// E4 render jobs and E8 contact sheets in the page (ROADMAP_v4). The director's acts go through the server's page-only ops:
// render_config (Render settings…: the command as one argument a line, with {placeholders}; its folder; the warm-up; the
// RAM floor; workers, size), render_start (Render…: ALWAYS after a confirm that shows the range, the free RAM against the
// floor, the command as it will run and, for the full film, the chapters not rendered yet), render_cancel. Anyone makes a
// contact sheet (sheet_make: of a render, a request's takes, the storyboard) and the director asks the agent for a second
// opinion on one (sheet_ask: a note to the agent; its review comes back with sheet_review and shows as a badge).
// Shown: Final › "Renders and sheets" (mountRenders), Review › Queue (render rows: renderActions; a done request's
// "Sheet"), Review › Compare (compareSheetsHtml: the sheets of revision A and B), and the sheet viewer (openSheet).
// Buttons anywhere carry data-rn="<act>" data-id="<id>": one delegate here handles them.
// API: WB.renders = {mount, openSheet, openSettings, openNew, start, cancel, sheet, ask, refresh}
import { commands } from './commands.js';
import { menus } from './menus.js';
import { openDialog } from './dialog.js';
import { store, toast, esc, mediaUrl } from '../js/store.js';
import * as RN from '../js/renders.js';
import { chaptersView } from '../js/chapters.js';
import { currentScript } from '../js/scenes.js';
import { packagesHtml } from './package.js';

const CSS = `.rnp{border:1px solid var(--line2);background:var(--bg2);margin:4px 0;padding:3px 6px;font-size:11.5px}
.fnrend.rnp{flex:none;margin:2px 4px;max-height:36vh;overflow:auto}
.rnp .rnh{display:flex;gap:8px;align-items:center;flex-wrap:wrap} .rnp .rnh b{font-size:12px} .rnp .sp{flex:1}
.rnp .rnrow{display:grid;grid-template-columns:150px 80px 1fr auto;gap:6px;align-items:center;padding:2px 0;border-top:1px solid var(--line2)}
.rnp .rnlog{font:10.5px Consolas,monospace;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rnp .rnsh{display:flex;gap:6px;flex-wrap:wrap;padding:3px 0;border-top:1px solid var(--line2)}
.rncard{width:176px;border:1px solid var(--line2);background:var(--bg);cursor:pointer;font-size:10.5px;line-height:13px}
.rncard img{display:block;width:176px;height:66px;object-fit:cover;object-position:top left;background:#111}
.rncard div{padding:1px 3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rnbadge{display:inline-block;padding:0 4px;border-radius:2px;font-size:10px;line-height:13px;border:1px solid var(--line)}
.rnbadge.ok{color:#7fbf8f;border-color:#3f6f4f} .rnbadge.issues{color:#f5a524;border-color:#7a5a20} .rnbadge.fail{color:#f08080;border-color:#7a3a3a} .rnbadge.ask{color:var(--acc)}
.rnph{color:var(--acc)} .rnph.failed,.rnph.cancelled{color:#f08080} .rnph.done{color:#7fbf8f}
.rnform{display:grid;grid-template-columns:120px 1fr;gap:4px 8px;align-items:start}
.rnform textarea,.rnform input{font:11.5px Consolas,monospace;width:100%;box-sizing:border-box} .rnform textarea{height:120px;resize:vertical}
.rnform .num{display:flex;gap:10px;flex-wrap:wrap} .rnform .num label{display:flex;gap:4px;align-items:center} .rnform .num input{width:70px}
.rnfoot{display:flex;gap:6px;align-items:center;margin-top:6px} .rnfoot .sp{flex:1}
.rnerr{color:#f08080} .rnok{color:#7fbf8f} .rnwarn{color:#f5a524}
.rncmd{font:11px Consolas,monospace;background:var(--bg);border:1px solid var(--line2);padding:3px 5px;word-break:break-all;max-height:90px;overflow:auto}
.rnview img{max-width:100%;display:block;border:1px solid var(--line2)} .rnview .rnfr{font-size:11px;max-height:150px;overflow:auto}
.rnview table{border-collapse:collapse;width:100%} .rnview td{padding:1px 4px;border-bottom:1px solid var(--line2);vertical-align:top}
.rnlogv{font:10.5px Consolas,monospace;white-space:pre-wrap;max-height:50vh;overflow:auto;background:var(--bg);padding:4px;border:1px solid var(--line2)}
.cmpsheets{display:grid;grid-template-columns:1fr 1fr;gap:8px} .cmpsheets h5{margin:2px 0;font-size:11px;color:var(--dim);font-weight:normal}`;
const css = () => { if (!document.getElementById('rncss')) { const st = document.createElement('style'); st.id = 'rncss'; st.textContent = CSS; document.head.appendChild(st); } };
const WB = () => window.WB;
const renders = () => (store.requests?.items || []).filter(RN.isRender);
const doc = () => store.renders || RN.emptyRenders();
const cfg = () => RN.configOf(doc());
const chapters = () => chaptersView(store.board, { scenes: currentScript(store.scenes)?.scenes || [], shots: store.boardShots(), approvals: store.approvals, requests: store.requests });
const imgUrl = (s) => `${mediaUrl(s.file)}?v=${encodeURIComponent(s.at || '')}`;
const badge = (s) => { const r = RN.lastReview(s), asked = (s.asks || []).length && !r; return r ? `<span class="rnbadge ${esc(r.verdict)}" title="${esc(`second opinion: ${r.verdict}${r.note ? ' · ' + r.note : ''}`)}">${r.verdict === 'ok' ? '✓ ok' : r.verdict === 'issues' ? '⚠ issues' : '✗ fail'}</span>` : asked ? '<span class="rnbadge ask" title="asked: the agent reviews it">asked</span>' : ''; };
let machine = null, lastFetch = 0;
async function refresh() {
  try { const r = await store.op('renders_get', {}); machine = r.machine; lastFetch = Date.now(); live = r.renders.filter(x => x.status === 'running'); for (const f of panels) f(); return r; } catch (e) { return null; }
}
let live = [];
const panels = new Set();
let poll = 0;
function watch() {   // while a render runs: its phase and log tail every second
  clearInterval(poll);
  if (!renders().some(r => r.status === 'running')) return;
  poll = setInterval(async () => { await refresh(); if (!renders().some(r => r.status === 'running')) { clearInterval(poll); poll = 0; refresh(); } }, 1000);
}
store.on((w) => { if (w === 'requests' || w === 'renders' || w === 'all') { for (const f of panels) f(); if (!poll) watch(); } });

