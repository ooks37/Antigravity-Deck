// === Cascade Routes ===
// /api/cascade/*, /api/auto-accept, /api/user/profile, /api/ls/:method

const { callApi, callApiFireAndForgetOnInstance } = require('../api');
const { getAutoAccept, setAutoAccept, buildAcceptPayload } = require('../cache');
const { startCascade, sendMessage } = require('../cascade'); // startAndSend is NOT used — intentionally omitted
const { registerCascadeInstance } = require('../poller');
const { resolveInst } = require('./route-helpers');
const { handleLsFallback } = require('../ls-fallback');
const userManager = require('../user-manager');

// Security: Method whitelist to prevent arbitrary LS method invocation.
// Generated from the extracted RPC registry — SAFE read-only methods are
// auto-generated, mutating ones are hand-curated. Regenerate after an
// Antigravity update: `node tools/api-tracker/gen-whitelist.js`.
const { ALLOWED_LS_METHODS } = require('../ls-method-whitelist');

function denyIfUnauthorized(req, res, cascadeId) {
    if (req.user && !userManager.canAccessConversation(cascadeId, req.user)) {
        res.status(403).json({ error: '无权访问该对话' });
        return true;
    }
    return false;
}

module.exports = function setupCascadeRoutes(app) {
    // Create a new cascade conversation
    app.post('/api/cascade/start', async (req, res) => {
        try {
            const inst = resolveInst(req);
            if (!inst) return res.status(503).json({ error: 'No language server connected' });
            const cascadeId = await startCascade(inst);
            registerCascadeInstance(cascadeId, inst);
            if (req.user) userManager.assignConversationOwner(cascadeId, req.user.id);
            res.json({ cascadeId });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Send a message to an existing cascade (non-blocking — fires stream, returns immediately)
    // Seamlessly falls back to `agy --conversation <id>` when continuing a local CLI SQLite session.
    app.post('/api/cascade/send', async (req, res) => {
        try {
            const { cascadeId, message, modelId, modelLabel, effort, images, imageBase64, workspace } = req.body;
            if (!cascadeId || !message) {
                return res.status(400).json({ error: 'cascadeId and message are required' });
            }
            if (denyIfUnauthorized(req, res, cascadeId)) return;

            const { hasCliConversation } = require('../cli-conversations');
            const { stepCache, ensureCached } = require('../step-cache');
            const { broadcast, broadcastAll } = require('../ws');
            const agyManager = require('../agy-manager');

            const inst = resolveInst(req);
            const isCliBacked = stepCache[cascadeId]?.source === 'cli-db' || hasCliConversation(cascadeId);

            const continueViaCli = async () => {
                if (req.user) userManager.assignConversationOwner(cascadeId, req.user.id);
                broadcast({ type: 'cascade_status', conversationId: cascadeId, status: 'CASCADE_RUN_STATUS_RUNNING' }, cascadeId);
                try {
                    await agyManager.streamAgyPrompt(
                        {
                            prompt: message,
                            model: modelId,
                            modelLabel,
                            effort,
                            conversationId: cascadeId,
                            workspace,
                        },
                        (ev) => {
                            if (ev.type === 'turn_steps' || ev.type === 'thinking' || ev.type === 'tool') {
                                broadcast({ type: 'cli_stream_event', conversationId: cascadeId, event: ev }, cascadeId);
                            }
                        },
                    );
                    delete stepCache[cascadeId];
                    await ensureCached(cascadeId, inst);
                    const updated = stepCache[cascadeId];
                    broadcast({
                        type: 'steps_init',
                        conversationId: cascadeId,
                        steps: updated ? updated.steps : [],
                        baseIndex: updated ? (updated.baseIndex || 0) : 0,
                        stepCount: updated ? (updated.stepCount || 0) : 0,
                        source: updated?.source || 'cli-db',
                    }, cascadeId);
                    broadcastAll({ type: 'conversations_updated' }, req.user?.id || null);
                } finally {
                    broadcast({ type: 'cascade_status', conversationId: cascadeId, status: 'CASCADE_RUN_STATUS_IDLE' }, cascadeId);
                }
            };

            if (isCliBacked || !inst) {
                continueViaCli().catch((e) => console.error('[Cascade CLI resume error]', e.message));
                return res.json({ ok: true, cascadeId, mode: 'agy-cli' });
            }

            // Fire-and-forget: start the LS stream; fall back to CLI if LS doesn't hold this ID (404)
            const opts = { modelId };
            if (images && images.length > 0) {
                opts.media = images; // array of { mimeType, inlineData, uri, thumbnail }
            } else if (imageBase64) {
                opts.imageBase64 = imageBase64; // legacy single-image fallback
            }
            sendMessage(cascadeId, message, { ...opts, inst }).catch(async (e) => {
                console.error('[Cascade send error]', e.message);
                if (hasCliConversation(cascadeId) || String(e.message).includes('404')) {
                    try { await continueViaCli(); } catch (cliErr) { console.error('[Cascade CLI fallback error]', cliErr.message); }
                }
            });
            res.json({ ok: true, cascadeId, mode: 'ls' });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Start a new cascade and send a message (non-blocking)
    app.post('/api/cascade/submit', async (req, res) => {
        try {
            const { message, modelId, modelLabel, effort, images, imageBase64, workspaceUri, workspace } = req.body;
            if (!message) {
                return res.status(400).json({ error: 'message is required' });
            }
            const inst = resolveInst(req);
            if (!inst) {
                const agyManager = require('../agy-manager');
                const { stepCache, ensureCached } = require('../step-cache');
                const { broadcast, broadcastAll } = require('../ws');
                let settled = false;
                let initResolve;
                const initPromise = new Promise((r) => { initResolve = r; });
                const timer = setTimeout(() => { if (!settled) { settled = true; initResolve(null); } }, 8000);

                agyManager.streamAgyPrompt(
                    { prompt: message, model: modelId, modelLabel, effort, workspace },
                    (ev) => {
                        if (ev.type === 'init' && ev.sessionId && !settled) {
                            settled = true;
                            clearTimeout(timer);
                            if (req.user) userManager.assignConversationOwner(ev.sessionId, req.user.id, String(message).trim().slice(0, 80));
                            initResolve(ev.sessionId);
                        }
                    },
                ).then(async (result) => {
                    if (result.sessionId) {
                        if (req.user) userManager.assignConversationOwner(result.sessionId, req.user.id, String(message).trim().slice(0, 80));
                        delete stepCache[result.sessionId];
                        await ensureCached(result.sessionId, null).catch(() => {});
                        const updated = stepCache[result.sessionId];
                        if (updated) {
                            broadcast({
                                type: 'steps_init',
                                conversationId: result.sessionId,
                                steps: updated.steps,
                                baseIndex: updated.baseIndex || 0,
                                stepCount: updated.stepCount || 0,
                                source: updated.source || 'cli-db',
                            }, result.sessionId);
                        }
                        broadcastAll({ type: 'conversations_updated' }, req.user?.id || null);
                        broadcast({ type: 'cascade_status', conversationId: result.sessionId, status: 'CASCADE_RUN_STATUS_IDLE' }, result.sessionId);
                    }
                    if (!settled) { settled = true; clearTimeout(timer); initResolve(result.sessionId || null); }
                }).catch(() => {
                    if (!settled) { settled = true; clearTimeout(timer); initResolve(null); }
                });

                const cascadeId = await initPromise;
                return res.json({ cascadeId, mode: 'agy-cli' });
            }

            // Start cascade synchronously, then fire-and-forget the message.
            const startOpts = workspaceUri ? { workspaceUris: [workspaceUri] } : {};
            const cascadeId = await startCascade(inst, startOpts);
            registerCascadeInstance(cascadeId, inst);
            if (req.user) userManager.assignConversationOwner(cascadeId, req.user.id, String(message).trim().slice(0, 80));
            const opts = { modelId, inst };
            if (images && images.length > 0) {
                opts.media = images;
            } else if (imageBase64) {
                opts.imageBase64 = imageBase64;
            }
            sendMessage(cascadeId, message, opts).catch(e => console.error('[Cascade submit error]', e.message));
            res.json({ cascadeId });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Cascade run status
    app.get('/api/cascade/:id/status', async (req, res) => {
        if (denyIfUnauthorized(req, res, req.params.id)) return;
        try {
            const inst = resolveInst(req);
            if (!inst) return res.status(503).json({ error: 'No language server connected' });
            const data = await callApi('GetAllCascadeTrajectories', {}, inst);
            const traj = data.trajectorySummaries?.[req.params.id];
            if (!traj) return res.status(404).json({ error: 'Cascade not found' });
            res.json({
                cascadeId: req.params.id,
                status: traj.status,
                stepCount: traj.stepCount,
                summary: traj.summary,
                lastModifiedTime: traj.lastModifiedTime,
            });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Accept or reject pending code changes
    // HandleCascadeUserInteraction is a streaming RPC — use fire-and-forget
    // Searches ALL LS instances to find the one that owns this cascade
    app.post('/api/cascade/:id/accept', async (req, res) => {
        const { lsInstances } = require('../config');
        const cascadeId = req.params.id;
        if (denyIfUnauthorized(req, res, cascadeId)) return;
        const isReject = !!req.body?.reject;
        // Hub model: with no tracked workspace lsInstances is empty, but the hub
        // connection still serves every cascade — fall back to it.
        let instances = lsInstances;
        if (!instances.length) {
            const { getFirstActiveInstance } = require('../detector');
            const hub = getFirstActiveInstance();
            instances = hub ? [hub] : [];
        }
        console.log(`[ManualInteract] ${isReject ? 'REJECT' : 'ACCEPT'} request for ${cascadeId.substring(0, 8)}, instances: ${instances.length}`);
        try {
            for (const inst of instances) {
                try {
                    let body;
                    if (req.body?.interaction) {
                        // Custom interaction from the UI (gate answers: ask_question responses,
                        // permission allow-once/always/deny, elicitation, …). Don't go through
                        // buildAcceptPayload — it returns null for gates that need a user answer.
                        const provided = req.body.interaction;
                        if (provided.trajectoryId && provided.stepIndex !== undefined) {
                            body = { cascadeId, interaction: provided };
                        } else {
                            // Fill in trajectoryId + stepIndex from the live WAITING step.
                            const { locateWaitingSteps } = require('../auto-accept');
                            const candidates = await locateWaitingSteps(cascadeId, inst);
                            if (!candidates.length) {
                                console.log(`[ManualInteract] Skip ${inst.workspaceName}:${inst.port} — no WAITING step (custom interaction)`);
                                continue;
                            }
                            // With multiple pending gates, target the one whose requested
                            // member matches what the UI answered (e.g. `permission`).
                            const memberKey = Object.keys(provided)
                                .find(k => !['trajectoryId', 'stepIndex', 'timedOut'].includes(k));
                            const match = (memberKey && candidates.find(c =>
                                c.step?.requestedInteraction?.[memberKey] !== undefined
                            )) || candidates[0];
                            body = { cascadeId, interaction: { trajectoryId: match.trajectoryId, stepIndex: match.stepIndex, ...provided } };
                        }
                        console.log(`[ManualInteract] Custom interaction payload:`, JSON.stringify(body.interaction).slice(0, 400));
                    } else {
                        const payload = await buildAcceptPayload(cascadeId, inst);
                        if (!payload) {
                            console.log(`[ManualInteract] Skip ${inst.workspaceName}:${inst.port} — no WAITING step`);
                            continue;
                        }
                        if (isReject) {
                            // Flip the built accept payload into a reject — generic across every
                            // interaction member (run_command/mcp/approval/permission/deploy/…).
                            const { denyInteraction } = require('../auto-accept');
                            body = { cascadeId, interaction: denyInteraction(payload.interaction) };
                            console.log(`[ManualInteract] Reject payload:`, JSON.stringify(body.interaction));
                        } else {
                            body = payload;
                        }
                    }

                    console.log(`[ManualInteract] >>> ${isReject ? 'Rejecting' : 'Accepting'} ${cascadeId.substring(0, 8)} on ${inst.workspaceName}:${inst.port}`);
                    const result = await callApiFireAndForgetOnInstance(inst, 'HandleCascadeUserInteraction', body);

                    if (result.ok) {
                        console.log(`[ManualInteract] +++ ${isReject ? 'REJECTED' : 'ACCEPTED'} via ${inst.workspaceName}`);
                        return res.json(result);
                    }
                    console.log(`[ManualInteract] --- FAILED on ${inst.workspaceName}: ${result.error || result.data}, trying next...`);
                } catch (e) {
                    console.log(`[ManualInteract] !!! Error on ${inst.workspaceName}: ${e.message}`);
                }
            }
            console.log(`[ManualInteract] No instance could ${isReject ? 'reject' : 'accept'} ${cascadeId.substring(0, 8)}`);
            res.status(404).json({ error: 'No WAITING step found on any LS instance' });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Gate options — what choices the IDE would show for the current WAITING interaction.
    // Lets the UI render the exact dynamic option set (esp. permission gates) instead of
    // hardcoding buttons. Returns { kind, ... } or { kind:null } when no gate is pending.
    app.get('/api/cascade/:id/gate', async (req, res) => {
        const cascadeId = req.params.id;
        if (denyIfUnauthorized(req, res, cascadeId)) return;
        try {
            const { lsInstances } = require('../config');
            let instances = lsInstances;
            if (!instances.length) {
                const { getFirstActiveInstance } = require('../detector');
                const hub = getFirstActiveInstance();
                instances = hub ? [hub] : [];
            }
            const { locateWaitingSteps } = require('../auto-accept');
            for (const inst of instances) {
                const candidates = await locateWaitingSteps(cascadeId, inst);
                const gate = candidates.find(c => c.step?.requestedInteraction &&
                    Object.keys(c.step.requestedInteraction).length > 0);
                if (!gate) continue;
                const ri = gate.step.requestedInteraction;
                if (ri.permission) {
                    const { buildPermissionOptions } = require('../interaction-options');
                    const { getSummaries } = require('./../jetbox');
                    const projectId = getSummaries()?.[cascadeId]?.trajectoryMetadata?.projectId || '';
                    const toolName = gate.step.metadata?.toolCall?.name || '';
                    return res.json(buildPermissionOptions(ri.permission, { toolName, projectId }));
                }
                // Other gate kinds (ask_question / elicitation) are rendered by the UI from
                // the step's requestedInteraction spec directly.
                const kind = Object.keys(ri)[0];
                return res.json({ kind, spec: ri[kind] });
            }
            return res.json({ kind: null });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Cancel active cascade invocation
    app.post('/api/cascade/:id/cancel', async (req, res) => {
        if (denyIfUnauthorized(req, res, req.params.id)) return;
        try {
            const inst = resolveInst(req);
            if (!inst) {
                return res.json({ cancelled: false, mode: 'cli' });
            }
            const result = await callApi('CancelCascadeInvocation', {
                cascadeId: req.params.id,
            }, inst);
            res.json(result);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Auto-accept toggle (server-side, instant reaction)
    app.get('/api/auto-accept', (req, res) => {
        res.json({ enabled: getAutoAccept() });
    });
    app.post('/api/auto-accept', (req, res) => {
        const { enabled } = req.body || {};
        setAutoAccept(!!enabled);
        res.json({ enabled: getAutoAccept() });
    });

    // Token usage / generator metadata
    app.get('/api/cascade/:id/metadata', async (req, res) => {
        if (denyIfUnauthorized(req, res, req.params.id)) return;
        try {
            const inst = resolveInst(req);
            if (!inst) return res.status(503).json({ error: 'No language server connected' });
            res.json(await callApi('GetCascadeTrajectoryGeneratorMetadata', {
                cascadeId: req.params.id,
            }, inst));
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // User profile + plan status data
    app.get('/api/user/profile', async (req, res) => {
        try {
            const inst = resolveInst(req);
            if (!inst) {
                return res.json({ user: req.user || {}, profilePicture: null, mode: 'cli' });
            }
            const [status, profile] = await Promise.all([
                callApi('GetUserStatus', {}, inst),
                callApi('GetProfileData', {}, inst)
            ]);
            res.json({
                user: status.userStatus || {},
                profilePicture: profile.profilePicture || null
            });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Delete a cascade conversation (works across both LS and local CLI SQLite DB)
    app.delete('/api/cascade/:id', async (req, res) => {
        const cascadeId = req.params.id;
        if (denyIfUnauthorized(req, res, cascadeId)) return;
        try {
            const inst = resolveInst(req);
            if (inst) {
                try {
                    await callApi('DeleteCascadeTrajectory', { cascadeId }, inst);
                } catch { /* ignore if not present on LS */ }
            }
            const { deleteCliConversation } = require('../cli-conversations');
            const cliRemoved = deleteCliConversation(cascadeId);
            userManager.removeConversationMeta(cascadeId);
            const { cleanupCascade } = require('../cleanup');
            cleanupCascade(cascadeId);
            try {
                require('../ws').broadcastAll({ type: 'conversations_updated' }, req.user?.id || null);
            } catch { /* ignore */ }
            res.json({ success: true, id: cascadeId, cliRemoved });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // === Generic LS Proxy — call any method ===
    // Security: Method whitelist to prevent arbitrary LS method invocation
    app.post('/api/ls/:method', async (req, res) => {
        try {
            const method = req.params.method;
            
            // Validate method against whitelist
            if (!ALLOWED_LS_METHODS.has(method)) {
                return res.status(403).json({ 
                    error: 'Method not allowed',
                    hint: 'This LS method is not in the allowed list for security reasons'
                });
            }
            
            const inst = resolveInst(req);
            if (!inst) {
                const fallback = await handleLsFallback(method, req.body || {});
                if (fallback !== null) return res.json(fallback);
                return res.status(503).json({ error: 'No language server connected' });
            }
            const result = await callApi(method, req.body || {}, inst);
            res.json(result);
        } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
    });
};
