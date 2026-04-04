import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import GLib from 'gi://GLib';
import {Keys} from './enums.js';
import {box, makePill, clipOverflow, addImageOrFallback, basenameNoExt} from './prefs-ui-helpers.js';
/** Home page UI, hero carousel, metrics, lock/wall previews. */
export const PrefsHomeMixin = {
_buildHomePage() {
    const page = new Adw.PreferencesPage({title: 'Home', name: 'home', icon_name: 'go-home-symbolic'});
    const group = new Adw.PreferencesGroup();
    const wrap = box(Gtk.Orientation.VERTICAL, 16, true, false);
    wrap.add_css_class('llp-page-wrap');
    wrap.add_css_class('llp-page-stack');
    wrap.set_hexpand(true);

    const topBar = new Gtk.CenterBox();
    topBar.add_css_class('llp-home-toolbar');
    try { topBar.set_hexpand(true); } catch (eHx) {}
    const versionPill = makePill(`v${this.metadata?.version || 'dev'}`);
    const updatePill = makePill('Checking…');
    try { versionPill.set_valign(Gtk.Align.CENTER); } catch (eV0) {}
    try { updatePill.set_valign(Gtk.Align.CENTER); } catch (eV1) {}
    const releasesBtn = new Gtk.Button();
    try { releasesBtn.add_css_class('flat'); } catch (e) {}
    releasesBtn.add_css_class('llp-home-toolbar-link');
    releasesBtn.set_child(this._makeTextIconButton('Releases'));
    releasesBtn.set_tooltip_text('Open latest tags');
    try { releasesBtn.set_valign(Gtk.Align.CENTER); } catch (eVr) {}
    const topLeft = box(Gtk.Orientation.HORIZONTAL, 8, false, false);
    topLeft.add_css_class('llp-home-chip-row');
    try { topLeft.set_valign(Gtk.Align.CENTER); } catch (eVl) {}
    topLeft.append(versionPill);
    topLeft.append(updatePill);
    topLeft.append(releasesBtn);
    const brandRow = box(Gtk.Orientation.HORIZONTAL, 10, false, false);
    try { brandRow.set_valign(Gtk.Align.CENTER); } catch (eVb) {}
    const brandIcon = new Gtk.Image();
    const flowerPaintable = this._loadExtensionIconPaintable('flower', 34);
    if (flowerPaintable) {
        brandIcon.set_from_paintable(flowerPaintable);
        try { brandIcon.set_pixel_size(34); } catch (ePx) {}
    } else {
        brandIcon.set_from_icon_name('image-missing-symbolic');
        try { brandIcon.set_pixel_size(34); } catch (ePx2) {}
    }
    try { brandIcon.set_valign(Gtk.Align.CENTER); } catch (eVi) {}
    const brandTitle = new Gtk.Label({
        label: this.metadata?.name || 'Live LockPaper',
        xalign: 0,
        valign: Gtk.Align.CENTER,
    });
    brandTitle.add_css_class('llp-home-brand-title');
    brandRow.append(brandIcon);
    brandRow.append(brandTitle);
    const githubBtn = new Gtk.Button();
    githubBtn.add_css_class('llp-home-github-btn');
    githubBtn.add_css_class('llp-home-toolbar-link');
    try { githubBtn.add_css_class('flat'); } catch (e) {}
    githubBtn.set_child(this._makeGitHubButtonContents());
    githubBtn.set_tooltip_text('Open project repository');
    try { githubBtn.set_valign(Gtk.Align.CENTER); } catch (eVg) {}
    const githubWrap = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, hexpand: false, vexpand: false});
    githubWrap.add_css_class('llp-home-github-wrap');
    try { githubWrap.set_valign(Gtk.Align.CENTER); } catch (eVw) {}
    githubWrap.append(githubBtn);
    try { topBar.set_valign(Gtk.Align.CENTER); } catch (eVt) {}
    topBar.set_start_widget(topLeft);
    topBar.set_center_widget(brandRow);
    topBar.set_end_widget(githubWrap);

    this._refreshLatestTagStatus(updatePill);
    releasesBtn.connect('clicked', () => {
        try { Gio.AppInfo.launch_default_for_uri('https://github.com/DeLuca21/LiveLockPaper/tags', null); } catch (e) {}
    });
    githubBtn.connect('clicked', () => {
        try { Gio.AppInfo.launch_default_for_uri('https://github.com/DeLuca21/LiveLockPaper', null); } catch (e) {}
    });

    wrap.append(topBar);

    const homeCleanup = {heavyIdle: 0, heroCycleId: 0, previewSigIds: []};
    page.connect('unrealize', () => {
        if (homeCleanup.heavyIdle) {
            try { GLib.Source.remove(homeCleanup.heavyIdle); } catch (eH) {}
            homeCleanup.heavyIdle = 0;
        }
        if (homeCleanup.heroCycleId) {
            try { GLib.Source.remove(homeCleanup.heroCycleId); } catch (eHc) {}
            homeCleanup.heroCycleId = 0;
        }
        if (this._metaSaveId) {
            try { GLib.Source.remove(this._metaSaveId); } catch (eMetaRm) {}
            this._metaSaveId = 0;
            try {
                this._loadMetaCache();
                this._writeJson(this._metaPath(), this._metaCache || {});
            } catch (eMetaWrite) {}
        }
        if (this._homeSelectionRefreshIdle) {
            try {
                GLib.Source.remove(this._homeSelectionRefreshIdle);
            } catch (eRm) {}
            this._homeSelectionRefreshIdle = 0;
        }
        this._refreshHomeSelectionCards = null;
        for (const id of homeCleanup.previewSigIds) {
            try {
                this._settings.disconnect(id);
            } catch (eDisc) {}
        }
        homeCleanup.previewSigIds.length = 0;
    });

    homeCleanup.heavyIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        homeCleanup.heavyIdle = 0;
        try {
            const entries = this._libraryEntries();
            const store = this._loadLibraryStore();
            const playlists = this._loadPlaylists();
            const libraryClips = this._allLibraryClips();
            const featured = this._featuredPath();
            let heroIndex = Math.max(0, libraryClips.indexOf(featured));
            if (heroIndex < 0)
                heroIndex = 0;

    const heroCard = clipOverflow(new Gtk.Overlay({hexpand: true}));
    heroCard.add_css_class('llp-hero-shell');
    const heroPicture = new Gtk.Picture({can_shrink: true, content_fit: Gtk.ContentFit.COVER, hexpand: true, vexpand: true});
    heroPicture.add_css_class('llp-hero-media');
    heroPicture.set_size_request(1180, 360);
    heroCard.set_child(heroPicture);
    addImageOrFallback(heroPicture, null, 1180, 360);

    const heroMeta = box(Gtk.Orientation.VERTICAL, 10, true, false);
    heroMeta.add_css_class('llp-hero-meta');
    heroMeta.set_halign(Gtk.Align.FILL);
    heroMeta.set_valign(Gtk.Align.END);
    const title = new Gtk.Label({label: 'Your library', xalign: 0});
    title.add_css_class('llp-big-copy');
    title.set_ellipsize(Pango.EllipsizeMode.END);
    heroMeta.append(title);
    heroCard.add_overlay(heroMeta);

    const heroNav = box(Gtk.Orientation.HORIZONTAL, 6, false, false);
    heroNav.set_halign(Gtk.Align.END);
    heroNav.set_valign(Gtk.Align.END);
    heroNav.set_margin_end(14);
    heroNav.set_margin_bottom(14);
    const prevBtn = new Gtk.Button({icon_name: 'go-previous-symbolic'});
    const nextBtn = new Gtk.Button({icon_name: 'go-next-symbolic'});
    prevBtn.add_css_class('llp-icon-btn');
    nextBtn.add_css_class('llp-icon-btn');
    heroNav.append(prevBtn);
    heroNav.append(nextBtn);
    heroCard.add_overlay(heroNav);

    const setHeroFromIndex = () => {
        const path = libraryClips[heroIndex] || null;
        if (!path) {
            title.set_label('Your library');
            addImageOrFallback(heroPicture, null, 1180, 360);
            prevBtn.set_sensitive(false);
            nextBtn.set_sensitive(false);
            return;
        }
        prevBtn.set_sensitive(libraryClips.length > 1);
        nextBtn.set_sensitive(libraryClips.length > 1);
        title.set_label(basenameNoExt(path));
        addImageOrFallback(heroPicture, null, 1180, 360);
        this._ensureThumb(path, 'home-hero', 1180, 360, thumb => addImageOrFallback(heroPicture, thumb, 1180, 360));
    };
    const stepHero = delta => {
        if (libraryClips.length < 2)
            return;
        heroIndex = (heroIndex + delta + libraryClips.length) % libraryClips.length;
        setHeroFromIndex();
    };
    prevBtn.connect('clicked', () => stepHero(-1));
    nextBtn.connect('clicked', () => stepHero(1));
    setHeroFromIndex();
    if (libraryClips.length > 1) {
        homeCleanup.heroCycleId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 7, () => {
            stepHero(1);
            return GLib.SOURCE_CONTINUE;
        });
    }

    const totalClips = entries.reduce((a, e) => a + e.clips.length, 0);
    const metricsRow = box(Gtk.Orientation.HORIZONTAL, 12, true, false);
    metricsRow.add_css_class('llp-home-stats-row');
    metricsRow.append(this._makeStatCard('Files', store.files.length, '', 'Directly added clips'));
    metricsRow.append(this._makeStatCard('Folders', store.folders.length, '', 'Imported sources'));
    metricsRow.append(this._makeStatCard('Playlists', playlists.length, '', 'Saved selections'));
    metricsRow.append(this._makeStatCard('Clips', totalClips, '', 'Total visible items'));

    const previews = box(Gtk.Orientation.HORIZONTAL, 12, true, false);
    const lockPreview = this._makePreviewCard('Current lock screen selection', true);
    const wallPreview = this._makePreviewCard('Current wallpaper selection', false);
    previews.append(lockPreview.card);
    previews.append(wallPreview.card);

    this._refreshHomeSelectionCards = () => {
        lockPreview.refresh();
        wallPreview.refresh();
    };
    const homePreviewKeySet = new Set();
    for (const k of [
        Keys.VIDEO_PATHS,
        Keys.WALLPAPER_VIDEO_PATHS,
        Keys.LOCKSCREEN_ENABLED,
        Keys.WALLPAPER_ENABLED,
        Keys.LOCKSCREEN_PER_MONITOR,
        Keys.WALLPAPER_PER_MONITOR,
        Keys.LOCKSCREEN_PER_MONITOR_CONFIG,
        Keys.WALLPAPER_PER_MONITOR_CONFIG,
    ]) {
        if (this._hasSettingKey(k))
            homePreviewKeySet.add(k);
    }
    const onHomeSettingsChanged = (_settings, key) => {
        if (homePreviewKeySet.has(key))
            this._scheduleHomeSelectionRefresh();
    };
    try {
        homeCleanup.previewSigIds.push(this._settings.connect('changed', onHomeSettingsChanged));
    } catch (eSig) {}

            wrap.append(heroCard);
            wrap.append(metricsRow);
            wrap.append(previews);
        } catch (eHeavy) {}
        return GLib.SOURCE_REMOVE;
    });

    group.add(wrap);
    page.add(group);
    return page;
}
};
