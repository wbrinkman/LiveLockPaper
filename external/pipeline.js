import Gst from 'gi://Gst';
import GLib from 'gi://GLib';
import GstController from 'gi://GstController';

const FADE_DURATION = 300;

const PLAY_FLAG_FORCE_FILTERS = 0x800;

function gtkColourFixEnabled() {
    const v = GLib.getenv('LIVELOCKPAPER_GTK_COLOR_FIX');
    return v !== '0' && v !== 'false' && v !== 'off';
}

function capsNeedHeavyColourFix(capsStr) {
    if (!capsStr || capsStr.length < 8)
        return false;
    const s = capsStr;

    if (s.includes('colorimetry=sRGB') || s.includes('colorimetry=(string)sRGB'))
        return false;
    if (s.includes('color-range=full') || s.includes('color-range=(string)full'))
        return false;

    const hasColorimetryField = s.includes('colorimetry=');
    const isBgra =
        s.includes('format=BGRA') ||
        s.includes('format=(string)BGRA');

    if (isBgra && !hasColorimetryField)
        return false;

    const limitedBtNoFull =
        /(bt601|bt709|bt2020)/i.test(s) &&
        !s.includes('color-range=full') &&
        !s.includes('color-range=(string)full');

    if (limitedBtNoFull)
        return true;

    if (!hasColorimetryField)
        return true;

    return false;
}

export function boostHwDecoderRanks() {
    const hwDecoders = [
        'vah264dec', 'vah265dec', 'vavp9dec', 'vaav1dec',
        'vajpegdec', 'vampeg2dec',
        'vaapidecodebin', 'vaapih264dec', 'vaapih265dec', 'vaapivp9dec',
        'nvh264dec', 'nvh265dec', 'nvvp9dec', 'nvav1dec',
        'nvh264sldec', 'nvh265sldec',
    ];
    const boosted = [];
    const targetRank = Gst.Rank.PRIMARY + 256;
    for (const name of hwDecoders) {
        const factory = Gst.ElementFactory.find(name);
        if (factory) {
            const oldRank = factory.get_rank();
            if (oldRank < targetRank) {
                factory.set_rank(targetRank);
                boosted.push(`${name} (${oldRank}→${targetRank})`);
            } else {
                boosted.push(`${name} (already ${oldRank})`);
            }
        }
    }
    if (boosted.length > 0) {
        console.log(`[ExtPipeline] HW decoder ranks boosted: ${boosted.join(', ')}`);
    } else {
        console.log('[ExtPipeline] No hardware decoders found on this system');
    }
}

export default class Pipeline {
    constructor({ videos, volume, loop, randomOrder, useVideorate, framerate, targetWidth = 0, targetHeight = 0, initialIndex = null, onTrackSwitch = null }) {
        this._bus = null;
        this._pipeline = null;
        this._videoSink = null;
        this._volumeElement = null;
        this._volumeControl = null;

        this._videos = videos;
        this._currentIndex = 0;
        this._volume = volume;
        this._loop = loop;
        this._randomOrder = randomOrder || false;
        this._useVideorate = useVideorate;
        this._framerate = framerate;
        this._targetWidth = targetWidth || 0;
        this._targetHeight = targetHeight || 0;
        this._initialIndex = Number.isInteger(initialIndex) ? initialIndex : null;
        this._queuedFromAboutToFinish = false;
        this._onTrackSwitch = typeof onTrackSwitch === 'function' ? onTrackSwitch : null;
        this._lastLoggedColourCaps = '';
        this._colourFixPhase = 'light';
        this._colourReconfigureSent = false;
        this._colourAwaitingPostReconfigure = false;
        this._colourFixTimerId = 0;
        this._weSetForceFilters = false;
    }

