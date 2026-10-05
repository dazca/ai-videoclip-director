// The proposals strip (docs/SPEC_v4_NOTES_ROUNDS.md §3; ROADMAP_v4 B10-B11): a compact row of cards next to a target
// that has proposals (a scene's sketch or idea, a shot's frame, a lyric line, a look, a location variant). Each card is
// an SVG (shown as <img src>: an SVG in an image never runs script; the server sanitised it too) or a short text, with
// its title and why, and four acts:
//   Pick     the director's (page only: POST /api/op/proposal_act). The stage applies it: an SVG becomes the scene
//            sketch's underlay / the frame sketch's base layer (mountSketch's underlay), a text fills the line / the
//            scene text / the shot action in the draft. One undo step (Ctrl+Z) puts both back.
//   Mix      pick + a note to the agent saying what to change (a note on the target, in the next round)
//   3 more   an ask for the agent on the target (notes.json, ask "proposals"); its next proposals_add answers it
//   ×        dismiss
// Plus "Prepare proposals" (Generate menu, palette): an ask for the agent on a stage; and the free local generator
// (js/proposals-local.js, run by the server: proposals_local) that makes 3 layouts per scene / shot with no agent.
//   stripHtml(target, {compact?, quiet?, local?}) -> html   the strip (compact: tiny thumbnails in a closed row; quiet:
//                            nothing when the target has no proposals, else an "ask for 3" line)
//   register(stage, apply)   apply({target, set, item, act}) -> {undo, redo} | null: what a pick does in that stage
//   offerPrepare(stage)      after a stage is saved: a small offer ("Prepare starting proposals?"), never run by itself
//   WB.proposals             {act, more, prepare, local, sets, open(target)} for the console and the tests
import { store, esc, toast, postJSON, mediaUrl, prefs, PROJECT } from '../js/store.js';
import * as P from '../js/proposals.js';
import * as N from '../js/notes.js';
import { commands } from './commands.js';
import { menus } from './menus.js';
import { ui } from './palette.js';
import { history } from './history.js';

const WB = () => window.WB;
const appliers = {};
export const register = (stage, fn) => { appliers[stage] = fn; };
const LOCAL = (t) => (t.stage === 'script' && t.kind === 'scene') || (t.stage === 'storyboard' && t.kind === 'shot');
const tAttr = (t) => `data-ts="${esc(t.stage)}" data-tk="${esc(t.kind)}" data-ti="${esc(t.id ?? '')}"`;
const tOf = (el) => { const e = el.closest('[data-ts]'); return e ? { stage: e.dataset.ts, kind: e.dataset.tk, id: e.dataset.ti || null } : null; };
const asksOn = (t) => (store.notes?.notes || []).filter(n => n.status === 'open' && n.to === 'agent' && n.ask === 'proposals' && N.sameTarget(n.target, t));
const folded = new Set(prefs.get('ppFolded:' + PROJECT, []));

