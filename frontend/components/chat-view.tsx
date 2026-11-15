'use client';

import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { Step } from '@/lib/types';
import { extractStepContent, getStepConfig } from '@/lib/step-utils';
import { cascadeSend, cascadeSubmit, cascadeCancel, cascadeInteract, getWorkspaces, getModels, getAutoAcceptState, setAutoAcceptState, saveMedia, clearConversationCache, fetchWorkflows, updatePermissionsConfig, getPermissionsConfig, uploadWorkspaceFile, rotateOAuthAccount, streamAgyChat } from '@/lib/cascade-api';
import type { Workspace, CascadeModel, CascadeModelGroup, ActiveModelAccount, MediaItem, WorkflowItem, UploadedFileResult } from '@/lib/cascade-api';
import { API_BASE } from '@/lib/config';
import { authFetch } from '@/lib/auth';
import { useAuthUser } from '@/components/auth-gate';
import { MarkdownRenderer } from './markdown-renderer';
import { ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { TokenUsage } from './token-usage';
import { cn } from '@/lib/utils';
import dynamic from 'next/dynamic';
const SourceControlView = dynamic(() => import('./source-control-view').then(m => ({ default: m.SourceControlView })), { ssr: false });
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Settings, Folder, Zap, BarChart2, RefreshCcw, SendHorizontal, Square, Paperclip, GitBranch, Plus, X, ChevronDown, Activity, Download, Bell, BellOff, Rocket, ArrowDown as ArrowDownIcon, Camera, Brain, Image as ImageIcon, Star, Shield, ShieldAlert, FileText, Loader2, RotateCw, Terminal } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { notificationService, NOTIFICATION_SETTINGS_CHANGED } from '@/lib/notifications';

// === Props ===
interface ChatViewProps {
    steps: Step[];
    baseIndex?: number;
    stepCount?: number;
    loadingOlder?: boolean;
    onLoadOlder?: () => void;
    currentConvId: string | null;
    currentWorkspace: string | null;
    /** Folder URI to bind a project-scoped new conversation to (null = global/loose). */
    newChatWorkspaceUri?: string | null;
    wsVersion: number;
    cascadeStatus?: string;
    onCascadeCreated: (cascadeId: string) => void;
    onHydrateConversation?: (cascadeId: string, steps: Step[], stepCount?: number) => void;
    onConversationsUpdated?: () => void;
    onNewConversation: () => void;
    showTimeline: boolean;
    onSetShowTimeline: (val: boolean) => void;
    showAnalytics: boolean;
    onToggleAnalytics: () => void;
    onExport: () => void;
    onShowSettings?: () => void;
    detected?: boolean;
    prefillPrompt?: { text: string; seq: number } | null;
    activeAccountLabel?: string | null;
    onOpenAccounts?: () => void;
    stepsLoading?: boolean;
    convNotFound?: boolean;
}

// === Classification ===
// === Extracted sub-components ===
import { groupSteps } from './chat/chat-helpers';
import { UserMessage } from './chat/user-message';
import { AgentResponse } from './chat/agent-response';
import { ProcessingGroup } from './chat/processing-group';
import { GeneratedImageStep } from './chat/generated-image-step';
import { StreamingIndicator } from './chat/streaming-indicator';
import { DoubaoWelcome } from './chat/doubao-welcome';
import { TieredModelPicker, EffortPicker } from './chat/tiered-model-picker';
import { AccountSwitcherPill } from './chat/account-switcher-pill';
import {
    type EffortLevel,
    groupModelsByFamily,
    findFamilyByModelId,
    pickVariantForEffort,
    normalizeEffortKey,
} from '@/lib/model-tiers';
import { WorkflowAutocomplete } from './workflow-autocomplete';
import type { WorkflowAutocompleteHandle } from './workflow-autocomplete';

// Helper: generate a small thumbnail (base64) from a full-size base64 image
function generateThumbnail(base64: string, mimeType: string, maxSize = 128): Promise<string> {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const scale = Math.min(maxSize / img.width, maxSize / img.height, 1);
            canvas.width = Math.round(img.width * scale);
            canvas.height = Math.round(img.height * scale);
            const ctx = canvas.getContext('2d')!;
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            // Return just the base64 part (no data: prefix)
            const dataUrl = canvas.toDataURL(mimeType || 'image/png', 0.7);
            resolve(dataUrl.split(',')[1]);
        };
        img.onerror = () => resolve(''); // fallback: empty thumbnail
        img.src = `data:${mimeType};base64,${base64}`;
    });
}

