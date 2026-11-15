// === Cascade API Client ===
import { API_BASE } from './config';
import { authHeaders, authFetch } from './auth';
import type { Step } from './types';

export interface Workspace {
    pid: string;
    workspaceId: string;
    workspaceName: string;
    workspaceFolderUri: string;
    category: 'workspace' | 'playground';
    port: number;
}

export interface WorkspaceResources {
    cpuPercent: number;
    memBytes: number;
    memMB: number;
    name?: string;
}

export interface SystemResources {
    cpuPercent: number;
    memUsedMB: number;
    memTotalMB: number;
    memPercent: number;
    cpuCores: number;
}

export interface ResourceHistoryPoint {
    t: number;
    cpu: number;
    mem: number;
}

export interface ResourceSnapshot {
    system: SystemResources;
    selfStats: SelfStats;
    workspaces: Record<string, WorkspaceResources>;
    history: ResourceHistoryPoint[];
}

export interface SelfProcessStats {
    pid: number | null;
    cpuPercent: number;
    memMB: number;
}

export interface SelfStats {
    backend: SelfProcessStats;
    frontend: SelfProcessStats;
    totalCpuPercent: number;
    totalMemMB: number;
}

export interface CascadeModel {
    label: string;
    modelId: string;
    cliModelId?: string;
    allowedTiers?: string[];
    supportsImages: boolean;
    isRecommended: boolean;
    isBeta?: boolean;
    tagTitle?: string;        // short badge shown in the IDE picker, e.g. "Fast"
    tagDescription?: string;  // badge tooltip, e.g. "Limited time"
    quota: number; // 0-1 fraction remaining
    resetTime?: string | null;
}

export interface ActiveModelAccount {
    alias: string | null;
    email: string | null;
    tierId: string;
    tierLabel: string;
    modelCount: number;
}

// A display section mirroring the Antigravity IDE model picker (from clientModelSorts).
// `name` is the section header (e.g. "Recommended"); empty string means render no header.
export interface CascadeModelGroup {
    name: string;
    models: CascadeModel[];
}

export interface CascadeSendResponse {
    status: number;
    data: string;
}

export interface CascadeSubmitResponse {
    cascadeId: string;
    result: CascadeSendResponse;
}

export interface WorkspaceFolder {
    name: string;
    path: string;
    uri: string;
    open: boolean;
    wsName: string | null;
}

export interface AppSettings {
    defaultWorkspaceRoot: string;
    defaultModel: string;
    agyBinaryPath?: string;
    [key: string]: unknown;
}

// Media item for multi-image support (matches LS API SaveMediaAsArtifact / SendUserCascadeMessage)
export interface MediaItem {
    mimeType: string;
    inlineData: string;   // base64
    uri?: string;         // returned by SaveMediaAsArtifact
    thumbnail?: string;   // base64 thumbnail (downscaled)
}

// Save a media file via SaveMediaAsArtifact (returns uri for later reference)
export async function saveMedia(mimeType: string, inlineData: string, thumbnail?: string): Promise<{ uri?: string }> {
    const res = await fetch(`${API_BASE}/api/media/save`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ mimeType, inlineData, thumbnail: thumbnail || '' }),
    });
    if (!res.ok) throw new Error(`SaveMedia failed: ${res.status}`);
    return res.json();
}

// Send a message to an existing cascade (supports optional multi-image + effort + workspace)
export async function cascadeSend(
    cascadeId: string,
    message: string,
    modelId?: string,
    images?: MediaItem[],
    opts?: { effort?: string; modelLabel?: string; workspace?: string },
): Promise<CascadeSendResponse> {
    const res = await fetch(`${API_BASE}/api/cascade/send`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
            cascadeId,
            message,
            modelId,
            images,
            effort: opts?.effort,
            modelLabel: opts?.modelLabel,
            workspace: opts?.workspace,
        }),
    });
    if (!res.ok) throw new Error(`Send failed: ${res.status}`);
    return res.json();
}

// Start a new cascade and send a message in one call
export async function cascadeSubmit(message: string, modelId?: string, images?: MediaItem[], workspace?: string, workspaceUri?: string): Promise<CascadeSubmitResponse> {
    const res = await fetch(`${API_BASE}/api/cascade/submit`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ message, modelId, images, workspace, workspaceUri }),
    });
    if (!res.ok) throw new Error(`Submit failed: ${res.status}`);
    return res.json();
}

// List all detected workspaces
export async function getWorkspaces(): Promise<Workspace[]> {
    const res = await fetch(`${API_BASE}/api/workspaces`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`Workspaces failed: ${res.status}`);
    return res.json();
}

// Get CPU/RAM resource stats for all workspace PIDs
export async function getWorkspaceResources(): Promise<ResourceSnapshot> {
    const res = await fetch(`${API_BASE}/api/workspaces/resources`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`Resources failed: ${res.status}`);
    return res.json();
}


