import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecoveryBudget, recoverablePlaybackError } from './playback-recovery.js';

test('only temporary failures retry; authorization, missing source and DRM do not loop', () => {
  for (const message of ['HTTP 408', 'HTTP 429', 'HTTP 502', 'stream_timeout', 'playback_timeout', 'video_error_2', 'networkError']) assert.equal(recoverablePlaybackError(new Error(message)), true, message);
  for (const message of ['HTTP 401', 'HTTP 403', 'HTTP 404', 'HTTP 410', 'video_error_4', 'DRM_NO_RECOGNIZED_KEY_SYSTEMS', 'HIGHEST_QUALITY_UNAVAILABLE']) assert.equal(recoverablePlaybackError(new Error(message)), false, message);
  assert.equal(recoverablePlaybackError({ code: 1001, data: ['redacted', 503] }), true);
  assert.equal(recoverablePlaybackError({ code: 1001, data: ['redacted', 403] }), false);
});

test('retry budget survives short recoveries, resets only after a stable minute', () => {
  const b = createRecoveryBudget();
  const error = new Error('playback_timeout');
  assert.deepEqual([0, 1, 2, 3, 4].map(() => b.next(error).delay), [2000, 5000, 10000, 20000, 30000]);
  assert.equal(b.next(error), null);
  b.progressing(0); b.progressing(59000); b.stalled(); b.progressing(60000);
  assert.equal(b.next(error), null);
  b.progressing(100000); b.progressing(160000);
  assert.equal(b.next(error).attempt, 1);
});

test('manual retry resets budget and rate limits are not retried immediately', () => {
  const b = createRecoveryBudget();
  assert.equal(b.next(new Error('HTTP 429')).delay, 30000);
  assert.equal(b.next({ code: 1001, data: ['redacted', 429] }).delay, 30000);
  b.reset();
  assert.equal(b.next(new Error('stream_timeout')).attempt, 1);
});
