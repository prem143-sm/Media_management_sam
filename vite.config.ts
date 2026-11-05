import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import authHandler from './api/auth.ts';
import mediaHandler from './api/media.ts';
import uploadTokenHandler from './api/upload-token.ts';

function localApi(): Plugin {
  return {
    name: 'media-manager-local-api',
    configureServer(server) {
      const routes: Record<string, (request: Request) => Promise<Response>> = {
        '/api/auth': authHandler,
        '/api/media': mediaHandler,
        '/api/upload-token': uploadTokenHandler,
      };
      for (const [route, handler] of Object.entries(routes)) {
        server.middlewares.use(route, async (req, res, next) => {
          try {
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            const body = chunks.length ? Buffer.concat(chunks) : undefined;
            const request = new Request(`http://${req.headers.host ?? 'localhost:5173'}${route}${req.url ?? ''}`, {
              method: req.method,
              headers: req.headers as HeadersInit,
              body: body && req.method !== 'GET' && req.method !== 'HEAD' ? body : undefined,
            });
            const response = await handler(request);
            res.statusCode = response.status;
            response.headers.forEach((value, name) => res.setHeader(name, value));
            res.end(Buffer.from(await response.arrayBuffer()));
          } catch (error) {
            next(error);
          }
        });
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  Object.assign(process.env, loadEnv(mode, process.cwd(), ''));
  return { plugins: [react(), localApi()], server: { port: 5173 } };
});
