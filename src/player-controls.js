export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function mediaRanges(ranges) {
  const result = [];
  for (let index = 0; index < (ranges?.length || 0); index++) {
    const start = ranges.start(index), end = ranges.end(index);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) result.push({ start, end });
  }
  return result;
}

export function seekPosition(ranges, target) {
  if (!ranges.length || !Number.isFinite(target)) return null;
  for (const range of ranges) if (target >= range.start && target <= range.end) return target;
  return ranges.flatMap(range => [range.start, range.end]).reduce((best, edge) => Math.abs(edge - target) < Math.abs(best - target) ? edge : best);
}

export function seekMedia(video, target, live = false) {
  const ranges = mediaRanges(video.seekable);
  if (live && ranges.length) {
    const last = ranges.at(-1);
    target = Math.min(target, Math.max(last.start, last.end - 0.1));
  }
  const position = seekPosition(ranges, target);
  if (position === null) return null;
  try { video.currentTime = position; return position; } catch { return null; }
}

export function probeVolume(video) {
  const original = video.volume, muted = video.muted;
  try {
    video.muted = true;
    const probe = original >= 0.5 ? original - 0.01 : original + 0.01;
    video.volume = probe;
    return Math.abs(video.volume - probe) < 0.001;
  } catch { return false; }
  finally {
    try { video.volume = original; } catch { /* Restricted volume setters may throw. */ }
    try { video.muted = muted; } catch { /* Device-managed mute may also reject writes. */ }
  }
}

export function setMediaVolume(video, value) {
  const next = clamp(value, 0, 1);
  try {
    video.volume = next;
    if (Math.abs(video.volume - next) > 0.001) return false;
    if (next > 0) video.muted = false;
    return true;
  } catch { return false; }
}

export function formatMediaTime(seconds) {
  if (!Number.isFinite(seconds)) return '0:00';
  const value = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(value / 3600), minutes = Math.floor(value % 3600 / 60), remainder = value % 60;
  return `${hours ? hours + ':' + String(minutes).padStart(2, '0') : minutes}:${String(remainder).padStart(2, '0')}`;
}

export function tapAction(previous, x, width, time) {
  const region = x < width * 0.4 ? 'left' : x > width * 0.6 ? 'right' : 'center';
  if (region !== 'center' && previous?.region === region && time - previous.time <= 300) {
    const total = (previous.total || 0) + 10;
    return { region, time, total, delta: region === 'left' ? -10 : 10 };
  }
  return { region, time, total: 0, delta: 0 };
}

export function verticalGesture(start, x, y) {
  const dx = x - start.x, dy = y - start.y;
  if (Math.abs(dy) < 12 || Math.abs(dy) <= Math.abs(dx) * 1.2) return null;
  return start.side === 'left'
    ? { kind: 'volume', value: clamp(start.volume - dy / start.height * 1.5, 0, 1) }
    : { kind: 'brightness', value: clamp(start.brightness - dy / start.height * 1.5, 0.25, 1.75) };
}
