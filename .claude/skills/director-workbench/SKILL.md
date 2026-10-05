---
name: director-workbench
description: Work as the assistant director on a music video in the Director Workbench (a time-synced web workbench with an MCP server named "workbench"/"director-workbench"). Use when the user talks about their music video project, the workbench, the song timeline, lyrics timing, script, shots or storyboard, characters / looks / costumes, locations, props, generated clips or stills, the generation queue, approvals, notes pinned to song time, the cost cap, or asks to start a "director session". Covers the workflow song -> script -> breakdown -> characters/looks/locations/props -> storyboard -> generation requests -> review -> render, and the rule never to spend without an approved request.
---

# Director workbench

The director (the user) works in the workbench page (`http://localhost:8140/?project=<id>`); you work on the same
project through the MCP tools (server `director-workbench`) or the JSON files in `data/<project>/`. Every write shows
up live in their page. Read `CLAUDE.md` in the workbench folder (MCP resource `workbench://docs/claude`) for the file
formats and how to add features.

## Start of a session

1. `status`: is the server up (live page) or are you on files only? Which project? How many pages are open?
   Not up and the director wants to watch: ask them to run `npm start` in the workbench folder.
2. `projects` (action list / open) if the project is not the right one.
3. `stages_get`: where the project stands in the guided flow (seven stages, the next one, what blocks it). Then
   `song_get` (words:false for a quick read), `shots_list`, `notes_get` (every stage's open notes), `approvals_get` state=changes,
   `requests_list`, `costs_get`. Summarise in a few lines: where the video stands, what the director asked for, money.
4. Open director notes and items in `changes` are the to-do list. Notes are ONE list for every stage and the timeline:
   `notes_get` (status open; `stage` filters; `to: "agent"` = the director's asks). Answer with `notes_add {reply_to}`;
   when you did what a note asks, `notes_status {id, status: "absorbed", reply: "line 7 rewritten in v4"}`; write your
   own on the row it is about (`notes_add {target: {stage, kind, id, w?, t?, pin?}, text}`). Never dismiss the director's
   notes (refused) and never absorb one you did not act on. Confirm the plan before large changes.
5. `round_get`: has the director **sent a review round**? If `status` is "sent", that round is your job first (see
   "Review rounds" below); "collecting" means they are still writing notes.
6. `proposals_get`: what the director **picked** (and the mix notes: what to change), and the open asks for proposals
   ("3 more" on a target, "Prepare proposals" on a stage). See "Proposals" below.
7. Late in a project, `final_get`: what is left before the render (see "Final approvals" below). If `locked` is not
   null the project is **locked for render**: every write of yours is refused (409); only read, and tell the director.

## Proposals (3 free choices instead of one answer)

Where a choice is visual or open, give the director something to choose from, so they never start from a blank page:
- **Where**: a scene's sketch (`{stage: "script", kind: "scene", id}`: SVG layouts) or its idea (texts); a shot's frame
  (`{stage: "storyboard", kind: "shot", id}`: SVG frames); a lyric line (`{stage: "lyrics", kind: "line", id}`: texts); a
  look (`{stage: "characters", kind: "tree", id: "ada/look:x"}`) or a location variant (`{stage: "scenery", kind:
  "tree", id: "studio/variant:dusk"}`): SVG mood boards (colour blocks, a silhouette) or texts.
- **How**: `proposals_add {target, items: [{title, why, svg | text}]}`, 3 items by default, each with a short title and
  one line of why. Write the SVG with code: `viewBox="0 0 160 90"` (16:9), a sky / ground split, rule-of-thirds
  silhouettes (a circle and a rounded rect), colour blocks from the scene's palette, a camera arrow (`<marker>` +
  `marker-end="url(#ah)"`), a small label. Only shapes, paths, text, gradients, markers and `<use href="#id">`: no
  script, images, links, `<style>`, on* or external refs (refused with the reason; fix and retry). Make the three
  really different (framing, side, move, mood), not three variations of one idea.
- **When**: at the start of a stage (after the script draft: a sketch set per scene; after the shots: a frame set per
  shot without a frame; for each look), when the director asks for "3 more" (an ask on the target: your next
  `proposals_add` on it answers it), or on a stage-wide "Prepare proposals" ask (add sets where they help most, then
  `notes_status {id, status: "absorbed", reply}`).
- **After**: `proposals_get` `picks` is what they chose; a **mix** is a pick plus a note to you (also an open note on the
  target, in the next round): apply it. Build the next step from the pick (the sketch over it, the sheet request with
  the mood, the line). You never pick, mix or dismiss (no tool). Free: no image model, no request.

## Review rounds (the director's notes, absorbed in one go)

The director collects notes in every stage, then clicks **Send round to Claude** on the stage rail: every open note of
theirs goes to you as ONE ask (a note `to: "agent"`, `ask: "round"`), and the notes they write after that wait for the
next round. Work it like this:
1. `round_get`: the round's notes grouped by stage, each with `content` (what it points at: the lyric line and version,
   the scene with its beats, the breakdown item, the node image, the shot, the lyric at a timeline time) and
   `becomes` (the revision it will be, e.g. "R3").
