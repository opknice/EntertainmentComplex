import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse/sync';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(rootDir, 'data');
const publicDataDir = path.join(rootDir, 'public', 'data');
const csvPath = path.join(dataDir, 'Doowiseplay-movies.csv');
const m3uPath = path.join(dataDir, 'Doowiseplay-movies.m3u');
const statePath = path.join(dataDir, 'source-state.json');
const catalogPath = path.join(publicDataDir, 'catalog.json');
const versionPath = path.join(publicDataDir, 'version.json');
const localEnvPath = path.join(rootDir, '.env.local');
const upstreamBase = 'https://dws-license.thmirror2.workers.dev';
const defaultUserAgent = 'Doowiseplay-Android/1.0';
const sportsUserAgent = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36';
const monitoredSources = ['77hd.m3u', 'ottmovie-series.m3u', 'playlistnolog.m3u', 'movie285_all.m3u'];
const liveSourceName = 'converted_playlist.m3u';
const sportsBase = 'https://atmflix.live';
const sportsFeeds = [
  ['football', '/api/fixtures/date'],
  ['volleyball', '/api/volleyball/fixtures'],
  ['hockey', '/api/hockey/fixtures'],
  ['nfl', '/api/nfl/fixtures'],
];

loadLocalEnv();

const memberId = process.env.DOOWISE_MEMBER_ID?.trim() || '';
const signingKey = process.env.PROXY_SIGNING_KEY?.trim() || memberId;
const proxyBaseUrl = (process.env.PROXY_BASE_URL || '').trim().replace(/\/$/, '');
const sportsProxyBaseUrl = (process.env.SPORTS_PROXY_BASE_URL || '/api/sports').trim();

if (!signingKey) throw new Error('ต้องตั้งค่า PROXY_SIGNING_KEY หรือ DOOWISE_MEMBER_ID');
if (!/^https:\/\//i.test(proxyBaseUrl)) throw new Error('ต้องตั้งค่า PROXY_BASE_URL เป็น HTTPS URL ของ Cloudflare Worker');

function loadLocalEnv() {
  if (!fs.existsSync(localEnvPath)) return;
  for (const rawLine of fs.readFileSync(localEnvPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function stableMovieId(title, url) {
  return crypto.createHash('sha256').update(`${title}\u0000${url}`).digest('base64url').slice(0, 22);
}

function normalizeMovie(row) {
  const title = String(row.title || '(ไม่มีชื่อ)').trim();
  const url = String(row.url || '').trim();
  return {
    id: stableMovieId(title, url),
    title,
    url,
    referer: String(row.referer || '').trim(),
    userAgent: String(row.user_agent || row.userAgent || defaultUserAgent).trim() || defaultUserAgent,
    source: String(row.source || 'unknown').trim(),
    group: String(row.group || '').trim(),
    logo: String(row.logo || '').trim(),
  };
}

function readCsv() {
  const input = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '');
  return parse(input, { columns: true, skip_empty_lines: true, relax_quotes: true })
    .map(normalizeMovie)
    .filter((movie) => movie.url);
}

function splitExtinf(line) {
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === '"') quoted = !quoted;
    if (line[index] === ',' && !quoted) return [line.slice(0, index), line.slice(index + 1).trim()];
  }
  return [line, ''];
}

function parseAttrs(meta) {
  const attrs = {};
  const pattern = /([A-Za-z0-9_-]+)=(?:"([^"]*)"|([^\s,]+))/g;
  let match;
  while ((match = pattern.exec(meta))) attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? '';
  return attrs;
}

function parsePlaylist(text, source) {
  const records = [];
  let current = null;
  for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF:')) {
      const [meta, displayTitle] = splitExtinf(line);
      current = { attrs: parseAttrs(meta), displayTitle, options: [] };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('#EXTVLCOPT:') || line.startsWith('#KODIPROP:')) {
      current.options.push(line);
      continue;
    }
    if (line.startsWith('#')) continue;

    const group = current.attrs['group-title'] || '';
    let kind = (current.attrs.type || '').toLowerCase();
    if (!kind) {
      if (/series|ซีรี/i.test(group)) kind = 'series';
      else if (/live|สด|ทีวี|กีฬา/i.test(group)) kind = 'live';
      else if (/movie|หนัง|ภาพยนตร์/i.test(group)) kind = 'movie';
      else kind = 'unknown';
    }

    if (kind === 'movie') {
      const headers = {};
      for (const option of current.options) {
        const body = option.slice(option.indexOf(':') + 1);
        const separator = body.indexOf('=');
        if (separator < 1) continue;
        const key = body.slice(0, separator).trim().toLowerCase();
        const value = body.slice(separator + 1).trim();
        if (['http-referrer', 'http-referer', 'referer'].includes(key)) headers.referer = value;
        if (['http-user-agent', 'user-agent'].includes(key)) headers.userAgent = value;
        if (['stream_headers', 'http-header'].includes(key)) {
          for (const pair of value.split('&')) {
            const pairSeparator = pair.indexOf('=');
            if (pairSeparator < 1) continue;
            const headerName = pair.slice(0, pairSeparator).trim().toLowerCase();
            const headerValue = pair.slice(pairSeparator + 1).trim();
            if (headerName === 'referer') headers.referer = headerValue;
            if (headerName === 'user-agent') headers.userAgent = headerValue;
          }
        }
      }
      records.push(normalizeMovie({
        title: current.attrs['movie-title'] || current.attrs['tvg-name'] || current.displayTitle || '(ไม่มีชื่อ)',
        url: line,
        referer: headers.referer || '',
        userAgent: headers.userAgent || defaultUserAgent,
        source,
        group,
        logo: current.attrs['tvg-logo'] || '',
      }));
    }
    current = null;
  }
  return records;
}

