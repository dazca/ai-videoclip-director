# Director Workbench: guide for agents

A browser workbench for directing a music video with an AI assistant. Time runs top to bottom; every column (sections,
lyrics with word timings, events, waveform, energy, script, shots, clips, cast, approvals, costs, notes) shares one
time axis, so one millisecond sits on the same pixel row everywhere. The director works in the page; you (the agent)
work on the same project files, through the MCP server (`mcp/server.mjs`) or by editing the JSON directly. No build
step, no framework, no paid API calls from the page (its Run buttons ask the local server's runner, which runs only
requests the director approved).

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
node mcp/client.mjs <tool> '<json>' [--project <id>]   # call one MCP tool from any shell / folder (see "Calling a tool")
node tools/run.mjs --project <id> <request ids> | --all [--dry-run]   # run APPROVED requests (see "Running approved requests")
node exporters/composition-data.mjs --project <id> [--out composition/edl.json] [--map "gen/=assets/gen/"]   # the picks as edl.json (E9)
```

**A stale server.** The server hashes its code at start (`serve.mjs`, `lib/`, `js/`, `tabs/`, `core/`, `app.js`). `/api/status`
`code` and the header `x-wb-code` on every `/api` response carry it. When the files on disk differ, `status` says
`server.code.stale` + "restart", every MCP tool adds a `warning: … restart the server` block, and the page shows a thin
"Restart the server" bar. An op the old server does not know (404 "no such op") is done on the files directly, with a
warning. After pulling or editing code: restart `node serve.mjs`, then reload the page. A stale MCP server itself
(`status` `mcp.stale`) needs a reconnect.

Needs Node 20+ and, for importing and thumbnails, `ffmpeg` / `ffprobe` on PATH. Optional local settings live in
`workbench.config.json` (gitignored; copy `workbench.config.example.json`): default project, data folder, media roots
outside the project folder, extra PRIVATE path rule, `fal_key_file` (the runner's key file, outside the project). Env vars
win: `WB_PROJECT`, `WORKBENCH_DATA`, `WORKBENCH_MEDIA_BASE`, `FAL_KEY`.

## Layout

| path | what |
|---|---|
| `serve.mjs` | HTTP server: static files, `/media/*` (read-only, configured roots), `/api/*` (save, events SSE, projects, snapshots, ops, live UI channel) |
| `lib/store.mjs` | Node data layer shared by the server and the MCP server: a thin aggregator that re-exports the `ops` object (every agent op, `ops.*`) and the helpers from `lib/ops/`; everything outside imports this file |
| `lib/ops/` | the data layer by domain (table below): `_shared.mjs` (files, config, media paths + the PRIVATE rule, `projDir` / `read` / `write` / `mutate`, time helpers, thumbnails, the director gates, the `ops` object); each domain file adds its ops with `Object.assign(ops, {...})` |
| `mcp/server.mjs`, `mcp/test.mjs`, `mcp/client.mjs` | MCP server (stdio: imports the tool files, adds the resources and the `director-session` prompt, connects), its end-to-end test, and the one-shot CLI client (`node mcp/client.mjs <tool> '<json>'`) |
| `mcp/tools/` | the MCP tools by domain, one file per `lib/ops/<domain>.mjs`; `_shared.mjs` holds the transport (`op`, `http`, `server`, `projectOf`), `wrap`, the shared zod schemas and the one `mcp` server object the files register on |
| `lib/svg-sanitize.mjs` | the SVG sanitiser for proposals: a strict tokenizer, an allow-list of elements and attributes, values re-escaped; refuses (with the reason) script, on*, foreignObject, external / javascript: refs, url() but url(#id), DOCTYPE, CDATA, > 64 KB, a bad viewBox |
| `lib/run.mjs` | the request runner (D3a images, D3b video, D3c retakes / stale locks): plans, locks (heartbeat; stale ones removed), claims (approval + cap; the cap again before every take), runs through a generator, writes `gen/<request>/`, records the cost once (a retaken take once more), registers and links the outputs; video in its own lane (1 at a time); resolves the fal key; `runEvents` (serve.mjs forwards them as SSE `{run}`). The only code that calls a paid API |
| `js/checks.js`, `lib/ops/checks.mjs`, `lib/ops/_hooks.mjs`, `core/checkbadge.js`, `tools/face-score.md` | D7 identity checks and D2 character constants: the shared logic (constants `{text, check, label?}`, `cleanConstants`, `seedConstants` ("Seed from base"), the checklist, check targets, the badge of the latest check), the ops (`check_add`, `checks_get`, the "identity check" ask), the "an output landed" hook (`landed` / `batchLanded` / `onLanded`: the runner's done, imports, a node added), the badges on nodes and take cards with their hover detail, and the documented (not built) local face-embedding score |
| `js/batches.js`, `lib/ops/batches.mjs`, `tabs/waves.js` | D4 job books, waves and pilot gates: the batch logic shared by the page, the ops and the runner (gate state locked / ready / running / review / done, `gateRefusal`, totals, verdicts, the take ratio `takeStats`, `observed`, `reestimate`, `planWaves`), the ops (`batches_get`, `waves_plan`, the page-only `batch_act` and `jobbooks_import`), and the "Plan waves" dialog over the Queue |
| `generators/` | generator plugins `{id, label, kinds, configured, supports, estimate, submit, poll, fetch}`: `fal.mjs` (nb2 edit / t2i, seedream edit; h3max / kling3pro image-to-video with an end frame, klingmc motion control with a reference video; fal queue + storage), `openwith.mjs` ("Open in another app": a prompt pack), `comfyui.mjs` (a stub) |
| `js/prices.js` | the ONE price table (list prices with the day each was verified): every estimate in the page, the server and the tools |
| `js/video.js` | a video request's spec (D3b): `video {model, start, end?, ref_video?, seconds, orientation?}`, the models' seconds, `videoRefs` (what is uploaded), `videoProblems`, `videoEstimate` ($/s x seconds x takes, by date); the Queue form, `request_create` / `request_update` and the runner share it |
| `js/recipe.js`, `templates/photoreal_recipe.json`, `docs/PHOTOREAL.md` | the photoreal recipe: the default prompt template (blocks per model), its data, and the guide that explains it |
| `index.html`, `app.js`, `app.css` | the page shell |
| `core/importmedia.js` | File › Import media… (D8): the dialog (dropped files uploaded in chunks, a media-root path / folder read in place with its jobs and recovered costs, kind / label / private per row, link to a request, record a cost), dropping files anywhere on the page, and "Use as…" (rows and the `media` context menu: identity / look / base / variant node, a shot's take / start frame; `useAsItems(media)`, `WB.importMedia`) |
| `js/surfaces.js`, `lib/ops/surfaces.mjs`, `mcp/tools/surfaces.mjs`, `tabs/surfaces.js` | E2 the lyric gate: the shared logic (a surface `{line, w?, where}` on a storyboard shot, `cleanWhere` / `cleanEntry` (kinds window / chat / dialog / karaoke / taskbar / other), `coverage` (every song word covered when a surface of a shot on screen at its time names it; the uncovered runs), `gateCheck` (Final's line), surfaces.json), the ops (`surfaces_get`, `surface_propose`, the page-only `surface_act`), and the Shot panel's "lyrics on screen" (`mountSurfaces`); the timeline's `surface` column (`js/columns.js`) and the Lyrics stage's per-line count read `coverage` |
| `core/helptip.js` | F5: `help(line, more)`: one line of help + a `?` popover (`<details>`, fixed to the window, Esc / a click elsewhere closes it); the stages' empty states and the storyboard's side panel use it |
| `core/timemode.js` | the stages' Time view (List | Time, Alt+T; ROADMAP_v4 F6): `TimeAxis` places a stage's rows on the timeline's warp (`WB.timeline.warp`, `tl.watch` for its relayouts and playhead), click-to-seek, scroll sync, "+ Add at m:ss" (`tmadd`); the timeline page stays laid out behind the others (`.pgwrap.bg`) so its warp stays true |
| `core/` | command registry + keymap, menus, palette, undo history (`history.push({label, undo, redo})` for a stage draft edit), selection, projects/exports, preview dock, default commands (+ the timeline "+ Add", `notes.addHere`), `rail.js` (stage rail + stage commands + open-notes counts + the review round at its right end: "Round N · K open notes", Send round to Claude, the agent's progress, Close revision, the revision chip; `WB.rounds`), `notescol.js` (the Notes column every stage mounts: row-aligned cells, typing, threads, its width (`width` / `maxWidth`), API in its header), `wizard.js` (new-project wizard, with the unticked "Prepare starting proposals"), `proposals.js` (the proposals strip every target with proposals shows: cards, Pick / Mix / 3 more / ×, the large view, `register(stage, apply)` for what a pick does, "Prepare proposals" and "Make free layouts" (Generate menu, palette), the offer after a save; API in its header), `sketch/` (the sketch tool: `mountSketch` / `openSketch`, API in its header) |
| `js/` | store (data + live reload), timeline (the warp), columns, player, verify hooks, `notes.js` (ONE notes model for every stage and the timeline: notes.json v2, targets, validation, the migration of the old stores, the old shapes; shared with `lib/ops/notes.mjs` and `serve.mjs`), `revisions.js` (review rounds and revisions: revisions.json, the round in flight, its progress, the compare helpers; shared with `lib/ops/rounds.mjs`), `proposals.js` (proposals.json: sets, items, targets, the "3 more" / "Prepare" ask texts; shared with `lib/ops/proposals.mjs`), `proposals-local.js` (the free local generator: 3 SVG layouts per scene / shot from the script, the beats and the palette), `flow.js` (the guided flow: stages + lyrics model), `scenes.js` (stage 2: scenes, intake, gaps, snapping), `breakdown.js` (stage 3: items, links, merge / split, the "Suggest from script" pre-pass), `assets.js` (stages 4 and 5: the asset workspace logic for characters, locations and props: iteration trees, branches, variants and their axes, statuses, estimates, prompts, the variant per scene) and `characters.js` (the stage-4 names on top of it), `storyboard.js` (stage 6: shots, tiling on the beat grid, "shots from beats", the assets a shot needs and their variants, estimates, gaps), `final.js` (stage 7: the pending list from every place a status lives, the ready-to-render checklist, the costs against the cap, the lock; shared with `lib/ops/final.mjs` / `final_get`), `takes.js` (D6 take selection: the takes of a shot / request from the media index, the pick's shape and checks (`checkClip`: a registered take of the shot, in / out inside its duration, alternatives), frames, takes.json, the Final "takes" line; shared with `lib/ops/takes.mjs`), all shared with `lib/store.mjs` |
| `tabs/` | one module per view; `tabs/registry.js` lists pages and sub-views; `stage.js` (stage workspaces), `lyrics.js` (stage 1), `script.js` (stage 2), `breakdown.js` (stage 3), `assetws.js` (the generic asset workspace + its commands), `charstage.js` (stage 4 on it; `characters.js` is the Assets sub-view), `scenery.js` (stage 5 on it: locations and props), `storyboard.js` (stage 6: the board, the shot panel, the gaps, the estimate vs the cap), `final.js` (stage 7, final approvals: `FinalList`, the grouped pending table with Approve / Request changes / approve-selected, the checklist, the costs, Lock for render / Unlock); `approvals.js` is Review › Approvals (the same `FinalList` rows without the panels, + the raw approvals.json states); `notes.js` is Review › Notes (every note in one table); `compare.js` is Review › Compare (two revisions per stage, each change with its note; restore); `takes.js` is take selection (D6): `mountTakes(host, {shot})` (the compact take cards with hover-scrub, ⤢ full size, the in / out editor on a mini strip snapped to frames, a note, Pick / unpick, "+ alt" for a song time, A/B in the dock, the agent's proposals with a one-click Pick; the storyboard Shot panel mounts it) and Review › Takes (per request / per shot); each stage mounts the Notes column (`core/notescol.js`) |
| `docs/SPEC_v3_GUIDED.md` | the guided creation flow (seven stages); phase 1 = stage rail, wizard, lyrics stage; phase 2 = the script stage + sketch files; phase 3 = the breakdown stage; phase 4 = the characters stage; phase 5 = the scenery stage (locations, props) on the generic asset workspace; phase 6 = the storyboard stage (shots per scene, gaps); phase 7 = final approvals (the pending list, the ready-to-render checklist, the costs, Lock for render) |
| `catalog/` | the free starter catalogue (CC0 / public-domain bases: bodies, poses, face angles, garments, locations, props; `catalog.json`, `LICENSES.md`), served read-only for stage 4 |
| `importers/` | `new_project.mjs` (song + lyrics -> project), `azemar_*` (the owner's production, kept as a worked example) |
| `tools/` | `verify.mjs` (UI suite; its stage-4 / 5 blocks are `verify-characters.mjs` (v7), `verify-scenery.mjs` (v8), `verify-storyboard.mjs` (v9) and `verify-dogfood.mjs` (v10: proposals, image import, request warnings, merged costs, the recipe form, the stale bar), `verify-notes.mjs` (v11: the migration of the old note stores, the Notes column per stage and on the timeline, the right-click "+ Add" menus + Ctrl+Z, the counters), `verify-runner.mjs` (v12: the Queue's Approve / Reject / Run, live progress, outputs as nodes, Settings > Generator, on a mock fal) `verify-rounds.mjs` (v13: a full review round in the page and over MCP, Close revision, Compare, restore, the page-only acts, the git mirror off by default, the Notes column's width) `verify-proposals.mjs` (v14: proposals added over MCP, the strips on a scene, a shot, a lyric line and a look, Pick -> the sketch underlay / the frame's base layer / the line text + Ctrl+Z, Mix, "3 more", the free local generator, "Prepare proposals", the wizard offer) and `verify-final.mjs` (v15: the Final list = final_get's rows, filters, the checklist and its gap links, the costs, Approve per kind, Request changes, approve-selected with its cost confirm, Review › Approvals, Lock for render (agent 409) and Unlock) and `verify-takes.mjs` (v16: take selection on ffmpeg placeholder takes: takes_get, take_propose, the cards and hover-scrub, the in / out handles, Pick, the proposal's one-click Pick, alternatives, A/B, the timeline clip column, Final's count, Review › Takes) and `verify-import.mjs` (v17, D8: File › Import media, dropped files, a falgen folder with its jobs and cost, "Use as…" identity / start frame / take, the Media browser's linked / unlinked, the agent's media_import) and `verify-video.mjs` (v18, D3b: the Queue's video form (motion prompt, duration + cost, start / end frame pickers, the H3 date switch), a video run with a failed take and "Retry take 2", the .mp4 outputs as takes, motion control, video one at a time, a stale lock), each runnable alone; `verify-stages.mjs` (F1: stage status from content, per stage empty / partial / done / regressed, the rail screenshots `f1_*.png`; run after it by `npm run verify`)), `security-test.mjs`, `sketch-test.mjs` (+ `sketch-dev.html`), `tiny-png.mjs` (test PNGs), `fake-falgen.mjs` (a fake falgen output tree for the D8 tests: never fal), `mock-fal.mjs` (a mock fal for every runner test: never the real one; its video endpoints check each kind's parameters and answer a placeholder MP4 made with ffmpeg; `failNext` fails one take), `run.mjs` (the runner CLI), `make_demo.mjs`, `chrome.mjs` |
| `tools/` | `verify.mjs` (UI suite; its stage-4 / 5 blocks are `verify-characters.mjs` (v7), `verify-scenery.mjs` (v8), `verify-storyboard.mjs` (v9) and `verify-dogfood.mjs` (v10: proposals, image import, request warnings, merged costs, the recipe form, the stale bar), `verify-notes.mjs` (v11: the migration of the old note stores, the Notes column per stage and on the timeline, the right-click "+ Add" menus + Ctrl+Z, the counters), `verify-runner.mjs` (v12: the Queue's Approve / Reject / Run, live progress, outputs as nodes, Settings > Generator, on a mock fal) `verify-rounds.mjs` (v13: a full review round in the page and over MCP, Close revision, Compare, restore, the page-only acts, the git mirror off by default, the Notes column's width) `verify-proposals.mjs` (v14: proposals added over MCP, the strips on a scene, a shot, a lyric line and a look, Pick -> the sketch underlay / the frame's base layer / the line text + Ctrl+Z, Mix, "3 more", the free local generator, "Prepare proposals", the wizard offer) and `verify-final.mjs` (v15: the Final list = final_get's rows, filters, the checklist and its gap links, the costs, Approve per kind, Request changes, approve-selected with its cost confirm, Review › Approvals, Lock for render (agent 409) and Unlock) and `verify-takes.mjs` (v16: take selection on ffmpeg placeholder takes: takes_get, take_propose, the cards and hover-scrub, the in / out handles, Pick, the proposal's one-click Pick, alternatives, A/B, the timeline clip column, Final's count, Review › Takes) and `verify-import.mjs` (v17, D8: File › Import media, dropped files, a falgen folder with its jobs and cost, "Use as…" identity / start frame / take, the Media browser's linked / unlinked, the agent's media_import) and `verify-timemode.mjs` (v19: the stages' List | Time toggle; in Time a lyric line / scene / shot sits at the timeline's y for the same t, ±2 px; the Notes cells, the playhead, click-to-seek, "+ Add at m:ss", scroll sync, Final by section; screenshots `v19_<stage>.png` = the stage next to the timeline), each runnable alone; `verify-stages.mjs` (F1: stage status from content, per stage empty / partial / done / regressed, the rail screenshots `f1_*.png`; run after it by `npm run verify`)), `security-test.mjs`, `sketch-test.mjs` (+ `sketch-dev.html`), `tiny-png.mjs` (test PNGs), `fake-falgen.mjs` (a fake falgen output tree for the D8 tests: never fal), `mock-fal.mjs` (a mock fal for every runner test: never the real one), `run.mjs` (the runner CLI), `make_demo.mjs`, `chrome.mjs` |
| `tools/` | `verify.mjs` (UI suite; its stage-4 / 5 blocks are `verify-characters.mjs` (v7), `verify-scenery.mjs` (v8), `verify-storyboard.mjs` (v9) and `verify-dogfood.mjs` (v10: proposals, image import, request warnings, merged costs, the recipe form, the stale bar), `verify-notes.mjs` (v11: the migration of the old note stores, the Notes column per stage and on the timeline, the right-click "+ Add" menus + Ctrl+Z, the counters), `verify-runner.mjs` (v12: the Queue's Approve / Reject / Run, live progress, outputs as nodes, Settings > Generator, on a mock fal) `verify-rounds.mjs` (v13: a full review round in the page and over MCP, Close revision, Compare, restore, the page-only acts, the git mirror off by default, the Notes column's width) `verify-proposals.mjs` (v14: proposals added over MCP, the strips on a scene, a shot, a lyric line and a look, Pick -> the sketch underlay / the frame's base layer / the line text + Ctrl+Z, Mix, "3 more", the free local generator, "Prepare proposals", the wizard offer) and `verify-final.mjs` (v15: the Final list = final_get's rows, filters, the checklist and its gap links, the costs, Approve per kind, Request changes, approve-selected with its cost confirm, Review › Approvals, Lock for render (agent 409) and Unlock) and `verify-takes.mjs` (v16: take selection on ffmpeg placeholder takes: takes_get, take_propose, the cards and hover-scrub, the in / out handles, Pick, the proposal's one-click Pick, alternatives, A/B, the timeline clip column, Final's count, Review › Takes) and `verify-import.mjs` (v17, D8: File › Import media, dropped files, a falgen folder with its jobs and cost, "Use as…" identity / start frame / take, the Media browser's linked / unlinked, the agent's media_import) and `verify-video.mjs` (v18, D3b: the Queue's video form (motion prompt, duration + cost, start / end frame pickers, the H3 date switch), a video run with a failed take and "Retry take 2", the .mp4 outputs as takes, motion control, video one at a time, a stale lock) and `verify-batches.mjs` (v20, D4: Plan waves with a pilot, batches as groups with their gate, Approve batch with the cap impact (agents 403), a locked batch never runs, Run batch within its cap, a pick + a rejection then Mark reviewed unlocks the next wave, the take-ratio stats and the re-estimate, Import job books as history) and `verify-checks.mjs` (v21, D7 / D2: the constants editor (Seed from base, labels, the checklist ticks, save), the "ask for an identity check" switch, one ask per landing, `check_add` and its refusals, the asks absorbed, the badges on nodes and take cards with their hover detail, the switch off) and `verify-composition.mjs` (v22, E9: a test composition with the drop-in reader; take A picked and exported from the page renders frame N as take A at its in-point, take B exported over MCP renders it as take B, pixels from headless screenshots) and `verify-surfaces.mjs` (v24, E2 / F4 / F5: surfaces_get, surface_propose and its refusals, the page-only accept / add / remove in the Shot panel, the surfaces carried forward, the timeline's surface column with uncovered words in red, the Lyrics stage's count, Final's "every word on a surface"; one status filter in Media; one-line help + "?"; every stage at 1280x800 and 1600x900), each runnable alone; `verify-stages.mjs` (F1: stage status from content, per stage empty / partial / done / regressed, the rail screenshots `f1_*.png`; run after it by `npm run verify`)), `security-test.mjs`, `security-composition.mjs` (E9: private media never exported, export path traversal refused), `sketch-test.mjs` (+ `sketch-dev.html`), `tiny-png.mjs` (test PNGs), `fake-falgen.mjs` (a fake falgen output tree for the D8 tests: never fal), `mock-fal.mjs` (a mock fal for every runner test: never the real one; its video endpoints check each kind's parameters and answer a placeholder MP4 made with ffmpeg; `failNext` fails one take), `run.mjs` (the runner CLI), `make_demo.mjs`, `chrome.mjs`, `face-score.md` (how an optional local face-embedding tool could fill `checks.score`; nothing built) |
| `exporters/hyperframes-html/` | HTML package of a HyperFrames composition: `export.mjs`, `verify.mjs`, `serve.mjs` (see Export) |
| `exporters/composition-data.mjs`, `exporters/composition-data/reader.js`, `lib/ops/composition.mjs`, `core/compexport.js`, `docs/COMPOSITION_ROUNDTRIP.md` | E9, the round trip with the composition: the export of the picks as ONE versioned JSON (`buildEdl`, pure; `exportComposition`, writes `data/<p>/exports/<out>` only; CLI), the drop-in dependency-free reader a HyperFrames composition includes with `<script src>` (`WB_EDL.load / from`, `at(t)`, `shot(id, t)`, `use("G05@20158", t)`: a pure function of time), the ops `composition_export` / `composition_get`, File › Export composition data… (the dialog: counts, the file map, the file; remembered in `settings.json` `composition`), the format and the (not applied) adoption proposal for `project/clip/xp/world.js` |
| `data/<project>/` | one folder per project; only `data/_template/` and `data/demo/` are in git |

**Where to add an op or a tool.** Each domain has one ops file and one tools file, so agents working on different domains
never edit the same file. Helpers used by several domains go in `lib/ops/_shared.mjs` (or are exported from the domain
that owns them and imported by the others); ops call each other through `ops.<name>`, never by import.

| domain | ops (`lib/ops/`) | tools (`mcp/tools/`) | what |
|---|---|---|---|
| core | `core.mjs` | `core.mjs` | code version (stale server), projects, snapshots (restore carry-forward), `song_get`, `timeline_query`, the media index (`media_list` (filters `linked` / `private`) / `media_add` / `media_update`), `scrubPrivate`; tools also `status`, `projects`, `wait_for`, `ui_focus` |
| media import (D8) | `media.mjs` | `media.mjs` | existing images and video: `media_scan` (read only: a media-root file / folder, its `job.json` jobs: prompt, model, refs, takes, cost and where the cost stands), `media_import` (register in place), `media_upload` / `media_use` (page only: no tool); `sniff`, `rootPath`, `readJob`, `jobCost`, `linkShotMedia` / `shotMediaLinks` (a shot's take / start frame, what D6's take picker reads) |
| notes | `notes.mjs` | `notes.mjs` | ONE notes model for every stage and the timeline (notes.json v2): `notesDoc` (migrates the old stores on first read), `checkTarget`, `addNote` / `replyNote` / `setStatus` (the other domains' note tools call these), `notes_get` / `notes_add` / `notes_status`, and the old timeline tools `notes_list` / `note_add` / `note_resolve` |
| requests, approvals, costs | `requests.mjs` | `requests.mjs` | the recipe file, `requests_list` / `request_create` / `request_update`, `request_run` / `generators_get` (the runner: `lib/run.mjs`, `generators/`), `approvals_get` / `set_states` (tool `request_changes`; approving is the page's: no tool), `costs_get`, `cost_record`, the falgen merge |
| stages, lyrics | `lyrics.mjs` | `lyrics.mjs` | `stages_get` / `stage_update`, `startStage`, stage 1 (`lyrics_*`, `song_attach`), `createGuidedProject` |
| script, scenes, sketches | `scenes.mjs` | `scenes.mjs` | stage 2: `script_get`, `scenes_update`, `scene_note_*`, `intake_*`, `sketch_*` |
| breakdown | `breakdown.mjs` | `breakdown.mjs` | stage 3: `breakdown_*` (`breakdown_promote` is page only: no tool) |
| assets, characters | `assets.mjs` | `assets.mjs` | entities (`entities_list`, `entity_get`, `entity_upsert`) and stages 4-5 (`asset_*`, `character_*`, `look_create`, `variant_create`, `base_propose`, `node_import_propose`; `asset_act` / `character_act` / `ref_upload` are page only: no tool) |
| storyboard | `storyboard.mjs` | `storyboard.mjs` | the shots.json shots (`shots_list`, `shot_get`, `shot_update`) and stage 6 (`storyboard_get`, `shots_update`, `shot_note_*`, `gaps_get`) |
| proposals | `proposals.mjs` | `proposals.mjs` | sets of free choices on a target (`proposals_add` with the SVG sanitiser, `proposals_get`; `proposal_act` is page only: no tool), the free local generator (`proposals_local`) |
| final approvals | `final.mjs` | `final.mjs` | stage 7: `final_get` (read only: the pending rows, the checklist, the costs, the lock), `final_lock` / `final_unlock` (page only: no tool), `lockGate` (a locked project refuses agent writes: serve.mjs and the MCP offline path call it) |
| batches, waves, job books (D4) | `batches.mjs` | `batches.mjs` | `batches_get` (read only: gates, totals, verdicts, the take ratio, the remaining waves re-estimated, the history), `waves_plan` (tool `waves_propose`: draft requests + draft batches from the storyboard gaps), `batch_act` and `jobbooks_import` (page only: no tool); the runner's gate (`js/batches.js` `gateRefusal`) |
| take selection | `takes.mjs` | `takes.mjs` | D6: `takes_get` (read only: a shot's / request's takes with fps and duration, the pick, the proposals), `take_propose` (the agent's proposal, takes.json), `take_act` (page only: pick / unpick / dismiss; no tool) |
| identity checks (D7) | `checks.mjs` (+ `_hooks.mjs`) | `checks.mjs` | `check_add` (the agent's vision check of a node / take / media against a character's constants checklist: checks.json only, never an approval or a pick), `checks_get` (read only: checks, the badge per target, the open asks, the checklists), `askIdentityCheck` (the "identity check" ask when outputs land, on `settings.json identity_checks`); the constants act is `asset_act constants` (page only) |
| composition data (E9) | `composition.mjs` | `composition.mjs` | `composition_export` (the picks as `exports/<out>` (default `composition/edl.json`): shots, take file mapped under the composition, in / out, looks / variants, placeholders, the song anchors, a checksum; writes nothing else; allowed while locked), `composition_get` (read only: what an export would hold; the page's dialog) |
| lyric gate (E2) | `surfaces.mjs` | `surfaces.mjs` | `surfaces_get` (read only: every lyric word covered or not, the uncovered runs, the surfaces per shot, the proposals), `surface_propose` (the agent's proposal: surfaces.json), `surface_act` (page only: accept / dismiss / reopen a proposal, add / remove a surface: shot.lyrics through a new storyboard version; no tool) |
| rounds, revisions | `rounds.mjs` | `rounds.mjs` | review rounds (`round_get`, `round_absorb`, `round_reply`, `round_finish`; `round_send` is page only: no tool) and revisions R<n> (`revisions_get`, `revision_compare`; `revision_close` / `revision_restore` are page only: no tool), the opt-in git mirror |

A new domain: a `lib/ops/<domain>.mjs` imported (or re-exported) by `lib/store.mjs`, and a `mcp/tools/<domain>.mjs`
imported by `mcp/server.mjs`.

## Project files (`data/<project>/`)

All times are **integer milliseconds**; no pixels are ever stored. A media path under a configured media root is
relative to the media base; any other path is relative to the project folder. Full shapes: README "Files"
(also the MCP resource `workbench://docs/file-formats`).

- `song.json`: duration, bpm/grid, `audio {mix, render, stems[]}`, `sections[{id, label, t0, t1, energy, ...}]`,
  `lines[{id "section/n", t0, t1, text, voice, words[{w, t0, t1, p}]}]`. Written by importers.
- `events.json`, `energy.json`, `peaks/*.json`: importer output.
- `script.json`: `lines[{id "s07", t0, lyric, mode W|S|B|W→S, action, line_id}]`.
- `shots.json`: `shots[{id, t0, t1, section, kind, title, cast[], locations[], clips[use ids], thumb}]` and clip
  `uses[{id "G05@20158", clip, take, in_ms, t0, t1, file, start_image, location, thumb}]`. Importer output, never
  rewritten: the storyboard (stage 6) is `storyboard.json`, which reads as v1 from these shots until its first write.
- `entities/{characters,locations,props}/<id>.json` + `entities/index.json`: characters carry `looks[]` (status draft /
  review / approved; approved only from the page). Stage 4 adds to a character `base{text, refs[{path, source:
  catalog|openverse|photo|sketch|media, private?, licence?, creator?, url?, ...}], at, by, via}` (the director's) and
  `iter{nodes[{id "n03", tree "identity"|"look:<id>", parent, from_identity?, image, request, kind, edit{text, sketch?,
  png?, mask?, pins[]}, choice null|kept|branch|reverted, private?, at, by, via}], trees{<tree>: {head, approved?}},
  notes[], log[]}`: append-only iteration trees (nodes never change except the director's `choice`; every act is
  logged). `catalog/...` ref paths are relative to the workbench folder. Stage 5: locations and props carry the same
  `base` / `iter` (trees `"base"` and `"variant:<id>"`) and `variants[{id, name, axes{angle?, tod?, weather?} |
  {angle?, state?}, notes, images[], status draft|review|approved, from?, scenes?[]}]`; any asset may carry
  `uses{<scene>: {variant: <variant / look id> | null, by, via: "page", at}}` (the variant each scene needs: the
  director's pick, else the agent's proposal in `variants[].scenes`, else the base; `asset_get` `scenes` resolves it).
  Logic: `js/assets.js` (shared), `js/characters.js` (stage-4 names). Reference images: `refs/<id>/` (Openverse, with
  provenance), `private/refs/<id>/` (the director's photos, always private).
- `media.json`: every generated/imported file with kind, links (entities, shots, uses, job, take, `request?`), status, thumbnails;
  an imported one carries `imported{by, via, at, from: "in place" | "upload", name?}`, and the director's "use as" `use_as[{shot, as:
  take | start_frame, by, via, at} | {entity, tree, node, as: identity | look | base | variant, ...}]`. A shot's start frame is also
  its `thumb` in a new storyboard version. Imported in place = a base-relative path under a media root; uploaded = `media/<kind>/`
  or `private/<kind>/`.
- `notes.json` (shared, v2): ONE list of notes for every stage and the timeline, `{v: 2, rev, round, notes[{id, target{stage,
  kind, id, w?, quote?, t?, pin?{x, y}, line?, scene?}, text, by, via: page|agent|import, status: open|absorbed|dismissed,
  round, replies[{id, text, by, via, at}], absorbed_in, created, to?: "agent", ask?: request|fill_gaps|extract|storyboard|round,
  gaps?, version?, marker?, about?, legacy?{store, id}, closed_by?, closed_via?, closed_at?, change?{stage, file?, version?,
  summary, at, by}}], legacy_seen[]}`. Targets per
  stage: lyrics `stage` / `section` / `line` (+ `w` [first, last word], `quote`); script `stage` / `scene` / `beat`
  (`"sc02/b1"`); breakdown `stage` / `item` / `scene`; characters and scenery `stage` / `asset` / `tree`
  (`"ada/look:x"`) / `node` (`"ada/n03"`, + `pin` 0..1 on its image) / `use` (`"ada/sc02"`: the asset in a scene);
  storyboard `stage` / `scene` / `shot` (+ `scene`); final `stage` / `shot`; timeline `time` (`t` ms, `line`). `absorbed` =
  handled (the agent did what it asks, or the director marked it done); `dismissed` = dropped (only the director dismisses
  the director's notes); `round` is the review round being collected (a note's `round`: the one it was written in);
  `absorbed_in` = the revision a round's note was absorbed in, `change` = what the agent changed for it (`round_absorb`). **Migration:** the first read (`notesDoc`, or the
  page in memory on a static host) reads the old stores into it without loss: notes.json v1 (kept as `notes.v1.json`;
  a `reply_to` note becomes a reply), the `notes` of lyrics.json / scenes.json / breakdown.json / storyboard.json and every
  entity's `iter.notes` (ids kept; a clash gets `-2`). Those files are never written for notes again; a note added to one
  later (an older page, a hand edit) is imported once, and a migrated note the director deleted stays deleted
  (`legacy_seen`). The old note tools are aliases that write v2 and answer in their old shapes. Logic: `js/notes.js`.
- Shared with the page, each `{rev, ...}`: `notes.json`, `approvals.json` (`"kind:id" -> {state}`; states draft,
  review, changes, approved, locked), `requests.json` (the generation queue; a stage-4 / 5 generation carries `asset{type, id,
  tree, from, kind: identity|base|edit|look|variant, text?, sketch?, png?, mask?, pins[]}` (the old `char` link is still
  read, never written), `warnings[]?` (request_create's, shown on the request card), `recipe?{id, version, model, framing,
  fields, blocks[{id, label, text}], negative_prompt?}` (made from the photoreal recipe), `takes?`, a video request's
  `video{model: h3max|kling3pro|klingmc, start, end?, ref_video?, seconds, orientation?}` (refs = [start, end?, ref_video?]),
  and the runner's `generator`, `linked{type, id, tree, nodes[], proposals[]}`, `handoff{generator, pack, results}`,
  `last_run{at, status, why}`, `takes_failed[]?` (a done request's takes that failed: retake them), `retaking?` (a retake
  in flight), `superseded_by[]?`, `history?{source: "falgen", book, job, dir, files, registered, notes?, after?, cost{status, source, usd, counted}}` (D4: a request imported from a
  job book: done, never run again, no new cost); statuses draft, approved, queued, running, done, failed, rejected (the director said no), withdrawn
  (its author took the draft back: the agent its own, the director theirs in the Queue; back to draft re-opens it)), and (D4) `batches[{id "b02",
  name, wave, request_ids[], shots[], gate{after: <batch id> | null, rule: "review"}, status: draft | approved | reviewed, max_usd? (the batch cap,
  its total when approved), verdicts{<request id>: {verdict: rejected | kept, by, via, at}}, by, via, at, approved_at?, reviewed_at?, stats?}]` (the
  server's only: written by `waves_plan` / `batch_act`; a page save keeps the server's copy, and drops a forged `history`), `overrides.json`,
  `settings.json` (also `generators{image, video, motion}`: Settings > Generator; `falgen`: Settings > costs, the falgen folder;
  `identity_checks: true`: the "ask for an identity check when an output lands" switch of the Characters stage, off by default).
- `gen/<request>/<id>_<take>.<ext>` + `job.json` (+ `pack/`, `results/` for "Open in another app"): the runner's
  outputs (`private/gen/...` when a ref is private; video `.mp4`); `job.json` has the provider job ids, per-take status /
  cost (a video take: seconds, fps, duration_ms), `video`, `retakes[]`, no key. `.lock` = the run holding it (pid, heartbeat).
- `costs.json`: `cap_usd`, `items[{id, t, usd, tool, date, request?, via?, job?, take?, note?, generator?}]` (`via`: spend
  recorded with `cost_record`, outside the queue; `via: "runner"`: a request the runner ran, item id = the request id; `takes`: the
  job made that many takes). `project.json` (or the page: Settings > costs, `settings.json` `falgen`; project.json wins) may name
  `"falgen": "<dir>"` (or `{dir, ledger}`, relative to the media base, inside it; read only): `costs_get` merges its `spent.json`
  and the `via falgen` rows of its `LEDGER.md`. Not linked: `falgen.linked: false`, and a warning names any `<media base>[/*[/*]]/gen/spent.json`
  found (its spend is then not in the total).
- Stage-4 / 5 `iter` also holds the agent's proposals: `base_proposal{text, refs, why, by, via, at}` and
  `proposals[{id "ip01", kind: import, tree, media, path, why, provenance, status: open|accepted|dismissed}]`; a node the
  director imported has `origin: "imported"`, `kind: "import"`, `request: null`, `provenance{media, path, job?, take?,
  request?, cost: {source: workbench|falgen, usd, …} | null}` (a job of several takes: `usd` is this take's share, with `job_usd`,
  `takes`, `take`; the takes of one job sum to it once). A character may carry `constants[]`: the details that must stay
  identical ("a silver ring on the LEFT ring finger"); the photoreal recipe puts them into the identity lock. Each is a string (older
  files) or `{text, check (default true: on the identity checklist of D7), label? (a short name for the badge: "clip side")}`;
  the director edits them in the Characters stage (Identity tab: "Constants", "Seed from base", `asset_act constants`, page only),
  an agent with `entity_upsert constants[]` (cleaned the same way: blank / duplicate dropped, at most 24).
- `checks.json` (the server's only; the page reads it): identity checks (D7), `{v: 1, rev, checks[{id "ck03", target{kind: node |
  take | media, id: "ada/n05" | "<shot>/<media id>" | "<media id>"}, against{entity, node, image}, by, via: "agent", verdict: ok | drift |
  fail, items[{constant, ok, note?}], note, score?{model, value, threshold?, metric?}, created}], asks[{note, entity, against, files[{file,
  from?, media?, node?, request?, target, source}], source, at}]}`. `asks` = the "identity check" asks the server wrote (each output once).
  `score` is the optional local face-embedding score (`tools/face-score.md`); nothing in the workbench computes it. Logic: `js/checks.js`.
- `stages.json` (shared, `{rev}`): the guided flow, `stages[{id, status: empty|in_progress|needs_you|done, done_by,
  via, updated, blockers[], note?, done_ok?}]` for lyrics, script, breakdown, characters, scenery, storyboard, final. Missing =
  derived from the files (content = in_progress, never done). Only the page sets `done` (`done_ok`: was the content ready
  then). What the rail shows is computed from the content (`js/flow.js` `stagesView`: `shown` empty | in_progress |
  needs_you | ready | done | changed, `content{status, blockers, hints, counts}`, `changed` = why a done stage no longer
  holds); "approved" for an asset means its identity / base tree has an approved node (`assetApproval`; an older Assets
  approval without one reads "approved (legacy) · no identity node").
- `lyrics.json` (shared, `{rev}`): stage 1. `current`, `versions[{id "v3", created, by, via, message, from?,
  sections[{id, label, lines[{id, text}]}]}]` (immutable; a save appends), `notes[{id "ln01", line, w [first, last
  word], quote, text, by, via, to?: "agent", status, replies[]}]`. Line ids are stable across versions and equal the
  `song.json` line ids; the server re-syncs `song.json` lines whenever `current` changes (timings kept for lines that
  still exist, new ones estimated). Missing = v1 derived from `song.json`. Shapes and logic: `js/flow.js`.
- `scenes.json` (shared, `{rev}`): stage 2, the script draft. `current`, `versions[{id "v3", created, by, via, message,
  from?, scenes[{id "sc03", t0, t1, title, text, line_ids[], beats[{id "b1", t, text}], sketches[ids]}]}]` (immutable;
  a save appends), `states{<scene id>: {status: draft|needs_you|ok, by, via, at}}` (outside the versions; `ok` only from
  the page), `notes[{id "sn01", scene|null, beat?, text, by, via, to?: "agent", kind?: request|fill_gaps, gaps?[[t0,
  t1]], status, version, replies[]}]`, `intake{mood|kind|who|where|era|refs|must|mustnot|budget: {text, by, via, at,
  asked?}}`. Scenes are bound to song time (t0 < t1 ms; `line_ids` = the song lines starting inside). Missing = v1
  derived from `script.json` (its `stages` become scenes, its `lines` their beats); `script.json` itself is never
  rewritten and its readers (the timeline script column, `timeline_query`) keep working. Logic: `js/scenes.js`.
- `breakdown.json` (shared, `{rev}`): stage 3, what the script needs. `current`, `versions[{id "v3", created, by, via,
  message, from?, script?, items[{id "bi03", kind character|location|prop|wardrobe|fx, name, description, links[{scene
  "sc02", beats[], note?}], source agent|director, aliases?[], for?: <character item id> (wardrobe), dropped?: true}]}]`
  (immutable; a save appends; `script` = the script version it was made from), `states{<item id>: {status:
  draft|review|ok, entity_id?, look_id?, by, via, at}}` (outside the versions; `ok` and `entity_id` / `look_id` only from
  the page), `notes[{id "bn01", item|null, scene?, text, by, via, to?: "agent", kind?: request|extract, status, version,
  replies[]}]`. Links name scene and beat ids of `scenes.json` (scene ids are never reused). Missing = no breakdown yet.
  Logic: `js/breakdown.js`.
- `storyboard.json` (shared, `{rev}`): stage 6, the storyboard. `current`, `versions[{id "v3", created, by, via, message,
  from?, script?, shots[{id "sh03", scene, t0, t1, kind, title, text, camera, sketch, beats[], cast[], locations[],
  props[], variants{<entity id>: <variant / look id> | null}, gen: still|video|null, clips[], thumb?, section?, clip?, lyrics?}]}]`
  (immutable; a save appends), `notes[{id "sbn01", shot|null, scene?, text, by, via, to?: "agent", kind?:
  request|storyboard|fill_gaps, gaps?, status, version, replies[]}]`. The shots of a scene TILE it (first starts with
  the scene, each ends where the next starts, last ends with it) on the beat grid; kinds wide / medium / close / insert
  / performance / xp-desktop (or another short word); the asset chips are entity ids, the variant each needs is the
  scene's (the entity's `uses`, else the agent's proposal, else the root) unless the shot's `variants` overrides it;
  `gen` = what it needs generated (default: insert / xp-desktop a still, else a video = a start frame + image-to-video).
  A shot's approval is `approvals.json` `shot:<id>` (approved / locked only from the page). A generation for a shot is a
  request with `target: "shot:<id>"` (kinds `shot-still`, `shot-video`). Missing = v1 derived from `shots.json` (ids,
  thumbs, clip uses kept; each shot in the scene at its middle); the timeline shots / cast / status columns read the
  storyboard. A shot's `clip` is the director's picked take (D6): `{request, take, file (a registered media path), media,
  kind: video|image, in_ms, out_ms (inside the take; a still: 0 / null), note, alt[{take, file?, t (song ms), note}], by, via:
  "page", at, proposal?}`, written only by `take_act` (page only) as a new version; every other save (a page save, the agent's
  `shots_update`, a restore of an old version by the agent) carries the current picks forward unchanged. A shot's `lyrics` is the lyric
  gate (E2): `[{line (a song line id), w? [first, last] word index (none = the whole line), where: "<kind>" | "<kind>: <detail>"}]`, kind
  window | chat | dialog | karaoke | taskbar | other, ≤ 120 characters: where those words show on screen during the shot; written only by
  `surface_act` (page only) as a new version and carried forward like the picks. A word is covered when a surface of a shot whose time
  overlaps the word's names it. Logic: `js/storyboard.js`, `js/takes.js`, `js/surfaces.js`.
- `sketches/<id>.json|.png|.mask.png`: sketches (vector strokes + pins + metadata, the flattened image, the edit mask),
  written by `sketch_save` and registered in `media.json` (kind `sketch`, links `scenes` / `entities` / `shots`);
  under `private/sketches/` when drawn over a private underlay. Not snapshotted (the script versions point at them).
- `.snapshots/<stamp>-<slug>/`: durable snapshots of the small JSON files (not revisions.json, settings.json, .history).
- `revisions.json` (the server's only; the page reads it): review rounds and revisions, `{v: 1, rev, rounds[{n, status:
  sent|finished|closed, sent_at, sent_by, notes[ids], ask, base (snapshot when sent), finished_at?, summary?, closed_at?,
  revision?}], revisions[{id "R3", n, round, created, summary, notes_absorbed[], notes_replied[], files_changed[], cost_usd,
  cost_delta, snapshot, base, by, via, git?}], restores[{at, revision, previous}], lock?: {at, revision, snapshot, summary, by, via, ready, failing?, pending} | null, locks[]}` (a revision may carry `final: true`: the one "Lock for render" closed). A revision's snapshot (`.meta.json`
  `revision`, `immutable`) is never changed; a restore snapshots the current state first and keeps notes.json. With
  `settings.json` `revisions_git: true` and git on PATH each revision is also a commit in `.history/` (a repository of its
  own). Logic: `js/revisions.js`, `lib/ops/rounds.mjs`.

- `takes.json` (the server's only; the page reads it): the agent's take proposals, `{v: 1, rev, proposals[{id "tp03", shot, request,
  job, take, file, media, kind, in_ms, out_ms, why, by, via: "agent", at, status: open|picked|dismissed, decided_at?}]}`. A take is
  a registered media file (not render / audio / sketch) linked to the shot (`shots`), its clip uses (`uses`, the use's clip as
  `job`) or a request targeting `shot:<id>` (`request` / `job`). Logic: `js/takes.js`, `lib/ops/takes.mjs`.
- `surfaces.json` (the server's only; the page reads it): the agent's lyric-surface proposals (E2), `{v: 1, rev, proposals[{id "sp03", shot,
  line, w?, where, why, by, via: "agent", at, status: open|accepted|dismissed, decided_at?, decided_by?}]}`. Logic: `js/surfaces.js`.
- `proposals.json` (the server's only; the page reads it) + `proposals/<set>-<item>.svg`: proposals, `{v: 1, rev,
  sets[{id "ps03", target{stage, kind, id}, round, by, via, source: agent|local, created, answers?[note ids], items[{id "a",
  title, why, svg?: "proposals/ps03-a.svg" (sanitised) | text?, status: open|picked|mixed|dismissed, note? (a mix), at?, by?,
  via?}]}]}`. Targets: lyrics `line` / `section`; script `scene` (sketch layouts, scene ideas); storyboard `shot` (frames) /
  `scene`; characters / scenery `asset` / `tree` (`"ada/look:x"`, `"studio/variant:dusk"`). One pick per set; picks, mixes
  and dismissals are the director's (page only). Logic: `js/proposals.js`, `lib/ops/proposals.mjs`.

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
node exporters/hyperframes-html/export.mjs <compositionDir> <outDir> --interactive   # web package: lazy media on
node exporters/hyperframes-html/verify.mjs <outDir> --against <same export without lazy> --every 2 --seams
```

- Never edit composition files in the package. The exporter only rewrites root-absolute paths, the player's CDN
  runtime URL (to the vendored runtime) and, with lazy media, the package's entry HTML. Each rewrite is listed in
  `manifest.rewrites`.
- Lazy media (`--lazy-media`, default with `--interactive`; `--no-lazy-media` to skip; `lazy/build.mjs <out> --off`
  undoes it): `lazy/lazy-media.js` and its schedule (`usage.visible`) go inline in the package's entry HTML. It parks
  the `src` of large images and videos until about 15 s before they show (the first 10 s load first) and parks far
  files again over a 150 MB budget. The interactive layer waits for the opening before `IX.ready` and holds the clock
  while the playhead's files load. It must leave every frame identical: check with `verify.mjs --against <the export
  without it> --every 2 --seams`. See the exporter README, "Lazy media".
- No trimming, re-encoding or custom boot screens in the package. Compression is a separate, later step that reads
  `manifest.json` and must pass `verify.mjs` against the same render again.
- `manifest.fonts.system_fonts` lists text that relies on fonts installed on the viewer's machine. Report it when
  delivering.

**The way back (E9): the picks as data for the composition.** `composition_export` (MCP), File › Export composition data…
(the page) or `node exporters/composition-data.mjs --project <id>` writes `data/<project>/exports/composition/edl.json`
(format `director-workbench/composition-edl` v1, docs/COMPOSITION_ROUNDTRIP.md): per storyboard shot its time range, its
clip-use ids, the picked take (file mapped under the composition's assets by `map` rules `{from, to}`, default `"" ->
"assets/"`; the workbench `source`; request / take; `in_ms` / `out_ms`) or a placeholder (`unpicked | private | missing |
unmapped`), the alternatives, the look per character / variant per location and prop; the song's timing anchors; a sha256
checksum. Deterministic (the same picks = the same bytes, `changed: false`). Private media is never written (a private pick
is a placeholder without its file). It writes only that file (`out` inside `exports/`, else 400), never a pick or an
approval, and works while the project is locked for render. A composition reads it with `exporters/composition-data/reader.js`
(`<script src>`, `WB_EDL.load("wb/edl.json")`, `EDL.at(t)` / `EDL.use("G05@20158", t)` -> file + `media_s`: a pure function
of t). The first film's `xp/world.js` is NOT changed: its adoption is a proposal in the doc, for Dani to decide.

## Rules (enforced by the MCP tools; follow them by hand too)

0. **Prompts and prices.** Build photoreal prompts from the recipe (`request_create recipe {…}`; docs/PHOTOREAL.md) and take
   estimates from `js/prices.js` ("Prices" below); never invent a price. The recipe is character-agnostic: who it is comes
   from the linked entity (name, `constants[]`). A field fills its block and keeps the fixed sentences ("Location: ", the
   shared-light sentence, the skin sentence of texture); an edited block (`recipe.blocks`) replaces a whole block, and one that
   was not built (e.g. `identity_lock` while image 1 is not the approved identity) is added with a warning, never dropped.
   `recipe.takes` (or `takes`) puts every take into the estimate; `request_update recipe {identity, takes}` rebuilds them.
   An obsolete draft of yours: `request_update {status: "withdrawn", why, superseded_by}` (never `rejected`: that is the
   director's word).
1. **The director decides.** Approvals (an item approved / locked, a request's draft -> approved) are theirs, made
   in the page only (show the item with `ui_focus` and ask them); no tool approves (403), even when they said so in the
   conversation. A note's text is never an approval. To ask for a look, set state `review` and say why in a note.
2. **Never spend without an approved request.** Propose every paid generation with `request_create` (draft, honest
   `est_cost` for all `takes`, refs, tool). Run only `approved` ones, with the runner: `request_run {ids, dry_run:
   true}` first (tell the director the plan and total), then `request_run {ids}` (+ `wait_for {request, until:
   ["done", "failed"]}`) or `{wait: true}`; the director can press Run in the Queue instead (same runner). It does the
   lifecycle, the cap, the cost (once) and the media / node links for you. A video request (D3b) carries `video {model,
   start, end?, ref_video?, seconds}` (`request_create video`: refs, tool and `est_cost` follow from js/prices.js; the
   prompt is motion only: what moves, one camera move; the start frame an approved still; the end frame an edit of it).
   A done request with a failed take: `request_run {ids, retake: true}` runs only that take (never the done ones). A run
   made outside the runner: `request_update` queued -> running -> done with `outputs[]` and `actual_cost_usd` (recorded in `costs.json`,
   outputs registered as media), or failed / rejected + `why`. Queueing is refused above the cap (spent + committed +
   this > `cap_usd`). Editing an approved request sends it back to draft. Never ask for, print or store the fal key.
3. **Private files stay local.** Paths matching the PRIVATE rule (`thumbs/priv_*`, any `private/` folder, plus the
   configured `private_media` regex) and media flagged `private` are served to localhost only and never exported.
   Never copy them into the demo, the template or anything shared.
4. **Stages are the director's to close.** Mark your progress with `stage_update` (in_progress, needs_you + a note,
   blockers); `done` is refused, and a done stage cannot be moved by an agent. Lyrics: propose in notes
   (`lyrics_note_add`) or save a new version (`lyrics_update`, never destructive: every version stays); answer the
   director's asks (`lyrics_get` `asks_for_agent`) with a reply and resolve them when done. Script: record intake
   answers only in the director's words (`intake_answer`, `asked_in_chat` when you asked); write scenes with
   `scenes_update` (a new version each time; `ok` on a scene is the director's); "fill the gaps" asks
   (`script_get` `asks_for_agent`, kind `fill_gaps`) mean: cover every listed range with scenes, then resolve.
   Breakdown: `breakdown_get` gives the script to extract from (scene text, beats, sketch pins, intake) and the
   existing entities; write the items with `breakdown_update` (a new version each time; link each to the scenes and
   beats that need it; merge duplicates; `dropped: true` rather than removing what the director made); an ask of kind
   `extract` means draft or refresh the whole breakdown, then resolve it. Item status `ok` is the director's; to ask
   for an entity, set `review` and say why in a note: only the page's "Create entity" makes one (nothing is generated
   or spent by it).
   Characters (stage 4): `character_get` (no id: every character and its status; with id: the base with ref files,
   the trees, the requests with the edit text, pins and sketch / mask files, `to_run`, `to_register`,
   `waiting_for_director`, notes, asks). Every generation is a `request_create` draft with `asset {type: "character", id,
   tree, from, kind}` (`char` is deprecated), refs (the node image first, then the sketch PNG and mask for an edit), the tool and an honest `est_cost`
   (from `js/prices.js`: identity / look sheet $0.12 (NB2 2K), an edit or a masked edit $0.08 (NB2 1K); see "Prices"). Run only approved
   ones (`request_run`: the outputs join the tree by themselves; a run outside the runner: `request_update` queued ->
   running -> done with `outputs` + `actual_cost_usd`, then `character_iteration_add {id, request}`): the node joins its tree; the first one is the head, later ones wait for
   the director. The base, keep / branch / revert, approving / unlocking the identity or a look are the director's, in
   the page (no tool); a look starts from the approved identity (`request_create` warns when a look sheet
   has `from: null` and no identity is approved yet); `look_create` proposes a look in `review`. **The base:** propose it
   with `base_propose {id, text, refs, why}`; the director accepts it in one click ("Accept base"). **An image that
   already exists** (a legacy approved look, an output made outside the queue, e.g. by falgen before a request existed):
   register it (`media_import` for files under a media root, read in place: a folder of falgen outputs (`out/<id>/job.json`)
   comes with its job, takes, prompt and cost; `media_scan` first to see them; or `media_add`, and relabel / re-link with
   `media_update`), record its spend with `cost_record` (`media_scan` / `media_import` give the args as `cost.offer` /
   `costs_not_counted` when the project does not count it yet; never an approval), and propose it as a node with `node_import_propose {id, tree, media, why}` (the identity
   head first; a look import is acceptable once the identity is approved); the director accepts it (origin imported,
   provenance kept) or imports any registered image directly ("Import an image…", or "Use as…" on any media item). A take
   or a start frame for a shot: say so in a note on the shot (`notes_add {target: {stage: "storyboard", kind: "shot", id}}`);
   "Use as…" (`media_use`) is the director's, in the page; a file used as a shot take is then one of that shot's takes in
   `takes_get` (why `use_as`; the start frame is `takes_get.start_frame`), so `take_propose` can name it. Ask with
   `character_note_add` and show it with `ui_focus` view "stage". Never copy a private photo or a node made from one
   anywhere shared.
   Scenery (stage 5): locations and props work the same way through the generic tools (`asset_get`,
   `asset_iteration_add`, `asset_note_add`; the `character_*` tools are the same code with `type: "character"`).
   `asset_get` (no id: every asset by kind; `type` filters) gives the base, the trees ("base" and one "variant:<id>"
   per variant), the variants with their axes, and `scenes`: each scene that uses the asset with the variant it needs,
   its source (director / agent / default) and image: what the storyboard reads. A generation is a `request_create`
   draft with `asset {type, id, tree, from, kind: base | edit | variant}` (kinds location-plate / prop-sheet,
   location-edit / prop-edit, location-variant / prop-variant; estimates in `js/assets.js` EST); a variant's sheet
   starts from the approved base node (refs: its image first). Propose variants with `variant_create` (status
   `review`; a location: axes angle wide / medium / reverse / a word, tod dawn / day / dusk / night, weather; a prop:
   angle, state broken / lit / ...; `scenes` = where you propose it). The base, keep / branch / revert, approving the
   base or a variant and the variant each scene uses are the director's, in the page (`asset_act`, no tool).
   Storyboard (stage 6): `storyboard_get` gives the scenes in song time with their beats, what each needs (`needs`:
   the breakdown's assets and the variant the scene uses) and their shots (frame sketch PNG + pins, the assets with
   their variant, image file and approved or `why` not, status, requests, estimate), the beat grid, the gaps and the
   asks. Write shots with `shots_update` (a new version each time; one shot per scene beat or group of beats, tiled to
   the scene and cut on the grid with `snap: "beats"`; kind, the action, camera / motion, cast / locations / props as
   entity ids, `variants` only where the shot differs from the scene, a frame via `sketch_save` with `links.shots`).
   An ask of kind `storyboard` = propose / complete the shots; `fill_gaps` = draft the generation requests: `gaps_get`
   gives, per shot without a request or clip, the drafts (`shot-still` first, then `shot-video` from its output; target
   `shot:<id>`, refs = the approved variant / look images + the frame sketch, tool, honest `est_cost`), the assets not
   approved yet (propose their sheets first) and the total against the cap; create them with `request_create`, then
   answer the ask (`shot_note_resolve`). A shot's `approved` / `locked` is the director's (403); set `review` and say why
   (`shot_note_add`).
4b. **Notes are one list** (`notes_get`, default status open; `to: "agent"` = the asks): the director's open notes on any
   stage are your to-do list. Answer with `notes_add {reply_to}`; when you did what a note asks, `notes_status {id,
   status: "absorbed", reply: "what changed"}`. Write your own notes with `notes_add {target}` on the row they are about
   (a line + word range, a scene / beat, an item, an asset / node + pin, a shot, a time). You cannot dismiss the director's
   notes, nor reopen one they dismissed (403). The per-stage note tools (`lyrics_note_*`, `scene_note_*`,
   `breakdown_note_*`, `shot_note_*`, `asset_note_add`, `note_add` / `note_resolve`) still work: they write the same list.
4c. **Review rounds.** The director collects notes, then sends a round from the page ("Send round to Claude": every open
   note of theirs as ONE ask, `ask: "round"`; notes.json `round` + 1). `round_get` gives the round's notes by stage with
   the content each points at; apply them with the stage tools (new versions, nothing approved), then per note
   `round_absorb {note, change: {stage, file, version, summary}}` (absorbed, `absorbed_in` = the revision it becomes, the
   change linked for the compare view) or `round_reply {note, text}` (it stays open for the director), and at the end
   `round_finish {summary}`. The page shows your progress live. Closing the revision (R<n>: an immutable snapshot +
   `revisions.json`), comparing and restoring are the director's (page only; no tool). `revisions_get {compare: [a, b]}`
   ("R<n>", "R0" = before the first round, "now") reads the per-stage diff with the notes behind each change.
4d. **Proposals** (free; SPEC v4 §3). Where a choice is visual or open (a scene sketch or idea, a shot frame, a look, a
   location variant, a lyric line), offer the director 3 choices instead of one answer: `proposals_add {target, items:
   [{title, why, svg | text}]}`. An SVG is code you write (composition, framing, rule-of-thirds silhouettes, colour blocks,
   a camera arrow; `viewBox="0 0 160 90"` for 16:9; ≤ 64 KB); the server sanitises it and refuses anything outside its
   allow-list with the reason (fix and retry). A text is a short alternative (a line, a scene idea, a shot action). The
   director picks (an SVG becomes the scene sketch's underlay / the frame sketch's base layer; a text fills the line /
   scene text / shot action in their draft), mixes (a pick + a note to you on the target: apply it like any note) or
   dismisses, in the page only (`proposal_act`: no tool, 403). `proposals_get` gives the sets, `picks` (what they chose,
   with mix notes) and `asks`: a "3 more" on a target is answered by your next `proposals_add` on that target
   (absorbed automatically); a stage-wide "Prepare proposals" ask: add sets where they help most (scene sketches from the
   script, shot frames from the beats, look moods), then `notes_status {id, status: "absorbed", reply}`. Without an
   agent the page's "Make free layouts" (`proposals_local`) makes 3 deterministic layouts per scene / shot.
4e. **Final approvals** (stage 7). `final_get` (read only) is what stands between the project and the render: the
   ready-to-render checklist (`scripted`, `shots`, `frames`, `takes` (every shot has a picked take), `lyrics` (every word on a surface, E2), `assets`, `notes`, `round`, `cap`, `export`; derived from the
   files, never stored, each failing line with its gaps), every row not approved yet grouped by stage (status, why, est /
   spent, open notes), the costs against the cap (the merged ledger) and the lock. Use it to say what is left and to pick
   your next task; approving any of it, and "Lock for render" / "Unlock", are the director's in the page (no tool). A
   **locked** project (`locked` not null) refuses every write of yours with 409 ("locked for render"): reads still work;
   tell the director what you would change and wait for them to unlock.
4f. **Take selection** (D6). The pick is the director's: which take a shot uses, its in / out, a note and the alternatives
   ("take 2, bigger smile: alternative for 139.84 s"), in the page (Storyboard › Shot › takes, or Review › Takes; `take_act`:
   no tool, 403). You review and propose: `takes_get {shot | request}` lists the takes (absolute files to look at, duration,
   fps, the pick, your proposals), then `take_propose {shot, media | file | take (+ request), in_ms, out_ms, why}` (in / out in
   ms or m:ss.mmm inside the take; the take must be a registered media file linked to that shot: link an import first with
   `media_update {id, shots}`). The director picks your proposal in one click or picks another. Never write `clip` yourself:
   `shots_update` ignores it (warning) and carries the pick forward; approval stays separate (`shot:<id>`).
4f2. **The lyric gate** (E2). Every sung or spoken word must appear on a desktop surface at its time. `surfaces_get` lists every
   lyric word covered or not (the shot and where), the uncovered runs and your proposals; propose a surface with `surface_propose
   {shot, line, w?, where: "<kind>[: detail]", why}` (kinds window, chat, dialog, karaoke, taskbar, other; the shot on screen while the
   words are sung). The director accepts in the page (Storyboard › Shot › lyrics on screen; `surface_act`: no tool, 403); never write
   `lyrics` yourself: `shots_update` ignores it (warning) and carries the director's forward. Final's checklist line `lyrics` counts it.
4g. **Waves and pilot gates** (D4). Paid generation goes in waves: a pilot first ("a pilot of G02, G07 and G15 to measure the take
   ratio … the rest only after that"), then 2 → 4 → 8 → the rest. `waves_propose {pilot, sizes, takes, dry_run}` turns the storyboard gaps into
   draft requests grouped in draft batches, each gated on the one before (show the dry run to the director first). Only the director
   approves a batch (as a whole: "Approve batch · $X" with the cap impact) and marks it reviewed (every done request's takes picked (D6) or
   rejected), which unlocks the next; both are page only (`batch_act`, no tool: 403). A locked or unapproved batch never runs (the
   runner and `request_update` queued refuse it); `request_run {batch}` runs an approved batch within its cap (`max_usd`). After a wave,
   `batches_get` gives the take ratio (`takes_per_used_shot`, `usd_per_used_s`) and the remaining waves re-estimated from it
   (`remaining[].observed_usd`): tell the director before the next wave. History requests (the first film's job books, imported by the
   director: `jobbooks_import`, page only) are done, never run again and cost nothing new.
4h. **Identity checks** (D7, free). A character's constants (`constants[]`, D2) are the details that must stay identical; the ticked ones
   are its checklist. With the director's switch on (`settings.json identity_checks`, Characters stage), every time outputs land (the
   runner's done, `media_import` / an upload, a node added to a tree or imported) the server writes ONE note for you per character, ask
   `check` ("Identity check: N new outputs of Ada landed …"), listing each output with the target to name and the approved identity to
   compare with; each output is asked about once. Open the files (`checks_get {entity}` gives the absolute paths and the checklist), compare
   each with the approved identity image, and write `check_add {target, against: {entity}, verdict: ok | drift | fail, items: [{constant,
   ok, note}], note}`: one item per constant you looked at (its text, label or index) plus `likeness` (the face as a whole); `ok` only
   when every item holds. When every output of an ask is checked, the ask is absorbed with the results. The director sees a badge on the
   node / take ("identity ok", "drift", "✗ clip side"; hover: the items) and decides: a check never approves, rejects or picks anything.
   Never invent a `score`: it is only for a local face-embedding tool that actually ran (`tools/face-score.md`).
5. **Snapshot before big edits** (`snapshot_save`); a restore snapshots the current state first, so it is undoable.
6. Register every new file (`media_add`, or automatically on `request_update` done) so it shows up in the page.

## Security model (local server)

- The server binds **127.0.0.1** only. `--lan`, `WB_HOST` or config `host` opts in to the network; remote clients
  still cannot write unless `allow_remote_ops` is set, and never get files flagged private.
- Requests must use an allowed **Host** (localhost / 127.0.0.1 / [::1] on the server's port) and, when sent by a
  browser, no foreign **Origin** (blocks CSRF and DNS rebinding).
- Every write (POST) must be `application/json` and carry a token. There are two (S9):
  - the **page token** (`x-wb-token`): per run, injected into `index.html` / `dock.html` as `<meta name="wb-token">` (read
    by `core/token.js`); `WB_TOKEN` fixes it;
  - the **agent token** (`x-wb-agent-token`): kept in `<data folder>/.wb-agent-token` (a dot-file outside every project:
    never served; made once and kept across restarts), or `WB_AGENT_TOKEN`. The MCP server (and so `mcp/client.mjs`)
    reads it from the data folder the server reports and never reads the page. `tools/run.mjs` works on the files (no
    HTTP) and needs no token.
- **Page or agent (S9).** A request is the page (the director) only when it carries the page token, no agent token, this
  server's **Origin** and **`Sec-Fetch-Site: same-origin`** (a browser sends both on a same-origin fetch; curl, Node's
  fetch and the MCP server send neither). Everything else is an agent: a request without the page's Origin is never the
  director. Every page act needs the page: a save that approves (a request draft -> approved, an item approved / locked),
  marks a stage done, sets a scene or breakdown item `ok`, dismisses the director's note or ticks "allow uploading
  private refs", and the ops `take_act`, `surface_act`, `media_use`, `media_upload`, `batch_act`, `jobbooks_import`, `asset_act` /
  `character_act` (base / import accept, approvals, constants), `ref_upload`, `breakdown_promote`, `round_send`,
  `revision_close`, `revision_restore`, `final_lock` / `final_unlock`, `proposal_act`. An agent gets 403 on each
  ("agents use the MCP tools"), whatever `via` its body claims; an agent's save is stamped `by: "agent", via:
  "agent"`, and `/api/restore` without the page is an agent's restore. Every `/api` write answers `x-wb-client: page |
  agent`. Offline mode is unchanged: the MCP server's file ops run with `via` absent (an agent) and never approve.
  Limit: a browser on plain `http://` to a LAN address may not send `Sec-Fetch-Site`, so page acts work from
  localhost; and a local process running as the same user can read either token and forge headers, or edit the JSON
  by hand: the rules are enforced on the MCP and HTTP surfaces, and an agent with a shell is on its honour unless it
  runs sandboxed.
- Only the page's own files are served from the workbench folder (an allow-list: `index.html`, `dock.html`, `app.js`,
  `app.css`, `README.md`, `core/`, `core/sketch/`, `js/`, `tabs/`, and the free starter catalogue `catalog/` (images,
  `catalog.json`, `LICENSES.md`); case-insensitive). The page shell carries a Content-Security-Policy
  with `script-src 'self'` (no inline scripts, no eval; media may also be `https:` / `data:` / `blob:`) and
  `connect-src 'self' https://api.openverse.org` (the stage-4 Openverse search from the browser; every other origin is
  blocked); every other file gets a sandboxing CSP and `nosniff`, so an HTML/SVG file in a project cannot run script in
  the workbench origin. An invalid `?project=` is redirected to the default project. A remote (LAN) client reads the
  project's JSON scrubbed of private paths and items flagged private (`lib/store.mjs` `scrubPrivate`).
- Paths with `..`, `.`, backslashes, NUL, `:` (NTFS streams) or `~<digit>` (8.3 short names) are rejected; dot-folders are never served; private files (by rule or
  `private: true` in `media.json`) live under `private/<kind>/` and are never exported or packaged.
- Rounds and revisions: `round_send`, `revision_close` and `revision_restore` are page only (via "page" from this server's
  Origin; no MCP tool; 403 to the agent surface and offline); `revisions.json` is not a page save (403); a page save of
  `notes.json` keeps the server's `round`, a note's `round`, `absorbed_in` and `change`; `round_absorb` checks the note is
  in the round in flight and its change (known stage, a project file without `..`, a version word, a summary); `/data/`
  never serves a dot-folder or dot-file (`.snapshots`, `.history`); the git mirror is opt-in (`settings.json`
  `revisions_git`) and always names its own repository (`--git-dir=data/<p>/.history/.git`), with hooks off (an empty
  `core.hooksPath` of the server's), `core.fsmonitor=false`, and only if `.history/.git/config` holds nothing but the keys
  `git init` writes (a filter, alias, pager, fsmonitor...: skipped with the reason) and no `info/attributes`; a repository
  git refuses as another user's (safe.directory) is skipped, never forced.
- Proposals: `proposal_act` (pick / mix / dismiss / reopen / restore) is page only (via "page" from the page (S9: this server's Origin + Sec-Fetch-Site);
  no MCP tool; 403 to the agent surface, a foreign Origin and offline); `proposals.json` is not a page save (403).
  `proposals_add` checks the target (a known stage / kind for proposals, the row exists now: 404), 1-6 items, a title, a
  why ≤ 300, exactly one of svg / text; every SVG goes through `lib/svg-sanitize.mjs` (an allow-list of elements and
  attributes, re-serialised from the parsed tree; no script, foreignObject, image, a, style element, animate / set, on*,
  href except `#id` on `<use>`, url() except `url(#id)`, javascript: / data: anywhere even entity-encoded, CSS escapes /
  expressions, DOCTYPE / entities / CDATA / processing instructions, more than 64 KB, a viewBox outside 0-10000 or
  1:4-4:1: 400 with the reason); the page shows an SVG only as `<img src>` (never inline), served with the sandboxing
  CSP (tools/security-test.mjs runs a battery of SVG XSS payloads, and a hand-written SVG with script shown in the page).
  Titles, whys and texts are rendered escaped.
- Take selection (D6): `take_act` (pick / unpick / dismiss / reopen) is page only (via "page" from this server's Origin; no MCP
  tool; 403 to the agent surface, a claimed via "page", a foreign Origin and offline). A pick (and `take_propose`) must name a
  registered media file of the project (media.json; not a path, not a render / audio / sketch) that is a take of that shot, with
  0 <= in < out <= its duration (media.json `duration_ms`, else ffprobe; unknown: refused); a still has no in / out; an
  alternative's time lies inside the song and its file is registered; request / take / kind come from the media entry, never
  from the caller. A page save of `storyboard.json` keeps the server's picks (a forged `clip` is replaced or dropped) and the
  agent's `shots_update` ignores `clip`. `takes.json` is not a page save. Notes render escaped (tools/security-test.mjs).
- The lyric gate (E2, `lib/ops/surfaces.mjs`): `surface_act` (accept / dismiss / reopen a proposal, add / remove a surface) is page only
  (via "page" from this server's Origin + Sec-Fetch-Site; no MCP tool; 403 to the agent surface, a claimed via "page", a foreign Origin and
  offline). A surface (and `surface_propose`) names a shot of the current storyboard, a song line, a word range on it, a `where` that starts
  with a known kind (window / chat / dialog / karaoke / taskbar / other), ≤ 120 characters without control characters, and words sung
  during the shot (else 400 / 404). A page save of `storyboard.json` keeps the server's `lyrics` (a forged one is replaced or dropped)
  and the agent's `shots_update` ignores `lyrics`; `surfaces.json` is not a page save (403). `where` and `why` are stored as text and
  rendered escaped (the Shot panel, the timeline's surface column, the Lyrics stage, Final; tools/security-test.mjs).
- Identity checks (D7, `lib/ops/checks.mjs`): `check_add` writes `checks.json` only (and absorbs a finished "identity check" ask): never
  approvals.json, requests.json, the storyboard (picks) or takes.json, whatever the body carries (`status`, `approve`, `director_approved`,
  `via: "page"`: ignored; stored `via: "agent"`). Its target must exist now (a node of that entity, a registered media that is a take of
  that shot, a registered image / video: 404; ids are checked by shape: 400) and so must the character and the node compared with; each
  item names one of the character's constants or `likeness` (400); `ok` with a failed item is 400; a `score` must be `{model, value}`
  (400). `checks.json` is not a page save (403). The constants act (`asset_act constants`) is page only like every `asset_act`;
  `entity_upsert constants[]` is cleaned (strings / `{text, check, label}`, ≤ 200 / 40 characters, ≤ 24). The asks are written only with the
  director's `identity_checks` switch (`settings.json`, a page save). Check notes, item notes and constants render escaped (badge, hover,
  editor; tools/security-test.mjs). Nothing downloads or runs a face model.
- Final approvals (stage 7): `final_get` is read only; the Final list approves through the page's own paths (page saves,
  `asset_act`, the rail's Mark done), so the agent surface keeps its 403 on approvals. `final_lock` / `final_unlock` are page
  only (via "page" from this server's Origin; no MCP tool; 403 to the agent surface, a claimed via "page", a foreign
  Origin and offline). While `revisions.json` `lock` is set (only the server writes that file) every write without this
  server's Origin gets 409 + why: `/api/op/*` except reads (`*_get`, `*_list`, `*_versions`, `*_query`, `*_compare`, a
  `request_run` dry run), `/api/save/*`, `/api/restore`, deleting the project; the MCP offline ops and `snapshot_restore` call the same
  `lockGate`. The page still saves (the director may change anything, then unlock). Like every page-only act, a local
  process holding the token could forge the Origin: this guards the tool surface.
- Notes (`notes.json` v2): `notes_add` checks the target (known stage and kind; ids without `..`, `.`, `\` or markup;
  the row exists in the current version: 404; word ranges on the line, `t` inside the song, pins 0..1; text 1-8000
  characters; else 400). An agent may reply, absorb (with a reply) and reopen, and dismiss only its own notes: a director's
  note cannot be dismissed (403, HTTP / MCP / offline), nor reopened once the director dismissed it. A page save of
  `notes.json` stamps new notes and replies `by: "director", via: "page"`, keeps an existing note's author, via, created,
  target, round, legacy link and an agent's words, stamps a status change `closed_by: "director", closed_via: "page"`,
  only grows `legacy_seen`, and refuses a v1 list or a bad target / status / id (400). The server migrates the old stores
  before serving or saving the file. Texts are rendered escaped (tools/security-test.mjs covers every Notes column).
- Approvals are the director's, and **only the page approves**: a click in the page (POST `/api/save` with this
  server's Origin) is stamped `via: "page"` (in a request's `log`, on an `approvals.json` item). There is no switch for
  agent approvals: the agent surface (`/api/op`, the MCP tools, offline mode) has no `approve` tool and refuses
  `set_states` approved / locked, `shot_update` / `shots_update` approved / locked and a request's draft -> approved
  (403, pointing to the page), whatever it claims (`director_approved` is ignored). The old `agent_approvals` setting
  and `WB_AGENT_APPROVALS` are ignored (the server warns once at start). A request is queued / run only on an approval
  recorded by the page after its last draft (a status typed into `requests.json` by hand, or an old `via: "agent"`
  approval, is refused). Notes written through the tools carry `via: "agent"`, and the `director-session` briefing does
  not present them as the director's. Trade-off: the director must click (the agent can show the item with
  `ui_focus`); this guards the tool surface, not an agent that edits the files directly with shell access.
- Editing an approved request's prompt, refs, `est_cost` or tool sends it back to draft. A cost cap of **0 blocks all
  paid requests**. A snapshot restore bumps each file's `rev` (stale pages get 409 instead of overwriting) and never
  rolls back spend: costs recorded since the snapshot stay, a request that ran since keeps its state, and a restored
  approval that is not the current one goes back to draft (listed in `kept_since_snapshot`); the current `cap_usd`
  is kept, and an agent's `snapshot_restore` brings an approved / locked item back as `review`, not approved.
  Duplicating a project sends the copy's runnable requests (approved / failed / queued / running: a failed one is retried
  on its approval) back to draft, the same set a restore checks; the copy gets no `.history` (the git mirror) and no
  `revisions.json` (its snapshots are not copied).
- Shared files are written one process at a time: a read-modify-write (`mutate`, a cost row, a page save) holds a lock
  file next to the file (`.<name>.lock`, exclusive create, taken over after 15 s), so the server, `tools/run.mjs` and an
  offline MCP server never lose each other's rows (the cap cannot undercount; busy: 503).
- Private references and fal: fal takes refs as URLs, so a run uploads each ref to fal storage (a public URL). A request
  with a private ref (the PRIVATE rule or media flagged private) runs on fal only once the director ticks **allow
  uploading private refs** on it in Review › Queue (off by default; lock badges on the refs). The tick is recorded by the
  server in the request's log from a page save with this server's Origin; an edit of the request unticks it; an agent
  cannot set it (`request_create` drops it, the runner refuses without it).
- Look colours are hex only (`look_create`, `entity_upsert`: 400 otherwise) and the page renders swatches through
  `hexColor()`, so a colour cannot carry CSS (a `url()` beacon).
- The agent rules hold on the tool surface (MCP, `/api/op` and `/api/save` without the page, see "Page or agent").
  An agent with a shell can read the page token from `index.html` and forge the Origin and `Sec-Fetch-Site`: it is on
  its honour there, like any local process. `/api/restore` without the page is always an agent's restore.
- Requests in `requests.json` (review #2 N3): a save never removes or renames a request (400: withdraw or reject it), a
  new one is a draft (400 otherwise), a request in a batch is approved only with its batch (`batch_act`; a save that
  approves it alone: 409) and a save moves a request only to draft / approved / rejected / withdrawn (the runner does
  the rest). A save that edits an approved request's prompt, refs, estimate, tool, video or takes sends it back to draft
  and unticks "allow uploading private refs" (as `request_update` does).
- Ref paths (N2): every ref is stored in one spelling (`request_create`, `request_update`, `video.*`, a page save):
  `./`, `//` and `x/..` are normalised, an absolute path becomes project- or media-base-relative, a ref outside the
  project and the media roots is 400. The PRIVATE rule, the `media.json` private flag, the runner (`refPrivate`: the
  resolved file, relative to the project and to the media base) and the Queue's lock badge all read that spelling, so
  a flagged file cannot be uploaded to fal under another name; outputs of a private-ref request go to `private/gen/`.
- The runner's locks (N4): the heartbeat runs on a timer while a run holds its lock (uploads and downloads included); a
  lock is taken over only when its process is gone, or alive but silent for 30 min; before a take is submitted the
  runner re-reads `job.json` and polls a handle another run saved instead of paying again. fal sees ref names as
  `<request>_<i><ext>` (never the file's own name), a ref is PUT only to a fal storage host, and an output is streamed
  to disk with a 500 MB cap (N8). Uploads check the free disk space first (1 GB spare, 507 otherwise; N7).
- Guided flow: `stage_update` refuses `done` and refuses moving a done stage; a page save of `stages.json` is stamped
  (`done_by: "director", via: "page"`); an agent's snapshot restore brings a done stage that is not done now back as
  `needs_you`. A page save of `lyrics.json` cannot rewrite a saved version (the server keeps its copy) nor the author of
  an existing note; new versions / notes / replies from the page are stamped `by: "director", via: "page"`; the
  tools stamp `via: "agent"`; a malformed `lyrics.json` is refused (400). `song_attach` takes audio files only and
  refuses PRIVATE paths.
- Stage 2 (script): a page save of `scenes.json` cannot rewrite a saved version nor the author of an existing note,
  status or intake answer; new versions, notes, replies, changed scene statuses and answers are stamped
  `by: "director", via: "page"`; a malformed file is refused (400). Only the page marks a scene `ok` (`scenes_update`
  refuses it; an agent's snapshot restore brings a lost `ok` back as `needs_you`). `sketch_save` takes ids
  `^[a-z0-9][a-z0-9_-]{0,63}$` only (no path can leave `sketches/`), real PNGs only (signature + IHDR, image and mask),
  and bodies up to 25 MB (every other request: 5 MB; over the limit: 413); it keeps the token / Origin / Host checks.
  A sketch drawn over a PRIVATE underlay is written under `private/sketches/` and flagged private in `media.json`
  (local only, never exported). Its `via` (page / agent) is provenance, not a permission.
- Stage 3 (breakdown): every `breakdown_update` is a new version; item, scene, beat and `for` ids must match
  `^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$` (400 otherwise); an agent cannot set an item `ok` (403) nor write `status`,
  `entity_id` or `look_id` on an item (ignored, with a warning). A page save of `breakdown.json` cannot rewrite a saved
  version, a note's author or an entity link (`entity_id` / `look_id` are kept from the server's copy whatever the
  page sends); a changed status is stamped `by: "director", via: "page"`; a malformed file is refused (400). "Create
  entity" (`POST /api/op/breakdown_promote`) is the page's only: the server passes `via: "page"` only for a request with
  this server's own Origin (plus the token, Host and JSON checks), the MCP server has no such tool and the op refuses
  anything else (403); entity ids are checked like every entity id; it writes a draft entity (or a look) and spends
  nothing. Like a page save, a local process holding the token could forge the Origin header: this guards the tool
  surface. An agent's snapshot restore brings a lost item `ok` back as `review`.
- Stage 4 (characters): `character_act` (the base, keep / branch / revert / make head, approve / unlock the identity
  or a look, new looks, page notes) and `ref_upload` (reference images) run only for the page's own request (the
  server passes `via: "page"` for this server's Origin + the token, like `breakdown_promote`); the MCP server has no
  such tools; the agent surface and offline mode get 403. `ref_upload` takes real images only (PNG / JPEG / WebP / GIF
  by signature, up to 20 MB, body 25 MB); a photo always lands in `private/refs/<character>/` (name sanitised) and is
  flagged private; an Openverse image goes to `refs/<character>/` with its licence, creator and URL. An agent adds a
  node only from a request approved in the page and `done` (`character_iteration_add`), never to an approved (locked)
  tree, never a look before the identity is approved; nodes made from a private photo are private (image copied under
  `private/characters/<id>/`) and outputs of a request with private refs are flagged private. `entity_upsert` ignores
  `iter` / `base` and refuses to approve or lock a look (403; `import_ok`, for local scripts calling the data layer, is
  stripped from HTTP calls). An agent's snapshot restore brings back no identity / look approval and keeps the nodes
  made since (undecided).
- Stage 5 (scenery): `asset_act` (the same acts for locations and props, plus the variant a scene uses, `act: "use"`;
  `character_act` is it with `type: "character"`) is page only like `character_act` (403 to the agent surface and
  offline); `ref_upload` takes `type` and checks it against the entity. `variant_create` always writes `review`
  (short-word axis values, checked scene ids); `entity_upsert` ignores `iter` / `base` / `uses` and refuses to approve
  a variant (403); a request carries one link, `asset` (a `char` link is accepted with a deprecation warning and stored as `asset`). An agent's snapshot restore brings back no
  variant approval that is not the current one and keeps the director's current scene picks.
- Stage 6 (storyboard): every `shots_update` is a new version; shot, scene, entity, variant, sketch, clip and beat ids are
  checked (400); a shot's approval lives in `approvals.json` and `shots_update` refuses `approved` / `locked` (403, also
  offline); a page save of `storyboard.json` cannot rewrite a saved version or a note's
  author (stamped director / page) and a malformed file is refused (400). Nothing in the stage spends.
- Entity thumbnails and copies made from private media stay private (`thumbs/priv_*`, `private/<kind>/`).
- Proposals and imports: accepting a base proposal (`base_accept` / `base_dismiss`), an import proposal (`import_accept` /
  `import_dismiss`) and importing an image as a node (`import`) are `asset_act` acts: page only (403 to the agent surface
  and offline). An import takes a registered image only (media.json; not a path, not audio), never into a locked tree;
  the node keeps the media's private flag. `base_propose` / `node_import_propose` only write proposals (`iter`, which
  `entity_upsert` ignores); a proposed photo ref must already be private. `media_update` moves a private flag only toward
  private (`private: false` and a status change of a private file: 403; its thumbnail becomes `thumbs/priv_*`).
  `cost_record` records spend, never an approval (no request moves; a done request's cost is refused: recorded at done).
  The `falgen` folder of `project.json` is read only and must lie inside the media base (else an error, nothing read).
  `templates/*.json` (the recipe) is served read only like the catalogue.
- Imports (D8, `lib/ops/media.mjs`): `media_scan` (read only) and `media_import` take a file or folder under a configured media
  root only: a path with `..`, `.` or a backslash is 400; anything outside the media roots (an absolute path elsewhere, a
  junction / symlink under a root that points outside it: the real path is checked) is 403. Files are judged by their bytes
  (PNG / JPEG / WebP / GIF / MP4 / MOV / WebM; an audio-only MP4 brand, a script or text named `.png`: 415), never by the
  name; a scan opens only `job.json` and the first bytes of each media file (a job's refs are listed by name, never opened).
  The private flag only moves toward private: `private: false` on a path the PRIVATE rule matches or on a file flagged
  private is 403. Imports register in place (never copied). `media_upload` (the page's drag and drop) and `media_use`
  ("use as" a node, a shot's take or start frame) are page only (via "page" from this server's Origin; no MCP tool; 403 to
  the agent surface, a claimed via "page" and offline): an upload is chunked (4 MB; the op's body limit 9 MB), at most
  200 MB a file (declared size checked first; more bytes than declared: 413 and the partial file removed), its first chunk
  must sniff as media (415), and it lands in `media/<kind>/` or, ticked private, `private/<kind>/` (name sanitised, the
  extension from the bytes) via `.uploads/` (a dot-folder: never served, ignored by the watcher, parts older than a day
  removed). A recovered cost is recorded only through `cost_record` (once per job; a job the linked falgen ledger counts is
  not offered).
- Batches (D4, `lib/ops/batches.mjs`, `js/batches.js`): `batch_act` (approve / verdict / review / cap / dismiss) and the job-book import
  (`jobbooks_import`; its dry run is anyone's) are page only (via "page" from this server's Origin; no MCP tool; 403 to the agent surface, a
  claimed via "page", a foreign Origin and offline). `requests.json` `batches` are the server's: a page save keeps its copy (a forged status,
  gate or batch is dropped), and a `history` field the page sends is dropped (an existing history request is kept as the server has it).
  A request of a locked or unapproved batch never runs (`planRun` refuses it before any call; `request_update` queued / running: 409),
  approving a locked batch is 409 even from the page, and a batch's cap (`max_usd` minus what it spent and runs) bounds every run of it.
  A history request never runs (`planOne`) and its import writes nothing to costs.json. The waves' requests are drafts: `waves_plan`
  never approves.
- The request runner (`lib/run.mjs`, `request_run`, the Queue's Run, `tools/run.mjs`): runs only a request with a
  recorded director approval (draft / rejected / done / a status typed by hand: refused; it never approves), claims it
  through `request_update` queued (approval + cap re-checked; 402 over the cap) and refuses an estimate above the
  approved `est_cost`; one lock per request (`gen/<id>/.lock`, across processes); the cost is recorded once per request.
  The fal key comes from `FAL_KEY` or `fal_key_file` (outside the workbench and the data folder, not under a media root;
  else refused) and goes only into the Authorization header of calls to fal's queue / storage origins (a status /
  response URL on another origin gets nothing); it is never logged, returned (`generators_get` says where it was found),
  written to `job.json` or any project file, and error texts are redacted. Downloads carry no key and must be images
  (PNG / JPEG / WebP signature; a video output an MP4 `ftyp` box). `WB_FAL_BASE` (the tests' mock fal) counts only with
  `WB_TEST=1` (as does `WB_TEST_DATE`, the price date of the tests). Video (D3b): the refs must be exactly the video's
  start / end frames and reference video (images / a video file), each an existing project or media-root file; a private
  reference VIDEO is a private ref like any other (the director's "allow uploading private refs" tick, or refused); a
  reference clip longer than the approved seconds is refused. A retake (D3c) runs only on a done request with a director
  approval on record, only its failed takes, within the approved `est_cost` and the cap; each take's cost is recorded once
  (`<request>#<take>`, deduplicated under the costs.json lock, so two retakes at once pay once). Running is local
  only like every write (token, Host, Origin). The server's file watcher ignores `gen/` (the page follows
  `requests.json` / `media.json`), and a dropped-name watch event makes the page re-read everything.
- The composition data export (E9, `composition_export`): writes only `data/<p>/exports/<out>`; `out` is a `.json` path of
  letters, digits, `_ . - /` inside `exports/` (`..`, `.`, an empty segment, a backslash, a drive, a leading slash, `%`, NUL,
  > 160 characters: 400; a junction / symlink inside `exports/` leading outside: 400); `map` rules are relative without `..`,
  `.`, a drive, a backslash or a leading slash (400). A private take (the PRIVATE rule, the `private_media` regex, or
  `private: true` in media.json) is never written: the shot exports as a placeholder `private` without its file or media id;
  a private alternative is dropped (tools/security-composition.mjs). No approval, pick or project file is touched.
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
| `notes_get`, `notes_add`, `notes_status` | ONE list of notes for every stage and the timeline: filters (stage, kind, id, note, status, to, by), counts per stage; a note on any row (`target {stage, kind, id, w?, quote?, t?, pin?}`) or a reply (`reply_to`); absorbed / open / dismissed (the director's: not by you) |
| `lyrics_note_add`, `lyrics_note_resolve` | notes on a line or a word range, thread replies, resolve (aliases: notes.json v2) |
| `song_attach` | add / replace the song file: peaks, energy, grid, duration; lines re-timed |
| `intake_get`, `intake_answer` | stage 2: the intake questions (mood, kind, who, where, era, refs, must, must-not, budget) and answers; mark asked in chat |
| `script_get`, `scenes_update` | stage 2: scenes (time range, lines, title, text, beats, sketches with image paths + pins, status), gaps, coverage, asks for the agent, versions + diff; a new version (full list / upsert + remove / restore; snap to lines, bars, sections; statuses draft / needs_you) |
| `scene_note_add`, `scene_note_resolve` | notes on a scene or a beat, thread replies, resolve |
| `sketch_save`, `sketch_get`, `sketch_list` | sketch files: save (JSON + base64 PNG + mask), get the PNG / mask paths (absolute too) and the numbered pins, list (by scene) |
| `breakdown_get`, `breakdown_update` | stage 3: the items (characters, locations, props, wardrobe, FX) with their scene / beat links, statuses, entity links, the matrix, asks for the agent, versions + diff, and the script + intake to extract from; a new version (full list / upsert + remove / restore; statuses draft / review) |
| `breakdown_note_add`, `breakdown_note_resolve` | notes on an item or a scene, thread replies, resolve |
| `character_get` | stage 4: no id = every character (status, scenes, open requests, nodes waiting) + breakdown characters not yet entities; id = base (ref files), trees (nodes with image files, branches, head, approved), looks, requests (edit text, pins, sketch PNG / mask files, ref files), `to_run`, `to_register`, `waiting_for_director`, notes, asks |
| `character_iteration_add` | register the output of an approved, done request as a node of its tree (never approves or chooses) |
| `character_note_add` | a note on a character, a tree or a node; reply_to (+ resolve) answers the director's asks |
| `look_create` | propose a look (costume): status `review`; its tree starts from the approved identity |
| `asset_get` | stages 4-5, any asset (character, location, prop): no id = every asset by kind (+ breakdown items not yet entities); id = base, trees, variants (axes), `scenes` (each scene's variant, source and image), requests, `to_run`, `to_register`, `waiting_for_director`, notes, asks |
| `asset_iteration_add` | register the output of an approved, done request as a node of the asset tree it names (`asset` / `char` link; never approves or chooses) |
| `asset_note_add` | a note on an asset, a tree, a node or a scene's use of it; reply_to (+ resolve) |
| `variant_create` | propose a variant: a location's angle / time of day / weather, a prop's angle / state (a character: a look); status `review`; `scenes` = where you propose it |
| `storyboard_get` | stage 6: the scenes in song time (beats, what each needs + its variant) with their shots (time, bars, kind, text, camera, frame sketch PNG + pins, assets with variant, image file, approved or why not, status, requests, estimate), shots outside the script, the beat grid, gap counts, notes, asks, versions + diff |
| `shots_update` | a new storyboard version (full list / upsert + remove / restore; snap to beats or bars; scenes re-tiled); statuses draft / review / changes (approved / locked refused) |
| `shot_note_add`, `shot_note_resolve` | notes on a shot or a scene, thread replies, resolve (answers the storyboard / fill-the-gaps asks) |
| `gaps_get` | what is still missing (unscripted time, scenes without shots, shots without a frame, assets not approved, shots without a request or clip), the draft requests per shot (prompt, refs, tool, est) and the total vs the cap |
| `snapshot_save`, `snapshot_list`, `snapshot_restore` | durable checkpoints |
| `song_get` | sections, lyric lines with word timings, events, grid |
| `timeline_query` | everything between t0 and t1 across all columns |
| `shots_list`, `shot_get`, `shot_update` | the shots.json shots and clip uses: status, take, in-point, title, a note (stage 6 shots: `storyboard_get`) |
| `entities_list`, `entity_get`, `entity_upsert` | characters (with looks), locations, props |
| `media_list`, `media_add` | the media index (filters kind, entity, status, shot, `linked` / `unlinked`, `private`, q); add = thumbnails + links |
| `media_scan` | read only: a file / folder under a media root: its media files (sniffed, registered?, private?) and its generation jobs (`job.json`: prompt, model, endpoint, refs, takes, cost {status recorded / counted / not_counted, usd, source, `offer`}) |
| `media_import` | register files / folders under a media root in place (job / take / label / cost share from `job.json`, `request` link); private never lowered; returns `costs_not_counted` (cost_record args) |
| `notes_list`, `note_add`, `note_resolve` | the timeline's notes (pinned to time) in the old shape; resolve = absorbed, with a reply |
| `round_get` | the review round the director sent: its notes by stage, each with the content it points at, the progress, the revision it becomes; "collecting" when none was sent |
| `round_absorb`, `round_reply`, `round_finish` | a round's note done (linked to the change {stage, file, version, summary}), answered (stays open), the round done (a summary; approves nothing) |
| `proposals_add` | attach 3 (1-6) proposals to a target (a scene, a shot, a lyric line, a look / variant tree, an asset): `{title, why, svg | text}`; SVG sanitised on the server (refused with the reason); answers an open "3 more" on that target; returns what changed |
| `proposals_get` | the proposal sets (target / stage / open / set filters) with each item's status and file, the director's `picks` (and mix notes), the open `asks` for proposals |
| `revisions_get` | the revisions R1, R2, … (summary, notes absorbed, files changed, cost delta, git), the round in flight; `compare: [a, b]` = per-stage diff (lyric lines, scenes / shots on the time line, breakdown items, asset heads A / B, cost) with the notes behind each change |
| `takes_get` | read only: the takes of a shot (`shot`) or a request (`request`): media, file (+ absolute), kind, take, request, duration, fps, source runner / import, picked + in / out, alt_for; the pick (`clip`) and how it fits the shot; your take proposals |
| `batches_get` | read only (D4): the batches (waves) with their gate (locked / ready / running / review / done and why), totals vs the batch cap, verdicts per request, the take ratio; `observed` (what the reviewed waves measured), `remaining` (the next waves re-estimated: list vs observed $), the history imported from the job books |
| `waves_propose` | waves from the storyboard gaps: the pilot (shot ids) first, then `sizes` (default 2, 4, 8, then the rest), `takes` per request; `dry_run` = the plan; else draft requests + draft batches gated wave after wave (never an approval) |
| `check_add` | D7: your vision check of an output (node "ada/n05", take "<shot>/<media>", media) against the character's approved identity and constants checklist: verdict ok / drift / fail, items `{constant, ok, note}` (+ `likeness`), a note; `score` only from a local face-embedding tool (tools/face-score.md); checks.json only, never an approval or a pick; absorbs a finished "identity check" ask |
| `checks_get` | D7, read only: `enabled` (the director's switch), the checks, the badge per target, the open "identity check" asks (outputs with absolute files, what is unchecked), the checklist per character (approved identity image + constants to check) |
| `composition_export` | E9: the picks as `exports/composition/edl.json` for the HyperFrames composition (shots, take file mapped under its assets + in / out, looks, placeholders, song anchors, checksum); `map`, `out` (inside exports/), `dry_run`; deterministic (`changed`); private never written; writes only that file (also while locked) |
| `surfaces_get` | E2, read only: the lyric gate: every lyric line with each word covered or not (`on [{shot, where}]`, `off_time`), the uncovered runs, the shots' surfaces (`lyrics[]`), your proposals; filters `line`, `shot`, `uncovered` |
| `surface_propose` | E2: propose where a lyric line / word range appears on screen during a shot (`where` "<kind>[: detail]": window, chat, dialog, karaoke, taskbar, other; `why`): an open proposal in surfaces.json the director accepts in the page (never on the shot itself) |
| `take_propose` | propose a take for a shot with in / out (ms or m:ss.mmm inside the take) and why: an open proposal in takes.json the director picks with one click (never a pick) |
| `final_get` | stage 7, read only: `ready`, `locked`, `failing`, the checklist (10 derived checks with their gaps, `lyrics` = the lyric gate), `pending` rows by group (lyrics, script, breakdown, characters, scenery, storyboard, requests: status, why, est / spent, notes open, approvable), `counts`, `costs` (spent / committed / drafts / to request / projected vs the cap); filters group / status / notes |
| `approvals_get`, `request_changes` | approval states (approving is the director's, in the page: no tool) |
| `requests_list`, `request_create`, `request_update` | the generation queue and its lifecycle (`asset` links a stage-4 / 5 generation to an asset tree; `char` is deprecated: a warning, stored as `asset`); `recipe` builds the prompt from the photoreal blocks; `video {model, start, end?, ref_video?, seconds}` makes a video request (refs, tool, est_cost from it); `warnings[]` |
| `request_run` | run APPROVED requests with the runner (the generator per kind from Settings > Generator; images and video): `dry_run` = the plan, nothing spent; refuses drafts; re-checks the cap (before every take too); outputs in `gen/`, cost once, media + nodes; `retake: true` = the failed takes of done requests only; `video_parallel` (default 1); `batch` = one approved, unlocked batch within its cap (D4; `all` runs batch by batch; a locked batch and a history request never run); `wait` or `wait_for` |
| `generators_get` | the generators (fal, openwith, comfyui), the one per kind, ready or not, where the fal key was found (never the key) |
| `costs_get` | one total (`total_spent_usd`) with per-source rows: costs.json, falgen ledger rows not in it, falgen spent.json not itemised (dedup by job); committed / cap; `falgen.linked` + a warning when a falgen folder nearby is not linked |
| `cost_record` | record spend made outside the queue (`via`, `job`, `take`, `tool`, `note`); never an approval; the same job once |
| `media_update` | relabel / re-kind / re-link a registered file; `private: true` only (one-way) |
| `base_propose` | propose a base (text + refs) the director accepts in one click |
| `node_import_propose` | propose a registered image as a node of a tree (identity head, a look); the director accepts |
| `wait_for` | block until a request / several `requests` (the first that changes) / stage / note changes (`until` statuses, `timeout_s` ≤ 1800; SSE or file polling); returns early with `code_changed` when the workbench code changes under it; `pages_open` |
| `ui_focus` | move the open page: seek, select, open a view, preview in the dock, toast; no page open: queued for the next page that opens the project (2 h) |

Resources: `workbench://docs/readme`, `workbench://docs/claude` (this file), `workbench://docs/file-formats`,
`workbench://docs/skill`, `workbench://project/{project}/{file}`. Prompt: `director-session` (briefing + state).

## Prices

`js/prices.js` is the one price table: the page's estimates, `request_create recipe`, `gaps_get` and the cost panel read
it. List prices (fal), each verified on the date given:

| model | endpoint | price | verified |
|---|---|---|---|
| Nano Banana 2 edit | `fal-ai/nano-banana-2/edit` | $0.08 at 1K, $0.12 at 2K (per image) | 2026-10-04 |
| Seedream 5.0 Pro edit | `bytedance/seedream/v5/pro/edit` | $0.0675 up to 1536², $0.135 up to 2048² (+$0.0045 per extra ref) | 2026-10-04 |
| MiniMax H3 Max image-to-video | `minimax/h3-max/image-to-video` | $0.048/s at 768p until 2026-10-15 (promo), then $0.08/s | 2026-10-04 |
| Kling v3 Pro image-to-video | `fal-ai/kling-video/v3/pro/image-to-video` | $0.112/s (no generated audio) | 2026-10-04 |
| Kling v3 Motion Control | `fal-ai/kling-video/v3/pro/motion-control` | $0.168/s | 2026-10-04 |

What each generation is estimated with (`USE`): a sheet (identity / look / base / variant) and a shot still = NB2 2K
$0.12; an edit or a masked edit = NB2 1K $0.08; a shot video = H3 Max 768p per second (5 s minimum, 10 s a clip). A video
request (js/video.js) is priced $/s x `video.seconds` x takes at the run's date (H3: $0.048/s up to 2026-10-15, $0.08/s from
the 16th: a request approved at the promo price and run after it is refused until re-approved); motion control by the
seconds of output (as long as the reference clip). To
change a price: edit `js/prices.js` (and `verified`), then this table. The runner (`generators/fal.mjs`) prices a take
from this table too (NB2: 1K for an edit kind, else 2K; text-to-image, a request without refs, at the edit list price,
not verified separately; Seedream: 2048 + $0.0045 per ref after the first) and refuses a run whose estimate is above
the approved `est_cost`; the actual cost recorded is that list price x the takes that completed (fal returns no cost).

## Calling a tool from a shell (the quickest way)

```
node <workbench>/mcp/client.mjs --list
node <workbench>/mcp/client.mjs status --project my-song
node <workbench>/mcp/client.mjs requests_list '{"status":"draft"}' --project my-song
node <workbench>/mcp/client.mjs wait_for '{"request":"r123","until":["approved","rejected"],"timeout_s":1800}'
```

It spawns `mcp/server.mjs` with the SDK client, calls one tool, prints its text (JSON) to stdout and any `warning:` to
stderr, and exits 1 on a tool error. When the MCP server cannot start (a file mid-edit: a SyntaxError, merge conflict markers) it
says which file and why instead of a bare "Connection closed". It works from any folder (it loads the SDK by file URL); JSON may also come from
`@file.json` or `-` (stdin); `--offline` and `--url` as for the server. From another ESM script, import the SDK with
`pathToFileURL` (a bare specifier resolves only inside the workbench folder).

**Runner hook** (falgen or any script that spends outside the queue): after a paid job, call
`node <workbench>/mcp/client.mjs cost_record '{"usd":0.24,"via":"falgen","job":"HV1","tool":"fal-ai/nano-banana-2/edit"}' --project <p>`
(the same job is recorded once; `costs_get` then counts it from costs.json, not from the ledger). For a run that
belongs to an approved request, run it with the workbench runner instead (`request_run`, `node tools/run.mjs`), or report
it with `request_update {id, status: "done", outputs, actual_cost_usd}`.
From Python: `subprocess.run(["node", WB + "/mcp/client.mjs", "cost_record", json.dumps({...}), "--project", p])`.

## Running approved requests

Batches (D4): a request in a batch runs only when its batch is approved and unlocked; **Run batch · $X** in the Queue, `request_run {batch}`,
`node tools/run.mjs --batch <id>`; the batch's cap (`max_usd`) bounds every run of it. One runner (`lib/run.mjs`) behind three doors: the page (Review > Queue: **Run · $X** per row, **Run all approved (N) ·
$X**), an agent (`request_run`), a shell (`node tools/run.mjs`). The director approves in the Queue (**Approve** /
**Reject** per row, or tick drafts: **Approve selected**). A run: claim (approved -> queued: the approval and the cap
are checked again) -> running (the generator: submit, poll every 4 s up to 25 min, fetch; progress as SSE `{run}`) ->
done (outputs `gen/<id>/<id>_<take>.png`, `job.json`, the cost recorded once, media registered, an asset request's
outputs added to its tree as nodes: `linked`) or failed (`why`; run it again to retry: existing takes are skipped,
submitted jobs polled again). Up to 2 at once. Generators (Settings > Generator per kind, `settings.json`
`generators`): `fal` (default; images, and video since D3b: H3 Max / Kling v3 Pro image-to-video from a start frame + an
optional end frame, Kling v3 Motion Control from a reference video, outputs `.mp4`, 1 at a time; a failed take of a done
request: `retake`), `openwith` (a prompt pack in `gen/<id>/pack/`, the request
handed off until images land in `gen/<id>/results/` and it is run again: done at $0), `comfyui` (stub). A generator is
`generators/<id>.mjs` exporting `{id, label, kinds, configured(ctx), supports(req), estimate(req), submit(req, ctx) ->
handle, poll(handle, ctx) -> {status: queued|running|done|failed|waiting}, fetch(handle, ctx) -> [{url | file, ext}]}`,
listed in `GENERATORS` (`lib/run.mjs`). Tests never call fal: `tools/mock-fal.mjs` + `WB_TEST=1 WB_FAL_BASE=<mock>`.

## Adding a feature

- **A command** (everything the user can do is one): `WB.commands.register({ id, title, group, keys, when, checked,
  run })` in `core/defaults.js` (or a tab module). It appears in the palette (Ctrl+K), the cheat sheet (?) and Settings >
  keybindings automatically; keys are rebindable and stored per project.
- **A menu entry**: `WB.menus.contribute(context, [commandId | {label, submenu} | '-' | (c) => items])`; contexts `timeline`, `ruler`,
  `lyric`, `section`, `shot`, `clip`, `cast`, `note`, `header`, `entity`, `empty`, `global`, `columns`, `stage`, `scene`,
  `tladd` (first on any timeline right-click: its + Add), `lyline`, `lysec`, `lystage`, `scgap`, `sbscene`, `bditem`, `bdstage`, `chnode`, `noterow` (any row with a Notes column:
  `c.ncCol`, `c.ncTarget`), `menubar:<File|Edit|View|Timeline|Generate|Window|Help>`. Elements with `data-sel="kind:id"`
  are selectable. A "+ Add" act goes first in its row's menu as `{label: '+ Add', submenu: [...]}` (with `notes.addHere`
  last) and is a command, so it is in the palette too; a stage draft edit records `history.push({label, undo, redo})`.
- **A Notes column** (every stage has one): `new NotesColumn({stage, scroller, rows: () => [{el | els, targets[],
  match?, sub?, targetAt?}], top?, scope?, current?, active?})` from `core/notescol.js` on the stage's scroll container;
  it re-aligns itself when the rows change. Offer Alt+N as `WB.stageActions[stage].note = () => nc.editCurrent()`.
- **A view**: `tabs/<name>.js` exporting `{ mount(el, ctx), show?(ctx) }` plus one line in `tabs/registry.js`, as a
  sub-view `{id, title, load, count?}` under Assets or Review (or `WB.app.registerSub(pageId, sub)` at runtime).
  Re-render on `store.on(what => ...)` (`'all'` after a full reload, else the field name: `notes`, `requests`, ...).
- **A column**: one object in `js/columns.js` (`kind: 'text'` drive/follow or `'lane'` canvas).
- **Help in a stage**: one line + a `?` popover, `help(line, more)` from `core/helptip.js` (F5: no paragraphs of prose in a workspace).
- **A stage workspace**: a module in `tabs/` loaded from `MODULES` in `tabs/stage.js` and imported by `core/rail.js`
  (so its commands exist before it is opened); offer `WB.stageActions[<stage>] = {canSave, save, canNote, note}` and
  the rail's `stage.save` (Ctrl+Enter) / `stage.note` (Alt+N) reach it. Its **Time view** (List | Time, Alt+T, `core/timemode.js`,
  per stage in prefs `timeMode`): `new TimeAxis({stage, scroller, rows: () => [{el, t0, t1, subs?}], nc, onApply})`,
  `ta.apply()` at the end of every render, the stage in `TIME_STAGES`, the Notes column with `fixed: () => ta.on`; rows
  are placed at the timeline's `warp.y(t)` (never a warp of their own), so they match the timeline to the pixel. A sketch anywhere: `mountSketch(el, {sketch?,
  id, resolve: mediaUrl, save})` from `core/sketch/sketch.js`, saving through `POST /api/op/sketch_save` (stage 4 mounts
  it over a node image for an edit: strokes, mask and pins go into the request). A new asset kind: a `TYPE` entry in
  `js/assets.js` (root tree, variant prefix and field, words, axes, request kinds, estimates) and a `UI` entry in
  `tabs/assetws.js`; a stage module mounts `new AssetWorkspace(el, {types, stage, pref})` and calls `assetCommands`.
- **Proposals on a new target**: render `stripHtml(target)` from `core/proposals.js` next to the row (it takes the row's
  width, left of the Notes column; `{compact: true}` in a closed row, `{quiet: true}` to show nothing without proposals),
  re-render on `store.on('proposals')`, and `register(stage, ({target, item, act}) => ({what, undo, redo}))` for what a
  pick does there (one undo step with the recorded pick); add the stage / kind to `js/proposals.js` `TARGETS`.
- **A page-only act** (the director's decision): an op in its `lib/ops/<domain>.mjs` that fails unless `via === 'page'`, and one
  line in `serve.mjs` setting `body.via` from the request's Origin (see `breakdown_promote`, `character_act`,
  `asset_act`, `ref_upload`, `round_send`, `proposal_act`, `final_lock`, `take_act`, `surface_act`, `media_upload`, `media_use`, `batch_act`, `jobbooks_import`); no MCP tool; a security check that the agent surface gets 403.
- **An agent op / MCP tool**: a function in the `Object.assign(ops, {...})` of its `lib/ops/<domain>.mjs` (it is then
  also `POST /api/op/<name>`; see "Where to add an op or a tool"), and a `mcp.registerTool` in `mcp/tools/<domain>.mjs`
  with a zod schema and a description an agent can follow; cover it in `mcp/test.mjs`.
- **Tests**: `npm run test:mcp` and `npm run verify` must pass (the verify suite runs on the demo; the owner's extra
  Part B checks run only on his own project). Add a check next to the feature you touched.
