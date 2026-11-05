import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

let server;
let libraryHandler;
let cookie;
let csrf;
let originalFetch;
const savedEnv = new Map();

function setEnv(name, value) {
  savedEnv.set(name, process.env[name]);
  process.env[name] = value;
}

before(async () => {
  setEnv('AUTH_SECRET', 'test-secret-with-more-than-thirty-two-characters');
  setEnv('ADMIN_USERNAME', 'media-admin');
  setEnv('GITHUB_TOKEN', 'test-github-token');
  setEnv('GITHUB_OWNER', 'prem143-sm');
  setEnv('GITHUB_REPOSITORY', 'SamsBday');
  setEnv('GITHUB_BRANCH', 'main');
  originalFetch = globalThis.fetch;
  server = await createServer({ configFile: 'vite.config.ts', server: { middlewareMode: true } });
  const { default: authHandler } = await server.ssrLoadModule('/api/auth.ts');
  ({ default: libraryHandler } = await server.ssrLoadModule('/api/library.ts'));
  const login = await authHandler(new Request('http://localhost:5173/api/auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'media-admin' }),
  }));
  assert.equal(login.status, 200);
  const data = await login.json();
  cookie = login.headers.get('set-cookie').split(';')[0];
  csrf = data.csrf;
});

after(async () => {
  globalThis.fetch = originalFetch;
  await server?.close();
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test('library requires a signed-in session', async () => {
  const response = await libraryHandler(new Request('http://localhost:5173/api/library'));
  assert.equal(response.status, 401);
});

test('library lists only optimized photos and website music files', async () => {
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.pathname.endsWith('/git/ref/heads/main')) {
      return Response.json({ object: { sha: 'head-sha' } });
    }
    if (url.pathname.endsWith('/git/commits/head-sha')) {
      return Response.json({ tree: { sha: 'tree-sha' } });
    }
    if (url.pathname.endsWith('/git/trees/tree-sha')) {
      return Response.json({
        truncated: false,
        tree: [
          { path: 'public/Photos/optimized/sam 1.webp', size: 1024, type: 'blob' },
          { path: 'public/Photos/original/sam.jpg', size: 2048, type: 'blob' },
          { path: 'public/music/Prems-Playlist/song.mp3', size: 4096, type: 'blob' },
          { path: 'public/music/Sams-Playlist/.gitkeep', size: 0, type: 'blob' },
          { path: 'src/data/photo-library.ts', size: 50, type: 'blob' },
        ],
      });
    }
    throw new Error(`Unexpected GitHub request: ${url.pathname}`);
  };

  const response = await libraryHandler(new Request('http://localhost:5173/api/library', {
    headers: { cookie },
  }));
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.repository, 'prem143-sm/SamsBday');
  assert.deepEqual(data.photos.map((file) => file.path), ['public/Photos/optimized/sam 1.webp']);
  assert.equal(data.photos[0].url, 'https://raw.githubusercontent.com/prem143-sm/SamsBday/main/public/Photos/optimized/sam%201.webp');
  assert.deepEqual(data.music.map((file) => file.path), ['public/music/Prems-Playlist/song.mp3']);
  assert.equal(data.music[0].playlist, 'Prems-Playlist');
});

test('empty uploads and paths outside managed folders are rejected', async () => {
  const invalidUpload = await libraryHandler(new Request('http://localhost:5173/api/library', {
    method: 'POST',
    headers: { cookie, origin: 'http://localhost:5173', 'x-csrf-token': csrf, 'content-type': 'application/json' },
    body: JSON.stringify({ files: [] }),
  }));
  assert.equal(invalidUpload.status, 400);

  const invalidDelete = await libraryHandler(new Request('http://localhost:5173/api/library?path=src%2FApp.tsx', {
    method: 'DELETE',
    headers: { cookie, origin: 'http://localhost:5173', 'x-csrf-token': csrf },
  }));
  assert.equal(invalidDelete.status, 400);
});
