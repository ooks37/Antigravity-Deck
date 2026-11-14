// === Proxy Routes (/api/proxy/*) ===
// Supports SOCKS5h / SOCKS5 / SOCKS4 / HTTP / HTTPS multi-node pool, exit IP probing, and one-click rotation.

const {
    getProxyState,
    addProxyNode,
    updateProxyNode,
    removeProxyNode,
    selectProxyNode,
    updateProxyPreferences,
    rotateNextProxyNode,
    testSavedProxyNode,
    testProxyConfig,
    getDirectExitIp,
} = require('../proxy-manager');

function broadcastProxyState(state) {
    try {
        const { broadcastAll } = require('../ws');
        broadcastAll({ type: 'proxy_updated', proxy: state });
    } catch { /* ws server may not be started in tests */ }
}

module.exports = function setupProxyRoutes(app) {
    app.get('/api/proxy', (req, res) => {
        try {
            res.json(getProxyState());
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.get('/api/proxy/ip', async (req, res) => {
        try {
            const state = getProxyState();
            const [direct, proxied] = await Promise.all([
                getDirectExitIp(5000),
                state.enabled && state.activeNodeId
                    ? testSavedProxyNode(state.activeNodeId).then((r) => r.result).catch((e) => ({ ok: false, error: e.message }))
                    : Promise.resolve(null),
            ]);
            res.json({ direct, proxied, state: getProxyState() });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/proxy/nodes', (req, res) => {
        try {
            const result = addProxyNode(req.body || {});
            broadcastProxyState(result.state);
            res.status(201).json(result);
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    app.patch('/api/proxy/nodes/:id', (req, res) => {
        try {
            const result = updateProxyNode(req.params.id, req.body || {});
            broadcastProxyState(result.state);
            res.json(result);
        } catch (e) {
            const status = e.message.includes('未找到') ? 404 : 400;
            res.status(status).json({ error: e.message });
        }
    });

    app.delete('/api/proxy/nodes/:id', (req, res) => {
        try {
            const result = removeProxyNode(req.params.id);
            broadcastProxyState(result.state);
            res.json(result);
        } catch (e) {
            const status = e.message.includes('未找到') ? 404 : 400;
            res.status(status).json({ error: e.message });
        }
    });

    app.post('/api/proxy/use', (req, res) => {
        const { id, enabled } = req.body || {};
        try {
            const state = selectProxyNode(id ?? null, enabled);
            broadcastProxyState(state);
            res.json({ success: true, state });
        } catch (e) {
            const status = e.message.includes('未找到') ? 404 : 400;
            res.status(status).json({ error: e.message });
        }
    });

    app.post('/api/proxy/rotate', (req, res) => {
        try {
            const state = rotateNextProxyNode();
            broadcastProxyState(state);
            res.json({ success: true, state });
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    app.patch('/api/proxy/preferences', (req, res) => {
        try {
            const state = updateProxyPreferences(req.body || {});
            broadcastProxyState(state);
            res.json({ success: true, state });
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    app.post('/api/proxy/test', async (req, res) => {
        const { id } = req.body || {};
        try {
            if (id) {
                const { result, state } = await testSavedProxyNode(id);
                broadcastProxyState(state);
                return res.json({ result, state });
            }
            const result = await testProxyConfig(req.body || {});
            res.json({ result });
        } catch (e) {
            const status = e.message.includes('未找到') ? 404 : 400;
            res.status(status).json({ error: e.message });
        }
    });
};
