import { useEffect, useMemo, useRef, useState } from 'react';

const PAGE_SIZE = 30;
const POLL_INTERVAL_MS = 15 * 60 * 1000;
const emptyCatalog = {
  version: '', generatedAt: '', total: 0, liveTotal: 0, sportsTotal: 0,
  sportsHealth: { degraded: false, failedSources: [], fallbackCount: 0 },
  sources: [], groups: [], recent: [], items: [], live: [], sports: [],
};

const sections = {
  movies: { label: 'หนัง', eyebrow: 'MOVIES', collection: 'items', filterLabel: 'แหล่งข้อมูล' },
  live: { label: 'ทีวีสด', eyebrow: 'LIVE TV', collection: 'live', filterLabel: 'หมวดช่อง' },
  sports: { label: 'กีฬาสด', eyebrow: 'LIVE SPORTS', collection: 'sports', filterLabel: 'ชนิดกีฬา' },
};

function formatSyncTime(value) {
  if (!value) return 'ยังไม่มีข้อมูลเวลา';
  return new Intl.DateTimeFormat('th-TH', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value));
}

function formatEventTime(value) {
  if (!value) return 'รอประกาศเวลาแข่งขัน';
  const date = new Date(value.replace(' ', 'T'));
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
  return [...catalog.items, ...catalog.live, ...catalog.sports];
}

function getSectionItems(catalog, section) {
  return catalog[sections[section]?.collection] || [];
}

function getItemSection(catalog, id) {
  if (catalog.items.some((item) => item.id === id)) return 'movies';
  if (catalog.live.some((item) => item.id === id)) return 'live';
  if (catalog.sports.some((item) => item.id === id)) return 'sports';
  return 'movies';
}

