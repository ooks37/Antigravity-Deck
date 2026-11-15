// === Workflow Routes ===
// /api/workflows, /api/workflows/:name — Maps workspace/global .md workflows,
// agy CLI built-in slash workflows (/plan, /boost, /goal, etc.), and SKILL.md skills.

const { getInstanceByName } = require('../detector');
const { pathToFileUri, uriToFsPath } = require('./route-helpers');
const { handleLsFallback, resolveWorkspacePathByName } = require('../ls-fallback');

function formatLabel(name) {
    const clean = String(name || '').trim();
    if (!clean) return '';
    return clean.charAt(0).toUpperCase() + clean.slice(1).replace(/[-_]/g, ' ');
}

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

    function buildLsBody(wsName) {
        const wsPath = resolveWsPath(wsName);
        return wsPath ? { workspaceUris: [pathToFileUri(wsPath)] } : {};
    }

    // GET /api/workflows — list all available slash workflows & skills mapped for agy CLI
    app.get('/api/workflows', async (req, res) => {
        try {
            const body = buildLsBody(req.query.workspace);
            const [wfRes, skillRes] = await Promise.all([
                handleLsFallback('GetAllWorkflows', body),
                handleLsFallback('GetAllSkills', body),
            ]);

            const workflows = [];
            const seenSlashes = new Set();

            for (const w of wfRes?.workflows || []) {
                const name = String(w.name || '').trim();
                if (!name) continue;
                const slash = name.startsWith('/') ? name : `/${name}`;
                if (seenSlashes.has(slash.toLowerCase())) continue;
                seenSlashes.add(slash.toLowerCase());
                const source = w.scope === 'workspace'
                    ? 'workspace'
                    : (w.isBuiltin || w.scope === 'builtin' ? 'builtin' : 'global');
                workflows.push({
                    slash,
                    label: formatLabel(name.replace(/^\//, '')),
                    description: w.description || '',
                    source,
                });
            }

            for (const s of skillRes?.skills || []) {
                const name = String(s.name || '').trim();
                if (!name) continue;
                const slash = name.startsWith('/') ? name : `/${name}`;
                if (seenSlashes.has(slash.toLowerCase())) continue;
                seenSlashes.add(slash.toLowerCase());
                workflows.push({
                    slash,
                    label: formatLabel(name.replace(/^\//, '')),
                    description: s.description || '',
                    source: s.scope === 'workspace' ? 'workspace' : 'skill',
                });
            }

            const rank = { workspace: 0, global: 1, builtin: 2, skill: 3 };
            workflows.sort((a, b) => (rank[a.source] ?? 9) - (rank[b.source] ?? 9) || a.slash.localeCompare(b.slash));
            res.json(workflows);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // GET /api/workflows/:name — read full content of a workflow or skill
    app.get('/api/workflows/:name', async (req, res) => {
        try {
            const name = req.params.name.replace(/[^a-zA-Z0-9._-]/g, '');
            if (!name) return res.status(400).json({ error: 'Invalid workflow name' });

            const body = buildLsBody(req.query.workspace);
            const [wfRes, skillRes] = await Promise.all([
                handleLsFallback('GetAllWorkflows', body),
                handleLsFallback('GetAllSkills', body),
            ]);

            const lower = name.toLowerCase();
            const matchedWf = (wfRes?.workflows || []).find((w) => String(w.name || '').toLowerCase() === lower);
            if (matchedWf) {
                return res.json({
                    name: matchedWf.name,
                    description: matchedWf.description || '',
                    content: matchedWf.content || '',
                    source: matchedWf.scope || (matchedWf.isBuiltin ? 'builtin' : 'global'),
                    path: matchedWf.path || null,
                });
            }

            const matchedSkill = (skillRes?.skills || []).find((s) => String(s.name || '').toLowerCase() === lower);
            if (matchedSkill) {
                return res.json({
                    name: matchedSkill.name,
                    description: matchedSkill.description || '',
                    content: matchedSkill.content || '',
                    source: matchedSkill.scope === 'workspace' ? 'workspace' : 'skill',
                    path: matchedSkill.path || null,
                });
            }

            res.status(404).json({ error: `Workflow "${name}" not found` });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
};
