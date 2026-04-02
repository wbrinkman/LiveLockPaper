#!/usr/bin/env -S gjs -m
/**
 * External mpv helper: one mpv window per monitor, titles LiveLockPaper-<n>.
 * Controlled via newline stdin commands (same protocol as Gtk player).
 */
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';

import { ScalingMode } from '../enums.js';
import CommandHandler from './command_handler.js';

const configPath = ARGV[0];
if (!configPath) {
    console.error('[mpv_run.js] No config file path provided');
    imports.system.exit(1);
}

let config;
try {
    const [ok, contents] = GLib.file_get_contents(configPath);
    if (!ok)
        throw new Error('file_get_contents returned false');
    config = JSON.parse(new TextDecoder().decode(contents));
} catch (e) {
    console.error(`[mpv_run.js] Failed to read config: ${e.message}`);
    imports.system.exit(1);
}

try {
    GLib.unlink(configPath);
} catch (_) {}

function sendMpvIpc(socketPath, command) {
    if (!socketPath || !GLib.file_test(socketPath, GLib.FileTest.EXISTS))
        return;
    let conn = null;
    try {
        const addr = Gio.UnixSocketAddress.new(socketPath);
        const client = new Gio.SocketClient();
        conn = client.connect(addr, null);
        const os = conn.get_output_stream();
        const line = `${JSON.stringify({ command })}\n`;
        os.write_all(new TextEncoder().encode(line), null);
    } catch (e) {
        console.error(`[mpv_run] IPC error: ${e.message}`);
    } finally {
        try {
            conn?.close(null);
        } catch (_) {}
    }
}

function waitForSocket(path, timeoutMs = 4000) {
    const deadline = GLib.get_monotonic_time() + timeoutMs * 1000;
    while (GLib.get_monotonic_time() < deadline) {
        if (GLib.file_test(path, GLib.FileTest.EXISTS))
            return true;
        GLib.usleep(30000);
    }
    return false;
}

function scalingArgs(mode) {
    const m = Number(mode) || 0;
    if (m === ScalingMode.STRETCH)
        return ['--keepaspect=no'];
    if (m === ScalingMode.COVER)
        return ['--keepaspect=yes', '--panscan=1'];
    return ['--keepaspect=yes'];
}

/**
 * Wallpaper blur: lavfi gblur+eq inside mpv (prefs mirror GTK Shell blur; Shell effect on reparented mpv
 * caused banding). Manual FPS: native fps filter after blur when videorate is on.
 */
function videoFilterArgs(useVideorate, framerate, blurRadius, blurBrightness) {
    const parts = [];
    const br = Math.max(0, Math.round(Number(blurRadius) || 0));
    if (br > 0) {
        const sigma = Math.min(28, Math.max(0.8, br * 0.48));
        const bright = Math.max(0, Math.min(1, Number(blurBrightness) || 1));
        const eqB = ((bright - 1) * 0.38).toFixed(4);
        parts.push(`lavfi=[gblur=sigma=${sigma.toFixed(2)}:steps=2,eq=brightness=${eqB}]`);
    }
    if (useVideorate) {
        const fps = Math.max(1, Math.min(120, Math.round(Number(framerate) || 30)));
        parts.push(`fps=${fps}`);
    }
    if (parts.length === 0)
        return [];
    return [`--vf=${parts.join('/')}`];
}

/** Match external/player.js: start at initialIndex; randomize remaining order when randomOrder. */
function buildPlaylistOrder(videos, startIdx, randomOrder) {
    const n = videos.length;
    if (n <= 1)
        return [...videos];
    let s = Number(startIdx);
    if (!Number.isInteger(s) || s < 0 || s >= n)
        s = 0;
    if (randomOrder) {
        const first = videos[s];
        const restIx = [];
        for (let i = 0; i < n; i++) {
            if (i !== s)
                restIx.push(i);
        }
        for (let i = restIx.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [restIx[i], restIx[j]] = [restIx[j], restIx[i]];
        }
        return [first, ...restIx.map(i => videos[i])];
    }
    const out = [];
    for (let k = 0; k < n; k++)
        out.push(videos[(s + k) % n]);
    return out;
}

Gtk.init();

const mpvBin = GLib.find_program_in_path('mpv');
if (!mpvBin) {
    console.error('[mpv_run] mpv not found in PATH');
    imports.system.exit(1);
}

