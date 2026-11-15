const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createUserManager } = require('../src/user-manager');

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
    console.log('\n[Test] user-manager multi-user auth & isolation tests');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-users-'));
    const dbPath = path.join(tmpDir, 'deck.db');

    try {
        await runTest('bootstraps initial admin and verifies scrypt password & sessions', () => {
            const mgr = createUserManager({ dbPath, initialAdminPassword: 'init-secret-99' });
            const admin = mgr.getPrimaryAdmin();
            assert.strictEqual(admin.username, 'admin');
            assert.strictEqual(admin.role, 'admin');
            assert.strictEqual(mgr.authenticate('ADMIN', 'init-secret-99').id, admin.id);
            assert.strictEqual(mgr.authenticate('admin', 'wrong-pass'), null);

            const { token } = mgr.createSession(admin.id);
            assert.ok(token.length >= 32);
            assert.strictEqual(mgr.authenticateRequest({ headers: { cookie: `ag_session=${token}` } }).id, admin.id);
            assert.strictEqual(mgr.authenticateRequest({ headers: { authorization: `Bearer ${token}` } }).id, admin.id);
            assert.strictEqual(mgr.authenticateRequest({ url: `/ws?token=${token}`, headers: {} }).id, admin.id);
            assert.strictEqual(mgr.deleteSession(token), true);
            assert.strictEqual(mgr.verifySessionToken(token), null);
            mgr.close();
        });

        await runTest('manages members, enforces validation, and protects last active admin', () => {
            const mgr = createUserManager({ dbPath });
            const admin = mgr.getPrimaryAdmin();

            const alice = mgr.createUser({ username: 'alice', password: 'alice-pass-1', displayName: 'Alice', role: 'member' });
            const bob = mgr.createUser({ username: 'bob', password: 'bob-pass-2', displayName: 'Bob', role: 'member' });
            assert.strictEqual(alice.role, 'member');
            assert.strictEqual(bob.role, 'member');
            assert.strictEqual(mgr.listUsers().length, 3);

            assert.throws(() => mgr.createUser({ username: 'Alice', password: 'another-pass' }), /已存在/);
            assert.throws(() => mgr.createUser({ username: 'x', password: '123' }), /用户名/);

            const aliceSession = mgr.createSession(alice.id);
            assert.strictEqual(mgr.verifySessionToken(aliceSession.token).username, 'alice');
            mgr.updateUser(alice.id, { disabled: true });
            assert.strictEqual(mgr.verifySessionToken(aliceSession.token), null);
            assert.strictEqual(mgr.authenticate('alice', 'alice-pass-1'), null);
            mgr.updateUser(alice.id, { disabled: false, password: 'alice-new-pass' });
            assert.ok(mgr.authenticate('alice', 'alice-new-pass'));

            assert.throws(() => mgr.updateUser(admin.id, { disabled: true }), /管理员/);
            assert.throws(() => mgr.updateUser(admin.id, { role: 'member' }), /管理员/);
            assert.throws(() => mgr.deleteUser(admin.id, bob.id), /管理员/);
            assert.throws(() => mgr.deleteUser(admin.id, admin.id), /自己/);

            const bobDeleted = mgr.deleteUser(bob.id, admin.id);
            assert.strictEqual(bobDeleted.deleted, true);
            mgr.close();
        });

        await runTest('changeOwnCredentials checks currentPassword and enforces strict conversation isolation & rename', () => {
            const mgr = createUserManager({ dbPath });
            const admin = mgr.getPrimaryAdmin();
            const alice = mgr.listUsers().find((u) => u.username === 'alice');
            const charlie = mgr.createUser({ username: 'charlie', password: 'charlie-pass-3', role: 'member' });

            assert.throws(() => mgr.changeOwnCredentials(alice.id, { currentPassword: 'wrong', newPassword: 'next-pass-9' }), /失败/);
            const updatedAlice = mgr.changeOwnCredentials(alice.id, {
                currentPassword: 'alice-new-pass',
                newPassword: 'alice-final-pass',
                displayName: 'Alice Wang',
            });
            assert.strictEqual(updatedAlice.displayName, 'Alice Wang');
            assert.ok(mgr.authenticate('alice', 'alice-final-pass'));

            // Unclaimed conversation belongs exclusively to primary admin
            assert.strictEqual(mgr.canAccessConversation('conv-legacy-01', admin), true);
            assert.strictEqual(mgr.canAccessConversation('conv-legacy-01', alice), false);

            // Assigned conversation belongs exclusively to its owner
            mgr.assignConversationOwner('conv-alice-01', alice.id, '初始标题');
            assert.strictEqual(mgr.canAccessConversation('conv-alice-01', alice), true);
            assert.strictEqual(mgr.canAccessConversation('conv-alice-01', charlie), false);
            assert.strictEqual(mgr.canAccessConversation('conv-alice-01', admin), false);

            const renamed = mgr.renameConversation('conv-alice-01', '服务器体检记录', alice);
            assert.strictEqual(renamed.title, '服务器体检记录');
            assert.strictEqual(mgr.getConversationMetaMap().get('conv-alice-01').customTitle, '服务器体检记录');
            assert.throws(() => mgr.renameConversation('conv-alice-01', '恶意篡改', charlie), /无权重命名/);

            mgr.removeConversationMeta('conv-alice-01');
            assert.strictEqual(mgr.getConversationMetaMap().has('conv-alice-01'), false);
            mgr.close();
        });
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
    process.exit(failed > 0 ? 1 : 0);
})();
