const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const protobuf = require('protobufjs');
const { DatabaseSync } = require('node:sqlite');

const {
    STEP_TYPE_MAP,
    STEP_STATUS_MAP,
    CONTENT_FIELD_MAP,
    NESTED_FIELD_MAPS,
} = require('../src/protobuf');

const {
    isValidCascadeId,
    getCliDbPath,
    hasCliConversation,
    decodeToolCallBytes,
    decodeCliToolPayload,
    readCliConversationSteps,
    listCliConversationIds,
} = require('../src/cli-conversations');

let passed = 0;
let failed = 0;

async function runTest(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`PASS: ${name}`);
    } catch (err) {
        failed++;
        console.error(`FAIL: ${name}`);
        console.error(err);
    }
}

function findKeyByVal(obj, target) {
    for (const [k, v] of Object.entries(obj || {})) {
        if (v === target) return Number(k);
    }
    return null;
}

function encodeStringField(writer, fieldNo, str) {
    writer.uint32((fieldNo << 3) | 2).string(str);
}

function encodeBytesField(writer, fieldNo, buf) {
    writer.uint32((fieldNo << 3) | 2).bytes(buf);
}

function encodeVarintField(writer, fieldNo, val) {
    writer.uint32((fieldNo << 3) | 0).uint32(val);
}

