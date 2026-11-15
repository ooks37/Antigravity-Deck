// === Profile & Multi-Account Routes ===
// /api/profiles/*  (Cross-platform IDE profile folder switching)
// /api/accounts/oauth/*  (Headless / VPS / CLI 0-second OAuth credential switching)

const {
    listProfiles,
    getActiveProfile,
    swapProfile,
    createProfile,
    deleteProfile,
    renameProfile,
    getProfileMetadata,
    startAddAccount,
    cancelAddAccount,
    assertProfileSwapSupported,
    getProfileEnvironment,
} = require('../profile-manager');
const {
    listOAuthAccounts,
    saveCurrentOAuthAccount,
    useOAuthAccount,
    importOAuthAccount,
    renameOAuthAccount,
    deleteOAuthAccount,
    fetchAccountQuota,
    rotateOAuthAccount,
    startWebOAuthFlow,
    completeWebOAuthFlow,
} = require('../oauth-accounts');
const { callApi } = require('../api');
const { getFirstActiveInstance } = require('../detector');

const errStatus = (e, fallback) => (e.code === 'EPLATFORM' ? 501 : fallback);

async function resolveCurrentAccountMetadata() {
    const inst = getFirstActiveInstance();
    if (inst) {
        try {
            const userStatus = await callApi('GetUserStatus', {}, inst);
            const email = userStatus?.userStatus?.email || null;
            if (email || userStatus?.userStatus?.name) {
                return {
                    userName: userStatus?.userStatus?.name || null,
                    email,
                    tier: userStatus?.userStatus?.userTier?.name || null,
                    plan: userStatus?.userStatus?.planStatus?.planInfo?.planName || null,
                    savedAt: new Date().toISOString(),
                };
            }
        } catch { /* fall back to local OAuth metadata */ }
    }

    const oauth = listOAuthAccounts();
    if (oauth.activeEmail || oauth.activeName) {
        return {
            userName: oauth.activeName || (oauth.activeEmail ? oauth.activeEmail.split('@')[0] : null),
            email: oauth.activeEmail || null,
            tier: null,
            plan: null,
            savedAt: new Date().toISOString(),
        };
    }
    return null;
}

