# Playback and video fullscreen

Selecting a movie, live TV, sports or OTT card mounts the video synchronously
inside the user's click, then requests playback and fullscreen on that video
element. It does not fullscreen the entire web page or change the catalog URL.
OTT details may load afterwards without replacing the video element.

The player retries presentation when media is ready. If the browser denies
autoplay or fullscreen, a visible play/fullscreen button allows a new user tap.
This does not bypass browser permissions. Safari's native video fullscreen API
is attempted only after metadata is available.

Closing the player cancels the selection, releases pending playback even before
OTT details arrive, and ignores late responses. Exiting video fullscreen returns
to the original catalog. Fullscreen belonging to another element is not closed.
Highest-source-quality selection is unchanged.

## Verification (2026-10-18)

- 29 Node tests passed, including gesture ordering, blocked APIs, prefixed APIs,
  Safari metadata gating and fullscreen ownership.
- Chrome browser tests used actual generated H.264/AAC media in MP4, HLS, DASH,
  MKV, MPEG-TS and FLV. All autoplayed and reported the video itself as the
  fullscreen element, decoding 1920x1080 frames. No autoplay-policy bypass flag
  was used.
- Live TV and sports card paths, OTT details delayed six seconds, cancellation
  during OTT loading and one-tap recovery under simulated policy rejection were
  tested separately.
- Safari-specific APIs have unit-double coverage, not physical iPhone/iPad
  verification. These checks do not establish playback for every source or codec.

Relevant platform requirements:
[fullscreen activation](https://developer.mozilla.org/en-US/docs/Web/API/Element/requestFullscreen),
[playback permission](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/play),
[Safari video fullscreen](https://developer.apple.com/documentation/webkitjs/htmlvideoelement/1628805-webkitsupportsfullscreen).
