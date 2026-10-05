# Director Workbench

The one version string is `package.json` `version`; **Help › About** shows it with the git commit of this checkout.

A vertical, time-synced, multi-column view of a music video: time runs top to bottom, every column shares one
time axis `y(t)`, and that axis is warped so wrapped text (lyrics, script, notes, events) pushes the audio lanes down
with it. A given millisecond sits on the same pixel row in every column. No build step, no framework.

## Run

Node 20+; ffmpeg / ffprobe on PATH for importing songs and making thumbnails.

```
npm install                      # @modelcontextprotocol/sdk + zod; puppeteer-core for the tests
npm start                        # the helper: node bin/cli.mjs serve -> http://localhost:8140/   (node serve.mjs [port] still works)
```

**Without a clone (G7, the npm helper)**: `npx ai-videoclip-director` (not published yet: today `npm pack` in this folder and
`npx ./ai-videoclip-director-<version>.tgz`). The commands:

```
npx ai-videoclip-director [serve] [--data <dir>] [--port 8140] [--lan] [--no-open]   # the page server (the default)
npx ai-videoclip-director mcp [--data <dir>] [--port 8140]    # the MCP server for Claude Code; it also serves the page from the
                                                              # same process when no workbench answers on the port
npx ai-videoclip-director connect [--data <dir>]              # how to connect Claude Code (the claude mcp add line)
npx ai-videoclip-director pair [--origin https://…] [--read-only] | --list | --revoke <id>   # pairing (below)
```

The data folder: `--data`, else `WORKBENCH_DATA`, else `data/` in a clone, else `~/ai-videoclip-director` (an npx install lives in a
cache that can be wiped; your projects must not). A **first run** makes it with the template and the demo, prints the URL and the
Connect command, opens the browser once, and the page opens on the **onboarding**: the three ways to start (a song, lyrics only, the
demo), Connect Claude, where the data lives, and a check of this computer (ffmpeg, the fal key, Claude); English, Catalan or Spanish
(Settings › language later; Help › Welcome… shows it again). `<data>/workbench.config.json` is read when there is no other config.

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

**Or in the page, no path typing (G6)**: File > New project… → title → lyrics (paste, or drop / load a `.txt` / `.lrc` file) →
**drop the song** (mp3, wav, m4a, flac, ogg; or "choose the file"). Create uploads it in 4 MB chunks (a progress bar), then the
server reads it: the length (ffprobe / ffmpeg), the waveform peaks, the energy curve, **the beat grid estimated from the song**
when no BPM is typed (an onset autocorrelation over 60-200 BPM with the first downbeat; "no clear beat" falls back to 120), and
the lyric timings over the real length (LRC tags win). The wizard shows each step, then the result (length, BPM and where it
came from, lines) and opens the project on the lyrics stage. A path on this machine still works ("or a path on this machine").

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

**In the page: Help › Connect Claude…** (F9) shows these exact lines for this checkout, each with a **copy** button: the
`claude mcp add workbench -- node <this folder>/mcp/server.mjs` command (with `--env WORKBENCH_URL=…` when the server is not on
8140), **where the agent token is** (`<data folder>/.wb-agent-token`: the file path only; the token itself is never shown, copied
or exported, and the MCP server reads the file by itself), and the quick test `node <this folder>/mcp/client.mjs status`. Under them:
the server, the pages open and the last write an agent made (`GET /api/connect`, local only).

Or put the JSON form of `.mcp.json.example` in the project's `.mcp.json` (or `claude mcp add-json`). Then start the
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
on the server, or a short text) / `proposals_get` (the sets, the director's picks and mix notes, the "3 more" asks); `final_get` (stage 7, read only: the ready-to-render checklist, everything not approved yet by stage with its cost,
the costs against the cap, the lock); `takes_get` / `take_propose` (take selection: the takes of a shot or a request, and the agent's
proposed take with in / out and why; the pick is the director's, in the page); `surfaces_get` / `surface_propose` (the lyric gate, E2: every
lyric word on a surface or not, and the agent's proposal of where a line shows on screen during a shot; accepting is the director's, in the
page); `composition_export` (E9: the picks as `edl.json` for the
HyperFrames composition; writes only that file); `approvals_get` / `request_changes` (approving is the page's), `requests_list` /
proposed take with in / out and why; the pick is the director's, in the page); `check_add` / `checks_get` (D7 identity checks: the
agent's vision check of a node or take against the character's approved identity and constants checklist; a badge for the director, never an
approval or a pick); `approvals_get` / `approve` / `request_changes`, `requests_list` /
`request_create` / `request_update` (`recipe`: the photoreal prompt blocks; `warnings[]`), `costs_get` (one total over costs.json and
`media_add`, `notes_list` / `note_add` / `note_resolve`, `approvals_get` / `request_changes` (approving is the page's), `requests_list` /
`request_create` / `request_update` (`recipe`: the photoreal prompt blocks; `warnings[]`; `takes`), `request_run` (run approved requests: the runner; `batch` = one wave) / `generators_get`, `batches_get` / `waves_propose` (D4: waves of
shots with review gates, the take ratio; approving and reviewing a batch are the director's, in the page), `costs_get` (one total over costs.json and
a falgen ledger), `cost_record` (spend made outside the queue, never an approval), `media_update`, `media_scan` / `media_import`
(existing images and video under a media root: read a folder and its `job.json` jobs (prompt, model, refs, cost), register in
place; uploads and "Use as…" are the director's, in the page), `wait_for` (block
until a request / stage / note changes), `ui_focus`; the guided flow: `stages_get` / `stage_update` (the per-stage note tools below
are aliases that write the same notes.json v2 and answer in their old shapes),
`lyrics_get` / `lyrics_update` / `lyrics_versions` / `lyrics_note_add` / `lyrics_note_resolve`, `song_attach`; stage 2:
`intake_get` / `intake_answer`, `interpretation_set` (E10: the agent's reading of an intake answer or a note, shown under the
director's verbatim words and marked as the agent's; the director accepts or edits it in the page), `script_get` / `scenes_update`, `scene_note_add` / `scene_note_resolve`, `sketch_save` /
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
  Alt+Shift+1..7, palette "Go to stage: Lyrics", right-click on the rail) to open its workspace. **One stage bar** (F8,
  `core/stagebar.js`) tops every stage, with the same slots at the same place everywhere: the stage, its status, **Mark
  done** (Reopen once done), **Needs you**, the stage's primary act (**Save version**; Characters / Scenery **Send edit
  request**; Final **Lock for render…**), **Ask the agent…**, **Send round N (k)** (the review round, as on the rail; then
  "Round N: Claude working", then "Close revision R<n>"), what blocks it, List | Time, and ‹ previous / next › stage.
  **Only the director marks a stage done** (here or on the rail; agents can set in progress / needs you and
  blockers). Later stages can be opened early. A project made before the flow counts stages with content as done.
