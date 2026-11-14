// === Antigravity Permission Manager ===
// Manages BOTH:
//   1) Antigravity Deck real-time autoAccept toggle (via getAutoAccept/setAutoAccept)
//   2) Official Antigravity CLI/Agent permissions engine in ~/.gemini/antigravity-cli/settings.json
// Preserves all unknown keys in settings.json using sparse, atomic (0o600) persistence.

const fs = require('fs');
const os = require('os');
const path = require('path');

const VALID_AGENT_MODES = ['default', 'accept-edits', 'auto', 'plan'];
const VALID_TOOL_PERMISSIONS = ['request-review', 'proceed-in-sandbox', 'always-proceed', 'strict'];
const VALID_ARTIFACT_POLICIES = ['asks-for-review', 'agent-decides', 'always-proceed'];
const SUPPORTED_ACTIONS = ['read_file', 'write_file', 'read_url', 'execute_url', 'command', 'unsandboxed', 'mcp'];

const CLI_DEFAULTS = {
    agentMode: 'default',
    toolPermission: 'request-review',
    artifactReviewPolicy: 'asks-for-review',
    allowNonWorkspaceAccess: false,
    enableTerminalSandbox: false,
};

const PRESETS = {
    strict: {
        label: '严格审核',
        autoAccept: false,
        agentMode: 'default',
        toolPermission: 'strict',
        artifactReviewPolicy: 'asks-for-review',
        allowNonWorkspaceAccess: false,
        enableTerminalSandbox: false,
    },
    default: {
        label: '默认平衡',
        autoAccept: false,
        agentMode: 'default',
        toolPermission: 'request-review',
        artifactReviewPolicy: 'asks-for-review',
        allowNonWorkspaceAccess: false,
        enableTerminalSandbox: false,
    },
    'accept-edits': {
        label: '自动改代码',
        autoAccept: true,
        agentMode: 'accept-edits',
        toolPermission: 'request-review',
        artifactReviewPolicy: 'asks-for-review',
        allowNonWorkspaceAccess: false,
        enableTerminalSandbox: false,
    },
    auto: {
        label: '沙盒全自动',
        autoAccept: true,
        agentMode: 'auto',
        toolPermission: 'proceed-in-sandbox',
        artifactReviewPolicy: 'asks-for-review',
        allowNonWorkspaceAccess: false,
        enableTerminalSandbox: true,
    },
    turbo: {
        label: '完全放行 (Turbo)',
        autoAccept: true,
        agentMode: 'auto',
        toolPermission: 'always-proceed',
        artifactReviewPolicy: 'always-proceed',
        allowNonWorkspaceAccess: true,
        enableTerminalSandbox: false,
    },
};

function getDefaultCliSettingsPath(homeDir = os.homedir()) {
    return path.join(homeDir, '.gemini', 'antigravity-cli', 'settings.json');
}

function validatePermissionRule(raw) {
    if (typeof raw !== 'string') throw new Error('权限规则必须是字符串');
    const rule = raw.trim();
    if (!rule) throw new Error('权限规则不能为空');
    if (/[\r\n\0]/.test(rule)) throw new Error('权限规则不能包含换行或控制字符');
    if (rule.length > 500) throw new Error('权限规则过长（最多 500 个字符）');

    const match = rule.match(/^([a-z_]+)\((.+)\)$/s);
    if (!match) {
        throw new Error(`权限规则格式无效: "${rule}"，应为 action(target) 格式，例如 command(git) 或 read_file(*)`);
    }
    const action = match[1];
    const target = match[2].trim();
    if (!SUPPORTED_ACTIONS.includes(action)) {
        throw new Error(`不支持的动作类型 "${action}"，可选: ${SUPPORTED_ACTIONS.join(', ')}`);
    }
    if (!target) {
        throw new Error(`权限规则 "${rule}" 的 target 不能为空`);
    }
    return `${action}(${target})`;
}

function normalizeRuleList(list) {
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    const out = [];
    for (const item of list) {
        const clean = validatePermissionRule(item);
        if (!seen.has(clean)) {
            seen.add(clean);
            out.push(clean);
        }
    }
    return out;
}

