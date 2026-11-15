'use client';

import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import dynamic from 'next/dynamic';
import { useWebSocket } from '@/lib/websocket';
import { extractStepContent, exportToMarkdown } from '@/lib/step-utils';
import { Timeline } from '@/components/timeline';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { MoreVertical, BarChart2, Download, Bell, BellOff, FolderSync, Star, WifiOff, Rocket, Loader2, Check, Smartphone, Share2, X, Users, Settings, KeyRound, Network, RotateCw, Power, Wrench } from 'lucide-react';
import { API_BASE } from '@/lib/config';
import { authHeaders } from '@/lib/auth';
import type { Project } from '@/lib/conversations';
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
import { SidebarTrigger } from '@/components/ui/sidebar';
import { AccountInfoView } from '@/components/user-profile';
import { SettingsView } from '@/components/settings-view';
import { AuthGate } from '@/components/auth-gate';
import { AgentLogsView } from '@/components/agent-logs-view';
import { SourceControlView } from '@/components/source-control-view';
import { ResourceMonitorView } from '@/components/resource-monitor-view';
import { ConversationHistoryView } from '@/components/conversation-history-view';
import { WorkspaceOnboardModal } from '@/components/workspace-onboard-modal';
import type { ToolboxTab } from '@/components/toolbox-drawer';
import { notificationService } from '@/lib/notifications';
import { initAppLogger } from '@/lib/app-logger';
import { usePwaInstall } from '@/hooks/use-pwa-install';
import { getSettings, getProfiles, getProxyState, useProxyNode, rotateProxyNode, type ProxyState, type FleetServer } from '@/lib/cascade-api';


// Lazy-load components that are hidden by default
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

