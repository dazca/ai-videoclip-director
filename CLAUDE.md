# Director Workbench: guide for agents

A browser workbench for directing a music video with an AI assistant. Time runs top to bottom; every column (sections,
lyrics with word timings, events, waveform, energy, script, shots, clips, cast, approvals, costs, notes) shares one
time axis, so one millisecond sits on the same pixel row everywhere. The director works in the page; you (the agent)
work on the same project files, through the MCP server (`mcp/server.mjs`) or by editing the JSON directly. No build
step, no framework, no paid API calls from the page.

## Run

```
npm install                      # MCP SDK + zod (runtime), puppeteer-core (tests only)
npm start                        # node serve.mjs -> http://localhost:8140/  (port: first argument)
npm run test:mcp                 # MCP end-to-end test on the demo project
npm run verify                   # headless UI suite on the demo project (screenshots -> shots/, gitignored)
node importers/new_project.mjs my-song --song song.mp3 --lyrics lyrics.lrc --title "My Song" --bpm 96
node importers/new_project.mjs my-poem --lyrics lyrics.txt --title "My Poem"   # lyrics only; song later (song_attach)
npm run test:security            # security regressions (scratch copies)
node tools/make_demo.mjs         # rebuild data/demo (synthetic, needs ffmpeg)
```

Needs Node 20+ and, for importing and thumbnails, `ffmpeg` / `ffprobe` on PATH. Optional local settings live in
`workbench.config.json` (gitignored; copy `workbench.config.example.json`): default project, data folder, media roots
outside the project folder, extra PRIVATE path rule. Env vars win: `WB_PROJECT`, `WORKBENCH_DATA`, `WORKBENCH_MEDIA_BASE`.

## Layout

