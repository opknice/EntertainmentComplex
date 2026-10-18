import assert from 'node:assert/strict';
import { createHmac, timingSafeEqual } from 'node:crypto';
import test from 'node:test';
import worker from './src/index.ts';
import { dashResourceOrigins } from './src/dash.ts';

const environment = { PROXY_SIGNING_KEY: 'test-only-signing-key', ALLOWED_ORIGINS: 'https://app.example' };
const originalFetch = globalThis.fetch;
const originalTimingSafeEqual = crypto.subtle.timingSafeEqual;
crypto.subtle.timingSafeEqual = timingSafeEqual;
test.after(() => { globalThis.fetch = originalFetch; crypto.subtle.timingSafeEqual = originalTimingSafeEqual; });

test('public sports feed forwards only fixed fixture endpoints with the source headers', async () => {
  const requests = [];
  globalThis.fetch = async (url, options) => { requests.push({ url, options }); return Response.json({ '2026-10-18': [] }); };
  const ok = await worker.fetch(new Request('https://proxy.example/v1/sports-feed?feed=football&url=https://unrelated.example'), environment);
  assert.equal(ok.status, 200);
  assert.equal(requests[0].url, 'https://atmflix.live/api/fixtures/date');
  assert.equal(requests[0].options.headers.Origin, 'https://atmflix.live');
  const denied = await worker.fetch(new Request('https://proxy.example/v1/sports-feed?feed=unknown'), environment);
  assert.equal(denied.status, 400);
  assert.equal(requests.length, 1);
});

function signedUrl(source, fields = {}) {
  const payload = Buffer.from(JSON.stringify({ u: source, r: '', a: 'player-test', o: [new URL(source).origin], e: Date.now() + 60000, ...fields })).toString('base64url');
  const signature = createHmac('sha256', environment.PROXY_SIGNING_KEY).update(payload).digest('base64url');
  return `https://proxy.example/v1/media?p=${payload}&s=${signature}`;
}

test('DASH CDN origins follow nested bases and XML entities without granting arbitrary origins', () => {
  const xml = `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"><BaseURL>https://cdn.example/live/?x=1&amp;y=2</BaseURL><Period><BaseURL>../archive/</BaseURL><AdaptationSet><SegmentTemplate media="https://segments.example/$Number$.m4s" /></AdaptationSet></Period></MPD>`;
  assert.deepEqual(dashResourceOrigins(xml, new URL('https://origin.example/live.mpd')), ['https://origin.example', 'https://cdn.example', 'https://segments.example']);
  assert.throws(() => dashResourceOrigins('<!DOCTYPE MPD><MPD/>', new URL('https://origin.example/live.mpd')), /invalid DASH/);
  assert.throws(() => dashResourceOrigins('<MPD><BaseURL>broken', new URL('https://origin.example/live.mpd')), /invalid DASH/);
});

test('proxy preserves mislabeled binary segments byte for byte, including split response chunks', async () => {
  const bytes = Uint8Array.from({ length: 1504 }, (_, index) => index % 188 === 0 ? 0x47 : index % 256);
  globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(bytes.slice(0, 3)); controller.enqueue(bytes.slice(3)); controller.close();
  } }), { headers: { 'Content-Type': 'application/vnd.apple.mpegurl', 'Content-Length': String(bytes.length) } });
  const response = await worker.fetch(new Request(signedUrl('https://cdn.example/segment.html')), environment);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
});

test('DASH playback context grants only manifest-declared CDN locations, rejecting unrelated client overrides', async () => {
  const manifestUrl = signedUrl('https://origin.example/live.mpd');
  globalThis.fetch = async () => new Response('<MPD><BaseURL>https://cdn.example/live/</BaseURL><Period/></MPD>', { headers: { 'Content-Type': 'application/dash+xml' } });
  const response = await worker.fetch(new Request(manifestUrl), environment);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('access-control-expose-headers'), /X-Media-Context/);
  const context = new URL(response.headers.get('x-media-context'));
  const fetched = [];
  globalThis.fetch = async (request) => { fetched.push(request.url); return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'video/mp4' } }); };
  context.searchParams.set('u', 'https://cdn.example/live/segment.m4s');
  const segment = await worker.fetch(new Request(context), environment);
  assert.equal(segment.status, 200);
  assert.deepEqual(fetched, ['https://cdn.example/live/segment.m4s']);
  context.searchParams.set('u', 'https://unrelated.example/segment.m4s');
  const denied = await worker.fetch(new Request(context), environment);
  assert.equal(denied.status, 403);
  assert.equal(fetched.length, 1);
});

