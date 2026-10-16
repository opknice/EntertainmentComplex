import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Local Vite sessions use the same complete sync as the scheduled production job.
export function catalogSyncPlugin() {
  function attach(server) {
    let child;
    let run = null;
    const sync = () => {
      if (child) return;
      run = { createdAt: new Date().toISOString(), status: 'in_progress', conclusion: null };
      child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/sync-catalog.mjs', import.meta.url))], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', (data) => console.log(String(data).trim()));
      child.stderr.on('data', (data) => console.warn(String(data).trim()));
      const finish = (success) => { run = { ...run, status: 'completed', conclusion: success ? 'success' : 'failure' }; child = null; };
      child.once('error', () => finish(false));
      child.once('exit', (code) => finish(code === 0));
    };
    server.middlewares.use('/api/update-catalog', (request, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.setHeader('Cache-Control', 'no-store');
      if (request.method === 'GET') { response.end(JSON.stringify({ run })); return; }
      if (request.method !== 'POST') { response.statusCode = 405; response.end('{}'); return; }
      const origin = request.headers.origin;
      if (origin && new URL(origin).host !== request.headers.host) { response.statusCode = 403; response.end('{}'); return; }
      if (child || run && Date.now() - Date.parse(run.createdAt) < 300_000) {
        response.statusCode = 429;
        response.end(JSON.stringify({ retryAfter: 60, run }));
        return;
      }
      sync();
      response.statusCode = 202;
      response.end(JSON.stringify({ requestedAt: run.createdAt }));
    });
    const timer = setInterval(sync, 15 * 60 * 1000);
    timer.unref();
    server.httpServer?.once('close', () => { clearInterval(timer); child?.kill(); });
  }
  return { name: 'local-catalog-sync', configureServer: attach, configurePreviewServer: attach };
}
