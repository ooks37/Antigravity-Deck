// === Auth Management Routes ===
// GET /api/auth/info, POST /api/auth/password

const { getEffectiveAuthKey, setCustomAuthKey } = require('../auth-manager');

module.exports = function setupAuthRoutes(app) {
    app.get('/api/auth/info', (req, res) => {
        const key = getEffectiveAuthKey();
        res.json({
            authEnabled: Boolean(key),
            keyLength: key.length,
        });
    });

    app.post('/api/auth/password', (req, res) => {
        try {
            const { currentKey, newKey } = req.body || {};
            const result = setCustomAuthKey(newKey, { currentKey });
            res.json(result);
        } catch (e) {
            res.status(e.statusCode || 400).json({ error: e.message || '修改访问密码失败' });
        }
    });
};
