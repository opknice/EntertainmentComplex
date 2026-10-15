const OWNER = 'opknice';
const REPOSITORY = 'EntertainmentComplex';
const WORKFLOW = 'sync-catalog.yml';
const COOLDOWN_MS = 5 * 60 * 1000;
const API_BASE = `https://api.github.com/repos/${OWNER}/${REPOSITORY}/actions/workflows/${WORKFLOW}`;

export const config = { runtime: 'edge' };

function json(body, status = 200, extraHeaders = {}) {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store', ...extraHeaders },
  });
}

function githubHeaders(token, includeBody = false) {
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'DoowisePlay-Catalog-Updater',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (includeBody) headers['Content-Type'] = 'application/json';
  return headers;
}

async function latestRun(token, event = '') {
  const url = new URL(`${API_BASE}/runs`);
  url.searchParams.set('per_page', '1');
  if (event) url.searchParams.set('event', event);
  const response = await fetch(url, {
    headers: githubHeaders(token),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`GitHub runs API failed (${response.status})`);
  const body = await response.json();
  return body.workflow_runs?.[0] || null;
}

function publicRun(run) {
  if (!run) return null;
  return {
    id: run.id,
    status: run.status,
    conclusion: run.conclusion,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
  };
}

export default async function handler(request) {
  const token = process.env.GITHUB_ACTIONS_TOKEN;
  if (!token) return json({ error: 'manual update is not configured' }, 503);

  try {
    if (request.method === 'GET') {
      return json({ run: publicRun(await latestRun(token, 'workflow_dispatch')) });
    }
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405, { Allow: 'GET, POST' });

    const requestUrl = new URL(request.url);
    const origin = request.headers.get('Origin');
    if (origin && origin !== requestUrl.origin) return json({ error: 'origin not allowed' }, 403);

    const latest = await latestRun(token);
    const lastStartedAt = latest?.created_at ? new Date(latest.created_at).getTime() : 0;
    const elapsed = Date.now() - lastStartedAt;
    const isRunning = latest && ['queued', 'in_progress', 'waiting', 'pending'].includes(latest.status);
    if (isRunning || elapsed < COOLDOWN_MS) {
      const retryAfter = isRunning ? 60 : Math.max(1, Math.ceil((COOLDOWN_MS - elapsed) / 1000));
      return json({
        error: isRunning ? 'update already running' : 'cooldown active',
        retryAfter,
        run: publicRun(latest),
      }, 429, { 'Retry-After': String(retryAfter) });
    }

    const requestedAt = new Date().toISOString();
    const response = await fetch(`${API_BASE}/dispatches`, {
      method: 'POST',
      headers: githubHeaders(token, true),
      body: JSON.stringify({ ref: 'main' }),
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`GitHub dispatch failed (${response.status})`);
    return json({ ok: true, requestedAt, cooldownSeconds: COOLDOWN_MS / 1000 }, 202);
  } catch (error) {
    console.error('catalog update request failed', error);
    return json({ error: 'unable to request catalog update' }, 502);
  }
}
