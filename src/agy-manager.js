// === Antigravity CLI (agy) Version Check & Manual Updater ===
// Auto-discovers `agy` across Windows/macOS/Linux without pinning versions,
// reads version & changelog, and exposes a mutex-guarded `agy update` trigger.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { getSettings } = require('./config');
const { getChildProcessEnv } = require('./proxy-manager');

const defaultExecFileAsync = promisify(execFile);

/** Normalize raw `agy --version` output into a clean version string. */
function parseVersion(rawOutput) {
    const text = String(rawOutput || '').trim();
    if (!text) return null;
    const match = text.match(/v?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/i);
    if (match) return match[1];
    return text.split(/\r?\n/)[0].trim() || null;
}

/** Parse `agy changelog` output into top version + bounded text. */
function parseChangelog(rawOutput, maxLines = 120) {
    const lines = String(rawOutput || '').replace(/\r\n/g, '\n').split('\n');
    let latestEntryVersion = null;
    for (const line of lines) {
        const m = line.match(/^\s*v?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\s*:/i);
        if (m) {
            latestEntryVersion = m[1];
            break;
        }
    }
    const truncated = lines.length > maxLines;
    const text = lines.slice(0, maxLines).join('\n').trim();
    return { latestEntryVersion, text, truncated, totalLines: lines.length };
}

/** Build ordered OS-specific fallback candidate paths for the `agy` binary. */
function getDefaultAgyCandidates(env = process.env, platformName = process.platform, homeDir = os.homedir()) {
    const candidates = [];
    if (env.AGY_BIN && env.AGY_BIN.trim()) {
        candidates.push({ path: env.AGY_BIN.trim(), source: 'env' });
    }

    if (platformName === 'win32') {
        const localAppData = env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');
        candidates.push(
            { path: path.join(localAppData, 'agy', 'bin', 'agy.exe'), source: 'default-win32' },
            { path: path.join(homeDir, '.local', 'bin', 'agy.exe'), source: 'default-local' },
            { path: path.join(homeDir, '.agy', 'bin', 'agy.exe'), source: 'default-agy' },
        );
    } else {
        candidates.push(
            { path: path.join(homeDir, '.local', 'bin', 'agy'), source: 'default-local' },
            { path: path.join(homeDir, '.agy', 'bin', 'agy'), source: 'default-agy' },
            { path: '/usr/local/bin/agy', source: 'default-usr-local' },
            { path: '/opt/homebrew/bin/agy', source: 'default-homebrew' },
            { path: '/usr/bin/agy', source: 'default-usr' },
        );
    }

    return candidates;
}

