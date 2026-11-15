// === Workflow Routes ===
// /api/workflows, /api/workflows/:name

const { getInstanceByName } = require('../detector');
const { uriToFsPath } = require('./route-helpers');
const { resolveWorkspacePathByName } = require('../ls-fallback');

module.exports = function setupWorkflowsRoutes(app) {
    function resolveWsPath(wsName) {
        if (wsName) {
            const decoded = decodeURIComponent(wsName);
            const inst = getInstanceByName(decoded);
            if (inst?.workspaceFolderUri) {
                return uriToFsPath(inst.workspaceFolderUri);
            }
            return resolveWorkspacePathByName(decoded);
        }
        return resolveWorkspacePathByName('');
    }

    // GET /api/workflows — list all available workflow files
    app.get('/api/workflows', (req, res) => {
        const fs = require('fs');
        const path = require('path');
        const os = require('os');

        const workflows = [];

        // Parse YAML frontmatter description from .md content
        function parseDescription(content) {
            const fm = content.match(/^---\s*\n([\s\S]*?)\n---/);
            if (fm) {
                const descMatch = fm[1].match(/description:\s*(.+)/);
                if (descMatch) return descMatch[1].trim();
            }
            // Fallback: first heading
            const heading = content.match(/^#\s+(.+)/m);
            return heading ? heading[1].trim() : '';
        }

        function scanDir(dirPath, source) {
            if (!fs.existsSync(dirPath)) return;
            try {
                const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.md'));
                for (const file of files) {
                    try {
                        const content = fs.readFileSync(path.join(dirPath, file), 'utf-8');
                        const name = path.basename(file, '.md');
                        if (!workflows.some(w => w.slash === `/${name}`)) {
                            workflows.push({
                                slash: `/${name}`,
                                label: name.charAt(0).toUpperCase() + name.slice(1).replace(/[-_]/g, ' '),
                                description: parseDescription(content),
                                source,
                            });
                        }
                    } catch { /* skip unreadable files */ }
                }
            } catch { /* dir not readable */ }
        }

        // 1. Scan global workflows (both desktop Antigravity and headless Antigravity CLI)
        for (const globalDir of [
            path.join(os.homedir(), '.gemini', 'antigravity', 'global_workflows'),
            path.join(os.homedir(), '.gemini', 'antigravity-cli', 'global_workflows'),
            path.join(os.homedir(), '.gemini', 'antigravity-cli', 'builtin', 'workflows'),
        ]) {
            scanDir(globalDir, 'global');
        }

        // 2. Scan per-workspace workflows (support both LS instance and CLI workspace fallback)
        const wsPath = resolveWsPath(req.query.workspace);
        if (wsPath) {
            scanDir(path.join(wsPath, '.agent', 'workflows'), 'workspace');
            scanDir(path.join(wsPath, '.agents', 'workflows'), 'workspace');
        }

        workflows.sort((a, b) => a.slash.localeCompare(b.slash));
        res.json(workflows);
    });

    // GET /api/workflows/:name — read full content of a workflow file
    app.get('/api/workflows/:name', (req, res) => {
        const fs = require('fs');
        const path = require('path');
        const os = require('os');

        const name = req.params.name.replace(/[^a-zA-Z0-9_-]/g, ''); // sanitize
        if (!name) return res.status(400).json({ error: 'Invalid workflow name' });

        // Check workspace-specific first, then global
        const wsPath = resolveWsPath(req.query.workspace);
        if (wsPath) {
            for (const rel of [path.join('.agent', 'workflows'), path.join('.agents', 'workflows')]) {
                const wsFile = path.join(wsPath, rel, `${name}.md`);
                if (fs.existsSync(wsFile)) {
                    return res.json({ name, content: fs.readFileSync(wsFile, 'utf-8'), source: 'workspace' });
                }
            }
        }

        // Global
        for (const globalDir of [
            path.join(os.homedir(), '.gemini', 'antigravity', 'global_workflows'),
            path.join(os.homedir(), '.gemini', 'antigravity-cli', 'global_workflows'),
            path.join(os.homedir(), '.gemini', 'antigravity-cli', 'builtin', 'workflows'),
        ]) {
            const globalFile = path.join(globalDir, `${name}.md`);
            if (fs.existsSync(globalFile)) {
                return res.json({ name, content: fs.readFileSync(globalFile, 'utf-8'), source: 'global' });
            }
        }

        res.status(404).json({ error: `Workflow "${name}" not found` });
    });
};