// Create/open a workspace — accepts { name } or { path }
export async function createWorkspace(nameOrPath: string, isName = false): Promise<{ created: boolean; alreadyOpen?: boolean; workspace?: { pid: string; workspaceName: string; port: number }; message?: string }> {
    const res = await fetch(`${API_BASE}/api/workspaces/create`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(isName ? { name: nameOrPath } : { path: nameOrPath }),
    });
    if (!res.ok) throw new Error(`Create failed: ${res.status}`);
    return res.json();
}

// Kill all Antigravity IDE processes
export async function killIde(): Promise<{ killed: boolean; platform: string; instancesCleared: number }> {
    const res = await fetch(`${API_BASE}/api/kill-ide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
    });
    if (!res.ok) throw new Error(`Kill IDE failed: ${res.status}`);
    return res.json();
}

// List folders in default workspace root
export async function getWorkspaceFolders(): Promise<{ root: string; folders: WorkspaceFolder[] }> {
    const res = await fetch(`${API_BASE}/api/workspaces/folders`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`Folders failed: ${res.status}`);
    return res.json();
}

// Settings
export async function getSettings(): Promise<AppSettings> {
    const res = await fetch(`${API_BASE}/api/settings`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`Settings failed: ${res.status}`);
    return res.json();
}

export async function updateSettings(settings: Partial<AppSettings>): Promise<AppSettings> {
    const res = await fetch(`${API_BASE}/api/settings`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(settings),
    });
    if (!res.ok) throw new Error(`Settings update failed: ${res.status}`);
    return res.json();
}

// Get available cascade models. `groups` mirrors the Antigravity IDE picker's
// sections/order; `models` is the same set flattened (backward compatible).
export async function getModels(refresh = false): Promise<{
    models: CascadeModel[];
    groups: CascadeModelGroup[];
    defaultModel: string;
    source?: string;
    hubSyncing?: boolean;
    activeAccount?: ActiveModelAccount;
}> {
    const q = refresh ? '?refresh=1' : '';
    const res = await fetch(`${API_BASE}/api/models${q}`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`Models failed: ${res.status}`);
    return res.json();
}

// Cancel an active cascade invocation
export async function cascadeCancel(cascadeId: string): Promise<object> {
    const res = await fetch(`${API_BASE}/api/cascade/${cascadeId}/cancel`, { method: 'POST', headers: authHeaders() });
    if (!res.ok) throw new Error(`Cancel failed: ${res.status}`);
    return res.json();
}

// Accept or reject pending code changes
export async function cascadeInteract(cascadeId: string, action: 'accept' | 'reject' = 'accept'): Promise<object> {
    const res = await fetch(`${API_BASE}/api/cascade/${cascadeId}/accept`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ action })
    });
    if (!res.ok) throw new Error(`Interact failed: ${res.status}`);
    return res.json();
}

// Gate options for the current WAITING interaction (dynamic, computed server-side to
// mirror what the Antigravity IDE would show).
export interface GateOption {
    id: string;
    label: string;
    payload: Record<string, unknown>;
}
export interface PermissionGateInfo {
    kind: 'permission';
    action: string;
    actionLabel: string;
    target: string;
    editableTarget: boolean;
    title: string;
    reason: string;
    options: GateOption[];
    denyWriteIn: { label: string; placeholder: string };
}
export type GateInfo =
    | PermissionGateInfo
    | { kind: 'askQuestion' | 'elicitation' | 'filePermission'; spec: Record<string, unknown> }
    | { kind: null };

export async function fetchGate(cascadeId: string): Promise<GateInfo> {
    const res = await fetch(`${API_BASE}/api/cascade/${cascadeId}/gate`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`Gate fetch failed: ${res.status}`);
    return res.json();
}

// Get cascade run status
export interface CascadeStatus {
    cascadeId: string;
    status: string;
    stepCount: number;
    summary: string;
    lastModifiedTime?: string;
}

export async function getCascadeStatus(cascadeId: string): Promise<CascadeStatus> {
    const res = await fetch(`${API_BASE}/api/cascade/${cascadeId}/status`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`Status failed: ${res.status}`);
    return res.json();
}

// Auto-accept (server-side toggle for instant reaction)
export async function getAutoAcceptState(): Promise<{ enabled: boolean }> {
    const res = await fetch(`${API_BASE}/api/auto-accept`, { headers: authHeaders() });
    return res.json();
}

export async function setAutoAcceptState(enabled: boolean): Promise<{ enabled: boolean }> {
    const res = await fetch(`${API_BASE}/api/auto-accept`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ enabled }),
    });
    return res.json();
}

// Clear cache for a specific conversation (forces full re-fetch)
export async function clearConversationCache(cascadeId: string): Promise<{ cleared: boolean }> {
    const res = await fetch(`${API_BASE}/api/cache/${cascadeId}`, { method: 'DELETE', headers: authHeaders() });
    return res.json();
}

// Read file content from disk (for code change viewer)
export async function readFile(filePath: string): Promise<{ content: string; path: string }> {
    const res = await fetch(`${API_BASE}/api/file/read`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ path: filePath }),
    });
    if (!res.ok) throw new Error(`Read failed: ${res.status}`);
    return res.json();
}

// === Git Source Control ===
export interface GitFileStatus {
    path: string;
    status: string;
    statusCode: string;
    additions: number;
    deletions: number;
}

export async function getGitStatus(workspace: string): Promise<{ files: GitFileStatus[]; error?: string }> {
    const res = await fetch(`${API_BASE}/api/workspaces/${encodeURIComponent(workspace)}/git/status`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`Git status failed: ${res.status}`);
    return res.json();
}

export async function getGitDiff(workspace: string, file?: string): Promise<{ diff: string }> {
    const url = file
        ? `${API_BASE}/api/workspaces/${encodeURIComponent(workspace)}/git/diff?file=${encodeURIComponent(file)}`
        : `${API_BASE}/api/workspaces/${encodeURIComponent(workspace)}/git/diff`;
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) throw new Error(`Git diff failed: ${res.status}`);
    return res.json();
}

export async function getGitShow(workspace: string, file: string): Promise<{ content: string | null; error?: string }> {
    const res = await fetch(`${API_BASE}/api/workspaces/${encodeURIComponent(workspace)}/git/show?file=${encodeURIComponent(file)}`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`Git show failed: ${res.status}`);
    return res.json();
}

export async function getWorkspaceFile(workspace: string, file: string): Promise<{ content: string | null; path: string; error?: string }> {
    const res = await fetch(`${API_BASE}/api/workspaces/${encodeURIComponent(workspace)}/file/read?file=${encodeURIComponent(file)}`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`File read failed: ${res.status}`);
    return res.json();
}

// === Workflows (slash commands from Antigravity IDE) ===
export interface WorkflowItem {
    slash: string;
    label: string;
    description: string;
    source: 'global' | 'workspace';
}

export async function fetchWorkflows(workspace?: string): Promise<WorkflowItem[]> {
    const url = workspace
        ? `${API_BASE}/api/workflows?workspace=${encodeURIComponent(workspace)}`
        : `${API_BASE}/api/workflows`;
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) throw new Error(`Workflows failed: ${res.status}`);
    return res.json();
}

export async function fetchWorkflowContent(name: string, workspace?: string): Promise<{ name: string; content: string; source: string }> {
    const url = workspace
        ? `${API_BASE}/api/workflows/${encodeURIComponent(name)}?workspace=${encodeURIComponent(workspace)}`
        : `${API_BASE}/api/workflows/${encodeURIComponent(name)}`;
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) throw new Error(`Workflow content failed: ${res.status}`);
    return res.json();
}

// === File Explorer ===
export interface FsEntry {
    name: string;
    type: 'file' | 'dir';
    size?: number;
    ext?: string;
}

export async function listWorkspaceDir(workspace: string, subpath = ''): Promise<{ entries: FsEntry[]; path: string }> {
    const url = `${API_BASE}/api/workspaces/${encodeURIComponent(workspace)}/fs/list${subpath ? `?path=${encodeURIComponent(subpath)}` : ''}`;
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) throw new Error(`Dir list failed: ${res.status}`);
    return res.json();
}

// Load older steps for scroll-up pagination (binary protobuf on backend)
export async function loadOlderSteps(
    conversationId: string
): Promise<{ steps: Step[]; baseIndex: number; hasMore: boolean }> {
    const res = await fetch(
        `${API_BASE}/api/conversations/${conversationId}/steps/older`,
        { headers: authHeaders() }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

// === Profile Swap & Cross-Platform OAuth Multi-Account ===
export interface ProfileMeta {
    userName?: string | null;
    email?: string | null;
    tier?: string | null;
    plan?: string | null;
    savedAt?: string | null;
}

export interface ProfileEntry {
    name: string;
    meta: ProfileMeta | null;
}

export interface ProfileEnvironment {
    platform: string;
    ideSupported: boolean;
    ideInstalled: boolean;
    ideRunning: boolean;
    headless: boolean;
    profilesDir: string;
    antigravityDataDir: string;
}

export interface OAuthAccountMeta {
    alias: string;
    source: string;
    updatedAt: string;
    email: string | null;
    name: string | null;
    expiry: string | null;
    isExpired: boolean;
    authMethod: string;
    format: string;
    hasRefreshToken: boolean;
    hasAccessToken: boolean;
    isActive: boolean;
}

export interface OAuthListResponse {
    hasCurrentCreds: boolean;
    activeEmail: string | null;
    activeName: string | null;
    expiry: string | null;
    isExpired: boolean;
    oauthCredsExists: boolean;
    accountsDirExists: boolean;
    activeAlias: string | null;
    accounts: OAuthAccountMeta[];
}

export interface ProfileListResponse {
    profiles: ProfileEntry[];
    active: string | null;
    environment?: ProfileEnvironment | null;
    oauth?: OAuthListResponse | null;
}

async function apiJson<T>(url: string, init?: RequestInit, fallbackErr = '请求失败'): Promise<T> {
    const res = await authFetch(url, {
        ...init,
        headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...(init?.headers as Record<string, string> | undefined || {}) },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${fallbackErr}: ${res.status}`);
    return data as T;
}

