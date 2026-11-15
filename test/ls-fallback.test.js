'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');
const { createLsFallback, parseFrontmatter } = require('../src/ls-fallback');

async function main() {
    let passed = 0;
    let failed = 0;

    async function test(name, fn) {
        try {
            await fn();
            console.log(`  PASS ${name}`);
            passed++;
        } catch (err) {
            console.error(`  FAIL ${name}:`, err.stack || err.message);
            failed++;
        }
    }

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-ls-fallback-'));
    try {
        const homeDir = path.join(tmpRoot, 'home');
        const wsRoot = path.join(tmpRoot, 'wwwroot');
        const projectDir = path.join(wsRoot, 'demo-repo');
        const emptySiteDir = path.join(wsRoot, 'static-site');

        // Prepare fake git repository
        fs.mkdirSync(projectDir, { recursive: true });
        fs.mkdirSync(emptySiteDir, { recursive: true });
        execFileSync('git', ['init', '-b', 'main'], { cwd: projectDir, stdio: 'ignore' });
        execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: projectDir, stdio: 'ignore' });
        execFileSync('git', ['config', 'user.name', 'Test'], { cwd: projectDir, stdio: 'ignore' });
        fs.writeFileSync(path.join(projectDir, 'README.md'), '# Demo\n', 'utf-8');
        fs.writeFileSync(path.join(projectDir, 'AGENTS.md'), '# Repo Rules\nAlways test.\n', 'utf-8');
        execFileSync('git', ['add', '.'], { cwd: projectDir, stdio: 'ignore' });
        execFileSync('git', ['commit', '-m', 'init'], { cwd: projectDir, stdio: 'ignore' });
        execFileSync('git', ['branch', 'feature/toolbox'], { cwd: projectDir, stdio: 'ignore' });
        fs.writeFileSync(path.join(projectDir, 'README.md'), '# Demo\nLine 2\n', 'utf-8');
        fs.writeFileSync(path.join(projectDir, 'notes.txt'), 'untracked\n', 'utf-8');

        // Prepare MCP config & tool schemas
        fs.mkdirSync(path.join(homeDir, '.gemini', 'config'), { recursive: true });
        fs.writeFileSync(
            path.join(homeDir, '.gemini', 'config', 'mcp_config.json'),
            JSON.stringify({
                mcpServers: {
                    'baota-hub': {
                        command: '/usr/bin/node',
                        args: ['/opt/bt-mcp-hub/bin/mcp-server.js'],
                        disabled: false,
                    },
                },
            }, null, 2),
            'utf-8',
        );
        fs.mkdirSync(path.join(homeDir, '.gemini', 'antigravity-cli', 'mcp', 'baota-hub'), { recursive: true });
        fs.writeFileSync(
            path.join(homeDir, '.gemini', 'antigravity-cli', 'mcp', 'baota-hub', 'bt_bash.json'),
            JSON.stringify({ name: 'bt_bash', description: 'Run shell on server' }),
            'utf-8',
        );

        // Prepare skills, rules, workflows, knowledge
        fs.mkdirSync(path.join(homeDir, '.gemini', 'antigravity-cli', 'builtin', 'skills', 'run-workflow'), { recursive: true });
        fs.writeFileSync(
            path.join(homeDir, '.gemini', 'antigravity-cli', 'builtin', 'skills', 'run-workflow', 'SKILL.md'),
            '---\nname: run-workflow\ndescription: Workflow runner skill\n---\n# Body\n',
            'utf-8',
        );
        fs.mkdirSync(path.join(homeDir, '.gemini', 'antigravity-cli', 'builtin', 'workflows'), { recursive: true });
        fs.writeFileSync(
            path.join(homeDir, '.gemini', 'antigravity-cli', 'builtin', 'workflows', 'deploy.md'),
            '---\ndescription: Builtin deploy workflow\nturbo: true\n---\n# Deploy\n',
            'utf-8',
        );
        fs.writeFileSync(path.join(homeDir, '.gemini', 'GEMINI.md'), '# Global Instructions\nKeep concise.\n', 'utf-8');
        fs.mkdirSync(path.join(homeDir, '.gemini', 'antigravity', 'knowledge', 'arch-notes', 'artifacts'), { recursive: true });
        fs.writeFileSync(
            path.join(homeDir, '.gemini', 'antigravity', 'knowledge', 'arch-notes', 'metadata.json'),
            JSON.stringify({ title: 'Architecture Notes', summary: 'Overview' }),
            'utf-8',
        );
        fs.writeFileSync(
            path.join(homeDir, '.gemini', 'antigravity', 'knowledge', 'arch-notes', 'artifacts', 'overview.md'),
            '# Overview\n',
            'utf-8',
        );

        const fb = createLsFallback({
            homeDir,
            cwd: projectDir,
            getSettings: () => ({ defaultWorkspaceRoot: wsRoot }),
            getProjects: () => [],
        });

        await test('parseFrontmatter parses single/quoted and multiline descriptions', async () => {
            const fm = parseFrontmatter('---\nname: "demo"\ndescription: >\n  Multi line\n  summary\nturbo: true\n---\n# Body');
            assert.strictEqual(fm.name, 'demo');
            assert.strictEqual(fm.description, 'Multi line summary');
            assert.strictEqual(fm.turbo, true);
        });

        await test('GetMcpServerStates and ToggleMcpServer manage config + tool schemas', async () => {
            const res = await fb.handleLsFallback('GetMcpServerStates', {});
            assert.strictEqual(res.is_loading, false);
            assert.strictEqual(res.states.length, 1);
            assert.strictEqual(res.states[0].spec.server_name, 'baota-hub');
            assert.strictEqual(res.states[0].status, 'MCP_SERVER_STATUS_CONNECTED');
            assert.strictEqual(res.states[0].tools[0].name, 'bt_bash');

            const toggled = await fb.handleLsFallback('ToggleMcpServer', { serverName: 'baota-hub', enabled: false });
            assert.strictEqual(toggled.ok, true);
            const after = await fb.handleLsFallback('GetMcpServerStates', {});
            assert.strictEqual(after.states[0].spec.disabled, true);
            assert.strictEqual(after.states[0].status, 'MCP_SERVER_STATUS_NOT_CONNECTED');
        });

        await test('GetWorkspaceInfos discovers marked repos and skips plain dirs', async () => {
            const info = await fb.handleLsFallback('GetWorkspaceInfos', {});
            assert.strictEqual(info.homeDirPath, homeDir);
            assert.strictEqual(info.workspaceInfos.length, 1);
            assert.ok(info.workspaceInfos[0].workspaceUri.endsWith('/demo-repo'));
            assert.ok(info.workspaceInfos[0].gitRootUri.endsWith('/demo-repo'));
        });

        await test('GetAllSkills, GetAllRules, GetAllWorkflows, and CopyBuiltinWorkflowToWorkspace work end-to-end', async () => {
            const skills = await fb.handleLsFallback('GetAllSkills', {});
            assert.strictEqual(skills.skills.length, 1);
            assert.strictEqual(skills.skills[0].name, 'run-workflow');
            assert.strictEqual(skills.skills[0].isBuiltin, true);

            const rules = await fb.handleLsFallback('GetAllRules', {});
            assert.ok(rules.memories.some((m) => m.title === 'AGENTS' && m.scope === 'workspace'));
            assert.ok(rules.memories.some((m) => m.title === 'GEMINI' && m.scope === 'global'));

            const wfBefore = await fb.handleLsFallback('GetAllWorkflows', {});
            assert.ok(wfBefore.workflows.length >= 2);
            const deployWf = wfBefore.workflows.find((w) => w.name === 'deploy');
            assert.ok(deployWf, 'Expected deploy workflow');
            assert.strictEqual(deployWf.turbo, true);
            assert.ok(wfBefore.workflows.some((w) => w.name === 'plan' && w.isBuiltin), 'Expected built-in /plan CLI workflow');
            assert.ok(wfBefore.workflows.some((w) => w.name === 'run-workflow'), 'Expected mapped run-workflow skill');

            const copied = await fb.handleLsFallback('CopyBuiltinWorkflowToWorkspace', { workflow: deployWf });
            assert.strictEqual(copied.ok, true);
            assert.ok(fs.existsSync(path.join(projectDir, '.agent', 'workflows', 'deploy.md')));
        });

        await test('GetKnowledgeItems returns disk items and safely handles missing directories', async () => {
            const kn = await fb.handleLsFallback('GetKnowledgeItems', {});
            assert.strictEqual(kn.items.length, 1);
            assert.strictEqual(kn.items[0].dirName, 'arch-notes');
            assert.strictEqual(kn.items[0].artifactSourceUris.length, 1);

            const emptyFb = createLsFallback({ homeDir: path.join(tmpRoot, 'nonexistent'), cwd: emptySiteDir, getSettings: () => ({}), getProjects: () => [] });
            const emptyKn = await emptyFb.handleLsFallback('GetKnowledgeItems', {});
            assert.deepStrictEqual(emptyKn.items, []);
        });

        await test('GetRepoInfos and GetWorkspaceEditState return branches and working tree diff counts', async () => {
            const info = await fb.handleLsFallback('GetWorkspaceInfos', {});
            const repos = await fb.handleLsFallback('GetRepoInfos', { repoUris: [info.workspaceInfos[0].gitRootUri] });
            assert.strictEqual(repos.repos.length, 1);
            assert.strictEqual(repos.repos[0].name, 'demo-repo');
            assert.ok(repos.repos[0].branches.some((b) => b.name === 'main' && b.isCurrentBranch));
            assert.ok(repos.repos[0].branches.some((b) => b.name === 'feature/toolbox' && !b.isCurrentBranch));

            const edits = await fb.handleLsFallback('GetWorkspaceEditState', {});
            assert.strictEqual(edits.workspaceEdits.length, 1);
            assert.strictEqual(edits.workspaceEdits[0].numAdditions, 1);
            assert.ok(edits.workspaceEdits[0].edits.some((e) => e.filePath === 'README.md'));
            assert.ok(edits.workspaceEdits[0].edits.some((e) => e.filePath === 'notes.txt'));
        });

        await test('resolveWorkspacePathByName rejects traversal and resolves valid workspace', async () => {
            assert.strictEqual(fb.resolveWorkspacePathByName('../etc'), null);
            assert.strictEqual(fb.resolveWorkspacePathByName('demo-repo'), fs.realpathSync(projectDir));
            assert.strictEqual(await fb.handleLsFallback('StartCascade', {}), null);
        });
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }

    console.log(`\nls-fallback tests: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