/** Button to launch the Antigravity IDE from the welcome screen. */
function LaunchIdeButton() {
  const [state, setState] = useState<'idle' | 'launching' | 'launched'>('idle');

  const handleLaunch = useCallback(async () => {
    if (state !== 'idle') return;
    setState('launching');
    try {
      await fetch(`${API_BASE}/api/launch-ide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
      });
      setState('launched');
      // Reset after 15s cooldown
      setTimeout(() => setState('idle'), 15000);
    } catch {
      setState('idle');
    }
  }, [state]);

  return (
    <button
      onClick={handleLaunch}
      disabled={state !== 'idle'}
      className={`inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 ${
        state === 'launched'
          ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 cursor-default'
          : state === 'launching'
            ? 'bg-primary/10 text-primary border border-primary/30 cursor-wait'
            : 'bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25 hover:border-primary/50 cursor-pointer'
      }`}
    >
      {state === 'launched' ? (
        <><Check className="w-4 h-4" /> 已启动 — 正在等待连接...</>
      ) : state === 'launching' ? (
        <><Loader2 className="w-4 h-4 animate-spin" /> 正在启动...</>
      ) : (
        <><Rocket className="w-4 h-4" /> 启动 Antigravity</>
      )}
    </button>
  );
}

export default function Home() {
  const { connected, detected, swapping, steps, baseIndex, stepCount, loadingOlder, stepsLoading, convNotFound, conversations, currentConvId, cascadeStatus, conversationsVersion, stepContentVersion, workspaceResources, selectConversation, lastUpdate, loadOlder } = useWebSocket();

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

  const refreshAccountBadge = useCallback(() => {
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
  }, []);

  const refreshProxyState = useCallback(() => {
    getProxyState()
      .then((d) => setProxyState(d))
      .catch(() => { /* keep previous */ });
  }, []);

  useEffect(() => {
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
  }, [refreshAccountBadge, refreshProxyState]);

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
  // Target fleet server selected from sidebar quick-view
  const [targetServer, setTargetServer] = useState<FleetServer | null>(null);
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
  useEffect(() => { localStorage.setItem('antigravity-show-settings', JSON.stringify(showSettings)); }, [showSettings]);
  useEffect(() => { localStorage.setItem('antigravity-show-account-info', JSON.stringify(showAccountInfo)); }, [showAccountInfo]);
  useEffect(() => { localStorage.setItem('antigravity-show-logs', JSON.stringify(showLogs)); }, [showLogs]);
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
    // Check if onboarding is needed
    getSettings().then(settings => {
      if (!settings.defaultWorkspaceRoot) {
        setSuggestedWorkspaceRoot((settings as any).suggestedWorkspaceRoot || '');
        setShowWorkspaceOnboard(true);
      }
    }).catch(console.error);

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // run once on mount

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
    setTargetServer(null);
    setNewChatWorkspaceUri(null);
    setNewChatMode(true);
  }, [selectConversation, resetPanels]);

  // === New Conversation (top action) — fresh chat against the hub, no project context ===
  const handleNewConversation = useCallback(() => {
    selectConversation(null);
    resetPanels();
    setActiveWorkspace(null);
    setHistoryProjectId(null);
    setTargetServer(null);
    setNewChatWorkspaceUri(null);
    setNewChatMode(true);
  }, [selectConversation, resetPanels]);

  // === New Project created — open it and start a fresh chat there ===
  const handleProjectCreated = useCallback((name: string) => {
    selectConversation(null);
    resetPanels();
    setHistoryProjectId(null);
    setActiveWorkspace(name);
    setNewChatWorkspaceUri(null);
    setNewChatMode(true);
  }, [selectConversation, resetPanels]);

  // === New conversation in an existing project — scope it to the project folder ===
  const handleNewProjectConversation = useCallback((project: Project) => {
    selectConversation(null);
    resetPanels();
    setHistoryProjectId(null);
    setActiveWorkspace(project.name);
    setNewChatWorkspaceUri(project.folderUri || null);
    setNewChatMode(true);
  }, [selectConversation, resetPanels]);

  // === Show account info in main panel ===
  const handleShowAccountInfo = useCallback(() => {
    selectConversation(null);
    resetPanels();
    setActiveWorkspace(null);
    setShowAccountInfo(true);
  }, [selectConversation, resetPanels]);

  // === Show settings in main panel ===
  const handleShowSettings = useCallback(() => {
    selectConversation(null);
    resetPanels();
    setActiveWorkspace(null);
    setShowSettings(true);
  }, [selectConversation, resetPanels]);

  // === Show Live Logs ===
  const handleShowLogs = useCallback(() => {
    selectConversation(null);
    resetPanels();
    setActiveWorkspace(null);
    setShowLogs(true);
  }, [selectConversation, resetPanels]);

  // === Show Source Control / IDE ===
  const handleShowSourceControl = useCallback(() => {
    selectConversation(null);
    resetPanels();
    setShowSourceControl(true);
  }, [selectConversation, resetPanels]);

  // === Show Resources ===
  const handleShowResources = useCallback(() => {
    selectConversation(null);
    resetPanels();
    setActiveWorkspace(null);
    setShowResources(true);
  }, [selectConversation, resetPanels]);

  // === Show MCP Servers ===
  const handleShowMcp = useCallback(() => {
    selectConversation(null);
    resetPanels();
    setActiveWorkspace(null);
    setShowMcp(true);
  }, [selectConversation, resetPanels]);

  // === Show Workflows / Skills / Rules ===
  const handleShowWorkflows = useCallback(() => {
    selectConversation(null);
    resetPanels();
    setActiveWorkspace(null);
    setShowWorkflows(true);
  }, [selectConversation, resetPanels]);

  // === Show Memories (knowledge items) ===
  const handleShowMemories = useCallback(() => {
    selectConversation(null);
    resetPanels();
    setActiveWorkspace(null);
    setShowMemories(true);
  }, [selectConversation, resetPanels]);

  // === Show Repo Info ===
  const handleShowRepoInfo = useCallback(() => {
    selectConversation(null);
    resetPanels();
    setActiveWorkspace(null);
    setShowRepoInfo(true);
  }, [selectConversation, resetPanels]);

  // === Show Conversation History view, optionally filtered to a project ===
  const handleShowHistory = useCallback((projectId: string | null = null) => {
    selectConversation(null);
    resetPanels();
    setActiveWorkspace(null);
    setHistoryProjectId(projectId);
    setShowHistoryPage(true);
  }, [selectConversation, resetPanels]);

  // === Go Home — reset to the default Doubao New Chat view ===
  const handleGoHome = useCallback(() => {
    selectConversation(null);
    setActiveWorkspace(null);
    setHistoryProjectId(null);
    setTargetServer(null);
    resetPanels();
    setNewChatMode(true);
  }, [selectConversation, resetPanels]);

  // === Open Consolidated IDE Toolbox ===
  const handleShowToolbox = useCallback((tab: ToolboxTab = 'mcp') => {
    selectConversation(null);
    resetPanels();
    setToolboxTab(tab);
    setShowToolbox(true);
  }, [selectConversation, resetPanels]);

  // === Select target fleet server from sidebar ===
  const handleSelectServer = useCallback((server: FleetServer) => {
    selectConversation(null);
    resetPanels();
    setActiveWorkspace(null);
    setHistoryProjectId(null);
    setNewChatWorkspaceUri(null);
    setTargetServer(server);
    setPrefillPrompt({
      text: `请通过 baota-hub 检查服务器 ${server.id}${server.name ? ` (${server.name})` : ''}${server.ip ? ` [${server.ip}]` : ''} 的运行状态、CPU/内存/磁盘及当前服务列表。`,
      seq: Date.now(),
    });
    setNewChatMode(true);
  }, [selectConversation, resetPanels]);

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

  // Current conversation info for header display
  const currentConvInfo = currentConvId ? conversations[currentConvId] : null;

  // === Determine what to show in main panel ===
  const anyOverlay = showAccountInfo || showSettings || showLogs || showSourceControl || showResources || showMcp || showWorkflows || showMemories || showRepoInfo || showToolbox;
  // Doubao UX: land directly on ChatView (even while LS reconnects so agy CLI / controls remain usable)
  const showHistoryView = showHistoryPage && !anyOverlay && currentConvId === null;
  const showChat = !anyOverlay && !showHistoryView;

  return (
    <AuthGate>
      <div className="flex h-dvh w-full bg-background text-foreground overflow-hidden">
        {/* Shadcn App Sidebar */}
        <AppSidebar
          currentConvId={currentConvId}
          conversationsVersion={conversationsVersion}
          detected={detected}
          workspaceResources={workspaceResources}
          onSelectConversation={handleSelectConversation}
          onNewConversation={handleNewConversation}
          onProjectCreated={handleProjectCreated}
          onNewProjectConversation={handleNewProjectConversation}
          onShowAccountInfo={handleShowAccountInfo}
          onShowSettings={handleShowSettings}
          onShowLogs={handleShowLogs}
          onShowSourceControl={handleShowSourceControl}
          onShowResources={handleShowResources}
          onShowMcp={handleShowMcp}
          onShowWorkflows={handleShowWorkflows}
          onShowMemories={handleShowMemories}
          onShowRepoInfo={handleShowRepoInfo}
          onShowHistory={handleShowHistory}
          onGoHome={handleGoHome}
          onConvDeleted={handleConvDeleted}
          onSelectServer={handleSelectServer}
          onShowToolbox={() => handleShowToolbox()}
        />

        {/* Main content */}
        <div className="flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden pwa-main-content">
          {/* Topbar */}
          <header className="flex items-center justify-between px-2 sm:px-4 h-11 bg-background border-b border-border flex-shrink-0">
            <div className="flex items-center gap-2 sm:gap-3 min-w-0">
              {/* Hamburger — provided by Shadcn SidebarTrigger */}
              <SidebarTrigger className="-ml-1 w-9 h-9" />
              <div className="flex items-center gap-1.5 cursor-pointer" onClick={handleGoHome} title="返回新建对话">
                <FolderSync className="w-4 h-4 text-primary" />
                {activeWorkspace ? (
                  <span className="font-semibold text-sm truncate max-w-[120px] sm:max-w-[200px]">{activeWorkspace}</span>
                ) : (
                  <>
                    <span className="font-semibold text-sm">Antigravity 工作台</span>
                    <Badge variant="outline" className="text-[9px] h-4 px-1 font-mono inline-flex">Cloud</Badge>
                  </>
                )}
              </div>
              {currentConvId && (
                <>
                  <div className="w-px h-5 bg-border hidden sm:block" />
                  <span className="text-xs text-muted-foreground truncate max-w-[120px] sm:max-w-[300px]">
                    {currentConvInfo?.summary || currentConvId.substring(0, 8)}
                  </span>
                  <span className="text-[10px] text-muted-foreground/60 hidden sm:inline">
                    ({steps.length || currentConvInfo?.stepCount || 0} 步)
                  </span>
                </>
              )}
            </div>

            <div className="flex items-center gap-1.5 sm:gap-3">

              {bookmarkedSteps.size > 0 && (
                <Badge variant="secondary" className="text-[10px] hidden sm:inline-flex gap-1"><Star className="w-3 h-3" /> {bookmarkedSteps.size}</Badge>
              )}
              {showChat && <span className="text-xs text-muted-foreground font-mono hidden md:inline">{steps.length > 0 ? `${steps.length} 步` : ''}</span>}
              {lastUpdate && <span className="text-xs text-muted-foreground hidden md:inline">{lastUpdate}</span>}
              {/* Status & Quick Account Bar */}
              <div className="flex items-center gap-1.5">
                {/* Quick Proxy Switcher */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      disabled={proxyBusy}
                      title={
                        proxyState?.enabled && proxyState?.activeNode
                          ? `出口代理: ${proxyState.activeNode.name} (${proxyState.activeNode.lastTest?.exitIp || `${proxyState.activeNode.host}:${proxyState.activeNode.port}`}) — 点击切换 IP`
                          : '当前直连（点击切换 SOCKS5h/HTTP 出口代理）'
                      }
                      className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border transition-colors cursor-pointer ${
                        proxyState?.enabled && proxyState?.activeNode
                          ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40 hover:bg-emerald-500/25'
                          : 'bg-muted/40 hover:bg-muted text-muted-foreground border-border/50'
                      }`}
                    >
                      {proxyBusy ? (
                        <Loader2 className="w-3 h-3 animate-spin text-emerald-400" />
                      ) : (
                        <Network className={`w-3 h-3 ${proxyState?.enabled && proxyState?.activeNode ? 'text-emerald-400' : 'text-muted-foreground'}`} />
                      )}
                      <span className="max-w-[90px] truncate hidden sm:inline">
                        {proxyState?.enabled && proxyState?.activeNode ? proxyState.activeNode.name : '直连'}
                      </span>
                      {proxyState?.enabled && proxyState?.activeNode?.lastTest?.exitIp && (
                        <span className="text-[9px] text-emerald-300/80 hidden lg:inline font-mono">
                          {proxyState.activeNode.lastTest.exitIp}
                        </span>
                      )}
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-60 text-xs">
                    <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
                      {proxyState?.enabled && proxyState?.activeNode
                        ? `当前出口: ${proxyState.activeNode.name} (${proxyState.activeNode.lastTest?.exitIp || `${proxyState.activeNode.host}:${proxyState.activeNode.port}`})`
                        : '当前模式: 本机直连（无代理）'}
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() => handleSwitchProxy(null)}
                      className="text-xs justify-between cursor-pointer"
                    >
                      <span className="flex items-center gap-1.5">
                        <Power className="w-3.5 h-3.5 text-muted-foreground" />
                        直连（不使用代理）
                      </span>
                      {!proxyState?.enabled && <Check className="w-3.5 h-3.5 text-emerald-400" />}
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
                        {proxyState.enabled && proxyState.activeNodeId === node.id && <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />}
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuSeparator />
                    {proxyState && proxyState.nodes.length > 0 && (
                      <DropdownMenuItem onClick={handleRotateProxy} className="text-xs gap-1.5 cursor-pointer">
                        <RotateCw className="w-3.5 h-3.5 text-sky-400" />
                        一键换下一个 IP
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onClick={handleShowSettings} className="text-xs gap-1.5 cursor-pointer">
                      <Settings className="w-3.5 h-3.5 text-muted-foreground" />
                      管理代理与测速...
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>

                <button
                  onClick={() => handleShowToolbox()}
                  title="打开扩展工具箱（MCP / 工作流 / 记忆库 / 监控 / 日志 / Git）"
                  className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border transition-colors cursor-pointer ${
                    showToolbox
                      ? 'bg-primary/15 text-primary border-primary/40'
                      : 'bg-muted/40 hover:bg-muted text-foreground/80 border-border/50'
                  }`}
                >
                  <Wrench className="w-3 h-3 text-muted-foreground" />
                  <span className="hidden sm:inline">工具箱</span>
                </button>

                <button
                  onClick={handleShowAccountInfo}
                  title={accountBadge?.email ? `当前账号: ${accountBadge.email}（点击切换/管理）` : '点击打开多账号管理与配额'}
                  className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border transition-colors cursor-pointer ${
                    showAccountInfo
                      ? 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-300 border-indigo-500/40'
                      : 'bg-muted/40 hover:bg-muted text-foreground/80 border-border/50'
                  }`}
                >
                  <Users className="w-3 h-3 text-indigo-500 dark:text-indigo-400" />
                  <span className="max-w-[90px] truncate hidden sm:inline">
                    {accountBadge?.label || '多账号'}
                  </span>
                  {accountBadge && accountBadge.total > 0 && (
                    <span className="text-[9px] text-muted-foreground hidden md:inline">({accountBadge.total})</span>
                  )}
                </button>
                {/* WebSocket connection status */}
                <div className={`flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium ${connected ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20' : 'bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20'}`}>
                  <div className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-emerald-500 dark:bg-emerald-400' : 'bg-red-500 dark:bg-red-400'}`} />
                  <span>WS</span>
                </div>
                {/* Language Server detection status */}
                <div className={`flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium ${detected ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20' : connected ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20' : 'bg-muted text-muted-foreground border border-border/30'}`}>
                  <div className={`w-1.5 h-1.5 rounded-full ${detected ? 'bg-emerald-500 dark:bg-emerald-400' : connected ? 'bg-amber-500 dark:bg-amber-400 animate-pulse' : 'bg-muted-foreground/50'}`} />
                  <span>{detected ? 'LS 已连接' : connected ? '探测中...' : 'LS 离线'}</span>
                </div>
              </div>
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

          {/* Analytics — always mounted when data available, animate open/close */}
          {currentConvId && steps.length > 0 && (
            <div className={`grid transition-all duration-200 ease-in-out ${showAnalytics ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
              <div className="overflow-hidden">
                <AnalyticsPanel steps={steps} />
              </div>
            </div>
          )}

          {/* === Main panel status strip when LS is offline/reloading (non-blocking) === */}
          {!detected && !anyOverlay && (
            <div className="px-3 sm:px-5 py-2 bg-amber-500/10 border-b border-amber-500/20 flex flex-wrap items-center justify-between gap-2 text-xs">
              {swapping ? (
                <div className="flex items-center gap-2 text-amber-700 dark:text-amber-300">
                  <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                  <span>正在切换账号并热重载 Antigravity Hub（约 3 秒）...</span>
                </div>
              ) : (
                <div className="flex items-center gap-2 text-amber-700 dark:text-amber-300 min-w-0">
                  <WifiOff className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate">
                    Antigravity Hub 暂未连接，可先使用下方 <strong>agy 直连</strong> 或切换 / 检查多账号状态
                  </span>
                </div>
              )}
              {!swapping && (
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={handleShowAccountInfo}
                    className="px-2.5 py-1 rounded-md bg-indigo-500/15 hover:bg-indigo-500/25 text-indigo-700 dark:text-indigo-300 border border-indigo-500/30 font-medium cursor-pointer"
                  >
                    多账号切换
                  </button>
                  <button
                    onClick={handleShowSettings}
                    className="px-2.5 py-1 rounded-md bg-muted/60 hover:bg-muted text-foreground/80 border border-border/50 font-medium cursor-pointer"
                  >
                    设置
                  </button>
                  <span className="hidden md:inline-flex scale-90 origin-right">
                    <LaunchIdeButton />
                  </span>
                </div>
              )}
            </div>
          )}

          {showAccountInfo && (
            <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
              {!detected && (
                <div className="px-6 py-2 bg-amber-500/10 border-b border-amber-500/20 flex items-center justify-between text-xs text-amber-700 dark:text-amber-300">
                  <span>当前尚未检测到运行中的 Antigravity Hub，你仍可在此零延迟切换、导入与管理全部 OAuth 账号并自动热重载。</span>
                  <button
                    onClick={handleGoHome}
                    className="underline hover:opacity-80 flex-shrink-0 ml-3 cursor-pointer"
                  >
                    返回工作台
                  </button>
                </div>
              )}
              <AccountInfoView detected={detected} onBackHome={handleGoHome} />
            </div>
          )}

          {showSettings && (
            <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
              {!detected && (
                <div className="px-6 py-2 bg-amber-500/10 border-b border-amber-500/20 flex items-center justify-between text-xs text-amber-700 dark:text-amber-300">
                  <span>当前尚未检测到运行中的 Antigravity Hub，你仍可在此配置路径、守卫策略与登录密码。</span>
                  <button
                    onClick={handleGoHome}
                    className="underline hover:opacity-80 flex-shrink-0 ml-3 cursor-pointer"
                  >
                    返回工作台
                  </button>
                </div>
              )}
              <SettingsView />
            </div>
          )}

          {/* Always mounted — WS stays alive, events accumulate in background */}
          <div className={detected && showLogs ? 'flex flex-col flex-1 min-h-0 overflow-hidden' : 'hidden'}>
            <AgentLogsView />
          </div>

          {/* Source Control / IDE panel */}
          {showSourceControl && (
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
          {showResources && (
            <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
              <ResourceMonitorView />
            </div>
          )}

          {/* MCP Servers panel */}
          {showMcp && (
            <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
              <McpView />
            </div>
          )}

          {/* Workflows / Skills / Rules panel */}
          {showWorkflows && (
            <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
              <WorkflowsView />
            </div>
          )}

          {/* Memories (knowledge items) panel */}
          {showMemories && (
            <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
              <MemoriesView />
            </div>
          )}

          {/* Repo Info panel */}
          {showRepoInfo && (
            <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
              <RepoInfoView />
            </div>
          )}

          {/* Consolidated Toolbox drawer/view */}
          {showToolbox && (
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
                onNewConversation={handleNewChat}
                showTimeline={showTimeline}
                onSetShowTimeline={handleSetShowTimeline}
                showAnalytics={showAnalytics}
                onToggleAnalytics={() => setShowAnalytics(v => !v)}
                onExport={handleExport}
                onShowSettings={handleShowSettings}
                detected={detected}
                targetServer={targetServer}
                onClearTargetServer={() => setTargetServer(null)}
                prefillPrompt={prefillPrompt}
                activeAccountLabel={accountBadge?.label || null}
                onOpenAccounts={handleShowAccountInfo}
              />

              {/* Step Detail Sheet */}
              <StepDetail
                step={selectedStep !== null ? steps[selectedStep] : null}
                index={selectedStep ?? 0}
                open={detailOpen}
                onClose={() => setDetailOpen(false)}
                onNavigate={navigateStep}
                totalSteps={steps.length}
                isBookmarked={selectedStep !== null ? bookmarkedSteps.has(selectedStep) : false}
                onToggleBookmark={toggleBookmark}
              />
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

          {/* Footer */}
          <footer className="flex items-center justify-between px-2 sm:px-4 h-8 bg-background border-t border-border flex-shrink-0 text-[10px] text-muted-foreground/60">
            <div className="flex items-center gap-2 sm:gap-3">
              <span><FolderSync className="w-3 h-3 inline-block mr-1" />Antigravity Deck 中文版</span>
              <span className="w-px h-3 bg-border hidden sm:block" />
              <span className="hidden sm:inline">远程控制台</span>
            </div>
            <div className="flex items-center gap-2 sm:gap-3">
              <button onClick={() => setShowShortcuts(v => !v)}
                className="flex items-center gap-1 hover:text-foreground transition-colors">
                <kbd className="px-1 py-0.5 bg-muted/50 rounded text-[9px] font-mono">?</kbd>
                <span>快捷键</span>
              </button>
            </div>
          </footer>
        </div>{/* end main content */}

        <WorkspaceOnboardModal
          open={showWorkspaceOnboard}
          suggestedRoot={suggestedWorkspaceRoot}
          onCompleted={(root) => {
            setShowWorkspaceOnboard(false);
            // Optionally force a refresh to pick up the new workspace root
            setWsVersion(v => v + 1);
          }}
        />
      </div>
    </AuthGate>
  );
}
