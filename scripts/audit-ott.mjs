import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const values = (flag) => args.flatMap((value, index) => value === flag ? [args[index + 1]] : []);
const groups = new Set(values('--group'));
for (const file of values('--scope-report')) {
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const group of report.scope || []) groups.add(group);
}
const output = values('--out')[0];
const concurrency = Number(values('--concurrency')[0] || 24);
if (!output || !groups.size || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) {
  throw new Error('Usage: node scripts/audit-ott.mjs --group NAME [--scope-report previous.json] --out report.json [--concurrency 24] [--direct-on-error]');
}
const directOnError = args.includes('--direct-on-error');
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'public/data/catalog.json'), 'utf8'));
const index = JSON.parse(fs.readFileSync(path.join(root, 'public', catalog.ottSummary.indexUrl), 'utf8'));
const limit = Number(values('--limit')[0] || Infinity);
const selectedIds = values('--ids-file')[0] ? new Set(JSON.parse(fs.readFileSync(values('--ids-file')[0], 'utf8'))) : null;
const entries = index.entries.filter((entry) => groups.has(entry[2]) && (!selectedIds || selectedIds.has(entry[0]))).slice(0, limit);
if (!entries.length) throw new Error('No catalog entries match the requested scope');
const neededIds = new Set(entries.map((entry) => entry[0]));
const items = new Map();
for (const part of new Set(entries.map((entry) => entry[3]))) {
  const shard = JSON.parse(fs.readFileSync(path.join(root, 'public', index.partsBase, `part-${part}.json`), 'utf8'));
  for (const item of shard.items) if (neededIds.has(item.id)) items.set(item.id, item);
}

function sourceRequest(proxyUrl) {
  const parsed = new URL(proxyUrl);
  const encoded = parsed.searchParams.get('p');
  if (!encoded) return { url: parsed, headers: {} };
  const payload = JSON.parse(Buffer.from(encoded, 'base64url'));
  return {
    url: new URL(parsed.searchParams.get('u') || payload.u),
    headers: { ...(payload.a ? { 'User-Agent': payload.a } : {}), ...(payload.r ? { Referer: payload.r } : {}), ...(payload.h || {}) },
  };
}

async function read(url, headers = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15000), redirect: 'follow' });
  const reader = response.body?.getReader();
  let size = 0;
  const chunks = [];
  let manifest = false;
  let checked = false;
  let done = false;
  let prefix = '';
  try {
    if (reader) while (true) {
      const part = await reader.read();
      if (part.done) { done = true; break; }
      chunks.push(part.value); size += part.value.length;
      if (!checked && size >= 1024) {
        prefix = Buffer.concat(chunks).subarray(0, 1024).toString('utf8').replace(/^\uFEFF/, '').trimStart();
        manifest = prefix.startsWith('#EXTM3U') || prefix.startsWith('<') && /<MPD[\s>]/.test(prefix);
        checked = true;
      }
      if (manifest ? size > 5 * 1024 * 1024 : checked && size >= 4096) break;
    }
  } finally { await reader?.cancel(); }
  const bytes = Buffer.concat(chunks);
  const text = bytes.toString('utf8');
  prefix ||= text.slice(0, 1024).replace(/^\uFEFF/, '').trimStart();
  const hls = prefix.startsWith('#EXTM3U');
  const dash = prefix.startsWith('<') && /<MPD[\s>]/.test(prefix);
  const html = /^<!doctype\s+html|^<html[\s>]/i.test(prefix);
  const ts = bytes.length >= 377 && bytes[0] === 0x47 && bytes[188] === 0x47 && bytes[376] === 0x47;
  const mp4 = /^(?:ftyp|styp|moof|moov)$/.test(bytes.subarray(4, 8).toString('ascii'));
  let error;
  if (!response.ok && /json/i.test(response.headers.get('content-type') || '')) {
    try {
      const reason = JSON.parse(text).error;
      if (['invalid signature', 'link expired', 'target origin mismatch', 'proxy request failed'].includes(reason)) error = reason;
    } catch { /* A truncated/non-JSON error body remains an HTTP observation. */ }
  }
  return { response, bytes, text, done, hls, dash, html, ts, mp4, error };
}

function httpOutcome(status, error) {
  if (error === 'link expired') return 'application_link_expired';
  if (error) return 'proxy_error';
  if (status === 404) return 'not_found';
  if (status === 410) return 'gone';
  if (status === 401 || status === 403) return 'access_denied';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'origin_error';
  return 'http_error';
}

