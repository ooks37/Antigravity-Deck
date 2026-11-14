#!/usr/bin/env node
// === Persistent Headless Antigravity Hub Daemon ===
// Intended to be supervised by PM2 (`antigravity-hub`) on headless Linux VPS.
// Injects active SOCKS5h/HTTP proxy settings cleanly on every startup/restart,
// wraps Antigravity Electron inside Xvfb + D-Bus, and tears down its whole
// process group on SIGTERM/SIGINT so no orphan language_server/Xvfb lingers.

const os = require('os');
const { spawn } = require('child_process');
const { findLinuxIdeBinary, buildLinuxIdeSpawn } = require('../src/ide-launcher');

const bin = findLinuxIdeBinary(process.env.ANTIGRAVITY_BIN || null);
if (!bin) {
    console.error('[antigravity-hub] Antigravity binary not found. Checked standard paths and PATH.');
    process.exit(1);
}

const spec = buildLinuxIdeSpawn(bin, [], {
    env: { ...process.env, HOME: process.env.HOME || os.homedir() },
    homeDir: os.homedir(),
});

console.log(`[antigravity-hub] Starting ${bin} (headless=${spec.headless}, command=${spec.command})`);

const child = spawn(spec.command, spec.args, {
    stdio: 'inherit',
    env: spec.env,
    detached: process.platform !== 'win32',
});

let shuttingDown = false;
function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[antigravity-hub] Received ${signal}, stopping Antigravity process group...`);
    if (child.pid && process.platform !== 'win32') {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { /* ignore */ }
        const forceTimer = setTimeout(() => {
            try { process.kill(-child.pid, 'SIGKILL'); } catch { /* ignore */ }
            process.exit(0);
        }, 5000);
        forceTimer.unref();
    } else {
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
    }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

child.on('error', (err) => {
    console.error('[antigravity-hub] Spawn error:', err.message);
    process.exit(1);
});

child.on('exit', (code, signal) => {
    if (shuttingDown) {
        process.exit(0);
    }
    console.error(`[antigravity-hub] Exited unexpectedly (code=${code}, signal=${signal})`);
    process.exit(typeof code === 'number' ? code : 1);
});