    init() {
        if (!Gst.is_initialized()) {
            if (!Gst.init_check([])[0])
                throw new Error('Unable to initialize GStreamer');
        }

        try {
            if (!Array.isArray(this._videos) || this._videos.length === 0)
                throw new Error('No videos configured for pipeline');

            if (this._initialIndex !== null && this._initialIndex >= 0 && this._initialIndex < this._videos.length) {
                this._currentIndex = this._initialIndex;
            } else if (this._randomOrder && this._videos.length > 1) {
                this._currentIndex = Math.floor(Math.random() * this._videos.length);
            }

            this._pipeline = Gst.ElementFactory.make('playbin', 'playbin');
            if (!this._pipeline)
                throw new Error('Failed to create playbin element');

            this._initVideo();
            this._initPlaybinColourFix();
            this._initAudio();
            this._initBusWatch();

            const uri = GLib.filename_to_uri(this._videos[this._currentIndex], null);
            this._pipeline.set_property('uri', uri);
            this._pipeline.connect('about-to-finish', () => {
                this._onAboutToFinish();
            });

            console.log(`[ExtPipeline] Initialized with ${this._videos.length} video(s), starting: ${this._videos[this._currentIndex]}`);
        } catch (e) {
            this.destroy();
            throw e;
        }
    }

    _initPlaybinColourFix() {
        if (!this._pipeline)
            return;
        if (!gtkColourFixEnabled()) {
            this._clearOurPlaybinColourFlags();
            try {
                this._pipeline.set_property('video-filter', null);
            } catch (e) {}
            return;
        }
        this._colourFixPhase = 'light';
        this._colourReconfigureSent = false;
        this._colourAwaitingPostReconfigure = false;
        this._clearOurPlaybinColourFlags();
        try {
            this._pipeline.set_property('video-filter', null);
        } catch (e) {}
    }

    _clearOurPlaybinColourFlags() {
        if (!this._pipeline || !this._weSetForceFilters)
            return;
        let flags = 0;
        try {
            flags = this._pipeline.get_property('flags');
        } catch (e) {
            return;
        }
        const next = flags & ~PLAY_FLAG_FORCE_FILTERS;
        if (next !== flags) {
            try {
                this._pipeline.set_property('flags', next);
            } catch (e2) {}
        }
        this._weSetForceFilters = false;
    }

    _applyPlaybinForceFiltersOnly() {
        if (!this._pipeline)
            return;
        let flags = 0;
        try {
            flags = this._pipeline.get_property('flags');
        } catch (e) {
            return;
        }
        const next = flags | PLAY_FLAG_FORCE_FILTERS;
        if (next === flags) {
            this._weSetForceFilters = true;
            return;
        }
        try {
            this._pipeline.set_property('flags', next);
            this._weSetForceFilters = true;
            console.log(`[ExtPipeline] colour fix: playbin force-filters on (native-video unchanged), flags 0x${flags.toString(16)} → 0x${next.toString(16)}`);
        } catch (e2) {}
    }

    _buildCpuColourFilterBin() {
        const bin = Gst.parse_bin_from_description(
            'videoconvert name=llp_colour_vc ! capsfilter name=llp_colour_cf',
            true,
        );
        if (!bin)
            return null;
        const vc = bin.get_by_name('llp_colour_vc');
        const cf = bin.get_by_name('llp_colour_cf');
        if (!vc || !cf)
            return null;
        try {
            vc.set_property('dither', 0);
        } catch (e) {}
        try {
            const n = GLib.get_num_processors();
            if (n > 0)
                vc.set_property('n-threads', n);
        } catch (e) {}
        const capsStrs = [
            'video/x-raw,format=BGRA,colorimetry=sRGB',
            'video/x-raw,format=BGRA,colorimetry=bt709',
            'video/x-raw,format=BGRA',
        ];
        let applied = null;
        for (const cs of capsStrs) {
            try {
                const c = Gst.Caps.from_string(cs);
                if (c && !c.is_empty()) {
                    cf.set_property('caps', c);
                    applied = cs;
                    break;
                }
            } catch (e) {}
        }
        if (!applied)
            return null;
        console.log(`[ExtPipeline] colour fix: CPU video-filter capsfilter="${applied}"`);
        return bin;
    }

