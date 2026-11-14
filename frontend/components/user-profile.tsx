'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { API_BASE } from '@/lib/config';
import { authHeaders } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { User, RefreshCw, Calendar, Clock, Zap, KeyRound, ArrowLeft, Server } from 'lucide-react';
import { getProfiles, type ProfileListResponse } from '@/lib/cascade-api';
import { ProfileSwitcher } from './profile-switcher';

export function UserProfile() {
    const [user, setUser] = useState<any>(null);
    const [profilePic, setProfilePic] = useState<string | null>(null);
    const [oauthEmail, setOAuthEmail] = useState<string | null>(null);
    const [oauthAlias, setOAuthAlias] = useState<string | null>(null);

    const refreshCompact = useCallback(() => {
        fetch(`${API_BASE}/api/user/profile`, { headers: authHeaders() })
            .then(r => (r.ok ? r.json() : null))
            .then(d => {
                if (d?.user) {
                    setUser(d.user);
                    setProfilePic(d.profilePicture || null);
                }
            })
            .catch(() => { /* LS offline */ });

        getProfiles()
            .then((p) => {
                setOAuthEmail(p.oauth?.activeEmail || null);
                setOAuthAlias(p.oauth?.activeAlias || p.active || null);
            })
            .catch(() => { /* ignore */ });
    }, []);

    useEffect(() => {
        refreshCompact();
        window.addEventListener('oauth-account-swapped', refreshCompact);
        window.addEventListener('profile-swapped', refreshCompact);
        return () => {
            window.removeEventListener('oauth-account-swapped', refreshCompact);
            window.removeEventListener('profile-swapped', refreshCompact);
        };
    }, [refreshCompact]);

    const displayName = user?.name || oauthAlias || oauthEmail?.split('@')[0] || '未绑定账号';
    const subText = user?.userTier?.name || oauthEmail || '点击管理多账号';

    return (
        <div className="flex items-center gap-2.5 px-3 py-2 border-t border-border/30">
            <Avatar className="w-7 h-7 rounded-full">
                {profilePic && <AvatarImage src={`data:image/png;base64,${profilePic}`} alt={displayName} />}
                <AvatarFallback className="rounded-full bg-indigo-500/20 text-xs font-bold text-indigo-400">
                    {displayName[0]?.toUpperCase() || '?'}
                </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
                <div className="text-xs font-medium truncate">{displayName}</div>
                <div className="text-[10px] text-muted-foreground truncate">{subText}</div>
            </div>
        </div>
    );
}

// === Account & Multi-User View — works both with active LS & headless/offline VPS ===

interface Model {
    label: string;
    modelId: string;
    supportsImages: boolean;
    isRecommended: boolean;
    quota: number;
    resetTime: string | null;
}

interface AccountInfoViewProps {
    detected?: boolean;
    onBackHome?: () => void;
}

function formatCountdown(target: Date): string {
    const diff = target.getTime() - Date.now();
    if (diff <= 0) return '即将重置...';
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    if (days > 0) return `${days}天 ${hours}小时`;
    const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    return `${hours}小时 ${mins}分`;
}