export interface FleetServer {
    id: string;
    name: string;
    ip: string;
    host: string;
    port: number | null;
    hostname: string;
    region: string;
    isp: string;
    os: string;
    kernel: string;
    cpuModel: string;
    cores: number | null;
    ramGb: number | null;
    diskGb: number | null;
    combo: string;
    tags: string[];
    description: string;
    isActive: boolean;
    configured: boolean;
    online?: boolean;
    authOk?: boolean;
    statusCode?: number | null;
    latencyMs?: number | null;
    error?: string | null;
    checkedAt?: string;
}

export interface FleetResponse {
    exists: boolean;
    configPath: string;
    activeServer: string | null;
    count: number;
    onlineCount?: number;
    servers: FleetServer[];
    error?: string;
}

export interface OAuthAccountQuota {
    alias: string;
    email: string | null;
    fetchedAt?: string;
    avgQuota?: number | null;
    minQuota?: number | null;
    exhaustedCount?: number;
    totalModels?: number;
    tierId?: string;
    tierLabel?: string;
    models?: Array<{
        modelId: string;
        displayName: string;
        remainingFraction: number | null;
        resetTime: string | null;
    }>;
    error?: string;
}

export interface UploadedFileResult {
    success: boolean;
    name: string;
    originalName: string;
    path: string;
    relativePath: string;
    size: number;
    mimeType: string;
}

