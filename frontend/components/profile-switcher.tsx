'use client';
import { useState, useEffect, useCallback, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Loader2, Trash2, ArrowLeftRight, UserCircle, Plus } from 'lucide-react';
import { getProfiles, swapProfile, createProfileEntry, deleteProfileEntry, autoOnboardProfile, startAddAccountFlow, cancelAddAccountFlow, type ProfileEntry } from '@/lib/cascade-api';
import { cn } from '@/lib/utils';

export function ProfileSwitcher() {
    const [profiles, setProfiles] = useState<ProfileEntry[]>([]);
    const [active, setActive] = useState<string | null>(null);
    const [swapping, setSwapping] = useState(false);
    const [addingAccount, setAddingAccount] = useState(false); // step 1: enter name
    const [awaitingLogin, setAwaitingLogin] = useState(false); // step 2: IDE open, waiting for login
    const [previousProfile, setPreviousProfile] = useState<string | null>(null);
    const [newName, setNewName] = useState('');
    const [loading, setLoading] = useState(true);
    const [onboarding, setOnboarding] = useState(false);
    const [status, setStatus] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);
    const onboardAttempted = useRef(false);

    const loadProfiles = useCallback(async () => {
        try {
            const data = await getProfiles();
            setProfiles(data.profiles);
            setActive(data.active);
            return data;
        } catch { /* ignore */ }
        finally { setLoading(false); }
        return null;
    }, []);

    // Auto-onboard: create default profile from IDE account when 0 profiles exist
    const tryAutoOnboard = useCallback(async () => {
        if (onboardAttempted.current) return;
        onboardAttempted.current = true;
        setOnboarding(true);
        try {
            const result = await autoOnboardProfile();
            if (result.created) {
                setStatus({ type: 'success', msg: `已自动保存账号档案 "${result.autoName}"` });
                await loadProfiles();
            }
        } catch {
            // IDE not running or not logged in — silently skip, user will see empty state with action button
        } finally { setOnboarding(false); }
    }, [loadProfiles]);

    useEffect(() => {
        loadProfiles().then(data => {
            // Auto-onboard when: no profiles, OR in "adding" state (profiles exist but no active)
            if (data && (data.profiles.length === 0 || !data.active)) tryAutoOnboard();
        });
    }, [loadProfiles, tryAutoOnboard]);

    useEffect(() => {
        if (!status) return;
        const t = setTimeout(() => setStatus(null), 5000);
        return () => clearTimeout(t);
    }, [status]);

    const handleSwap = async (target: string) => {
        if (swapping || target === active) return;
        if (!confirm(`确定切换到 "${target}"？这会关闭并重启 Antigravity IDE（约 10 秒）。`)) return;
        setSwapping(true);
        setStatus(null);
        try {
            const result = await swapProfile(target);
            setActive(result.activeProfile);
            setStatus({ type: 'success', msg: `已切换至 ${target}` });
            loadProfiles();
            // Notify other components to refresh account data
            window.dispatchEvent(new CustomEvent('profile-swapped', { detail: result }));
        } catch (e: any) {
            setStatus({ type: 'error', msg: e.message });
        } finally { setSwapping(false); }
    };

    // Start "Add New Account" — close IDE, launch fresh
    const handleStartAddAccount = async () => {
        if (!confirm('此操作将关闭当前 Antigravity IDE 并以空白登录状态重启，是否继续？')) return;
        setSwapping(true);
        setStatus(null);
        try {
            const result = await startAddAccountFlow();
            setPreviousProfile(result.previousProfile);
            setAwaitingLogin(true);
            setAddingAccount(false);
            setStatus({ type: 'success', msg: result.message });
        } catch (e: any) {
            setStatus({ type: 'error', msg: e.message });
        } finally { setSwapping(false); }
    };

    // Save new account after user logged in
    const handleSaveNewAccount = async (force = false) => {
        const name = newName.trim().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9_-]/g, '');
        if (!name) return;
        try {
            const result = await createProfileEntry(name, force);
            setNewName('');
            setAwaitingLogin(false);
            setAddingAccount(false);
            loadProfiles();
            setStatus({ type: 'success', msg: `账号档案已保存为 "${name}"` });
        } catch (e: any) {
            if (e.message.includes('already saved as profile')) {
                if (confirm(`${e.message}\n\n仍要覆盖保存吗？`)) return handleSaveNewAccount(true);
                return;
            }
            setStatus({ type: 'error', msg: e.message });
        }
    };

    // Cancel add account — restore previous profile
    const handleCancelAdd = async () => {
        if (!previousProfile) { setAwaitingLogin(false); setAddingAccount(false); return; }
        setSwapping(true);
        try {
            await cancelAddAccountFlow(previousProfile);
            setAwaitingLogin(false);
            setAddingAccount(false);
            setPreviousProfile(null);
            loadProfiles();
            setStatus({ type: 'success', msg: '已恢复之前的账号档案' });
        } catch (e: any) {
            setStatus({ type: 'error', msg: e.message });
        } finally { setSwapping(false); }
    };

    const handleDelete = async (name: string) => {
        if (!confirm(`确定删除账号档案 "${name}"？该账号保存的所有本地登录状态将被移除。`)) return;
        try {
            await deleteProfileEntry(name);
            loadProfiles();
            setStatus({ type: 'success', msg: `已删除账号档案 "${name}"` });
        } catch (e: any) {
            setStatus({ type: 'error', msg: e.message });
        }
    };

    if (loading) return null;

    const activeProfile = profiles.find(p => p.name === active);
    const otherProfiles = profiles.filter(p => p.name !== active);

    return (
        <div>
            <div className="flex items-center justify-between mb-3">
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                    <UserCircle className="h-3 w-3" /> 多账号切换
                </h3>
                {/* Add Account button */}
            {!addingAccount && !awaitingLogin && !swapping && (
                    <Button variant="outline" size="sm" className="h-6 text-[10px]" onClick={handleStartAddAccount}>
                        <Plus className="h-3 w-3 mr-1" /> 添加账号
                    </Button>
                )}
            </div>

            {/* Onboarding in progress */}
            {onboarding && (
                <div className="flex items-center gap-2 px-4 py-3 rounded-lg border border-indigo-500/30 bg-indigo-500/10 mb-3">
                    <Loader2 className="h-4 w-4 animate-spin text-indigo-400" />
                    <span className="text-xs text-indigo-400 font-medium">正在识别 IDE 当前登录账号...</span>
                </div>
            )}

            {/* Empty state — no profiles saved yet */}
            {profiles.length === 0 && !onboarding && (
                <div className="mb-3">
                    <p className="text-xs text-muted-foreground mb-2">
                        尚未保存任何账号档案。保存当前 IDE 账号后即可随时在多个 Google 账号之间无缝切换（当前仅支持 Windows）。
                    </p>
                    {!addingAccount && (
                        <Button variant="outline" size="sm" className="h-7 text-[10px]" onClick={() => setAddingAccount(true)}>
                            <Plus className="h-3 w-3 mr-1" /> 保存当前账号
                        </Button>
                    )}
                </div>
            )}

            {/* Swap in progress */}
            {swapping && (
                <div className="flex items-center gap-2 px-4 py-3 rounded-lg border border-amber-500/30 bg-amber-500/10 mb-3">
                    <Loader2 className="h-4 w-4 animate-spin text-amber-400" />
                    <span className="text-xs text-amber-400 font-medium">正在切换账号并重启 IDE（约需 10 秒）...</span>
                </div>
            )}

            {/* Status toast */}
            {status && (
                <div className={cn(
                    "px-3 py-2 rounded-lg border mb-3 text-xs font-medium",
                    status.type === 'success' ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400" : "border-red-500/30 bg-red-500/10 text-red-400"
                )}>{status.msg}</div>
            )}

            {/* Active profile */}
            {activeProfile && (
                <div className="px-3 py-2.5 rounded-lg border border-emerald-500/20 bg-emerald-500/5 mb-2">
                    <div className="flex items-center gap-2">
                        <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
                        <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                                <span className="text-xs font-medium">{activeProfile.meta?.userName || activeProfile.name}</span>
                                <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30 text-[9px] h-4 px-1.5">当前使用</Badge>
                                {activeProfile.meta?.tier && (
                                    <Badge variant="outline" className="text-[9px] h-4 px-1.5 border-indigo-500/30 text-indigo-400">{activeProfile.meta.tier}</Badge>
                                )}
                            </div>
                            {activeProfile.meta?.email && (
                                <p className="text-[10px] text-muted-foreground truncate mt-0.5">{activeProfile.meta.email}</p>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* Other profiles — swap targets */}
            {otherProfiles.map(p => (
                <div key={p.name} className="flex items-center justify-between px-3 py-2 rounded-lg border border-border/40 bg-muted/10 mb-1.5">
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                            <span className="text-xs font-medium truncate">{p.meta?.userName || p.name}</span>
                            {p.meta?.tier && (
                                <Badge variant="outline" className="text-[9px] h-4 px-1.5 border-muted-foreground/30 text-muted-foreground">{p.meta.tier}</Badge>
                            )}
                        </div>
                        {p.meta?.email && (
                            <p className="text-[10px] text-muted-foreground truncate">{p.meta.email}</p>
                        )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0 ml-2">
                        <Button variant="ghost" size="sm" className="h-6 px-2 text-[10px]" onClick={() => handleSwap(p.name)} disabled={swapping}>
                            <ArrowLeftRight className="h-3 w-3 mr-1" /> 切换
                        </Button>
                        <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-muted-foreground hover:text-red-400" onClick={() => handleDelete(p.name)} disabled={swapping}>
                            <Trash2 className="h-3 w-3" />
                        </Button>
                    </div>
                </div>
            ))}

            {/* No active profile — in "adding" state, show save prompt */}
            {!active && profiles.length > 0 && !awaitingLogin && !onboarding && (
                <div className="mt-2 p-3 rounded-lg border border-amber-500/30 bg-amber-500/5">
                    <p className="text-xs text-amber-400 font-medium mb-2">
                        🔑 检测到未归档的新账号，请命名并保存以启用快速切换：
                    </p>
                    <div className="flex items-center gap-2">
                        <Input
                            value={newName} onChange={e => setNewName(e.target.value)}
                            placeholder="档案别名（仅限英文/数字，如 work, personal）"
                            className="h-7 text-xs flex-1" autoFocus
                            onKeyDown={e => { if (e.key === 'Enter') handleSaveNewAccount(); }}
                        />
                        <Button variant="outline" size="sm" className="h-7 text-[10px]" onClick={() => handleSaveNewAccount()} disabled={!newName.trim() || swapping}>
                            保存
                        </Button>
                    </div>
                </div>
            )}

            {/* Awaiting Login — IDE is open fresh, user needs to login then save */}
            {awaitingLogin && (
                <div className="mt-2 p-3 rounded-lg border border-amber-500/30 bg-amber-500/5">
                    <p className="text-xs text-amber-400 font-medium mb-2">
                        🔑 请在重启后的 Antigravity IDE 中登录新的 Google 账号，然后在下方保存：
                    </p>
                    <div className="flex items-center gap-2">
                        <Input
                            value={newName} onChange={e => setNewName(e.target.value)}
                            placeholder="档案别名（仅限英文/数字，如 work, personal）"
                            className="h-7 text-xs flex-1" autoFocus
                            onKeyDown={e => { if (e.key === 'Enter') handleSaveNewAccount(); if (e.key === 'Escape') handleCancelAdd(); }}
                        />
                        <Button variant="outline" size="sm" className="h-7 text-[10px]" onClick={() => handleSaveNewAccount()} disabled={!newName.trim() || swapping}>
                            保存
                        </Button>
                        <Button variant="ghost" size="sm" className="h-7 text-[10px] text-muted-foreground" onClick={handleCancelAdd} disabled={swapping}>
                            取消
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
}