// ------------------------------------------------------------------ acts
async function start(id) {
  const r = renders().find(x => x.id === id); if (!r) return;
  if (!doc().config?.command) { toast('set the render command first (Render settings…)'); return openSettings(); }
  const m = (await refresh())?.machine || machine || {}, c = cfg(), s = r.render || {};
  const gaps = s.scope === 'full' ? RN.orderGaps(chapters(), store.requests?.items || []) : [];
  const vals = { out: `…/renders/${id}/${id}.mp4`, from: (s.t0 / 1000).toFixed(3), to: (s.t1 / 1000).toFixed(3), duration: ((s.t1 - s.t0) / 1000).toFixed(3), from_ms: s.t0, to_ms: s.t1, scope: s.scope, chapter: s.chapter || '', chapter_file: '', width: c.width, height: c.height, fps: c.fps, workers: c.workers, id, project: '', project_dir: '…' };
  const low = m.free_ram_mb != null && m.free_ram_mb <= c.min_free_mb, busy = m.lock;
  const d = openDialog({ id: 'rnconfirm', title: `Render ${RN.specLabel(r)}?`, wide: true, html: `
    <p>${esc(RN.specLabel(r))} · ${((s.t1 - s.t0) / 1000).toFixed(1)} s · ${c.width}x${c.height} · ${c.workers} worker${c.workers > 1 ? 's' : ''} · local, $0, but heavy</p>
    <p>Free RAM now <b class="${low ? 'rnwarn' : 'rnok'}">${esc(m.free_ram_mb ?? '?')} MB</b> (the floor: ${c.min_free_mb} MB${low ? `: it will wait ${c.ram_wait_s} s and check again, up to ${c.ram_tries} times` : ''})${busy ? ` · <b class="rnerr">a render is running (${esc(busy.project)}/${esc(busy.id)}): one at a time</b>` : ''}</p>
    ${c.warm ? `<div class="dim">warm-up first:</div><div class="rncmd">${esc(RN.fillArgv(c.warm, vals).join(' '))}</div>` : '<div class="dim">no warm-up command (Render settings…): a cold cache renders slower and uses more RAM</div>'}
    <div class="dim">the command (no shell; {out} is the file it must write):</div><div class="rncmd">${esc(RN.fillArgv(c.command, vals).join(' '))}</div>
    ${gaps.length ? `<p class="rnwarn">Chapters before the full film: ${esc(gaps.join(', '))} not rendered yet.</p><label><input type="checkbox" data-f="force"> render the full film anyway</label>` : ''}
    <div class="rnfoot"><span class="dim">the outputs (MP4, contact sheet, seams sheet) are registered and linked to ${esc(RN.currentRevision(store.revisions))}</span><span class="sp"></span><button data-x="no">Cancel</button><button data-x="go" class="pri"${busy ? ' disabled' : ''}>Render</button></div>
    <div class="rnres"></div>` });
  d.el.addEventListener('click', async (e) => {
    const x = e.target.closest('[data-x]')?.dataset.x; if (!x) return;
    if (x === 'no') return d.close();
    try {
      const force = !!d.el.querySelector('[data-f=force]')?.checked;
      if (gaps.length && !force) { d.el.querySelector('.rnres').innerHTML = '<span class="rnerr">tick "render the full film anyway", or render the chapters first</span>'; return; }
      const j = await store.op('render_start', { id, ...(force ? { force_order: true } : {}) });
      d.close(); toast(`render ${j.label} started`); setTimeout(() => { refresh(); watch(); }, 300);
    } catch (er) { d.el.querySelector('.rnres').innerHTML = `<span class="rnerr">${esc(er.message)}</span>`; }
  });
  return d;
}
async function cancel(id) { try { await store.op('render_cancel', { id }); toast(`render ${id}: cancelling`); } catch (e) { toast('not cancelled: ' + e.message); } }
async function sheet(body) {
  toast('making the contact sheet (ffmpeg)…');
  try { const r = await store.op('sheet_make', body); toast(`contact sheet ${r.sheet}: ${r.tiles} frames`); setTimeout(() => openSheet(r.sheet), 400); return r; } catch (e) { toast('no sheet: ' + e.message); return null; }
}
async function ask(id) { try { const r = await store.op('sheet_ask', { sheet: id }); toast(`asked the agent for a second opinion on ${id} (note ${r.note})`); return r; } catch (e) { toast('not asked: ' + e.message); return null; } }
async function showLog(id) {
  const r = await store.op('renders_get', { id, log_lines: 400 }).catch(() => null), x = r?.renders?.[0];
  openDialog({ id: 'rnlog', title: `Render log · ${id}`, wide: true, html: `<div class="dim">${esc(x?.log_file || '')}</div><div class="rnlogv">${esc((x?.log_tail || []).join('\n') || '(empty)')}</div>` });
}

