const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const {
    createProxyStore,
    parseProxyInput,
    buildProxyUrl,
    sanitizeNode,
    openTunnelSocket,
} = require('../src/proxy-manager');

let passed = 0;
let failed = 0;

async function runTest(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  PASS ${name}`);
    } catch (err) {
        failed++;
        console.error(`  FAIL ${name}:`, err.stack || err.message);
    }
}

(async () => {
    console.log('\n[Test] proxy-manager unit tests');

    await runTest('parseProxyInput parses socks5h URLs, socks alias, and shorthand host:port:user:pass', () => {
        const a = parseProxyInput('socks5h://u1:p%40ss@10.0.0.5:1080#US-West');
        assert.strictEqual(a.protocol, 'socks5h');
        assert.strictEqual(a.host, '10.0.0.5');
        assert.strictEqual(a.port, 1080);
        assert.strictEqual(a.username, 'u1');
        assert.strictEqual(a.password, 'p@ss');
        assert.strictEqual(a.name, 'US-West');

        const b = parseProxyInput('192.168.1.9:2080:alice:secret');
        assert.strictEqual(b.protocol, 'socks5h');
        assert.strictEqual(b.host, '192.168.1.9');
        assert.strictEqual(b.port, 2080);
        assert.strictEqual(b.username, 'alice');
        assert.strictEqual(b.password, 'secret');

        const c = parseProxyInput('socks://127.0.0.1:40000');
        assert.strictEqual(c.protocol, 'socks5h');

        assert.throws(() => parseProxyInput('ftp://1.2.3.4:21'));
        assert.throws(() => parseProxyInput('socks5h://1.2.3.4:99999'));
        assert.throws(() => parseProxyInput('socks5h://1.2.3.4:1080\r\nevil'));
    });

    await runTest('proxy store manages nodes, masks passwords, syncs env with localhost bypass, and rotates healthy nodes', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-proxy-test-'));
        try {
            const fakeEnv = {};
            const store = createProxyStore({
                settingsPath: path.join(tmp, 'proxy.settings.json'),
                env: fakeEnv,
            });

            const r1 = store.addNode({ name: 'NodeA', url: 'socks5h://alice:topsecret@1.1.1.1:1080', activate: true });
            assert.strictEqual(r1.node.hasPassword, true);
            assert.strictEqual('password' in r1.node, false);
            assert.ok(r1.node.maskedUrl.includes('alice:******@1.1.1.1:1080'));
            assert.strictEqual(fakeEnv.ALL_PROXY, buildProxyUrl({ protocol: 'socks5h', host: '1.1.1.1', port: 1080, username: 'alice', password: 'topsecret' }));
            assert.ok(fakeEnv.NO_PROXY.includes('127.0.0.1') && fakeEnv.NO_PROXY.includes('localhost'));
            assert.deepStrictEqual(store.getChromiumProxyArgs(), ['--proxy-server=socks5://1.1.1.1:1080', '--proxy-bypass-list=127.0.0.1;localhost;::1;0.0.0.0']);

            const r2 = store.addNode({ name: 'NodeB', protocol: 'http', host: '2.2.2.2', port: 8080 });
            const r3 = store.addNode({ name: 'NodeC', protocol: 'socks5h', host: '3.3.3.3', port: 1080 });
            store.recordNodeTestResult(r2.node.id, { ok: false, error: 'dead' });
            store.recordNodeTestResult(r3.node.id, { ok: true, exitIp: '3.3.3.3', latencyMs: 50 });

            // Rotating from NodeA skips failed NodeB and selects healthy NodeC
            const rotated = store.rotateNextNode();
            assert.strictEqual(rotated.activeNodeId, r3.node.id);
            assert.strictEqual(rotated.activeNode.name, 'NodeC');

            // Updating NodeA without supplying password keeps original password
            store.updateNode(r1.node.id, { name: 'NodeA-Updated', password: '' });
            const updatedRaw = store.load().nodes.find((n) => n.id === r1.node.id);
            assert.strictEqual(updatedRaw.password, 'topsecret');
            assert.strictEqual(sanitizeNode(updatedRaw).name, 'NodeA-Updated');

            // Selecting null disables proxy and restores env
            const disabled = store.selectNode(null);
            assert.strictEqual(disabled.enabled, false);
            assert.strictEqual(fakeEnv.ALL_PROXY, undefined);
            assert.deepStrictEqual(store.getChromiumProxyArgs(), []);

            // Removing active node clears active state
            store.selectNode(r3.node.id, true);
            const afterDel = store.removeNode(r3.node.id);
            assert.strictEqual(afterDel.state.enabled, false);
            assert.strictEqual(afterDel.state.activeNodeId, null);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    await runTest('openTunnelSocket performs full SOCKS5h RFC1929 auth + ATYPE=0x03 domain CONNECT handshake', async () => {
        let observedTargetHost = null;
        let observedTargetPort = null;
        let observedUser = null;
        let observedPass = null;

        const server = net.createServer((sock) => {
            let stage = 0;
            let buf = Buffer.alloc(0);
            sock.on('data', (chunk) => {
                buf = Buffer.concat([buf, chunk]);
                if (stage === 0 && buf.length >= 2) {
                    const nmethods = buf[1];
                    if (buf.length < 2 + nmethods) return;
                    buf = buf.subarray(2 + nmethods);
                    stage = 1;
                    sock.write(Buffer.from([0x05, 0x02])); // select user/pass
                }
                if (stage === 1 && buf.length >= 2) {
                    const ulen = buf[1];
                    if (buf.length < 2 + ulen + 1) return;
                    const plen = buf[2 + ulen];
                    if (buf.length < 3 + ulen + plen) return;
                    observedUser = buf.subarray(2, 2 + ulen).toString('utf8');
                    observedPass = buf.subarray(3 + ulen, 3 + ulen + plen).toString('utf8');
                    buf = buf.subarray(3 + ulen + plen);
                    stage = 2;
                    sock.write(Buffer.from([0x01, 0x00])); // auth success
                }
                if (stage === 2 && buf.length >= 5) {
                    const atype = buf[3];
                    assert.strictEqual(atype, 0x03); // remote DNS resolution (socks5h)
                    const dlen = buf[4];
                    if (buf.length < 5 + dlen + 2) return;
                    observedTargetHost = buf.subarray(5, 5 + dlen).toString('utf8');
                    observedTargetPort = buf.readUInt16BE(5 + dlen);
                    buf = buf.subarray(5 + dlen + 2);
                    stage = 3;
                    sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
                }
                if (stage === 3 && buf.length > 0) {
                    sock.write(buf); // echo tunneled payload
                    buf = Buffer.alloc(0);
                }
            });
        });

        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        try {
            const port = server.address().port;
            const tun = await openTunnelSocket({
                protocol: 'socks5h',
                host: '127.0.0.1',
                port,
                username: 'socksuser',
                password: 'sockspassword',
            }, 'example.com', 443, 3000);

            const echoed = await new Promise((resolve, reject) => {
                tun.once('error', reject);
                tun.once('data', (d) => resolve(d.toString('utf8')));
                tun.write('PING_TUNNEL');
            });
            tun.destroy();

            assert.strictEqual(observedUser, 'socksuser');
            assert.strictEqual(observedPass, 'sockspassword');
            assert.strictEqual(observedTargetHost, 'example.com');
            assert.strictEqual(observedTargetPort, 443);
            assert.strictEqual(echoed, 'PING_TUNNEL');
        } finally {
            server.close();
        }
    });

    await runTest('openTunnelSocket supports HTTP CONNECT with Basic auth', async () => {
        let seenConnect = '';
        const server = net.createServer((sock) => {
            sock.once('data', (chunk) => {
                seenConnect = chunk.toString('utf8');
                sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            });
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        try {
            const port = server.address().port;
            const tun = await openTunnelSocket({
                protocol: 'http',
                host: '127.0.0.1',
                port,
                username: 'u',
                password: 'p',
            }, 'ipinfo.io', 443, 3000);
            tun.destroy();
            assert.ok(seenConnect.startsWith('CONNECT ipinfo.io:443 HTTP/1.1'));
            assert.ok(seenConnect.includes('Proxy-Authorization: Basic '));
        } finally {
            server.close();
        }
    });

    console.log(`\nSummary: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
})();
