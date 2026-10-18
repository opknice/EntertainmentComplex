import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { clearPlaybackProgress, readPlaybackProgress, savePlaybackProgress } from './playback-progress';
import { mediaRanges } from './player-controls';

const STORAGE_WARNING = 'เบราว์เซอร์นี้ไม่อนุญาตให้บันทึกตำแหน่งรับชม';

export function usePlaybackProgress(videoRef, identity, live, onStart) {
  const [saved] = useState(() => live ? { progress: null, available: true } : readPlaybackProgress(identity));
  const [phase, setPhase] = useState(saved.progress ? 'prompt' : 'active');
  const [error, setError] = useState('');
  const [warning, setWarning] = useState(saved.available ? '' : STORAGE_WARNING);
  const session = useRef({ phase: saved.progress ? 'prompt' : 'active', choice: null, ready: false, engaged: false, applied: false, lastWrite: 0 });
  const latest = useRef(null);
  latest.current = { live, onStart };
  const blocked = !live && Boolean(saved.progress) && phase !== 'active';

  const activate = () => {
    const video = videoRef.current, state = session.current;
    if (!state.ready) return false;
    if (latest.current.live || state.phase === 'active') return true;
    if (!state.choice) return false;
    if (state.choice === 'continue' && !state.applied) {
      const position = saved.progress.position;
      const ranges = mediaRanges(video.seekable);
      const seekable = ranges.some(range => position >= range.start && position < range.end);
      if (!seekable || !Number.isFinite(video.duration) || position >= video.duration) {
        state.phase = 'prompt'; state.choice = null;
        setPhase('prompt');
        setError('ไฟล์นี้ยังกลับไปตำแหน่งเดิมไม่ได้ ลองเล่นต่ออีกครั้ง หรือเลือกเริ่มใหม่');
        return false;
      }
      try { video.currentTime = position; }
      catch {
        state.phase = 'prompt'; state.choice = null; setPhase('prompt');
        setError('ต้นทางยังไม่ยอมให้เลื่อนไปตำแหน่งเดิม เลือกเริ่มใหม่ได้');
        return false;
      }
      state.applied = true;
    }
    if (state.choice === 'restart') {
      if (!clearPlaybackProgress(identity)) setWarning(STORAGE_WARNING);
      try { video.currentTime = 0; } catch { /* A newly loaded source is already at its beginning. */ }
    }
    state.phase = 'active';
    // Update autoplay and its explicit playback gate before calling play().
    flushSync(() => setPhase('active'));
    return true;
  };

  const choose = choice => {
    session.current.choice = choice;
    session.current.phase = 'waiting';
    setError(''); setPhase('waiting');
    if (activate()) latest.current.onStart();
  };

  useEffect(() => {
    const video = videoRef.current, state = session.current;
    if (!video || !identity || live) return undefined;
    let mounted = true;
    const report = available => { if (mounted) setWarning(available ? '' : STORAGE_WARNING); };
    const persist = () => {
      if (state.phase !== 'active' || !state.engaged) return;
      if (video.ended) { report(clearPlaybackProgress(identity)); return; }
      const result = savePlaybackProgress(identity, video.currentTime, video.duration);
      report(result.available);
      if (result.saved) state.lastWrite = performance.now();
    };
    const playing = () => {
      if (state.phase !== 'active') { video.pause(); return; }
      state.engaged = true;
    };
    const update = () => { if (performance.now() - state.lastWrite >= 5000) persist(); };
    const hidden = () => { if (video.ownerDocument.visibilityState === 'hidden') persist(); };
    video.addEventListener('playing', playing);
    video.addEventListener('timeupdate', update);
    ['pause', 'seeked', 'ended'].forEach(name => video.addEventListener(name, persist));
    video.ownerDocument.addEventListener('visibilitychange', hidden);
    const window = video.ownerDocument.defaultView;
    window.addEventListener('pagehide', persist);
    return () => {
      mounted = false;
      // This hook runs before the loader clears src/destroys its media engine.
      persist();
      video.removeEventListener('playing', playing);
      video.removeEventListener('timeupdate', update);
      ['pause', 'seeked', 'ended'].forEach(name => video.removeEventListener(name, persist));
      video.ownerDocument.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', persist);
    };
  }, [videoRef, identity, live]);

  return {
    blocked, waiting: phase === 'waiting', saved: saved.progress, error, warning,
    choose,
    loading: () => { session.current.ready = false; },
    ready: () => { session.current.ready = true; return activate(); },
  };
}
