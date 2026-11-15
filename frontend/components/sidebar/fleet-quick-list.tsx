'use client';

import { useState, useEffect, useCallback } from 'react';
import { getFleetServers, pingFleetServers, type FleetServer } from '@/lib/cascade-api';
import { cn } from '@/lib/utils';
import { Server, RefreshCw, ChevronRight } from 'lucide-react';

interface FleetQuickListProps {
    onSelectServer: (server: FleetServer) => void;
}

export function FleetQuickList({ onSelectServer }: FleetQuickListProps) {
    const [servers, setServers] = useState<FleetServer[]>([]);
    const [loading, setLoading] = useState(true);
    const [pinging, setPinging] = useState(false);

    const loadList = useCallback(async () => {
        try {
            const data = await getFleetServers();
            setServers(data.servers || []);
        } catch {
            /* ignore if fleet file not present */
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        loadList();
    }, [loadList]);

    const handlePing = async (e: React.MouseEvent) => {
        e.stopPropagation();
        if (pinging) return;
        setPinging(true);
        try {
            const data = await pingFleetServers(3500);
            setServers(data.servers || []);
        } catch {
            /* keep previous */
        } finally {
            setPinging(false);
        }
    };

    if (!loading && servers.length === 0) return null;

    return (
        <div className="px-2 py-1 space-y-1">
            <div className="flex items-center justify-between px-1.5 py-0.5">
                <span className="text-[11px] font-medium text-sidebar-foreground/70 flex items-center gap-1.5">
                    <Server className="h-3 w-3 text-primary" />
                    服务器机群 ({servers.length})
                </span>
                <button
                    type="button"
                    onClick={handlePing}
                    disabled={pinging}
                    title="检测全部宝塔节点连通性与延迟"
                    className="text-[10px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1 cursor-pointer"
                >
                    <RefreshCw className={cn('h-2.5 w-2.5', pinging && 'animate-spin')} />
                    {pinging ? '测速中' : '测速'}
                </button>
            </div>

            <div className="space-y-0.5 max-h-48 overflow-y-auto pr-0.5">
                {servers.map((srv) => {
                    const checked = typeof srv.online === 'boolean';
                    return (
                        <button
                            key={srv.id}
                            type="button"
                            onClick={() => onSelectServer(srv)}
                            className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg text-left hover:bg-sidebar-accent transition-colors cursor-pointer group"
                            title={`${srv.name} (${srv.ip}) ${srv.region || ''} · 点击在新对话中运维此节点`}
                        >
                            <div className="flex items-center gap-2 min-w-0 flex-1">
                                <span
                                    className={cn(
                                        'h-2 w-2 rounded-full shrink-0',
                                        !checked
                                            ? 'bg-muted-foreground/40'
                                            : srv.online
                                                ? 'bg-emerald-500'
                                                : 'bg-rose-500'
                                    )}
                                />
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-1.5 text-xs font-medium truncate">
                                        <span className="font-mono text-[10px] px-1 rounded bg-muted text-foreground/80 shrink-0">{srv.id}</span>
                                        <span className="truncate">{srv.region || srv.name}</span>
                                        {srv.combo && (
                                            <span className="text-[10px] text-muted-foreground shrink-0">{srv.combo}</span>
                                        )}
                                    </div>
                                    <div className="text-[10px] text-muted-foreground/70 font-mono truncate">
                                        {srv.ip}
                                    </div>
                                </div>
                            </div>

                            <div className="flex items-center gap-1 shrink-0">
                                {typeof srv.latencyMs === 'number' && (
                                    <span className={cn(
                                        'text-[10px] font-mono',
                                        srv.online ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500'
                                    )}>
                                        {srv.online ? `${srv.latencyMs}ms` : '离线'}
                                    </span>
                                )}
                                <ChevronRight className="h-3 w-3 text-muted-foreground/40 group-hover:text-foreground transition-colors" />
                            </div>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
