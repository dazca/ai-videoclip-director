# HyperFrames HTML package exporter

Packages a [HyperFrames](https://github.com/heygen-com/hyperframes) composition **as itself**: the same HTML, CSS,
JS, fonts, images, videos and audio, byte for byte, in the same relative layout, plus the official
`<hyperframes-player>` to play it. It plays like the MP4 render because it is the same composition the renderer
captures. Nothing is trimmed, re-encoded, re-timed or wrapped in a custom loader. Making it smaller is a separate,
later step that reads `manifest.json`.

Works on any composition folder (not tied to one project). Needs Node 22+, `ffmpeg`/`ffprobe` on PATH, and a
Chrome with H.264/AAC: `$CHROME_PATH`, else the Chrome for Testing that puppeteer/HyperFrames keep in
`~/.cache/puppeteer`, else `tools/chrome.mjs`. `puppeteer-core` comes from the workbench's `npm install`.

```
node exporters/hyperframes-html/export.mjs <compositionDir> <outDir> [--entry index.html] [--sample-fps 10]
node exporters/hyperframes-html/verify.mjs <outDir> --against <render.mp4> [--n 12 | --times 4,18.5] [--play 6]
node exporters/hyperframes-html/serve.mjs  <outDir> [port]      # any static server with byte ranges works
node exporters/hyperframes-html/export.mjs <compositionDir> <outDir> --interactive [--project <workbench project dir>]
node exporters/hyperframes-html/interactive/build.mjs <outDir> [--project <dir>]   # add the layer to an existing package
node exporters/hyperframes-html/interactive/verify-interactive.mjs <outDir>        # headless test of the layer
```

## What `export.mjs` does

1. **Collects every file the composition uses**:
   - static references: HTML `src`/`href`/`poster`/`srcset`/`data-composition-src`, `url()` and `@import` in inline
     and linked CSS, and string literals in the loaded scripts that name an existing file;
   - runtime requests: it serves the composition, opens it headless through the player, seeks the whole timeline at
     `--sample-fps` and plays a few seconds, recording every request (including media that scripts create at mount).
   Junctions and symlinks are followed: the real file is copied.
2. **Copies them unchanged** to `outDir/composition/` (the sha256 of every copy is checked against the source).
   The only rewrite it may make in the composition is a root-absolute path (`"/assets/x.png"`) turned relative,
   because the package nests the composition one folder down. Every rewrite is listed in `manifest.json` and printed.
3. **Adds the player**: `outDir/index.html` is the official player, full window, with its own controls and nothing
   else. The player and the runtime are vendored in `outDir/_hyperframes/` from the composition's
   `node_modules/hyperframes/dist` (or `--hyperframes <dist dir>`, or `--hf-version x.y.z` to fetch them from jsDelivr).
   The player normally injects the runtime from a jsDelivr URL. That one constant in the vendored player is pointed at
   the vendored runtime, so nothing loads from a CDN. That is the one change to a file, and it is in the player, not in
   the composition. The player injects the runtime only when a composition needs it (for example nested
   `data-composition-src`). Otherwise it drives `window.__timelines` directly.
4. **Writes `manifest.json`**:
   - `composition`: entry, title, id, width, height, duration, fps (when the runtime reports it);
   - `assets[]`: `path, kind, bytes, sha256, mime, found_by[]` (static / runtime-request / dom), `referenced_by`, and
     for media (ffprobe): `codec, profile, width, height, fps, pix_fmt, has_alpha, duration, bitrate, video_bitrate,
     frames, audio_codec, sample_rate, channels, has_audio`;
   - `usage` per asset, measured in the headless pass:
     - `visible` / `audible`: timeline ranges in seconds;
     - `segments[{t0, t1, m0, m1}]`: timeline range mapped to the media time played;
     - `media_ranges` and `media_used_fraction`: what a trim step could keep;
     - `element_classes` / `element_filters`: for example an SVG filter that decodes a stacked-alpha video, which a
       compressor must preserve;
   - `totals` by kind, `rewrites`, `missing_in_source` (files the composition probes that do not exist in the source
     either), `external` URLs (not packaged), and `fonts`. `fonts` lists the `@font-face` families (file or `local()`
     only), the font stacks of on-screen text, and `system_fonts`: text that depends on fonts installed on the viewer's
     machine, as it depended on the render machine's.

`outDir` is cleared only if it is empty or holds a previous export (it checks `manifest.json`), and never when the
composition folder is inside it.

**PRIVATE files are never packaged.** If the composition uses a file matching the workbench PRIVATE rule
(`thumbs/priv_*`, any `private/` folder, the configured `private_media` regex, tested on the path as the composition
names it and base-relative after following junctions) or, with `--project <workbench project dir>`, a file flagged
private in that project's `media.json`, the export stops with exit code 3 and writes nothing: the composition would
still reference it. The interactive layer drops private clip/start-image paths from `interactive.project.json` too.

## What `verify.mjs` checks

1. Integrity: every manifest asset is present with its sha256.
2. Load: player `ready` and `assetsReady`, and whether the runtime was injected.
3. Frames: seeks the player (`player.seek`) to N frame times of the render and waits until on-screen videos have
   decoded. It removes the `controls` attribute so the bar is not in the picture, screenshots at the composition size
   (the player shows it 1:1), and compares with the render's frame: mean absolute difference (% of 255) and PSNR.
   The target is the render's own encoding noise, about 30 dB PSNR for `-q standard` H.264.
4. Playback: `player.play()` for `--play` seconds, and the clock must advance.
5. Requests: no HTTP or network failure (except the probes listed in `missing_in_source`), no request leaving the
   server, no page errors.

Report: `<outDir>-verify/verify.json` plus `cmp-<t>.jpg` (package | render) for each time. The exit code is non-zero
on integrity, request, external-request or page-error failures, on media still decoding at a capture, and on a frame
above `--max-mad` (% of 255, default 5) or below `--min-psnr` (dB, default 20).

## Interactive layer (`--interactive`)

Adds `interactive.html`, `interactive.js`, `interactive.css` (and `interactive.project.json` with `--project`) next to
`index.html`, which stays the plain player. Nothing under `composition/` or `_hyperframes/` changes, and
`manifest.json` is written exactly as without the flag. Open `http://<server>/interactive.html`: it must be served
(same origin), `file://` cannot reach into the film.

The film runs in a same-origin iframe in its own standalone mode (`composition/<entry>?standalone=1`, the master
`<audio>` is the clock), scaled to the window. The layer lives in the parent page and only reads the film's document:
`elementsFromPoint`, computed styles and boxes, node clones, video/canvas frames. Compositions without a standalone
driver (no `standalone` in their scripts) are driven by the layer: their `__timelines` entry is seeked to the audio
time each frame and `video[data-start]` elements are kept in step.

| while playing | |
|---|---|
| hover | thin outline + label of the thing under the pointer: text, window, dialog, image, video, dancer, button, graphic, element |
| click | lifts it into a card; the film keeps running |
| click outside the cards | sends the unpinned cards back (lifts nothing) |
| Ctrl/Cmd+click | lifts and keeps the other cards |
| Shift+click | lifts the enclosing window/dialog instead of the text/image inside |
| Alt+click | pause |

Cards: text = real text with its computed styling (select, copy); window/dialog/button/element = a DOM clone frozen
at that instant with every computed style inlined (text inside selectable, videos/canvases inside drawn as frames);
image = the full-resolution source (Ctrl+wheel zoom, drag out or "save"); video clip = the current frame (save as
PNG) + a small looping player of the clip file; dancer = its animation looping (sprite sheets step on the film's beat
grid when `window.KIT` exists; stacked-alpha clips are decoded into a transparent canvas). Each card shows the song
time, the scene (`[data-shot]`), the element, the source file with its manifest facts, and, with `--project`, the
workbench shot (title, cast, locations, note), clip use, lyric line, script line and nearby notes. Cards drag by the
header, resize at the corner, zoom with Ctrl+wheel or `- 100% +`, pin (or double-click the header). Closing (Esc, x,
click outside) removes the card. Nothing animates: cards, outlines and the HUD appear and disappear at once.

Paused (Space, the HUD button or Alt+click): the film's document takes the pointer, so everything is natively
selectable / copyable, images drag out, right-click is the browser's own; double-click lifts. The film's own
click-to-toggle (standalone mode) is stopped by a capture listener while paused. Space resumes from the paused ms
(the audio clock is paused, not seeked) and clears the selection.

Clean screen: the HUD (bottom-left: play/pause, time, scrubber, `live` = back to where the film would be now had you
not scrubbed, hint) is hidden until the pointer reaches the bottom 48 px, or for 1.5 s after Space / an arrow; it
hides 1.2 s after the pointer leaves that zone. Outlines show only while the pointer moves (hidden after 1.5 s
still). The "click anything" hint goes away after the first lift. The system pointer is always visible: the film
hides it for its drawn XP cursor (`#screen {cursor: none}`), so the layer injects a style into the film document
(not into any file) that restores it (I-beam on text while paused, a hand over liftable things).

Keys: Space, Esc, Left/Right seek 5 s, I outlines, **H** HUD auto / always / never, **L** a 2 px progress line while
the HUD is hidden (off by default), **A** aspect fit / fill. H, L and A are remembered per viewer (localStorage).
Aspect: `fit` shows the whole film letterboxed; `fill` covers any window shape with one uniform scale and crops the
overflow, centred, or around `interactive.html?focus=x,y` (0..1). Never stretched. Hit-testing, lifting, pausing and
selection map through the same transform in both. See `ASPECT.md` for a composition that really adapts to the window.

`verify-interactive.mjs` checks the clean screen (HUD hidden by default, bottom-edge show/hide, keys, no
transitions, the pointer never `none`), plays, lifts a text, a window, an image, a video clip, a sprite dancer and a stacked-alpha
dancer while playing (hover, click, content, drag, Ctrl+wheel, select, Esc), compares the audio-clock progress over
6 s with a plain-playback baseline (within 50 ms, no stalls or jumps), then checks paused selection, double-click
lift and resume from the paused ms, and finally fit / fill at 1280x720, 1080x1920, 2560x1080 and 1024x768 (geometry,
hover, click lift, paused double-click lift on the same thing; `aspect-<w>x<h>-<mode>.png` with a card lifted). Screenshots and `verify-interactive.json` go to `<outDir>-verify/interactive/`.

Limits: needs http (same origin); `--project` packages the project's shot titles, cast names, script and notes text
(private file paths are dropped); clones show computed styles, so CSS animations inside them are frozen and
cross-origin images (none in a package) would not draw.

## Next step (not here): compression

`manifest.json` holds what a per-file decision needs: codec, size, bitrate, resolution, alpha, and the media ranges
actually played. A compressor (HandBrakeCLI / ffmpeg presets, image re-encoding) writes a new package and a new
manifest. It must keep paths, durations and timing (or update the references), keep stacked-alpha layouts intact,
and then run `verify.mjs` again against the same render.
