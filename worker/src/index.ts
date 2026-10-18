import { dashResourceOrigins } from './dash.ts';
import { SPORTS_FEEDS, SPORTS_HEADERS, SPORTS_ORIGIN } from '../../lib/sports-catalog.js';

const MAX_MANIFEST_BYTES = 5 * 1024 * 1024;
const textEncoder = new TextEncoder();

type MediaPayload = {
  u: string;
  c?: string;
  r: string;
  a: string;
  h?: Record<string, string>;
  o?: string[];
  e: number;
};

function corsHeaders(request: Request, env: Env): Headers {
  const origin = request.headers.get('Origin') || '';
  const allowed = env.ALLOWED_ORIGINS.split(',').map((item) => item.trim()).filter(Boolean);
  const headers = new Headers({
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Content-Type',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type, X-Media-Base, X-Media-Context',
    'Vary': 'Origin',
  });
  if (allowed.includes(origin) || isLocalDevelopmentOrigin(origin)) headers.set('Access-Control-Allow-Origin', origin);
  return headers;
}

function isLocalDevelopmentOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    const port = Number(url.port);
    return url.protocol === 'http:'
      && ['localhost', '127.0.0.1'].includes(url.hostname)
      && Number.isInteger(port)
      && port > 0
      && port <= 65_535;
  } catch {
    return false;
  }
}

function jsonResponse(request: Request, env: Env, body: unknown, status = 200): Response {
  const headers = corsHeaders(request, env);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  return Response.json(body, { status, headers });
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(normalized + padding);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bytesToBase64Url(value: ArrayBufferLike): string {
  const bytes = new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodePayload(encoded: string): MediaPayload {
  if (!encoded || encoded.length > 16_384) throw new Error('invalid payload');
  const parsed: unknown = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encoded)));
  if (!parsed || typeof parsed !== 'object') throw new Error('invalid payload');
  const record = parsed as Record<string, unknown>;
  if (typeof record.u !== 'string' || typeof record.r !== 'string' || typeof record.a !== 'string' || typeof record.e !== 'number') {
    throw new Error('invalid payload');
  }
  if (typeof record.c !== 'undefined' && typeof record.c !== 'string') throw new Error('invalid payload');
  if (typeof record.h !== 'undefined' && (!record.h || typeof record.h !== 'object' || Array.isArray(record.h))) throw new Error('invalid payload');
  if (typeof record.o !== 'undefined' && (!Array.isArray(record.o) || record.o.length > 8 || record.o.some((origin) => typeof origin !== 'string' || origin.length > 512))) {
    throw new Error('invalid payload');
  }
  if (record.u.length > 8_192 || record.r.length > 2_048 || record.a.length > 512 || String(record.c || '').length > 256) throw new Error('payload too large');
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries((record.h || {}) as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(name) || typeof value !== 'string' || value.length > 2_048) throw new Error('invalid headers');
    if (!['authinfo', 'authorization', 'origin'].includes(name.toLowerCase())) continue;
    headers[name] = value;
  }
  const origins = (record.o || []).map((origin) => validatedTarget(`${origin}/`).origin);
  return { u: record.u, c: record.c as string | undefined, r: record.r, a: record.a, h: headers, o: [...new Set(origins)], e: record.e };
}

async function hmac(value: string, secret: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', textEncoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', key, textEncoder.encode(value));
}

