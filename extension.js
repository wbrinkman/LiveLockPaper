import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as LoginManager from 'resource:///org/gnome/shell/misc/loginManager.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

import St from 'gi://St';
import Gst from 'gi://Gst';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GstPbutils from 'gi://GstPbutils';
import Meta from 'gi://Meta';

import Pipeline from './core/pipeline.js';
import { PlayerProcess } from './core/player_process.js';

import { Keys } from "./enums.js";
import { setImageData } from './utils/set_image_data.js';
import { isGtk4PaintableSinkAvailable } from './utils/check_dependencies.js';
import { sendErrorNotification } from './utils/notifications.js';

import { createActor } from './core/scalers.js';

export default class LockscreenExtension extends Extension {
    enable() {
        const mode = Main.sessionMode.currentMode;
        console.log(`[LiveLockPaper] enable() called, sessionMode=${mode}`);

        // Cancel any pending teardown from a previous disable()
        if (this._deferredTeardownId) {
            GLib.Source.remove(this._deferredTeardownId);
            this._deferredTeardownId = null;
        }

        // Cancel any pending init from a previous enable() (debounce)
        if (this._deferredInitId) {
            GLib.Source.remove(this._deferredInitId);
            this._deferredInitId = null;
        }

        // Cancel any pending idle activation from a previous init
        if (this._deferredActivateId) {
            GLib.Source.remove(this._deferredActivateId);
            this._deferredActivateId = null;
        }

        // Cancel any pending startup-complete listener
        if (this._startupCompleteId) {
            Main.layoutManager.disconnect(this._startupCompleteId);
            this._startupCompleteId = null;
        }

        this._active = true;

        const gstReady = Gst.is_initialized();

        if (!gstReady && Main.layoutManager._startingUp) {
            // On fresh boot, wait for startup-complete before heavy init.
            console.log('[LiveLockPaper] Session starting up, waiting for startup-complete signal…');

            this._startupCompleteId = Main.layoutManager.connect('startup-complete', () => {
                Main.layoutManager.disconnect(this._startupCompleteId);
                this._startupCompleteId = null;
                if (!this._active) return;

                console.log('[LiveLockPaper] startup-complete received, scheduling init in 500ms');
                // Small buffer after startup-complete for VA-API/PipeWire to settle
                this._deferredInitId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                    this._deferredInitId = null;
                    if (!this._active) return GLib.SOURCE_REMOVE;
                    this._deferredInit();
                    return GLib.SOURCE_REMOVE;
                });
            });
        } else {
            // Normal path for lock/unlock or mid-session toggles.
            const delay = gstReady ? 250 : 500;

            this._deferredInitId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                this._deferredInitId = null;
                if (!this._active) return GLib.SOURCE_REMOVE;
                this._deferredInit();
                return GLib.SOURCE_REMOVE;
            });

            console.log(`[LiveLockPaper] Init scheduled in ${delay}ms (gstReady=${gstReady})`);
        }
    }

    disable() {
        const mode = Main.sessionMode.currentMode;
        console.log(`[LiveLockPaper] disable() called, sessionMode=${mode}`);

        this._active = false;

        // Cancel pending deferred init (the main debounce mechanism)
        if (this._deferredInitId) {
            GLib.Source.remove(this._deferredInitId);
            this._deferredInitId = null;
        }

        // Cancel pending idle activation
        if (this._deferredActivateId) {
            GLib.Source.remove(this._deferredActivateId);
            this._deferredActivateId = null;
        }

        // Cancel pending startup-complete listener
        if (this._startupCompleteId) {
            Main.layoutManager.disconnect(this._startupCompleteId);
            this._startupCompleteId = null;
        }

        // Cancel pending deferred teardown from a PREVIOUS disable
        if (this._deferredTeardownId) {
            GLib.Source.remove(this._deferredTeardownId);
            this._deferredTeardownId = null;
        }

        // Defer actual teardown — if enable() is called within 350ms (i.e.
        // this was just a mode-transition cycle), the teardown is cancelled.
        this._deferredTeardownId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => {
            this._deferredTeardownId = null;
            if (this._active) return GLib.SOURCE_REMOVE; // re-enabled, skip
            console.log('[LiveLockPaper] Deferred teardown running (extension truly disabled)');
            this._fullTeardown();
            return GLib.SOURCE_REMOVE;
        });
    }

    // One-time init + mode activation.
    _deferredInit() {
        try {
            // Cancel any pending activation from a previous init
            if (this._deferredActivateId) {
                GLib.Source.remove(this._deferredActivateId);
                this._deferredActivateId = null;
            }

            if (!Gst.is_initialized()) {
                console.log('[LiveLockPaper] Initializing GStreamer…');
                if (!Gst.init_check([])[0]) {
                    console.error('[LiveLockPaper] Failed to initialize GStreamer');
                    return;
                }
                console.log('[LiveLockPaper] GStreamer initialized ✓');
            }

            if (!this._settings) {
                this._settings = this.getSettings();
            }
            if (!this._panelVisibilityChangedId) {
                this._panelVisibilityChangedId = this._settings.connect(
                    `changed::${Keys.DEBUG_SHOW_PANEL_BUTTON}`,
                    () => {
                        this._ensureStatusIndicator();
                        this._syncStatusIndicator();
                    }
                );
            }
            if (!this._lockRuntimeSettingIds) {
                this._lockRuntimeSettingIds = [];
                this._lockRuntimeSettingIds.push(
                    this._settings.connect(`changed::${Keys.LOCKSCREEN_ENABLED}`, () => {
                        this._onLockRuntimeSettingChanged();
                    })
                );
                this._lockRuntimeSettingIds.push(
                    this._settings.connect(`changed::${Keys.DEBUG_USE_GTK4_SINK}`, () => {
                        this._onLockRuntimeSettingChanged();
                    })
                );
            }
            this._ensureStatusIndicator();

            // Check gtk4paintablesink availability (one-time)
            if (this._gtk4SinkAvailable === undefined) {
                this._gtk4SinkAvailable = isGtk4PaintableSinkAvailable();
                console.log(`[LiveLockPaper] gtk4paintablesink available: ${this._gtk4SinkAvailable}`);
            }

            // Connect session-mode handler ONCE (idempotent)
            if (!this._sessionModeChangedId) {
                this._sessionModeChangedId = Main.sessionMode.connect('updated', () => {
                    this._onSessionModeChanged();
                });
            }

            // Defer activation to idle so compositor work settles first.
            const mode = Main.sessionMode.currentMode;
            console.log(`[LiveLockPaper] Deferred init complete, scheduling activation for: ${mode}`);

            this._deferredActivateId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._deferredActivateId = null;
                if (!this._active) return GLib.SOURCE_REMOVE;
                const currentMode = Main.sessionMode.currentMode;
                console.log(`[LiveLockPaper] Idle activation firing for: ${currentMode}`);
                try {
                    this._activateForMode(currentMode);
                } catch (e) {
                    console.error(`[LiveLockPaper] Activation failed: ${e.message}\n${e.stack}`);
                }
                return GLib.SOURCE_REMOVE;
            });
        } catch (e) {
            console.error(`[LiveLockPaper] _deferredInit failed: ${e.message}\n${e.stack}`);
        }
    }

    // Full teardown when extension is truly disabled.
    _fullTeardown() {
        try {
            if (this._sessionModeChangedId) {
                Main.sessionMode.disconnect(this._sessionModeChangedId);
                this._sessionModeChangedId = null;
            }
            if (this._startupCompleteId) {
                Main.layoutManager.disconnect(this._startupCompleteId);
                this._startupCompleteId = null;
            }
            if (this._deferredInitId) {
                GLib.Source.remove(this._deferredInitId);
                this._deferredInitId = null;
            }
            if (this._deferredActivateId) {
                GLib.Source.remove(this._deferredActivateId);
                this._deferredActivateId = null;
            }
            if (this._deferredTeardownId) {
                GLib.Source.remove(this._deferredTeardownId);
                this._deferredTeardownId = null;
            }
            this._disableLockScreen();
            this._disableWallpaper();
            this._cleanupPauseWhenHidden();
            this._destroyStatusIndicator();
            if (this._panelVisibilityChangedId && this._settings) {
                try { this._settings.disconnect(this._panelVisibilityChangedId); } catch (_) {}
                this._panelVisibilityChangedId = null;
            }
            if (this._lockRuntimeSettingIds && this._settings) {
                for (const id of this._lockRuntimeSettingIds) {
                    try { this._settings.disconnect(id); } catch (_) {}
                }
                this._lockRuntimeSettingIds = [];
            }
            this._currentActivatedMode = null;
            this._settings = null;
        } catch (e) {
            console.error(`[LiveLockPaper] _fullTeardown failed: ${e.message}\n${e.stack}`);
        }
    }

    // Handle session-mode transitions (user <-> unlock-dialog).
    _onSessionModeChanged() {
        const mode = Main.sessionMode.currentMode;
        if (mode === this._currentActivatedMode) return; // no real change

        // If deferred init is pending, let it handle activation.
        if (this._deferredInitId) {
            console.log(`[LiveLockPaper] Session mode → ${mode} (deferred init pending, will handle)`);
            return;
        }

        // Cancel pending deferred activation and handle the new mode now.
        if (this._deferredActivateId) {
            GLib.Source.remove(this._deferredActivateId);
            this._deferredActivateId = null;
        }

        console.log(`[LiveLockPaper] Session mode changed → ${mode}`);
        try {
            this._activateForMode(mode);
        } catch (e) {
            console.error(`[LiveLockPaper] _onSessionModeChanged crashed: ${e.message}\n${e.stack}`);
        }
    }

    // Activate features for the current session mode.
    _activateForMode(mode) {
        if (mode === this._currentActivatedMode) {
            console.log(`[LiveLockPaper] Already active for ${mode}, skipping`);
            return;
        }

        if (mode === 'unlock-dialog') {
            // Lock screen: pause wallpaper and set up lock video.
            const lockscreenEnabled = this._settings?.get_boolean(Keys.LOCKSCREEN_ENABLED) ?? true;
            console.log(`[LiveLockPaper] → pausing wallpaper, lock screen video ${lockscreenEnabled ? 'enabled' : 'disabled'}`);
            this._currentActivatedMode = mode;
            this._pauseWallpaper();
            if (lockscreenEnabled)
                this._enableLockScreen();
            else
                this._disableLockScreen();
        } else if (mode === 'user') {
            // Desktop — tear down lock screen, resume wallpaper
            console.log('[LiveLockPaper] → tearing down lock screen, resuming wallpaper');
            this._currentActivatedMode = mode;
            this._disableLockScreen();
            this._resumeWallpaper();
        }
        this._syncStatusIndicator();
    }

    // Return true when GTK4 subprocess renderer should be used.
    _shouldUseGtk4Sink() {
        if (!this._settings) return false;
        const forceAppsink = this._settings.get_boolean(Keys.DEBUG_USE_GTK4_SINK);
        if (forceAppsink)
            return false;

        if (!this._gtk4SinkAvailable) {
            console.warn('[LiveLockPaper] gtk4paintablesink not available, falling back to appsink');
            if (!this._gtk4MissingNotified) {
                this._gtk4MissingNotified = true;
                sendErrorNotification(
                    'gtk4paintablesink is not installed.\n' +
                    'Install gstreamer-plugin-gtk4 (or gstreamer1.0-gtk4 on Debian/Ubuntu) ' +
                    'to use the default high-performance renderer.'
                );
            }
            return false;
        }
        return true;
    }

    _onLockRuntimeSettingChanged() {
        this._syncStatusIndicator();
        if (Main.sessionMode.currentMode !== 'unlock-dialog')
            return;
        this._disableLockScreen();
        if (this._settings?.get_boolean(Keys.LOCKSCREEN_ENABLED))
            this._enableLockScreen();
    }

    _hasBatteryDevice() {
        if (this._batteryPresent !== undefined)
            return this._batteryPresent;
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
            this._batteryPresent = isPresent && type === 2; // 2 = Battery
        } catch (e) {
            this._batteryPresent = false;
        }
        return this._batteryPresent;
    }

    _ensureStatusIndicator() {
        if (!this._settings)
            return;
        const shouldShow = this._settings.get_boolean(Keys.DEBUG_SHOW_PANEL_BUTTON);
        if (!shouldShow) {
            this._destroyStatusIndicator();
            return;
        }
        if (this._panelButton)
            return;

        this._panelSignals = [];
        this._manualWallpaperPaused = false;

        this._panelButton = new PanelMenu.Button(0.0, 'LiveLockPaper');
        const panelGicon = Gio.icon_new_for_string(`${this.path}/icon.png`);
        const icon = new St.Icon({
            gicon: panelGicon,
            fallback_icon_name: 'image-x-generic-symbolic',
            style_class: 'system-status-icon',
        });
        this._panelButton.add_child(icon);

        this._menuPlayPauseItem = new PopupMenu.PopupMenuItem('Pause Wallpaper');
        this._menuPlayPauseId = this._menuPlayPauseItem.connect('activate', () => {
            this._toggleWallpaperPlaybackFromMenu();
        });
        this._panelButton.menu.addMenuItem(this._menuPlayPauseItem);

        this._menuNextItem = new PopupMenu.PopupMenuItem('Next Video');
        this._menuNextId = this._menuNextItem.connect('activate', () => {
            this._advanceWallpaperFromMenu();
        });
        this._panelButton.menu.addMenuItem(this._menuNextItem);

        this._menuWallpaperEnabledSwitch = new PopupMenu.PopupSwitchMenuItem(
            'Wallpaper enabled',
            this._settings.get_boolean(Keys.WALLPAPER_ENABLED)
        );
        this._menuWallpaperEnabledId = this._menuWallpaperEnabledSwitch.connect('toggled', (_item, state) => {
            this._settings.set_boolean(Keys.WALLPAPER_ENABLED, state);
        });
        this._panelButton.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._panelButton.menu.addMenuItem(this._menuWallpaperEnabledSwitch);

        this._menuLockscreenEnabledSwitch = new PopupMenu.PopupSwitchMenuItem(
            'Lock screen video',
            this._settings.get_boolean(Keys.LOCKSCREEN_ENABLED)
        );
        this._menuLockscreenEnabledId = this._menuLockscreenEnabledSwitch.connect('toggled', (_item, state) => {
            this._settings.set_boolean(Keys.LOCKSCREEN_ENABLED, state);
        });
        this._panelButton.menu.addMenuItem(this._menuLockscreenEnabledSwitch);

        this._menuPauseWhenHiddenSwitch = new PopupMenu.PopupSwitchMenuItem(
            'Pause when hidden',
            this._settings.get_boolean(Keys.DEBUG_PAUSE_WHEN_HIDDEN)
        );
        this._menuPauseWhenHiddenId = this._menuPauseWhenHiddenSwitch.connect('toggled', (_item, state) => {
            this._settings.set_boolean(Keys.DEBUG_PAUSE_WHEN_HIDDEN, state);
        });
        

        this._menuRandomOrderSwitch = new PopupMenu.PopupSwitchMenuItem(
            'Random order',
            this._settings.get_boolean(Keys.WALLPAPER_RANDOM_ORDER)
        );
        this._menuRandomOrderId = this._menuRandomOrderSwitch.connect('toggled', (_item, state) => {
            this._settings.set_boolean(Keys.WALLPAPER_RANDOM_ORDER, state);
        });
        

        this._menuPerMonitorSwitch = new PopupMenu.PopupSwitchMenuItem(
            'Per-monitor videos',
            this._settings.get_boolean(Keys.WALLPAPER_PER_MONITOR)
        );
        this._menuPerMonitorId = this._menuPerMonitorSwitch.connect('toggled', (_item, state) => {
            this._settings.set_boolean(Keys.WALLPAPER_PER_MONITOR, state);
        });
        

        this._menuWallpaperBlurSwitch = new PopupMenu.PopupSwitchMenuItem(
            'Wallpaper blur',
            (this._settings.get_int(Keys.WALLPAPER_BLUR_RADIUS) ?? 0) > 0
        );
        this._menuWallpaperBlurId = this._menuWallpaperBlurSwitch.connect('toggled', (_item, state) => {
            const current = this._settings.get_int(Keys.WALLPAPER_BLUR_RADIUS);
            if (!state) {
                if (current > 0)
                    this._panelBlurRestoreRadius = current;
                this._settings.set_int(Keys.WALLPAPER_BLUR_RADIUS, 0);
                return;
            }
            const restore = this._panelBlurRestoreRadius && this._panelBlurRestoreRadius > 0
                ? this._panelBlurRestoreRadius
                : 20;
            this._settings.set_int(Keys.WALLPAPER_BLUR_RADIUS, restore);
        });
        

        this._menuMuteSwitch = new PopupMenu.PopupSwitchMenuItem(
            'Mute wallpaper audio',
            this._settings.get_int(Keys.WALLPAPER_VOLUME) === 0
        );
        this._menuMuteId = this._menuMuteSwitch.connect('toggled', (_item, state) => {
            const current = this._settings.get_int(Keys.WALLPAPER_VOLUME);
            if (state) {
                if (current > 0)
                    this._panelMuteRestoreVolume = current;
                this._settings.set_int(Keys.WALLPAPER_VOLUME, 0);
                return;
            }
            const restore = this._panelMuteRestoreVolume && this._panelMuteRestoreVolume > 0
                ? this._panelMuteRestoreVolume
                : 15;
            this._settings.set_int(Keys.WALLPAPER_VOLUME, restore);
        });
        

        this._menuGtkRendererSwitch = new PopupMenu.PopupSwitchMenuItem(
            'Use GTK4 renderer',
            !this._settings.get_boolean(Keys.DEBUG_USE_GTK4_SINK)
        );
        this._menuGtkRendererId = this._menuGtkRendererSwitch.connect('toggled', (_item, state) => {
            // Schema key is inverted: true means force legacy appsink.
            this._settings.set_boolean(Keys.DEBUG_USE_GTK4_SINK, !state);
        });
        

        if (this._hasBatteryDevice()) {
            this._menuDisableOnBatterySwitch = new PopupMenu.PopupSwitchMenuItem(
                'Disable on battery',
                this._settings.get_boolean(Keys.DISABLE_ON_BATTERY)
            );
            this._menuDisableOnBatteryId = this._menuDisableOnBatterySwitch.connect('toggled', (_item, state) => {
                this._settings.set_boolean(Keys.DISABLE_ON_BATTERY, state);
            });
            
        }

        this._menuRestartItem = new PopupMenu.PopupMenuItem('Restart Wallpaper');
        this._menuRestartId = this._menuRestartItem.connect('activate', () => {
            this._restartWallpaperFromMenu();
        });

        // Quick toggles ordered by frequency/importance.
        this._panelButton.menu.addMenuItem(this._menuRandomOrderSwitch);
        this._panelButton.menu.addMenuItem(this._menuPerMonitorSwitch);
        this._panelButton.menu.addMenuItem(this._menuPauseWhenHiddenSwitch);
        this._panelButton.menu.addMenuItem(this._menuMuteSwitch);
        this._panelButton.menu.addMenuItem(this._menuWallpaperBlurSwitch);
        if (this._menuDisableOnBatterySwitch)
            this._panelButton.menu.addMenuItem(this._menuDisableOnBatterySwitch);
        this._panelButton.menu.addMenuItem(this._menuGtkRendererSwitch);
        this._panelButton.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._panelButton.menu.addMenuItem(this._menuRestartItem);

        this._menuSettingsItem = new PopupMenu.PopupMenuItem('Open Settings');
        this._menuSettingsId = this._menuSettingsItem.connect('activate', () => {
            this.openPreferences();
        });
        this._panelButton.menu.addMenuItem(this._menuSettingsItem);

        Main.panel.addToStatusArea('live-lockpaper-indicator', this._panelButton, 1, 'right');

        this._panelSignals.push(
            this._settings.connect(`changed::${Keys.WALLPAPER_ENABLED}`, () => this._syncStatusIndicator())
        );
        this._panelSignals.push(
            this._settings.connect(`changed::${Keys.DEBUG_PAUSE_WHEN_HIDDEN}`, () => this._syncStatusIndicator())
        );
        this._panelSignals.push(
            this._settings.connect(`changed::${Keys.WALLPAPER_BLUR_RADIUS}`, () => this._syncStatusIndicator())
        );
        this._panelSignals.push(
            this._settings.connect(`changed::${Keys.LOCKSCREEN_ENABLED}`, () => this._syncStatusIndicator())
        );
        this._panelSignals.push(
            this._settings.connect(`changed::${Keys.WALLPAPER_RANDOM_ORDER}`, () => this._syncStatusIndicator())
        );
        this._panelSignals.push(
            this._settings.connect(`changed::${Keys.WALLPAPER_PER_MONITOR}`, () => this._syncStatusIndicator())
        );
        this._panelSignals.push(
            this._settings.connect(`changed::${Keys.WALLPAPER_VOLUME}`, () => this._syncStatusIndicator())
        );
        this._panelSignals.push(
            this._settings.connect(`changed::${Keys.DEBUG_USE_GTK4_SINK}`, () => this._syncStatusIndicator())
        );
        this._panelSignals.push(
            this._settings.connect(`changed::${Keys.DISABLE_ON_BATTERY}`, () => this._syncStatusIndicator())
        );

        this._syncStatusIndicator();
    }

    _destroyStatusIndicator() {
        if (this._panelSignals && this._settings) {
            for (const id of this._panelSignals) {
                try { this._settings.disconnect(id); } catch (_) {}
            }
        }
        this._panelSignals = [];

        if (this._menuPlayPauseItem && this._menuPlayPauseId) {
            try { this._menuPlayPauseItem.disconnect(this._menuPlayPauseId); } catch (_) {}
        }
        if (this._menuNextItem && this._menuNextId) {
            try { this._menuNextItem.disconnect(this._menuNextId); } catch (_) {}
        }
        if (this._menuWallpaperEnabledSwitch && this._menuWallpaperEnabledId) {
            try { this._menuWallpaperEnabledSwitch.disconnect(this._menuWallpaperEnabledId); } catch (_) {}
        }
        if (this._menuLockscreenEnabledSwitch && this._menuLockscreenEnabledId) {
            try { this._menuLockscreenEnabledSwitch.disconnect(this._menuLockscreenEnabledId); } catch (_) {}
        }
        if (this._menuPauseWhenHiddenSwitch && this._menuPauseWhenHiddenId) {
            try { this._menuPauseWhenHiddenSwitch.disconnect(this._menuPauseWhenHiddenId); } catch (_) {}
        }
        if (this._menuRandomOrderSwitch && this._menuRandomOrderId) {
            try { this._menuRandomOrderSwitch.disconnect(this._menuRandomOrderId); } catch (_) {}
        }
        if (this._menuPerMonitorSwitch && this._menuPerMonitorId) {
            try { this._menuPerMonitorSwitch.disconnect(this._menuPerMonitorId); } catch (_) {}
        }
        if (this._menuWallpaperBlurSwitch && this._menuWallpaperBlurId) {
            try { this._menuWallpaperBlurSwitch.disconnect(this._menuWallpaperBlurId); } catch (_) {}
        }
        if (this._menuMuteSwitch && this._menuMuteId) {
            try { this._menuMuteSwitch.disconnect(this._menuMuteId); } catch (_) {}
        }
        if (this._menuGtkRendererSwitch && this._menuGtkRendererId) {
            try { this._menuGtkRendererSwitch.disconnect(this._menuGtkRendererId); } catch (_) {}
        }
        if (this._menuDisableOnBatterySwitch && this._menuDisableOnBatteryId) {
            try { this._menuDisableOnBatterySwitch.disconnect(this._menuDisableOnBatteryId); } catch (_) {}
        }
        if (this._menuRestartItem && this._menuRestartId) {
            try { this._menuRestartItem.disconnect(this._menuRestartId); } catch (_) {}
        }
        if (this._menuSettingsItem && this._menuSettingsId) {
            try { this._menuSettingsItem.disconnect(this._menuSettingsId); } catch (_) {}
        }

        this._menuPlayPauseItem = null;
        this._menuNextItem = null;
        this._menuWallpaperEnabledSwitch = null;
        this._menuLockscreenEnabledSwitch = null;
        this._menuPauseWhenHiddenSwitch = null;
        this._menuRandomOrderSwitch = null;
        this._menuPerMonitorSwitch = null;
        this._menuWallpaperBlurSwitch = null;
        this._menuMuteSwitch = null;
        this._menuGtkRendererSwitch = null;
        this._menuDisableOnBatterySwitch = null;
        this._menuRestartItem = null;
        this._menuSettingsItem = null;
        this._menuPlayPauseId = null;
        this._menuNextId = null;
        this._menuWallpaperEnabledId = null;
        this._menuLockscreenEnabledId = null;
        this._menuPauseWhenHiddenId = null;
        this._menuRandomOrderId = null;
        this._menuPerMonitorId = null;
        this._menuWallpaperBlurId = null;
        this._menuMuteId = null;
        this._menuGtkRendererId = null;
        this._menuDisableOnBatteryId = null;
        this._menuRestartId = null;
        this._menuSettingsId = null;

        if (this._panelButton) {
            this._panelButton.destroy();
            this._panelButton = null;
        }
    }

    _syncStatusIndicator() {
        if (!this._panelButton || !this._settings)
            return;

        const showPanelButton = this._settings.get_boolean(Keys.DEBUG_SHOW_PANEL_BUTTON);
        if (!showPanelButton) {
            this._destroyStatusIndicator();
            return;
        }

        const isUserMode = Main.sessionMode.currentMode === 'user';
        const wallpaperEnabled = this._settings.get_boolean(Keys.WALLPAPER_ENABLED);
        const hasRuntime = !!this._wpPlayerProcess || (this._wpPipelines && this._wpPipelines.length > 0);
        const canControlPlayback = isUserMode && wallpaperEnabled && hasRuntime;
        const canToggleWallpaperFeatures = isUserMode && wallpaperEnabled;
        const paused = this._manualWallpaperPaused || this._wallpaperWasPaused;

        this._panelButton.visible = isUserMode;

        this._menuPlayPauseItem.label.set_text(paused ? 'Play Wallpaper' : 'Pause Wallpaper');
        this._menuPlayPauseItem.setSensitive(canControlPlayback);
        this._menuNextItem.setSensitive(canControlPlayback && this._canAdvanceWallpaperPlaylist());
        this._menuRestartItem.setSensitive(isUserMode);

        if (this._menuWallpaperEnabledSwitch.state !== wallpaperEnabled)
            this._menuWallpaperEnabledSwitch.setToggleState(wallpaperEnabled);
        if (this._menuLockscreenEnabledSwitch.state !== this._settings.get_boolean(Keys.LOCKSCREEN_ENABLED))
            this._menuLockscreenEnabledSwitch.setToggleState(this._settings.get_boolean(Keys.LOCKSCREEN_ENABLED));

        const pauseWhenHidden = this._settings.get_boolean(Keys.DEBUG_PAUSE_WHEN_HIDDEN);
        if (this._menuPauseWhenHiddenSwitch.state !== pauseWhenHidden)
            this._menuPauseWhenHiddenSwitch.setToggleState(pauseWhenHidden);
        this._menuPauseWhenHiddenSwitch.setSensitive(canToggleWallpaperFeatures);

        const randomOrder = this._settings.get_boolean(Keys.WALLPAPER_RANDOM_ORDER);
        if (this._menuRandomOrderSwitch.state !== randomOrder)
            this._menuRandomOrderSwitch.setToggleState(randomOrder);
        this._menuRandomOrderSwitch.setSensitive(canToggleWallpaperFeatures);

        const perMonitor = this._settings.get_boolean(Keys.WALLPAPER_PER_MONITOR);
        if (this._menuPerMonitorSwitch.state !== perMonitor)
            this._menuPerMonitorSwitch.setToggleState(perMonitor);
        this._menuPerMonitorSwitch.setSensitive(canToggleWallpaperFeatures);

        const blurEnabled = (this._settings.get_int(Keys.WALLPAPER_BLUR_RADIUS) ?? 0) > 0;
        if (this._menuWallpaperBlurSwitch.state !== blurEnabled)
            this._menuWallpaperBlurSwitch.setToggleState(blurEnabled);
        this._menuWallpaperBlurSwitch.setSensitive(canToggleWallpaperFeatures);

        const muted = this._settings.get_int(Keys.WALLPAPER_VOLUME) === 0;
        if (this._menuMuteSwitch.state !== muted)
            this._menuMuteSwitch.setToggleState(muted);
        this._menuMuteSwitch.setSensitive(canToggleWallpaperFeatures);

        const useGtkRenderer = !this._settings.get_boolean(Keys.DEBUG_USE_GTK4_SINK);
        if (this._menuGtkRendererSwitch.state !== useGtkRenderer)
            this._menuGtkRendererSwitch.setToggleState(useGtkRenderer);

        if (this._menuDisableOnBatterySwitch) {
            const disableOnBattery = this._settings.get_boolean(Keys.DISABLE_ON_BATTERY);
            if (this._menuDisableOnBatterySwitch.state !== disableOnBattery)
                this._menuDisableOnBatterySwitch.setToggleState(disableOnBattery);
        }
    }

    _canAdvanceWallpaperPlaylist() {
        if (this._wpMonitorStates && this._wpMonitorStates.some(s => (s?.videoPaths?.length ?? 0) > 1))
            return true;
        if (this._wpSubprocessMonitorVideos && this._wpSubprocessMonitorVideos.some(v => (v?.length ?? 0) > 1))
            return true;
        return false;
    }

    _toggleWallpaperPlaybackFromMenu() {
        if (Main.sessionMode.currentMode !== 'user')
            return;

        const hasPipelines = this._wpPipelines && this._wpPipelines.length > 0;
        const hasSubprocess = !!this._wpPlayerProcess;
        if (!hasPipelines && !hasSubprocess)
            return;

        const shouldPlay = this._manualWallpaperPaused || this._wallpaperWasPaused;
        if (shouldPlay) {
            if (hasPipelines)
                this._wpPipelines.forEach(p => p.play());
            if (hasSubprocess)
                this._wpPlayerProcess.play();
            this._manualWallpaperPaused = false;
            this._wallpaperWasPaused = false;
            this._wpDesktopHidden = false;
            if (hasPipelines) this._checkDesktopVisibility();
            if (hasSubprocess) this._checkDesktopVisibilitySubprocess();
        } else {
            if (hasPipelines)
                this._wpPipelines.forEach(p => p.pause());
            if (hasSubprocess)
                this._wpPlayerProcess.pause();
            this._manualWallpaperPaused = true;
            this._wallpaperWasPaused = true;
        }

        this._syncStatusIndicator();
    }

    _advanceWallpaperFromMenu() {
        if (Main.sessionMode.currentMode !== 'user')
            return;

        if (this._wpPlayerProcess) {
            this._wpPlayerProcess.next();
            this._syncStatusIndicator();
            return;
        }

        if (!this._wpMonitorStates || this._wpMonitorStates.length === 0)
            return;

        for (let i = 0; i < this._wpMonitorStates.length; i++) {
            const state = this._wpMonitorStates[i];
            if (!state || !state.videoPaths || state.videoPaths.length <= 1)
                continue;
            this._onWallpaperMonitorVideoEnd(i);
        }
        this._syncStatusIndicator();
    }

    _restartWallpaperFromMenu() {
        if (Main.sessionMode.currentMode !== 'user')
            return;
        this._manualWallpaperPaused = false;
        this._wallpaperWasPaused = false;
        this._teardownWallpaper();
        this._enableWallpaper();
        this._syncStatusIndicator();
    }

    // Lock screen

    _enableLockScreen() {
        try {
            if (this._settings && !this._settings.get_boolean(Keys.LOCKSCREEN_ENABLED)) {
                console.log('[LockScreen] Disabled by setting, skipping setup');
                this._disableLockScreen();
                return;
            }
            console.log('[LockScreen] _enableLockScreen called');
            if (!Main.screenShield?._dialog) {
                // The dialog can appear late on some systems. Retry for a few
                // seconds instead of giving up after a single attempt.
                if (!this._lockRetryCount)
                    this._lockRetryCount = 0;
                this._lockRetryCount += 1;
                if (this._lockRetryCount > 20) {
                    console.error('[LockScreen] screenShield._dialog not available after retries');
                    this._lockRetryCount = 0;
                    return;
                }

                console.log(`[LockScreen] screenShield._dialog not ready, retry ${this._lockRetryCount}/20 in 250ms…`);
                this._lockRetryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                    this._lockRetryId = null;
                    this._enableLockScreen();
                    return GLib.SOURCE_REMOVE;
                });
                return;
            }
            this._lockRetryCount = 0;
            if (this._shouldUseGtk4Sink()) {
                this._setupLockScreenSubprocess();
            } else {
                this._setupLockScreen();
            }
        } catch (e) {
            console.error(`[LockScreen] _enableLockScreen failed: ${e.message}\n${e.stack}`);
        }
    }

    _setupLockScreen() {

        this._promptShown = false;

        this._actors = [];
        this._images = [];
        this._lockPipelines = [];          // Per-monitor pipelines (or single shared)
        this._lockMonitorStates = [];      // Per-monitor playlist state

        this._injectionManager = null;

        // Check battery — skip video lock screen to save power
        if (this._settings.get_boolean(Keys.DISABLE_ON_BATTERY) && this._isOnBattery()) {
            console.log('[LockScreen] Skipping — device is on battery power');
            return;
        }

        // Load shared video paths - prefer multiple videos, fallback to single
        let videoPaths = [];
        try {
            videoPaths = this._settings.get_strv(Keys.VIDEO_PATHS);
            if (!videoPaths || !Array.isArray(videoPaths)) videoPaths = [];
        } catch (e) {
            videoPaths = [];
        }
        const singleVideoPath = this._settings.get_string(Keys.VIDEO_PATH);
        if (videoPaths.length === 0 && singleVideoPath) {
            videoPaths = [singleVideoPath];
        }
        videoPaths = videoPaths.filter(path => {
            if (!path || !path.trim()) return false;
            if (!GLib.file_test(path, GLib.FileTest.EXISTS)) {
                console.log(`[LockScreen] Skipping missing video: ${path}`);
                return false;
            }
            return true;
        });

        // Per-monitor check
        this._lockscreenPerMonitor = this._settings.get_boolean(Keys.LOCKSCREEN_PER_MONITOR);
        let lockPerMonitorConfig = {};
        if (this._lockscreenPerMonitor) {
            try {
                lockPerMonitorConfig = JSON.parse(this._settings.get_string(Keys.LOCKSCREEN_PER_MONITOR_CONFIG));
            } catch (e) { lockPerMonitorConfig = {}; }
        }

        // If per-monitor is off, we need at least a shared video list
        if (!this._lockscreenPerMonitor && videoPaths.length === 0) {
            console.warning('No videos set, falling back');
            return;
        }

        this._videoPaths = videoPaths;
        this._currentVideoIndex = -1;
        this._randomOrder = this._settings.get_boolean(Keys.VIDEO_RANDOM_ORDER);
        
        // Common settings
        this._fadeInDuration = this._settings.get_int(Keys.FADE_IN_DURATION);
        this._scalingMode = this._settings.get_int(Keys.SCALING_MODE);
        this._blurRadius = this._settings.get_int(Keys.BLUR_RADIUS);
        this._blurBrightness = this._settings.get_double(Keys.BLUR_BRIGHTNESS);

        this._volume = this._settings.get_int(Keys.AUDIO_VOLUME) / 100

        this._promptSettings = {
            [Keys.PROMPT_PAUSE]: 
                this._settings.get_boolean(Keys.PROMPT_PAUSE),
            [Keys.PROMPT_CHANGE_BLUR]: 
                this._settings.get_boolean(Keys.PROMPT_CHANGE_BLUR),
            [Keys.PROMPT_BLUR_RADIUS]: 
                this._settings.get_int(Keys.PROMPT_BLUR_RADIUS),
            [Keys.PROMPT_BLUR_ANIM_DURATION]: 
                this._settings.get_int(Keys.PROMPT_BLUR_ANIM_DURATION),
            [Keys.PROMPT_BLUR_BRIGHTNESS]: 
                this._settings.get_double(Keys.PROMPT_BLUR_BRIGHTNESS),
            [Keys.PROMPT_GRAYSCALE]: 
                this._settings.get_boolean(Keys.PROMPT_GRAYSCALE),
        }

        const loop = this._settings.get_boolean(Keys.LOOPED);
        const autoFps = this._settings.get_boolean(Keys.VIDEO_AUTO_FPS);
        const manualFramerate = this._settings.get_int(Keys.FRAMERATE);
        const skipFrame = this._settings.get_boolean(Keys.DEBUG_SKIP_FIRST_FRAME);
        const preferHwDecoder = this._settings.get_boolean(Keys.DEBUG_PREFER_HW_DECODER);
        const gpuColorConversion = this._settings.get_boolean(Keys.DEBUG_GPU_COLOR_CONVERSION);
        const adaptivePolling = this._settings.get_boolean(Keys.DEBUG_PUSH_FRAME_DELIVERY);
        
        // Helper to get framerate for a video
        this._getFramerateForVideo = (videoPath) => {
            if (!autoFps) return manualFramerate;
            try {
                const metadata = this._settings.get_value(Keys.VIDEO_METADATA).recursiveUnpack();
                if (metadata && metadata[videoPath]) {
                    const meta = metadata[videoPath];
                    let fps = null;
                    if (meta.fps) {
                        fps = (typeof meta.fps === 'object' && meta.fps.get_int32)
                            ? meta.fps.get_int32()
                            : (typeof meta.fps === 'number' ? meta.fps : null);
                    }
                    if (fps && fps > 0) return fps;
                }
            } catch (e) { }
            return manualFramerate;
        };

        // Track play count when video starts
        this._incrementPlayCount = (videoPath) => {
            try {
                let metadata = this._settings.get_value(Keys.VIDEO_METADATA).recursiveUnpack();
                if (!metadata) metadata = {};
                if (!metadata[videoPath]) metadata[videoPath] = {};
                
                const currentCount = metadata[videoPath].playCount || 0;
                metadata[videoPath].playCount = currentCount + 1;
                
                const variantDict = {};
                for (const [key, value] of Object.entries(metadata)) {
                    const valueDict = {};
                    if (value.fps !== undefined) valueDict['fps'] = new GLib.Variant('i', value.fps);
                    if (value.width !== undefined) valueDict['width'] = new GLib.Variant('i', value.width);
                    if (value.height !== undefined) valueDict['height'] = new GLib.Variant('i', value.height);
                    if (value.duration !== undefined) valueDict['duration'] = new GLib.Variant('i', value.duration);
                    if (value.playCount !== undefined) valueDict['playCount'] = new GLib.Variant('i', value.playCount);
                    variantDict[key] = new GLib.Variant('a{sv}', valueDict);
                }
                this._settings.set_value(Keys.VIDEO_METADATA, new GLib.Variant('a{sv}', variantDict));
            } catch (e) {
                console.log('Error incrementing play count:', e);
            }
        };

        // NOTE: Force gpuColorConversion OFF for lock screen pipelines.
        // Creating GL contexts (glupload/glcolorconvert/gldownload) during the
        // lock-screen compositor transition can deadlock with Wayland/Mutter.
        // CPU videoconvert is safe and lock screen pipelines are short-lived.
        this._lockPerMonitorConfig = lockPerMonitorConfig;
        this._lockPipelineParams = { loop, autoFps, manualFramerate, skipFrame, preferHwDecoder, gpuColorConversion: false, adaptivePolling };

        // Build connector map for per-monitor mode
        if (this._lockscreenPerMonitor) {
            this._lockConnectorMap = {};
            try {
                const monitorManager = global.backend.get_monitor_manager();
                const logicalMonitors = monitorManager.get_logical_monitors();
                for (const lm of logicalMonitors) {
                    const displayIdx = lm.get_number();
                    const metaMonitors = lm.get_monitors();
                    if (metaMonitors && metaMonitors.length > 0) {
                        this._lockConnectorMap[displayIdx] = metaMonitors[0].get_connector();
                    }
                }
                console.log(`[LockScreen] Connector map: ${JSON.stringify(this._lockConnectorMap)}`);
            } catch (e) {
                console.log(`[LockScreen] Failed to build connector map: ${e.message}`);
            }
        }

        // For shared mode (non per-monitor), prepare the shared pipeline
        if (!this._lockscreenPerMonitor) {
        const initialVideoPath = this._selectNextVideo();
        if (!initialVideoPath) {
            console.warning('Failed to select initial video, falling back')
            return;
        }
        this._discoverVideoProperties(initialVideoPath);
        
        const initialFramerate = this._getFramerateForVideo(initialVideoPath);
            console.log(`[LockScreen] Shared mode: ${initialVideoPath.split('/').pop()} at ${initialFramerate}fps`);

            const monitors = Main.layoutManager.monitors;
            const maxW = Math.max(...monitors.map(m => m.width));
            const maxH = Math.max(...monitors.map(m => m.height));

        this._pipeline = new Pipeline({
            videoPath: initialVideoPath,
            volume: this._volume,
                loop: loop && this._videoPaths.length === 1,
            framerate: initialFramerate,
            skipFrame: skipFrame,
                targetWidth: maxW,
                targetHeight: maxH,
                preferHwDecoder: preferHwDecoder,
                gpuColorConversion: false, // Force CPU conversion for lock screen (GL deadlocks)
                adaptivePolling: adaptivePolling,
                name: 'ls-shared',
            dataCallback: this._drawImages.bind(this),
            onVideoEnd: this._videoPaths.length > 1 ? this._onVideoEnd.bind(this) : null
            });
        }
        
        // Creating blur effect
        const themeContext = St.ThemeContext.get_for_stage(global.stage);
        this._blurRadius *= themeContext.scale_factor
        this._promptSettings[Keys.BLUR_RADIUS] *= themeContext.scale_factor

        this._blurEffect = {
            name: 'lockscreen-extension-blur',
            radius: this._blurRadius,
            brightness: this._blurBrightness,
        };

        const backend = Clutter.get_default_backend();
        this._coglContext = backend.get_cogl_context();

        // Track which videos have been selected as initial across monitors,
        // so per-monitor mode doesn't start all monitors on the same video.
        this._lockUsedInitialVideos = new Set();

        // Patch lock dialog background creation to inject our actors.
        this._injectionManager = new InjectionManager();
        this._injectionManager.overrideMethod(Main.screenShield._dialog, '_createBackground',
            (original) => {
                const self = this;
                return function(monitorIndex) {
                    original.call(this, monitorIndex);
                    self._handleMonitor(monitorIndex);
            };
        });

        Main.screenShield._dialog._updateBackgrounds();

        // Monkey-patching showPrompt (password prompt)
        this._injectionManager.overrideMethod(Main.screenShield._dialog, '_showPrompt',
            (original) => {
                const self = this;
                return function(...args) {
                    original.call(this, ...args);
                    self._onPromptShow();
                };
            }
        );

        // Monkey-patching showClock (hide password prompt)
        this._injectionManager.overrideMethod(Main.screenShield._dialog, '_showClock',
            (original) => {
                const self = this;
                return function(...args) {
                    original.call(this, ...args);
                    self._onPromptHide();
                };
            }
        );
    }

    // Subprocess lock screen (gtk4paintablesink)

    _showLockStartupCover() {
        const dialog = Main.screenShield?._dialog;
        const bgGroup = dialog?._backgroundGroup;
        if (!bgGroup)
            return;

        if (this._lockStartupCover) {
            try {
                if (this._lockStartupCover.get_parent() !== bgGroup)
                    bgGroup.add_child(this._lockStartupCover);
                this._lockStartupCover.show();
            } catch (_) {}
            return;
        }

        const cover = new Clutter.Actor({
            x: 0,
            y: 0,
            width: global.stage.width,
            height: global.stage.height,
            reactive: false,
            opacity: 255,
        });
        try { cover.set_background_color(new Clutter.Color({ red: 0, green: 0, blue: 0, alpha: 255 })); } catch (_) {}
        bgGroup.add_child(cover);
        bgGroup.set_child_above_sibling(cover, null);
        this._lockStartupCover = cover;
    }

    _hideLockStartupCover() {
        if (!this._lockStartupCover)
            return;
        try { this._lockStartupCover.destroy(); } catch (_) {}
        this._lockStartupCover = null;
    }

    _setupLockScreenSubprocess() {
        this._promptShown = false;
        this._actors = [];    // Wrapper actors for effects
        this._lockPlayerProcess = null;
        this._lockWindowActors = {};
        this._injectionManager = null;
        this._showLockStartupCover();

        // Check battery
        if (this._settings.get_boolean(Keys.DISABLE_ON_BATTERY) && this._isOnBattery()) {
            console.log('[LockScreen:GTK4] Skipping — device is on battery power');
            return;
        }

        // Load video paths (shared + per-monitor)
        let videoPaths = [];
        try {
            videoPaths = this._settings.get_strv(Keys.VIDEO_PATHS);
            if (!videoPaths || !Array.isArray(videoPaths)) videoPaths = [];
        } catch (e) { videoPaths = []; }
        const singleVideoPath = this._settings.get_string(Keys.VIDEO_PATH);
        if (videoPaths.length === 0 && singleVideoPath) videoPaths = [singleVideoPath];
        videoPaths = videoPaths.filter(p => p && p.trim() && GLib.file_test(p, GLib.FileTest.EXISTS));

        const lockscreenPerMonitor = this._settings.get_boolean(Keys.LOCKSCREEN_PER_MONITOR);
        let lockPerMonitorConfig = {};
        if (lockscreenPerMonitor) {
            try { lockPerMonitorConfig = JSON.parse(this._settings.get_string(Keys.LOCKSCREEN_PER_MONITOR_CONFIG)); }
            catch (e) { lockPerMonitorConfig = {}; }
        }

        // Build monitor config for the subprocess
        const monitors = Main.layoutManager.monitors;
        const subprocessMonitors = [];

        if (lockscreenPerMonitor) {
            // Build connector map
            const connectorMap = {};
            try {
                const mm = global.backend.get_monitor_manager();
                for (const lm of mm.get_logical_monitors()) {
                    const metas = lm.get_monitors();
                    if (metas?.length > 0) connectorMap[lm.get_number()] = metas[0].get_connector();
                }
            } catch (e) {}

            for (let i = 0; i < monitors.length; i++) {
                const conn = connectorMap[monitors[i].index] || connectorMap[i] || `Monitor-${i}`;
                const rawPaths = lockPerMonitorConfig[conn] || lockPerMonitorConfig[`Monitor-${i}`] || lockPerMonitorConfig[String(i)] || [];
                let paths = rawPaths.filter(p => p && p.trim() && GLib.file_test(p, GLib.FileTest.EXISTS));
                if (paths.length === 0) paths = videoPaths; // fallback to shared
                subprocessMonitors.push({ videos: paths });
            }
        } else {
            if (videoPaths.length === 0) {
                console.warn('[LockScreen:GTK4] No videos set, falling back');
                return;
            }
            // Shared: one monitor config entry, player.js will share the paintable
            subprocessMonitors.push({ videos: videoPaths });
        }

        // Settings for subprocess
        const volume = this._settings.get_int(Keys.AUDIO_VOLUME) / 100;
        const scalingMode = this._settings.get_int(Keys.SCALING_MODE);
        const useVideorate = this._settings.get_int(Keys.FRAMERATE) > 0; // only if framerate set
        const framerate = this._settings.get_int(Keys.FRAMERATE);
        this._fadeInDuration = this._settings.get_int(Keys.FADE_IN_DURATION);
        this._scalingMode = scalingMode;
        this._blurRadius = this._settings.get_int(Keys.BLUR_RADIUS);
        this._blurBrightness = this._settings.get_double(Keys.BLUR_BRIGHTNESS);

        this._promptSettings = {
            [Keys.PROMPT_PAUSE]:              this._settings.get_boolean(Keys.PROMPT_PAUSE),
            [Keys.PROMPT_CHANGE_BLUR]:        this._settings.get_boolean(Keys.PROMPT_CHANGE_BLUR),
            [Keys.PROMPT_BLUR_RADIUS]:        this._settings.get_int(Keys.PROMPT_BLUR_RADIUS),
            [Keys.PROMPT_BLUR_ANIM_DURATION]: this._settings.get_int(Keys.PROMPT_BLUR_ANIM_DURATION),
            [Keys.PROMPT_BLUR_BRIGHTNESS]:    this._settings.get_double(Keys.PROMPT_BLUR_BRIGHTNESS),
            [Keys.PROMPT_GRAYSCALE]:          this._settings.get_boolean(Keys.PROMPT_GRAYSCALE),
        };

        const themeContext = St.ThemeContext.get_for_stage(global.stage);
        this._blurRadius *= themeContext.scale_factor;
        this._promptSettings[Keys.BLUR_RADIUS] *= themeContext.scale_factor;

        this._blurEffect = {
            name: 'lockscreen-extension-blur',
            radius: this._blurRadius,
            brightness: this._blurBrightness,
        };

        // Spawn the subprocess
        const randomOrder = this._settings.get_boolean(Keys.VIDEO_RANDOM_ORDER);
        const config = {
            scalingMode,
            volume,
            useVideorate: false, // Let playbin handle framerate
            framerate,
            randomOrder,
            monitors: subprocessMonitors,
        };

        this._lockPlayerProcess = new PlayerProcess({
            playerPath: this.path + '/external/run.js',
            config,
        });

        try {
            this._lockPlayerProcess.run();
        } catch (e) {
            console.error(`[LockScreen:GTK4] Failed to spawn player: ${e.message}`);
            this._lockPlayerProcess = null;
            this._hideLockStartupCover();
            return;
        }

        // Temporarily hide window animations so the player windows don't flash
        this._injectionManager = new InjectionManager();
        this._injectionManager.overrideMethod(
            Main.wm, '_shouldAnimateActor',
            (original) => function(_actor, _types) { return false; }
        );

        const monitorCount = monitors.length;
        this._lockPlayerProcess.waitForWindows(monitorCount, 10000, (windows) => {
            console.log(`[LockScreen:GTK4] All ${windows.length} window(s) mapped`);

            // User may have unlocked before helper windows appeared.
            if (!Main.screenShield?._dialog) {
                console.warn('[LockScreen:GTK4] Lock screen dialog no longer exists, aborting');
                this._lockPlayerProcess?.destroy();
                this._lockPlayerProcess = null;
                this._hideLockStartupCover();
                return;
            }

            // Store window actors by monitor index derived from the GTK window
            // title (LiveLockPaper-<index>). Map-event ordering is not stable.
            windows.forEach((win, i) => {
                const title = win.get_title() || '';
                const match = title.match(/^LiveLockPaper-(\d+)$/);
                const monitorIndex = match ? Number.parseInt(match[1], 10) : i;
                const targetMonitor = monitors[monitorIndex] || monitors[i] || monitors[0];
                if (targetMonitor) {
                    const enforceFrame = () => {
                        try {
                            win.move_resize_frame(
                                false,
                                targetMonitor.x,
                                targetMonitor.y,
                                targetMonitor.width,
                                targetMonitor.height
                            );
                        } catch (_) {
                            try { win.move_frame(false, targetMonitor.x, targetMonitor.y); } catch (_) {}
                        }
                    };
                    enforceFrame();
                    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                        if (!this._lockPlayerProcess)
                            return GLib.SOURCE_REMOVE;
                        enforceFrame();
                        return GLib.SOURCE_REMOVE;
                    });
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 260, () => {
                        if (!this._lockPlayerProcess)
                            return GLib.SOURCE_REMOVE;
                        enforceFrame();
                        return GLib.SOURCE_REMOVE;
                    });
                }
                try { win.set_skip_taskbar(true); } catch (_) {
                    try { win.skip_taskbar = true; } catch (_) {}
                }
                try { win.set_skip_pager(true); } catch (_) {
                    try { win.skip_pager = true; } catch (_) {}
                }
                this._lockWindowActors[monitorIndex] = win.get_compositor_private();
            });

            // Override _createBackground to reparent our windows
            this._injectionManager.overrideMethod(
                Main.screenShield._dialog, '_createBackground',
                (original) => {
                    const self = this;
                    return function(idx) {
                        original.call(this, idx);
                        self._handleMonitorSubprocess(idx);
                    };
                }
            );

            // Override prompt show/hide
            this._injectionManager.overrideMethod(
                Main.screenShield._dialog, '_showPrompt',
                (original) => {
                    const self = this;
                    return function(...args) {
                        original.call(this, ...args);
                        self._onPromptShow();
                    };
                }
            );
            this._injectionManager.overrideMethod(
                Main.screenShield._dialog, '_showClock',
                (original) => {
                    const self = this;
                    return function(...args) {
                        original.call(this, ...args);
                        self._onPromptHide();
                    };
                }
            );

            Main.screenShield._dialog._updateBackgrounds();
        }, (err) => {
            console.error(`[LockScreen:GTK4] ${err}`);
            // Restore animation override
            this._injectionManager?.clear();
            this._injectionManager = null;
            this._hideLockStartupCover();
        });
    }

    // Reparent a helper window actor into lock screen background.
    _handleMonitorSubprocess(monitorIndex) {
        const isLastMonitor = monitorIndex === Main.layoutManager.monitors.length - 1;
        const windowActor = this._lockWindowActors[monitorIndex];

        if (windowActor) {
            const parent = windowActor.get_parent();
            if (parent) parent.remove_child(windowActor);

            // Position wrapper at the monitor geometry.
            const monitor = Main.layoutManager.monitors[monitorIndex];
            const wrapper = new Clutter.Actor({
                x: monitor.x,
                y: monitor.y,
                width: monitor.width,
                height: monitor.height,
                clip_to_allocation: true,
            });

            Main.screenShield._dialog._backgroundGroup.add_child(wrapper);
            Main.screenShield._dialog._backgroundGroup.set_child_above_sibling(wrapper, null);

            wrapper.add_effect(new Shell.BlurEffect(this._blurEffect));

            // Pre-add desaturate effect (factor 0 = no effect yet)
            if (this._promptSettings[Keys.PROMPT_GRAYSCALE]) {
                wrapper.add_effect_with_name(
                    'lockscreen-extension-desaturate',
                    new Clutter.DesaturateEffect({ factor: 0.0 })
                );
            }

            if (this._fadeInDuration > 0)
                wrapper.opacity = 0;

            wrapper.add_child(windowActor);
            windowActor.reactive = false;

            // Translation-only fitting avoids resampling artifacts.
            const fixPositionAndScale = () => {
                windowActor.set_translation(-Math.round(windowActor.x), -Math.round(windowActor.y), 0);
                windowActor.set_pivot_point(0, 0);
                windowActor.set_scale(1, 1);
            };
            let lockFixQueued = 0;
            const queueFixPositionAndScale = () => {
                if (lockFixQueued)
                    return;
                lockFixQueued = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    lockFixQueued = 0;
                    if (!this._lockPlayerProcess)
                        return GLib.SOURCE_REMOVE;
                    fixPositionAndScale();
                    return GLib.SOURCE_REMOVE;
                });
            };
            if (!this._lockPositionSignals) this._lockPositionSignals = [];
            const sigX = windowActor.connect('notify::x', queueFixPositionAndScale);
            const sigY = windowActor.connect('notify::y', queueFixPositionAndScale);
            const sigW = windowActor.connect('notify::width', queueFixPositionAndScale);
            const sigH = windowActor.connect('notify::height', queueFixPositionAndScale);
            this._lockPositionSignals.push({ actor: windowActor, ids: [sigX, sigY, sigW, sigH] });
            queueFixPositionAndScale();
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 260, () => {
                if (!this._lockPlayerProcess)
                    return GLib.SOURCE_REMOVE;
                fixPositionAndScale();
                return GLib.SOURCE_REMOVE;
            });

            // When the wrapper is destroyed (unlock), detach the actor. The
            // helper process owns the toplevel window and will tear it down;
            // re-inserting into window_group can confuse dock/window trackers.
            wrapper.connect('destroy', () => {
                const p = windowActor.get_parent();
                if (p) p.remove_child(windowActor);
                try { windowActor.hide(); } catch (_) {}
                delete this._lockWindowActors[monitorIndex];
            });

            this._actors.push(wrapper);
        } else {
            console.warn(`[LockScreen:GTK4] No window actor for monitor ${monitorIndex}`);
        }

        if (isLastMonitor) {
            this._hideLockStartupCover();
            this._initLoginManagerSubprocess();
            this._startAnimation();
            this._lockPlayerProcess?.play();
            console.log(`[LockScreen:GTK4] ${Object.keys(this._lockWindowActors).length} window(s) reparented and playing`);
        }
    }

    _initLoginManagerSubprocess() {
        this._loginManager = LoginManager.getLoginManager();
        this._sleepId = this._loginManager.connect('prepare-for-sleep', (_manager, aboutToSleep) => {
            if (!this._lockPlayerProcess) return;
            aboutToSleep ? this._lockPlayerProcess.pause() : this._lockPlayerProcess.play();
        });
    }

    _disableLockScreen() {
        this._hideLockStartupCover();
        if (this._lockRetryId) {
            GLib.Source.remove(this._lockRetryId);
            this._lockRetryId = null;
        }
        this._lockRetryCount = 0;

        if (this._injectionManager) {
            this._injectionManager.clear();
            this._injectionManager = null;
        }

        if (this._sleepId) {
            this._loginManager.disconnect(this._sleepId);
            this._sleepId = null;
        }

        // Destroy subprocess player (gtk4 mode)
        if (this._lockPlayerProcess) {
            // Disconnect position/scale watchers
            if (this._lockPositionSignals) {
                for (const { actor, ids } of this._lockPositionSignals) {
                    for (const id of ids) {
                        try { actor.disconnect(id); } catch (_) {}
                    }
                }
                this._lockPositionSignals = [];
            }
            // Detach all window actors before destroying the helper process.
            for (const windowActor of Object.values(this._lockWindowActors)) {
                try {
                    windowActor.set_translation(0, 0, 0);
                    windowActor.set_scale(1, 1);
                    const parent = windowActor.get_parent();
                    if (parent) parent.remove_child(windowActor);
                    windowActor.hide();
                } catch (e) {}
            }
            this._lockWindowActors = {};
            this._lockPlayerProcess.destroy();
            this._lockPlayerProcess = null;
        }
        
        // Destroy shared pipeline (non per-monitor mode)
        if (this._pipeline) {
            this._pipeline.destroy();
            this._pipeline = null;
        }

        // Destroy per-monitor pipelines
        if (this._lockPipelines) {
            this._lockPipelines.forEach(p => p.destroy());
            this._lockPipelines = [];
        }
        this._lockMonitorStates = [];

        this._coglContext = null;
        if (this._actors) {
            this._actors.forEach(a => {
                try { a.remove_effect_by_name('lockscreen-extension-blur'); } catch (e) {}
                a.destroy();
            });
            this._actors = [];
        }
        if (this._images) {
            this._images = [];
        }
    }

    _onPromptShow() {
        if (this._promptShown) return;
        this._promptShown = true;

        const animDuration = this._promptSettings[Keys.PROMPT_BLUR_ANIM_DURATION];

        this._actors.forEach(actor => {
            if (this._promptSettings[Keys.PROMPT_CHANGE_BLUR]) {
                let radius = this._promptSettings[Keys.PROMPT_BLUR_RADIUS];
                let brightness = radius ? this._promptSettings[Keys.PROMPT_BLUR_BRIGHTNESS] : 1; 

                actor.ease_property(
                    '@effects.lockscreen-extension-blur.radius', 
                    this._promptSettings[Keys.PROMPT_BLUR_RADIUS], 
                    {
                        duration: animDuration,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    }
                );
                actor.ease_property(
                    '@effects.lockscreen-extension-blur.brightness', 
                    brightness, 
                    {
                        duration: animDuration,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    }
                );
            }

            // Grayscale (desaturation) effect on password prompt
            if (this._promptSettings[Keys.PROMPT_GRAYSCALE]) {
                if (!actor.get_effect('lockscreen-extension-desaturate')) {
                    const desaturate = new Clutter.DesaturateEffect({ factor: 0.0 });
                    actor.add_effect_with_name('lockscreen-extension-desaturate', desaturate);
                }
                actor.ease_property(
                    '@effects.lockscreen-extension-desaturate.factor',
                    1.0,
                    {
                        duration: animDuration,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    }
                );
            }
        })

        if (this._promptSettings[Keys.PROMPT_PAUSE]) {
            // Pause all pipelines (shared + per-monitor + subprocess)
            if (this._pipeline) this._pipeline.pause();
            if (this._lockPipelines) this._lockPipelines.forEach(p => p.pause());
            if (this._lockPlayerProcess) this._lockPlayerProcess.pause();
        }
    }

    _onPromptHide() {
        if (!this._promptShown) return;
        this._promptShown = false;

        const animDuration = this._promptSettings[Keys.PROMPT_BLUR_ANIM_DURATION];

        this._actors.forEach(actor => {
            if (this._promptSettings[Keys.PROMPT_CHANGE_BLUR]) {
                let radius = this._blurRadius;
                let brightness = radius ? this._blurBrightness : 1; 

                actor.ease_property(
                    '@effects.lockscreen-extension-blur.radius', 
                    this._blurRadius, 
                    {
                        duration: animDuration,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    }
                );
                actor.ease_property(
                    '@effects.lockscreen-extension-blur.brightness', 
                    brightness, 
                    {
                        duration: animDuration,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    }
                );
            }

            // Remove grayscale effect when prompt hides
            if (this._promptSettings[Keys.PROMPT_GRAYSCALE]) {
                actor.ease_property(
                    '@effects.lockscreen-extension-desaturate.factor',
                    0.0,
                    {
                        duration: animDuration,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    }
                );
            }
        })

        if (this._promptSettings[Keys.PROMPT_PAUSE]) {
            // Resume all pipelines (shared + per-monitor + subprocess)
            if (this._pipeline) this._pipeline.play();
            if (this._lockPipelines) this._lockPipelines.forEach(p => p.play());
            if (this._lockPlayerProcess) this._lockPlayerProcess.play();
        }
    }

    _handleMonitor(monitorIndex) {
        const monitor = Main.layoutManager.monitors[monitorIndex];
        const isLastMonitor = monitorIndex === Main.layoutManager.monitors.length - 1;
        const { loop, skipFrame, preferHwDecoder, gpuColorConversion, adaptivePolling } = this._lockPipelineParams;

        if (this._lockscreenPerMonitor) {
            // Per-monitor mode.
            const connector = (this._lockConnectorMap && this._lockConnectorMap[monitor.index])
                || (this._lockConnectorMap && this._lockConnectorMap[monitorIndex])
                || `Monitor-${monitorIndex}`;

            const monitorPaths = (this._lockPerMonitorConfig[connector] || []).filter(p => {
                if (!p || !p.trim()) return false;
                if (!GLib.file_test(p, GLib.FileTest.EXISTS)) {
                    console.log(`[LockScreen] Skipping missing video for ${connector}: ${p}`);
                    return false;
                }
                return true;
            });

            console.log(`[LockScreen] Per-monitor: ${connector} (${monitor.width}x${monitor.height}), ${monitorPaths.length} video(s)`);

            if (monitorPaths.length === 0) {
                // No videos for this monitor — use shared list as fallback
                if (this._videoPaths && this._videoPaths.length > 0) {
                    console.log(`[LockScreen] No per-monitor config for "${connector}", using shared video list`);
                    // Fall through to shared handling below
                } else {
                    return;
                }
            }

            const effectivePaths = monitorPaths.length > 0 ? monitorPaths : this._videoPaths;

            // Playlist state for this monitor
            const state = {
                videoPaths: effectivePaths,
                currentIndex: -1,
                randomOrder: this._randomOrder,
            };

            // Select initial video — avoid duplicates across monitors
            const videoPath = this._selectUniqueInitialVideo(state, this._lockUsedInitialVideos);
            if (!videoPath) return;
            this._lockUsedInitialVideos.add(videoPath);

            // Discover dimensions
            let dims = { width: monitor.width, height: monitor.height };
            try {
                const discoverer = new GstPbutils.Discoverer({ timeout: 1 * Gst.SECOND });
                const info = discoverer.discover_uri(GLib.filename_to_uri(videoPath, null));
                const streams = info.get_video_streams();
                if (streams.length > 0) {
                    dims = { width: streams[0].get_width(), height: streams[0].get_height() };
                }
            } catch (e) { }

            const { actor, container, image } = createActor({
                monitor,
                video_width: dims.width,
                video_height: dims.height,
                scaling_mode: this._scalingMode,
            });

            const mainActor = container || actor;
            this._actors.push(mainActor);
            this._images.push(image);

            mainActor.add_effect(new Shell.BlurEffect(this._blurEffect));
            Main.screenShield._dialog._backgroundGroup.add_child(mainActor);
            Main.screenShield._dialog._backgroundGroup.set_child_above_sibling(mainActor, null);

            if (this._fadeInDuration > 0) mainActor.opacity = 0;

            // Stagger timers to spread main-thread load.
            const pipelineIndex = this._lockPipelines.length;
            const framerate = this._getFramerateForVideo(videoPath);
            const shouldLoop = loop && effectivePaths.length === 1;
            const totalLockMonitors = Main.layoutManager.monitors.length;
            const staggerMs = totalLockMonitors > 1
                ? Math.round((1000 / framerate) / totalLockMonitors) * pipelineIndex
                : 0;

            const pipeline = new Pipeline({
                videoPath: videoPath,
                volume: this._volume,
                loop: shouldLoop,
                framerate: framerate,
                skipFrame: skipFrame,
                targetWidth: monitor.width,
                targetHeight: monitor.height,
                preferHwDecoder: preferHwDecoder,
                gpuColorConversion: gpuColorConversion,
                adaptivePolling: adaptivePolling,
                name: `ls-${connector}`,
                timerDelay: staggerMs,
                dataCallback: (data, w, h) => {
                    setImageData(image, this._coglContext, data, Cogl.PixelFormat.BGRA_8888, w, h, w * 4);
                },
                onVideoEnd: effectivePaths.length > 1 ? () => {
                    this._onLockMonitorVideoEnd(pipelineIndex);
                } : null,
            });

            this._lockPipelines.push(pipeline);
            this._lockMonitorStates.push(state);

            console.log(`[LockScreen] ${connector}: ${videoPath.split('/').pop()} at ${framerate}fps`);
        } else {
            // Shared mode.
        const { actor, container, image } = createActor({
            monitor,
            video_width: this.width, 
            video_height: this.height,
            scaling_mode: this._scalingMode,
            });

        let mainActor = container ? container : actor;

        this._actors.push(mainActor);
        this._images.push(image);
        
        mainActor.add_effect(new Shell.BlurEffect(this._blurEffect));
        Main.screenShield._dialog._backgroundGroup.add_child(mainActor);
        Main.screenShield._dialog._backgroundGroup.set_child_above_sibling(mainActor, null);

        if (this._fadeInDuration > 0) {
            mainActor.opacity = 0;
        }
        }

        console.log(`[LockScreen] _handleMonitor(${monitorIndex}), isLast=${isLastMonitor}, perMonitor=${this._lockscreenPerMonitor}, actors=${this._actors.length}`);

        if (isLastMonitor) {
            try {
                if (this._lockscreenPerMonitor) {
                    // Initialize and start all per-monitor pipelines
                    this._lockPipelines.forEach(p => {
                        try { if (p.init()) p.play(); }
                        catch (e) { console.error(`[LockScreen] Pipeline init/play failed: ${e.message}`); }
                    });
                } else {
                    // Shared pipeline
                    this._initPipeline();
                }
                this._initLoginManager();
                this._startAnimation();
                console.log(`[LockScreen] ${this._lockscreenPerMonitor ? this._lockPipelines.length + ' per-monitor' : 'shared'} pipeline(s) initialized and playing`);
            } catch (e) {
                console.error(`[LockScreen] Failed to start pipelines: ${e.message}\n${e.stack}`);
            }
        }
    }

    _startAnimation() {
        this._actors.forEach(actor => actor.ease({
            opacity: 255,
            duration: this._fadeInDuration,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
        }))
    }

    _initLoginManager() {
        this._loginManager = LoginManager.getLoginManager();
        this._sleepId = this._loginManager.connect('prepare-for-sleep', (manager, aboutToSleep) => {
            // Handle shared pipeline
            if (this._pipeline) {
            aboutToSleep ? this._pipeline.pause() : this._pipeline.play();
            }
            // Handle per-monitor pipelines
            if (this._lockPipelines) {
                this._lockPipelines.forEach(p => {
                    aboutToSleep ? p.pause() : p.play();
                });
            }
        });
    }

    _initPipeline() {
        if (!this._pipeline.is_initialized()) {
            if (this._pipeline.init()) {
                this._pipeline.play()
            }
        }
    }

    _selectNextVideo() {
        if (!this._videoPaths || this._videoPaths.length === 0) {
            return null;
        }
        
        // If only one video, return it
        if (this._videoPaths.length === 1) {
            this._currentVideoIndex = 0;
            return this._videoPaths[0];
        }
        
        // Check if random order is enabled
        if (this._randomOrder) {
            // Select a random video different from the current one
            let newIndex;
            do {
                newIndex = Math.floor(Math.random() * this._videoPaths.length);
            } while (newIndex === this._currentVideoIndex && this._videoPaths.length > 1);
            
            this._currentVideoIndex = newIndex;
            return this._videoPaths[newIndex];
        } else {
            // Play in order
            this._currentVideoIndex = (this._currentVideoIndex + 1) % this._videoPaths.length;
            return this._videoPaths[this._currentVideoIndex];
        }
    }

    _discoverVideoProperties(videoPath) {
        try {
            let discoverer = new GstPbutils.Discoverer({ timeout: 1 * Gst.SECOND });
            let info = discoverer.discover_uri(GLib.filename_to_uri(videoPath, null));
            let videoStreams = info.get_video_streams();
            if (videoStreams.length > 0) {
                let stream = videoStreams[0];
                this.width = stream.get_width();
                this.height = stream.get_height();
                console.log('video size:', this.width, this.height);
            }
        } catch (e) {
            console.error('Failed to discover video properties:', e);
        }
    }

    _onVideoEnd() {
        // Select next video (random or sequential based on setting)
        const newVideoPath = this._selectNextVideo();
        if (!newVideoPath) {
            console.error('Failed to select new video');
            return;
        }
        
        console.log(`[LiveLockPaper] Switching to new video: ${newVideoPath}`);
        
        // Increment play count
        this._incrementPlayCount(newVideoPath);
        
        // Discover properties of new video
        this._discoverVideoProperties(newVideoPath);
        
        // Get framerate for new video (auto-detect if enabled)
        const newFramerate = this._getFramerateForVideo(newVideoPath);
        const autoFpsEnabled = this._settings.get_boolean(Keys.VIDEO_AUTO_FPS);
        console.log(`[LiveLockPaper] Using framerate: ${newFramerate} fps (auto-detect: ${autoFpsEnabled ? 'enabled' : 'disabled'})`);
        
        // Update current video path
        this._currentVideoPath = newVideoPath;
        
        // Change video in pipeline with new framerate
        if (this._pipeline) {
            this._pipeline.changeVideo(newVideoPath, newFramerate);
        }
    }

    // Handle EOS for one lock-screen monitor pipeline.
    _onLockMonitorVideoEnd(pipelineIndex) {
        const state = this._lockMonitorStates[pipelineIndex];
        if (!state) return;

        const newVideoPath = this._wpSelectNextVideoFor(state);
        if (!newVideoPath) return;

        console.log(`[LockScreen] Pipeline ${pipelineIndex} switching to: ${newVideoPath.split('/').pop()}`);

        const framerate = this._getFramerateForVideo(newVideoPath);
        this._incrementPlayCount(newVideoPath);

        if (this._lockPipelines && this._lockPipelines[pipelineIndex]) {
            this._lockPipelines[pipelineIndex].changeVideo(newVideoPath, framerate);
        }
    }

    _drawImages(data, width, height) {
        this._images.forEach(image => {
            setImageData(
                image,
                this._coglContext,
                data,
                Cogl.PixelFormat.BGRA_8888,
                width,
                height,
                width * 4
            )
        })
    }

    // Wallpaper

    // Check battery state via UPower.
    _isOnBattery() {
        try {
            const upower = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SYSTEM,
                Gio.DBusProxyFlags.NONE,
                null,
                'org.freedesktop.UPower',
                '/org/freedesktop/UPower',
                'org.freedesktop.UPower',
                null
            );
            return upower.get_cached_property('OnBattery')?.unpack() ?? false;
        } catch (e) {
            return false;
        }
    }

    _enableWallpaper() {
        if (!this._settings.get_boolean(Keys.WALLPAPER_ENABLED)) {
            // Keep watcher so enabling wallpaper applies live.
            this._wpSettingsIds = [];
            const enableId = this._settings.connect('changed::' + Keys.WALLPAPER_ENABLED, () => {
                this._scheduleWallpaperRestart();
            });
            this._wpSettingsIds.push(enableId);
            this._syncStatusIndicator();
            return;
        }

        // Optional battery guard.
        if (this._settings.get_boolean(Keys.DISABLE_ON_BATTERY) && this._isOnBattery()) {
            console.log('[Wallpaper] Skipping — device is on battery power');
            this._wpSettingsIds = [];
            const enableId = this._settings.connect('changed::' + Keys.WALLPAPER_ENABLED, () => {
                this._scheduleWallpaperRestart();
            });
            this._wpSettingsIds.push(enableId);
            this._syncStatusIndicator();
            return;
        }

        // GTK4 subprocess mode.
        if (this._shouldUseGtk4Sink()) {
            this._enableWallpaperSubprocess();
            return;
        }

        const perMonitor = this._settings.get_boolean(Keys.WALLPAPER_PER_MONITOR);
        const scalingMode = this._settings.get_int(Keys.WALLPAPER_SCALING_MODE);
        const blurRadius = this._settings.get_int(Keys.WALLPAPER_BLUR_RADIUS);
        const blurBrightness = this._settings.get_double(Keys.WALLPAPER_BLUR_BRIGHTNESS);
        const autoFps = this._settings.get_boolean(Keys.WALLPAPER_AUTO_FPS);
        const manualFramerate = this._settings.get_int(Keys.WALLPAPER_FRAMERATE);
        const loop = this._settings.get_boolean(Keys.WALLPAPER_LOOPED);
        const volume = this._settings.get_int(Keys.WALLPAPER_VOLUME) / 100;
        const fadeInDuration = this._settings.get_int(Keys.WALLPAPER_FADE_IN_DURATION);
        const skipFrame = this._settings.get_boolean(Keys.DEBUG_SKIP_FIRST_FRAME);
        const randomOrder = this._settings.get_boolean(Keys.WALLPAPER_RANDOM_ORDER);
        const preferHwDecoder = this._settings.get_boolean(Keys.DEBUG_PREFER_HW_DECODER);
        const gpuColorConversion = this._settings.get_boolean(Keys.DEBUG_GPU_COLOR_CONVERSION);
        const pauseWhenHidden = this._settings.get_boolean(Keys.DEBUG_PAUSE_WHEN_HIDDEN);
        const adaptivePolling = this._settings.get_boolean(Keys.DEBUG_PUSH_FRAME_DELIVERY);

        this._wpActors = [];
        this._wpImages = [];
        this._wpPipelines = [];
        this._wpMonitorStates = []; // For per-monitor playlist state

        const backend = Clutter.get_default_backend();
        this._wpCoglContext = backend.get_cogl_context();

        const themeContext = St.ThemeContext.get_for_stage(global.stage);
        const adjustedBlurRadius = blurRadius * themeContext.scale_factor;

        // Discover source dimensions with fallback.
        const discoverDimensions = (videoPath, fallbackW, fallbackH) => {
            try {
                const discoverer = new GstPbutils.Discoverer({ timeout: 1 * Gst.SECOND });
                const info = discoverer.discover_uri(GLib.filename_to_uri(videoPath, null));
                const streams = info.get_video_streams();
                if (streams.length > 0) {
                    return { width: streams[0].get_width(), height: streams[0].get_height() };
                }
            } catch (e) { }
            return { width: fallbackW, height: fallbackH };
        };

        const monitors = Main.layoutManager.monitors;

        // Wallpaper quality scales render resolution (25-100%).
        const qualityPct = this._settings.get_int(Keys.WALLPAPER_QUALITY);
        const WP_QUALITY = qualityPct / 100;

        if (perMonitor) {
            // Parse per-monitor config JSON.
            let config = {};
            try {
                config = JSON.parse(this._settings.get_string(Keys.WALLPAPER_PER_MONITOR_CONFIG));
            } catch (e) { config = {}; }

            console.log(`[Wallpaper] Per-monitor config keys: ${JSON.stringify(Object.keys(config))}`);

            // Map display index to connector name.
            const connectorMap = {};
            try {
                const monitorManager = global.backend.get_monitor_manager();
                const logicalMonitors = monitorManager.get_logical_monitors();
                for (const lm of logicalMonitors) {
                    const displayIdx = lm.get_number();
                    const metaMonitors = lm.get_monitors();
                    if (metaMonitors && metaMonitors.length > 0) {
                        connectorMap[displayIdx] = metaMonitors[0].get_connector();
                    }
                }
                console.log(`[Wallpaper] Connector map: ${JSON.stringify(connectorMap)}`);
            } catch (e) {
                console.log(`[Wallpaper] Failed to build connector map: ${e.message}`);
            }

            // Avoid duplicate initial picks across monitors.
            const usedInitialVideos = new Set();

            // Pre-count active monitors for timer staggering.
            const activeMonitorCount = monitors.filter((monitor, i) => {
                const conn = connectorMap[monitor.index] || connectorMap[i] || `Monitor-${i}`;
                return (config[conn] || []).filter(p => p && p.trim()).length > 0;
            }).length;

            monitors.forEach((monitor, i) => {
                const connector = connectorMap[monitor.index] || connectorMap[i] || `Monitor-${i}`;

                console.log(`[Wallpaper] Monitor ${i} (index=${monitor.index}): connector="${connector}", size=${monitor.width}x${monitor.height}`);

                const monitorPaths = (config[connector] || []).filter(p => {
                    if (!p || !p.trim()) return false;
                    if (!GLib.file_test(p, GLib.FileTest.EXISTS)) {
                        console.log(`[Wallpaper] Skipping missing video for ${connector}: ${p}`);
                        return false;
                    }
                    return true;
                });
                if (monitorPaths.length === 0) {
                    console.log(`[Wallpaper] No valid videos configured for "${connector}", skipping (config keys: ${Object.keys(config).join(', ')})`);
                    return;
                }

                const state = {
                    videoPaths: monitorPaths,
                    currentIndex: -1,
                    randomOrder: randomOrder,
                };

                const videoPath = this._selectUniqueInitialVideo(state, usedInitialVideos);
                if (!videoPath) return;
                usedInitialVideos.add(videoPath);

                const dims = discoverDimensions(videoPath, monitor.width, monitor.height);

                const { actor, container, image } = createActor({
                    monitor, video_width: dims.width, video_height: dims.height,
                    scaling_mode: scalingMode,
                });

                const mainActor = container || actor;
                if (adjustedBlurRadius > 0) {
                    mainActor.add_effect(new Shell.BlurEffect({
                        name: 'wallpaper-blur',
                        radius: adjustedBlurRadius,
                        brightness: blurBrightness,
                    }));
                }

                this._wpActors.push(mainActor);
                this._wpImages.push(image);

                Main.layoutManager._backgroundGroup.add_child(mainActor);
                Main.layoutManager._backgroundGroup.set_child_above_sibling(mainActor, null);

                // Each monitor has its own pipeline and EOS callback.
                const pipelineIndex = this._wpPipelines.length;
                const shouldLoop = loop && monitorPaths.length === 1;
                const tgtW = Math.round(monitor.width * WP_QUALITY);
                const tgtH = Math.round(monitor.height * WP_QUALITY);
                const framerate = this._getWallpaperFramerate(videoPath);
                const staggerMs = activeMonitorCount > 1
                    ? Math.round((1000 / framerate) / activeMonitorCount) * pipelineIndex
                    : 0;
                const pipeline = new Pipeline({
                    videoPath: videoPath,
                    volume: volume,
                    loop: shouldLoop,
                    framerate: framerate,
                    skipFrame: skipFrame,
                    targetWidth: tgtW,
                    targetHeight: tgtH,
                    timerPriority: GLib.PRIORITY_DEFAULT_IDLE,
                    preferHwDecoder: preferHwDecoder,
                    gpuColorConversion: gpuColorConversion,
                    adaptivePolling: adaptivePolling,
                    name: `wp-${connector}`,
                    timerDelay: staggerMs,
                    dataCallback: (data, w, h) => {
                        setImageData(image, this._wpCoglContext, data, Cogl.PixelFormat.BGRA_8888, w, h, w * 4);
                    },
                    onVideoEnd: monitorPaths.length > 1 ? () => {
                        this._onWallpaperMonitorVideoEnd(pipelineIndex);
                    } : null,
                });

                this._wpPipelines.push(pipeline);
                this._wpMonitorStates.push(state);

                if (fadeInDuration > 0) mainActor.opacity = 0;

                console.log(`[Wallpaper] ${connector} (${monitor.width}x${monitor.height} → ${tgtW}x${tgtH}): ${monitorPaths.length} video(s), starting with ${videoPath.split('/').pop()}`);
            });
        } else {
            // Shared wallpaper-video-paths mode.
            let wpVideoPaths = [];
            try {
                wpVideoPaths = this._settings.get_strv(Keys.WALLPAPER_VIDEO_PATHS);
                if (!wpVideoPaths || !Array.isArray(wpVideoPaths)) wpVideoPaths = [];
            } catch (e) { wpVideoPaths = []; }
            wpVideoPaths = wpVideoPaths.filter(p => {
                if (!p || !p.trim()) return false;
                if (!GLib.file_test(p, GLib.FileTest.EXISTS)) {
                    console.log(`[Wallpaper] Skipping missing video: ${p}`);
                    return false;
                }
                return true;
            });

            if (wpVideoPaths.length === 0) {
                console.log('[Wallpaper] No valid videos for wallpaper');
                this._setupWallpaperSettingsWatch();
                this._syncStatusIndicator();
                return;
            }

            const state = {
                videoPaths: wpVideoPaths,
                currentIndex: -1,
                randomOrder: randomOrder,
            };
            this._wpMonitorStates.push(state);

            const videoPath = this._wpSelectNextVideoFor(state);
            if (!videoPath) {
                this._setupWallpaperSettingsWatch();
                return;
            }

            const dims = discoverDimensions(videoPath, 1920, 1080);

            monitors.forEach((monitor) => {
                const { actor, container, image } = createActor({
                    monitor, video_width: dims.width, video_height: dims.height,
                    scaling_mode: scalingMode,
                });

                const mainActor = container || actor;
                if (adjustedBlurRadius > 0) {
                    mainActor.add_effect(new Shell.BlurEffect({
                        name: 'wallpaper-blur',
                        radius: adjustedBlurRadius,
                        brightness: blurBrightness,
                    }));
                }

                this._wpActors.push(mainActor);
                this._wpImages.push(image);

                Main.layoutManager._backgroundGroup.add_child(mainActor);
                Main.layoutManager._backgroundGroup.set_child_above_sibling(mainActor, null);

                if (fadeInDuration > 0) mainActor.opacity = 0;
            });

            // Shared pipeline targets largest monitor at quality scale.
            const maxW = Math.round(Math.max(...monitors.map(m => m.width)) * WP_QUALITY);
            const maxH = Math.round(Math.max(...monitors.map(m => m.height)) * WP_QUALITY);
            const pipeline = new Pipeline({
                videoPath: videoPath,
                volume: volume,
                loop: loop && wpVideoPaths.length === 1,
                framerate: this._getWallpaperFramerate(videoPath),
                skipFrame: skipFrame,
                targetWidth: maxW,
                targetHeight: maxH,
                timerPriority: GLib.PRIORITY_DEFAULT_IDLE,
                preferHwDecoder: preferHwDecoder,
                gpuColorConversion: gpuColorConversion,
                adaptivePolling: adaptivePolling,
                name: 'wp-shared',
                dataCallback: (data, w, h) => {
                    this._wpImages.forEach(img => {
                        setImageData(img, this._wpCoglContext, data, Cogl.PixelFormat.BGRA_8888, w, h, w * 4);
                    });
                },
                onVideoEnd: wpVideoPaths.length > 1 ? () => {
                    this._onWallpaperMonitorVideoEnd(0);
                } : null,
            });

            this._wpPipelines.push(pipeline);
            console.log(`[Wallpaper] All monitors: ${wpVideoPaths.length} video(s), target ${maxW}x${maxH}, starting with ${videoPath.split('/').pop()}`);
        }

        // Initialize and start all pipelines
        this._wpPipelines.forEach(p => {
            if (p.init()) p.play();
        });

        // Fade in
        if (fadeInDuration > 0) {
            this._wpActors.forEach(a => a.ease({
                opacity: 255,
                duration: fadeInDuration,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
            }));
        }

        console.log(`[Wallpaper] Started with ${this._wpPipelines.length} pipeline(s) on ${monitors.length} monitor(s)`);

        // Set up pause-when-hidden if enabled
        if (pauseWhenHidden) {
            this._setupPauseWhenHidden();
        }

        // Watch for settings changes to live-reload
        this._setupWallpaperSettingsWatch();
        this._syncStatusIndicator();
    }

    // Subprocess wallpaper (gtk4paintablesink)

    _enableWallpaperSubprocess() {
        console.log('[Wallpaper:GTK4] Setting up subprocess wallpaper');

        this._wpActors = [];
        this._wpPlayerProcess = null;
        this._wpWindowActors = {};
        this._wpSubprocessMonitorVideos = [];

        const perMonitor = this._settings.get_boolean(Keys.WALLPAPER_PER_MONITOR);
        const scalingMode = this._settings.get_int(Keys.WALLPAPER_SCALING_MODE);
        const volume = this._settings.get_int(Keys.WALLPAPER_VOLUME) / 100;
        const framerate = this._settings.get_int(Keys.WALLPAPER_FRAMERATE);
        const qualityPct = this._settings.get_int(Keys.WALLPAPER_QUALITY);
        const renderScale = Math.max(0.25, Math.min(1.0, qualityPct / 100));
        const fadeInDuration = this._settings.get_int(Keys.WALLPAPER_FADE_IN_DURATION);
        const blurRadius = this._settings.get_int(Keys.WALLPAPER_BLUR_RADIUS);
        const blurBrightness = this._settings.get_double(Keys.WALLPAPER_BLUR_BRIGHTNESS);
        const pauseWhenHidden = this._settings.get_boolean(Keys.DEBUG_PAUSE_WHEN_HIDDEN);

        const monitors = Main.layoutManager.monitors;
        const subprocessMonitors = [];
        const randomOrder = this._settings.get_boolean(Keys.WALLPAPER_RANDOM_ORDER);

        // Get shared/fallback video paths
        let wpVideoPaths = [];
        try { wpVideoPaths = this._settings.get_strv(Keys.WALLPAPER_VIDEO_PATHS); }
        catch (e) { wpVideoPaths = []; }
        wpVideoPaths = (wpVideoPaths || []).filter(p => p && p.trim() && GLib.file_test(p, GLib.FileTest.EXISTS));

        if (perMonitor) {
            let config = {};
            try { config = JSON.parse(this._settings.get_string(Keys.WALLPAPER_PER_MONITOR_CONFIG)); }
            catch (e) { config = {}; }

            const connectorMap = {};
            try {
                const mm = global.backend.get_monitor_manager();
                for (const lm of mm.get_logical_monitors()) {
                    const metas = lm.get_monitors();
                    if (metas?.length > 0) connectorMap[lm.get_number()] = metas[0].get_connector();
                }
            } catch (e) {}

            for (let i = 0; i < monitors.length; i++) {
                const conn = connectorMap[monitors[i].index] || connectorMap[i] || `Monitor-${i}`;
                const rawPaths = config[conn] || config[`Monitor-${i}`] || config[String(i)] || [];
                let paths = rawPaths.filter(p => p && p.trim() && GLib.file_test(p, GLib.FileTest.EXISTS));
                // Always push an entry; fallback to shared videos.
                if (paths.length === 0) paths = wpVideoPaths;
                subprocessMonitors.push({
                    videos: paths,
                    width: monitors[i].width,
                    height: monitors[i].height,
                });
            }
        } else {
            if (wpVideoPaths.length > 0) {
                let maxW = 0;
                let maxH = 0;
                for (const m of monitors) {
                    if (m.width > maxW) maxW = m.width;
                    if (m.height > maxH) maxH = m.height;
                }
                subprocessMonitors.push({ videos: wpVideoPaths, width: maxW, height: maxH });
            }
        }

        if (subprocessMonitors.length === 0) {
            console.log('[Wallpaper:GTK4] No valid videos configured');
            this._setupWallpaperSettingsWatch();
            this._syncStatusIndicator();
            return;
        }
        this._wpSubprocessMonitorVideos = subprocessMonitors.map(m => m.videos || []);

        const playerConfig = {
            scalingMode,
            volume,
            useVideorate: false,
            framerate,
            renderScale,
            randomOrder,
            monitors: subprocessMonitors,
        };

        this._wpPlayerProcess = new PlayerProcess({
            playerPath: this.path + '/external/run.js',
            config: playerConfig,
        });

        try {
            this._wpPlayerProcess.run();
        } catch (e) {
            console.error(`[Wallpaper:GTK4] Failed to spawn player: ${e.message}`);
            this._wpPlayerProcess = null;
            this._setupWallpaperSettingsWatch();
            return;
        }

        const monitorCount = monitors.length;
        this._wpPlayerProcess.waitForWindows(monitorCount, 10000, (windows) => {
            console.log(`[Wallpaper:GTK4] All ${windows.length} window(s) mapped`);

            const themeContext = St.ThemeContext.get_for_stage(global.stage);
            const adjustedBlurRadius = blurRadius * themeContext.scale_factor;
            this._wpPositionSignals = [];

            for (let i = 0; i < windows.length; i++) {
                const win = windows[i];
                const title = win.get_title() || '';
                const match = title.match(/^LiveLockPaper-(\d+)$/);
                const mappedMonitorIndex = match ? Number.parseInt(match[1], 10) : i;
                const targetMonitor = monitors[mappedMonitorIndex] || monitors[i] || monitors[0];
                if (targetMonitor) {
                    const enforceFrame = () => {
                        try {
                            win.move_resize_frame(
                                false,
                                targetMonitor.x,
                                targetMonitor.y,
                                targetMonitor.width,
                                targetMonitor.height
                            );
                        } catch (_) {
                            try { win.move_frame(false, targetMonitor.x, targetMonitor.y); } catch (_) {}
                        }
                    };
                    enforceFrame();
                    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                        if (!this._wpPlayerProcess)
                            return GLib.SOURCE_REMOVE;
                        enforceFrame();
                        return GLib.SOURCE_REMOVE;
                    });
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 260, () => {
                        if (!this._wpPlayerProcess)
                            return GLib.SOURCE_REMOVE;
                        enforceFrame();
                        return GLib.SOURCE_REMOVE;
                    });
                }
                try { win.set_skip_taskbar(true); } catch (_) {
                    try { win.skip_taskbar = true; } catch (_) {}
                }
                try { win.set_skip_pager(true); } catch (_) {
                    try { win.skip_pager = true; } catch (_) {}
                }
                const windowActor = win.get_compositor_private();
                if (!windowActor) continue;

                this._wpWindowActors[mappedMonitorIndex] = windowActor;
                const parent = windowActor.get_parent();
                if (parent) parent.remove_child(windowActor);

                // Position the wrapper at the monitor's geometry.
                // Do NOT use win.make_fullscreen() — it moves the window
                // to Mutter's fullscreen layer (above the panel/dock) and
                // can cause the compositor to reclaim the actor.
                const monitor = monitors[mappedMonitorIndex] || monitors[i] || monitors[0];
                const wrapper = new Clutter.Actor({
                    x: monitor.x,
                    y: monitor.y,
                    width: monitor.width,
                    height: monitor.height,
                    clip_to_allocation: true,
                });

                if (adjustedBlurRadius > 0) {
                    wrapper.add_effect(new Shell.BlurEffect({
                        name: 'wallpaper-blur',
                        radius: adjustedBlurRadius,
                        brightness: blurBrightness,
                    }));
                }

                wrapper.add_child(windowActor);
                windowActor.reactive = false;

                // Translation-only fitting avoids resampling artifacts.
                const fixPositionAndScale = () => {
                    const ax = windowActor.x;
                    const ay = windowActor.y;
                    windowActor.set_translation(-Math.round(ax), -Math.round(ay), 0);
                    windowActor.set_pivot_point(0, 0);
                    windowActor.set_scale(1, 1);
                };
                let wpFixQueued = 0;
                const queueFixPositionAndScale = () => {
                    if (wpFixQueued)
                        return;
                    wpFixQueued = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                        wpFixQueued = 0;
                        if (!this._wpPlayerProcess)
                            return GLib.SOURCE_REMOVE;
                        fixPositionAndScale();
                        return GLib.SOURCE_REMOVE;
                    });
                };
                const sigX = windowActor.connect('notify::x', queueFixPositionAndScale);
                const sigY = windowActor.connect('notify::y', queueFixPositionAndScale);
                const sigW = windowActor.connect('notify::width', queueFixPositionAndScale);
                const sigH = windowActor.connect('notify::height', queueFixPositionAndScale);
                this._wpPositionSignals.push({ actor: windowActor, ids: [sigX, sigY, sigW, sigH] });
                queueFixPositionAndScale();
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 260, () => {
                    if (!this._wpPlayerProcess)
                        return GLib.SOURCE_REMOVE;
                    fixPositionAndScale();
                    return GLib.SOURCE_REMOVE;
                });

                if (fadeInDuration > 0) wrapper.opacity = 0;

                Main.layoutManager._backgroundGroup.add_child(wrapper);
                Main.layoutManager._backgroundGroup.set_child_above_sibling(wrapper, null);

                this._wpActors.push(wrapper);
            }
            // Re-assert helper hints after map/reparent. Some shell/dock setups
            // appear to drop these around lock/unlock transitions.
            this._refreshGtkHelperWindowHints('wallpaper-map');

            // Fade in
            if (fadeInDuration > 0) {
                this._wpActors.forEach(a => a.ease({
                    opacity: 255,
                    duration: fadeInDuration,
                    mode: Clutter.AnimationMode.EASE_IN_QUAD,
                }));
            }

            this._wpPlayerProcess.play();
            console.log(`[Wallpaper:GTK4] ${this._wpActors.length} window(s) reparented and playing`);

            // Set up pause-when-hidden if enabled
            if (pauseWhenHidden) {
                this._setupPauseWhenHiddenSubprocess();
            }
            this._syncStatusIndicator();
        }, (err) => {
            console.error(`[Wallpaper:GTK4] ${err}`);
            this._syncStatusIndicator();
        });

        this._setupWallpaperSettingsWatch();
    }

    // Pause-when-hidden watchers for subprocess wallpaper.
    _setupPauseWhenHiddenSubprocess() {
        this._wpDesktopHidden = false;

        this._wpRestackedId = global.display.connect('restacked', () => {
            this._checkDesktopVisibilitySubprocess();
        });

        this._wpOverviewShowingId = Main.overview.connect('showing', () => {
            if (this._wpDesktopHidden) {
                this._wpDesktopHidden = false;
                this._wpPlayerProcess?.play();
                console.log('[Wallpaper:GTK4] Desktop visible (overview opened), resuming');
            }
        });

        this._wpOverviewHiddenId = Main.overview.connect('hidden', () => {
            this._checkDesktopVisibilitySubprocess();
        });

        console.log('[Wallpaper:GTK4] Pause-when-hidden: ✓ enabled');
    }

    _checkDesktopVisibilitySubprocess() {
        if (Main.sessionMode.currentMode !== 'user') return;
        if (!this._wpPlayerProcess) return;
        if (this._wallpaperWasPaused) return;
        if (this._manualWallpaperPaused) return;

        if (Main.overview.visible) {
            if (this._wpDesktopHidden) {
                this._wpDesktopHidden = false;
                this._wpPlayerProcess.play();
            }
            return;
        }

        const monitors = Main.layoutManager.monitors;
        const allCovered = monitors.every(m => this._isMonitorFullyCovered(m.index));

        if (allCovered && !this._wpDesktopHidden) {
            this._wpDesktopHidden = true;
            this._wpPlayerProcess.pause();
            console.log(`[Wallpaper:GTK4] Desktop fully covered, pausing`);
        } else if (!allCovered && this._wpDesktopHidden) {
            this._wpDesktopHidden = false;
            this._wpPlayerProcess.play();
            console.log(`[Wallpaper:GTK4] Desktop visible again, resuming`);
        }
    }

    // Watch wallpaper settings and trigger debounced restart.
    _setupWallpaperSettingsWatch() {
        // Disconnect any existing watchers first (fixes toggle bug where only
        // the WALLPAPER_ENABLED watcher was active after first enable)
        if (this._wpSettingsIds && this._wpSettingsIds.length > 0 && this._settings) {
            this._wpSettingsIds.forEach(id => {
                try { this._settings.disconnect(id); } catch (e) { }
            });
        }
        this._wpSettingsIds = [];
        const watchKeys = [
            Keys.WALLPAPER_ENABLED, Keys.WALLPAPER_VIDEO_PATHS,
            Keys.WALLPAPER_PER_MONITOR, Keys.WALLPAPER_PER_MONITOR_CONFIG,
            Keys.WALLPAPER_SCALING_MODE, Keys.WALLPAPER_BLUR_RADIUS,
            Keys.WALLPAPER_BLUR_BRIGHTNESS, Keys.WALLPAPER_AUTO_FPS,
            Keys.WALLPAPER_FRAMERATE, Keys.WALLPAPER_LOOPED,
            Keys.WALLPAPER_VOLUME, Keys.WALLPAPER_RANDOM_ORDER,
            Keys.WALLPAPER_FADE_IN_DURATION, Keys.WALLPAPER_QUALITY,
            Keys.DEBUG_PREFER_HW_DECODER, Keys.DEBUG_GPU_COLOR_CONVERSION,
            Keys.DEBUG_PAUSE_WHEN_HIDDEN, Keys.DEBUG_PUSH_FRAME_DELIVERY,
            Keys.DEBUG_USE_GTK4_SINK, Keys.DISABLE_ON_BATTERY,
        ];
        watchKeys.forEach(key => {
            const id = this._settings.connect('changed::' + key, () => {
                this._scheduleWallpaperRestart();
            });
            this._wpSettingsIds.push(id);
        });
    }

    // Debounced wallpaper restart.
    _scheduleWallpaperRestart() {
        if (this._wpRestartTimeout) {
            GLib.Source.remove(this._wpRestartTimeout);
        }
        this._wpRestartTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._wpRestartTimeout = null;
            try {
                console.log('[Wallpaper] Settings changed, restarting wallpaper...');
                this._teardownWallpaper();
                this._enableWallpaper();
            } catch (e) {
                console.error(`[Wallpaper] Restart failed: ${e.message}\n${e.stack}`);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    // Tear down wallpaper runtime without touching settings watchers.
    _teardownWallpaper() {
        if (this._wpRestartTimeout) {
            GLib.Source.remove(this._wpRestartTimeout);
            this._wpRestartTimeout = null;
        }
        // Clean up pause-when-hidden watchers
        this._cleanupPauseWhenHidden();

        // Subprocess player cleanup
        if (this._wpPlayerProcess) {
            // Disconnect position/scale watchers
            if (this._wpPositionSignals) {
                for (const { actor, ids } of this._wpPositionSignals) {
                    for (const id of ids) {
                        try { actor.disconnect(id); } catch (_) {}
                    }
                }
                this._wpPositionSignals = [];
            }
            // Return window actors to window_group
            for (const windowActor of Object.values(this._wpWindowActors || {})) {
                try {
                    windowActor.set_translation(0, 0, 0);
                    windowActor.set_scale(1, 1);
                    const parent = windowActor.get_parent();
                    if (parent) parent.remove_child(windowActor);
                    global.window_group.add_child(windowActor);
                    windowActor.hide();
                } catch (e) {}
            }
            this._wpWindowActors = {};
            this._wpPlayerProcess.destroy();
            this._wpPlayerProcess = null;
        }

        if (this._wpPipelines) {
            this._wpPipelines.forEach(p => p.destroy());
            this._wpPipelines = [];
        }
        this._wpCoglContext = null;
        this._wpMonitorStates = [];
        if (this._wpActors) {
            this._wpActors.forEach(a => {
                try { a.remove_effect_by_name('wallpaper-blur'); } catch (e) { }
                a.destroy();
            });
            this._wpActors = [];
        }
        if (this._wpImages) {
            this._wpImages = [];
        }
        this._wpSubprocessMonitorVideos = [];
        this._syncStatusIndicator();
    }

    // Pause-when-hidden

    // Set up visibility watchers.
    _setupPauseWhenHidden() {
        this._wpDesktopHidden = false;

        // Watch for window stacking changes
        this._wpRestackedId = global.display.connect('restacked', () => {
            this._checkDesktopVisibility();
        });

        // Watch for overview — desktop is visible during overview
        this._wpOverviewShowingId = Main.overview.connect('showing', () => {
            if (this._wpDesktopHidden) {
                this._wpDesktopHidden = false;
                if (this._wpPipelines && this._wpPipelines.length > 0) {
                    this._wpPipelines.forEach(p => p.play());
                    console.log('[Wallpaper] Desktop visible (overview opened), resuming');
                }
            }
        });

        this._wpOverviewHiddenId = Main.overview.connect('hidden', () => {
            this._checkDesktopVisibility();
        });

        console.log('[Wallpaper] Pause-when-hidden: ✓ enabled');
    }

    // Pause/resume when desktop becomes hidden/visible.
    _checkDesktopVisibility() {
        // Don't interfere when lock screen is active or during transitions
        if (Main.sessionMode.currentMode !== 'user') return;
        if (!this._wpPipelines || this._wpPipelines.length === 0) return;
        if (this._wallpaperWasPaused) return; // Paused for lock — don't interfere
        if (this._manualWallpaperPaused) return;

        // If overview is open, desktop is visible
        if (Main.overview.visible) {
            if (this._wpDesktopHidden) {
                this._wpDesktopHidden = false;
                this._wpPipelines.forEach(p => p.play());
                console.log('[Wallpaper] Desktop visible (overview), resuming');
            }
            return;
        }

        const monitors = Main.layoutManager.monitors;
        const allCovered = monitors.every((monitor) => {
            return this._isMonitorFullyCovered(monitor.index);
        });

        if (allCovered && !this._wpDesktopHidden) {
            this._wpDesktopHidden = true;
            this._wpPipelines.forEach(p => p.pause());
            console.log(`[Wallpaper] Desktop fully covered (${monitors.length} monitor(s)), pausing ${this._wpPipelines.length} pipeline(s)`);
        } else if (!allCovered && this._wpDesktopHidden) {
            this._wpDesktopHidden = false;
            this._wpPipelines.forEach(p => p.play());
            console.log(`[Wallpaper] Desktop visible again, resuming ${this._wpPipelines.length} pipeline(s)`);
        }
    }

    // Return true when a monitor is fully covered by a normal window.
    _isMonitorFullyCovered(monitorIndex) {
        try {
            const windowActors = global.get_window_actors();
            const wpPid = this._wpPlayerProcess?.pid ?? null;
            const lockPid = this._lockPlayerProcess?.pid ?? null;
            for (const wa of windowActors) {
                // Window actors can be disposed during compositor transitions
                // (lock screen, overview, etc.) — guard every access.
                let win;
                try { win = wa.meta_window; } catch (e) { continue; }
                if (!win || win.minimized) continue;
                // Ignore our own helper GTK windows, otherwise pause-when-hidden
                // sees the desktop as permanently covered and pauses forever.
                const pid = win.get_pid?.() ?? 0;
                if ((wpPid && pid === wpPid) || (lockPid && pid === lockPid))
                    continue;
                // Also ignore helper windows by title in case PID filtering races
                // during lock/unlock teardown (PID can be gone before actor cleanup).
                const title = win.get_title?.() ?? '';
                if (title.startsWith('LiveLockPaper-'))
                    continue;
                if (win.get_monitor() !== monitorIndex) continue;
                if (win.window_type !== Meta.WindowType.NORMAL) continue;
                if (win.is_fullscreen() || (win.maximized_horizontally && win.maximized_vertically)) {
                    return true;
                }
            }
        } catch (e) {
            // Silently fail — better to resume playback than crash
        }
        return false;
    }

    _refreshGtkHelperWindowHints(reason = 'unspecified') {
        try {
            const windowActors = global.get_window_actors();
            const wpPid = this._wpPlayerProcess?.pid ?? null;
            const lockPid = this._lockPlayerProcess?.pid ?? null;
            const primaryMonitor = Main.layoutManager?.primaryMonitor ?? null;
            for (const wa of windowActors) {
                let win;
                try { win = wa.meta_window; } catch (e) { continue; }
                if (!win)
                    continue;
                const title = win.get_title?.() ?? '';
                const pid = win.get_pid?.() ?? 0;
                const isHelperByTitle = title.startsWith('LiveLockPaper-');
                const isHelperByPid = (wpPid && pid === wpPid) || (lockPid && pid === lockPid);
                if (!isHelperByTitle && !isHelperByPid)
                    continue;

                try { win.set_skip_taskbar(true); } catch (_) {
                    try { win.skip_taskbar = true; } catch (_) {}
                }
                try { win.set_skip_pager(true); } catch (_) {
                    try { win.skip_pager = true; } catch (_) {}
                }
                // Keep wallpaper helper MetaWindows associated with primary monitor.
                // We render detached actors into per-monitor wrappers, so monitor
                // assignment for the hidden helper windows is only for WM/dock logic.
                if (primaryMonitor && wpPid && pid === wpPid) {
                    try { win.move_frame(false, primaryMonitor.x, primaryMonitor.y); } catch (_) {}
                }

                const verboseHelperLogs = this._settings?.get_boolean?.(Keys.DEBUG_GTK_HELPER_LOGS) ?? false;
                if (verboseHelperLogs) {
                    console.log(
                        `[Wallpaper:GTK4] helper-hints(${reason}) title="${title}" monitor=${win.get_monitor?.()} ` +
                        `type=${win.window_type} fullscreen=${win.is_fullscreen?.()} ` +
                        `max=${win.maximized_horizontally && win.maximized_vertically} ` +
                        `skip_taskbar=${win.skip_taskbar} skip_pager=${win.skip_pager}`
                    );
                }
            }
        } catch (e) {}
    }

    // Disconnect pause-when-hidden handlers.
    _cleanupPauseWhenHidden() {
        if (this._wpRestackedId) {
            global.display.disconnect(this._wpRestackedId);
            this._wpRestackedId = null;
        }
        if (this._wpOverviewShowingId) {
            Main.overview.disconnect(this._wpOverviewShowingId);
            this._wpOverviewShowingId = null;
        }
        if (this._wpOverviewHiddenId) {
            Main.overview.disconnect(this._wpOverviewHiddenId);
            this._wpOverviewHiddenId = null;
        }
        this._wpDesktopHidden = false;
    }

    // Pause wallpaper runtime during lock.
    _pauseWallpaper() {
        // Cancel any pending settings-change restart — otherwise it may fire
        // DURING the lock screen setup and create duplicate pipelines or race.
        if (this._wpRestartTimeout) {
            GLib.Source.remove(this._wpRestartTimeout);
            this._wpRestartTimeout = null;
            console.log('[Wallpaper] Cancelled pending restart (locking)');
        }
        if (this._wpPipelines && this._wpPipelines.length > 0) {
            console.log(`[Wallpaper] Pausing ${this._wpPipelines.length} pipeline(s)`);
            this._wpPipelines.forEach(p => p.pause());
            this._wallpaperWasPaused = true;
        }
        // Subprocess mode
        if (this._wpPlayerProcess) {
            console.log('[Wallpaper:GTK4] Pausing subprocess');
            this._wpPlayerProcess.pause();
            this._wallpaperWasPaused = true;
        }
        this._syncStatusIndicator();
    }

    // Resume wallpaper after unlock, or re-enable if needed.
    _resumeWallpaper() {
        const hasPipelines = this._wpPipelines && this._wpPipelines.length > 0;
        const hasSubprocess = !!this._wpPlayerProcess;

        if (this._manualWallpaperPaused) {
            this._syncStatusIndicator();
            return;
        }

        if (this._wallpaperWasPaused && (hasPipelines || hasSubprocess)) {
            if (hasPipelines) {
                console.log(`[Wallpaper] Resuming ${this._wpPipelines.length} pipeline(s)`);
                this._wpPipelines.forEach(p => p.play());
            }
            if (hasSubprocess) {
                console.log('[Wallpaper:GTK4] Resuming subprocess');
                this._wpPlayerProcess.play();
                this._refreshGtkHelperWindowHints('resume-immediate');
            }
            this._wallpaperWasPaused = false;
            this._wpDesktopHidden = false;
            // Re-check visibility after a short delay.
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                if (hasPipelines) this._checkDesktopVisibility();
                if (hasSubprocess) {
                    this._refreshGtkHelperWindowHints('resume-200ms');
                    this._checkDesktopVisibilitySubprocess();
                }
                return GLib.SOURCE_REMOVE;
            });
            // Run one extra check + play nudge after lockscreen teardown settles.
            // This avoids a stuck-paused state when transient unlock windows
            // briefly trip the coverage check.
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 900, () => {
                if (Main.sessionMode.currentMode !== 'user')
                    return GLib.SOURCE_REMOVE;
                if (hasSubprocess && this._wpPlayerProcess) {
                    this._wpPlayerProcess.play();
                    this._refreshGtkHelperWindowHints('resume-900ms');
                    this._checkDesktopVisibilitySubprocess();
                }
                if (hasPipelines && this._wpPipelines?.length > 0) {
                    this._wpPipelines.forEach(p => p.play());
                    this._checkDesktopVisibility();
                }
                this._syncStatusIndicator();
                return GLib.SOURCE_REMOVE;
            });
            this._syncStatusIndicator();
        } else {
            // If pipelines are missing, do a full enable.
            this._enableWallpaper();
        }
    }

    _disableWallpaper() {
        this._wallpaperWasPaused = false;
        this._manualWallpaperPaused = false;
        // Disconnect settings watchers
        if (this._wpSettingsIds && this._settings) {
            this._wpSettingsIds.forEach(id => {
                try { this._settings.disconnect(id); } catch (e) { }
            });
            this._wpSettingsIds = [];
        }
        this._teardownWallpaper();
    }

    _getWallpaperFramerate(videoPath) {
        const autoFps = this._settings?.get_boolean(Keys.WALLPAPER_AUTO_FPS) ?? false;
        const manualFramerate = this._settings?.get_int(Keys.WALLPAPER_FRAMERATE) ?? 25;
        if (!autoFps) return manualFramerate;
        try {
            const metadata = this._settings.get_value(Keys.WALLPAPER_VIDEO_METADATA).recursiveUnpack();
            if (metadata && metadata[videoPath]) {
                const meta = metadata[videoPath];
                let fps = null;
                if (meta.fps) {
                    if (typeof meta.fps === 'object' && meta.fps.get_int32) {
                        fps = meta.fps.get_int32();
                    } else if (typeof meta.fps === 'number') {
                        fps = meta.fps;
                    }
                }
                if (fps && fps > 0) return fps;
            }
        } catch (e) { }
        return manualFramerate;
    }

    // Select the next item from a playlist state.
    _wpSelectNextVideoFor(state) {
        if (!state.videoPaths || state.videoPaths.length === 0) return null;
        if (state.videoPaths.length === 1) {
            state.currentIndex = 0;
            return state.videoPaths[0];
        }
        if (state.randomOrder) {
            let newIndex;
            do {
                newIndex = Math.floor(Math.random() * state.videoPaths.length);
            } while (newIndex === state.currentIndex && state.videoPaths.length > 1);
            state.currentIndex = newIndex;
            return state.videoPaths[newIndex];
        } else {
            state.currentIndex = (state.currentIndex + 1) % state.videoPaths.length;
            return state.videoPaths[state.currentIndex];
        }
    }

    // Pick initial per-monitor video and avoid duplicates when possible.
    _selectUniqueInitialVideo(state, usedVideos) {
        if (!state.videoPaths || state.videoPaths.length === 0) return null;
        if (state.videoPaths.length === 1) {
            state.currentIndex = 0;
            return state.videoPaths[0];
        }

        // Try unused videos first.
        const available = state.videoPaths
            .map((p, idx) => ({ path: p, idx }))
            .filter(v => !usedVideos.has(v.path));

        if (available.length > 0) {
            const pick = state.randomOrder
                ? available[Math.floor(Math.random() * available.length)]
                : available[0];
            state.currentIndex = pick.idx;
            return pick.path;
        }

        // All videos already used elsewhere; overlap is unavoidable.
        return this._wpSelectNextVideoFor(state);
    }

    // Handle EOS for wallpaper pipeline index.
    _onWallpaperMonitorVideoEnd(pipelineIndex) {
        const state = this._wpMonitorStates[pipelineIndex];
        if (!state) return;

        const newVideoPath = this._wpSelectNextVideoFor(state);
        if (!newVideoPath) return;

        console.log(`[Wallpaper] Pipeline ${pipelineIndex} switching to: ${newVideoPath.split('/').pop()}`);

        const framerate = this._getWallpaperFramerate(newVideoPath);

        if (this._wpPipelines && this._wpPipelines[pipelineIndex]) {
            this._wpPipelines[pipelineIndex].changeVideo(newVideoPath, framerate);
        }
    }
}
