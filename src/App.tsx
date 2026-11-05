import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { upload } from '@vercel/blob/client';
import { api, formatBytes, formatDate, setCsrfToken, type BundleSummary, type Dashboard, type Photo, type Session, type Track } from './lib/api';

type Section = 'overview' | 'photos' | 'music' | 'bundles' | 'settings';
type QueueItem = { name: string; state: 'Waiting' | 'Processing' | 'Uploading' | 'Committed' | 'Failed'; progress?: number; error?: string };
type StagedFile = {
  stagingPath: string;
  filename: string;
  kind: 'photo' | 'music';
  category?: 'humanMode' | 'divineMode';
  title?: string;
  width?: number;
  height?: number;
};
type Activity = { id: string; message: string; time: string };

const navigation: Array<{ id: Section; label: string; icon: string }> = [
  { id: 'overview', label: 'Overview', icon: '◈' },
  { id: 'photos', label: 'Photos', icon: '▧' },
  { id: 'music', label: 'Music', icon: '♫' },
  { id: 'bundles', label: 'Bundles', icon: '▤' },
  { id: 'settings', label: 'Settings', icon: '⚙' },
];
const photoAccept = '.jpg,.jpeg,.png,.webp,.gif';
const audioAccept = '.mp3,.wav,.m4a,.ogg,.flac,.aac';

