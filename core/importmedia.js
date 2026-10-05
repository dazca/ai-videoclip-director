// File › Import media… (ROADMAP_v4 D8): bring existing images and video into the project, then "use" them.
//   - drop files anywhere on the page (or "choose files"): uploaded into the project in 4 MB chunks (POST
//     /api/op/media_upload, page only; up to 200 MB a file, sniffed by its bytes on the server)
//   - or type a path / folder under a configured media root: read in place (media_scan, then media_import); a generation
//     output tree (falgen out/<id>/job.json, the runner's gen/<request>/job.json) shows each job's prompt, model, refs,
//     takes and cost, offers to record a cost the project does not count yet (cost_record; the same job once; a job the
//     linked falgen ledger counts is not offered) and to link the files to a request
//   - every row: kind, label, private (forced on for a PRIVATE path or a file flagged private: never less private)
//   - "Use as…" (the dialog's rows after import, and the 'media' context menu anywhere): an identity / look node of a
//     character, a base / variant node of a location or prop (asset_act import: no request, nothing paid), a shot's take
//     or start frame. All page only (POST /api/op/media_use): an agent proposes these instead.
// API: openImport({files?, path?}), useAsItems(media) -> menu items; WB.importMedia = {open, useAsItems}.
import { commands } from './commands.js';
import { menus } from './menus.js';
import { ui } from './palette.js';
import { confirmDialog } from './dialog.js';
import { store, toast, esc, postJSON, mediaUrl, config } from '../js/store.js';
import * as A from '../js/assets.js';
import { boardShots } from '../js/storyboard.js';

const MAX = 200 * 1024 * 1024, CHUNK = 4 * 1024 * 1024;
const KINDS = ['still', 'clip', 'sheet', 'ref', 'render', 'variation', 'contact', 'motion-ref', 'avatar'];
const IMG = /\.(png|jpe?g|webp|gif)$/i, VID = /\.(mp4|webm|mov|mkv)$/i;
const mb = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' kB');
const usd = (x) => (x == null ? '?' : '$' + Number(x).toFixed(2));
async function op(name, body) {
  const r = await postJSON('/api/op/' + name, body), j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || `HTTP ${r.status}`); e.code = r.status; throw e; }
  return j;
}
const b64 = (blob) => new Promise((ok, bad) => { const fr = new FileReader(); fr.onload = () => ok(String(fr.result).replace(/^data:[^,]*,/, '')); fr.onerror = () => bad(fr.error); fr.readAsDataURL(blob); });
const uid = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(36).padStart(2, '0')).join('').slice(0, 20);
// the first bytes say what a dropped file is (the server checks again): image / video / null
async function sniffBlob(f) {
  const b = new Uint8Array(await f.slice(0, 16).arrayBuffer()), s = (a, z) => String.fromCharCode(...b.slice(a, z));
  if (b[0] === 0x89 && s(1, 4) === 'PNG') return 'image';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image';
  if (s(0, 4) === 'RIFF' && s(8, 12) === 'WEBP') return 'image';
  if (/^GIF8[79]a$/.test(s(0, 6))) return 'image';
  if (s(4, 8) === 'ftyp' && !/^M4[AB] /.test(s(8, 12))) return 'video';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video';
  return null;
}