2. Apply each note with the normal stage tools (`lyrics_update`, `scenes_update`, `breakdown_update`, `shots_update`,
   `node_import_propose`, `request_create` drafts, ...). Each save is a new version; never approve anything.
3. Per note: `round_absorb {note, change: {stage, file, version, summary}}` when you did it ("line 7 rewritten",
   "scene sc04 split in two", file "lyrics.json", version "v4"): the compare view links the change to the note.
   `round_reply {note, text}` when you cannot or need a decision (the note stays open for the director).
   The rail shows the director your progress live (absorbed / replied / left).
4. `round_finish {summary}` once every note is absorbed or replied: what you changed, what is left.
5. The director reviews and clicks **Close revision R<n>**: an immutable project-wide snapshot + an entry in
   `revisions.json`. They compare revisions (Review › Compare) and restore one if they want. Sending a round, closing
   and restoring a revision are theirs only (no tool; 403). `revisions_get` lists the revisions; `compare: ["R2", "R3"]`
   (or "R0" = before the first round, "now") gives the per-stage diff with the notes behind each change.

## Final approvals (stage 7)

**Takes** (take selection, D6). When a shot has outputs (the runner's, or imports linked to it), review them and propose
the best: `takes_get {shot}` (or `{request}`) lists every take with its absolute file (look at it), duration and fps, the
director's pick and your proposals; then `take_propose {shot, media | file | take (+ request), in_ms, out_ms, why}` (in /
out inside the take, ms or m:ss.mmm; why = what you saw: "take 0: the smile lands at 0.6 s; take 1 has a door wipe"; flag
an alternative for a moment in the why: "alternative for 139.84 s: take 2"). The director picks with one click (or picks
another, with in / out, a note and alternatives); the pick lands on the storyboard shot as `clip` through a new version.
You never pick (no tool) and never write `clip` (`shots_update` ignores it and keeps theirs). An imported file is a take
once it is linked to the shot (`media_update {id, shots: ["sh03"]}`). Final's checklist counts the shots with a pick.

**The lyric gate** (E2). "Every sung or spoken word appears on a desktop surface at its time." A surface is a lyric line (or a
word range of it) on a storyboard shot plus where it shows: `window` (a window title), `chat`, `dialog`, `karaoke`, `taskbar` or
`other`, with an optional detail (`"chat: Notepad, typed letter by letter"`). `surfaces_get` (read only) gives every line with each
word covered or not (and on which shot / where), the uncovered runs and your proposals; `uncovered: true` lists only the gaps. Fill
them with `surface_propose {shot, line, w?: [first, last], where, why}`: the shot must be on screen while the words are sung (else
400). The director accepts it in the page (Storyboard › Shot › lyrics on screen) or adds their own; it lands on the shot as
`lyrics[{line, w?, where}]` through a new version. You never write `lyrics` (`shots_update` ignores it and keeps theirs) and
cannot accept (no tool). Final's checklist line "every word on a surface" counts the words; the timeline's surface column shows
the uncovered ones in red.

