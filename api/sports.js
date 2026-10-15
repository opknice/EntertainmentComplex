const SPORTS_ORIGIN = 'https://atmflix.live';
const RESOLVER_URL = 'https://dws-license.thmirror2.workers.dev/atmsign';
const USER_AGENT = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36';
const MAX_MANIFEST_BYTES = 5 * 1024 * 1024;

export const config = { runtime: 'edge' };

function errorResponse(message, status) {
  return Response.json({ error: message }, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
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

function proxiedUrl(requestUrl, channel, target) {
  const output = new URL('/api/sports', requestUrl.origin);
  output.searchParams.set('ch', channel);
  output.searchParams.set('u', target.href);
  return output.href;
}

function rewriteUriAttributes(line, baseUrl, requestUrl, channel) {
  return line.replace(/URI="([^"]+)"/g, (_match, value) => {
    const target = new URL(value, baseUrl);
    return `URI="${proxiedUrl(requestUrl, channel, target)}"`;
  });
}

function rewriteManifest(text, baseUrl, requestUrl, channel) {
  return text.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (trimmed.startsWith('#')) return rewriteUriAttributes(line, baseUrl, requestUrl, channel);
    return proxiedUrl(requestUrl, channel, new URL(trimmed, baseUrl));
  }).join('\n');
}

function responseHeaders(upstream) {
  const headers = new Headers();
  for (const name of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag', 'Last-Modified']) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('Cache-Control', 'private, max-age=15');
  return headers;
}

export default async function handler(request) {
  if (!['GET', 'HEAD'].includes(request.method)) return errorResponse('method not allowed', 405);

  const requestUrl = new URL(request.url);
  const channel = requestUrl.searchParams.get('ch') || '';
  if (!/^[A-Za-z0-9._-]{1,256}$/.test(channel)) return errorResponse('invalid channel', 400);

  try {
    const signedTarget = await resolveChannel(channel);
    const override = requestUrl.searchParams.get('u');
    const target = override ? new URL(override) : signedTarget;
    if (target.protocol !== 'https:' || target.origin !== signedTarget.origin) {
      return errorResponse('target origin mismatch', 403);
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
    const outputHeaders = responseHeaders(upstream);

    if (request.method === 'HEAD' || !isManifest || !upstream.ok) {
      return new Response(upstream.body, { status: upstream.status, headers: outputHeaders });
    }

    const declaredLength = Number(upstream.headers.get('Content-Length') || 0);
    if (declaredLength > MAX_MANIFEST_BYTES) return errorResponse('manifest too large', 502);
    const manifest = await upstream.text();
    if (new TextEncoder().encode(manifest).byteLength > MAX_MANIFEST_BYTES) return errorResponse('manifest too large', 502);
    const baseUrl = new URL(upstream.url || target.href);
    const rewritten = rewriteManifest(manifest, baseUrl, requestUrl, channel);
    outputHeaders.set('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
    outputHeaders.delete('Content-Length');
    return new Response(rewritten, { status: upstream.status, headers: outputHeaders });
  } catch (error) {
    console.error('sports proxy failed', error);
    return errorResponse('sports stream unavailable', 502);
  }
}
