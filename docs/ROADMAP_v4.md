# Roadmap v4: audit against everything Dani asked for (2026-10-05)

Status: audit and plan. No code was changed for this document.

## How this audit was made
- Sources read:
  - specs: `docs/SPEC_v3_GUIDED.md`, `docs/SPEC_v4_NOTES_ROUNDS.md`, `docs/WEB_SERVICE_PLAN.md`;
  - guides: `README.md`, `CLAUDE.md`, `.claude/skills/director-workbench/SKILL.md`;
  - review: `../workbench-review/DOGFOOD_her_v3.md`;
  - the first film's orchestration: `../project/{PRODUCTION,SYNC,STORYBOARD,TREATMENT,NOTES_treatment_dani,LEDGER}.md`, `../project/gen/{falgen.py,TAKES.md,LOOKS_PLAN.md,jobs_her_v3.json}`;
  - research: `../videoclip-research/{README.md,PHOTOREAL_GUIDE.md,photoreal_recipe.json}`.
- The live app: `serve.mjs 8191` ran on a scratch copy of `data/demo` (WORKBENCH_DATA in the scratchpad). Headless Chromium screenshots were taken of every page, sub-view and stage (1600x900 and 1280x800), plus the palette, a context menu, the File menu, the hidden top bar and the preview dock. I read every screenshot. The page logged no console errors. The server was stopped afterwards.
- Work already under way: while this audit ran, the dogfood loop added `js/prices.js` (one price table), `templates/photoreal_recipe.json`, `docs/PHOTOREAL.md` and a `js/recipe.js` reference, and changed `js/assets.js` and `js/storyboard.js`. The items below that this work covers are marked **(in progress)**, so the loop can verify them.

## Legend
- **Size:**
  - **S**: at most one hourly iteration.
  - **M**: two or three iterations.
  - **L**: a day or more, to be split into the sub-items given.
- **Dep:** the items that must land first.
- **Files:** the files the item mostly touches. The parallel plan at the end uses these.
- Quotes are Dani's words, from the specs, PRODUCTION.md, NOTES_treatment_dani.md, LOOKS_PLAN.md or the standing requirements.

---

## A. Dogfood frictions (being fixed now; verify each one)

The source is `DOGFOOD_her_v3.md`: HER's looks v3 run through MCP. Dani's order (LOOKS_PLAN.md): "first fix the workbench frictions found in DOGFOOD_her_v3.md, then do everything through the workbench (MCP)".

For each item, the loop should check the line given under **Verify**.

**A1. A stale server is not detected.**
- Missing: `status` says the server is "up" even when its code is older than the files on disk. A new op then fails with `404 no such op: character_get`.
- Where: `mcp/server.mjs` `status`, `serve.mjs`.
- Why: an agent loses time on a false error, and Dani's page silently posts to the old ops.
- Size: S. Dep: none.
- Verify: `status` reports a code hash or mtime mismatch and says "restart the server". On a 404 "no such op", the MCP server falls back to files mode for that op.

**A2. The page is stale too.**
- Missing: the page loads new JS but posts its acts to the old server.
- Where: `js/store.js`, `serve.mjs` `/api/status`.
- Why: Dani may be unable to set a base or approve, without being told why.
- Size: S. Dep: A1.
- Verify: the page shows a one-line "server is older than the app, restart it" bar.

**A3. An agent cannot propose a base.**
- Missing: there is no `base_propose` tool. `character_get` says only "needs a base".
- Where: `lib/store.mjs`, `mcp/server.mjs`, the stage 4 and 5 workspace (`tabs/assetws.js`).
- Why: the brief "set her base from her reference" had no path. Agents must never set a base themselves, but they should be able to propose one that Dani accepts with one click.
- Size: S. Dep: none.
- Verify: the tool writes a proposal, and the page shows **Accept base** next to it.

**A4. A character made the old way cannot unlock its looks without paying again.**
- Missing: there is no way to promote an existing image (e.g. `her_full_green`) to the identity head without a request.
- Where: stage 4. The demo shows it too: in Assets › Characters, **Ada is "approved"**, while the Characters stage says **"Ada needs a base"** (screenshots `02_characters`, `03_stage_characters`).
- Why: unlocking the looks would otherwise mean a paid regeneration of something that is already approved.
- Size: M. Dep: D8 (import node).
- Verify: Dani can choose "Use as identity" on a media item. An agent can propose it. The tree starts from an import node.

**A5. A look request with no source is accepted.**
- Missing: `request_create` on a `look:` tree with `from: null` is accepted silently.
- Where: `lib/store.mjs` request validation.
- Why: the error only shows at `character_iteration_add`, after the money is spent.
- Size: S. Dep: none.
- Verify: the draft is refused, or warns, at create time.

**A6. Outputs made outside the queue cannot be registered.**
- Missing: there is no "import / retro-register" request kind for paid outputs made outside the queue ($0.72 for HV1-3).
- Where: `lib/store.mjs`, the Review › Queue page.
- Why: the alternatives are faking an approval (forbidden) or leaving the spend unrecorded.
- Size: S. Dep: D5 for the cost line.
- Verify: a `retro` kind with outputs and actual cost lands in the queue as "needs director confirmation". Nothing runs.

