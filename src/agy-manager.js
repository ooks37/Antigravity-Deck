// === Antigravity CLI (agy) Version Check & Manual Updater ===
// Auto-discovers `agy` across Windows/macOS/Linux without pinning versions,
// reads version & changelog, and exposes a mutex-guarded `agy update` trigger.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const { getSettings } = require('./config');
const { getChildProcessEnv } = require('./proxy-manager');
const { readCliConversationSteps } = require('./cli-conversations');

const defaultExecFileAsync = promisify(execFile);

/** Normalize raw `agy --version` output into a clean version string. */
function parseVersion(rawOutput) {
    const text = String(rawOutput || '').trim();
    if (!text) return null;
    const match = text.match(/v?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/i);
    if (match) return match[1];
    return text.split(/\r?\n/)[0].trim() || null;
}

/** Parse `agy changelog` output into top version + bounded text. */
function parseChangelog(rawOutput, maxLines = 120) {
    const lines = String(rawOutput || '').replace(/\r\n/g, '\n').split('\n');
    let latestEntryVersion = null;
    for (const line of lines) {
        const m = line.match(/^\s*v?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\s*:/i);
        if (m) {
            latestEntryVersion = m[1];
            break;
        }
    }
    const truncated = lines.length > maxLines;
    const text = lines.slice(0, maxLines).join('\n').trim();
    return { latestEntryVersion, text, truncated, totalLines: lines.length };
}

/** Parse `agy models` output (`<id>\t<label>` or whitespace-separated) into model entries. */
function parseAgyModels(rawOutput) {
    const models = [];
    const seen = new Set();
    for (const line of String(rawOutput || '').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || /^Fetching\b/i.test(trimmed) || /^[-=]+$/.test(trimmed)) continue;
        let id = '';
        let label = '';
        if (trimmed.includes('\t')) {
            const parts = trimmed.split('\t');
            id = parts[0].trim();
            label = parts.slice(1).join(' ').trim();
        } else {
            const m = trimmed.match(/^([a-z0-9._-]+)(?:\s+(.*))?$/i);
            if (!m) continue;
            id = m[1].trim();
            label = (m[2] || '').trim();
        }
        if (!id || seen.has(id)) continue;
        seen.add(id);
        models.push({ id, label: label || id });
    }
    return models;
}

/** Parse `agy -p --output-format stream-json` NDJSON output (supports agy 1.5+ event schema + legacy schema). */
function parseAgyStreamJson(rawOutput) {
    const rawLines = String(rawOutput || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const events = [];
    const deltaChunks = [];
    const plainLines = [];
    let finalText = '';
    let sessionId = null;

    for (const line of rawLines) {
        try {
            const obj = JSON.parse(line);
            events.push(obj);
            if (obj.session_id) sessionId = obj.session_id;
            if (obj.conversation_id) sessionId = obj.conversation_id;
            if (obj.result?.conversation_id) sessionId = obj.result.conversation_id;
            if (obj.step_update?.conversation_id) sessionId = obj.step_update.conversation_id;

            // agy 1.5+ stream-json format: { event: 'result', result: { response: '...' } }
            if (obj.event === 'result' && typeof obj.result?.response === 'string' && obj.result.response.trim()) {
                finalText = obj.result.response.trim();
            } else if (obj.event === 'step_update' && obj.step_update?.step_type === 'agent_response' && typeof obj.step_update.text_delta === 'string') {
                deltaChunks.push(obj.step_update.text_delta);
            } else if (typeof obj.result === 'string' && obj.result.trim()) {
                finalText = obj.result.trim();
            } else if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
                const chunks = obj.message.content
                    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
                    .map((c) => c.text)
                    .join('');
                if (chunks) finalText = chunks.trim();
            } else if (typeof obj.text === 'string' && !finalText) {
                finalText = obj.text.trim();
            }
        } catch {
            plainLines.push(line);
        }
    }

    if (!finalText && deltaChunks.length > 0) {
        finalText = deltaChunks.join('').trim();
    }
    if (!finalText && events.length === 0 && plainLines.length > 0) {
        finalText = plainLines.join('\n').trim();
    }

    return {
        sessionId,
        text: finalText,
        eventsCount: events.length,
    };
}

