import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';
import GdkPixbuf from 'gi://GdkPixbuf';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';
import {Keys} from './enums.js';
import {LOCK_TEXT_FONT_WEIGHT_CHOICES, LOCK_TEXT_FONT_STYLE_CHOICES} from './prefs-constants.js';
import {box, basename, makePill, makeClickablePill, clearChildren, addImageOrFallback, clipOverflow, basenameNoExt, formatDuration, formatBytes} from './prefs-ui-helpers.js';
/** Reusable rows, controls, cards, dialogs helpers, settings getters, version/tag UI. */
export const PrefsUiMixin = {
_makeStatCard(title, value, badge = '', subtitle = '') {
    const card = box(Gtk.Orientation.VERTICAL, 0, true, false);
    card.add_css_class('llp-stat-card');
    card.add_css_class('compact');

    const main = box(Gtk.Orientation.HORIZONTAL, 12, true, false);
    main.add_css_class('llp-stat-main');

    const copy = box(Gtk.Orientation.VERTICAL, 4, true, false);
    copy.add_css_class('llp-stat-copy');

    const head = box(Gtk.Orientation.HORIZONTAL, 8, true, false);
    const t = new Gtk.Label({label: title, xalign: 0});
    t.add_css_class('llp-card-subtitle');
    head.append(t);
    if (badge)
        head.append(makePill(badge));

    copy.append(head);
    if (subtitle) {
        const s = new Gtk.Label({label: subtitle, xalign: 0, wrap: true});
        s.add_css_class('llp-stat-label');
        copy.append(s);
    }

    const v = new Gtk.Label({label: String(value), xalign: 1});
    v.add_css_class('llp-stat-value');
    v.add_css_class('compact');
    try { v.set_halign(Gtk.Align.END); } catch (e) {}
    try { v.set_valign(Gtk.Align.CENTER); } catch (e2) {}

    main.append(copy);
    main.append(v);
    card.append(main);
    return card;
},

/**
 * Icon + label pill used on Home selection cards (`llp-overlay-source-pill`).
 * `apply(kind, title)` — empty title hides; `kind` selects sidebar-style icon (folder / file / playlist).
 */
_makeOverlaySourcePill(maxWidthChars = null) {
    const sourceChipBox = box(Gtk.Orientation.HORIZONTAL, 6, false, false);
    sourceChipBox.add_css_class('llp-overlay-source-pill');
    try { sourceChipBox.set_halign(Gtk.Align.START); } catch (eHa) {}
    try { sourceChipBox.set_hexpand(false); } catch (eHx) {}
    try { sourceChipBox.set_valign(Gtk.Align.CENTER); } catch (eSc) {}
    const sourceIcon = new Gtk.Image({icon_name: 'folder-symbolic', pixel_size: 13, valign: Gtk.Align.CENTER});
    sourceIcon.add_css_class('llp-sidebar-type-icon');
    try { sourceIcon.set_hexpand(false); } catch (eHi) {}
    const sourceLabel = new Gtk.Label({label: '', xalign: 0, valign: Gtk.Align.CENTER});
    try { sourceLabel.set_hexpand(false); } catch (eHl) {}
    sourceLabel.set_ellipsize(Pango.EllipsizeMode.END);
    if (maxWidthChars != null) {
        try { sourceLabel.set_max_width_chars(maxWidthChars); } catch (eMw) {}
    }
    sourceChipBox.append(sourceIcon);
    sourceChipBox.append(sourceLabel);
    try { sourceChipBox.set_visible(false); } catch (eSc2) {}
    const apply = (kind, title) => {
        const t = String(title || '').trim();
        if (!t) {
            try { sourceChipBox.set_visible(false); } catch (eVs2) {}
            return;
        }
        try { sourceIcon.set_from_icon_name(kind ? this._entryKindIcon(kind) : 'folder-symbolic'); } catch (eIc) {}
        sourceLabel.set_label(t);
        try { sourceChipBox.set_visible(true); } catch (eVs) {}
    };
    return {widget: sourceChipBox, apply};
},

_makePreviewCard(title, lockTarget) {
    const card = box(Gtk.Orientation.VERTICAL, 10, true, false);
    card.add_css_class('llp-strip-card');

    const head = box(Gtk.Orientation.HORIZONTAL, 8, true, false);
    const t = new Gtk.Label({label: title, xalign: 0});
    t.add_css_class('llp-section-title');
    head.append(t);
    const chipRow = box(Gtk.Orientation.HORIZONTAL, 6, true, false);
    chipRow.add_css_class('llp-home-chip-row');
    head.append(chipRow);

    const hero = clipOverflow(new Gtk.Overlay({hexpand: true}));
    hero.add_css_class('llp-hero-shell');
    hero.add_css_class('llp-hero-compact');

    const pic = new Gtk.Picture({can_shrink: true, content_fit: Gtk.ContentFit.COVER, hexpand: true, vexpand: true});
    pic.add_css_class('llp-hero-media');
    pic.set_size_request(520, 220);
    hero.set_child(pic);
    addImageOrFallback(pic, null, 520, 220);

    const meta = box(Gtk.Orientation.VERTICAL, 6, true, false);
    meta.add_css_class('llp-hero-meta');
    meta.set_halign(Gtk.Align.FILL);
    meta.set_valign(Gtk.Align.END);

    const {widget: sourceChipBox, apply: applySourceChip} = this._makeOverlaySourcePill();

    const titleL = new Gtk.Label({label: 'No selection yet', xalign: 0});
    titleL.add_css_class('llp-card-title');
    titleL.set_ellipsize(Pango.EllipsizeMode.END);
    try { titleL.set_hexpand(true); } catch (eHe) {}

    const subL = new Gtk.Label({
        label: 'Pick clips from Library to populate this playlist.',
        xalign: 0,
        wrap: true,
    });
    subL.add_css_class('llp-card-subtitle');

    meta.append(sourceChipBox);
    meta.append(titleL);
    meta.append(subL);
    hero.add_overlay(meta);

    const enabledKey = lockTarget ? Keys.LOCKSCREEN_ENABLED : Keys.WALLPAPER_ENABLED;
    const perKey = lockTarget ? Keys.LOCKSCREEN_PER_MONITOR : Keys.WALLPAPER_PER_MONITOR;
    const thumbTag = lockTarget ? 'home:lockPreview' : 'home:wallPreview';
    let metaSeq = 0;

    const refresh = () => {
        metaSeq++;
        const seq = metaSeq;
        const arr = this._effectivePlaylistPaths(lockTarget);
        let enabled = false;
        try {
            enabled = this._settings.get_boolean(enabledKey);
        } catch (e) {}
        let perDisplay = false;
        try {
            perDisplay = this._hasSettingKey(perKey) && this._settings.get_boolean(perKey);
        } catch (eP) {}
        const path = arr[0] || null;

        const applyThumbDim = () => {
            let en = false;
            try { en = this._settings.get_boolean(enabledKey); } catch (eD) {}
            try {
                if (en)
                    hero.remove_css_class('llp-preview-thumb-off');
                else
                    hero.add_css_class('llp-preview-thumb-off');
            } catch (eD2) {}
        };

        const appendBaseChips = () => {
            const onPill = makeClickablePill(
                enabled ? 'On' : 'Off',
                () => {
                    try {
                        const cur = this._settings.get_boolean(enabledKey);
                        this._settings.set_boolean(enabledKey, !cur);
                    } catch (eC) {}
                },
                lockTarget ? 'Turn lock screen video on or off' : 'Turn wallpaper video on or off',
            );
            try { onPill.set_valign(Gtk.Align.CENTER); } catch (eV) {}
            chipRow.append(onPill);

            if (this._hasSettingKey(perKey)) {
                const perPill = makeClickablePill(
                    perDisplay ? 'Per display' : 'Shared',
                    () => {
                        try {
                            const cur = this._settings.get_boolean(perKey);
                            this._settings.set_boolean(perKey, !cur);
                        } catch (eC2) {}
                    },
                    lockTarget
                        ? 'Shared: one playlist for all monitors. Per display: choose monitors in Library.'
                        : 'Shared: one wallpaper for all monitors. Per display: choose monitors in Library.',
                );
                try { perPill.set_valign(Gtk.Align.CENTER); } catch (eV2) {}
                chipRow.append(perPill);
            }
        };

        clearChildren(chipRow);
        appendBaseChips();

        if (path) {
            const srcInfo = this._selectionSourceInfoForStrv(arr);
            if (srcInfo.title && srcInfo.kind)
                applySourceChip(srcInfo.kind, srcInfo.title);
            else
                applySourceChip(null, '');
            titleL.set_label(basenameNoExt(path));
            try { subL.set_visible(false); } catch (eVis) {}
            addImageOrFallback(pic, null, 520, 220);
            this._ensureThumb(path, thumbTag, 520, 220, thumb => {
                if (seq !== metaSeq)
                    return;
                addImageOrFallback(pic, thumb, 520, 220);
            });
            chipRow.append(makePill(`${arr.length} clips`));
            applyThumbDim();
            this._sumMetadataForPaths(arr, totals => {
                if (seq !== metaSeq)
                    return;
                clearChildren(chipRow);
                appendBaseChips();
                if (totals.count)
                    chipRow.append(makePill(`${totals.count} clips`));
                if (totals.duration)
                    chipRow.append(makePill(formatDuration(totals.duration)));
                if (totals.size)
                    chipRow.append(makePill(formatBytes(totals.size)));
                applyThumbDim();
            });
        } else {
            applySourceChip(null, '');
            titleL.set_label('No selection yet');
            subL.set_label('Pick clips from Library to populate this playlist.');
            try { subL.set_visible(true); } catch (eVis2) {}
            addImageOrFallback(pic, null, 520, 220);
            applyThumbDim();
        }
    };

    refresh();
    card.append(head);
    card.append(hero);
    return {card, refresh};
},

/** Load `icons/<basename>.svg` then `.png` as Gdk.Texture (Pixbuf fallback for SVG quirks). */
_loadExtensionIconPaintable(basenameNoExt, pixelSize) {
    let base = '';
    try { base = this.metadata?.path || ''; } catch (e) {}
    if (!base) {
        try {
            if (typeof this.getPath === 'function')
                base = this.getPath() || '';
        } catch (e2) {}
    }
    if (!base)
        return null;
    const iconsDir = GLib.build_filenamev([base, 'icons']);
    const candidates = [
        GLib.build_filenamev([iconsDir, `${basenameNoExt}.svg`]),
        GLib.build_filenamev([iconsDir, `${basenameNoExt}.png`]),
    ];
    for (const p of candidates) {
        const f = Gio.File.new_for_path(p);
        if (!f.query_exists(null))
            continue;
        try {
            return Gdk.Texture.new_from_file(f);
        } catch (e) {
            try {
                const pb = GdkPixbuf.Pixbuf.new_from_file_at_scale(p, pixelSize, pixelSize, true);
                return Gdk.Texture.new_for_pixbuf(pb);
            } catch (e2) {}
        }
    }
    return null;
},

/** Icon + label; monochrome mark uses `.llp-github-brand` + CSS invert for white on dark. */
_makeGitHubButtonContents() {
    const row = box(Gtk.Orientation.HORIZONTAL, 8, false, false);
    row.set_valign(Gtk.Align.CENTER);
    const img = new Gtk.Image();
    img.set_pixel_size(18);
    img.set_valign(Gtk.Align.CENTER);
    const tex = this._loadExtensionIconPaintable('github-logo-monochrome', 18);
    if (tex) {
        img.set_from_paintable(tex);
        img.add_css_class('llp-github-brand');
    } else {
        img.set_from_icon_name('external-link-symbolic');
    }
    row.append(img);
    row.append(new Gtk.Label({label: 'GitHub', xalign: 0, valign: Gtk.Align.CENTER}));
    return row;
},

_makeTextIconButton(label, iconName = 'external-link-symbolic', iconPixelSize = 16) {
    const row = box(Gtk.Orientation.HORIZONTAL, 8, false, false);
    row.set_valign(Gtk.Align.CENTER);
    const img = new Gtk.Image({icon_name: iconName, pixel_size: iconPixelSize, valign: Gtk.Align.CENTER});
    row.append(img);
    row.append(new Gtk.Label({label, xalign: 0, valign: Gtk.Align.CENTER}));
    return row;
},

_normalizeVersionTag(tag) {
    return String(tag || '').trim().replace(/^refs\/tags\//, '').replace(/^v/i, '');
},

_compareVersions(a, b) {
    const pa = this._normalizeVersionTag(a).split(/[^0-9]+/).filter(Boolean).map(n => Number(n) || 0);
    const pb = this._normalizeVersionTag(b).split(/[^0-9]+/).filter(Boolean).map(n => Number(n) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const av = pa[i] || 0;
        const bv = pb[i] || 0;
        if (av > bv)
            return 1;
        if (av < bv)
            return -1;
    }
    return 0;
},

_refreshLatestTagStatus(label) {
    label.set_label('Checking…');
    const session = new Soup.Session();
    const msg = Soup.Message.new('GET', 'https://api.github.com/repos/DeLuca21/LiveLockPaper/tags');
    msg.request_headers.append('User-Agent', 'LiveLockPaper-Prefs');
    session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (sess, res) => {
        try {
            const bytes = sess.send_and_read_finish(res);
            const status = msg.get_status();
            if (status !== Soup.Status.OK)
                throw new Error(`HTTP ${status}`);
            const data = JSON.parse(new TextDecoder().decode(bytes.toArray()));
            const latest = data?.[0]?.name || '';
            const current = `${this.metadata?.version || 'dev'}`;
            if (!latest)
                throw new Error('No tag');
            const cmp = this._compareVersions(current, latest);
            label.set_label(cmp >= 0 ? 'Up to date' : `New: ${latest}`);
            if (cmp < 0)
                label.add_css_class('llp-pill-accent');
            else
                label.remove_css_class('llp-pill-accent');
        } catch (e) {
            label.set_label('Couldn’t check');
            label.remove_css_class('llp-pill-accent');
        }
    });
},

_boolRow(title, subtitle, key) {
    const row = new Adw.SwitchRow({title, subtitle});
    try {
        this._settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    } catch (e) {}
    return row;
},

_comboRow(title, subtitle, value, optionLabels, setValue) {
    const labels = Array.isArray(optionLabels) ? optionLabels : [];
    // DropDown's natural width follows the longest option; clamp so title/subtitle keep most of the row.
    return this._adwDropDownSettingsRow(title, subtitle, labels, value, setValue, 200, 288);
},

_spinRow(title, subtitle, value, min, max, suffix, setValue, stepIncrement = null, pageIncrement = null) {
    const stepInc = stepIncrement != null ? stepIncrement : (max > 200 ? 10 : 1);
    const pageInc = pageIncrement != null ? pageIncrement : (max > 200 ? 100 : 10);
    const adj = new Gtk.Adjustment({
        lower: min,
        upper: max,
        step_increment: stepInc,
        page_increment: pageInc,
        value,
    });
    const row = new Adw.SpinRow({title, subtitle, adjustment: adj});
    const suf = new Gtk.Label({label: suffix, valign: Gtk.Align.CENTER, css_classes: ['dim-label']});
    row.add_suffix(suf);
    row.connect('notify::value', () => {
        try { setValue(Math.round(row.get_value())); } catch (e2) {}
    });
    return row;
},

_pathsGroup(title, paths) {
    const group = new Adw.PreferencesGroup({title});
    const arr = Array.isArray(paths) ? paths : [];
    try { group.set_description(`${arr.length} path(s) — reorder from the Library tab.`); } catch (e) {}
    const exp = new Adw.ExpanderRow({
        title: 'Assigned videos',
        subtitle: arr.length ? `${arr.length} in playlist` : 'None',
    });
    const limit = 80;
    const slice = arr.slice(0, limit);
    for (const p of slice)
        exp.add_row(new Adw.ActionRow({title: basename(p), subtitle: p}));
    if (arr.length > limit) {
        exp.add_row(new Adw.ActionRow({
            title: `…and ${arr.length - limit} more`,
            subtitle: 'Full list is stored in gsettings',
        }));
    }
    if (!arr.length)
        exp.add_row(new Adw.ActionRow({title: 'Empty', subtitle: 'Choose clips in Library, then use Set as Lock Screen / Wallpaper.'}));
    group.add(exp);
    return group;
},

_makeSettingsCard(title, subtitle) {
    const card = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 10});
    card.add_css_class('llp-settings-card');
    const t = new Gtk.Label({label: title, xalign: 0});
    t.add_css_class('llp-section-title');
    card.append(t);
    if (subtitle) {
        const s = new Gtk.Label({label: subtitle, xalign: 0, wrap: true});
        s.add_css_class('llp-card-subtitle');
        card.append(s);
    }
    return card;
},