export function AccountInfoView({ detected = true, onBackHome }: AccountInfoViewProps) {
    const [user, setUser] = useState<any>(null);
    const [profilePic, setProfilePic] = useState<string | null>(null);
    const [models, setModels] = useState<Model[]>([]);
    const [profileData, setProfileData] = useState<ProfileListResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [now, setNow] = useState(Date.now());

    const loadData = useCallback(async () => {
        setLoading(true);
        try {
            const profTask = getProfiles();
            if (detected) {
                const [profRes, userRes, modelsRes] = await Promise.allSettled([
                    profTask,
                    fetch(`${API_BASE}/api/user/profile`, { headers: authHeaders() }).then(r => (r.ok ? r.json() : null)),
                    fetch(`${API_BASE}/api/models`, { headers: authHeaders() }).then(r => (r.ok ? r.json() : null)),
                ]);
                if (profRes.status === 'fulfilled') setProfileData(profRes.value);
                if (userRes.status === 'fulfilled' && userRes.value) {
                    setUser(userRes.value.user || null);
                    setProfilePic(userRes.value.profilePicture || null);
                } else {
                    setUser(null);
                    setProfilePic(null);
                }
                if (modelsRes.status === 'fulfilled' && modelsRes.value) {
                    setModels(modelsRes.value.models || []);
                } else {
                    setModels([]);
                }
            } else {
                const profRes = await profTask.catch(() => null);
                setProfileData(profRes);
                setUser(null);
                setProfilePic(null);
                setModels([]);
            }
        } finally {
            setLoading(false);
        }
    }, [detected]);

    useEffect(() => { loadData(); }, [loadData]);

    useEffect(() => {
        const delayedReload = () => {
            loadData();
            [4000, 9000].forEach(delay => setTimeout(() => loadData(), delay));
        };
        const immediateReload = () => { loadData(); };
        window.addEventListener('profile-swapped', delayedReload);
        window.addEventListener('oauth-account-swapped', immediateReload);
        return () => {
            window.removeEventListener('profile-swapped', delayedReload);
            window.removeEventListener('oauth-account-swapped', immediateReload);
        };
    }, [loadData]);

    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 60_000);
        return () => clearInterval(timer);
    }, []);

    const resetDate = useMemo(() => {
        const times = models
            .map(m => m.resetTime)
            .filter((t): t is string => !!t)
            .map(t => new Date(t).getTime())
            .filter(t => t > now);
        return times.length > 0 ? new Date(Math.min(...times)) : null;
    }, [models, now]);
    const countdown = useMemo(() => resetDate ? formatCountdown(resetDate) : '—', [resetDate, now]);
    const resetDateStr = useMemo(() => resetDate ? resetDate.toLocaleString('zh-CN', {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    }) : '暂无重置时间', [resetDate]);

    if (loading) {
        return (
            <div className="flex-1 overflow-y-auto">
                <div className="max-w-3xl mx-auto p-6 space-y-4">
                    <Skeleton className="h-6 w-40" />
                    <Skeleton className="h-28 w-full rounded-xl" />
                    <Skeleton className="h-64 w-full rounded-xl" />
                </div>
            </div>
        );
    }

    const oauth = profileData?.oauth;
    const tierName = user?.userTier?.name || '';
    const planName = user?.planStatus?.planInfo?.planName || '';
    const displayName = user?.name || oauth?.activeAlias || oauth?.activeName || profileData?.active || '未选择账号';
    const displayEmail = user?.email || oauth?.activeEmail || '';

    return (
        <div className="flex-1 overflow-y-auto">
            <div className="max-w-3xl mx-auto p-4 sm:p-6 space-y-5">

                {/* Top Header */}
                <div className="flex items-center gap-2">
                    {onBackHome && !detected && (
                        <Button variant="ghost" size="sm" onClick={onBackHome} className="h-7 px-2 text-xs gap-1">
                            <ArrowLeft className="h-3.5 w-3.5" /> 返回
                        </Button>
                    )}
                    <h2 className="text-sm font-semibold tracking-wide text-muted-foreground flex items-center gap-1.5">
                        <Zap className="h-3.5 w-3.5 text-indigo-400" /> 账户管理与模型配额
                    </h2>
                    <div className="flex-1 h-px bg-border/40" />
                    <Button variant="outline" size="sm" onClick={loadData} className="h-7 text-xs gap-1">
                        <RefreshCw className="h-3 w-3" /> 刷新
                    </Button>
                </div>

                {/* Account Overview Hero Card */}
                <div className="relative overflow-hidden rounded-xl border border-border/50 bg-gradient-to-br from-indigo-500/12 via-purple-500/5 to-transparent p-5">
                    <div className="absolute top-0 right-0 w-36 h-36 bg-indigo-500/8 rounded-full -translate-y-1/2 translate-x-1/2 pointer-events-none" />
                    <div className="flex flex-wrap items-center justify-between gap-4 relative">
                        <div className="flex items-center gap-4 min-w-0">
                            <Avatar className="w-12 h-12 rounded-full ring-2 ring-indigo-500/25">
                                {profilePic && <AvatarImage src={`data:image/png;base64,${profilePic}`} alt={displayName} />}
                                <AvatarFallback className="rounded-full bg-indigo-500/20 text-lg font-bold text-indigo-400">
                                    {displayName[0]?.toUpperCase() || '?'}
                                </AvatarFallback>
                            </Avatar>
                            <div className="min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                    <span className="text-base font-semibold truncate">{displayName}</span>
                                    {oauth?.activeAlias && (
                                        <Badge variant="outline" className="text-[10px] h-5 px-1.5 border-emerald-500/35 text-emerald-400 gap-1">
                                            <KeyRound className="h-2.5 w-2.5" /> OAuth: {oauth.activeAlias}
                                        </Badge>
                                    )}
                                </div>
                                {displayEmail ? (
                                    <p className="text-xs text-muted-foreground truncate mt-0.5">{displayEmail}</p>
                                ) : (
                                    <p className="text-xs text-muted-foreground mt-0.5">
                                        {detected ? '已连接 Language Server' : '当前为离线 / 无头服务器模式（可自由切换与导入账号）'}
                                    </p>
                                )}
                            </div>
                        </div>

                        <div className="flex items-center gap-2 flex-wrap">
                            {tierName && (
                                <Badge className="bg-indigo-500/20 text-indigo-400 border-indigo-500/30 hover:bg-indigo-500/30">
                                    {tierName}
                                </Badge>
                            )}
                            {planName && (
                                <Badge variant="outline" className="border-purple-500/30 text-purple-400">
                                    {planName} 方案
                                </Badge>
                            )}
                            {!detected && (
                                <Badge variant="outline" className="border-amber-500/30 text-amber-400 gap-1 font-normal">
                                    <Server className="h-3 w-3" /> 离线/VPS 模式
                                </Badge>
                            )}
                        </div>
                    </div>
                </div>

                {/* Cross-platform Multi-Account Hub */}
                <ProfileSwitcher detected={detected} onAccountChanged={loadData} />

                {/* Model Usage (when IDE Language Server is connected) */}
                {models.length > 0 && (
                    <div className="space-y-3">
                        <div className="flex items-center justify-between">
                            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                                <User className="h-3.5 w-3.5" /> 模型余量统计
                            </h3>
                            <span className="text-[11px] text-muted-foreground">共 {models.length} 个模型</span>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                            {models.map((model) => {
                                const pct = Math.round(model.quota * 100);
                                return (
                                    <div key={model.modelId || model.label} className="px-4 py-3 rounded-lg border border-border/40 bg-muted/10">
                                        <div className="flex items-center justify-between gap-2 mb-2">
                                            <div className="flex items-center gap-1.5 min-w-0">
                                                <span className="text-xs font-medium truncate">{model.label}</span>
                                                {model.isRecommended && (
                                                    <Badge variant="outline" className="text-[9px] h-4 px-1 border-amber-500/30 text-amber-500 shrink-0">推荐</Badge>
                                                )}
                                            </div>
                                            <span className={cn(
                                                'text-xs font-semibold tabular-nums shrink-0',
                                                pct > 50 ? 'text-emerald-400' : pct > 20 ? 'text-amber-400' : 'text-red-400'
                                            )}>
                                                {pct}%
                                            </span>
                                        </div>
                                        <div className="h-1.5 bg-muted/30 rounded-full overflow-hidden">
                                            <div
                                                className={cn(
                                                    'h-full rounded-full transition-all duration-500',
                                                    pct > 50 ? 'bg-emerald-500/75' : pct > 20 ? 'bg-amber-500/75' : 'bg-red-500/75'
                                                )}
                                                style={{ width: `${pct}%` }}
                                            />
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}

                {/* Reset Timing (shown when quota reset dates are available) */}
                {resetDate && (
                    <div className="rounded-xl border border-border/50 bg-muted/10 p-4">
                        <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2.5">
                                <div className="w-8 h-8 rounded-lg bg-amber-500/10 flex items-center justify-center">
                                    <Calendar className="h-4 w-4 text-amber-400" />
                                </div>
                                <div>
                                    <div className="text-xs font-medium">额度重置时间</div>
                                    <div className="text-[11px] text-muted-foreground">{resetDateStr}</div>
                                </div>
                            </div>
                            <div className="flex items-center gap-1.5 text-right">
                                <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                                <span className="text-sm font-semibold text-amber-400">{countdown}</span>
                            </div>
                        </div>
                    </div>
                )}

            </div>
        </div>
    );
}
