// === Dynamic Auth Key Manager ===
// Single source of truth for AUTH_KEY across HTTP middleware and all WebSocket servers.
// Supports runtime password changes synced to .auth-key and PM2 ecosystem.config.cjs.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');
const AUTH_KEY_FILE = path.join(ROOT_DIR, '.auth-key');
const ECOSYSTEM_FILE = path.join(ROOT_DIR, 'ecosystem.config.cjs');

function getAuthKeyFile() {
    return process.env.AG_AUTH_KEY_FILE || AUTH_KEY_FILE;
}

function getEcosystemFile() {
    return process.env.AG_ECOSYSTEM_FILE || ECOSYSTEM_FILE;
}

let cachedNoAuth = null;

function isNoAuthMode() {
    if (cachedNoAuth === null) {
        cachedNoAuth = process.argv.includes('--no-auth');
    }
    return cachedNoAuth;
}

function readAuthKeyFile() {
    try {
        const keyFile = getAuthKeyFile();
        if (fs.existsSync(keyFile)) {
            const val = fs.readFileSync(keyFile, 'utf8').trim();
            if (val) return val;
        }
    } catch { /* ignore */ }
    return '';
}

function getEffectiveAuthKey() {
    if (isNoAuthMode()) return '';
    // Prefer runtime-updated env var if set; fall back to .auth-key file
    const envKey = (process.env.AUTH_KEY || '').trim();
    const fileKey = readAuthKeyFile();
    return envKey || fileKey || '';
}

function verifyAuthKey(candidate) {
    const active = getEffectiveAuthKey();
    if (!active) return true;
    if (typeof candidate !== 'string' || !candidate) return false;
    const trimmed = candidate.trim();
    if (trimmed.length !== active.length) return false;
    try {
        return crypto.timingSafeEqual(Buffer.from(trimmed), Buffer.from(active));
    } catch {
        return false;
    }
}

function syncStartupAuthKey() {
    if (isNoAuthMode()) return '';
    const fileKey = readAuthKeyFile();
    if (fileKey) {
        process.env.AUTH_KEY = fileKey;
        return fileKey;
    }
    return (process.env.AUTH_KEY || '').trim();
}

function setCustomAuthKey(newKeyInput, { currentKey } = {}) {
    if (isNoAuthMode()) {
        throw new Error('当前处于 --no-auth 本地免密模式，无法修改密钥');
    }
    const active = getEffectiveAuthKey();
    if (active && currentKey !== undefined && !verifyAuthKey(String(currentKey))) {
        const err = new Error('当前密钥验证失败');
        err.statusCode = 403;
        throw err;
    }

    if (typeof newKeyInput !== 'string') {
        throw new Error('新密码必须是字符串');
    }
    const nextKey = newKeyInput.trim();
    if (nextKey.length < 4 || nextKey.length > 128) {
        throw new Error('新密码长度需在 4 到 128 个字符之间');
    }
    if (/[\r\n\0]/.test(nextKey)) {
        throw new Error('新密码不能包含换行或空字符');
    }

    const keyFile = getAuthKeyFile();
    const ecosystemFile = getEcosystemFile();
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    const tmpPath = `${keyFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, `${nextKey}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpPath, keyFile);
    if (process.platform !== 'win32') {
        try { fs.chmodSync(keyFile, 0o600); } catch { /* ignore */ }
    }

    process.env.AUTH_KEY = nextKey;

    // Best-effort sync to ecosystem.config.cjs so PM2 reloads keep the updated password
    try {
        if (fs.existsSync(ecosystemFile)) {
            const raw = fs.readFileSync(ecosystemFile, 'utf8');
            const replaced = raw.replace(
                /(AUTH_KEY\s*:\s*['"])([^'"]*)(['"])/,
                (_, prefix, _old, suffix) => `${prefix}${nextKey.replace(/['\\]/g, '\\$&')}${suffix}`
            );
            if (replaced !== raw) {
                fs.writeFileSync(ecosystemFile, replaced, 'utf8');
            }
        }
    } catch { /* non-fatal */ }

    return { updated: true, keyLength: nextKey.length };
}

module.exports = {
    AUTH_KEY_FILE,
    getEffectiveAuthKey,
    verifyAuthKey,
    syncStartupAuthKey,
    setCustomAuthKey,
};
