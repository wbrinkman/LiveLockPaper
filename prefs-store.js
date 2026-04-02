import Gio from 'gi://Gio';
import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';
import {Keys} from './enums.js';
import {uniq, isVideoPath, basename, basenameNoExt, canonicalPath, sameLibraryFilePath} from './prefs-ui-helpers.js';
/** Library JSON, playlists, cache invalidation, paths, scanning, featured path, cleanup. */
export const PrefsStoreMixin = {
_cfgDir() {
    const dir = GLib.build_filenamev([GLib.get_user_config_dir(), 'live-lockpaper']);
    try { Gio.File.new_for_path(dir).make_directory_with_parents(null); } catch (e) {}
    return dir;
},

_libraryPath() {
    return GLib.build_filenamev([this._cfgDir(), 'library.json']);
},

_playlistsPath() {
    return GLib.build_filenamev([this._cfgDir(), 'playlists.json']);
},

_metaPath() {
    return GLib.build_filenamev([this._cfgDir(), 'prefs-metadata.json']);
},

_thumbDir() {
    const dir = GLib.build_filenamev([this._cfgDir(), 'thumbs']);
    try { Gio.File.new_for_path(dir).make_directory_with_parents(null); } catch (e) {}
    return dir;
},

_readJson(filePath, fallback) {
    try {
        const f = Gio.File.new_for_path(filePath);
        if (!f.query_exists(null))
            return fallback;
        const [, bytes] = f.load_contents(null);
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch (e) {
        return fallback;
    }
},

_writeJson(filePath, data) {
    try {
        Gio.File.new_for_path(filePath).replace_contents(
            JSON.stringify(data, null, 2),
            null,
            false,
            Gio.FileCreateFlags.REPLACE_DESTINATION,
            null
        );
    } catch (e) {}
},

_invalidateLibraryCaches() {
    this._libraryStoreCache = null;
    this._playlistCache = null;
    this._libraryEntriesCache = null;
    this._allLibraryClipsCache = null;
    this._folderScanCache = new Map();
},

_normalizeFolderExcludesMap(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object')
        return out;
    for (const [folderPath, list] of Object.entries(raw)) {
        if (typeof folderPath !== 'string' || !Array.isArray(list))
            continue;
        const arr = uniq(list.filter(Boolean));
        if (arr.length)
            out[folderPath] = arr;
    }
    return out;
},

_normalizeFolderExtrasMap(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object')
        return out;
    for (const [folderPath, list] of Object.entries(raw)) {
        if (typeof folderPath !== 'string' || !Array.isArray(list))
            continue;
        const arr = uniq(list.filter(p => p && isVideoPath(p)));
        if (arr.length)
            out[folderPath] = arr;
    }
    return out;
},

_loadLibraryStore() {
    if (this._libraryStoreCache) {
        const fe = {};
        for (const [k, v] of Object.entries(this._libraryStoreCache.folderExcludes || {}))
            fe[k] = [...(v || [])];
        const fx = {};
        for (const [k, v] of Object.entries(this._libraryStoreCache.folderExtras || {}))
            fx[k] = [...(v || [])];
        return {
            files: [...(this._libraryStoreCache.files || [])],
            folders: [...(this._libraryStoreCache.folders || [])],
            folderExcludes: fe,
            folderExtras: fx,
        };
    }
    const data = this._readJson(this._libraryPath(), {files: [], folders: [], folderExcludes: {}, folderExtras: {}});
    const folderExcludes = this._normalizeFolderExcludesMap(data.folderExcludes);
    const folderExtras = this._normalizeFolderExtrasMap(data.folderExtras);
    this._libraryStoreCache = {
        files: uniq(Array.isArray(data.files) ? data.files : []),
        folders: uniq(Array.isArray(data.folders) ? data.folders : []),
        folderExcludes,
        folderExtras,
    };
    return {
        files: [...this._libraryStoreCache.files],
        folders: [...this._libraryStoreCache.folders],
        folderExcludes: {...folderExcludes},
        folderExtras: {...folderExtras},
    };
},

_mergeListsForFolderKey(raw, folder, itemFilter) {
    const merged = [];
    const seen = new Set();
    for (const [k, list] of Object.entries(raw || {})) {
        if (!Array.isArray(list))
            continue;
        if (!sameLibraryFilePath(k, folder))
            continue;
        for (const item of list) {
            if (!item || seen.has(item))
                continue;
            if (itemFilter && !itemFilter(item))
                continue;
            seen.add(item);
            merged.push(item);
        }
    }
    return merged;
},

_mergeFolderKeyedMap(raw, folders, itemFilter) {
    const out = {};
    for (const folder of folders) {
        const merged = this._mergeListsForFolderKey(raw, folder, itemFilter);
        if (merged.length)
            out[folder] = merged;
    }
    return out;
},

_saveLibraryStore(store) {
    const folders = uniq(store.folders || []);
    const rawFE = store.folderExcludes && typeof store.folderExcludes === 'object' ? store.folderExcludes : {};
    const rawFX = store.folderExtras && typeof store.folderExtras === 'object' ? store.folderExtras : {};
    const folderExcludes = this._mergeFolderKeyedMap(rawFE, folders, x => !!x);
    const folderExtras = this._mergeFolderKeyedMap(rawFX, folders, p => isVideoPath(p));
    const normalized = {
        files: uniq(store.files || []),
        folders,
        folderExcludes,
        folderExtras,
    };
    this._writeJson(this._libraryPath(), normalized);
    this._libraryStoreCache = {
        files: [...normalized.files],
        folders: [...normalized.folders],
        folderExcludes: {...folderExcludes},
        folderExtras: {...folderExtras},
    };
    this._libraryEntriesCache = null;
    this._allLibraryClipsCache = null;
    this._folderScanCache = new Map();
},

_loadPlaylists() {
    if (this._playlistCache)
        return this._playlistCache.map(pl => ({...pl, items: [...(pl.items || [])]}));
    const data = this._readJson(this._playlistsPath(), {playlists: []});
    this._playlistCache = Array.isArray(data.playlists) ? data.playlists.map(pl => ({...pl, items: [...(pl.items || [])]})) : [];
    return this._playlistCache.map(pl => ({...pl, items: [...(pl.items || [])]}));
},

_savePlaylists(playlists) {
    const normalized = Array.isArray(playlists) ? playlists.map(pl => ({...pl, items: [...(pl.items || [])]})) : [];
    this._writeJson(this._playlistsPath(), {playlists: normalized});
    this._playlistCache = normalized.map(pl => ({...pl, items: [...(pl.items || [])]}));
    this._libraryEntriesCache = null;
    this._allLibraryClipsCache = null;
    try { this._scheduleHomeSelectionRefresh(); } catch (e) {}
},

_loadMetaCache() {
    if (!this._metaCache)
        this._metaCache = this._readJson(this._metaPath(), {});
    return this._metaCache;
},

_saveMetaCache() {
    if (this._metaSaveId)
        return;
    this._metaSaveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, 250, () => {
        this._metaSaveId = 0;
        this._writeJson(this._metaPath(), this._metaCache || {});
        return GLib.SOURCE_REMOVE;
    });
},

_ensureStoreSeeded() {
    const store = this._loadLibraryStore();
    if (store.files.length || store.folders.length)
        return;
    const ls = uniq(this._safeGetStrv(Keys.VIDEO_PATHS));
    const wp = uniq(this._safeGetStrv(Keys.WALLPAPER_VIDEO_PATHS));
    const all = uniq([...ls, ...wp]);
    const files = [];
    const folders = [];
    for (const path of all) {
        try {
            const f = Gio.File.new_for_path(path);
            if (!f.query_exists(null))
                continue;
            const info = f.query_info('standard::type', Gio.FileQueryInfoFlags.NONE, null);
            const type = info.get_file_type();
            if (type === Gio.FileType.DIRECTORY)
                folders.push(path);
            else if (type === Gio.FileType.REGULAR && isVideoPath(path))
                files.push(path);
        } catch (e) {}
    }
    this._saveLibraryStore({files, folders, folderExcludes: {}, folderExtras: {}});
},

_safeGetStrv(key) {
    try {
        const v = this._settings.get_strv(key);
        return Array.isArray(v) ? v : [];
    } catch (e) {
        return [];
    }
},

_setStrv(key, arr) {
    try { this._settings.set_strv(key, uniq(arr)); } catch (e) {}
    if (key === Keys.VIDEO_PATHS || key === Keys.WALLPAPER_VIDEO_PATHS) {
        try { this._refreshHomeSelectionCards?.(); } catch (e2) {}
        this._scheduleHomeSelectionRefresh();
    }
},

/** Coalesce settings-driven updates so Home preview cards refresh on the next main-loop tick (live in-session). */
_scheduleHomeSelectionRefresh() {
    if (this._homeSelectionRefreshIdle)
        return;
    this._homeSelectionRefreshIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        this._homeSelectionRefreshIdle = 0;
        try {
            if (this._refreshHomeSelectionCards)
                this._refreshHomeSelectionCards();
        } catch (e) {}
        return GLib.SOURCE_REMOVE;
    });
},

