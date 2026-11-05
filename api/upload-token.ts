import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { checkMutation, json, readSession, vercelHandler } from '../src/server/http.ts';

async function handle(request: Request): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  const session = readSession(request);
  if (!session) return json({ error: 'Session expired. Please sign in again.' }, 401);
  const invalid = checkMutation(request, session);
  if (invalid) return invalid;
  if (!process.env.BLOB_READ_WRITE_TOKEN) return json({ error: 'Temporary upload storage is not configured.' }, 503);

  let body: HandleUploadBody;
  try {
    body = await request.json() as HandleUploadBody;
  } catch {
    return json({ error: 'Invalid upload token request.' }, 400);
  }

  try {
    const result = await handleUpload({
      request,
      body,
      token: process.env.BLOB_READ_WRITE_TOKEN,
      onBeforeGenerateToken: async (pathname) => {
        if (!/^staging\/[A-Za-z0-9_-]{16,80}$/.test(pathname)) throw new Error('Invalid staging path.');
        return {
          allowedContentTypes: [
            'image/webp',
            'audio/mpeg',
            'audio/mp3',
            'audio/wav',
            'audio/x-wav',
            'audio/mp4',
            'audio/aac',
            'audio/ogg',
            'audio/flac',
            'application/octet-stream',
          ],
          maximumSizeInBytes: 100 * 1024 * 1024,
          addRandomSuffix: false,
          tokenPayload: session.username,
        };
      },
    });
    return json(result);
  } catch {
    return json({ error: 'Could not authorize the temporary upload.' }, 400);
  }
}

export default vercelHandler(async (request) => {
  try {
    return await handle(request);
  } catch {
    return json({ error: 'Could not authorize the temporary upload.' }, 500);
  }
});
