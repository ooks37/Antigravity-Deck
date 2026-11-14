// === Profile Manager — Cross-Platform Antigravity Account Folder Swapper ===
// Swaps account-specific data folders across Windows, Linux, and macOS:
// 1. Antigravity IDE user data dir (%APPDATA%\Antigravity | ~/.config/Antigravity | ~/Library/Application Support/Antigravity)
// 2. ~/.gemini (Gemini CLI / OAuth / antigravity cache)
// 3. ~/.antigravity (extensions / account state)

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { getSettings: defaultGetSettings, saveSettings: defaultSaveSettings } = require('./config');

const PS_PATH = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const SUPPORTED_PLATFORMS = new Set(['win32', 'linux', 'darwin']);
const PROFILE_SWAP_SUPPORTED = SUPPORTED_PLATFORMS.has(process.platform);

function getRuntime(opts = {}) {
    return {
        platform: opts.platform || process.platform,
        homeDir: opts.homeDir || os.homedir(),
        appDataDir: opts.appDataDir ?? process.env.APPDATA,
        localAppDataDir: opts.localAppDataDir ?? process.env.LOCALAPPDATA,
        xdgConfigHome: opts.xdgConfigHome ?? process.env.XDG_CONFIG_HOME,
        profilesDir: opts.profilesDir || null,
        getSettings: opts.getSettings || defaultGetSettings,
        saveSettings: opts.saveSettings || defaultSaveSettings,
        skipIdeControl: Boolean(opts.skipIdeControl),
    };
}

function assertProfileSwapSupported(opts = {}) {
    const { platform } = getRuntime(opts);
    if (SUPPORTED_PLATFORMS.has(platform)) return;
    const err = new Error(`当前平台 (${platform}) 暂不支持 IDE 目录切换。`);
    err.code = 'EPLATFORM';
    throw err;
}

function getAntigravityDataDir(opts = {}) {
    const rt = getRuntime(opts);
    if (rt.platform === 'win32') {
        const base = rt.appDataDir || path.join(rt.homeDir, 'AppData', 'Roaming');
        return path.join(base, 'Antigravity');
    }
    if (rt.platform === 'darwin') {
        return path.join(rt.homeDir, 'Library', 'Application Support', 'Antigravity');
    }
    const xdg = rt.xdgConfigHome || path.join(rt.homeDir, '.config');
    return path.join(xdg, 'Antigravity');
}

function getSwapFolders(opts = {}) {
    const rt = getRuntime(opts);
    return [
        { name: 'Antigravity', source: () => getAntigravityDataDir(rt) },
        { name: '.gemini', source: () => path.join(rt.homeDir, '.gemini') },
        { name: '.antigravity', source: () => path.join(rt.homeDir, '.antigravity') },
    ];
}

function getProfilesDir(opts = {}) {
    const rt = getRuntime(opts);
    if (rt.profilesDir) return rt.profilesDir;
    const settings = rt.getSettings();
    if (settings?.profilesDir) return settings.profilesDir;

    if (rt.platform === 'win32') {
        return path.join(rt.appDataDir || rt.homeDir, 'AntigravityDeck', 'profiles');
    }
    if (rt.platform === 'darwin') {
        return path.join(rt.homeDir, 'Library', 'Application Support', 'AntigravityDeck', 'profiles');
    }
    const xdg = rt.xdgConfigHome || path.join(rt.homeDir, '.config');
    return path.join(xdg, 'AntigravityDeck', 'profiles');
}

let _swapping = false; // mutex to prevent concurrent swaps

function moveDirSync(src, dst) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    try {
        fs.renameSync(src, dst);
    } catch (err) {
        if (err.code === 'EXDEV' || err.code === 'EPERM' || err.code === 'EBUSY') {
            fs.mkdirSync(dst, { recursive: true });
            fs.cpSync(src, dst, { recursive: true, force: true });
            fs.rmSync(src, { recursive: true, force: true, maxRetries: 3, retryDelay: 1000 });
            return;
        }
        throw err;
    }
}

