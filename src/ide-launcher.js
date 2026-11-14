// === Shared IDE Launcher (Cross-Platform & Headless Linux VPS) ===
// Unified launcher used by /api/launch-ide, /api/workspaces/create,
// profile-manager relaunchIde, and scripts/antigravity-daemon.js.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile, execFileSync } = require('child_process');
const { getChildProcessEnv, getChromiumProxyArgs } = require('./proxy-manager');

const LINUX_IDE_CANDIDATES = [
    '/usr/bin/antigravity',
    '/usr/local/bin/antigravity',
    '/opt/antigravity/Antigravity-x64/antigravity',
    '/opt/Antigravity/antigravity',
];

const PM2_HUB_APP_NAME = 'antigravity-hub';

function execFileAsync(file, args, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        execFile(file, args, { timeout: timeoutMs }, (err, stdout) => {
            if (err) reject(err);
            else resolve(String(stdout || '').trim());
        });
    });
}

function findLinuxIdeBinary(preferredPath = null, opts = {}) {
    const existsSync = opts.existsSync || fs.existsSync;
    const candidates = [preferredPath, ...LINUX_IDE_CANDIDATES].filter(Boolean);
    for (const p of candidates) {
        if (existsSync(p)) return p;
    }
    if (!opts.skipWhich) {
        try {
            const out = execFileSync('which', ['antigravity'], { encoding: 'utf8', timeout: 2000 }).trim();
            if (out && existsSync(out)) return out;
        } catch { /* ignore */ }
    }
    return null;
}

function isHeadlessDisplay(env = process.env) {
    return !env.DISPLAY && !env.WAYLAND_DISPLAY;
}

function buildLinuxIdeSpawn(binaryPath, extraArgs = [], opts = {}) {
    const existsSync = opts.existsSync || fs.existsSync;
    const getuid = opts.getuid || (typeof process.getuid === 'function' ? () => process.getuid() : () => 1000);
    const getChildEnv = opts.getChildProcessEnv || getChildProcessEnv;
    const getProxyArgs = opts.getChromiumProxyArgs || getChromiumProxyArgs;

    const baseEnv = getChildEnv(opts.env || process.env);
    const env = { ...baseEnv, HOME: baseEnv.HOME || opts.homeDir || os.homedir() };
    const proxyArgs = getProxyArgs() || [];
    const headless = isHeadlessDisplay(env);

    const electronFlags = [];
    if (headless || getuid() === 0) {
        electronFlags.push('--no-sandbox', '--disable-dev-shm-usage');
    }
    if (headless) {
        electronFlags.push('--disable-gpu');
    }

    const appArgs = [...electronFlags, ...proxyArgs, ...extraArgs];
    const hasXvfb = existsSync('/usr/bin/xvfb-run');
    const hasDbus = existsSync('/usr/bin/dbus-run-session');

    if (headless && hasXvfb) {
        const inner = hasDbus
            ? ['/usr/bin/dbus-run-session', '--', binaryPath, ...appArgs]
            : [binaryPath, ...appArgs];
        return {
            command: '/usr/bin/xvfb-run',
            args: ['-a', '-s', '-screen 0 1280x800x24', ...inner],
            env,
            headless: true,
        };
    }

    return {
        command: binaryPath,
        args: appArgs,
        env,
        headless,
    };
}

async function hasPm2HubApp() {
    if (process.platform === 'win32') return false;
    try {
        const raw = await execFileAsync('pm2', ['jlist'], 4000);
        const list = JSON.parse(raw || '[]');
        return Array.isArray(list) && list.some((app) => app && app.name === PM2_HUB_APP_NAME);
    } catch {
        return false;
    }
}

async function stopManagedIde() {
    if (!(await hasPm2HubApp())) return false;
    try {
        await execFileAsync('pm2', ['stop', PM2_HUB_APP_NAME], 8000);
        return true;
    } catch {
        return false;
    }
}

async function restartManagedIde() {
    if (!(await hasPm2HubApp())) return false;
    await execFileAsync('pm2', ['restart', PM2_HUB_APP_NAME], 8000);
    return true;
}

function launchDesktopIde({ exePath = null, extraArgs = [], workspacePath = null, homeDir = os.homedir(), localAppDataDir = process.env.LOCALAPPDATA } = {}) {
    const platform = os.platform();
    const childEnv = getChildProcessEnv(process.env);
    const proxyArgs = getChromiumProxyArgs();

    if (platform === 'darwin') {
        const appExists = fs.existsSync('/Applications/Antigravity.app') || fs.existsSync(path.join(homeDir, 'Applications', 'Antigravity.app'));
        if (!appExists) return false;
        const appArgs = [...extraArgs, ...proxyArgs];
        const base = workspacePath ? ['-a', 'Antigravity', workspacePath] : ['-a', 'Antigravity'];
        const openArgs = appArgs.length ? [...base, '--args', ...appArgs] : base;
        const child = spawn('open', openArgs, { timeout: 10000, detached: true, stdio: 'ignore', env: childEnv });
        child.on('error', (err) => console.error('[!] Failed to open Antigravity:', err.message));
        child.unref();
        return true;
    }

    const argsWithWorkspace = workspacePath ? ['--trust-workspace', workspacePath, ...extraArgs] : [...extraArgs];

    if (platform === 'win32') {
        const fallback = path.join(localAppDataDir || path.join(homeDir, 'AppData', 'Local'), 'Programs', 'Antigravity', 'Antigravity.exe');
        const exe = (exePath && fs.existsSync(exePath)) ? exePath : (fs.existsSync(fallback) ? fallback : 'antigravity');
        const child = spawn(exe, [...argsWithWorkspace, ...proxyArgs], { timeout: 10000, detached: true, stdio: 'ignore', shell: exe === 'antigravity', env: childEnv });
        child.on('error', (err) => console.error('[!] Failed to launch antigravity:', err.message));
        child.unref();
        return true;
    }

    const bin = findLinuxIdeBinary(exePath);
    if (!bin) return false;
    const spec = buildLinuxIdeSpawn(bin, argsWithWorkspace, { homeDir });
    const child = spawn(spec.command, spec.args, { detached: true, stdio: 'ignore', env: spec.env });
    child.on('error', (err) => console.error('[!] Failed to launch antigravity:', err.message));
    child.unref();
    return true;
}

module.exports = {
    PM2_HUB_APP_NAME,
    LINUX_IDE_CANDIDATES,
    findLinuxIdeBinary,
    isHeadlessDisplay,
    buildLinuxIdeSpawn,
    hasPm2HubApp,
    stopManagedIde,
    restartManagedIde,
    launchDesktopIde,
};