function randomKey(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

function fileSlug(name: string): string {
  return name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'media';
}

async function convertPhoto(file: File): Promise<{ file: File; width: number; height: number }> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error(`${file.name}: this image format is not supported by this browser. HEIC/HEIF files must be converted before upload.`);
  }
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not prepare the image for WebP conversion.');
    context.drawImage(bitmap, 0, 0);
    const converted = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('WebP conversion failed.')), 'image/webp', 0.84);
    });
    return {
      file: new File([converted], `${fileSlug(file.name)}.webp`, { type: 'image/webp', lastModified: Date.now() }),
      width: bitmap.width,
      height: bitmap.height,
    };
  } finally {
    bitmap.close();
  }
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loginLoading, setLoginLoading] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [section, setSection] = useState<Section>('overview');
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [bundle, setBundle] = useState<{ id: string; photoCount: number; sizeBytes: number; photos: Photo[] } | null>(null);
  const [allPhotos, setAllPhotos] = useState<Photo[]>([]);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [category, setCategory] = useState<'humanMode' | 'divineMode'>('humanMode');
  const [selectedPhoto, setSelectedPhoto] = useState<Photo | null>(null);
  const [activity, setActivity] = useState<Activity[]>(() => {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem('media-manager-activity') || '[]');
      return Array.isArray(stored) ? stored as Activity[] : [];
    } catch { return []; }
  });
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const expire = () => {
      setCsrfToken('');
      setSession({ authenticated: false });
      setDashboard(null);
      setBundle(null);
      setError('Session expired. Please sign in again.');
    };
    window.addEventListener('media-session-expired', expire);
    return () => window.removeEventListener('media-session-expired', expire);
  }, []);

  const refresh = useCallback(async () => {
    const data = await api<Dashboard>('/api/media');
    setDashboard(data);
    setError('');
  }, []);

  const checkSession = useCallback(async () => {
    try {
      const current = await api<Session>('/api/auth');
      setCsrfToken(current.csrf ?? '');
      setSession(current);
      if (current.authenticated) {
        try { await refresh(); } catch (reason) {
          setError(reason instanceof Error ? reason.message : 'Could not load the repository.');
        }
      }
    } catch (reason) {
      setSession({ authenticated: false });
      setError(reason instanceof Error ? reason.message : 'Could not verify session.');
    }
  }, [refresh]);

  useEffect(() => { void checkSession(); }, [checkSession]);

  useEffect(() => {
    if (section !== 'photos' || bundle || !session?.authenticated) return;
    let active = true;
    api<{ photos: Photo[] }>('/api/media?view=photos')
      .then((result) => { if (active) setAllPhotos(result.photos); })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : 'Could not load photos.'); });
    return () => { active = false; };
  }, [section, bundle, session?.authenticated, dashboard?.mediaManifest.version]);

  const recordActivity = (text: string) => {
    const next = [{ id: randomKey(), message: text, time: new Date().toISOString() }, ...activity].slice(0, 12);
    setActivity(next);
    try { localStorage.setItem('media-manager-activity', JSON.stringify(next)); } catch { /* Activity history is optional. */ }
  };

  const login = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoginLoading(true);
    setError('');
    try {
      const result = await api<Session>('/api/auth', { method: 'POST', body: JSON.stringify({ username, password }) });
      setCsrfToken(result.csrf ?? '');
      setSession(result);
      setPassword('');
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Sign-in failed.');
    } finally {
      setLoginLoading(false);
    }
  };

  const logout = async () => {
    try { await api('/api/auth', { method: 'DELETE' }); } catch { /* The cookie may already have expired. */ }
    setCsrfToken('');
    setDashboard(null);
    setBundle(null);
    setSession({ authenticated: false });
    setSection('overview');
  };

  const openBundle = async (item: BundleSummary) => {
    setBusy(true);
    setError('');
    try {
      const result = await api<{ bundle: { id: string; photoCount: number; sizeBytes: number; photos: Photo[] } }>(`/api/media?bundle=${encodeURIComponent(item.id)}`);
      setBundle(result.bundle);
      setSection('photos');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not load bundle.');
    } finally {
      setBusy(false);
    }
  };

  const chooseFiles = async (files: FileList | null, kind: 'photo' | 'music') => {
    if (!files?.length) return;
    const list = Array.from(files);
    const nextQueue = list.map((file) => ({ name: file.name, state: 'Waiting' as const }));
    setQueue(nextQueue);
    setBusy(true);
    setError('');
    setMessage('');
    const staged: StagedFile[] = [];
    let committedFileCount = 0;
    try {
      for (let index = 0; index < list.length; index++) {
        const source = list[index];
        setQueue((items) => items.map((item, i) => i === index ? { ...item, state: 'Processing' } : item));
        if (kind === 'photo' && !/\.(jpe?g|png|webp|gif)$/i.test(source.name)) {
          throw new Error(`${source.name}: choose a JPG, PNG, WebP or GIF image.`);
        }
        if (kind === 'music' && !/\.(mp3|wav|m4a|ogg|flac|aac)$/i.test(source.name)) {
          throw new Error(`${source.name}: this audio format is not supported.`);
        }
        const converted = kind === 'photo' ? await convertPhoto(source) : { file: source, width: 0, height: 0 };
        if (converted.file.size > 100 * 1024 * 1024) {
          throw new Error(`${source.name}: the processed file exceeds GitHub's 100 MB per-file limit.`);
        }
        if (kind === 'music' && !converted.file.size) throw new Error(`${source.name}: the selected file is empty.`);
        setQueue((items) => items.map((item, i) => i === index ? { ...item, state: 'Uploading' } : item));
        const stagingPath = `staging/${randomKey()}`;
        await upload(stagingPath, converted.file, {
          access: 'private',
          contentType: converted.file.type || 'application/octet-stream',
          handleUploadUrl: '/api/upload-token',
          headers: { 'x-csrf-token': session?.csrf ?? '' },
          multipart: converted.file.size > 5 * 1024 * 1024,
          onUploadProgress: ({ percentage }) => setQueue((items) => items.map((item, i) => i === index ? { ...item, state: 'Uploading', progress: percentage } : item)),
        });
        staged.push({
          stagingPath,
          filename: converted.file.name,
          kind,
          category: kind === 'music' ? category : undefined,
          title: kind === 'music' ? source.name.replace(/\.[^.]+$/, '') : undefined,
          width: converted.width,
          height: converted.height,
        });
      }

      for (let offset = 0; offset < staged.length; offset += 20) {
        await api('/api/media', { method: 'POST', body: JSON.stringify({ files: staged.slice(offset, offset + 20) }) });
        committedFileCount = Math.min(staged.length, offset + 20);
        setQueue((items) => items.map((item, index) => index >= offset && index < offset + 20 ? { ...item, state: 'Committed' } : item));
      }
      const photosAdded = kind === 'photo' ? staged.length : 0;
      const musicAdded = kind === 'music' ? staged.length : 0;
      const description = photosAdded ? `Added ${photosAdded} photo${photosAdded === 1 ? '' : 's'}` : `Added ${musicAdded} music track${musicAdded === 1 ? '' : 's'}`;
      setMessage(`${description} to the repository.`);
      recordActivity(description);
      setBundle(null);
      await refresh();
    } catch (reason) {
      const text = reason instanceof Error ? reason.message : 'Upload failed.';
      setError(text);
      setQueue((items) => items.map((item) => item.state === 'Committed' ? item : { ...item, state: 'Failed', error: text }));
      const failedPaths = staged.slice(committedFileCount).map((item) => item.stagingPath);
      await Promise.allSettled(failedPaths.map((path) => api(`/api/media?kind=staging&id=${encodeURIComponent(path)}`, { method: 'DELETE' })));
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const deleteItem = async (kind: 'photo' | 'music', item: Photo | Track, trackCategory?: 'humanMode' | 'divineMode') => {
    if (!window.confirm(`Are you sure?\n\nThis will permanently remove ${item.filename} from the repository.`)) return;
    setBusy(true);
    setError('');
    try {
      const query = new URLSearchParams({ kind, id: item.id });
      if (trackCategory) query.set('category', trackCategory);
      await api(`/api/media?${query}`, { method: 'DELETE' });
      setMessage('Media deleted and repository manifests updated.');
      recordActivity(`Deleted ${item.filename}`);
      if (kind === 'photo' && bundle) {
        setBundle({ ...bundle, photos: bundle.photos.filter((photo) => photo.id !== item.id), photoCount: bundle.photoCount - 1, sizeBytes: bundle.sizeBytes - item.sizeBytes });
      }
      if (selectedPhoto?.id === item.id) setSelectedPhoto(null);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Delete failed.');
    } finally {
      setBusy(false);
    }
  };

  const visibleTracks = useMemo(() => {
    if (!dashboard) return [];
    const query = search.trim().toLowerCase();
    return (['humanMode', 'divineMode'] as const).flatMap((key) =>
      dashboard.playlist[key]
        .filter((track) => !query || `${track.title} ${track.filename}`.toLowerCase().includes(query))
        .map((track) => ({ track, category: key })),
    );
  }, [dashboard, search]);

  if (session === null) return <div className="boot-screen"><div className="brand-mark">M</div><span>Opening your vault…</span></div>;
  if (!session.authenticated) {
    return (
      <main className="login-shell">
        <div className="login-ambient ambient-one" /><div className="login-ambient ambient-two" />
        <section className="login-card">
          <div className="brand-mark">M</div>
          <div className="eyebrow">PRIVATE REPOSITORY</div>
          <h1>Welcome to your<br /><span>Media Vault</span></h1>
          <p className="muted">A private space for the moments worth keeping.</p>
          {error && <div className="notice error-notice" role="alert">{error}</div>}
          <form onSubmit={login} className="login-form">
            <label>Username<input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required /></label>
            <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
            <button className="primary-button wide-button" disabled={loginLoading}>{loginLoading ? 'Signing in…' : 'Sign in'} <span>→</span></button>
          </form>
          <div className="login-foot"><span className="status-dot" /> Encrypted session · Admin access only</div>
        </section>
      </main>
    );
  }

  const photoBundles = dashboard?.mediaManifest.photoBundles ?? [];
  const currentBundle = bundle ? photoBundles.find((item) => item.id === bundle.id) : null;
  const photosToDisplay = (bundle ? bundle.photos : allPhotos).filter((photo) => !search.trim() || photo.filename.toLowerCase().includes(search.trim().toLowerCase()));

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#" onClick={(event) => { event.preventDefault(); setSection('overview'); setBundle(null); }}>
          <span className="brand-mark small-mark">M</span><span>media<span className="brand-light">vault</span><small>PRIVATE LIBRARY</small></span>
        </a>
        <div className="side-label">WORKSPACE</div>
        <nav>{navigation.map((item) => (
          <button key={item.id} className={`nav-item ${section === item.id ? 'active' : ''}`} onClick={() => { setSection(item.id); setBundle(null); setSearch(''); }}>
            <span className="nav-icon">{item.icon}</span>{item.label}
            {item.id === 'photos' && photoBundles.length > 0 && <span className="nav-count">{photoBundles.length}</span>}
          </button>
        ))}</nav>
        <div className="sidebar-bottom">
          <div className="repo-mini"><span className={`status-dot ${dashboard?.connected ? '' : 'disconnected'}`} /><div><strong>Repository</strong><small>{dashboard?.repository ?? (error ? 'Connection unavailable' : 'Connecting…')}</small></div></div>
          <button className="user-button" onClick={logout}><span className="user-avatar">{session.username?.slice(0, 1).toUpperCase()}</span><span><strong>{session.username}</strong><small>Administrator</small></span><span className="logout-icon">↗</span></button>
        </div>
      </aside>

      <main className="main-panel">
        <input ref={fileInput} className="hidden-file-input" aria-hidden="true" tabIndex={-1} type="file" accept={section === 'music' ? audioAccept : photoAccept} multiple disabled={busy} onChange={(event) => void chooseFiles(event.target.files, section === 'music' ? 'music' : 'photo')} />
        <header className="topbar">
          <div className="breadcrumbs"><span>Workspace</span><i>/</i><strong>{bundle ? bundle.id : navigation.find((item) => item.id === section)?.label}</strong></div>
          <div className="topbar-right">
            <div className={`connection ${dashboard?.connected ? '' : 'disconnected'}`}><span className="status-dot" /> {dashboard?.connected ? 'GitHub connected' : 'GitHub unavailable'}</div>
            <button className="icon-button mobile-logout" aria-label="Sign out" onClick={logout}>↗</button>
            <span className="header-avatar">{session.username?.slice(0, 1).toUpperCase()}</span>
          </div>
        </header>

        <div className="content">
          {error && <div className="notice error-notice" role="alert">{error}<button onClick={() => setError('')} aria-label="Dismiss error">×</button></div>}
          {message && <div className="notice success-notice" role="status">{message}<button onClick={() => setMessage('')} aria-label="Dismiss message">×</button></div>}

          {section === 'overview' && (
            <>
              <div className="page-heading"><div><div className="eyebrow">YOUR COLLECTION</div><h1>Good to see you, {session.username} <span className="wave">✦</span></h1><p>Here’s what’s happening across your media library.</p></div><button className="primary-button" disabled={busy} onClick={() => { setSection('photos'); setBundle(null); fileInput.current?.click(); }}>＋ Add media</button></div>
              <div className="stats-grid">
                <StatCard icon="▧" label="Total photos" value={dashboard?.photoCount ?? 0} detail={`${photoBundles.length} organized bundles`} accent="lavender" />
                <StatCard icon="♫" label="Music tracks" value={dashboard?.musicCount ?? 0} detail="Across both playlists" accent="mint" />
                <StatCard icon="◒" label="Photo storage" value={formatBytes(dashboard?.photoBytes ?? 0)} detail="Stored in GitHub" accent="blue" />
                <StatCard icon="◈" label="Current bundle" value={photoBundles.at(-1)?.id ?? '—'} detail={photoBundles.length ? `${formatBytes(photoBundles.at(-1)!.sizeBytes)} of ${formatBytes(dashboard?.bundleLimitBytes ?? 0)}` : 'Ready for your first upload'} accent="peach" />
              </div>
              <div className="dashboard-columns">
                <section className="panel-card"><div className="section-title"><div><h2>Photo bundles</h2><p>Collections are kept under 100 MB each.</p></div><button className="text-button" onClick={() => setSection('bundles')}>View all <span>→</span></button></div>
                  {photoBundles.length ? <div className="bundle-list">{photoBundles.slice(-4).reverse().map((item) => <BundleRow key={item.id} item={item} limit={dashboard?.bundleLimitBytes ?? 0} onOpen={openBundle} />)}</div> : <EmptyState title="Your gallery starts here" detail="Upload photos and they’ll be optimized and grouped into bundles automatically." />}
                </section>
                <section className="panel-card"><div className="section-title"><div><h2>Recent activity</h2><p>Your latest library changes.</p></div></div>
                  {activity.length ? <div className="activity-list">{activity.slice(0, 6).map((item) => <div className="activity-item" key={item.id}><span className="activity-check">✓</span><div><strong>{item.message}</strong><small>{formatDate(item.time, dashboard?.timezone)}</small></div></div>)}</div> : <EmptyState title="No activity yet" detail="Upload or organize media to see changes here." />}
                </section>
              </div>
            </>
          )}

          {(section === 'photos' || section === 'bundles') && (
            <>
              <div className="page-heading"><div><div className="eyebrow">{section === 'photos' ? 'PHOTO LIBRARY' : 'ORGANIZATION'}</div><h1>{bundle ? bundle.id : section === 'photos' ? 'Photos' : 'Bundles'}</h1><p>{bundle ? `${bundle.photoCount} photos · ${formatBytes(bundle.sizeBytes)}` : section === 'photos' ? 'Search and preview images across your collection.' : 'Every photo bundle and its storage usage.'}</p></div>
                <button className="primary-button upload-button" disabled={busy} onClick={() => fileInput.current?.click()}>＋ Upload photos</button>
              </div>
              <div className="toolbar">
                <div className="search-box"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={bundle ? 'Search in this bundle…' : section === 'photos' ? 'Search photos by filename…' : 'Search bundles…'} /></div>
                {bundle ? <button className="secondary-button" onClick={() => setBundle(null)}>← All bundles</button> : <span className="toolbar-count">{dashboard?.photoCount ?? 0} photos · {photoBundles.length} bundles</span>}
              </div>
              {section === 'photos' ? (
                photosToDisplay.length ? <div className="photo-grid">{photosToDisplay.map((photo) => <button className="photo-tile" key={photo.id} onClick={() => setSelectedPhoto(photo)}><img src={photo.url} alt={photo.filename} loading="lazy" /><span className="photo-caption">{photo.filename}</span></button>)}</div> : <EmptyState title={search ? 'No photos match' : 'No photos yet'} detail={search ? 'Try another filename search.' : 'Upload JPG, PNG, WebP or GIF files. They’re converted to optimized WebP automatically.'} />
              ) : photoBundles.length ? <div className="bundle-grid">{photoBundles.filter((item) => !search || item.id.toLowerCase().includes(search.toLowerCase())).map((item) => <BundleCard key={item.id} item={item} limit={dashboard?.bundleLimitBytes ?? 0} onOpen={openBundle} />)}</div> : <EmptyState title="No bundles yet" detail="Upload photos and they’ll be organized into bundles automatically." />}
            </>
          )}

          {section === 'music' && (
            <>
              <div className="page-heading"><div><div className="eyebrow">AUDIO LIBRARY</div><h1>Music</h1><p>Manage your playlists and keep the soundtrack in order.</p></div><button className="primary-button upload-button" disabled={busy} onClick={() => fileInput.current?.click()}>＋ Upload music</button></div>
              <div className="music-controls"><div className="search-box"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search songs or filenames…" /></div><label className="select-wrap"><span>Add to</span><select value={category} onChange={(event) => setCategory(event.target.value as typeof category)}><option value="humanMode">Human Mode</option><option value="divineMode">Divine Mode</option></select></label></div>
              {(['humanMode', 'divineMode'] as const).map((key) => {
                const tracks = visibleTracks.filter((item) => item.category === key);
                return <section className="music-section panel-card" key={key}><div className="section-title"><div><h2>{key === 'humanMode' ? 'Human Mode' : 'Divine Mode'}</h2><p>{dashboard?.playlist[key].length ?? 0} tracks</p></div><span className="music-symbol">♫</span></div>
                  {tracks.length ? <div className="track-list">{tracks.map(({ track }) => <TrackRow key={track.id} track={track} category={key} baseUrl={dashboard?.mediaBaseUrl ?? ''} onDelete={deleteItem} />)}</div> : <div className="compact-empty">{search ? 'No matching tracks.' : 'This playlist is ready for its first track.'}</div>}
                </section>;
              })}
            </>
          )}

          {section === 'settings' && (
            <>
              <div className="page-heading"><div><div className="eyebrow">PREFERENCES</div><h1>Settings</h1><p>Repository connection and storage configuration.</p></div></div>
              <section className="settings-card panel-card"><div className="settings-heading"><span className="settings-icon">⌘</span><div><h2>GitHub repository</h2><p>Media files and manifests are committed to this repository.</p></div><span className="connected-badge"><span className="status-dot" /> Connected</span></div>
                <div className="settings-grid"><Setting label="Repository" value={dashboard?.repository ?? 'Not configured'} /><Setting label="Branch" value={dashboard?.branch ?? '—'} /><Setting label="Photo bundle limit" value={`${formatBytes(dashboard?.bundleLimitBytes ?? 0)} maximum`} /><Setting label="Timezone" value={dashboard?.timezone ?? 'Asia/Kolkata'} /></div>
                <div className="settings-note">Your GitHub token and authentication secrets are stored only in server environment variables. They are never sent to this browser.</div>
              </section>
              <section className="settings-card panel-card"><div className="settings-heading"><span className="settings-icon purple">◈</span><div><h2>Published manifests</h2><p>Versioned metadata for future media consumers.</p></div></div><div className="manifest-list"><div><span>Photo manifest</span><code>media-manifest.json · v{dashboard?.mediaManifest.version ?? 1}</code></div><div><span>Music playlist</span><code>music/playlist.json · v{dashboard?.playlist.version ?? 1}</code></div></div></section>
            </>
          )}

          {queue.length > 0 && <section className="queue-card panel-card"><div className="section-title"><div><h2>Upload queue</h2><p>{queue.filter((item) => item.state === 'Committed').length} of {queue.length} complete</p></div><button className="icon-button" disabled={busy} onClick={() => setQueue([])}>×</button></div><div className="queue-list">{queue.map((item, index) => <div className="queue-item" key={`${item.name}-${index}`}><span className={`queue-status ${item.state.toLowerCase()}`}>{item.state === 'Committed' ? '✓' : item.state === 'Failed' ? '!' : item.state === 'Waiting' ? '·' : '…'}</span><span className="queue-name">{item.name}</span><span className={`queue-state ${item.state.toLowerCase()}`}>{item.state === 'Uploading' && item.progress !== undefined ? `${Math.round(item.progress)}%` : item.state}</span></div>)}</div></section>}

          <footer className="footer"><span>Media Vault <i>·</i> Private by design</span><span>All changes are versioned in GitHub</span></footer>
        </div>
      </main>

      {selectedPhoto && <div className="modal-backdrop" onClick={() => setSelectedPhoto(null)}><section className="photo-modal" onClick={(event) => event.stopPropagation()}><button className="modal-close" onClick={() => setSelectedPhoto(null)}>×</button><img src={selectedPhoto.url} alt={selectedPhoto.filename} /><div className="photo-details"><div><div className="eyebrow">PHOTO DETAILS</div><h2>{selectedPhoto.filename}</h2><p>{selectedPhoto.width} × {selectedPhoto.height} · {formatBytes(selectedPhoto.sizeBytes)} · WebP</p></div><button className="danger-button" disabled={busy} onClick={() => void deleteItem('photo', selectedPhoto)}>Delete photo</button></div></section></div>}
    </div>
  );
}

