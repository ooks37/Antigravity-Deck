// === Pure Node.js Reader for antigravity-cli SQLite Conversations ===
// agy CLI stores conversations in ~/.gemini/antigravity-cli/conversations/<cascadeId>.db
// while antigravity-hub LS serves ~/.gemini/antigravity/conversations/. When Jetbox lists
// CLI conversations in the sidebar, LS returns API 404 on GetCascadeTrajectorySteps.
// This module reads & decodes those SQLite protobuf rows natively via Node 22+ `node:sqlite`.

const os = require('os');
const fs = require('fs');
const path = require('path');
const protobuf = require('protobufjs');
const {
    STEP_TYPE_MAP,
    STEP_STATUS_MAP,
    CONTENT_FIELD_MAP,
    NESTED_FIELD_MAPS,
    decodeMetadata,
    decodeGenericMessage,
    decodeRequestedInteraction,
} = require('./protobuf');

const SAFE_CASCADE_ID_RE = /^[a-zA-Z0-9_-]{8,128}$/;

let sqliteModule = null;
function getDatabaseSync() {
    if (sqliteModule === false) return null;
    if (sqliteModule) return sqliteModule.DatabaseSync;
    try {
        sqliteModule = require('node:sqlite');
        return sqliteModule.DatabaseSync;
    } catch {
        sqliteModule = false;
        return null;
    }
}

function getCliConversationsDir(opts = {}) {
    if (opts.cliConversationsDir) return opts.cliConversationsDir;
    if (process.env.AGY_CONVERSATIONS_DIR) return process.env.AGY_CONVERSATIONS_DIR;
    const homeDir = opts.homeDir || os.homedir();
    return path.join(homeDir, '.gemini', 'antigravity-cli', 'conversations');
}

function isValidCascadeId(cascadeId) {
    return typeof cascadeId === 'string' && SAFE_CASCADE_ID_RE.test(cascadeId);
}

function getCliDbPath(cascadeId, opts = {}) {
    if (!isValidCascadeId(cascadeId)) return null;
    const dir = path.resolve(getCliConversationsDir(opts));
    const dbPath = path.resolve(dir, `${cascadeId}.db`);
    if (!dbPath.startsWith(dir + path.sep)) return null;
    return dbPath;
}

function hasCliConversation(cascadeId, opts = {}) {
    const dbPath = getCliDbPath(cascadeId, opts);
    return !!(dbPath && fs.existsSync(dbPath));
}

function decodeToolCallBytes(buf) {
    if (!buf || buf.length === 0) return null;
    const reader = protobuf.Reader.create(buf);
    const tc = {};
    while (reader.pos < reader.len) {
        try {
            const tag = reader.uint32();
            const fn = tag >>> 3;
            const wt = tag & 7;
            if (wt === 2 && (fn === 1 || fn === 2 || fn === 3)) {
                const str = Buffer.from(reader.bytes()).toString('utf-8');
                if (fn === 1) tc.id = str;
                else if (fn === 2) tc.name = str;
                else if (fn === 3) tc.argumentsJson = str;
            } else {
                reader.skipType(wt);
            }
        } catch { break; }
    }
    return tc.name || tc.id || tc.argumentsJson ? tc : null;
}

function decodeMetadataWithToolCall(buf) {
    const meta = decodeMetadata(buf) || {};
    const reader = protobuf.Reader.create(buf);
    while (reader.pos < reader.len) {
        try {
            const tag = reader.uint32();
            const fn = tag >>> 3;
            const wt = tag & 7;
            if (fn === 4 && wt === 2) {
                const tc = decodeToolCallBytes(Buffer.from(reader.bytes()));
                if (tc) {
                    meta.toolCall = tc;
                    if (!meta.name && tc.name) meta.name = tc.name;
                    if (!meta.argumentsJson && tc.argumentsJson) meta.argumentsJson = tc.argumentsJson;
                }
            } else {
                reader.skipType(wt);
            }
        } catch { break; }
    }
    return meta;
}

