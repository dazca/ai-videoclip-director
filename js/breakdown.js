// Stage 3 of the guided flow (docs/SPEC_v3_GUIDED.md): the breakdown. Pure functions, no DOM and no Node APIs: the page
// (tabs/breakdown.js, js/columns.js) and the data layer (lib/store.mjs) import the same code.
//
// breakdown.json  {rev, current: "v3", versions: [{id, n, created, by, via, message, from?, script?, items: [Item]}],
//                  states: {<item id>: State}, notes: [Note]}
//   Item   {id "bi03", kind, name, description, links: [{scene "sc02", beats: ["b1"], note?}], source: agent | director,
//           aliases?: [names], for?: <character item id> (wardrobe: whose), dropped?: true}
//          kind: character | location | prop | wardrobe | fx. links name the scenes (and beats) of scenes.json that need
//          the item; scene ids are never reused, so a link keeps meaning across script versions. dropped = soft delete
//          (the item stays in the version, greyed; restoring clears the flag). script = the script version it was made from.
//   State  {status: draft | review | ok, entity_id?, look_id?, by, via, at}   outside the versions (like the script's
//          scene statuses): status ok is the director's (page only; an agent sets review to ask), entity_id / look_id
//          are set only by the page's "Create entity" (POST /api/op/breakdown_promote, refused to the agent surface)
//   Note   {id "bn01", item: id | null, scene?: id, text, by, via, to?: "agent", kind?: request | extract, status,
//           at, version, replies: [{id, text, by, via, at}]}
//   A version is immutable: a save appends one and moves `current`; a restore appends a copy. A missing file reads as
//   an empty breakdown (no versions).
export const KINDS = ['character', 'location', 'prop', 'wardrobe', 'fx'];
export const KIND_LABEL = { character: 'characters', location: 'locations', prop: 'props', wardrobe: 'wardrobe', fx: 'FX' };
export const KIND_ONE = { character: 'character', location: 'location', prop: 'prop', wardrobe: 'wardrobe', fx: 'FX' };
export const KIND_COLOR = { character: '#f0a46c', location: '#6fb3d9', prop: '#d9c36f', wardrobe: '#d98fc0', fx: '#8fd9a0' };
export const ITEM_STATUSES = ['draft', 'review', 'ok'];
export const ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const BEAT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
// kinds that become a real entity (wardrobe becomes a look on a character; FX stays in the breakdown)
export const PROMOTABLE = ['character', 'location', 'prop', 'wardrobe'];

const maxN = (list, re) => list.reduce((m, x) => Math.max(m, Number(re.exec(String(x?.id))?.[1]) || 0), 0);
export const slug = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'item';

// ------------------------------------------------------------------ documents
export function emptyBreakdown() { return { rev: 0, current: null, versions: [], states: {}, notes: [] }; }
export function normBreakdown(doc) {
  const d = doc && typeof doc === 'object' && Array.isArray(doc.versions) ? { ...emptyBreakdown(), ...doc } : { ...emptyBreakdown(), ...(doc && typeof doc === 'object' ? { rev: doc.rev || 0 } : {}) };
  if (!Array.isArray(d.notes)) d.notes = [];
  if (!d.states || typeof d.states !== 'object' || Array.isArray(d.states)) d.states = {};
  if (d.versions.length && !d.versions.some(v => v.id === d.current)) d.current = d.versions[d.versions.length - 1].id;
  return d;
}
export const currentBreakdown = (doc) => doc?.versions?.find(v => v.id === doc.current) || null;
export const sameItems = (a, b) => JSON.stringify(a?.items || a || []) === JSON.stringify(b?.items || b || []);
export function addBreakdownVersion(doc, items, { by = 'director', via, message = '', from, script, created } = {}) {
  const n = Math.max(0, ...doc.versions.map(v => v.n || Number(String(v.id).replace(/\D/g, '')) || 0)) + 1;
  const v = { id: `v${n}`, n, created: created || new Date().toISOString().slice(0, 19), by, ...(via ? { via } : {}), message: String(message || ''), ...(from ? { from } : {}), ...(script ? { script } : {}), items: structuredClone(items) };
  doc.versions.push(v); doc.current = v.id;
  return v;
}
// ids are never reused: the next number after every item of every version and the draft
export const nextItemId = (doc, draft) => `bi${String(Math.max(maxN((doc?.versions || []).flatMap(v => v.items || []), /^bi(\d+)$/), maxN(draft || [], /^bi(\d+)$/)) + 1).padStart(2, '0')}`;
export const nextBdNoteId = (doc) => `bn${String(maxN(doc?.notes || [], /^bn(\d+)$/) + 1).padStart(2, '0')}`;
export const itemState = (doc, id) => doc?.states?.[id] || { status: 'draft' };
export const itemStatus = (doc, id) => doc?.states?.[id]?.status || 'draft';
export const itemScenes = (it) => (it?.links || []).map(l => l.scene);

