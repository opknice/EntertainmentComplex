import assert from 'node:assert/strict';
import test from 'node:test';
import { formatMediaTime, mediaRanges, probeVolume, seekMedia, seekPosition, setMediaVolume, tapAction, verticalGesture } from './player-controls.js';

const ranges = entries => ({ length: entries.length, start: index => entries[index][0], end: index => entries[index][1] });

test('seek positions remain in actual ranges, including gaps and unseekable streams', () => {
  const parsed = mediaRanges(ranges([[10, 20], [30, 50], [60, Infinity]]));
  assert.deepEqual(parsed, [{ start: 10, end: 20 }, { start: 30, end: 50 }]);
  assert.equal(seekPosition(parsed, 12), 12);
  assert.equal(seekPosition(parsed, -10), 10);
  assert.equal(seekPosition(parsed, 24), 20);
  assert.equal(seekPosition(parsed, 28), 30);
  assert.equal(seekPosition(parsed, 100), 50);
  assert.equal(seekPosition(parsed, NaN), null);
  assert.equal(seekPosition([], 30), null);
});

test('live seeks clamp before live edge; unavailable and rejected seeks are not reported as successful', () => {
  const video = { seekable: ranges([[100, 130]]), currentTime: 110 };
  assert.equal(seekMedia(video, 150, true), 129.9);
  assert.equal(video.currentTime, 129.9);
  assert.equal(seekMedia({ seekable: ranges([]) }, 10), null);
  assert.equal(seekMedia({ seekable: ranges([[0, 50]]), set currentTime(_value) { throw new Error('not ready'); } }, 10), null);
});

test('volume capability probe restores both volume and mute without exposing a fake successful adjustment', () => {
  const video = { volume: 0, muted: false };
  assert.equal(probeVolume(video), true);
  assert.equal(video.volume, 0); assert.equal(video.muted, false);
  assert.equal(setMediaVolume(video, 1.5), true); assert.equal(video.volume, 1);
  const restricted = { muted: false, get volume() { return 1; }, set volume(_value) {} };
  assert.equal(probeVolume(restricted), false); assert.equal(restricted.muted, false);
  assert.equal(setMediaVolume(restricted, 0.5), false);
  const throwing = { muted: false, get volume() { return 1; }, set volume(_value) { throw new Error('restricted'); } };
  assert.equal(probeVolume(throwing), false); assert.equal(throwing.muted, false);
});

test('left vertical swipes adjust volume and right vertical swipes adjust image brightness with safe bounds', () => {
  const start = { x: 30, y: 100, height: 200, volume: 0.5, brightness: 1, side: 'left' };
  assert.deepEqual(verticalGesture(start, 30, 60), { kind: 'volume', value: 0.8 });
  assert.deepEqual(verticalGesture(start, 30, 400), { kind: 'volume', value: 0 });
  assert.deepEqual(verticalGesture({ ...start, side: 'right' }, 30, 60), { kind: 'brightness', value: 1.3 });
  assert.deepEqual(verticalGesture({ ...start, side: 'right' }, 30, 400), { kind: 'brightness', value: 0.25 });
  assert.equal(verticalGesture(start, 30, 95), null);
  assert.equal(verticalGesture(start, 100, 120), null);
});

test('double taps seek only matching sides, accumulate feedback, and expire without cross-side seeks', () => {
  const first = tapAction(null, 10, 100, 1000);
  assert.equal(first.delta, 0);
  const second = tapAction(first, 10, 100, 1200);
  assert.equal(second.delta, -10); assert.equal(second.total, 10);
  assert.equal(tapAction(second, 10, 100, 1400).total, 20);
  assert.equal(tapAction(second, 90, 100, 1300).delta, 0);
  assert.equal(tapAction(second, 10, 100, 1600).delta, 0);
  const center = tapAction(null, 50, 100, 1000);
  assert.equal(tapAction(center, 50, 100, 1200).delta, 0);
  assert.equal(tapAction(tapAction(null, 90, 100, 1000), 90, 100, 1200).delta, 10);
});

test('time labels support long movies, negative offsets and unknown durations', () => {
  assert.equal(formatMediaTime(3661), '1:01:01');
  assert.equal(formatMediaTime(61.9), '1:01');
  assert.equal(formatMediaTime(-2), '0:00');
  assert.equal(formatMediaTime(Infinity), '0:00');
});