/** Pass a realized Gtk window/dialog when possible so Gdk sees the same display as the prefs UI. */
_getDetectedMonitors(sourceWidget = null) {
    const readMonitorsFromDisplay = display => {
        const out = [];
        if (!display)
            return out;
        try {
            let primaryMon = null;
            try {
                primaryMon = display.get_primary_monitor();
            } catch (e0) {}
            const monitorList = display.get_monitors();
            const count = monitorList.get_n_items();
            for (let i = 0; i < count; i++) {
                const mon = monitorList.get_item(i);
                if (!mon)
                    continue;
                let connector = '';
                try {
                    if (typeof mon.get_connector === 'function')
                        connector = mon.get_connector() || '';
                } catch (eC) {}
                if (!connector) {
                    try {
                        connector = mon.connector || '';
                    } catch (eP) {}
                }
                let x = 0;
                let y = 0;
                let width = 0;
                let height = 0;
                try {
                    const geo = mon.get_geometry();
                    x = geo.x;
                    y = geo.y;
                    width = geo.width;
                    height = geo.height;
                } catch (e3) {}
                let model = '';
                try {
                    model = mon.get_model() || '';
                } catch (e4) {}
                let manufacturer = '';
                try {
                    manufacturer = mon.get_manufacturer() || '';
                } catch (e5) {}
                out.push({
                    index: i,
                    connector: connector || `Monitor-${i}`,
                    x,
                    y,
                    width,
                    height,
                    model,
                    manufacturer,
                    isPrimary: !!(primaryMon && mon === primaryMon),
                });
            }
        } catch (e) {}
        return out;
    };

    let winDisplay = null;
    try {
        winDisplay = sourceWidget?.get_display?.() ?? this._window?.get_display?.() ?? null;
    } catch (eW) {}
    const fromWindow = readMonitorsFromDisplay(winDisplay);
    const fromDefault = readMonitorsFromDisplay(Gdk.Display.get_default());
    const monitors =
        fromWindow.length > fromDefault.length ? fromWindow
            : fromDefault.length > fromWindow.length ? fromDefault
                : (fromWindow.length ? fromWindow : fromDefault);

    if (!monitors.length) {
        monitors.push({
            index: 0,
            connector: 'Unknown',
            x: 0,
            y: 0,
            width: 0,
            height: 0,
            model: '',
            manufacturer: '',
            isPrimary: true,
        });
    }
    return monitors;
},

