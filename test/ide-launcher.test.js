const assert = require('assert');
const { buildLinuxIdeSpawn, findLinuxIdeBinary } = require('../src/ide-launcher');

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
    console.log('\n[Test] ide-launcher unit tests');

    await runTest('buildLinuxIdeSpawn wraps headless environments with xvfb-run + dbus + proxy args', () => {
        const spec = buildLinuxIdeSpawn('/opt/antigravity/Antigravity-x64/antigravity', ['--trust-workspace', '/srv/app'], {
            env: { PATH: '/usr/bin' },
            homeDir: '/root',
            getuid: () => 0,
            existsSync: (p) => p === '/usr/bin/xvfb-run' || p === '/usr/bin/dbus-run-session',
            getChildProcessEnv: (env) => ({ ...env, ALL_PROXY: 'socks5h://127.0.0.1:1080' }),
            getChromiumProxyArgs: () => ['--proxy-server=socks5://127.0.0.1:1080'],
        });

        assert.strictEqual(spec.headless, true);
        assert.strictEqual(spec.command, '/usr/bin/xvfb-run');
        assert.deepStrictEqual(spec.args.slice(0, 6), [
            '-a',
            '-s',
            '-screen 0 1280x800x24',
            '/usr/bin/dbus-run-session',
            '--',
            '/opt/antigravity/Antigravity-x64/antigravity',
        ]);
        assert.ok(spec.args.includes('--no-sandbox'));
        assert.ok(spec.args.includes('--disable-gpu'));
        assert.ok(spec.args.includes('--disable-dev-shm-usage'));
        assert.ok(spec.args.includes('--proxy-server=socks5://127.0.0.1:1080'));
        assert.ok(spec.args.includes('/srv/app'));
        assert.strictEqual(spec.env.HOME, '/root');
        assert.strictEqual(spec.env.ALL_PROXY, 'socks5h://127.0.0.1:1080');
    });

    await runTest('buildLinuxIdeSpawn runs binary directly when DISPLAY is set', () => {
        const spec = buildLinuxIdeSpawn('/usr/local/bin/antigravity', [], {
            env: { DISPLAY: ':0', HOME: '/home/dev' },
            homeDir: '/home/dev',
            getuid: () => 1000,
            existsSync: () => true,
            getChildProcessEnv: (env) => env,
            getChromiumProxyArgs: () => [],
        });

        assert.strictEqual(spec.headless, false);
        assert.strictEqual(spec.command, '/usr/local/bin/antigravity');
        assert.deepStrictEqual(spec.args, []);
        assert.strictEqual(spec.env.HOME, '/home/dev');
    });

    await runTest('findLinuxIdeBinary checks /opt/antigravity/Antigravity-x64/antigravity fallback', () => {
        const found = findLinuxIdeBinary(null, {
            existsSync: (p) => p === '/opt/antigravity/Antigravity-x64/antigravity',
            skipWhich: true,
        });
        assert.strictEqual(found, '/opt/antigravity/Antigravity-x64/antigravity');
    });

    console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
    process.exit(failed > 0 ? 1 : 0);
})();
