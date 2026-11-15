// === Conversations Routes ===
// /api/workspaces/:name/conversations, /api/models, /api/conversations/*, /api/user, /api/cache

const fs = require('fs');
const { callApi, callApiOnInstance } = require('../api');
const { callApiBinary } = require('../api');
const { countBinarySteps, decodeBinarySteps } = require('../protobuf');
const { STEP_LOAD_CHUNK } = require('../config');
const { lsInstances } = require('../config');
const { stepCache } = require('../cache');
const { getInstanceByName } = require('../detector');
const { resolveInst } = require('./route-helpers');
const {
    hasCliConversation,
    readCliConversationSteps,
    listCliConversationIds,
    extractCliConversationSummary,
} = require('../cli-conversations');
const agyManager = require('../agy-manager');
const userManager = require('../user-manager');
const {
    listOAuthAccounts,
    getActiveAccountQuotaSummary,
    classifyAccountTier,
    isInternalOrNoiseModel,
    buildQuotaPools,
} = require('../oauth-accounts');
const { resolveWorkspacePathByName } = require('../ls-fallback');

// Private helper — clear all step cache
function clearCache() {
    const { cleanupAll } = require('../cleanup');
    return cleanupAll();
}

const GEMINI_PRO_FALLBACK_KEYS = [
    'gemini-3.1-pro-high',
    'gemini-3-pro-high',
    'gemini-2.5-pro',
    'gemini-3.8-flash-tiered',
    'gemini-3-flash',
];

const GEMINI_FLASH_FALLBACK_KEYS = [
    'gemini-3.8-flash-tiered',
    'gemini-3-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
    'gemini-2.5-flash',
];

function matchCloudCodeWithMeta(modelSlug, rawModelsMap) {
    if (!rawModelsMap || typeof rawModelsMap !== 'object' || !modelSlug) return { entry: null, exact: false };
    const lower = String(modelSlug).toLowerCase();
    if (rawModelsMap[lower]) return { entry: rawModelsMap[lower], exact: true };
    const base = lower.replace(/-(low|medium|high|xhigh|max|thinking)$/i, '');
    const candidates = [base, `${base}-tiered`, `${base}-thinking`, `${base}-medium`, `${base}-high`];
    for (const key of candidates) {
        if (rawModelsMap[key]) return { entry: rawModelsMap[key], exact: true };
    }

    // Newer CLI models (e.g. gemini-4-argon-*, gemini-4-hydrogen-*, gemini-pro-orchestrator-*)
    // match their corresponding Pro/Argon or Flash/Hydrogen quota pool before falling back across Gemini.
    if (lower.startsWith('gemini-')) {
        const isPro = /pro|argon|orchestrator/i.test(lower) && !/flash|hydrogen/i.test(lower);
        const fallbackKeys = isPro ? GEMINI_PRO_FALLBACK_KEYS : GEMINI_FLASH_FALLBACK_KEYS;
        for (const key of fallbackKeys) {
            if (rawModelsMap[key]?.quotaInfo) return { entry: rawModelsMap[key], exact: false };
        }
        const anyGemini = Object.entries(rawModelsMap).find(([k, v]) =>
            k.startsWith('gemini-') && !k.includes('image') && !v?.isInternal && v?.quotaInfo
        );
        if (anyGemini) return { entry: anyGemini[1], exact: false };
    } else if (lower.startsWith('claude-')) {
        const isOpus = lower.includes('opus');
        const isSonnet = lower.includes('sonnet');
        const subFamilyMatch = Object.entries(rawModelsMap).find(([k, v]) =>
            k.startsWith('claude-')
            && ((isOpus && k.includes('opus')) || (isSonnet && k.includes('sonnet')))
            && !v?.isInternal
            && v?.quotaInfo
        );
        if (subFamilyMatch) return { entry: subFamilyMatch[1], exact: false };
        const anyClaude = Object.entries(rawModelsMap).find(([k, v]) =>
            k.startsWith('claude-') && !v?.isInternal && v?.quotaInfo
        );
        if (anyClaude) return { entry: anyClaude[1], exact: false };
    } else if (lower.startsWith('gpt-')) {
        const anyGpt = Object.entries(rawModelsMap).find(([k, v]) =>
            k.startsWith('gpt-') && !v?.isInternal && v?.quotaInfo
        );
        if (anyGpt) return { entry: anyGpt[1], exact: false };
    }
    return { entry: null, exact: false };
}

function matchCloudCodeEntry(modelSlug, rawModelsMap) {
    return matchCloudCodeWithMeta(modelSlug, rawModelsMap).entry;
}

