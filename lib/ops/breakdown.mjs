// Stage 3: the breakdown (breakdown.json): versions, item statuses, notes, and the page-only "Create entity" (breakdown_promote).
import path from 'node:path';
import * as F from '../../js/flow.js';
import * as SC from '../../js/scenes.js';
import * as BD from '../../js/breakdown.js';
import { fail, nowIso, ops, projDir, read, readJSON, validId, write } from './_shared.mjs';
import { startStage } from './lyrics.mjs';
import { scenesDoc, sketchUse, sketchView } from './scenes.mjs';

// ------------------------------------------------------------------ stage 3: the breakdown (breakdown.json)
// Formats and the shared logic live in js/breakdown.js. Rules: every breakdown_update is a NEW version (nothing is
// overwritten; restore copies an old one); an item's status "ok" is the director's (page only; an agent sets "review"
// to ask); turning an item into an entity (breakdown_promote) is the page's act only: serve.mjs passes via "page" for a
// same-origin browser request, the MCP server has no such tool, and nothing is generated or spent by it.
export function breakdownDoc(p) { return BD.normBreakdown(readJSON(path.join(projDir(p), 'breakdown.json'), null, true)); }
function mutateBreakdown(p, fn) {
  const d = breakdownDoc(p); const r = fn(d);
  try { BD.checkBreakdown(d); } catch (e) { fail(400, e.message); }
  d.rev = (d.rev || 0) + 1; write(p, 'breakdown.json', d); return r === undefined ? d : r;
}
function bdNoteView(n, v) { const it = (v?.items || []).find(x => x.id === n.item); return { ...n, item_name: it?.name ?? null, ...(it || !n.item ? {} : { detached: 'the item is not in the current version' }) }; }
// what an agent may not write on an item (the page's own fields)
const BD_PAGE_FIELDS = ['status', 'entity_id', 'look_id', 'source'];
Object.assign(ops, {
  breakdown_get(p, { version, diff, notes = 'open', kind, scene, with_script = true } = {}) {
    const doc = breakdownDoc(p);
    if (diff) {
      if (!Array.isArray(diff) || diff.length !== 2) fail(400, 'diff: [older version id, newer version id]');
      const [a, b] = diff.map(x => doc.versions.find(v => v.id === x)); if (!a || !b) fail(404, `no such version: ${diff.join(', ')}`);
      const d = F.wordDiff(BD.breakdownText(a), BD.breakdownText(b));
      const show = d.map(o => o.w === '\n' ? (o.op === '-' ? '' : '\n') : o.op === '=' ? o.w : o.op === '-' ? `[-${o.w}-]` : `{+${o.w}+}`).join(' ').replace(/ ?\n ?/g, '\n');
      return { a: a.id, b: b.id, ...F.diffStats(d), items: BD.itemChanges(a, b), diff: show };
    }
    if (kind != null && !BD.KINDS.includes(kind)) fail(400, `kind: one of ${BD.KINDS.join(', ')}`);
    const v = version ? doc.versions.find(x => x.id === version) : BD.currentBreakdown(doc);
    if (version && !v) fail(404, `no version "${version}" (breakdown_get lists the versions)`);
    const sdoc = scenesDoc(p), sv = SC.currentScript(sdoc), scenes = sv?.scenes || [], sIds = new Map(scenes.map(s => [s.id, s]));
    const all = (v?.items || []).map(it => {
      const st = doc.states[it.id] || {}, missing = it.links.filter(l => !sIds.has(l.scene)).map(l => l.scene);
      return { ...it, status: st.status || 'draft', ...(st.entity_id ? { entity_id: st.entity_id } : {}), ...(st.look_id ? { look_id: st.look_id } : {}), ...(missing.length ? { missing_scenes: missing } : {}) };
    });
    const items = all.filter(i => (!kind || i.kind === kind) && (!scene || i.links.some(l => l.scene === scene)));
    const live = all.filter(i => !i.dropped);
    const ns = doc.notes.filter(n => notes === 'all' || n.status === notes);
    const uses = with_script ? sketchUse(p) : null, I = sdoc.intake || {};
    return { current: doc.current, version: v ? { id: v.id, created: v.created, by: v.by, via: v.via, message: v.message, from: v.from, script: v.script || null } : null,
      script_current: sdoc.current, ...(v?.script && v.script !== sdoc.current ? { script_changed: `this breakdown was made from script ${v.script}; the script is now ${sdoc.current}: check new or changed scenes` } : {}),
      counts: Object.fromEntries(BD.KINDS.map(k => [k, live.filter(i => i.kind === k).length])), dropped: all.length - live.length,
      items,
      scenes: scenes.map(s => ({ id: s.id, time: SC.span(s.t0, s.t1), title: s.title, items: live.filter(i => i.links.some(l => l.scene === s.id)).map(i => i.id) })),
      scenes_without_characters: scenes.filter(s => !live.some(i => i.kind === 'character' && i.links.some(l => l.scene === s.id))).map(s => s.id),
      entities: read(p, 'entities/index.json').map(e => ({ id: e.id, kind: e.kind, name: e.name })),
      notes: ns.map(n => bdNoteView(n, v)),
      asks_for_agent: doc.notes.filter(n => n.status === 'open' && n.to === 'agent').map(n => ({ id: n.id, item: n.item, scene: n.scene || null, kind: n.kind || 'request', text: n.text, replies: n.replies?.length || 0 })),
      versions: doc.versions.map(x => ({ id: x.id, created: x.created, by: x.by, via: x.via, message: x.message, from: x.from, script: x.script, items: x.items.length, current: x.id === doc.current })),
      ...(with_script ? {
        script: { version: sdoc.current, scenes: scenes.map(s => ({ id: s.id, time: SC.span(s.t0, s.t1), title: s.title, text: s.text, beats: s.beats.map(b => ({ id: b.id, t: b.t, text: b.text })),
          sketches: s.sketches.map(k => { try { const x = sketchView(p, k, { uses }); return { id: k, png: x.files.png, pins: x.pins }; } catch (e) { return { id: k, missing: true }; } }) })) },
        intake: Object.fromEntries(['who', 'where', 'era', 'must', 'mustnot'].map(k => [k, I[k]?.text || null])),
      } : {}),
      rules: 'breakdown_update writes a NEW version (never destructive); item status ok is the director\'s (page); only the page turns an item into an entity (set status "review" and say why in a note to ask); nothing here generates or spends' };
  },
  // a new version of the whole breakdown: items = the full list; or upsert (merge by id, an item without id is new) and
  // remove (ids); or restore = an old version id. status sets per-item statuses (draft / review; ok is the director's).
  breakdown_update(p, { items, upsert, remove, restore, status, message = '', by = 'agent' } = {}) {
    const modes = [items != null, upsert != null || remove != null, restore != null].filter(Boolean).length;
    if (modes > 1 || (!modes && status == null)) fail(400, 'give one of items (the full list), upsert / remove, or restore; or only status');
    if (status != null) {
      if (typeof status !== 'object' || Array.isArray(status)) fail(400, 'status: {<item id>: "draft" | "review"}');
      for (const [k, v] of Object.entries(status)) {
        if (!BD.ITEM_ID.test(k)) fail(400, `status: bad item id "${k}"`);
        if (v === 'ok') fail(403, `only the director marks an item ok, in the page; set "review" and say why in a note (breakdown_note_add) (${k})`);
        if (!BD.ITEM_STATUSES.includes(v)) fail(400, `status of ${k}: draft or review`);
      }
    }
    const sdoc = scenesDoc(p), scenes = SC.currentScript(sdoc)?.scenes || [], sIds = new Map(scenes.map(s => [s.id, s]));
    let r = {}; const warnings = [];
    mutateBreakdown(p, (d) => {
      const prev = BD.currentBreakdown(d);
      let body = null;
      if (restore != null) { const old = d.versions.find(v => v.id === restore); if (!old) fail(404, `no version "${restore}"`); body = structuredClone(old.items); }
      else if (items != null || upsert != null || remove != null) {
        if (items != null && !Array.isArray(items)) fail(400, 'items: [{id?, kind, name, description, links: [{scene, beats?, note?}], aliases?, for?, dropped?}]');
        if (upsert != null && !Array.isArray(upsert)) fail(400, 'upsert: a list of items (partial: only the fields to change; no id = a new item)');
        if (remove != null && (!Array.isArray(remove) || remove.some(x => typeof x !== 'string' || !BD.ITEM_ID.test(x)))) fail(400, 'remove: a list of item ids');
        const base = items != null ? [] : structuredClone(prev?.items || []), draft = [...base];
        const old = new Map((prev?.items || []).map(s => [s.id, s])), byId = new Map(base.map(s => [s.id, s]));
        for (const id of remove || []) { if (!byId.has(id)) fail(404, `no item "${id}" in the current version`); draft.splice(draft.indexOf(byId.get(id)), 1); byId.delete(id); }
        for (const x0 of items || upsert || []) {
          if (!x0 || typeof x0 !== 'object') fail(400, 'every item is an object');
          const x = { ...x0 };
          if (x.id != null && !BD.ITEM_ID.test(String(x.id))) fail(400, `item id "${String(x.id).slice(0, 60)}": letters, digits, _ and - (up to 40)`);
          for (const k of BD_PAGE_FIELDS) if (k in x) { if (k !== 'source') warnings.push(`${x.id || x.name}: ${k} ignored (${k === 'status' ? 'use status {}' : 'set by the page'})`); delete x[k]; }
          const cur = x.id != null ? byId.get(String(x.id)) : null;
          if (upsert && x.id != null && !cur) fail(404, `no item "${x.id}" to update (leave id out for a new item)`);
          const id = cur?.id ?? (x.id != null ? String(x.id) : BD.nextItemId(d, draft));
          if (!cur && byId.has(id)) fail(400, `duplicate item id "${id}"`);
          const was = cur || old.get(id);
          let c; try { c = BD.cleanItem({ ...(cur || { description: '', links: [] }), ...x, id, source: was?.source || 'agent' }); } catch (e) { fail(400, e.message); }
          if (cur) draft[draft.indexOf(cur)] = c; else draft.push(c);
          byId.set(id, c);
        }
        body = draft;
      }
      if (body) {
        if (prev && BD.sameItems(prev.items, body)) r = { version: prev.id, unchanged: true };
        else { const v = BD.addBreakdownVersion(d, body, { by, via: 'agent', message: restore ? (message || `restore ${restore}`) : message, ...(restore ? { from: restore } : {}), script: sdoc.current || undefined }); r = { version: v.id, items: v.items.length }; }
      }
      for (const [k, v] of Object.entries(status || {})) d.states[k] = { ...(d.states[k] || {}), status: v, by, via: 'agent', at: nowIso() };
      if (status) r.status = status;
      const cur = BD.currentBreakdown(d)?.items || [], names = new Map();
      for (const it of cur) {
        for (const l of it.links) {
          const s = sIds.get(l.scene);
          if (!s) warnings.push(`${it.id}: scene "${l.scene}" is not in the current script`);
          else for (const b of l.beats) if (!s.beats.some(x => x.id === b)) warnings.push(`${it.id}: beat "${b}" is not in ${l.scene}`);
        }
        if (it.kind === 'wardrobe' && it.for && !cur.some(x => x.id === it.for && x.kind === 'character')) warnings.push(`${it.id}: for "${it.for}" is not a character item`);
        const key = `${it.kind}:${it.name.toLowerCase()}`; if (names.has(key) && !it.dropped) warnings.push(`${it.id} and ${names.get(key)}: the same ${it.kind} name (merge them?)`); else names.set(key, it.id);
      }
      for (const k of Object.keys(status || {})) if (!cur.some(i => i.id === k)) warnings.push(`status for "${k}": no such item in the current version`);
    });
    if (warnings.length) r.warnings = [...new Set(warnings)];
    if (r.version && !r.unchanged) startStage(p, 'breakdown');
    return r;
  },
  // a note on an item (or a scene), with neither for the whole breakdown, a reply in a thread (reply_to), or an ask for
  // the agent (to "agent")
  breakdown_note_add(p, { item, scene, text, reply_to, to, by = 'agent' } = {}) {
    if (!text || typeof text !== 'string') fail(400, 'text required');
    if (scene != null && (typeof scene !== 'string' || !SC.SCENE_ID.test(scene))) fail(400, 'scene: a scene id');
    return mutateBreakdown(p, (d) => {
      if (reply_to) {
        const n = d.notes.find(x => x.id === reply_to); if (!n) fail(404, `no breakdown note "${reply_to}"`);
        const r = { id: `${n.id}.${(n.replies?.length || 0) + 1}`, text, by, via: 'agent', at: nowIso() };
        (n.replies ||= []).push(r); return { note: n.id, reply: r };
      }
      const v = BD.currentBreakdown(d), it = item ? v?.items.find(x => x.id === item) : null;
      if (item && !it) fail(404, `no item "${item}" in the current version (breakdown_get lists them)`);
      if (scene && !SC.currentScript(scenesDoc(p))?.scenes.some(s => s.id === scene)) fail(404, `no scene "${scene}" in the current script`);
      const n = { id: BD.nextBdNoteId(d), item: it ? item : null, ...(scene ? { scene } : {}), text, by, via: 'agent', ...(to ? { to: String(to) } : {}), status: 'open', at: nowIso(), version: d.current, replies: [] };
      d.notes.push(n); return bdNoteView(n, v);
    });
  },
  breakdown_note_resolve(p, { id, reply, reopen = false, by = 'agent' } = {}) {
    return mutateBreakdown(p, (d) => {
      const n = d.notes.find(x => x.id === id); if (!n) fail(404, `no breakdown note "${id}"`);
      if (reply) (n.replies ||= []).push({ id: `${n.id}.${(n.replies?.length || 0) + 1}`, text: String(reply), by, via: 'agent', at: nowIso() });
      n.status = reopen ? 'open' : 'resolved'; n.resolved_by = by; n.resolved_at = nowIso();
      return { ...n };
    });
  },
  // "Create entity" (the page only): a character / location / prop item becomes an entity in entities/ (a draft, no
  // images: nothing is generated or spent), or is linked to an existing one (entity_id); a wardrobe item becomes a look
  // on a character (character = its entity id, default the entity of the character the item is for). unlink: forget
  // the link (the entity stays). via: set by serve.mjs ("page" for a same-origin browser request, else "agent").
  breakdown_promote(p, { item, entity_id, character, unlink = false, via = 'agent' } = {}) {
    if (via !== 'page') fail(403, 'only the director turns a breakdown item into an entity, in the page (Breakdown stage: Create entity). Ask with breakdown_update status {<item>: "review"} and a note (breakdown_note_add); show it with ui_focus view "stage"');
    if (typeof item !== 'string' || !BD.ITEM_ID.test(item)) fail(400, 'item: an item id');
    for (const [k, v] of [['entity_id', entity_id], ['character', character]]) if (v != null && !validId(v)) fail(400, `${k}: an entity id`);
    const doc = breakdownDoc(p), it = BD.currentBreakdown(doc)?.items.find(x => x.id === item);
    if (!it) fail(404, `no item "${item}" in the current version (save your edits first)`);
    const stamp = { by: 'director', via: 'page', at: nowIso() };
    if (unlink) {
      return mutateBreakdown(p, (d) => { const s = d.states[item]; if (!s?.entity_id) fail(409, `${item} is not linked to an entity`); delete s.entity_id; delete s.look_id; Object.assign(s, stamp); return { item, unlinked: true }; });
    }
    if (it.dropped) fail(409, `${item} is dropped: restore it first`);
    if (!BD.PROMOTABLE.includes(it.kind)) fail(400, 'FX items stay in the breakdown (they become shots and requests later); only characters, locations, props and wardrobe become entities');
    if (doc.states[item]?.entity_id) fail(409, `${item} is already ${doc.states[item].entity_id}${doc.states[item].look_id ? ' / ' + doc.states[item].look_id : ''}`);
    const idx = read(p, 'entities/index.json'), info = { item: it.id, scenes: BD.itemScenes(it), at: stamp.at };
    const desc = /^suggested from /.test(it.description) ? '' : it.description;
    let res;
    if (it.kind === 'wardrobe') {
      const cid = character || (it.for && doc.states[it.for]?.entity_id);
      if (!cid) fail(400, 'wardrobe becomes a look on a character: choose the character (an entity), or turn the character it is for into an entity first');
      const ce = idx.find(e => e.id === cid);
      if (!ce || ce.kind !== 'character') fail(404, `no character entity "${cid}"`);
      const ent = readJSON(path.join(projDir(p), ce.path), {}, true) || {}, used = new Set((ent.looks || []).map(l => l.id));
      let lid = BD.slug(it.name); for (let n = 2; used.has(lid); n++) lid = `${BD.slug(it.name)}-${n}`;
      ops.entity_upsert(p, { kind: 'character', id: cid, look: { id: lid, name: it.name, garments: [it.name], colors: [], images: [], notes: desc, status: 'draft', breakdown: info } });
      res = { entity_id: cid, look_id: lid, created: 'look' };
    } else if (entity_id) {
      const e = idx.find(x => x.id === entity_id);
      if (!e) fail(404, `no entity "${entity_id}"`);
      if (e.kind !== it.kind) fail(409, `${entity_id} is a ${e.kind}, the item a ${it.kind}`);
      res = { entity_id, created: false };
    } else {
      const taken = new Set(idx.map(e => e.id.toLowerCase()));
      let id = BD.slug(it.name); for (let n = 2; taken.has(id); n++) id = `${BD.slug(it.name)}-${n}`;
      ops.entity_upsert(p, { kind: it.kind, id, name: it.name, fields: { status: 'draft', refs: [], [it.kind === 'character' ? 'role' : 'description']: desc, ...(it.kind === 'character' ? { looks: [] } : {}), ...(it.aliases?.length ? { aliases: it.aliases } : {}), breakdown: info } });
      res = { entity_id: id, created: true };
    }
    mutateBreakdown(p, (d) => { d.states[item] = { ...(d.states[item] || {}), status: 'ok', entity_id: res.entity_id, ...(res.look_id ? { look_id: res.look_id } : {}), ...stamp }; });
    return { item, kind: it.kind, ...res };
  },
});
