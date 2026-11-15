// === File Routes ===
// GET /api/file/read (gemini paths), POST /api/media/save, POST /api/file/read (workspace paths), GET /api/file/serve

const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const { callApi } = require('../api');
const { uriToFsPath, resolveInst } = require('./route-helpers');

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

function resolveUploadTargetDir(workspaceHint) {
    const { lsInstances } = require('../config');
    const { resolveWorkspacePathByName, discoverWorkspaces } = require('../ls-fallback');
    let rootDir = null;
    if (workspaceHint && typeof workspaceHint === 'string') {
        const clean = workspaceHint.trim();
        const matched = lsInstances.find((i) =>
            i.workspaceName === clean
            || i.workspaceFolderUri === clean
            || uriToFsPath(i.workspaceFolderUri) === clean);
        if (matched) {
            rootDir = uriToFsPath(matched.workspaceFolderUri);
        } else {
            rootDir = resolveWorkspacePathByName(clean);
        }
    }
    if (!rootDir && lsInstances.length > 0) {
        rootDir = uriToFsPath(lsInstances[0].workspaceFolderUri);
    }
    if (!rootDir) {
        const cliWorkspaces = discoverWorkspaces();
        if (cliWorkspaces.length > 0) rootDir = cliWorkspaces[0].path;
    }
    if (rootDir && fs.existsSync(rootDir)) {
        return { baseDir: rootDir, uploadDir: path.join(rootDir, '.antigravity-uploads') };
    }
    const fallback = path.join(os.homedir(), '.gemini', 'antigravity-deck', 'uploads');
    return { baseDir: null, uploadDir: fallback };
}

