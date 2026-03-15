import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';

// Reads newline-delimited commands from stdin and dispatches handlers.
export default class CommandHandler {
    constructor() {
        this._stdin = null;
        this._handlers = new Map();
        this._cancelled = false;
    }

    init() {
        this._stdin = new Gio.DataInputStream({
            base_stream: new GioUnix.InputStream({
                fd: 0,
                close_fd: false,
            }),
        });
        this._read();
    }

    addHandler(command, callback) {
        this._handlers.set(command, callback);
    }

    removeHandler(command) {
        this._handlers.delete(command);
    }

    _read() {
        if (this._cancelled) return;

        this._stdin.read_line_async(GLib.PRIORITY_DEFAULT, null, (_, result) => {
            try {
                const [line] = this._stdin.read_line_finish(result);
                if (line) {
                    const text = new TextDecoder().decode(line).trim();
                    // Commands can be plain ("play") or carry a payload ("change-video:0:/path/to/file.mp4")
                    const colonIdx = text.indexOf(':');
                    const cmd = colonIdx >= 0 ? text.substring(0, colonIdx) : text;
                    const payload = colonIdx >= 0 ? text.substring(colonIdx + 1) : null;

                    const handler = this._handlers.get(cmd);
                    if (handler) {
                        handler(payload);
                    } else {
                        console.warn(`[CommandHandler] Unknown command: "${cmd}"`);
                    }
                }
            } catch (e) {
                if (!this._cancelled)
                    console.error(`[CommandHandler] Error reading stdin: ${e.message}`);
            }
            this._read();
        });
    }

    destroy() {
        this._cancelled = true;
        this._handlers.clear();

        if (this._stdin) {
            try { this._stdin.close(null); } catch (_) {}
            this._stdin = null;
        }
    }
}
