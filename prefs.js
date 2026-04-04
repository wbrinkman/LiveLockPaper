import Gst from 'gi://Gst';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {APP_ID} from './prefs-constants.js';
import {PREFS_CSS_BASE} from './prefs-css.js';
import {PREFS_CSS_EXTENDED} from './prefs-css-extended.js';
import {PrefsUiMixin} from './prefs-ui.js';
import {PrefsStoreMixin} from './prefs-store.js';
import {PrefsMediaMixin} from './prefs-media.js';
import {PrefsLibraryMixin} from './prefs-library.js';
import {PrefsHomeMixin} from './prefs-home.js';
import {PrefsSettingsMixin} from './prefs-settings.js';

class LiveLockPaperPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        try {
            Gst.init(null);
        } catch (e) {}
        this._settings = this.getSettings();
        this._window = window;
        this._refreshHomeSelectionCards = null;
        this._homeSelectionRefreshIdle = 0;
        try {
            window.set_title(APP_ID);
        } catch (e) {}
        try {
            window.set_default_size(1480, 960);
        } catch (e) {}
        this._installCss();
        this._ensureStoreSeeded();

        window.add(this._buildHomePage());
        const win = window;
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            try {
                win.add(this._buildLibraryPage());
            } catch (e) {}
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                try {
                    win.add(this._buildSettingsPage());
                } catch (e2) {}
                return GLib.SOURCE_REMOVE;
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    _installCss() {
        if (this._cssInstalled)
            return;

        const provider = new Gtk.CssProvider();
        provider.load_from_string(PREFS_CSS_BASE + PREFS_CSS_EXTENDED);
        const display = Gdk.Display.get_default();
        if (display)
            Gtk.StyleContext.add_provider_for_display(display, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
        this._cssInstalled = true;
    }
}

Object.assign(LiveLockPaperPrefs.prototype,
    PrefsUiMixin,
    PrefsStoreMixin,
    PrefsMediaMixin,
    PrefsLibraryMixin,
    PrefsHomeMixin,
    PrefsSettingsMixin);

export default LiveLockPaperPrefs;
