import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import {Keys} from './enums.js';
import {APP_ID, CARD_W, CARD_H, HERO_W, HERO_H} from './prefs-constants.js';
import {box, clearChildren, basename, basenameNoExt, uniq, isVideoPath, sameLibraryFilePath, pathFromGFile, makePill, makeClickablePill, clipOverflow, addImageOrFallback, formatDuration, formatBytes, formatPlayCountLabel} from './prefs-ui-helpers.js';
/** Apply-to-target dialog, monitor preview, Library page. */
export const PrefsLibraryMixin = {
/** Library → lock screen / wallpaper: one dialog with layout preview + all vs one display. */
_runLibraryApplyFlow(target, paths) {
    const list = uniq(paths || []).filter(Boolean);
    if (!list.length)
        return;
    const lock = target === 'lock';
    const strvKey = lock ? Keys.VIDEO_PATHS : Keys.WALLPAPER_VIDEO_PATHS;
    const perKey = lock ? Keys.LOCKSCREEN_PER_MONITOR : Keys.WALLPAPER_PER_MONITOR;
    const jsonKey = lock ? Keys.LOCKSCREEN_PER_MONITOR_CONFIG : Keys.WALLPAPER_PER_MONITOR_CONFIG;

    const enableTarget = () => {
        if (lock && this._hasSettingKey(Keys.LOCKSCREEN_ENABLED))
            try { this._settings.set_boolean(Keys.LOCKSCREEN_ENABLED, true); } catch (e) {}
        if (!lock && this._hasSettingKey(Keys.WALLPAPER_ENABLED))
            try { this._settings.set_boolean(Keys.WALLPAPER_ENABLED, true); } catch (e) {}
    };

    if (!this._hasSettingKey(perKey)) {
        this._setStrv(strvKey, list);
        if (lock && this._hasSettingKey(Keys.VIDEO_PATH) && list.length)
            try { this._settings.set_string(Keys.VIDEO_PATH, list[0]); } catch (e) {}
        enableTarget();
        return;
    }

    const title = lock ? 'Apply to lock screen' : 'Apply to wallpaper';
    this._presentApplyPlaylistVisualDialog(title, lock, list, strvKey, perKey, jsonKey, enableTarget);
},

_presentApplyPlaylistVisualDialog(title, lock, list, strvKey, perKey, jsonKey, enableTarget) {
    const applyShared = () => {
        try { this._settings.set_boolean(perKey, false); } catch (e) {}
        this._setStrv(strvKey, list);
        if (lock && this._hasSettingKey(Keys.VIDEO_PATH) && list.length)
            try { this._settings.set_string(Keys.VIDEO_PATH, list[0]); } catch (e2) {}
        enableTarget();
    };

    const applyPerDisplay = connectors => {
        const uniqConnectors = [...new Set((connectors || []).filter(Boolean))];
        if (!uniqConnectors.length)
            return;
        const cfg = {...this._getStringMapConfig(jsonKey)};
        const pathsCopy = [...list];
        for (const c of uniqConnectors)
            cfg[c] = pathsCopy;
        try { this._settings.set_boolean(perKey, true); } catch (e) {}
        this._setStringMapConfig(jsonKey, cfg);
        enableTarget();
    };

    const dlg = new Gtk.Dialog({transient_for: this._window, modal: true, title});
    try {
        dlg.realize();
    } catch (eRealize) {}
    /** Gdk monitor list from the dialog’s display (same as prefs window after realize). */
    const monitors = this._getDetectedMonitors(dlg);
    try { dlg.set_default_size(560, 460); } catch (e) {}
    dlg.add_button('Cancel', Gtk.ResponseType.CANCEL);
    dlg.add_button('Apply', Gtk.ResponseType.OK);

    const area = dlg.get_content_area();
    try { area.set_orientation(Gtk.Orientation.VERTICAL); } catch (e) {}
    area.set_spacing(12);
    area.set_margin_top(14);
    area.set_margin_bottom(14);
    area.set_margin_start(16);
    area.set_margin_end(16);

    const instr = new Gtk.Label({
        label: 'Shared playlist: same playlist on every monitor, in sync.\nPer display: same playlist on the monitors you tick; not in sync with each other.',
        wrap: true,
        xalign: 0,
    });
    instr.add_css_class('llp-card-subtitle');
    instr.add_css_class('llp-apply-dlg-instr');
    try { instr.set_max_width_chars(48); } catch (e) {}
    area.append(instr);

    const modeRow = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 8});
    const btnShared = new Gtk.ToggleButton({label: 'Shared playlist', active: true});
    const btnPer = new Gtk.ToggleButton({label: 'Per display'});
    try { btnPer.set_group(btnShared); } catch (e) {}
    modeRow.append(btnShared);
    modeRow.append(btnPer);
    area.append(modeRow);

    const perToolbar = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 8});
    const selectAllBtn = new Gtk.Button({label: 'Select all displays'});
    const clearSelBtn = new Gtk.Button({label: 'Clear selection'});
    perToolbar.append(selectAllBtn);
    perToolbar.append(clearSelBtn);
    area.append(perToolbar);

    const PREVIEW_W = 500;
    const PREVIEW_H = 270;
    const margin = 16;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const m of monitors) {
        const x = m.x ?? 0;
        const y = m.y ?? 0;
        const w = Math.max(m.width || 0, 320);
        const h = Math.max(m.height || 0, 240);
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x + w);
        maxY = Math.max(maxY, y + h);
    }
    if (!Number.isFinite(minX) || maxX <= minX) {
        minX = 0;
        minY = 0;
        maxX = 1920;
        maxY = 1080;
    }
    const tw = Math.max(maxX - minX, 1);
    const th = Math.max(maxY - minY, 1);
    const availW = PREVIEW_W - 2 * margin;
    const availH = PREVIEW_H - 2 * margin;
    const scale = Math.min(availW / tw, availH / th) * 0.98;

    const canvasOuter = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, hexpand: true});
    canvasOuter.add_css_class('llp-mon-canvas');
    canvasOuter.set_size_request(520, 308);
    canvasOuter.set_valign(Gtk.Align.FILL);

    const centerBox = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, hexpand: true, vexpand: true});
    try { centerBox.set_halign(Gtk.Align.CENTER); } catch (e) {}
    try { centerBox.set_valign(Gtk.Align.CENTER); } catch (e2) {}

    const fixed = new Gtk.Fixed();
    fixed.set_size_request(PREVIEW_W, PREVIEW_H);

    const tiles = [];

    const selectedConnectors = () => tiles.filter(t => t.tb.get_active()).map(t => t.mon.connector).filter(Boolean);

    const updateTileStyles = () => {
        const per = btnPer.get_active();
        for (const {tb, tileRoot} of tiles) {
            if (per && tb.get_active())
                tileRoot.add_css_class('llp-apply-mon-selected');
            else
                tileRoot.remove_css_class('llp-apply-mon-selected');
        }
    };

    const status = new Gtk.Label({label: '', xalign: 0, wrap: true});
    try { status.set_max_width_chars(56); } catch (e) {}

    const refreshStatus = () => {
        if (btnShared.get_active()) {
            status.set_label('Same playlist, in sync on all monitors.');
        } else {
            const sel = selectedConnectors();
            if (!sel.length)
                status.set_label('Tick the monitors to update. Previews use different clips per display.');
            else if (sel.length === 1)
                status.set_label(`Same playlist on ${sel[0]}; not in sync with other screens.`);
            else
                status.set_label(`Same playlist on ${sel.length} monitors; not in sync between them.`);
        }
    };

    const APPLY_THUMB_TAG = 'applyDlgHi2';
    const applyThumbGen = (bw, bh) => ({
        w: Math.min(2560, Math.max(280, Math.round(bw * 4))),
        h: Math.min(1600, Math.max(210, Math.round(bh * 4))),
    });
    const refreshTilePreviews = () => {
        const shared = btnShared.get_active();
        for (const t of tiles) {
            const idx = t.mon.index ?? 0;
            const clipPath = list.length
                ? (shared ? list[0] : list[idx % list.length])
                : null;
            const bw = t.bw | 0;
            const bh = t.bh | 0;
            const {w: genW, h: genH} = applyThumbGen(bw, bh);
            if (clipPath) {
                this._ensureThumb(clipPath, APPLY_THUMB_TAG, genW, genH, thumb =>
                    addImageOrFallback(t.pic, thumb, genW, genH));
            } else {
                addImageOrFallback(t.pic, null, genW, genH);
            }
        }
    };

    const setPerToolbarVisible = vis => {
        try { perToolbar.set_visible(vis); } catch (e) {}
    };

    monitors.forEach(mon => {
        const x = mon.x ?? 0;
        const y = mon.y ?? 0;
        const rawW = Math.max(mon.width || 0, 320);
        const rawH = Math.max(mon.height || 0, 240);
        const dx = margin + (x - minX) * scale;
        const dy = margin + (y - minY) * scale;
        const bw = Math.max(92, Math.round(rawW * scale));
        const bh = Math.max(120, Math.round(rawH * scale));
        const {w: hiW, h: hiH} = applyThumbGen(bw, bh);

        const dimStr = (mon.width && mon.height) ? `${mon.width}×${mon.height}` : '';
        const pretty = (mon.manufacturer && mon.model) ? `${mon.manufacturer} ${mon.model}` : '';
        const gdkNum = (mon.index ?? 0) + 1;
        const tip = `Display ${gdkNum} — ${mon.connector || 'Unknown'}${pretty ? `\n${pretty}` : ''}${dimStr ? `\n${dimStr}` : ''}\n\nSame order as Settings → Displays.`;

        const tileRoot = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6});
        tileRoot.add_css_class('llp-apply-mon-column');
        try { tileRoot.set_tooltip_text(tip); } catch (e) {}

        const picWrap = clipOverflow(new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, hexpand: false, vexpand: false}));
        try { picWrap.set_hexpand(true); } catch (e0) {}
        try { picWrap.set_vexpand(true); } catch (e0b) {}
        const pic = new Gtk.Picture({can_shrink: true, content_fit: Gtk.ContentFit.COVER, hexpand: true, vexpand: true});
        addImageOrFallback(pic, null, hiW, hiH);
        picWrap.append(pic);

        const tb = new Gtk.ToggleButton();
        tb.add_css_class('flat');
        tb.add_css_class('llp-mon-tile');
        tb.add_css_class('llp-apply-mon-screen');
        if (mon.isPrimary)
            tb.add_css_class('primary');
        tb.set_child(picWrap);
        tb.set_size_request(bw, bh);
        try { tb.set_tooltip_text(tip); } catch (eTip) {}

        const caption = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 2});
        caption.add_css_class('llp-apply-mon-caption');
        try { caption.set_tooltip_text(tip); } catch (eTip2) {}
        try { caption.set_size_request(bw, -1); } catch (eSz) {}

        const title = new Gtk.Label({label: `Display ${gdkNum}`, xalign: 0.5});
        title.add_css_class('llp-mon-tile-title');
        const connL = new Gtk.Label({label: mon.connector || '?', xalign: 0.5});
        connL.set_ellipsize(Pango.EllipsizeMode.END);
        try { connL.set_max_width_chars(18); } catch (e2) {}
        connL.add_css_class('llp-mon-tile-conn');
        caption.append(title);
        caption.append(connL);
        if (dimStr) {
            const dimL = new Gtk.Label({label: dimStr, xalign: 0.5});
            dimL.add_css_class('llp-mon-tile-dim');
            caption.append(dimL);
        }
        if (mon.isPrimary) {
            const prim = new Gtk.Label({label: 'Primary', xalign: 0.5});
            prim.add_css_class('llp-mon-tile-dim');
            caption.append(prim);
        }

        tileRoot.append(tb);
        tileRoot.append(caption);

        tb.connect('toggled', () => {
            if (tb.get_active())
                try { btnPer.set_active(true); } catch (e3) {}
            updateTileStyles();
            refreshStatus();
        });

        tiles.push({tb, mon, pic, bw, bh, tileRoot});
        try {
            fixed.put(tileRoot, dx, dy);
        } catch (e4) {}
    });

    refreshTilePreviews();

    centerBox.append(fixed);
    canvasOuter.append(centerBox);
    area.append(canvasOuter);
    area.append(status);

    const onModeChange = () => {
        const per = btnPer.get_active();
        setPerToolbarVisible(per);
        if (btnShared.get_active()) {
            for (const {tb} of tiles)
                tb.set_active(false);
        }
        updateTileStyles();
        refreshStatus();
        refreshTilePreviews();
    };

    btnShared.connect('toggled', () => {
        if (btnShared.get_active())
            onModeChange();
    });
    btnPer.connect('toggled', () => {
        if (btnPer.get_active())
            onModeChange();
    });

    selectAllBtn.connect('clicked', () => {
        try { btnPer.set_active(true); } catch (e) {}
        for (const {tb} of tiles)
            tb.set_active(true);
        updateTileStyles();
        refreshStatus();
    });
    clearSelBtn.connect('clicked', () => {
        for (const {tb} of tiles)
            tb.set_active(false);
        updateTileStyles();
        refreshStatus();
    });

    setPerToolbarVisible(false);
    refreshStatus();

    dlg.connect('response', (_d, response) => {
        if (response === Gtk.ResponseType.OK) {
            const shared = btnShared.get_active();
            const sel = selectedConnectors();
            if (!shared && !sel.length)
                return;
            dlg.destroy();
            if (shared)
                applyShared();
            else
                applyPerDisplay(sel);
            this._scheduleHomeSelectionRefresh();
            return;
        }
        dlg.destroy();
    });

    dlg.present();
},

