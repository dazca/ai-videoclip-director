// File › Export › Interactive HTML package… (ROADMAP_v4 C5): the render handoff from the page. ONE dialog, the director's only:
//   1. the confirm: the composition (Render settings…: its folder and entry; never a path typed here), the render the package will
//      be checked against (the newest done render, or another one; none = not checked), the agent's proposals (package_propose) to
//      start instead of a new export, the machine (free RAM vs the floor, a render or export already running: one at a time)
//   2. Export -> package_start (page only): the workbench runs its own exporter (exporters/hyperframes-html/export.mjs --interactive)
//      then verify.mjs --against the render; the dialog follows the phase and the log tail (renders_get) and can cancel it
//   3. the frame-match report: frames matched / compared (pass rate), the verdict, MAD / PSNR means, the problems, the worst frames
//      as thumbnails (package | render side by side), the folder (Open folder) and how to serve it; the package is registered in
//      renders.json packages[] with the revision.
// Also: the Queue's rows of kind package (packageActions: Export…, Cancel, Log, Report) and Final's "HTML packages" lines
// (packagesHtml). Buttons carry data-pk="<act>" data-id="<id>": one delegate here.
// API: WB.package = {open, report, start, cancel, refresh}
import { commands } from './commands.js';
import { openDialog } from './dialog.js';
import { projects } from './projects.js';
import { store, toast, esc, mediaUrl } from '../js/store.js';
import * as RN from '../js/renders.js';

const CSS = `.pkdlg .pkg{display:grid;grid-template-columns:110px 1fr;gap:4px 8px;align-items:start;margin:2px 0 6px}
.pkdlg .pkg code,.pkdlg .pkpath{font:11px Consolas,monospace;word-break:break-all}
.pkdlg .pkprop{display:block;margin:1px 0} .pkdlg select{max-width:100%}
.pkdlg .pkph{font-size:12px;margin:4px 0} .pkdlg .pkph b{color:var(--acc)}
.pkdlg .pklog{font:10.5px Consolas,monospace;white-space:pre-wrap;max-height:180px;overflow:auto;background:var(--bg);padding:4px;border:1px solid var(--line2);color:var(--dim)}
.pkrep .pkhead{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;margin:2px 0 6px} .pkrep .pkrate{font-size:20px;font-weight:600}
.pkrep .pkrate.pass{color:#7fbf8f} .pkrep .pkrate.fail{color:#f08080} .pkrep .pkrate.none{color:var(--dim)}
.pkrep .pkworst{display:grid;grid-template-columns:repeat(2,1fr);gap:6px}
.pkrep .pkfr{border:1px solid var(--line2);background:var(--bg);font-size:10.5px} .pkrep .pkfr.bad{border-color:#7a3a3a}
.pkrep .pkfr img{display:block;width:100%;height:auto;background:#111} .pkrep .pkfr div{padding:1px 4px;display:flex;gap:6px}
.pkrep .pkfr .b{color:#f08080} .pkrep .pkfr .g{color:#7fbf8f} .pkrep ul{margin:2px 0 4px 16px;padding:0;color:#f5a524}
.pkline{display:grid;grid-template-columns:150px 80px 1fr auto;gap:6px;align-items:center;padding:2px 0;border-top:1px solid var(--line2)}
.pkchip{display:inline-block;padding:0 4px;border-radius:2px;font-size:10px;line-height:13px;border:1px solid var(--line)} .pkchip.pass{color:#7fbf8f;border-color:#3f6f4f} .pkchip.fail{color:#f08080;border-color:#7a3a3a}`;
const css = () => { if (!document.getElementById('pkcss')) { const st = document.createElement('style'); st.id = 'pkcss'; st.textContent = CSS; document.head.appendChild(st); } };
const items = () => store.requests?.items || [];
const jobs = () => items().filter(RN.isPackage);
const doc = () => RN.normRenders(store.renders);
const when = (at) => String(at || '').replace('T', ' ').slice(5, 16);
let state = null;   // the last renders_get (machine, composition, against, exports with their log tails)
async function refresh() { try { state = await store.op('renders_get', {}); return state; } catch (e) { return null; } }

