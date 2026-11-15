// === Cross-Platform OAuth Credential & agy CLI Account Pool ===
// Manages ~/.gemini/oauth_creds.json, ~/.gemini/google_accounts.json, ~/.gemini/accounts/*.json,
// and optional Windows Credential Manager ("gemini:antigravity") sync without ever returning raw tokens.

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { spawn } = require('child_process');

const PS_PATH = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const DEFAULT_SCOPE = 'openid https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email';
const ALIAS_PATTERN = /^[a-zA-Z0-9_\u4e00-\u9fa5-]+$/;
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v1/userinfo';
const CLOUDCODE_MODELS_URL = 'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels';
const CLOUDCODE_LOAD_ASSIST_URL = 'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist';
const DEFAULT_OAUTH_REDIRECT_URI = 'http://localhost:51121/oauth-callback';

const pendingOAuthFlows = new Map(); // state -> { codeVerifier, redirectUri, createdAt }
const quotaCache = new Map(); // alias -> { fetchedAt, ... }
const quotaInFlight = new Map(); // alias -> Promise<summary>

function resolvePaths(opts = {}) {
    const homeDir = opts.homeDir || os.homedir();
    const geminiDir = path.join(homeDir, '.gemini');
    const accountsDir = opts.accountsDir || path.join(geminiDir, 'accounts');
    const altAccountsDir = opts.altAccountsDir || path.join(geminiDir, 'antigravity-cli', 'plugin_data', 'agy-accounts');
    const oauthCredsPath = path.join(geminiDir, 'oauth_creds.json');
    const googleAccountsPath = path.join(geminiDir, 'google_accounts.json');
    const cliTokenPath = path.join(geminiDir, 'antigravity-cli', 'antigravity-oauth-token');
    const jetskiTokenPath = path.join(geminiDir, 'jetski-standalone-oauth-token');
    const ideTokenPath = path.join(geminiDir, 'antigravity', 'antigravity-oauth-token');
    return {
        homeDir,
        geminiDir,
        accountsDir,
        altAccountsDir,
        oauthCredsPath,
        googleAccountsPath,
        cliTokenPath,
        jetskiTokenPath,
        ideTokenPath,
    };
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
    const candidateFiles = [
        oauthData,
        readJsonSafe(paths.jetskiTokenPath),
        readJsonSafe(paths.cliTokenPath),
        readJsonSafe(paths.ideTokenPath),
    ].filter(Boolean);

    const parsedMetas = candidateFiles.map((d) => extractAccountMeta(d)).filter((m) => m.hasAccessToken || m.hasRefreshToken);
    const oauthMeta = oauthData ? extractAccountMeta(oauthData) : null;
    const activeEmail = oauthMeta?.email || googleAccounts?.active || parsedMetas[0]?.email || null;

    // Pick freshest expiry among matching email credentials (agy CLI / LS auto-refreshes standalone token files)
    let bestMeta = oauthMeta;
    for (const m of parsedMetas) {
        if (activeEmail && m.email && m.email.toLowerCase() !== activeEmail.toLowerCase()) continue;
        if (!bestMeta || (!bestMeta.expiry && m.expiry) || (m.expiry && bestMeta.expiry && Date.parse(m.expiry) > Date.parse(bestMeta.expiry))) {
            bestMeta = m;
        }
    }

    return {
        hasCurrentCreds: Boolean(parsedMetas.length > 0),
        activeEmail,
        activeName: bestMeta?.name || oauthMeta?.name || null,
        expiry: bestMeta?.expiry || oauthMeta?.expiry || null,
        isExpired: bestMeta ? bestMeta.isExpired : false,
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
        const cachedQuota = formatCachedQuota(quotaCache.get(acc.alias) || null, false);
        return { ...acc, isActive, quota: cachedQuota };
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
    for (const filePath of [paths.jetskiTokenPath, paths.cliTokenPath, paths.ideTokenPath, paths.oauthCredsPath]) {
        const fileCred = readJsonSafe(filePath);
        if (fileCred) return fileCred;
    }
    return null;
}

function discoverOAuthClientConfig(opts = {}) {
    if (opts.oauthConfig?.clientId && opts.oauthConfig?.clientSecret) {
        return opts.oauthConfig;
    }
    if (process.env.AG_OAUTH_CLIENT_ID && process.env.AG_OAUTH_CLIENT_SECRET) {
        return {
            clientId: process.env.AG_OAUTH_CLIENT_ID.trim(),
            clientSecret: process.env.AG_OAUTH_CLIENT_SECRET.trim(),
        };
    }
    try {
        const { getSettings } = require('./config');
        const settings = getSettings() || {};
        if (settings.oauthClientId && settings.oauthClientSecret) {
            return {
                clientId: String(settings.oauthClientId).trim(),
                clientSecret: String(settings.oauthClientSecret).trim(),
            };
        }
    } catch { /* ignore in isolated tests */ }

    // Best-effort discovery from local 9router/provider registry on VPS if present
    const localRegistryPaths = [
        '/www/wwwroot/9router/app/open-sse/providers/registry/antigravity.js',
    ];
    for (const regPath of localRegistryPaths) {
        try {
            if (!fs.existsSync(regPath)) continue;
            const text = fs.readFileSync(regPath, 'utf8');
            const idMatch = text.match(/clientId\s*:\s*['"]([^'"]+\.apps\.googleusercontent\.com)['"]/);
            const secMatch = text.match(/clientSecret\s*:\s*['"]([^'"]+)['"]/);
            if (idMatch && secMatch) {
                return { clientId: idMatch[1], clientSecret: secMatch[1] };
            }
        } catch { /* ignore */ }
    }
    return null;
}

function httpsJsonRequest(urlString, { method = 'GET', headers = {}, body = null, timeoutMs = 15000 } = {}) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(urlString);
        const req = https.request({
            hostname: parsed.hostname,
            port: parsed.port || 443,
            path: `${parsed.pathname}${parsed.search}`,
            method,
            headers,
            timeout: timeoutMs,
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let json = null;
                try { json = JSON.parse(text); } catch { /* ignore */ }
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve({ status: res.statusCode, data: json ?? text });
                } else {
                    const errMsg = json?.error_description || json?.error?.message || json?.error || `HTTP ${res.statusCode}`;
                    const err = new Error(typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg));
                    err.statusCode = res.statusCode;
                    err.body = json || text;
                    reject(err);
                }
            });
        });
        req.on('timeout', () => req.destroy(new Error('请求超时')));
        req.on('error', reject);
        if (body !== null) req.write(body);
        req.end();
    });
}

