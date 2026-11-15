'use client';

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Step } from '@/lib/types';
import { extractStepContent } from '@/lib/step-utils';
import { MarkdownRenderer } from '../markdown-renderer';
import { useCopy } from './chat-helpers';
import { Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { API_BASE } from '@/lib/config';
import { authFetch } from '@/lib/auth';
import { AlertTriangle, Check, ChevronDown, ChevronRight, Copy, FileText } from 'lucide-react';

function ArtifactPreviewButton({ fileUri }: { fileUri: string }) {
    const fileName = fileUri.split('/').pop() || '产物文件';
    const [content, setContent] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [open, setOpen] = useState(false);
    const { copied, copy } = useCopy();

    const loadContent = useCallback(async () => {
        if (content !== null) return;
        setLoading(true);
        try {
            const cleanPath = fileUri.replace(/^file:\/\//, '');
            const res = await authFetch(`${API_BASE}/api/file/read`, {
                method: 'POST',
                body: JSON.stringify({ path: cleanPath }),
            });
            if (res.ok) {
                const data = await res.json();
                setContent(data.content || '（空文件）');
            } else {
                setContent(`无法加载文件 (${res.status})`);
            }
        } catch {
            setContent('加载文件内容失败');
        } finally {
            setLoading(false);
        }
    }, [fileUri, content]);

    useEffect(() => {
        if (open) loadContent();
    }, [open, loadContent]);

    return (
        <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
                <Button
                    variant="ghost"
                    className="mt-2 w-full justify-start gap-2 px-3 py-2 h-auto text-xs font-medium text-foreground/85 border border-border/60 bg-muted/25 hover:bg-muted/50 rounded-lg"
                >
                    <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{fileName}</span>
                    <span className="ml-auto text-[10px] text-muted-foreground">查看文件</span>
                </Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-[85vw] sm:w-[540px] sm:max-w-[540px] p-0 flex flex-col">
                <SheetHeader className="px-4 py-3 border-b border-border/40">
                    <div className="flex items-center justify-between pr-6">
                        <SheetTitle className="text-sm font-medium flex items-center gap-2">
                            <FileText className="h-4 w-4 text-muted-foreground" />
                            {fileName}
                        </SheetTitle>
                        {content && (
                            <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs" onClick={(e) => copy(content, e)}>
                                {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                                {copied ? '已复制' : '复制'}
                            </Button>
                        )}
                    </div>
                    <SheetDescription className="text-[11px] font-mono truncate">{fileUri}</SheetDescription>
                </SheetHeader>
                <ScrollArea className="flex-1 p-4">
                    {loading ? (
                        <div className="text-xs text-muted-foreground py-4">正在读取文件...</div>
                    ) : (
                        <div className="text-sm leading-relaxed">
                            <MarkdownRenderer content={content || ''} />
                        </div>
                    )}
                </ScrollArea>
            </SheetContent>
        </Sheet>
    );
}

export const AgentResponse = memo(function AgentResponse({ step, index }: { step: Step; index: number }) {
    const content = useMemo(() => extractStepContent(step), [step]);
    const thinking = useMemo(() => (step.plannerResponse?.thinking || '').trim(), [step]);
    const isThinkingPhase = step.status === 'CORTEX_STEP_STATUS_IN_PROGRESS' && !content && Boolean(thinking);
    const [showThinking, setShowThinking] = useState(isThinkingPhase);
    const { copied, copy } = useCopy();
    const isError = step.type === 'CORTEX_STEP_TYPE_ERROR_MESSAGE';
    const reviewUris = step.notifyUser?.reviewAbsoluteUris || [];

    if (!content && !thinking && reviewUris.length === 0) return null;

    if (isError) {
        return (
            <div className="my-2">
                <div className="border-l-2 border-destructive/70 bg-destructive/5 rounded-r-xl px-4 py-3 text-sm">
                    <div className="flex items-center gap-1.5 text-xs font-medium text-destructive mb-1">
                        <AlertTriangle className="h-3.5 w-3.5" />
                        <span>执行异常</span>
                    </div>
                    <div className="text-xs sm:text-sm text-destructive/90 leading-relaxed whitespace-pre-wrap">
                        {content}
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="group my-3" data-step-index={index}>
            {thinking && (
                <div className="mb-2.5 rounded-xl border border-border/60 bg-muted/25 overflow-hidden">
                    <button
                        type="button"
                        onClick={() => setShowThinking((v) => !v)}
                        className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors cursor-pointer text-left"
                    >
                        {showThinking ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
                        <span>思考过程</span>
                        <span className="text-[10px] text-muted-foreground/60 ml-auto font-normal">
                            {thinking.length} 字
                        </span>
                    </button>
                    {showThinking && (
                        <div className="px-3 pb-2.5 pt-1 border-t border-border/40 text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap max-h-[260px] overflow-y-auto">
                            {thinking}
                        </div>
                    )}
                </div>
            )}

            {content && (
                <div className="relative rounded-2xl bg-card border border-border/50 px-4 py-3 text-sm leading-relaxed">
                    <MarkdownRenderer content={content} />
                    <div className="mt-2 flex items-center justify-end opacity-80 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                        <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground gap-1"
                            onClick={(e) => copy(content, e)}
                        >
                            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                            <span>{copied ? '已复制' : '复制'}</span>
                        </Button>
                    </div>
                </div>
            )}

            {reviewUris.length > 0 && (
                <div className="space-y-1">
                    {reviewUris.map((uri) => (
                        <ArtifactPreviewButton key={uri} fileUri={uri} />
                    ))}
                </div>
            )}
        </div>
    );
});

AgentResponse.displayName = 'AgentResponse';