_makeSwitchControl(active, onChange) {
    const sw = new Gtk.Switch({valign: Gtk.Align.CENTER, active: !!active});
    sw.connect('notify::active', () => {
        try { onChange(sw.get_active()); } catch (e) {}
    });
    return sw;
},

_makeScaleControl(value, min, max, step, onChange, formatValue) {
    const adj = new Gtk.Adjustment({
        lower: min,
        upper: max,
        step_increment: step,
        page_increment: Math.max(step, (max - min) / 20),
        value,
    });
    const scale = new Gtk.Scale({
        orientation: Gtk.Orientation.HORIZONTAL,
        adjustment: adj,
        draw_value: false,
    });
    try { scale.set_hexpand(true); } catch (e) {}
    scale.set_size_request(200, -1);
    const lbl = new Gtk.Label({
        label: formatValue(Math.round(value)),
        valign: Gtk.Align.CENTER,
        width_chars: 12,
    });
    scale.connect('value-changed', () => {
        const v = Math.round(scale.get_value());
        lbl.set_label(formatValue(v));
        try { onChange(v); } catch (e2) {}
    });
    const box = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 10});
    box.append(scale);
    box.append(lbl);
    return box;
},

_makeDropDownControl(options, currentIndex, onChange, dropMinWidth = 200, dropMaxWidth = null) {
    const model = new Gtk.StringList({strings: options});
    const dd = new Gtk.DropDown({model, valign: Gtk.Align.CENTER});
    const i = Math.max(0, Math.min(options.length - 1, currentIndex | 0));
    try { dd.set_selected(i); } catch (e) {}
    dd.connect('notify::selected', () => {
        try { onChange(dd.get_selected()); } catch (e2) {}
    });
    try { dd.set_vexpand(false); } catch (e3) {}
    const minW = Math.max(120, dropMinWidth | 0);
    const maxW = dropMaxWidth > 0 ? Math.max(minW, dropMaxWidth | 0) : 0;
    try { dd.set_size_request(minW, -1); } catch (e4) {}
    try { dd.set_hexpand(!!maxW); } catch (eHx) {}
    try { dd.set_property('popup-fixed-width', false); } catch (ePw) {}
    const wrap = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        valign: Gtk.Align.CENTER,
        vexpand: false,
    });
    try { wrap.set_halign(Gtk.Align.END); } catch (eHa) {}
    let core = dd;
    if (maxW > 0) {
        try {
            const clamp = new Adw.Clamp({
                child: dd,
                maximum_size: maxW,
            });
            try { clamp.set_tightening_threshold(maxW); } catch (eTh) {}
            try { clamp.set_hexpand(false); } catch (eHc) {}
            core = clamp;
        } catch (eCl) {
            core = dd;
        }
    }
    wrap.append(core);
    return wrap;
},

