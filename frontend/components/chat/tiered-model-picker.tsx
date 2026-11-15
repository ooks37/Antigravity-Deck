'use client';

import { useState, useRef, useEffect, useMemo } from 'react';
import type { CascadeModel } from '@/lib/cascade-api';
import {
    groupModelsByFamily,
    parseModelLabel,
    formatEffortZh,
    formatQuotaPercent,
    formatResetCountdown,
    detectProvider,
} from '@/lib/model-tiers';
import { cn } from '@/lib/utils';
import { Sparkles, CircleDot, Bot, ChevronDown, Check, Clock, Zap } from 'lucide-react';

interface TieredModelPickerProps {
    models: CascadeModel[];
    selectedModel: string;
    onSelectModel: (modelId: string) => void;
}

function ProviderIcon({ provider }: { provider: 'gemini' | 'claude' | 'openai' | 'other' }) {
    if (provider === 'gemini') return <Sparkles className="h-3.5 w-3.5 text-sky-500 shrink-0" />;
    if (provider === 'claude') return <CircleDot className="h-3.5 w-3.5 text-violet-500 shrink-0" />;
    if (provider === 'openai') return <CircleDot className="h-3.5 w-3.5 text-emerald-500 shrink-0" />;
    return <Bot className="h-3.5 w-3.5 text-muted-foreground shrink-0" />;
}

export function TieredModelPicker({ models, selectedModel, onSelectModel }: TieredModelPickerProps) {
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
    const currentParsed = parseModelLabel(current?.label || current?.modelId || '默认模型');
    const currentQuotaPct = formatQuotaPercent(current?.quota);
    const currentProvider = detectProvider((current?.label || '') + ' ' + (current?.modelId || ''));

    return (
        <div className="relative" ref={pickerRef}>
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                className={cn(
                    'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-xs border transition-colors cursor-pointer max-w-[230px]',
                    'bg-muted/50 hover:bg-muted border-border/60 text-foreground'
                )}
                title="切换模型系列与思考深度"
            >
                <ProviderIcon provider={currentProvider} />
                <span className="truncate font-medium">{currentParsed.family}</span>
                {currentParsed.effort !== 'Standard' && (
                    <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-primary/12 text-primary font-medium shrink-0">
                        {currentParsed.effort}
                    </span>
                )}
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
                <div className="absolute bottom-full left-0 mb-2 w-[310px] sm:w-[360px] max-h-[65vh] overflow-y-auto rounded-2xl border border-border bg-popover text-popover-foreground shadow-xl z-50 p-2 space-y-1.5">
                    <div className="px-2 py-1 flex items-center justify-between text-[11px] text-muted-foreground border-b border-border/50">
                        <span className="font-medium">选择模型与推理深度</span>
                        <span className="text-[10px]">对话中可随时无损切换</span>
                    </div>

                    {families.length === 0 ? (
                        <div className="py-6 text-center text-xs text-muted-foreground">暂无可用模型</div>
                    ) : (
                        families.map((fam) => {
                            const hasSelected = fam.variants.some((v) => v.modelId === selectedModel);
                            const primaryVariant = fam.variants.find((v) => v.modelId === selectedModel)
                                || fam.variants[Math.min(1, fam.variants.length - 1)]
                                || fam.variants[0];
                            const pct = formatQuotaPercent(primaryVariant?.quota);
                            const countdown = formatResetCountdown(primaryVariant?.resetTime);

                            return (
                                <div
                                    key={fam.family}
                                    className={cn(
                                        'rounded-xl p-2 border transition-colors',
                                        hasSelected
                                            ? 'bg-primary/6 border-primary/30'
                                            : 'bg-transparent border-transparent hover:bg-muted/50'
                                    )}
                                >
                                    <div className="flex items-center justify-between gap-2">
                                        <button
                                            type="button"
                                            onClick={() => {
                                                if (primaryVariant) {
                                                    onSelectModel(primaryVariant.modelId);
                                                    setOpen(false);
                                                }
                                            }}
                                            className="flex items-center gap-2 min-w-0 flex-1 text-left cursor-pointer"
                                        >
                                            <ProviderIcon provider={fam.provider} />
                                            <span className="text-xs font-semibold truncate">{fam.family}</span>
                                            {fam.isRecommended && (
                                                <span className="text-[9px] px-1.5 py-0.2 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 shrink-0">
                                                    推荐
                                                </span>
                                            )}
                                            {primaryVariant?.tagTitle && (
                                                <span className="text-[9px] px-1.5 py-0.2 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 shrink-0 inline-flex items-center gap-0.5">
                                                    <Zap className="h-2.5 w-2.5" /> {primaryVariant.tagTitle}
                                                </span>
                                            )}
                                        </button>

                                        <div className="flex items-center gap-1.5 shrink-0">
                                            <div className="w-12 h-1.5 rounded-full bg-muted overflow-hidden">
                                                <div
                                                    className={cn(
                                                        'h-full rounded-full',
                                                        pct > 30 ? 'bg-emerald-500' : pct > 10 ? 'bg-amber-500' : 'bg-rose-500'
                                                    )}
                                                    style={{ width: `${pct}%` }}
                                                />
                                            </div>
                                            <span className="text-[10px] font-mono text-muted-foreground w-7 text-right">
                                                {pct}%
                                            </span>
                                        </div>
                                    </div>

                                    {/* Effort selector pills */}
                                    <div className="mt-1.5 flex items-center justify-between gap-2 pl-5">
                                        <div className="flex flex-wrap items-center gap-1">
                                            {fam.variants.map((v) => {
                                                const active = v.modelId === selectedModel;
                                                const exhausted = v.quota <= 0.01;
                                                return (
                                                    <button
                                                        key={v.modelId}
                                                        type="button"
                                                        onClick={() => {
                                                            onSelectModel(v.modelId);
                                                            setOpen(false);
                                                        }}
                                                        className={cn(
                                                            'px-2 py-0.5 rounded-full text-[10px] border transition-colors cursor-pointer inline-flex items-center gap-1',
                                                            active
                                                                ? 'bg-primary text-primary-foreground border-primary font-medium'
                                                                : exhausted
                                                                    ? 'bg-muted/30 text-muted-foreground/50 border-border/40 line-through'
                                                                    : 'bg-background hover:bg-muted border-border/70 text-foreground/80'
                                                        )}
                                                        title={`${v.label} · 剩余 ${formatQuotaPercent(v.quota)}%`}
                                                    >
                                                        {active && <Check className="h-2.5 w-2.5" />}
                                                        <span>{v.effort === 'Standard' ? '标准' : `${v.effort} (${formatEffortZh(v.effort)})`}</span>
                                                    </button>
                                                );
                                            })}
                                        </div>
                                        {countdown && (
                                            <span className="text-[9px] text-muted-foreground inline-flex items-center gap-0.5 shrink-0">
                                                <Clock className="h-2.5 w-2.5" /> {countdown}
                                            </span>
                                        )}
                                    </div>
                                </div>
                            );
                        })
                    )}
                </div>
            )}
        </div>
    );
}
