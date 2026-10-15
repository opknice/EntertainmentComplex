import { useEffect, useMemo, useRef, useState } from 'react';

const PAGE_SIZE = 48;
const POLL_INTERVAL_MS = 15 * 60 * 1000;
const emptyCatalog = { version: '', generatedAt: '', total: 0, liveTotal: 0, sportsTotal: 0, sources: [], groups: [], items: [], live: [], sports: [] };
const sections = [
  { id: 'movies', label: 'หนัง', eyebrow: 'รายการหนัง' },
  { id: 'live', label: 'ทีวีสด', eyebrow: 'ช่องทีวีสด' },
  { id: 'sports', label: 'กีฬาสด', eyebrow: 'โปรแกรมกีฬา' },
];

function formatSyncTime(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function formatEventTime(value) {
  if (!value) return 'เวลาแข่งขันจะแจ้งภายหลัง';
  const date = new Date(value.replace(' ', 'T'));
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('th-TH', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(date);
}

function SyncStatus({ catalog, checking }) {
  const generated = formatSyncTime(catalog.generatedAt);
  return <span className={`sync-pill${checking ? ' is-syncing' : ''}`} title={generated ? `ข้อมูลล่าสุด ${generated}` : 'กำลังโหลดข้อมูล'}><span className="sync-dot" />{checking ? 'กำลังตรวจข้อมูลใหม่…' : 'ตรวจข้อมูลใหม่ทุก 15 นาที'}</span>;
}

function useDebounced(value, delay = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

function Player({ item, onClose }) {
  const videoRef = useRef(null);
  const [status, setStatus] = useState('กำลังเตรียมเครื่องเล่น…');

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !item) return undefined;
    let hls;
    let shakaPlayer;
    let cancelled = false;
    setStatus('กำลังเชื่อมต่อสตรีม…');

    async function setupPlayer() {
      if (item.streamType === 'DASH') {
        const module = await import('shaka-player/dist/shaka-player.compiled.js');
        const shaka = module.default || module;
        shaka.polyfill.installAll();
        if (!shaka.Player.isBrowserSupported()) throw new Error('DASH_NOT_SUPPORTED');
        shakaPlayer = new shaka.Player();
        await shakaPlayer.attach(video);
        const network = shakaPlayer.getNetworkingEngine();
        network.registerRequestFilter((type, request) => {
          if (type === shaka.net.NetworkingEngine.RequestType.MANIFEST) return;
          request.uris = request.uris.map((uri) => `${item.playUrl}&u=${encodeURIComponent(uri)}`);
        });
        await shakaPlayer.load(item.playUrl, null, 'application/dash+xml');
        if (!cancelled) {
          setStatus('พร้อมเล่น');
          video.play().catch(() => setStatus('กดปุ่มเล่นเพื่อเริ่มรับชม'));
        }
        return;
      }

      const { default: Hls } = await import('hls.js');
      if (cancelled) return;
      if (Hls.isSupported()) {
        hls = new Hls({ enableWorker: true, lowLatencyMode: true });
        hls.loadSource(item.playUrl);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          setStatus('พร้อมเล่น');
          video.play().catch(() => setStatus('กดปุ่มเล่นเพื่อเริ่มรับชม'));
        });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) setStatus(`เล่นไม่ได้: ${data.details || data.type}`);
        });
      } else {
        video.src = item.playUrl;
        video.addEventListener('loadedmetadata', () => setStatus('พร้อมเล่น'), { once: true });
        video.addEventListener('error', () => setStatus('เบราว์เซอร์นี้ไม่รองรับรูปแบบวิดีโอ'), { once: true });
        video.load();
      }
    }

    setupPlayer().catch((error) => {
      console.error('player setup failed', error);
      if (error?.message === 'DASH_NOT_SUPPORTED') {
        setStatus('เบราว์เซอร์นี้ไม่รองรับ DASH');
        return;
      }
      const detail = error?.code || error?.message;
      setStatus(`โหลดสตรีมไม่สำเร็จ${detail ? ` (${detail})` : ''}`);
    });
    return () => {
      cancelled = true;
      hls?.destroy();
      shakaPlayer?.destroy();
      video.removeAttribute('src');
      video.load();
    };
  }, [item]);

  return (
    <section className="player-shell" aria-label="เครื่องเล่นวิดีโอ">
      <div className="player-topbar"><div><span className="eyebrow">กำลังรับชม</span><h2>{item.title}</h2></div><button className="icon-button" type="button" onClick={onClose} aria-label="ปิดเครื่องเล่น">×</button></div>
      <div className="video-frame"><video ref={videoRef} controls playsInline poster={item.logo || undefined} /></div>
      <div className="player-meta"><span className="status-dot" /><span>{status}</span><span className="meta-separator">•</span><span>{item.source || item.group}</span><span className="badge">ผ่าน secure proxy</span></div>
      {item.directUrl && <details><summary>รายละเอียดลิงก์</summary><p className="direct-url">{item.directUrl}</p></details>}
    </section>
  );
}

