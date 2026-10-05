// MCP tools: named sync points (lib/ops/events.mjs, js/events.js; ROADMAP_v4 E1). The agent reads the events, proposes new
// ones and proposes re-times after the take; accepting an event and applying a re-time are the director's, in the page
// (events_act / retime_apply / retime_undo: no tool).
import { z } from 'zod';
import { mcp, op, wrap, project, time, by } from './_shared.mjs';

const KIND = z.enum(['stop', 'spoken', 'voice', 'cue', 'custom']);

mcp.registerTool('events_get', {
  title: 'Named events (sync points)',
  description: 'Read only. The song\'s named events (events.json): [{id "her_hi_there", name, t (ms), time, kind stop | spoken | voice | cue | custom | section, note, status accepted | proposed | dismissed, '
    + 'measured? (where it really landed in the chosen take), anchored [{kind scene | shot, id, edge t0 | t1, t}] (the boundaries that follow it)}], counts, '
    + 'pending (when events are measured elsewhere than their time: the re-time plan: moves, every boundary old -> new, problems), and the re-time records (proposed / applied / undone). '
    + 'Anchor scene / shot boundaries to accepted events with scenes_update / shots_update (anchors {t0?, t1?} or snap "events"). Filters: kind, status (default: not dismissed), t0 / t1, id.',
  inputSchema: { project, kind: z.enum(['stop', 'spoken', 'voice', 'cue', 'custom', 'section']).optional(), status: z.enum(['accepted', 'proposed', 'dismissed']).optional(),
    t0: time.optional(), t1: time.optional(), id: z.string().optional() },
}, wrap((a) => op('events_get', a)));

mcp.registerTool('event_add', {
  title: 'Propose a named event',
  description: 'Add a named sync point at a song time: a stop (the beat cuts out), a spoken line, a voice change, a cue, or anything a cut should land on ("her_hi_there": Verse 5, her first line). '
    + 'It is written with status "proposed": the director accepts it in the page (timeline › events column), and only then can boundaries snap / anchor to it. '
    + 'id (optional; letters, digits, _ . -; default from the name), name, t (ms or m:ss.mmm), kind stop | spoken | voice | cue | custom, note (what is heard there), measured (optional: where it really landed). '
    + 'An existing id is 409. Never an approval.',
  inputSchema: { project, id: z.string().optional(), name: z.string(), t: time, kind: KIND.optional(), note: z.string().optional(), measured: time.optional(), by },
}, wrap((a) => op('event_add', a)));

mcp.registerTool('retime_propose', {
  title: 'Propose a re-time after the take',
  description: 'After the song take is chosen: "measure where each Stop actually landed and re-time to it". Give moves [{event, to}] (to = where the event really is, ms or m:ss.mmm; '
    + 'measure it from the stems / the beat grid) or from_measured: true (the events the director measured), and why. Returns the plan: every scene and shot boundary anchored to those events '
    + '(and the cuts that share them) old -> new, and problems (a boundary that would cross another: refused, 400). Written as a "proposed" re-time; NOTHING moves: the director applies it '
    + 'in the page (Timeline › Re-time…) as one undoable change (a new scenes and storyboard version). Accepted events only.',
  inputSchema: { project, moves: z.array(z.object({ event: z.string(), to: time })).optional(), from_measured: z.boolean().optional(), why: z.string().optional(), by },
}, wrap((a) => op('retime_propose', a)));