module.exports = function setupProfilesRoutes(app) {
    // === Unified Profile + OAuth Overview ===
    app.get('/api/profiles', async (req, res) => {
        try {
            const names = listProfiles();
            const profiles = names.map(name => ({ name, meta: getProfileMetadata(name) }));
            const [environment, oauth] = await Promise.all([
                getProfileEnvironment().catch(() => null),
                Promise.resolve().then(() => listOAuthAccounts()).catch(() => null),
            ]);
            res.json({
                profiles,
                active: getActiveProfile(),
                environment,
                oauth,
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.get('/api/profiles/active', (req, res) => {
        res.json({ active: getActiveProfile() });
    });

    app.post('/api/profiles/swap', (req, res) => {
        const { targetProfile } = req.body || {};
        if (!targetProfile) return res.status(400).json({ error: '缺少 targetProfile 参数' });
        swapProfile(targetProfile)
            .then(result => res.json(result))
            .catch(e => {
                const msg = e.message || '';
                const status = msg.includes('正在进行中') ? 409
                    : msg.includes('未找到') ? 404 : errStatus(e, 500);
                res.status(status).json({ error: msg });
            });
    });

    // Auto-create default IDE profile when 0 profiles exist (graceful fallback on VPS/headless)
    app.post('/api/profiles/auto-onboard', async (req, res) => {
        try {
            assertProfileSwapSupported();
            const active = getActiveProfile();
            const existing = listProfiles();
            if (active && existing.length > 0) {
                return res.json({ skipped: true, message: '已有激活的账号档案', active });
            }

            const metadata = await resolveCurrentAccountMetadata();
            const email = metadata?.email;
            if (!email) {
                return res.json({ skipped: true, message: '未检测到在线 IDE 登录态，可先在 OAuth 账号池导入或手动创建档案' });
            }

            const autoName = email.split('@')[0].replace(/[^a-zA-Z0-9_-]/g, '-').substring(0, 30) || 'default';
            const result = createProfile(autoName, metadata);
            res.json({ ...result, autoName });
        } catch (e) {
            res.status(errStatus(e, 400)).json({ error: e.message });
        }
    });

    app.post('/api/profiles/create', async (req, res) => {
        const { name, force } = req.body || {};
        if (!name) return res.status(400).json({ error: '缺少 name 参数' });

        try {
            const metadata = await resolveCurrentAccountMetadata();
            const result = createProfile(name, metadata, { force: !!force });
            res.json(result);
        } catch (e) {
            const status = e.message.includes('已保存为档案') ? 409 : errStatus(e, 400);
            res.status(status).json({ error: e.message });
        }
    });

    app.patch('/api/profiles/:name', (req, res) => {
        const { newName } = req.body || {};
        if (!newName) return res.status(400).json({ error: '缺少 newName 参数' });
        try {
            res.json(renameProfile(req.params.name, newName));
        } catch (e) {
            const status = e.message.includes('未找到') ? 404 : 400;
            res.status(status).json({ error: e.message });
        }
    });

    app.delete('/api/profiles/:name', (req, res) => {
        try {
            res.json(deleteProfile(req.params.name));
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    app.post('/api/profiles/add-account', (req, res) => {
        startAddAccount()
            .then(result => res.json(result))
            .catch(e => res.status(errStatus(e, 500)).json({ error: e.message }));
    });

    app.post('/api/profiles/cancel-add', (req, res) => {
        const { previousProfile } = req.body || {};
        if (!previousProfile) return res.status(400).json({ error: '缺少 previousProfile 参数' });
        cancelAddAccount(previousProfile)
            .then(result => res.json(result))
            .catch(e => res.status(errStatus(e, 500)).json({ error: e.message }));
    });

    // === OAuth / agy CLI Account Pool (0-second headless + cross-platform switch) ===
    app.get('/api/accounts/oauth', (req, res) => {
        try {
            res.json(listOAuthAccounts());
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/accounts/oauth/save', async (req, res) => {
        const { alias, force } = req.body || {};
        try {
            const result = await saveCurrentOAuthAccount(alias || '', { force: !!force });
            res.json(result);
        } catch (e) {
            const status = e.message.includes('已保存为') || e.message.includes('已存在') ? 409 : 400;
            res.status(status).json({ error: e.message });
        }
    });

    app.post('/api/accounts/oauth/import', async (req, res) => {
        const { alias, credentialJson, force, activate } = req.body || {};
        if (!credentialJson) return res.status(400).json({ error: '请提供 OAuth 凭据 JSON' });
        try {
            const result = await importOAuthAccount({
                alias,
                credentialJson,
                force: !!force,
                activate: !!activate,
            });
            res.json(result);
        } catch (e) {
            const status = e.message.includes('已保存为') || e.message.includes('已存在') ? 409 : 400;
            res.status(status).json({ error: e.message });
        }
    });

    app.post('/api/accounts/oauth/use', async (req, res) => {
        const { target, reloadHub, refreshIfExpired } = req.body || {};
        if (!target) return res.status(400).json({ error: '缺少 target 参数' });
        try {
            const result = await useOAuthAccount(target, {
                reloadHub: reloadHub !== false,
                refreshIfExpired: refreshIfExpired !== false,
            });
            res.json(result);
        } catch (e) {
            const status = e.message.includes('未找到') ? 404 : 400;
            res.status(status).json({ error: e.message });
        }
    });

    app.get('/api/accounts/oauth/quota', async (req, res) => {
        const alias = req.query?.alias ? String(req.query.alias) : '';
        try {
            if (alias) {
                const quota = await fetchAccountQuota(alias);
                return res.json(quota);
            }
            const overview = listOAuthAccounts();
            const entries = await Promise.all((overview.accounts || []).map(async (acc) => {
                try {
                    return await fetchAccountQuota(acc.alias);
                } catch (e) {
                    return { alias: acc.alias, email: acc.email || null, error: e.message };
                }
            }));
            res.json({ activeAlias: overview.activeAlias, accounts: entries });
        } catch (e) {
            const status = e.message.includes('未找到') ? 404 : 400;
            res.status(status).json({ error: e.message });
        }
    });

    app.post('/api/accounts/oauth/rotate', async (req, res) => {
        try {
            const result = await rotateOAuthAccount({ reloadHub: req.body?.reloadHub !== false });
            res.json(result);
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    app.post('/api/accounts/oauth/login-url', (req, res) => {
        try {
            const { redirectUri } = req.body || {};
            res.json(startWebOAuthFlow({ redirectUri }));
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    app.post('/api/accounts/oauth/callback', async (req, res) => {
        try {
            const { callbackUrl, code, state, alias, activate } = req.body || {};
            const result = await completeWebOAuthFlow({ callbackUrl, code, state, alias, activate: activate !== false });
            res.json(result);
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    app.patch('/api/accounts/oauth/:alias', (req, res) => {
        const { newAlias } = req.body || {};
        if (!newAlias) return res.status(400).json({ error: '缺少 newAlias 参数' });
        try {
            res.json(renameOAuthAccount(req.params.alias, newAlias));
        } catch (e) {
            const status = e.message.includes('未找到') ? 404 : e.message.includes('已存在') ? 409 : 400;
            res.status(status).json({ error: e.message });
        }
    });

    app.delete('/api/accounts/oauth/:alias', (req, res) => {
        try {
            res.json(deleteOAuthAccount(req.params.alias));
        } catch (e) {
            const status = e.message.includes('未找到') ? 404 : 400;
            res.status(status).json({ error: e.message });
        }
    });
};
