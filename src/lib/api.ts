export type Photo = {
  id: string;
  bundleId?: string;
  filename: string;
  path: string;
  sizeBytes: number;
  width: number;
  height: number;
  uploadedAt: string;
  url?: string;
};

export type BundleSummary = { id: string; path: string; photoCount: number; sizeBytes: number };
export type Track = { id: string; title: string; filename: string; path: string; sizeBytes: number; uploadedAt: string };
export type Playlist = { version: number; updatedAt: string; humanMode: Track[]; divineMode: Track[] };
export type Dashboard = {
  repository: string;
  branch: string;
  mediaBaseUrl: string;
  timezone: string;
  connected: boolean;
  mediaManifest: { version: number; updatedAt: string; photoBundles: BundleSummary[] };
  playlist: Playlist;
  photoCount: number;
  photoBytes: number;
  musicCount: number;
  bundleLimitBytes: number;
};
export type Session = { authenticated: boolean; username?: string; csrf?: string; expiresAt?: number };

let csrfToken = '';
export function setCsrfToken(value: string) { csrfToken = value; }

export async function api<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  if (['POST', 'DELETE', 'PUT', 'PATCH'].includes(init.method?.toUpperCase() ?? 'GET') && csrfToken) {
    headers.set('x-csrf-token', csrfToken);
  }
  const response = await fetch(url, { ...init, headers, credentials: 'include' });
  const data = await response.json().catch(() => ({})) as T & { error?: string };
  if (response.status === 401) window.dispatchEvent(new Event('media-session-expired'));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

export function formatDate(value: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(value));
}
