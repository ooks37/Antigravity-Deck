'use client';

import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import {
    Activity,
    ArrowLeftRight,
    Check,
    Globe,
    Loader2,
    Network,
    Pencil,
    Plus,
    Power,
    RefreshCw,
    RotateCw,
    Shield,
    Trash2,
} from 'lucide-react';
import {
    addProxyNode,
    deleteProxyNode,
    getProxyIpStatus,
    getProxyState,
    rotateProxyNode,
    testProxyNode,
    updateProxyNode,
    updateProxyPreferences,
    useProxyNode,
    type ProxyNode,
    type ProxyState,
    type ProxyTestResult,
} from '@/lib/cascade-api';

interface NodeFormState {
    mode: 'url' | 'fields';
    editingId: string | null;
    name: string;
    url: string;
    protocol: 'socks5h' | 'socks5' | 'socks4' | 'http' | 'https';
    host: string;
    port: string;
    username: string;
    password: string;
    activate: boolean;
}

const EMPTY_FORM: NodeFormState = {
    mode: 'url',
    editingId: null,
    name: '',
    url: '',
    protocol: 'socks5h',
    host: '',
    port: '1080',
    username: '',
    password: '',
    activate: true,
};

export function ProxyPanel() {
    const [state, setState] = useState<ProxyState | null>(null);
    const [directIp, setDirectIp] = useState<ProxyTestResult | null>(null);
    const [proxiedIp, setProxiedIp] = useState<ProxyTestResult | null>(null);
    const [bypassDraft, setBypassDraft] = useState('127.0.0.1,localhost,::1,0.0.0.0');

    const [loading, setLoading] = useState(true);
    const [checkingIp, setCheckingIp] = useState(false);
    const [busyKey, setBusyKey] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);

    const [showDialog, setShowDialog] = useState(false);
    const [form, setForm] = useState<NodeFormState>(EMPTY_FORM);
    const [draftTest, setDraftTest] = useState<ProxyTestResult | null>(null);
    const [deleteTarget, setDeleteTarget] = useState<ProxyNode | null>(null);

    const loadState = useCallback(async () => {
        try {
            const st = await getProxyState();
            setState(st);
            setBypassDraft(st.bypassHosts || '127.0.0.1,localhost,::1,0.0.0.0');
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : '加载代理设置失败');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        loadState();
        const handler = (e: Event) => {
            const detail = (e as CustomEvent<ProxyState | undefined>).detail;
            if (detail) setState(detail);
            else loadState();
        };
        window.addEventListener('proxy-updated', handler);
        return () => window.removeEventListener('proxy-updated', handler);
    }, [loadState]);

    const emitUpdated = (next: ProxyState) => {
        setState(next);
        window.dispatchEvent(new CustomEvent('proxy-updated', { detail: next }));
    };

    const handleCheckIps = async () => {
        setCheckingIp(true);
        setError(null);
        try {
            const res = await getProxyIpStatus();
            setDirectIp(res.direct);
            setProxiedIp(res.proxied);
            emitUpdated(res.state);
        } catch (err) {
            setError(err instanceof Error ? err.message : '检测出口 IP 失败');
        } finally {
            setCheckingIp(false);
        }
    };

    const handleTestNode = async (id: string) => {
        setBusyKey(`test:${id}`);
        setError(null);
        try {
            const res = await testProxyNode({ id });
            if (res.state) emitUpdated(res.state);
            if (res.result.ok) {
                setNotice(`节点测试通过 · 出口 IP: ${res.result.exitIp || '未知'} (${res.result.country || '-'} · ${res.result.latencyMs}ms)`);
            } else {
                setError(`节点测试失败: ${res.result.error || '无法连接'}`);
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : '测试节点失败');
        } finally {
            setBusyKey(null);
        }
    };

    const handleUseNode = async (id: string | null) => {
        setBusyKey(`use:${id || 'direct'}`);
        setError(null);
        setNotice(null);
        try {
            const res = await useProxyNode(id);
            emitUpdated(res.state);
            setProxiedIp(null);
            setNotice(
                res.state.enabled && res.state.activeNode
                    ? `已切换出站代理至「${res.state.activeNode.name}」(${res.state.activeNode.protocol}://${res.state.activeNode.host}:${res.state.activeNode.port})，所有新启动的 agy/IDE 进程将自动走此 IP`
                    : '已切回服务器直连模式（不使用外部代理）',
            );
        } catch (err) {
            setError(err instanceof Error ? err.message : '切换代理失败');
        } finally {
            setBusyKey(null);
        }
    };

    const handleRotate = async () => {
        setBusyKey('rotate');
        setError(null);
        setNotice(null);
        try {
            const res = await rotateProxyNode();
            emitUpdated(res.state);
            setProxiedIp(null);
            if (res.state.activeNode) {
                setNotice(`已轮换至节点「${res.state.activeNode.name}」(${res.state.activeNode.host}:${res.state.activeNode.port})`);
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : '轮换节点失败');
        } finally {
            setBusyKey(null);
        }
    };

    const handleToggleApplyIde = async (checked: boolean) => {
        setBusyKey('prefs');
        try {
            const res = await updateProxyPreferences({ applyToIde: checked });
            emitUpdated(res.state);
        } catch (err) {
            setError(err instanceof Error ? err.message : '更新代理配置失败');
        } finally {
            setBusyKey(null);
        }
    };

    const handleSaveBypass = async () => {
        setBusyKey('bypass');
        try {
            const res = await updateProxyPreferences({ bypassHosts: bypassDraft });
            emitUpdated(res.state);
            setNotice('已更新本地直连绕过名单（始终保留 127.0.0.1 / localhost）');
        } catch (err) {
            setError(err instanceof Error ? err.message : '保存忽略列表失败');
        } finally {
            setBusyKey(null);
        }
    };

    const buildPayloadFromForm = () => {
        if (form.mode === 'url' && !form.editingId) {
            return {
                name: form.name.trim() || undefined,
                url: form.url.trim(),
                activate: form.activate,
            };
        }
        return {
            name: form.name.trim() || undefined,
            protocol: form.protocol,
            host: form.host.trim(),
            port: form.port.trim(),
            username: form.username.trim(),
            password: form.password,
            activate: form.activate,
        };
    };

    const handleTestDraft = async () => {
        setBusyKey('test-draft');
        setDraftTest(null);
        setError(null);
        try {
            const payload = buildPayloadFromForm();
            const res = await testProxyNode(payload);
            setDraftTest(res.result);
        } catch (err) {
            setError(err instanceof Error ? err.message : '测试草稿失败');
        } finally {
            setBusyKey(null);
        }
    };

    const handleSaveNode = async () => {
        setBusyKey('save-node');
        setError(null);
        try {
            const payload = buildPayloadFromForm();
            if (form.editingId) {
                const res = await updateProxyNode(form.editingId, payload);
                emitUpdated(res.state);
                setNotice(`已更新代理节点「${res.node.name}」`);
            } else {
                const res = await addProxyNode(payload);
                emitUpdated(res.state);
                setNotice(form.activate ? `已添加并启用节点「${res.node.name}」` : `已添加代理节点「${res.node.name}」`);
            }
            setShowDialog(false);
            setForm(EMPTY_FORM);
            setDraftTest(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : '保存代理节点失败');
        } finally {
            setBusyKey(null);
        }
    };

    const handleConfirmDelete = async () => {
        if (!deleteTarget) return;
        const target = deleteTarget;
        setDeleteTarget(null);
        setBusyKey(`del:${target.id}`);
        setError(null);
        try {
            const res = await deleteProxyNode(target.id);
            emitUpdated(res.state);
            setNotice(`已删除代理节点「${target.name}」`);
        } catch (err) {
            setError(err instanceof Error ? err.message : '删除节点失败');
        } finally {
            setBusyKey(null);
        }
    };

    const openEdit = (node: ProxyNode) => {
        setForm({
            mode: 'fields',
            editingId: node.id,
            name: node.name,
            url: '',
            protocol: node.protocol,
            host: node.host,
            port: String(node.port),
            username: node.username || '',
            password: '',
            activate: state?.activeNodeId === node.id && Boolean(state?.enabled),
        });
        setDraftTest(node.lastTest);
        setShowDialog(true);
    };

    if (loading) {
        return (
            <Card className="border-border/50">
                <CardContent className="p-5 flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    正在加载代理配置...
                </CardContent>
            </Card>
        );
    }

    const nodes = state?.nodes || [];
    const activeNode = state?.activeNode || null;

    return (
        <>
            <Card className="border-border/50">
                <CardHeader className="pb-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                            <CardTitle className="text-sm flex items-center gap-2">
                                <Network className="h-4 w-4 text-emerald-400" />
                                出站代理池（SOCKS5h / SOCKS5 / HTTP）
                                {state?.enabled && activeNode ? (
                                    <Badge className="text-[10px] h-4 px-1.5 bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/20">
                                        已启用 · {activeNode.name}
                                    </Badge>
                                ) : (
                                    <Badge variant="outline" className="text-[10px] h-4 px-1.5 text-muted-foreground">
                                        直连模式
                                    </Badge>
                                )}
                            </CardTitle>
                            <CardDescription className="text-xs mt-1">
                                防止服务器单 IP 被限流/封禁，随时一键切换新出口 IP（支持远程 DNS 防泄漏 <code className="text-[10px]">socks5h://</code>）
                            </CardDescription>
                        </div>

                        <div className="flex items-center gap-1.5 flex-wrap">
                            <Button
                                size="sm"
                                variant="outline"
                                className="h-7 text-xs gap-1"
                                onClick={handleCheckIps}
                                disabled={checkingIp || busyKey !== null}
                            >
                                {checkingIp ? <Loader2 className="h-3 w-3 animate-spin" /> : <Globe className="h-3 w-3" />}
                                查出口 IP
                            </Button>
                            {nodes.length >= 2 && (
                                <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-7 text-xs gap-1"
                                    onClick={handleRotate}
                                    disabled={busyKey !== null}
                                >
                                    <RotateCw className={`h-3 w-3 ${busyKey === 'rotate' ? 'animate-spin' : ''}`} />
                                    换下一个 IP
                                </Button>
                            )}
                            <Button
                                size="sm"
                                className="h-7 text-xs gap-1"
                                disabled={busyKey !== null}
                                onClick={() => {
                                    setForm({ ...EMPTY_FORM });
                                    setDraftTest(null);
                                    setShowDialog(true);
                                }}
                            >
                                <Plus className="h-3 w-3" />
                                添加代理节点
                            </Button>
                        </div>
                    </div>
                </CardHeader>

                <CardContent className="space-y-4">
                    {error && (
                        <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-md px-3 py-2 flex items-center justify-between gap-2">
                            <span>{error}</span>
                            <button onClick={() => setError(null)} className="text-red-300/70 hover:text-red-200">✕</button>
                        </div>
                    )}
                    {notice && (
                        <div className="text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-md px-3 py-2 flex items-center justify-between gap-2">
                            <span>{notice}</span>
                            <button onClick={() => setNotice(null)} className="text-emerald-300/70 hover:text-emerald-200">✕</button>
                        </div>
                    )}

                    {/* Current Status & Direct vs Proxy IP Comparison */}
                    <div className="rounded-lg border border-border/50 bg-muted/15 p-3 space-y-2.5">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="text-xs flex items-center gap-2 min-w-0">
                                <Shield className={`h-4 w-4 shrink-0 ${state?.enabled ? 'text-emerald-400' : 'text-muted-foreground'}`} />
                                {state?.enabled && activeNode ? (
                                    <span className="truncate">
                                        当前激活: <strong>{activeNode.name}</strong>{' '}
                                        <code className="text-[11px] text-muted-foreground bg-background/60 px-1.5 py-0.5 rounded">{activeNode.maskedUrl}</code>
                                    </span>
                                ) : (
                                    <span className="text-muted-foreground">当前使用服务器原生网络直连（本地 127.0.0.1 RPC 始终直连）</span>
                                )}
                            </div>
                            {state?.enabled && (
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-6 px-2 text-[11px] text-amber-400 hover:text-amber-300 gap-1"
                                    disabled={busyKey !== null}
                                    onClick={() => handleUseNode(null)}
                                >
                                    <Power className="h-3 w-3" />
                                    切回直连
                                </Button>
                            )}
                        </div>

                        {(directIp || proxiedIp) && (
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1 text-[11px]">
                                <div className="rounded-md bg-background/50 border border-border/40 px-2.5 py-1.5 flex items-center justify-between gap-2">
                                    <span className="text-muted-foreground">本机直连出口:</span>
                                    <span className="font-mono">
                                        {directIp?.ok ? `${directIp.exitIp} (${directIp.country || '-'})` : (directIp?.error || '检测失败')}
                                    </span>
                                </div>
                                {state?.enabled && (
                                    <div className="rounded-md bg-background/50 border border-emerald-500/25 px-2.5 py-1.5 flex items-center justify-between gap-2">
                                        <span className="text-emerald-400">当前代理出口:</span>
                                        <span className="font-mono text-emerald-300">
                                            {proxiedIp?.ok
                                                ? `${proxiedIp.exitIp} (${proxiedIp.country || '-'} · ${proxiedIp.latencyMs}ms)`
                                                : (proxiedIp?.error || '不可用')}
                                        </span>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>

                    {/* Node List */}
                    {nodes.length === 0 ? (
                        <div className="p-4 rounded-lg border border-dashed border-border/50 bg-muted/10 text-center space-y-2">
                            <p className="text-xs text-muted-foreground">
                                尚未添加代理节点。可添加 <code className="text-[10px]">socks5h://user:pass@ip:port</code> 或本地 <code className="text-[10px]">127.0.0.1:40000</code>（如 WARP / sing-box / 落地 Socks5），在主 IP 失效时立即切换。
                            </p>
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {nodes.map((node) => {
                                const isActive = Boolean(state?.enabled && state?.activeNodeId === node.id);
                                return (
                                    <div
                                        key={node.id}
                                        className={`flex flex-wrap items-center justify-between gap-2.5 p-3 rounded-lg border transition-colors ${
                                            isActive
                                                ? 'bg-emerald-500/8 border-emerald-500/35'
                                                : 'bg-muted/10 border-border/40 hover:border-border/70'
                                        }`}
                                    >
                                        <div className="min-w-0 space-y-1">
                                            <div className="flex items-center gap-1.5 flex-wrap">
                                                <span className="text-xs font-semibold">{node.name}</span>
                                                <Badge variant="secondary" className="text-[9px] h-4 px-1.5 uppercase font-mono">
                                                    {node.protocol}
                                                </Badge>
                                                {isActive && (
                                                    <Badge className="text-[9px] h-4 px-1.5 bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/20 gap-0.5">
                                                        <Check className="h-2.5 w-2.5" /> 使用中
                                                    </Badge>
                                                )}
                                                {node.lastTest && (
                                                    <Badge
                                                        variant="outline"
                                                        className={`text-[9px] h-4 px-1.5 font-mono ${
                                                            node.lastTest.ok
                                                                ? 'border-emerald-500/30 text-emerald-400'
                                                                : 'border-red-500/30 text-red-400'
                                                        }`}
                                                    >
                                                        {node.lastTest.ok
                                                            ? `${node.lastTest.exitIp || 'OK'} · ${node.lastTest.country || '-'} · ${node.lastTest.latencyMs}ms`
                                                            : '上次测速失败'}
                                                    </Badge>
                                                )}
                                            </div>
                                            <div className="text-[11px] font-mono text-muted-foreground truncate">
                                                {node.maskedUrl}
                                            </div>
                                        </div>

                                        <div className="flex items-center gap-1 flex-shrink-0">
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                className="h-7 px-2 text-xs gap-1"
                                                disabled={busyKey !== null}
                                                onClick={() => handleTestNode(node.id)}
                                                title="通过此节点探测实时出口 IP 与延迟"
                                            >
                                                {busyKey === `test:${node.id}` ? (
                                                    <Loader2 className="h-3 w-3 animate-spin" />
                                                ) : (
                                                    <Activity className="h-3 w-3" />
                                                )}
                                                测速
                                            </Button>
                                            {!isActive && (
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    className="h-7 px-2.5 text-xs gap-1"
                                                    disabled={busyKey !== null}
                                                    onClick={() => handleUseNode(node.id)}
                                                >
                                                    <ArrowLeftRight className="h-3 w-3" />
                                                    启用
                                                </Button>
                                            )}
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                                                disabled={busyKey !== null}
                                                onClick={() => openEdit(node)}
                                                title="编辑节点"
                                            >
                                                <Pencil className="h-3.5 w-3.5" />
                                            </Button>
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                                                disabled={busyKey !== null}
                                                onClick={() => setDeleteTarget(node)}
                                                title="删除节点"
                                            >
                                                <Trash2 className="h-3.5 w-3.5" />
                                            </Button>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}

                    {/* Preferences */}
                    <div className="pt-2 border-t border-border/30 space-y-3">
                        <div className="flex items-center justify-between gap-2">
                            <div>
                                <span className="text-xs font-medium">启动 Antigravity IDE 时自动注入代理</span>
                                <p className="text-[11px] text-muted-foreground">
                                    除环境变量外，同时传递 <code className="text-[10px]">--proxy-server</code> 与 <code className="text-[10px]">--proxy-bypass-list</code>
                                </p>
                            </div>
                            <Switch
                                checked={Boolean(state?.applyToIde)}
                                disabled={busyKey !== null}
                                onCheckedChange={handleToggleApplyIde}
                            />
                        </div>
                        <div className="space-y-1.5">
                            <label className="text-[11px] text-muted-foreground">本地直连绕过列表（NO_PROXY，逗号分隔）</label>
                            <div className="flex gap-2">
                                <Input
                                    value={bypassDraft}
                                    onChange={(e) => setBypassDraft(e.target.value)}
                                    className="font-mono text-xs h-8 flex-1"
                                    placeholder="127.0.0.1,localhost,::1,0.0.0.0"
                                />
                                <Button size="sm" variant="outline" className="h-8 text-xs" onClick={handleSaveBypass} disabled={busyKey !== null}>
                                    保存绕过
                                </Button>
                            </div>
                        </div>
                    </div>
                </CardContent>
            </Card>

            {/* Add / Edit Proxy Node Dialog */}
            <Dialog
                open={showDialog}
                onOpenChange={(open) => {
                    setShowDialog(open);
                    if (!open) {
                        setForm(EMPTY_FORM);
                        setDraftTest(null);
                    }
                }}
            >
                <DialogContent className="sm:max-w-[460px]">
                    <DialogHeader>
                        <DialogTitle>{form.editingId ? '编辑代理节点' : '添加 SOCKS5h / HTTP 代理节点'}</DialogTitle>
                        <DialogDescription>
                            支持 <code className="text-[11px]">socks5h://</code>（远程解析 DNS，防污染）、<code className="text-[11px]">socks5://</code>、<code className="text-[11px]">socks4://</code> 与 <code className="text-[11px]">http(s)://</code>。
                        </DialogDescription>
                    </DialogHeader>

                    <div className="space-y-3 py-1">
                        {!form.editingId && (
                            <div className="flex gap-1.5">
                                <Button
                                    type="button"
                                    size="sm"
                                    variant={form.mode === 'url' ? 'secondary' : 'ghost'}
                                    className="h-7 text-xs"
                                    onClick={() => setForm((f) => ({ ...f, mode: 'url' }))}
                                >
                                    快速粘贴 URL / IP:端口
                                </Button>
                                <Button
                                    type="button"
                                    size="sm"
                                    variant={form.mode === 'fields' ? 'secondary' : 'ghost'}
                                    className="h-7 text-xs"
                                    onClick={() => setForm((f) => ({ ...f, mode: 'fields' }))}
                                >
                                    逐项填写参数
                                </Button>
                            </div>
                        )}

                        <div className="space-y-1.5">
                            <label className="text-xs font-medium text-muted-foreground">节点备注名（选填）</label>
                            <Input
                                value={form.name}
                                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                                placeholder="例如：美西备用住宅IP / WARP-40000"
                            />
                        </div>

                        {form.mode === 'url' && !form.editingId ? (
                            <div className="space-y-1.5">
                                <label className="text-xs font-medium text-muted-foreground">代理地址</label>
                                <Input
                                    value={form.url}
                                    onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
                                    placeholder="socks5h://user:pass@1.2.3.4:1080 或 ip:port:user:pass"
                                    className="font-mono text-xs"
                                    autoFocus
                                />
                            </div>
                        ) : (
                            <>
                                <div className="grid grid-cols-3 gap-2">
                                    <div className="space-y-1">
                                        <label className="text-xs font-medium text-muted-foreground">协议</label>
                                        <Select
                                            value={form.protocol}
                                            onValueChange={(v) => setForm((f) => ({ ...f, protocol: v as NodeFormState['protocol'] }))}
                                        >
                                            <SelectTrigger className="h-9 text-xs font-mono">
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="socks5h">socks5h</SelectItem>
                                                <SelectItem value="socks5">socks5</SelectItem>
                                                <SelectItem value="socks4">socks4</SelectItem>
                                                <SelectItem value="http">http</SelectItem>
                                                <SelectItem value="https">https</SelectItem>
                                            </SelectContent>
                                        </Select>
                                    </div>
                                    <div className="col-span-2 space-y-1">
                                        <label className="text-xs font-medium text-muted-foreground">主机 IP / 域名</label>
                                        <Input
                                            value={form.host}
                                            onChange={(e) => setForm((f) => ({ ...f, host: e.target.value }))}
                                            placeholder="127.0.0.1"
                                            className="font-mono text-xs"
                                        />
                                    </div>
                                </div>
                                <div className="grid grid-cols-3 gap-2">
                                    <div className="space-y-1">
                                        <label className="text-xs font-medium text-muted-foreground">端口</label>
                                        <Input
                                            value={form.port}
                                            onChange={(e) => setForm((f) => ({ ...f, port: e.target.value }))}
                                            placeholder="1080"
                                            className="font-mono text-xs"
                                        />
                                    </div>
                                    <div className="space-y-1">
                                        <label className="text-xs font-medium text-muted-foreground">用户名（选填）</label>
                                        <Input
                                            value={form.username}
                                            onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
                                            className="font-mono text-xs"
                                        />
                                    </div>
                                    <div className="space-y-1">
                                        <label className="text-xs font-medium text-muted-foreground">密码（选填）</label>
                                        <Input
                                            type="password"
                                            value={form.password}
                                            onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                                            placeholder={form.editingId ? '留空保留原密码' : ''}
                                            className="font-mono text-xs"
                                        />
                                    </div>
                                </div>
                            </>
                        )}

                        {!form.editingId && (
                            <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                                <Checkbox checked={form.activate} onCheckedChange={(v) => setForm((f) => ({ ...f, activate: v === true }))} />
                                <span>保存后立即设为当前活跃代理</span>
                            </label>
                        )}

                        {draftTest && (
                            <div className={`text-xs rounded-md px-3 py-2 border ${draftTest.ok ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-400' : 'bg-red-500/10 border-red-500/25 text-red-400'}`}>
                                {draftTest.ok
                                    ? `✓ 连通正常 · 出口 IP: ${draftTest.exitIp || '未知'} (${draftTest.country || '-'} · ${draftTest.org || ''}) · ${draftTest.latencyMs}ms`
                                    : `✗ 测试失败: ${draftTest.error || '连接失败'}`}
                            </div>
                        )}
                    </div>

                    <DialogFooter className="gap-2 sm:gap-1">
                        <Button type="button" variant="outline" size="sm" onClick={handleTestDraft} disabled={busyKey !== null} className="gap-1">
                            {busyKey === 'test-draft' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                            先测试连通
                        </Button>
                        <Button type="button" size="sm" onClick={handleSaveNode} disabled={busyKey !== null}>
                            {busyKey === 'save-node' && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />}
                            保存节点
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Delete Proxy Node AlertDialog */}
            <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>删除代理节点「{deleteTarget?.name}」？</AlertDialogTitle>
                        <AlertDialogDescription>
                            将从本地代理池移除节点 {deleteTarget?.maskedUrl}。{state?.activeNodeId === deleteTarget?.id ? '删除当前激活节点后将自动切回直连模式。' : ''}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>取消</AlertDialogCancel>
                        <AlertDialogAction onClick={handleConfirmDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                            确认删除
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    );
}
