import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { fetchSportsCatalog, sportTimestamp, isRelevantSport } from './sports-catalog.js';

const now = Date.parse('2026-10-18T12:00:00Z');
const fixture = { channel: 'match_1', event_time: '2026-10-18 20:00:00+07', teamhome: { name: 'Home' }, teamaway: { name: 'Away' }, status_short: 'NS' };

test('source UTC offsets normalize once and stale or finished matches leave the catalog', () => {
  for (const value of ['2026-10-18 20:00:00+07', '2026-10-18 20:00:00+0700', '2026-10-18T20:00:00+07:00', '2026-10-18 20:00:00']) assert.equal(sportTimestamp(value), Date.parse('2026-10-18T13:00:00Z'));
  assert.equal(isRelevantSport({ time: '2026-10-17 10:00:00+07' }, now), false);
  assert.equal(isRelevantSport({ time: fixture.event_time, status: 'FT' }, now), false);
  assert.equal(isRelevantSport({ time: fixture.event_time }, now), true);
});

test('live and static paths preserve existing channel identities and remove stale fallback on failure', async () => {
  const result = await fetchSportsCatalog({ now, previousSports: [
    { sport: 'event', title: 'Old', channel: 'old', time: '2026-10-17 10:00:00+07' },
    { sport: 'event', title: 'Current', channel: 'current', time: fixture.event_time },
  ], loadFeed: async feed => { if (feed === 'event') throw new Error('HTTP 403'); return feed === 'football' ? { '2026-10-18': [fixture] } : []; } });
  assert.equal(result.items.length, 2);
  assert.equal(result.fallbackCount, 1);
  assert.deepEqual(result.failures, [{ source: 'event', reason: 'HTTP 403' }]);
  const expected = createHash('sha256').update(`football:Home vs Away:${fixture.event_time}\0match_1`).digest('base64url').slice(0, 22);
  assert.equal(result.items.find(item => item.sport === 'football').id, expected);
});

test('valid empty feeds clear old entries; invalid HTTP-200 error bodies preserve relevant fallback', async () => {
  const previousSports = [{ sport: 'football', title: 'Current', channel: 'current', time: fixture.event_time }];
  const empty = await fetchSportsCatalog({ now, previousSports, loadFeed: async () => [] });
  assert.equal(empty.items.length, 0);
  assert.equal(empty.failures.length, 0);
  const invalid = await fetchSportsCatalog({ now, previousSports, loadFeed: async feed => feed === 'football' ? { error: 'blocked' } : [] });
  assert.equal(invalid.fallbackCount, 1);
  assert.equal(invalid.failures[0].source, 'football');
});
