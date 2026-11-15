const assert = require('assert');
const {
    createAgyManager,
    parseVersion,
    parseChangelog,
    getDefaultAgyCandidates,
} = require('../src/agy-manager');

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
    console.log('\n[Test] agy-manager unit tests');

    await runTest('parseVersion handles prefixed and plain versions', () => {
        assert.strictEqual(parseVersion('1.5.9\n'), '1.5.9');
        assert.strictEqual(parseVersion('agy version v1.6.0-beta.1'), '1.6.0-beta.1');
        assert.strictEqual(parseVersion('   '), null);
    });

    await runTest('parseChangelog extracts latest version and bounds lines', () => {
        const sample = ['1.5.8:', '· Feature A', '· Feature B', '1.5.7:', '· Older'].join('\n');
        const parsed = parseChangelog(sample, 10);
        assert.strictEqual(parsed.latestEntryVersion, '1.5.8');
        assert.strictEqual(parsed.truncated, false);
        assert.strictEqual(parsed.totalLines, 5);
    });

    await runTest('getDefaultAgyCandidates includes Windows and POSIX paths', () => {
        const win = getDefaultAgyCandidates({ LOCALAPPDATA: 'C:\\Users\\demo\\AppData\\Local' }, 'win32', 'C:\\Users\\demo');
        assert.ok(win.some((c) => c.path.endsWith('agy\\bin\\agy.exe')));
        const linux = getDefaultAgyCandidates({ AGY_BIN: '/custom/agy' }, 'linux', '/home/demo');
        assert.strictEqual(linux[0].path, '/custom/agy');
        assert.ok(linux.some((c) => c.path === '/usr/local/bin/agy'));
    });

    await runTest('findAgyBinary prioritizes valid configured settings path', async () => {
        const fakeBin = 'C:\\tools\\agy.exe';
        const mgr = createAgyManager({
            getSettings: () => ({ agyBinaryPath: fakeBin }),
            existsSync: (p) => p === fakeBin,
            statSync: () => ({ isFile: () => true }),
            execFileAsync: async () => ({ stdout: '', stderr: '' }),
        });
        const res = await mgr.findAgyBinary();
        assert.strictEqual(res.found, true);
        assert.strictEqual(res.path, fakeBin);
        assert.strictEqual(res.source, 'settings');
    });

    await runTest('findAgyBinary reports clear error when configured path is missing', async () => {
        const mgr = createAgyManager({
            getSettings: () => ({ agyBinaryPath: '/nope/missing-agy' }),
            existsSync: () => false,
            statSync: () => ({ isFile: () => false }),
            execFileAsync: async () => ({ stdout: '', stderr: '' }),
        });
        const res = await mgr.findAgyBinary();
        assert.strictEqual(res.found, false);
        assert.ok(res.error.includes('/nope/missing-agy'));
    });

    await runTest('updateAgy runs update, compares versions, and guards concurrent calls', async () => {
        const fakeBin = '/usr/local/bin/agy';
        let currentVer = '1.5.8';
        let releaseUpdate;
        const updateStarted = new Promise((resolve) => {
            releaseUpdate = resolve;
        });
        let finishUpdate;
        const blockUpdate = new Promise((resolve) => {
            finishUpdate = resolve;
        });

        const mgr = createAgyManager({
            getSettings: () => ({ agyBinaryPath: fakeBin }),
            existsSync: (p) => p === fakeBin,
            statSync: () => ({ isFile: () => true }),
            execFileAsync: async (_bin, args) => {
                if (args[0] === '--version') return { stdout: `${currentVer}\n`, stderr: '' };
                if (args[0] === 'update') {
                    releaseUpdate();
                    await blockUpdate;
                    currentVer = '1.6.0';
                    return { stdout: 'Updated to 1.6.0\n', stderr: '' };
                }
                return { stdout: '', stderr: '' };
            },
        });

        const firstPromise = mgr.updateAgy();
        await updateStarted;
        const concurrentResult = await mgr.updateAgy();
        assert.strictEqual(concurrentResult.statusCode, 409);
        assert.strictEqual(concurrentResult.inProgress, true);

        finishUpdate();
        const firstResult = await firstPromise;
        assert.strictEqual(firstResult.statusCode, 200);
        assert.strictEqual(firstResult.success, true);
        assert.strictEqual(firstResult.previousVersion, '1.5.8');
        assert.strictEqual(firstResult.version, '1.6.0');
        assert.strictEqual(firstResult.updated, true);

        const afterStatus = await mgr.getAgyStatus({ refresh: false });
        assert.strictEqual(afterStatus.version, '1.6.0');
    });

    await runTest('parseAgyModels & parseAgyStreamJson extract models and final agent response cleanly', async () => {
        const { parseAgyModels, parseAgyStreamJson } = require('../src/agy-manager');
        const models = parseAgyModels(
            'Fetching available models...\n' +
            'gemini-4-argon-medium\tGemini 4 Argon (Medium)\n' +
            'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n',
        );
        assert.deepStrictEqual(models, [
            { id: 'gemini-4-argon-medium', label: 'Gemini 4 Argon (Medium)' },
            { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
        ]);

        const ndjson = [
            JSON.stringify({ event: 'init', conversation_id: 'conv-123' }),
            JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'conv-123', step_type: 'agent_response', text_delta: '82 主机 ' } }),
            JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'conv-123', step_type: 'agent_response', text_delta: '在线' } }),
            JSON.stringify({ event: 'result', result: { conversation_id: 'conv-123', status: 'SUCCESS', response: '82 主机正常，负载 0.12。\n' } }),
        ].join('\n');
        const parsed = parseAgyStreamJson(ndjson);
        assert.strictEqual(parsed.sessionId, 'conv-123');
        assert.strictEqual(parsed.text, '82 主机正常，负载 0.12。');
        assert.strictEqual(parsed.eventsCount, 4);

        const fakeBin = '/usr/local/bin/agy';
        let capturedArgs = null;
        const mgr = createAgyManager({
            getSettings: () => ({ agyBinaryPath: fakeBin }),
            existsSync: (p) => p === fakeBin,
            statSync: () => ({ isFile: () => true }),
            execFileAsync: async (_bin, args) => {
                if (args[0] === 'models') {
                    return { stdout: 'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n', stderr: '' };
                }
                capturedArgs = args;
                return { stdout: ndjson, stderr: '' };
            },
        });
        const runRes = await mgr.runAgyPrompt({
            prompt: 'check 82',
            model: 'MODEL_PLACEHOLDER_M999',
            modelLabel: 'Gemini 3.8 Flash (Low)',
        });
        assert.strictEqual(runRes.statusCode, 200);
        assert.strictEqual(runRes.model, 'gemini-3.8-flash-low');
        assert.strictEqual(runRes.text, '82 主机正常，负载 0.12。');
        assert.ok(capturedArgs.includes('gemini-3.8-flash-low'));
    });

    console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
    process.exit(failed > 0 ? 1 : 0);
})();