_hasSettingKey(key) {
    try { return !!this._settings?.settings_schema?.has_key?.(key); } catch (e) { return false; }
},

/** True when UPower reports a battery (same check as the panel quick menu). */
_hasBatteryDevice() {
    if (this._prefsBatteryPresent !== undefined)
        return this._prefsBatteryPresent;
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
        this._prefsBatteryPresent = isPresent && type === 2;
    } catch (e) {
        this._prefsBatteryPresent = false;
    }
    return this._prefsBatteryPresent;
},

_getSettingBool(key, fallback = false) {
    try { return this._hasSettingKey(key) ? this._settings.get_boolean(key) : fallback; } catch (e) { return fallback; }
},

_getSettingInt(key, fallback = 0) {
    try { return this._hasSettingKey(key) ? this._settings.get_int(key) : fallback; } catch (e) { return fallback; }
},

_getSettingDouble(key, fallback = 0) {
    try { return this._hasSettingKey(key) ? this._settings.get_double(key) : fallback; } catch (e) { return fallback; }
},

_getSettingString(key, fallback = '') {
    try { return this._hasSettingKey(key) ? this._settings.get_string(key) : fallback; } catch (e) { return fallback; }
},

_makeEntryControl(value, onChange, placeholder = '') {
    const entry = new Gtk.Entry({text: value || '', valign: Gtk.Align.CENTER, hexpand: true});
    if (placeholder)
        try { entry.set_placeholder_text(placeholder); } catch (e) {}
    entry.connect('changed', () => {
        try { onChange(entry.get_text()); } catch (e) {}
    });
    return entry;
},

