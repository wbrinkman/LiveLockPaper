import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import cairo from 'cairo';

import Pipeline from './pipeline.js';
import { ScalingMode } from '../enums.js';
import CommandHandler from './command_handler.js';

// Standalone GTK4 player process used by the extension.
export default class Player {
    constructor(config) {
        this._config = config;
        this._pipelines = [];
        this._app = null;
        this._commands = null;
    }

    run() {
        this._app = new Gtk.Application({
            application_id: 'dev.livelockpaper.wallpaper.helper',
            flags: Gio.ApplicationFlags.NON_UNIQUE,
        });
        this._app.connect('activate', () => this._activate());

        try {
            this._app.run([]);
        } catch (e) {
            this._cleanup();
            throw e;
        }
    }

    _activate() {
        try {
            this._initStyle();
            this._initPipelinesAndWindows();
            this._initCommands();
        } catch (e) {
            logError(e, 'Player: failed to activate');
            this._cleanup();
        }
    }

    _initStyle() {
        const css = new Gtk.CssProvider();
        css.load_from_string(`
            window {
                background: none;
                background-color: transparent;
            }
            picture {
                background: none;
                background-color: transparent;
            }
            .llp-transition-mask {
                background: #000;
            }
            * {
                background: none;
                transition: none;
                animation: none;
            }
        `);

        Gtk.StyleContext.add_provider_for_display(
            Gdk.Display.get_default(),
            css,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
        );
    }

    _initPipelinesAndWindows() {
        const config = this._config;

        // Map JS scaling mode to Gtk.ContentFit
        let scaling;
        switch (config.scalingMode) {
            case ScalingMode.STRETCH: scaling = Gtk.ContentFit.FILL;    break;
            case ScalingMode.FIT:     scaling = Gtk.ContentFit.CONTAIN; break;
            case ScalingMode.COVER:   scaling = Gtk.ContentFit.COVER;   break;
            default:                  scaling = Gtk.ContentFit.FILL;
        }

        const display = Gdk.Display.get_default();
        if (!display)
            throw new Error('Failed to get GDK display');

        const gdkMonitors = display.get_monitors();
        const monitorCount = gdkMonitors.get_n_items();
        if (monitorCount === 0)
            throw new Error('No monitors found');

        const monitors = config.monitors || [];
        const renderScale = Math.max(0.25, Math.min(1.0, Number(config.renderScale) || 1.0));
        const shouldScale = renderScale < 0.999;

        // Determine if per-monitor (each monitor has its own pipeline) or shared
        const perMonitor = monitors.length > 1;

        const randomOrder = config.randomOrder || false;

        if (perMonitor) {
            // ── Per-monitor mode: one pipeline per monitor ──
            const usedInitialVideos = new Set();
            for (let i = 0; i < monitorCount; i++) {
                const monitorConfig = monitors[i] || monitors[0];
                const videos = Array.isArray(monitorConfig?.videos) ? monitorConfig.videos : [];
                
                // Skip monitors with no videos (disabled monitors)
                if (videos.length === 0) {
                    console.log(`[Player] Skipping monitor ${i} - no videos configured`);
                    continue;
                }
                
                const gdkMonitor = gdkMonitors.get_item(i);
                const geo = gdkMonitor?.get_geometry();
                const baseW = monitorConfig?.width || geo?.width || 1920;
                const baseH = monitorConfig?.height || geo?.height || 1080;
                const targetWidth = shouldScale ? Math.max(1, Math.round(baseW * renderScale)) : 0;
                const targetHeight = shouldScale ? Math.max(1, Math.round(baseH * renderScale)) : 0;
                const configuredInitialIndex = Number.isInteger(monitorConfig?.initialIndex)
                    ? monitorConfig.initialIndex
                    : null;
                const initialIndex = configuredInitialIndex !== null
                    ? configuredInitialIndex
                    : this._pickInitialIndex(videos, randomOrder, usedInitialVideos);

                const pipeline = new Pipeline({
                    videos,
                    volume: config.volume,
                    loop: true,
                    randomOrder,
                    useVideorate: config.useVideorate,
                    framerate: config.framerate,
                    targetWidth,
                    targetHeight,
                    initialIndex,
                });
                pipeline.init();
                this._pipelines.push(pipeline);

                const paintable = pipeline.get_paintable();
                if (!paintable)
                    throw new Error(`Failed to get paintable for monitor ${i}`);

                this._createWindow(paintable, scaling, i);
            }

            console.log(`[Player] Per-monitor mode: ${this._pipelines.length} pipeline(s) for ${monitorCount} monitor(s), random=${randomOrder}`);
        } else {
            // ── Shared mode: one pipeline, paintable shared across all windows ──
            const sharedConfig = monitors[0] || { videos: [] };
            const sharedVideos = Array.isArray(sharedConfig?.videos) ? sharedConfig.videos : [];
            const baseW = sharedConfig?.width || 1920;
            const baseH = sharedConfig?.height || 1080;
            const targetWidth = shouldScale ? Math.max(1, Math.round(baseW * renderScale)) : 0;
            const targetHeight = shouldScale ? Math.max(1, Math.round(baseH * renderScale)) : 0;

            const pipeline = new Pipeline({
                videos: sharedVideos,
                volume: config.volume,
                loop: true,
                randomOrder,
                useVideorate: config.useVideorate,
                framerate: config.framerate,
                targetWidth,
                targetHeight,
                initialIndex: Number.isInteger(sharedConfig?.initialIndex) ? sharedConfig.initialIndex : null,
            });
            pipeline.init();
            this._pipelines.push(pipeline);

            const paintable = pipeline.get_paintable();
            if (!paintable)
                throw new Error('Failed to get paintable from shared pipeline');

            for (let i = 0; i < monitorCount; i++) {
                this._createWindow(paintable, scaling, i);
            }

            console.log(`[Player] Shared mode: 1 pipeline for ${monitorCount} monitor(s), random=${randomOrder}`);
        }
    }

