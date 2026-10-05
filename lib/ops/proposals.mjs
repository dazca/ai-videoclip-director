// Proposals (docs/SPEC_v4_NOTES_ROUNDS.md §3; ROADMAP_v4 B9-B11). Shapes and shared logic: js/proposals.js; the SVG
// sanitiser: lib/svg-sanitize.mjs; the free local generator: js/proposals-local.js.
//   proposals_add    the agent (or a script) attaches a set of choices to a target: by default 3 items, each a small SVG
//                    made with code (sanitised here, written to proposals/<set>-<item>.svg) or a short text, with a title
//                    and a why. Answers the open "proposals" asks on the same target (a "3 more"). Returns what changed.
//   proposals_get    the sets (by target / stage / open / set id) with each item's status and the director's picks and
//                    mix notes, plus the open asks for proposals
//   proposal_act     PAGE ONLY: pick | mix (pick + a note to the agent) | dismiss | reopen | restore (the page's undo).
//                    One pick per set. The agent cannot pick (403, no MCP tool)
//   proposals_local  the free local generator: 3 SVG layouts per scene (its sketch) and / or per shot (its frame), from
//                    the script, the beats and the scene's palette; skips a target that already has open proposals
// proposals.json is the server's (not a page save: 403), read by the page like revisions.json.
import path from 'node:path';
import * as P from '../../js/proposals.js';
import * as N from '../../js/notes.js';
import * as SC from '../../js/scenes.js';
import * as SB from '../../js/storyboard.js';
import * as A from '../../js/assets.js';
import { localSceneItems, localShotItems } from '../../js/proposals-local.js';
import { sanitizeSvg } from '../svg-sanitize.mjs';
import { fail, nowIso, ops, projDir, read, readJSON, writeAtomic, writeJSON } from './_shared.mjs';
import { notesDoc, checkTarget, addNote, setStatus } from './notes.mjs';
import { scenesDoc } from './scenes.mjs';
import { breakdownDoc } from './breakdown.mjs';
import { boardDoc } from './storyboard.mjs';

const FILE = 'proposals.json';
export const proposalsDoc = (p) => P.normProposals(readJSON(path.join(projDir(p), FILE), null, true));
function mutate(p, fn) { const d = proposalsDoc(p); const r = fn(d); d.rev = (d.rev || 0) + 1; writeJSON(path.join(projDir(p), FILE), d); return r === undefined ? d : r; }
const str = (v) => typeof v === 'string' ? v.trim() : '';

// a target proposals may sit on (js/proposals.js TARGETS) that exists now (lib/ops/notes.mjs checkTarget)
function cleanTarget(p, target) {
  if (!target || typeof target !== 'object') fail(400, 'target: {stage, kind, id} (a scene, a shot, a lyric line, a look tree "ada/look:x", a location variant tree "studio/variant:x", an asset)');
  const kinds = P.TARGETS[target.stage];
  if (!kinds) fail(400, `target.stage: one of ${Object.keys(P.TARGETS).join(', ')}`);
  if (!kinds.includes(target.kind)) fail(400, `target.kind on ${target.stage}: one of ${kinds.join(', ')}`);
  const t = checkTarget(p, { stage: target.stage, kind: target.kind, id: target.id });
  return { stage: t.stage, kind: t.kind, id: t.id };
}
function cleanItem(x, k) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) fail(400, `items[${k}]: {title, why, svg | text}`);
  const title = str(x.title), why = str(x.why);
  if (!title || title.length > P.TITLE_MAX) fail(400, `items[${k}].title: 1-${P.TITLE_MAX} characters (e.g. "Wide · Ada on the left third")`);
  if (why.length > P.WHY_MAX) fail(400, `items[${k}].why: up to ${P.WHY_MAX} characters (one line of rationale)`);
  const hasSvg = x.svg != null && x.svg !== '', hasText = x.text != null && x.text !== '';
  if (hasSvg === hasText) fail(400, `items[${k}]: exactly one of svg (an SVG string made with code) or text (a short text)`);
  if (hasText) { const t = str(x.text); if (!t || t.length > P.TEXT_MAX) fail(400, `items[${k}].text: 1-${P.TEXT_MAX} characters`); return { title, why, text: t }; }
  let s; try { s = sanitizeSvg(String(x.svg)); } catch (e) { fail(400, `items[${k}]: ${e.message}`); }
  return { title, why, svg: s.svg };
}