    _cancelColourFixPostTimer() {
        if (this._colourFixTimerId) {
            GLib.source_remove(this._colourFixTimerId);
            this._colourFixTimerId = 0;
        }
    }

    _scheduleColourFixPostReconfigure() {
        this._cancelColourFixPostTimer();
        this._colourFixTimerId = GLib.timeout_add(GLib.PRIORITY_LOW, 200, () => {
            this._colourFixTimerId = 0;
            if (this._colourAwaitingPostReconfigure)
                this._evaluateColourFixAfterReconfigure();
            return GLib.SOURCE_REMOVE;
        });
    }

    _sinkCapsString() {
        try {
            const pad = this._videoSink?.get_static_pad?.('sink');
            if (!pad)
                return '';
            const caps = pad.get_current_caps();
            if (!caps || caps.is_empty())
                return '';
            return caps.to_string();
        } catch (e) {
            return '';
        }
    }

    _onColourFixAsyncDone() {
        if (!gtkColourFixEnabled() || !this._pipeline || this._colourFixPhase !== 'light')
            return;
        const s = this._sinkCapsString();
        if (!s)
            return;

        if (!this._colourReconfigureSent) {
            try {
                const pad = this._videoSink.get_static_pad('sink');
                if (pad)
                    pad.send_event(Gst.Event.new_reconfigure());
            } catch (e) {}
            this._colourReconfigureSent = true;
            this._colourAwaitingPostReconfigure = true;
            this._scheduleColourFixPostReconfigure();
            return;
        }

        if (this._colourAwaitingPostReconfigure) {
            this._cancelColourFixPostTimer();
            this._evaluateColourFixAfterReconfigure();
        }
    }

    _evaluateColourFixAfterReconfigure() {
        if (!this._colourAwaitingPostReconfigure || this._colourFixPhase !== 'light')
            return;
        this._colourAwaitingPostReconfigure = false;
        this._cancelColourFixPostTimer();

        const s = this._sinkCapsString();
        if (!capsNeedHeavyColourFix(s)) {
            console.log('[ExtPipeline] colour fix: caps OK after reconfigure — staying on zero-copy/light path');
            return;
        }
        this._transitionToHeavyColourPath(s);
    }

    _transitionToHeavyColourPath(capsStr) {
        if (!this._pipeline || this._colourFixPhase !== 'light')
            return;

        const bin = this._buildCpuColourFilterBin();
        if (!bin) {
            console.warn('[ExtPipeline] colour fix: could not build heavy video-filter');
            return;
        }

        const capsForLog = capsStr ?? this._sinkCapsString() ?? '(unknown)';
        console.log(`[ExtPipeline] colour fix: engaging CPU heavy path — caps: ${capsForLog}`);

        try {
            this._pipeline.set_state(Gst.State.READY);
            this._pipeline.set_property('video-filter', bin);
            this._applyPlaybinForceFiltersOnly();
            this._pipeline.set_state(Gst.State.PLAYING);
            this._colourFixPhase = 'heavy-cpu';
            console.log('[ExtPipeline] colour fix: heavy path active (cpu)');
        } catch (e) {
            console.warn(`[ExtPipeline] colour fix: heavy path failed: ${e.message}`);
            try {
                this._pipeline.set_property('video-filter', null);
            } catch (e2) {}
            this._clearOurPlaybinColourFlags();
            this._colourFixPhase = 'light';
        }
    }