    _pickInitialIndex(videos, randomOrder, usedInitialVideos) {
        if (!Array.isArray(videos) || videos.length === 0)
            return null;

        if (videos.length === 1) {
            usedInitialVideos.add(videos[0]);
            return 0;
        }

        const available = videos
            .map((path, idx) => ({ path, idx }))
            .filter(v => !usedInitialVideos.has(v.path));

        let picked = null;
        if (available.length > 0) {
            picked = randomOrder
                ? available[Math.floor(Math.random() * available.length)]
                : available[0];
        } else {
            const fallbackIndex = randomOrder
                ? Math.floor(Math.random() * videos.length)
                : 0;
            picked = { path: videos[fallbackIndex], idx: fallbackIndex };
        }

        usedInitialVideos.add(picked.path);
        return picked.idx;
    }

    _createWindow(paintable, scaling, monitorIndex) {
        const display = Gdk.Display.get_default();
        const gdkMonitors = display.get_monitors();
        const gdkMonitor = gdkMonitors.get_item(monitorIndex);
        const geo = gdkMonitor?.get_geometry();

        const window = new Gtk.Window({
            title: `LiveLockPaper-${monitorIndex}`,
        });
        try { window.set_application(this._app); } catch (_) {}

        if (geo) {
            window.set_default_size(geo.width, geo.height);
            window.set_size_request(geo.width, geo.height);
        }

        const picture = new Gtk.Picture({
            paintable,
            content_fit: scaling,
            can_shrink: true,
            hexpand: true,
            vexpand: true,
        });
        if (geo) {
            picture.set_size_request(geo.width, geo.height);
        }
        try { picture.set_can_target(false); } catch (_) {}

        window.set_child(picture);
        window.set_decorated(false);
        window.set_resizable(true);
        try { window.set_modal(false); } catch (_) {}
        try { window.set_startup_id(''); } catch (_) {}
        try { window.set_can_target(false); } catch (_) {}
        try { window.set_focusable(false); } catch (_) {}

        window.connect('realize', () => {
            const surface = window.get_surface();
            surface?.set_opaque_region(null);
            try {
                const inputRegion = new cairo.Region();
                surface?.set_input_region(inputRegion);
            } catch (_) {}
        });

        window.present();
        return { window, picture };
    }

    _initCommands() {
        this._commands = new CommandHandler();

        this._commands.addHandler('play', () => {
            this._pipelines.forEach(p => p.play());
        });

        this._commands.addHandler('pause', () => {
            this._pipelines.forEach(p => p.pause());
        });

        this._commands.addHandler('quit', () => {
            this._quit();
        });

        // change-video:<monitorIndex>:<filePath>
        this._commands.addHandler('change-video', (payload) => {
            if (!payload) return;
            const firstColon = payload.indexOf(':');
            if (firstColon < 0) return;
            const monitorIdx = parseInt(payload.substring(0, firstColon), 10);
            const filePath = payload.substring(firstColon + 1);
            if (isNaN(monitorIdx) || !filePath) return;

            const pipeline = this._pipelines[monitorIdx] || this._pipelines[0];
            if (pipeline) {
                pipeline.changeVideo(filePath);
            }
        });

        // set-volume:<0.0-1.0>
        this._commands.addHandler('set-volume', (payload) => {
            const vol = parseFloat(payload);
            if (!isNaN(vol)) {
                this._pipelines.forEach(p => p.easeVolume(vol));
            }
        });

        // next:<monitorIndex|all>
        this._commands.addHandler('next', (payload) => {
            if (!payload || payload === 'all') {
                this._pipelines.forEach(p => p.advanceToNext());
                return;
            }
            const monitorIdx = parseInt(payload, 10);
            if (isNaN(monitorIdx))
                return;
            const pipeline = this._pipelines[monitorIdx] || this._pipelines[0];
            pipeline?.advanceToNext();
        });

        this._commands.init();
    }

    _quit() {
        this._cleanup();
        this._app.quit();
    }

    _cleanup() {
        try {
            this._commands?.destroy();
        } catch (e) {
            logError(e, 'Player: error destroying commands');
        } finally {
            this._commands = null;
        }

        for (const pipeline of this._pipelines) {
            try {
                pipeline.destroy();
            } catch (e) {
                logError(e, 'Player: error destroying pipeline');
            }
        }
        this._pipelines = [];
    }
}
