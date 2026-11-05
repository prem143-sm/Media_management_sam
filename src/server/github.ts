import { del, get } from '@vercel/blob';

export type PhotoEntry = {
  id: string;
  filename: string;
  path: string;
  sizeBytes: number;
  width: number;
  height: number;
  uploadedAt: string;
};

export type PhotoBundleManifest = {
  id: string;
  photoCount: number;
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
  photos: PhotoEntry[];
};

export type PhotoBundleSummary = {
  id: string;
  path: string;
  photoCount: number;
  sizeBytes: number;
};

export type MediaManifest = {
  version: number;
  updatedAt: string;
  photoBundles: PhotoBundleSummary[];
};

export type MusicTrack = {
  id: string;
  title: string;
  filename: string;
  path: string;
  sizeBytes: number;
  uploadedAt: string;
};

export type PlaylistManifest = {
  version: number;
  updatedAt: string;
  humanMode: MusicTrack[];
  divineMode: MusicTrack[];
};

type TreeEntry = { path: string; mode: '100644'; type: 'blob'; sha: string | null };
export type StagedBlobReference = { stagingPath: string; sizeBytes: number };
export type TreeContent = string | Buffer | StagedBlobReference;
type GithubConfig = { token: string; owner: string; repository: string; branch: string };
const API = 'https://api.github.com';
const inFlightWrites = new Map<string, Promise<unknown>>();

function config(): GithubConfig {
  const { GITHUB_TOKEN: token, GITHUB_OWNER: owner, GITHUB_REPOSITORY: repository } = process.env;
  const branch = process.env.GITHUB_BRANCH || 'main';
  if (!token || !owner || !repository) throw new Error('GitHub storage is not configured.');
  const branchParts = branch.split('/');
  if (
    !/^[A-Za-z0-9._-]+$/.test(owner) ||
    !/^[A-Za-z0-9._-]+$/.test(repository) ||
    !/^[A-Za-z0-9._/-]+$/.test(branch) ||
    branchParts.some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error('GitHub repository settings are invalid.');
  }
  return { token, owner, repository, branch };
}

function endpoint(path: string): string {
  const c = config();
  return `${API}/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repository)}/${path}`;
}