function decodeCliPlannerResponse(buf) {
    const base = decodeGenericMessage(buf, NESTED_FIELD_MAPS.plannerResponse) || {};
    const reader = protobuf.Reader.create(buf);
    const toolCalls = [];
    while (reader.pos < reader.len) {
        try {
            const tag = reader.uint32();
            const fn = tag >>> 3;
            const wt = tag & 7;
            if (fn === 7 && wt === 2) {
                const tc = decodeToolCallBytes(Buffer.from(reader.bytes()));
                if (tc) toolCalls.push(tc);
            } else {
                reader.skipType(wt);
            }
        } catch { break; }
    }
    if (toolCalls.length > 0) base.toolCalls = toolCalls;
    // Remove raw unparsed field 7 string if decoded cleanly into toolCalls
    if (base[7] && toolCalls.length > 0) delete base[7];
    // Ensure chat-helpers renders final text replies (not pure tool-call thoughts)
    if (!base.modifiedResponse && base.response && toolCalls.length === 0) {
        base.modifiedResponse = base.response;
    }
    return base;
}

function decodeKvPair(buf) {
    const reader = protobuf.Reader.create(buf);
    let key = '';
    let val = '';
    while (reader.pos < reader.len) {
        try {
            const tag = reader.uint32();
            const fn = tag >>> 3;
            const wt = tag & 7;
            if (wt === 2 && (fn === 1 || fn === 2)) {
                const s = Buffer.from(reader.bytes()).toString('utf-8');
                if (fn === 1) key = s;
                else if (fn === 2) val = s;
            } else {
                reader.skipType(wt);
            }
        } catch { break; }
    }
    return key ? [key, val] : null;
}

function decodeCliToolPayload(buf) {
    const reader = protobuf.Reader.create(buf);
    const args = {};
    let result = '';
    while (reader.pos < reader.len) {
        try {
            const tag = reader.uint32();
            const fn = tag >>> 3;
            const wt = tag & 7;
            if (fn === 1 && wt === 2) {
                const pair = decodeKvPair(Buffer.from(reader.bytes()));
                if (pair) {
                    const [k, v] = pair;
                    try { args[k] = (v.startsWith('{') || v.startsWith('[')) ? JSON.parse(v) : v; }
                    catch { args[k] = v; }
                }
            } else if (fn === 2 && wt === 2) {
                // Result container often wraps UTF-8 result string in field 1
                const sub = Buffer.from(reader.bytes());
                const r2 = protobuf.Reader.create(sub);
                let extracted = '';
                while (r2.pos < r2.len) {
                    try {
                        const t2 = r2.uint32();
                        const f2 = t2 >>> 3;
                        const w2 = t2 & 7;
                        if (f2 === 1 && w2 === 2) {
                            extracted = Buffer.from(r2.bytes()).toString('utf-8');
                            break;
                        }
                        r2.skipType(w2);
                    } catch { break; }
                }
                result = extracted || sub.toString('utf-8');
            } else {
                reader.skipType(wt);
            }
        } catch { break; }
    }
    return { args, result };
}