function cardHtml(s, i) {
  const st = i.status, pk = P.isPicked(i);
  const media = i.svg ? `<img src="${esc(mediaUrl(i.svg))}" alt="" loading="lazy" data-pp="zoom" title="click: larger">` : `<div class="ppx" title="${esc(i.text)}">${esc(i.text)}</div>`;
  const acts = pk ? `<b data-pp="reopen" title="undo the pick (Ctrl+Z also works)">unpick</b>` : `<b data-pp="pick" class="pri" title="pick it: ${esc(P.pickEffect(s.target, i))}">Pick</b><b data-pp="mix" title="pick it and tell the agent what to change (a note on this ${esc(s.target.kind)})">Mix</b><b data-pp="dismiss" title="dismiss">×</b>`;
  return `<div class="ppc s-${st}${i.svg ? ' svg' : ' txt'}" data-set="${esc(s.id)}" data-item="${esc(i.id)}">${media}`
    + `<div class="ppti" title="${esc(`${s.id}/${i.id} · ${i.title}${i.why ? '\n' + i.why : ''}`)}">${pk ? `<i class="ppok">✓ ${st}</i>` : ''}${esc(i.title)}</div>`
    + (pk && i.note ? `<div class="ppw ppnote" title="${esc(i.note)}">“${esc(i.note)}”</div>` : i.why ? `<div class="ppw" title="${esc(i.why)}">${esc(i.why)}</div>` : '')
    + `<div class="ppa">${acts}</div></div>`;
}
// the strip for a target ('' when nothing to show)
export function stripHtml(target, { compact = false, quiet = false, local = LOCAL(target), label } = {}) {
  if (!store.proposals || !target) return '';
  const sets = P.setsFor(store.proposals, target), asks = asksOn(target);
  const items = sets.flatMap(s => s.items.filter(i => i.status !== 'dismissed').map(i => [s, i]));
  if (compact) {
    if (!items.length) return '';
    const open = items.filter(([, i]) => i.status === 'open').length, pk = items.find(([, i]) => P.isPicked(i));
    return `<div class="pps mini" ${tAttr(target)} title="${esc(`${items.length} proposal(s)${pk ? ` · picked “${pk[1].title}”` : ''}: open it to choose`)}"><span class="ppl">◇ ${pk ? '✓' : open}</span>${items.slice(0, 3).map(([, i]) => i.svg ? `<img src="${esc(mediaUrl(i.svg))}" alt="" loading="lazy" class="${P.isPicked(i) ? 'pk' : ''}">` : `<span class="ppmt${P.isPicked(i) ? ' pk' : ''}">${esc(i.title)}</span>`).join('')}</div>`;
  }
  const waiting = asks.length ? `<span class="ppwait" title="${esc(asks[0].text)}">3 more asked · waiting for the agent</span>` : '';
  if (!items.length) {
    if (quiet && !asks.length) return '';
    return `<div class="pps none" ${tAttr(target)}><span class="ppl">◇ proposals</span>${waiting}<span class="sp"></span>${asks.length ? '' : `<a data-pp="more" title="ask the agent for 3 proposals (a note to the agent on this ${esc(target.kind)}; free)">ask for 3</a>`}${local ? `<a data-pp="local" title="3 free layouts made here from the script (wide / medium / close, thirds, a camera arrow): no agent, no cost">3 free layouts</a>` : ''}</div>`;
  }
  const key = P.keyOf(target), fold = folded.has(key), n = items.length, sids = [...new Set(items.map(([s]) => s.id))];
  const src = [...new Set(sets.filter(s => sids.includes(s.id)).map(s => s.source === 'local' ? 'local' : s.via === 'page' ? 'page' : 'agent'))].join(' + ');
  const head = `<div class="ppsh"><b class="ppl">◇ ${n} proposal${n > 1 ? 's' : ''}</b><span class="dim">${esc(label || '')}${label ? ' · ' : ''}${esc(sids.join(' '))} · ${esc(src)}</span>${waiting}<span class="sp"></span>`
    + `${asks.length ? '' : `<a data-pp="more" title="ask the agent for 3 more, different ones (a note to the agent; free)">3 more</a>`}${local ? `<a data-pp="local" title="3 more free layouts made here (no agent)">+3 free</a>` : ''}<a data-pp="fold" title="${fold ? 'show' : 'hide'} the cards">${fold ? '▾' : '▴'}</a></div>`;
  return `<div class="pps${fold ? ' folded' : ''}" ${tAttr(target)}>${head}${fold ? '' : `<div class="ppcards">${items.map(([s, i]) => cardHtml(s, i)).join('')}</div>`}</div>`;
}

