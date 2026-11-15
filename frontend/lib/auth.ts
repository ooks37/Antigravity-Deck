// === Multi-User Session Token & Cookie Helpers ===
// Backend sets HttpOnly `ag_session` cookie on POST /api/auth/login.
// We also persist the opaque session token in localStorage so WebSocket upgrades
// (which can drop cookies behind strict proxies) and Bearer headers work seamlessly.

const SESSION_TOKEN_STORAGE = 'ag_session_token';
const LEGACY_AUTH_KEY_STORAGE = 'antigravity_auth_key';

export function getAuthKey(): string {
    if (typeof window === 'undefined') return '';
    return localStorage.getItem(SESSION_TOKEN_STORAGE) || localStorage.getItem(LEGACY_AUTH_KEY_STORAGE) || '';
}

export function setAuthKey(token: string): void {
    if (typeof window === 'undefined') return;
    localStorage.setItem(SESSION_TOKEN_STORAGE, token);
    localStorage.removeItem(LEGACY_AUTH_KEY_STORAGE);
}

export function clearAuthKey(): void {
    if (typeof window === 'undefined') return;
    localStorage.removeItem(SESSION_TOKEN_STORAGE);
    localStorage.removeItem(LEGACY_AUTH_KEY_STORAGE);
}

export function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const token = getAuthKey();
    return {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}`, 'X-Session-Token': token } : {}),
        ...extra,
    };
}

export function authFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const incomingHeaders = init.headers instanceof Headers
        ? Object.fromEntries(init.headers.entries())
        : (Array.isArray(init.headers) ? Object.fromEntries(init.headers) : (init.headers as Record<string, string> | undefined) || {});
    return fetch(input, {
        ...init,
        credentials: 'include',
        headers: authHeaders(incomingHeaders),
    });
}

export function authWsUrl(baseUrl: string): string {
    const token = getAuthKey();
    if (!token) return baseUrl;
    const sep = baseUrl.includes('?') ? '&' : '?';
    return `${baseUrl}${sep}token=${encodeURIComponent(token)}`;
}