// write one set (items already cleaned: svg = the sanitised markup); answers the open "proposals" asks on the target
function addSet(p, t, cleaned, { by = 'agent', via = 'agent', source = 'agent' } = {}) {
  const dir = projDir(p), round = notesDoc(p).round || 1, at = nowIso();
  const set = mutate(p, (d) => {
    const id = P.nextSetId(d), ids = P.itemIds(cleaned.length);
    const items = cleaned.map((x, k) => {
      const it = { id: ids[k], title: x.title, why: x.why, status: 'open' };
      if (x.svg != null) { it.svg = P.svgPath(id, ids[k]); writeAtomic(path.join(dir, it.svg), x.svg); } else it.text = x.text;
      return it;
    });
    const s = { id, target: t, round, by: String(by || 'agent').slice(0, 60), via, source, created: at, items };
    d.sets.push(s); return s;
  });
  // a "3 more" (an open ask of kind proposals on this very target) is answered by the new set
  const answered = [];
  for (const n of notesDoc(p).notes) {
    if (n.status !== 'open' || n.to !== 'agent' || n.ask !== 'proposals' || !P.sameTarget(n.target, t)) continue;
    setStatus(p, n.id, 'absorbed', { reply: `${set.items.length} proposals added: ${set.id}`, by, via: via === 'page' ? 'page' : 'agent' });
    answered.push(n.id);
  }
  if (answered.length) mutate(p, (d) => { const s = d.sets.find(x => x.id === set.id); s.answers = answered; });
  return { set, answered };
}
const view = (p, s) => ({ ...s, label: P.targetLabel(s.target), items: s.items.map(i => ({ ...i, ...(i.svg ? { svg_url: `/data/${p}/${i.svg}`, svg_file: path.join(projDir(p), i.svg) } : {}) })) });

// the cast and palette of a scene / shot (the local generator): names and look colours of its characters
function castOf(p, ids) {
  const idx = read(p, 'entities/index.json') || [], out = [];
  for (const id of ids) {
    const e = idx.find(x => x.id === id && x.kind === 'character'); if (!e || /\.\./.test(e.path)) continue;
    const ent = readJSON(path.join(projDir(p), e.path), {}) || {};
    out.push({ name: ent.name || id, colors: A.variants(ent, 'character').flatMap(v => v.colors || []) });
  }
  return { cast: out.map(x => x.name), colors: out.flatMap(x => x.colors) };
}

