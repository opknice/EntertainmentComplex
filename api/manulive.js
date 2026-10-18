import { resolveManuLive } from '../lib/manulive.js';

export const config = { runtime: 'edge' };

export default async function handler(request) {
  if (request.method !== 'GET') return Response.json({ error: 'method not allowed' }, { status: 405 });
  const url = new URL(request.url);
  try {
    const data = await resolveManuLive(async path => {
      const response = await fetch(new URL(path, url.origin), { cache: 'no-store', signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error('catalog unavailable');
      return response.json();
    }, (url.searchParams.get('channel') || '').slice(0, 256), (url.searchParams.get('revision') || '').slice(0, 1024));
    return Response.json(data, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ error: 'โหลดช่องไม่สำเร็จ กรุณาลองเชื่อมต่อใหม่' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
