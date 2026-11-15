'use client';

import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
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
    ArrowLeftRight,
    Check,
    KeyRound,
    Loader2,
    Monitor,
    Pencil,
    Plus,
    RefreshCw,
    RotateCcw,
    RotateCw,
    Save,
    Server,
    ExternalLink,
    Gauge,
    ShieldCheck,
    Trash2,
    Upload,
    UserPlus,
    Users,
} from 'lucide-react';
import {
    autoOnboardProfile,
    cancelAddAccountFlow,
    createProfileEntry,
    deleteOAuthAccountEntry,
    deleteProfileEntry,
    getProfiles,
    importOAuthAccount,
    renameOAuthAccountEntry,
    renameProfileEntry,
    saveOAuthAccount,
    startAddAccountFlow,
    swapProfile,
    switchOAuthAccount,
    getOAuthQuotas,
    rotateOAuthAccount,
    startOAuthLoginUrl,
    completeOAuthCallback,
    type OAuthAccountMeta,
    type OAuthAccountQuota,
    type OAuthListResponse,
    type ProfileEntry,
    type ProfileEnvironment,
} from '@/lib/cascade-api';

interface ProfileSwitcherProps {
    detected?: boolean;
    onAccountChanged?: () => void;
}

type ConfirmAction =
    | { kind: 'swap-ide'; target: string }
    | { kind: 'delete-ide'; target: string }
    | { kind: 'start-add-ide' }
    | { kind: 'delete-oauth'; target: string; email?: string | null };

type RenameModalState =
    | { scope: 'oauth'; currentName: string; value: string }
    | { scope: 'ide'; currentName: string; value: string };

function formatPlatformLabel(env: ProfileEnvironment | null): string {
    if (!env) return '跨平台';
    const map: Record<string, string> = { win32: 'Windows', linux: 'Linux', darwin: 'macOS' };
    const osName = map[env.platform] || env.platform;
    return env.headless ? `${osName} 无头/VPS` : osName;
}