async function github<T>(path: string, init?: RequestInit): Promise<T> {
  const c = config();
  const response = await fetch(endpoint(path), {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${c.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const status = response.status === 401 || response.status === 403 ? 'GitHub rejected the configured token or permissions.' :
      response.status === 404 ? 'The configured GitHub repository or branch was not found.' :
        response.status === 409 || response.status === 422 ? 'The repository changed during this update. Refresh and retry.' :
          `GitHub request failed (${response.status}).`;
    throw new Error(status);
  }
  return response.json() as Promise<T>;
}

async function contents<T>(path: string, ref = config().branch): Promise<T | null> {
  const c = config();
  const filePath = path.split('/').map(encodeURIComponent).join('/');
  const response = await fetch(`${API}/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repository)}/contents/${filePath}?ref=${encodeURIComponent(ref)}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${c.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'GitHub rejected the configured token or permissions.' : `Could not read repository file (${response.status}).`);
  const file = await response.json() as { content?: string; encoding?: string };
  if (file.encoding !== 'base64' || typeof file.content !== 'string') throw new Error('A repository manifest has an unsupported format.');
  const parsed: unknown = JSON.parse(Buffer.from(file.content.replace(/\s/g, ''), 'base64').toString('utf8'));
  if (!parsed || typeof parsed !== 'object') throw new Error('A repository manifest has an unsupported format.');
  return parsed as T;
}

function blankMedia(): MediaManifest {
  return { version: 1, updatedAt: new Date().toISOString(), photoBundles: [] };
}

function blankPlaylist(): PlaylistManifest {
  return { version: 1, updatedAt: new Date().toISOString(), humanMode: [], divineMode: [] };
}

function validManifest(media: MediaManifest): boolean {
  if (!Number.isInteger(media.version) || media.version < 1 || !Array.isArray(media.photoBundles)) return false;
  const ids = new Set<string>();
  return media.photoBundles.every((bundle) => {
    if (
      !/^bundle-\d{3,}$/.test(bundle.id) || ids.has(bundle.id) ||
      bundle.path !== `photos/${bundle.id}/` ||
      !Number.isSafeInteger(bundle.photoCount) || bundle.photoCount < 1 ||
      !Number.isSafeInteger(bundle.sizeBytes) || bundle.sizeBytes < 1
    ) return false;
    ids.add(bundle.id);
    return true;
  });
}

function validPlaylist(playlist: PlaylistManifest): boolean {
  if (!Number.isInteger(playlist.version) || playlist.version < 1) return false;
  const ids = new Set<string>();
  for (const [category, folder] of [['humanMode', 'human-mode'], ['divineMode', 'divine-mode']] as const) {
    const tracks = playlist[category];
    if (!Array.isArray(tracks)) return false;
    for (const track of tracks) {
      if (
        !track || typeof track.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(track.id) || ids.has(track.id) ||
        typeof track.title !== 'string' || typeof track.filename !== 'string' ||
        !/^[A-Za-z0-9_-]+\.(mp3|wav|m4a|ogg|flac|aac)$/i.test(track.filename) ||
        track.path !== `music/${folder}/${track.filename}` ||
        !Number.isSafeInteger(track.sizeBytes) || track.sizeBytes < 1
      ) return false;
      ids.add(track.id);
    }
  }
  return true;
}

export async function getDashboard() {
  const c = config();
  const ref = await github<{ object: { sha: string } }>(`git/ref/heads/${c.branch.split('/').map(encodeURIComponent).join('/')}`);
  const headSha = ref.object.sha;
  const [mediaManifest, playlist] = await Promise.all([
    contents<MediaManifest>('media-manifest.json', headSha),
    contents<PlaylistManifest>('music/playlist.json', headSha),
  ]);
  const photos = mediaManifest ?? blankMedia();
  const music = playlist ?? blankPlaylist();
  if (!validManifest(photos)) throw new Error('The photo manifest is invalid. No changes were made.');
  if (!validPlaylist(music)) throw new Error('The music playlist manifest is invalid. No changes were made.');
  const timezone = process.env.MEDIA_TIMEZONE || 'Asia/Kolkata';
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    throw new Error('MEDIA_TIMEZONE is invalid. Use a valid IANA timezone.');
  }
  return {
    repository: `${config().owner}/${config().repository}`,
    branch: config().branch,
    headSha,
    mediaBaseUrl: publicMediaUrl(''),
    timezone,
    connected: true,
    mediaManifest: photos,
    playlist: music,
    photoCount: photos.photoBundles.reduce((sum, bundle) => sum + bundle.photoCount, 0),
    photoBytes: photos.photoBundles.reduce((sum, bundle) => sum + bundle.sizeBytes, 0),
    musicCount: music.humanMode.length + music.divineMode.length,
    bundleLimitBytes: Math.min(100, Math.max(1, Number(process.env.MEDIA_MAX_BUNDLE_SIZE_MB) || 100)) * 1024 * 1024,
  };
}

export async function getAllPhotos() {
  const dashboard = await getDashboard();
  const photos: Array<PhotoEntry & { bundleId: string; url: string }> = [];
  for (const summary of dashboard.mediaManifest.photoBundles) {
    const bundle = await getPhotoBundle(summary.id, dashboard.headSha);
    if (!bundle) throw new Error(`Photo bundle ${summary.id} is missing.`);
    for (const photo of bundle.photos) photos.push({ ...photo, bundleId: bundle.id, url: publicMediaUrl(photo.path) });
  }
  return photos;
}

export async function getPhotoBundle(id: string, ref?: string): Promise<PhotoBundleManifest | null> {
  if (!/^bundle-\d{3,}$/.test(id)) return null;
  const manifest = await contents<PhotoBundleManifest>(`photos/${id}/manifest.json`, ref);
  if (!manifest) return null;
  const photoIds = new Set<string>();
  const validPhotos = Array.isArray(manifest.photos) && manifest.photos.every((photo) => {
    if (
      !photo || typeof photo.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(photo.id) || photoIds.has(photo.id) ||
      typeof photo.filename !== 'string' || !/^[A-Za-z0-9_-]+\.webp$/i.test(photo.filename) ||
      photo.path !== `photos/${id}/${photo.filename}` ||
      !Number.isSafeInteger(photo.sizeBytes) || photo.sizeBytes < 1 ||
      !Number.isInteger(photo.width) || photo.width < 1 ||
      !Number.isInteger(photo.height) || photo.height < 1
    ) return false;
    photoIds.add(photo.id);
    return true;
  });
  if (
    manifest.id !== id || !validPhotos ||
    manifest.photoCount !== manifest.photos.length ||
    manifest.sizeBytes !== manifest.photos.reduce((sum, photo) => sum + photo.sizeBytes, 0)
  ) throw new Error(`Photo bundle ${id} metadata is invalid.`);
  return manifest;
}

export async function stageBlobBytes(path: string): Promise<Buffer> {
  if (!/^staging\/[A-Za-z0-9_-]{16,80}$/.test(path)) throw new Error('Staged upload reference is invalid.');
  const blob = await get(path, { access: 'private' });
  if (!blob?.stream) throw new Error('A staged upload expired or could not be found.');
  return Buffer.from(await new Response(blob.stream).arrayBuffer());
}

async function createBlob(content: TreeContent): Promise<string> {
  if (typeof content === 'object' && !Buffer.isBuffer(content)) {
    const bytes = await stageBlobBytes(content.stagingPath);
    if (bytes.length !== content.sizeBytes) throw new Error('A staged upload changed size before commit.');
    content = bytes;
  }
  const result = await github<{ sha: string }>('git/blobs', {
    method: 'POST',
    body: JSON.stringify({ content: typeof content === 'string' ? content : content.toString('base64'), encoding: typeof content === 'string' ? 'utf-8' : 'base64' }),
  });
  return result.sha;
}

export async function commitTree(
  files: Array<{ path: string; content: TreeContent }>,
  removals: string[],
  message: string,
  expectedHead?: string,
): Promise<void> {
  const c = config();
  const lockKey = `${c.owner}/${c.repository}:${c.branch}`;
  const previous = inFlightWrites.get(lockKey) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const refPath = `git/ref/heads/${c.branch.split('/').map(encodeURIComponent).join('/')}`;
    const ref = await github<{ object: { sha: string } }>(refPath);
    if (expectedHead && ref.object.sha !== expectedHead) {
      throw new Error('The repository changed during this update. Refresh and retry.');
    }
    const current = await github<{ sha: string; tree: { sha: string } }>(`git/commits/${ref.object.sha}`);
    const additions: TreeEntry[] = [];
    for (const file of files) additions.push({ path: file.path, mode: '100644', type: 'blob', sha: await createBlob(file.content) });
    const entries: TreeEntry[] = [
      ...additions,
      ...removals.map((path) => ({ path, mode: '100644' as const, type: 'blob' as const, sha: null })),
    ];
    const tree = await github<{ sha: string }>('git/trees', {
      method: 'POST',
      body: JSON.stringify({ base_tree: current.tree.sha, tree: entries }),
    });
    const commit = await github<{ sha: string }>('git/commits', {
      method: 'POST',
      body: JSON.stringify({ message, tree: tree.sha, parents: [current.sha] }),
    });
    await github(`git/refs/heads/${c.branch.split('/').map(encodeURIComponent).join('/')}`, {
      method: 'PATCH',
      body: JSON.stringify({ sha: commit.sha, force: false }),
    });
  });
  inFlightWrites.set(lockKey, next);
  try {
    await next;
  } finally {
    if (inFlightWrites.get(lockKey) === next) inFlightWrites.delete(lockKey);
  }
}

export async function validatePublishedState(
  media: MediaManifest,
  playlist: PlaylistManifest,
  headSha: string,
  plannedFiles: Map<string, TreeContent> = new Map(),
  plannedBundles: Map<string, PhotoBundleManifest> = new Map(),
): Promise<void> {
  if (!validManifest(media) || !validPlaylist(playlist)) throw new Error('Media manifest validation failed.');
  const commit = await github<{ tree: { sha: string } }>(`git/commits/${headSha}`);
  const tree = await github<{ truncated: boolean; tree: Array<{ path: string; type: string; size?: number }> }>(`git/trees/${commit.tree.sha}?recursive=1`);
  if (tree.truncated) throw new Error('The GitHub repository tree is too large to validate safely.');
  const sizes = new Map(tree.tree.filter((entry) => entry.type === 'blob').map((entry) => [entry.path, entry.size ?? -1]));

  const sizeOf = (path: string): number | undefined => {
    const planned = plannedFiles.get(path);
    if (planned !== undefined) {
      if (typeof planned === 'string') return Buffer.byteLength(planned);
      if (Buffer.isBuffer(planned)) return planned.length;
      return planned.sizeBytes;
    }
    return sizes.get(path);
  };
  if (sizeOf('media-manifest.json') === undefined || sizeOf('music/playlist.json') === undefined) {
    throw new Error('A required media manifest is missing from the repository update.');
  }

  const photoIds = new Set<string>();
  for (const summary of media.photoBundles) {
    const manifestPath = `photos/${summary.id}/manifest.json`;
    const bundle = plannedBundles.get(summary.id) ?? await getPhotoBundle(summary.id, headSha);
    if (
      !bundle || bundle.id !== summary.id ||
      bundle.photoCount !== summary.photoCount || bundle.sizeBytes !== summary.sizeBytes ||
      sizeOf(manifestPath) === undefined
    ) throw new Error(`Photo bundle ${summary.id} failed manifest validation.`);
    for (const photo of bundle.photos) {
      if (photoIds.has(photo.id)) throw new Error(`Photo ID ${photo.id} appears more than once.`);
      photoIds.add(photo.id);
      if (sizeOf(photo.path) !== photo.sizeBytes) throw new Error(`Photo ${photo.filename} is missing or has an invalid size.`);
    }
  }

  for (const track of [...playlist.humanMode, ...playlist.divineMode]) {
    if (sizeOf(track.path) !== track.sizeBytes) throw new Error(`Music track ${track.filename} is missing or has an invalid size.`);
  }
}

export async function deleteStaged(paths: string[]): Promise<void> {
  if (!paths.length) return;
  await del(paths);
}

export function publicMediaUrl(path: string): string {
  const c = config();
  return `https://raw.githubusercontent.com/${c.owner}/${c.repository}/${encodeURIComponent(c.branch)}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

export function newManifestVersion(version: number): { version: number; updatedAt: string } {
  return { version: version + 1, updatedAt: new Date().toISOString() };
}
