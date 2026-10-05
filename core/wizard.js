// New-project wizard (File > New project, and on an empty project): name -> lyrics -> song (optional) -> create.
// "new" creates data/<id>/ through POST /api/projects/new {id, title, lyrics, song?, bpm?} (lib/store.mjs
// createGuidedProject: lyrics.json v1, estimated timings over a placeholder duration until a song is attached) and opens
// it on the lyrics stage. "fill" (an empty project) skips the name and saves the lyrics into the open project.
// G6 (new project from a song, in the page): the song step takes a DROPPED song file (mp3 / wav / m4a / flac / ogg; or
// "choose the file"), no path typing; the lyrics step loads a .txt / .lrc file (dropped on the text or "Load a file…"). On
// Create the song is uploaded in 4 MB chunks (core/projectzip.js uploadStaged: project_upload kind song, page only), then
// POST /api/projects/new {song_upload} reads it on the server (lib/ops/projectio.mjs createFromSong: ffprobe, the waveform,
// the energy, the beat grid estimated from the song when no BPM is typed, the lyric timings; LRC tags win) while the
// wizard shows the steps and their progress, then the result (length, BPM and where it came from, lines and their timing)
// and opens the project. A path on this machine still works ("or a path on this machine").
//   WB.wizard.open({fill?: boolean, start?: 'song'}); WB.wizard.hold = true keeps the result on screen (tests)
// start 'song' (G8, the onboarding's "Start from a song"): after the name, Next goes straight to the song step (lyrics: Back)
import { store, toast, esc, PROJECT, postJSON, prefs } from '../js/store.js';
import { slugId, projects } from './projects.js';
import { uploadStaged } from './projectzip.js';
import * as F from '../js/flow.js';

const CSS = `.wzdrop{border:1px dashed var(--line);padding:16px 8px;text-align:center;cursor:pointer;margin:0 0 8px;font-size:12px} .wzdrop.over{border-color:var(--acc);background:#2a2516} .wzdrop u{color:var(--acc)}
.wzfile{display:flex;gap:8px;align-items:center;margin:0 0 8px;padding:4px 6px;background:var(--bg3);font-size:12px} .wzfile b{color:var(--acc)} .wzfile a{margin-left:auto;cursor:pointer;color:var(--dim)}
.wzpath summary{cursor:pointer;font-size:11px;color:var(--dim);margin:0 0 6px} .wzload{font-size:11px;cursor:pointer;color:var(--acc);margin-left:6px}
.wzsteps{list-style:none;margin:4px 0;padding:0;font-size:12px} .wzsteps li{padding:5px 0 5px 22px;position:relative;color:var(--dim)}
.wzsteps li::before{content:'○';position:absolute;left:4px} .wzsteps li.on{color:var(--fg)} .wzsteps li.on::before{content:'◐';color:var(--acc)}
.wzsteps li.done{color:#a9c9b3} .wzsteps li.done::before{content:'✓'} .wzsteps li.err{color:#f0a090} .wzsteps li.err::before{content:'✗'}
.wzsteps .wzbar{display:block;height:4px;background:var(--line);margin-top:4px;max-width:360px} .wzsteps .wzbar i{display:block;height:100%;width:0;background:var(--acc)}
.wzsteps small{display:block;color:var(--dim);font-size:11px} .wzres{margin-top:6px;padding:6px 8px;background:var(--bg3);font-size:12px;line-height:18px} .wzres b{color:var(--acc)}`;
const AUDIO = /\.(mp3|wav|m4a|flac|ogg|aac)$/i;
const mb = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' kB');

