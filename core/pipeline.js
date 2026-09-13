import Gst from 'gi://Gst';
import GLib from 'gi://GLib';
import GstController from 'gi://GstController';

export default class Pipeline {
    constructor({ videoPath, volume, loop, framerate, skipFrame, dataCallback, onVideoEnd, targetWidth, targetHeight, timerPriority, preferHwDecoder, gpuColorConversion, name, timerDelay, adaptivePolling, useVideorate }) {
        this._videoPath = videoPath
        this._volume = volume
        this._loop = loop
        this._framerate = framerate
        // When true, videorate + caps force output to this._framerate (manual FPS mode). When false, stream keeps native timing (auto FPS).
        this._useVideorate = useVideorate ?? false
        this._dataCallback = dataCallback
        this._skipFrame = skipFrame ?? false
        this._onVideoEnd = onVideoEnd || null
        this._targetWidth = targetWidth || 0
        this._targetHeight = targetHeight || 0
        // Default for lock screen, idle for wallpaper.
        this._timerPriority = timerPriority ?? GLib.PRIORITY_DEFAULT
        this._preferHwDecoder = preferHwDecoder ?? false
        this._gpuColorConversion = gpuColorConversion ?? false
        // Human-readable name for log messages.
        this._name = name || 'default'
        // Optional start delay to stagger multiple pipelines.
        this._timerDelay = timerDelay ?? 0
        // Adaptive polling: quick re-poll on hit, normal interval on miss.
        this._adaptivePolling = adaptivePolling ?? false
    
        this._pipeline = null;
        this._bus = null;

        this._videoSink = null;

        this._volumeElement = null;
        this._volumeControl = null;
        
        this._initialized = false;
        this._firstFrame = true;
        this._destroyed = false;
        
        this._dataTimeoutId = null; 
        this._playbackTimeoutId = null;

        // Performance tracking
        this._frameCount = 0;
        this._droppedFrames = 0;
        this._lastStatsTime = 0;

        this._PLAYBACK_FADE_DUR = 300;
    }

    is_initialized() {
        return this._initialized
    }

