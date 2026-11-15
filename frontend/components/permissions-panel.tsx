'use client';
import { useState, useEffect, useCallback } from 'react';
import {
    getPermissionsConfig,
    updatePermissionsConfig,
    applyPermissionPreset,
    getIdeRuntimeStatus,
    restartIdeService,
} from '@/lib/cascade-api';
import type {
    PermissionConfigState,
    IdeRuntimeStatus,
    AgentMode,
    ToolPermission,
    ArtifactReviewPolicy,
    PermissionPresetName,
} from '@/lib/cascade-api';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import {
    ShieldCheck,
    Server,
    RefreshCw,
    Plus,
    Trash2,
    Check,
    AlertTriangle,
    Loader2,
} from 'lucide-react';

const PRESET_OPTIONS: Array<{
    id: PermissionPresetName;
    title: string;
    desc: string;
    tone: string;
}> = [
    { id: 'strict', title: '严格审核', desc: '读写/执行全部确认', tone: 'border-sky-500/30 hover:border-sky-500/60' },
    { id: 'default', title: '默认平衡', desc: '仅工作区外与命令询问', tone: 'border-border/60 hover:border-primary/50' },
    { id: 'accept-edits', title: '自动改代码', desc: '自动应用文件编辑', tone: 'border-emerald-500/30 hover:border-emerald-500/60' },
    { id: 'auto', title: '沙盒全自动', desc: '沙盒内命令免审批', tone: 'border-amber-500/30 hover:border-amber-500/60' },
    { id: 'turbo', title: '完全放行 (Turbo)', desc: '全权限自动执行', tone: 'border-rose-500/30 hover:border-rose-500/60' },
];

const QUICK_RULES: Array<{ list: 'allow' | 'ask' | 'deny'; rule: string; label: string }> = [
    { list: 'allow', rule: 'command(git)', label: '+ 允许 git' },
    { list: 'allow', rule: 'read_file(*)', label: '+ 允许全局只读' },
    { list: 'allow', rule: 'read_url(*)', label: '+ 允许网页抓取' },
    { list: 'deny', rule: 'command(rm -rf)', label: '+ 禁止 rm -rf' },
    { list: 'deny', rule: 'command(sudo)', label: '+ 禁止 sudo' },
];