    _resetColourFixForNewUri() {
        this._cancelColourFixPostTimer();
        this._colourFixPhase = 'light';
        this._colourReconfigureSent = false;
        this._colourAwaitingPostReconfigure = false;
        if (!this._pipeline)
            return;
        if (!gtkColourFixEnabled()) {
            this._clearOurPlaybinColourFlags();
            try {
                this._pipeline.set_property('video-filter', null);
            } catch (e) {}
            return;
        }
        this._clearOurPlaybinColourFlags();
        try {
            this._pipeline.set_property('video-filter', null);
        } catch (e) {}
    }

    _resetColourCapsLog() {
        this._lastLoggedColourCaps = '';
        this._colourReconfigureSent = false;
        this._colourAwaitingPostReconfigure = false;
        this._cancelColourFixPostTimer();
    }

    _logGtkSinkColourCaps(context) {
        try {
            const pad = this._videoSink?.get_static_pad?.('sink');
            if (!pad) {
                console.log(`[ExtPipeline] colour caps (${context}): (no sink pad)`);
                return;
            }
            const caps = pad.get_current_caps();
            if (!caps || caps.is_empty()) {
                console.log(`[ExtPipeline] colour caps (${context}): (empty — not negotiated yet)`);
                return;
            }
            const s = caps.to_string();
            if (s === this._lastLoggedColourCaps)
                return;
            this._lastLoggedColourCaps = s;
            console.log(`[ExtPipeline] colour caps (${context}): ${s}`);
        } catch (e) {
            console.log(`[ExtPipeline] colour caps (${context}): (error ${e.message})`);
        }
    }

    _initVideo() {
        const createVideoSinkBin = (description) => {
            const bin = Gst.parse_bin_from_description(description, true);
            if (!bin)
                throw new Error('Failed to create video sink bin');
            const sink = bin.get_by_name('sink');
            if (!sink)
                throw new Error('Failed to find gtk4paintablesink in video sink bin');
            return { bin, sink };
        };

        const hasTargetSize = this._targetWidth > 0 && this._targetHeight > 0;
        if (this._useVideorate) {
            const prefix =
                `videorate skip-to-first=true ! video/x-raw,framerate=${this._framerate}/1 ! `;
            const sizedSuffix = `videoscale ! video/x-raw,width=${this._targetWidth},height=${this._targetHeight} ! gtk4paintablesink name=sink`;
            const plainSuffix = `gtk4paintablesink name=sink`;
            const desc = hasTargetSize ? prefix + sizedSuffix : prefix + plainSuffix;
            const { bin, sink } = createVideoSinkBin(desc);
            this._videoSink = sink;
            this._pipeline.set_property('video-sink', bin);
        } else if (hasTargetSize) {
            const { bin, sink } = createVideoSinkBin(
                `videoscale ! video/x-raw,width=${this._targetWidth},height=${this._targetHeight} ! gtk4paintablesink name=sink`
            );
            this._videoSink = sink;
            this._pipeline.set_property('video-sink', bin);
        } else {
            const { bin, sink } = createVideoSinkBin(`gtk4paintablesink name=sink`);
            this._videoSink = sink;
            this._pipeline.set_property('video-sink', bin);
        }
    }

    _initAudio() {
        const audioBin = new Gst.Bin({ name: 'audio-bin' });
        const audioConvert = Gst.ElementFactory.make('audioconvert', 'audioconvert');
        const audioSink = Gst.ElementFactory.make('autoaudiosink', 'audio-sink');
        this._volumeElement = Gst.ElementFactory.make('volume', 'volume');

        if (!audioConvert || !audioSink || !this._volumeElement)
            throw new Error('Failed to create audio elements');

        audioSink.set_property('sync', true);

        audioBin.add(audioConvert);
        audioBin.add(this._volumeElement);
        audioBin.add(audioSink);

        audioConvert.link(this._volumeElement);
        this._volumeElement.link(audioSink);

        this._volumeControl = GstController.InterpolationControlSource.new();
        this._volumeControl.set_property('mode', GstController.InterpolationMode.LINEAR);

        const binding = GstController.DirectControlBinding.new(
            this._volumeElement, 'volume', this._volumeControl
        );
        this._volumeElement.add_control_binding(binding);
        this._volumeElement.set_property('volume', this._volume);

        const audioGhostPad = Gst.GhostPad.new('sink', audioConvert.get_static_pad('sink'));
        audioBin.add_pad(audioGhostPad);

        this._pipeline.set_property('audio-sink', audioBin);
    }