function buildAllowedReadRoots() {
    const { lsInstances, getSettings } = require('../config');
    const { discoverWorkspaces } = require('../ls-fallback');
    const settings = getSettings();
    const allowedRoots = [];
    const addRoot = (candidate) => {
        if (!candidate) return;
        try {
            const real = fs.realpathSync(candidate);
            if (!allowedRoots.includes(real)) allowedRoots.push(real);
        } catch { }
    };

    if (settings.defaultWorkspaceRoot) addRoot(settings.defaultWorkspaceRoot);
    for (const inst of lsInstances) {
        if (inst.workspaceFolderUri) addRoot(uriToFsPath(inst.workspaceFolderUri));
    }
    for (const ws of discoverWorkspaces()) {
        if (ws.path) addRoot(ws.path);
    }
    addRoot(path.join(os.homedir(), '.gemini', 'antigravity', 'brain'));
    addRoot(path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain'));
    addRoot(path.join(os.homedir(), '.gemini', 'antigravity-deck', 'uploads'));
    return allowedRoots;
}

module.exports = function setupFilesRoutes(app) {
    // GET /api/file/read — for rendering artifacts like .md files
    // Security: only allows reading from .gemini paths (simple path check)
    app.get('/api/file/read', async (req, res) => {
        try {
            let filePath = req.query.path;
            if (!filePath) return res.status(400).json({ error: 'path query parameter is required' });
            // Support file:/// URIs
            if (filePath.startsWith('file:///')) {
                try { filePath = decodeURIComponent(new URL(filePath).pathname); } catch { filePath = decodeURIComponent(filePath.replace('file://', '')); }
                // Windows: /C:/Users/... → C:/Users/...
                if (/^\/[a-zA-Z]:/.test(filePath)) filePath = filePath.substring(1);
            }
            // Security: only allow reading from .gemini/antigravity/brain paths
            const normalized = require('path').resolve(filePath);
            if (!normalized.includes('.gemini')) {
                return res.status(403).json({ error: 'Access denied — only .gemini paths allowed' });
            }
            const fs = require('fs');
            if (!fs.existsSync(normalized)) return res.status(404).json({ error: 'File not found' });
            const content = fs.readFileSync(normalized, 'utf-8');
            res.json({ path: normalized, content });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // POST /api/media/save — SaveMediaAsArtifact proxy (with local filesystem fallback in headless CLI mode)
    app.post('/api/media/save', async (req, res) => {
        try {
            const { mimeType, inlineData, thumbnail } = req.body;
            if (!inlineData) return res.status(400).json({ error: 'inlineData is required' });
            const inst = resolveInst(req);
            if (!inst) {
                const { pathToFileUri } = require('../ls-fallback');
                const { uploadDir } = resolveUploadTargetDir(req.query?.workspace || req.body?.workspace);
                fs.mkdirSync(uploadDir, { recursive: true });
                const extMap = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };
                const ext = extMap[mimeType] || '.png';
                const filePath = path.join(uploadDir, `media-${Date.now()}${ext}`);
                const rawB64 = String(inlineData).replace(/^data:[^;]+;base64,/, '');
                fs.writeFileSync(filePath, Buffer.from(rawB64, 'base64'));
                return res.json({ uri: pathToFileUri(filePath), path: filePath });
            }
            const result = await callApi('SaveMediaAsArtifact', {
                media: { mimeType: mimeType || 'image/png', inlineData, thumbnail: thumbnail || '' }
            }, inst);
            res.json(result);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // POST /api/file/read — for artifact/review file preview
    // Uses POST to avoid Cloudflare WAF blocking file:// URIs in query params
    // Security: restricts reads to workspace root and active workspace folders only
    // Defenses: path.resolve (traversal), realpathSync (symlink), allowedRoots whitelist
    app.post('/api/file/read', async (req, res) => {
        try {
            let filePath = typeof req.body?.path === 'string' ? req.body.path : '';

            // Handle file:// URIs
            if (filePath.startsWith('file:///')) {
                try { filePath = decodeURIComponent(new URL(filePath).pathname); } catch { filePath = decodeURIComponent(filePath.replace('file://', '')); }
                // Windows: /C:/Users/... → C:/Users/...
                if (/^\/[a-zA-Z]:/.test(filePath)) filePath = filePath.substring(1);
            }

            if (!filePath) return res.status(400).json({ error: 'Missing path parameter' });

            // Security: Resolve real path (follows symlinks) and verify it exists
            let realPath;
            try {
                realPath = fs.realpathSync(filePath);
            } catch (e) {
                if (e.code === 'ENOENT') {
                    return res.status(404).json({ error: 'File not found' });
                }
                return res.status(400).json({ error: 'Invalid file path' });
            }

            // Security: Only allow reading files within workspace directories and brain/uploads dirs
            const allowedRoots = buildAllowedReadRoots();

            // Deny if no workspace roots configured — nothing to allow
            if (allowedRoots.length === 0) {
                return res.status(403).json({ error: 'Access denied: no workspace configured' });
            }

            // Check if file is within any allowed workspace (case-insensitive on Windows)
            const isAllowed = allowedRoots.some(root => {
                const normalizedRoot = path.resolve(root);
                return process.platform === 'win32'
                    ? realPath.toLowerCase().startsWith(normalizedRoot.toLowerCase() + path.sep) ||
                    realPath.toLowerCase() === normalizedRoot.toLowerCase()
                    : realPath.startsWith(normalizedRoot + path.sep) ||
                    realPath === normalizedRoot;
            });

            if (!isAllowed) {
                return res.status(403).json({ error: 'Access denied: file outside workspace' });
            }

            const content = fs.readFileSync(realPath, 'utf-8');
            res.json({ content, path: filePath });
        } catch (e) {
            res.status(500).json({ error: 'Failed to read file' });
        }
    });

    // POST /api/file/serve — binary image serving for Cloudflare tunnel compatibility
    // Uses POST so the file path is in the request body (not query string) — Cloudflare WAF
    // blocks file:// URIs and Windows paths (backslashes) in GET query params.
    // Returns base64-encoded image data as JSON: { data, mimeType }
    // Security: same workspace allowlist + MIME type whitelist as GET version
    app.post('/api/file/serve', (req, res) => {
        try {
            let filePath = typeof req.body?.path === 'string' ? req.body.path : '';
            // Handle file:// URIs
            if (filePath.startsWith('file:///')) {
                try { filePath = decodeURIComponent(new URL(filePath).pathname); } catch { filePath = decodeURIComponent(filePath.replace('file://', '')); }
                if (/^\/[a-zA-Z]:/.test(filePath)) filePath = filePath.substring(1);
            }
            if (!filePath) return res.status(400).json({ error: 'Missing path parameter' });

            // MIME whitelist — only serve image types
            const ALLOWED_MIME = {
                '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
                '.gif': 'image/gif', '.webp': 'image/webp',
                '.bmp': 'image/bmp', '.ico': 'image/x-icon',
            };
            const ext = path.extname(filePath).toLowerCase();
            if (!ALLOWED_MIME[ext]) {
                return res.status(403).json({ error: 'File type not allowed' });
            }

            // Resolve real path (follows symlinks)
            let realPath;
            try {
                realPath = fs.realpathSync(filePath);
            } catch (e) {
                if (e.code === 'ENOENT') return res.status(404).json({ error: 'File not found' });
                return res.status(400).json({ error: 'Invalid file path' });
            }

            // Build allowed roots (same as POST /api/file/read)
            const allowedRoots = buildAllowedReadRoots();

            if (allowedRoots.length === 0) {
                return res.status(403).json({ error: 'Access denied: no workspace configured' });
            }

            // Verify file is within allowed roots
            const isAllowed = allowedRoots.some(root => {
                const normalizedRoot = path.resolve(root);
                return process.platform === 'win32'
                    ? realPath.toLowerCase().startsWith(normalizedRoot.toLowerCase() + path.sep) ||
                    realPath.toLowerCase() === normalizedRoot.toLowerCase()
                    : realPath.startsWith(normalizedRoot + path.sep) ||
                    realPath === normalizedRoot;
            });

            if (!isAllowed) {
                return res.status(403).json({ error: 'Access denied: file outside workspace' });
            }

            // Check file size (max 50MB)
            const stat = fs.statSync(realPath);
            if (stat.size > 50 * 1024 * 1024) {
                return res.status(413).json({ error: 'File too large' });
            }

            // Read and return as base64 JSON (no file path in URL — bypasses Cloudflare WAF)
            const data = fs.readFileSync(realPath).toString('base64');
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Cache-Control', 'public, max-age=3600');
            res.json({ data, mimeType: ALLOWED_MIME[ext] });
        } catch (e) {
            res.status(500).json({ error: 'Failed to serve file' });
        }
    });

    // GET /api/file/serve — binary file serving for images/media
    // Security: same workspace allowlist as POST /api/file/read + MIME type whitelist
    app.get('/api/file/serve', (req, res) => {
        try {
            let filePath = typeof req.query.path === 'string' ? req.query.path : '';
            // Handle file:// URIs
            if (filePath.startsWith('file:///')) {
                try { filePath = decodeURIComponent(new URL(filePath).pathname); } catch { filePath = decodeURIComponent(filePath.replace('file://', '')); }
                if (/^\/[a-zA-Z]:/.test(filePath)) filePath = filePath.substring(1);
            }
            if (!filePath) return res.status(400).json({ error: 'Missing path parameter' });

            // MIME whitelist — only serve image types
            const ALLOWED_MIME = {
                '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
                '.gif': 'image/gif', '.webp': 'image/webp',
                '.bmp': 'image/bmp', '.ico': 'image/x-icon',
            };
            const ext = path.extname(filePath).toLowerCase();
            if (!ALLOWED_MIME[ext]) {
                return res.status(403).json({ error: 'File type not allowed' });
            }

            // Resolve real path (follows symlinks)
            let realPath;
            try {
                realPath = fs.realpathSync(filePath);
            } catch (e) {
                if (e.code === 'ENOENT') return res.status(404).json({ error: 'File not found' });
                return res.status(400).json({ error: 'Invalid file path' });
            }

            // Build allowed roots (same as POST /api/file/read)
            const allowedRoots = buildAllowedReadRoots();

            if (allowedRoots.length === 0) {
                return res.status(403).json({ error: 'Access denied: no workspace configured' });
            }

            // Verify file is within allowed roots
            const isAllowed = allowedRoots.some(root => {
                const normalizedRoot = path.resolve(root);
                return process.platform === 'win32'
                    ? realPath.toLowerCase().startsWith(normalizedRoot.toLowerCase() + path.sep) ||
                    realPath.toLowerCase() === normalizedRoot.toLowerCase()
                    : realPath.startsWith(normalizedRoot + path.sep) ||
                    realPath === normalizedRoot;
            });

            if (!isAllowed) {
                return res.status(403).json({ error: 'Access denied: file outside workspace' });
            }

            // Check file size (max 50MB)
            const stat = fs.statSync(realPath);
            if (stat.size > 50 * 1024 * 1024) {
                return res.status(413).json({ error: 'File too large' });
            }

            // Serve with proper headers
            res.setHeader('Content-Type', ALLOWED_MIME[ext]);
            res.setHeader('Content-Length', stat.size);
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('Content-Disposition', 'inline');
            res.setHeader('Cache-Control', 'public, max-age=3600');
            fs.createReadStream(realPath).pipe(res);
        } catch (e) {
            res.status(500).json({ error: 'Failed to serve file' });
        }
    });

    // POST /api/files/upload — upload arbitrary log/config/script/document files up to 15MB
    app.post('/api/files/upload', express.json({ limit: '25mb' }), (req, res) => {
        try {
            const { name, contentBase64, contentText, workspace, mimeType } = req.body || {};
            if (!name || typeof name !== 'string') {
                return res.status(400).json({ error: '缺少文件名 name' });
            }
            let buf;
            if (typeof contentBase64 === 'string' && contentBase64.length > 0) {
                const rawB64 = contentBase64.replace(/^data:[^;]+;base64,/, '');
                buf = Buffer.from(rawB64, 'base64');
            } else if (typeof contentText === 'string') {
                buf = Buffer.from(contentText, 'utf8');
            } else {
                return res.status(400).json({ error: '缺少文件内容 contentBase64 或 contentText' });
            }

            if (buf.length > MAX_UPLOAD_BYTES) {
                return res.status(413).json({ error: `文件过大，最大支持 ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))}MB` });
            }

            const originalBase = path.basename(name).trim() || 'upload.bin';
            const cleanBase = originalBase.replace(/[^\w.\-()\u4e00-\u9fa5]/g, '_').slice(0, 120) || 'upload.bin';
            const finalName = `${Date.now()}-${cleanBase}`;
            const { baseDir, uploadDir } = resolveUploadTargetDir(workspace);
            fs.mkdirSync(uploadDir, { recursive: true });

            const targetPath = path.resolve(uploadDir, finalName);
            const resolvedUploadDir = path.resolve(uploadDir);
            if (!targetPath.startsWith(resolvedUploadDir + path.sep)) {
                return res.status(403).json({ error: '非法文件路径' });
            }

            fs.writeFileSync(targetPath, buf);
            const relativePath = baseDir ? path.relative(baseDir, targetPath).replace(/\\/g, '/') : targetPath;
            res.json({
                success: true,
                name: finalName,
                originalName: originalBase,
                path: targetPath,
                relativePath,
                size: buf.length,
                mimeType: mimeType || 'application/octet-stream',
            });
        } catch (e) {
            res.status(500).json({ error: e.message || '上传文件失败' });
        }
    });
};