Object.assign(ops, {
  proposals_add(p, { target, items, by = 'agent', via = 'agent' } = {}) {
    const t = cleanTarget(p, target);
    if (!Array.isArray(items) || items.length < 1 || items.length > P.MAX_ITEMS) fail(400, `items: 1-${P.MAX_ITEMS} proposals (3 is the default: give the director a real choice)`);
    const cleaned = items.map(cleanItem);
    const { set, answered } = addSet(p, t, cleaned, { by, via: via === 'page' ? 'page' : 'agent', source: 'agent' });
    return {
      changed: `proposals.json: set ${set.id} on ${P.targetLabel(t)} with ${set.items.length} item${set.items.length > 1 ? 's' : ''} (${set.items.map(i => i.svg ? `${i.id} svg ${i.svg}` : `${i.id} text`).join(', ')})${answered.length ? `; answered ${answered.join(', ')}` : ''}`,
      set: view(p, set), answered,
      next: 'the director picks, mixes or dismisses them in the page (picks are the director\'s); read their choice with proposals_get',
    };
  },
  proposals_get(p, { target, stage, open, set } = {}) {
    const d = proposalsDoc(p);
    if (stage != null && !P.TARGETS[stage]) fail(400, `stage: one of ${Object.keys(P.TARGETS).join(', ')}`);
    let sets = d.sets;
    if (set != null) sets = sets.filter(s => s.id === set);
    if (target) sets = sets.filter(s => P.sameTarget(s.target, { stage: target.stage, kind: target.kind, id: target.id ?? null }));
    if (stage) sets = sets.filter(s => s.target.stage === stage);
    if (open) sets = sets.filter(s => s.items.some(i => i.status === 'open'));
    const picks = sets.flatMap(s => s.items.filter(P.isPicked).map(i => ({ set: s.id, item: i.id, target: s.target, label: P.targetLabel(s.target), title: i.title, status: i.status, ...(i.note ? { note: i.note } : {}), ...(i.svg ? { svg: i.svg } : { text: i.text }), at: i.at || null })));
    const asks = notesDoc(p).notes.filter(n => n.status === 'open' && n.to === 'agent' && n.ask === 'proposals')
      .filter(n => (!stage || n.target.stage === stage) && (!target || P.sameTarget(n.target, target) || n.target.kind === 'stage'))
      .map(n => ({ id: n.id, target: n.target, text: n.text, created: n.created }));
    return { sets: sets.map(s => view(p, s)).reverse(), picks, asks,
      counts: { sets: sets.length, open_items: sets.reduce((a, s) => a + s.items.filter(i => i.status === 'open').length, 0), picked: picks.length },
      rules: 'proposals_add {target, items: [{title, why, svg | text}]} adds a set (3 by default); a pick, mix or dismissal is the director\'s (page only). A mix = their pick plus a note to you (an open note on the target). A "3 more" ask is answered by your next proposals_add on its target; a stage-wide "Prepare proposals" ask: add sets where they help most, then notes_status {id, status: "absorbed", reply}.' };
  },
  proposal_act(p, { via, set, item, act, note, states } = {}) {
    if (via !== 'page') fail(403, 'only the director picks, mixes or dismisses a proposal, in the page: an agent cannot (add more with proposals_add)');
    if (!['pick', 'mix', 'dismiss', 'reopen', 'restore'].includes(act)) fail(400, 'act: pick | mix | dismiss | reopen | restore');
    let noteId = null;
    const out = mutate(p, (d) => {
      const s = d.sets.find(x => x.id === set); if (!s) fail(404, `no proposal set "${set}"`);
      const before = Object.fromEntries(s.items.map(i => [i.id, i.status]));
      if (act === 'restore') {
        if (!states || typeof states !== 'object') fail(400, 'states: {<item id>: status}');
        for (const [k, v] of Object.entries(states)) { const i = s.items.find(x => x.id === k); if (!i || !P.ITEM_STATUSES.includes(v)) fail(400, `states.${k}: an item of ${s.id} and a status ${P.ITEM_STATUSES.join(' | ')}`); i.status = v; if (!P.isPicked(i)) delete i.note; }
        return { set: s.id, before, after: Object.fromEntries(s.items.map(i => [i.id, i.status])) };
      }
      const it = s.items.find(x => x.id === item); if (!it) fail(404, `no item "${item}" in ${s.id}`);
      if (act === 'mix' && (typeof note !== 'string' || !note.trim() || note.length > 2000)) fail(400, 'note: what to change in the mix, 1-2000 characters');
      if (act === 'pick' || act === 'mix') for (const o of s.items) if (o !== it && P.isPicked(o)) { o.status = 'open'; delete o.note; }
      it.status = act === 'pick' ? 'picked' : act === 'mix' ? 'mixed' : act === 'dismiss' ? 'dismissed' : 'open';
      if (act === 'mix') it.note = note.trim(); else delete it.note;
      Object.assign(it, { at: nowIso(), by: 'director', via: 'page' });
      return { set: s.id, item: it.id, status: it.status, target: s.target, before, after: Object.fromEntries(s.items.map(i => [i.id, i.status])), title: it.title, ...(it.svg ? { svg: it.svg } : { text: it.text }) };
    });
    if (act === 'mix') {
      const n = addNote(p, { target: out.target, text: `Mix of proposal ${out.set}/${out.item} “${out.title}” (picked): ${note.trim()}`, to: 'agent', ask: 'request', by: 'director', via: 'page' });
      noteId = n.id;
    }
    return { ...out, ...(noteId ? { note: noteId } : {}) };
  },
  // the free local generator: scenes (their sketch) and / or shots (their frame); target = one scene / shot only
  proposals_local(p, { scope = 'all', target, via = 'agent', by } = {}) {
    if (!['all', 'script', 'storyboard'].includes(scope)) fail(400, 'scope: all | script | storyboard');
    const d = proposalsDoc(p), has = (t) => d.sets.some(s => P.sameTarget(s.target, t) && s.items.some(i => i.status === 'open'));
    const scenes = SC.currentScript(scenesDoc(p))?.scenes || [], shots = SB.boardShots(boardDoc(p));
    let bd = null; try { bd = breakdownDoc(p); } catch (e) { /* no breakdown */ }
    const ents = (read(p, 'entities/index.json') || []).filter(e => !/\.\./.test(e.path)).map(e => ({ ...(readJSON(path.join(projDir(p), e.path), {}) || {}), id: e.id, kind: e.kind }));
    const jobs = [];
    const want = (t) => !target || P.sameTarget(t, { stage: target.stage, kind: target.kind, id: target.id });
    if (scope !== 'storyboard') for (const s of scenes) {
      const t = { stage: 'script', kind: 'scene', id: s.id }; if (!want(t)) continue;
      const c = castOf(p, SB.sceneAssets(s.id, bd, ents).filter(x => x.type === 'character').map(x => x.id));
      jobs.push([t, () => localSceneItems(s, { cast: c.cast, colors: c.colors })]);
    }
    if (scope !== 'script') for (const s of shots) {
      const t = { stage: 'storyboard', kind: 'shot', id: s.id }; if (!want(t)) continue;
      const sc = scenes.find(x => x.id === s.scene), c = castOf(p, s.cast || []);
      jobs.push([t, () => localShotItems(s, { scene: sc, cast: c.cast, colors: c.colors })]);
    }
    const added = [], skipped = [];
    for (const [t, make] of jobs) {
      if (has(t)) { skipped.push(P.targetLabel(t)); continue; }
      const cleaned = make().map((x, k) => cleanItem(x, k));
      const { set } = addSet(p, t, cleaned, { by: by || 'local generator', via: via === 'page' ? 'page' : 'agent', source: 'local' });
      added.push({ set: set.id, target: t, items: set.items.length });
    }
    return { changed: `proposals.json: ${added.length} new set${added.length === 1 ? '' : 's'} (${added.reduce((a, x) => a + x.items, 0)} SVG layouts)${skipped.length ? `; ${skipped.length} target${skipped.length === 1 ? '' : 's'} already had open proposals` : ''}`, added, skipped, cost_usd: 0 };
  },
});
