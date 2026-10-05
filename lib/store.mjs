// Node-side data layer shared by serve.mjs (HTTP API) and mcp/server.mjs (MCP tools, offline fallback).
// Every function works on the project folders in DATA_ROOT (default workbench/data/, env WORKBENCH_DATA) and writes
// with temp file + rename. Nothing here talks to the network or to a paid API, except the request runner (lib/run.mjs).
//
// Configuration (all optional): workbench.config.json next to serve.mjs (local, gitignored; see
// workbench.config.example.json) and environment variables, which win:
//   WORKBENCH_DATA        project folders                         (config data_dir, default ./data)
//   WB_PROJECT            default project                         (config default_project, default "demo")
//   WORKBENCH_MEDIA_BASE  folder that base-relative media live in (config media_base, default the workbench's parent)
//   config media_roots    path prefixes under media_base served read-only at /media/<path> (default none)
//   config private_media  extra regex (string) of PRIVATE paths: local only, never exported
//   (approvals are always the director's, in the page: there is no switch for agent approvals; see README "Security model")
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
//   proposals.mjs   proposals: sets of free choices (SVG made with code, or text) on a target; the director picks (page only)
//   takes.mjs       take selection: the takes of a shot / request, the agent's take proposals; the pick (page only)
//   surfaces.mjs    E2 the lyric gate: where each lyric word appears on screen (shot.lyrics), the agent's proposals; accept (page only)
//   media.mjs       D8: importing existing images and video (scan a media-root folder + its job.json, register in place,
//                   page uploads, "use as" a node / a shot's take / start frame)
//   batches.mjs     D4: batches (waves) of requests with review gates, the plan of waves from the gaps, the job-book import
//   checks.mjs      D7: identity checks (check_add / checks_get; the "identity check" ask when outputs land: _hooks.mjs)
//   events.mjs      E1: named sync points (events.json), anchors of scene / shot boundaries, the re-time after the take
//   composition.mjs E9: composition_export (the picks as exports/<file>.json for a HyperFrames composition), composition_get
//   renders.mjs     E4 render jobs (requests of kind render, started only by the director's click; one at a time, RAM floor,
//                   chapters first) and E8 contact sheets (lib/contact.mjs) with the agent's second opinion
//   songs.mjs       E7 song versions (song.json versions[], the re-align preview, switching is the director's) and the Suno brief
// and lib/run.mjs: the request runner (D3a; request_run in requests.mjs), the only part that calls a paid API, through
// generators/<id>.mjs, and only for requests the director approved
// Each domain module adds its ops to `ops` when it is loaded; importing them all here registers every op, so every
// importer (serve.mjs, mcp/server.mjs, tools/, importers/, exporters/) keeps using lib/store.mjs with the same names.
import './ops/notes.mjs';
import './ops/rounds.mjs';
import './ops/proposals.mjs';
import './ops/takes.mjs';
import './ops/surfaces.mjs';
import './ops/final.mjs';   // stage 7: final_get, Lock for render (final_lock / final_unlock, page only), lockGate
import './ops/media.mjs';   // D8: import existing images / video (media_scan, media_import; media_upload / media_use page only)
import './ops/batches.mjs'; // D4: job books, waves and pilot gates (batches_get, waves_plan; batch_act / the job-book import page only)
import './ops/checks.mjs';  // D7: identity checks (check_add, checks_get; never an approval or a pick)
import './ops/composition.mjs'; // E9: composition_export / composition_get (the picks as edl.json; writes only the export file)
import './ops/events.mjs';      // E1: named sync points (events_get, event_add, retime_propose; events_act / retime_apply / retime_undo page only)
import './ops/interpret.mjs';   // E10: the agent's interpretation of intake answers and notes (interpretation_set; interpretation_act page only)
import './ops/renders.mjs';     // E4 / E8: render jobs (render_propose; render_config / render_start / render_cancel page only), contact sheets, second opinions
import './ops/projectio.mjs';   // G5 / G6: project_export / project_import (zip), project_upload (page only), createFromSong
import './ops/songs.mjs';       // E7: song versions (song_version_add / _plan; song_version_use / song_upload page only), the Suno brief
export { WB_DIR, WbError, readJSON, writeJSON, writeAtomic, walk, inside, loadConfig, CFG, DATA_ROOT, isPrivate, normRel, isMediaRootPath, cleanRel, relTo, mediaRootFile,
  resolveMedia, flaggedPrivate, isFlaggedPrivate, projectIds, agentArgs, WRITABLE, validId, projDir, read, write, mutate, ms, tc, makeThumbs, REQUEST_STATUSES, approvalOk, privateUploadOk, RUNNABLE, withFileLock, appendCost, ops } from './ops/_shared.mjs';
export { codeState, codeDiff, listProjects, createProject, duplicateProject, deleteProject, snapshot, listSnapshots, restore, scrubPrivate } from './ops/core.mjs';
export { loadRecipe, falgenSource, costSummary, requestAuthor } from './ops/requests.mjs';
export { projectFacts, lyricsDoc, syncLyrics, afterPageSave, createGuidedProject } from './ops/lyrics.mjs';
export { scenesDoc } from './ops/scenes.mjs';
export { breakdownDoc } from './ops/breakdown.mjs';
export { refFile, refPrivate, canonRef, canonRefs } from './ops/assets.mjs';
export { boardDoc } from './ops/storyboard.mjs';
export { notesDoc, notesCounts, legacyStores } from './ops/notes.mjs';
// the request runner (talks to the generators: the network): its progress events, forwarded by serve.mjs to the pages
export { runEvents, generatorsInfo } from './run.mjs';
export { revDoc } from './ops/rounds.mjs';
export { proposalsDoc } from './ops/proposals.mjs';
export { takesDoc } from './ops/takes.mjs';
export { surfacesDoc } from './ops/surfaces.mjs';
export { eventsDoc } from './ops/events.mjs';
export { rendersDoc, lockInfo as renderLock } from './ops/renders.mjs';
export { sanitizeSvg, SvgError } from './svg-sanitize.mjs';
export { lockGate, lockedOf, finalOf } from './ops/final.mjs';
export { sniff, shotMediaLinks, linkShotMedia, UPLOAD_MAX } from './ops/media.mjs';
export { checksDoc, askIdentityCheck } from './ops/checks.mjs';
export { createFromSong, exportPlan, inspectZip, badName, demote, FORMAT as ZIP_FORMAT, MANIFEST as ZIP_MANIFEST } from './ops/projectio.mjs';
export { landed, batchLanded } from './ops/_hooks.mjs';
