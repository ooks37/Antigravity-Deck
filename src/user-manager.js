// === Pure Node.js Multi-User Auth, Session & Conversation Ownership Store ===
// Backed by Node 22+ built-in `node:sqlite` + scrypt password hashing + opaque SHA-256 session tokens.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { getEffectiveAuthKey } = require('./auth-manager');

const ROOT_DIR = path.join(__dirname, '..');
const DEFAULT_DB_PATH = path.join(ROOT_DIR, 'data', 'deck.db');
const SESSION_COOKIE_NAME = 'ag_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const USERNAME_RE = /^[a-zA-Z0-9._-]{2,32}$/;

function parseCookies(header) {
    const out = {};
    if (!header || typeof header !== 'string') return out;
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq <= 0) continue;
        const key = part.slice(0, eq).trim();
        const val = part.slice(eq + 1).trim();
        if (!key) continue;
        try {
            out[key] = decodeURIComponent(val);
        } catch {
            out[key] = val;
        }
    }
    return out;
}

function extractRequestToken(req) {
    if (!req) return '';
    const cookies = parseCookies(req.headers?.cookie);
    if (cookies[SESSION_COOKIE_NAME]) return cookies[SESSION_COOKIE_NAME].trim();

    const authHeader = req.headers?.authorization;
    if (typeof authHeader === 'string' && /^Bearer\s+/i.test(authHeader)) {
        return authHeader.replace(/^Bearer\s+/i, '').trim();
    }

    const headerToken = req.headers?.['x-session-token'] || req.headers?.['x-auth-key'];
    if (typeof headerToken === 'string' && headerToken.trim()) {
        return headerToken.trim();
    }

    if (req.url) {
        try {
            const url = new URL(req.url, 'http://localhost');
            const qt = url.searchParams.get('token') || url.searchParams.get('auth_key');
            if (qt && qt.trim()) return qt.trim();
        } catch { /* ignore malformed url */ }
    }
    return '';
}

function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
    return `scrypt:${salt}:${derived}`;
}

function verifyPassword(password, storedHash) {
    if (typeof password !== 'string' || typeof storedHash !== 'string') return false;
    const parts = storedHash.split(':');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
    const [, salt, hex] = parts;
    if (!salt || !hex) return false;
    try {
        const expected = Buffer.from(hex, 'hex');
        const actual = crypto.scryptSync(password, salt, expected.length);
        if (actual.length !== expected.length) return false;
        return crypto.timingSafeEqual(actual, expected);
    } catch {
        return false;
    }
}

