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
  if (/video_error_4|MEDIA_ERR_SRC_NOT_SUPPORTED/i.test(message)) return 'รูปแบบสตรีมนี้ไม่รองรับการเล่นในเว็บเบราว์เซอร์';
  if (/stream_timeout|playback_timeout/i.test(message)) return 'ต้นทางตอบช้าหรือไม่มีข้อมูลวิดีโอภายในเวลาที่กำหนด';
  if (message === 'DASH_NOT_SUPPORTED') return 'เบราว์เซอร์นี้ไม่รองรับ DASH';
  return `โหลดสตรีมไม่สำเร็จ${message ? ` (${message})` : ''}`;
}

export async function detectStreamType(item, signal) {
  if (item.streamType !== 'AUTO') return item.streamType;
  const classifyContentType = (type = '') => {
    if (/mpegurl/i.test(type)) return 'HLS';
    if (/dash\+xml/i.test(type)) return 'DASH';
    if (/^(video|audio)\//i.test(type)) return 'วิดีโอ';
    return null;
  };

  // Some IPTV origins deliberately reject HEAD while serving the same URL to
  // GET. Treat HEAD as an optimization only; the byte probe is authoritative.
  try {
    const response = await fetch(item.playUrl, { method: 'HEAD', signal });
    const detected = response.ok && classifyContentType(response.headers.get('content-type'));
    if (detected) return detected;
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
  }

  const probe = await fetch(item.playUrl, { headers: { Range: 'bytes=0-1023' }, signal });
  if (!probe.ok) throw new Error(`ต้นทางตอบ HTTP ${probe.status}`);
  const detected = classifyContentType(probe.headers.get('content-type'));
  if (detected) {
    await probe.body?.cancel();
    return detected;
  }
  if (!probe.body) throw new Error('ต้นทางไม่ได้ส่งข้อมูลสตรีมกลับมา');
  const reader = probe.body.getReader();
  try {
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value?.subarray(0, 1024));
    if (text.trimStart().startsWith('#EXTM3U')) return 'HLS';
    if (/<MPD[\s>]/.test(text)) return 'DASH';
    if (text.slice(4, 8) === 'ftyp') return 'วิดีโอ';
    throw new Error('ต้นทางไม่ได้ส่งไฟล์วิดีโอหรือ manifest ที่รองรับ');
  } finally { await reader.cancel(); }
}

export function playable(video, setCancel, timeoutMs = 25000) {
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
