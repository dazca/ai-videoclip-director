// File › Export project as zip… / Import project from zip… (ROADMAP_v4 G5; lib/ops/projectio.mjs). Nothing leaves this machine:
// the zip is written into the project (exports/, a personal backup into private/exports/) and downloaded from this server.
//   Export: what the zip holds now (project_export dry_run: files, size, private files left out, unregistered, external), "include
//           snapshots", and "include private media (personal backup)": off by default, ticked only here (an agent's export never
//           holds private media) and shown with a warning; Export writes it and the browser downloads it.
//   Import: drop a .zip on the dialog (or anywhere on the page) or choose it: uploaded in chunks (project_upload kind zip, page only),
//           checked (project_import dry_run: the manifest, checksums, paths, sizes, ids), then imported as a NEW project (id
//           editable): approvals arrive as review, requests as draft, costs as history. "Open" opens it.
// uploadStaged(file, kind, onProgress) is shared with the new-project wizard (G6: a dropped song).
// API: openExport(), openImport({file?}); WB.projectZip = {openExport, openImport, uploadStaged}.
import { commands } from './commands.js';
import { menus } from './menus.js';
import { openDialog, esc } from './dialog.js';
import { toast, postJSON, PROJECT } from '../js/store.js';
import { projects } from './projects.js';

const CHUNK = 4 * 1024 * 1024;
const CSS = `.pzb{display:grid;grid-template-columns:110px 1fr;gap:6px 10px;align-items:start;font-size:12px}
.pzb .dim{color:var(--dim)} .pzb b.n{color:var(--acc)} .pzb label{display:flex;gap:6px;align-items:flex-start;cursor:pointer}
.pzb label input{margin-top:2px} .pzwarn{grid-column:1/-1;border:1px solid #8a5a14;background:#2a2112;color:#f0c27a;padding:6px 8px;font-size:11px;line-height:15px}
.pzres{grid-column:1/-1;font-size:11px;word-break:break-all;min-height:14px} .pzres.err{color:#f08080} .pzres.ok{color:#a9c9b3}
.pzf{display:flex;gap:6px;align-items:center;justify-content:flex-end;margin-top:10px;padding-top:6px;border-top:1px solid var(--line2)}
.pzdrop{grid-column:1/-1;border:1px dashed var(--line);padding:18px 8px;text-align:center;cursor:pointer;color:var(--fg)} .pzdrop.over{border-color:var(--acc);background:#2a2516} .pzdrop u{color:var(--acc)}
.pzbar{grid-column:1/-1;height:4px;background:var(--line)} .pzbar i{display:block;height:100%;width:0;background:var(--acc);transition:width .15s}
.pzb input[name=id]{width:220px;font:12px Consolas,monospace} .pzlist{grid-column:1/-1;margin:0;padding-left:16px;font-size:11px;color:var(--dim)}`;
const css = () => { if (!document.getElementById('pzcss')) { const s = document.createElement('style'); s.id = 'pzcss'; s.textContent = CSS; document.head.appendChild(s); } };
const mb = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' kB');
const b64 = (blob) => new Promise((ok, bad) => { const fr = new FileReader(); fr.onload = () => ok(String(fr.result).replace(/^data:[^,]*,/, '')); fr.onerror = () => bad(fr.error); fr.readAsDataURL(blob); });
const uid = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(36).padStart(2, '0')).join('').slice(0, 20);
async function op(name, body) { const r = await postJSON('/api/op/' + name, body), j = await r.json().catch(() => ({})); if (!r.ok) { const e = new Error(j.error || `HTTP ${r.status}`); e.code = r.status; throw e; } return j; }

// one file into <data>/.uploads/ in 4 MB chunks -> the upload id (kind: zip | song)
export async function uploadStaged(file, kind, onProgress) {
  const id = uid(); let off = 0;
  do {
    const end = Math.min(file.size, off + CHUNK);
    await op('project_upload', { upload: id, kind, name: file.name, size: file.size, offset: off, data: await b64(file.slice(off, end)), done: end >= file.size });
    off = end; onProgress?.(off / file.size);
  } while (off < file.size);
  return id;
}

