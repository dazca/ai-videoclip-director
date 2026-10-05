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
node mcp/client.mjs <tool> '<json>' [--project <id>]   # call one MCP tool from any shell / folder (see "Calling a tool")
```

**A stale server.** The server hashes its code at start (`serve.mjs`, `lib/`, `js/`, `tabs/`, `core/`, `app.js`). `/api/status`
`code` and the header `x-wb-code` on every `/api` response carry it. When the files on disk differ, `status` says
`server.code.stale` + "restart", every MCP tool adds a `warning: … restart the server` block, and the page shows a thin
"Restart the server" bar. An op the old server does not know (404 "no such op") is done on the files directly, with a
warning. After pulling or editing code: restart `node serve.mjs`, then reload the page. A stale MCP server itself
(`status` `mcp.stale`) needs a reconnect.

Needs Node 20+ and, for importing and thumbnails, `ffmpeg` / `ffprobe` on PATH. Optional local settings live in
`workbench.config.json` (gitignored; copy `workbench.config.example.json`): default project, data folder, media roots
outside the project folder, extra PRIVATE path rule. Env vars win: `WB_PROJECT`, `WORKBENCH_DATA`, `WORKBENCH_MEDIA_BASE`.

## Layout

| path | what |
|---|---|
| `serve.mjs` | HTTP server: static files, `/media/*` (read-only, configured roots), `/api/*` (save, events SSE, projects, snapshots, ops, live UI channel) |
| `lib/store.mjs` | Node data layer shared by the server and the MCP server: a thin aggregator that re-exports the `ops` object (every agent op, `ops.*`) and the helpers from `lib/ops/`; everything outside imports this file |
| `lib/ops/` | the data layer by domain (table below): `_shared.mjs` (files, config, media paths + the PRIVATE rule, `projDir` / `read` / `write` / `mutate`, time helpers, thumbnails, the director gates, the `ops` object); each domain file adds its ops with `Object.assign(ops, {...})` |
| `mcp/server.mjs`, `mcp/test.mjs`, `mcp/client.mjs` | MCP server (stdio: imports the tool files, adds the resources and the `director-session` prompt, connects), its end-to-end test, and the one-shot CLI client (`node mcp/client.mjs <tool> '<json>'`) |
| `mcp/tools/` | the MCP tools by domain, one file per `lib/ops/<domain>.mjs`; `_shared.mjs` holds the transport (`op`, `http`, `server`, `projectOf`), `wrap`, the shared zod schemas and the one `mcp` server object the files register on |
| `js/prices.js` | the ONE price table (list prices with the day each was verified): every estimate in the page, the server and the tools |
| `js/recipe.js`, `templates/photoreal_recipe.json`, `docs/PHOTOREAL.md` | the photoreal recipe: the default prompt template (blocks per model), its data, and the guide that explains it |
| `index.html`, `app.js`, `app.css` | the page shell |
| `core/` | command registry + keymap, menus, palette, undo history, selection, projects/exports, preview dock, default commands, `rail.js` (stage rail + stage commands), `wizard.js` (new-project wizard), `sketch/` (the sketch tool: `mountSketch` / `openSketch`, API in its header) |
| `js/` | store (data + live reload), timeline (the warp), columns, player, verify hooks, `flow.js` (the guided flow: stages + lyrics model), `scenes.js` (stage 2: scenes, intake, gaps, snapping), `breakdown.js` (stage 3: items, links, merge / split, the "Suggest from script" pre-pass), `assets.js` (stages 4 and 5: the asset workspace logic for characters, locations and props: iteration trees, branches, variants and their axes, statuses, estimates, prompts, the variant per scene) and `characters.js` (the stage-4 names on top of it), `storyboard.js` (stage 6: shots, tiling on the beat grid, "shots from beats", the assets a shot needs and their variants, estimates, gaps), all shared with `lib/store.mjs` |
| `tabs/` | one module per view; `tabs/registry.js` lists pages and sub-views; `stage.js` (stage workspaces), `lyrics.js` (stage 1), `script.js` (stage 2), `breakdown.js` (stage 3), `assetws.js` (the generic asset workspace + its commands), `charstage.js` (stage 4 on it; `characters.js` is the Assets sub-view), `scenery.js` (stage 5 on it: locations and props), `storyboard.js` (stage 6: the board, the shot panel, the gaps, the estimate vs the cap) |
| `docs/SPEC_v3_GUIDED.md` | the guided creation flow (seven stages); phase 1 = stage rail, wizard, lyrics stage; phase 2 = the script stage + sketch files; phase 3 = the breakdown stage; phase 4 = the characters stage; phase 5 = the scenery stage (locations, props) on the generic asset workspace; phase 6 = the storyboard stage (shots per scene, gaps) |
| `catalog/` | the free starter catalogue (CC0 / public-domain bases: bodies, poses, face angles, garments, locations, props; `catalog.json`, `LICENSES.md`), served read-only for stage 4 |
| `importers/` | `new_project.mjs` (song + lyrics -> project), `azemar_*` (the owner's production, kept as a worked example) |
| `tools/` | `verify.mjs` (UI suite; its stage-4 / 5 blocks are `verify-characters.mjs` (v7), `verify-scenery.mjs` (v8), `verify-storyboard.mjs` (v9) and `verify-dogfood.mjs` (v10: proposals, image import, request warnings, merged costs, the recipe form, the stale bar), each runnable alone; `verify-stages.mjs` (F1: stage status from content, per stage empty / partial / done / regressed, the rail screenshots `f1_*.png`; run after it by `npm run verify`)), `security-test.mjs`, `sketch-test.mjs` (+ `sketch-dev.html`), `tiny-png.mjs` (test PNGs), `make_demo.mjs`, `chrome.mjs` |
| `exporters/hyperframes-html/` | HTML package of a HyperFrames composition: `export.mjs`, `verify.mjs`, `serve.mjs` (see Export) |
| `data/<project>/` | one folder per project; only `data/_template/` and `data/demo/` are in git |

**Where to add an op or a tool.** Each domain has one ops file and one tools file, so agents working on different domains
never edit the same file. Helpers used by several domains go in `lib/ops/_shared.mjs` (or are exported from the domain
that owns them and imported by the others); ops call each other through `ops.<name>`, never by import.

| domain | ops (`lib/ops/`) | tools (`mcp/tools/`) | what |
|---|---|---|---|
| core | `core.mjs` | `core.mjs` | code version (stale server), projects, snapshots (restore carry-forward), `song_get`, `timeline_query`, the media index (`media_list` / `media_add` / `media_update`), `scrubPrivate`; tools also `status`, `projects`, `wait_for`, `ui_focus` |
| requests, approvals, costs | `requests.mjs` | `requests.mjs` | the recipe file, `requests_list` / `request_create` / `request_update`, `approvals_get` / `set_states` (tools `approve`, `request_changes`), `costs_get`, `cost_record`, the falgen merge |
| notes | `notes.mjs` | `notes.mjs` | notes pinned to song time (`notes_list`, `note_add`, `note_resolve`) |
| stages, lyrics | `lyrics.mjs` | `lyrics.mjs` | `stages_get` / `stage_update`, `startStage`, stage 1 (`lyrics_*`, `song_attach`), `createGuidedProject` |
| script, scenes, sketches | `scenes.mjs` | `scenes.mjs` | stage 2: `script_get`, `scenes_update`, `scene_note_*`, `intake_*`, `sketch_*` |
| breakdown | `breakdown.mjs` | `breakdown.mjs` | stage 3: `breakdown_*` (`breakdown_promote` is page only: no tool) |
| assets, characters | `assets.mjs` | `assets.mjs` | entities (`entities_list`, `entity_get`, `entity_upsert`) and stages 4-5 (`asset_*`, `character_*`, `look_create`, `variant_create`, `base_propose`, `node_import_propose`; `asset_act` / `character_act` / `ref_upload` are page only: no tool) |
| storyboard | `storyboard.mjs` | `storyboard.mjs` | the shots.json shots (`shots_list`, `shot_get`, `shot_update`) and stage 6 (`storyboard_get`, `shots_update`, `shot_note_*`, `gaps_get`) |

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
- `media.json`: every generated/imported file with kind, links (entities, shots, uses, job, take), status, thumbnails.
- Shared with the page, each `{rev, ...}`: `notes.json`, `approvals.json` (`"kind:id" -> {state}`; states draft,
  review, changes, approved, locked), `requests.json` (the generation queue; a stage-4 / 5 generation carries `asset{type, id,
  tree, from, kind: identity|base|edit|look|variant, text?, sketch?, png?, mask?, pins[]}` (the old `char` link is still
  read, never written), `warnings[]?` (request_create's, shown on the request card), `recipe?{id, version, model, framing,
  fields, blocks[{id, label, text}], negative_prompt?}` (made from the photoreal recipe)), `overrides.json`, `settings.json`.
- `costs.json`: `cap_usd`, `items[{id, t, usd, tool, date, request?, via?, job?, take?, note?}]` (`via`: spend recorded
  with `cost_record`, outside the queue). `project.json` may name `"falgen": "<dir>"` (or `{dir, ledger}`, relative to the
  media base, inside it; read only): `costs_get` merges its `spent.json` and the `via falgen` rows of its `LEDGER.md`.
- Stage-4 / 5 `iter` also holds the agent's proposals: `base_proposal{text, refs, why, by, via, at}` and
  `proposals[{id "ip01", kind: import, tree, media, path, why, provenance, status: open|accepted|dismissed}]`; a node the
  director imported has `origin: "imported"`, `kind: "import"`, `request: null`, `provenance{media, path, job?, take?,
  request?, cost: {source: workbench|falgen, usd, …} | null}`.
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
  props[], variants{<entity id>: <variant / look id> | null}, gen: still|video|null, clips[], thumb?, section?}]}]`
  (immutable; a save appends), `notes[{id "sbn01", shot|null, scene?, text, by, via, to?: "agent", kind?:
  request|storyboard|fill_gaps, gaps?, status, version, replies[]}]`. The shots of a scene TILE it (first starts with
  the scene, each ends where the next starts, last ends with it) on the beat grid; kinds wide / medium / close / insert
  / performance / xp-desktop (or another short word); the asset chips are entity ids, the variant each needs is the
  scene's (the entity's `uses`, else the agent's proposal, else the root) unless the shot's `variants` overrides it;
  `gen` = what it needs generated (default: insert / xp-desktop a still, else a video = a start frame + image-to-video).
  A shot's approval is `approvals.json` `shot:<id>` (approved / locked only from the page). A generation for a shot is a
  request with `target: "shot:<id>"` (kinds `shot-still`, `shot-video`). Missing = v1 derived from `shots.json` (ids,
  thumbs, clip uses kept; each shot in the scene at its middle); the timeline shots / cast / status columns read the
  storyboard. Logic: `js/storyboard.js`.
- `sketches/<id>.json|.png|.mask.png`: sketches (vector strokes + pins + metadata, the flattened image, the edit mask),
  written by `sketch_save` and registered in `media.json` (kind `sketch`, links `scenes` / `entities` / `shots`);
  under `private/sketches/` when drawn over a private underlay. Not snapshotted (the script versions point at them).
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

## Rules (enforced by the MCP tools; follow them by hand too)

0. **Prompts and prices.** Build photoreal prompts from the recipe (`request_create recipe {…}`; docs/PHOTOREAL.md) and take
   estimates from `js/prices.js` ("Prices" below); never invent a price.
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
   ones (`request_update` queued -> running -> done with `outputs` + `actual_cost_usd`), then
   `character_iteration_add {id, request}`: the node joins its tree; the first one is the head, later ones wait for
   the director. The base, keep / branch / revert, approving / unlocking the identity or a look are the director's, in
   the page (no tool); a look starts from the approved identity (`request_create` warns when a look sheet
   has `from: null` and no identity is approved yet); `look_create` proposes a look in `review`. **The base:** propose it
   with `base_propose {id, text, refs, why}`; the director accepts it in one click ("Accept base"). **An image that
   already exists** (a legacy approved look, an output made outside the queue, e.g. by falgen before a request existed):
   register it (`media_add`, or relabel / re-link it with `media_update`), record its spend with `cost_record {usd, via,
   job}` (never an approval), and propose it as a node with `node_import_propose {id, tree, media, why}` (the identity
   head first; a look import is acceptable once the identity is approved); the director accepts it (origin imported,
   provenance kept) or imports any registered image directly ("Import an image…"). Ask with
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
  `app.css`, `README.md`, `core/`, `core/sketch/`, `js/`, `tabs/`, and the free starter catalogue `catalog/` (images,
  `catalog.json`, `LICENSES.md`); case-insensitive). The page shell carries a Content-Security-Policy
  with `script-src 'self'` (no inline scripts, no eval; media may also be `https:` / `data:` / `blob:`) and
  `connect-src 'self' https://api.openverse.org` (the stage-4 Openverse search from the browser; every other origin is
  blocked); every other file gets a sandboxing CSP and `nosniff`, so an HTML/SVG file in a project cannot run script in
  the workbench origin. An invalid `?project=` is redirected to the default project. A remote (LAN) client reads the
  project's JSON scrubbed of private paths and items flagged private (`lib/store.mjs` `scrubPrivate`).
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
  with `director_approved` and offline); a page save of `storyboard.json` cannot rewrite a saved version or a note's
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
| `media_list`, `media_add` | the media index; add = thumbnails + links |
| `notes_list`, `note_add`, `note_resolve` | notes pinned to time; resolve with a reply |
| `approvals_get`, `approve`, `request_changes` | approval states |
| `requests_list`, `request_create`, `request_update` | the generation queue and its lifecycle (`asset` links a stage-4 / 5 generation to an asset tree; `char` is deprecated: a warning, stored as `asset`); `recipe` builds the prompt from the photoreal blocks; `warnings[]` |
| `costs_get` | one total (`total_spent_usd`) with per-source rows: costs.json, falgen ledger rows not in it, falgen spent.json not itemised (dedup by job); committed / cap |
| `cost_record` | record spend made outside the queue (`via`, `job`, `take`, `tool`, `note`); never an approval; the same job once |
| `media_update` | relabel / re-kind / re-link a registered file; `private: true` only (one-way) |
| `base_propose` | propose a base (text + refs) the director accepts in one click |
| `node_import_propose` | propose a registered image as a node of a tree (identity head, a look); the director accepts |
| `wait_for` | block until a request / stage / note changes (`until` statuses, `timeout_s` ≤ 1800; SSE or file polling) |
| `ui_focus` | move the open page: seek, select, open a view, preview in the dock, toast |

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
$0.12; an edit or a masked edit = NB2 1K $0.08; a shot video = H3 Max 768p per second (5 s minimum, 10 s a clip). To
change a price: edit `js/prices.js` (and `verified`), then this table.

## Calling a tool from a shell (the quickest way)

```
node <workbench>/mcp/client.mjs --list
node <workbench>/mcp/client.mjs status --project my-song
node <workbench>/mcp/client.mjs requests_list '{"status":"draft"}' --project my-song
node <workbench>/mcp/client.mjs wait_for '{"request":"r123","until":["approved","rejected"],"timeout_s":1800}'
```

It spawns `mcp/server.mjs` with the SDK client, calls one tool, prints its text (JSON) to stdout and any `warning:` to
stderr, and exits 1 on a tool error. It works from any folder (it loads the SDK by file URL); JSON may also come from
`@file.json` or `-` (stdin); `--offline` and `--url` as for the server. From another ESM script, import the SDK with
`pathToFileURL` (a bare specifier resolves only inside the workbench folder).

**Runner hook** (falgen or any script that spends outside the queue): after a paid job, call
`node <workbench>/mcp/client.mjs cost_record '{"usd":0.24,"via":"falgen","job":"HV1","tool":"fal-ai/nano-banana-2/edit"}' --project <p>`
(the same job is recorded once; `costs_get` then counts it from costs.json, not from the ledger). For a run that
belongs to an approved request, report it with `request_update {id, status: "done", outputs, actual_cost_usd}` instead.
From Python: `subprocess.run(["node", WB + "/mcp/client.mjs", "cost_record", json.dumps({...}), "--project", p])`.

## Adding a feature

- **A command** (everything the user can do is one): `WB.commands.register({ id, title, group, keys, when, checked,
  run })` in `core/defaults.js` (or a tab module). It appears in the palette (Ctrl+K), the cheat sheet (?) and Settings >
  keybindings automatically; keys are rebindable and stored per project.
- **A menu entry**: `WB.menus.contribute(context, [commandId | {label, submenu} | '-'])`; contexts `timeline`, `ruler`,
  `lyric`, `section`, `shot`, `clip`, `cast`, `note`, `header`, `entity`, `empty`, `global`, `columns`, `stage`, `scene`,
  `menubar:<File|Edit|View|Timeline|Generate|Window|Help>`. Elements with `data-sel="kind:id"` are selectable.
- **A view**: `tabs/<name>.js` exporting `{ mount(el, ctx), show?(ctx) }` plus one line in `tabs/registry.js`, as a
  sub-view `{id, title, load, count?}` under Assets or Review (or `WB.app.registerSub(pageId, sub)` at runtime).
  Re-render on `store.on(what => ...)` (`'all'` after a full reload, else the field name: `notes`, `requests`, ...).
- **A column**: one object in `js/columns.js` (`kind: 'text'` drive/follow or `'lane'` canvas).
- **A stage workspace**: a module in `tabs/` loaded from `MODULES` in `tabs/stage.js` and imported by `core/rail.js`
  (so its commands exist before it is opened); offer `WB.stageActions[<stage>] = {canSave, save, canNote, note}` and
  the rail's `stage.save` (Ctrl+Enter) / `stage.note` (Alt+N) reach it. A sketch anywhere: `mountSketch(el, {sketch?,
  id, resolve: mediaUrl, save})` from `core/sketch/sketch.js`, saving through `POST /api/op/sketch_save` (stage 4 mounts
  it over a node image for an edit: strokes, mask and pins go into the request). A new asset kind: a `TYPE` entry in
  `js/assets.js` (root tree, variant prefix and field, words, axes, request kinds, estimates) and a `UI` entry in
  `tabs/assetws.js`; a stage module mounts `new AssetWorkspace(el, {types, stage, pref})` and calls `assetCommands`.
- **A page-only act** (the director's decision): an op in its `lib/ops/<domain>.mjs` that fails unless `via === 'page'`, and one
  line in `serve.mjs` setting `body.via` from the request's Origin (see `breakdown_promote`, `character_act`,
  `asset_act`, `ref_upload`); no MCP tool; a security check that the agent surface gets 403.
- **An agent op / MCP tool**: a function in the `Object.assign(ops, {...})` of its `lib/ops/<domain>.mjs` (it is then
  also `POST /api/op/<name>`; see "Where to add an op or a tool"), and a `mcp.registerTool` in `mcp/tools/<domain>.mjs`
  with a zod schema and a description an agent can follow; cover it in `mcp/test.mjs`.
- **Tests**: `npm run test:mcp` and `npm run verify` must pass (the verify suite runs on the demo; the owner's extra
  Part B checks run only on his own project). Add a check next to the feature you touched.
