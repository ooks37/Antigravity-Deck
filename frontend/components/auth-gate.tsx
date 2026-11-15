'use client';

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useRef,
    useState,
    type KeyboardEvent,
    type ReactNode,
} from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
    clearAuthKey,
    getAuthKey,
    getRememberedUsername,
    setAuthKey,
    setRememberedUsername,
} from '@/lib/auth';
import { authLogin, authLogout, fetchAuthMe, type UserProfile } from '@/lib/cascade-api';
import { useTheme } from '@/lib/theme';
import {
    AlertCircle,
    ArrowRight,
    Cpu,
    Eye,
    EyeOff,
    HelpCircle,
    Loader2,
    Lock,
    Moon,
    ShieldCheck,
    Sun,
    Terminal,
    User,
    X,
} from 'lucide-react';

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

const WORKBENCH_HIGHLIGHTS = [
    {
        icon: Terminal,
        title: '实时思考与工具执行流',
        desc: '流式呈现推理步骤、终端指令执行与文件读写进度，关键过程全程可控。',
    },
    {
        icon: Cpu,
        title: '多模型与推理深度调度',
        desc: '按任务复杂度即时切换模型系列与思考深度档位，兼顾响应速度与准确率。',
    },
    {
        icon: ShieldCheck,
        title: '成员会话隔离与权限分级',
        desc: '每位成员拥有独立对话空间；核心配置、代理及账号凭据仅管理员可见。',
    },
];

function BrandMark() {
    return (
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-foreground text-background shadow-xs shrink-0">
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 3 4.5 19.5h3.2l1.7-3.8h5.2l1.7 3.8h3.2L12 3Z" />
                <path d="M9.8 12.6 12 7.5l2.2 5.1" />
            </svg>
        </span>
    );
}

interface AuthGateProps {
    children: ReactNode;
}

