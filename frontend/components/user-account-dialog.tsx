'use client';

import { useCallback, useEffect, useState } from 'react';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { useAuthUser } from '@/components/auth-gate';
import {
    changeOwnCredentials,
    createUserAccount,
    deleteUserAccount,
    listUsers,
    updateUserAccount,
    type UserProfile,
} from '@/lib/cascade-api';
import {
    KeyRound,
    Loader2,
    LogOut,
    Plus,
    Shield,
    Trash2,
    UserCheck,
    UserMinus,
    Users,
} from 'lucide-react';

interface UserAccountDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    initialTab?: 'account' | 'members';
}

export function UserAccountDialog({
    open,
    onOpenChange,
    initialTab = 'account',
}: UserAccountDialogProps) {
    const { user, refreshUser, logout } = useAuthUser();
    const isAdmin = user?.role === 'admin';
    const [tab, setTab] = useState<'account' | 'members'>(initialTab);

    // Account security state
    const [displayName, setDisplayName] = useState('');
    const [currentPassword, setCurrentPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [savingAccount, setSavingAccount] = useState(false);
    const [accountMsg, setAccountMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

    // Admin member management state
    const [users, setUsers] = useState<UserProfile[]>([]);
    const [loadingUsers, setLoadingUsers] = useState(false);
    const [membersError, setMembersError] = useState('');
    const [newUsername, setNewUsername] = useState('');
    const [newDisplay, setNewDisplay] = useState('');
    const [newMemberPass, setNewMemberPass] = useState('');
    const [newMemberRole, setNewMemberRole] = useState<'member' | 'admin'>('member');
    const [creatingUser, setCreatingUser] = useState(false);
    const [resetTargetId, setResetTargetId] = useState<string | null>(null);
    const [resetPasswordVal, setResetPasswordVal] = useState('');
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
    const [busyUserId, setBusyUserId] = useState<string | null>(null);

    useEffect(() => {
        if (!open) return;
        setTab(initialTab === 'members' && isAdmin ? 'members' : 'account');
        setDisplayName(user?.displayName || '');
        setCurrentPassword('');
        setNewPassword('');
        setAccountMsg(null);
        setConfirmDeleteId(null);
        setResetTargetId(null);
    }, [open, initialTab, isAdmin, user?.displayName]);

    const loadMembers = useCallback(async () => {
        if (!isAdmin) return;
        setLoadingUsers(true);
        setMembersError('');
        try {
            const res = await listUsers();
            setUsers(res.users || []);
        } catch (err) {
            setMembersError(err instanceof Error ? err.message : '加载成员列表失败');
        } finally {
            setLoadingUsers(false);
        }
    }, [isAdmin]);

    useEffect(() => {
        if (open && tab === 'members' && isAdmin) {
            loadMembers();
        }
    }, [open, tab, isAdmin, loadMembers]);

    const handleSaveAccount = async (e: React.FormEvent) => {
        e.preventDefault();
        setAccountMsg(null);
        if (!newPassword.trim() && displayName.trim() === (user?.displayName || '')) {
            setAccountMsg({ kind: 'err', text: '没有需要保存的修改' });
            return;
        }
        if (newPassword.trim() && newPassword.trim().length < 4) {
            setAccountMsg({ kind: 'err', text: '新密码至少 4 位字符' });
            return;
        }
        setSavingAccount(true);
        try {
            await changeOwnCredentials({
                displayName: displayName.trim() || undefined,
                currentPassword: currentPassword.trim() || undefined,
                newPassword: newPassword.trim() || undefined,
            });
            setCurrentPassword('');
            setNewPassword('');
            await refreshUser();
            setAccountMsg({ kind: 'ok', text: '账号信息已更新' });
        } catch (err) {
            setAccountMsg({ kind: 'err', text: err instanceof Error ? err.message : '保存失败' });
        } finally {
            setSavingAccount(false);
        }
    };

    const handleCreateMember = async (e: React.FormEvent) => {
        e.preventDefault();
        setMembersError('');
        setCreatingUser(true);
        try {
            await createUserAccount({
                username: newUsername.trim(),
                password: newMemberPass.trim(),
                displayName: newDisplay.trim() || undefined,
                role: newMemberRole,
            });
            setNewUsername('');
            setNewDisplay('');
            setNewMemberPass('');
            setNewMemberRole('member');
            await loadMembers();
        } catch (err) {
            setMembersError(err instanceof Error ? err.message : '创建成员失败');
        } finally {
            setCreatingUser(false);
        }
    };

    const handleToggleDisabled = async (target: UserProfile) => {
        setBusyUserId(target.id);
        setMembersError('');
        try {
            await updateUserAccount(target.id, { disabled: !target.disabled });
            await loadMembers();
        } catch (err) {
            setMembersError(err instanceof Error ? err.message : '操作失败');
        } finally {
            setBusyUserId(null);
        }
    };

    const handleResetMemberPassword = async (targetId: string) => {
        if (resetPasswordVal.trim().length < 4) {
            setMembersError('重置密码至少 4 位字符');
            return;
        }
        setBusyUserId(targetId);
        setMembersError('');
        try {
            await updateUserAccount(targetId, { password: resetPasswordVal.trim() });
            setResetTargetId(null);
            setResetPasswordVal('');
            await loadMembers();
        } catch (err) {
            setMembersError(err instanceof Error ? err.message : '重置密码失败');
        } finally {
            setBusyUserId(null);
        }
    };

    const handleDeleteMember = async (targetId: string) => {
        setBusyUserId(targetId);
        setMembersError('');
        try {
            await deleteUserAccount(targetId);
            setConfirmDeleteId(null);
            await loadMembers();
        } catch (err) {
            setMembersError(err instanceof Error ? err.message : '删除失败');
        } finally {
            setBusyUserId(null);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[520px] max-h-[85dvh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle className="text-base">
                        {tab === 'members' ? '团队成员管理' : '个人账号设置'}
                    </DialogTitle>
                    <DialogDescription className="text-xs">
                        {user ? `${user.displayName} (@${user.username})` : ''}
                    </DialogDescription>
                </DialogHeader>

                {isAdmin && (
                    <div className="flex gap-1 border-b border-border/60 pb-2">
                        <Button
                            type="button"
                            size="sm"
                            variant={tab === 'account' ? 'secondary' : 'ghost'}
                            className="h-7 text-xs gap-1.5"
                            onClick={() => setTab('account')}
                        >
                            <KeyRound className="h-3.5 w-3.5" /> 账号安全
                        </Button>
                        <Button
                            type="button"
                            size="sm"
                            variant={tab === 'members' ? 'secondary' : 'ghost'}
                            className="h-7 text-xs gap-1.5"
                            onClick={() => setTab('members')}
                        >
                            <Users className="h-3.5 w-3.5" /> 成员管理
                        </Button>
                    </div>
                )}

                {tab === 'account' && (
                    <div className="space-y-4">
                        <form onSubmit={handleSaveAccount} className="space-y-3">
                            <div className="flex items-center justify-between text-xs px-3 py-2 rounded-lg bg-muted/40">
                                <span className="text-muted-foreground">当前身份</span>
                                <Badge variant="outline" className="text-[11px] gap-1">
                                    {isAdmin ? <><Shield className="h-3 w-3" /> 管理员</> : '普通成员'}
                                </Badge>
                            </div>
                            <div className="space-y-1">
                                <label className="text-xs text-muted-foreground">显示名称</label>
                                <Input
                                    value={displayName}
                                    onChange={(e) => setDisplayName(e.target.value)}
                                    placeholder="输入显示昵称"
                                    className="h-8 text-xs"
                                />
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                                <div className="space-y-1">
                                    <label className="text-xs text-muted-foreground">当前密码（改密必填）</label>
                                    <Input
                                        type="password"
                                        value={currentPassword}
                                        onChange={(e) => setCurrentPassword(e.target.value)}
                                        placeholder="输入当前密码"
                                        autoComplete="current-password"
                                        className="h-8 text-xs"
                                    />
                                </div>
                                <div className="space-y-1">
                                    <label className="text-xs text-muted-foreground">新密码（不改留空）</label>
                                    <Input
                                        type="password"
                                        value={newPassword}
                                        onChange={(e) => setNewPassword(e.target.value)}
                                        placeholder="至少 4 位字符"
                                        autoComplete="new-password"
                                        className="h-8 text-xs"
                                    />
                                </div>
                            </div>

                            {accountMsg && (
                                <p className={`text-xs px-2.5 py-1.5 rounded-md ${accountMsg.kind === 'ok' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-destructive/10 text-destructive'}`}>
                                    {accountMsg.text}
                                </p>
                            )}

                            <div className="flex items-center justify-between pt-1">
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    className="h-8 text-xs text-muted-foreground hover:text-destructive gap-1.5"
                                    onClick={() => {
                                        onOpenChange(false);
                                        logout();
                                    }}
                                >
                                    <LogOut className="h-3.5 w-3.5" /> 退出登录
                                </Button>
                                <Button type="submit" size="sm" className="h-8 text-xs" disabled={savingAccount}>
                                    {savingAccount ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
                                    保存修改
                                </Button>
                            </div>
                        </form>
                    </div>
                )}

                {tab === 'members' && isAdmin && (
                    <div className="space-y-4">
                        <form onSubmit={handleCreateMember} className="p-3 rounded-lg border border-border/60 bg-muted/20 space-y-2.5">
                            <div className="text-xs font-medium flex items-center gap-1.5">
                                <Plus className="h-3.5 w-3.5" /> 新增团队账号（公开注册已关闭）
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                                <Input
                                    value={newUsername}
                                    onChange={(e) => setNewUsername(e.target.value)}
                                    placeholder="用户名 (2-32位英文/数字)"
                                    className="h-8 text-xs"
                                    required
                                />
                                <Input
                                    value={newDisplay}
                                    onChange={(e) => setNewDisplay(e.target.value)}
                                    placeholder="显示名称 (可选)"
                                    className="h-8 text-xs"
                                />
                            </div>
                            <div className="grid grid-cols-3 gap-2">
                                <Input
                                    type="password"
                                    value={newMemberPass}
                                    onChange={(e) => setNewMemberPass(e.target.value)}
                                    placeholder="初始密码 (≥4位)"
                                    className="h-8 text-xs col-span-2"
                                    required
                                />
                                <select
                                    value={newMemberRole}
                                    onChange={(e) => setNewMemberRole(e.target.value as 'member' | 'admin')}
                                    className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                                >
                                    <option value="member">普通成员</option>
                                    <option value="admin">管理员</option>
                                </select>
                            </div>
                            <div className="flex justify-end">
                                <Button type="submit" size="sm" className="h-7 text-xs" disabled={creatingUser}>
                                    {creatingUser ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
                                    创建成员
                                </Button>
                            </div>
                        </form>

                        {membersError && (
                            <p className="text-xs text-destructive bg-destructive/10 px-2.5 py-1.5 rounded-md">
                                {membersError}
                            </p>
                        )}

                        <div className="space-y-2">
                            {loadingUsers && users.length === 0 ? (
                                <div className="flex items-center justify-center py-6 text-xs text-muted-foreground gap-1.5">
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> 加载中...
                                </div>
                            ) : (
                                users.map((u) => {
                                    const isSelf = u.id === user?.id;
                                    const isBusy = busyUserId === u.id;
                                    return (
                                        <div key={u.id} className="p-2.5 rounded-lg border border-border/50 space-y-2">
                                            <div className="flex items-center justify-between gap-2">
                                                <div className="min-w-0">
                                                    <div className="flex items-center gap-1.5 flex-wrap">
                                                        <span className="text-xs font-medium truncate">{u.displayName}</span>
                                                        <span className="text-[11px] text-muted-foreground">@{u.username}</span>
                                                        <Badge variant={u.role === 'admin' ? 'default' : 'secondary'} className="text-[10px] h-4 px-1.5">
                                                            {u.role === 'admin' ? '管理员' : '成员'}
                                                        </Badge>
                                                        {u.disabled && (
                                                            <Badge variant="destructive" className="text-[10px] h-4 px-1.5">已禁用</Badge>
                                                        )}
                                                    </div>
                                                    <div className="text-[11px] text-muted-foreground mt-0.5">
                                                        对话数：{u.conversationCount ?? 0}
                                                    </div>
                                                </div>

                                                <div className="flex items-center gap-1 shrink-0">
                                                    <Button
                                                        type="button"
                                                        size="sm"
                                                        variant="ghost"
                                                        className="h-7 px-2 text-[11px]"
                                                        disabled={isBusy}
                                                        onClick={() => {
                                                            setResetTargetId(resetTargetId === u.id ? null : u.id);
                                                            setResetPasswordVal('');
                                                        }}
                                                    >
                                                        改密
                                                    </Button>
                                                    {!isSelf && (
                                                        <>
                                                            <Button
                                                                type="button"
                                                                size="icon"
                                                                variant="ghost"
                                                                className="h-7 w-7"
                                                                disabled={isBusy}
                                                                title={u.disabled ? '启用账号' : '禁用账号'}
                                                                onClick={() => handleToggleDisabled(u)}
                                                            >
                                                                {u.disabled ? <UserCheck className="h-3.5 w-3.5 text-emerald-600" /> : <UserMinus className="h-3.5 w-3.5 text-muted-foreground" />}
                                                            </Button>
                                                            {confirmDeleteId === u.id ? (
                                                                <Button
                                                                    type="button"
                                                                    size="sm"
                                                                    variant="destructive"
                                                                    className="h-7 px-2 text-[11px]"
                                                                    disabled={isBusy}
                                                                    onClick={() => handleDeleteMember(u.id)}
                                                                >
                                                                    确认删
                                                                </Button>
                                                            ) : (
                                                                <Button
                                                                    type="button"
                                                                    size="icon"
                                                                    variant="ghost"
                                                                    className="h-7 w-7 text-muted-foreground hover:text-destructive"
                                                                    disabled={isBusy}
                                                                    title="删除成员"
                                                                    onClick={() => setConfirmDeleteId(u.id)}
                                                                >
                                                                    <Trash2 className="h-3.5 w-3.5" />
                                                                </Button>
                                                            )}
                                                        </>
                                                    )}
                                                </div>
                                            </div>

                                            {resetTargetId === u.id && (
                                                <div className="flex items-center gap-2 pt-1">
                                                    <Input
                                                        type="password"
                                                        value={resetPasswordVal}
                                                        onChange={(e) => setResetPasswordVal(e.target.value)}
                                                        placeholder="输入新密码（至少 4 位）"
                                                        className="h-7 text-xs"
                                                    />
                                                    <Button
                                                        type="button"
                                                        size="sm"
                                                        className="h-7 text-xs shrink-0"
                                                        disabled={isBusy}
                                                        onClick={() => handleResetMemberPassword(u.id)}
                                                    >
                                                        保存
                                                    </Button>
                                                </div>
                                            )}
                                        </div>
                                    );
                                })
                            )}
                        </div>
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}
