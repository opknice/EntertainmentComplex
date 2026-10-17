import { useEffect, useRef, useState } from 'react';
import { detectStreamType, highestHlsConfig, highestQualityIndex, highestShakaConfig, lockHlsToHighest, lockShakaToHighest, playable, playbackErrorMessage, proxyResourceUrl, sourceUrl } from './playback';
import { isVideoFullscreen, startVideoPresentation } from './player-presentation';

export default function StreamPlayer({ item, mediaRef, autoFullscreen = false }) {
  const internalVideoRef = useRef(null);
  const videoRef = mediaRef || internalVideoRef;
  const cleanupDone = useRef(Promise.resolve());
  const [status, setStatus] = useState('กำลังเตรียมเครื่องเล่น…');
  const [resolution, setResolution] = useState('');
  const [actionRequired, setActionRequired] = useState('');
  const applyPresentation = ({ playing, fullscreenAccepted }) => {
    setActionRequired(!playing ? 'play' : !fullscreenAccepted ? 'fullscreen' : '');
    if (!playing) setStatus('แตะปุ่มเล่นเพื่อเริ่มรับชม');
  };
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !item) return undefined;
    const previousCleanup = cleanupDone.current;
    const controller = new AbortController();
    let hls, shakaPlayer, transportPlayer;
    let cancelled = false;
    let cancelReadiness = () => {};
    let lastHttpStatus;
    setStatus('กำลังโหลดคุณภาพสูงสุดจากต้นทาง…');
    setResolution('');
    setActionRequired('');
    const updateResolution = () => {
      if (!cancelled && video.videoWidth) setResolution(video.videoWidth + '×' + video.videoHeight);
    };
    const playing = () => {
      updateResolution();
      if (!cancelled) {
        setStatus('กำลังเล่น');
        setActionRequired(autoFullscreen && !isVideoFullscreen(video) ? 'fullscreen' : '');
      }
    };
    const waiting = () => { if (!cancelled) setStatus('กำลังบัฟเฟอร์คุณภาพสูงสุด…'); };
    video.addEventListener('resize', updateResolution);
    video.addEventListener('loadedmetadata', updateResolution);
    video.addEventListener('playing', playing);
    video.addEventListener('waiting', waiting);

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
          shakaPlayer.addEventListener('error', (event) => fail(event.detail));
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
            hls = new Hls(highestHlsConfig);
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
              if (data.fatal) fail(new Error(data.response?.code ? 'HTTP ' + data.response.code : data.details || data.type));
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
        updateResolution();
        setStatus(video.paused ? 'พร้อมเล่น · คุณภาพสูงสุด' : 'กำลังเล่น');
        startVideoPresentation(video, autoFullscreen).then((result) => { if (!cancelled) applyPresentation(result); });
      }
    }
    setup().catch((error) => {
      cancelReadiness();
      if (cancelled) return;
      hls?.stopLoad();
      transportPlayer?.unload();
      cleanupDone.current = Promise.resolve(shakaPlayer?.unload()).catch(() => {});
      setStatus(playbackErrorMessage(error?.message === 'stream_timeout' && lastHttpStatus ? new Error('HTTP ' + lastHttpStatus) : error));
    });
    return () => {
      cancelled = true;
      controller.abort();
      cancelReadiness();
      video.removeEventListener('resize', updateResolution);
      video.removeEventListener('loadedmetadata', updateResolution);
      video.removeEventListener('playing', playing);
      video.removeEventListener('waiting', waiting);
      hls?.destroy();
      transportPlayer?.destroy();
      cleanupDone.current = cleanupDone.current.then(() => shakaPlayer?.destroy()).catch(() => {});
      video.removeAttribute('src');
      video.load();
    };
  }, [item, autoFullscreen]);
  return <><div className="video-frame"><video ref={videoRef} controls autoPlay playsInline preload="auto" poster={item?.logo || undefined} />{actionRequired && <button className="player-start primary-button" type="button" onClick={() => {
    const video = videoRef.current;
    startVideoPresentation(video, autoFullscreen).then((result) => { if (video.isConnected && videoRef.current === video) applyPresentation(result); });
  }}>{actionRequired === 'fullscreen' ? '⛶ เต็มจอ' : autoFullscreen ? '▶ เล่นเต็มจอ' : '▶ เล่นวิดีโอ'}</button>}</div><div className="player-status"><span className="status-dot" /><span>{status}</span><b className="video-quality" aria-label="คุณภาพวิดีโอ" aria-live="polite">{resolution || 'ต้นฉบับสูงสุด'}</b></div></>;
}
