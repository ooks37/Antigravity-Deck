'use client';

import dynamic from 'next/dynamic';
import { AuthGate } from '@/components/auth-gate';

const WorkspaceShell = dynamic(
  () => import('@/components/workspace-shell').then((m) => ({ default: m.WorkspaceShell })),
  {
    ssr: false,
    loading: () => (
      <div className="h-[100dvh] w-full flex items-center justify-center bg-background">
        <div className="w-5 h-5 border-2 border-primary/40 border-t-primary rounded-full animate-spin" />
      </div>
    ),
  }
);

export default function Home() {
  return (
    <AuthGate>
      <WorkspaceShell />
    </AuthGate>
  );
}
