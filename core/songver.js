// E7 song versions and the Suno brief in the page (ROADMAP_v4). Lyrics stage › the song line: "versions…" and "Suno brief…".
//   Song versions…  the takes (v1, v2…: source, length, bpm, alignment, the style / lyrics used), "+ Add a take": an audio
//                   file dropped here (uploaded in chunks: song_upload, page only) or a path on this machine, its source
//                   (Suno / upload), the style and lyrics prompt it was made with (prefilled from the brief), and how its
//                   lyrics line up (stretched to its length, an offset + scale, or a pasted LRC); then Preview: the E1
//                   re-time preview (core/events.js planTable) of every scene / shot boundary and event that moves, and Use
//                   vN = ONE undoable change (song_version_use, page only: the audio, beat grid, lyric timings, a new scenes
//                   and storyboard version; Ctrl+Z uses the version before)
//   Suno brief…     style / exclude / title (saved in settings.json suno) + the lyrics of the current version with section
//                   tags, the character counts against Suno's limits, Copy buttons. Nothing calls Suno.
// API: WB.songs = {open, brief, plan(version)}
import { commands } from './commands.js';
import { menus } from './menus.js';
import { history } from './history.js';
import { copyText } from './dialog.js';
import { planTable, evDialog, evCss, heldHtml, ticked, allTicked } from './events.js';
import { ui } from './palette.js';
import { HELD_LABEL } from '../js/events.js';
import { store, toast, esc } from '../js/store.js';
import { fmt } from '../js/timeline.js';
import { currentScript } from '../js/scenes.js';
import { currentVersion } from '../js/flow.js';
import * as SG from '../js/songs.js';

const CSS = `.sgdlg .sgv{width:100%;border-collapse:collapse} .sgdlg .sgv td,.sgdlg .sgv th{padding:2px 5px;border-bottom:1px solid var(--line2);text-align:left;white-space:nowrap}
.sgdlg .sgv tr.cur td{color:var(--acc)} .sgdlg .sgadd{display:grid;grid-template-columns:110px 1fr;gap:4px 8px;align-items:start;border:1px dashed var(--line);padding:4px 6px;margin-top:6px}
.sgdlg textarea{width:100%;box-sizing:border-box;height:52px;font:11.5px Consolas,monospace} .sgdlg input[type=text]{width:100%;box-sizing:border-box}
.sgdlg .cnt{font-size:10.5px;color:var(--dim)} .sgdlg .cnt.over{color:#f08080} .sgdlg .sgsum{margin:4px 0} .sgdlg .sgpv{border:1px solid var(--line2);padding:3px 6px;margin-top:6px}`;
const css = () => { evCss(); if (!document.getElementById('sgcss')) { const st = document.createElement('style'); st.id = 'sgcss'; st.textContent = CSS; document.head.appendChild(st); } };
const b64 = (blob) => new Promise((ok, bad) => { const fr = new FileReader(); fr.onload = () => ok(String(fr.result).replace(/^data:[^,]*,/, '')); fr.onerror = () => bad(fr.error); fr.readAsDataURL(blob); });
// approvals and the scene states feed `held` (review #3 M2: the same rule as a re-time)
const ctx = () => ({ scenes: currentScript(store.scenes)?.scenes || [], shots: store.boardShots(), events: (store.events || []).filter(e => e.status !== 'dismissed'), approvals: store.approvals, states: store.scenes?.states || {} });
const lockedNow = () => store.revisions?.lock || null;
// the plan of using version v now: computed here exactly as the server does (js/songs.js)
export function plan(id) {
  const song = store.song, v = SG.versionsOf(song).find(x => x.id === id); if (!v) return null;
  const map = SG.mapTo(song, v), p = SG.songPlan({ map, ...ctx(), dur: v.duration_ms, version: v.id });
  return { v, plan: p, lines: SG.linesMoved(song.lines, map) };
}
// Ctrl+Z / redo moves cuts too: a held item (approved / ok / take too short) asks first (review #3 M2), never silently
async function confirming(version) {
  try { return await store.op('song_version_use', { version }); } catch (e) {
    const held = e.body?.held; if (e.status !== 409 || !Array.isArray(held) || !held.length) throw e;
    const ok = await ui.confirm(`Use song ${version}: it moves ${held.map(h => `${h.key} (${h.reasons.map(r => HELD_LABEL[r] || r).join(', ')})`).join('; ')}. An approved shot goes back to review. Go on?`);
    if (!ok) throw new Error('not done: you kept the cuts');
    return store.op('song_version_use', { version, confirm: held.map(h => h.key) });
  }
}
async function use(id, confirm = []) {
  const prev = SG.currentVersionId(store.song);
  const r = await store.op('song_version_use', { version: id, confirm });
  history.push({ label: `song ${prev} → ${id}`, undo: () => confirming(prev), redo: () => confirming(id) });
  toast(`song ${id} in use: ${r.summary} (Ctrl+Z goes back to ${prev})`);
  return r;
}
async function upload(file, onp) {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(10)), b => (b % 36).toString(36)).join(''), CH = 4 * 1024 * 1024;
  let off = 0, r = null;
  do { const part = file.slice(off, off + CH), done = off + part.size >= file.size; r = await store.op('song_upload', { upload: id, name: file.name, size: file.size, offset: off, data: await b64(part), done }); off += part.size; onp?.(off / file.size); } while (off < file.size);
  return r.path;
}

