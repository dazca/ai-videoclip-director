# Aspect ratio: playing a 16:9 film in any window

The HTML package plays the composition itself, so in principle it can do what an MP4 cannot: lay itself out for
the window it is in. This note covers what the player can do on its own today, what a composition would need to
be really aspect-independent, what that means for *azemar.exe*, and a recommendation.

## 1. What the player does on its own (done, `interactive.html`)

| mode | what you see | cost |
|---|---|---|
| `fit` (default) | the whole 1280x720 film, uniform scale, black bars (letterbox or pillarbox) | nothing is lost; bars on any non-16:9 window |
| `fill` | uniform scale up to cover the window, overflow cropped, centred or around `?focus=x,y` | no bars; crops 25% of a 4:3 window's width, 68% of a 9:16 phone's width, 25% of a 21:9 window's height |
| `stretch` | not offered: it distorts the picture | |

`A` switches between them and the choice is remembered. Both are one transform on the iframe (`translate + scale`),
so hit-testing, hover, lifting, paused selection and double-click go through the same mapping (tested at 1280x720,
1080x1920, 2560x1080, 1024x768 by `verify-interactive.mjs`).

The limit of the player alone: it can only scale and crop a fixed 16:9 picture. It cannot know that the wallpaper
could go on, that the taskbar belongs to the bottom edge, or that a portrait phone should see the window the
cursor is working in rather than the centre of the screen. A static focus point helps a little; a per-shot focus
(below, B1) helps much more and is still cheap.

## 2. Truly aspect-independent: safe area + bleed ("extend")

The model used by games and broadcast graphics (Unity's "expand" canvas, Godot's `expand` stretch aspect, TV
title-safe areas, iOS safe-area insets):

- **Safe area**: the authored 16:9 rectangle (here 1280x720). Everything the story needs (lyrics, the window the
  cursor works in, the dancer) is inside it and is always visible, in every ratio.
- **Bleed**: whatever lies around the safe area. On a wider or taller window the viewport grows past the safe area
  and the composition fills the extra room with content that makes sense there: more wallpaper, more sky, the
  taskbar stretching to the real edge, desktop icons at the real left edge, footage cover-cropped to the new box.
- The scale is chosen so the safe area fits (`min`), then the viewport is extended to the window's ratio. Nothing is
  ever cropped out of the safe area and nothing is stretched. A limit (for example up to 21:9 and down to 9:16) can
  fall back to bars beyond it.

### Authoring rules a composition would need

1. **A viewport API that stays deterministic.** The composition reads its frame size from one place, for example
   `data-viewport="1280x720"` on the root, or `window.__hfViewport = {w, h, safe: {x, y, w, h}}`, set before mount
   and *never* from `innerWidth` / `matchMedia` directly. The renderer passes it explicitly (one render per target
   ratio: 16:9, 9:16, 1:1, 21:9), so a frame is still a pure function of `(t, viewport)` and renders reproduce
   byte-for-byte. The player passes the live window size and re-lays out on resize (between frames, never during
   a capture).
2. **Two layers of geometry.** Story content is positioned in safe-area coordinates (as now). Edge furniture is
   anchored to viewport edges: `left: 0; right: 0; bottom: 0` for a taskbar, `left: 0` for icon columns,
   `inset: 0` for wallpaper. CSS does this for free when the containers are sized by the viewport.
3. **Relative units where things should grow.** `vw/vh` or container query units (`cqw/cqh`) inside a container that
   *is* the viewport, never `px` widths that assume 1280.
4. **Cover-cropped media with focus points.** Wallpaper and world footage use `object-fit: cover` (or the engine's
   own cover math) with a per-asset or per-shot focus point (`object-position: 30% 40%`), so a portrait crop keeps
   the face, a wide crop keeps the horizon.
5. **Camera in safe-area terms.** A camera that frames "the chart window" says so (a target rect in safe-area
   coordinates); the engine computes the zoom and offset for the actual viewport, and can show more around it
   instead of zooming in.