async function refreshCredentialObject(raw, opts = {}) {
    const meta = extractAccountMeta(raw);
    const nested = raw.token && typeof raw.token === 'object' ? raw.token : null;
    const refreshToken = nested?.refresh_token || raw.refresh_token;
    if (!refreshToken) return { data: raw, refreshed: false };

    const cfg = discoverOAuthClientConfig(opts);
    if (!cfg) return { data: raw, refreshed: false, reason: 'missing_oauth_client' };

    const form = new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
    }).toString();

    const resp = await httpsJsonRequest(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form,
    });
    const tok = resp.data || {};
    if (!tok.access_token) return { data: raw, refreshed: false };

    const expiresIn = Number(tok.expires_in) || 3599;
    const expiryIso = new Date(Date.now() + expiresIn * 1000).toISOString();
    const expiryMs = Date.now() + expiresIn * 1000;

    if (nested) {
        const updated = {
            ...raw,
            ...(tok.id_token ? { id_token: tok.id_token } : {}),
            token: {
                ...nested,
                access_token: tok.access_token,
                refresh_token: tok.refresh_token || refreshToken,
                token_type: tok.token_type || nested.token_type || 'Bearer',
                expiry: expiryIso,
                expires_in: expiresIn,
            },
        };
        return { data: updated, refreshed: true };
    }

    const updated = {
        ...raw,
        access_token: tok.access_token,
        refresh_token: tok.refresh_token || refreshToken,
        token_type: tok.token_type || raw.token_type || 'Bearer',
        expiry_date: expiryMs,
        ...(tok.id_token ? { id_token: tok.id_token } : {}),
        ...(meta.email ? { email: meta.email, id_token_email: meta.email } : {}),
    };
    return { data: updated, refreshed: true };
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
    let raw = readJsonSafe(found.targetPath);
    normalizeCredentialData(raw);
    let meta = extractAccountMeta(raw);

    // Optional live refresh before writing credentials (skipped in offline unit tests unless requested)
    let tokenRefreshed = false;
    if (opts.refreshIfExpired && meta.isExpired && meta.hasRefreshToken) {
        try {
            const refreshed = await refreshCredentialObject(raw, opts);
            if (refreshed.refreshed) {
                raw = refreshed.data;
                meta = extractAccountMeta(raw);
                tokenRefreshed = true;
                writeSecretJsonFile(found.targetPath, raw);
            }
        } catch { /* non-fatal: still switch with refresh_token so agy/LS can refresh */ }
    }

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

    const platform = opts.platform || process.platform;
    let credManSynced = false;
    let headlessTokenSynced = false;

    if (platform === 'win32' && opts.useCredMan !== false) {
        const writer = opts.writeWindowsCred || defaultWriteWindowsCred;
        try {
            credManSynced = await writer(raw);
        } catch {
            credManSynced = false;
        }
    }

    // Write headless fallback credential files for agy CLI & standalone language_server on Linux/macOS
    if (platform !== 'win32' && opts.syncHeadless !== false) {
        const existingJetski = readJsonSafe(paths.jetskiTokenPath);
        const credBlob = toCredManBlobObject(raw);
        if (existingJetski?.writer_id && !credBlob.writer_id) {
            credBlob.writer_id = existingJetski.writer_id;
        }
        writeSecretJsonFile(paths.cliTokenPath, credBlob);
        writeSecretJsonFile(paths.jetskiTokenPath, credBlob);
        writeSecretJsonFile(paths.ideTokenPath, credBlob);
        headlessTokenSynced = true;
    }

    try {
        require('./agy-manager').invalidateModelsCache();
    } catch { /* ignore in isolated unit tests */ }
    quotaCache.delete(found.cleanAlias);
    quotaInFlight.delete(found.cleanAlias);

    let hubReloaded = false;
    if (opts.reloadHub) {
        try {
            const { hasPm2HubApp, restartManagedIde } = require('./ide-launcher');
            if (await hasPm2HubApp()) {
                await restartManagedIde();
                hubReloaded = true;
            }
        } catch { /* non-fatal */ }
    }

    try {
        const { broadcastAll } = require('./ws');
        broadcastAll({
            type: 'oauth_account_swapped',
            alias: found.cleanAlias,
            email: meta.email,
            hubReloaded,
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
        headlessTokenSynced,
        tokenRefreshed,
        hubReloaded,
    };
}

function isInternalOrNoiseModel(id, info) {
    if (!id) return true;
    if (info?.isInternal) return true;
    if (id.endsWith('-disabled')) return true;
    if (id.startsWith('tab_') || id.startsWith('chat_')) return true;
    return false;
}

function classifyAccountTier({ loadCodeAssist = null, modelsMap = {}, agyModels = [], userStatus = null } = {}) {
    const currentTier = loadCodeAssist?.currentTier || null;
    const paidTier = loadCodeAssist?.paidTier || null;
    const userTier = userStatus?.userTier || null;
    const planInfo = userStatus?.planStatus?.planInfo || null;
    const currentTierId = String(currentTier?.id || '').toLowerCase();
    const paidTierId = String(paidTier?.id || '').toLowerCase();

    const activeTierTexts = [
        currentTier?.id,
        currentTier?.name,
        userTier?.id,
        userTier?.name,
        planInfo?.planName,
        planInfo?.teamsTier,
    ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

    const allTexts = [
        activeTierTexts,
        paidTier?.id,
        paidTier?.name,
        loadCodeAssist?.upgradeSubscriptionType,
    ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

    const activeKeys = [
        ...Object.keys(modelsMap || {}).filter((id) => !isInternalOrNoiseModel(id, modelsMap[id])),
        ...(Array.isArray(agyModels) ? agyModels.map((m) => m.id || '').filter(Boolean) : []),
    ];

    const hasGemini4 = activeKeys.some((id) => /^gemini-4-/i.test(id) || /orchestrator/i.test(id));
    const hasClaude55 = activeKeys.some((id) => /claude-.*-5-5/i.test(id));
    const hasClaude46 = activeKeys.some((id) => /claude-.*-4-6/i.test(id));

    let tierId = 'free';
    let tierLabel = 'Free 基础 (G3.8/C4.6)';

    if (/ultra/.test(activeTierTexts) || (/ultra/.test(paidTierId) && currentTierId !== 'free-tier')) {
        tierId = 'ultra';
        tierLabel = 'AI Ultra';
    } else if (/jio/.test(activeTierTexts)) {
        tierId = 'jio';
        tierLabel = hasGemini4 || hasClaude55 ? 'Jio 合作版 (高配)' : 'Jio 合作版';
    } else if (/pixel/.test(activeTierTexts)) {
        tierId = 'pixel';
        tierLabel = hasGemini4 || hasClaude55 ? 'Pixel 权益版 (高配)' : 'Pixel 权益版';
    } else if (/student/.test(activeTierTexts)) {
        tierId = 'student';
        tierLabel = '学生权益版';
    } else if (hasGemini4 || hasClaude55) {
        tierId = 'pro-full';
        tierLabel = paidTier?.name ? `${paidTier.name} (G4/C5.5)` : 'Pro 高配 (G4/C5.5)';
    } else if (/jio/.test(allTexts)) {
        tierId = 'jio';
        tierLabel = 'Jio 基础版';
    } else if (/pixel/.test(allTexts)) {
        tierId = 'pixel';
        tierLabel = 'Pixel 基础版';
    } else if (currentTierId && currentTierId !== 'free-tier') {
        tierId = currentTierId;
        tierLabel = currentTier?.name || planInfo?.planName || 'Pro';
    } else if (currentTierId === 'free-tier' && !hasGemini4 && !hasClaude55) {
        tierId = 'free';
        tierLabel = hasClaude46 ? 'Free 基础 (G3.8/C4.6)' : 'Free 基础版';
    }

    return {
        tierId,
        tierLabel,
        currentTierId: currentTier?.id || null,
        currentTierName: currentTier?.name || null,
        paidTierId: paidTier?.id || null,
        paidTierName: paidTier?.name || null,
        hasGemini4,
        hasClaude55,
        hasClaude46,
    };
}

async function fetchAccountQuota(alias, opts = {}) {
    const paths = resolvePaths(opts);
    const found = findAccountFile(paths, alias);
    if (!found) {
        throw new Error(`未找到已保存的 OAuth 账号 "${alias}"`);
    }
    let raw = readJsonSafe(found.targetPath);
    normalizeCredentialData(raw);
    let meta = extractAccountMeta(raw);

    if (meta.isExpired || !meta.hasAccessToken) {
        const refreshed = await refreshCredentialObject(raw, opts);
        if (refreshed.refreshed) {
            raw = refreshed.data;
            meta = extractAccountMeta(raw);
            writeSecretJsonFile(found.targetPath, raw);
        }
    }

    const accessToken = raw.token?.access_token || raw.access_token;
    if (!accessToken) {
        throw new Error(`账号 "${alias}" 缺少可用 access_token`);
    }

    const reqHeaders = {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'antigravity/1.15.8 linux/amd64',
    };

    const [modelsResult, lcaResult] = await Promise.allSettled([
        httpsJsonRequest(CLOUDCODE_MODELS_URL, {
            method: 'POST',
            headers: reqHeaders,
            body: JSON.stringify({}),
            timeoutMs: 12000,
        }),
        httpsJsonRequest(CLOUDCODE_LOAD_ASSIST_URL, {
            method: 'POST',
            headers: reqHeaders,
            body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } }),
            timeoutMs: 12000,
        }),
    ]);

    const modelsResp = modelsResult.status === 'fulfilled' ? modelsResult.value : null;
    if (!modelsResp) {
        throw modelsResult.reason || new Error('获取 CloudCode 模型失败');
    }
    const lcaData = lcaResult.status === 'fulfilled' ? lcaResult.value?.data || null : null;

    const rawModelsMap = modelsResp.data?.models && typeof modelsResp.data.models === 'object' ? modelsResp.data.models : {};
    const filteredEntries = Object.entries(rawModelsMap).filter(([id, info]) => !isInternalOrNoiseModel(id, info));

    const models = filteredEntries.map(([id, info]) => {
        const qi = info?.quotaInfo || {};
        const frac = typeof qi.remainingFraction === 'number' ? qi.remainingFraction : null;
        return {
            modelId: id,
            displayName: info?.displayName || id,
            remainingFraction: frac,
            resetTime: qi.resetTime || null,
            recommended: !!info?.recommended,
            supportsImages: !!info?.supportsImages,
            supportsThinking: !!info?.supportsThinking,
            modelPlaceholder: info?.model || null,
        };
    });

    const withQuota = models.filter((m) => typeof m.remainingFraction === 'number');
    const avgQuota = withQuota.length
        ? Math.round((withQuota.reduce((s, m) => s + m.remainingFraction, 0) / withQuota.length) * 100) / 100
        : null;
    const minQuota = withQuota.length
        ? Math.min(...withQuota.map((m) => m.remainingFraction))
        : null;
    const exhaustedCount = withQuota.filter((m) => m.remainingFraction <= 0.01).length;

    const tierInfo = classifyAccountTier({
        loadCodeAssist: lcaData,
        modelsMap: rawModelsMap,
    });

    const summary = {
        alias: found.cleanAlias,
        email: meta.email,
        fetchedAt: new Date().toISOString(),
        avgQuota,
        minQuota,
        exhaustedCount,
        totalModels: models.length,
        tierId: tierInfo.tierId,
        tierLabel: tierInfo.tierLabel,
        tierInfo,
        models: models.slice(0, 32),
    };
    quotaCache.set(found.cleanAlias, { ...summary, rawModelsMap });
    return opts.includeRaw ? { ...summary, rawModelsMap } : summary;
}