_getStringMapConfig(key) {
    if (!this._hasSettingKey(key))
        return {};
    try {
        const json = this._settings.get_string(key);
        const o = JSON.parse(json);
        return (o && typeof o === 'object') ? o : {};
    } catch (e) {
        return {};
    }
},

_setStringMapConfig(key, obj) {
    if (!this._hasSettingKey(key))
        return;
    try {
        this._settings.set_string(key, JSON.stringify(obj));
    } catch (e) {}
    if (key === Keys.LOCKSCREEN_PER_MONITOR_CONFIG || key === Keys.WALLPAPER_PER_MONITOR_CONFIG) {
        try { this._refreshHomeSelectionCards?.(); } catch (e2) {}
        this._scheduleHomeSelectionRefresh();
    }
},

_scanFolder(folderPath) {
    if (!this._folderScanCache)
        this._folderScanCache = new Map();
    if (this._folderScanCache.has(folderPath))
        return [...(this._folderScanCache.get(folderPath) || [])];
    const out = [];
    const walk = dirPath => {
        try {
            const dir = Gio.File.new_for_path(dirPath);
            const e = dir.enumerate_children('standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = e.next_file(null)) !== null) {
                const child = dir.get_child(info.get_name());
                if (info.get_file_type() === Gio.FileType.DIRECTORY)
                    walk(child.get_path());
                else if (info.get_file_type() === Gio.FileType.REGULAR && isVideoPath(child.get_path())) {
                    const raw = child.get_path();
                    const c = canonicalPath(raw);
                    out.push(c || raw);
                }
            }
            try { e.close(null); } catch (e2) {}
        } catch (e) {}
    };
    walk(folderPath);
    const unique = uniq(out);
    this._folderScanCache.set(folderPath, unique);
    return [...unique];
},

