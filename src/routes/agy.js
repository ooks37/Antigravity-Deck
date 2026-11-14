// === Antigravity CLI (agy) Management Routes ===
// GET  /api/agy/status     -> current agy binary path, resolved source, and version
// GET  /api/agy/changelog  -> recent `agy changelog` entries
// POST /api/agy/update     -> manually run `agy update` and return before/after versions

const agyManager = require('../agy-manager');

module.exports = function setupAgyRoutes(app) {
    app.get('/api/agy/status', async (req, res) => {
        try {
            const refresh = req.query.refresh !== 'false';
            const status = await agyManager.getAgyStatus({ refresh });
            res.json(status);
        } catch (e) {
            console.error('[!] AGY status error:', e.message);
            res.status(500).json({ error: '获取 agy 状态失败' });
        }
    });

    app.get('/api/agy/changelog', async (req, res) => {
        try {
            const limit = Number(req.query.limit) || 120;
            const changelog = await agyManager.getAgyChangelog({ limit });
            res.json(changelog);
        } catch (e) {
            console.error('[!] AGY changelog error:', e.message);
            res.status(500).json({ error: '读取 agy 更新日志失败' });
        }
    });

    app.post('/api/agy/update', async (req, res) => {
        try {
            const result = await agyManager.updateAgy();
            const { statusCode = 200, ...payload } = result;
            res.status(statusCode).json(payload);
        } catch (e) {
            console.error('[!] AGY update error:', e.message);
            res.status(500).json({ success: false, error: '执行 agy 手动更新失败' });
        }
    });
};
