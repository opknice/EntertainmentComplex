import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cleanupOttGenerations, parseOttPlaylist } from './ott-catalog.mjs';

test('preserves movies, series, live groups and quoted commas without following status/trap URLs', () => {
  const { items, placeholders } = parseOttPlaylist(`#EXTM3U
#EXTINF:-1 type="movie" group-title="Movies, new",Film, part 2
https://media.example/film.mp4
#EXTINF:-1 type="series" group-title="Series" tvg-season="2" tvg-episode="3",Episode 3
https://media.example/episode.m3u8
#EXTINF:-1 group-title="TV",News
http://media.example/live.m3u8
#EXTINF:-1,Approval
http://error.com
#EXTINF:-1,Trap
https://doowiseplayfree.thmirror2.workers.dev/playlist.m3u?id=HONEYPOT_9999`);
  assert.equal(items.length, 3);
  assert.equal(placeholders, 2);
  assert.equal(items[0].title, 'Film, part 2');
  assert.equal(items[0].group, 'Movies, new');
  assert.equal(items[1].season, '2');
  assert.equal(items[2].url, 'http://media.example/live.m3u8');
});

test('keeps request headers, manifest format and source ClearKey values', () => {
  const keyId = 'a'.repeat(32);
  const key = 'b'.repeat(32);
  const { items: [item] } = parseOttPlaylist(`#EXTM3U
#EXTINF:-1,Protected channel
#EXTVLCOPT:http-referrer=https://provider.example/
#KODIPROP:inputstream.ffmpegdirect.http_user_agent=OTT test
#KODIPROP:inputstream.adaptive.manifest_type=mpd
#KODIPROP:inputstream.adaptive.stream_headers=Origin=https%3A%2F%2Fprovider.example&authinfo=token
#KODIPROP:inputstream.adaptive.license_type=clearkey
#KODIPROP:inputstream.adaptive.license_key=${keyId}:${key}
https://media.example/stream`);
  assert.equal(item.streamType, 'DASH');
  assert.equal(item.userAgent, 'OTT test');
  assert.equal(item.referer, 'https://provider.example/');
  assert.equal(item.headers.Origin, 'https://provider.example');
  assert.deepEqual(item.clearKeys, { [keyId]: key });
});

test('keeps multiple comma-separated ClearKey pairs supplied by the playlist', () => {
  const firstId = '00112233445566778899aabbccddeeff';
  const firstKey = 'ffeeddccbbaa99887766554433221100';
  const secondId = '102132435465768798a9bacbdcedfe0f';
  const secondKey = '0ffedccbaa9988776655443322110010';
  const { items: [item] } = parseOttPlaylist(`#EXTM3U
#EXTINF:-1 group-title="Sport MPD",Multi-key channel
#KODIPROP:inputstream.adaptive.license_type=org.w3.clearkey
#KODIPROP:inputstream.adaptive.license_key=${firstId}:${firstKey},${secondId}:${secondKey}
https://media.example/manifest.mpd`);
  assert.deepEqual(item.clearKeys, { [firstId]: firstKey, [secondId]: secondKey });
  assert.equal(item.playbackError, undefined);
});

test('rejects approval/error responses so refresh cannot replace a valid catalog with status entries', () => {
  assert.throws(() => parseOttPlaylist('Forbidden'), /not an M3U/);
  assert.throws(() => parseOttPlaylist('#EXTM3U\n#EXTINF:-1,Unknown ID\nhttp://error.com'), /no playable entries/);
});

test('stable identity survives unrelated insertions while repeated source entries remain distinct', () => {
  const record = '#EXTINF:-1,News\nhttps://media.example/live.m3u8\n';
  const original = parseOttPlaylist(`#EXTM3U\n${record}${record}`).items;
  const changed = parseOttPlaylist(`#EXTM3U\n#EXTINF:-1,Added\nhttps://media.example/new.m3u8\n${record}${record}`).items;
  assert.notEqual(original[0].id, original[1].id);
  assert.equal(original[0].id, changed[1].id);
  assert.equal(original[1].id, changed[2].id);
});

test('unknown extensions stay AUTO while text playlists are recognized as HLS', () => {
  const { items } = parseOttPlaylist(`#EXTM3U
#EXTINF:-1,Extensionless video
https://media.example/stream
#EXTINF:-1,Text HLS
https://media.example/playlist.txt`);
  assert.equal(items[0].streamType, 'AUTO');
  assert.equal(items[1].streamType, 'HLS');
});

test('generation cleanup retains current and previous catalogs only', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ott-generations-'));
  const folder = path.join(root, 'public/data/ott');
  const current = 'a'.repeat(20) + '-current';
  const previous = 'b'.repeat(20) + '-previous';
  const stale = 'c'.repeat(20) + '-stale';
  fs.mkdirSync(path.join(folder, current), { recursive: true });
  fs.mkdirSync(path.join(folder, previous));
  fs.mkdirSync(path.join(folder, stale));
  fs.mkdirSync(path.join(folder, 'unrelated'));
  try {
    cleanupOttGenerations(root, current, previous);
    assert.deepEqual(fs.readdirSync(folder).sort(), [current, previous, 'unrelated'].sort());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
