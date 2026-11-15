'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { changeAuthPassword, getAuthInfo } from '@/lib/cascade-api';
import { getAuthKey, setAuthKey } from '@/lib/auth';
import { Lock, Copy, Check, Smartphone, Share2, KeyRound, Eye, EyeOff, Loader2 } from 'lucide-react';

export function SecurityPanel() {
    const [authEnabled, setAuthEnabled] = useState(true);
    const [currentKey, setCurrentKey] = useState('');
    const [newKey, setNewKey] = useState('');
    const [showKeys, setShowKeys] = useState(false);
    const [saving, setSaving] = useState(false);
    const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
    const [copiedLink, setCopiedLink] = useState(false);

    useEffect(() => {
        setCurrentKey(getAuthKey() || '');
        getAuthInfo()
            .then((d) => setAuthEnabled(d.authEnabled))
            .catch(() => { });
    }, []);

    const directUrl = typeof window !== 'undefined' && getAuthKey()
        ? `${window.location.origin}/?key=${encodeURIComponent(getAuthKey())}`
        : (typeof window !== 'undefined' ? window.location.origin : '');

    const handleChangePassword = async (e: React.FormEvent) => {
        e.preventDefault();
        const next = newKey.trim();
        if (next.length < 4) {
            setMsg({ kind: 'err', text: '新密码至少需要 4 个字符' });
            return;
        }
        setSaving(true);
        setMsg(null);
        try {
            await changeAuthPassword({
                currentKey: currentKey.trim() || getAuthKey() || undefined,
                newKey: next,
            });
            setAuthKey(next);
            setCurrentKey(next);
            setNewKey('');
            setMsg({ kind: 'ok', text: '密码已更新并永久生效，当前浏览器已自动保持登录。' });
        } catch (err) {
            setMsg({ kind: 'err', text: err instanceof Error ? err.message : '修改密码失败' });
        } finally {
            setSaving(false);
        }
    };

    const handleCopyDirectLink = async () => {
        if (!directUrl) return;
        try {
            await navigator.clipboard.writeText(directUrl);
            setCopiedLink(true);
            setTimeout(() => setCopiedLink(false), 2000);
        } catch {
            setMsg({ kind: 'err', text: '复制失败，请手动长按复制下方链接' });
        }
    };

    const handleNativeShare = async () => {
        if (!directUrl || typeof navigator.share !== 'function') return;
        try {
            await navigator.share({
                title: 'Antigravity 云端工作台直达入口',
                text: '打开后自动记住登录态（请勿转发给他人）',
                url: directUrl,
            });
        } catch { /* user cancelled share */ }
    };

    return (
        <Card>
            <CardHeader className="pb-3">
                <div className="flex items-center justify-between gap-2">
                    <CardTitle className="text-xs font-semibold flex items-center gap-1.5">
                        <Lock className="h-3.5 w-3.5 text-primary" /> 访问安全与手机免密直达
                    </CardTitle>
                    <Badge variant="outline" className="text-[10px] h-5">
                        {authEnabled ? '访问密码已开启' : '免密本地模式'}
                    </Badge>
                </div>
                <CardDescription className="text-[10px]">
                    自定义易记访问密码（同步生效至重启守护），或一键复制含凭据直达链接到手机 Safari 书签 / 主屏幕。
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                {authEnabled && (
                    <form onSubmit={handleChangePassword} className="space-y-2.5 p-3 rounded-lg border border-border/50 bg-muted/15">
                        <div className="flex items-center justify-between">
                            <span className="text-[11px] font-medium flex items-center gap-1">
                                <KeyRound className="h-3 w-3 text-muted-foreground" /> 修改工作台访问密码
                            </span>
                            <button
                                type="button"
                                onClick={() => setShowKeys((v) => !v)}
                                className="text-[10px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1 cursor-pointer"
                            >
                                {showKeys ? <><EyeOff className="h-3 w-3" /> 隐藏</> : <><Eye className="h-3 w-3" /> 显示</>}
                            </button>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            <Input
                                type={showKeys ? 'text' : 'password'}
                                value={currentKey}
                                onChange={(e) => setCurrentKey(e.target.value)}
                                placeholder="当前密码"
                                className="h-8 text-xs font-mono"
                            />
                            <Input
                                type={showKeys ? 'text' : 'password'}
                                value={newKey}
                                onChange={(e) => setNewKey(e.target.value)}
                                placeholder="输入新密码（4~128位）"
                                className="h-8 text-xs font-mono"
                            />
                        </div>
                        <div className="flex items-center justify-between gap-2">
                            <span className="text-[10px] text-muted-foreground">
                                修改后旧密码与旧直达链接会立即失效。
                            </span>
                            <Button type="submit" size="sm" className="h-7 text-xs shrink-0" disabled={saving || newKey.trim().length < 4}>
                                {saving ? <><Loader2 className="h-3 w-3 animate-spin mr-1" /> 保存中</> : '更新密码'}
                            </Button>
                        </div>
                    </form>
                )}

                {msg && (
                    <div className={`text-xs px-3 py-2 rounded-md border ${
                        msg.kind === 'ok'
                            ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-600 dark:text-emerald-400'
                            : 'bg-destructive/10 border-destructive/25 text-destructive'
                    }`}>
                        {msg.text}
                    </div>
                )}

                <div className="p-3 rounded-lg border border-border/50 bg-muted/15 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-medium flex items-center gap-1">
                            <Smartphone className="h-3.5 w-3.5 text-primary" /> 手机 / 平板免密直达链接
                        </span>
                        <div className="flex items-center gap-1.5">
                            <Button type="button" size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={handleCopyDirectLink} disabled={!directUrl}>
                                {copiedLink ? <><Check className="h-3 w-3 text-emerald-500" /> 已复制</> : <><Copy className="h-3 w-3" /> 复制直达链接</>}
                            </Button>
                            {typeof navigator !== 'undefined' && typeof navigator.share === 'function' && (
                                <Button type="button" size="sm" variant="ghost" className="h-7 text-xs gap-1" onClick={handleNativeShare}>
                                    <Share2 className="h-3 w-3" /> 分享
                                </Button>
                            )}
                        </div>
                    </div>
                    <p className="text-[10px] text-muted-foreground font-mono break-all bg-background/80 px-2.5 py-1.5 rounded border border-border/40 select-all">
                        {showKeys ? directUrl : (directUrl.replace(/\?key=.*$/, '?key=••••••••') || '未登录状态')}
                    </p>
                    <p className="text-[10px] text-muted-foreground leading-relaxed">
                        用手机浏览器打开此链接后，页面会自动将口令写入安全 Cookie 与本地缓存，并立即从地址栏清除密钥，之后刷新或添加到主屏幕无需重复输入密码。
                    </p>
                </div>
            </CardContent>
        </Card>
    );
}
