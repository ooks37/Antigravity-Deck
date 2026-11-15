"use client"

import { useState, useEffect, useCallback, useRef, useMemo } from "react"
import { loadConversationIndex, groupByTimeBucket, renameConversation, deleteConversation } from "@/lib/conversations"
import type { Project, ConvRow } from "@/lib/conversations"
import { cn } from "@/lib/utils"
import { useTheme } from "@/lib/theme"
import { useAuthUser } from "@/components/auth-gate"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
    Sidebar,
    SidebarContent,
    SidebarFooter,
    SidebarGroup,
    SidebarGroupContent,
    SidebarGroupLabel,
    SidebarHeader,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
    useSidebar,
} from "@/components/ui/sidebar"
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
    Check,
    ChevronsUpDown,
    History,
    KeyRound,
    Loader2,
    LogOut,
    MessageSquare,
    Moon,
    Pencil,
    Plus,
    Search,
    Settings,
    Shield,
    Sun,
    Trash2,
    Users,
    Wrench,
    X,
} from "lucide-react"

interface AppSidebarProps {
    currentConvId: string | null
    conversationsVersion: number
    detected?: boolean
    onSelectConversation: (convId: string | null, wsName: string) => void
    onNewConversation: () => void
    onShowAccountInfo: () => void
    onShowSettings: () => void
    onShowHistory: (projectId?: string | null) => void
    onGoHome: () => void
    onConvDeleted?: (convId: string) => void
    onShowToolbox?: () => void
    onOpenUserDialog?: (tab: "account" | "members") => void
    // Optional legacy callbacks kept non-breaking if passed
    onProjectCreated?: (name: string) => void
    onNewProjectConversation?: (project: Project) => void
    onShowLogs?: () => void
    onShowSourceControl?: () => void
    onShowResources?: () => void
    onShowMcp?: () => void
    onShowWorkflows?: () => void
    onShowMemories?: () => void
    onShowRepoInfo?: () => void
}

const SIDEBAR_LIMIT = 40