function parseLivePlaylist(text, source) {
  const records = [];
  let current = null;
  for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF:')) {
      const [meta, displayTitle] = splitExtinf(line);
      current = { attrs: parseAttrs(meta), displayTitle, options: [] };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('#EXTVLCOPT:') || line.startsWith('#KODIPROP:')) {
      current.options.push(line);
      continue;
    }
    if (line.startsWith('#')) continue;

    const headers = {};
    let userAgent = defaultUserAgent;
    let referer = '';
    for (const option of current.options) {
      const body = option.slice(option.indexOf(':') + 1);
      const separator = body.indexOf('=');
      if (separator < 1) continue;
      const key = body.slice(0, separator).trim().toLowerCase();
      const value = body.slice(separator + 1).trim();
      if (['http-referrer', 'http-referer', 'referer'].includes(key)) referer = value;
      if (['http-user-agent', 'user-agent'].includes(key)) userAgent = value;
      if (['stream_headers', 'http-header'].some((name) => key.endsWith(name))) {
        for (const pair of value.split('&')) {
          const pairSeparator = pair.indexOf('=');
          if (pairSeparator < 1) continue;
          const headerName = pair.slice(0, pairSeparator).trim();
          const headerValue = pair.slice(pairSeparator + 1).trim();
          if (/^[A-Za-z0-9-]{1,64}$/.test(headerName)) headers[headerName] = headerValue;
        }
      }
    }
    const title = current.attrs['tvg-name'] || current.displayTitle || '(ไม่มีชื่อ)';
    records.push({
      id: stableMovieId(title, line),
      title,
      url: line,
      referer,
      userAgent,
      headers,
      source,
      group: current.attrs['group-title'] || 'ทีวีสด',
      logo: current.attrs['tvg-logo'] || '',
      category: /sport|กีฬา/i.test(`${title} ${current.attrs['group-title'] || ''}`) ? 'sport-channel' : 'live-tv',
    });
    current = null;
  }
  return records;
}

function csvCell(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

function serializeCsv(items) {
  const rows = [['title', 'url', 'referer', 'user_agent', 'source', 'group', 'logo'].map(csvCell).join(',')];
  for (const item of items) rows.push([item.title, item.url, item.referer, item.userAgent, item.source, item.group, item.logo].map(csvCell).join(','));
  return `\uFEFF${rows.join('\n')}\n`;
}

function serializeM3u(items) {
  const lines = ['#EXTM3U'];
  for (const item of items) {
    const title = item.title.replace(/[\r\n]/g, ' ').trim();
    const group = item.group.replaceAll('"', "'");
    const logo = item.logo.replaceAll('"', '%22');
    lines.push(`#EXTINF:-1 group-title="${group}" tvg-logo="${logo}",${title}`);
    if (item.referer) lines.push(`#EXTVLCOPT:http-referrer=${item.referer}`);
    if (item.userAgent && item.userAgent !== defaultUserAgent) lines.push(`#EXTVLCOPT:http-user-agent=${item.userAgent}`);
    lines.push(item.url);
  }
  return `${lines.join('\n')}\n`;
}

function writeAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, content, 'utf8');
  fs.renameSync(temporaryPath, filePath);
}

function sourceFingerprint(item) {
  return `${item.name}|${item.size ?? ''}|${item.updated ?? ''}`;
}