// ------------------------------------------------------------------ the sheet viewer
export function openSheet(id) {
  css();
  const s = doc().sheets.find(x => x.id === id); if (!s) return toast(`no sheet ${id}`);
  const revs = s.reviews || [], open = (s.asks || []).length && !revs.length;
  const d = openDialog({ id: 'rnsheet', title: `${s.kind === 'seams' ? 'Seams sheet' : 'Contact sheet'} · ${s.title || s.id}`, wide: true, html: `<div class="rnview">
    <div class="dim">${esc(s.from)}${s.source && s.source !== 'storyboard' ? ' ' + esc(s.source) : ''} · ${esc(s.revision || 'R0')} · ${esc(String(s.at || '').replace('T', ' '))} · ${(s.frames || []).length} frames ${badge(s)}</div>
    <a href="${esc(imgUrl(s))}" target="_blank" title="full size"><img src="${esc(imgUrl(s))}" alt=""></a>
    ${revs.length ? revs.slice().reverse().map(r => `<div style="margin-top:4px"><span class="rnbadge ${esc(r.verdict)}">${esc(r.verdict)}</span> <b>${esc(r.by)}</b> <span class="dim">${esc(String(r.at).replace('T', ' '))}</span> ${esc(r.note)}
      ${r.items?.length ? `<table>${r.items.map(i => `<tr><td>${i.ok ? '✓' : '✗'}</td><td>${i.t != null ? esc(RN.tc(i.t)) : ''}</td><td>${esc(i.shot || '')}</td><td>${esc(i.constant || '')}</td><td>${esc(i.note)}</td></tr>`).join('')}</table>` : ''}</div>`).join('') : ''}
    <div class="rnfoot"><span class="dim">${open ? 'the agent was asked for a second opinion' : 'a second opinion: the agent reviews this sheet against the script and the characters\' constants'}</span><span class="sp"></span><button data-x="ask" class="${open ? '' : 'pri'}">${open ? 'Ask again' : 'Ask for a second opinion'}</button></div></div>` });
  d.el.addEventListener('click', async (e) => { if (e.target.closest('[data-x=ask]')) { await ask(id); d.close(); } });
  return d;
}

