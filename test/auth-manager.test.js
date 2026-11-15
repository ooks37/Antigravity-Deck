const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-deck-auth-'));
const tmpKeyFile = path.join(tmpDir, '.auth-key');
const tmpEcoFile = path.join(tmpDir, 'ecosystem.config.cjs');
const prevEnvKeyFile = process.env.AG_AUTH_KEY_FILE;
const prevEnvEcoFile = process.env.AG_ECOSYSTEM_FILE;
const prevAuthKey = process.env.AUTH_KEY;

process.env.AG_AUTH_KEY_FILE = tmpKeyFile;
process.env.AG_ECOSYSTEM_FILE = tmpEcoFile;
delete process.env.AUTH_KEY;

const {
    getEffectiveAuthKey,
    verifyAuthKey,
    syncStartupAuthKey,
    setCustomAuthKey,
} = require('../src/auth-manager');

let passed = 0;
let failed = 0;

async function runTest(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  PASS ${name}`);
    } catch (err) {
        failed++;
        console.error(`  FAIL ${name}:`, err.message);
    }
}

(async () => {
    console.log('\n[Test] auth-manager unit tests');
    try {
        await runTest('syncStartupAuthKey loads .auth-key into AUTH_KEY and verifies securely', () => {
            fs.writeFileSync(tmpKeyFile, 'initial-secret-123\n', 'utf8');
            const synced = syncStartupAuthKey();
            assert.strictEqual(synced, 'initial-secret-123');
            assert.strictEqual(getEffectiveAuthKey(), 'initial-secret-123');
            assert.strictEqual(verifyAuthKey('initial-secret-123'), true);
            assert.strictEqual(verifyAuthKey('wrong-key'), false);
        });

        await runTest('setCustomAuthKey rejects wrong currentKey, short keys, and syncs .auth-key + ecosystem.config.cjs', () => {
            fs.writeFileSync(tmpEcoFile, "module.exports = { apps: [{ env: { AUTH_KEY: 'initial-secret-123' } }] };\n");
            assert.throws(() => setCustomAuthKey('newpass123', { currentKey: 'bad' }), /当前密钥验证失败/);
            assert.throws(() => setCustomAuthKey('abc', { currentKey: 'initial-secret-123' }), /4 到 128/);

            const res = setCustomAuthKey('my-custom-pass-888', { currentKey: 'initial-secret-123' });
            assert.strictEqual(res.updated, true);
            assert.strictEqual(getEffectiveAuthKey(), 'my-custom-pass-888');
            assert.strictEqual(verifyAuthKey('my-custom-pass-888'), true);
            assert.strictEqual(verifyAuthKey('initial-secret-123'), false);

            assert.strictEqual(fs.readFileSync(tmpKeyFile, 'utf8').trim(), 'my-custom-pass-888');
            assert.ok(fs.readFileSync(tmpEcoFile, 'utf8').includes("AUTH_KEY: 'my-custom-pass-888'"));
        });
    } finally {
        if (prevEnvKeyFile === undefined) delete process.env.AG_AUTH_KEY_FILE;
        else process.env.AG_AUTH_KEY_FILE = prevEnvKeyFile;
        if (prevEnvEcoFile === undefined) delete process.env.AG_ECOSYSTEM_FILE;
        else process.env.AG_ECOSYSTEM_FILE = prevEnvEcoFile;
        if (prevAuthKey === undefined) delete process.env.AUTH_KEY;
        else process.env.AUTH_KEY = prevAuthKey;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
    process.exit(failed > 0 ? 1 : 0);
})();
