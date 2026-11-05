import { del, get } from '@vercel/blob';

const API = 'https://api.github.com';
const PHOTO_ROOT = 'public/Photos/optimized';
const MUSIC_ROOT = 'public/music';
const PLAYLISTS = ['Sams-Playlist', 'Prems-Playlist'] as const;

type Settings = { owner: string; repository: string; branch: string; token?: string };
export type RepositoryFile = { path: string; size: number };
export type StagedMedia = { stagingPath: string; path: string; size: number };

function settings(): Settings {
  const owner = process.env.GITHUB_OWNER || 'prem143-sm';
  const repository = process.env.GITHUB_REPOSITORY || 'SamsBday';
  const branch = process.env.GITHUB_BRANCH || 'main';
  const token = process.env.GITHUB_TOKEN;
  if (!/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repository)) {
    throw new Error('GitHub repository settings are invalid.');
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('GitHub branch setting is invalid.');
  }
  return { owner, repository, branch, token };
}

function endpoint(path: string): string {
  const { owner, repository } = settings();
  return `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/${path}`;
}

async function github<T>(path: string, init?: RequestInit): Promise<T> {
  const config = settings();
  const method = init?.method?.toUpperCase() ?? 'GET';
  if (method !== 'GET' && !config.token) {
    throw new Error('Repository updates need GITHUB_TOKEN with Contents read/write permission.');
  }
  const response = await fetch(endpoint(path), {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    if (response.status === 409 || response.status === 422) {
      throw new Error('The SamsBday repository changed during the update. Refresh and retry.');
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error('GitHub rejected GITHUB_TOKEN or its repository permissions.');
    }
    if (response.status === 404) throw new Error('SamsBday repository or branch was not found.');
    throw new Error(`GitHub media request failed (${response.status}).`);
  }
  return response.json() as Promise<T>;
}

export async function listManagedFiles(): Promise<{ headSha: string; files: RepositoryFile[] }> {
  const config = settings();
  const reference = await github<{ object: { sha: string } }>(
    `git/ref/heads/${config.branch.split('/').map(encodeURIComponent).join('/')}`,
  );
  const commit = await github<{ tree: { sha: string } }>(`git/commits/${reference.object.sha}`);
  const tree = await github<{ truncated: boolean; tree: Array<{ path: string; type: string; size?: number }> }>(
    `git/trees/${commit.tree.sha}?recursive=1`,
  );
  if (tree.truncated) throw new Error('The SamsBday repository is too large to list safely.');
  return {
    headSha: reference.object.sha,
    files: tree.tree
      .filter((entry) => entry.type === 'blob')
      .filter((entry) => entry.path.startsWith(`${PHOTO_ROOT}/`) || entry.path.startsWith(`${MUSIC_ROOT}/`))
      .map((entry) => ({ path: entry.path, size: entry.size ?? 0 })),
  };
}

export function isManagedPath(path: string): boolean {
  return path.startsWith(`${PHOTO_ROOT}/`) || path.startsWith(`${MUSIC_ROOT}/`);
}

export function isValidPlaylist(value: string): value is (typeof PLAYLISTS)[number] {
  return PLAYLISTS.some((playlist) => playlist === value);
}

export function managedMediaUrl(path: string): string {
  const { owner, repository, branch } = settings();
  return `https://raw.githubusercontent.com/${owner}/${repository}/${encodeURIComponent(branch)}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

export async function readStagedMedia(path: string): Promise<Buffer> {
  if (!/^staging\/[A-Za-z0-9_-]{16,80}$/.test(path)) throw new Error('Temporary upload reference is invalid.');
  const result = await get(path, { access: 'private' });
  if (!result?.stream) throw new Error('A temporary upload expired or could not be found.');
  return Buffer.from(await new Response(result.stream).arrayBuffer());
}

export async function commitManagedChanges(
  expectedHead: string,
  additions: StagedMedia[],
  removals: string[],
  message: string,
): Promise<void> {
  const { branch } = settings();
  const currentCommit = await github<{ tree: { sha: string } }>(`git/commits/${expectedHead}`);
  const entries: Array<{ path: string; mode: '100644'; type: 'blob'; sha: string | null }> = [];
  for (const addition of additions) {
    const bytes = await readStagedMedia(addition.stagingPath);
    if (bytes.length !== addition.size) throw new Error('A temporary upload changed size before commit.');
    const blob = await github<{ sha: string }>('git/blobs', {
      method: 'POST',
      body: JSON.stringify({ content: bytes.toString('base64'), encoding: 'base64' }),
    });
    entries.push({ path: addition.path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  for (const path of removals) entries.push({ path, mode: '100644', type: 'blob', sha: null });
  if (!entries.length) throw new Error('No repository changes were requested.');

  const tree = await github<{ sha: string }>('git/trees', {
    method: 'POST',
    body: JSON.stringify({ base_tree: currentCommit.tree.sha, tree: entries }),
  });
  const commit = await github<{ sha: string }>('git/commits', {
    method: 'POST',
    body: JSON.stringify({ message, tree: tree.sha, parents: [expectedHead] }),
  });
  await github(`git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha, force: false }),
  });
}

export async function deleteStagedMedia(paths: string[]): Promise<void> {
  if (paths.length) await del(paths);
}
