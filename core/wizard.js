// New-project wizard (File > New project, and on an empty project): name -> lyrics -> song (optional) -> create.
// "new" creates data/<id>/ through POST /api/projects/new {id, title, lyrics, song?, bpm?} (lib/store.mjs
// createGuidedProject: lyrics.json v1, estimated timings over a placeholder duration until a song is attached) and opens
// it on the lyrics stage. "fill" (an empty project) skips the name and saves the lyrics into the open project.
//   WB.wizard.open({fill?: boolean})
import { store, toast, esc, PROJECT, postJSON, prefs } from '../js/store.js';
import { slugId, projects } from './projects.js';
import * as F from '../js/flow.js';

let box = null;
const STEPS = ['Name', 'Lyrics', 'Song'];
export const wizard = {
  isOpen: () => !!box,
  close() { box?.remove(); box = null; },
  open({ fill = false } = {}) {
    this.close();
    const st = { step: fill ? 1 : 0, fill, title: '', id: '', idTouched: false, lyrics: '', song: '', bpm: '' };
    box = document.createElement('div'); box.className = 'wizbg';
    box.innerHTML = `<div class="wiz" role="dialog" aria-label="new project"><div class="wizh"></div><div class="wizb"></div><div class="wizf"></div></div>`;
    document.body.appendChild(box);
    const $ = (s) => box.querySelector(s);
    const read = () => {
      const t = $('[name=title]'), i = $('[name=id]'), l = $('[name=lyrics]'), s = $('[name=song]'), b = $('[name=bpm]');
      if (t) st.title = t.value; if (i) st.id = i.value; if (l) st.lyrics = l.value; if (s) st.song = s.value.trim().replace(/^"|"$/g, ''); if (b) st.bpm = b.value;
    };
    const render = () => {
      $('.wizh').innerHTML = `<b>${fill ? `Start ${esc(PROJECT)}` : 'New project'}</b>` + STEPS.map((n, i) => (fill && i === 0) ? '' : `<span class="${i === st.step ? 'on' : i < st.step ? 'done' : ''}">${i + (fill ? 0 : 1)} ${n}</span>`).join('') + '<span class="sp"></span><a data-w="close" title="Esc">×</a>';
      const n = F.parseText(st.lyrics), lines = n.reduce((a, b) => a + b.lines.length, 0);
      $('.wizb').innerHTML = st.step === 0
        ? `<label>Title<input name="title" value="${esc(st.title)}" placeholder="My Song" spellcheck="false" autocomplete="off"></label>
           <label>Folder id<input name="id" value="${esc(st.id)}" placeholder="my-song" spellcheck="false" autocomplete="off"></label>
           <p class="dim">The project lives in data/&lt;id&gt;/. Next you paste the lyrics; the song file can come now or later.</p>`
        : st.step === 1
        ? `<label>Lyrics <span class="dim">(paste the poem; [Verse 1] / [Chorus] tags or blank lines make sections; LRC time tags are kept)</span>
           <textarea name="lyrics" rows="16" spellcheck="false" placeholder="[Verse 1]\nfirst line\nsecond line\n\n[Chorus]\n…">${esc(st.lyrics)}</textarea></label>
           <p class="dim wizcount">${lines ? `${lines} lines in ${n.length} section${n.length > 1 ? 's' : ''}: ${esc(n.map(s => s.label).join(', '))}` : 'You can also leave it empty and write the lyrics in the Lyrics stage.'}</p>`
        : `<label>Song file <span class="dim">(optional: path of an audio file on this machine; wav, mp3, m4a, flac, ogg)</span><input name="song" value="${esc(st.song)}" placeholder="C:\\music\\my-song.wav" spellcheck="false" autocomplete="off"></label>
           <label>BPM <span class="dim">(optional, default 120)</span><input name="bpm" value="${esc(st.bpm)}" placeholder="120" inputmode="decimal" style="width:80px"></label>
           <p class="dim">Without a song the project gets a placeholder length (${fmtMs(F.placeholderMs(lines))}) and estimated line timings; add the song later from the Lyrics stage (Add song…) and the lines are timed over the real song.</p>`;
      const last = st.step === 2;
      $('.wizf').innerHTML = `<span class="dim wizerr"></span><span class="sp"></span>${st.step > (fill ? 1 : 0) ? '<button data-w="back">Back</button>' : ''}${last ? '' : '<button data-w="next" class="pri">Next</button>'}${st.step >= 1 ? `<button data-w="create" class="${last ? 'pri' : ''}">${fill ? 'Start' : 'Create project'}</button>` : ''}`;
      ($('.wizb input, .wizb textarea'))?.focus();
    };
    const err = (m) => { const e = $('.wizerr'); if (e) e.textContent = m; };
    const go = async (what) => {
      read();
      if (what === 'close') return this.close();
      if (what === 'back') { st.step--; return render(); }
      if (st.step === 0 && (what === 'next' || what === 'create')) {
        if (!st.title.trim() && !st.id.trim()) return err('give the project a title');
        st.id = slugId(st.id || st.title); if (!st.id) return err('the id needs letters or digits');
        await projects.refresh().catch(() => {});
        if (projects.list.some(p => p.id === st.id)) return err(`a project "${st.id}" already exists: pick another id`);
      }
      if (what === 'next') { st.step++; return render(); }
      if (what !== 'create') return;
      if (st.bpm && !(Number(st.bpm) > 20 && Number(st.bpm) <= 400)) return err('bpm: a number between 20 and 400');
      const btn = $('[data-w=create]'); btn.disabled = true; err(st.song ? 'creating… (reading the song with ffmpeg)' : 'creating…');
      try {
        if (fill) await fillThis(st); else await create(st);
      } catch (e) { btn.disabled = false; return err(String(e.message || e)); }
    };
    box.addEventListener('click', (e) => { const w = e.target.closest('[data-w]'); if (w) go(w.dataset.w); else if (e.target === box) this.close(); });
    box.addEventListener('input', (e) => {
      if (e.target.name === 'title' && !st.idTouched) { const i = $('[name=id]'); if (i) i.value = slugId(e.target.value); }
      if (e.target.name === 'id') st.idTouched = true;
      if (e.target.name === 'lyrics') { read(); const n = F.parseText(st.lyrics), c = n.reduce((a, b) => a + b.lines.length, 0); const p = $('.wizcount'); if (p) p.textContent = c ? `${c} lines in ${n.length} section${n.length > 1 ? 's' : ''}: ${n.map(s => s.label).join(', ')}` : 'You can also leave it empty and write the lyrics in the Lyrics stage.'; }
    });
    box.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); this.close(); }
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
  toast(`created ${j.id}: ${j.lines} lines${j.song ? ', song attached' : ', no song yet'}`);
  projects.open(j.id);
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
}
window.WB = Object.assign(window.WB || {}, { wizard });