export async function getAuthInfo(): Promise<{ authEnabled: boolean; keyLength: number }> {
    return apiJson(`${API_BASE}/api/auth/info`, undefined, '获取访问认证信息失败');
}

export async function changeAuthPassword(payload: { currentKey?: string; newKey: string }): Promise<{ updated: boolean; keyLength: number }> {
    return apiJson(`${API_BASE}/api/auth/password`, {
        method: 'POST',
        body: JSON.stringify(payload),
    }, '修改访问密码失败');
}

export async function getFleetServers(): Promise<FleetResponse> {
    return apiJson(`${API_BASE}/api/fleet/servers`, undefined, '获取服务器列表失败');
}

export async function pingFleetServers(timeoutMs = 3500): Promise<FleetResponse> {
    return apiJson(`${API_BASE}/api/fleet/ping`, {
        method: 'POST',
        body: JSON.stringify({ timeoutMs }),
    }, '检测服务器连通性失败');
}

export async function uploadWorkspaceFile(payload: {
    name: string;
    contentBase64?: string;
    contentText?: string;
    workspace?: string;
    mimeType?: string;
}): Promise<UploadedFileResult> {
    return apiJson(`${API_BASE}/api/files/upload`, {
        method: 'POST',
        body: JSON.stringify(payload),
    }, '上传文件失败');
}

export async function switchOAuthAccount(
    target: string,
    opts?: { reloadHub?: boolean; refreshIfExpired?: boolean },
): Promise<{
    success: boolean;
    alias: string;
    email: string | null;
    name: string | null;
    oauthSynced: boolean;
    credManSynced: boolean;
    headlessTokenSynced?: boolean;
    tokenRefreshed?: boolean;
    hubReloaded?: boolean;
}> {
    return apiJson(`${API_BASE}/api/accounts/oauth/use`, {
        method: 'POST',
        body: JSON.stringify({
            target,
            reloadHub: opts?.reloadHub ?? true,
            refreshIfExpired: opts?.refreshIfExpired ?? true,
        }),
    }, '切换 OAuth 账号失败');
}

export async function getOAuthQuotas(alias?: string): Promise<OAuthAccountQuota | { activeAlias: string | null; accounts: OAuthAccountQuota[] }> {
    const q = alias ? `?alias=${encodeURIComponent(alias)}` : '';
    return apiJson(`${API_BASE}/api/accounts/oauth/quota${q}`, undefined, '获取账号配额失败');
}

export async function rotateOAuthAccount(reloadHub = true): Promise<{
    rotated: boolean;
    previousAlias: string | null;
    alias: string;
    email: string | null;
    hubReloaded?: boolean;
}> {
    return apiJson(`${API_BASE}/api/accounts/oauth/rotate`, {
        method: 'POST',
        body: JSON.stringify({ reloadHub }),
    }, '轮转切换账号失败');
}

export async function startOAuthLoginUrl(redirectUri?: string): Promise<{ authUrl: string; redirectUri: string; state: string }> {
    return apiJson(`${API_BASE}/api/accounts/oauth/login-url`, {
        method: 'POST',
        body: JSON.stringify(redirectUri ? { redirectUri } : {}),
    }, '生成 Google 登录链接失败');
}

export async function completeOAuthCallback(payload: {
    callbackUrl?: string;
    code?: string;
    state?: string;
    alias?: string;
    activate?: boolean;
}): Promise<{ success: boolean; alias: string; email: string | null }> {
    return apiJson(`${API_BASE}/api/accounts/oauth/callback`, {
        method: 'POST',
        body: JSON.stringify(payload),
    }, '完成 Google OAuth 登录失败');
}

