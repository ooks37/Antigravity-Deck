'use client';

import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import dynamic from 'next/dynamic';
import { useWebSocket } from '@/lib/websocket';
import { extractStepContent, exportToMarkdown } from '@/lib/step-utils';
import { Timeline } from '@/components/timeline';
import { Badge } from '@/components/ui/badge';
import { Loader2, Check, Smartphone, Share2, X, Users, Settings, Network, RotateCw, Power, Wrench, Plus, Shield, User } from 'lucide-react';
import type { Project } from '@/lib/conversations';
import { cleanConversationTitle } from '@/lib/conversations';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChatView } from '@/components/chat-view';
import { AppSidebar } from '@/components/app-sidebar';
import { SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useAuthUser } from '@/components/auth-gate';
import type { ToolboxTab } from '@/components/toolbox-drawer';
import { notificationService } from '@/lib/notifications';
import { initAppLogger } from '@/lib/app-logger';
import { usePwaInstall } from '@/hooks/use-pwa-install';
import { getSettings, getProfiles, getProxyState, useProxyNode, rotateProxyNode, type ProxyState } from '@/lib/cascade-api';

// Lazy-load secondary views & modals so logged-in chat loads immediately without waiting on admin/diff bundles
const AccountInfoView = dynamic(() => import('@/components/user-profile').then(m => ({ default: m.AccountInfoView })), { ssr: false });
const SettingsView = dynamic(() => import('@/components/settings-view').then(m => ({ default: m.SettingsView })), { ssr: false });
const UserAccountDialog = dynamic(() => import('@/components/user-account-dialog').then(m => ({ default: m.UserAccountDialog })), { ssr: false });
const AgentLogsView = dynamic(() => import('@/components/agent-logs-view').then(m => ({ default: m.AgentLogsView })), { ssr: false });
const SourceControlView = dynamic(() => import('@/components/source-control-view').then(m => ({ default: m.SourceControlView })), { ssr: false });
const ResourceMonitorView = dynamic(() => import('@/components/resource-monitor-view').then(m => ({ default: m.ResourceMonitorView })), { ssr: false });
const ConversationHistoryView = dynamic(() => import('@/components/conversation-history-view').then(m => ({ default: m.ConversationHistoryView })), { ssr: false });
const WorkspaceOnboardModal = dynamic(() => import('@/components/workspace-onboard-modal').then(m => ({ default: m.WorkspaceOnboardModal })), { ssr: false });
const AnalyticsPanel = dynamic(() => import('@/components/analytics-panel').then(m => ({ default: m.AnalyticsPanel })), { ssr: false });
const StepDetail = dynamic(() => import('@/components/step-detail').then(m => ({ default: m.StepDetail })), { ssr: false });
const McpView = dynamic(() => import('@/components/mcp-view').then(m => ({ default: m.McpView })), { ssr: false });
const WorkflowsView = dynamic(() => import('@/components/workflows-view').then(m => ({ default: m.WorkflowsView })), { ssr: false });
const MemoriesView = dynamic(() => import('@/components/memories-view').then(m => ({ default: m.MemoriesView })), { ssr: false });
const RepoInfoView = dynamic(() => import('@/components/repo-info-view').then(m => ({ default: m.RepoInfoView })), { ssr: false });
const ToolboxView = dynamic(() => import('@/components/toolbox-drawer').then(m => ({ default: m.ToolboxView })), { ssr: false });

/** Read a JSON-serialised value from localStorage (SSR-safe). */
function getStoredValue<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const stored = localStorage.getItem(key);
    if (stored === null) return fallback;
    return JSON.parse(stored) as T;
  } catch { return fallback; }
}