    init() {
        if (this._initialized)
            return true;

        // Validate video path exists before building the pipeline
        if (!this._videoPath || !GLib.file_test(this._videoPath, GLib.FileTest.EXISTS)) {
            console.error(`[Pipeline:${this._name}] init: video file not found: ${this._videoPath}`);
            return false;
        }

        try {
            // Prefer hardware decoders when requested.
            if (this._preferHwDecoder) {
                this._boostHwDecoderRanks();
            }

            const videoBin   = new Gst.Bin({ name: 'video-bin' });
            const videoSink  = Gst.ElementFactory.make('appsink', 'video-sink');

            if (!videoSink) {
                throw new Error('Failed to create appsink element');
            }

            // Apply target resolution caps when provided.
            let capString = 'video/x-raw,format=BGRA';
            if (this._targetWidth > 0 && this._targetHeight > 0) {
                capString += `,width=${this._targetWidth},height=${this._targetHeight}`;
            }

            videoSink.set_property('caps', Gst.Caps.from_string(capString));
            videoSink.set_property('max-buffers', 1);
            videoSink.set_property('drop', true);
            videoSink.set_property('sync', true);
            videoSink.set_property('emit-signals', false);

            // Colour conversion path: GPU GL or CPU videoconvert.
            let useGpuConversion = false;
            let glUpload = null, glConvert = null, glDownload = null;
            let videoConvert = null;

            if (this._gpuColorConversion) {
                glUpload   = Gst.ElementFactory.make('glupload',        'glupload');
                glConvert  = Gst.ElementFactory.make('glcolorconvert',  'glcolorconvert');
                glDownload = Gst.ElementFactory.make('gldownload',      'gldownload');

                if (glUpload && glConvert && glDownload) {
                    useGpuConversion = true;
                    console.log(`[Pipeline:${this._name}] GPU colour conversion: ✓ (glupload → glcolorconvert → gldownload)`);
                } else {
                    console.log(`[Pipeline:${this._name}] GPU colour conversion: ✗ GL elements not available, falling back to CPU videoconvert`);
                    glUpload = null; glConvert = null; glDownload = null;
                }
            }

            if (!useGpuConversion) {
                videoConvert = Gst.ElementFactory.make('videoconvert', 'videoconvert');
                if (!videoConvert) {
                    throw new Error('Failed to create videoconvert element');
                }
                // Cheap videoconvert settings when available.
                try {
                    videoConvert.set_property('dither', 0);           // No dithering (faster)
                    videoConvert.set_property('chroma-mode', 0);      // No chroma resampling
                } catch (e) { /* properties may not exist in older GStreamer */ }
            }

            // Queue between decoder output and conversion.
            const preConvertQueue = Gst.ElementFactory.make('queue', 'pre-convert-queue');
            if (preConvertQueue) {
                preConvertQueue.set_property('max-size-buffers', 2);
                preConvertQueue.set_property('max-size-time', 0);
                preConvertQueue.set_property('max-size-bytes', 0);
            }

            // Optional scaler in-pipeline.
            const videoScale = Gst.ElementFactory.make('videoscale', 'videoscale');

            // Queue between conversion and sink side.
            const postConvertQueue = Gst.ElementFactory.make('queue', 'post-convert-queue');
            if (postConvertQueue) {
                postConvertQueue.set_property('max-size-buffers', 2);
                postConvertQueue.set_property('max-size-time', 0);
                postConvertQueue.set_property('max-size-bytes', 0);
            }

            // Assemble the video bin chain.
            const binElements = [];
            if (preConvertQueue) binElements.push(preConvertQueue);

            if (this._useVideorate) {
                const videoRate = Gst.ElementFactory.make('videorate', 'videorate');
                if (!videoRate)
                    throw new Error('Failed to create videorate element');
                try {
                    videoRate.set_property('skip-to-first', true);
                } catch (e) { /* older GStreamer */ }
                const fpsRound = Math.max(1, Math.min(120, Math.round(this._framerate)));
                const framerateCaps = Gst.Caps.from_string(`video/x-raw,framerate=${fpsRound}/1`);
                const capsFilter = Gst.ElementFactory.make('capsfilter', 'framerate-caps');
                if (!capsFilter)
                    throw new Error('Failed to create capsfilter for framerate');
                capsFilter.set_property('caps', framerateCaps);
                binElements.push(videoRate);
                binElements.push(capsFilter);
            }

            if (useGpuConversion) {
                binElements.push(glUpload);
                binElements.push(glConvert);
                binElements.push(glDownload);
            } else {
                binElements.push(videoConvert);
            }
            if (postConvertQueue) binElements.push(postConvertQueue);
            if (videoScale) {
                try { videoScale.set_property('method', 1); } catch (e) {} // bilinear
                binElements.push(videoScale);
            }
            binElements.push(videoSink);

            for (const el of binElements) videoBin.add(el);
            for (let i = 0; i < binElements.length - 1; i++) {
                if (!binElements[i].link(binElements[i + 1])) {
                    console.log(`[Pipeline:${this._name}] Warning: failed to link ${binElements[i].name} → ${binElements[i + 1].name}`);
                }
            }

            const ghostTarget = binElements[0].get_static_pad('sink');
            const videoGhostPad = Gst.GhostPad.new('sink', ghostTarget);
            videoBin.add_pad(videoGhostPad);

            let pipeline = Gst.ElementFactory.make('playbin', 'pipeline');
            if (!pipeline) {
                throw new Error('Failed to create playbin element')
            }
            pipeline.set_property('uri', GLib.filename_to_uri(this._videoPath, null));
            pipeline.set_property('video-sink', videoBin);
            
            // Keep playbin flags minimal.
            let flags = 0x1 | 0x40; // VIDEO + NATIVE_VIDEO
            if (this._volume > 0) flags |= 0x2; // AUDIO only when needed
            try {
                pipeline.set_property('flags', flags);
            } catch (e) {
                // Flags property may not be settable in all cases
            }

            // Add playbin video-filter queue when available.
            try {
                const videoFilter = Gst.ElementFactory.make('queue', 'playbin-video-filter');
                if (videoFilter) {
                    videoFilter.set_property('max-size-buffers', 2);
                    videoFilter.set_property('max-size-time', 0);
                    videoFilter.set_property('max-size-bytes', 0);
                    pipeline.set_property('video-filter', videoFilter);
                }
            } catch (e) {
                // video-filter property may not be available
            }

            if (this._volume > 0) {
                const audioBin      = new Gst.Bin({ name: 'audio-bin' });
                const audioQueue    = Gst.ElementFactory.make('queue', 'audio-queue');
                const audioConvert  = Gst.ElementFactory.make('audioconvert',  'audioconvert');
                const audioResample = Gst.ElementFactory.make('audioresample',  'audioresample');
                const audioSink =     Gst.ElementFactory.make('autoaudiosink', 'audio-sink');
                const volumeElement = Gst.ElementFactory.make('volume', 'volume');

                if (!audioConvert || !audioResample || !audioSink || !audioQueue || !volumeElement) {
                    throw new Error('Failed to create audio elements');
                }

                audioQueue.set_property('max-size-buffers', 0); // unlimited
                audioQueue.set_property('max-size-time', 5 * Gst.SECOND); // 5 second buffer
                audioQueue.set_property('max-size-bytes', 0); // unlimited

                audioSink.set_property('sync', true);
                
                audioBin.add(audioConvert);
                audioBin.add(audioResample);
                audioBin.add(audioQueue);
                audioBin.add(volumeElement);
                audioBin.add(audioSink);

                audioConvert.link(audioResample);
                audioResample.link(audioQueue);
                audioQueue.link(volumeElement);
                volumeElement.link(audioSink);

                const controlSource = GstController.InterpolationControlSource.new();
                controlSource.set_property(
                    'mode',
                    GstController.InterpolationMode.LINEAR
                );

                const binding = GstController.DirectControlBinding.new(
                    volumeElement,
                    'volume',
                    controlSource
                );

                volumeElement.add_control_binding(binding);
                volumeElement.set_property('volume', this._volume)

                this._volumeElement = volumeElement;
                this._volumeControl = controlSource;

                const audioGhostPad = Gst.GhostPad.new('sink', audioConvert.get_static_pad('sink'));
                audioBin.add_pad(audioGhostPad);

                pipeline.set_property('audio-sink', audioBin);
            } else {
                const fakeSink = Gst.ElementFactory.make('fakesink', 'audio-fake');
                pipeline.set_property('audio-sink', fakeSink);
            }

            this._pipeline = pipeline;
            this._bus = pipeline.get_bus();
            this._videoSink = videoSink;

            this._initBusWatch();

            // Manual FPS: poll at the capped rate. Auto/native timing: poll fast; videorate is off and
            // appsink sync drives frame times — using manual FPS here wrongly throttles to 2fps etc.
            const pollHz = this._useVideorate
                ? Math.max(1, Math.min(120, Math.round(this._framerate)))
                : 60;
            const interval = 1000 / pollHz;
            this._interval = interval;
            const scaleInfo = (this._targetWidth > 0 && this._targetHeight > 0)
                ? `, target: ${this._targetWidth}x${this._targetHeight}`
                : '';
            const prioLabel = this._timerPriority === GLib.PRIORITY_DEFAULT ? 'normal' : 'idle';
            const hwLabel = this._preferHwDecoder ? '✓' : '✗';
            const gpuLabel = useGpuConversion ? '✓' : '✗';
            const staggerInfo = this._timerDelay > 0 ? `, stagger: ${this._timerDelay}ms` : '';
            const deliveryLabel = this._adaptivePolling ? 'adaptive' : 'fixed';
            const rateLabel = this._useVideorate ? 'videorate+caps' : 'native';
            const pollNote = this._useVideorate ? `${this._framerate}fps` : `native+${pollHz}Hz-poll`;
            console.log(`[Pipeline:${this._name}] Initialized: ${pollNote} (${interval.toFixed(1)}ms${scaleInfo}${staggerInfo}), ${rateLabel}, polling: ${deliveryLabel}, priority: ${prioLabel}, hwdec: ${hwLabel}, gpu-cc: ${gpuLabel}`);
            this._lastStatsTime = GLib.get_monotonic_time();

            // Stagger timer start when requested.
            if (this._timerDelay > 0) {
                this._dataTimeoutId = GLib.timeout_add(this._timerPriority, this._timerDelay, () => {
                    console.log(`[Pipeline:${this._name}] Stagger delay elapsed, starting frame timer`);
                    if (this._adaptivePolling) {
                        this._scheduleAdaptivePoll(interval);
                    } else {
                        this._dataTimeoutId = this._startFetchTimer(interval);
                    }
                    return GLib.SOURCE_REMOVE;
                });
            } else if (this._adaptivePolling) {
                this._scheduleAdaptivePoll(interval);
            } else {
                this._dataTimeoutId = this._startFetchTimer(interval);
            }
            if (!this._dataTimeoutId) {
                throw new Error('Failed to create the fetch timer')
            }

            this._initialized = true;
            return true;
        }
        catch(e) {
            console.error('Pipeline init failed: ', e.message);
            this.destroy();
            return false;
        }
    }