- **List | Time** (ROADMAP_v4 F6, a provisional decision: List stays the default): the stage bar of Lyrics, Script,
  Breakdown, Storyboard and Final has a **List | Time** toggle (also **Alt+T**, View menu, right-click on the stage),
  remembered per stage. In **Time** the rows sit on the **timeline's own warped axis** (`core/timemode.js` reads
  `WB.timeline.warp`: the same anchors and measured row heights), so a lyric line, a scene or a shot is at the same y as
  on the timeline for the same ms, and the view scrolls with the timeline's playhead (the orange line) and shares its
  reading position. Lyrics: a line per row (section tags a band on the left); Script: each scene / gap a row, its lyric
  lines and beats at their own times; Storyboard: the scene a band, its shots stacked down it at their times (frame |
  text); Breakdown: the matrix on its side, a scene per row (ordered and sized by time) x an item per column; Final: the
  rows grouped by song section in time order. A row holds what fits its time slot (an orange underline = more; hover
  shows it whole); the Notes column stays row-aligned, which here means time-aligned (its cells keep the slot's height).
  A click on an empty spot seeks; right-click > **+ Add at m:ss** adds a note on the row at that time, a scene or a shot.
  Rows off screen are skipped by the browser (`content-visibility: auto`): placing the owner's 4:28 song (101 lines,
  52 shots) takes under 10 ms. The timeline stays laid out behind the other pages (hidden, not removed), so its warp
  is always the real one.
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
  answered here or in a chat; "asked in chat" marks; **Ask for a draft**; under an answer, the agent's **interpretation**
  (E10) in its own style, "agent's reading · not reviewed", with **Accept** / **Edit**: the answer itself stays verbatim; an edited
  reading is yours and the agent cannot overwrite it; the same block sits under a note in every Notes column), **Versions** (A/B side-by-side diff with the
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
- **Takes** (D6 take selection; `tabs/takes.js`, logic `js/takes.js` shared with `takes_get`): the Shot panel's **takes**
  section (and Review › **Takes**, per request or shot) shows every take of the shot as a compact card: the runner's outputs of
  its requests (`gen/<request>/<request>_<take>.<ext>`) and any registered media linked to the shot, its clip uses or its
  requests (imports too). Hover a card to scrub its video, click to open it in the editor, ⤢ for full size, Shift+click to
  mark it B. The editor: the video, a mini strip of the take with **in / out** handles (drag; snapped to the take's frames;
  the video follows; ⇤in / out⇥ take the video's time), a readout (length, frames, how it fits the shot), a note, **Pick
  take** (saved on the storyboard shot as `clip{request, take, file, in_ms, out_ms, note, alt[]}` through a new version;
  approval stays separate), **+ alt** (this take as an alternative for a song time: "bigger smile, alt for 2:19.84"),
  **A/B** (the dock plays A and B side by side in lockstep over their ranges), unpick. The agent's proposals (◆, from
  `take_propose`) sit above the editor with a one-click **Pick**. The timeline **clips** column shows the pick (★ take,
  in–out) over its shot, and Final's checklist counts the shots with a picked take.
- **The lyric gate** (E2; `js/surfaces.js`, `tabs/surfaces.js`): "every sung or spoken word appears on a desktop surface at its
  time". The Shot panel's **lyrics on screen** section lists the lyric lines sung during the shot, each word red while it is on no
  surface; click a word (Shift+click a second one for a range), pick where it shows (window title, chat, dialog, karaoke, taskbar,
  other) and a detail, **+ surface**; × takes one off. The agent's proposals (`surface_propose`) sit there with **Accept** / ×. Each
  change is a new storyboard version (`shot.lyrics[{line, w?, where}]`; page only). The timeline's **surface** column shows every
  line's words (uncovered in red), the Lyrics stage a `covered/n` count per line (click: the shot), the storyboard's side panel
  (no shot selected) the uncovered runs, and Final's checklist the line **every word on a surface**.
- **Help** (F5, `core/helptip.js`): empty states and the storyboard's side panel are one line plus a **?** that opens the longer
  explanation; a short poem spreads over the Lyrics stage's height, an empty breakdown shows the scenes it will read.
- **Export composition data…** (File menu; E9, `core/compexport.js`): the picks as one JSON file for the HyperFrames
  composition, `data/<project>/exports/composition/edl.json` (versioned, deterministic, with a checksum): per shot the picked
  take (its file mapped under the composition's assets: one rule a line, `from => to`), in / out, the look per character,
  placeholders for unpicked or private shots, and the song's timing anchors. The dialog shows how many shots are picked and
  remembers the map. The composition reads it with `exporters/composition-data/reader.js`; see docs/COMPOSITION_ROUNDTRIP.md.
- **Constants and identity checks** (D2 / D7; `js/checks.js`, `lib/ops/checks.mjs`, `core/checkbadge.js`): the Characters
  stage's Identity tab has a compact **Constants** list: the details that must stay identical in every image ("orange starburst
  clip above the LEFT ear", "cyan jaw seam"), one row each with a tick (on the identity checklist), a short name for the badge
  ("clip side") and the text; **Seed from base** proposes rows from the base description, **Save constants** saves them (they go
  into the identity lock of every photoreal prompt). The switch **ask for an identity check when an output lands** (off by
  default; `settings.json identity_checks`) makes the server write ONE note for the agent each time outputs land (the runner's
  done, an import, a node added): the outputs, the approved identity to compare with and the checklist. The agent looks and writes
  `check_add` (verdict ok / drift / fail, one item per constant). Each node and take card then carries a badge (**identity ok**,
  **drift**, **✗ clip side**); hover it for the items, the note and earlier checks. The director still decides: a check never
  approves, rejects or picks anything. An optional local face-embedding score could fill `score` (`tools/face-score.md`; not built).
- **Final stage** (stage 7, final approvals; `tabs/final.js`, logic `js/final.js` shared with `final_get`): ONE compact
  table of everything not approved yet, grouped by stage: the lyrics stage not done, scenes not ok, breakdown items not
  ok, identity / base trees and looks / variants not approved, shots and clip takes (approvals.json) not approved, draft
  requests. Each row: thumbnail (or the kind's letter), time, what, status, why it waits, cost (estimated / spent),
  **✓ Approve**, **✎ Request changes** (type what to change, Enter: a note on the row, and the state goes to changes /
  draft where it has one), **↗** jump to where it lives; the Notes column on the right shows every stage's notes on the
  row. Filters: stage, status, "has open notes". Tick rows (or a whole group) and **Approve selected**: a confirm shows
  the count and what it commits (requests: committed and left before → after, against the cap). Above the list:
  **Ready to render**, eight lines derived from the files, never stored (every second scripted, every scene has
  shots, every shot an approved frame / take / clip, every asset approved, no open notes, no open round, costs within
  the cap, an export is possible: the song + media for every shot, none private only), each failing line with its
  gaps as links; **Costs**: spent (the merged ledger), committed and estimated remaining (drafts + shots not requested
  yet) against the cap, by source. **Lock for render** (a confirm; "Lock anyway" names the failing checks) closes a
  revision (the final snapshot), marks it `final` and locks the project: a blue banner, and every agent write gets 409
  until **Unlock**. Every act uses the page's own paths (page saves stamped `via: "page"`, `asset_act`, the stage
  rail's Mark done, `final_lock` / `final_unlock`). Review › Approvals shows the same rows (without the panels and the
  Notes column) above the raw approvals.json states.
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
  visible bin (Media keeps only its own status filter, F4); the character page opens inside it) · **3 Review** (Approvals, Queue = generation requests, Notes,
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
  Shift+H show all · Alt+H header full/thin/hidden · Ctrl+0 fit song (a song shorter than the window always fills its height, F7) · Ctrl+1 100 % · T (or 0) linear time · F follow ·
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
| surface | text, follow | on | the lyric gate (E2): per lyric line its words, read normally when they show on a surface (a storyboard shot's `lyrics[]` at the word's time), **red** when on none; `covered/n` per line; hover = shot · where; double-click = the shot in the storyboard |
| lyrics | text, drive | on | one row per **visual line**; each visual line is a warp knot at its first word's onset; karaoke word highlight; dotted = low-confidence word; left stripe = voice (male/female/both/system) |
| events | text, follow | on | the named sync points (`events.json`, E1; `js/eventscol.js`): kind icon, name, ⚓n = boundaries anchored to it; an agent's proposed event dashed with ✓ (accept); a measured one shows "→ m:ss.mmm" and a ghost row at the measured time. Drag an event = set where it really landed (measured); double-click = edit, an empty spot = "+ Named event here"; right-click = its menu |
| wave | lane | on | mix waveform, faint downbeat lines (they spread apart where text is dense) |
| stems | lane | hidden | vocals, backing, bass, drums |
| energy | lane | on | RMS (24 fps) + amber target overload ladder 0-10 per section |
| script | text, drive | on | W/S/B + action per lyric line (TREATMENT §2), approval dot |
| scenes | text, follow | on | stage 2 (`scenes.json`): each scene (title, text, sketch count, status colour; stage 3: its characters and locations from `breakdown.json`, + the count of other items) on the left, its beats on the right, each at its own time; double-click = open it in the script stage |
| shots | text, follow | on | stage 6 (`storyboard.json`, else `shots.json`): each storyboard shot, its frame sketch (else the render frame), kind, status dot |
| clips | text, follow | on | world-clip uses (clip.take +in-point), frame at the in-point, location colour; overlaps share width; a storyboard shot's picked take (★ take, in–out, alternatives count) over the shot, replacing the uses it lists |
| cast | text, follow | on | cast chips + location letters per storyboard shot |
| status | text, follow | on | approval chips for the shot and each clip use inside it |
| cost | text, drive | hidden | $ per generation job at its first use, running Σ / cap |
| notes | text, drive | on | every note with a time (notes.json v2): the timeline's, and the stages' on a line, scene, beat or shot (tagged); a click on an empty spot types a note at that ms |

### Named sync points and the re-time after the take (E1)

The cuts of a music video land on **named events** (`her_hi_there`, `duet_5_both`, a Stop, a spoken line), not only on
beats and lines. `events.json` holds them; the timeline's **events** column shows them.

- **Make them**: right-click on the timeline › + Add › **+ Named event here** (or in a stage's Time view), right-click a
  lyric word › **+ Named event at “word”** (its time, the word as the name), Timeline › **Import events (audio
  events.json)…** (the first film's `audio/out/final/events.json`: times in seconds; sections skipped, ids kept). An
  agent's `event_add` is *proposed* (dashed, ✓ accepts it); only accepted events are snap targets.
- **Snap and anchor**: the script and storyboard **snap** menus offer **events** (the nearest named event within 1 s;
  the boundary is also anchored to it); the scene card and the shot panel have a **⚓ anchor…** select per boundary. An
  anchored boundary stores `anchors {t0?, t1?: event id}`, not just a time.
- **Measure**: after the song take is chosen, drag an event in the events column to where it really landed, or type it
  / "= playhead" in its dialog (`measured`). Its time stays until the re-time (an anchored event's time is locked).
- **Re-time after the take…** (Timeline menu, the palette): the measured events and the agent's proposed re-times
  (`retime_propose`), the **preview** (every anchored boundary and every cut that sits on one, old → new; problems
  refuse it), and **Apply**: ONE undoable change = a new `scenes.json` version and a new `storyboard.json` version
  (picks kept), the events at their new times. Ctrl+Z = `retime_undo` (new versions with the old times; the events
  pending again); Ctrl+Shift+Z re-applies.
- Accepting, measuring, importing and applying / undoing are the director's (page only: `events_act`, `retime_apply`,
  `retime_undo`); an agent reads (`events_get`), proposes events (`event_add`) and re-times (`retime_propose`).

## Files (`data/<project>/`)

All times are **integer milliseconds**. Pixels are never stored. Media paths under one of the configured `media_roots`
are relative to `media_base` and served read-only at `/media/<path>`; other paths are relative to the project folder
(the demo keeps its files in `media/`, `audio/`, `render/`).

| file | shape |
|---|---|
| `song.json` | `{duration_ms, bpm, beat_ms, bar_ms, grid:{beats[], downbeats[]}, audio:{mix, render, stems[{id,label,audio,peaks}]}, sections[{id,label,t0,t1,energy,world_pct,overload:[lo,hi],transitions}], lines[{id:"verse1/3", section, t0, t1, text, voice, kind, words[{w,t0,t1,p}]}]}`; E7 adds `versions[{id: "v2", label, source: suno/upload/import/other, audio, duration_ms, bpm, style?, exclude?, lyrics_prompt?, lines[{id,t0,t1}], alignment{method: lrc/lines/offset/stretch}, by, via, at}]` and `current_version` (the takes of the song; using one is the page's: Lyrics › versions…) |
| `events.json` | v2 (E1, the server's: written by the ops, never a page save): `{v: 2, rev, events[{id "her_hi_there", name, t, kind: stop/spoken/voice/cue/custom/section, note, status: accepted/proposed/dismissed, measured?, by, via, at, source_kind?, retimed?[{from, to, at, retime}]}], retimes[{id "rt03", status: proposed/applied/undone/dismissed, moves[{event, from, to}], why, by, via, at, applied_at?, versions?{scenes: [from, to], storyboard: [from, to]}, rows[]}]}`. An importer's old array `[{id, t, kind, note}]` reads as v2 (every event accepted; `drop` / `beat` / `count` -> cue, `silence` -> stop, `line` / `word` -> voice, the original in `source_kind`). Scenes (`scenes.json`) and storyboard shots carry `anchors?{t0?, t1?: event id}`: that boundary follows the event. Logic: `js/events.js` |
| `energy.json` | `{fps, rms[], onset[]}` (0-1) |
| `script.json` | `{stages[{name,t0,t1,text}], lines[{id:"s07", t0, t_end?, lyric, mode:"W"|"S"|"B"|"W→S", action, line_id}]}` |
| `shots.json` | `{shots[{id, t0, t1, section, kind, title, cast[], locations[], clips[use ids], thumb, render_frame_ms}], uses[{id:"G05@20158", clip, take, in_ms, t0, t1, file, start_image, location, thumb, label}]}` |
| `entities/{characters,locations,props}/<id>.json` | `{id, kind, name, role|description, refs[paths], thumb, status, private_refs?, breakdown?{item, scenes}, ...}`; `entities/index.json` lists them. A character also carries `looks[{id, name, garments[], colors[], images[], notes, status: draft/review/approved, from?: breakdown/agent/page, breakdown?}]` and stage 4: `base{text, refs[{path, source: catalog/openverse/photo/sketch/media, private?, title?, licence?, licence_url?, creator?, url?, original?, attribution?, catalog_id?, openverse_id?}], at, by, via}` and `iter{nodes[{id: "n03", tree: "identity" \| "look:<id>", parent, from_identity?, image, request, kind: identity/edit/look, edit{text, sketch?, png?, mask?, pins[{n, x, y, text}]}, choice: null/kept/branch/reverted, private?, at, by, via, note?}], trees{<tree>: {head, approved?, approved_at?, approved_by?, via?}}, notes[{id: "cn01", tree?, node?, text, by, via, to?, status, at, replies[]}], log[{at, by, via, act, tree?, node?, detail?}]}`: append-only (a node never changes except the director's `choice`; every act is logged); `identity_sheet` = the approved identity image. Catalogue paths (`catalog/...`) are relative to the workbench folder. Locations and props (stage 5) carry the same `base` and `iter` (trees `"base"` and `"variant:<id>"`, node kinds base/edit/variant, notes `"an01"`) and `variants[{id, name, axes{angle?, tod?, weather?} (location) \| {angle?, state?} (prop), notes, images[], status: draft/review/approved, from?: page/agent, scenes?[] (the agent's proposal), breakdown?}]`; `sheet` = the approved base image. Every asset may carry `uses{<scene id>: {variant: <variant / look id> \| null (the base / identity), by, via: "page", at, note?}}`: the variant each scene needs (the director's pick; without one, the variant the agent proposed for that scene, else the base). Logic: `js/assets.js` (shared), `js/characters.js` (the stage-4 names) |
| `notes.json` | v2, ONE list for every stage and the timeline: `{v: 2, rev, round, notes[{id, target{stage: lyrics/script/breakdown/characters/scenery/storyboard/final/timeline, kind, id, w?, quote?, t?, pin?{x, y}, line?, scene?}, text, by, via: page/agent/import, status: open/absorbed/dismissed, round, replies[{id, text, by, via, at}], interpretation? (E10: the agent's reading, see Security), absorbed_in, created, to?: "agent", ask?: request/fill_gaps/extract/storyboard, gaps?, version?, marker?, about?, legacy?{store, id}}], legacy_seen[]}`. Kinds per stage: lyrics stage/section/line (+ `w`, `quote`); script stage/scene/beat (`"sc02/b1"`); breakdown stage/item/scene; characters / scenery stage/asset/tree (`"ada/look:x"`)/node (`"ada/n03"`, + `pin`)/use (`"ada/sc02"`); storyboard stage/scene/shot; final stage/shot; timeline time (`t` ms). Shapes and logic: `js/notes.js`. **Migration**: on its first read the server (or the page, on a static host) reads the old stores into it without loss: notes.json v1 `{rev, notes[{id, t, line_id, by, text, status, at, about?, reply_to?}]}` (kept as `notes.v1.json`; a `reply_to` note becomes a reply), and the `notes` of `lyrics.json`, `scenes.json`, `breakdown.json`, `storyboard.json` and each entity's `iter.notes`; those files are never written for notes again (a note added to one later is imported once; `legacy_seen` keeps a deleted one from coming back) |
| `approvals.json` | `{rev, states[], items:{"<kind>:<id>": {state, by, at, why?, comment?}}}`; kinds: `shot`, `use`, `job`, `script`, `character`, `location`, `prop` |
| `costs.json` | `{cap_usd, fal_total_usd, items[{id, t, usd, tool, date, request?, via?, job?, take?, note?}], pre_production[], ledger[]}`; `project.json` `falgen` (a folder inside the media base, read only) adds its spent.json / LEDGER.md rows to `costs_get` (deduplicated by job) |
| `peaks/<id>.json` | `{bin_ms:5, n, scale, min, max}`: min/max per 5 ms bin, int8 (value/127*scale), base64; ~140 KB each |
| `thumbs/*.jpg` | small frames: `shot_<id>` (render), `use_<clip>_<take>_<in_ms>` (clip at the in-point), `ent_<id>` |
| `_src/edl.json` | raw `WORLD.clip` calls from the render page (input to the importer) |
| `media.json` | `{generated, count, by_kind, items[{id, path, kind, label, entities[], shots[], uses[], take, job, group, size, w, h, duration_ms, private, status: used/picked/unused/private, cost_usd, thumb, strip?, strip_n?, packed_alpha?, request?, imported?{by, via, at, from: in place / upload, name?}, use_as?[{shot, as: take / start_frame} / {entity, tree, node, as: identity / look / base / variant}, by, via, at]}]}`; kinds: render, clip, still, avatar, body, motion, dancer, motion-ref, sheet, variation, contact, audio, ref |
| `thumbs/m_*.jpg`, `s_*.jpg`, `priv_*.jpg` | media thumbnails (max 240 px, sheets 600 px), 8-frame hover-scrub strips of videos, thumbnails of PRIVATE files |
| `_src/probe.json` | ffprobe cache (size/mtime keyed) |
| `requests.json` | `{rev, items[{id, kind, target, prompt, refs[], est_cost, tool?, status: draft/approved/queued/running/done/failed/rejected/withdrawn, by, at, takes?, superseded_by?, history?{source, book, job, dir, files, registered, cost}, outputs?[], generator?, linked?{type, id, tree, nodes[], proposals[]}, handoff?{generator, pack, results}, last_run?{at, status, why}, asset?{type: character/location/prop, id, tree, from, kind: identity/base/edit/look/variant, text?, sketch?, png?, mask?, pins[]}, warnings?[], recipe?{id, version, model, framing, fields, blocks[]}}]}`; kinds: regenerate, new-costume, new-variant, generate, duplicate, choose-take, set-in, edit-timing, swap-costume, section-variant, import, identity-sheet, character-edit, look-sheet, location-plate, location-edit, location-variant, prop-sheet, prop-edit, prop-variant. `asset` links a stage-4 / 5 generation to the asset tree it grows; older requests may carry it as `char` (still read; `request_create` accepts `char` with a deprecation warning and stores `asset` only). `batches[{id, name, wave, request_ids[], shots[], gate{after, rule: "review"}, status: draft/approved/reviewed, max_usd?, verdicts{<request>: {verdict: rejected/kept}}, approved_at?, reviewed_at?, stats?}]` (D4 waves; the server's: a page save keeps its copy) |
| `refs/<id>/`, `private/refs/<id>/`, `private/{characters,locations,props}/<id>/` | stage-4 / 5 references: Openverse images (public, provenance in `media.json` `provenance{}`), the director's reference photos (always private), and iteration images made from private photos (private) |
| `overrides.json` | `{rev, sections:{<id>:{label?, color?}}}`: the director's section renames / colours over `song.json` |
| `settings.json` | `{rev, keybindings:{<command id>:[keys]}, identity_checks?: true}` (not snapshotted; `identity_checks`: the Characters stage's "ask for an identity check when an output lands") |
| `project.json` | `{title, created, from?}` |
| `stages.json` | `{rev, stages[{id: lyrics/script/breakdown/characters/scenery/storyboard/final, status: empty/in_progress/needs_you/done, done_by?, via?, updated?, updated_by?, blockers[], note?}]}`: the guided flow (shared with the page; only the page sets `done`, stamped `done_by: "director", via: "page"`); missing = derived (content = in progress, never done); `stages_get` adds `shown` / `content` / `changed`, computed from the files (js/flow.js `stagesView`) |
| `lyrics.json` | `{rev, current: "v3", seq, versions[{id, n, created, by, via, message, from?, sections[{id, label, lines[{id, text, t?}]}]}], notes[{id, line, w: [first, last word] \| null, quote, text, by, via, to?: "agent", kind?, status, at, version, replies[{id, text, by, via, at}]}]}`: stage 1. Versions are immutable (a save appends one and moves `current`; the server keeps its copy of every saved version); line ids are stable across versions and are the `song.json` line ids (a missing file reads as v1 derived from `song.json`). The server re-syncs `song.json` lines on every new current version |
| `scenes.json` | `{rev, current, versions[{id, n, created, by, via, message, from?, scenes[{id: "sc03", t0, t1, title, text, line_ids[], beats[{id: "b1", t, text}], sketches[ids]}]}], states{<scene>: {status: draft/needs_you/ok, by, via, at}}, notes[{id: "sn01", scene \| null, beat?, text, by, via, to?: "agent", kind?: request/fill_gaps, gaps?, status, at, version, replies[]}], intake{<question>: {text, by, via, at, asked?, interpretation?}}}`: stage 2, the script draft (shared with the page). Versions are immutable (a save appends; restore copies); statuses and intake answers live outside them; only the page sets a scene `ok`. A missing file reads as v1 derived from `script.json` (`stages` -> scenes, `lines` -> beats), which is never rewritten. Shapes and logic: `js/scenes.js` |
| `breakdown.json` | `{rev, current, versions[{id, n, created, by, via, message, from?, script?, items[{id: "bi03", kind: character/location/prop/wardrobe/fx, name, description, links[{scene, beats[], note?}], source: agent/director, aliases?, for? (wardrobe: the character item), dropped?}]}], states{<item>: {status: draft/review/ok, entity_id?, look_id?, by, via, at}}, notes[{id: "bn01", item \| null, scene?, text, by, via, to?: "agent", kind?: request/extract, status, at, version, replies[]}]}`: stage 3, the breakdown (shared with the page). Versions are immutable (a save appends; restore copies); statuses and entity links live outside them; only the page sets an item `ok` or links it to an entity ("Create entity": a draft entity in `entities/`, or a look on a character). Links name scene / beat ids of `scenes.json`. Shapes and logic: `js/breakdown.js` |
| `storyboard.json` | `{rev, current, versions[{id, n, created, by, via, message, from?, script?, shots[{id: "sh03", scene, t0, t1, kind: wide/medium/close/insert/performance/xp-desktop/…, title, text, camera, sketch, beats[], cast[], locations[], props[], variants{<entity>: <variant / look> \| null}, gen: still/video/null, clips[], thumb?, section?, clip?, lyrics?[{line, w?, where}] (the lyric gate, E2: page only)}]}], notes[{id: "sbn01", shot, scene?, text, by, via, to?: "agent", kind?: request/storyboard/fill_gaps, gaps?, status, at, version, replies[]}]}`: stage 6, the storyboard. A version is immutable (a save appends one); the shots of a scene tile it; the variant each asset needs is the scene's (entity `uses`) unless `variants` overrides it. The shot's approval is `approvals.json` `shot:<id>`. Missing = v1 derived from `shots.json` (never rewritten; its readers keep working). Logic: `js/storyboard.js` |
| `takes.json` | the agent's take proposals (the server's; the page reads it): `{v: 1, rev, proposals[{id: "tp03", shot, request, job, take, file, media, kind, in_ms, out_ms, why, by, via: "agent", at, status: open/picked/dismissed}]}`. The pick itself is the storyboard shot's `clip{request, take, file, media, kind, in_ms, out_ms, note, alt[{take, file?, t, note}], by, via: "page", at, proposal?}` (written only by the page's `take_act`, carried forward by every other save) |
| `surfaces.json` | the agent's lyric-surface proposals (E2; the server's, the page reads it): `{v: 1, rev, proposals[{id: "sp03", shot, line, w?, where, why, by, via: "agent", at, status: open/accepted/dismissed, decided_at?, decided_by?}]}`; an accepted surface lives on the storyboard shot as `lyrics[{line, w?: [first, last word], where: "<kind>[: detail]"}]` (kind window / chat / dialog / karaoke / taskbar / other; written by `surface_act`, page only) |
| `renders.json` | E4 / E8 (the server's; the page reads it): `{v: 1, rev, config (the director's render command: argv with {placeholders}, cwd, warm-up, RAM floor, workers, size; set in the page only) \| null, sheets[{id, kind: contact/seams, from: render/request/storyboard, source, file, frames[{t, label, shot?}], revision, asks[], reviews[{verdict: ok/issues/fail, items[], note, via: "agent"}]}]}`; a render job is a request of kind `render` (`render {scope, t0, t1, chapter?}`, `render_run {phase, ram, log, out, sheets, revision}`), its files in `renders/<id>/` (MP4, `-sheet.jpg`, `-seams.jpg`, `render.log`); other sheets in `sheets/` |
| `checks.json` | identity checks (D7; the server's, the page reads it): `{v: 1, rev, checks[{id: "ck03", target{kind: node/take/media, id: "ada/n05" \| "<shot>/<media>" \| "<media>"}, against{entity, node, image}, by, via: "agent", verdict: ok/drift/fail, items[{constant, ok, note?}], note, score?{model, value, threshold?, metric?}, created}], asks[{note, entity, against, files[{file, media?, node?, request?, target, source}], source, at}]}`. A character's `constants[]` are strings or `{text, check, label?}` (D2). Never an approval or a pick. Logic: `js/checks.js` |
| `sketches/<id>.json` / `.png` / `.mask.png` | a sketch: `{id, w, h, paper, underlay{src, opacity, fit}, strokes[], mask[], pins[{n, x, y, text}], title?, created, updated, by, via}` (format: `core/sketch/sketch.js`), the flattened image and the edit mask; written by `sketch_save`, registered in `media.json` (`kind: "sketch"`, `sketch`, `mask`, `scenes[]`, `pins`); under `private/sketches/` when drawn over a private image; not snapshotted |
| `.snapshots/<yyyymmdd-hhmmss>-<slug>/` | copies of the small JSON files (no peaks, thumbs, `_src`, settings, revisions.json) + `.meta.json {id, at, message, auto, files, revision?, immutable?}` |
| `revisions.json` | the review rounds and revisions (written by the server only; the page reads it): `{v: 1, rev, rounds[{n, status: sent/finished/closed, sent_at, sent_by, notes[ids], ask (the note to the agent), base (the snapshot when sent), finished_at?, summary?, closed_at?, revision?}], revisions[{id: "R3", n, round, created, summary, notes_absorbed[], notes_replied[], files_changed[], cost_usd, cost_delta, snapshot, base, by, via, git?: {commit} \| {skipped}}], restores[{at, revision, previous}], lock?: {at, revision, snapshot, summary, by, via, ready, failing?, pending} \| null, locks[]}`. A revision's snapshot is never changed; restoring one snapshots the current state first and keeps notes.json. "Lock for render" (stage 7) closes a revision with `final: true` and sets `lock` (the history in `locks[]`, `unlocked_at` when the director unlocks); while `lock` is set every agent write is refused (409). Logic: `js/revisions.js`, `lib/ops/rounds.mjs`, `lib/ops/final.mjs` |
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
- **A shell**: `node tools/run.mjs --project <p> <ids…> | --all | --batch <id> [--dry-run] [--parallel 2] [--video-parallel 1] [--retake] [--max-usd 2]` (a cap for the batch: `request_run max_usd`).

What a run does: only a request with the director's approval on record runs (a draft, rejected or done one is
refused; the runner never approves); the cap is re-checked when it is claimed (`queued`, 402 over it) and the
generator's estimate (`js/prices.js`) may not exceed the approved `est_cost`; `queued -> running -> done` (or `failed`
with `why`; a failed request keeps its approval and can be run again); the cap is checked again before every take is
submitted. Up to 2 image requests at once; video requests in their own lane, 1 at a time (`video_parallel`). Outputs go to
`data/<p>/gen/<request>/<id>_<take>.png` (`private/gen/…` when a ref is private) with `job.json` (the provider's job
ids, per-take status and cost; never the key); a take whose file exists is skipped and a submitted job is polled again,
not paid twice. At done the actual cost (list price × completed takes) is recorded once in `costs.json` (item id = the
request, `via: "runner"`; `costs_get` and `cost_record` dedupe by it), the outputs are registered as media (linked to
the shot for a `shot:` target) and, for an asset request, added to its tree as nodes the director keeps or picks
(`asset_iteration_add`; a tree that refuses gets a `node_import_propose` proposal); the request records `linked`.

**Video** (D3b; `js/video.js`). In the Queue's **+ New request**, pick a video model (MiniMax H3 Max, Kling v3 Pro,
Kling v3 Motion Control) and the form becomes a video request: a **motion-only prompt** (what moves and one camera move,
not what the frame already shows; "Apply photoreal recipe" gives the motion / camera / ambient / medium blocks), a
**duration** selector with the cost of each length (per second × takes, at today's price: the H3 promo $0.048/s ends on
2026-10-15, then $0.08/s), the **start frame** and the optional **end frame** picked from the approved nodes and the
registered images (make the end frame by editing the start frame: same light, lens, place, wardrobe), and for motion
control a **reference video** from the registered clips (its length sets the seconds; 3-30 s, one person, no cuts). The
request stores `video {model, start, end?, ref_video?, seconds, orientation?}`; `refs` = [start, end, reference video]
(what the run uploads to fal storage), `tool` = the endpoint, `est_cost` = $/s × seconds × takes. An agent passes the same
`video` to `request_create` (and `request_update video {...}`: an edit sends an approved request back to draft). A run
sends falgen's payloads (H3: `image_url`, integer `duration`, `768P`, `end_image_url`; Kling: `start_image_url`,
`duration` "5", `generate_audio: false`, a negative prompt, `end_image_url`; motion control: `image_url`, `video_url`,
`character_orientation`), waits up to 25 min per take, saves `gen/<id>/<id>_<take>.mp4` and probes it (fps, duration in
`job.json` and `media.json`); with a `shot:` target the outputs are that shot's takes in take selection (D6). A
reference clip longer than the approved seconds is refused (fal bills the output length).

**Waves, pilot gates and job books** (D4; `js/batches.js`, `lib/ops/batches.mjs`, `tabs/waves.js`). Paid generation goes in
waves (TREATMENT: "a pilot … to measure the take ratio … the rest only after that"; research: "waves with review gates (2, 4, 8, 10
shots)"). **Plan waves…** in the Queue (or the agent's `waves_propose`) splits the storyboard gaps into a pilot (the shots you tick,
else the first ones), then waves of 2 → 4 → 8 → the rest, with the takes per shot and the cap; **Create waves** writes draft requests
and draft batches (`requests.json` `batches[]`), each gated on the one before. In the Queue each batch is a collapsible group with its
gate (**locked** / **ready** / **running** / **review** / **done**), its totals and its cap: **Approve batch · $X** approves the whole
batch after a confirm that shows the total and the cap impact; **Run batch** runs it within its cap (`max_usd`); once every request
ran, pick a take of each shot (Storyboard › Shot › Takes, Review › Takes) or **Reject takes**, then **Mark reviewed**: the next batch
unlocks. A locked batch never runs. After a wave the Queue shows the take ratio (takes per used shot, cost per used second) and
re-estimates the remaining waves from it (their seconds x the cost per used second, next to the list price). **Import job books**
reads the first film's falgen `jobs_*.json` (the falgen folder linked in Settings › costs / `project.json`) as history requests: done,
linked to their outputs that are registered media, never run again, nothing added to the ledger (each job's money shows where the
merged ledger has it). Approving, reviewing and the import are the director's (page only: `batch_act`, `jobbooks_import`).

**A failed take inside a done request** (D3c): the request is done with the takes that finished (`takes_failed` lists
the others; nothing is paid for them). **Retry take N · $x** in the Queue (`request_run {ids, retake: true}`, `--retake`)
runs only those takes again, never the done ones, within the approved `est_cost` and the cap; the request stays done, its
outputs grow, and each retaken take's cost is recorded once (`costs.json` item `<request>#<take>`). **Stale locks**: a
`gen/<id>/.lock` whose runner is gone (its process dead, or no heartbeat for 10 min) is removed when the next run is
planned (`stale_locks_removed`).

**Generators** (Settings › Generator, per kind: image / video / motion; `settings.json` `generators`; tool
`generators_get`): `fal` (default: Nano Banana 2 edit / text-to-image and Seedream 5 edit through fal's queue API, refs
uploaded to fal storage (a public URL: a private ref only with the request's "allow uploading private refs" tick in the
Queue), 25 min timeout; video: H3 Max / Kling v3 Pro image-to-video and Kling Motion Control, per second, above),
`openwith` ("Open in another app": exports
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
`GET /api/projects` · `POST /api/projects/new {id, title?, lyrics?, song?, bpm?}` (with `lyrics` / `song`: the wizard's guided project; with `song_upload` + `song_name`: G6, a song the page staged with `project_upload`, page only) · `POST /api/projects/duplicate {from, to, reset_state?}` ·
`POST /api/projects/delete {id}` (the default project is refused) · `GET /api/snapshots` · `POST /api/snapshot {message}` ·
`POST /api/restore {snapshot}` (auto-snapshots first, copies the snapshot's JSON back, removes files it did not have; costs and requests that ran since are kept) ·
`POST /api/reveal {path}` (Explorer at a media file). Writes are temp file + rename with retries (Windows locks);
small files are served in one read so no handle stays open.

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
  private refs", and the ops `take_act`, `media_use`, `media_upload`, `batch_act`, `jobbooks_import`, `asset_act` /
  `character_act` (base / import accept, approvals, constants), `ref_upload`, `breakdown_promote`, `round_send`,
  `revision_close`, `revision_restore`, `final_lock` / `final_unlock`, `proposal_act`, `events_act`, `project_upload` (G5 / G6), `retime_apply` /
  `retime_undo`. An agent gets 403 on each
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
  `connect-src 'self' https://api.openverse.org` (the stage-4 Openverse search; every other origin is blocked); every
  other file gets a sandboxing CSP and `nosniff`, so an HTML/SVG file in a project cannot run script in the workbench
  origin. An invalid `?project=` is redirected to the default project.
- A remote (LAN) client reads the project's JSON files scrubbed: no private path and no item flagged private (so
  `media.json`, a character's base and iteration nodes, requests built on private photos list nothing private).
- Paths with `..`, `.`, backslashes, NUL, `:` (NTFS streams) or `~<digit>` (8.3 short names) are rejected; dot-folders are never served; private files (by rule or
  `private: true` in `media.json`) live under `private/<kind>/` and are never exported or packaged.
- The request runner runs only requests with a recorded director approval, re-checks the cap, records each cost
  once, and keeps the fal key out of every response, file and log (README "Running approved requests").
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
  server in the request's log from a page save with the page (S9: this server's Origin + Sec-Fetch-Site); an edit of the request unticks it; an agent
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
  `--git-dir=data/<p>/.history/.git` (never the workbench repository) and only when the director turned it on, with hooks
  off, `core.fsmonitor=false`, and only on a `.history/.git` whose config holds just what `git init` writes (else skipped
  with the reason: a handed-over project folder never runs its own hooks or filters); safe.directory is never overridden.
  `--git-dir=data/<p>/.history/.git` (never the workbench repository) and only when the director turned it on.
- Take selection (D6): picking a take (`take_act`: pick / unpick / dismiss) is the page's act only (via "page" from this
  server's Origin; no MCP tool; 403 to the agent surface, a claimed via "page", a foreign Origin and offline). A pick and a
  `take_propose` must name a registered media file of the project that is a take of that shot (not a path, a render, audio
  or another shot's take: 400 / 404), with 0 <= in < out <= the take's duration (a still: no range) and alternatives inside
  the song; request / take / kind come from the media entry. A page save of `storyboard.json` keeps the server's picks and
  the agent's `shots_update` ignores `clip`; `takes.json` is not a page save.
- Interpretations (E10, `lib/ops/interpret.mjs`): an intake answer or a note may carry `interpretation {text, by, via: "agent", at,
  status: proposed | accepted | edited, agent_text?, reviewed?}`. `interpretation_set` (the agent) always writes via "agent", status
  proposed, and never touches the verbatim text; an edited one is the director's (409). `interpretation_act` (accept / edit) is page
  only (S9: the page token + this server's Origin + Sec-Fetch-Site; no MCP tool; 403 to curl, the agent token, the Origin or
  Sec-Fetch-Site alone, cross-site, a forged Origin with the agent token, a claimed via "page" and offline). A save of `scenes.json`
  or `notes.json` never writes one (the server keeps its copy). Rendered escaped.
- Help › Connect Claude… (F9): `GET /api/connect` (local only) names the agent token's **file**; no response, page, copy button or
  export ever carries a token's value (tools/security-test.mjs checks the endpoint, the dialog's text and HTML and what it copies).
- The lyric gate (E2): accepting a proposal, adding or removing a surface (`surface_act`) is the page's act only (via "page" from
  this server's Origin; no MCP tool; 403 to the agent surface, a claimed via "page", a foreign Origin and offline). A surface and a
  `surface_propose` name a shot, a song line, a word range on it, a known kind (≤ 120 characters, no control characters) and words
  sung during the shot (400 / 404). A page save of `storyboard.json` keeps the server's `lyrics` and the agent's `shots_update`
  ignores them; `surfaces.json` is not a page save. `where` and `why` render escaped.
- Named events and the re-time (E1, `lib/ops/events.mjs`): `events.json` is the server's (not a page save: 403); `events_act`
  (add / update / measure / remove / accept / dismiss / import / retime_dismiss), `retime_apply` and `retime_undo` are page only
  (S9: the page token + this server's Origin + `Sec-Fetch-Site: same-origin`, never the agent token; no MCP tool; 403 to curl with
  the page token, the agent token, the Origin alone, Sec-Fetch-Site alone, cross-site, a forged Origin with the agent token, a
  claimed via "page" and offline). An agent's `event_add` is always `proposed` (not a snap target until the director accepts it)
  and `retime_propose` only records a proposal (nothing moves). Event ids `^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$`, anchors name such
  ids, times inside the song (400); an anchored event's time is changed only by a re-time and it cannot be removed (409); a
  re-time that would leave a boundary without length or a shot outside its scene is refused (400 / 409) and writes nothing. An
  agent's snapshot restore brings an accepted event that is not accepted now back as proposed. Names, notes and whys render
  escaped (the events column, the event and re-time dialogs; tools/security-test.mjs).
- Identity checks (D7): `check_add` writes `checks.json` only, never approvals, requests, picks or takes.json, whatever the body
  says; its target (a node, a take of that shot, a registered image / video), the character and the node compared with must exist
  (404; ids checked by shape: 400); each item names one of the character's constants or `likeness`; `checks.json` is not a page
  save (403); the constants act is page only; notes and constants render escaped. Nothing downloads or runs a face model.
- Final approvals (stage 7): `final_get` is read only; approving from the Final list goes through the page's own paths
  (the agent surface still gets 403 on approvals). "Lock for render" / "Unlock" (`final_lock` / `final_unlock`) are the
  page's only (via "page" from this server's Origin; no MCP tool; 403 to the agent surface, a claimed via "page", a
  foreign Origin and offline). While a project is locked (`revisions.json` `lock`, which only the server writes) every
  write without this server's Origin is refused with 409 and a reason: `/api/op/*` except reads (`*_get`, `*_list`,
  `*_versions`, `*_query`, `*_compare`, a `request_run` dry run), `/api/save/*`, `/api/restore` and deleting the project; the MCP server's
  offline ops and `snapshot_restore` check the same lock. The page itself still saves.
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
- The project as a zip (G5 / G6, `lib/ops/projectio.mjs`, `lib/zip.mjs`; tools/security-projectzip.mjs): `project_export` leaves out
  PRIVATE media (the PRIVATE rule, media flagged private, `thumbs/priv_*`) and scrubs every JSON file (`scrubPrivate`; a cost row keeps
  its money); `include_private` (a personal backup, written to `private/exports/`: served to localhost only) is the page's only (S9: 403
  to the page token alone, the agent token, the Origin alone, a forged Origin with the agent token, a claimed via "page" and offline;
  the MCP tool has no such field). `project_upload` (chunks staged in `<data>/.uploads/`, a dot-folder: never served, cleaned after a
  day) is page only; its first chunk must sniff as a zip / an audio file (415); declared size caps 2 GB / 300 MB (413); offsets
  checked (409); free disk checked (507). `project_import` validates the whole zip before writing anything (into a temp folder,
  renamed at the end; removed on any failure): every entry and manifest name a clean relative path (no `..`, `.`, empty segment,
  leading `/`, drive, backslash, `:`, NUL, control character, `~<digit>`, device name, trailing dot / space, dot-file or dot-folder
  but `.snapshots/`), no symlink, no zip64 / multi-disk / encryption, store or deflate only, no overlapping entries, the local name =
  the central one, sizes (a zip and its total uncompressed <= 2 GB, a file <= 512 MB, <= 20 000 files, ratio <= 1000:1, inflating stops at
  the declared size), every CRC, the manifest (format v1, a valid project id, every file listed once with the same size and sha256,
  nothing extra or missing), every JSON parses, entity / request / media ids and paths; then `inside()` again for each file. It never
  writes over an existing project (409) and demotes the director's decisions (approvals -> review, requests -> draft with the
  private-upload tick taken back, batches -> draft, looks / variants -> review, approved tree nodes unset, scenes / items ok ->
  needs_you / review, stages done -> in_progress, the render lock and command dropped; snapshots too); an agent imports only a
  path under a project's `exports/` or a media root, never a private one (403), and never an upload (403). A new project from an
  uploaded song (`/api/projects/new {song_upload}`) is the page's (403).
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

## Pairing a hosted page with this computer (G7, the local side)

The hosted app (G1, not built yet) is the same page served from another origin; the data stays on your computer and the page
reaches it through the helper. The local side is ready:

1. In a terminal: `npx ai-videoclip-director pair` (optionally `--origin https://director.example`, `--read-only`). It prints a
   short code like `K7QF-2MXD`: it works **once**, for **10 minutes**; 5 wrong codes void every pending code.
2. The hosted page sends it once: `POST http://localhost:8140/api/pair {code}` from its own Origin. The helper answers a token
   **bound to that Origin** (`{token, id, origin, scope}`), stored only as a hash in `<data>/.wb-pairings.json` (never served).
3. The page sends `x-wb-pair-token` on every request. Another Origin with it, or no Origin, gets 403. Scope `director` (the default):
   the page acts as you (approvals, picks...) when the browser says `Sec-Fetch-Site`; **never your private files** (403; JSON
   scrubbed), never a personal backup, never pairing management, Reveal or the onboarding flag. Scope `read`: GET only.
4. **Settings › Paired pages** lists the pairings (origin, scope, created, last used; never a token) and **Revoke** cuts one off at
   once; also `pair --list` / `pair --revoke <id>` in the terminal.

The browser side: an https page calling `http://localhost` is allowed as a "potentially trustworthy" origin, but Chrome asks for
**Local Network Access** (Chrome 142+: a permission prompt "this site wants to connect to devices on your local network"; older
versions send a Private Network Access preflight with `Access-Control-Request-Private-Network: true`). The helper answers CORS
preflights only for `/api/pair` and for Origins that hold a pairing, with `Access-Control-Allow-Private-Network: true`. The page's
fetches should pass `targetAddressSpace: "loopback"` (Chrome) so the prompt names the right thing. Server-Sent Events
(`/api/events`) cannot carry the token header: a hosted page polls for now (G1 will add a token in the URL or a WebSocket).

**Safari**: Safari blocks an https page's requests to `http://localhost` / `http://127.0.0.1` as mixed content in many versions
(WebKit's localhost exemption is partial and has changed between releases), and has no Local Network Access prompt. If the hosted
page cannot reach the helper in Safari: open the helper's own page instead (`http://localhost:8140/`: the same app, served locally,
no pairing needed), or use Chrome, Edge or Firefox for the hosted page. Firefox treats `http://localhost` as potentially trustworthy
and needs no prompt.

## The project as a zip (G5)

**File › Export project as zip…** writes `data/<project>/exports/<project>-<stamp>.zip` (the last 3 are kept) and downloads it:
every JSON file, the sketches, peaks, thumbnails and the media the project registers or points at, plus `workbench-export.json`
(format `director-workbench/project-zip` v1: each file's size and sha256). The zip's layout is the folder's, so it can be unpacked by
hand. **Private media is left out by default** (the PRIVATE rule, media flagged private, `thumbs/priv_*`) and every JSON file is scrubbed
of private paths; **include private media (personal backup)** is a tick in the page only, with a warning, and writes to
`private/exports/` (local only). Snapshots are optional. Files under a media root are not copied (counted as external). The MCP tool
`project_export` does the same without the private switch.

**File › Import project from zip…** (or drop a `.zip` anywhere on the page): the zip is uploaded in chunks, checked (every name a clean
relative path: zip-slip, absolute paths, drives, backslashes, dot-folders, device names and symlinks refused; sizes: 2 GB a zip and
uncompressed, 512 MB a file, 20 000 files, a compression ratio over 1000:1; the manifest's sha256 and size for every file, nothing extra
or missing; JSON and ids) and imported as a **new** project (id editable; never over an existing one). The director's decisions do not
travel: approvals arrive as `review`, every request as `draft` (its old status kept in `imported.status`, "allow uploading private refs"
off), batches as draft, approved looks / variants as review, approved tree nodes unset, scenes `ok` -> `needs_you`, items `ok` -> review,
stages done -> in progress, the render lock and the render command dropped (imported snapshots too); costs are kept as history
(`costs.json` `imported`). An agent imports with `project_import {path}` (a zip under a project's `exports/` or a media root).
No dependency: `lib/zip.mjs` (node:zlib + a CRC-32 table; no zip64). Tested by `npm run verify` v29, `npm run test:mcp` and
`tools/security-projectzip.mjs`.

### The way back: the picks as data for the composition (E9)

```
node exporters/composition-data.mjs --project <id> [--out composition/edl.json] [--map "project/gen/out/=assets/world/"] [--dry-run]
```

Writes `data/<project>/exports/<out>` only (also File › Export composition data… and the MCP tool `composition_export`):
format `director-workbench/composition-edl` v1, every storyboard shot with its time range, clip-use ids, the picked take (file
mapped under the composition, in / out) or a placeholder (`unpicked`, `private`, `missing`, `unmapped`), the alternatives, the
look per character and the variant per location / prop, the song's timing anchors and a sha256 checksum. Private media is never
written. A composition includes `exporters/composition-data/reader.js` (`<script src>`, no dependencies) and asks
`WB_EDL.load("wb/edl.json").at(t)` or `.use("G05@20158", t)` for the file and its in-point: a pure function of time, so the
render stays deterministic. Format, reader API and the (not applied) adoption proposal for the first film's `xp/world.js`:
`docs/COMPOSITION_ROUNDTRIP.md`. Tested by `npm run verify` v22 (a test composition renders take A, then take B) and
`tools/security-composition.mjs`.

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
- **Preview dock** (`core/dock.js`, P): **docked** at the right by default (F7): a full-height panel, and the page narrows to
  make room (the timeline's columns re-fit, nothing is covered; the grip on its left edge sets its width); **⇥** floats it
  bottom-right over the page instead (⇥ again docks it); floating, drag the title to any corner, the grip resizes, ⧉
  pops it out to `dock.html` (BroadcastChannel `wb-dock-<project>` keeps time, source and hover in sync; closing the
  window brings the dock back); geometry in localStorage. Modes: **film** (the render, exact seek on every playhead
  change, rate-nudged within a frame while playing), **hover** (after 220 ms over a shot, clip, cast chip, media cell
  or card; leaving returns to film), **pin** (click a media cell / Preview / Compare pins it; `film` unpins).
  Sources: `{kind: film|shot|use|compare|media|entity|look|image|video, id}`.
- **Media** (Assets > Media): dense grid grouped by kind; filters kind / entity / status / linked or unlinked / private, a
  search, "compact" cells, and **Import media…**; a badge on a cell the director used ("identity", "frame", "take"); hover
  scrubs the 8-frame strip; click = dock; right-click = `media` context (**Use as…**, show, compare takes, show on timeline,
  use as reference for…, copy path, open file location); drag a cell onto the look form as a reference.
- **Import media** (File › Import media…, or drop files anywhere on the page; `core/importmedia.js`, D8): dropped files are
  uploaded into the project (up to 200 MB each, judged by their bytes: images and video only); or type a path / folder under
  a media root to read it in place. A generation output folder (falgen's `out/<id>/job.json`, the runner's `gen/<request>/`)
  lists its jobs with the prompt, model, refs (🔒 = private) and the cost: recorded, counted from the linked falgen ledger,
  or "not counted yet" (a ledger row next to the tree, or an estimate from `js/prices.js`) with a "record" tick
  (`cost_record`, once per job; an estimate is offered, not ticked). Each row: thumbnail, kind, label, private (forced on
  for a PRIVATE path: never less private); "link to request" ties the files to a request. After Import each row has
  **Use as…**: identity / look of a character, base / variant of a location or prop (an imported node: no request, nothing
  paid), a shot's start frame (its thumb, a new storyboard version) or take (`use_as` on the media item; the take picker
  reads it). An agent imports with `media_import` and proposes a "use as" (`node_import_propose`, a note on the shot).
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
