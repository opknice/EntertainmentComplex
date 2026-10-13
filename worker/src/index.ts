const MAX_MANIFEST_BYTES = 5 * 1024 * 1024;
const textEncoder = new TextEncoder();

type MediaPayload = {
  u: string;
  r: string;
  a: string;
  e: number;
};

function corsHeaders(request: Request, env: Env): Headers {
  const origin = request.headers.get('Origin') || '';
  const allowed = env.ALLOWED_ORIGINS.split(',').map((item) => item.trim()).filter(Boolean);
  const headers = new Headers({
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Content-Type',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type',
    'Vary': 'Origin',
  });
  if (allowed.includes(origin)) headers.set('Access-Control-Allow-Origin', origin);
  return headers;
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
  if (record.u.length > 8_192 || record.r.length > 2_048 || record.a.length > 512) throw new Error('payload too large');
  return { u: record.u, r: record.r, a: record.a, e: record.e };
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
  if (url.protocol !== 'https:' || isPrivateHostname(url.hostname)) throw new Error('target not allowed');
  return url;
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
  const target = validatedTarget(payload.u);
  const upstreamHeaders = new Headers();
  if (payload.r) upstreamHeaders.set('Referer', payload.r);
  if (payload.a) upstreamHeaders.set('User-Agent', payload.a);
  const range = request.headers.get('Range');
  if (range) upstreamHeaders.set('Range', range);
  const accept = request.headers.get('Accept');
  if (accept) upstreamHeaders.set('Accept', accept);

  const upstream = await fetch(target, { method: request.method, headers: upstreamHeaders, redirect: 'follow' });
  const contentType = upstream.headers.get('Content-Type')?.toLowerCase() || '';
  const isManifest = contentType.includes('mpegurl') || /\.m3u8(?:$|\?)/i.test(target.href);
  const headers = copyResponseHeaders(upstream, request, env);

  if (request.method === 'HEAD' || !isManifest || !upstream.ok) return new Response(upstream.body, { status: upstream.status, headers });
  const manifest = await readBoundedText(upstream);
  const rewritten = await rewriteManifest(manifest, new URL(upstream.url || target.href), payload, env, requestUrl);
  headers.set('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
  headers.delete('Content-Length');
  headers.set('Cache-Control', 'private, max-age=30');
  return new Response(rewritten, { status: upstream.status, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request, env) });
      if (url.pathname === '/health' && request.method === 'GET') return jsonResponse(request, env, { ok: true, service: 'doowiseplay-proxy' });
      if (url.pathname !== '/v1/media' || !['GET', 'HEAD'].includes(request.method)) return jsonResponse(request, env, { error: 'not found' }, 404);
      return await handleMedia(request, env, url);
    } catch (error) {
      console.error(JSON.stringify({ message: 'request failed', path: url.pathname, error: error instanceof Error ? error.message : String(error) }));
      return jsonResponse(request, env, { error: 'proxy request failed' }, 502);
    }
  },
} satisfies ExportedHandler<Env>;
