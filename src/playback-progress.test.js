import assert from 'node:assert/strict';
import test from 'node:test';
import { clearPlaybackProgress, readPlaybackProgress, savePlaybackProgress } from './playback-progress.js';

function memoryStorage() {
  const values = new Map();
  return { values, getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}

test('progress is isolated by movie identity and browser storage, without retaining stream credentials', () => {
  const first = memoryStorage(), otherBrowser = memoryStorage();
  assert.deepEqual(savePlaybackProgress('movies:123', 123.4, 600, first), { saved: true, available: true });
  assert.equal(readPlaybackProgress('movies:123', first).progress.position, 123.4);
  assert.equal(readPlaybackProgress('movies:456', first).progress, null);
  assert.equal(readPlaybackProgress('ott:123', first).progress, null);
  assert.equal(readPlaybackProgress('movies:123', otherBrowser).progress, null);
  const record = JSON.parse([...first.values.values()][0]);
  assert.deepEqual(Object.keys(record).sort(), ['duration', 'position', 'updatedAt', 'version']);
});

test('restart or completed playback clears only the selected movie', () => {
  const storage = memoryStorage();
  savePlaybackProgress('first', 10, 600, storage); savePlaybackProgress('second', 20, 600, storage);
  assert.equal(clearPlaybackProgress('first', storage), true);
  assert.equal(readPlaybackProgress('first', storage).progress, null);
  assert.equal(readPlaybackProgress('second', storage).progress.position, 20);
});

test('rewinding to the beginning removes the old position without touching other movies', () => {
  const storage = memoryStorage();
  savePlaybackProgress('movie', 120, 600, storage);
  savePlaybackProgress('other', 40, 600, storage);
  assert.deepEqual(savePlaybackProgress('movie', .2, 600, storage), { saved: false, available: true });
  assert.equal(readPlaybackProgress('movie', storage).progress, null);
  assert.equal(readPlaybackProgress('other', storage).progress.position, 40);
});

test('unknown, live and completed durations and subsecond positions are not saved', () => {
  const storage = memoryStorage();
  for (const [position, duration] of [[0, 600], [.5, 600], [10, Infinity], [NaN, 600], [10, NaN], [600, 600], [610, 600]]) {
    assert.deepEqual(savePlaybackProgress('movie', position, duration, storage), { saved: false, available: true });
  }
  assert.equal(storage.values.size, 0);
});

test('malformed, oversized or future-version stored values do not become resume requests', () => {
  const storage = memoryStorage();
  savePlaybackProgress('movie', 10, 600, storage);
  const key = [...storage.values.keys()][0];
  for (const raw of ['{', 'x'.repeat(2049), 'null', JSON.stringify({ version: 2, position: 10, duration: 600, updatedAt: Date.now() }), JSON.stringify({ version: 1, position: '10', duration: 600, updatedAt: Date.now() })]) {
    storage.setItem(key, raw);
    assert.deepEqual(readPlaybackProgress('movie', storage), { progress: null, available: true });
  }
});

test('restricted storage and quota failures are reported without blocking video playback', () => {
  const storage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); }, removeItem() { throw new Error('denied'); } };
  assert.deepEqual(readPlaybackProgress('movie', storage), { progress: null, available: false });
  assert.deepEqual(savePlaybackProgress('movie', 10, 600, storage), { saved: false, available: false });
  assert.equal(clearPlaybackProgress('movie', storage), false);
});
