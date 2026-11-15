'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { useAuthUser } from '@/components/auth-gate';
import { changeOwnCredentials } from '@/lib/cascade-api';
import { Eye, EyeOff, KeyRound, Loader2, Lock } from 'lucide-react';

export function SecurityPanel() {
    const { user, authEnabled, refreshUser } = useAuthUser();
    const [currentPassword, setCurrentPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [showKeys, setShowKeys] = useState(false);
    const [saving, setSaving] = useState(false);
    const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

    const handleChangePassword = async (e: React.FormEvent) => {
        e.preventDefault();
        const next = newPassword.trim();
        if (next.length < 4) {
            setMsg({ kind: 'err', text: '新密码至少需要 4 个字符' });
            return;
        }
        setSaving(true);
        setMsg(null);
        try {
            await changeOwnCredentials({
                currentPassword: currentPassword.trim() || undefined,
                newPassword: next,
            });
            setCurrentPassword('');
            setNewPassword('');
            await refreshUser();
            setMsg({ kind: 'ok', text: '当前账号密码已更新并永久生效。' });
        } catch (err) {
            setMsg({ kind: 'err', text: err instanceof Error ? err.message : '修改密码失败' });
        } finally {
            setSaving(false);
        }
    };

    return (
        <Card>
            <CardHeader className="pb-3">
                <div className="flex items-center justify-between gap-2">
                    <CardTitle className="text-xs font-semibold flex items-center gap-1.5">
                        <Lock className="h-3.5 w-3.5 text-foreground/80" /> 多用户账号安全
                    </CardTitle>
                    <Badge variant="outline" className="text-[10px] h-5">
                        {authEnabled ? '多用户会话认证已开启' : '免密本地模式'}
                    </Badge>
                </div>
                <CardDescription className="text-[11px]">
                    当前登录：{user ? `${user.displayName} (@${user.username})` : '未登录'} · 如需创建或禁用其他成员，请打开左下角用户菜单的「成员管理」。
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
                {authEnabled && (
                    <form onSubmit={handleChangePassword} className="space-y-2.5 p-3 rounded-lg border border-border/50 bg-muted/15">
                        <div className="flex items-center justify-between">
                            <span className="text-xs font-medium flex items-center gap-1">
                                <KeyRound className="h-3.5 w-3.5 text-muted-foreground" /> 修改当前账号密码
                            </span>
                            <button
                                type="button"
                                onClick={() => setShowKeys((v) => !v)}
                                className="text-[11px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1 cursor-pointer"
                            >
                                {showKeys ? <><EyeOff className="h-3 w-3" /> 隐藏</> : <><Eye className="h-3 w-3" /> 显示</>}
                            </button>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            <Input
                                type={showKeys ? 'text' : 'password'}
                                value={currentPassword}
                                onChange={(e) => setCurrentPassword(e.target.value)}
                                placeholder="当前密码"
                                className="h-8 text-xs"
                            />
                            <Input
                                type={showKeys ? 'text' : 'password'}
                                value={newPassword}
                                onChange={(e) => setNewPassword(e.target.value)}
                                placeholder="新密码（至少 4 位）"
                                className="h-8 text-xs"
                            />
                        </div>
                        {msg && (
                            <p className={`text-xs ${msg.kind === 'ok' ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'}`}>
                                {msg.text}
                            </p>
                        )}
                        <div className="flex justify-end">
                            <Button type="submit" size="sm" className="h-7 text-xs" disabled={saving || !newPassword.trim()}>
                                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
                                保存新密码
                            </Button>
                        </div>
                    </form>
                )}
            </CardContent>
        </Card>
    );
}
