// MCP tools: the shots.json shots / clip uses and stage 6: the storyboard and the gaps (lib/ops/storyboard.mjs).
// Registered on the shared server object when mcp/server.mjs imports this file.
import { z } from 'zod';
import { mcp, op, wrap, project, time, by } from './_shared.mjs';

// ------------------------------------------------------------------ shots
mcp.registerTool('shots_list', {
  title: 'List shots', description: 'Storyboard shots in time order: {id, t0, t1, time, section, kind (screen/split/world), title, cast[], locations[], clips[clip use ids], state}. Filter by section, approval state or a time range.',
  inputSchema: { project, section: z.string().optional(), state: z.enum(['draft', 'review', 'changes', 'approved', 'locked']).optional(), t0: time.optional(), t1: time.optional() },
}, wrap((a) => op('shots_list', a)));
mcp.registerTool('shot_get', {
  title: 'Get a shot or clip use', description: 'One shot (id like "c1-desk") or clip use (id like "G05@20158"): all fields, approval record, its clip uses with every available take, notes on it or inside its time, requests targeting it, and the media linked to it.',
  inputSchema: { project, id: z.string() },
}, wrap((a) => op('shot_get', a)));
mcp.registerTool('shot_update', {
  title: 'Update a shot or clip use',
  description: 'Change a shot / clip use. status -> approvals ("review" to ask the director to look; "approved"/"locked" only the director sets, in the page (you: 403); "changes" only on their word or your review finding). note -> a note pinned at its start. title -> the shot title. take / in_ms / file -> which take of a clip use plays and from where (clip uses only; the take\'s file is found in the media index). Timing edits beyond that belong in a request. Returns what changed.',
  inputSchema: { project, id: z.string().describe('Shot id or clip use id.'), status: z.enum(['draft', 'review', 'changes', 'approved', 'locked']).optional(), comment: z.string().optional().describe('Stored with the status.'),
    take: z.number().int().min(0).optional(), in_ms: time.optional().describe('In-point inside the clip file.'), file: z.string().optional(), title: z.string().optional(), note: z.string().optional(), by },
}, wrap((a) => op('shot_update', a)));

// ------------------------------------------------------------------ stage 6: the storyboard (shots per scene) and the gaps
const shotId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/).describe('Shot id (sh03; older shots.json ids like s2-wall stay).');
const entIds = z.array(z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/));
const shot = z.object({ id: shotId.optional().describe('Leave out for a new shot.'), scene: z.string().nullable().optional().describe('The scene it belongs to (script_get); a new shot without one goes to the scene at its middle.'),
  t0: time.optional(), t1: time.optional(), kind: z.string().optional().describe('wide, medium, close, insert, performance, xp-desktop (or another short lower-case word).'),
  title: z.string().optional(), text: z.string().optional().describe('The action: what we see.'), camera: z.string().optional().describe('Camera / motion: slow push in, handheld, locked-off…'),
  sketch: z.string().nullable().optional().describe('The frame sketch id (sketch_save, links {shots: [id]}).'), beats: z.array(z.string()).optional().describe('The scene beat ids this shot covers.'),
  cast: entIds.optional(), locations: entIds.optional(), props: entIds.optional(),
  variants: z.record(z.string().nullable()).optional().describe('{<entity id>: <variant / look id> | null (the root)}: only where the shot differs from the scene\'s pick.'),
  gen: z.enum(['still', 'video']).nullable().optional().describe('What it needs generated (default from the kind).'), clips: z.array(z.string()).optional(),
  context: z.string().nullable().optional().describe('E6: the shot\'s WORLD when it differs from its scene\'s ("dancing"): its cast wear their look for that world; a cast character without one shows as a gap (gaps_get looks, Final). null = the scene\'s.'),
  anchors: z.object({ t0: z.string().optional(), t1: z.string().optional() }).optional().describe('E1: tie a cut to a named event (events_get ids): {t1: "duet_5_both"}; it takes the time of the event and follows it when the director re-times after the take') }).passthrough();
