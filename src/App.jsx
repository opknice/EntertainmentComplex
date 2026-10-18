import { useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useOttCatalog } from './useOttCatalog';
import StreamPlayer from './StreamPlayer';
import { isVideoFullscreen, leaveVideoFullscreen, startVideoPresentation } from './player-presentation';
import { isRelevantSport, sportTimestamp } from '../lib/sports-catalog';

const PAGE_SIZE = 30;
const POLL_INTERVAL_MS = 15 * 60 * 1000;
const emptyCatalog = {
  version: '', generatedAt: '', total: 0, liveTotal: 0, sportsTotal: 0, ottTotal: 0,
  sportsHealth: { degraded: false, failedSources: [], fallbackCount: 0 },
  sources: [], groups: [], recent: [], items: [], live: [], sports: [], ott: [],
};

const sections = {
  movies: { label: 'หนัง', eyebrow: 'MOVIES', collection: 'items', filterLabel: 'แหล่งข้อมูล' },
  live: { label: 'ทีวีสด', eyebrow: 'LIVE TV', collection: 'live', filterLabel: 'หมวดช่อง' },
  sports: { label: 'กีฬาสด', eyebrow: 'LIVE SPORTS', collection: 'sports', filterLabel: 'ชนิดกีฬา' },
  ott: { label: 'OTT', eyebrow: 'OTT PLAYLIST', collection: 'ott', filterLabel: 'หมวดต้นทาง' },
};

function formatSyncTime(value) {
  if (!value) return 'ยังไม่มีข้อมูลเวลา';
  return new Intl.DateTimeFormat('th-TH', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value));
}

