# SPEC v5: live script, centred lyrics, character studio, assets as references (lead, 2026-10-06)

Dani reviewed the workbench and asked for the following. Verbatim points are summarised; the interpretation is the
lead's and is what the agents build. Standing rules still hold: extremely compact, minimum text, everything a command,
agents never approve, nothing paid without approval, S9 (page Origin + Sec-Fetch-Site for page acts), data stays local.

## G. Global: drop the third bar
"The third menu is unnecessary since it can be done via right click on the tab itself" (the stage bar: "1 · Lyrics ·
ready to mark done · Mark done · Needs you · …").
- Remove `core/stagebar.js` from view. Every action it had (status, Mark done, In progress, Needs you, Send round,
  Ask the agent, Lock, List/Time, versions, compare, help) moves to: **right-click on the stage tab** in the rail (a
  context menu with the same commands, status shown in the menu header), the command palette, and keys.
- The rail tab itself carries the status dot + open-notes count + a tooltip with blockers (already there).
- Text that doesn't fit is **compacted to its first words with an ellipsis** everywhere (one CSS/utility, full text in
  a tooltip): script lines, scene texts, item names, notes.

## 1. Lyrics: a centred poem with margin notes
- The poem sits **in the middle** of the workspace, like a page. Alignment toggle **left / centre / right** (remembered).
- Notes are **not a grid column**: the whole area to the right of a line is clickable; click anywhere there and type
  a note in place, anchored to that line (or to the selected words). Notes show as compact margin annotations next to
  their line, stacked when several. Left margin stays clean. Same notes model (notes.json v2), same rounds.

## 2. Script = the lyrics annotated + live drawings (the heart of the tool)
- The script stage shows the lyrics (centred, as in 1) with the director's margin notes ("dawn, she wakes, blue
  light", colours, moods). **To the right, live**, every line or section gets **3–4 drawing proposals** as soon as a
  note is committed:
  - instantly from the free local SVG generator (composition, framing, silhouettes, the colours named in the note);
  - refined by a connected Claude (SVG made with code) — a **live mode**: a Claude Code chat running the
    `director-live` loop (`wait_for` on notes → `proposals_add`), documented in the skill and offered in
    Help › Connect Claude;
  - and, when a qwen-image server is reachable, **image proposals** from Qwen-Image-2.1 (fast turbo, 3–4 variants).
- The director **picks** one (or none). Any proposal can be **maximised** and **drawn on** (sketch tool, mask, pins);
  the drawing + notes + colours are saved together as the line's visual reference.
- Scenes are still there underneath (time ranges, beats) but come from the annotated lyrics: committing notes on a
  span proposes/extends a scene. Everything is stored so a later agent can analyse it holistically
  (`script_get` returns lyrics + notes + picks + drawings + extracted assets per time range).

## 3. Character studio (qwen-powered, Photoshop-like, live)
- The character view **centres on the character, large** (the current identity/look image fills the stage), with a
  slim tool rail and a small request box. Minimal text.
- Tools: **pose** (a skeleton you drag; sent as a pose reference/control), **rotate / angle** (multi-angle LoRA via
  qwen), **draw + mask** then edit, **multiple reference images** (drop several to combine), plus free text in the
  request box. Each change is **sent live** (debounced) to the qwen server and returns 1 image or **3–4 proposals**
  if the director asks; pick → becomes a node in the tree (existing iteration tree, A/B).
- Backend: `generators/qwen.mjs` talks to the Qwen-Image-2.1 local studio HTTP API
  (`local-gen/qwen-image21/web/app.py`, default `http://127.0.0.1:7860`, configurable to any reachable machine).
  Local generation is $0; results are registered media. When no qwen server is reachable the tools still work and the
  request goes to the normal Queue (fal / open-with) instead.

## 4. Characters: identity + clothes, styles, minimum text
- Each character = identity + **outfits**. The agent can create the identity and outfits; the director chooses
  **style chips** (techno, modern, classic, street, formal, sport, vintage, custom) which seed the outfit prompt.
- UI: thumbnails, chips, one request box. No paragraphs. Script/scene text compacted to first words.

## 5. Assets are references, not steps; 0. Aesthetics; the script drives extraction
- New stage **0 · Look** (overall aesthetics of the video): palette, references, era, camera language, mood words,
  a few picked images. Every generation and proposal reads it.
- **Characters, Scenery and Props leave the numbered rail.** They live in a **right-most Assets pane** (collapsible,
  always available) and keep their full views via the Assets page. From the pane the director drags/references an
  asset into a script line or scene (an `@` mention in a note does the same).
- **Live extraction:** when the director commits script notes, an extractor (local heuristic immediately + the
  connected agent) finds new characters / places / props and creates **placeholders** in the Assets pane (status
  draft, linked to the lines). A second step (agent) gives each placeholder a default identity/look consistent with
  0 · Look. The director can change anything. The breakdown matrix becomes a view inside the Assets pane, not a stage.
- New rail: **0 Look · 1 Lyrics · 2 Script · 3 Storyboard · 4 Final** (+ the Assets pane). Old projects map their
  stage statuses onto it; nothing is lost.

## Hardware note (qwen)
The qwen-image-2.1 studio expects an RTX 50xx with 16 GB VRAM, 32 GB RAM and ~50 GB disk (35 GB weights). Dani's
laptop: RTX 4070 Laptop 8 GB, 16 GB RAM, ~24 GB free. So the workbench treats qwen as a **network generator** (same PC
when possible, a friend's PC or a rented GPU otherwise) and never assumes it runs locally. Weights are not downloaded
without Dani's go. See `docs/QWEN_INTEGRATION.md`.
