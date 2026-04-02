import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {VIDEO_EXTS} from './prefs-constants.js';

function box(orientation, spacing = 0, hexpand = false, vexpand = false) {
return new Gtk.Box({orientation, spacing, hexpand, vexpand});
}

function clearChildren(widget) {
let child = widget.get_first_child?.();
while (child) {
    const next = child.get_next_sibling?.();
    try { widget.remove(child); } catch (e) {}
    child = next;
}
}

function basename(path) {
try { return GLib.path_get_basename(path) || path; } catch (e) { return path || ''; }
}

function basenameNoExt(path) {
const b = basename(path);
return b.replace(/\.[^.]+$/, '');
}

function isVideoPath(path) {
const lower = String(path || '').toLowerCase();
return VIDEO_EXTS.some(ext => lower.endsWith(ext));
}

/** Collapse `.` / `..` so FileChooser paths match `_scanFolder` / excludes (fixes same-dir “add to folder”). */
function canonicalPath(p) {
    if (p == null || p === '')
        return '';
    const s = String(p);
    try {
        if (GLib.path_is_absolute(s)) {
            const c = GLib.canonicalize_filename(s, null);
            if (c)
                return c;
        }
    } catch (e) {}
    return s;
}

/** Same on-disk file as `canonicalPath` + `Gio.File.equal` (library scan vs chooser vs JSON keys). */
function sameLibraryFilePath(a, b) {
    if (a === b)
        return true;
    const ca = canonicalPath(a);
    const cb = canonicalPath(b);
    if (ca && cb && ca === cb)
        return true;
    try {
        return Gio.File.new_for_path(a).equal(Gio.File.new_for_path(b));
    } catch (e) {
        return false;
    }
}

/** Local path from a Gio.File (e.g. Gtk.FileChooser). get_path() is often null with xdg-desktop-portal / some mounts. */
function pathFromGFile(file) {
    if (!file)
        return '';
    const fin = raw => (raw ? (canonicalPath(raw) || raw) : '');
    try {
        const direct = file.get_path();
        if (direct)
            return fin(direct);
    } catch (e) {}
    try {
        const uri = file.get_uri();
        if (uri?.startsWith('file://')) {
            const parts = GLib.filename_from_uri(uri);
            const fn = parts?.[0];
            if (fn)
                return fin(fn);
        }
    } catch (e2) {}
    try {
        const uri = file.get_uri();
        if (uri) {
            const f2 = Gio.File.new_for_uri(uri);
            const p2 = f2.get_path();
            if (p2)
                return fin(p2);
        }
    } catch (e3) {}
    return '';
}

function uniq(paths) {
return [...new Set((paths || []).filter(Boolean))];
}

function md5(text) {
return GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, text, -1);
}

function formatDuration(sec) {
if (!Number.isFinite(sec) || sec <= 0)
    return '';
const total = Math.round(sec);
const h = Math.floor(total / 3600);
const m = Math.floor((total % 3600) / 60);
const s = total % 60;
return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function formatPlayCountLabel(count) {
const n = Math.max(0, Math.round(Number(count) || 0));
return n === 1 ? '1 Play' : `${n} Plays`;
}

function formatBytes(bytes) {
if (!Number.isFinite(bytes) || bytes < 0)
    return '';
const units = ['B', 'KB', 'MB', 'GB', 'TB'];
let n = bytes;
let i = 0;
while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
}
return i === 0 ? `${Math.round(n)} ${units[i]}` : `${n.toFixed(i >= 3 ? 2 : 1)} ${units[i]}`;
}

function makePill(text) {
const l = new Gtk.Label({label: text, xalign: 0});
l.add_css_class('llp-pill');
return l;
}

/** Same look as `makePill`, toggles via primary click. */
function makeClickablePill(text, onClick, tooltip = '') {
const l = new Gtk.Label({label: text, xalign: 0});
l.add_css_class('llp-pill');
l.add_css_class('llp-pill-clickable');
if (tooltip) {
    try { l.set_tooltip_text(tooltip); } catch (e) {}
}
const click = new Gtk.GestureClick();
click.set_button(Gdk.BUTTON_PRIMARY);
click.connect('released', (_g, nPress) => {
    if (nPress === 1) {
        try { onClick(); } catch (e2) {}
    }
});
l.add_controller(click);
try {
    const disp = Gdk.Display.get_default();
    if (disp)
        l.set_cursor(Gdk.Cursor.new_from_name(disp, 'pointer'));
} catch (e3) {}
return l;
}

function clipOverflow(widget) {
try { widget.set_overflow(Gtk.Overflow.HIDDEN); } catch (e) {}
return widget;
}

function addImageOrFallback(picture, imagePath, width, height) {
try {
    if (imagePath) {
        const pb = GdkPixbuf.Pixbuf.new_from_file_at_scale(imagePath, width, height, true);
        const texture = Gdk.Texture.new_for_pixbuf(pb);
        picture.set_paintable(texture);
        return true;
    }
} catch (e) {}
try {
    const iconImg = Gtk.Image.new_from_icon_name('video-x-generic-symbolic');
    try { iconImg.set_pixel_size(Math.min(Math.max(width, height), 128)); } catch (e2) {}
    const p = iconImg.get_paintable();
    if (p)
        picture.set_paintable(p);
    else
        picture.set_paintable(null);
} catch (e3) {
    picture.set_paintable(null);
}
return false;
}

export {
    box,
    clearChildren,
    basename,
    basenameNoExt,
    isVideoPath,
    canonicalPath,
    sameLibraryFilePath,
    pathFromGFile,
    uniq,
    md5,
    formatDuration,
    formatPlayCountLabel,
    formatBytes,
    makePill,
    makeClickablePill,
    clipOverflow,
    addImageOrFallback,
};