(async () => {
    await runTest('isValidCascadeId and getCliDbPath block path traversal & invalid ids', () => {
        const tmpDir = os.tmpdir();
        assert.strictEqual(isValidCascadeId('../etc/passwd'), false);
        assert.strictEqual(isValidCascadeId('short'), false);
        assert.strictEqual(isValidCascadeId('445998ba-1111-2222-3333-444455556666'), true);
        assert.strictEqual(getCliDbPath('../../secret.db', { cliConversationsDir: tmpDir }), null);
        assert.strictEqual(
            getCliDbPath('445998ba-1111-2222-3333-444455556666', { cliConversationsDir: tmpDir }),
            path.join(path.resolve(tmpDir), '445998ba-1111-2222-3333-444455556666.db'),
        );
    });

    await runTest('decodeToolCallBytes and decodeCliToolPayload parse protobuf binary fields', () => {
        const tcW = protobuf.Writer.create();
        encodeStringField(tcW, 1, 'call_abc');
        encodeStringField(tcW, 2, 'run_command');
        encodeStringField(tcW, 3, '{"command":"uptime"}');
        const tc = decodeToolCallBytes(Buffer.from(tcW.finish()));
        assert.deepStrictEqual(tc, {
            id: 'call_abc',
            name: 'run_command',
            argumentsJson: '{"command":"uptime"}',
        });

        const kvW = protobuf.Writer.create();
        encodeStringField(kvW, 1, 'command');
        encodeStringField(kvW, 2, 'ls -la');
        const resInner = protobuf.Writer.create();
        encodeStringField(resInner, 1, 'ok output');
        const toolW = protobuf.Writer.create();
        encodeBytesField(toolW, 1, kvW.finish());
        encodeBytesField(toolW, 2, resInner.finish());
        const decodedTool = decodeCliToolPayload(Buffer.from(toolW.finish()));
        assert.deepStrictEqual(decodedTool.args, { command: 'ls -la' });
        assert.strictEqual(decodedTool.result, 'ok output');
    });

    await runTest('readCliConversationSteps decodes USER_INPUT, CLI_TOOL, PLANNER_RESPONSE and paginates', () => {
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cli-conv-test-'));
        const cascadeId = '445998ba-abcd-4000-8000-1234567890ab';
        const dbPath = path.join(tmpRoot, `${cascadeId}.db`);

        const userInputTypeId = findKeyByVal(STEP_TYPE_MAP, 'CORTEX_STEP_TYPE_USER_INPUT');
        const plannerTypeId = findKeyByVal(STEP_TYPE_MAP, 'CORTEX_STEP_TYPE_PLANNER_RESPONSE');
        const doneStatusId = findKeyByVal(STEP_STATUS_MAP, 'CORTEX_STEP_STATUS_DONE');
        const userInputFieldNo = findKeyByVal(CONTENT_FIELD_MAP, 'userInput');
        const userRespFieldNo = findKeyByVal(NESTED_FIELD_MAPS.userInput, 'userResponse');
        const plannerRespFieldNo = findKeyByVal(NESTED_FIELD_MAPS.plannerResponse, 'response');

        assert.ok(userInputTypeId !== null && plannerTypeId !== null && doneStatusId !== null);
        assert.ok(userInputFieldNo !== null && userRespFieldNo !== null && plannerRespFieldNo !== null);

        // Step 0: USER_INPUT
        const uInner = protobuf.Writer.create();
        encodeStringField(uInner, userRespFieldNo, 'Check 199 uptime');
        const uPayload = protobuf.Writer.create();
        encodeVarintField(uPayload, 1, userInputTypeId);
        encodeVarintField(uPayload, 4, doneStatusId);
        encodeBytesField(uPayload, userInputFieldNo, uInner.finish());

        // Step 1: CLI_TOOL (step_type 132)
        const metaTc = protobuf.Writer.create();
        encodeStringField(metaTc, 1, 'tc_1');
        encodeStringField(metaTc, 2, 'bt_bash');
        encodeStringField(metaTc, 3, '{"server":"199"}');
        const metaW = protobuf.Writer.create();
        encodeBytesField(metaW, 4, metaTc.finish());

        const kvW = protobuf.Writer.create();
        encodeStringField(kvW, 1, 'server');
        encodeStringField(kvW, 2, '199');
        const resInner = protobuf.Writer.create();
        encodeStringField(resInner, 1, 'up 12 days');
        const cliToolW = protobuf.Writer.create();
        encodeBytesField(cliToolW, 1, kvW.finish());
        encodeBytesField(cliToolW, 2, resInner.finish());

        const cliPayload = protobuf.Writer.create();
        encodeVarintField(cliPayload, 1, 132);
        encodeVarintField(cliPayload, 4, doneStatusId);
        encodeBytesField(cliPayload, 5, metaW.finish());
        encodeBytesField(cliPayload, 140, cliToolW.finish());

        // Step 2: PLANNER_RESPONSE (final reply)
        const pInner = protobuf.Writer.create();
        encodeStringField(pInner, plannerRespFieldNo, '199 has been up for 12 days.');
        const pPayload = protobuf.Writer.create();
        encodeVarintField(pPayload, 1, plannerTypeId);
        encodeVarintField(pPayload, 4, doneStatusId);
        encodeBytesField(pPayload, 20, pInner.finish());

        const db = new DatabaseSync(dbPath);
        try {
            db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, fmt INTEGER, metadata BLOB, step_payload BLOB)');
            const insert = db.prepare('INSERT INTO steps (idx, step_type, status, fmt, metadata, step_payload) VALUES (?, ?, ?, 0, ?, ?)');
            insert.run(0, userInputTypeId, doneStatusId, null, Buffer.from(uPayload.finish()));
            insert.run(1, 132, doneStatusId, Buffer.from(metaW.finish()), Buffer.from(cliPayload.finish()));
            insert.run(2, plannerTypeId, doneStatusId, null, Buffer.from(pPayload.finish()));
        } finally {
            db.close();
        }

        try {
            assert.strictEqual(hasCliConversation(cascadeId, { cliConversationsDir: tmpRoot }), true);
            assert.deepStrictEqual(listCliConversationIds({ cliConversationsDir: tmpRoot }), [cascadeId]);

            const full = readCliConversationSteps(cascadeId, { cliConversationsDir: tmpRoot });
            assert.strictEqual(full.source, 'cli-db');
            assert.strictEqual(full.totalSteps, 3);
            assert.strictEqual(full.baseIndex, 0);
            assert.strictEqual(full.steps.length, 3);

            assert.strictEqual(full.steps[0].type, 'CORTEX_STEP_TYPE_USER_INPUT');
            assert.strictEqual(full.steps[0].userInput.userResponse, 'Check 199 uptime');

            assert.strictEqual(full.steps[1].type, 'CORTEX_STEP_TYPE_CLI_TOOL');
            assert.strictEqual(full.steps[1].cliTool.name, 'bt_bash');
            assert.strictEqual(full.steps[1].cliTool.result, 'up 12 days');
            assert.strictEqual(full.steps[1].metadata.resultJson, 'up 12 days');

            assert.strictEqual(full.steps[2].type, 'CORTEX_STEP_TYPE_PLANNER_RESPONSE');
            assert.strictEqual(full.steps[2].plannerResponse.modifiedResponse, '199 has been up for 12 days.');

            const page = readCliConversationSteps(cascadeId, { cliConversationsDir: tmpRoot, startIndex: 1, endIndex: 3 });
            assert.strictEqual(page.baseIndex, 1);
            assert.strictEqual(page.steps.length, 2);
            assert.strictEqual(page.steps[0].type, 'CORTEX_STEP_TYPE_CLI_TOOL');

            const cnt = readCliConversationSteps(cascadeId, { cliConversationsDir: tmpRoot, countOnly: true });
            assert.strictEqual(cnt.totalSteps, 3);
            assert.strictEqual(cnt.steps.length, 0);
        } finally {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        }
    });

    console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
    process.exit(failed > 0 ? 1 : 0);
})();
