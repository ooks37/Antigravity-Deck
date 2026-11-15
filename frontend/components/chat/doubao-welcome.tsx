'use client';

import { Activity, ArrowUpRight, HardDrive, ShieldCheck, Terminal, Wrench } from 'lucide-react';

interface PromptCard {
    title: string;
    subtitle: string;
    prompt: string;
    icon: React.ReactNode;
}

const DEFAULT_CARDS: PromptCard[] = [
    {
        title: '系统状态巡检',
        subtitle: '查看 CPU 负载、内存、磁盘占用与运行服务',
        prompt: '请检查当前服务器的 CPU 负载、内存占用、磁盘空间以及 PM2 服务状态，有异常请给出处理建议。',
        icon: <Activity className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />,
    },
    {
        title: '故障与日志排查',
        subtitle: '定位接口报错、Nginx 502 或服务异常重启原因',
        prompt: '帮我检查最近的服务错误日志与 Nginx 访问异常，定位原因并说明修复方案。',
        icon: <Terminal className="h-4 w-4 text-sky-600 dark:text-sky-400" />,
    },
    {
        title: 'Docker 与进程治理',
        subtitle: '查看容器运行状态、端口占用及高内存进程',
        prompt: '列出当前运行的容器与占用内存最高的进程，检查监听端口是否存在异常占用。',
        icon: <HardDrive className="h-4 w-4 text-amber-600 dark:text-amber-400" />,
    },
    {
        title: '代码与配置变更',
        subtitle: '读取配置文件、编写脚本或修改服务端代码',
        prompt: '我想修改项目配置并验证服务状态，请先询问我要处理哪项具体配置。',
        icon: <Wrench className="h-4 w-4 text-foreground/70" />,
    },
];

interface DoubaoWelcomeProps {
    activeAccountLabel?: string | null;
    onPickPrompt: (prompt: string, autoSend?: boolean) => void;
}

export function DoubaoWelcome({
    activeAccountLabel,
    onPickPrompt,
}: DoubaoWelcomeProps) {
    return (
        <div className="min-h-full flex flex-col items-center justify-center px-3 sm:px-6 py-8">
            <div className="w-full max-w-2xl space-y-6 text-center">
                <div className="space-y-2">
                    <h1 className="text-2xl sm:text-[26px] font-semibold tracking-tight text-foreground">
                        有什么我可以帮你的？
                    </h1>
                    <p className="text-xs sm:text-sm text-muted-foreground max-w-md mx-auto leading-relaxed">
                        直接输入命令或问题，支持切换模型、调节思考深度与工具执行。
                    </p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-left">
                    {DEFAULT_CARDS.map((card) => (
                        <button
                            key={card.title}
                            type="button"
                            onClick={() => onPickPrompt(card.prompt, false)}
                            className="group rounded-xl border border-border/70 bg-card hover:bg-muted/35 hover:border-border p-3.5 transition-colors cursor-pointer"
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

                <div className="flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground/70">
                    <ShieldCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                    <span>
                        按模型账号配额真实调度{activeAccountLabel ? ` · 当前模型池：${activeAccountLabel}` : ''}
                    </span>
                </div>
            </div>
        </div>
    );
}
