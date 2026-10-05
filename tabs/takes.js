// Take selection (ROADMAP_v4 D6): the takes of a shot as compact cards, the in / out editor, A/B in the dock, the
// alternatives and the agent's take proposals. Used in two places:
//   - the storyboard Shot panel (tabs/storyboard.js): mountTakes(host, {shot})
//   - Review › Takes (this module's default export): every request with outputs (and every shot with takes), one at a time
// A card: hover scrubs the video (the pointer's x is the time), click opens it in the editor (larger), ⤢ opens it full
// size; Shift / Ctrl+click marks it B for A/B (the dock plays A and B side by side in lockstep over their in → out).
// The editor: the video, a mini strip of the take with two handles (in / out; dragged, snapped to the take's frames; the
// video follows), a time readout, a note; "Pick take" saves shot.clip through a NEW storyboard version (take_act, page
// only); "+ alt" marks the take as an alternative for a song time (shown in the pick). Approval stays separate.
// Logic and shapes: js/takes.js; server: lib/ops/takes.mjs (takes_get / take_propose / take_act).
import { store, esc, toast, postJSON, mediaUrl, prefs, PROJECT } from '../js/store.js';
import * as T from '../js/takes.js';
import * as SB from '../js/storyboard.js';

const WB = () => window.WB;
const ST = new Map();             // per shot: {sel, b, in, out, note, altT, altNote}
const INFO = new Map();           // media id -> {fps, duration_ms} from takes_get (ffprobe on the server)
const asked = new Set();
const clk = (ms) => { const s = Math.max(0, ms) / 1000, m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(2).padStart(5, '0')}`; };
const parseSong = (v) => { const s = String(v || '').trim(), m = /^(\d+):(\d{1,2}(?:\.\d+)?)$/.exec(s); if (m) return Math.round((+m[1] * 60 + +m[2]) * 1000); return /^\d+(\.\d+)?$/.test(s) ? Math.round(+s * 1000) : null; };
const parseSec = (v) => { const s = String(v || '').trim().replace(/\s*s$/, ''); return /^\d+(\.\d+)?$/.test(s) ? Math.round(+s * 1000) : null; };

// the saved shot (the pick lives on the current storyboard version) and its takes, from the page's store
export function savedShot(id) { return SB.boardShots(store.board).find(s => s.id === id) || null; }
export function shotTakes(shot) { return shot ? T.takesForShot(shot, { media: store.media, requests: store.requests, uses: store.uses }) : []; }
const info = (t) => ({ fps: INFO.get(t.media)?.fps || t.fps || T.DEFAULT_FPS, dur: t.duration_ms || INFO.get(t.media)?.duration_ms || null });
// fps / probed durations come from the server (takes_get); asked once per shot and media set
function askInfo(shotId, takes, rerender) {
  const k = shotId + '|' + takes.map(t => t.media).join(','); if (asked.has(k) || !takes.some(t => t.kind === 'video')) return; asked.add(k);
  postJSON('/api/op/takes_get', { shot: shotId }).then(r => r.ok ? r.json() : null).then(j => {
    if (!j) return; let ch = false;
    for (const t of j.takes || []) { const o = INFO.get(t.media); if (!o || o.fps !== t.fps || o.duration_ms !== t.duration_ms) { INFO.set(t.media, { fps: t.fps, duration_ms: t.duration_ms }); ch = true; } }
    if (ch) rerender();
  }).catch(() => {});
}
function stateFor(shot, takes) {
  let s = ST.get(shot.id);
  if (!s) { s = {}; ST.set(shot.id, s); }
  if (!s.sel || !takes.some(t => t.media === s.sel)) { const p = shot.clip && takes.find(t => t.file === shot.clip.file); s.sel = (p || takes.find(t => t.kind === 'video') || takes[0])?.media || null; s.range = null; }
  const t = takes.find(x => x.media === s.sel);
  if (t && !s.range) {
    const { dur } = info(t), pick = shot.clip && shot.clip.file === t.file ? shot.clip : null;
    s.range = t.kind === 'video' ? { in: pick?.in_ms ?? 0, out: pick?.out_ms ?? (dur ? Math.min(dur, Math.max(1, shot.t1 - shot.t0)) : null) } : { in: 0, out: null };
    s.note = pick?.note ?? s.note ?? '';
  }
  return s;
}

// ------------------------------------------------------------------ html
function cardHtml(t, shot, s) {
  const pick = shot.clip, picked = pick?.file === t.file, alt = (pick?.alt || []).filter(a => a.file === t.file), prop = T.openProposals(store.takes, shot.id).some(p => p.file === t.file);
  const { dur } = info(t), name = T.takeName(t);
  return `<div class="tkc${t.media === s.sel ? ' on' : ''}${t.media === s.b ? ' b' : ''}${picked ? ' pk' : ''}" data-tk="${esc(t.media)}" data-tkind="${t.kind}" title="${esc(`${name} · ${t.label}${dur ? ' · ' + T.secs(dur, 1) : ''}${t.source === 'import' ? ' · imported' : ''}${picked ? ' · PICKED' : ''}${prop ? ' · proposed by the agent' : ''}\nclick: open · Shift+click: B for A/B · ⤢ full size`)}">`
    + `<div class="tkth">${t.thumb ? `<img src="${esc(mediaUrl(t.thumb))}" alt="" loading="lazy">` : t.kind === 'image' ? `<img src="${esc(mediaUrl(t.file))}" alt="" loading="lazy">` : '<span class="tknoth">▶</span>'}<i class="tkbar"></i>${t.kind === 'video' ? '<u class="tkhv"></u>' : ''}<b class="tkz" data-tk-a="big" title="full size">⤢</b></div>`
    + `<div class="tkl">${t.request || t.job ? `<b>#${esc(t.take ?? '?')}</b>` : `<b class="tkfn">${esc(name)}</b>`}${picked ? '<i class="tkpk" title="picked">★</i>' : prop ? '<i class="tkpp" title="the agent proposes it">◆</i>' : ''}${alt.length ? `<i class="tkal" title="${esc(alt.map(a => `alt for ${clk(a.t)} ${a.note}`).join('\n'))}">alt</i>` : ''}${dur ? `<span>${(dur / 1000).toFixed(1)}s</span>` : t.kind === 'image' ? '<span>still</span>' : ''}${t.request || t.job ? `<span class="tkrq">${esc(t.request || t.job)}</span>` : ''}</div></div>`;
}
function editorHtml(t, shot, s) {
  const { fps, dur } = info(t), r = s.range || { in: 0, out: null }, pick = shot.clip, picked = pick?.file === t.file;
  const pc = (ms) => dur ? `${(ms / dur * 100).toFixed(3)}%` : '0%';
  const len = r.out != null ? r.out - r.in : null, frames = len != null ? Math.round(len / T.frameMs(fps)) : null;
  const fit = len != null ? T.fitNote({ in_ms: r.in, out_ms: r.out }, shot) : '';
  const media = t.kind === 'video'
    ? `<video class="tkvid" src="${esc(mediaUrl(t.file))}#t=${(r.in / 1000).toFixed(3)}" muted playsinline preload="auto"></video>`
    : `<img class="tkvid" src="${esc(mediaUrl(t.file))}" alt="">`;
  const strip = t.kind === 'video' ? `<div class="tkstrip" data-dur="${dur || 0}" ${t.strip ? `style="background-image:url('${esc(mediaUrl(t.strip))}')"` : ''} title="drag the handles: in / out (snapped to ${fps} fps frames); click: seek">`
    + `<i class="tkdim l" style="width:${pc(r.in)}"></i><i class="tkdim r" style="left:${pc(r.out ?? dur ?? 0)}"></i><b class="tkh" data-h="in" style="left:${pc(r.in)}"></b><b class="tkh" data-h="out" style="left:${pc(r.out ?? dur ?? 0)}"></b><u class="tkph" style="left:${pc(r.in)}"></u></div>` : '';
  const ro = t.kind === 'video'
    ? `<div class="tkro"><label>in <input class="tkin" value="${(r.in / 1000).toFixed(2)}" spellcheck="false"></label><label>out <input class="tkout" value="${r.out != null ? (r.out / 1000).toFixed(2) : ''}" spellcheck="false"></label><span class="tklen">${len != null ? `${T.secs(len)} · ${frames} f @${fps}` : ''}</span><span class="tkfit dim">${esc(fit)}</span></div>`
    : '<div class="tkro dim">a still: no in / out</div>';
  const alts = (pick?.alt || []).map((a, i) => `<span class="tkalt1" title="${esc(a.note)}">alt ${esc(a.file ? T.takeName(shotTakes(shot).find(x => x.file === a.file) || { file: a.file }) : '#' + a.take)} for <a data-tk-t="${a.t}">${clk(a.t)}</a>${a.note ? ' · ' + esc(a.note.slice(0, 40)) : ''}<b data-tk-a="altrm" data-i="${i}" title="remove">×</b></span>`).join('');
  return `<div class="tked" data-tk="${esc(t.media)}">${media}${strip}${ro}`
    + `<div class="tkrow"><input class="tknote" value="${esc(s.note || '')}" placeholder="note: use 0.5–1.5 s; add a code push" spellcheck="false" maxlength="${T.NOTE_MAX}"></div>`
    + `<div class="tkact"><button data-tk-a="pick" class="pri" title="the director's pick: saved on the shot as a new storyboard version (approval stays separate)">${picked ? 'Update pick' : 'Pick take'}</button>${t.kind === 'video' ? '<button data-tk-a="play" title="play in → out">▶</button><button data-tk-a="seti" title="in = the video\'s time">⇤in</button><button data-tk-a="seto" title="out = the video\'s time">out⇥</button>' : ''}<button data-tk-a="ab" title="A/B in the preview dock: this take (A) and the B take (Shift+click a card) or the pick">A/B</button>${pick ? '<button data-tk-a="unpick" title="remove the pick (a new version)">unpick</button>' : ''}</div>`
    + `<div class="tkaltf"><span class="dim">alt for</span><input class="tkaltt" value="${esc(s.altT ?? clk(shot.t0))}" spellcheck="false" title="the song time this take is an alternative for (m:ss.ss)"><input class="tkaltn" value="${esc(s.altNote || '')}" placeholder="why (bigger smile)" spellcheck="false" maxlength="${T.ALT_NOTE_MAX}"><button data-tk-a="alt"${pick ? '' : ' disabled title="pick a take first: an alternative is kept on the pick"'}>+ alt</button></div>`
    + (alts ? `<div class="tkalts">${alts}</div>` : '') + '</div>';
}
function proposalsHtml(shot, takes) {
  const ps = (store.takes?.proposals || []).filter(p => p.shot === shot.id && p.status !== 'dismissed');
  if (!ps.length) return '';
  return `<div class="tkps">${ps.map(p => { const t = takes.find(x => x.file === p.file); return `<div class="tkp s-${esc(p.status)}" data-p="${esc(p.id)}"><i>◆</i><b data-tk-sel="${esc(t?.media || '')}">${esc(T.takeName(t || p))}</b><span class="tkpr">${p.out_ms != null ? `${(p.in_ms / 1000).toFixed(2)}–${(p.out_ms / 1000).toFixed(2)} s` : 'still'}</span><span class="tkpw" title="${esc(p.why)}">${esc(p.why)}</span>${p.status === 'picked' ? '<span class="okc">picked</span>' : `<button data-tk-a="ppick" class="pri" title="pick it (one click: the proposed range)">Pick</button><b data-tk-a="pdis" title="dismiss">×</b>`}</div>`; }).join('')}</div>`;
}
export function takesHtml(shot) {
  if (!shot) return '<div class="dim tkno">save the storyboard first: a pick names a saved shot</div>';
  const takes = shotTakes(shot), s = stateFor(shot, takes), t = takes.find(x => x.media === s.sel), pick = shot.clip;
  const head = `<div class="tkhd"><span class="dim">${takes.length ? `${takes.length} take${takes.length > 1 ? 's' : ''}` : 'no takes yet'}</span>${pick ? `<span class="tkpkd" title="${esc(pick.note || '')}">★ ${esc(T.takeName({ ...pick, job: store.mediaById?.[pick.media]?.job }))}${pick.out_ms != null ? ` ${(pick.in_ms / 1000).toFixed(2)}–${(pick.out_ms / 1000).toFixed(2)} s` : ''}${pick.alt?.length ? ` · ${pick.alt.length} alt` : ''}</span>` : '<span class="dim">· none picked</span>'}</div>`;
  if (!takes.length) return `<div class="tkw" data-shot="${esc(shot.id)}">${head}<div class="dim tkno">runner outputs of this shot's requests and media linked to it (media_update shots) show here</div></div>`;
  return `<div class="tkw" data-shot="${esc(shot.id)}">${head}<div class="tkstrip0">${takes.map(x => cardHtml(x, shot, s)).join('')}</div>${proposalsHtml(shot, takes)}${t ? editorHtml(t, shot, s) : ''}</div>`;
}