// ------------------------------------------------------------------ "use as…": the director's, page only (media_use)
async function useAs(m, body, what) {
  try {
    const r = await op('media_use', { media: m.id, ...body });
    toast(r.node ? `${m.id} is now node ${r.node} of ${r.id} ${r.tree} (imported: no request, nothing paid)` : `${m.id} is the ${body.as === 'take' ? 'take' : 'start frame'} of ${body.shot}${r.storyboard_version ? ` (storyboard ${r.storyboard_version})` : ''}`);
    document.dispatchEvent(new CustomEvent('wb:media-used', { detail: { media: m.id, ...body, result: r } }));
    return r;
  } catch (e) { toast(`${what}: ${e.message}`); return null; }
}
const pickShot = async (title) => {
  const shots = boardShots(store.board); if (!shots.length) { toast('no shots in the storyboard yet'); return null; }
  return ui.pick({ title, items: shots.map(s => ({ label: `${s.id} · ${s.title || s.kind}`, detail: `${(s.t0 / 1000).toFixed(1)}–${(s.t1 / 1000).toFixed(1)} s`, value: s.id })) });
};
export function useAsItems(m) {
  if (!m) return [];
  const img = IMG.test(m.path), vid = VID.test(m.path), ents = store.entities || [];
  const chars = ents.filter(e => e.kind === 'character'), places = ents.filter(e => e.kind === 'location' || e.kind === 'prop');
  const none = (t) => [{ label: t, disabled: true }];
  const items = [];
  if (img) {
    items.push({ label: 'Identity of', submenu: () => chars.length ? chars.map(e => ({ label: e.name || e.id, run: () => useAs(m, { as: 'identity', id: e.id }, 'use as identity') })) : none('(no characters yet)') });
    items.push({ label: 'Look of', submenu: () => { const xs = chars.flatMap(e => A.variants(e, 'character').map(l => ({ label: `${e.name || e.id} · ${l.name || l.id}`, run: () => useAs(m, { as: 'look', id: e.id, tree: `look:${l.id}` }, 'use as look') }))); return xs.length ? xs : none('(no looks yet)'); } });
    items.push({ label: 'Base of', submenu: () => places.length ? places.map(e => ({ label: `${e.name || e.id}`, detail: e.kind, run: () => useAs(m, { as: 'base', id: e.id, type: e.kind }, 'use as base') })) : none('(no locations or props yet)') });
    items.push({ label: 'Variant of', submenu: () => { const xs = places.flatMap(e => A.variants(e, e.kind).map(v => ({ label: `${e.name || e.id} · ${v.name || v.id}`, run: () => useAs(m, { as: 'variant', id: e.id, type: e.kind, tree: `variant:${v.id}` }, 'use as variant') }))); return xs.length ? xs : none('(no variants yet)'); } });
    items.push('-');
    items.push({ label: 'Start frame of shot…', run: async () => { const s = await pickShot(`Start frame: ${m.id} becomes the still a shot starts from`); if (s) useAs(m, { as: 'start_frame', shot: s }, 'start frame'); } });
  }
  if (img || vid) items.push({ label: 'Take of shot…', run: async () => { const s = await pickShot(`Take: ${m.id} becomes a take of a shot`); if (s) useAs(m, { as: 'take', shot: s }, 'take'); } });
  return items.length ? items : none('(not an image or a video)');
}
menus.contribute('media', [{ label: 'Use as…', when: (c) => !!c.media && (IMG.test(c.media.path) || VID.test(c.media.path)), submenu: (c) => useAsItems(c.media) },
  { label: 'Make public…', when: (c) => canPublish(c.media), run: (c) => makePublic([c.media.id]) }]);

// review #3 walk blocker 2: "Make public…" (media_publish, page only): the director's own private upload becomes a public file
// (it moves out of private/, its picks and refs follow) after a confirm that says what that means. An agent cannot.
export const canPublish = (m) => !!m && m.private === true && m.imported?.from === 'upload' && /^private\/[a-z0-9_-]+\/[^/]+$/.test(m.path || '');
export async function makePublic(ids) {
  const ms = ids.map(id => (store.media || []).find(m => m.id === id)).filter(canPublish);
  if (!ms.length) { toast('only your own private uploads can be made public'); return []; }
  const what = ms.length === 1 ? (ms[0].label || ms[0].id) : `${ms.length} uploads`;
  const ok = await confirmDialog({ id: 'publish', title: `Make ${what} public?`, ok: 'Make public', cancel: 'Keep it private',
    html: `<p class="wbwarn"><b>${esc(ms.map(m => m.path).join(', '))}</b> moves out of <code>private/</code> into <code>media/</code>. A public file:</p>`
      + '<ul><li>can be exported (edl.json, the HTML package) and packaged for the render;</li><li>is served to other machines on your network (with <code>--lan</code>);</li><li>can be uploaded to fal (a public URL) when a run uses it as a reference.</li></ul>'
      + '<p class="wbwarn">Only do this for an image you are fine sharing: never a private photo of a person. To make it private again, flag it private (Assets › Media).</p>' });
  if (!ok) return [];
  const done = [];
  for (const m of ms) { try { const r = await store.op('media_publish', { media: m.id, confirm: true }); done.push(r); } catch (e) { toast(`${m.id}: ${e.message}`); } }
  if (done.length) toast(`${done.length} file${done.length === 1 ? '' : 's'} made public: ${done.map(r => r.to).join(', ')}${done.some(r => r.updated?.storyboard) ? ' · the storyboard follows (a new version)' : ''}`);
  return done;
}

