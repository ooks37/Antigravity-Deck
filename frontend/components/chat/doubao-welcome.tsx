'use client';

import { Sparkles, Server, Activity, HardDrive, Terminal, ShieldCheck, ArrowUpRight } from 'lucide-react';
import type { FleetServer } from '@/lib/cascade-api';

interface QuickPromptCard {
    title: string;
    subtitle: string;
    prompt: string;
    icon: React.ReactNode;
    accent: string;
}

const DEFAULT_CARDS: QuickPromptCard[] = [
    {
        title: '全网服务器一键巡检',
        subtitle: '并发探测 10+ 宝塔节点延迟、CPU、内存与在线服务',
        prompt: '请使用 baota-hub 的 bt_ping_all 与 bt_system_info 巡检所有在线服务器状态，按延迟、负载与磁盘使用率汇总一份简洁表格，重点标出异常节点。',
        icon: <Activity className="h-4 w-4 text-emerald-500" />,
        accent: 'hover:border-emerald-500/40 hover:bg-emerald-500/5',
    },
    {
        title: '检查 82 弘速云状态',
        subtitle: '2核2G 美西节点 · 进程、磁盘与站点排查',
        prompt: '请通过 baota-hub 连接到 82 弘速云（82.158.88.15，2h2g）检查 uptime、free -m、df -h、nginx 与 pm2 状态，汇报当前健康情况。',
        icon: <Server className="h-4 w-4 text-sky-500" />,
        accent: 'hover:border-sky-500/40 hover:bg-sky-500/5',
    },
    {
        title: '本机 199 服务与日志诊断',
        subtitle: 'Antigravity Hub / PM2 / Nginx 运行与错误日志排查',
        prompt: '请检查当前 199 服务器上的 pm2 list、端口占用、磁盘空间以及最近异常日志，确认所有后台服务健康运行。',
        icon: <Terminal className="h-4 w-4 text-indigo-500" />,
        accent: 'hover:border-indigo-500/40 hover:bg-indigo-500/5',
    },
    {
        title: '磁盘大文件与安全巡检',
        subtitle: '定位占满空间目录、过期日志与可疑进程',
        prompt: '请检查所有高占用磁盘分区（df -h、du 排查大目录），给出可安全清理的缓存/日志建议，清理前先列清单向我确认。',
        icon: <HardDrive className="h-4 w-4 text-amber-500" />,
        accent: 'hover:border-amber-500/40 hover:bg-amber-500/5',
    },
];

interface DoubaoWelcomeProps {
    targetServer?: FleetServer | null;
    onClearTargetServer?: () => void;
    onPickPrompt: (prompt: string, autoSend?: boolean) => void;
    activeAccountLabel?: string | null;
}

export function DoubaoWelcome({
    targetServer,
    onClearTargetServer,
    onPickPrompt,
    activeAccountLabel,
}: DoubaoWelcomeProps) {
    return (
        <div className="flex flex-col items-center justify-center min-h-[55vh] px-4 py-8">
            <div className="max-w-2xl w-full space-y-6 text-center">
                <div className="space-y-2.5">
                    <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 text-primary text-xs font-medium">
                        <Sparkles className="h-3.5 w-3.5" />
                        <span>Antigravity 云端智能运维工作台</span>
                        {activeAccountLabel && (
                            <span className="text-[11px] opacity-80 border-l border-primary/25 pl-2">
                                {activeAccountLabel}
                            </span>
                        )}
                    </div>
                    <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-foreground">
                        你好，需要我远程处理什么任务？
                    </h1>
                    <p className="text-xs sm:text-sm text-muted-foreground max-w-lg mx-auto leading-relaxed">
                        直接用自然语言下达命令——已打通本机终端与 <span className="font-medium text-foreground/80">Baota MCP 多机集群</span>，支持自由切换模型与多账号额度。
                    </p>
                </div>

                {targetServer && (
                    <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-sky-500/10 border border-sky-500/25 text-xs text-sky-700 dark:text-sky-300">
                        <Server className="h-3.5 w-3.5" />
                        <span>
                            当前目标主机: <strong>{targetServer.name}</strong> ({targetServer.ip}{targetServer.combo ? ` · ${targetServer.combo}` : ''})
                        </span>
                        {onClearTargetServer && (
                            <button
                                type="button"
                                onClick={onClearTargetServer}
                                className="ml-1 text-[11px] opacity-70 hover:opacity-100 underline cursor-pointer"
                            >
                                取消指定
                            </button>
                        )}
                    </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-left">
                    {DEFAULT_CARDS.map((card) => (
                        <button
                            key={card.title}
                            type="button"
                            onClick={() => onPickPrompt(card.prompt, false)}
                            className={`group rounded-2xl border border-border/70 bg-card p-3.5 transition-all cursor-pointer shadow-[0_1px_2px_rgba(0,0,0,0.02)] ${card.accent}`}
                        >
                            <div className="flex items-start justify-between gap-2">
                                <div className="flex items-center gap-2 font-medium text-xs sm:text-[13px] text-foreground">
                                    {card.icon}
                                    <span>{card.title}</span>
                                </div>
                                <ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground/40 group-hover:text-foreground transition-colors shrink-0" />
                            </div>
                            <p className="mt-1.5 text-[11px] text-muted-foreground leading-relaxed">
                                {card.subtitle}
                            </p>
                        </button>
                    ))}
                </div>

                <div className="flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground/75">
                    <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
                    <span>默认开启智能防误触守卫：常规检查自动放行，高危删库/停服/删文件命令将弹窗由你审批</span>
                </div>
            </div>
        </div>
    );
}
