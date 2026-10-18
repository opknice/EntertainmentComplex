import { useEffect, useRef, useState } from 'react';
import { detectStreamType, highestHlsConfig, highestQualityIndex, highestShakaConfig, lockHlsToHighest, lockShakaToHighest, playable, playbackErrorMessage, proxyResourceUrl, sourceUrl } from './playback';
import { startVideoPresentation } from './player-presentation';
import PlayerControls from './PlayerControls';
import { usePlaybackProgress } from './usePlaybackProgress';
import ResumePrompt from './ResumePrompt';
import { createRecoveryBudget } from './playback-recovery';

export default function StreamPlayer({ item, mediaRef, autoFullscreen = false, live = false, resumeId, onClose }) {
  const internalVideoRef = useRef(null);
  const videoRef = mediaRef || internalVideoRef;
  const surfaceRef = useRef(null);
  const cleanupDone = useRef(Promise.resolve());
  const [status, setStatus] = useState('กำลังเตรียมเครื่องเล่น…');
  const [resolution, setResolution] = useState('');
  const [actionRequired, setActionRequired] = useState('');
  const [nativePresentation, setNativePresentation] = useState(false);
  const [failed, setFailed] = useState(false);
  const [generation, setGeneration] = useState(0);
  const recovery = useRef(null);
  const retryPosition = useRef(null);
  const applyPresentation = ({ playing }) => {
    setActionRequired(playing ? '' : 'play');
    if (!playing) setStatus('แตะปุ่มเล่นเพื่อเริ่มรับชม');
  };
  const startPlayback = () => {
    if (failed) {
      if (!live && videoRef.current?.currentTime > 0) retryPosition.current = videoRef.current.currentTime;
      recovery.current?.budget.reset();
      setGeneration(value => value + 1);
      return;
    }
    const video = videoRef.current;
    setStatus('กำลังเริ่มรับชม…');
    startVideoPresentation(video, autoFullscreen).then(result => { if (video.isConnected && videoRef.current === video) applyPresentation(result); });
  };
  const progress = usePlaybackProgress(videoRef, resumeId, live, startPlayback);
  useEffect(() => {
    const video = videoRef.current;
    const begin = () => setNativePresentation(true), end = () => setNativePresentation(false);
    video.addEventListener('webkitbeginfullscreen', begin);
    video.addEventListener('webkitendfullscreen', end);
    return () => { video.removeEventListener('webkitbeginfullscreen', begin); video.removeEventListener('webkitendfullscreen', end); };
  }, [videoRef]);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    progress.loading();
    if (!item) return () => { video.pause(); video.removeAttribute('src'); video.load(); };
    const previousCleanup = cleanupDone.current;
    const controller = new AbortController();
    let hls, shakaPlayer, transportPlayer;
    let cancelled = false;
    let terminalError = false;
    let cancelReadiness = () => {};
    let lastHttpStatus;
    if (recovery.current?.item !== item) {
      recovery.current = { item, budget: createRecoveryBudget() };
      retryPosition.current = null;
    }
    const budget = recovery.current.budget;
    let retryTimer;
    let retryPending = false;
    let loaded = false;
    let lastPosition = video.currentTime;
    let lastAdvance = performance.now();
    const scheduleRecovery = error => {
      if (!live || cancelled || retryPending) return retryPending;
      // Do not undo a deliberate pause; initial load and native media errors
      // may legitimately have paused=true without a user pause.
      if (loaded && video.paused && !video.error && !video.ended) return false;
      const next = budget.next(error);
      if (!next) return false;
      retryPending = true;
      terminalError = true;
      setFailed(false);
      setStatus(`สัญญาณสะดุด · เชื่อมต่อใหม่ใน ${next.delay / 1000} วินาที (${next.attempt}/5)`);
      const retry = () => {
        if (cancelled) return;
        if (loaded && video.paused && !video.error && !video.ended) {
          retryPending = false;
          setFailed(true);
          setStatus('หยุดพัก · กดเชื่อมต่อใหม่เมื่อต้องการรับชม');
          return;
        }
        if (navigator.onLine === false || document.hidden) {
          setStatus('รอเครือข่ายหรือกลับมาที่หน้ารับชม แล้วจะเชื่อมต่อใหม่');
          retryTimer = setTimeout(retry, 2000);
          return;
        }
        setGeneration(value => value + 1);
      };
      retryTimer = setTimeout(retry, next.delay);
      return true;
    };
    setStatus('กำลังโหลดคุณภาพสูงสุดจากต้นทาง…');
    setResolution('');
    setActionRequired('');
    setFailed(false);
    const updateResolution = () => {
      if (!cancelled && video.videoWidth) setResolution(video.videoWidth + '×' + video.videoHeight);
    };
    const playing = () => {
      updateResolution();
      if (!cancelled && !terminalError) {
        setStatus('กำลังเล่น');
        setActionRequired('');
      }
    };
    const waiting = () => { budget.stalled(); if (!cancelled && !terminalError) setStatus('กำลังบัฟเฟอร์คุณภาพสูงสุด…'); };
    const watchdog = setInterval(() => {
      if (!live || cancelled || retryPending || terminalError) return;
      const now = performance.now();
      if (video.paused || video.seeking || document.hidden || navigator.onLine === false) {
        lastAdvance = now; lastPosition = video.currentTime; budget.stalled(); return;
      }
      if (Math.abs(video.currentTime - lastPosition) > 0.05) {
        lastAdvance = now; lastPosition = video.currentTime; budget.progressing(now);
      } else {
        budget.stalled();
        if (now - lastAdvance >= 30000 && !scheduleRecovery(new Error('playback_timeout'))) {
          terminalError = true;
          setFailed(true);
          setStatus('สัญญาณยังไม่กลับมาหลังลองเชื่อมต่อใหม่ · กดเชื่อมต่อใหม่เพื่อลองอีกครั้ง');
        }
      }
    }, 2000);
    const mediaError = () => {
      if (!loaded || cancelled) return; // Initial errors are owned by playable().
      const error = new Error(`video_error_${video.error?.code || 'unknown'}`);
      if (!scheduleRecovery(error)) {
        terminalError = true;
        setFailed(true);
        setStatus(playbackErrorMessage(error));
      }
    };
    const liveEnded = () => { if (live) scheduleRecovery(new Error('EarlyEof')); };
    video.addEventListener('resize', updateResolution);
    video.addEventListener('loadedmetadata', updateResolution);
    video.addEventListener('playing', playing);
    video.addEventListener('waiting', waiting);
    video.addEventListener('error', mediaError);
    video.addEventListener('ended', liveEnded);

    async function setup() {
      await previousCleanup;
      if (cancelled) return;
      if (item.playbackError) throw new Error(item.playbackError);
      const streamType = await detectStreamType(item, controller.signal);
      if (cancelled) return;
      let rejectFatal;
      const fatal = new Promise((_resolve, reject) => { rejectFatal = reject; });
      const fail = (error) => {
        if (cancelled) return;
        if (scheduleRecovery(error)) { rejectFatal(error); return; }
        terminalError = true;
        setFailed(true);
        setStatus(playbackErrorMessage(error));
        rejectFatal(error);
      };
      const ready = playable(video, (cancel) => { cancelReadiness = cancel; });
      const load = async () => {
        if (streamType === 'DASH' || streamType === 'MKV' || item.clearKeys) {
          const module = streamType === 'MKV'
            ? await import('shaka-player/dist/shaka-player.experimental.js')
            : await import('shaka-player/dist/shaka-player.compiled.js');
          if (cancelled) return;
          const shaka = module.default || module;
          shaka.polyfill.installAll();
          if (!shaka.Player.isBrowserSupported()) throw new Error('DASH_NOT_SUPPORTED');
          shakaPlayer = new shaka.Player();
          await shakaPlayer.attach(video);
          if (cancelled) return;
          shakaPlayer.configure(highestShakaConfig);
          if (live) shakaPlayer.configure({ streaming: { rebufferingGoal: 6 } });
          if (item.clearKeys) shakaPlayer.configure({ drm: { clearKeys: item.clearKeys } });
          const network = shakaPlayer.getNetworkingEngine();
          let manifestBase = sourceUrl(item);
          let resourceContext = item.playUrl;
          network.registerRequestFilter((_type, request) => {
            request.uris = request.uris.map((uri) => /^https?:/i.test(uri) ? proxyResourceUrl(resourceContext, uri, manifestBase) : uri);
          });
          network.registerResponseFilter((type, response) => {
            if (type === shaka.net.NetworkingEngine.RequestType.MANIFEST) {
              manifestBase = response.headers['x-media-base'] || manifestBase;
              resourceContext = response.headers['x-media-context'] || resourceContext;
              response.uri = manifestBase;
            }
          });
          shakaPlayer.addEventListener('error', (event) => {
            if (event.detail.severity !== shaka.util.Error.Severity.RECOVERABLE) fail(event.detail);
          });
          let loaded = false;
          shakaPlayer.addEventListener('trackschanged', () => { if (loaded && !cancelled) lockShakaToHighest(shakaPlayer); });
          const mime = streamType === 'DASH' ? 'application/dash+xml' : streamType === 'MKV' ? 'video/x-matroska' : 'application/x-mpegurl';
          await shakaPlayer.load(item.playUrl, null, mime);
          if (cancelled) return;
          loaded = true;
          lockShakaToHighest(shakaPlayer);
          return;
        }
        if (streamType === 'MPEG-TS' || streamType === 'FLV') {
          const module = await import('mpegts.js');
          if (cancelled) return;
          const mpegts = module.default || module;
          if (!mpegts.getFeatureList().msePlayback) throw new Error('MEDIA_ERR_SRC_NOT_SUPPORTED');
          mpegts.LoggingControl.enableInfo = false;
          transportPlayer = mpegts.createPlayer({
            type: streamType === 'FLV' ? 'flv' : 'mpegts',
            isLive: !['movie', 'series'].includes(item.kind), url: item.playUrl,
          }, { enableWorker: true, enableStashBuffer: true, liveBufferLatencyChasing: false, autoCleanupSourceBuffer: true });
          transportPlayer.on(mpegts.Events.ERROR, (_type, detail, info) => fail(new Error(info?.code ? 'HTTP ' + info.code : detail)));
          transportPlayer.attachMediaElement(video);
          transportPlayer.load();
          return;
        }
        if (streamType === 'HLS') {
          const { default: Hls } = await import('hls.js');
          if (cancelled) return;
          if (Hls.isSupported()) {
            hls = new Hls({ ...highestHlsConfig, ...(live ? { liveSyncDurationCount: 6 } : {}) });
            hls.on(Hls.Events.MANIFEST_PARSED, () => {
              lockHlsToHighest(hls);
              hls.startLoad();
            });
            hls.on(Hls.Events.LEVELS_UPDATED, () => lockHlsToHighest(hls));
            hls.on(Hls.Events.LEVEL_SWITCHING, (_event, data) => {
              if (data.level !== highestQualityIndex(hls.levels)) {
                hls.stopLoad();
                fail(new Error('HIGHEST_QUALITY_UNAVAILABLE'));
              }
            });
            hls.on(Hls.Events.ERROR, (_event, data) => {
              if (data.response?.code) lastHttpStatus = data.response.code;
              if (data.fatal) {
                const error = new Error(data.response?.code ? 'HTTP ' + data.response.code : data.details || data.type);
                error.recoverable = [Hls.ErrorTypes.NETWORK_ERROR, Hls.ErrorTypes.MEDIA_ERROR].includes(data.type);
                fail(error);
              }
            });
            hls.loadSource(item.playUrl);
            hls.attachMedia(video);
            return;
          }
        }
        video.src = item.playUrl;
        video.load();
      };
      await Promise.race([Promise.all([ready, load()]), fatal]);
      if (!cancelled) {
        loaded = true;
        lastAdvance = performance.now();
        if (!live && retryPosition.current !== null) {
          const position = retryPosition.current;
          let seekable = false;
          for (let index = 0; index < video.seekable.length; index += 1) {
            if (position >= video.seekable.start(index) && position < video.seekable.end(index)) seekable = true;
          }
          if (!seekable) throw new Error('ยังกลับไปตำแหน่งเดิมไม่ได้ กรุณาลองเชื่อมต่อใหม่');
          video.currentTime = position;
          retryPosition.current = null;
        }
        updateResolution();
        if (!progress.ready()) { setStatus('เลือกรับชมต่อหรือเริ่มใหม่'); return; }
        setStatus(video.paused ? 'พร้อมเล่น · คุณภาพสูงสุด' : 'กำลังเล่น');
        startVideoPresentation(video, autoFullscreen).then((result) => { if (!cancelled) applyPresentation(result); });
      }
    }
    setup().catch((error) => {
      cancelReadiness();
      if (cancelled) return;
      const failure = error?.message === 'stream_timeout' && lastHttpStatus ? new Error('HTTP ' + lastHttpStatus) : error;
      const recovering = scheduleRecovery(failure);
      terminalError = true;
      if (!recovering) setFailed(true);
      hls?.stopLoad();
      transportPlayer?.unload();
      cleanupDone.current = Promise.resolve(shakaPlayer?.unload()).catch(() => {});
      if (!recovering) setStatus(playbackErrorMessage(failure));
    });
    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
      clearInterval(watchdog);
      controller.abort();
      cancelReadiness();
      video.removeEventListener('resize', updateResolution);
      video.removeEventListener('loadedmetadata', updateResolution);
      video.removeEventListener('playing', playing);
      video.removeEventListener('waiting', waiting);
      video.removeEventListener('error', mediaError);
      video.removeEventListener('ended', liveEnded);
      hls?.destroy();
      transportPlayer?.destroy();
      cleanupDone.current = cleanupDone.current.then(() => shakaPlayer?.destroy()).catch(() => {});
      video.removeAttribute('src');
      video.load();
    };
  }, [item, autoFullscreen, live, generation]);
  return <div ref={surfaceRef} className="video-frame player-surface" data-player-surface="" tabIndex={0} role="group" aria-label="เครื่องเล่นวิดีโอ">
    <video ref={videoRef} data-playback-blocked={progress.blocked ? 'true' : 'false'} controls={nativePresentation} autoPlay={!progress.blocked} playsInline preload="auto" poster={item?.logo || undefined} />
    {progress.blocked && item ? <ResumePrompt progress={progress} loadError={failed ? status : ''} onClose={onClose} /> : <PlayerControls videoRef={videoRef} surfaceRef={surfaceRef} item={item} live={live} autoFullscreen={autoFullscreen} status={status} saveWarning={progress.warning} failed={failed} resolution={resolution} actionRequired={actionRequired} onClose={onClose} onStart={startPlayback} />}
  </div>;
}