export async function runAgyQuick(payload: {
    prompt: string;
    model?: string;
    modelLabel?: string;
    effort?: string;
    conversationId?: string;
    workspace?: string;
}): Promise<{ success: boolean; text?: string; sessionId?: string | null; error?: string }> {
    return apiJson(`${API_BASE}/api/agy/run`, {
        method: 'POST',
        body: JSON.stringify(payload),
    }, '调用 agy 执行失败');
}

export async function getProfiles(): Promise<ProfileListResponse> {
    return apiJson<ProfileListResponse>(`${API_BASE}/api/profiles`, undefined, '获取账号档案失败');
}

export async function swapProfile(target: string): Promise<{ success: boolean; platform?: string; previousProfile: string; activeProfile: string; relaunched: boolean }> {
    return apiJson(`${API_BASE}/api/profiles/swap`, {
        method: 'POST',
        body: JSON.stringify({ targetProfile: target }),
    }, '切换档案失败');
}

export async function autoOnboardProfile(): Promise<{ created?: boolean; skipped?: boolean; message: string; autoName?: string; active?: string }> {
    return apiJson(`${API_BASE}/api/profiles/auto-onboard`, { method: 'POST' }, '自动识别档案失败');
}

export async function createProfileEntry(name: string, force = false): Promise<{ created: boolean; copied: number; message: string; warning?: string }> {
    return apiJson(`${API_BASE}/api/profiles/create`, {
        method: 'POST',
        body: JSON.stringify({ name, force }),
    }, '创建档案失败');
}

export async function renameProfileEntry(name: string, newName: string): Promise<{ renamed: boolean; oldName: string; newName: string }> {
    return apiJson(`${API_BASE}/api/profiles/${encodeURIComponent(name)}`, {
        method: 'PATCH',
        body: JSON.stringify({ newName }),
    }, '重命名档案失败');
}

export async function deleteProfileEntry(name: string): Promise<{ deleted: boolean; message: string }> {
    return apiJson(`${API_BASE}/api/profiles/${encodeURIComponent(name)}`, { method: 'DELETE' }, '删除档案失败');
}

export async function startAddAccountFlow(): Promise<{ success: boolean; previousProfile: string; relaunched: boolean; message: string }> {
    return apiJson(`${API_BASE}/api/profiles/add-account`, { method: 'POST' }, '启动新账号登录失败');
}

export async function cancelAddAccountFlow(previousProfile: string): Promise<{ success: boolean; activeProfile: string; relaunched: boolean }> {
    return apiJson(`${API_BASE}/api/profiles/cancel-add`, {
        method: 'POST',
        body: JSON.stringify({ previousProfile }),
    }, '还原原档案失败');
}

export async function getOAuthAccounts(): Promise<OAuthListResponse> {
    return apiJson(`${API_BASE}/api/accounts/oauth`, undefined, '获取 OAuth 账号列表失败');
}

export async function saveOAuthAccount(alias?: string, force = false): Promise<{ saved: boolean; alias: string; account: OAuthAccountMeta }> {
    return apiJson(`${API_BASE}/api/accounts/oauth/save`, {
        method: 'POST',
        body: JSON.stringify({ alias: alias || '', force }),
    }, '保存当前凭据失败');
}

export async function importOAuthAccount(payload: { alias?: string; credentialJson: string; force?: boolean; activate?: boolean }): Promise<{ imported: boolean; alias: string; activated: boolean; account: OAuthAccountMeta }> {
    return apiJson(`${API_BASE}/api/accounts/oauth/import`, {
        method: 'POST',
        body: JSON.stringify(payload),
    }, '导入 OAuth 凭据失败');
}

export async function useOAuthAccount(target: string): Promise<{ success: boolean; alias: string; email: string | null; name: string | null; oauthSynced: boolean; credManSynced: boolean }> {
    return apiJson(`${API_BASE}/api/accounts/oauth/use`, {
        method: 'POST',
        body: JSON.stringify({ target }),
    }, '切换 OAuth 账号失败');
}

export async function renameOAuthAccountEntry(alias: string, newAlias: string): Promise<{ renamed: boolean; oldAlias: string; newAlias: string }> {
    return apiJson(`${API_BASE}/api/accounts/oauth/${encodeURIComponent(alias)}`, {
        method: 'PATCH',
        body: JSON.stringify({ newAlias }),
    }, '重命名 OAuth 账号失败');
}

export async function deleteOAuthAccountEntry(alias: string): Promise<{ deleted: boolean; alias: string }> {
    return apiJson(`${API_BASE}/api/accounts/oauth/${encodeURIComponent(alias)}`, {
        method: 'DELETE',
    }, '删除 OAuth 账号失败');
}

