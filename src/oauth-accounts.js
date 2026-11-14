// === Cross-Platform OAuth Credential & agy CLI Account Pool ===
// Manages ~/.gemini/oauth_creds.json, ~/.gemini/google_accounts.json, ~/.gemini/accounts/*.json,
// and optional Windows Credential Manager ("gemini:antigravity") sync without ever returning raw tokens.

const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PS_PATH = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const DEFAULT_SCOPE = 'openid https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email';
const ALIAS_PATTERN = /^[a-zA-Z0-9_\u4e00-\u9fa5-]+$/;

function resolvePaths(opts = {}) {
    const homeDir = opts.homeDir || os.homedir();
    const geminiDir = path.join(homeDir, '.gemini');
    const accountsDir = opts.accountsDir || path.join(geminiDir, 'accounts');
    const altAccountsDir = opts.altAccountsDir || path.join(geminiDir, 'antigravity-cli', 'plugin_data', 'agy-accounts');
    const oauthCredsPath = path.join(geminiDir, 'oauth_creds.json');
    const googleAccountsPath = path.join(geminiDir, 'google_accounts.json');
    return { homeDir, geminiDir, accountsDir, altAccountsDir, oauthCredsPath, googleAccountsPath };
}

function validateAlias(alias) {
    if (!alias || typeof alias !== 'string') {
        throw new Error('账号别名不能为空');
    }
    const trimmed = alias.trim();
    if (!trimmed || trimmed.length > 50 || trimmed === '.' || trimmed === '..') {
        throw new Error('账号别名长度需在 1-50 个字符之间');
    }
    if (!ALIAS_PATTERN.test(trimmed)) {
        throw new Error('账号别名仅支持字母、数字、下划线、连字符和中文');
    }
    return trimmed;
}

function safeJoinAlias(dir, alias) {
    const cleanAlias = validateAlias(alias);
    const resolvedDir = path.resolve(dir);
    const targetPath = path.resolve(resolvedDir, `${cleanAlias}.json`);
    if (!targetPath.startsWith(resolvedDir + path.sep)) {
        throw new Error('非法的账号路径');
    }
    return { cleanAlias, targetPath };
}

function decodeJwtPayload(token) {
    if (!token || typeof token !== 'string') return {};
    try {
        const parts = token.split('.');
        if (parts.length < 2) return {};
        const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
        const json = Buffer.from(padded, 'base64').toString('utf8');
        return JSON.parse(json);
    } catch {
        return {};
    }
}

function normalizeCredentialData(rawInput) {
    let data = rawInput;
    if (typeof rawInput === 'string') {
        try {
            data = JSON.parse(rawInput);
        } catch {
            throw new Error('凭据内容不是合法的 JSON 格式');
        }
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('凭据 JSON 必须是一个对象');
    }
    const nested = data.token && typeof data.token === 'object' ? data.token : null;
    const accessToken = nested?.access_token ?? data.access_token ?? '';
    const refreshToken = nested?.refresh_token ?? data.refresh_token ?? '';
    if (!accessToken && !refreshToken) {
        throw new Error('凭据 JSON 缺少 access_token 或 refresh_token');
    }
    return data;
}

function extractAccountMeta(rawInput) {
    let data = rawInput;
    if (typeof rawInput === 'string') {
        try {
            data = JSON.parse(rawInput);
        } catch {
            return {
                email: null,
                name: null,
                expiry: null,
                isExpired: false,
                authMethod: 'unknown',
                format: 'unknown',
                hasRefreshToken: false,
                hasAccessToken: false,
            };
        }
    }
    if (!data || typeof data !== 'object') {
        return {
            email: null,
            name: null,
            expiry: null,
            isExpired: false,
            authMethod: 'unknown',
            format: 'unknown',
            hasRefreshToken: false,
            hasAccessToken: false,
        };
    }

    const nested = data.token && typeof data.token === 'object' ? data.token : null;
    const claims = decodeJwtPayload(data.id_token);
    const email = claims.email || data.id_token_email || data.email || data.user_email || null;
    const name = claims.name || data.name || (email ? email.split('@')[0] : null);

    let expiryIso = null;
    let expiryMs = null;
    if (nested?.expiry) {
        const parsed = Date.parse(nested.expiry);
        if (!Number.isNaN(parsed)) {
            expiryMs = parsed;
            expiryIso = new Date(parsed).toISOString();
        }
    } else if (typeof data.expiry_date === 'number' && Number.isFinite(data.expiry_date)) {
        expiryMs = data.expiry_date;
        expiryIso = new Date(data.expiry_date).toISOString();
    } else if (typeof data.expiry === 'string') {
        const parsed = Date.parse(data.expiry);
        if (!Number.isNaN(parsed)) {
            expiryMs = parsed;
            expiryIso = new Date(parsed).toISOString();
        }
    }

    const hasAccessToken = Boolean(nested?.access_token || data.access_token);
    const hasRefreshToken = Boolean(nested?.refresh_token || data.refresh_token);

    return {
        email,
        name,
        expiry: expiryIso,
        isExpired: expiryMs !== null ? Date.now() > expiryMs : false,
        authMethod: data.auth_method || (nested ? 'consumer' : 'oauth'),
        format: nested ? 'agy-cred' : 'oauth-creds',
        hasRefreshToken,
        hasAccessToken,
    };
}

