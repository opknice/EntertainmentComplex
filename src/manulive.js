import Hls from 'hls.js';
import { highestHlsConfig, highestQualityIndex, lockHlsToHighest, playbackErrorMessage } from './playback.js';
import { createRecoveryBudget } from './playback-recovery.js';

// This entry is built separately for Chromium 56 (Samsung's 2018 TV engine).
const video = document.getElementById('tv-video');
const panel = document.getElementById('tv-panel');
const status = document.getElementById('tv-status');
const title = document.getElementById('tv-title');
const settings = document.getElementById('tv-channel-settings');
const channels = document.getElementById('tv-channels');
const budget = createRecoveryBudget();
let hls, item, itemKey = '', revision = '', selection = '', requestId = 0;
let wantsPlay = true, failed = false, retryTimer, hideTimer, refreshing = false;
let lastTime = 0, lastAdvance = Date.now(), remembered, queuedRefresh = false, queuedForce = false;
try { remembered = JSON.parse(localStorage.getItem('manulive-channel') || 'null'); } catch { /* Playback works without storage. */ }
if (remembered) { selection = remembered.title || ''; revision = remembered.revision || ''; }

function show(message) {
  if (message) status.textContent = message;
  panel.classList.remove('is-hidden');
  clearTimeout(hideTimer);
  if (!settings.hidden || video.paused || failed) return;
  hideTimer = setTimeout(() => panel.classList.add('is-hidden'), 5000);
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url); xhr.timeout = 25000;
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) { reject(new Error(`HTTP ${xhr.status}`)); return; }
      try { resolve(JSON.parse(xhr.responseText)); } catch { reject(new Error('invalid response')); }
    };
    xhr.onerror = () => reject(new Error('NetworkError'));
    xhr.ontimeout = () => reject(new Error('stream_timeout'));
    xhr.send();
  });
}

function play() {
  if (!wantsPlay) return;
  try {
    const result = video.play();
    if (result && result.catch) result.catch(() => { show('กด OK หรือปุ่มเล่นเพื่อเริ่มรับชม'); document.getElementById('tv-play').focus(); });
  } catch { show('กดปุ่มเล่นเพื่อเริ่มรับชม'); }
}

function recover(error) {
  if (retryTimer || !wantsPlay) return;
  const next = budget.next(error);
  failed = !next;
  if (!next) { show(playbackErrorMessage(error)); return; }
  show(`สัญญาณสะดุด · เชื่อมต่อใหม่ใน ${next.delay / 1000} วินาที (${next.attempt}/5)`);
  const retry = () => {
    retryTimer = null;
    if (!wantsPlay) return;
    if (navigator.onLine === false || document.hidden) { retryTimer = setTimeout(retry, 2000); return; }
    if (item) attach(item);
  };
  retryTimer = setTimeout(retry, next.delay);
}

// On a native-only HLS device, select the highest advertised variant explicitly.
async function nativeHlsUrl(url, depth = 0) {
  if (depth >= 6) throw new Error('MEDIA_ERR_SRC_NOT_SUPPORTED');
  const text = await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest(); xhr.open('GET', url); xhr.timeout = 25000;
    xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve(xhr.responseText) : reject(new Error(`HTTP ${xhr.status}`));
    xhr.onerror = () => reject(new Error('NetworkError')); xhr.ontimeout = () => reject(new Error('stream_timeout')); xhr.send();
  });
  if (!text.replace(/^\uFEFF/, '').trim().startsWith('#EXTM3U')) throw new Error('MEDIA_ERR_SRC_NOT_SUPPORTED');
  const lines = text.split(/\r?\n/), variants = [];
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].startsWith('#EXT-X-STREAM-INF:')) continue;
    const attrs = lines[index], resolution = attrs.match(/RESOLUTION=(\d+)x(\d+)/);
    let next = index + 1;
    while (next < lines.length && (!lines[next].trim() || lines[next].startsWith('#'))) next++;
    if (next < lines.length) variants.push({ width: Number(resolution?.[1]), height: Number(resolution?.[2]), bitrate: Number(attrs.match(/(?:^|,)BANDWIDTH=(\d+)/)?.[1] || attrs.match(/:BANDWIDTH=(\d+)/)?.[1]), frameRate: Number(attrs.match(/FRAME-RATE=([\d.]+)/)?.[1]), url: new URL(lines[next].trim(), url).href });
  }
  return variants.length ? nativeHlsUrl(variants[highestQualityIndex(variants)].url, depth + 1) : url;
}