function MediaCard({ item, onPlay, sport }) {
  return (
    <article className={`movie-card${sport ? ' sport-card' : ''}`}>
      <button className="poster-button" type="button" onClick={() => onPlay(item)} aria-label={`เล่น ${item.title}`}>
        {sport && item.awayLogo ? <div className="team-logos"><img src={item.logo} alt="" /><span>VS</span><img src={item.awayLogo} alt="" /></div> : item.logo ? <img src={item.logo} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <div className="poster-fallback"><span>{sport ? 'LIVE' : '▶'}</span></div>}
        <span className="play-chip">▶ ดูสด</span>
      </button>
      <div className="card-body"><h3 title={item.title}>{item.title}</h3>{sport && <p className="event-time">{formatEventTime(item.time)}</p>}<div className="card-meta"><span>{sport ? item.sport : item.streamType}</span><span>{item.source?.replace('.m3u', '') || item.group}</span></div></div>
    </article>
  );
}

async function fetchJson(pathname) {
  const separator = pathname.includes('?') ? '&' : '?';
  const response = await fetch(`${pathname}${separator}t=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function allCatalogItems(catalog) {
  return [...catalog.items, ...catalog.live, ...catalog.sports];
}

export default function App() {
  const [catalog, setCatalog] = useState(emptyCatalog);
  const [section, setSection] = useState('movies');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [syncNotice, setSyncNotice] = useState('');
  const debouncedQuery = useDebounced(query);
  const versionRef = useRef('');

  useEffect(() => {
    let cancelled = false;
    fetchJson('/data/catalog.json').then((data) => {
      if (cancelled) return;
      versionRef.current = data.version;
      setCatalog({ ...emptyCatalog, ...data, live: data.live || [], sports: data.sports || [] });
    }).catch(() => !cancelled && setError('โหลดคลังรายการไม่สำเร็จ')).finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let noticeTimer;
    async function checkForUpdates() {
      setChecking(true);
      try {
        const version = await fetchJson('/data/version.json');
        if (!cancelled && version.version && versionRef.current && version.version !== versionRef.current) {
          const next = { ...emptyCatalog, ...await fetchJson('/data/catalog.json') };
          if (cancelled) return;
          versionRef.current = next.version;
          setCatalog(next);
          setSelected((current) => current ? allCatalogItems(next).find((item) => item.id === current.id) || null : null);
          setSyncNotice(`อัปเดตคลังแล้ว: หนัง ${next.total.toLocaleString('th-TH')} เรื่อง · ทีวี ${next.liveTotal.toLocaleString('th-TH')} ช่อง`);
          window.clearTimeout(noticeTimer);
          noticeTimer = window.setTimeout(() => setSyncNotice(''), 8000);
        }
      } catch {
        if (!cancelled) setError((current) => current || 'ตรวจข้อมูลอัปเดตไม่สำเร็จ ระบบจะลองใหม่อัตโนมัติ');
      } finally {
        if (!cancelled) setChecking(false);
      }
    }
    const interval = window.setInterval(checkForUpdates, POLL_INTERVAL_MS);
    return () => { cancelled = true; window.clearInterval(interval); window.clearTimeout(noticeTimer); };
  }, []);

  useEffect(() => { setPage(1); setFilter(''); setSelected(null); }, [section]);
  useEffect(() => setPage(1), [debouncedQuery, filter]);

  const activeItems = section === 'live' ? catalog.live : section === 'sports' ? catalog.sports : catalog.items;
  const filterOptions = useMemo(() => [...new Set(activeItems.map((item) => section === 'movies' ? item.source : section === 'live' ? item.group : item.sport).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'th')), [activeItems, section]);
  const filteredItems = useMemo(() => {
    const normalized = debouncedQuery.trim().toLocaleLowerCase('th');
    return activeItems.filter((item) => {
      const itemFilter = section === 'movies' ? item.source : section === 'live' ? item.group : item.sport;
      return (!filter || itemFilter === filter) && (!normalized || `${item.title} ${item.source || ''} ${item.league || ''}`.toLocaleLowerCase('th').includes(normalized));
    });
  }, [activeItems, debouncedQuery, filter, section]);
  const pageCount = Math.max(1, Math.ceil(filteredItems.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const visibleItems = filteredItems.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const activeMeta = sections.find((item) => item.id === section);
  const range = filteredItems.length ? `${((safePage - 1) * PAGE_SIZE + 1).toLocaleString('th-TH')}–${Math.min(safePage * PAGE_SIZE, filteredItems.length).toLocaleString('th-TH')} จาก ${filteredItems.length.toLocaleString('th-TH')}` : '0 รายการ';

  return (
    <div className="app-shell">
      <header className="hero">
        <nav><div className="brand"><span className="brand-mark">D</span><span>Doowise Play</span></div><div className="nav-status"><SyncStatus catalog={catalog} checking={checking} /><span className="library-count">หนัง {catalog.total.toLocaleString('th-TH')} · ทีวี {catalog.liveTotal.toLocaleString('th-TH')} · กีฬา {catalog.sportsTotal.toLocaleString('th-TH')}</span></div></nav>
        <div className="hero-copy"><span className="eyebrow">PRIVATE ENTERTAINMENT HUB</span><h1>คืนนี้ดูอะไรดี?</h1><p>หนัง ทีวีสด และโปรแกรมกีฬา จาก Doowise Play ในหน้าจอเดียว</p></div>
        <div className="content-tabs" role="tablist" aria-label="ประเภทเนื้อหา">{sections.map((item) => <button key={item.id} type="button" role="tab" aria-selected={section === item.id} className={section === item.id ? 'active' : ''} onClick={() => setSection(item.id)}>{item.label}<span>{item.id === 'movies' ? catalog.total : item.id === 'live' ? catalog.liveTotal : catalog.sportsTotal}</span></button>)}</div>
        <div className="search-panel"><label className="search-box"><span aria-hidden="true">⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={section === 'sports' ? 'ค้นหาทีม ลีก หรือรายการกีฬา…' : 'ค้นหาชื่อรายการ…'} />{query && <button type="button" onClick={() => setQuery('')} aria-label="ล้างการค้นหา">×</button>}</label><label className="select-box"><span>{section === 'movies' ? 'แหล่งข้อมูล' : section === 'live' ? 'หมวดช่อง' : 'ชนิดกีฬา'}</span><select value={filter} onChange={(event) => setFilter(event.target.value)}><option value="">ทั้งหมด</option>{filterOptions.map((item) => <option key={item} value={item}>{item}</option>)}</select></label></div>
      </header>

      <main>
        {syncNotice && <div className="sync-notice" role="status">✓ {syncNotice}</div>}
        {selected && <Player item={selected} onClose={() => setSelected(null)} />}
        <div className="section-heading"><div><span className="eyebrow">{activeMeta.eyebrow}</span><h2>{debouncedQuery ? `ผลการค้นหา “${debouncedQuery}”` : filter || (section === 'movies' ? 'หนังทั้งหมด' : section === 'live' ? 'ช่องทั้งหมด' : 'การแข่งขันทั้งหมด')}</h2></div><span className="result-range">{range}</span></div>
        {error && <div className="error-banner" role="alert">{error}</div>}
        {loading ? <div className="loading-grid" aria-label="กำลังโหลด">{Array.from({ length: 12 }, (_, index) => <div className="skeleton" key={index} />)}</div> : visibleItems.length ? <div className={`movie-grid${section === 'sports' ? ' sports-grid' : ''}`}>{visibleItems.map((item) => <MediaCard key={item.id} item={item} sport={section === 'sports'} onPlay={setSelected} />)}</div> : <div className="empty-state"><span>⌕</span><h3>ไม่พบรายการที่ค้นหา</h3><p>ลองใช้คำค้นสั้นลงหรือเลือกหมวดอื่น</p></div>}
        <div className="pagination" aria-label="เปลี่ยนหน้า"><button type="button" disabled={safePage <= 1} onClick={() => setPage((value) => value - 1)}>← ก่อนหน้า</button><span>หน้า {safePage.toLocaleString('th-TH')} / {pageCount.toLocaleString('th-TH')}</span><button type="button" disabled={safePage >= pageCount} onClick={() => setPage((value) => value + 1)}>ถัดไป →</button></div>
      </main>
      <footer><span>Doowise Play</span><span>หนัง ทีวีสด และกีฬา อัปเดตอัตโนมัติทุก 15 นาที · เล่นผ่าน secure proxy</span></footer>
    </div>
  );
}
