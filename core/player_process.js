import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

// Wrapper for spawning and controlling the external GTK4 or mpv helper process.
export class PlayerProcess {
    constructor({ playerPath, config, matchWindowsByTitleOnly = false }) {
        this._playerPath = playerPath;
        this._config = config;
        this._matchWindowsByTitleOnly = !!matchWindowsByTitleOnly;

        this._pid = null;
        this._stdin = null;
        this._mapId = null;
        this._createdId = null;
        this._timeoutId = null;
        // Last batch from waitForWindows (verify + coverage); mpv uses child PIDs vs gjs host PID.
        this._windows = null;
        this._childWindowPids = null;
    }

    _pidMatches(win) {
        if (this._matchWindowsByTitleOnly)
            return true;
        return win && win.get_pid?.() === this._pid;
    }

    _playerArgv(configPath) {
        const p = this._playerPath || '';
        if (p.endsWith('.js')) {
            const gjs = GLib.find_program_in_path('gjs');
            if (gjs)
                return [gjs, '-m', p, configPath];
        }
        return [p, configPath];
    }

    // Write config and spawn the subprocess.
    run() {
        // Write config to a temp file
        const configPath = GLib.build_filenamev([
            GLib.get_tmp_dir(),
            `livelockpaper-config-${GLib.get_real_time()}.json`,
        ]);

        const configJson = JSON.stringify(this._config);
        GLib.file_set_contents(configPath, configJson);

        // Run .js helpers via `gjs -m` so they work without the executable bit (zip/install often ships 0644).
        const argv = this._playerArgv(configPath);
        console.log(`[PlayerProcess] Spawning: ${argv.join(' ')}`);

        // Force GTK4 to NGL to avoid known Vulkan crashes on some drivers.
        let env = GLib.get_environ();
        env = GLib.environ_setenv(env, 'GSK_RENDERER', 'ngl', true);

        const [success, pid, stdinFd] = GLib.spawn_async_with_pipes(
            null,
            argv,
            env,
            GLib.SpawnFlags.SEARCH_PATH,
            null
        );

        if (!success)
            throw new Error('PlayerProcess: failed to spawn player subprocess');

        this._pid = pid;

        const stdinStream = new GioUnix.OutputStream({ fd: stdinFd, close_fd: true });
        this._stdin = new Gio.DataOutputStream({ base_stream: stdinStream });

        console.log(`[PlayerProcess] Subprocess started, PID=${pid}`);

        // skip_taskbar/skip_pager are set in waitForWindows callback
    }