// === LS API Proxy ===
// Generic helper for proxied LS calls: POST /api/ls/:method (relative path — uses Next.js rewrite).
export async function lsCall<T = unknown>(method: string, body: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    const res = await fetch(`/api/ls/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(body),
        signal,
    });
    if (!res.ok) throw new Error(`LS ${method} failed: ${res.status}`);
    return res.json();
}

// === Antigravity CLI (agy) Management ===
export interface AgyUpdateRecord {
    success: boolean;
    previousVersion: string | null;
    version: string | null;
    updated: boolean;
    output?: string;
    error?: string;
}

export interface AgyStatus {
    found: boolean;
    path: string | null;
    configuredPath: string;
    source: string | null;
    version: string | null;
    platform: string;
    updating: boolean;
    lastUpdateAt: string | null;
    lastUpdateResult: AgyUpdateRecord | null;
    error?: string;
}

export interface AgyChangelog {
    found: boolean;
    path?: string | null;
    latestEntryVersion: string | null;
    text: string;
    truncated: boolean;
    totalLines: number;
    error?: string;
}

export interface AgyUpdateResult {
    success: boolean;
    inProgress?: boolean;
    path?: string | null;
    previousVersion?: string | null;
    version?: string | null;
    updated?: boolean;
    output?: string;
    checkedAt?: string;
    error?: string;
}

export async function getAgyStatus(refresh = true): Promise<AgyStatus> {
    const res = await fetch(`${API_BASE}/api/agy/status?refresh=${refresh ? 'true' : 'false'}`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`获取 agy 状态失败: ${res.status}`);
    return res.json();
}

export async function getAgyChangelog(limit = 120): Promise<AgyChangelog> {
    const res = await fetch(`${API_BASE}/api/agy/changelog?limit=${limit}`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`读取 agy 更新日志失败: ${res.status}`);
    return res.json();
}

export async function triggerAgyUpdate(): Promise<AgyUpdateResult> {
    const res = await fetch(`${API_BASE}/api/agy/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok && data.success === undefined) {
        throw new Error(data.error || `更新 agy 失败: ${res.status}`);
    }
    return data;
}

// === SOCKS5h / HTTP Proxy Pool ===
export interface ProxyTestResult {
    ok: boolean;
    exitIp: string | null;
    country: string | null;
    city: string | null;
    org: string | null;
    latencyMs: number | null;
    testedAt?: string;
    error?: string;
}

export interface ProxyNode {
    id: string;
    name: string;
    protocol: 'socks5h' | 'socks5' | 'socks4' | 'http' | 'https';
    host: string;
    port: number;
    username: string;
    hasPassword: boolean;
    maskedUrl: string;
    createdAt: string | null;
    lastTest: ProxyTestResult | null;
}

export interface ProxyState {
    enabled: boolean;
    activeNodeId: string | null;
    activeNode: ProxyNode | null;
    applyToIde: boolean;
    bypassHosts: string;
    nodes: ProxyNode[];
}

export interface ProxyNodeInput {
    name?: string;
    protocol?: string;
    host?: string;
    port?: number | string;
    username?: string;
    password?: string;
    clearPassword?: boolean;
    url?: string;
    activate?: boolean;
}

export async function getProxyState(): Promise<ProxyState> {
    return apiJson<ProxyState>(`${API_BASE}/api/proxy`, undefined, '获取代理配置失败');
}

export async function getProxyIpStatus(): Promise<{ direct: ProxyTestResult; proxied: ProxyTestResult | null; state: ProxyState }> {
    return apiJson(`${API_BASE}/api/proxy/ip`, undefined, '检测出口 IP 失败');
}

export async function addProxyNode(input: ProxyNodeInput): Promise<{ node: ProxyNode; state: ProxyState }> {
    return apiJson(`${API_BASE}/api/proxy/nodes`, { method: 'POST', body: JSON.stringify(input) }, '添加代理节点失败');
}