// ------------------------------------------------------------------ the acts
async function op(name, body) {
  const r = await postJSON('/api/op/' + name, body), j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
const refresh = () => store.reload(['proposals.json']);
async function act(set, item, a, { note } = {}) {
  const s = store.proposals?.sets.find(x => x.id === set), it = s?.items.find(x => x.id === item);
  if (!s || !it) return toast(`no proposal ${set}/${item}`);
  if (a === 'mix' && note == null) { note = await ui.prompt({ title: `Mix “${it.title}”: what should the agent change?`, placeholder: 'e.g. this framing, but at night and closer' }); if (!note || !note.trim()) return; }
  let r;
  try { r = await op('proposal_act', { set, item, act: a, ...(note ? { note } : {}) }); } catch (e) { return toast('proposal: ' + e.message); }
  await refresh();
  if (a === 'dismiss' || a === 'reopen') {
    history.push({ label: `${a} proposal ${set}/${item}`, undo: async () => { await op('proposal_act', { set, act: 'restore', states: r.before }); await refresh(); }, redo: async () => { await op('proposal_act', { set, item, act: a }); await refresh(); } });
    return r;
  }
  // pick / mix: the stage applies it (sketch underlay, text), one undo step for both
  let fx = null;
  try { fx = await appliers[s.target.stage]?.({ target: s.target, set: s, item: it, act: a }) || null; } catch (e) { toast('picked, but not applied: ' + (e.message || e)); }
  history.push({ label: `${a} proposal ${set}/${item}`,
    undo: async () => { await fx?.undo?.(); await op('proposal_act', { set, act: 'restore', states: r.before }); if (r.note) await store.deleteNotes([r.note]); await refresh(); },
    redo: async () => { await op('proposal_act', { set, item, act: 'pick' }); await fx?.redo?.(); await refresh(); } });
  toast(`${a === 'mix' ? 'mixed' : 'picked'} “${it.title}”${fx?.what ? ': ' + fx.what : ''}${a === 'mix' ? ' · your note goes to the agent' : ''}`);
  return r;
}
// "3 more" on a target: one ask for the agent (its next proposals_add on the target answers it)
async function more(target) {
  if (asksOn(target).length) return toast('already asked: the agent has an open "3 more" on this');
  const text = P.moreText(target, P.setsFor(store.proposals, target, { all: true }));
  await store.noteAdd(target, text, { to: 'agent', ask: 'proposals', about: 'proposals:' + P.keyOf(target) });
  toast('asked the agent for 3 more (a note to the agent: it goes in the next round)');
}
// the free local generator (no agent): scenes and / or shots, or one target
async function local({ scope = 'all', target } = {}) {
  try {
    const r = await op('proposals_local', { scope, ...(target ? { target } : {}) });
    await refresh();
    toast(r.added.length ? `${r.added.length * 3} free layouts made (${r.added.length} set${r.added.length > 1 ? 's' : ''})${r.skipped.length ? ` · ${r.skipped.length} already had open ones` : ''}` : `nothing new: ${r.skipped.length ? 'every target already has open proposals' : 'no scenes or shots yet'}`);
    return r;
  } catch (e) { toast('layouts: ' + e.message); return null; }
}
// "Prepare proposals": an ask for the agent on a stage (it adds sets where they help most, then resolves the ask)
async function prepare(stage) {
  if (!stage) {
    const cur = WB()?.stages?.current?.();
    stage = P.PREPARE_TEXT[cur] ? cur : await ui.pick({ title: 'Prepare starting proposals for…', items: Object.keys(P.PREPARE_TEXT).map(s => ({ label: N.STAGE_TITLE[s], detail: P.PREPARE_TEXT[s].slice(0, 90) + '…', value: s })) });
    if (!stage) return;
  }
  const t = { stage, kind: 'stage', id: null };
  if (asksOn(t).length) return toast(`already asked: the agent has an open "Prepare proposals" for the ${stage}`);
  await store.noteAdd(t, P.PREPARE_TEXT[stage], { to: 'agent', ask: 'proposals', about: 'proposals:prepare:' + stage });
  toast(`asked the agent to prepare starting proposals for the ${stage} (Notes column, top row)${LOCAL({ stage, kind: stage === 'script' ? 'scene' : 'shot' }) ? ' · or make free layouts now: Generate > Make free layouts' : ''}`);
}

// ------------------------------------------------------------------ the offer (after a stage is saved, after the wizard)
const offered = new Set();
export function offerPrepare(stage, { force = false } = {}) {
  if (!P.PREPARE_TEXT[stage] || (!force && offered.has(stage))) return;
  if (!force && P.targetsOn(store.proposals, stage).length) return;   // it has proposals already
  offered.add(stage);
  document.querySelector('.ppoffer')?.remove();
  const el = document.createElement('div'); el.className = 'ppoffer'; el.setAttribute('role', 'status');
  const loc = stage === 'script' || stage === 'storyboard';
  el.innerHTML = `<b>◇ Prepare starting proposals for the ${esc(stage)}?</b><span class="dim">3 choices per ${stage === 'script' ? 'scene' : stage === 'storyboard' ? 'shot' : stage === 'lyrics' ? 'weak line' : stage === 'characters' ? 'look' : 'variant'}, so you choose instead of starting blank</span><span class="ppob"><button data-o="ask" class="pri" title="a note to the agent (free)">Ask the agent</button>${loc ? '<button data-o="local" title="3 layouts per ' + (stage === 'script' ? 'scene' : 'shot') + ' made here, no agent, no cost">Free layouts now</button>' : ''}<button data-o="no">Not now</button></span>`;
  el.addEventListener('click', async (e) => { const o = e.target.closest('[data-o]')?.dataset.o; if (!o) return; el.remove(); if (o === 'ask') await prepare(stage); else if (o === 'local') await local({ scope: stage }); });
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 20000);
}

