import assert from 'node:assert/strict';
import test from 'node:test';
import { enterVideoFullscreen, isVideoFullscreen, leaveVideoFullscreen, startVideoPresentation } from './player-presentation.js';

test('plays and requests fullscreen on the video synchronously in gesture order', async () => {
  const calls = [];
  const video = {
    ownerDocument: {},
    play() { assert.equal(this, video); calls.push('play'); return Promise.resolve(); },
    requestFullscreen(options) { assert.equal(this, video); assert.equal(options.navigationUI, 'hide'); calls.push('fullscreen'); return Promise.resolve(); },
  };
  const pending = startVideoPresentation(video);
  assert.deepEqual(calls, ['play', 'fullscreen']);
  assert.deepEqual(await pending, { playing: true, fullscreenAccepted: true });
});

test('reports blocked playback and fullscreen without unhandled rejections', async () => {
  const video = { ownerDocument: {}, play: () => Promise.reject(new Error('NotAllowedError')), requestFullscreen: () => Promise.reject(new Error('Denied')) };
  assert.deepEqual(await startVideoPresentation(video), { playing: false, fullscreenAccepted: false });
});

test('inline playback does not request fullscreen', async () => {
  const video = { ownerDocument: {}, play: () => Promise.resolve(), requestFullscreen: () => { throw new Error('must not call'); } };
  assert.deepEqual(await startVideoPresentation(video, false), { playing: true, fullscreenAccepted: true });
});

test('an existing video fullscreen session is not requested twice', async () => {
  const video = { ownerDocument: {}, requestFullscreen: () => { throw new Error('must not call'); } };
  video.ownerDocument.fullscreenElement = video;
  assert.equal(isVideoFullscreen(video), true);
  assert.equal(await enterVideoFullscreen(video), true);
});

test('Safari native video fullscreen waits for metadata and uses the video receiver', async () => {
  let entered = 0, exited = 0;
  const video = {
    ownerDocument: {}, readyState: 0,
    webkitEnterFullscreen() { assert.equal(this, video); entered++; this.webkitDisplayingFullscreen = true; },
    webkitExitFullscreen() { assert.equal(this, video); exited++; this.webkitDisplayingFullscreen = false; },
  };
  assert.equal(await enterVideoFullscreen(video), false);
  assert.equal(entered, 0);
  video.readyState = 1;
  assert.equal(await enterVideoFullscreen(video), true);
  assert.equal(entered, 1);
  assert.equal(isVideoFullscreen(video), true);
  await leaveVideoFullscreen(video);
  assert.equal(exited, 1);
});

test('supports the prefixed element fullscreen API', async () => {
  const video = { ownerDocument: {}, webkitRequestFullscreen() { this.ownerDocument.webkitFullscreenElement = this; } };
  assert.equal(await enterVideoFullscreen(video), true);
  assert.equal(isVideoFullscreen(video), true);
});

test('only exits fullscreen owned by this video', async () => {
  let exits = 0;
  const document = { fullscreenElement: {}, exitFullscreen() { assert.equal(this, document); exits++; return Promise.resolve(); } };
  const video = { ownerDocument: document };
  await leaveVideoFullscreen(video);
  assert.equal(exits, 0);
  document.fullscreenElement = video;
  await leaveVideoFullscreen(video);
  assert.equal(exits, 1);
});

test('unsupported and synchronously throwing APIs remain recoverable', async () => {
  assert.equal(await enterVideoFullscreen(null), false);
  assert.equal(await enterVideoFullscreen({ ownerDocument: {} }), false);
  const video = { ownerDocument: {}, play() { throw new Error('blocked'); }, requestFullscreen() { throw new Error('blocked'); } };
  assert.deepEqual(await startVideoPresentation(video), { playing: false, fullscreenAccepted: false });
  await leaveVideoFullscreen(null);
});