// ------------------------------------------------------------------ settings (the director's command) and a new render
export function openSettings() {
  css();
  const c = doc().config || RN.DEFAULT_CONFIG;
  const nums = ['min_free_mb', 'ram_wait_s', 'ram_tries', 'abort_below_mb', 'workers', 'width', 'height', 'fps', 'excerpt_max_s', 'sheet_every_s', 'timeout_min', 'verify_n', 'sample_fps'];
  const d = openDialog({ id: 'rnsettings', title: 'Render settings', wide: true, html: `<div class="rnform">
    <span>Command</span><span><textarea data-f="command" spellcheck="false" placeholder="node&#10;C:\\path\\to\\node_modules\\hyperframes\\dist\\cli.js&#10;render&#10;-o&#10;{out}&#10;-w&#10;{workers}">${esc((c.command || []).join('\n'))}</textarea><span class="dim">one argument a line, the program first; no shell. It must write {out}. Placeholders: ${Object.keys(RN.PLACEHOLDERS).map(k => `<code title="${esc(RN.PLACEHOLDERS[k])}">{${k}}</code>`).join(' ')}</span></span>
    <span>Folder</span><span><input data-f="cwd" value="${esc(c.cwd || '')}" placeholder="absolute folder it runs in (empty: the project folder)" spellcheck="false"></span>
    <span>Warm-up</span><span><textarea data-f="warm" style="height:54px" spellcheck="false" placeholder="optional: a command run first (warm the frame cache)">${esc((c.warm || []).join('\n'))}</textarea></span>
    <span>Composition</span><span><input data-f="composition" value="${esc(c.composition || '')}" placeholder="absolute folder of the HyperFrames composition (empty: the folder above)" spellcheck="false"><span class="dim">File › Export › Interactive HTML package… packages it: entry <input data-f="entry" value="${esc(c.entry || 'index.html')}" style="width:110px" spellcheck="false"> · HyperFrames dist folder <input data-f="hyperframes" value="${esc(c.hyperframes || '')}" style="width:200px" placeholder="optional" spellcheck="false"></span></span>
    <span>Etiquette</span><span class="num">${nums.map(k => `<label title="${k}">${k.replace(/_/g, ' ')} <input data-n="${k}" value="${esc(c[k])}"></label>`).join('')}</span>
    </div><div class="rnfoot"><span class="rnres dim">only you set this: an agent proposes renders, never a command</span><span class="sp"></span><button data-x="save" class="pri">Save</button></div>` });
  d.el.addEventListener('click', async (e) => {
    if (!e.target.closest('[data-x=save]')) return;
    const lines = (f) => d.el.querySelector(`[data-f=${f}]`).value.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    const val = (f) => d.el.querySelector(`[data-f=${f}]`).value.trim() || null;
    const config = { command: lines('command'), cwd: val('cwd'), warm: lines('warm'), composition: val('composition'), entry: val('entry'), hyperframes: val('hyperframes'), ...Object.fromEntries(nums.map(k => [k, d.el.querySelector(`[data-n=${k}]`).value.trim()])) };
    try { await store.op('render_config', { config }); toast('render settings saved'); d.close(); }
    catch (er) { const r = d.el.querySelector('.rnres'); r.className = 'rnres rnerr'; r.textContent = er.message; }
  });
  return d;
}
export function openNew(pre = {}) {
  css();
  const chs = chapters().filter(c => c.t1 > c.t0), ph = WB()?.timeline?.player?.time?.() || 0, c = cfg();
  const t0 = pre.t0 ?? Math.round(ph), t1 = pre.t1 ?? Math.min(store.song?.duration_ms || 0, t0 + Math.min(10, c.excerpt_max_s) * 1000);
  const d = openDialog({ id: 'rnnew', title: 'New render', html: `<div class="rnform">
    <span>Scope</span><span><select data-f="scope"><option value="excerpt">excerpt (at most ${c.excerpt_max_s} s)</option><option value="chapter"${chs.length ? '' : ' disabled'}>a chapter</option><option value="full">the full film</option></select></span>
    <span>Excerpt</span><span><input data-f="t0" value="${(t0 / 1000).toFixed(2)}" style="width:80px"> → <input data-f="t1" value="${(t1 / 1000).toFixed(2)}" style="width:80px"> s</span>
    <span>Chapter</span><span><select data-f="chapter">${chs.map(x => `<option value="${esc(x.id)}">${esc(x.id)} · ${esc(x.name)} · ${esc(RN.tc(x.t0))}–${esc(RN.tc(x.t1))}</option>`).join('') || '<option value="">no chapters</option>'}</select></span>
    <span>Why</span><span><input data-f="why" placeholder="what to look at" spellcheck="false"></span></div>
    <div class="rnfoot"><span class="rnres dim">a draft; Render… asks before it starts</span><span class="sp"></span><button data-x="add">Add draft</button><button data-x="addgo" class="pri">Add and render…</button></div>` });
  if (pre.scope) d.el.querySelector('[data-f=scope]').value = pre.scope;
  d.el.addEventListener('click', async (e) => {
    const x = e.target.closest('[data-x]')?.dataset.x; if (!x) return;
    const v = (f) => d.el.querySelector(`[data-f=${f}]`).value, scope = v('scope');
    try {
      const r = await store.op('render_propose', { scope, ...(scope === 'excerpt' ? { t0: Math.round(Number(v('t0')) * 1000), t1: Math.round(Number(v('t1')) * 1000) } : {}), ...(scope === 'chapter' ? { chapter: v('chapter') } : {}), why: v('why') });
      d.close(); toast(`render ${r.request.id} added (draft)`);
      if (x === 'addgo') { await store.reload(['requests.json']); start(r.request.id); }
    } catch (er) { const r = d.el.querySelector('.rnres'); r.className = 'rnres rnerr'; r.textContent = er.message; }
  });
  return d;
}