class MpvHost {
    constructor(cfg) {
        this._config = cfg;
        /** @type {{ monitorIndex: number, socketPath: string, pid: number }[]} */
        this._instances = [];
        /** @type {Record<number, { paths: string[], randomOrder: boolean }>} */
        this._playlistMeta = {};
        /** Same playlist on every head (extension shared mode); random next must pick once for all mpvs. */
        this._wallpaperPerMonitor = true;
        this._commands = null;
        this._loop = GLib.MainLoop.new(null, false);
        this._quitting = false;
    }

    _socketPath(i) {
        return GLib.build_filenamev([
            GLib.get_tmp_dir(),
            `llp-mpv-${GLib.get_real_time()}-${i}-${Math.floor(Math.random() * 1e9)}.sock`,
        ]);
    }

    _spawnMpv(monitorIndex, geometry, orderedPaths, catalogPaths) {
        if (!Array.isArray(orderedPaths) || orderedPaths.length === 0)
            return;

        const randomOrder = !!this._config.randomOrder;
        this._playlistMeta[monitorIndex] = {
            paths: [...(catalogPaths ?? orderedPaths)],
            randomOrder,
        };

        const sock = this._socketPath(monitorIndex);
        const { width, height, x, y } = geometry;
        const geoArg = `${width}x${height}+${x}+${y}`;

        const vol = Math.max(0, Math.min(100, Math.round(Number(this._config.volume ?? 0) * 100)));
        const preferHw = this._config.preferHwDecoder !== false;
        const blurR = Math.max(0, Math.round(Number(this._config.wallpaperBlurRadius) || 0));
        const needCopyHw = blurR > 0;
        const hwdec = preferHw ? (needCopyHw ? 'auto-copy-safe' : 'auto-safe') : 'no';
        const useVideorate = !!this._config.useVideorate;
        const fr = this._config.framerate;
        const blurBright = this._config.wallpaperBlurBrightness;
        const stableTitle = `LiveLockPaper-${monitorIndex}`;
        const argv = [
            mpvBin,
            `--title=${stableTitle}`,
            // Reduce chance the window title is rewritten to "file.mp4 — …" before Mutter sees it.
            `--force-media-title=${stableTitle}`,
            // Do not set --wayland-app-id: a public id makes each mpv process a separate dock entry.
            // Skip-taskbar overrides (extension) hide helpers like the single-process GTK helper.
            `--geometry=${geoArg}`,
            '--no-border',
            // Default mpv --background is "tiles"; sub-pixel gaps can show patterned/themed edges in Clutter.
            '--background=color',
            '--background-color=#FF000000',
            '--border-background=none',
            // Resample frame times to each surface's display refresh (like many desktop mpv setups). Reduces
            // judder for 24/30 fps on 60+ Hz panels; each Wayland/X11 window still tracks its own output.
            '--video-sync=display-resample',
            // Extra demuxer headroom for high-bitrate 4K (defaults are small → micro-stalls under load).
            '--demuxer-max-bytes=128MiB',
            '--ontop=no',
            '--really-quiet',
            '--no-terminal',
            '--no-osc',
            '--osd-on-seek=no',
            '--no-input-default-bindings',
            '--input-vo-keyboard=no',
            '--input-cursor-passthrough=yes',
            '--cursor-autohide=always',
            `--volume=${vol}`,
            `--hwdec=${hwdec}`,
            `--input-ipc-server=${sock}`,
            ...scalingArgs(this._config.scalingMode),
            ...videoFilterArgs(useVideorate, fr, blurR, blurBright),
        ];

        let startPath;
        if (orderedPaths.length === 1) {
            argv.push('--loop=inf');
            startPath = orderedPaths[0];
            argv.push(startPath);
        } else {
            const plPath = GLib.build_filenamev([
                GLib.get_tmp_dir(),
                `llp-pl-${GLib.get_real_time()}-${monitorIndex}.m3u`,
            ]);
            const body = ['#EXTM3U', ...orderedPaths.map(p => p)].join('\n');
            GLib.file_set_contents(plPath, body);
            argv.push(`--playlist=${plPath}`);
            argv.push('--loop-playlist=inf');
            argv.push('--playlist-start=0');
            startPath = plPath;
        }

        let proc;
        try {
            proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
        } catch (e) {
            console.error(`[mpv_run] Failed to spawn mpv for monitor ${monitorIndex}: ${e.message}`);
            return;
        }
        let pid = 0;
        try {
            pid = proc.get_identifier() || 0;
        } catch (_) {}

        if (!waitForSocket(sock)) {
            console.error(`[mpv_run] mpv IPC socket missing: ${sock}`);
            try {
                proc.force_exit();
            } catch (_) {}
            return;
        }

        this._instances.push({ monitorIndex, socketPath: sock, pid, proc });
        console.log(`[mpv_run] Monitor ${monitorIndex}: mpv PID ${pid}, ${startPath}`);
    }

