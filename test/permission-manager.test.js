const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPermissionManager, validatePermissionRule } = require('../src/permission-manager');

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
    console.log('\n[Test] permission-manager unit tests');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-deck-perm-'));

    try {
        await runTest('reads defaults cleanly when CLI settings file does not exist', () => {
            let autoAccept = false;
            const settingsPath = path.join(tmpDir, 'missing', 'settings.json');
            const pm = createPermissionManager({
                settingsPath,
                getAutoAccept: () => autoAccept,
                setAutoAccept: (v) => { autoAccept = !!v; },
            });
            const state = pm.getState();
            assert.strictEqual(state.autoAccept, false);
            assert.strictEqual(state.fileExists, false);
            assert.strictEqual(state.cli.agentMode, 'default');
            assert.strictEqual(state.cli.toolPermission, 'request-review');
            assert.strictEqual(state.cli.artifactReviewPolicy, 'asks-for-review');
            assert.deepStrictEqual(state.cli.permissions, { allow: [], ask: [], deny: [] });
        });

        await runTest('preserves unknown keys and stores sparse non-default CLI fields + rules', () => {
            let autoAccept = false;
            const settingsPath = path.join(tmpDir, 'preserve', 'settings.json');
            fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
            fs.writeFileSync(settingsPath, JSON.stringify({
                $schema: 'https://antigravity.google/schemas/v1/settings.json',
                colorScheme: 'tokyo night',
                model: 'Gemini 3.1 Pro',
            }, null, 2));

            const pm = createPermissionManager({
                settingsPath,
                getAutoAccept: () => autoAccept,
                setAutoAccept: (v) => { autoAccept = !!v; },
            });

            const next = pm.updatePermissions({
                autoAccept: true,
                cli: {
                    agentMode: 'accept-edits',
                    toolPermission: 'proceed-in-sandbox',
                    enableTerminalSandbox: true,
                    permissions: {
                        allow: [' command(git) ', 'command(git)', 'read_file(*)', 'command(regex:npm run (build|test))'],
                        deny: ['command(rm -rf)'],
                    },
                },
            });

            assert.strictEqual(next.autoAccept, true);
            assert.strictEqual(next.cli.agentMode, 'accept-edits');
            assert.strictEqual(next.cli.toolPermission, 'proceed-in-sandbox');
            assert.strictEqual(next.cli.enableTerminalSandbox, true);
            assert.deepStrictEqual(next.cli.permissions.allow, [
                'command(git)',
                'read_file(*)',
                'command(regex:npm run (build|test))',
            ]);
            assert.deepStrictEqual(next.cli.permissions.deny, ['command(rm -rf)']);

            const savedRaw = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            assert.strictEqual(savedRaw.colorScheme, 'tokyo night');
            assert.strictEqual(savedRaw.model, 'Gemini 3.1 Pro');
            assert.strictEqual(savedRaw.$schema, 'https://antigravity.google/schemas/v1/settings.json');
        });

        await runTest('resetting back to default removes sparse keys cleanly without touching unknown fields', () => {
            let autoAccept = true;
            const settingsPath = path.join(tmpDir, 'preserve', 'settings.json');
            const pm = createPermissionManager({
                settingsPath,
                getAutoAccept: () => autoAccept,
                setAutoAccept: (v) => { autoAccept = !!v; },
            });

            const res = pm.applyPreset('default');
            assert.strictEqual(res.autoAccept, false);
            assert.strictEqual(res.cli.agentMode, 'default');
            assert.strictEqual(res.cli.toolPermission, 'request-review');

            const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            assert.strictEqual('agentMode' in raw, false);
            assert.strictEqual('toolPermission' in raw, false);
            assert.strictEqual(raw.colorScheme, 'tokyo night');
        });

        await runTest('rejects malformed permission rules cleanly', () => {
            assert.strictEqual(validatePermissionRule(' mcp(github/*) '), 'mcp(github/*)');
            assert.throws(() => validatePermissionRule('invalid_rule'), /格式无效/);
            assert.throws(() => validatePermissionRule('unknown_action(foo)'), /不支持的动作类型/);
            assert.throws(() => validatePermissionRule('command(   )'), /target 不能为空/);
            assert.throws(() => validatePermissionRule('command(ls\nrm -rf)'), /换行/);
        });
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
    process.exit(failed > 0 ? 1 : 0);
})();
