import { useEffect, useMemo, useRef, useState } from 'react';

const PAGE_SIZE = 48;
const emptyMeta = { total: 0, sources: [], groups: [], sync: null };

function formatSyncTime(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('th-TH', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value));
}

function SyncStatus({ sync }) {
  if (!sync) return <span className="sync-pill"><span className="sync-dot" />กำลังเชื่อมต่อ</span>;
  if (sync.syncing) return <span className="sync-pill is-syncing"><span className="sync-dot" />กำลังซิงก์ 4 แหล่ง…</span>;
  if (sync.lastError) return <span className="sync-pill has-error" title={sync.lastError}><span className="sync-dot" />ซิงก์มีข้อผิดพลาด</span>;
  const checked = formatSyncTime(sync.lastCheckedAt);
  return (
    <span className="sync-pill" title={checked ? `ตรวจล่าสุด ${checked}` : 'รอตรวจสอบครั้งแรก'}>
      <span className="sync-dot" />อัปเดตอัตโนมัติทุก {sync.intervalMinutes} นาที
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
    const failed = () => setStatus('เบราว์เซอร์นี้ไม่รองรับรูปแบบวิดีโอ ลองเปิดไฟล์ M3U ใน VLC');

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
        <div>
          <span className="eyebrow">กำลังรับชม</span>
          <h2>{movie.title}</h2>
        </div>
        <button className="icon-button" type="button" onClick={onClose} aria-label="ปิดเครื่องเล่น">×</button>
      </div>
      <div className="video-frame">
        <video ref={videoRef} controls playsInline poster={movie.logo || undefined} />
      </div>
      <div className="player-meta">
        <span className="status-dot" />
        <span>{status}</span>
        <span className="meta-separator">•</span>
        <span>{movie.source}</span>
        {movie.requiresReferer && <span className="badge">ผ่าน secure proxy</span>}
      </div>
      <details>
        <summary>รายละเอียดลิงก์</summary>
        <p className="direct-url">{movie.directUrl}</p>
      </details>
    </section>
  );
}

function MovieCard({ movie, onPlay }) {
  return (
    <article className="movie-card">
      <button className="poster-button" type="button" onClick={() => onPlay(movie.id)} aria-label={`เล่น ${movie.title}`}>
        {movie.logo ? (
          <img src={movie.logo} alt="" loading="lazy" referrerPolicy="no-referrer" />
        ) : (
          <div className="poster-fallback"><span>▶</span></div>
        )}
        <span className="play-chip">▶ เล่น</span>
      </button>
      <div className="card-body">
        <h3 title={movie.title}>{movie.title}</h3>
        <div className="card-meta">
          <span>{movie.streamType}</span>
          <span>{movie.source.replace('.m3u', '')}</span>
        </div>
      </div>
    </article>
  );
}