function toOAuthCredsObject(data, existing = {}) {
    const nested = data.token && typeof data.token === 'object' ? data.token : null;
    const meta = extractAccountMeta(data);
    const out = { ...existing };

    const accessToken = nested?.access_token ?? data.access_token;
    const refreshToken = nested?.refresh_token ?? data.refresh_token;
    const tokenType = nested?.token_type ?? data.token_type ?? 'Bearer';

    if (accessToken !== undefined) out.access_token = accessToken;
    if (refreshToken !== undefined) out.refresh_token = refreshToken;
    if (data.id_token) {
        out.id_token = data.id_token;
    } else {
        delete out.id_token;
    }
    if (meta.email) {
        out.id_token_email = meta.email;
        out.email = meta.email;
    }
    out.token_type = tokenType;
    if (meta.expiry) {
        out.expiry_date = Date.parse(meta.expiry);
    }
    if (!out.scope) {
        out.scope = data.scope || DEFAULT_SCOPE;
    }
    return out;
}

function toCredManBlobObject(data) {
    if (data.token && typeof data.token === 'object') {
        return data;
    }
    const meta = extractAccountMeta(data);
    return {
        token: {
            access_token: data.access_token || '',
            refresh_token: data.refresh_token || '',
            token_type: data.token_type || 'Bearer',
            ...(meta.expiry ? { expiry: meta.expiry } : {}),
        },
        auth_method: data.auth_method || 'consumer',
        ...(data.id_token ? { id_token: data.id_token } : {}),
        ...(meta.email ? { id_token_email: meta.email } : {}),
    };
}

function writeSecretJsonFile(filePath, contentObj) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const serialized = typeof contentObj === 'string' ? contentObj : JSON.stringify(contentObj, null, 2);
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, serialized, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
    if (process.platform !== 'win32') {
        try { fs.chmodSync(filePath, 0o600); } catch { /* ignore */ }
    }
}

function readJsonSafe(filePath) {
    if (!fs.existsSync(filePath)) return null;
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return null;
    }
}

function runPowerShellStdin(script, stdinText = null, timeoutMs = 8000) {
    return new Promise((resolve) => {
        if (!fs.existsSync(PS_PATH)) {
            return resolve({ ok: false, stdout: '' });
        }
        const child = spawn(PS_PATH, ['-NoProfile', '-NonInteractive', '-Command', script], {
            windowsHide: true,
        });
        let stdout = '';
        let settled = false;
        const timer = setTimeout(() => {
            if (!settled) {
                settled = true;
                try { child.kill(); } catch { /* ignore */ }
                resolve({ ok: false, stdout: '' });
            }
        }, timeoutMs);

        child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
        child.on('error', () => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve({ ok: false, stdout: '' });
            }
        });
        child.on('close', (code) => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve({ ok: code === 0, stdout });
            }
        });

        if (stdinText !== null) {
            child.stdin.write(stdinText, 'utf8');
        }
        child.stdin.end();
    });
}

