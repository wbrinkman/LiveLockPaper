import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import GdkPixbuf from 'gi://GdkPixbuf';
import Pango from 'gi://Pango';
import GObject from 'gi://GObject';
import Gst from 'gi://Gst';
import GstPbutils from 'gi://GstPbutils';
import GLib from 'gi://GLib';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import { Keys } from "./enums.js";


export default class LiveLockscreenExtensionPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window._settings = this.getSettings();
        window.set_default_size(600, 700);
        
        // Validate videos on startup
        this._validateVideos(window);

        // Lock Screen page
        const lockScreenPage = new Adw.PreferencesPage({
            title: 'Lock Screen',
            icon_name: 'system-lock-screen-symbolic',
        });
        lockScreenPage.add(this._buildGeneralGroup(window));

        // Lock screen per-monitor video groups
        const lsSingleVideoGroup = this._buildLockscreenSingleVideoGroup(window);
        lockScreenPage.add(lsSingleVideoGroup);

        const lsPerMonitorGroup = this._buildLockscreenPerMonitorGroup(window);
        lockScreenPage.add(lsPerMonitorGroup);

        // Toggle visibility based on per-monitor setting
        const updateLsGroupVisibility = () => {
            const perMonitor = window._settings.get_boolean(Keys.LOCKSCREEN_PER_MONITOR);
            lsSingleVideoGroup.visible = !perMonitor;
            lsPerMonitorGroup.visible = perMonitor;
        };
        updateLsGroupVisibility();
        window._settings.connect('changed::' + Keys.LOCKSCREEN_PER_MONITOR, updateLsGroupVisibility);

        const lsAppearanceGroup = this._buildAppearanceGroup(window);
        lockScreenPage.add(lsAppearanceGroup);
        const lsPromptGroup = this._buildPromptGroup(window);
        lockScreenPage.add(lsPromptGroup);

        // Disable lockscreen-specific groups when lock screen video is off.
        const updateLockscreenSensitivity = () => {
            const enabled = window._settings.get_boolean(Keys.LOCKSCREEN_ENABLED);
            lsSingleVideoGroup.set_sensitive(enabled);
            lsPerMonitorGroup.set_sensitive(enabled);
            lsAppearanceGroup.set_sensitive(enabled);
            lsPromptGroup.set_sensitive(enabled);
        };
        updateLockscreenSensitivity();
        window._settings.connect('changed::' + Keys.LOCKSCREEN_ENABLED, updateLockscreenSensitivity);
        window.add(lockScreenPage);

        // Wallpaper page
        const wallpaperPage = new Adw.PreferencesPage({
            title: 'Wallpaper',
            icon_name: 'preferences-desktop-wallpaper-symbolic',
        });

        const wpControlGroup = this._buildWallpaperControlGroup(window);
        wallpaperPage.add(wpControlGroup);

        const wpSingleVideoGroup = this._buildWallpaperSingleVideoGroup(window);
        wallpaperPage.add(wpSingleVideoGroup);

        const wpPerMonitorGroup = this._buildWallpaperPerMonitorGroup(window);
        wallpaperPage.add(wpPerMonitorGroup);

        wallpaperPage.add(this._buildWallpaperAppearanceGroup(window));

        // Toggle visibility of single vs per-monitor groups
        const updateWpGroupVisibility = () => {
            const perMonitor = window._settings.get_boolean(Keys.WALLPAPER_PER_MONITOR);
            wpSingleVideoGroup.visible = !perMonitor;
            wpPerMonitorGroup.visible = perMonitor;
        };
        updateWpGroupVisibility();
        window._settings.connect('changed::' + Keys.WALLPAPER_PER_MONITOR, updateWpGroupVisibility);

        window.add(wallpaperPage);

        // Debug page
        const debugPage = new Adw.PreferencesPage({
            title: 'Debug',
            icon_name: 'applications-utilities-symbolic',
        });
        debugPage.add(this._buildPerfGroup(window));
        debugPage.add(this._buildDebugGroup(window));
        window.add(debugPage);
    }

    _buildGeneralGroup(window) {
        let generalGroup = new Adw.PreferencesGroup({
            title: 'General',
        });

        const lockscreenEnabledSwitch = new Adw.SwitchRow({
            title: 'Enable Video Lock Screen',
            subtitle: 'Use video background on the lock screen',
        });
        window._settings.bind(
            Keys.LOCKSCREEN_ENABLED, lockscreenEnabledSwitch,
            'active', Gio.SettingsBindFlags.DEFAULT
        );
        generalGroup.add(lockscreenEnabledSwitch);

        const scalingRow = new Adw.ComboRow({
            title: 'Scaling mode',
            subtitle: 'How the video is scaled to fit the screen',
            model: new Gtk.StringList({
                strings: ['Stretch', 'Fit', 'Cover']
            }),
        });

        scalingRow.set_selected(window._settings.get_int(Keys.SCALING_MODE));
        scalingRow.connect('notify::selected', row => {
            window._settings.set_int(Keys.SCALING_MODE, row.selected);
        });

        let volumeRow = new Adw.SpinRow({
            title: 'Volume',
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 100,
                step_increment: 1,
                value: window._settings.get_int(Keys.AUDIO_VOLUME),
            }),
        });
        let volumeSuffix = new Gtk.Label({
            label: '%',
            valign: Gtk.Align.CENTER,
            css_classes: ['dim-label'],
        });
        volumeRow.add_suffix(volumeSuffix);
        volumeRow.connect('notify::value', row => {
            window._settings.set_int(Keys.AUDIO_VOLUME, row.get_value());
        });
        

        // Random order
        const randomOrderSwitch = new Adw.SwitchRow({
            title: 'Random order',
            subtitle: 'Play videos in random order',
        });
        window._settings.bind(
            Keys.VIDEO_RANDOM_ORDER, randomOrderSwitch,
            'active', Gio.SettingsBindFlags.DEFAULT
        );
        

        // Per-monitor toggle
        const perMonitorSwitch = new Adw.SwitchRow({
            title: 'Per-monitor videos',
            subtitle: 'Each monitor gets its own independent set of videos',
        });
        window._settings.bind(
            Keys.LOCKSCREEN_PER_MONITOR, perMonitorSwitch,
            'active', Gio.SettingsBindFlags.DEFAULT
        );
        generalGroup.add(perMonitorSwitch);
        generalGroup.add(randomOrderSwitch);

        const loopSwitch = new Adw.SwitchRow({
            title: 'Loop video',
            subtitle: 'Continuously replay the video when it ends',
        });
        window._settings.bind(
            Keys.LOOPED, loopSwitch, 
            'active', Gio.SettingsBindFlags.DEFAULT
        );

        // Loop only applies to single-video mode. With multiple videos,
        // the playlist always cycles through all videos automatically.
        const updateLoopSensitivity = () => {
            try {
                const isPerMonitor = window._settings.get_boolean(Keys.LOCKSCREEN_PER_MONITOR);
                if (isPerMonitor) {
                    const config = this._getLockscreenPerMonitorConfig(window);
                    const hasMultiple = Object.values(config).some(paths => Array.isArray(paths) && paths.length > 1);
                    if (hasMultiple) {
                        loopSwitch.set_sensitive(false);
                        loopSwitch.subtitle = 'Not applicable — monitors with multiple videos always cycle through their playlist';
                    } else {
                        loopSwitch.set_sensitive(true);
                        loopSwitch.subtitle = 'Continuously replay the video when it ends';
                    }
                } else {
                    const paths = window._settings.get_strv(Keys.VIDEO_PATHS);
                    const count = paths && Array.isArray(paths) ? paths.length : 0;
                    if (count > 1) {
                        loopSwitch.set_sensitive(false);
                        loopSwitch.subtitle = 'Not applicable — multiple videos always cycle through the playlist automatically';
                    } else {
                        loopSwitch.set_sensitive(true);
                        loopSwitch.subtitle = 'Continuously replay the video when it ends';
                    }
                }
            } catch (e) {
                loopSwitch.set_sensitive(true);
            }
        };
        updateLoopSensitivity();
        window._settings.connect('changed::' + Keys.VIDEO_PATHS, updateLoopSensitivity);
        window._settings.connect('changed::' + Keys.LOCKSCREEN_PER_MONITOR, updateLoopSensitivity);
        window._settings.connect('changed::' + Keys.LOCKSCREEN_PER_MONITOR_CONFIG, updateLoopSensitivity);

        generalGroup.add(loopSwitch);
        generalGroup.add(volumeRow);
        generalGroup.add(scalingRow);

        return generalGroup;
    }

    _buildAppearanceGroup(window) {
        let appearanceGroup = new Adw.PreferencesGroup({
            title: 'Appearance',
        });

        // Auto-detect FPS toggle
        const autoFpsSwitch = new Adw.SwitchRow({
            title: 'Auto-detect FPS',
            subtitle: 'Automatically use each video\'s native framerate',
        });
        window._settings.bind(
            Keys.VIDEO_AUTO_FPS, autoFpsSwitch,
            'active', Gio.SettingsBindFlags.DEFAULT
        );
        appearanceGroup.add(autoFpsSwitch);

        let fpsRow = new Adw.SpinRow({
            title: 'Framerate',
            subtitle: 'Manual framerate (used when auto-detect is off)',
        });
        
        const toggleFpsRow = () => {
            fpsRow.set_sensitive(!autoFpsSwitch.active);
        };
        toggleFpsRow();
        autoFpsSwitch.connect('notify::active', toggleFpsRow);
        
        fpsRow.set_adjustment(new Gtk.Adjustment({
            lower: 1,
            upper: 120,
            step_increment: 1,
            value: window._settings.get_int(Keys.FRAMERATE),
        }));
        fpsRow.connect('notify::value', row => {
            window._settings.set_int(Keys.FRAMERATE, row.get_value());
        });
        let fpsSuffix = new Gtk.Label({
            label: 'fps',
            valign: Gtk.Align.CENTER,
            css_classes: ['dim-label'],
        });
        fpsRow.add_suffix(fpsSuffix);

        appearanceGroup.add(fpsRow);


        let fadeInRow = new Adw.SpinRow({
            title: 'Fade in',
            subtitle: 'Video fade-in animation duration',
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 600 * 1000, // 10 minutes (I think thats big enough)
                step_increment: 100,
                value: window._settings.get_int(Keys.FADE_IN_DURATION),
            }),
        });
        // Add "ms" suffix label
        let fadeSuffix = new Gtk.Label({
            label: 'ms',
            valign: Gtk.Align.CENTER,
            css_classes: ['dim-label'],
        });
        fadeInRow.add_suffix(fadeSuffix);
        fadeInRow.connect('notify::value', row => {
            window._settings.set_int(Keys.FADE_IN_DURATION, row.get_value());
        });
        appearanceGroup.add(fadeInRow);

        let blurRadiusRow = new Adw.SpinRow({
            title: 'Blur radius',
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 100,
                step_increment: 1,
                value: window._settings.get_int(Keys.BLUR_RADIUS),
            }),
        });
        let radiusSuffix = new Gtk.Label({
            label: 'px',
            valign: Gtk.Align.CENTER,
            css_classes: ['dim-label'],
        });
        blurRadiusRow.add_suffix(radiusSuffix);
        appearanceGroup.add(blurRadiusRow);

        let blurBrightnessRow = new Adw.SpinRow({
            title: 'Blur brightness',
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 100,
                step_increment: 1,
                value: window._settings.get_double(Keys.BLUR_BRIGHTNESS) * 100,
            }),
        });
        let brightnessSuffix = new Gtk.Label({
            label: '%',
            valign: Gtk.Align.CENTER,
            css_classes: ['dim-label'],
        });
        blurBrightnessRow.add_suffix(brightnessSuffix);
        appearanceGroup.add(blurBrightnessRow);

        const toggleBrightnessSpin = () => {
            blurBrightnessRow.set_sensitive(blurRadiusRow.get_value() !== 0);
        };
        toggleBrightnessSpin();

        // Connecting signals
        blurRadiusRow.connect('notify::value', row => {
            window._settings.set_int(Keys.BLUR_RADIUS, row.get_value());
            toggleBrightnessSpin()
        });
        blurBrightnessRow.connect('notify::value', row => {
            window._settings.set_double(Keys.BLUR_BRIGHTNESS, row.get_value() / 100);
        });

        return appearanceGroup;
    }

    _buildPromptGroup(window) {
        let promptGroup = new Adw.PreferencesGroup({
            title: 'Password Prompt',
            description: 'Customize behavior when password prompt appears',
        });

        const pauseSwitch = new Adw.SwitchRow({
            title: 'Pause video'
        });
        window._settings.bind(
            Keys.PROMPT_PAUSE, pauseSwitch,
            'active', Gio.SettingsBindFlags.DEFAULT
        );
        promptGroup.add(pauseSwitch);

        const changeBlurSwitch = new Adw.SwitchRow({
            title: 'Change blur'
        });
        window._settings.bind(
            Keys.PROMPT_CHANGE_BLUR, changeBlurSwitch,
            'active', Gio.SettingsBindFlags.DEFAULT
        );
        promptGroup.add(changeBlurSwitch);

        const blurRadiusRow = new Adw.SpinRow({
            title: 'Blur radius',
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 100,
                step_increment: 1,
                value: window._settings.get_int(Keys.PROMPT_BLUR_RADIUS),
            }),
        });
        let radiusSuffix = new Gtk.Label({
            label: 'px',
            valign: Gtk.Align.CENTER,
            css_classes: ['dim-label'],
        });
        blurRadiusRow.add_suffix(radiusSuffix);

        window._settings.bind(
            Keys.PROMPT_BLUR_RADIUS, blurRadiusRow,
            'value', Gio.SettingsBindFlags.DEFAULT
        );
        promptGroup.add(blurRadiusRow);

        const blurBrightnessRow = new Adw.SpinRow({
            title: 'Blur brightness',
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 100,
                step_increment: 1,
                value: window._settings.get_double(Keys.PROMPT_BLUR_BRIGHTNESS) * 100,
            }),
        });
        blurBrightnessRow.connect('notify::value', row => {
            window._settings.set_double(Keys.PROMPT_BLUR_BRIGHTNESS, row.get_value() / 100);
        });
        let suffix = new Gtk.Label({
            label: '%',
            valign: Gtk.Align.CENTER,
            css_classes: ['dim-label'],
        });
        blurBrightnessRow.add_suffix(suffix);
        promptGroup.add(blurBrightnessRow);

        const animDurationRow = new Adw.SpinRow({
            title: 'Animation duration',
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 600000,
                step_increment: 100,
                value: window._settings.get_int(Keys.PROMPT_BLUR_ANIM_DURATION),
            }),
        });
        window._settings.bind(
            Keys.PROMPT_BLUR_ANIM_DURATION, animDurationRow,
            'value', Gio.SettingsBindFlags.DEFAULT
        );
        let animSuffix = new Gtk.Label({
            label: 'ms',
            valign: Gtk.Align.CENTER,
            css_classes: ['dim-label'],
        });
        animDurationRow.add_suffix(animSuffix);
        promptGroup.add(animDurationRow);

        const toggleBlurRows = () => {
            const enabled = changeBlurSwitch.active;
            blurRadiusRow.set_sensitive(enabled);
            blurBrightnessRow.set_sensitive(enabled);
            animDurationRow.set_sensitive(enabled);
        };
        toggleBlurRows();
        changeBlurSwitch.connect('notify::active', toggleBlurRows);

        const grayscaleSwitch = new Adw.SwitchRow({
            title: 'Grayscale effect',
            subtitle: 'Desaturate the video to grayscale when the password prompt appears',
        });
        window._settings.bind(
            Keys.PROMPT_GRAYSCALE, grayscaleSwitch,
            'active', Gio.SettingsBindFlags.DEFAULT
        );
        promptGroup.add(grayscaleSwitch);

        return promptGroup;
    }

    _buildPerfGroup(window) {
        const group = new Adw.PreferencesGroup({
            title: 'Performance',
            description: 'Performance and renderer options. Most changes apply after wallpaper restart.',
        });

        const gtk4SinkSwitch = new Adw.SwitchRow({
            title: 'Force legacy appsink renderer',
            subtitle: 'Use the older in-process appsink path for compatibility testing.',
        });
        window._settings.bind(
            Keys.DEBUG_USE_GTK4_SINK, gtk4SinkSwitch,
            'active', Gio.SettingsBindFlags.DEFAULT
        );
        group.add(gtk4SinkSwitch);

        const pauseHiddenSwitch = new Adw.SwitchRow({
            title: 'Pause wallpaper when hidden',
            subtitle: 'Pause playback when all monitors are fully covered by windows.',
        });
        window._settings.bind(
            Keys.DEBUG_PAUSE_WHEN_HIDDEN, pauseHiddenSwitch,
            'active', Gio.SettingsBindFlags.DEFAULT
        );
        group.add(pauseHiddenSwitch);

        const adaptivePollingSwitch = new Adw.SwitchRow({
            title: 'Adaptive frame polling',
            subtitle: 'Poll quickly when frames are ready, back off when they are not.',
        });
        window._settings.bind(
            Keys.DEBUG_PUSH_FRAME_DELIVERY, adaptivePollingSwitch,
            'active', Gio.SettingsBindFlags.DEFAULT
        );
        group.add(adaptivePollingSwitch);

        const hwDecoderSwitch = new Adw.SwitchRow({
            title: 'Prefer hardware decoder',
            subtitle: 'Prefer VA-API/NVDEC over software decoding when available.',
        });
        window._settings.bind(
            Keys.DEBUG_PREFER_HW_DECODER, hwDecoderSwitch,
            'active', Gio.SettingsBindFlags.DEFAULT
        );
        group.add(hwDecoderSwitch);

        const gpuCCSwitch = new Adw.SwitchRow({
            title: 'GPU colour conversion',
            subtitle: 'Use OpenGL for YUV to BGRA conversion (appsink path only).',
        });
        window._settings.bind(
            Keys.DEBUG_GPU_COLOR_CONVERSION, gpuCCSwitch,
            'active', Gio.SettingsBindFlags.DEFAULT
        );
        group.add(gpuCCSwitch);

        if (this._hasBatteryDevice()) {
            const batterySwitch = new Adw.SwitchRow({
                title: 'Disable on battery',
                subtitle: 'Disable wallpaper and lock screen video while on battery.',
            });
            window._settings.bind(
                Keys.DISABLE_ON_BATTERY, batterySwitch,
                'active', Gio.SettingsBindFlags.DEFAULT
            );
            group.add(batterySwitch);
        }

        const hwDecoderDefaultSubtitle = 'Prefer VA-API/NVDEC over software decoding when available.';
        const gpuCCDefaultSubtitle = 'Use OpenGL for YUV to BGRA conversion (appsink path only).';
        const adaptiveDefaultSubtitle = 'Poll quickly when frames are ready, back off when they are not.';
        const appsinkOnlySuffix = 'Appsink-only (disabled while GTK4 renderer is active).';

        const updateSinkSpecificSensitivity = () => {
            const forceAppsink = window._settings.get_boolean(Keys.DEBUG_USE_GTK4_SINK);
            const usingGtkRenderer = !forceAppsink;

            hwDecoderSwitch.set_sensitive(!usingGtkRenderer);
            gpuCCSwitch.set_sensitive(!usingGtkRenderer);
            adaptivePollingSwitch.set_sensitive(!usingGtkRenderer);

            hwDecoderSwitch.set_subtitle(
                usingGtkRenderer ? `${appsinkOnlySuffix} ${hwDecoderDefaultSubtitle}` : hwDecoderDefaultSubtitle
            );
            gpuCCSwitch.set_subtitle(
                usingGtkRenderer ? `${appsinkOnlySuffix} ${gpuCCDefaultSubtitle}` : gpuCCDefaultSubtitle
            );
            adaptivePollingSwitch.set_subtitle(
                usingGtkRenderer ? `${appsinkOnlySuffix} ${adaptiveDefaultSubtitle}` : adaptiveDefaultSubtitle
            );
        };

        updateSinkSpecificSensitivity();
        window._settings.connect(`changed::${Keys.DEBUG_USE_GTK4_SINK}`, updateSinkSpecificSensitivity);

        return group;
    }

    _hasBatteryDevice() {
        try {
            const displayDevice = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SYSTEM,
                Gio.DBusProxyFlags.NONE,
                null,
                'org.freedesktop.UPower',
                '/org/freedesktop/UPower/devices/DisplayDevice',
                'org.freedesktop.UPower.Device',
                null
            );
            const isPresent = displayDevice.get_cached_property('IsPresent')?.unpack() ?? false;
            const type = displayDevice.get_cached_property('Type')?.unpack() ?? 0;
            return isPresent && type === 2; // 2 = Battery
        } catch (e) {
            return false;
        }
    }

    _buildDebugGroup(window) {
        let debugGroup = new Adw.PreferencesGroup({
            title: 'Debug',
        });

        const panelButtonSwitch = new Adw.SwitchRow({
            title: 'Show top bar quick controls',
            subtitle: 'Show the panel menu with playback and quick toggles.',
        });
        window._settings.bind(
            Keys.DEBUG_SHOW_PANEL_BUTTON, panelButtonSwitch,
            'active', Gio.SettingsBindFlags.DEFAULT
        );
        debugGroup.add(panelButtonSwitch);

        const skipFrameSwitch = new Adw.SwitchRow({
            title: 'Skip first frame',
            subtitle: "Enable this if there is a brief green screen at the start"
        });
        window._settings.bind(
            Keys.DEBUG_SKIP_FIRST_FRAME, skipFrameSwitch, 
            'active', Gio.SettingsBindFlags.DEFAULT
        );
        debugGroup.add(skipFrameSwitch);

        const skipFrameDefaultSubtitle = 'Enable this if there is a brief green screen at the start';
        const updateSkipFrameSensitivity = () => {
            const forceAppsink = window._settings.get_boolean(Keys.DEBUG_USE_GTK4_SINK);
            const usingGtkRenderer = !forceAppsink;

            skipFrameSwitch.set_sensitive(!usingGtkRenderer);
            skipFrameSwitch.set_subtitle(
                usingGtkRenderer
                    ? `Appsink-only (disabled while GTK4 renderer is active). ${skipFrameDefaultSubtitle}`
                    : skipFrameDefaultSubtitle
            );
        };
        updateSkipFrameSensitivity();
        window._settings.connect(`changed::${Keys.DEBUG_USE_GTK4_SINK}`, updateSkipFrameSensitivity);

        const helperLogsSwitch = new Adw.SwitchRow({
            title: 'Verbose GTK helper logs',
            subtitle: 'Extra GTK4 helper window logs for dock/stacking troubleshooting.',
        });
        window._settings.bind(
            Keys.DEBUG_GTK_HELPER_LOGS, helperLogsSwitch,
            'active', Gio.SettingsBindFlags.DEFAULT
        );
        debugGroup.add(helperLogsSwitch);

        // Log viewer expander
        const logExpander = new Adw.ExpanderRow({
            title: 'View Logs',
            subtitle: 'View extension logs with filtering options',
        });

        // Log type toggles
        const logTypes = [
            { key: 'metadata', label: 'Metadata', regex: '\\[Metadata\\]' },
            { key: 'pipeline', label: 'Pipeline', regex: '\\[Pipeline\\]' },
            { key: 'lockscreen', label: 'Extension', regex: '\\[LiveLockPaper\\]' },
            { key: 'wallpaper', label: 'Wallpaper', regex: '\\[Wallpaper(?::[^\\]]+)?\\]' },
            { key: 'lockscreenLog', label: 'Lock Screen', regex: '\\[LockScreen(?::[^\\]]+)?\\]' },
            { key: 'all', label: 'All logs', regex: '' },
        ];

        const logTypeSwitches = {};
        logTypes.forEach(type => {
            const switchRow = new Adw.SwitchRow({
                title: type.label,
            });
            // Default: Metadata and LiveLockScreen enabled
            switchRow.set_active(type.key === 'pipeline' || type.key === 'lockscreen' || type.key === 'wallpaper' || type.key === 'lockscreenLog' || type.key === 'all');
            logTypeSwitches[type.key] = switchRow;
            logExpander.add_row(switchRow);
        });

        // Log display area - use a box with label on top, full width
        const logContainer = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            margin_top: 8,
            margin_bottom: 8,
            margin_start: 12,
            margin_end: 12,
            hexpand: true,
        });
        
        const logLabel = new Gtk.Label({
            label: '<b>Logs</b>',
            use_markup: true,
            halign: Gtk.Align.START,
        });
        logContainer.append(logLabel);
        
        const logScrolled = new Gtk.ScrolledWindow({
            height_request: 300,
            hexpand: true,
        });
        const logTextView = new Gtk.TextView({
            editable: false,
            monospace: true,
            wrap_mode: Gtk.WrapMode.WORD,
        });
        logScrolled.set_child(logTextView);
        logContainer.append(logScrolled);
        
        // Use PreferencesRow for full-width custom content
        const logDisplayRow = new Adw.PreferencesRow();
        logDisplayRow.set_child(logContainer);
        logExpander.add_row(logDisplayRow);

        // Buttons row
        const buttonsContainer = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            margin_start: 12,
            margin_end: 12,
            margin_bottom: 8,
        });
        const refreshButton = new Gtk.Button({
            label: 'Refresh',
            icon_name: 'view-refresh-symbolic',
        });
        refreshButton.connect('clicked', () => {
            this._refreshLogs(logTextView, logTypeSwitches, logTypes);
        });
        const copyButton = new Gtk.Button({
            label: 'Copy Logs',
            icon_name: 'edit-copy-symbolic',
        });
        copyButton.connect('clicked', () => {
            this._copyLogs(logTextView);
        });
        buttonsContainer.append(refreshButton);
        buttonsContainer.append(copyButton);
        
        const buttonsRow = new Adw.ActionRow({
            title: '',
        });
        buttonsRow.add_suffix(buttonsContainer);
        logExpander.add_row(buttonsRow);

        // Initial load
        this._refreshLogs(logTextView, logTypeSwitches, logTypes);

        debugGroup.add(logExpander);
        return debugGroup;
    }

    _buildPathRow(window) {
        const group = new Adw.PreferencesGroup({
            title: 'Videos',
            description: 'Select multiple videos for playback',
            margin_top: 12, // Add top margin to match other groups
        });
        
        // Create CSS provider for rounded thumbnails (once per group)
        if (!window._thumbnailCssProvider) {
            const cssProvider = new Gtk.CssProvider();
            const css = `
                .thumbnail-frame {
                    border-radius: 6px;
                    min-width: 100px;
                    min-height: 56px;
                    background-color: alpha(@window_fg_color, 0.08);
                }
                .thumbnail-frame > picture {
                    border-radius: 6px;
                }
            `;
            cssProvider.load_from_data(css, css.length);
            const display = Gdk.Display.get_default();
            if (display) {
                Gtk.StyleContext.add_provider_for_display(
                    display,
                    cssProvider,
                    Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
                );
            }
            window._thumbnailCssProvider = cssProvider;
        }

        // Random order checkbox
        const randomOrderSwitch = new Adw.SwitchRow({
            title: 'Random order',
            subtitle: 'Play videos in random order (unchecked = play in listed order)',
        });
        window._settings.bind(
            Keys.VIDEO_RANDOM_ORDER, randomOrderSwitch,
            'active', Gio.SettingsBindFlags.DEFAULT
        );
        group.add(randomOrderSwitch);

        // Get current video paths - use try-catch in case the key doesn't exist
        let videoPaths = [];
        try {
            videoPaths = window._settings.get_strv(Keys.VIDEO_PATHS);
            // Handle null case (setting not initialized)
            if (!videoPaths || !Array.isArray(videoPaths)) {
                videoPaths = [];
            }
        } catch (e) {
            // Key doesn't exist in schema, use empty array
            videoPaths = [];
        }
        
        const singleVideoPath = window._settings.get_string(Keys.VIDEO_PATH);
        
        // Migrate single video to multiple videos if needed
        if (videoPaths.length === 0 && singleVideoPath) {
            videoPaths = [singleVideoPath];
            try {
                window._settings.set_strv(Keys.VIDEO_PATHS, videoPaths);
            } catch (e) {
                // If setting doesn't exist, skip migration
                console.log('Could not migrate video path:', e);
            }
        }

        const expanderRow = new Adw.ExpanderRow({
            title: 'Video List',
            subtitle: 'Click to expand and manage videos',
        });
        
        const listBox = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.NONE,
        });
        listBox.add_css_class('boxed-list');
        
        const scrolledWindow = new Gtk.ScrolledWindow({
            hexpand: true,
        });
        scrolledWindow.set_child(listBox);
        
        listBox.connect('row-activated', (listBox, row) => {
            if (row && row._videoPath) {
                try {
                    const file = Gio.File.new_for_path(row._videoPath);
                    if (file.query_exists(null)) {
                        const uri = GLib.filename_to_uri(row._videoPath, null);
                        Gio.AppInfo.launch_default_for_uri(uri, null, null);
                    }
                } catch (e) {
                    console.log(`[Video] Error opening video ${row._videoPath}:`, e);
                }
            }
        });
        
        const updateScrolledHeight = () => {
            try {
                const paths = window._settings.get_strv(Keys.VIDEO_PATHS);
                const count = paths && Array.isArray(paths) ? paths.length : 0;
                if (count === 0) {
                    scrolledWindow.height_request = 100; // Empty state height
                } else {
                    const calculatedHeight = count * 120;
                    scrolledWindow.height_request = calculatedHeight;
                }
            } catch (e) {
                scrolledWindow.height_request = 200;
            }
        };
        
        updateScrolledHeight();
        
        expanderRow.add_row(scrolledWindow);

        window._updateVideoListCallback = null;
        
        const updateVideoList = () => {
            let child = listBox.get_first_child();
            while (child) {
                const next = child.get_next_sibling();
                listBox.remove(child);
                child = next;
            }

            try {
                videoPaths = window._settings.get_strv(Keys.VIDEO_PATHS);
                if (!videoPaths || !Array.isArray(videoPaths)) {
                    videoPaths = [];
                }
            } catch (e) {
                videoPaths = [];
            }
            
            if (videoPaths.length === 0) {
                const emptyRow = new Gtk.ListBoxRow();
                const emptyLabel = new Gtk.Label({
                    label: 'No videos selected',
                    css_classes: ['dim-label'],
                    margin_start: 12,
                    margin_end: 12,
                    margin_top: 12,
                    margin_bottom: 12,
                });
                emptyRow.set_child(emptyLabel);
                listBox.append(emptyRow);
            } else {
                videoPaths.forEach((path, index) => {
                    const row = new Gtk.ListBoxRow();
                    const rowBox = new Gtk.Box({
                        orientation: Gtk.Orientation.HORIZONTAL,
                        spacing: 8,
                        margin_start: 8,
                        margin_end: 8,
                        margin_top: 4,
                        margin_bottom: 4,
                    });

                    // Keep thumbnail width stable so rows align cleanly.
                    const thumbnailBox = new Gtk.Box({
                        orientation: Gtk.Orientation.VERTICAL,
                        width_request: 100,
                        height_request: 56,
                        hexpand: false,
                        vexpand: false,
                        valign: Gtk.Align.CENTER,
                        overflow: Gtk.Overflow.HIDDEN,
                        css_classes: ['thumbnail-frame'],
                    });

                    const thumbnailImage = new Gtk.Picture({
                        content_fit: Gtk.ContentFit.COVER,
                        can_shrink: true,
                        halign: Gtk.Align.FILL,
                        valign: Gtk.Align.FILL,
                    });
                    thumbnailImage.set_paintable(null);
                    thumbnailBox.append(thumbnailImage);
                    rowBox.append(thumbnailBox);
                    
                    this._loadVideoThumbnail(path, thumbnailImage);

                    const infoBox = new Gtk.Box({
                        orientation: Gtk.Orientation.VERTICAL,
                        hexpand: true,
                        halign: Gtk.Align.FILL,
                        valign: Gtk.Align.CENTER,
                    });
                    const titleLabel = new Gtk.Label({
                        label: path.split('/').pop() || path,
                        halign: Gtk.Align.START,
                        xalign: 0,
                        ellipsize: Pango.EllipsizeMode.END,
                        max_width_chars: 25,
                    });
                    titleLabel.add_css_class('title-4');
                    
                    const pathLabel = new Gtk.Label({
                        label: path,
                        halign: Gtk.Align.START,
                        xalign: 0,
                        css_classes: ['dim-label'],
                        wrap: true,
                        wrap_mode: Pango.WrapMode.WORD_CHAR,
                        max_width_chars: 35,
                    });
                    pathLabel.add_css_class('caption');
                    
                    let metadataText = null; // Will be object with line1, line2, fileNotFound or null
                    let hasMetadata = false;
                    try {
                        const metadataValue = window._settings.get_value(Keys.VIDEO_METADATA);
                        let metadata = null;
                        if (metadataValue) {
                            try {
                                metadata = metadataValue.recursiveUnpack();
                            } catch (e) {
                                console.log('Error unpacking metadata:', e);
                                metadata = null;
                            }
                        }
                        
                        if (metadata && metadata[path]) {
                            const meta = metadata[path];
                            const metaStr = JSON.stringify({
                                width: meta.width,
                                height: meta.height,
                                fps: meta.fps,
                                duration: meta.duration,
                                playCount: meta.playCount
                            }, null, 2);
                            console.log(`[Metadata] Raw metadata for ${path}: ${metaStr}`);
                            
                            const extractValue = (val) => {
                                if (val === null || val === undefined) return null;
                                if (typeof val === 'object') {
                                    if (val.constructor && val.constructor.name === 'Variant') {
                                        try {
                                            const variantType = val.get_type_string();
                                            console.log(`[Metadata] Extracting variant type: ${variantType}`);
                                            if (variantType === 'i' || variantType === 'u') {
                                                const result = val.get_int32 ? val.get_int32() : (val.get_uint32 ? val.get_uint32() : null);
                                                console.log(`[Metadata] Extracted int value: ${result}`);
                                                return result;
                                            } else if (variantType === 'd') {
                                                return val.get_double();
                                            } else {
                                                const unpacked = val.recursiveUnpack();
                                                return extractValue(unpacked);
                                            }
                                        } catch (e) {
                                            try {
                                                const unpacked = val.recursiveUnpack();
                                                return extractValue(unpacked);
                                            } catch (e2) {
                                                console.log(`[Metadata] Could not extract value from variant:`, e2);
                                                return null;
                                            }
                                        }
                                    }
                                    if (val.get_int32) {
                                        const result = val.get_int32();
                                        console.log(`[Metadata] Extracted via get_int32: ${result}`);
                                        return result;
                                    }
                                    if (val.get_int) return val.get_int();
                                    if (val.get_uint32) return val.get_uint32();
                                    if (val.get_double) return val.get_double();
                                    try {
                                        const unpacked = val.recursiveUnpack();
                                        return extractValue(unpacked);
                                    } catch (e) {
                                    }
                                }
                                return val;
                            };
                            
                            let width = extractValue(meta.width);
                            let height = extractValue(meta.height);
                            let fps = extractValue(meta.fps);
                            let duration = extractValue(meta.duration);
                            let playCount = extractValue(meta.playCount);
                            
                            console.log(`[Metadata] Extracted values for ${path}:`, { width, height, fps, duration, playCount });
                            
                            const line1Parts = [];
                            const line2Parts = [];
                            
                            const fileExtension = path.split('.').pop()?.toUpperCase() || '';
                            
                            if (width && height) {
                                const typePrefix = fileExtension ? `${fileExtension} - ` : '';
                                line1Parts.push(`${typePrefix}Resolution - ${width}x${height}`);
                                hasMetadata = true;
                            }
                            if (fps) {
                                line1Parts.push(`FPS - ${fps}`);
                                hasMetadata = true;
                            }
                            if (duration !== null && duration !== undefined && duration > 0) {
                                const minutes = Math.floor(duration / 60);
                                const seconds = duration % 60;
                                line2Parts.push(`Duration - ${minutes}:${seconds.toString().padStart(2, '0')}`);
                                hasMetadata = true;
                                console.log(`[Metadata] Displaying duration: ${minutes}:${seconds.toString().padStart(2, '0')} for ${path}`);
                            } else {
                                console.log(`[Metadata] No duration to display for ${path} (value: ${duration})`);
                            }
                            if (playCount !== null && playCount !== undefined) {
                                line2Parts.push(`Plays - ${playCount}`);
                                hasMetadata = true;
                                console.log(`[Metadata] Displaying playCount: ${playCount} for ${path}`);
                            } else {
                                console.log(`[Metadata] No playCount to display for ${path} (value: ${playCount})`);
                            }
                            
                            let fileNotFound = false;
                            try {
                                const file = Gio.File.new_for_path(path);
                                if (!file.query_exists(null)) {
                                    fileNotFound = true;
                                }
                            } catch (e) {
                            }
                            
                            metadataText = {
                                line1: line1Parts.length > 0 ? line1Parts.join(' • ') : '',
                                line2: line2Parts.length > 0 ? line2Parts.join(' • ') : '',
                                fileNotFound: fileNotFound
                            };
                        }
                    } catch (e) {
                        console.log('Error getting metadata:', e);
                    }
                    
                    infoBox.append(titleLabel);
                    infoBox.append(pathLabel);
                    
                    if (metadataText && typeof metadataText === 'object') {
                        if (metadataText.line1) {
                            const metadataLine1Label = new Gtk.Label({
                                label: metadataText.line1,
                                halign: Gtk.Align.START,
                                xalign: 0,
                                css_classes: ['dim-label'],
                                wrap: true,
                                wrap_mode: Pango.WrapMode.WORD_CHAR,
                                max_width_chars: 30,
                            });
                            metadataLine1Label.add_css_class('caption');
                            infoBox.append(metadataLine1Label);
                        }
                        if (metadataText.line2) {
                            const line2Text = metadataText.line2 + (metadataText.fileNotFound ? '  ⚠️ File not found' : '');
                            const metadataLine2Label = new Gtk.Label({
                                label: line2Text,
                                halign: Gtk.Align.START,
                                xalign: 0,
                                css_classes: ['dim-label'],
                                wrap: true,
                                wrap_mode: Pango.WrapMode.WORD_CHAR,
                                max_width_chars: 30,
                            });
                            metadataLine2Label.add_css_class('caption');
                            infoBox.append(metadataLine2Label);
                        }
                    } else {
                        const detectingLabel = new Gtk.Label({
                            label: 'Detecting metadata...',
                            halign: Gtk.Align.START,
                            xalign: 0,
                            css_classes: ['dim-label'],
                        });
                        detectingLabel.add_css_class('caption');
                        infoBox.append(detectingLabel);
                    }

                    const buttonBox = new Gtk.Box({
                        orientation: Gtk.Orientation.HORIZONTAL,
                        spacing: 4,
                        halign: Gtk.Align.END,
                        valign: Gtk.Align.CENTER,
                    });

                    const upButton = new Gtk.Button({
                        icon_name: 'go-up-symbolic',
                        tooltip_text: 'Move up',
                        sensitive: index > 0,
                    });
                    upButton.connect('clicked', () => {
                        let currentPaths = [];
                        try {
                            currentPaths = window._settings.get_strv(Keys.VIDEO_PATHS);
                            if (!currentPaths || !Array.isArray(currentPaths)) {
                                currentPaths = [];
                            }
                        } catch (e) {
                            currentPaths = [];
                        }
                        if (index > 0) {
                            [currentPaths[index - 1], currentPaths[index]] = [currentPaths[index], currentPaths[index - 1]];
                            try {
                                window._settings.set_strv(Keys.VIDEO_PATHS, currentPaths);
                            } catch (e) {
                                console.log('Could not update video paths:', e);
                            }
                            updateVideoList();
                        }
                    });

                    const downButton = new Gtk.Button({
                        icon_name: 'go-down-symbolic',
                        tooltip_text: 'Move down',
                        sensitive: index < videoPaths.length - 1,
                    });
                    downButton.connect('clicked', () => {
                        let currentPaths = [];
                        try {
                            currentPaths = window._settings.get_strv(Keys.VIDEO_PATHS);
                            if (!currentPaths || !Array.isArray(currentPaths)) {
                                currentPaths = [];
                            }
                        } catch (e) {
                            currentPaths = [];
                        }
                        if (index < currentPaths.length - 1) {
                            [currentPaths[index], currentPaths[index + 1]] = [currentPaths[index + 1], currentPaths[index]];
                            try {
                                window._settings.set_strv(Keys.VIDEO_PATHS, currentPaths);
                            } catch (e) {
                                console.log('Could not update video paths:', e);
                            }
                            updateVideoList();
                        }
                    });

                    const removeButton = new Gtk.Button({
                        icon_name: 'edit-delete-symbolic',
                        tooltip_text: 'Remove',
                        css_classes: ['destructive-action'],
                    });
                    removeButton.connect('clicked', () => {
                        let currentPaths = [];
                        try {
                            currentPaths = window._settings.get_strv(Keys.VIDEO_PATHS);
                            if (!currentPaths || !Array.isArray(currentPaths)) {
                                currentPaths = [];
                            }
                        } catch (e) {
                            currentPaths = [];
                        }
                        currentPaths.splice(index, 1);
                        try {
                            if (currentPaths.length > 0) {
                                window._settings.set_strv(Keys.VIDEO_PATHS, currentPaths);
                            } else {
                                window._settings.set_strv(Keys.VIDEO_PATHS, []);
                            }
                        } catch (e) {
                            console.log('Could not update video paths:', e);
                        }
                        updateVideoList();
                    });

                    buttonBox.append(upButton);
                    buttonBox.append(downButton);
                    buttonBox.append(removeButton);

                    rowBox.set_hexpand(false);
                    rowBox.set_halign(Gtk.Align.FILL);
                    
                    rowBox.append(infoBox);
                    rowBox.append(buttonBox);
                    row.set_child(rowBox);
                    
                    row._videoPath = path;
                    
                    listBox.append(row);
                });
            }
        };

        updateVideoList();
        
        window._updateVideoListCallback = updateVideoList;
        
        try {
            const paths = window._settings.get_strv(Keys.VIDEO_PATHS);
            if (paths && paths.length > 0) {
                this._updateVideoMetadata(paths, window);
            }
        } catch (e) {
            console.log('Error triggering metadata detection:', e);
        }

        window._settings.connect('changed::' + Keys.VIDEO_PATHS, () => {
            updateVideoList();
            updateScrolledHeight(); // Update height when videos change
            try {
                const paths = window._settings.get_strv(Keys.VIDEO_PATHS);
                const count = paths && Array.isArray(paths) ? paths.length : 0;
                expanderRow.set_subtitle(`${count} video${count !== 1 ? 's' : ''} selected`);
            } catch (e) {
                expanderRow.set_subtitle('Click to expand and manage videos');
            }
        });

        try {
            const paths = window._settings.get_strv(Keys.VIDEO_PATHS);
            const count = paths && Array.isArray(paths) ? paths.length : 0;
            expanderRow.set_subtitle(`${count} video${count !== 1 ? 's' : ''} selected`);
        } catch (e) {
            expanderRow.set_subtitle('Click to expand and manage videos');
        }

        group.add(expanderRow);

        const addFilesRow = new Adw.ActionRow({
            title: 'Add Videos',
            subtitle: 'Select multiple video files',
        });

        const addFilesButton = new Adw.ButtonContent({
            icon_name: 'document-open-symbolic',
            label: 'Select Files',
        });

        addFilesRow.activatable_widget = addFilesButton;
        addFilesRow.add_suffix(addFilesButton);

        addFilesRow.connect('activated', () => {
            this._openFileDialog(window, updateVideoList, true);
        });

        group.add(addFilesRow);

        const addFolderRow = new Adw.ActionRow({
            title: 'Add Folder',
            subtitle: 'Select a folder containing videos',
        });

        const addFolderButton = new Adw.ButtonContent({
            icon_name: 'folder-open-symbolic',
            label: 'Select Folder',
        });

        addFolderRow.activatable_widget = addFolderButton;
        addFolderRow.add_suffix(addFolderButton);

        addFolderRow.connect('activated', () => {
            this._openFolderDialog(window, updateVideoList);
        });

        group.add(addFolderRow);

        // Refresh thumbnails button
        const refreshThumbRow = new Adw.ActionRow({
            title: 'Refresh Thumbnails',
            subtitle: 'Clear cached thumbnails and regenerate',
        });

        const refreshThumbButton = new Adw.ButtonContent({
            icon_name: 'view-refresh-symbolic',
            label: 'Refresh',
        });

        refreshThumbRow.activatable_widget = refreshThumbButton;
        refreshThumbRow.add_suffix(refreshThumbButton);

        refreshThumbRow.connect('activated', () => {
            // Clear all cached thumbnails
            const cacheDir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'live-lockpaper', 'thumbnails']);
            try {
                const dir = Gio.File.new_for_path(cacheDir);
                if (dir.query_exists(null)) {
                    const enumerator = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
                    let fileInfo;
                    while ((fileInfo = enumerator.next_file(null)) !== null) {
                        const child = dir.get_child(fileInfo.get_name());
                        try { child.delete(null); } catch(e) {}
                    }
                    enumerator.close(null);
                }
                console.log('[Thumbnail] Cache cleared, refreshing...');
            } catch (e) {
                console.log('[Thumbnail] Error clearing cache:', e);
            }
            // Refresh the video list to regenerate thumbnails
            updateVideoList();
        });

        group.add(refreshThumbRow);

        return group;
    }

    _detectVideoMetadata(videoPath) {
        try {
            if (!Gst.is_initialized()) {
                Gst.init([]);
            }
            
            const discoverer = new GstPbutils.Discoverer({ timeout: 3 * Gst.SECOND });
            const uri = GLib.filename_to_uri(videoPath, null);
            const info = discoverer.discover_uri(uri);
            
            const metadata = {};
            
            // Get duration
            const duration = info.get_duration();
            console.log(`[Metadata] Raw duration for ${videoPath}:`, duration, typeof duration, `(${duration ? duration / Gst.SECOND : 'N/A'} seconds)`);
            if (duration && duration > 0) {
                // Duration is in nanoseconds, convert to seconds
                const durationSeconds = Math.round(duration / Gst.SECOND);
                metadata.duration = durationSeconds;
                console.log(`[Metadata] Duration detected: ${durationSeconds} seconds (${Math.floor(durationSeconds / 60)}:${(durationSeconds % 60).toString().padStart(2, '0')})`);
            } else {
                console.log(`[Metadata] No duration found for ${videoPath} (duration value: ${duration})`);
            }
            
            const videoStreams = info.get_video_streams();
            if (videoStreams.length > 0) {
                const stream = videoStreams[0];
                metadata.width = stream.get_width();
                metadata.height = stream.get_height();
                
                // Get FPS - try multiple methods
                let fpsDetected = false;
                
                // Method 1: Try get_framerate() directly on stream
                try {
                    const fps = stream.get_framerate();
                    if (fps) {
                        // get_framerate returns a tuple [num, den]
                        let num = 0, den = 1;
                        if (Array.isArray(fps)) {
                            num = fps[0];
                            den = fps[1];
                        } else if (typeof fps === 'object') {
                            // Might be a Gst.Fraction or similar
                            num = fps.num || fps[0] || 0;
                            den = fps.den || fps[1] || 1;
                        }
                        
                        if (num > 0 && den > 0) {
                            const calculatedFps = num / den;
                            if (calculatedFps > 0 && calculatedFps < 1000) {
                                metadata.fps = Math.round(calculatedFps);
                                fpsDetected = true;
                                console.log(`FPS detected (method 1): ${metadata.fps} (${num}/${den}) for ${videoPath}`);
                            }
                        }
                    }
                } catch (e1) {
                    console.log(`Method 1 failed for ${videoPath}:`, e1);
                }
                
                if (!fpsDetected) {
                    try {
                        const caps = stream.get_caps();
                        if (caps) {
                            const numStructures = caps.get_size();
                            for (let i = 0; i < numStructures; i++) {
                                const structure = caps.get_structure(i);
                                if (structure && structure.has_field('framerate')) {
                                    const result = structure.get_fraction('framerate');
                                    console.log(`get_fraction result for ${videoPath}:`, result, typeof result, Array.isArray(result));
                                    
                                    if (result) {
                                        let num = 0, den = 1;
                                        
                                        if (Array.isArray(result)) {
                                            if (result.length >= 3) {
                                                const success = result[0];
                                                num = result[1];
                                                den = result[2];
                                                if (!success) continue;
                                            } else if (result.length >= 2) {
                                                num = result[0];
                                                den = result[1];
                                            }
                                        } else if (typeof result === 'object') {
                                            num = result.num || result[0] || 0;
                                            den = result.den || result[1] || 1;
                                        }
                                        
                                        if (typeof num === 'boolean') num = num ? 1 : 0;
                                        if (typeof den === 'boolean') den = den ? 1 : 0;
                                        
                                        num = Number(num);
                                        den = Number(den);
                                        
                                        if (num > 0 && den > 0) {
                                            const calculatedFps = num / den;
                                            if (calculatedFps > 0 && calculatedFps < 1000) {
                                                metadata.fps = Math.round(calculatedFps);
                                                fpsDetected = true;
                                                console.log(`FPS detected (method 2, structure ${i}): ${metadata.fps} (${num}/${den} = ${calculatedFps}) for ${videoPath}`);
                                                break;
                                            } else {
                                                console.log(`Invalid FPS calculation: ${num}/${den} = ${calculatedFps} for ${videoPath}`);
                                            }
                                        } else {
                                            console.log(`Invalid FPS values: num=${num}, den=${den} for ${videoPath}`);
                                        }
                                    }
                                }
                            }
                        }
                    } catch (e2) {
                        console.log(`Method 2 failed for ${videoPath}:`, e2);
                    }
                }
                
                if (!fpsDetected) {
                    try {
                        const caps = stream.get_caps();
                        if (caps) {
                            const structure = caps.get_structure(0);
                            if (structure) {
                                const fpsStr = structure.get_string('framerate');
                                if (fpsStr) {
                                    const parts = fpsStr.split('/');
                                    if (parts.length === 2) {
                                        const num = parseFloat(parts[0]);
                                        const den = parseFloat(parts[1]);
                                        if (num > 0 && den > 0) {
                                            const calculatedFps = num / den;
                                            if (calculatedFps > 0 && calculatedFps < 1000) {
                                                metadata.fps = Math.round(calculatedFps);
                                                fpsDetected = true;
                                                console.log(`FPS detected (method 3): ${metadata.fps} (${num}/${den}) for ${videoPath}`);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    } catch (e3) {
                    }
                }
                
                if (!fpsDetected) {
                    console.log(`Warning: Could not detect FPS for ${videoPath} - video may not have framerate info`);
                }
            }
            
            return metadata;
        } catch (e) {
            console.log(`Error detecting metadata for ${videoPath}:`, e);
            
            if (e.message && (e.message.includes('plug-in') || e.message.includes('missing'))) {
                console.log(`[Metadata] Attempting fallback detection for ${videoPath}`);
                return this._detectVideoMetadataFallback(videoPath);
            }
            
            return null;
        }
    }

    _detectVideoMetadataFallback(videoPath) {
        try {
            const escapedPath = videoPath.replace(/"/g, '\\"');
            const [success, stdout, stderr, exitCode] = GLib.spawn_command_line_sync(
                `ffprobe -v quiet -print_format json -show_format -show_streams "${escapedPath}"`
            );
            
            if (success && exitCode === 0 && stdout) {
                const output = stdout.toString();
                const json = JSON.parse(output);
                const metadata = {};
                
                if (json.format && json.format.duration) {
                    metadata.duration = Math.round(parseFloat(json.format.duration));
                }
                
                if (json.streams) {
                    const videoStream = json.streams.find(s => s.codec_type === 'video');
                    if (videoStream) {
                        metadata.width = videoStream.width;
                        metadata.height = videoStream.height;
                        
                        if (videoStream.r_frame_rate) {
                            const [num, den] = videoStream.r_frame_rate.split('/').map(Number);
                            if (num > 0 && den > 0) {
                                metadata.fps = Math.round(num / den);
                            }
                        } else if (videoStream.avg_frame_rate) {
                            const [num, den] = videoStream.avg_frame_rate.split('/').map(Number);
                            if (num > 0 && den > 0) {
                                metadata.fps = Math.round(num / den);
                            }
                        }
                    }
                }
                
                if (Object.keys(metadata).length > 0) {
                    console.log(`[Metadata] Fallback (ffprobe) succeeded for ${videoPath}:`, metadata);
                    return metadata;
                }
            }
        } catch (e) {
            console.log(`[Metadata] ffprobe fallback failed for ${videoPath}:`, e);
        }
        
        try {
            const escapedPath = videoPath.replace(/"/g, '\\"');
            const command = `gst-discoverer-1.0 "${escapedPath}" 2>&1`;
            const [success, stdout, stderr, exitCode] = GLib.spawn_command_line_sync(command);
            
            if (success && stdout) {
                const output = stdout.toString();
                const metadata = {};
                
                const durationMatch = output.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
                if (durationMatch) {
                    const hours = parseInt(durationMatch[1]);
                    const minutes = parseInt(durationMatch[2]);
                    const seconds = parseFloat(durationMatch[3]);
                    metadata.duration = Math.round(hours * 3600 + minutes * 60 + seconds);
                }
                
                const resolutionMatch = output.match(/Video:.*?(\d+)x(\d+)/);
                if (resolutionMatch) {
                    metadata.width = parseInt(resolutionMatch[1]);
                    metadata.height = parseInt(resolutionMatch[2]);
                }
                
                const fpsMatch = output.match(/framerate[^0-9]*(\d+)\/(\d+)/);
                if (fpsMatch) {
                    const num = parseInt(fpsMatch[1]);
                    const den = parseInt(fpsMatch[2]);
                    if (den > 0) {
                        metadata.fps = Math.round(num / den);
                    }
                }
                
                if (Object.keys(metadata).length > 0) {
                    console.log(`[Metadata] Fallback (gst-discoverer-1.0) succeeded for ${videoPath}:`, metadata);
                    return metadata;
                }
            }
        } catch (e) {
            console.log(`[Metadata] gst-discoverer-1.0 fallback failed for ${videoPath}:`, e);
        }
        
        console.log(`[Metadata] All fallback methods failed for ${videoPath}`);
        return null;
    }

    _updateVideoMetadata(videoPaths, window, metadataKey = Keys.VIDEO_METADATA, refreshCallback = null) {
        try {
            let metadata = {};
            try {
                const currentMetadata = window._settings.get_value(metadataKey).recursiveUnpack();
                if (currentMetadata) {
                    metadata = currentMetadata;
                }
            } catch (e) {
                metadata = {};
            }
            
            let updated = false;
            const detectPromises = [];
            
            videoPaths.forEach(path => {
                let needsDetection = false;
                if (!metadata[path]) {
                    needsDetection = true;
                } else {
                    const existing = metadata[path];
                    let hasWidth = false, hasFps = false, hasDuration = false;
                    const checkValue = (val) => {
                        if (val === null || val === undefined) return false;
                        if (typeof val === 'object' && val.constructor && val.constructor.name === 'Variant') {
                            try {
                                const unpacked = val.recursiveUnpack();
                                return unpacked !== null && unpacked !== undefined;
                            } catch (e) {
                                return false;
                            }
                        }
                        return true;
                    };
                    if (existing.width && checkValue(existing.width)) {
                        hasWidth = true;
                    }
                    if (existing.fps && checkValue(existing.fps)) {
                        hasFps = true;
                    }
                    if (existing.duration && checkValue(existing.duration)) {
                        hasDuration = true;
                    }
                    if (!hasWidth || !hasFps || !hasDuration) {
                        needsDetection = true;
                    }
                }
                
                if (needsDetection) {
                    detectPromises.push(
                        new Promise((resolve) => {
                            try {
                                console.log(`[Metadata] Detecting metadata for: ${path}`);
                                const detected = this._detectVideoMetadata(path);
                                console.log(`[Metadata] Detection result for ${path}:`, detected);
                                if (detected && (detected.fps || detected.width || detected.duration)) {
                                    if (metadata[path]) {
                                        const existing = metadata[path];
                                        const existingPlayCount = existing.playCount;
                                        if (detected.width) metadata[path].width = detected.width;
                                        if (detected.height) metadata[path].height = detected.height;
                                        if (detected.fps) metadata[path].fps = detected.fps;
                                        if (detected.duration) metadata[path].duration = detected.duration;
                                        if (existingPlayCount !== undefined && existingPlayCount !== null) {
                                            metadata[path].playCount = existingPlayCount;
                                        } else if (!metadata[path].playCount) {
                                            metadata[path].playCount = 0;
                                        }
                                    } else {
                                        metadata[path] = detected;
                                        if (!metadata[path].playCount) {
                                            metadata[path].playCount = 0;
                                        }
                                    }
                                    updated = true;
                                    console.log(`Detected metadata for ${path}:`, detected);
                                } else {
                                    if (!metadata[path]) {
                                        metadata[path] = { playCount: 0 };
                                    } else if (metadata[path].playCount === undefined || metadata[path].playCount === null) {
                                        metadata[path].playCount = 0;
                                    }
                                    console.log(`No metadata detected for ${path}`);
                                }
                            } catch (e) {
                                console.log(`Error detecting metadata for ${path}:`, e);
                            }
                            resolve();
                        })
                    );
                }
            });
            
            if (detectPromises.length > 0) {
                Promise.all(detectPromises).then(() => {
                    if (updated) {
                        try {
                            const variantDict = {};
                            for (const [key, value] of Object.entries(metadata)) {
                                const valueDict = {};
                                if (value.fps !== undefined && value.fps !== null) {
                                    valueDict['fps'] = new GLib.Variant('i', value.fps);
                                }
                                if (value.width !== undefined && value.width !== null) {
                                    valueDict['width'] = new GLib.Variant('i', value.width);
                                }
                                if (value.height !== undefined && value.height !== null) {
                                    valueDict['height'] = new GLib.Variant('i', value.height);
                                }
                                if (value.duration !== undefined && value.duration !== null) {
                                    valueDict['duration'] = new GLib.Variant('i', value.duration);
                                    console.log(`[Metadata] Saving duration for ${key}: ${value.duration} seconds`);
                                }
                                const playCount = (value.playCount !== undefined && value.playCount !== null) ? value.playCount : 0;
                                valueDict['playCount'] = new GLib.Variant('i', playCount);
                                console.log(`[Metadata] Saving playCount for ${key}: ${playCount}`);
                                variantDict[key] = new GLib.Variant('a{sv}', valueDict);
                            }
                            const variant = new GLib.Variant('a{sv}', variantDict);
                            window._settings.set_value(metadataKey, variant);
                            console.log(`[Metadata] Saved metadata variant for ${Object.keys(variantDict).length} videos`);
                            
                            if (refreshCallback) {
                                refreshCallback();
                            } else if (window._updateVideoListCallback) {
                                window._updateVideoListCallback();
                            }
                        } catch (e) {
                            console.log('Error saving video metadata:', e);
                        }
                    }
                });
            }
        } catch (e) {
            console.log('Error updating video metadata:', e);
        }
    }

    _openFileDialog(window, updateCallback, selectMultiple = true) {
        let filter = new Gtk.FileFilter();
        filter.set_name('Video files');
        filter.add_mime_type('video/*');

        let filters = new Gio.ListStore({ item_type: Gtk.FileFilter });
        filters.append(filter);

        let dialog = new Gtk.FileDialog({ 
            title: selectMultiple ? 'Select Video Files' : 'Select Video File'
        });
        dialog.set_filters(filters);
        if (selectMultiple) {
            dialog.set_accept_label('Select');
        }

        let videoPaths = [];
        try {
            videoPaths = window._settings.get_strv(Keys.VIDEO_PATHS);
            if (!videoPaths || !Array.isArray(videoPaths)) {
                videoPaths = [];
            }
        } catch (e) {
            videoPaths = [];
        }
        if (videoPaths.length > 0) {
            try {
                const file = Gio.File.new_for_path(videoPaths[0]);
                const parentFolder = file.get_parent();
                if (parentFolder)
                    dialog.set_initial_folder(parentFolder);
            } catch (e) {
            }
        } else {
            const singleVideoPath = window._settings.get_string(Keys.VIDEO_PATH);
            if (singleVideoPath) {
                try {
                    const file = Gio.File.new_for_path(singleVideoPath);
                    const parentFolder = file.get_parent();
                    if (parentFolder)
                        dialog.set_initial_folder(parentFolder);
                } catch (e) {
                }
            }
        }

        if (selectMultiple) {
            dialog.open_multiple(window, null, (d, result) => {
                try {
                    let files = d.open_multiple_finish(result);
                    if (files && files.get_n_items() > 0) {
                        let currentPaths = [];
                        try {
                            currentPaths = window._settings.get_strv(Keys.VIDEO_PATHS);
                            if (!currentPaths || !Array.isArray(currentPaths)) {
                                currentPaths = [];
                            }
                        } catch (e) {
                            currentPaths = [];
                        }
                        
                        let added = false;
                        for (let i = 0; i < files.get_n_items(); i++) {
                            let file = files.get_item(i);
                            const newPath = file.get_path();
                            if (newPath && !currentPaths.includes(newPath)) {
                                currentPaths.push(newPath);
                                added = true;
                            }
                        }
                        
                        if (added) {
                            try {
                                window._settings.set_strv(Keys.VIDEO_PATHS, currentPaths);
                                // Detect metadata for new videos
                                this._updateVideoMetadata(currentPaths, window);
                                if (updateCallback) updateCallback();
                            } catch (e) {
                                console.log('Could not save video paths:', e);
                            }
                        }
                    }
                } catch (e) {
                    console.log(`Error selecting files: ${e}`);
                }
            });
        } else {
            dialog.open(window, null, (d, result) => {
                try {
                    let file = d.open_finish(result);
                    if (file) {
                        let currentPaths = [];
                        try {
                            currentPaths = window._settings.get_strv(Keys.VIDEO_PATHS);
                            if (!currentPaths || !Array.isArray(currentPaths)) {
                                currentPaths = [];
                            }
                        } catch (e) {
                            currentPaths = [];
                        }
                        const newPath = file.get_path();
                        
                        if (newPath && !currentPaths.includes(newPath)) {
                            currentPaths.push(newPath);
                            try {
                                window._settings.set_strv(Keys.VIDEO_PATHS, currentPaths);
                                // Detect metadata for new video
                                this._updateVideoMetadata(currentPaths, window);
                                if (updateCallback) updateCallback();
                            } catch (e) {
                                console.log('Could not save video paths:', e);
                            }
                        }
                    }
                } catch (e) {
                    console.log(`Error selecting file: ${e}`);
                }
            });
        }
    }

    _openFolderDialog(window, updateCallback) {
        let dialog = new Gtk.FileDialog({ 
            title: 'Select Folder Containing Videos'
        });
        dialog.set_accept_label('Select Folder');

        // Try to get initial folder from existing videos
        let videoPaths = [];
        try {
            videoPaths = window._settings.get_strv(Keys.VIDEO_PATHS);
            if (!videoPaths || !Array.isArray(videoPaths)) {
                videoPaths = [];
            }
        } catch (e) {
            videoPaths = [];
        }
        if (videoPaths.length > 0) {
            try {
                const file = Gio.File.new_for_path(videoPaths[0]);
                const parentFolder = file.get_parent();
                if (parentFolder)
                    dialog.set_initial_folder(parentFolder);
            } catch (e) {
                // Ignore errors
            }
        }

        dialog.select_folder(window, null, (d, result) => {
            try {
                let folder = d.select_folder_finish(result);
                if (folder) {
                    const folderPath = folder.get_path();
                    this._scanFolderForVideos(folderPath, window, updateCallback);
                }
            } catch (e) {
                console.log(`Error selecting folder: ${e}`);
            }
        });
    }

    _scanFolderForVideos(folderPath, window, updateCallback) {
        try {
            const folder = Gio.File.new_for_path(folderPath);
            const enumerator = folder.enumerate_children(
                'standard::name,standard::type',
                Gio.FileQueryInfoFlags.NONE,
                null
            );

            let videoExtensions = ['.mp4', '.avi', '.mkv', '.mov', '.webm', '.flv', '.wmv', '.m4v', '.3gp', '.ogv'];
            let videoFiles = [];

            let fileInfo;
            while ((fileInfo = enumerator.next_file(null)) !== null) {
                const fileName = fileInfo.get_name();
                const fileType = fileInfo.get_file_type();
                
                if (fileType === Gio.FileType.REGULAR) {
                    const lowerName = fileName.toLowerCase();
                    if (videoExtensions.some(ext => lowerName.endsWith(ext))) {
                        const filePath = folder.get_child(fileName).get_path();
                        videoFiles.push(filePath);
                    }
                }
            }

            if (videoFiles.length > 0) {
                let currentPaths = [];
                try {
                    currentPaths = window._settings.get_strv(Keys.VIDEO_PATHS);
                    if (!currentPaths || !Array.isArray(currentPaths)) {
                        currentPaths = [];
                    }
                } catch (e) {
                    currentPaths = [];
                }

                let added = false;
                videoFiles.forEach(newPath => {
                    if (!currentPaths.includes(newPath)) {
                        currentPaths.push(newPath);
                        added = true;
                    }
                });

                if (added) {
                    try {
                        window._settings.set_strv(Keys.VIDEO_PATHS, currentPaths);
                        // Detect metadata for new videos
                        this._updateVideoMetadata(currentPaths, window);
                        if (updateCallback) updateCallback();
                    } catch (e) {
                        console.log('Could not save video paths:', e);
                    }
                }
            } else {
                console.log('No video files found in selected folder');
            }
        } catch (e) {
            console.log(`Error scanning folder: ${e}`);
        }
    }

    _validateVideos(window) {
        try {
            const videoPaths = window._settings.get_strv(Keys.VIDEO_PATHS);
            if (!videoPaths || videoPaths.length === 0) return;
            
            const validPaths = [];
            const invalidPaths = [];
            const folderPaths = new Set();
            
            // First pass: validate existing paths and identify folders
            for (const path of videoPaths) {
                try {
                    const file = Gio.File.new_for_path(path);
                    if (file.query_exists(null)) {
                        validPaths.push(path);
                        // Check if this path's parent directory contains other videos
                        // If multiple videos share the same parent, it's likely a folder selection
                        const parent = file.get_parent();
                        if (parent) {
                            folderPaths.add(parent.get_path());
                        }
                    } else {
                        invalidPaths.push(path);
                        console.log(`[LiveLockScreen] Video file not found: ${path}`);
                    }
                } catch (e) {
                    invalidPaths.push(path);
                    console.log(`[LiveLockScreen] Error checking video file: ${path}`, e);
                }
            }
            
            // Second pass: rescan folders for new videos
            const videoExtensions = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv', '.wmv', '.m4v'];
            let newVideosFound = false;
            
            for (const folderPath of folderPaths) {
                try {
                    const folder = Gio.File.new_for_path(folderPath);
                    if (folder.query_exists(null)) {
                        const enumerator = folder.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
                        
                        let fileInfo;
                        while ((fileInfo = enumerator.next_file(null)) !== null) {
                            const fileName = fileInfo.get_name();
                            const filePath = GLib.build_filenamev([folderPath, fileName]);
                            const lowerName = fileName.toLowerCase();
                            
                            if (videoExtensions.some(ext => lowerName.endsWith(ext))) {
                                if (!validPaths.includes(filePath)) {
                                    validPaths.push(filePath);
                                    newVideosFound = true;
                                    console.log(`[LiveLockScreen] Found new video in folder: ${filePath}`);
                                }
                            }
                        }
                        enumerator.close(null);
                    }
                } catch (e) {
                    console.log(`[LiveLockScreen] Error rescanning folder ${folderPath}:`, e);
                }
            }
            
            // Update settings if there are changes
            if (invalidPaths.length > 0 || newVideosFound) {
                window._settings.set_strv(Keys.VIDEO_PATHS, validPaths);
                if (invalidPaths.length > 0) {
                    console.log(`[LiveLockScreen] Removed ${invalidPaths.length} invalid video path(s)`);
                }
                if (newVideosFound) {
                    console.log(`[LiveLockScreen] Added new video(s) from folders`);
                    // Trigger metadata update for new videos
                    this._updateVideoMetadata(validPaths, window);
                }
            }
        } catch (e) {
            console.log('Error validating videos:', e);
        }
    }


    _refreshLogs(logTextView, logTypeSwitches, logTypes) {
        try {
            // Get active log types
            const activeTypes = logTypes.filter(type => {
                return logTypeSwitches[type.key].active;
            });

            // Build journalctl command using shell
            const extensionUuid = 'live-lockpaper@DeLuca21';
            
            // Use sh -c to properly handle pipes
            let filterCmd = '';
            if (!logTypeSwitches['all'].active && activeTypes.length > 0) {
                const prefixes = activeTypes
                    .filter(t => t.key !== 'all' && t.regex)
                    .map(t => t.regex)
                    .join('|');
                if (prefixes) {
                    // Use grep with -E for extended regex, properly escaped
                    filterCmd = ` | grep -E '${prefixes}'`;
                }
            }
            
            // Build the full command with proper escaping
            // GNOME Shell extension logs are in journalctl
            // Extension console.log messages appear in journalctl under gnome-shell
            // Try multiple approaches to find the logs
            const searchTerms = `${extensionUuid}|live-lockpaper|LiveLockPaper|LiveLockScreen|Metadata|Pipeline`;
            const baseCmd = `(journalctl --user -n 1000 --no-pager -o cat 2>/dev/null | grep -iE '${searchTerms}' || journalctl --user -n 1000 --no-pager -o short 2>/dev/null | grep -iE '${searchTerms}' | sed 's/^[^:]*: //' || echo '')`;
            const command = filterCmd ? `sh -c "${baseCmd}${filterCmd} 2>&1"` : `sh -c "${baseCmd} 2>&1"`;

            // Execute command
            const [success, stdout, stderr, exitStatus] = GLib.spawn_command_line_sync(command);
            
            let logText = '';
            // Handle different exit codes:
            // 0 = success with output
            // 1 = grep found no matches (normal when filtering)
            // 256 = exit code 1 from shell (grep no matches)
            // Other = actual error
            
            const exitCode = exitStatus >>> 8; // Get actual exit code (status is in high byte)
            
            if (success && (exitCode === 0 || exitCode === 1) && stdout && stdout.length > 0) {
                logText = new TextDecoder().decode(stdout);
                // Filter out stack traces - they start with function names and @file://
                const lines = logText.split('\n');
                const filteredLines = lines.filter(line => {
                    // Skip stack trace lines (they contain @file:// or are just function names)
                    if (line.includes('@file://')) return false;
                    if (line.match(/^[a-zA-Z_][a-zA-Z0-9_]*@/)) return false;
                    if (line.match(/^[a-zA-Z_][a-zA-Z0-9_]*\/</)) return false;
                    if (line.trim() === '') return false;
                    return true;
                });
                
                logText = filteredLines.join('\n');
                
                if (!logText.trim()) {
                    logText = 'No logs found matching the selected filters. Try selecting different log types or check if the extension is running.';
                }
            } else {
                const errorText = stderr && stderr.length > 0 ? new TextDecoder().decode(stderr) : '';
                if (exitCode === 1 || exitCode === 256) {
                    // Exit code 1 from grep means no matches - this is normal
                    logText = 'No logs found matching the selected filters. Try selecting different log types or check if the extension is running.';
                } else {
                    logText = `Error reading logs (exit code: ${exitCode}): ${errorText || 'No output'}`;
                }
            }

            // Update text view
            const buffer = logTextView.get_buffer();
            buffer.set_text(logText, -1);
            
            // Scroll to bottom
            const endIter = buffer.get_end_iter();
            buffer.place_cursor(endIter);
            logTextView.scroll_to_iter(endIter, 0.0, false, 0.0, 0.0);
        } catch (e) {
            console.log('Error refreshing logs:', e);
            const buffer = logTextView.get_buffer();
            buffer.set_text(`Error reading logs: ${e.message}`, -1);
        }
    }

    _copyLogs(logTextView) {
        try {
            const buffer = logTextView.get_buffer();
            const [start, end] = buffer.get_bounds();
            const text = buffer.get_text(start, end, false);
            
            const clipboard = Gdk.Display.get_default().get_clipboard();
            clipboard.set(text);
            
            const bufferText = buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), false);
            if (bufferText.length > 0) {
                console.log('Logs copied to clipboard');
            }
        } catch (e) {
            console.log('Error copying logs:', e);
        }
    }

    _getThumbnailCachePath(videoPath) {
        // Ensure thumbnail cache directory exists.
        const cacheDir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'live-lockpaper', 'thumbnails']);
        try {
            const dir = Gio.File.new_for_path(cacheDir);
            if (!dir.query_exists(null)) {
                dir.make_directory_with_parents(null);
            }
        } catch (e) {
            // Directory might already exist
        }
        
        const file = Gio.File.new_for_path(videoPath);
        let mtime = 0;
        try {
            const info = file.query_info('time::modified', Gio.FileQueryInfoFlags.NONE, null);
            mtime = info.get_modification_time().tv_sec;
        } catch (e) {
        }
        
        const hashInput = `${videoPath}:${mtime}`;
        let hash = 0;
        for (let i = 0; i < hashInput.length; i++) {
            const char = hashInput.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32-bit integer
        }
        const hashStr = Math.abs(hash).toString(16);
        
        return GLib.build_filenamev([cacheDir, `thumb_${hashStr}.png`]);
    }

    // Load thumbnail at fixed display size for consistent row layout.
    _setThumbnailAtDisplaySize(pictureWidget, filePath) {
        try {
            const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(filePath, 100, 56, false);
            const texture = Gdk.Texture.new_for_pixbuf(pixbuf);
            pictureWidget.set_paintable(texture);
            return true;
        } catch (e) {
            console.log(`[Thumbnail] Error loading thumbnail from ${filePath}:`, e);
            return false;
        }
    }

    _loadVideoThumbnail(videoPath, pictureWidget) {
        const cachePath = this._getThumbnailCachePath(videoPath);
        const cacheFile = Gio.File.new_for_path(cachePath);
        
        if (cacheFile.query_exists(null)) {
            try {
                const fileInfo = cacheFile.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null);
                const fileSize = fileInfo.get_size();
                if (fileSize > 0) {
                    if (this._setThumbnailAtDisplaySize(pictureWidget, cachePath)) {
                        console.log(`[Thumbnail] Using cached thumbnail for ${videoPath} (${fileSize} bytes)`);
                        return;
                    }
                } else {
                    console.log(`[Thumbnail] Deleting empty cached thumbnail for ${videoPath}`);
                    cacheFile.delete(null);
                }
            } catch (e) {
                console.log(`[Thumbnail] Error checking cached thumbnail for ${videoPath}:`, e);
            }
        }
        
        console.log(`[Thumbnail] Generating thumbnail for ${videoPath}`);
        
        const quotedVideoPath = GLib.shell_quote(videoPath);
        const quotedCachePath = GLib.shell_quote(cachePath);
        
        // Generate at 2x and downscale on load for sharper thumbnails.
        const ffmpegCommand = `ffmpeg -y -ss 1 -i ${quotedVideoPath} -vframes 1 -update 1 -vf "scale=200:112:force_original_aspect_ratio=increase,crop=200:112" ${quotedCachePath}`;
        console.log(`[Thumbnail] Command: ${ffmpegCommand}`);
        
        try {
            GLib.spawn_command_line_async(ffmpegCommand);
        } catch (e) {
            console.log(`[Thumbnail] Failed to spawn ffmpeg for ${videoPath}:`, e);
            return;
        }
        
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
            try {
                const file = Gio.File.new_for_path(cachePath);
                if (file.query_exists(null)) {
                    const info = file.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null);
                    if (info.get_size() > 0) {
                        this._setThumbnailAtDisplaySize(pictureWidget, cachePath);
                        console.log(`[Thumbnail] Loaded thumbnail for ${videoPath} (${info.get_size()} bytes)`);
                    } else {
                        try { file.delete(null); } catch(de) {}
                        console.log(`[Thumbnail] Empty thumbnail file for ${videoPath}`);
                    }
                } else {
                    console.log(`[Thumbnail] Thumbnail not created for ${videoPath}, ffmpeg may have failed`);
                }
            } catch (e) {
                console.log(`[Thumbnail] Error checking thumbnail for ${videoPath}:`, e);
            }
            return false;
        });
    }

    // Wallpaper preferences

    // Get connected monitors and basic display info.
    _getDetectedMonitors() {
        const monitors = [];
        try {
            const display = Gdk.Display.get_default();
            if (display) {
                const monitorList = display.get_monitors();
                const count = monitorList.get_n_items();
                for (let i = 0; i < count; i++) {
                    const mon = monitorList.get_item(i);
                    let connector = '';
                    try { connector = mon.connector || ''; } catch (e) {}
                    if (!connector) {
                        try { connector = mon.get_connector ? mon.get_connector() : ''; } catch (e) {}
                    }
                    let geo = { width: 0, height: 0 };
                    try { geo = mon.get_geometry(); } catch (e) {}
                    let model = '';
                    try { model = mon.get_model() || ''; } catch (e) {}
                    let manufacturer = '';
                    try { manufacturer = mon.get_manufacturer() || ''; } catch (e) {}
                    monitors.push({
                        index: i,
                        connector: connector || `Monitor-${i}`,
                        width: geo.width,
                        height: geo.height,
                        model: model,
                        manufacturer: manufacturer,
                    });
                }
            }
        } catch (e) {
            console.log('[Prefs] Error detecting monitors:', e);
        }
        if (monitors.length === 0) {
            monitors.push({ index: 0, connector: 'Unknown', width: 0, height: 0, model: '', manufacturer: '' });
        }
        return monitors;
    }

    // Read wallpaper per-monitor config JSON.
    _getPerMonitorConfig(window) {
        try {
            const json = window._settings.get_string(Keys.WALLPAPER_PER_MONITOR_CONFIG);
            const config = JSON.parse(json);
            return (config && typeof config === 'object') ? config : {};
        } catch (e) {
            return {};
        }
    }

    // Write wallpaper per-monitor config JSON.
    _setPerMonitorConfig(window, config) {
        try {
            window._settings.set_string(Keys.WALLPAPER_PER_MONITOR_CONFIG, JSON.stringify(config));
        } catch (e) {
            console.log('[Prefs] Error saving per-monitor config:', e);
        }
    }

    // Read lock screen per-monitor config JSON.
    _getLockscreenPerMonitorConfig(window) {
        try {
            const json = window._settings.get_string(Keys.LOCKSCREEN_PER_MONITOR_CONFIG);
            const config = JSON.parse(json);
            return (config && typeof config === 'object') ? config : {};
        } catch (e) {
            return {};
        }
    }

    // Write lock screen per-monitor config JSON.
    _setLockscreenPerMonitorConfig(window, config) {
        try {
            window._settings.set_string(Keys.LOCKSCREEN_PER_MONITOR_CONFIG, JSON.stringify(config));
        } catch (e) {
            console.log('[Prefs] Error saving lockscreen per-monitor config:', e);
        }
    }

    // Lock screen single-video group (when per-monitor is off).
    _buildLockscreenSingleVideoGroup(window) {
        const group = new Adw.PreferencesGroup({
            title: 'Videos',
            description: 'Videos shared across all monitors on the lock screen',
        });

        this._ensureThumbnailCss(window);

        const getPaths = () => {
            try {
                const p = window._settings.get_strv(Keys.VIDEO_PATHS);
                return (p && Array.isArray(p)) ? p : [];
            } catch (e) { return []; }
        };
        const setPaths = (paths) => {
            window._settings.set_strv(Keys.VIDEO_PATHS, paths);
            // Also update legacy single-path key for backward compat
            if (paths.length > 0) {
                window._settings.set_string(Keys.VIDEO_PATH, paths[0]);
            }
        };

        const widget = this._buildVideoListWidget(window, {
            getPaths, setPaths,
            metadataKey: Keys.VIDEO_METADATA,
            title: 'Video List',
        });

        group.add(widget.expanderRow);
        group.add(widget.addFilesRow);
        group.add(widget.addFolderRow);
        group.add(widget.refreshRow);

        window._settings.connect('changed::' + Keys.VIDEO_PATHS, () => {
            widget.updateList();
        });

        const paths = getPaths();
        if (paths.length > 0) {
            this._updateVideoMetadata(paths, window, Keys.VIDEO_METADATA, widget.updateList);
        }

        return group;
    }

    // Lock screen per-monitor group (when per-monitor is on).
    _buildLockscreenPerMonitorGroup(window) {
        const group = new Adw.PreferencesGroup({
            title: 'Per-Monitor Videos',
            description: 'Each monitor has its own independent set of videos on the lock screen',
        });

        this._ensureThumbnailCss(window);

        const monitors = this._getDetectedMonitors();

        monitors.forEach((mon) => {
            const connector = mon.connector;
            const displayName = mon.manufacturer && mon.model
                ? `${mon.connector} — ${mon.manufacturer} ${mon.model} (${mon.width}×${mon.height})`
                : `${mon.connector} (${mon.width}×${mon.height})`;

            const getPaths = () => {
                const config = this._getLockscreenPerMonitorConfig(window);
                return (config[connector] && Array.isArray(config[connector])) ? config[connector] : [];
            };
            const setPaths = (paths) => {
                const config = this._getLockscreenPerMonitorConfig(window);
                config[connector] = paths;
                this._setLockscreenPerMonitorConfig(window, config);
            };

            const widget = this._buildVideoListWidget(window, {
                getPaths, setPaths,
                metadataKey: Keys.VIDEO_METADATA,
                title: displayName,
            });

            group.add(widget.expanderRow);
            group.add(widget.addFilesRow);
            group.add(widget.addFolderRow);
            group.add(widget.refreshRow);

            window._settings.connect('changed::' + Keys.LOCKSCREEN_PER_MONITOR_CONFIG, () => {
                widget.updateList();
            });

            const paths = getPaths();
            if (paths.length > 0) {
                this._updateVideoMetadata(paths, window, Keys.VIDEO_METADATA, widget.updateList);
            }
        });

        if (monitors.length === 1 && monitors[0].connector === 'Unknown') {
            const infoRow = new Adw.ActionRow({
                title: 'No monitors detected',
                subtitle: 'Monitor detection may require a running Wayland/X11 session',
                icon_name: 'dialog-warning-symbolic',
            });
            group.add(infoRow);
        }

        return group;
    }

    // Shared video-list widget used by lock screen and wallpaper sections.
    _buildVideoListWidget(window, { getPaths, setPaths, metadataKey, title = 'Video List' }) {
        const paths = getPaths();

        const expanderRow = new Adw.ExpanderRow({
            title: title,
            subtitle: `${paths.length} video${paths.length !== 1 ? 's' : ''} selected`,
        });

        const listBox = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.NONE });
        listBox.add_css_class('boxed-list');

        // Open video in default player on click
        listBox.connect('row-activated', (lb, row) => {
            if (row && row._videoPath) {
                try {
                    const file = Gio.File.new_for_path(row._videoPath);
                    if (file.query_exists(null)) {
                        Gio.AppInfo.launch_default_for_uri(GLib.filename_to_uri(row._videoPath, null), null, null);
                    }
                } catch (e) {
                    console.log(`[Video] Error opening video:`, e);
                }
            }
        });

        const scrolledWindow = new Gtk.ScrolledWindow({ hexpand: true });
        scrolledWindow.set_child(listBox);
        expanderRow.add_row(scrolledWindow);

        // The extractValue helper for reading metadata variants
        const extractValue = (val) => {
            if (val === null || val === undefined) return null;
            if (typeof val === 'object') {
                if (val.constructor && val.constructor.name === 'Variant') {
                    try {
                        const variantType = val.get_type_string();
                        if (variantType === 'i' || variantType === 'u') {
                            return val.get_int32 ? val.get_int32() : (val.get_uint32 ? val.get_uint32() : null);
                        } else if (variantType === 'd') {
                            return val.get_double();
                        } else {
                            return extractValue(val.recursiveUnpack());
                        }
                    } catch (e) {
                        try { return extractValue(val.recursiveUnpack()); } catch (e2) { return null; }
                    }
                }
                if (val.get_int32) return val.get_int32();
                if (val.get_uint32) return val.get_uint32();
                if (val.get_double) return val.get_double();
                try { return extractValue(val.recursiveUnpack()); } catch (e) {}
            }
            return val;
        };

        const updateList = () => {
            // Clear existing children
            let child = listBox.get_first_child();
            while (child) {
                const next = child.get_next_sibling();
                listBox.remove(child);
                child = next;
            }

            const currentPaths = getPaths();

            if (currentPaths.length === 0) {
                const emptyRow = new Gtk.ListBoxRow();
                emptyRow.set_child(new Gtk.Label({
                    label: 'No videos selected',
                    css_classes: ['dim-label'],
                    margin_start: 12, margin_end: 12, margin_top: 12, margin_bottom: 12,
                }));
                listBox.append(emptyRow);
                scrolledWindow.height_request = 60;
            } else {
                currentPaths.forEach((path, index) => {
                    const row = new Gtk.ListBoxRow();
                    const rowBox = new Gtk.Box({
                        orientation: Gtk.Orientation.HORIZONTAL,
                        spacing: 8,
                        margin_start: 8, margin_end: 8,
                        margin_top: 4, margin_bottom: 4,
                    });

                    // Thumbnail
                    const thumbnailBox = new Gtk.Box({
                        orientation: Gtk.Orientation.VERTICAL,
                        width_request: 100, height_request: 56,
                        hexpand: false, vexpand: false,
                        valign: Gtk.Align.CENTER,
                        overflow: Gtk.Overflow.HIDDEN,
                        css_classes: ['thumbnail-frame'],
                    });
                    const thumbnailImage = new Gtk.Picture({
                        content_fit: Gtk.ContentFit.COVER,
                        can_shrink: true,
                        halign: Gtk.Align.FILL, valign: Gtk.Align.FILL,
                    });
                    thumbnailImage.set_paintable(null);
                    thumbnailBox.append(thumbnailImage);
                    rowBox.append(thumbnailBox);
                    this._loadVideoThumbnail(path, thumbnailImage);

                    // Info box
                    const infoBox = new Gtk.Box({
                        orientation: Gtk.Orientation.VERTICAL,
                        hexpand: true, halign: Gtk.Align.FILL, valign: Gtk.Align.CENTER,
                    });
                    const titleLabel = new Gtk.Label({
                        label: path.split('/').pop() || path,
                        halign: Gtk.Align.START, xalign: 0,
                        ellipsize: Pango.EllipsizeMode.END, max_width_chars: 25,
                    });
                    titleLabel.add_css_class('title-4');
                    const pathLabel = new Gtk.Label({
                        label: path,
                        halign: Gtk.Align.START, xalign: 0,
                        css_classes: ['dim-label'],
                        wrap: true, wrap_mode: Pango.WrapMode.WORD_CHAR, max_width_chars: 35,
                    });
                    pathLabel.add_css_class('caption');

                    // Read metadata
                    let metadataText = null;
                    try {
                        const metadataValue = window._settings.get_value(metadataKey);
                        let metadata = null;
                        try { metadata = metadataValue.recursiveUnpack(); } catch (e) {}

                        if (metadata && metadata[path]) {
                            const meta = metadata[path];
                            let width = extractValue(meta.width);
                            let height = extractValue(meta.height);
                            let fps = extractValue(meta.fps);
                            let duration = extractValue(meta.duration);
                            let playCount = extractValue(meta.playCount);

                            const line1Parts = [];
                            const line2Parts = [];
                            const fileExtension = path.split('.').pop()?.toUpperCase() || '';

                            if (width && height) {
                                const typePrefix = fileExtension ? `${fileExtension} - ` : '';
                                line1Parts.push(`${typePrefix}Resolution - ${width}x${height}`);
                            }
                            if (fps) line1Parts.push(`FPS - ${fps}`);
                            if (duration !== null && duration !== undefined && duration > 0) {
                                const minutes = Math.floor(duration / 60);
                                const seconds = duration % 60;
                                line2Parts.push(`Duration - ${minutes}:${seconds.toString().padStart(2, '0')}`);
                            }
                            if (playCount !== null && playCount !== undefined) {
                                line2Parts.push(`Plays - ${playCount}`);
                            }

                            let fileNotFound = false;
                            try {
                                if (!Gio.File.new_for_path(path).query_exists(null)) fileNotFound = true;
                            } catch (e) {}

                            metadataText = {
                                line1: line1Parts.join(' • '),
                                line2: line2Parts.join(' • '),
                                fileNotFound: fileNotFound,
                            };
                        }
                    } catch (e) {}

                    infoBox.append(titleLabel);
                    infoBox.append(pathLabel);

                    if (metadataText && typeof metadataText === 'object') {
                        if (metadataText.line1) {
                            const l1 = new Gtk.Label({
                                label: metadataText.line1,
                                halign: Gtk.Align.START, xalign: 0,
                                css_classes: ['dim-label'],
                                wrap: true, wrap_mode: Pango.WrapMode.WORD_CHAR, max_width_chars: 30,
                            });
                            l1.add_css_class('caption');
                            infoBox.append(l1);
                        }
                        if (metadataText.line2) {
                            const l2text = metadataText.line2 + (metadataText.fileNotFound ? '  ⚠️ File not found' : '');
                            const l2 = new Gtk.Label({
                                label: l2text,
                                halign: Gtk.Align.START, xalign: 0,
                                css_classes: ['dim-label'],
                                wrap: true, wrap_mode: Pango.WrapMode.WORD_CHAR, max_width_chars: 30,
                            });
                            l2.add_css_class('caption');
                            infoBox.append(l2);
                        }
                    } else {
                        const dl = new Gtk.Label({
                            label: 'Detecting metadata...', halign: Gtk.Align.START, xalign: 0, css_classes: ['dim-label'],
                        });
                        dl.add_css_class('caption');
                        infoBox.append(dl);
                    }

                    // Buttons
                    const buttonBox = new Gtk.Box({
                        orientation: Gtk.Orientation.HORIZONTAL,
                        spacing: 4, halign: Gtk.Align.END, valign: Gtk.Align.CENTER,
                    });
                    const upButton = new Gtk.Button({ icon_name: 'go-up-symbolic', tooltip_text: 'Move up', sensitive: index > 0 });
                    upButton.connect('clicked', () => {
                        const p = getPaths();
                        if (index > 0) {
                            [p[index - 1], p[index]] = [p[index], p[index - 1]];
                            setPaths(p);
                            updateList();
                        }
                    });
                    const downButton = new Gtk.Button({ icon_name: 'go-down-symbolic', tooltip_text: 'Move down', sensitive: index < currentPaths.length - 1 });
                    downButton.connect('clicked', () => {
                        const p = getPaths();
                        if (index < p.length - 1) {
                            [p[index], p[index + 1]] = [p[index + 1], p[index]];
                            setPaths(p);
                            updateList();
                        }
                    });
                    const removeButton = new Gtk.Button({ icon_name: 'edit-delete-symbolic', tooltip_text: 'Remove', css_classes: ['destructive-action'] });
                    removeButton.connect('clicked', () => {
                        const p = getPaths();
                        p.splice(index, 1);
                        setPaths(p);
                        updateList();
                    });

                    buttonBox.append(upButton);
                    buttonBox.append(downButton);
                    buttonBox.append(removeButton);

                    rowBox.set_hexpand(false);
                    rowBox.set_halign(Gtk.Align.FILL);
                    rowBox.append(infoBox);
                    rowBox.append(buttonBox);
                    row.set_child(rowBox);
                    row._videoPath = path;
                    listBox.append(row);
                });
                scrolledWindow.height_request = currentPaths.length * 120;
            }

            expanderRow.set_subtitle(`${currentPaths.length} video${currentPaths.length !== 1 ? 's' : ''} selected`);
        };

        updateList();

        // Add files row
        const addFilesRow = new Adw.ActionRow({ title: 'Add Videos', subtitle: 'Select multiple video files' });
        const addFilesButton = new Adw.ButtonContent({ icon_name: 'document-open-symbolic', label: 'Select Files' });
        addFilesRow.activatable_widget = addFilesButton;
        addFilesRow.add_suffix(addFilesButton);
        addFilesRow.connect('activated', () => {
            this._openGenericFileDialog(window, getPaths, setPaths, metadataKey, updateList);
        });

        // Add folder row
        const addFolderRow = new Adw.ActionRow({ title: 'Add Folder', subtitle: 'Select a folder containing videos' });
        const addFolderButton = new Adw.ButtonContent({ icon_name: 'folder-open-symbolic', label: 'Select Folder' });
        addFolderRow.activatable_widget = addFolderButton;
        addFolderRow.add_suffix(addFolderButton);
        addFolderRow.connect('activated', () => {
            this._openGenericFolderDialog(window, getPaths, setPaths, metadataKey, updateList);
        });

        // Refresh thumbnails row
        const refreshRow = new Adw.ActionRow({ title: 'Refresh Thumbnails', subtitle: 'Clear cached thumbnails and regenerate' });
        const refreshButton = new Adw.ButtonContent({ icon_name: 'view-refresh-symbolic', label: 'Refresh' });
        refreshRow.activatable_widget = refreshButton;
        refreshRow.add_suffix(refreshButton);
        refreshRow.connect('activated', () => {
            const cacheDir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'live-lockpaper', 'thumbnails']);
            try {
                const dir = Gio.File.new_for_path(cacheDir);
                if (dir.query_exists(null)) {
                    const enumerator = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
                    let fileInfo;
                    while ((fileInfo = enumerator.next_file(null)) !== null) {
                        try { dir.get_child(fileInfo.get_name()).delete(null); } catch (e) {}
                    }
                    enumerator.close(null);
                }
            } catch (e) {}
            updateList();
        });

        return { expanderRow, updateList, addFilesRow, addFolderRow, refreshRow };
    }

    // Reusable file picker helper.
    _openGenericFileDialog(window, getPaths, setPaths, metadataKey, updateCallback) {
        let filter = new Gtk.FileFilter();
        filter.set_name('Video files');
        filter.add_mime_type('video/*');
        let filters = new Gio.ListStore({ item_type: Gtk.FileFilter });
        filters.append(filter);

        let dialog = new Gtk.FileDialog({ title: 'Select Video Files' });
        dialog.set_filters(filters);
        dialog.set_accept_label('Select');

        const currentPaths = getPaths();
        if (currentPaths.length > 0) {
            try {
                const parent = Gio.File.new_for_path(currentPaths[0]).get_parent();
                if (parent) dialog.set_initial_folder(parent);
            } catch (e) {}
        }

        dialog.open_multiple(window, null, (d, result) => {
            try {
                let files = d.open_multiple_finish(result);
                if (files && files.get_n_items() > 0) {
                    let paths = getPaths();
                    let added = false;
                    for (let i = 0; i < files.get_n_items(); i++) {
                        const newPath = files.get_item(i).get_path();
                        if (newPath && !paths.includes(newPath)) {
                            paths.push(newPath);
                            added = true;
                        }
                    }
                    if (added) {
                        setPaths(paths);
                        this._updateVideoMetadata(paths, window, metadataKey, updateCallback);
                        if (updateCallback) updateCallback();
                    }
                }
            } catch (e) {
                console.log(`Error selecting files: ${e}`);
            }
        });
    }

    // Reusable folder picker helper.
    _openGenericFolderDialog(window, getPaths, setPaths, metadataKey, updateCallback) {
        let dialog = new Gtk.FileDialog({ title: 'Select Folder Containing Videos' });
        dialog.set_accept_label('Select Folder');

        const currentPaths = getPaths();
        if (currentPaths.length > 0) {
            try {
                const parent = Gio.File.new_for_path(currentPaths[0]).get_parent();
                if (parent) dialog.set_initial_folder(parent);
            } catch (e) {}
        }

        dialog.select_folder(window, null, (d, result) => {
            try {
                let folder = d.select_folder_finish(result);
                if (folder) {
                    this._scanGenericFolderForVideos(folder.get_path(), getPaths, setPaths, window, metadataKey, updateCallback);
                }
            } catch (e) {
                console.log(`Error selecting folder: ${e}`);
            }
        });
    }

    // Scan a folder and append supported video files.
    _scanGenericFolderForVideos(folderPath, getPaths, setPaths, window, metadataKey, updateCallback) {
        try {
            const folder = Gio.File.new_for_path(folderPath);
            const enumerator = folder.enumerate_children('standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);
            const videoExtensions = ['.mp4', '.avi', '.mkv', '.mov', '.webm', '.flv', '.wmv', '.m4v', '.3gp', '.ogv'];
            let videoFiles = [];
            let fileInfo;
            while ((fileInfo = enumerator.next_file(null)) !== null) {
                const fileName = fileInfo.get_name();
                if (fileInfo.get_file_type() === Gio.FileType.REGULAR) {
                    if (videoExtensions.some(ext => fileName.toLowerCase().endsWith(ext))) {
                        videoFiles.push(folder.get_child(fileName).get_path());
                    }
                }
            }
            if (videoFiles.length > 0) {
                let paths = getPaths();
                let added = false;
                videoFiles.forEach(newPath => {
                    if (!paths.includes(newPath)) {
                        paths.push(newPath);
                        added = true;
                    }
                });
                if (added) {
                    setPaths(paths);
                    this._updateVideoMetadata(paths, window, metadataKey, updateCallback);
                    if (updateCallback) updateCallback();
                }
            }
        } catch (e) {
            console.log(`Error scanning folder: ${e}`);
        }
    }

    _buildWallpaperControlGroup(window) {
        const group = new Adw.PreferencesGroup({
            title: 'Video Wallpaper',
            description: 'Set a video as your desktop wallpaper — changes apply live',
        });

        // Enable toggle
        const enableSwitch = new Adw.SwitchRow({
            title: 'Enable Video Wallpaper',
            subtitle: 'Replace your desktop wallpaper with a video',
        });
        window._settings.bind(
            Keys.WALLPAPER_ENABLED, enableSwitch,
            'active', Gio.SettingsBindFlags.DEFAULT
        );
        group.add(enableSwitch);

        // Per-monitor toggle
        const perMonitorSwitch = new Adw.SwitchRow({
            title: 'Per-monitor videos',
            subtitle: 'Each monitor gets its own independent set of videos',
        });
        window._settings.bind(
            Keys.WALLPAPER_PER_MONITOR, perMonitorSwitch,
            'active', Gio.SettingsBindFlags.DEFAULT
        );
        group.add(perMonitorSwitch);

        // Loop toggle (with conditional logic like lock screen)
        const loopSwitch = new Adw.SwitchRow({
            title: 'Loop video',
            subtitle: 'Continuously replay videos',
        });
        window._settings.bind(
            Keys.WALLPAPER_LOOPED, loopSwitch,
            'active', Gio.SettingsBindFlags.DEFAULT
        );

        // Random order
        const randomOrderSwitch = new Adw.SwitchRow({
            title: 'Random order',
            subtitle: 'Play videos in random order',
        });
        window._settings.bind(
            Keys.WALLPAPER_RANDOM_ORDER, randomOrderSwitch,
            'active', Gio.SettingsBindFlags.DEFAULT
        );
        let loopAllowedByPlaylist = true;
        const updateLoopSensitivity = () => {
            try {
                const isPerMonitor = window._settings.get_boolean(Keys.WALLPAPER_PER_MONITOR);
                if (isPerMonitor) {
                    // In per-monitor mode, loop sensitivity depends on per-monitor config
                    const config = this._getPerMonitorConfig(window);
                    const hasMultiple = Object.values(config).some(paths => Array.isArray(paths) && paths.length > 1);
                    if (hasMultiple) {
                        loopAllowedByPlaylist = false;
                        loopSwitch.subtitle = 'Not applicable — monitors with multiple videos always cycle through their playlist';
                    } else {
                        loopAllowedByPlaylist = true;
                        loopSwitch.subtitle = 'Continuously replay videos';
                    }
                } else {
                    const paths = window._settings.get_strv(Keys.WALLPAPER_VIDEO_PATHS);
                    const count = paths && Array.isArray(paths) ? paths.length : 0;
                    if (count > 1) {
                        loopAllowedByPlaylist = false;
                        loopSwitch.subtitle = 'Not applicable — multiple videos always cycle through the playlist automatically';
                    } else {
                        loopAllowedByPlaylist = true;
                        loopSwitch.subtitle = 'Continuously replay videos';
                    }
                }
            } catch (e) {
                loopAllowedByPlaylist = true;
            }
            updateSensitivity();
        };
        updateLoopSensitivity();
        window._settings.connect('changed::' + Keys.WALLPAPER_VIDEO_PATHS, updateLoopSensitivity);
        window._settings.connect('changed::' + Keys.WALLPAPER_PER_MONITOR, updateLoopSensitivity);
        window._settings.connect('changed::' + Keys.WALLPAPER_PER_MONITOR_CONFIG, updateLoopSensitivity);
        group.add(randomOrderSwitch);
        group.add(loopSwitch);

        // Sensitivity: disable controls when wallpaper is disabled
        function updateSensitivity() {
            const enabled = enableSwitch.active;
            perMonitorSwitch.set_sensitive(enabled);
            randomOrderSwitch.set_sensitive(enabled);
            loopSwitch.set_sensitive(enabled && loopAllowedByPlaylist);
        }
        updateSensitivity();
        enableSwitch.connect('notify::active', updateSensitivity);

        return group;
    }

    // Wallpaper single-video group (when per-monitor is off).
    _buildWallpaperSingleVideoGroup(window) {
        const group = new Adw.PreferencesGroup({
            title: 'Videos',
            description: 'Videos shared across all monitors',
        });

        // Ensure CSS provider is loaded
        this._ensureThumbnailCss(window);

        const getPaths = () => {
            try {
                const p = window._settings.get_strv(Keys.WALLPAPER_VIDEO_PATHS);
                return (p && Array.isArray(p)) ? p : [];
            } catch (e) { return []; }
        };
        const setPaths = (paths) => {
            window._settings.set_strv(Keys.WALLPAPER_VIDEO_PATHS, paths);
        };

        const widget = this._buildVideoListWidget(window, {
            getPaths, setPaths,
            metadataKey: Keys.WALLPAPER_VIDEO_METADATA,
            title: 'Video List',
        });

        group.add(widget.expanderRow);
        group.add(widget.addFilesRow);
        group.add(widget.addFolderRow);
        group.add(widget.refreshRow);

        // Watch for path changes to refresh list
        window._settings.connect('changed::' + Keys.WALLPAPER_VIDEO_PATHS, () => {
            widget.updateList();
        });

        // Trigger metadata detection
        const paths = getPaths();
        if (paths.length > 0) {
            this._updateVideoMetadata(paths, window, Keys.WALLPAPER_VIDEO_METADATA, widget.updateList);
        }

        return group;
    }

    // Wallpaper per-monitor group (when per-monitor is on).
    _buildWallpaperPerMonitorGroup(window) {
        const group = new Adw.PreferencesGroup({
            title: 'Per-Monitor Videos',
            description: 'Each monitor has its own independent set of videos',
        });

        // Ensure CSS provider is loaded
        this._ensureThumbnailCss(window);

        const monitors = this._getDetectedMonitors();

        monitors.forEach((mon) => {
            const connector = mon.connector;
            const displayName = mon.manufacturer && mon.model
                ? `${mon.connector} — ${mon.manufacturer} ${mon.model} (${mon.width}×${mon.height})`
                : `${mon.connector} (${mon.width}×${mon.height})`;

            const getPaths = () => {
                const config = this._getPerMonitorConfig(window);
                return (config[connector] && Array.isArray(config[connector])) ? config[connector] : [];
            };
            const setPaths = (paths) => {
                const config = this._getPerMonitorConfig(window);
                config[connector] = paths;
                this._setPerMonitorConfig(window, config);
            };

            const widget = this._buildVideoListWidget(window, {
                getPaths, setPaths,
                metadataKey: Keys.WALLPAPER_VIDEO_METADATA,
                title: displayName,
            });

            group.add(widget.expanderRow);
            group.add(widget.addFilesRow);
            group.add(widget.addFolderRow);
            group.add(widget.refreshRow);

            // Watch for config changes to refresh this monitor's list
            window._settings.connect('changed::' + Keys.WALLPAPER_PER_MONITOR_CONFIG, () => {
                widget.updateList();
            });

            // Trigger metadata detection for this monitor's videos
            const paths = getPaths();
            if (paths.length > 0) {
                this._updateVideoMetadata(paths, window, Keys.WALLPAPER_VIDEO_METADATA, widget.updateList);
            }
        });

        // If no monitors detected at all, show a message
        if (monitors.length === 1 && monitors[0].connector === 'Unknown') {
            const infoRow = new Adw.ActionRow({
                title: 'No monitors detected',
                subtitle: 'Monitor detection may require a running Wayland/X11 session',
                icon_name: 'dialog-warning-symbolic',
            });
            group.add(infoRow);
        }

        return group;
    }

    // Load thumbnail CSS provider once.
    _ensureThumbnailCss(window) {
        if (!window._thumbnailCssProvider) {
            const cssProvider = new Gtk.CssProvider();
            const css = `
                .thumbnail-frame {
                    border-radius: 6px;
                    min-width: 100px;
                    min-height: 56px;
                    background-color: alpha(@window_fg_color, 0.08);
                }
                .thumbnail-frame > picture {
                    border-radius: 6px;
                }
            `;
            cssProvider.load_from_data(css, css.length);
            const display = Gdk.Display.get_default();
            if (display) {
                Gtk.StyleContext.add_provider_for_display(display, cssProvider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
            }
            window._thumbnailCssProvider = cssProvider;
        }
    }

    _buildWallpaperAppearanceGroup(window) {
        const group = new Adw.PreferencesGroup({
            title: 'Appearance',
        });

        // Render quality
        const qualityRow = new Adw.SpinRow({
            title: 'Render quality',
            subtitle: 'Percentage of monitor resolution (lower = better performance, higher = sharper)',
            adjustment: new Gtk.Adjustment({
                lower: 25, upper: 100, step_increment: 5,
                value: window._settings.get_int(Keys.WALLPAPER_QUALITY),
            }),
        });
        qualityRow.add_suffix(new Gtk.Label({ label: '%', valign: Gtk.Align.CENTER, css_classes: ['dim-label'] }));
        qualityRow.connect('notify::value', row => {
            window._settings.set_int(Keys.WALLPAPER_QUALITY, row.get_value());
        });
        group.add(qualityRow);

        // Scaling mode
        const scalingRow = new Adw.ComboRow({
            title: 'Scaling mode',
            subtitle: 'How the video is scaled to fit the screen',
            model: new Gtk.StringList({
                strings: ['Stretch', 'Fit', 'Cover']
            }),
        });
        scalingRow.set_selected(window._settings.get_int(Keys.WALLPAPER_SCALING_MODE));
        scalingRow.connect('notify::selected', row => {
            window._settings.set_int(Keys.WALLPAPER_SCALING_MODE, row.selected);
        });
        group.add(scalingRow);

        // Volume
        const volumeRow = new Adw.SpinRow({
            title: 'Volume',
            subtitle: 'Audio volume (0 = muted)',
            adjustment: new Gtk.Adjustment({
                lower: 0, upper: 100, step_increment: 1,
                value: window._settings.get_int(Keys.WALLPAPER_VOLUME),
            }),
        });
        volumeRow.add_suffix(new Gtk.Label({ label: '%', valign: Gtk.Align.CENTER, css_classes: ['dim-label'] }));
        volumeRow.connect('notify::value', row => {
            window._settings.set_int(Keys.WALLPAPER_VOLUME, row.get_value());
        });
        group.add(volumeRow);

        // Auto FPS
        const autoFpsSwitch = new Adw.SwitchRow({
            title: 'Auto-detect FPS',
            subtitle: "Use each video's native framerate",
        });
        window._settings.bind(
            Keys.WALLPAPER_AUTO_FPS, autoFpsSwitch,
            'active', Gio.SettingsBindFlags.DEFAULT
        );
        group.add(autoFpsSwitch);

        // Manual FPS
        const fpsRow = new Adw.SpinRow({
            title: 'Framerate',
            subtitle: 'Manual framerate (used when auto-detect is off)',
        });
        fpsRow.set_adjustment(new Gtk.Adjustment({
            lower: 1, upper: 120, step_increment: 1,
            value: window._settings.get_int(Keys.WALLPAPER_FRAMERATE),
        }));
        fpsRow.add_suffix(new Gtk.Label({ label: 'fps', valign: Gtk.Align.CENTER, css_classes: ['dim-label'] }));
        fpsRow.connect('notify::value', row => {
            window._settings.set_int(Keys.WALLPAPER_FRAMERATE, row.get_value());
        });
        const toggleFps = () => fpsRow.set_sensitive(!autoFpsSwitch.active);
        toggleFps();
        autoFpsSwitch.connect('notify::active', toggleFps);
        group.add(fpsRow);

        // Fade in
        const fadeRow = new Adw.SpinRow({
            title: 'Fade in',
            subtitle: 'Video fade-in animation duration',
            adjustment: new Gtk.Adjustment({
                lower: 0, upper: 600000, step_increment: 100,
                value: window._settings.get_int(Keys.WALLPAPER_FADE_IN_DURATION),
            }),
        });
        fadeRow.add_suffix(new Gtk.Label({ label: 'ms', valign: Gtk.Align.CENTER, css_classes: ['dim-label'] }));
        fadeRow.connect('notify::value', row => {
            window._settings.set_int(Keys.WALLPAPER_FADE_IN_DURATION, row.get_value());
        });
        group.add(fadeRow);

        // Blur radius
        const blurRow = new Adw.SpinRow({
            title: 'Blur radius',
            adjustment: new Gtk.Adjustment({
                lower: 0, upper: 100, step_increment: 1,
                value: window._settings.get_int(Keys.WALLPAPER_BLUR_RADIUS),
            }),
        });
        blurRow.add_suffix(new Gtk.Label({ label: 'px', valign: Gtk.Align.CENTER, css_classes: ['dim-label'] }));
        group.add(blurRow);

        // Blur brightness
        const blurBrightnessRow = new Adw.SpinRow({
            title: 'Blur brightness',
            adjustment: new Gtk.Adjustment({
                lower: 0, upper: 100, step_increment: 1,
                value: window._settings.get_double(Keys.WALLPAPER_BLUR_BRIGHTNESS) * 100,
            }),
        });
        blurBrightnessRow.add_suffix(new Gtk.Label({ label: '%', valign: Gtk.Align.CENTER, css_classes: ['dim-label'] }));
        group.add(blurBrightnessRow);

        const toggleBrightness = () => {
            blurBrightnessRow.set_sensitive(blurRow.get_value() !== 0);
        };
        toggleBrightness();

        blurRow.connect('notify::value', row => {
            window._settings.set_int(Keys.WALLPAPER_BLUR_RADIUS, row.get_value());
            toggleBrightness();
        });
        blurBrightnessRow.connect('notify::value', row => {
            window._settings.set_double(Keys.WALLPAPER_BLUR_BRIGHTNESS, row.get_value() / 100);
        });

        // Sensitivity: disable appearance controls when wallpaper is disabled
        const wpEnabled = window._settings.get_boolean(Keys.WALLPAPER_ENABLED);
        const setGroupSensitivity = (enabled) => {
            qualityRow.set_sensitive(enabled);
            scalingRow.set_sensitive(enabled);
            volumeRow.set_sensitive(enabled);
            autoFpsSwitch.set_sensitive(enabled);
            fpsRow.set_sensitive(enabled && !autoFpsSwitch.active);
            fadeRow.set_sensitive(enabled);
            blurRow.set_sensitive(enabled);
            blurBrightnessRow.set_sensitive(enabled && blurRow.get_value() !== 0);
        };
        setGroupSensitivity(wpEnabled);
        window._settings.connect('changed::' + Keys.WALLPAPER_ENABLED, () => {
            setGroupSensitivity(window._settings.get_boolean(Keys.WALLPAPER_ENABLED));
        });

        return group;
    }
}