let el = null, sel = null;
// the dialog takes the focus, so Esc closes it (the shell listens on its own element)
const focusDlg = (back) => { const d = back.querySelector('.evdlg'); d.tabIndex = -1; d.focus({ preventScroll: true }); };
export function openVersions(pre = null) {
  css(); el?.remove(); sel = pre ?? sel;
  const song = store.song, vs = SG.versionsOf(song), cur = SG.currentVersionId(song);
  if (sel && (sel === cur || !vs.some(v => v.id === sel))) sel = null;
  const brief = SG.sunoBrief({ version: currentVersion(store.lyrics), style: store.settings?.suno?.style || '', exclude: store.settings?.suno?.exclude || '' });
  const pv = sel ? plan(sel) : null, lk = lockedNow();
  const rows = vs.map(v => `<tr class="${v.id === cur ? 'cur' : ''}" data-v="${esc(v.id)}"><td><b>${esc(v.id)}</b></td><td>${esc(v.label || '')}</td><td>${esc(v.source)}</td><td>${fmt(v.duration_ms)}</td><td>${esc(v.bpm || '')}</td>
    <td class="dim" title="${esc(v.alignment ? JSON.stringify(v.alignment) : '')}">${esc(v.alignment?.method || '')}${v.alignment?.matched ? ` ${v.alignment.matched}/${v.alignment.total}` : ''}</td><td class="dim">${esc(v.by || '')}</td>
    <td>${v.id === cur ? '<b>in use</b>' : `<button data-x="pv" data-v="${esc(v.id)}">${sel === v.id ? 'Previewing' : 'Preview…'}</button>`}</td></tr>`).join('');
  const body = `<table class="sgv"><tr><th>version</th><th>label</th><th>source</th><th>length</th><th>bpm</th><th>lyrics aligned by</th><th>by</th><th></th></tr>${rows}</table>`
    + (pv ? `<div class="sgpv"><h4>Preview: using ${esc(pv.v.id)} (${fmt(pv.v.duration_ms)})</h4><div class="sgsum">${esc(SG.planSummary(pv.plan, pv.lines))}</div>${pv.v.style ? `<div class="dim" title="${esc(pv.v.style)}">style: ${esc(pv.v.style.slice(0, 140))}${pv.v.style.length > 140 ? '…' : ''}</div>` : ''}`
      + planTable(pv.plan, '<div class="dim">no scene, shot or event moves</div>') + heldHtml(pv.plan)
      + (lk ? `<div class="err rtlock">The project is locked for render (${esc(lk.revision || 'locked')}): using another take would move the locked cut. Unlock it first (Final › Unlock).</div>` : '') + (pv.plan.problems.length ? `<div class="err">cannot use it: ${esc(pv.plan.problems.join('; '))}</div>` : '')
      + `<button data-x="use" class="pri"${pv.plan.problems.length || lk || pv.plan.held?.length ? ' disabled' : ''}>Use ${esc(pv.v.id)}</button> <span class="dim">one undoable change: the audio, the beat grid, the lyric timings, a new scenes and storyboard version</span></div>` : '')
    + `<div class="sgadd"><b style="grid-column:1/-1">+ Add a take</b>
      <span>File</span><span><input type="file" data-f="file" accept="audio/*,.mp3,.wav,.m4a,.flac,.ogg"> or a path <input type="text" data-f="path" placeholder="C:\\Music\\suno-take-2.mp3" spellcheck="false"></span>
      <span>Source</span><span><select data-f="source"><option value="suno">Suno</option><option value="upload">upload</option><option value="other">other</option></select> <input type="text" data-f="label" placeholder="label (Suno v17, take 2…)" style="width:60%"></span>
      <span>Style used</span><span><textarea data-f="style" spellcheck="false">${esc(brief.style)}</textarea></span>
      <span>Lyrics used</span><span><textarea data-f="lyrics" spellcheck="false">${esc(brief.lyrics)}</textarea></span>
      <span>Line up by</span><span><label><input type="radio" name="al" value="stretch" checked> stretch to its length</label> <label><input type="radio" name="al" value="offset"> offset <input type="text" data-f="offset" value="0" style="width:60px"> ms × <input type="text" data-f="scale" value="1" style="width:50px"></label> <label><input type="radio" name="al" value="lrc"> timed lyrics (LRC)</label>
        <textarea data-f="lrc" placeholder="[00:12.40] first line&#10;[00:15.10] second line" spellcheck="false" style="display:none"></textarea></span>
      <span></span><span><button data-x="add" class="pri">Add version</button> <span class="dim">nothing moves until you preview and use it</span></span></div><div class="rtres"></div>`;
  el = evDialog('Song versions', `${vs.length} take${vs.length === 1 ? '' : 's'} · ${cur} in use · nothing here calls Suno`, body, '<a data-x="brief">Suno brief…</a><span class="sp"></span><span class="dim">v1 is the song as it was imported</span>');
  el.querySelector('.evdlg').classList.add('sgdlg');
  focusDlg(el);
  const res = (h, bad) => { const r = el.querySelector('.rtres'); r.innerHTML = h; r.className = 'rtres ' + (bad ? 'err' : 'ok'); };
  el.addEventListener('change', (e) => {
    if (e.target.matches('input[data-held]')) { const box = el.querySelector('.sgpv'), btn = el.querySelector('[data-x=use]'); if (btn) btn.disabled = !!(lk || pv?.plan.problems.length || !allTicked(box)); return; }
    if (e.target.name === 'al') el.querySelector('[data-f=lrc]').style.display = e.target.value === 'lrc' ? '' : 'none'; });
  el.addEventListener('click', async (e) => {
    const x = e.target.closest('[data-x]')?.dataset.x; if (!x || x === 'close') return;
    try {
      if (x === 'pv') { sel = e.target.closest('[data-v]').dataset.v; return openVersions(); }
      if (x === 'brief') { el.remove(); return openBrief(); }
      if (x === 'use') { const v = sel; res('using ' + esc(v) + '… (decoding the audio)'); await use(v, ticked(el.querySelector('.sgpv'))); sel = null; return openVersions(); }
      if (x === 'add') {
        const f = (k) => el.querySelector(`[data-f=${k}]`), file = f('file').files?.[0], al = el.querySelector('[name=al]:checked').value;
        let p = f('path').value.trim();
        if (!file && !p) return res('choose the audio file of the take (or give its path)', true);
        if (file) { res('uploading… 0%'); p = await upload(file, (q) => res(`uploading… ${Math.round(q * 100)}%`)); }
        res('reading the take (ffprobe)…');
        const r = await store.op('song_version_add', { path: p, source: f('source').value, label: f('label').value.trim() || undefined, style: f('style').value, lyrics_prompt: f('lyrics').value,
          ...(al === 'offset' ? { offset_ms: Number(f('offset').value) || 0, scale: Number(f('scale').value) || 1 } : {}), ...(al === 'lrc' ? { lrc: f('lrc').value } : {}) });
        toast(`song ${r.version.id} added (${fmt(r.version.duration_ms)}): ${r.plan.summary}`);
        await store.reload(['song.json']); sel = r.version.id; return openVersions();
      }
    } catch (er) { res(esc(er.message || String(er)), true); }
  });
  return el;
}

