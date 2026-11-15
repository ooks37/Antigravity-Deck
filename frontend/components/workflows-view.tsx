'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import type { ComponentType, ReactNode } from 'react';
import { lsCall } from '@/lib/cascade-api';
import { Workflow, Activity, AlertTriangle, Loader2, BookOpen, ScrollText, FolderOpen, Copy, ChevronDown, ChevronRight, Check } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';

// === Types ===

// GetWorkspaceInfos response
interface WorkspaceInfo {
    workspaceUri?: string;
    gitRootUri?: string;
    [key: string]: unknown;
}

interface GetWorkspaceInfosResponse {
    homeDirPath?: string;
    homeDirUri?: string;
    geminiDirUri?: string;
    workspaceInfos?: WorkspaceInfo[];
    [key: string]: unknown;
}

// WorkflowSpec — used for both workflows and skills
interface WorkflowSpec {
    path?: string;
    name?: string;
    description?: string;
    content?: string;
    turbo?: boolean;
    isBuiltin?: boolean;
    scope?: string;
    baseDir?: string;
    disableModelInvocation?: boolean;
    pluginName?: string;
    [key: string]: unknown;
}

interface GetAllWorkflowsResponse {
    workflows?: WorkflowSpec[];
    [key: string]: unknown;
}

interface GetAllSkillsResponse {
    skills?: WorkflowSpec[];
    [key: string]: unknown;
}

// CortexMemory — a rule
interface CortexMemory {
    memoryId?: string;
    title?: string;
    metadata?: unknown;
    source?: string;
    scope?: string;
    textMemory?: string;
    absolutePath?: string;
    [key: string]: unknown;
}

interface GetAllRulesResponse {
    memories?: CortexMemory[];
    [key: string]: unknown;
}

type TabId = 'workflows' | 'skills' | 'rules';

// === Helpers ===

function workflowName(w: WorkflowSpec): string {
    return w.name ?? w.path ?? '（未命名）';
}

function ruleName(r: CortexMemory): string {
    return r.title ?? r.memoryId ?? '（未命名）';
}

