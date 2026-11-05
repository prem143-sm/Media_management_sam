import { scryptSync, timingSafeEqual } from 'node:crypto';
import { checkMutation, clearSessionCookie, createSession, json, readSession, vercelHandler } from '../src/server/http.ts';

const attempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

function validPassword(password: string, encoded: string): boolean {
  const [scheme, salt, expectedHex] = encoded.split('$');
  if (scheme !== 'scrypt' || !salt || !/^[a-f0-9]{128}$/i.test(expectedHex ?? '')) return false;
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = scryptSync(password, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function originAllowed(request: Request): boolean {
  const origin = request.headers.get('origin');
  try {
    return !origin || new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

async function handle(request: Request): Promise<Response> {
  const session = readSession(request);
  if (request.method === 'GET') {
    return session
      ? json({ authenticated: true, username: session.username, csrf: session.csrf, expiresAt: session.expiresAt })
      : json({ authenticated: false });
  }

  if (!originAllowed(request)) return json({ error: 'Request origin is not allowed.' }, 403);
  if (request.method === 'DELETE') {
    if (!session) return json({ error: 'Session expired. Please sign in again.' }, 401, { 'Set-Cookie': clearSessionCookie() });
    const invalid = checkMutation(request, session);
    if (invalid) return invalid;
    return json({ authenticated: false }, 200, { 'Set-Cookie': clearSessionCookie() });
  }

  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? 'unknown';
  const record = attempts.get(ip);
  if (record && record.resetAt > Date.now() && record.count >= MAX_ATTEMPTS) {
    return json({ error: 'Too many sign-in attempts. Try again in 15 minutes.' }, 429);
  }
  if (record && record.resetAt <= Date.now()) attempts.delete(ip);

  let body: { username?: unknown; password?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid sign-in request.' }, 400);
  }

  const expectedUsername = process.env.ADMIN_USERNAME;
  const passwordHash = process.env.ADMIN_PASSWORD_HASH;
  if (!expectedUsername || !passwordHash || !process.env.AUTH_SECRET || process.env.AUTH_SECRET.length < 32) {
    return json({ error: 'Authentication is not configured. Set the required server environment variables.' }, 503);
  }
  if (typeof body.username !== 'string' || typeof body.password !== 'string' || body.password.length > 1024) {
    return json({ error: 'Invalid username or password.' }, 401);
  }

  const usernameMatches = body.username.length === expectedUsername.length
    && timingSafeEqual(Buffer.from(body.username), Buffer.from(expectedUsername));
  let passwordMatches = false;
  try {
    passwordMatches = validPassword(body.password, passwordHash);
  } catch {
    return json({ error: 'Authentication configuration is invalid.' }, 503);
  }
  if (!usernameMatches || !passwordMatches) {
    const current = attempts.get(ip);
    attempts.set(ip, {
      count: (current?.count ?? 0) + 1,
      resetAt: current?.resetAt && current.resetAt > Date.now() ? current.resetAt : Date.now() + LOCKOUT_MS,
    });
    return json({ error: 'Invalid username or password.' }, 401);
  }

  attempts.delete(ip);
  try {
    const auth = createSession(expectedUsername);
    return json(
      { authenticated: true, username: expectedUsername, csrf: auth.csrf, expiresAt: auth.expiresAt },
      200,
      { 'Set-Cookie': auth.cookie },
    );
  } catch {
    return json({ error: 'Authentication is not configured correctly.' }, 503);
  }
}

export default vercelHandler(async (request) => {
  try {
    return await handle(request);
  } catch {
    return json({ error: 'Authentication request failed.' }, 500);
  }
});