function formatCachedQuota(cached, includeRaw) {
    if (!cached) return null;
    if (includeRaw) return cached;
    const { rawModelsMap: _raw, models: _models, ...clean } = cached;
    return clean;
}

async function getActiveAccountQuotaSummary({ forceRefresh = false, includeRaw = true } = {}, opts = {}) {
    const overview = listOAuthAccounts(opts);
    const activeAcc = (overview.accounts || []).find((a) => a.isActive);
    if (!activeAcc) return null;
    const cached = !forceRefresh ? quotaCache.get(activeAcc.alias) : null;
    const ageMs = cached ? (Date.now() - Date.parse(cached.fetchedAt || 0)) : Infinity;
    const runRefresh = () => {
        const canCoalesce = !opts || Object.keys(opts).length === 0;
        if (canCoalesce && quotaInFlight.has(activeAcc.alias)) {
            return quotaInFlight.get(activeAcc.alias);
        }
        const p = fetchAccountQuota(activeAcc.alias, { ...opts, includeRaw: true })
            .finally(() => { if (canCoalesce) quotaInFlight.delete(activeAcc.alias); });
        if (canCoalesce) quotaInFlight.set(activeAcc.alias, p);
        return p;
    };

    if (cached && Number.isFinite(ageMs)) {
        if (ageMs < 60000) {
            return formatCachedQuota(cached, includeRaw);
        }
        // Serve stale quota up to 30 min immediately while refreshing in the background
        if (ageMs < 1800000) {
            runRefresh().catch(() => {});
            return formatCachedQuota(cached, includeRaw);
        }
    }
    try {
        const fresh = await runRefresh();
        return formatCachedQuota(fresh, includeRaw);
    } catch {
        return formatCachedQuota(cached, includeRaw);
    }
}