export function ProfileSwitcher({ detected = false, onAccountChanged }: ProfileSwitcherProps) {
    const [profiles, setProfiles] = useState<ProfileEntry[]>([]);
    const [active, setActive] = useState<string | null>(null);
    const [env, setEnv] = useState<ProfileEnvironment | null>(null);
    const [oauth, setOAuth] = useState<OAuthListResponse | null>(null);

    const [activeTab, setActiveTab] = useState<string>('oauth');
    const [didPickDefaultTab, setDidPickDefaultTab] = useState(false);

    const [loading, setLoading] = useState(true);
    const [busyKey, setBusyKey] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);

    // IDE flow state
    const [awaitingLogin, setAwaitingLogin] = useState(false);
    const [prevProfile, setPrevProfile] = useState<string | null>(null);
    const [showIdeSaveDialog, setShowIdeSaveDialog] = useState(false);
    const [ideSaveName, setIdeSaveName] = useState('');
    const [ideSaveForce, setIdeSaveForce] = useState(false);

    // OAuth save / import dialogs
    const [showOAuthSaveDialog, setShowOAuthSaveDialog] = useState(false);
    const [oauthSaveAlias, setOAuthSaveAlias] = useState('');
    const [oauthSaveForce, setOAuthSaveForce] = useState(false);

    const [showImportDialog, setShowImportDialog] = useState(false);
    const [importAlias, setImportAlias] = useState('');
    const [importJson, setImportJson] = useState('');
    const [importForce, setImportForce] = useState(false);
    const [importActivate, setImportActivate] = useState(true);

    // OAuth live quota & Web Google OAuth modal
    const [quotaMap, setQuotaMap] = useState<Record<string, OAuthAccountQuota>>({});
    const [showWebOAuthDialog, setShowWebOAuthDialog] = useState(false);
    const [webOAuthUrl, setWebOAuthUrl] = useState('');
    const [webOAuthCallback, setWebOAuthCallback] = useState('');
    const [webOAuthAlias, setWebOAuthAlias] = useState('');

    // Unified rename & confirm modals
    const [renameState, setRenameState] = useState<RenameModalState | null>(null);
    const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);

    const fetchAll = useCallback(async (quiet = false) => {
        if (!quiet) setLoading(true);
        try {
            const data = await getProfiles();
            setProfiles(data.profiles || []);
            setActive(data.active || null);
            setEnv(data.environment || null);
            setOAuth(data.oauth || null);
            setError(null);

            if (!didPickDefaultTab) {
                const hasOAuth = Boolean(data.oauth?.accounts?.length || data.oauth?.hasCurrentCreds);
                const hasIde = Boolean(data.profiles?.length);
                if (!detected || hasOAuth || !hasIde) {
                    setActiveTab('oauth');
                } else {
                    setActiveTab('ide');
                }
                setDidPickDefaultTab(true);
            }
            return data;
        } catch (err) {
            setError(err instanceof Error ? err.message : '读取账号列表失败');
            return null;
        } finally {
            setLoading(false);
        }
    }, [detected, didPickDefaultTab]);

    const tryAutoOnboard = useCallback(async () => {
        if (!detected) return;
        try {
            const res = await autoOnboardProfile();
            if (res.created) {
                setNotice(`已自动识别并保存 IDE 档案 "${res.autoName}"`);
                await fetchAll(true);
            }
        } catch {
            // ignore silently on auto-onboard
        }
    }, [detected, fetchAll]);

    useEffect(() => {
        let cancelled = false;
        fetchAll().then((data) => {
            if (!cancelled && detected && data && (data.profiles.length === 0 || !data.active)) {
                tryAutoOnboard();
            }
        });
        return () => { cancelled = true; };
    }, [fetchAll, detected, tryAutoOnboard]);

    useEffect(() => {
        const reload = () => { fetchAll(true); };
        window.addEventListener('oauth-account-swapped', reload);
        window.addEventListener('profile-swapped', reload);
        return () => {
            window.removeEventListener('oauth-account-swapped', reload);
            window.removeEventListener('profile-swapped', reload);
        };
    }, [fetchAll]);

    const notifyChange = useCallback((eventName: 'oauth-account-swapped' | 'profile-swapped', detail?: unknown) => {
        window.dispatchEvent(new CustomEvent(eventName, { detail }));
        onAccountChanged?.();
    }, [onAccountChanged]);

    // === OAuth Pool Handlers ===
    const handleRefreshQuotas = async () => {
        if (busyKey) return;
        setBusyKey('oauth-quota');
        setError(null);
        try {
            const resp = await getOAuthQuotas();
            if ('accounts' in resp) {
                const map: Record<string, OAuthAccountQuota> = {};
                for (const q of resp.accounts) map[q.alias] = q;
                setQuotaMap(map);
                setNotice(`已刷新 ${resp.accounts.length} 个账号的模型剩余配额`);
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : '刷新账号配额失败');
        } finally {
            setBusyKey(null);
        }
    };

    const handleRotateOAuth = async () => {
        if (busyKey) return;
        setBusyKey('oauth-rotate');
        setError(null);
        setNotice(null);
        try {
            const res = await rotateOAuthAccount(true);
            setNotice(`已轮换切换至可用账号「${res.alias}」${res.email ? ` (${res.email})` : ''}${res.hubReloaded ? ' · 已静默重载后端引擎' : ''}`);
            await fetchAll(true);
            notifyChange('oauth-account-swapped', res);
        } catch (err) {
            setError(err instanceof Error ? err.message : '轮换切换账号失败');
        } finally {
            setBusyKey(null);
        }
    };

    const handleStartWebOAuth = async () => {
        setBusyKey('oauth-login-url');
        setError(null);
        try {
            const res = await startOAuthLoginUrl();
            setWebOAuthUrl(res.authUrl);
            setWebOAuthCallback('');
            setWebOAuthAlias('');
            setShowWebOAuthDialog(true);
        } catch (err) {
            setError(err instanceof Error ? err.message : '生成 Google 登录链接失败');
        } finally {
            setBusyKey(null);
        }
    };

    const handleCompleteWebOAuth = async () => {
        if (!webOAuthCallback.trim()) {
            setError('请粘贴 Google 授权跳转后的完整回调链接');
            return;
        }
        setBusyKey('oauth-callback');
        setError(null);
        try {
            const res = await completeOAuthCallback({
                callbackUrl: webOAuthCallback.trim(),
                alias: webOAuthAlias.trim() || undefined,
                activate: true,
            });
            setShowWebOAuthDialog(false);
            setNotice(`已通过 Google OAuth 登录并激活账号「${res.alias}」${res.email ? ` (${res.email})` : ''}`);
            await fetchAll(true);
            notifyChange('oauth-account-swapped', res);
        } catch (err) {
            setError(err instanceof Error ? err.message : '完成 Google 授权失败');
        } finally {
            setBusyKey(null);
        }
    };

    const handleUseOAuth = async (acc: OAuthAccountMeta) => {
        if (busyKey || acc.isActive) return;
        setBusyKey(`oauth-use:${acc.alias}`);
        setError(null);
        setNotice(null);
        try {
            const res = await switchOAuthAccount(acc.alias, { reloadHub: true, refreshIfExpired: true });
            setNotice(`已切换 OAuth 账号至「${res.alias}」${res.email ? ` (${res.email})` : ''}${res.tokenRefreshed ? ' · 已自动续期' : ''}${res.hubReloaded ? ' · 后台引擎已静默重载' : ''}`);
            await fetchAll(true);
            notifyChange('oauth-account-swapped', res);
        } catch (err) {
            setError(err instanceof Error ? err.message : '切换 OAuth 账号失败');
        } finally {
            setBusyKey(null);
        }
    };

    const handleSaveCurrentOAuth = async () => {
        setBusyKey('oauth-save');
        setError(null);
        try {
            const res = await saveOAuthAccount(oauthSaveAlias.trim(), oauthSaveForce);
            setNotice(`已保存当前活跃凭据为「${res.alias}」`);
            setShowOAuthSaveDialog(false);
            setOAuthSaveAlias('');
            setOAuthSaveForce(false);
            await fetchAll(true);
            notifyChange('oauth-account-swapped', res);
        } catch (err) {
            setError(err instanceof Error ? err.message : '保存当前 OAuth 凭据失败');
        } finally {
            setBusyKey(null);
        }
    };

    const handleImportOAuth = async () => {
        if (!importJson.trim()) {
            setError('请粘贴 OAuth 凭据 JSON 内容');
            return;
        }
        setBusyKey('oauth-import');
        setError(null);
        try {
            const res = await importOAuthAccount({
                alias: importAlias.trim() || undefined,
                credentialJson: importJson.trim(),
                force: importForce,
                activate: importActivate,
            });
            setNotice(
                res.activated
                    ? `已导入并激活账号「${res.alias}」${res.account?.email ? ` (${res.account.email})` : ''}`
                    : `已成功导入账号「${res.alias}」`,
            );
            setShowImportDialog(false);
            setImportAlias('');
            setImportJson('');
            setImportForce(false);
            await fetchAll(true);
            notifyChange('oauth-account-swapped', res);
        } catch (err) {
            setError(err instanceof Error ? err.message : '导入 OAuth 凭据失败');
        } finally {
            setBusyKey(null);
        }
    };

    // === IDE Profile Handlers ===
    const executeSwapIde = async (target: string) => {
        setBusyKey(`ide-swap:${target}`);
        setError(null);
        setNotice(null);
        try {
            const res = await swapProfile(target);
            setActive(res.activeProfile);
            setAwaitingLogin(false);
            setPrevProfile(null);
            setNotice(
                res.relaunched
                    ? `已切换 IDE 档案至 "${res.activeProfile}"，正在重新启动 IDE（约 10 秒）...`
                    : `已切换档案目录至 "${res.activeProfile}"（未运行桌面 IDE，配置已就绪）`,
            );
            await fetchAll(true);
            notifyChange('profile-swapped', res);
        } catch (err) {
            setError(err instanceof Error ? err.message : '切换 IDE 档案失败');
        } finally {
            setBusyKey(null);
        }
    };

    const handleSaveIdeProfile = async () => {
        const clean = ideSaveName.trim();
        if (!clean) return;
        setBusyKey('ide-create');
        setError(null);
        try {
            await createProfileEntry(clean, ideSaveForce);
            setActive(clean);
            setAwaitingLogin(false);
            setPrevProfile(null);
            setShowIdeSaveDialog(false);
            setIdeSaveName('');
            setIdeSaveForce(false);
            setNotice(`已保存当前 IDE 数据为档案 "${clean}"`);
            await fetchAll(true);
            notifyChange('profile-swapped', { activeProfile: clean });
        } catch (err) {
            setError(err instanceof Error ? err.message : '保存 IDE 档案失败');
        } finally {
            setBusyKey(null);
        }
    };

    const handleCancelAddIde = async () => {
        if (!prevProfile) return;
        setBusyKey('ide-cancel-add');
        setError(null);
        try {
            const res = await cancelAddAccountFlow(prevProfile);
            setActive(res.activeProfile);
            setAwaitingLogin(false);
            setPrevProfile(null);
            setNotice(`已还原原档案 "${res.activeProfile}"`);
            await fetchAll(true);
            notifyChange('profile-swapped', res);
        } catch (err) {
            setError(err instanceof Error ? err.message : '还原档案失败');
        } finally {
            setBusyKey(null);
        }
    };

    const handleRenameSubmit = async () => {
        if (!renameState) return;
        const targetNew = renameState.value.trim();
        if (!targetNew || targetNew === renameState.currentName) return;
        setBusyKey('rename');
        setError(null);
        try {
            if (renameState.scope === 'oauth') {
                await renameOAuthAccountEntry(renameState.currentName, targetNew);
                setNotice(`已将 OAuth 账号「${renameState.currentName}」重命名为「${targetNew}」`);
                notifyChange('oauth-account-swapped');
            } else {
                await renameProfileEntry(renameState.currentName, targetNew);
                setNotice(`已将 IDE 档案 "${renameState.currentName}" 重命名为 "${targetNew}"`);
                notifyChange('profile-swapped');
            }
            setRenameState(null);
            await fetchAll(true);
        } catch (err) {
            setError(err instanceof Error ? err.message : '重命名失败');
        } finally {
            setBusyKey(null);
        }
    };

    const handleConfirmExecute = async () => {
        if (!confirmAction) return;
        const action = confirmAction;
        setConfirmAction(null);

        if (action.kind === 'swap-ide') {
            await executeSwapIde(action.target);
            return;
        }

        if (action.kind === 'start-add-ide') {
            setBusyKey('ide-add-account');
            setError(null);
            try {
                const res = await startAddAccountFlow();
                setPrevProfile(res.previousProfile);
                setAwaitingLogin(true);
                setActive(null);
                setNotice(res.message);
                await fetchAll(true);
            } catch (err) {
                setError(err instanceof Error ? err.message : '启动新账号登录失败');
            } finally {
                setBusyKey(null);
            }
            return;
        }

        if (action.kind === 'delete-ide') {
            setBusyKey(`ide-del:${action.target}`);
            setError(null);
            try {
                await deleteProfileEntry(action.target);
                setNotice(`已删除 IDE 档案 "${action.target}"`);
                await fetchAll(true);
            } catch (err) {
                setError(err instanceof Error ? err.message : '删除 IDE 档案失败');
            } finally {
                setBusyKey(null);
            }
            return;
        }

        if (action.kind === 'delete-oauth') {
            setBusyKey(`oauth-del:${action.target}`);
            setError(null);
            try {
                await deleteOAuthAccountEntry(action.target);
                setNotice(`已从账号池移除「${action.target}」`);
                await fetchAll(true);
                notifyChange('oauth-account-swapped');
            } catch (err) {
                setError(err instanceof Error ? err.message : '删除 OAuth 账号失败');
            } finally {
                setBusyKey(null);
            }
        }
    };

    const activeProfile = profiles.find((p) => p.name === active);
    const otherProfiles = profiles.filter((p) => p.name !== active);
    const oauthAccounts = oauth?.accounts || [];
    const activeOAuthAccount = oauthAccounts.find((a) => a.isActive) || null;

    if (loading) {
        return (
            <Card className="border-border/50">
                <CardContent className="p-6 flex items-center justify-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    正在加载多用户账号配置...
                </CardContent>
            </Card>
        );
    }

    return (
        <>
            <Card className="border-border/50 overflow-hidden">
                <CardHeader className="pb-3 border-b border-border/40 bg-muted/10">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2.5">
                            <div className="w-8 h-8 rounded-lg bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center">
                                <Users className="h-4 w-4 text-indigo-400" />
                            </div>
                            <div>
                                <CardTitle className="text-sm font-semibold">多用户账号切换中心</CardTitle>
                                <p className="text-[11px] text-muted-foreground mt-0.5">
                                    支持 Linux VPS / macOS / Windows 跨平台无缝切换 Google 账号
                                </p>
                            </div>
                        </div>

                        <div className="flex items-center gap-1.5 flex-wrap">
                            <Badge variant="outline" className="text-[10px] h-5 px-2 gap-1 font-normal border-border/60">
                                {env?.headless ? <Server className="h-3 w-3 text-emerald-400" /> : <Monitor className="h-3 w-3 text-sky-400" />}
                                {formatPlatformLabel(env)}
                            </Badge>
                            {env && (
                                <Badge
                                    variant="outline"
                                    className={`text-[10px] h-5 px-2 font-normal ${
                                        env.ideRunning
                                            ? 'border-emerald-500/30 text-emerald-400 bg-emerald-500/10'
                                            : 'border-border/60 text-muted-foreground'
                                    }`}
                                >
                                    {env.ideRunning ? '桌面 IDE 运行中' : 'IDE 未运行'}
                                </Badge>
                            )}
                            <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2 text-xs"
                                onClick={() => fetchAll(true)}
                                disabled={busyKey !== null}
                                title="刷新账号状态"
                            >
                                <RefreshCw className={`h-3.5 w-3.5 ${busyKey ? 'animate-spin' : ''}`} />
                            </Button>
                        </div>
                    </div>
                </CardHeader>

                <CardContent className="p-4 space-y-4">
                    {/* Feedback banners */}
                    {error && (
                        <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-md px-3 py-2 flex items-center justify-between gap-2">
                            <span>{error}</span>
                            <button onClick={() => setError(null)} className="text-red-300/70 hover:text-red-200 text-xs">✕</button>
                        </div>
                    )}
                    {notice && (
                        <div className="text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-md px-3 py-2 flex items-center justify-between gap-2">
                            <span>{notice}</span>
                            <button onClick={() => setNotice(null)} className="text-emerald-300/70 hover:text-emerald-200 text-xs">✕</button>
                        </div>
                    )}

                    <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
                        <TabsList className="w-full grid grid-cols-2 h-9">
                            <TabsTrigger value="oauth" className="text-xs gap-1.5">
                                <KeyRound className="h-3.5 w-3.5" />
                                <span>OAuth 账号池（0秒热切）</span>
                                <Badge variant="secondary" className="text-[10px] h-4 px-1.5">{oauthAccounts.length}</Badge>
                            </TabsTrigger>
                            <TabsTrigger value="ide" className="text-xs gap-1.5">
                                <ArrowLeftRight className="h-3.5 w-3.5" />
                                <span>IDE 目录档案（完整隔离）</span>
                                <Badge variant="secondary" className="text-[10px] h-4 px-1.5">{profiles.length}</Badge>
                            </TabsTrigger>
                        </TabsList>

                        {/* === Tab 1: OAuth Pool (agy CLI + VPS headless compatible) === */}
                        <TabsContent value="oauth" className="space-y-3 pt-3">
                            {/* Toolbar + current oauth status */}
                            <div className="flex flex-wrap items-center justify-between gap-2 p-3 rounded-lg bg-muted/15 border border-border/40">
                                <div className="min-w-0 space-y-0.5">
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <span className="text-[11px] font-medium text-muted-foreground">当前 OAuth 凭据:</span>
                                        {oauth?.activeEmail ? (
                                            <span className="text-xs font-semibold text-foreground truncate">{oauth.activeEmail}</span>
                                        ) : oauth?.hasCurrentCreds ? (
                                            <span className="text-xs font-medium text-foreground">已检测到本地凭据</span>
                                        ) : (
                                            <span className="text-xs text-muted-foreground">暂无活跃凭据</span>
                                        )}
                                        {activeOAuthAccount && (
                                            <Badge className="text-[10px] h-4 px-1.5 bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/20">
                                                {activeOAuthAccount.alias}
                                            </Badge>
                                        )}
                                    </div>
                                    <p className="text-[11px] text-muted-foreground">
                                        直接读写 <code className="text-[10px] bg-muted/50 px-1 py-0.5 rounded">~/.gemini/oauth_creds.json</code> 与 <code className="text-[10px] bg-muted/50 px-1 py-0.5 rounded">accounts/*.json</code>（无需重启、兼容 <code className="text-[10px]">agy</code> 与 Linux VPS）
                                    </p>
                                </div>

                                <div className="flex flex-wrap items-center gap-1.5 flex-shrink-0">
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        className="h-7 text-xs gap-1"
                                        disabled={busyKey !== null || oauthAccounts.length === 0}
                                        onClick={handleRefreshQuotas}
                                    >
                                        {busyKey === 'oauth-quota' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Gauge className="h-3 w-3" />}
                                        刷新配额
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        className="h-7 text-xs gap-1"
                                        disabled={busyKey !== null || oauthAccounts.length < 2}
                                        onClick={handleRotateOAuth}
                                    >
                                        {busyKey === 'oauth-rotate' ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCw className="h-3 w-3" />}
                                        一键轮转
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        className="h-7 text-xs gap-1"
                                        disabled={busyKey !== null}
                                        onClick={handleStartWebOAuth}
                                    >
                                        {busyKey === 'oauth-login-url' ? <Loader2 className="h-3 w-3 animate-spin" /> : <ExternalLink className="h-3 w-3" />}
                                        Google 网页登录
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        className="h-7 text-xs gap-1"
                                        disabled={busyKey !== null || !oauth?.hasCurrentCreds}
                                        onClick={() => {
                                            setOAuthSaveAlias('');
                                            setOAuthSaveForce(false);
                                            setShowOAuthSaveDialog(true);
                                        }}
                                        title={oauth?.hasCurrentCreds ? '将当前 oauth_creds.json / 系统凭据另存为账号' : '当前无活跃凭据'}
                                    >
                                        <Save className="h-3 w-3" />
                                        保存当前凭据
                                    </Button>
                                    <Button
                                        size="sm"
                                        className="h-7 text-xs gap-1"
                                        disabled={busyKey !== null}
                                        onClick={() => {
                                            setImportAlias('');
                                            setImportJson('');
                                            setImportForce(false);
                                            setImportActivate(true);
                                            setShowImportDialog(true);
                                        }}
                                    >
                                        <Upload className="h-3 w-3" />
                                        导入 JSON
                                    </Button>
                                </div>
                            </div>

                            {oauthAccounts.length === 0 ? (
                                <div className="p-5 rounded-lg bg-muted/10 border border-dashed border-border/50 text-center space-y-2.5">
                                    <KeyRound className="h-7 w-7 mx-auto text-muted-foreground/60" />
                                    <div className="space-y-1">
                                        <p className="text-xs font-medium text-foreground">OAuth 账号池暂无已保存账号</p>
                                        <p className="text-[11px] text-muted-foreground max-w-md mx-auto">
                                            可将其他机器导出的 <code className="text-[10px]">oauth_creds.json</code> 或 <code className="text-[10px]">agy</code> 账号 JSON 导入此处，随时零延迟秒切。
                                        </p>
                                    </div>
                                    <div className="flex items-center justify-center gap-2 pt-1">
                                        {oauth?.hasCurrentCreds && (
                                            <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => setShowOAuthSaveDialog(true)}>
                                                <Save className="h-3 w-3" /> 保存当前账号
                                            </Button>
                                        )}
                                        <Button size="sm" className="h-7 text-xs gap-1" onClick={() => setShowImportDialog(true)}>
                                            <Upload className="h-3 w-3" /> 导入凭据 JSON
                                        </Button>
                                    </div>
                                </div>
                            ) : (
                                <div className="grid grid-cols-1 gap-2">
                                    {oauthAccounts.map((acc) => {
                                        const isSwitchingThis = busyKey === `oauth-use:${acc.alias}`;
                                        const initial = (acc.email || acc.alias || '?')[0].toUpperCase();
                                        return (
                                            <div
                                                key={acc.alias}
                                                className={`flex items-center justify-between gap-3 p-3 rounded-lg border transition-colors ${
                                                    acc.isActive
                                                        ? 'bg-emerald-500/8 border-emerald-500/35'
                                                        : 'bg-muted/15 border-border/40 hover:border-border/70'
                                                }`}
                                            >
                                                <div className="flex items-center gap-3 min-w-0">
                                                    <div
                                                        className={`w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold flex-shrink-0 ${
                                                            acc.isActive
                                                                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
                                                                : 'bg-muted text-muted-foreground'
                                                        }`}
                                                    >
                                                        {initial}
                                                    </div>
                                                    <div className="min-w-0">
                                                        <div className="flex items-center gap-1.5 flex-wrap">
                                                            <span className="text-xs font-semibold truncate">{acc.alias}</span>
                                                            {acc.isActive && (
                                                                <Badge variant="outline" className="text-[9px] h-4 px-1.5 border-emerald-500/40 text-emerald-400 gap-0.5">
                                                                    <ShieldCheck className="h-2.5 w-2.5" /> 当前使用中
                                                                </Badge>
                                                            )}
                                                            <Badge variant="secondary" className="text-[9px] h-4 px-1.5 font-normal">
                                                                {acc.format === 'agy-cred' ? 'agy 凭据' : 'OAuth JSON'}
                                                            </Badge>
                                                            {quotaMap[acc.alias]?.tierLabel && (
                                                                <Badge variant="outline" className="text-[9px] h-4 px-1.5 border-primary/35 text-primary font-medium">
                                                                    {quotaMap[acc.alias].tierLabel}
                                                                    {typeof quotaMap[acc.alias].totalModels === 'number' ? ` · ${quotaMap[acc.alias].totalModels} 模型` : ''}
                                                                </Badge>
                                                            )}
                                                            {acc.isExpired && (
                                                                <Badge variant="outline" className="text-[9px] h-4 px-1.5 border-amber-500/30 text-amber-400">
                                                                    {acc.hasRefreshToken ? '访问令牌过期（可自动续期）' : '已过期'}
                                                                </Badge>
                                                            )}
                                                        </div>
                                                        <p className="text-[11px] text-muted-foreground truncate mt-0.5">
                                                            {acc.email || '未包含邮箱声明'}
                                                            {acc.name && acc.email && !acc.email.startsWith(acc.name) ? ` · ${acc.name}` : ''}
                                                        </p>
                                                        {quotaMap[acc.alias] && (
                                                            <div className="mt-1.5 flex items-center gap-2 text-[10px]">
                                                                {quotaMap[acc.alias].error ? (
                                                                    <span className="text-amber-500">配额检测失败: {quotaMap[acc.alias].error}</span>
                                                                ) : (
                                                                    <>
                                                                        <div className="w-20 h-1.5 rounded-full bg-muted overflow-hidden">
                                                                            <div
                                                                                className={`h-full rounded-full ${(quotaMap[acc.alias].avgQuota ?? 1) > 0.25 ? 'bg-emerald-500' : 'bg-amber-500'}`}
                                                                                style={{ width: `${Math.round((quotaMap[acc.alias].avgQuota ?? 0) * 100)}%` }}
                                                                            />
                                                                        </div>
                                                                        <span className="text-muted-foreground font-mono">
                                                                            均值 {Math.round((quotaMap[acc.alias].avgQuota ?? 0) * 100)}% · 最低 {Math.round((quotaMap[acc.alias].minQuota ?? 0) * 100)}%
                                                                            {(quotaMap[acc.alias].exhaustedCount ?? 0) > 0 ? ` (${quotaMap[acc.alias].exhaustedCount} 项耗尽)` : ''}
                                                                        </span>
                                                                    </>
                                                                )}
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>

                                                <div className="flex items-center gap-1 flex-shrink-0">
                                                    {!acc.isActive ? (
                                                        <Button
                                                            size="sm"
                                                            variant="outline"
                                                            className="h-7 px-2.5 text-xs gap-1"
                                                            disabled={busyKey !== null}
                                                            onClick={() => handleUseOAuth(acc)}
                                                        >
                                                            {isSwitchingThis ? (
                                                                <Loader2 className="h-3 w-3 animate-spin" />
                                                            ) : (
                                                                <ArrowLeftRight className="h-3 w-3" />
                                                            )}
                                                            切换使用
                                                        </Button>
                                                    ) : (
                                                        <span className="text-[11px] text-emerald-400 px-2 hidden sm:inline-flex items-center gap-1">
                                                            <Check className="h-3.5 w-3.5" /> 已启用
                                                        </span>
                                                    )}
                                                    <Button
                                                        size="sm"
                                                        variant="ghost"
                                                        className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                                                        disabled={busyKey !== null}
                                                        title="重命名别名"
                                                        onClick={() => setRenameState({ scope: 'oauth', currentName: acc.alias, value: acc.alias })}
                                                    >
                                                        <Pencil className="h-3.5 w-3.5" />
                                                    </Button>
                                                    <Button
                                                        size="sm"
                                                        variant="ghost"
                                                        className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                                                        disabled={busyKey !== null}
                                                        title="从账号池删除"
                                                        onClick={() => setConfirmAction({ kind: 'delete-oauth', target: acc.alias, email: acc.email })}
                                                    >
                                                        <Trash2 className="h-3.5 w-3.5" />
                                                    </Button>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </TabsContent>

                        {/* === Tab 2: Cross-Platform IDE Folder Profiles === */}
                        <TabsContent value="ide" className="space-y-3 pt-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <p className="text-[11px] text-muted-foreground">
                                    隔离切换 <code className="text-[10px]">Antigravity</code> / <code className="text-[10px]">.gemini</code> / <code className="text-[10px]">.antigravity</code> 目录。
                                    {env?.headless ? '（当前无桌面 GUI，切换将直接更新配置目录）' : '（切换运行中档案将安全重启 IDE）'}
                                </p>
                                <div className="flex items-center gap-1.5">
                                    {active && !awaitingLogin && (
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            className="h-7 text-xs gap-1"
                                            disabled={busyKey !== null}
                                            onClick={() => setConfirmAction({ kind: 'start-add-ide' })}
                                        >
                                            <UserPlus className="h-3 w-3" /> 添加新 Google 账号
                                        </Button>
                                    )}
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        className="h-7 text-xs gap-1"
                                        disabled={busyKey !== null}
                                        onClick={() => {
                                            setIdeSaveName('');
                                            setIdeSaveForce(false);
                                            setShowIdeSaveDialog(true);
                                        }}
                                    >
                                        <Plus className="h-3 w-3" /> 保存当前为新档案
                                    </Button>
                                </div>
                            </div>

                            {profiles.length === 0 && !awaitingLogin && (
                                <div className="p-5 rounded-lg bg-muted/10 border border-dashed border-border/50 text-center space-y-2">
                                    <p className="text-xs text-muted-foreground">
                                        尚未保存任何 IDE 目录档案。保存当前登录状态后，可随时在不同完整工作区账号之间切换。
                                    </p>
                                    <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => setShowIdeSaveDialog(true)}>
                                        <Plus className="h-3 w-3" /> 保存当前账号档案
                                    </Button>
                                </div>
                            )}

                            {awaitingLogin && (
                                <div className="p-3 rounded-lg bg-blue-500/10 border border-blue-500/30 space-y-2.5">
                                    <div className="flex items-center justify-between gap-2">
                                        <div>
                                            <div className="text-xs font-medium text-blue-400">正在等待新账号登录</div>
                                            <p className="text-[11px] text-muted-foreground mt-0.5">
                                                请在 Antigravity IDE 中完成 Google 登录（或先在无头环境中写入登录凭据），然后点击“保存为新档案”。
                                            </p>
                                        </div>
                                        {prevProfile && (
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                className="h-7 text-xs gap-1 text-muted-foreground"
                                                disabled={busyKey !== null}
                                                onClick={handleCancelAddIde}
                                            >
                                                <RotateCcw className="h-3 w-3" /> 取消并还原
                                            </Button>
                                        )}
                                    </div>
                                    <Button size="sm" className="h-7 text-xs gap-1" onClick={() => setShowIdeSaveDialog(true)}>
                                        <Plus className="h-3 w-3" /> 保存当前登录为新档案
                                    </Button>
                                </div>
                            )}

                            {!active && profiles.length > 0 && !awaitingLogin && (
                                <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 flex flex-wrap items-center justify-between gap-2">
                                    <div className="text-xs text-amber-300">
                                        当前未绑定活跃档案（可能刚添加新账号尚未保存）。
                                    </div>
                                    <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => setShowIdeSaveDialog(true)}>
                                        <Plus className="h-3 w-3" /> 保存当前账号
                                    </Button>
                                </div>
                            )}

                            {activeProfile && (
                                <div className="flex items-center justify-between gap-2 p-3 rounded-lg bg-indigo-500/10 border border-indigo-500/30">
                                    <div className="min-w-0">
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
                                            <span className="text-xs font-semibold">{activeProfile.name}</span>
                                            {activeProfile.meta?.userName && (
                                                <span className="text-[11px] text-muted-foreground">({activeProfile.meta.userName})</span>
                                            )}
                                            {activeProfile.meta?.tier && (
                                                <Badge variant="outline" className="text-[9px] h-4 px-1.5 border-indigo-500/30 text-indigo-400">
                                                    {activeProfile.meta.tier}
                                                </Badge>
                                            )}
                                            <Badge variant="secondary" className="text-[9px] h-4 px-1.5">当前档案</Badge>
                                        </div>
                                        {activeProfile.meta?.email && (
                                            <p className="text-[11px] text-muted-foreground truncate mt-0.5 pl-4">{activeProfile.meta.email}</p>
                                        )}
                                    </div>
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                                        disabled={busyKey !== null}
                                        title="重命名当前档案"
                                        onClick={() => setRenameState({ scope: 'ide', currentName: activeProfile.name, value: activeProfile.name })}
                                    >
                                        <Pencil className="h-3.5 w-3.5" />
                                    </Button>
                                </div>
                            )}

                            {otherProfiles.length > 0 && (
                                <div className="space-y-1.5">
                                    {otherProfiles.map((p) => (
                                        <div key={p.name} className="flex items-center justify-between gap-2 p-3 rounded-lg bg-muted/15 border border-border/40">
                                            <div className="min-w-0">
                                                <div className="flex items-center gap-2 flex-wrap">
                                                    <span className="text-xs font-medium">{p.name}</span>
                                                    {p.meta?.userName && (
                                                        <span className="text-[11px] text-muted-foreground">({p.meta.userName})</span>
                                                    )}
                                                    {p.meta?.tier && (
                                                        <Badge variant="outline" className="text-[9px] h-4 px-1.5">{p.meta.tier}</Badge>
                                                    )}
                                                </div>
                                                {p.meta?.email && (
                                                    <p className="text-[11px] text-muted-foreground truncate mt-0.5">{p.meta.email}</p>
                                                )}
                                            </div>
                                            <div className="flex items-center gap-1 flex-shrink-0">
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    className="h-7 px-2.5 text-xs gap-1"
                                                    disabled={busyKey !== null || !active}
                                                    title={!active ? '请先保存当前登录账号后再切换' : `切换至 ${p.name}`}
                                                    onClick={() => setConfirmAction({ kind: 'swap-ide', target: p.name })}
                                                >
                                                    {busyKey === `ide-swap:${p.name}` ? (
                                                        <Loader2 className="h-3 w-3 animate-spin" />
                                                    ) : (
                                                        <ArrowLeftRight className="h-3 w-3" />
                                                    )}
                                                    切换档案
                                                </Button>
                                                <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                                                    disabled={busyKey !== null}
                                                    title="重命名"
                                                    onClick={() => setRenameState({ scope: 'ide', currentName: p.name, value: p.name })}
                                                >
                                                    <Pencil className="h-3.5 w-3.5" />
                                                </Button>
                                                <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                                                    disabled={busyKey !== null}
                                                    title="删除档案"
                                                    onClick={() => setConfirmAction({ kind: 'delete-ide', target: p.name })}
                                                >
                                                    <Trash2 className="h-3.5 w-3.5" />
                                                </Button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </TabsContent>
                    </Tabs>
                </CardContent>
            </Card>

            {/* Save Current OAuth Account Dialog */}
            <Dialog open={showOAuthSaveDialog} onOpenChange={(open) => { setShowOAuthSaveDialog(open); }}>
                <DialogContent className="sm:max-w-[420px]">
                    <DialogHeader>
                        <DialogTitle>保存当前 OAuth 凭据</DialogTitle>
                        <DialogDescription>
                            将当前活跃的 <code className="text-[11px]">oauth_creds.json</code> / 系统凭据保存到 <code className="text-[11px]">~/.gemini/accounts/</code> 账号池。
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-3 py-1">
                        <div className="space-y-1.5">
                            <label className="text-xs font-medium text-muted-foreground">账号别名（留空则自动根据邮箱生成）</label>
                            <Input
                                value={oauthSaveAlias}
                                onChange={(e) => setOAuthSaveAlias(e.target.value)}
                                placeholder="例如：主账号、work、personal"
                                onKeyDown={(e) => { if (e.key === 'Enter') handleSaveCurrentOAuth(); }}
                                autoFocus
                            />
                        </div>
                        <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                            <Checkbox checked={oauthSaveForce} onCheckedChange={(v) => setOAuthSaveForce(v === true)} />
                            <span>若同名或同邮箱已存在，强制覆盖保存</span>
                        </label>
                    </div>
                    <DialogFooter>
                        <Button variant="ghost" size="sm" onClick={() => setShowOAuthSaveDialog(false)}>取消</Button>
                        <Button size="sm" onClick={handleSaveCurrentOAuth} disabled={busyKey === 'oauth-save'}>
                            {busyKey === 'oauth-save' && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />}
                            保存至账号池
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Import OAuth JSON Dialog */}
            <Dialog
                open={showImportDialog}
                onOpenChange={(open) => {
                    setShowImportDialog(open);
                    if (!open) setImportJson('');
                }}
            >
                <DialogContent className="sm:max-w-[500px]">
                    <DialogHeader>
                        <DialogTitle>导入 OAuth 凭据 JSON</DialogTitle>
                        <DialogDescription>
                            支持 <code className="text-[11px]">~/.gemini/oauth_creds.json</code> 或 <code className="text-[11px]">~/.gemini/accounts/*.json</code> 导出的凭据内容（仅存储于本机目录，绝不回传令牌原文）。
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-3 py-1">
                        <div className="space-y-1.5">
                            <label className="text-xs font-medium text-muted-foreground">账号别名（选填，支持中英文、数字、_-）</label>
                            <Input
                                value={importAlias}
                                onChange={(e) => setImportAlias(e.target.value)}
                                placeholder="留空将自动从邮箱提取别名"
                            />
                        </div>
                        <div className="space-y-1.5">
                            <label className="text-xs font-medium text-muted-foreground">凭据 JSON 内容</label>
                            <Textarea
                                value={importJson}
                                onChange={(e) => setImportJson(e.target.value)}
                                placeholder={'{\n  "access_token": "...",\n  "refresh_token": "...",\n  "id_token": "..."\n}'}
                                className="font-mono text-xs min-h-32 max-h-56"
                            />
                        </div>
                        <div className="space-y-2">
                            <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                                <Checkbox checked={importActivate} onCheckedChange={(v) => setImportActivate(v === true)} />
                                <span>导入后立即设为当前活跃账号</span>
                            </label>
                            <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                                <Checkbox checked={importForce} onCheckedChange={(v) => setImportForce(v === true)} />
                                <span>若别名或同邮箱已存在，强制覆盖保存</span>
                            </label>
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="ghost" size="sm" onClick={() => { setShowImportDialog(false); setImportJson(''); }}>取消</Button>
                        <Button size="sm" onClick={handleImportOAuth} disabled={busyKey === 'oauth-import' || !importJson.trim()}>
                            {busyKey === 'oauth-import' && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />}
                            导入账号
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Save IDE Profile Dialog */}
            <Dialog open={showIdeSaveDialog} onOpenChange={setShowIdeSaveDialog}>
                <DialogContent className="sm:max-w-[420px]">
                    <DialogHeader>
                        <DialogTitle>保存当前 IDE 账号档案</DialogTitle>
                        <DialogDescription>
                            档案名仅支持英文字母、数字、连字符和下划线（例如 work、personal、account-2）。
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-3 py-1">
                        <Input
                            value={ideSaveName}
                            onChange={(e) => setIdeSaveName(e.target.value)}
                            placeholder="work-account"
                            onKeyDown={(e) => { if (e.key === 'Enter' && ideSaveName.trim()) handleSaveIdeProfile(); }}
                            autoFocus
                        />
                        <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                            <Checkbox checked={ideSaveForce} onCheckedChange={(v) => setIdeSaveForce(v === true)} />
                            <span>若同一邮箱已存在档案，允许强制保存副本</span>
                        </label>
                    </div>
                    <DialogFooter>
                        <Button variant="ghost" size="sm" onClick={() => setShowIdeSaveDialog(false)}>取消</Button>
                        <Button size="sm" onClick={handleSaveIdeProfile} disabled={busyKey === 'ide-create' || !ideSaveName.trim()}>
                            {busyKey === 'ide-create' && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />}
                            确认保存
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Web Google OAuth Dialog */}
            <Dialog open={showWebOAuthDialog} onOpenChange={setShowWebOAuthDialog}>
                <DialogContent className="sm:max-w-[500px]">
                    <DialogHeader>
                        <DialogTitle>Google 网页授权登录新账号</DialogTitle>
                        <DialogDescription>
                            1) 点击下方按钮在新窗口完成 Google 登录；2) 浏览器跳转到 localhost 无法访问页后，复制地址栏完整链接粘贴到下方即可完成绑定。
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-3 py-1">
                        {webOAuthUrl && (
                            <div className="flex items-center justify-between gap-2 p-2.5 rounded-lg border border-border/60 bg-muted/20">
                                <span className="text-[11px] text-muted-foreground truncate font-mono flex-1">{webOAuthUrl}</span>
                                <Button size="sm" variant="outline" className="h-7 text-xs gap-1 shrink-0" asChild>
                                    <a href={webOAuthUrl} target="_blank" rel="noopener noreferrer">
                                        <ExternalLink className="h-3 w-3" /> 打开 Google 授权
                                    </a>
                                </Button>
                            </div>
                        )}
                        <div className="space-y-1">
                            <label className="text-xs font-medium">粘贴回调地址栏 URL（必填）</label>
                            <Input
                                value={webOAuthCallback}
                                onChange={(e) => setWebOAuthCallback(e.target.value)}
                                placeholder="http://localhost:.../oauth-callback?code=...&state=..."
                                className="font-mono text-xs"
                            />
                        </div>
                        <div className="space-y-1">
                            <label className="text-xs font-medium">账号别名（可选，留空自动按邮箱前缀生成）</label>
                            <Input
                                value={webOAuthAlias}
                                onChange={(e) => setWebOAuthAlias(e.target.value)}
                                placeholder="例如 work-backup"
                                className="text-xs"
                            />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="ghost" size="sm" onClick={() => setShowWebOAuthDialog(false)}>取消</Button>
                        <Button size="sm" onClick={handleCompleteWebOAuth} disabled={busyKey === 'oauth-callback' || !webOAuthCallback.trim()}>
                            {busyKey === 'oauth-callback' && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />}
                            完成绑定并切换
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Unified Rename Dialog */}
            <Dialog open={renameState !== null} onOpenChange={(open) => { if (!open) setRenameState(null); }}>
                <DialogContent className="sm:max-w-[400px]">
                    <DialogHeader>
                        <DialogTitle>重命名{renameState?.scope === 'oauth' ? ' OAuth 账号' : ' IDE 档案'}</DialogTitle>
                        <DialogDescription>
                            {renameState?.scope === 'oauth'
                                ? '支持中英文、数字、下划线和连字符。'
                                : 'IDE 档案名仅支持英文字母、数字、下划线和连字符。'}
                        </DialogDescription>
                    </DialogHeader>
                    <Input
                        value={renameState?.value || ''}
                        onChange={(e) => setRenameState((prev) => (prev ? { ...prev, value: e.target.value } : null))}
                        onKeyDown={(e) => { if (e.key === 'Enter') handleRenameSubmit(); }}
                        autoFocus
                    />
                    <DialogFooter>
                        <Button variant="ghost" size="sm" onClick={() => setRenameState(null)}>取消</Button>
                        <Button
                            size="sm"
                            onClick={handleRenameSubmit}
                            disabled={busyKey === 'rename' || !renameState?.value.trim() || renameState?.value.trim() === renameState?.currentName}
                        >
                            {busyKey === 'rename' && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />}
                            确认修改
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Unified Confirmation AlertDialog */}
            <AlertDialog open={confirmAction !== null} onOpenChange={(open) => { if (!open) setConfirmAction(null); }}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            {confirmAction?.kind === 'swap-ide' && `切换到 IDE 档案 "${confirmAction.target}"？`}
                            {confirmAction?.kind === 'start-add-ide' && '添加新的 Google 账号？'}
                            {confirmAction?.kind === 'delete-ide' && `删除 IDE 档案 "${confirmAction.target}"？`}
                            {confirmAction?.kind === 'delete-oauth' && `移除 OAuth 账号「${confirmAction.target}」？`}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            {confirmAction?.kind === 'swap-ide' && (
                                env?.ideRunning
                                    ? '检测到桌面 Antigravity IDE 正在运行，此操作将安全关闭并重启 IDE 以加载新档案（约 10 秒）。'
                                    : '当前桌面 IDE 未运行，将直接切换配置目录并设目标档案为激活状态。'
                            )}
                            {confirmAction?.kind === 'start-add-ide' && '此操作将保存当前档案目录并清空工作登录态，方便登录全新的 Google 账号。'}
                            {confirmAction?.kind === 'delete-ide' && `将永久删除档案目录 "${confirmAction.target}" 及其缓存快照，该操作不可撤销。`}
                            {confirmAction?.kind === 'delete-oauth' && `将从 ~/.gemini/accounts 移除「${confirmAction.target}」${confirmAction.email ? ` (${confirmAction.email})` : ''} 的本地凭据文件。`}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>取消</AlertDialogCancel>
                        <AlertDialogAction
                            onClick={handleConfirmExecute}
                            className={
                                confirmAction?.kind === 'delete-ide' || confirmAction?.kind === 'delete-oauth'
                                    ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                                    : undefined
                            }
                        >
                            确认
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    );
}