_libraryEntries() {
    if (this._libraryEntriesCache)
        return this._libraryEntriesCache.map(entry => ({...entry, clips: [...(entry.clips || [])]}));
    const store = this._loadLibraryStore();
    const playlists = this._loadPlaylists();
    const entries = [];

    for (const folder of store.folders) {
        const scanned = this._scanFolder(folder);
        const hideRaw = this._mergeListsForFolderKey(store.folderExcludes || {}, folder, x => !!x);
        const extraList = this._mergeListsForFolderKey(store.folderExtras || {}, folder, x => isVideoPath(x));
        const inExtras = p => extraList.some(e => sameLibraryFilePath(e, p));
        const isScannedHidden = p => {
            if (inExtras(p))
                return false;
            return hideRaw.some(h => sameLibraryFilePath(h, p));
        };
        const base = scanned.filter(p => !isScannedHidden(p));
        const inList = (arr, p) => arr.some(x => sameLibraryFilePath(x, p));
        for (const p of extraList) {
            if (inList(base, p))
                continue;
            base.push(p);
        }
        const clips = base;
        entries.push({
            key: `folder:${folder}`,
            kind: 'folder',
            title: basename(folder),
            subtitle: `${clips.length} videos`,
            path: folder,
            clips,
        });
    }

    for (const file of store.files) {
        entries.push({
            key: `file:${file}`,
            kind: 'file',
            title: basenameNoExt(file),
            subtitle: basename(file),
            path: file,
            clips: [file],
        });
    }

    for (const pl of playlists) {
        const items = uniq(Array.isArray(pl.items) ? pl.items.filter(isVideoPath) : []);
        entries.push({
            key: `playlist:${pl.id}`,
            kind: 'playlist',
            title: pl.name || 'Playlist',
            subtitle: `${items.length} videos`,
            id: pl.id,
            clips: items,
        });
    }

    entries.sort((a, b) => a.title.localeCompare(b.title, undefined, {sensitivity: 'base'}));
    this._libraryEntriesCache = entries.map(entry => ({...entry, clips: [...(entry.clips || [])]}));
    return this._libraryEntriesCache.map(entry => ({...entry, clips: [...(entry.clips || [])]}));
},

_allLibraryClips() {
    if (this._allLibraryClipsCache)
        return [...this._allLibraryClipsCache];
    const clips = uniq(this._libraryEntries().flatMap(e => e.clips || []).filter(Boolean));
    this._allLibraryClipsCache = clips;
    return [...clips];
},

/**
 * If strv paths match exactly one library entry’s clip set, return its title and kind (folder / playlist / file).
 * Mixed or unmatched sources → { title: '', kind: null }.
 */
_selectionSourceInfoForStrv(paths) {
    const sel = uniq(paths || []);
    if (!sel.length)
        return {title: '', kind: null};
    const n = sel.length;
    const set = new Set(sel);
    const matchesEntry = clips => {
        const u = uniq(clips || []);
        if (u.length !== n || u.length !== set.size)
            return false;
        for (const p of u) {
            if (!set.has(p))
                return false;
        }
        return true;
    };
    for (const e of this._libraryEntries()) {
        if (matchesEntry(e.clips))
            return {title: e.title || '', kind: e.kind || null};
    }
    return {title: '', kind: null};
},

/** Paths actually used for lock screen or wallpaper (shared strv, or merged per-monitor JSON when enabled). */
_effectivePlaylistPaths(lock) {
    const strvKey = lock ? Keys.VIDEO_PATHS : Keys.WALLPAPER_VIDEO_PATHS;
    const perKey = lock ? Keys.LOCKSCREEN_PER_MONITOR : Keys.WALLPAPER_PER_MONITOR;
    const jsonKey = lock ? Keys.LOCKSCREEN_PER_MONITOR_CONFIG : Keys.WALLPAPER_PER_MONITOR_CONFIG;
    const fromStrv = () => this._safeGetStrv(strvKey);
    let per = false;
    try {
        per = this._hasSettingKey(perKey) && this._settings.get_boolean(perKey);
    } catch (e) {}
    if (!per)
        return fromStrv();
    const cfg = this._getStringMapConfig(jsonKey);
    const merged = [];
    for (const v of Object.values(cfg)) {
        if (Array.isArray(v)) {
            for (const p of v) {
                if (p)
                    merged.push(String(p));
            }
        } else if (typeof v === 'string' && v.trim() && isVideoPath(v)) {
            merged.push(v);
        }
    }
    const u = uniq(merged);
    if (u.length)
        return u;
    const fallback = fromStrv();
    return fallback.length ? fallback : u;
},

_featuredPath() {
    const wp = this._safeGetStrv(Keys.WALLPAPER_VIDEO_PATHS);
    const ls = this._safeGetStrv(Keys.VIDEO_PATHS);
    if (wp.length)
        return wp[0];
    if (ls.length)
        return ls[0];
    const firstEntry = this._libraryEntries().find(e => e.clips?.length);
    return firstEntry?.clips?.[0] || null;
},

_entryKindIcon(kind) {
    switch (kind) {
    case 'folder':
        return 'folder-symbolic';
    case 'playlist':
        return 'view-list-symbolic';
    case 'file':
    default:
        return 'video-x-generic-symbolic';
    }
},

_cleanupPlaylists() {
    const pls = this._loadPlaylists();
    const store = this._loadLibraryStore();
    const known = new Set([...store.files, ...store.folders.flatMap(f => this._scanFolder(f))]);
    let changed = false;
    for (const pl of pls) {
        const before = (pl.items || []).length;
        pl.items = uniq((pl.items || []).filter(p => known.has(p) || Gio.File.new_for_path(p).query_exists(null)));
        if (pl.items.length !== before)
            changed = true;
    }
    if (changed)
        this._savePlaylists(pls);
}
};