**The picks for the composition** (E9). When the director wants the render to follow the picks, `composition_export`
(`{dry_run: true}` first to see the counts; `map` rules `{from, to}` turn workbench media paths into the composition's,
e.g. `project/gen/out/` -> `assets/world/`) writes `data/<project>/exports/composition/edl.json` and nothing else (also while
locked). Tell the director how many shots are picked and which are placeholders (unpicked / private / missing / unmapped).
The composition reads it with `exporters/composition-data/reader.js`; never edit the composition's own files to adopt it
unless the director asks (docs/COMPOSITION_ROUNDTRIP.md has the proposal).

**Identity checks** (D7, free). A character's `constants[]` (D2) are the details that must stay identical ("orange starburst
clip above the LEFT ear", "cyan jaw seam"); the ticked ones are its checklist. The director keeps them in the Characters stage
(Identity tab, "Constants"); you may propose them with `entity_upsert {kind: "character", id, fields: {constants: [{text, check,
label}]}}` when they ask. With their switch on ("ask for an identity check when an output lands"), a run, an import or a new node
leaves you ONE note per character (ask `check`, "Identity check: 2 new outputs of Ada landed …"). Then: `checks_get {entity}` (the
approved identity image and each output, absolute paths: look at both), and per output `check_add {target, against: {entity},
verdict: ok | drift | fail, items: [{constant, ok, note: "clip on the RIGHT side"}, {constant: "likeness", ok}], note}`. Be honest:
`ok` only when every item holds. The ask is absorbed once every output is checked. The director sees the badge ("✗ clip side")
on the node / take and decides; a check never approves, rejects or picks. Never invent a `score` (only a local face-embedding
tool fills it: tools/face-score.md).

`final_get` (read only) answers "what is left?": `ready`, `failing`, the **ready-to-render checklist** (every second
scripted, every scene has shots, every shot an approved frame / take / clip, every shot a picked take, every word on a surface (the lyric gate), every asset approved, no open notes, no
open round, costs within the cap, an export is possible; derived from the files, each failing line with its gaps),
`pending` (every row not approved yet, grouped: lyrics, script, breakdown, characters, scenery, storyboard, requests;
with status, why, est / spent cost, open notes) and `costs` (spent from the merged ledger, committed, drafts, the shots
not requested yet, projected, against the cap). Summarise it for the director in a few lines (the failing checks
first, then the biggest groups and the money), then work the gaps you can: draft requests (`gaps_get`,
`request_create`), answer open notes, propose shots or assets, set `review` + a note where you need their look.
Approving rows, approve-selected and **Lock for render** / **Unlock** happen in the page only (Final stage; show it
with `ui_focus` view `stage`). A locked project refuses your writes with 409 until they unlock: do not retry.

## The workflow (one stage at a time, the director signs off each)

The page shows it as the **stage rail**: 1 Lyrics, 2 Script, 3 Breakdown, 4 Characters, 5 Scenery, 6 Storyboard,
7 Final. Report progress with `stage_update` (in_progress while you work, needs_you + a note when the director must
decide, blockers); only the director marks a stage done, in the page. Show them the stage with `ui_focus` view
`stage` (the rail opens the right one). The director may view Lyrics, Script, Breakdown, Storyboard and Final in
**Time** (List | Time on the stage bar, Alt+T): the same rows on the timeline's time axis. It changes nothing in the files:
your times (`t0` / `t1` ms on scenes, beats, shots) are what places them, so keep them exact and tiled.

