// Node-side data layer shared by serve.mjs (HTTP API) and mcp/server.mjs (MCP tools, offline fallback).
// Every function works on the project folders in DATA_ROOT (default workbench/data/, env WORKBENCH_DATA) and writes
// with temp file + rename. Nothing here talks to the network or to a paid API.
//
// Configuration (all optional): workbench.config.json next to serve.mjs (local, gitignored; see
// workbench.config.example.json) and environment variables, which win:
//   WORKBENCH_DATA        project folders                         (config data_dir, default ./data)
//   WB_PROJECT            default project                         (config default_project, default "demo")
//   WORKBENCH_MEDIA_BASE  folder that base-relative media live in (config media_base, default the workbench's parent)
//   config media_roots    path prefixes under media_base served read-only at /media/<path> (default none)
//   config private_media  extra regex (string) of PRIVATE paths: local only, never exported
//   config agent_approvals / WB_AGENT_APPROVALS=1   let an agent's director_approved:true approve (default: only the
//                         page approves; see README "Security model")
//
// This file only puts the data layer together; the code lives in lib/ops/ (CLAUDE.md "Layout"):
//   _shared.mjs     files, configuration, media paths + the PRIVATE rule, project folders, time helpers, thumbnails,
//                   the director gates, and the `ops` object
//   core.mjs        code version, projects, snapshots, song / timeline, media index, scrubPrivate
//   requests.mjs    the recipe file, the generation queue, approvals, costs (+ falgen)
//   notes.mjs       notes: one model for every stage and the timeline (notes.json v2, migrated from the old stores)
//   lyrics.mjs      the guided flow (stages) and stage 1 (lyrics, song_attach, guided projects)
//   scenes.mjs      stage 2: the script (scenes, intake) and sketches
//   breakdown.mjs   stage 3: the breakdown
//   assets.mjs      stages 4 and 5: entities and the asset workspace (characters, locations, props)
//   storyboard.mjs  stage 6: the storyboard, the gaps, and the shots.json shots / clip uses
//   rounds.mjs      review rounds (send / get / absorb / reply / finish) and revisions R<n> (close / restore / compare)
// Each domain module adds its ops to `ops` when it is loaded; importing them all here registers every op, so every
// importer (serve.mjs, mcp/server.mjs, tools/, importers/, exporters/) keeps using lib/store.mjs with the same names.
import './ops/notes.mjs';
import './ops/rounds.mjs';
export { WB_DIR, WbError, readJSON, writeJSON, writeAtomic, walk, inside, loadConfig, CFG, DATA_ROOT, isPrivate, isMediaRootPath, cleanRel, relTo, mediaRootFile,
  resolveMedia, flaggedPrivate, isFlaggedPrivate, projectIds, WRITABLE, validId, projDir, read, write, mutate, ms, tc, makeThumbs, REQUEST_STATUSES, approvalOk, ops } from './ops/_shared.mjs';
export { codeState, codeDiff, listProjects, createProject, duplicateProject, deleteProject, snapshot, listSnapshots, restore, scrubPrivate } from './ops/core.mjs';
export { loadRecipe, falgenSource, costSummary } from './ops/requests.mjs';
export { projectFacts, lyricsDoc, syncLyrics, afterPageSave, createGuidedProject } from './ops/lyrics.mjs';
export { scenesDoc } from './ops/scenes.mjs';
export { breakdownDoc } from './ops/breakdown.mjs';
export { refFile } from './ops/assets.mjs';
export { boardDoc } from './ops/storyboard.mjs';
export { notesDoc, notesCounts, legacyStores } from './ops/notes.mjs';
export { revDoc } from './ops/rounds.mjs';