    // Raise hardware decoder ranks over software decoders.
    _boostHwDecoderRanks() {
        const hwDecoders = [
            // GStreamer VA (modern, preferred)
            'vah264dec', 'vah265dec', 'vavp9dec', 'vaav1dec',
            'vajpegdec', 'vampeg2dec',
            // GStreamer VAAPI (legacy)
            'vaapidecodebin', 'vaapih264dec', 'vaapih265dec', 'vaapivp9dec',
            // NVIDIA NVDEC
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
            console.log(`[Pipeline:${this._name}] HW decoder ranks boosted: ${boosted.join(', ')}`);
        } else {
            console.log(`[Pipeline:${this._name}] No hardware decoders found on this system`);
        }
    }

    _initBusWatch() {
        this._bus.add_watch(GLib.PRIORITY_DEFAULT, (bus, message) => {
            if (message.type === Gst.MessageType.EOS) {
                if (this._loop) {
                    this._pipeline.seek_simple(
                        Gst.Format.TIME,
                        Gst.SeekFlags.FLUSH | Gst.SeekFlags.KEY_UNIT,
                        0
                    );
                    this._firstFrame = true;
                } else if (this._onVideoEnd) {
                    this._onVideoEnd();
                }
            }
            return GLib.SOURCE_CONTINUE;
        });
    }
    