export default function App() {
  const [meta, setMeta] = useState(emptyMeta);
  const [query, setQuery] = useState('');
  const [source, setSource] = useState('');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState({ total: 0, items: [] });
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [catalogVersion, setCatalogVersion] = useState(0);
  const [syncNotice, setSyncNotice] = useState('');
  const debouncedQuery = useDebounced(query);

  useEffect(() => {
    fetch('/api/meta').then((response) => response.json()).then(setMeta).catch(() => setError('โหลดข้อมูลภาพรวมไม่สำเร็จ'));
  }, []);

  useEffect(() => {
    const updates = new EventSource('/api/updates');
    let noticeTimer;
    updates.onmessage = (event) => {
      try {
        const update = JSON.parse(event.data);
        setMeta((current) => ({
          ...current,
          total: update.total ?? current.total,
          sources: update.sources ?? current.sources,
          groups: update.groups ?? current.groups,
          sync: update.sync ?? current.sync,
        }));
        if (update.kind === 'catalog-updated') {
          setCatalogVersion((version) => version + 1);
          const added = update.sync?.lastAdded || 0;
          const changed = update.sync?.changedSources?.length || 0;
          setSyncNotice(`อัปเดตคลังแล้ว: เพิ่ม ${added.toLocaleString('th-TH')} เรื่อง จาก ${changed} แหล่ง`);
          window.clearTimeout(noticeTimer);
          noticeTimer = window.setTimeout(() => setSyncNotice(''), 8000);
        }
      } catch {
        // EventSource reconnects automatically; keep the current catalog visible.
      }
    };
    return () => {
      window.clearTimeout(noticeTimer);
      updates.close();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (debouncedQuery) params.set('q', debouncedQuery);
    if (source) params.set('source', source);
    setLoading(true);
    setError('');
    fetch(`/api/movies?${params}`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error('request failed');
        return response.json();
      })
      .then(setResult)
      .catch((requestError) => {
        if (requestError.name !== 'AbortError') setError('โหลดรายการหนังไม่สำเร็จ');
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [debouncedQuery, source, page, catalogVersion]);

  useEffect(() => setPage(1), [debouncedQuery, source]);

  async function playMovie(id) {
    setError('');
    try {
      const response = await fetch(`/api/movies/${id}`);
      if (!response.ok) throw new Error('request failed');
      setSelected(await response.json());
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch {
      setError('เปิดรายการนี้ไม่สำเร็จ');
    }
  }

  const pageCount = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
  const range = useMemo(() => {
    if (!result.total) return '0 รายการ';
    const start = (page - 1) * PAGE_SIZE + 1;
    const end = Math.min(page * PAGE_SIZE, result.total);
    return `${start.toLocaleString('th-TH')}–${end.toLocaleString('th-TH')} จาก ${result.total.toLocaleString('th-TH')}`;
  }, [page, result.total]);

  return (
    <div className="app-shell">
      <header className="hero">
        <nav>
          <div className="brand"><span className="brand-mark">D</span><span>Doowise Play</span></div>
          <div className="nav-status">
            <SyncStatus sync={meta.sync} />
            <span className="library-count">คลัง {meta.total.toLocaleString('th-TH')} เรื่อง</span>
          </div>
        </nav>
        <div className="hero-copy">
          <span className="eyebrow">PRIVATE MOVIE LIBRARY</span>
          <h1>คืนนี้ดูเรื่องอะไรดี?</h1>
          <p>ค้นหาและเปิดลิงก์จากคลัง M3U/CSV ของคุณในหน้าจอเดียว</p>
        </div>
        <div className="search-panel">
          <label className="search-box">
            <span aria-hidden="true">⌕</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="ค้นหาชื่อหนัง…" />
            {query && <button type="button" onClick={() => setQuery('')} aria-label="ล้างการค้นหา">×</button>}
          </label>
          <label className="select-box">
            <span>แหล่งข้อมูล</span>
            <select value={source} onChange={(event) => setSource(event.target.value)}>
              <option value="">ทุกแหล่ง</option>
              {meta.sources.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>
        </div>
      </header>

      <main>
        {syncNotice && <div className="sync-notice" role="status">✓ {syncNotice}</div>}
        {selected && <Player movie={selected} onClose={() => setSelected(null)} />}

        <div className="section-heading">
          <div>
            <span className="eyebrow">รายการหนัง</span>
            <h2>{query ? `ผลการค้นหา “${debouncedQuery}”` : source || 'หนังทั้งหมด'}</h2>
          </div>
          <span className="result-range">{range}</span>
        </div>

        {error && <div className="error-banner" role="alert">{error}</div>}
        {loading ? (
          <div className="loading-grid" aria-label="กำลังโหลด">
            {Array.from({ length: 12 }, (_, index) => <div className="skeleton" key={index} />)}
          </div>
        ) : result.items.length ? (
          <div className="movie-grid">
            {result.items.map((movie) => <MovieCard key={movie.id} movie={movie} onPlay={playMovie} />)}
          </div>
        ) : (
          <div className="empty-state"><span>⌕</span><h3>ไม่พบหนังที่ค้นหา</h3><p>ลองใช้คำค้นสั้นลงหรือเลือกแหล่งข้อมูลอื่น</p></div>
        )}

        <div className="pagination" aria-label="เปลี่ยนหน้า">
          <button type="button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>← ก่อนหน้า</button>
          <span>หน้า {page.toLocaleString('th-TH')} / {pageCount.toLocaleString('th-TH')}</span>
          <button type="button" disabled={page >= pageCount} onClick={() => setPage((value) => value + 1)}>ถัดไป →</button>
        </div>
      </main>

      <footer>
        <span>Doowise Play</span>
        <span>เล่นสตรีมผ่าน local proxy เพื่อคงค่า Referer จากไฟล์ M3U</span>
      </footer>
    </div>
  );
}
