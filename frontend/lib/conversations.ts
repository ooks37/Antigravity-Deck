// === Conversation index (hub Jetbox model) ===
// Shared loader + helpers for the project/conversation view used by both the
// sidebar (AppSidebar) and the full Conversation History view. Sources:
//   GET /api/projects       → { projects: Project[] }
//   GET /api/conversations  → { trajectorySummaries: { [id]: summary } }

import { API_BASE } from '@/lib/config';
import { authFetch } from '@/lib/auth';

/** Marker id for conversations not attached to any project. */
export const OUTSIDE_PROJECT = 'outside-of-project';

export interface Project {
    id: string;
    name: string;
    folderUri: string;
    conversationCount: number;
}

export interface ConvRow {
    id: string;
    title: string;
    projectId: string;
    projectName: string;
    lastModified: string;
    stepCount: number;
}

/** Loosely-typed shape of one trajectory summary as returned by /api/conversations. */
interface RawWorkspaceRef {
    repository?: { computedName?: string };
    workspaceFolderAbsoluteUri?: string;
}
interface RawSummary {
    summary?: string;
    stepCount?: number;
    lastModifiedTime?: string;
    createdTime?: string;
    trajectoryMetadata?: { projectId?: string };
    workspaces?: RawWorkspaceRef[];
}

/** Compact relative time, e.g. "刚刚", "5分钟前", "3小时前", "2天前". */
export function relTime(iso: string): string {
    if (!iso) return '';
    const t = new Date(iso).getTime();
    if (isNaN(t)) return '';
    const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (s < 60) return '刚刚';
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}分钟`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}小时`;
    const d = Math.floor(h / 24);
    if (d < 30) return `${d}天`;
    const mo = Math.floor(d / 30);
    if (mo < 12) return `${mo}个月`;
    return `${Math.floor(mo / 12)}年`;
}

/** Normalize a file:// URI for comparison: decode (c%3A→c:), lowercase, strip trailing slashes. */
export function normUri(uri: string): string {
    if (!uri) return '';
    try { return decodeURIComponent(uri).toLowerCase().replace(/\/+$/, ''); }
    catch { return uri.toLowerCase().replace(/\/+$/, ''); }
}

/** Last path segment of a URI, URL-decoded, trailing slashes stripped. */
export function basename(uri: string): string {
    if (!uri) return '';
    try { return decodeURIComponent(uri).replace(/\/+$/, '').split('/').pop() || ''; }
    catch { return uri.replace(/\/+$/, '').split('/').pop() || ''; }
}

/** Normalize raw CLI/LS prompt snippet into a clean single-line conversation title. */
export function cleanConversationTitle(raw?: string): string {
    if (!raw) return '新对话';
    const singleLine = String(raw)
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/^[#>*\-\s]+/, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!singleLine) return '新对话';
    return singleLine.length > 60 ? `${singleLine.slice(0, 60)}…` : singleLine;
}

/** Rename a conversation (persisted server-side in SQLite conversation_owners). */
export async function renameConversation(id: string, title: string): Promise<{ success: boolean; title: string }> {
    const res = await authFetch(`${API_BASE}/api/conversations/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ title }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `重命名失败: ${res.status}`);
    return data;
}

/** Delete a conversation (cleanly deletes LS trajectory if connected and local CLI SQLite DB). */
export async function deleteConversation(id: string): Promise<{ success: boolean }> {
    const res = await authFetch(`${API_BASE}/api/cascade/${encodeURIComponent(id)}`, {
        method: 'DELETE',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `删除失败: ${res.status}`);
    return data;
}

/**
 * Load the full conversation index sorted by lastModified (newest first).
 * Filters out zero-step empty stubs unless they already have a custom title.
 */
export async function loadConversationIndex(): Promise<{ projects: Project[]; rows: ConvRow[] }> {
    const [pj, cv] = await Promise.all([
        authFetch(`${API_BASE}/api/projects`)
            .then(r => (r.ok ? r.json() : { projects: [] })).catch(() => ({ projects: [] })),
        authFetch(`${API_BASE}/api/conversations`)
            .then(r => (r.ok ? r.json() : { trajectorySummaries: {} })).catch(() => ({ trajectorySummaries: {} })),
    ]);

    const projects: Project[] = pj.projects || [];
    const projById = new Map(projects.map((p: Project) => [p.id, p]));
    const folderToId = new Map(
        projects.filter(p => p.folderUri).map(p => [normUri(p.folderUri), p.id])
    );
    const summaries: Record<string, RawSummary & { customTitle?: string }> = cv.trajectorySummaries || {};

    const rows: ConvRow[] = Object.entries(summaries)
        .filter(([, s]) => (s.stepCount || 0) > 0 || Boolean(s.customTitle))
        .map(([id, s]) => {
            const ws: RawWorkspaceRef = (s.workspaces && s.workspaces[0]) || {};
            const wsUri = ws.workspaceFolderAbsoluteUri || '';
            let pid = s?.trajectoryMetadata?.projectId || '';
            if (!pid && wsUri) {
                const matchedId = folderToId.get(normUri(wsUri));
                if (matchedId) pid = matchedId;
            }
            const proj = projById.get(pid);
            const repoName = ws.repository?.computedName
                ? String(ws.repository.computedName).split('/').pop()
                : '';
            const projectName = proj?.name || repoName || basename(wsUri) || '';
            return {
                id,
                title: s.customTitle || cleanConversationTitle(s.summary),
                projectId: pid,
                projectName,
                lastModified: s.lastModifiedTime || s.createdTime || '',
                stepCount: s.stepCount || 0,
            };
        })
        .sort((a, b) => (b.lastModified).localeCompare(a.lastModified));

    return { projects, rows };
}

/** Group rows into per-project buckets plus the loose ("no project") bucket. */
export function groupByProject(rows: ConvRow[]): {
    byProject: Map<string, ConvRow[]>;
    loose: ConvRow[];
} {
    const byProject = new Map<string, ConvRow[]>();
    const loose: ConvRow[] = [];
    for (const r of rows) {
        if (!r.projectId || r.projectId === OUTSIDE_PROJECT) {
            loose.push(r);
            continue;
        }
        const list = byProject.get(r.projectId);
        if (list) list.push(r);
        else byProject.set(r.projectId, [r]);
    }
    return { byProject, loose };
}

export interface TimeBucketGroup {
    label: '今天' | '昨天' | '7天内' | '更早';
    rows: ConvRow[];
}

/** Group conversation rows into Doubao-style calendar buckets (newest first). */
export function groupByTimeBucket(rows: ConvRow[]): TimeBucketGroup[] {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
    const startOfWeek = startOfToday - 7 * 24 * 60 * 60 * 1000;

    const buckets: Record<TimeBucketGroup['label'], ConvRow[]> = {
        '今天': [],
        '昨天': [],
        '7天内': [],
        '更早': [],
    };

    for (const r of rows) {
        const ts = r.lastModified ? new Date(r.lastModified).getTime() : 0;
        if (!ts || Number.isNaN(ts)) {
            buckets['更早'].push(r);
        } else if (ts >= startOfToday) {
            buckets['今天'].push(r);
        } else if (ts >= startOfYesterday) {
            buckets['昨天'].push(r);
        } else if (ts >= startOfWeek) {
            buckets['7天内'].push(r);
        } else {
            buckets['更早'].push(r);
        }
    }

    return (['今天', '昨天', '7天内', '更早'] as const)
        .filter((label) => buckets[label].length > 0)
        .map((label) => ({ label, rows: buckets[label] }));
}