/** Full-width Libadwaita expander; use `add()` for Adw.ActionRow / SwitchRow / ComboRow / nested ExpanderRow. */
_makeSettingsExpander(title, subtitle = '') {
    // GObject construct properties (same as _pathsGroup). Adw row titles use Pango markup; unescaped "&" can blank the title.
    const exp = new Adw.ExpanderRow({
        title: title ?? '',
        subtitle: subtitle ?? '',
    });
    return {
        expander: exp,
        add(row) {
            try { exp.add_row(row); } catch (e) {}
        },
    };
},

_adwSwitchSettingsRow(title, subtitle, active, onChange) {
    const row = new Adw.SwitchRow({title, subtitle});
    const applyActive = v => {
        const b = !!v;
        try {
            row.active = b;
        } catch (e) {
            try {
                row.set_active?.(b);
            } catch (e2) {}
        }
    };
    applyActive(active);
    row.connect('notify::active', () => {
        try { onChange(!!row.active); } catch (e2) {}
    });
    return row;
},

_adwScaleSettingsRow(title, subtitle, value, min, max, step, onChange, formatValue) {
    const row = new Adw.ActionRow({title, subtitle});
    const ctrl = this._makeScaleControl(value, min, max, step, onChange, formatValue);
    try { ctrl.set_hexpand(true); } catch (e) {}
    row.add_suffix(ctrl);
    return row;
},