// ------------------------------------------------------------------ acts (take_act: page only)
async function act(body) {
  const r = await postJSON('/api/op/take_act', body), j = await r.json().catch(() => ({}));
  if (!r.ok) { toast('take: ' + (j.error || `HTTP ${r.status}`)); return null; }
  return j;
}
function clipBody(shot, t, s, extra = {}) {
  const pick = shot.clip;
  return { act: 'pick', shot: shot.id, media: t.media, in_ms: s.range?.in ?? 0, out_ms: t.kind === 'video' ? s.range?.out : null, note: s.note || '', alt: (pick?.alt || []).map(a => ({ ...(a.file ? { file: a.file } : { take: a.take }), t: a.t, note: a.note })), ...extra };
}
export async function pickTake(shotId, mediaId, range, { note, proposal } = {}) {
  const shot = savedShot(shotId), t = shotTakes(shot).find(x => x.media === mediaId); if (!shot || !t) return null;
  const s = stateFor(shot, shotTakes(shot)); s.sel = mediaId; if (range) s.range = { ...range }; if (note != null) s.note = note;
  const j = await act(clipBody(shot, t, s, proposal ? { proposal } : {}));
  if (j) toast(j.unchanged ? `${shotId}: already picked` : `${shotId}: ${T.takeName(t)} picked${j.clip?.out_ms != null ? ` ${(j.clip.in_ms / 1000).toFixed(2)}–${(j.clip.out_ms / 1000).toFixed(2)} s` : ''} · ${j.version}${j.fit ? ' · ' + j.fit : ''}`);
  return j;
}
function abSources(shot, takes, s) {
  const a = takes.find(t => t.media === s.sel), b = takes.find(t => t.media === s.b) || takes.find(t => shot.clip && t.file === shot.clip.file && t.media !== s.sel) || takes.find(t => t.media !== s.sel);
  if (!a || !b) return null;
  const rng = (t) => t.media === s.sel && s.range ? s.range : shot.clip?.file === t.file ? { in: shot.clip.in_ms, out: shot.clip.out_ms } : { in: 0, out: info(t).dur };
  return { kind: 'ab', a: a.media, b: b.media, ain: rng(a).in, aout: rng(a).out, bin: rng(b).in, bout: rng(b).out, title: `${shot.id}: A ${T.takeName(a)} · B ${T.takeName(b)}` };
}

