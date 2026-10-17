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

function signedUrl(source) {
  const payload = Buffer.from(JSON.stringify({ u: source, r: '', a: 'player-test', o: [new URL(source).origin], e: Date.now() + 60000 })).toString('base64url');
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
