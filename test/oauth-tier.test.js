const assert = require('assert');
const { classifyAccountTier } = require('../src/oauth-accounts');
const { buildCliFallbackModels } = require('../src/routes/conversations');

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

    await runTest('buildCliFallbackModels maps CloudCode Gemini pool quota/reset/rec to Gemini 4 and Orchestrator', () => {
        const res = buildCliFallbackModels(
            [
                { id: 'gemini-4-argon-medium', label: 'Gemini 4 Argon (Medium)' },
                { id: 'gemini-4-hydrogen-high', label: 'Gemini 4 Hydrogen (High)' },
                { id: 'gemini-pro-orchestrator-g1-pro', label: 'Orchestrator (Argon)' },
                { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
                { id: 'claude-sonnet-5-5-medium', label: 'Claude Sonnet 5.5 (Medium)' },
                { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' },
            ],
            {
                rawModelsMap: {
                    'gemini-3.8-flash-tiered': {
                        recommended: true,
                        supportsImages: true,
                        quotaInfo: { remainingFraction: 0.25, resetTime: '2026-11-15T16:13:31Z' },
                    },
                    'claude-sonnet-5-5-medium': {
                        recommended: true,
                        supportsImages: true,
                        tagTitle: 'New',
                        quotaInfo: { remainingFraction: 0.9, resetTime: '2026-11-15T19:12:06Z' },
                    },
                    'gpt-oss-120b-medium': {
                        recommended: true,
                        supportsImages: false,
                        quotaInfo: { remainingFraction: 0.9, resetTime: '2026-11-15T19:12:06Z' },
                    },
                },
            },
        );
        const byId = Object.fromEntries(res.models.map((m) => [m.modelId, m]));
        assert.strictEqual(byId['gemini-4-argon-medium'].quota, 0.25);
        assert.strictEqual(byId['gemini-4-argon-medium'].resetTime, '2026-11-15T16:13:31Z');
        assert.strictEqual(byId['gemini-4-argon-medium'].isRecommended, true);
        assert.strictEqual(byId['gemini-4-hydrogen-high'].quota, 0.25);
        assert.strictEqual(byId['gemini-pro-orchestrator-g1-pro'].quota, 0.25);
        assert.strictEqual(byId['gemini-pro-orchestrator-g1-pro'].resetTime, '2026-11-15T16:13:31Z');
        assert.strictEqual(byId['gemini-pro-orchestrator-g1-pro'].isRecommended, false);
        assert.strictEqual(res.defaultModel, 'gemini-4-argon-medium');
        assert.deepStrictEqual(res.groups.map((g) => g.name), ['Gemini', 'Claude', 'GPT / OpenAI']);
        assert.ok(res.groups[0].models.some((m) => m.modelId === 'gemini-pro-orchestrator-g1-pro'));
    });

    console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
    process.exit(failed > 0 ? 1 : 0);
})();