test('HLS manifests still rewrite child URLs and AES key references', async () => {
  globalThis.fetch = async () => new Response('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:6,\nsegment.ts\n', { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
  const response = await worker.fetch(new Request(signedUrl('https://cdn.example/live/index.m3u8')), environment);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const text = await response.text();
  const child = text.split('\n').find((line) => line.startsWith('https:'));
  const key = text.match(/URI="([^"]+)"/)[1];
  for (const [url, expected] of [[child, 'https://cdn.example/live/segment.ts'], [key, 'https://cdn.example/live/key.bin']]) {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://proxy.example');
    assert.equal(JSON.parse(Buffer.from(parsed.searchParams.get('p'), 'base64url')).u, expected);
  }
});

test('HTTP-IP redirects use the transport adapter at every hop while preserving canonical HLS resource bases', async () => {
  const requests = [];
  let released = 0;
  globalThis.fetch = async request => {
    requests.push({ url: request.url, redirect: request.redirect });
    if (requests.length === 1) return new Response(new ReadableStream({ cancel() { released++; } }), { status: 302, headers: { Location: 'http://198.51.100.20:2005/live/index.m3u8' } });
    if (requests.length === 2) return new Response('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:6,\nsegment.ts\n', { headers: { 'Content-Type': 'application/x-mpegURL' } });
    return new Response(new Uint8Array([0x47, 1, 2]), { headers: { 'Content-Type': 'video/mp2t' } });
  };
  const response = await worker.fetch(new Request(signedUrl('http://origin.example:2095/live.m3u8')), environment);
  assert.equal(response.status, 200);
  assert.equal(released, 1);
  assert.equal(response.headers.get('x-media-base'), 'http://198.51.100.20:2005/live/index.m3u8');
  const text = await response.text();
  const segment = text.split('\n').find(line => line.startsWith('https:'));
  const key = text.match(/URI="([^"]+)"/)[1];
  for (const [url, suffix] of [[segment, 'segment.ts'], [key, 'key.bin']]) {
    const parsed = new URL(url);
    assert.equal(JSON.parse(Buffer.from(parsed.searchParams.get('p'), 'base64url')).u, 'http://198.51.100.20:2005/live/' + suffix);
  }
  await worker.fetch(new Request(segment), environment);
  assert.deepEqual(requests, [
    { url: 'http://origin.example:2095/live.m3u8', redirect: 'manual' },
    { url: 'http://198-51-100-20.sslip.io:2005/live/index.m3u8', redirect: 'manual' },
    { url: 'http://198-51-100-20.sslip.io:2005/live/segment.ts', redirect: 'manual' },
  ]);
});

test('relative redirects retain media headers but do not forward authentication to another origin', async () => {
  const seen = [];
  globalThis.fetch = async request => {
    seen.push({ method: request.method, auth: request.headers.get('authorization'), authInfo: request.headers.get('authinfo'), range: request.headers.get('range'), agent: request.headers.get('user-agent'), referer: request.headers.get('referer') });
    if (seen.length === 1) return new Response(null, { status: 307, headers: { Location: './next' } });
    if (seen.length === 2) return new Response(null, { status: 303, headers: { Location: 'http://cdn.example:2095/final' } });
    return new Response(null, { headers: { 'Content-Type': 'video/mp4' } });
  };
  const url = signedUrl('http://origin.example:2095/start', { h: { Authorization: 'test-credential', AuthInfo: 'test-info' }, r: 'https://player.example/' });
  const response = await worker.fetch(new Request(url, { method: 'HEAD', headers: { Range: 'bytes=0-1023' } }), environment);
  assert.equal(response.status, 200);
  assert.deepEqual(seen.map(x => [x.method, x.auth, x.authInfo]), [['HEAD', 'test-credential', 'test-info'], ['HEAD', 'test-credential', 'test-info'], ['HEAD', null, null]]);
  assert.ok(seen.every(x => x.range === 'bytes=0-1023' && x.agent === 'player-test' && x.referer === 'https://player.example/'));
});

test('redirects reject private/unsupported destinations before fetching them and release their response bodies', async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    for (const target of ['http://127.0.0.1/private', 'http://10.0.0.1/private', 'http://[::1]/private', 'ftp://origin.example/file']) {
      let requests = 0, released = 0;
      globalThis.fetch = async () => { requests++; return new Response(new ReadableStream({ cancel() { released++; } }), { status: 302, headers: { Location: target } }); };
      const response = await worker.fetch(new Request(signedUrl('https://origin.example/file')), environment);
      assert.equal(response.status, 502);
      assert.equal(requests, 1);
      assert.equal(released, 1);
    }
  } finally { console.error = originalError; }
});

test('redirect loops are bounded like fetch and release every intermediate response', async () => {
  let requests = 0, released = 0;
  globalThis.fetch = async () => { requests++; return new Response(new ReadableStream({ cancel() { released++; } }), { status: 308, headers: { Location: './again' } }); };
  const originalError = console.error;
  console.error = () => {};
  try {
    const response = await worker.fetch(new Request(signedUrl('https://origin.example/again')), environment);
    assert.equal(response.status, 502);
    assert.equal(requests, 21);
    assert.equal(released, 21);
  } finally { console.error = originalError; }
});