// ------------------------------------------------------------------ the report (a done package)
export function reportHtml(pk) {
  const r = pk?.report;
  if (!r) return `<div class="pkrep"><div class="pkhead"><span class="pkrate none">not checked</span><span class="dim">no done render to compare with when it was exported: render one (Final › Renders), then export again</span></div></div>`;
  const vdir = RN.RENDER_ID.test(String(pk.id)) ? `exports/package/${pk.id}-verify` : '';   // named from the id (as the server writes it)
  return `<div class="pkrep"><div class="pkhead"><span class="pkrate ${esc(r.verdict)}">${r.pass} / ${r.frames} frames match · ${esc(RN.pctOf(r))}</span>
      <span class="pkchip ${esc(r.verdict)}">${r.verdict === 'pass' ? '✓ pass' : '✗ fail'}</span>
      <span class="dim">against ${esc(pk.against?.render || '?')} (${esc(pk.against ? RN.specLabel({ render: pk.against }) : '')}) · MAD mean ${esc(r.mad_mean)} % · PSNR mean ${esc(r.psnr_mean)} dB · a frame matches under ${esc(r.thresholds?.max_mad_pct)} % MAD and over ${esc(r.thresholds?.min_psnr)} dB</span></div>
    ${r.problems?.length ? `<ul>${r.problems.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    <div class="dim" style="margin:2px 0">the worst frames (package | render):</div>
    <div class="pkworst">${(r.worst || []).map(w => `<div class="pkfr${w.bad ? ' bad' : ''}">${w.image && RN.PKG_IMG.test(w.image) ? `<a href="${esc(mediaUrl(`${vdir}/${w.image}`))}" target="_blank" title="full size"><img src="${esc(mediaUrl(`${vdir}/${w.image}`))}" alt="" loading="lazy"></a>` : ''}
      <div><b>${esc(Number(w.t).toFixed(2))} s</b><span>frame ${esc(w.frame)}</span><span class="${w.bad ? 'b' : 'g'}">MAD ${esc(w.mad)} %</span><span>PSNR ${esc(w.psnr)} dB</span>${w.bad ? '<span class="b">✗</span>' : ''}</div></div>`).join('')}</div></div>`;
}
function folderHtml(pk) {
  return `<div class="pkg"><span>Package</span><span><span class="pkpath">${esc(pk.abs || pk.dir + '/')}</span> · ${esc(pk.manifest?.assets ?? '?')} composition file${pk.manifest?.assets === 1 ? '' : 's'}${pk.manifest?.bytes ? ` · ${(pk.manifest.bytes / 1048576).toFixed(1)} MB` : ''} · ${esc(pk.revision || 'R0')} · ${esc(when(pk.at))}
    ${pk.manifest?.system_fonts?.length ? `<div class="rnwarn">relies on fonts installed on the viewer's machine: ${esc(pk.manifest.system_fonts.join(', '))}</div>` : ''}
    <div class="dim">serve it with <code>node exporters/hyperframes-html/serve.mjs "${esc(pk.abs || pk.dir)}"</code> (any static server with byte ranges)</div></span></div>
    <div class="wbdlgf"><span class="sp"></span><button data-pk="reveal" data-id="${esc(pk.id)}">Open folder</button></div>`;
}
export function report(id) {
  css();
  const pk = doc().packages.find(x => x.id === id); if (!pk) return toast(`no package ${id}`);
  const d = openDialog({ id: 'pkreport', title: `Interactive HTML package · ${id}`, wide: true, html: `<div class="pkdlg">${reportHtml(pk)}${folderHtml(pk)}</div>` });
  return d;
}

// ------------------------------------------------------------------ the dialog: confirm, progress, report
let dlg = null, poll = 0;
export async function open(pre = {}) {
  css();
  const s = await refresh();
  // from the server's answer (the page's copy of requests.json may be a moment behind a render that just finished)
  const done = (s?.renders || []).filter(r => r.status === 'done' && r.run?.out).map(r => ({ id: r.id, label: r.label, ended: r.run.ended || r.at })).reverse();
  const props = (s?.exports || jobs()).filter(r => ['draft', 'approved', 'failed'].includes(r.status)).slice().reverse();
  const running = (s?.exports || jobs()).find(r => r.status === 'running');
  const comp = s?.composition || {}, m = s?.machine || {}, c = RN.configOf(doc()), ag = s?.against;
  dlg = openDialog({ id: 'pkdlg', title: 'Export the interactive HTML package', wide: true, html: `<div class="pkdlg"><div class="pkbody"></div></div>` });
  const body = dlg.el.querySelector('.pkbody');
  if (running) { follow(running.id); return dlg; }
  const pick = pre.id && props.find(r => r.id === pre.id) ? pre.id : '';
  const low = m.free_ram_mb != null && m.free_ram_mb <= c.min_free_mb;
  body.innerHTML = `<p class="dim" style="margin:0 0 6px">The composition itself, packaged 1:1 (byte-identical files, the official player, lazy media, the click-anything layer), then checked frame by frame against a render. Local, $0, heavy: one render or export at a time.</p>
    <div class="pkg"><span>Composition</span><span>${comp.dir ? `<span class="pkpath">${esc(comp.dir)}</span> · <code>${esc(comp.entry || 'index.html')}</code>` : '<b class="rnerr">not set</b>'} · <a data-pk="settings">Render settings…</a></span>
      <span>Checked against</span><span>${done.length ? `<select data-f="against">${done.map(r => `<option value="${esc(r.id)}"${r.id === ag?.id ? ' selected' : ''}>${esc(r.id)} · ${esc(r.label)} · ${esc(when(r.ended))}</option>`).join('')}</select>` : '<span class="rnwarn">no done render yet: the package will not be checked (Final › Renders: render one first)</span>'}</span>
      ${props.length ? `<span>Proposed</span><span><label class="pkprop"><input type="radio" name="pkp" value=""${pick ? '' : ' checked'}> a new export</label>${props.map(r => `<label class="pkprop"><input type="radio" name="pkp" value="${esc(r.id)}"${r.id === pick ? ' checked' : ''}> ${esc(r.id)} · ${esc(r.by === 'director' ? 'yours' : 'the agent\'s')}${r.package?.why ? ': ' + esc(r.package.why) : ''}${r.status === 'failed' ? ` <span class="rnerr">(failed: ${esc(String(r.why || '').slice(0, 80))})</span>` : ''}</label>`).join('')}</span>` : ''}
      <span>Machine</span><span>free RAM <b class="${low ? 'rnwarn' : 'rnok'}">${esc(m.free_ram_mb ?? '?')} MB</b> (the floor ${esc(c.min_free_mb)} MB${low ? `: it waits ${esc(c.ram_wait_s)} s and checks again` : ''})${m.lock ? ` · <b class="rnerr">${esc(m.lock.id)} is running (${esc(m.lock.project)}): one at a time</b>` : ''}</span>
      <span>Output</span><span class="dim">exports/package/&lt;id&gt;/ in this project, registered with ${esc(RN.currentRevision(store.revisions))} and its frame-match report</span></div>
    <div class="wbdlgf"><span class="pkres dim">only you start an export: an agent proposes one</span><span class="sp"></span><button data-x="no">Cancel</button><button data-x="go" class="pri"${comp.dir && !m.lock ? '' : ' disabled'}>Export</button></div>`;
  body.addEventListener('click', async (e) => {
    const x = e.target.closest('[data-x]')?.dataset.x; if (!x) return;
    if (x === 'no') return dlg.close();
    const id = body.querySelector('input[name=pkp]:checked')?.value || undefined, against = body.querySelector('[data-f=against]')?.value || undefined;
    try { const j = await store.op('package_start', { ...(id ? { id } : {}), ...(against ? { against } : {}) }); toast(`exporting the HTML package ${j.started}`); follow(j.started); }
    catch (er) { const r = body.querySelector('.pkres'); r.className = 'pkres rnerr'; r.textContent = er.message; }
  });
  return dlg;
}
// the export running: its phase and log tail every second; then the report
function follow(id) {
  clearInterval(poll);
  const tick = async () => {
    if (!dlg?.el.isConnected) { clearInterval(poll); poll = 0; return; }
    const s = await store.op('renders_get', { id, log_lines: 14 }).catch(() => null), x = s?.exports?.[0];
    if (!x) return;
    const body = dlg.el.querySelector('.pkbody'); if (!body) return;
    if (x.status === 'running') {
      const ph = x.run?.phase || 'waiting_ram';
      body.innerHTML = `<div class="pkph">⟳ <b>${esc(RN.PHASES[ph] || ph)}</b> · ${esc(id)}${x.run?.against ? ` · against ${esc(x.run.against)}` : ''}${ph === 'waiting_ram' && x.run?.waiting_ram ? ` · free RAM ${esc(x.run.waiting_ram.free_mb)} MB, check ${esc(x.run.waiting_ram.check)}/${esc(x.run.waiting_ram.of)}` : ''}</div>
        <div class="pklog">${esc((x.log_tail || []).join('\n') || '…')}</div><div class="wbdlgf"><span class="dim">you may close this: the export goes on (Review › Queue shows it)</span><span class="sp"></span><button data-pk="cancel" data-id="${esc(id)}">Cancel export</button></div>`;
      return;
    }
    clearInterval(poll); poll = 0;
    await store.reload(['renders.json', 'requests.json']);
    const pk = (s.packages || []).find(k => k.id === id);
    body.innerHTML = x.status === 'done' && pk ? `${reportHtml(pk)}${folderHtml(pk)}`
      : `<div class="pkph rnerr">✕ ${esc(x.status)}: ${esc(x.why || x.run?.why || '')}</div><div class="pklog">${esc((x.log_tail || []).join('\n'))}</div>`;
  };
  tick(); poll = setInterval(tick, 1000);
}
async function start(id) { return open({ id }); }
async function cancel(id) { try { await store.op('package_cancel', { id }); toast(`export ${id}: cancelling`); } catch (e) { toast('not cancelled: ' + e.message); } }
async function showLog(id) {
  const s = await store.op('renders_get', { id, log_lines: 400 }).catch(() => null), x = s?.exports?.[0];
  openDialog({ id: 'pklog', title: `Export log · ${id}`, wide: true, html: `<div class="dim">${esc(x?.log_file || '')}</div><div class="rnlogv">${esc((x?.log_tail || []).join('\n') || '(empty)')}</div>` });
}

// ------------------------------------------------------------------ the Queue's rows and Final's lines
export function packageActions(r) {
  if (r.status === 'running') return `<span class="rnph">⟳ ${esc(RN.PHASES[r.package_run?.phase] || 'exporting')}</span><button data-pk="follow" data-id="${esc(r.id)}">Progress</button><button data-pk="cancel" data-id="${esc(r.id)}">Cancel</button>`;
  if (r.status === 'done') { const pk = doc().packages.find(x => x.id === r.id), rp = pk?.report; return `<span class="rnph done">✓ exported${rp ? ` · ${rp.pass}/${rp.frames} frames (${esc(RN.pctOf(rp))})` : ' · not checked'}</span><button data-pk="report" data-id="${esc(r.id)}">Report</button><button data-pk="log" data-id="${esc(r.id)}">Log</button>`; }
  if (['draft', 'approved', 'failed'].includes(r.status)) return `${r.status === 'failed' ? `<span class="rnph failed" title="${esc(r.why || '')}">✕ ${esc(String(r.why || 'failed').slice(0, 90))}</span>` : ''}<button data-pk="start" data-id="${esc(r.id)}" class="pri" title="asks before it starts: the composition, the render it is checked against, one heavy job at a time">Export…</button>${r.status === 'failed' ? `<button data-pk="log" data-id="${esc(r.id)}">Log</button>` : ''}`;
  return '';
}
export function packagesHtml() {
  css();
  const list = doc().packages.slice().reverse().slice(0, 4), open = jobs().filter(r => ['draft', 'running', 'failed'].includes(r.status));
  if (!list.length && !open.length) return '';
  return `<div class="rnh" style="margin-top:3px"><b>HTML packages</b><span class="dim">File › Export › Interactive HTML package… · checked frame by frame against a render</span></div>`
    + open.map(r => `<div class="pkline" data-sel="request:${esc(r.id)}"><span><b>package</b><div class="dim">${esc(r.id)}${r.package?.why ? ' · ' + esc(r.package.why) : ''}</div></span><span class="chip">${esc(r.status)}</span><span class="dim">${esc(r.by === 'director' ? 'yours' : 'proposed by the agent')}</span><span>${packageActions(r)}</span></div>`).join('')
    + list.map(pk => `<div class="pkline"><span><b>${esc(pk.id)}</b><div class="dim">${esc(pk.revision || 'R0')} · ${esc(when(pk.at))}</div></span><span>${pk.report ? `<span class="pkchip ${esc(pk.report.verdict)}">${esc(RN.pctOf(pk.report))}</span>` : '<span class="pkchip">not checked</span>'}</span><span class="dim">${pk.report ? `${pk.report.pass}/${pk.report.frames} frames vs ${esc(pk.against?.render || '')}` : ''} · ${esc(pk.dir)}</span><span><button data-pk="report" data-id="${esc(pk.id)}">Report</button></span></div>`).join('');
}

document.addEventListener('click', (e) => {
  const rc = e.target.closest('[data-runcmd]'); if (rc) { e.preventDefault(); return commands.run(rc.dataset.runcmd); }   // Final's "next:" after the lock
  const b = e.target.closest('[data-pk]'); if (!b) return;
  const act = b.dataset.pk, id = b.dataset.id;
  e.preventDefault();
  if (act === 'start') return start(id);
  if (act === 'cancel') return cancel(id);
  if (act === 'log') return showLog(id);
  if (act === 'report') return report(id);
  if (act === 'follow') { open().then(() => follow(id)); return; }
  if (act === 'settings') { dlg?.close(); return window.WB?.renders?.openSettings(); }
  if (act === 'reveal') { const pk = doc().packages.find(x => x.id === id); if (pk) projects.reveal(`${pk.dir}/index.html`); }
});

commands.register([
  { id: 'file.exportPackage', group: 'File', title: 'Interactive HTML package… (the composition 1:1 + its frame match against the render)', run: () => open() },
]);
window.WB = Object.assign(window.WB || {}, { package: { open, report, start, cancel, refresh, reportHtml } });
