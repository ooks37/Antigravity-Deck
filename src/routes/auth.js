// === Multi-User Auth & User Management Routes ===
// Public:  GET /api/auth/me, POST /api/auth/login, POST /api/auth/logout
// Self:    POST /api/auth/password, PATCH /api/auth/profile
// Admin:   GET/POST /api/users, PATCH/DELETE /api/users/:id

const {
    SESSION_COOKIE_NAME,
    SESSION_TTL_MS,
    extractRequestToken,
    getAuthStatus,
    authenticate,
    authenticateRequest,
    createSession,
    deleteSession,
    changeOwnCredentials,
    listUsers,
    createUser,
    updateUser,
    deleteUser,
} = require('../user-manager');

function setSessionCookie(res, token) {
    const maxAgeSec = Math.floor(SESSION_TTL_MS / 1000);
    const parts = [
        `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        `Max-Age=${maxAgeSec}`,
    ];
    res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

module.exports = function setupAuthRoutes(app) {
    app.get('/api/auth/me', (req, res) => {
        const status = getAuthStatus();
        const user = authenticateRequest(req);
        res.json({
            authEnabled: status.authEnabled,
            multiUser: true,
            authenticated: Boolean(user),
            user: user || null,
        });
    });

    app.get('/api/auth/info', (req, res) => {
        const status = getAuthStatus();
        res.json({
            authEnabled: status.authEnabled,
            multiUser: true,
            role: req.user?.role || null,
        });
    });

    app.post('/api/auth/login', (req, res) => {
        try {
            const { username, password } = req.body || {};
            if (!username || !password) {
                return res.status(400).json({ error: '请输入用户名和密码' });
            }
            const user = authenticate(username, password);
            if (!user) {
                return res.status(401).json({ error: '用户名、密码错误或账号已禁用' });
            }
            const { token, expiresAt } = createSession(user.id);
            setSessionCookie(res, token);
            res.json({ user, token, expiresAt });
        } catch (e) {
            res.status(e.statusCode || 500).json({ error: e.message || '登录失败' });
        }
    });

    app.post('/api/auth/logout', (req, res) => {
        const token = extractRequestToken(req);
        if (token) deleteSession(token);
        clearSessionCookie(res);
        res.json({ success: true });
    });

    app.post('/api/auth/password', (req, res) => {
        try {
            if (!req.user) return res.status(401).json({ error: '未登录' });
            const { currentPassword, currentKey, newPassword, newKey, newUsername, displayName } = req.body || {};
            const updated = changeOwnCredentials(req.user.id, {
                currentPassword: currentPassword ?? currentKey,
                newPassword: newPassword ?? newKey,
                newUsername,
                displayName,
            });
            res.json({ updated: true, user: updated });
        } catch (e) {
            res.status(e.statusCode || 400).json({ error: e.message || '更新账号信息失败' });
        }
    });

    app.get('/api/users', (req, res) => {
        if (!req.user || req.user.role !== 'admin') {
            return res.status(403).json({ error: '仅管理员可查看成员列表' });
        }
        res.json({ users: listUsers() });
    });

    app.post('/api/users', (req, res) => {
        if (!req.user || req.user.role !== 'admin') {
            return res.status(403).json({ error: '仅管理员可创建用户' });
        }
        try {
            const user = createUser(req.body || {});
            res.status(201).json({ user });
        } catch (e) {
            res.status(e.statusCode || 400).json({ error: e.message || '创建用户失败' });
        }
    });

    app.patch('/api/users/:id', (req, res) => {
        if (!req.user || req.user.role !== 'admin') {
            return res.status(403).json({ error: '仅管理员可修改用户' });
        }
        try {
            const user = updateUser(req.params.id, req.body || {});
            res.json({ user });
        } catch (e) {
            res.status(e.statusCode || 400).json({ error: e.message || '更新用户失败' });
        }
    });

    app.delete('/api/users/:id', (req, res) => {
        if (!req.user || req.user.role !== 'admin') {
            return res.status(403).json({ error: '仅管理员可删除用户' });
        }
        try {
            const result = deleteUser(req.params.id, req.user.id);
            res.json(result);
        } catch (e) {
            res.status(e.statusCode || 400).json({ error: e.message || '删除用户失败' });
        }
    });
};