    _initBusWatch() {
        this._bus = this._pipeline.get_bus();
        this._bus.add_signal_watch();
        this._bus.connect('message', (_, msg) => {
            if (msg.type === Gst.MessageType.EOS) {
                this._onEOS();
            } else if (msg.type === Gst.MessageType.ERROR) {
                const [err, debug] = msg.parse_error();
                console.error(`[ExtPipeline] GStreamer error: ${err.message} (${debug})`);
            } else if (msg.type === Gst.MessageType.ASYNC_DONE) {
                GLib.idle_add(GLib.PRIORITY_LOW, () => {
                    this._logGtkSinkColourCaps('async-done');
                    this._onColourFixAsyncDone();
                    return GLib.SOURCE_REMOVE;
                });
            }
        });
    }

    _onEOS() {
        if (this._videos.length === 1) {
            if (this._loop) {
                this._pipeline.seek_simple(
                    Gst.Format.TIME,
                    Gst.SeekFlags.FLUSH | Gst.SeekFlags.KEY_UNIT,
                    0
                );
            }
            return;
        }

        if (this._queuedFromAboutToFinish) {
            this._queuedFromAboutToFinish = false;
            this._pipeline.set_state(Gst.State.PLAYING);
            return;
        }

        if (this._randomOrder) {
            let next;
            do {
                next = Math.floor(Math.random() * this._videos.length);
            } while (next === this._currentIndex && this._videos.length > 1);
            this._currentIndex = next;
        } else {
            this._currentIndex = (this._currentIndex + 1) % this._videos.length;
        }

        const nextUri = GLib.filename_to_uri(this._videos[this._currentIndex], null);
        console.log(`[ExtPipeline] Playlist advancing to [${this._currentIndex}]: ${this._videos[this._currentIndex]}`);
        this._notifyTrackSwitch();
        this._resetColourCapsLog();
        this._pipeline.set_state(Gst.State.READY);
        this._resetColourFixForNewUri();
        this._pipeline.set_property('uri', nextUri);
        this._pipeline.set_state(Gst.State.PLAYING);
    }

    _onAboutToFinish() {
        if (!this._pipeline || this._videos.length <= 1)
            return;

        let nextIndex;
        if (this._randomOrder) {
            let next;
            do {
                next = Math.floor(Math.random() * this._videos.length);
            } while (next === this._currentIndex && this._videos.length > 1);
            nextIndex = next;
        } else {
            nextIndex = (this._currentIndex + 1) % this._videos.length;
        }

        const nextUri = GLib.filename_to_uri(this._videos[nextIndex], null);
        this._currentIndex = nextIndex;
        this._queuedFromAboutToFinish = true;
        this._notifyTrackSwitch();
        this._resetColourCapsLog();
        this._pipeline.set_property('uri', nextUri);
        console.log(`[ExtPipeline] Queued next URI via about-to-finish [${nextIndex}]: ${this._videos[nextIndex]}`);
    }

    _notifyTrackSwitch() {
        if (!this._onTrackSwitch)
            return;
        try {
            this._onTrackSwitch();
        } catch (e) {
            console.warn(`[ExtPipeline] onTrackSwitch callback error: ${e.message}`);
        }
    }