async function verifySignature(payload: string, provided: string, secret: string): Promise<boolean> {
  let providedBytes: Uint8Array;
  try {
    providedBytes = base64UrlToBytes(provided);
  } catch {
    providedBytes = new Uint8Array();
  }
  const expected = new Uint8Array(await hmac(payload, secret));
  const paddedProvided = new Uint8Array(expected.length);
  paddedProvided.set(providedBytes.slice(0, expected.length));
  const sameBytes = crypto.subtle.timingSafeEqual(expected, paddedProvided);
  return sameBytes && providedBytes.length === expected.length;
}

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace('[', '').replace(']', '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true;
  if (/^(?:127|10)\./.test(host) || /^169\.254\./.test(host) || /^0\./.test(host)) return true;
  const match = host.match(/^(\d{1,3})\.(\d{1,3})\./);
  if (!match) return /^f[cd][0-9a-f]{2}:/i.test(host) || /^fe[89ab][0-9a-f]:/i.test(host);
  const first = Number(match[1]);
  const second = Number(match[2]);
  return first === 192 && second === 168 || first === 172 && second >= 16 && second <= 31;
}

function validatedTarget(value: string): URL {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || isPrivateHostname(url.hostname)) throw new Error('target not allowed');
  return url;
}

function workerFetchTarget(target: URL): URL {
  // Cloudflare rejects Worker subrequests to some public IPv4 HTTP origins
  // with error 1003. sslip.io resolves the generated hostname back to the
  // exact same public address, while retaining the original port and path.
  if (target.protocol !== 'http:' || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(target.hostname)) return target;
  const output = new URL(target.href);
  output.hostname = `${target.hostname.replaceAll('.', '-')}.sslip.io`;
  return output;
}

async function fetchMediaUpstream(target: URL, method: string, headers: Headers): Promise<{ response: Response; url: URL }> {
  let url = target;
  const forwarded = new Headers(headers);
  // Match fetch's 20-redirect bound, validating/routing every hop rather than
  // allowing an automatic redirect to bypass the HTTP-IP transport adapter.
  for (let redirects = 0; ; redirects += 1) {
    const request = new Request(workerFetchTarget(url).href, { method, headers: forwarded, redirect: 'manual' });
    const response = await fetch(request, { cache: 'no-store' });
    const location = response.headers.get('Location');
    if (![301, 302, 303, 307, 308].includes(response.status) || !location) return { response, url };
    await response.body?.cancel();
    if (redirects >= 20) throw new Error('too many upstream redirects');
    const next = validatedTarget(new URL(location, url).href);
    if (next.origin !== url.origin) {
      forwarded.delete('Authorization');
      forwarded.delete('Proxy-Authorization');
      forwarded.delete('AuthInfo');
    }
    url = next;
  }
}

async function signUrl(target: URL, payload: MediaPayload, env: Env, requestUrl: URL): Promise<string> {
  const encoded = bytesToBase64Url(textEncoder.encode(JSON.stringify({ ...payload, u: target.href })).buffer);
  const signature = bytesToBase64Url(await hmac(encoded, env.PROXY_SIGNING_KEY));
  const output = new URL('/v1/media', requestUrl.origin);
  output.searchParams.set('p', encoded);
  output.searchParams.set('s', signature);
  return output.href;
}

async function replaceUriAttributes(line: string, baseUrl: URL, payload: MediaPayload, env: Env, requestUrl: URL): Promise<string> {
  const matches = [...line.matchAll(/URI="([^"]+)"/g)];
  let rewritten = line;
  for (const match of matches.reverse()) {
    const target = validatedTarget(new URL(match[1], baseUrl).href);
    const signed = await signUrl(target, payload, env, requestUrl);
    const start = match.index! + 5;
    rewritten = `${rewritten.slice(0, start)}${signed}${rewritten.slice(start + match[1].length)}`;
  }
  return rewritten;
}

async function rewriteManifest(text: string, upstreamUrl: URL, payload: MediaPayload, env: Env, requestUrl: URL): Promise<string> {
  const lines = text.split(/\r?\n/);
  const output: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      output.push(line);
    } else if (trimmed.startsWith('#')) {
      output.push(await replaceUriAttributes(line, upstreamUrl, payload, env, requestUrl));
    } else {
      output.push(await signUrl(validatedTarget(new URL(trimmed, upstreamUrl).href), payload, env, requestUrl));
    }
  }
  return output.join('\n');
}