    _startFetchTimer(interval) {
        return GLib.timeout_add(this._timerPriority, interval, () => this._fetchData());
    }

    // Adaptive polling: fast after hit, normal after miss.
    _scheduleAdaptivePoll(delayMs) {
        if (this._destroyed) return;
        this._dataTimeoutId = GLib.timeout_add(this._timerPriority, delayMs, () => {
            if (this._destroyed) return GLib.SOURCE_REMOVE;
            const gotFrame = this._fetchDataAdaptive();
            this._scheduleAdaptivePoll(gotFrame ? 1 : this._interval);
            return GLib.SOURCE_REMOVE;
        });
    }

    _easeVolume(target, durationMs = 300) {
        if (!this._volumeControl || !this._volumeElement)
            return;

        const clock = this._pipeline.get_clock();
        if (!clock) return;

        const now = clock.get_time();
        const base = this._pipeline.get_base_time();
        let runningTime = now - base;

        if (runningTime < 0 || runningTime === Gst.CLOCK_TIME_NONE) {
            runningTime = 0;
        }

        const startVol = this._volumeElement.volume;

        this._volumeControl.unset_all();

        const startTime = runningTime;
        const endTime = startTime + (durationMs * Gst.MSECOND);

        const safeStart = Math.max(0.0, Math.min(1.0, startVol));
        const safeTarget = Math.max(0.0, Math.min(1.0, target));

        // Keep legacy scaling to match existing pipeline volume behavior.
        this._volumeControl.set(startTime, safeStart / 10);
        this._volumeControl.set(endTime, safeTarget / 10);
    }

    // Pull one frame in fixed-interval mode.
    _fetchData() {
        this._pullAndProcess();
        return GLib.SOURCE_CONTINUE;
    }

    // Pull one frame in adaptive mode.
    _fetchDataAdaptive() {
        return this._pullAndProcess();
    }

    // Shared frame pull path used by fixed and adaptive timers.
    _pullAndProcess() {
        try {
            if (this._destroyed || !this._videoSink) return false;

        let sample = this._videoSink.emit('try-pull-sample', 0);
            if (!sample) {
                this._droppedFrames++;
                this._logStats();
                return false;
            }

        let buffer = sample.get_buffer();
        
            // Some files decode a bad first frame.
        if (this._skipFrame && this._firstFrame) {
            this._firstFrame = false;
                return false;
        }

        let caps = sample.get_caps();
        let structure = caps.get_structure(0);
        let [, width] = structure.get_int('width');
        let [, height] = structure.get_int('height');

        let [success, mapInfo] = buffer.map(Gst.MapFlags.READ);
            if (!success) return false;

            this._dataCallback(mapInfo.data, width, height);
            buffer.unmap(mapInfo);
            
            this._frameCount++;
            this._logStats();
            return true;
        } catch (e) {
            console.error(`[Pipeline:${this._name}] Error in frame processing: ${e.message}`);
            return false;
        }
    }