1. **Lyrics** (stage 1): a project can start from lyrics alone (`projects` create with `lyrics`, or the page's
   wizard); the song comes later (`song_attach`, timings re-estimated over the real song). `lyrics_get` gives the
   poem with line ids, timings, open notes and `asks_for_agent` (the director's "Ask the agent" box: your to-do
   list). Work by notes first (`lyrics_note_add` on a line or a word range, `reply_to` to answer in a thread,
   `lyrics_note_resolve` with a reply when done); change the poem only as asked, with `lyrics_update` (a NEW version
   with a message; nothing is overwritten; `lyrics_versions` lists and diffs, `restore` copies an old one back).
   A new song with timed lyrics: `node importers/new_project.mjs <id> --song <file> --lyrics <file>` (LRC timings are
   used; plain lyrics are spread evenly and marked `timing: "estimated"`: fix them before cutting). Sections, bars and
   lyric lines are the grid every later decision snaps to.
2. **Script** (stage 2, `scenes.json`): start from the **intake** (`intake_get`): ask the open questions in the
   conversation (mark them `intake_answer` `asked_in_chat: true`) and record the director's own words with
   `intake_answer` (`by: "director"` when you relay them). Then draft **scenes** with `scenes_update` (each call is a
   NEW version with a message): every scene bound to song time (`t0` < `t1`, `snap: "lines"` / `"bars"` /
   `"sections"`), a title, a visual description, timed **beats** inside it, and sketch ids. `script_get` shows the
   scenes with their lyric lines, the **gaps** (unscripted ranges with the lines in them), coverage, notes and
   `asks_for_agent`; an ask of kind `fill_gaps` means cover every listed gap, then `scene_note_resolve` it with a
   reply. Work by notes when the director should decide (`scene_note_add`, `reply_to` in threads); set a scene
   `needs_you` (`status`), never `ok` (the director's). The director's drawings: `sketch_get` / `sketch_list` give the
   PNG and mask paths (open them to look) and the numbered pins ("necklace, silver, thin"); `sketch_save` writes one
   (base64 PNG). A project scripted before the flow reads its old `script.json` as v1 (stages -> scenes, lines -> beats).
3. **Breakdown** (stage 3, `breakdown.json`): `breakdown_get` returns the current items and, with them, everything to
   extract from: the script scenes (text, beats, sketch pins: the director's callouts), the intake (who, where, era,
   must-haves) and the existing entities. Write the items with `breakdown_update` (a NEW version each time, with a
   message): characters, locations, props, wardrobe (`for` = the character item it belongs to) and FX, one item per
   distinct thing, each linked to the scenes and beats that need it (`links: [{scene, beats, note?}]`). Keep what the
   director made: merge duplicates, mark `dropped: true` instead of removing, never undo their drops. An ask of kind
   `extract` (the page's "Ask the agent to extract") means draft or refresh the breakdown, then
   `breakdown_note_resolve` it with a reply. Statuses: `review` asks the director to look (e.g. "make this an
   entity"); `ok` is theirs. Entities come from the page's "Create entity" (a draft character / location / prop, or a
   look on a character): you cannot create them from a breakdown item; ask with `review` and a note
   (`breakdown_note_add`).
4. **Characters** (stage 4, the page's Characters stage): `character_get` lists every character (status: needs a
   base / iterating / identity approved / looks) and, per character, the director's **base** (catalogue bodies,
   Openverse images with licence / creator / URL, a description, private reference photos, sketches: open the ref
   `file`s to look), the **iteration trees** ("identity" and one "look:<id>" per costume), the requests with the edit
   text, the numbered **pins** ("necklace here, silver") and the sketch PNG / **mask** files, and what waits on whom
   (`to_run`, `to_register`, `waiting_for_director`). Every generation is a `request_create` DRAFT with `asset {type:
   "character", id, tree, from, kind: identity | edit | look}` (`char` is deprecated), refs (for an edit: the node image, the sketch PNG, the mask), the tool and
   an honest `est_cost`; the director approves it in the page. Run only approved ones (`request_run`, step 7: the
   outputs join the tree as nodes by themselves; a run made outside the runner: `request_update` queued -> running ->
   done with outputs and the actual cost, then `character_iteration_add {id, request}`): the image becomes a
   node; the director compares it with its parent and keeps, branches or reverts it, and approves the identity / a look
   (locks it), all in the page. A look starts from the approved identity; propose new costumes with `look_create`
   (status review). Answer the director's notes and asks with `character_note_add` (`reply_to`, `resolve`). Private
   photos (friends, the director) and anything made from them stay under `private/`: never copy them anywhere shared.
   The `character_*` tools are the generic `asset_*` tools with `type: "character"`.
   **Scenery** (stage 5, locations and props: the page's Scenery stage): the same loop through `asset_get` (no id:
   every location / prop with its status; with `type` + id: base, trees "base" and "variant:<id>", variants with
   their axes, requests, `to_run`, `to_register`, `waiting_for_director`, and `scenes`: each scene that uses it with
   the variant it needs), `request_create` with `asset {type: "location" | "prop", id, tree, from, kind: base | edit |
   variant}` (a location's base is an establishing plate, empty of people; a prop's a sheet; a variant's sheet starts
   from the approved base node, its image first in refs), `asset_iteration_add {type, id, request}` and
   `asset_note_add`. Propose variants with `variant_create` (status review): a location's `axes` {angle: wide / medium
   / reverse / a word, tod: dawn / day / dusk / night, weather: clear / overcast / rain / fog / snow / a word}, a
   prop's {angle, state: broken / lit / wet / open / a word}, and `scenes` = the scenes you propose it for (read the
   scene text: "at night in the rain" -> a night / rain variant for that scene). The director picks the variant each
   scene uses in the page; the storyboard reads `asset_get` `scenes`. A missing look, angle or state becomes a
   variant + a generation request, not a guess.