| path | what |
|---|---|
| `serve.mjs` | HTTP server: static files, `/media/*` (read-only, configured roots), `/api/*` (save, events SSE, projects, snapshots, ops, live UI channel) |
| `lib/store.mjs` | Node data layer shared by the server and the MCP server: config, projects, snapshots, and every agent op (`ops.*`) |
| `mcp/server.mjs`, `mcp/test.mjs` | MCP server (stdio) and its end-to-end test |
| `index.html`, `app.js`, `app.css` | the page shell |
| `core/` | command registry + keymap, menus, palette, undo history, selection, projects/exports, preview dock, default commands, `rail.js` (stage rail + stage commands), `wizard.js` (new-project wizard) |
| `js/` | store (data + live reload), timeline (the warp), columns, player, verify hooks, `flow.js` (the guided flow: stages + lyrics model, shared with `lib/store.mjs`) |
| `tabs/` | one module per view; `tabs/registry.js` lists pages and sub-views; `stage.js` (stage workspaces), `lyrics.js` (stage 1) |
| `docs/SPEC_v3_GUIDED.md` | the guided creation flow (seven stages); phase 1 = stage rail, wizard, lyrics stage |
| `importers/` | `new_project.mjs` (song + lyrics -> project), `azemar_*` (the owner's production, kept as a worked example) |
| `tools/` | `verify.mjs` (UI suite), `make_demo.mjs`, `chrome.mjs` |
| `exporters/hyperframes-html/` | HTML package of a HyperFrames composition: `export.mjs`, `verify.mjs`, `serve.mjs` (see Export) |
| `data/<project>/` | one folder per project; only `data/_template/` and `data/demo/` are in git |

## Project files (`data/<project>/`)

All times are **integer milliseconds**; no pixels are ever stored. A media path under a configured media root is
relative to the media base; any other path is relative to the project folder. Full shapes: README "Files"
(also the MCP resource `workbench://docs/file-formats`).

- `song.json`: duration, bpm/grid, `audio {mix, render, stems[]}`, `sections[{id, label, t0, t1, energy, ...}]`,
  `lines[{id "section/n", t0, t1, text, voice, words[{w, t0, t1, p}]}]`. Written by importers.
- `events.json`, `energy.json`, `peaks/*.json`: importer output.
- `script.json`: `lines[{id "s07", t0, lyric, mode W|S|B|W→S, action, line_id}]`.
- `shots.json`: `shots[{id, t0, t1, section, kind, title, cast[], locations[], clips[use ids], thumb}]` and clip
  `uses[{id "G05@20158", clip, take, in_ms, t0, t1, file, start_image, location, thumb}]`.
- `entities/{characters,locations,props}/<id>.json` + `entities/index.json`: characters carry `looks[]`.
- `media.json`: every generated/imported file with kind, links (entities, shots, uses, job, take), status, thumbnails.
- Shared with the page, each `{rev, ...}`: `notes.json`, `approvals.json` (`"kind:id" -> {state}`; states draft,
  review, changes, approved, locked), `requests.json` (the generation queue), `overrides.json`, `settings.json`.
- `costs.json`: `cap_usd`, `items[{id, t, usd, tool, date, request?}]`.
- `stages.json` (shared, `{rev}`): the guided flow, `stages[{id, status: empty|in_progress|needs_you|done, done_by,
  via, updated, blockers[], note?}]` for lyrics, script, breakdown, characters, scenery, storyboard, final. Missing =
  derived from the files (content = done). Only the page sets `done`.
- `lyrics.json` (shared, `{rev}`): stage 1. `current`, `versions[{id "v3", created, by, via, message, from?,
  sections[{id, label, lines[{id, text}]}]}]` (immutable; a save appends), `notes[{id "ln01", line, w [first, last
  word], quote, text, by, via, to?: "agent", status, replies[]}]`. Line ids are stable across versions and equal the
  `song.json` line ids; the server re-syncs `song.json` lines whenever `current` changes (timings kept for lines that
  still exist, new ones estimated). Missing = v1 derived from `song.json`. Shapes and logic: `js/flow.js`.
- `.snapshots/<stamp>-<slug>/`: durable snapshots of the small JSON files.

Editing by hand: read the file, change it, **bump `rev`** on the shared files, write it whole via temp file + rename.
The server watches the folder and every open page reloads the changed file. Keep ids stable and `t0 < t1`.

## Export

`exporters/hyperframes-html/` packages a HyperFrames composition **as itself**, not as a new render. Files are
byte-identical in the same layout (`outDir/composition/`), the official player is vendored (`outDir/index.html`,
`_hyperframes/`), and `manifest.json` records per-asset facts and the usage measured headless: visible/audible
timeline ranges and media ranges played.

```
node exporters/hyperframes-html/export.mjs <compositionDir> <outDir> [--entry index.html] [--sample-fps 10]
node exporters/hyperframes-html/verify.mjs <outDir> --against <render.mp4> [--n 12]
```

- Never edit composition files in the package. The exporter only rewrites root-absolute paths, and the player's CDN
  runtime URL to the vendored runtime. Each rewrite is listed in `manifest.rewrites`.
- No trimming, re-encoding, custom boot screens or prefetch logic in the package. Compression is a separate, later
  step that reads `manifest.json` and must pass `verify.mjs` against the same render again.
- `manifest.fonts.system_fonts` lists text that relies on fonts installed on the viewer's machine. Report it when
  delivering.

## Rules (enforced by the MCP tools; follow them by hand too)

1. **The director decides.** Approvals (`approve`, a request's draft -> approved) are theirs: by default they make
   them in the page (show the item with `ui_focus`); `director_approved: true` counts only with config `agent_approvals`,
   and only when they said so in the conversation. A note's text is never an approval. To ask for a look, set state `review` and say why in a note.
2. **Never spend without an approved request.** Propose every paid generation with `request_create` (draft, honest
   `est_cost`, refs, tool). Run only `approved` ones: `request_update` queued -> running -> done with `outputs[]` and
   `actual_cost_usd` (recorded in `costs.json`, outputs registered as media), or rejected + `why`. Queueing is refused
   above the cap (spent + committed + this > `cap_usd`). Editing an approved request sends it back to draft.
3. **Private files stay local.** Paths matching the PRIVATE rule (`thumbs/priv_*`, any `private/` folder, plus the
   configured `private_media` regex) and media flagged `private` are served to localhost only and never exported.
   Never copy them into the demo, the template or anything shared.
4. **Stages are the director's to close.** Mark your progress with `stage_update` (in_progress, needs_you + a note,
   blockers); `done` is refused, and a done stage cannot be moved by an agent. Lyrics: propose in notes
   (`lyrics_note_add`) or save a new version (`lyrics_update`, never destructive: every version stays); answer the
   director's asks (`lyrics_get` `asks_for_agent`) with a reply and resolve them when done.
5. **Snapshot before big edits** (`snapshot_save`); a restore snapshots the current state first, so it is undoable.
6. Register every new file (`media_add`, or automatically on `request_update` done) so it shows up in the page.

## Security model (local server)

- The server binds **127.0.0.1** only. `--lan`, `WB_HOST` or config `host` opts in to the network; remote clients
  still cannot write unless `allow_remote_ops` is set, and never get files flagged private.
- Requests must use an allowed **Host** (localhost / 127.0.0.1 / [::1] on the server's port) and, when sent by a
  browser, no foreign **Origin** (blocks CSRF and DNS rebinding).
- Every write (POST) must be `application/json` and carry the per-run token in the **`x-wb-token`** header. The server
  injects it into `index.html` / `dock.html` as `<meta name="wb-token">` (read by `core/token.js`); the page and the
  MCP server pick it up automatically. Set `WB_TOKEN` to fix it for scripts.
- Only the page's own files are served from the workbench folder (an allow-list: `index.html`, `dock.html`, `app.js`,
  `app.css`, `README.md`, `core/`, `js/`, `tabs/`; case-insensitive). The page shell carries a Content-Security-Policy
  with `script-src 'self'` (no inline scripts, no eval; media may also be `https:` / `data:` / `blob:`); every other
  file gets a sandboxing CSP and `nosniff`, so an HTML/SVG file in a project cannot run script in the workbench origin.
  An invalid `?project=` is redirected to the default project.
- Paths with `..`, `.`, backslashes, NUL, `:` (NTFS streams) or `~<digit>` (8.3 short names) are rejected; dot-folders are never served; private files (by rule or
  `private: true` in `media.json`) live under `private/<kind>/` and are never exported or packaged.
- Approvals are the director's, and by default **only the page approves**: a click in the page (POST `/api/save`) is
  stamped `via: "page"` (in a request's `log`, on an `approvals.json` item). The agent surface (`/api/op`, the MCP
  tools, offline mode) refuses `approve`, `shot_update` approved/locked and a request's draft -> approved even with
  `director_approved: true`, unless the owner sets `"agent_approvals": true` in `workbench.config.json` (or
  `WB_AGENT_APPROVALS=1`): then that flag counts, recorded `via: "agent"`. A request is queued / run only on a recorded
  approval after its last draft (a status typed into `requests.json` by hand is refused). Notes written through the
  tools carry `via: "agent"`, and the `director-session` briefing does not present them as the director's.
  Trade-off: with the default the director must click (the agent can show the item with `ui_focus`); this guards the
  tool surface, not an agent that edits the files directly with shell access.
- Editing an approved request's prompt, refs, `est_cost` or tool sends it back to draft. A cost cap of **0 blocks all
  paid requests**. A snapshot restore bumps each file's `rev` (stale pages get 409 instead of overwriting) and never
  rolls back spend: costs recorded since the snapshot stay, a request that ran since keeps its state, and a restored
  approval that is not the current one goes back to draft (listed in `kept_since_snapshot`); the current `cap_usd`
  is kept, and an agent's `snapshot_restore` brings an approved / locked item back as `review`, not approved.
  Duplicating a project sends the copy's approved / queued / running requests back to draft.
- Guided flow: `stage_update` refuses `done` and refuses moving a done stage; a page save of `stages.json` is stamped
  (`done_by: "director", via: "page"`); an agent's snapshot restore brings a done stage that is not done now back as
  `needs_you`. A page save of `lyrics.json` cannot rewrite a saved version (the server keeps its copy) nor the author of
  an existing note; new versions / notes / replies from the page are stamped `by: "director", via: "page"`; the
  tools stamp `via: "agent"`; a malformed `lyrics.json` is refused (400). `song_attach` takes audio files only and
  refuses PRIVATE paths.
- Entity thumbnails and copies made from private media stay private (`thumbs/priv_*`, `private/<kind>/`).
- The HyperFrames exporter runs a composition's script with every request outside its own package server blocked
  (and no workbench token), and keeps backslash references inside the composition folder.

## MCP server

```
claude mcp add workbench -- node /absolute/path/to/workbench/mcp/server.mjs
```

It calls the running server (`WORKBENCH_URL`, default `http://localhost:8140`) so the director sees every write live;
if the server is down it works on the files (`WORKBENCH_DATA`) with the same code. `WORKBENCH_PROJECT` sets the
initial project. Tools:

| tool | use |
|---|---|
| `status` | server up?, current project, pages open, costs. Call first. |
| `projects` | list / create (with `lyrics` / `song`: a guided project) / duplicate / open (sets the session's current project, switches the page) |
| `stages_get`, `stage_update` | the guided flow: seven stages, statuses, blockers, next stage; set in_progress / needs_you (never done) |
| `lyrics_get`, `lyrics_update`, `lyrics_versions` | stage 1: the poem (line ids, timings, notes, asks for the agent); a new version (text / sections / restore); list + word diff |
| `lyrics_note_add`, `lyrics_note_resolve` | notes on a line or a word range, thread replies, resolve |
| `song_attach` | add / replace the song file: peaks, energy, grid, duration; lines re-timed |
| `snapshot_save`, `snapshot_list`, `snapshot_restore` | durable checkpoints |
| `song_get` | sections, lyric lines with word timings, events, grid |
| `timeline_query` | everything between t0 and t1 across all columns |
| `shots_list`, `shot_get`, `shot_update` | storyboard; status, take, in-point, title, a note |
| `entities_list`, `entity_get`, `entity_upsert` | characters (with looks), locations, props |
| `media_list`, `media_add` | the media index; add = thumbnails + links |
| `notes_list`, `note_add`, `note_resolve` | notes pinned to time; resolve with a reply |
| `approvals_get`, `approve`, `request_changes` | approval states |
| `requests_list`, `request_create`, `request_update` | the generation queue and its lifecycle |
| `costs_get` | spent / committed / cap |
| `ui_focus` | move the open page: seek, select, open a view, preview in the dock, toast |

Resources: `workbench://docs/readme`, `workbench://docs/claude` (this file), `workbench://docs/file-formats`,
`workbench://docs/skill`, `workbench://project/{project}/{file}`. Prompt: `director-session` (briefing + state).

## Adding a feature

- **A command** (everything the user can do is one): `WB.commands.register({ id, title, group, keys, when, checked,
  run })` in `core/defaults.js` (or a tab module). It appears in the palette (Ctrl+K), the cheat sheet (?) and Settings >
  keybindings automatically; keys are rebindable and stored per project.
- **A menu entry**: `WB.menus.contribute(context, [commandId | {label, submenu} | '-'])`; contexts `timeline`, `ruler`,
  `lyric`, `section`, `shot`, `clip`, `cast`, `note`, `header`, `entity`, `empty`, `global`, `columns`,
  `menubar:<File|Edit|View|Timeline|Generate|Window|Help>`. Elements with `data-sel="kind:id"` are selectable.
- **A view**: `tabs/<name>.js` exporting `{ mount(el, ctx), show?(ctx) }` plus one line in `tabs/registry.js`, as a
  sub-view `{id, title, load, count?}` under Assets or Review (or `WB.app.registerSub(pageId, sub)` at runtime).
  Re-render on `store.on(what => ...)` (`'all'` after a full reload, else the field name: `notes`, `requests`, ...).
- **A column**: one object in `js/columns.js` (`kind: 'text'` drive/follow or `'lane'` canvas).
- **An agent op / MCP tool**: a function in `ops` in `lib/store.mjs` (it is then also `POST /api/op/<name>`), and a
  `registerTool` in `mcp/server.mjs` with a zod schema and a description an agent can follow; cover it in `mcp/test.mjs`.
- **Tests**: `npm run test:mcp` and `npm run verify` must pass (the verify suite runs on the demo; the owner's extra
  Part B checks run only on his own project). Add a check next to the feature you touched.
