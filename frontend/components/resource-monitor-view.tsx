"use client"

import { useEffect, useState, useCallback, useMemo } from "react"
import { getWorkspaceResources, killIde } from "@/lib/cascade-api"
import type { ResourceSnapshot, SystemResources, WorkspaceResources, ResourceHistoryPoint, SelfStats } from "@/lib/cascade-api"
import { Cpu, MemoryStick, Activity, Monitor, HardDrive, Server, Box, AlertTriangle, Power } from "lucide-react"
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog"

// === Donut Chart (SVG) ===
function DonutChart({ value, max = 100, size = 110, strokeWidth = 10, label, sublabel, color }: {
    value: number; max?: number; size?: number; strokeWidth?: number
    label: string; sublabel: string; color: string
}) {
    const radius = (size - strokeWidth) / 2
    const circumference = 2 * Math.PI * radius
    const percent = Math.min(value / max, 1)
    const offset = circumference * (1 - percent)

    return (
        <div className="flex flex-col items-center gap-1.5">
            <svg width={size} height={size} className="transform -rotate-90">
                {/* Background ring */}
                <circle cx={size / 2} cy={size / 2} r={radius}
                    fill="none" stroke="currentColor" className="text-muted/20"
                    strokeWidth={strokeWidth} />
                {/* Value ring */}
                <circle cx={size / 2} cy={size / 2} r={radius}
                    fill="none" stroke={color}
                    strokeWidth={strokeWidth}
                    strokeDasharray={circumference}
                    strokeDashoffset={offset}
                    strokeLinecap="round"
                    style={{ transition: 'stroke-dashoffset 0.8s ease, stroke 0.8s ease' }} />
            </svg>
            {/* Center text overlay */}
            <div className="absolute flex flex-col items-center justify-center" style={{ width: size, height: size }}>
                <span className="text-lg font-bold tabular-nums" style={{ color }}>
                    {value.toFixed(1)}%
                </span>
            </div>
            <span className="text-xs font-medium text-foreground/80">{label}</span>
            <span className="text-[10px] text-muted-foreground">{sublabel}</span>
        </div>
    )
}

// === Sparkline Chart (SVG) ===
function Sparkline({ data, width = 280, height = 50, color, label }: {
    data: number[]; width?: number; height?: number; color: string; label: string
}) {
    if (!data.length) return null
    const max = Math.max(...data, 1)
    const points = data.map((v, i) => {
        const x = (i / Math.max(data.length - 1, 1)) * width
        const y = height - (v / max) * (height - 4) - 2
        return `${x},${y}`
    }).join(' ')

    const areaPoints = `0,${height} ${points} ${width},${height}`
    const latest = data[data.length - 1]

    return (
        <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
                <span className="text-[11px] font-mono tabular-nums" style={{ color }}>
                    {latest.toFixed(1)}%
                </span>
            </div>
            <svg width={width} height={height} className="w-full" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
                {/* Fill area */}
                <polygon points={areaPoints} fill={color} opacity={0.1} />
                {/* Line */}
                <polyline points={points} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
            </svg>
        </div>
    )
}

