'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { lsCall } from '@/lib/cascade-api';
import { Brain, AlertTriangle, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

// === Types ===

interface KnowledgeItem {
    dirName?: string;
    dirUri?: string;
    metadataUri?: string;
    metadataContents?: string;
    artifactSourceUris?: string[];
    [key: string]: unknown;
}

interface GetKnowledgeItemsResponse {
    items?: KnowledgeItem[];
    [key: string]: unknown;
}

// === Helpers ===

/** True for the AbortError thrown when a fetch is cancelled (expected, not a user error). */
function isAbortError(e: unknown): boolean {
    return e instanceof DOMException && e.name === 'AbortError';
}

/** A short display name for a knowledge item. */
function itemDisplayName(item: KnowledgeItem): string {
    if (item.dirName) return item.dirName;
    if (item.dirUri) {
        const parts = item.dirUri.replace(/\/$/, '').split('/');
        return parts[parts.length - 1] ?? item.dirUri;
    }
    return '（未命名）';
}

/** Extract a short summary from metadataContents (first non-empty line). */
function itemSummary(item: KnowledgeItem): string | undefined {
    if (!item.metadataContents) return undefined;
    const lines = item.metadataContents.split('\n').map(l => l.trim()).filter(Boolean);
    return lines[0];
}

// === Shared presentational primitives ===

function LoadingSpinner({ label }: { label: string }) {
    return (
        <div className="flex items-center justify-center py-16">
            <div className="flex flex-col items-center gap-3">
                <Loader2 className="w-6 h-6 text-muted-foreground/50 animate-spin" />
                <span className="text-sm text-muted-foreground">{label}</span>
            </div>
        </div>
    );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
    return (
        <div className="flex items-center justify-center py-16">
            <div className="flex flex-col items-center gap-3 max-w-sm text-center">
                <AlertTriangle className="w-6 h-6 text-red-400/60" />
                <span className="text-sm font-medium text-foreground/70">加载失败</span>
                <span className="text-xs text-muted-foreground font-mono break-all">{message}</span>
                <button
                    onClick={onRetry}
                    className="text-xs px-3 py-1.5 rounded-lg bg-muted/40 hover:bg-muted/70 text-muted-foreground hover:text-foreground transition-colors border border-border/30"
                >
                    重试
                </button>
            </div>
        </div>
    );
}

function EmptyState() {
    return (
        <div className="rounded-xl border border-border/50 bg-card/50 p-10 text-center">
            <Brain className="w-8 h-8 mx-auto text-muted-foreground/20 mb-3" />
            <p className="text-sm font-medium text-muted-foreground/60 mb-1">未找到知识记忆条目</p>
            <p className="text-xs text-muted-foreground/40 max-w-xs mx-auto">
                当助手保存持久化记忆产物后，相关知识条目将显示在此处。
            </p>
        </div>
    );
}

// === Knowledge item row ===

function KnowledgeItemRow({ item }: { item: KnowledgeItem }) {
    const name = itemDisplayName(item);
    const summary = itemSummary(item);
    const sourceCount = item.artifactSourceUris?.length ?? 0;

    return (
        <div className="px-4 py-3 hover:bg-muted/20 transition-colors">
            <div className="grid grid-cols-[1fr_auto] items-start gap-3">
                <div className="flex flex-col gap-0.5 min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                        <Brain className="w-3.5 h-3.5 shrink-0 text-violet-400/60" />
                        <span className="text-sm font-medium truncate">{name}</span>
                        {sourceCount > 0 && (
                            <span className="text-[9px] font-medium text-muted-foreground/50 bg-muted/40 px-1 py-0.5 rounded shrink-0">
                                {sourceCount} 个来源
                            </span>
                        )}
                    </div>
                    {summary && (
                        <p className="text-xs text-muted-foreground/60 pl-6 line-clamp-2">{summary}</p>
                    )}
                    {item.dirUri && (
                        <p className="text-[10px] text-muted-foreground/40 pl-6 font-mono truncate">{item.dirUri}</p>
                    )}
                </div>
                <Badge className="text-[9px] h-5 px-1.5 bg-muted/30 text-muted-foreground border border-border/20 hover:bg-muted/30 shrink-0 mt-0.5">
                    知识库
                </Badge>
            </div>
        </div>
    );
}

// === Main Component ===

export function MemoriesView() {
    const [items, setItems] = useState<KnowledgeItem[] | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const fetchAbortRef = useRef<AbortController | null>(null);

    const fetchData = useCallback(() => {
        if (fetchAbortRef.current !== null) fetchAbortRef.current.abort();
        const ac = new AbortController();
        fetchAbortRef.current = ac;

        setIsLoading(true);
        setError(null);

        lsCall<GetKnowledgeItemsResponse>('GetKnowledgeItems', {}, ac.signal)
            .then(res => {
                if (ac.signal.aborted) return;
                setItems(res.items ?? []);
                setIsLoading(false);
            })
            .catch((e: unknown) => {
                if (isAbortError(e)) return;
                setError(e instanceof Error ? e.message : '加载知识条目失败');
                setIsLoading(false);
            });
    }, []);

    useEffect(() => {
        fetchData();
        return () => {
            if (fetchAbortRef.current !== null) fetchAbortRef.current.abort();
        };
    }, [fetchData]);

    if (isLoading && items === null) {
        return (
            <div className="flex-1 flex items-center justify-center">
                <div className="flex flex-col items-center gap-3">
                    <Brain className="w-8 h-8 text-muted-foreground/50 animate-pulse" />
                    <span className="text-sm text-muted-foreground">正在加载记忆...</span>
                </div>
            </div>
        );
    }

    if (error !== null) {
        return (
            <div className="flex-1 flex items-center justify-center">
                <div className="flex flex-col items-center gap-3 max-w-sm text-center">
                    <AlertTriangle className="w-8 h-8 text-red-400/60" />
                    <span className="text-sm font-medium text-foreground/70">加载记忆失败</span>
                    <span className="text-xs text-muted-foreground font-mono break-all">{error}</span>
                    <button
                        onClick={() => fetchData()}
                        className="text-xs px-3 py-1.5 rounded-lg bg-muted/40 hover:bg-muted/70 text-muted-foreground hover:text-foreground transition-colors border border-border/30"
                    >
                        重试
                    </button>
                </div>
            </div>
        );
    }

    const itemList = items ?? [];

    return (
        <div className="flex-1 overflow-y-auto">
            <div className="max-w-3xl mx-auto p-6 space-y-6">
                {/* Header */}
                <div className="flex items-center gap-3">
                    <div className="p-2 rounded-lg bg-gradient-to-br from-violet-500/10 to-indigo-500/10 border border-violet-500/20">
                        <Brain className="w-5 h-5 text-violet-400" />
                    </div>
                    <div>
                        <h2 className="text-lg font-semibold">长期记忆</h2>
                        <p className="text-xs text-muted-foreground">
                            {itemList.length === 0
                                ? '尚未存储任何知识条目'
                                : `共 ${itemList.length} 条知识记忆`}
                        </p>
                    </div>
                    {isLoading && (
                        <Loader2 className="w-4 h-4 text-muted-foreground/50 animate-spin ml-auto" />
                    )}
                </div>

                {/* Content */}
                {itemList.length === 0 ? (
                    <EmptyState />
                ) : (
                    <div className="rounded-xl border border-border/50 bg-card/50 overflow-hidden">
                        <div className="grid grid-cols-[1fr_auto] gap-3 px-4 py-2 text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium border-b border-border/30 bg-muted/10">
                            <span>知识条目</span>
                            <span>类型</span>
                        </div>
                        <div className="divide-y divide-border/20">
                            {itemList.map((item, i) => (
                                <KnowledgeItemRow key={item.dirUri ?? item.dirName ?? String(i)} item={item} />
                            ))}
                        </div>
                    </div>
                )}

                {/* Footer */}
                <p className="text-center text-[10px] text-muted-foreground/40 pb-4">
                    只读视图 — 知识条目由助手在对话过程中自动管理
                </p>
            </div>
        </div>
    );
}
