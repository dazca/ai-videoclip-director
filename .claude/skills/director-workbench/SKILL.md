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

## The workflow (one stage at a time, the director signs off each)

The page shows it as the **stage rail**: 1 Lyrics, 2 Script, 3 Breakdown, 4 Characters, 5 Scenery, 6 Storyboard,
7 Final. Report progress with `stage_update` (in_progress while you work, needs_you + a note when the director must
decide, blockers); only the director marks a stage done, in the page. Show them the stage with `ui_focus` view
`stage` (the rail opens the right one).

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
   an honest `est_cost`; the director approves it in the page. Run only approved ones (`request_update` queued ->
   running -> done with outputs and the actual cost), then `character_iteration_add {id, request}`: the image becomes a
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
   `base_propose`. An image that already exists (a legacy look, an output made outside the queue): `media_add` /
   `media_update`, `cost_record {usd, via, job}` for its spend (never an approval), then `node_import_propose`.
   To wait for the director, use `wait_for {request, until: ["approved", "rejected"], timeout_s}` instead of polling.
   If `status` says the server is stale, ask for a restart.
   The director approves in Review > Queue (show it with `ui_focus` view "queue"). Only if the owner enabled
   `agent_approvals` may you pass `director_approved: true`, and only when they said so in the conversation.
7. **Run** only approved requests: `request_update` queued -> running -> (call the provider) -> done with `outputs` and
   `actual_cost_usd`; on failure rejected + `why`. Outputs become media automatically; attach them to uses with
   `shot_update` (take, in_ms) and to entities with `entity_upsert`.
8. **Review**: set `review`, pin a note explaining what changed (`notes_add` on the shot / node / line), `ui_focus`
   with `preview` to show it. The director approves or requests changes; answer their notes with `notes_add {reply_to}`
   and `notes_status absorbed` + reply once done.
9. **Render**: the final render is a media item of kind `render` and the song's `audio.render`; snapshot first.

## Never

- Never call a paid API (image, video, voice, music) without an APPROVED request whose `est_cost` fits the cap.
  `costs_get` before proposing; the tools refuse queueing above the cap. Record the real cost when done.
- Never approve on the director's behalf, never mark their notes resolved without doing what they asked.
- Never `round_absorb` a note you did not apply, and never call `round_finish` before every note of the round is
  absorbed or replied. A round is not an approval: closing the revision is the director's.
- Never touch PRIVATE files (crops of real photos, anything under a `private/` folder or flagged private) beyond
  reading them locally for the director; never copy them into exports, the demo, the template or a shared repo.
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
