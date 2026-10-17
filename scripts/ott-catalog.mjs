import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const OTT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';

function attributes(text) {
  return Object.fromEntries([...text.matchAll(/([\w-]+)=(?:"([^"]*)"|([^\s,]+))/g)].map((match) => [match[1].toLowerCase(), match[2] ?? match[3]]));
}

function clearKeys(value) {
  const keys = {};
  if (/^[a-f0-9]{32}:[a-f0-9]{32}$/i.test(value)) {
    const [id, key] = value.split(':');
    keys[id] = key;
  } else {
    try {
      const parsed = JSON.parse(value);
      for (const entry of parsed.keys || []) {
        if (entry.kty === 'oct' && entry.kid && entry.k) keys[Buffer.from(entry.kid, 'base64url').toString('hex')] = Buffer.from(entry.k, 'base64url').toString('hex');
      }
      for (const [id, key] of Object.entries(parsed)) if (/^[a-f0-9]{32}$/i.test(id) && typeof key === 'string' && /^[a-f0-9]{32}$/i.test(key)) keys[id] = key;
    } catch { /* Unsupported source key syntax remains explicit. */ }
  }
  return keys;
}

export function parseOttPlaylist(text) {
  if (!text.replace(/^\uFEFF/, '').trimStart().startsWith('#EXTM3U')) throw new Error('OTT response is not an M3U playlist');
  const items = [];
  const occurrences = new Map();
  let current;
  let placeholders = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#EXTINF:')) {
      let quoted = false;
      let separator = -1;
      for (let i = 0; i < line.length; i += 1) {
        if (line[i] === '"') quoted = !quoted;
        if (line[i] === ',' && !quoted) { separator = i; break; }
      }
      current = { attrs: attributes(line.slice(0, separator < 0 ? undefined : separator)), title: separator < 0 ? '' : line.slice(separator + 1).trim(), headers: {}, userAgent: OTT_USER_AGENT, referer: '', properties: {} };
    } else if (current && /^(#EXTVLCOPT:|#KODIPROP:)/.test(line)) {
      const option = line.slice(line.indexOf(':') + 1);
      const separator = option.indexOf('=');
      const key = option.slice(0, separator).toLowerCase();
      const value = option.slice(separator + 1);
      current.properties[key] = value;
      if (['http-referrer', 'http-referer', 'referer'].includes(key) || key.endsWith('.http_referrer')) current.referer = value;
      if (['http-user-agent', 'user-agent'].includes(key) || key.endsWith('.http_user_agent')) current.userAgent = value;
      if (/stream_headers$|http-header$/.test(key)) {
        for (const [name, headerValue] of new URLSearchParams(value)) {
          if (name.toLowerCase() === 'referer') current.referer = headerValue;
          else if (name.toLowerCase() === 'user-agent') current.userAgent = headerValue;
          else if (/^[A-Za-z0-9-]{1,64}$/.test(name)) current.headers[name] = headerValue;
        }
      }
    } else if (current && line && !line.startsWith('#')) {
      const record = current;
      current = null;
      let url;
      try { url = new URL(line); } catch { continue; }
      // These are provider status/trap records, not playable channels. Never follow them.
      if (['error.com', 'debug.com', 'info.com'].includes(url.hostname) || url.hostname === 'doowiseplayfree.thmirror2.workers.dev' && url.pathname === '/playlist.m3u') { placeholders += 1; continue; }
      if (!['https:', 'http:'].includes(url.protocol)) continue;
      const title = record.title || record.attrs['tvg-name'] || '(ไม่มีชื่อ)';
      const group = record.attrs['group-title'] || 'อื่นๆ';
      const streamType = /\.mpd(?:$|\?)/i.test(url.href) || Object.entries(record.properties).some(([key, value]) => key.endsWith('manifest_type') && value === 'mpd') ? 'DASH' : /\.(m3u8|txt)(?:$|\?)/i.test(url.href) ? 'HLS' : /\.(mp4|mkv|webm)(?:$|\?)/i.test(url.href) ? 'วิดีโอ' : 'AUTO';
      const identity = `${title}\0${group}\0${url.href}`;
      const occurrence = occurrences.get(identity) || 0;
      occurrences.set(identity, occurrence + 1);
      const drmType = record.properties['inputstream.adaptive.license_type'];
      const drmKeys = /clearkey/i.test(drmType || '') ? clearKeys(record.properties['inputstream.adaptive.license_key'] || '') : {};
      items.push({
        id: `ott-${crypto.createHash('sha256').update(`${title}\0${group}\0${url.href}\0${occurrence}`).digest('base64url').slice(0, 22)}`,
        title, group, source: 'OTT Playlist', logo: record.attrs['tvg-logo'] || '',
        url: url.href, referer: record.referer, userAgent: record.userAgent, headers: record.headers,
        streamType, kind: record.attrs.type || 'live', properties: record.properties,
        seriesTitle: record.attrs['serie-title'] || '', season: record.attrs['tvg-season'] || '', episode: record.attrs['tvg-episode'] || '',
        ...(Object.keys(drmKeys).length ? { clearKeys: drmKeys } : {}),
        ...(drmType && !Object.keys(drmKeys).length ? { playbackError: 'ต้นทางไม่ได้ระบุข้อมูลใบอนุญาตที่เครื่องเล่นรองรับสำหรับช่องนี้' } : {}),
      });
    }
  }
  if (!items.length) throw new Error(`OTT returned no playable entries (${placeholders} status records)`);
  return { items, placeholders };
}

async function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value));
  for (let attempt = 0; ; attempt += 1) {
    try { fs.renameSync(temporary, file); break; } catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 6) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}