export async function updateProxyNode(id: string, input: ProxyNodeInput): Promise<{ node: ProxyNode; state: ProxyState }> {
    return apiJson(`${API_BASE}/api/proxy/nodes/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) }, '更新代理节点失败');
}

export async function deleteProxyNode(id: string): Promise<{ deleted: boolean; id: string; state: ProxyState }> {
    return apiJson(`${API_BASE}/api/proxy/nodes/${encodeURIComponent(id)}`, { method: 'DELETE' }, '删除代理节点失败');
}

export async function useProxyNode(id: string | null, enabled?: boolean): Promise<{ success: boolean; state: ProxyState }> {
    return apiJson(`${API_BASE}/api/proxy/use`, { method: 'POST', body: JSON.stringify({ id, enabled }) }, '切换代理节点失败');
}

export async function rotateProxyNode(): Promise<{ success: boolean; state: ProxyState }> {
    return apiJson(`${API_BASE}/api/proxy/rotate`, { method: 'POST' }, '轮换下一代理节点失败');
}

export async function updateProxyPreferences(prefs: { enabled?: boolean; applyToIde?: boolean; bypassHosts?: string }): Promise<{ success: boolean; state: ProxyState }> {
    return apiJson(`${API_BASE}/api/proxy/preferences`, { method: 'PATCH', body: JSON.stringify(prefs) }, '更新代理偏好失败');
}

export async function testProxyNode(payload: { id?: string } | ProxyNodeInput): Promise<{ result: ProxyTestResult; state?: ProxyState }> {
    return apiJson(`${API_BASE}/api/proxy/test`, { method: 'POST', body: JSON.stringify(payload) }, '测试代理连通性失败');
}

// === Permissions & Antigravity Daemon Control ===
export type AgentMode = 'default' | 'accept-edits' | 'auto' | 'plan';
export type ToolPermission = 'request-review' | 'proceed-in-sandbox' | 'always-proceed' | 'strict';
export type ArtifactReviewPolicy = 'asks-for-review' | 'agent-decides' | 'always-proceed';
export type PermissionPresetName = 'strict' | 'default' | 'accept-edits' | 'auto' | 'turbo';

export interface CliPermissionsConfig {
    agentMode: AgentMode;
    toolPermission: ToolPermission;
    artifactReviewPolicy: ArtifactReviewPolicy;
    allowNonWorkspaceAccess: boolean;
    enableTerminalSandbox: boolean;
    permissions: {
        allow: string[];
        ask: string[];
        deny: string[];
    };
}

export interface PermissionConfigState {
    autoAccept: boolean;
    autoAcceptPolicy?: 'smart' | 'full';
    settingsPath: string;
    fileExists: boolean;
    parseError: string | null;
    lsConnected?: boolean;
    presetApplied?: PermissionPresetName;
    cli: CliPermissionsConfig;
}

export interface IdeRuntimeStatus {
    lsDetected: boolean;
    port: number | null;
    ideInstalled: boolean;
    ideRunning: boolean;
    pm2Managed: boolean;
    platform: string;
}

export async function getPermissionsConfig(): Promise<PermissionConfigState> {
    return apiJson<PermissionConfigState>(`${API_BASE}/api/permissions`, undefined, '获取权限设置失败');
}

export async function updatePermissionsConfig(payload: {
    autoAccept?: boolean;
    autoAcceptPolicy?: 'smart' | 'full';
    cli?: Partial<CliPermissionsConfig>;
}): Promise<PermissionConfigState> {
    return apiJson<PermissionConfigState>(`${API_BASE}/api/permissions`, {
        method: 'POST',
        body: JSON.stringify(payload),
    }, '保存权限设置失败');
}

export async function applyPermissionPreset(preset: PermissionPresetName): Promise<PermissionConfigState> {
    return apiJson<PermissionConfigState>(`${API_BASE}/api/permissions/preset`, {
        method: 'POST',
        body: JSON.stringify({ preset }),
    }, '应用权限预设失败');
}

export async function getIdeRuntimeStatus(): Promise<IdeRuntimeStatus> {
    return apiJson<IdeRuntimeStatus>(`${API_BASE}/api/ide/status`, undefined, '获取 Antigravity 服务状态失败');
}

export async function restartIdeService(): Promise<{ restarted: boolean; managedBy: string; platform: string }> {
    return apiJson(`${API_BASE}/api/ide/restart`, { method: 'POST' }, '重启 Antigravity 服务失败');
}

// === Multi-User Auth & User Administration ===
export interface UserProfile {
    id: string;
    username: string;
    displayName: string;
    role: 'admin' | 'member';
    disabled?: boolean;
    conversationCount?: number;
    createdAt?: string;
    updatedAt?: string;
    isNoAuth?: boolean;
}

export interface AuthMeResponse {
    authEnabled: boolean;
    multiUser: boolean;
    authenticated: boolean;
    user: UserProfile | null;
}

export async function fetchAuthMe(): Promise<AuthMeResponse> {
    return apiJson<AuthMeResponse>(`${API_BASE}/api/auth/me`, undefined, '获取登录状态失败');
}

export async function authLogin(
    username: string,
    password: string,
    remember = true,
): Promise<{ user: UserProfile; token: string; expiresAt: string; persistent?: boolean }> {
    return apiJson(`${API_BASE}/api/auth/login`, {
        method: 'POST',
        body: JSON.stringify({ username, password, remember }),
    }, '登录失败');
}

export async function authLogout(): Promise<{ success: boolean }> {
    return apiJson(`${API_BASE}/api/auth/logout`, { method: 'POST' }, '退出登录失败');
}

export async function changeOwnCredentials(payload: {
    currentPassword?: string;
    newPassword?: string;
    newUsername?: string;
    displayName?: string;
}): Promise<{ updated: boolean; user: UserProfile }> {
    return apiJson(`${API_BASE}/api/auth/password`, {
        method: 'POST',
        body: JSON.stringify(payload),
    }, '更新账号信息失败');
}

export async function listUsers(): Promise<{ users: UserProfile[] }> {
    return apiJson(`${API_BASE}/api/users`, undefined, '获取成员列表失败');
}

export async function createUserAccount(payload: {
    username: string;
    password: string;
    displayName?: string;
    role?: 'admin' | 'member';
}): Promise<{ user: UserProfile }> {
    return apiJson(`${API_BASE}/api/users`, {
        method: 'POST',
        body: JSON.stringify(payload),
    }, '创建成员失败');
}

export async function updateUserAccount(
    id: string,
    payload: { displayName?: string; password?: string; disabled?: boolean; role?: 'admin' | 'member' },
): Promise<{ user: UserProfile }> {
    return apiJson(`${API_BASE}/api/users/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
    }, '更新成员失败');
}

