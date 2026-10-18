const PREFIX = 'entertainment-complex:watch-position:v1:';

function storageFor(storage) { return storage === undefined ? globalThis.localStorage : storage; }
function keyFor(identity) { return PREFIX + encodeURIComponent(identity); }

export function readPlaybackProgress(identity, storage) {
  if (!identity) return { progress: null, available: true };
  let raw;
  try {
    const target = storageFor(storage);
    if (!target) return { progress: null, available: false };
    raw = target.getItem(keyFor(identity));
  } catch { return { progress: null, available: false }; }
  if (!raw || raw.length > 2048) return { progress: null, available: true };
  try {
    const value = JSON.parse(raw);
    if (value?.version !== 1 || !Number.isFinite(value.position) || value.position < 1 || !Number.isFinite(value.duration) || value.duration <= value.position || !Number.isFinite(value.updatedAt)) return { progress: null, available: true };
    return { progress: { position: value.position, duration: value.duration, updatedAt: value.updatedAt }, available: true };
  } catch { return { progress: null, available: true }; }
}

export function savePlaybackProgress(identity, position, duration, storage) {
  if (!identity || !Number.isFinite(position) || position < 0 || !Number.isFinite(duration) || duration <= position) return { saved: false, available: true };
  // Returning to the beginning must not leave an older, later bookmark behind.
  if (position < 1) return { saved: false, available: clearPlaybackProgress(identity, storage) };
  try {
    const target = storageFor(storage);
    if (!target) return { saved: false, available: false };
    target.setItem(keyFor(identity), JSON.stringify({ version: 1, position, duration, updatedAt: Date.now() }));
    return { saved: true, available: true };
  } catch { return { saved: false, available: false }; }
}

export function clearPlaybackProgress(identity, storage) {
  if (!identity) return true;
  try {
    const target = storageFor(storage);
    if (!target) return false;
    target.removeItem(keyFor(identity));
    return true;
  } catch { return false; }
}
