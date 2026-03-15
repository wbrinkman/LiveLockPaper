import Gst from 'gi://Gst';
import GLib from 'gi://GLib';
import GstController from 'gi://GstController';

const FADE_DURATION = 300;

// Single gtk4paintablesink-based pipeline with playlist support.
export default class Pipeline {
    constructor({ videos, volume, loop, randomOrder, useVideorate, framerate, targetWidth = 0, targetHeight = 0, initialIndex = null, onTrackSwitch = null }) {
        this._bus = null;
        this._pipeline = null;
        this._videoSink = null;
        this._volumeElement = null;
        this._volumeControl = null;

        this._videos = videos;          // Array of file paths
        this._currentIndex = 0;
        this._volume = volume;
        this._loop = loop;              // Keep cycling the playlist
        this._randomOrder = randomOrder || false;
        this._useVideorate = useVideorate;
        this._framerate = framerate;
        this._targetWidth = targetWidth || 0;
        this._targetHeight = targetHeight || 0;
        this._initialIndex = Number.isInteger(initialIndex) ? initialIndex : null;
        this._queuedFromAboutToFinish = false;
        this._onTrackSwitch = typeof onTrackSwitch === 'function' ? onTrackSwitch : null;
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
            }
        });
    }

    _onEOS() {
        if (this._videos.length === 1) {
            if (this._loop) {
                // Single video loop — smooth seek to start
                this._pipeline.seek_simple(
                    Gst.Format.TIME,
                    Gst.SeekFlags.FLUSH | Gst.SeekFlags.KEY_UNIT,
                    0
                );
            }
            // If single video and !loop, pipeline naturally stops.
            return;
        }

        // If we already queued a next URI in about-to-finish, nudge the
        // pipeline back to PLAYING and let playbin continue seamlessly.
        if (this._queuedFromAboutToFinish) {
            this._queuedFromAboutToFinish = false;
            this._pipeline.set_state(Gst.State.PLAYING);
            return;
        }

        // Multiple videos — advance to next
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
        this._pipeline.set_state(Gst.State.READY);
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
        this._pipeline.set_state(Gst.State.READY);
        this._pipeline.set_property('uri', nextUri);
        this._pipeline.set_state(Gst.State.PLAYING);
        console.log(`[ExtPipeline] Advanced to [${this._currentIndex}]: ${this._videos[this._currentIndex]}`);
        return true;
    }

    // Change video at runtime.
    changeVideo(filePath) {
        if (!this._pipeline) return;
        const uri = GLib.filename_to_uri(filePath, null);
        console.log(`[ExtPipeline] Changing video to: ${filePath}`);
        this._pipeline.set_state(Gst.State.READY);
        this._pipeline.set_property('uri', uri);
        this._pipeline.set_state(Gst.State.PLAYING);
    }

    // Replace the full playlist.
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

        // Keep legacy /10 scaling for GstController behavior.
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
    }
}