// ------------------------------------------------------------------ mount (the host's innerHTML is replaced on every render)
export function mountTakes(host, { shot: shotId, onChange } = {}) {
  const render = () => { const sh = savedShot(shotId); host.innerHTML = takesHtml(sh); wireMedia(); if (sh) askInfo(shotId, shotTakes(sh), render); onChange?.(); };
  const cur = () => { const sh = savedShot(shotId), takes = shotTakes(sh), s = sh ? stateFor(sh, takes) : null; return { sh, takes, s, t: s && takes.find(x => x.media === s.sel) }; };
  const vid = () => host.querySelector('video.tkvid');
  const pctOf = (ms, dur) => dur ? `${(ms / dur * 100).toFixed(3)}%` : '0%';
  // the readout, the dims and the handles follow the range without a full render (the video keeps playing)
  const paint = () => {
    const { sh, s, t } = cur(); if (!t || t.kind !== 'video') return;
    const { fps, dur } = info(t), r = s.range, ed = host.querySelector('.tked'); if (!ed) return;
    ed.querySelector('.tkdim.l').style.width = pctOf(r.in, dur); ed.querySelector('.tkdim.r').style.left = pctOf(r.out ?? dur, dur);
    ed.querySelector('.tkh[data-h=in]').style.left = pctOf(r.in, dur); ed.querySelector('.tkh[data-h=out]').style.left = pctOf(r.out ?? dur, dur);
    const i = ed.querySelector('.tkin'), o = ed.querySelector('.tkout');
    if (document.activeElement !== i) i.value = (r.in / 1000).toFixed(2); if (document.activeElement !== o) o.value = r.out != null ? (r.out / 1000).toFixed(2) : '';
    const len = r.out != null ? r.out - r.in : null;
    ed.querySelector('.tklen').textContent = len != null ? `${T.secs(len)} · ${Math.round(len / T.frameMs(fps))} f @${fps}` : '';
    ed.querySelector('.tkfit').textContent = len != null ? T.fitNote({ in_ms: r.in, out_ms: r.out }, sh) : '';
  };
  const setRange = (which, ms) => {
    const { s, t } = cur(); if (!t || t.kind !== 'video') return;
    const { fps, dur } = info(t), f = T.frameMs(fps), r = s.range; let v = T.snapFrame(ms, fps, dur);
    if (which === 'in') v = Math.min(v, (r.out ?? dur) - Math.round(f)); else v = Math.max(v, r.in + Math.round(f));
    r[which] = Math.max(0, dur ? Math.min(dur, v) : v); paint();
    const V = vid(); if (V) V.currentTime = r[which] / 1000;
  };
  function wireMedia() {
    const V = vid(); if (!V) return;
    const ph = host.querySelector('.tkph');
    V.addEventListener('timeupdate', () => { const { s, t } = cur(); if (!t) return; const { dur } = info(t), ms = V.currentTime * 1000; if (ph) ph.style.left = pctOf(ms, dur); if (V._toOut && s.range.out != null && ms >= s.range.out - 15) { V.pause(); V._toOut = false; V.currentTime = s.range.in / 1000; } });
    V.addEventListener('loadedmetadata', () => { const { t } = cur(); if (t && !info(t).dur && V.duration) { INFO.set(t.media, { ...(INFO.get(t.media) || {}), duration_ms: Math.round(V.duration * 1000) }); render(); } }, { once: true });
  }
  host.onclick = async (e) => {
    const { sh, takes, s, t } = cur(); if (!sh) return;
    const a = e.target.closest('[data-tk-a]')?.dataset.tkA, card = e.target.closest('.tkc[data-tk]');
    if (a === 'big' && card) { e.stopPropagation(); return enlarge(takes.find(x => x.media === card.dataset.tk)); }
    if (card && !a) {
      if (e.shiftKey || e.ctrlKey || e.metaKey) { s.b = s.b === card.dataset.tk ? null : card.dataset.tk; return render(); }
      if (s.sel !== card.dataset.tk) { s.sel = card.dataset.tk; s.range = null; } return render();
    }
    const sel = e.target.closest('[data-tk-sel]'); if (sel && sel.dataset.tkSel) { s.sel = sel.dataset.tkSel; const p = (store.takes?.proposals || []).find(x => x.id === sel.closest('[data-p]')?.dataset.p); s.range = p ? { in: p.in_ms, out: p.out_ms } : null; return render(); }
    const tt = e.target.closest('[data-tk-t]'); if (tt) return WB()?.timeline?.seek(Number(tt.dataset.tkT));
    const st = e.target.closest('.tkstrip'); if (st && !e.target.closest('.tkh')) { const r = st.getBoundingClientRect(), dur = Number(st.dataset.dur) || 0, V = vid(); if (V && dur) V.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * dur / 1000; return; }
    if (!a) return;
    const V = vid();
    if (a === 'play' && V && t) { V.currentTime = s.range.in / 1000; V._toOut = true; V.play().catch(() => {}); return; }
    if (a === 'seti' && V) return setRange('in', V.currentTime * 1000);
    if (a === 'seto' && V) return setRange('out', V.currentTime * 1000);
    if (a === 'pick' && t) { const j = await act(clipBody(sh, t, s)); if (j) toast(j.unchanged ? 'nothing changed' : `${sh.id}: ${T.takeName(t)} picked · ${j.version}${j.fit ? ' · ' + j.fit : ''}`); return; }
    if (a === 'unpick') { const j = await act({ act: 'unpick', shot: sh.id }); if (j) toast(`${sh.id}: no take picked · ${j.version}`); return; }
    if (a === 'ab') { const src = abSources(sh, takes, s); if (!src) return toast('A/B needs two takes'); return WB()?.dock?.show(src); }
    if (a === 'alt' && t && sh.clip) {
      const tm = parseSong(host.querySelector('.tkaltt')?.value); if (tm == null) return toast('alt for: a song time m:ss.ss');
      s.altT = clk(tm); s.altNote = host.querySelector('.tkaltn')?.value || '';
      const pt = takes.find(x => x.file === sh.clip.file); if (!pt) return toast('the picked take is no longer registered');
      const body = { act: 'pick', shot: sh.id, media: pt.media, in_ms: sh.clip.in_ms, out_ms: sh.clip.out_ms, note: sh.clip.note || '', alt: [...(sh.clip.alt || []).map(x => ({ ...(x.file ? { file: x.file } : { take: x.take }), t: x.t, note: x.note })), { media: t.media, t: tm, note: s.altNote }] };
      const j = await act(body); if (j) { s.altNote = ''; toast(`${T.takeName(t)} marked as an alternative for ${clk(tm)}`); } return;
    }
    if (a === 'altrm' && sh.clip) {
      const i = Number(e.target.dataset.i), pt = takes.find(x => x.file === sh.clip.file); if (!pt) return;
      const alt = (sh.clip.alt || []).filter((_, k) => k !== i).map(x => ({ ...(x.file ? { file: x.file } : { take: x.take }), t: x.t, note: x.note }));
      await act({ act: 'pick', shot: sh.id, media: pt.media, in_ms: sh.clip.in_ms, out_ms: sh.clip.out_ms, note: sh.clip.note || '', alt }); return;
    }
    const pid = e.target.closest('[data-p]')?.dataset.p, p = pid && (store.takes?.proposals || []).find(x => x.id === pid);
    if (a === 'ppick' && p) { const pt = takes.find(x => x.file === p.file); if (!pt) return toast('that take is no longer registered'); await pickTake(sh.id, pt.media, { in: p.in_ms, out: p.out_ms }, { proposal: p.id, note: s.note }); return; }
    if (a === 'pdis' && p) { await act({ act: 'dismiss', proposal: p.id }); return; }
  };
  // hover-scrub on a card: the pointer's x is the time in the take (a muted video replaces the thumbnail while hovering)
  host.onpointermove = (e) => {
    const card = e.target.closest('.tkc[data-tkind=video]'); if (!card) return;
    const { takes } = cur(), t = takes.find(x => x.media === card.dataset.tk); if (!t) return;
    const th = card.querySelector('.tkth'); let v = th.querySelector('video');
    if (!v) { v = document.createElement('video'); v.muted = true; v.preload = 'auto'; v.playsInline = true; v.src = mediaUrl(t.file); th.appendChild(v); }
    const r = th.getBoundingClientRect(), f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), dur = info(t).dur || (v.duration * 1000) || 0;
    if (dur) v.currentTime = f * dur / 1000;
    const bar = th.querySelector('.tkhv'); if (bar) bar.style.left = `${(f * 100).toFixed(1)}%`;
    card.classList.add('scr');
  };
  host.onpointerout = (e) => { const card = e.target.closest('.tkc'); if (card && !card.contains(e.relatedTarget)) { card.classList.remove('scr'); card.querySelector('.tkth video')?.remove(); } };
  // the handles: drag (pointer capture), snapped to frames; the video follows
  host.onpointerdown = (e) => {
    const h = e.target.closest('.tkh'); if (!h) return;
    e.preventDefault(); const strip = h.parentElement, dur = Number(strip.dataset.dur) || 0; if (!dur) return;
    h.setPointerCapture(e.pointerId); h.classList.add('drag');
    const move = (ev) => { const r = strip.getBoundingClientRect(); setRange(h.dataset.h, Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * dur); };
    const up = () => { h.classList.remove('drag'); h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up); };
    h.addEventListener('pointermove', move); h.addEventListener('pointerup', up);
  };
  host.onchange = (e) => {
    const { s } = cur(); if (!s) return;
    if (e.target.matches('.tkin, .tkout')) { const v = parseSec(e.target.value); if (v == null) { toast('seconds, e.g. 1.25'); return paint(); } return setRange(e.target.matches('.tkin') ? 'in' : 'out', v); }
  };
  host.oninput = (e) => { const { s } = cur(); if (!s) return; if (e.target.matches('.tknote')) s.note = e.target.value; if (e.target.matches('.tkaltn')) s.altNote = e.target.value; if (e.target.matches('.tkaltt')) s.altT = e.target.value; };
  host.onkeydown = (e) => { if (e.target.matches('input')) { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } } };
  render();
  return { render };
}
// full size: an overlay with the take (controls, looped); Esc or a click outside closes it
export function enlarge(t) {
  if (!t) return;
  document.querySelector('.tkbig')?.remove();
  const o = document.createElement('div'); o.className = 'tkbig';
  o.innerHTML = `<div class="tkbigb">${t.kind === 'video' ? `<video src="${esc(mediaUrl(t.file))}" controls autoplay muted loop playsinline></video>` : `<img src="${esc(mediaUrl(t.file))}" alt="">`}<div class="tkbigc">${esc(T.takeName(t))} · ${esc(t.label)}${t.duration_ms ? ' · ' + T.secs(t.duration_ms, 1) : ''} <span class="dim">Esc closes</span></div></div>`;
  const close = () => { o.remove(); removeEventListener('keydown', key, true); };
  const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  o.addEventListener('click', (e) => { if (!e.target.closest('.tkbigb')) close(); });
  addEventListener('keydown', key, true); document.body.appendChild(o);
}

