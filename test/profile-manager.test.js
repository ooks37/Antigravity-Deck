const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    getAntigravityDataDir,
    getProfilesDir,
    assertProfileSwapSupported,
    createProfile,
    listProfiles,
    swapProfile,
    renameProfile,
    deleteProfile,
    startAddAccount,
    cancelAddAccount,
    getProfileMetadata,
} = require('../src/profile-manager');

const {
    validateAlias,
    extractAccountMeta,
    importOAuthAccount,
    listOAuthAccounts,
    useOAuthAccount,
    saveCurrentOAuthAccount,
    renameOAuthAccount,
    deleteOAuthAccount,
} = require('../src/oauth-accounts');

let passed = 0;
let failed = 0;

async function runTest(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  PASS ${name}`);
    } catch (err) {
        failed++;
        console.error(`  FAIL ${name}:`, err.stack || err.message);
    }
}

function makeFakeJwt(payloadObj) {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
    return `${header}.${body}.fakesig`;
}

function makeMemorySettings(initial = {}) {
    let state = { activeProfile: null, profilesDir: null, ...initial };
    return {
        getSettings: () => ({ ...state }),
        saveSettings: (updates) => {
            state = { ...state, ...updates };
            return { ...state };
        },
    };
}

(async () => {
    console.log('\n[Test] profile-manager + oauth-accounts unit tests');

    await runTest('cross-platform path resolution works for win32, linux, and darwin', () => {
        assertProfileSwapSupported({ platform: 'linux' });
        assertProfileSwapSupported({ platform: 'darwin' });
        assertProfileSwapSupported({ platform: 'win32' });
        assert.throws(() => assertProfileSwapSupported({ platform: 'freebsd' }), (e) => e.code === 'EPLATFORM');

        assert.strictEqual(
            getAntigravityDataDir({ platform: 'win32', homeDir: 'C:\\Users\\a', appDataDir: 'C:\\Users\\a\\AppData\\Roaming' }),
            path.join('C:\\Users\\a\\AppData\\Roaming', 'Antigravity')
        );
        assert.strictEqual(
            getAntigravityDataDir({ platform: 'linux', homeDir: '/home/vps', xdgConfigHome: '' }),
            path.join('/home/vps', '.config', 'Antigravity')
        );
        assert.strictEqual(
            getAntigravityDataDir({ platform: 'darwin', homeDir: '/Users/mac' }),
            path.join('/Users/mac', 'Library', 'Application Support', 'Antigravity')
        );

        const mem = makeMemorySettings();
        assert.strictEqual(
            getProfilesDir({ platform: 'linux', homeDir: '/home/vps', xdgConfigHome: '', ...mem }),
            path.join('/home/vps', '.config', 'AntigravityDeck', 'profiles')
        );
    });

    await runTest('IDE profile lifecycle create, rename, swap, add-account, cancel, and delete on simulated Linux VPS', async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-prof-test-'));
        try {
            const mem = makeMemorySettings();
            const opts = {
                platform: 'linux',
                homeDir: tmp,
                xdgConfigHome: path.join(tmp, '.config'),
                skipIdeControl: true,
                ...mem,
            };

            // Seed account A inside .config/Antigravity and .gemini
            const ideDir = getAntigravityDataDir(opts);
            const geminiDir = path.join(tmp, '.gemini');
            fs.mkdirSync(ideDir, { recursive: true });
            fs.mkdirSync(geminiDir, { recursive: true });
            fs.writeFileSync(path.join(ideDir, 'session.txt'), 'account-a');
            fs.writeFileSync(path.join(geminiDir, 'state.json'), '{"user":"a"}');

            const createdA = createProfile('alpha', { email: 'alpha@example.com', userName: 'Alpha' }, {}, opts);
            assert.strictEqual(createdA.created, true);
            assert.strictEqual(mem.getSettings().activeProfile, 'alpha');

            // Start add-account moves current out cleanly
            const added = await startAddAccount(opts);
            assert.strictEqual(added.success, true);
            assert.strictEqual(added.previousProfile, 'alpha');
            assert.strictEqual(mem.getSettings().activeProfile, null);
            assert.strictEqual(fs.existsSync(path.join(ideDir, 'session.txt')), false);

            // Simulate login as account B and create profile beta
            fs.mkdirSync(ideDir, { recursive: true });
            fs.writeFileSync(path.join(ideDir, 'session.txt'), 'account-b');
            createProfile('beta', { email: 'beta@example.com', userName: 'Beta' }, {}, opts);
            assert.strictEqual(mem.getSettings().activeProfile, 'beta');
            assert.deepStrictEqual(listProfiles(opts), ['alpha', 'beta']);

            // Rename inactive profile alpha -> alpha_main
            renameProfile('alpha', 'alpha_main', opts);
            assert.deepStrictEqual(listProfiles(opts), ['alpha_main', 'beta']);
            assert.strictEqual(getProfileMetadata('alpha_main', opts).email, 'alpha@example.com');

            // Swap from beta -> alpha_main
            const swapped = await swapProfile('alpha_main', opts);
            assert.strictEqual(swapped.activeProfile, 'alpha_main');
            assert.strictEqual(fs.readFileSync(path.join(ideDir, 'session.txt'), 'utf8'), 'account-a');
            assert.strictEqual(fs.readFileSync(path.join(geminiDir, 'state.json'), 'utf8'), '{"user":"a"}');

            // Start add-account then cancel-add restores alpha_main
            await startAddAccount(opts);
            assert.strictEqual(mem.getSettings().activeProfile, null);
            await cancelAddAccount('alpha_main', opts);
            assert.strictEqual(mem.getSettings().activeProfile, 'alpha_main');
            assert.strictEqual(fs.readFileSync(path.join(ideDir, 'session.txt'), 'utf8'), 'account-a');

            // Delete inactive beta succeeds; deleting active alpha_main throws
            assert.throws(() => deleteProfile('alpha_main', opts));
            const del = deleteProfile('beta', opts);
            assert.strictEqual(del.deleted, true);
            assert.deepStrictEqual(listProfiles(opts), ['alpha_main']);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    await runTest('OAuth account validation rejects traversal and empty/missing tokens', () => {
        assert.throws(() => validateAlias('../evil'));
        assert.throws(() => validateAlias('bad/name'));
        assert.throws(() => validateAlias('bad space'));
        assert.strictEqual(validateAlias('主账号_1-test'), '主账号_1-test');

        const meta = extractAccountMeta({
            id_token: makeFakeJwt({ email: 'demo@example.com', name: 'Demo User' }),
            token: { access_token: 'sec-access', refresh_token: 'sec-refresh', expiry: '2099-01-01T00:00:00Z' },
        });
        assert.strictEqual(meta.email, 'demo@example.com');
        assert.strictEqual(meta.name, 'Demo User');
        assert.strictEqual(meta.format, 'agy-cred');
        assert.strictEqual(meta.hasRefreshToken, true);
        assert.strictEqual('access_token' in meta, false);
        assert.strictEqual('refresh_token' in meta, false);
    });

    await runTest('OAuth pool import, switch (use), save current, rename, delete, never leaks raw tokens', async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-oauth-test-'));
        try {
            let credWrites = 0;
            const opts = {
                homeDir: tmp,
                platform: 'linux',
                useCredMan: true,
                writeWindowsCred: async () => { credWrites++; return true; },
            };

            const credA = {
                token: {
                    access_token: 'SECRET_ACCESS_A',
                    refresh_token: 'SECRET_REFRESH_A',
                    token_type: 'Bearer',
                    expiry: '2099-06-01T00:00:00.000Z',
                },
                auth_method: 'consumer',
                id_token: makeFakeJwt({ email: 'first@example.com', name: 'First' }),
            };
            const credB = {
                access_token: 'SECRET_ACCESS_B',
                refresh_token: 'SECRET_REFRESH_B',
                token_type: 'Bearer',
                expiry_date: 4090000000000,
                id_token: makeFakeJwt({ email: 'second@example.com', name: 'Second' }),
            };

            const impA = await importOAuthAccount({ alias: '主号', credentialJson: JSON.stringify(credA), activate: true }, opts);
            assert.strictEqual(impA.imported, true);
            assert.strictEqual(impA.activated, true);
            assert.strictEqual(JSON.stringify(impA).includes('SECRET_'), false);

            const impB = await importOAuthAccount({ alias: 'work', credentialJson: credB, activate: false }, opts);
            assert.strictEqual(impB.imported, true);
            assert.strictEqual(JSON.stringify(impB).includes('SECRET_'), false);

            let listed = listOAuthAccounts(opts);
            assert.strictEqual(listed.activeEmail, 'first@example.com');
            assert.strictEqual(listed.activeAlias, '主号');
            assert.strictEqual(listed.accounts.length, 2);
            assert.strictEqual(JSON.stringify(listed).includes('SECRET_'), false);

            // Switch to work (test Windows CredMan hook on win32 too)
            const switched = await useOAuthAccount('work', { ...opts, platform: 'win32' });
            assert.strictEqual(switched.success, true);
            assert.strictEqual(switched.credManSynced, true);
            assert.strictEqual(credWrites, 1);

            const activeOAuth = JSON.parse(fs.readFileSync(path.join(tmp, '.gemini', 'oauth_creds.json'), 'utf8'));
            assert.strictEqual(activeOAuth.access_token, 'SECRET_ACCESS_B');
            assert.strictEqual(activeOAuth.email, 'second@example.com');

            const gAcc = JSON.parse(fs.readFileSync(path.join(tmp, '.gemini', 'google_accounts.json'), 'utf8'));
            assert.strictEqual(gAcc.active, 'second@example.com');
            assert.ok(gAcc.old.includes('first@example.com'));

            // Rename and save current check
            const ren = renameOAuthAccount('主号', 'personal', opts);
            assert.strictEqual(ren.newAlias, 'personal');

            // Duplicate email blocked without force, allowed with force
            await assert.rejects(() => saveCurrentOAuthAccount('work_copy', { force: false }, opts));
            const savedCopy = await saveCurrentOAuthAccount('work_copy', { force: true }, opts);
            assert.strictEqual(savedCopy.saved, true);

            const del = deleteOAuthAccount('work_copy', opts);
            assert.strictEqual(del.deleted, true);

            listed = listOAuthAccounts(opts);
            assert.deepStrictEqual(listed.accounts.map(a => a.alias), ['personal', 'work']);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    console.log(`\nSummary: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
})();