mcp.registerTool('storyboard_get', {
  title: 'Get the storyboard (stage 6)',
  description: 'Also chapters (E3: each with its DERIVED build status planned / generating / built / approved, picked / approved / placeholders), worlds and looks_by_world (E6: the world of a shot dresses its cast in the look tagged with it; `world` on scenes and shots, asset `source: world`, `mismatch`), and per shot `placeholder` when it has no frame or take (E5). The storyboard: the script\'s scenes in song time [{id, time, title, text, status, beats [{id, t, text}], needs (the cast / locations / props the breakdown links to the scene, with the variant the scene uses), shots}], each shot {id, scene, t0, t1, time, bars, kind, title, text, camera, beats, cast, locations, props, variants (per-shot overrides), gen still/video, clips, status (approvals: draft/review/changes/approved/locked), frame {sketch, png, file (absolute), pins} or {thumb}, assets [{type, id, name, variant, variant_name, source scene/shot/director/agent/default, approved, image, file, why}], requests (target shot:<id>), estimate}; outside_script (shots whose scene is gone); the beat grid; gaps (counts + estimate; gaps_get has the rows); notes (default open); asks_for_agent (kind storyboard = propose shots, fill_gaps = draft requests); versions. A project without storyboard.json reads its shots from shots.json (v1, derived). version = an older one; diff = [a, b] -> word diff + shots added / removed / changed; scene filters.',
  inputSchema: { project, version: z.string().optional(), diff: z.array(z.string()).length(2).optional(), scene: z.string().optional(), notes: z.enum(['open', 'resolved', 'all']).optional() },
}, wrap((a) => op('storyboard_get', a)));
mcp.registerTool('shots_update', {
  title: 'Write the storyboard as a new version',
  description: 'Save a NEW version of the storyboard (versions are never overwritten). One of: shots = the full list; upsert = shots to add (no id: a new id sh<n>) or change (id + only the fields to change) plus remove = shot ids; restore = an old version id. A shot is bound to song time (t0 < t1, ms or "m:ss.mmm") and to a scene; the shots of a scene TILE it (re-tiled unless tile:false: the first starts with the scene, each ends where the next starts, the last ends with the scene); snap "beats" | "bars" puts the times you give on the beat grid, "events" on the nearest named event (and anchors the cut to it); anchors {t0?, t1?: event id} tie a cut to a named event (events_get) so a re-time after the take moves it. Propose shots from the scene beats (one per beat or group of beats) with kind, the action, camera / motion, cast / locations / props (entity ids; variants only where the shot differs from the scene) and a frame sketch (sketch_save first). status = {<shot id>: "draft" | "review" | "changes"} (approved / locked are the director\'s, in the page: 403). Give a short message. Returns the version, warnings (unknown scenes, entities, variants, sketches, beats; boundaries moved by tiling) and the gaps left.',
  inputSchema: { project, shots: z.array(shot).optional(), upsert: z.array(shot).optional(), remove: z.array(z.string()).optional(), restore: z.string().optional(),
    status: z.record(z.enum(['draft', 'review', 'changes', 'approved', 'locked'])).optional(), snap: z.enum(['beats', 'bars', 'events', 'off']).optional(), tile: z.boolean().optional(), message: z.string().optional(), by },
}, wrap((a) => op('shots_update', a)));
const chapter = z.object({ id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/).optional().describe('c1, c2… (leave out for a new one).'), name: z.string().optional(),
  scenes: z.array(z.string()).optional().describe('The scene ids it groups (a scene is in one chapter: a scene listed here leaves the chapter it was in).'),
  owner: z.string().optional().describe('Who builds it (an agent\'s name, "lead").'), file: z.string().optional().describe('Where it is built in the composition ("xp/ch1.js").'), note: z.string().optional() }).passthrough();
mcp.registerTool('chapters_update', {
  title: 'Group scenes into chapters (E3)',
  description: 'The chapters of the film (storyboard.json chapters[], outside the storyboard versions): chapters = the full list, or upsert (merge by id; no id = a new chapter c<n>) and remove (chapter ids). Each chapter groups scenes (script_get ids) and may name its owner (who builds it) and file (where it is built). Its BUILD STATUS is derived, never written (a status you send is ignored): planned (no shots, or nothing generated) -> generating (some requests / picks) -> built (every shot has a picked take; nothing renders as a placeholder) -> approved (and every shot approved by the director). Returns every chapter with its status, counts (shots, picked, approved, placeholders) and why. Planning only: nothing is approved or spent. storyboard_get and final_get list them too.',
  inputSchema: { project, chapters: z.array(chapter).optional(), upsert: z.array(chapter).optional(), remove: z.array(z.string()).optional(), by },
}, wrap((a) => op('chapters_update', a)));
mcp.registerTool('shot_note_add', {
  title: 'Note on a shot',
  description: 'Pin a note to a shot (shot id from storyboard_get), or a scene, or neither for the whole storyboard. reply_to = a note id adds your reply to its thread (answer the director\'s notes and asks this way). Notes are marked via "agent"; they never change the storyboard (shots_update does).',
  inputSchema: { project, shot: z.string().optional(), scene: z.string().optional(), text: z.string(), reply_to: z.string().optional(), to: z.string().optional(), by },
}, wrap((a) => op('shot_note_add', a)));
mcp.registerTool('shot_note_resolve', {
  title: 'Resolve a storyboard note',
  description: 'Mark a storyboard note (or an ask for you: "storyboard", "fill the gaps") resolved, with an optional reply saying what you did; reopen:true reopens it. Resolve the director\'s asks only when you did what they asked.',
  inputSchema: { project, id: z.string(), reply: z.string().optional(), reopen: z.boolean().optional(), by },
}, wrap((a) => op('shot_note_resolve', a)));
mcp.registerTool('gaps_get', {
  title: 'What is still missing (stage 6 gaps) and what filling it costs',
  description: 'Everything still missing across the stages: unscripted time, scenes without shots, shots without a frame, assets the shots need that are not approved (with the shots that need them), shots without a generation request or clip; proposals = for each of those shots the draft requests to create (request_create: kind shot-still / shot-video, target "shot:<id>", prompt, refs = the approved variant / look images + the frame sketch (ref_files absolute), tool, honest est_cost; a video needs its still first), with the assets not yet approved; estimate = the total against the cap (spent + committed + this, over_cap); asks_for_agent = the director\'s "fill the gaps" asks. Nothing is created or spent by this call.',
  inputSchema: { project },
}, wrap((a) => op('gaps_get', a)));
