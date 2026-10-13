import { useEffect, useMemo, useRef, useState } from 'react';

const PAGE_SIZE = 48;
const POLL_INTERVAL_MS = 15 * 60 * 1000;
const emptyCatalog = { version: '', generatedAt: '', total: 0, sources: [], groups: [], items: [] };

function formatSyncTime(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('th-TH', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value));
}

function SyncStatus({ catalog, checking }) {
  const generated = formatSyncTime(catalog.generatedAt);
  return (
    <span className={`sync-pill${checking ? ' is-syncing' : ''}`} title={generated ? `ข้อมูลล่าสุด ${generated}` : 'กำลังโหลดข้อมูล'}>
      <span className="sync-dot" />{checking ? 'กำลังตรวจข้อมูลใหม่…' : 'ตรวจข้อมูลใหม่ทุก 15 นาที'}
    </span>
  );
}

function useDebounced(value, delay = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

function Player({ movie, onClose }) {
  const videoRef = useRef(null);
  const [status, setStatus] = useState('กำลังเตรียมเครื่องเล่น…');

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !movie) return undefined;
    let hls;
    let cancelled = false;
    setStatus('กำลังเชื่อมต่อสตรีม…');
    const ready = () => setStatus('พร้อมเล่น');
    const failed = () => setStatus('เบราว์เซอร์นี้ไม่รองรับรูปแบบวิดีโอ');

    async function setupPlayer() {
      const { default: Hls } = await import('hls.js');
      if (cancelled) return;
      if (Hls.isSupported()) {
        hls = new Hls({ enableWorker: true, lowLatencyMode: false });
        hls.loadSource(movie.playUrl);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          setStatus('พร้อมเล่น');
          video.play().catch(() => setStatus('กดปุ่มเล่นเพื่อเริ่มรับชม'));
        });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) setStatus(`เล่นไม่ได้: ${data.details || data.type}`);
        });
      } else {
        video.src = movie.playUrl;
        video.addEventListener('loadedmetadata', ready);
        video.addEventListener('error', failed);
        video.load();
      }
    }

    setupPlayer().catch(() => setStatus('โหลดเครื่องเล่นไม่สำเร็จ'));
    return () => {
      cancelled = true;
      hls?.destroy();
      video.removeEventListener('loadedmetadata', ready);
      video.removeEventListener('error', failed);
      video.removeAttribute('src');
      video.load();
    };
  }, [movie]);

  return (
    <section className="player-shell" aria-label="เครื่องเล่นวิดีโอ">
      <div className="player-topbar">
        <div><span className="eyebrow">กำลังรับชม</span><h2>{movie.title}</h2></div>
        <button className="icon-button" type="button" onClick={onClose} aria-label="ปิดเครื่องเล่น">×</button>
      </div>
      <div className="video-frame"><video ref={videoRef} controls playsInline poster={movie.logo || undefined} /></div>
      <div className="player-meta">
        <span className="status-dot" /><span>{status}</span><span className="meta-separator">•</span>
        <span>{movie.source}</span><span className="badge">ผ่าน secure proxy</span>
      </div>
      <details><summary>รายละเอียดลิงก์</summary><p className="direct-url">{movie.directUrl}</p></details>
    </section>
  );
}

function MovieCard({ movie, onPlay }) {
  return (
    <article className="movie-card">
      <button className="poster-button" type="button" onClick={() => onPlay(movie.id)} aria-label={`เล่น ${movie.title}`}>
        {movie.logo ? <img src={movie.logo} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <div className="poster-fallback"><span>▶</span></div>}
        <span className="play-chip">▶ เล่น</span>
      </button>
      <div className="card-body">
        <h3 title={movie.title}>{movie.title}</h3>
        <div className="card-meta"><span>{movie.streamType}</span><span>{movie.source.replace('.m3u', '')}</span></div>
      </div>
    </article>
  );
}

