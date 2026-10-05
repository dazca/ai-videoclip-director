// Generation queue: data/<project>/requests.json. The page only writes DRAFT requests and approvals; the agent picks up
// approved ones, sets queued/running, and writes back status done + outputs (or rejected). Cost cap shown on top.
//   {id, kind, target, prompt, refs[], est_cost, status: draft|approved|queued|running|done|rejected, by, at, outputs?[],
//    warnings?[] (request_create's: e.g. a look sheet with no approved identity), recipe? (the photoreal blocks)}
// "+ New request": a draft request from the page. "Apply photoreal recipe" builds the prompt from editable blocks
// (references + identity lock, subject + wardrobe, action, place, light, camera, texture, medium, the avoid guard) for
// the chosen model (js/recipe.js, templates/photoreal_recipe.json, docs/PHOTOREAL.md); the estimate comes from the one
// price table (js/prices.js).
import { store, toast } from '../js/store.js';
import { fmt } from '../js/timeline.js';
import { esc, mediaAttr } from '../core/esc.js';
import { buildRecipe, FIELDS, MODELS, FRAMINGS } from '../js/recipe.js';
import { PRICES, estimateWith } from '../js/prices.js';
const ORDER = ['draft', 'approved'];
const CLS = { draft: '', approved: 's-approved', queued: 's-review', running: 's-review', done: 's-locked', rejected: 's-changes' };
let RECIPE = null;
const loadRecipe = async () => (RECIPE ||= await fetch('/templates/photoreal_recipe.json').then(r => (r.ok ? r.json() : {})).catch(() => ({})));

