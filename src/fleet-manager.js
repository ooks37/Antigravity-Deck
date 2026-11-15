const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');

function resolveServersFilePath(opts = {}) {
    return opts.serversPath
        || process.env.BT_SERVERS_JSON
        || path.join(os.homedir(), '.bt-mcp', 'servers.json');
}

function parseUrlHostPort(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return { host: '', port: null, protocol: '' };
    try {
        const u = new URL(rawUrl);
        const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
        return { host: u.hostname || '', port, protocol: u.protocol };
    } catch {
        return { host: '', port: null, protocol: '' };
    }
}

function readRawServersConfig(opts = {}) {
    const filePath = resolveServersFilePath(opts);
    if (!fs.existsSync(filePath)) {
        return { exists: false, filePath, activeServer: null, rawServers: [] };
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const list = Array.isArray(parsed?.servers)
            ? parsed.servers
            : (parsed?.servers && typeof parsed.servers === 'object' ? Object.values(parsed.servers) : []);
        return {
            exists: true,
            filePath,
            activeServer: parsed?.activeServer || null,
            rawServers: list.filter((s) => s && typeof s === 'object'),
        };
    } catch (e) {
        return { exists: true, filePath, activeServer: null, rawServers: [], parseError: e.message };
    }
}

function sanitizeServerEntry(s, activeServer) {
    const urlMeta = parseUrlHostPort(s.url);
    const id = String(s.id || s.name || s.host || s.ip || '');
    const specs = s.specs && typeof s.specs === 'object' ? { ...s.specs } : {};
    const ip = s.ip || urlMeta.host || s.host || '';
    const combo = specs.combo || (specs.cores && specs.ram_gb ? `${specs.cores}h${specs.ram_gb}g` : '');
    return {
        id,
        name: s.name || id,
        ip,
        host: s.host || urlMeta.host || ip,
        port: urlMeta.port,
        hostname: s.hostname || '',
        region: specs.region || '',
        isp: specs.isp || '',
        os: specs.os || '',
        kernel: specs.kernel || '',
        cpuModel: specs.cpu_model || '',
        cores: specs.cores ?? null,
        ramGb: specs.ram_gb ?? null,
        diskGb: specs.disk_gb ?? null,
        combo,
        tags: Array.isArray(s.tags) ? s.tags : [],
        description: s.description || '',
        isActive: Boolean(activeServer && (activeServer === id || activeServer === s.name)),
        configured: Boolean(s.url && s.token),
    };
}

function listFleetServers(opts = {}) {
    const { exists, filePath, activeServer, rawServers, parseError } = readRawServersConfig(opts);
    const servers = rawServers.map((s) => sanitizeServerEntry(s, activeServer));
    return {
        exists,
        configPath: filePath,
        activeServer,
        count: servers.length,
        servers,
        ...(parseError ? { error: parseError } : {}),
    };
}

function defaultProbeServer(rawServer, timeoutMs = 3500) {
    return new Promise((resolve) => {
        if (!rawServer?.url) {
            return resolve({ online: false, latencyMs: null, statusCode: null, error: '未配置 Endpoint' });
        }
        let target;
        try {
            target = new URL(rawServer.url);
        } catch {
            return resolve({ online: false, latencyMs: null, statusCode: null, error: 'Endpoint URL 无效' });
        }

        const mod = target.protocol === 'https:' ? https : http;
        const started = Date.now();
        let settled = false;
        const done = (result) => {
            if (settled) return;
            settled = true;
            resolve(result);
        };

        const req = mod.request(
            {
                hostname: target.hostname,
                port: target.port || (target.protocol === 'https:' ? 443 : 80),
                path: target.pathname + target.search,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(rawServer.token ? { Authorization: `Bearer ${rawServer.token}` } : {}),
                },
                rejectUnauthorized: false,
                timeout: timeoutMs,
            },
            (res) => {
                res.resume();
                const latencyMs = Date.now() - started;
                // Any HTTP/MCP response (200/400/401/405/406) proves panel MCP endpoint is reachable;
                // distinguish auth error separately while reporting transport reachability.
                const authOk = res.statusCode !== 401 && res.statusCode !== 403;
                done({
                    online: res.statusCode < 500,
                    authOk,
                    statusCode: res.statusCode,
                    latencyMs,
                    error: authOk ? null : `HTTP ${res.statusCode} 鉴权失败`,
                });
            },
        );
        req.on('timeout', () => {
            req.destroy();
            done({ online: false, authOk: false, statusCode: null, latencyMs: Date.now() - started, error: '连接超时' });
        });
        req.on('error', (err) => {
            done({ online: false, authOk: false, statusCode: null, latencyMs: Date.now() - started, error: err.message });
        });
        req.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }));
        req.end();
    });
}

async function pingFleet(opts = {}) {
    const { exists, filePath, activeServer, rawServers, parseError } = readRawServersConfig(opts);
    const probeFn = opts.probeServer || defaultProbeServer;
    const timeoutMs = Number(opts.timeoutMs) || 3500;

    const results = await Promise.all(rawServers.map(async (raw) => {
        const sanitized = sanitizeServerEntry(raw, activeServer);
        const probe = await probeFn(raw, timeoutMs);
        return {
            ...sanitized,
            online: Boolean(probe.online),
            authOk: probe.authOk !== false,
            statusCode: probe.statusCode ?? null,
            latencyMs: probe.latencyMs ?? null,
            error: probe.error || null,
            checkedAt: new Date().toISOString(),
        };
    }));

    return {
        exists,
        configPath: filePath,
        activeServer,
        count: results.length,
        onlineCount: results.filter((r) => r.online).length,
        servers: results,
        ...(parseError ? { error: parseError } : {}),
    };
}

module.exports = {
    resolveServersFilePath,
    sanitizeServerEntry,
    listFleetServers,
    pingFleet,
};
