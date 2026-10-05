// MCP tools: the shots.json shots / clip uses and stage 6: the storyboard and the gaps (lib/ops/storyboard.mjs).
// Registered on the shared server object when mcp/server.mjs imports this file.
import { z } from 'zod';
import { mcp, op, wrap, project, time, by, directorApproved } from './_shared.mjs';

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
  description: 'Change a shot / clip use. status -> approvals ("review" to ask the director to look; "approved"/"locked" need director_approved:true, only when the director said so; "changes" only on their word or your review finding). note -> a note pinned at its start. title -> the shot title. take / in_ms / file -> which take of a clip use plays and from where (clip uses only; the take\'s file is found in the media index). Timing edits beyond that belong in a request. Returns what changed.',
  inputSchema: { project, id: z.string().describe('Shot id or clip use id.'), status: z.enum(['draft', 'review', 'changes', 'approved', 'locked']).optional(), comment: z.string().optional().describe('Stored with the status.'),
    take: z.number().int().min(0).optional(), in_ms: time.optional().describe('In-point inside the clip file.'), file: z.string().optional(), title: z.string().optional(), note: z.string().optional(), by, director_approved: directorApproved },
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
  gen: z.enum(['still', 'video']).nullable().optional().describe('What it needs generated (default from the kind).'), clips: z.array(z.string()).optional() }).passthrough();
mcp.registerTool('storyboard_get', {
  title: 'Get the storyboard (stage 6)',
  description: 'The storyboard: the script\'s scenes in song time [{id, time, title, text, status, beats [{id, t, text}], needs (the cast / locations / props the breakdown links to the scene, with the variant the scene uses), shots}], each shot {id, scene, t0, t1, time, bars, kind, title, text, camera, beats, cast, locations, props, variants (per-shot overrides), gen still/video, clips, status (approvals: draft/review/changes/approved/locked), frame {sketch, png, file (absolute), pins} or {thumb}, assets [{type, id, name, variant, variant_name, source scene/shot/director/agent/default, approved, image, file, why}], requests (target shot:<id>), estimate}; outside_script (shots whose scene is gone); the beat grid; gaps (counts + estimate; gaps_get has the rows); notes (default open); asks_for_agent (kind storyboard = propose shots, fill_gaps = draft requests); versions. A project without storyboard.json reads its shots from shots.json (v1, derived). version = an older one; diff = [a, b] -> word diff + shots added / removed / changed; scene filters.',
  inputSchema: { project, version: z.string().optional(), diff: z.array(z.string()).length(2).optional(), scene: z.string().optional(), notes: z.enum(['open', 'resolved', 'all']).optional() },
}, wrap((a) => op('storyboard_get', a)));
mcp.registerTool('shots_update', {
  title: 'Write the storyboard as a new version',
  description: 'Save a NEW version of the storyboard (versions are never overwritten). One of: shots = the full list; upsert = shots to add (no id: a new id sh<n>) or change (id + only the fields to change) plus remove = shot ids; restore = an old version id. A shot is bound to song time (t0 < t1, ms or "m:ss.mmm") and to a scene; the shots of a scene TILE it (re-tiled unless tile:false: the first starts with the scene, each ends where the next starts, the last ends with the scene); snap "beats" | "bars" puts the times you give on the beat grid. Propose shots from the scene beats (one per beat or group of beats) with kind, the action, camera / motion, cast / locations / props (entity ids; variants only where the shot differs from the scene) and a frame sketch (sketch_save first). status = {<shot id>: "draft" | "review" | "changes"} (approved / locked are the director\'s, in the page: 403). Give a short message. Returns the version, warnings (unknown scenes, entities, variants, sketches, beats; boundaries moved by tiling) and the gaps left.',
  inputSchema: { project, shots: z.array(shot).optional(), upsert: z.array(shot).optional(), remove: z.array(z.string()).optional(), restore: z.string().optional(),
    status: z.record(z.enum(['draft', 'review', 'changes', 'approved', 'locked'])).optional(), snap: z.enum(['beats', 'bars', 'off']).optional(), tile: z.boolean().optional(), message: z.string().optional(), by },
}, wrap((a) => op('shots_update', a)));
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