5. **Storyboard** (stage 6, the page's Storyboard stage; `storyboard.json`, read as v1 from `shots.json` until the
   first write): `storyboard_get` gives the scenes in song time with their beats, what each needs (the breakdown's
   assets and the variant the scene uses) and their shots. Cut each scene into shots from its beats (one shot per beat
   or group of beats) with `shots_update` (a new version each time; `snap: "beats"`; the shots of a scene tile it):
   kind (wide / medium / close / insert / performance / xp-desktop), the action, camera / motion, `cast` / `locations`
   / `props` as entity ids, `variants` only where a shot differs from the scene's pick, `gen` still or video. Draw a
   frame where it helps (`sketch_save` with `links.shots`, then `sketch` on the shot). Status `review` asks the
   director to look (`shot_note_add` says why); approving a shot is theirs. Asks of kind `storyboard` (propose shots)
   and `fill_gaps` (draft requests) arrive in `storyboard_get` / `gaps_get` `asks_for_agent`; answer with
   `shot_note_resolve` + reply when done. `gaps_get` lists what is still missing across the stages (unscripted time,
   scenes without shots, shots without a frame, assets not approved, shots without a request or clip) and, per shot,
   the draft requests to propose (`shot-still` first, `shot-video` from its output; target `shot:<id>`; refs = the
   approved variant / look images + the frame sketch) with the total against the cap: propose the missing asset
   sheets first, keep the total under the cap (prefer stills when it is tight), and say so in the reply.