// a link from the page or an agent: {scene, beats?, note?} or a bare scene id
function cleanLink(l, where) {
  const x = typeof l === 'string' ? { scene: l } : l;
  if (!x || typeof x !== 'object' || typeof x.scene !== 'string' || !ITEM_ID.test(x.scene)) throw new Error(`${where}: a link is {scene: "<scene id>", beats?: [ids], note?}`);
  const beats = [...new Set((Array.isArray(x.beats) ? x.beats : []).map(String))];
  for (const b of beats) if (!BEAT_ID.test(b)) throw new Error(`${where}: beat id "${b}"`);
  const note = x.note == null ? '' : String(x.note).slice(0, 1000);
  return { scene: x.scene, beats, ...(note ? { note } : {}) };
}
// an item from the page or an agent -> the stored shape; throws a message on what cannot be fixed
export function cleanItem(it, { source = 'director' } = {}) {
  if (!it || typeof it !== 'object') throw new Error('an item must be an object');
  const id = String(it.id || '');
  if (!ITEM_ID.test(id)) throw new Error(`item id "${it.id}": letters, digits, _ and - (up to 40)`);
  if (!KINDS.includes(it.kind)) throw new Error(`item ${id}: kind must be one of ${KINDS.join(', ')}`);
  const name = String(it.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!name) throw new Error(`item ${id}: a name is required`);
  const links = [], seen = new Map();
  for (const l of Array.isArray(it.links) ? it.links : []) {
    const c = cleanLink(l, `item ${id}`), o = seen.get(c.scene);
    if (o) { o.beats = [...new Set([...o.beats, ...c.beats])]; if (c.note && !o.note) o.note = c.note; } else { seen.set(c.scene, c); links.push(c); }
  }
  const aliases = [...new Set((Array.isArray(it.aliases) ? it.aliases : []).map(a => String(a).replace(/\s+/g, ' ').trim().slice(0, 200)).filter(a => a && a.toLowerCase() !== name.toLowerCase()))].slice(0, 20);
  if (it.for != null && it.for !== '' && !ITEM_ID.test(String(it.for))) throw new Error(`item ${id}: for must be an item id`);
  return { id, kind: it.kind, name, description: String(it.description ?? '').slice(0, 8000), links, source: it.source === 'agent' || it.source === 'director' ? it.source : source,
    ...(aliases.length ? { aliases } : {}), ...(it.kind === 'wardrobe' && it.for ? { for: String(it.for) } : {}), ...(it.dropped ? { dropped: true } : {}) };
}
// a breakdown.json from the page or an agent: the shape the tools rely on (throws a message on a bad file)
export function checkBreakdown(d) {
  if (!d || typeof d !== 'object' || !Array.isArray(d.versions)) throw new Error('breakdown.json: {versions[], states{}, notes[]} expected');
  if (d.notes != null && !Array.isArray(d.notes)) throw new Error('breakdown.json: notes must be a list');
  if (d.states != null && (typeof d.states !== 'object' || Array.isArray(d.states))) throw new Error('breakdown.json: states must be an object');
  const ids = new Set();
  for (const v of d.versions) {
    if (!v || typeof v.id !== 'string' || ids.has(v.id) || !Array.isArray(v.items)) throw new Error('breakdown.json: every version needs a unique id and items[]');
    ids.add(v.id); const I = new Set();
    for (const it of v.items) {
      if (!it || typeof it.id !== 'string' || !ITEM_ID.test(it.id) || I.has(it.id)) throw new Error(`breakdown.json: ${v.id}: every item needs a unique id (letters, digits, _ -)`);
      I.add(it.id);
      if (!KINDS.includes(it.kind) || typeof it.name !== 'string' || !it.name.trim() || !Array.isArray(it.links)) throw new Error(`breakdown.json: ${v.id}/${it.id}: kind, name, links[] expected`);
      for (const l of it.links) if (!l || typeof l.scene !== 'string' || !ITEM_ID.test(l.scene) || (l.beats != null && (!Array.isArray(l.beats) || l.beats.some(b => typeof b !== 'string' || !BEAT_ID.test(b))))) throw new Error(`breakdown.json: ${v.id}/${it.id}: a link is {scene, beats[]}`);
    }
  }
  if (d.versions.length && !ids.has(d.current)) throw new Error('breakdown.json: current must name a version');
  for (const [k, v] of Object.entries(d.states || {})) {
    if (!ITEM_ID.test(k) || !v || !ITEM_STATUSES.includes(v.status)) throw new Error(`breakdown.json: states.${k}.status must be one of ${ITEM_STATUSES.join(', ')}`);
    if (v.entity_id != null && (typeof v.entity_id !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/.test(v.entity_id))) throw new Error(`breakdown.json: states.${k}.entity_id`);
  }
  return d;
}

