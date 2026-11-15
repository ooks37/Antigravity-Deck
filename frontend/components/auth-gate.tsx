'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { clearAuthKey, setAuthKey } from '@/lib/auth';
import { authLogin, authLogout, fetchAuthMe, type UserProfile } from '@/lib/cascade-api';
import { Eye, EyeOff, Loader2, Lock } from 'lucide-react';

interface AuthContextValue {
    user: UserProfile | null;
    authEnabled: boolean;
    loading: boolean;
    refreshUser: () => Promise<void>;
    logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
    user: null,
    authEnabled: true,
    loading: true,
    refreshUser: async () => {},
    logout: async () => {},
});

export function useAuthUser() {
    return useContext(AuthContext);
}

interface AuthGateProps {
    children: ReactNode;
}

export function AuthGate({ children }: AuthGateProps) {
    const [status, setStatus] = useState<'loading' | 'unauthenticated' | 'authenticated'>('loading');
    const [authEnabled, setAuthEnabled] = useState(true);
    const [user, setUser] = useState<UserProfile | null>(null);
    const [username, setUsername] = useState('admin');
    const [password, setPassword] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [error, setError] = useState('');
    const [submitting, setSubmitting] = useState(false);

    const checkSession = useCallback(async () => {
        try {
            const me = await fetchAuthMe();
            setAuthEnabled(me.authEnabled);
            if (!me.authEnabled || (me.authenticated && me.user)) {
                setUser(me.user);
                setStatus('authenticated');
                return;
            }
            setUser(null);
            setStatus('unauthenticated');
        } catch {
            // Backend restarting or unreachable briefly: prompt sign-in cleanly without bypassing.
            setUser(null);
            setStatus('unauthenticated');
        }
    }, []);

    useEffect(() => {
        checkSession();
    }, [checkSession]);

    const logout = useCallback(async () => {
        try { await authLogout(); } catch { /* ignore */ }
        clearAuthKey();
        setUser(null);
        setPassword('');
        setStatus('unauthenticated');
    }, []);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        const u = username.trim();
        const p = password.trim();
        if (!u || !p) {
            setError('请输入用户名和密码');
            return;
        }
        setError('');
        setSubmitting(true);
        try {
            const res = await authLogin(u, p);
            if (res.token) setAuthKey(res.token);
            setUser(res.user);
            setPassword('');
            setStatus('authenticated');
        } catch (err) {
            setError(err instanceof Error ? err.message : '登录失败，请检查账号和密码');
        } finally {
            setSubmitting(false);
        }
    };

    if (status === 'loading') {
        return (
            <div className="min-h-dvh flex items-center justify-center bg-background">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>正在加载工作台...</span>
                </div>
            </div>
        );
    }

    if (status === 'unauthenticated') {
        return (
            <div className="min-h-dvh flex items-center justify-center bg-background px-4">
                <Card className="w-full max-w-[360px] border-border/60 shadow-sm">
                    <CardHeader className="pb-4 space-y-1.5 text-center">
                        <div className="mx-auto w-9 h-9 rounded-xl bg-muted flex items-center justify-center mb-1">
                            <Lock className="h-4 w-4 text-foreground/80" />
                        </div>
                        <CardTitle className="text-base font-semibold tracking-tight">登录 Antigravity 工作台</CardTitle>
                        <CardDescription className="text-xs">
                            仅限授权账号访问，会话与记录按用户隔离
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <form onSubmit={handleSubmit} className="space-y-3">
                            <div className="space-y-1.5">
                                <label className="text-[11px] font-medium text-muted-foreground" htmlFor="login-username">
                                    用户名
                                </label>
                                <Input
                                    id="login-username"
                                    type="text"
                                    value={username}
                                    onChange={(e) => setUsername(e.target.value)}
                                    placeholder="输入用户名"
                                    autoComplete="username"
                                    autoFocus
                                    className="h-9 text-sm"
                                />
                            </div>
                            <div className="space-y-1.5">
                                <label className="text-[11px] font-medium text-muted-foreground" htmlFor="login-password">
                                    密码
                                </label>
                                <div className="relative">
                                    <Input
                                        id="login-password"
                                        type={showPassword ? 'text' : 'password'}
                                        value={password}
                                        onChange={(e) => setPassword(e.target.value)}
                                        placeholder="输入密码"
                                        autoComplete="current-password"
                                        className="h-9 text-sm pr-9"
                                    />
                                    <button
                                        type="button"
                                        onClick={() => setShowPassword((v) => !v)}
                                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground cursor-pointer"
                                        aria-label={showPassword ? '隐藏密码' : '显示密码'}
                                    >
                                        {showPassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                                    </button>
                                </div>
                            </div>

                            {error && (
                                <p className="text-xs text-destructive bg-destructive/10 rounded-md px-2.5 py-1.5">
                                    {error}
                                </p>
                            )}

                            <Button type="submit" className="w-full h-9 text-sm" disabled={submitting}>
                                {submitting ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : null}
                                {submitting ? '正在验证...' : '登录'}
                            </Button>
                        </form>
                    </CardContent>
                </Card>
            </div>
        );
    }

    return (
        <AuthContext.Provider value={{ user, authEnabled, loading: false, refreshUser: checkSession, logout }}>
            {children}
        </AuthContext.Provider>
    );
}