async function fetchSourceList() {
  const response = await fetch(`${upstreamBase}/cv/sources`, {
    headers: { 'User-Agent': defaultUserAgent },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`ตรวจรายการต้นทางไม่สำเร็จ (HTTP ${response.status})`);
  const body = await response.json();
  const byName = new Map((body.movie || []).map((item) => [item.name, item]));
  const movies = monitoredSources.map((name) => {
    const item = byName.get(name);
    if (!item) throw new Error(`ไม่พบแหล่งข้อมูล ${name}`);
    return item;
  });
  const live = (body.live || []).find((item) => item.name === liveSourceName);
  if (!live) throw new Error(`ไม่พบแหล่งข้อมูล ${liveSourceName}`);
  return { movies, live };
}

async function fetchSourceMovies(source) {
  if (!memberId) throw new Error(`แหล่ง ${source} เปลี่ยนแปลง แต่ยังไม่ได้ตั้งค่า DOOWISE_MEMBER_ID`);
  const endpoint = `${upstreamBase}/cv/playlist?src=${encodeURIComponent(source)}&id=${encodeURIComponent(memberId)}`;
  const response = await fetch(endpoint, {
    headers: { 'User-Agent': defaultUserAgent },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`ดาวน์โหลด ${source} ไม่สำเร็จ (HTTP ${response.status})`);
  return parsePlaylist(await response.text(), source);
}

async function fetchLiveChannels(source) {
  if (!memberId) throw new Error(`ยังไม่ได้ตั้งค่า DOOWISE_MEMBER_ID สำหรับ ${source}`);
  const endpoint = `${upstreamBase}/cv/playlist?src=${encodeURIComponent(source)}&id=${encodeURIComponent(memberId)}`;
  const response = await fetch(endpoint, {
    headers: { 'User-Agent': defaultUserAgent },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`ดาวน์โหลด ${source} ไม่สำเร็จ (HTTP ${response.status})`);
  return parseLivePlaylist(await response.text(), source);
}

function flattenFixturePayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  return Object.values(payload).flatMap((value) => Array.isArray(value) ? value : []);
}

async function fetchSports() {
  const results = [];
  for (const [sport, pathname] of sportsFeeds) {
    const response = await fetch(`${sportsBase}${pathname}`, {
      headers: { 'User-Agent': sportsUserAgent },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`โหลดตารางกีฬา ${sport} ไม่สำเร็จ (HTTP ${response.status})`);
    for (const item of flattenFixturePayload(await response.json())) {
      const home = item.teamhome?.name_th || item.teamhome?.name || '';
      const away = item.teamaway?.name_th || item.teamaway?.name || '';
      const channel = String(item.channel || '').trim();
      if (!channel) continue;
      const title = `${home} vs ${away}`.trim().replace(/^vs$|^\s*vs\s*/i, '') || String(item.title || channel);
      const league = item.league_info?.name_th || item.league_info?.name || String(item.league_round || sport).split(' - ')[0];
      results.push({
        id: stableMovieId(`${sport}:${title}:${item.event_time || ''}`, channel),
        title,
        sport,
        league: league || sport,
        time: String(item.event_time || ''),
        status: String(item.status_short || ''),
        channel,
        logo: item.teamhome?.logo || '',
        awayLogo: item.teamaway?.logo || '',
      });
    }
  }
  const eventsResponse = await fetch(`${sportsBase}/api/events`, {
    headers: { 'User-Agent': sportsUserAgent },
    signal: AbortSignal.timeout(30_000),
  });
  if (eventsResponse.ok) {
    for (const item of await eventsResponse.json()) {
      const channel = String(item.channel || '').trim();
      if (!channel) continue;
      results.push({
        id: stableMovieId(`event:${item.title}:${item.start || ''}`, channel),
        title: String(item.title || channel),
        sport: 'event',
        league: 'อีเวนต์',
        time: String(item.start || ''),
        status: '',
        channel,
        logo: String(item.thumbnail || ''),
        awayLogo: '',
      });
    }
  }
  return [...new Map(results.map((item) => [`${item.channel}\u0000${item.time}\u0000${item.title}`, item])).values()]
    .sort((a, b) => a.time.localeCompare(b.time) || a.sport.localeCompare(b.sport));
}

function signPlayUrl(movie, expiresAt) {
  const allowedOrigins = [];
  if (movie.url) {
    const streamUrl = new URL(movie.url);
    allowedOrigins.push(streamUrl.origin);
    const playbackPrefix = streamUrl.searchParams.get('playbackUrlPrefix');
    if (playbackPrefix) {
      try {
        allowedOrigins.push(new URL(playbackPrefix).origin);
      } catch {
        // Ignore malformed optional CDN hints; the primary stream remains usable.
      }
    }
  }
  const payload = Buffer.from(JSON.stringify({
    u: movie.url || '',
    c: movie.channel || '',
    r: movie.referer || '',
    a: movie.userAgent || defaultUserAgent,
    h: movie.headers || {},
    o: [...new Set(allowedOrigins)],
    e: expiresAt,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', signingKey).update(payload).digest('base64url');
  return `${proxyBaseUrl}/v1/media?p=${encodeURIComponent(payload)}&s=${encodeURIComponent(signature)}`;
}

function catalogHash(items) {
  const digest = crypto.createHash('sha256');
  for (const item of items) digest.update(`${item.id}\u0000${item.title}\u0000${item.url}\u0000${item.referer}\u0000${item.logo}\u0000${JSON.stringify(item.headers || {})}\n`);
  return digest.digest('hex').slice(0, 20);
}

async function main() {
  const previousVersion = readJson(versionPath, null);
  const sourceState = readJson(statePath, {});
  const sourceList = await fetchSourceList();
  const changedSources = sourceList.movies.filter((source) => sourceState[source.name]?.fingerprint !== sourceFingerprint(source));
  const existingMovies = readCsv();
  const byIdentity = new Map(existingMovies.map((movie) => [`${movie.title}\u0000${movie.url}`, movie]));
  let added = 0;

  for (const source of changedSources) {
    const incoming = await fetchSourceMovies(source.name);
    for (const movie of incoming) {
      const identity = `${movie.title}\u0000${movie.url}`;
      if (!byIdentity.has(identity)) added += 1;
      byIdentity.set(identity, movie);
    }
    sourceState[source.name] = {
      size: source.size ?? null,
      updated: source.updated ?? null,
      fingerprint: sourceFingerprint(source),
      syncedAt: new Date().toISOString(),
    };
  }

  const movies = [...byIdentity.values()].sort((a, b) => a.title.localeCompare(b.title, 'th'));
  const [liveChannels, sports] = await Promise.all([fetchLiveChannels(sourceList.live.name), fetchSports()]);
  const contentHash = catalogHash([...movies, ...liveChannels, ...sports.map((item) => ({ ...item, url: item.channel, referer: '', logo: `${item.logo}|${item.awayLogo}` }))]);
  const now = Date.now();
  const linksNeedRotation = previousVersion?.catalogHash !== contentHash
    || previousVersion?.proxyBaseUrl !== proxyBaseUrl
    || !Number.isFinite(previousVersion?.expiresAt)
    || previousVersion.expiresAt < now + 7 * 24 * 60 * 60 * 1000;
  const version = linksNeedRotation ? `${contentHash}-${now.toString(36)}` : previousVersion.version;
  const generatedAt = linksNeedRotation ? new Date(now).toISOString() : previousVersion.generatedAt;
  const expiresAt = linksNeedRotation ? now + 30 * 24 * 60 * 60 * 1000 : previousVersion.expiresAt;
  const sources = [...new Set(movies.map((movie) => movie.source))].sort((a, b) => a.localeCompare(b));
  const groups = [...new Set(movies.map((movie) => movie.group).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'th'));
  const items = movies.map((movie) => ({
    id: movie.id,
    title: movie.title,
    source: movie.source,
    group: movie.group,
    logo: movie.logo,
    directUrl: movie.url,
    requiresReferer: Boolean(movie.referer),
    streamType: /\.m3u8(?:$|\?)/i.test(movie.url) ? 'HLS' : 'วิดีโอ',
    playUrl: signPlayUrl(movie, expiresAt),
  }));
  const live = liveChannels.map((channel) => ({
    id: channel.id,
    title: channel.title,
    source: channel.source,
    group: channel.group,
    logo: channel.logo,
    category: channel.category,
    directUrl: channel.url,
    streamType: /\.mpd(?:$|\?)/i.test(channel.url) ? 'DASH' : /\.m3u8(?:$|\?)/i.test(channel.url) ? 'HLS' : 'สตรีมสด',
    playUrl: signPlayUrl(channel, expiresAt),
  }));
  const sportItems = sports.map((event) => ({
    ...event,
    source: event.league,
    group: event.sport,
    streamType: 'HLS',
    playUrl: `${sportsProxyBaseUrl}?ch=${encodeURIComponent(event.channel)}`,
  }));
  const catalog = { version, generatedAt, total: items.length, liveTotal: live.length, sportsTotal: sportItems.length, sources, groups, items, live, sports: sportItems };
  const versionDocument = linksNeedRotation ? {
    version,
    catalogHash: contentHash,
    proxyBaseUrl,
    generatedAt,
    expiresAt,
    total: items.length,
    liveTotal: live.length,
    sportsTotal: sportItems.length,
    sources,
    changedSources: changedSources.map((source) => source.name),
    added,
  } : previousVersion;

  writeAtomic(csvPath, serializeCsv(movies));
  writeAtomic(m3uPath, serializeM3u(movies));
  writeAtomic(statePath, `${JSON.stringify(sourceState, null, 2)}\n`);
  writeAtomic(catalogPath, `${JSON.stringify(catalog)}\n`);
  writeAtomic(versionPath, `${JSON.stringify(versionDocument, null, 2)}\n`);

  console.log(JSON.stringify({ version, total: movies.length, changedSources: versionDocument.changedSources, added }));
}

await main();