async function fetchJson(pathname) {
  const separator = pathname.includes('?') ? '&' : '?';
  const response = await fetch(`${pathname}${separator}t=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export default function App() {
  const [catalog, setCatalog] = useState(emptyCatalog);
  const [query, setQuery] = useState('');
  const [source, setSource] = useState('');
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
      setCatalog(data);
    }).catch(() => {
      if (!cancelled) setError('โหลดรายการหนังไม่สำเร็จ');
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
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
          const nextCatalog = await fetchJson('/data/catalog.json');
          if (cancelled) return;
          versionRef.current = nextCatalog.version;
          setCatalog(nextCatalog);
          setSelected((current) => current ? nextCatalog.items.find((item) => item.id === current.id) || null : null);
          setSyncNotice(`อัปเดตคลังแล้ว: ${nextCatalog.total.toLocaleString('th-TH')} เรื่อง`);
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
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.clearTimeout(noticeTimer);
    };
  }, []);

  useEffect(() => setPage(1), [debouncedQuery, source]);

  const filteredItems = useMemo(() => {
    const normalizedQuery = debouncedQuery.trim().toLocaleLowerCase('th');
    return catalog.items.filter((movie) => {
      if (source && movie.source !== source) return false;
      return !normalizedQuery || movie.title.toLocaleLowerCase('th').includes(normalizedQuery);
    });
  }, [catalog.items, debouncedQuery, source]);
  const pageCount = Math.max(1, Math.ceil(filteredItems.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const visibleItems = filteredItems.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  function playMovie(id) {
    const movie = catalog.items.find((item) => item.id === id);
    if (!movie) {
      setError('เปิดรายการนี้ไม่สำเร็จ');
      return;
    }
    setError('');
    setSelected(movie);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const range = useMemo(() => {
    if (!filteredItems.length) return '0 รายการ';
    const start = (safePage - 1) * PAGE_SIZE + 1;
    const end = Math.min(safePage * PAGE_SIZE, filteredItems.length);
    return `${start.toLocaleString('th-TH')}–${end.toLocaleString('th-TH')} จาก ${filteredItems.length.toLocaleString('th-TH')}`;
  }, [safePage, filteredItems.length]);

  return (
    <div className="app-shell">
      <header className="hero">
        <nav>
          <div className="brand"><span className="brand-mark">D</span><span>Doowise Play</span></div>
          <div className="nav-status"><SyncStatus catalog={catalog} checking={checking} /><span className="library-count">คลัง {catalog.total.toLocaleString('th-TH')} เรื่อง</span></div>
        </nav>
        <div className="hero-copy"><span className="eyebrow">PRIVATE MOVIE LIBRARY</span><h1>คืนนี้ดูเรื่องอะไรดี?</h1><p>ค้นหาและเปิดลิงก์จากคลัง M3U/CSV ของคุณในหน้าจอเดียว</p></div>
        <div className="search-panel">
          <label className="search-box">
            <span aria-hidden="true">⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="ค้นหาชื่อหนัง…" />
            {query && <button type="button" onClick={() => setQuery('')} aria-label="ล้างการค้นหา">×</button>}
          </label>
          <label className="select-box">
            <span>แหล่งข้อมูล</span>
            <select value={source} onChange={(event) => setSource(event.target.value)}><option value="">ทุกแหล่ง</option>{catalog.sources.map((item) => <option key={item} value={item}>{item}</option>)}</select>
          </label>
        </div>
      </header>

      <main>
        {syncNotice && <div className="sync-notice" role="status">✓ {syncNotice}</div>}
        {selected && <Player movie={selected} onClose={() => setSelected(null)} />}
        <div className="section-heading">
          <div><span className="eyebrow">รายการหนัง</span><h2>{query ? `ผลการค้นหา “${debouncedQuery}”` : source || 'หนังทั้งหมด'}</h2></div>
          <span className="result-range">{range}</span>
        </div>
        {error && <div className="error-banner" role="alert">{error}</div>}
        {loading ? (
          <div className="loading-grid" aria-label="กำลังโหลด">{Array.from({ length: 12 }, (_, index) => <div className="skeleton" key={index} />)}</div>
        ) : visibleItems.length ? (
          <div className="movie-grid">{visibleItems.map((movie) => <MovieCard key={movie.id} movie={movie} onPlay={playMovie} />)}</div>
        ) : (
          <div className="empty-state"><span>⌕</span><h3>ไม่พบหนังที่ค้นหา</h3><p>ลองใช้คำค้นสั้นลงหรือเลือกแหล่งข้อมูลอื่น</p></div>
        )}
        <div className="pagination" aria-label="เปลี่ยนหน้า">
          <button type="button" disabled={safePage <= 1} onClick={() => setPage((value) => value - 1)}>← ก่อนหน้า</button>
          <span>หน้า {safePage.toLocaleString('th-TH')} / {pageCount.toLocaleString('th-TH')}</span>
          <button type="button" disabled={safePage >= pageCount} onClick={() => setPage((value) => value + 1)}>ถัดไป →</button>
        </div>
      </main>
      <footer><span>Doowise Play</span><span>รายการอัปเดตอัตโนมัติทุก 15 นาที · เล่นผ่าน Cloudflare secure proxy</span></footer>
    </div>
  );
}