// Inline C# Advapi32 helper executed cleanly without secrets in CLI args
const WIN_CRED_CS = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class AgyCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags;
    public uint Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredRead(string target, uint type, int reservedFlag, out IntPtr credentialPtr);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredWrite(ref CREDENTIAL userCredential, uint flags);
  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern void CredFree(IntPtr buffer);

  public static string Read(string target) {
    IntPtr ptr;
    if (!CredRead(target, 1, 0, out ptr)) return "";
    try {
      var cred = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
      if (cred.CredentialBlob == IntPtr.Zero || cred.CredentialBlobSize == 0) return "";
      byte[] bytes = new byte[cred.CredentialBlobSize];
      Marshal.Copy(cred.CredentialBlob, bytes, 0, (int)cred.CredentialBlobSize);
      return Encoding.UTF8.GetString(bytes);
    } finally { CredFree(ptr); }
  }

  public static bool Write(string target, string user, string secret) {
    byte[] bytes = Encoding.UTF8.GetBytes(secret);
    IntPtr buf = Marshal.AllocCoTaskMem(bytes.Length);
    try {
      Marshal.Copy(bytes, 0, buf, bytes.Length);
      var cred = new CREDENTIAL();
      cred.Type = 1;
      cred.TargetName = target;
      cred.UserName = user;
      cred.Persist = 2;
      cred.CredentialBlobSize = (uint)bytes.Length;
      cred.CredentialBlob = buf;
      return CredWrite(ref cred, 0);
    } finally { Marshal.FreeCoTaskMem(buf); }
  }
}
"@
`;

async function defaultReadWindowsCred() {
    if (process.platform !== 'win32') return null;
    const script = `${WIN_CRED_CS}\n[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n[AgyCred]::Read('gemini:antigravity')`;
    const res = await runPowerShellStdin(script);
    if (!res.ok || !res.stdout.trim()) return null;
    try {
        return JSON.parse(res.stdout.trim());
    } catch {
        return null;
    }
}

async function defaultWriteWindowsCred(blobObj) {
    if (process.platform !== 'win32') return false;
    const secretStr = JSON.stringify(toCredManBlobObject(blobObj));
    const script = `${WIN_CRED_CS}\n$raw = [Console]::In.ReadToEnd()\nif ([AgyCred]::Write('gemini:antigravity', 'antigravity', $raw)) { 'OK' } else { exit 1 }`;
    const res = await runPowerShellStdin(script, secretStr);
    return res.ok && res.stdout.includes('OK');
}

function generateAutoAlias(email, existingAliases = []) {
    const local = email && email.includes('@') ? email.split('@')[0] : 'account';
    const base = local.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]/g, '-').slice(0, 30) || 'account';
    const set = new Set(existingAliases);
    if (!set.has(base)) return base;
    let i = 2;
    while (set.has(`${base}_${i}`)) i++;
    return `${base}_${i}`;
}

function listAccountFiles(paths) {
    const found = new Map();
    for (const { dir, source } of [
        { dir: paths.accountsDir, source: 'accounts' },
        { dir: paths.altAccountsDir, source: 'plugin' },
    ]) {
        if (!fs.existsSync(dir)) continue;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const ent of entries) {
            if (!ent.isFile() || !ent.name.endsWith('.json')) continue;
            const alias = ent.name.slice(0, -5);
            if (!ALIAS_PATTERN.test(alias) || found.has(alias)) continue;
            const fullPath = path.join(dir, ent.name);
            try {
                const raw = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
                const stat = fs.statSync(fullPath);
                const meta = extractAccountMeta(raw);
                found.set(alias, {
                    alias,
                    source,
                    updatedAt: stat.mtime.toISOString(),
                    ...meta,
                });
            } catch {
                // Skip unreadable/corrupt file safely
            }
        }
    }
    return Array.from(found.values()).sort((a, b) => a.alias.localeCompare(b.alias));
}

function getCurrentOAuthStatusSync(opts = {}) {
    const paths = resolvePaths(opts);
    const oauthData = readJsonSafe(paths.oauthCredsPath);
    const googleAccounts = readJsonSafe(paths.googleAccountsPath);
    const oauthMeta = oauthData ? extractAccountMeta(oauthData) : null;
    const activeEmail = oauthMeta?.email || googleAccounts?.active || null;
    return {
        hasCurrentCreds: Boolean(oauthData && (oauthMeta?.hasAccessToken || oauthMeta?.hasRefreshToken)),
        activeEmail,
        activeName: oauthMeta?.name || null,
        expiry: oauthMeta?.expiry || null,
        isExpired: oauthMeta?.isExpired || false,
        oauthCredsExists: fs.existsSync(paths.oauthCredsPath),
        accountsDirExists: fs.existsSync(paths.accountsDir),
    };
}

function listOAuthAccounts(opts = {}) {
    const paths = resolvePaths(opts);
    const status = getCurrentOAuthStatusSync(opts);
    const accounts = listAccountFiles(paths);
    let activeAlias = null;
    const activeLower = status.activeEmail ? status.activeEmail.toLowerCase() : null;
    const enriched = accounts.map((acc) => {
        const isActive = Boolean(activeLower && acc.email && acc.email.toLowerCase() === activeLower);
        if (isActive && !activeAlias) activeAlias = acc.alias;
        return { ...acc, isActive };
    });
    return {
        ...status,
        activeAlias,
        accounts: enriched,
    };
}

function findAccountFile(paths, alias) {
    const { cleanAlias, targetPath } = safeJoinAlias(paths.accountsDir, alias);
    if (fs.existsSync(targetPath)) return { cleanAlias, targetPath };
    const { targetPath: altPath } = safeJoinAlias(paths.altAccountsDir, cleanAlias);
    if (fs.existsSync(altPath)) return { cleanAlias, targetPath: altPath };
    return null;
}

async function readActiveCredentialObject(opts = {}) {
    const paths = resolvePaths(opts);
    const platform = opts.platform || process.platform;
    if (platform === 'win32' && opts.useCredMan !== false) {
        const reader = opts.readWindowsCred || defaultReadWindowsCred;
        const winCred = await reader();
        if (winCred) return winCred;
    }
    const fileCred = readJsonSafe(paths.oauthCredsPath);
    if (fileCred) return fileCred;
    return null;
}

async function saveCurrentOAuthAccount(aliasInput, { force = false } = {}, opts = {}) {
    const paths = resolvePaths(opts);
    const current = await readActiveCredentialObject(opts);
    if (!current) {
        throw new Error('未检测到当前活跃 OAuth 凭据（~/.gemini/oauth_creds.json 或系统凭据为空），请先登录或使用 JSON 导入');
    }
    normalizeCredentialData(current);
    const meta = extractAccountMeta(current);
    const existingList = listAccountFiles(paths);
    const alias = aliasInput
        ? validateAlias(aliasInput)
        : generateAutoAlias(meta.email, existingList.map((a) => a.alias));

    if (!force && meta.email) {
        const dup = existingList.find((a) => a.email && a.email.toLowerCase() === meta.email.toLowerCase() && a.alias !== alias);
        if (dup) {
            throw new Error(`账号 "${meta.email}" 已保存为 "${dup.alias}"（如需强制另存请开启覆盖选项）`);
        }
    }

    const { targetPath } = safeJoinAlias(paths.accountsDir, alias);
    if (!force && fs.existsSync(targetPath)) {
        throw new Error(`账号别名 "${alias}" 已存在`);
    }

    writeSecretJsonFile(targetPath, current);
    return {
        saved: true,
        alias,
        account: {
            alias,
            source: 'accounts',
            updatedAt: new Date().toISOString(),
            ...meta,
            isActive: true,
        },
    };
}

async function useOAuthAccount(targetAlias, opts = {}) {
    const paths = resolvePaths(opts);
    const found = findAccountFile(paths, targetAlias);
    if (!found) {
        throw new Error(`未找到已保存的 OAuth 账号 "${targetAlias}"`);
    }
    const raw = readJsonSafe(found.targetPath);
    normalizeCredentialData(raw);
    const meta = extractAccountMeta(raw);

    const existingOAuth = readJsonSafe(paths.oauthCredsPath) || {};
    const nextOAuth = toOAuthCredsObject(raw, existingOAuth);
    writeSecretJsonFile(paths.oauthCredsPath, nextOAuth);

    const googleAccounts = readJsonSafe(paths.googleAccountsPath) || { active: null, old: [] };
    const oldSet = new Set(Array.isArray(googleAccounts.old) ? googleAccounts.old : []);
    if (googleAccounts.active && googleAccounts.active !== meta.email) {
        oldSet.add(googleAccounts.active);
    }
    if (meta.email) oldSet.delete(meta.email);
    writeSecretJsonFile(paths.googleAccountsPath, {
        active: meta.email || googleAccounts.active || null,
        old: Array.from(oldSet),
    });

    let credManSynced = false;
    const platform = opts.platform || process.platform;
    if (platform === 'win32' && opts.useCredMan !== false) {
        const writer = opts.writeWindowsCred || defaultWriteWindowsCred;
        try {
            credManSynced = await writer(raw);
        } catch {
            credManSynced = false;
        }
    }

    try {
        const { broadcastAll } = require('./ws');
        broadcastAll({
            type: 'oauth_account_swapped',
            alias: found.cleanAlias,
            email: meta.email,
        });
    } catch { /* ws server may not be initialized in tests */ }

    return {
        success: true,
        alias: found.cleanAlias,
        email: meta.email,
        name: meta.name,
        format: meta.format,
        oauthSynced: true,
        credManSynced,
    };
}

async function importOAuthAccount({ alias, credentialJson, force = false, activate = false } = {}, opts = {}) {
    const paths = resolvePaths(opts);
    const parsed = normalizeCredentialData(credentialJson);
    const meta = extractAccountMeta(parsed);
    const existingList = listAccountFiles(paths);

    const finalAlias = alias && String(alias).trim()
        ? validateAlias(alias)
        : generateAutoAlias(meta.email, existingList.map((a) => a.alias));

    const { targetPath } = safeJoinAlias(paths.accountsDir, finalAlias);
    if (!force && fs.existsSync(targetPath)) {
        throw new Error(`账号别名 "${finalAlias}" 已存在`);
    }
    if (!force && meta.email) {
        const dup = existingList.find((a) => a.email && a.email.toLowerCase() === meta.email.toLowerCase() && a.alias !== finalAlias);
        if (dup) {
            throw new Error(`账号 "${meta.email}" 已保存为 "${dup.alias}"（如需多别名保存请开启覆盖）`);
        }
    }

    writeSecretJsonFile(targetPath, parsed);

    let switched = null;
    if (activate) {
        switched = await useOAuthAccount(finalAlias, opts);
    }

    return {
        imported: true,
        alias: finalAlias,
        activated: Boolean(activate),
        switchResult: switched,
        account: {
            alias: finalAlias,
            source: 'accounts',
            updatedAt: new Date().toISOString(),
            ...meta,
            isActive: Boolean(activate),
        },
    };
}

function renameOAuthAccount(oldAlias, newAliasInput, opts = {}) {
    const paths = resolvePaths(opts);
    const found = findAccountFile(paths, oldAlias);
    if (!found) {
        throw new Error(`未找到已保存的 OAuth 账号 "${oldAlias}"`);
    }
    const { cleanAlias: newAlias, targetPath: dstPath } = safeJoinAlias(paths.accountsDir, newAliasInput);
    if (found.cleanAlias === newAlias) {
        throw new Error('新别名不能与原别名相同');
    }
    if (fs.existsSync(dstPath)) {
        throw new Error(`目标别名 "${newAlias}" 已存在`);
    }
    fs.mkdirSync(paths.accountsDir, { recursive: true });
    if (path.dirname(found.targetPath) === path.resolve(paths.accountsDir)) {
        fs.renameSync(found.targetPath, dstPath);
    } else {
        fs.copyFileSync(found.targetPath, dstPath);
        fs.rmSync(found.targetPath, { force: true });
    }
    return { renamed: true, oldAlias: found.cleanAlias, newAlias };
}

function deleteOAuthAccount(alias, opts = {}) {
    const paths = resolvePaths(opts);
    const found = findAccountFile(paths, alias);
    if (!found) {
        throw new Error(`未找到已保存的 OAuth 账号 "${alias}"`);
    }
    fs.rmSync(found.targetPath, { force: true });
    return { deleted: true, alias: found.cleanAlias };
}

module.exports = {
    validateAlias,
    extractAccountMeta,
    normalizeCredentialData,
    toOAuthCredsObject,
    toCredManBlobObject,
    listOAuthAccounts,
    saveCurrentOAuthAccount,
    useOAuthAccount,
    importOAuthAccount,
    renameOAuthAccount,
    deleteOAuthAccount,
};
