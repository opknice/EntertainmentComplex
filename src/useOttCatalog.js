import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

async function readJson(url, signal) {
  const response = await fetch(url, { cache: 'no-store', signal });
  if (!response.ok) throw new Error(`OTT HTTP ${response.status}`);
  return response.json();
}

export function useOttCatalog(enabled, summary) {
  const [index, setIndex] = useState(null);
  const [loaded, setLoaded] = useState({});
  const [error, setError] = useState('');
  const cache = useRef(new Map());
  const generation = useRef(0);
  useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    const current = ++generation.current;
    setIndex(null);
    setLoaded({});
    setError('');
    cache.current.clear();
    readJson(summary?.indexUrl || '/data/ott/index.json', controller.signal)
      .then((data) => {
        if (!Array.isArray(data.entries)) throw new Error('Invalid OTT index');
        if (current === generation.current) setIndex(data);
      })
      .catch((reason) => { if (!controller.signal.aborted) setError(`โหลดคลัง OTT ไม่สำเร็จ (${reason.message})`); });
    return () => controller.abort();
  }, [enabled, summary?.version, summary?.indexUrl]);

  const loadItems = useCallback(async (entries) => {
    if (!index) return [];
    const current = generation.current;
    const parts = [...new Set(entries.map((item) => item.ottPart))];
    const chunks = await Promise.all(parts.map((part) => {
      if (!cache.current.has(part)) {
        const pending = readJson(`${index.partsBase || '/data/ott'}/part-${part}.json`).then((data) => {
          if (data.version !== index.version) throw new Error('คลังเปลี่ยนแล้ว กรุณาเปิดหมวด OTT ใหม่');
          if (current === generation.current) setLoaded((previous) => ({ ...previous, ...Object.fromEntries(data.items.map((item) => [item.id, item])) }));
          return data.items;
        }).catch((reason) => { cache.current.delete(part); throw reason; });
        cache.current.set(part, pending);
      }
      return cache.current.get(part);
    }));
    const byId = new Map(chunks.flat().map((item) => [item.id, item]));
    return entries.map((item) => byId.get(item.id) || item);
  }, [index]);

  const items = useMemo(() => (index?.entries || []).map(([id, title, group, ottPart]) => ({ id, title, group, ottPart, source: 'OTT Playlist', ...loaded[id] })), [index, loaded]);
  const loadVisible = useCallback((entries) => { loadItems(entries).catch((reason) => setError(reason.message)); }, [loadItems]);
  return { items, loading: enabled && !index && !error, error, loadItems, loadVisible };
}
