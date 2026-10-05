// Generation queue: data/<project>/requests.json. The director decides here: Approve / Reject per row (or tick drafts:
// Approve selected · $X), Unapprove, Back to draft. An approved request runs with Run · $X (or Run all approved (N) · $X):
// the local server's runner (lib/run.mjs, POST /api/op/request_run), the same one an agent's request_run uses; its
// progress arrives as SSE {run} (store.runs) and the row follows queued -> running -> done (outputs, the nodes it added)
// or failed (why, Retry). The generator per kind is Settings > Generator ("Open in another app": Export prompt pack,
// Copy prompt, Collect results). Cost cap shown on top.
//   {id, kind, target, prompt, refs[], est_cost, takes?, status: draft|approved|queued|running|done|failed|rejected|withdrawn, by, at,
//    outputs?[], warnings?[] (request_create's: e.g. a look sheet with no approved identity), recipe? (the photoreal
//    blocks), generator?, linked?, handoff?, last_run?}
// Private refs (a real photo: the PRIVATE rule, or media flagged private) carry a lock badge; fal uploads every ref to its
// storage (a public URL), so a request with one runs only once the director ticks "allow uploading private refs" on it
// (off by default; recorded by the server in the request's log, undone by an edit; lib/run.mjs refuses the run without it).
// "+ New request": a draft request from the page. "Apply photoreal recipe" builds the prompt from editable blocks
// (references + identity lock, subject + wardrobe, action, place, light, camera, texture, medium, the avoid guard) for
// the chosen model (js/recipe.js, templates/photoreal_recipe.json, docs/PHOTOREAL.md); the estimate comes from the one
// price table (js/prices.js).
// A VIDEO model (D3b; js/video.js) turns the form into a video request: a MOTION-ONLY prompt (what moves, one camera
// move; the recipe's video blocks), a duration selector with the cost of each length (per second, the H3 promo by date),
// the start frame and the end frame picked from the approved nodes and the registered images (the end frame: an edit of
// the start frame, or none), and for motion control a reference video from the registered clips (its length sets the
// seconds). A done request with a failed take offers "Retry take N · $x" (D3c: only that take runs again).
// Batches (D4, js/batches.js): requests.json batches[] (waves) show as collapsible groups with their gate (locked / ready /
// running / review / done), totals and the take-ratio stats; "Approve batch · $X" approves the whole batch after a confirm
// with the total and the cap impact (batch_act, page only), "Run batch" runs it within its cap, a done request's takes are
// picked (D6) or rejected / kept here, and "Mark reviewed" unlocks the next wave. "Plan waves…" (tabs/waves.js) proposes
// waves from the storyboard gaps; "Import job books" brings the first film's falgen jobs_*.json in as history (done, never
// run again, no new cost).
import { store, toast, isPrivatePath, postJSON } from '../js/store.js';
import { fmt } from '../js/timeline.js';
import { esc, mediaAttr } from '../core/esc.js';
import { buildRecipe, constantsOf, FIELDS, MODELS, FRAMINGS } from '../js/recipe.js';
import { PRICES, estimateWith, genKindOf } from '../js/prices.js';
import * as VID from '../js/video.js';
import * as B from '../js/batches.js';
import * as SB from '../js/storyboard.js';
import { openWaves } from './waves.js';
import { ui } from '../core/palette.js';
const CLS = { draft: '', approved: 's-approved', queued: 's-review', running: 's-review', done: 's-locked', failed: 's-changes', rejected: 's-changes', withdrawn: 's-archived' };
// who wrote a request (lib/ops/requests.mjs requestAuthor): the page's own drafts are the director's; withdrawn = its author took it back
const author = (r) => { const v = r.log?.[0]?.via; return v === 'page' ? 'director' : v === 'agent' ? 'agent' : r.by === 'director' ? 'director' : 'agent'; };
let RECIPE = null;
const loadRecipe = async () => (RECIPE ||= await fetch('/templates/photoreal_recipe.json').then(r => (r.ok ? r.json() : {})).catch(() => ({})));