// ------------------------------------------------------------------ the large view (click a thumbnail)
function zoom(target, set, item) {
  const s = store.proposals?.sets.find(x => x.id === set), i = s?.items.find(x => x.id === item); if (!i) return;
  document.querySelector('.ppbig')?.remove();
  const el = document.createElement('div'); el.className = 'ppbig';
  el.innerHTML = `<div class="ppbw pps" ${tAttr(target)}><div class="ppc s-${i.status}" data-set="${esc(set)}" data-item="${esc(item)}"><img src="${esc(mediaUrl(i.svg))}" alt=""><div class="ppti"><b>${esc(i.title)}</b> <span class="dim">${esc(set)}/${esc(item)} · ${esc(P.targetLabel(target))}</span></div>${i.why ? `<div class="ppw">${esc(i.why)}</div>` : ''}<div class="ppa">${P.isPicked(i) ? '<b data-pp="reopen">unpick</b>' : '<b data-pp="pick" class="pri">Pick</b><b data-pp="mix">Mix</b><b data-pp="dismiss">Dismiss</b>'}<span class="sp"></span><b data-pp="close">Close (Esc)</b></div></div></div>`;
  el.addEventListener('click', (e) => { if (e.target === el) el.remove(); });
  el.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); el.remove(); } });
  el.tabIndex = -1; document.body.appendChild(el); el.focus();
}

// one listener for every strip on the page (capture: the stage's own click handlers never see these clicks)
document.addEventListener('click', async (e) => {
  const a = e.target.closest?.('.pps [data-pp]'); if (!a) return;
  e.stopPropagation(); e.preventDefault();
  const t = tOf(a), card = a.closest('[data-set]'), pp = a.dataset.pp;
  if (pp === 'close') return a.closest('.ppbig')?.remove();
  if (pp === 'fold') { const k = P.keyOf(t); if (folded.has(k)) folded.delete(k); else folded.add(k); prefs.set('ppFolded:' + PROJECT, [...folded]); store.emit('proposals'); return; }
  if (pp === 'more') return more(t);
  if (pp === 'local') return local({ scope: t.stage === 'script' ? 'script' : 'storyboard', target: t });
  if (pp === 'zoom' && card) return zoom(t, card.dataset.set, card.dataset.item);
  if (card && ['pick', 'mix', 'dismiss', 'reopen'].includes(pp)) { a.closest('.ppbig')?.remove(); return act(card.dataset.set, card.dataset.item, pp); }
}, true);

// the strips show the open "3 more" asks: when those change (a note written or answered), the stages re-render their strips
let askSig = '';
store.on((w) => {
  if (w !== 'notes' && w !== 'all') return;
  const sig = (store.notes?.notes || []).filter(n => n.status === 'open' && n.ask === 'proposals').map(n => n.id).join(',');
  if (sig !== askSig) { askSig = sig; if (w === 'notes') store.emit('proposals'); }
});

// ------------------------------------------------------------------ commands, menus; the wizard's pending offer
commands.register([
  { id: 'proposals.prepare', group: 'Generate', title: 'Prepare proposals: ask the agent for starting choices (scenes, shots, lines, looks)…', run: () => prepare() },
  { id: 'proposals.local', group: 'Generate', title: 'Make free layouts: 3 SVG layouts per scene and shot (no agent, no cost)', run: () => local({ scope: 'all' }) },
]);
menus.contribute('menubar:Generate', ['-', 'proposals.prepare', 'proposals.local']);
// the new-project wizard's "Prepare starting proposals" (the director ticked it there; unticked by default): once the
// new project opens, the ask for the script's starting proposals is written (the agent drafts the scenes first)
if (prefs.get('ppPrepare', null) === PROJECT) {
  prefs.set('ppPrepare', null);
  const go = () => { if (document.body.dataset.ready === '1' && store.notes) prepare('script'); else setTimeout(go, 300); };
  setTimeout(go, 600);
}
window.WB = Object.assign(window.WB || {}, { proposals: { act, more, prepare, local, offer: offerPrepare, sets: (t) => P.setsFor(store.proposals, t, { all: true }), strip: stripHtml } });