/** Build ordered OS-specific fallback candidate paths for the `agy` binary. */
function getDefaultAgyCandidates(env = process.env, platformName = process.platform, homeDir = os.homedir()) {
    const candidates = [];
    if (env.AGY_BIN && env.AGY_BIN.trim()) {
        candidates.push({ path: env.AGY_BIN.trim(), source: 'env' });
    }

    const pathImpl = platformName === 'win32' ? path.win32 : path.posix;
    if (platformName === 'win32') {
        const localAppData = env.LOCALAPPDATA || pathImpl.join(homeDir, 'AppData', 'Local');
        candidates.push(
            { path: pathImpl.join(localAppData, 'agy', 'bin', 'agy.exe'), source: 'default-win32' },
            { path: pathImpl.join(homeDir, '.local', 'bin', 'agy.exe'), source: 'default-local' },
            { path: pathImpl.join(homeDir, '.agy', 'bin', 'agy.exe'), source: 'default-agy' },
        );
    } else {
        candidates.push(
            { path: pathImpl.join(homeDir, '.local', 'bin', 'agy'), source: 'default-local' },
            { path: pathImpl.join(homeDir, '.agy', 'bin', 'agy'), source: 'default-agy' },
            { path: '/usr/local/bin/agy', source: 'default-usr-local' },
            { path: '/opt/homebrew/bin/agy', source: 'default-homebrew' },
            { path: '/usr/bin/agy', source: 'default-usr' },
        );
    }

    return candidates;
}

