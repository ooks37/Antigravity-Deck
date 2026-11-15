import type { CascadeModel } from './cascade-api';

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'thinking' | 'standard';

export interface ModelVariant {
    modelId: string;
    cliModelId?: string;
    label: string;
    effort: EffortLevel;
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
    supportsThinking: boolean;
    variants: ModelVariant[];
}

const EFFORT_RANK: Record<EffortLevel, number> = {
    low: 1,
    medium: 2,
    high: 3,
    xhigh: 4,
    max: 5,
    thinking: 3,
    standard: 0,
};

const EFFORT_ZH: Record<string, string> = {
    low: '低',
    medium: '中',
    high: '高',
    xhigh: '极高',
    max: '极致',
    thinking: '深度思考',
    standard: '标准',
};

const EFFORT_DESC_ZH: Record<string, string> = {
    low: '快速响应 · 低思考开销',
    medium: '均衡模式 · 速度与质量兼顾',
    high: '深度推理 · 适合复杂分析',
    xhigh: '极限思考 · 最强复杂问题求解',
    max: '最高推理预算',
    thinking: '内置深度思考链路',
    standard: '标准推理模式',
};

export function formatEffortZh(effort: string): string {
    return EFFORT_ZH[effort.toLowerCase()] || effort;
}

export function formatEffortDescZh(effort: string): string {
    return EFFORT_DESC_ZH[effort.toLowerCase()] || effort;
}

export function normalizeEffortKey(raw?: string | null): EffortLevel {
    const clean = String(raw || '').trim().toLowerCase();
    if (clean === 'low' || clean === 'medium' || clean === 'high' || clean === 'xhigh' || clean === 'max' || clean === 'thinking' || clean === 'standard') {
        return clean;
    }
    return 'standard';
}

export function parseModelLabel(label: string): { family: string; effort: EffortLevel; supportsThinking: boolean } {
    const clean = String(label || '').trim();
    const match = clean.match(/^(.*?)\s*\((Low|Medium|High|XHigh|Max|Thinking)\)\s*$/i);
    if (!match) {
        return { family: clean || '默认模型', effort: 'standard', supportsThinking: false };
    }
    const effort = normalizeEffortKey(match[2]);
    return {
        family: match[1].trim(),
        effort,
        supportsThinking: effort !== 'standard',
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
        const { family, effort, supportsThinking } = parseModelLabel(m.label || m.modelId);
        let group = map.get(family);
        if (!group) {
            group = {
                family,
                provider: detectProvider(family + ' ' + m.modelId),
                isRecommended: Boolean(m.isRecommended),
                supportsThinking,
                variants: [],
            };
            map.set(family, group);
        }
        if (m.isRecommended) group.isRecommended = true;
        if (supportsThinking) group.supportsThinking = true;
        group.variants.push({
            modelId: m.modelId,
            cliModelId: m.cliModelId,
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

export function pickVariantForEffort(family: ModelFamily, preferredEffort: EffortLevel): ModelVariant {
    const exact = family.variants.find((v) => v.effort === preferredEffort);
    if (exact) return exact;
    if (preferredEffort === 'max' || preferredEffort === 'xhigh') {
        const high = family.variants.find((v) => v.effort === 'xhigh')
            || family.variants.find((v) => v.effort === 'high')
            || family.variants[family.variants.length - 1];
        if (high) return high;
    }
    if (preferredEffort === 'high' || preferredEffort === 'medium') {
        const med = family.variants.find((v) => v.effort === 'medium')
            || family.variants.find((v) => v.effort === 'high')
            || family.variants[0];
        if (med) return med;
    }
    if (preferredEffort === 'low') {
        const low = family.variants.find((v) => v.effort === 'low') || family.variants[0];
        if (low) return low;
    }
    return family.variants.find((v) => v.isRecommended)
        || family.variants.find((v) => v.effort === 'medium')
        || family.variants[0];
}

export function findFamilyByModelId(families: ModelFamily[], modelId?: string | null): ModelFamily | undefined {
    if (!modelId) return families[0];
    return families.find((f) => f.variants.some((v) => v.modelId === modelId || v.cliModelId === modelId));
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
