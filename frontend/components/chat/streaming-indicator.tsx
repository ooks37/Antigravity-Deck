'use client';

import { Loader2 } from 'lucide-react';

export function StreamingIndicator() {
    return (
        <div className="my-2 px-1">
            <div className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-muted/40 border border-border/60 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-foreground/70" />
                <span>正在思考与处理中...</span>
            </div>
        </div>
    );
}