// ------------------------------------------------------------------ the panel (Final) and the Queue rows
export function renderActions(r) {
  if (r.status === 'running') { const ph = r.render_run?.phase || 'running'; return `<span class="rnph ${esc(ph)}">⟳ ${esc(RN.PHASES[ph] || ph)}</span><button data-rn="cancel" data-id="${esc(r.id)}">Cancel</button><button data-rn="log" data-id="${esc(r.id)}">Log</button>`; }
  if (r.status === 'done') return `<span class="rnph done">✓ rendered · $0</span>${(r.render_run?.sheets || []).map(s => `<button data-rn="sheet" data-id="${esc(s)}">${/seams/.test(s) ? 'Seams' : 'Sheet'}</button>`).join('')}<button data-rn="log" data-id="${esc(r.id)}">Log</button>`;
  if (['draft', 'approved', 'failed'].includes(r.status)) return `${r.status === 'failed' ? `<span class="rnph failed" title="${esc(r.why || '')}">✕ ${esc(String(r.why || 'failed').slice(0, 90))}</span>` : ''}<button data-rn="start" data-id="${esc(r.id)}" class="pri" title="asks before it starts: one render at a time, enough free RAM, your command">Render…</button>${r.status === 'failed' ? `<button data-rn="log" data-id="${esc(r.id)}">Log</button>` : ''}`;
  return '';
}
export function mountRenders(host) {
  css();
  host.classList.add('rnp');
  const draw = () => {
    if (!host.isConnected) { panels.delete(draw); return; }
    const rs = renders().slice().reverse(), sh = doc().sheets.slice().reverse().slice(0, 10), c = doc().config;
    const tail = (r) => (live.find(x => x.id === r.id)?.log_tail || []).at(-1) || '';
    host.innerHTML = `<div class="rnh"><b>Renders and sheets</b><span class="dim">local, $0, one at a time${machine ? ` · free RAM ${esc(machine.free_ram_mb)} MB (floor ${esc(machine.floor_mb)})` : ''}${machine?.lock ? ` · <b>rendering ${esc(machine.lock.id)}</b>` : ''}</span><span class="sp"></span>
      <a data-rn="new">+ New render…</a> · <a data-rn="sbsheet" title="one tile per storyboard shot: its take, frame or placeholder">Sheet of the storyboard</a> · <a data-rn="settings"${c ? '' : ' class="rnwarn"'}>Render settings…${c ? '' : ' (not set)'}</a></div>`
      + (rs.length ? rs.slice(0, 8).map(r => `<div class="rnrow" data-sel="request:${esc(r.id)}"><span><b>${esc(RN.specLabel(r))}</b><div class="dim">${esc(r.id)}${r.render?.why ? ' · ' + esc(r.render.why) : ''}</div></span><span class="chip ${({ done: 's-locked', running: 's-review', failed: 's-changes', withdrawn: 's-archived' })[r.status] || ''}">${esc(r.status)}</span>`
        + `<span class="rnlog" title="${esc(tail(r))}">${r.status === 'running' ? esc(tail(r) || RN.PHASES[r.render_run?.phase] || '') : r.render_run?.ram ? `RAM min ${esc(r.render_run.ram.min_mb)} MB${r.render_run.revision ? ' · ' + esc(r.render_run.revision) : ''}` : esc(r.by || '')}</span><span>${renderActions(r)}</span></div>`).join('')
        : '<div class="dim" style="padding:2px 0">no render yet: + New render… (or the agent proposes one); chapters first, then the full film</div>')
      + packagesHtml()
      + (sh.length ? `<div class="rnsh">${sh.map(s => `<div class="rncard" data-rn="sheet" data-id="${esc(s.id)}" title="${esc(s.title || s.id)}"><img src="${esc(imgUrl(s))}" alt="" loading="lazy"><div>${esc(s.kind === 'seams' ? 'seams' : s.from)} ${esc(s.source && s.source !== 'storyboard' ? s.source : '')} ${badge(s)}</div><div class="dim">${esc(s.revision || 'R0')} · ${esc(String(s.at || '').slice(5, 16).replace('T', ' '))}</div></div>`).join('')}</div>` : '');
  };
  panels.add(draw); draw();
  if (Date.now() - lastFetch > 2000) refresh(); else draw();
  watch();
  return { refresh: draw };
}
// Compare: the sheets of revision A and of revision B, side by side ("now" = the newest)
export function compareSheetsHtml(a, b) {
  css();
  const all = doc().sheets, pick = (r) => (r === 'now' ? all.slice().reverse() : RN.sheetsOfRevision(doc(), r)).slice(0, 4);
  const col = (r) => { const l = pick(r); return `<div><h5>${esc(r)} · ${l.length} sheet${l.length === 1 ? '' : 's'}</h5>${l.length ? l.map(s => `<div class="rncard" data-rn="sheet" data-id="${esc(s.id)}" style="width:auto"><img src="${esc(imgUrl(s))}" alt="" loading="lazy" style="width:100%;height:auto;max-height:140px"><div>${esc(s.kind)} · ${esc(s.from)} ${esc(s.source && s.source !== 'storyboard' ? s.source : '')} ${badge(s)}</div></div>`).join('') : '<div class="dim">no sheet for this revision (render one from Final)</div>'}</div>`; };
  return `<h4>Renders and sheets <span class="dim">the contact sheets made at each revision</span></h4><div class="cmpsheets">${col(a)}${col(b)}</div>`;
}