function hashSessionToken(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function validateUsername(username) {
    const clean = typeof username === 'string' ? username.trim() : '';
    if (!USERNAME_RE.test(clean)) {
        const err = new Error('用户名需为 2~32 位字母、数字、点、下划线或连字符');
        err.statusCode = 400;
        throw err;
    }
    return clean;
}

function validatePassword(password, label = '密码') {
    if (typeof password !== 'string') {
        const err = new Error(`${label}不能为空`);
        err.statusCode = 400;
        throw err;
    }
    const clean = password.trim();
    if (clean.length < 4 || clean.length > 128) {
        const err = new Error(`${label}长度需在 4 到 128 个字符之间`);
        err.statusCode = 400;
        throw err;
    }
    if (/[\r\n\0]/.test(clean)) {
        const err = new Error(`${label}不能包含换行或空字符`);
        err.statusCode = 400;
        throw err;
    }
    return clean;
}

function toPublicUser(row) {
    if (!row) return null;
    return {
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        role: row.role,
        disabled: Boolean(row.disabled),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function createUserManager(opts = {}) {
    let db = null;
    let currentDbPath = null;

    function resolveDbPath() {
        return opts.dbPath || process.env.AG_USERS_DB || DEFAULT_DB_PATH;
    }

    function isNoAuth() {
        if (typeof opts.isNoAuth === 'boolean') return opts.isNoAuth;
        return process.argv.includes('--no-auth');
    }

    function getDb() {
        const target = resolveDbPath();
        if (db && currentDbPath === target) return db;
        if (db) {
            try { db.close(); } catch { /* ignore */ }
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        db = new DatabaseSync(target);
        currentDbPath = target;
        db.exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA busy_timeout = 3000;
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                display_name TEXT NOT NULL,
                role TEXT NOT NULL CHECK(role IN ('admin', 'member')),
                password_hash TEXT NOT NULL,
                disabled INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                created_at TEXT NOT NULL,
                last_seen_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
            CREATE TABLE IF NOT EXISTS conversation_owners (
                cascade_id TEXT PRIMARY KEY,
                owner_id TEXT NOT NULL,
                custom_title TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_conv_owners_owner ON conversation_owners(owner_id);
        `);
        ensureBootstrapAdmin(db);
        return db;
    }

    function ensureBootstrapAdmin(database = db) {
        const row = database.prepare('SELECT COUNT(*) AS cnt FROM users').get();
        if (Number(row?.cnt || 0) > 0) return;

        const seedSecret = opts.initialAdminPassword
            || (typeof opts.getAuthKey === 'function' ? opts.getAuthKey() : getEffectiveAuthKey())
            || 'admin123';
        const now = new Date().toISOString();
        database.prepare(
            'INSERT INTO users (id, username, display_name, role, password_hash, disabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)'
        ).run(crypto.randomUUID(), 'admin', '管理员', 'admin', hashPassword(seedSecret), now, now);
    }

    function getPrimaryAdmin() {
        const database = getDb();
        const row = database.prepare("SELECT * FROM users WHERE role = 'admin' AND disabled = 0 ORDER BY created_at ASC LIMIT 1").get()
            || database.prepare("SELECT * FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1").get();
        return toPublicUser(row);
    }

    function getAuthStatus() {
        getDb();
        return {
            authEnabled: !isNoAuth(),
            multiUser: true,
        };
    }

    function getUserById(userId) {
        if (!userId) return null;
        const row = getDb().prepare('SELECT * FROM users WHERE id = ?').get(String(userId));
        return toPublicUser(row);
    }

    function authenticate(username, password) {
        const cleanUser = typeof username === 'string' ? username.trim() : '';
        if (!cleanUser || typeof password !== 'string' || !password) return null;
        const database = getDb();
        const row = database.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(cleanUser);
        if (!row || row.disabled) return null;
        if (!verifyPassword(password.trim(), row.password_hash) && !verifyPassword(password, row.password_hash)) {
            return null;
        }
        return toPublicUser(row);
    }

    function createSession(userId, ttlMs = SESSION_TTL_MS) {
        const database = getDb();
        const nowMs = Date.now();
        const now = new Date(nowMs).toISOString();
        const expiresAt = new Date(nowMs + ttlMs).toISOString();
        const token = crypto.randomBytes(32).toString('hex');
        const tokenHash = hashSessionToken(token);

        database.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
        database.prepare(
            'INSERT INTO sessions (token_hash, user_id, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)'
        ).run(tokenHash, userId, expiresAt, now, now);

        return { token, expiresAt };
    }

    function verifySessionToken(token) {
        if (!token || typeof token !== 'string') return null;
        const database = getDb();
        const tokenHash = hashSessionToken(token.trim());
        const row = database.prepare(`
            SELECT s.expires_at, u.*
            FROM sessions s
            JOIN users u ON u.id = s.user_id
            WHERE s.token_hash = ?
        `).get(tokenHash);
        if (!row) return null;
        if (row.disabled) return null;
        if (new Date(row.expires_at).getTime() <= Date.now()) {
            database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
            return null;
        }
        database.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(new Date().toISOString(), tokenHash);
        return toPublicUser(row);
    }

    function authenticateRequest(req) {
        if (isNoAuth()) {
            const admin = getPrimaryAdmin();
            return admin ? { ...admin, isNoAuth: true } : null;
        }
        const token = extractRequestToken(req);
        if (!token) return null;
        return verifySessionToken(token);
    }

    function deleteSession(token) {
        if (!token || typeof token !== 'string') return false;
        const res = getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashSessionToken(token.trim()));
        return res.changes > 0;
    }

    function deleteUserSessions(userId) {
        getDb().prepare('DELETE FROM sessions WHERE user_id = ?').run(String(userId));
    }

    function changeOwnCredentials(userId, { currentPassword, newPassword, newUsername, displayName } = {}) {
        const database = getDb();
        const row = database.prepare('SELECT * FROM users WHERE id = ?').get(String(userId));
        if (!row) {
            const err = new Error('用户不存在');
            err.statusCode = 404;
            throw err;
        }

        const updates = [];
        const params = [];
        const wantsSensitiveChange = Boolean(newPassword || (newUsername && newUsername.trim().toLowerCase() !== row.username.toLowerCase()));
        if (wantsSensitiveChange && !isNoAuth()) {
            if (!currentPassword || !verifyPassword(String(currentPassword).trim(), row.password_hash) && !verifyPassword(String(currentPassword), row.password_hash)) {
                const err = new Error('当前密码验证失败');
                err.statusCode = 403;
                throw err;
            }
        }

        if (newUsername !== undefined && newUsername.trim() !== row.username) {
            const cleanUsername = validateUsername(newUsername);
            const conflict = database.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE AND id != ?').get(cleanUsername, row.id);
            if (conflict) {
                const err = new Error('该用户名已被占用');
                err.statusCode = 409;
                throw err;
            }
            updates.push('username = ?');
            params.push(cleanUsername);
        }

        if (displayName !== undefined) {
            const cleanDisplay = String(displayName || '').trim().slice(0, 48);
            if (cleanDisplay) {
                updates.push('display_name = ?');
                params.push(cleanDisplay);
            }
        }

        if (newPassword !== undefined && String(newPassword).length > 0) {
            const cleanPass = validatePassword(newPassword, '新密码');
            updates.push('password_hash = ?');
            params.push(hashPassword(cleanPass));
        }

        if (updates.length > 0) {
            updates.push('updated_at = ?');
            params.push(new Date().toISOString());
            params.push(row.id);
            database.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
        }

        return getUserById(row.id);
    }

    function listUsers() {
        const database = getDb();
        const rows = database.prepare(`
            SELECT u.*,
                   (SELECT COUNT(*) FROM conversation_owners co WHERE co.owner_id = u.id) AS conversation_count
            FROM users u
            ORDER BY CASE WHEN u.role = 'admin' THEN 0 ELSE 1 END, u.created_at ASC
        `).all();
        return rows.map((r) => ({
            ...toPublicUser(r),
            conversationCount: Number(r.conversation_count || 0),
        }));
    }

    function createUser({ username, password, displayName, role = 'member' } = {}) {
        const database = getDb();
        const cleanUsername = validateUsername(username);
        const cleanPassword = validatePassword(password, '初始密码');
        const cleanRole = role === 'admin' ? 'admin' : 'member';
        const cleanDisplay = String(displayName || cleanUsername).trim().slice(0, 48) || cleanUsername;

        const existing = database.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(cleanUsername);
        if (existing) {
            const err = new Error(`用户名 "${cleanUsername}" 已存在`);
            err.statusCode = 409;
            throw err;
        }

        const now = new Date().toISOString();
        const id = crypto.randomUUID();
        database.prepare(
            'INSERT INTO users (id, username, display_name, role, password_hash, disabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)'
        ).run(id, cleanUsername, cleanDisplay, cleanRole, hashPassword(cleanPassword), now, now);

        return getUserById(id);
    }

    function countActiveAdmins(excludeId = null) {
        const database = getDb();
        const row = excludeId
            ? database.prepare("SELECT COUNT(*) AS cnt FROM users WHERE role = 'admin' AND disabled = 0 AND id != ?").get(String(excludeId))
            : database.prepare("SELECT COUNT(*) AS cnt FROM users WHERE role = 'admin' AND disabled = 0").get();
        return Number(row?.cnt || 0);
    }

    function updateUser(targetId, { displayName, password, disabled, role } = {}) {
        const database = getDb();
        const row = database.prepare('SELECT * FROM users WHERE id = ?').get(String(targetId));
        if (!row) {
            const err = new Error('未找到目标用户');
            err.statusCode = 404;
            throw err;
        }

        const nextRole = role !== undefined ? (role === 'admin' ? 'admin' : 'member') : row.role;
        const nextDisabled = disabled !== undefined ? (disabled ? 1 : 0) : row.disabled;

        if (row.role === 'admin' && (nextRole !== 'admin' || nextDisabled === 1) && countActiveAdmins(row.id) === 0) {
            const err = new Error('至少需要保留一个启用状态的管理员账号');
            err.statusCode = 400;
            throw err;
        }

        const updates = ['role = ?', 'disabled = ?', 'updated_at = ?'];
        const params = [nextRole, nextDisabled, new Date().toISOString()];

        if (displayName !== undefined) {
            const cleanDisplay = String(displayName || '').trim().slice(0, 48);
            if (cleanDisplay) {
                updates.push('display_name = ?');
                params.push(cleanDisplay);
            }
        }
        if (password !== undefined && String(password).trim().length > 0) {
            const cleanPass = validatePassword(password, '重置密码');
            updates.push('password_hash = ?');
            params.push(hashPassword(cleanPass));
        }

        params.push(row.id);
        database.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);

        if (nextDisabled === 1 || (password !== undefined && String(password).trim().length > 0)) {
            deleteUserSessions(row.id);
        }
        return getUserById(row.id);
    }

    function deleteUser(targetId, actorId = null) {
        const database = getDb();
        const row = database.prepare('SELECT * FROM users WHERE id = ?').get(String(targetId));
        if (!row) {
            const err = new Error('未找到目标用户');
            err.statusCode = 404;
            throw err;
        }
        if (actorId && row.id === actorId) {
            const err = new Error('不能删除当前登录的管理员自己');
            err.statusCode = 400;
            throw err;
        }
        if (row.role === 'admin' && countActiveAdmins(row.id) === 0) {
            const err = new Error('不能删除最后一个管理员账号');
            err.statusCode = 400;
            throw err;
        }
        deleteUserSessions(row.id);
        database.prepare('DELETE FROM users WHERE id = ?').run(row.id);
        return { deleted: true, id: row.id };
    }

    function assignConversationOwner(cascadeId, ownerId, customTitle = null) {
        if (!cascadeId || !ownerId) return null;
        const database = getDb();
        const existing = database.prepare('SELECT * FROM conversation_owners WHERE cascade_id = ?').get(String(cascadeId));
        const now = new Date().toISOString();
        if (existing) {
            if (customTitle && customTitle !== existing.custom_title) {
                database.prepare('UPDATE conversation_owners SET custom_title = ?, updated_at = ? WHERE cascade_id = ?')
                    .run(String(customTitle).trim().slice(0, 120), now, String(cascadeId));
            }
            return existing.owner_id;
        }
        database.prepare(
            'INSERT INTO conversation_owners (cascade_id, owner_id, custom_title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
        ).run(String(cascadeId), String(ownerId), customTitle ? String(customTitle).trim().slice(0, 120) : null, now, now);
        return String(ownerId);
    }

    function getConversationMeta(cascadeId) {
        if (!cascadeId) return null;
        const row = getDb().prepare('SELECT * FROM conversation_owners WHERE cascade_id = ?').get(String(cascadeId));
        if (row) {
            return {
                cascadeId: row.cascade_id,
                ownerId: row.owner_id,
                customTitle: row.custom_title || null,
            };
        }
        const admin = getPrimaryAdmin();
        return {
            cascadeId: String(cascadeId),
            ownerId: admin?.id || null,
            customTitle: null,
        };
    }

    function getConversationMetaMap() {
        const rows = getDb().prepare('SELECT cascade_id, owner_id, custom_title FROM conversation_owners').all();
        const map = new Map();
        for (const r of rows) {
            map.set(r.cascade_id, { ownerId: r.owner_id, customTitle: r.custom_title || null });
        }
        return map;
    }

    function canAccessConversation(cascadeId, user) {
        if (!user || !cascadeId) return false;
        const meta = getConversationMeta(cascadeId);
        // Unclaimed legacy conversations belong strictly to primary admin
        const effectiveOwnerId = meta?.ownerId || getPrimaryAdmin()?.id || null;
        if (!effectiveOwnerId) return user.role === 'admin';
        return effectiveOwnerId === user.id;
    }

    function renameConversation(cascadeId, title, user) {
        if (!canAccessConversation(cascadeId, user)) {
            const err = new Error('无权重命名该对话');
            err.statusCode = 403;
            throw err;
        }
        const cleanTitle = String(title || '').trim().slice(0, 120);
        if (!cleanTitle) {
            const err = new Error('标题不能为空');
            err.statusCode = 400;
            throw err;
        }
        const database = getDb();
        const existing = database.prepare('SELECT cascade_id FROM conversation_owners WHERE cascade_id = ?').get(String(cascadeId));
        const now = new Date().toISOString();
        if (existing) {
            database.prepare('UPDATE conversation_owners SET custom_title = ?, updated_at = ? WHERE cascade_id = ?')
                .run(cleanTitle, now, String(cascadeId));
        } else {
            database.prepare('INSERT INTO conversation_owners (cascade_id, owner_id, custom_title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
                .run(String(cascadeId), user.id, cleanTitle, now, now);
        }
        return { cascadeId, title: cleanTitle };
    }

    function removeConversationMeta(cascadeId) {
        if (!cascadeId) return;
        getDb().prepare('DELETE FROM conversation_owners WHERE cascade_id = ?').run(String(cascadeId));
    }

    function close() {
        if (db) {
            try { db.close(); } catch { /* ignore */ }
            db = null;
            currentDbPath = null;
        }
    }

    return {
        getDb,
        getPrimaryAdmin,
        getAuthStatus,
        getUserById,
        authenticate,
        createSession,
        verifySessionToken,
        authenticateRequest,
        deleteSession,
        changeOwnCredentials,
        listUsers,
        createUser,
        updateUser,
        deleteUser,
        assignConversationOwner,
        getConversationMeta,
        getConversationMetaMap,
        canAccessConversation,
        renameConversation,
        removeConversationMeta,
        close,
    };
}

const defaultUserManager = createUserManager();

module.exports = {
    SESSION_COOKIE_NAME,
    SESSION_TTL_MS,
    parseCookies,
    extractRequestToken,
    hashPassword,
    verifyPassword,
    createUserManager,
    ...defaultUserManager,
};
