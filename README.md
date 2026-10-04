# Director workbench (v2: commands, menus, projects; media, preview dock, characterization)

A vertical, time-synced, multi-column view of a music video: time runs top to bottom, every column shares one
time axis `y(t)`, and that axis is warped so wrapped text (lyrics, script, notes, events) pushes the audio lanes down
with it. A given millisecond sits on the same pixel row in every column. No build step, no framework.

## Run

Node 20+; ffmpeg / ffprobe on PATH for importing songs and making thumbnails.

```
npm install                      # @modelcontextprotocol/sdk + zod; puppeteer-core for the tests
npm start                        # node serve.mjs -> http://localhost:8140/   (port: first argument)
```

The page opens the default project (`$WB_PROJECT`, else `default_project` in `workbench.config.json`, else `demo`);
any other with `?project=<id>`. **Try it**: `data/demo/` is a 20 s synthetic project (tone track, test-pattern
render, fractal "clips", placeholder characters; all made by `tools/make_demo.mjs` with ffmpeg, CC0).

**Your own song**:

```
node importers/new_project.mjs my-song --song path/to/song.mp3 --lyrics path/to/lyrics.lrc --title "My Song" --bpm 96 --offset 120 --cap 25
```

Copies the song into the project, computes the waveform peaks and energy curve, the beat grid (bpm, first downbeat at
`--offset` ms) and sections + lines from the lyrics (`[mm:ss.xx]` LRC timings are used; plain text is spread evenly and
marked `timing: "estimated"`; `[Verse 1]` headers or blank lines start sections). Shots, entities, script and notes
start empty: fill them with your agent (below). `data/_template/` is the empty project that File > New copies.

**Settings of this machine** (optional, gitignored): copy `workbench.config.example.json` to `workbench.config.json`:
`default_project`, `data_dir`, `media_base` + `media_roots` (folders outside the project served read-only at
`/media/<path>`, e.g. a renders folder), `private_media` (regex of PRIVATE paths: local only, never exported).

**Tests**: `npm run test:mcp` (MCP end to end on the demo) · `npm run verify` (headless UI suite on the demo:
screenshots + alignment + perf + writes + commands -> `shots/`; `node tools/verify.mjs --project <id>` for another).

**Example importer**: `importers/azemar_import.py` + `importers/azemar_extract_edl.mjs` built the owner's own production
(word-aligned lyrics, an EDL extracted from the render page, entities with looks, a 230-file media index). They only run
next to that production's folders (`AZEMAR_BASE`), and are kept as a worked example of the file formats at full size.

## Connect Claude

The workbench ships an MCP server (`mcp/server.mjs`, stdio) so any Claude session can read and drive a project: the
song, the timeline, shots, characters / looks / locations / props, media, notes, approvals, the generation queue and
the cost cap, snapshots, and the open page itself (`ui_focus`). In Claude Code:

```
claude mcp add workbench -- node /absolute/path/to/workbench/mcp/server.mjs
claude mcp add workbench -e WORKBENCH_PROJECT=demo -- node /absolute/path/to/workbench/mcp/server.mjs   # start on a project
```

or put the JSON form of `.mcp.json.example` in the project's `.mcp.json` (or `claude mcp add-json`). Then start the
workbench (`npm start`), open the page, and in Claude: *"use the director-session prompt"* or just *"what's open in
the workbench?"*. With the server running every tool goes through its HTTP API (`WORKBENCH_URL`, default
`http://localhost:8140`) and the page updates live; without it the tools read and write the files directly
(`WORKBENCH_DATA`, default `./data`), only `ui_focus` needs the page.