// ------------------------------------------------------------------ director tools (on a list of items; return the new list)
export function mergeItems(items, keepId, otherIds) {
  const keep = items.find(i => i.id === keepId); if (!keep) throw new Error(`no item ${keepId}`);
  const others = otherIds.filter(id => id !== keepId).map(id => items.find(i => i.id === id)).filter(Boolean);
  const out = structuredClone(keep), by = new Map(out.links.map(l => [l.scene, l]));
  for (const o of others) {
    for (const l of o.links) { const x = by.get(l.scene); if (x) { x.beats = [...new Set([...x.beats, ...l.beats])]; if (l.note) x.note = x.note ? `${x.note}; ${l.note}` : l.note; } else { const c = structuredClone(l); out.links.push(c); by.set(c.scene, c); } }
    out.aliases = [...new Set([...(out.aliases || []), o.name, ...(o.aliases || [])])].filter(a => a.toLowerCase() !== out.name.toLowerCase());
    if (o.description && !out.description.includes(o.description)) out.description = out.description ? `${out.description}\n${o.description}` : o.description;
  }
  if (!out.aliases?.length) delete out.aliases;
  const gone = new Set(others.map(o => o.id));
  // wardrobe that belonged to a merged character now belongs to the kept one
  return items.filter(i => !gone.has(i.id)).map(i => i.id === keepId ? out : (gone.has(i.for) ? { ...i, for: keepId } : i));
}
// a copy of the item under a new name (same kind, the scenes chosen go with it; none chosen = all links copied)
export function splitItem(items, id, newId, name, scenes) {
  const it = items.find(i => i.id === id); if (!it) throw new Error(`no item ${id}`);
  const move = scenes?.length ? new Set(scenes) : null;
  const copy = { ...structuredClone(it), id: newId, name, source: 'director', links: structuredClone(move ? it.links.filter(l => move.has(l.scene)) : it.links) };
  delete copy.aliases; delete copy.dropped;
  const rest = move ? { ...it, links: it.links.filter(l => !move.has(l.scene)) } : it;
  const i = items.indexOf(it);
  return [...items.slice(0, i), rest, copy, ...items.slice(i + 1)];
}
export function toggleLink(item, scene, on) {
  const has = item.links.some(l => l.scene === scene);
  if (on == null) on = !has;
  if (on && !has) item.links.push({ scene, beats: [] });
  if (!on && has) item.links = item.links.filter(l => l.scene !== scene);
  return on;
}
// keep links in scene order (by the given scene list), unknown scenes last
export const sortLinks = (item, scenes) => { const o = new Map((scenes || []).map((s, i) => [s.id, i])); item.links.sort((a, b) => (o.get(a.scene) ?? 1e9) - (o.get(b.scene) ?? 1e9)); return item; };

// ------------------------------------------------------------------ text, diff
export function breakdownText(v) {
  return KINDS.map(k => (v?.items || []).filter(i => i.kind === k)).filter(l => l.length).map(l => `[${KIND_LABEL[l[0].kind]}]\n` + l.map(i =>
    `${i.dropped ? '(dropped) ' : ''}${i.name}${i.aliases?.length ? ` (aka ${i.aliases.join(', ')})` : ''}: ${i.links.map(x => x.scene + (x.beats.length ? '/' + x.beats.join('+') : '')).join(' ') || 'no scenes'}${i.description ? ' · ' + i.description.replace(/\s+/g, ' ') : ''}`).join('\n')).join('\n\n');
}
export function itemChanges(a, b) {
  const A = new Map((a?.items || []).map(s => [s.id, s])), B = new Map((b?.items || []).map(s => [s.id, s]));
  return { added: [...B.keys()].filter(k => !A.has(k)), removed: [...A.keys()].filter(k => !B.has(k)), changed: [...B.keys()].filter(k => A.has(k) && JSON.stringify(A.get(k)) !== JSON.stringify(B.get(k))) };
}