function formatEventTime(value) {
  if (!value) return 'รอประกาศเวลาแข่งขัน';
  const date = new Date(sportTimestamp(value));
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('th-TH', {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

function displayTitle(item) {
  const current = String(item?.title || '').trim();
  if (current.length > 1 && current !== '[' && current !== '(ไม่มีชื่อ)') return current;
  try {
    const pathname = new URL(item?.directUrl || '', window.location.origin).pathname;
    const filename = decodeURIComponent(pathname.split('/').filter(Boolean).pop() || 'รายการไม่มีชื่อ');
    return filename.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
  } catch {
    return 'รายการไม่มีชื่อ';
  }
}

function allCatalogItems(catalog) {
  return [...catalog.items, ...catalog.live, ...catalog.sports, ...(catalog.ott || [])];
}

function getSectionItems(catalog, section) {
  return catalog[sections[section]?.collection] || [];
}

function getItemSection(catalog, id) {
  if (id.startsWith('ott-')) return 'ott';
  if (catalog.items.some((item) => item.id === id)) return 'movies';
  if (catalog.live.some((item) => item.id === id)) return 'live';
  if (catalog.sports.some((item) => item.id === id)) return 'sports';
  return 'movies';
}

function recentMovies(catalog, limit = 24) {
  const byId = new Map(catalog.items.map((item) => [item.id, item]));
  const pinned = (catalog.recent || []).map((id) => byId.get(id)).filter(Boolean);
  const dated = catalog.items
    .filter((item) => item.discoveredAt)
    .sort((a, b) => String(b.discoveredAt).localeCompare(String(a.discoveredAt)));
  const fallback = catalog.items.filter((item) => displayTitle(item) !== 'รายการไม่มีชื่อ');
  return [...new Map([...pinned, ...dated, ...fallback].map((item) => [item.id, item])).values()].slice(0, limit);
}

function routeFromLocation() {
  const parts = window.location.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (!parts.length) return { name: 'home' };
  if (parts[0] === 'category' && sections[parts[1]]) return { name: 'category', section: parts[1], search: window.location.search };
  if (parts[0] === 'details' && sections[parts[1]] && parts[2]) return { name: 'details', section: parts[1], id: parts[2] };
  if (parts[0] === 'watch' && sections[parts[1]] && parts[2]) return { name: 'watch', section: parts[1], id: parts[2] };
  return { name: 'not-found' };
}

function useRoute() {
  const [route, setRoute] = useState(routeFromLocation);
  useEffect(() => {
    const onPopState = () => setRoute(routeFromLocation());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);
  return route;
}

function navigate(path, { replace = false } = {}) {
  window.history[replace ? 'replaceState' : 'pushState']({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function Link({ to, className = '', children, onClick, ...props }) {
  return (
    <a
      href={to}
      className={className}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        navigate(to);
      }}
      {...props}
    >
      {children}
    </a>
  );
}

async function fetchJson(pathname) {
  const separator = pathname.includes('?') ? '&' : '?';
  const response = await fetch(`${pathname}${separator}t=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function useCatalog() {
  const [catalog, setCatalog] = useState(emptyCatalog);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [syncNotice, setSyncNotice] = useState('');
  const [manualState, setManualState] = useState('idle');
  const versionRef = useRef('');
  const liveSportsRef = useRef(null);

  const applyCatalog = (data) => {
    const next = { ...emptyCatalog, ...data, live: data.live || [], sports: data.sports || [], recent: data.recent || [] };
    const liveSports = liveSportsRef.current;
    if (liveSports && Date.parse(liveSports.sportsHealth.checkedAt) > Date.parse(next.sportsHealth?.checkedAt || next.generatedAt || 0)) {
      Object.assign(next, liveSports);
    }
    versionRef.current = next.version;
    setCatalog(next);
    return next;
  };

  useEffect(() => {
    let cancelled = false;
    fetchJson('/data/catalog.json')
      .then((data) => { if (!cancelled) applyCatalog(data); })
      .catch(() => { if (!cancelled) setError('โหลดคลังรายการไม่สำเร็จ'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // Fetch the live fixture snapshot independently of GitHub's delayed scheduler
  // and the static-site build. One shared CDN snapshot is cached for 60 seconds.
  useEffect(() => {
    if (loading) return undefined;
    let cancelled = false, running = false;
    const controller = new AbortController();
    const refreshSports = async () => {
      if (running || document.hidden) return;
      running = true;
      try {
        const response = await fetch('/api/sports-catalog', { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const result = await response.json();
        if (!Array.isArray(result.sports) || !result.sportsHealth?.checkedAt) throw new Error('invalid sports snapshot');
        if (!cancelled) setCatalog(current => {
          const failed = new Set(result.sportsHealth.failedSources || []);
          const fallback = current.sports.filter(item => failed.has(item.sport) && isRelevantSport(item));
          const sports = [...result.sports, ...fallback].sort((a, b) => (sportTimestamp(a.time) || 0) - (sportTimestamp(b.time) || 0));
          const update = { sports, sportsTotal: sports.length, sportsHealth: { ...result.sportsHealth, fallbackCount: fallback.length } };
          liveSportsRef.current = update;
          return { ...current, ...update };
        });
      } catch {
        if (!cancelled) setCatalog(current => ({ ...current, sportsHealth: { ...current.sportsHealth, degraded: true } }));
      } finally { running = false; }
    };
    refreshSports();
    const timer = window.setInterval(refreshSports, 60000);
    window.addEventListener('online', refreshSports);
    document.addEventListener('visibilitychange', refreshSports);
    return () => { cancelled = true; controller.abort(); window.clearInterval(timer); window.removeEventListener('online', refreshSports); document.removeEventListener('visibilitychange', refreshSports); };
  }, [loading]);

  useEffect(() => {
    let cancelled = false;
    let noticeTimer;
    async function checkForUpdates() {
      setChecking(true);
      try {
        const version = await fetchJson('/data/version.json');
        if (!cancelled && version.version && versionRef.current && version.version !== versionRef.current) {
          const next = applyCatalog(await fetchJson('/data/catalog.json'));
          setSyncNotice(`อัปเดตคลังแล้ว · หนัง ${next.total.toLocaleString('th-TH')} · ทีวี ${next.liveTotal.toLocaleString('th-TH')} · กีฬา ${next.sportsTotal.toLocaleString('th-TH')} · OTT ${next.ottTotal.toLocaleString('th-TH')}`);
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

  async function manualUpdate() {
    setManualState('requesting');
    setError('');
    try {
      const response = await fetch('/api/update-catalog', { method: 'POST', headers: { Accept: 'application/json' } });
      const body = await response.json();
      if (response.status === 429) {
        setManualState('cooldown');
        setSyncNotice('มีการอัปเดตอยู่แล้ว หรือเพิ่งอัปเดตภายใน 5 นาที');
        window.setTimeout(() => setManualState('idle'), Math.min((body.retryAfter || 60) * 1000, 5 * 60 * 1000));
        return;
      }
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      setManualState('queued');
      setSyncNotice('รับคำขอแล้ว กำลังดึงรายการใหม่จากต้นทาง');
      const requestedAt = new Date(body.requestedAt).getTime();
      for (let attempt = 0; attempt < 60; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 5000));
        const status = await fetchJson('/api/update-catalog');
        const createdAt = status.run?.createdAt ? new Date(status.run.createdAt).getTime() : 0;
        if (createdAt + 2000 < requestedAt || status.run?.status !== 'completed') continue;
        if (status.run.conclusion !== 'success') throw new Error(`workflow ${status.run.conclusion || 'failed'}`);
        const published = await fetchJson('/data/catalog.json');
        // A successful Actions run can precede the Vercel deployment.
        if (Date.parse(published.sportsHealth?.checkedAt || published.generatedAt) + 2000 < requestedAt) continue;
        const next = applyCatalog(published);
        setManualState('cooldown');
        setSyncNotice(`อัปเดตแล้ว · หนัง ${next.total.toLocaleString('th-TH')} · ทีวี ${next.liveTotal.toLocaleString('th-TH')} · กีฬา ${next.sportsTotal.toLocaleString('th-TH')} · OTT ${next.ottTotal.toLocaleString('th-TH')}`);
        window.setTimeout(() => setManualState('idle'), 5 * 60 * 1000);
        return;
      }
      throw new Error('update timeout');
    } catch (updateError) {
      console.error('manual catalog update failed', updateError);
      setManualState('error');
      setError('สั่งอัปเดตข้อมูลไม่สำเร็จ กรุณาลองใหม่อีกครั้ง');
      window.setTimeout(() => setManualState('idle'), 8000);
    }
  }

  return { catalog, loading, checking, error, syncNotice, manualState, manualUpdate };
}

function SyncButton({ catalog, checking, manualState, onManualUpdate }) {
  const labels = {
    requesting: 'กำลังส่งคำขอ…', queued: 'กำลังอัปเดต…', cooldown: 'อัปเดตล่าสุดแล้ว', error: 'ลองอัปเดตอีกครั้ง',
  };
  const busy = checking || ['requesting', 'queued'].includes(manualState);
  return (
    <button className={`sync-button${busy ? ' is-busy' : ''}${manualState === 'error' ? ' has-error' : ''}`} type="button" onClick={onManualUpdate} disabled={busy || manualState === 'cooldown'} title={`ข้อมูลล่าสุด ${formatSyncTime(catalog.generatedAt)}`}>
      <span className="sync-dot" />{labels[manualState] || (checking ? 'กำลังตรวจข้อมูล…' : 'อัปเดตคลัง')}
    </button>
  );
}

function Header({ catalog, route, checking, manualState, onManualUpdate, onPlay }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef(null);
  const searchToggleRef = useRef(null);
  const [query, setQuery] = useState('');
  const activeSection = route.section || 'movies';
  const suggestions = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('th');
    if (normalized.length < 2) return [];
    return allCatalogItems(catalog).filter((item) => displayTitle(item).toLocaleLowerCase('th').includes(normalized)).slice(0, 5);
  }, [catalog, query]);

  const submitSearch = (event) => {
    event.preventDefault();
    const value = query.trim();
    if (!value) { searchInputRef.current?.focus(); return; }
    setMenuOpen(false);
    setSearchOpen(false);
    event.currentTarget.querySelector(':focus')?.blur();
    navigate(`/category/${activeSection}?q=${encodeURIComponent(value)}`);
  };

  const toggleSearch = () => {
    if (searchOpen) { setSearchOpen(false); return; }
    // Reveal before focusing within the tap handler so mobile keyboards can open.
    flushSync(() => { setSearchOpen(true); setMenuOpen(false); });
    searchInputRef.current?.focus();
  };

  return (
    <>
      <header className={`site-header${menuOpen ? ' menu-is-open' : ''}`}>
        <div className="header-inner">
          <Link className="brand" to="/" aria-label="Entertainment Complex หน้าแรก">
            <img className="brand-mark" src="/assets/entertainment-complex-logo.png" alt="" />
            <span className="brand-copy"><strong>entertainment</strong><small>complex</small></span>
          </Link>
          <nav id="primary-navigation" className={`primary-nav${menuOpen ? ' is-open' : ''}`} aria-label="เมนูหลัก">
            <div className="mobile-nav-head"><span>ENTERTAINMENT COMPLEX</span><button type="button" onClick={() => setMenuOpen(false)} aria-label="ปิดเมนู">×</button></div>
            <Link to="/" className={route.name === 'home' ? 'active' : ''} onClick={() => setMenuOpen(false)}>หน้าแรก</Link>
            {Object.entries(sections).map(([id, meta]) => (
              <Link key={id} to={`/category/${id}`} className={route.section === id ? 'active' : ''} onClick={() => setMenuOpen(false)}>{meta.label}</Link>
            ))}
            <div className="mobile-sync"><SyncButton catalog={catalog} checking={checking} manualState={manualState} onManualUpdate={onManualUpdate} /></div>
          </nav>
          <button ref={searchToggleRef} className="search-toggle" type="button" aria-label={searchOpen ? 'ปิดช่องค้นหา' : 'เปิดช่องค้นหา'} aria-controls="header-search" aria-expanded={searchOpen} onClick={toggleSearch}>{searchOpen ? '×' : '⌕'}</button>
          <form id="header-search" className={`header-search${searchOpen ? ' is-open' : ''}`} role="search" onSubmit={submitSearch} onKeyDown={(event) => {
            if (event.key === 'Escape' && searchOpen) { event.preventDefault(); setSearchOpen(false); searchToggleRef.current?.focus(); }
          }}>
            <input ref={searchInputRef} type="search" enterKeyHint="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="ค้นหาหนัง ช่อง หรือกีฬา…" aria-label="ค้นหา" />
            {query && <button className="search-clear" type="button" onClick={() => { setQuery(''); searchInputRef.current?.focus(); }} aria-label="ล้างการค้นหา">×</button>}
            <button className="search-submit" type="submit" aria-label="ค้นหา">⌕</button>
            {suggestions.length > 0 && (
              <div className="search-results" role="listbox" aria-label="ผลการค้นหา">
                {suggestions.map((item) => {
                  const section = getItemSection(catalog, item.id);
                  return <button key={item.id} type="button" onClick={() => { setQuery(''); setSearchOpen(false); onPlay(item, section); }}><Poster item={item} /><span><strong>{displayTitle(item)}</strong><small>{sections[section].label} · {item.streamType || item.league || item.group}</small></span></button>;
                })}
              </div>
            )}
          </form>
          <div className="desktop-sync"><SyncButton catalog={catalog} checking={checking} manualState={manualState} onManualUpdate={onManualUpdate} /></div>
          <button className="menu-toggle" type="button" aria-controls="primary-navigation" aria-expanded={menuOpen} onClick={() => { setSearchOpen(false); setMenuOpen((value) => !value); }} aria-label="เปิดเมนู"><span /><span /><span /></button>
        </div>
      </header>
      {menuOpen && <button className="menu-backdrop" type="button" aria-label="ปิดเมนู" onClick={() => setMenuOpen(false)} />}
    </>
  );
}

function Poster({ item, className = '' }) {
  const [failedLogo, setFailedLogo] = useState('');
  if (item.logo && !item.logo.includes('ui-avatars.com') && failedLogo !== item.logo) return <img className={className} src={item.logo} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailedLogo(item.logo)} />;
  return <span className={`poster-fallback ${className}`} aria-hidden="true">{item.awayLogo ? 'VS' : 'EC'}</span>;
}

function MediaCard({ item, section, compact = false, onPlay }) {
  const title = displayTitle(item);
  const isChannel = section === 'live' || (section === 'ott' && item.kind === 'live');
  return (
    <article className={`media-card${compact ? ' is-compact' : ''}${section === 'sports' ? ' is-sport' : ''}${isChannel ? ' is-channel' : ''}`}>
      <button className="media-poster" type="button" onClick={() => onPlay(item, section)} aria-label={`เล่น ${title}`} title={title}>
        {section === 'sports' && item.awayLogo ? <span className="team-match"><Poster item={item} /><b>VS</b><Poster item={{ logo: item.awayLogo }} /></span> : <Poster item={item} />}
        <span className="poster-shade" />
        <span className="type-badge">{section === 'sports' ? (item.status || 'LIVE') : item.streamType || 'VIDEO'}</span>
        <span className="play-hover">▶ รับชม</span>
      </button>
      <div className="media-body">
        <h3><button type="button" onClick={() => onPlay(item, section)} title={title}>{title}</button></h3>
        {section === 'sports' && <p className="event-time">{formatEventTime(item.time)}</p>}
        <p>{section === 'movies' ? item.group || item.source : section !== 'sports' ? item.group : item.league || item.sport}</p>
      </div>
    </article>
  );
}

function Rail({ title, eyebrow, items, section, viewAll, onPlay }) {
  return (
    <section className="content-section">
      <div className="section-title"><div><span className="eyebrow">{eyebrow}</span><h2>{title}</h2></div>{viewAll && <Link className="text-link" to={viewAll}>ดูทั้งหมด <span>→</span></Link>}</div>
      <div className="media-rail">{items.map((item) => <MediaCard key={item.id} item={item} section={section} compact onPlay={onPlay} />)}</div>
    </section>
  );
}

function HomePage({ catalog, loading, onPlay }) {
  const newest = useMemo(() => recentMovies(catalog, 20), [catalog]);
  const liveItems = catalog.live.slice(0, 12);
  const sportItems = catalog.sports.filter((item) => !['FT', 'Finished'].includes(item.status)).slice(0, 10);
  if (loading) return <PageLoading />;
  return (
    <main className="site-main home-page">
      {newest.length ? <Rail eyebrow="JUST UPDATED" title="หนังอัปเดตล่าสุด" items={newest.slice(0, 12)} section="movies" viewAll="/category/movies" onPlay={onPlay} /> : <EmptyState title="ยังไม่มีรายการหนัง" />}
      <Rail eyebrow="LIVE NOW" title="ช่องทีวีสด" items={liveItems} section="live" viewAll="/category/live" onPlay={onPlay} />
      <Rail eyebrow="SPORTS" title="โปรแกรมกีฬาที่รับชมได้" items={sportItems} section="sports" viewAll="/category/sports" onPlay={onPlay} />
    </main>
  );
}

function CategoryPage({ catalog, section, initialSearch, loading, onPlay, onVisibleItems }) {
  const params = useMemo(() => new URLSearchParams(initialSearch), [initialSearch]);
  const [query, setQuery] = useState(params.get('q') || '');
  const [filter, setFilter] = useState(params.get('filter') || '');
  const [page, setPage] = useState(Math.max(1, Number(params.get('page')) || 1));
  const meta = sections[section];
  const items = getSectionItems(catalog, section);
  const filterOptions = useMemo(() => [...new Set(items.map((item) => section === 'movies' ? item.source : section !== 'sports' ? item.group : item.sport).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'th')), [items, section]);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('th');
    return items.filter((item) => {
      const itemFilter = section === 'movies' ? item.source : section !== 'sports' ? item.group : item.sport;
      return (!filter || itemFilter === filter) && (!normalized || `${displayTitle(item)} ${item.source || ''} ${item.group || ''} ${item.league || ''}`.toLocaleLowerCase('th').includes(normalized));
    });
  }, [items, query, filter, section]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const visible = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const visibleIds = visible.map((item) => item.id).join(',');
  useEffect(() => { if (onVisibleItems && visible.length) onVisibleItems(visible); }, [visibleIds, onVisibleItems]);

  useEffect(() => {
    if (loading) return;
    const next = new URLSearchParams();
    if (query) next.set('q', query);
    if (filter) next.set('filter', filter);
    if (safePage > 1) next.set('page', String(safePage));
    const suffix = next.toString() ? `?${next}` : '';
    window.history.replaceState({}, '', `/category/${section}${suffix}`);
  }, [query, filter, safePage, section, loading]);

  if (loading) return <PageLoading />;
  return (
    <main className="site-main inner-page">
      <div className="catalog-layout">
        <section className="filter-panel" aria-label="ค้นหาและกรอง">
          <label><span>ค้นหา</span><input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder={`ค้นหา${meta.label}…`} /></label>
          <label><span>{meta.filterLabel}</span><select value={filter} onChange={(event) => { setFilter(event.target.value); setPage(1); }}><option value="">ทั้งหมด</option>{filterOptions.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>
          {(query || filter) && <button className="clear-filters" type="button" onClick={() => { setQuery(''); setFilter(''); setPage(1); }}>ล้างตัวกรอง</button>}
        </section>
        <section className="catalog-content" aria-live="polite">
          <div className="catalog-heading"><h1>{query ? `ผลการค้นหา “${query}”` : filter || `${meta.label}ทั้งหมด`}</h1><div className="catalog-meta"><span>แสดง {visible.length.toLocaleString('th-TH')} จาก {filtered.length.toLocaleString('th-TH')} รายการ</span><span>หน้า {safePage.toLocaleString('th-TH')} / {pageCount.toLocaleString('th-TH')}</span></div></div>
          {visible.length ? <div className="catalog-grid">{visible.map((item) => <MediaCard key={item.id} item={item} section={section} onPlay={onPlay} />)}</div> : <EmptyState title="ไม่พบรายการที่ค้นหา" description="ลองใช้คำค้นที่สั้นลงหรือเปลี่ยนตัวกรอง" />}
          <Pagination page={safePage} count={pageCount} onChange={setPage} />
        </section>
      </div>
    </main>
  );
}

function Breadcrumbs({ items }) {
  return <nav className="breadcrumbs" aria-label="เส้นทางหน้าเว็บ">{items.map(([label, href], index) => <span key={`${label}-${index}`}>{index > 0 && <b>›</b>}{href ? <Link to={href}>{label}</Link> : label}</span>)}</nav>;
}

function DetailPage({ catalog, section, id, loading, onPlay }) {
  const items = getSectionItems(catalog, section);
  const item = items.find((entry) => entry.id === id);
  if (loading) return <PageLoading />;
  if (!item) return <NotFound />;
  const title = displayTitle(item);
  const similarKey = section === 'movies' ? item.source : section !== 'sports' ? item.group : item.sport;
  const related = items.filter((entry) => entry.id !== id && (section === 'movies' ? entry.source : section !== 'sports' ? entry.group : entry.sport) === similarKey).slice(0, 10);
  return (
    <main className="site-main inner-page">
      <Breadcrumbs items={[['หน้าแรก', '/'], [sections[section].label, `/category/${section}`], [title]]} />
      <div className="detail-layout">
        <article className="detail-card">
          <div className="detail-poster"><Poster item={item} /><span>{item.streamType || 'LIVE'}</span></div>
          <div className="detail-copy"><span className="eyebrow">{sections[section].eyebrow}</span><h1>{title}</h1><p className="detail-lead">พร้อมรับชมจากคลัง entertainment-complex ผ่านระบบสตรีมที่เชื่อมต่อกับต้นทางโดยตรง</p><dl><MetaRow label="ประเภท" value={sections[section].label} /><MetaRow label={sections[section].filterLabel} value={section === 'sports' ? item.sport : section === 'live' ? item.group : item.source} /><MetaRow label="กลุ่ม" value={section === 'sports' ? item.league : item.group} /><MetaRow label="รูปแบบสตรีม" value={item.streamType} />{section === 'sports' && <MetaRow label="เวลาแข่งขัน" value={formatEventTime(item.time)} />}</dl><div className="detail-actions"><button className="primary-button large" type="button" onClick={() => onPlay(item, section)}>▶ เริ่มรับชม</button><Link className="secondary-button" to={`/category/${section}`}>กลับไปเลือกเรื่องอื่น</Link></div></div>
        </article>
        <aside className="detail-aside"><span className="no-ad-mark">NO ADS</span><h2>พื้นที่รับชมที่ไม่รบกวนคุณ</h2><p>ไม่มี banner, popup, redirect หรือโฆษณาคั่นก่อนเล่น</p><ul><li>สตรีมผ่าน secure proxy</li><li>รองรับ HLS และ DASH</li><li>ใช้งานได้ทั้งมือถือและคอมพิวเตอร์</li></ul></aside>
      </div>
      {related.length > 0 && <Rail eyebrow="YOU MAY ALSO LIKE" title="รายการที่เกี่ยวข้อง" items={related} section={section} viewAll={`/category/${section}`} onPlay={onPlay} />}
    </main>
  );
}

function MetaRow({ label, value }) {
  if (!value) return null;
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}


function WatchPage({ catalog, section, id, loading }) {
  const item = getSectionItems(catalog, section).find((entry) => entry.id === id);
  if (loading) return <PageLoading />;
  if (!item) return <NotFound />;
  const title = displayTitle(item);
  return (
    <main className="site-main watch-page">
      <Breadcrumbs items={[['หน้าแรก', '/'], [sections[section].label, `/category/${section}`], [title, `/details/${section}/${encodeURIComponent(id)}`], ['เครื่องเล่น']]} />
      <section className="watch-shell"><div className="watch-heading"><div><span className="eyebrow">NOW PLAYING</span><h1>{title}</h1></div><Link className="secondary-button" to={`/details/${section}/${encodeURIComponent(id)}`}>← รายละเอียด</Link></div><StreamPlayer key={item.id} item={item} resumeId={section === 'movies' || section === 'ott' ? `${section}:${item.id}` : undefined} live={section === 'live' || section === 'sports' || item.kind === 'live'} /></section>
      <div className="watch-help"><span>ไม่มีโฆษณา</span><p>หากวิดีโอไม่เริ่มอัตโนมัติ ให้กดปุ่มเล่นหนึ่งครั้ง เนื่องจากนโยบาย autoplay ของเบราว์เซอร์</p></div>
    </main>
  );
}

function PlayerOverlay({ selection, onClose, mediaRef }) {
  const { item, section } = selection;
  const title = displayTitle(item);
  return (
    <section className="fullscreen-player" role="dialog" aria-modal="true" aria-label={`กำลังรับชม ${title}`} onKeyDown={event => {
      if (event.key !== 'Tab') return;
      const focusable = [...event.currentTarget.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]')].filter(element => element.getClientRects().length > 0);
      const first = focusable[0], last = focusable.at(-1);
      if (!first) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }}>
      <div className="fullscreen-player-stage"><StreamPlayer key={item.id} item={item.playUrl ? item : null} mediaRef={mediaRef} autoFullscreen resumeId={section === 'movies' || section === 'ott' ? `${section}:${item.id}` : undefined} live={section === 'live' || section === 'sports' || item.kind === 'live'} onClose={onClose} /></div>
    </section>
  );
}

function Pagination({ page, count, onChange }) {
  if (count <= 1) return null;
  const pages = [...new Set([1, page - 1, page, page + 1, count].filter((value) => value >= 1 && value <= count))];
  return <nav className="pagination" aria-label="เปลี่ยนหน้า"><button type="button" disabled={page <= 1} onClick={() => onChange(page - 1)}>←</button>{pages.map((value, index) => <span key={value}>{index > 0 && value - pages[index - 1] > 1 && <i>…</i>}<button className={value === page ? 'active' : ''} type="button" onClick={() => onChange(value)}>{value.toLocaleString('th-TH')}</button></span>)}<button type="button" disabled={page >= count} onClick={() => onChange(page + 1)}>→</button></nav>;
}

function PageLoading() {
  return <main className="site-main loading-page"><div className="loading-hero" /><div className="loading-grid">{Array.from({ length: 12 }, (_, index) => <div key={index} />)}</div></main>;
}

function EmptyState({ title, description = 'รายการจะปรากฏเมื่อมีข้อมูลจากต้นทาง' }) {
  return <div className="empty-state"><span>⌕</span><h2>{title}</h2><p>{description}</p></div>;
}

function NotFound() {
  return <main className="site-main not-found"><span>404</span><h1>ไม่พบหน้าหรือรายการนี้</h1><p>รายการอาจถูกย้ายหรือยังไม่ได้รับข้อมูลจากต้นทาง</p><Link className="primary-button" to="/">กลับหน้าแรก</Link></main>;
}

function Footer({ catalog }) {
  const degraded = catalog.sportsHealth?.degraded;
  return <footer className="site-footer"><div><Link className="brand footer-brand" to="/"><img className="brand-mark" src="/assets/entertainment-complex-logo.png" alt="" /><span className="brand-copy"><strong>entertainment</strong><small>complex</small></span></Link><p>พื้นที่รวมหนัง ทีวีสด และกีฬา ที่ออกแบบให้รับชมได้อย่างตรงไปตรงมาโดยไม่มีโฆษณารบกวน</p></div><div className="footer-links">{Object.entries(sections).map(([id, meta]) => <Link key={id} to={`/category/${id}`}>{meta.label}</Link>)}</div><div className={`footer-status${degraded ? ' is-degraded' : ''}`}><span className="status-dot" />{degraded ? 'ข้อมูลกีฬาบางส่วนล่าช้า' : 'คลังทำงานปกติ'}<small>{formatSyncTime(catalog.generatedAt)}</small></div></footer>;
}

export default function App() {
  const route = useRoute();
  const { catalog: baseCatalog, loading, checking, error, syncNotice, manualState, manualUpdate } = useCatalog();
  const ott = useOttCatalog(route.section === 'ott', baseCatalog.ottSummary);
  const catalog = useMemo(() => ({ ...baseCatalog, ott: ott.items }), [baseCatalog, ott.items]);
  const [playError, setPlayError] = useState('');
  const [activePlayer, setActivePlayer] = useState(null);
  const overlayVideoRef = useRef(null);
  const playRequestRef = useRef(0);
  const previousFocusRef = useRef(null);
  const openPlayer = async (item, section) => {
    const requestId = ++playRequestRef.current;
    previousFocusRef.current = document.activeElement;
    setPlayError('');
    // Mount the video during the user's tap, including while OTT details load.
    flushSync(() => setActivePlayer({ item, section }));
    const video = overlayVideoRef.current;
    startVideoPresentation(video).then(() => { if (overlayVideoRef.current !== video) leaveVideoFullscreen(video); });
    try {
      const playable = section === 'ott' ? (await ott.loadItems([item]))[0] : item;
      if (requestId !== playRequestRef.current) return;
      if (!playable?.playUrl) throw new Error('ยังโหลดข้อมูลรายการไม่ครบ กรุณาลองอีกครั้ง');
      setActivePlayer({ item: playable, section });
    } catch (reason) {
      if (requestId !== playRequestRef.current) return;
      setPlayError(`เปิดรายการไม่สำเร็จ (${reason.message})`);
      leaveVideoFullscreen(video);
      setActivePlayer(null);
    }
  };
  const ottRouteItem = route.section === 'ott' && route.id ? ott.items.find((item) => item.id === route.id) : null;
  useEffect(() => {
    if (ottRouteItem && !ottRouteItem.playUrl) ott.loadVisible([ottRouteItem]);
  }, [ottRouteItem?.id, ottRouteItem?.playUrl, ott.loadVisible]);
  const pageLoading = loading || (route.section === 'ott' && (ott.loading || Boolean(ottRouteItem && !ottRouteItem.playUrl && !ott.error)));
  const closePlayer = () => {
    const requestId = ++playRequestRef.current;
    const previousFocus = previousFocusRef.current;
    leaveVideoFullscreen(overlayVideoRef.current).then(() => {
      if (playRequestRef.current === requestId && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    });
    setActivePlayer(null);
  };

  useEffect(() => {
    if (!activePlayer) return undefined;
    document.body.classList.add('player-open');
    const video = overlayVideoRef.current;
    let enteredFullscreen = isVideoFullscreen(video);
    const handleKeyDown = (event) => { if (event.key === 'Escape') closePlayer(); };
    const handleFullscreenChange = () => {
      if (isVideoFullscreen(video)) enteredFullscreen = true;
      else if (enteredFullscreen) closePlayer();
    };
    video?.addEventListener('webkitbeginfullscreen', handleFullscreenChange);
    video?.addEventListener('webkitendfullscreen', closePlayer);
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    return () => {
      document.body.classList.remove('player-open');
      video?.removeEventListener('webkitbeginfullscreen', handleFullscreenChange);
      video?.removeEventListener('webkitendfullscreen', closePlayer);
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
    };
  }, [activePlayer?.item.id]);

  let page;
  if (route.name === 'home') page = <HomePage catalog={catalog} loading={loading} onPlay={openPlayer} />;
  else if (route.name === 'category') page = <CategoryPage key={`${route.section}:${route.search}`} catalog={catalog} section={route.section} initialSearch={route.search} loading={pageLoading} onPlay={openPlayer} onVisibleItems={route.section === 'ott' ? ott.loadVisible : undefined} />;
  else if (route.name === 'details') page = <DetailPage catalog={catalog} section={route.section} id={route.id} loading={pageLoading} onPlay={openPlayer} />;
  else if (route.name === 'watch') page = <WatchPage catalog={catalog} section={route.section} id={route.id} loading={pageLoading} />;
  else page = <NotFound />;
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">ข้ามไปยังเนื้อหา</a>
      <Header catalog={catalog} route={route} checking={checking} manualState={manualState} onManualUpdate={manualUpdate} onPlay={openPlayer} />
      <div id="main-content">{syncNotice && <div className="global-notice" role="status">✓ {syncNotice}</div>}{(error || ott.error || playError) && <div className="global-error" role="alert">{error || ott.error || playError}</div>}{catalog.ottSummary?.degraded && route.section === 'ott' && <div className="global-notice" role="status">ต้นทาง OTT อัปเดตไม่สำเร็จ กำลังแสดงคลังล่าสุดที่บันทึกไว้</div>}{page}</div>
      <Footer catalog={catalog} />
      {activePlayer && <PlayerOverlay selection={activePlayer} onClose={closePlayer} mediaRef={overlayVideoRef} />}
    </div>
  );
}
