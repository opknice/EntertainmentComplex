import assert from 'node:assert/strict';
import test from 'node:test';
import { detectStreamType, proxyResourceUrl, sourceUrl } from './playback.js';

const originalFetch = globalThis.fetch;

test.afterEach(() => { globalThis.fetch = originalFetch; });

test('falls back to GET when an IPTV origin rejects HEAD', async () => {
  const calls = [];
  globalThis.fetch = async (_url, options = {}) => {
    calls.push(options);
    if (options.method === 'HEAD') return new Response('', { status: 403 });
    return new Response('#EXTM3U\n#EXT-X-VERSION:3', {
      headers: { 'content-type': 'application/vnd.apple.mpegurl' },
    });
  };

  assert.equal(await detectStreamType({ streamType: 'AUTO', playUrl: 'https://proxy.example/media' }), 'HLS');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].headers.Range, 'bytes=0-1023');
});

test('uses the GET content type for extensionless media', async () => {
  globalThis.fetch = async (_url, options = {}) => options.method === 'HEAD'
    ? new Response('', { status: 405 })
    : new Response(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), {
        headers: { 'content-type': 'video/x-matroska' },
      });

  assert.equal(await detectStreamType({ streamType: 'AUTO', playUrl: 'https://proxy.example/media' }), 'วิดีโอ');
});

test('resolves relative manifests against their upstream URL without double proxying', () => {
  const playUrl = 'https://proxy.example/v1/media?p=abc&s=def';
  const nested = proxyResourceUrl(playUrl, '../video/child.m3u8', 'https://origin.example/live/master/index.m3u8');
  assert.equal(new URL(nested).searchParams.get('u'), 'https://origin.example/live/video/child.m3u8');
  assert.equal(proxyResourceUrl(playUrl, playUrl, 'https://origin.example/live/master.m3u8'), playUrl);
});

test('recovers the original source URL from a signed proxy URL', () => {
  const payload = Buffer.from(JSON.stringify({ u: 'http://origin.example/live' })).toString('base64url');
  assert.equal(sourceUrl({ playUrl: `https://proxy.example/v1/media?p=${payload}&s=sig` }), 'http://origin.example/live');
});
