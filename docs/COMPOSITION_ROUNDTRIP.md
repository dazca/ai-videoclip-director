# A round trip with the composition (ROADMAP_v4 E9)

The first film's HyperFrames composition is read into the workbench one way today
(`importers/azemar_extract_edl.mjs` hooks `WORLD.clip` and writes the uses into `shots.json`). E9 adds the way back.
The workbench exports the director's picks as one data file. A composition reads that file with a small drop-in
script, so a take picked in the page changes the render.

```
page: Storyboard › Shot › takes  ── Pick ──▶  storyboard.json shot.clip
File › Export composition data…  /  MCP composition_export  /  node exporters/composition-data.mjs --project <id>
        ──▶  data/<project>/exports/composition/edl.json
composition: <script src="wb/reader.js"> + WB_EDL.load("wb/edl.json")  ──▶  EDL.use("G05@20158", t) / EDL.at(t)
```

Parts:

- **The export**: `exporters/composition-data.mjs`, with the op in `lib/ops/composition.mjs`.
- **The reader**: `exporters/composition-data/reader.js`.
- **The page command**: `core/compexport.js`.
- **The MCP tool**: `mcp/tools/composition.mjs`.

## edl.json, version 1

`format: "director-workbench/composition-edl"`, `version: 1`. Every time is an integer number of milliseconds of song
time.

```jsonc
{
 "format": "director-workbench/composition-edl", "version": 1, "about": "docs/COMPOSITION_ROUNDTRIP.md …",
 "project": "azemar", "title": "One More Epoch", "storyboard": "v7",        // the storyboard version it was made from
 "units": {"time": "ms"},
 "map": [{"from": "project/gen/out/", "to": "assets/world/"}],              // the file mapping used
 "song": {"duration_ms": 268522, "bpm": 134, "beat_ms": 448, "bar_ms": 1791, "beats_per_bar": 4,
          "first_beat_ms": 0, "first_downbeat_ms": 0,
          "sections": [{"id", "label", "t0", "t1"}], "lines": [{"id", "t0", "t1"}]},   // the timing anchors
 "counts": {"shots", "picked", "placeholders", "private", "unmapped"},
 "shots": [{                                                                 // the current storyboard, in time order
   "id": "sh07", "t0": 20158, "t1": 22800, "scene": "sc03", "kind": "medium", "title": "desk: one more sip",
   "uses": ["G05@20158"],                                                    // the clip uses it covers (shots.json)
   "status": "picked",
   "take": {"file": "assets/world/G05/G05_1.mp4",                            // relative to the composition (mapped)
            "source": "project/gen/out/G05/G05_1.mp4",                       // the workbench media path
            "media": "G05_1", "request": "G05", "take": 1, "kind": "video",  // or "image" (in 0, out null)
            "in_ms": 350, "out_ms": 2990},                                   // inside the take file
   "alt": [{"t": 21500, "take": 0, "file": "assets/world/G05/G05_0.mp4", "source": "…", "note": "bigger smile"}],
   "looks": {"him": "office"},                                               // the look per character (null = identity)
   "variants": {"desk": "dusk"}                                              // the variant per location / prop (null = base)
 }, {
   "id": "sh08", "t0": 22800, "t1": 25200, "status": "placeholder",
   "placeholder": {"reason": "unpicked", "label": "webcam: his face",       // unpicked | private | missing | unmapped
                   "id": "sh08", "kind": "close", "time": "0:22.8–0:25.2", "text": "…", "cast": ["Dani"], "world": "on screen",
                   "svg": "<svg …>…</svg>"},   // E5: the neutral placeholder FRAME the workbench draws (js/placeholder.js), escaped
   "world": "on screen",                                                     // E6: the shot's world (its own, else its scene's), when it has one
   "uses": ["G08@25200"], "looks": {}, "variants": {}
 }],
 "warnings": [],
 "checksum": "sha256:…"
}
```

**Rules:**

- **Deterministic.** The same project state gives the same bytes. There is no clock in the file, the shots are sorted
  by time, and the look and variant keys are sorted. Exporting the same picks again reports `changed: false`.
- **Checksum.** `checksum` is `"sha256:" + hex(sha256(JSON.stringify(doc without "checksum")))`. Key order is the
  file's own order, so parsing the file, deleting `checksum` and re-stringifying it reproduces the hash.