_adwDropDownSettingsRow(title, subtitle, options, currentIndex, onChange, dropMinWidth = 200, dropMaxWidth = null) {
    const row = new Adw.ActionRow({title, subtitle});
    row.add_suffix(this._makeDropDownControl(options, currentIndex, onChange, dropMinWidth, dropMaxWidth));
    return row;
},

_adwEntrySettingsRow(title, subtitle, value, onChange, placeholder = '') {
    const row = new Adw.ActionRow({title, subtitle});
    const ent = this._makeEntryControl(value, onChange, placeholder);
    try { ent.set_hexpand(true); ent.set_width_chars(24); } catch (e) {}
    row.add_suffix(ent);
    return row;
},

_adwSpinSettingsRow(title, subtitle, value, min, max, step, onChange, digits = 0, suffixLabel = null) {
    const adj = new Gtk.Adjustment({
        lower: min,
        upper: max,
        step_increment: step,
        page_increment: Math.max(step, (max - min) / 20),
        value,
    });
    const row = new Adw.SpinRow({title, subtitle, adjustment: adj});
    if (suffixLabel) {
        const suf = new Gtk.Label({label: suffixLabel, valign: Gtk.Align.CENTER});
        try { suf.add_css_class('dim-label'); } catch (eS) {}
        try { row.add_suffix(suf); } catch (eA) {}
    }
    row.connect('notify::value', () => {
        try {
            const raw = row.get_value();
            const v = digits > 0 ? raw : Math.round(raw);
            onChange(v);
        } catch (e2) {}
    });
    return row;
},

