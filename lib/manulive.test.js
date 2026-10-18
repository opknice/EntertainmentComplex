import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveManuLive } from './manulive.js';

function documents(generation = 'abc-123', id = 'channel-id') {
  return {
    '/manulive.json': { section: 'ott', group: 'sport all', title: 'MonoMax | sp 5' },
    '/data/catalog.json': { ottSummary: { indexUrl: `/data/ott/${generation}/index.json` } },
    [`/data/ott/${generation}/index.json`]: { version: generation, partsBase: `/data/ott/${generation}`, entries: [[id, 'MonoMax | sp 5', 'sport all', 2], ['other', 'MonoMax | sp 4', 'sport all', 2], ['excluded', 'Other group', 'Elsewhere', 5]] },
    [`/data/ott/${generation}/part-2.json`]: { version: generation, items: [{ id, title: 'MonoMax | sp 5', playUrl: 'https://proxy.example/latest' }, { id: 'other', title: 'MonoMax | sp 4', playUrl: 'https://proxy.example/other' }] },
  };
}

test('fixed page resolves the newest catalog ID and signed stream without downloading unrelated shards', async () => {
  for (const [generation, id] of [['abc-123', 'old-id'], ['def-456', 'new-id']]) {
    const docs = documents(generation, id), reads = [];
    const result = await resolveManuLive(async path => { reads.push(path); return docs[path]; });
    assert.equal(result.item.id, id);
    assert.equal(result.choices.length, 2);
    assert.equal(reads.length, 4);
  }
});

test('TV channel preference uses only listed channels and a new central configuration resets an old preference', async () => {
  const docs = documents(); const read = async path => docs[path];
  const initial = await resolveManuLive(read);
  assert.equal((await resolveManuLive(read, 'MonoMax | sp 4', initial.revision)).item.id, 'other');
  assert.equal((await resolveManuLive(read, 'https://unrelated.example', initial.revision)).item, null);
  docs['/manulive.json'].title = 'MonoMax | sp 4';
  assert.equal((await resolveManuLive(read, 'MonoMax | sp 5', initial.revision)).item.id, 'other');
});

test('missing or moving channels keep a chooser and never silently substitute a different broadcast', async () => {
  const docs = documents(); docs['/manulive.json'].title = 'Moved channel';
  const result = await resolveManuLive(async path => docs[path]);
  assert.equal(result.item, null);
  assert.equal(result.choices.length, 2);
});

test('central config can move the same URL to a live TV channel', async () => {
  const docs = { '/manulive.json': { section: 'live', group: '', title: 'New live channel' }, '/data/catalog.json': { live: [{ id: 'live-new', title: 'New live channel', playUrl: 'https://proxy.example/live' }] } };
  assert.equal((await resolveManuLive(async path => docs[path])).item.id, 'live-new');
});