// === Main Chat View ===
export function ChatView({
    steps,
    baseIndex = 0,
    stepCount = 0,
    loadingOlder = false,
    onLoadOlder,
    currentConvId,
    currentWorkspace,
    newChatWorkspaceUri,
    wsVersion,
    cascadeStatus,
    onCascadeCreated,
    onHydrateConversation,
    onConversationsUpdated,
    onNewConversation,
    showTimeline,
    onSetShowTimeline,
    showAnalytics,
    onToggleAnalytics,
    onExport,
    onShowSettings,
    detected = true,
    prefillPrompt,
    activeAccountLabel,
    onOpenAccounts,
    stepsLoading = false,
    convNotFound = false,
}: ChatViewProps) {
    const { user } = useAuthUser();
    const isAdmin = user?.role === 'admin';
    const [input, setInput] = useState('');
    const [sending, setSending] = useState(false);
    // activeCascadeId: derived from currentConvId, with local override for new chats
    const [localCascadeId, setLocalCascadeId] = useState<string | null>(null);
    const [showSourceControl, setShowSourceControl] = useState(false);
    const activeCascadeId = localCascadeId ?? currentConvId;
    const [showScrollBtn, setShowScrollBtn] = useState(false);
    const prevStepsLenRef = useRef(0);
    const prevBaseIndexRef = useRef(baseIndex);

    // Auto-accept + Smart Guard Policy ('smart' vs 'full')
    const [autoAccept, setAutoAccept] = useState<boolean>(true);
    const [autoAcceptPolicy, setAutoAcceptPolicy] = useState<'smart' | 'full'>('smart');

    // Workspace & model pickers
    const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
    const [selectedWs, setSelectedWs] = useState<number | null>(null);
    const [models, setModels] = useState<CascadeModel[]>([]);
    const [modelGroups, setModelGroups] = useState<CascadeModelGroup[]>([]);
    const [modelsLoading, setModelsLoading] = useState(false);
    const [activeAccount, setActiveAccount] = useState<ActiveModelAccount | null>(null);
    const [hubSyncing, setHubSyncing] = useState(false);
    const [selectedModel, setSelectedModel] = useState<string>('');
    const [selectedEffort, setSelectedEffort] = useState<EffortLevel>(() => {
        if (typeof window !== 'undefined') {
            const norm = normalizeEffortKey(localStorage.getItem('antigravity-effort'));
            if (norm !== 'standard') return norm;
        }
        return 'medium';
    });
    const selectedEffortRef = useRef<EffortLevel>(selectedEffort);
    selectedEffortRef.current = selectedEffort;
    const hubSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const handleSelectEffort = (effort: EffortLevel) => {
        setSelectedEffort(effort);
        if (typeof window !== 'undefined') {
            try { localStorage.setItem('antigravity-effort', effort); } catch { /* ignore */ }
        }
    };

    const applyModelsResponse = (
        m: {
            models?: CascadeModel[];
            groups?: CascadeModelGroup[];
            defaultModel?: string;
            hubSyncing?: boolean;
            activeAccount?: ActiveModelAccount;
        },
        preferredDefault?: string,
        canRetrySync = true,
    ) => {
        const list = m.models || [];
        setModels(list);
        setModelGroups(m.groups || []);
        if (m.activeAccount !== undefined) setActiveAccount(m.activeAccount || null);
        setHubSyncing(Boolean(m.hubSyncing));

        setSelectedModel((prev) => {
            if (list.length === 0) return '';
            const direct = prev ? list.find((item) => item.modelId === prev || item.cliModelId === prev) : undefined;
            if (direct) return direct.modelId;

            const candidateDefault =
                (preferredDefault && list.find((item) => item.modelId === preferredDefault || item.cliModelId === preferredDefault)?.modelId) ||
                (m.defaultModel && list.find((item) => item.modelId === m.defaultModel || item.cliModelId === m.defaultModel)?.modelId) ||
                list[0].modelId;

            const fam = findFamilyByModelId(groupModelsByFamily(list), candidateDefault);
            const variant = fam ? pickVariantForEffort(fam, selectedEffortRef.current) : null;
            return variant?.modelId || candidateDefault;
        });

        if (hubSyncTimerRef.current) {
            clearTimeout(hubSyncTimerRef.current);
            hubSyncTimerRef.current = null;
        }
        if (m.hubSyncing && canRetrySync) {
            hubSyncTimerRef.current = setTimeout(() => {
                hubSyncTimerRef.current = null;
                getModels(true)
                    .then((fresh) => applyModelsResponse(fresh, undefined, false))
                    .catch(() => { });
            }, 5500);
        }
    };
    const [, setShowWsPicker] = useState(false);
    const [, setShowModelPicker] = useState(false);
    const [showTokens, setShowTokens] = useState(() => {
        if (typeof window === 'undefined') return false;
        try { const v = localStorage.getItem('antigravity-show-tokens'); return v ? JSON.parse(v) : false; } catch { return false; }
    });
    // Multi-image + arbitrary uploaded files
    const [pendingImages, setPendingImages] = useState<{ id: string; name: string; mimeType: string; base64: string; dataUrl: string }[]>([]);
    const [pendingFiles, setPendingFiles] = useState<UploadedFileResult[]>([]);
    const [uploadingFile, setUploadingFile] = useState(false);
    const [uploadNotice, setUploadNotice] = useState<string | null>(null);
    const [pendingMessage, setPendingMessage] = useState<string | null>(null);
    const [isDragOver, setIsDragOver] = useState(false);
    // Quick agy CLI mode + real-time streaming turns + account rotate state
    const [useAgyCli, setUseAgyCli] = useState(false);
    const [liveTurns, setLiveTurns] = useState<Array<{
        id: string;
        prompt: string;
        phase: 'thinking' | 'tool' | 'answering' | 'done' | 'error';
        thinking: string;
        showThinking: boolean;
        tools: Array<{ name: string; status: string }>;
        reply: string;
        error?: string | null;
        startedAt: number;
        elapsedMs: number;
        pending: boolean;
    }>>([]);
    const streamAbortRef = useRef<AbortController | null>(null);
    const activeStreamConvIdRef = useRef<string | null>(null);
    const [rotatingAccount, setRotatingAccount] = useState(false);
    // Workflow autocomplete state
    const [workflows, setWorkflows] = useState<WorkflowItem[]>([]);
    const [showWorkflows, setShowWorkflows] = useState(false);
    const [workflowQuery, setWorkflowQuery] = useState('');

    // === Notification quick toggle ===
    const [notificationsEnabled, setNotificationsEnabled] = useState(() => notificationService?.getSettings().enabled ?? false);

    useEffect(() => {
        const handler = () => {
            setNotificationsEnabled(notificationService?.getSettings().enabled ?? false);
        };
        window.addEventListener(NOTIFICATION_SETTINGS_CHANGED, handler);
        return () => window.removeEventListener(NOTIFICATION_SETTINGS_CHANGED, handler);
    }, []);

    // === Notification banner state ===
    const [notiPermission, setNotiPermission] = useState<NotificationPermission>(() =>
        notificationService?.getPermission() ?? 'default'
    );
    const [notiBannerDismissed, setNotiBannerDismissed] = useState(() => {
        if (typeof window === 'undefined') return false;
        return localStorage.getItem('antigravity-noti-banner-dismissed') === '1';
    });
    const showNotiBanner = !notificationsEnabled && !notiBannerDismissed && notiPermission !== 'denied';

    // Sync permission state
    useEffect(() => {
        const handler = () => {
            setNotiPermission(notificationService?.getPermission() ?? 'default');
        };
        window.addEventListener(NOTIFICATION_SETTINGS_CHANGED, handler);
        return () => window.removeEventListener(NOTIFICATION_SETTINGS_CHANGED, handler);
    }, []);
    const wsPickerRef = useRef<HTMLDivElement>(null);
    const modelPickerRef = useRef<HTMLDivElement>(null);

    // Chat scroll — autoScroll as ref to avoid re-renders on scroll events
    const bottomRef = useRef<HTMLDivElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const autoScrollRef = useRef(true);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    // Snapshot of sent images for optimistic rendering (survives state clear)
    const pendingMediaRef = useRef<{ dataUrl: string; mimeType: string; name: string }[]>([]);

    // Detect REAL user scroll via wheel/touch events (these NEVER fire from programmatic scrollIntoView)
    // This is the key to distinguishing user intent from auto-scroll
    const userScrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const isUserScrollingRef = useRef(false);
    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const markUserScroll = () => {
            isUserScrollingRef.current = true;
            clearTimeout(userScrollTimeoutRef.current);
            userScrollTimeoutRef.current = setTimeout(() => {
                isUserScrollingRef.current = false;
            }, 150);
        };
        el.addEventListener('wheel', markUserScroll, { passive: true });
        el.addEventListener('touchstart', markUserScroll, { passive: true });
        return () => {
            el.removeEventListener('wheel', markUserScroll);
            el.removeEventListener('touchstart', markUserScroll);
            clearTimeout(userScrollTimeoutRef.current);
        };
    }, []);

    // Reset textarea height when input is cleared (e.g. after send)
    useEffect(() => {
        if (!input && inputRef.current) {
            inputRef.current.style.height = '';
        }
    }, [input]);

    // Auto-scroll: triggers on new steps (length change) AND streaming content updates (wsVersion)
    useEffect(() => {
        if (autoScrollRef.current && bottomRef.current) {
            bottomRef.current.scrollIntoView({ behavior: 'smooth' });
        } else if (steps.length > prevStepsLenRef.current) {
            // New steps arrived but user is scrolled up — show button
            setShowScrollBtn(true);
        }
        prevStepsLenRef.current = steps.length;
    }, [steps.length, wsVersion]);

    // Preserve scroll position when older steps are prepended (baseIndex decreased)
    useEffect(() => {
        const el = containerRef.current;
        if (el && baseIndex < prevBaseIndexRef.current && steps.length > prevStepsLenRef.current) {
            const addedCount = steps.length - prevStepsLenRef.current;
            requestAnimationFrame(() => {
                el.scrollTop += addedCount * 80;
            });
        }
        prevBaseIndexRef.current = baseIndex;
    }, [baseIndex, steps.length]);

    const handleScroll = useCallback(() => {
        if (!containerRef.current) return;
        const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
        // Only update autoScroll state from REAL user scrolls (wheel/touch)
        // Programmatic scrollIntoView fires scroll events but NOT wheel/touch events
        if (isUserScrollingRef.current) {
            const atBottom = scrollHeight - scrollTop <= clientHeight + 100;
            autoScrollRef.current = atBottom;
            if (atBottom) setShowScrollBtn(false);
        }
        // Always check: load older steps when near top
        if (scrollTop < 100 && baseIndex > 0 && !loadingOlder && onLoadOlder) {
            onLoadOlder();
        }
    }, [baseIndex, loadingOlder, onLoadOlder]);

    const scrollToBottom = useCallback(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
        autoScrollRef.current = true;
        setShowScrollBtn(false);
    }, []);

    // Load workspaces + models + settings in parallel
    useEffect(() => { localStorage.setItem('antigravity-show-tokens', JSON.stringify(showTokens)); }, [showTokens]);
    const modelInitRef = useRef(false);
    useEffect(() => {
        const fetchModels = modelInitRef.current ? Promise.resolve(null) : getModels();
        Promise.all([
            isAdmin ? getWorkspaces().catch(() => []) : Promise.resolve([]),
            fetchModels,
            isAdmin ? authFetch(`${API_BASE}/api/settings`).then(r => (r.ok ? r.json() : null)).catch(() => null) : Promise.resolve(null),
        ])
            .then(([ws, modelsResp, settingsResp]) => {
                setWorkspaces(ws);
                if (currentWorkspace !== null) {
                    const wsIdx = ws.findIndex(w => w.workspaceName === currentWorkspace);
                    setSelectedWs(wsIdx >= 0 ? wsIdx : 0);
                }
                else if (ws.length > 0) setSelectedWs(0);
                if (modelsResp && !modelInitRef.current) {
                    modelInitRef.current = true;
                    applyModelsResponse(modelsResp, settingsResp?.defaultModel, true);
                }
            })
            .catch(() => { });
        if (isAdmin) {
            getAutoAcceptState().then(s => setAutoAccept(s.enabled)).catch(() => { });
            getPermissionsConfig().then(p => {
                setAutoAccept(p.autoAccept);
                if (p.autoAcceptPolicy === 'full' || p.autoAcceptPolicy === 'smart') {
                    setAutoAcceptPolicy(p.autoAcceptPolicy);
                }
            }).catch(() => { });
        }
        // Load workflows
        fetchWorkflows(currentWorkspace || undefined).then(setWorkflows).catch(() => { });
    }, [wsVersion, currentWorkspace, isAdmin]);

    const refreshActiveModels = useCallback(async () => {
        setModelsLoading(true);
        try {
            const m = await getModels(true);
            applyModelsResponse(m, undefined, true);
        } catch {
            /* keep previous models on transient error */
        } finally {
            setModelsLoading(false);
        }
    }, []);

    // Refresh models & tier info automatically when OAuth account swaps or LS reconnects
    useEffect(() => {
        const reloadModels = (ev: Event) => {
            if ((ev as CustomEvent)?.detail?.source === 'picker') return;
            refreshActiveModels();
        };
        window.addEventListener('oauth-account-swapped', reloadModels);
        window.addEventListener('ls-detected', reloadModels);
        return () => {
            window.removeEventListener('oauth-account-swapped', reloadModels);
            window.removeEventListener('ls-detected', reloadModels);
            if (hubSyncTimerRef.current) {
                clearTimeout(hubSyncTimerRef.current);
                hubSyncTimerRef.current = null;
            }
        };
    }, [refreshActiveModels]);

    // Apply prefilled prompt from quick actions
    useEffect(() => {
        if (prefillPrompt?.text) {
            setInput(prefillPrompt.text);
            setTimeout(() => inputRef.current?.focus(), 60);
        }
    }, [prefillPrompt]);

    // Reset localCascadeId when switching to another conversation (preserve active SSE stream turn)
    useEffect(() => {
        setLocalCascadeId(null);
        if (currentConvId !== activeStreamConvIdRef.current) {
            setLiveTurns((prev) => prev.filter((t) => t.pending));
        }
    }, [currentConvId]);

    // Scroll to bottom when entering/switching conversations
    useEffect(() => {
        autoScrollRef.current = true;
        // Use a short delay to let the DOM render the new steps first
        const timer = setTimeout(() => {
            bottomRef.current?.scrollIntoView({ behavior: 'instant' });
            // Only auto-focus on desktop — on Android, programmatic focus triggers the soft keyboard
            window.matchMedia('(pointer: fine)').matches && inputRef.current?.focus();
        }, 50);
        return () => clearTimeout(timer);
    }, [currentConvId]);

    // Close pickers on outside click
    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (wsPickerRef.current && !wsPickerRef.current.contains(e.target as Node)) setShowWsPicker(false);
            if (modelPickerRef.current && !modelPickerRef.current.contains(e.target as Node)) setShowModelPicker(false);
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, []);

    // Upload arbitrary log/script/config file to workspace
    const uploadOtherFile = useCallback(async (file: File) => {
        if (file.size > 15 * 1024 * 1024) {
            setUploadNotice(`文件「${file.name}」超过 15MB 限制`);
            return;
        }
        setUploadingFile(true);
        setUploadNotice(null);
        try {
            const dataUrl = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result || ''));
                reader.onerror = () => reject(new Error('读取文件失败'));
                reader.readAsDataURL(file);
            });
            const uploaded = await uploadWorkspaceFile({
                name: file.name,
                contentBase64: dataUrl,
                workspace: currentWorkspace || undefined,
                mimeType: file.type || 'application/octet-stream',
            });
            setPendingFiles((prev) => [...prev, uploaded]);
        } catch (err) {
            setUploadNotice(err instanceof Error ? err.message : '上传文件失败');
        } finally {
            setUploadingFile(false);
        }
    }, [currentWorkspace]);

    // Send message
    const handleSend = useCallback(async () => {
        const rawText = input.trim();
        if ((!rawText && pendingImages.length === 0 && pendingFiles.length === 0) || sending) return;

        let text = rawText;
        if (pendingFiles.length > 0) {
            const refs = pendingFiles.map((f) => `- ${f.originalName} -> ${f.path}`).join('\n');
            text = `${text ? `${text}\n\n` : ''}[已上传文件到工作区]\n${refs}`;
        }

        // Real-time SSE streaming via agy CLI (default mode when Hub IDE is disabled/offline, or toggled)
        if (useAgyCli || !detected) {
            const turnId = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
            const startedAt = Date.now();
            const controller = new AbortController();
            streamAbortRef.current = controller;
            activeStreamConvIdRef.current = activeCascadeId || null;

            setSending(true);
            setInput('');
            setPendingFiles([]);
            setPendingImages([]);
            setLiveTurns((prev) => [
                ...prev,
                {
                    id: turnId,
                    prompt: text,
                    phase: 'thinking',
                    thinking: '',
                    showThinking: true,
                    tools: [],
                    reply: '',
                    error: null,
                    startedAt,
                    elapsedMs: 0,
                    pending: true,
                },
            ]);

            const elapsedTimer = setInterval(() => {
                setLiveTurns((prev) =>
                    prev.map((t) => (t.id === turnId && t.pending ? { ...t, elapsedMs: Date.now() - t.startedAt } : t)),
                );
            }, 250);

            let syncedFromDb = false;
            try {
                const normEffort = normalizeEffortKey(selectedEffort);
                const apiEffort = (normEffort === 'low' || normEffort === 'medium' || normEffort === 'high' || normEffort === 'xhigh' || normEffort === 'max') ? normEffort : undefined;
                const selectedLabel = models.find((m) => m.modelId === selectedModel)?.label;

                await streamAgyChat(
                    {
                        prompt: text,
                        model: selectedModel || undefined,
                        modelLabel: selectedLabel,
                        effort: apiEffort,
                        conversationId: activeCascadeId || undefined,
                        workspace: currentWorkspace || undefined,
                    },
                    {
                        onInit: (ev) => {
                            if (ev.sessionId) {
                                activeStreamConvIdRef.current = ev.sessionId;
                                setLocalCascadeId(ev.sessionId);
                                if (!activeCascadeId) onCascadeCreated(ev.sessionId);
                            }
                        },
                        onStatus: (ev) => {
                            const nextPhase = ev.phase === 'tool' || ev.phase === 'answering' ? ev.phase : 'thinking';
                            setLiveTurns((prev) =>
                                prev.map((t) => (t.id === turnId ? { ...t, phase: nextPhase, elapsedMs: ev.elapsedMs ?? (Date.now() - t.startedAt) } : t)),
                            );
                        },
                        onThinking: (ev) => {
                            setLiveTurns((prev) =>
                                prev.map((t) => (t.id === turnId ? { ...t, thinking: ev.text, elapsedMs: ev.elapsedMs ?? (Date.now() - t.startedAt) } : t)),
                            );
                        },
                        onTool: (ev) => {
                            setLiveTurns((prev) =>
                                prev.map((t) => {
                                    if (t.id !== turnId) return t;
                                    const nextTools = [...t.tools];
                                    const existingIdx = nextTools.findIndex((item) => item.name === ev.name && item.status !== 'DONE');
                                    if (existingIdx >= 0) nextTools[existingIdx] = { name: ev.name, status: ev.status };
                                    else nextTools.push({ name: ev.name, status: ev.status });
                                    return { ...t, phase: 'tool', tools: nextTools };
                                }),
                            );
                        },
                        onTextDelta: (ev) => {
                            setLiveTurns((prev) =>
                                prev.map((t) => (t.id === turnId ? { ...t, phase: 'answering', showThinking: false, reply: ev.fullText ?? (t.reply + ev.text) } : t)),
                            );
                        },
                        onStepsSync: (ev) => {
                            if (ev.sessionId && Array.isArray(ev.steps) && ev.steps.length > 0 && onHydrateConversation) {
                                syncedFromDb = true;
                                onHydrateConversation(ev.sessionId, ev.steps, ev.stepCount);
                                setLiveTurns((prev) => prev.filter((t) => t.id !== turnId));
                            }
                        },
                        onDone: (ev) => {
                            if (!syncedFromDb) {
                                setLiveTurns((prev) =>
                                    prev.map((t) =>
                                        t.id === turnId
                                            ? {
                                                ...t,
                                                phase: 'done',
                                                pending: false,
                                                reply: ev.text || t.reply,
                                                elapsedMs: Date.now() - t.startedAt,
                                            }
                                            : t,
                                    ),
                                );
                            }
                        },
                    },
                    controller.signal,
                );
                onConversationsUpdated?.();
            } catch (e) {
                const isAbort = e instanceof Error && e.name === 'AbortError';
                const msg = isAbort ? '已停止生成' : (e instanceof Error ? e.message : '执行失败');
                setLiveTurns((prev) =>
                    prev.map((t) =>
                        t.id === turnId
                            ? { ...t, pending: false, phase: 'error', error: isAbort && t.reply ? null : msg, elapsedMs: Date.now() - t.startedAt }
                            : t,
                    ),
                );
            } finally {
                clearInterval(elapsedTimer);
                streamAbortRef.current = null;
                setSending(false);
            }
            return;
        }

        setSending(true);
        // Optimistic update: show user message immediately
        setPendingMessage(text || '(images)');
        // Snapshot images for optimistic rendering before clearing state
        pendingMediaRef.current = pendingImages.map(img => ({ dataUrl: img.dataUrl, mimeType: img.mimeType, name: img.name }));
        try {
            // Build media array from pending images
            let mediaItems: MediaItem[] | undefined;
            if (pendingImages.length > 0) {
                mediaItems = await Promise.all(pendingImages.map(async (img) => {
                    const thumbnail = await generateThumbnail(img.base64, img.mimeType);
                    let uri: string | undefined;
                    try {
                        const saved = await saveMedia(img.mimeType, img.base64, thumbnail);
                        uri = saved.uri;
                    } catch { /* uri is optional */ }
                    return {
                        mimeType: img.mimeType,
                        inlineData: img.base64,
                        uri: uri || '',
                        thumbnail: thumbnail,
                    };
                }));
            }

            if (activeCascadeId) {
                const normEffort = normalizeEffortKey(selectedEffort);
                const apiEffort = (normEffort === 'low' || normEffort === 'medium' || normEffort === 'high' || normEffort === 'xhigh' || normEffort === 'max') ? normEffort : undefined;
                const selectedLabel = models.find((m) => m.modelId === selectedModel)?.label;
                await cascadeSend(activeCascadeId, text, selectedModel || undefined, mediaItems, {
                    effort: apiEffort,
                    modelLabel: selectedLabel,
                    workspace: currentWorkspace || undefined,
                });
            } else {
                const result = await cascadeSubmit(text, selectedModel || undefined, mediaItems, currentWorkspace || undefined, newChatWorkspaceUri || undefined);
                const newId = result.cascadeId;
                setLocalCascadeId(newId);
                onCascadeCreated(newId);
            }
            setInput('');
            setPendingImages([]);
            setPendingFiles([]);
        } catch (e) {
            console.error('Send error:', e);
        } finally {
            setSending(false);
        }
    }, [input, sending, activeCascadeId, selectedModel, selectedEffort, models, pendingImages, pendingFiles, useAgyCli, detected, currentWorkspace, newChatWorkspaceUri, onCascadeCreated, onHydrateConversation, onConversationsUpdated]);

    // Image handling — shared processor for adding files to pending images
    const processImageFile = useCallback((file: File) => {
        if (!file.type.startsWith('image/')) return;
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const reader = new FileReader();
        reader.onload = () => {
            const dataUrl = reader.result as string;
            const base64 = dataUrl.split(',')[1];
            setPendingImages(prev => [...prev, {
                id,
                name: file.name || 'clipboard-image.png',
                mimeType: file.type || 'image/png',
                base64,
                dataUrl,
            }]);
        };
        reader.readAsDataURL(file);
    }, []);

    const handleImagePick = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files;
        if (!files) return;
        Array.from(files).forEach(f => {
            if (f.type.startsWith('image/')) processImageFile(f);
            else uploadOtherFile(f);
        });
        // Reset input so same file can be re-selected
        if (fileInputRef.current) fileInputRef.current.value = '';
    }, [processImageFile, uploadOtherFile]);

    // Clipboard paste — capture ALL images from Ctrl+V
    const handlePaste = useCallback((e: React.ClipboardEvent) => {
        const items = e.clipboardData?.items;
        if (!items) return;
        let hasImage = false;
        for (const item of items) {
            if (item.type.startsWith('image/')) {
                const file = item.getAsFile();
                if (file) { processImageFile(file); hasImage = true; }
            }
        }
        if (hasImage) e.preventDefault();
    }, [processImageFile]);

    // Drag-and-drop handlers
    const handleDragOver = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer.types.includes('Files')) {
            setIsDragOver(true);
        }
    }, []);

    const handleDragLeave = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragOver(false);
    }, []);

    const handleDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragOver(false);
        const files = e.dataTransfer.files;
        if (!files) return;
        Array.from(files).forEach(f => {
            if (f.type.startsWith('image/')) processImageFile(f);
            else uploadOtherFile(f);
        });
    }, [processImageFile, uploadOtherFile]);

    const removeImage = useCallback((id: string) => {
        setPendingImages(prev => prev.filter(img => img.id !== id));
    }, []);

    const clearAllImages = useCallback(() => {
        setPendingImages([]);
        if (fileInputRef.current) fileInputRef.current.value = '';
    }, []);

    // Cancel active SSE stream or LS cascade
    const handleCancel = useCallback(async () => {
        if (streamAbortRef.current) {
            streamAbortRef.current.abort();
            streamAbortRef.current = null;
        }
        if (activeCascadeId && detected) {
            try { await cascadeCancel(activeCascadeId); } catch (e) { console.error('Cancel error:', e); }
        }
    }, [activeCascadeId, detected]);

    // Accept/Reject interaction
    const handleInteract = useCallback(async (action: 'accept' | 'reject') => {
        if (!activeCascadeId) return;
        try { await cascadeInteract(activeCascadeId, action); }
        catch (e) { console.error('Interact error:', e); }
    }, [activeCascadeId]);

    // New chat
    const handleNewChat = useCallback(() => {
        if (streamAbortRef.current) {
            streamAbortRef.current.abort();
            streamAbortRef.current = null;
        }
        activeStreamConvIdRef.current = null;
        setLocalCascadeId(null);
        setInput('');
        setLiveTurns([]);
        onNewConversation();
    }, [onNewConversation]);

    // Workflow autocomplete: detect "/" at start of input
    const handleInputChange = useCallback((val: string) => {
        setInput(val);
        if (val.startsWith('/')) {
            setShowWorkflows(true);
            setWorkflowQuery(val.slice(1)); // text after "/"
        } else {
            setShowWorkflows(false);
        }
    }, []);

    // Workflow selection: insert slash command into input (user sends manually)
    const handleWorkflowSelect = useCallback((workflow: WorkflowItem) => {
        setShowWorkflows(false);
        setInput(workflow.slash + ' ');
        inputRef.current?.focus();
    }, []);

    // Key handling — workflow autocomplete intercepts arrow/enter/escape first
    const autocompleteRef = useRef<WorkflowAutocompleteHandle | null>(null);
    const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (showWorkflows && autocompleteRef.current?.handleKeyDown(e)) return;
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
    }, [handleSend, showWorkflows]);

    // Merge optimistic pending message into displayed steps
    const displaySteps = useMemo(() => {
        if (!pendingMessage) return steps;
        // Check if pending message is already in real steps using extractStepContent (handles all formats)
        const lastUserStep = [...steps].reverse().find(s => s.type === 'CORTEX_STEP_TYPE_USER_INPUT');
        if (lastUserStep) {
            const lastText = extractStepContent(lastUserStep) || '';
            if (lastText === pendingMessage) return steps;
        }
        // Append optimistic user step with image data
        const optimisticStep: Step & { _media?: typeof pendingMediaRef.current } = {
            type: 'CORTEX_STEP_TYPE_USER_INPUT',
            status: 'CORTEX_STEP_STATUS_DONE',
            userInput: { items: [{ text: pendingMessage }] },
        };
        // Attach image snapshots for UserMessage rendering
        if (pendingMediaRef.current.length > 0) {
            optimisticStep._media = pendingMediaRef.current;
        }
        return [...steps, optimisticStep];
    }, [steps, pendingMessage]);

    // Clear pending message when real steps pick it up (avoids setTimeout inside useMemo)
    useEffect(() => {
        if (!pendingMessage) return;
        const lastUserStep = [...steps].reverse().find(s => s.type === 'CORTEX_STEP_TYPE_USER_INPUT');
        if (lastUserStep) {
            const lastText = extractStepContent(lastUserStep) || '';
            if (lastText === pendingMessage) {
                setPendingMessage(null);
                pendingMediaRef.current = [];
            }
        }
    }, [steps, pendingMessage]);

    const groups = useMemo(() => groupSteps(displaySteps), [displaySteps]);

    // Highest step index with a terminal status — a WAITING gate is live unless a
    // LATER step already completed past it (queued PENDING steps must not hide it).
    const lastTerminalIndex = useMemo(() => {
        const TERMINAL = new Set<string | number>([
            'CORTEX_STEP_STATUS_DONE', 'CORTEX_STEP_STATUS_ERROR',
            'CORTEX_STEP_STATUS_CANCELED', 'CORTEX_STEP_STATUS_CANCELLED',
            'CORTEX_STEP_STATUS_BLOCKED', 3, 4, 5, 7,
        ]);
        let last = -1;
        displaySteps.forEach((s, i) => { if (TERMINAL.has(s.status as string | number)) last = i; });
        return last;
    }, [displaySteps]);

    const isStreamingCli = liveTurns.some((t) => t.pending);
    const isRunning = cascadeStatus === 'CASCADE_RUN_STATUS_RUNNING' || isStreamingCli;
    const isWaiting = cascadeStatus === 'CASCADE_RUN_STATUS_WAITING_FOR_USER';
    const isActive = isRunning || isWaiting;

    const selectedWsName = selectedWs !== null && workspaces[selectedWs] ? workspaces[selectedWs].workspaceName : '未选择工作区';
    const currentModelObj = models.find(m => m.modelId === selectedModel);
    const hasLowQuota = Boolean(currentModelObj && typeof currentModelObj.quota === 'number' && currentModelObj.quota <= 0.15);
    const hasRateLimitError = useMemo(() => {
        const last = displaySteps[displaySteps.length - 1];
        if (!last) return false;
        const txt = JSON.stringify(last.errorMessage || '').toLowerCase();
        return txt.includes('429') || txt.includes('quota') || txt.includes('exhausted') || txt.includes('rate');
    }, [displaySteps]);

    const handleCycleGuardMode = useCallback(async () => {
        if (!autoAccept) {
            setAutoAccept(true);
            setAutoAcceptPolicy('smart');
            await updatePermissionsConfig({ autoAccept: true, autoAcceptPolicy: 'smart' }).catch(() => {
                setAutoAcceptState(true).catch(() => { });
            });
        } else if (autoAcceptPolicy === 'smart') {
            setAutoAcceptPolicy('full');
            await updatePermissionsConfig({ autoAccept: true, autoAcceptPolicy: 'full' }).catch(() => { });
        } else {
            setAutoAccept(false);
            setAutoAcceptPolicy('smart');
            await updatePermissionsConfig({ autoAccept: false, autoAcceptPolicy: 'smart' }).catch(() => {
                setAutoAcceptState(false).catch(() => { });
            });
        }
    }, [autoAccept, autoAcceptPolicy]);

    const handleQuickRotateAccount = useCallback(async () => {
        if (rotatingAccount) return;
        setRotatingAccount(true);
        try {
            const res = await rotateOAuthAccount(true);
            window.dispatchEvent(new CustomEvent('oauth-account-swapped', { detail: res }));
        } catch {
            onOpenAccounts?.();
        } finally {
            setRotatingAccount(false);
        }
    }, [rotatingAccount, onOpenAccounts]);

    return (
        <div className="flex-1 flex flex-col min-h-0">
            {showSourceControl && currentWorkspace !== null ? (
                <div className="flex-1 min-h-0 overflow-hidden">
                    <SourceControlView
                        workspace={currentWorkspace}
                        onClose={() => setShowSourceControl(false)}
                    />
                </div>
            ) : (
                <>
                    {/* Notification setup banner */}
                    {showNotiBanner && (
                        <div className="mx-3 sm:mx-6 mt-2 mb-0 rounded-lg border border-sky-500/20 bg-sky-500/5 px-3 py-2.5 flex items-center gap-3">
                            <Bell className="h-4 w-4 text-sky-400 flex-shrink-0" />
                            <p className="text-xs text-muted-foreground flex-1">
                                开启推送通知，在任务执行完成或等待确认时及时收到提醒。
                            </p>
                            <button
                                className="text-xs font-medium text-sky-400 hover:text-sky-300 transition-colors whitespace-nowrap"
                                onClick={async () => {
                                    const perm = await notificationService?.requestPermission();
                                    if (perm === 'granted') {
                                        notificationService?.setEnabled(true);
                                        setNotiBannerDismissed(true);
                                        localStorage.setItem('antigravity-noti-banner-dismissed', '1');
                                    }
                                }}
                            >
                                立即开启
                            </button>
                            {onShowSettings && (
                                <button
                                    className="text-xs text-muted-foreground/60 hover:text-muted-foreground transition-colors whitespace-nowrap"
                                    onClick={onShowSettings}
                                >
                                    设置
                                </button>
                            )}
                            <button
                                className="text-muted-foreground/40 hover:text-muted-foreground transition-colors"
                                onClick={() => {
                                    setNotiBannerDismissed(true);
                                    localStorage.setItem('antigravity-noti-banner-dismissed', '1');
                                }}
                            >
                                <X className="h-3.5 w-3.5" />
                            </button>
                        </div>
                    )}
                    {/* Chat messages */}
                    <div ref={containerRef} onScroll={handleScroll} className="relative flex-1 overflow-y-auto px-3 sm:px-6 py-3 sm:py-5">
                        {displaySteps.length === 0 && liveTurns.length === 0 ? (
                            currentConvId ? (
                                <div className="flex items-center justify-center h-full">
                                    {stepsLoading ? (
                                        <div className="text-center space-y-2 text-muted-foreground">
                                            <Loader2 className="h-6 w-6 animate-spin mx-auto text-primary/70" />
                                            <p className="text-sm">正在加载对话记录...</p>
                                        </div>
                                    ) : (
                                        <div className="text-center space-y-1.5 text-muted-foreground">
                                            <p className="text-sm font-medium text-foreground/80">
                                                {convNotFound ? '未找到本地对话步骤记录' : '该对话暂无本地步骤记录'}
                                            </p>
                                            <p className="text-xs text-muted-foreground/80">
                                                发送一条消息可继续对话
                                            </p>
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <DoubaoWelcome
                                    activeAccountLabel={isAdmin ? activeAccountLabel : null}
                                    onPickPrompt={(prompt) => {
                                        setInput(prompt);
                                        setTimeout(() => inputRef.current?.focus(), 40);
                                    }}
                                />
                            )
                        ) : (
                            <div className="max-w-3xl mx-auto">
                                {/* Load older steps trigger */}
                                {baseIndex > 0 && (
                                    <div className="flex justify-center py-3 mb-2">
                                        {loadingOlder ? (
                                            <span className="text-xs text-muted-foreground animate-pulse">正在加载更早的步骤...</span>
                                        ) : (
                                            <button
                                                onClick={onLoadOlder}
                                                className="text-xs text-muted-foreground hover:text-foreground transition-colors px-3 py-1.5 rounded-md hover:bg-muted/40"
                                            >
                                                ↑ 加载更早的步骤 (上方还有 {baseIndex} 步)
                                            </button>
                                        )}
                                    </div>
                                )}
                                {groups.map((group, gIdx) => {
                                    const isRecent = gIdx >= groups.length - 3;
                                    const animClass = isRecent ? 'message-animate' : '';
                                    if (group.type === 'user') {
                                        const { step, originalIndex } = group.steps[0];
                                        return <div key={`u-${gIdx}`} className={animClass}><UserMessage step={step} index={originalIndex} /></div>;
                                    }
                                    if (group.type === 'response') {
                                        const { step, originalIndex } = group.steps[0];
                                        return <div key={`r-${gIdx}`} className={animClass}><AgentResponse step={step} index={originalIndex} /></div>;
                                    }
                                    if (group.type === 'image') {
                                        const { step, originalIndex } = group.steps[0];
                                        return <div key={`img-${gIdx}`} className={animClass}><GeneratedImageStep step={step} originalIndex={originalIndex} /></div>;
                                    }
                                    return <div key={`p-${gIdx}`} className={animClass}><ProcessingGroup steps={group.steps} cascadeId={activeCascadeId} lastTerminalIndex={lastTerminalIndex} /></div>;
                                })}
                                {liveTurns.map((turn) => (
                                    <div key={turn.id} className="space-y-3 my-3">
                                        <div className="flex justify-end">
                                            <div className="max-w-[82%] rounded-2xl rounded-tr-sm px-4 py-2.5 bg-primary/10 border border-primary/15 text-sm whitespace-pre-wrap">
                                                {turn.prompt}
                                            </div>
                                        </div>
                                        <div className="my-2 space-y-2">
                                            {(turn.pending || turn.thinking || turn.tools.length > 0) && (
                                                <div className="rounded-xl border border-border/60 bg-muted/25 overflow-hidden">
                                                    <button
                                                        type="button"
                                                        onClick={() =>
                                                            setLiveTurns((prev) =>
                                                                prev.map((item) => (item.id === turn.id ? { ...item, showThinking: !item.showThinking } : item)),
                                                            )
                                                        }
                                                        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer text-left"
                                                    >
                                                        {turn.pending ? (
                                                            <Loader2 className="h-3.5 w-3.5 animate-spin text-foreground/75 shrink-0" />
                                                        ) : turn.showThinking ? (
                                                            <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                                                        ) : (
                                                            <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                                                        )}
                                                        <span className="font-medium">
                                                            {turn.pending
                                                                ? (turn.phase === 'tool'
                                                                    ? `正在执行工具 (${(turn.elapsedMs / 1000).toFixed(1)}s)`
                                                                    : turn.phase === 'answering'
                                                                        ? `正在输出回复 (${(turn.elapsedMs / 1000).toFixed(1)}s)`
                                                                        : `正在深度思考 (${(turn.elapsedMs / 1000).toFixed(1)}s)`)
                                                                : `已思考并处理 (${(turn.elapsedMs / 1000).toFixed(1)}s)`}
                                                        </span>
                                                        {turn.tools.length > 0 && (
                                                            <span className="text-[11px] text-muted-foreground/70 ml-auto">
                                                                {turn.tools.length} 次工具调用
                                                            </span>
                                                        )}
                                                    </button>
                                                    {turn.showThinking && (turn.thinking || turn.tools.length > 0) && (
                                                        <div className="border-t border-border/40 px-3 py-2 space-y-2 text-xs text-muted-foreground">
                                                            {turn.thinking && (
                                                                <div className="whitespace-pre-wrap leading-relaxed max-h-[220px] overflow-y-auto">
                                                                    {turn.thinking}
                                                                </div>
                                                            )}
                                                            {turn.tools.length > 0 && (
                                                                <div className="flex flex-wrap gap-1.5 pt-0.5">
                                                                    {turn.tools.map((tl, i) => (
                                                                        <span
                                                                            key={`${tl.name}-${i}`}
                                                                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-background/80 border border-border/50 text-[11px] font-mono"
                                                                        >
                                                                            {tl.status !== 'DONE' && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
                                                                            <span>{tl.name}</span>
                                                                        </span>
                                                                    ))}
                                                                </div>
                                                            )}
                                                        </div>
                                                    )}
                                                </div>
                                            )}

                                            {turn.error && (
                                                <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-3.5 py-2.5 text-xs text-destructive whitespace-pre-wrap">
                                                    {turn.error}
                                                </div>
                                            )}

                                            {turn.reply && (
                                                <div className="rounded-2xl bg-card border border-border/50 px-4 py-3 text-sm leading-relaxed">
                                                    <MarkdownRenderer content={turn.reply} />
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                ))}
                                {isRunning && !isStreamingCli && <StreamingIndicator />}
                                <div ref={bottomRef} className="h-4" />
                            </div>
                        )}
                        {/* Scroll to bottom button */}
                        {showScrollBtn && (
                            <Button
                                onClick={scrollToBottom}
                                variant="secondary"
                                size="sm"
                                className="scroll-bottom-btn"
                            >
                                <ArrowDownIcon className="h-3 w-3 mr-1 inline" /> 查看最新消息
                            </Button>
                        )}
                    </div>

                    {/* Input bar (Doubao floating rounded composer) */}
                    <div className="px-3 sm:px-6 pb-3 pt-1 bg-gradient-to-t from-background via-background/95 to-transparent"
                        onDragOver={handleDragOver}
                        onDragLeave={handleDragLeave}
                        onDrop={handleDrop}
                    >
                        {/* Drag overlay */}
                        {isDragOver && (
                            <div className="absolute inset-0 z-50 flex items-center justify-center bg-primary/5 border-2 border-dashed border-primary/40 rounded-lg backdrop-blur-sm pointer-events-none">
                                <div className="text-center space-y-2">
                                    <div className="flex items-center justify-center gap-2">
                                        <Camera className="h-6 w-6 text-primary/60" />
                                        <p className="text-sm font-medium text-primary/80">松手以上传图片或日志/配置文件</p>
                                    </div>
                                </div>
                            </div>
                        )}
                        <div className="max-w-3xl mx-auto rounded-2xl border border-border/80 bg-card shadow-[0_6px_24px_rgba(0,0,0,0.06)] px-3 pt-2.5 pb-2 space-y-2">
                            {/* Pickers row */}
                            <div className="flex items-center gap-1.5 text-xs flex-wrap">
                                {/* Categorized Model Picker, Effort Picker, & Integrated agy Account Switcher */}
                                <TieredModelPicker
                                    models={models}
                                    groups={modelGroups}
                                    selectedModel={selectedModel}
                                    selectedEffort={selectedEffort}
                                    onSelectModel={setSelectedModel}
                                    onSelectEffort={handleSelectEffort}
                                    activeAccount={activeAccount}
                                    hubSyncing={hubSyncing}
                                    loading={modelsLoading}
                                />
                                <EffortPicker
                                    models={models}
                                    selectedModel={selectedModel}
                                    selectedEffort={selectedEffort}
                                    onSelectModel={setSelectedModel}
                                    onSelectEffort={handleSelectEffort}
                                />
                                {isAdmin && (
                                    <AccountSwitcherPill
                                        activeAccount={activeAccount}
                                        detected={Boolean(detected)}
                                        onSwitched={refreshActiveModels}
                                        onOpenAccounts={onOpenAccounts}
                                    />
                                )}

                                {/* 3-mode Execution Guard Pill (admin only when Hub IDE active) */}
                                {isAdmin && detected && (
                                    <button
                                        type="button"
                                        onClick={handleCycleGuardMode}
                                        title="点击切换执行审批策略：智能放行（推荐） → 全自动 → 逐项确认"
                                        className={cn(
                                            'inline-flex items-center gap-1 h-7 px-2.5 rounded-full text-[11px] font-medium border transition-colors cursor-pointer',
                                            !autoAccept
                                                ? 'bg-muted/50 text-muted-foreground border-border/60 hover:text-foreground'
                                                : autoAcceptPolicy === 'full'
                                                    ? 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/30'
                                                    : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30'
                                        )}
                                    >
                                        {!autoAccept ? <ShieldAlert className="h-3 w-3" /> : <Shield className="h-3 w-3" />}
                                        <span>{!autoAccept ? '逐项确认' : autoAcceptPolicy === 'full' ? '全自动' : '智能放行'}</span>
                                    </button>
                                )}

                                {/* Engine switch: Hub vs agy CLI only shown if Hub IDE actually connected */}
                                {detected && (
                                    <button
                                        type="button"
                                        onClick={() => setUseAgyCli((v) => !v)}
                                        title="切换执行引擎：Antigravity Hub / agy CLI 直连"
                                        className={cn(
                                            'inline-flex items-center gap-1 h-7 px-2 rounded-full text-[11px] border transition-colors cursor-pointer',
                                            useAgyCli
                                                ? 'bg-muted text-foreground border-border'
                                                : 'bg-muted/40 text-muted-foreground border-border/50 hover:text-foreground'
                                        )}
                                    >
                                        <Terminal className="h-3 w-3" />
                                        <span>{useAgyCli ? 'CLI' : 'Hub'}</span>
                                    </button>
                                )}

                                {isAdmin && (hasLowQuota || hasRateLimitError) && (
                                    <button
                                        type="button"
                                        onClick={handleQuickRotateAccount}
                                        disabled={rotatingAccount}
                                        className="inline-flex items-center gap-1 h-7 px-2.5 rounded-full text-[11px] font-medium bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/35 hover:bg-amber-500/25 cursor-pointer"
                                    >
                                        {rotatingAccount ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCw className="h-3 w-3" />}
                                        <span>额度紧张 · 一键换号</span>
                                    </button>
                                )}

                                {/* Status indicator */}
                                {isActive && (
                                    <div className="flex items-center gap-1.5 text-[10px] text-primary ml-1">
                                        <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                                        {isWaiting ? (autoAccept ? '处理审批...' : '等待你审批') : '执行中'}
                                    </div>
                                )}

                                <div className="flex-1" />

                                {/* New chat button */}
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={handleNewChat}
                                    className="gap-1 h-7 text-muted-foreground hover:text-foreground"
                                >
                                    <Plus className="h-3.5 w-3.5" />
                                    <span className="hidden sm:inline">新对话</span>
                                </Button>

                                {/* Chat Settings Dropdown */}
                                <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                        <Button variant="ghost" size="sm" className="gap-1.5 h-7 text-muted-foreground hover:text-foreground">
                                            <Settings className="w-3.5 h-3.5" />
                                            <span className="hidden sm:inline">对话设置</span>
                                        </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end" className="w-56 mb-1 bg-popover/95 backdrop-blur-sm shadow-xl rounded-lg border-border">
                                        <DropdownMenuLabel className="flex items-center gap-2 text-xs font-normal text-muted-foreground px-2 py-1.5">
                                            <Folder className="w-3.5 h-3.5" />
                                            <span className="truncate flex-1 min-w-0">{selectedWsName}</span>
                                        </DropdownMenuLabel>
                                        <DropdownMenuSeparator className="bg-border" />
                                        <DropdownMenuItem
                                            onClick={(e) => {
                                                e.preventDefault();
                                                const newVal = !autoAccept;
                                                setAutoAccept(newVal);
                                                setAutoAcceptState(newVal).catch(() => { });
                                            }}
                                            className="cursor-pointer flex items-center justify-between"
                                        >
                                            <div className="flex items-center gap-2">
                                                <Zap className={cn("w-3.5 h-3.5", autoAccept ? "text-green-400" : "text-muted-foreground")} />
                                                <span className={autoAccept ? "text-green-400/90" : ""}>自动放行操作</span>
                                            </div>
                                            <Switch checked={autoAccept} className="scale-75 pointer-events-none" />
                                        </DropdownMenuItem>
                                        <DropdownMenuItem
                                            onClick={(e) => {
                                                e.preventDefault();
                                                onSetShowTimeline(!showTimeline);
                                            }}
                                            className="cursor-pointer flex items-center justify-between"
                                        >
                                            <div className="flex items-center gap-2">
                                                <Activity className={cn("w-3.5 h-3.5", showTimeline ? "text-blue-400" : "text-muted-foreground")} />
                                                <span className={showTimeline ? "text-blue-400/90" : ""}>步骤时间轴</span>
                                            </div>
                                            <Switch checked={showTimeline} className="scale-75 pointer-events-none" />
                                        </DropdownMenuItem>
                                        <DropdownMenuItem onClick={() => setShowTokens(!showTokens)} className="cursor-pointer">
                                            <BarChart2 className="w-3.5 h-3.5 mr-2 text-muted-foreground" />
                                            {showTokens ? '隐藏 Token 统计' : '显示 Token 统计'}
                                        </DropdownMenuItem>
                                        <DropdownMenuSeparator className="bg-white/5" />
                                        <DropdownMenuItem onClick={onToggleAnalytics} className="cursor-pointer">
                                            <BarChart2 className="w-3.5 h-3.5 mr-2 text-muted-foreground" />
                                            {showAnalytics ? '隐藏统计面板' : '显示统计面板'}
                                        </DropdownMenuItem>
                                        <DropdownMenuItem onClick={onExport} disabled={steps.length === 0} className="cursor-pointer">
                                            <Download className="w-3.5 h-3.5 mr-2 text-muted-foreground" />
                                            导出 Markdown
                                        </DropdownMenuItem>
                                        <DropdownMenuItem
                                            onClick={() => notificationService?.setEnabled(!notificationsEnabled)}
                                            className="cursor-pointer"
                                        >
                                            {notificationsEnabled
                                                ? <><BellOff className="w-3.5 h-3.5 mr-2 text-muted-foreground" /> 关闭通知提醒</>
                                                : <><Bell className="w-3.5 h-3.5 mr-2 text-muted-foreground" /> 开启通知提醒</>}
                                        </DropdownMenuItem>
                                        <DropdownMenuSeparator className="bg-white/5" />
                                        <DropdownMenuItem
                                            onClick={async () => {
                                                if (!activeCascadeId) return;
                                                try {
                                                    await clearConversationCache(activeCascadeId);
                                                    window.dispatchEvent(new CustomEvent('refresh-conversation', { detail: { cascadeId: activeCascadeId } }));
                                                } catch (e) { console.error('Refresh error:', e); }
                                            }}
                                            className="cursor-pointer text-muted-foreground focus:text-foreground"
                                        >
                                            <RefreshCcw className="w-3.5 h-3.5 mr-2" />
                                            刷新对话缓存
                                        </DropdownMenuItem>
                                    </DropdownMenuContent>
                                </DropdownMenu>
                            </div>

                            {/* Token usage display */}
                            {showTokens && <TokenUsage cascadeId={activeCascadeId} />}

                            {/* Uploaded files preview */}
                            {(pendingFiles.length > 0 || uploadingFile || uploadNotice) && (
                                <div className="flex flex-wrap items-center gap-1.5 px-2 py-1.5 bg-muted/30 border border-border/50 rounded-xl text-xs">
                                    {pendingFiles.map((f) => (
                                        <span key={f.path} className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-background border border-border/60 max-w-[220px]">
                                            <FileText className="h-3 w-3 text-primary shrink-0" />
                                            <span className="truncate text-[11px]">{f.originalName}</span>
                                            <button
                                                type="button"
                                                onClick={() => setPendingFiles((prev) => prev.filter((x) => x.path !== f.path))}
                                                className="text-muted-foreground hover:text-destructive cursor-pointer"
                                            >
                                                <X className="h-3 w-3" />
                                            </button>
                                        </span>
                                    ))}
                                    {uploadingFile && (
                                        <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                                            <Loader2 className="h-3 w-3 animate-spin" /> 正在上传文件...
                                        </span>
                                    )}
                                    {uploadNotice && (
                                        <span className="text-[11px] text-destructive">{uploadNotice}</span>
                                    )}
                                </div>
                            )}

                            {/* Image preview — multi-image horizontal list */}
                            {pendingImages.length > 0 && (
                                <div className="flex items-center gap-2 px-3 py-2 bg-muted/20 border border-border/30 rounded-lg overflow-x-auto">
                                    {pendingImages.map((img) => (
                                        <div key={img.id} className="relative shrink-0 group/img">
                                            <img src={img.dataUrl} className="w-14 h-14 rounded-lg object-cover border border-border/30" alt={img.name} title={img.name} />
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-destructive text-destructive-foreground opacity-0 group-hover/img:opacity-100 transition-opacity shadow-md"
                                                onClick={() => removeImage(img.id)}
                                            >
                                                <X className="h-2.5 w-2.5" />
                                            </Button>
                                        </div>
                                    ))}
                                    {pendingImages.length > 1 && (
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="shrink-0 h-6 text-[10px] text-muted-foreground hover:text-destructive px-2"
                                            onClick={clearAllImages}
                                        >
                                            清空全部
                                        </Button>
                                    )}
                                    <span className="shrink-0 text-[10px] text-muted-foreground/60">
                                        {pendingImages.length} 张图片
                                    </span>
                                </div>
                            )}

                            {/* Hidden file input — supports images & logs/scripts/configs */}
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept="image/*,.log,.txt,.sh,.py,.js,.ts,.tsx,.jsx,.json,.yaml,.yml,.conf,.ini,.md,.csv,.env,.sql,.xml"
                                multiple
                                className="hidden"
                                onChange={handleImagePick}
                            />

                            {/* Input area */}
                            <div className="relative flex items-end gap-2">
                                {/* Workflow autocomplete popup */}
                                <WorkflowAutocomplete
                                    query={workflowQuery}
                                    workflows={workflows}
                                    visible={showWorkflows}
                                    onSelect={handleWorkflowSelect}
                                    onClose={() => setShowWorkflows(false)}
                                    ref={autocompleteRef}
                                />
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="shrink-0 h-9 w-9 sm:h-10 sm:w-10 rounded-xl border border-border/50"
                                    onClick={() => fileInputRef.current?.click()}
                                    title="上传图片或日志/配置文件"
                                >
                                    <Paperclip className="h-4 w-4" />
                                </Button>
                                {isAdmin && (
                                    <Button
                                        variant={showSourceControl ? 'secondary' : 'ghost'}
                                        size="icon"
                                        className={cn(
                                            'shrink-0 h-9 w-9 sm:h-11 sm:w-11 rounded-lg border border-border/50',
                                            showSourceControl && 'border-primary/30'
                                        )}
                                        onClick={() => setShowSourceControl(v => !v)}
                                        title="源代码管理"
                                    >
                                        <GitBranch className="h-4 w-4" />
                                    </Button>
                                )}
                                <Textarea
                                    ref={inputRef}
                                    value={input}
                                    onChange={e => handleInputChange(e.target.value)}
                                    onKeyDown={handleKeyDown}
                                    onPaste={handlePaste}
                                    placeholder={currentConvId ? "输入消息继续对话..." : "问我任何服务器运维或代码问题..."}
                                    className="flex-1 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0 min-h-[36px] sm:min-h-[42px] max-h-[200px] text-sm !py-[8px]"
                                    rows={1}
                                    onInput={(e) => {
                                        const target = e.target as HTMLTextAreaElement;
                                        target.style.height = 'auto';
                                        target.style.height = Math.min(target.scrollHeight, 200) + 'px';
                                    }}
                                />
                                {isRunning ? (
                                    <Button onClick={handleCancel} variant="destructive" size="icon" className="h-9 w-9 sm:h-10 sm:w-10 rounded-xl shrink-0">
                                        <Square className="h-4 w-4" />
                                    </Button>
                                ) : (
                                    <Button
                                        onClick={handleSend}
                                        disabled={(!input.trim() && pendingImages.length === 0 && pendingFiles.length === 0) || sending}
                                        size="icon"
                                        className="h-9 w-9 sm:h-10 sm:w-10 rounded-xl shrink-0"
                                    >
                                        <SendHorizontal className="h-4 w-4" />
                                    </Button>
                                )}
                            </div>
                        </div>
                    </div>
                </>
            )}
        </div>
    );
}