export function AppSidebar({
    currentConvId,
    conversationsVersion,
    onSelectConversation,
    onNewConversation,
    onShowAccountInfo,
    onShowSettings,
    onShowHistory,
    onGoHome,
    onConvDeleted,
    onShowToolbox,
    onOpenUserDialog,
}: AppSidebarProps) {
    const { isDark, toggle: toggleTheme } = useTheme()
    const { isMobile, setOpenMobile } = useSidebar()
    const { user, logout } = useAuthUser()
    const isAdmin = user?.role === "admin"

    const [allRows, setAllRows] = useState<ConvRow[]>([])
    const [loading, setLoading] = useState(true)
    const [searchQuery, setSearchQuery] = useState("")
    const [editingId, setEditingId] = useState<string | null>(null)
    const [editTitle, setEditTitle] = useState("")
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
    const [busyId, setBusyId] = useState<string | null>(null)
    const [actionError, setActionError] = useState<string | null>(null)

    const hasLoadedRef = useRef(false)

    const fetchData = useCallback(async () => {
        if (!hasLoadedRef.current) setLoading(true)
        try {
            const { rows } = await loadConversationIndex()
            setAllRows(rows)
            hasLoadedRef.current = true
        } catch {
            // non-fatal
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => {
        fetchData()
    }, [fetchData, conversationsVersion, user?.id])

    const filteredRows = useMemo(() => {
        const q = searchQuery.trim().toLowerCase()
        const base = q ? allRows.filter((r) => r.title.toLowerCase().includes(q)) : allRows
        return q ? base : base.slice(0, SIDEBAR_LIMIT)
    }, [allRows, searchQuery])

    const timeBuckets = useMemo(() => groupByTimeBucket(filteredRows), [filteredRows])

    const handleSelect = (id: string) => {
        if (editingId === id) return
        setConfirmDeleteId(null)
        onSelectConversation(id, "")
        if (isMobile) setOpenMobile(false)
    }

    const startRename = (e: React.MouseEvent, row: ConvRow) => {
        e.stopPropagation()
        setConfirmDeleteId(null)
        setActionError(null)
        setEditingId(row.id)
        setEditTitle(row.title)
    }

    const commitRename = async (id: string) => {
        const clean = editTitle.trim()
        if (!clean) {
            setEditingId(null)
            return
        }
        setBusyId(id)
        setActionError(null)
        try {
            const res = await renameConversation(id, clean)
            setAllRows((prev) => prev.map((r) => (r.id === id ? { ...r, title: res.title || clean } : r)))
            setEditingId(null)
        } catch (err) {
            setActionError(err instanceof Error ? err.message : "重命名失败")
        } finally {
            setBusyId(null)
        }
    }

    const handleDelete = async (e: React.MouseEvent, id: string) => {
        e.stopPropagation()
        if (confirmDeleteId !== id) {
            setEditingId(null)
            setConfirmDeleteId(id)
            return
        }
        setBusyId(id)
        setActionError(null)
        try {
            await deleteConversation(id)
            setAllRows((prev) => prev.filter((r) => r.id !== id))
            setConfirmDeleteId(null)
            onConvDeleted?.(id)
        } catch (err) {
            setActionError(err instanceof Error ? err.message : "删除失败")
        } finally {
            setBusyId(null)
        }
    }

    const displayName = user?.displayName || user?.username || "成员"
    const initialChar = displayName.slice(0, 1).toUpperCase()

    return (
        <Sidebar className="border-r border-sidebar-border/80">
            <SidebarHeader className="px-3 pt-3 pb-2 gap-2.5">
                <button
                    type="button"
                    onClick={() => {
                        onGoHome()
                        if (isMobile) setOpenMobile(false)
                    }}
                    className="flex items-center justify-between px-1 py-0.5 text-left hover:opacity-85 transition-opacity cursor-pointer"
                >
                    <span className="font-semibold text-sm tracking-tight text-sidebar-foreground">
                        Antigravity 工作台
                    </span>
                </button>

                <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                        onNewConversation()
                        if (isMobile) setOpenMobile(false)
                    }}
                    className="w-full justify-start gap-2 h-9 rounded-xl bg-background/80 hover:bg-accent/60 border-border/70 text-xs font-medium shadow-none cursor-pointer"
                >
                    <Plus className="h-4 w-4 text-foreground/80" />
                    <span>开启新对话</span>
                </Button>

                <div className="relative">
                    <Search className="h-3.5 w-3.5 text-muted-foreground/70 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <Input
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="搜索最近对话..."
                        className="h-8 pl-8 pr-7 text-xs rounded-lg bg-muted/40 border-border/50 focus-visible:ring-1"
                    />
                    {searchQuery && (
                        <button
                            type="button"
                            onClick={() => setSearchQuery("")}
                            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground cursor-pointer"
                            aria-label="清空搜索"
                        >
                            <X className="h-3.5 w-3.5" />
                        </button>
                    )}
                </div>
            </SidebarHeader>

            <SidebarContent className="px-2 pb-2">
                {actionError && (
                    <div className="mx-2 mb-1 px-2.5 py-1.5 rounded-md bg-destructive/10 text-destructive text-[11px] flex items-center justify-between gap-2">
                        <span className="truncate">{actionError}</span>
                        <button type="button" onClick={() => setActionError(null)} className="shrink-0 cursor-pointer">
                            <X className="h-3 w-3" />
                        </button>
                    </div>
                )}

                {loading && allRows.length === 0 ? (
                    <div className="flex items-center justify-center py-10 text-xs text-muted-foreground gap-2">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        <span>加载对话...</span>
                    </div>
                ) : timeBuckets.length === 0 ? (
                    <div className="px-3 py-10 text-center space-y-1">
                        <MessageSquare className="h-5 w-5 mx-auto text-muted-foreground/40" />
                        <p className="text-xs text-muted-foreground">
                            {searchQuery ? "未找到匹配的对话" : "暂无历史对话"}
                        </p>
                    </div>
                ) : (
                    timeBuckets.map((bucket) => (
                        <SidebarGroup key={bucket.label} className="py-1.5 px-0">
                            <SidebarGroupLabel className="h-6 px-2 text-[11px] font-medium text-muted-foreground/75">
                                {bucket.label}
                            </SidebarGroupLabel>
                            <SidebarGroupContent>
                                <SidebarMenu className="gap-0.5">
                                    {bucket.rows.map((row) => {
                                        const isActive = row.id === currentConvId
                                        const isEditing = editingId === row.id
                                        const isConfirmDel = confirmDeleteId === row.id
                                        const isBusy = busyId === row.id

                                        if (isEditing) {
                                            return (
                                                <SidebarMenuItem key={row.id} className="px-1 py-0.5">
                                                    <div className="flex items-center gap-1">
                                                        <Input
                                                            value={editTitle}
                                                            onChange={(e) => setEditTitle(e.target.value)}
                                                            onKeyDown={(e) => {
                                                                if (e.key === "Enter") {
                                                                    e.preventDefault()
                                                                    commitRename(row.id)
                                                                } else if (e.key === "Escape") {
                                                                    setEditingId(null)
                                                                }
                                                            }}
                                                            autoFocus
                                                            className="h-7 text-xs px-2"
                                                        />
                                                        <Button
                                                            type="button"
                                                            size="icon"
                                                            variant="ghost"
                                                            className="h-7 w-7 shrink-0"
                                                            disabled={isBusy}
                                                            onClick={() => commitRename(row.id)}
                                                            title="保存标题"
                                                        >
                                                            {isBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                                                        </Button>
                                                        <Button
                                                            type="button"
                                                            size="icon"
                                                            variant="ghost"
                                                            className="h-7 w-7 shrink-0"
                                                            onClick={() => setEditingId(null)}
                                                            title="取消"
                                                        >
                                                            <X className="h-3.5 w-3.5" />
                                                        </Button>
                                                    </div>
                                                </SidebarMenuItem>
                                            )
                                        }

                                        return (
                                            <SidebarMenuItem key={row.id} className="group/conv relative">
                                                <SidebarMenuButton
                                                    isActive={isActive}
                                                    onClick={() => handleSelect(row.id)}
                                                    className={cn(
                                                        "h-8 px-2.5 pr-14 rounded-lg text-xs transition-colors cursor-pointer",
                                                        isActive
                                                            ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                                                            : "text-sidebar-foreground/85 hover:bg-sidebar-accent/50",
                                                    )}
                                                    title={row.title}
                                                >
                                                    <span className="truncate">{row.title}</span>
                                                </SidebarMenuButton>

                                                <div
                                                    className={cn(
                                                        "absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5 transition-opacity",
                                                        isConfirmDel || isBusy
                                                            ? "opacity-100"
                                                            : "opacity-100 sm:opacity-0 sm:group-hover/conv:opacity-100",
                                                    )}
                                                >
                                                    {isConfirmDel ? (
                                                        <>
                                                            <button
                                                                type="button"
                                                                disabled={isBusy}
                                                                onClick={(e) => handleDelete(e, row.id)}
                                                                className="h-6 px-1.5 rounded text-[10px] font-medium bg-destructive text-destructive-foreground hover:opacity-90 cursor-pointer"
                                                            >
                                                                {isBusy ? "..." : "确认删"}
                                                            </button>
                                                            <button
                                                                type="button"
                                                                onClick={(e) => {
                                                                    e.stopPropagation()
                                                                    setConfirmDeleteId(null)
                                                                }}
                                                                className="h-6 w-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground cursor-pointer"
                                                                title="取消"
                                                            >
                                                                <X className="h-3 w-3" />
                                                            </button>
                                                        </>
                                                    ) : (
                                                        <>
                                                            <button
                                                                type="button"
                                                                onClick={(e) => startRename(e, row)}
                                                                className="h-6 w-6 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-background/80 cursor-pointer"
                                                                title="重命名"
                                                            >
                                                                <Pencil className="h-3 w-3" />
                                                            </button>
                                                            <button
                                                                type="button"
                                                                onClick={(e) => handleDelete(e, row.id)}
                                                                className="h-6 w-6 flex items-center justify-center rounded-md text-muted-foreground hover:text-destructive hover:bg-background/80 cursor-pointer"
                                                                title="删除对话"
                                                            >
                                                                <Trash2 className="h-3 w-3" />
                                                            </button>
                                                        </>
                                                    )}
                                                </div>
                                            </SidebarMenuItem>
                                        )
                                    })}
                                </SidebarMenu>
                            </SidebarGroupContent>
                        </SidebarGroup>
                    ))
                )}

                {allRows.length > SIDEBAR_LIMIT && !searchQuery && (
                    <button
                        type="button"
                        onClick={() => {
                            onShowHistory(null)
                            if (isMobile) setOpenMobile(false)
                        }}
                        className="mx-2 mt-1 py-1.5 px-2 rounded-lg text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/40 flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                    >
                        <History className="h-3 w-3" />
                        <span>查看全部 {allRows.length} 条对话</span>
                    </button>
                )}
            </SidebarContent>

            <SidebarFooter className="p-2 border-t border-sidebar-border/60">
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <button
                            type="button"
                            className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl hover:bg-sidebar-accent/60 transition-colors cursor-pointer text-left"
                        >
                            <div className="h-7 w-7 rounded-full bg-foreground/10 text-foreground flex items-center justify-center text-xs font-semibold shrink-0">
                                {initialChar}
                            </div>
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1.5">
                                    <span className="text-xs font-medium truncate">{displayName}</span>
                                    <Badge variant="outline" className="text-[10px] h-4 px-1 font-normal">
                                        {isAdmin ? "管理员" : "成员"}
                                    </Badge>
                                </div>
                                <div className="text-[11px] text-muted-foreground truncate">
                                    @{user?.username || "guest"}
                                </div>
                            </div>
                            <ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        </button>
                    </DropdownMenuTrigger>

                    <DropdownMenuContent side="top" align="start" className="w-56 text-xs">
                        <DropdownMenuLabel className="font-normal">
                            <div className="font-medium text-foreground">{displayName}</div>
                            <div className="text-[11px] text-muted-foreground">@{user?.username || ""}</div>
                        </DropdownMenuLabel>
                        <DropdownMenuSeparator />

                        <DropdownMenuItem
                            className="cursor-pointer gap-2"
                            onClick={() => onOpenUserDialog?.("account")}
                        >
                            <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
                            <span>账号与改密</span>
                        </DropdownMenuItem>

                        {isAdmin && (
                            <>
                                <DropdownMenuItem
                                    className="cursor-pointer gap-2"
                                    onClick={() => onOpenUserDialog?.("members")}
                                >
                                    <Shield className="h-3.5 w-3.5 text-muted-foreground" />
                                    <span>成员管理</span>
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                    className="cursor-pointer gap-2"
                                    onClick={() => {
                                        onShowAccountInfo()
                                        if (isMobile) setOpenMobile(false)
                                    }}
                                >
                                    <Users className="h-3.5 w-3.5 text-muted-foreground" />
                                    <span>OAuth 模型与配额</span>
                                </DropdownMenuItem>
                                {onShowToolbox && (
                                    <DropdownMenuItem
                                        className="cursor-pointer gap-2"
                                        onClick={() => {
                                            onShowToolbox()
                                            if (isMobile) setOpenMobile(false)
                                        }}
                                    >
                                        <Wrench className="h-3.5 w-3.5 text-muted-foreground" />
                                        <span>系统工具箱</span>
                                    </DropdownMenuItem>
                                )}
                                <DropdownMenuItem
                                    className="cursor-pointer gap-2"
                                    onClick={() => {
                                        onShowSettings()
                                        if (isMobile) setOpenMobile(false)
                                    }}
                                >
                                    <Settings className="h-3.5 w-3.5 text-muted-foreground" />
                                    <span>后台设置与代理</span>
                                </DropdownMenuItem>
                            </>
                        )}

                        <DropdownMenuSeparator />
                        <DropdownMenuItem className="cursor-pointer gap-2" onClick={toggleTheme}>
                            {isDark ? <Sun className="h-3.5 w-3.5 text-muted-foreground" /> : <Moon className="h-3.5 w-3.5 text-muted-foreground" />}
                            <span>{isDark ? "切换浅色模式" : "切换深色模式"}</span>
                        </DropdownMenuItem>
                        <DropdownMenuItem
                            className="cursor-pointer gap-2 text-destructive focus:text-destructive"
                            onClick={() => logout()}
                        >
                            <LogOut className="h-3.5 w-3.5" />
                            <span>退出登录</span>
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </SidebarFooter>
        </Sidebar>
    )
}