export function PermissionsPanel() {
    const [permState, setPermState] = useState<PermissionConfigState | null>(null);
    const [ideStatus, setIdeStatus] = useState<IdeRuntimeStatus | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [restarting, setRestarting] = useState(false);
    const [ruleList, setRuleList] = useState<'allow' | 'ask' | 'deny'>('allow');
    const [ruleInput, setRuleInput] = useState('');
    const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

    const flash = (kind: 'ok' | 'err', text: string) => {
        setNotice({ kind, text });
        setTimeout(() => setNotice((prev) => (prev?.text === text ? null : prev)), 4000);
    };

    const loadData = useCallback(async () => {
        setLoading(true);
        try {
            const [perm, ide] = await Promise.all([
                getPermissionsConfig(),
                getIdeRuntimeStatus().catch(() => null),
            ]);
            setPermState(perm);
            setIdeStatus(ide);
        } catch (e: unknown) {
            flash('err', e instanceof Error ? e.message : '读取权限配置失败');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { loadData(); }, [loadData]);

    const applyUpdate = async (payload: Parameters<typeof updatePermissionsConfig>[0], okText = '权限配置已更新') => {
        setSaving(true);
        try {
            const next = await updatePermissionsConfig(payload);
            setPermState(next);
            flash('ok', okText);
        } catch (e: unknown) {
            flash('err', e instanceof Error ? e.message : '保存权限配置失败');
        } finally {
            setSaving(false);
        }
    };

    const handlePreset = async (preset: PermissionPresetName) => {
        setSaving(true);
        try {
            const next = await applyPermissionPreset(preset);
            setPermState(next);
            flash('ok', `已应用预设：${PRESET_OPTIONS.find((p) => p.id === preset)?.title || preset}`);
        } catch (e: unknown) {
            flash('err', e instanceof Error ? e.message : '应用预设失败');
        } finally {
            setSaving(false);
        }
    };

    const handleRestartIde = async () => {
        setRestarting(true);
        try {
            const res = await restartIdeService();
            flash('ok', res.managedBy === 'pm2' ? '已通知 PM2 重启 Antigravity 守护进程，约 5 秒恢复连接' : '已触发启动 Antigravity 服务');
            setTimeout(() => {
                getIdeRuntimeStatus().then(setIdeStatus).catch(() => {});
            }, 4000);
        } catch (e: unknown) {
            flash('err', e instanceof Error ? e.message : '重启服务失败');
        } finally {
            setRestarting(false);
        }
    };

    const addRule = async (listName: 'allow' | 'ask' | 'deny', rawRule: string) => {
        const clean = rawRule.trim();
        if (!clean || !permState) return;
        const current = permState.cli.permissions[listName] || [];
        if (current.includes(clean)) {
            flash('ok', `规则 ${clean} 已存在`);
            return;
        }
        await applyUpdate({
            cli: {
                permissions: {
                    ...permState.cli.permissions,
                    [listName]: [...current, clean],
                },
            },
        }, `已添加 ${listName.toUpperCase()} 规则：${clean}`);
        setRuleInput('');
    };

    const removeRule = async (listName: 'allow' | 'ask' | 'deny', targetRule: string) => {
        if (!permState) return;
        const nextList = (permState.cli.permissions[listName] || []).filter((r) => r !== targetRule);
        await applyUpdate({
            cli: {
                permissions: {
                    ...permState.cli.permissions,
                    [listName]: nextList,
                },
            },
        }, `已移除规则：${targetRule}`);
    };

    const matchedPreset = PRESET_OPTIONS.find((p) => {
        if (!permState) return false;
        const { cli, autoAccept } = permState;
        if (p.id === 'strict') return !autoAccept && cli.toolPermission === 'strict';
        if (p.id === 'default') return !autoAccept && cli.agentMode === 'default' && cli.toolPermission === 'request-review';
        if (p.id === 'accept-edits') return autoAccept && cli.agentMode === 'accept-edits' && cli.toolPermission === 'request-review';
        if (p.id === 'auto') return autoAccept && cli.agentMode === 'auto' && cli.toolPermission === 'proceed-in-sandbox';
        if (p.id === 'turbo') return autoAccept && cli.toolPermission === 'always-proceed' && cli.artifactReviewPolicy === 'always-proceed';
        return false;
    })?.id;

    return (
        <Card>
            <CardHeader className="pb-3">
                <div className="flex items-center justify-between gap-2">
                    <CardTitle className="text-xs font-semibold flex items-center gap-1.5">
                        <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" /> Agent 权限与服务守护
                    </CardTitle>
                    {ideStatus && (
                        <span className={cn(
                            'text-[10px] px-2 py-0.5 rounded-full font-mono border',
                            ideStatus.lsDetected
                                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                                : 'bg-amber-500/10 text-amber-400 border-amber-500/30'
                        )}>
                            {ideStatus.lsDetected ? `LS 在线 :${ideStatus.port}` : 'LS 未连接'}
                        </span>
                    )}
                </div>
                <CardDescription className="text-[10px]">
                    管理服务器常驻 Antigravity 进程状态、Web 自动审批及 CLI 底层细粒度工具权限（同步写入 settings.json）。
                </CardDescription>
            </CardHeader>

            <CardContent className="space-y-4">
                {/* Daemon runtime bar */}
                <div className="rounded-lg border border-border/50 bg-muted/20 p-3 flex flex-wrap items-center justify-between gap-3">
                    <div className="space-y-1 text-xs">
                        <div className="flex items-center gap-2">
                            <Server className="h-3.5 w-3.5 text-primary" />
                            <span className="font-medium">Antigravity 常驻服务</span>
                            {ideStatus?.pm2Managed && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/25">
                                    PM2 自动保活中
                                </span>
                            )}
                        </div>
                        <p className="text-[11px] text-muted-foreground">
                            {ideStatus
                                ? `IDE 安装: ${ideStatus.ideInstalled ? '是' : '否'} · 进程: ${ideStatus.ideRunning ? '运行中' : '未运行'} · LS Hub: ${ideStatus.lsDetected ? '已就绪' : '重连中'}`
                                : '正在探测守护状态...'}
                        </p>
                    </div>
                    <div className="flex items-center gap-2">
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-7 text-xs gap-1.5"
                            onClick={loadData}
                            disabled={loading}
                        >
                            <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
                            刷新
                        </Button>
                        <Button
                            type="button"
                            size="sm"
                            className="h-7 text-xs gap-1.5"
                            onClick={handleRestartIde}
                            disabled={restarting}
                        >
                            {restarting ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                            重启 Antigravity
                        </Button>
                    </div>
                </div>

                {notice && (
                    <div className={cn(
                        'rounded-md border px-3 py-2 text-xs flex items-center gap-2',
                        notice.kind === 'ok'
                            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                            : 'border-destructive/30 bg-destructive/10 text-destructive'
                    )}>
                        {notice.kind === 'ok' ? <Check className="h-3.5 w-3.5 flex-shrink-0" /> : <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />}
                        <span>{notice.text}</span>
                    </div>
                )}

                {permState && (
                    <>
                        {/* Web Auto-Accept */}
                        <div className="flex items-center justify-between gap-4 rounded-lg border border-border/40 p-3">
                            <div className="space-y-0.5">
                                <span className="text-xs font-medium block">Deck 自动放行安全操作 (`autoAccept`)</span>
                                <span className="text-[11px] text-muted-foreground block">
                                    自动审批日常检查与编辑确认；开启“智能防误触守卫”时，高危删除/停服/强制推送命令会自动暂停等你手动审批。
                                </span>
                            </div>
                            <Switch
                                checked={permState.autoAccept}
                                disabled={saving}
                                onCheckedChange={(checked) => applyUpdate({ autoAccept: checked }, checked ? '已开启 Deck 自动放行' : '已关闭 Deck 自动放行')}
                            />
                        </div>

                        {permState.autoAccept && (
                            <div className="flex items-center justify-between gap-4 rounded-lg border border-border/40 p-3 bg-muted/15">
                                <div className="space-y-0.5">
                                    <span className="text-xs font-medium block">高危命令安全守卫 (`smart` / `full`)</span>
                                    <span className="text-[11px] text-muted-foreground block">
                                        {permState.autoAcceptPolicy === 'full'
                                            ? '当前为完全放行：所有终端命令与操作均自动放行，请谨慎使用。'
                                            : '当前为智能放行（推荐）：仅拦截 rm -rf / systemctl stop / DROP TABLE 等高危指令并弹出审批卡片。'}
                                    </span>
                                </div>
                                <div className="flex items-center gap-1 shrink-0 rounded-md border border-border/60 p-0.5 bg-background">
                                    <button
                                        type="button"
                                        disabled={saving}
                                        onClick={() => applyUpdate({ autoAcceptPolicy: 'smart' }, '已切换为智能安全守卫')}
                                        className={cn(
                                            'px-2 py-1 text-[11px] rounded cursor-pointer transition-colors',
                                            permState.autoAcceptPolicy !== 'full'
                                                ? 'bg-primary text-primary-foreground font-medium'
                                                : 'text-muted-foreground hover:text-foreground'
                                        )}
                                    >
                                        智能守卫
                                    </button>
                                    <button
                                        type="button"
                                        disabled={saving}
                                        onClick={() => applyUpdate({ autoAcceptPolicy: 'full' }, '已切换为完全放行')}
                                        className={cn(
                                            'px-2 py-1 text-[11px] rounded cursor-pointer transition-colors',
                                            permState.autoAcceptPolicy === 'full'
                                                ? 'bg-rose-500 text-white font-medium'
                                                : 'text-muted-foreground hover:text-foreground'
                                        )}
                                    >
                                        完全放行
                                    </button>
                                </div>
                            </div>
                        )}

                        {/* Quick Presets */}
                        <div className="space-y-2">
                            <span className="text-[11px] font-medium text-muted-foreground block">一键权限预设</span>
                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                                {PRESET_OPTIONS.map((preset) => (
                                    <button
                                        key={preset.id}
                                        type="button"
                                        disabled={saving}
                                        onClick={() => handlePreset(preset.id)}
                                        className={cn(
                                            'text-left rounded-lg border p-2.5 transition-colors cursor-pointer bg-muted/10',
                                            preset.tone,
                                            matchedPreset === preset.id && 'ring-1 ring-primary bg-primary/10 border-primary/60'
                                        )}
                                    >
                                        <div className="text-xs font-medium flex items-center justify-between">
                                            <span>{preset.title}</span>
                                            {matchedPreset === preset.id && <Check className="h-3 w-3 text-primary" />}
                                        </div>
                                        <div className="text-[10px] text-muted-foreground mt-0.5">{preset.desc}</div>
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Granular CLI / Agent Settings */}
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                            <div className="space-y-1">
                                <label className="text-[11px] text-muted-foreground block">默认执行模式 (`agentMode`)</label>
                                <Select
                                    value={permState.cli.agentMode}
                                    disabled={saving}
                                    onValueChange={(v) => applyUpdate({ cli: { agentMode: v as AgentMode } })}
                                >
                                    <SelectTrigger className="h-8 text-xs">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="default">default（标准）</SelectItem>
                                        <SelectItem value="accept-edits">accept-edits（自动改文件）</SelectItem>
                                        <SelectItem value="auto">auto（自动评估命令）</SelectItem>
                                        <SelectItem value="plan">plan（仅规划）</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>

                            <div className="space-y-1">
                                <label className="text-[11px] text-muted-foreground block">工具授权 (`toolPermission`)</label>
                                <Select
                                    value={permState.cli.toolPermission}
                                    disabled={saving}
                                    onValueChange={(v) => applyUpdate({ cli: { toolPermission: v as ToolPermission } })}
                                >
                                    <SelectTrigger className="h-8 text-xs">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="strict">strict（每次均询问）</SelectItem>
                                        <SelectItem value="request-review">request-review（需审核）</SelectItem>
                                        <SelectItem value="proceed-in-sandbox">proceed-in-sandbox（沙盒免审）</SelectItem>
                                        <SelectItem value="always-proceed">always-proceed（直接放行）</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>

                            <div className="space-y-1">
                                <label className="text-[11px] text-muted-foreground block">产物审核 (`artifactReview`)</label>
                                <Select
                                    value={permState.cli.artifactReviewPolicy}
                                    disabled={saving}
                                    onValueChange={(v) => applyUpdate({ cli: { artifactReviewPolicy: v as ArtifactReviewPolicy } })}
                                >
                                    <SelectTrigger className="h-8 text-xs">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="asks-for-review">asks-for-review（等待确认）</SelectItem>
                                        <SelectItem value="agent-decides">agent-decides（Agent 决定）</SelectItem>
                                        <SelectItem value="always-proceed">always-proceed（免等待）</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <div className="flex items-center justify-between rounded-md border border-border/40 px-3 py-2">
                                <span className="text-xs">允许访问工作区外目录</span>
                                <Switch
                                    checked={permState.cli.allowNonWorkspaceAccess}
                                    disabled={saving}
                                    onCheckedChange={(checked) => applyUpdate({ cli: { allowNonWorkspaceAccess: checked } })}
                                    className="scale-90"
                                />
                            </div>
                            <div className="flex items-center justify-between rounded-md border border-border/40 px-3 py-2">
                                <span className="text-xs">启用终端 OS 隔离沙盒</span>
                                <Switch
                                    checked={permState.cli.enableTerminalSandbox}
                                    disabled={saving}
                                    onCheckedChange={(checked) => applyUpdate({ cli: { enableTerminalSandbox: checked } })}
                                    className="scale-90"
                                />
                            </div>
                        </div>

                        {/* Fine-grained Allow / Ask / Deny Rules */}
                        <div className="space-y-2.5 border-t border-border/30 pt-3">
                            <div className="flex items-center justify-between gap-2">
                                <span className="text-[11px] font-medium text-muted-foreground">细粒度权限规则 (`action(target)`)</span>
                                <span className="text-[10px] font-mono text-muted-foreground/70 truncate max-w-[260px]" title={permState.settingsPath}>
                                    {permState.settingsPath}
                                </span>
                            </div>

                            <div className="flex flex-wrap gap-1.5">
                                {QUICK_RULES.map((item) => (
                                    <Button
                                        key={`${item.list}:${item.rule}`}
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        className="h-6 text-[10px] px-2"
                                        disabled={saving}
                                        onClick={() => addRule(item.list, item.rule)}
                                    >
                                        {item.label}
                                    </Button>
                                ))}
                            </div>

                            <div className="flex flex-col sm:flex-row gap-2">
                                <Select value={ruleList} onValueChange={(v) => setRuleList(v as 'allow' | 'ask' | 'deny')}>
                                    <SelectTrigger className="h-8 w-full sm:w-28 text-xs">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="allow">Allow 允许</SelectItem>
                                        <SelectItem value="ask">Ask 询问</SelectItem>
                                        <SelectItem value="deny">Deny 禁止</SelectItem>
                                    </SelectContent>
                                </Select>
                                <Input
                                    value={ruleInput}
                                    onChange={(e) => setRuleInput(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                            e.preventDefault();
                                            addRule(ruleList, ruleInput);
                                        }
                                    }}
                                    placeholder="例如 command(npm run) 或 read_file(/srv) 或 mcp(*)"
                                    className="h-8 text-xs font-mono flex-1"
                                />
                                <Button
                                    type="button"
                                    size="sm"
                                    className="h-8 text-xs gap-1"
                                    disabled={saving || !ruleInput.trim()}
                                    onClick={() => addRule(ruleList, ruleInput)}
                                >
                                    <Plus className="h-3.5 w-3.5" /> 添加规则
                                </Button>
                            </div>

                            <div className="space-y-2">
                                {(['allow', 'ask', 'deny'] as const).map((bucket) => {
                                    const rules = permState.cli.permissions[bucket] || [];
                                    if (rules.length === 0) return null;
                                    const badgeCls = bucket === 'allow'
                                        ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
                                        : bucket === 'ask'
                                            ? 'bg-amber-500/10 text-amber-300 border-amber-500/30'
                                            : 'bg-rose-500/10 text-rose-300 border-rose-500/30';
                                    return (
                                        <div key={bucket} className="space-y-1">
                                            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{bucket}</span>
                                            <div className="flex flex-wrap gap-1.5">
                                                {rules.map((r) => (
                                                    <span key={r} className={cn('inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-mono', badgeCls)}>
                                                        <span>{r}</span>
                                                        <button
                                                            type="button"
                                                            onClick={() => removeRule(bucket, r)}
                                                            disabled={saving}
                                                            className="hover:opacity-80 cursor-pointer"
                                                            aria-label={`删除规则 ${r}`}
                                                        >
                                                            <Trash2 className="h-2.5 w-2.5" />
                                                        </button>
                                                    </span>
                                                ))}
                                            </div>
                                        </div>
                                    );
                                })}
                                {permState.cli.permissions.allow.length === 0 &&
                                    permState.cli.permissions.ask.length === 0 &&
                                    permState.cli.permissions.deny.length === 0 && (
                                        <p className="text-[11px] text-muted-foreground/70">
                                            暂无自定义规则（当前按上方权限预设与策略运行）。
                                        </p>
                                    )}
                            </div>
                        </div>
                    </>
                )}
            </CardContent>
        </Card>
    );
}
