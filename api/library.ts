import { checkMutation, json, readSession, vercelHandler } from '../src/server/http.ts';
import {
  commitManagedChanges,
  deleteStagedMedia,
  isManagedPath,
  isValidPlaylist,
  listManagedFiles,
  managedMediaUrl,
  readStagedMedia,
} from '../src/server/repository-media.ts';

const PHOTO_ROOT = 'public/Photos/optimized';
const MUSIC_ROOT = 'public/music';
const IMAGE_EXTENSIONS = new Set(['.avif', '.bmp', '.gif', '.jpeg', '.jpg', '.png', '.webp']);
const AUDIO_EXTENSIONS = new Set(['.aac', '.flac', '.m4a', '.mp3', '.ogg', '.wav']);
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_COMMIT_ITEMS = 10;

type ManagedKind = 'photo' | 'music';
type UploadItem = { stagingPath?: unknown; filename?: unknown; kind?: unknown; playlist?: unknown };

function extension(path: string): string {
  return path.slice(path.lastIndexOf('.')).toLowerCase();
}

function safeFilename(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 180
    && value !== '.' && value !== '..'
    && !value.startsWith('.')
    && !/[\\/\u0000-\u001f\u007f]/.test(value)
    && value.trim() === value;
}

function allowedPath(path: string): boolean {
  const fileExtension = extension(path);
  if (path.startsWith(`${PHOTO_ROOT}/`)) return IMAGE_EXTENSIONS.has(fileExtension);
  if (path.startsWith(`${MUSIC_ROOT}/`)) {
    const playlist = path.slice(MUSIC_ROOT.length + 1).split('/')[0];
    return isValidPlaylist(playlist) && AUDIO_EXTENSIONS.has(fileExtension);
  }
  return false;
}

function validWebp(bytes: Buffer): boolean {
  return bytes.length > 12
    && bytes.toString('ascii', 0, 4) === 'RIFF'
    && bytes.toString('ascii', 8, 12) === 'WEBP';
}

function validAudio(bytes: Buffer, ext: string): boolean {
  if (ext === '.wav') return bytes.length > 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE';
  if (ext === '.ogg') return bytes.toString('ascii', 0, 4) === 'OggS';
  if (ext === '.flac') return bytes.toString('ascii', 0, 4) === 'fLaC';
  if (ext === '.m4a') return bytes.length > 12 && bytes.toString('ascii', 4, 8) === 'ftyp';
  if (ext === '.aac') return bytes.length > 2 && bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0;
  if (ext === '.mp3') return bytes.toString('ascii', 0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
  return false;
}

function asMediaFile(path: string, sizeBytes: number) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const isPhoto = path.startsWith(`${PHOTO_ROOT}/`);
  const playlist = isPhoto ? undefined : path.slice(MUSIC_ROOT.length + 1).split('/')[0];
  return {
    id: path,
    path,
    name,
    sizeBytes,
    url: managedMediaUrl(path),
    kind: isPhoto ? 'photo' as const : 'music' as const,
    playlist,
  };
}