// === Per-workspace row ===
function WorkspaceRow({ pid, data }: { pid: string; data: WorkspaceResources }) {
    const cpuColor = getGradientColor(data.cpuPercent)
    const memColor = getGradientColor(Math.min((data.memMB / 2048) * 100, 100))

    return (
        <div className="group grid grid-cols-[1fr_100px_100px_60px] items-center gap-3 py-2 px-3 rounded-lg hover:bg-muted/30 transition-colors">
            <div className="flex items-center gap-2 min-w-0">
                <Server className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                <span className="text-sm font-medium truncate">{data.name || `PID ${pid}`}</span>
            </div>
            <div className="flex items-center gap-2">
                <div className="w-full h-2 rounded-full bg-muted/30 overflow-hidden">
                    <div className="h-full rounded-full" style={{
                        width: `${Math.max(Math.min(data.cpuPercent, 100), 2)}%`,
                        backgroundColor: cpuColor,
                        transition: 'width 0.8s ease',
                    }} />
                </div>
                <span className="text-[11px] font-mono tabular-nums text-muted-foreground w-10 text-right">
                    {data.cpuPercent.toFixed(1)}%
                </span>
            </div>
            <div className="flex items-center gap-2">
                <div className="w-full h-2 rounded-full bg-muted/30 overflow-hidden">
                    <div className="h-full rounded-full" style={{
                        width: `${Math.max(Math.min((data.memMB / 2048) * 100, 100), 2)}%`,
                        backgroundColor: memColor,
                        transition: 'width 0.8s ease',
                    }} />
                </div>
                <span className="text-[11px] font-mono tabular-nums text-muted-foreground w-14 text-right">
                    {data.memMB} MB
                </span>
            </div>
            <span className="text-[10px] text-muted-foreground/60 text-right font-mono">{pid}</span>
        </div>
    )
}

// === Color helper ===
function getGradientColor(value: number): string {
    const clamped = Math.max(0, Math.min(100, value))
    if (clamped < 50) {
        const t = clamped / 50
        const h = 142 - t * (142 - 38)
        return `hsl(${h}, 80%, 48%)`
    }
    const t = (clamped - 50) / 50
    const h = 38 - t * 38
    return `hsl(${h}, 84%, 55%)`
}