function matchCloudCodeQuota(modelSlug, rawModelsMap) {
    return matchCloudCodeEntry(modelSlug, rawModelsMap)?.quotaInfo || null;
}

function classifyModelCategory(m) {
    const hay = `${m.label || ''} ${m.modelId || ''}`.toLowerCase();
    if (hay.includes('claude')) return 'Claude';
    if (hay.includes('gemini') || hay.includes('orchestrator') || hay.includes('argon') || hay.includes('hydrogen')) return 'Gemini';
    if (hay.includes('gpt') || hay.includes('openai')) return 'GPT / OpenAI';
    return '其他模型';
}

function groupModelsByCategory(sourceModels) {
    const buckets = new Map();
    for (const m of sourceModels) {
        const cat = classifyModelCategory(m);
        if (!buckets.has(cat)) buckets.set(cat, []);
        buckets.get(cat).push(m);
    }
    return Array.from(buckets.entries()).map(([name, models]) => ({ name, models }));
}

function buildCliFallbackModels(agyModels, activeSummary) {
    const rawMap = activeSummary?.rawModelsMap || {};
    const sourceModels = Array.isArray(agyModels) && agyModels.length > 0
        ? agyModels.map((m) => {
            const { entry, exact } = matchCloudCodeWithMeta(m.id, rawMap);
            const qi = entry?.quotaInfo || null;
            const slugLower = String(m.id || '').toLowerCase();
            // Flagship Gemini 4 models should be recommended when the shared Gemini pool is active,
            // whereas orchestrator helper slugs stay non-default unless CloudCode explicitly recommends them.
            const isRecommended = exact
                ? Boolean(entry?.recommended)
                : (/^gemini-4-/.test(slugLower) && Boolean(entry?.recommended));
            return {
                label: m.label || entry?.displayName || m.id,
                modelId: m.id,
                cliModelId: m.id,
                supportsImages: entry ? Boolean(entry.supportsImages) : true,
                isRecommended,
                isBeta: false,
                tagTitle: exact ? (entry?.tagTitle || '') : (/^gemini-4-/.test(slugLower) ? 'New' : ''),
                tagDescription: exact ? (entry?.tagDescription || '') : '',
                quota: typeof qi?.remainingFraction === 'number' ? qi.remainingFraction : 1,
                resetTime: qi?.resetTime || null,
            };
        })
        : (activeSummary?.models || [])
            .filter((m) => !isInternalOrNoiseModel(m.modelId, m) && !/-image$/i.test(m.modelId))
            .map((m) => ({
                label: m.displayName || m.modelId,
                modelId: m.modelId,
                cliModelId: m.modelId,
                supportsImages: !!m.supportsImages,
                isRecommended: !!m.recommended,
                isBeta: false,
                tagTitle: m.tagTitle || '',
                tagDescription: m.tagDescription || '',
                quota: typeof m.remainingFraction === 'number' ? m.remainingFraction : 1,
                resetTime: m.resetTime || null,
            }));

    const groups = groupModelsByCategory(sourceModels);
    const recommended = sourceModels.find((m) => m.isRecommended) || sourceModels[0];
    return {
        models: sourceModels,
        groups,
        defaultModel: recommended?.modelId || '',
    };
}

