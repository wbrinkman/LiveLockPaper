import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';

// Wrapper for spawning and controlling the external GTK4 player process.
export class PlayerProcess {
    constructor({ playerPath, config }) {
        this._playerPath = playerPath;
        this._config = config;

        this._pid = null;
        this._stdin = null;
        this._mapId = null;
        this._timeoutId = null;
    }

    // Write config and spawn the subprocess.
    run() {
        // Write config to a temp file
        const configPath = GLib.build_filenamev([
            GLib.get_tmp_dir(),
            `livelockpaper-config-${GLib.get_real_time()}.json`,
        ]);

        const configJson = JSON.stringify(this._config);
        GLib.file_set_contents(configPath, configJson);

        console.log(`[PlayerProcess] Spawning: ${this._playerPath} ${configPath}`);

        // Force GTK4 to NGL to avoid known Vulkan crashes on some drivers.
        let env = GLib.get_environ();
        env = GLib.environ_setenv(env, 'GSK_RENDERER', 'ngl', true);

        const [success, pid, stdinFd] = GLib.spawn_async_with_pipes(
            null,                              // working directory (inherit)
            [this._playerPath, configPath],    // argv
            env,                               // envp (inherit + GSK_RENDERER=ngl)
            GLib.SpawnFlags.SEARCH_PATH,       // flags
            null                               // child_setup
        );

        if (!success)
            throw new Error('PlayerProcess: failed to spawn player subprocess');

        this._pid = pid;

        const stdinStream = new GioUnix.OutputStream({ fd: stdinFd, close_fd: true });
        this._stdin = new Gio.DataOutputStream({ base_stream: stdinStream });

        console.log(`[PlayerProcess] Subprocess started, PID=${pid}`);
    }

    // Wait until helper windows are mapped and matched by PID.
    waitForWindows(count, timeoutMs, callback, errback) {
        const collected = [];

        this._mapId = global.window_manager.connect_after('map', (_wm, windowActor) => {
            try {
                const win = windowActor.get_meta_window();
                if (!win || win.get_pid() !== this._pid) return;

                collected.push(win);
                console.log(`[PlayerProcess] Window mapped (${collected.length}/${count}), PID=${win.get_pid()}`);

                if (collected.length === count) {
                    global.window_manager.disconnect(this._mapId);
                    this._mapId = null;

                    if (this._timeoutId !== null) {
                        GLib.source_remove(this._timeoutId);
                        this._timeoutId = null;
                    }

                    callback(collected);
                }
            } catch (e) {
                console.error(`[PlayerProcess] Error in map handler: ${e.message}`);
            }
        });

        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
            if (this._mapId) {
                global.window_manager.disconnect(this._mapId);
                this._mapId = null;
            }
            this._timeoutId = null;
            errback?.(`timed out waiting for windows (got ${collected.length}/${count})`);
            return GLib.SOURCE_REMOVE;
        });
    }

    play() {
        this._sendCommand('play');
    }

    pause() {
        this._sendCommand('pause');
    }

    // Change video for one monitor.
    changeVideo(monitorIndex, filePath) {
        this._sendCommand(`change-video:${monitorIndex}:${filePath}`);
    }

    setVolume(volume) {
        this._sendCommand(`set-volume:${volume}`);
    }

    // Advance playlist; null target advances all monitors.
    next(monitorIndex = null) {
        if (monitorIndex === null || monitorIndex === undefined) {
            this._sendCommand('next:all');
            return;
        }
        this._sendCommand(`next:${monitorIndex}`);
    }

    _sendCommand(command) {
        if (!this._stdin) return;
        try {
            this._stdin.put_string(`${command}\n`, null);
        } catch (e) {
            console.error(`[PlayerProcess] Failed to send command "${command}": ${e.message}`);
        }
    }

    get pid() { return this._pid; }

    destroy() {
        if (this._timeoutId !== null) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }

        if (this._mapId) {
            try { global.window_manager.disconnect(this._mapId); } catch (_) {}
            this._mapId = null;
        }

        // Send quit command first for graceful shutdown
        this._sendCommand('quit');

        // Then kill as backup after a short delay
        if (this._pid) {
            const pid = this._pid;
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                try { GLib.spawn_command_line_sync(`kill ${pid}`); } catch (_) {}
                return GLib.SOURCE_REMOVE;
            });
            this._pid = null;
        }

        if (this._stdin) {
            try { this._stdin.close(null); } catch (_) {}
            this._stdin = null;
        }
    }
}
