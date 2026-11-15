'use client';

import { useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { McpView } from './mcp-view';
import { WorkflowsView } from './workflows-view';
import { MemoriesView } from './memories-view';
import { RepoInfoView } from './repo-info-view';
import { ResourceMonitorView } from './resource-monitor-view';
import { AgentLogsView } from './agent-logs-view';
import { SourceControlView } from './source-control-view';
import { Plug, Workflow, Brain, GitBranch, Monitor, Activity, FolderGit2, X } from 'lucide-react';

export type ToolboxTab = 'mcp' | 'workflows' | 'memories' | 'resources' | 'logs' | 'repo' | 'git';

interface ToolboxViewProps {
    initialTab?: ToolboxTab;
    activeWorkspace?: string | null;
    detected: boolean;
    onClose: () => void;
}

export function ToolboxView({ initialTab = 'mcp', activeWorkspace, detected, onClose }: ToolboxViewProps) {
    const [tab, setTab] = useState<ToolboxTab>(initialTab);

    return (
        <div className="flex flex-col flex-1 min-h-0 overflow-hidden bg-background">
            <div className="px-4 sm:px-6 py-3 border-b border-border/70 flex items-center justify-between gap-3 bg-card/60">
                <div>
                    <h2 className="text-sm font-semibold text-foreground">高级工具箱与系统诊断</h2>
                    <p className="text-[11px] text-muted-foreground">集中管理 MCP 工具服务、技能工作流、记忆库、系统资源监控与仓库 Git 变更</p>
                </div>
                <Button variant="ghost" size="sm" onClick={onClose} className="h-8 gap-1 text-xs">
                    <X className="h-3.5 w-3.5" /> 返回对话
                </Button>
            </div>

            <Tabs value={tab} onValueChange={(v) => setTab(v as ToolboxTab)} className="flex flex-col flex-1 min-h-0 overflow-hidden">
                <div className="px-4 sm:px-6 pt-2 border-b border-border/50 bg-muted/20 overflow-x-auto">
                    <TabsList className="h-9 bg-transparent gap-1 p-0">
                        <TabsTrigger value="mcp" className="text-xs gap-1.5 data-[state=active]:bg-background">
                            <Plug className="h-3.5 w-3.5" /> MCP 服务
                        </TabsTrigger>
                        <TabsTrigger value="workflows" className="text-xs gap-1.5 data-[state=active]:bg-background">
                            <Workflow className="h-3.5 w-3.5" /> 工作流/技能
                        </TabsTrigger>
                        <TabsTrigger value="memories" className="text-xs gap-1.5 data-[state=active]:bg-background">
                            <Brain className="h-3.5 w-3.5" /> 记忆库
                        </TabsTrigger>
                        <TabsTrigger value="resources" className="text-xs gap-1.5 data-[state=active]:bg-background">
                            <Monitor className="h-3.5 w-3.5" /> 资源监控
                        </TabsTrigger>
                        <TabsTrigger value="logs" disabled={!detected} className="text-xs gap-1.5 data-[state=active]:bg-background">
                            <Activity className="h-3.5 w-3.5" /> 实时日志
                        </TabsTrigger>
                        <TabsTrigger value="repo" disabled={!detected} className="text-xs gap-1.5 data-[state=active]:bg-background">
                            <FolderGit2 className="h-3.5 w-3.5" /> 仓库信息
                        </TabsTrigger>
                        <TabsTrigger value="git" disabled={!detected || !activeWorkspace} className="text-xs gap-1.5 data-[state=active]:bg-background">
                            <GitBranch className="h-3.5 w-3.5" /> Git 源码
                        </TabsTrigger>
                    </TabsList>
                </div>

                <TabsContent value="mcp" className="flex-1 min-h-0 overflow-hidden m-0">
                    <McpView />
                </TabsContent>
                <TabsContent value="workflows" className="flex-1 min-h-0 overflow-hidden m-0">
                    <WorkflowsView />
                </TabsContent>
                <TabsContent value="memories" className="flex-1 min-h-0 overflow-hidden m-0">
                    <MemoriesView />
                </TabsContent>
                <TabsContent value="resources" className="flex-1 min-h-0 overflow-hidden m-0">
                    <ResourceMonitorView />
                </TabsContent>
                <TabsContent value="logs" className="flex-1 min-h-0 overflow-hidden m-0">
                    <AgentLogsView />
                </TabsContent>
                <TabsContent value="repo" className="flex-1 min-h-0 overflow-hidden m-0">
                    <RepoInfoView />
                </TabsContent>
                <TabsContent value="git" className="flex-1 min-h-0 overflow-hidden m-0">
                    {activeWorkspace && (
                        <SourceControlView workspace={activeWorkspace} onClose={() => setTab('mcp')} />
                    )}
                </TabsContent>
            </Tabs>
        </div>
    );
}
