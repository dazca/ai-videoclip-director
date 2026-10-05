# SPEC v4: notes everywhere, rounds and revisions, proposals (lead, 2026-10-05)

Dani, verbatim: "In every part we should be able to have a "notes" column, where user can, per typed time, or
formatted to the same line level to the left (e.g. verses in poem) we can add notes there directly. We should have a
"+add" in the right click or something in order to add new lines or timestamps. Notes is what will be absorbed by
claude or the AI assistant once all notes are in, and the UI will work in "revisions". Each revision stored and we can
compare revisions somehow maybe with inner git or dunno. You tell me whats best, but user must have it easy to do so.
[...] When drawing or something, we can add "proposals", like 3, made by SVG or code so user can imaginate and choose.
And then add more proposals dunno, proposals could be a pre-created text that you create at the beginning.. dunno.
Think whats best. Take in mind the orchestration and other files from the other videoclip."

## 1. A Notes column in every stage
- Every stage workspace (lyrics, script, breakdown, characters, scenery, storyboard, final) and the timeline get the
  same **Notes column** on the right of the stage's rows, **row-aligned** to what is on the left: a lyric line, a
  scene, a beat, a shot, an item, a tree node. On the timeline it is **time-aligned** (warped like every column).
- Click an empty cell (or Alt+N on the selected row) to type a note; Enter saves; the note sits on that row's line.
  A note can target the whole row, a word range (lyrics), a time (timeline), or a region of an image (pin).
- **Right-click "+ Add"** everywhere: + line / + verse / + section (lyrics), + scene / + beat (script),
  + timestamp note (timeline, at the clicked time), + shot (storyboard), + item (breakdown), + note here (anything).
- One shared notes model and component (`js/notes.js`, `core/notescol.js`) replaces the per-stage note panels
  (lyrics, scenes, breakdown, characters, storyboard already have notes; migrate them, keep reading the old files).
  Note: `{id, target{stage, kind, id, w?, t?, pin?}, text, by, via, status open|absorbed|dismissed, round, reply?,
  absorbed_in?: revision id, created}`.

## 2. Rounds and revisions (the easy version of "inner git")
- The director works in **rounds**. During a round they drop notes anywhere. A counter in the stage rail shows
  "Round 3 · 14 open notes". **"Send round to Claude"** (one button) closes the round: it writes one ask that lists
  every open note with its target, and the agent (via MCP `round_get` / `round_absorb`) applies them and saves new
  versions. Each note it handled becomes **absorbed** with a link to the change ("line 7 rewritten", "scene sc04
  split"), or gets a reply when it could not.
- Closing a round and finishing its absorption creates a **revision**: `R1, R2, ...`, a project-wide, immutable
  snapshot of every shared file (built on the existing `.snapshots/` mechanism), with a summary (notes absorbed,
  files changed, cost).
- **Compare** is a first-class view: pick two revisions (default: current vs previous) and see per stage what
  changed: text diff for lyrics/script, scene and shot add/remove/move on the timeline, image A/B for nodes, with each
  change linked to the note that caused it. Restore any revision (it snapshots the current state first).
- Under the hood: the per-file immutable versions + snapshots we already have, plus a `revisions.json` index. If
  `git` is on PATH, the server can also mirror each revision as a commit in `data/<project>/.history` (opt-in, for
  power users and for agents that like `git diff`); the user never needs to know git.

## 3. Proposals
- Anywhere a choice is visual or open (a scene sketch, a shot frame, a look, a location, a lyric line, a scene's
  idea), the agent can attach **proposals**: by default 3, each a small **SVG made with code** (composition, framing,
  silhouettes, colour blocks, camera arrows) or a short text, with a title and one line of rationale. Free: no image
  model needed.
- The page shows them as a strip of cards next to the target: **pick** (it becomes the sketch underlay / the text),
  **mix** (pick + a note), **"3 more"** (writes an ask), dismiss. Picks are the director's (page only).
- At project creation and after each stage the agent pre-creates proposals where they help most (scene sketches
  from the script, shot frames from the beats, look moods), so the director starts by choosing, not from a blank page.
- MCP: `proposals_add(target, items[{title, why, svg|text}])` (SVG sanitised server-side: no script, no external
  refs, size cap), `proposals_get`, `proposal_pick` is page only.

## 4. From the first videoclip (orchestration to carry over)
Look at `project/PRODUCTION.md`, `SYNC.md`, `STORYBOARD.md`, `shots.json`, `gen/falgen.py` (job books, cap, ledger),
`gen/TAKES.md`, `LEDGER.md`, `videoclip-research/README.md`, `videoclip-research/PHOTOREAL_GUIDE.md` +
`photoreal_recipe.json`, and `workbench-review/DOGFOOD_her_v3.md`. Whatever the film needed that the workbench lacks
(take selection, job books, render etiquette, sync points, the photoreal recipe as the default prompt template, one
cost ledger with falgen) goes into the roadmap.
