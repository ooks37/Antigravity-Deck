"use client"

import { useState, useEffect, useCallback, useRef, useMemo } from "react"
import { createWorkspace, getProfiles, useOAuthAccount } from "@/lib/cascade-api"
import type { OAuthListResponse, ResourceSnapshot } from "@/lib/cascade-api"
import { loadConversationIndex, groupByProject } from "@/lib/conversations"
import type { Project, ConvRow } from "@/lib/conversations"
import { cn } from "@/lib/utils"
import { useTheme } from "@/lib/theme"
import { API_BASE } from "@/lib/config"
import { authHeaders } from "@/lib/auth"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog"

import {
    Sidebar,
    SidebarContent,
    SidebarFooter,
    SidebarGroup,
    SidebarGroupAction,
    SidebarGroupContent,
    SidebarGroupLabel,
    SidebarHeader,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
    SidebarSeparator,
    useSidebar,
} from "@/components/ui/sidebar"

import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Settings, Users, Check, KeyRound, Plug, ArrowLeftRight, Moon, Sun, Plus, FolderPlus, EllipsisVertical, Activity, FolderSync, Loader2, GitBranch, Monitor, Workflow, Brain, History, MessageSquare } from "lucide-react"

import { ProjectGroup } from "./sidebar/project-group"
import { SystemResourceSummary } from "./sidebar/system-resource-summary"

interface AppSidebarProps {
    currentConvId: string | null
    conversationsVersion: number
    /** Whether Antigravity Language Server is detected by backend */
    detected: boolean
    onSelectConversation: (convId: string | null, wsName: string) => void
    /** Start a fresh conversation (no project/workspace required). */
    onNewConversation: () => void
    /** A new project folder was created — launch straight into a new chat there. */
    onProjectCreated: (name: string) => void
    /** Start a fresh conversation scoped to an existing project's folder. */
    onNewProjectConversation: (project: Project) => void
    onShowAccountInfo: () => void
    onShowSettings: () => void
    onShowLogs: () => void
    onShowSourceControl: () => void
    onShowResources: () => void
    onShowMcp: () => void
    onShowWorkflows: () => void
    onShowMemories: () => void
    onShowRepoInfo: () => void
    /** Open the full Conversation History view, optionally filtered to a project. */
    onShowHistory: (projectId?: string | null) => void
    onGoHome: () => void
    workspaceResources?: ResourceSnapshot | null
    /** Called after a conversation is deleted, with the deleted conv ID */
    onConvDeleted?: (convId: string) => void
}

const LOOSE_LIMIT = 8

