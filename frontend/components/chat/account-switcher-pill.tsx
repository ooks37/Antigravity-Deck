'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
    getOAuthAccounts,
    getOAuthQuotas,
    switchOAuthAccount,
    type ActiveModelAccount,
    type OAuthAccountMeta,
    type OAuthAccountQuota,
} from '@/lib/cascade-api';
import { cn } from '@/lib/utils';
import { UserCheck, ChevronDown, Check, RefreshCw, Settings2, Loader2, AlertTriangle } from 'lucide-react';

interface AccountSwitcherPillProps {
    activeAccount?: ActiveModelAccount | null;
    detected: boolean;
    onSwitched?: () => Promise<void> | void;
    onOpenAccounts?: () => void;
}

export function AccountSwitcherPill({
    activeAccount,
    detected,
    onSwitched,
    onOpenAccounts,
}: AccountSwitcherPillProps) {
    const [open, setOpen] = useState(false);
    const [accounts, setAccounts] = useState<OAuthAccountMeta[]>([]);
    const [quotaMap, setQuotaMap] = useState<Record<string, OAuthAccountQuota>>({});
    const [switchingAlias, setSwitchingAlias] = useState<string | null>(null);
    const [refreshingQuotas, setRefreshingQuotas] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const ref = useRef<HTMLDivElement>(null);

    const loadAccounts = useCallback(async () => {
        try {
            const res = await getOAuthAccounts();
            const list = res.accounts || [];
            setAccounts(list);
            setQuotaMap((prev) => {
                const next = { ...prev };
                for (const acc of list) {
                    if (acc.quota) next[acc.alias] = acc.quota;
                }
                return next;
            });
        } catch {
            /* ignore */
        }
    }, []);

    useEffect(() => {
        let active = true;
        getOAuthAccounts()
            .then((res) => {
                if (!active) return;
                const list = res.accounts || [];
                setAccounts(list);
                setQuotaMap((prev) => {
                    const next = { ...prev };
                    for (const acc of list) {
                        if (acc.quota) next[acc.alias] = acc.quota;
                    }
                    return next;
                });
            })
            .catch(() => { /* ignore */ });
        const handler = () => { void loadAccounts(); };
        window.addEventListener('oauth-account-swapped', handler);
        return () => {
            active = false;
            window.removeEventListener('oauth-account-swapped', handler);
        };
    }, [loadAccounts]);

    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) {
                setOpen(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, []);

    const handleRefreshQuotas = async (e: React.MouseEvent) => {
        e.stopPropagation();
        if (refreshingQuotas) return;
        setRefreshingQuotas(true);
        setError(null);
        try {
            const res = await getOAuthQuotas();
            if ('accounts' in res && Array.isArray(res.accounts)) {
                setQuotaMap((prev) => {
                    const next = { ...prev };
                    for (const q of res.accounts) {
                        next[q.alias] = q;
                    }
                    return next;
                });
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : '刷新配额失败');
        } finally {
            setRefreshingQuotas(false);
        }
    };

    const handleSelectAccount = async (acc: OAuthAccountMeta) => {
        if (switchingAlias) return;
        if (acc.isActive) {
            setOpen(false);
            return;
        }
        setSwitchingAlias(acc.alias);
        setError(null);
        try {
            const res = await switchOAuthAccount(acc.alias, {
                reloadHub: detected,
                refreshIfExpired: true,
            });
            await loadAccounts();
            window.dispatchEvent(new CustomEvent('oauth-account-swapped', { detail: { ...res, source: 'picker' } }));
            await onSwitched?.();
            setOpen(false);
        } catch (err) {
            setError(err instanceof Error ? err.message : '切换账号失败');
        } finally {
            setSwitchingAlias(null);
        }
    };

    const activeEntry = accounts.find((a) => a.isActive) || null;
    const activeQuota = activeEntry ? quotaMap[activeEntry.alias] : undefined;
    const displayAlias = activeAccount?.alias
        || activeEntry?.alias
        || activeAccount?.email?.split('@')[0]
        || '切换账号';
    const displayTier = activeAccount?.tierLabel || activeQuota?.tierLabel || null;
    const busy = Boolean(switchingAlias);

    return (
        <div className="relative" ref={ref}>
            <button
                type="button"
                onClick={() => {
                    const nextOpen = !open;
                    setOpen(nextOpen);
                    if (nextOpen) loadAccounts();
                }}
                className={cn(
                    'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-xs border transition-colors cursor-pointer max-w-[180px]',
                    'bg-muted/50 hover:bg-muted border-border/60 text-foreground'
                )}
                title={activeAccount?.email ? `当前 agy 账号: ${activeAccount.email}${displayTier ? ` (${displayTier})` : ''}` : '切换 agy OAuth 账号'}
            >
                {busy
                    ? <Loader2 className="h-3 w-3 animate-spin text-primary shrink-0" />
                    : <UserCheck className="h-3 w-3 text-emerald-500 shrink-0" />
                }
                <span className="truncate font-medium">{displayAlias}</span>
                {displayTier && (
                    <span className="hidden sm:inline text-[10px] px-1.5 py-0.2 rounded-full bg-primary/10 text-primary truncate max-w-[78px]">
                        {displayTier.replace(/\s*\(.*?\)\s*/g, '')}
                    </span>
                )}
                <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
            </button>

            {open && (
                <div className="absolute bottom-full left-0 mb-2 w-[300px] sm:w-[320px] max-h-[60vh] overflow-y-auto rounded-2xl border border-border bg-popover text-popover-foreground shadow-xl z-50 p-2 space-y-1.5">
                    <div className="px-2 py-1.5 flex items-center justify-between gap-2 text-[11px] border-b border-border/50">
                        <span className="font-medium text-foreground/90">
                            agy 账号切换 ({accounts.length})
                        </span>
                        <div className="flex items-center gap-1">
                            <button
                                type="button"
                                onClick={handleRefreshQuotas}
                                disabled={refreshingQuotas}
                                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors cursor-pointer"
                                title="检测所有账号等级与实时配额"
                            >
                                <RefreshCw className={cn('h-3 w-3', refreshingQuotas && 'animate-spin')} />
                                <span>测配额</span>
                            </button>
                            {onOpenAccounts && (
                                <button
                                    type="button"
                                    onClick={() => { setOpen(false); onOpenAccounts(); }}
                                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors cursor-pointer"
                                    title="管理 / 导入 OAuth 账号"
                                >
                                    <Settings2 className="h-3 w-3" />
                                    <span>管理</span>
                                </button>
                            )}
                        </div>
                    </div>

                    {error && (
                        <div className="mx-1 px-2 py-1.5 rounded-lg bg-rose-500/10 border border-rose-500/20 text-[11px] text-rose-500 flex items-center gap-1.5">
                            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                            <span className="truncate">{error}</span>
                        </div>
                    )}

                    {accounts.length === 0 ? (
                        <div className="py-5 text-center space-y-2">
                            <p className="text-xs text-muted-foreground">暂无已保存的 agy OAuth 账号</p>
                            {onOpenAccounts && (
                                <button
                                    type="button"
                                    onClick={() => { setOpen(false); onOpenAccounts(); }}
                                    className="text-xs text-primary hover:underline cursor-pointer"
                                >
                                    前往导入或登录账号
                                </button>
                            )}
                        </div>
                    ) : (
                        <div className="space-y-1">
                            {accounts.map((acc) => {
                                const q = quotaMap[acc.alias];
                                const avgPct = typeof q?.avgQuota === 'number' ? Math.round(q.avgQuota * 100) : null;
                                const isSwitchingThis = switchingAlias === acc.alias;
                                return (
                                    <button
                                        key={acc.alias}
                                        type="button"
                                        disabled={Boolean(switchingAlias)}
                                        onClick={() => handleSelectAccount(acc)}
                                        className={cn(
                                            'w-full rounded-xl px-2.5 py-2 border text-left transition-colors cursor-pointer flex items-center justify-between gap-2',
                                            acc.isActive
                                                ? 'bg-primary/8 border-primary/35'
                                                : 'bg-transparent border-transparent hover:bg-muted/60'
                                        )}
                                    >
                                        <div className="min-w-0 flex-1 space-y-0.5">
                                            <div className="flex items-center gap-1.5">
                                                <span className={cn(
                                                    'w-1.5 h-1.5 rounded-full shrink-0',
                                                    acc.isActive ? 'bg-emerald-500' : acc.isExpired && !acc.hasRefreshToken ? 'bg-rose-400' : 'bg-muted-foreground/35'
                                                )} />
                                                <span className="text-xs font-semibold truncate">{acc.alias}</span>
                                                {q?.tierLabel && (
                                                    <span className="text-[9px] px-1.5 py-0.2 rounded-full bg-primary/10 text-primary shrink-0">
                                                        {q.tierLabel}
                                                    </span>
                                                )}
                                                {acc.isExpired && !acc.hasRefreshToken && (
                                                    <span className="text-[9px] px-1 py-0.2 rounded bg-rose-500/15 text-rose-500 shrink-0">
                                                        已过期
                                                    </span>
                                                )}
                                            </div>
                                            <div className="text-[10px] text-muted-foreground truncate pl-3">
                                                {acc.email || acc.name || '未知邮箱'}
                                            </div>
                                        </div>

                                        <div className="flex items-center gap-1.5 shrink-0">
                                            {Array.isArray(q?.pools) && q!.pools!.length > 0 ? (
                                                <div className="flex items-center gap-1">
                                                    {q!.pools!.map((pool) => {
                                                        const pct = pool.percent ?? Math.round((pool.remainingFraction ?? 1) * 100);
                                                        const shortTag = pool.id.startsWith('gemini') ? 'G' : pool.id === 'claude' ? 'C' : (pool.shortLabel || pool.label).slice(0, 2);
                                                        return (
                                                            <span
                                                                key={pool.id}
                                                                className={cn(
                                                                    'text-[9px] font-mono px-1 py-0.2 rounded border',
                                                                    pct > 50
                                                                        ? 'text-emerald-400 border-emerald-500/25 bg-emerald-500/10'
                                                                        : pct > 15
                                                                            ? 'text-amber-400 border-amber-500/25 bg-amber-500/10'
                                                                            : 'text-rose-400 border-rose-500/25 bg-rose-500/10'
                                                                )}
                                                                title={`${pool.label} 池剩余 ${pct}%`}
                                                            >
                                                                {shortTag} {pct}%
                                                            </span>
                                                        );
                                                    })}
                                                </div>
                                            ) : avgPct !== null ? (
                                                <span className={cn(
                                                    'text-[10px] font-mono',
                                                    avgPct <= 15 ? 'text-amber-500 font-semibold' : 'text-muted-foreground'
                                                )}>
                                                    {avgPct}%
                                                </span>
                                            ) : null}
                                            {isSwitchingThis ? (
                                                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                                            ) : acc.isActive ? (
                                                <Check className="h-3.5 w-3.5 text-primary" />
                                            ) : null}
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
