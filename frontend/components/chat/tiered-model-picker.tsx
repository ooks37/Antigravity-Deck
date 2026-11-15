'use client';

import { useState, useRef, useEffect, useMemo } from 'react';
import type { ActiveModelAccount, CascadeModel, CascadeModelGroup, QuotaPoolInfo } from '@/lib/cascade-api';
import {
    groupModelsByFamily,
    findFamilyByModelId,
    pickVariantForEffort,
    formatEffortZh,
    formatEffortDescZh,
    formatQuotaPercent,
    formatResetCountdown,
    detectProvider,
    type EffortLevel,
    type ModelFamily,
} from '@/lib/model-tiers';
import { cn } from '@/lib/utils';
import { Sparkles, CircleDot, Bot, ChevronDown, Check, Clock, Zap, Brain, Loader2, RefreshCw, Repeat2 } from 'lucide-react';

interface TieredModelPickerProps {
    models: CascadeModel[];
    groups?: CascadeModelGroup[];
    selectedModel: string;
    selectedEffort: EffortLevel;
    onSelectModel: (modelId: string) => void;
    onSelectEffort?: (effort: EffortLevel) => void;
    activeAccount?: ActiveModelAccount | null;
    hubSyncing?: boolean;
    loading?: boolean;
}

const PROVIDER_CATEGORY_LABEL: Record<ModelFamily['provider'], string> = {
    gemini: 'Gemini 系列',
    claude: 'Claude 系列',
    openai: 'GPT / OpenAI',
    other: '其他模型',
};

function ProviderIcon({ provider }: { provider: 'gemini' | 'claude' | 'openai' | 'other' }) {
    if (provider === 'gemini') return <Sparkles className="h-3.5 w-3.5 text-sky-500 shrink-0" />;
    if (provider === 'claude') return <CircleDot className="h-3.5 w-3.5 text-violet-500 shrink-0" />;
    if (provider === 'openai') return <CircleDot className="h-3.5 w-3.5 text-emerald-500 shrink-0" />;
    return <Bot className="h-3.5 w-3.5 text-muted-foreground shrink-0" />;
}

export function deriveQuotaPools(models: CascadeModel[], activeAccount?: ActiveModelAccount | null): QuotaPoolInfo[] {
    if (Array.isArray(activeAccount?.pools) && activeAccount!.pools.length > 0) {
        return activeAccount!.pools;
    }
    const defs = [
        { id: 'gemini-pro', label: 'Gemini Pro', shortLabel: 'G·Pro', match: (s: string) => /gemini/i.test(s) && !/flash/i.test(s) },
        { id: 'gemini-flash', label: 'Gemini Flash', shortLabel: 'G·Flash', match: (s: string) => /gemini/i.test(s) && /flash/i.test(s) },
        { id: 'claude', label: 'Claude', shortLabel: 'Claude', match: (s: string) => /claude/i.test(s) },
        { id: 'gpt', label: 'GPT', shortLabel: 'GPT', match: (s: string) => /gpt/i.test(s) },
    ];
    const rawPools: QuotaPoolInfo[] = [];
    for (const def of defs) {
        const matched = models.filter((m) => def.match(`${m.cliModelId || ''} ${m.modelId || ''} ${m.label || ''}`));
        if (!matched.length) continue;
        const quotas = matched.map((m) => m.quota).filter((q): q is number => typeof q === 'number' && Number.isFinite(q));
        const minQ = quotas.length ? Math.min(...quotas) : 1;
        const resetTime = matched.map((m) => m.resetTime).find(Boolean) || null;
        rawPools.push({
            id: def.id,
            label: def.label,
            shortLabel: def.shortLabel,
            remainingFraction: minQ,
            percent: Math.round(minQ * 100),
            resetTime,
            modelCount: matched.length,
        });
    }
    const gPro = rawPools.find((p) => p.id === 'gemini-pro');
    const gFlash = rawPools.find((p) => p.id === 'gemini-flash');
    if (gPro && gFlash && Math.abs(gPro.remainingFraction - gFlash.remainingFraction) <= 0.015) {
        const minQ = Math.min(gPro.remainingFraction, gFlash.remainingFraction);
        const merged: QuotaPoolInfo = {
            id: 'gemini',
            label: 'Gemini',
            shortLabel: 'Gemini',
            remainingFraction: minQ,
            percent: Math.round(minQ * 100),
            resetTime: gPro.resetTime || gFlash.resetTime || null,
            modelCount: gPro.modelCount + gFlash.modelCount,
        };
        return [merged, ...rawPools.filter((p) => p.id !== 'gemini-pro' && p.id !== 'gemini-flash')];
    }
    if (gPro && !gFlash) {
        gPro.id = 'gemini';
        gPro.label = 'Gemini';
        gPro.shortLabel = 'Gemini';
    } else if (gFlash && !gPro) {
        gFlash.id = 'gemini';
        gFlash.label = 'Gemini';
        gFlash.shortLabel = 'Gemini';
    }
    return rawPools;
}