function hasUsefulPoster(item) {
  return Boolean(item?.logo && /^https?:\/\//i.test(item.logo) && !item.logo.includes('ui-avatars.com'));
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
  if (parts[0] === 'category' && sections[parts[1]]) return { name: 'category', section: parts[1] };
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

  const applyCatalog = (data) => {
    const next = { ...emptyCatalog, ...data, live: data.live || [], sports: data.sports || [], recent: data.recent || [] };
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

  useEffect(() => {
    let cancelled = false;
    let noticeTimer;
    async function checkForUpdates() {
      setChecking(true);
      try {
        const version = await fetchJson('/data/version.json');
        if (!cancelled && version.version && versionRef.current && version.version !== versionRef.current) {
          const next = applyCatalog(await fetchJson('/data/catalog.json'));
          setSyncNotice(`อัปเดตคลังแล้ว · หนัง ${next.total.toLocaleString('th-TH')} · ทีวี ${next.liveTotal.toLocaleString('th-TH')} · กีฬา ${next.sportsTotal.toLocaleString('th-TH')}`);
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
        const next = applyCatalog(await fetchJson('/data/catalog.json'));
        setManualState('cooldown');
        setSyncNotice(`อัปเดตแล้ว พบหนัง ${next.total.toLocaleString('th-TH')} เรื่อง`);
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
    if (!value) return;
    setMenuOpen(false);
    navigate(`/category/${activeSection}?q=${encodeURIComponent(value)}`);
  };

  return (
    <>
      <header className="site-header">
        <div className="header-inner">
          <Link className="brand" to="/" aria-label="Entertainment Complex หน้าแรก">
            <img className="brand-mark" src="/assets/entertainment-complex-logo.png" alt="" />
            <span className="brand-copy"><strong>entertainment</strong><small>complex</small></span>
          </Link>
          <nav className={`primary-nav${menuOpen ? ' is-open' : ''}`} aria-label="เมนูหลัก">
            <div className="mobile-nav-head"><span>ENTERTAINMENT COMPLEX</span><button type="button" onClick={() => setMenuOpen(false)} aria-label="ปิดเมนู">×</button></div>
            <Link to="/" className={route.name === 'home' ? 'active' : ''} onClick={() => setMenuOpen(false)}>หน้าแรก</Link>
            {Object.entries(sections).map(([id, meta]) => (
              <Link key={id} to={`/category/${id}`} className={route.section === id ? 'active' : ''} onClick={() => setMenuOpen(false)}>{meta.label}</Link>
            ))}
            <div className="mobile-sync"><SyncButton catalog={catalog} checking={checking} manualState={manualState} onManualUpdate={onManualUpdate} /></div>
          </nav>
          <form className="header-search" role="search" onSubmit={submitSearch}>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="ค้นหาหนัง ช่อง หรือกีฬา…" aria-label="ค้นหา" />
            {query && <button className="search-clear" type="button" onClick={() => setQuery('')} aria-label="ล้างการค้นหา">×</button>}
            <button className="search-submit" type="submit" aria-label="ค้นหา">⌕</button>
            {suggestions.length > 0 && (
              <div className="search-results" role="listbox" aria-label="ผลการค้นหา">
                {suggestions.map((item) => {
                  const section = getItemSection(catalog, item.id);
                  return <button key={item.id} type="button" onClick={() => { setQuery(''); onPlay(item, section); }}><Poster item={item} /><span><strong>{displayTitle(item)}</strong><small>{sections[section].label} · {item.streamType || item.league || item.group}</small></span></button>;
                })}
              </div>
            )}
          </form>
          <div className="desktop-sync"><SyncButton catalog={catalog} checking={checking} manualState={manualState} onManualUpdate={onManualUpdate} /></div>
          <button className="menu-toggle" type="button" aria-expanded={menuOpen} onClick={() => setMenuOpen((value) => !value)} aria-label="เปิดเมนู"><span /><span /><span /></button>
        </div>
      </header>
      {menuOpen && <button className="menu-backdrop" type="button" aria-label="ปิดเมนู" onClick={() => setMenuOpen(false)} />}
    </>
  );
}

function Poster({ item, className = '' }) {
  if (item.logo && !item.logo.includes('ui-avatars.com')) return <img className={className} src={item.logo} alt="" loading="lazy" referrerPolicy="no-referrer" />;
  return <span className={`poster-fallback ${className}`} aria-hidden="true">{item.awayLogo ? 'VS' : 'EC'}</span>;
}

function MediaCard({ item, section, compact = false, onPlay }) {
  const title = displayTitle(item);
  return (
    <article className={`media-card${compact ? ' is-compact' : ''}${section === 'sports' ? ' is-sport' : ''}`}>
      <button className="media-poster" type="button" onClick={() => onPlay(item, section)} aria-label={`เล่น ${title}`}>
        {section === 'sports' && item.awayLogo ? <span className="team-match"><Poster item={item} /><b>VS</b><img src={item.awayLogo} alt="" loading="lazy" referrerPolicy="no-referrer" /></span> : <Poster item={item} />}
        <span className="poster-shade" />
        <span className="type-badge">{section === 'sports' ? (item.status || 'LIVE') : item.streamType || 'VIDEO'}</span>
        <span className="play-hover">▶ รับชม</span>
      </button>
      <div className="media-body">
        <h3><button type="button" onClick={() => onPlay(item, section)}>{title}</button></h3>
        {section === 'sports' && <p className="event-time">{formatEventTime(item.time)}</p>}
        <p>{section === 'movies' ? item.group || item.source : section === 'live' ? item.group : item.league || item.sport}</p>
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

function Hero({ item, generatedAt, onPlay }) {
  const title = displayTitle(item);
  const backdrop = hasUsefulPoster(item) ? { backgroundImage: `linear-gradient(90deg, rgba(7,5,11,.98) 0%, rgba(7,5,11,.76) 48%, rgba(7,5,11,.25) 100%), linear-gradient(0deg, rgba(7,5,11,.92), rgba(7,5,11,.08) 68%), url("${item.logo.replaceAll('"', '%22')}")` } : undefined;
  return (
    <section className="feature-hero" style={backdrop} aria-label="รายการหนังอัปเดตใหม่">
      <div className="feature-glow" />
      <div className="feature-copy">
        <span className="update-kicker"><i /> อัปเดตใหม่จากต้นทาง</span>
        <h1>{title}</h1>
        <p>รายการล่าสุดจากสัญญาณอัปเดตของคลัง พร้อมรับชมผ่านระบบ secure streaming ของ entertainment-complex</p>
        <div className="feature-meta"><span>{item.streamType || 'วิดีโอ'}</span><span>{item.group || item.source || 'รายการใหม่'}</span><span>{formatSyncTime(generatedAt)}</span></div>
        <div className="feature-actions"><button className="primary-button" type="button" onClick={() => onPlay(item, 'movies')}>▶ รับชมตอนนี้</button><Link className="secondary-button" to={`/details/movies/${encodeURIComponent(item.id)}`}>ดูรายละเอียด</Link></div>
      </div>
      <div className="feature-poster"><Poster item={item} /></div>
    </section>
  );
}

function HomePage({ catalog, loading, onPlay }) {
  const newest = useMemo(() => recentMovies(catalog, 20), [catalog]);
  const heroItem = newest.find(hasUsefulPoster) || newest[0];
  const liveItems = catalog.live.slice(0, 12);
  const sportItems = catalog.sports.filter((item) => !['FT', 'Finished'].includes(item.status)).slice(0, 10);
  if (loading) return <PageLoading />;
  return (
    <main className="site-main home-page">
      {heroItem ? <Hero item={heroItem} generatedAt={catalog.generatedAt} onPlay={onPlay} /> : <EmptyState title="ยังไม่มีรายการหนัง" />}
      <div className="home-layout">
        <aside className="home-sidebar left-sidebar">
          <PanelTitle icon="◈" title="เลือกดูง่ายๆ" />
          <Link className="quick-category movie" to="/category/movies"><span>▶</span><div><strong>หนังทั้งหมด</strong><small>{catalog.total.toLocaleString('th-TH')} เรื่อง</small></div><b>›</b></Link>
          <Link className="quick-category live" to="/category/live"><span>●</span><div><strong>ทีวีสด</strong><small>{catalog.liveTotal.toLocaleString('th-TH')} ช่อง</small></div><b>›</b></Link>
          <Link className="quick-category sports" to="/category/sports"><span>◆</span><div><strong>กีฬาสด</strong><small>{catalog.sportsTotal.toLocaleString('th-TH')} รายการ</small></div><b>›</b></Link>
          <div className="sidebar-note"><span>NO ADS</span><strong>ดูต่อเนื่อง ไม่มีอะไรมารบกวน</strong><p>เลือกเนื้อหาแล้วเริ่มรับชมได้ทันที</p></div>
        </aside>
        <div className="home-content">
          <section className="intro-panel"><span className="eyebrow">ENTERTAINMENT COMPLEX</span><h2>หนัง ทีวีสด และกีฬา อยู่ในที่เดียว</h2><p>ค้นหา เลือก และรับชมได้ตรงไปตรงมา ทุกหน้าถูกออกแบบให้เนื้อหาเป็นจุดเด่น โดยไม่มีพื้นที่โฆษณาแทรก</p></section>
          <Rail eyebrow="JUST UPDATED" title="หนังอัปเดตล่าสุด" items={newest.slice(0, 12)} section="movies" viewAll="/category/movies" onPlay={onPlay} />
          <Rail eyebrow="LIVE NOW" title="ช่องทีวีสด" items={liveItems} section="live" viewAll="/category/live" onPlay={onPlay} />
          <Rail eyebrow="SPORTS" title="โปรแกรมกีฬาที่รับชมได้" items={sportItems} section="sports" viewAll="/category/sports" onPlay={onPlay} />
        </div>
        <aside className="home-sidebar right-sidebar">
          <PanelTitle icon="✦" title="สถานะคลัง" />
          <div className="library-stat"><strong>{catalog.total.toLocaleString('th-TH')}</strong><span>หนัง</span></div>
          <div className="library-stat"><strong>{catalog.liveTotal.toLocaleString('th-TH')}</strong><span>ช่องทีวี</span></div>
          <div className="library-stat"><strong>{catalog.sportsTotal.toLocaleString('th-TH')}</strong><span>รายการกีฬา</span></div>
          <div className="last-update"><small>อัปเดตล่าสุด</small><strong>{formatSyncTime(catalog.generatedAt)}</strong><p>ระบบตรวจข้อมูลใหม่อัตโนมัติทุก 15 นาที</p></div>
        </aside>
      </div>
    </main>
  );
}

function PanelTitle({ icon, title }) {
  return <div className="panel-title"><span>{icon}</span><h2>{title}</h2></div>;
}

function useQueryState() {
  return useMemo(() => new URLSearchParams(window.location.search), [window.location.search]);
}

function CategoryPage({ catalog, section, loading, onPlay }) {
  const params = useQueryState();
  const [query, setQuery] = useState(params.get('q') || '');
  const [filter, setFilter] = useState(params.get('filter') || '');
  const [page, setPage] = useState(Math.max(1, Number(params.get('page')) || 1));
  const meta = sections[section];
  const items = getSectionItems(catalog, section);
  const filterOptions = useMemo(() => [...new Set(items.map((item) => section === 'movies' ? item.source : section === 'live' ? item.group : item.sport).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'th')), [items, section]);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('th');
    return items.filter((item) => {
      const itemFilter = section === 'movies' ? item.source : section === 'live' ? item.group : item.sport;
      return (!filter || itemFilter === filter) && (!normalized || `${displayTitle(item)} ${item.source || ''} ${item.group || ''} ${item.league || ''}`.toLocaleLowerCase('th').includes(normalized));
    });
  }, [items, query, filter, section]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const visible = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  useEffect(() => {
    const next = new URLSearchParams();
    if (query) next.set('q', query);
    if (filter) next.set('filter', filter);
    if (safePage > 1) next.set('page', String(safePage));
    const suffix = next.toString() ? `?${next}` : '';
    window.history.replaceState({}, '', `/category/${section}${suffix}`);
  }, [query, filter, safePage, section]);

  useEffect(() => { setPage(1); }, [query, filter]);
  useEffect(() => { setQuery(params.get('q') || ''); setFilter(params.get('filter') || ''); setPage(Math.max(1, Number(params.get('page')) || 1)); }, [section]);

  if (loading) return <PageLoading />;
  return (
    <main className="site-main inner-page">
      <Breadcrumbs items={[['หน้าแรก', '/'], [meta.label]]} />
      <section className="archive-hero"><span className="archive-icon">{section === 'movies' ? '▶' : section === 'live' ? '●' : '◆'}</span><div><span className="eyebrow">{meta.eyebrow}</span><h1>{meta.label}</h1><p>เลือกดูจากคลังทั้งหมดได้อย่างรวดเร็ว ไม่มีโฆษณาหรือหน้าต่างรบกวน</p></div><strong>{filtered.length.toLocaleString('th-TH')}<small>รายการ</small></strong></section>
      <div className="catalog-layout">
        <aside className="filter-panel">
          <PanelTitle icon="⌁" title="ค้นหาและกรอง" />
          <label><span>ค้นหา</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`ค้นหา${meta.label}…`} /></label>
          <label><span>{meta.filterLabel}</span><select value={filter} onChange={(event) => setFilter(event.target.value)}><option value="">ทั้งหมด</option>{filterOptions.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>
          {(query || filter) && <button className="clear-filters" type="button" onClick={() => { setQuery(''); setFilter(''); }}>ล้างตัวกรอง</button>}
          <div className="filter-summary"><span>กำลังแสดง</span><strong>{visible.length.toLocaleString('th-TH')}</strong><small>จาก {filtered.length.toLocaleString('th-TH')} รายการ</small></div>
        </aside>
        <section className="catalog-content" aria-live="polite">
          <div className="catalog-heading"><div><span className="eyebrow">BROWSE</span><h2>{query ? `ผลการค้นหา “${query}”` : filter || `${meta.label}ทั้งหมด`}</h2></div><span>หน้า {safePage.toLocaleString('th-TH')} / {pageCount.toLocaleString('th-TH')}</span></div>
          {visible.length ? <div className={`catalog-grid${section === 'sports' ? ' sport-grid' : ''}`}>{visible.map((item) => <MediaCard key={item.id} item={item} section={section} onPlay={onPlay} />)}</div> : <EmptyState title="ไม่พบรายการที่ค้นหา" description="ลองใช้คำค้นที่สั้นลงหรือเปลี่ยนตัวกรอง" />}
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
  const similarKey = section === 'movies' ? item.source : section === 'live' ? item.group : item.sport;
  const related = items.filter((entry) => entry.id !== id && (section === 'movies' ? entry.source : section === 'live' ? entry.group : entry.sport) === similarKey).slice(0, 10);
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

function StreamPlayer({ item }) {
  const videoRef = useRef(null);
  const [status, setStatus] = useState('กำลังเตรียมเครื่องเล่น…');
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !item) return undefined;
    let hls;
    let shakaPlayer;
    let cancelled = false;
    let cancelReadiness = () => {};
    setStatus('กำลังเชื่อมต่อสตรีม…');
    async function setup() {
      if (item.streamType === 'DASH') {
        const module = await import('shaka-player/dist/shaka-player.compiled.js');
        const shaka = module.default || module;
        shaka.polyfill.installAll();
        if (!shaka.Player.isBrowserSupported()) throw new Error('DASH_NOT_SUPPORTED');
        shakaPlayer = new shaka.Player();
        await shakaPlayer.attach(video);
        const network = shakaPlayer.getNetworkingEngine();
        network.registerRequestFilter((type, request) => {
          if (type !== shaka.net.NetworkingEngine.RequestType.MANIFEST) request.uris = request.uris.map((uri) => `${item.playUrl}&u=${encodeURIComponent(uri)}`);
        });
        await new Promise((resolve, reject) => {
          let readyCheck;
          const finish = () => {
            video.removeEventListener('canplay', finish);
            window.clearInterval(readyCheck);
            resolve();
          };
          const fail = (error) => {
            video.removeEventListener('canplay', finish);
            window.clearInterval(readyCheck);
            reject(error);
          };
          video.addEventListener('canplay', finish, { once: true });
          readyCheck = window.setInterval(() => { if (video.readyState >= 3) finish(); }, 150);
          shakaPlayer.load(item.playUrl, null, 'application/dash+xml').then(finish, fail);
        });
      } else {
        const { default: Hls } = await import('hls.js');
        if (cancelled) return;
        if (Hls.isSupported() && (item.streamType === 'HLS' || /\.m3u8/i.test(item.playUrl))) {
          hls = new Hls({ enableWorker: true, lowLatencyMode: true });
          hls.loadSource(item.playUrl);
          hls.attachMedia(video);
          await new Promise((resolve, reject) => {
            let readyCheck;
            let readyTimeout;
            let settled = false;
            const cleanup = () => {
              video.removeEventListener('canplay', finish);
              window.clearInterval(readyCheck);
              window.clearTimeout(readyTimeout);
            };
            const finish = () => {
              if (settled) return;
              settled = true;
              cleanup();
              resolve();
            };
            const fail = (detail) => {
              if (settled) return;
              settled = true;
              cleanup();
              reject(new Error(detail || 'stream_load_failed'));
            };
            cancelReadiness = cleanup;
            video.addEventListener('canplay', finish, { once: true });
            readyCheck = window.setInterval(() => { if (video.readyState >= 3) finish(); }, 150);
            readyTimeout = window.setTimeout(() => fail('stream_timeout'), 20_000);
            hls.on(Hls.Events.ERROR, (_event, data) => { if (data.fatal) fail(data.details || data.type); });
          });
        } else {
          video.src = item.playUrl;
          video.load();
        }
      }
      if (!cancelled) {
        setStatus('พร้อมเล่น');
        video.play().catch(() => setStatus('กดปุ่มเล่นเพื่อเริ่มรับชม'));
      }
    }
    setup().catch((playerError) => {
      console.error('player setup failed', playerError);
      setStatus(playerError?.message === 'DASH_NOT_SUPPORTED' ? 'เบราว์เซอร์นี้ไม่รองรับ DASH' : `โหลดสตรีมไม่สำเร็จ${playerError?.message ? ` (${playerError.message})` : ''}`);
    });
    return () => { cancelled = true; cancelReadiness(); hls?.destroy(); shakaPlayer?.destroy(); video.removeAttribute('src'); video.load(); };
  }, [item]);
  return <><div className="video-frame"><video ref={videoRef} controls playsInline poster={item.logo || undefined} /></div><div className="player-status"><span className="status-dot" /><span>{status}</span><b>SECURE STREAM</b></div></>;
}

function WatchPage({ catalog, section, id, loading }) {
  const item = getSectionItems(catalog, section).find((entry) => entry.id === id);
  if (loading) return <PageLoading />;
  if (!item) return <NotFound />;
  const title = displayTitle(item);
  return (
    <main className="site-main watch-page">
      <Breadcrumbs items={[['หน้าแรก', '/'], [sections[section].label, `/category/${section}`], [title, `/details/${section}/${encodeURIComponent(id)}`], ['เครื่องเล่น']]} />
      <section className="watch-shell"><div className="watch-heading"><div><span className="eyebrow">NOW PLAYING</span><h1>{title}</h1></div><Link className="secondary-button" to={`/details/${section}/${encodeURIComponent(id)}`}>← รายละเอียด</Link></div><StreamPlayer item={item} /></section>
      <div className="watch-help"><span>ไม่มีโฆษณา</span><p>หากวิดีโอไม่เริ่มอัตโนมัติ ให้กดปุ่มเล่นหนึ่งครั้ง เนื่องจากนโยบาย autoplay ของเบราว์เซอร์</p></div>
    </main>
  );
}

function PlayerOverlay({ selection, onClose }) {
  const { item, section } = selection;
  const title = displayTitle(item);
  return (
    <section className="fullscreen-player" role="dialog" aria-modal="true" aria-label={`กำลังรับชม ${title}`}>
      <header className="fullscreen-player-head">
        <div><span className="eyebrow">NOW PLAYING · {sections[section].label}</span><h2>{title}</h2></div>
        <button type="button" onClick={onClose} aria-label="ปิดเครื่องเล่น" autoFocus>×</button>
      </header>
      <div className="fullscreen-player-stage"><StreamPlayer key={item.id} item={item} /></div>
      <p className="fullscreen-player-help">กด Esc หรือปุ่ม × เพื่อกลับไปยังรายการเดิม · ไม่มีโฆษณาคั่น</p>
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
  const { catalog, loading, checking, error, syncNotice, manualState, manualUpdate } = useCatalog();
  const [activePlayer, setActivePlayer] = useState(null);
  const openPlayer = (item, section) => {
    setActivePlayer({ item, section });
    const root = document.documentElement;
    const requestFullscreen = root.requestFullscreen || root.webkitRequestFullscreen;
    if (!document.fullscreenElement && !document.webkitFullscreenElement && requestFullscreen) {
      Promise.resolve(requestFullscreen.call(root, { navigationUI: 'hide' })).catch(() => {});
    }
  };
  const closePlayer = () => {
    setActivePlayer(null);
    const exitFullscreen = document.exitFullscreen || document.webkitExitFullscreen;
    if ((document.fullscreenElement || document.webkitFullscreenElement) && exitFullscreen) {
      Promise.resolve(exitFullscreen.call(document)).catch(() => {});
    }
  };

  useEffect(() => {
    if (!activePlayer) return undefined;
    document.body.classList.add('player-open');
    const handleKeyDown = (event) => { if (event.key === 'Escape') closePlayer(); };
    const handleFullscreenChange = () => {
      if (!document.fullscreenElement && !document.webkitFullscreenElement) setActivePlayer(null);
    };
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    return () => {
      document.body.classList.remove('player-open');
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
    };
  }, [activePlayer]);

  let page;
  if (route.name === 'home') page = <HomePage catalog={catalog} loading={loading} onPlay={openPlayer} />;
  else if (route.name === 'category') page = <CategoryPage catalog={catalog} section={route.section} loading={loading} onPlay={openPlayer} />;
  else if (route.name === 'details') page = <DetailPage catalog={catalog} section={route.section} id={route.id} loading={loading} onPlay={openPlayer} />;
  else if (route.name === 'watch') page = <WatchPage catalog={catalog} section={route.section} id={route.id} loading={loading} />;
  else page = <NotFound />;
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">ข้ามไปยังเนื้อหา</a>
      <Header catalog={catalog} route={route} checking={checking} manualState={manualState} onManualUpdate={manualUpdate} onPlay={openPlayer} />
      <div id="main-content">{syncNotice && <div className="global-notice" role="status">✓ {syncNotice}</div>}{error && <div className="global-error" role="alert">{error}</div>}{page}</div>
      <Footer catalog={catalog} />
      {activePlayer && <PlayerOverlay selection={activePlayer} onClose={closePlayer} />}
    </div>
  );
}