    // Wait until helper windows are mapped and matched by PID.
    waitForWindows(count, timeoutMs, callback, errback) {
        this._windows = null;
        this._childWindowPids = null;
        const collected = [];
        const seen = new Set();

        // Set skip_taskbar override early to prevent dock from seeing the window
        this._createdId = global.display.connect('window-created', (_display, win) => {
            try {
                if (!this._pidMatches(win)) return;
                const title = win.get_title?.() ?? '';
                if (!title.startsWith('LiveLockPaper-')) return;
                
                // Set via Mutter API as early as possible
                try { win.set_skip_taskbar(true); } catch (_) {}
                try { win.set_skip_pager(true); } catch (_) {}
                
                // JS override for dash-to-dock
                if (!win.__llp_skipTaskbarOverride) {
                    try {
                        Object.defineProperty(win, 'skip_taskbar', {
                            get: () => true,
                            configurable: true,
                        });
                        win.is_skip_taskbar = () => true;
                        win.__llp_skipTaskbarOverride = true;
                    } catch (_) {}
                }
                // JS override for skip_pager
                if (!win.__llp_skipPagerOverride) {
                    try {
                        Object.defineProperty(win, 'skip_pager', {
                            get: () => true,
                            configurable: true,
                        });
                        win.is_skip_pager = () => true;
                        win.__llp_skipPagerOverride = true;
                    } catch (_) {}
                }
            } catch (_) {}
        });

        this._mapId = global.window_manager.connect_after('map', (_wm, windowActor) => {
            try {
                const win = windowActor.get_meta_window();
                if (!this._pidMatches(win)) return;
                const title = win.get_title?.() ?? '';

                // mpv often appends " — mpv" or the filename; match prefix only.
                const match = title.match(/LiveLockPaper-(\d+)/);
                if (!match)
                    return;

                // De-dupe multiple map events for the same window
                const monitorIndex = Number.parseInt(match[1], 10);
                const stableSeq = win.get_stable_sequence?.();
                const key = Number.isFinite(monitorIndex)
                    ? `monitor:${monitorIndex}`
                    : (stableSeq ?? `${win.get_pid?.() ?? 0}:${title}`);
                if (seen.has(key))
                    return;
                seen.add(key);

                // Set skip flags immediately when window maps (fixes dock bug on some systems)
                try { win.set_skip_taskbar(true); } catch (_) {}
                try { win.set_skip_pager(true); } catch (_) {}
                if (!win.__llp_skipTaskbarOverride) {
                    try {
                        Object.defineProperty(win, 'skip_taskbar', {
                            get: () => true,
                            configurable: true,
                        });
                        win.is_skip_taskbar = () => true;
                        win.__llp_skipTaskbarOverride = true;
                    } catch (_) {}
                }
                if (!win.__llp_skipPagerOverride) {
                    try {
                        Object.defineProperty(win, 'skip_pager', {
                            get: () => true,
                            configurable: true,
                        });
                        win.is_skip_pager = () => true;
                        win.__llp_skipPagerOverride = true;
                    } catch (_) {}
                }

                collected.push(win);
                console.log(`[PlayerProcess] Window mapped (${collected.length}/${count}), PID=${win.get_pid()}`);

                if (collected.length === count) {
                    global.window_manager.disconnect(this._mapId);
                    this._mapId = null;

                    if (this._createdId) {
                        try { global.display.disconnect(this._createdId); } catch (_) {}
                        this._createdId = null;
                    }

                    if (this._timeoutId !== null) {
                        GLib.source_remove(this._timeoutId);
                        this._timeoutId = null;
                    }

                    // Set window properties immediately before reparenting
                    for (const win of collected) {
                        // Unmaximize to prevent dock from hiding
                        try { win.unmaximize(); } catch (_) {
                            try { win.unmaximize(Meta.MaximizeFlags.BOTH); } catch (_) {}
                        }
                        // Set skip_taskbar via Mutter API
                        try { win.set_skip_taskbar(true); } catch (_) {}
                        try { win.set_skip_pager(true); } catch (_) {}
                        // JS override for dash-to-dock
                        if (!win.__llp_skipTaskbarOverride) {
                            try {
                                Object.defineProperty(win, 'skip_taskbar', {
                                    get: () => true,
                                    configurable: true,
                                });
                                win.is_skip_taskbar = () => true;
                                win.__llp_skipTaskbarOverride = true;
                            } catch (_) {}
                        }
                        // JS override for skip_pager
                        if (!win.__llp_skipPagerOverride) {
                            try {
                                Object.defineProperty(win, 'skip_pager', {
                                    get: () => true,
                                    configurable: true,
                                });
                                win.is_skip_pager = () => true;
                                win.__llp_skipPagerOverride = true;
                            } catch (_) {}
                        }
                    }
                    this._windows = collected;
                    this._childWindowPids = new Set();
                    for (const w of collected) {
                        const p = w.get_pid?.();
                        if (p)
                            this._childWindowPids.add(p);
                    }
                    collected.sort((a, b) => {
                        const ma = Number.parseInt(
                            (a.get_title?.() ?? '').match(/LiveLockPaper-(\d+)/)?.[1] ?? '999',
                            10
                        );
                        const mb = Number.parseInt(
                            (b.get_title?.() ?? '').match(/LiveLockPaper-(\d+)/)?.[1] ?? '999',
                            10
                        );
                        return ma - mb;
                    });
                    callback(collected);
                }
            } catch (e) {
                console.error(`[PlayerProcess] Error in map handler: ${e.message}`);
            }
        });

        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
            if (this._mapId) {
                global.window_manager.disconnect(this._mapId);
                this._mapId = null;
            }
            if (this._createdId) {
                try { global.display.disconnect(this._createdId); } catch (_) {}
                this._createdId = null;
            }
            this._timeoutId = null;
            this._windows = null;
            this._childWindowPids = null;
            errback?.(`timed out waiting for windows (got ${collected.length}/${count})`);
            return GLib.SOURCE_REMOVE;
        });
    }

    play() {
        this._sendCommand('play');
    }

    pause() {
        this._sendCommand('pause');
    }

    // Change video for one monitor.
    changeVideo(monitorIndex, filePath) {
        this._sendCommand(`change-video:${monitorIndex}:${filePath}`);
    }

    setVolume(volume) {
        this._sendCommand(`set-volume:${volume}`);
    }

    // Advance playlist; null target advances all monitors.
    next(monitorIndex = null) {
        if (monitorIndex === null || monitorIndex === undefined) {
            this._sendCommand('next:all');
            return;
        }
        this._sendCommand(`next:${monitorIndex}`);
    }

    _sendCommand(command) {
        if (!this._stdin) return;
        try {
            this._stdin.put_string(`${command}\n`, null);
        } catch (e) {
            console.error(`[PlayerProcess] Failed to send command "${command}": ${e.message}`);
        }
    }

    get pid() { return this._pid; }

    destroy() {
        if (this._timeoutId !== null) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }

        if (this._mapId) {
            try { global.window_manager.disconnect(this._mapId); } catch (_) {}
            this._mapId = null;
        }

        if (this._createdId) {
            try { global.display.disconnect(this._createdId); } catch (_) {}
            this._createdId = null;
        }

        // Send quit command first for graceful shutdown
        this._sendCommand('quit');

        // Then kill as backup after a short delay
        if (this._pid) {
            const pid = this._pid;
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                try { GLib.spawn_command_line_sync(`kill ${pid}`); } catch (_) {}
                return GLib.SOURCE_REMOVE;
            });
            this._pid = null;
        }

        if (this._stdin) {
            try { this._stdin.close(null); } catch (_) {}
            this._stdin = null;
        }

        this._windows = null;
        this._childWindowPids = null;
    }
}
