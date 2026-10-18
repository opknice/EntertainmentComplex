export const SPORTS_ORIGIN = 'https://atmflix.live';
export const SPORTS_FEEDS = { football: '/api/fixtures/date', volleyball: '/api/volleyball/fixtures', hockey: '/api/hockey/fixtures', nfl: '/api/nfl/fixtures', event: '/api/events' };
export const SPORTS_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36', Origin: SPORTS_ORIGIN, Referer: `${SPORTS_ORIGIN}/`, Accept: 'application/json' };

export function sportTimestamp(value) {
  let text = String(value || '').trim().replace(' ', 'T');
  if (!text) return NaN;
  if (/[+-]\d{2}$/.test(text)) text += ':00';
  else if (/[+-]\d{4}$/.test(text)) text = text.slice(0, -2) + ':' + text.slice(-2);
  else if (!/(Z|[+-]\d{2}:\d{2})$/i.test(text)) text += '+07:00';
  return Date.parse(text);
}

export function isRelevantSport(item, now = Date.now()) {
  if (['FT', 'AET', 'PEN', 'Finished', 'Cancelled', 'Canceled', 'Postponed'].includes(String(item.status || ''))) return false;
  const time = sportTimestamp(item.time);
  return !Number.isFinite(time) || time >= now - 8 * 3600000 && time <= now + 48 * 3600000;
}

function rows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object' || !Object.values(payload).every(Array.isArray)) throw new Error('invalid fixture response');
  return Object.values(payload).flat();
}

async function stableId(title, channel) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${title}\0${channel}`)));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '').slice(0, 22);
}

export async function fetchSportsCatalog({ loadFeed, previousSports = [], now = Date.now() }) {
  const results = [], failures = [];
  let fallbackCount = 0;
  await Promise.all(Object.keys(SPORTS_FEEDS).map(async sport => {
    try {
      const records = rows(await loadFeed(sport));
      const parsed = [];
      for (const item of records) {
        if (!item || typeof item !== 'object') throw new Error('invalid fixture record');
        const channel = String(item.channel || '').trim();
        if (!channel) continue;
        const time = String(sport === 'event' ? item.start || '' : item.event_time || '');
        const home = item.teamhome?.name_th || item.teamhome?.name || '';
        const away = item.teamaway?.name_th || item.teamaway?.name || '';
        const title = sport === 'event' ? String(item.title || channel) : `${home} vs ${away}`.trim().replace(/^vs$|^\s*vs\s*/i, '') || String(item.title || channel);
        parsed.push({ id: await stableId(`${sport}:${title}:${time}`, channel), title, sport,
          league: sport === 'event' ? 'อีเวนต์' : item.league_info?.name_th || item.league_info?.name || String(item.league_round || sport).split(' - ')[0],
          time, status: String(item.status_short || ''), channel,
          logo: sport === 'event' ? String(item.thumbnail || '') : item.teamhome?.logo || '', awayLogo: item.teamaway?.logo || '' });
      }
      results.push(...parsed);
    } catch (error) {
      const fallback = previousSports.filter(item => item.sport === sport && isRelevantSport(item, now));
      failures.push({ source: sport, reason: error.message });
      fallbackCount += fallback.length;
      results.push(...fallback);
    }
  }));
  const items = [...new Map(results.filter(item => isRelevantSport(item, now)).map(item => [`${item.channel}\0${item.time}\0${item.title}`, item])).values()]
    .sort((a, b) => (sportTimestamp(a.time) || 0) - (sportTimestamp(b.time) || 0) || a.title.localeCompare(b.title));
  return { items, failures: failures.sort((a, b) => a.source.localeCompare(b.source)), fallbackCount };
}

export function publicSportItems(items, proxyBase = '/api/sports') {
  return items.map(item => ({ ...item, source: item.league, group: item.sport, streamType: 'HLS', playUrl: `${proxyBase}?ch=${encodeURIComponent(item.channel)}` }));
}