function attach(nextItem) {
  const current = ++requestId;
  clearTimeout(retryTimer); retryTimer = null;
  if (hls) { hls.destroy(); hls = null; }
  video.removeAttribute('src'); video.load();
  item = nextItem; failed = false; lastTime = 0; lastAdvance = Date.now();
  title.textContent = item.title;
  show('กำลังโหลดคุณภาพสูงสุด…');
  if (item.playbackError) { failed = true; show(item.playbackError); return; }
  if (item.streamType === 'HLS' && Hls.isSupported()) {
    hls = new Hls({ ...highestHlsConfig, liveSyncDurationCount: 6 });
    hls.on(Hls.Events.MANIFEST_PARSED, () => { lockHlsToHighest(hls); hls.startLoad(); play(); });
    hls.on(Hls.Events.LEVELS_UPDATED, () => lockHlsToHighest(hls));
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (current !== requestId || !data.fatal) return;
      const error = new Error(data.response?.code ? `HTTP ${data.response.code}` : data.details || data.type);
      error.recoverable = [Hls.ErrorTypes.NETWORK_ERROR, Hls.ErrorTypes.MEDIA_ERROR].indexOf(data.type) >= 0;
      recover(error);
    });
    hls.loadSource(item.playUrl); hls.attachMedia(video);
  } else if (item.streamType === 'HLS' && video.canPlayType('application/vnd.apple.mpegurl')) {
    nativeHlsUrl(item.playUrl).then(url => { if (current === requestId) { video.src = url; video.load(); play(); } }).catch(error => { if (current === requestId) recover(error); });
  } else if (item.streamType === 'วิดีโอ') {
    video.src = item.playUrl; video.load(); play();
  } else {
    failed = true; show('รูปแบบช่องนี้ยังไม่รองรับในหน้าเล่นบนทีวี กรุณาเลือกช่อง HLS');
  }
}

async function refresh(force = false) {
  if (refreshing) { queuedRefresh = true; queuedForce = queuedForce || force; return; }
  refreshing = true;
  const requestedSelection = selection, requestedRevision = revision;
  try {
    const data = await requestJson('/api/manulive?channel=' + encodeURIComponent(selection) + '&revision=' + encodeURIComponent(revision));
    if (selection !== requestedSelection || revision !== requestedRevision) { queuedRefresh = true; queuedForce = true; return; }
    if (revision !== data.revision) selection = '';
    revision = data.revision;
    title.textContent = data.title;
    const previous = channels.value;
    channels.textContent = '';
    data.choices.forEach(choice => { const option = document.createElement('option'); option.value = choice.title; option.textContent = choice.title; channels.appendChild(option); });
    channels.value = !settings.hidden && previous ? previous : data.title;
    if (!data.item) {
      ++requestId; if (hls) { hls.destroy(); hls = null; } video.removeAttribute('src'); video.load();
      item = null; itemKey = ''; failed = true;
      show('ยังไม่พบช่องนี้ในคลังล่าสุด กดเปลี่ยนช่องเพื่อเลือกช่องที่ย้ายไป');
      return;
    }
    const nextKey = data.item.id + '|' + data.item.playUrl;
    if (force || nextKey !== itemKey) { itemKey = nextKey; attach(data.item); }
  } catch {
    if (!item) { failed = true; show('โหลดช่องไม่สำเร็จ กดเชื่อมต่อใหม่เพื่อลองอีกครั้ง'); }
  } finally {
    refreshing = false;
    if (queuedRefresh) {
      const forceNext = queuedForce;
      queuedRefresh = false; queuedForce = false;
      setTimeout(() => refresh(forceNext), 0);
    }
  }
}