async function moveDirWithRetry(src, dst, opts = {}, maxRetries = 5) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            moveDirSync(src, dst);
            return;
        } catch (err) {
            if ((err.code === 'EPERM' || err.code === 'EBUSY') && attempt < maxRetries) {
                const delay = 2000 + attempt * 2000;
                console.log(`[!] Profile swap: ${err.code} on "${path.basename(src)}", retry ${attempt + 1}/${maxRetries} in ${delay / 1000}s...`);
                await killJavaZombies(opts);
                await new Promise(r => setTimeout(r, delay));
                continue;
            }
            throw err;
        }
    }
}

function listProfiles(opts = {}) {
    const dir = getProfilesDir(opts);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
        .filter(d => d.isDirectory() && /^[a-zA-Z0-9_-]+$/.test(d.name))
        .map(d => d.name)
        .sort();
}

function getActiveProfile(opts = {}) {
    const rt = getRuntime(opts);
    return rt.getSettings()?.activeProfile || null;
}

function execFileAsync(file, args = [], timeout = 10000) {
    return new Promise((resolve, reject) => {
        execFile(file, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
            if (err) return reject(new Error(stderr || err.message));
            resolve((stdout || '').trim());
        });
    });
}

function runPs(cmd, timeout = 10000) {
    return execFileAsync(PS_PATH, ['-NoProfile', '-NonInteractive', '-Command', cmd], timeout);
}

// Find standalone desktop Antigravity IDE processes on Unix without ever matching Antigravity-Deck or LS
async function findUnixIdeProcesses() {
    try {
        const stdout = await execFileAsync('ps', ['-eo', 'pid=,comm=,args='], 5000);
        if (!stdout) return [];
        const pids = [];
        for (const line of stdout.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const match = trimmed.match(/^(\d+)\s+(\S+)\s+(.*)$/);
            if (!match) continue;
            const pid = parseInt(match[1], 10);
            const comm = match[2].toLowerCase();
            const args = match[3];
            if (!pid || pid === process.pid) continue;
            if (args.includes('Antigravity-Deck') || args.includes('language_server') || args.includes('--standalone')) continue;
            const exe = (args.split(/\s+/)[0] || '').toLowerCase();
            if (comm === 'antigravity' || exe.endsWith('/antigravity') || exe.includes('antigravity.app/contents/macos')) {
                pids.push({ pid, exe: args.split(/\s+/)[0] });
            }
        }
        return pids;
    } catch {
        return [];
    }
}

async function detectIdeInstalled(opts = {}) {
    const rt = getRuntime(opts);
    if (rt.platform === 'win32') {
        const exe = path.join(rt.localAppDataDir || path.join(rt.homeDir, 'AppData', 'Local'), 'Programs', 'Antigravity', 'Antigravity.exe');
        return fs.existsSync(exe);
    }
    if (rt.platform === 'darwin') {
        return fs.existsSync('/Applications/Antigravity.app') || fs.existsSync(path.join(rt.homeDir, 'Applications', 'Antigravity.app'));
    }
    for (const candidate of ['/usr/bin/antigravity', '/usr/local/bin/antigravity', '/opt/Antigravity/antigravity']) {
        if (fs.existsSync(candidate)) return true;
    }
    try {
        const whichOut = await execFileAsync('which', ['antigravity'], 2000);
        return Boolean(whichOut);
    } catch {
        return false;
    }
}

async function detectIdeRunning(opts = {}) {
    const rt = getRuntime(opts);
    if (rt.skipIdeControl) return false;
    if (rt.platform === 'win32') {
        try {
            const cnt = await runPs(`(Get-Process -Name Antigravity -ErrorAction SilentlyContinue).Count`);
            return (parseInt(cnt, 10) || 0) > 0;
        } catch {
            return false;
        }
    }
    const procs = await findUnixIdeProcesses();
    return procs.length > 0;
}