export default {
  mount(el, ctx) {
    el.classList.add('pane', 'queue');
    el.innerHTML = '<div class="qform" hidden></div><div class="qlist"></div>';
    const $form = el.querySelector('.qform'), $list = el.querySelector('.qlist');
    let filter = '';
    // the new-request form (kept across list re-renders)
    const F = { open: false, kind: 'generate', target: '', refs: '', model: 'nb2', framing: 'full_body', seconds: 5, takes: 1, identity: false, prompt: '', recipe: false, fields: {}, blocks: {}, built: null, start: '', end: '', ref_video: '', orientation: 'video' };
    const isVideo = () => !!VID.MODELS[F.model];
    const vSpec = () => VID.videoOf({ video: { model: F.model, start: F.start, end: F.end, ref_video: F.ref_video, seconds: F.seconds, orientation: F.orientation } }, F.model);
    // the frames a video starts / ends on: approved nodes first (each asset tree's approved node), then the registered images
    const frameOpts = () => {
      const out = [], seen = new Set(), add = (x) => { if (!x.path || seen.has(x.path)) return; seen.add(x.path); out.push(x); };
      for (const e of store.entities || []) for (const [tree, st] of Object.entries(e.iter?.trees || {})) { const n = st?.approved && (e.iter.nodes || []).find(x => x.id === st.approved); if (n?.image && VID.IMAGE_RE.test(n.image)) add({ path: n.image, label: `${e.name || e.id} · ${tree} · ${n.id} ✓ approved`, group: 'approved nodes', priv: privRef(n.image) || !!n.private }); }
      for (const m of store.media || []) if (VID.IMAGE_RE.test(m.path || '') && !['sketch', 'render', 'catalog'].includes(m.kind)) add({ path: m.path, label: `${m.label || m.id}${m.status === 'approved' ? ' ✓' : ''}`, group: 'registered images', priv: !!m.private || privRef(m.path) });
      return out;
    };
    const clipOpts = () => (store.media || []).filter(m => VID.VIDEO_RE.test(m.path || '') && !['render', 'audio'].includes(m.kind)).map(m => ({ path: m.path, label: `${m.label || m.id}${m.duration_ms ? ` · ${(m.duration_ms / 1000).toFixed(1)} s` : ''}`, group: 'registered clips', priv: !!m.private || privRef(m.path), dur: m.duration_ms }));
    const pick = (f, opts, cur, none) => { const groups = [...new Set(opts.map(o => o.group))]; return `<select data-f="${f}">${none ? `<option value="">${esc(none)}</option>` : ''}${groups.map(g => `<optgroup label="${esc(g)}">${opts.filter(o => o.group === g).map(o => `<option value="${esc(o.path)}"${o.path === cur ? ' selected' : ''}>${o.priv ? '🔒 ' : ''}${esc(o.label)}</option>`).join('')}</optgroup>`).join('')}</select>`; };
    const timeOf = (k) => { if (!k) return null; const id = k.slice(k.indexOf(':') + 1); return store.shots.find(s => 'shot:' + s.id === k)?.t0 ?? store.uses.find(u => u.id === id)?.t0 ?? store.song.sections.find(s => s.id === id)?.t0 ?? store.song.lines.find(l => l.id === id)?.t0 ?? null; };
    const refsOf = () => F.refs.split(/[,\n]/).map(s => s.trim()).filter(Boolean);
    // the subject from the target: a character entity gives its name and its identity constants (entity.constants[]): the
    // recipe is character-agnostic and fills in from them (the same code as request_create's recipe)
    const subject = () => { const [k, id] = F.target.split(':'), e = id ? store.entities.find(x => x.id === id && (!k || x.kind === k)) : null; return e ? { name: e.name || e.id, character: e.kind === 'character', constants: constantsOf(e.constants) } : {}; };
    const rebuild = () => { F.built = buildRecipe(RECIPE, { ...F.fields, model: F.model, framing: F.framing, seconds: F.seconds, takes: F.takes, identity: F.identity, refs: isVideo() ? VID.videoRefs(vSpec()).length : refsOf().length, ...subject(), blocks: F.blocks }); F.prompt = F.built.prompt; };
    const est = () => isVideo() ? VID.videoEstimate(vSpec(), { takes: F.takes }) : F.recipe && F.built ? F.built.est : estimateWith({ model: F.model, tier: PRICES[F.model]?.default, what: MODELS[F.model] === 'video' ? 'image-to-video' : F.takes > 1 ? `${F.takes} images` : 'one image' }, { seconds: F.seconds, n: F.takes });
    const renderForm = () => {
      $form.hidden = !F.open; if (!F.open) return;
      const e = est(), video = isVideo(), V = video ? VID.MODELS[F.model] : null, vs = video ? vSpec() : null;
      // the duration selector: each length with what it costs (per second x takes, at today's price)
      const secs = video ? V.seconds.filter(x => x <= (F.model === 'klingmc' && F.orientation === 'image' ? 10 : V.max)) : [];
      if (video && !secs.includes(F.seconds)) secs.push(F.seconds), secs.sort((a, b) => a - b);
      const vprob = video ? VID.videoProblems(vs) : [];
      const VFIELDS = ['action', 'camera', 'place', 'light'];
      $form.innerHTML = `<div class="qfh"><b>New ${video ? 'video ' : ''}request</b><span class="dim">a DRAFT: nothing runs or is paid until you approve it</span><span class="sp"></span><a data-q="close">close</a></div>
        <div class="qfrow"><label>kind <input data-f="kind" value="${esc(F.kind)}" spellcheck="false"></label><label>target <input data-f="target" value="${esc(F.target)}" placeholder="character:ada · shot:sh03" spellcheck="false"></label>
        <label>model <select data-f="model">${Object.keys(MODELS).map(m => `<option value="${m}"${m === F.model ? ' selected' : ''}>${esc(PRICES[m].name)}</option>`).join('')}</select></label>
        ${video ? `<label title="output length: one camera move, 5-6 s by default (docs/PHOTOREAL.md §6); the cost is per second">duration <select data-f="seconds" class="qsecs">${secs.map(x => { const c = VID.videoEstimate({ ...vs, seconds: x }, { takes: F.takes }); return `<option value="${x}"${x === F.seconds ? ' selected' : ''}>${x} s · $${c.usd.toFixed(2)}</option>`; }).join('')}</select></label>` : `<label>framing <select data-f="framing">${Object.entries(FRAMINGS).map(([k, l]) => `<option value="${k}"${k === F.framing ? ' selected' : ''}>${esc(l.replace(/ photograph$/, ''))}</option>`).join('')}</select></label>`}
        <label title="how many ${video ? 'videos' : 'images'} (candidates): the estimate covers all of them">takes <input data-f="takes" type="number" min="1" max="8" value="${F.takes}" style="width:3.5em"></label>
        ${video ? '' : `<label title="image 1 is the approved face / identity: the identity lock block is added (with the character's constants)"><input type="checkbox" data-f="identity"${F.identity ? ' checked' : ''}> image 1 = the approved identity</label>`}</div>
        ${video ? `<div class="qfrow qvframes"><label title="the still the video starts from: an approved node or a registered image (animate approved stills only)">start frame ${pick('start', frameOpts(), F.start, '— pick the start frame —')}</label>
          ${V.end ? `<label title="optional: make the end frame by editing the start frame (same light, lens, place, wardrobe; only pose, expression or camera position change). For a loop pick the start frame again.">end frame ${pick('end', frameOpts(), F.end, 'none (free end)')}</label>` : ''}
          ${V.ref_video ? `<label title="the performance to transfer: 3-30 s, one continuous shot, one person, no cuts, no camera move; its length sets the seconds">reference video ${pick('ref_video', clipOpts(), F.ref_video, '— pick a reference clip —')}</label>
          <label title="character_orientation">orientation <select data-f="orientation">${Object.entries(VID.ORIENTATIONS).map(([k, l]) => `<option value="${k}"${k === F.orientation ? ' selected' : ''} title="${esc(l)}">${k}</option>`).join('')}</select></label>` : ''}
          <span class="qvthumbs">${thumbs(VID.videoRefs(vs), "", refTags({ refs: VID.videoRefs(vs), video: vs }))}</span></div>
          <div class="dim qvhint">${V.ref_video ? 'motion control: the reference clip drives the motion; the prompt describes the background and atmosphere only' : 'the end frame: an edit of the start frame (same light, lens, place, wardrobe); none = a free end'} · uploaded to fal storage when it runs</div>`
        : `<div class="qfrow"><label class="wide">refs <input data-f="refs" value="${esc(F.refs)}" placeholder="paths, comma separated (image 1 first)" spellcheck="false"></label></div>`}
        <div class="qfrow">${F.recipe ? '<span class="qrec on">photoreal recipe applied</span><a data-q="norecipe">remove</a>' : `<button data-q="recipe" class="pri" title="build the prompt from the photoreal recipe\'s blocks for this model (docs/PHOTOREAL.md)">Apply photoreal recipe${video ? ' (motion blocks)' : ''}</button>`}</div>
        ${F.recipe ? `<div class="qfields">${FIELDS.filter(x => !video || VFIELDS.includes(x.id)).map(x => video && x.id === 'action' ? `<label title="the motion only: what moves, not what the image already shows">motion<input data-fld="action" value="${esc(F.fields.action || '')}" placeholder="what moves: she lifts her head, a strand of hair moves" spellcheck="false"></label>` : video && x.id === 'camera' ? `<label title="ONE camera move">camera move<input data-fld="camera" list="qcammoves" value="${esc(F.fields.camera || '')}" placeholder="static locked-off camera" spellcheck="false"></label>` : `<label title="${esc(x.hint)}">${esc(x.label)}<input data-fld="${x.id}" value="${esc(F.fields[x.id] || '')}" placeholder="${esc(x.hint)}" spellcheck="false"></label>`).join('')}</div>
          <div class="qblocks">${F.built.blocks.map(b => `<label class="${/\[fill:/.test(b.text) ? 'unfilled' : ''}${b.edited ? ' edited' : ''}"><span>${esc(b.label)}</span><textarea data-blk="${esc(b.id)}" rows="${Math.min(4, Math.ceil(b.text.length / 110) || 1)}" spellcheck="false">${esc(b.text)}</textarea></label>`).join('')}</div>` : ''}
        ${video ? `<datalist id="qcammoves">${(RECIPE?.video?.camera_moves || []).map(c => `<option value="${esc(c)}">`).join('')}</datalist>` : ''}
        <label class="qprompt">${video ? 'motion prompt <span class="dim">(motion only: what moves, one camera move; not what the frame already shows)</span>' : 'prompt'} <textarea data-f="prompt" rows="4" spellcheck="false"${video ? ' placeholder="She lifts her head and glances toward the window, a strand of hair moves. Camera: slow push-in."' : ''}>${esc(F.prompt)}</textarea></label>
        <div class="chreqw qwarn">${[...(F.recipe ? F.built.warnings : []), ...vprob].map(w => `<span>⚠ ${esc(w)}</span>`).join('')}</div>
        ${F.recipe && F.built.negative_prompt ? `<div class="dim">negative prompt: ${esc(F.built.negative_prompt)}</div>` : ''}
        <div class="qfrow qest"><span>est <b>$${Number(e?.usd || 0).toFixed(2)}</b> <span class="dim">${esc(e?.why || '')}</span></span><span class="sp"></span><button data-q="add" class="pri">Add draft request</button></div>`;
    };
    // the generator per kind (Settings > Generator; settings.json generators, default fal) and the runner's live progress
    // (no choice made: the server's default from generators_get: fal with a key, else Open in another app; review #3 blocker 5)
    let GI = null;
    const genOf = (r) => (['draft', 'approved', 'failed'].includes(r.status) ? null : r.generator || r.handoff?.generator) || store.settings?.generators?.[genKindOf(r)] || GI?.default || 'fal';
    const sel = new Set();   // ticked draft rows (Approve / Reject selected)
    const money = (x) => `$${(Number(x) || 0).toFixed(2)}`;
    const privRef = (p) => isPrivatePath(p) || !!store.mediaByPath?.[p]?.private;
    const thumbs = (list, cls = '', tags = []) => list.map((p, i) => { const img = /\.(png|jpe?g|webp|gif)$/i.test(String(p)), th = !img && store.mediaByPath?.[p]?.thumb, pv = cls !== 'out' && privRef(p); return `<a class="qthumb ${cls}${pv ? ' priv' : ''}${th ? ' vid' : ''}" href="${mediaAttr(p)}" target="_blank" title="${esc(p)}${pv ? ' · private: a real photo, local only' : ''}">${img ? `<img src="${mediaAttr(p)}" alt="" loading="lazy">` : th ? `<img src="${mediaAttr(th)}" alt="" loading="lazy">` : ''}<span>${tags[i] ? `<i>${esc(tags[i])}</i> ` : ''}${pv ? '🔒 ' : ''}${esc(String(p).split('/').pop())}</span></a>`; }).join('');
    // a video request's refs, labelled (start / end / reference)
    const refTags = (r) => { if (!r.video) return []; const v = r.video; return (r.refs || []).map(x => (x === v.start ? 'start' : x === v.end ? 'end' : x === v.ref_video ? 'ref' : '')); };
    // a fal run uploads every ref to fal storage (a public URL): a private one needs the director's tick on the request
    const privBox = (r) => {
      const n = (r.refs || []).filter(privRef).length; if (!n || genOf(r) !== 'fal' || ['done', 'rejected', 'withdrawn'].includes(r.status)) return '';
      const on = r.private_upload_ok === true;
      return `<label class="qpriv${on ? ' on' : ''}" title="fal takes references as URLs: a run uploads each ref to fal storage, where it gets a public URL. Off: the run is refused."><input type="checkbox" data-x="privok"${on ? ' checked' : ''}> allow uploading private refs <span class="dim">(🔒 ${n} → fal storage, public URL)</span></label>`;
    };
    const PHASE = { running: 'started', upload: 'uploading refs', submit: 'submitted', queued: 'in the provider queue', retrying: 'retrying the status', take_done: 'take done', skip: 'output exists: skipped', take_failed: 'take failed', refused: 'refused', handed_off: 'pack exported' };
    const progress = (r) => {
      const x = store.runs?.[r.id]; if (!x) return r.status === 'queued' ? 'queued' : 'running…';
      const tk = x.takes ? ` · take ${Math.min((x.take ?? 0) + 1, x.takes)}/${x.takes}` : '';
      return `${x.phase === 'running' && x.s != null ? 'generating' : PHASE[x.phase] || x.phase}${x.s != null ? ` · ${x.s} s` : ''}${tk}${x.error || x.why ? ': ' + (x.error || x.why) : ''}`;
    };
    // what a done request cost: "spent" only for money that is recorded or counted; a history request's estimate (or a
    // falgen ledger row the project does not count) is "est. (not counted)" (lib/ops/batches.mjs history.cost)
    const counted = (c) => c?.counted === true || ['recorded', 'counted'].includes(c?.status);
    const costLbl = (r) => { if (!B.isHistory(r)) return `${money(r.actual_cost_usd)} spent`; const c = r.history.cost || {}; return counted(c) ? `${money(c.usd ?? r.actual_cost_usd)} spent` : c.usd != null ? `${money(c.usd)} est. (not counted)` : 'cost unknown'; };
    const actions = (r) => {
      const gen = genOf(r), runLbl = gen === 'openwith' ? 'Export prompt pack' : `Run · ${money(r.est_cost)}`;
      // made in another app (no fal key, or chosen): nothing is paid through the workbench, so it is approved at $0 (the cap untouched)
      if (r.status === 'draft' && gen === 'openwith') return `<button data-x="approve0" class="pri" title="approve it to be made in another app: Run exports its prompt pack; nothing is paid through the workbench ($0 against the cap)">Approve · $0 (another app)</button>${author(r) === 'director' ? '<button data-x="withdraw" title="your own draft: take it back (not a rejection)">Withdraw</button>' : '<button data-x="reject">Reject</button>'}`;
      if (r.status === 'draft') return `<button data-x="approve" class="pri" title="approve: it may then run and spend up to its estimate">Approve</button>${author(r) === 'director' ? '<button data-x="withdraw" title="your own draft: take it back (not a rejection)">Withdraw</button>' : '<button data-x="reject">Reject</button>'}`;
      if (r.status === 'approved') return `${r.last_run?.status === 'refused' ? `<span class="qwhy" title="${esc(r.last_run.why)}">last run refused: ${esc(r.last_run.why.slice(0, 120))}</span>` : ''}<button data-x="run" class="pri run" title="run it now with ${esc(gen)} (Settings › Generator); the cap is checked again">${runLbl}</button><button data-x="unapprove" title="back to draft">Unapprove</button><button data-x="reject">Reject</button>`;
      if (r.status === 'queued' || (r.status === 'running' && !r.handoff)) return `<span class="qprog">⟳ ${esc(progress(r))}</span>`;
      if (r.status === 'running' && r.handoff) return `<div class="qho"><span class="qhol" title="${esc(`pack: ${r.handoff.pack || ''} · results: ${r.handoff.results || ''}`)}"><b>1</b> Copy prompt · <b>2</b> make the images in your app with the refs (Open folder) · <b>3</b> drop them here · <b>4</b> Collect results</span><span class="qhob"><button data-x="copy">Copy prompt</button><button data-x="reveal" title="open the prompt pack (prompt.txt, refs/, README) in your file manager">Open folder</button><label class="qdrop" data-drop="${esc(r.id)}" title="PNG, JPEG or WebP: they land in ${esc(r.handoff.results || 'results/')}">drop images here or <u>pick files</u><input type="file" data-x="hofiles" accept="image/png,image/jpeg,image/webp" multiple hidden></label><button data-x="run" class="pri">Collect results</button></span></div>`;
      if (r.status === 'failed') return `<span class="qwhy" title="${esc(r.why || '')}">✕ ${esc(String(r.why || 'failed').slice(0, 140))}</span><button data-x="run" class="pri" title="run again (outputs that exist are skipped; a submitted job is polled, not paid twice)">Retry · ${money(r.est_cost)}</button><button data-x="reject">Reject</button>`;
      if (r.status === 'done' && r.retaking) return `<span class="qprog">⟳ retake ${esc((r.retaking.takes || []).map(t => t + 1).join(', '))}: ${esc(progress(r))}</span>`;
      if (r.status === 'done') { const L = r.linked, tf = r.takes_failed || [], per = (Number(r.est_cost) || 0) / Math.max(1, r.takes || 1); return `${tf.length ? `<button data-x="retake" class="pri" title="run only the failed take${tf.length > 1 ? 's' : ''} again (the done takes are kept and not paid again); within the approved estimate, the cap checked">Retry take ${tf.map(t => t + 1).join(', ')} · ${money(per * tf.length)}</button>` : ''}<span class="qdone">✓ ${costLbl(r)}${tf.length ? ` · take ${tf.map(t => t + 1).join(', ')} failed` : ''}${L ? ` · ${L.nodes?.length ? `node${L.nodes.length > 1 ? 's' : ''} ${esc(L.nodes.join(', '))}` : ''}${L.proposals?.length ? ` proposed ${esc(L.proposals.join(', '))}` : ''} in ${esc(L.id)} ${esc(L.tree || '')}: keep or pick` : ''}</span>${L ? '<button data-x="stage" title="keep or pick them in the stage">Open in stage</button>' : ''}`; }
      if (r.status === 'rejected') return `<button data-x="redraft">Back to draft</button>`;
      if (r.status === 'withdrawn') return `<span class="qwhy" title="${esc(r.why || '')}">withdrawn by ${author(r) === 'director' ? 'you' : 'the agent'}${r.superseded_by?.length ? ' · superseded by ' + esc(r.superseded_by.join(', ')) : ''}${r.why ? ': ' + esc(String(r.why).slice(0, 120)) : ''}</span><button data-x="redraft">Back to draft</button>`;
      return '';
    };
    const render = () => {
      const items = store.requests?.items || [];
      const by = {}; for (const r of items) by[r.status] = (by[r.status] || 0) + 1;
      const spent = (store.costs?.items || []).reduce((s, x) => s + (Number(x.usd) || 0), 0);
      const pending = items.filter(r => ['approved', 'queued', 'running'].includes(r.status)).reduce((s, r) => s + (Number(r.est_cost) || 0), 0);
      const drafts = items.filter(r => r.status === 'draft').reduce((s, r) => s + (Number(r.est_cost) || 0), 0);
      const cap = Number(store.costs?.cap_usd) || 0, pct = cap ? Math.min(100, (spent + pending) / cap * 100) : 0;
      const approved = items.filter(r => r.status === 'approved'), apUsd = approved.reduce((s, r) => s + (Number(r.est_cost) || 0), 0);
      for (const id of [...sel]) if (!items.some(r => r.id === id && r.status === 'draft')) sel.delete(id);
      const selUsd = items.filter(r => sel.has(r.id)).reduce((s, r) => s + (Number(r.est_cost) || 0), 0);
      // D4: batches (waves) as collapsible groups with their gate, the history imported from the job books, then the rest
      const doc = store.requests || {}, batches = B.batchesOf(doc), shotsNow = SB.boardShots(store.board);
      const inBatch = new Set(batches.flatMap(b => b.request_ids || [])), hist = items.filter(B.isHistory), loose = items.filter(r => !inBatch.has(r.id) && !B.isHistory(r));
      const shown = (list) => list.filter(r => !filter || r.status === filter);
      $list.innerHTML = `<div class="bar">spent $${spent.toFixed(2)} + approved/queued $${pending.toFixed(2)} (drafts $${drafts.toFixed(2)}) of cap $${cap} <span class="dim">(all sources: Costs)</span>
        <div class="meter"><i style="width:${pct}%"></i></div>
        ${['', 'draft', 'approved', 'queued', 'running', 'done', 'failed', 'rejected', 'withdrawn'].map(s => `<a data-f="${s}" class="${s === filter ? 'picked' : ''}">${s || 'all'}${s ? ' ' + (by[s] || 0) : ' ' + items.length}</a>`).join(' · ')}
        · <a data-q="new" class="qnew">+ New request</a> · <a data-q="waves" class="qnew" title="waves of 2 → 4 → 8 → rest shots from the storyboard gaps, a pilot first, each gated on the review of the one before">Plan waves…</a> · <a data-q="jobbooks" title="the first film's falgen job books (jobs_*.json) as history: done requests linked to their outputs, never run again, no new cost">Import job books</a></div>
        <div class="qacts"><button data-q="runall" class="pri"${approved.length ? '' : ' disabled'} title="run every approved request, batch by batch (up to 2 at once; the cap is checked for each; a locked batch never runs)">Run all approved (${approved.length}) · ${money(apUsd)}</button>
        ${sel.size ? `<span class="qselt">${sel.size} selected · ${money(selUsd)}</span><button data-q="approvesel" class="pri">Approve selected</button><button data-q="rejectsel">Reject selected</button>` : '<span class="dim">tick drafts to approve or reject several at once</span>'}
        <span class="dim">· nothing runs or is paid until you approve it; Run uses the generator in Settings › Generator · right-click a shot / clip / cast chip / card to add a request</span></div>
        ${GI && !GI.fal_key?.found && Object.values(GI.selected || {}).includes('openwith') ? '<div class="qnokey">No fal key: an approved request runs as <b>Open in another app</b> ($0). Run exports its prompt and refs; you make the images in any app and drop them on its row. (A fal key: Settings › Generator.)</div>' : ''}
        ${batches.length ? wavesHead(doc, shotsNow) : ''}
        ${items.length ? `<table class="tbl qtbl">${HEAD}
          ${batches.map(b => batchHtml(b, doc, shotsNow, shown)).join('')}
          ${hist.length ? histHtml(hist, shotsNow, shown) : ''}
          ${loose.length ? `<tbody class="qloose">${batches.length || hist.length ? `<tr class="qgh"><td colspan="${NCOL}"><div class="qgrp"><b>Not in a batch</b> <span class="dim">${loose.length} request${loose.length === 1 ? '' : 's'}</span></div></td></tr>` : ''}${rowsHtml(shown(loose).slice().reverse())}</tbody>` : ''}</table>` : '<p class="dim">no requests yet</p>'}`;
    };
    // ONE table for every group (the waves, the history, the requests in no batch): the same columns all the way down,
    // each group a header row; a prompt is one line until it has the focus
    const NCOL = 9;
    const HEAD = `<colgroup><col class="qc-tick"><col class="qc-st"><col class="qc-kind"><col class="qc-tgt"><col class="qc-pr"><col class="qc-est"><col class="qc-refs"><col class="qc-at"><col class="qc-act"></colgroup>
      <thead><tr><th></th><th>status</th><th>kind</th><th>target</th><th>prompt</th><th>$ est</th><th>refs → outputs</th><th>at</th><th>actions</th></tr></thead>`;
    const rowsHtml = (list, b = null) => `${list.map(r => { const t = timeOf(r.target); return `<tr data-id="${esc(r.id)}" data-sel="request:${esc(r.id)}" class="q-${esc(r.status)}${(r.warnings || []).length ? ' warn' : ''}">
          <td>${r.status === 'draft' && !b ? `<input type="checkbox" data-x="pick"${sel.has(r.id) ? ' checked' : ''} title="select">` : ''}</td>
          <td><span class="chip ${CLS[r.status] || ''}"${r.status === 'withdrawn' ? ' title="its author took it back (not a rejection by the director)"' : ''}>${esc(r.status)}</span>${B.isHistory(r) ? '<div class="dim qhtag" title="imported from a job book: never run again">history</div>' : ''}</td><td>${esc(r.kind)}${r.recipe ? ' <span class="qrec" title="built from the photoreal recipe (its blocks are stored with the request)">recipe</span>' : ''}<div class="dim">${esc(B.isHistory(r) ? r.history.book : genOf(r))}</div>${r.video ? `<div class="dim qvid" title="${esc(PRICES[r.video.model]?.name || r.video.model)}">${esc(r.video.model)} · ${esc(r.video.seconds)} s${r.video.end ? ' · start→end' : ''}${r.video.ref_video ? ' · ref video' : ''}</div>` : ''}</td>
          <td>${t != null ? `<a data-t="${Number(t) || 0}">${esc(r.target)} ${fmt(t)}</a>` : esc(r.target || '')}</td>
          <td class="qp"><textarea data-x="prompt" rows="1" title="${esc(String(r.prompt || '').slice(0, 600))}" ${['draft', 'approved'].includes(r.status) ? '' : 'readonly'}>${esc(r.prompt)}</textarea>${(r.warnings || []).length ? `<div class="chreqw">${r.warnings.map(w => `<span>⚠ ${esc(w)}</span>`).join('')}</div>` : ''}</td>
          <td><input data-x="cost" type="number" step="0.01" min="0" value="${Number(r.est_cost) || 0}" style="width:4.5em"${['draft', 'approved'].includes(r.status) ? '' : ' disabled'}>${r.takes > 1 ? `<div class="dim qtakes" title="the estimate covers every take">${r.takes} takes · ${money((Number(r.est_cost) || 0) / r.takes)} each</div>` : ''}</td>
          <td class="refs">${thumbs(r.refs || [], '', refTags(r))}${(r.outputs || []).length ? `<span class="qarrow">→</span>${thumbs(r.outputs, 'out')}` : ''}${privBox(r)}</td>
          <td class="dim">${esc((r.at || '').replace('T', ' ').slice(5, 16))}</td>
          <td class="qbtns">${b ? batchActions(r, b) : B.isHistory(r) ? histActions(r) : actions(r)}</td></tr>`; }).join('')}`;
    // ---------------------------------------------------------------- batches (D4)
    const open = new Map();   // batch id -> expanded? (default: open unless done)
    let confirming = null;    // the batch whose "Approve batch" confirm is showing
    const isOpen = (id, state) => open.has(id) ? open.get(id) : state !== 'done';
    const pctOf = (x, c) => (c ? `${Math.round(x / c * 100)}%` : 'no cap');
    const statsLine = (st, label = 'take ratio', money$ = null) => `<div class="qstats" title="takes made ÷ shots that use one of them; what they cost ÷ the seconds of them in the film">${esc(label)}: <b>${st.takes}</b> take${st.takes === 1 ? '' : 's'} for ${st.shots} shot${st.shots === 1 ? '' : 's'} · <b>${st.used_shots}</b> used · <b>${st.takes_per_used_shot ?? '–'}</b> takes per used shot · ${money$ ?? `${money(st.spent_usd)} spent`} · ${st.used_s} s used · <b>${st.usd_per_used_s != null ? '$' + st.usd_per_used_s.toFixed(3) : '–'}</b> per used second</div>`;
    const wavesHead = (doc, shots) => {
      const ob = B.observed(doc, shots), rest = B.reestimate(doc, shots);
      return `<div class="qwaveshead"><b>Waves</b> <span class="dim">approve a whole batch; the next one unlocks when you mark the one before reviewed (its takes picked or rejected)</span>
        ${ob.from.length ? statsLine(ob, `measured by ${ob.from.length} wave${ob.from.length > 1 ? 's' : ''}`) : '<div class="dim qstats">no wave reviewed yet: the take ratio is measured after the pilot</div>'}
        ${rest.length ? `<div class="qrest">${rest.map(x => `<span title="list price ${money(x.list_usd)}; observed = ${x.seconds} s x the cost per used second measured">${esc(x.name)}: list ${money(x.list_usd)}${x.observed_usd != null ? ` → <b>observed ${money(x.observed_usd)}</b>` : ''}</span>`).join(' · ')}</div>` : ''}</div>`;
    };
    const batchHtml = (b, doc, shots, shown) => {
      const g = B.gateState(b, doc), T = B.batchTotals(b, doc), R = B.requestsOf(b, doc), op = isOpen(b.id, g.state), V = B.verdicts(b, doc, shots);
      const prev = b.gate?.after ? B.batchById(doc, b.gate.after) : null, und = V.filter(v => v.verdict === 'pending' || v.verdict === 'not run');
      const runnable = R.filter(r => ['approved', 'failed'].includes(r.status)), runUsd = runnable.reduce((s, r) => s + (Number(r.est_cost) || 0), 0);
      const btns = g.state === 'locked' ? `<span class="qlock" title="${esc(g.why)}">🔒 waits for ${esc(prev?.name || b.gate.after)} to be reviewed</span>`
        : g.state === 'done' ? '<span class="qdone">✓ reviewed</span>'
        : g.state === 'review' ? `<button data-q="breview" class="pri"${und.length ? ' disabled' : ''} title="${und.length ? esc('pick a take or reject the takes of ' + und.map(v => v.id).join(', ')) : 'every request decided: unlock the next wave'}">Mark reviewed${und.length ? ` (${und.length} to decide)` : ''}</button>`
        : b.status === 'draft' ? `<button data-q="bapprove" class="pri" title="approve every request of this batch at once">Approve batch · ${money(T.drafts_usd)}</button><button data-q="bdismiss" title="drop the batch (its requests stay drafts)">Dismiss</button>`
        : g.state === 'ready' && runnable.length ? `<button data-q="brun" class="pri run" title="run its approved requests within the batch cap">Run batch · ${money(runUsd)}</button>` : '';
      const c = Number(store.costs?.cap_usd) || 0, sp = (store.costs?.items || []).reduce((s, x) => s + (Number(x.usd) || 0), 0), cm = (store.requests?.items || []).filter(r => ['approved', 'queued', 'running'].includes(r.status)).reduce((s, r) => s + (Number(r.est_cost) || 0), 0), after = sp + cm + T.drafts_usd;
      const conf = confirming === b.id && b.status === 'draft' ? `<div class="qconfirm${after > c + 1e-9 ? ' over' : ''}">Approve <b>${esc(b.name)}</b>: ${R.filter(r => r.status === 'draft').length} request${R.length === 1 ? '' : 's'} · <b>${money(T.drafts_usd)}</b> · cap: spent ${money(sp)} + committed ${money(cm)} + this ${money(T.drafts_usd)} = <b>${money(after)}</b> of ${money(c)} (${pctOf(after, c)})${after > c + 1e-9 ? ' · <b>over the cap</b>: queueing will be refused' : ''} · batch cap ${money(T.drafts_usd)}
        <button data-q="bconfirm" class="pri">Approve · ${money(T.drafts_usd)}</button><button data-q="bcancel">Cancel</button></div>` : '';
      return `<tbody class="qbatch st-${g.state}" data-b="${esc(b.id)}"><tr class="qgh"><td colspan="${NCOL}"><div class="qbh"><a data-q="btog" class="qtw">${op ? '▾' : '▸'}</a><b>${esc(b.name || b.id)}</b><span class="chip gate gate-${g.state}" title="${esc(g.why)}">${g.state}</span>
        <span class="qbn">${T.n} request${T.n === 1 ? '' : 's'} · ${T.shots} shot${T.shots === 1 ? '' : 's'} · est ${money(T.est_usd)}${T.spent_usd ? ` · spent ${money(T.spent_usd)}` : ''}${T.max_usd != null ? ` · batch cap ${money(T.max_usd)}` : ''}</span>
        <span class="dim qbg">${[prev ? '' : 'first wave', b.via === 'agent' ? 'proposed by the agent' : ''].filter(Boolean).join(' · ')}</span><span class="sp"></span>${btns}</div>
        ${conf}${['review', 'done'].includes(g.state) || T.spent_usd ? statsLine(B.batchStats(b, doc, shots)) : ''}</td></tr>
        ${op ? rowsHtml(shown(R), b) : ''}</tbody>`;
    };
    const histHtml = (hist, shots, shown) => {
      const op = open.has('_hist') ? open.get('_hist') : false, st = B.takeStats(hist, shots), books = [...new Set(hist.map(r => r.history.book))];
      const cs = hist.map(r => r.history?.cost || {}), inL = cs.filter(counted).reduce((a, c) => a + (Number(c.usd) || 0), 0), notC = cs.filter(c => !counted(c)).reduce((a, c) => a + (Number(c.usd) || 0), 0);
      return `<tbody class="qbatch qhist" data-b="_hist"><tr class="qgh"><td colspan="${NCOL}"><div class="qbh"><a data-q="btog" class="qtw">${op ? '▾' : '▸'}</a><b>History · job books</b><span class="chip gate gate-done">history</span><span class="qbn">${hist.length} request${hist.length === 1 ? '' : 's'} · ${esc(books.join(', '))}</span><span class="dim qbg">imported: done, never run again, no new cost</span></div>
        ${statsLine(st, 'job books', `${money(inL)} spent${notC ? ` · ${money(notC)} est. (not counted)` : ''}`)}</td></tr>${op ? rowsHtml(shown(hist).slice().reverse()) : ''}</tbody>`;
    };
    const histActions = (r) => { const c = r.history?.cost || {}; return `<span class="qdone${counted(c) ? '' : ' est'}" title="${esc(c.why || '')}">✓ history · ${(r.outputs || []).length}/${r.history.files ?? '?'} outputs registered · ${costLbl(r)}${counted(c) ? ' (in the ledger)' : ''}</span>`; };
    // a request inside a batch: no per-row approval (the batch is approved as a whole); a done one gets its verdict
    const batchActions = (r, b) => {
      if (r.status === 'draft') return B.gateState(b, store.requests).state === 'locked' ? '<span class="dim" title="no approval per request in a batch: its batch is approved as a whole once its gate opens">approve with the batch ↑ (once it unlocks)</span>' : '<span class="dim" title="no approval per request in a batch: approve the batch as a whole (its header)">approve with the batch ↑</span>';
      const v = B.verdicts(b, store.requests, SB.boardShots(store.board)).find(x => x.id === r.id), undo = b.status === 'reviewed' ? '' : '<a data-x="vundo">undo</a>';
      const vb = r.status !== 'done' || !v ? '' : v.verdict === 'picked' ? `<span class="qverd ok" title="the shot uses take ${v.clip?.take ?? '?'}">✓ take picked</span>`
        : v.verdict === 'rejected' ? `<span class="qverd no">✕ takes rejected</span>${undo}` : v.verdict === 'kept' ? `<span class="qverd ok">✓ kept</span>${undo}`
        : `<span class="qverd pend">pick a take${v.shot ? ` (${esc(v.shot)})` : ''} or</span><button data-x="vreject" title="none of its takes is usable">Reject takes</button>${v.shot ? '' : '<button data-x="vkeep" title="its takes are fine (no shot to pick them on)">Keep</button>'}`;
      return vb + actions(r);
    };
    // the first film's falgen job books as history: a dry run first (what would come in), then the director confirms
    const importJobBooks = async () => {
      let d; try { d = await store.op('jobbooks_import', { dry_run: true }); } catch (er) { return toast(`job books: ${er.message}`); }
      if (!d.imported.length) return toast(`job books (${d.books.join(', ') || 'none'}): nothing new to import${d.skipped.length ? ` · ${d.skipped.length} skipped` : ''}`);
      const ok = await ui.confirm(`Import ${d.imported.length} job${d.imported.length === 1 ? '' : 's'} from ${d.books.join(', ')} as history (done, ${d.outputs_linked} registered output${d.outputs_linked === 1 ? '' : 's'} linked, never run again, no new cost: $${d.cost_usd_shown.toFixed(2)} shown, $${d.not_counted_usd.toFixed(2)} of it not in the ledger yet)?`);
      if (!ok) return;
      try { const j = await store.op('jobbooks_import', {}); open.set('_hist', true); toast(`${j.imported.length} history request${j.imported.length === 1 ? '' : 's'} imported from ${j.books.join(', ')} · ${j.skipped.length} skipped`); } catch (er) { toast(`job books: ${er.message}`); }
    };
    const batchAct = async (body, ok) => { try { const j = await store.op('batch_act', body); if (ok) toast(ok(j)); return j; } catch (er) { toast(`not done: ${er.message}`); return null; } };
    render();
    store.generators().then(g => { GI = g; render(); }).catch(() => {});
    // results made in another app, dropped (or picked) on a handed-off row: uploaded into its results/ (handoff_upload, page
    // only), then collected (request_run: its outputs at $0)
    const handoffFiles = async (id, files) => {
      const imgs = [...files].filter(f => /^image\/(png|jpeg|webp)$/.test(f.type) || /\.(png|jpe?g|webp)$/i.test(f.name));
      if (!imgs.length) return toast('drop PNG, JPEG or WebP images');
      let n = 0;
      for (const f of imgs) {
        const data = await new Promise((ok, bad) => { const fr = new FileReader(); fr.onload = () => ok(String(fr.result).split(',')[1] || ''); fr.onerror = bad; fr.readAsDataURL(f); });
        try { await store.op('handoff_upload', { id, name: f.name, data }); n++; } catch (er) { toast(`${f.name}: ${er.message}`); }
      }
      if (n) { toast(`${n} image${n === 1 ? '' : 's'} in ${id}'s results: collecting them`); await run([id]); }
    };
    $list.addEventListener('dragover', (e) => { const d = e.target.closest('.qdrop'); if (d) { e.preventDefault(); e.stopPropagation(); d.classList.add('over'); } });
    $list.addEventListener('dragleave', (e) => { e.target.closest('.qdrop')?.classList.remove('over'); });
    $list.addEventListener('drop', (e) => { const d = e.target.closest('.qdrop'); if (!d) return; e.preventDefault(); e.stopPropagation(); d.classList.remove('over'); handoffFiles(d.dataset.drop, e.dataTransfer.files); });
    const addRequest = async () => {
      const e = est(), video = isVideo(), vs = video ? vSpec() : null, refs = video ? VID.videoRefs(vs) : refsOf();
      if (video) { const bad = VID.videoProblems(vs); if (bad.length) return toast(bad[0]); }
      if (!F.prompt.trim()) return toast(video ? 'write the motion prompt (what moves, one camera move), or apply the photoreal recipe' : 'write a prompt (or apply the photoreal recipe)');
      const extra = { tool: e?.tool, est_why: e?.why, ...(F.takes > 1 ? { takes: F.takes } : {}), ...(video ? { video: vs } : {}) };
      if (F.recipe && F.built) {
        const who = subject();
        extra.recipe = { id: F.built.recipe, v: 2, version: F.built.version, model: F.built.model, framing: F.built.framing, ...(who.name ? { name: who.name } : {}), identity: !!F.identity, ...(who.character ? { character: true } : {}), ...(who.constants?.length ? { constants: who.constants } : {}), ...(F.takes > 1 ? { takes: F.takes } : {}), fields: Object.fromEntries(Object.entries(F.fields).filter(([, v]) => v)), blocks: F.built.blocks.map(({ id, label, text, edited }) => ({ id, label, text, ...(edited ? { edited: true } : {}) })), ...(F.built.negative_prompt ? { negative_prompt: F.built.negative_prompt } : {}) };
        if (F.prompt !== F.built.prompt) extra.recipe.prompt_edited = true;
        if (F.built.warnings.length) extra.warnings = F.built.warnings;
      }
      const r = await store.addRequest({ kind: F.kind.trim() || 'generate', target: F.target.trim() || null, prompt: F.prompt, refs, est_cost: Number(e?.usd || 0), extra });
      toast(`draft request ${r.id} (${r.kind}) · est $${Number(r.est_cost).toFixed(2)} · approve it, then Run it here (or let the agent run it)`);
      Object.assign(F, { open: false, prompt: '', recipe: false, fields: {}, blocks: {}, built: null, takes: 1, start: '', end: '', ref_video: '' }); renderForm();
    };
    // Run (one request) / Run all approved: the local server's runner (lib/run.mjs); progress comes back through its SSE
    const run = async (ids, { retake = false } = {}) => {
      try {
        const j = await store.runRequests(ids, { all: !ids, retake });
        for (const x of j.refused || []) toast(`${x.id} not run: ${x.why}`);
        if (j.started?.length) toast(`running ${j.started.map(x => x.id).join(', ')} · est $${(j.est_total_usd || 0).toFixed(2)}`);
        else if (!(j.refused || []).length) toast('nothing to run');
      } catch (er) { toast(`run failed: ${er.message}`); }
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
      if (q === 'runall') return run(null);
      // D4: waves, batches and the job books
      if (q === 'waves') return openWaves();
      if (q === 'jobbooks') return importJobBooks();
      const bid = e.target.closest('[data-b]')?.dataset.b;
      if (q === 'btog' && bid) { const st = bid === '_hist' ? 'done' : B.gateState(B.batchById(store.requests, bid), store.requests).state; open.set(bid, !isOpen(bid, st)); render(); return; }
      if (q === 'bapprove') { confirming = bid; render(); return; }
      if (q === 'bcancel') { confirming = null; render(); return; }
      if (q === 'bconfirm') { confirming = null; await batchAct({ act: 'approve', id: bid }, (j) => `${bid} approved: ${j.approved.length} request${j.approved.length === 1 ? '' : 's'} · ${money(j.total_usd)} · batch cap ${money(j.max_usd)}${j.cap?.over_cap ? ' · over the cap: queueing will be refused' : ''}`); return; }
      if (q === 'bdismiss') { await batchAct({ act: 'dismiss', id: bid }, () => `${bid} dismissed: its requests stay drafts`); return; }
      if (q === 'breview') { await batchAct({ act: 'review', id: bid }, (j) => `${bid} reviewed${j.unlocked?.length ? ` · ${j.unlocked.join(', ')} unlocked` : ''} · ${j.stats?.takes_per_used_shot ?? '–'} takes per used shot`); return; }
      if (q === 'brun') { try { const j = await store.runRequests(null, { batch: bid }); for (const x of j.refused || []) toast(`${x.id} not run: ${x.why}`); if (j.started?.length) toast(`running ${bid}: ${j.started.map(x => x.id).join(', ')} · est $${(j.est_total_usd || 0).toFixed(2)}`); else if (!(j.refused || []).length) toast('nothing to run'); } catch (er) { toast(`run failed: ${er.message}`); } return; }
      if (q === 'approvesel' || q === 'rejectsel') { const ids = [...sel]; sel.clear(); for (const id of ids) await store.setRequest(id, { status: q === 'approvesel' ? 'approved' : 'rejected' }); toast(`${ids.length} request${ids.length > 1 ? 's' : ''} ${q === 'approvesel' ? 'approved' : 'rejected'}`); return; }
      const row = e.target.closest('tr[data-id]'); if (!row) return;
      const id = row.dataset.id, r = store.requests?.items?.find(x => x.id === id), x = e.target.dataset.x;
      if (!r) return;
      if (x === 'pick') { if (e.target.checked) sel.add(id); else sel.delete(id); render(); return; }
      if ((x === 'vreject' || x === 'vkeep' || x === 'vundo') && bid) return batchAct({ act: 'verdict', id: bid, request: id, verdict: x === 'vundo' ? null : x === 'vreject' ? 'rejected' : 'kept' }, () => `${id}: ${x === 'vundo' ? 'undecided again' : x === 'vreject' ? 'takes rejected' : 'takes kept'}`);
      if (x === 'privok') { await store.setRequest(id, { private_upload_ok: e.target.checked }); toast(e.target.checked ? `${id}: its private refs may be uploaded to fal storage when it runs` : `${id}: private refs stay local (a fal run is refused)`); return; }
      if (x === 'approve') return store.setRequest(id, { status: 'approved' });
      if (x === 'approve0') return store.setRequest(id, { est_cost: 0 }).then(() => store.setRequest(id, { status: 'approved' }));   // edit, then approve: an edit voids an approval
      if (x === 'unapprove' || x === 'redraft') return store.setRequest(id, { status: 'draft' });
      if (x === 'reject') return store.setRequest(id, { status: 'rejected', ...(r.status !== 'draft' ? { why: 'rejected by the director in Review > Queue' } : {}) });
      if (x === 'withdraw') return store.setRequest(id, { status: 'withdrawn', why: 'withdrawn by the director' });
      if (x === 'run') return run([id]);
      if (x === 'reveal' && r.handoff?.pack) { const res = await postJSON('/api/reveal', { path: `${r.handoff.pack}/README.md` }).catch(() => null); if (!res?.ok) toast(`the pack is in ${r.handoff.pack}/ (in the project folder)`); return; }
      if (x === 'retake') return run([id], { retake: true });
      if (x === 'copy') { try { await navigator.clipboard.writeText(r.prompt || ''); toast('prompt copied: paste it in the other app'); } catch (er) { toast('copy failed: the prompt is in ' + (r.handoff?.pack || 'the pack') + '/prompt.txt'); } return; }
      if (x === 'stage' && r.linked) { const L = r.linked; await window.WB.stages?.open(L.type === 'character' ? 'characters' : 'scenery'); (L.type === 'character' ? window.WB.characters : window.WB.scenery)?.open?.(L.id); return; }
      if (!x) window.WB.selection.set(['request:' + id]);
    });
    // the form: typing updates the state; a field or a block rebuilds the prompt (an edited block wins)
    $form.addEventListener('input', (e) => {
      const t = e.target, f = t.dataset.f;
      if (f === 'prompt') { F.prompt = t.value; return; }
      if (f && !['model', 'framing', 'identity', 'start', 'end', 'ref_video', 'orientation', 'seconds'].includes(f)) { F[f] = f === 'seconds' ? Number(t.value) || 5 : f === 'takes' ? Math.min(8, Math.max(1, Math.round(Number(t.value)) || 1)) : t.value; if (f === 'takes' && !F.recipe) { syncPrompt(); return; } if (f === 'refs' || f === 'seconds' || f === 'target' || f === 'takes') { if (F.recipe) { rebuild(); syncBlocks(); } } return; }
      if (t.dataset.fld) { F.fields[t.dataset.fld] = t.value; rebuild(); syncBlocks(); return; }
      if (t.dataset.blk) { F.blocks[t.dataset.blk] = t.value; rebuild(); syncBlocks(); }
    });
    $form.addEventListener('change', (e) => {
      const t = e.target, f = t.dataset.f;
      if (f === 'model' || f === 'framing') {
        F[f] = t.value;
        if (f === 'model' && VID.MODELS[F.model]) { const V = VID.MODELS[F.model]; if (!V.seconds.includes(F.seconds) || F.seconds > V.max) F.seconds = V.def; if (/^(generate|shot-video|motion)$/.test(F.kind)) F.kind = V.ref_video ? 'motion' : 'shot-video'; if (!V.end) F.end = ''; if (!V.ref_video) F.ref_video = ''; }
        if (F.recipe) rebuild(); renderForm();
      }
      if (['start', 'end', 'ref_video', 'orientation', 'seconds'].includes(f)) {
        F[f] = f === 'seconds' ? Number(t.value) || F.seconds : t.value;
        // motion control: the output is as long as the reference clip, so its length sets the seconds
        if (f === 'ref_video' && t.value) { const d = store.mediaByPath?.[t.value]?.duration_ms; if (d) { const V = VID.MODELS[F.model]; F.seconds = Math.min(V.max, Math.max(V.min, Math.ceil(d / 1000 - 0.25))); } }
        if (F.recipe) rebuild(); renderForm();
      }
      if (f === 'identity') { F.identity = t.checked; if (F.recipe) rebuild(); renderForm(); }
    });
    $form.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') { F.open = false; renderForm(); } });
    // keep the focused input; refresh the other blocks and the prompt in place
    const syncPrompt = () => { const p = $form.querySelector('[data-f=prompt]'); if (p) p.value = F.prompt; const est$ = est(); const b = $form.querySelector('.qfrow:last-child b'); if (b) b.textContent = `$${Number(est$?.usd || 0).toFixed(2)}`; const w = $form.querySelector('.qwarn'); if (w) w.innerHTML = F.recipe && F.built ? F.built.warnings.map(x => `<span>⚠ ${esc(x)}</span>`).join('') : ''; };
    // in place (never a re-render while typing: the focus stays): block texts, their marks, the warnings, the estimate
    const syncBlocks = () => { for (const b of F.built.blocks) { const ta = $form.querySelector(`[data-blk="${b.id}"]`); if (!ta) continue; if (ta !== document.activeElement) ta.value = b.text; ta.parentElement.classList.toggle('unfilled', /\[fill:/.test(b.text)); ta.parentElement.classList.toggle('edited', !!b.edited); } syncPrompt(); };
    $list.addEventListener('change', (e) => {
      const row = e.target.closest('tr[data-id]'); if (!row) return;
      if (e.target.dataset.x === 'hofiles') { const fl = e.target.files; if (fl?.length) handoffFiles(row.dataset.id, fl); return; }
      if (e.target.dataset.x === 'prompt') store.setRequest(row.dataset.id, { prompt: e.target.value });
      if (e.target.dataset.x === 'cost') store.setRequest(row.dataset.id, { est_cost: Number(e.target.value) || 0 });
    });
    // never re-render under the director's cursor (focused field, or mid-click); a skipped render runs once focus has
    // left the pane and the click is over, so the agent's status changes still show up
    let stale = false, down = false;
    // (a focused button or checkbox is no reason to wait: only a field being typed in is)
    const typing = () => { const a = document.activeElement; return $list.contains(a) && a.matches('textarea, input:not([type=checkbox])'); };
    const flush = () => { if (stale && !down && !typing()) { stale = false; render(); } };
    store.on((w) => { if (!['requests', 'all', 'runs', 'settings', 'costs', 'board', 'media'].includes(w)) return; stale = true; flush(); });
    el.addEventListener('focusout', () => setTimeout(flush));
    $list.addEventListener('pointerdown', () => { down = true; });
    document.addEventListener('pointerup', () => { if (down) { down = false; setTimeout(flush); } }, true);
  },
};
