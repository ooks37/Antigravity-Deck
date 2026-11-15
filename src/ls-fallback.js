// === Headless / CLI Fallback for Toolbox LS Methods ===
// Provides disk- and git-backed implementations for the subset of Language Server
// RPCs used by the System Toolbox when Antigravity Desktop IDE LS is not running.

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const { pathToFileUri, uriToFsPath } = require('./routes/route-helpers');

const WORKSPACE_MARKERS = ['.git', '.agent', '.agents', 'AGENTS.md', 'GEMINI.md'];
const SKIP_SCAN_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', '__pycache__', '.cache', 'logs', 'data']);

/** Official agy CLI built-in slash workflows mapped directly to agy execution. */
const BUILTIN_CLI_WORKFLOWS = [
    {
        path: 'builtin://agy-cli/plan.md',
        name: 'plan',
        description: '复杂任务分步规划工作流：在动手修改前先梳理架构、边界与分步执行计划',
        content: '---\nname: plan\ndescription: 复杂任务分步规划工作流：在动手修改前先梳理架构、边界与分步执行计划\n---\n\n# /plan — 分步规划工作流\n\n1. 梳理当前需求、代码上下文与影响边界\n2. 列出结构化分步实施计划与验证标准\n3. 确认计划后按步骤推进并校验结果\n',
        isBuiltin: true,
        scope: 'builtin',
        turbo: false,
    },
    {
        path: 'builtin://agy-cli/boost.md',
        name: 'boost',
        description: '深度思考与多视角严密验证工作流：适合复杂编码、架构设计或疑难排错',
        content: '---\nname: boost\ndescription: 深度思考与多视角严密验证工作流：适合复杂编码、架构设计或疑难排错\n---\n\n# /boost — 深度推理与多视角验证工作流\n\n开启深度思考、多方案对比分析与端到端严格验证。\n',
        isBuiltin: true,
        scope: 'builtin',
        turbo: false,
    },
    {
        path: 'builtin://agy-cli/goal.md',
        name: 'goal',
        description: '长周期自主目标工作流：持续推进并闭环验证，直至目标完全达成',
        content: '---\nname: goal\ndescription: 长周期自主目标工作流：持续推进并闭环验证，直至目标完全达成\nturbo: true\n---\n\n# /goal — 自主目标达成工作流\n\n围绕目标持续迭代执行、自检与修复，直至所有验收标准全部通过。\n',
        isBuiltin: true,
        scope: 'builtin',
        turbo: true,
    },
    {
        path: 'builtin://agy-cli/teamwork.md',
        name: 'teamwork',
        description: '多智能体协同工作流（Swarm）：拆分独立子任务并行推进与交叉审查',
        content: '---\nname: teamwork\ndescription: 多智能体协同工作流（Swarm）：拆分独立子任务并行推进与交叉审查\n---\n\n# /teamwork — 多 Agent 团队协作工作流\n\n将大型项目拆分为并行子模块，通过多智能体协同完成并汇总验证。\n',
        isBuiltin: true,
        scope: 'builtin',
        turbo: false,
    },
    {
        path: 'builtin://agy-cli/grill-me.md',
        name: 'grill-me',
        description: '交互式设计拷问工作流：通过高密度追问帮你理清方案死角与边界条件',
        content: '---\nname: grill-me\ndescription: 交互式设计拷问工作流：通过高密度追问帮你理清方案死角与边界条件\n---\n\n# /grill-me — 方案压力测试工作流\n\n针对当前设计或计划进行追问，逐一消解模糊假设与潜在风险。\n',
        isBuiltin: true,
        scope: 'builtin',
        turbo: false,
    },
    {
        path: 'builtin://agy-cli/compact.md',
        name: 'compact',
        description: '上下文受控压缩工作流：汇总沉淀关键进展并释放长对话上下文空间',
        content: '---\nname: compact\ndescription: 上下文受控压缩工作流：汇总沉淀关键进展并释放长对话上下文空间\n---\n\n# /compact — 上下文受控压缩\n\n将当前长会话的关键决策与代码状态整理为结构化摘要。\n',
        isBuiltin: true,
        scope: 'builtin',
        turbo: false,
    },
    {
        path: 'builtin://agy-cli/schedule.md',
        name: 'schedule',
        description: '定时与周期任务工作流：创建一次性计时器或 Cron 周期执行计划',
        content: '---\nname: schedule\ndescription: 定时与周期任务工作流：创建一次性计时器或 Cron 周期执行计划\n---\n\n# /schedule — 定时调度工作流\n\n配置一次性延时触发或 Cron 周期执行的自动化任务。\n',
        isBuiltin: true,
        scope: 'builtin',
        turbo: false,
    },
    {
        path: 'builtin://agy-cli/learn.md',
        name: 'learn',
        description: '经验沉淀工作流：将本次排错或架构规范提炼固化为可复用的技能或规则',
        content: '---\nname: learn\ndescription: 经验沉淀工作流：将本次排错或架构规范提炼固化为可复用的技能或规则\n---\n\n# /learn — 知识与技能沉淀工作流\n\n将对话中验证有效的排错流程、配置约定沉淀到工作区或全局技能库。\n',
        isBuiltin: true,
        scope: 'builtin',
        turbo: false,
    },
    {
        path: 'builtin://agy-cli/browser.md',
        name: 'browser',
        description: '网页检索与浏览器交互工作流：执行线上页面检查、搜索与自动化操作',
        content: '---\nname: browser\ndescription: 网页检索与浏览器交互工作流：执行线上页面检查、搜索与自动化操作\n---\n\n# /browser — 浏览器交互工作流\n\n结合网页搜索与浏览器工具完成在线验证与交互任务。\n',
        isBuiltin: true,
        scope: 'builtin',
        turbo: false,
    },
];