    // Advance playlist immediately.
    advanceToNext() {
        if (!this._pipeline || !Array.isArray(this._videos) || this._videos.length === 0)
            return false;

        if (this._videos.length === 1) {
            this._pipeline.seek_simple(
                Gst.Format.TIME,
                Gst.SeekFlags.FLUSH | Gst.SeekFlags.KEY_UNIT,
                0
            );
            this._pipeline.set_state(Gst.State.PLAYING);
            return true;
        }

        if (this._randomOrder) {
            let next;
            do {
                next = Math.floor(Math.random() * this._videos.length);
            } while (next === this._currentIndex && this._videos.length > 1);
            this._currentIndex = next;
        } else {
            this._currentIndex = (this._currentIndex + 1) % this._videos.length;
        }

        const nextUri = GLib.filename_to_uri(this._videos[this._currentIndex], null);
        this._queuedFromAboutToFinish = false;
        this._notifyTrackSwitch();
        this._resetColourCapsLog();
        this._pipeline.set_state(Gst.State.READY);
        this._resetColourFixForNewUri();
        this._pipeline.set_property('uri', nextUri);
        this._pipeline.set_state(Gst.State.PLAYING);
        console.log(`[ExtPipeline] Advanced to [${this._currentIndex}]: ${this._videos[this._currentIndex]}`);
        return true;
    }

    changeVideo(filePath) {
        if (!this._pipeline) return;
        const uri = GLib.filename_to_uri(filePath, null);
        console.log(`[ExtPipeline] Changing video to: ${filePath}`);
        this._resetColourCapsLog();
        this._pipeline.set_state(Gst.State.READY);
        this._resetColourFixForNewUri();
        this._pipeline.set_property('uri', uri);
        this._pipeline.set_state(Gst.State.PLAYING);
    }

    setVideos(videos) {
        this._videos = videos;
        this._currentIndex = 0;
    }

    get_paintable() {
        return this._videoSink?.get_property('paintable') ?? null;
    }

    easeVolume(target, durationMs = 300) {
        if (!this._volumeControl || !this._volumeElement)
            return;

        const clock = this._pipeline.get_clock();
        if (!clock) return;

        const now = clock.get_time();
        const base = this._pipeline.get_base_time();
        let runningTime = now - base;

        if (runningTime < 0 || runningTime === Gst.CLOCK_TIME_NONE)
            runningTime = 0;

        const startVol = this._volumeElement.volume;

        this._volumeControl.unset_all();

        const endTime = runningTime + (durationMs * Gst.MSECOND);

        const safeStart = Math.max(0.0, Math.min(1.0, startVol));
        const safeTarget = Math.max(0.0, Math.min(1.0, target));

        this._volumeControl.set(runningTime, safeStart / 10);
        this._volumeControl.set(endTime, safeTarget / 10);
    }

    play() {
        if (!this._pipeline) return;
        this.easeVolume(this._volume, FADE_DURATION);
        this._pipeline.set_state(Gst.State.PLAYING);
    }

    pause() {
        if (!this._pipeline) return;
        this.easeVolume(0, FADE_DURATION);
        GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            FADE_DURATION + 50,
            () => {
                if (!this._pipeline) return GLib.SOURCE_REMOVE;

                const [ok, position] = this._pipeline.query_position(Gst.Format.TIME);
                if (ok && position > 0) {
                    this._pipeline.seek_simple(
                        Gst.Format.TIME,
                        Gst.SeekFlags.FLUSH | Gst.SeekFlags.ACCURATE,
                        position
                    );
                }

                this._pipeline.set_state(Gst.State.PAUSED);
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    destroy() {
        this._cancelColourFixPostTimer();
        if (this._bus) {
            this._bus.remove_signal_watch();
            this._bus = null;
        }

        if (this._pipeline) {
            this._pipeline.set_state(Gst.State.NULL);
            this._pipeline = null;
        }

        this._videoSink = null;
        this._volumeElement = null;
        this._volumeControl = null;
        this._lastLoggedColourCaps = '';
        this._weSetForceFilters = false;
    }
}

// Colour opt-out: LIVELOCKPAPER_GTK_COLOR_FIX=0. Caps trace: GST_DEBUG=GST_CAPS:5