async function probe(item, group) {
  const result = { id: item.id, title: item.title, group, testedAt: new Date().toISOString(), checks: [], expiryConfirmed: false };
  let lastSource;
  async function check(url, stage) {
    lastSource = sourceRequest(url);
    const data = await read(url);
    const fact = { stage, sourceHost: lastSource.url.host, status: data.response.status, contentType: data.response.headers.get('content-type'), inspectedBytes: data.bytes.length, bodyKind: data.hls ? 'hls' : data.dash ? 'dash' : data.html ? 'html' : data.ts ? 'mpegts' : data.mp4 ? 'mp4' : 'other', ...(data.error ? { proxyError: data.error } : {}) };
    result.checks.push(fact);
    if (!data.response.ok) {
      result.outcome = httpOutcome(data.response.status, data.error);
      if (directOnError) {
        try {
          const direct = await read(lastSource.url, lastSource.headers);
          fact.direct = { status: direct.response.status, contentType: direct.response.headers.get('content-type'), inspectedBytes: direct.bytes.length, bodySha256: crypto.createHash('sha256').update(direct.bytes).digest('hex') };
          if ([401, 403, 410].includes(direct.response.status) && /\b(?:token|link|session|signature|url|stream)\b.{0,32}\bexpired\b/i.test(direct.text.slice(0, 4096))) {
            fact.direct.explicitExpiryMessage = true;
            result.outcome = 'upstream_token_expired';
            result.expiryConfirmed = true;
          }
        } catch (error) { fact.direct = { error: error.cause?.code || error.name }; }
      }
      return null;
    }
    return data;
  }
  try {
    let url = item.playUrl;
    let data;
    for (let depth = 0; depth < 6; depth++) {
      data = await check(url, depth ? 'variant_manifest' : 'entry');
      if (!data) return result;
      if (data.dash) { result.outcome = 'dash_manifest_available'; result.hasSuppliedClearKeys = Boolean(item.clearKeys); return result; }
      if (!data.hls) {
        result.outcome = !data.html && (data.ts || data.mp4 || /^(video|audio)\//i.test(data.response.headers.get('content-type') || '')) ? 'media_response_available' : 'unsupported_response';
        return result;
      }
      if (!data.done) { result.outcome = 'manifest_too_large'; return result; }
      const lines = data.text.split(/\r?\n/).map((line) => line.trim());
      const uris = lines.filter((line) => line && !line.startsWith('#'));
      if (!uris.length) { result.outcome = 'empty_manifest'; return result; }
      if (/#EXT-X-STREAM-INF/.test(data.text)) { url = new URL(uris[0], url).href; continue; }
      for (const line of lines.filter((line) => /^#EXT-X-(KEY|MAP):/.test(line))) {
        const resource = line.match(/URI="([^"]+)"/)?.[1];
        if (!resource || !/^https?:/i.test(new URL(resource, url).href)) continue;
        const resourceData = await check(new URL(resource, url).href, line.startsWith('#EXT-X-KEY:') ? 'encryption_key' : 'initialization_segment');
        if (!resourceData) return result;
        if (line.startsWith('#EXT-X-KEY:') && /METHOD=AES-128/.test(line) && resourceData.bytes.length !== 16) { result.outcome = 'invalid_encryption_key'; return result; }
      }
      const segments = [...new Set([uris[0], uris.at(-1)])];
      for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
        const segment = await check(new URL(segments[segmentIndex], url).href, segmentIndex ? 'last_segment' : 'first_segment');
        if (!segment) return result;
        if (!segment.bytes.length || segment.html || segment.hls || segment.dash) { result.outcome = 'invalid_media_segment'; return result; }
      }
      result.outcome = 'hls_segments_available';
      return result;
    }
    result.outcome = 'manifest_depth_exceeded';
  } catch (error) {
    result.outcome = error.name === 'TimeoutError' ? 'timeout' : 'network_error';
    result.error = error.cause?.code || error.name;
    if (lastSource) result.failedSourceHost = lastSource.url.host;
  }
  return result;
}

const startedAt = new Date().toISOString();
const results = new Array(entries.length);
const checkpoint = path.resolve(`${output}.ndjson`);
fs.mkdirSync(path.dirname(checkpoint), { recursive: true });
let resumed = new Map();
if (args.includes('--resume') && fs.existsSync(checkpoint)) {
  const saved = fs.readFileSync(checkpoint, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
  if (saved[0].catalogVersion !== catalog.ottSummary.version) throw new Error('Cannot resume evidence from a different catalog');
  resumed = new Map(saved.slice(1).map((result) => [result.id, result]));
} else fs.writeFileSync(checkpoint, `${JSON.stringify({ catalogVersion: catalog.ottSummary.version, startedAt, scope: [...groups] })}\n`);
let cursor = 0;
let completed = 0;
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (cursor < entries.length) {
    const position = cursor++;
    const [id, , group] = entries[position];
    results[position] = resumed.get(id) || await probe(items.get(id), group);
    if (!resumed.has(id)) fs.appendFileSync(checkpoint, `${JSON.stringify(results[position])}\n`);
    completed += 1;
    if (completed % 500 === 0) console.log(JSON.stringify({ completed, total: entries.length }));
  }
}));
const byGroup = {}, byOutcome = {};
for (const result of results) {
  byGroup[result.group] ||= {};
  byGroup[result.group][result.outcome] = (byGroup[result.group][result.outcome] || 0) + 1;
  byOutcome[result.outcome] = (byOutcome[result.outcome] || 0) + 1;
}
const report = { startedAt, finishedAt: new Date().toISOString(), catalogVersion: catalog.ottSummary.version, scope: [...groups], policy: 'Every selected entry is checked. HLS first/last segments and supplied AES keys are requested. A media response or DASH manifest does not establish browser decoding. 404, denied access, origin errors and timeouts never prove expiration. expiryConfirmed requires an explicit expiry message from the direct upstream response.', total: results.length, byOutcome, byGroup, results };
fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
fs.writeFileSync(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ output: path.resolve(output), total: report.total, byOutcome, byGroup }));