// ------------------------------------------------------------------ "Suggest from script": a deterministic pre-pass
// Looks at the current script (scene titles, text, beats) and the intake answers "who" / "where" (and "must"), so the
// director has a first list without an agent. Capitalised names (not only at the start of a sentence; or the name of
// an existing entity, `known`) become
// characters, or locations after "in / at / inside / to …"; intake "who" lines become characters and "where" lines
// locations; garments after "wearing / dressed in / her / his …" wardrobe; a short list of objects props; a short list
// of effects FX. Each suggestion is linked to the scenes and beats that mention it. Returns [{kind, name, description,
// links, for?}] (no ids); the caller merges them with what exists.
const STOP = new Set(('the a an and but or so then when while as at in on of to from with into out up down over under he she they we i you it his her their our my your its this that these those there here '
  + 'night day morning evening noon dawn dusk close cut wide shot camera slow fast intro verse chorus bridge outro pre hook drop back black white fade everyone everybody nobody someone something nothing '
  + 'all no yes oh ah not just only still again after before now later inside outside behind above below across through along around near far end start title scene beat lyrics int ext pov cu ms ws ecu '
  + 'monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december god ok okay hey suddenly finally meanwhile '
  + 'one two three four five first last next other another every each some many few more most very also even ever never always maybe perhaps').split(/\s+/));
const LOC_PREP = new Set(['in', 'at', 'inside', 'into', 'to', 'from', 'outside', 'near', 'across', 'through', 'toward', 'towards', 'onto', 'leaving', 'enters', 'enter', 'reaches']);
const GARMENTS = 'coat|dress|jacket|hoodie|suit|shirt|t-shirt|hat|cap|scarf|boots|shoes|sneakers|trainers|gloves|uniform|gown|skirt|jeans|trousers|pants|sweater|jumper|cardigan|raincoat|overalls|mask|veil|glasses|sunglasses|necklace|earrings|ring|bracelet|tie|vest|cape|robe|kimono|leotard|tracksuit|apron|helmet|wig|costume|outfit|blazer|parka|hood|beanie|heels|sandals|socks|belt|shorts|pyjamas|bikini|swimsuit|tuxedo|corset';
const PROPS = 'phone|guitar|microphone|mic|car|bus|bike|bicycle|motorbike|umbrella|letter|bottle|camera|candle|mirror|television|tv|radio|cigarette|book|key|keys|suitcase|bag|map|photo|photograph|polaroid|flower|flowers|rose|roses|knife|gun|lamp|lantern|clock|watch|ticket|tickets|cassette|record|vinyl|headphones|computer|laptop|screen|piano|drum|drums|ball|balloon|balloons|box|chair|table|bed|cup|mug|lighter|matches|rope|boat|train|tape|notebook|pen|envelope|wine|cake|gift|doll|teddy|skateboard|walkman|boombox|torch|flashlight|telescope|globe|typewriter|synth|synthesizer|keyboard|bench|sofa|couch';
const FX = ['smoke', 'fog', 'haze', 'rain', 'snow', 'fire', 'flames', 'sparks', 'explosion', 'glitch', 'strobe', 'lens flare', 'light leak', 'slow motion', 'slow-motion', 'time-lapse', 'timelapse', 'freeze frame', 'double exposure', 'split screen',
  'confetti', 'lightning', 'flicker', 'dissolve', 'morph', 'particles', 'bubbles', 'dust', 'ash', 'laser', 'lasers', 'projection', 'hologram', 'underwater', 'rewind', 'reverse motion', 'datamosh', 'vhs', 'film grain', 'neon'];