- **Private media is never written.**
  - A picked take is private when the PRIVATE path rule matches it (`private/`, `thumbs/priv_*`, the configured
    `private_media`) or when `media.json` flags it `private: true`. Such a take exports as `placeholder.reason:
    "private"`, with neither its file nor its media id.
  - A private alternative is dropped.
- **Placeholders.**
  - `unpicked`: no take is picked yet.
  - `private`: see the rule above.
  - `missing`: the picked file is no longer in `media.json`.
  - `unmapped`: no map rule covers the file.

  The composition keeps its own fallback for every placeholder: the start still or the "WORLD CLIP PENDING" card.
- **The file mapping.**
  - `map` is a list of `{from, to}` prefix rules, tried longest `from` first. The default is `[{"from": "", "to":
    "assets/"}]`.
  - Both sides must be relative, with no `..`, `.`, drive, backslash or leading slash. Anything else is refused with
    400.
  - The mapping comes from the `map` argument, else `settings.json` `composition.map` (the export dialog remembers
    it there), else `project.json` `composition.map`.
- **Where the export writes.**
  - It writes only `data/<project>/exports/<out>`, by default `composition/edl.json`.
  - `out` must stay inside `exports/`. A path with `..`, `.`, a backslash, a drive or a leading slash is refused,
    and so is a junction that leads outside.
  - It never touches an approval, a pick, a request or any other project file.
  - It works on a project locked for render, because exporting for the render is what the lock is for.
- **Versioning.**
  - A reader refuses a version it does not know.
  - Adding fields keeps version 1.
  - Changing the meaning of a field makes it version 2.

## The reader (`exporters/composition-data/reader.js`)

The reader is ES5 with no dependencies, about 100 lines. It defines `window.WB_EDL`, or `module.exports` in Node.

```html
<script src="wb/reader.js"></script>
<script>var EDL = WB_EDL.load("wb/edl.json");</script>   <!-- synchronous, at build time -->
```

**Lookups:**

| call | what it resolves |
|---|---|
| `EDL.at(t)` | the shot under song time `t`, resolved at `t` |
| `EDL.shot(id, t)` | shot `id`, resolved at `t` |
| `EDL.use("G05@20158", t)` | the shot that covers that clip use, resolved at `t` |
| `EDL.atSeconds(s)` | the same as `EDL.at(s * 1000)` |

**A resolution** has these fields:

- `file` and `kind`.
- `media_ms` / `media_s`: `in_ms + (t − shot.t0)`, clamped to `[in_ms, out_ms)`. For a still it is 0.
- `status`, `placeholder`, `looks`, `variants` and `alt`.

Every lookup is a pure function of the document and `t`. The file is read once at build time, so the render stays
deterministic: a frame shows the same pixels every time.

The round trip is tested by `npm run verify` v22 (`tools/verify-composition.mjs`), which runs these steps:

1. It writes a test composition with HyperFrames markup. The composition includes `reader.js` and renders
   `renderAt(t)` as a pure function of `t`.
2. It picks take A in the page and exports with the page's command.
3. It renders frame N headless, and the pixels are take A at its in-point.
4. It picks take B and exports over MCP.
5. It renders frame N again, and the pixels are take B.
6. It renders the same frame twice and checks that the pixels are identical.

## Proposal: how the first film's composition would adopt it

> A proposal only. Nothing under `project/clip/` has been changed. Dani's film source stays as it is until he asks.

Today `xp/world.js` decides the footage of each use at build time:

- `WORLD.clip(parent, id, {start, end, in, take, …})` plays `assets/world/<id>/<id>_<take>.mp4` from `in`.
- `take` and `in` are written by hand in `ch1.js` … `ch5.js`. Examples:
  - `Wd.clip(L, "G02", { start: bar(5), end: 12.548, in: 0.865 })`
  - `Wd.clip(vv, "G04", { take: 1, start: bar(10), … in: 2.9 })`

The workbench imported exactly these uses as `shots.json` `uses` with the ids `"<id>@<start ms>"`
(`importers/azemar_import.py`). The patch makes `clip()` ask the EDL first and keeps today's values as the fallback.

**1. Export, once per change of picks.** In the workbench, use File › Export composition data… with this map:

```
project/gen/out/ => assets/world/
```

