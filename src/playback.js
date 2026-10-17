export function sourceUrl(item) {
  if (item.directUrl) return item.directUrl;
  try {
    const encoded = new URL(item.playUrl).searchParams.get('p').replace(/-/g, '+').replace(/_/g, '/');
    const decoded = new TextDecoder().decode(Uint8Array.from(atob(encoded), (letter) => letter.charCodeAt(0)));
    return JSON.parse(decoded).u;
  } catch { return item.playUrl; }
}

export function proxyResourceUrl(playUrl, uri, base) {
  const target = new URL(uri, base);
  const proxy = new URL(playUrl);
  if (target.origin === proxy.origin && target.pathname === proxy.pathname && target.searchParams.has('p') && target.searchParams.has('s')) return target.href;
  proxy.searchParams.set('u', target.href);
  return proxy.href;
}

export function highestQualityIndex(tracks, preferredLanguage = '') {
  const number = (value) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0;
  const score = (track) => {
    const width = number(track.width), height = number(track.height);
    const pixels = width && height ? width * height : height ? height * height * 16 / 9 : width * width * 9 / 16;
    return [pixels, number(track.frameRate), number(track.videoBandwidth || track.bitrate || track.bandwidth), Number(Boolean(preferredLanguage) && track.language === preferredLanguage), Number(Boolean(track.active))];
  };
  let best = -1, bestScore = [];
  for (let index = 0; index < tracks.length; index += 1) {
    const candidate = score(tracks[index]);
    const firstDifference = candidate.findIndex((value, position) => value !== bestScore[position]);
    if (best < 0 || firstDifference >= 0 && candidate[firstDifference] > bestScore[firstDifference]) { best = index; bestScore = candidate; }
  }
  return best;
}

export function lockHlsToHighest(hls) {
  const index = highestQualityIndex(hls.levels);
  if (index < 0) return;
  hls.startLevel = index;
  hls.loadLevel = index;
}

export function lockShakaToHighest(player) {
  const tracks = player.getVariantTracks();
  const active = tracks.find((track) => track.active);
  const best = tracks[highestQualityIndex(tracks, active?.language)];
  if (best && !best.active) player.selectVariantTrack(best, true);
  return best;
}

export const highestHlsConfig = {
  enableWorker: true, autoStartLoad: false, capLevelToPlayerSize: false,
  capLevelOnFPSDrop: false, preserveManualLevelOnError: true,
  lowLatencyMode: false, maxBufferLength: 90, backBufferLength: 30,
  fragLoadPolicy: { default: {
    maxTimeToFirstByteMs: 30000, maxLoadTimeMs: 120000,
    timeoutRetry: { maxNumRetry: 3, retryDelayMs: 1000, maxRetryDelayMs: 8000 },
    errorRetry: { maxNumRetry: 3, retryDelayMs: 1000, maxRetryDelayMs: 8000 },
  } },
};

export const highestShakaConfig = {
  abr: { enabled: false, defaultBandwidthEstimate: 1e12, useNetworkInformation: false, restrictToElementSize: false, restrictToScreenSize: false },
  streaming: {
    bufferingGoal: 90, rebufferingGoal: 3, maxDisabledTime: 0,
    retryParameters: { timeout: 120000, stallTimeout: 60000, connectionTimeout: 30000 },
  },
};

export function playbackErrorMessage(error) {
  const message = error?.message || String(error || '');
  const code = error?.code || Number(message.match(/Shaka(?: Error)? (\d+)/i)?.[1]);
  const networkError = code === 1001 ? error : Array.isArray(error?.data) ? error.data.find((entry) => entry?.code === 1001) : null;
  const status = Number(networkError?.data?.[1] || message.match(/HTTP[_ ]?([1-5]\d\d)/i)?.[1]);
  if (code === 6007 || /LICENSE_REQUEST_FAILED/i.test(message)) return 'ต้นทางปฏิเสธหรือไม่ตอบรับคำขอใบอนุญาต DRM';
  try {
    const reason = JSON.parse(networkError?.data?.[2] || '{}').error;
    if (reason === 'link expired') return 'ลิงก์รับชมของเว็บหมดอายุ กรุณาอัปเดตคลังแล้วเปิดใหม่';
    if (reason === 'target origin mismatch') return 'ระบบส่งต่อสตรีมยังไม่รองรับ CDN ของช่องนี้ กรุณาอัปเดตคลังแล้วลองใหม่';
    if (reason === 'proxy request failed') return 'ระบบส่งต่อสตรีมเชื่อมต่อหรืออ่านข้อมูลต้นทางไม่สำเร็จ';
  } catch { /* Non-JSON upstream errors retain their HTTP status below. */ }
  if (status === 404) return 'ต้นทางไม่พบไฟล์สตรีม (HTTP 404) ยังยืนยันไม่ได้ว่าสัญญาณหมดอายุ';
  if (status === 410) return 'ลิงก์นี้ไม่พร้อมให้บริการแล้ว (HTTP 410) ลองอัปเดตคลังแล้วเปิดใหม่';
  if ([401, 403].includes(status)) return `ต้นทางปฏิเสธสิทธิ์รับชม (HTTP ${status})`;
  if (status === 429) return 'ต้นทางจำกัดจำนวนการเชื่อมต่อ (HTTP 429) กรุณารอสักครู่แล้วลองใหม่';
  if (status >= 500) return `เซิร์ฟเวอร์ต้นทางขัดข้อง (HTTP ${status})`;
  if (code === 6001 || /DRM_NO_RECOGNIZED_KEY_SYSTEMS/i.test(message)) return 'ช่องนี้ใช้ระบบ DRM ที่เบราว์เซอร์หรือข้อมูลใบอนุญาตปัจจุบันยังไม่รองรับ';
  if (message === 'HIGHEST_QUALITY_UNAVAILABLE') return 'สตรีมคุณภาพสูงสุดไม่พร้อมให้บริการ กรุณาลองใหม่อีกครั้ง';
  if (/video_error_4|MEDIA_ERR_SRC_NOT_SUPPORTED/i.test(message)) return 'รูปแบบสตรีมนี้ไม่รองรับการเล่นในเว็บเบราว์เซอร์';
  if (/video_error_3|MEDIA_ERR_DECODE|CodecUnsupported/i.test(message)) return 'อุปกรณ์นี้ถอดรหัสวิดีโอหรือเสียงรูปแบบนี้ไม่ได้ ต้องแปลง codec ที่เซิร์ฟเวอร์ก่อนรับชม';
  if (code === 1003 || /stream_timeout|playback_timeout/i.test(message)) return 'ต้นทางตอบช้าหรือไม่มีข้อมูลวิดีโอภายในเวลาที่กำหนด';
  if (message === 'DASH_NOT_SUPPORTED') return 'เบราว์เซอร์นี้ไม่รองรับ DASH';
  return `โหลดสตรีมไม่สำเร็จ${message ? ` (${message})` : ''}`;
}

