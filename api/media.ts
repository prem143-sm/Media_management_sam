import { del } from '@vercel/blob';
import { checkMutation, json, readSession, vercelHandler } from '../src/server/http.ts';
import {
  commitTree,
  deleteStaged,
  getDashboard,
  getAllPhotos,
  getPhotoBundle,
  newManifestVersion,
  publicMediaUrl,
  stageBlobBytes,
  validatePublishedState,
  type MediaManifest,
  type MusicTrack,
  type PhotoBundleManifest,
  type PhotoEntry,
  type PlaylistManifest,
  type StagedBlobReference,
  type TreeContent,
} from '../src/server/github.ts';
import { planPhotoBundles } from '../src/server/bundle-policy.mjs';

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac']);
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_COMMIT_ITEMS = 20;

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function apiError(error: unknown): Response {
  const message = error instanceof Error ? error.message : 'Media operation failed.';
  return json({ error: message }, 502);
}

function cleanBaseName(name: string): string {
  return name
    .replace(/\.[^.]+$/, '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70) || 'media';
}

function looksLikeWebp(bytes: Buffer): boolean {
  return bytes.length > 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
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

async function commitUploads(request: Request): Promise<Response> {
  const invalid = checkMutation(request, readSession(request)!);
  if (invalid) return invalid;
  let body: {
    files?: Array<{
      stagingPath?: unknown;
      filename?: unknown;
      kind?: unknown;
      category?: unknown;
      title?: unknown;
      width?: unknown;
      height?: unknown;
    }>;
  };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid upload request.' }, 400);
  }
  const files = body.files;
  if (!Array.isArray(files) || !files.length || files.length > MAX_COMMIT_ITEMS) {
    return json({ error: `Commit between 1 and ${MAX_COMMIT_ITEMS} files at a time.` }, 400);
  }

  const stagedPaths: string[] = [];
  const verified: Array<{
    path: string;
    sizeBytes: number;
    filename: string;
    kind: 'photo' | 'music';
    category: 'humanMode' | 'divineMode' | null;
    title: string;
    width: number;
    height: number;
  }> = [];
  for (const file of files) {
    if (
      !file || typeof file !== 'object' ||
      typeof file.stagingPath !== 'string' || !/^staging\/[A-Za-z0-9_-]{16,80}$/.test(file.stagingPath) ||
      typeof file.filename !== 'string' || file.filename.length > 180 ||
      (file.kind !== 'photo' && file.kind !== 'music')
    ) return json({ error: 'An upload contains invalid media metadata.' }, 400);
    if (file.kind === 'music' && file.category !== 'humanMode' && file.category !== 'divineMode') {
      return json({ error: 'Choose a valid music category.' }, 400);
    }
    if (file.kind === 'photo' && (typeof file.width !== 'number' || typeof file.height !== 'number' || file.width < 1 || file.height < 1)) {
      return json({ error: 'Photo dimensions are missing. Reprocess the image and retry.' }, 400);
    }
    stagedPaths.push(file.stagingPath);
    const bytes = await stageBlobBytes(file.stagingPath);
    if (!bytes.length || bytes.length > MAX_FILE_BYTES) return json({ error: 'The file exceeds GitHub’s individual file limit.' }, 413);
    const ext = file.filename.slice(file.filename.lastIndexOf('.')).toLowerCase();
    if (file.kind === 'photo' && (ext !== '.webp' || !looksLikeWebp(bytes))) {
      return json({ error: 'Photo processing failed: upload must be a valid WebP image.' }, 415);
    }
    if (file.kind === 'music' && (!AUDIO_EXTENSIONS.has(ext) || !validAudio(bytes, ext))) {
      return json({ error: 'Unsupported or invalid audio file.' }, 415);
    }
    verified.push({
      path: file.stagingPath,
      sizeBytes: bytes.length,
      filename: file.filename,
      kind: file.kind,
      category: file.kind === 'music' ? file.category as 'humanMode' | 'divineMode' : null,
      title: typeof file.title === 'string' && file.title.trim() ? file.title.trim().slice(0, 120) : cleanBaseName(file.filename),
      width: typeof file.width === 'number' ? Math.round(file.width) : 0,
      height: typeof file.height === 'number' ? Math.round(file.height) : 0,
    });
  }

  const initial = await getDashboard();
  const media: MediaManifest = initial.mediaManifest;
  const playlist: PlaylistManifest = initial.playlist;
  const photoManifests = new Map<string, PhotoBundleManifest>();
  const changes = new Map<string, TreeContent>();
  const photoAdds = verified.filter((file) => file.kind === 'photo');
  if (photoAdds.length) {
    for (const summary of media.photoBundles) {
      const current = await getPhotoBundle(summary.id, initial.headSha);
      if (!current || current.photoCount !== summary.photoCount || current.sizeBytes !== summary.sizeBytes) {
        return json({ error: `Photo bundle ${summary.id} is missing or inconsistent. No files were committed.` }, 409);
      }
      photoManifests.set(summary.id, current);
    }
  }

  const configuredLimit = Math.min(100, Math.max(1, Number(process.env.MEDIA_MAX_BUNDLE_SIZE_MB) || 100)) * 1024 * 1024;
  let assignments: string[] = [];
  if (photoAdds.length) {
    let plan: ReturnType<typeof planPhotoBundles>;
    try {
      plan = planPhotoBundles(media.photoBundles, photoAdds.map((file) => file.sizeBytes), configuredLimit);
    } catch {
      return json({ error: `A processed image exceeds the ${formatBytes(configuredLimit)} photo bundle limit.` }, 413);
    }
    media.photoBundles = plan.bundles;
    assignments = plan.assignments;
  }
  for (const [index, file] of photoAdds.entries()) {
    const bundleId = assignments[index];
    let manifest = photoManifests.get(bundleId);
    if (!manifest) {
      const now = new Date().toISOString();
      manifest = { id: bundleId, photoCount: 0, sizeBytes: 0, createdAt: now, updatedAt: now, photos: [] };
      photoManifests.set(bundleId, manifest);
    }
    const entryId = crypto.randomUUID();
    const filename = `${entryId}-${cleanBaseName(file.filename)}.webp`;
    const path = `photos/${manifest.id}/${filename}`;
    const entry: PhotoEntry = {
      id: entryId,
      filename,
      path,
      sizeBytes: file.sizeBytes,
      width: file.width,
      height: file.height,
      uploadedAt: new Date().toISOString(),
    };
    changes.set(path, { stagingPath: file.path, sizeBytes: file.sizeBytes } satisfies StagedBlobReference);
    manifest.photos.push(entry);
    manifest.photoCount = manifest.photos.length;
    manifest.sizeBytes += file.sizeBytes;
    manifest.updatedAt = entry.uploadedAt;
  }

  for (const [id, manifest] of photoManifests) {
    changes.set(`photos/${id}/manifest.json`, JSON.stringify(manifest, null, 2));
  }
  if (photoAdds.length) Object.assign(media, newManifestVersion(media.version));

  const musicAdds = verified.filter((file) => file.kind === 'music');
  for (const file of musicAdds) {
    const id = crypto.randomUUID();
    const ext = file.filename.slice(file.filename.lastIndexOf('.')).toLowerCase();
    const filename = `${id}-${cleanBaseName(file.filename)}${ext}`;
    const category = file.category!;
    const path = `music/${category === 'humanMode' ? 'human-mode' : 'divine-mode'}/${filename}`;
    const track: MusicTrack = {
      id,
      title: file.title,
      filename,
      path,
      sizeBytes: file.sizeBytes,
      uploadedAt: new Date().toISOString(),
    };
    playlist[category].push(track);
    changes.set(path, { stagingPath: file.path, sizeBytes: file.sizeBytes } satisfies StagedBlobReference);
  }
  if (musicAdds.length) Object.assign(playlist, newManifestVersion(playlist.version));

  if (musicAdds.length) changes.set('music/playlist.json', JSON.stringify(playlist, null, 2));
  if (verified.length) {
    changes.set('media-manifest.json', JSON.stringify(media, null, 2));
    changes.set('music/playlist.json', JSON.stringify(playlist, null, 2));
  }

  try {
    await validatePublishedState(media, playlist, initial.headSha, changes, photoManifests);
    await commitTree(
      Array.from(changes, ([path, content]) => ({ path, content })),
      [],
      `media: add ${photoAdds.length} photos and ${musicAdds.length} music tracks`,
      initial.headSha,
    );
  } catch (error) {
    return apiError(error);
  }

  let cleanupWarning: string | undefined;
  try {
    await deleteStaged(stagedPaths);
  } catch {
    cleanupWarning = 'Media was committed, but temporary upload cleanup needs attention.';
  }
  return json({
    ok: true,
    addedPhotos: photoAdds.length,
    addedMusic: musicAdds.length,
    photoBundles: media.photoBundles,
    cleanupWarning,
  });
}

async function deleteMedia(request: Request): Promise<Response> {
  const invalid = checkMutation(request, readSession(request)!);
  if (invalid) return invalid;
  const url = new URL(request.url);
  const kind = url.searchParams.get('kind');
  const id = url.searchParams.get('id');
  if (!id || id.length > 80) return json({ error: 'Invalid media item.' }, 400);

  try {
    if (kind === 'photo') {
      const initial = await getDashboard();
      const media = initial.mediaManifest;
      let found: { bundle: PhotoBundleManifest; photo: PhotoEntry } | null = null;
      for (const summary of media.photoBundles) {
        const bundle = await getPhotoBundle(summary.id, initial.headSha);
        const photo = bundle?.photos.find((entry) => entry.id === id);
        if (bundle && photo) { found = { bundle, photo }; break; }
      }
      if (!found) return json({ error: 'Photo was not found.' }, 404);
      found.bundle.photos = found.bundle.photos.filter((photo) => photo.id !== id);
      found.bundle.photoCount = found.bundle.photos.length;
      found.bundle.sizeBytes -= found.photo.sizeBytes;
      found.bundle.updatedAt = new Date().toISOString();
      const removals = [found.photo.path];
      const changes: Array<{ path: string; content: string }> = [];
      if (found.bundle.photoCount === 0) {
        media.photoBundles = media.photoBundles.filter((bundle) => bundle.id !== found.bundle.id);
        removals.push(`photos/${found.bundle.id}/manifest.json`);
      } else {
        changes.push({ path: `photos/${found.bundle.id}/manifest.json`, content: JSON.stringify(found.bundle, null, 2) });
      }
      Object.assign(media, newManifestVersion(media.version));
      changes.push({ path: 'media-manifest.json', content: JSON.stringify(media, null, 2) });
      changes.push({ path: 'music/playlist.json', content: JSON.stringify(initial.playlist, null, 2) });
      await validatePublishedState(media, initial.playlist, initial.headSha, new Map(changes.map((item) => [item.path, item.content])), new Map(found.bundle.photoCount ? [[found.bundle.id, found.bundle]] : []));
      await commitTree(changes, removals, 'media: remove photo', initial.headSha);
      return json({ ok: true });
    }

    if (kind === 'music') {
      const initial = await getDashboard();
      const media = initial.mediaManifest;
      const playlist = initial.playlist;
      const category = url.searchParams.get('category');
      const categoryKey = category === 'humanMode' || category === 'divineMode' ? category : null;
      const track = categoryKey ? playlist[categoryKey].find((item) => item.id === id) : null;
      if (!track || !categoryKey) return json({ error: 'Music track was not found.' }, 404);
      playlist[categoryKey] = playlist[categoryKey].filter((item) => item.id !== id);
      Object.assign(playlist, newManifestVersion(playlist.version));
      const files = [
        { path: 'music/playlist.json', content: JSON.stringify(playlist, null, 2) },
        { path: 'media-manifest.json', content: JSON.stringify(media, null, 2) },
      ];
      await validatePublishedState(media, playlist, initial.headSha, new Map(files.map((item) => [item.path, item.content])));
      await commitTree(
        files,
        [track.path],
        'media: remove music track',
        initial.headSha,
      );
      return json({ ok: true });
    }

    if (kind === 'staging') {
      if (!/^staging\/[A-Za-z0-9_-]{16,80}$/.test(id)) return json({ error: 'Invalid temporary upload.' }, 400);
      await del(id);
      return json({ ok: true });
    }
    return json({ error: 'Invalid media type.' }, 400);
  } catch (error) {
    return apiError(error);
  }
}

async function handle(request: Request): Promise<Response> {
  const session = readSession(request);
  if (!session) return json({ error: 'Session expired. Please sign in again.' }, 401);

  if (request.method === 'GET') {
    const url = new URL(request.url);
    try {
      if (url.searchParams.get('view') === 'photos') {
        return json({ photos: await getAllPhotos() });
      }
      const dashboard = await getDashboard();
      const bundleId = url.searchParams.get('bundle');
      if (bundleId) {
        const bundle = await getPhotoBundle(bundleId);
        if (!bundle) return json({ error: 'Photo bundle was not found.' }, 404);
        return json({ bundle: { ...bundle, photos: bundle.photos.map((photo) => ({ ...photo, url: publicMediaUrl(photo.path) })) } });
      }
      return json(dashboard);
    } catch (error) {
      return apiError(error);
    }
  }

  if (request.method === 'POST') return commitUploads(request);
  if (request.method === 'DELETE') return deleteMedia(request);
  return json({ error: 'Method not allowed.' }, 405);
}

export default vercelHandler(async (request) => {
  try {
    return await handle(request);
  } catch (error) {
    return apiError(error);
  }
});