// Gracefully close desktop IDE before swapping folders (never force-kill on Windows due to DPAPI token flush)
async function gracefulCloseIde(opts = {}) {
    const rt = getRuntime(opts);
    if (rt.skipIdeControl) return null;

    if (rt.platform === 'win32') {
        let exePath = null;
        try {
            exePath = await runPs(`(Get-Process -Name Antigravity -ErrorAction SilentlyContinue | Where-Object { $_.Path }).Path | Select-Object -First 1`);
        } catch { /* OK */ }

        let processCount = 0;
        try {
            const cnt = await runPs(`(Get-Process -Name Antigravity -ErrorAction SilentlyContinue).Count`);
            processCount = parseInt(cnt, 10) || 0;
        } catch { /* OK */ }

        if (processCount === 0) {
            console.log('[*] Profile swap: IDE not running, skipping close');
            return exePath;
        }

        console.log(`[*] Profile swap: sending graceful close to ${processCount} Antigravity processes...`);
        try {
            await runPs(`Get-Process -Name Antigravity -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { $_.CloseMainWindow() } | Out-Null`);
        } catch { /* OK */ }

        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
            try {
                const remaining = await runPs(`(Get-Process -Name Antigravity -ErrorAction SilentlyContinue).Count`);
                if (!remaining || remaining === '0') {
                    console.log('[*] Profile swap: IDE closed gracefully');
                    await new Promise(r => setTimeout(r, 1000));
                    return exePath;
                }
            } catch { break; }
            await new Promise(r => setTimeout(r, 1000));
        }

        let stillAlive = 0;
        try {
            const cnt = await runPs(`(Get-Process -Name Antigravity -ErrorAction SilentlyContinue).Count`);
            stillAlive = parseInt(cnt, 10) || 0;
        } catch { /* OK */ }
        if (stillAlive > 0) {
            throw new Error(`Antigravity IDE 未能在 30 秒内关闭（仍有 ${stillAlive} 个进程），请手动关闭后重试，避免损坏登录凭据。`);
        }
        await new Promise(r => setTimeout(r, 1000));
        return exePath;
    }

    const procs = await findUnixIdeProcesses();
    if (procs.length === 0) {
        console.log('[*] Profile swap: IDE not running (or headless VPS), skipping close');
        return null;
    }

    const exePath = procs[0]?.exe || null;
    console.log(`[*] Profile swap: closing ${procs.length} Antigravity process(es) on ${rt.platform}...`);
    if (rt.platform === 'darwin') {
        try {
            await execFileAsync('osascript', ['-e', 'tell application "Antigravity" to quit'], 8000);
        } catch {
            for (const p of procs) {
                try { process.kill(p.pid, 'SIGTERM'); } catch { /* ignore */ }
            }
        }
    } else {
        for (const p of procs) {
            try { process.kill(p.pid, 'SIGTERM'); } catch { /* ignore */ }
        }
    }

    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
        const remaining = await findUnixIdeProcesses();
        if (remaining.length === 0) {
            await new Promise(r => setTimeout(r, 500));
            return exePath;
        }
        await new Promise(r => setTimeout(r, 500));
    }

    const stillRunning = await findUnixIdeProcesses();
    if (stillRunning.length > 0) {
        throw new Error(`Antigravity IDE 未能在 20 秒内退出（仍有 ${stillRunning.length} 个进程），请手动退出后再试。`);
    }
    return exePath;
}

async function killJavaZombies(opts = {}) {
    const rt = getRuntime(opts);
    if (rt.skipIdeControl) return;
    if (rt.platform === 'win32') {
        try {
            await runPs(`Get-CimInstance Win32_Process -Filter "Name='java.exe'" | Where-Object { $_.CommandLine -match 'antigravity' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`, 5000);
        } catch { /* OK */ }
        return;
    }
    try {
        const out = await execFileAsync('ps', ['-eo', 'pid=,comm=,args='], 4000);
        for (const line of out.split('\n')) {
            const match = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
            if (!match) continue;
            const pid = parseInt(match[1], 10);
            const comm = match[2].toLowerCase();
            const args = match[3].toLowerCase();
            if (comm === 'java' && args.includes('.antigravity')) {
                try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
            }
        }
    } catch { /* OK */ }
}

