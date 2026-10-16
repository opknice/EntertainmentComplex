import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { handleSportsRequest } from './lib/sports-proxy.js';
import { catalogSyncPlugin } from './lib/catalog-sync-dev.js';

function sportsApi() {
  return {
    name: 'entertainment-complex-sports-api',
    configureServer(server) {
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
  plugins: [react(), sportsApi(), catalogSyncPlugin()],
  server: {
    host: '127.0.0.1',
  },
});