async function resolveChannel(channel: string): Promise<URL> {
  if (!/^[A-Za-z0-9._-]{1,256}$/.test(channel)) throw new Error('invalid channel');
  const response = await fetch(`https://dws-license.thmirror2.workers.dev/atmsign?ch=${encodeURIComponent(channel)}`, {
    headers: { 'User-Agent': 'Doowiseplay' },
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`channel lookup failed (${response.status})`);
  const body = await response.json() as { ok?: boolean; url?: string };
  if (!body.ok || !body.url) throw new Error('channel unavailable');
  return validatedTarget(body.url);
}

async function readBoundedText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('Content-Length') || 0);
  if (declaredLength > MAX_MANIFEST_BYTES) throw new Error('manifest too large');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_MANIFEST_BYTES) throw new Error('manifest too large');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel(error instanceof Error ? error.message : 'manifest read failed');
    throw error;
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

async function inspectBody(response: Response): Promise<{ prefix: string; body: ReadableStream<Uint8Array> | null }> {
  if (!response.body) return { prefix: '', body: null };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let done = false;
  while (length < 1024 && !done) {
    const next = await reader.read();
    done = next.done;
    if (next.value) { chunks.push(next.value); length += next.value.byteLength; }
  }
  const prefixBytes = new Uint8Array(Math.min(length, 1024));
  let offset = 0;
  for (const chunk of chunks) {
    const count = Math.min(chunk.length, prefixBytes.length - offset);
    if (count > 0) prefixBytes.set(chunk.subarray(0, count), offset);
    offset += count;
  }
  return {
    prefix: new TextDecoder().decode(prefixBytes).replace(/^\uFEFF/, '').trimStart(),
    body: new ReadableStream<Uint8Array>({
      start(controller) { for (const chunk of chunks) controller.enqueue(chunk); if (done) controller.close(); },
      async pull(controller) {
        const next = await reader.read();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
      cancel(reason) { return reader.cancel(reason); },
    }),
  };
}

function copyResponseHeaders(upstream: Response, request: Request, env: Env): Headers {
  const headers = corsHeaders(request, env);
  for (const name of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges', 'Cache-Control', 'ETag', 'Last-Modified']) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

async function handleMedia(request: Request, env: Env, requestUrl: URL): Promise<Response> {
  const encoded = requestUrl.searchParams.get('p') || '';
  const signature = requestUrl.searchParams.get('s') || '';
  if (!(await verifySignature(encoded, signature, env.PROXY_SIGNING_KEY))) return jsonResponse(request, env, { error: 'invalid signature' }, 403);
  const payload = decodePayload(encoded);
  if (!Number.isFinite(payload.e) || payload.e < Date.now()) return jsonResponse(request, env, { error: 'link expired' }, 410);
  const signedTarget = payload.c ? await resolveChannel(payload.c) : validatedTarget(payload.u);
  const override = requestUrl.searchParams.get('u');
  let target = signedTarget;
  if (override) {
    const candidate = validatedTarget(override);
    const allowedOrigins = new Set([signedTarget.origin, ...(payload.o || [])]);
    if (!allowedOrigins.has(candidate.origin)) return jsonResponse(request, env, { error: 'target origin mismatch' }, 403);
    target = candidate;
  }
  const upstreamHeaders = new Headers();
  if (payload.r) upstreamHeaders.set('Referer', payload.r);
  if (payload.a) upstreamHeaders.set('User-Agent', payload.a);
  for (const [name, value] of Object.entries(payload.h || {})) upstreamHeaders.set(name, value);
  const range = request.headers.get('Range');
  if (range) upstreamHeaders.set('Range', range);
  const accept = request.headers.get('Accept');
  if (accept) upstreamHeaders.set('Accept', accept);

  const { response: upstream, url: upstreamUrl } = await fetchMediaUpstream(target, request.method, upstreamHeaders);
  const contentType = upstream.headers.get('Content-Type')?.toLowerCase() || '';
  const isManifest = contentType.includes('mpegurl') || /\.m3u8(?:$|\?)/i.test(target.href);
  const mayContainManifest = contentType.startsWith('text/plain') || /\.txt(?:$|\?)/i.test(target.href);
  const isDashManifest = contentType.includes('dash+xml') || /\.mpd(?:$|\?)/i.test(target.href);
  const headers = copyResponseHeaders(upstream, request, env);

  if (request.method === 'HEAD' || (!isManifest && !isDashManifest && !mayContainManifest) || !upstream.ok) return new Response(upstream.body, { status: upstream.status, headers });
  const inspected = await inspectBody(upstream);
  const hlsBody = inspected.prefix.startsWith('#EXTM3U');
  const dashBody = isDashManifest && inspected.prefix.startsWith('<');
  if (!hlsBody && !dashBody) {
    // Some providers label TS/AES segments as mpegurl, even with .html paths.
    // Preserve their bytes: decoding/re-signing binary content corrupts playback.
    if (contentType.includes('mpegurl')) headers.set('Content-Type', 'application/octet-stream');
    return new Response(inspected.body, { status: upstream.status, headers });
  }
  const manifest = await readBoundedText(new Response(inspected.body, { headers: upstream.headers }));
  // Relative resource URLs belong to the final upstream URL, not the DNS alias
  // used only to transport public HTTP-IP requests through Cloudflare.
  const manifestUrl = upstreamUrl;
  if (dashBody) {
    const origins = dashResourceOrigins(manifest, manifestUrl).map((origin) => validatedTarget(`${origin}/`).origin);
    const resourcePayload = { ...payload, o: [...new Set([...(payload.o || []), ...origins])] };
    if (resourcePayload.o.length > 8) throw new Error('too many DASH resource origins');
    headers.set('X-Media-Context', await signUrl(signedTarget, resourcePayload, env, requestUrl));
  }
  const rewritten = dashBody ? manifest : await rewriteManifest(manifest, manifestUrl, payload, env, requestUrl);
  headers.set('Content-Type', dashBody ? 'application/dash+xml; charset=utf-8' : 'application/vnd.apple.mpegurl; charset=utf-8');
  headers.delete('Content-Length');
  headers.set('Cache-Control', !dashBody && /#EXT-X-ENDLIST/.test(manifest) ? 'private, max-age=30' : 'no-store');
  headers.set('X-Media-Base', manifestUrl.href);
  return new Response(rewritten, { status: upstream.status, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request, env) });
      if (url.pathname === '/health' && request.method === 'GET') return jsonResponse(request, env, { ok: true, service: 'doowiseplay-proxy' });
        if (url.pathname === '/v1/sports-feed' && request.method === 'GET') {
          const feed = url.searchParams.get('feed') || '';
          if (!Object.hasOwn(SPORTS_FEEDS, feed)) return jsonResponse(request, env, { error: 'invalid sports feed' }, 400);
          const upstream = await fetch(`${SPORTS_ORIGIN}${SPORTS_FEEDS[feed]}`, { headers: SPORTS_HEADERS, signal: AbortSignal.timeout(15000), cf: { cacheEverything: true, cacheTtl: 60 } });
          if (!upstream.ok) return jsonResponse(request, env, { error: 'sports feed unavailable' }, upstream.status);
          const data = JSON.parse(await readBoundedText(upstream));
          return jsonResponse(request, env, data);
        }
      if (url.pathname !== '/v1/media' || !['GET', 'HEAD'].includes(request.method)) return jsonResponse(request, env, { error: 'not found' }, 404);
      return await handleMedia(request, env, url);
    } catch (error) {
      console.error(JSON.stringify({ message: 'request failed', path: url.pathname, error: error instanceof Error ? error.message : String(error) }));
      return jsonResponse(request, env, { error: 'proxy request failed' }, 502);
    }
  },
} satisfies ExportedHandler<Env>;