// one delegate for every data-rn button / card on the page
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-rn]'); if (!b) return;
  const act = b.dataset.rn, id = b.dataset.id;
  e.preventDefault();
  if (act === 'start') return start(id);
  if (act === 'cancel') return cancel(id);
  if (act === 'log') return showLog(id);
  if (act === 'sheet') return openSheet(id);
  if (act === 'new') return openNew();
  if (act === 'settings') return openSettings();
  if (act === 'sbsheet') return sheet({ from: 'storyboard' });
  if (act === 'reqsheet') return sheet({ from: 'request', id });
});

commands.register([
  { id: 'renders.new', group: 'Render', title: 'New render… (an excerpt, a chapter, the full film)', run: () => openNew() },
  { id: 'renders.settings', group: 'Render', title: 'Render settings… (your render command)', run: () => openSettings() },
  { id: 'renders.sheetStoryboard', group: 'Render', title: 'Contact sheet of the storyboard', run: () => sheet({ from: 'storyboard' }) },
  { id: 'renders.show', group: 'Render', title: 'Renders and sheets (Final)', run: () => WB()?.stages?.open('final') },
]);
menus.contribute('menubar:Generate', ['-', 'renders.new', 'renders.sheetStoryboard', 'renders.settings']);
window.WB = Object.assign(window.WB || {}, { renders: { mount: mountRenders, openSheet, openSettings, openNew, start, cancel, sheet, ask, refresh } });
