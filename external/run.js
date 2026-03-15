#!/usr/bin/env -S gjs -m
// Entry point for the external GTK4 player subprocess.
import GLib from 'gi://GLib';
import Player from './player.js';

const configPath = ARGV[0];
if (!configPath) {
    console.error('[run.js] No config file path provided');
    imports.system.exit(1);
}

let config;
try {
    const [ok, contents] = GLib.file_get_contents(configPath);
    if (!ok) throw new Error('file_get_contents returned false');
    config = JSON.parse(new TextDecoder().decode(contents));
} catch (e) {
    console.error(`[run.js] Failed to read config from ${configPath}: ${e.message}`);
    imports.system.exit(1);
}

// Clean up the temp config file
try {
    GLib.unlink(configPath);
} catch (_) { }

console.log(`[run.js] Starting player with config: ${JSON.stringify(config).substring(0, 200)}…`);

const player = new Player(config);
player.run();