Tools: `status`, `projects` (list/create/duplicate/open), `snapshot_save` / `snapshot_list` / `snapshot_restore`, `song_get`,
`timeline_query`, `shots_list` / `shot_get` / `shot_update`, `entities_list` / `entity_get` / `entity_upsert`, `media_list` /
`media_add`, `notes_list` / `note_add` / `note_resolve`, `approvals_get` / `approve` / `request_changes`, `requests_list` /
`request_create` / `request_update`, `costs_get`, `ui_focus`. Resources: the README, `CLAUDE.md`, the file formats, the
skill, and each project's JSON files. Prompt: `director-session`. Rules the tools enforce: an agent cannot approve on
its own, a request runs only after the director approved it, queueing is refused above the cost cap, and `done` needs
the output files and the actual cost (recorded in `costs.json`, outputs indexed as media). The agent guide is
`CLAUDE.md`; the Claude Code skill `.claude/skills/director-workbench/` loads automatically when you open this folder.

## Using it

- **Top bar** (18 px; `` ` `` hides / shows it; **Esc never hides it**: Esc only closes menus, dialogs, the palette and
  the cheat sheet): menu bar (File Edit View Timeline Generate Window Help; F10 opens it from the keyboard), the
  **page tabs**, project name, transport, `⌘` = command palette, `⌃` = hide the bar, `⚙` = Settings (far right).
  **Hidden bar**: a 12 px `⌄` in the top-right corner (faint until hovered, above everything) brings it back; so do
  `` ` ``, F10, right-click on empty space > Show top bar, and the palette ("Show top bar"). **Hidden column header**
  (Alt+H cycles full / thin / hidden): a 12 px `⌄` at the top edge of the time ruler restores it; also right-click >
  Show column header, View > Show column header.
- **Pages** (the NLE standard: a few pages like DaVinci Resolve's, asset kinds as bins like Premiere's Project panel;
  keys 1-4): **1 Timeline** (the synced vertical view, default) · **2 Assets** (left sub-nav: Characters, Locations,
  Props, Media, Clips, each with its count; a search box and a status filter at the top filter the cards / rows of the
  visible bin; the character page opens inside it) · **3 Review** (Approvals, Queue = generation requests, Notes,
  Costs) · **4 Settings** (not a tab: Edit > Settings, `Ctrl+,`, or `⚙`). **Window > New page…** pins any sub-view
  (e.g. Media) as its own closable page (keys 5-9); Window also lists every sub-view (Assets > Characters…), and the
  palette has one command per sub-view ("Assets: Characters", "Review: Queue"…).
- **Commands**: every action is a command (`core/commands.js`). `Ctrl+K` / `Ctrl+Shift+P` = fuzzy palette with the
  keys next to each command; `Ctrl+F` = find (lyrics, script, notes, shot/clip ids, entities); `?` = cheat sheet.
  All keys are rebindable in **Settings > keybindings** (stored per project in `settings.json`; conflicts in red).
- **Default keys**: Space play/pause · J/K/L shuttle (J = 2 s jumps back, K = pause, L = play / faster) · ←/→ beat,
  Shift bar, Alt 10 ms · ↑/↓ lyric line · Home/End · `[` `]` section · I/O loop in/out, Shift+L loop on/off ·
  M marker · N new note · A approve, R request changes (selection, else the shot at the playhead) · Ctrl+Z,
  Ctrl+Shift+Z / Ctrl+Y undo/redo · Ctrl+S snapshot · Ctrl+Shift+S save project as · Ctrl+D duplicate (request) ·
  Delete (notes) · F2 rename (note, section) · 1-4 pages (1 Timeline, 2 Assets, 3 Review, 4 Settings; 5-9 custom pages) · Alt+1-9 toggle columns · H hide the column under the mouse,
  Shift+H show all · Alt+H header full/thin/hidden · Ctrl+0 fit song · Ctrl+1 100 % · T (or 0) linear time · F follow ·
  +/- zoom · P preview dock · V floating render · `` ` `` top bar · Alt+H column header · Ctrl+, settings · ? cheat sheet ·
  F10 menu bar · Esc closes menus / dialogs / palette / cheat sheet (only).
- **Mouse**: wheel = time · **Ctrl+wheel / pinch = zoom time at the cursor** (the time under the pointer stays on its
  pixel row; the warp is rebuilt with the new floor) · Shift+wheel = sideways · Alt+wheel or Ctrl+Shift+wheel = widen /
  narrow the column under the cursor · middle-drag = pan · drag on the ruler = select a time range · click = seek +
  select · Shift+click = add to the selection / extend the range · right-click = context menu (Shift+right-click = the
  browser's) · double-click a header = auto-fit width · double-click a separator = reset width · drag a header =
  reorder columns · drag a separator = resize (down to 3 px).
- **Context menus** (keyboard: ↑↓ → ← Enter Esc, type a letter to jump): ruler/lanes, timeline, lyric line, section
  (rename, colour, loop, fold = collapse, variant), shot / clip (preview, show in Clips, choose take, set in-point,
  approve, regenerate, duplicate, open file location, copy id), cast chip (open, swap costume), note, column header
  (hide, strip, drive/follow, width presets, move, settings, reset), entity card, empty space (paste, hidden columns).
- **Column header** (16 px): hover a name for `D/F` (drive / follow), `▸` (collapse to a strip), `×` (hide).
  `⋮` at the right lists every column.
- **Drive vs follow**: a drive column's measured heights push the axis (lyrics, events, script, cost, notes by
  default); a follow column clips to it (sections, shots, clips, cast, status). Hidden, collapsed and follow columns
  do not push, so hiding a column tightens time. A **folded** section is drawn at 0.6 px/s and its text is hidden.
- **Edits** (all undoable per session): approval chips (click cycles `draft → approved → changes`, or A / R), notes
  (add, edit, resolve, delete), section label/colour (`overrides.json`), generation requests (`requests.json`).
  `song.json`, `shots.json` etc. stay the importer's: timing / take / in-point changes become **requests** for the
  agent. The page never calls a paid API.
- **Projects** (File menu): new (empty), new from template (copy without notes/approvals/requests), open, recent,
  save snapshot (Ctrl+S, with a message), revert to snapshot (the current state is snapshotted first, "auto"),
  save as / duplicate, import (as requests), export (JSON bundle, shot list CSV, printable storyboard), delete.
  Open a project with `?project=<id>`.
- Layout (widths, order, hidden, collapsed, modes, folds, floor, active page and sub-view, custom pages, asset filter) is kept in `localStorage` per browser.

## Columns

| id | kind | default | shows |
|---|---|---|---|
| ruler | lane | on | bar number + mm:ss at downbeats, beat ticks, section colour band, amber density tint = local stretch |
| sections | text, follow | on | label, energy, world %, overload target; click = loop |
| lyrics | text, drive | on | one row per **visual line**; each visual line is a warp knot at its first word's onset; karaoke word highlight; dotted = low-confidence word; left stripe = voice (male/female/both/system) |
| events | text, drive | on | stops, drops, counts, silences, beats, spoken cues |
| wave | lane | on | mix waveform, faint downbeat lines (they spread apart where text is dense) |
| stems | lane | hidden | vocals, backing, bass, drums |
| energy | lane | on | RMS (24 fps) + amber target overload ladder 0-10 per section |
| script | text, drive | on | W/S/B + action per lyric line (TREATMENT §2), approval dot |
| shots | text, follow | on | storyboard shot, frame of the v1 render, kind (screen/split/world), status dot |
| clips | text, follow | on | world-clip uses (clip.take +in-point), frame at the in-point, location colour; overlaps share width |
| cast | text, follow | on | D, H, A1-A8 chips + location letters per shot |
| status | text, follow | on | approval chips for the shot and each clip use inside it |
| cost | text, drive | hidden | $ per generation job at its first use, running Σ / cap |
| notes | text, drive | on | Dani's and the director's notes pinned to time |

## Files (`data/<project>/`)

All times are **integer milliseconds**. Pixels are never stored. Media paths under one of the configured `media_roots`
are relative to `media_base` and served read-only at `/media/<path>`; other paths are relative to the project folder
(the demo keeps its files in `media/`, `audio/`, `render/`).

| file | shape |
|---|---|
| `song.json` | `{duration_ms, bpm, beat_ms, bar_ms, grid:{beats[], downbeats[]}, audio:{mix, render, stems[{id,label,audio,peaks}]}, sections[{id,label,t0,t1,energy,world_pct,overload:[lo,hi],transitions}], lines[{id:"verse1/3", section, t0, t1, text, voice, kind, words[{w,t0,t1,p}]}]}` |
| `events.json` | `[{id, t, kind, note}]` |
| `energy.json` | `{fps, rms[], onset[]}` (0-1) |
| `script.json` | `{stages[{name,t0,t1,text}], lines[{id:"s07", t0, t_end?, lyric, mode:"W"|"S"|"B"|"W→S", action, line_id}]}` |
| `shots.json` | `{shots[{id, t0, t1, section, kind, title, cast[], locations[], clips[use ids], thumb, render_frame_ms}], uses[{id:"G05@20158", clip, take, in_ms, t0, t1, file, start_image, location, thumb, label}]}` |
| `entities/{characters,locations,props}/<id>.json` | `{id, kind, name, role|description, refs[paths], thumb, status, private_refs?, ...}`; `entities/index.json` lists them |
| `notes.json` | `{rev, notes[{id, t, line_id, by, text, status:"open"|"resolved", at, about?, source?}]}` |
| `approvals.json` | `{rev, states[], items:{"<kind>:<id>": {state, by, at, why?, comment?}}}`; kinds: `shot`, `use`, `job`, `script`, `character`, `location`, `prop` |
| `costs.json` | `{cap_usd, fal_total_usd, items[{id, t, usd, tool, date}], pre_production[], ledger[]}` |
| `peaks/<id>.json` | `{bin_ms:5, n, scale, min, max}`: min/max per 5 ms bin, int8 (value/127*scale), base64; ~140 KB each |
| `thumbs/*.jpg` | small frames: `shot_<id>` (render), `use_<clip>_<take>_<in_ms>` (clip at the in-point), `ent_<id>` |
| `_src/edl.json` | raw `WORLD.clip` calls from the render page (input to the importer) |
| `media.json` | `{generated, count, by_kind, items[{id, path, kind, label, entities[], shots[], uses[], take, job, group, size, w, h, duration_ms, private, status: used/picked/unused/private, cost_usd, thumb, strip?, strip_n?, packed_alpha?}]}`; kinds: render, clip, still, avatar, body, motion, dancer, motion-ref, sheet, variation, contact, audio, ref |
| `thumbs/m_*.jpg`, `s_*.jpg`, `priv_*.jpg` | media thumbnails (max 240 px, sheets 600 px), 8-frame hover-scrub strips of videos, thumbnails of PRIVATE files |
| `_src/probe.json` | ffprobe cache (size/mtime keyed) |
| `requests.json` | `{rev, items[{id, kind, target, prompt, refs[], est_cost, status: draft/approved/queued/running/done/rejected, by, at, outputs?[]}]}`; kinds: regenerate, new-costume, new-variant, generate, duplicate, choose-take, set-in, edit-timing, swap-costume, section-variant, import |
| `overrides.json` | `{rev, sections:{<id>:{label?, color?}}}`: the director's section renames / colours over `song.json` |
| `settings.json` | `{rev, keybindings:{<command id>:[keys]}}` (not snapshotted) |
| `project.json` | `{title, created, from?}` |
| `.snapshots/<yyyymmdd-hhmmss>-<slug>/` | copies of the small JSON files (no peaks, thumbs, `_src`, settings) + `.meta.json {id, at, message, auto, files}` |

## How an agent edits them

- Edit **ms and text**, never layout. Any change re-flows every column: `serve.mjs` watches the data folder and pushes
  the changed file name over SSE (`/api/events`); the page reloads that file (approvals/notes in place, anything else
  rebuilds the timeline and keeps the scroll position by time).
- Invariants: `t0 < t1`; words inside a line are monotone and inside the line; ids stay stable (`intro/0`, `c1-desk`,
  `G05@20158`, `script:s07`).
- `approvals.json` / `notes.json` are shared with the page: read the file, change it, **bump `rev`**, write it whole
  (write a temp file and rename). The page posts `{base_rev, data}` to `/api/save/<file>`; a stale `base_rev` gets
  `409` and the page re-applies its change on top of the current file, so an agent's edit is never silently lost.
- To answer a note: append a note with `by: "agent"` at the same `t` (or set `status: "resolved"`). To ask for a
  review: set an item to `state: "review"`.
- Generation queue: read `requests.json`; run only `status: "approved"` items; set `queued` / `running`, then `done`
  with `outputs: [paths]` (or `rejected` + `why`); bump `rev`, write whole, as above. The Queue tab shows it live.
- New columns: one object in `js/columns.js`. New views: one module in `tabs/` plus one line in `tabs/registry.js`,
  as a sub-view under its page (`{ id, title, load, count?(store) }` in the page's `subs`) or, rarely, a new page
  (a module exports `{ mount(el, ctx), show?(ctx) }`; `ctx.store`, `ctx.timeline`, `ctx.goto(ms)`). At runtime:
  `WB.app.registerSub('assets', sub)`. `WB.app.show(id)` takes a page id (`timeline`, `assets`, `review`, `settings`)
  or a sub-view id (`characters`, `queue`, `media`…: opens its page on it); `WB.app.newPage(viewId)` /
  `closePage('p:<viewId>')` for custom pages; `WB.context().tab` is the page, `.view` the visible sub-view.

## Server (`serve.mjs`)

Every `/api` call takes `?project=<id>` (default: `$WB_PROJECT`, the config's `default_project`, else `demo`). The data layer is
`lib/store.mjs`, shared with the MCP server.
`GET /api/config` (media roots, private rule) · `GET /api/status` (pages open) · `POST /api/op/<op>` (every MCP tool op, local
only) · `POST /api/ui {t?, range?, view?, select?, preview?, message?, play?, open_project?}` (live UI channel: pushed to the
open pages over SSE; returns `{pages, delivered}` once they ack via `POST /api/ui/ack`) ·
`POST /api/save/<file>` `{base_rev, data}` (409 + current file when stale) · `GET /api/events` (SSE `{project, file}`) ·
`GET /api/projects` · `POST /api/projects/new {id}` · `POST /api/projects/duplicate {from, to, reset_state?}` ·
`POST /api/projects/delete {id}` (the default project is refused) · `GET /api/snapshots` · `POST /api/snapshot {message}` ·
`POST /api/restore {snapshot}` (auto-snapshots first, copies byte-identical, removes files the snapshot did not have) ·
`POST /api/reveal {path}` (Explorer at a media file). Writes are temp file + rename with retries (Windows locks);
small files are served in one read so no handle stays open.

## Security model (local server)

- The server binds **127.0.0.1** only. `--lan`, `WB_HOST` or config `host` opts in to the network; remote clients
  still cannot write unless `allow_remote_ops` is set, and never get files flagged private.
- Requests must use an allowed **Host** (localhost / 127.0.0.1 / [::1] on the server's port) and, when sent by a
  browser, no foreign **Origin** (blocks CSRF and DNS rebinding).
- Every write (POST) must be `application/json` and carry the per-run token in the **`x-wb-token`** header. The server
  injects it into `index.html` / `dock.html` as `<meta name="wb-token">` and `window.__WB_TOKEN__`; the page and the
  MCP server pick it up automatically. Set `WB_TOKEN` to fix it for scripts.
- Paths with `..`, `.`, backslashes or NUL are rejected; dot-folders are never served; private files (by rule or
  `private: true` in `media.json`) live under `private/<kind>/` and are never exported or packaged.
- Approvals are the director's: `approve` (and `shot_update` to approved/locked) need `director_approved: true`, which
  an agent must only pass when the human explicitly approved in the conversation. A cost cap of **0 blocks all paid
  requests**. A snapshot restore bumps each file's `rev` (stale pages get 409 instead of overwriting).

## Export: HTML package of a HyperFrames composition (`exporters/hyperframes-html/`)

The film's composition itself, packaged 1:1 to play in any browser: every file it uses is copied byte-identical in its
own layout under `composition/`, with the official `<hyperframes-player>` (vendored, no CDN) as `index.html`, and a
`manifest.json`. The manifest has every asset's size, hash, codec, resolution, fps, bitrate and alpha, and where in the
timeline each one is visible or audible and which media time it plays, all measured headless. That is the input for a
later, separate compression step (HandBrakeCLI / ffmpeg presets).

```
node exporters/hyperframes-html/export.mjs <compositionDir> <outDir>            # [--entry index.html] [--sample-fps 10]
node exporters/hyperframes-html/verify.mjs <outDir> --against <render.mp4>      # frames vs the render, failed requests
node exporters/hyperframes-html/serve.mjs  <outDir>                             # http://127.0.0.1:8150/
```

Details: `exporters/hyperframes-html/README.md`.

## Extension API (for tab modules; full reference at the top of `core/commands.js`)

```js
WB.commands.register({ id: 'media.compare', title: 'Compare takes', group: 'View', keys: ['C'],
  when: (c) => !!c.use, checked: (c) => false, run: (c) => WB.dock.show({ kind: 'compare', use: c.use }) });
WB.menus.contribute('clip', ['media.compare', { label: 'More', submenu: (c) => [/* items */] }, '-']);  // or 'menubar:View'
WB.commands.run('view.linear');  WB.context({ t: 61000 });  WB.keymap.set(id, ['Ctrl+Alt+C']);
WB.ui.prompt({ title }) / WB.ui.pick({ title, items }) / WB.ui.confirm(title)       // palette-style dialogs
WB.selection.keys / .range / .set([...]);  WB.requests.create({ kind, target, prompt, refs, est_cost });
WB.dock.open() / close() / toggle() / isOpen() / show(source) / el / body   // placeholder until Part B
```

Contexts for `contribute`: `timeline`, `ruler`, `lyric`, `section`, `shot`, `clip`, `cast`, `note`, `header`,
`entity` (any element with `data-ent="<entity id>"`), `empty`, `global`, `columns`, `menubar:<Menu>`. Elements with
`data-sel="<kind>:<id>"` are selectable (click / Shift+click) and pass `item` to the context. Modules in `core/`:
`commands.js` (registry, keymap), `menus.js` (popups, menu bar), `palette.js` (palette, find, prompt/pick, cheat
sheet), `history.js` (undo/redo), `selection.js`, `projects.js` (projects, snapshots, exports), `dock.js` (stub),
`defaults.js` (every default command and menu, written against the public API).

## How the warp works (`js/warp.js`, `js/timeline.js`)

Anchors = section bounds + lyric line onsets + shot cuts + every drive item's start/end. Each drive item gives a
constraint `y(next) ≥ y(start) + height`; a forward pass `Y[k] = max(Y[k-1] + floor·dt, Y[a] + h …)` builds the
smallest monotone axis with a minimum px/s floor (instrumental passages stay visible). `y(t)` is piecewise linear, so
`t(y)` (click to seek) is a binary search plus one division. Lyrics are wrapped with canvas text metrics in the same
font and rendered one nowrap row per visual line, so the measured and the drawn text cannot differ, and every visual
line gets its own knot. Other drive columns are measured from the DOM in one batch. Lanes are one sticky
viewport-sized canvas each, drawn per device-pixel row through `t(y)` from a 5/20/80/320/1280 ms min/max pyramid.
Resizes re-warp at most once per frame (ResizeObserver + rAF) and restore the scroll position by time at the reading
line (30 % of the view).

## Part B: media everywhere, preview dock, characterization

- **Importer** (the owner's example, `importers/azemar_import.py`) indexes every generated file into `media.json` (230 items: renders, clips with every take, start
  images, avatars, HER bodies, motion clips, dancer sprites, motion sources, character-lab sheets and variations,
  contact/review sheets, mix + stems, private refs) with thumbnails and hover-scrub strips (ffmpeg, cached), and
  enriches the entity files: characters get `face`, `body`, `sheets{angles, expressions, turnaround, hero}`,
  `looks[{id, name, garments, colors, images, clips, stills, used[{shot,t}], status, cost_usd, base?, variant_of?,
  avatar?}]`, `motion[]`, `lives[]`, `private_refs[]`; avatars A1-A7 are lives (looks) of Dani (`life_of`);
  locations get `establishing`, `images[{path, still, angle, tod, clips}]`, `angles`, `times`, `clips[]`; props get
  `hero` and `images[]`. Storyboard A6 = office boxers (still I14), A7 = cosmologist (job "A6").
- **PRIVATE**: paths matching the private rule (`thumbs/priv_*`, any `private/` folder, plus `private_media` in the local
  config; in the owner's production `project/gen/refs/*`, `character-lab/refs/*`) are crops of real photos. They are flagged `private`, shown only in the local page with a 🔒 badge, their thumbnails are
  `thumbs/priv_*`, `serve.mjs` serves them to localhost only, and every export goes through `scrub()` in
  `core/projects.js` (bundle, CSV, storyboard): no private path ever leaves the machine.
- **Preview dock** (`core/dock.js`, P): bottom-right by default; drag the title to any corner, the grip resizes, ⧉
  pops it out to `dock.html` (BroadcastChannel `wb-dock-<project>` keeps time, source and hover in sync; closing the
  window brings the dock back); geometry in localStorage. Modes: **film** (the render, exact seek on every playhead
  change, rate-nudged within a frame while playing), **hover** (after 220 ms over a shot, clip, cast chip, media cell
  or card; leaving returns to film), **pin** (click a media cell / Preview / Compare pins it; `film` unpins).
  Sources: `{kind: film|shot|use|compare|media|entity|look|image|video, id}`.
- **Media** (Assets > Media): dense grid grouped by kind; filters kind / entity / status / private; hover scrubs the 8-frame strip;
  click = dock; right-click = `media` context (show, compare takes, show on timeline, use as reference for…, copy
  path, open file location); drag a cell onto the look form as a reference.
- **Characters**: leads (big face, full body, head-angle and expression cells cropped from the 3x3 sheets), lives of
  Dani, dancers; click = character page (identity sheet, private refs, LOOKS as cards with garments, colours, where
  used, status, cost, a big **+ New look** card, expressions, head angles, motion clips, lives). Right-click a look:
  duplicate, variant of, where used, preview. **Locations**: establishing image, angles x time of day, clips shot
  there, **+ New angle / time of day**. **Props**: hero, images, **+ New variant**.
- **Look form** (`WB.lookForm(entity, {mode: new|dup|variant, look, refs})`): name, garments, colours, references
  (drop from Media / files, or pick from Media), notes, options (turnaround sheet, takes, re-shoot used shots) with a
  live cost estimate against the cap; creates a draft `new-costume` / `new-variant` request with `look{...}`.
- Commands: `dock.film`, `dock.pin`, `dock.popout`, `dock.corner`, `media.compare`, `media.show`, `media.timeline`,
  `media.copyPath`, `media.reveal`, `media.tab`, `entity.page`, `entity.sheet`, `entity.newLook`, `look.duplicate`,
  `look.variant`, `look.timeline`, `look.preview` (`core/partb.js`). Cast chip > Swap costume lists the looks.