    _run() {
        const display = Gdk.Display.get_default();
        if (!display) {
            console.error('[mpv_run] No display');
            imports.system.exit(1);
        }

        if (GLib.getenv('WAYLAND_DISPLAY'))
            console.log('[mpv_run] Wayland: default mpv VO (e.g. waylandvk/gpu-next). Do not force x11egl — it diverges from normal mpv and caused row/comb artifacts.');

        const gdkMonitors = display.get_monitors();
        const gdkCount = gdkMonitors.get_n_items();
        const shellGeoms = Array.isArray(this._config.monitorGeometries) ? this._config.monitorGeometries : [];
        const useShell = shellGeoms.length > 0;
        const monitorCount = useShell ? shellGeoms.length : gdkCount;
        if (monitorCount === 0) {
            console.error('[mpv_run] No monitors');
            imports.system.exit(1);
        }

        // One rect per head from Shell JSON (get_monitor_geometry in extension). Mixing Gdk WxH with Shell x,y broke alignment.
        const pickGeo = i => {
            if (useShell) {
                const g = shellGeoms[i];
                if (g && (g.width | 0) > 1 && (g.height | 0) > 1) {
                    return {
                        width: g.width | 0,
                        height: g.height | 0,
                        x: g.x | 0,
                        y: g.y | 0,
                    };
                }
            }
            if (i < gdkCount) {
                const gdkMonitor = gdkMonitors.get_item(i);
                const geo = gdkMonitor?.get_geometry();
                if (geo) {
                    return {
                        width: geo.width,
                        height: geo.height,
                        x: geo.x,
                        y: geo.y,
                    };
                }
            }
            return null;
        };

        // Per-monitor vs shared matches external/player.js; geometry index matches gnome-shell layoutManager.
        const monitors = this._config.monitors || [];
        const perMonitor = monitors.length > 1;
        this._wallpaperPerMonitor = perMonitor;
        const randomOrder = !!this._config.randomOrder;

        if (perMonitor) {
            for (let i = 0; i < monitorCount; i++) {
                const monitorConfig = monitors[i] || monitors[0];
                const videos = Array.isArray(monitorConfig?.videos) ? [...monitorConfig.videos] : [];
                if (videos.length === 0) {
                    console.log(`[mpv_run] Skipping monitor ${i} - no videos configured`);
                    continue;
                }
                const geo = pickGeo(i);
                if (!geo)
                    continue;
                let initialIndex = monitorConfig?.initialIndex;
                if (!Number.isInteger(initialIndex) || initialIndex < 0 || initialIndex >= videos.length)
                    initialIndex = 0;
                const ordered = buildPlaylistOrder(videos, initialIndex, randomOrder);
                console.log(`[mpv_run] spawn mon=${i} geo=${JSON.stringify(geo)} useVideorate=${!!this._config.useVideorate} fr=${this._config.framerate}`);
                this._spawnMpv(i, geo, ordered, videos);
            }
            console.log(`[mpv_run] Per-monitor: ${this._instances.length} mpv / ${monitorCount} (${useShell ? 'Shell' : 'Gdk'} geom) random=${randomOrder}`);
        } else {
            const sharedConfig = monitors[0] || { videos: [] };
            const videos = Array.isArray(sharedConfig?.videos) ? [...sharedConfig.videos] : [];
            if (videos.length === 0) {
                console.error('[mpv_run] No videos in shared config');
                imports.system.exit(1);
            }
            let initialIndex = sharedConfig?.initialIndex;
            if (!Number.isInteger(initialIndex) || initialIndex < 0 || initialIndex >= videos.length)
                initialIndex = 0;
            const ordered = buildPlaylistOrder(videos, initialIndex, randomOrder);
            for (let i = 0; i < monitorCount; i++) {
                const geo = pickGeo(i);
                if (!geo)
                    continue;
                console.log(`[mpv_run] spawn mon=${i} geo=${JSON.stringify(geo)} useVideorate=${!!this._config.useVideorate} fr=${this._config.framerate}`);
                this._spawnMpv(i, geo, ordered, videos);
            }
            console.log(`[mpv_run] Shared: ${this._instances.length} mpv / ${monitorCount} (${useShell ? 'Shell' : 'Gdk'} geom) random=${randomOrder}`);
        }

        if (this._instances.length === 0) {
            console.error('[mpv_run] No mpv instances started');
            imports.system.exit(1);
        }

        this._initCommands();
        this._loop.run();
    }