function safeReadJsonObject(filePath) {
    if (!fs.existsSync(filePath)) return { raw: {}, parseError: null };
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return { raw: {}, parseError: 'settings.json 根节点不是 JSON 对象' };
        }
        return { raw: parsed, parseError: null };
    } catch (e) {
        return { raw: {}, parseError: e.message };
    }
}

function atomicWritePrivateJson(filePath, data) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch { /* ignore on win32 */ }
    fs.renameSync(tmp, filePath);
}

function createPermissionManager(options = {}) {
    const getSettingsPath = () => {
        if (options.settingsPath) return options.settingsPath;
        if (process.env.ANTIGRAVITY_CLI_SETTINGS_PATH) return process.env.ANTIGRAVITY_CLI_SETTINGS_PATH;
        return getDefaultCliSettingsPath();
    };

    const getAutoAcceptFn = () => {
        if (options.getAutoAccept) return options.getAutoAccept;
        return require('./auto-accept').getAutoAccept;
    };

    const setAutoAcceptFn = () => {
        if (options.setAutoAccept) return options.setAutoAccept;
        return require('./auto-accept').setAutoAccept;
    };

    function getState() {
        const settingsPath = getSettingsPath();
        const exists = fs.existsSync(settingsPath);
        const { raw, parseError } = safeReadJsonObject(settingsPath);
        const perms = (raw.permissions && typeof raw.permissions === 'object' && !Array.isArray(raw.permissions))
            ? raw.permissions
            : {};

        const agentMode = typeof raw.agentMode === 'string' && VALID_AGENT_MODES.includes(raw.agentMode)
            ? raw.agentMode
            : 'default';
        const toolPermission = typeof raw.toolPermission === 'string' && VALID_TOOL_PERMISSIONS.includes(raw.toolPermission)
            ? raw.toolPermission
            : CLI_DEFAULTS.toolPermission;
        const artifactReviewPolicy = typeof raw.artifactReviewPolicy === 'string' && VALID_ARTIFACT_POLICIES.includes(raw.artifactReviewPolicy)
            ? raw.artifactReviewPolicy
            : CLI_DEFAULTS.artifactReviewPolicy;

        return {
            autoAccept: Boolean(getAutoAcceptFn()()),
            settingsPath,
            fileExists: exists,
            parseError,
            cli: {
                agentMode,
                toolPermission,
                artifactReviewPolicy,
                allowNonWorkspaceAccess: typeof raw.allowNonWorkspaceAccess === 'boolean'
                    ? raw.allowNonWorkspaceAccess
                    : CLI_DEFAULTS.allowNonWorkspaceAccess,
                enableTerminalSandbox: typeof raw.enableTerminalSandbox === 'boolean'
                    ? raw.enableTerminalSandbox
                    : CLI_DEFAULTS.enableTerminalSandbox,
                permissions: {
                    allow: Array.isArray(perms.allow) ? perms.allow.filter((x) => typeof x === 'string') : [],
                    ask: Array.isArray(perms.ask) ? perms.ask.filter((x) => typeof x === 'string') : [],
                    deny: Array.isArray(perms.deny) ? perms.deny.filter((x) => typeof x === 'string') : [],
                },
            },
        };
    }

    function updatePermissions(input = {}) {
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
            throw new Error('无效的权限配置载荷');
        }

        if (input.autoAccept !== undefined) {
            setAutoAcceptFn()(Boolean(input.autoAccept));
        }

        const cliPatch = input.cli && typeof input.cli === 'object' ? input.cli : null;
        if (cliPatch) {
            const settingsPath = getSettingsPath();
            const { raw, parseError } = safeReadJsonObject(settingsPath);
            if (parseError) {
                throw new Error(`无法写入权限配置，现有 settings.json 解析失败: ${parseError}`);
            }

            const next = { ...raw };

            if (cliPatch.agentMode !== undefined) {
                const mode = cliPatch.agentMode === '' ? 'default' : cliPatch.agentMode;
                if (!VALID_AGENT_MODES.includes(mode)) {
                    throw new Error(`不支持的 agentMode: ${cliPatch.agentMode}`);
                }
                if (mode === 'default') delete next.agentMode;
                else next.agentMode = mode;
            }

            if (cliPatch.toolPermission !== undefined) {
                if (!VALID_TOOL_PERMISSIONS.includes(cliPatch.toolPermission)) {
                    throw new Error(`不支持的 toolPermission: ${cliPatch.toolPermission}`);
                }
                if (cliPatch.toolPermission === CLI_DEFAULTS.toolPermission) delete next.toolPermission;
                else next.toolPermission = cliPatch.toolPermission;
            }

            if (cliPatch.artifactReviewPolicy !== undefined) {
                if (!VALID_ARTIFACT_POLICIES.includes(cliPatch.artifactReviewPolicy)) {
                    throw new Error(`不支持的 artifactReviewPolicy: ${cliPatch.artifactReviewPolicy}`);
                }
                if (cliPatch.artifactReviewPolicy === CLI_DEFAULTS.artifactReviewPolicy) delete next.artifactReviewPolicy;
                else next.artifactReviewPolicy = cliPatch.artifactReviewPolicy;
            }

            if (cliPatch.allowNonWorkspaceAccess !== undefined) {
                const val = Boolean(cliPatch.allowNonWorkspaceAccess);
                if (val === CLI_DEFAULTS.allowNonWorkspaceAccess) delete next.allowNonWorkspaceAccess;
                else next.allowNonWorkspaceAccess = val;
            }

            if (cliPatch.enableTerminalSandbox !== undefined) {
                const val = Boolean(cliPatch.enableTerminalSandbox);
                if (val === CLI_DEFAULTS.enableTerminalSandbox) delete next.enableTerminalSandbox;
                else next.enableTerminalSandbox = val;
            }

            if (cliPatch.permissions !== undefined) {
                if (!cliPatch.permissions || typeof cliPatch.permissions !== 'object' || Array.isArray(cliPatch.permissions)) {
                    throw new Error('permissions 必须是包含 allow / ask / deny 数组的对象');
                }
                const prevPerms = (next.permissions && typeof next.permissions === 'object' && !Array.isArray(next.permissions))
                    ? { ...next.permissions }
                    : {};
                for (const listName of ['allow', 'ask', 'deny']) {
                    if (cliPatch.permissions[listName] !== undefined) {
                        const normalized = normalizeRuleList(cliPatch.permissions[listName]);
                        if (normalized.length > 0) prevPerms[listName] = normalized;
                        else delete prevPerms[listName];
                    }
                }
                if (Object.keys(prevPerms).length > 0) next.permissions = prevPerms;
                else delete next.permissions;
            }

            atomicWritePrivateJson(settingsPath, next);
        }

        return getState();
    }

    function applyPreset(presetName) {
        const preset = PRESETS[presetName];
        if (!preset) {
            throw new Error(`未知权限预设: "${presetName}"，可选: ${Object.keys(PRESETS).join(', ')}`);
        }
        return updatePermissions({
            autoAccept: preset.autoAccept,
            cli: {
                agentMode: preset.agentMode,
                toolPermission: preset.toolPermission,
                artifactReviewPolicy: preset.artifactReviewPolicy,
                allowNonWorkspaceAccess: preset.allowNonWorkspaceAccess,
                enableTerminalSandbox: preset.enableTerminalSandbox,
            },
        });
    }

    return {
        getState,
        updatePermissions,
        applyPreset,
        validatePermissionRule,
    };
}

const defaultPermissionManager = createPermissionManager();

module.exports = {
    VALID_AGENT_MODES,
    VALID_TOOL_PERMISSIONS,
    VALID_ARTIFACT_POLICIES,
    SUPPORTED_ACTIONS,
    PRESETS,
    validatePermissionRule,
    createPermissionManager,
    getState: (...args) => defaultPermissionManager.getState(...args),
    updatePermissions: (...args) => defaultPermissionManager.updatePermissions(...args),
    applyPreset: (...args) => defaultPermissionManager.applyPreset(...args),
};
