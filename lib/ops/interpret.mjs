// E10: the agent's interpretation next to the director's verbatim intake answers and notes (shape: js/interpret.js).
//   interpretation_set  the agent writes its reading of an intake answer (key) or a note (note): status "proposed", via
//                       "agent" (whatever the caller claims). An "edited" one is the director's words: 409
//   interpretation_act  PAGE ONLY: the director accepts it (act "accept") or rewrites it (act "edit" + text). The agent
//                       cannot (403, no MCP tool)
// Neither ever changes the verbatim answer or note text.
import path from 'node:path';
import * as I from '../../js/interpret.js';
import * as SC from '../../js/scenes.js';
import * as N from '../../js/notes.js';
import { fail, nowIso, ops, projDir, withFileLock, write } from './_shared.mjs';
import { scenesDoc } from './scenes.mjs';
import { mutateNotes } from './notes.mjs';

const text = (t) => { try { return I.cleanText(t); } catch (e) { fail(400, e.message); } };
const pageOnly = (via) => { if (via !== 'page') fail(403, 'accepting or editing an interpretation is the director\'s, in the page (Script › Intake, the Notes column): write yours with interpretation_set'); };
// the thing interpreted: {key} = an intake question, {note} = a note id; fn(holder) changes holder.interpretation
function onTarget(p, { key, note }, fn) {
  if ((key == null) === (note == null)) fail(400, 'give key (an intake question id) or note (a note id), not both');
  if (key != null) {
    if (!SC.INTAKE.some(q => q.id === key)) fail(400, `no intake question "${key}" (ids: ${SC.INTAKE.map(q => q.id).join(', ')})`);
    const file = path.join(projDir(p), 'scenes.json');
    return withFileLock(file, () => {
      const d = scenesDoc(p); delete d.derived;
      const a = d.intake[key];
      if (!a || !String(a.text || '').trim()) fail(409, `intake "${key}" has no answer yet: an interpretation sits under the director's own words (intake_answer records them)`);
      const r = fn(a, `intake ${key}`);
      d.rev = (d.rev || 0) + 1; write(p, 'scenes.json', d);
      return { key, answer: a.text, interpretation: a.interpretation, ...r };
    });
  }
  return mutateNotes(p, (d) => {
    const n = N.findNote(d, note); if (!n) fail(404, `no note "${note}" (notes_get lists them)`);
    const r = fn(n, `note ${n.id}`);
    return { note: n.id, text: n.text, interpretation: n.interpretation, ...r };
  });
}

Object.assign(ops, {
  interpretation_set(p, { key, note, text: t, by = 'agent' } = {}) {
    const v = text(t), who = typeof by === 'string' && by.trim() && by !== 'director' ? by.trim().slice(0, 40) : 'agent';
    return onTarget(p, { key, note }, (h, what) => {
      if (h.interpretation?.status === 'edited') fail(409, `${what}: the director rewrote this interpretation (it is their words now); reply in a note instead`);
      h.interpretation = { text: v, by: who, via: 'agent', at: nowIso(), status: 'proposed' };
    });
  },
  interpretation_act(p, { key, note, act, text: t, via } = {}) {
    pageOnly(via);
    if (!['accept', 'edit'].includes(act)) fail(400, 'act: accept | edit');
    const v = act === 'edit' ? text(t) : null;
    return onTarget(p, { key, note }, (h, what) => {
      const i = h.interpretation; if (!i) fail(404, `${what} has no interpretation`);
      const reviewed = { by: 'director', via: 'page', at: nowIso() };
      if (act === 'accept') h.interpretation = { ...i, status: i.status === 'edited' ? 'edited' : 'accepted', reviewed };
      else h.interpretation = { ...i, text: v, status: 'edited', agent_text: i.agent_text ?? i.text, reviewed };
    });
  },
});
