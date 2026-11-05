import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

type VercelRequest = IncomingMessage & { body?: unknown };
export type AdminSession = { username: string; expiresAt: number; csrf: string };

export function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(value, { status, headers });
}

function headersFrom(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(name, value);
    else if (Array.isArray(value)) headers.set(name, value.join(', '));
  }
  return headers;
}

function fetchRequest(req: VercelRequest): Request {
  const method = req.method ?? 'GET';
  const forwarded = req.headers['x-forwarded-proto'];
  const protocol = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0] ?? 'http';
  const host = req.headers.host ?? 'localhost';
  const value = req.body;
  const body: string | undefined = value == null || method === 'GET' || method === 'HEAD'
    ? undefined
    : typeof value === 'string'
      ? value
      : value instanceof Uint8Array
        ? new TextDecoder().decode(value)
        : JSON.stringify(value);
  return new Request(new URL(req.url ?? '/', `${protocol}://${host}`), {
    method,
    headers: headersFrom(req),
    body,
  });
}

export function vercelHandler(
  handle: (request: Request) => Promise<Response>,
): {
  (request: Request): Promise<Response>;
  (request: VercelRequest, response: ServerResponse): Promise<void>;
} {
  async function run(request: Request | VercelRequest, response?: ServerResponse): Promise<Response | void> {
    const fetchReq = request instanceof Request ? request : fetchRequest(request);
    let result = await handle(fetchReq);
    const activeSession = result.status < 400 ? readSession(fetchReq) : null;
    if (activeSession && !result.headers.has('Set-Cookie')) {
      const refreshed = refreshSession(activeSession);
      const headers = new Headers(result.headers);
      headers.set('Set-Cookie', refreshed.cookie);
      result = new Response(result.body, { status: result.status, statusText: result.statusText, headers });
    }
    if (request instanceof Request) return result;
    if (!response) throw new Error('Vercel response object is unavailable.');
    response.statusCode = result.status;
    result.headers.forEach((value, name) => response.setHeader(name, value));
    response.end(Buffer.from(await result.arrayBuffer()));
  }
  function handler(request: Request): Promise<Response>;
  function handler(request: VercelRequest, response: ServerResponse): Promise<void>;
  function handler(request: Request | VercelRequest, response?: ServerResponse): Promise<Response | void> {
    return run(request, response);
  }
  return handler;
}

const SESSION_COOKIE = 'media_manager_session';
const SESSION_SECONDS = 8 * 60 * 60;

function secret(): string {
  const value = process.env.AUTH_SECRET;
  if (!value || value.length < 32) throw new Error('Authentication is not configured.');
  return value;
}

function signature(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('base64url');
}

export function createSession(username: string): { cookie: string; csrf: string; expiresAt: number } {
  const expiresAt = Date.now() + SESSION_SECONDS * 1000;
  const csrf = randomBytes(32).toString('base64url');
  return sessionCookie({ username, expiresAt, csrf });
}

function sessionCookie(session: AdminSession): { cookie: string; csrf: string; expiresAt: number } {
  const expiresAt = session.expiresAt;
  const csrf = session.csrf;
  const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
  const secure = process.env.NODE_ENV === 'production' || process.env.VERCEL ? '; Secure' : '';
  return {
    cookie: `${SESSION_COOKIE}=${payload}.${signature(payload)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}${secure}`,
    csrf,
    expiresAt,
  };
}

function refreshSession(session: AdminSession): { cookie: string; csrf: string; expiresAt: number } {
  return sessionCookie({ ...session, expiresAt: Date.now() + SESSION_SECONDS * 1000 });
}

export function clearSessionCookie(): string {
  const secure = process.env.NODE_ENV === 'production' || process.env.VERCEL ? '; Secure' : '';
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
}

export function readSession(request: Request): AdminSession | null {
  try {
    const cookie = request.headers.get('cookie') ?? '';
    const match = cookie.match(/(?:^|;\s*)media_manager_session=([^;]+)/);
    if (!match) return null;
    const [payload, provided] = match[1].split('.');
    if (!payload || !provided) return null;
    const expected = signature(payload);
    const actualBytes = Buffer.from(provided);
    const expectedBytes = Buffer.from(expected);
    if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) return null;
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as AdminSession;
    if (
      typeof session.username !== 'string' || session.username !== process.env.ADMIN_USERNAME ||
      typeof session.csrf !== 'string' || session.expiresAt <= Date.now()
    ) return null;
    return session;
  } catch {
    return null;
  }
}

export function checkMutation(request: Request, session: AdminSession): Response | null {
  const origin = request.headers.get('origin');
  try {
    if (origin && new URL(origin).origin !== new URL(request.url).origin) return json({ error: 'Request origin is not allowed.' }, 403);
  } catch {
    return json({ error: 'Request origin is not allowed.' }, 403);
  }
  const token = request.headers.get('x-csrf-token') ?? '';
  const a = Buffer.from(token);
  const b = Buffer.from(session.csrf);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return json({ error: 'Session verification failed. Please refresh and try again.' }, 403);
  return null;
}
