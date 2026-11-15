const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { listFleetServers, pingFleet } = require('../src/fleet-manager');

let passed = 0;
let failed = 0;

async function runTest(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  PASS ${name}`);
    } catch (err) {
        failed++;
        console.error(`  FAIL ${name}:`, err.message);
    }
}

(async () => {
    console.log('\n[Test] fleet-manager unit tests');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-deck-fleet-'));
    const serversPath = path.join(tmpDir, 'servers.json');

    try {
        await runTest('returns empty fleet when servers.json does not exist', () => {
            const res = listFleetServers({ serversPath: path.join(tmpDir, 'missing.json') });
            assert.strictEqual(res.exists, false);
            assert.strictEqual(res.count, 0);
            assert.deepStrictEqual(res.servers, []);
        });

        await runTest('lists servers cleanly and never leaks token or secret URL path', async () => {
            fs.writeFileSync(serversPath, JSON.stringify({
                activeServer: 'ch',
                servers: [
                    {
                        id: 'ch',
                        name: '宁波电信',
                        ip: '110.42.109.192',
                        url: 'https://110.42.109.192:8765/bt-mcp-secret-path/mcp',
                        token: 'btmcp_super_secret_token_123',
                        hostname: 'zy0917441',
                        specs: { cores: 16, ram_gb: 24, disk_gb: 500, combo: '16h24g', region: '宁波' },
                    },
                    {
                        id: '82',
                        name: '弘速云美西',
                        ip: '82.158.88.15',
                        url: 'https://82.158.88.15:8765/bt-mcp-other/mcp',
                        token: 'btmcp_other_secret',
                        specs: { cores: 2, ram_gb: 2, disk_gb: 30 },
                    },
                ],
            }));

            const list = listFleetServers({ serversPath });
            assert.strictEqual(list.exists, true);
            assert.strictEqual(list.count, 2);
            assert.strictEqual(list.servers[0].isActive, true);
            assert.strictEqual(list.servers[0].combo, '16h24g');
            assert.strictEqual(list.servers[1].combo, '2h2g');

            const serialized = JSON.stringify(list);
            assert.ok(!serialized.includes('btmcp_'), 'must never leak btmcp token');
            assert.ok(!serialized.includes('bt-mcp-secret-path'), 'must never leak secret URL path');

            const pinged = await pingFleet({
                serversPath,
                probeServer: async (srv) => srv.id === 'ch'
                    ? { online: true, authOk: true, statusCode: 200, latencyMs: 18 }
                    : { online: false, authOk: false, statusCode: null, latencyMs: 3500, error: '连接超时' },
            });
            assert.strictEqual(pinged.onlineCount, 1);
            assert.strictEqual(pinged.servers[0].latencyMs, 18);
            assert.strictEqual(pinged.servers[1].online, false);
        });
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
    process.exit(failed > 0 ? 1 : 0);
})();
