// === Cross-Platform Proxy Manager (SOCKS5h / SOCKS5 / SOCKS4 / HTTP) ===
// Maintains multi-node proxy pool in proxy.settings.json (mode 0o600),
// syncs process.env (ALL_PROXY / HTTP_PROXY / HTTPS_PROXY / NO_PROXY) with localhost bypass,
// and includes a pure-stdlib SOCKS5h/SOCKS5/HTTP CONNECT tunnel tester for latency & exit IP checks.

const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROXY_SETTINGS_PATH = path.join(__dirname, '..', 'proxy.settings.json');
const ALLOWED_PROTOCOLS = new Set(['socks5h', 'socks5', 'socks4', 'socks', 'http', 'https']);
const DEFAULT_BYPASS = ['127.0.0.1', 'localhost', '::1', '0.0.0.0'];

const DEFAULT_PROXY_SETTINGS = {
    enabled: false,
    activeNodeId: null,
    applyToIde: true,
    bypassHosts: DEFAULT_BYPASS.join(','),
    nodes: [],
};

function sanitizeControlChars(str, fieldName = '字段') {
    if (typeof str !== 'string') return '';
    if (/[\r\n\0]/.test(str)) {
        throw new Error(`${fieldName} 包含非法控制字符`);
    }
    return str.trim();
}

function normalizeProtocol(raw) {
    const p = String(raw || 'socks5h').toLowerCase().replace(/:$/, '');
    if (!ALLOWED_PROTOCOLS.has(p)) {
        throw new Error(`不支持的代理协议 "${raw}"（仅支持 socks5h / socks5 / socks4 / http / https）`);
    }
    return p === 'socks' ? 'socks5h' : p;
}

/**
 * Parse either a URL (socks5h://user:pass@host:port) or shorthand host:port[:user:pass]
 */
function parseProxyInput(input) {
    if (!input) throw new Error('代理地址不能为空');

    if (typeof input === 'object' && !Array.isArray(input)) {
        if (input.url && typeof input.url === 'string' && !input.host) {
            const fromUrl = parseProxyInput(input.url);
            return {
                ...fromUrl,
                ...(input.name ? { name: sanitizeControlChars(input.name, '节点名称') } : {}),
                ...(input.username !== undefined && input.username !== '' ? { username: sanitizeControlChars(input.username, '用户名') } : {}),
                ...(input.password !== undefined && input.password !== '' ? { password: sanitizeControlChars(input.password, '密码') } : {}),
            };
        }

        const protocol = normalizeProtocol(input.protocol || 'socks5h');
        const host = sanitizeControlChars(String(input.host || ''), '代理主机');
        const port = parseInt(String(input.port || ''), 10);
        if (!host) throw new Error('代理主机不能为空');
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw new Error('代理端口必须是 1-65535 之间的整数');
        }
        return {
            name: sanitizeControlChars(String(input.name || ''), '节点名称') || `${host}:${port}`,
            protocol,
            host,
            port,
            username: sanitizeControlChars(String(input.username || ''), '用户名'),
            password: sanitizeControlChars(String(input.password || ''), '密码'),
        };
    }

    const raw = sanitizeControlChars(String(input), '代理地址');
    if (!raw) throw new Error('代理地址不能为空');

    // Support host:port or host:port:user:pass shorthand
    if (!raw.includes('://')) {
        const parts = raw.split(':');
        if (parts.length === 2 || parts.length === 4) {
            const [host, portStr, user = '', pass = ''] = parts;
            const port = parseInt(portStr, 10);
            if (host && Number.isInteger(port) && port >= 1 && port <= 65535) {
                return {
                    name: `${host}:${port}`,
                    protocol: 'socks5h',
                    host,
                    port,
                    username: user,
                    password: pass,
                };
            }
        }
        return parseProxyInput(`socks5h://${raw}`);
    }

    let parsed;
    try {
        parsed = new URL(raw);
    } catch {
        throw new Error('代理 URL 格式无效，示例：socks5h://user:pass@1.2.3.4:1080');
    }

    const protocol = normalizeProtocol(parsed.protocol);
    const host = parsed.hostname;
    const port = parseInt(parsed.port || (protocol === 'https' ? '443' : protocol === 'http' ? '8080' : '1080'), 10);
    if (!host) throw new Error('代理主机不能为空');
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('代理端口无效');
    }

    const username = parsed.username ? decodeURIComponent(parsed.username) : '';
    const password = parsed.password ? decodeURIComponent(parsed.password) : '';
    const hashName = parsed.hash ? decodeURIComponent(parsed.hash.slice(1)).trim() : '';

    return {
        name: sanitizeControlChars(hashName, '节点名称') || `${host}:${port}`,
        protocol,
        host,
        port,
        username: sanitizeControlChars(username, '用户名'),
        password: sanitizeControlChars(password, '密码'),
    };
}

