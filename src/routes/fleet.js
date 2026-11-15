const { listFleetServers, pingFleet } = require('../fleet-manager');

module.exports = function (app) {
    // List configured Baota MCP fleet servers (tokens and secret URLs stripped)
    app.get('/api/fleet/servers', (req, res) => {
        try {
            res.json(listFleetServers());
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Live health probe across configured fleet servers
    app.post('/api/fleet/ping', async (req, res) => {
        try {
            const timeoutMs = Number(req.body?.timeoutMs) || 3500;
            const result = await pingFleet({ timeoutMs: Math.min(Math.max(timeoutMs, 1000), 10000) });
            res.json(result);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
};