export default {
  mount(el, ctx) {
    el.classList.add('pane', 'queue');
    el.innerHTML = '<div class="qform" hidden></div><div class="qlist"></div>';
    const $form = el.querySelector('.qform'), $list = el.querySelector('.qlist');
    let filter = '';
    // the new-request form (kept across list re-renders)
    const F = { open: false, kind: 'generate', target: '', refs: '', model: 'nb2', framing: 'full_body', seconds: 5, identity: false, prompt: '', recipe: false, fields: {}, blocks: {}, built: null };
    const timeOf = (k) => { if (!k) return null; const id = k.slice(k.indexOf(':') + 1); return store.shots.find(s => 'shot:' + s.id === k)?.t0 ?? store.uses.find(u => u.id === id)?.t0 ?? store.song.sections.find(s => s.id === id)?.t0 ?? store.song.lines.find(l => l.id === id)?.t0 ?? null; };
    const refsOf = () => F.refs.split(/[,\n]/).map(s => s.trim()).filter(Boolean);
    const rebuild = () => { F.built = buildRecipe(RECIPE, { ...F.fields, model: F.model, framing: F.framing, seconds: F.seconds, identity: F.identity, refs: refsOf().length, name: F.target.includes(':') ? store.entities.find(e => e.id === F.target.split(':')[1])?.name : undefined, blocks: F.blocks }); F.prompt = F.built.prompt; };
    const est = () => F.recipe && F.built ? F.built.est : estimateWith({ model: F.model, tier: PRICES[F.model]?.default, what: MODELS[F.model] === 'video' ? 'image-to-video' : 'one image' }, { seconds: F.seconds });
    const renderForm = () => {
      $form.hidden = !F.open; if (!F.open) return;
      const e = est(), video = MODELS[F.model] === 'video';
      $form.innerHTML = `<div class="qfh"><b>New request</b><span class="dim">a DRAFT: nothing runs or is paid until you approve it</span><span class="sp"></span><a data-q="close">close</a></div>
        <div class="qfrow"><label>kind <input data-f="kind" value="${esc(F.kind)}" spellcheck="false"></label><label>target <input data-f="target" value="${esc(F.target)}" placeholder="character:ada · shot:sh03" spellcheck="false"></label>
        <label>model <select data-f="model">${Object.keys(MODELS).map(m => `<option value="${m}"${m === F.model ? ' selected' : ''}>${esc(PRICES[m].name)}</option>`).join('')}</select></label>
        ${video ? `<label>seconds <input data-f="seconds" type="number" min="1" max="15" value="${F.seconds}" style="width:4em"></label>` : `<label>framing <select data-f="framing">${Object.entries(FRAMINGS).map(([k, l]) => `<option value="${k}"${k === F.framing ? ' selected' : ''}>${esc(l.replace(/ photograph$/, ''))}</option>`).join('')}</select></label>`}
        <label title="image 1 is the approved face / identity: the identity lock block is added"><input type="checkbox" data-f="identity"${F.identity ? ' checked' : ''}> image 1 = the approved identity</label></div>
        <div class="qfrow"><label class="wide">refs <input data-f="refs" value="${esc(F.refs)}" placeholder="paths, comma separated (image 1 first)" spellcheck="false"></label>
        ${F.recipe ? '<span class="qrec on">photoreal recipe applied</span><a data-q="norecipe">remove</a>' : '<button data-q="recipe" class="pri" title="build the prompt from the photoreal recipe\'s blocks for this model (docs/PHOTOREAL.md)">Apply photoreal recipe</button>'}</div>
        ${F.recipe ? `<div class="qfields">${FIELDS.map(x => `<label title="${esc(x.hint)}">${esc(x.label)}<input data-fld="${x.id}" value="${esc(F.fields[x.id] || '')}" placeholder="${esc(x.hint)}" spellcheck="false"></label>`).join('')}</div>
          <div class="qblocks">${F.built.blocks.map(b => `<label class="${/\[fill:/.test(b.text) ? 'unfilled' : ''}${b.edited ? ' edited' : ''}"><span>${esc(b.label)}</span><textarea data-blk="${esc(b.id)}" rows="${Math.min(4, Math.ceil(b.text.length / 110) || 1)}" spellcheck="false">${esc(b.text)}</textarea></label>`).join('')}</div>` : ''}
        <label class="qprompt">prompt <textarea data-f="prompt" rows="4" spellcheck="false">${esc(F.prompt)}</textarea></label>
        <div class="chreqw qwarn">${F.recipe ? F.built.warnings.map(w => `<span>⚠ ${esc(w)}</span>`).join('') : ''}</div>
        ${F.recipe && F.built.negative_prompt ? `<div class="dim">negative prompt: ${esc(F.built.negative_prompt)}</div>` : ''}
        <div class="qfrow"><span>est <b>$${Number(e?.usd || 0).toFixed(2)}</b> <span class="dim">${esc(e?.why || '')}</span></span><span class="sp"></span><button data-q="add" class="pri">Add draft request</button></div>`;
    };
    const render = () => {
      const items = store.requests?.items || [];
      const by = {}; for (const r of items) by[r.status] = (by[r.status] || 0) + 1;
      const spent = (store.costs?.items || []).reduce((s, x) => s + (Number(x.usd) || 0), 0);
      const pending = items.filter(r => ['approved', 'queued', 'running'].includes(r.status)).reduce((s, r) => s + (Number(r.est_cost) || 0), 0);
      const drafts = items.filter(r => r.status === 'draft').reduce((s, r) => s + (Number(r.est_cost) || 0), 0);
      const cap = Number(store.costs?.cap_usd) || 0, pct = cap ? Math.min(100, (spent + pending) / cap * 100) : 0;
      $list.innerHTML = `<div class="bar">spent $${spent.toFixed(2)} + approved/queued $${pending.toFixed(2)} (drafts $${drafts.toFixed(2)}) of cap $${cap} <span class="dim">(all sources: Costs)</span>
        <div class="meter"><i style="width:${pct}%"></i></div>
        ${['', 'draft', 'approved', 'queued', 'running', 'done', 'rejected'].map(s => `<a data-f="${s}" class="${s === filter ? 'picked' : ''}">${s || 'all'}${s ? ' ' + (by[s] || 0) : ' ' + items.length}</a>`).join(' · ')}
        · <a data-q="new" class="qnew">+ New request</a>
        <span class="dim"> · the agent runs approved requests only; right-click a shot / clip / cast chip / card to add one</span></div>
        ${items.length ? `<table class="tbl"><tr><th>status</th><th>kind</th><th>target</th><th>prompt draft</th><th>$ est</th><th>refs / outputs</th><th>at</th><th></th></tr>
        ${items.filter(r => !filter || r.status === filter).slice().reverse().map(r => { const t = timeOf(r.target); return `<tr data-id="${esc(r.id)}" data-sel="request:${esc(r.id)}" class="${(r.warnings || []).length ? 'warn' : ''}">
          <td><span class="chip ${CLS[r.status] || ''}" data-x="cycle" title="click: draft ⇄ approved">${esc(r.status)}</span></td><td>${esc(r.kind)}${r.recipe ? ' <span class="qrec" title="built from the photoreal recipe (its blocks are stored with the request)">recipe</span>' : ''}</td>
          <td>${t != null ? `<a data-t="${Number(t) || 0}">${esc(r.target)} ${fmt(t)}</a>` : esc(r.target || '')}</td>
          <td><textarea data-x="prompt" rows="1" ${['draft', 'approved'].includes(r.status) ? '' : 'disabled'}>${esc(r.prompt)}</textarea>${(r.warnings || []).length ? `<div class="chreqw">${r.warnings.map(w => `<span>⚠ ${esc(w)}</span>`).join('')}</div>` : ''}</td>
          <td><input data-x="cost" type="number" step="0.05" min="0" value="${Number(r.est_cost) || 0}" style="width:4.5em"></td>
          <td class="refs">${(r.refs || []).map(p => `<a href="${mediaAttr(p)}" target="_blank">${esc(String(p).split('/').pop())}</a>`).join(' ')}${(r.outputs || []).map(p => ` <a class="picked" href="${mediaAttr(p)}" target="_blank">→ ${esc(String(p).split('/').pop())}</a>`).join('')}</td>
          <td class="dim">${esc((r.at || '').replace('T', ' ').slice(5, 16))}</td>
          <td><button data-x="reject" title="reject">✕</button></td></tr>`; }).join('')}</table>` : '<p class="dim">no requests yet</p>'}`;
    };
    render();
    const addRequest = async () => {
      const e = est(), refs = refsOf();
      if (!F.prompt.trim()) return toast('write a prompt (or apply the photoreal recipe)');
      const extra = { tool: e?.tool, est_why: e?.why };
      if (F.recipe && F.built) {
        extra.recipe = { id: F.built.recipe, version: F.built.version, model: F.built.model, framing: F.built.framing, identity: !!F.identity, fields: Object.fromEntries(Object.entries(F.fields).filter(([, v]) => v)), blocks: F.built.blocks.map(({ id, label, text }) => ({ id, label, text })), ...(F.built.negative_prompt ? { negative_prompt: F.built.negative_prompt } : {}) };
        if (F.prompt !== F.built.prompt) extra.recipe.prompt_edited = true;
        if (F.built.warnings.length) extra.warnings = F.built.warnings;
      }
      const r = await store.addRequest({ kind: F.kind.trim() || 'generate', target: F.target.trim() || null, prompt: F.prompt, refs, est_cost: Number(e?.usd || 0), extra });
      toast(`draft request ${r.id} (${r.kind}) · est $${Number(r.est_cost).toFixed(2)} · approve it here, then the agent runs it`);
      Object.assign(F, { open: false, prompt: '', recipe: false, fields: {}, blocks: {}, built: null }); renderForm();
    };
    el.addEventListener('click', async (e) => {
      const q = e.target.closest('[data-q]')?.dataset.q;
      if (q === 'new') { F.open = !F.open; renderForm(); if (F.open) $form.querySelector('[data-f=kind]')?.focus(); return; }
      if (q === 'close') { F.open = false; return renderForm(); }
      if (q === 'recipe') { await loadRecipe(); F.recipe = true; F.blocks = {}; rebuild(); return renderForm(); }
      if (q === 'norecipe') { F.recipe = false; F.built = null; return renderForm(); }
      if (q === 'add') return addRequest();
      const f = e.target.closest('a[data-f]'); if (f) { filter = f.dataset.f; render(); return; }
      const a = e.target.closest('a[data-t]'); if (a) return ctx.goto(Number(a.dataset.t));
      const row = e.target.closest('tr[data-id]'); if (!row) return;
      const id = row.dataset.id, r = store.requests?.items?.find(x => x.id === id), x = e.target.dataset.x;
      if (!r) return;
      if (x === 'cycle' && ORDER.includes(r.status)) store.setRequest(id, { status: ORDER[(ORDER.indexOf(r.status) + 1) % ORDER.length] });
      else if (x === 'cycle' && r.status === 'rejected') store.setRequest(id, { status: 'draft' });
      if (x === 'reject') store.setRequest(id, { status: 'rejected' });
      if (!x) window.WB.selection.set(['request:' + id]);
    });
    // the form: typing updates the state; a field or a block rebuilds the prompt (an edited block wins)
    $form.addEventListener('input', (e) => {
      const t = e.target, f = t.dataset.f;
      if (f === 'prompt') { F.prompt = t.value; return; }
      if (f && f !== 'model' && f !== 'framing' && f !== 'identity') { F[f] = f === 'seconds' ? Number(t.value) || 5 : t.value; if (f === 'refs' || f === 'seconds' || f === 'target') { if (F.recipe) { rebuild(); syncBlocks(); } } return; }
      if (t.dataset.fld) { F.fields[t.dataset.fld] = t.value; rebuild(); syncBlocks(); return; }
      if (t.dataset.blk) { F.blocks[t.dataset.blk] = t.value; rebuild(); syncBlocks(); }
    });
    $form.addEventListener('change', (e) => {
      const t = e.target, f = t.dataset.f;
      if (f === 'model' || f === 'framing') { F[f] = t.value; if (F.recipe) rebuild(); renderForm(); }
      if (f === 'identity') { F.identity = t.checked; if (F.recipe) rebuild(); renderForm(); }
    });
    $form.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') { F.open = false; renderForm(); } });
    // keep the focused input; refresh the other blocks and the prompt in place
    const syncPrompt = () => { const p = $form.querySelector('[data-f=prompt]'); if (p) p.value = F.prompt; const est$ = est(); const b = $form.querySelector('.qfrow:last-child b'); if (b) b.textContent = `$${Number(est$?.usd || 0).toFixed(2)}`; const w = $form.querySelector('.qwarn'); if (w) w.innerHTML = F.recipe && F.built ? F.built.warnings.map(x => `<span>⚠ ${esc(x)}</span>`).join('') : ''; };
    // in place (never a re-render while typing: the focus stays): block texts, their marks, the warnings, the estimate
    const syncBlocks = () => { for (const b of F.built.blocks) { const ta = $form.querySelector(`[data-blk="${b.id}"]`); if (!ta) continue; if (ta !== document.activeElement) ta.value = b.text; ta.parentElement.classList.toggle('unfilled', /\[fill:/.test(b.text)); ta.parentElement.classList.toggle('edited', !!b.edited); } syncPrompt(); };
    $list.addEventListener('change', (e) => {
      const row = e.target.closest('tr[data-id]'); if (!row) return;
      if (e.target.dataset.x === 'prompt') store.setRequest(row.dataset.id, { prompt: e.target.value });
      if (e.target.dataset.x === 'cost') store.setRequest(row.dataset.id, { est_cost: Number(e.target.value) || 0 });
    });
    // never re-render under the director's cursor (focused field, or mid-click); a skipped render runs once focus has
    // left the pane and the click is over, so the agent's status changes still show up
    let stale = false, down = false;
    const flush = () => { if (stale && !down && !$list.contains(document.activeElement)) { stale = false; render(); } };
    store.on((w) => { if (w !== 'requests' && w !== 'all') return; stale = true; flush(); });
    el.addEventListener('focusout', () => setTimeout(flush));
    $list.addEventListener('pointerdown', () => { down = true; });
    document.addEventListener('pointerup', () => { if (down) { down = false; setTimeout(flush); } }, true);
  },
};