export async function deleteUserAccount(id: string): Promise<{ deleted: boolean; id: string }> {
    return apiJson(`${API_BASE}/api/users/${encodeURIComponent(id)}`, {
        method: 'DELETE',
    }, '删除成员失败');
}

// === Real-Time Streaming agy Chat (SSE) ===
export interface AgyStreamEventHandlers {
    onInit?: (data: { sessionId: string; model?: string | null; effort?: string | null }) => void;
    onStatus?: (data: { phase: string; elapsedMs?: number }) => void;
    onThinking?: (data: { text: string; elapsedMs?: number }) => void;
    onTool?: (data: { name: string; status: string; info?: unknown; elapsedMs?: number }) => void;
    onTurnSteps?: (data: { sessionId: string; baseIndex: number; steps: Step[]; totalSteps: number }) => void;
    onTextDelta?: (data: { text: string; fullText?: string }) => void;
    onStepsSync?: (data: { sessionId: string; steps: Step[]; stepCount: number }) => void;
    onDone?: (data: { sessionId?: string | null; model?: string | null; effort?: string | null; text?: string }) => void;
    onError?: (error: string) => void;
}

export async function streamAgyChat(
    payload: {
        prompt: string;
        model?: string;
        modelLabel?: string;
        effort?: string;
        conversationId?: string;
        workspace?: string;
    },
    handlers: AgyStreamEventHandlers,
    signal?: AbortSignal,
): Promise<{ sessionId?: string | null; text?: string }> {
    const res = await authFetch(`${API_BASE}/api/agy/stream`, {
        method: 'POST',
        body: JSON.stringify(payload),
        signal,
    });
    if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `发送失败 (${res.status})`);
    }
    if (!res.body) {
        throw new Error('浏览器不支持流式响应');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let finalSessionId: string | null = null;
    let finalText = '';

    const dispatchBlock = (block: string) => {
        if (!block.trim()) return;
        let eventName = 'message';
        const dataLines: string[] = [];
        for (const rawLine of block.split(/\r?\n/)) {
            const line = rawLine.trimEnd();
            if (!line || line.startsWith(':')) continue;
            if (line.startsWith('event:')) {
                eventName = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
                dataLines.push(line.slice(5).trim());
            }
        }
        if (!dataLines.length) return;
        let data: Record<string, unknown>;
        try {
            data = JSON.parse(dataLines.join('\n'));
        } catch {
            return;
        }
        const ev = (typeof data.type === 'string' && eventName === 'message') ? data.type : eventName;
        if (ev === 'init') {
            if (typeof data.sessionId === 'string') finalSessionId = data.sessionId;
            handlers.onInit?.(data as { sessionId: string; model?: string | null; effort?: string | null });
        } else if (ev === 'status') {
            handlers.onStatus?.(data as { phase: string; elapsedMs?: number });
        } else if (ev === 'thinking') {
            handlers.onThinking?.(data as { text: string; elapsedMs?: number });
        } else if (ev === 'tool') {
            handlers.onTool?.(data as { name: string; status: string; info?: unknown; elapsedMs?: number });
        } else if (ev === 'turn_steps') {
            handlers.onTurnSteps?.(data as { sessionId: string; baseIndex: number; steps: Step[]; totalSteps: number });
        } else if (ev === 'text_delta') {
            if (typeof data.fullText === 'string') finalText = data.fullText;
            else if (typeof data.text === 'string') finalText += data.text;
            handlers.onTextDelta?.(data as { text: string; fullText?: string });
        } else if (ev === 'steps_sync') {
            handlers.onStepsSync?.(data as { sessionId: string; steps: Step[]; stepCount: number });
        } else if (ev === 'done') {
            if (typeof data.sessionId === 'string') finalSessionId = data.sessionId;
            if (typeof data.text === 'string') finalText = data.text;
            handlers.onDone?.(data as { sessionId?: string | null; model?: string | null; effort?: string | null; text?: string });
        } else if (ev === 'error') {
            const msg = typeof data.error === 'string' ? data.error : '生成失败';
            handlers.onError?.(msg);
            throw new Error(msg);
        }
    };

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split(/\r?\n\r?\n/);
        buffer = parts.pop() || '';
        for (const block of parts) dispatchBlock(block);
    }
    buffer += decoder.decode();
    if (buffer.trim()) dispatchBlock(buffer);

    return { sessionId: finalSessionId, text: finalText };
}