module.exports = function setupConversationsRoutes(app) {
    // Conversations for a specific workspace (filtered by workspace URI)
    app.get('/api/workspaces/:name/conversations', async (req, res) => {
        const wsName = decodeURIComponent(req.params.name);
        const inst = getInstanceByName(wsName);
        if (!inst) {
            if (resolveWorkspacePathByName(wsName)) {
                return res.json({ trajectorySummaries: {} });
            }
            return res.status(400).json({ error: 'Unknown workspace' });
        }

        try {
            // Source: full Jetbox conversation history (all-time). Fall back to the live
            // cascade list only if Jetbox hasn't populated yet (e.g. right after boot).
            const { getSummaries } = require('../jetbox');
            let all = getSummaries();
            if (!all || Object.keys(all).length === 0) {
                const trajData = await callApiOnInstance(inst, 'GetAllCascadeTrajectories');
                all = trajData.trajectorySummaries || {};
            }

            // Filter: only keep cascades whose workspace URI matches this instance.
            // Case-insensitive + decoded comparison (Windows drive letters vary: C: vs c:).
            // Orphans (no workspace URIs) only show in detached instances (no real folder).
            const wsUri = inst.workspaceFolderUri;
            const isDetached = !wsUri || wsUri.startsWith('detached://');
            const normalize = uri => decodeURIComponent(uri || '').toLowerCase().replace(/\/+$/, '');
            const wsUriNorm = normalize(wsUri);
            const filtered = {};
            for (const [id, info] of Object.entries(all)) {
                if (req.user && !userManager.canAccessConversation(id, req.user)) continue;
                const cascadeWsUris = (info.workspaces || []).map(w => w.workspaceFolderAbsoluteUri);
                const isOrphan = !info.workspaces || info.workspaces.length === 0;
                const matchesWorkspace = cascadeWsUris.some(uri => normalize(uri) === wsUriNorm);
                if (matchesWorkspace || (isOrphan && isDetached)) filtered[id] = info;
            }

            res.json({ trajectorySummaries: filtered });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Available models for cascade — merges active OAuth account entitlement & agy CLI fallback
    // so /api/models never crashes with 500 during hub LS reboot after account switch and
    // accurately reflects Free/Jio/Pixel/Pro/Ultra account differences.
    app.get('/api/models', async (req, res) => {
        try {
            const isAdmin = !req.user || req.user.role === 'admin';
            const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
            const oauthOverview = listOAuthAccounts();
            const activeEntry = (oauthOverview.accounts || []).find((a) => a.isActive) || null;
            const activeSummary = await getActiveAccountQuotaSummary({ forceRefresh, includeRaw: true }).catch(() => null);
            const activeEmail = activeSummary?.email || oauthOverview.activeEmail || activeEntry?.email || null;

            const inst = resolveInst(req);
            let lsData = null;
            let lsUserStatus = null;
            let lsFailed = !inst;

            if (inst) {
                const [cfgRes, userRes] = await Promise.allSettled([
                    callApi('GetCascadeModelConfigData', {}, inst),
                    callApi('GetUserStatus', {}, inst),
                ]);
                if (cfgRes.status === 'fulfilled' && cfgRes.value?.clientModelConfigs) {
                    lsData = cfgRes.value;
                } else {
                    lsFailed = true;
                }
                if (userRes.status === 'fulfilled' && userRes.value?.userStatus) {
                    lsUserStatus = userRes.value.userStatus;
                }
            }

            const lsEmail = lsUserStatus?.email || null;
            const lsEmailMatches = !activeEmail || !lsEmail || lsEmail.toLowerCase() === activeEmail.toLowerCase();

            if (lsData && lsEmailMatches) {
                const rawMap = activeSummary?.rawModelsMap || {};
                const mapModel = (m) => {
                    const qi = matchCloudCodeQuota(m.modelId, rawMap);
                    return {
                        label: m.label,
                        modelId: m.modelOrAlias?.model || m.modelOrAlias?.alias || '',
                        cliModelId: m.modelId || '',
                        allowedTiers: Array.isArray(m.allowedTiers) ? m.allowedTiers : [],
                        supportsImages: !!m.supportsImages,
                        isRecommended: !!m.isRecommended,
                        isBeta: !!m.isBeta,
                        tagTitle: m.tagTitle || '',
                        tagDescription: m.tagDescription || '',
                        quota: m.quotaInfo?.remainingFraction ?? qi?.remainingFraction ?? 1,
                        resetTime: m.quotaInfo?.resetTime || qi?.resetTime || null,
                    };
                };

                const configs = (lsData.clientModelConfigs || []).filter((m) => m.disabled !== true);
                const byLabel = new Map(configs.map((m) => [m.label, m]));

                const used = new Set();
                const groups = [];
                const primarySort = (lsData.clientModelSorts || [])[0];
                if (primarySort) {
                    for (const g of (primarySort.groups || [])) {
                        const groupModels = (g.modelLabels || [])
                            .map((label) => byLabel.get(label))
                            .filter(Boolean)
                            .map((m) => { used.add(m.label); return mapModel(m); });
                        if (groupModels.length) groups.push({ name: groups.length === 0 ? (primarySort.name || '') : '', models: groupModels });
                    }
                }
                const leftovers = configs.filter((m) => !used.has(m.label)).map(mapModel);
                if (leftovers.length) groups.push({ name: groups.length ? 'Other' : '', models: leftovers });

                const models = groups.flatMap((g) => g.models);
                const defaultModel = lsData.defaultOverrideModelConfig?.modelOrAlias?.model || models[0]?.modelId || '';
                const tierInfo = classifyAccountTier({
                    userStatus: lsUserStatus,
                    modelsMap: rawMap,
                    agyModels: models.map((m) => ({ id: m.cliModelId || m.modelId, label: m.label })),
                });

                const pools = Array.isArray(activeSummary?.pools) && activeSummary.pools.length > 0
                    ? activeSummary.pools
                    : buildQuotaPools(models);

                return res.json({
                    models,
                    groups,
                    defaultModel,
                    source: 'ls',
                    hubSyncing: false,
                    activeAccount: {
                        alias: isAdmin ? (activeEntry?.alias || null) : null,
                        email: isAdmin ? (activeEmail || lsEmail || null) : null,
                        tierId: activeSummary?.tierId || tierInfo.tierId,
                        tierLabel: activeSummary?.tierLabel || tierInfo.tierLabel,
                        modelCount: models.length,
                        pools,
                    },
                });
            }

            // Hub LS offline, disabled (lightweight CLI mode), or temporarily out of sync:
            // immediately serve active account's real agy CLI / CloudCode models with zero 500 error.
            const agyRes = await agyManager.getAgyModels({ force: forceRefresh }).catch(() => ({ models: [] }));
            const agyList = Array.isArray(agyRes?.models) ? agyRes.models : [];
            const fallback = buildCliFallbackModels(agyList, activeSummary);
            const tierInfo = classifyAccountTier({
                modelsMap: activeSummary?.rawModelsMap || {},
                agyModels: agyList,
            });
            const pools = Array.isArray(activeSummary?.pools) && activeSummary.pools.length > 0
                ? activeSummary.pools
                : buildQuotaPools(fallback.models);

            return res.json({
                ...fallback,
                source: agyList.length ? 'agy-cli' : 'cloudcode',
                hubSyncing: Boolean(process.env.ENABLE_IDE_HUB === 'true' && (lsFailed || !lsEmailMatches)),
                activeAccount: {
                    alias: isAdmin ? (activeEntry?.alias || null) : null,
                    email: isAdmin ? activeEmail : null,
                    tierId: activeSummary?.tierId || tierInfo.tierId,
                    tierLabel: activeSummary?.tierLabel || tierInfo.tierLabel,
                    modelCount: fallback.models.length,
                    pools,
                },
            });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Full conversation history — Jetbox stream + any local antigravity-cli SQLite sessions.
    app.get('/api/conversations', async (req, res) => {
        try {
            const { getSummaries } = require('../jetbox');
            const jetboxSummaries = getSummaries();
            let summaries = jetboxSummaries && Object.keys(jetboxSummaries).length > 0
                ? { ...jetboxSummaries }
                : {};

            if (Object.keys(summaries).length === 0) {
                const seenConns = new Set();
                for (const inst of lsInstances) {
                    const connKey = `${inst.useTls ? 's' : ''}${inst.port}:${inst.csrfToken}`;
                    if (seenConns.has(connKey)) continue;
                    seenConns.add(connKey);
                    try {
                        const data = await callApiOnInstance(inst, 'GetAllCascadeTrajectories');
                        if (data?.trajectorySummaries) Object.assign(summaries, data.trajectorySummaries);
                    } catch { }
                }
            }

            // Merge local CLI SQLite conversations so new agy sessions always appear even when IDE Hub is off
            for (const cliId of listCliConversationIds()) {
                if (req.user && !userManager.canAccessConversation(cliId, req.user)) continue;
                if (!summaries[cliId]) {
                    try {
                        const info = extractCliConversationSummary(cliId);
                        if (info) {
                            summaries[cliId] = {
                                summary: info.summary || `对话 ${cliId.slice(0, 8)}`,
                                stepCount: info.totalSteps || 0,
                                lastModifiedTime: info.lastModifiedTime,
                                createdTime: info.createdTime,
                                source: 'cli-db',
                            };
                        }
                    } catch { /* ignore unreadable db */ }
                }
            }

            const includeEmpty = req.query.includeEmpty === '1';
            const metaMap = userManager.getConversationMetaMap();
            const visibleSummaries = {};
            for (const [id, rawInfo] of Object.entries(summaries)) {
                if (req.user && !userManager.canAccessConversation(id, req.user)) continue;
                const info = { ...rawInfo };
                if (!includeEmpty && (info.stepCount || 0) === 0) continue;
                const meta = metaMap.get(id);
                if (meta?.customTitle) {
                    info.summary = meta.customTitle;
                    info.customTitle = meta.customTitle;
                }
                if (meta?.ownerId) {
                    info.ownerId = meta.ownerId;
                }
                visibleSummaries[id] = info;
            }

            res.json({ trajectorySummaries: visibleSummaries });
        }
        catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Projects (Jetbox ProjectUpdatesStream + ReadProject) with conversation counts —
    // powers the "Projects" grouping in the conversation history view.
    app.get('/api/projects', (req, res) => {
        try {
            const { getProjects } = require('../jetbox');
            res.json({ projects: getProjects() });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Rename a conversation (persisted per owner/admin in SQLite)
    app.patch('/api/conversations/:id', (req, res) => {
        const cascadeId = req.params.id;
        if (req.user && !userManager.canAccessConversation(cascadeId, req.user)) {
            return res.status(403).json({ error: '无权修改该对话' });
        }
        try {
            const actor = req.user || userManager.getPrimaryAdmin();
            const result = userManager.renameConversation(cascadeId, req.body?.title, actor);
            try {
                require('../ws').broadcastAll({ type: 'conversations_updated' }, req.user?.id || null);
            } catch { /* ignore */ }
            return res.json({ success: true, id: cascadeId, title: result.title });
        } catch (e) {
            return res.status(e.statusCode || 400).json({ error: e.message || '重命名失败' });
        }
    });

    // Conversation steps — tries Hub LS first, falls back to local antigravity-cli SQLite DB
    app.get('/api/conversations/:id/steps', async (req, res) => {
        const cascadeId = req.params.id;
        if (req.user && !userManager.canAccessConversation(cascadeId, req.user)) {
            return res.status(403).json({ error: '无权访问该对话' });
        }
        const startIndex = parseInt(req.query.start) || 0;
        const endIndex = parseInt(req.query.end) || 999999;
        try {
            const inst = resolveInst(req);
            if (inst) {
                try {
                    const lsResult = await callApi('GetCascadeTrajectorySteps', {
                        cascadeId,
                        startIndex,
                        endIndex,
                    }, inst);
                    const lsSteps = Array.isArray(lsResult?.steps) ? lsResult.steps : [];
                    if (lsSteps.length > 0 || !hasCliConversation(cascadeId)) {
                        return res.json({ ...lsResult, source: 'ls' });
                    }
                } catch {
                    // Fall through to CLI DB / not-found handling
                }
            }

            const cliResult = readCliConversationSteps(cascadeId, { startIndex, endIndex });
            if (cliResult) {
                return res.json(cliResult);
            }

            return res.json({ steps: [], totalSteps: 0, baseIndex: startIndex, notFound: true, source: 'none' });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Load older steps for scroll-up pagination (binary protobuf for LS, SQLite slice for CLI DB)
    app.get('/api/conversations/:id/steps/older', async (req, res) => {
        try {
            const cascadeId = req.params.id;
            if (req.user && !userManager.canAccessConversation(cascadeId, req.user)) {
                return res.status(403).json({ error: '无权访问该对话' });
            }
            const cache = stepCache[cascadeId];
            if (!cache || (cache.baseIndex || 0) === 0) {
                return res.json({ steps: [], baseIndex: 0, hasMore: false });
            }

            const currentBase = cache.baseIndex || 0;
            const loadFrom = Math.max(0, currentBase - STEP_LOAD_CHUNK);
            const loadTo = currentBase;

            let olderSteps = [];
            if (cache.source === 'cli-db' || hasCliConversation(cascadeId)) {
                const cliRes = readCliConversationSteps(cascadeId, { startIndex: loadFrom, endIndex: loadTo });
                olderSteps = cliRes?.steps || [];
            } else {
                const inst = resolveInst(req);
                if (inst) {
                    const binBuf = await callApiBinary(cascadeId, loadFrom, loadTo, inst);
                    const binCount = countBinarySteps(binBuf);
                    if (binCount > 0) {
                        olderSteps = decodeBinarySteps(binBuf);
                    }
                }
            }

            if (olderSteps.length > 0) {
                cache.steps.unshift(...olderSteps);
                cache.baseIndex = loadFrom;
            }

            res.json({
                steps: olderSteps,
                baseIndex: loadFrom,
                hasMore: loadFrom > 0,
            });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // User info
    app.get('/api/user', async (req, res) => {
        try {
            const inst = resolveInst(req);
            if (!inst) {
                return res.json({ user: req.user || null, mode: 'cli' });
            }
            res.json(await callApi('GetUserStatus', {}, inst));
        }
        catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Cache management
    app.delete('/api/cache', (req, res) => {
        const count = clearCache();
        console.log(`[*] Cache cleared (${count} conversations)`);
        res.json({ cleared: count });
    });

    app.delete('/api/cache/:id', (req, res) => {
        const id = req.params.id;
        if (stepCache[id]) {
            const { cleanupCascade } = require('../cleanup');
            cleanupCascade(id);
            console.log(`[*] Cache cleared for ${id.substring(0, 8)}`);
            res.json({ cleared: true, id });
        } else {
            res.json({ cleared: false, id, message: 'not cached' });
        }
    });
};

module.exports.buildCliFallbackModels = buildCliFallbackModels;