    // Log performance stats every 5 seconds.
    _logStats() {
        const now = GLib.get_monotonic_time();
        const elapsed = (now - this._lastStatsTime) / 1000000; // microseconds → seconds
        if (elapsed >= 5.0) {
            const actualFps = this._frameCount / elapsed;
            const mode = this._adaptivePolling ? 'adaptive' : 'fixed';
            const targetLabel = this._useVideorate ? `${this._framerate}fps` : 'native';
            console.log(`[Pipeline:${this._name}] Stats: ${actualFps.toFixed(1)} fps (${targetLabel}), ${this._droppedFrames} empty in ${elapsed.toFixed(0)}s [${mode}]`);
            this._frameCount = 0;
            this._droppedFrames = 0;
            this._lastStatsTime = now;
        }
    }

    play() {
        if (this._pipeline) {
            this._cancelRateRamp();
            this._clearPlaybackTimeout()
            this._pipeline.set_state(Gst.State.PLAYING);
            this._easeVolume(this._volume, this._PLAYBACK_FADE_DUR);
        }
    }

    getVideoPath() {
        return this._videoPath;
    }

    // Current playback position in nanoseconds, or null if unavailable.
    queryPositionNs() {
        if (!this._pipeline) return null;
        const [ok, pos] = this._pipeline.query_position(Gst.Format.TIME);
        return ok ? pos : null;
    }

    seekToNs(positionNs) {
        if (!this._pipeline || positionNs == null) return;
        try {
            this._pipeline.seek_simple(
                Gst.Format.TIME,
                Gst.SeekFlags.FLUSH | Gst.SeekFlags.KEY_UNIT,
                positionNs
            );
        } catch (e) {
            console.error(`[Pipeline:${this._name}] seek failed: ${e.message}`);
        }
    }