/** Create an `agy` manager instance (injectable dependencies for testing). */
function createAgyManager(deps = {}) {
    const execFileAsync = deps.execFileAsync || defaultExecFileAsync;
    const spawnFn = deps.spawn || spawn;
    const readCliSteps = deps.readCliConversationSteps || readCliConversationSteps;
    const existsSync = deps.existsSync || fs.existsSync;
    const statSync = deps.statSync || fs.statSync;
    const getAppSettings = deps.getSettings || getSettings;
    const env = deps.env || process.env;
    const platformName = deps.platform || process.platform;
    const homeDir = deps.homeDir || os.homedir();

    let updating = false;
    let lastUpdateAt = null;
    let lastUpdateResult = null;
    let cachedStatus = null;
    let cachedModels = null;
    let cachedModelsAt = 0;
    let modelsEpoch = 0;
    let modelsRefreshPromise = null;

    function isExecutableFile(filePath) {
        if (!filePath || typeof filePath !== 'string' || filePath.includes('\0')) return false;
        try {
            return existsSync(filePath) && statSync(filePath).isFile();
        } catch {
            return false;
        }
    }

    async function resolveFromPathLookup() {
        const locator = platformName === 'win32' ? 'where.exe' : 'which';
        try {
            const { stdout } = await execFileAsync(locator, ['agy'], { timeout: 3000, windowsHide: true });
            const lines = String(stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
            for (const line of lines) {
                if (isExecutableFile(line)) return line;
            }
        } catch {
            // `agy` not on PATH
        }
        return null;
    }

    async function findAgyBinary(customPathOverride) {
        const settings = getAppSettings() || {};
        const configuredPath = typeof customPathOverride === 'string'
            ? customPathOverride.trim()
            : String(settings.agyBinaryPath || '').trim();

        if (configuredPath) {
            if (configuredPath.includes('\0')) {
                return { found: false, path: null, configuredPath, source: 'settings', error: '自定义 agy 路径包含非法字符' };
            }
            if (isExecutableFile(configuredPath)) {
                return { found: true, path: configuredPath, configuredPath, source: 'settings' };
            }
            return {
                found: false,
                path: null,
                configuredPath,
                source: 'settings',
                error: `指定的 agy 可执行文件不存在: ${configuredPath}`,
            };
        }

        for (const candidate of getDefaultAgyCandidates(env, platformName, homeDir)) {
            if (isExecutableFile(candidate.path)) {
                return { found: true, path: candidate.path, configuredPath: '', source: candidate.source };
            }
        }

        const fromPath = await resolveFromPathLookup();
        if (fromPath) {
            return { found: true, path: fromPath, configuredPath: '', source: 'path' };
        }

        return {
            found: false,
            path: null,
            configuredPath: '',
            source: null,
            error: '未检测到 agy CLI，请先安装或手动填写 agy 可执行文件路径',
        };
    }

    function buildAgyEnv() {
        const merged = getChildProcessEnv({ ...env, HOME: env.HOME || homeDir || os.homedir() });
        if (!merged.HOME) merged.HOME = homeDir || os.homedir();
        return merged;
    }

    async function runAgy(binPath, args, timeoutMs = 15000, cwd = undefined) {
        return execFileAsync(binPath, args, {
            timeout: timeoutMs,
            windowsHide: true,
            maxBuffer: 4 * 1024 * 1024,
            env: buildAgyEnv(),
            ...(cwd ? { cwd } : {}),
        });
    }

    async function getAgyStatus({ refresh = true, customPath } = {}) {
        if (!refresh && cachedStatus && !customPath) {
            return { ...cachedStatus, updating, lastUpdateAt, lastUpdateResult };
        }

        const binary = await findAgyBinary(customPath);
        if (!binary.found) {
            const status = {
                found: false,
                path: null,
                configuredPath: binary.configuredPath,
                source: binary.source,
                version: null,
                platform: platformName,
                updating,
                lastUpdateAt,
                lastUpdateResult,
                error: binary.error,
            };
            if (!customPath) cachedStatus = status;
            return status;
        }

        let version = null;
        let versionError = null;
        try {
            const { stdout, stderr } = await runAgy(binary.path, ['--version'], 8000);
            version = parseVersion(`${stdout || ''}\n${stderr || ''}`);
        } catch (err) {
            versionError = err.message;
        }

        const status = {
            found: true,
            path: binary.path,
            configuredPath: binary.configuredPath,
            source: binary.source,
            version,
            platform: platformName,
            updating,
            lastUpdateAt,
            lastUpdateResult,
            ...(versionError ? { error: `读取 agy 版本失败: ${versionError}` } : {}),
        };
        if (!customPath) cachedStatus = status;
        return status;
    }

    async function getAgyChangelog({ customPath, limit = 120 } = {}) {
        const binary = await findAgyBinary(customPath);
        if (!binary.found) {
            return { found: false, error: binary.error, text: '', latestEntryVersion: null, truncated: false, totalLines: 0 };
        }

        const safeLimit = Math.min(Math.max(Number(limit) || 120, 10), 400);
        try {
            const { stdout, stderr } = await runAgy(binary.path, ['changelog'], 12000);
            const parsed = parseChangelog(stdout || stderr || '', safeLimit);
            return { found: true, path: binary.path, ...parsed };
        } catch (err) {
            return {
                found: true,
                path: binary.path,
                error: `读取更新日志失败: ${err.message}`,
                text: '',
                latestEntryVersion: null,
                truncated: false,
                totalLines: 0,
            };
        }
    }

    async function updateAgy({ customPath } = {}) {
        if (updating) {
            return {
                statusCode: 409,
                success: false,
                inProgress: true,
                error: 'agy 正在更新中，请稍候完成后再试',
            };
        }

        const binary = await findAgyBinary(customPath);
        if (!binary.found) {
            return {
                statusCode: 404,
                success: false,
                error: binary.error,
            };
        }

        updating = true;
        let previousVersion = null;
        try {
            try {
                const before = await runAgy(binary.path, ['--version'], 8000);
                previousVersion = parseVersion(`${before.stdout || ''}\n${before.stderr || ''}`);
            } catch {
                // Keep null if --version failed before update
            }

            const { stdout, stderr } = await runAgy(binary.path, ['update'], 180000);
            const output = `${stdout || ''}${stderr ? `\n${stderr}` : ''}`.trim();

            let currentVersion = previousVersion;
            try {
                const after = await runAgy(binary.path, ['--version'], 8000);
                currentVersion = parseVersion(`${after.stdout || ''}\n${after.stderr || ''}`) || previousVersion;
            } catch {
                // Keep best-effort version
            }

            const updated = Boolean(previousVersion && currentVersion && previousVersion !== currentVersion);
            const result = {
                statusCode: 200,
                success: true,
                path: binary.path,
                previousVersion,
                version: currentVersion,
                updated,
                output: output || (updated ? `已更新至 ${currentVersion}` : `当前已是最新版本 (${currentVersion || '未知'})`),
                checkedAt: new Date().toISOString(),
            };

            lastUpdateAt = result.checkedAt;
            lastUpdateResult = {
                success: true,
                previousVersion,
                version: currentVersion,
                updated,
                output: result.output,
            };
            cachedStatus = null;
            return result;
        } catch (err) {
            const detail = [err.message, err.stdout, err.stderr]
                .map((s) => String(s || '').trim())
                .filter(Boolean)
                .join('\n');
            const message = detail || '执行 agy update 失败';
            lastUpdateAt = new Date().toISOString();
            lastUpdateResult = {
                success: false,
                previousVersion,
                version: previousVersion,
                updated: false,
                error: message,
            };
            return {
                statusCode: 500,
                success: false,
                path: binary.path,
                previousVersion,
                version: previousVersion,
                error: message,
            };
        } finally {
            updating = false;
        }
    }

    const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

    function normalizeEffort(effort) {
        if (!effort || typeof effort !== 'string') return null;
        const clean = effort.trim().toLowerCase();
        return VALID_EFFORTS.has(clean) ? clean : null;
    }

    function invalidateModelsCache() {
        cachedModels = null;
        cachedModelsAt = 0;
        modelsEpoch += 1;
        modelsRefreshPromise = null;
    }

    async function resolveAgyModelId(model, modelLabel, effort = null) {
        const raw = typeof model === 'string' ? model.trim() : '';
        const lbl = typeof modelLabel === 'string' ? modelLabel.trim() : '';
        const cleanEffort = normalizeEffort(effort);
        if (!raw && !lbl) return null;

        // Already a known agy slug format (lowercase hyphenated, not LS placeholder)
        if (raw && !raw.startsWith('MODEL_') && !raw.includes(' ') && /^[a-z0-9._-]+$/.test(raw)) {
            if (!cleanEffort) return raw;
            const listRes = await getAgyModels().catch(() => null);
            const available = Array.isArray(listRes?.models) ? listRes.models : [];
            const baseSlug = raw.replace(/-(low|medium|high|xhigh|max)$/i, '');
            const byEffort = available.find((m) => m.id.toLowerCase() === `${baseSlug}-${cleanEffort}`);
            return byEffort ? byEffort.id : raw;
        }

        const listRes = await getAgyModels();
        const available = Array.isArray(listRes?.models) ? listRes.models : [];
        const needle = (lbl || raw).toLowerCase();
        const baseNeedle = needle.replace(/\s*\((low|medium|high|xhigh|max|thinking)\)\s*$/i, '').trim();

        if (cleanEffort && baseNeedle && available.length > 0) {
            const exactWithEffort = available.find((m) => {
                const ml = m.label.toLowerCase();
                return ml === `${baseNeedle} (${cleanEffort})` || m.id.toLowerCase().endsWith(`-${cleanEffort}`) && ml.startsWith(baseNeedle);
            });
            if (exactWithEffort) return exactWithEffort.id;
        }

        if (needle && available.length > 0) {
            const byId = available.find((m) => m.id.toLowerCase() === needle);
            if (byId) return byId.id;
            const byLabel = available.find((m) => m.label.toLowerCase() === needle);
            if (byLabel) return byLabel.id;
            if (baseNeedle) {
                const byBase = available.find((m) => m.label.toLowerCase().replace(/\s*\((low|medium|high|xhigh|max|thinking)\)\s*$/i, '').trim() === baseNeedle);
                if (byBase) return byBase.id;
            }
        }

        // Convert friendly label like "Gemini 3.8 Flash" + effort "low" -> "gemini-3.8-flash-low"
        if (lbl) {
            const baseSlug = baseNeedle.replace(/[^a-z0-9.]+/g, '-').replace(/^-|-$/g, '');
            if (cleanEffort && (!available.length || available.some((m) => m.id === `${baseSlug}-${cleanEffort}`))) {
                return `${baseSlug}-${cleanEffort}`;
            }
            const slug = lbl.toLowerCase().replace(/[()]/g, ' ').trim().replace(/[^a-z0-9.]+/g, '-').replace(/^-|-$/g, '');
            if (slug && (!available.length || available.some((m) => m.id === slug))) {
                return slug;
            }
        }
        return raw && !raw.startsWith('MODEL_') ? raw : null;
    }

    async function preparePromptExecution({ prompt, model, modelLabel, effort, conversationId, workspace } = {}) {
        if (!prompt || !String(prompt).trim()) {
            return { ok: false, errorResult: { statusCode: 400, success: false, error: 'prompt 不能为空' } };
        }
        const binary = await findAgyBinary();
        if (!binary.found) {
            return { ok: false, errorResult: { statusCode: 404, success: false, error: binary.error || '未检测到 agy CLI' } };
        }

        const args = ['-p', String(prompt).trim(), '--output-format', 'stream-json'];
        const cleanEffort = normalizeEffort(effort);
        const resolvedModel = await resolveAgyModelId(model, modelLabel, cleanEffort).catch(() => null);
        if (resolvedModel) {
            args.push('--model', resolvedModel);
        }
        const resolvedSuffix = resolvedModel ? (resolvedModel.match(/-(low|medium|high|xhigh|max)$/i)?.[1]?.toLowerCase() || null) : null;
        if (cleanEffort && (!resolvedSuffix || resolvedSuffix === cleanEffort)) {
            args.push('--effort', cleanEffort);
        }
        const cleanConvId = (conversationId && typeof conversationId === 'string' && /^[a-zA-Z0-9_-]{8,128}$/.test(conversationId.trim()))
            ? conversationId.trim()
            : null;
        if (cleanConvId) {
            args.push('--conversation', cleanConvId);
        }
        const cwd = workspace && typeof workspace === 'string' && existsSync(workspace) ? workspace : undefined;
        return { ok: true, binary, args, cleanEffort, resolvedModel, cleanConvId, cwd };
    }

    async function runAgyPrompt({ prompt, model, modelLabel, effort, conversationId, workspace, timeoutMs = 120000 } = {}) {
        const prep = await preparePromptExecution({ prompt, model, modelLabel, effort, conversationId, workspace });
        if (!prep.ok) return prep.errorResult;
        const { binary, args, cleanEffort, resolvedModel, cwd } = prep;

        try {
            const { stdout, stderr } = await runAgy(binary.path, args, timeoutMs, cwd);
            const parsed = parseAgyStreamJson(stdout);
            return {
                statusCode: 200,
                success: true,
                path: binary.path,
                model: resolvedModel || null,
                effort: cleanEffort || null,
                sessionId: parsed.sessionId,
                text: parsed.text || String(stdout || '').trim(),
                eventsCount: parsed.eventsCount,
                stderr: String(stderr || '').trim() || null,
            };
        } catch (err) {
            const detail = String(err?.stderr || err?.stdout || err?.message || 'agy 执行失败').trim();
            return {
                statusCode: 500,
                success: false,
                path: binary.path,
                error: detail.split(/\r?\n/)[0].slice(0, 300),
                detail: detail.slice(0, 2000),
            };
        }
    }

    async function refreshAgyModelsLocked() {
        if (modelsRefreshPromise) return modelsRefreshPromise;
        const epochAtStart = modelsEpoch;
        modelsRefreshPromise = (async () => {
            const binary = await findAgyBinary();
            if (!binary.found) {
                return { statusCode: 404, success: false, error: binary.error, models: [] };
            }
            try {
                const { stdout } = await runAgy(binary.path, ['models'], 10000);
                const raw = String(stdout || '').trim();
                const models = parseAgyModels(raw);
                if (epochAtStart === modelsEpoch) {
                    cachedModels = { raw, models };
                    cachedModelsAt = Date.now();
                }
                return { statusCode: 200, success: true, raw, models };
            } catch (err) {
                return { statusCode: 500, success: false, error: err.message, models: [] };
            }
        })();
        try {
            return await modelsRefreshPromise;
        } finally {
            modelsRefreshPromise = null;
        }
    }

    async function getAgyModels({ force = false } = {}) {
        const ageMs = Date.now() - cachedModelsAt;
        if (!force && cachedModels) {
            // Fresh within 5 min; stale-while-revalidate up to 12 hours so /api/models never blocks
            if (ageMs < 300000) {
                return { statusCode: 200, success: true, ...cachedModels };
            }
            if (ageMs < 43200000) {
                refreshAgyModelsLocked().catch(() => {});
                return { statusCode: 200, success: true, ...cachedModels };
            }
        }
        return refreshAgyModelsLocked();
    }

    function streamAgyPrompt({ prompt, model, modelLabel, effort, conversationId, workspace, timeoutMs = 180000, onSpawn } = {}, onEvent = () => {}) {
        return (async () => {
            const prep = await preparePromptExecution({ prompt, model, modelLabel, effort, conversationId, workspace });
            if (!prep.ok) return prep.errorResult;
            const { binary, args, cleanEffort, resolvedModel, cleanConvId, cwd } = prep;

            const startedAt = Date.now();
            let sessionId = cleanConvId || null;
            let turnBaseIndex = 0;
            if (cleanConvId) {
                try {
                    const countRes = readCliSteps(cleanConvId, { homeDir, countOnly: true });
                    turnBaseIndex = Number(countRes?.totalSteps) || 0;
                } catch { /* non-fatal */ }
            }

            let emittedInit = false;
            let fullText = '';
            let finalResultText = '';
            let eventsCount = 0;
            let lastThinking = '';
            let lastStepSig = '';
            let lastPhase = 'thinking';
            let stderrBuf = '';
            let stdoutBuf = '';
            let aborted = false;
            let timedOut = false;

            const safeEmit = (ev) => {
                try { onEvent(ev); } catch { /* ignore listener errors */ }
            };

            const maybeEmitInit = (sid) => {
                if (!sid || emittedInit) return;
                emittedInit = true;
                sessionId = sid;
                safeEmit({
                    type: 'init',
                    sessionId: sid,
                    model: resolvedModel || null,
                    effort: cleanEffort || null,
                });
            };

            const syncCliDbProgress = () => {
                if (!sessionId) return;
                try {
                    const res = readCliSteps(sessionId, { homeDir, startIndex: turnBaseIndex });
                    if (!res || !Array.isArray(res.steps)) return;
                    const thinkingParts = [];
                    for (const step of res.steps) {
                        const thought = step?.plannerResponse?.thinking;
                        if (typeof thought === 'string' && thought.trim()) {
                            thinkingParts.push(thought.trim());
                        }
                    }
                    const joinedThinking = thinkingParts.join('\n\n');
                    if (joinedThinking && joinedThinking !== lastThinking) {
                        lastThinking = joinedThinking;
                        safeEmit({
                            type: 'thinking',
                            text: joinedThinking,
                            elapsedMs: Date.now() - startedAt,
                        });
                    }
                    const sig = `${res.totalSteps}:${res.steps.map((s) => `${s.type || ''}:${s.status || ''}:${s.plannerResponse?.thinking?.length || 0}`).join(',')}`;
                    if (sig !== lastStepSig) {
                        lastStepSig = sig;
                        safeEmit({
                            type: 'turn_steps',
                            sessionId,
                            baseIndex: turnBaseIndex,
                            steps: res.steps,
                            totalSteps: res.totalSteps,
                        });
                    }
                } catch { /* DB may not exist or be mid-commit */ }
            };

            const processNdjsonLine = (line) => {
                const trimmed = String(line || '').trim();
                if (!trimmed.startsWith('{')) return;
                let obj;
                try { obj = JSON.parse(trimmed); } catch { return; }
                eventsCount++;

                const evName = obj.event || obj.type;
                const su = obj.step_update || (evName === 'step_update' ? obj : null);
                const resObj = obj.result || (evName === 'result' ? obj : null);

                const sid = obj.conversation_id || su?.conversation_id || resObj?.conversation_id || obj.session_id;
                if (sid && typeof sid === 'string') {
                    maybeEmitInit(sid);
                }

                if (su) {
                    const st = su.step_type || '';
                    if (st === 'agent_response') {
                        const delta = su.text_delta || su.delta || '';
                        if (delta) {
                            if (lastPhase !== 'answering') {
                                lastPhase = 'answering';
                                safeEmit({ type: 'status', phase: 'answering', elapsedMs: Date.now() - startedAt });
                            }
                            fullText += delta;
                            safeEmit({ type: 'text_delta', text: delta, fullText });
                        } else if (su.status === 'DONE' && typeof su.response === 'string' && su.response && !fullText) {
                            fullText = su.response;
                            safeEmit({ type: 'text_delta', text: su.response, fullText });
                        }
                    } else if (st === 'tool') {
                        if (lastPhase !== 'tool') {
                            lastPhase = 'tool';
                            safeEmit({ type: 'status', phase: 'tool', elapsedMs: Date.now() - startedAt });
                        }
                        safeEmit({
                            type: 'tool',
                            name: su.tool_name || su.name || 'tool',
                            status: su.status || 'ACTIVE',
                            info: su.tool_info || null,
                            elapsedMs: Date.now() - startedAt,
                        });
                        syncCliDbProgress();
                    }
                }

                if (resObj && typeof resObj.response === 'string') {
                    finalResultText = resObj.response.trim();
                } else if (typeof obj.response === 'string' && evName === 'result') {
                    finalResultText = obj.response.trim();
                }
            };

            return await new Promise((resolve) => {
                const child = spawnFn(binary.path, args, {
                    cwd,
                    env: buildAgyEnv(),
                    windowsHide: true,
                    stdio: ['ignore', 'pipe', 'pipe'],
                });

                if (typeof onSpawn === 'function') {
                    onSpawn(() => {
                        aborted = true;
                        try { child.kill('SIGTERM'); } catch { /* ignore */ }
                    });
                }

                safeEmit({ type: 'status', phase: 'thinking', elapsedMs: 0 });
                if (sessionId) maybeEmitInit(sessionId);

                const pollIntervalMs = Number(optsTimeoutCheck(deps.dbPollMs, 350));
                const dbTimer = setInterval(syncCliDbProgress, pollIntervalMs);
                const killTimer = setTimeout(() => {
                    timedOut = true;
                    try { child.kill('SIGTERM'); } catch { /* ignore */ }
                    setTimeout(() => {
                        try { child.kill('SIGKILL'); } catch { /* ignore */ }
                    }, 2000).unref();
                }, Math.max(5000, Number(timeoutMs) || 180000));

                child.stdout?.on('data', (chunk) => {
                    stdoutBuf += chunk.toString('utf8');
                    const lines = stdoutBuf.split(/\r?\n/);
                    stdoutBuf = lines.pop() || '';
                    for (const l of lines) processNdjsonLine(l);
                });

                child.stderr?.on('data', (chunk) => {
                    if (stderrBuf.length < 16384) stderrBuf += chunk.toString('utf8');
                });

                const finalize = (errMsg = null) => {
                    clearInterval(dbTimer);
                    clearTimeout(killTimer);
                    if (stdoutBuf.trim()) {
                        processNdjsonLine(stdoutBuf);
                        stdoutBuf = '';
                    }
                    syncCliDbProgress();

                    const text = (finalResultText || fullText).trim();
                    if (aborted) {
                        return resolve({ statusCode: 499, success: false, error: '已取消生成', sessionId, text, eventsCount });
                    }
                    if (timedOut) {
                        return resolve({ statusCode: 504, success: false, error: 'agy 执行超时', sessionId, text, eventsCount });
                    }
                    if (errMsg && !text) {
                        return resolve({ statusCode: 500, success: false, error: errMsg, sessionId, text, eventsCount });
                    }
                    return resolve({
                        statusCode: 200,
                        success: true,
                        sessionId,
                        model: resolvedModel || null,
                        effort: cleanEffort || null,
                        text,
                        thinking: lastThinking || undefined,
                        eventsCount,
                    });
                };

                child.on('error', (err) => finalize(err?.message || '启动 agy CLI 失败'));
                child.on('close', (code) => {
                    if (code && code !== 0 && !finalResultText && !fullText) {
                        const detail = stderrBuf.trim() || `agy 退出码 ${code}`;
                        return finalize(detail);
                    }
                    return finalize(null);
                });
            });
        })();
    }

    function optsTimeoutCheck(v, fallback) {
        const n = Number(v);
        return Number.isFinite(n) && n >= 20 ? n : fallback;
    }

    return {
        findAgyBinary,
        getAgyStatus,
        getAgyChangelog,
        updateAgy,
        runAgyPrompt,
        streamAgyPrompt,
        getAgyModels,
        invalidateModelsCache,
    };
}

const defaultManager = createAgyManager();

module.exports = {
    createAgyManager,
    parseVersion,
    parseChangelog,
    parseAgyModels,
    parseAgyStreamJson,
    getDefaultAgyCandidates,
    ...defaultManager,
};
