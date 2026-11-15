import type { CascadeModel } from './cascade-api';

export interface ModelVariant {
    modelId: string;
    label: string;
    effort: string;
    effortRank: number;
    quota: number;
    resetTime?: string | null;
    supportsImages: boolean;
    isRecommended: boolean;
    tagTitle?: string;
    tagDescription?: string;
}

export interface ModelFamily {
    family: string;
    provider: 'gemini' | 'claude' | 'openai' | 'other';
    isRecommended: boolean;
    variants: ModelVariant[];
}

const EFFORT_RANK: Record<string, number> = {
    Low: 1,
    Medium: 2,
    High: 3,
    XHigh: 4,
    Thinking: 4,
    Standard: 0,
};

const EFFORT_ZH: Record<string, string> = {
    Low: '低',
    Medium: '中',
    High: '高',
    XHigh: '极高',
    Thinking: '深度思考',
    Standard: '标准',
};

export function formatEffortZh(effort: string): string {
    return EFFORT_ZH[effort] || effort;
}

export function parseModelLabel(label: string): { family: string; effort: string } {
    const clean = String(label || '').trim();
    const match = clean.match(/^(.*?)\s*\((Low|Medium|High|XHigh|Thinking)\)\s*$/i);
    if (!match) {
        return { family: clean || '未知模型', effort: 'Standard' };
    }
    const rawEffort = match[2].toLowerCase();
    const normalizedEffort = rawEffort === 'xhigh'
        ? 'XHigh'
        : rawEffort.charAt(0).toUpperCase() + rawEffort.slice(1);
    return {
        family: match[1].trim(),
        effort: normalizedEffort,
    };
}

export function detectProvider(labelOrId: string): ModelFamily['provider'] {
    const low = labelOrId.toLowerCase();
    if (low.includes('gemini') || low.includes('hydrogen') || low.includes('argon')) return 'gemini';
    if (low.includes('claude')) return 'claude';
    if (low.includes('gpt') || low.includes('openai')) return 'openai';
    return 'other';
}

export function groupModelsByFamily(models: CascadeModel[]): ModelFamily[] {
    const map = new Map<string, ModelFamily>();
    for (const m of models) {
        const { family, effort } = parseModelLabel(m.label || m.modelId);
        let group = map.get(family);
        if (!group) {
            group = {
                family,
                provider: detectProvider(family + ' ' + m.modelId),
                isRecommended: Boolean(m.isRecommended),
                variants: [],
            };
            map.set(family, group);
        }
        if (m.isRecommended) group.isRecommended = true;
        group.variants.push({
            modelId: m.modelId,
            label: m.label,
            effort,
            effortRank: EFFORT_RANK[effort] ?? 9,
            quota: typeof m.quota === 'number' ? m.quota : 1,
            resetTime: m.resetTime || null,
            supportsImages: m.supportsImages,
            isRecommended: m.isRecommended,
            tagTitle: m.tagTitle,
            tagDescription: m.tagDescription,
        });
    }

    const families = Array.from(map.values());
    for (const f of families) {
        f.variants.sort((a, b) => a.effortRank - b.effortRank);
    }
    return families;
}

export function formatQuotaPercent(quota: number | undefined | null): number {
    if (typeof quota !== 'number' || Number.isNaN(quota)) return 100;
    return Math.max(0, Math.min(100, Math.round(quota * 100)));
}

export function formatResetCountdown(resetTime?: string | null): string {
    if (!resetTime) return '';
    const t = new Date(resetTime).getTime();
    if (Number.isNaN(t)) return '';
    const diffMs = t - Date.now();
    if (diffMs <= 0) return '即将重置';
    const mins = Math.floor(diffMs / 60000);
    if (mins < 60) return `${mins}分后重置`;
    const hours = Math.floor(mins / 60);
    const remMins = mins % 60;
    if (hours < 24) return `${hours}h${remMins}m后重置`;
    const days = Math.floor(hours / 24);
    return `${days}天${hours % 24}h后重置`;
}
