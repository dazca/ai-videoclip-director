// Identity checks (ROADMAP_v4 D7) and character constants (D2). Pure functions, no DOM and no Node APIs: the page (the
// node badges of tabs/assetws.js, the take cards of tabs/takes.js, the constants editor of the Characters stage) and the
// data layer (lib/ops/checks.mjs, lib/ops/assets.mjs) import the same code.
//
// CONSTANTS (D2) live on a character entity: constants[] = the details that must stay identical in every image. Each one
// is a string (older files) or {text, check?: bool (default true: it is on the identity checklist), label?: a short name
// for a badge, "clip side"}. The photoreal recipe puts every constant into the identity lock (js/recipe.js constantsOf);
// the checklist is the ones with check !== false.
//
// checks.json (the server's; the page reads it):
//   {v: 1, rev, checks: [Check], asks: [Ask]}
//   Check {id "ck03", target: {kind: node | take | media, id}, against: {entity, node}, by, via: "agent", verdict: ok | drift |
//          fail, items: [{constant, ok, note?}], note, score?: {model, value, threshold?, metric?}, created}
//     target ids: node "<entity>/<node>" (an iteration node), take "<shot>/<media id>" (a take of a storyboard shot), media
//     "<media id>" (any registered image or video)
//     against: the character and the node whose image it was compared with (its approved identity node by default)
//     score: the OPTIONAL local face-embedding score (tools/face-score.md); nothing in the workbench computes it
//   Ask   {note, entity, against, files: [{file, media?, node?, shot?, target}], source, at}: the "identity check" ask the
//         server wrote when outputs landed (settings.json identity_checks: true), so one output is asked about once
// A check is information for the director: it never approves, rejects or picks anything.
export const VERDICTS = ['ok', 'drift', 'fail'];
export const TARGET_KINDS = ['node', 'take', 'media'];
export const CONST_MAX = 24, CONST_TEXT_MAX = 200, CONST_LABEL_MAX = 40, ITEMS_MAX = 40, ITEM_NOTE_MAX = 500, NOTE_MAX = 2000;
export const LIKENESS = 'likeness';   // a built-in checklist item: the face as a whole
const ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;
export const NODE_TARGET = /^([A-Za-z0-9_][A-Za-z0-9_-]{0,63})\/(n\d{1,5})$/;
export const TAKE_TARGET = /^([A-Za-z0-9_][A-Za-z0-9_.:-]{0,63})\/([A-Za-z0-9_][A-Za-z0-9_.@-]{0,127})$/;
export const MEDIA_ID = /^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,127}$/;
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
export const emptyChecks = () => ({ v: 1, rev: 0, checks: [], asks: [] });
export function normChecks(d) {
  if (!d || typeof d !== 'object') return emptyChecks();
  return { v: 1, rev: d.rev || 0, checks: Array.isArray(d.checks) ? d.checks.filter(c => c && typeof c === 'object' && c.target) : [], asks: Array.isArray(d.asks) ? d.asks.filter(a => a && typeof a === 'object') : [] };
}

// ------------------------------------------------------------------ constants (D2)
// one constant -> {text, check, label?} (a string is a checked constant)
export function constantOf(x) {
  const text = clean(typeof x === 'string' ? x : x?.text, CONST_TEXT_MAX); if (!text) return null;
  const label = typeof x === 'object' && x ? clean(x.label, CONST_LABEL_MAX) : '';
  return { text, check: !(typeof x === 'object' && x && x.check === false), ...(label ? { label } : {}) };
}
export const constantsList = (ent) => (Array.isArray(ent?.constants) ? ent.constants : []).map(constantOf).filter(Boolean).slice(0, CONST_MAX);
export const checklist = (ent) => constantsList(ent).filter(c => c.check);
// the editor's save: strings or {text, check, label}; duplicates (same text) dropped; at most CONST_MAX
export function cleanConstants(list) {
  if (!Array.isArray(list)) throw Object.assign(new Error('constants: a list of {text, check?, label?}'), { code: 400 });
  const out = [], seen = new Set();
  for (const x of list) { const c = constantOf(x); if (!c || seen.has(c.text.toLowerCase())) continue; seen.add(c.text.toLowerCase()); out.push(c); }
  if (out.length > CONST_MAX) throw Object.assign(new Error(`constants: at most ${CONST_MAX}`), { code: 400 });
  return out;
}
// a short name for a constant in a badge: its label, else its first words ("orange starburst clip")
export const shortName = (c) => c?.label || String((typeof c === 'string' ? c : c?.text) || '').replace(/\(.*?\)/g, '').split(/\s+/).filter(Boolean).slice(0, 3).join(' ');
// "Seed from base": candidate constants from the character's base description (sentences and "+" / ";" clauses that name a
// detail), the ones already there left out. The director keeps, edits or drops each before saving.
export function seedConstants(text, existing = []) {
  const have = new Set(existing.map(c => String(c?.text || c).toLowerCase()));
  const parts = String(text || '').split(/[\n;.]+|\s\+\s/).map(s => clean(s.replace(/^[-*•]\s*/, ''), CONST_TEXT_MAX)).filter(s => s.length >= 4 && s.split(/\s+/).length >= 2);
  const out = [];
  for (const s of parts) { const k = s.toLowerCase(); if (have.has(k) || out.some(o => o.text.toLowerCase() === k)) continue; out.push({ text: s, check: true }); }
  return out.slice(0, CONST_MAX);
}
// a checklist item's constant -> the entity's constant text (case-insensitive), "likeness", or an index into the checklist
export function matchConstant(ent, c) {
  const list = constantsList(ent);
  if (Number.isInteger(c)) return list[c]?.text ?? null;
  const s = clean(c, CONST_TEXT_MAX).toLowerCase(); if (!s) return null;
  if (s === LIKENESS) return LIKENESS;
  return list.find(x => x.text.toLowerCase() === s || (x.label && x.label.toLowerCase() === s))?.text ?? null;
}