    _socketForMonitor(idx) {
        const inst = this._instances.find(x => x.monitorIndex === idx);
        return inst?.socketPath ?? null;
    }

    _allSockets() {
        return this._instances.map(x => x.socketPath).filter(Boolean);
    }

    _initCommands() {
        this._commands = new CommandHandler();

        this._commands.addHandler('play', () => {
            for (const s of this._allSockets())
                sendMpvIpc(s, ['set_property', 'pause', false]);
        });

        this._commands.addHandler('pause', () => {
            for (const s of this._allSockets())
                sendMpvIpc(s, ['set_property', 'pause', true]);
        });

        this._commands.addHandler('quit', () => {
            this._quit();
        });

        this._commands.addHandler('set-volume', payload => {
            const vol = Math.max(0, Math.min(100, Math.round(Number.parseFloat(payload) * 100)));
            for (const s of this._allSockets())
                sendMpvIpc(s, ['set_property', 'volume', vol]);
        });

        this._commands.addHandler('change-video', payload => {
            if (!payload) return;
            const firstColon = payload.indexOf(':');
            if (firstColon < 0) return;
            const monitorIdx = Number.parseInt(payload.substring(0, firstColon), 10);
            const filePath = payload.substring(firstColon + 1);
            if (Number.isNaN(monitorIdx) || !filePath) return;
            if (this._wallpaperPerMonitor) {
                const sock = this._socketForMonitor(monitorIdx) || this._allSockets()[0];
                if (sock)
                    sendMpvIpc(sock, ['loadfile', filePath, 'replace']);
            } else {
                for (const s of this._allSockets())
                    sendMpvIpc(s, ['loadfile', filePath, 'replace']);
            }
        });

        this._commands.addHandler('next', payload => {
            if (!this._wallpaperPerMonitor) {
                this._mpvSharedPlaylistNext();
                return;
            }
            if (!payload || payload === 'all') {
                for (const inst of this._instances)
                    this._mpvPlaylistNext(inst);
                return;
            }
            const monitorIdx = Number.parseInt(payload, 10);
            const inst = this._instances.find(x => x.monitorIndex === monitorIdx) ?? this._instances[0];
            if (inst)
                this._mpvPlaylistNext(inst);
        });

        this._commands.init();
    }

    _quit() {
        if (this._quitting)
            return;
        this._quitting = true;
        try {
            this._commands?.destroy();
        } catch (_) {}
        this._commands = null;

        for (const s of this._allSockets())
            sendMpvIpc(s, ['quit']);

        for (const inst of this._instances) {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
                try {
                    inst.proc?.force_exit();
                } catch (_) {}
                if (inst.pid) {
                    try {
                        GLib.spawn_command_line_sync(`kill ${inst.pid}`);
                    } catch (_) {}
                }
                return GLib.SOURCE_REMOVE;
            });
        }
        this._instances = [];
        this._playlistMeta = {};

        try {
            this._loop.quit();
        } catch (_) {}
    }

    _mpvPlaylistNext(inst) {
        const sock = inst?.socketPath;
        if (!sock)
            return;
        const meta = this._playlistMeta[inst.monitorIndex];
        if (meta?.randomOrder && meta.paths?.length > 1) {
            const pick = meta.paths[Math.floor(Math.random() * meta.paths.length)];
            sendMpvIpc(sock, ['loadfile', pick, 'replace']);
            return;
        }
        sendMpvIpc(sock, ['playlist-next']);
    }

    /** Shared wallpaper: one random choice or one playlist step for every mpv instance. */
    _mpvSharedPlaylistNext() {
        const first = this._instances[0];
        if (!first)
            return;
        const meta = this._playlistMeta[first.monitorIndex];
        if (meta?.randomOrder && meta.paths?.length > 1) {
            const pick = meta.paths[Math.floor(Math.random() * meta.paths.length)];
            for (const s of this._allSockets())
                sendMpvIpc(s, ['loadfile', pick, 'replace']);
            return;
        }
        for (const s of this._allSockets())
            sendMpvIpc(s, ['playlist-next']);
    }
}

const host = new MpvHost(config);
host._run();