/** Create an `agy` manager instance (injectable dependencies for testing). */
function createAgyManager(deps = {}) {
    const execFileAsync = deps.execFileAsync || defaultExecFileAsync;
    const existsSync = deps.existsSync || fs.existsSync;
    const statSync = deps.statSync || fs.statSync;
    const getAppSettings = deps.getSettings || getSettings;
    const env = deps.env || process.env;
    const platformName = deps.platform || process.platform;
    const homeDir = deps.homeDir || os.homedir();

    let updating = false;
    let lastUpdateAt = null;
    let lastUpdateResult = null;
    let cachedStatus = null;

    function isExecutableFile(filePath) {
        if (!filePath || typeof filePath !== 'string' || filePath.includes('\0')) return false;
        try {
            return existsSync(filePath) && statSync(filePath).isFile();
        } catch {
            return false;
        }
    }

    async function resolveFromPathLookup() {
        const locator = platformName === 'win32' ? 'where.exe' : 'which';
        try {
            const { stdout } = await execFileAsync(locator, ['agy'], { timeout: 3000, windowsHide: true });
            const lines = String(stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
            for (const line of lines) {
                if (isExecutableFile(line)) return line;
            }
        } catch {
            // `agy` not on PATH
        }
        return null;
    }

    async function findAgyBinary(customPathOverride) {
        const settings = getAppSettings() || {};
        const configuredPath = typeof customPathOverride === 'string'
            ? customPathOverride.trim()
            : String(settings.agyBinaryPath || '').trim();

        if (configuredPath) {
            if (configuredPath.includes('\0')) {
                return { found: false, path: null, configuredPath, source: 'settings', error: '自定义 agy 路径包含非法字符' };
            }
            if (isExecutableFile(configuredPath)) {
                return { found: true, path: configuredPath, configuredPath, source: 'settings' };
            }
            return {
                found: false,
                path: null,
                configuredPath,
                source: 'settings',
                error: `指定的 agy 可执行文件不存在: ${configuredPath}`,
            };
        }

        for (const candidate of getDefaultAgyCandidates(env, platformName, homeDir)) {
            if (isExecutableFile(candidate.path)) {
                return { found: true, path: candidate.path, configuredPath: '', source: candidate.source };
            }
        }

        const fromPath = await resolveFromPathLookup();
        if (fromPath) {
            return { found: true, path: fromPath, configuredPath: '', source: 'path' };
        }

        return {
            found: false,
            path: null,
            configuredPath: '',
            source: null,
            error: '未检测到 agy CLI，请先安装或手动填写 agy 可执行文件路径',
        };
    }

    async function runAgy(binPath, args, timeoutMs = 15000) {
        return execFileAsync(binPath, args, {
            timeout: timeoutMs,
            windowsHide: true,
            maxBuffer: 2 * 1024 * 1024,
            env: getChildProcessEnv(env),
        });
    }

    async function getAgyStatus({ refresh = true, customPath } = {}) {
        if (!refresh && cachedStatus && !customPath) {
            return { ...cachedStatus, updating, lastUpdateAt, lastUpdateResult };
        }

        const binary = await findAgyBinary(customPath);
        if (!binary.found) {
            const status = {
                found: false,
                path: null,
                configuredPath: binary.configuredPath,
                source: binary.source,
                version: null,
                platform: platformName,
                updating,
                lastUpdateAt,
                lastUpdateResult,
                error: binary.error,
            };
            if (!customPath) cachedStatus = status;
            return status;
        }

        let version = null;
        let versionError = null;
        try {
            const { stdout, stderr } = await runAgy(binary.path, ['--version'], 8000);
            version = parseVersion(`${stdout || ''}\n${stderr || ''}`);
        } catch (err) {
            versionError = err.message;
        }

        const status = {
            found: true,
            path: binary.path,
            configuredPath: binary.configuredPath,
            source: binary.source,
            version,
            platform: platformName,
            updating,
            lastUpdateAt,
            lastUpdateResult,
            ...(versionError ? { error: `读取 agy 版本失败: ${versionError}` } : {}),
        };
        if (!customPath) cachedStatus = status;
        return status;
    }

    async function getAgyChangelog({ customPath, limit = 120 } = {}) {
        const binary = await findAgyBinary(customPath);
        if (!binary.found) {
            return { found: false, error: binary.error, text: '', latestEntryVersion: null, truncated: false, totalLines: 0 };
        }

        const safeLimit = Math.min(Math.max(Number(limit) || 120, 10), 400);
        try {
            const { stdout, stderr } = await runAgy(binary.path, ['changelog'], 12000);
            const parsed = parseChangelog(stdout || stderr || '', safeLimit);
            return { found: true, path: binary.path, ...parsed };
        } catch (err) {
            return {
                found: true,
                path: binary.path,
                error: `读取更新日志失败: ${err.message}`,
                text: '',
                latestEntryVersion: null,
                truncated: false,
                totalLines: 0,
            };
        }
    }

    async function updateAgy({ customPath } = {}) {
        if (updating) {
            return {
                statusCode: 409,
                success: false,
                inProgress: true,
                error: 'agy 正在更新中，请稍候完成后再试',
            };
        }

        const binary = await findAgyBinary(customPath);
        if (!binary.found) {
            return {
                statusCode: 404,
                success: false,
                error: binary.error,
            };
        }

        updating = true;
        let previousVersion = null;
        try {
            try {
                const before = await runAgy(binary.path, ['--version'], 8000);
                previousVersion = parseVersion(`${before.stdout || ''}\n${before.stderr || ''}`);
            } catch {
                // Keep null if --version failed before update
            }

            const { stdout, stderr } = await runAgy(binary.path, ['update'], 180000);
            const output = `${stdout || ''}${stderr ? `\n${stderr}` : ''}`.trim();

            let currentVersion = previousVersion;
            try {
                const after = await runAgy(binary.path, ['--version'], 8000);
                currentVersion = parseVersion(`${after.stdout || ''}\n${after.stderr || ''}`) || previousVersion;
            } catch {
                // Keep best-effort version
            }

            const updated = Boolean(previousVersion && currentVersion && previousVersion !== currentVersion);
            const result = {
                statusCode: 200,
                success: true,
                path: binary.path,
                previousVersion,
                version: currentVersion,
                updated,
                output: output || (updated ? `已更新至 ${currentVersion}` : `当前已是最新版本 (${currentVersion || '未知'})`),
                checkedAt: new Date().toISOString(),
            };

            lastUpdateAt = result.checkedAt;
            lastUpdateResult = {
                success: true,
                previousVersion,
                version: currentVersion,
                updated,
                output: result.output,
            };
            cachedStatus = null;
            return result;
        } catch (err) {
            const detail = [err.message, err.stdout, err.stderr]
                .map((s) => String(s || '').trim())
                .filter(Boolean)
                .join('\n');
            const message = detail || '执行 agy update 失败';
            lastUpdateAt = new Date().toISOString();
            lastUpdateResult = {
                success: false,
                previousVersion,
                version: previousVersion,
                updated: false,
                error: message,
            };
            return {
                statusCode: 500,
                success: false,
                path: binary.path,
                previousVersion,
                version: previousVersion,
                error: message,
            };
        } finally {
            updating = false;
        }
    }

    return {
        findAgyBinary,
        getAgyStatus,
        getAgyChangelog,
        updateAgy,
    };
}

const defaultManager = createAgyManager();

module.exports = {
    createAgyManager,
    parseVersion,
    parseChangelog,
    getDefaultAgyCandidates,
    ...defaultManager,
};