export async function syncOttCatalog({ rootDir, signPlayUrl, proxyBaseUrl }) {
  const folder = path.join(rootDir, 'public/data/ott');
  const manifestPath = path.join(folder, 'index.json');
  let previous;
  try {
    const catalog = JSON.parse(fs.readFileSync(path.join(rootDir, 'public/data/catalog.json'), 'utf8'));
    const published = catalog?.ottSummary?.indexUrl?.match(/^\/data\/ott\/([a-f0-9]{20}-[a-z0-9]+)\/index\.json$/);
    if (published) previous = JSON.parse(fs.readFileSync(path.join(folder, published[1], 'index.json'), 'utf8'));
  } catch { /* Fall back to the legacy index during migration. */ }
  if (!previous) {
    try { previous = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { /* First import. */ }
  }
  try {
    const id = process.env.OTT_PLAYLIST_ID?.trim();
    if (!id) throw new Error('OTT_PLAYLIST_ID is not configured');
    const endpoint = new URL('https://doowiseplayfree.thmirror2.workers.dev/playlist.m3u');
    endpoint.searchParams.set('id', id);
    const response = await fetch(endpoint, { headers: { 'User-Agent': OTT_USER_AGENT }, signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`OTT HTTP ${response.status}`);
    const raw = await response.text();
    const { items, placeholders } = parseOttPlaylist(raw);
    const hasher = crypto.createHash('sha256').update('ott-parser-v3').update(proxyBaseUrl);
    for (const item of items) hasher.update(JSON.stringify(item));
    const digest = hasher.digest('hex').slice(0, 20);
    if (previous?.hash === digest && previous.partsBase && previous.expiresAt > Date.now() + 7 * 86400_000) return { ...previous.summary, degraded: false };
    const now = Date.now();
    const expiresAt = now + 30 * 86400_000;
    const version = `${digest}-${now.toString(36)}`;
    const partsBase = `/data/ott/${version}`;
    const generationFolder = path.join(folder, version);
    const index = [];
    for (let offset = 0, part = 0; offset < items.length; offset += 1000, part += 1) {
      const records = items.slice(offset, offset + 1000).map((item) => {
        index.push([item.id, item.title, item.group, part]);
        const { url, referer, userAgent, headers, properties, ...publicItem } = item;
        return { ...publicItem, playUrl: signPlayUrl(item, expiresAt) };
      });
      await write(path.join(generationFolder, `part-${part}.json`), { version, items: records });
    }
    const indexUrl = `${partsBase}/index.json`;
    const summary = { version, total: items.length, generatedAt: new Date(now).toISOString(), indexUrl, placeholders, degraded: false };
    await write(path.join(generationFolder, 'index.json'), { version, hash: digest, expiresAt, partsBase, summary, entries: index });
    console.log(`OTT: imported ${items.length} entries; excluded ${placeholders} provider status/trap records`);
    return summary;
  } catch (error) {
    if (!previous) throw error;
    console.warn(`OTT refresh failed: ${error.message}; retaining ${previous.summary.total} entries`);
    return { ...previous.summary, degraded: true, error: error.message };
  }
}

export function cleanupOttGenerations(rootDir, currentVersion, previousVersion = '') {
  if (!/^[a-f0-9]{20}-[a-z0-9]+$/.test(currentVersion)) throw new Error('Invalid OTT generation');
  const folder = path.resolve(rootDir, 'public/data/ott');
  const keep = new Set([currentVersion]);
  if (/^[a-f0-9]{20}-[a-z0-9]+$/.test(previousVersion)) keep.add(previousVersion);
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[a-f0-9]{20}-[a-z0-9]+$/.test(entry.name) || keep.has(entry.name)) continue;
    const target = path.resolve(folder, entry.name);
    if (path.dirname(target) !== folder) throw new Error('OTT cleanup target escaped catalog folder');
    fs.rmSync(target, { recursive: true });
  }
}
