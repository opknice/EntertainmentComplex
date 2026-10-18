# Playback and video fullscreen

Selecting a movie, live TV, sports or OTT card mounts the video synchronously
inside the user's click, then requests playback and fullscreen on that video
element and its `[data-player-surface]` container. Fullscreen includes the custom
controls and gesture layer, not the whole web page. It does not change the catalog URL.
OTT details may load afterwards without replacing the video element.

The player retries presentation when media is ready. If the browser denies
autoplay or fullscreen, visible play/fullscreen controls allow a new user tap.
This does not bypass browser permissions. Safari's native video fullscreen API
is attempted only after metadata is available.

Closing the player cancels the selection, releases pending playback even before
OTT details arrive, and ignores late responses. Exiting video fullscreen returns
to the original catalog. Fullscreen belonging to another element is not closed.
Highest-source-quality selection is unchanged.

## Custom controls and gestures

- One tap shows/hides controls; controls hide after three idle seconds during
  playback. Paused, failed, focused and settings states keep controls visible.
- Double-tap the left/right zones to seek -10/+10 seconds. Subsequent taps within
  300 ms accumulate feedback. Swipes, canceled pointers, second fingers and taps
  on actual controls do not count as seek taps.
- Vertical swipe on the left adjusts media volume only when a read-back probe
  confirms it is writable. Unsupported devices show a hardware-button notice.
  This is not the device's master volume. Muting remains a separate control.
- Vertical swipe on the right changes the video's CSS brightness (25–175%,
  default 100%). It does not change OS display brightness or source resolution.
- Timeline, skip buttons, mute/volume, brightness, playback speed for VOD,
  touch lock/unlock, fullscreen and a source-resolution indicator have visible
  controls. Settings explain device restrictions and gestures.
- Seeking uses actual `seekable` ranges, including gaps. Live streams without
  a seekable window disable seeking. DVR streams provide a return-to-live button.
- Player-scoped shortcuts: Space/K play/pause; arrows or J/L seek; up/down volume;
  M mute; F fullscreen. Native input/button behavior and browser modifier shortcuts
  are not intercepted. Dialog focus is contained and returns to the selected card.
- Native iPhone video fullscreen replaces web UI with system controls; custom
  gestures cannot be promised in that mode. Unsupported element fullscreen keeps
  the web player usable, with native presentation as a fallback where supported.

## Continue watching on this browser

- Movies and OTT VOD use stable section/item IDs as localStorage keys. Saved
  records contain position, duration and timestamp, never stream URLs or tokens.
  Live TV, sports and OTT live channels do not store or restore positions.
- Reopening a partially watched title offers **continue from the saved time** or
  **restart** before playback/audio starts. Closing that dialog preserves the old
  position. A choice made while the source loads waits for readiness.
- An active viewing session saves at most every five seconds during playback,
  plus pause, seek completion, hidden page, pagehide and player cleanup. Completion,
  restart or returning to the first second clears that title's position only.
- Continue requires the saved position to be in the current source's seekable
  ranges and duration. An unavailable position gives an explicit error and leaves
  restart available; source-loading errors remain visible without erasing history.
- Storage denial/quota errors do not block viewing; a visible warning explains
  that the browser cannot save progress. Invalid stored data is ignored.
- History belongs to this website origin in this browser profile, not an account
  or device-wide database. Clearing site data removes it; private browsing may not
  retain it. Local and production origins, different browsers and different devices
  do not share history. Sudden termination can lose the latest few seconds.
- On native-only fullscreen devices the web resume dialog remains inline until
  a choice is made, since system video fullscreen would hide that dialog.

## Verification (2026-10-18)

- 45 Node tests passed, including progress isolation, invalid/restricted storage,
  restart/rewind cleanup, resume playback gating, gesture ordering, ranges/gaps, seek limits,
  double-tap accumulation, swipe axes/bounds, restricted volume, blocked APIs,
  prefixed APIs, Safari metadata gating and fullscreen-container ownership.
- Chrome browser tests used actual generated H.264/AAC media in MP4, HLS, DASH,
  MKV, MPEG-TS and FLV. All autoplayed and reported the player surface (including
  controls) as the fullscreen element, decoding 1920x1080 frames. No autoplay-policy bypass flag
  was used.
- Live TV and sports card paths, OTT details delayed six seconds, cancellation
  during OTT loading and one-tap recovery under simulated policy rejection were
  tested separately.
- Chrome and Edge browser tests cover mouse and emulated touch double-taps,
  vertical swipes, brightness, volume, touch lock, timeline/keyboard seeks,
  settings, automatic control hiding and close. Layout/hit testing covers
  320x568, 390x844, 600x884, 844x390, 1093x884 and 1920x1080 viewports.
- Simulated no-element-fullscreen and read-only-volume devices verify truthful
  fallback notices, usable controls, dialog focus containment and focus return.
- Chrome and Edge tested persistence across closing/reloading, paused resume
  prompts, dismissal, continue, restart, pagehide, completion, storage denial and
  mobile portrait/landscape layouts. Chrome additionally decoded MP4, HLS, DASH,
  MKV, MPEG-TS and FLV after restoring a saved position, tested choosing before
  source readiness, unavailable seek ranges, source failure and delayed OTT VOD/live
  classification. Fixtures are generated test media, not proof of every upstream.
- Safari-specific APIs have unit-double coverage, not physical iPhone/iPad
  verification. These checks do not establish playback for every source or codec.

Run the source regressions with:

```sh
node --test src/playback-progress.test.js src/player-controls.test.js src/player-presentation.test.js src/playback.test.js scripts/ott-catalog.test.mjs worker/playback.test.mjs
npm run build
```

Relevant platform requirements:
[fullscreen activation](https://developer.mozilla.org/en-US/docs/Web/API/Element/requestFullscreen),
[playback permission](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/play),
[Safari video fullscreen](https://developer.apple.com/documentation/webkitjs/htmlvideoelement/1628805-webkitsupportsfullscreen).
