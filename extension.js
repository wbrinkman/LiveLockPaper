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

import { Keys, PauseWhenHiddenMode } from "./enums.js";
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

        // Defer teardown — if enable() is called within 350ms, cancel teardown
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
            console.log('[LiveLockPaper] diagnostics build active: snapshot-v1');

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
            this._syncKeepAwakeHooks();
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
            if (!this._lockTextSettingIds) {
                this._lockTextSettingIds = [];
                const textKeys = [
                    Keys.LOCKSCREEN_TEXT_CUSTOMIZE_ENABLED,
                    Keys.LOCKSCREEN_TEXT_HIDE_CMD,
                    Keys.LOCKSCREEN_TEXT_HIDE_TIME,
                    Keys.LOCKSCREEN_TEXT_HIDE_DATE,
                    Keys.LOCKSCREEN_TEXT_HIDE_HINT,
                    Keys.LOCKSCREEN_TEXT_CMD_SIZE,
                    Keys.LOCKSCREEN_TEXT_TIME_SIZE,
                    Keys.LOCKSCREEN_TEXT_DATE_SIZE,
                    Keys.LOCKSCREEN_TEXT_HINT_SIZE,
                    Keys.LOCKSCREEN_TEXT_CMD_COLOR,
                    Keys.LOCKSCREEN_TEXT_TIME_COLOR,
                    Keys.LOCKSCREEN_TEXT_DATE_COLOR,
                    Keys.LOCKSCREEN_TEXT_HINT_COLOR,
                    Keys.LOCKSCREEN_TEXT_CMD_FONT,
                    Keys.LOCKSCREEN_TEXT_TIME_FONT,
                    Keys.LOCKSCREEN_TEXT_DATE_FONT,
                    Keys.LOCKSCREEN_TEXT_HINT_FONT,
                    Keys.LOCKSCREEN_TEXT_CMD_WEIGHT,
                    Keys.LOCKSCREEN_TEXT_TIME_WEIGHT,
                    Keys.LOCKSCREEN_TEXT_DATE_WEIGHT,
                    Keys.LOCKSCREEN_TEXT_HINT_WEIGHT,
                    Keys.LOCKSCREEN_TEXT_CMD_STYLE,
                    Keys.LOCKSCREEN_TEXT_TIME_STYLE,
                    Keys.LOCKSCREEN_TEXT_DATE_STYLE,
                    Keys.LOCKSCREEN_TEXT_HINT_STYLE,
                    Keys.LOCKSCREEN_TEXT_CMD_COMMAND,
                    Keys.LOCKSCREEN_TEXT_TIME_FORMAT,
                    Keys.LOCKSCREEN_TEXT_DATE_FORMAT,
                    Keys.LOCKSCREEN_KEEP_AWAKE_ENABLED,
                    Keys.LOCKSCREEN_KEEP_AWAKE_TIMEOUT_SECONDS,
                    Keys.LOCKSCREEN_KEEP_AWAKE_ONLY_ON_AC,
                ];
                for (const key of textKeys) {
                    this._lockTextSettingIds.push(
                        this._settings.connect(`changed::${key}`, () => this._onLockTextSettingsChanged())
                    );
                }
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
            if (this._lockTextSettingIds && this._settings) {
                for (const id of this._lockTextSettingIds) {
                    try { this._settings.disconnect(id); } catch (_) {}
                }
                this._lockTextSettingIds = [];
            }
            this._removeKeepAwakeHooks();
            this._clearLockTextCommandState();
            this._stopAllPlayCountTracking();
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
            else {
                this._disableLockScreen();
                // Keep lockscreen text customization independent from lockscreen video enablement.
                this._applyLockscreenTextCustomization();
                this._restartKeepAwakeTimerIfNeeded();
            }
        } else if (mode === 'user') {
            // Desktop — tear down lock screen, resume wallpaper
            console.log('[LiveLockPaper] → tearing down lock screen, resuming wallpaper');
            this._currentActivatedMode = mode;
            this._disableLockScreen();
            this._clearKeepAwakeTimer();
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
        else {
            // Runtime lockscreen video disable should not disable text customization.
            this._applyLockscreenTextCustomization();
            this._restartKeepAwakeTimerIfNeeded();
        }
    }

    _onLockTextSettingsChanged() {
        this._syncKeepAwakeHooks();
        if (Main.sessionMode.currentMode !== 'unlock-dialog')
            return;
        this._applyLockscreenTextCustomization();
        this._restartKeepAwakeTimerIfNeeded();
    }

    _getLockscreenTextSettings() {
        return {
            enabled: this._settings.get_boolean(Keys.LOCKSCREEN_TEXT_CUSTOMIZE_ENABLED),
            hideCmd: this._settings.get_boolean(Keys.LOCKSCREEN_TEXT_HIDE_CMD),
            hideTime: this._settings.get_boolean(Keys.LOCKSCREEN_TEXT_HIDE_TIME),
            hideDate: this._settings.get_boolean(Keys.LOCKSCREEN_TEXT_HIDE_DATE),
            hideHint: this._settings.get_boolean(Keys.LOCKSCREEN_TEXT_HIDE_HINT),
            cmdSize: this._settings.get_int(Keys.LOCKSCREEN_TEXT_CMD_SIZE),
            timeSize: this._settings.get_int(Keys.LOCKSCREEN_TEXT_TIME_SIZE),
            dateSize: this._settings.get_int(Keys.LOCKSCREEN_TEXT_DATE_SIZE),
            hintSize: this._settings.get_int(Keys.LOCKSCREEN_TEXT_HINT_SIZE),
            cmdColor: this._settings.get_string(Keys.LOCKSCREEN_TEXT_CMD_COLOR),
            timeColor: this._settings.get_string(Keys.LOCKSCREEN_TEXT_TIME_COLOR),
            dateColor: this._settings.get_string(Keys.LOCKSCREEN_TEXT_DATE_COLOR),
            hintColor: this._settings.get_string(Keys.LOCKSCREEN_TEXT_HINT_COLOR),
            cmdFont: this._settings.get_string(Keys.LOCKSCREEN_TEXT_CMD_FONT).trim(),
            timeFont: this._settings.get_string(Keys.LOCKSCREEN_TEXT_TIME_FONT).trim(),
            dateFont: this._settings.get_string(Keys.LOCKSCREEN_TEXT_DATE_FONT).trim(),
            hintFont: this._settings.get_string(Keys.LOCKSCREEN_TEXT_HINT_FONT).trim(),
            cmdWeight: this._settings.get_string(Keys.LOCKSCREEN_TEXT_CMD_WEIGHT).trim(),
            timeWeight: this._settings.get_string(Keys.LOCKSCREEN_TEXT_TIME_WEIGHT).trim(),
            dateWeight: this._settings.get_string(Keys.LOCKSCREEN_TEXT_DATE_WEIGHT).trim(),
            hintWeight: this._settings.get_string(Keys.LOCKSCREEN_TEXT_HINT_WEIGHT).trim(),
            cmdStyle: this._settings.get_string(Keys.LOCKSCREEN_TEXT_CMD_STYLE).trim(),
            timeStyle: this._settings.get_string(Keys.LOCKSCREEN_TEXT_TIME_STYLE).trim(),
            dateStyle: this._settings.get_string(Keys.LOCKSCREEN_TEXT_DATE_STYLE).trim(),
            hintStyle: this._settings.get_string(Keys.LOCKSCREEN_TEXT_HINT_STYLE).trim(),
            cmdCommand: this._settings.get_string(Keys.LOCKSCREEN_TEXT_CMD_COMMAND).trim(),
            timeFormat: this._settings.get_string(Keys.LOCKSCREEN_TEXT_TIME_FORMAT).trim(),
            dateFormat: this._settings.get_string(Keys.LOCKSCREEN_TEXT_DATE_FORMAT).trim(),
        };
    }

    _findActorByStyleClass(root, className) {
        if (!root)
            return null;
        if (typeof root.has_style_class_name === 'function' && root.has_style_class_name(className))
            return root;
        if (typeof root.get_children !== 'function')
            return null;
        for (const child of root.get_children()) {
            const found = this._findActorByStyleClass(child, className);
            if (found)
                return found;
        }
        return null;
    }

    _ensureCmdOutputLabel(clock) {
        if (!clock)
            return null;
        if (this._lockTextCmdLabel && this._lockTextCmdLabel.get_parent()) {
            this._lockTextCmdLabel.remove_style_class_name?.('screen-shield-hint-label');
            this._lockTextCmdLabel.add_style_class_name?.('live-lockpaper-cmd-label');
            return this._lockTextCmdLabel;
        }

        const container = clock._box ?? clock;
        if (!container || typeof container.insert_child_at_index !== 'function')
            return null;

        const label = new St.Label({
            style_class: 'live-lockpaper-cmd-label',
            x_align: Clutter.ActorAlign.CENTER,
        });
        container.insert_child_at_index(label, 0);
        this._lockTextCmdLabel = label;
        return label;
    }

    _clearLockTextTimer() {
        if (this._lockTextRefreshId) {
            GLib.Source.remove(this._lockTextRefreshId);
            this._lockTextRefreshId = null;
        }
        this._clearLockTextLabelHooks();
    }

    _clearLockTextLabelHooks() {
        if (!this._lockTextLabelHookIds)
            return;
        for (const [label, id] of this._lockTextLabelHookIds) {
            try {
                if (label && id)
                    label.disconnect(id);
            } catch (_) {}
        }
        this._lockTextLabelHookIds = null;
    }

    _clearLockTextCommandState() {
        if (this._lockTextCommandTimeoutIds) {
            for (const id of this._lockTextCommandTimeoutIds.values())
                GLib.Source.remove(id);
            this._lockTextCommandTimeoutIds.clear();
        }
        this._lockTextPendingCommands?.clear();
        this._lockTextCommandState = {};
    }

    _formatNow(formatString, fallbackText) {
        if (!formatString)
            return fallbackText;
        try {
            return GLib.DateTime.new_now_local().format(formatString) ?? fallbackText;
        } catch (_) {
            return fallbackText;
        }
    }

    _buildLockTextStyle(sizePx, color, fontFamily, fontWeight, fontStyle) {
        const parts = [`font-size: ${sizePx}px`, `color: ${color}`];
        if (fontFamily)
            parts.push(`font-family: "${fontFamily.replace(/"/g, '\\"')}"`);
        if (fontWeight)
            parts.push(`font-weight: ${fontWeight}`);
        if (fontStyle)
            parts.push(`font-style: ${fontStyle}`);
        return `${parts.join('; ')};`;
    }

    _runLockTextCommand(kind, command, label, options = {}) {
        if (!command || !label)
            return;
        if (!this._lockTextPendingCommands)
            this._lockTextPendingCommands = new Set();
        if (!this._lockTextCommandTimeoutIds)
            this._lockTextCommandTimeoutIds = new Map();
        if (!this._lockTextCommandState)
            this._lockTextCommandState = {};
        if (!this._lockTextCommandState[kind])
            this._lockTextCommandState[kind] = {lastOutput: '', pauseUntilMs: 0, lastHour: -1};
        const state = this._lockTextCommandState[kind];
        
        // Check if hour changed - force refresh for time-sensitive commands
        const now = GLib.DateTime.new_now_local();
        const currentHour = now.get_hour();
        const hourChanged = state.lastHour !== -1 && state.lastHour !== currentHour;
        if (hourChanged)
            state.pauseUntilMs = 0; // Force refresh on hour change
        
        if (this._lockTextPendingCommands.has(kind)) {
            // If hour changed and command is running, cancel it to restart with new hour
            if (hourChanged && this._lockTextCommandTimeoutIds.has(kind)) {
                const timeoutId = this._lockTextCommandTimeoutIds.get(kind);
                GLib.Source.remove(timeoutId);
                this._lockTextCommandTimeoutIds.delete(kind);
                this._lockTextPendingCommands.delete(kind);
            } else {
                return;
            }
        }
        if ((options.pauseWhenUnchanged ?? false) && Date.now() < state.pauseUntilMs)
            return;
        this._lockTextPendingCommands.add(kind);

        try {
            const proc = Gio.Subprocess.new(
                ['/bin/sh', '-c', command],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
            const timeoutMs = Math.max(100, options.timeoutMs ?? 1500);
            const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
                try { proc.force_exit(); } catch (_) {}
                this._lockTextCommandTimeoutIds?.delete(kind);
                return GLib.SOURCE_REMOVE;
            });
            this._lockTextCommandTimeoutIds.set(kind, timeoutId);
            proc.communicate_utf8_async(null, null, (p, res) => {
                this._lockTextPendingCommands?.delete(kind);
                if (this._lockTextCommandTimeoutIds?.has(kind)) {
                    GLib.Source.remove(this._lockTextCommandTimeoutIds.get(kind));
                    this._lockTextCommandTimeoutIds.delete(kind);
                }
                try {
                    const [, stdout] = p.communicate_utf8_finish(res);
                    let output = stdout ?? '';
                    if (options.trimOutput ?? true)
                        output = output.trim();
                    if ((options.maxLength ?? 256) > 0 && output.length > options.maxLength)
                        output = output.slice(0, options.maxLength);

                    if ((options.pauseWhenUnchanged ?? false) && output === state.lastOutput) {
                        state.pauseUntilMs = Date.now() + Math.max(1, options.unchangedBackoffSeconds ?? 15) * 1000;
                    } else {
                        state.pauseUntilMs = 0;
                    }
                    state.lastOutput = output;
                    // Track current hour for detecting hour changes
                    const now = GLib.DateTime.new_now_local();
                    state.lastHour = now.get_hour();

                    if (Main.sessionMode.currentMode === 'unlock-dialog' && label.visible)
                        label.text = output;
                } catch (_) {}
            });
        } catch (_) {
            this._lockTextPendingCommands.delete(kind);
            if (this._lockTextCommandTimeoutIds?.has(kind)) {
                GLib.Source.remove(this._lockTextCommandTimeoutIds.get(kind));
                this._lockTextCommandTimeoutIds.delete(kind);
            }
        }
    }

    _applyLockscreenTextCustomization() {
        const dialog = Main.screenShield?._dialog;
        if (!dialog)
            return;

        const clock = dialog._clock ?? null;
        const timeLabel = clock?._time ?? this._findActorByStyleClass(dialog, 'screen-shield-clock-time');
        const dateLabel = clock?._date ?? this._findActorByStyleClass(dialog, 'screen-shield-clock-date');
        const cmdLabel = this._ensureCmdOutputLabel(clock);
        const hintLabel =
            this._findActorByStyleClass(dialog, 'screen-shield-hint-label')
            || this._findActorByStyleClass(dialog, 'screen-shield-hint-text')
            || this._findActorByStyleClass(dialog, 'screen-shield-hint')
            || (clock?._hint ?? null);

        if (!cmdLabel && !timeLabel && !dateLabel && !hintLabel)
            return;

        const cfg = this._getLockscreenTextSettings();

        if (!cfg.enabled) {
            if (cmdLabel) {
                cmdLabel.set_style('');
                cmdLabel.visible = false;
                cmdLabel.text = '';
            }
            if (timeLabel) timeLabel.set_style('');
            if (dateLabel) dateLabel.set_style('');
            if (hintLabel) {
                hintLabel.set_style('');
                hintLabel.visible = true;
            }
            this._clearLockTextTimer();
            this._clearLockTextCommandState();
            return;
        }

        if (cmdLabel) {
            cmdLabel.set_style(this._buildLockTextStyle(cfg.cmdSize, cfg.cmdColor, cfg.cmdFont, cfg.cmdWeight, cfg.cmdStyle));
            cmdLabel.visible = !cfg.hideCmd && cfg.cmdCommand.length > 0;
            if (!cfg.cmdCommand.length)
                cmdLabel.text = '';
        }
        if (timeLabel)
            timeLabel.set_style(this._buildLockTextStyle(cfg.timeSize, cfg.timeColor, cfg.timeFont, cfg.timeWeight, cfg.timeStyle));
        if (dateLabel)
            dateLabel.set_style(this._buildLockTextStyle(cfg.dateSize, cfg.dateColor, cfg.dateFont, cfg.dateWeight, cfg.dateStyle));
        if (timeLabel)
            timeLabel.visible = !cfg.hideTime;
        if (dateLabel)
            dateLabel.visible = !cfg.hideDate;
        if (hintLabel) {
            hintLabel.set_style(this._buildLockTextStyle(cfg.hintSize, cfg.hintColor, cfg.hintFont, cfg.hintWeight, cfg.hintStyle));
            hintLabel.visible = !cfg.hideHint;
        }

        const needsCustomFormat = cfg.timeFormat.length > 0 || cfg.dateFormat.length > 0;
        const needsCommandOutput = cfg.cmdCommand.length > 0;
        this._clearLockTextTimer();
        if (!needsCustomFormat && !needsCommandOutput)
            return;

        this._lockTextLabelHookIds = [];
        const attachFormatHook = (label, format) => {
            if (!label || !format)
                return;
            let applying = false;
            const id = label.connect('notify::text', () => {
                if (applying || Main.sessionMode.currentMode !== 'unlock-dialog')
                    return;
                const expected = this._formatNow(format, '');
                if (!expected || label.text === expected)
                    return;
                applying = true;
                label.text = expected;
                applying = false;
            });
            this._lockTextLabelHookIds.push([label, id]);
        };
        attachFormatHook(timeLabel, cfg.timeFormat);
        attachFormatHook(dateLabel, cfg.dateFormat);

        const refresh = () => {
            if (Main.sessionMode.currentMode !== 'unlock-dialog')
                return GLib.SOURCE_CONTINUE;
            // Always format with current time - never use fallback that might be missing seconds
            if (timeLabel && cfg.timeFormat) {
                const formatted = this._formatNow(cfg.timeFormat, '');
                if (formatted) timeLabel.text = formatted;
            }
            if (dateLabel && cfg.dateFormat) {
                const formatted = this._formatNow(cfg.dateFormat, '');
                if (formatted) dateLabel.text = formatted;
            }
            const cmdOptions = {
                timeoutMs: 1500,
                trimOutput: true,
                maxLength: 256,
                pauseWhenUnchanged: true,
                unchangedBackoffSeconds: 15,
            };
            if (cmdLabel && cfg.cmdCommand && cmdLabel.visible) {
                // Force refresh on minute 0 to catch hour changes immediately
                const now = GLib.DateTime.new_now_local();
                const currentMinute = now.get_minute();
                if (currentMinute === 0) {
                    // At top of hour, reduce pause to ensure we catch hour changes
                    cmdOptions.unchangedBackoffSeconds = 1;
                }
                this._runLockTextCommand('cmd', cfg.cmdCommand, cmdLabel, cmdOptions);
            }
            return GLib.SOURCE_CONTINUE;
        };
        
        // Keep a low-frequency refresh for command output/date rollover; label hooks handle immediate rewrites.
        refresh(); // Initial update
        this._lockTextRefreshId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, refresh);
    }

    _pokeLockscreen() {
        const shield = Main.screenShield;
        try {
            if (typeof shield?._wakeUpScreen === 'function')
                shield._wakeUpScreen();
            else if (typeof shield?.wakeUpScreen === 'function')
                shield.wakeUpScreen();
        } catch (_) {}
    }

    _isKeepAwakeEnabledNow() {
        if (!this._settings)
            return false;
        if (!this._settings.get_boolean(Keys.LOCKSCREEN_KEEP_AWAKE_ENABLED))
            return false;
        if (this._settings.get_boolean(Keys.LOCKSCREEN_KEEP_AWAKE_ONLY_ON_AC) && this._isOnBattery())
            return false;
        return true;
    }

    _syncKeepAwakeHooks() {
        if (this._isKeepAwakeEnabledNow())
            this._installKeepAwakeHooks();
        else
            this._removeKeepAwakeHooks();
    }

    _installKeepAwakeHooks() {
        if (this._keepAwakeHooksInstalled)
            return;

        const shield = Main.screenShield;
        if (!shield || typeof shield._setActive !== 'function')
            return;

        this._keepAwakeHooksInstalled = true;
        this._keepAwakeActiveOnce = false;
        this._screenShieldSetActiveOriginal = shield._setActive;
        shield._setActive = active => this._keepAwakeSetActive(shield, active);
    }

    _removeKeepAwakeHooks() {
        if (!this._keepAwakeHooksInstalled)
            return;

        const shield = Main.screenShield;
        if (shield && this._screenShieldSetActiveOriginal)
            shield._setActive = this._screenShieldSetActiveOriginal;

        this._screenShieldSetActiveOriginal = null;
        this._keepAwakeHooksInstalled = false;
        this._keepAwakeActiveOnce = false;
    }

    _keepAwakeSetActive(shield, active) {
        const wasActive = shield._isActive;
        shield._isActive = active;

        if (wasActive !== shield._isActive) {
            if (!this._isKeepAwakeEnabledNow() || this._keepAwakeActiveOnce) {
                shield.emit('active-changed');
                this._keepAwakeActiveOnce = false;
            }
        }

        if (active) {
            this._startKeepAwakeTimerIfNeeded();
        } else {
            this._clearKeepAwakeTimer();
        }

        if (shield._loginSession)
            shield._loginSession.SetLockedHintRemote(active);

        shield._syncInhibitor();
    }

    _clearKeepAwakeTimer() {
        if (this._lockKeepAwakePulseId) {
            GLib.Source.remove(this._lockKeepAwakePulseId);
            this._lockKeepAwakePulseId = null;
        }
        if (this._lockKeepAwakeTimeoutId) {
            GLib.Source.remove(this._lockKeepAwakeTimeoutId);
            this._lockKeepAwakeTimeoutId = null;
        }
    }

    _startKeepAwakeTimerIfNeeded() {
        this._clearKeepAwakeTimer();
        if (!this._settings)
            return;
        if (Main.sessionMode.currentMode !== 'unlock-dialog')
            return;
        if (!this._isKeepAwakeEnabledNow())
            return;

        // Keep lock screen visible while timer is active.
        this._pokeLockscreen();
        this._lockKeepAwakePulseId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 15, () => {
            if (Main.sessionMode.currentMode !== 'unlock-dialog')
                return GLib.SOURCE_REMOVE;
            this._pokeLockscreen();
            return GLib.SOURCE_CONTINUE;
        });
        GLib.Source.set_name_by_id(this._lockKeepAwakePulseId, '[livelockpaper] lock-keep-awake-pulse');

        const timeout = Math.max(0, this._settings.get_int(Keys.LOCKSCREEN_KEEP_AWAKE_TIMEOUT_SECONDS));
        if (timeout > 0) {
            this._lockKeepAwakeTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, timeout, () => {
                this._lockKeepAwakeTimeoutId = null;
                this._clearKeepAwakeTimer();
                // Stop wake-ups and let GNOME's native blank timeout handle blackout.
                this._keepAwakeActiveOnce = true;
                try { Main.screenShield?.emit?.('active-changed'); } catch (_) {}
                return GLib.SOURCE_REMOVE;
            });
            GLib.Source.set_name_by_id(this._lockKeepAwakeTimeoutId, '[livelockpaper] lock-keep-awake-timeout');
        }
    }

    _restartKeepAwakeTimerIfNeeded() {
        if (Main.sessionMode.currentMode !== 'unlock-dialog')
            return;
        this._startKeepAwakeTimerIfNeeded();
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
        // Use standard icon that should work with most icon packs
        this._panelIcon = new St.Icon({
            icon_name: 'preferences-desktop-wallpaper-symbolic',
            fallback_icon_name: 'image-x-generic-symbolic',
            style_class: 'system-status-icon',
        });
        this._panelButton.add_child(this._panelIcon);

        this._menuPlayPauseItem = new PopupMenu.PopupMenuItem('Pause Wallpaper');
        this._menuPlayPauseId = this._menuPlayPauseItem.connect('activate', () => {
            this._toggleWallpaperPlaybackFromMenu();
            return false; // Prevent menu from closing
        });
        this._panelButton.menu.addMenuItem(this._menuPlayPauseItem);

        this._menuNextItem = new PopupMenu.PopupMenuItem('Next Video');
        this._menuNextId = this._menuNextItem.connect('activate', () => {
            this._advanceWallpaperFromMenu();
            return false; // Prevent menu from closing
        });
        this._panelButton.menu.addMenuItem(this._menuNextItem);

        // Wallpaper group (submenu)
        this._menuWallpaperGroup = new PopupMenu.PopupSubMenuMenuItem('Wallpaper', true);
        const wallpaperSubmenu = this._menuWallpaperGroup.menu;

        this._menuWallpaperEnabledSwitch = new PopupMenu.PopupSwitchMenuItem(
            'Wallpaper enabled',
            this._settings.get_boolean(Keys.WALLPAPER_ENABLED)
        );
        this._menuWallpaperEnabledId = this._menuWallpaperEnabledSwitch.connect('toggled', (_item, state) => {
            this._settings.set_boolean(Keys.WALLPAPER_ENABLED, state);
        });
        wallpaperSubmenu.addMenuItem(this._menuWallpaperEnabledSwitch);

        this._menuRandomOrderSwitch = new PopupMenu.PopupSwitchMenuItem(
            'Random order',
            this._settings.get_boolean(Keys.WALLPAPER_RANDOM_ORDER)
        );
        this._menuRandomOrderId = this._menuRandomOrderSwitch.connect('toggled', (_item, state) => {
            this._settings.set_boolean(Keys.WALLPAPER_RANDOM_ORDER, state);
        });
        wallpaperSubmenu.addMenuItem(this._menuRandomOrderSwitch);

        this._menuPerMonitorSwitch = new PopupMenu.PopupSwitchMenuItem(
            'Per-monitor videos',
            this._settings.get_boolean(Keys.WALLPAPER_PER_MONITOR)
        );
        this._menuPerMonitorId = this._menuPerMonitorSwitch.connect('toggled', (_item, state) => {
            this._settings.set_boolean(Keys.WALLPAPER_PER_MONITOR, state);
        });
        wallpaperSubmenu.addMenuItem(this._menuPerMonitorSwitch);

        // Pause when hidden - use a cycling menu item instead of submenu
        // This avoids nested submenu issues
        this._menuPauseWhenHiddenItem = new PopupMenu.PopupMenuItem('');
        this._updatePauseWhenHiddenMenuLabel();
        this._menuPauseWhenHiddenItem.connect('activate', () => {
            const currentMode = this._settings.get_int(Keys.PAUSE_WHEN_HIDDEN_MODE) ?? PauseWhenHiddenMode.ALL_MONITORS;
            // Cycle through modes: OFF -> ALL_MONITORS -> ANY_MONITOR -> OFF
            let nextMode;
            if (currentMode === PauseWhenHiddenMode.OFF) {
                nextMode = PauseWhenHiddenMode.ALL_MONITORS;
            } else if (currentMode === PauseWhenHiddenMode.ALL_MONITORS) {
                nextMode = PauseWhenHiddenMode.ANY_MONITOR;
            } else {
                nextMode = PauseWhenHiddenMode.OFF;
            }
            this._settings.set_int(Keys.PAUSE_WHEN_HIDDEN_MODE, nextMode);
            this._updatePauseWhenHiddenMenuLabel();
            this._updatePauseWhenHiddenMenuState();
            return false; // Prevent menu from closing
        });
        wallpaperSubmenu.addMenuItem(this._menuPauseWhenHiddenItem);

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
        wallpaperSubmenu.addMenuItem(this._menuMuteSwitch);

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
        wallpaperSubmenu.addMenuItem(this._menuWallpaperBlurSwitch);

        if (this._hasBatteryDevice()) {
            this._menuWallpaperDisableOnBatterySwitch = new PopupMenu.PopupSwitchMenuItem(
                'Disable on battery',
                this._settings.get_boolean(Keys.WALLPAPER_DISABLE_ON_BATTERY)
            );
            this._menuWallpaperDisableOnBatteryId = this._menuWallpaperDisableOnBatterySwitch.connect('toggled', (_item, state) => {
                this._settings.set_boolean(Keys.WALLPAPER_DISABLE_ON_BATTERY, state);
            });
            wallpaperSubmenu.addMenuItem(this._menuWallpaperDisableOnBatterySwitch);
        }

        this._panelButton.menu.addMenuItem(this._menuWallpaperGroup);

        // Lock screen group (submenu)
        this._menuLockscreenGroup = new PopupMenu.PopupSubMenuMenuItem('Lock screen', true);
        const lockscreenSubmenu = this._menuLockscreenGroup.menu;

        this._menuLockscreenEnabledSwitch = new PopupMenu.PopupSwitchMenuItem(
            'Lock screen video',
            this._settings.get_boolean(Keys.LOCKSCREEN_ENABLED)
        );
        this._menuLockscreenEnabledId = this._menuLockscreenEnabledSwitch.connect('toggled', (_item, state) => {
            this._settings.set_boolean(Keys.LOCKSCREEN_ENABLED, state);
        });
        lockscreenSubmenu.addMenuItem(this._menuLockscreenEnabledSwitch);

        this._menuLsRandomOrderSwitch = new PopupMenu.PopupSwitchMenuItem(
            'Random order',
            this._settings.get_boolean(Keys.VIDEO_RANDOM_ORDER)
        );
        this._menuLsRandomOrderId = this._menuLsRandomOrderSwitch.connect('toggled', (_item, state) => {
            this._settings.set_boolean(Keys.VIDEO_RANDOM_ORDER, state);
        });
        lockscreenSubmenu.addMenuItem(this._menuLsRandomOrderSwitch);

        this._menuLsPerMonitorSwitch = new PopupMenu.PopupSwitchMenuItem(
            'Per-monitor videos',
            this._settings.get_boolean(Keys.LOCKSCREEN_PER_MONITOR)
        );
        this._menuLsPerMonitorId = this._menuLsPerMonitorSwitch.connect('toggled', (_item, state) => {
            this._settings.set_boolean(Keys.LOCKSCREEN_PER_MONITOR, state);
        });
        lockscreenSubmenu.addMenuItem(this._menuLsPerMonitorSwitch);

        this._menuLsMuteSwitch = new PopupMenu.PopupSwitchMenuItem(
            'Mute lockscreen audio',
            this._settings.get_int(Keys.AUDIO_VOLUME) === 0
        );
        this._menuLsMuteId = this._menuLsMuteSwitch.connect('toggled', (_item, state) => {
            const current = this._settings.get_int(Keys.AUDIO_VOLUME);
            if (state) {
                if (current > 0)
                    this._panelLsMuteRestoreVolume = current;
                this._settings.set_int(Keys.AUDIO_VOLUME, 0);
                return;
            }
            const restore = this._panelLsMuteRestoreVolume && this._panelLsMuteRestoreVolume > 0
                ? this._panelLsMuteRestoreVolume
                : 15;
            this._settings.set_int(Keys.AUDIO_VOLUME, restore);
        });
        lockscreenSubmenu.addMenuItem(this._menuLsMuteSwitch);

        this._menuLsBlurSwitch = new PopupMenu.PopupSwitchMenuItem(
            'Blur',
            (this._settings.get_int(Keys.BLUR_RADIUS) ?? 0) > 0
        );
        this._menuLsBlurId = this._menuLsBlurSwitch.connect('toggled', (_item, state) => {
            const current = this._settings.get_int(Keys.BLUR_RADIUS);
            if (!state) {
                if (current > 0)
                    this._panelLsBlurRestoreRadius = current;
                this._settings.set_int(Keys.BLUR_RADIUS, 0);
                return;
            }
            const restore = this._panelLsBlurRestoreRadius && this._panelLsBlurRestoreRadius > 0
                ? this._panelLsBlurRestoreRadius
                : 20;
            this._settings.set_int(Keys.BLUR_RADIUS, restore);
        });
        lockscreenSubmenu.addMenuItem(this._menuLsBlurSwitch);

        this._menuLsGrayscaleSwitch = new PopupMenu.PopupSwitchMenuItem(
            'Grayscale effect',
            this._settings.get_boolean(Keys.PROMPT_GRAYSCALE)
        );
        this._menuLsGrayscaleId = this._menuLsGrayscaleSwitch.connect('toggled', (_item, state) => {
            this._settings.set_boolean(Keys.PROMPT_GRAYSCALE, state);
        });
        lockscreenSubmenu.addMenuItem(this._menuLsGrayscaleSwitch);

        if (this._hasBatteryDevice()) {
            this._menuLockscreenDisableOnBatterySwitch = new PopupMenu.PopupSwitchMenuItem(
                'Disable on battery',
                this._settings.get_boolean(Keys.LOCKSCREEN_DISABLE_ON_BATTERY)
            );
            this._menuLockscreenDisableOnBatteryId = this._menuLockscreenDisableOnBatterySwitch.connect('toggled', (_item, state) => {
                this._settings.set_boolean(Keys.LOCKSCREEN_DISABLE_ON_BATTERY, state);
            });
            lockscreenSubmenu.addMenuItem(this._menuLockscreenDisableOnBatterySwitch);
        }

        this._panelButton.menu.addMenuItem(this._menuLockscreenGroup);

        // Other settings (outside groups)
        this._panelButton.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._menuGtkRendererSwitch = new PopupMenu.PopupSwitchMenuItem(
            'Use GTK4 renderer',
            !this._settings.get_boolean(Keys.DEBUG_USE_GTK4_SINK)
        );
        this._menuGtkRendererId = this._menuGtkRendererSwitch.connect('toggled', (_item, state) => {
            // Schema key is inverted: true means force legacy appsink.
            this._settings.set_boolean(Keys.DEBUG_USE_GTK4_SINK, !state);
        });
        this._panelButton.menu.addMenuItem(this._menuGtkRendererSwitch);


        this._menuRestartItem = new PopupMenu.PopupMenuItem('Restart Wallpaper');
        this._menuRestartId = this._menuRestartItem.connect('activate', () => {
            this._restartWallpaperFromMenu();
            return false; // Prevent menu from closing
        });
        this._panelButton.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._panelButton.menu.addMenuItem(this._menuRestartItem);

        this._menuSettingsItem = new PopupMenu.PopupMenuItem('Open Settings');
        this._menuSettingsId = this._menuSettingsItem.connect('activate', () => {
            this.openPreferences();
            return false; // Prevent menu from closing
        });
        this._panelButton.menu.addMenuItem(this._menuSettingsItem);

        Main.panel.addToStatusArea('live-lockpaper-indicator', this._panelButton, 1, 'right');

        this._panelSignals.push(
            this._settings.connect(`changed::${Keys.WALLPAPER_ENABLED}`, () => {
                this._syncStatusIndicator();
                if (this._menuWallpaperEnabledSwitch)
                    this._menuWallpaperEnabledSwitch.setToggleState(this._settings.get_boolean(Keys.WALLPAPER_ENABLED));
            })
        );
        this._panelSignals.push(
            this._settings.connect(`changed::${Keys.PAUSE_WHEN_HIDDEN_MODE}`, () => {
                this._syncStatusIndicator();
                this._updatePauseWhenHiddenMenuState();
            })
        );
        this._panelSignals.push(
            this._settings.connect(`changed::${Keys.WALLPAPER_BLUR_RADIUS}`, () => {
                this._syncStatusIndicator();
                if (this._menuWallpaperBlurSwitch)
                    this._menuWallpaperBlurSwitch.setToggleState((this._settings.get_int(Keys.WALLPAPER_BLUR_RADIUS) ?? 0) > 0);
            })
        );
        this._panelSignals.push(
            this._settings.connect(`changed::${Keys.LOCKSCREEN_ENABLED}`, () => {
                this._syncStatusIndicator();
                if (this._menuLockscreenEnabledSwitch)
                    this._menuLockscreenEnabledSwitch.setToggleState(this._settings.get_boolean(Keys.LOCKSCREEN_ENABLED));
            })
        );
        this._panelSignals.push(
            this._settings.connect(`changed::${Keys.WALLPAPER_RANDOM_ORDER}`, () => {
                this._syncStatusIndicator();
                if (this._menuRandomOrderSwitch)
                    this._menuRandomOrderSwitch.setToggleState(this._settings.get_boolean(Keys.WALLPAPER_RANDOM_ORDER));
            })
        );
        this._panelSignals.push(
            this._settings.connect(`changed::${Keys.WALLPAPER_PER_MONITOR}`, () => {
                this._syncStatusIndicator();
                if (this._menuPerMonitorSwitch)
                    this._menuPerMonitorSwitch.setToggleState(this._settings.get_boolean(Keys.WALLPAPER_PER_MONITOR));
            })
        );
        this._panelSignals.push(
            this._settings.connect(`changed::${Keys.WALLPAPER_VOLUME}`, () => {
                this._syncStatusIndicator();
                if (this._menuMuteSwitch)
                    this._menuMuteSwitch.setToggleState(this._settings.get_int(Keys.WALLPAPER_VOLUME) === 0);
            })
        );
        this._panelSignals.push(
            this._settings.connect(`changed::${Keys.VIDEO_RANDOM_ORDER}`, () => {
                if (this._menuLsRandomOrderSwitch)
                    this._menuLsRandomOrderSwitch.setToggleState(this._settings.get_boolean(Keys.VIDEO_RANDOM_ORDER));
            })
        );
        this._panelSignals.push(
            this._settings.connect(`changed::${Keys.LOCKSCREEN_PER_MONITOR}`, () => {
                if (this._menuLsPerMonitorSwitch)
                    this._menuLsPerMonitorSwitch.setToggleState(this._settings.get_boolean(Keys.LOCKSCREEN_PER_MONITOR));
            })
        );
        this._panelSignals.push(
            this._settings.connect(`changed::${Keys.AUDIO_VOLUME}`, () => {
                if (this._menuLsMuteSwitch)
                    this._menuLsMuteSwitch.setToggleState(this._settings.get_int(Keys.AUDIO_VOLUME) === 0);
            })
        );
        this._panelSignals.push(
            this._settings.connect(`changed::${Keys.BLUR_RADIUS}`, () => {
                if (this._menuLsBlurSwitch)
                    this._menuLsBlurSwitch.setToggleState((this._settings.get_int(Keys.BLUR_RADIUS) ?? 0) > 0);
            })
        );
        this._panelSignals.push(
            this._settings.connect(`changed::${Keys.DEBUG_USE_GTK4_SINK}`, () => this._syncStatusIndicator())
        );
        this._panelSignals.push(
            this._settings.connect(`changed::${Keys.WALLPAPER_DISABLE_ON_BATTERY}`, () => {
                this._syncStatusIndicator();
                if (this._menuWallpaperDisableOnBatterySwitch)
                    this._menuWallpaperDisableOnBatterySwitch.setToggleState(this._settings.get_boolean(Keys.WALLPAPER_DISABLE_ON_BATTERY));
                // Restart wallpaper immediately when battery setting changes
                this._scheduleWallpaperRestart();
            })
        );
        this._panelSignals.push(
            this._settings.connect(`changed::${Keys.LOCKSCREEN_DISABLE_ON_BATTERY}`, () => {
                this._syncStatusIndicator();
                if (this._menuLockscreenDisableOnBatterySwitch)
                    this._menuLockscreenDisableOnBatterySwitch.setToggleState(this._settings.get_boolean(Keys.LOCKSCREEN_DISABLE_ON_BATTERY));
            })
        );
        this._panelSignals.push(
            this._settings.connect(`changed::${Keys.PROMPT_GRAYSCALE}`, () => {
                if (this._menuLsGrayscaleSwitch)
                    this._menuLsGrayscaleSwitch.setToggleState(this._settings.get_boolean(Keys.PROMPT_GRAYSCALE));
            })
        );
        this._panelSignals.push(
            this._settings.connect(`changed::${Keys.PANEL_ICON_MODE}`, () => {
                const wpEnabled = this._settings.get_boolean(Keys.WALLPAPER_ENABLED);
                const lsEnabled = this._settings.get_boolean(Keys.LOCKSCREEN_ENABLED);
                this._updatePanelIcon(wpEnabled, lsEnabled);
            })
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
        // Pause when hidden menu item doesn't need disconnection
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
        if (this._menuWallpaperDisableOnBatterySwitch && this._menuWallpaperDisableOnBatteryId) {
            try { this._menuWallpaperDisableOnBatterySwitch.disconnect(this._menuWallpaperDisableOnBatteryId); } catch (_) {}
        }
        if (this._menuLockscreenDisableOnBatterySwitch && this._menuLockscreenDisableOnBatteryId) {
            try { this._menuLockscreenDisableOnBatterySwitch.disconnect(this._menuLockscreenDisableOnBatteryId); } catch (_) {}
        }
        if (this._menuLsGrayscaleSwitch && this._menuLsGrayscaleId) {
            try { this._menuLsGrayscaleSwitch.disconnect(this._menuLsGrayscaleId); } catch (_) {}
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
        this._menuPauseWhenHiddenItem = null;
        this._menuRandomOrderSwitch = null;
        this._menuPerMonitorSwitch = null;
        this._menuWallpaperBlurSwitch = null;
        this._menuMuteSwitch = null;
        this._menuGtkRendererSwitch = null;
        this._menuWallpaperDisableOnBatterySwitch = null;
        this._menuLockscreenDisableOnBatterySwitch = null;
        this._menuLsGrayscaleSwitch = null;
        this._menuRestartItem = null;
        this._menuSettingsItem = null;
        this._menuPlayPauseId = null;
        this._menuNextId = null;
        this._menuWallpaperEnabledId = null;
        this._menuLockscreenEnabledId = null;
        this._menuRandomOrderId = null;
        this._menuPerMonitorId = null;
        this._menuWallpaperBlurId = null;
        this._menuMuteId = null;
        this._menuGtkRendererId = null;
        this._menuWallpaperDisableOnBatteryId = null;
        this._menuLockscreenDisableOnBatteryId = null;
        this._menuLsGrayscaleId = null;
        this._menuRestartId = null;
        this._menuSettingsId = null;

        if (this._panelButton) {
            this._panelButton.destroy();
            this._panelButton = null;
        }
    }

    _updatePanelIcon(wallpaperEnabled, lockscreenEnabled) {
        if (!this._panelIcon || !this._settings)
            return;

        const iconMode = this._settings.get_int(Keys.PANEL_ICON_MODE) ?? 0;

        if (iconMode === 2 || iconMode === 3) {
            // Static mode - use original or custom static icon
            let iconPath;
            if (iconMode === 2) {
                // Original static icon
                iconPath = `${this.path}/icons/original.png`;
            } else {
                // Custom static icon (flower.png)
                iconPath = `${this.path}/icons/flower.png`;
            }
            
            try {
                const gicon = Gio.icon_new_for_string(iconPath);
                this._panelIcon.gicon = gicon;
                this._panelIcon.icon_name = null;
            } catch (_) {
                // Fallback to original icon
                try {
                    const gicon = Gio.icon_new_for_string(`${this.path}/icons/original.png`);
                    this._panelIcon.gicon = gicon;
                    this._panelIcon.icon_name = null;
                } catch (_) {}
            }
            return;
        }

        // Dynamic mode (0 = standard icons, 1 = custom icons)
        if (iconMode === 1) {
            // Custom dynamic icons - use fixed filenames
            let iconPath;
            if (wallpaperEnabled && lockscreenEnabled) {
                iconPath = `${this.path}/icons/both.png`;
            } else if (wallpaperEnabled) {
                iconPath = `${this.path}/icons/wallpaper.png`;
            } else if (lockscreenEnabled) {
                iconPath = `${this.path}/icons/lockscreen.png`;
            } else {
                iconPath = `${this.path}/icons/none.png`;
            }

            try {
                const gicon = Gio.icon_new_for_string(iconPath);
                this._panelIcon.gicon = gicon;
                this._panelIcon.icon_name = null;
                return;
            } catch (_) {
                // Fall through to standard icons if custom fails
            }
        }

        // Standard GNOME icons (mode 0 or fallback)
        let iconName;
        if (wallpaperEnabled && lockscreenEnabled) {
            iconName = 'media-playback-start-symbolic';
        } else if (wallpaperEnabled) {
            iconName = 'preferences-desktop-wallpaper-symbolic';
        } else if (lockscreenEnabled) {
            iconName = 'system-lock-screen-symbolic';
        } else {
            iconName = 'video-x-generic-symbolic';
        }

        try {
            this._panelIcon.icon_name = iconName;
            this._panelIcon.gicon = null;
        } catch (_) {
            try {
                this._panelIcon.icon_name = 'image-x-generic-symbolic';
                this._panelIcon.gicon = null;
            } catch (_) {}
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
        const lockscreenEnabled = this._settings.get_boolean(Keys.LOCKSCREEN_ENABLED);
        const hasRuntime = !!this._wpPlayerProcess || (this._wpPipelines && this._wpPipelines.length > 0);
        const canControlPlayback = isUserMode && wallpaperEnabled && hasRuntime;
        const canToggleWallpaperFeatures = isUserMode && wallpaperEnabled;
        const paused = this._manualWallpaperPaused || this._wallpaperWasPaused;

        this._panelButton.visible = isUserMode;

        // Update icon based on lockscreen and wallpaper states
        this._updatePanelIcon(wallpaperEnabled, lockscreenEnabled);

        if (this._menuPlayPauseItem) {
            this._menuPlayPauseItem.label.set_text(paused ? 'Play Wallpaper' : 'Pause Wallpaper');
            this._menuPlayPauseItem.setSensitive(canControlPlayback);
        }
        if (this._menuNextItem) {
            this._menuNextItem.setSensitive(canControlPlayback && this._canAdvanceWallpaperPlaylist());
        }
        if (this._menuRestartItem) {
            this._menuRestartItem.setSensitive(isUserMode);
        }

        if (this._menuWallpaperEnabledSwitch && this._menuWallpaperEnabledSwitch.state !== wallpaperEnabled)
            this._menuWallpaperEnabledSwitch.setToggleState(wallpaperEnabled);
        if (this._menuLockscreenEnabledSwitch) {
            const lockscreenEnabled = this._settings.get_boolean(Keys.LOCKSCREEN_ENABLED);
            if (this._menuLockscreenEnabledSwitch.state !== lockscreenEnabled)
                this._menuLockscreenEnabledSwitch.setToggleState(lockscreenEnabled);
        }

        this._updatePauseWhenHiddenMenuState();
        if (this._menuPauseWhenHiddenItem)
            this._menuPauseWhenHiddenItem.setSensitive(canToggleWallpaperFeatures);
    }

    _updatePauseWhenHiddenMenuLabel() {
        if (!this._menuPauseWhenHiddenItem) return;
        const mode = this._settings.get_int(Keys.PAUSE_WHEN_HIDDEN_MODE) ?? PauseWhenHiddenMode.ALL_MONITORS;
        let label;
        if (mode === PauseWhenHiddenMode.OFF) {
            label = 'Pause when hidden: Off';
        } else if (mode === PauseWhenHiddenMode.ALL_MONITORS) {
            label = 'Pause when hidden: All';
        } else {
            label = 'Pause when hidden: Any';
        }
        this._menuPauseWhenHiddenItem.label.text = label;
    }

    _updatePauseWhenHiddenMenuState() {
        if (!this._menuPauseWhenHiddenItem) return;
        this._updatePauseWhenHiddenMenuLabel();

        // Define canToggleWallpaperFeatures for this function scope
        const isUserMode = Main.sessionMode.currentMode === 'user';
        const wallpaperEnabled = this._settings.get_boolean(Keys.WALLPAPER_ENABLED);
        const canToggleWallpaperFeatures = isUserMode && wallpaperEnabled;

        const randomOrder = this._settings.get_boolean(Keys.WALLPAPER_RANDOM_ORDER);
        if (this._menuRandomOrderSwitch) {
            if (this._menuRandomOrderSwitch.state !== randomOrder)
                this._menuRandomOrderSwitch.setToggleState(randomOrder);
            this._menuRandomOrderSwitch.setSensitive(canToggleWallpaperFeatures);
        }

        const perMonitor = this._settings.get_boolean(Keys.WALLPAPER_PER_MONITOR);
        if (this._menuPerMonitorSwitch) {
            if (this._menuPerMonitorSwitch.state !== perMonitor)
                this._menuPerMonitorSwitch.setToggleState(perMonitor);
            this._menuPerMonitorSwitch.setSensitive(canToggleWallpaperFeatures);
        }

        const blurEnabled = (this._settings.get_int(Keys.WALLPAPER_BLUR_RADIUS) ?? 0) > 0;
        if (this._menuWallpaperBlurSwitch) {
            if (this._menuWallpaperBlurSwitch.state !== blurEnabled)
                this._menuWallpaperBlurSwitch.setToggleState(blurEnabled);
            this._menuWallpaperBlurSwitch.setSensitive(canToggleWallpaperFeatures);
        }

        const muted = this._settings.get_int(Keys.WALLPAPER_VOLUME) === 0;
        if (this._menuMuteSwitch) {
            if (this._menuMuteSwitch.state !== muted)
                this._menuMuteSwitch.setToggleState(muted);
            this._menuMuteSwitch.setSensitive(canToggleWallpaperFeatures);
        }

        const useGtkRenderer = !this._settings.get_boolean(Keys.DEBUG_USE_GTK4_SINK);
        if (this._menuGtkRendererSwitch.state !== useGtkRenderer)
            this._menuGtkRendererSwitch.setToggleState(useGtkRenderer);

        if (this._menuWallpaperDisableOnBatterySwitch) {
            const disableOnBattery = this._settings.get_boolean(Keys.WALLPAPER_DISABLE_ON_BATTERY);
            if (this._menuWallpaperDisableOnBatterySwitch.state !== disableOnBattery)
                this._menuWallpaperDisableOnBatterySwitch.setToggleState(disableOnBattery);
        }
        if (this._menuLockscreenDisableOnBatterySwitch) {
            const disableOnBattery = this._settings.get_boolean(Keys.LOCKSCREEN_DISABLE_ON_BATTERY);
            if (this._menuLockscreenDisableOnBatterySwitch.state !== disableOnBattery)
                this._menuLockscreenDisableOnBatterySwitch.setToggleState(disableOnBattery);
        }
        if (this._menuLsGrayscaleSwitch) {
            const grayscale = this._settings.get_boolean(Keys.PROMPT_GRAYSCALE);
            if (this._menuLsGrayscaleSwitch.state !== grayscale)
                this._menuLsGrayscaleSwitch.setToggleState(grayscale);
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
            if (this._wpSubprocessStates && this._wpSubprocessStates.length > 0) {
                for (const state of this._wpSubprocessStates) {
                    if (!state?.videoPaths || state.videoPaths.length <= 1)
                        continue;
                    const nextPath = this._wpSelectNextVideoFor(state);
                    if (nextPath)
                        this._startPlayCountTracking(Keys.WALLPAPER_VIDEO_METADATA, nextPath);
                }
            }
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
                if (Main.sessionMode.currentMode === 'unlock-dialog') {
                    this._applyLockscreenTextCustomization();
                    this._restartKeepAwakeTimerIfNeeded();
                }
                return;
            }
            console.log('[LockScreen] _enableLockScreen called');
            if (!Main.screenShield?._dialog) {
            // Retry for a few seconds (dialog can appear late on some systems)
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

        // Check battery — skip video lock screen to save power, but keep text/keep-awake behavior active.
        if (this._settings.get_boolean(Keys.LOCKSCREEN_DISABLE_ON_BATTERY) && this._isOnBattery()) {
            console.log('[LockScreen] Skipping — device is on battery power');
            this._applyLockscreenTextCustomization();
            this._restartKeepAwakeTimerIfNeeded();
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
            this._incrementPlayCountForMetadataKey(Keys.VIDEO_METADATA, videoPath);
        };

        // Force gpuColorConversion OFF for lock screen (GL contexts can deadlock during lock transition)
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
        this._startPlayCountTracking(Keys.VIDEO_METADATA, initialVideoPath);
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
            useVideorate: !autoFps,
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

        this._applyLockscreenTextCustomization();
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

        // Check battery — skip video lock screen to save power, but keep text/keep-awake behavior active.
        if (this._settings.get_boolean(Keys.LOCKSCREEN_DISABLE_ON_BATTERY) && this._isOnBattery()) {
            console.log('[LockScreen:GTK4] Skipping — device is on battery power');
            this._hideLockStartupCover();
            this._applyLockscreenTextCustomization();
            this._restartKeepAwakeTimerIfNeeded();
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
        const randomOrder = this._settings.get_boolean(Keys.VIDEO_RANDOM_ORDER);
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
            const usedInitialVideos = new Set();
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
                const state = {
                    videoPaths: paths,
                    currentIndex: -1,
                    randomOrder,
                };
                const selected = this._selectUniqueInitialVideo(state, usedInitialVideos);
                if (selected)
                    this._startPlayCountTracking(Keys.VIDEO_METADATA, selected);
                subprocessMonitors.push({
                    videos: paths,
                    initialIndex: state.currentIndex,
                });
            }
        } else {
            if (videoPaths.length === 0) {
                console.warn('[LockScreen:GTK4] No videos set, falling back');
                return;
            }
            // Shared: one monitor config entry, player.js will share the paintable
            const state = {
                videoPaths,
                currentIndex: -1,
                randomOrder,
            };
            const selected = this._wpSelectNextVideoFor(state);
            if (selected)
                this._startPlayCountTracking(Keys.VIDEO_METADATA, selected);
            subprocessMonitors.push({
                videos: videoPaths,
                initialIndex: state.currentIndex,
            });
        }

        // Settings for subprocess
        const volume = this._settings.get_int(Keys.AUDIO_VOLUME) / 100;
        const scalingMode = this._settings.get_int(Keys.SCALING_MODE);
        const lockAutoFps = this._settings.get_boolean(Keys.VIDEO_AUTO_FPS);
        const useVideorate = !lockAutoFps;
        const framerate = this._settings.get_int(Keys.FRAMERATE);
        const preferHwDecoder = this._settings.get_boolean(Keys.DEBUG_PREFER_HW_DECODER);
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
        const config = {
            scalingMode,
            volume,
            useVideorate,
            framerate,
            preferHwDecoder,
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
            // Map-event ordering is not stable, use window title index
            windows.forEach((win, i) => {
                const title = win.get_title() || '';
                const match = title.match(/^LiveLockPaper-(\d+)$/);
                const monitorIndex = match ? Number.parseInt(match[1], 10) : i;
                const targetMonitor = monitors[monitorIndex] || monitors[i] || monitors[0];

                if (targetMonitor) {
                    // Position-only: don't resize (avoids Mutter auto-maximize).
                    try {
                        win.move_frame(false, targetMonitor.x, targetMonitor.y);
                    } catch (_) {}
                }
                try { win.set_skip_taskbar(true); } catch (_) {
                    try { win.skip_taskbar = true; } catch (_) {}
                }
                try { win.set_skip_pager(true); } catch (_) {
                    try { win.skip_pager = true; } catch (_) {}
                }
                this._lockWindowActors[monitorIndex] = win.get_compositor_private();
            });
            this._refreshGtkHelperWindowHints('lock-map');

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
            this._applyLockscreenTextCustomization();
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

            // Detach actor on unlock (helper process owns the window)
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
        // Disconnect existing sleep handler if any
        if (this._sleepId) {
            console.log('[LockScreen:GTK4] Disconnecting existing sleep handler');
            this._loginManager?.disconnect(this._sleepId);
            this._sleepId = null;
        }
        this._loginManager = LoginManager.getLoginManager();
        const verbose = this._isVerboseLoggingEnabled();
        if (verbose) {
            console.log('[LockScreen:GTK4] Initializing sleep handler for lockscreen subprocess');
        }
        this._sleepId = this._loginManager.connect('prepare-for-sleep', (_manager, aboutToSleep) => {
            const verbose = this._isVerboseLoggingEnabled();
            const timestamp = verbose ? new Date().toISOString() : null;
            
            if (verbose) {
                console.log(`[LockScreen:GTK4] prepare-for-sleep: aboutToSleep=${aboutToSleep}, currentMode=${Main.sessionMode.currentMode}, hasLockPlayerProcess=${!!this._lockPlayerProcess}`);
            }
            
            if (aboutToSleep) {
                // Destroy lockscreen video process on sleep to prevent it from blocking sleep
                console.log(`[LockScreen:GTK4] ⏸️  SLEEP: Destroying lockscreen${verbose ? ` [${timestamp}]` : ''}`);
                if (this._lockPlayerProcess) {
                    if (verbose) console.log(`[LockScreen:GTK4] SLEEP: Destroying player process (PID=${this._lockPlayerProcess.pid})`);
                    // Disconnect position/scale watchers
                    if (this._lockPositionSignals) {
                        for (const { actor, ids } of this._lockPositionSignals) {
                            for (const id of ids) {
                                try { actor.disconnect(id); } catch (_) {}
                            }
                        }
                        this._lockPositionSignals = [];
                    }
                    // Detach all window actors before destroying
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
                    if (verbose) console.log('[LockScreen:GTK4] SLEEP: Player process destroyed');
                }
                // Clear injection manager (will be recreated on wake if needed)
                if (this._injectionManager) {
                    if (verbose) console.log('[LockScreen:GTK4] SLEEP: Clearing injection manager');
                    this._injectionManager.clear();
                    this._injectionManager = null;
                }
            } else {
                // On wake, recreate lockscreen video if system is still locked
                const lockscreenEnabled = this._settings?.get_boolean(Keys.LOCKSCREEN_ENABLED);
                const shouldRecreate = Main.sessionMode.currentMode === 'unlock-dialog' && lockscreenEnabled;
                
                if (verbose) {
                    const wakeTimestamp = new Date().toISOString();
                    console.log(`[LockScreen:GTK4] ▶️  WAKE: System RESUMED [${wakeTimestamp}]`);
                    console.log(`[LockScreen:GTK4] WAKE: currentMode=${Main.sessionMode.currentMode}, lockscreenEnabled=${lockscreenEnabled}, shouldRecreate=${shouldRecreate}`);
                } else {
                    console.log(`[LockScreen:GTK4] ▶️  WAKE: ${shouldRecreate ? 'Recreating lockscreen' : 'Not recreating'}`);
                }
                
                if (shouldRecreate) {
                    if (verbose) console.log('[LockScreen:GTK4] WAKE: Recreating player process (system still locked)');
                    // Re-setup the lockscreen subprocess
                    this._setupLockScreenSubprocess();
                }
            }
        });
        if (verbose) {
            console.log('[LockScreen:GTK4] Sleep handler initialized');
        }
    }

    _disableLockScreen() {
        // Stop all lockscreen play count tracking
        for (const [key, tracking] of this._playCountTracking.entries()) {
            if (tracking.metadataKey === Keys.VIDEO_METADATA) {
                this._stopPlayCountTracking(key);
            }
        }
        this._hideLockStartupCover();
        this._clearLockTextTimer();
        this._clearLockTextCommandState();
        this._clearKeepAwakeTimer();
        try { this._lockTextCmdLabel?.destroy(); } catch (_) {}
        try { this._lockTextOverlayLayer?.destroy(); } catch (_) {}
        this._lockTextCmdLabel = null;
        this._lockTextOverlayLayer = null;
        this._lockTextOverlayBinLayout = null;
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
            this._startPlayCountTracking(Keys.VIDEO_METADATA, videoPath);

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
                useVideorate: !this._lockPipelineParams.autoFps,
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

    _initWallpaperSleepHandler() {
        // Disconnect existing wallpaper sleep handler if any
        if (this._wpSleepId) {
            console.log('[Wallpaper] Disconnecting existing wallpaper sleep handler');
            this._loginManager?.disconnect(this._wpSleepId);
            this._wpSleepId = null;
        }
        
        // Get or create login manager
        if (!this._loginManager) {
            this._loginManager = LoginManager.getLoginManager();
        }
        
        if (this._isVerboseLoggingEnabled()) {
            console.log('[Wallpaper] Initializing sleep handler for wallpaper');
        }
        this._wpSleepId = this._loginManager.connect('prepare-for-sleep', (_manager, aboutToSleep) => {
            try {
                const verbose = this._isVerboseLoggingEnabled();
                const timestamp = verbose ? new Date().toISOString() : null;
                
                const wpPipelinesValue = this._wpPipelines;
                const hasPipelines = !!(wpPipelinesValue && Array.isArray(wpPipelinesValue) && wpPipelinesValue.length > 0);
                const hasSubprocess = !!this._wpPlayerProcess;
                const pipelineCount = hasPipelines ? wpPipelinesValue.length : 0;
                const subprocessPid = hasSubprocess ? this._wpPlayerProcess.pid : 'N/A';
                
                if (verbose) {
                    console.log(`[Wallpaper] prepare-for-sleep: aboutToSleep=${aboutToSleep}, currentMode=${Main.sessionMode.currentMode}`);
                    console.log(`[Wallpaper] State: hasPipelines=${hasPipelines}, hasSubprocess=${hasSubprocess}, subprocessPid=${subprocessPid}`);
                }
                
                if (aboutToSleep) {
                    // Pause wallpaper on sleep to prevent it from blocking sleep
                    console.log(`[Wallpaper] ⏸️  SLEEP: Pausing wallpaper${verbose ? ` [${timestamp}]` : ''}`);
                    if (hasPipelines) {
                        if (verbose) console.log(`[Wallpaper] SLEEP: Pausing ${pipelineCount} pipeline(s)`);
                        this._wpPipelines.forEach((p, idx) => {
                            try {
                                p.pause();
                                if (verbose) console.log(`[Wallpaper] SLEEP: Pipeline ${idx} paused`);
                            } catch (e) {
                                console.error(`[Wallpaper] SLEEP: Error pausing pipeline ${idx}: ${e.message}`);
                            }
                        });
                    }
                    if (hasSubprocess) {
                        if (verbose) console.log(`[Wallpaper] SLEEP: Pausing subprocess (PID=${subprocessPid})`);
                        try {
                            this._wpPlayerProcess.pause();
                            if (verbose) console.log(`[Wallpaper] SLEEP: Subprocess paused`);
                        } catch (e) {
                            console.error(`[Wallpaper] SLEEP: Error pausing subprocess: ${e.message}`);
                        }
                    }
                    this._wallpaperWasPausedForSleep = true;
                } else {
                    // On wake, resume wallpaper if in desktop mode
                    const wallpaperEnabled = this._settings?.get_boolean(Keys.WALLPAPER_ENABLED);
                    const shouldResume = Main.sessionMode.currentMode === 'user' && 
                        wallpaperEnabled &&
                        this._wallpaperWasPausedForSleep;
                    
                    if (verbose) {
                        const wakeTimestamp = new Date().toISOString();
                        console.log(`[Wallpaper] ▶️  WAKE: System RESUMED [${wakeTimestamp}]`);
                        console.log(`[Wallpaper] WAKE: currentMode=${Main.sessionMode.currentMode}, wallpaperEnabled=${wallpaperEnabled}, wasPausedForSleep=${this._wallpaperWasPausedForSleep}, shouldResume=${shouldResume}`);
                    } else {
                        console.log(`[Wallpaper] ▶️  WAKE: Resuming wallpaper`);
                    }
                    
                    if (shouldResume) {
                        if (verbose) console.log('[Wallpaper] WAKE: Starting resume sequence...');
                        if (hasPipelines) {
                            if (verbose) console.log(`[Wallpaper] WAKE: Resuming ${pipelineCount} pipeline(s)`);
                            this._wpPipelines.forEach((p, idx) => {
                                try {
                                    p.play();
                                    if (verbose) console.log(`[Wallpaper] WAKE: Pipeline ${idx} resumed`);
                                } catch (e) {
                                    console.error(`[Wallpaper] WAKE: Error resuming pipeline ${idx}: ${e.message}`);
                                }
                            });
                        }
                        if (hasSubprocess) {
                            if (verbose) console.log(`[Wallpaper] WAKE: Resuming subprocess (PID=${subprocessPid})`);
                            try {
                                this._wpPlayerProcess.play();
                                if (verbose) console.log(`[Wallpaper] WAKE: Subprocess resumed`);
                            } catch (e) {
                                console.error(`[Wallpaper] WAKE: Error resuming subprocess: ${e.message}`);
                            }
                        }
                        this._wallpaperWasPausedForSleep = false;
                    } else if (verbose) {
                        console.log('[Wallpaper] WAKE: Not resuming wallpaper (conditions not met)');
                    }
                }
            } catch (e) {
                console.error(`[Wallpaper] Error in sleep handler: ${e.message}\n${e.stack}`);
            }
        });
        if (this._isVerboseLoggingEnabled()) {
            console.log('[Wallpaper] Sleep handler initialized');
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
        // Disconnect existing sleep handler if any
        if (this._sleepId) {
            if (this._isVerboseLoggingEnabled()) {
                console.log('[LockScreen] Disconnecting existing sleep handler');
            }
            this._loginManager?.disconnect(this._sleepId);
            this._sleepId = null;
        }
        this._loginManager = LoginManager.getLoginManager();
        const verbose = this._isVerboseLoggingEnabled();
        if (verbose) {
            console.log('[LockScreen] Initializing sleep handler for lockscreen appsink');
        }
        this._sleepId = this._loginManager.connect('prepare-for-sleep', (manager, aboutToSleep) => {
            const verbose = this._isVerboseLoggingEnabled();
            const timestamp = verbose ? new Date().toISOString() : null;
            const hasPipeline = !!this._pipeline;
            const hasPipelines = this._lockPipelines && this._lockPipelines.length > 0;
            const pipelineCount = hasPipelines ? this._lockPipelines.length : 0;
            
            if (verbose) {
                console.log(`[LockScreen] prepare-for-sleep: aboutToSleep=${aboutToSleep}, currentMode=${Main.sessionMode.currentMode}`);
                console.log(`[LockScreen] State: hasPipeline=${hasPipeline}, hasPipelines=${hasPipelines}, pipelineCount=${pipelineCount}`);
            }
            
            if (aboutToSleep) {
                // Destroy lockscreen video pipelines on sleep to prevent them from blocking sleep
                console.log(`[LockScreen] ⏸️  SLEEP: Destroying lockscreen${verbose ? ` [${timestamp}]` : ''}`);
                // Destroy shared pipeline
                if (this._pipeline) {
                    if (verbose) console.log('[LockScreen] SLEEP: Destroying shared pipeline');
                    this._pipeline.destroy();
                    this._pipeline = null;
                }
                // Destroy per-monitor pipelines
                if (this._lockPipelines && this._lockPipelines.length > 0) {
                    if (verbose) console.log(`[LockScreen] SLEEP: Destroying ${pipelineCount} per-monitor pipeline(s)`);
                    this._lockPipelines.forEach(p => p.destroy());
                    this._lockPipelines = [];
                }
                this._lockMonitorStates = [];
                // Clear actors and images
                if (this._actors && this._actors.length > 0) {
                    if (verbose) console.log(`[LockScreen] SLEEP: Destroying ${this._actors.length} actor(s)`);
                    this._actors.forEach(a => {
                        try { a.remove_effect_by_name('lockscreen-extension-blur'); } catch (e) {}
                        a.destroy();
                    });
                    this._actors = [];
                }
                if (this._images) {
                    if (verbose) console.log('[LockScreen] SLEEP: Clearing images');
                    this._images = [];
                }
            } else {
                // On wake, recreate lockscreen video if system is still locked
                const lockscreenEnabled = this._settings?.get_boolean(Keys.LOCKSCREEN_ENABLED);
                const shouldRecreate = Main.sessionMode.currentMode === 'unlock-dialog' && lockscreenEnabled;
                
                if (verbose) {
                    const wakeTimestamp = new Date().toISOString();
                    console.log(`[LockScreen] ▶️  WAKE: System RESUMED [${wakeTimestamp}]`);
                    console.log(`[LockScreen] WAKE: currentMode=${Main.sessionMode.currentMode}, lockscreenEnabled=${lockscreenEnabled}, shouldRecreate=${shouldRecreate}`);
                } else {
                    console.log(`[LockScreen] ▶️  WAKE: ${shouldRecreate ? 'Recreating lockscreen' : 'Not recreating'}`);
                }
                
                if (shouldRecreate) {
                    if (verbose) console.log('[LockScreen] WAKE: Recreating pipelines (system still locked)');
                    // Re-setup the lockscreen
                    this._setupLockScreen();
                }
            }
        });
        if (verbose) {
            console.log('[LockScreen] Sleep handler initialized');
        }
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
        // Stop tracking previous video
        if (this._currentVideoPath) {
            this._stopPlayCountTracking(`${Keys.VIDEO_METADATA}:${this._currentVideoPath}`);
        }

        // Select next video (random or sequential based on setting)
        const newVideoPath = this._selectNextVideo();
        if (!newVideoPath) {
            console.error('Failed to select new video');
            return;
        }
        
        console.log(`[LiveLockPaper] Switching to new video: ${newVideoPath}`);
        
        // Start tracking play count
        this._startPlayCountTracking(Keys.VIDEO_METADATA, newVideoPath);
        
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

        // Stop tracking previous video for this monitor (before currentIndex is updated)
        const prevIndex = state.currentIndex >= 0 ? state.currentIndex : 0;
        const prevVideoPath = state.videoPaths[prevIndex];
        if (prevVideoPath) {
            this._stopPlayCountTracking(`${Keys.VIDEO_METADATA}:${prevVideoPath}`);
        }

        const newVideoPath = this._wpSelectNextVideoFor(state);
        if (!newVideoPath) return;

        console.log(`[LockScreen] Pipeline ${pipelineIndex} switching to: ${newVideoPath.split('/').pop()}`);

        const framerate = this._getFramerateForVideo(newVideoPath);
        this._startPlayCountTracking(Keys.VIDEO_METADATA, newVideoPath);

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
        if (this._settings.get_boolean(Keys.WALLPAPER_DISABLE_ON_BATTERY) && this._isOnBattery()) {
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
        const pauseWhenHiddenMode = this._settings.get_int(Keys.PAUSE_WHEN_HIDDEN_MODE) ?? PauseWhenHiddenMode.ALL_MONITORS;
        const pauseWhenHidden = pauseWhenHiddenMode !== PauseWhenHiddenMode.OFF;
        const adaptivePolling = this._settings.get_boolean(Keys.DEBUG_PUSH_FRAME_DELIVERY);

        this._wpActors = [];
        this._wpImages = [];
        this._wpPipelines = [];
        this._wpMonitorStates = []; // For per-monitor playlist state
        this._wallpaperWasPausedForSleep = false;

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
                this._startPlayCountTracking(Keys.WALLPAPER_VIDEO_METADATA, videoPath);
                const staggerMs = activeMonitorCount > 1
                    ? Math.round((1000 / framerate) / activeMonitorCount) * pipelineIndex
                    : 0;
                const pipeline = new Pipeline({
                    videoPath: videoPath,
                    volume: volume,
                    loop: shouldLoop,
                    framerate: framerate,
                    useVideorate: !autoFps,
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
            this._startPlayCountTracking(Keys.WALLPAPER_VIDEO_METADATA, videoPath);

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
                useVideorate: !autoFps,
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
            // Mark as not ready initially to prevent immediate pausing
            this._wpPauseWhenHiddenReady = false;
            // Delay the initial check to avoid pausing immediately after startup
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                this._setupPauseWhenHidden();
                this._wpPauseWhenHiddenReady = true;
                return GLib.SOURCE_REMOVE;
            });
        } else {
            this._wpPauseWhenHiddenReady = false;
        }

        // Watch for settings changes to live-reload
        this._setupWallpaperSettingsWatch();
        // Initialize sleep handling for wallpaper
        this._initWallpaperSleepHandler();
        this._syncStatusIndicator();
    }

    // Subprocess wallpaper (gtk4paintablesink)

    _enableWallpaperSubprocess() {
        console.log('[Wallpaper:GTK4] Setting up subprocess wallpaper');

        this._wpActors = [];
        this._wpPlayerProcess = null;
        this._wpWindowActors = {};
        this._wpSubprocessMonitorVideos = [];
        this._wallpaperWasPausedForSleep = false;

        const perMonitor = this._settings.get_boolean(Keys.WALLPAPER_PER_MONITOR);
        const scalingMode = this._settings.get_int(Keys.WALLPAPER_SCALING_MODE);
        const volume = this._settings.get_int(Keys.WALLPAPER_VOLUME) / 100;
        const wallpaperAutoFps = this._settings.get_boolean(Keys.WALLPAPER_AUTO_FPS);
        const useVideorate = !wallpaperAutoFps;
        const framerate = this._settings.get_int(Keys.WALLPAPER_FRAMERATE);
        const preferHwDecoder = this._settings.get_boolean(Keys.DEBUG_PREFER_HW_DECODER);
        const qualityPct = this._settings.get_int(Keys.WALLPAPER_QUALITY);
        const renderScale = Math.max(0.25, Math.min(1.0, qualityPct / 100));
        const fadeInDuration = this._settings.get_int(Keys.WALLPAPER_FADE_IN_DURATION);
        const blurRadius = this._settings.get_int(Keys.WALLPAPER_BLUR_RADIUS);
        const blurBrightness = this._settings.get_double(Keys.WALLPAPER_BLUR_BRIGHTNESS);
        const pauseWhenHiddenMode = this._settings.get_int(Keys.PAUSE_WHEN_HIDDEN_MODE) ?? PauseWhenHiddenMode.ALL_MONITORS;
        const pauseWhenHidden = pauseWhenHiddenMode !== PauseWhenHiddenMode.OFF;

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
            const usedInitialVideos = new Set();
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
                const state = {
                    videoPaths: paths,
                    currentIndex: -1,
                    randomOrder,
                };
                const selected = this._selectUniqueInitialVideo(state, usedInitialVideos);
                if (selected)
                    this._startPlayCountTracking(Keys.WALLPAPER_VIDEO_METADATA, selected);
                subprocessMonitors.push({
                    videos: paths,
                    initialIndex: state.currentIndex,
                    width: monitors[i].width,
                    height: monitors[i].height,
                });
            }
        } else {
            if (wpVideoPaths.length > 0) {
                const state = {
                    videoPaths: wpVideoPaths,
                    currentIndex: -1,
                    randomOrder,
                };
                const selected = this._wpSelectNextVideoFor(state);
                if (selected)
                    this._startPlayCountTracking(Keys.WALLPAPER_VIDEO_METADATA, selected);
                let maxW = 0;
                let maxH = 0;
                for (const m of monitors) {
                    if (m.width > maxW) maxW = m.width;
                    if (m.height > maxH) maxH = m.height;
                }
                subprocessMonitors.push({
                    videos: wpVideoPaths,
                    initialIndex: state.currentIndex,
                    width: maxW,
                    height: maxH,
                });
            }
        }

        if (subprocessMonitors.length === 0) {
            console.log('[Wallpaper:GTK4] No valid videos configured');
            this._setupWallpaperSettingsWatch();
            this._syncStatusIndicator();
            return;
        }
        this._wpSubprocessMonitorVideos = subprocessMonitors.map(m => m.videos || []);
        this._wpSubprocessStates = subprocessMonitors.map(m => ({
            videoPaths: Array.isArray(m.videos) ? m.videos : [],
            currentIndex: Number.isInteger(m.initialIndex) ? m.initialIndex : -1,
            randomOrder,
        }));

        const playerConfig = {
            scalingMode,
            volume,
            useVideorate,
            framerate,
            preferHwDecoder,
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
            this._debugDumpWindowSnapshot('wallpaper-map-callback');

            const themeContext = St.ThemeContext.get_for_stage(global.stage);
            const adjustedBlurRadius = blurRadius * themeContext.scale_factor;
            this._wpPositionSignals = [];

            // Use title-based monitor index — this is set explicitly by player.js
            // win.get_monitor() is not reliable here
            // Wayland may not have placed the window on the correct monitor yet.
            let reparentedCount = 0;
            const totalWindows = windows.length;
            
            const checkAllReparented = () => {
                if (reparentedCount === totalWindows) {
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
                    this._debugDumpWindowSnapshot('wallpaper-playing');

                    // Set up pause-when-hidden if enabled
                    if (pauseWhenHidden) {
                        // Mark as not ready initially to prevent immediate pausing
                        this._wpPauseWhenHiddenReady = false;
                        // Delay the initial check to avoid pausing immediately after startup
                        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                            this._setupPauseWhenHiddenSubprocess();
                            this._wpPauseWhenHiddenReady = true;
                            return GLib.SOURCE_REMOVE;
                        });
                    } else {
                        this._wpPauseWhenHiddenReady = false;
                    }
                    this._syncStatusIndicator();
                }
            };
            
            for (const win of windows) {
                const title = win.get_title() || '';
                const match = title.match(/^LiveLockPaper-(\d+)$/);
                const monitorIndex = match ? Number.parseInt(match[1], 10) : 0;

                const monitor = monitors[monitorIndex];
                if (!monitor) {
                    console.warn(`[Wallpaper:GTK4] No monitor at index ${monitorIndex}, skipping`);
                    reparentedCount++;
                    checkAllReparented();
                    continue;
                }

                // Position window on correct monitor immediately
                // This must happen before reparenting to ensure correct placement
                try {
                    win.move_resize_frame(false, monitor.x, monitor.y, monitor.width, monitor.height);
                } catch (_) {}

                // Ensure skip flags are set (they should already be set in player_process.js)
                try { win.set_skip_taskbar(true); } catch (_) {}
                try { win.set_skip_pager(true); } catch (_) {}

                // Reparent immediately - this prevents Mutter from moving the window
                // Once reparented, the window actor is under our control
                const windowActor = win.get_compositor_private();
                if (!windowActor) {
                    reparentedCount++;
                    checkAllReparented();
                    continue;
                }

                this._wpWindowActors[monitorIndex] = windowActor;
                const parent = windowActor.get_parent();
                if (parent) parent.remove_child(windowActor);

                    // Position the wrapper at the monitor's geometry.
                    // Do NOT use win.make_fullscreen() — it moves the window
                    // to Mutter's fullscreen layer (above the panel/dock) and
                    // can cause the compositor to reclaim the actor.
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

                    if (fadeInDuration > 0) wrapper.opacity = 0;

                    Main.layoutManager._backgroundGroup.add_child(wrapper);
                    Main.layoutManager._backgroundGroup.set_child_above_sibling(wrapper, null);

                    this._wpActors.push(wrapper);
                    reparentedCount++;
                    checkAllReparented();
            }
        }, (err) => {
            console.error(`[Wallpaper:GTK4] ${err}`);
            this._debugDumpWindowSnapshot('wallpaper-map-error');
            this._syncStatusIndicator();
        });

        this._setupWallpaperSettingsWatch();
        // Initialize sleep handling for wallpaper
        this._initWallpaperSleepHandler();
    }

    // Pause-when-hidden watchers for subprocess wallpaper.
    _setupPauseWhenHiddenSubprocess() {
        this._wpDesktopHidden = false;

        this._wpRestackedId = global.display.connect('restacked', () => {
            this._checkDesktopVisibilitySubprocess();
        });

        // Watch for window state changes (fullscreen, maximize, etc.)
        // Note: window-state-changed might not exist on all GNOME versions
        try {
            this._wpWindowStateChangedId = global.display.connect('window-state-changed', () => {
                this._checkDesktopVisibilitySubprocess();
            });
        } catch (e) {
            console.warn('[Wallpaper:GTK4] window-state-changed signal not available, using periodic check only');
            this._wpWindowStateChangedId = null;
        }

        // Periodic check (every 300ms) - this is the main mechanism
        this._wpVisibilityCheckId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            300,
            () => {
                this._checkDesktopVisibilitySubprocess();
                return GLib.SOURCE_CONTINUE;
            }
        );

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
        
        // Don't check immediately after setup - give wallpapers time to start
        if (!this._wpPauseWhenHiddenReady) return;

        const pauseMode = this._settings.get_int(Keys.PAUSE_WHEN_HIDDEN_MODE) ?? PauseWhenHiddenMode.ALL_MONITORS;
        if (pauseMode === PauseWhenHiddenMode.OFF) return;

        if (Main.overview.visible) {
            if (this._wpDesktopHidden) {
                this._wpDesktopHidden = false;
                this._wpPlayerProcess.play();
            }
            return;
        }

        const monitors = Main.layoutManager.monitors;
        const coverage = monitors.map(m => ({ index: m.index, covered: this._isMonitorFullyCovered(m.index) }));
        
        let shouldPause = false;
        if (pauseMode === PauseWhenHiddenMode.ALL_MONITORS) {
            shouldPause = coverage.every(c => c.covered);
        } else if (pauseMode === PauseWhenHiddenMode.ANY_MONITOR) {
            shouldPause = coverage.some(c => c.covered);
        }
        
        this._debugLogCoverageState('subprocess', coverage, shouldPause);

        if (shouldPause && !this._wpDesktopHidden) {
            this._wpDesktopHidden = true;
            this._wpPlayerProcess.pause();
            const modeText = pauseMode === PauseWhenHiddenMode.ALL_MONITORS ? 'all monitors' : 'any monitor';
            console.log(`[Wallpaper:GTK4] Desktop fully covered (${modeText}), pausing`);
        } else if (!shouldPause && this._wpDesktopHidden) {
            this._wpDesktopHidden = false;
            this._wpPlayerProcess.play();
            console.log(`[Wallpaper:GTK4] Desktop visible again, resuming`);
        }
    }

    // Watch wallpaper settings and trigger debounced restart.
    _setupWallpaperSettingsWatch() {
        // Disconnect existing watchers first
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
            Keys.DEBUG_PUSH_FRAME_DELIVERY,
            Keys.DEBUG_USE_GTK4_SINK,
        ];
        watchKeys.forEach(key => {
            const id = this._settings.connect('changed::' + key, () => {
                this._scheduleWallpaperRestart();
            });
            this._wpSettingsIds.push(id);
        });
        
        // Handle pause-when-hidden mode change separately (no restart needed)
        const pauseWhenHiddenId = this._settings.connect(`changed::${Keys.PAUSE_WHEN_HIDDEN_MODE}`, () => {
            // Just update the pause-when-hidden watchers without restarting wallpaper
            this._cleanupPauseWhenHidden();
            const pauseMode = this._settings.get_int(Keys.PAUSE_WHEN_HIDDEN_MODE) ?? PauseWhenHiddenMode.ALL_MONITORS;
            if (pauseMode !== PauseWhenHiddenMode.OFF) {
                // Set up watchers if wallpaper is already running
                this._wpPauseWhenHiddenReady = false;
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                    if (this._wpPlayerProcess) {
                        // Subprocess mode
                        this._setupPauseWhenHiddenSubprocess();
                    } else if (this._wpPipelines && this._wpPipelines.length > 0) {
                        // Appsink mode
                        this._setupPauseWhenHidden();
                    }
                    this._wpPauseWhenHiddenReady = true;
                    return GLib.SOURCE_REMOVE;
                });
            }
        });
        this._wpSettingsIds.push(pauseWhenHiddenId);
    }

    // Debounced wallpaper restart.
    _scheduleWallpaperRestart() {
        if (!this._active)
            return;
        if (this._wpRestartTimeout) {
            GLib.Source.remove(this._wpRestartTimeout);
        }
        this._wpRestartSerial = (this._wpRestartSerial ?? 0) + 1;
        const restartSerial = this._wpRestartSerial;
        this._wpRestartTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._wpRestartTimeout = null;
            if (!this._active)
                return GLib.SOURCE_REMOVE;
            if (restartSerial !== this._wpRestartSerial)
                return GLib.SOURCE_REMOVE;
            if (this._wpRestartInFlight) {
                this._wpRestartPending = true;
                return GLib.SOURCE_REMOVE;
            }
            this._wpRestartInFlight = true;
            try {
                console.log('[Wallpaper] Settings changed, restarting wallpaper...');
                console.log(`[Wallpaper:GTK4] diag marker: restart verbose=${this._isVerboseGtkHelperLoggingEnabled()} serial=${restartSerial}`);
                this._debugDumpWindowSnapshot('settings-restart-pre');
                this._refreshGtkHelperWindowHints('settings-restart-pre-teardown');
                const hadSubprocess = !!this._wpPlayerProcess;
                const previousWpPid = this._wpPlayerProcess?.pid ?? null;
                this._teardownWallpaper({ keepRestartState: true });
                const finishRestart = () => {
                    if (!this._active) {
                        this._wpRestartInFlight = false;
                        return GLib.SOURCE_REMOVE;
                    }
                    this._debugDumpWindowSnapshot('settings-restart-before-enable');
                    this._enableWallpaper();
                    this._debugDumpWindowSnapshot('settings-restart-after-enable');
                    // Re-assert skip_taskbar/skip_pager after a short delay
                    // in case Mutter resets them during compositor transitions.
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                        this._refreshGtkHelperWindowHints('settings-restart-500ms');
                        this._debugDumpWindowSnapshot('settings-restart-500ms');
                        // Only verify windows if using GTK4 sink (PlayerProcess)
                        // and only if we're not already in a restart
                        if (this._wpRestartInFlight || this._wpRestartTimeout) {
                            return GLib.SOURCE_REMOVE;
                        }
                        // Only verify windows for GTK4 sink (appsink doesn't use PlayerProcess)
                        if (!this._wpPlayerProcess) {
                            return GLib.SOURCE_REMOVE;
                        }
                        // Give windows more time to appear, especially when switching sinks
                        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
                            // Double-check we're still not in a restart
                            if (this._wpRestartInFlight || this._wpRestartTimeout || !this._active) {
                                return GLib.SOURCE_REMOVE;
                            }
                            // Only verify if we're still using GTK4 sink
                            if (!this._wpPlayerProcess) {
                                return GLib.SOURCE_REMOVE;
                            }
                            const expectedMonitors = Main.layoutManager.monitors.length;
                            const actualWindows = this._wpPlayerProcess._windows?.length ?? 0;
                            // Only retry if we have significantly fewer windows than expected
                            // Allow some tolerance for timing issues
                            if (actualWindows === 0 && expectedMonitors > 0) {
                                console.warn(`[Wallpaper:GTK4] No windows found, expected ${expectedMonitors}. This may be normal when switching sinks.`);
                                // Don't auto-retry - let user manually restart if needed
                                // Auto-retry can cause loops when switching sinks
                            }
                            return GLib.SOURCE_REMOVE;
                        });
                        return GLib.SOURCE_REMOVE;
                    });
                    this._wpRestartInFlight = false;
                    if (this._wpRestartPending) {
                        this._wpRestartPending = false;
                        this._scheduleWallpaperRestart();
                    }
                    return GLib.SOURCE_REMOVE;
                };
                if (hadSubprocess) {
                    // Drain old helper windows before respawn to avoid overlap
                    // races that can hide dock/top bar on some systems.
                    this._waitForGtkHelperDrain(previousWpPid, 3000, finishRestart);
                } else {
                    finishRestart();
                }
            } catch (e) {
                this._wpRestartInFlight = false;
                console.error(`[Wallpaper] Restart failed: ${e.message}\n${e.stack}`);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _hasGtkHelperWindows(pidHint = null) {
        try {
            const windowActors = global.get_window_actors();
            for (const wa of windowActors) {
                let win;
                try { win = wa.meta_window; } catch (_) { continue; }
                if (!win)
                    continue;
                const title = win.get_title?.() ?? '';
                const pid = win.get_pid?.() ?? 0;
                if (title.startsWith('LiveLockPaper-'))
                    return true;
                if (pidHint && pid === pidHint)
                    return true;
            }
        } catch (_) {}
        return false;
    }

    _waitForGtkHelperDrain(pidHint, timeoutMs, onDone) {
        if (this._wpHelperDrainTimeout) {
            GLib.Source.remove(this._wpHelperDrainTimeout);
            this._wpHelperDrainTimeout = null;
        }
        if (!this._hasGtkHelperWindows(pidHint)) {
            this._debugDumpWindowSnapshot('drain-skip-no-helper');
            onDone?.();
            return;
        }
        this._debugDumpWindowSnapshot('drain-start');
        const startUs = GLib.get_monotonic_time();
        this._wpHelperDrainTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, () => {
            if (!this._active) {
                this._wpHelperDrainTimeout = null;
                this._debugDumpWindowSnapshot('drain-abort-inactive');
                onDone?.();
                return GLib.SOURCE_REMOVE;
            }
            if (!this._hasGtkHelperWindows(pidHint)) {
                this._wpHelperDrainTimeout = null;
                this._debugDumpWindowSnapshot('drain-finished');
                onDone?.();
                return GLib.SOURCE_REMOVE;
            }
            const elapsedMs = Math.floor((GLib.get_monotonic_time() - startUs) / 1000);
            if (elapsedMs >= timeoutMs) {
                console.log(`[Wallpaper:GTK4] helper drain timed out at ${elapsedMs}ms; continuing restart`);
                this._wpHelperDrainTimeout = null;
                this._debugDumpWindowSnapshot('drain-timeout');
                onDone?.();
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    // Tear down wallpaper runtime without touching settings watchers.
    _teardownWallpaper({ keepRestartState = false } = {}) {
        this._debugDumpWindowSnapshot('teardown-start');
        if (this._wpRestartTimeout) {
            GLib.Source.remove(this._wpRestartTimeout);
            this._wpRestartTimeout = null;
        }
        if (this._wpHelperDrainTimeout) {
            GLib.Source.remove(this._wpHelperDrainTimeout);
            this._wpHelperDrainTimeout = null;
        }
        if (!keepRestartState) {
            this._wpRestartInFlight = false;
            this._wpRestartPending = false;
        }
        // Clean up pause-when-hidden watchers
        this._cleanupPauseWhenHidden();

        // Clean up wallpaper sleep handler
        if (this._wpSleepId) {
            if (this._isVerboseLoggingEnabled()) {
                console.log('[Wallpaper] Disconnecting wallpaper sleep handler during teardown');
            }
            this._loginManager?.disconnect(this._wpSleepId);
            this._wpSleepId = null;
        }

        // Subprocess player cleanup
        if (this._wpPlayerProcess) {
            // Disconnect position/scale watchers
            if (this._wpPositionSignals) {
                for (const entry of this._wpPositionSignals) {
                    if (entry.actor) {
                        // Actor signals (position/scale watchers)
                        for (const id of entry.ids) {
                            try { entry.actor.disconnect(id); } catch (_) {}
                        }
                    } else if (entry.win) {
                        // Window signals (position/maximize watchers) and timeouts
                        for (const id of entry.ids) {
                            try {
                                if (typeof id === 'number') {
                                    // Timeout ID
                                    GLib.source_remove(id);
                                } else {
                                    // Signal ID
                                    entry.win.disconnect(id);
                                }
                            } catch (_) {}
                        }
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
                    windowActor.hide();
                } catch (e) {}
            }
            this._wpWindowActors = {};
            this._wpPlayerProcess.destroy();
            this._wpPlayerProcess = null;
        }
        this._wpSubprocessStates = [];

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
        this._debugDumpWindowSnapshot('teardown-done');
    }

    // Pause-when-hidden

    // Set up visibility watchers.
    _setupPauseWhenHidden() {
        this._wpDesktopHidden = false;

        // Watch for window stacking changes
        this._wpRestackedId = global.display.connect('restacked', () => {
            this._checkDesktopVisibility();
        });

        // Watch for window state changes (fullscreen, maximize, etc.)
        // Note: window-state-changed might not exist on all GNOME versions
        try {
            this._wpWindowStateChangedId = global.display.connect('window-state-changed', () => {
                this._checkDesktopVisibility();
            });
        } catch (e) {
            console.warn('[Wallpaper] window-state-changed signal not available, using periodic check only');
            this._wpWindowStateChangedId = null;
        }

        // Periodic check (every 300ms) - this is the main mechanism
        this._wpVisibilityCheckId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            300,
            () => {
                this._checkDesktopVisibility();
                return GLib.SOURCE_CONTINUE;
            }
        );

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
        
        // Don't check immediately after setup - give wallpapers time to start
        if (!this._wpPauseWhenHiddenReady) return;

        // If overview is open, desktop is visible
        if (Main.overview.visible) {
            if (this._wpDesktopHidden) {
                this._wpDesktopHidden = false;
                this._wpPipelines.forEach(p => p.play());
                console.log('[Wallpaper] Desktop visible (overview), resuming');
            }
            return;
        }

        const pauseMode = this._settings.get_int(Keys.PAUSE_WHEN_HIDDEN_MODE) ?? PauseWhenHiddenMode.ALL_MONITORS;
        if (pauseMode === PauseWhenHiddenMode.OFF) return;

        const monitors = Main.layoutManager.monitors;
        const coverage = monitors.map(m => ({ index: m.index, covered: this._isMonitorFullyCovered(m.index) }));
        
        let shouldPause = false;
        if (pauseMode === PauseWhenHiddenMode.ALL_MONITORS) {
            shouldPause = coverage.every(c => c.covered);
        } else if (pauseMode === PauseWhenHiddenMode.ANY_MONITOR) {
            shouldPause = coverage.some(c => c.covered);
        }
        
        this._debugLogCoverageState('appsink', coverage, shouldPause);

        if (shouldPause && !this._wpDesktopHidden) {
            this._wpDesktopHidden = true;
            // Use the same pause method as the panel button
            this._wpPipelines.forEach(p => p.pause());
            const modeText = pauseMode === PauseWhenHiddenMode.ALL_MONITORS ? 'all monitors' : 'any monitor';
            console.log(`[Wallpaper] Desktop fully covered (${modeText}), pausing ${this._wpPipelines.length} pipeline(s)`);
        } else if (!shouldPause && this._wpDesktopHidden) {
            this._wpDesktopHidden = false;
            // Use the same play method as the panel button
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
                // Guard every access (actors can be disposed during transitions)
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
                
                // Skip if not on the target monitor
                if (win.get_monitor() !== monitorIndex) continue;
                
                // Only check normal windows (not desktop, dock, etc.)
                if (win.window_type !== Meta.WindowType.NORMAL) continue;
                
                // Check if window is fullscreen - this is the key check
                // Fullscreen apps will have is_fullscreen() = true
                const isFullscreen = win.is_fullscreen();
                if (isFullscreen) {
                    return true;
                }
                
                // Also check for maximized windows that cover the entire monitor
                if (win.maximized_horizontally && win.maximized_vertically) {
                    // Double-check geometry to ensure it actually covers the monitor
                    const monitor = Main.layoutManager.monitors[monitorIndex];
                    if (monitor) {
                        const frame = win.get_frame_rect();
                        // Check if window covers at least 95% of monitor
                        const monitorArea = monitor.width * monitor.height;
                        const frameArea = frame.width * frame.height;
                        const coverageRatio = monitorArea > 0 ? frameArea / monitorArea : 0;
                        if (coverageRatio >= 0.95) {
                            return true;
                        }
                    }
                }
            }
        } catch (e) {
            console.warn(`[Wallpaper] Error checking monitor coverage: ${e.message}`);
        }
        return false;
    }

    // Refresh helper-window hints: skip_taskbar and skip_pager.
    _refreshGtkHelperWindowHints(reason = 'unspecified') {
        try {
            const windowActors = global.get_window_actors();
            const wpPid = this._wpPlayerProcess?.pid ?? null;
            const lockPid = this._lockPlayerProcess?.pid ?? null;
            for (const wa of windowActors) {
                let win;
                try { win = wa.meta_window; } catch (e) { continue; }
                if (!win)
                    continue;
                const title = win.get_title?.() ?? '';
                const pid = win.get_pid?.() ?? 0;
                const isHelper = title.startsWith('LiveLockPaper-') ||
                    (wpPid && pid === wpPid) || (lockPid && pid === lockPid);
                if (!isHelper)
                    continue;

                // On Wayland, set_skip_taskbar() is read-only, so we override
                // the JS property getter to make dock extensions ignore our helpers
                if (!win.__llp_skipTaskbarOverride) {
                    try {
                        Object.defineProperty(win, 'skip_taskbar', {
                            get: () => true,
                            configurable: true,
                        });
                        // Also override the method form in case the dock calls it
                        win.is_skip_taskbar = () => true;
                        win.__llp_skipTaskbarOverride = true;
                    } catch (_) {}
                }
                try { win.set_skip_pager(true); } catch (_) {
                    try { win.skip_pager = true; } catch (_) {}
                }

                const isFs = win.is_fullscreen?.() ?? false;
                const isMaxH = !!win.maximized_horizontally;
                const isMaxV = !!win.maximized_vertically;
                const monIdx = win.get_monitor?.() ?? -1;

                // Always log helper state (not gated by verbose) so we can
                // diagnose dock/panel hide issues from the journal.
                console.log(
                    `[Wallpaper:GTK4] helper-state(${reason}) "${title}" pid=${pid} mon=${monIdx} ` +
                    `fs=${isFs} maxH=${isMaxH} maxV=${isMaxV} ` +
                    `skipT=${!!win.skip_taskbar} skipP=${!!win.skip_pager} ` +
                    `type=${win.window_type} override=${!!win.__llp_skipTaskbarOverride}`
                );
            }
        } catch (e) {}
    }

    _isVerboseGtkHelperLoggingEnabled() {
        return this._settings?.get_boolean?.(Keys.DEBUG_GTK_HELPER_LOGS) ?? false;
    }

    _isVerboseLoggingEnabled() {
        // Use the existing verbose GTK helper logs setting for all verbose logging
        return this._settings?.get_boolean?.(Keys.DEBUG_GTK_HELPER_LOGS) ?? false;
    }

    _debugLogCoverageState(kind, coverage, allCovered) {
        if (!this._isVerboseGtkHelperLoggingEnabled())
            return;
        const key = `${kind}|${allCovered}|${coverage.map(c => `${c.index}:${c.covered ? 1 : 0}`).join(',')}`;
        if (this._lastCoverageDebugKey === key)
            return;
        this._lastCoverageDebugKey = key;
        console.log(`[Wallpaper:GTK4] coverage(${kind}) allCovered=${allCovered} byMonitor=${coverage.map(c => `${c.index}:${c.covered ? 'covered' : 'clear'}`).join(' ')}`);
        this._debugDumpWindowSnapshot(`coverage-${kind}`);
    }

    _debugDumpWindowSnapshot(reason = 'snapshot') {
        if (!this._isVerboseGtkHelperLoggingEnabled())
            return;
        try {
            const rows = [];
            const windowActors = global.get_window_actors();
            const wpPid = this._wpPlayerProcess?.pid ?? null;
            const lockPid = this._lockPlayerProcess?.pid ?? null;
            for (const wa of windowActors) {
                let win;
                try { win = wa.meta_window; } catch (_) { continue; }
                if (!win)
                    continue;
                const title = win.get_title?.() ?? '';
                const pid = win.get_pid?.() ?? 0;
                const isHelper = title.startsWith('LiveLockPaper-') || (wpPid && pid === wpPid) || (lockPid && pid === lockPid);
                const isFullscreen = !!win.is_fullscreen?.();
                const isMaximized = !!(win.maximized_horizontally && win.maximized_vertically);
                const isInteresting = isHelper || isFullscreen || isMaximized || win.window_type === Meta.WindowType.NORMAL;
                if (!isInteresting)
                    continue;
                rows.push(
                    `title="${title}" pid=${pid} mon=${win.get_monitor?.()} type=${win.window_type} ` +
                    `fs=${isFullscreen} max=${isMaximized} min=${!!win.minimized} ` +
                    `skipT=${!!win.skip_taskbar} skipP=${!!win.skip_pager} helper=${isHelper}`
                );
            }
            console.log(`[Wallpaper:GTK4] snapshot(${reason}) mode=${Main.sessionMode.currentMode} wpPid=${wpPid ?? 0} lockPid=${lockPid ?? 0} rows=${rows.length}`);
            rows.forEach((line, idx) => {
                console.log(`[Wallpaper:GTK4]   [${idx}] ${line}`);
            });
        } catch (e) {
            console.error(`[Wallpaper:GTK4] snapshot(${reason}) failed: ${e.message}`);
        }
    }

    // Disconnect pause-when-hidden handlers.
    _cleanupPauseWhenHidden() {
        if (this._wpRestackedId) {
            global.display.disconnect(this._wpRestackedId);
            this._wpRestackedId = null;
        }
        if (this._wpWindowStateChangedId) {
            global.display.disconnect(this._wpWindowStateChangedId);
            this._wpWindowStateChangedId = null;
        }
        if (this._wpVisibilityCheckId) {
            GLib.source_remove(this._wpVisibilityCheckId);
            this._wpVisibilityCheckId = null;
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
            }
            this._wallpaperWasPaused = false;
            this._wpDesktopHidden = false;
            // Re-check visibility after a short delay.
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                if (hasPipelines) this._checkDesktopVisibility();
                if (hasSubprocess) {
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
                    this._checkDesktopVisibilitySubprocess();
                }
                if (hasPipelines && this._wpPipelines?.length > 0) {
                    this._wpPipelines.forEach(p => p.play());
                    this._checkDesktopVisibility();
                }
                this._syncStatusIndicator();
                return GLib.SOURCE_REMOVE;
            });
            // After lock-screen windows are gone, clear auto-maximize on
            // wallpaper helpers so the dock doesn't dodge them.
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, () => {
                if (Main.sessionMode.currentMode !== 'user')
                    return GLib.SOURCE_REMOVE;
                this._refreshGtkHelperWindowHints('post-resume-600ms');
                return GLib.SOURCE_REMOVE;
            });
            this._syncStatusIndicator();
        } else {
            // If pipelines are missing, do a full enable.
            this._enableWallpaper();
        }
    }

    _disableWallpaper() {
        // Stop all wallpaper play count tracking
        for (const [key, tracking] of this._playCountTracking.entries()) {
            if (tracking.metadataKey === Keys.WALLPAPER_VIDEO_METADATA) {
                this._stopPlayCountTracking(key);
            }
        }
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

    _getNumericMetadataValue(value) {
        if (value === null || value === undefined)
            return null;
        if (typeof value === 'number')
            return Number.isFinite(value) ? value : null;
        if (typeof value === 'object') {
            try {
                if (typeof value.get_int32 === 'function')
                    return value.get_int32();
                if (typeof value.get_uint32 === 'function')
                    return value.get_uint32();
                if (typeof value.get_double === 'function')
                    return value.get_double();
                if (typeof value.recursiveUnpack === 'function')
                    return this._getNumericMetadataValue(value.recursiveUnpack());
            } catch (_) {}
        }
        return null;
    }

    // Play count tracking: hybrid approach (50% duration OR 10 seconds, whichever comes first)
    _playCountTracking = new Map(); // key: `${metadataKey}:${videoPath}`, value: { timerId, startTime, metadataKey, videoPath }

    _startPlayCountTracking(metadataKey, videoPath) {
        if (!videoPath || !this._settings)
            return;

        // Stop any existing tracking for this video
        const trackingKey = `${metadataKey}:${videoPath}`;
        this._stopPlayCountTracking(trackingKey);

        // Get video duration from metadata
        let duration = null;
        try {
            const metadata = this._settings.get_value(metadataKey).recursiveUnpack() ?? {};
            if (metadata[videoPath]) {
                duration = this._getNumericMetadataValue(metadata[videoPath].duration);
            }
        } catch (_) {}

        // Calculate thresholds
        const minTimeSeconds = 10; // Minimum 10 seconds
        const minDurationPercent = 0.5; // 50% of video duration
        const minDurationSeconds = duration ? Math.max(1, Math.round(duration * minDurationPercent)) : null;

        // If video is very short (< 10s), count immediately
        if (duration && duration < minTimeSeconds) {
            this._incrementPlayCountForMetadataKey(metadataKey, videoPath);
            return;
        }

        // Start tracking
        const startTime = Date.now();
        const tracking = {
            startTime,
            metadataKey,
            videoPath,
            minTimeSeconds,
            minDurationSeconds,
            duration,
        };

        // Check threshold every second
        const timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            return this._checkPlayCountThreshold(trackingKey, tracking);
        });

        tracking.timerId = timerId;
        this._playCountTracking.set(trackingKey, tracking);
    }

    _checkPlayCountThreshold(trackingKey, tracking) {
        const { startTime, metadataKey, videoPath, minTimeSeconds, minDurationSeconds, duration } = tracking;
        const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);

        // Check if minimum time threshold reached
        if (elapsedSeconds >= minTimeSeconds) {
            this._incrementPlayCountForMetadataKey(metadataKey, videoPath);
            this._stopPlayCountTracking(trackingKey);
            return GLib.SOURCE_REMOVE;
        }

        // Check if duration percentage threshold reached (if we have duration)
        if (minDurationSeconds !== null && elapsedSeconds >= minDurationSeconds) {
            this._incrementPlayCountForMetadataKey(metadataKey, videoPath);
            this._stopPlayCountTracking(trackingKey);
            return GLib.SOURCE_REMOVE;
        }

        // Continue tracking
        return GLib.SOURCE_CONTINUE;
    }

    _stopPlayCountTracking(trackingKey) {
        const tracking = this._playCountTracking.get(trackingKey);
        if (tracking && tracking.timerId) {
            GLib.Source.remove(tracking.timerId);
            this._playCountTracking.delete(trackingKey);
        }
    }

    _stopAllPlayCountTracking() {
        for (const [key, tracking] of this._playCountTracking.entries()) {
            if (tracking.timerId) {
                GLib.Source.remove(tracking.timerId);
            }
        }
        this._playCountTracking.clear();
    }

    _incrementPlayCountForMetadataKey(metadataKey, videoPath) {
        if (!videoPath || !this._settings)
            return;
        try {
            let metadata = {};
            try {
                metadata = this._settings.get_value(metadataKey).recursiveUnpack() ?? {};
            } catch (_) {
                metadata = {};
            }
            if (!metadata[videoPath] || typeof metadata[videoPath] !== 'object')
                metadata[videoPath] = {};

            const currentCount = this._getNumericMetadataValue(metadata[videoPath].playCount) ?? 0;
            metadata[videoPath].playCount = currentCount + 1;

            const variantDict = {};
            for (const [key, value] of Object.entries(metadata)) {
                const valueDict = {};
                const fps = this._getNumericMetadataValue(value?.fps);
                const width = this._getNumericMetadataValue(value?.width);
                const height = this._getNumericMetadataValue(value?.height);
                const duration = this._getNumericMetadataValue(value?.duration);
                const playCount = this._getNumericMetadataValue(value?.playCount) ?? 0;

                if (fps !== null) valueDict.fps = new GLib.Variant('i', Math.round(fps));
                if (width !== null) valueDict.width = new GLib.Variant('i', Math.round(width));
                if (height !== null) valueDict.height = new GLib.Variant('i', Math.round(height));
                if (duration !== null) valueDict.duration = new GLib.Variant('i', Math.round(duration));
                valueDict.playCount = new GLib.Variant('i', Math.max(0, Math.round(playCount)));
                variantDict[key] = new GLib.Variant('a{sv}', valueDict);
            }

            this._settings.set_value(metadataKey, new GLib.Variant('a{sv}', variantDict));
        } catch (e) {
            console.log(`[LiveLockPaper] Error incrementing play count for ${videoPath}: ${e}`);
        }
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

        // Stop tracking previous video for this monitor (before currentIndex is updated)
        const prevIndex = state.currentIndex >= 0 ? state.currentIndex : 0;
        const prevVideoPath = state.videoPaths[prevIndex];
        if (prevVideoPath) {
            this._stopPlayCountTracking(`${Keys.WALLPAPER_VIDEO_METADATA}:${prevVideoPath}`);
        }

        const newVideoPath = this._wpSelectNextVideoFor(state);
        if (!newVideoPath) return;

        console.log(`[Wallpaper] Pipeline ${pipelineIndex} switching to: ${newVideoPath.split('/').pop()}`);

        const framerate = this._getWallpaperFramerate(newVideoPath);
        this._startPlayCountTracking(Keys.WALLPAPER_VIDEO_METADATA, newVideoPath);

        if (this._wpPipelines && this._wpPipelines[pipelineIndex]) {
            this._wpPipelines[pipelineIndex].changeVideo(newVideoPath, framerate);
        }
    }
}