export function AuthGate({ children }: AuthGateProps) {
    const { isDark, toggle: toggleTheme } = useTheme();
    const [status, setStatus] = useState<'loading' | 'unauthenticated' | 'authenticated'>('loading');
    const [authEnabled, setAuthEnabled] = useState(true);
    const [user, setUser] = useState<UserProfile | null>(null);

    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [remember, setRemember] = useState(true);
    const [showPassword, setShowPassword] = useState(false);
    const [capsLockOn, setCapsLockOn] = useState(false);
    const [showHelp, setShowHelp] = useState(false);
    const [sessionNotice, setSessionNotice] = useState('');
    const [error, setError] = useState('');
    const [invalidField, setInvalidField] = useState<'username' | 'password' | 'both' | null>(null);
    const [submitting, setSubmitting] = useState(false);

    const usernameRef = useRef<HTMLInputElement>(null);
    const passwordRef = useRef<HTMLInputElement>(null);

    const checkSession = useCallback(async () => {
        const hadToken = Boolean(getAuthKey());
        try {
            const me = await fetchAuthMe();
            setAuthEnabled(me.authEnabled);
            if (!me.authEnabled || (me.authenticated && me.user)) {
                setUser(me.user);
                setSessionNotice('');
                setStatus('authenticated');
                return;
            }
            if (hadToken) {
                clearAuthKey();
                setSessionNotice('当前登录凭证已失效或已在其他端退出，请重新登录。');
            }
            setUser(null);
            setStatus('unauthenticated');
        } catch {
            setUser(null);
            setStatus('unauthenticated');
        }
    }, []);

    useEffect(() => {
        const savedUser = getRememberedUsername();
        if (savedUser) setUsername(savedUser);
        checkSession();
    }, [checkSession]);

    useEffect(() => {
        if (status !== 'unauthenticated') return;
        const timer = window.setTimeout(() => {
            if (getRememberedUsername() || username.trim()) {
                passwordRef.current?.focus();
            } else {
                usernameRef.current?.focus();
            }
        }, 40);
        return () => window.clearTimeout(timer);
        // Intentionally run once when entering the unauthenticated view.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [status]);

    const logout = useCallback(async () => {
        try { await authLogout(); } catch { /* ignore */ }
        clearAuthKey();
        setUser(null);
        setPassword('');
        setError('');
        setSessionNotice('');
        setInvalidField(null);
        setStatus('unauthenticated');
    }, []);

    const handleKeyState = (e: KeyboardEvent<HTMLInputElement>) => {
        if (typeof e.getModifierState === 'function') {
            setCapsLockOn(e.getModifierState('CapsLock'));
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        const cleanUser = username.trim();
        const cleanPass = password;

        if (!cleanUser && !cleanPass.trim()) {
            setInvalidField('both');
            setError('请输入用户名和密码');
            usernameRef.current?.focus();
            return;
        }
        if (!cleanUser) {
            setInvalidField('username');
            setError('请输入用户名');
            usernameRef.current?.focus();
            return;
        }
        if (!cleanPass.trim()) {
            setInvalidField('password');
            setError('请输入密码');
            passwordRef.current?.focus();
            return;
        }

        setError('');
        setSessionNotice('');
        setInvalidField(null);
        setSubmitting(true);

        try {
            const res = await authLogin(cleanUser, cleanPass, remember);
            if (res.token) setAuthKey(res.token, remember);
            setRememberedUsername(cleanUser, remember);
            setUser(res.user);
            setPassword('');
            setStatus('authenticated');
        } catch (err) {
            const message = err instanceof Error ? err.message : '登录失败，请检查账号和密码';
            setError(message);
            setInvalidField('both');
            passwordRef.current?.select();
        } finally {
            setSubmitting(false);
        }
    };

    if (status === 'loading') {
        return (
            <div className="min-h-dvh w-full flex-1 flex flex-col items-center justify-center bg-background px-4">
                <div className="flex flex-col items-center gap-3 text-center">
                    <BrandMark />
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        <span>正在校验会话状态...</span>
                    </div>
                </div>
            </div>
        );
    }

    if (status === 'unauthenticated') {
        return (
            <div className="min-h-dvh w-full flex-1 bg-background text-foreground grid lg:grid-cols-[1.08fr_1fr]">
                {/* Desktop Left Showcase Panel (Linear / Feishu Console inspired) */}
                <aside className="hidden lg:flex flex-col justify-between relative overflow-hidden border-r border-border/70 bg-muted/35 dark:bg-card/40 px-12 py-10 xl:px-16">
                    <div
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-0 opacity-[0.45] dark:opacity-[0.22]"
                        style={{
                            backgroundImage: 'radial-gradient(color-mix(in oklab, var(--border) 90%, transparent) 1px, transparent 1px)',
                            backgroundSize: '22px 22px',
                        }}
                    />

                    <div className="relative flex items-center gap-3">
                        <BrandMark />
                        <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold tracking-tight">Antigravity</span>
                            <span className="rounded-md border border-border/80 bg-background/80 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                                云端工作台
                            </span>
                        </div>
                    </div>

                    <div className="relative max-w-md space-y-8 my-auto py-8">
                        <div className="space-y-3">
                            <h1 className="text-[28px] xl:text-[32px] font-semibold tracking-tight leading-[1.25] text-foreground">
                                面向团队的云端 AI 协同控制台
                            </h1>
                            <p className="text-sm text-muted-foreground leading-relaxed">
                                直连服务端运行环境与实时工具链，统一调度多模型能力，会话记录与系统权限按账号严格隔离。
                            </p>
                        </div>

                        <div className="space-y-5 pt-2">
                            {WORKBENCH_HIGHLIGHTS.map((item) => {
                                const Icon = item.icon;
                                return (
                                    <div key={item.title} className="flex items-start gap-3.5">
                                        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border/80 bg-background/90 text-foreground/80 shadow-2xs">
                                            <Icon className="h-4 w-4" />
                                        </div>
                                        <div className="space-y-1">
                                            <h2 className="text-[13px] font-medium text-foreground">{item.title}</h2>
                                            <p className="text-xs text-muted-foreground leading-relaxed">{item.desc}</p>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    <div className="relative flex items-center justify-between text-[11px] text-muted-foreground border-t border-border/60 pt-5">
                        <span>受控访问工作区</span>
                        <span>HttpOnly Cookie · 独立会话隔离</span>
                    </div>
                </aside>

                {/* Right Focused Sign-In Column */}
                <main className="flex flex-col justify-between px-5 py-6 sm:px-10 sm:py-8">
                    <header className="flex items-center justify-between lg:justify-end">
                        <div className="flex items-center gap-2.5 lg:hidden">
                            <BrandMark />
                            <div className="flex items-center gap-1.5">
                                <span className="text-sm font-semibold tracking-tight">Antigravity</span>
                                <span className="text-xs text-muted-foreground">工作台</span>
                            </div>
                        </div>

                        <button
                            type="button"
                            onClick={toggleTheme}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border/70 bg-background hover:bg-muted/70 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                            aria-label={isDark ? '切换至浅色模式' : '切换至深色模式'}
                            title={isDark ? '切换至浅色模式' : '切换至深色模式'}
                        >
                            {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
                        </button>
                    </header>

                    <div className="w-full max-w-[380px] mx-auto my-auto py-8">
                        <div className="space-y-1.5 mb-6">
                            <h2 className="text-xl font-semibold tracking-tight text-foreground">
                                登录工作台
                            </h2>
                            <p className="text-[13px] text-muted-foreground">
                                请使用管理员分配的账号与密码继续
                            </p>
                        </div>

                        {sessionNotice && !error && (
                            <div
                                role="status"
                                className="mb-4 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-800 dark:text-amber-300"
                            >
                                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                                <span>{sessionNotice}</span>
                            </div>
                        )}

                        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
                            <div className="space-y-1.5">
                                <label
                                    htmlFor="login-username"
                                    className="block text-xs font-medium text-foreground/85"
                                >
                                    用户名
                                </label>
                                <div className="relative">
                                    <User className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/75" />
                                    <Input
                                        ref={usernameRef}
                                        id="login-username"
                                        type="text"
                                        value={username}
                                        onChange={(e) => {
                                            setUsername(e.target.value);
                                            if (error) { setError(''); setInvalidField(null); }
                                        }}
                                        placeholder="输入用户名"
                                        autoComplete="username"
                                        aria-invalid={invalidField === 'username' || invalidField === 'both'}
                                        className="h-10 pl-9 pr-8 text-sm rounded-lg"
                                        disabled={submitting}
                                    />
                                    {username && !submitting && (
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setUsername('');
                                                usernameRef.current?.focus();
                                            }}
                                            className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground/70 hover:text-foreground hover:bg-muted cursor-pointer"
                                            aria-label="清空用户名"
                                        >
                                            <X className="h-3.5 w-3.5" />
                                        </button>
                                    )}
                                </div>
                            </div>

                            <div className="space-y-1.5">
                                <div className="flex items-center justify-between">
                                    <label
                                        htmlFor="login-password"
                                        className="block text-xs font-medium text-foreground/85"
                                    >
                                        密码
                                    </label>
                                    {capsLockOn && (
                                        <span className="text-[11px] font-medium text-amber-600 dark:text-amber-400">
                                            大写锁定已开启
                                        </span>
                                    )}
                                </div>
                                <div className="relative">
                                    <Lock className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/75" />
                                    <Input
                                        ref={passwordRef}
                                        id="login-password"
                                        type={showPassword ? 'text' : 'password'}
                                        value={password}
                                        onChange={(e) => {
                                            setPassword(e.target.value);
                                            if (error) { setError(''); setInvalidField(null); }
                                        }}
                                        onKeyDown={handleKeyState}
                                        onKeyUp={handleKeyState}
                                        onBlur={() => setCapsLockOn(false)}
                                        placeholder="输入登录密码"
                                        autoComplete="current-password"
                                        aria-invalid={invalidField === 'password' || invalidField === 'both'}
                                        className="h-10 pl-9 pr-9 text-sm rounded-lg"
                                        disabled={submitting}
                                    />
                                    <button
                                        type="button"
                                        onClick={() => setShowPassword((v) => !v)}
                                        className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground/70 hover:text-foreground hover:bg-muted cursor-pointer"
                                        aria-label={showPassword ? '隐藏密码' : '显示密码'}
                                    >
                                        {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                                    </button>
                                </div>
                            </div>

                            <div className="flex items-center justify-between pt-0.5">
                                <label
                                    htmlFor="login-remember"
                                    className="inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground select-none cursor-pointer"
                                >
                                    <Checkbox
                                        id="login-remember"
                                        checked={remember}
                                        onCheckedChange={(v) => setRemember(v === true)}
                                        disabled={submitting}
                                    />
                                    <span>保持登录状态（30 天）</span>
                                </label>

                                <button
                                    type="button"
                                    onClick={() => setShowHelp((v) => !v)}
                                    className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                                    aria-expanded={showHelp}
                                >
                                    <HelpCircle className="h-3.5 w-3.5" />
                                    <span>忘记密码？</span>
                                </button>
                            </div>

                            {showHelp && (
                                <div className="rounded-lg border border-border/70 bg-muted/50 px-3 py-2.5 text-[11px] text-muted-foreground leading-relaxed space-y-1">
                                    <p className="font-medium text-foreground/90">账号与密码重置说明</p>
                                    <p>普通成员忘记密码或需要开通新账号，请联系系统管理员在「成员管理」中协助重置或新增。</p>
                                    <p>首次部署的管理员可在服务器部署目录查看 <code className="rounded bg-background px-1 py-0.5 font-mono text-[10px]">.auth-key</code> 获取初始密钥。</p>
                                </div>
                            )}

                            {error && (
                                <div
                                    role="alert"
                                    className="flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/10 px-3 py-2.5 text-xs text-destructive"
                                >
                                    <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                                    <span>{error}</span>
                                </div>
                            )}

                            <Button
                                type="submit"
                                className="w-full h-10 text-sm font-medium rounded-lg mt-1 cursor-pointer"
                                disabled={submitting}
                            >
                                {submitting ? (
                                    <>
                                        <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
                                        <span>正在验证身份...</span>
                                    </>
                                ) : (
                                    <>
                                        <span>登录工作台</span>
                                        <ArrowRight className="h-4 w-4 ml-1.5" />
                                    </>
                                )}
                            </Button>
                        </form>

                        <p className="mt-5 text-center text-[11px] text-muted-foreground/80">
                            授权成员专用入口 · 按 Enter 键可快速提交
                        </p>
                    </div>

                    <footer className="flex items-center justify-center lg:justify-end text-[11px] text-muted-foreground/75">
                        <span>Antigravity 云端工作台 · 多用户隔离版</span>
                    </footer>
                </main>
            </div>
        );
    }

    return (
        <AuthContext.Provider value={{ user, authEnabled, loading: false, refreshUser: checkSession, logout }}>
            {children}
        </AuthContext.Provider>
    );
}