function formatHostForUrl(host) {
    return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function buildProxyUrl(node, { maskPassword = false } = {}) {
    if (!node) return '';
    const hostPart = `${formatHostForUrl(node.host)}:${node.port}`;
    const hasUser = Boolean(node.username);
    const hasPass = Boolean(node.password);
    let authPart = '';
    if (hasUser || hasPass) {
        const u = encodeURIComponent(node.username || '');
        const p = maskPassword ? (hasPass ? '******' : '') : encodeURIComponent(node.password || '');
        authPart = hasPass ? `${u}:${p}@` : `${u}@`;
    }
    return `${node.protocol}://${authPart}${hostPart}`;
}

function sanitizeNode(node) {
    if (!node) return null;
    return {
        id: node.id,
        name: node.name,
        protocol: node.protocol,
        host: node.host,
        port: node.port,
        username: node.username || '',
        hasPassword: Boolean(node.password),
        maskedUrl: buildProxyUrl(node, { maskPassword: true }),
        createdAt: node.createdAt || null,
        lastTest: node.lastTest || null,
    };
}

function createProxyStore(opts = {}) {
    const settingsPath = opts.settingsPath || PROXY_SETTINGS_PATH;
    const envTarget = opts.env || process.env;
    const baseEnvSnapshot = {
        HTTP_PROXY: envTarget.HTTP_PROXY,
        HTTPS_PROXY: envTarget.HTTPS_PROXY,
        ALL_PROXY: envTarget.ALL_PROXY,
        NO_PROXY: envTarget.NO_PROXY,
        http_proxy: envTarget.http_proxy,
        https_proxy: envTarget.https_proxy,
        all_proxy: envTarget.all_proxy,
        no_proxy: envTarget.no_proxy,
    };

    let cached = null;

    function load() {
        if (cached) return cached;
        try {
            if (fs.existsSync(settingsPath)) {
                const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
                cached = {
                    ...DEFAULT_PROXY_SETTINGS,
                    ...raw,
                    nodes: Array.isArray(raw.nodes) ? raw.nodes : [],
                };
                return cached;
            }
        } catch { /* fall through to defaults */ }
        cached = { ...DEFAULT_PROXY_SETTINGS, nodes: [] };
        return cached;
    }

    function save(next) {
        cached = {
            ...DEFAULT_PROXY_SETTINGS,
            ...next,
            nodes: Array.isArray(next.nodes) ? next.nodes : [],
        };
        const dir = path.dirname(settingsPath);
        fs.mkdirSync(dir, { recursive: true });
        const tmpPath = `${settingsPath}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(cached, null, 2), { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(tmpPath, settingsPath);
        if (process.platform !== 'win32') {
            try { fs.chmodSync(settingsPath, 0o600); } catch { /* ignore */ }
        }
        return cached;
    }

    function getActiveNode() {
        const cfg = load();
        if (!cfg.enabled || !cfg.activeNodeId) return null;
        return cfg.nodes.find((n) => n.id === cfg.activeNodeId) || null;
    }

    function computeNoProxy(cfg) {
        const extras = String(cfg.bypassHosts || '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        return Array.from(new Set([...DEFAULT_BYPASS, ...extras])).join(',');
    }

    function getProxyEnvVars() {
        const cfg = load();
        const active = getActiveNode();
        if (!active) return null;
        const url = buildProxyUrl(active, { maskPassword: false });
        const noProxy = computeNoProxy(cfg);
        return {
            ALL_PROXY: url,
            HTTP_PROXY: url,
            HTTPS_PROXY: url,
            all_proxy: url,
            http_proxy: url,
            https_proxy: url,
            NO_PROXY: noProxy,
            no_proxy: noProxy,
        };
    }

    function getChildProcessEnv(baseEnv = process.env) {
        const proxyVars = getProxyEnvVars();
        if (!proxyVars) return baseEnv;
        return { ...baseEnv, ...proxyVars };
    }

    function getChromiumProxyArgs() {
        const cfg = load();
        const active = getActiveNode();
        if (!active || !cfg.applyToIde) return [];
        const scheme = active.protocol === 'socks5h' || active.protocol === 'socks' ? 'socks5' : active.protocol;
        const serverVal = `${scheme}://${formatHostForUrl(active.host)}:${active.port}`;
        const bypassList = computeNoProxy(cfg).split(',').join(';');
        return [`--proxy-server=${serverVal}`, `--proxy-bypass-list=${bypassList}`];
    }

    function syncProxyEnv() {
        const proxyVars = getProxyEnvVars();
        const keys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'];
        if (proxyVars) {
            for (const k of keys) {
                envTarget[k] = proxyVars[k];
            }
            return { applied: true };
        }
        for (const k of keys) {
            if (baseEnvSnapshot[k] !== undefined) {
                envTarget[k] = baseEnvSnapshot[k];
            } else {
                delete envTarget[k];
            }
        }
        return { applied: false };
    }

    function getState() {
        const cfg = load();
        const active = getActiveNode();
        return {
            enabled: Boolean(cfg.enabled && active),
            activeNodeId: active ? active.id : null,
            activeNode: active ? sanitizeNode(active) : null,
            applyToIde: Boolean(cfg.applyToIde),
            bypassHosts: computeNoProxy(cfg),
            nodes: cfg.nodes.map(sanitizeNode),
        };
    }

    function addNode(input) {
        const cfg = load();
        const parsed = parseProxyInput(input);
        const node = {
            id: `px_${crypto.randomBytes(4).toString('hex')}`,
            ...parsed,
            createdAt: new Date().toISOString(),
            lastTest: null,
        };
        const activate = Boolean(input && typeof input === 'object' && input.activate);
        const nextNodes = [...cfg.nodes, node];
        save({
            ...cfg,
            nodes: nextNodes,
            ...(activate ? { enabled: true, activeNodeId: node.id } : {}),
        });
        syncProxyEnv();
        return { node: sanitizeNode(node), state: getState() };
    }

    function updateNode(id, input) {
        const cfg = load();
        const idx = cfg.nodes.findIndex((n) => n.id === id);
        if (idx === -1) throw new Error('未找到指定代理节点');
        const prev = cfg.nodes[idx];
        const nextInput = (typeof input === 'object' && !Array.isArray(input))
            ? {
                ...prev,
                ...input,
                password: (input.password === undefined || input.password === '') && !input.clearPassword
                    ? prev.password
                    : input.password,
            }
            : input;
        const parsed = parseProxyInput(nextInput);
        const updated = { ...prev, ...parsed };
        const nextNodes = [...cfg.nodes];
        nextNodes[idx] = updated;
        save({ ...cfg, nodes: nextNodes });
        syncProxyEnv();
        return { node: sanitizeNode(updated), state: getState() };
    }

    function removeNode(id) {
        const cfg = load();
        const exists = cfg.nodes.some((n) => n.id === id);
        if (!exists) throw new Error('未找到指定代理节点');
        const nextNodes = cfg.nodes.filter((n) => n.id !== id);
        const wasActive = cfg.activeNodeId === id;
        save({
            ...cfg,
            nodes: nextNodes,
            ...(wasActive ? { activeNodeId: null, enabled: false } : {}),
        });
        syncProxyEnv();
        return { deleted: true, id, state: getState() };
    }

    function selectNode(idOrNull, enabledOverride = undefined) {
        const cfg = load();
        if (idOrNull === null || idOrNull === '') {
            save({ ...cfg, enabled: false });
            syncProxyEnv();
            return getState();
        }
        const target = cfg.nodes.find((n) => n.id === idOrNull);
        if (!target) throw new Error('未找到指定代理节点');
        const enabled = enabledOverride !== undefined ? Boolean(enabledOverride) : true;
        save({ ...cfg, activeNodeId: target.id, enabled });
        syncProxyEnv();
        return getState();
    }

    function updateProxyPreferences({ enabled, applyToIde, bypassHosts } = {}) {
        const cfg = load();
        const updates = { ...cfg };
        if (enabled !== undefined) {
            if (enabled && !cfg.activeNodeId) {
                if (cfg.nodes.length === 0) throw new Error('请先至少添加一个代理节点');
                updates.activeNodeId = cfg.nodes[0].id;
            }
            updates.enabled = Boolean(enabled);
        }
        if (applyToIde !== undefined) updates.applyToIde = Boolean(applyToIde);
        if (bypassHosts !== undefined) {
            updates.bypassHosts = sanitizeControlChars(String(bypassHosts), '忽略列表');
        }
        save(updates);
        syncProxyEnv();
        return getState();
    }

    function recordNodeTestResult(id, result) {
        const cfg = load();
        const idx = cfg.nodes.findIndex((n) => n.id === id);
        if (idx === -1) return;
        const nextNodes = [...cfg.nodes];
        nextNodes[idx] = { ...nextNodes[idx], lastTest: result };
        save({ ...cfg, nodes: nextNodes });
    }

    function rotateNextNode() {
        const cfg = load();
        if (cfg.nodes.length === 0) throw new Error('代理池为空，请先添加节点');
        if (cfg.nodes.length === 1) return selectNode(cfg.nodes[0].id, true);
        const curIdx = cfg.nodes.findIndex((n) => n.id === cfg.activeNodeId);
        // Prefer next node that passed its last test, else strict next in ring
        const ordered = [];
        for (let i = 1; i < cfg.nodes.length; i++) {
            ordered.push(cfg.nodes[(Math.max(curIdx, 0) + i) % cfg.nodes.length]);
        }
        const healthy = ordered.find((n) => n.lastTest?.ok !== false) || ordered[0];
        return selectNode(healthy.id, true);
    }

    return {
        load,
        save,
        getState,
        getActiveNode,
        getProxyEnvVars,
        getChildProcessEnv,
        getChromiumProxyArgs,
        syncProxyEnv,
        addNode,
        updateNode,
        removeNode,
        selectNode,
        updateProxyPreferences,
        recordNodeTestResult,
        rotateNextNode,
    };
}

// === Pure-stdlib SOCKS5h / SOCKS5 / SOCKS4 / HTTP CONNECT Tunnel ===

function createBufferedReader(socket) {
    let buffer = Buffer.alloc(0);
    let ended = false;
    let error = null;
    const waiters = [];

    function flushWaiters() {
        while (waiters.length > 0) {
            const w = waiters[0];
            if (error) {
                waiters.shift();
                w.reject(error);
            } else if (buffer.length >= w.needed) {
                waiters.shift();
                const slice = buffer.subarray(0, w.needed);
                buffer = buffer.subarray(w.needed);
                w.resolve(slice);
            } else if (ended) {
                waiters.shift();
                w.reject(new Error('代理连接意外关闭'));
            } else {
                break;
            }
        }
    }

    function onData(chunk) {
        buffer = Buffer.concat([buffer, chunk]);
        flushWaiters();
    }
    function onEnd() { ended = true; flushWaiters(); }
    function onErr(e) { error = e; flushWaiters(); }

    socket.on('data', onData);
    socket.on('end', onEnd);
    socket.on('close', onEnd);
    socket.on('error', onErr);

    return {
        readExactly(needed) {
            if (buffer.length >= needed) {
                const slice = buffer.subarray(0, needed);
                buffer = buffer.subarray(needed);
                return Promise.resolve(slice);
            }
            if (error) return Promise.reject(error);
            if (ended) return Promise.reject(new Error('代理连接提前断开'));
            return new Promise((resolve, reject) => waiters.push({ needed, resolve, reject }));
        },
        readUntilDoubleCrlf() {
            const marker = Buffer.from('\r\n\r\n');
            const idx = buffer.indexOf(marker);
            if (idx !== -1) {
                const head = buffer.subarray(0, idx + 4);
                buffer = buffer.subarray(idx + 4);
                return Promise.resolve({ head: head.toString('utf8'), leftover: buffer });
            }
            return new Promise((resolve, reject) => {
                const check = () => {
                    const i = buffer.indexOf(marker);
                    if (i !== -1) {
                        const head = buffer.subarray(0, i + 4);
                        buffer = buffer.subarray(i + 4);
                        resolve({ head: head.toString('utf8'), leftover: buffer });
                    } else if (error) {
                        reject(error);
                    } else if (ended) {
                        reject(new Error('HTTP 代理握手响应不完整'));
                    } else {
                        socket.once('data', check);
                    }
                };
                socket.once('data', check);
            });
        },
        detach() {
            socket.off('data', onData);
            socket.off('end', onEnd);
            socket.off('close', onEnd);
            socket.off('error', onErr);
            return buffer;
        },
    };
}

async function openTunnelSocket(proxy, targetHost, targetPort, timeoutMs = 8000) {
    const connectOpts = { host: proxy.host, port: proxy.port };
    const socket = proxy.protocol === 'https'
        ? tls.connect({ ...connectOpts, rejectUnauthorized: true })
        : net.connect(connectOpts);

    socket.setTimeout(timeoutMs);

    await new Promise((resolve, reject) => {
        const onTimeout = () => reject(new Error('连接代理服务器超时'));
        socket.once('timeout', onTimeout);
        socket.once('error', reject);
        socket.once(proxy.protocol === 'https' ? 'secureConnect' : 'connect', () => {
            socket.off('timeout', onTimeout);
            resolve();
        });
    });

    const reader = createBufferedReader(socket);

    try {
        if (proxy.protocol === 'http' || proxy.protocol === 'https') {
            const headers = [
                `CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
                `Host: ${targetHost}:${targetPort}`,
            ];
            if (proxy.username || proxy.password) {
                const token = Buffer.from(`${proxy.username || ''}:${proxy.password || ''}`).toString('base64');
                headers.push(`Proxy-Authorization: Basic ${token}`);
            }
            headers.push('', '');
            socket.write(headers.join('\r\n'));
            const { head } = await reader.readUntilDoubleCrlf();
            const statusLine = head.split('\r\n')[0] || '';
            if (!/\s200(\s|$)/.test(statusLine)) {
                throw new Error(`HTTP 代理拒绝连接: ${statusLine.trim()}`);
            }
            const leftover = reader.detach();
            if (leftover.length > 0) socket.unshift(leftover);
            return socket;
        }

        if (proxy.protocol === 'socks4') {
            const portBuf = Buffer.alloc(2);
            portBuf.writeUInt16BE(targetPort, 0);
            const hostBuf = Buffer.from(targetHost, 'utf8');
            const userBuf = Buffer.from(proxy.username || '', 'utf8');
            const req = Buffer.concat([
                Buffer.from([0x04, 0x01]),
                portBuf,
                Buffer.from([0x00, 0x00, 0x00, 0x01]), // SOCKS4a domain marker
                userBuf,
                Buffer.from([0x00]),
                hostBuf,
                Buffer.from([0x00]),
            ]);
            socket.write(req);
            const resp = await reader.readExactly(8);
            if (resp[1] !== 0x5a) {
                throw new Error(`SOCKS4 代理连接失败 (code=${resp[1]})`);
            }
            const leftover = reader.detach();
            if (leftover.length > 0) socket.unshift(leftover);
            return socket;
        }

        // SOCKS5 / SOCKS5h (ATYPE 0x03 domain -> remote DNS resolution!)
        const hasCreds = Boolean(proxy.username || proxy.password);
        const methods = hasCreds ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00];
        socket.write(Buffer.from(methods));

        const greet = await reader.readExactly(2);
        if (greet[0] !== 0x05) throw new Error('非 SOCKS5 协议响应');
        if (greet[1] === 0xff) throw new Error('SOCKS5 认证方式不被接受（请核对用户名密码）');
        if (greet[1] === 0x02) {
            const uBuf = Buffer.from(proxy.username || '', 'utf8');
            const pBuf = Buffer.from(proxy.password || '', 'utf8');
            if (uBuf.length > 255 || pBuf.length > 255) throw new Error('代理用户名或密码过长');
            socket.write(Buffer.concat([
                Buffer.from([0x01, uBuf.length]),
                uBuf,
                Buffer.from([pBuf.length]),
                pBuf,
            ]));
            const authRes = await reader.readExactly(2);
            if (authRes[1] !== 0x00) throw new Error('SOCKS5 用户名或密码认证失败');
        } else if (greet[1] !== 0x00) {
            throw new Error(`不支持的 SOCKS5 认证方法 (${greet[1]})`);
        }

        const hostBytes = Buffer.from(targetHost, 'utf8');
        if (hostBytes.length > 255) throw new Error('目标主机名过长');
        const portBuf = Buffer.alloc(2);
        portBuf.writeUInt16BE(targetPort, 0);
        const connectReq = Buffer.concat([
            Buffer.from([0x05, 0x01, 0x00, 0x03, hostBytes.length]),
            hostBytes,
            portBuf,
        ]);
        socket.write(connectReq);

        const head = await reader.readExactly(4);
        if (head[1] !== 0x00) {
            const errMap = {
                1: '代理服务器内部错误',
                2: '规则拒绝连接',
                3: '目标网络不可达',
                4: '目标主机不可达',
                5: '目标拒绝连接',
                6: 'TTL 超时',
                7: '不支持的命令',
                8: '不支持的地址类型',
            };
            throw new Error(`SOCKS5 CONNECT 失败: ${errMap[head[1]] || `code ${head[1]}`}`);
        }
        const atype = head[3];
        if (atype === 0x01) {
            await reader.readExactly(6);
        } else if (atype === 0x03) {
            const lenBuf = await reader.readExactly(1);
            await reader.readExactly(lenBuf[0] + 2);
        } else if (atype === 0x04) {
            await reader.readExactly(18);
        }

        const leftover = reader.detach();
        if (leftover.length > 0) socket.unshift(leftover);
        return socket;
    } catch (err) {
        try { socket.destroy(); } catch { /* ignore */ }
        throw err;
    }
}

async function fetchJsonOverProxy(proxy, { host, port = 443, path: reqPath = '/', useTls = true, timeoutMs = 8000 }) {
    const rawSocket = await openTunnelSocket(proxy, host, port, timeoutMs);
    const conn = useTls
        ? tls.connect({ socket: rawSocket, servername: host, rejectUnauthorized: true })
        : rawSocket;

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            try { conn.destroy(); } catch { /* ignore */ }
            reject(new Error('通过代理获取出口信息超时'));
        }, timeoutMs);

        const finish = (err, data) => {
            clearTimeout(timer);
            try { conn.destroy(); } catch { /* ignore */ }
            if (err) reject(err);
            else resolve(data);
        };

        const chunks = [];
        conn.on('error', (err) => finish(err));
        conn.on('data', (c) => chunks.push(c));
        conn.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            const sep = raw.indexOf('\r\n\r\n');
            const body = sep !== -1 ? raw.slice(sep + 4) : raw;
            try {
                resolveAndDone(body);
            } catch (e) {
                finish(new Error(`解析出口信息失败: ${e.message}`));
            }
        });

        function resolveAndDone(body) {
            const trimmed = body.trim();
            // Handle simple chunked transfer if present
            let jsonText = trimmed;
            const firstBrace = trimmed.indexOf('{');
            const lastBrace = trimmed.lastIndexOf('}');
            if (firstBrace !== -1 && lastBrace > firstBrace) {
                jsonText = trimmed.slice(firstBrace, lastBrace + 1);
            }
            const parsed = JSON.parse(jsonText);
            finish(null, parsed);
        }

        const sendReq = () => {
            conn.write(
                `GET ${reqPath} HTTP/1.1\r\n` +
                `Host: ${host}\r\n` +
                `User-Agent: Antigravity-Deck/1.0\r\n` +
                `Accept: application/json\r\n` +
                `Connection: close\r\n\r\n`
            );
        };

        if (useTls) conn.once('secureConnect', sendReq);
        else sendReq();
    });
}

async function probeExitIpViaProxy(proxy, timeoutMs = 8000) {
    const start = Date.now();
    let info = null;
    try {
        info = await fetchJsonOverProxy(proxy, {
            host: 'ipinfo.io',
            port: 443,
            path: '/json',
            useTls: true,
            timeoutMs,
        });
    } catch {
        info = await fetchJsonOverProxy(proxy, {
            host: 'api.ipify.org',
            port: 443,
            path: '/?format=json',
            useTls: true,
            timeoutMs,
        });
    }
    const latencyMs = Date.now() - start;
    return {
        ok: true,
        exitIp: info.ip || null,
        country: info.country || null,
        city: info.city || null,
        org: info.org || null,
        latencyMs,
        testedAt: new Date().toISOString(),
    };
}

async function testProxyConfig(input, timeoutMs = 8000) {
    const proxy = parseProxyInput(input);
    try {
        return await probeExitIpViaProxy(proxy, timeoutMs);
    } catch (err) {
        return {
            ok: false,
            exitIp: null,
            country: null,
            city: null,
            org: null,
            latencyMs: null,
            error: err.message,
            testedAt: new Date().toISOString(),
        };
    }
}

async function getDirectExitIp(timeoutMs = 5000) {
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch('https://ipinfo.io/json', {
            signal: controller.signal,
            headers: { 'User-Agent': 'Antigravity-Deck/1.0', Accept: 'application/json' },
        });
        const data = await res.json();
        return {
            ok: true,
            exitIp: data.ip || null,
            country: data.country || null,
            city: data.city || null,
            org: data.org || null,
            latencyMs: Date.now() - start,
        };
    } catch (err) {
        return { ok: false, exitIp: null, error: err.message };
    } finally {
        clearTimeout(timer);
    }
}

const defaultStore = createProxyStore();

module.exports = {
    createProxyStore,
    parseProxyInput,
    buildProxyUrl,
    sanitizeNode,
    openTunnelSocket,
    testProxyConfig,
    probeExitIpViaProxy,
    getDirectExitIp,
    initProxyEnv: () => defaultStore.syncProxyEnv(),
    getProxyState: () => defaultStore.getState(),
    getProxyEnvVars: () => defaultStore.getProxyEnvVars(),
    getChildProcessEnv: (env) => defaultStore.getChildProcessEnv(env),
    getChromiumProxyArgs: () => defaultStore.getChromiumProxyArgs(),
    addProxyNode: (input) => defaultStore.addNode(input),
    updateProxyNode: (id, input) => defaultStore.updateNode(id, input),
    removeProxyNode: (id) => defaultStore.removeNode(id),
    selectProxyNode: (id, enabled) => defaultStore.selectNode(id, enabled),
    updateProxyPreferences: (prefs) => defaultStore.updateProxyPreferences(prefs),
    rotateNextProxyNode: () => defaultStore.rotateNextNode(),
    testSavedProxyNode: async (id) => {
        const cfg = defaultStore.load();
        const node = cfg.nodes.find((n) => n.id === id);
        if (!node) throw new Error('未找到指定代理节点');
        const res = await testProxyConfig(node);
        defaultStore.recordNodeTestResult(id, res);
        return { result: res, state: defaultStore.getState() };
    },
};