export function openBrief() {
  css(); el?.remove();
  const s = store.settings?.suno || {};
  el = evDialog('Suno brief', 'paste it into Suno (custom mode) yourself · nothing here calls Suno', `<div class="sgadd" style="border:0;padding:0;margin:0">
    <span>Style</span><span><textarea data-f="style" style="height:96px" spellcheck="false" placeholder="genre, tempo, key, instruments, voices, the arc">${esc(s.style || '')}</textarea><span class="cnt" data-c="style"></span></span>
    <span>Exclude</span><span><textarea data-f="exclude" spellcheck="false">${esc(s.exclude || '')}</textarea><span class="cnt" data-c="exclude"></span></span>
    <span>Title</span><span><input type="text" data-f="title" value="${esc(s.title || store.song?.title || '')}"><span class="cnt" data-c="title"></span></span>
    <span>Lyrics</span><span><textarea data-f="lyrics" readonly style="height:180px" spellcheck="false"></textarea><span class="cnt" data-c="lyrics"></span> <span class="dim">from the Lyrics stage (current version), with its [section] tags; a tag without lines is a cue, not sung</span></span></div><div class="sgw"></div><div class="rtres"></div>`,
    '<button data-x="cstyle">Copy style</button><button data-x="clyrics">Copy lyrics</button><button data-x="call">Copy all</button><span class="sp"></span><a data-x="vers">Song versions…</a><button data-x="save" class="pri">Save style</button>');
  el.querySelector('.evdlg').classList.add('sgdlg');
  focusDlg(el);
  const f = (k) => el.querySelector(`[data-f=${k}]`);
  const build = () => SG.sunoBrief({ version: currentVersion(store.lyrics), style: f('style').value, exclude: f('exclude').value, title: f('title').value });
  const upd = () => { const b = build(); f('lyrics').value = b.lyrics; for (const g of b.gates) { const c = el.querySelector(`[data-c=${g.field}]`); c.textContent = `${g.count} / ${g.max}`; c.classList.toggle('over', !g.ok); } el.querySelector('.sgw').innerHTML = b.warnings.map(w => `<div class="dim">⚠ ${esc(w)}</div>`).join(''); return b; };
  el.addEventListener('input', upd); upd();
  el.addEventListener('click', async (e) => {
    const x = e.target.closest('[data-x]')?.dataset.x; if (!x || x === 'close') return;
    const b = upd();
    if (x === 'cstyle') { await copyText(b.style); toast('style copied'); }
    if (x === 'clyrics') { await copyText(b.lyrics); toast('lyrics copied'); }
    if (x === 'call') { await copyText(b.text); toast('the brief copied'); }
    if (x === 'vers') { el.remove(); openVersions(); }
    if (x === 'save') { await store.mutate('settings.json', (d) => { d.suno = { ...(d.suno || {}), style: b.style, exclude: b.exclude, title: b.title }; }, { label: 'Suno brief' }); toast('Suno style saved'); }
  });
  return el;
}

commands.register([
  { id: 'song.versions', group: 'Lyrics', title: () => `Song versions… (${SG.versionsOf(store.song).length}, ${SG.currentVersionId(store.song)} in use)`, when: () => !!store.song, run: () => openVersions() },
  { id: 'song.brief', group: 'Lyrics', title: 'Suno brief… (style + lyrics to paste)', when: () => !!store.song, run: () => openBrief() },
]);
menus.contribute('lystage', ['song.versions', 'song.brief']);
window.WB = Object.assign(window.WB || {}, { songs: { open: openVersions, brief: openBrief, plan } });