// === Main Component ===
export function ResourceMonitorView() {
    const [snapshot, setSnapshot] = useState<ResourceSnapshot | null>(null)
    const [loading, setLoading] = useState(true)
    const [showKillIde, setShowKillIde] = useState(false)
    const [killingIde, setKillingIde] = useState(false)


    const fetchData = useCallback(async () => {
        try {
            const data = await getWorkspaceResources()
            setSnapshot(data)
        } catch {
            // ignore — server might not be ready
        } finally {
            setLoading(false)
        }
    }, [])

    // Fetch on mount + poll every 5s
    useEffect(() => {
        fetchData()
        const timer = setInterval(fetchData, 5000)
        return () => clearInterval(timer)
    }, [fetchData])

    // Also listen for WebSocket updates via custom event
    useEffect(() => {
        const handler = (e: Event) => {
            const data = (e as CustomEvent).detail
            if (data) setSnapshot(data)
        }
        window.addEventListener('resource-update', handler)
        return () => window.removeEventListener('resource-update', handler)
    }, [])

    const system = snapshot?.system
    const deckStats = snapshot?.selfStats
    const workspaces = snapshot?.workspaces || {}
    const historyData = snapshot?.history || []
    const workspaceList = useMemo(() =>
        Object.entries(workspaces).sort((a, b) => b[1].memMB - a[1].memMB),
        [workspaces]
    )

    // Aggregate workspace totals
    const wsTotalCpu = useMemo(() =>
        workspaceList.reduce((sum, [, w]) => sum + w.cpuPercent, 0),
        [workspaceList]
    )
    const wsTotalMem = useMemo(() =>
        workspaceList.reduce((sum, [, w]) => sum + w.memMB, 0),
        [workspaceList]
    )

    const cpuHistory = useMemo(() => historyData.map(h => h.cpu), [historyData])
    const memHistory = useMemo(() => historyData.map(h => h.mem), [historyData])

    const cpuColor = system ? getGradientColor(system.cpuPercent) : 'hsl(142, 80%, 48%)'
    const memColor = system ? getGradientColor(system.memPercent) : 'hsl(142, 80%, 48%)'

    if (loading && !snapshot) {
        return (
            <div className="flex-1 flex items-center justify-center">
                <div className="flex flex-col items-center gap-3">
                    <Activity className="w-8 h-8 text-muted-foreground/50 animate-pulse" />
                    <span className="text-sm text-muted-foreground">正在加载资源数据...</span>
                </div>
            </div>
        )
    }

    return (
        <div className="flex-1 overflow-y-auto">
            <div className="max-w-3xl mx-auto p-6 space-y-6">
                {/* Header */}
                <div className="flex items-center gap-3">
                    <div className="p-2 rounded-lg bg-gradient-to-br from-emerald-500/10 to-cyan-500/10 border border-emerald-500/20">
                        <Monitor className="w-5 h-5 text-emerald-400" />
                    </div>
                    <div>
                        <h2 className="text-lg font-semibold">系统资源监控</h2>
                        <p className="text-xs text-muted-foreground">
                            系统：{system?.cpuCores || 0} 核心 • {system?.memTotalMB ? `${(system.memTotalMB / 1024).toFixed(1)} GB 内存` : '—'}
                        </p>
                    </div>
                    <div className="ml-auto">
                        <button
                            onClick={() => setShowKillIde(true)}
                            disabled={killingIde || workspaceList.length === 0}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 hover:border-red-500/40 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                        >
                            {killingIde
                                ? <span className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" />
                                : <Power className="w-3.5 h-3.5" />}
                            终止 Antigravity
                        </button>
                    </div>
                </div>

                {/* System Overview — Donut charts */}
                <div className="rounded-xl border border-border/50 bg-card/50 p-5">
                    <h3 className="text-sm font-medium text-muted-foreground mb-4 flex items-center gap-2">
                        <Activity className="w-4 h-4" /> 系统概览
                    </h3>
                    <div className="grid grid-cols-3 gap-6 justify-items-center">
                        <div className="relative">
                            <DonutChart
                                value={system?.cpuPercent ?? 0}
                                label="CPU 占用"
                                sublabel={`${system?.cpuCores ?? 0} 核心`}
                                color={cpuColor}
                            />
                        </div>
                        <div className="relative">
                            <DonutChart
                                value={system?.memPercent ?? 0}
                                label="内存"
                                sublabel={`${system?.memUsedMB ? (system.memUsedMB / 1024).toFixed(1) : '0'} / ${system?.memTotalMB ? (system.memTotalMB / 1024).toFixed(1) : '0'} GB`}
                                color={memColor}
                            />
                        </div>
                        <div className="relative">
                            <DonutChart
                                value={workspaceList.length > 0 ? (wsTotalMem / (system?.memUsedMB || 1)) * 100 : 0}
                                label="工作区占比"
                                sublabel={`${workspaceList.length} 个工作区`}
                                color="hsl(262, 80%, 55%)"
                            />
                        </div>
                    </div>
                </div>

                {/* Antigravity Deck App — Self Monitoring */}
                {deckStats && (
                    <div className="rounded-xl border border-border/50 bg-card/50 p-5">
                        <h3 className="text-sm font-medium text-muted-foreground mb-3 flex items-center gap-2">
                            <Box className="w-4 h-4" /> Antigravity Deck（本应用）
                        </h3>
                        {/* Column headers */}
                        <div className="grid grid-cols-[1fr_100px_100px_60px] gap-3 px-3 pb-1 text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium">
                            <span>组件</span>
                            <span>CPU</span>
                            <span>内存</span>
                            <span className="text-right">PID</span>
                        </div>
                        <div className="divide-y divide-border/30">
                            {/* Backend row */}
                            <div className="grid grid-cols-[1fr_100px_100px_60px] items-center gap-3 py-2 px-3 rounded-lg hover:bg-muted/30 transition-colors">
                                <div className="flex items-center gap-2 min-w-0">
                                    <Server className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                                    <span className="text-sm font-medium">后端服务 (Node.js)</span>
                                </div>
                                <div className="flex items-center gap-2">
                                    <div className="w-full h-2 rounded-full bg-muted/30 overflow-hidden">
                                        <div className="h-full rounded-full" style={{
                                            width: `${Math.max(Math.min(deckStats.backend.cpuPercent, 100), 2)}%`,
                                            backgroundColor: getGradientColor(deckStats.backend.cpuPercent),
                                            transition: 'width 0.8s ease',
                                        }} />
                                    </div>
                                    <span className="text-[11px] font-mono tabular-nums text-muted-foreground w-10 text-right">
                                        {deckStats.backend.cpuPercent.toFixed(1)}%
                                    </span>
                                </div>
                                <div className="flex items-center gap-2">
                                    <div className="w-full h-2 rounded-full bg-muted/30 overflow-hidden">
                                        <div className="h-full rounded-full" style={{
                                            width: `${Math.max(Math.min((deckStats.backend.memMB / 512) * 100, 100), 2)}%`,
                                            backgroundColor: getGradientColor(Math.min((deckStats.backend.memMB / 512) * 100, 100)),
                                            transition: 'width 0.8s ease',
                                        }} />
                                    </div>
                                    <span className="text-[11px] font-mono tabular-nums text-muted-foreground w-14 text-right">
                                        {deckStats.backend.memMB} MB
                                    </span>
                                </div>
                                <span className="text-[10px] text-muted-foreground/60 text-right font-mono">{deckStats.backend.pid}</span>
                            </div>
                            {/* Frontend row */}
                            <div className="grid grid-cols-[1fr_100px_100px_60px] items-center gap-3 py-2 px-3 rounded-lg hover:bg-muted/30 transition-colors">
                                <div className="flex items-center gap-2 min-w-0">
                                    <Monitor className="w-3.5 h-3.5 text-violet-400 shrink-0" />
                                    <span className="text-sm font-medium">前端界面 (Next.js)</span>
                                </div>
                                <div className="flex items-center gap-2">
                                    <div className="w-full h-2 rounded-full bg-muted/30 overflow-hidden">
                                        <div className="h-full rounded-full" style={{
                                            width: `${Math.max(Math.min(deckStats.frontend.cpuPercent, 100), 2)}%`,
                                            backgroundColor: getGradientColor(deckStats.frontend.cpuPercent),
                                            transition: 'width 0.8s ease',
                                        }} />
                                    </div>
                                    <span className="text-[11px] font-mono tabular-nums text-muted-foreground w-10 text-right">
                                        {deckStats.frontend.cpuPercent.toFixed(1)}%
                                    </span>
                                </div>
                                <div className="flex items-center gap-2">
                                    <div className="w-full h-2 rounded-full bg-muted/30 overflow-hidden">
                                        <div className="h-full rounded-full" style={{
                                            width: `${Math.max(Math.min((deckStats.frontend.memMB / 512) * 100, 100), 2)}%`,
                                            backgroundColor: getGradientColor(Math.min((deckStats.frontend.memMB / 512) * 100, 100)),
                                            transition: 'width 0.8s ease',
                                        }} />
                                    </div>
                                    <span className="text-[11px] font-mono tabular-nums text-muted-foreground w-14 text-right">
                                        {deckStats.frontend.memMB} MB
                                    </span>
                                </div>
                                <span className="text-[10px] text-muted-foreground/60 text-right font-mono">{deckStats.frontend.pid || '—'}</span>
                            </div>
                        </div>
                        {/* Totals */}
                        <div className="grid grid-cols-[1fr_100px_100px_60px] gap-3 px-3 pt-2 mt-2 border-t border-border/50 text-xs font-medium">
                            <span className="text-muted-foreground">Deck 总计</span>
                            <span className="font-mono tabular-nums">{deckStats.totalCpuPercent.toFixed(1)}%</span>
                            <span className="font-mono tabular-nums">{deckStats.totalMemMB} MB</span>
                            <span></span>
                        </div>
                    </div>
                )}

                {/* Usage History — Sparklines */}
                {cpuHistory.length > 1 && (
                    <div className="rounded-xl border border-border/50 bg-card/50 p-5">
                        <h3 className="text-sm font-medium text-muted-foreground mb-4 flex items-center gap-2">
                            <HardDrive className="w-4 h-4" /> 历史占用
                            <span className="text-[10px] text-muted-foreground/50 ml-auto">最近 {Math.round(cpuHistory.length * 5 / 60)} 分钟</span>
                        </h3>
                        <div className="space-y-4">
                            <Sparkline data={cpuHistory} color={cpuColor} label="CPU %" />
                            <Sparkline data={memHistory} color={memColor} label="内存 %" />
                        </div>
                    </div>
                )}

                {/* Per-workspace Breakdown */}
                <div className="rounded-xl border border-border/50 bg-card/50 p-5">
                    <h3 className="text-sm font-medium text-muted-foreground mb-3 flex items-center gap-2">
                        <Cpu className="w-4 h-4" /> 工作区资源明细
                    </h3>

                    {workspaceList.length === 0 ? (
                        <div className="text-center py-6">
                            <Server className="w-6 h-6 mx-auto text-muted-foreground/30 mb-2" />
                            <p className="text-sm text-muted-foreground/60">未检测到活动中的工作区</p>
                        </div>
                    ) : (
                        <>
                            {/* Column headers */}
                            <div className="grid grid-cols-[1fr_100px_100px_60px] gap-3 px-3 pb-1 text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium">
                                <span>工作区</span>
                                <span>CPU</span>
                                <span>内存</span>
                                <span className="text-right">PID</span>
                            </div>
                            <div className="divide-y divide-border/30">
                                {workspaceList.map(([pid, data]) => (
                                    <WorkspaceRow key={pid} pid={pid} data={data} />
                                ))}
                            </div>
                            {/* Totals */}
                            <div className="grid grid-cols-[1fr_100px_100px_60px] gap-3 px-3 pt-2 mt-2 border-t border-border/50 text-xs font-medium">
                                <span className="text-muted-foreground">Antigravity 总计</span>
                                <span className="font-mono tabular-nums">{wsTotalCpu.toFixed(1)}%</span>
                                <span className="font-mono tabular-nums">{wsTotalMem} MB</span>
                                <span></span>
                            </div>
                        </>
                    )}
                </div>

                {/* Footer info */}
                <div className="text-center text-[10px] text-muted-foreground/40 pb-4">
                    每 5 秒采样一次 • {historyData.length} / 60 个历史数据点
                </div>
            </div>

            {/* Kill IDE Confirmation Dialog */}
            <AlertDialog open={showKillIde} onOpenChange={setShowKillIde}>
                <AlertDialogContent className="sm:max-w-[420px]">
                    <AlertDialogHeader>
                        <AlertDialogTitle className="flex items-center gap-2">
                            <AlertTriangle className="h-5 w-5 text-red-400" />
                            终止 Antigravity IDE
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            此操作将<span className="font-medium text-red-400">终止本机上所有 Antigravity IDE 进程</span>。
                            所有活动工作区（{workspaceList.length} 个）及正在运行的 Cascade 对话都将被停止。
                            <br /><br />
                            之后可在欢迎页重新启动 IDE。
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel className="text-xs">取消</AlertDialogCancel>
                        <AlertDialogAction
                            onClick={async () => {
                                setShowKillIde(false)
                                setKillingIde(true)
                                try {
                                    await killIde()
                                    // Give processes time to die, then refresh
                                    setTimeout(() => {
                                        fetchData()
                                        setKillingIde(false)
                                    }, 2000)
                                } catch (e) {
                                    console.error('Kill IDE failed:', e)
                                    setKillingIde(false)
                                }
                            }}
                            className="bg-red-500 hover:bg-red-600 text-white text-xs"
                        >
                            <Power className="h-3.5 w-3.5 mr-1" />
                            终止所有进程
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    )
}