async function rotateOAuthAccount(opts = {}) {
    const overview = listOAuthAccounts(opts);
    const accounts = overview.accounts || [];
    if (accounts.length < 2) {
        throw new Error('已保存账号不足 2 个，无法自动轮转切换');
    }
    const currentIdx = accounts.findIndex((a) => a.isActive);
    const ordered = currentIdx >= 0
        ? [...accounts.slice(currentIdx + 1), ...accounts.slice(0, currentIdx)]
        : accounts;

    // Prefer an account whose cached quota is not exhausted and has a refresh token
    const candidate = ordered.find((a) => {
        const q = quotaCache.get(a.alias);
        if (q && q.avgQuota !== null && q.avgQuota <= 0.02) return false;
        return a.hasRefreshToken || !a.isExpired;
    }) || ordered[0];

    const switchResult = await useOAuthAccount(candidate.alias, {
        ...opts,
        refreshIfExpired: true,
        reloadHub: opts.reloadHub !== false,
    });
    return { rotated: true, previousAlias: overview.activeAlias, ...switchResult };
}

function startWebOAuthFlow({ redirectUri } = {}, opts = {}) {
    const cfg = discoverOAuthClientConfig(opts);
    if (!cfg) {
        throw new Error('未配置 Google OAuth 客户端凭据（可在环境变量 AG_OAUTH_CLIENT_ID / AG_OAUTH_CLIENT_SECRET 或 settings.json 中配置）');
    }
    const finalRedirect = (redirectUri && String(redirectUri).trim()) || DEFAULT_OAUTH_REDIRECT_URI;
    const state = crypto.randomBytes(18).toString('hex');
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

    // Prune flows older than 20 minutes
    const cutoff = Date.now() - 20 * 60 * 1000;
    for (const [k, v] of pendingOAuthFlows.entries()) {
        if (v.createdAt < cutoff) pendingOAuthFlows.delete(k);
    }

    pendingOAuthFlows.set(state, {
        codeVerifier,
        redirectUri: finalRedirect,
        createdAt: Date.now(),
    });

    const params = new URLSearchParams({
        client_id: cfg.clientId,
        redirect_uri: finalRedirect,
        response_type: 'code',
        scope: `${DEFAULT_SCOPE} https://www.googleapis.com/auth/cclog https://www.googleapis.com/auth/experimentsandconfigs`,
        access_type: 'offline',
        prompt: 'consent',
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
    });

    return {
        authUrl: `${GOOGLE_AUTH_URL}?${params.toString()}`,
        redirectUri: finalRedirect,
        state,
    };
}