// ------------------------------------------------------------------ the dialog
let dlg = null;
export function openImport({ files = null, path = '' } = {}) {
  if (!dlg) dlg = new ImportDialog();
  dlg.show();
  if (files?.length) dlg.addFiles(files);
  if (path) dlg.scan(path);
  return dlg;
}
class ImportDialog {
  constructor() {
    this.rows = []; this.jobs = []; this.busy = false;
    const el = this.el = document.createElement('div'); el.className = 'imback';
    el.innerHTML = `<div class="imdlg" role="dialog" aria-label="Import media">
      <div class="imh"><b>Import media</b><span class="dim">images and video · nothing is generated or paid</span><span class="sp"></span><i data-x="close" title="Esc">×</i></div>
      <div class="imsrc"><div class="imdrop" data-x="pick">Drop files here, or <u>choose files</u> <span class="dim">· uploaded into the project · up to 200 MB a file</span><input type="file" multiple accept="image/*,video/*" hidden></div>
        <form class="impath"><input name="path" placeholder="or a path or folder under a media root (read in place)" spellcheck="false"><button>Read</button></form>
        <div class="imroots dim"></div></div>
      <div class="imjobs"></div>
      <div class="imlist"></div>
      <div class="imf"><span class="imsum dim"></span><span class="sp"></span><label class="imreq">link to request <select name="request"></select></label><button data-x="import" class="pri">Import</button></div>
    </div>`;
    const input = el.querySelector('input[type=file]');
    el.addEventListener('click', (e) => {
      const x = e.target.closest('[data-x]')?.dataset.x;
      if (e.target === el || x === 'close') return this.hide();
      if (x === 'pick') return input.click();
      if (x === 'import') return this.run();
      if (x === 'useas') { const m = store.mediaById[e.target.closest('[data-x]').dataset.m]; if (m) { const r = e.target.getBoundingClientRect(); menus.open(useAsItems(m), { x: r.left, y: r.bottom }); } return; }
      if (x === 'prompt') return e.target.closest('.imjob').classList.toggle('open');
    });
    input.addEventListener('change', () => { this.addFiles([...input.files]); input.value = ''; });
    el.querySelector('.impath').addEventListener('submit', (e) => { e.preventDefault(); this.scan(e.target.path.value); });
    el.addEventListener('change', (e) => {
      const r = e.target.closest('[data-row]'); if (!r) return;
      const row = this.rows[Number(r.dataset.row)], f = e.target.dataset.f; if (!row || !f) return;
      row[f] = e.target.type === 'checkbox' ? e.target.checked : e.target.value; this.summary();
    });
    el.addEventListener('input', (e) => { const r = e.target.closest('[data-row]'); if (r && e.target.dataset.f === 'label') this.rows[Number(r.dataset.row)].label = e.target.value; });
    el.addEventListener('change', (e) => { const j = e.target.closest('[data-job]'); if (j && e.target.name === 'record') { const job = this.jobs.find(x => x.id === j.dataset.job); if (job) job.record = e.target.checked; } });
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); this.hide(); } });
    el.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); el.querySelector('.imdrop').classList.add('over'); } });
    el.addEventListener('dragleave', () => el.querySelector('.imdrop').classList.remove('over'));
    el.addEventListener('drop', (e) => { if (!e.dataTransfer?.files?.length) return; e.preventDefault(); e.stopPropagation(); el.querySelector('.imdrop').classList.remove('over'); this.addFiles([...e.dataTransfer.files]); });
  }
  show() {
    if (!this.el.isConnected) document.body.appendChild(this.el);
    { const b = this.el.firstElementChild; b.tabIndex = -1; b.focus({ preventScroll: true }); }   // Esc reaches the dialog (review #3 UX 3)
    this.el.querySelector('.imroots').textContent = (config.media_roots?.length ? `media roots: ${config.media_roots.join(' · ')}` : 'no media roots configured (workbench.config.json media_roots): drop files instead')
      + (config.media_roots_ignored?.length ? ` · ignored: ${config.media_roots_ignored.join(', ')} (named like a project folder: rename it, e.g. my-media/)` : '');
    this.render(); this.el.querySelector('[name=path]').focus();
  }
  hide() { for (const r of this.rows) if (r.url) URL.revokeObjectURL(r.url); this.rows = []; this.jobs = []; this.el.remove(); }
  async addFiles(files) {
    for (const f of files) {
      const row = { src: 'upload', file: f, name: f.name, size: f.size, kind: '', label: f.name.replace(/\.[^.]*$/, ''), private: true, forced: false, include: true };   // review #2 N7: a dropped file is often a real photo: private (local only) until the director unticks it
      if (f.size > MAX) Object.assign(row, { include: false, bad: `${mb(f.size)}: over the 200 MB a file` });
      else { const t = await sniffBlob(f); if (!t) Object.assign(row, { include: false, bad: 'not an image or a video (by its bytes)' }); else Object.assign(row, { type: t, kind: t === 'video' ? 'clip' : 'still', url: URL.createObjectURL(f) }); }
      this.rows.push(row);
    }
    this.render();
  }
  async scan(p) {
    p = String(p || '').trim(); if (!p) return;
    this.el.querySelector('[name=path]').value = p;
    this.setSum('reading…');
    try {
      const r = await op('media_scan', { path: p });
      for (const f of r.files) {
        if (this.rows.some(x => x.src === 'path' && x.path === f.path)) continue;
        this.rows.push({ src: 'path', path: f.path, name: f.name, size: f.size, type: f.type, kind: f.kind, label: f.label, private: f.private || f.registered_private, forced: f.private || f.registered_private, include: !f.registered, registered: f.registered, job: f.job, take: f.take });
      }
      for (const j of r.jobs) if (!this.jobs.some(x => x.id === j.id)) this.jobs.push({ ...j, record: j.cost?.status === 'not_counted' && j.cost?.usd != null && j.cost.source !== 'estimate' });   // an estimate is offered, not ticked
      this.scanned = r;
      this.render();
      if (r.skipped_count) toast(`${r.skipped_count} file(s) skipped: ${r.skipped.slice(0, 3).map(s => `${s.path.split('/').pop()} (${s.why})`).join(', ')}`);
    } catch (e) { this.setSum(''); toast(`not read: ${e.message}`); }
  }
  setSum(t) { this.el.querySelector('.imsum').textContent = t; }
  summary() {
    const inc = this.rows.filter(r => r.include && !r.done), up = inc.filter(r => r.src === 'upload');
    const rec = this.jobs.filter(j => j.record && j.cost?.offer);
    this.setSum(this.rows.length ? `${inc.length} to import${up.length ? ` (${up.length} upload${up.length > 1 ? 's' : ''}, ${mb(up.reduce((s, r) => s + r.size, 0))})` : ''} · ${this.rows.filter(r => r.private && r.include).length} private${rec.length ? ` · record ${usd(rec.reduce((s, j) => s + j.cost.usd, 0))} for ${rec.length} job${rec.length > 1 ? 's' : ''}` : ''}` : 'nothing yet: drop files or read a path');
    const b = this.el.querySelector('[data-x=import]'); b.disabled = this.busy || (!inc.length && !rec.length); b.textContent = this.busy ? 'Importing…' : `Import ${inc.length || ''}`.trim();
  }
  render() {
    const sel = this.el.querySelector('[name=request]'), cur = sel.value;
    sel.innerHTML = '<option value="">(none)</option>' + (store.requests?.items || []).slice(-60).reverse().map(r => `<option value="${esc(r.id)}">${esc(r.id)} · ${esc(r.kind || '')} · ${esc(r.status)}</option>`).join('');
    sel.value = cur;
    this.el.querySelector('.imjobs').innerHTML = this.jobs.length ? `<div class="imjh">generation jobs found <span class="dim">(job.json: prompt, model, refs and cost recovered)</span></div>` + this.jobs.map(j => {
      const c = j.cost || {}, priv = (j.refs || []).filter(r => r.private).length;
      const st = c.status === 'recorded' ? `<span class="ok">recorded</span> in costs.json` : c.status === 'counted' ? `<span class="ok">counted</span> from the linked falgen ledger` : c.status === 'not_counted' ? `<span class="warn">not counted yet</span> · ${esc(c.source)}` : 'no cost found';
      return `<div class="imjob" data-job="${esc(j.id)}"><div class="imjl"><b>${esc(j.id)}</b> <span>${esc(j.model || '')} · ${esc(j.endpoint || j.runner)}</span> <span class="dim">${j.files.length} file${j.files.length === 1 ? '' : 's'}${j.resolution ? ' · ' + esc(j.resolution) : ''}${j.duration ? ' · ' + esc(j.duration) + ' s' : ''} · refs ${j.refs.length}${priv ? ` (${priv} 🔒)` : ''}</span><span class="sp"></span>
        <span class="imcost" title="${esc(c.why || '')}">${usd(c.usd)} · ${st}</span>${c.status === 'not_counted' && c.offer ? `<label class="imrec" title="cost_record ${esc(JSON.stringify(c.offer))}"><input type="checkbox" name="record" ${j.record ? 'checked' : ''}> record</label>` : ''}</div>
        <div class="imprompt" data-x="prompt" title="click: the whole prompt">${esc(j.prompt || j.notes || '(no prompt)')}</div></div>`;
    }).join('') : '';
    this.el.querySelector('.imlist').innerHTML = this.rows.length ? this.rows.map((r, i) => {
      const src = r.url || (r.path ? mediaUrl(r.path) : ''), thumb = !src ? '<span class="imno">?</span>' : r.type === 'video' ? `<video src="${esc(src)}" muted preload="metadata"></video>` : `<img src="${esc(src)}" alt="" loading="lazy">`;
      const m = r.media || (r.registered && store.mediaById[r.registered]);
      return `<div class="imrow${r.bad ? ' bad' : ''}${r.done ? ' done' : ''}" data-row="${i}"><input type="checkbox" data-f="include" ${r.include ? 'checked' : ''} ${r.bad || r.done ? 'disabled' : ''} title="import this file">
        <div class="imth">${thumb}${r.private ? '<i class="lock">🔒</i>' : ''}</div>
        <div class="imnm"><b title="${esc(r.path || r.name)}">${esc(r.name)}</b><span class="dim">${esc(r.src === 'upload' ? 'upload' : r.path.split('/').slice(0, -1).join('/'))} · ${mb(r.size)}${r.type ? ' · ' + r.type : ''}${r.job ? ` · job ${esc(r.job)}${r.take != null ? ' take ' + esc(r.take) : ''}` : ''}</span>${r.bad ? `<span class="err">${esc(r.bad)}</span>` : ''}${r.err ? `<span class="err">${esc(r.err)}</span>` : ''}${r.progress != null && !r.done ? `<span class="improg"><i style="width:${Math.round(r.progress * 100)}%"></i></span>` : ''}</div>
        <select data-f="kind" ${r.bad || r.done ? 'disabled' : ''}>${[...new Set([r.kind, ...KINDS])].filter(Boolean).map(k => `<option ${k === r.kind ? 'selected' : ''}>${esc(k)}</option>`).join('')}</select>
        <input data-f="label" value="${esc(r.label || '')}" ${r.bad || r.done ? 'disabled' : ''} placeholder="label">
        <label class="impriv" title="${r.forced ? 'private by its path or its flag: it stays private (never less private)' : 'private: local only, never exported'}"><input type="checkbox" data-f="private" ${r.private ? 'checked' : ''} ${r.forced || r.bad || r.done ? 'disabled' : ''}> private</label>
        <span class="imst">${m ? `<span class="ok" data-media="${esc(m.id)}">${r.done ? 'imported' : 'registered'} · ${esc(m.id)}</span> <button data-x="useas" data-m="${esc(m.id)}">Use as…</button>` : ''}</span></div>`;
    }).join('') : '<div class="dim imempty">Drop images or videos on this window, choose files, or read a folder (a generation output folder like out/&lt;id&gt;/ with its job.json shows the prompt, the model and the cost).</div>';
    this.summary();
  }
  async run() {
    if (this.busy) return;
    this.busy = true; this.summary();
    const request = this.el.querySelector('[name=request]').value || undefined;
    let ok = 0, failed = 0;
    try {
      // uploads: chunk by chunk (the server sniffs the first chunk and checks the size)
      for (const r of this.rows.filter(x => x.include && !x.done && x.src === 'upload')) {
        try {
          const id = uid(); let off = 0, res = null;
          do {
            const end = Math.min(r.size, off + CHUNK), data = await b64(r.file.slice(off, end));
            res = await op('media_upload', { upload: id, name: r.name, size: r.size, offset: off, data, done: end >= r.size, kind: r.kind, label: r.label, private: !!r.private, ...(request ? { request } : {}) });
            off = end; r.progress = off / r.size; this.render();
          } while (off < r.size);
          Object.assign(r, { done: true, include: false, media: res.media, err: null }); ok++;
        } catch (e) { r.err = e.message; failed++; }
        this.render();
      }
      // paths under a media root: one media_import, in place
      const rows = this.rows.filter(x => x.include && !x.done && x.src === 'path');
      if (rows.length) {
        try {
          const res = await op('media_import', { items: rows.map(r => ({ path: r.path, kind: r.kind, label: r.label, private: !!r.private })), ...(request ? { request } : {}), by: 'director' });
          const all = [...res.imported, ...res.already];
          for (const r of rows) { const m = all.find(x => x.path.toLowerCase() === r.path.toLowerCase()); if (m) { Object.assign(r, { done: true, include: false, media: m, err: null }); ok++; } }
        } catch (e) { for (const r of rows) r.err = e.message; failed += rows.length; }
      }
      // the recovered costs the project does not count yet: cost_record (the same job is recorded once)
      for (const j of this.jobs.filter(x => x.record && x.cost?.offer)) {
        try { const res = await op('cost_record', { ...j.cost.offer, by: 'director' }); j.record = false; j.cost = { ...j.cost, status: res.recorded ? 'recorded' : j.cost.status, why: res.recorded ? 'recorded now' : res.reason }; }
        catch (e) { toast(`cost of ${j.id} not recorded: ${e.message}`); }
      }
      await store.reload(['media.json']).catch(() => {});
      for (const r of this.rows) if (r.media && store.mediaById[r.media.id]) r.media = store.mediaById[r.media.id];
      toast(`imported ${ok} file${ok === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''}: use them with "Use as…"`);
    } finally { this.busy = false; this.render(); }
  }
}

// ------------------------------------------------------------------ the command, the File menu, dropping files on the page
commands.register({ id: 'file.importMedia', group: 'File', title: 'Import media…', run: (c) => openImport({ path: c?.path || '' }) });
// files dropped anywhere that nothing else took (a look form, a reference drop zone) open the dialog with them
document.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files') && !e.defaultPrevented) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
document.addEventListener('drop', (e) => { if (!e.defaultPrevented && e.dataTransfer?.files?.length) { e.preventDefault(); openImport({ files: [...e.dataTransfer.files] }); } });
window.WB = Object.assign(window.WB || {}, { importMedia: { open: openImport, useAsItems, makePublic, canPublish } });