async function swapFolders(currentProfile, targetProfile, opts = {}) {
    const rt = getRuntime(opts);
    const profilesDir = getProfilesDir(rt);
    const currentDir = path.join(profilesDir, currentProfile);
    const targetDir = path.join(profilesDir, targetProfile);
    const folders = getSwapFolders(rt);

    fs.mkdirSync(currentDir, { recursive: true });
    if (!fs.existsSync(targetDir)) {
        throw new Error(`目标档案 "${targetProfile}" 不存在`);
    }

    const movedToCurrent = [];
    try {
        for (const f of folders) {
            const src = f.source();
            const dst = path.join(currentDir, f.name);
            if (fs.existsSync(src)) {
                if (fs.existsSync(dst)) {
                    fs.rmSync(dst, { recursive: true, force: true });
                }
                await moveDirWithRetry(src, dst, rt);
                movedToCurrent.push({ src, dst });
            }
        }
    } catch (err) {
        for (const m of movedToCurrent) {
            try { moveDirSync(m.dst, m.src); } catch { /* best effort */ }
        }
        throw new Error(`保存当前档案失败: ${err.message}`);
    }

    const movedFromTarget = [];
    try {
        for (const f of folders) {
            const src = path.join(targetDir, f.name);
            const dst = f.source();
            if (fs.existsSync(src)) {
                if (fs.existsSync(dst)) {
                    fs.rmSync(dst, { recursive: true, force: true });
                }
                await moveDirWithRetry(src, dst, rt);
                movedFromTarget.push({ src, dst });
            }
        }
    } catch (err) {
        for (const m of movedFromTarget) {
            try { moveDirSync(m.dst, m.src); } catch { /* best effort */ }
        }
        for (const m of movedToCurrent) {
            try { moveDirSync(m.dst, m.src); } catch { /* best effort */ }
        }
        throw new Error(`恢复目标档案 "${targetProfile}" 失败（已回滚）: ${err.message}`);
    }
}