/** True for the AbortError thrown when a fetch is cancelled (expected, not a user error). */
function isAbortError(e: unknown): boolean {
    return e instanceof DOMException && e.name === 'AbortError';
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

function EmptyState({ icon: Icon, title, hint }: { icon: ComponentType<{ className?: string }>; title: string; hint: string }) {
    return (
        <div className="rounded-xl border border-border/50 bg-card/50 p-10 text-center">
            <Icon className="w-8 h-8 mx-auto text-muted-foreground/20 mb-3" />
            <p className="text-sm font-medium text-muted-foreground/60 mb-1">{title}</p>
            <p className="text-xs text-muted-foreground/40 max-w-xs mx-auto">{hint}</p>
        </div>
    );
}

/** A list row wrapper: name + optional badges line, optional description/meta lines, and a trailing scope badge. */
function ListRow({
    icon: Icon,
    iconColor,
    name,
    badges,
    description,
    meta,
    scope,
}: {
    icon: ComponentType<{ className?: string }>;
    iconColor: string;
    name: string;
    badges?: ReactNode;
    description?: string;
    meta?: string;
    scope?: string;
}) {
    return (
        <div className="px-4 py-3 hover:bg-muted/20 transition-colors">
            <div className="grid grid-cols-[1fr_auto] items-start gap-3">
                <div className="flex flex-col gap-0.5 min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                        <Icon className={`w-3.5 h-3.5 shrink-0 ${iconColor}`} />
                        <span className="text-sm font-medium truncate">{name}</span>
                        {badges}
                    </div>
                    {description && (
                        <p className="text-xs text-muted-foreground/60 pl-6 line-clamp-2">{description}</p>
                    )}
                    {meta && (
                        <p className="text-[10px] text-muted-foreground/40 pl-6 font-mono truncate">{meta}</p>
                    )}
                </div>
                {scope && (
                    <Badge className="text-[9px] h-5 px-1.5 bg-muted/30 text-muted-foreground border border-border/20 hover:bg-muted/30 shrink-0 mt-0.5">
                        {scope}
                    </Badge>
                )}
            </div>
        </div>
    );
}

function ListTable({ columnLabel, children }: { columnLabel: string; children: ReactNode }) {
    return (
        <div className="rounded-xl border border-border/50 bg-card/50 overflow-hidden">
            <div className="grid grid-cols-[1fr_auto] gap-3 px-4 py-2 text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium border-b border-border/30 bg-muted/10">
                <span>{columnLabel}</span>
                <span>作用域</span>
            </div>
            <div className="divide-y divide-border/20">{children}</div>
        </div>
    );
}

const builtinBadge = (
    <span className="text-[9px] font-medium text-muted-foreground/50 bg-muted/40 px-1 py-0.5 rounded shrink-0">
        内置
    </span>
);

// === Lists ===

// Workflows and skills share the WorkflowSpec shape; only icon/color/labels differ.
function SpecList({
    items,
    icon,
    iconColor,
    columnLabel,
    showTurbo,
    onCopy,
    copyingPath,
    copyErrors,
}: {
    items: WorkflowSpec[];
    icon: ComponentType<{ className?: string }>;
    iconColor: string;
    columnLabel: string;
    showTurbo: boolean;
    onCopy?: (w: WorkflowSpec) => void;
    copyingPath?: string | null;
    copyErrors?: Record<string, string>;
}) {
    const [expandedKey, setExpandedKey] = useState<string | null>(null);
    const [copiedSlash, setCopiedSlash] = useState<string | null>(null);

    const handleCopySlash = (e: React.MouseEvent, slash: string) => {
        e.stopPropagation();
        if (typeof navigator !== 'undefined' && navigator.clipboard) {
            navigator.clipboard.writeText(`${slash} `).catch(() => {});
            setCopiedSlash(slash);
            setTimeout(() => setCopiedSlash((prev) => (prev === slash ? null : prev)), 1500);
        }
    };

    return (
        <ListTable columnLabel={columnLabel}>
            {items.map((w, i) => {
                const key = w.path ?? w.name ?? String(i);
                const isCopying = copyingPath === key;
                const copyErr = copyErrors?.[key];
                const isExpanded = expandedKey === key;
                const rawName = workflowName(w);
                const slashCmd = rawName.startsWith('/') ? rawName : `/${rawName}`;
                const hasContent = typeof w.content === 'string' && w.content.trim().length > 0;
                return (
                    <div key={key}>
                        <div
                            onClick={() => hasContent && setExpandedKey(isExpanded ? null : key)}
                            className={`grid grid-cols-[1fr_auto] items-start gap-3 px-4 py-3 hover:bg-muted/20 transition-colors ${hasContent ? 'cursor-pointer' : ''}`}
                        >
                            <div className="flex flex-col gap-0.5 min-w-0">
                                <div className="flex items-center gap-2 min-w-0 flex-wrap">
                                    {hasContent ? (
                                        isExpanded ? <ChevronDown className="w-3.5 h-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                                    ) : (
                                        (() => { const Icon = icon; return <Icon className={`w-3.5 h-3.5 shrink-0 ${iconColor}`} />; })()
                                    )}
                                    <span className="text-sm font-medium truncate">{rawName}</span>
                                    <button
                                        type="button"
                                        onClick={(e) => handleCopySlash(e, slashCmd)}
                                        title="点击复制对话斜杠调用指令"
                                        className="inline-flex items-center gap-1 font-mono text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary hover:bg-primary/20 transition-colors shrink-0"
                                    >
                                        {copiedSlash === slashCmd ? <Check className="w-2.5 h-2.5" /> : null}
                                        {slashCmd}
                                    </button>
                                    {w.isBuiltin && builtinBadge}
                                    {showTurbo && w.turbo && (
                                        <span className="text-[9px] font-medium text-amber-400/70 bg-amber-500/10 px-1 py-0.5 rounded shrink-0">
                                            极速
                                        </span>
                                    )}
                                </div>
                                {w.description && (
                                    <p className="text-xs text-muted-foreground/60 pl-6 line-clamp-2">{w.description as string}</p>
                                )}
                                {w.pluginName && (
                                    <p className="text-[10px] text-muted-foreground/40 pl-6 font-mono truncate">插件: {w.pluginName as string}</p>
                                )}
                            </div>
                            <div className="flex items-center gap-2 shrink-0 mt-0.5" onClick={(e) => e.stopPropagation()}>
                                {onCopy && w.isBuiltin && (
                                    <button
                                        onClick={() => onCopy(w)}
                                        disabled={isCopying}
                                        title="复制到工作区以便编辑"
                                        className="flex items-center gap-1 text-[10px] px-2 py-1 rounded-md bg-muted/30 hover:bg-muted/60 text-muted-foreground hover:text-foreground transition-colors border border-border/20 disabled:opacity-40 disabled:cursor-not-allowed"
                                    >
                                        {isCopying
                                            ? <Loader2 className="w-3 h-3 animate-spin" />
                                            : <Copy className="w-3 h-3" />
                                        }
                                        复制
                                    </button>
                                )}
                                {w.scope && (
                                    <Badge className="text-[9px] h-5 px-1.5 bg-muted/30 text-muted-foreground border border-border/20 hover:bg-muted/30">
                                        {w.scope as string}
                                    </Badge>
                                )}
                            </div>
                        </div>
                        {isExpanded && hasContent && (
                            <div className="px-4 pb-3 pt-1 bg-muted/10 border-t border-border/20 space-y-1.5">
                                {w.path && (
                                    <p className="text-[10px] text-muted-foreground/50 font-mono break-all">
                                        映射路径: {w.path}
                                    </p>
                                )}
                                <pre className="text-xs font-mono text-foreground/80 whitespace-pre-wrap break-words max-h-72 overflow-y-auto rounded-lg bg-background/80 border border-border/40 p-3">
                                    {w.content}
                                </pre>
                            </div>
                        )}
                        {copyErr && (
                            <div className="px-4 pb-2 -mt-1">
                                <p className="text-[10px] text-red-400/80 font-mono bg-red-500/5 border border-red-500/10 rounded px-2 py-1 break-all">
                                    复制失败: {copyErr}
                                </p>
                            </div>
                        )}
                    </div>
                );
            })}
        </ListTable>
    );
}

function RuleList({ items }: { items: CortexMemory[] }) {
    return (
        <ListTable columnLabel="规则">
            {items.map((r, i) => (
                <ListRow
                    key={r.memoryId ?? r.absolutePath ?? String(i)}
                    icon={ScrollText}
                    iconColor="text-sky-400/60"
                    name={ruleName(r)}
                    badges={
                        r.source ? (
                            <span className="text-[9px] font-medium text-muted-foreground/50 bg-muted/40 px-1 py-0.5 rounded shrink-0">
                                {r.source}
                            </span>
                        ) : undefined
                    }
                    description={r.textMemory}
                    meta={r.absolutePath}
                    scope={r.scope}
                />
            ))}
        </ListTable>
    );
}

// === No-workspace state ===
function NoWorkspaceState() {
    return (
        <div className="flex-1 flex items-center justify-center">
            <div className="flex flex-col items-center gap-3 max-w-sm text-center">
                <FolderOpen className="w-8 h-8 text-muted-foreground/30" />
                <span className="text-sm font-medium text-foreground/70">尚未打开工作区</span>
                <span className="text-xs text-muted-foreground">
                    请在 Antigravity IDE 中打开工作区文件夹，以浏览工作流、技能与规则。
                </span>
            </div>
        </div>
    );
}

// === Per-tab data state ===
interface TabData<T> {
    data: T | null;
    isLoading: boolean;
    error: string | null;
}

function initialTabData<T>(): TabData<T> {
    return { data: null, isLoading: false, error: null };
}

/** Renders one tab's loading / error / content states from its TabData. */
function TabContent<T>({
    tab,
    loadingLabel,
    onRetry,
    children,
}: {
    tab: TabData<T>;
    loadingLabel: string;
    onRetry: () => void;
    children: (data: T) => ReactNode;
}) {
    if (tab.isLoading && tab.data === null) return <LoadingSpinner label={loadingLabel} />;
    if (tab.error !== null) return <ErrorState message={tab.error} onRetry={onRetry} />;
    return <>{tab.data !== null ? children(tab.data) : null}</>;
}

// === Main Component ===
export function WorkflowsView() {
    const [workspaceUris, setWorkspaceUris] = useState<string[] | null>(null);
    const [wsLoading, setWsLoading] = useState(true);
    const [wsError, setWsError] = useState<string | null>(null);

    const [activeTab, setActiveTab] = useState<TabId>('workflows');

    const [workflowsTab, setWorkflowsTab] = useState<TabData<WorkflowSpec[]>>(initialTabData);
    const [skillsTab, setSkillsTab] = useState<TabData<WorkflowSpec[]>>(initialTabData);
    const [rulesTab, setRulesTab] = useState<TabData<CortexMemory[]>>(initialTabData);

    const [copyingPath, setCopyingPath] = useState<string | null>(null);
    const [copyErrors, setCopyErrors] = useState<Record<string, string>>({});

    // Track the in-flight fetch's AbortController so we can cancel it on unmount / tab change.
    const fetchAbortRef = useRef<AbortController | null>(null);

    // Step 1: resolve workspace URIs on mount
    useEffect(() => {
        const ac = new AbortController();
        setWsLoading(true);
        setWsError(null);

        lsCall<GetWorkspaceInfosResponse>('GetWorkspaceInfos', {}, ac.signal)
            .then(res => {
                const uris = (res.workspaceInfos ?? [])
                    .map(info => info.workspaceUri)
                    .filter((u): u is string => typeof u === 'string' && u.length > 0);
                setWorkspaceUris(uris);
            })
            .catch((e: unknown) => {
                if (isAbortError(e)) return;
                setWsError(e instanceof Error ? e.message : '加载工作区信息失败');
                setWorkspaceUris([]);
            })
            .finally(() => {
                if (!ac.signal.aborted) setWsLoading(false);
            });

        return () => ac.abort();
    }, []);

    // Step 2: fetch tab data when workspaceUris are ready and tab changes.
    const fetchTab = useCallback((tab: TabId, uris: string[]) => {
        // Cancel any prior in-flight fetch (truly aborts the HTTP request via the signal).
        if (fetchAbortRef.current !== null) fetchAbortRef.current.abort();
        const ac = new AbortController();
        fetchAbortRef.current = ac;

        const body = { workspaceUris: uris };

        if (tab === 'workflows') {
            setWorkflowsTab(prev => ({ ...prev, isLoading: true, error: null }));
            lsCall<GetAllWorkflowsResponse>('GetAllWorkflows', body, ac.signal)
                .then(res => setWorkflowsTab({ data: res.workflows ?? [], isLoading: false, error: null }))
                .catch((e: unknown) => {
                    if (isAbortError(e)) return;
                    setWorkflowsTab({ data: null, isLoading: false, error: e instanceof Error ? e.message : '加载工作流失败' });
                });
        } else if (tab === 'skills') {
            setSkillsTab(prev => ({ ...prev, isLoading: true, error: null }));
            lsCall<GetAllSkillsResponse>('GetAllSkills', body, ac.signal)
                .then(res => setSkillsTab({ data: res.skills ?? [], isLoading: false, error: null }))
                .catch((e: unknown) => {
                    if (isAbortError(e)) return;
                    setSkillsTab({ data: null, isLoading: false, error: e instanceof Error ? e.message : '加载技能失败' });
                });
        } else {
            setRulesTab(prev => ({ ...prev, isLoading: true, error: null }));
            lsCall<GetAllRulesResponse>('GetAllRules', body, ac.signal)
                .then(res => setRulesTab({ data: res.memories ?? [], isLoading: false, error: null }))
                .catch((e: unknown) => {
                    if (isAbortError(e)) return;
                    setRulesTab({ data: null, isLoading: false, error: e instanceof Error ? e.message : '加载规则失败' });
                });
        }
    }, []);

    const handleCopyWorkflow = useCallback(async (w: WorkflowSpec) => {
        const key = w.path ?? w.name ?? '';
        if (!key) return;
        setCopyingPath(key);
        setCopyErrors(prev => { const n = { ...prev }; delete n[key]; return n; });
        try {
            await lsCall('CopyBuiltinWorkflowToWorkspace', { workflow: w, metadata: {} });
            // Re-fetch the workflows list so the copied item appears as a workspace workflow.
            // Use a dedicated AbortController (NOT the shared fetchAbortRef) so a concurrent
            // tab-switch can't cancel this refresh, and vice-versa.
            if (workspaceUris !== null) {
                const ac = new AbortController();
                setWorkflowsTab(prev => ({ ...prev, isLoading: true, error: null }));
                try {
                    const res = await lsCall<GetAllWorkflowsResponse>('GetAllWorkflows', { workspaceUris }, ac.signal);
                    setWorkflowsTab({ data: res.workflows ?? [], isLoading: false, error: null });
                } catch (re: unknown) {
                    if (!isAbortError(re)) {
                        setWorkflowsTab({ data: null, isLoading: false, error: re instanceof Error ? re.message : '加载工作流失败' });
                    }
                }
            }
        } catch (e: unknown) {
            setCopyErrors(prev => ({ ...prev, [key]: e instanceof Error ? e.message : '复制失败' }));
        } finally {
            setCopyingPath(null);
        }
    }, [workspaceUris]);

    useEffect(() => {
        if (workspaceUris === null) return; // still loading workspace info
        fetchTab(activeTab, workspaceUris);
        return () => {
            if (fetchAbortRef.current !== null) fetchAbortRef.current.abort();
        };
    }, [activeTab, workspaceUris, fetchTab]);

    // === Loading workspace info ===
    if (wsLoading) {
        return (
            <div className="flex-1 flex items-center justify-center">
                <div className="flex flex-col items-center gap-3">
                    <Activity className="w-8 h-8 text-muted-foreground/50 animate-pulse" />
                    <span className="text-sm text-muted-foreground">正在检测工作区...</span>
                </div>
            </div>
        );
    }

    if (wsError !== null) {
        return (
            <div className="flex-1 flex items-center justify-center">
                <div className="flex flex-col items-center gap-3 max-w-sm text-center">
                    <AlertTriangle className="w-8 h-8 text-red-400/60" />
                    <span className="text-sm font-medium text-foreground/70">检测工作区失败</span>
                    <span className="text-xs text-muted-foreground font-mono break-all">{wsError}</span>
                </div>
            </div>
        );
    }

    // No workspace URIs at all → show friendly state
    if (workspaceUris !== null && workspaceUris.length === 0) {
        return <NoWorkspaceState />;
    }

    const currentTab = activeTab === 'workflows' ? workflowsTab : activeTab === 'skills' ? skillsTab : rulesTab;
    const uris = workspaceUris ?? [];

    return (
        <div className="flex-1 overflow-y-auto">
            <div className="max-w-3xl mx-auto p-6 space-y-6">
                {/* Header */}
                <div className="flex items-center gap-3">
                    <div className="p-2 rounded-lg bg-gradient-to-br from-violet-500/10 to-indigo-500/10 border border-violet-500/20">
                        <Workflow className="w-5 h-5 text-violet-400" />
                    </div>
                    <div>
                        <h2 className="text-lg font-semibold">工作流 / 技能 / 规则</h2>
                        <p className="text-xs text-muted-foreground">
                            查看当前活动工作区中的扩展配置项（只读视图）
                        </p>
                    </div>
                    {currentTab.isLoading && (
                        <Loader2 className="w-4 h-4 text-muted-foreground/50 animate-spin ml-auto" />
                    )}
                </div>

                {/* Tabs */}
                <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as TabId)}>
                    <TabsList className="w-full justify-start">
                        <TabsTrigger value="workflows" className="flex items-center gap-1.5">
                            <Workflow className="w-3.5 h-3.5" />
                            工作流
                        </TabsTrigger>
                        <TabsTrigger value="skills" className="flex items-center gap-1.5">
                            <BookOpen className="w-3.5 h-3.5" />
                            技能
                        </TabsTrigger>
                        <TabsTrigger value="rules" className="flex items-center gap-1.5">
                            <ScrollText className="w-3.5 h-3.5" />
                            规则
                        </TabsTrigger>
                    </TabsList>

                    <TabsContent value="workflows">
                        <TabContent tab={workflowsTab} loadingLabel="正在加载工作流..." onRetry={() => fetchTab('workflows', uris)}>
                            {(items) => items.length === 0
                                ? <EmptyState icon={Workflow} title="未找到工作流" hint="请在工作区中添加工作流文件后查看。" />
                                : <SpecList items={items} icon={Workflow} iconColor="text-violet-400/60" columnLabel="工作流" showTurbo onCopy={handleCopyWorkflow} copyingPath={copyingPath} copyErrors={copyErrors} />}
                        </TabContent>
                    </TabsContent>
                    <TabsContent value="skills">
                        <TabContent tab={skillsTab} loadingLabel="正在加载技能..." onRetry={() => fetchTab('skills', uris)}>
                            {(items) => items.length === 0
                                ? <EmptyState icon={BookOpen} title="未找到技能" hint="从 Antigravity 插件市场安装技能后将显示在此处。" />
                                : <SpecList items={items} icon={BookOpen} iconColor="text-emerald-400/60" columnLabel="技能" showTurbo={false} />}
                        </TabContent>
                    </TabsContent>
                    <TabsContent value="rules">
                        <TabContent tab={rulesTab} loadingLabel="正在加载规则..." onRetry={() => fetchTab('rules', uris)}>
                            {(items) => items.length === 0
                                ? <EmptyState icon={ScrollText} title="未找到规则" hint="在工作区添加规则文件，即可为助手注入持久化指令。" />
                                : <RuleList items={items} />}
                        </TabContent>
                    </TabsContent>
                </Tabs>

                {/* Footer */}
                <p className="text-center text-[10px] text-muted-foreground/40 pb-4">
                    可将内置工作流复制到当前工作区进行自定义编辑；技能与规则请通过 Antigravity IDE 设置进行管理。
                </p>
            </div>
        </div>
    );
}
