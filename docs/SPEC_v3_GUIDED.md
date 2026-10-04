# SPEC v3: the guided creation flow (lead, 2026-10-04)

Dani, verbatim: "I think the initial thing we need to do is to guide the user towards the creation of its piece. When a
new project is created, what it needs is a lyric, so we must prepare the UI for each step. Lyric only for example,
where user will be able to add notes on the poem or so and keep iterating on it. It can be done either here in this
chat, or in the UI. Then, we continue with the script borrador, we need to create or simulate a script before
pointing out characters. We ask a few questions or ask for notes to the user, and then we fill the remaining gaps.
Thinking about beats, etc, so every scene is scripted. From here, we extract the necessary assets, starting from
characters, so we start with the characterization, and each character will be generated via online references
already (find free templates) or the user will describe and start modelling them with friend faces or whatever they
want. This step is iterative so user can request to add 'necklaces' or pins or more messy hair etc. Then, for each
character, user can create different 'clothings', so this is iterative and can take a while. Same with scenery assets
etc. Actually, at this point, i was imagining that our UI required of a paint-in-browser tool so user can 'describe'
the characters by drawing and text at the same time, and when adding necklaces and stuff, we could use this tool as
well. This also happens with scenery. And actually, with the script, it is also a text + image description, related
to each timestamp of the song. Once this is done, we fill other gaps and let user do the final approvements."

Standing rules (unchanged): extremely compact UI (1 px separators, no margins unless needed), vertical time-synced
timeline, everything is a command (palette, keys, context menus), files shared with agents via the MCP server, the
director approves in the page (agents cannot approve), nothing paid runs without an approved request, data stays on
the user's side, security model in README must keep holding (tests: `npm run verify`, `test:mcp`, `test:security`).

## The flow: seven stages, one rail
A thin **stage rail** (one 18 px row under the top bar, hideable with the bar) shows the stages with a status dot each
(empty / in progress / needs you / done) and what is blocking the next one. Clicking a stage opens its workspace.
Every stage can be worked from the page OR from a Claude Code chat through MCP tools; both edit the same files and the
page updates live. A stage is "done" when the director marks it so (page only); later stages can be opened early.

1. **Song & lyrics**: new project wizard (name, song file optional at first, lyrics text). Lyrics workspace: the poem
   as editable lines with section tags; **notes pinned to a line or a word range** (director and agent notes, threads,
   resolve); **versions** (every save of the poem is a version; side-by-side diff of two versions; restore); an
   "ask the agent" box that writes a request note the agent picks up (`lyrics_*` tools). When a song file is added,
   lines get timings (existing importer/aligner path) and the timeline shows them.
2. **Script draft (borrador)**: an **intake**: a short list of questions (genre/mood, story vs performance vs concept,
   who appears, where, era/look, references, must-haves, must-nots, budget/cap) answered in the page or in chat; then
   the agent drafts **scenes**, each bound to a song time range (snap to sections/lines/bars) with: beats (timed
   actions inside the scene), text description, and **sketches** (drawn in the sketch tool) as the visual intent.
   Director notes per scene; versions; "fill the gaps" asks the agent to script any unscripted time ranges so every
   second of the song is covered. The timeline gets a Scenes column (and beats inside).
3. **Breakdown**: the agent extracts from the script the characters, locations, props, wardrobe and FX, each linked
   back to the scenes/beats that need them; the director merges/renames/drops; nothing is generated yet.
4. **Characters** (first asset kind): for each character a workspace with
   - **base**: start from (a) a free template library (body/pose/face-angle bases with clear free licences, found
     online, stored as a static catalogue), (b) a description, (c) the user's own reference photos (friends, self)
     marked private, or (d) a sketch; the agent turns it into an identity sheet through an approved request;
   - **iterations**: a tree of versions; each iteration = base image + an edit instruction made of **text + a sketch
     drawn over the image + an optional mask** ("add a necklace here", "messier hair", "a pin on the lapel");
     request -> approve -> generate -> compare side by side -> keep/branch/revert;
   - **looks (clothing)**: per character, each look its own iteration tree starting from the approved identity.
5. **Locations / scenery** and **props**: the same workspace pattern (base from templates/description/photos/sketch,
   iterations with sketch + text, variants: angles, time of day).
6. **Storyboard & gaps**: shots per scene (from beats), each with a frame sketch and text; the agent proposes the
   remaining shots, generation requests, clips; the existing timeline/columns show it all.
7. **Final approvals**: one review page listing everything still draft/changes/review across stages, with costs,
   approve/request changes, and a "ready to render" checklist.

## Shared components
- **Sketch tool** (`core/sketch/`): an in-browser paint surface, vanilla JS, no framework, compact. Layers: an
  underlay image (reference or generated still, optional), a sketch layer (pen, brush sizes, eraser, line, rectangle,
  ellipse, arrow, fill, colour picker incl. a small palette, opacity), a **mask** layer (for edit regions), and
  **text pins** (numbered callouts anchored to points, each with a note: "necklace, silver, thin"). Undo/redo,
  zoom/pan, pressure (pointer events), keyboard shortcuts, copy/paste of the whole sketch to another
  scene/character ("copy from scene to scene"). Saved as `sketches/<id>.json` (vector strokes + pins + metadata) plus a
  flattened `<id>.png` and `<id>.mask.png` that agents and image models can use. Opens inline (in a stage workspace)
  or as a floating window; usable anywhere an item can carry a visual description.
- **Notes & versions** already exist for some files; extend them generically (lyrics lines, scenes, entities, looks).
- **MCP tools** for every stage (lyrics, intake, scenes/beats, breakdown, iterations, sketches as image paths + pins),
  documented in CLAUDE.md and the skill, so a chat can drive the same flow.

## Process
Iterative: build -> test live (headless Chromium screenshots of every stage and interaction, read by the agent, plus
scripted interactions and the existing suites) -> review against this spec and Dani's words -> fix. The lead reviews
screenshots after every phase and opens the result in Dani's browser at the end.
