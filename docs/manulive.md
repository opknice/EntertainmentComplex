# Manu Live TV page

Open `/manulive` in the TV browser. The page starts the configured channel;
if the browser blocks autoplay, press the large Play button once.
The player is a separate classic-script bundle compiled for Chromium 56,
without loading the main React application or the full OTT catalog into the TV.
Samsung NU7100 is a 2018 model; actual playback on the physical TV still needs
verification by its owner. Browser simulation does not establish TV codec support.

## Move the main channel without changing the URL

Edit `public/manulive.json` and deploy:

```json
{
  "section": "ott",
  "group": "sport all",
  "title": "MonoMax | sp 5"
}
```

`section` supports `ott`, `live`, or `sports`. The group and title match the
current catalog exactly. Set group to an empty string for all live/sports items.
The resolver uses the latest catalog generation and signed stream rather than
retaining an old channel ID or stream URL. The TV checks this mapping every minute.
Changing the central mapping clears an outdated device override automatically.

The page's **เปลี่ยนช่อง** button selects another channel in the configured group
and remembers that choice on this device only. **กลับช่องหลัก** restores the
central setting. This does not change other TVs or the central configuration.
Missing channels show the chooser instead of silently substituting another feed.

HLS plays at the highest advertised quality with bounded reconnection. Native HLS
is used if MediaSource playback is unavailable and the browser advertises HLS
support; its master playlist is resolved to the highest variant first.
The endpoint and client do not accept arbitrary external stream URLs.
