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

    app.get('/api/agy/models', async (req, res) => {
        try {
            const force = req.query.refresh === '1' || req.query.refresh === 'true';
            const result = await agyManager.getAgyModels({ force });
            const { statusCode = 200, ...payload } = result;
            res.status(statusCode).json(payload);
        } catch (e) {
            res.status(500).json({ success: false, error: e.message || '读取 agy 模型失败', models: [] });
        }
    });

    app.post('/api/agy/run', async (req, res) => {
        try {
            const { prompt, model, modelLabel, effort, conversationId, workspace, timeoutMs } = req.body || {};
            const userManager = require('../user-manager');
            if (conversationId && req.user && !userManager.canAccessConversation(conversationId, req.user)) {
                return res.status(403).json({ success: false, error: '无权访问或续聊该对话' });
            }
            const result = await agyManager.runAgyPrompt({
                prompt,
                model,
                modelLabel,
                effort,
                conversationId,
                workspace,
                timeoutMs: Number(timeoutMs) || 120000,
            });
            if (result.success && result.sessionId && req.user) {
                userManager.assignConversationOwner(result.sessionId, req.user.id, String(prompt || '').trim().slice(0, 80));
                try {
                    const { stepCache, ensureCached } = require('../step-cache');
                    delete stepCache[result.sessionId];
                    await ensureCached(result.sessionId, null);
                    require('../ws').broadcastAll({ type: 'conversations_updated' }, req.user.id);
                } catch { /* non-fatal */ }
            }
            const { statusCode = 200, ...payload } = result;
            res.status(statusCode).json(payload);
        } catch (e) {
            res.status(500).json({ success: false, error: e.message || 'agy 执行失败' });
        }
    });

    app.post('/api/agy/stream', async (req, res) => {
        const { prompt, model, modelLabel, effort, conversationId, workspace, timeoutMs } = req.body || {};
        const userManager = require('../user-manager');
        if (!prompt || !String(prompt).trim()) {
            return res.status(400).json({ success: false, error: 'prompt 不能为空' });
        }
        if (conversationId && req.user && !userManager.canAccessConversation(conversationId, req.user)) {
            return res.status(403).json({ success: false, error: '无权访问或续聊该对话' });
        }

        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        if (typeof res.flushHeaders === 'function') res.flushHeaders();

        let closed = false;
        let cancelChild = null;
        const sendEvent = (event, data) => {
            if (closed || res.writableEnded) return;
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };

        req.on('close', () => {
            closed = true;
            if (typeof cancelChild === 'function') cancelChild();
        });

        try {
            const result = await agyManager.streamAgyPrompt(
                {
                    prompt,
                    model,
                    modelLabel,
                    effort,
                    conversationId,
                    workspace,
                    timeoutMs: Number(timeoutMs) || 180000,
                    onSpawn: (abortFn) => { cancelChild = abortFn; },
                },
                (ev) => {
                    if (ev.type === 'init' && ev.sessionId && req.user) {
                        userManager.assignConversationOwner(ev.sessionId, req.user.id, String(prompt || '').trim().slice(0, 80));
                    }
                    sendEvent(ev.type, ev);
                },
            );

            if (result.sessionId && req.user) {
                userManager.assignConversationOwner(result.sessionId, req.user.id, String(prompt || '').trim().slice(0, 80));
                try {
                    const { stepCache, ensureCached } = require('../step-cache');
                    delete stepCache[result.sessionId];
                    await ensureCached(result.sessionId, null);
                    const updated = stepCache[result.sessionId];
                    if (updated) {
                        sendEvent('steps_sync', { sessionId: result.sessionId, steps: updated.steps, stepCount: updated.stepCount });
                    }
                    require('../ws').broadcastAll({ type: 'conversations_updated' }, req.user.id);
                } catch { /* non-fatal */ }
            }

            if (result.success) {
                sendEvent('done', {
                    sessionId: result.sessionId,
                    model: result.model,
                    effort: result.effort,
                    text: result.text,
                    eventsCount: result.eventsCount,
                });
            } else {
                sendEvent('error', { error: result.error || '执行失败', sessionId: result.sessionId || null });
            }
        } catch (e) {
            sendEvent('error', { error: e.message || '执行异常' });
        } finally {
            if (!closed && !res.writableEnded) res.end();
        }
    });
};