_parseColorStringToRgba(s) {
    const rgba = new Gdk.RGBA();
    const t = String(s || '').trim();
    if (!t || !rgba.parse(t)) {
        rgba.red = 1;
        rgba.green = 1;
        rgba.blue = 1;
        rgba.alpha = 1;
    }
    return rgba;
},

_rgbaToHex(rgba) {
    const r = Math.min(255, Math.max(0, Math.round((rgba?.red ?? 0) * 255)));
    const g = Math.min(255, Math.max(0, Math.round((rgba?.green ?? 0) * 255)));
    const b = Math.min(255, Math.max(0, Math.round((rgba?.blue ?? 0) * 255)));
    const h = n => n.toString(16).padStart(2, '0');
    return `#${h(r)}${h(g)}${h(b)}`.toLowerCase();
},

_lockTextChoiceIndex(choices, stored) {
    const s = String(stored ?? '').trim();
    if (!s)
        return 0;
    let i = choices.findIndex(c => c.value === s);
    if (i >= 0)
        return i;
    const sl = s.toLowerCase();
    i = choices.findIndex(c => String(c.value || '').toLowerCase() === sl);
    if (i >= 0)
        return i;
    i = choices.findIndex(c => String(c.label || '').toLowerCase() === sl);
    if (i >= 0)
        return i;
    return 0;
},