async function handle(request: Request): Promise<Response> {
  const session = readSession(request);
  if (!session) return json({ error: 'Session expired. Please sign in again.' }, 401);

  if (request.method === 'GET') {
    try {
      const { headSha, files } = await listManagedFiles();
      const photos = files
        .filter((file) => file.path.startsWith(`${PHOTO_ROOT}/`) && IMAGE_EXTENSIONS.has(extension(file.path)))
        .map((file) => asMediaFile(file.path, file.size));
      const music = files
        .filter((file) => file.path.startsWith(`${MUSIC_ROOT}/`) && AUDIO_EXTENSIONS.has(extension(file.path)))
        .map((file) => asMediaFile(file.path, file.size));
      const owner = process.env.GITHUB_OWNER || 'prem143-sm';
      const repository = process.env.GITHUB_REPOSITORY || 'SamsBday';
      return json({ repository: `${owner}/${repository}`, branch: process.env.GITHUB_BRANCH || 'main', headSha, photos, music });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : 'Could not load repository media.' }, 502);
    }
  }

  if (request.method !== 'POST' && request.method !== 'DELETE') return json({ error: 'Method not allowed.' }, 405);
  const invalid = checkMutation(request, session);
  if (invalid) return invalid;

  if (request.method === 'DELETE') {
    const path = new URL(request.url).searchParams.get('path') ?? '';
    if (!isManagedPath(path) || !allowedPath(path)) return json({ error: 'Invalid media path.' }, 400);
    try {
      const current = await listManagedFiles();
      if (!current.files.some((file) => file.path === path)) return json({ error: 'Media file was not found.' }, 404);
      await commitManagedChanges(current.headSha, [], [path], `media: delete ${path.slice(path.lastIndexOf('/') + 1)}`);
      return json({ ok: true });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : 'Could not delete repository media.' }, 502);
    }
  }

  let body: { files?: UploadItem[] };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid media upload request.' }, 400);
  }
  if (!Array.isArray(body.files) || !body.files.length || body.files.length > MAX_COMMIT_ITEMS) {
    return json({ error: `Upload between 1 and ${MAX_COMMIT_ITEMS} files at a time.` }, 400);
  }

  const pending: Array<{ stagingPath: string; path: string; filename: string; kind: ManagedKind }> = [];
  const seenPaths = new Set<string>();
  let current: Awaited<ReturnType<typeof listManagedFiles>>;
  try {
    current = await listManagedFiles();
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Could not load repository files.' }, 502);
  }
  const existingPaths = new Set(current.files.map((file) => file.path));
  for (const file of body.files) {
    if (
      !file || typeof file !== 'object'
      || typeof file.stagingPath !== 'string' || !/^staging\/[A-Za-z0-9_-]{16,80}$/.test(file.stagingPath)
      || !safeFilename(file.filename)
      || (file.kind !== 'photo' && file.kind !== 'music')
    ) return json({ error: 'An upload contains invalid media metadata.' }, 400);

    const kind = file.kind as ManagedKind;
    let path: string;
    if (kind === 'photo') {
      if (extension(file.filename) !== '.webp') return json({ error: 'Photos must be converted to WebP before upload.' }, 415);
      path = `${PHOTO_ROOT}/${file.filename}`;
    } else {
      if (typeof file.playlist !== 'string' || !isValidPlaylist(file.playlist)) {
        return json({ error: 'Choose a valid music playlist.' }, 400);
      }
      if (!AUDIO_EXTENSIONS.has(extension(file.filename))) return json({ error: 'Unsupported music format.' }, 415);
      path = `${MUSIC_ROOT}/${file.playlist}/${file.filename}`;
    }
    if (existingPaths.has(path) || seenPaths.has(path)) {
      return json({ error: `${file.filename} already exists in the selected folder. Rename it and try again.` }, 409);
    }
    seenPaths.add(path);
    pending.push({ stagingPath: file.stagingPath, path, filename: file.filename, kind });
  }

  const stagedPaths = pending.map((item) => item.stagingPath);
  const additions: Array<{ stagingPath: string; path: string; size: number }> = [];
  try {
    for (const file of pending) {
      const bytes = await readStagedMedia(file.stagingPath);
      if (!bytes.length || bytes.length > MAX_FILE_BYTES) throw new Error('File must be between 1 byte and 100 MB.');
      if (file.kind === 'photo' && !validWebp(bytes)) throw new Error('Invalid WebP photo.');
      if (file.kind === 'music' && !validAudio(bytes, extension(file.filename))) {
        throw new Error(`Invalid audio file: ${file.filename}`);
      }
      additions.push({ stagingPath: file.stagingPath, path: file.path, size: bytes.length });
    }
    await commitManagedChanges(current.headSha, additions, [], `media: add ${additions.length} file${additions.length === 1 ? '' : 's'}`);
  } catch (error) {
    try {
      await deleteStagedMedia(stagedPaths);
    } catch {
      return json({ error: `${error instanceof Error ? error.message : 'Upload failed.'} Temporary upload cleanup also failed.` }, 502);
    }
    return json({ error: error instanceof Error ? error.message : 'Could not add repository media.' }, 502);
  }

  try {
    await deleteStagedMedia(stagedPaths);
  } catch {
    return json({ ok: true, warning: 'Media was committed, but temporary upload cleanup needs attention.' });
  }
  return json({ ok: true, added: additions.length });
}

export default vercelHandler(async (request) => {
  try {
    return await handle(request);
  } catch {
    return json({ error: 'Repository media request failed.' }, 500);
  }
});
