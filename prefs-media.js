import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {Keys} from './enums.js';
import {uniq, md5} from './prefs-ui-helpers.js';
/** Thumbnails, ffprobe metadata, play counts, cache clears. */
export const PrefsMediaMixin = {
_thumbHitCacheRemember(thumbPath) {
    if (!thumbPath)
        return;
    if (!this._thumbHitCache)
        this._thumbHitCache = new Map();
    this._thumbHitCache.set(thumbPath, true);
    if (this._thumbHitCache.size > 12000)
        this._thumbHitCache.clear();
},

_thumbHitCacheForget(thumbPath) {
    try {
        this._thumbHitCache?.delete(thumbPath);
    } catch (e) {}
},

_thumbPath(videoPath, tag = 'grid') {
    return GLib.build_filenamev([this._thumbDir(), `${md5(`${tag}:${videoPath}`)}.jpg`]);
},

_pumpThumbWorkQueue() {
    const max = this._thumbWorkMaxConcurrent ?? 6;
    while ((this._thumbWorkActive | 0) < max && this._thumbWorkQueue?.length) {
        const job = this._thumbWorkQueue.shift();
        if (!job)
            break;
        this._thumbWorkQueuedKeys?.delete(job.key);
        this._thumbWorkActive = (this._thumbWorkActive | 0) + 1;
        const {key, videoPath, width, height, thumbPath} = job;
        const scale = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`;
        const argv = [
            'ffmpeg', '-y', '-hide_banner', '-loglevel', 'error',
            '-ss', '1', '-i', videoPath,
            '-frames:v', '1', '-vf', scale,
            '-q:v', '2',
            thumbPath,
        ];
        const finish = ok => {
            this._thumbWorkActive = Math.max(0, (this._thumbWorkActive | 0) - 1);
            const cbs = this._thumbJobs?.get(key) || [];
            this._thumbJobs?.delete(key);
            const exists = ok && Gio.File.new_for_path(thumbPath).query_exists(null) ? thumbPath : null;
            if (exists)
                this._thumbHitCacheRemember(thumbPath);
            else
                this._thumbHitCacheForget(thumbPath);
            for (const cb of cbs)
                cb?.(exists);
            this._pumpThumbWorkQueue();
        };
        try {
            const proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDERR_PIPE | Gio.SubprocessFlags.STDOUT_PIPE);
            proc.wait_check_async(null, (p, res) => {
                try {
                    p.wait_check_finish(res);
                } catch (e) {}
                finish(Gio.File.new_for_path(thumbPath).query_exists(null));
            });
        } catch (e) {
            finish(false);
        }
    }
},

_ensureThumb(videoPath, tag, width, height, callback) {
    const thumbPath = this._thumbPath(videoPath, tag);
    if (this._thumbHitCache?.get(thumbPath)) {
        callback?.(thumbPath);
        return;
    }
    try {
        if (Gio.File.new_for_path(thumbPath).query_exists(null)) {
            this._thumbHitCacheRemember(thumbPath);
            callback?.(thumbPath);
            return;
        }
    } catch (e) {}

    if (!this._thumbJobs)
        this._thumbJobs = new Map();
    const key = `${tag}:${videoPath}`;
    if (this._thumbJobs.has(key)) {
        this._thumbJobs.get(key).push(callback);
        return;
    }
    this._thumbJobs.set(key, [callback]);

    if (!this._thumbWorkQueue)
        this._thumbWorkQueue = [];
    if (!this._thumbWorkQueuedKeys)
        this._thumbWorkQueuedKeys = new Set();
    if (this._thumbWorkQueuedKeys.has(key))
        return;
    this._thumbWorkQueuedKeys.add(key);
    this._thumbWorkQueue.push({key, videoPath, width, height, thumbPath});
    this._pumpThumbWorkQueue();
},

_parseFfprobeMeta(stdout) {
    const meta = {width: 0, height: 0, duration: 0, fps: 0, size: 0};
    const lines = String(stdout || '').split(/\r?\n/);
    for (const line of lines) {
        const [k, v] = line.split('=');
        if (!k || v == null)
            continue;
        if (k === 'width') meta.width = Number(v) || 0;
        else if (k === 'height') meta.height = Number(v) || 0;
        else if (k === 'duration') meta.duration = Number(v) || 0;
        else if (k === 'size') meta.size = Number(v) || 0;
        else if (k === 'r_frame_rate') {
            const m = v.match(/^(\d+)\/(\d+)$/);
            if (m) {
                const num = Number(m[1]);
                const den = Number(m[2]);
                meta.fps = den ? Number((num / den).toFixed(2)) : 0;
            } else {
                meta.fps = Number(v) || 0;
            }
        }
    }
    return meta;
},

_pumpMetaProbeQueue() {
    const max = this._metaProbeMaxConcurrent ?? 6;
    while ((this._metaProbeActive | 0) < max && this._metaProbeQueue?.length) {
        const path = this._metaProbeQueue.shift();
        if (!path)
            break;
        this._metaProbeQueuedPaths?.delete(path);
        this._metaProbeActive = (this._metaProbeActive | 0) + 1;
        const cache = this._loadMetaCache();
        const argv = [
            'ffprobe', '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=width,height,r_frame_rate',
            '-show_entries', 'format=duration,size',
            '-of', 'default=noprint_wrappers=1:nokey=0',
            path,
        ];
        const done = meta => {
            this._metaProbeActive = Math.max(0, (this._metaProbeActive | 0) - 1);
            const cbs = this._metaJobs?.get(path) || [];
            this._metaJobs?.delete(path);
            for (const cb of cbs)
                cb?.(meta);
            this._pumpMetaProbeQueue();
        };
        try {
            const proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            proc.communicate_utf8_async(null, null, (p, res) => {
                let meta = {width: 0, height: 0, duration: 0, fps: 0, size: 0};
                try {
                    const [, stdout] = p.communicate_utf8_finish(res);
                    meta = this._parseFfprobeMeta(stdout);
                } catch (e) {}
                cache[path] = meta;
                this._saveMetaCache();
                done(meta);
            });
        } catch (e) {
            cache[path] = {width: 0, height: 0, duration: 0, fps: 0, size: 0};
            this._saveMetaCache();
            done(cache[path]);
        }
    }
},

_metadataFor(path, callback) {
    const cache = this._loadMetaCache();
    if (cache[path]) {
        callback?.(cache[path]);
        return;
    }
    if (!this._metaJobs)
        this._metaJobs = new Map();
    if (this._metaJobs.has(path)) {
        this._metaJobs.get(path).push(callback);
        return;
    }
    this._metaJobs.set(path, [callback]);

    if (!this._metaProbeQueue)
        this._metaProbeQueue = [];
    if (!this._metaProbeQueuedPaths)
        this._metaProbeQueuedPaths = new Set();
    if (this._metaProbeQueuedPaths.has(path))
        return;
    this._metaProbeQueuedPaths.add(path);
    this._metaProbeQueue.push(path);
    this._pumpMetaProbeQueue();
},

_sumMetadataForPaths(paths, callback) {
    const arr = uniq(paths || []);
    if (!arr.length) {
        callback?.({count: 0, duration: 0, size: 0});
        return;
    }
    let remaining = arr.length;
    const totals = {count: arr.length, duration: 0, size: 0};
    for (const path of arr) {
        this._metadataFor(path, meta => {
            totals.duration += Number(meta?.duration) || 0;
            totals.size += Number(meta?.size) || 0;
            remaining--;
            if (remaining <= 0)
                callback?.(totals);
        });
    }
},

_metaVariantNumber(v) {
    if (v == null)
        return 0;
    if (typeof v === 'number')
        return Number.isFinite(v) ? Math.round(v) : 0;
    try {
        if (typeof v.get_int32 === 'function')
            return v.get_int32();
    } catch (e) {}
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n) : 0;
},

_playCountFromUnpackedMetaEntry(entry) {
    if (!entry || typeof entry !== 'object')
        return 0;
    return Math.max(0, this._metaVariantNumber(entry.playCount));
},

/** Sum of lock-screen + wallpaper play counts for one file path (matches extension tracking). */
_playCountTotalForLibraryVideoPath(path) {
    if (!path || !this._settings)
        return 0;
    let t = 0;
    try {
        if (this._hasSettingKey(Keys.VIDEO_METADATA)) {
            const m = this._settings.get_value(Keys.VIDEO_METADATA).recursiveUnpack() ?? {};
            t += this._playCountFromUnpackedMetaEntry(m[path]);
        }
    } catch (e) {}
    try {
        if (this._hasSettingKey(Keys.WALLPAPER_VIDEO_METADATA)) {
            const m = this._settings.get_value(Keys.WALLPAPER_VIDEO_METADATA).recursiveUnpack() ?? {};
            t += this._playCountFromUnpackedMetaEntry(m[path]);
        }
    } catch (e) {}
    return t;
},

_clearThumbCache() {
    try {
        const d = Gio.File.new_for_path(this._thumbDir());
        const e = d.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = e.next_file(null)))
            d.get_child(info.get_name()).delete(null);
        try { e.close(null); } catch (e2) {}
    } catch (e) {}
    try {
        this._thumbHitCache?.clear();
    } catch (e3) {}
},

_clearMetadataCache() {
    this._metaCache = {};
    try { this._saveMetaCache(); } catch (e) {}
}
};