// ------------------------------------------------------------------ export
export function openExport() {
  css();
  const d = openDialog({ id: 'projectExport', title: `Export project as zip · ${PROJECT}`, wide: true, html: `<div class="pzb">
    <span>Holds</span><span class="pzsum dim">…</span>
    <span>Options</span><span><label><input type="checkbox" name="snapshots"><span>include snapshots <span class="dim">(.snapshots/: the saved states)</span></span></label>
      <label><input type="checkbox" name="private"><span>include private media (personal backup) <span class="dim">(real photos and what was made from them; off by default)</span></span></label></span>
    <div class="pzwarn" hidden></div>
    <div class="pzres"></div></div>
    <div class="pzf"><span class="dim" style="margin-right:auto">written into the project, then downloaded · nothing is uploaded anywhere</span><button data-x="export" class="pri">Export zip</button></div>` });
  const $ = (s) => d.el.querySelector(s), opts = () => ({ snapshots: $('[name=snapshots]').checked, include_private: $('[name=private]').checked });
  const res = (html, cls = '') => { const r = $('.pzres'); r.innerHTML = html; r.className = 'pzres ' + cls; };
  let priv = null;   // the private files a default export leaves out (the warning names them)
  const plan = async () => {
    const o = opts();
    try {
      if (o.include_private && !priv) priv = await op('project_export', { snapshots: o.snapshots, dry_run: true });
      const r = await op('project_export', { ...o, dry_run: true });
      if (!o.include_private) priv = r;
      $('.pzsum').innerHTML = `<b class="n">${r.files}</b> files · ${mb(r.bytes)}${o.include_private ? '' : ` · <b class="n">${r.private_excluded}</b> private file${r.private_excluded === 1 ? '' : 's'} left out${r.private_excluded ? ` (${mb(r.private_bytes)})` : ''}`}`
        + `${r.unregistered_skipped ? ` · ${r.unregistered_skipped} unregistered file${r.unregistered_skipped === 1 ? '' : 's'} skipped` : ''}${r.external ? ` · ${r.external} file${r.external === 1 ? '' : 's'} under a media root not copied` : ''}`;
      const w = $('.pzwarn');
      w.hidden = !o.include_private;
      w.innerHTML = o.include_private ? `⚠ <b>Personal backup.</b> This zip will hold the ${priv?.private_excluded ?? ''} private file${priv?.private_excluded === 1 ? '' : 's'} too (${mb(priv?.private_bytes || 0)}): photos of real people and the images made from them. Keep it to yourself: do not share it, post it or send it to anyone, and do not give it to an agent. It is written to <code>private/exports/</code> (served to this machine only).` : '';
      $('[data-x=export]').textContent = o.include_private ? 'Export personal backup' : 'Export zip';
    } catch (e) { $('.pzsum').textContent = e.message; }
  };
  d.el.addEventListener('change', (e) => { if (e.target.name === 'snapshots' || e.target.name === 'private') plan(); });
  d.el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-x=export]')) {
      const b = e.target.closest('button'); b.disabled = true; res('writing the zip…');
      try {
        const r = await op('project_export', opts());
        res(`written: <b>${esc(r.path)}</b> · ${r.files} files · ${mb(r.zip_bytes)} <a href="${esc(r.url)}" download data-dl="1">download again</a>`, 'ok');
        const a = document.createElement('a'); a.href = r.url; a.download = r.path.split('/').pop(); document.body.appendChild(a); a.click(); a.remove();
        toast(`exported ${r.files} files to ${r.path}`);
      } catch (er) { res(esc(er.message), 'err'); }
      b.disabled = false;
    }
  });
  plan();
  return d;
}

