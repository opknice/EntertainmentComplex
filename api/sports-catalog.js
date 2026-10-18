import { fetchSportsCatalog, publicSportItems } from '../lib/sports-catalog.js';

export const config = { runtime: 'edge' };
const FEED_BASE = 'https://doowiseplay-proxy.kasthanakrit4.workers.dev/v1/sports-feed';

export default async function handler(request) {
  if (request.method !== 'GET') return Response.json({ error: 'method not allowed' }, { status: 405 });
  const checkedAt = new Date().toISOString();
  const result = await fetchSportsCatalog({ loadFeed: async feed => {
    const response = await fetch(`${FEED_BASE}?feed=${feed}`, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  } });
  const sportsHealth = { checkedAt, degraded: result.failures.length > 0, failedSources: result.failures.map(f => f.source), fallbackCount: 0 };
  return Response.json({ sports: publicSportItems(result.items), sportsTotal: result.items.length, sportsHealth }, {
    status: result.failures.length === 5 ? 503 : 200,
    headers: { 'Cache-Control': result.failures.length ? 'no-store' : 'public, max-age=0, s-maxage=60' },
  });
}