function StatCard({ icon, label, value, detail, accent }: { icon: string; label: string; value: string | number; detail: string; accent: string }) {
  return <article className="stat-card"><div className={`stat-icon ${accent}`}>{icon}</div><div className="stat-label">{label}</div><strong className="stat-value">{value}</strong><small>{detail}</small></article>;
}

function BundleRow({ item, limit, onOpen }: { item: BundleSummary; limit: number; onOpen: (item: BundleSummary) => void }) {
  return <button className="bundle-row" onClick={() => onOpen(item)}><span className="bundle-art"><span>▧</span></span><span className="bundle-row-info"><strong>{item.id}</strong><small>{item.photoCount} photos</small></span><span className="bundle-row-size"><strong>{formatBytes(item.sizeBytes)}</strong><small>{limit ? Math.round(item.sizeBytes / limit * 100) : 0}% full</small></span><span className="row-arrow">↗</span></button>;
}

function BundleCard({ item, limit, onOpen }: { item: BundleSummary; limit: number; onOpen: (item: BundleSummary) => void }) {
  const percent = limit ? Math.min(100, item.sizeBytes / limit * 100) : 0;
  return <button className="bundle-card" onClick={() => onOpen(item)}><div className="bundle-card-top"><span className="bundle-art large-art"><span>▧</span></span><span className="bundle-card-arrow">↗</span></div><div className="bundle-card-title">{item.id}</div><div className="bundle-card-info">{item.photoCount} photos <i>·</i> {formatBytes(item.sizeBytes)}</div><div className="progress-track"><span style={{ width: `${percent}%` }} /></div><div className="bundle-card-bottom"><span>Storage used</span><strong>{percent.toFixed(0)}%</strong></div></button>;
}

function TrackRow({ track, category, baseUrl, onDelete }: { track: Track; category: 'humanMode' | 'divineMode'; baseUrl: string; onDelete: (kind: 'music', item: Track, category: 'humanMode' | 'divineMode') => void }) {
  const url = `${baseUrl}${track.path.split('/').map(encodeURIComponent).join('/')}`;
  return <div className="track-row"><span className="track-play">♫</span><div className="track-main"><strong>{track.title}</strong><small>{track.filename} · {formatBytes(track.sizeBytes)}</small></div><audio controls preload="none" src={url} aria-label={`Preview ${track.title}`} /><button className="icon-button delete-icon" aria-label={`Delete ${track.title}`} onClick={() => onDelete('music', track, category)}>⌫</button></div>;
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="empty-state"><span className="empty-icon">✧</span><strong>{title}</strong><p>{detail}</p></div>;
}

function Setting({ label, value }: { label: string; value: string }) {
  return <div className="setting-item"><span>{label}</span><strong>{value}</strong></div>;
}
