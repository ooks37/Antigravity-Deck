'use client';

import { useState, useRef, useEffect, useMemo } from 'react';
import type { ActiveModelAccount, CascadeModel } from '@/lib/cascade-api';
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
} from '@/lib/model-tiers';
import { cn } from '@/lib/utils';
import { Sparkles, CircleDot, Bot, ChevronDown, Check, Clock, Zap, Brain } from 'lucide-react';

interface TieredModelPickerProps {
    models: CascadeModel[];
    selectedModel: string;
    selectedEffort: EffortLevel;
    onSelectModel: (modelId: string) => void;
    onSelectEffort?: (effort: EffortLevel) => void;
    activeAccount?: ActiveModelAccount | null;
    hubSyncing?: boolean;
}

function ProviderIcon({ provider }: { provider: 'gemini' | 'claude' | 'openai' | 'other' }) {
    if (provider === 'gemini') return <Sparkles className="h-3.5 w-3.5 text-sky-500 shrink-0" />;
    if (provider === 'claude') return <CircleDot className="h-3.5 w-3.5 text-violet-500 shrink-0" />;
    if (provider === 'openai') return <CircleDot className="h-3.5 w-3.5 text-emerald-500 shrink-0" />;
    return <Bot className="h-3.5 w-3.5 text-muted-foreground shrink-0" />;
}

export function TieredModelPicker({
    models,
    selectedModel,
    selectedEffort,
    onSelectModel,
    onSelectEffort,
    activeAccount,
    hubSyncing = false,
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
    const current = models.find((m) => m.modelId === selectedModel) || models[0];
    const currentFamily = findFamilyByModelId(families, current?.modelId);
    const displayName = currentFamily?.family || current?.label || '选择模型';
    const currentQuotaPct = formatQuotaPercent(current?.quota);
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
                <ProviderIcon provider={currentProvider} />
                <span className="truncate font-medium">{displayName}</span>
                {current && typeof current.quota === 'number' && (
                    <span className={cn(
                        'text-[10px] font-mono shrink-0',
                        currentQuotaPct <= 15 ? 'text-amber-500 font-semibold' : 'text-muted-foreground'
                    )}>
                        {currentQuotaPct}%
                    </span>
                )}
                <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
            </button>

            {open && (
                <div className="absolute bottom-full left-0 mb-2 w-[300px] sm:w-[340px] max-h-[62vh] overflow-y-auto rounded-2xl border border-border bg-popover text-popover-foreground shadow-xl z-50 p-2 space-y-1">
                    <div className="px-2 py-1.5 flex items-center justify-between gap-2 text-[11px] text-muted-foreground border-b border-border/50">
                        <span className="font-medium text-foreground/90">选择模型</span>
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

                    {families.length === 0 ? (
                        <div className="py-6 text-center text-xs text-muted-foreground">暂无可用模型</div>
                    ) : (
                        families.map((fam) => {
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
                        })
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
