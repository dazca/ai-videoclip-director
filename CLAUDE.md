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
| `core/` | command registry + keymap, menus, palette, undo history, selection, projects/exports, preview dock, default commands |
| `js/` | store (data + live reload), timeline (the warp), columns, player, verify hooks |
| `tabs/` | one module per view; `tabs/registry.js` lists pages and sub-views |
| `importers/` | `new_project.mjs` (song + lyrics -> project), `azemar_*` (the owner's production, kept as a worked example) |
| `tools/` | `verify.mjs` (UI suite), `make_demo.mjs`, `chrome.mjs` |
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
- `.snapshots/<stamp>-<slug>/`: durable snapshots of the small JSON files.

Editing by hand: read the file, change it, **bump `rev`** on the shared files, write it whole via temp file + rename.
The server watches the folder and every open page reloads the changed file. Keep ids stable and `t0 < t1`.

## Rules (enforced by the MCP tools; follow them by hand too)

1. **The director decides.** Approvals (`approve`, `request_changes`, a request's draft -> approved) are theirs: do
   it only when they said so in the conversation. To ask for a look, set state `review` and say why in a note.
2. **Never spend without an approved request.** Propose every paid generation with `request_create` (draft, honest
   `est_cost`, refs, tool). Run only `approved` ones: `request_update` queued -> running -> done with `outputs[]` and
   `actual_cost_usd` (recorded in `costs.json`, outputs registered as media), or rejected + `why`. Queueing is refused
   above the cap (spent + committed + this > `cap_usd`). Editing an approved request sends it back to draft.
3. **Private files stay local.** Paths matching the PRIVATE rule (`thumbs/priv_*`, any `private/` folder, plus the
   configured `private_media` regex) and media flagged `private` are served to localhost only and never exported.
   Never copy them into the demo, the template or anything shared.
4. **Snapshot before big edits** (`snapshot_save`); a restore snapshots the current state first, so it is undoable.
5. Register every new file (`media_add`, or automatically on `request_update` done) so it shows up in the page.

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
| `projects` | list / create / duplicate / open (sets the session's current project, switches the page) |
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
