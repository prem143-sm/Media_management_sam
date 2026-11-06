import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { upload } from '@vercel/blob/client';
import { api, formatBytes, setCsrfToken, type Session } from './lib/api';

type Section = 'overview' | 'photos' | 'music';
type MediaFile = {
  id: string;
  path: string;
  name: string;
  sizeBytes: number;
  url: string;
  kind: 'photo' | 'music';
  playlist?: string;
};
type Library = {
  repository: string;
  branch: string;
  headSha: string;
  photos: MediaFile[];
  music: MediaFile[];
};
type StagedUpload = {
  stagingPath: string;
  filename: string;
  kind: 'photo' | 'music';
  playlist?: string;
};

const playlists = ['Sams-Playlist', 'Prems-Playlist'];
const photoAccept = 'image/*';
const audioAccept = '.mp3,.wav,.m4a,.ogg,.flac,.aac';

function randomKey(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

function isImageFile(file: File): boolean {
  return file.type.startsWith('image/')
    || /\.(avif|bmp|gif|jpe?g|png|tiff?|webp)$/i.test(file.name);
}

function photoSlug(name: string): string {
  return name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'photo';
}

async function convertPhoto(file: File): Promise<File> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error(`${file.name}: this image format is not supported by this browser.`);
  }
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not prepare the image for WebP conversion.');
    context.drawImage(bitmap, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => result ? resolve(result) : reject(new Error('WebP conversion failed.')), 'image/webp', 0.84);
    });
    return new File([blob], `${photoSlug(file.name)}.webp`, { type: 'image/webp' });
  } finally {
    bitmap.close();
  }
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [username, setUsername] = useState('');
  const [section, setSection] = useState<Section>('overview');
  const [library, setLibrary] = useState<Library | null>(null);
  const [search, setSearch] = useState('');
  const [selectedPhoto, setSelectedPhoto] = useState<MediaFile | null>(null);
  const [playlist, setPlaylist] = useState(playlists[1]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [queue, setQueue] = useState<string[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setLibrary(await api<Library>('/api/library'));
      setError('');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const expire = () => {
      setCsrfToken('');
      setLibrary(null);
      setSession({ authenticated: false });
      setError('Session expired. Please sign in again.');
    };
    window.addEventListener('media-session-expired', expire);
    return () => window.removeEventListener('media-session-expired', expire);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const current = await api<Session>('/api/auth');
        setCsrfToken(current.csrf ?? '');
        setSession(current);
        if (current.authenticated) {
          try {
            await refresh();
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : 'Could not load repository media.');
          }
        }
      } catch (reason) {
        setSession({ authenticated: false });
        setError(reason instanceof Error ? reason.message : 'Could not verify session.');
      }
    })();
  }, [refresh]);

  const login = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const current = await api<Session>('/api/auth', { method: 'POST', body: JSON.stringify({ username }) });
      setCsrfToken(current.csrf ?? '');
      setSession(current);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    try {
      await api('/api/auth', { method: 'DELETE' });
    } catch {
      // The session cookie may already have expired.
    }
    setCsrfToken('');
    setLibrary(null);
    setSession({ authenticated: false });
    setSection('overview');
  };

  const chooseFiles = async (selected: FileList | null) => {
    if (!selected?.length) return;
    const files = Array.from(selected);
    if (files.length > 10) {
      setError('Upload up to 10 files at a time.');
      return;
    }
    setBusy(true);
    setError('');
    setMessage('');
    setQueue(files.map((file) => file.name));
    const staged: StagedUpload[] = [];
    try {
      for (const [index, source] of files.entries()) {
        let file = source;
        if (section === 'photos') {
          if (!isImageFile(source)) throw new Error(`${source.name}: choose a supported image file.`);
          if (!source.size || source.size > 100 * 1024 * 1024) throw new Error(`${source.name}: files must be between 1 byte and 100 MB.`);
          const converted = await convertPhoto(source);
          file = new File([converted], `${Date.now()}-${index}-${converted.name}`, { type: converted.type });
        } else if (!/\.(mp3|wav|m4a|ogg|flac|aac)$/i.test(source.name)) {
          throw new Error(`${source.name}: choose a supported audio file.`);
        }
        if (section === 'music' && (!file.size || file.size > 100 * 1024 * 1024)) {
          throw new Error(`${source.name}: files must be between 1 byte and 100 MB.`);
        }
        const stagingPath = `staging/${randomKey()}`;
        await upload(stagingPath, file, {
          access: 'private',
          contentType: file.type || 'application/octet-stream',
          handleUploadUrl: '/api/upload-token',
          headers: { 'x-csrf-token': session?.csrf ?? '' },
          multipart: file.size > 5 * 1024 * 1024,
        });
        staged.push({
          stagingPath,
          filename: file.name,
          kind: section === 'photos' ? 'photo' : 'music',
          playlist: section === 'music' ? playlist : undefined,
        });
      }
      const result = await api<{ added: number; warning?: string }>('/api/library', {
        method: 'POST',
        body: JSON.stringify({ files: staged }),
      });
      setMessage(`${result.added} file${result.added === 1 ? '' : 's'} added to SamsBday.${result.warning ? ` ${result.warning}` : ''}`);
      setQueue([]);
      await refresh();
    } catch (reason) {
      const text = reason instanceof Error ? reason.message : 'Upload failed.';
      setError(text.includes('Failed to retrieve the client token')
        ? 'Upload storage could not issue a token. Check BLOB_READ_WRITE_TOKEN and the upload-token function configuration in Vercel.'
        : text);
      setQueue([]);
      await Promise.allSettled(staged.map((item) =>
        api(`/api/media?kind=staging&id=${encodeURIComponent(item.stagingPath)}`, { method: 'DELETE' }),
      ));
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const deleteFile = async (file: MediaFile) => {
    if (!window.confirm(`Permanently delete ${file.name} from SamsBday?`)) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await api(`/api/library?path=${encodeURIComponent(file.path)}`, { method: 'DELETE' });
      setMessage(`${file.name} deleted from SamsBday.`);
      if (selectedPhoto?.id === file.id) setSelectedPhoto(null);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not delete the file.');
    } finally {
      setBusy(false);
    }
  };

  const visiblePhotos = useMemo(() => (library?.photos ?? []).filter((file) =>
    file.name.toLowerCase().includes(search.trim().toLowerCase()),
  ), [library, search]);
  const visibleMusic = useMemo(() => (library?.music ?? []).filter((file) =>
    file.name.toLowerCase().includes(search.trim().toLowerCase()),
  ), [library, search]);

  if (session === null) return <div className="boot-screen"><div className="brand-mark">M</div><span>Opening your vault…</span></div>;
  if (!session.authenticated) {
    return (
      <main className="login-shell">
        <div className="login-ambient ambient-one" /><div className="login-ambient ambient-two" />
        <section className="login-card">
          <div className="brand-mark">M</div>
          <div className="eyebrow">SAMSBDAY REPOSITORY</div>
          <h1>Welcome to your<br /><span>Media Vault</span></h1>
          <p className="muted">Manage photos and music on your website.</p>
          {error && <div className="notice error-notice" role="alert">{error}</div>}
          <form onSubmit={login} className="login-form">
            <label>User ID<input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required /></label>
            <button className="primary-button wide-button" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'} <span>→</span></button>
          </form>
          <div className="login-foot"><span className="status-dot" /> Encrypted session · Admin access only</div>
        </section>
      </main>
    );
  }

  const photos = library?.photos ?? [];
  const music = library?.music ?? [];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#" onClick={(event) => { event.preventDefault(); setSection('overview'); setSearch(''); }}>
          <span className="brand-mark small-mark">M</span><span>media<span className="brand-light">vault</span><small>SAMSBDAY LIBRARY</small></span>
        </a>
        <div className="side-label">WORKSPACE</div>
        <nav>
          {([
            ['overview', '◈', 'Overview'],
            ['photos', '▧', 'Photos'],
            ['music', '♫', 'Music'],
          ] as const).map(([id, icon, label]) => (
            <button key={id} className={`nav-item ${section === id ? 'active' : ''}`} onClick={() => { setSection(id); setSearch(''); }}>
              <span className="nav-icon">{icon}</span>{label}
              {id === 'photos' && photos.length > 0 && <span className="nav-count">{photos.length}</span>}
              {id === 'music' && music.length > 0 && <span className="nav-count">{music.length}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="repo-mini"><span className="status-dot" /><div><strong>Repository</strong><small>{library?.repository ?? 'Loading…'}</small></div></div>
          <button className="user-button" onClick={() => void logout()}><span className="user-avatar">{session.username?.slice(0, 1).toUpperCase()}</span><span><strong>{session.username}</strong><small>Administrator</small></span><span className="logout-icon">↗</span></button>
        </div>
      </aside>

      <main className="main-panel">
        <input
          ref={fileInput}
          className="hidden-file-input"
          aria-hidden="true"
          tabIndex={-1}
          type="file"
          accept={section === 'music' ? audioAccept : photoAccept}
          multiple
          disabled={busy}
          onChange={(event) => void chooseFiles(event.target.files)}
        />
        <header className="topbar">
          <div className="breadcrumbs"><span>SamsBday</span><i>/</i><strong>{section}</strong></div>
          <div className="topbar-right">
            <a className="connection" href="https://github.com/prem143-sm/SamsBday" target="_blank" rel="noreferrer"><span className="status-dot" /> GitHub connected ↗</a>
            <button className="icon-button mobile-logout" aria-label="Sign out" onClick={() => void logout()}>↗</button>
            <span className="header-avatar">{session.username?.slice(0, 1).toUpperCase()}</span>
          </div>
        </header>

        <div className="content">
          {error && <div className="notice error-notice" role="alert">{error}<button onClick={() => setError('')} aria-label="Dismiss error">×</button></div>}
          {message && <div className="notice success-notice" role="status">{message}<button onClick={() => setMessage('')} aria-label="Dismiss message">×</button></div>}
          {queue.length > 0 && <div className="notice upload-notice" role="status">Uploading {queue.length} file{queue.length === 1 ? '' : 's'}… {queue[0]}</div>}

          {section === 'overview' && (
            <>
              <div className="page-heading">
                <div><div className="eyebrow">SAMSBDAY · MAIN</div><h1>Your media library</h1><p>Manage the files published by the birthday website.</p></div>
                <button className="secondary-button" disabled={loading || busy} onClick={() => void refresh()}>↻ Refresh</button>
              </div>
              <div className="stats-grid">
                <StatCard icon="▧" label="Photos" value={photos.length} detail="public/Photos/optimized" accent="lavender" />
                <StatCard icon="♫" label="Music tracks" value={music.length} detail="public/music" accent="mint" />
                <StatCard icon="◒" label="Photo storage" value={formatBytes(photos.reduce((sum, file) => sum + file.sizeBytes, 0))} detail="Stored in GitHub" accent="blue" />
                <StatCard icon="◈" label="Branch" value={library?.branch ?? 'main'} detail="Changes commit directly to GitHub" accent="peach" />
              </div>
              <div className="dashboard-columns">
                <section className="panel-card library-summary-card">
                  <div className="section-title"><div><h2>Photos</h2><p>{photos.length} optimized images</p></div><button className="text-button" onClick={() => setSection('photos')}>Manage photos →</button></div>
                  <div className="summary-preview">{photos.slice(0, 5).map((photo) => <button key={photo.id} onClick={() => setSelectedPhoto(photo)} aria-label={`View ${photo.name}`}><img src={photo.url} alt="" loading="lazy" /></button>)}</div>
                </section>
                <section className="panel-card library-summary-card">
                  <div className="section-title"><div><h2>Music</h2><p>{music.length} tracks in the website playlists</p></div><button className="text-button" onClick={() => setSection('music')}>Manage music →</button></div>
                  <div className="playlist-counts">{playlists.map((name) => <div key={name}><span>♫</span><strong>{name.replace('-', ' ')}</strong><small>{music.filter((track) => track.playlist === name).length} tracks</small></div>)}</div>
                </section>
              </div>
            </>
          )}

          {(section === 'photos' || section === 'music') && (
            <>
              <div className="page-heading">
                <div><div className="eyebrow">{section === 'photos' ? 'PHOTO LIBRARY' : 'AUDIO LIBRARY'}</div><h1>{section === 'photos' ? 'Photos' : 'Music'}</h1>
                  <p>{section === 'photos' ? 'Files in public/Photos/optimized' : 'Tracks in public/music and its playlist folders'}</p></div>
                {section === 'music' && <label className="playlist-select">Upload to<select value={playlist} onChange={(event) => setPlaylist(event.target.value)}>{playlists.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>}
                <button className="primary-button upload-button" disabled={busy || loading} onClick={() => fileInput.current?.click()}>{busy ? 'Working…' : section === 'photos' ? '＋ Add photos' : '＋ Add music'}</button>
              </div>
              <div className="library-toolbar">
                <div className="search-box"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={`Search ${section} by filename…`} /></div>
                <span className="toolbar-count">{section === 'photos' ? visiblePhotos.length : visibleMusic.length} files</span>
              </div>
              {loading ? <div className="empty-state"><strong>Loading repository files…</strong></div> : section === 'photos' ? (
                visiblePhotos.length
                  ? <div className="photo-grid library-photo-grid">{visiblePhotos.map((photo) => (
                    <article className="managed-photo" key={photo.id}>
                      <button className="managed-photo-preview" onClick={() => setSelectedPhoto(photo)}><img src={photo.url} alt={photo.name} loading="lazy" /></button>
                      <div className="managed-file-info"><span title={photo.name}>{photo.name}</span><small>{formatBytes(photo.sizeBytes)}</small><button className="danger-button" disabled={busy} onClick={() => void deleteFile(photo)}>Delete</button></div>
                    </article>
                  ))}</div>
                  : <EmptyState title={search ? 'No photos match' : 'No photos yet'} detail={search ? 'Try another filename.' : 'Add photos to publish them in public/Photos/optimized.'} />
              ) : visibleMusic.length ? (
                <div className="managed-music-list">{visibleMusic.map((track) => (
                  <article className="managed-track" key={track.id}>
                    <span className="track-play">♫</span>
                    <div className="track-main"><strong title={track.name}>{track.name}</strong><small>{track.playlist} · {formatBytes(track.sizeBytes)}</small></div>
                    <audio controls preload="none" src={track.url} aria-label={`Play ${track.name}`} />
                    <a className="text-button track-open" href={track.url} target="_blank" rel="noreferrer">View</a>
                    <button className="danger-button" disabled={busy} onClick={() => void deleteFile(track)}>Delete</button>
                  </article>
                ))}</div>
              ) : <EmptyState title={search ? 'No music matches' : 'No music yet'} detail={search ? 'Try another filename.' : 'Add tracks to a SamsBday music playlist.'} />}
            </>
          )}
          <footer className="footer"><span>Media Vault <i>·</i> Connected to prem143-sm/SamsBday</span><span>Changes commit directly to main</span></footer>
        </div>
      </main>

      {selectedPhoto && (
        <div className="modal-backdrop" onClick={() => setSelectedPhoto(null)}>
          <section className="photo-modal" onClick={(event) => event.stopPropagation()}>
            <button className="modal-close" onClick={() => setSelectedPhoto(null)} aria-label="Close preview">×</button>
            <img src={selectedPhoto.url} alt={selectedPhoto.name} />
            <div className="photo-details"><div><div className="eyebrow">PHOTO PREVIEW</div><h2>{selectedPhoto.name}</h2><p>{formatBytes(selectedPhoto.sizeBytes)} · {selectedPhoto.path}</p></div><button className="danger-button" disabled={busy} onClick={() => void deleteFile(selectedPhoto)}>Delete photo</button></div>
          </section>
        </div>
      )}
    </div>
  );
}

function StatCard({ icon, label, value, detail, accent }: { icon: string; label: string; value: string | number; detail: string; accent: string }) {
  return <article className="stat-card"><div className={`stat-icon ${accent}`}>{icon}</div><div className="stat-label">{label}</div><strong className="stat-value">{value}</strong><small>{detail}</small></article>;
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="empty-state"><span className="empty-icon">✧</span><strong>{title}</strong><p>{detail}</p></div>;
}
