'use client';

import { useState, useMemo, memo } from 'react';
import { Step } from '@/lib/types';
import { extractStepContent, getStepConfig } from '@/lib/step-utils';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ChevronRight, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { StepIcon } from '../ui/step-icon';
import { cn } from '@/lib/utils';
import { WaitingStep } from './waiting-step';
import { CodeChangeViewer } from './code-change-viewer';

interface ProcessingGroupProps {
    steps: { step: Step; originalIndex: number }[];
    cascadeId: string | null;
    lastTerminalIndex?: number;
    onStepAccepted?: () => void;
}

export const ProcessingGroup = memo(function ProcessingGroup({
    steps: groupSteps,
    cascadeId,
    lastTerminalIndex = -1,
    onStepAccepted,
}: ProcessingGroupProps) {
    const hasActive = useMemo(
        () =>
            groupSteps.some(
                ({ step }) =>
                    step.status === 'CORTEX_STEP_STATUS_IN_PROGRESS' ||
                    step.status === 'CORTEX_STEP_STATUS_PENDING' ||
                    step.status === 'CORTEX_STEP_STATUS_WAITING',
            ),
        [groupSteps],
    );
    const hasThinking = useMemo(
        () => groupSteps.some(({ step }) => Boolean(step.plannerResponse?.thinking?.trim())),
        [groupSteps],
    );

    // Default open while actively streaming or waiting, compact when completed unless toggled.
    const [open, setOpen] = useState(hasActive);

    const summaryLabel = useMemo(() => {
        const thoughts = groupSteps.filter(({ step }) => Boolean(step.plannerResponse?.thinking?.trim())).length;
        const tools = groupSteps.length - thoughts;
        const parts: string[] = [];
        if (thoughts > 0) parts.push(`${thoughts} 项思考`);
        if (tools > 0) parts.push(`${tools} 次工具调用`);
        return parts.length > 0 ? parts.join(' · ') : `已执行 ${groupSteps.length} 步操作`;
    }, [groupSteps]);

    const visibleItems = useMemo(() => {
        return groupSteps.filter(({ step, originalIndex }) => {
            if (step.status === 'CORTEX_STEP_STATUS_WAITING' && originalIndex > lastTerminalIndex) return true;
            if (step.plannerResponse?.thinking?.trim()) return true;
            return Boolean(extractStepContent(step));
        });
    }, [groupSteps, lastTerminalIndex]);

    if (visibleItems.length === 0 && !hasThinking) return null;

    return (
        <Collapsible open={open} onOpenChange={setOpen} className="my-2 rounded-xl border border-border/60 bg-muted/20 overflow-hidden">
            <CollapsibleTrigger asChild>
                <button
                    type="button"
                    className="w-full flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer text-left"
                >
                    <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 transition-transform duration-150', open && 'rotate-90')} />
                    {hasActive ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-foreground/75 shrink-0" />
                    ) : (
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                    )}
                    <span className="font-medium truncate">
                        {hasActive ? '正在思考与调用工具...' : `思考与执行过程（${summaryLabel}）`}
                    </span>
                </button>
            </CollapsibleTrigger>

            <CollapsibleContent>
                <div className="border-t border-border/40 divide-y divide-border/30">
                    {visibleItems.map(({ step, originalIndex }) => {
                        if (step.status === 'CORTEX_STEP_STATUS_WAITING' && originalIndex > lastTerminalIndex) {
                            return (
                                <div key={originalIndex} className="p-2.5">
                                    <WaitingStep
                                        step={step}
                                        originalIndex={originalIndex}
                                        cascadeId={cascadeId}
                                        onAccepted={onStepAccepted}
                                    />
                                </div>
                            );
                        }

                        const cfg = getStepConfig(step.type);
                        const thinkingText = step.plannerResponse?.thinking?.trim() || '';
                        const content = extractStepContent(step);
                        const isErr = step.status === 'CORTEX_STEP_STATUS_ERROR';
                        const isRunning = step.status === 'CORTEX_STEP_STATUS_IN_PROGRESS' || step.status === 'CORTEX_STEP_STATUS_PENDING';
                        const ackInfos = step.codeAcknowledgement?.codeAcknowledgementInfos;

                        return (
                            <div key={originalIndex} className="px-3 py-2 space-y-1.5 text-xs">
                                <div className="flex items-center gap-1.5 text-muted-foreground">
                                    <StepIcon name={cfg.icon} className="h-3.5 w-3.5 shrink-0" />
                                    <span className="font-medium text-foreground/85">{cfg.label}</span>
                                    {isRunning && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground ml-1" />}
                                    {isErr && <AlertCircle className="h-3 w-3 text-destructive ml-1" />}
                                </div>

                                {thinkingText && (
                                    <div className="text-muted-foreground leading-relaxed whitespace-pre-wrap pl-5 max-h-[200px] overflow-y-auto">
                                        {thinkingText}
                                    </div>
                                )}

                                {content && content !== thinkingText && (
                                    <pre className="pl-5 text-[11px] text-muted-foreground/90 font-mono whitespace-pre-wrap break-all overflow-x-auto max-h-[180px] overflow-y-auto">
                                        {content}
                                    </pre>
                                )}

                                {ackInfos && ackInfos.length > 0 && (
                                    <div className="pl-5">
                                        <CodeChangeViewer infos={ackInfos} isAccept={step.codeAcknowledgement?.isAccept} />
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            </CollapsibleContent>
        </Collapsible>
    );
});

ProcessingGroup.displayName = 'ProcessingGroup';
