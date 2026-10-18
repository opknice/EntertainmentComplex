import { build, defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { handleSportsRequest } from './lib/sports-proxy.js';
import { catalogSyncPlugin } from './lib/catalog-sync-dev.js';
import handleSportsCatalog from './api/sports-catalog.js';
import handleManuLive from './api/manulive.js';

function manuLive() {
  const tvBundle = async () => {
    const result = await build({ configFile: false, publicDir: false, logLevel: 'error', build: {
      write: false, target: 'chrome56', minify: true,
      lib: { entry: 'src/manulive.js', name: 'ManuLive', formats: ['iife'] },
    } });
    const outputs = Array.isArray(result) ? result : [result];
    return outputs.flatMap(output => output.output).find(file => file.type === 'chunk').code;
  };
  const attach = server => {
    server.middlewares.use((request, _response, next) => {
      if (['/manulive', '/manulive/'].includes(request.url?.split('?')[0])) request.url = '/manulive.html';
      next();
    });
    server.middlewares.use('/api/manulive', async (request, response, next) => {
      try {
        const url = new URL(request.originalUrl || request.url, `http://${request.headers.host}`);
        const result = await handleManuLive(new Request(url, { method: request.method }));
        response.statusCode = result.status;
        result.headers.forEach((value, name) => response.setHeader(name, value));
        response.end(Buffer.from(await result.arrayBuffer()));
      } catch (error) { next(error); }
    });
  };
  return { name: 'manulive-tv', configureServer(server) {
      attach(server);
      server.middlewares.use('/assets/manulive-tv.js', async (_request, response, next) => {
        try { response.setHeader('Content-Type', 'application/javascript'); response.end(await tvBundle()); }
        catch (error) { next(error); }
      });
    }, configurePreviewServer: attach,
    async generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'assets/manulive-tv.js', source: await tvBundle() });
    },
  };
}

function sportsApi() {
  return {
    name: 'entertainment-complex-sports-api',
    configureServer(server) {
      server.middlewares.use('/api/sports-catalog', async (request, response, next) => {
        try {
          const result = await handleSportsCatalog(new Request('http://localhost/api/sports-catalog', { method: request.method }));
          response.statusCode = result.status;
          result.headers.forEach((value, name) => response.setHeader(name, value));
          response.end(Buffer.from(await result.arrayBuffer()));
        } catch (error) { next(error); }
      });
      server.middlewares.use('/api/sports', async (request, response, next) => {
        try {
          const origin = `http://${request.headers.host || '127.0.0.1'}`;
          const webRequest = new Request(new URL(request.originalUrl || request.url || '/api/sports', origin), {
            method: request.method,
            headers: request.headers,
          });
          const webResponse = await handleSportsRequest(webRequest);
          response.statusCode = webResponse.status;
          webResponse.headers.forEach((value, name) => response.setHeader(name, value));
          response.end(Buffer.from(await webResponse.arrayBuffer()));
        } catch (error) {
          next(error);
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), sportsApi(), catalogSyncPlugin(), manuLive()],
  server: {
    host: '127.0.0.1',
  },
});
