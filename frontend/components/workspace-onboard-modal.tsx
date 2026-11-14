'use client';

import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { updateSettings } from '@/lib/cascade-api';
import { FolderOpen, ArrowRight, Loader2 } from 'lucide-react';

interface WorkspaceOnboardModalProps {
    open: boolean;
    suggestedRoot: string;
    onCompleted: (root: string) => void;
}

export function WorkspaceOnboardModal({ open, suggestedRoot, onCompleted }: WorkspaceOnboardModalProps) {
    const [path, setPath] = useState(suggestedRoot);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');

    // Update local state if suggestion arrives later
    useEffect(() => {
        if (suggestedRoot) setPath(suggestedRoot);
    }, [suggestedRoot]);

    const handleSave = async () => {
        if (!path.trim()) {
            setError('工作区根目录路径不能为空。');
            return;
        }

        setError('');
        setSaving(true);
        try {
            const updated = await updateSettings({ defaultWorkspaceRoot: path.trim() });
            onCompleted(updated.defaultWorkspaceRoot);
        } catch (e: any) {
            setError(e.message || '保存工作区根目录失败。');
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={(val) => {
            // Cannot close the modal without finishing onboarding
            if (!val) {
                // Ignore close attempts
            }
        }}>
            <DialogContent className="sm:max-w-md [&>button]:hidden">
                <DialogHeader>
                    <div className="mx-auto w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mb-4 text-primary">
                        <FolderOpen className="w-6 h-6" />
                    </div>
                    <DialogTitle className="text-center text-xl">欢迎使用 Antigravity Deck</DialogTitle>
                    <DialogDescription className="text-center">
                        开始使用前，请先配置默认工作区根目录。后续新建的工作区都会保存在此目录下。
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4 py-4">
                    <div className="space-y-2">
                        <label className="text-sm font-medium">工作区根目录路径</label>
                        <Input 
                            value={path} 
                            onChange={e => {
                                setPath(e.target.value);
                                if (error) setError('');
                            }}
                            placeholder="例如 /root/workspace 或 C:\Users\you\Workspace"
                            className="font-mono text-xs"
                            autoFocus
                        />
                        {error ? (
                            <p className="text-xs text-destructive">{error}</p>
                        ) : (
                            <p className="text-xs text-muted-foreground">
                                系统会自动扫描此目录下的工作区文件夹，方便你随时在 IDE 中打开。
                            </p>
                        )}
                    </div>
                </div>

                <DialogFooter className="sm:justify-stretch">
                    <Button onClick={handleSave} disabled={saving || !path.trim()} className="w-full gap-2">
                        {saving ? (
                            <>
                                <Loader2 className="w-4 h-4 animate-spin" />
                                正在保存设置...
                            </>
                        ) : (
                            <>
                                保存并继续
                                <ArrowRight className="w-4 h-4" />
                            </>
                        )}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