// ------------------------------------------------------------------ Review › Takes: per request (and per shot)
let V = null;
class TakesView {
  constructor(el) {
    this.el = el; this.sel = prefs.get('takesSel:' + PROJECT, null);
    el.classList.add('tkview');
    el.innerHTML = '<div class="tklist"></div><div class="tkmain"></div>';
    el.querySelector('.tklist').addEventListener('click', (e) => { const r = e.target.closest('[data-k]'); if (r) { this.sel = r.dataset.k; prefs.set('takesSel:' + PROJECT, this.sel); this.render(); } });
    store.on((w) => { if (['all', 'board', 'requests', 'takes', 'media'].includes(w)) this.render(); });
    this.render();
  }
  rows() {
    const R = store.requests?.items || [], shots = SB.boardShots(store.board), out = [];
    for (const r of R) { const tk = T.takesForRequest(r.id, { media: store.media, requests: R }); if (tk.length) out.push({ k: 'r:' + r.id, label: r.id, sub: `${r.kind || ''} · ${r.target || ''}`, n: tk.length, shot: /^shot:/.test(r.target || '') ? r.target.slice(5) : null }); }
    for (const s of shots) { const tk = shotTakes(s); if (tk.length) out.push({ k: 's:' + s.id, label: s.id, sub: `shot · ${clk(s.t0)}${s.clip ? ' · ★' : ''}`, n: tk.length, shot: s.id, picked: !!s.clip }); }
    return out;
  }
  render() {
    const rows = this.rows(); if (!rows.some(r => r.k === this.sel)) this.sel = rows[0]?.k || null;
    this.el.querySelector('.tklist').innerHTML = rows.length ? rows.map(r => `<div class="tkli${r.k === this.sel ? ' on' : ''}" data-k="${esc(r.k)}"><b>${esc(r.label)}</b><span class="dim">${esc(r.sub)}</span><i>${r.n}</i></div>`).join('') : '<div class="dim tkno">no takes yet: approved requests the runner ran, or media linked to shots</div>';
    const row = rows.find(r => r.k === this.sel), main = this.el.querySelector('.tkmain');
    if (!row) { main.innerHTML = ''; return; }
    if (row.shot && savedShot(row.shot)) { main.innerHTML = `<div class="tkmh"><b>${esc(row.k.startsWith('r:') ? `${row.label} → ${row.shot}` : row.label)}</b><a data-go="${esc(row.shot)}">open in the storyboard ›</a></div><div class="tkhost"></div>`; mountTakes(main.querySelector('.tkhost'), { shot: row.shot }); }
    else { const tk = T.takesForRequest(row.label, { media: store.media, requests: store.requests }); main.innerHTML = `<div class="tkmh"><b>${esc(row.label)}</b><span class="dim">${esc(row.sub)} · not a shot request: its outputs join the asset tree</span></div><div class="tkstrip0">${tk.map(t => `<div class="tkc" data-tk="${esc(t.media)}"><div class="tkth"><img src="${esc(mediaUrl(t.thumb || t.file))}" alt=""></div><div class="tkl"><b>${esc(T.takeName(t))}</b></div></div>`).join('')}</div>`; main.onclick = (e) => { const c = e.target.closest('.tkc'); if (c) enlarge(tk.find(t => t.media === c.dataset.tk)); }; }
    main.querySelector('[data-go]')?.addEventListener('click', async (e) => { const id = e.target.dataset.go; await WB().stages.open('storyboard'); WB().storyboard?.focus(id); });
  }
}
export default {
  mount(el) { V = new TakesView(el); window.WB = Object.assign(window.WB || {}, { takes: { view: () => V, mountTakes, enlarge, pickTake } }); },
  show() { V?.render(); },
};