const RE_WEAR = new RegExp(`\\b(?:wear(?:s|ing)?|dressed in|in (?:a|an|her|his|their|a pair of))\\s+((?:[a-z][a-z-]*\\s+){0,3}?(?:${GARMENTS}))\\b`, 'gi');
const RE_GARMENT = new RegExp(`\\b(?:her|his|their|a|an)\\s+((?:[a-z][a-z-]*\\s+){0,2}?(?:${GARMENTS}))\\b`, 'gi');
const RE_PROP = new RegExp(`\\b(?:a|an|the|her|his|their|its|my|your)\\s+((?:[a-z][a-z-]*\\s+){0,2}?(?:${PROPS}))\\b`, 'gi');
const RE_FX = new RegExp(`\\b(${FX.map(x => x.replace(/[-\s]/g, '[-\\s]?')).join('|')})\\b`, 'gi');
const cap1 = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const ADJ_STOP = new Set(['the', 'a', 'an', 'her', 'his', 'their', 'its', 'my', 'your', 'old', 'same', 'other', 'little', 'big']);
const cleanPhrase = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim().split(' ').filter((w, i, a) => !(i < a.length - 1 && ADJ_STOP.has(w))).join(' ');
const head = (s) => s.split(' ').pop();
// the character named last in a text (by position): whose garment "her coat" / "wearing a coat" is
const lastMentioned = (cands, text) => { let best = null, at = -1; for (const c of cands) for (const n of c.mentions) { const re = new RegExp(mentionRe(n).source, 'giu'); for (const m of text.matchAll(re)) if (m.index > at) { at = m.index; best = c; } } return best; };
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentionRe = (name) => new RegExp(`(^|[^\\p{L}\\p{N}])${esc(name).replace(/[-\s]+/g, '[-\\s]+')}(?:'s|’s)?(?![\\p{L}\\p{N}])`, 'iu');