export function WorkspaceShell() {
  const { user } = useAuthUser();
  const isAdmin = user?.role === 'admin';
  const { detected, steps, baseIndex, stepCount, loadingOlder, stepsLoading, convNotFound, conversations, currentConvId, cascadeStatus, conversationsVersion, selectConversation, loadConversations, loadOlder, hydrateConversation } = useWebSocket();

  const [showAnalytics, setShowAnalytics] = useState(() => getStoredValue('antigravity-show-analytics', false));
  const [showTimeline, setShowTimeline] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('showTimeline');
      return saved !== null ? saved === 'true' : false;
    }
    return false;
  });
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [accountBadge, setAccountBadge] = useState<{ label: string; email: string | null; total: number } | null>(null);
  const [proxyState, setProxyState] = useState<ProxyState | null>(null);
  const [proxyBusy, setProxyBusy] = useState(false);
  const [userDialogOpen, setUserDialogOpen] = useState(false);
  const [userDialogTab, setUserDialogTab] = useState<'account' | 'members'>('account');

  const refreshAccountBadge = useCallback(() => {
    if (!isAdmin) return;
    getProfiles()
      .then((d) => {
        const oauthLabel = d.oauth?.activeAlias || d.oauth?.activeName || (d.oauth?.activeEmail ? d.oauth.activeEmail.split('@')[0] : null);
        const label = oauthLabel || d.active || '';
        const total = (d.oauth?.accounts?.length || 0) || d.profiles.length;
        setAccountBadge({
          label,
          email: d.oauth?.activeEmail || null,
          total,
        });
      })
      .catch(() => { /* keep previous */ });
  }, [isAdmin]);

  const refreshProxyState = useCallback(() => {
    if (!isAdmin) return;
    getProxyState()
      .then((d) => setProxyState(d))
      .catch(() => { /* keep previous */ });
  }, [isAdmin]);

  useEffect(() => {
    if (!isAdmin) return;
    refreshAccountBadge();
    refreshProxyState();
    window.addEventListener('oauth-account-swapped', refreshAccountBadge);
    window.addEventListener('profile-swapped', refreshAccountBadge);
    window.addEventListener('proxy-updated', refreshProxyState);
    return () => {
      window.removeEventListener('oauth-account-swapped', refreshAccountBadge);
      window.removeEventListener('profile-swapped', refreshAccountBadge);
      window.removeEventListener('proxy-updated', refreshProxyState);
    };
  }, [isAdmin, refreshAccountBadge, refreshProxyState]);

  const handleSwitchProxy = useCallback(async (nodeId: string | null) => {
    if (proxyBusy) return;
    setProxyBusy(true);
    try {
      const res = await useProxyNode(nodeId, nodeId !== null);
      setProxyState(res.state);
    } catch (e) {
      console.error('Switch proxy failed:', e);
    } finally {
      setProxyBusy(false);
    }
  }, [proxyBusy]);

  const handleRotateProxy = useCallback(async () => {
    if (proxyBusy) return;
    setProxyBusy(true);
    try {
      const res = await rotateProxyNode();
      setProxyState(res.state);
    } catch (e) {
      console.error('Rotate proxy failed:', e);
    } finally {
      setProxyBusy(false);
    }
  }, [proxyBusy]);

  // === PWA Notification service init + App Logger ===
  useEffect(() => {
    notificationService?.init();
    initAppLogger();
  }, []);

  // === PWA Install ===
  const pwaInstall = usePwaInstall();

  // Persist showTimeline to localStorage
  const handleSetShowTimeline = useCallback((val: boolean) => {
    setShowTimeline(val);
    localStorage.setItem('showTimeline', String(val));
  }, []);

  // Listen for localStorage changes (e.g. from Settings view)
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'showTimeline' && e.newValue !== null) {
        setShowTimeline(e.newValue === 'true');
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // === Mobile sidebar state ===
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarClosing, setSidebarClosing] = useState(false);

  const handleCloseSidebar = useCallback(() => {
    setSidebarClosing(true);
    setTimeout(() => { setSidebarOpen(false); setSidebarClosing(false); }, 200);
  }, []);

  // === Active workspace name — which workspace the user is "in" ===
  const [activeWorkspace, setActiveWorkspace] = useState<string | null>(() => getStoredValue('antigravity-active-workspace', null));
  // NEW: When true, show ChatView in "new chat" mode (no conversation yet)
  const [newChatMode, setNewChatMode] = useState(false);
  // Folder URI to scope a project-scoped new conversation (null = global/loose new chat).
  const [newChatWorkspaceUri, setNewChatWorkspaceUri] = useState<string | null>(null);
  // NEW: When true, show AccountInfoView in main panel
  const [showAccountInfo, setShowAccountInfo] = useState(() => getStoredValue('antigravity-show-account-info', false));
  // NEW: When true, show SettingsView in main panel
  const [showSettings, setShowSettings] = useState(() => getStoredValue('antigravity-show-settings', false));
  // NEW: When true, show AgentLogsView in main panel
  const [showLogs, setShowLogs] = useState(() => getStoredValue('antigravity-show-logs', false));
  // NEW: When true, show Source Control / IDE view in main panel
  const [showSourceControl, setShowSourceControl] = useState(false);
  const [showResources, setShowResources] = useState(false);
  // NEW: When true, show MCP Servers panel in main panel
  const [showMcp, setShowMcp] = useState(false);
  // NEW: When true, show Workflows / Skills / Rules panel in main panel
  const [showWorkflows, setShowWorkflows] = useState(false);
  // NEW: When true, show Memories (knowledge items) panel in main panel
  const [showMemories, setShowMemories] = useState(false);
  // NEW: When true, show Repo Info panel in main panel
  const [showRepoInfo, setShowRepoInfo] = useState(false);
  // Explicit History view toggle (Doubao default lands directly on New Chat instead)
  const [showHistoryPage, setShowHistoryPage] = useState(false);
  // Consolidated Toolbox drawer/view for IDE tools (MCP / Workflows / Memories / Resources / Logs / Repo / Git)
  const [showToolbox, setShowToolbox] = useState(false);
  const [toolboxTab, setToolboxTab] = useState<ToolboxTab>('mcp');
  const [prefillPrompt, setPrefillPrompt] = useState<{ text: string; seq: number } | null>(null);
  // Conversation History is filtered to a project when set (null = all).
  const [historyProjectId, setHistoryProjectId] = useState<string | null>(null);
  // Bumped when sidebar creates a workspace, so panels refresh their lists
  const [wsVersion, setWsVersion] = useState(0);

  // === Workspace Onboarding ===
  const [showWorkspaceOnboard, setShowWorkspaceOnboard] = useState(false);
  const [suggestedWorkspaceRoot, setSuggestedWorkspaceRoot] = useState('');

  // Auto-bump wsVersion when backend discovers new conversations
  useEffect(() => {
    if (conversationsVersion > 0) setWsVersion(v => v + 1);
  }, [conversationsVersion]);

  // === Persist navigation state to localStorage ===
  useEffect(() => { localStorage.setItem('antigravity-active-workspace', JSON.stringify(activeWorkspace)); }, [activeWorkspace]);
  useEffect(() => { localStorage.setItem('antigravity-show-settings', JSON.stringify(isAdmin && showSettings)); }, [showSettings, isAdmin]);
  useEffect(() => { localStorage.setItem('antigravity-show-account-info', JSON.stringify(isAdmin && showAccountInfo)); }, [showAccountInfo, isAdmin]);
  useEffect(() => { localStorage.setItem('antigravity-show-logs', JSON.stringify(isAdmin && showLogs)); }, [showLogs, isAdmin]);
  useEffect(() => { localStorage.setItem('antigravity-show-analytics', JSON.stringify(showAnalytics)); }, [showAnalytics]);

  // Persist currentConvId and restore on mount
  useEffect(() => {
    localStorage.setItem('antigravity-current-conv-id', JSON.stringify(currentConvId));
  }, [currentConvId]);

  useEffect(() => {
    const storedConvId = getStoredValue<string | null>('antigravity-current-conv-id', null);
    if (storedConvId) {
      selectConversation(storedConvId);
    }
    if (isAdmin) {
      getSettings().then(settings => {
        if (!settings.defaultWorkspaceRoot) {
          setSuggestedWorkspaceRoot((settings as Record<string, string>).suggestedWorkspaceRoot || '');
          setShowWorkspaceOnboard(true);
        }
      }).catch(() => { });
    }

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]); // run once or on role upgrade

  // Step detail state
  const [selectedStep, setSelectedStep] = useState<number | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  // Bookmarks
  const [bookmarkedSteps, setBookmarkedSteps] = useState<Set<number>>(new Set());


  // Helper to reset all panel states
  const resetPanels = useCallback(() => {
    setNewChatMode(false);
    setShowAccountInfo(false);
    setShowSettings(false);
    setShowLogs(false);
    setShowSourceControl(false);
    setShowResources(false);
    setShowMcp(false);
    setShowWorkflows(false);
    setShowMemories(false);
    setShowRepoInfo(false);
    setShowToolbox(false);
    setShowHistoryPage(false);
  }, []);

  // === Sidebar or History: click conversation → open chat ===
  const handleSelectConversation = useCallback((convId: string | null, wsName: string) => {
    setActiveWorkspace(wsName);
    resetPanels();
    selectConversation(convId);
  }, [selectConversation, resetPanels]);

  // === New Chat (from ChatView) — show ChatView in new chat mode ===
  const handleNewChat = useCallback(() => {
    selectConversation(null);
    resetPanels();
    setNewChatWorkspaceUri(null);
    setNewChatMode(true);
  }, [selectConversation, resetPanels]);

  // === New Conversation (top action) — fresh chat, no project context ===
  const handleNewConversation = useCallback(() => {
    selectConversation(null);
    resetPanels();
    setActiveWorkspace(null);
    setHistoryProjectId(null);
    setNewChatWorkspaceUri(null);
    setNewChatMode(true);
  }, [selectConversation, resetPanels]);

  // === New Project created ===
  const handleProjectCreated = useCallback((name: string) => {
    selectConversation(null);
    resetPanels();
    setHistoryProjectId(null);
    setActiveWorkspace(name);
    setNewChatWorkspaceUri(null);
    setNewChatMode(true);
  }, [selectConversation, resetPanels]);

  // === New conversation in an existing project ===
  const handleNewProjectConversation = useCallback((project: Project) => {
    selectConversation(null);
    resetPanels();
    setHistoryProjectId(null);
    setActiveWorkspace(project.name);
    setNewChatWorkspaceUri(project.folderUri || null);
    setNewChatMode(true);
  }, [selectConversation, resetPanels]);

  // === Admin-only overlays ===
  const handleShowAccountInfo = useCallback(() => {
    if (!isAdmin) return;
    selectConversation(null);
    resetPanels();
    setActiveWorkspace(null);
    setShowAccountInfo(true);
  }, [isAdmin, selectConversation, resetPanels]);

  const handleShowSettings = useCallback(() => {
    if (!isAdmin) return;
    selectConversation(null);
    resetPanels();
    setActiveWorkspace(null);
    setShowSettings(true);
  }, [isAdmin, selectConversation, resetPanels]);

  const handleShowLogs = useCallback(() => {
    if (!isAdmin) return;
    selectConversation(null);
    resetPanels();
    setActiveWorkspace(null);
    setShowLogs(true);
  }, [isAdmin, selectConversation, resetPanels]);

  const handleShowSourceControl = useCallback(() => {
    if (!isAdmin) return;
    selectConversation(null);
    resetPanels();
    setShowSourceControl(true);
  }, [isAdmin, selectConversation, resetPanels]);

  const handleShowResources = useCallback(() => {
    if (!isAdmin) return;
    selectConversation(null);
    resetPanels();
    setActiveWorkspace(null);
    setShowResources(true);
  }, [isAdmin, selectConversation, resetPanels]);

  const handleShowMcp = useCallback(() => {
    if (!isAdmin) return;
    selectConversation(null);
    resetPanels();
    setActiveWorkspace(null);
    setShowMcp(true);
  }, [isAdmin, selectConversation, resetPanels]);

  const handleShowWorkflows = useCallback(() => {
    if (!isAdmin) return;
    selectConversation(null);
    resetPanels();
    setActiveWorkspace(null);
    setShowWorkflows(true);
  }, [isAdmin, selectConversation, resetPanels]);

  const handleShowMemories = useCallback(() => {
    if (!isAdmin) return;
    selectConversation(null);
    resetPanels();
    setActiveWorkspace(null);
    setShowMemories(true);
  }, [isAdmin, selectConversation, resetPanels]);

  const handleShowRepoInfo = useCallback(() => {
    if (!isAdmin) return;
    selectConversation(null);
    resetPanels();
    setActiveWorkspace(null);
    setShowRepoInfo(true);
  }, [isAdmin, selectConversation, resetPanels]);

  const handleShowHistory = useCallback((projectId: string | null = null) => {
    selectConversation(null);
    resetPanels();
    setActiveWorkspace(null);
    setHistoryProjectId(projectId);
    setShowHistoryPage(true);
  }, [selectConversation, resetPanels]);

  const handleGoHome = useCallback(() => {
    selectConversation(null);
    setActiveWorkspace(null);
    setHistoryProjectId(null);
    resetPanels();
    setNewChatMode(true);
  }, [selectConversation, resetPanels]);

  const handleShowToolbox = useCallback((tab: ToolboxTab = 'mcp') => {
    if (!isAdmin) return;
    selectConversation(null);
    resetPanels();
    setToolboxTab(tab);
    setShowToolbox(true);
  }, [isAdmin, selectConversation, resetPanels]);

  const handleOpenUserDialog = useCallback((tab: 'account' | 'members' = 'account') => {
    setUserDialogTab(tab === 'members' && !isAdmin ? 'account' : tab);
    setUserDialogOpen(true);
  }, [isAdmin]);

  // When CascadePanel creates a new cascade, track it
  const handleCascadeCreated = useCallback((cascadeId: string) => {
    setNewChatMode(false);
    selectConversation(cascadeId);
  }, [selectConversation]);

  // Called when a conversation is deleted from the sidebar.
  // Navigates away if the deleted conversation is currently open.
  // The sidebar's loadIndex() already re-fetches, so no wsVersion bump needed.
  const handleConvDeleted = useCallback((convId: string) => {
    if (currentConvId === convId) {
      selectConversation(null);
      setNewChatMode(false);
    }
  }, [currentConvId, selectConversation]);


  // Export
  const handleExport = useCallback(() => {
    if (currentConvId && steps.length > 0) exportToMarkdown(steps, currentConvId);
  }, [steps, currentConvId]);

  // Copy conversation ID
  const handleCopyId = useCallback((e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    navigator.clipboard.writeText(id);
    setTimeout(() => { }, 1500);
  }, []);

  // Step detail
  const openStepDetail = useCallback((index: number) => {
    setSelectedStep(index);
    setDetailOpen(true);
  }, []);

  const navigateStep = useCallback((direction: 'prev' | 'next') => {
    setSelectedStep(prev => {
      if (prev === null) return 0;
      const next = direction === 'prev' ? prev - 1 : prev + 1;
      return Math.max(0, Math.min(steps.length - 1, next));
    });
  }, [steps.length]);

  const toggleBookmark = useCallback(() => {
    if (selectedStep === null) return;
    setBookmarkedSteps(prev => {
      const next = new Set(prev);
      if (next.has(selectedStep)) next.delete(selectedStep);
      else next.add(selectedStep);
      return next;
    });
  }, [selectedStep]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      // Search focus
      if (mod && (e.key === 'f' || e.key === 'k')) {
        e.preventDefault();
        document.querySelector<HTMLInputElement>('input[data-search-steps]')?.focus();
      }
      // New conversation
      if (mod && e.key === 'n') {
        e.preventDefault();
        handleNewConversation();
      }
      // Export
      if (mod && e.shiftKey && e.key === 'E') {
        e.preventDefault();
        handleExport();
      }
      // Close panel
      if (e.key === 'Escape') {
        setDetailOpen(false);
      }
      // Arrow key navigation in detail panel
      if (detailOpen) {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); navigateStep('prev'); }
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); navigateStep('next'); }
        if (e.key === 'b') toggleBookmark();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [detailOpen, navigateStep, toggleBookmark, handleNewConversation, handleExport]);

  // Refresh conversation handler — re-selects the same conversation to force re-fetch
  useEffect(() => {
    const handler = (e: Event) => {
      const cascadeId = (e as CustomEvent).detail?.cascadeId;
      if (cascadeId) {
        // De-select then re-select to force WS re-fetch
        selectConversation(null);
        setTimeout(() => selectConversation(cascadeId), 100);
      }
    };
    window.addEventListener('refresh-conversation', handler);
    return () => window.removeEventListener('refresh-conversation', handler);
  }, [selectConversation]);

  const currentConvInfo = currentConvId ? conversations[currentConvId] : null;
  const headerTitle = useMemo(() => {
    if (isAdmin && showAccountInfo) return 'OAuth 模型与账号池';
    if (isAdmin && showSettings) return '后台设置与代理';
    if (isAdmin && showToolbox) return '系统工具箱';
    if (showHistoryPage) return '全部历史对话';
    if (currentConvId && currentConvInfo?.summary) return cleanConversationTitle(currentConvInfo.summary);
    if (currentConvId) return `对话 ${currentConvId.slice(0, 8)}`;
    return 'Antigravity 工作台';
  }, [isAdmin, showAccountInfo, showSettings, showToolbox, showHistoryPage, currentConvId, currentConvInfo?.summary]);

  // === Determine what to show in main panel ===
  const anyOverlay = isAdmin && (showAccountInfo || showSettings || showLogs || showSourceControl || showResources || showMcp || showWorkflows || showMemories || showRepoInfo || showToolbox);
  const showHistoryView = showHistoryPage && !anyOverlay && currentConvId === null;
  const showChat = !anyOverlay && !showHistoryView;

  return (
    <SidebarProvider>
      <TooltipProvider delayDuration={200}>
      <div className="flex h-dvh w-full bg-background text-foreground overflow-hidden">
        <AppSidebar
          currentConvId={currentConvId}
          conversationsVersion={conversationsVersion}
          detected={detected}
          onSelectConversation={handleSelectConversation}
          onNewConversation={handleNewConversation}
          onShowAccountInfo={handleShowAccountInfo}
          onShowSettings={handleShowSettings}
          onShowHistory={handleShowHistory}
          onGoHome={handleGoHome}
          onConvDeleted={handleConvDeleted}
          onShowToolbox={() => handleShowToolbox()}
          onOpenUserDialog={handleOpenUserDialog}
        />

        {/* Main content */}
        <div className="flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden pwa-main-content">
          {/* Clean minimalist navbar */}
          <header className="flex items-center justify-between px-3 sm:px-5 h-12 bg-background border-b border-border/70 flex-shrink-0 gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <SidebarTrigger className="-ml-1 w-8 h-8" />
              <button
                type="button"
                onClick={handleGoHome}
                className="font-medium text-sm text-foreground truncate max-w-[190px] sm:max-w-[420px] hover:opacity-80 transition-opacity cursor-pointer text-left"
                title={headerTitle}
              >
                {headerTitle}
              </button>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              {(currentConvId || anyOverlay || showHistoryView) && (
                <button
                  type="button"
                  onClick={handleNewConversation}
                  className="inline-flex items-center gap-1 h-7 px-2.5 rounded-full text-xs font-medium bg-muted/50 hover:bg-muted text-foreground/85 border border-border/60 transition-colors cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">新对话</span>
                </button>
              )}

              {isAdmin && (
                <>
                  {/* Compact Proxy Switcher */}
                  {(proxyState?.enabled || (proxyState?.nodes?.length || 0) > 0) && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          disabled={proxyBusy}
                          title={
                            proxyState?.enabled && proxyState?.activeNode
                              ? `出口代理: ${proxyState.activeNode.name} (${proxyState.activeNode.lastTest?.exitIp || `${proxyState.activeNode.host}:${proxyState.activeNode.port}`})`
                              : '当前直连（切换代理节点）'
                          }
                          className={`inline-flex items-center gap-1 h-7 px-2.5 rounded-full text-xs border transition-colors cursor-pointer ${
                            proxyState?.enabled && proxyState?.activeNode
                              ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30'
                              : 'bg-muted/40 hover:bg-muted text-muted-foreground border-border/60'
                          }`}
                        >
                          {proxyBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Network className="w-3 h-3" />}
                          <span className="max-w-[80px] truncate hidden md:inline">
                            {proxyState?.enabled && proxyState?.activeNode ? proxyState.activeNode.name : '直连'}
                          </span>
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-60 text-xs">
                        <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
                          {proxyState?.enabled && proxyState?.activeNode
                            ? `当前出口: ${proxyState.activeNode.name}`
                            : '当前模式: 本机直连'}
                        </DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => handleSwitchProxy(null)} className="text-xs justify-between cursor-pointer">
                          <span className="flex items-center gap-1.5">
                            <Power className="w-3.5 h-3.5 text-muted-foreground" />
                            直连（不使用代理）
                          </span>
                          {!proxyState?.enabled && <Check className="w-3.5 h-3.5 text-emerald-500" />}
                        </DropdownMenuItem>
                        {proxyState && proxyState.nodes.length > 0 && <DropdownMenuSeparator />}
                        {proxyState?.nodes.map((node) => (
                          <DropdownMenuItem
                            key={node.id}
                            onClick={() => handleSwitchProxy(node.id)}
                            className="text-xs justify-between cursor-pointer gap-2"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="truncate font-medium">{node.name}</div>
                              <div className="text-[10px] text-muted-foreground font-mono truncate">
                                {node.protocol.toUpperCase()} · {node.lastTest?.exitIp || `${node.host}:${node.port}`}
                              </div>
                            </div>
                            {proxyState.enabled && proxyState.activeNodeId === node.id && <Check className="w-3.5 h-3.5 text-emerald-500 shrink-0" />}
                          </DropdownMenuItem>
                        ))}
                        <DropdownMenuSeparator />
                        {proxyState && proxyState.nodes.length > 0 && (
                          <DropdownMenuItem onClick={handleRotateProxy} className="text-xs gap-1.5 cursor-pointer">
                            <RotateCw className="w-3.5 h-3.5" />
                            换下一个节点
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem onClick={handleShowSettings} className="text-xs gap-1.5 cursor-pointer">
                          <Settings className="w-3.5 h-3.5 text-muted-foreground" />
                          管理代理与设置
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}

                  <button
                    type="button"
                    onClick={handleShowAccountInfo}
                    title={accountBadge?.email ? `OAuth 模型池: ${accountBadge.email}` : 'OAuth 模型池与配额'}
                    className={`inline-flex items-center gap-1 h-7 px-2.5 rounded-full text-xs border transition-colors cursor-pointer ${
                      showAccountInfo
                        ? 'bg-foreground text-background border-foreground'
                        : 'bg-muted/40 hover:bg-muted text-foreground/80 border-border/60'
                    }`}
                  >
                    <Users className="w-3.5 h-3.5" />
                    <span className="max-w-[80px] truncate hidden sm:inline">
                      {accountBadge?.label || '模型池'}
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleShowToolbox()}
                    title="系统工具箱（MCP / 监控 / 日志 / Git）"
                    className={`inline-flex items-center gap-1 h-7 px-2 rounded-full text-xs border transition-colors cursor-pointer ${
                      showToolbox
                        ? 'bg-foreground text-background border-foreground'
                        : 'bg-muted/40 hover:bg-muted text-foreground/80 border-border/60'
                    }`}
                  >
                    <Wrench className="w-3.5 h-3.5" />
                  </button>
                </>
              )}

              <button
                type="button"
                onClick={() => handleOpenUserDialog('account')}
                className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-xs bg-muted/40 hover:bg-muted text-foreground/85 border border-border/60 transition-colors cursor-pointer"
                title={user ? `${user.displayName} (@${user.username})` : '个人账号'}
              >
                {isAdmin ? <Shield className="w-3 h-3 text-muted-foreground" /> : <User className="w-3 h-3 text-muted-foreground" />}
                <span className="max-w-[76px] truncate">{user?.displayName || user?.username || '账号'}</span>
              </button>
            </div>
          </header>

          {/* Keyboard shortcuts popup */}
          {showShortcuts && (
            <div className="absolute right-2 sm:right-4 top-12 z-50 w-[calc(100%-1rem)] sm:w-56 bg-popover border border-border rounded-lg shadow-xl p-3 space-y-1.5 text-xs">
              <div className="flex items-center justify-between pb-1.5 border-b border-border mb-1.5">
                <span className="font-semibold text-foreground">快捷键说明</span>
                <button onClick={() => setShowShortcuts(false)} className="text-muted-foreground hover:text-foreground">✕</button>
              </div>
              {[
                ['Ctrl+K', '搜索步骤'],
                ['Ctrl+N', '新建对话'],
                ['Ctrl+Shift+E', '导出 Markdown'],
                ['←  →', '切换上下步'],
                ['B', '收藏/取消步骤'],
                ['Esc', '关闭详情面板'],
                ['Enter', '发送消息'],
                ['Shift+Enter', '换行'],
              ].map(([key, desc]) => (
                <div key={key} className="flex items-center justify-between">
                  <span className="text-muted-foreground">{desc}</span>
                  <kbd className="px-1.5 py-0.5 bg-muted/50 rounded text-[9px] font-mono text-muted-foreground">{key}</kbd>
                </div>
              ))}
            </div>
          )}

          {/* Timeline */}
          {currentConvId && showTimeline && steps.length > 0 && (
            <Timeline
              steps={steps}
              onSelectStep={openStepDetail}
            />
          )}

          {/* Analytics — only load/mount when toggled on */}
          {currentConvId && steps.length > 0 && showAnalytics && (
            <div className="border-b border-border/50">
              <AnalyticsPanel steps={steps} />
            </div>
          )}

          {isAdmin && showAccountInfo && (
            <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
              <AccountInfoView detected={detected} onBackHome={handleGoHome} />
            </div>
          )}

          {isAdmin && showSettings && (
            <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
              <SettingsView />
            </div>
          )}

          {isAdmin && detected && showLogs && (
            <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
              <AgentLogsView />
            </div>
          )}

          {/* Source Control / IDE panel */}
          {isAdmin && showSourceControl && (
            <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
              {activeWorkspace ? (
                <SourceControlView
                  workspace={activeWorkspace}
                  onClose={() => setShowSourceControl(false)}
                />
              ) : (
                <div className="flex-1 flex items-center justify-center">
                  <div className="text-center space-y-3">
                    <div className="text-4xl">📂</div>
                    <h3 className="text-lg font-semibold text-foreground/70">尚未选择工作区</h3>
                    <p className="text-sm text-muted-foreground max-w-sm">
                      请先从左侧栏选择一个工作区项目，再打开源代码管理。
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Resource Monitor panel */}
          {isAdmin && showResources && (
            <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
              <ResourceMonitorView />
            </div>
          )}

          {/* MCP Servers panel */}
          {isAdmin && showMcp && (
            <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
              <McpView />
            </div>
          )}

          {/* Workflows / Skills / Rules panel */}
          {isAdmin && showWorkflows && (
            <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
              <WorkflowsView />
            </div>
          )}

          {/* Memories (knowledge items) panel */}
          {isAdmin && showMemories && (
            <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
              <MemoriesView />
            </div>
          )}

          {/* Repo Info panel */}
          {isAdmin && showRepoInfo && (
            <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
              <RepoInfoView />
            </div>
          )}

          {/* Consolidated Toolbox drawer/view */}
          {isAdmin && showToolbox && (
            <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
              <ToolboxView
                initialTab={toolboxTab}
                activeWorkspace={activeWorkspace}
                detected={detected}
                onClose={() => setShowToolbox(false)}
              />
            </div>
          )}

          {/* Conversation History — explicit view when opened from sidebar */}
          {showHistoryView && (
            <ConversationHistoryView
              currentConvId={currentConvId}
              version={conversationsVersion}
              onSelectConversation={handleSelectConversation}
              initialProjectId={historyProjectId}
            />
          )}

          {showChat && (
            <>
              <ChatView
                steps={steps}
                baseIndex={baseIndex}
                stepCount={stepCount}
                loadingOlder={loadingOlder}
                onLoadOlder={loadOlder}
                stepsLoading={stepsLoading}
                convNotFound={convNotFound}
                currentConvId={currentConvId}
                currentWorkspace={activeWorkspace}
                newChatWorkspaceUri={newChatWorkspaceUri}
                wsVersion={wsVersion}
                cascadeStatus={cascadeStatus ?? undefined}
                onCascadeCreated={handleCascadeCreated}
                onHydrateConversation={(id, syncedSteps, cnt) => {
                  hydrateConversation(id, syncedSteps, cnt);
                  loadConversations();
                }}
                onConversationsUpdated={loadConversations}
                onNewConversation={handleNewChat}
                showTimeline={showTimeline}
                onSetShowTimeline={handleSetShowTimeline}
                showAnalytics={showAnalytics}
                onToggleAnalytics={() => setShowAnalytics(v => !v)}
                onExport={handleExport}
                onShowSettings={isAdmin ? handleShowSettings : undefined}
                detected={detected}
                prefillPrompt={prefillPrompt}
                activeAccountLabel={isAdmin ? (accountBadge?.label || null) : null}
                onOpenAccounts={isAdmin ? handleShowAccountInfo : undefined}
              />

              {/* Step Detail Sheet — lazy-loaded only when opened */}
              {detailOpen && selectedStep !== null && (
                <StepDetail
                  step={steps[selectedStep]}
                  index={selectedStep}
                  open={detailOpen}
                  onClose={() => setDetailOpen(false)}
                  onNavigate={navigateStep}
                  totalSteps={steps.length}
                  isBookmarked={bookmarkedSteps.has(selectedStep)}
                  onToggleBookmark={toggleBookmark}
                />
              )}
            </>
          )}


          {/* PWA Install Banner */}
          {pwaInstall.showBanner && (
            <div className="flex items-center gap-2 px-3 py-2 bg-blue-500/10 border-t border-blue-500/20 flex-shrink-0">
              <Smartphone className="w-4 h-4 text-blue-400 flex-shrink-0" />
              <span className="text-xs text-blue-300 flex-1">
                {pwaInstall.isIOS
                  ? <>点击底部分享图标 <Share2 className="w-3 h-3 inline" /> 后选择“添加到主屏幕”</>
                  : '将应用安装到桌面/主屏幕以获得最佳体验'
                }
              </span>
              {pwaInstall.canInstall && (
                <button
                  onClick={pwaInstall.install}
                  className="text-[10px] font-medium px-2.5 py-1 rounded-md bg-blue-500 text-white hover:bg-blue-400 transition-colors flex-shrink-0"
                >
                  立即安装
                </button>
              )}
              <button onClick={pwaInstall.dismiss} className="text-blue-400/60 hover:text-blue-300 transition-colors flex-shrink-0">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

        </div>{/* end main content */}

        {userDialogOpen && (
          <UserAccountDialog
            open={userDialogOpen}
            onOpenChange={setUserDialogOpen}
            initialTab={userDialogTab}
          />
        )}

        {isAdmin && showWorkspaceOnboard && (
          <WorkspaceOnboardModal
            open={showWorkspaceOnboard}
            suggestedRoot={suggestedWorkspaceRoot}
            onCompleted={() => {
              setShowWorkspaceOnboard(false);
              setWsVersion(v => v + 1);
            }}
          />
        )}
      </div>
      </TooltipProvider>
    </SidebarProvider>
  );
}