function decodeCliStepRow(row) {
    const step = {
        type: STEP_TYPE_MAP[row.step_type] || (row.step_type === 132 ? 'CORTEX_STEP_TYPE_CLI_TOOL' : `CORTEX_STEP_TYPE_UNKNOWN_${row.step_type}`),
        status: STEP_STATUS_MAP[row.status] || `CORTEX_STEP_STATUS_UNKNOWN_${row.status}`,
    };

    const payloadBuf = row.step_payload ? Buffer.from(row.step_payload) : null;
    if (payloadBuf && payloadBuf.length > 0) {
        const reader = protobuf.Reader.create(payloadBuf);
        while (reader.pos < reader.len) {
            try {
                const tag = reader.uint32();
                const fn = tag >>> 3;
                const wt = tag & 7;
                if (fn === 1 && wt === 0) {
                    const typeId = reader.uint32();
                    step.type = STEP_TYPE_MAP[typeId] || (typeId === 132 ? 'CORTEX_STEP_TYPE_CLI_TOOL' : `CORTEX_STEP_TYPE_UNKNOWN_${typeId}`);
                } else if (fn === 4 && wt === 0) {
                    const statusId = reader.uint32();
                    step.status = STEP_STATUS_MAP[statusId] || `CORTEX_STEP_STATUS_UNKNOWN_${statusId}`;
                } else if (fn === 5 && wt === 2) {
                    step.metadata = decodeMetadataWithToolCall(Buffer.from(reader.bytes()));
                } else if (fn === 20 && wt === 2) {
                    step.plannerResponse = decodeCliPlannerResponse(Buffer.from(reader.bytes()));
                } else if (fn === 56 && wt === 2) {
                    const ri = decodeRequestedInteraction(Buffer.from(reader.bytes()));
                    if (Object.keys(ri).length > 0) step.requestedInteraction = ri;
                } else if (fn === 140 && wt === 2) {
                    const cliTool = decodeCliToolPayload(Buffer.from(reader.bytes()));
                    step.cliTool = cliTool;
                } else if (wt === 2 && CONTENT_FIELD_MAP[fn]) {
                    const key = CONTENT_FIELD_MAP[fn];
                    step[key] = decodeGenericMessage(Buffer.from(reader.bytes()), NESTED_FIELD_MAPS[key] || null);
                } else {
                    reader.skipType(wt);
                }
            } catch { break; }
        }
    }

    if (!step.metadata && row.metadata) {
        step.metadata = decodeMetadataWithToolCall(Buffer.from(row.metadata));
    }

    if (step.cliTool && step.metadata?.toolCall?.name) {
        step.cliTool.name = step.metadata.toolCall.name;
        if (!step.metadata.resultJson && step.cliTool.result) {
            step.metadata.resultJson = step.cliTool.result;
        }
    } else if (step.cliTool && !step.metadata?.argumentsJson && Object.keys(step.cliTool.args || {}).length > 0) {
        step.metadata = step.metadata || {};
        step.metadata.argumentsJson = JSON.stringify(step.cliTool.args);
    }

    if (step.type === 'CORTEX_STEP_TYPE_USER_INPUT' && step.userInput) {
        const cleanText = step.userInput.userResponse || step.userInput.items?.map((i) => i.text || '').join('\n') || '';
        if (cleanText) {
            step.userInput = { userResponse: cleanText, items: [{ text: cleanText }] };
        }
    }

    return step;
}

function readCliConversationSteps(cascadeId, opts = {}) {
    const dbPath = getCliDbPath(cascadeId, opts);
    if (!dbPath || !fs.existsSync(dbPath)) return null;

    const DatabaseSync = getDatabaseSync();
    if (!DatabaseSync) return null;

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
        const countRow = db.prepare('SELECT COUNT(*) AS cnt FROM steps').get();
        const totalSteps = Number(countRow?.cnt || 0);
        if (opts.countOnly) {
            return { totalSteps, steps: [], baseIndex: 0, source: 'cli-db' };
        }

        const startIndex = Math.max(0, Number(opts.startIndex) || 0);
        const rawEnd = opts.endIndex !== undefined ? Number(opts.endIndex) : totalSteps;
        const endIndex = Math.min(totalSteps, Number.isFinite(rawEnd) ? rawEnd : totalSteps);
        if (endIndex <= startIndex || totalSteps === 0) {
            return { totalSteps, steps: [], baseIndex: startIndex, source: 'cli-db' };
        }

        const rows = db
            .prepare('SELECT idx, step_type, status, metadata, step_payload FROM steps WHERE idx >= ? AND idx < ? ORDER BY idx ASC')
            .all(startIndex, endIndex);
        const steps = rows.map(decodeCliStepRow);
        return { steps, totalSteps, baseIndex: startIndex, source: 'cli-db' };
    } finally {
        db.close();
    }
}

function listCliConversationIds(opts = {}) {
    const dir = getCliConversationsDir(opts);
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.db'))
        .map((f) => f.slice(0, -3))
        .filter(isValidCascadeId);
}

module.exports = {
    getCliConversationsDir,
    isValidCascadeId,
    getCliDbPath,
    hasCliConversation,
    decodeToolCallBytes,
    decodeCliToolPayload,
    decodeCliStepRow,
    readCliConversationSteps,
    listCliConversationIds,
};
