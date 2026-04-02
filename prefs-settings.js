import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {Keys, VideoRenderer} from './enums.js';
import {FADE_IN_DURATION_MS_MAX, FADE_IN_DURATION_MS_STEP, LOCK_TEXT_FONT_WEIGHT_CHOICES, LOCK_TEXT_FONT_STYLE_CHOICES, MANUAL_FPS_MAX, MANUAL_FPS_MIN} from './prefs-constants.js';
import {box} from './prefs-ui-helpers.js';
/** Settings page cards, expanders, diagnostics, logs. */
export const PrefsSettingsMixin = {
_buildSettingsPage() {
    const page = new Adw.PreferencesPage({title: 'Settings', name: 'settings', icon_name: 'preferences-system-symbolic'});
    const group = new Adw.PreferencesGroup();
    const wrap = box(Gtk.Orientation.VERTICAL, 16, true, false);
    wrap.add_css_class('llp-page-wrap');
    wrap.add_css_class('llp-page-stack');
    wrap.set_hexpand(true);

    const cols = box(Gtk.Orientation.HORIZONTAL, 16, true, false);
    cols.set_hexpand(true);
    try { cols.set_homogeneous(true); } catch (e) {}
    const leftCol = box(Gtk.Orientation.VERTICAL, 16, true, false);
    const rightCol = box(Gtk.Orientation.VERTICAL, 16, true, false);
    leftCol.set_hexpand(true);
    rightCol.set_hexpand(true);
    cols.append(leftCol);
    cols.append(rightCol);

    const addLeft = card => { card.add_css_class('llp-settings-panel'); leftCol.append(card); };
    const addRight = card => { card.add_css_class('llp-settings-panel'); rightCol.append(card); };

    const hasKey = key => this._hasSettingKey(key);
    const getB = (key, fallback = false) => this._getSettingBool(key, fallback);
    const getI = (key, fallback = 0) => this._getSettingInt(key, fallback);
    const getD = (key, fallback = 0) => this._getSettingDouble(key, fallback);
    const getS = (key, fallback = '') => this._getSettingString(key, fallback);
    const setB = (key, value) => { try { if (hasKey(key)) this._settings.set_boolean(key, !!value); } catch (e) {} };
    const setI = (key, value) => { try { if (hasKey(key)) this._settings.set_int(key, value | 0); } catch (e) {} };
    const setD = (key, value) => { try { if (hasKey(key)) this._settings.set_double(key, Number(value) || 0); } catch (e) {} };
    const setS = (key, value) => { try { if (hasKey(key)) this._settings.set_string(key, `${value ?? ''}`); } catch (e) {} };

    const bindSensitivity = (widget, keys, fn) => {
        const refresh = () => {
            try { widget.set_sensitive(!!fn()); } catch (e) {}
        };
        refresh();
        for (const key of keys || []) {
            if (!hasKey(key))
                continue;
            try { this._settings.connect(`changed::${key}`, refresh); } catch (e) {}
        }
        return refresh;
    };

    const manualFpsSubtitle = 'Manual framerate when Auto FPS is off. Type a value or use the stepper.';
    const clampManualFps = v => Math.max(MANUAL_FPS_MIN, Math.min(MANUAL_FPS_MAX, v));
    const addManualFpsRow = (section, framerateKey, autoFpsKey) => {
        const row = this._adwSpinSettingsRow(
            'FPS',
            manualFpsSubtitle,
            clampManualFps(this._settings.get_int(framerateKey)),
            MANUAL_FPS_MIN,
            MANUAL_FPS_MAX,
            1,
            value => this._settings.set_int(framerateKey, value),
            0,
            'fps',
        );
        section.add(row);
        bindSensitivity(row, [autoFpsKey], () => !getB(autoFpsKey, false));
    };

    const playlistPathCount = v => {
        const arr = Array.isArray(v) ? v : (v ? [v] : []);
        return arr.filter(p => p && String(p).trim()).length;
    };
    const loopAllowedForPerMonitorConfig = cfg => {
        for (const paths of Object.values(cfg || {})) {
            if (playlistPathCount(paths) > 1)
                return false;
        }
        return true;
    };
    const loopToggleAllowedLock = () => {
        try {
            if (hasKey(Keys.LOCKSCREEN_PER_MONITOR) && this._settings.get_boolean(Keys.LOCKSCREEN_PER_MONITOR))
                return loopAllowedForPerMonitorConfig(this._getStringMapConfig(Keys.LOCKSCREEN_PER_MONITOR_CONFIG));
        } catch (e) {}
        return playlistPathCount(this._safeGetStrv(Keys.VIDEO_PATHS)) <= 1;
    };
    const loopToggleAllowedWallpaper = () => {
        try {
            if (hasKey(Keys.WALLPAPER_PER_MONITOR) && this._settings.get_boolean(Keys.WALLPAPER_PER_MONITOR))
                return loopAllowedForPerMonitorConfig(this._getStringMapConfig(Keys.WALLPAPER_PER_MONITOR_CONFIG));
        } catch (e) {}
        return playlistPathCount(this._safeGetStrv(Keys.WALLPAPER_VIDEO_PATHS)) <= 1;
    };
    const bindLoopClipRow = (row, watchKeys, allowedFn, subtitleOk, subtitleNa) => {
        const refresh = () => {
            const ok = !!allowedFn();
            try {
                row.set_sensitive(ok);
                row.subtitle = ok ? subtitleOk : subtitleNa;
            } catch (e) {}
        };
        refresh();
        for (const key of watchKeys) {
            if (!hasKey(key))
                continue;
            try { this._settings.connect(`changed::${key}`, refresh); } catch (e) {}
        }
    };
    const loopClipSubNa = 'Not applicable — with multiple clips the playlist advances automatically.';

    const resetPlayCounts = key => {
        if (!hasKey(key))
            return;
        try {
            const raw = getS(key, '{}');
            const data = JSON.parse(raw || '{}');
            for (const [path, item] of Object.entries(data || {})) {
                if (item && typeof item === 'object')
                    data[path] = {...item, playCount: 0};
            }
            setS(key, JSON.stringify(data));
        } catch (e) {}
    };

    const timeoutValues = [0, 60, 300, 600, 900, 1800, 3600];
    const timeoutLabels = ['Never', '1 min', '5 min', '10 min', '15 min', '30 min', '60 min'];
    const timeoutIndex = value => Math.max(0, timeoutValues.indexOf(value) >= 0 ? timeoutValues.indexOf(value) : 0);

    const lockGroup = new Adw.PreferencesGroup({
        title: 'Lock Screen',
        description: 'Video playlist, playback, and related options for the lock screen.',
    });
    lockGroup.add_css_class('llp-settings-card');

    const lockGeneral = this._makeSettingsExpander('Playback and layout', 'Enable the lock screen playlist and tune how clips play.');
    lockGeneral.add(this._adwSwitchSettingsRow('Enabled', 'Use videos on the lock screen.', this._settings.get_boolean(Keys.LOCKSCREEN_ENABLED), active => this._settings.set_boolean(Keys.LOCKSCREEN_ENABLED, active)));
    lockGeneral.add(this._adwSwitchSettingsRow('Random order', 'Play lock screen clips in random order.', this._settings.get_boolean(Keys.VIDEO_RANDOM_ORDER), active => this._settings.set_boolean(Keys.VIDEO_RANDOM_ORDER, active)));
    const lockLoopSubOk = 'Replay the current lock screen clip when it ends.';
    const lockLoopRow = this._adwSwitchSettingsRow('Loop current clip', lockLoopSubOk, this._settings.get_boolean(Keys.LOOPED), active => this._settings.set_boolean(Keys.LOOPED, active));
    lockGeneral.add(lockLoopRow);
    bindLoopClipRow(
        lockLoopRow,
        [Keys.VIDEO_PATHS, Keys.LOCKSCREEN_PER_MONITOR, Keys.LOCKSCREEN_PER_MONITOR_CONFIG],
        loopToggleAllowedLock,
        lockLoopSubOk,
        loopClipSubNa,
    );
    lockGeneral.add(this._adwSwitchSettingsRow('Auto FPS', 'Use the clip native framerate when possible.', this._settings.get_boolean(Keys.VIDEO_AUTO_FPS), active => this._settings.set_boolean(Keys.VIDEO_AUTO_FPS, active)));
    addManualFpsRow(lockGeneral, Keys.FRAMERATE, Keys.VIDEO_AUTO_FPS);
    lockGeneral.add(this._adwDropDownSettingsRow('Scaling mode', 'Choose how the video fits the screen.', ['Stretch', 'Fit', 'Cover'], this._settings.get_int(Keys.SCALING_MODE), value => this._settings.set_int(Keys.SCALING_MODE, value)));
    lockGeneral.add(this._adwScaleSettingsRow('Volume', 'Playback volume used on lock screen.', this._settings.get_int(Keys.AUDIO_VOLUME), 0, 100, 1, value => this._settings.set_int(Keys.AUDIO_VOLUME, value), value => `${value}%`));
    lockGeneral.add(this._adwScaleSettingsRow('Fade in', 'Fade-in duration for lock screen playback.', Math.min(FADE_IN_DURATION_MS_MAX, Math.max(0, this._settings.get_int(Keys.FADE_IN_DURATION))), 0, FADE_IN_DURATION_MS_MAX, FADE_IN_DURATION_MS_STEP, value => this._settings.set_int(Keys.FADE_IN_DURATION, value), value => `${value} ms`));
    if (hasKey('lockscreen-disable-on-battery') && this._hasBatteryDevice())
        lockGeneral.add(this._adwSwitchSettingsRow('Disable on battery', 'Pause lock screen video while on battery power.', this._settings.get_boolean(Keys.LOCKSCREEN_DISABLE_ON_BATTERY), active => this._settings.set_boolean(Keys.LOCKSCREEN_DISABLE_ON_BATTERY, active)));
    lockGeneral.add(this._adwLabelSuffixRow('Current playlist size', 'Number of clips currently assigned to lock screen.', `${this._safeGetStrv(Keys.VIDEO_PATHS).length} clips`));
    lockGroup.add(lockGeneral.expander);

    if (hasKey('background-video-blur-radius') || hasKey('background-video-blur-brightness')) {
        const section = this._makeSettingsExpander('Appearance', 'Blur controls for the lock screen background.');
        if (hasKey('background-video-blur-radius'))
            section.add(this._adwScaleSettingsRow('Blur radius', 'Amount of blur behind the lock screen video.', getI('background-video-blur-radius', 0), 0, 100, 1, value => setI('background-video-blur-radius', value), value => `${value}px`));
        let blurBrightnessRow = null;
        if (hasKey('background-video-blur-brightness')) {
            blurBrightnessRow = this._adwScaleSettingsRow('Blur brightness', 'Brightness used when blur is enabled.', Math.round(getD('background-video-blur-brightness', 1) * 100), 0, 100, 1, value => setD('background-video-blur-brightness', value / 100), value => `${value}%`);
            section.add(blurBrightnessRow);
            bindSensitivity(blurBrightnessRow, ['background-video-blur-radius'], () => getI('background-video-blur-radius', 0) > 0);
        }
        lockGroup.add(section.expander);
    }

    if (hasKey('prompt-pause-video') || hasKey('prompt-change-blur') || hasKey('prompt-grayscale')) {
        const section = this._makeSettingsExpander('Password prompt', 'How lock screen playback should behave when the password prompt appears.');
        if (hasKey('prompt-pause-video'))
            section.add(this._adwSwitchSettingsRow('Pause video', 'Pause the lock screen video when the prompt is visible.', getB('prompt-pause-video', false), active => setB('prompt-pause-video', active)));
        if (hasKey('prompt-grayscale'))
            section.add(this._adwSwitchSettingsRow('Grayscale', 'Apply grayscale while the prompt is visible.', getB('prompt-grayscale', false), active => setB('prompt-grayscale', active)));
        if (hasKey('prompt-change-blur'))
            section.add(this._adwSwitchSettingsRow('Change blur', 'Switch to a dedicated blur style when the prompt shows.', getB('prompt-change-blur', false), active => setB('prompt-change-blur', active)));
        let promptBlurRadiusRow = null;
        let promptBlurBrightnessRow = null;
        let promptBlurDurationRow = null;
        if (hasKey('prompt-blur-radius')) {
            promptBlurRadiusRow = this._adwScaleSettingsRow('Prompt blur radius', 'Blur radius used while the prompt is visible.', getI('prompt-blur-radius', 0), 0, 100, 1, value => setI('prompt-blur-radius', value), value => `${value}px`);
            section.add(promptBlurRadiusRow);
        }
        if (hasKey('prompt-blur-brightness')) {
            promptBlurBrightnessRow = this._adwScaleSettingsRow('Prompt blur brightness', 'Blur brightness used while the prompt is visible.', Math.round(getD('prompt-blur-brightness', 1) * 100), 0, 100, 1, value => setD('prompt-blur-brightness', value / 100), value => `${value}%`);
            section.add(promptBlurBrightnessRow);
        }
        if (hasKey('prompt-blur-anim-duration')) {
            promptBlurDurationRow = this._adwScaleSettingsRow('Blur change animation', 'Animation duration for the prompt blur transition.', getI('prompt-blur-anim-duration', 250), 0, 5000, 10, value => setI('prompt-blur-anim-duration', value), value => `${value} ms`);
            section.add(promptBlurDurationRow);
        }
        for (const row of [promptBlurRadiusRow, promptBlurBrightnessRow, promptBlurDurationRow]) {
            if (row)
                bindSensitivity(row, ['prompt-change-blur'], () => getB('prompt-change-blur', false));
        }
        lockGroup.add(section.expander);
    }

    if (hasKey('lockscreen-keep-awake-enabled') || hasKey('lockscreen-keep-awake-timeout-seconds')) {
        const section = this._makeSettingsExpander('Keep awake', 'Prevent the screen from blanking too quickly while Live LockPaper is active.');
        let onlyAcRow = null;
        let timeoutRow = null;
        if (hasKey('lockscreen-keep-awake-enabled'))
            section.add(this._adwSwitchSettingsRow('Enable keep awake', 'Keep the screen awake while the lock screen playlist is active.', getB('lockscreen-keep-awake-enabled', false), active => setB('lockscreen-keep-awake-enabled', active)));
        if (hasKey('lockscreen-keep-awake-only-on-ac') && this._hasBatteryDevice()) {
            onlyAcRow = this._adwSwitchSettingsRow('Only on AC', 'Only keep the screen awake when the system is on external power.', getB('lockscreen-keep-awake-only-on-ac', false), active => setB('lockscreen-keep-awake-only-on-ac', active));
            section.add(onlyAcRow);
        }
        if (hasKey('lockscreen-keep-awake-timeout-seconds')) {
            timeoutRow = this._adwDropDownSettingsRow('Timeout before blank', 'How long to wait before allowing the screen to blank again.', timeoutLabels, timeoutIndex(getI('lockscreen-keep-awake-timeout-seconds', 0)), index => setI('lockscreen-keep-awake-timeout-seconds', timeoutValues[Math.max(0, Math.min(timeoutValues.length - 1, index))]));
            section.add(timeoutRow);
        }
        for (const row of [onlyAcRow, timeoutRow]) {
            if (row)
                bindSensitivity(row, ['lockscreen-keep-awake-enabled'], () => getB('lockscreen-keep-awake-enabled', false));
        }
        lockGroup.add(section.expander);
    }

    if (hasKey('lockscreen-text-customize-enabled')) {
        const section = this._makeSettingsExpander('Lock screen text', 'Customize the lock screen time, date, hint, and command output blocks.');
        section.add(this._adwSwitchSettingsRow('Customize lock screen text', 'Enable custom lock screen text styling and formats.', getB('lockscreen-text-customize-enabled', false), active => setB('lockscreen-text-customize-enabled', active)));

        const appendTextGroup = (title, subtitle) => {
            const sub = new Adw.ExpanderRow({title, subtitle});
            section.expander.add_row(sub);
            return sub;
        };

        const cmdExp = appendTextGroup('Command output', 'Command text shown on the lock screen.');
        if (hasKey('lockscreen-text-hide-cmd'))
            cmdExp.add_row(this._adwSwitchSettingsRow('Hide command output', 'Hide the command output block entirely.', getB('lockscreen-text-hide-cmd', false), active => setB('lockscreen-text-hide-cmd', active)));
        if (hasKey('lockscreen-text-cmd-color'))
            cmdExp.add_row(this._adwColorPickerSettingsRow('Color', 'Text color for command output.', getS('lockscreen-text-cmd-color', '#D7CB8F'), value => setS('lockscreen-text-cmd-color', value)));
        if (hasKey('lockscreen-text-cmd-size'))
            cmdExp.add_row(this._adwSpinSettingsRow('Font size', 'Font size for command output.', getI('lockscreen-text-cmd-size', 18), 10, 96, 1, value => setI('lockscreen-text-cmd-size', value)));
        if (hasKey('lockscreen-text-cmd-font'))
            cmdExp.add_row(this._adwLockTextFontFamilyDropDownRow('Font family', 'Font family for command output.', getS('lockscreen-text-cmd-font', ''), value => setS('lockscreen-text-cmd-font', value)));
        if (hasKey('lockscreen-text-cmd-weight'))
            cmdExp.add_row(this._adwLockTextChoiceDropDownRow('Weight', 'Font weight for command output.', LOCK_TEXT_FONT_WEIGHT_CHOICES, getS('lockscreen-text-cmd-weight', ''), value => setS('lockscreen-text-cmd-weight', value)));
        if (hasKey('lockscreen-text-cmd-style'))
            cmdExp.add_row(this._adwLockTextChoiceDropDownRow('Style', 'Font style for command output.', LOCK_TEXT_FONT_STYLE_CHOICES, getS('lockscreen-text-cmd-style', ''), value => setS('lockscreen-text-cmd-style', value)));
        if (hasKey('lockscreen-text-cmd-command')) {
            const greetingCmdPreset = 'hour=$(date +%H); if [ "$hour" -lt 12 ]; then greeting="Morning"; elif [ "$hour" -lt 18 ]; then greeting="Afternoon"; else greeting="Evening"; fi; name=$(whoami); name=$(echo "$name" | awk \'{print toupper(substr($0,1,1)) substr($0,2)}\'); echo "Good $greeting $name"';
            const cmdPlaceholder = 'echo "Hello $(whoami)"';
            const cmdEntry = this._makeEntryControl(getS('lockscreen-text-cmd-command', ''), value => setS('lockscreen-text-cmd-command', value), cmdPlaceholder);
            const cmdRow = new Adw.ActionRow({title: 'Command', subtitle: 'Shell command used for the command output block.'});
            try { cmdEntry.set_hexpand(true); cmdEntry.set_width_chars(28); } catch (e) {}
            cmdRow.add_suffix(cmdEntry);
            cmdExp.add_row(cmdRow);
            const presetBtn = new Gtk.Button({label: 'Use greeting preset'});
            try { presetBtn.add_css_class('suggested-action'); } catch (ePb) {}
            try { presetBtn.set_valign(Gtk.Align.CENTER); } catch (ePv) {}
            try { presetBtn.set_vexpand(false); } catch (ePe) {}
            presetBtn.connect('clicked', () => {
                try { cmdEntry.set_text(greetingCmdPreset); } catch (e) {}
                setS('lockscreen-text-cmd-command', greetingCmdPreset);
            });
            const presetSuffix = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER, vexpand: false});
            presetSuffix.append(presetBtn);
            const presetRow = new Adw.ActionRow({title: 'Greeting preset', subtitle: 'Insert a sample time-based greeting command.'});
            presetRow.add_suffix(presetSuffix);
            cmdExp.add_row(presetRow);
        }

        const timeExp = appendTextGroup('Time', 'Time block formatting and style.');
        if (hasKey('lockscreen-text-hide-time'))
            timeExp.add_row(this._adwSwitchSettingsRow('Hide time', 'Hide the time block entirely.', getB('lockscreen-text-hide-time', false), active => setB('lockscreen-text-hide-time', active)));
        if (hasKey('lockscreen-text-time-color'))
            timeExp.add_row(this._adwColorPickerSettingsRow('Color', 'Text color for the time block.', getS('lockscreen-text-time-color', '#8ED78F'), value => setS('lockscreen-text-time-color', value)));
        if (hasKey('lockscreen-text-time-size'))
            timeExp.add_row(this._adwSpinSettingsRow('Font size', 'Font size for the time block.', getI('lockscreen-text-time-size', 72), 12, 240, 1, value => setI('lockscreen-text-time-size', value)));
        if (hasKey('lockscreen-text-time-font'))
            timeExp.add_row(this._adwLockTextFontFamilyDropDownRow('Font family', 'Font family for the time block.', getS('lockscreen-text-time-font', ''), value => setS('lockscreen-text-time-font', value)));
        if (hasKey('lockscreen-text-time-weight'))
            timeExp.add_row(this._adwLockTextChoiceDropDownRow('Weight', 'Font weight for the time block.', LOCK_TEXT_FONT_WEIGHT_CHOICES, getS('lockscreen-text-time-weight', ''), value => setS('lockscreen-text-time-weight', value)));
        if (hasKey('lockscreen-text-time-style'))
            timeExp.add_row(this._adwLockTextChoiceDropDownRow('Style', 'Font style for the time block.', LOCK_TEXT_FONT_STYLE_CHOICES, getS('lockscreen-text-time-style', ''), value => setS('lockscreen-text-time-style', value)));
        if (hasKey('lockscreen-text-time-format'))
            timeExp.add_row(this._adwEntrySettingsRow('Format', 'GLib DateTime format for the time block.', getS('lockscreen-text-time-format', '%H:%M'), value => setS('lockscreen-text-time-format', value), '%H:%M'));

        const dateExp = appendTextGroup('Date', 'Date block formatting and style.');
        if (hasKey('lockscreen-text-hide-date'))
            dateExp.add_row(this._adwSwitchSettingsRow('Hide date', 'Hide the date block entirely.', getB('lockscreen-text-hide-date', false), active => setB('lockscreen-text-hide-date', active)));
        if (hasKey('lockscreen-text-date-color'))
            dateExp.add_row(this._adwColorPickerSettingsRow('Color', 'Text color for the date block.', getS('lockscreen-text-date-color', '#F2675D'), value => setS('lockscreen-text-date-color', value)));
        if (hasKey('lockscreen-text-date-size'))
            dateExp.add_row(this._adwSpinSettingsRow('Font size', 'Font size for the date block.', getI('lockscreen-text-date-size', 22), 10, 128, 1, value => setI('lockscreen-text-date-size', value)));
        if (hasKey('lockscreen-text-date-font'))
            dateExp.add_row(this._adwLockTextFontFamilyDropDownRow('Font family', 'Font family for the date block.', getS('lockscreen-text-date-font', ''), value => setS('lockscreen-text-date-font', value)));
        if (hasKey('lockscreen-text-date-weight'))
            dateExp.add_row(this._adwLockTextChoiceDropDownRow('Weight', 'Font weight for the date block.', LOCK_TEXT_FONT_WEIGHT_CHOICES, getS('lockscreen-text-date-weight', ''), value => setS('lockscreen-text-date-weight', value)));
        if (hasKey('lockscreen-text-date-style'))
            dateExp.add_row(this._adwLockTextChoiceDropDownRow('Style', 'Font style for the date block.', LOCK_TEXT_FONT_STYLE_CHOICES, getS('lockscreen-text-date-style', ''), value => setS('lockscreen-text-date-style', value)));
        if (hasKey('lockscreen-text-date-format'))
            dateExp.add_row(this._adwEntrySettingsRow('Format', 'GLib DateTime format for the date block.', getS('lockscreen-text-date-format', '%A, %d %B'), value => setS('lockscreen-text-date-format', value), '%A, %d %B'));

        const hintExp = appendTextGroup('Hint', 'Hint block appearance.');
        if (hasKey('lockscreen-text-hide-hint'))
            hintExp.add_row(this._adwSwitchSettingsRow('Hide hint', 'Hide the hint block entirely.', getB('lockscreen-text-hide-hint', false), active => setB('lockscreen-text-hide-hint', active)));
        if (hasKey('lockscreen-text-hint-color'))
            hintExp.add_row(this._adwColorPickerSettingsRow('Color', 'Text color for the hint block.', getS('lockscreen-text-hint-color', '#BEDA77'), value => setS('lockscreen-text-hint-color', value)));
        if (hasKey('lockscreen-text-hint-size'))
            hintExp.add_row(this._adwSpinSettingsRow('Font size', 'Font size for the hint block.', getI('lockscreen-text-hint-size', 14), 10, 96, 1, value => setI('lockscreen-text-hint-size', value)));
        if (hasKey('lockscreen-text-hint-font'))
            hintExp.add_row(this._adwLockTextFontFamilyDropDownRow('Font family', 'Font family for the hint block.', getS('lockscreen-text-hint-font', ''), value => setS('lockscreen-text-hint-font', value)));
        if (hasKey('lockscreen-text-hint-weight'))
            hintExp.add_row(this._adwLockTextChoiceDropDownRow('Weight', 'Font weight for the hint block.', LOCK_TEXT_FONT_WEIGHT_CHOICES, getS('lockscreen-text-hint-weight', ''), value => setS('lockscreen-text-hint-weight', value)));
        if (hasKey('lockscreen-text-hint-style'))
            hintExp.add_row(this._adwLockTextChoiceDropDownRow('Style', 'Font style for the hint block.', LOCK_TEXT_FONT_STYLE_CHOICES, getS('lockscreen-text-hint-style', ''), value => setS('lockscreen-text-hint-style', value)));

        lockGroup.add(section.expander);
        bindSensitivity(cmdExp, ['lockscreen-text-customize-enabled'], () => getB('lockscreen-text-customize-enabled', false));
        bindSensitivity(timeExp, ['lockscreen-text-customize-enabled'], () => getB('lockscreen-text-customize-enabled', false));
        bindSensitivity(dateExp, ['lockscreen-text-customize-enabled'], () => getB('lockscreen-text-customize-enabled', false));
        bindSensitivity(hintExp, ['lockscreen-text-customize-enabled'], () => getB('lockscreen-text-customize-enabled', false));
    }

    const wallpaperGroup = new Adw.PreferencesGroup({
        title: 'Wallpaper',
        description: 'Video playlist, playback, and related options for the desktop wallpaper.',
    });
    wallpaperGroup.add_css_class('llp-settings-card');

    const wallGeneral = this._makeSettingsExpander('Playback and layout', 'Enable wallpaper video and tune how clips play on the desktop.');
    wallGeneral.add(this._adwSwitchSettingsRow('Enabled', 'Use videos as the desktop wallpaper.', this._settings.get_boolean(Keys.WALLPAPER_ENABLED), active => this._settings.set_boolean(Keys.WALLPAPER_ENABLED, active)));
    wallGeneral.add(this._adwSwitchSettingsRow('Random order', 'Play wallpaper clips in random order.', this._settings.get_boolean(Keys.WALLPAPER_RANDOM_ORDER), active => this._settings.set_boolean(Keys.WALLPAPER_RANDOM_ORDER, active)));
    const wallLoopSubOk = 'Replay the current wallpaper clip when it ends.';
    const wallLoopRow = this._adwSwitchSettingsRow('Loop current clip', wallLoopSubOk, this._settings.get_boolean(Keys.WALLPAPER_LOOPED), active => this._settings.set_boolean(Keys.WALLPAPER_LOOPED, active));
    wallGeneral.add(wallLoopRow);
    bindLoopClipRow(
        wallLoopRow,
        [Keys.WALLPAPER_VIDEO_PATHS, Keys.WALLPAPER_PER_MONITOR, Keys.WALLPAPER_PER_MONITOR_CONFIG],
        loopToggleAllowedWallpaper,
        wallLoopSubOk,
        loopClipSubNa,
    );
    wallGeneral.add(this._adwSwitchSettingsRow('Auto FPS', 'Use the clip native framerate when possible.', this._settings.get_boolean(Keys.WALLPAPER_AUTO_FPS), active => this._settings.set_boolean(Keys.WALLPAPER_AUTO_FPS, active)));
    addManualFpsRow(wallGeneral, Keys.WALLPAPER_FRAMERATE, Keys.WALLPAPER_AUTO_FPS);
    wallGeneral.add(this._adwDropDownSettingsRow('Scaling mode', 'Choose how wallpaper video fits the screen.', ['Stretch', 'Fit', 'Cover'], this._settings.get_int(Keys.WALLPAPER_SCALING_MODE), value => this._settings.set_int(Keys.WALLPAPER_SCALING_MODE, value)));
    wallGeneral.add(this._adwScaleSettingsRow('Volume', 'Playback volume used on wallpaper.', this._settings.get_int(Keys.WALLPAPER_VOLUME), 0, 100, 1, value => this._settings.set_int(Keys.WALLPAPER_VOLUME, value), value => `${value}%`));
    wallGeneral.add(this._adwScaleSettingsRow('Fade in', 'Fade-in duration for wallpaper playback.', Math.min(FADE_IN_DURATION_MS_MAX, Math.max(0, this._settings.get_int(Keys.WALLPAPER_FADE_IN_DURATION))), 0, FADE_IN_DURATION_MS_MAX, FADE_IN_DURATION_MS_STEP, value => this._settings.set_int(Keys.WALLPAPER_FADE_IN_DURATION, value), value => `${value} ms`));
    wallGeneral.add(this._adwScaleSettingsRow('Quality', 'Render quality for desktop wallpaper playback.', this._settings.get_int(Keys.WALLPAPER_QUALITY), 25, 100, 1, value => this._settings.set_int(Keys.WALLPAPER_QUALITY, value), value => `${value}%`));
    if (hasKey('wallpaper-disable-on-battery') && this._hasBatteryDevice())
        wallGeneral.add(this._adwSwitchSettingsRow('Disable on battery', 'Pause wallpaper playback while on battery power.', this._settings.get_boolean(Keys.WALLPAPER_DISABLE_ON_BATTERY), active => this._settings.set_boolean(Keys.WALLPAPER_DISABLE_ON_BATTERY, active)));
    wallGeneral.add(this._adwLabelSuffixRow('Current playlist size', 'Number of clips currently assigned to wallpaper.', `${this._safeGetStrv(Keys.WALLPAPER_VIDEO_PATHS).length} clips`));
    wallpaperGroup.add(wallGeneral.expander);

    if (hasKey('wallpaper-blur-radius') || hasKey('wallpaper-blur-brightness') || hasKey('pause-when-hidden-mode')) {
        const section = this._makeSettingsExpander('Appearance', 'Blur behind wallpaper and when to pause playback if windows fully cover the desktop.');
        if (hasKey('wallpaper-blur-radius'))
            section.add(this._adwScaleSettingsRow('Blur radius', 'Amount of blur behind wallpaper playback.', getI('wallpaper-blur-radius', 0), 0, 100, 1, value => setI('wallpaper-blur-radius', value), value => `${value}px`));
        let blurBrightnessRow = null;
        if (hasKey('wallpaper-blur-brightness')) {
            blurBrightnessRow = this._adwScaleSettingsRow('Blur brightness', 'Brightness used when wallpaper blur is enabled.', Math.round(getD('wallpaper-blur-brightness', 1) * 100), 0, 100, 1, value => setD('wallpaper-blur-brightness', value / 100), value => `${value}%`);
            section.add(blurBrightnessRow);
            bindSensitivity(blurBrightnessRow, ['wallpaper-blur-radius'], () => getI('wallpaper-blur-radius', 0) > 0);
        }
        if (hasKey('pause-when-hidden-mode'))
            section.add(this._adwDropDownSettingsRow(
                'Pause when hidden',
                'Pause wallpaper when monitors are fully covered by fullscreen or maximised windows.',
                ['Off', 'All monitors', 'Any monitor'],
                Math.max(0, Math.min(2, getI('pause-when-hidden-mode', 0))),
                index => setI('pause-when-hidden-mode', index),
            ));
        wallpaperGroup.add(section.expander);
    }

    const libraryCard = this._makeSettingsCard('Library and cache', 'Clear thumbnails or metadata, fix playlists, or zero play counts.');
    const refreshSummary = () => {
        const store = this._loadLibraryStore();
        const entries = this._libraryEntries();
        const playlists = this._loadPlaylists().length;
        if (libraryCard._summaryLabel)
            try {
                libraryCard._summaryLabel.set_label(`${store.files.length} files • ${store.folders.length} folders • ${playlists} playlists • ${entries.reduce((a, e) => a + e.clips.length, 0)} clips`);
            } catch (eL) {}
    };
    const summary = new Gtk.Label({label: '', xalign: 0, wrap: true});
    summary.add_css_class('llp-card-subtitle');
    libraryCard._summaryLabel = summary;
    refreshSummary();
    const confirmDestructiveThen = (heading, body, confirmLabel, fn) => {
        this._confirmAction({heading, body, confirmLabel, destructive: true}).then(ok => {
            if (ok) fn();
        });
    };
    libraryCard.append(summary);
    const buttonRow = box(Gtk.Orientation.HORIZONTAL, 8, false, false);
    const clearThumbs = new Gtk.Button({label: 'Clear thumbnails'});
    const clearMeta = new Gtk.Button({label: 'Clear metadata'});
    const cleanPlaylists = new Gtk.Button({label: 'Cleanup playlists'});
    buttonRow.append(clearThumbs); buttonRow.append(clearMeta); buttonRow.append(cleanPlaylists);
    libraryCard.append(buttonRow);
    clearThumbs.connect('clicked', () => confirmDestructiveThen(
        'Clear thumbnails?',
        'Remove all cached preview images. They will be regenerated when you browse the library.',
        '_Clear',
        () => { this._clearThumbCache(); refreshSummary(); },
    ));
    clearMeta.connect('clicked', () => confirmDestructiveThen(
        'Clear metadata cache?',
        'Discard the in-memory and on-disk cache of per-file metadata used by the library. Data will be fetched again as needed.',
        '_Clear',
        () => { this._clearMetadataCache(); refreshSummary(); },
    ));
    cleanPlaylists.connect('clicked', () => confirmDestructiveThen(
        'Clean up playlists?',
        'Remove playlist entries that no longer exist in the library store (missing files or folders).',
        '_Clean up',
        () => { this._cleanupPlaylists(); refreshSummary(); },
    ));

    const playCountSub = new Gtk.Label({
        label: 'Play-count reset: metadata only. Thumbnails and playlists stay.',
        xalign: 0,
        wrap: true,
        margin_top: 12,
    });
    playCountSub.add_css_class('llp-card-subtitle');
    libraryCard.append(playCountSub);
    const resetCountsRow = box(Gtk.Orientation.HORIZONTAL, 8, false, false);
    const resetLock = new Gtk.Button({label: 'Reset lock counts'});
    const resetWallpaper = new Gtk.Button({label: 'Reset wallpaper counts'});
    const resetBoth = new Gtk.Button({label: 'Reset both'});
    resetCountsRow.append(resetLock);
    resetCountsRow.append(resetWallpaper);
    resetCountsRow.append(resetBoth);
    libraryCard.append(resetCountsRow);
    resetLock.connect('clicked', () => confirmDestructiveThen(
        'Reset lock screen play counts?',
        'All stored play counts in lock screen video metadata will be set to zero.',
        '_Reset',
        () => resetPlayCounts(Keys.VIDEO_METADATA),
    ));
    resetWallpaper.connect('clicked', () => confirmDestructiveThen(
        'Reset wallpaper play counts?',
        'All stored play counts in wallpaper video metadata will be set to zero.',
        '_Reset',
        () => resetPlayCounts(Keys.WALLPAPER_VIDEO_METADATA),
    ));
    resetBoth.connect('clicked', () => confirmDestructiveThen(
        'Reset all play counts?',
        'Lock screen and wallpaper play counts in metadata will both be set to zero.',
        '_Reset all',
        () => {
            resetPlayCounts(Keys.VIDEO_METADATA);
            resetPlayCounts(Keys.WALLPAPER_VIDEO_METADATA);
        },
    ));

    const diagnosticsGroup = new Adw.PreferencesGroup({
        title: 'Diagnostics and Debug',
        description: 'Runtime controls, renderer flags, and troubleshooting helpers.',
    });
    diagnosticsGroup.add_css_class('llp-settings-card');

    if (hasKey('video-renderer') || hasKey('debug-use-gtk4-sink') || hasKey('debug-prefer-hardware-decoder') || hasKey('debug-push-frame-delivery') || hasKey('debug-gpu-color-conversion')) {
        const perf = this._makeSettingsExpander('Performance', 'Renderer path, hardware decoding, and appsink-only options.');
        if (hasKey('video-renderer')) {
            const rendererLabels = [
                'GTK4 subprocess (gtk4paintablesink)',
                'Legacy appsink (in-process)',
                'mpv subprocess',
            ];
            const videoRendererRow = this._adwDropDownSettingsRow(
                'Video renderer',
                '',
                rendererLabels,
                getI(Keys.VIDEO_RENDERER, 0),
                v => setI(Keys.VIDEO_RENDERER, v),
                200,
                288,
            );
            try {
                videoRendererRow.set_tooltip_text(
                    'GTK4 subprocess, in-process appsink, or mpv. mpv often handles heavy 4K well (install mpv). Changing renderer may require unlocking once or restarting wallpaper.',
                );
            } catch (eVr) {}
            perf.add(videoRendererRow);
        } else if (hasKey('debug-use-gtk4-sink')) {
            const legacyRow = new Adw.SwitchRow({
                title: 'Force legacy appsink renderer',
                subtitle: 'Default off: GTK4 subprocess with gtk4paintablesink. Turn on for the older in-process appsink path.',
            });
            try {
                this._settings.bind(
                    Keys.DEBUG_USE_GTK4_SINK,
                    legacyRow,
                    'active',
                    Gio.SettingsBindFlags.DEFAULT,
                );
            } catch (e) {}
            perf.add(legacyRow);
        }
        if (hasKey('debug-prefer-hardware-decoder')) {
            const hwDecRow = this._adwSwitchSettingsRow('Prefer hardware decoder', 'GTK4/appsink: VA-API/NVDEC rank boost. mpv: hardware decode via --hwdec (off = no).', getB('debug-prefer-hardware-decoder', true), active => setB('debug-prefer-hardware-decoder', active));
            try {
                hwDecRow.set_tooltip_text('Wallpaper blur can make mpv use a copy-safe hwdec path. Turn this off to force software decoding if playback glitches.');
            } catch (eHw) {}
            perf.add(hwDecRow);
        }
        let pushRow = null;
        let gpuRow = null;
        if (hasKey('debug-push-frame-delivery')) {
            pushRow = this._adwSwitchSettingsRow('Adaptive frame polling', 'Appsink-only frame polling optimization.', getB('debug-push-frame-delivery', false), active => setB('debug-push-frame-delivery', active));
            perf.add(pushRow);
        }
        if (hasKey('debug-gpu-color-conversion')) {
            gpuRow = this._adwSwitchSettingsRow('GPU colour conversion', 'Appsink-only GPU colour conversion toggle.', getB('debug-gpu-color-conversion', false), active => setB('debug-gpu-color-conversion', active));
            perf.add(gpuRow);
        }
        const appsinkOnlySensitive = () => {
            if (hasKey('video-renderer'))
                return getI(Keys.VIDEO_RENDERER, 0) === VideoRenderer.APPSINK;
            return getB('debug-use-gtk4-sink', false);
        };
        const appsinkWatchKeys = hasKey('video-renderer') ? ['video-renderer'] : ['debug-use-gtk4-sink'];
        for (const row of [pushRow, gpuRow]) {
            if (row)
                bindSensitivity(row, appsinkWatchKeys, appsinkOnlySensitive);
        }
        diagnosticsGroup.add(perf.expander);
    }

    if (hasKey('panel-icon-mode') || hasKey('debug-show-panel-button')) {
        const panel = this._makeSettingsExpander('Panel icon', 'Status icon options for the top bar integration.');
        if (hasKey('debug-show-panel-button'))
            panel.add(this._adwSwitchSettingsRow('Show top bar quick controls', 'Expose quick controls in the top bar panel button.', getB('debug-show-panel-button', false), active => setB('debug-show-panel-button', active)));
        if (hasKey('panel-icon-mode')) {
            const iconModeLabels = ['Dynamic (Standard Icons)', 'Dynamic (Custom Icons)', 'Static (Original Icon)', 'Static (Custom Icon)'];
            panel.add(this._comboRow('Change icon', 'Select how the panel icon is displayed.', getI('panel-icon-mode', 0), iconModeLabels, v => setI('panel-icon-mode', v)));
        }
        diagnosticsGroup.add(panel.expander);
    }

    const debugSection = this._makeSettingsExpander('Debug', 'Troubleshooting helpers and log access.');
    if (hasKey('debug-skip-frame')) {
        const skipRow = this._adwSwitchSettingsRow('Skip first frame', 'Skip the first decoded frame during startup.', getB('debug-skip-frame', false), active => setB('debug-skip-frame', active));
        debugSection.add(skipRow);
        bindSensitivity(
            skipRow,
            hasKey('video-renderer') ? ['video-renderer'] : ['debug-use-gtk4-sink'],
            () => (hasKey('video-renderer')
                ? getI(Keys.VIDEO_RENDERER, 0) === VideoRenderer.APPSINK
                : getB('debug-use-gtk4-sink', false)),
        );
    }
    if (hasKey('debug-gtk-helper-logs'))
        debugSection.add(this._adwSwitchSettingsRow('Verbose helper logs', 'Emit more detailed helper and journal logging.', getB('debug-gtk-helper-logs', false), active => setB('debug-gtk-helper-logs', active)));

    const logsSection = this._makeSettingsExpander('View logs', 'Read recent Live LockPaper and GJS journal output without leaving the prefs window.');
    const logButtons = box(Gtk.Orientation.HORIZONTAL, 8, false, false);
    const refreshLogsBtn = new Gtk.Button({label: 'Refresh'});
    const copyLogsBtn = new Gtk.Button({label: 'Copy'});
    logButtons.append(refreshLogsBtn);
    logButtons.append(copyLogsBtn);
    const logBtnRow = new Adw.ActionRow({title: 'Journal', subtitle: 'Load and copy recent gjs journal lines.'});
    logBtnRow.add_suffix(logButtons);
    logsSection.add(logBtnRow);
    const logView = new Gtk.TextView({editable: false, monospace: true, wrap_mode: Gtk.WrapMode.WORD_CHAR});
    logView.set_vexpand(true);
    const logScroll = new Gtk.ScrolledWindow({min_content_height: 220, vexpand: true});
    logScroll.set_child(logView);
    try { logScroll.set_size_request(400, 220); } catch (eLs) {}
    const logOutRow = new Adw.ActionRow({title: 'Output'});
    logOutRow.add_suffix(logScroll);
    logsSection.add(logOutRow);
    const readLogs = () => {
        try {
            const cmd = "sh -lc 'journalctl -b --no-pager -o cat /usr/bin/gjs 2>/dev/null | tail -n 300'";
            const [, out] = GLib.spawn_command_line_sync(cmd);
            return out ? new TextDecoder().decode(out) : '';
        } catch (e) {
            return `Could not load logs.\n${e}`;
        }
    };
    const refreshLogs = () => {
        try { logView.get_buffer().set_text(readLogs(), -1); } catch (e) {}
    };
    refreshLogsBtn.connect('clicked', refreshLogs);
    copyLogsBtn.connect('clicked', () => {
        try {
            const buf = logView.get_buffer();
            const text = buf.get_text(buf.get_start_iter(), buf.get_end_iter(), false);
            Gdk.Display.get_default()?.get_clipboard?.()?.set?.(text);
        } catch (e) {}
    });
    refreshLogs();
    debugSection.add(logsSection.expander);
    diagnosticsGroup.add(debugSection.expander);

    addLeft(lockGroup);
    addLeft(libraryCard);
    addRight(wallpaperGroup);
    addRight(diagnosticsGroup);

    wrap.append(cols);
    group.add(wrap);
    page.add(group);
    return page;
}
};
