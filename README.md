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

**Lyrics first, song later**: `node importers/new_project.mjs my-song --lyrics lyrics.txt --title "My Song"` (or File >
New project in the page: a wizard, name -> lyrics -> song optional) makes a lyrics-only project: a placeholder length
(~4 s a line), estimated line timings, the lyrics stage in progress. Add the song when you have it (Lyrics stage >
Add song…, or the MCP tool `song_attach`): peaks, energy, grid and the real duration are computed and the lines are
re-timed over the song (LRC tags win, else estimated as above).

**Settings of this machine** (optional, gitignored): copy `workbench.config.example.json` to `workbench.config.json`:
`default_project`, `data_dir`, `media_base` + `media_roots` (folders outside the project served read-only at
`/media/<path>`, e.g. a renders folder), `private_media` (regex of PRIVATE paths: local only, never exported).

**Tests**: `npm run test:mcp` (MCP end to end on the demo) · `npm run verify` (headless UI suite on the demo:
screenshots + alignment + perf + writes + commands + the guided flow, stages 1-6 -> `shots/`; `node tools/verify.mjs --project <id>`
for another) · `npm run test:security`. All of them work on scratch copies of the data, never on `data/`.

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
`media_add`, the notes of every stage and the timeline in one list: `notes_get` / `notes_add` (any row: a lyric line or word range, a
scene or beat, an item, an asset / tree / node + image pin, a shot, a time) / `notes_status` (absorbed with a reply; the director's
notes are dismissed only by the director), and the old `notes_list` / `note_add` / `note_resolve` (the timeline); review rounds:
`round_get` (the round the director sent: its notes by stage with the content they point at) / `round_absorb` (a note done,
linked to the change) / `round_reply` / `round_finish`, and `revisions_get` (the revisions R1, R2, …, and a per-stage compare
of two); proposals: `proposals_add` (3 free choices on a scene, a shot, a lyric line, a look: SVG made with code, sanitised
on the server, or a short text) / `proposals_get` (the sets, the director's picks and mix notes, the "3 more" asks); `approvals_get` / `approve` / `request_changes`, `requests_list` /
`request_create` / `request_update` (`recipe`: the photoreal prompt blocks; `warnings[]`), `costs_get` (one total over costs.json and
`media_add`, `notes_list` / `note_add` / `note_resolve`, `approvals_get` / `approve` / `request_changes`, `requests_list` /
`request_create` / `request_update` (`recipe`: the photoreal prompt blocks; `warnings[]`; `takes`), `request_run` (run approved requests: the runner) / `generators_get`, `costs_get` (one total over costs.json and
a falgen ledger), `cost_record` (spend made outside the queue, never an approval), `media_update`, `wait_for` (block
until a request / stage / note changes), `ui_focus`; the guided flow: `stages_get` / `stage_update` (the per-stage note tools below
are aliases that write the same notes.json v2 and answer in their old shapes),
`lyrics_get` / `lyrics_update` / `lyrics_versions` / `lyrics_note_add` / `lyrics_note_resolve`, `song_attach`; stage 2:
`intake_get` / `intake_answer`, `script_get` / `scenes_update`, `scene_note_add` / `scene_note_resolve`, `sketch_save` /
`sketch_get` / `sketch_list` (image paths + pins, so the agent can look at the director's drawings); stage 3:
`breakdown_get` / `breakdown_update`, `breakdown_note_add` / `breakdown_note_resolve`; stage 4: `character_get`,
`character_iteration_add`, `character_note_add`, `look_create`; stages 4 and 5, any asset (characters, locations, props): `asset_get`,
`asset_iteration_add`, `asset_note_add`, `variant_create`, `base_propose` (a base the director accepts in one click),
`node_import_propose` (an existing registered image as a node, e.g. the identity head; the director accepts or imports
any image directly in the page) (generations carry an `asset` link; the `character_*` tools
are the same code for a character); stage 6: `storyboard_get`, `shots_update` (a new version each time), `shot_note_add` /
`shot_note_resolve`, `gaps_get` (what is still missing, the draft requests per shot and the estimate against the cap).
Resources: the README, `CLAUDE.md`, the file formats, the
skill, and each project's JSON files. Prompt: `director-session`. Rules the tools enforce: an agent cannot approve on
its own, a request runs only after the director approved it, queueing is refused above the cost cap, and `done` needs
the output files and the actual cost (recorded in `costs.json`, outputs indexed as media). The agent guide is
`CLAUDE.md`; the Claude Code skill `.claude/skills/director-workbench/` loads automatically when you open this folder.

## Using it

- **The guided flow** (`docs/SPEC_v3_GUIDED.md`): a project is made in seven stages, **1 Lyrics · 2 Script ·
  3 Breakdown · 4 Characters · 5 Scenery · 6 Storyboard · 7 Final**. The **stage rail** (one 18 px row under the top
  bar, hidden with it, or alone with View > Stage rail) shows each with a status dot (hollow = empty, amber = in
  progress, red = needs you, green = done) and, at the right, `next: <stage> · <what blocks it>`. Click a stage (or
  Alt+Shift+1..7, palette "Go to stage: Lyrics", right-click on the rail) to open its workspace; its bar has the status
  buttons: **only the director marks a stage done** (here or on the rail; agents can set in progress / needs you and
  blockers). Later stages can be opened early. A project made before the flow counts stages with content as done.
- **Notes** (SPEC v4 §1): every stage workspace has a **Notes column** on the right of its rows, **row-aligned**: a
  note sits on the row it is about (a lyric line or a section tag, a scene (its beats' notes tagged b1, b2…), a
  breakdown item, a tree branch / the open node, a scene's use of an asset, a storyboard scene (its shots' notes tagged
  with the shot), a final shot); a row grows when its notes need the room. The thin top row holds the notes on the
  whole stage (and on rows not shown). **Click an empty cell** (or **Alt+N** on the selected row) to type: Enter saves,
  Shift+Enter a new line, Esc cancels; `@agent …` (or the `→ agent` toggle) makes it an ask the agent reads. On a
  note: ↩ reply, ✓ done (absorbed), × dismiss, ↺ reopen; `open / all` in the column header; View > Notes column hides
  it. The **timeline** notes column is time-aligned (warped like every column): it holds every note with a time (the
  timeline's own, and the stages' notes on a line, scene, beat or shot, tagged lyr / scr / sto…); **click an empty spot**
  to type a note at that ms. **Right-click "+ Add"** everywhere: lyrics (+ line above / below, + verse, + section),
  script (+ scene here, + beat at this time), timeline (+ note at this time, + scene here, + shot here), storyboard
  (+ shot), breakdown (+ item by kind), trees (+ note on this node, + pinned note), any row (+ note here); every one is
  undoable (Ctrl+Z) and in the palette. The **stage rail** shows each stage's open notes; the top bar "N open notes"
  counts them all (click: Review › Notes, every note in one table). All notes are one list, `notes.json` v2 (the old
  per-stage note lists are read into it once: see Files). The Notes column takes the width the stage's rows leave
  (the lyrics: everything right of the poem, up to 800 px; elsewhere about a fifth of the stage, 236-400 px).
- **Review rounds and revisions** (SPEC v4 §2): the right end of the stage rail reads **Round N · K open notes**. When
  your notes are in, click **Send round to Claude** (or File › Send round): every open note of yours goes to the agent
  as one ask, and notes you write afterwards wait for the next round. While the agent works the rail shows its progress
  (**absorbed · replied · left**, a small bar); when it says it is done, **Close revision R<n>**: the whole project is
  snapshotted (immutable) and indexed. The **R<n>** chip on the rail (or File › Compare revisions, Review › Compare)
  opens **Compare**: the revisions on the left (round, summary, notes absorbed, files, cost; a click compares one with
  the one before), and A → B on the right (default: the latest against the previous one, or "R0", the state before
  the first round): the lyric lines changed (word diff), scenes and shots added / removed / moved on a mini time line,
  breakdown items, each asset tree's head as image A / B, the cost delta, and the notes absorbed in between; each change
  carries the chip of the note that caused it. **restore** (two clicks) puts the project files back to a revision (the
  current state is snapshotted first; your notes stay as they are). File › Mirror revisions to git (off by default)
  also commits each revision into `data/<project>/.history`, a git repository of its own, if git is on PATH.
- **Proposals** (SPEC v4 §3): where a choice is visual or open, the agent attaches 3 small choices, each an SVG made with
  code (composition, framing, silhouettes, colour blocks, a camera arrow) or a short text, with a title and a why. They
  show as a compact strip next to the target (a scene's sketch and idea, a shot's frame in the Shot panel, a lyric line,
  a look or a location variant; a closed scene shows tiny thumbnails, a shot card a ◇ badge); click a thumbnail for a
  larger view. **Pick**: an SVG becomes the scene sketch's underlay / the frame sketch's base layer, a text replaces the
  line / the scene text / the shot's action in your draft (Ctrl+Z puts it back); **Mix**: pick + a note telling the agent
  what to change; **3 more**: an ask for the agent (its next proposals on that target answer it); **×** dismiss. The ◇
  on a lyric line's tools asks for 3 alternatives. Generate > **Prepare proposals** asks the agent for starting choices
  on a stage; Generate > **Make free layouts** makes 3 SVG layouts per scene and shot right away, with no agent and no
  cost (wide / medium / close, rule-of-thirds silhouettes in the cast's colours, a camera arrow read from the beats).
  After a first save of the lyrics, script or storyboard (and in the new-project wizard, unticked) the page offers to
  prepare starting proposals; it never runs by itself. Picks are yours: the agent reads them (`proposals_get`).
- **New project** (File > New project, and automatically on an empty project): a wizard, **name -> lyrics (paste) ->
  song (optional path on this machine) -> Create**; opens the new project on the lyrics stage. File > New empty
  project keeps the old one-line prompt.
- **Lyrics stage** (stage 1): the poem as lines under their `[Section]` tags, each with its time (`~` = estimated;
  click = show it in the timeline). Double-click / Enter / F2 edits a line (Enter keeps, Tab next line, Shift+Enter a
  new line below, Esc cancels, an empty line is removed); hover tools move (↑↓, Alt+↑↓), add, edit, note, delete lines
  and sections; **Edit as text** for pasting or bulk edits (`[Section]` tags; unchanged and reworded lines keep their
  ids, so timings and notes follow). Edits are a draft (kept in this browser) until **Save version** (Ctrl+Enter, with
  an optional message): every save is a new version, and the song's lines (the timeline lyrics column) follow at once,
  keeping the timings of the lines that still exist. **Notes** (the Notes column, right next to the poem): select
  words in a line -> `+ note` (or Alt+N; with no selection, on the focused line) types a note pinned to those words
  (they stay underlined); who wrote it shows as the bar colour (amber = director, violet = agent). **Ask the agent**
  (palette, or `@agent` in a note) writes a note addressed to the agent (MCP `lyrics_get` lists it under
  `asks_for_agent`): nothing is generated, nothing is paid. **Versions** (the bar's Versions button): the list,
  A/B -> side-by-side word diff (or click a row: it vs the one before; `diff` in the bar compares your unsaved edits),
  **Restore** = a new version copied from the old one. **Add song…** attaches the song file.
- **Script stage** (stage 2): the song as a list in time order, each **scene** next to the lyric lines it covers and
  every unscripted stretch as an amber **gap** row (`+ scene here`); the bar shows the version, the scene count and
  how much of the song is scripted. Click a scene to edit it in place: title, **from / to** (m:ss.mmm; snapped to
  lines, bars or sections with the bar's `snap`; `from = playhead`), the description, timed **beats** (`+ beat`), and
  **sketches**: `+ new sketch` opens the sketch tool inline under the scene (Ctrl+S saves the drawing: `sketches/<id>`
  .json/.png/.mask.png, a media item of kind sketch), `window` opens it floating, `copy` then `paste` on another
  scene makes a copy for that scene. The scene status (**draft / needs you / ok**) is saved at once; ok is the
  director's. Edits are a draft (kept in this browser) until **Save version** (Ctrl+Enter); a new sketch on a clean
  draft is saved as a version by itself. **Fill the gaps** writes an ask for the agent listing the unscripted
  ranges (`script_get` `asks_for_agent`); the agent answers with `scenes_update` and the page follows live. The Notes
  column sits on each scene's row (Alt+N: the open scene). Side panel: **Intake** (the nine starting questions,
  answered here or in a chat; "asked in chat" marks; **Ask for a draft**), **Versions** (A/B side-by-side diff with the
  scenes added / changed / removed, restore). Right-click a scene (+ Add: scene here = a split at the clicked line's
  time, beat at this time; a gap: scene here) for its commands; double-click a scene in the timeline Scenes column to
  open it here.
- **Breakdown stage** (stage 3): what the script needs, as **items** of five kinds (characters, locations, props,
  wardrobe, FX), each linked to the scenes (and beats) that need it. **Suggest from script** makes a first list here and
  now, without an agent (a deterministic pass over the scene titles, text and beats and the intake answers: capitalised
  names and the "who" answer become characters, places after "in / at / to…" and the "where" answer locations,
  garments after "wearing / her / his…" wardrobe with its owner, a short list of objects props, of effects FX);
  **Ask the agent to extract** writes an ask the agent reads (`breakdown_get`). Two views: **List** (grouped by kind; a
  row shows the status, the source, the entity it became and its scene chips; click to edit in place: name, kind,
  status, description, wardrobe owner, scenes with their beat chips and a note each) and **Matrix** (items × scenes; a
  click on a cell links / unlinks; a scene header filters to that scene's items; scenes without a character in amber).
  Director tools, all commands with menus: **merge** (Ctrl+click several, the selection bar or right-click; pick which
  name stays, the others become aliases), **rename** (double-click), **drop** (soft: greyed, restorable), **split**
  (pick the scenes that go to the new item), **change kind**, link / unlink. Edits are a draft until **Save version**
  (Ctrl+Enter); item statuses (draft / review / ok) are saved at once, ok is the director's. **Create entity** turns a
  character, location or prop into a draft entity in Assets (or links it to an existing one) and a wardrobe item into a
  look on a character: no images, no request, nothing spent; page only. The Notes column sits on each item's row (list
  and matrix; notes on a scene in its top row); **Versions** (the bar's button: A/B diff, restore). Right-click an item
  > + Add (an item of any kind); a scene (timeline, script, matrix) > **Breakdown items in this scene**; the timeline
  Scenes column shows each scene's characters and locations under its title.
- **Characters stage** (stage 4): the characters of the breakdown (left: each with the scenes it appears in and where
  it stands: needs a base / base chosen / identity · n nodes / identity approved / looks a/n approved; breakdown
  characters not yet entities are listed greyed with a link to make them). Per character, three tabs:
  **Identity**: the **base**, from any mix of the CC0 **catalogue** (`catalog/`, filtered by kind and tags),
  an **Openverse** search (from your browser straight to `api.openverse.org`, CC0 + public domain by default, "+ CC BY"
  optional; sensitive results hidden; a warning on photographs of people; the chosen image is stored in
  `refs/<character>/` with its licence, creator and URL), a **description**, your own **reference photos** (upload or a
  path on this machine: stored under `private/refs/<character>/`, flagged private, never exported) and a **sketch**.
  **Request identity sheet** makes a DRAFT generation request (refs, tool and an honest estimate); **Approve** it here
  (the steps draft › approved › running › done show on each request); an agent runs it through MCP and the output
  comes back as a node of the **iteration tree**, drawn as horizontal strips, one per branch (● head, ✓ approved,
  "new" = waiting for you). Open a node: **Edit from nX** opens the sketch tool over the image: say what to change in
  text, draw on it, paint a **mask** (M: only that region changes) and drop numbered **pins** (P: "necklace here,
  silver"); **Request edit** sends all of it as a draft request. A new node opens **side by side with its parent**:
  A/B **slider**, **toggle** or **side by side**; then **Keep** (it becomes the head), **Branch** (kept on a side
  strip) or **Revert** (dropped; the head stays). **Make head** goes back to any node. **Approve identity** locks it
  (page only; Unlock reopens). **Looks**: one tree per costume, starting from the approved identity; the breakdown's
  wardrobe items are its draft looks (or "make it a look"), **+ New look**, **Request look sheet**, then the same edit /
  compare / keep loop and **Approve look**. The Notes column: the character's notes in its top row, a node's on its
  branch strip or on the open node; **📍 pin** (or right-click a node > + pinned note) then a click on the image pins a
  numbered note there. **Notes** tab: one row per thing notes are on (a tree, a node, a scene) and the history of every
  act. **Scenes**: the look each scene needs (see the Scenery stage). Commands: palette
  "Characters: …", right-click a node (compare, edit, keep, branch, revert, approve), Ctrl+Enter sends the open edit
  request.
- **Scenery stage** (stage 5): locations and props on the same workspace as the characters (one code path:
  `tabs/assetws.js`, logic in `js/assets.js`). Left: the breakdown's **Locations** and **Props** in two groups, each with
  its scenes and where it stands (needs a base / base chosen / base · n nodes / base approved / variants a/n approved;
  items not yet entities greyed, "make…"). Per asset: **Base**: the same base picker (the catalogue opens on its
  locations or props, Openverse, a description, private photos of a real place or object, a sketch), **Request base
  plate** (a location: an establishing plate, wide, empty of people) / **Request prop sheet**, then the same iteration
  tree, edit (text + sketch + mask + pins), A/B compare, keep / branch / revert and **Approve base** (page only; sets
  the location's `establishing` / the prop's `hero` image when it has none). **Variants**: each variant is its own tree
  starting from the approved base; **+ New variant** opens a one-line-per-axis form: a location's **angle** (wide /
  medium / reverse / custom), **time of day** (dawn / day / dusk / night) and **weather** (clear / overcast / rain / fog
  / snow / custom); a prop's **angle** and **state** (broken / lit / wet / open / custom); the name and id follow the
  axes ("reverse · night · rain", `reverse-night-rain`); **Request variant sheet** starts from the approved base;
  **Approve variant**. **Scenes**: every scene that uses the asset (from the breakdown links) with a picker for the
  variant it needs (the base or a variant; "you" = your pick, "agent" = the agent's proposal, "default" = the base),
  the variant's image and the scene text; add any other scene. The pick is saved in the entity (`uses`), page only,
  and is what the storyboard reads. **Notes**: on the asset, a tree, a node or a scene. Commands: palette "Scenery: …",
  Ctrl+Enter sends the open edit request.
- **Storyboard stage** (stage 6): the script's scenes in song time (unscripted stretches as amber rows), each a strip of
  **shot cards** that **tile** the scene: the first starts with it, each ends where the next starts, the last ends with
  it. A 6 px rail above each strip shows the cuts (alternating shades), the bars (ticks) and the scene's beats (dots).
  A card: id, start, length, kind, the status chip, the **frame** (the frame sketch, the shots.json render frame, or
  "no frame · draw"), ▶ video / ▣ still, the action, ⌖ camera / motion, the **asset chips** (C / L / P, green = the
  variant it needs is approved, amber = not yet; the variant name when it is not the root) and the generation request
  or clip (or "no request · ~$ est"). **Shots from beats** proposes, for every scene without shots, one shot per scene
  beat or group of beats closer than a bar, cut on the beat grid (a long stretch is cut again every ~4 bars), with a
  kind guessed from the words (sings -> performance, hands / letter -> insert, face -> close, the first -> wide), the
  beats' text as the action and the breakdown's cast / locations / props (an item linked to given beats only on the
  shots holding them); a scene's own **from beats** redoes it. **Shot** panel (click a card; ← / → step): status
  (draft / review / changes / **approve**, the director's, in `approvals.json` as `shot:<id>`), from / to (snapped to
  beats or bars with the bar's `snap`; ◂ ▸ nudge a boundary by a beat; a boundary moves both shots), kind, still /
  video with its estimate, title, action, camera / motion, the **frame** (`+ draw` opens the sketch tool inline under
  the scene, 16:9, over the shot's location image when it has one; `window`, `copy`, `paste` into another shot), the
  **assets** with a per-shot variant picker ("scene's: …" = the Scenery / Characters pick, or the root, or any
  variant) and a link to an asset that is not approved, quick "+ Name" adds for what the scene needs, the generation
  requests (Approve / Reject drafts here) and **Request still / start frame / video** (a DRAFT request, target
  `shot:<id>`, refs = the approved variant images + the frame sketch, honest estimate), **Split at beat**, **Merge with
  next**, **◂ Move / Move ▸** (swap, lengths kept), **Delete** (its time goes to the neighbour). **Gaps** panel:
  everything still missing across the stages, each row a jump link: unscripted time (-> the script), scenes without
  shots, shots without a frame, assets the shots need that are not approved (-> the characters / scenery stage on that
  asset), shots without a request or clip; and the **estimate** of generating those shots against the cap (a meter:
  spent, committed, this estimate, other drafts, the cap mark; a warning over the cap or with a $0 cap). **Fill the
  gaps** and **Ask the agent to storyboard** write asks the agent reads (`storyboard_get` / `gaps_get`); **Versions**
  (A/B diff, restore). The Notes column sits on each scene's row (its shots' notes tagged with the shot; Alt+N: the
  selected shot); right-click a shot or a scene > + Add > + shot. Edits are a draft until **Save version**
  (Ctrl+Enter); a new frame on a clean draft is saved as a version by itself. The timeline **shots** column shows the
  storyboard's shots (frame thumbnails), and the cast / status columns follow them. Commands: palette "Storyboard: …",
  right-click a shot (board or timeline): open in the storyboard, frame, split, merge, move, copy / paste frame,
  request, note, delete.
- **Final stage** (stage 7, a placeholder until phase 7): every storyboard shot in time order with its approval state
  and its request or clip, the counts per state, and the Notes column on the shots (the notes for the last pass).
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
  (hide, strip, drive/follow, width presets, move, settings, reset), entity card, empty space (paste, hidden columns);
  **+ Add** first in every stage row's menu and on the timeline (see Notes).
- **Column header** (16 px): hover a name for `D/F` (drive / follow), `▸` (collapse to a strip), `×` (hide).
  `⋮` at the right lists every column.
- **Drive vs follow**: a drive column's measured heights push the axis (lyrics, events, script, cost, notes by
  default); a follow column clips to it (sections, shots, clips, cast, status). Hidden, collapsed and follow columns
  do not push, so hiding a column tightens time. A **folded** section is drawn at 0.6 px/s and its text is hidden.
- **Edits** (all undoable per session): approval chips (click cycles `draft → approved → changes`, or A / R), notes
  (add, reply, done, dismiss, edit, delete), the stage drafts' "+ Add" (a line, a verse, a section, a scene, a beat, an
  item, a shot), section label/colour (`overrides.json`), generation requests (`requests.json`).
  `song.json`, `shots.json` etc. stay the importer's: timing / take / in-point changes become **requests** for the
  agent. The page never calls a paid API.
- **Projects** (File menu): new (the wizard), new empty, new from template (copy without notes/approvals/requests), open, recent,
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
| scenes | text, follow | on | stage 2 (`scenes.json`): each scene (title, text, sketch count, status colour; stage 3: its characters and locations from `breakdown.json`, + the count of other items) on the left, its beats on the right, each at its own time; double-click = open it in the script stage |
| shots | text, follow | on | stage 6 (`storyboard.json`, else `shots.json`): each storyboard shot, its frame sketch (else the render frame), kind, status dot |
| clips | text, follow | on | world-clip uses (clip.take +in-point), frame at the in-point, location colour; overlaps share width |
| cast | text, follow | on | cast chips + location letters per storyboard shot |
| status | text, follow | on | approval chips for the shot and each clip use inside it |
| cost | text, drive | hidden | $ per generation job at its first use, running Σ / cap |
| notes | text, drive | on | every note with a time (notes.json v2): the timeline's, and the stages' on a line, scene, beat or shot (tagged); a click on an empty spot types a note at that ms |

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
| `entities/{characters,locations,props}/<id>.json` | `{id, kind, name, role|description, refs[paths], thumb, status, private_refs?, breakdown?{item, scenes}, ...}`; `entities/index.json` lists them. A character also carries `looks[{id, name, garments[], colors[], images[], notes, status: draft/review/approved, from?: breakdown/agent/page, breakdown?}]` and stage 4: `base{text, refs[{path, source: catalog/openverse/photo/sketch/media, private?, title?, licence?, licence_url?, creator?, url?, original?, attribution?, catalog_id?, openverse_id?}], at, by, via}` and `iter{nodes[{id: "n03", tree: "identity" \| "look:<id>", parent, from_identity?, image, request, kind: identity/edit/look, edit{text, sketch?, png?, mask?, pins[{n, x, y, text}]}, choice: null/kept/branch/reverted, private?, at, by, via, note?}], trees{<tree>: {head, approved?, approved_at?, approved_by?, via?}}, notes[{id: "cn01", tree?, node?, text, by, via, to?, status, at, replies[]}], log[{at, by, via, act, tree?, node?, detail?}]}`: append-only (a node never changes except the director's `choice`; every act is logged); `identity_sheet` = the approved identity image. Catalogue paths (`catalog/...`) are relative to the workbench folder. Locations and props (stage 5) carry the same `base` and `iter` (trees `"base"` and `"variant:<id>"`, node kinds base/edit/variant, notes `"an01"`) and `variants[{id, name, axes{angle?, tod?, weather?} (location) \| {angle?, state?} (prop), notes, images[], status: draft/review/approved, from?: page/agent, scenes?[] (the agent's proposal), breakdown?}]`; `sheet` = the approved base image. Every asset may carry `uses{<scene id>: {variant: <variant / look id> \| null (the base / identity), by, via: "page", at, note?}}`: the variant each scene needs (the director's pick; without one, the variant the agent proposed for that scene, else the base). Logic: `js/assets.js` (shared), `js/characters.js` (the stage-4 names) |
| `notes.json` | v2, ONE list for every stage and the timeline: `{v: 2, rev, round, notes[{id, target{stage: lyrics/script/breakdown/characters/scenery/storyboard/final/timeline, kind, id, w?, quote?, t?, pin?{x, y}, line?, scene?}, text, by, via: page/agent/import, status: open/absorbed/dismissed, round, replies[{id, text, by, via, at}], absorbed_in, created, to?: "agent", ask?: request/fill_gaps/extract/storyboard, gaps?, version?, marker?, about?, legacy?{store, id}}], legacy_seen[]}`. Kinds per stage: lyrics stage/section/line (+ `w`, `quote`); script stage/scene/beat (`"sc02/b1"`); breakdown stage/item/scene; characters / scenery stage/asset/tree (`"ada/look:x"`)/node (`"ada/n03"`, + `pin`)/use (`"ada/sc02"`); storyboard stage/scene/shot; final stage/shot; timeline time (`t` ms). Shapes and logic: `js/notes.js`. **Migration**: on its first read the server (or the page, on a static host) reads the old stores into it without loss: notes.json v1 `{rev, notes[{id, t, line_id, by, text, status, at, about?, reply_to?}]}` (kept as `notes.v1.json`; a `reply_to` note becomes a reply), and the `notes` of `lyrics.json`, `scenes.json`, `breakdown.json`, `storyboard.json` and each entity's `iter.notes`; those files are never written for notes again (a note added to one later is imported once; `legacy_seen` keeps a deleted one from coming back) |
| `approvals.json` | `{rev, states[], items:{"<kind>:<id>": {state, by, at, why?, comment?}}}`; kinds: `shot`, `use`, `job`, `script`, `character`, `location`, `prop` |
| `costs.json` | `{cap_usd, fal_total_usd, items[{id, t, usd, tool, date, request?, via?, job?, take?, note?}], pre_production[], ledger[]}`; `project.json` `falgen` (a folder inside the media base, read only) adds its spent.json / LEDGER.md rows to `costs_get` (deduplicated by job) |
| `peaks/<id>.json` | `{bin_ms:5, n, scale, min, max}`: min/max per 5 ms bin, int8 (value/127*scale), base64; ~140 KB each |
| `thumbs/*.jpg` | small frames: `shot_<id>` (render), `use_<clip>_<take>_<in_ms>` (clip at the in-point), `ent_<id>` |
| `_src/edl.json` | raw `WORLD.clip` calls from the render page (input to the importer) |
| `media.json` | `{generated, count, by_kind, items[{id, path, kind, label, entities[], shots[], uses[], take, job, group, size, w, h, duration_ms, private, status: used/picked/unused/private, cost_usd, thumb, strip?, strip_n?, packed_alpha?}]}`; kinds: render, clip, still, avatar, body, motion, dancer, motion-ref, sheet, variation, contact, audio, ref |
| `thumbs/m_*.jpg`, `s_*.jpg`, `priv_*.jpg` | media thumbnails (max 240 px, sheets 600 px), 8-frame hover-scrub strips of videos, thumbnails of PRIVATE files |
| `_src/probe.json` | ffprobe cache (size/mtime keyed) |
| `requests.json` | `{rev, items[{id, kind, target, prompt, refs[], est_cost, tool?, status: draft/approved/queued/running/done/failed/rejected, by, at, takes?, outputs?[], generator?, linked?{type, id, tree, nodes[], proposals[]}, handoff?{generator, pack, results}, last_run?{at, status, why}, asset?{type: character/location/prop, id, tree, from, kind: identity/base/edit/look/variant, text?, sketch?, png?, mask?, pins[]}, warnings?[], recipe?{id, version, model, framing, fields, blocks[]}}]}`; kinds: regenerate, new-costume, new-variant, generate, duplicate, choose-take, set-in, edit-timing, swap-costume, section-variant, import, identity-sheet, character-edit, look-sheet, location-plate, location-edit, location-variant, prop-sheet, prop-edit, prop-variant. `asset` links a stage-4 / 5 generation to the asset tree it grows; older requests may carry it as `char` (still read; `request_create` accepts `char` with a deprecation warning and stores `asset` only) |
| `refs/<id>/`, `private/refs/<id>/`, `private/{characters,locations,props}/<id>/` | stage-4 / 5 references: Openverse images (public, provenance in `media.json` `provenance{}`), the director's reference photos (always private), and iteration images made from private photos (private) |
| `overrides.json` | `{rev, sections:{<id>:{label?, color?}}}`: the director's section renames / colours over `song.json` |
| `settings.json` | `{rev, keybindings:{<command id>:[keys]}}` (not snapshotted) |
| `project.json` | `{title, created, from?}` |
| `stages.json` | `{rev, stages[{id: lyrics/script/breakdown/characters/scenery/storyboard/final, status: empty/in_progress/needs_you/done, done_by?, via?, updated?, updated_by?, blockers[], note?}]}`: the guided flow (shared with the page; only the page sets `done`, stamped `done_by: "director", via: "page"`); missing = derived (content = in progress, never done); `stages_get` adds `shown` / `content` / `changed`, computed from the files (js/flow.js `stagesView`) |
| `lyrics.json` | `{rev, current: "v3", seq, versions[{id, n, created, by, via, message, from?, sections[{id, label, lines[{id, text, t?}]}]}], notes[{id, line, w: [first, last word] \| null, quote, text, by, via, to?: "agent", kind?, status, at, version, replies[{id, text, by, via, at}]}]}`: stage 1. Versions are immutable (a save appends one and moves `current`; the server keeps its copy of every saved version); line ids are stable across versions and are the `song.json` line ids (a missing file reads as v1 derived from `song.json`). The server re-syncs `song.json` lines on every new current version |
| `scenes.json` | `{rev, current, versions[{id, n, created, by, via, message, from?, scenes[{id: "sc03", t0, t1, title, text, line_ids[], beats[{id: "b1", t, text}], sketches[ids]}]}], states{<scene>: {status: draft/needs_you/ok, by, via, at}}, notes[{id: "sn01", scene \| null, beat?, text, by, via, to?: "agent", kind?: request/fill_gaps, gaps?, status, at, version, replies[]}], intake{<question>: {text, by, via, at, asked?}}}`: stage 2, the script draft (shared with the page). Versions are immutable (a save appends; restore copies); statuses and intake answers live outside them; only the page sets a scene `ok`. A missing file reads as v1 derived from `script.json` (`stages` -> scenes, `lines` -> beats), which is never rewritten. Shapes and logic: `js/scenes.js` |
| `breakdown.json` | `{rev, current, versions[{id, n, created, by, via, message, from?, script?, items[{id: "bi03", kind: character/location/prop/wardrobe/fx, name, description, links[{scene, beats[], note?}], source: agent/director, aliases?, for? (wardrobe: the character item), dropped?}]}], states{<item>: {status: draft/review/ok, entity_id?, look_id?, by, via, at}}, notes[{id: "bn01", item \| null, scene?, text, by, via, to?: "agent", kind?: request/extract, status, at, version, replies[]}]}`: stage 3, the breakdown (shared with the page). Versions are immutable (a save appends; restore copies); statuses and entity links live outside them; only the page sets an item `ok` or links it to an entity ("Create entity": a draft entity in `entities/`, or a look on a character). Links name scene / beat ids of `scenes.json`. Shapes and logic: `js/breakdown.js` |
| `storyboard.json` | `{rev, current, versions[{id, n, created, by, via, message, from?, script?, shots[{id: "sh03", scene, t0, t1, kind: wide/medium/close/insert/performance/xp-desktop/…, title, text, camera, sketch, beats[], cast[], locations[], props[], variants{<entity>: <variant / look> \| null}, gen: still/video/null, clips[], thumb?, section?}]}], notes[{id: "sbn01", shot, scene?, text, by, via, to?: "agent", kind?: request/storyboard/fill_gaps, gaps?, status, at, version, replies[]}]}`: stage 6, the storyboard. A version is immutable (a save appends one); the shots of a scene tile it; the variant each asset needs is the scene's (entity `uses`) unless `variants` overrides it. The shot's approval is `approvals.json` `shot:<id>`. Missing = v1 derived from `shots.json` (never rewritten; its readers keep working). Logic: `js/storyboard.js` |
| `sketches/<id>.json` / `.png` / `.mask.png` | a sketch: `{id, w, h, paper, underlay{src, opacity, fit}, strokes[], mask[], pins[{n, x, y, text}], title?, created, updated, by, via}` (format: `core/sketch/sketch.js`), the flattened image and the edit mask; written by `sketch_save`, registered in `media.json` (`kind: "sketch"`, `sketch`, `mask`, `scenes[]`, `pins`); under `private/sketches/` when drawn over a private image; not snapshotted |
| `.snapshots/<yyyymmdd-hhmmss>-<slug>/` | copies of the small JSON files (no peaks, thumbs, `_src`, settings, revisions.json) + `.meta.json {id, at, message, auto, files, revision?, immutable?}` |
| `revisions.json` | the review rounds and revisions (written by the server only; the page reads it): `{v: 1, rev, rounds[{n, status: sent/finished/closed, sent_at, sent_by, notes[ids], ask (the note to the agent), base (the snapshot when sent), finished_at?, summary?, closed_at?, revision?}], revisions[{id: "R3", n, round, created, summary, notes_absorbed[], notes_replied[], files_changed[], cost_usd, cost_delta, snapshot, base, by, via, git?: {commit} \| {skipped}}], restores[{at, revision, previous}]}`. A revision's snapshot is never changed; restoring one snapshots the current state first and keeps notes.json. Logic: `js/revisions.js`, `lib/ops/rounds.mjs` |
| `proposals.json` + `proposals/<set>-<item>.svg` | proposals (written by the server only; the page reads it): `{v: 1, rev, sets[{id: "ps03", target{stage, kind, id}, round, by, via, source: agent/local, created, answers?[note ids], items[{id: "a", title, why, svg?: "proposals/ps03-a.svg" \| text?, status: open/picked/mixed/dismissed, note?, at?, by?, via?}]}]}`. Every SVG was sanitised (`lib/svg-sanitize.mjs`) and is shown only as an image. One pick per set; picks are the director's. Logic: `js/proposals.js`, `lib/ops/proposals.mjs`, the local generator `js/proposals-local.js` |
| `.history/` | only with `settings.json` `revisions_git: true` and git on PATH: a git repository of its own with one commit per revision (the snapshot's files); never served, never the workbench's repository |

## How an agent edits them

- Edit **ms and text**, never layout. Any change re-flows every column: `serve.mjs` watches the data folder and pushes
  the changed file name over SSE (`/api/events`); the page reloads that file (approvals/notes in place, anything else
  rebuilds the timeline and keeps the scroll position by time).
- Invariants: `t0 < t1`; words inside a line are monotone and inside the line; ids stay stable (`intro/0`, `c1-desk`,
  `G05@20158`, `script:s07`).
- `approvals.json` / `notes.json` are shared with the page: read the file, change it, **bump `rev`**, write it whole
  (write a temp file and rename). The page posts `{base_rev, data}` to `/api/save/<file>`; a stale `base_rev` gets
  `409` and the page re-applies its change on top of the current file, so an agent's edit is never silently lost.
- To answer a note: `notes_add {reply_to, text}` (or append a reply to its `replies` in notes.json v2 and bump `rev`);
  when you did what it asks, `notes_status {id, status: "absorbed", reply}`. Only the director dismisses the director's
  notes. To ask for a review: set an item to `state: "review"`.
- Generation queue: read `requests.json`; run only `status: "approved"` items that the director approved in the page
  (a `log` entry `via: "page"`). The workbench runs them itself (see "Running approved requests" below): `request_run`
  (MCP / `/api/op`), `node tools/run.mjs`, or the page's Run buttons. A run made outside it is reported with
  `request_update` (MCP / `/api/op`): queued / running, then `done` with `outputs: [paths]` (or `failed` / `rejected` +
  `why`). The Queue tab shows it live.

## Running approved requests (the runner: `lib/run.mjs`, `generators/`)

Nothing is generated or paid until the director approves a request in **Review › Queue** (each draft has **Approve** /
**Reject**; tick several for **Approve selected · $X**). An approved request then runs from either side, through one
runner with one approval rule, one cap and one ledger:

- **The page**: **Run · $X** on a row, or **Run all approved (N) · $X**. Progress (uploading refs, in the provider
  queue, generating, take 1/2, done) comes live from the server (SSE).
- **An agent**: `request_run {ids, dry_run: true}` (the plan: generator, model, endpoint, takes, estimate vs the
  approved `est_cost`, the cap, outputs already on disk; nothing called, written or spent), then `request_run {ids}`
  (background; `wait_for {request, until: ["done", "failed"]}`) or `{ids, wait: true}`.
- **A shell**: `node tools/run.mjs --project <p> <ids…> | --all [--dry-run] [--parallel 2]`.

What a run does: only a request with the director's approval on record runs (a draft, rejected or done one is
refused; the runner never approves); the cap is re-checked when it is claimed (`queued`, 402 over it) and the
generator's estimate (`js/prices.js`) may not exceed the approved `est_cost`; `queued -> running -> done` (or `failed`
with `why`; a failed request keeps its approval and can be run again). Up to 2 at once. Outputs go to
`data/<p>/gen/<request>/<id>_<take>.png` (`private/gen/…` when a ref is private) with `job.json` (the provider's job
ids, per-take status and cost; never the key); a take whose file exists is skipped and a submitted job is polled again,
not paid twice. At done the actual cost (list price × completed takes) is recorded once in `costs.json` (item id = the
request, `via: "runner"`; `costs_get` and `cost_record` dedupe by it), the outputs are registered as media (linked to
the shot for a `shot:` target) and, for an asset request, added to its tree as nodes the director keeps or picks
(`asset_iteration_add`; a tree that refuses gets a `node_import_propose` proposal); the request records `linked`.

**Generators** (Settings › Generator, per kind: image / video / motion; `settings.json` `generators`; tool
`generators_get`): `fal` (default: Nano Banana 2 edit / text-to-image and Seedream 5 edit through fal's queue API, refs
uploaded to fal storage, 25 min timeout; video is D3b), `openwith` ("Open in another app": exports
`gen/<request>/pack/` with `prompt.txt`, `refs/`, `README.md`; the request waits, handed off, until you put the images
in `gen/<request>/results/` and press **Collect results**: they become its outputs at $0; **Copy prompt** puts the
prompt on the clipboard), `comfyui` (a stub: "not configured").

**The fal key** comes from the environment of the server / runner (`FAL_KEY`) or from `fal_key_file` in
`workbench.config.json`: a file outside the workbench and the data folder (`FAL_KEY=…` or the bare key); anything
inside the project is refused. It is sent only to fal's queue and storage origins, never logged, returned, or written
(Settings shows only where it was found). Tests use a mock fal (`tools/mock-fal.mjs`, `WB_TEST=1` + `WB_FAL_BASE`);
`WB_FAL_BASE` is ignored without `WB_TEST=1`.
- New columns: one object in `js/columns.js`. New views: one module in `tabs/` plus one line in `tabs/registry.js`,
  as a sub-view under its page (`{ id, title, load, count?(store) }` in the page's `subs`) or, rarely, a new page
  (a module exports `{ mount(el, ctx), show?(ctx) }`; `ctx.store`, `ctx.timeline`, `ctx.goto(ms)`). At runtime:
  `WB.app.registerSub('assets', sub)`. `WB.app.show(id)` takes a page id (`timeline`, `assets`, `review`, `settings`)
  or a sub-view id (`characters`, `queue`, `media`…: opens its page on it); `WB.app.newPage(viewId)` /
  `closePage('p:<viewId>')` for custom pages; `WB.context().tab` is the page, `.view` the visible sub-view.

## Server (`serve.mjs`)

Every `/api` call takes `?project=<id>` (default: `$WB_PROJECT`, the config's `default_project`, else `demo`). The data layer is
`lib/store.mjs`, shared with the MCP server.
`GET /api/config` (media roots, private rule) · `GET /api/status` (pages open; `code {hash, started, disk, stale, changed}`: restart the server when stale; every `/api` response carries the header `x-wb-code`) · `POST /api/op/<op>` (every MCP tool op, local
only; bodies up to 5 MB, `sketch_save` and `ref_upload` up to 25 MB) · `POST /api/ui {t?, range?, view?, select?, preview?, message?, play?, open_project?}` (live UI channel: pushed to the
open pages over SSE; returns `{pages, delivered}` once they ack via `POST /api/ui/ack`) ·
`POST /api/save/<file>` `{base_rev, data}` (409 + current file when stale) · `GET /api/events` (SSE `{project, file}`) ·
`GET /api/projects` · `POST /api/projects/new {id, title?, lyrics?, song?, bpm?}` (with `lyrics` / `song`: the wizard's guided project) · `POST /api/projects/duplicate {from, to, reset_state?}` ·
`POST /api/projects/delete {id}` (the default project is refused) · `GET /api/snapshots` · `POST /api/snapshot {message}` ·
`POST /api/restore {snapshot}` (auto-snapshots first, copies the snapshot's JSON back, removes files it did not have; costs and requests that ran since are kept) ·
`POST /api/reveal {path}` (Explorer at a media file). Writes are temp file + rename with retries (Windows locks);
small files are served in one read so no handle stays open.

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
  `connect-src 'self' https://api.openverse.org` (the stage-4 Openverse search; every other origin is blocked); every
  other file gets a sandboxing CSP and `nosniff`, so an HTML/SVG file in a project cannot run script in the workbench
  origin. An invalid `?project=` is redirected to the default project.
- A remote (LAN) client reads the project's JSON files scrubbed: no private path and no item flagged private (so
  `media.json`, a character's base and iteration nodes, requests built on private photos list nothing private).
- Paths with `..`, `.`, backslashes, NUL, `:` (NTFS streams) or `~<digit>` (8.3 short names) are rejected; dot-folders are never served; private files (by rule or
  `private: true` in `media.json`) live under `private/<kind>/` and are never exported or packaged.
- The request runner runs only requests with a recorded director approval, re-checks the cap, records each cost
  once, and keeps the fal key out of every response, file and log (README "Running approved requests").
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
  (`done_by: "director", via: "page"`). A page save of `lyrics.json` cannot rewrite a saved version nor a note's author;
  the tools stamp `via: "agent"`.
- Notes (`notes.json` v2): a target is checked (stage and kind known, ids without `..` / `.` / `\` / markup, the row
  exists: 404, word ranges, times inside the song, pins 0..1; text 1-8000 characters: else 400). An agent may reply,
  mark a note absorbed (with a reply) and reopen it, and dismiss only its own notes: dismissing a director's note, or
  reopening one the director dismissed, is 403 (HTTP, MCP and offline). A page save of `notes.json` stamps new notes and
  replies `by: "director", via: "page"`, keeps an existing note's author, via, created, target, round and an agent's
  words, stamps a status change `closed_by: "director"`, only grows `legacy_seen`, and refuses an old (v1) list or a
  bad target / status / id (400). Note texts are rendered as text everywhere (Notes columns, the timeline, Review).
- Proposals: picking, mixing and dismissing (`proposal_act`) are the page's acts only (the server passes `via: "page"`
  for its own Origin; no MCP tool; the agent surface, a foreign Origin and offline get 403); `proposals.json` is not a
  page save (403). `proposals_add` sanitises every SVG with an allow-list (elements: shapes, paths, text, groups,
  gradients, markers, clip paths, masks, patterns, `<use href="#id">`; attributes: geometry, paint, text, transforms) and
  refuses the rest with the reason: script, foreignObject, image, links, `<style>`, animate / set, on* handlers, external,
  `javascript:` or `data:` references (also entity-encoded), `url()` other than `url(#id)`, CSS escapes and expressions,
  DOCTYPE / entities / CDATA / processing instructions, more than 64 KB, a viewBox outside 0-10000 or 1:4-4:1. The kept
  markup is written out again from the parsed tree (values re-escaped). The page shows proposals only as `<img src>` and
  the server serves them with the sandboxing CSP and nosniff. Titles, whys and texts render as text.
- Review rounds and revisions: sending a round (`round_send`), closing (`revision_close`) and restoring
  (`revision_restore`) a revision are the page's acts only (the server passes `via: "page"` for its own Origin; no MCP
  tool; the agent surface and offline get 403). `revisions.json` is not a page save (403). A page save of `notes.json`
  keeps the server's `round`, a note's `round`, `absorbed_in` and `change` (a new note gets none). `round_absorb` checks
  the note is in the round in flight and its `change` (a known stage, a project-relative file without `..`, a version
  word, a summary). `/data/<p>/` never serves a dot-folder or dot-file (`.snapshots`, `.history`); the compare op reads
  snapshots for the page and names revisions only as `R<n>`, `R0` or `now`. The git mirror runs `git` with
  `--git-dir=data/<p>/.history/.git` (never the workbench repository) and only when the director turned it on.
- Stage 2 (script): a page save of `scenes.json` cannot rewrite a saved version nor the author of an existing note,
  status or intake answer; new versions, notes, replies, changed scene statuses and answers are stamped
  `by: "director", via: "page"`; a malformed file is refused (400). Only the page marks a scene `ok` (`scenes_update`
  refuses it; an agent's snapshot restore brings a lost `ok` back as `needs_you`). `sketch_save` takes ids
  `^[a-z0-9][a-z0-9_-]{0,63}$` only (no path can leave `sketches/`), real PNGs only (signature + IHDR, image and mask),
  and bodies up to 25 MB (every other request: 5 MB; over the limit: 413); it keeps the token / Origin / Host checks.
  A sketch drawn over a PRIVATE underlay is written under `private/sketches/` and flagged private in `media.json`
  (local only, never exported). Its `via` (page / agent) is provenance, not a permission.
- Stage 3 (breakdown): ids of items, scenes, beats and wardrobe owners are checked (`^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$`,
  400 otherwise); an agent cannot set an item `ok` or write an entity link; a page save of `breakdown.json` cannot
  rewrite a saved version, a note's author or an entity link, and changed statuses are stamped director / page;
  "Create entity" (`/api/op/breakdown_promote`) runs only for the page's own request (this server's Origin + the
  token), never for the MCP tools (no such tool) or offline; it spends nothing. An agent's restore brings a lost `ok`
  back as `review`.
- Stage 4 (characters): the director's acts (`POST /api/op/character_act`: the base, keep / branch / revert / make
  head, approve and unlock the identity or a look, new looks, notes from the page) and reference uploads
  (`/api/op/ref_upload`) run only for the page's own request (this server's Origin + the token); the MCP server has no
  such tools and the ops refuse anything else (403), offline too. `ref_upload` takes real images only (PNG / JPEG / WebP /
  GIF by signature; SVG, HTML and other files 400), up to 20 MB; a photo always goes to `private/refs/<character>/`
  (the name is reduced to letters, digits, `-` and `_`) and is flagged private. An agent adds a node only from a
  request the director approved in the page and that is `done` (`character_iteration_add`), never to an approved
  (locked) tree, and a look only after the identity is approved; a node made from a private photo is private and its
  image is copied under `private/characters/<id>/`; outputs of a request with private refs are flagged private.
  `entity_upsert` ignores `iter` / `base` and refuses to approve or lock a look (403); `look_create` makes looks in
  `review`. An agent's snapshot restore brings back no identity / look approval and keeps the nodes made since.
- Stage 5 (scenery): locations and props run on the same ops. `POST /api/op/asset_act` (`character_act` is it with
  `type: "character"`) adds the per-scene pick (`act: "use"`) and the variant acts (`variant_new`, `variant_status`),
  and is page only like `character_act` (this server's Origin + the token; 403 to the agent surface, a claimed
  `via`, a foreign Origin, no token, offline). `ref_upload` takes `type` and checks that the entity is of that type.
  An agent proposes variants with `variant_create` (always `review`; axis values are short words, scene ids are
  checked), registers nodes with `asset_iteration_add` (never before the base is approved for a variant, never into a
  locked tree), and cannot pick a scene's variant: `entity_upsert` ignores `iter`, `base` and `uses` and refuses to
  approve a variant (403). A request carries one link (`asset`; an old `char` is still read). An agent's snapshot restore brings back no
  variant approval that is not the current one (the variant back to `review`) and keeps the director's current picks.
- Stage 6 (storyboard): every `shots_update` is a new version; shot, scene, entity, variant, sketch, clip and beat ids are
  checked (400 otherwise; a sketch id can never leave `sketches/`, a `thumb` never `..`); a shot's approval is
  `approvals.json` `shot:<id>`: an agent may set draft / review / changes, `approved` and `locked` are refused (403, also
  with a claimed `director_approved` and offline; the director approves in the page). A page save of `storyboard.json`
  cannot rewrite a saved version or a note's author; new versions, notes and replies are stamped director / page; a
  malformed file is refused (400). Nothing in the stage generates or spends: requests are drafts the director approves.
- Entity thumbnails and copies made from private media stay private (`thumbs/priv_*`, `private/<kind>/`).
- The HyperFrames exporter runs a composition's script with every request outside its own package server blocked
  (and no workbench token), and keeps backslash references inside the composition folder.

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
`entity` (any element with `data-ent="<entity id>"`), `empty`, `global`, `columns`, `menubar:<Menu>`, and in the stage
workspaces `stage`, `scene`, `bditem`, `chnode`, `tladd` (the timeline: first on its sheet, its + Add), `lyline` (a lyric line: `lineId`), `lysec` (a section tag: `secId`),
`lystage`, `scgap` (a script gap: `gap`), `sbscene` (a storyboard scene or shot), `bdstage`, `noterow` (any row with a
Notes column: `ncCol`, `ncTarget`; `hasAdd` says the menu has its own "+ Add"). Elements with
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