// ------------------------------------------------------------------ import
export function openImport({ file = null } = {}) {
  css();
  const d = openDialog({ id: 'projectImport', title: 'Import project from zip', wide: true, html: `<div class="pzb">
    <div class="pzdrop" data-x="pick">Drop a project <b>.zip</b> here, or <u>choose it</u> <span class="dim">· it becomes a NEW project · nothing leaves this machine</span><input type="file" accept=".zip,application/zip" hidden></div>
    <div class="pzbar" hidden><i></i></div>
    <span>Zip</span><span class="pzsum dim">none yet</span>
    <span>New project id</span><span><input name="id" spellcheck="false" autocomplete="off" disabled> <span class="dim">(never over an existing project)</span></span>
    <ul class="pzlist"><li>approvals arrive as <b>review</b> (never approved), requests as <b>draft</b>, costs as history</li><li>checked first: paths, sizes, the manifest's checksums, ids</li></ul>
    <div class="pzres"></div></div>
    <div class="pzf"><button data-x="open" hidden>Open project</button><button data-x="import" class="pri" disabled>Import</button></div>` });
  const $ = (s) => d.el.querySelector(s), input = $('input[type=file]'), st = { upload: null, id: null };
  const res = (html, cls = '') => { const r = $('.pzres'); r.innerHTML = html; r.className = 'pzres ' + cls; };
  const take = async (f) => {
    if (!f) return;
    st.upload = null; $('[data-x=import]').disabled = true; $('[data-x=open]').hidden = true; $('[name=id]').disabled = true;
    if (!/\.zip$/i.test(f.name)) return res(`${esc(f.name)}: not a .zip`, 'err');
    const bar = $('.pzbar'), fill = bar.firstElementChild; bar.hidden = false; fill.style.width = '0';
    $('.pzsum').textContent = `${f.name} · ${mb(f.size)} · uploading…`; res('');
    try {
      st.upload = await uploadStaged(f, 'zip', (x) => { fill.style.width = Math.round(x * 100) + '%'; $('.pzsum').textContent = `${f.name} · ${mb(f.size)} · uploading ${Math.round(x * 100)}%`; });
      $('.pzsum').textContent = `${f.name} · checking…`;
      const r = await op('project_import', { upload: st.upload, dry_run: true });
      $('.pzsum').innerHTML = `<b class="n">${esc(r.title)}</b> (from <b>${esc(r.from)}</b>, exported ${esc(String(r.exported || '').replace('T', ' '))}${r.version ? ', v' + esc(r.version) : ''}) · ${r.files} files · ${mb(r.bytes)}${r.snapshots ? ' · with snapshots' : ''}`
        + (r.include_private ? ` · <span style="color:#f0c27a">a personal backup: ${r.private_files} private file${r.private_files === 1 ? '' : 's'} (they stay private here)</span>` : '');
      const i = $('[name=id]'); i.value = r.id; i.disabled = false; $('[data-x=import]').disabled = false;
      res('checked: paths, sizes, checksums and ids are fine', 'ok');
    } catch (e) { st.upload = null; bar.hidden = true; $('.pzsum').textContent = f.name; res(esc(e.message), 'err'); }
  };
  input.addEventListener('change', () => { take(input.files[0]); input.value = ''; });
  const drop = $('.pzdrop');
  d.el.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); e.stopPropagation(); drop.classList.add('over'); } });
  d.el.addEventListener('dragleave', () => drop.classList.remove('over'));
  d.el.addEventListener('drop', (e) => { if (!e.dataTransfer?.files?.length) return; e.preventDefault(); e.stopPropagation(); drop.classList.remove('over'); take(e.dataTransfer.files[0]); });
  d.el.addEventListener('click', async (e) => {
    const x = e.target.closest('[data-x]')?.dataset.x;
    if (x === 'pick') return input.click();
    if (x === 'open' && st.id) return projects.open(st.id);
    if (x === 'import' && st.upload) {
      const b = e.target.closest('button'); b.disabled = true; res('importing…');
      try {
        const r = await op('project_import', { upload: st.upload, id: $('[name=id]').value.trim() || undefined });
        st.id = r.id; st.upload = null;
        const dm = Object.entries(r.demoted || {}).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', ');
        res(`imported as <b>${esc(r.id)}</b> · ${r.files} files${dm ? ` · demoted: ${esc(dm)}` : ''}`, 'ok');
        $('[data-x=open]').hidden = false; $('[data-x=open]').classList.add('pri'); b.hidden = true;
        await projects.refresh();
        toast(`imported ${r.from} as ${r.id}`);
      } catch (er) { res(esc(er.message), 'err'); b.disabled = false; }
    }
  });
  if (file) take(file);
  return d;
}

commands.register({ id: 'file.exportZip', group: 'File', title: 'Export project as zip…', run: () => openExport() });
commands.register({ id: 'file.importZip', group: 'File', title: 'Import project from zip…', run: () => openImport() });
menus.contribute('menubar:File', ['-', 'file.exportZip', 'file.importZip']);
// a .zip dropped anywhere on the page opens the import (before File › Import media… takes the drop)
addEventListener('drop', (e) => {
  const fs = [...(e.dataTransfer?.files || [])];
  if (e.target?.closest?.('[data-dlg=projectImport]')) return;   // the dialog's own drop zone takes it
  if (fs.length === 1 && /\.zip$/i.test(fs[0].name) && !e.defaultPrevented) { e.preventDefault(); e.stopPropagation(); openImport({ file: fs[0] }); }
}, true);
window.WB = Object.assign(window.WB || {}, { projectZip: { openExport, openImport, uploadStaged } });