function relaunchIde(exePath, opts = {}) {
    const rt = getRuntime(opts);
    if (rt.skipIdeControl) return false;

    if (rt.platform === 'win32') {
        const fallback = path.join(rt.localAppDataDir || path.join(rt.homeDir, 'AppData', 'Local'), 'Programs', 'Antigravity', 'Antigravity.exe');
        const exe = (exePath && fs.existsSync(exePath)) ? exePath : fallback;
        if (!fs.existsSync(exe)) {
            console.log(`[!] Profile swap: IDE executable not found at ${exe} — skipping relaunch`);
            return false;
        }
        console.log(`[*] Profile swap: relaunching IDE (${exe})...`);
        const child = spawn(exe, [], { detached: true, stdio: 'ignore' });
        child.unref();
        return true;
    }

    if (rt.platform === 'darwin') {
        if (!fs.existsSync('/Applications/Antigravity.app') && !fs.existsSync(path.join(rt.homeDir, 'Applications', 'Antigravity.app'))) {
            return false;
        }
        const child = spawn('open', ['-a', 'Antigravity'], { detached: true, stdio: 'ignore' });
        child.unref();
        return true;
    }

    // Linux desktop vs headless VPS
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
        console.log('[*] Profile swap: headless Linux/VPS environment (no DISPLAY), skipping desktop IDE relaunch');
        return false;
    }
    const candidates = [exePath, '/usr/bin/antigravity', '/usr/local/bin/antigravity', '/opt/Antigravity/antigravity'].filter(Boolean);
    const exe = candidates.find(p => fs.existsSync(p));
    if (!exe) return false;
    const child = spawn(exe, [], { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
}

function validateProfileName(name) {
    if (!name || typeof name !== 'string') throw new Error('档案名称不能为空');
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('档案名称仅支持英文字母、数字、连字符和下划线');
    if (name.length > 50) throw new Error('档案名称过长（最多 50 个字符）');
    return name;
}

async function swapProfile(targetProfile, opts = {}) {
    assertProfileSwapSupported(opts);
    if (_swapping) throw new Error('已有账号切换操作正在进行中，请稍候');
    validateProfileName(targetProfile);

    const rt = getRuntime(opts);
    const currentProfile = getActiveProfile(rt);
    if (!currentProfile) {
        throw new Error('当前处于“添加新账号”状态，请先保存当前登录账号或取消添加后再切换。');
    }
    if (currentProfile === targetProfile) {
        throw new Error(`当前已处于档案 "${targetProfile}"`);
    }

    const profiles = listProfiles(rt);
    if (!profiles.includes(targetProfile)) {
        throw new Error(`未找到档案 "${targetProfile}"`);
    }

    _swapping = true;
    try {
        console.log(`[*] Profile swap (${rt.platform}): ${currentProfile} -> ${targetProfile}`);
        try {
            const { broadcastAll } = require('./ws');
            broadcastAll({ type: 'status', detected: false, swapping: true, from: currentProfile, to: targetProfile });
        } catch { /* ignore */ }

        const exePath = await gracefulCloseIde(rt);
        await killJavaZombies(rt);
        await swapFolders(currentProfile, targetProfile, rt);
        rt.saveSettings({ activeProfile: targetProfile });
        const relaunched = relaunchIde(exePath, rt);

        try {
            const { broadcastAll } = require('./ws');
            broadcastAll({ type: 'swap_complete', profile: targetProfile });
        } catch { /* ignore */ }

        return {
            success: true,
            platform: rt.platform,
            previousProfile: currentProfile,
            activeProfile: targetProfile,
            relaunched,
        };
    } finally {
        _swapping = false;
    }
}

function findProfileByEmail(email, opts = {}) {
    if (!email) return null;
    const profiles = listProfiles(opts);
    for (const p of profiles) {
        const meta = getProfileMetadata(p, opts);
        if (meta && meta.email && meta.email.toLowerCase() === email.toLowerCase()) return p;
    }
    return null;
}

function createProfile(name, metadata = null, { force = false } = {}, opts = {}) {
    assertProfileSwapSupported(opts);
    validateProfileName(name);
    const rt = getRuntime(opts);
    const dir = path.join(getProfilesDir(rt), name);
    if (fs.existsSync(dir)) throw new Error(`档案 "${name}" 已存在`);

    if (!force && metadata?.email) {
        const existing = findProfileByEmail(metadata.email, rt);
        if (existing) {
            throw new Error(`账号 "${metadata.email}" 已保存为档案 "${existing}"。如需强制另存请开启覆盖选项。`);
        }
    }

    fs.mkdirSync(dir, { recursive: true });
    const SKIP_DIRS = new Set(['Network', 'GPUCache', 'GrShaderCache', 'ShaderCache', 'Service Worker', 'Cache_Data', 'Code Cache']);
    const filterCopy = (src) => !SKIP_DIRS.has(path.basename(src));

    let copied = 0;
    for (const f of getSwapFolders(rt)) {
        const src = f.source();
        if (fs.existsSync(src)) {
            try {
                fs.cpSync(src, path.join(dir, f.name), { recursive: true, filter: filterCopy });
            } catch (err) {
                if (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EPIPE') {
                    console.warn(`[!] Profile create: partial copy of ${f.name}`);
                } else {
                    throw err;
                }
            }
            copied++;
        }
    }

    if (copied === 0) {
        fs.rmSync(dir, { recursive: true, force: true });
        throw new Error('未检测到可保存的 IDE 或 Gemini 数据目录，请先至少启动并登录一次。');
    }

    if (metadata) {
        fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify(metadata, null, 2), 'utf-8');
    }

    rt.saveSettings({ activeProfile: name });
    return { created: true, copied, message: `已保存当前账号档案 "${name}"` };
}

function getProfileMetadata(name, opts = {}) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name || '')) return null;
    const metaPath = path.join(getProfilesDir(opts), name, 'profile.json');
    if (!fs.existsSync(metaPath)) return null;
    try { return JSON.parse(fs.readFileSync(metaPath, 'utf-8')); } catch { return null; }
}

function renameProfile(oldName, newName, opts = {}) {
    validateProfileName(oldName);
    validateProfileName(newName);
    if (oldName === newName) throw new Error('新档案名不能与原名称相同');
    const rt = getRuntime(opts);
    const profilesDir = getProfilesDir(rt);
    const oldDir = path.join(profilesDir, oldName);
    const newDir = path.join(profilesDir, newName);
    if (!fs.existsSync(oldDir)) throw new Error(`未找到档案 "${oldName}"`);
    if (fs.existsSync(newDir)) throw new Error(`档案 "${newName}" 已存在`);

    moveDirSync(oldDir, newDir);
    if (getActiveProfile(rt) === oldName) {
        rt.saveSettings({ activeProfile: newName });
    }
    return { renamed: true, oldName, newName };
}