_listPangoFontFamilyNames() {
    if (this._lockTextFontFamilyCache)
        return this._lockTextFontFamilyCache;
    const out = [];
    try {
        const fm = PangoCairo.FontMap.get_default();
        const fams = fm?.list_families?.() || [];
        for (const fam of fams) {
            try {
                const n = fam.get_name?.();
                if (n)
                    out.push(n);
            } catch (e) {}
        }
        out.sort((a, b) => a.localeCompare(b, undefined, {sensitivity: 'base'}));
    } catch (e) {}
    if (!out.length) {
        out.push('Cantarell');
        out.push('Sans');
    }
    this._lockTextFontFamilyCache = out;
    return this._lockTextFontFamilyCache;
},

_adwColorPickerSettingsRow(title, subtitle, value, onChange) {
    const row = new Adw.ActionRow({title, subtitle});
    const dialog = new Gtk.ColorDialog();
    const btn = new Gtk.ColorDialogButton({dialog, valign: Gtk.Align.CENTER});
    try {
        btn.set_rgba(this._parseColorStringToRgba(value));
    } catch (e) {}
    try {
        btn.add_css_class('flat');
    } catch (e2) {}
    try {
        btn.set_tooltip_text('Choose color');
    } catch (e3) {}
    let lastHex = this._rgbaToHex(btn.get_rgba());
    btn.connect('notify::rgba', () => {
        try {
            const h = this._rgbaToHex(btn.get_rgba());
            if (h === lastHex)
                return;
            lastHex = h;
            onChange(h);
        } catch (e4) {}
    });
    row.add_suffix(btn);
    return row;
},

_adwLockTextChoiceDropDownRow(title, subtitle, choices, value, onChange, dropMinWidth = 200) {
    const row = new Adw.ActionRow({title, subtitle});
    const labels = choices.map(c => c.label);
    const idx = this._lockTextChoiceIndex(choices, value);
    const ctrl = this._makeDropDownControl(
        labels,
        idx,
        i => {
            if (i >= 0 && i < choices.length) {
                try {
                    onChange(choices[i].value);
                } catch (e3) {}
            }
        },
        dropMinWidth,
    );
    row.add_suffix(ctrl);
    return row;
},

_adwLockTextFontFamilyDropDownRow(title, subtitle, value, onChange) {
    const names = this._listPangoFontFamilyNames();
    const v = String(value || '').trim();
    const choices = [{value: '', label: 'Default (system)'}];
    if (v && !names.includes(v))
        choices.push({value: v, label: v});
    for (const n of names)
        choices.push({value: n, label: n});
    return this._adwLockTextChoiceDropDownRow(title, subtitle, choices, v, onChange, 280);
},

_adwLabelSuffixRow(title, subtitle, labelText) {
    const row = new Adw.ActionRow({title, subtitle});
    const lbl = new Gtk.Label({label: labelText, valign: Gtk.Align.CENTER});
    try { lbl.add_css_class('dim-label'); } catch (e) {}
    row.add_suffix(lbl);
    return row;
},

/** @returns {Promise<boolean>} true if user chose the confirm response */
_confirmAction({heading, body = '', confirmLabel = '_Continue', destructive = false}) {
    const win = this._window;
    if (!win)
        return Promise.resolve(false);
    return new Promise(resolve => {
        try {
            const dlg = new Adw.AlertDialog({heading, body});
            dlg.add_response('cancel', '_Cancel');
            dlg.add_response('confirm', confirmLabel);
            if (destructive) {
                try {
                    dlg.set_response_appearance('confirm', Adw.ResponseAppearance.DESTRUCTIVE);
                } catch (eA) {}
            }
            dlg.set_default_response('cancel');
            dlg.set_close_response('cancel');
            dlg.choose(win, null, (d, res) => {
                try {
                    resolve(d.choose_finish(res) === 'confirm');
                } catch (eF) {
                    resolve(false);
                }
            });
        } catch (e) {
            resolve(false);
        }
    });
},
};
