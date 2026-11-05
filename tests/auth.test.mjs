import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

let server;
let handler;
let cookie;
let csrf;

before(async () => {
  process.env.AUTH_SECRET = 'test-secret-with-more-than-thirty-two-characters';
  process.env.ADMIN_USERNAME = 'media-admin';
  server = await createServer({ configFile: 'vite.config.ts', server: { middlewareMode: true } });
  ({ default: handler } = await server.ssrLoadModule('/api/auth.ts'));
});

after(async () => {
  await server?.close();
  delete process.env.AUTH_SECRET;
  delete process.env.ADMIN_USERNAME;
});

async function request(method, body, headers = {}) {
  return handler(new Request('http://localhost:5173/api/auth', {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  }));
}

test('an incorrect user ID is rejected', async () => {
  const response = await request('POST', { username: 'not-the-admin' });
  assert.equal(response.status, 401);
});

test('the configured user ID logs in and logout expires its session cookie', async () => {
  const login = await request('POST', { username: 'media-admin' });
  const data = await login.json();
  assert.equal(login.status, 200);
  assert.equal(data.authenticated, true);
  assert.ok(data.csrf);
  cookie = login.headers.get('set-cookie').split(';')[0];
  csrf = data.csrf;

  const session = await request('GET', undefined, { cookie });
  assert.equal((await session.json()).authenticated, true);
  assert.match(session.headers.get('set-cookie'), /Max-Age=28800/);

  const missingCsrf = await request('DELETE', undefined, { cookie, origin: 'http://localhost:5173' });
  assert.equal(missingCsrf.status, 403);

  const crossOrigin = await request('DELETE', undefined, {
    cookie,
    origin: 'https://other.example',
    'x-csrf-token': csrf,
  });
  assert.equal(crossOrigin.status, 403);

  const logout = await request('DELETE', undefined, {
    cookie,
    origin: 'http://localhost:5173',
    'x-csrf-token': csrf,
  });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  const signedOut = await request('GET');
  assert.equal((await signedOut.json()).authenticated, false);
});

test('sessions expire after eight inactive hours', async () => {
  const now = Date.now;
  Date.now = () => now() - 9 * 60 * 60 * 1000;
  let expiredCookie;
  try {
    const login = await request('POST', { username: 'media-admin' });
    expiredCookie = login.headers.get('set-cookie').split(';')[0];
  } finally {
    Date.now = now;
  }
  const expired = await request('GET', undefined, { cookie: expiredCookie });
  assert.equal((await expired.json()).authenticated, false);
});

test('the Vercel Node request adapter handles parsed JSON bodies', async () => {
  const response = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name] = value; },
    end(value) { this.body = value.toString(); },
  };
  await handler({
    method: 'POST',
    url: '/api/auth',
    headers: { host: 'localhost:3000', 'content-type': 'application/json' },
    body: { username: 'media-admin' },
  }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).authenticated, true);
  assert.match(response.headers['set-cookie'], /HttpOnly/);
});