    // Like seekToNs, but waits until the pipeline can answer a position query first.
    // A freshly created/initialized pipeline isn't seekable the instant init()+play()
    // return — GStreamer needs real wall-clock time to finish PAUSED preroll — so a seek
    // issued immediately after can be silently dropped, leaving playback at position 0.
    // Calls onDone once the seek has actually been issued (or after maxWaitMs, best-effort).
    seekToNsWhenReady(positionNs, onDone, maxWaitMs = 1000, pollMs = 30) {
        if (!this._pipeline || positionNs == null) {
            if (onDone) onDone();
            return;
        }
        let waited = 0;
        const poll = () => {
            if (this._destroyed || !this._pipeline)
                return GLib.SOURCE_REMOVE;
            if (this.queryPositionNs() != null || waited >= maxWaitMs) {
                this.seekToNs(positionNs);
                if (onDone) onDone();
                return GLib.SOURCE_REMOVE;
            }
            waited += pollMs;
            return GLib.SOURCE_CONTINUE;
        };
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, pollMs, poll);
    }

    getRate() {
        return this._rate ?? 1.0;
    }

    // Change playback rate in place (GStreamer trick-play seek at the current position).
    // rate must be > 0 — GStreamer doesn't allow a literal 0 rate; use pause() to freeze.
    setRate(rate) {
        if (!this._pipeline) return;
        const posNs = this.queryPositionNs();
        if (posNs == null) return;
        try {
            this._pipeline.seek(
                rate,
                Gst.Format.TIME,
                Gst.SeekFlags.FLUSH | Gst.SeekFlags.KEY_UNIT,
                Gst.SeekType.SET, posNs,
                Gst.SeekType.NONE, -1
            );
            this._rate = rate;
        } catch (e) {
            console.error(`[Pipeline:${this._name}] setRate(${rate}) failed: ${e.message}`);
        }
    }

    // Change rate on the fly via GStreamer's "instant rate change" seek: a seek whose
    // only job is a new rate (SeekType.NONE for both start and stop, no FLUSH — GStreamer
    // rejects INSTANT_RATE_CHANGE combined with either). No flush means no re-preroll
    // stutter, so this is safe to call frequently for a ramp — unlike setRate() above.
    // Avoid calling it in the same tick as a position-changing seek (seekToNs/setRate);
    // GStreamer needs the segment to settle first or it logs a critical and no-ops.
    setRateInstant(rate) {
        if (!this._pipeline) return;
        try {
            const ok = this._pipeline.seek(
                rate,
                Gst.Format.TIME,
                Gst.SeekFlags.INSTANT_RATE_CHANGE,
                Gst.SeekType.NONE, -1,
                Gst.SeekType.NONE, -1
            );
            if (ok) this._rate = rate;
        } catch (e) {
            console.error(`[Pipeline:${this._name}] setRateInstant(${rate}) failed: ${e.message}`);
        }
    }

    // Smoothly ramp playback rate from fromRate to toRate over durationMs via instant
    // rate-change seeks (flush-free, so no per-step stutter). Linear rate-of-change:
    // an eased curve front/back-loads the change and reads as a plateau-then-snap once
    // it's clamped near zero — constant speed feels smoother end-to-end. The first step
    // fires after one stepMs tick rather than synchronously, so it never lands in the
    // same cycle as a preceding position seek (see setRateInstant's caveat above).
    // Calls onDone when the ramp completes.
    rampRate(fromRate, toRate, durationMs, onDone) {
        this._cancelRateRamp();
        const stepMs = 80;
        const steps = Math.max(1, Math.round(durationMs / stepMs));
        let step = 0;
        this._rateRampTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, stepMs, () => {
            if (this._destroyed || !this._pipeline) {
                this._rateRampTimeoutId = null;
                return GLib.SOURCE_REMOVE;
            }
            step++;
            const p = Math.min(1, step / steps);
            const rate = fromRate + (toRate - fromRate) * p;
            // Keep updating all the way down to a near-standstill crawl instead of
            // holding a fixed low rate for the tail — onDone's pause() then only has
            // to stop an already-barely-moving frame, not snap from a visible speed.
            this.setRateInstant(Math.max(rate, 0.01));
            if (p >= 1) {
                this._rateRampTimeoutId = null;
                if (onDone) onDone();
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _cancelRateRamp() {
        if (this._rateRampTimeoutId) {
            GLib.Source.remove(this._rateRampTimeoutId);
            this._rateRampTimeoutId = null;
        }
    }

    pause() {
        if (this._pipeline) {
            this._cancelRateRamp();
            this._clearPlaybackTimeout()
            this._easeVolume(0, this._PLAYBACK_FADE_DUR);
            this._playbackTimeoutId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT, 
                this._PLAYBACK_FADE_DUR + 50, 
                () => {
                this._pipeline.set_state(Gst.State.PAUSED);
                this._playbackTimeoutId = null;
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _clearPlaybackTimeout() {
        if (this._playbackTimeoutId) {
            GLib.Source.remove(this._playbackTimeoutId);
            this._playbackTimeoutId = null;
        }
    }

    changeVideo(newVideoPath, newFramerate = null) {
    // Skip invalid path changes.
        if (!newVideoPath || !GLib.file_test(newVideoPath, GLib.FileTest.EXISTS)) {
            console.log(`[Pipeline:${this._name}] changeVideo: file not found, skipping: ${newVideoPath}`);
            return;
        }

        // Destroy current pipeline
        this.destroy();
        
        // Update video path
        this._videoPath = newVideoPath;
        this._firstFrame = true;
        this._initialized = false;
        this._destroyed = false;
        
        // Update framerate if provided
        if (newFramerate !== null) {
            const oldFramerate = this._framerate;
            this._framerate = newFramerate;
            console.log(`[Pipeline:${this._name}] Framerate changed: ${oldFramerate} -> ${newFramerate} fps`);
        }
        
        // Reinitialize with new video
        if (this.init()) {
            this.play();
        }
    }

    destroy() {
        this._destroyed = true;
        this._cancelRateRamp();
        this._clearPlaybackTimeout()

        if (this._dataTimeoutId) {
            try { GLib.Source.remove(this._dataTimeoutId); } catch (e) { }
            this._dataTimeoutId = null;
        }
        if (this._bus) {
            this._bus.remove_watch();
            this._bus = null;
        }
        if (this._pipeline) {
            this._pipeline.set_state(Gst.State.NULL);
            this._pipeline = null;
        }

        this._videoSink = null;
        this._frameCount = 0;
        this._droppedFrames = 0;
    }
}