_buildLibraryPage() {
    const page = new Adw.PreferencesPage({title: 'Library', name: 'library', icon_name: 'video-x-generic-symbolic'});
    const group = new Adw.PreferencesGroup();
    const root = box(Gtk.Orientation.HORIZONTAL, 12, true, true);
    root.add_css_class('llp-page-wrap');
    root.add_css_class('llp-library-root');

    const state = {
        entries: [],
        filteredEntries: [],
        currentKeys: [],
        currentEntries: [],
        sidebarFilter: '',
        heroPath: null,
        isPreviewing: false,
        sidebarInitialized: false,
        lastSidebarIndex: -1,
        heroMetaSeq: 0,
        sidebarBuildGen: 0,
        flowBuildGen: 0,
        sidebarIdleId: 0,
        flowIdleId: 0,
        /** LRU Map: selection+clips signature → seen after a full grid build (fast path on revisit). */
        flowWarmLRU: null,
    };

    /** Set after toolbar load widgets are built; cancelFlowIdleOnly calls hide. */
    const flowLoadUi = {
        hide: () => {},
        showClearing: () => {},
        showAdding: (_done, _total) => {},
    };

    const clearFlowWarmCache = () => {
        if (state.flowWarmLRU)
            state.flowWarmLRU.clear();
    };

    const touchFlowWarm = sig => {
        if (!state.flowWarmLRU)
            state.flowWarmLRU = new Map();
        if (state.flowWarmLRU.has(sig))
            state.flowWarmLRU.delete(sig);
        state.flowWarmLRU.set(sig, true);
        while (state.flowWarmLRU.size > 256) {
            const k = state.flowWarmLRU.keys().next().value;
            state.flowWarmLRU.delete(k);
        }
    };

    const flowGridSignature = clips => {
        const keys = [...state.currentKeys].sort();
        return `${keys.join('\u0001')}\u0002${clips.join('\u0001')}`;
    };

    const cancelFlowIdleOnly = () => {
        if (state.flowIdleId) {
            try {
                GLib.Source.remove(state.flowIdleId);
            } catch (e) {}
            state.flowIdleId = 0;
        }
        flowLoadUi.hide();
    };

    const cancelLibraryChunkIds = () => {
        if (state.sidebarIdleId) {
            try {
                GLib.Source.remove(state.sidebarIdleId);
            } catch (e) {}
            state.sidebarIdleId = 0;
        }
        cancelFlowIdleOnly();
    };

    const left = box(Gtk.Orientation.VERTICAL, 10, false, true);
    left.set_size_request(260, -1);
    left.add_css_class('llp-sidebar-card');

    const leftTop = box(Gtk.Orientation.VERTICAL, 4, true, false);
    const brandRow = box(Gtk.Orientation.HORIZONTAL, 10, true, false);
    try { brandRow.set_valign(Gtk.Align.START); } catch (eBr) {}
    brandRow.add_css_class('llp-sidebar-brand');
    const logoImg = new Gtk.Image();
    try { logoImg.set_valign(Gtk.Align.CENTER); } catch (eLv) {}
    try { logoImg.set_pixel_size(36); } catch (ePx) {}
    const flowerPaintable = this._loadExtensionIconPaintable('flower', 72);
    if (flowerPaintable) {
        try { logoImg.set_from_paintable(flowerPaintable); } catch (eFp) {}
    } else {
        try { logoImg.set_from_icon_name('image-missing-symbolic'); } catch (eIc) {}
    }
    const eyebrow = new Gtk.Label({label: APP_ID, xalign: 0});
    eyebrow.add_css_class('llp-section-title');
    try { eyebrow.set_valign(Gtk.Align.CENTER); } catch (eEy) {}
    try { eyebrow.set_hexpand(true); } catch (eHx) {}
    brandRow.append(logoImg);
    brandRow.append(eyebrow);
    const leftTitle = new Gtk.Label({label: 'Your library', xalign: 0});
    leftTitle.add_css_class('llp-big-copy');
    leftTitle.set_wrap(true);
    const leftSub = new Gtk.Label({label: 'Videos on this device, folders you imported, and playlists you created.', xalign: 0, wrap: true});
    leftSub.add_css_class('llp-subtitle');
    leftTop.append(brandRow);
    leftTop.append(leftTitle);
    leftTop.append(leftSub);

    const entrySearch = new Gtk.SearchEntry({placeholder_text: 'Search files or playlists…'});
    entrySearch.add_css_class('llp-search');

    const sideStats = box(Gtk.Orientation.HORIZONTAL, 6, true, false);
    const entriesPill = makePill('0 items');
    const clipsPill = makePill('0 clips');
    sideStats.append(entriesPill);
    sideStats.append(clipsPill);

    const listBox = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE, vexpand: true});
    listBox.add_css_class('navigation-sidebar');
    const listScroll = new Gtk.ScrolledWindow({hexpand: true, vexpand: true});
    listScroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC);
    listScroll.set_child(listBox);

    left.append(leftTop);
    left.append(entrySearch);
    left.append(sideStats);
    left.append(listScroll);

    const sidebarRemoveFooter = box(Gtk.Orientation.VERTICAL, 8, false, false);
    const sidebarRemoveBtn = new Gtk.Button();
    sidebarRemoveBtn.set_child(this._makeTextIconButton('Remove from library', 'user-trash-symbolic', 16));
    sidebarRemoveBtn.add_css_class('destructive-action');
    sidebarRemoveBtn.set_tooltip_text('Remove the selected sidebar item (folder, file, or playlist) from your library.');
    try {
        sidebarRemoveBtn.set_hexpand(true);
    } catch (eSb) {}
    sidebarRemoveFooter.append(sidebarRemoveBtn);
    left.append(sidebarRemoveFooter);

    const right = box(Gtk.Orientation.VERTICAL, 0, true, true);
    right.add_css_class('llp-main-card');

    const topRow = box(Gtk.Orientation.HORIZONTAL, 8, true, false);
    topRow.set_margin_bottom(12);
    const selectedEntriesPill = makePill('0 library items selected');
    /** Always hexpand with two springs so buttons stay right; only inner box toggles visibility. */
    const topMid = box(Gtk.Orientation.HORIZONTAL, 0, true, false);
    topMid.set_hexpand(true);
    const topMidSpringL = new Gtk.Box({hexpand: true});
    const flowLoadBox = box(Gtk.Orientation.VERTICAL, 5, false, false);
    flowLoadBox.set_valign(Gtk.Align.CENTER);
    const flowLoadLabel = new Gtk.Label({label: '', xalign: 0.5});
    flowLoadLabel.add_css_class('llp-dim');
    const flowLoadBar = new Gtk.ProgressBar();
    flowLoadBar.set_hexpand(true);
    flowLoadBar.set_size_request(200, -1);
    flowLoadBar.add_css_class('llp-flow-load-bar');
    flowLoadBox.append(flowLoadLabel);
    flowLoadBox.append(flowLoadBar);
    flowLoadBox.set_visible(false);
    const topMidSpringR = new Gtk.Box({hexpand: true});
    topMid.append(topMidSpringL);
    topMid.append(flowLoadBox);
    topMid.append(topMidSpringR);
    const addFilesLinked = box(Gtk.Orientation.HORIZONTAL, 0, false, false);
    addFilesLinked.add_css_class('linked');
    const addFilesBtn = new Gtk.Button({label: 'Add files'});
    const addToContainerBtn = new Gtk.Button({label: 'To folder / playlist'});
    addFilesBtn.add_css_class('suggested-action');
    addToContainerBtn.add_css_class('suggested-action');
    addFilesBtn.set_tooltip_text('Add video files as standalone library items (paths only; files are not moved).');
    addFilesLinked.append(addFilesBtn);
    addFilesLinked.append(addToContainerBtn);
    const addFolderBtn = new Gtk.Button({label: 'Add folder'});
    const reloadBtn = new Gtk.Button({icon_name: 'view-refresh-symbolic'});
    topRow.append(selectedEntriesPill);
    topRow.append(topMid);
    topRow.append(addFilesLinked);
    topRow.append(addFolderBtn);
    topRow.append(reloadBtn);

    Object.assign(flowLoadUi, {
        hide() {
            try {
                flowLoadBox.set_visible(false);
                flowLoadBar.set_fraction(0);
                flowLoadLabel.set_label('');
            } catch (e) {}
        },
        showClearing() {
            try {
                flowLoadBox.set_visible(true);
                flowLoadLabel.set_label('Preparing view…');
                flowLoadBar.set_fraction(0);
                flowLoadBar.pulse();
            } catch (e) {}
        },
        showAdding(done, total) {
            try {
                flowLoadBox.set_visible(true);
                const t = total | 0;
                flowLoadLabel.set_label(
                    t > 0
                        ? `Loading clips… ${Math.min(done | 0, t)} / ${t}`
                        : 'Loading clips…',
                );
                flowLoadBar.set_fraction(t > 0 ? Math.min(1, (done | 0) / t) : 0);
            } catch (e) {}
        },
    });

    const contentScroll = new Gtk.ScrolledWindow({hexpand: true, vexpand: true});
    contentScroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC);
    const contentBox = box(Gtk.Orientation.VERTICAL, 12, true, false);
    contentBox.set_margin_top(4);
    contentBox.set_margin_bottom(4);
    contentScroll.set_child(contentBox);

    const heroOverlay = clipOverflow(new Gtk.Overlay({hexpand: true, vexpand: false}));
    heroOverlay.add_css_class('llp-hero-shell');
    heroOverlay.add_css_class('llp-drop');

    const heroPicture = new Gtk.Picture({can_shrink: true, content_fit: Gtk.ContentFit.COVER, hexpand: true, vexpand: true});
    heroPicture.add_css_class('llp-hero-media');
    heroPicture.set_size_request(HERO_W, HERO_H);
    heroOverlay.set_child(heroPicture);

    const heroVideo = new Gtk.Video({hexpand: true, vexpand: true, autoplay: true, loop: true});
    heroVideo.add_css_class('llp-hero-media');
    heroVideo.set_size_request(HERO_W, HERO_H);
    heroVideo.set_visible(false);
    heroOverlay.add_overlay(heroVideo);

    const heroMeta = box(Gtk.Orientation.VERTICAL, 6, true, false);
    heroMeta.add_css_class('llp-hero-meta');
    heroMeta.set_halign(Gtk.Align.FILL);
    heroMeta.set_valign(Gtk.Align.END);

    const heroChipRow = box(Gtk.Orientation.HORIZONTAL, 6, true, false);
    heroChipRow.add_css_class('llp-library-chip-row');
    const {widget: heroSourcePillBox, apply: applyHeroSourcePill} = this._makeOverlaySourcePill(36);
    heroChipRow.append(heroSourcePillBox);
    const heroTitle = new Gtk.Label({label: 'No library item selected', xalign: 0, ellipsize: Pango.EllipsizeMode.END, max_width_chars: 42});
    heroTitle.add_css_class('llp-hero-title');
    const clearHeroChipRowMeta = () => {
        const first = heroChipRow.get_first_child();
        let cur = first ? first.get_next_sibling() : null;
        while (cur) {
            const next = cur.get_next_sibling();
            heroChipRow.remove(cur);
            cur = next;
        }
    };
    heroMeta.append(heroChipRow);
    heroMeta.append(heroTitle);
    heroOverlay.add_overlay(heroMeta);

    const playOverlayButton = new Gtk.Button({icon_name: 'media-playback-start-symbolic'});
    playOverlayButton.set_halign(Gtk.Align.CENTER);
    playOverlayButton.set_valign(Gtk.Align.CENTER);
    playOverlayButton.add_css_class('flat');
    playOverlayButton.add_css_class('llp-center-play');
    heroOverlay.add_overlay(playOverlayButton);

    const actionRow = box(Gtk.Orientation.HORIZONTAL, 8, false, false);
    const selectAllBtn = new Gtk.Button({label: 'Select all'});
    const clearSelBtn = new Gtk.Button({label: 'Clear selection'});
    actionRow.append(selectAllBtn);
    actionRow.append(clearSelBtn);

    const flow = new Gtk.FlowBox({
        selection_mode: Gtk.SelectionMode.MULTIPLE,
        row_spacing: 14,
        column_spacing: 14,
        valign: Gtk.Align.START,
        max_children_per_line: 100,
        min_children_per_line: 1,
        activate_on_single_click: false,
        hexpand: true,
        vexpand: false,
    });
    const libraryPlayMetaSigIds = [];

    const footer = box(Gtk.Orientation.HORIZONTAL, 8, true, false);
    footer.add_css_class('llp-footer-bar');
    const footerPrimary = box(Gtk.Orientation.HORIZONTAL, 8, false, false);
    footerPrimary.add_css_class('llp-footer-primary-actions');
    try {
        footerPrimary.set_hexpand(true);
    } catch (eFp) {}
    const makeLibFooterButton = (labelText, iconName) => {
        const row = box(Gtk.Orientation.HORIZONTAL, 8, false, false);
        row.set_valign(Gtk.Align.CENTER);
        const img = new Gtk.Image({icon_name: iconName, pixel_size: 16, valign: Gtk.Align.CENTER});
        const textLabel = new Gtk.Label({label: labelText, xalign: 0, valign: Gtk.Align.CENTER});
        row.append(img);
        row.append(textLabel);
        const btn = new Gtk.Button();
        btn.set_child(row);
        btn.add_css_class('llp-lib-footer-btn');
        btn._footerLabel = textLabel;
        try { btn.set_valign(Gtk.Align.CENTER); } catch (eV) {}
        return btn;
    };
    const setLockBtn = makeLibFooterButton('Apply to lock screen', 'changes-prevent-symbolic');
    setLockBtn.add_css_class('suggested-action');
    const setWallpaperBtn = makeLibFooterButton('Apply to wallpaper', 'preferences-desktop-wallpaper-symbolic');
    const playlistBtn = makeLibFooterButton('New playlist', 'view-list-symbolic');
    playlistBtn.set_has_tooltip(true);
    playlistBtn.connect('query-tooltip', (_w, _x, _y, _kb, tooltip) => {
        tooltip.set_markup(
            '<b>Create playlist</b>&#10;&#10;'
            + '• If any grid thumbnails are selected, the new playlist uses those videos.&#10;'
            + '• Otherwise it uses every video from your current sidebar selection (folders, playlists, and/or files—combined).',
        );
        return true;
    });
    const removeFromListBtn = makeLibFooterButton('Remove from list', 'user-trash-symbolic');
    removeFromListBtn.add_css_class('destructive-action');
    const footerSpacer = new Gtk.Box({hexpand: true});
    const selectionLabel = new Gtk.Label({label: '0 Grid Items Selected', xalign: 1});
    selectionLabel.add_css_class('llp-footer-grid-count');
    footerPrimary.append(setLockBtn);
    footerPrimary.append(setWallpaperBtn);
    footerPrimary.append(playlistBtn);
    footerPrimary.append(removeFromListBtn);
    footer.append(footerPrimary);
    footer.append(footerSpacer);
    footer.append(selectionLabel);

    contentBox.append(heroOverlay);
    contentBox.append(actionRow);
    contentBox.append(flow);

    const scrollOverlay = new Gtk.Overlay({hexpand: true, vexpand: true});
    scrollOverlay.set_child(contentScroll);
    const scrollTopFab = box(Gtk.Orientation.VERTICAL, 0, false, false);
    scrollTopFab.add_css_class('llp-library-scroll-top-fab');
    scrollTopFab.set_halign(Gtk.Align.END);
    scrollTopFab.set_valign(Gtk.Align.END);
    scrollTopFab.set_margin_end(14);
    scrollTopFab.set_margin_bottom(14);
    scrollTopFab.set_size_request(52, 52);
    scrollTopFab.set_visible(false);
    scrollTopFab.set_tooltip_text('Scroll to top');
    try { scrollTopFab.set_focusable(true); } catch (eF) {}
    const scrollTopIcon = new Gtk.Image({icon_name: 'go-up-symbolic'});
    try { scrollTopIcon.set_pixel_size(22); } catch (ePi) {}
    try { scrollTopIcon.set_vexpand(true); } catch (eVe) {}
    try { scrollTopIcon.set_valign(Gtk.Align.CENTER); } catch (eVc) {}
    try { scrollTopIcon.set_halign(Gtk.Align.CENTER); } catch (eHc) {}
    scrollTopFab.append(scrollTopIcon);
    const scrollTopFabClick = new Gtk.GestureClick();
    scrollTopFabClick.connect('released', () => runLibraryScrollToTop());
    scrollTopFab.add_controller(scrollTopFabClick);
    try {
        const dispFab = Gdk.Display.get_default();
        if (dispFab)
            scrollTopFab.set_cursor(Gdk.Cursor.new_from_name(dispFab, 'pointer'));
    } catch (eCur) {}
    scrollOverlay.add_overlay(scrollTopFab);

    let libVadj = null;
    try {
        const vp = contentScroll.get_child();
        if (vp?.get_vadjustment)
            libVadj = vp.get_vadjustment();
        else if (vp && Gtk.Scrollable?.get_vadjustment)
            libVadj = Gtk.Scrollable.get_vadjustment(vp);
    } catch (eVj) {}

    const syncLibraryScrollTopBtn = () => {
        if (!libVadj)
            return;
        try {
            const upper = libVadj.get_upper();
            const page = libVadj.get_page_size();
            const maxScroll = Math.max(0, upper - page);
            scrollTopFab.set_visible(maxScroll > 12 && libVadj.get_value() > 24);
        } catch (eSy) {}
    };
    if (libVadj) {
        libVadj.connect('value-changed', syncLibraryScrollTopBtn);
        libVadj.connect('notify::upper', syncLibraryScrollTopBtn);
        libVadj.connect('notify::page-size', syncLibraryScrollTopBtn);
    }
    let libraryScrollAnimId = 0;
    const runLibraryScrollToTop = () => {
        if (!libVadj)
            return;
        let start;
        try { start = libVadj.get_value(); } catch (e) { return; }
        if (start <= 2)
            return;
        if (libraryScrollAnimId) {
            try { GLib.Source.remove(libraryScrollAnimId); } catch (eRm) {}
            libraryScrollAnimId = 0;
        }
        const t0 = GLib.get_monotonic_time();
        const durationUs = 380 * 1000;
        const tick = () => {
            const elapsed = GLib.get_monotonic_time() - t0;
            const u = Math.min(1, elapsed / durationUs);
            const eased = 1 - (1 - u) * (1 - u);
            try { libVadj.set_value(start * (1 - eased)); } catch (eT) {}
            if (u < 1)
                return GLib.SOURCE_CONTINUE;
            try { libVadj.set_value(0); } catch (eT2) {}
            libraryScrollAnimId = 0;
            return GLib.SOURCE_REMOVE;
        };
        libraryScrollAnimId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, tick);
    };
    page.connect('unrealize', () => {
        cancelLibraryChunkIds();
        if (libraryScrollAnimId) {
            try { GLib.Source.remove(libraryScrollAnimId); } catch (eUr) {}
            libraryScrollAnimId = 0;
        }
    });
    scrollOverlay.connect('map', () => {
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            syncLibraryScrollTopBtn();
            return GLib.SOURCE_REMOVE;
        });
    });

    right.append(topRow);
    right.append(scrollOverlay);
    right.append(footer);

    const currentClips = () => uniq(state.currentEntries.flatMap(e => e.clips || []));

    /** Resolve to the string used in `store.folders`, or null (avoids orphan `folderExtras` keys). */
    const resolveFolderKeyInStore = (store, path) => {
        if (path == null || path === '')
            return null;
        const exact = store.folders.find(f => f === path);
        if (exact != null)
            return exact;
        try {
            const ef = Gio.File.new_for_path(path);
            const found = store.folders.find(f => {
                try {
                    return ef.equal(Gio.File.new_for_path(f));
                } catch (e) {
                    return false;
                }
            });
            if (found != null)
                return found;
        } catch (e2) {}
        return null;
    };

    /** Drop excluded paths when the user re-adds those files via “Add to folder”. */
    const removePathsFromFolderExcludes = (store, canonicalFolder, pathList) => {
        if (!pathList.length || !store.folderExcludes || typeof store.folderExcludes !== 'object')
            return;
        for (const mapKey of Object.keys(store.folderExcludes)) {
            if (!sameLibraryFilePath(mapKey, canonicalFolder))
                continue;
            const ex = store.folderExcludes[mapKey];
            if (!Array.isArray(ex))
                continue;
            const next = ex.filter(oldP => !pathList.some(np => sameLibraryFilePath(oldP, np)));
            if (next.length)
                store.folderExcludes[mapKey] = next;
            else
                delete store.folderExcludes[mapKey];
        }
    };

    const setPreviewState = active => {
        state.isPreviewing = !!active;
        heroMeta.set_visible(!state.isPreviewing);
        playOverlayButton.set_visible(!state.isPreviewing && !!state.heroPath);
        if (!state.isPreviewing) {
            heroVideo.set_visible(false);
            try {
                heroVideo.media_stream?.pause?.();
                heroVideo.media_stream?.seek?.(0);
            } catch (e) {}
        }
    };

    const startPreview = () => {
        if (!state.heroPath)
            return;
        try {
            heroVideo.set_file(Gio.File.new_for_path(state.heroPath));
            heroVideo.set_visible(true);
            setPreviewState(true);
        } catch (e) {}
    };
    const stopPreview = () => setPreviewState(false);
    const togglePreview = () => state.isPreviewing ? stopPreview() : startPreview();
    const click = new Gtk.GestureClick();
    click.connect('released', () => togglePreview());
    heroOverlay.add_controller(click);
    playOverlayButton.connect('clicked', togglePreview);

    const selectedPaths = () => {
        const out = [];
        let child = flow.get_first_child();
        while (child) {
            if (child.is_selected?.() && child._videoPath)
                out.push(child._videoPath);
            child = child.get_next_sibling();
        }
        return out;
    };

    /** Flow selection is often cleared before `clicked` when the footer button takes focus; capture on `pressed`. */
    let gridPathsAtRemovePress = [];

    const setFooterIconBtnLabel = (btn, text) => {
        try {
            if (btn._footerLabel?.set_label)
                btn._footerLabel.set_label(text);
        } catch (e) {}
    };

    const syncLibraryFooterLabels = () => {
        const gridN = selectedPaths().length;
        const nLib = state.currentEntries.length;
        let lockTip = '';
        let wpTip = '';
        if (gridN > 0) {
            lockTip = `Apply ${gridN} selected video${gridN === 1 ? '' : 's'} to the lock screen.`;
            wpTip = `Apply ${gridN} selected video${gridN === 1 ? '' : 's'} as wallpaper.`;
        } else if (nLib === 1) {
            const k = state.currentEntries[0].kind;
            if (k === 'folder') {
                lockTip = 'Apply all videos in this folder to the lock screen.';
                wpTip = 'Apply all videos in this folder as wallpaper.';
            } else if (k === 'playlist') {
                lockTip = 'Apply all videos in this playlist to the lock screen.';
                wpTip = 'Apply all videos in this playlist as wallpaper.';
            } else {
                lockTip = 'Apply this video to the lock screen.';
                wpTip = 'Apply this video as wallpaper.';
            }
        } else if (nLib > 1) {
            lockTip = 'Apply all videos from the selected sidebar items (combined) to the lock screen.';
            wpTip = 'Apply all videos from the selected sidebar items (combined) as wallpaper.';
        } else {
            lockTip = 'Select a library item or choose videos in the grid.';
            wpTip = 'Select a library item or choose videos in the grid.';
        }
        try {
            setLockBtn.set_tooltip_text(lockTip);
            setWallpaperBtn.set_tooltip_text(wpTip);
        } catch (eTt) {}

        try {
            sidebarRemoveBtn.set_sensitive(state.currentKeys.length > 0);
        } catch (eSb) {}

        const one = nLib === 1 ? state.currentEntries[0] : null;
        const canAddHere = !!(one && (one.kind === 'folder' || one.kind === 'playlist'));
        try {
            addToContainerBtn.set_sensitive(canAddHere);
            addToContainerBtn.set_label(
                canAddHere
                    ? (one.kind === 'folder' ? 'To folder' : 'To playlist')
                    : 'To folder / playlist',
            );
            addToContainerBtn.set_tooltip_text(
                canAddHere
                    ? `Add file paths into “${one.title}” (${one.kind}). Files stay on disk; only the library is updated.`
                    : 'Select exactly one folder or playlist in the sidebar to add files into it.',
            );
        } catch (eAc) {}

        const canStrip = !!(one && (one.kind === 'folder' || one.kind === 'playlist') && gridN > 0);
        let removeLabel = 'Remove from list';
        if (one?.kind === 'folder')
            removeLabel = 'Remove from folder';
        else if (one?.kind === 'playlist')
            removeLabel = 'Remove from playlist';
        try {
            removeFromListBtn.set_sensitive(canStrip);
            setFooterIconBtnLabel(removeFromListBtn, removeLabel);
            removeFromListBtn.set_tooltip_text(
                canStrip
                    ? (one.kind === 'playlist'
                        ? 'Remove selected videos from this playlist (files stay on disk).'
                        : 'Hide selected videos from this folder in the library (files stay on disk).')
                    : (one?.kind === 'folder' || one?.kind === 'playlist'
                        ? 'Select videos in the grid first, then use this to drop them from this folder or playlist.'
                        : 'Select a folder or playlist and choose grid videos to remove from that list.'),
            );
        } catch (eRl) {}
    };

    const syncSelectionLabel = () => {
        selectionLabel.set_label(`${selectedPaths().length} Grid Items Selected`);
        syncLibraryFooterLabels();
    };
    const refreshSidebarStats = () => {
        const entries = this._libraryEntries();
        entriesPill.set_label(`${entries.length} items`);
        clipsPill.set_label(`${entries.reduce((a, e) => a + e.clips.length, 0)} clips`);
    };

    const appendHeroMetaPill = text => {
        const p = makePill(text);
        try { p.set_valign(Gtk.Align.CENTER); } catch (eV) {}
        heroChipRow.append(p);
    };
    const applyLibraryHeroSourcePill = path => {
        if (state.currentEntries.length === 1) {
            const e = state.currentEntries[0];
            applyHeroSourcePill(e.kind, e.title || '');
        } else if (state.currentEntries.length > 1) {
            applyHeroSourcePill('playlist', `${state.currentEntries.length} library items`);
        } else {
            try {
                const dir = GLib.path_get_dirname(path || '') || '';
                const name = basename(dir) || dir || '';
                applyHeroSourcePill('folder', name);
            } catch (e) {
                applyHeroSourcePill(null, '');
            }
        }
    };
    const fillHeroMetaSingle = (path, meta) => {
        clearHeroChipRowMeta();
        applyLibraryHeroSourcePill(path);
        if (meta.width && meta.height) appendHeroMetaPill(`${meta.width}×${meta.height}`);
        if (meta.fps) appendHeroMetaPill(`${meta.fps} fps`);
        if (meta.duration) appendHeroMetaPill(formatDuration(meta.duration));
        if (meta.size) appendHeroMetaPill(formatBytes(meta.size));
    };
    const fillHeroMetaAggregate = (clips, seq) => {
        clearHeroChipRowMeta();
        applyLibraryHeroSourcePill(clips[0]);
        appendHeroMetaPill(`${clips.length} clips`);
        const HERO_AGG_MAX = 100;
        if (clips.length > HERO_AGG_MAX)
            return;
        this._sumMetadataForPaths(clips, totals => {
            if (seq !== state.heroMetaSeq)
                return;
            clearHeroChipRowMeta();
            applyLibraryHeroSourcePill(clips[0]);
            if (totals.count)
                appendHeroMetaPill(`${totals.count} clips`);
            if (totals.duration)
                appendHeroMetaPill(formatDuration(totals.duration));
            if (totals.size)
                appendHeroMetaPill(formatBytes(totals.size));
        });
    };

    const updateHero = path => {
        state.heroPath = path || null;
        stopPreview();
        state.heroMetaSeq++;
        const seq = state.heroMetaSeq;
        const clips = currentClips();
        if (!path || !clips.length) {
            heroTitle.set_label(
                !state.currentKeys.length
                    ? 'Select a folder, file, or playlist'
                    : 'No clips to show',
            );
            applyHeroSourcePill(null, '');
            clearHeroChipRowMeta();
            addImageOrFallback(heroPicture, null, HERO_W, HERO_H);
            playOverlayButton.set_visible(false);
            return;
        }
        heroTitle.set_label(basenameNoExt(path));
        addImageOrFallback(heroPicture, null, HERO_W, HERO_H);
        playOverlayButton.set_visible(true);
        this._ensureThumb(path, 'hero', HERO_W, HERO_H, thumb => addImageOrFallback(heroPicture, thumb, HERO_W, HERO_H));
        if (clips.length === 1) {
            this._metadataFor(clips[0], meta => {
                if (seq !== state.heroMetaSeq)
                    return;
                fillHeroMetaSingle(clips[0], meta || {});
            });
        } else {
            fillHeroMetaAggregate(clips, seq);
        }
    };

    let flowRenderSkipCellMeta = false;

    const addClipFlowCard = path => {
        const child = new Gtk.FlowBoxChild();
        child._videoPath = path;
        child.set_can_focus(true);
        const outer = clipOverflow(box(Gtk.Orientation.VERTICAL, 0, false, false));
        outer.add_css_class('llp-thumb-card');
        outer.set_size_request(CARD_W, -1);
        const overlay = clipOverflow(new Gtk.Overlay());
        const pic = new Gtk.Picture({can_shrink: true, content_fit: Gtk.ContentFit.COVER});
        pic.add_css_class('llp-thumb-media');
        pic.set_size_request(CARD_W, CARD_H);
        overlay.set_child(pic);
        addImageOrFallback(pic, null, CARD_W, CARD_H);
        this._ensureThumb(path, 'grid', CARD_W, CARD_H, thumb => addImageOrFallback(pic, thumb, CARD_W, CARD_H));
        const topLeft = new Gtk.Label({label: ''});
        topLeft.add_css_class('llp-badge');
        topLeft.set_halign(Gtk.Align.START);
        topLeft.set_valign(Gtk.Align.START);
        overlay.add_overlay(topLeft);
        const topRight = new Gtk.Label({label: ''});
        topRight.add_css_class('llp-badge');
        topRight.set_halign(Gtk.Align.END);
        topRight.set_valign(Gtk.Align.START);
        overlay.add_overlay(topRight);
        if (!flowRenderSkipCellMeta) {
            this._metadataFor(path, meta => {
                topRight.set_label(meta.duration ? formatDuration(meta.duration) : '');
            });
        }
        const nPlays = this._playCountTotalForLibraryVideoPath(path);
        try { topLeft.set_label(formatPlayCountLabel(nPlays)); } catch (ePl) {}
        child._playCountLabel = topLeft;
        const textBox = box(Gtk.Orientation.VERTICAL, 2, true, false);
        textBox.set_margin_top(8); textBox.set_margin_bottom(8); textBox.set_margin_start(8); textBox.set_margin_end(8);
        const title = new Gtk.Label({label: basenameNoExt(path), xalign: 0, ellipsize: Pango.EllipsizeMode.END, max_width_chars: 18});
        title.add_css_class('llp-card-title');
        const sub = new Gtk.Label({label: basename(path), xalign: 0, ellipsize: Pango.EllipsizeMode.MIDDLE, max_width_chars: 24});
        sub.add_css_class('llp-card-subtitle');
        textBox.append(title); textBox.append(sub);
        outer.append(overlay); outer.append(textBox);
        child.set_child(outer);
        flow.insert(child, -1);
    };

    /** Removing thousands of FlowBox children in one pass freezes GTK — clear in slices. */
    const FLOW_CLEAR_BATCH = 72;
    const FLOW_BATCH_COLD = 28;
    const FLOW_BATCH_WARM = 64;
    /** Only instant-fill tiny warmed folders; large ones always chunk so the main loop stays responsive. */
    const FLOW_WARM_SYNC_MAX_CLIPS = 64;
    /** One batch per idle keeps the prefs window responsive; do not pump hundreds of widgets per tick. */
    const FLOW_PUMP_PRIORITY = GLib.PRIORITY_DEFAULT_IDLE;

    const scaleClearBatch = (base, n) => {
        if (n > 2800)
            return Math.min(200, Math.round(base * 2.35));
        if (n > 1400)
            return Math.min(150, Math.round(base * 1.85));
        if (n > 600)
            return Math.min(110, Math.round(base * 1.4));
        return base;
    };

    const scaleAddBatch = (base, n) => {
        if (n > 2800)
            return Math.min(140, Math.round(base * 2.05));
        if (n > 1400)
            return Math.min(110, Math.round(base * 1.65));
        if (n > 600)
            return Math.min(88, Math.round(base * 1.3));
        return base;
    };

    const finishFlowBuild = () => {
        flowLoadUi.hide();
        syncSelectionLabel();
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            syncLibraryScrollTopBtn();
            return GLib.SOURCE_REMOVE;
        });
    };

    const renderFlow = () => {
        cancelFlowIdleOnly();
        state.flowBuildGen = (state.flowBuildGen | 0) + 1;
        const fGen = state.flowBuildGen;

        const clips = currentClips();
        if (!clips.length) {
            flowLoadUi.hide();
            clearChildren(flow);
            updateHero(null);
            syncSelectionLabel();
            return;
        }

        flowRenderSkipCellMeta = clips.length > 280;

        const sig = flowGridSignature(clips);
        const warmHit = !!(state.flowWarmLRU && state.flowWarmLRU.has(sig));
        const addBatchBase = warmHit ? FLOW_BATCH_WARM : FLOW_BATCH_COLD;
        const addBatch = scaleAddBatch(addBatchBase, clips.length);
        const clearBatch = scaleClearBatch(FLOW_CLEAR_BATCH, clips.length);

        const runAfterClear = () => {
            if (fGen !== state.flowBuildGen)
                return;
            updateHero(clips[0]);

            const syncWarmOk = warmHit && clips.length <= FLOW_WARM_SYNC_MAX_CLIPS;
            if (syncWarmOk) {
                touchFlowWarm(sig);
                for (let i = 0; i < clips.length; i++)
                    addClipFlowCard(clips[i]);
                finishFlowBuild();
                return;
            }

            flowLoadUi.showAdding(0, clips.length);
            let fi = 0;
            const pumpFlow = () => {
                if (fGen !== state.flowBuildGen) {
                    state.flowIdleId = 0;
                    flowLoadUi.hide();
                    return GLib.SOURCE_REMOVE;
                }
                const end = Math.min(fi + addBatch, clips.length);
                for (; fi < end; fi++)
                    addClipFlowCard(clips[fi]);
                flowLoadUi.showAdding(fi, clips.length);
                if (fi < clips.length)
                    return GLib.SOURCE_CONTINUE;
                state.flowIdleId = 0;
                touchFlowWarm(sig);
                finishFlowBuild();
                return GLib.SOURCE_REMOVE;
            };
            state.flowIdleId = GLib.idle_add(FLOW_PUMP_PRIORITY, pumpFlow);
        };

        let ch0 = null;
        try {
            ch0 = flow.get_first_child();
        } catch (eFc) {}
        if (!ch0) {
            runAfterClear();
            return;
        }

        flowLoadUi.showClearing();
        const pumpClear = () => {
            if (fGen !== state.flowBuildGen) {
                state.flowIdleId = 0;
                flowLoadUi.hide();
                return GLib.SOURCE_REMOVE;
            }
            let n = 0;
            let ch = flow.get_first_child();
            while (ch && n < clearBatch) {
                const nx = ch.get_next_sibling();
                try {
                    flow.remove(ch);
                } catch (eRm) {}
                ch = nx;
                n++;
            }
            try {
                flowLoadBar.pulse();
            } catch (ePulse) {}
            if (flow.get_first_child())
                return GLib.SOURCE_CONTINUE;
            state.flowIdleId = 0;
            runAfterClear();
            return GLib.SOURCE_REMOVE;
        };
        state.flowIdleId = GLib.idle_add(FLOW_PUMP_PRIORITY, pumpClear);
    };

    const refreshGridPlayCounts = () => {
        let ch = flow.get_first_child();
        while (ch) {
            const lbl = ch._playCountLabel;
            const p = ch._videoPath;
            if (lbl && p) {
                const n = this._playCountTotalForLibraryVideoPath(p);
                try { lbl.set_label(formatPlayCountLabel(n)); } catch (e) {}
            }
            ch = ch.get_next_sibling();
        }
    };
    for (const metaKey of [Keys.VIDEO_METADATA, Keys.WALLPAPER_VIDEO_METADATA]) {
        if (!this._hasSettingKey(metaKey))
            continue;
        try {
            libraryPlayMetaSigIds.push(this._settings.connect(`changed::${metaKey}`, () => refreshGridPlayCounts()));
        } catch (eSig) {}
    }
    page.connect('unrealize', () => {
        cancelLibraryChunkIds();
        for (const id of libraryPlayMetaSigIds) {
            try { this._settings.disconnect(id); } catch (eDisc) {}
        }
        libraryPlayMetaSigIds.length = 0;
    });

    const syncSelectedEntries = () => {
        state.currentEntries = state.filteredEntries.filter(e => state.currentKeys.includes(e.key));
        selectedEntriesPill.set_label(`${state.currentKeys.length} library items selected`);
        syncLibraryFooterLabels();
    };

    const markActiveRows = () => {
        let row = listBox.get_first_child();
        while (row) {
            row.remove_css_class('active');
            if (state.currentKeys.includes(row._entryKey))
                row.add_css_class('active');
            row = row.get_next_sibling();
        }
    };


    const SIDEBAR_BATCH = 14;

    const appendSidebarRow = (entry, idx) => {
        const row = new Gtk.ListBoxRow();
        row._entryKey = entry.key;
        row._entryIndex = idx;
        row.add_css_class('llp-entry-row');

        const rowBox = box(Gtk.Orientation.HORIZONTAL, 10, true, false);
        const thumbWrap = new Gtk.Frame({width_request: 56, height_request: 36});
        thumbWrap.add_css_class('llp-sidebar-thumb');
        const thumbPic = new Gtk.Picture({can_shrink: true, content_fit: Gtk.ContentFit.COVER});
        thumbPic.add_css_class('llp-thumb-media');
        thumbPic.set_size_request(56, 36);
        thumbWrap.set_child(thumbPic);
        addImageOrFallback(thumbPic, null, 56, 36);
        const seedPath = entry.clips[0] || null;
        if (seedPath)
            this._ensureThumb(seedPath, 'w56h36', 56, 36, thumb => addImageOrFallback(thumbPic, thumb, 56, 36));

        const typeIcon = new Gtk.Image({icon_name: this._entryKindIcon(entry.kind), pixel_size: 13, valign: Gtk.Align.CENTER});
        typeIcon.add_css_class('llp-sidebar-type-icon');

        const textWrap = box(Gtk.Orientation.VERTICAL, 2, true, false);
        const t = new Gtk.Label({label: entry.title, xalign: 0, ellipsize: Pango.EllipsizeMode.END});
        t.add_css_class('llp-card-title');
        const s = new Gtk.Label({label: entry.subtitle, xalign: 0, ellipsize: Pango.EllipsizeMode.END});
        s.add_css_class('llp-card-subtitle');
        textWrap.append(t);
        textWrap.append(s);

        rowBox.append(thumbWrap);
        rowBox.append(typeIcon);
        rowBox.append(textWrap);
        row.set_child(rowBox);

        const clickRow = new Gtk.GestureClick();
        clickRow.connect('released', gesture => {
            const mods = gesture.get_current_event_state ? gesture.get_current_event_state() : 0;
            const ctrl = !!(mods & Gdk.ModifierType.CONTROL_MASK);
            const shift = !!(mods & Gdk.ModifierType.SHIFT_MASK);

            if (shift && state.lastSidebarIndex >= 0) {
                const start = Math.min(state.lastSidebarIndex, idx);
                const end = Math.max(state.lastSidebarIndex, idx);
                const rangeKeys = state.filteredEntries.slice(start, end + 1).map(e => e.key);
                state.currentKeys = ctrl ? uniq([...state.currentKeys, ...rangeKeys]) : rangeKeys;
            } else if (ctrl) {
                if (state.currentKeys.includes(entry.key))
                    state.currentKeys = state.currentKeys.filter(k => k !== entry.key);
                else
                    state.currentKeys = [...state.currentKeys, entry.key];
                state.lastSidebarIndex = idx;
            } else {
                if (state.currentKeys.length === 1 && state.currentKeys[0] === entry.key)
                    state.currentKeys = [];
                else
                    state.currentKeys = [entry.key];
                state.lastSidebarIndex = idx;
            }

            syncSelectedEntries();
            markActiveRows();
            renderFlow();
        });
        row.add_controller(clickRow);

        listBox.append(row);
    };

    const renderSidebar = () => {
        cancelLibraryChunkIds();
        state.sidebarBuildGen = (state.sidebarBuildGen | 0) + 1;
        const sbGen = state.sidebarBuildGen;

        clearChildren(listBox);
        state.entries = this._libraryEntries();
        const q = state.sidebarFilter.trim().toLowerCase();
        state.filteredEntries = state.entries.filter(entry => !q || entry.title.toLowerCase().includes(q) || entry.subtitle.toLowerCase().includes(q));
        state.currentKeys = state.currentKeys.filter(k => state.filteredEntries.some(e => e.key === k));

        let sIdx = 0;
        const pumpSidebar = () => {
            if (sbGen !== state.sidebarBuildGen) {
                state.sidebarIdleId = 0;
                return GLib.SOURCE_REMOVE;
            }
            const n = state.filteredEntries.length;
            const end = Math.min(sIdx + SIDEBAR_BATCH, n);
            for (; sIdx < end; sIdx++)
                appendSidebarRow(state.filteredEntries[sIdx], sIdx);
            if (sIdx < n)
                return GLib.SOURCE_CONTINUE;
            state.sidebarIdleId = 0;
            refreshSidebarStats();
            if (!state.sidebarInitialized)
                state.sidebarInitialized = true;
            syncSelectedEntries();
            markActiveRows();
            renderFlow();
            return GLib.SOURCE_REMOVE;
        };
        state.sidebarIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, pumpSidebar);
    };


    entrySearch.connect('search-changed', entry => { state.sidebarFilter = entry.get_text(); renderSidebar(); });

    flow.connect('selected-children-changed', () => {
        const paths = selectedPaths();
        if (paths.length) updateHero(paths[0]);
        else updateHero(currentClips()[0] || null);
        syncSelectionLabel();
        let child = flow.get_first_child();
        while (child) {
            const card = child.get_child();
            card?.remove_css_class('selected');
            if (child.is_selected?.()) card?.add_css_class('selected');
            child = child.get_next_sibling();
        }
    });

    const applySelectionTo = key => {
        const chosen = selectedPaths();
        const paths = chosen.length ? chosen : currentClips();
        if (!paths.length)
            return;
        if (key === Keys.VIDEO_PATHS)
            this._runLibraryApplyFlow('lock', paths);
        else if (key === Keys.WALLPAPER_VIDEO_PATHS)
            this._runLibraryApplyFlow('wallpaper', paths);
        else
            this._setStrv(key, paths);
    };

    const videoPathsFromChooser = chooser => {
        const out = [];
        const push = file => {
            const path = pathFromGFile(file);
            if (path && isVideoPath(path))
                out.push(path);
        };
        try {
            const model = chooser.get_files?.();
            if (model) {
                const n = model.get_n_items?.() ?? 0;
                for (let i = 0; i < n; i++)
                    push(model.get_item(i));
            }
        } catch (e) {}
        if (!out.length) {
            try {
                push(chooser.get_file?.());
            } catch (e2) {}
        }
        return out;
    };

    const openFiles = () => {
        const chooser = new Gtk.FileChooserNative({title: 'Add video files', transient_for: this._window, modal: true, action: Gtk.FileChooserAction.OPEN, accept_label: 'Add', cancel_label: 'Cancel'});
        chooser.set_select_multiple(true);
        chooser.connect('response', (_d, response) => {
            if (response === Gtk.ResponseType.ACCEPT) {
                const store = this._loadLibraryStore();
                for (const path of videoPathsFromChooser(chooser))
                    store.files.push(path);
                this._saveLibraryStore(store);
                state.currentKeys = [];
                clearFlowWarmCache();
                renderSidebar();
            }
            chooser.destroy();
        });
        chooser.show();
    };

    const openFilesIntoSelectedContainer = () => {
        syncSelectedEntries();
        if (state.currentEntries.length !== 1)
            return;
        const entry = state.currentEntries[0];
        if (entry.kind !== 'folder' && entry.kind !== 'playlist')
            return;
        const title = entry.kind === 'folder'
            ? `Add videos to folder “${entry.title}”`
            : `Add videos to playlist “${entry.title}”`;
        const chooser = new Gtk.FileChooserNative({title, transient_for: this._window, modal: true, action: Gtk.FileChooserAction.OPEN, accept_label: 'Add', cancel_label: 'Cancel'});
        chooser.set_select_multiple(true);
        chooser.connect('response', (_d, response) => {
            if (response === Gtk.ResponseType.ACCEPT) {
                const paths = videoPathsFromChooser(chooser);
                if (paths.length) {
                    if (entry.kind === 'playlist') {
                        const playlists = this._loadPlaylists();
                        const target = playlists.find(p => `playlist:${p.id}` === entry.key);
                        if (target) {
                            if (!target.items)
                                target.items = [];
                            const have = new Set(target.items);
                            for (const p of paths) {
                                if (!have.has(p)) {
                                    target.items.push(p);
                                    have.add(p);
                                }
                            }
                            this._savePlaylists(playlists);
                        }
                    } else {
                        const store = this._loadLibraryStore();
                        const folderKey = resolveFolderKeyInStore(store, entry.path);
                        if (folderKey) {
                            const scanned = this._scanFolder(folderKey);
                            const folderPaths = uniq(paths.map(p => {
                                for (const sp of scanned) {
                                    if (sameLibraryFilePath(sp, p))
                                        return sp;
                                }
                                return p;
                            }));
                            if (!store.folderExtras || typeof store.folderExtras !== 'object')
                                store.folderExtras = {};
                            const have = new Set(store.folderExtras[folderKey] || []);
                            for (const p of folderPaths)
                                have.add(p);
                            store.folderExtras[folderKey] = [...have];
                            removePathsFromFolderExcludes(store, folderKey, folderPaths);
                            this._saveLibraryStore(store);
                        }
                    }
                    clearFlowWarmCache();
                    renderSidebar();
                }
            }
            chooser.destroy();
        });
        chooser.show();
    };

    const openFolder = () => {
        const chooser = new Gtk.FileChooserNative({title: 'Add folder', transient_for: this._window, modal: true, action: Gtk.FileChooserAction.SELECT_FOLDER, accept_label: 'Add', cancel_label: 'Cancel'});
        chooser.connect('response', (_d, response) => {
            if (response === Gtk.ResponseType.ACCEPT) {
                const path = pathFromGFile(chooser.get_file?.());
                if (path) {
                    const store = this._loadLibraryStore();
                    store.folders.push(path);
                    this._saveLibraryStore(store);
                    state.currentKeys = [];
                    clearFlowWarmCache();
                    renderSidebar();
                }
            }
            chooser.destroy();
        });
        chooser.show();
    };

    const createPlaylist = () => {
        const paths = selectedPaths().length ? selectedPaths() : currentClips();
        if (!paths.length) return;
        const dialog = new Gtk.Dialog({transient_for: this._window, modal: true, title: 'Create Playlist'});
        dialog.add_button('Cancel', Gtk.ResponseType.CANCEL);
        dialog.add_button('Create', Gtk.ResponseType.OK);
        const area = dialog.get_content_area();
        area.set_margin_top(12); area.set_margin_bottom(12); area.set_margin_start(12); area.set_margin_end(12);
        const entry = new Gtk.Entry({placeholder_text: 'Playlist name'});
        area.append(entry);
        dialog.connect('response', (_dlg, response) => {
            if (response === Gtk.ResponseType.OK) {
                const name = entry.get_text().trim() || 'Playlist';
                const playlists = this._loadPlaylists();
                playlists.push({id: GLib.uuid_string_random(), name, items: paths});
                this._savePlaylists(playlists);
                clearFlowWarmCache();
                renderSidebar();
            }
            dialog.destroy();
        });
        dialog.present();
    };

    const confirmDestructiveThen = (heading, body, confirmLabel, fn) => {
        this._confirmAction({heading, body, confirmLabel, destructive: true}).then(ok => {
            if (ok)
                fn();
        });
    };

    const performRemoveSidebarItemsFromLibrary = () => {
        const store = this._loadLibraryStore();
        const playlists = this._loadPlaylists();
        for (const entry of state.currentEntries) {
            if (entry.kind === 'playlist') {
                const target = playlists.find(p => `playlist:${p.id}` === entry.key);
                if (target)
                    target.items = [];
            } else if (entry.kind === 'folder') {
                const fk = resolveFolderKeyInStore(store, entry.path);
                if (fk != null) {
                    store.folders = store.folders.filter(p => p !== fk);
                    if (store.folderExcludes && fk)
                        delete store.folderExcludes[fk];
                    if (store.folderExtras && fk)
                        delete store.folderExtras[fk];
                } else {
                    store.folders = store.folders.filter(p => {
                        try {
                            return !Gio.File.new_for_path(p).equal(Gio.File.new_for_path(entry.path));
                        } catch (e) {
                            return p !== entry.path;
                        }
                    });
                    const stripByPath = map => {
                        if (!map || typeof map !== 'object')
                            return;
                        for (const key of Object.keys(map)) {
                            try {
                                if (Gio.File.new_for_path(key).equal(Gio.File.new_for_path(entry.path)))
                                    delete map[key];
                            } catch (e) {
                                if (key === entry.path)
                                    delete map[key];
                            }
                        }
                    };
                    stripByPath(store.folderExcludes);
                    stripByPath(store.folderExtras);
                }
            } else if (entry.kind === 'file') {
                store.files = store.files.filter(p => p !== entry.path);
            }
        }
        this._savePlaylists(playlists.filter(p => Array.isArray(p.items) && p.items.length));
        this._saveLibraryStore(store);
        state.currentKeys = [];
        state.currentEntries = [];
        clearFlowWarmCache();
        renderSidebar();
    };

    const removeSidebarItemsFromLibrary = () => {
        if (!state.currentKeys.length)
            return;
        const n = state.currentEntries.length;
        const labelFor = e => {
            if (!e) return '';
            if (e.kind === 'file')
                return basename(e.path || '') || e.path || '';
            return e.title || e.path || e.key || '';
        };
        const preview = state.currentEntries.map(labelFor).filter(Boolean).slice(0, 3);
        const more = n > preview.length ? ` and ${n - preview.length} more` : '';
        const listBit = preview.length ? ` ${preview.join(', ')}${more}.` : '';
        const body = n === 1
            ? `Remove “${preview[0] || 'this item'}” from your library? Nothing is deleted from disk; only library lists and playlists are updated.`
            : `Remove ${n} selected items from your library?${listBit} Nothing is deleted from disk.`;
        confirmDestructiveThen('Remove from library?', body, '_Remove', performRemoveSidebarItemsFromLibrary);
    };

    const performRemoveSelectedFromCurrentList = (entry, paths) => {
        if (entry.kind === 'playlist') {
            const playlists = this._loadPlaylists();
            const target = playlists.find(p => `playlist:${p.id}` === entry.key);
            if (!target)
                return;
            target.items = (target.items || []).filter(p => !paths.some(d => sameLibraryFilePath(d, p)));
            this._savePlaylists(playlists.filter(p => (p.items || []).length));
        } else if (entry.kind === 'folder') {
            const store = this._loadLibraryStore();
            const folderKey = resolveFolderKeyInStore(store, entry.path);
            if (!folderKey)
                return;
            if (!store.folderExcludes || typeof store.folderExcludes !== 'object')
                store.folderExcludes = {};
            if (!store.folderExtras || typeof store.folderExtras !== 'object')
                store.folderExtras = {};
            const extraArr = store.folderExtras[folderKey] || [];
            let extras = extraArr.filter(p => !paths.some(d => sameLibraryFilePath(d, p)));
            const excludeSet = new Set(store.folderExcludes[folderKey] || []);
            for (const p of paths) {
                if (extraArr.some(e => sameLibraryFilePath(e, p)))
                    continue;
                excludeSet.add(p);
            }
            if (extras.length)
                store.folderExtras[folderKey] = extras;
            else
                delete store.folderExtras[folderKey];
            if (excludeSet.size)
                store.folderExcludes[folderKey] = [...excludeSet];
            else
                delete store.folderExcludes[folderKey];
            this._saveLibraryStore(store);
        } else {
            return;
        }
        flow.unselect_all();
        clearFlowWarmCache();
        renderSidebar();
    };

    const removeSelectedFromCurrentList = () => {
        syncSelectedEntries();
        let chosen = selectedPaths();
        if (!chosen.length && gridPathsAtRemovePress.length)
            chosen = [...gridPathsAtRemovePress];
        try {
            if (!chosen.length || state.currentEntries.length !== 1)
                return;
            const entry = state.currentEntries[0];
            const allowList = currentClips();
            const paths = [];
            for (const p of chosen) {
                const hit = allowList.find(a => sameLibraryFilePath(a, p));
                if (hit)
                    paths.push(hit);
            }
            if (!paths.length)
                return;

            if (entry.kind !== 'playlist' && entry.kind !== 'folder')
                return;

            const n = paths.length;
            const title = entry.title || basename(entry.path || '') || 'this list';
            const isPl = entry.kind === 'playlist';
            const heading = isPl ? 'Remove from playlist?' : 'Remove from folder?';
            const body = `Remove ${n} video${n === 1 ? '' : 's'} from “${title}”? Files stay on disk; only this ${isPl ? 'playlist' : 'folder'} listing is updated.`;
            confirmDestructiveThen(heading, body, '_Remove', () => performRemoveSelectedFromCurrentList(entry, paths));
        } finally {
            gridPathsAtRemovePress = [];
        }
    };

    addFilesBtn.connect('clicked', openFiles);
    addToContainerBtn.connect('clicked', openFilesIntoSelectedContainer);
    addFolderBtn.connect('clicked', openFolder);
    reloadBtn.connect('clicked', () => {
        this._invalidateLibraryCaches();
        clearFlowWarmCache();
        renderSidebar();
    });
    selectAllBtn.connect('clicked', () => { let child = flow.get_first_child(); while (child) { flow.select_child(child); child = child.get_next_sibling(); } syncSelectionLabel(); });
    clearSelBtn.connect('clicked', () => { flow.unselect_all(); syncSelectionLabel(); });
    setLockBtn.connect('clicked', () => applySelectionTo(Keys.VIDEO_PATHS));
    setWallpaperBtn.connect('clicked', () => applySelectionTo(Keys.WALLPAPER_VIDEO_PATHS));
    playlistBtn.connect('clicked', createPlaylist);
    sidebarRemoveBtn.connect('clicked', removeSidebarItemsFromLibrary);
    const removeFromListPress = new Gtk.GestureClick();
    removeFromListPress.connect('pressed', () => {
        gridPathsAtRemovePress = selectedPaths();
    });
    removeFromListBtn.add_controller(removeFromListPress);
    removeFromListBtn.connect('clicked', removeSelectedFromCurrentList);

    root.append(left);
    root.append(right);
    group.add(root);
    page.add(group);
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        renderSidebar();
        return GLib.SOURCE_REMOVE;
    });
    return page;
}
};
