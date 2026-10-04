# Director Workbench v2 spec (lead, 2026-10-04)

Dani on v1 (verbatim): "think of commands, all commands available and that are typical in a UI like this. Think about
ctrl+scroll for expanding x axis, or y axis, etc. Also all the things that can appear when right-clicking, menus,
submenus, etc. So it is all customizable and easy to use. / Also, if the video or preview or anything else is
created, it should appear in bottom right if user wants to. We have here many things created isn't it? can't they be
incorporated seamlessly? / Also, the characterization.. i don't see the "faces" nor bodies nor else. Also, it is hard
for me to see the "create a new costume" for a character, etc. How could we incorporate that in? / We should have
also the typical options of "Menu -> File save, duplicate, etc" so i can create a new "project" out of this one and go
back to whichever point, etc."

Standing rules from v1: extremely compact (1 px separators, no margins unless needed, columns down to 3 px), time runs
top to bottom, all columns synced to the ms, top bar hideable, tabs as registry modules, files shared with the agent.

## Part A: command system, input, menus, projects (core)
1. **Command registry** (`core/commands.js`): every action is a named command {id, title, group, keys, when, run}.
   Everything else (menus, palette, context menus, toolbar) is built from it. Ctrl+K / Ctrl+Shift+P opens a fuzzy
   **command palette** showing keys next to each command.
2. **Keybindings**: defaults typical of NLEs/DAWs and editors, all rebindable in Settings (stored in
   `data/<project>/settings.json`, conflicts flagged). At least: Space play/pause; J/K/L shuttle; Left/Right step a
   beat (Shift = bar, Alt = frame/10 ms); Up/Down previous/next lyric line; Home/End; [ and ] previous/next section;
   I/O set loop in/out, Shift+L toggle loop; M add a marker/note at the playhead; N new note; A approve selection,
   R request changes; Ctrl+Z / Ctrl+Shift+Z undo/redo (for every edit in the page); Ctrl+S save snapshot; Ctrl+Shift+S
   save project as; Ctrl+D duplicate (shot/scene/costume); Delete; Ctrl+F find (lyrics, script, notes, ids); F2 rename;
   1-9 jump to tabs; ` or Esc hide top bar; H hide focused column, Shift+H show all; Ctrl+0 fit song to window; Ctrl+1
   100 %; T toggle linear/warped time; P toggle preview dock; ? shows a cheat sheet overlay.
3. **Mouse and wheel**: wheel = scroll time; Ctrl+wheel = zoom TIME axis (vertical, centred on the cursor's time, warp
   preserved); Shift+wheel = horizontal scroll when columns overflow; Ctrl+Shift+wheel or Alt+wheel over a column =
   widen/narrow that column; pinch on touchpads = time zoom; middle-drag = pan; drag on the ruler = select a time
   range; Shift+click extends a selection; double-click a column header = auto-fit width; double-click a separator =
   reset width; drag a header = reorder columns.
4. **Context menus** (right-click, with submenus, keyboard navigable, built from the registry with `when` contexts):
   on the ruler/timeline (add marker, set loop from here, select section, zoom to section, copy time code), a lyric
   word/line (play from here, loop line, add note, edit timing, copy text), a section (rename, colour, loop, collapse,
   duplicate as variant), a shot/clip cell (preview, show in Clips, choose take > submenu of takes, set in-point,
   approve / request changes, regenerate (queues a request), duplicate, open file location, copy id), a cast chip
   (open character, swap costume > submenu), a column header (hide, collapse to strip, width presets, move left/right,
   column settings, reset), an entity card (open, duplicate, new costume / variant, request generation, archive),
   empty space (paste, add note, show hidden columns > submenu). All menus extensible from tab modules.
5. **Menu bar** (in the hideable top bar, left of the tabs, compact): File, Edit, View, Timeline, Generate, Window, Help.
   File: New project (empty), New from template, Open (list of projects), Save snapshot (Ctrl+S, with a message),
   Save project as / Duplicate project (copies `data/<project>/` to a new name), Revert to snapshot (history list with
   dates and messages: restore = becomes the current state, previous state kept), Import (song/stems/lyrics/images),
   Export (JSON bundle, shot list CSV, PDF-ready storyboard page), Recent projects, Project settings.
   Projects live in `workbench/data/<project>/`; snapshots in `workbench/data/<project>/.snapshots/<timestamp>-<slug>/`
   (only the small JSON files; media are referenced, not copied). The server provides list/create/duplicate/snapshot/
   restore endpoints. Undo history is per session; snapshots are durable.
6. **Generation requests**: the page never calls paid APIs. "Regenerate", "New costume", "Request generation" write
   an entry to `data/<project>/requests.json` {id, kind, target, prompt draft, refs, est_cost, status:
   draft|approved|queued|running|done|rejected}; an Approvals/Queue view shows them; only approved ones are picked up
   by the agent, which writes results back (status done + output paths). Cost cap shown.

## Part B: media everywhere, preview dock, characterization
7. **Preview dock** (bottom-right, toggle P, resizable, draggable to any corner, can pop out to its own window,
   remembers size): shows whatever is relevant: the rendered film synced to the playhead (default), or the hovered or
   selected clip, image, start frame, take comparison (side by side), stems player, or a character sheet. Pin to keep a
   source. All generated media (renders, clips with all takes, start images, motion clips, character sheets, avatars,
   dancer sprites, contact sheets, mixes) are indexed into `data/<project>/media.json` by the importer and appear in a
   **Media** tab (grid, filters by kind/entity/status, hover scrub for videos) and in context menus.
8. **Characters tab redesign**: each character is a card with a large face (best frontal), full-body image, and a
   strip of turnaround / head angles / expressions; click opens a character page: identity sheet, all LOOKS
   (costumes) as cards (each: full-body image, garment list, where used on the timeline, status, cost), a big
   "+ New look" card that opens a small form (name, garments, colours, reference images by drag-drop or picking from
   Media, notes) and creates a draft generation request with a cost estimate; also "Duplicate look", "Variant of",
   expressions, motion clips (dances) and avatars. HER and the 7 avatars are characters too. Same pattern for
   Locations (establishing images, angles, time-of-day variants, "+ New angle / time of day") and Props (hero image,
   "+ New variant").
9. Import the existing azemar.exe media for this: `character-lab/outputs/a_basics/` (Dani's identity sheets; his picks
   in `character-lab/base/PICKS.md`), `character-lab/outputs/b_variations/`, `project/gen/refs/` (identity refs:
   PRIVATE, crops of real photos; show them only in the local page, mark them private), `project/gen/out/` (start
   images I*, avatars A*, clips G*, motion D*/H*, HER H0/H0s), `project/clip/assets/dancers/`, `project/clip/renders/`.
