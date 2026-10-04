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

`outDir` is cleared only if it is empty or holds a previous export (it checks `manifest.json`).

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
on integrity, request or external-request failures.

## Next step (not here): compression

`manifest.json` holds what a per-file decision needs: codec, size, bitrate, resolution, alpha, and the media ranges
actually played. A compressor (HandBrakeCLI / ffmpeg presets, image re-encoding) writes a new package and a new
manifest. It must keep paths, durations and timing (or update the references), keep stacked-alpha layouts intact,
and then run `verify.mjs` again against the same render.