// every text of the script with where it sits: {scene, beat?, text}
export function scriptTexts(scenes) {
  const out = [];
  for (const s of scenes || []) {
    out.push({ scene: s.id, text: [s.title, s.text].filter(Boolean).join('. ') });
    for (const b of s.beats || []) out.push({ scene: s.id, beat: b.id, text: b.text || '' });
  }
  return out;
}
// the scenes (and beats) whose text mentions one of the names: [{scene, beats}]
export function linksFor(names, scenes) {
  const res = names.filter(Boolean).map(mentionRe), by = new Map();
  for (const t of scriptTexts(scenes)) {
    if (!res.some(r => r.test(t.text))) continue;
    const l = by.get(t.scene) || { scene: t.scene, beats: [] }; by.set(t.scene, l);
    if (t.beat && !l.beats.includes(t.beat)) l.beats.push(t.beat);
  }
  return [...by.values()];
}
const splitList = (s) => String(s || '').split(/[,;\n/]|\band\b|\by\b|\bet\b|\+|&/i).map(x => x.replace(/\(.*?\)/g, '').replace(/^\s*(?:the|a|an|el|la|els|les|un|una)\s+/i, '').replace(/[.:!?"“”]+/g, '').replace(/\s+/g, ' ').trim())
  .filter(x => x && x.length <= 40 && x.split(' ').length <= 5 && !/^(nobody|no one|none|nothing|nadie|ningú|n\/a|-|tbd|\?)$/i.test(x));

export function suggestItems(scenes, intake = {}, known = []) {
  const texts = scriptTexts(scenes), cand = new Map();   // key -> {kind, name, votes{kind: n}, from: Set, for?}
  const add = (kind, name, from, extra = {}) => {
    const key = (kind === 'prop' || kind === 'wardrobe' || kind === 'fx' ? kind + ':' : 'n:') + (kind === 'prop' ? head(name) : name).toLowerCase();
    const c = cand.get(key) || { kind, name, votes: {}, from: new Set(), mentions: new Set([name]) };
    c.votes[kind] = (c.votes[kind] || 0) + 1; c.from.add(from); c.mentions.add(name);
    if (extra.for && !c.for) c.for = extra.for;
    cand.set(key, c);
  };
  // capitalised names; one that only ever opens a sentence counts when it also appears mid-sentence or in the intake
  const intakeNames = new Set([...splitList(intake.who?.text), ...splitList(intake.where?.text), ...known].map(x => String(x).toLowerCase()));
  const found = [];
  for (const t of texts) {
    const toks = [...t.text.matchAll(/[\p{L}][\p{L}'’-]*|[.!?:—–(]|\n/gu)].map(m => m[0]);
    for (let i = 0; i < toks.length; i++) {
      const w = toks[i];
      if (w.replace(/['’]s$/, '').length < 2 || !/^\p{Lu}/u.test(w) || STOP.has(w.toLowerCase().replace(/['’]s$/, '')) || (w.length > 3 && w === w.toUpperCase())) continue;
      const startOfSentence = i === 0 || /^[.!?:—–(\n]$/.test(toks[i - 1]);
      const parts = [w.replace(/['’]s$/, '')]; let j = i + 1;
      while (j < toks.length) {
        if (/^\p{Lu}/u.test(toks[j]) && !STOP.has(toks[j].toLowerCase())) { parts.push(toks[j].replace(/['’]s$/, '')); j++; continue; }
        if (/^(de|del|la|of|van|von|da|dos|el)$/.test(toks[j]) && /^\p{Lu}/u.test(toks[j + 1] || '')) { parts.push(toks[j], toks[j + 1].replace(/['’]s$/, '')); j += 2; continue; }
        break;
      }
      const prev = (toks[i - 1] || '').toLowerCase();
      found.push({ name: parts.join(' '), mid: !startOfSentence, loc: LOC_PREP.has(prev), t });
      i = j - 1;
    }
  }
  const midNames = new Set(found.filter(f => f.mid).map(f => f.name.toLowerCase()));
  for (const f of found) {
    if (!f.mid && !midNames.has(f.name.toLowerCase()) && !intakeNames.has(f.name.toLowerCase())) continue;
    add(f.loc ? 'location' : 'character', f.name, f.t.beat ? 'beats' : 'scene text');
  }
  for (const n of splitList(intake.who?.text)) add('character', cap1(n), 'the intake (who)');
  for (const n of splitList(intake.where?.text)) add('location', cap1(n), 'the intake (where)');
  // wardrobe, props, FX from the script text (and the must-haves)
  const chars = () => [...cand.values()].filter(c => c.kind === 'character');
  for (const t of [...texts, { text: String(intake.must?.text || ''), intake: true }]) {
    const from = t.intake ? 'the intake (must-haves)' : t.beat ? 'beats' : 'scene text';
    for (const re of [RE_WEAR, RE_GARMENT]) for (const m of t.text.matchAll(re)) {
      const name = cleanPhrase(m[1]);
      const before = t.text.slice(0, m.index), owner = /\b(?:his|her|their)\s/i.test(m[0]) || /^wear|^dressed/i.test(m[0]) ? lastMentioned(chars(), before) : null;
      add('wardrobe', name, from, owner ? { for: owner.name } : {});
    }
    for (const m of t.text.matchAll(RE_PROP)) add('prop', cleanPhrase(m[1]), from);
    for (const m of t.text.matchAll(RE_FX)) add('fx', m[1].toLowerCase().replace(/\s+/g, ' '), from);
  }
  const out = [];
  for (const c of cand.values()) {
    const kind = Object.entries(c.votes).sort((a, b) => b[1] - a[1])[0][0];
    const names = [...c.mentions];
    out.push({ kind, name: cap1(c.name), description: `suggested from ${[...c.from].join(', ')}`, links: linksFor(names, scenes), ...(c.for ? { for: c.for } : {}) });
  }
  return out.sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || b.links.length - a.links.length || a.name.localeCompare(b.name));
}
// merge suggestions into a list of items: an item with the same name (or alias) gains the missing links; the rest are
// new items (ids from nextId). Returns {items, added: [ids], updated: [ids]}
export function mergeSuggestions(items, sugg, nextId) {
  const out = structuredClone(items), added = [], updated = [];
  const byName = (n) => out.find(i => [i.name, ...(i.aliases || [])].some(x => x.toLowerCase() === n.toLowerCase()));
  for (const s of sugg) {
    const ex = byName(s.name);
    if (ex) {
      let ch = false;
      for (const l of s.links) { const x = ex.links.find(y => y.scene === l.scene); if (!x) { ex.links.push(structuredClone(l)); ch = true; } else { const nb = l.beats.filter(b => !x.beats.includes(b)); if (nb.length) { x.beats.push(...nb); ch = true; } } }
      if (ch && !updated.includes(ex.id)) updated.push(ex.id);
      continue;
    }
    const id = nextId(out);
    out.push({ id, kind: s.kind, name: s.name, description: s.description, links: structuredClone(s.links), source: 'director', ...(s.for ? { for: s.for } : {}) });
    added.push(id);
  }
  // wardrobe "for" names -> the character item's id
  for (const i of out) if (i.kind === 'wardrobe' && i.for && !out.some(x => x.id === i.for)) { const c = out.find(x => x.kind === 'character' && x.name.toLowerCase() === String(i.for).toLowerCase()); if (c) i.for = c.id; else delete i.for; }
  return { items: out, added, updated };
}
