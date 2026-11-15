// === WebSocket Handling ===
// Manages WS connections, per-client conversation tracking, and broadcasting.

const { lsConfig } = require('./config');
const { getInstanceForCascade } = require('./poller');
const { authenticateRequest, canAccessConversation } = require('./user-manager');

const viewers = new Set();
const globalViewers = new Set(); // clients that want ALL events (Live Logs — admin only)
const clientConvMap = new Map(); // Map<ws, convId> — per-client conversation tracking

function setupWebSocket(wss, { ensureCached, stepCache }) {
    wss.on('connection', (ws, req) => {
        const user = authenticateRequest(req);
        if (!user) {
            ws.close(4401, 'Unauthorized');
            return;
        }
        ws._user = user;
        viewers.add(ws);
        // Hub model (2.0.11): detection = the shared hub LS is up (lsConfig.detected),
        // NOT whether any workspace is tracked (lsInstances is empty until a workspace
        // is opened/created, but the hub is still usable for new chats + history).
        ws.send(JSON.stringify({ type: 'status', detected: lsConfig.detected, port: lsConfig.port || null }));

        ws.on('message', async (raw) => {
            try {
                const msg = JSON.parse(raw.toString());
                if (msg.type === 'set_conversation') {
                    if (msg.conversationId && !canAccessConversation(msg.conversationId, ws._user)) {
                        sendToOne(ws, {
                            type: 'steps_init',
                            conversationId: msg.conversationId,
                            steps: [],
                            baseIndex: 0,
                            stepCount: 0,
                            source: 'none',
                            notFound: true,
                            forbidden: true,
                        });
                        return;
                    }
                    clientConvMap.set(ws, msg.conversationId);
                    console.log(`[WS] set_conversation → ${msg.conversationId?.substring(0, 8)}, clients: ${clientConvMap.size}`);
                    await ensureCached(msg.conversationId, getInstanceForCascade(msg.conversationId));
                    const cache = stepCache[msg.conversationId];
                    sendToOne(ws, {
                        type: 'steps_init',
                        conversationId: msg.conversationId,
                        steps: cache ? cache.steps : [],
                        baseIndex: cache ? (cache.baseIndex || 0) : 0,
                        stepCount: cache ? (cache.stepCount || 0) : 0,
                        source: cache?.source || (cache ? 'ls' : 'none'),
                        notFound: !cache,
                    });
                    if (cache?.source === 'cli-db') {
                        sendToOne(ws, {
                            type: 'cascade_status',
                            conversationId: msg.conversationId,
                            status: 'CASCADE_RUN_STATUS_IDLE',
                        });
                    }
                } else if (msg.type === 'subscribe_all') {
                    if (ws._user?.role !== 'admin') return;
                    globalViewers.add(ws);
                    console.log(`[WS] subscribe_all — global viewers: ${globalViewers.size}`);
                } else if (msg.type === 'app_log') {
                    // Frontend error/log forwarding — rebroadcast to all admin Live Logs viewers
                    broadcastToGlobal({ ...msg, ts: msg.ts || Date.now() });
                }
            } catch (e) { }
        });

        ws.on('close', () => {
            viewers.delete(ws);
            globalViewers.delete(ws);
            clientConvMap.delete(ws);
        });
    });
}

function sendToOne(ws, data) {
    if (ws.readyState === 1) ws.send(JSON.stringify(data));
}

function broadcast(data, targetConvId) {
    const msg = JSON.stringify(data);
    const sent = new Set();
    // Send to viewers watching this specific conversation
    viewers.forEach(v => {
        if (v.readyState !== 1) return;
        if (targetConvId && clientConvMap.get(v) !== targetConvId) return;
        if (targetConvId && !canAccessConversation(targetConvId, v._user)) return;
        v.send(msg);
        sent.add(v);
    });
    // Also send to admin global viewers (Live Logs — all cascades)
    globalViewers.forEach(v => {
        if (v.readyState !== 1) return;
        if (sent.has(v)) return;
        if (v._user?.role !== 'admin') return;
        v.send(msg);
    });
}

// Broadcast to ALL connected viewers (optionally scoped to one ownerId or admins)
function broadcastAll(data, targetOwnerId = null) {
    const msg = JSON.stringify(data);
    viewers.forEach(v => {
        if (v.readyState !== 1) return;
        if (targetOwnerId && v._user?.id !== targetOwnerId) return;
        v.send(msg);
    });
}

// Broadcast to global viewers only (Live Logs subscribers — for app_log events)
function broadcastToGlobal(data) {
    const msg = JSON.stringify(data);
    globalViewers.forEach(v => {
        if (v.readyState === 1) v.send(msg);
    });
}

module.exports = { setupWebSocket, sendToOne, broadcast, broadcastAll, broadcastToGlobal };