document.getElementById('tv-play').onclick = () => {
  show();
  if (failed || !item) { wantsPlay = true; budget.reset(); refresh(true); }
  else if (video.paused) { wantsPlay = true; play(); }
  else { wantsPlay = false; clearTimeout(retryTimer); retryTimer = null; video.pause(); show('หยุดชั่วคราว'); }
};
document.getElementById('tv-retry').onclick = () => { wantsPlay = true; budget.reset(); refresh(true); };
document.getElementById('tv-fullscreen').onclick = () => {
  const target = document.getElementById('tv-player');
  const request = target.requestFullscreen || target.webkitRequestFullscreen;
  try { const result = request?.call(target); if (result?.catch) result.catch(() => show('แสดงเต็มพื้นที่หน้าเว็บแล้ว')); } catch { show('แสดงเต็มพื้นที่หน้าเว็บแล้ว'); }
};
document.getElementById('tv-change').onclick = () => { settings.hidden = !settings.hidden; show(); if (!settings.hidden) channels.focus(); };
function remember() { try { localStorage.setItem('manulive-channel', JSON.stringify({ title: selection, revision })); } catch { /* Optional device preference. */ } }
document.getElementById('tv-apply').onclick = () => { selection = channels.value; remember(); settings.hidden = true; wantsPlay = true; budget.reset(); refresh(true); };
document.getElementById('tv-default').onclick = () => { selection = ''; remember(); settings.hidden = true; wantsPlay = true; budget.reset(); refresh(true); };
video.addEventListener('playing', () => { failed = false; lastAdvance = Date.now(); show('กำลังเล่น · คุณภาพสูงสุด'); });
video.addEventListener('waiting', () => { budget.stalled(); if (!failed && !retryTimer) show('กำลังบัฟเฟอร์คุณภาพสูงสุด…'); });
video.addEventListener('error', () => { if (item) recover(new Error(`video_error_${video.error?.code || 0}`)); });
video.addEventListener('ended', () => recover(new Error('EarlyEof')));
document.addEventListener('mousemove', () => show());
document.addEventListener('keydown', event => {
  show();
  if (event.target === channels) return; // Let the browser operate the TV select.
  const key = event.key, code = event.keyCode;
  if (key === 'MediaPlay' || code === 415) { event.preventDefault(); wantsPlay = true; if (failed) { budget.reset(); refresh(true); } else play(); return; }
  if (key === 'MediaPause' || code === 19) { event.preventDefault(); wantsPlay = false; clearTimeout(retryTimer); retryTimer = null; video.pause(); show('หยุดชั่วคราว'); return; }
  if (key === 'MediaPlayPause' || code === 10252 || key === 'Enter' && event.target === document.body) { event.preventDefault(); document.getElementById('tv-play').click(); return; }
  if ((key === 'Escape' || code === 10009) && !settings.hidden) { event.preventDefault(); settings.hidden = true; document.getElementById('tv-change').focus(); return; }
  if (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown') {
    event.preventDefault();
    const controls = Array.prototype.slice.call(panel.querySelectorAll('button,select')).filter(element => element.offsetHeight > 0);
    const index = controls.indexOf(document.activeElement), delta = key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 1;
    controls[(index + delta + controls.length) % controls.length].focus();
  }
});
setInterval(() => { if (!document.hidden) refresh(); }, 60000);
setInterval(() => {
  if (!item || failed || retryTimer || !wantsPlay || video.paused || document.hidden || navigator.onLine === false) { lastAdvance = Date.now(); budget.stalled(); return; }
  if (Math.abs(video.currentTime - lastTime) > .05) { lastTime = video.currentTime; lastAdvance = Date.now(); budget.progressing(lastAdvance); }
  else { budget.stalled(); if (Date.now() - lastAdvance > 30000) recover(new Error('playback_timeout')); }
}, 2000);
window.addEventListener('online', () => refresh(failed));
document.addEventListener('visibilitychange', () => { lastAdvance = Date.now(); if (!document.hidden) refresh(); });
refresh();