async function completeWebOAuthFlow({ callbackUrl, code, state, alias, activate = true } = {}, opts = {}) {
    const cfg = discoverOAuthClientConfig(opts);
    if (!cfg) {
        throw new Error('未配置 Google OAuth 客户端凭据');
    }

    let authCode = code ? String(code).trim() : '';
    let authState = state ? String(state).trim() : '';

    if (callbackUrl && String(callbackUrl).trim()) {
        const rawInput = String(callbackUrl).trim();
        let parsed;
        try {
            parsed = new URL(rawInput);
        } catch {
            throw new Error('回调链接格式无效，请粘贴浏览器地址栏中完整的 http://localhost... 链接');
        }
        const errParam = parsed.searchParams.get('error');
        if (errParam) {
            throw new Error(`Google 授权失败: ${errParam}`);
        }
        authCode = parsed.searchParams.get('code') || authCode;
        authState = parsed.searchParams.get('state') || authState;
    }

    if (!authCode) {
        throw new Error('回调链接中缺少授权 code');
    }

    const flow = authState ? pendingOAuthFlows.get(authState) : null;
    if (authState && !flow) {
        throw new Error('授权会话已过期或无效，请重新生成登录链接');
    }
    if (authState) pendingOAuthFlows.delete(authState);

    const form = new URLSearchParams({
        code: authCode,
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        redirect_uri: flow?.redirectUri || DEFAULT_OAUTH_REDIRECT_URI,
        grant_type: 'authorization_code',
        ...(flow?.codeVerifier ? { code_verifier: flow.codeVerifier } : {}),
    }).toString();

    const tokResp = await httpsJsonRequest(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form,
    });
    const tok = tokResp.data || {};
    if (!tok.access_token) {
        throw new Error('Google 未返回 access_token');
    }

    let userInfo = {};
    try {
        const uiResp = await httpsJsonRequest(GOOGLE_USERINFO_URL, {
            headers: { Authorization: `Bearer ${tok.access_token}` },
        });
        userInfo = uiResp.data || {};
    } catch { /* fallback to id_token claims */ }

    const claims = decodeJwtPayload(tok.id_token);
    const email = userInfo.email || claims.email || null;
    const expiresIn = Number(tok.expires_in) || 3599;
    const expiryIso = new Date(Date.now() + expiresIn * 1000).toISOString();

    const credObj = {
        token: {
            access_token: tok.access_token,
            refresh_token: tok.refresh_token || '',
            token_type: tok.token_type || 'Bearer',
            expiry: expiryIso,
            expires_in: expiresIn,
        },
        auth_method: 'consumer',
        ...(tok.id_token ? { id_token: tok.id_token } : {}),
        ...(email ? { id_token_email: email } : {}),
    };

    return importOAuthAccount({
        alias,
        credentialJson: credObj,
        force: true,
        activate: Boolean(activate),
    }, {
        ...opts,
        reloadHub: activate && opts.reloadHub !== false,
    });
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
    fetchAccountQuota,
    getActiveAccountQuotaSummary,
    classifyAccountTier,
    isInternalOrNoiseModel,
    rotateOAuthAccount,
    startWebOAuthFlow,
    completeWebOAuthFlow,
    refreshCredentialObject,
};