6. **Bleed content exists.** Wallpaper images, skies and footage have to be big enough (a 9:16 extension of a 16:9
   frame needs 3.2x the height of the safe area at the same width), or the bleed is filled with an extended / blurred /
   tiled version. Generated footage can be regenerated or outpainted at a taller ratio.
7. **Test matrix**: each target ratio rendered and compared, and the player checked at odd sizes.

HyperFrames today has a fixed `data-width` / `data-height` per composition and renders that box; there is no
viewport parameter in the runtime. Rule 1 would be a convention on top (a global the composition reads, set by
the page before it loads), plus a renderer option to set it per render.

## 3. This film (*azemar.exe*)

How it is built: `#frame` 1280x720 holds `#screen`, a fixed **960x540** desktop in "screen px". The engine
(`xp/engine.js`) shows it through a camera: `zoom = z * 2/3` and `left/top = -cam`, with 47 camera key lists over
46 shots in `xp/ch1..5.js`; `aim()` clamps the camera to the 960x540 screen. Every window, icon, sprite and lyric
surface is placed in absolute screen px (`U.at`, `U.win`, ~120 placements). The wallpaper is `background-size:
cover` and the taskbar is `left: 0; right: 0; bottom: 0` inside `#screen`, which is the good news: those two would
extend by themselves if `#screen` were wider or taller. The world footage is drawn with the engine's own cover math
(`world.js cover(bw, bh, z, fx, fy)`), already focus-point based.

What "extend" would take here:

| step | what | effort |
|---|---|---|
| B1 | **Per-shot focus for the player's `fill`** (no composition change): read the current camera (`XPE.find(t)` and the camera rect) and the shot's important rect (the active window, the dancer box), and pan the crop to keep it inside the window, eased. The engine already exposes the shot list, so this is player-only code plus an optional `focus` field per shot. Makes portrait `fill` usable. | 1 to 2 days |
| B2 | **Screen that grows with the viewport**: `SW/SH` from the viewport instead of 960x540 (for example 960 x 540·k for a taller window, 960·k x 540 for a wider one), `#screen` sized from them; wallpaper and taskbar extend for free; desktop icons and tray anchor to edges; `aim()` clamps to the new screen. The safe area is the old 960x540 box, centred. | 2 to 3 days |
| B3 | **Shot-by-shot pass**: 46 shots place windows in absolute px; most can stay in the safe area, but full-screen gags (maximised windows, the giant title bar, the pip grid, the formation of windows, the world-as-window shots) must be anchored to the screen edges or re-laid out for portrait. Cameras that frame the full screen (`z = 2`) need a "frame this rect" form. | 1 to 2 weeks |
| B4 | **Bleed material**: the wallpaper and the world stills/clips at taller/wider ratios (outpaint or regenerate), checking every shot in 9:16 and 21:9. | 2 to 5 days plus generation cost (needs an approved request) |
| B5 | **Renderer + tests**: viewport per render, a 9:16 and a 21:9 render, `verify.mjs` per ratio, the lyric gate per ratio. | 2 to 3 days |

Total for a real "extend" version: roughly **3 to 4 weeks**, most of it B3, and it touches the approved film, so
every shot would need the director's review again.

What the player alone can and cannot do:

- Player only: fit, fill, a fixed focus point (done); a per-shot / per-camera focus that follows the action (B1);
  a blurred or mirrored wallpaper-coloured fill instead of black bars in `fit` (cosmetic, half a day).
- Needs composition changes: anything that shows *more* of the desktop than the authored 16:9 (B2-B5).

## Recommendation

1. Ship `fit` as the default and `fill` as the option (done): correct in every ratio, no distortion, nothing to
   re-approve.
2. Next, B1 (per-shot focus for `fill`, player-only, about 2 days): it fixes portrait phones, the case where a
   centred crop loses the most.
3. Do the full safe-area + bleed rewrite (B2-B5) only if a vertical or ultrawide version becomes a real deliverable;
   in that case author the next film with the viewport API from the start (rules 1-7) instead of retrofitting
   this one.