// ------------------------------------------------------------------ targets
export const targetKey = (t) => `${t?.kind}:${t?.id}`;
export function cleanTarget(t) {
  if (!t || typeof t !== 'object' || !TARGET_KINDS.includes(t.kind)) throw Object.assign(new Error(`target: {kind: ${TARGET_KINDS.join(' | ')}, id}`), { code: 400 });
  const id = String(t.id ?? '');
  const ok = t.kind === 'node' ? NODE_TARGET.test(id) : t.kind === 'take' ? TAKE_TARGET.test(id) : MEDIA_ID.test(id);
  if (!ok) throw Object.assign(new Error(t.kind === 'node' ? 'target.id: "<entity>/<node>" (ada/n03)' : t.kind === 'take' ? 'target.id: "<shot>/<media id>" (a take of that shot: takes_get)' : 'target.id: a media id (media_list)'), { code: 400 });
  return { kind: t.kind, id };
}
export const entityIdOk = (s) => typeof s === 'string' && ID_RE.test(s);

// ------------------------------------------------------------------ reads for the badges
const byTime = (a, b) => String(b.created || '').localeCompare(String(a.created || '')) || String(b.id).localeCompare(String(a.id));
// the checks of a node: on the node itself, or on the media file that is its image
export function nodeChecks(doc, entId, node, media = []) {
  const img = String(node?.image || '').toLowerCase(), mids = new Set(media.filter(m => String(m.path || '').toLowerCase() === img).map(m => m.id));
  return (doc?.checks || []).filter(c => (c.target.kind === 'node' && c.target.id === `${entId}/${node?.id}`) || (c.target.kind === 'media' && mids.has(c.target.id))
    || (c.target.kind === 'take' && mids.has(c.target.id.split('/').slice(1).join('/')))).sort(byTime);
}
// the checks of a take (a media file in a shot): on the take, or on the media
export const takeChecks = (doc, shotId, mediaId) => (doc?.checks || []).filter(c => (c.target.kind === 'take' && c.target.id === `${shotId}/${mediaId}`) || (c.target.kind === 'media' && c.target.id === mediaId)
  || (c.target.kind === 'take' && c.target.id.endsWith('/' + mediaId))).sort(byTime);
// the latest check's badge: "identity ok" / "drift" / "✗ clip side" (the first failed constant) / "✗ identity"
export function badge(check, ent = null) {
  if (!check) return null;
  const failed = (check.items || []).filter(i => i.ok === false);
  const nameOf = (txt) => { if (txt === LIKENESS) return 'likeness'; const c = constantsList(ent).find(x => x.text === txt); return shortName(c || txt); };
  if (failed.length) return { cls: 'fail', label: `✗ ${nameOf(failed[0].constant)}${failed.length > 1 ? ` +${failed.length - 1}` : ''}` };
  if (check.verdict === 'fail') return { cls: 'fail', label: '✗ identity' };
  if (check.verdict === 'drift') return { cls: 'drift', label: 'drift' };
  return { cls: 'ok', label: 'identity ok' };
}
// the open asks with what is still unchecked in each
export function askState(doc, ask) {
  const keys = new Set((doc?.checks || []).map(c => targetKey(c.target)));
  const left = (ask.files || []).filter(f => !keys.has(targetKey(f.target)));
  return { ...ask, unchecked: left.length, left };
}