6. **Generation requests**: `request_create` drafts with a concrete prompt, refs, tool and an honest `est_cost` (list prices:
   `js/prices.js`; for photoreal stills and video pass `recipe {model, wardrobe, action, place, light, ...}`: the prompt is
   built from the photoreal blocks, the estimate from the price table; read the returned `warnings`). No base yet:
   `base_propose`. An image or video that already exists (a legacy look, an output made outside the queue, falgen's
   `out/<id>/`): `media_scan {path}` (a folder under a media root: its files and each `job.json` job with prompt, model,
   refs, takes and cost status), `media_import {paths}` (registers in place, job / take / cost share; private never
   lowered), `cost_record` with the job's `cost.offer` when it says not_counted (never an approval), then
   `node_import_propose` for a node; a take or a start frame for a shot: a note on the shot. "Use as…" and uploads are
   the director's, in the page (File › Import media…).
   To wait for the director, use `wait_for {request, until: ["approved", "rejected"], timeout_s}` instead of polling.
   Several drafts: `wait_for {requests: [ids], until: ["approved", "rejected"]}` returns on the first. A draft of yours that is
   obsolete: `request_update {status: "withdrawn", why, superseded_by}` (rejected is the director's word). With no page open,
   `ui_focus` is queued for the next page that opens the project.
   If `status` says the server is stale, ask for a restart.
   The director approves in Review > Queue (show it with `ui_focus` view "queue"). You cannot approve: no tool does
   it (403), even when they say "approve it" in the conversation; ask them to click.
7. **Run** only approved requests: `request_update` queued -> running -> (call the provider) -> done with `outputs` and
   `actual_cost_usd`; on failure rejected + `why`. Outputs become media automatically; attach them to uses with
   `shot_update` (take, in_ms) and to entities with `entity_upsert`.
8. **Review**: set `review`, pin a note explaining what changed (`notes_add` on the shot / node / line), `ui_focus`
   with `preview` to show it. The director approves or requests changes; answer their notes with `notes_add {reply_to}`
   and `notes_status absorbed` + reply once done.
7. **Run** only approved requests, with the workbench runner (the same one as the page's **Run** / **Run all approved**
   buttons in Review > Queue): first `request_run {ids, dry_run: true}` and tell the director the plan (generator,
   model, takes, estimate, cap); then `request_run {ids}` (returns at once; `wait_for {request, until: ["done",
   "failed"]}`) or `request_run {ids, wait: true}`. It refuses drafts (you cannot approve), re-checks the cap, writes
   `gen/<request>/<id>_<take>.png` + `job.json`, records the actual cost once, registers the media and adds the outputs
   to the request's asset tree as nodes the director keeps or picks (`linked` on the request). A `failed` request (why)
   can be run again: outputs that exist are skipped and a submitted job is polled, not paid twice. The generator per
   kind is the director's (Settings > Generator: fal by default; "Open in another app" exports a prompt pack and the
   request waits for its results; `generators_get`). The fal key is in the user's environment: never ask for it, print
   it or write it anywhere. **Video** runs in the same runner: propose it with `request_create {kind: "shot-video",
   target: "shot:<id>", prompt, video: {model: h3max | kling3pro | klingmc, start, end?, ref_video?, seconds}, takes?}`:
   the prompt is MOTION ONLY (what moves and one camera move, not what the frame already shows; `recipe {model, action,
   camera}` builds it), the start frame an APPROVED still, the end frame (optional) an edit of the start frame, 5-6 s by
   default; motion control takes a reference clip (3-30 s, one person, no cuts) and describes only the background.
   `refs`, `tool` and `est_cost` ($/s x seconds x takes, js/prices.js; the H3 promo ends 2026-10-15) follow from `video`.
   Outputs are `.mp4` takes of the shot (`takes_get`). A done request whose `takes_failed` is not empty: `request_run
   {ids, retake: true}` (dry run first) runs only those takes again. A run made outside the runner: `request_update`
   queued -> running -> done with `outputs` and `actual_cost_usd` (or `failed` / rejected + `why`). From a shell:
   `node <workbench>/tools/run.mjs --project <p> <ids> [--dry-run] [--retake]`.
   **Waves** (D4): shots are generated in waves with review gates, a pilot first ("to measure the take ratio … the rest
   only after that"). `waves_propose {pilot: [shot ids], sizes: [2, 4, 8], takes: 2, dry_run: true}` gives the plan from
   the storyboard gaps (waves, shots, estimates, the cap): show it, then call it without `dry_run` to write draft requests
   and draft batches (each gated on the one before). The director approves a whole batch ("Approve batch · $X") and marks
   it reviewed once every take is picked or rejected; that unlocks the next. Run an approved batch with `request_run
   {batch, dry_run: true}` then `request_run {batch}`; a locked batch is refused. After each wave read `batches_get`
   (`observed.takes_per_used_shot`, `observed.usd_per_used_s`, `remaining[].observed_usd`) and tell the director what the
   next wave will really cost. Requests marked `history` (the first film's job books, imported by the director) are
   done: never run or edit them.
8. **Review**: set `review`, pin a note explaining what changed, `ui_focus` with `preview` to show it. The director
   approves or requests changes; answer their notes with `note_resolve` + reply.
9. **Render**: the final render is a media item of kind `render` and the song's `audio.render`; snapshot first.

## Never

- Never call a paid API (image, video, voice, music) without an APPROVED request whose `est_cost` fits the cap.
  `costs_get` before proposing; the tools refuse queueing above the cap. Record the real cost when done. Prefer
  `request_run` (it enforces all of this) to calling a provider yourself.
- Never approve on the director's behalf, never mark their notes resolved without doing what they asked. Never approve,
  review (unlock) or re-cap a batch, nor import the job books: those are the director's, in the page.
- Never pick, mix or dismiss a proposal (the director's, in the page), and never write `proposals.json` or
  `proposals/*.svg` by hand: `proposals_add` sanitises and records them. Never pick a take or write a shot's `clip` (or
  `takes.json`): propose with `take_propose`; the director picks in the page. Never write a shot's `lyrics` (or
  `surfaces.json`): propose a surface with `surface_propose`; the director accepts in the page.
- Never treat an identity check as a decision: `check_add` only informs the director (a badge); never approve, reject or pick
  because of it, and never write `checks.json` by hand.
- Never try to work around a project locked for render (409): no hand edits of the files, no snapshot restores; ask the
  director to unlock it in the Final stage.
- Never `round_absorb` a note you did not apply, and never call `round_finish` before every note of the round is
  absorbed or replied. A round is not an approval: closing the revision is the director's.
- Never touch PRIVATE files (crops of real photos, anything under a `private/` folder or flagged private) beyond
  reading them locally for the director; never copy them into exports, the demo, the template or a shared repo.
  A fal run uploads its refs to fal storage (a public URL): a request with a private ref runs only after the director
  ticks "allow uploading private refs" on it in Review › Queue (`request_run` says so); you cannot tick it. Look
  colours are hex only (`#1c2541`).
- Never edit timing by moving pixels: times are integer ms in the JSON; layout follows.
- Never mark a stage done or edit `stages.json` / `lyrics.json` / `scenes.json` by hand to look like the director's
  (`via: "page"`): use the tools, which stamp your writes `via: "agent"`. Never mark a scene `ok`.
- Never invent intake answers: record only what the director said.
- Never mark a breakdown item `ok`, and never try to turn one into an entity yourself: set `review` and ask.
- Never choose keep / branch / revert, approve an identity, a base, a look or a variant, pick the variant a scene
  uses, or write an asset's `iter` / `base` / `uses` by hand: those are the director's, in the page. Register only
  outputs of approved, done requests.
- Never approve or lock a shot (`shots_update` refuses it), never rewrite `storyboard.json` by hand, and never create a
  request a shot does not need: `gaps_get` says what is missing and what it costs.

## Handy patterns

- "What happens at the drop?" -> `timeline_query` around the section start, then `ui_focus` t + select.
- "Make a new costume for X" -> `entity_get` X, propose a look with `request_create` (kind `new-costume`, target
  `character:X`, refs = the look's base images), wait for approval.
- "Try another take" -> `shot_get` the shot (lists every take per clip use), `shot_update` take/in_ms, state `review`.
- Before risky edits: `snapshot_save`; undo with `snapshot_restore`.
- "Storyboard the chorus" -> `storyboard_get` {scene}, `shots_update` upsert one shot per beat (snap beats), a frame
  sketch for the key shot, then `ui_focus` view "stage" and a `shot_note_add` asking for review.
- "What is left before we can render?" -> `gaps_get`: the groups, the draft requests and the estimate vs the cap.
- "Give me options for the chorus shot" -> `storyboard_get` {scene}, then `proposals_add` on the shot with 3 SVG frames
  (wide low angle / over the shoulder / top shot), `ui_focus` view "stage" select the shot; after their pick,
  `proposals_get` and draw the frame over it (`sketch_save` with `underlay` = the picked SVG path).