The map is remembered. Then copy or link `data/azemar/exports/composition/edl.json` to
`project/clip/wb/edl.json`, next to a copy of `reader.js` at `project/clip/wb/reader.js`. A junction like the
existing `assets/world` one keeps it live.

**2. `index.html`** (and the `AZ:HEAD` block that `tools/make-cut.mjs` copies into cut pages). Add two scripts
before `xp/world.js`:

```html
<script src="wb/reader.js"></script>
<script>try { window.AZ_EDL = WB_EDL.load("wb/edl.json"); } catch (e) { window.AZ_EDL = null; }  // no file: today's behaviour</script>
```

**3. `xp/world.js` `clip(parent, id, o)`.** These are the only lines that change, at the top of the function:

```js
// the director's pick for this use (workbench edl.json), if any: take file + in-point at this use's start
var key = id + "@" + Math.round(o.start * 1000);
var pick = window.AZ_EDL ? window.AZ_EDL.use(key, o.start * 1000) : null;
var src = clipUrl(id, o.take);                                 // today's file
if (pick && pick.status === "picked" && pick.kind === "video" && sameClip(pick, id)) {
  src = pick.file;                                             // e.g. assets/world/G05/G05_1.mp4
  o = Object.assign({}, o, { in: pick.media_s,                 // in_ms + (use start - shot t0)
                             len: pick.out_ms != null ? pick.out_ms / 1000 : undefined });
}
// sameClip(pick, id): the picked file is a take of the same clip ("/G05/" in pick.file). A shot whose uses mix
// clips (G02 bathroom + the mirror tile) changes only the uses of the picked clip; the others keep their code.
```

Then make three replacements in the function:

- `has(id, o.take)` becomes `exists(src)`.
- `v.setAttribute("src", base() + clipUrl(id, o.take))` becomes `v.setAttribute("src", base() + src)`.
- The placeholder card's `o.label` becomes `pick && pick.placeholder ? pick.placeholder.label : o.label`.

Nothing else moves:

- `worldClip()` still maps song time to clip time from `o.in`, so the frame is still a pure function of `t`.
- The still and card fallbacks still cover every placeholder.

**How the calls map:**

| world.js today | with the EDL |
|---|---|
| `WORLD.clip(L, "G01", {start: 1.04, end: bar(5), in: 0, …})` | `AZ_EDL.use("G01@1040", 1040)`: the take file and in-point the director picked for the shot that covers 1.04 s |
| `{take: 1, …}` (G04 steam) | the picked take's file (`G04_<n>.mp4`); `take` stays only as the fallback |
| `in: 0.865` (G02 bath) | `pick.media_s`: the pick's `in_ms` plus the offset of this use inside the shot |
| a use with no pick (`placeholder.reason: "unpicked"`) | today's `take` / `in`, unchanged |
| a private pick (`reason: "private"`) | today's values. The private file is never in the EDL, so it cannot reach a render or an export |

**Decisions for Dani, before applying it:**

1. Should a pick's in-point override the hand-tuned `in:` of a use? The proposal says yes for uses of the picked
   clip. The alternative is "file only, keep `in:`".
2. Should edl.json be linked live (a junction to the workbench's exports folder) or copied by hand per render?
3. Should a missing or invalid edl.json fail the render, or fall back silently to today's code? The proposal falls
   back silently, and `window.AZ_EDL` stays null.

## E3 / E5 / E6 additions (still version 1: new optional fields only)

- `chapters` (top level): `[{id, name, scenes, t0, t1, owner, file, status, shots, picked, placeholders}]`, the chapters of the
  storyboard with their build status DERIVED from the picks and approvals (planned / generating / built / approved). A chapter is
  "built" when no shot of it renders as a placeholder.
- `placeholder.svg` (and `id`, `kind`, `time`, `text`, `cast`, `world`) on every placeholder row: the neutral 16:9 frame with the
  shot's id that the workbench draws on its cards and timeline. It is made from the shot's own text only, so a private take never
  leaks through it. The reader exposes it as `placeholder_src` (a `data:` URI for `<img src>`), so a chapter can be built before
  its footage lands and picks the take up when it does.
- `world` on a shot row (its own world, else its scene's), and `looks` resolved through it: a cast character wears the look tagged
  with the shot's world unless the shot overrides it.
