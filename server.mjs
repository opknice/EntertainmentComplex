import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { parse } from 'csv-parse/sync';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(here, 'data');
const csvPath = path.join(dataDir, 'Doowiseplay-movies.csv');
const m3uPath = path.join(dataDir, 'Doowiseplay-movies.m3u');
const sourceStatePath = path.join(dataDir, 'source-state.json');
const envPath = path.join(here, '.env.local');
const isDev = process.argv.includes('--dev');
const port = Number(process.env.PORT || 4173);
const signingKey = crypto.randomBytes(32);
const upstreamBase = 'https://dws-license.thmirror2.workers.dev';
const defaultUserAgent = 'Doowiseplay-Android/1.0';
const monitoredSources = ['77hd.m3u', 'ottmovie-series.m3u', 'playlistnolog.m3u', 'movie285_all.m3u'];

function loadLocalEnv() {
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadLocalEnv();

const memberId = process.env.DOOWISE_MEMBER_ID || '';
const syncIntervalMinutes = Math.max(1, Number(process.env.DOOWISE_SYNC_INTERVAL_MINUTES) || 15);
const syncIntervalMs = syncIntervalMinutes * 60 * 1000;

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

function readSourceState() {
  try {
    return JSON.parse(fs.readFileSync(sourceStatePath, 'utf8'));
  } catch {
    return {};
  }
}

let movies = readCsv();
let moviesById = new Map();
let sources = [];
let groups = [];
let sourceState = readSourceState();
let syncInProgress = false;
const syncClients = new Set();
const syncStatus = {
  enabled: Boolean(memberId),
  intervalMinutes: syncIntervalMinutes,
  syncing: false,
  lastCheckedAt: null,
  lastUpdatedAt: null,
  lastError: memberId ? '' : 'ยังไม่ได้ตั้งค่า DOOWISE_MEMBER_ID',
  lastAdded: 0,
  lastRemoved: 0,
  changedSources: [],
};

function rebuildIndexes() {
  moviesById = new Map(movies.map((movie) => [movie.id, movie]));
  sources = [...new Set(movies.map((movie) => movie.source))].sort((a, b) => a.localeCompare(b));
  groups = [...new Set(movies.map((movie) => movie.group).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'th'));
}

rebuildIndexes();

function safeText(value) {
  return String(value || '').toLocaleLowerCase('th');
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

function csvCell(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

function serializeCsv(items) {
  const rows = [['title', 'url', 'referer', 'user_agent', 'source', 'group', 'logo'].map(csvCell).join(',')];
  for (const item of items) {
    rows.push([item.title, item.url, item.referer, item.userAgent, item.source, item.group, item.logo].map(csvCell).join(','));
  }
  return `\uFEFF${rows.join('\r\n')}\r\n`;
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
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, content, 'utf8');
  fs.renameSync(temporaryPath, filePath);
}

function persistCatalog() {
  fs.mkdirSync(dataDir, { recursive: true });
  writeAtomic(csvPath, serializeCsv(movies));
  writeAtomic(m3uPath, serializeM3u(movies));
  writeAtomic(sourceStatePath, `${JSON.stringify(sourceState, null, 2)}\n`);
}

function publicSyncStatus() {
  return { ...syncStatus, memberIdConfigured: Boolean(memberId) };
}

function emitSyncEvent(kind = 'status') {
  const payload = JSON.stringify({ kind, sync: publicSyncStatus(), total: movies.length, sources, groups });
  for (const client of syncClients) client.write(`data: ${payload}\n\n`);
}

function sourceFingerprint(item) {
  return `${item.name}|${item.size ?? ''}|${item.updated ?? ''}`;
}

async function fetchSourceList() {
  const response = await fetch(`${upstreamBase}/cv/sources`, {
    headers: { 'User-Agent': defaultUserAgent },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`ตรวจรายการต้นทางไม่สำเร็จ (HTTP ${response.status})`);
  const body = await response.json();
  const byName = new Map((body.movie || []).map((item) => [item.name, item]));
  return monitoredSources.map((name) => {
    const item = byName.get(name);
    if (!item) throw new Error(`ไม่พบแหล่งข้อมูล ${name}`);
    return item;
  });
}

async function fetchSourceMovies(source) {
  const endpoint = `${upstreamBase}/cv/playlist?src=${encodeURIComponent(source)}&id=${encodeURIComponent(memberId)}`;
  const response = await fetch(endpoint, {
    headers: { 'User-Agent': defaultUserAgent },
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) throw new Error(`${source}: HTTP ${response.status}`);
  return parsePlaylist(await response.text(), source);
}

async function checkForUpdates() {
  if (!memberId || syncInProgress) return;
  syncInProgress = true;
  Object.assign(syncStatus, { syncing: true, lastError: '', changedSources: [], lastAdded: 0, lastRemoved: 0 });
  emitSyncEvent();

  try {
    const remoteSources = await fetchSourceList();
    const changed = remoteSources.filter((item) => sourceState[item.name]?.fingerprint !== sourceFingerprint(item));
    syncStatus.lastCheckedAt = new Date().toISOString();

    if (!changed.length) {
      syncStatus.syncing = false;
      emitSyncEvent();
      return;
    }

    const previousKeys = new Set(movies.map((movie) => `${movie.title}\u0000${movie.url}`));
    const replacements = new Map();
    const failures = [];
    for (const sourceInfo of changed) {
      try {
        replacements.set(sourceInfo.name, await fetchSourceMovies(sourceInfo.name));
        sourceState[sourceInfo.name] = {
          size: sourceInfo.size,
          updated: sourceInfo.updated,
          fingerprint: sourceFingerprint(sourceInfo),
          syncedAt: new Date().toISOString(),
        };
      } catch (error) {
        failures.push(String(error.message || error));
      }
    }

    if (replacements.size) {
      // The updater is intentionally additive: a source refresh may add new titles,
      // but it never removes an existing local entry without an explicit user action.
      const combined = [...movies, ...[...replacements.values()].flat()];
      const deduplicated = [];
      const seen = new Set();
      for (const movie of combined) {
        const key = `${movie.title}\u0000${movie.url}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduplicated.push(movie);
      }
      const nextKeys = new Set(deduplicated.map((movie) => `${movie.title}\u0000${movie.url}`));
      syncStatus.lastAdded = [...nextKeys].filter((key) => !previousKeys.has(key)).length;
      syncStatus.lastRemoved = 0;
      syncStatus.changedSources = [...replacements.keys()];
      syncStatus.lastUpdatedAt = new Date().toISOString();
      movies = deduplicated;
      rebuildIndexes();
      persistCatalog();
    }

    syncStatus.lastError = failures.join(' • ');
    syncStatus.syncing = false;
    emitSyncEvent(replacements.size ? 'catalog-updated' : 'status');
  } catch (error) {
    syncStatus.lastCheckedAt = new Date().toISOString();
    syncStatus.lastError = String(error.message || error);
    syncStatus.syncing = false;
    emitSyncEvent();
  } finally {
    syncInProgress = false;
  }
}

function signResource(id, url) {
  return crypto.createHmac('sha256', signingKey).update(`${id}|${url}`).digest('base64url');
}

function proxiedResource(id, url) {
  const params = new URLSearchParams({ resource: url, sig: signResource(id, url) });
  return `/api/proxy/${id}?${params}`;
}

function isManifest(contentType, sample, url) {
  return /mpegurl|vnd\.apple/i.test(contentType) || /^\s*#EXTM3U/i.test(sample) || /\.m3u8(?:$|\?)/i.test(url);
}

function rewriteManifest(text, baseUrl, movieId) {
  return text.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (!trimmed.startsWith('#')) {
      const absolute = new URL(trimmed, baseUrl).href;
      return proxiedResource(movieId, absolute);
    }
    return line.replace(/URI="([^"]+)"/g, (_, uri) => {
      const absolute = new URL(uri, baseUrl).href;
      return `URI="${proxiedResource(movieId, absolute)}"`;
    });
  }).join('\n');
}

const app = express();
app.disable('x-powered-by');

app.get('/api/meta', (_req, res) => {
  res.json({ total: movies.length, m3uEntries: movies.length, sources, groups, sync: publicSyncStatus() });
});

app.get('/api/updates', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  syncClients.add(res);
  res.write(`data: ${JSON.stringify({ kind: 'connected', sync: publicSyncStatus(), total: movies.length, sources, groups })}\n\n`);
  const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 25000);
  req.on('close', () => {
    clearInterval(heartbeat);
    syncClients.delete(res);
  });
});

app.get('/api/movies', (req, res) => {
  const query = safeText(req.query.q).trim();
  const source = String(req.query.source || '');
  const group = String(req.query.group || '');
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(12, Number(req.query.pageSize) || 48));
  const filtered = movies.filter((movie) => {
    if (source && movie.source !== source) return false;
    if (group && movie.group !== group) return false;
    if (query && !safeText(movie.title).includes(query)) return false;
    return true;
  });
  const start = (page - 1) * pageSize;
  res.json({
    page,
    pageSize,
    total: filtered.length,
    items: filtered.slice(start, start + pageSize).map((movie) => ({
      id: movie.id,
      title: movie.title,
      source: movie.source,
      group: movie.group,
      logo: movie.logo,
      requiresReferer: Boolean(movie.referer),
      streamType: /\.m3u8(?:$|\?)/i.test(movie.url) ? 'HLS' : /\.mp4(?:$|\?)/i.test(movie.url) ? 'MP4' : 'VIDEO',
    })),
  });
});

app.get('/api/movies/:id', (req, res) => {
  const movie = moviesById.get(req.params.id);
  if (!movie) return res.status(404).json({ error: 'ไม่พบรายการ' });
  res.json({
    id: movie.id,
    title: movie.title,
    source: movie.source,
    group: movie.group,
    logo: movie.logo,
    directUrl: movie.url,
    playUrl: `/api/proxy/${movie.id}`,
    requiresReferer: Boolean(movie.referer),
  });
});

app.get('/api/proxy/:id', async (req, res) => {
  const id = req.params.id;
  const movie = moviesById.get(id);
  if (!movie) return res.status(404).send('Unknown movie');

  let target = movie.url;
  if (req.query.resource || req.query.sig) {
    const resource = String(req.query.resource || '');
    const signature = String(req.query.sig || '');
    const expected = signResource(id, resource);
    if (!resource || signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      return res.status(403).send('Invalid media signature');
    }
    target = resource;
  }

  let parsedTarget;
  try {
    parsedTarget = new URL(target);
  } catch {
    return res.status(400).send('Invalid media URL');
  }
  if (!['http:', 'https:'].includes(parsedTarget.protocol)) return res.status(400).send('Unsupported protocol');

  const headers = { 'User-Agent': movie.userAgent };
  if (movie.referer) headers.Referer = movie.referer;
  if (req.headers.range) headers.Range = req.headers.range;

  try {
    const upstream = await fetch(target, { headers, redirect: 'follow', signal: AbortSignal.timeout(30000) });
    if (!upstream.ok && upstream.status !== 206) {
      const message = await upstream.text().catch(() => '');
      return res.status(upstream.status).send(message.slice(0, 1000));
    }

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    if (isManifest(contentType, '', upstream.url)) {
      const body = await upstream.text();
      if (isManifest(contentType, body.slice(0, 64), upstream.url)) {
        res.type('application/vnd.apple.mpegurl');
        res.set('Cache-Control', 'no-store');
        return res.send(rewriteManifest(body, upstream.url, id));
      }
    }

    res.status(upstream.status);
    for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']) {
      const value = upstream.headers.get(name);
      if (value) res.set(name, value);
    }
    if (!upstream.body) return res.end();
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (error) {
    if (!res.headersSent) res.status(502).json({ error: 'โหลดสตรีมไม่สำเร็จ', detail: String(error.message || error) });
    else res.destroy(error);
  }
});

if (isDev) {
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
} else {
  const dist = path.join(here, 'dist');
  app.use(express.static(dist));
  app.get('*path', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

const server = app.listen(port, '127.0.0.1', () => {
  process.stdout.write(`Doowise Play ready at http://127.0.0.1:${port}\n`);
  if (memberId) {
    process.stdout.write(`Auto-sync enabled every ${syncIntervalMinutes} minutes for ${monitoredSources.length} sources\n`);
    void checkForUpdates();
  } else {
    process.stdout.write('Auto-sync disabled: DOOWISE_MEMBER_ID is missing\n');
  }
});

const syncTimer = setInterval(() => void checkForUpdates(), syncIntervalMs);
syncTimer.unref();

function shutdown() {
  clearInterval(syncTimer);
  for (const client of syncClients) client.end();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