export function QuotaPoolsPill({
    models,
    activeAccount,
    onRefresh,
    onRotate,
}: {
    models: CascadeModel[];
    activeAccount?: ActiveModelAccount | null;
    onRefresh?: () => Promise<void> | void;
    onRotate?: () => Promise<void> | void;
}) {
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState<'refresh' | 'rotate' | null>(null);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const onMouseDown = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener('mousedown', onMouseDown);
        return () => document.removeEventListener('mousedown', onMouseDown);
    }, [open]);

    const pools = useMemo(() => deriveQuotaPools(models, activeAccount), [models, activeAccount]);
    const families = useMemo(() => groupModelsByFamily(models), [models]);

    if (pools.length === 0) return null;

    const handleRefresh = async () => {
        if (!onRefresh || busy) return;
        setBusy('refresh');
        try {
            await onRefresh();
        } finally {
            setBusy(null);
        }
    };

    const handleRotate = async () => {
        if (!onRotate || busy) return;
        setBusy('rotate');
        try {
            await onRotate();
        } finally {
            setBusy(null);
        }
    };

    return (
        <div ref={ref} className="relative">
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                className={cn(
                    'flex items-center gap-1.5 h-6 px-2 rounded-md border text-[11px] font-medium transition-colors cursor-pointer select-none',
                    open
                        ? 'bg-muted/80 text-foreground border-border'
                        : 'bg-muted/30 text-muted-foreground hover:text-foreground hover:bg-muted/60 border-border/50'
                )}
                title="各模型池独立剩余额度百分比（点击查看详情与重置时间）"
            >
                <span className="text-[10px] text-muted-foreground/70 hidden sm:inline">额度</span>
                {pools.map((pool, idx) => {
                    const pct = pool.percent ?? Math.round((pool.remainingFraction ?? 1) * 100);
                    return (
                        <span key={pool.id} className="inline-flex items-center gap-1">
                            {idx > 0 && <span className="text-muted-foreground/30">·</span>}
                            <span
                                className={cn(
                                    'w-1.5 h-1.5 rounded-full shrink-0',
                                    pct > 50 ? 'bg-emerald-400' : pct > 15 ? 'bg-amber-400' : 'bg-rose-400'
                                )}
                            />
                            <span className="text-[10px] text-muted-foreground font-normal">{pool.label}</span>
                            <span
                                className={cn(
                                    'font-mono text-[10px] font-semibold',
                                    pct > 50 ? 'text-emerald-400' : pct > 15 ? 'text-amber-400' : 'text-rose-400'
                                )}
                            >
                                {pct}%
                            </span>
                        </span>
                    );
                })}
            </button>

            {open && (
                <div className="absolute bottom-full right-0 mb-1.5 w-[290px] max-w-[90vw] rounded-xl border border-border bg-popover/95 backdrop-blur-xl shadow-2xl z-50 overflow-hidden animate-in fade-in slide-in-from-bottom-1 duration-150">
                    <div className="flex items-center justify-between px-3 py-2 border-b border-border/50 bg-muted/20">
                        <div className="flex items-center gap-1.5 min-w-0">
                            <span className="text-[11px] font-semibold text-foreground">分池模型额度</span>
                            {activeAccount?.tierLabel && (
                                <span className="text-[9px] px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20 font-medium truncate">
                                    {activeAccount.tierLabel}
                                </span>
                            )}
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                            {onRotate && (
                                <button
                                    type="button"
                                    onClick={handleRotate}
                                    disabled={busy !== null}
                                    className="inline-flex items-center gap-1 h-5 px-1.5 rounded text-[10px] font-medium bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 border border-emerald-500/20 transition-colors cursor-pointer disabled:opacity-40"
                                    title="切换到额度更高的账号"
                                >
                                    <Repeat2 className={cn('w-2.5 h-2.5', busy === 'rotate' && 'animate-spin')} />
                                    换号
                                </button>
                            )}
                            {onRefresh && (
                                <button
                                    type="button"
                                    onClick={handleRefresh}
                                    disabled={busy !== null}
                                    className="inline-flex items-center justify-center w-5 h-5 rounded text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors cursor-pointer disabled:opacity-40"
                                    title="实时刷新 CloudCode 分池额度"
                                >
                                    <RefreshCw className={cn('w-3 h-3', busy === 'refresh' && 'animate-spin')} />
                                </button>
                            )}
                        </div>
                    </div>

                    {/* Independent Quota Pools */}
                    <div className="p-2.5 space-y-2 border-b border-border/40">
                        {pools.map((pool) => {
                            const pct = pool.percent ?? Math.round((pool.remainingFraction ?? 1) * 100);
                            const resetText = formatResetCountdown(pool.resetTime);
                            return (
                                <div key={pool.id} className="rounded-lg border border-border/50 bg-muted/15 px-2.5 py-2 space-y-1.5">
                                    <div className="flex items-center justify-between gap-2">
                                        <div className="flex items-center gap-1.5 min-w-0">
                                            <span
                                                className={cn(
                                                    'w-2 h-2 rounded-full shrink-0',
                                                    pct > 50 ? 'bg-emerald-400' : pct > 15 ? 'bg-amber-400' : 'bg-rose-400'
                                                )}
                                            />
                                            <span className="text-xs font-medium text-foreground">{pool.label} 池</span>
                                            {resetText && (
                                                <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground/75">
                                                    <Clock className="w-2.5 h-2.5" />
                                                    {resetText}
                                                </span>
                                            )}
                                        </div>
                                        <span
                                            className={cn(
                                                'text-xs font-mono font-bold shrink-0',
                                                pct > 50 ? 'text-emerald-400' : pct > 15 ? 'text-amber-400' : 'text-rose-400'
                                            )}
                                        >
                                            {pct}%
                                        </span>
                                    </div>
                                    <div className="w-full h-1.5 rounded-full bg-muted overflow-hidden">
                                        <div
                                            className={cn(
                                                'h-full rounded-full transition-all',
                                                pct > 50 ? 'bg-emerald-400' : pct > 15 ? 'bg-amber-400' : 'bg-rose-400'
                                            )}
                                            style={{ width: `${Math.max(2, pct)}%` }}
                                        />
                                    </div>
                                </div>
                            );
                        })}
                    </div>

                    {/* Per-family breakdown on right side by percentage */}
                    <div className="max-h-[180px] overflow-y-auto px-2.5 py-2 space-y-1">
                        <div className="text-[10px] text-muted-foreground/70 px-1 pb-0.5 flex items-center justify-between">
                            <span>模型系列明细</span>
                            <span>剩余百分比</span>
                        </div>
                        {families.map((fam) => {
                            const pct = formatQuotaPercent(fam.variants[0]?.quota);
                            return (
                                <div key={fam.family} className="flex items-center justify-between px-1.5 py-1 rounded-md hover:bg-muted/30 text-[11px]">
                                    <span className="text-foreground/90 truncate pr-2">{fam.family}</span>
                                    <span
                                        className={cn(
                                            'font-mono font-semibold shrink-0',
                                            pct > 50 ? 'text-emerald-400' : pct > 15 ? 'text-amber-400' : 'text-rose-400'
                                        )}
                                    >
                                        {pct}%
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}

export function TieredModelPicker({
    models,
    groups = [],
    selectedModel,
    selectedEffort,
    onSelectModel,
    onSelectEffort,
    activeAccount,
    hubSyncing = false,
    loading = false,
}: TieredModelPickerProps) {
    const [open, setOpen] = useState(false);
    const pickerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
                setOpen(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, []);

    const families = useMemo(() => groupModelsByFamily(models), [models]);
    // Group model families into dynamic categories (prefer server groups when categorized, else by provider)
    const categorizedSections = useMemo(() => {
        const meaningfulGroups = groups.filter((g) => g.name && g.models.length > 0 && g.name !== 'Models');
        if (meaningfulGroups.length > 1) {
            return meaningfulGroups.map((g) => ({
                category: g.name,
                provider: detectProvider(g.name + ' ' + (g.models[0]?.modelId || '')),
                families: groupModelsByFamily(g.models),
            }));
        }
        const map = new Map<string, { category: string; provider: ModelFamily['provider']; families: ModelFamily[] }>();
        for (const fam of families) {
            const cat = PROVIDER_CATEGORY_LABEL[fam.provider];
            if (!map.has(cat)) {
                map.set(cat, { category: cat, provider: fam.provider, families: [] });
            }
            map.get(cat)!.families.push(fam);
        }
        return Array.from(map.values());
    }, [families, groups]);
    const current = models.find((m) => m.modelId === selectedModel) || models[0];
    const currentFamily = findFamilyByModelId(families, current?.modelId);
    const displayName = currentFamily?.family || current?.label || '选择模型';
    const currentProvider = currentFamily?.provider || detectProvider((current?.label || '') + ' ' + (current?.modelId || ''));

    return (
        <div className="relative" ref={pickerRef}>
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                className={cn(
                    'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-xs border transition-colors cursor-pointer max-w-[210px]',
                    'bg-muted/50 hover:bg-muted border-border/60 text-foreground'
                )}
                title={activeAccount?.tierLabel ? `切换模型 · 当前账号权益: ${activeAccount.tierLabel}` : '切换模型'}
            >
                {loading
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin text-primary shrink-0" />
                    : <ProviderIcon provider={currentProvider} />
                }
                <span className="truncate font-medium">{displayName}</span>
                <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
            </button>

            {open && (
                <div className="absolute bottom-full left-0 mb-2 w-[310px] sm:w-[350px] max-h-[62vh] overflow-y-auto rounded-2xl border border-border bg-popover text-popover-foreground shadow-xl z-50 p-2 space-y-2">
                    <div className="px-2 py-1.5 flex items-center justify-between gap-2 text-[11px] text-muted-foreground border-b border-border/50">
                        <span className="font-medium text-foreground/90">
                            选择模型 ({families.length})
                        </span>
                        <div className="flex items-center gap-1.5 min-w-0">
                            {activeAccount?.tierLabel && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary truncate max-w-[160px]">
                                    {activeAccount.tierLabel}
                                </span>
                            )}
                            {hubSyncing && (
                                <span className="text-[9px] text-amber-500 shrink-0">同步中</span>
                            )}
                        </div>
                    </div>

                    {categorizedSections.length === 0 ? (
                        <div className="py-6 text-center text-xs text-muted-foreground">
                            {loading ? '正在拉取当前账号真实模型...' : '暂无可用模型'}
                        </div>
                    ) : (
                        categorizedSections.map((section) => (
                            <div key={section.category} className="space-y-1">
                                <div className="px-2 pt-1 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                                    <span className="inline-flex items-center gap-1">
                                        <ProviderIcon provider={section.provider} />
                                        <span>{section.category}</span>
                                    </span>
                                    <span className="font-mono text-[9px] opacity-75">{section.families.length}</span>
                                </div>
                                {section.families.map((fam) => {
                                    const isSelectedFamily = currentFamily?.family === fam.family;
                                    const targetVariant = pickVariantForEffort(fam, selectedEffort);
                                    const pct = formatQuotaPercent(targetVariant?.quota);
                                    const countdown = formatResetCountdown(targetVariant?.resetTime);
                                    const exhausted = (targetVariant?.quota ?? 1) <= 0.01;

                                    return (
                                        <button
                                            key={fam.family}
                                            type="button"
                                            onClick={() => {
                                                if (targetVariant) {
                                                    onSelectModel(targetVariant.modelId);
                                                    if (onSelectEffort && targetVariant.effort !== 'standard') {
                                                        onSelectEffort(targetVariant.effort);
                                                    }
                                                    setOpen(false);
                                                }
                                            }}
                                            className={cn(
                                                'w-full rounded-xl px-2.5 py-2 border transition-colors text-left cursor-pointer space-y-1',
                                                isSelectedFamily
                                                    ? 'bg-primary/8 border-primary/35'
                                                    : 'bg-transparent border-transparent hover:bg-muted/60'
                                            )}
                                        >
                                            <div className="flex items-center justify-between gap-2">
                                                <div className="flex items-center gap-2 min-w-0 flex-1">
                                                    <ProviderIcon provider={fam.provider} />
                                                    <span className={cn('text-xs font-semibold truncate', exhausted && 'text-muted-foreground line-through')}>
                                                        {fam.family}
                                                    </span>
                                                    {fam.isRecommended && (
                                                        <span className="text-[9px] px-1.5 py-0.2 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 shrink-0">
                                                            推荐
                                                        </span>
                                                    )}
                                                    {targetVariant?.tagTitle && (
                                                        <span className="text-[9px] px-1.5 py-0.2 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 shrink-0 inline-flex items-center gap-0.5">
                                                            <Zap className="h-2.5 w-2.5" /> {targetVariant.tagTitle}
                                                        </span>
                                                    )}
                                                </div>

                                                <div className="flex items-center gap-1.5 shrink-0">
                                                    {isSelectedFamily && <Check className="h-3.5 w-3.5 text-primary" />}
                                                    <span className={cn(
                                                        'text-[10px] font-mono w-8 text-right',
                                                        pct <= 15 ? 'text-amber-500 font-semibold' : 'text-muted-foreground'
                                                    )}>
                                                        {pct}%
                                                    </span>
                                                </div>
                                            </div>

                                            <div className="flex items-center justify-between gap-2 pl-5">
                                                <div className="w-24 h-1 rounded-full bg-muted overflow-hidden">
                                                    <div
                                                        className={cn(
                                                            'h-full rounded-full',
                                                            pct > 30 ? 'bg-emerald-500' : pct > 10 ? 'bg-amber-500' : 'bg-rose-500'
                                                        )}
                                                        style={{ width: `${pct}%` }}
                                                    />
                                                </div>
                                                {countdown ? (
                                                    <span className="text-[9px] text-muted-foreground inline-flex items-center gap-0.5 shrink-0">
                                                        <Clock className="h-2.5 w-2.5" /> {countdown}
                                                    </span>
                                                ) : fam.supportsThinking ? (
                                                    <span className="text-[9px] text-muted-foreground/75 shrink-0">支持调节思考程度</span>
                                                ) : null}
                                            </div>
                                        </button>
                                    );
                                })}
                            </div>
                        ))
                    )}
                </div>
            )}
        </div>
    );
}

interface EffortPickerProps {
    models: CascadeModel[];
    selectedModel: string;
    selectedEffort: EffortLevel;
    onSelectModel: (modelId: string) => void;
    onSelectEffort: (effort: EffortLevel) => void;
}

export function EffortPicker({
    models,
    selectedModel,
    selectedEffort,
    onSelectModel,
    onSelectEffort,
}: EffortPickerProps) {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) {
                setOpen(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, []);

    const families = useMemo(() => groupModelsByFamily(models), [models]);
    const current = models.find((m) => m.modelId === selectedModel) || models[0];
    const currentFamily = findFamilyByModelId(families, current?.modelId);
    const activeVariant = currentFamily
        ? pickVariantForEffort(currentFamily, selectedEffort)
        : null;
    const tunableVariants = (currentFamily?.variants || []).filter((v) => v.effort !== 'standard');
    const isFixedThinking = tunableVariants.length === 1 && tunableVariants[0].effort === 'thinking';
    const hasChoices = tunableVariants.length > 1;
    const currentEffortLabel = activeVariant
        ? formatEffortZh(activeVariant.effort)
        : formatEffortZh(selectedEffort);

    return (
        <div className="relative" ref={ref}>
            <button
                type="button"
                disabled={!hasChoices && !isFixedThinking}
                onClick={() => hasChoices && setOpen((v) => !v)}
                title={hasChoices ? '独立调整思考程度 (--effort / 变体档位)' : isFixedThinking ? '当前模型默认开启深度思考' : '当前模型不支持多档思考调节'}
                className={cn(
                    'inline-flex items-center gap-1 h-7 px-2.5 rounded-full text-[11px] font-medium border transition-colors',
                    hasChoices
                        ? 'bg-violet-500/10 text-violet-700 dark:text-violet-300 border-violet-500/30 hover:bg-violet-500/15 cursor-pointer'
                        : isFixedThinking
                            ? 'bg-violet-500/8 text-violet-600/85 dark:text-violet-300/85 border-violet-500/20 cursor-default'
                            : 'bg-muted/40 text-muted-foreground border-border/50 opacity-75 cursor-default'
                )}
            >
                <Brain className="h-3 w-3 shrink-0" />
                <span>思考: {currentEffortLabel}</span>
                {hasChoices && <ChevronDown className="h-3 w-3 opacity-75 shrink-0" />}
            </button>

            {open && hasChoices && currentFamily && (
                <div className="absolute bottom-full left-0 mb-2 w-52 rounded-2xl border border-border bg-popover text-popover-foreground shadow-xl z-50 p-1.5 space-y-1">
                    <div className="px-2 py-1 text-[10px] font-medium text-muted-foreground border-b border-border/50">
                        思考程度 ({currentFamily.family})
                    </div>
                    {tunableVariants.map((v) => {
                        const active = (activeVariant?.modelId || selectedModel) === v.modelId;
                        const pct = formatQuotaPercent(v.quota);
                        return (
                            <button
                                key={v.modelId}
                                type="button"
                                onClick={() => {
                                    onSelectEffort(v.effort);
                                    onSelectModel(v.modelId);
                                    setOpen(false);
                                }}
                                className={cn(
                                    'w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-xl text-left text-xs transition-colors cursor-pointer',
                                    active
                                        ? 'bg-primary text-primary-foreground font-medium'
                                        : 'hover:bg-muted/60 text-foreground'
                                )}
                            >
                                <div className="min-w-0">
                                    <div className="flex items-center gap-1.5">
                                        {active && <Check className="h-3 w-3 shrink-0" />}
                                        <span>{formatEffortZh(v.effort)}</span>
                                    </div>
                                    <div className={cn('text-[9px] truncate', active ? 'text-primary-foreground/80' : 'text-muted-foreground')}>
                                        {formatEffortDescZh(v.effort)}
                                    </div>
                                </div>
                                <span className={cn('text-[10px] font-mono shrink-0', active ? 'text-primary-foreground/90' : 'text-muted-foreground')}>
                                    {pct}%
                                </span>
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
