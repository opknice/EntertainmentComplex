const SPORTS_ORIGIN = 'https://atmflix.live';
const RESOLVER_URL = 'https://dws-license.thmirror2.workers.dev/atmsign';
const USER_AGENT = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36';
const MAX_MANIFEST_BYTES = 5 * 1024 * 1024;

function isAllowedBrowserOrigin(request, origin) {
  if (!origin) return false;
  if (origin === new URL(request.url).origin) return true;
  try {
    const value = new URL(origin);
    return value.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(value.hostname);
  } catch {
    return false;
  }
}

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const headers = new Headers({
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Content-Type',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type',
    Vary: 'Origin',
  });
  if (isAllowedBrowserOrigin(request, origin)) headers.set('Access-Control-Allow-Origin', origin);
  return headers;
}

function errorResponse(request, message, status) {
  const headers = corsHeaders(request);
  headers.set('Cache-Control', 'no-store');
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return Response.json({ error: message }, { status, headers });
}

async function resolveChannel(channel) {
  const resolver = new URL(RESOLVER_URL);
  resolver.searchParams.set('ch', channel);
  const response = await fetch(resolver, {
    headers: { 'User-Agent': 'Doowiseplay' },
    redirect: 'follow',
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`channel lookup failed (${response.status})`);
  const body = await response.json();
  if (!body?.ok || !body?.url) throw new Error('channel unavailable');
  const target = new URL(body.url);
  if (target.protocol !== 'https:') throw new Error('invalid channel URL');
  return target;
}

function proxiedUrl(channel, target) {
  const output = new URL('/api/sports', 'https://local.invalid');
  output.searchParams.set('ch', channel);
  output.searchParams.set('u', target.href);
  return `${output.pathname}${output.search}`;
}

function rewriteUriAttributes(line, baseUrl, channel) {
  return line.replace(/URI="([^"]+)"/g, (_match, value) => {
    const target = new URL(value, baseUrl);
    return `URI="${proxiedUrl(channel, target)}"`;
  });
}

function rewriteManifest(text, baseUrl, channel) {
  return text.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (trimmed.startsWith('#')) return rewriteUriAttributes(line, baseUrl, channel);
    return proxiedUrl(channel, new URL(trimmed, baseUrl));
  }).join('\n');
}

function responseHeaders(request, upstream) {
  const headers = corsHeaders(request);
  for (const name of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag', 'Last-Modified']) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('Cache-Control', 'private, max-age=15');
  return headers;
}

export async function handleSportsRequest(request) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request) });
  if (!['GET', 'HEAD'].includes(request.method)) return errorResponse(request, 'method not allowed', 405);

  const requestUrl = new URL(request.url);
  const channel = requestUrl.searchParams.get('ch') || '';
  if (!/^[A-Za-z0-9._-]{1,256}$/.test(channel)) return errorResponse(request, 'invalid channel', 400);

  try {
    const signedTarget = await resolveChannel(channel);
    const override = requestUrl.searchParams.get('u');
    const target = override ? new URL(override) : signedTarget;
    if (target.protocol !== 'https:' || target.origin !== signedTarget.origin) {
      return errorResponse(request, 'target origin mismatch', 403);
    }

    const headers = new Headers({
      Origin: SPORTS_ORIGIN,
      Referer: `${SPORTS_ORIGIN}/`,
      'User-Agent': USER_AGENT,
    });
    const range = request.headers.get('Range');
    if (range) headers.set('Range', range);
    const accept = request.headers.get('Accept');
    if (accept) headers.set('Accept', accept);

    const upstream = await fetch(target, {
      method: request.method,
      headers,
      redirect: 'follow',
      cache: 'no-store',
    });
    const contentType = upstream.headers.get('Content-Type')?.toLowerCase() || '';
    const isManifest = contentType.includes('mpegurl') || /\.m3u8(?:$|\?)/i.test(target.href);
    const outputHeaders = responseHeaders(request, upstream);

    if (request.method === 'HEAD' || !isManifest || !upstream.ok) {
      return new Response(upstream.body, { status: upstream.status, headers: outputHeaders });
    }

    const declaredLength = Number(upstream.headers.get('Content-Length') || 0);
    if (declaredLength > MAX_MANIFEST_BYTES) return errorResponse(request, 'manifest too large', 502);
    const manifest = await upstream.text();
    if (new TextEncoder().encode(manifest).byteLength > MAX_MANIFEST_BYTES) return errorResponse(request, 'manifest too large', 502);
    const baseUrl = new URL(upstream.url || target.href);
    const rewritten = rewriteManifest(manifest, baseUrl, channel);
    outputHeaders.set('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
    outputHeaders.delete('Content-Length');
    return new Response(rewritten, { status: upstream.status, headers: outputHeaders });
  } catch (error) {
    console.error('sports proxy failed', error);
    return errorResponse(request, 'sports stream unavailable', 502);
  }
}
