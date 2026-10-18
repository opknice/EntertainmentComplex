import { useEffect, useRef, useState } from 'react';
import { enterVideoFullscreen, isVideoFullscreen, leaveVideoFullscreen, startVideoPresentation } from './player-presentation';
import { clamp, formatMediaTime, mediaRanges, probeVolume, seekMedia, setMediaVolume, tapAction, verticalGesture } from './player-controls';
import './player-controls.css';
import PlayerIcon from './PlayerIcon';

function readVideo(video, live) {
  const ranges = mediaRanges(video.seekable);
  return {
    paused: video.paused, ended: video.ended, time: video.currentTime || 0,
    duration: video.duration, ranges, live: live || video.duration === Infinity,
    volume: video.volume, muted: video.muted, rate: video.playbackRate,
    ready: video.readyState, fullscreen: isVideoFullscreen(video),
  };
}

export default function PlayerControls({ videoRef, surfaceRef, item, live, autoFullscreen, status, saveWarning, failed, resolution, actionRequired, onStart, onClose }) {
  const [media, setMedia] = useState({ paused: true, time: 0, ranges: [], volume: 1, muted: false, rate: 1, ready: 0, live, fullscreen: false });
  const [visible, setVisible] = useState(true);
  const [locked, setLocked] = useState(false);
  const [settings, setSettings] = useState(false);
  const [brightness, setBrightness] = useState(1);
  const [volumeSupported, setVolumeSupported] = useState(null);
  const [hud, setHud] = useState(null);
  const [draft, setDraft] = useState(null);
  const activity = useRef(0), pointer = useRef(null), lastTap = useRef(null);
  const tapTimer = useRef(null), hudTimer = useRef(null), scrubbing = useRef(false), draftRef = useRef(null);
  const active = useRef(null);
  active.current = { media, locked, settings };
  const wake = () => { activity.current = performance.now(); setVisible(true); };
  const notify = (text, detail = '') => {
    setHud({ text, detail });
    clearTimeout(hudTimer.current);
    hudTimer.current = setTimeout(() => setHud(null), 1100);
  };

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    const update = () => setMedia(readVideo(video, live));
    const metadata = () => { setVolumeSupported(probeVolume(video)); update(); };
    const fullscreen = () => {
      update();
      if (isVideoFullscreen(video) && !video.webkitDisplayingFullscreen) surfaceRef.current?.focus({ preventScroll: true });
    };
    const events = ['timeupdate', 'durationchange', 'progress', 'play', 'pause', 'ended', 'volumechange', 'ratechange', 'canplay', 'seeking', 'seeked', 'emptied'];
    events.forEach(name => video.addEventListener(name, update));
    video.addEventListener('loadedmetadata', metadata);
    video.ownerDocument.addEventListener('fullscreenchange', fullscreen);
    video.ownerDocument.addEventListener('webkitfullscreenchange', fullscreen);
    if (video.readyState >= 1) metadata(); else update();
    activity.current = performance.now();
    const idle = setInterval(() => {
      const state = active.current;
      if (!state.media.paused && !state.settings && !state.locked && !scrubbing.current && !pointer.current && performance.now() - activity.current > 3000 && !surfaceRef.current?.querySelector('.smart-controls:focus-within, .smart-settings:focus-within')) setVisible(false);
    }, 500);
    return () => {
      clearInterval(idle); clearTimeout(tapTimer.current); clearTimeout(hudTimer.current);
      events.forEach(name => video.removeEventListener(name, update));
      video.removeEventListener('loadedmetadata', metadata);
      video.ownerDocument.removeEventListener('fullscreenchange', fullscreen);
      video.ownerDocument.removeEventListener('webkitfullscreenchange', fullscreen);
      pointer.current = null; lastTap.current = null;
    };
  }, [videoRef, surfaceRef, item?.id, live]);

  useEffect(() => {
    const video = videoRef.current;
    if (video) video.style.filter = brightness === 1 ? '' : `brightness(${brightness})`;
    return () => { if (video) video.style.filter = ''; };
  }, [brightness, videoRef]);

  const resumePlayback = () => {
    const video = videoRef.current;
    startVideoPresentation(video, autoFullscreen && !isVideoFullscreen(video)).then(result => {
      if (!video.isConnected || videoRef.current !== video) return;
      if (!result.playing) notify('แตะเล่นอีกครั้ง', 'เบราว์เซอร์ยังไม่อนุญาตให้เล่นอัตโนมัติ');
      else if (!result.fullscreenAccepted) notify('ใช้โหมดเต็มพื้นที่เว็บ', 'เบราว์เซอร์ยังไม่อนุญาตเต็มจอ');
    });
  };
  const togglePlay = () => {
    const video = videoRef.current;
    wake();
    if (failed) { onStart(); return; }
    if (video.paused || video.ended) resumePlayback(); else video.pause();
  };
  const seekBy = (delta, total = Math.abs(delta)) => {
    const video = videoRef.current;
    const before = video.currentTime;
    const target = seekMedia(video, before + delta, media.live);
    setMedia(readVideo(video, live));
    if (target === null) notify('เลื่อนเวลาไม่ได้', media.live ? 'ต้นทางไม่มีช่วงย้อนหลังให้เลื่อน' : 'รอข้อมูลวิดีโอพร้อมก่อน');
    else notify(`${delta < 0 ? '−' : '+'}${total} วินาที`, formatMediaTime(target));
    wake();
  };
  const changeVolume = value => {
    if (volumeSupported === false || !setMediaVolume(videoRef.current, value)) {
      setVolumeSupported(false); notify('เสียงควบคุมโดยอุปกรณ์', 'ใช้ปุ่มเพิ่ม/ลดเสียงบนเครื่อง'); return;
    }
    setVolumeSupported(true); notify(`เสียง ${Math.round(videoRef.current.volume * 100)}%`);
    setMedia(readVideo(videoRef.current, live));
  };
  const changeBrightness = value => {
    const next = clamp(value, 0.25, 1.75);
    setBrightness(next); notify(`ความสว่างภาพ ${Math.round(next * 100)}%`, 'ปรับภาพวิดีโอ ไม่ใช่ความสว่างระบบ');
  };
  const fullscreen = () => {
    const video = videoRef.current;
    wake();
    if (isVideoFullscreen(video)) leaveVideoFullscreen(video);
    else enterVideoFullscreen(video).then(accepted => { if (!accepted && video.isConnected) notify('ใช้โหมดเต็มพื้นที่เว็บ', 'เบราว์เซอร์ไม่อนุญาตหรือไม่รองรับเต็มจอ'); });
  };
  const cancelGesture = () => { pointer.current = null; lastTap.current = null; clearTimeout(tapTimer.current); };
  const pointerDown = event => {
    if (locked) return;
    if (!event.isPrimary || event.button !== 0) { cancelGesture(); return; }
    const rect = event.currentTarget.getBoundingClientRect(), x = event.clientX - rect.left;
    if (event.pointerType === 'touch' && (x < 16 || x > rect.width - 16)) return;
    pointer.current = { id: event.pointerId, x, y: event.clientY, width: rect.width, height: rect.height, side: x < rect.width / 2 ? 'left' : 'right', volume: videoRef.current.volume, brightness, time: performance.now(), moved: false, mode: null };
    event.currentTarget.setPointerCapture(event.pointerId);
    surfaceRef.current?.focus({ preventScroll: true });
    activity.current = performance.now();
  };
  const pointerMove = event => {
    const start = pointer.current;
    if (!start) { if (event.pointerType === 'mouse' && !locked) wake(); return; }
    if (start.id !== event.pointerId || locked) return;
    const rect = event.currentTarget.getBoundingClientRect(), x = event.clientX - rect.left;
    if (Math.hypot(x - start.x, event.clientY - start.y) > 12) {
      start.moved = true; lastTap.current = null; clearTimeout(tapTimer.current);
    }
    const gesture = verticalGesture(start, start.mode === 'vertical' ? start.x : x, event.clientY);
    if (!gesture || start.mode === 'horizontal') {
      if (start.moved && !start.mode) start.mode = 'horizontal';
      return;
    }
    start.mode = 'vertical';
    event.preventDefault();
    if (gesture.kind === 'volume') changeVolume(gesture.value); else changeBrightness(gesture.value);
  };
  const pointerUp = event => {
    const start = pointer.current;
    if (!start || start.id !== event.pointerId) return;
    pointer.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (locked || start.moved || performance.now() - start.time > 350) return;
    const tap = tapAction(lastTap.current, start.x, start.width, performance.now());
    lastTap.current = tap; clearTimeout(tapTimer.current);
    if (tap.delta) seekBy(tap.delta, tap.total);
    else tapTimer.current = setTimeout(() => { activity.current = performance.now(); setVisible(value => !value); }, 300);
  };
  const onKeyDown = event => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'Escape' && (locked || settings)) {
      event.preventDefault(); event.stopPropagation(); setLocked(false); setSettings(false); wake(); return;
    }
    if (locked || event.target.closest('input,select,textarea,button')) return;
    const key = event.key.toLowerCase();
    const action = {
      ' ': togglePlay, k: togglePlay,
      arrowleft: () => seekBy(-10), j: () => seekBy(-10),
      arrowright: () => seekBy(10), l: () => seekBy(10),
      arrowup: () => changeVolume(videoRef.current.volume + 0.05),
      arrowdown: () => changeVolume(videoRef.current.volume - 0.05),
      m: () => { videoRef.current.muted = !videoRef.current.muted; wake(); }, f: fullscreen,
    }[key];
    if (action) { event.preventDefault(); event.stopPropagation(); action(); }
  };

  useEffect(() => {
    const surface = surfaceRef.current;
    surface?.addEventListener('keydown', onKeyDown);
    return () => surface?.removeEventListener('keydown', onKeyDown);
  });

  const start = media.ranges[0]?.start || 0, end = media.ranges.at(-1)?.end || 0;
  const canSeek = end > start;
  const time = draft ?? media.time;
  const percent = canSeek ? clamp((time - start) / (end - start) * 100, 0, 100) : 0;
  const controlsVisible = !locked && (visible || media.paused || settings || failed || Boolean(actionRequired));
  const displayStatus = media.ended ? 'จบการเล่น' : media.paused && status === 'กำลังเล่น' ? 'หยุดชั่วคราว' : status;
  const commitSeek = value => {
    const target = seekMedia(videoRef.current, Number(value), media.live);
    if (target === null) notify('เลื่อนเวลาไม่ได้');
    setMedia(readVideo(videoRef.current, live));
    setDraft(null); draftRef.current = null; scrubbing.current = false; wake();
  };

  return <>
    <div className="player-gesture-surface" aria-hidden="true" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={cancelGesture} onLostPointerCapture={() => { pointer.current = null; }} />
    {hud && <output className="player-hud" aria-live="polite"><strong>{hud.text}</strong>{hud.detail && <small>{hud.detail}</small>}</output>}
    {locked ? <button className="player-unlock" type="button" autoFocus onClick={() => { setLocked(false); surfaceRef.current?.focus({ preventScroll: true }); wake(); }} aria-label="ปลดล็อกการสัมผัส"><PlayerIcon name="unlock" /> ปลดล็อก</button> : <>
      <div className="smart-player-top" hidden={!controlsVisible}>
        <div><strong className="smart-player-title">{item ? item.title || 'รายการไม่มีชื่อ' : 'กำลังเตรียมรายการ…'}</strong><small className="player-status">{displayStatus}</small>{saveWarning && <small className="resume-save-warning" role="status">{saveWarning}</small>}</div>
        {onClose && <button type="button" className="smart-icon" onClick={onClose} aria-label="ปิดเครื่องเล่น"><PlayerIcon name="close" /></button>}
      </div>
      {(failed || actionRequired === 'play' || media.ended) && <button className="player-start primary-button" type="button" onClick={media.ended && !failed ? togglePlay : onStart}>{failed ? '↻ เชื่อมต่อใหม่' : media.ended ? '↻ เล่นอีกครั้ง' : '▶ เล่นวิดีโอ'}</button>}
      {(failed || !media.ready && !actionRequired) && <div className="player-loading" role="status">{status}</div>}
      <div className="smart-controls" hidden={!controlsVisible} onPointerDown={wake} onFocus={wake}>
        <div className="smart-seek-row">
          <input type="range" min={start} max={canSeek ? end : 1} step="0.1" value={clamp(time, start, canSeek ? end : 1)} disabled={!canSeek} aria-label="ตำแหน่งวิดีโอ" aria-valuetext={media.live ? `ย้อนหลัง ${formatMediaTime(Math.max(0, end - time))}` : formatMediaTime(time)} style={{ '--seek-progress': `${percent}%` }} onPointerDown={() => { scrubbing.current = true; }} onChange={event => {
            const value = Number(event.target.value);
            if (scrubbing.current) { setDraft(value); draftRef.current = value; } else commitSeek(value);
          }} onPointerUp={() => { if (draftRef.current !== null) commitSeek(draftRef.current); else scrubbing.current = false; }} onPointerCancel={() => { scrubbing.current = false; draftRef.current = null; setDraft(null); }} />
          {draft !== null && <output className="smart-seek-preview">{formatMediaTime(draft)}</output>}
        </div>
        <div className="smart-control-row">
          <button className="smart-icon" type="button" onClick={togglePlay} aria-label={media.paused ? 'เล่น' : 'หยุดชั่วคราว'}><PlayerIcon name={media.paused ? 'play' : 'pause'} /></button>
          <button className="smart-icon seek-step" type="button" onClick={() => seekBy(-10)} disabled={!canSeek} aria-label="ย้อนหลัง 10 วินาที">↶<small>10</small></button>
          <button className="smart-icon seek-step" type="button" onClick={() => seekBy(10)} disabled={!canSeek} aria-label="ข้ามหน้า 10 วินาที">↷<small>10</small></button>
          <span className="smart-time">{media.live ? <button className="smart-live" type="button" disabled={!canSeek} aria-label={end - time > 3 ? 'กลับสู่ถ่ายทอดสด' : 'กำลังถ่ายทอดสด'} onClick={() => { seekMedia(videoRef.current, end, true); setMedia(readVideo(videoRef.current, live)); if (videoRef.current.paused) resumePlayback(); wake(); }}>{end - time > 3 ? '↪ กลับสด' : '● LIVE'}</button> : `${formatMediaTime(time)} / ${formatMediaTime(media.duration)}`}</span>
          <button className="smart-icon" type="button" onClick={() => { videoRef.current.muted = !videoRef.current.muted; wake(); }} aria-label={media.muted ? 'เปิดเสียง' : 'ปิดเสียง'}><PlayerIcon name={media.muted ? 'muted' : 'volume'} /></button>
          <input className="smart-volume" type="range" min="0" max="1" step="0.05" value={media.muted ? 0 : media.volume} disabled={volumeSupported !== true} onChange={event => changeVolume(Number(event.target.value))} aria-label="ระดับเสียงวิดีโอ" />
          <b className="video-quality">{resolution || 'ต้นฉบับสูงสุด'}</b>
          <button className="smart-icon" type="button" aria-label="ล็อกการสัมผัส" onClick={() => { cancelGesture(); setSettings(false); setLocked(true); }}><PlayerIcon name="lock" /></button>
          <button className="smart-icon" type="button" aria-label="ตั้งค่าเครื่องเล่น" aria-expanded={settings} onClick={() => { setSettings(value => !value); wake(); }}><PlayerIcon name="settings" /></button>
          <button className="smart-icon" type="button" aria-label={media.fullscreen ? 'ออกจากเต็มจอ' : 'เต็มจอ'} onClick={fullscreen}><PlayerIcon name="fullscreen" /></button>
        </div>
      </div>
      {settings && <section className="smart-settings" aria-label="ตั้งค่าเครื่องเล่น">
        <header><strong>ตั้งค่าเครื่องเล่น</strong><button className="smart-icon" type="button" aria-label="ปิดการตั้งค่า" onClick={() => setSettings(false)}><PlayerIcon name="close" /></button></header>
        <label>ความสว่างภาพ {Math.round(brightness * 100)}%<input type="range" min="0.25" max="1.75" step="0.05" value={brightness} onChange={event => changeBrightness(Number(event.target.value))} /></label>
        <small>ปรับเฉพาะภาพวิดีโอ ไม่ใช่ความสว่างหน้าจอระบบ</small>
        <label>เสียงวิดีโอ {volumeSupported === false ? '— ใช้ปุ่มบนอุปกรณ์' : `${Math.round(media.volume * 100)}%`}<input type="range" min="0" max="1" step="0.05" value={media.volume} disabled={volumeSupported !== true} onChange={event => changeVolume(Number(event.target.value))} /></label>
        {!media.live && <label>ความเร็ว<select value={media.rate} onChange={event => {
          const video = videoRef.current, rate = Number(event.target.value);
          try { video.playbackRate = rate; if (Math.abs(video.playbackRate - rate) > 0.001) notify('อุปกรณ์ไม่รองรับความเร็วที่เลือก'); }
          catch { notify('อุปกรณ์ไม่รองรับความเร็วที่เลือก'); }
          setMedia(readVideo(video, live)); wake();
        }}>{[0.5, 0.75, 1, 1.25, 1.5, 2].map(rate => <option key={rate} value={rate}>{rate}×</option>)}</select></label>}
        <p>คุณภาพต้นทางสูงสุด · {resolution || 'รอข้อมูลวิดีโอ'}</p>
        <p>แตะสองครั้งซ้าย/ขวา: −10 / +10 วินาที<br />ปัดขึ้นลงซ้าย: เสียง · ขวา: ความสว่างภาพ<br />คอม: Space เล่น/หยุด · ←/→ เลื่อน · ↑/↓ เสียง · F เต็มจอ</p>
        {videoRef.current?.webkitEnterFullscreen && <button className="secondary-button" type="button" onClick={() => {
          try { videoRef.current.webkitEnterFullscreen(); } catch { notify('เครื่องเล่นระบบยังไม่พร้อม'); }
        }}>เปิดเครื่องเล่นระบบ (gesture ของเว็บจะไม่ทำงาน)</button>}
      </section>}
    </>}
  </>;
}