export function AppSidebar({
    currentConvId,
    conversationsVersion,
    detected,
    onSelectConversation,
    onNewConversation,
    onProjectCreated,
    onNewProjectConversation,
    onShowAccountInfo,
    onShowSettings,
    onShowLogs,
    onShowSourceControl,
    onShowResources,
    onShowMcp,
    onShowWorkflows,
    onShowMemories,
    onShowRepoInfo,
    onShowHistory,
    onGoHome,
    workspaceResources,
    onConvDeleted,
}: AppSidebarProps) {
    const { isDark, toggle: toggleTheme } = useTheme()
    const { isMobile } = useSidebar()

    const [projects, setProjects] = useState<Project[]>([])
    const [byProject, setByProject] = useState<Map<string, ConvRow[]>>(new Map())
    const [loose, setLoose] = useState<ConvRow[]>([])
    const [loading, setLoading] = useState(true)
    const [expandedMap, setExpandedMap] = useState<Record<string, boolean>>({})

    const [newName, setNewName] = useState("")
    const [creating, setCreating] = useState(false)
    const [createError, setCreateError] = useState("")
    const [showCreateDialog, setShowCreateDialog] = useState(false)

    // User profile & cross-platform multi-account summary
    const [userProfile, setUserProfile] = useState<{ name: string; tier: string; avatar: string | null } | null>(null)
    const [oauthStatus, setOAuthStatus] = useState<OAuthListResponse | null>(null)
    const [ideActiveProfile, setIdeActiveProfile] = useState<string | null>(null)
    const [switchingAlias, setSwitchingAlias] = useState<string | null>(null)

    const hasLoadedRef = useRef(false)
    const didInitExpandRef = useRef(false)

    const nameValidationError = useMemo(() => {
        const trimmed = newName.trim()
        if (!trimmed) return ""
        if (/[/\\:*?"<>|]/.test(trimmed)) return "项目名称包含非法字符"
        if (trimmed.length > 100) return "名称过长（最多 100 个字符）"
        const lower = trimmed.toLowerCase()
        if (projects.some((p) => p.name.toLowerCase() === lower))
            return "同名项目已存在"
        return ""
    }, [newName, projects])

    const fetchAccountSummary = useCallback(() => {
        getProfiles()
            .then(data => {
                setOAuthStatus(data.oauth || null)
                setIdeActiveProfile(data.active || null)
            })
            .catch(() => { })
    }, [])

    // Fetch user profile on mount and when connection is established
    const fetchUserProfile = useCallback(() => {
        fetchAccountSummary()
        if (!detected) {
            setUserProfile(null)
            return
        }
        fetch(`${API_BASE}/api/user/profile`, { headers: authHeaders() })
            .then(r => (r.ok ? r.json() : null))
            .then(d => {
                const u = d?.user
                if (!u) return
                setUserProfile({
                    name: u.name || 'User',
                    tier: u.userTier?.name || u.planStatus?.planInfo?.planName || '',
                    avatar: d.profilePicture || null,
                })
            })
            .catch(() => { })
    }, [detected, fetchAccountSummary])

    useEffect(() => {
        fetchUserProfile()
    }, [fetchUserProfile])

    // Re-fetch profile when IDE or OAuth swap happens
    useEffect(() => {
        const handleIdeSwap = () => {
            fetchAccountSummary()
            const attempts = [5000, 8000, 12000];
            attempts.forEach(delay => setTimeout(() => fetchUserProfile(), delay));
        }
        const handleOAuthSwap = () => {
            fetchAccountSummary()
        }
        window.addEventListener('profile-swapped', handleIdeSwap)
        window.addEventListener('oauth-account-swapped', handleOAuthSwap)
        return () => {
            window.removeEventListener('profile-swapped', handleIdeSwap)
            window.removeEventListener('oauth-account-swapped', handleOAuthSwap)
        }
    }, [fetchUserProfile, fetchAccountSummary])

    const handleQuickSwitchOAuth = useCallback(async (alias: string) => {
        if (switchingAlias) return
        setSwitchingAlias(alias)
        try {
            const res = await useOAuthAccount(alias)
            fetchAccountSummary()
            window.dispatchEvent(new CustomEvent('oauth-account-swapped', { detail: res }))
        } catch {
            // If quick switch fails, open full manager
            onShowAccountInfo()
        } finally {
            setSwitchingAlias(null)
        }
    }, [switchingAlias, fetchAccountSummary, onShowAccountInfo])

    const loadIndex = useCallback(async () => {
        try {
            const { projects: projs, rows } = await loadConversationIndex()
            const { byProject: bp, loose: lo } = groupByProject(rows)
            setProjects(projs)
            setByProject(bp)
            setLoose(lo)
            // Expand the first project once, the first time we get data (AG IDE behaviour).
            if (!didInitExpandRef.current && projs.length > 0) {
                didInitExpandRef.current = true
                setExpandedMap({ [projs[0].id]: true })
            }
        } catch {
            // keep previous state on transient failures
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => {
        if (!hasLoadedRef.current) {
            hasLoadedRef.current = true
            loadIndex()
        }
    }, [loadIndex])

    // Refresh when backend broadcasts conversations_updated via WS
    useEffect(() => {
        if (conversationsVersion > 0) loadIndex()
    }, [conversationsVersion, loadIndex])

    const toggleProject = useCallback((projectId: string) => {
        setExpandedMap((prev) => ({ ...prev, [projectId]: !prev[projectId] }))
    }, [])

    const handleConvDeleted = useCallback(
        (convId: string) => {
            // Optimistically drop from both buckets, then re-fetch for consistency.
            setByProject((prev) => {
                const next = new Map(prev)
                for (const [pid, list] of next) {
                    if (list.some((c) => c.id === convId)) {
                        next.set(pid, list.filter((c) => c.id !== convId))
                    }
                }
                return next
            })
            setLoose((prev) => prev.filter((c) => c.id !== convId))
            onConvDeleted?.(convId)
            loadIndex()
        },
        [loadIndex, onConvDeleted]
    )

    const handleCreateProject = useCallback(async () => {
        const name = newName.trim()
        if (!name || creating || nameValidationError) return
        setCreating(true)
        setCreateError("")
        try {
            const res = await createWorkspace(name, true)
            const createdName = res.workspace?.workspaceName || name
            setNewName("")
            setShowCreateDialog(false)
            await loadIndex()
            onProjectCreated(createdName)
        } catch (e) {
            const msg = e instanceof Error ? e.message : "创建项目失败"
            setCreateError(msg)
        } finally {
            setCreating(false)
        }
    }, [newName, creating, nameValidationError, loadIndex, onProjectCreated])

    // Build the ordered project list with their conversations + total counts.
    const projectRows = useMemo(
        () => projects.map((p) => ({
            project: p,
            conversations: byProject.get(p.id) || [],
            total: p.conversationCount || (byProject.get(p.id) || []).length,
        })),
        [projects, byProject]
    )

    return (
        <>
            <Sidebar variant="inset">
                <SidebarHeader>
                    <button
                        onClick={onGoHome}
                        className="flex items-center gap-2 px-4 py-2 mt-2 hover:opacity-80 transition-opacity cursor-pointer"
                    >
                        <FolderSync className="h-5 w-5 text-primary" />
                        <span className="font-semibold text-lg tracking-tight">Antigravity Deck</span>
                    </button>
                </SidebarHeader>

                {/* System Resource Summary — compact CPU/RAM bars */}
                <div className="px-3 pb-1">
                    <SystemResourceSummary
                        system={workspaceResources?.system}
                        onClick={onShowResources}
                    />
                </div>

                <SidebarContent>
                    <SidebarSeparator className="mx-0" />

                    {/* Top actions: New Conversation + Conversation History */}
                    <SidebarGroup>
                        <SidebarGroupContent>
                            <div className="px-2 pb-1">
                                <Button
                                    size="sm"
                                    onClick={onNewConversation}
                                    className="w-full h-8 text-xs gap-1.5 justify-start"
                                >
                                    <Plus className="h-3.5 w-3.5" />
                                    新建对话
                                </Button>
                            </div>
                            <SidebarMenu>
                                <SidebarMenuItem>
                                    <SidebarMenuButton onClick={() => onShowHistory(null)} tooltip="历史对话" className="text-xs">
                                        <History className="shrink-0" />
                                        <span>历史对话</span>
                                    </SidebarMenuButton>
                                </SidebarMenuItem>
                            </SidebarMenu>
                        </SidebarGroupContent>
                    </SidebarGroup>

                    <SidebarSeparator className="mx-0" />

                    {/* Projects */}
                    <SidebarGroup>
                        <SidebarGroupLabel>项目列表</SidebarGroupLabel>
                        <SidebarGroupAction title="新建项目" onClick={() => setShowCreateDialog(true)}>
                            <Plus /> <span className="sr-only">新建项目</span>
                        </SidebarGroupAction>
                        <SidebarGroupContent>
                            {loading && projectRows.length === 0 && (
                                <div className="px-3 py-4 text-xs text-muted-foreground text-center">加载中...</div>
                            )}
                            {!loading && projectRows.length === 0 && (
                                <div className="px-3 py-3 text-[11px] text-muted-foreground/50 text-center">
                                    暂无项目。请在 Antigravity 中打开文件夹，或点击右上角 ＋ 新建。
                                </div>
                            )}
                            {projectRows.map(({ project, conversations, total }) => (
                                <ProjectGroup
                                    key={project.id}
                                    name={project.name}
                                    totalCount={total}
                                    conversations={conversations}
                                    currentConvId={currentConvId}
                                    expanded={!!expandedMap[project.id]}
                                    onToggle={() => toggleProject(project.id)}
                                    onSelectConv={(convId) => onSelectConversation(convId, project.name)}
                                    onSeeAll={() => onShowHistory(project.id)}
                                    onNewConversation={() => onNewProjectConversation(project)}
                                    onDeleted={handleConvDeleted}
                                />
                            ))}
                        </SidebarGroupContent>
                    </SidebarGroup>

                    {/* Loose conversations (no project) */}
                    {loose.length > 0 && (
                        <>
                            <SidebarSeparator className="mx-0" />
                            <SidebarGroup>
                                <SidebarGroupLabel>独立对话</SidebarGroupLabel>
                                <SidebarGroupContent>
                                    <SidebarMenu>
                                        {loose.slice(0, LOOSE_LIMIT).map((conv) => (
                                            <SidebarMenuItem key={conv.id}>
                                                <SidebarMenuButton
                                                    isActive={conv.id === currentConvId}
                                                    onClick={() => onSelectConversation(conv.id, conv.projectName || 'unknown')}
                                                    tooltip={conv.title}
                                                    className="text-xs"
                                                >
                                                    <MessageSquare className="shrink-0" />
                                                    <span className="truncate min-w-0">{conv.title}</span>
                                                </SidebarMenuButton>
                                            </SidebarMenuItem>
                                        ))}
                                        {loose.length > LOOSE_LIMIT && (
                                            <SidebarMenuItem>
                                                <SidebarMenuButton
                                                    onClick={() => onShowHistory(null)}
                                                    className="text-sidebar-foreground/50 text-[10px]"
                                                >
                                                    查看全部 ({loose.length})
                                                </SidebarMenuButton>
                                            </SidebarMenuItem>
                                        )}
                                    </SidebarMenu>
                                </SidebarGroupContent>
                            </SidebarGroup>
                        </>
                    )}

                    {/* Tools (kept Deck features) */}
                    <SidebarSeparator className="mx-0" />
                    <SidebarGroup>
                        <SidebarGroupContent>
                            <SidebarMenu>
                                <SidebarMenuItem>
                                    <SidebarMenuButton onClick={onShowMcp} tooltip="MCP 服务" className="text-xs">
                                        <Plug className="shrink-0" />
                                        <span>MCP 服务</span>
                                    </SidebarMenuButton>
                                </SidebarMenuItem>
                                <SidebarMenuItem>
                                    <SidebarMenuButton onClick={onShowWorkflows} tooltip="工作流与技能" className="text-xs">
                                        <Workflow className="shrink-0" />
                                        <span>工作流</span>
                                    </SidebarMenuButton>
                                </SidebarMenuItem>
                                <SidebarMenuItem>
                                    <SidebarMenuButton onClick={onShowMemories} tooltip="长期记忆" className="text-xs">
                                        <Brain className="shrink-0" />
                                        <span>记忆库</span>
                                    </SidebarMenuButton>
                                </SidebarMenuItem>
                                <SidebarMenuItem>
                                    <SidebarMenuButton onClick={onShowRepoInfo} tooltip="仓库信息" className="text-xs">
                                        <GitBranch className="shrink-0" />
                                        <span>仓库信息</span>
                                    </SidebarMenuButton>
                                </SidebarMenuItem>
                            </SidebarMenu>
                        </SidebarGroupContent>
                    </SidebarGroup>
                </SidebarContent>

                <SidebarFooter>
                    <SidebarMenu>
                        <SidebarMenuItem>
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <SidebarMenuButton
                                        size="lg"
                                        className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                                    >
                                        <div className="relative">
                                            <Avatar className="h-8 w-8 rounded-lg">
                                                {userProfile?.avatar && (
                                                    <AvatarImage src={`data:image/png;base64,${userProfile.avatar}`} alt={userProfile.name} />
                                                )}
                                                <AvatarFallback className={cn(
                                                    "rounded-lg text-xs font-semibold",
                                                    (detected || oauthStatus?.activeEmail || ideActiveProfile)
                                                        ? "bg-indigo-500/20 text-indigo-400"
                                                        : "bg-muted text-muted-foreground"
                                                )}>
                                                    {(userProfile?.name || oauthStatus?.activeAlias || oauthStatus?.activeName || ideActiveProfile || '?')[0]?.toUpperCase()}
                                                </AvatarFallback>
                                            </Avatar>
                                            {(oauthStatus?.activeEmail || detected) && (
                                                <span className={cn(
                                                    "absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-sidebar",
                                                    detected ? "bg-emerald-400" : "bg-sky-400"
                                                )} />
                                            )}
                                        </div>
                                        <div className="grid flex-1 text-left text-sm leading-tight">
                                            <span className="truncate font-medium text-xs">
                                                {userProfile?.name
                                                    ?? oauthStatus?.activeAlias
                                                    ?? oauthStatus?.activeName
                                                    ?? ideActiveProfile
                                                    ?? (detected ? '加载中...' : '未选择账号')}
                                            </span>
                                            <span className="truncate text-[10px] text-sidebar-foreground/60">
                                                {userProfile?.tier
                                                    || oauthStatus?.activeEmail
                                                    || (oauthStatus?.accounts?.length
                                                        ? `已保存 ${oauthStatus.accounts.length} 个 OAuth 账号`
                                                        : (detected ? '在线' : '点击切换或导入账号'))}
                                            </span>
                                        </div>
                                        <EllipsisVertical className="ml-auto size-4" />
                                    </SidebarMenuButton>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent
                                    side={isMobile ? "bottom" : "right"}
                                    align="end"
                                    sideOffset={4}
                                    className="w-[--radix-dropdown-menu-trigger-width] min-w-60 rounded-lg"
                                >
                                    <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground truncate">
                                        {oauthStatus?.activeEmail
                                            ? `当前 OAuth: ${oauthStatus.activeEmail}`
                                            : (ideActiveProfile ? `当前档案: ${ideActiveProfile}` : '多账号切换中心')}
                                    </DropdownMenuLabel>
                                    <DropdownMenuItem onClick={onShowAccountInfo}>
                                        <Users className="mr-2 h-4 w-4 text-indigo-400" />
                                        <span>多账号管理与配额</span>
                                    </DropdownMenuItem>
                                    {oauthStatus && oauthStatus.accounts.length > 0 && (
                                        <DropdownMenuSub>
                                            <DropdownMenuSubTrigger>
                                                <ArrowLeftRight className="mr-2 h-4 w-4 text-emerald-400" />
                                                <span>快速切换 OAuth ({oauthStatus.accounts.length})</span>
                                            </DropdownMenuSubTrigger>
                                            <DropdownMenuSubContent className="min-w-52 max-h-72 overflow-y-auto">
                                                {oauthStatus.accounts.map((acc) => (
                                                    <DropdownMenuItem
                                                        key={acc.alias}
                                                        disabled={switchingAlias !== null}
                                                        onClick={() => handleQuickSwitchOAuth(acc.alias)}
                                                        className="flex items-center justify-between gap-2"
                                                    >
                                                        <div className="min-w-0 flex-1">
                                                            <div className="text-xs font-medium truncate flex items-center gap-1">
                                                                <KeyRound className="h-3 w-3 shrink-0 text-muted-foreground" />
                                                                <span className="truncate">{acc.alias}</span>
                                                            </div>
                                                            {acc.email && (
                                                                <div className="text-[10px] text-muted-foreground truncate pl-4">{acc.email}</div>
                                                            )}
                                                        </div>
                                                        {switchingAlias === acc.alias ? (
                                                            <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
                                                        ) : acc.isActive ? (
                                                            <Check className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                                                        ) : null}
                                                    </DropdownMenuItem>
                                                ))}
                                                <DropdownMenuSeparator />
                                                <DropdownMenuItem onClick={onShowAccountInfo}>
                                                    <Plus className="mr-2 h-3.5 w-3.5" />
                                                    <span className="text-xs">导入 / 管理全部账号...</span>
                                                </DropdownMenuItem>
                                            </DropdownMenuSubContent>
                                        </DropdownMenuSub>
                                    )}
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem onClick={onShowLogs} disabled={!detected}>
                                        <Activity className="mr-2 h-4 w-4" />
                                        <span>实时日志</span>
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={onShowSourceControl} disabled={!detected}>
                                        <GitBranch className="mr-2 h-4 w-4" />
                                        <span>源代码管理</span>
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={onShowResources}>
                                        <Monitor className="mr-2 h-4 w-4" />
                                        <span>系统资源监控</span>
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={toggleTheme}>
                                        {isDark ? <Sun className="mr-2 h-4 w-4" /> : <Moon className="mr-2 h-4 w-4" />}
                                        <span>{isDark ? "浅色模式" : "深色模式"}</span>
                                    </DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem onClick={onShowSettings}>
                                        <Settings className="mr-2 h-4 w-4" />
                                        <span>应用设置</span>
                                    </DropdownMenuItem>
                                </DropdownMenuContent>
                            </DropdownMenu>
                        </SidebarMenuItem>
                    </SidebarMenu>
                </SidebarFooter>
            </Sidebar>

            <Dialog open={showCreateDialog} onOpenChange={(open) => {
                setShowCreateDialog(open)
                if (!open) { setNewName(""); setCreateError("") }
            }}>
                <DialogContent className="sm:max-w-[420px]">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <FolderPlus className="h-5 w-5" />
                            新建项目
                        </DialogTitle>
                        <DialogDescription>
                            在默认工作区下创建新的项目目录并立即开启对话。
                        </DialogDescription>
                    </DialogHeader>

                    <div className="space-y-4 py-2">
                        <div className="space-y-2.5">
                            <label className="text-xs font-medium text-muted-foreground">项目名称</label>
                            <Input
                                value={newName}
                                onChange={(e) => { setNewName(e.target.value); setCreateError("") }}
                                onKeyDown={(e) => e.key === "Enter" && !nameValidationError && handleCreateProject()}
                                placeholder="my-awesome-project"
                                className={cn(nameValidationError && newName.trim() && "border-destructive focus-visible:ring-destructive")}
                                disabled={creating}
                                autoFocus
                            />
                            {(nameValidationError || createError) && newName.trim() && (
                                <p className="text-xs text-destructive">{nameValidationError || createError}</p>
                            )}
                            <p className="text-xs text-muted-foreground">
                                将在你的工作区根目录下创建文件夹、自动打开并创建新会话。
                            </p>
                        </div>
                    </div>

                    <DialogFooter>
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => { setShowCreateDialog(false); setNewName(""); setCreateError("") }}
                            disabled={creating}
                        >
                            取消
                        </Button>
                        <Button
                            size="sm"
                            onClick={async () => { await handleCreateProject() }}
                            disabled={creating || !newName.trim() || !!nameValidationError}
                        >
                            {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Plus className="h-3.5 w-3.5 mr-1.5" />}
                            创建项目
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    )
}