/** Parse simple YAML frontmatter (`--- ... ---`) plus first heading fallback. */
function parseFrontmatter(content) {
    const raw = String(content || '');
    const meta = { name: '', description: '', trigger: '', turbo: false };
    const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (fmMatch) {
        const lines = fmMatch[1].split(/\r?\n/);
        let activeKey = null;
        let blockLines = [];
        const flushBlock = () => {
            if (activeKey && blockLines.length > 0 && !meta[activeKey]) {
                meta[activeKey] = blockLines.join(' ').trim();
            }
            activeKey = null;
            blockLines = [];
        };
        for (const line of lines) {
            if (activeKey && /^\s+/.test(line)) {
                blockLines.push(line.trim());
                continue;
            }
            flushBlock();
            const kv = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
            if (!kv) continue;
            const key = kv[1];
            const val = kv[2].trim();
            if (val === '>' || val === '|' || val === '>-' || val === '|-') {
                activeKey = key;
                continue;
            }
            const unquoted = val.replace(/^(['"])(.*)\1$/, '$2');
            if (key === 'name') meta.name = unquoted;
            else if (key === 'description') meta.description = unquoted;
            else if (key === 'trigger') meta.trigger = unquoted;
            else if (key === 'turbo') meta.turbo = unquoted === 'true';
        }
        flushBlock();
    }
    if (!meta.description) {
        const heading = raw.match(/^#\s+(.+)$/m);
        if (heading) meta.description = heading[1].trim();
    }
    return meta;
}

function readJsonSafe(filePath) {
    try {
        if (!fs.existsSync(filePath)) return null;
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
        return null;
    }
}

function isExistingDir(dirPath) {
    try {
        return Boolean(dirPath) && fs.statSync(dirPath).isDirectory();
    } catch {
        return false;
    }
}

function hasWorkspaceMarker(dirPath) {
    return WORKSPACE_MARKERS.some((marker) => fs.existsSync(path.join(dirPath, marker)));
}

function realpathOrResolve(targetPath) {
    try {
        return fs.realpathSync(targetPath);
    } catch {
        return path.resolve(targetPath);
    }
}

function createLsFallback(deps = {}) {
    const homeDir = deps.homeDir || os.homedir();
    const cwd = deps.cwd || process.cwd();
    const getSettings = deps.getSettings || (() => require('./config').getSettings());
    const getProjects = deps.getProjects || (() => require('./jetbox').getProjects());
    const execFileSync = deps.execFileSync || childProcess.execFileSync;

    function runGit(args, repoDir) {
        try {
            return execFileSync('git', args, {
                cwd: repoDir,
                encoding: 'utf-8',
                timeout: 2500,
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            });
        } catch {
            return null;
        }
    }

    function detectGitRoot(dirPath) {
        if (fs.existsSync(path.join(dirPath, '.git'))) {
            const top = runGit(['rev-parse', '--show-toplevel'], dirPath);
            if (top && isExistingDir(top.trim())) return realpathOrResolve(top.trim());
            return realpathOrResolve(dirPath);
        }
        const top = runGit(['rev-parse', '--show-toplevel'], dirPath);
        if (top && isExistingDir(top.trim())) return realpathOrResolve(top.trim());
        return null;
    }

    /** Discover active/known project workspaces from Jetbox, defaultWorkspaceRoot, and cwd. */
    function discoverWorkspaces() {
        const seen = new Set();
        const found = [];

        const addDir = (candidatePath, requireMarker = false) => {
            if (!isExistingDir(candidatePath)) return;
            const resolved = realpathOrResolve(candidatePath);
            if (seen.has(resolved)) return;
            if (requireMarker && !hasWorkspaceMarker(resolved)) return;
            seen.add(resolved);
            const gitRoot = detectGitRoot(resolved);
            found.push({
                name: path.basename(resolved) || resolved,
                path: resolved,
                workspaceUri: pathToFileUri(resolved),
                gitRoot,
                gitRootUri: gitRoot ? pathToFileUri(gitRoot) : undefined,
            });
        };

        // 1. Jetbox projects (if populated)
        try {
            for (const p of getProjects() || []) {
                const pPath = uriToFsPath(p?.folderUri);
                if (pPath) addDir(pPath, false);
            }
        } catch { /* ignore */ }

        // 2. Configured defaultWorkspaceRoot (direct repo or 1st-level marked workspaces)
        let settings = {};
        try { settings = getSettings() || {}; } catch { /* ignore */ }
        const wsRoot = settings.defaultWorkspaceRoot;
        if (isExistingDir(wsRoot)) {
            if (hasWorkspaceMarker(wsRoot)) {
                addDir(wsRoot, false);
            }
            try {
                const entries = fs.readdirSync(wsRoot, { withFileTypes: true });
                for (const entry of entries) {
                    if (found.length >= 20) break;
                    if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP_SCAN_DIRS.has(entry.name)) continue;
                    addDir(path.join(wsRoot, entry.name), true);
                }
            } catch { /* ignore */ }
        }

        // 3. Process cwd (if marked, or final fallback if nothing else found)
        if (isExistingDir(cwd)) {
            addDir(cwd, found.length > 0);
        }

        return found;
    }

    function resolveWorkspaceDirs(workspaceUris) {
        if (Array.isArray(workspaceUris) && workspaceUris.length > 0) {
            const dirs = [];
            const seen = new Set();
            for (const uri of workspaceUris) {
                const fsPath = uri && uri.startsWith('file://') ? uriToFsPath(uri) : uri;
                if (!isExistingDir(fsPath)) continue;
                const resolved = realpathOrResolve(fsPath);
                if (!seen.has(resolved)) {
                    seen.add(resolved);
                    dirs.push(resolved);
                }
            }
            if (dirs.length > 0) return dirs;
        }
        return discoverWorkspaces().map((w) => w.path);
    }

    function resolveWorkspacePathByName(rawName) {
        if (!rawName) return null;
        let name = String(rawName);
        try { name = decodeURIComponent(name); } catch { /* keep raw */ }
        const clean = name.trim();
        if (!clean || clean === '.' || clean === '..' || clean.includes('..')) return null;

        const targetLower = clean.toLowerCase();
        const discovered = discoverWorkspaces();
        const exact = discovered.find((w) =>
            w.name.toLowerCase() === targetLower
            || w.path.toLowerCase() === targetLower
            || w.workspaceUri.toLowerCase() === targetLower
        );
        if (exact) return exact.path;

        // Allow direct child folders inside defaultWorkspaceRoot without traversal
        let settings = {};
        try { settings = getSettings() || {}; } catch { /* ignore */ }
        const wsRoot = settings.defaultWorkspaceRoot;
        if (isExistingDir(wsRoot) && !clean.includes('/') && !clean.includes('\\')) {
            try {
                const match = fs.readdirSync(wsRoot, { withFileTypes: true })
                    .find((d) => d.isDirectory() && d.name.toLowerCase() === targetLower);
                if (match) return realpathOrResolve(path.join(wsRoot, match.name));
            } catch { /* ignore */ }
        }

        if (isExistingDir(cwd) && path.basename(cwd).toLowerCase() === targetLower) {
            return realpathOrResolve(cwd);
        }
        return null;
    }

    function getMcpConfigPaths() {
        return [
            path.join(homeDir, '.gemini', 'config', 'mcp_config.json'),
            path.join(homeDir, '.gemini', 'antigravity', 'mcp_config.json'),
            path.join(homeDir, '.gemini', 'antigravity-cli', 'mcp_config.json'),
        ];
    }

    function loadMcpTools(serverName) {
        const schemaDirs = [
            path.join(homeDir, '.gemini', 'antigravity-cli', 'mcp', serverName),
            path.join(homeDir, '.gemini', 'antigravity', 'mcp', serverName),
        ];
        const toolsMap = new Map();
        for (const dir of schemaDirs) {
            if (!isExistingDir(dir)) continue;
            try {
                for (const file of fs.readdirSync(dir)) {
                    if (!file.endsWith('.json')) continue;
                    const parsed = readJsonSafe(path.join(dir, file));
                    if (!parsed) continue;
                    const toolName = parsed.name || path.basename(file, '.json');
                    if (!toolsMap.has(toolName)) {
                        toolsMap.set(toolName, {
                            name: toolName,
                            description: parsed.description || '',
                        });
                    }
                }
            } catch { /* ignore unreadable dir */ }
        }
        return [...toolsMap.values()].sort((a, b) => a.name.localeCompare(b.name));
    }

    function getMcpServerStates() {
        const mergedServers = new Map();
        for (const cfgPath of getMcpConfigPaths()) {
            const parsed = readJsonSafe(cfgPath);
            const servers = parsed?.mcpServers;
            if (!servers || typeof servers !== 'object') continue;
            for (const [serverName, spec] of Object.entries(servers)) {
                if (!spec || typeof spec !== 'object' || mergedServers.has(serverName)) continue;
                mergedServers.set(serverName, spec);
            }
        }

        const states = [];
        for (const [serverName, entry] of mergedServers.entries()) {
            const disabled = entry.disabled === true;
            const serverUrl = entry.serverUrl || entry.url;
            states.push({
                spec: {
                    server_name: serverName,
                    ...(entry.command ? { command: entry.command } : {}),
                    ...(Array.isArray(entry.args) ? { args: entry.args } : {}),
                    ...(serverUrl ? { server_url: serverUrl } : {}),
                    disabled,
                },
                status: disabled ? 'MCP_SERVER_STATUS_NOT_CONNECTED' : 'MCP_SERVER_STATUS_CONNECTED',
                tools: loadMcpTools(serverName),
            });
        }
        states.sort((a, b) => a.spec.server_name.localeCompare(b.spec.server_name));
        return { states, is_loading: false };
    }

    function toggleMcpServer(body = {}) {
        const serverName = typeof body.serverName === 'string' ? body.serverName.trim() : '';
        if (!serverName) {
            const err = new Error('serverName is required');
            err.status = 400;
            throw err;
        }
        const enabled = body.enabled !== false;
        let updated = 0;

        for (const cfgPath of getMcpConfigPaths()) {
            const parsed = readJsonSafe(cfgPath);
            if (!parsed?.mcpServers?.[serverName]) continue;
            parsed.mcpServers[serverName].disabled = !enabled;
            fs.writeFileSync(cfgPath, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
            updated++;
        }

        if (updated === 0) {
            const err = new Error(`MCP server not found: ${serverName}`);
            err.status = 404;
            throw err;
        }
        return { ok: true, serverName, enabled };
    }

    function getWorkspaceInfos() {
        const workspaces = discoverWorkspaces();
        return {
            homeDirPath: homeDir,
            homeDirUri: pathToFileUri(homeDir),
            geminiDirUri: pathToFileUri(path.join(homeDir, '.gemini')),
            workspaceInfos: workspaces.map((w) => ({
                workspaceUri: w.workspaceUri,
                ...(w.gitRootUri ? { gitRootUri: w.gitRootUri } : {}),
            })),
        };
    }

    function scanMarkdownFiles(dirPath, { scope, isBuiltin }) {
        if (!isExistingDir(dirPath)) return [];
        const items = [];
        try {
            const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.md')).sort();
            for (const file of files) {
                const filePath = path.join(dirPath, file);
                try {
                    const content = fs.readFileSync(filePath, 'utf-8');
                    const fm = parseFrontmatter(content);
                    const baseName = path.basename(file, '.md');
                    items.push({
                        path: filePath,
                        name: fm.name || baseName,
                        description: fm.description || '',
                        content,
                        isBuiltin: Boolean(isBuiltin),
                        scope,
                        ...(fm.turbo ? { turbo: true } : {}),
                    });
                } catch { /* skip unreadable file */ }
            }
        } catch { /* skip unreadable dir */ }
        return items;
    }

    function getAllWorkflows(body = {}) {
        const wsDirs = resolveWorkspaceDirs(body.workspaceUris);
        const candidates = [];

        for (const ws of wsDirs) {
            for (const dirName of ['.agent', '.agents', '_agent', '_agents']) {
                candidates.push(...scanMarkdownFiles(path.join(ws, dirName, 'workflows'), { scope: 'workspace', isBuiltin: false }));
            }
        }
        candidates.push(...scanMarkdownFiles(path.join(homeDir, '.gemini', 'config', 'workflows'), { scope: 'global', isBuiltin: false }));
        candidates.push(...scanMarkdownFiles(path.join(homeDir, '.gemini', 'config', 'global_workflows'), { scope: 'global', isBuiltin: false }));
        candidates.push(...scanMarkdownFiles(path.join(homeDir, '.gemini', 'antigravity', 'global_workflows'), { scope: 'global', isBuiltin: false }));
        candidates.push(...scanMarkdownFiles(path.join(homeDir, '.gemini', 'antigravity-cli', 'global_workflows'), { scope: 'global', isBuiltin: false }));
        candidates.push(...scanMarkdownFiles(path.join(homeDir, '.gemini', 'antigravity-cli', 'builtin', 'workflows'), { scope: 'builtin', isBuiltin: true }));
        candidates.push(...scanMarkdownFiles(path.join(homeDir, '.gemini', 'antigravity', 'builtin', 'workflows'), { scope: 'builtin', isBuiltin: true }));

        // Map Antigravity 2.0 workflow orchestration skills (run-workflow, migrate-workflows, automation, native_swarm)
        try {
            const { skills } = getAllSkills(body);
            for (const s of skills) {
                if (/workflow|automation|swarm|plan|executing-plans|writing-plans/i.test(s.name || '')) {
                    candidates.push({
                        path: s.path,
                        name: s.name,
                        description: s.description,
                        content: s.content || '',
                        isBuiltin: Boolean(s.isBuiltin),
                        scope: s.scope || 'builtin',
                    });
                }
            }
        } catch { /* ignore */ }

        // Map official agy CLI built-in slash workflows (/plan, /boost, /goal, /teamwork, etc.)
        candidates.push(...BUILTIN_CLI_WORKFLOWS);

        const seenPaths = new Set();
        const seenNames = new Set();
        const workflows = [];
        for (const item of candidates) {
            const isVirtual = String(item.path || '').startsWith('builtin://');
            const keyPath = isVirtual ? item.path : realpathOrResolve(item.path);
            if (seenPaths.has(keyPath)) continue;
            if (item.isBuiltin && seenNames.has(item.name)) continue;
            seenPaths.add(keyPath);
            seenNames.add(item.name);
            workflows.push(item);
        }
        return { workflows };
    }

    function copyBuiltinWorkflowToWorkspace(body = {}) {
        const workflow = body.workflow;
        if (!workflow || typeof workflow !== 'object') {
            const err = new Error('workflow payload is required');
            err.status = 400;
            throw err;
        }
        const wsDirs = resolveWorkspaceDirs();
        if (wsDirs.length === 0) {
            const err = new Error('No target workspace available');
            err.status = 400;
            throw err;
        }

        const rawName = path.basename(String(workflow.path || workflow.name || 'workflow'), '.md')
            .replace(/[^a-zA-Z0-9._-]/g, '-');
        if (!rawName) {
            const err = new Error('Invalid workflow name');
            err.status = 400;
            throw err;
        }

        let content = typeof workflow.content === 'string' ? workflow.content : '';
        if (!content && typeof workflow.path === 'string' && !workflow.path.startsWith('builtin://')) {
            const builtinRoots = [
                path.join(homeDir, '.gemini', 'antigravity-cli', 'builtin'),
                path.join(homeDir, '.gemini', 'antigravity', 'builtin'),
            ].map((p) => path.resolve(p));
            const srcPath = path.resolve(workflow.path);
            const allowed = builtinRoots.some((root) => srcPath.startsWith(root + path.sep));
            if (allowed && fs.existsSync(srcPath)) {
                content = fs.readFileSync(srcPath, 'utf-8');
            }
        }
        if (!content) {
            const builtinMatch = BUILTIN_CLI_WORKFLOWS.find((w) => w.name === rawName || w.path === workflow.path);
            if (builtinMatch) content = builtinMatch.content;
        }
        if (!content) {
            const err = new Error('Workflow content unavailable');
            err.status = 400;
            throw err;
        }

        const destDir = path.join(wsDirs[0], '.agent', 'workflows');
        fs.mkdirSync(destDir, { recursive: true });
        const destPath = path.join(destDir, `${rawName}.md`);
        fs.writeFileSync(destPath, content, 'utf-8');
        return { ok: true, path: destPath };
    }

    function scanSkillsDir(baseDir, { scope, isBuiltin, pluginName }) {
        if (!isExistingDir(baseDir)) return [];
        const items = [];
        try {
            const entries = fs.readdirSync(baseDir, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                const skillDir = path.join(baseDir, entry.name);
                const skillMd = path.join(skillDir, 'SKILL.md');
                if (!fs.existsSync(skillMd)) continue;
                try {
                    const content = fs.readFileSync(skillMd, 'utf-8');
                    const fm = parseFrontmatter(content);
                    items.push({
                        path: skillMd,
                        baseDir: skillDir,
                        name: fm.name || entry.name,
                        description: fm.description || '',
                        content,
                        isBuiltin: Boolean(isBuiltin),
                        scope,
                        ...(pluginName ? { pluginName } : {}),
                    });
                } catch { /* skip unreadable skill */ }
            }
        } catch { /* skip unreadable dir */ }
        return items;
    }

    function scanPluginSkills(pluginsRoot, isBuiltin) {
        if (!isExistingDir(pluginsRoot)) return [];
        const items = [];
        try {
            for (const entry of fs.readdirSync(pluginsRoot, { withFileTypes: true })) {
                if (!entry.isDirectory()) continue;
                const skillsDir = path.join(pluginsRoot, entry.name, 'skills');
                items.push(...scanSkillsDir(skillsDir, {
                    scope: isBuiltin ? 'builtin' : 'plugin',
                    isBuiltin,
                    pluginName: entry.name,
                }));
            }
        } catch { /* skip unreadable dir */ }
        return items;
    }

    function getAllSkills(body = {}) {
        const wsDirs = resolveWorkspaceDirs(body.workspaceUris);
        const candidates = [];

        for (const ws of wsDirs) {
            for (const dirName of ['.agent', '.agents', '_agent', '_agents']) {
                candidates.push(...scanSkillsDir(path.join(ws, dirName, 'skills'), { scope: 'workspace', isBuiltin: false }));
            }
        }
        candidates.push(...scanSkillsDir(path.join(homeDir, '.gemini', 'config', 'skills'), { scope: 'global', isBuiltin: false }));
        candidates.push(...scanSkillsDir(path.join(homeDir, '.gemini', 'skills'), { scope: 'global', isBuiltin: false }));
        candidates.push(...scanSkillsDir(path.join(homeDir, '.agents', 'skills'), { scope: 'global', isBuiltin: false }));
        candidates.push(...scanSkillsDir(path.join(homeDir, '.gemini', 'antigravity', 'skills'), { scope: 'global', isBuiltin: false }));
        candidates.push(...scanSkillsDir(path.join(homeDir, '.gemini', 'antigravity-cli', 'skills'), { scope: 'global', isBuiltin: false }));
        candidates.push(...scanPluginSkills(path.join(homeDir, '.gemini', 'config', 'plugins'), false));
        candidates.push(...scanSkillsDir(path.join(homeDir, '.gemini', 'antigravity-cli', 'builtin', 'skills'), { scope: 'builtin', isBuiltin: true }));
        candidates.push(...scanSkillsDir(path.join(homeDir, '.gemini', 'antigravity', 'builtin', 'skills'), { scope: 'builtin', isBuiltin: true }));
        candidates.push(...scanPluginSkills(path.join(homeDir, '.gemini', 'antigravity-cli', 'builtin', 'plugins'), true));
        candidates.push(...scanPluginSkills(path.join(homeDir, '.gemini', 'antigravity', 'builtin', 'plugins'), true));

        const seenPaths = new Set();
        const seenBuiltinNames = new Set();
        const skills = [];
        for (const item of candidates) {
            const keyPath = realpathOrResolve(item.path);
            if (seenPaths.has(keyPath)) continue;
            if (item.isBuiltin && seenBuiltinNames.has(item.name)) continue;
            seenPaths.add(keyPath);
            if (item.isBuiltin) seenBuiltinNames.add(item.name);
            skills.push(item);
        }
        skills.sort((a, b) => Number(a.isBuiltin) - Number(b.isBuiltin) || a.name.localeCompare(b.name));
        return { skills };
    }

    function readRuleFile(filePath, scope, sourceLabel) {
        try {
            if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
            const content = fs.readFileSync(filePath, 'utf-8').trim();
            if (!content) return null;
            const fm = parseFrontmatter(content);
            return {
                memoryId: filePath,
                title: fm.name || path.basename(filePath, path.extname(filePath)),
                scope,
                source: sourceLabel,
                textMemory: content.length > 2000 ? `${content.slice(0, 2000)}...` : content,
                absolutePath: filePath,
            };
        } catch {
            return null;
        }
    }

    function scanRuleDir(dirPath, scope, sourceLabel) {
        if (!isExistingDir(dirPath)) return [];
        const items = [];
        try {
            for (const file of fs.readdirSync(dirPath).filter((f) => f.endsWith('.md')).sort()) {
                const rule = readRuleFile(path.join(dirPath, file), scope, sourceLabel);
                if (rule) items.push(rule);
            }
        } catch { /* ignore */ }
        return items;
    }

    function getAllRules(body = {}) {
        const wsDirs = resolveWorkspaceDirs(body.workspaceUris);
        const candidates = [];

        for (const ws of wsDirs) {
            for (const fileName of ['AGENTS.md', 'GEMINI.md']) {
                const r = readRuleFile(path.join(ws, fileName), 'workspace', '工作区');
                if (r) candidates.push(r);
            }
            for (const dirName of ['.agent', '.agents', '_agent', '_agents']) {
                candidates.push(...scanRuleDir(path.join(ws, dirName, 'rules'), 'workspace', '工作区规则'));
            }
        }

        for (const fileName of ['AGENTS.md', 'GEMINI.md']) {
            const rHome = readRuleFile(path.join(homeDir, fileName), 'global', '用户目录');
            if (rHome) candidates.push(rHome);
            const rGem = readRuleFile(path.join(homeDir, '.gemini', fileName), 'global', '全局');
            if (rGem) candidates.push(rGem);
            const rCfg = readRuleFile(path.join(homeDir, '.gemini', 'config', fileName), 'global', '全局配置');
            if (rCfg) candidates.push(rCfg);
        }
        candidates.push(...scanRuleDir(path.join(homeDir, '.gemini', 'config', 'rules'), 'global', '全局规则'));
        candidates.push(...scanRuleDir(path.join(homeDir, '.gemini', 'antigravity', 'rules'), 'global', '全局规则'));
        candidates.push(...scanRuleDir(path.join(homeDir, '.gemini', 'antigravity-cli', 'rules'), 'global', '全局规则'));
        candidates.push(...scanRuleDir(path.join(homeDir, '.gemini', 'antigravity', 'memories'), 'global', '全局记忆'));
        candidates.push(...scanRuleDir(path.join(homeDir, '.gemini', 'antigravity-cli', 'memories'), 'global', '全局记忆'));

        // Also surface ~/.gemini/config/settings.json if it defines agent execution/permission rules
        const cliSettingsPath = path.join(homeDir, '.gemini', 'config', 'settings.json');
        const cliSettings = readJsonSafe(cliSettingsPath);
        if (cliSettings && typeof cliSettings === 'object' && (cliSettings.agentMode || cliSettings.toolPermission || cliSettings.permissions)) {
            candidates.push({
                memoryId: cliSettingsPath,
                title: 'settings.json (CLI 全局执行与权限规则)',
                scope: 'global',
                source: 'CLI 配置',
                textMemory: JSON.stringify({
                    agentMode: cliSettings.agentMode || 'default',
                    toolPermission: cliSettings.toolPermission || 'always-proceed',
                    artifactReviewPolicy: cliSettings.artifactReviewPolicy || 'agent-decides',
                    terminalAutoExecutionPolicy: cliSettings.terminalAutoExecutionPolicy || 'auto',
                    allowNonWorkspaceAccess: cliSettings.allowNonWorkspaceAccess !== false,
                    permissions: cliSettings.permissions || {},
                }, null, 2),
                absolutePath: cliSettingsPath,
            });
        }

        const seen = new Set();
        const memories = [];
        for (const rule of candidates) {
            const key = realpathOrResolve(rule.absolutePath);
            if (seen.has(key)) continue;
            seen.add(key);
            memories.push(rule);
        }
        return { memories };
    }

    function getKnowledgeItems() {
        const roots = [
            path.join(homeDir, '.gemini', 'antigravity', 'knowledge'),
            path.join(homeDir, '.gemini', 'antigravity-cli', 'knowledge'),
        ];
        const seen = new Set();
        const items = [];

        for (const root of roots) {
            if (!isExistingDir(root)) continue;
            try {
                for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
                    if (!entry.isDirectory() || seen.has(entry.name)) continue;
                    seen.add(entry.name);
                    const dirPath = path.join(root, entry.name);
                    const item = {
                        dirName: entry.name,
                        dirUri: pathToFileUri(dirPath),
                    };
                    const metaPath = path.join(dirPath, 'metadata.json');
                    if (fs.existsSync(metaPath)) {
                        try {
                            item.metadataUri = pathToFileUri(metaPath);
                            item.metadataContents = fs.readFileSync(metaPath, 'utf-8');
                        } catch { /* skip unreadable meta */ }
                    }
                    const artifactsDir = path.join(dirPath, 'artifacts');
                    if (isExistingDir(artifactsDir)) {
                        try {
                            item.artifactSourceUris = fs.readdirSync(artifactsDir)
                                .sort()
                                .map((f) => pathToFileUri(path.join(artifactsDir, f)));
                        } catch { /* ignore */ }
                    }
                    items.push(item);
                }
            } catch { /* ignore */ }
        }
        items.sort((a, b) => a.dirName.localeCompare(b.dirName));
        return { items };
    }

    function getGitRootsFromRequest(repoUris) {
        const roots = [];
        const seen = new Set();
        const addRoot = (candidate) => {
            if (!isExistingDir(candidate)) return;
            const gitRoot = detectGitRoot(candidate);
            if (!gitRoot || seen.has(gitRoot)) return;
            seen.add(gitRoot);
            roots.push(gitRoot);
        };

        if (Array.isArray(repoUris) && repoUris.length > 0) {
            for (const uri of repoUris) {
                const p = uri && uri.startsWith('file://') ? uriToFsPath(uri) : uri;
                if (p) addRoot(p);
            }
        }
        if (roots.length === 0) {
            for (const ws of discoverWorkspaces()) {
                addRoot(ws.gitRoot || ws.path);
            }
        }
        return roots;
    }

    function getRepoInfos(body = {}) {
        const roots = getGitRootsFromRequest(body.repoUris);
        const repos = [];

        for (const repoPath of roots) {
            const branchOut = runGit(['branch', '--no-color'], repoPath);
            const branches = [];
            if (branchOut !== null) {
                for (const line of branchOut.split(/\r?\n/)) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed.startsWith('(')) continue;
                    const isCurrentBranch = line.startsWith('*');
                    const name = trimmed.replace(/^\*\s*/, '').trim();
                    if (name) branches.push({ name, isCurrentBranch });
                }
            }
            if (branches.length === 0) {
                const unborn = runGit(['symbolic-ref', '--short', 'HEAD'], repoPath);
                if (unborn && unborn.trim()) {
                    branches.push({ name: unborn.trim(), isCurrentBranch: true });
                }
            }
            repos.push({
                name: path.basename(repoPath),
                repoPath,
                branches,
                scmType: 'GIT',
            });
        }
        return { repos };
    }

    function getWorkspaceEditState() {
        const roots = getGitRootsFromRequest();
        const workspaceEdits = [];

        for (const repoRoot of roots) {
            let numstat = runGit(['diff', '--numstat', 'HEAD'], repoRoot);
            if (numstat === null) numstat = runGit(['diff', '--numstat'], repoRoot) || '';

            const editsByFile = new Map();
            let numAdditions = 0;
            let numDeletions = 0;

            for (const line of numstat.split(/\r?\n/)) {
                if (!line.trim()) continue;
                const [addStr, delStr, ...rest] = line.split('\t');
                const filePath = rest.join('\t');
                if (!filePath) continue;
                const additions = parseInt(addStr, 10) || 0;
                const deletions = parseInt(delStr, 10) || 0;
                numAdditions += additions;
                numDeletions += deletions;
                editsByFile.set(filePath, { filePath, additions, deletions });
            }

            const porcelain = runGit(['status', '--porcelain'], repoRoot) || '';
            for (const line of porcelain.split(/\r?\n/)) {
                if (!line.trim()) continue;
                const filePath = line.slice(3).trim();
                if (filePath && !editsByFile.has(filePath)) {
                    editsByFile.set(filePath, { filePath, additions: 0, deletions: 0 });
                }
            }

            workspaceEdits.push({
                repoRoot,
                numAdditions,
                numDeletions,
                edits: [...editsByFile.values()],
            });
        }
        return { workspaceEdits };
    }

    async function handleLsFallback(method, body = {}) {
        switch (method) {
            case 'GetMcpServerStates':
                return getMcpServerStates();
            case 'ToggleMcpServer':
                return toggleMcpServer(body);
            case 'GetWorkspaceInfos':
                return getWorkspaceInfos();
            case 'GetAllWorkflows':
                return getAllWorkflows(body);
            case 'CopyBuiltinWorkflowToWorkspace':
                return copyBuiltinWorkflowToWorkspace(body);
            case 'GetAllSkills':
                return getAllSkills(body);
            case 'GetAllRules':
                return getAllRules(body);
            case 'GetKnowledgeItems':
                return getKnowledgeItems();
            case 'GetRepoInfos':
                return getRepoInfos(body);
            case 'GetWorkspaceEditState':
                return getWorkspaceEditState();
            default:
                return null;
        }
    }

    return {
        handleLsFallback,
        discoverWorkspaces,
        resolveWorkspacePathByName,
    };
}

const defaultInstance = createLsFallback();

module.exports = {
    createLsFallback,
    handleLsFallback: defaultInstance.handleLsFallback,
    discoverWorkspaces: defaultInstance.discoverWorkspaces,
    resolveWorkspacePathByName: defaultInstance.resolveWorkspacePathByName,
    parseFrontmatter,
    BUILTIN_CLI_WORKFLOWS,
};