let box = null;
const STEPS = ['Name', 'Lyrics', 'Song'];
export const wizard = {
  hold: false,
  isOpen: () => !!box,
  close() { box?.remove(); box = null; },
  open({ fill = false, start = null } = {}) {
    this.close();
    if (!document.getElementById('wzcss')) { const s = document.createElement('style'); s.id = 'wzcss'; s.textContent = CSS; document.head.appendChild(s); }
    const st = { step: fill ? 1 : 0, fill, title: '', id: '', idTouched: false, lyrics: '', song: '', file: null, bpm: '', prep: false, busy: false };
    box = document.createElement('div'); box.className = 'wizbg';
    box.innerHTML = `<div class="wiz" role="dialog" aria-label="new project"><div class="wizh"></div><div class="wizb"></div><div class="wizf"></div></div>`;
    document.body.appendChild(box);
    const $ = (s) => box.querySelector(s);
    const read = () => {
      const t = $('[name=title]'), i = $('[name=id]'), l = $('[name=lyrics]'), s = $('[name=song]'), b = $('[name=bpm]'), pr = $('[name=prep]');
      if (pr) st.prep = pr.checked;
      if (t) st.title = t.value; if (i) st.id = i.value; if (l) st.lyrics = l.value; if (s) st.song = s.value.trim().replace(/^"|"$/g, ''); if (b) st.bpm = b.value;
    };
    const fileRow = () => st.file ? `<div class="wzfile">♪ <b>${esc(st.file.name)}</b> <span class="dim">${mb(st.file.size)} · uploaded and read when you press ${fill ? 'Start' : 'Create project'}</span><a data-w="unfile" title="remove">×</a></div>` : '';
    const render = () => {
      $('.wizh').innerHTML = `<b>${fill ? `Start ${esc(PROJECT)}` : 'New project'}</b>` + STEPS.map((n, i) => (fill && i === 0) ? '' : `<span class="${i === st.step ? 'on' : i < st.step ? 'done' : ''}">${i + (fill ? 0 : 1)} ${n}</span>`).join('') + '<span class="sp"></span><a data-w="close" title="Esc">×</a>';
      const n = F.parseText(st.lyrics), lines = n.reduce((a, b) => a + b.lines.length, 0);
      $('.wizb').innerHTML = st.step === 0
        ? `<label>Title<input name="title" value="${esc(st.title)}" placeholder="My Song" spellcheck="false" autocomplete="off"></label>
           <label>Folder id<input name="id" value="${esc(st.id)}" placeholder="my-song" spellcheck="false" autocomplete="off"></label>
           <p class="dim">The project lives in data/&lt;id&gt;/. Next you paste the lyrics; the song file can come now or later.</p>`
        : st.step === 1
        ? `<label>Lyrics <span class="dim">(paste the poem, or drop a .txt / .lrc file on it; [Verse 1] / [Chorus] tags or blank lines make sections; LRC time tags are kept)</span><a class="wzload" data-w="loadlyr">Load a file…</a><input type="file" name="lyrfile" accept=".txt,.lrc,text/plain" hidden>
           <textarea name="lyrics" rows="16" spellcheck="false" placeholder="[Verse 1]\nfirst line\nsecond line\n\n[Chorus]\n…">${esc(st.lyrics)}</textarea></label>
           <p class="dim wizcount">${lines ? `${lines} lines in ${n.length} section${n.length > 1 ? 's' : ''}: ${esc(n.map(s => s.label).join(', '))}` : 'You can also leave it empty and write the lyrics in the Lyrics stage.'}</p>`
        : `<div class="wzdrop" data-w="pick"${st.file ? ' hidden' : ''}>Drop the song here <span class="dim">(mp3, wav, m4a, flac, ogg)</span> or <u>choose the file</u><input type="file" name="songfile" accept="audio/*,.mp3,.wav,.m4a,.flac,.ogg" hidden></div>${fileRow()}
           <label>BPM <span class="dim">(optional: empty = ${st.file || st.song ? 'estimated from the song' : '120'})</span><input name="bpm" value="${esc(st.bpm)}" placeholder="${st.file || st.song ? 'auto' : '120'}" inputmode="decimal" style="width:80px"></label>
           <details class="wzpath"${st.song ? ' open' : ''}><summary>or a path on this machine</summary><input name="song" value="${esc(st.song)}" placeholder="C:\\music\\my-song.wav" spellcheck="false" autocomplete="off"></details>
           <label class="wizprep"><input type="checkbox" name="prep"${st.prep ? ' checked' : ''}> Prepare starting proposals <span class="dim">(asks the agent for 3 choices per scene sketch and idea once it drafts the script, so you start by choosing; free. Generate &gt; Make free layouts works without an agent)</span></label>
           <p class="dim">The song is read on this machine: its length, the waveform, the beats and the lyric timings. Without a song the project gets a placeholder length (${fmtMs(F.placeholderMs(lines))}) and estimated line timings; add the song later from the Lyrics stage (Add song…).</p>`;
      const last = st.step === 2;
      $('.wizf').innerHTML = `<span class="dim wizerr"></span><span class="sp"></span>${st.step > (fill ? 1 : 0) ? '<button data-w="back">Back</button>' : ''}${last ? '' : '<button data-w="next" class="pri">Next</button>'}${st.step >= 1 ? `<button data-w="create" class="${last ? 'pri' : ''}">${fill ? 'Start' : 'Create project'}</button>` : ''}`;
      ($('.wizb input:not([type=file]):not([type=checkbox]), .wizb textarea'))?.focus();
    };
    const err = (m) => { const e = $('.wizerr'); if (e) e.textContent = m; };
    const takeSong = (f) => {
      if (!f) return;
      if (!AUDIO.test(f.name) && !/^audio\//.test(f.type)) return err(`${f.name}: not a song file (mp3, wav, m4a, flac, ogg)`);
      read(); st.file = f; st.song = ''; render(); err('');
    };
    const takeLyrics = async (f) => {
      if (!f) return;
      if (f.size > 200000) return err(`${f.name}: over 200 kB`);
      read(); st.lyrics = (await f.text()).replace(/^\uFEFF/, ''); render(); err(`loaded ${f.name}`);
    };
    const go = async (what) => {
      if (st.busy && what !== 'close') return;
      read();
      if (what === 'close') return this.close();
      if (what === 'back') { st.step--; return render(); }
      if (what === 'pick') return $('[name=songfile]')?.click();
      if (what === 'loadlyr') return $('[name=lyrfile]')?.click();
      if (what === 'unfile') { st.file = null; return render(); }
      if (st.step === 0 && (what === 'next' || what === 'create')) {
        if (!st.title.trim() && !st.id.trim()) return err('give the project a title');
        st.id = slugId(st.id || st.title); if (!st.id) return err('the id needs letters or digits');
        await projects.refresh().catch(() => {});
        if (projects.list.some(p => p.id === st.id)) return err(`a project "${st.id}" already exists: pick another id`);
      }
      if (what === 'next') { st.step = start === 'song' && st.step === 0 ? 2 : st.step + 1; return render(); }
      if (what !== 'create') return;
      if (st.bpm && !(Number(st.bpm) > 20 && Number(st.bpm) <= 400)) return err('bpm: a number between 20 and 400');
      const btn = $('[data-w=create]'); btn.disabled = true; err(st.song ? 'creating… (reading the song with ffmpeg)' : 'creating…');
      try {
        if (st.file) await withSong(st, box, this);
        else if (fill) await fillThis(st); else await create(st);
      } catch (e) { st.busy = false; if (st.file && box) { render(); } const b = $('[data-w=create]'); if (b) b.disabled = false; return err(String(e.message || e)); }
    };
    box.addEventListener('click', (e) => { const w = e.target.closest('[data-w]'); if (w) go(w.dataset.w); else if (e.target === box && !st.busy) this.close(); });
    box.addEventListener('change', (e) => {
      if (e.target.name === 'songfile') { takeSong(e.target.files[0]); e.target.value = ''; }
      if (e.target.name === 'lyrfile') { takeLyrics(e.target.files[0]); e.target.value = ''; }
    });
    // files dropped on the wizard are its own (never File › Import media…): a song on the song step, a text on the lyrics step
    box.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); e.stopPropagation(); $('.wzdrop')?.classList.add('over'); } });
    box.addEventListener('dragleave', () => $('.wzdrop')?.classList.remove('over'));
    box.addEventListener('drop', (e) => {
      const f = e.dataTransfer?.files?.[0]; if (!f) return;
      e.preventDefault(); e.stopPropagation(); $('.wzdrop')?.classList.remove('over');
      if (st.busy) return;
      if (AUDIO.test(f.name) || /^audio\//.test(f.type)) { if (st.step !== 2) { read(); st.step = 2; } takeSong(f); }
      else if (/\.(txt|lrc)$/i.test(f.name) || /^text\//.test(f.type)) { if (st.step !== 1) { read(); st.step = 1; } takeLyrics(f); }
      else err(`${f.name}: drop a song (mp3, wav, m4a, flac, ogg) or a lyrics file (.txt, .lrc)`);
    }, true);
    box.addEventListener('input', (e) => {
      if (e.target.name === 'title' && !st.idTouched) { const i = $('[name=id]'); if (i) i.value = slugId(e.target.value); }
      if (e.target.name === 'id') st.idTouched = true;
      if (e.target.name === 'lyrics') { read(); const n = F.parseText(st.lyrics), c = n.reduce((a, b) => a + b.lines.length, 0); const p = $('.wizcount'); if (p) p.textContent = c ? `${c} lines in ${n.length} section${n.length > 1 ? 's' : ''}: ${n.map(s => s.label).join(', ')}` : 'You can also leave it empty and write the lyrics in the Lyrics stage.'; }
    });
    box.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); if (!st.busy) this.close(); }
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || e.target.tagName === 'INPUT')) { e.preventDefault(); go(st.step === 2 ? 'create' : 'next'); }
    });
    render();
  },
};
const fmtMs = (ms) => `${Math.floor(ms / 60000)}:${String(Math.round(ms / 1000) % 60).padStart(2, '0')}`;
async function create(st) {
  const r = await postJSON('/api/projects/new', { id: st.id, title: st.title.trim() || st.id, lyrics: st.lyrics, ...(st.song ? { song: st.song } : {}), ...(st.bpm ? { bpm: Number(st.bpm) } : {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  prefs.set('activeTab', 'stage'); prefs.set('stage', 'lyrics');
  if (st.prep) prefs.set('ppPrepare', j.id);   // core/proposals.js writes the ask once the new project opens
  toast(`created ${j.id}: ${j.lines} lines${j.song ? ', song attached' : ', no song yet'}`);
  projects.open(j.id);
}
// G6: a dropped song: upload (chunks, progress), then the server reads it and makes the project; the steps on screen
async function withSong(st, box, wiz) {
  st.busy = true;
  const $ = (s) => box.querySelector(s);
  $('.wizb').innerHTML = `<ol class="wzsteps">
    <li data-s="up">Upload the song <span class="dim">${esc(st.file.name)} · ${mb(st.file.size)}</span><span class="wzbar"><i></i></span><small class="pct">0%</small></li>
    <li data-s="read">${st.fill ? 'Attach it' : 'Create the project'} and read the song <small>length (ffprobe), waveform, energy, beats${st.bpm ? '' : ' (estimated)'}, lyric timing</small><small class="el"></small></li>
    <li data-s="done">Open the project</li></ol><div class="wzres" hidden></div>`;
  $('.wizf').innerHTML = '<span class="dim wizerr"></span><span class="sp"></span><button data-w="create" class="pri" disabled>Working…</button>';
  const li = (s, cls) => { const x = $(`[data-s=${s}]`); if (x) x.className = cls; };
  li('up', 'on');
  let r, timer;
  try {
    const upload = st.fill ? null : await uploadStaged(st.file, 'song', (x) => { $('.wzbar i').style.width = Math.round(x * 100) + '%'; $('.pct').textContent = `${Math.round(x * 100)}%`; });
    let path = null;
    if (st.fill) path = await uploadSong(st.file, (x) => { $('.wzbar i').style.width = Math.round(x * 100) + '%'; $('.pct').textContent = `${Math.round(x * 100)}%`; });
    li('up', 'done'); li('read', 'on');
    const t0 = Date.now(); timer = setInterval(() => { const e = $('.el'); if (e) e.textContent = `${Math.round((Date.now() - t0) / 1000)} s`; }, 500);
    if (st.fill) {
      if (st.lyrics.trim()) { const body = F.assignIds(F.parseText(st.lyrics), F.currentVersion(store.lyrics), store.lyrics).sections; await store.mutate('lyrics.json', (d) => { F.addVersion(d, body, { by: 'director', via: 'page', message: 'first draft' }); }, { label: 'lyrics first draft' }); }
      const a = await store.op('song_attach', { path, ...(st.bpm ? { bpm: Number(st.bpm) } : { estimate: true }) });
      r = { id: PROJECT, lines: a.lines, song: a };
    } else {
      const res = await postJSON('/api/projects/new', { id: st.id, title: st.title.trim() || st.id, lyrics: st.lyrics, song_upload: upload, song_name: st.file.name, ...(st.bpm ? { bpm: Number(st.bpm) } : {}) });
      r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r.error || `HTTP ${res.status}`);
    }
  } catch (e) { clearInterval(timer); li($('[data-s=read]').className === 'on' ? 'read' : 'up', 'err'); throw e; }
  clearInterval(timer);
  li('read', 'done'); li('done', 'on');
  const s = r.song || {}, b = s.beats || {};
  const bpmTxt = b.source === 'estimated' ? `<b>${b.bpm} BPM</b> (estimated from the song, confidence ${Math.round((b.confidence || 0) * 100)}%)` : b.source === 'default' ? `<b>${s.bpm} BPM</b> (no clear beat found: the default; set it in Settings)` : `<b>${s.bpm} BPM</b>`;
  const res = $('.wzres'); res.hidden = false;
  res.innerHTML = `<b>${esc(r.id)}</b> · ${fmtMs(s.duration_ms || 0)} long · ${bpmTxt} · ${r.lines || 0} lyric line${r.lines === 1 ? '' : 's'}${r.lines ? (/\[\d+:\d+(\.\d+)?\]/.test(st.lyrics) ? ' (timed from the LRC tags)' : ' (timings estimated over the song: fix them in the Lyrics stage)') : ''}`;
  st.busy = false;
  prefs.set('activeTab', 'stage'); prefs.set('stage', 'lyrics');
  if (st.prep && !st.fill) prefs.set('ppPrepare', r.id);
  toast(`${st.fill ? 'song attached' : `created ${r.id}`}: ${fmtMs(s.duration_ms || 0)}, ${s.bpm} BPM${b.source === 'estimated' ? ' (estimated)' : ''}, ${r.lines} lines`);
  $('.wizf').innerHTML = `<span class="sp"></span><button data-w2="open" class="pri">${st.fill ? 'Done' : 'Open the project'}</button>`;
  const open = async () => { if (st.fill) { wiz.close(); await window.WB.stages.open('lyrics'); if (st.prep) await window.WB.proposals?.prepare('script'); } else projects.open(r.id); };
  $('[data-w2=open]').addEventListener('click', open);
  if (!wiz.hold) setTimeout(() => { if (box.isConnected) open(); }, 1800);
}
// an empty project being filled: the song goes in through E7's song_upload (page only) -> audio/versions/<name>
const b64 = (blob) => new Promise((ok, bad) => { const fr = new FileReader(); fr.onload = () => ok(String(fr.result).replace(/^data:[^,]*,/, '')); fr.onerror = () => bad(fr.error); fr.readAsDataURL(blob); });
async function uploadSong(file, onp) {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(10)), b => (b % 36).toString(36)).join(''), CH = 4 * 1024 * 1024;
  let off = 0, r = null;
  do { const part = file.slice(off, off + CH), done = off + part.size >= file.size; r = await store.op('song_upload', { upload: id, name: file.name, size: file.size, offset: off, data: await b64(part), done }); off += part.size; onp?.(off / file.size); } while (off < file.size);
  return r.path;
}
async function fillThis(st) {
  if (st.lyrics.trim()) {
    const body = F.assignIds(F.parseText(st.lyrics), F.currentVersion(store.lyrics), store.lyrics).sections;
    await store.mutate('lyrics.json', (d) => { F.addVersion(d, body, { by: 'director', via: 'page', message: 'first draft' }); }, { label: 'lyrics first draft' });
  }
  if (st.song) {
    const r = await postJSON('/api/op/song_attach', { path: st.song, ...(st.bpm ? { bpm: Number(st.bpm) } : {}) });
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error('song: ' + (j.error || r.status));
  }
  wizard.close();
  await window.WB.stages.open('lyrics');
  if (st.prep) await window.WB.proposals?.prepare('script');
}
window.WB = Object.assign(window.WB || {}, { wizard });
