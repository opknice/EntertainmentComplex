function fullscreenTarget(video) {
  return video?.closest?.('[data-player-surface]') || video;
}

export function isVideoFullscreen(video) {
  if (!video) return false;
  const document = video.ownerDocument;
  const target = fullscreenTarget(video);
  return document?.fullscreenElement === target || document?.webkitFullscreenElement === target || document?.fullscreenElement === video || document?.webkitFullscreenElement === video || Boolean(video.webkitDisplayingFullscreen);
}

export function enterVideoFullscreen(video) {
  if (!video) return Promise.resolve(false);
  if (isVideoFullscreen(video)) return Promise.resolve(true);
  try {
    const target = fullscreenTarget(video);
    const request = target.requestFullscreen || target.webkitRequestFullscreen;
    if (request && video.ownerDocument?.fullscreenEnabled !== false) return Promise.resolve(request.call(target, { navigationUI: 'hide' })).then(() => true, () => false);
    // iPhone's native video API requires metadata; retry once the stream is ready.
    // Native video fullscreen hides web dialogs; keep the resume choice visible.
    if (video.dataset?.playbackBlocked !== 'true' && video.webkitEnterFullscreen && video.readyState >= 1) {
      video.webkitEnterFullscreen();
      return Promise.resolve(true);
    }
  } catch { /* A blocked request remains recoverable through a user tap. */ }
  return Promise.resolve(false);
}

export function leaveVideoFullscreen(video) {
  if (!video || !isVideoFullscreen(video)) return Promise.resolve();
  const document = video.ownerDocument;
  try {
    if (video.webkitDisplayingFullscreen && video.webkitExitFullscreen) {
      video.webkitExitFullscreen();
      return Promise.resolve();
    }
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    return Promise.resolve(exit?.call(document)).catch(() => {});
  } catch { return Promise.resolve(); }
}

export function startVideoPresentation(video, fullscreen = true) {
  // Both calls happen in the original tap, before any asynchronous catalog work.
  // Start playback first: requesting fullscreen can consume transient activation.
  let playback;
  try { playback = video.dataset?.playbackBlocked === 'true' ? Promise.resolve(false) : Promise.resolve(video.play()).then(() => true, () => false); }
  catch { playback = Promise.resolve(false); }
  const presentation = fullscreen ? enterVideoFullscreen(video) : Promise.resolve(true);
  return Promise.all([playback, presentation]).then(([playing, fullscreenAccepted]) => ({ playing, fullscreenAccepted }));
}