function deleteProfile(name, opts = {}) {
    validateProfileName(name);
    const rt = getRuntime(opts);
    const active = getActiveProfile(rt);
    if (name === active) throw new Error('无法删除当前正在使用的档案，请先切换到其他档案');
    const dir = path.join(getProfilesDir(rt), name);
    if (!fs.existsSync(dir)) throw new Error(`未找到档案 "${name}"`);
    fs.rmSync(dir, { recursive: true, force: true });
    return { deleted: true, message: `档案 "${name}" 已删除` };
}

async function startAddAccount(opts = {}) {
    assertProfileSwapSupported(opts);
    if (_swapping) throw new Error('已有账号操作正在进行中');
    const rt = getRuntime(opts);
    const currentProfile = getActiveProfile(rt);
    if (!currentProfile) throw new Error('当前没有活跃档案，请先保存当前账号');

    _swapping = true;
    try {
        console.log(`[*] Add account (${rt.platform}): saving "${currentProfile}" -> resetting active folders`);
        const exePath = await gracefulCloseIde(rt);
        await killJavaZombies(rt);

        const profilesDir = getProfilesDir(rt);
        const currentDir = path.join(profilesDir, currentProfile);
        fs.mkdirSync(currentDir, { recursive: true });
        for (const f of getSwapFolders(rt)) {
            const src = f.source();
            const dst = path.join(currentDir, f.name);
            if (fs.existsSync(src)) {
                if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
                await moveDirWithRetry(src, dst, rt);
            }
        }

        const relaunched = relaunchIde(exePath, rt);
        rt.saveSettings({ activeProfile: null });
        return {
            success: true,
            previousProfile: currentProfile,
            relaunched,
            message: relaunched
                ? '已以空白登录状态重启 Antigravity IDE，登录新 Google 账号后点击“保存账号”即可。'
                : '已清空当前档案目录（未检测到可重启的桌面 IDE）。请登录或导入新账号后保存档案。',
        };
    } finally {
        _swapping = false;
    }
}

async function cancelAddAccount(previousProfile, opts = {}) {
    assertProfileSwapSupported(opts);
    validateProfileName(previousProfile);
    const rt = getRuntime(opts);
    const profilesDir = getProfilesDir(rt);
    const prevDir = path.join(profilesDir, previousProfile);
    if (!fs.existsSync(prevDir)) throw new Error(`未找到原档案 "${previousProfile}"`);

    _swapping = true;
    try {
        const exePath = await gracefulCloseIde(rt);
        await killJavaZombies(rt);

        for (const f of getSwapFolders(rt)) {
            const p = f.source();
            if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
        }

        for (const f of getSwapFolders(rt)) {
            const src = path.join(prevDir, f.name);
            const dst = f.source();
            if (fs.existsSync(src)) {
                moveDirSync(src, dst);
            }
        }

        rt.saveSettings({ activeProfile: previousProfile });
        const relaunched = relaunchIde(exePath, rt);
        return { success: true, activeProfile: previousProfile, relaunched };
    } finally {
        _swapping = false;
    }
}

async function getProfileEnvironment(opts = {}) {
    const rt = getRuntime(opts);
    const ideInstalled = await detectIdeInstalled(rt);
    const ideRunning = await detectIdeRunning(rt);
    return {
        platform: rt.platform,
        ideSupported: SUPPORTED_PLATFORMS.has(rt.platform),
        ideInstalled,
        ideRunning,
        headless: rt.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY,
        profilesDir: getProfilesDir(rt),
        antigravityDataDir: getAntigravityDataDir(rt),
    };
}

function isSwapping() { return _swapping; }

module.exports = {
    listProfiles,
    getActiveProfile,
    swapProfile,
    createProfile,
    deleteProfile,
    renameProfile,
    getProfileMetadata,
    findProfileByEmail,
    startAddAccount,
    cancelAddAccount,
    isSwapping,
    assertProfileSwapSupported,
    getProfileEnvironment,
    getAntigravityDataDir,
    getProfilesDir,
    getSwapFolders,
    validateProfileName,
};
