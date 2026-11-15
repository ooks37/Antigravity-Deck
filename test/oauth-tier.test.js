const assert = require('assert');
const { classifyAccountTier } = require('../src/oauth-accounts');

let passed = 0;
let failed = 0;

async function runTest(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`PASS: ${name}`);
    } catch (err) {
        failed++;
        console.error(`FAIL: ${name}`);
        console.error(err);
    }
}

(async () => {
    await runTest('classifyAccountTier detects Free base accounts even with promo paidTier hint', () => {
        const res = classifyAccountTier({
            loadCodeAssist: {
                currentTier: { id: 'free-tier', name: 'Free' },
                paidTier: { id: 'g1-pro-tier', name: 'Google AI Pro' },
            },
            modelsMap: {
                'gemini-3.8-flash-low': { displayName: 'Gemini 3.8 Flash (Low)' },
                'claude-sonnet-4-6-thinking': { displayName: 'Claude Sonnet 4.6 (Thinking)' },
                'chat_20706_internal': { displayName: 'Internal' },
            },
        });
        assert.strictEqual(res.tierId, 'free');
        assert.strictEqual(res.hasGemini4, false);
        assert.strictEqual(res.hasClaude55, false);
        assert.strictEqual(res.hasClaude46, true);
    });

    await runTest('classifyAccountTier classifies Pro/full accounts unlocking Gemini 4 & Claude 5.5', () => {
        const res = classifyAccountTier({
            loadCodeAssist: {
                currentTier: { id: 'free-tier', name: 'Free' },
                paidTier: { id: 'g1-pro-tier', name: 'Google AI Pro' },
            },
            modelsMap: {
                'gemini-4-argon-medium': { displayName: 'Gemini 4 Argon (Medium)' },
                'claude-opus-5-5-thinking': { displayName: 'Claude Opus 5.5 (Thinking)' },
            },
        });
        assert.strictEqual(res.tierId, 'pro-full');
        assert.strictEqual(res.hasGemini4, true);
        assert.strictEqual(res.hasClaude55, true);
        assert.ok(res.tierLabel.includes('Google AI Pro'));
    });

    await runTest('classifyAccountTier detects Jio, Pixel, Student and AI Ultra accounts', () => {
        const jio = classifyAccountTier({
            loadCodeAssist: { currentTier: { id: 'jio-promo-tier', name: 'Jio Partner' } },
            agyModels: [{ id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' }],
        });
        assert.strictEqual(jio.tierId, 'jio');
        assert.ok(jio.tierLabel.includes('Jio'));

        const pixel = classifyAccountTier({
            loadCodeAssist: { currentTier: { id: 'pixel-9-pro-bundle', name: 'Pixel Perk' } },
            modelsMap: { 'gemini-4-hydrogen-high': { displayName: 'Gemini 4 Hydrogen (High)' } },
        });
        assert.strictEqual(pixel.tierId, 'pixel');
        assert.ok(pixel.tierLabel.includes('Pixel'));

        const student = classifyAccountTier({
            loadCodeAssist: { currentTier: { id: 'student-pro-tier', name: 'Student Plan' } },
        });
        assert.strictEqual(student.tierId, 'student');

        const ultra = classifyAccountTier({
            loadCodeAssist: {
                currentTier: { id: 'g1-ultra-tier', name: 'Google AI Ultra' },
                paidTier: { id: 'g1-ultra-tier', name: 'Google AI Ultra' },
            },
        });
        assert.strictEqual(ultra.tierId, 'ultra');
        assert.strictEqual(ultra.tierLabel, 'AI Ultra');
    });

    console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
    process.exit(failed > 0 ? 1 : 0);
})();