**A7. Costs are out of sync with falgen.**
- Missing: `costs_get` says $25.08, while falgen's `spent.json` says $25.78 and LEDGER.md has the HV rows.
- Where: `lib/store.mjs` costs, `../project/gen/falgen.py`.
- Why: two ledgers drift apart, so the cap check is wrong.
- Size: S as a stopgap (read falgen's `spent.json`). D5 is the real fix.
- Verify: `costs_get` shows both totals and flags a difference.

**A8. Two link fields on requests.**
- Missing: `char` and `asset` both exist. The docs say "asset wins".
- Where: `mcp/server.mjs` schema, CLAUDE.md.
- Why: agents cannot tell which field is canonical.
- Size: S. Dep: none.
- Verify: `char` is accepted as an alias and echoed back as `asset` only.

**A9. Three estimates for one look sheet (in progress).**
- Missing: CLAUDE.md says $0.08, falgen says $0.12 per image, and the coordinator said $0.24.
- Where: `js/prices.js` (new), `js/assets.js`, `js/characters.js`, CLAUDE.md. The demo still shows **"Request identity sheet · est $0.08 · fal-ai/flux-pro/kontext/max/multi"**, a model the recipe does not use.
- Why: honest estimates are the basis of "nothing paid without an approved request".
- Size: S. Dep: none.
- Verify: one table is the only source, the forms show nb2 2K at $0.12 × takes, and CLAUDE.md quotes the table.

**A10. Media cannot be relabelled.**
- Missing: there is no `media_update`. `media_add` on a path that is already indexed ignores the new label and kind.
- Where: `lib/store.mjs`, `mcp/server.mjs`.
- Size: S. Dep: none.
- Verify: the label, kind and entities can be changed. Changing the private flag is refused.

**A11. Every agent writes its own MCP client.**
- Missing: there is no reusable CLI. On Windows, an ESM import needs `pathToFileURL`.
- Where: `mcp/client.mjs` (new).
- Size: S. Dep: none.
- Verify: `node mcp/client.mjs status '{}'` works from any folder.

**A12. Waiting for an approval means polling.**
- Missing: there is no `wait_for` tool or notification.
- Where: `mcp/server.mjs`, the SSE in `serve.mjs`.
- Why: the "poll every 30 s for 60 min" pattern wastes turns.
- Size: S. Dep: none.
- Verify: `wait_for {request|item, until: status, timeout_s}` returns on change.

---

## B. SPEC v4: notes column, rounds and revisions, compare, proposals, right-click "+ Add"

Dani: "In every part we should be able to have a "notes" column ... formatted to the same line level to the left ... Notes is what will be absorbed by claude ... the UI will work in "revisions" ... user must have it easy to do so."

Today:
- Notes live in six separate stores: `notes.json`, `lyrics.json`, `scenes.json`, `breakdown.json`, entity `iter.notes` and `storyboard.json`.
- Each stage has its own side panel.
- Review › Notes lists only `notes.json`: 2 notes in the demo, none of the stage notes.
- There are no rounds, no revisions and no proposals. The word "round" appears nowhere in the code.

**B1. One notes model, with migration.**
- Missing: `js/notes.js` with `{id, target{stage,kind,id,w?,t?,pin?}, text, by, via, status open|absorbed|dismissed, round, reply?, absorbed_in?, created}`. It reads the six old stores, and new notes are written once to `notes.json` v2.
- Where: `js/notes.js` (new), `lib/ops/notes.mjs`, the readers in `tabs/*`.
- Why: "Notes is what will be absorbed by claude". One list is what one "send round" needs.
- Size: M. Dep: G4 (the split of `lib/store.mjs`) is strongly advised first.

**B2. The Notes column component, first in Lyrics.**
- Missing: `core/notescol.js`, a right-hand column aligned to each row. Clicking an empty cell or pressing Alt+N types a note, and Enter saves it. A note can target a row, a word range or an image pin.
- Where: the Lyrics stage. Today it has a separate 330 px side panel: screenshot `03_stage_lyrics` shows the poem in the top third and the "Notes 0" panel unrelated to the lines.
- Why: "per typed time, or formatted to the same line level to the left (e.g. verses in poem)".
- Size: M. Dep: B1.

**B3. The Notes column in Script, Breakdown, Characters, Scenery, Storyboard and Final.**
- Missing: the same component on each stage's rows: scene, beat, item, tree node, shot.
- Where: `tabs/script.js`, `breakdown.js`, `assetws.js`, `storyboard.js`, and the Final stage (C1).
- Why: "In every part".
- Size: M (one stage per half hour once B2 exists). Dep: B2.

**B4. A time-aligned notes column on the timeline.**
- Missing: the timeline's `notes` column displays notes but cannot be typed into. Clicking an empty cell should add a note at that warped time.
- Where: `js/columns.js`, `js/timeline.js`.
- Why: the same as B2, on the warped axis "synced to the millisecond".
- Size: S. Dep: B1.

**B5. Right-click "+ Add" everywhere.**
- Missing: a `+ Add ›` submenu on every context:
  - lyrics: + line / verse / section;
  - script: + scene / + beat;
  - timeline: + timestamp note at the clicked time;
  - storyboard: + shot;
  - breakdown: + item;
  - anywhere: + note here.
- Where: `core/defaults.js` menus and the stage tabs. Screenshot `05_context` (timeline) offers only "New note…" and "Add marker".
- Why: "We should have a "+add" in the right click or something in order to add new lines or timestamps."
- Size: S per context. M in total. Dep: none (B2 for "+ note here").

**B6. Rounds.**
- Missing:
  - a "Round 3 · 14 open notes" counter on the stage rail;
  - a **Send round to Claude** button, which closes the round and writes one ask;
  - MCP `round_get` / `round_absorb`. A handled note becomes `absorbed`, linked to the change ("line 7 rewritten"), or gets a reply.
- Where: `core/rail.js`, `js/notes.js`, `lib/ops/rounds.mjs`, `mcp/tools/rounds.mjs`, SKILL.md, CLAUDE.md.
- Why: "Notes is what will be absorbed by claude ... once all notes are in".
- Size: M. Dep: B1.

**B7. Revisions R1, R2, ….**
- Missing: when a round's absorption finishes, an immutable project-wide snapshot with a summary (notes absorbed, files changed, cost), indexed in `revisions.json`. Restoring one takes an auto-snapshot first. An opt-in git mirror goes in `data/<p>/.history`.
- Where: `lib/ops/snapshots.mjs`, `core/projects.js` (File › Revisions).
- Why: "Each revision stored and we can compare revisions somehow maybe with inner git".
- Size: M. Dep: B6.

**B8. Compare view.**
- Missing: pick two revisions (the default is the current one against the previous one) and see, per stage:
  - a text diff for lyrics and the script (reuse the per-stage version diffs that already exist);
  - shots and scenes added, removed or moved on the timeline;
  - image A/B for tree nodes.
  
  Each change links to the note that caused it.
- Where: a new `tabs/compare.js` (Review › Compare).
- Why: "user must have it easy to do so".
- Size: L. Split it: B8a text stages, B8b timeline, B8c images.
- Dep: B7.

**B9. The proposals data and MCP.**
- Missing: `proposals_add(target, items[{title, why, svg|text}])` with a server-side SVG sanitiser (no script, no external refs, a size cap), and `proposals_get`. `proposal_pick` is page-only.
- Where: `lib/ops/proposals.mjs`, `mcp/tools/proposals.mjs`, `tools/security-test.mjs`. The SVG sanitiser must also pass the security suite.
- Why: "we can add "proposals", like 3, made by SVG or code so user can imaginate and choose".
- Size: M. Dep: G4.

**B10. The proposals strip in the page.**
- Missing: three cards next to the target (a scene sketch, a shot frame, a look, a location, a lyric line, a scene idea), with **pick**, **mix**, **3 more** and **dismiss**. Picking an image proposal sets the sketch underlay; picking a text proposal sets the text.
- Where: `core/proposals.js` (new), mounted by the stage tabs and `core/sketch/sketch.js`.
- Size: M. Dep: B9.

**B11. Pre-created proposals.**
- Missing: at project creation and after each stage, the agent attaches proposals where they help most (scene sketches from the script, shot frames from beats, look moods).
- Where: SKILL.md workflow, the `director-session` prompt, the asks written by the stage tabs.
- Why: "the director starts by choosing, not from a blank page".
- Size: S (documentation and prompts). Dep: B9.

**B12. Docs and tests for B1-B11.**
- Missing: CLAUDE.md, SKILL.md and README sections, `mcp/test.mjs` cases, and `tools/verify.mjs` steps with screenshots.
- Size: S per item. It ships with each item, not at the end.

---

## C. Phase 7: final approvals

SPEC v3: "Once this is done, we fill other gaps and let user do the final approvements." Today stage 7 is a placeholder (screenshot `03_stage_final`: "This workspace comes in a later phase … Today: Review > Approvals, Queue and Costs").

**C1. The Final stage workspace.**
- Missing: one list of everything still draft, changes or review across all stages. That covers:
  - the lyrics version and the scenes not ok;
  - breakdown items;
  - identity and look trees, bases and variants;
  - shots;
  - draft requests;
  - open notes and asks.
  
  Each row shows its thumbnail, time, cost, why it is waiting and a jump link, with Approve / Request changes inline (page only). It is grouped by stage, with the Notes column (B3).
- Where: `tabs/final.js` (new), `js/flow.js` aggregates.
- Why: "let user do the final approvements".
- Size: M. Dep: none (B3 for its notes column).

**C2. Ready-to-render checklist.**
- Missing: computed checks, each a link:
  - every second is scripted;
  - every shot has an approved frame and a clip with a chosen take and in-point;
  - every asset a shot needs is approved;
  - the lyric gate passes (E2);
  - sync points are honoured (E1);
  - spend is within the cap and no unregistered spend remains;
  - no private path is in an export.
- Where: `js/flow.js`, `tabs/final.js`.
- Why: SPEC v3 stage 7, "a ready to render checklist".
- Size: M. Dep: C1, D6, E1, E2.

**C3. A readable Approvals sub-view.**
- Missing: today Review › Approvals is a wrap of coloured chips (`shot:s1-intro`, `use:C1@4000`, `character:ada`) with no what, why, image or time (screenshot `02_approvals`). It should be the same rows as C1, filtered.
- Where: `tabs/approvals.js`.
- Size: S. Dep: C1.

**C4. Picture lock.**
- Missing: marking a revision as **final** (director only), which freezes it until it is unlocked, and naming that revision in exports.
- Where: `tabs/final.js`, `revisions.json`.
- Size: S. Dep: B7, C1.

**C5. Render handoff from the page.**
- Missing: File › Export › **Interactive HTML package**. The helper runs `exporters/hyperframes-html/export.mjs` and then `verify.mjs --against <render>`, and shows the frame-match report. Today this exists only as a CLI and is missing from the File menu.
- Where: `core/projects.js`, `serve.mjs` (helper op), `exporters/`.
- Why: the standing requirement "interactive HTML export, 1:1 with the render".
- Size: M. Dep: E12 (the composition reads the workbench data).

---

## D. Generation pipeline

Today:
- The workbench drafts requests and estimates them.
- The **agent runs them outside**, through falgen, its own ledger and its own job books.
- Takes, identity checks and imports have no home.

**D1. The photoreal recipe as the default prompt (in progress).**
- Missing: every request form (identity, look, base, variant, edit, shot still, shot video) should be prefilled from `templates/photoreal_recipe.json` blocks (refs → identity_lock → subject_wardrobe → action → location → light → camera → texture → negatives), with each block editable and kept separately on the request.
  - A lint flags the words to leave out ("beautiful, perfect, 8k, masterpiece…").
  - The video blocks are used for I2V (motion only, 5-6 s).
- Where: `js/recipe.js`, `templates/`, `tabs/assetws.js`, `tabs/storyboard.js`, `gaps_get`.
- Why: Dani: "Put emphasis in photorealism and all that". SPEC v4 §4: "the photoreal recipe as the default prompt template".
- Size: M. Dep: A9.
- Verify: the HV1 prompt from `jobs_her_v3.json` can be rebuilt from the blocks.

**D2. Character constants.**
- Missing: a per-character list of the details that must stay identical, for example HER's "orange (#D97757) irregular starburst enamel clip above the LEFT ear + matching lapel pin, copper-tipped curls, cyan jaw/neck seam, camera-ring irises; never the Anthropic logo". It feeds the `identity_lock` block and the D7 checklist.
- Where: entity `constants[]`, stage 4 Identity tab.
- Why: the TAKES review caught "Take 1 puts the clip on her RIGHT side (wrong side)" by hand.
- Size: S. Dep: D1.

**D3. Request runner inside the workbench (falgen equivalent).**
- Missing: `tools/run.mjs` and an MCP `request_run {ids}` that:
  - runs only `approved` requests;
  - re-checks the cap at run time;
  - submits and polls the provider (fal queue: submit / status / response, a 25 min timeout);
  - writes `data/<p>/gen/<request>/<id>_<take>.<ext>` plus `job.json`;
  - is re-run safe (existing outputs are skipped) and runs up to N in parallel;
  - has a `--dry-run`;
  - records the actual cost and moves the request to done with outputs, then registers the media.
  
  The key comes from the user's environment or `.env` outside the project, and never from a project file.
- Where: `tools/run.mjs`, `generators/fal.mjs`, `lib/ops/requests.mjs`, `mcp/tools/requests.mjs`.
- Why: Dani: "nothing paid runs without an approved request". Today that holds only by discipline, because falgen does not know the queue.
- Size: L. Split it:
  - D3a: the runner core plus fal images (nb2, seedream);
  - D3b: video (h3, kling, motion control: uploads for video refs);
  - D3c: parallelism, retries, resume.
- Dep: D5, D9 (the interface), A9.

**D4. Job books, waves and pilot gates.**
- Missing:
  - a **batch** of requests that is approved at once with its total ("wave 1: 2 shots, $3.24");
  - pilot gates (2 → 4 → 8 → 10), so the next wave stays locked until the director reviews the pilot;
  - import of the existing `../project/gen/jobs_*.json` as requests (history).
- Where: `requests.json` `batch`, Review › Queue, `tools/run.mjs`.
- Why: TREATMENT §4 "a pilot of G02, G07 and G15 ($3.24) to measure the take ratio … the rest only after that". Research README: "waves with review gates (2, 4, 8, 10 shots)".
- Size: M. Dep: D3a.

**D5. One cost ledger.**
- Missing:
  - `costs.json` becomes the only ledger;
  - LEDGER.md becomes a generated view;
  - manual rows for spend outside generation (the Suno plan, ~$10, "paid by Dani directly");
  - a project-wide cap ($70 in total) plus a per-batch cap (falgen's `--cap`);
  - falgen is retired, or calls `request_update`;
  - a reconcile step against the provider's billing total (`provider_total` exists).
- Where: `lib/ops/costs.mjs`, `tabs/costs.js`, `../project/gen/falgen.py`.
- Why: "Budget for all paid generation: $70 in total". DOGFOOD #7.
- Size: M. Dep: A7.

**D6. Take selection.**
- Missing: in the page, per request or shot:
  - every take as a card with hover-scrub;
  - A/B compare;
  - **Pick take**, with an in-point and out-point drawn on a mini strip and a note ("use 0.5-1.5 s; add a code push");
  - an alternative take marked for a given time ("take 2 waves with a bigger smile, alternative for 139.84").
  
  The pick is the director's, and is saved on the storyboard shot (`clip{request, take, in_ms, out_ms, alt[]}`). Today "choose-take" and "set-in" are request kinds handed to an agent, and `shots.json` stays importer-owned.
- Where: `tabs/storyboard.js` Shot panel, `core/dock.js` compare, `js/storyboard.js`.
- Why: all of TAKES.md was done by hand. SPEC v4 §4 lists take selection.
- Size: M. Dep: D3a (outputs as takes). It works on imported outputs (D8) before that.

**D7. Identity checks.**
- Missing: when an output lands, a check against the approved identity:
  - a vision pass by the agent against the D2 constants checklist (free in a chat), writing a check note;
  - optionally a local face-embedding score (ArcFace or InsightFace in a venv; 8 GB VRAM and the disk limits apply).
  
  A badge shows on the node and take ("identity ok / drift / constant failed: clip side"). The director still decides.
- Where: `lib/ops/checks.mjs`, MCP `check_add`, node and take badges in `tabs/assetws.js` and `tabs/storyboard.js`.
- Why: PRODUCTION.md "Pilots verified: MiniMax H3 keeps Dani's likeness". TAKES.md "identity holds (face, curls, jaw/neck cyan seam, eyes)". Both were checked by eye.
- Size: M (agent and checklist path). The embedding score is +M, an option for Dani.
- Dep: D2, D6.

**D8. Import of existing images and video.**
- Missing:
  - File › Import media (drag and drop, a path, or a folder);
  - a folder import that reads falgen's `out/<id>/job.json` to recover the prompt, model, refs and cost;
  - then **use as**: identity or look node (A4), base or variant node, shot take, start frame;
  - paid outputs are retro-registered (A6).
- Where: `core/projects.js`, `tabs/media.js`, `lib/ops/media.mjs`, `mcp` `media_import`.
- Why: DOGFOOD #4 and #6. The 230 files of the first film already exist.
- Size: M. Dep: A6.

**D9. The generator plugin setting.**
- Missing: Settings › Generator, per kind (image, video, motion):
  - **fal** (default; the key stays in the user's environment);
  - **local ComfyUI** (`http://127.0.0.1:8188`, a workflow JSON per kind with slots for the prompt, refs and mask; $0 estimates);
  - **Open in another app** (exports a prompt pack: the prompt text on the clipboard, a refs folder and a README; the result comes back through D8).
  
  Interface `generators/<id>.mjs {estimate, submit, poll, fetch}`.
- Where: `generators/`, `tabs/settings.js`, `js/prices.js`.
- Why: the user's own data and machine, and the free and local routes in the research index (Qwen-Image-Edit GGUF, FLUX.2 klein).
- Size: M for the interface plus "open in another app". ComfyUI is +M.
- Dep: D3a.

---

## E. Things the first film needed that the workbench lacks

**E1. Named sync points as snap targets.**
- Missing: the shot and scene boundaries of the first film snap to **named events** (`her_hi_there`, `duet_5_both`, `spoken_found_bugs`, `break_before_every_agent`, "beat 60 (after 'eye')"), not only to beats, bars and lines. The script and storyboard `snap` menus offer lines, beats, bars and sections only.
- Also missing: **re-time after the take** (SYNC.md: "After the take is chosen: measure where each Stop actually landed … and re-time this table to it"). This means moving events and every boundary snapped to them together.
- Where: `js/scenes.js` `snapTime`, `js/storyboard.js`, `events.json` (named events with kind stop / spoken / voice).
- Size: M. Dep: none.

**E2. The lyric gate.**
- Missing: "Every sung or spoken word appears on a desktop surface at its time … A script checks it." Each word or line should carry a **surface** (shot plus where: window title, chat, dialog…), shown as a column, with uncovered words in red. The check counts toward C2.
- Where: `js/columns.js` (a `surface` column), `storyboard.json` shot `lyrics[]`.
- Size: M. Dep: none.

**E3. Chapters and build status.**
- Missing: shots grouped into chapters (`c1-*` … `c8-*`), each with a **BUILT / fallback** state and an owner agent ("Chapter 1 is built in `xp/ch1.js`; the rest renders as the fallback").
- Where: `storyboard.json` `chapters[]`, a timeline band, a storyboard strip header.
- Size: S. Dep: none.

**E4. Render etiquette and render jobs.**
- Missing: the rules ("excerpts of at most 20 s, 1 worker, 1280x720, only when >1.5 GB free RAM; the lead does the full render") are prose only. The workbench needs render requests of kind `excerpt` and `full`, a RAM check, one renderer at a time (a lock), and a contact-sheet output registered as media.
- Where: `tools/render.mjs`, Review › Queue.
- Size: M. Dep: D3 (the queue machinery).

**E5. Placeholder frames.**
- Missing: "A clip that does not exist yet must be drawn as a neutral placeholder frame with its id". The shots and clips columns and the storyboard show "no frame · draw" but no id placeholder that the composition can use.
- Where: `js/columns.js`, `js/storyboard.js`, export.
- Size: S. Dep: none.

**E6. Looks per context.**
- Missing: LOOKS_PLAN.md is a matrix of **character × context** (on screen / out of the screen / dancing). A shot's context should pick each character's look automatically, and stay overridable per shot. Today it works per scene `uses` only.
- Where: `entities` `contexts{}`, the scene and shot `context`, `js/assets.js`.
- Size: M. Dep: none.

**E7. Song versions and the Suno pipeline.**
- Missing:
  - cue tags in the lyrics (`[Stop - …]`, `[Spoken - …]`, `[Male]` / `[Female]`) kept as cues and not sung text;
  - a Suno paste export with the 5,000-character gate (style plus lyrics);
  - several **song takes** (v16, v17…) to pick from, followed by re-timing (E1).
- Where: the Lyrics stage, `lyrics.json` `cues`, `song_attach` versions.
- Size: M. Dep: E1.

**E8. Contact sheets and second opinions.**
- Missing: Claude "watches via contact sheets" (`rv_a/b/c.jpg`, `her_v3_sheet.jpg`). The workbench should make a contact sheet of the takes of a batch, or of a time range of the render, and attach it to the batch or round for review.
- Where: `tools/contact.mjs` (ffmpeg), Review › Queue.
- Size: S. Dep: D4.

**E9. A round trip with the composition.**
- Missing: the HyperFrames composition (`../project/clip/`) is imported into the workbench one way (`azemar_extract_edl.mjs`). It should **read** the workbench's picks (shot, take, in-point, look, placeholder) from an exported data file. Picking a take in the page then changes the render.
- Where: `exporters/composition-data.mjs`, the composition loader (owner side).
- Size: M. Dep: D6.

**E10. Interpretation next to verbatim answers.**
- Missing: NOTES_treatment_dani.md holds Dani's verbatim answers **and** the lead's interpretation. Intake answers and notes should have an `interpretation` field, written by the agent and marked as such.
- Where: `scenes.json` intake, B1 notes.
- Size: S. Dep: B1.

---

## F. UX gaps seen in the screenshots

**F1. Stage status is wrong on projects made before the flow.**
- Missing: the rail shows green "done" for:
  - Breakdown, while it says **"No breakdown yet … 0 items"**;
  - Script, with **"9 intake questions open"**;
  - Characters and Scenery, while every asset says **"needs a base"**.
  
  `deriveStages` treats any content as done. A derived state should read "has content (not reviewed)", which is a distinct dot.
- Where: `js/flow.js` `deriveStages`, `core/rail.js`.
- Why: "A stage is "done" when the director marks it so".
- Size: S. Dep: none.

**F2. Assets › Characters is not compact.**
- Missing: two cards share the full width with ~250 px empty gutters, and a large unlabelled grey box sits at the right (screenshot `02_characters`). It should be a packed grid, with **+ New look** visible as a card per character.
- Where: `tabs/characters.js`, `tabs/library.js`, `app.css`.
- Why: "Extremely compact: 1 px separators, no margins unless needed". "Characters visible, with "+ New look"".
- Size: S. Dep: none.

**F3. The Queue hides the approve action.**
- Missing: approving is a click on the "draft" chip, explained only by its tooltip. The queue needs:
  - an explicit **Approve** / **Reject** per row and for a selection;
  - the total of the selection;
  - ref thumbnails;
  - a prompt that is readable (today a one-row truncated textarea).
- Where: `tabs/queue.js`.
- Why: "Agents never approve" also means the director must see clearly what they approve.
- Size: S. Dep: none (D4 adds batches).

**F4. Duplicate filters in Media.**
- Missing: two "any status" selects appear, one in the page search bar and one in the bin.
- Where: `tabs/media.js`, `app.js` search bar.
- Size: S. Dep: none.

**F5. Stage workspaces leave most of the screen empty.**
- Missing: in Lyrics, Script, Breakdown, Characters, Scenery and Final, the content fills the top 10-35 % and the rest is empty. Empty states and help are long prose (Storyboard's right panel, Final). Use the space for the Notes column (B2/B3) and shorten the help to one line plus a `?`.
- Where: `tabs/*.js`, `app.css`.
- Size: S (after B3). Dep: B3.

**F6. Stage views are not on the time axis.**
- Missing: Lyrics, Script and Storyboard are lists, and the Storyboard runs time **left to right** in strips. The standing rule is "Time is vertical, and columns are synced to the millisecond on a warped axis".
- Proposal: each stage workspace becomes a column preset of the timeline plus its side tools. Script = lyrics + scenes + beats + notes. Storyboard = scenes + shots (stacked vertically, frames in a wide follow column) + notes. The card strips remain as an optional view.
- Where: `tabs/stage.js`, `js/columns.js`, `tabs/storyboard.js`.
- Size: L. This is a decision for Dani (see the end).
- Dep: B4.

**F7. The timeline wastes height and width.**
- Missing:
  - **Fit song** draws a 20 s song in the top 40 % of the viewport and leaves the rest empty;
  - at 1280 px the notes column is cut off at the right edge;
  - the preview dock, once opened, covers the notes column instead of reserving space.
  
  Fit should fill the height, and the dock should get a "docked" mode that narrows the columns.
- Where: `js/timeline.js`, `core/dock.js`.
- Size: S. Dep: none.

**F8. The stage bars are inconsistent.**
- Missing: done stages show "Reopen", others show "Mark done · In progress · Needs you". The ‹ › navigation sits at the right on the rail row. "Ask the agent" is a box at the bottom right in Lyrics and Breakdown, but buttons in the bar elsewhere. There should be one stage-bar template: status, primary actions, then Send round (B6) in the same place everywhere.
- Where: `tabs/stage.js` and each stage tab.
- Size: S. Dep: B6 for the round button.

**F9. No "Connect Claude" in Help.**
- Missing: Help has GitHub, README, Issue and About, but nothing that copies `claude mcp add workbench -- node <abs path>/mcp/server.mjs` and shows the connection state (pages open, last agent op).
- Where: `core/defaults.js`.
- Why: "MCP so any Claude Code chat can drive it; Help › GitHub".
- Size: S. Dep: none.

**F10. About says "v2".**
- Missing: `help.about` says "Director Workbench v2", `package.json` says 0.3.0, and the specs are at v4. Use one version string.
- Size: S. Dep: none.

---

## G. Hosted/static mode (WEB_SERVICE_PLAN; owner decision: the site only serves the app)

Already done:
- the local-server security prerequisite: Host and Origin checks, JSON content type, and the per-run `x-wb-token` in `serve.mjs` and `core/token.js`.

Not done:
- the static build;
- the storage layer;
- `core/ops.js`;
- the zip format;
- the npm helper;
- pairing.

**G1. v0, a hosted read-only demo.**
- Missing:
  - `tools/build-static.mjs` (an allow-list into `dist/`; the build fails on a private path);
  - a "demo, read-only" badge;
  - `version.json`;
  - About and privacy pages;
  - `_headers` with a CSP;
  - a Pages project.
- Where: `tools/`, `app.js` (a static flag), `js/store.js`.
- Why: "azemar.eu serves only the static app".
- Size: M. Dep: none.

**G2. Remove the agent self-approval escape hatch.**
- Missing: the `agent_approvals` setting (`WB_AGENT_APPROVALS=1`) lets an agent's `director_approved: true` count. Replace it with a page-confirmed approval: `approve_request` opens a dialog in the page, and only that click approves.
- Where: `lib/store.mjs`, `mcp/server.mjs`, a page dialog.
- Why: "Agents never approve; nothing paid runs without an approved request".
- Size: S. Dep: none.

**G3. Storage interface.**
- Missing: `core/storage/` with the OPFS, FSA, IDB-meta, Static and Helper backends, plus a Service Worker for `data/` URLs with Range support.
- Size: L. Dep: G4.

**G4. Split `lib/store.mjs` and make it isomorphic (do this early).**
- Missing: the store is 1,868 lines, and every feature in B, C, D and E edits it and `mcp/server.mjs` (515 lines). It should be split into per-domain modules:
  - `lib/ops/{notes,lyrics,scenes,breakdown,assets,storyboard,requests,costs,media,snapshots,proposals,rounds}.mjs` over a small fs adapter;
  - `mcp/tools/<domain>.mjs`, registered from `mcp/server.mjs`.
  
  This is also step one of the plan's `core/ops.js`.
- Where: `lib/`, `mcp/`.
- Why: parallel agents can then add features without editing the same file, and the browser mode can reuse the ops later.
- Size: M. Dep: the A batch landed (do not refactor under the dogfood loop).

**G5. Zip export and import.**
- Missing: zip export and import (private files excluded unless "personal backup" is ticked).
- Size: M. Dep: G3.

**G6. New project from a song, in the page.**
- Missing: a port of `importers/new_project.mjs` (`decodeAudioData`, peaks, energy, LRC).
- Size: M. Dep: G3.

**G7. npm helper and pairing.**
- Missing: `npx ai-videoclip-director` (the helper is `serve.mjs` plus MCP in one process), pairing tokens, Local Network Access handling and Safari guidance.
- Size: L. Dep: G2, G4.

**G8. Onboarding and i18n.**
- Missing: an onboarding screen, error states, and Catalan and Spanish for onboarding.
- Size: M. Dep: G1.

---

## Recommended order: hourly iterations

These are the lanes. Each agent owns its lane's files during an iteration, and two lanes never touch the same file in the same hour.

| Lane | Files |
|---|---|
| **S** (server and MCP) | `lib/**`, `mcp/**`, `serve.mjs` |
| **P** (stage pages) | `tabs/{lyrics,script,breakdown,assetws,storyboard,final,compare}.js`, `core/notescol.js`, `core/proposals.js` |
| **T** (timeline and shell) | `js/{timeline,columns,flow}.js`, `core/{rail,defaults,dock}.js`, `app.*`, `tabs/{characters,library,media,queue,approvals}.js` |
| **R** (generation runner) | `tools/run.mjs`, `generators/**`, `tools/contact.mjs`, `../project/gen/falgen.py` |
| **D** (docs) | `CLAUDE.md`, `README.md`, `SKILL.md` |

The lane that owns a feature also updates the docs for it.

| Hour | Lane S | Lane P | Lane T | Lane R |
|---|---|---|---|---|
| 1 | Verify A1-A12 with the loop (read-only checks plus `test:mcp`) | — | F1 stage status truth, F10 version | — |
| 2 | **G4** split store and MCP into per-domain modules (no behaviour change; all three test suites pass) | — | F2 compact Characters bin, F4 Media filters | D9 interface (`generators/fal.mjs` skeleton, no calls) |
| 3 | B1 notes model plus migration (ops) | — | F3 Queue approve and reject, F9 Connect Claude | D5 one ledger: falgen reads/writes `costs.json` via `request_update` |
| 4 | A6 retro kind, D8 import ops (`media_import`, job.json parse) | B2 Notes column in Lyrics | B4 timeline notes column typing | D3a runner core: fal images, dry-run, cap re-check |
| 5 | B6 rounds ops plus `round_get` / `round_absorb` | B3 Notes column in Script and Breakdown | B5 "+ Add" submenus (timeline, global) | D3a finish, run on the demo with a mock provider |
| 6 | B7 revisions plus `revisions.json` | B3 Notes column in assetws and Storyboard | B6 round counter plus **Send round** on the rail (F8 stage-bar template) | D3b video (h3, kling, mc uploads) |
| 7 | A4 import node and "use as identity" ops | B5 "+ Add" in each stage | F7 timeline fit and docked preview | D4 batches and pilot gates |
| 8 | D6 take ops (`clip{take,in,out,alt}`) | D6 take picker in the Shot panel | D8 Import media UI in File menu and Media | E8 contact sheets |
| 9 | C1 aggregation ops | C1 Final workspace, C3 Approvals rows | E3 chapters band, E5 placeholders | D3c parallel, retries, resume |
| 10 | B9 proposals ops plus the SVG sanitiser plus security tests | B8a Compare: text stages | E1 named sync points plus re-time | D1 verify recipe forms end to end (with the loop's js/recipe.js) |
| 11 | D7 checks ops plus `check_add`, D2 constants | B10 proposals strip | E2 lyric gate column | E4 render jobs and RAM lock |
| 12 | G2 page-confirmed approvals | B8b/B8c Compare: timeline and images | C2 ready-to-render checklist | D9 "open in another app" pack |
| 13+ | G1 static build, then G3/G5/G6/G7 | B11 pre-created proposals (prompts), E7 Suno cues | F6 vertical stage views (if Dani says yes), E6 looks per context | D9 ComfyUI, E9 composition data export |

Rules for the loop:
- Run `npm run verify`, `test:mcp` and `test:security` at the end of every hour. The lead runs `verify` once per hour, because it uses fixed ports.
- Take screenshots of every new view and read them.
- A feature is not done until its MCP tool, its docs and its verify step exist.

---

## Decisions for Dani

1. **Who presses "run".**
   - Option 1: approved requests run only from an agent (the runner is a CLI/MCP tool, and the page never calls a paid API, as today).
   - Option 2: the page also gets a **Run approved** button that asks the local helper to run them.
   
   Either way, nothing unapproved runs.
2. **Stage views on the time axis (F6).** Should the Lyrics, Script and Storyboard workspaces become vertical, warped column presets ("time is vertical")? Or should they stay lists and card strips, with the timeline as the synced view? This is about a day of work.
3. **Identity checks (D7).** Is the agent's visual check against a constants checklist enough (free)? Or should a local face-embedding model be installed in a venv (about 300 MB, with the disk being tight)?
4. **Legacy characters (A4).** May the director promote existing approved images (her_full_green, the HV looks) straight into the identity and look trees, without a paid regeneration?
5. **falgen.** Retire it in favour of the workbench runner once D3a lands, or keep it as a thin client that writes through `request_update`?
6. **One cap.** Is it $70 in total including the Suno plan (~$10), as LEDGER.md counts it, with per-batch caps under it?
7. **The git mirror for revisions (B7).** Opt-in (proposed), or on whenever git is installed?
8. **Self-approval escape hatch (G2).** Remove `agent_approvals` completely?
9. **The hosted address.** `director.azemar.eu` (the plan's proposal), or a path on azemar.eu?

## Provisional decisions (lead, 2026-10-05; Dani was away; he may override any)
- Approved requests run from **both** a page "Run approved" button and an agent: same runner, cap and ledger.
- Stage views get an optional **time-aligned toggle** (list stays the default).
- **Remove `agent_approvals`** entirely: approvals are always the director's.
- Existing approved images can be **promoted without regeneration** (page only).
- The revision git mirror is **opt-in**. falgen is retired only once the in-app runner reaches parity.
- Budget: the cap stays as configured; whether $70 includes Suno is still open (ask Dani).
- Identity checks: the agent's visual checklist first; a local face model only if Dani wants it.
- Hosting at director.azemar.eu: later (group G), on Dani's go.

## Progress log
- 2026-10-05: done: A1–A12 (dogfood her v3), DOGFOOD_looks 1–15 (13 deferred), F1, F3, G4, B1–B5, B6–B8, D1, D3a, D9 (fal + open-with; ComfyUI stub), D5 partial (merged ledger, per-take cost).
- In progress: B9–B10 (proposals), C1–C3 (final approvals).
- Next: review pass (spec + security), D3b (video), D6 (take selection), D8 (import media UI), D4 (waves / pilot gates), time-aligned stage toggle, G (hosted mode, on Dani's go).