export async function detectStreamType(item, signal) {
  if (['HLS', 'DASH', 'MPEG-TS', 'MKV', 'FLV'].includes(item.streamType)) return item.streamType;
  let extension = '';
  try { extension = new URL(sourceUrl(item)).pathname.match(/\.[a-z0-9]+$/i)?.[0]?.toLowerCase() || ''; } catch { /* Probe an unrecognized source. */ }
  if (extension === '.mkv') return 'MKV';
  if (['.ts', '.m2ts', '.mts'].includes(extension)) return 'MPEG-TS';
  if (extension === '.flv') return 'FLV';
  if (['.mp4', '.webm', '.mov', '.m4v'].includes(extension)) return 'วิดีโอ';
  const classifyContentType = (type = '') => {
    if (/mpegurl/i.test(type)) return 'HLS';
    if (/dash\+xml/i.test(type)) return 'DASH';
    if (/matroska/i.test(type)) return 'MKV';
    if (/mp2t|mpeg2-ts/i.test(type)) return 'MPEG-TS';
    if (/x-flv/i.test(type)) return 'FLV';
    if (/^(video|audio)\//i.test(type)) return 'วิดีโอ';
    return null;
  };

  // Some IPTV origins deliberately reject HEAD while serving the same URL to
  // GET. Treat HEAD as an optimization only; the byte probe is authoritative.
  try {
    const response = await fetch(item.playUrl, { method: 'HEAD', signal });
    const detected = response.ok && classifyContentType(response.headers.get('content-type'));
    if (detected && detected !== 'วิดีโอ') return detected;
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
  }

  const probe = await fetch(item.playUrl, { headers: { Range: 'bytes=0-1023' }, signal });
  if (!probe.ok) throw new Error(`ต้นทางตอบ HTTP ${probe.status}`);
  const detected = classifyContentType(probe.headers.get('content-type'));
  if (detected && detected !== 'วิดีโอ') {
    await probe.body?.cancel();
    return detected;
  }
  if (!probe.body) throw new Error('ต้นทางไม่ได้ส่งข้อมูลสตรีมกลับมา');
  const reader = probe.body.getReader();
  try {
    const value = new Uint8Array(1024);
    let length = 0;
    while (length < value.length) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const bytes = chunk.value.subarray(0, value.length - length);
      value.set(bytes, length);
      length += bytes.length;
    }
    const text = new TextDecoder().decode(value.subarray(0, length));
    if (text.trimStart().startsWith('#EXTM3U')) return 'HLS';
    if (/<MPD[\s>]/.test(text)) return 'DASH';
    if (value[0] === 0x47 && value[188] === 0x47 && value[376] === 0x47 || value[4] === 0x47 && value[196] === 0x47 && value[388] === 0x47) return 'MPEG-TS';
    if (value?.[0] === 0x1a && value[1] === 0x45 && value[2] === 0xdf && value[3] === 0xa3) return 'MKV';
    if (text.startsWith('FLV')) return 'FLV';
    if (text.slice(4, 8) === 'ftyp') return 'วิดีโอ';
    if (detected) return detected;
    throw new Error('ต้นทางไม่ได้ส่งไฟล์วิดีโอหรือ manifest ที่รองรับ');
  } finally { await reader.cancel(); }
}

export function playable(video, setCancel, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    let timer;
    let poll;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      video.removeEventListener('canplay', ready);
      video.removeEventListener('error', failed);
      if (error) reject(error); else resolve();
    };
    const ready = () => { if (video.readyState >= 3) finish(); };
    const failed = () => finish(new Error(`video_error_${video.error?.code || 'unknown'}`));
    video.addEventListener('canplay', ready);
    video.addEventListener('error', failed);
    poll = setInterval(ready, 150);
    timer = setTimeout(() => finish(new Error('stream_timeout')), timeoutMs);
    setCancel(() => finish());
    ready();
  });
}
