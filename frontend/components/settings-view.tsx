'use client';
import { useState, useEffect, useCallback } from 'react';
import { API_BASE } from '@/lib/config';
import { authHeaders } from '@/lib/auth';
import { getSettings, updateSettings, getAgyStatus, getAgyChangelog, triggerAgyUpdate } from '@/lib/cascade-api';
import type { AppSettings, AgyStatus, AgyChangelog, AgyUpdateResult } from '@/lib/cascade-api';
import { cn } from '@/lib/utils';
import { Check, X, Sparkles, CircleDot, Bot, Settings, Globe, Camera, Star, Bell, Terminal, RefreshCw, Download, FileText, Loader2 } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { ProxyPanel } from './proxy-panel';
import { PermissionsPanel } from './permissions-panel';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import {
    Select,
    SelectContent,
    SelectGroup,
    SelectItem,
    SelectLabel,
    SelectSeparator,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { notificationService, NOTIFICATION_SETTINGS_CHANGED } from '@/lib/notifications';
import type { NotificationSettings } from '@/lib/notifications';

interface Model {
    label: string;
    modelId: string;
    supportsImages: boolean;
    isRecommended: boolean;
    quota: number;
}

export function SettingsView() {
    const [settings, setSettings] = useState<AppSettings | null>(null);
    const [models, setModels] = useState<Model[]>([]);
    const [apiDefaultModel, setApiDefaultModel] = useState('');
    const [workspaceRoot, setWorkspaceRoot] = useState('');
    const [defaultModel, setDefaultModel] = useState('');
    const [agyBinaryPath, setAgyBinaryPath] = useState('');
    const [agyStatus, setAgyStatus] = useState<AgyStatus | null>(null);
    const [agyLoading, setAgyLoading] = useState(false);
    const [agyUpdating, setAgyUpdating] = useState(false);
    const [agyUpdateResult, setAgyUpdateResult] = useState<AgyUpdateResult | null>(null);
    const [showAgyChangelog, setShowAgyChangelog] = useState(false);
    const [agyChangelog, setAgyChangelog] = useState<AgyChangelog | null>(null);
    const [loadingChangelog, setLoadingChangelog] = useState(false);
    const [saving, setSaving] = useState(false);
    const [saveMsg, setSaveMsg] = useState('');
    const [loading, setLoading] = useState(true);

    // === Push notification settings (localStorage, not server) ===
    const [notiSettings, setNotiSettings] = useState<NotificationSettings>(() =>
        notificationService?.getSettings() ?? { enabled: false, events: { cascadeComplete: true, waitingForUser: true, error: true, autoAccepted: false } }
    );
    const [notiPermission, setNotiPermission] = useState<NotificationPermission>(() =>
        notificationService?.getPermission() ?? 'default'
    );

    useEffect(() => {
        const handler = () => {
            if (!notificationService) return;
            setNotiSettings(notificationService.getSettings());
            setNotiPermission(notificationService.getPermission());
        };
        window.addEventListener(NOTIFICATION_SETTINGS_CHANGED, handler);
        return () => window.removeEventListener(NOTIFICATION_SETTINGS_CHANGED, handler);
    }, []);

    const refreshAgy = useCallback(async () => {
        setAgyLoading(true);
        try {
            const st = await getAgyStatus(true);
            setAgyStatus(st);
        } catch (e) {
            console.error('Failed to load agy status:', e);
        } finally {
            setAgyLoading(false);
        }
    }, []);

    const handleAgyUpdate = async () => {
        setAgyUpdating(true);
        setAgyUpdateResult(null);
        try {
            const res = await triggerAgyUpdate();
            setAgyUpdateResult(res);
            await refreshAgy();
            if (showAgyChangelog) {
                const cl = await getAgyChangelog(120).catch(() => null);
                if (cl) setAgyChangelog(cl);
            }
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : '执行 agy 更新失败';
            setAgyUpdateResult({ success: false, error: msg });
        } finally {
            setAgyUpdating(false);
        }
    };

    const handleToggleChangelog = async () => {
        const next = !showAgyChangelog;
        setShowAgyChangelog(next);
        if (next && !agyChangelog) {
            setLoadingChangelog(true);
            try {
                const cl = await getAgyChangelog(120);
                setAgyChangelog(cl);
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : '读取更新日志失败';
                setAgyChangelog({ found: false, latestEntryVersion: null, text: '', truncated: false, totalLines: 0, error: msg });
            } finally {
                setLoadingChangelog(false);
            }
        }
    };

    const loadAll = useCallback(async () => {
        setLoading(true);
        try {
            const [settingsData, modelsRes, agyData] = await Promise.all([
                getSettings(),
                fetch(`${API_BASE}/api/models`, { headers: authHeaders() })
                    .then(r => (r.ok ? r.json() : { models: [], defaultModel: '' }))
                    .catch(() => ({ models: [], defaultModel: '' })),
                getAgyStatus(true).catch(() => null),
            ]);
            setSettings(settingsData);
            setWorkspaceRoot(settingsData.defaultWorkspaceRoot || '');
            setDefaultModel(settingsData.defaultModel || '__api_default__');
            setAgyBinaryPath(settingsData.agyBinaryPath || '');
            setModels(modelsRes.models || []);
            setApiDefaultModel(modelsRes.defaultModel || '');
            setAgyStatus(agyData);
        } catch (e) {
            console.error('Failed to load settings:', e);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { loadAll(); }, [loadAll]);

    const handleSave = async () => {
        setSaving(true);
        setSaveMsg('');
        try {
            const updated = await updateSettings({
                defaultWorkspaceRoot: workspaceRoot.trim(),
                defaultModel: defaultModel === '__api_default__' ? '' : defaultModel,
                agyBinaryPath: agyBinaryPath.trim(),
            });
            setSettings(updated);
            setSaveMsg('saved');
            refreshAgy();
            setTimeout(() => setSaveMsg(''), 2500);
        } catch {
            setSaveMsg('error');
        } finally {
            setSaving(false);
        }
    };

    const realDefault = defaultModel === '__api_default__' ? '' : defaultModel;
    const hasChanges = settings && (
        workspaceRoot.trim() !== (settings.defaultWorkspaceRoot || '') ||
        realDefault !== (settings.defaultModel || '') ||
        agyBinaryPath.trim() !== (settings.agyBinaryPath || '')
    );

    const geminiModels = models.filter(m => m.label.toLowerCase().includes('gemini'));
    const claudeModels = models.filter(m => m.label.toLowerCase().includes('claude'));
    const otherModels = models.filter(m =>
        !m.label.toLowerCase().includes('gemini') && !m.label.toLowerCase().includes('claude')
    );

    const getModelIcon = (label: string) => {
        if (label.toLowerCase().includes('gemini')) return <Sparkles className="h-3.5 w-3.5 text-sky-400" />;
        if (label.toLowerCase().includes('claude')) return <CircleDot className="h-3.5 w-3.5 text-purple-400" />;
        if (label.toLowerCase().includes('gpt')) return <CircleDot className="h-3.5 w-3.5 text-emerald-400" />;
        return <Bot className="h-3.5 w-3.5" />;
    };

    if (loading) {
        return (
            <div className="flex-1 overflow-y-auto">
                <div className="max-w-2xl mx-auto p-6 space-y-4">
                    <Skeleton className="h-6 w-24" />
                    <Skeleton className="h-32 w-full rounded-lg" />
                    <Skeleton className="h-24 w-full rounded-lg" />
                    <Skeleton className="h-20 w-full rounded-lg" />
                </div>
            </div>
        );
    }

    return (
        <div className="flex-1 overflow-y-auto">
            <div className="max-w-2xl mx-auto p-6 space-y-4">

                {/* Header */}
                <div className="flex items-center gap-2">
                    <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5"><Settings className="h-3.5 w-3.5" /> 应用设置</h2>
                    <div className="flex-1 h-px bg-border/30" />
                </div>

                {/* Antigravity CLI (agy) Version & Manual Updater */}
                <Card>
                    <CardHeader className="pb-3">
                        <div className="flex items-center justify-between gap-2">
                            <CardTitle className="text-xs font-semibold flex items-center gap-1.5">
                                <Terminal className="h-3.5 w-3.5 text-primary" /> Antigravity CLI (`agy`) 版本与更新
                            </CardTitle>
                            <span className={cn(
                                "text-[10px] px-2 py-0.5 rounded-full font-mono border",
                                agyStatus?.found
                                    ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
                                    : "bg-amber-500/10 text-amber-400 border-amber-500/30"
                            )}>
                                {agyStatus?.found
                                    ? `v${agyStatus.version || '未知版本'}`
                                    : '未检测到 agy'}
                            </span>
                        </div>
                        <CardDescription className="text-[10px]">
                            不锁定 CLI 版本，支持随时一键检测并手动升级主机上的最新官方 agy CLI。
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        <div className="rounded-lg border border-border/50 bg-muted/20 p-3 space-y-1.5 text-xs">
                            <div className="flex items-center justify-between gap-2">
                                <span className="text-muted-foreground">当前版本</span>
                                <span className="font-mono text-foreground">
                                    {agyStatus?.found ? (agyStatus.version || '已安装（无法解析版本号）') : '未安装 / 未找到'}
                                </span>
                            </div>
                            <div className="flex items-start justify-between gap-2">
                                <span className="text-muted-foreground flex-shrink-0">程序路径</span>
                                <span className="font-mono text-[11px] text-foreground/90 text-right break-all">
                                    {agyStatus?.path || agyStatus?.configuredPath || '自动探测失败'}
                                </span>
                            </div>
                            {agyStatus?.lastUpdateAt && (
                                <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground/80 pt-1 border-t border-border/30">
                                    <span>上次手动检查/更新</span>
                                    <span>{new Date(agyStatus.lastUpdateAt).toLocaleString('zh-CN')}</span>
                                </div>
                            )}
                            {agyStatus?.error && (
                                <p className="text-[11px] text-amber-400 pt-1">{agyStatus.error}</p>
                            )}
                        </div>

                        <div className="space-y-1.5">
                            <label className="text-[11px] text-muted-foreground block">
                                自定义 `agy` 可执行文件路径（可选，留空自动从系统 PATH 或默认目录探测，修改后请点击底部“保存设置”）
                            </label>
                            <Input
                                value={agyBinaryPath}
                                onChange={e => setAgyBinaryPath(e.target.value)}
                                placeholder="例如 C:\Users\you\AppData\Local\agy\bin\agy.exe 或 /usr/local/bin/agy"
                                className="font-mono text-xs"
                            />
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                            <Button
                                type="button"
                                size="sm"
                                className="text-xs h-8 gap-1.5"
                                onClick={handleAgyUpdate}
                                disabled={agyUpdating || !agyStatus?.found}
                            >
                                {agyUpdating ? (
                                    <><Loader2 className="h-3.5 w-3.5 animate-spin" /> 正在更新 agy...</>
                                ) : (
                                    <><Download className="h-3.5 w-3.5" /> 手动更新至最新版</>
                                )}
                            </Button>
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="text-xs h-8 gap-1.5"
                                onClick={refreshAgy}
                                disabled={agyLoading || agyUpdating}
                            >
                                <RefreshCw className={cn("h-3.5 w-3.5", agyLoading && "animate-spin")} />
                                刷新状态
                            </Button>
                            <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="text-xs h-8 gap-1.5"
                                onClick={handleToggleChangelog}
                                disabled={!agyStatus?.found}
                            >
                                <FileText className="h-3.5 w-3.5" />
                                {showAgyChangelog ? '收起更新日志' : '查看更新日志'}
                            </Button>
                        </div>

                        {agyUpdateResult && (
                            <div className={cn(
                                "rounded-md border p-2.5 text-xs space-y-1",
                                agyUpdateResult.success
                                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                                    : "border-destructive/40 bg-destructive/10 text-destructive"
                            )}>
                                <div className="font-medium flex items-center gap-1.5">
                                    {agyUpdateResult.success ? <Check className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
                                    <span>
                                        {agyUpdateResult.success
                                            ? agyUpdateResult.updated
                                                ? `更新完成：${agyUpdateResult.previousVersion || '?'} → ${agyUpdateResult.version || '?'}`
                                                : `检查完成：当前已是最新版本 (${agyUpdateResult.version || '未知'})`
                                            : `更新失败：${agyUpdateResult.error || '未知错误'}`}
                                    </span>
                                </div>
                                {agyUpdateResult.output && (
                                    <pre className="text-[10px] font-mono whitespace-pre-wrap opacity-90 max-h-32 overflow-y-auto">
                                        {agyUpdateResult.output}
                                    </pre>
                                )}
                            </div>
                        )}

                        {showAgyChangelog && (
                            <div className="rounded-md border border-border/50 bg-background/60 p-2.5">
                                {loadingChangelog ? (
                                    <div className="text-xs text-muted-foreground flex items-center gap-2 py-2">
                                        <Loader2 className="h-3.5 w-3.5 animate-spin" /> 正在读取 agy changelog...
                                    </div>
                                ) : agyChangelog?.error ? (
                                    <p className="text-xs text-destructive">{agyChangelog.error}</p>
                                ) : (
                                    <pre className="text-[11px] font-mono text-muted-foreground whitespace-pre-wrap max-h-56 overflow-y-auto leading-relaxed">
                                        {agyChangelog?.text || '暂无更新日志内容'}
                                    </pre>
                                )}
                            </div>
                        )}
                    </CardContent>
                </Card>

                {/* Default Model */}
                <Card>
                    <CardHeader className="pb-3">
                        <CardTitle className="text-xs font-semibold">默认模型</CardTitle>
                        <CardDescription className="text-[10px]">
                            发起新对话时默认选用的模型，你随时可以在单次对话中临时切换。
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        <Select value={defaultModel} onValueChange={setDefaultModel}>
                            <SelectTrigger className="w-full">
                                <SelectValue placeholder="请选择模型" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="__api_default__">
                                    <span className="flex items-center gap-1.5">
                                        <Globe className="h-3.5 w-3.5" />
                                        跟随 API 默认 ({models.find(m => m.modelId === apiDefaultModel)?.label || '自动'})
                                    </span>
                                </SelectItem>

                                <SelectSeparator />

                                {geminiModels.length > 0 && (
                                    <SelectGroup>
                                        <SelectLabel>Gemini</SelectLabel>
                                        {geminiModels.map(m => (
                                            <SelectItem key={m.modelId} value={m.modelId}>
                                                <span className="flex items-center gap-2">
                                                    {getModelIcon(m.label)}
                                                    <span>{m.label}</span>
                                                    {m.modelId === apiDefaultModel && (
                                                        <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary ml-1">API 默认</span>
                                                    )}
                                                    {m.supportsImages && (
                                                        <span className="text-[9px] text-sky-400"><Camera className="h-3 w-3" /></span>
                                                    )}
                                                </span>
                                            </SelectItem>
                                        ))}
                                    </SelectGroup>
                                )}

                                {claudeModels.length > 0 && (
                                    <SelectGroup>
                                        <SelectLabel>Claude</SelectLabel>
                                        {claudeModels.map(m => (
                                            <SelectItem key={m.modelId} value={m.modelId}>
                                                <span className="flex items-center gap-2">
                                                    {getModelIcon(m.label)}
                                                    <span>{m.label}</span>
                                                    {m.modelId === apiDefaultModel && (
                                                        <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary ml-1">API 默认</span>
                                                    )}
                                                    {m.supportsImages && (
                                                        <span className="text-[9px] text-sky-400"><Camera className="h-3 w-3" /></span>
                                                    )}
                                                </span>
                                            </SelectItem>
                                        ))}
                                    </SelectGroup>
                                )}

                                {otherModels.length > 0 && (
                                    <SelectGroup>
                                        <SelectLabel>其他模型</SelectLabel>
                                        {otherModels.map(m => (
                                            <SelectItem key={m.modelId} value={m.modelId}>
                                                <span className="flex items-center gap-2">
                                                    {getModelIcon(m.label)}
                                                    <span>{m.label}</span>
                                                    {m.modelId === apiDefaultModel && (
                                                        <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary ml-1">API 默认</span>
                                                    )}
                                                </span>
                                            </SelectItem>
                                        ))}
                                    </SelectGroup>
                                )}
                            </SelectContent>
                        </Select>

                        {defaultModel && defaultModel !== '__api_default__' && (
                            <div className="text-[10px] text-primary/80 flex items-center gap-1">
                                <Star className="h-3 w-3 fill-primary text-primary" /> 当前设为：<strong>{models.find(m => m.modelId === defaultModel)?.label || defaultModel}</strong>
                            </div>
                        )}
                    </CardContent>
                </Card>

                {/* Chat Display */}

                {/* Default Workspace Root */}
                <Card>
                    <CardHeader className="pb-3">
                        <CardTitle className="text-xs font-semibold">默认工作区根目录</CardTitle>
                        <CardDescription className="text-[10px]">
                            新建的工作区将作为子目录创建在此路径下，已有子目录也会自动识别为可选工作区。
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <Input
                            value={workspaceRoot}
                            onChange={e => setWorkspaceRoot(e.target.value)}
                            placeholder="例如 /root/workspaces 或 C:\Users\you\Workspaces"
                            className="font-mono text-xs"
                        />
                    </CardContent>
                </Card>

                {/* Push Notifications */}
                <Card>
                    <CardHeader className="pb-3">
                        <CardTitle className="text-xs font-semibold flex items-center gap-1.5">
                            <Bell className="h-3.5 w-3.5" /> 推送通知
                        </CardTitle>
                        <CardDescription className="text-[10px]">
                            当对话执行完成、出现报错或等待审批时接收系统级桌面/移动端通知，即使标签页已最小化也能及时提醒。
                        </CardDescription>
                        <p className="text-[10px] text-blue-400/80 mt-1">
                            📲 <strong>提示：</strong>在手机端将其安装为 PWA 即可直接接收原生推送，无需额外授权繁琐配置。
                        </p>
                    </CardHeader>
                    <CardContent className="space-y-4">

                        {/* Step 1: Permission setup — prominent section */}
                        {notiPermission !== 'granted' && (
                            <div className="rounded-lg border border-border/50 bg-muted/30 p-3 space-y-3">
                                <div className="flex items-start gap-2">
                                    <span className="text-lg mt-0.5">🔔</span>
                                    <div className="space-y-1">
                                        <p className="text-xs font-medium">启用浏览器通知权限</p>
                                        <p className="text-[10px] text-muted-foreground leading-relaxed">
                                            {notiPermission === 'denied' ? (
                                                <>当前浏览器已<strong className="text-red-400">拦截</strong>通知权限，请按以下方式开启：</>
                                            ) : (
                                                <>点击下方按钮即可开启通知提醒（桌面端与手机浏览器均支持）。</>
                                            )}
                                        </p>
                                    </div>
                                </div>

                                {notiPermission === 'denied' ? (
                                    <div className="space-y-2 pl-7">
                                        <div className="text-[10px] text-muted-foreground space-y-1">
                                            <p><strong>桌面端 (Chrome/Edge)：</strong>点击地址栏左侧 🔒 图标 → 网站设置 → 通知 → 允许</p>
                                            <p><strong>移动端 (Chrome)：</strong>点击右上角 ⋮ 菜单 → 设置 → 网站设置 → 通知 → 找到本站点并允许</p>
                                            <p><strong>Safari (iOS)：</strong>前往系统设置 → Safari 浏览器 → 通知 → 找到本站点并允许</p>
                                        </div>
                                        <p className="text-[10px] text-amber-400/80">修改权限后，请刷新当前页面生效。</p>
                                    </div>
                                ) : (
                                    <Button
                                        variant="default"
                                        size="sm"
                                        className="ml-7 text-xs h-8 gap-1.5"
                                        onClick={() => notificationService?.requestPermission()}
                                    >
                                        <Bell className="h-3.5 w-3.5" />
                                        允许接收通知
                                    </Button>
                                )}
                            </div>
                        )}

                        {/* Permission granted badge */}
                        {notiPermission === 'granted' && (
                            <div className="flex items-center gap-2 text-[10px] text-emerald-400">
                                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                                浏览器通知权限已开启！
                            </div>
                        )}

                        {/* Master toggle */}
                        <div className="flex items-center justify-between">
                            <span className="text-xs">开启推送通知</span>
                            <Switch
                                checked={notiSettings.enabled}
                                onCheckedChange={(checked) => notificationService?.setEnabled(checked)}
                            />
                        </div>

                        {/* Per-event toggles */}
                        <div className={cn("space-y-2 border-t border-border/30 pt-3", !notiSettings.enabled && "opacity-40 pointer-events-none")}>
                            <span className="text-[10px] text-muted-foreground uppercase tracking-wider">通知触发事件</span>
                            {[
                                { key: 'cascadeComplete' as const, label: '任务运行完成', emoji: '✅' },
                                { key: 'waitingForUser' as const, label: '等待用户确认/审批', emoji: '⏳' },
                                { key: 'error' as const, label: '运行出错/失败', emoji: '❌' },
                                { key: 'autoAccepted' as const, label: '已自动放行操作', emoji: '⚡' },
                            ].map(({ key, label, emoji }) => (
                                <div key={key} className="flex items-center justify-between">
                                    <span className="text-xs flex items-center gap-1.5">
                                        <span>{emoji}</span> {label}
                                    </span>
                                    <Switch
                                        checked={notiSettings.events[key]}
                                        onCheckedChange={(checked) => notificationService?.setEventEnabled(key, checked)}
                                        className="scale-90"
                                    />
                                </div>
                            ))}
                        </div>

                        {/* Test button */}
                        <Button
                            variant="outline"
                            size="sm"
                            className="text-xs h-7"
                            onClick={() => notificationService?.testNotification()}
                            disabled={!notiSettings.enabled || notiPermission !== 'granted'}
                        >
                            发送测试通知
                        </Button>

                        {/* PWA install hint */}
                        <p className="text-[10px] text-muted-foreground/60 leading-relaxed">
                            💡 <strong>提示：</strong>为获得最佳移动端体验，可将本站安装为 PWA 应用（点击浏览器地址栏安装图标，或移动端选择“添加到主屏幕”）。
                        </p>
                    </CardContent>
                </Card>

                {/* Agent Permissions & Persistent Service */}
                <PermissionsPanel />

                {/* SOCKS5h / HTTP Proxy Pool */}
                <ProxyPanel />

                {/* Save */}
                <div className="flex items-center gap-3">
                    <Button
                        onClick={handleSave}
                        disabled={saving || !hasChanges}
                    >
                        {saving ? '保存中…' : '保存设置'}
                    </Button>
                    {saveMsg && (
                        <span className={cn("text-xs font-medium flex items-center gap-1", saveMsg === 'saved' ? "text-emerald-500" : "text-destructive")}>
                            {saveMsg === 'saved' ? <><Check className="h-3 w-3" /> 已保存！</> : <><X className="h-3 w-3" /> 保存失败</>}
                        </span>
                    )}
                    {hasChanges && !saveMsg && (
                        <span className="text-[10px] text-amber-500 flex items-center gap-1">
                            <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                            有未保存的更改
                        </span>
                    )}
                </div>

            </div>
        </div>
    );
}
