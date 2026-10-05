// Column definitions for the timeline. kind 'lane' = canvas drawn per pixel row; kind 'text' = DOM items placed by y(t).
// A text column has build(c) -> c.items [{t0, t1?, el}], optional prepare/measure/tick/act/refresh/dblclick.
// A lane column has draw(c, env). Adding a column = adding one object here.
import { el, fmt, secColor, upperBound } from './timeline.js';
import { mediaUrl, esc } from './store.js';
import { currentScript, sceneStatus } from './scenes.js';
import { currentBreakdown, KINDS, KIND_COLOR } from './breakdown.js';
import { shotEstimate } from './storyboard.js';
import { noteTime, STAGE_TITLE } from './notes.js';
import { coverage } from './surfaces.js';

const LH = 14;              // lyric visual line height (px), 12 px type
const RAMP = Array.from({ length: 32 }, (_, i) => { const a = i / 31; const l = 14 + a * 70; return `hsl(210, ${12 + a * 20}%, ${l}%)`; });
const STEM_COLORS = { vocals: '#9db7d6', backing: '#b7a6d9', bass: '#93c2a2', drums: '#cfae80' };
const ICON = { stop: '■', drop: '▼', count: '#', silence: '∅', beat: '♩', spoken: '“', word: 'w', end: '⏹', line: '·', section: '§' };
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const cssColor = (c, d = '#888') => /^#[0-9a-f]{3,8}$/i.test(c || '') ? c : d;

export function makeColumns(tl, store) {
  const song = store.song, dur = song.duration_ms;
  const st = (k) => store.state(k);
  const chip = (k, label) => `<span class="chip s-${esc(st(k))}" data-act="st" data-k="${esc(k)}" title="${esc(k)}: ${esc(st(k))} (click: approve / needs changes / draft)">${esc(label)}</span>`;
  const seekAct = (c, a) => { if (a.dataset.act === 'seek') tl.seek(Number(a.dataset.t)); if (a.dataset.act === 'st') store.cycle(a.dataset.k); };
  const refreshChips = (c, what) => { if (what !== 'approvals') return false; for (const ch of c.body.querySelectorAll('.chip[data-k], .st[data-k]')) { const s = st(ch.dataset.k); ch.className = ch.className.replace(/\bs-\w+/, 's-' + s); ch.title = `${ch.dataset.k}: ${s}`; } return false; };
  // the storyboard's shots (storyboard.json; a project without it reads shots.json): shots, cast and status columns
  const shotSpans = () => store.boardShots().map(s => ({ t0: s.t0, t1: s.t1, s }));
  const onBoard = (fn) => function (c, what) { if (what === 'board') { this.build(c); return true; } return fn ? fn(c, what) : false; };
  // a shot's frame: its frame sketch (the flattened PNG, cache-busted by its media entry), else the shots.json thumbnail
  const frameSrc = (s) => { if (s.sketch) { const m = store.mediaById?.['sketch-' + s.sketch]; return `${mediaUrl(m?.path || `sketches/${s.sketch}.png`)}?v=${encodeURIComponent(m?.updated || '')}`; } return s.thumb ? mediaUrl(s.thumb) : ''; };
  const short = (id) => { const e = store.entityById?.[id] || store.entities.find(x => x.kind === 'location' && x.letter === id); return e?.letter || e?.short || (e ? String(e.name || id).split(/[\s·-]+/).filter(Boolean).map(w => w[0]).join('').slice(0, 2).toUpperCase() : id); };

  function addItems(c, list, html, cls = '') {
    c.body.innerHTML = ''; c.items = [];
    for (const x of list) {
      const e = el('div', `it ${cls}`); e.innerHTML = html(x);
      c.body.appendChild(e); c.items.push({ t0: x.t0, t1: x.t1, el: e, x });
    }
  }

  return [
    // ---------------------------------------------------------------- ruler
    { id: 'ruler', title: 'time', kind: 'lane', w: 40, draw(c, env) {
      const { ctx, w, rows, dpr, rowsT, yOf, warp } = env;
      for (const s of song.sections) { const y0 = yOf(s.t0), y1 = yOf(s.t1); if (y1 < 0 || y0 > rows) continue; ctx.fillStyle = secColor(s.id, 0.95); ctx.fillRect(0, y0, Math.min(3 * dpr, w), y1 - y0); }
      // density tint: local px/s over the floor (the axis shows its own scale)
      if (w > 4 * dpr) for (let r = 0; r < rows; r += 2) {
        const dt = rowsT[Math.min(rows, r + 2)] - rowsT[r]; if (dt <= 0) continue;
        const ratio = (2 / dpr) / (dt / 1000) / (warp.floor * 1000);
        if (ratio > 1.05) { ctx.fillStyle = `rgba(245,165,36,${Math.min(0.55, Math.log2(ratio) * 0.18)})`; ctx.fillRect(3 * dpr, r, Math.min(3 * dpr, w - 3 * dpr), 2); }
      }
      const g = song.grid, tA = rowsT[0], tB = rowsT[rows];
      ctx.fillStyle = 'rgba(200,204,209,0.35)';
      for (let i = Math.max(0, upperBound(g.beats, tA) - 1); i < g.beats.length && g.beats[i] <= tB; i++) ctx.fillRect(w - 3 * dpr, Math.round(yOf(g.beats[i])), 3 * dpr, 1);
      ctx.font = `${10 * dpr}px "Segoe UI", Arial, sans-serif`; ctx.textBaseline = 'top';
      let lastY = -1e9;
      for (let i = Math.max(0, upperBound(g.downbeats, tA) - 1); i < g.downbeats.length && g.downbeats[i] <= tB; i++) {
        const y = Math.round(yOf(g.downbeats[i]));
        ctx.fillStyle = 'rgba(200,204,209,0.6)'; ctx.fillRect(6 * dpr, y, w, 1);
        if (w >= 22 * dpr && y - lastY >= 11 * dpr) {
          ctx.fillStyle = '#9aa0a8'; ctx.fillText(w >= 40 * dpr ? `${i + 1} ${fmt(g.downbeats[i])}` : `${i + 1}`, 7 * dpr, y + dpr); lastY = y;
        }
      }
      c.drawn = { downbeats: true };
    } },

    // ---------------------------------------------------------------- sections
    { id: 'sections', title: 'section', kind: 'text', w: 54, mode: 'follow', stripColor: '#888',
      build(c) {
        addItems(c, song.sections, (s) => `<div class="sec" data-act="loop" data-sel="section:${esc(s.id)}" data-t0="${num(s.t0)}" data-t1="${num(s.t1)}" title="${esc(store.secLabel(s))} · click: loop this section · ${esc(s.transitions || '')}" style="--sc:${esc(secColor(s.id, 0.9))};--sb:${esc(secColor(s.id, 0.22))}"><b>${esc(store.secLabel(s))}</b><i>E${esc(s.energy)} · W${esc(s.world_pct ?? '?')} · OL ${esc(s.overload_text ?? '')}</i></div>`);
      },
      act(c, a) {
        const t0 = Number(a.dataset.t0), t1 = Number(a.dataset.t1);
        if (tl.loop && tl.loop.t0 === t0) tl.setLoop(null); else { tl.setLoop({ t0, t1 }); tl.seek(t0); }
        for (const x of c.body.querySelectorAll('.sec')) x.classList.toggle('looping', !!tl.loop && Number(x.dataset.t0) === tl.loop.t0);
      } },

    // ---------------------------------------------------------------- lyrics (drives the warp, one item per VISUAL line)
    { id: 'lyrics', title: 'lyrics', kind: 'text', w: 210, mode: 'drive', stripColor: '#c9ccd1',
      build(c) { c.wrapW = -1; c.items = []; },
      prepare(c) {
        const avail = c.vw - 7; // 1 px separator + 2 px voice stripe + 3 px inset + 1 px slack
        if (avail === c.wrapW && c.items.length) return;
        c.wrapW = avail;
        const cv = (this._cv ||= document.createElement('canvas').getContext('2d'));
        cv.font = getComputedStyle(c.body).font || '12px "Segoe UI"';
        const cache = (this._wcache ||= new Map()); if (this._font !== cv.font) { cache.clear(); this._font = cv.font; }
        const W = (s) => { let v = cache.get(s); if (v == null) { v = cv.measureText(s).width; cache.set(s, v); } return v; };
        const sp = W(' ');
        c.body.innerHTML = ''; c.items = []; c.words = []; c.spans = [];
        const frag = document.createDocumentFragment();
        for (const L of song.lines) {
          // greedy wrap with the same font the DOM uses; each visual line is rendered nowrap, so it cannot re-wrap differently
          const groups = []; let cur = [], x = 0;
          L.words.forEach((wd, i) => { const ww = W(wd.w); if (cur.length && x + sp + ww > avail) { groups.push(cur); cur = []; x = 0; } x += (cur.length ? sp : 0) + ww; cur.push(i); });
          if (cur.length) groups.push(cur);
          groups.forEach((g, gi) => {
            const e = el('div', `it vl v-${L.voice}${gi === 0 ? ' l0' : ''}${gi === groups.length - 1 ? ' ll' : ''}`);
            e.dataset.line = L.id; e.dataset.sel = 'line:' + L.id;
            e.innerHTML = g.map(i => { const wd = L.words[i]; return `<span data-act="seek" data-t="${num(wd.t0)}"${wd.p < 0.2 ? ' class="lo"' : ''}>${esc(wd.w)}</span>`; }).join(' ');
            frag.appendChild(e);
            const t0 = L.words[g[0]].t0;
            c.items.push({ t0, el: e, line: L, first: gi === 0 });
            g.forEach((i, k) => { c.words.push(L.words[i]); c.spans.push(e.children[k]); });
          });
        }
        c.body.appendChild(frag);
        c.wT0 = c.words.map(w => w.t0);
        c.dirty = true;
      },
      measure(c) {
        return c.items.map((it, i) => ({ t0: it.t0, t1: i + 1 < c.items.length ? Math.max(c.items[i + 1].t0, it.t0 + 1) : dur, h: LH + (i + 1 < c.items.length && c.items[i + 1].first ? 1 : 0) }));
      },
      tick(c, t) {
        if (!c.wT0) return;
        const i = upperBound(c.wT0, t) - 1;
        const on = i >= 0 && t <= c.words[i].t1 + 120 ? i : -1;
        if (on === c.on) return;
        if (c.on >= 0) c.spans[c.on]?.classList.remove('on');
        if (on >= 0) c.spans[on].classList.add('on');
        c.on = on;
      },
      act: seekAct, gap: 0 },

    // ---------------------------------------------------------------- surface (E2, the lyric gate, js/surfaces.js): per lyric line,
    // its words as they show on screen: a word on a surface (a shot's lyrics[] at the word's time) reads normally, a word
    // on no surface is red. Hover: where it shows. Click a word: seek; double-click: the shot in the storyboard
    { id: 'surface', title: 'surface', kind: 'text', w: 96, mode: 'follow', stripColor: '#e5484d',
      build(c) {
        const cov = coverage(song, store.boardShots()), next = (i) => cov.lines[i + 1]?.t0 ?? dur;
        const list = cov.lines.map((l, i) => ({ t0: num(l.t0), t1: Math.max(num(l.t0) + 1, Math.min(next(i), dur)), l }));
        addItems(c, list, ({ l }) => `<div class="sfl${l.covered === l.n ? ' ok' : ''}" data-line="${esc(l.id)}" title="${esc(`${l.id}: ${l.covered} of ${l.n} words on a surface`)}"><i class="sfn">${l.covered}/${l.n}</i>${l.words.map(w => `<span class="sfw ${w.by.length ? 'on' : 'un'}" data-act="seek" data-t="${num(w.t0)}" title="${esc(w.by.length ? `${w.w}: ${w.by.map(b => `${b.shot} · ${b.where}`).join('\n')}` : `${w.w}: on no surface${w.off ? ` (${w.off.map(b => b.shot).join(', ')} is not on screen then)` : ''}`)}">${esc(w.w)}</span>`).join(' ')}</div>`);
      },
      act: seekAct, refresh: onBoard(),
      dblclick(c, t) { const s = store.boardShots().find(x => x.t0 <= t && t < x.t1); window.WB?.stages?.open('storyboard').then(() => s && window.WB.storyboard?.focus(s.id)); } },

    // ---------------------------------------------------------------- events
    { id: 'events', title: 'events', kind: 'text', w: 90, mode: 'drive', stripColor: '#f5a524',
      build(c) {
        const groups = [];
        for (const e of store.events) { if (e.kind === 'section' || e.kind === 'line') continue; const g = groups[groups.length - 1]; if (g && Math.abs(g.t0 - e.t) < 2) g.list.push(e); else groups.push({ t0: e.t, list: [e] }); }
        addItems(c, groups, (g) => g.list.map(e => `<div class="ev k-${esc(e.kind)}" data-act="seek" data-t="${num(e.t)}" title="${fmt(e.t, true)} ${esc(e.kind)}: ${esc(e.note)}"><i>${ICON[e.kind] || '·'}</i>${esc(e.note || e.id)}</div>`).join(''));
      }, act: seekAct },

    // ---------------------------------------------------------------- waveform (mix)
    { id: 'wave', title: 'mix', kind: 'lane', w: 34, draw(c, env) { gridLines(env); drawPeaks(env, store.peaks.mix, 0, env.w, '#8fa3b8'); } },

    // ---------------------------------------------------------------- stems
    { id: 'stems', title: 'stems', kind: 'lane', w: 64, hidden: true, draw(c, env) {
      // stems without a peaks file are remembered (no refetch every frame) and left out; the others still draw
      c.failed ||= new Set();
      const all = (song.audio?.stems || []).map(s => s.id);
      const missing = all.filter(id => !store.peaks[id] && !c.failed.has(id));
      if (missing.length) { if (!c.loading) { c.loading = true; store.loadPeaks(missing).then(() => { for (const id of missing) if (!store.peaks[id]) c.failed.add(id); c.loading = false; tl.drawLanes(); }); } return; }
      const ids = all.filter(id => store.peaks[id]); if (!ids.length) return;
      gridLines(env);
      const n = ids.length, sw = env.w / n;
      ids.forEach((id, i) => { drawPeaks(env, store.peaks[id], Math.round(i * sw), Math.max(1, Math.round(sw) - (sw > 4 ? 1 : 0)), STEM_COLORS[id]); });
    } },

    // ---------------------------------------------------------------- energy curve (+ target overload ladder)
    { id: 'energy', title: 'energy', kind: 'lane', w: 30, draw(c, env) {
      const { ctx, w, rows, rowsT, dpr, yOf } = env; const E = store.energy, fps = E.fps, rms = E.rms;
      for (let r = 0; r < rows; r++) {
        const f0 = Math.floor(rowsT[r] / 1000 * fps), f1 = Math.max(f0 + 1, Math.ceil(rowsT[r + 1] / 1000 * fps));
        let m = 0; for (let f = f0; f < f1 && f < rms.length; f++) if (rms[f] > m) m = rms[f];
        if (w < 10 * dpr) { ctx.fillStyle = RAMP[Math.min(31, m * 31 | 0)]; ctx.fillRect(0, r, w, 1); }
        else { ctx.fillStyle = RAMP[Math.min(31, 8 + m * 23 | 0)]; ctx.fillRect(0, r, Math.max(1, m * w), 1); }
      }
      if (w >= 8 * dpr) { // target overload 0-10 from the treatment, a ramp per section
        ctx.fillStyle = '#f5a524';
        for (const s of song.sections) { if (!s.overload) continue; const y0 = yOf(s.t0), y1 = yOf(s.t1); if (y1 < 0 || y0 > rows) continue;
          for (let y = Math.max(0, Math.floor(y0)); y < Math.min(rows, y1); y += 2) { const a = (y - y0) / (y1 - y0); const ol = s.overload[0] + (s.overload[1] - s.overload[0]) * a; ctx.fillRect(Math.round(ol / 10 * (w - dpr)), y, dpr, 1); } }
      }
    } },

    // ---------------------------------------------------------------- script (TREATMENT section 2)
    { id: 'script', title: 'script', kind: 'text', w: 230, mode: 'drive', stripColor: '#9db7d6',
      build(c) {
        addItems(c, store.script.lines, (s) => `<div class="sc" data-sel="script:${esc(s.id)}" title="${esc(s.lyric)}"><i class="m m-${esc(String(s.mode ?? '').replace('→', ''))}">${esc(s.mode)}</i><span class="st s-${esc(st('script:' + s.id))}" data-act="st" data-k="script:${esc(s.id)}"></span>${esc(s.action)}</div>`);
      }, act: seekAct, refresh: refreshChips },

    // ---------------------------------------------------------------- scenes (stage 2, scenes.json): the scene on the left,
    // its beats on the right, each at its own time; double-click opens the script stage on that scene
    { id: 'scenes', title: 'scenes', kind: 'text', w: 170, mode: 'follow', stripColor: '#c3b2e8',
      build(c) {
        const doc = store.scenes, v = currentScript(doc), list = [];
        // stage 3 markers: the breakdown items each scene needs (characters first), one compact line under the title
        const bi = (currentBreakdown(store.breakdown)?.items || []).filter(i => !i.dropped).sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind));
        const marks = (id) => { const L = bi.filter(i => i.links.some(l => l.scene === id)); if (!L.length) return ''; const N = L.filter(i => i.kind === 'character' || i.kind === 'location').slice(0, 3); return `<em class="scbd" title="${esc(L.map(i => `${i.kind}: ${i.name}`).join('\n'))}">${N.map(i => `<i style="color:${KIND_COLOR[i.kind]}">${esc(i.name)}</i>`).join(' ')}${L.length > N.length ? ` +${L.length - N.length}` : ''}</em>`; };
        for (const s of v?.scenes || []) {
          list.push({ t0: s.t0, t1: s.t1, s, k: 0 });
          s.beats.forEach((b, i) => list.push({ t0: b.t, t1: Math.max(b.t + 1, s.beats[i + 1]?.t ?? s.t1), b, s, k: 1 }));
        }
        list.sort((a, b) => a.t0 - b.t0 || a.k - b.k);
        addItems(c, list, (x) => x.b
          ? `<div class="scb" data-act="seek" data-t="${num(x.b.t)}" data-sel="scene:${esc(x.s.id)}" title="${fmt(x.b.t, true)} · ${esc(x.s.id)}/${esc(x.b.id)}: ${esc(x.b.text)}">${esc(x.b.text) || '·'}</div>`
          : `<div class="scn s-${esc(sceneStatus(doc, x.s.id))}" data-act="seek" data-t="${num(x.s.t0)}" data-sel="scene:${esc(x.s.id)}" title="${esc(x.s.id)} · ${fmt(x.s.t0, true)}–${fmt(x.s.t1, true)} · ${esc(x.s.title)}\n${esc(x.s.text)}\n(double-click: open in the script stage)"><b>${esc(x.s.title || x.s.id)}</b>${x.s.sketches.length ? `<i>✎${x.s.sketches.length}</i>` : ''}${marks(x.s.id)}<span>${esc(x.s.text)}</span></div>`, 'scit');
        c.items.forEach((it) => it.el.classList.add(it.x.b ? 'beat' : 'scene'));
      },
      act: seekAct,
      refresh(c, what) { if (what !== 'scenes' && what !== 'breakdown') return false; this.build(c); return true; },
      dblclick(c, t) { const s = currentScript(store.scenes)?.scenes.find(x => x.t0 <= t && t < x.t1); window.WB?.stages?.open('script').then(() => s && window.WB.script?.focus(s.id)); } },

    // ---------------------------------------------------------------- shots (the storyboard: frame sketch, else the render frame)
    { id: 'shots', title: 'shots', kind: 'text', w: 104, mode: 'follow', stripColor: '#c9ccd1',
      build(c) {
        addItems(c, store.boardShots(), (s) => { const src = frameSrc(s), g = s.gen || (s.thumb ? '' : shotEstimate(s).gen);
          return `<div class="shot k-${esc(s.kind)}${s.sketch ? ' skf' : ''}" data-act="seek" data-sel="shot:${esc(s.id)}" data-t="${num(s.t0)}" title="${esc(s.id)}${s.scene ? ' · ' + esc(s.scene) : ''} · ${esc(s.kind)}${g ? ' · ' + g : ''} · ${fmt(s.t0, true)}–${fmt(s.t1, true)} · ${esc(s.title || s.text || '')}${s.camera ? '\ncamera: ' + esc(s.camera) : ''}"><div class="cap">${chip('shot:' + s.id, '')}<b>${esc(s.id)}</b> <i>${esc(s.kind)}</i></div>${src ? `<img loading="lazy" src="${esc(src)}" alt="">` : `<span class="nofr">${esc(s.title || s.text || 'no frame')}</span>`}</div>`; });
      }, act: seekAct, refresh: onBoard(refreshChips),
      dblclick(c, t) { if (!tl.player.video) tl.player.toggleVideo(); tl.seek(t); } },

    // ---------------------------------------------------------------- world clips (EDL uses: clip, take, in-point) + the picked takes
    // a storyboard shot with a picked take (shot.clip, D6) shows it over the shot's time: ★ take, in–out, its frame; the
    // EDL uses that shot lists are then hidden (the pick supersedes them)
    { id: 'clips', title: 'world clips', kind: 'text', w: 76, mode: 'follow', stripColor: '#93c2a2',
      build(c) {
        const picked = store.boardShots().filter(s => s.clip?.file), hide = new Set(picked.flatMap(s => s.clips || []));
        const items = [...store.uses.filter(u => !hide.has(u.id)), ...picked.map(s => ({ pick: true, s, id: s.id, t0: s.t0, t1: s.t1 }))].sort((a, b) => a.t0 - b.t0 || a.t1 - b.t1);
        // pack overlapping uses into sub-lanes, per overlap cluster (a lone clip keeps the full width)
        const list = []; let cluster = [], cEnd = -1, lanes = [];
        const flush = () => { for (const u of cluster) u.nLanes = lanes.length; cluster = []; lanes = []; };
        for (const u0 of items) {
          if (u0.t0 >= cEnd) { flush(); cEnd = -1; }
          let k = lanes.findIndex(end => end <= u0.t0); if (k < 0) { k = lanes.length; lanes.push(0); } lanes[k] = u0.t1;
          const u = { ...u0, lane: k }; cluster.push(u); list.push(u); cEnd = Math.max(cEnd, u0.t1);
        }
        flush();
        const pickHtml = ({ s }) => { const k = s.clip, m = store.mediaById?.[k.media] || store.mediaByPath?.[k.file], nm = `${k.request || m?.job || 'take'}.${k.take ?? '?'}`;
          return `<div class="use pick" data-act="seek" data-sel="shot:${esc(s.id)}" data-t="${num(s.t0)}" title="${esc(`${s.id}: picked take ${nm} (${k.file})${k.out_ms != null ? ` · in ${(k.in_ms / 1000).toFixed(2)} s → out ${(k.out_ms / 1000).toFixed(2)} s` : ' · still'} · ${fmt(s.t0, true)}–${fmt(s.t1, true)}${k.note ? '\n' + k.note : ''}${(k.alt || []).length ? '\n' + k.alt.map(a => `alt for ${fmt(a.t, true)}: ${a.note}`).join('\n') : ''}`)}"><div class="cap"><b>★${k.request || m?.job ? 't' + esc(k.take ?? '?') : esc(nm)}</b> <i>${k.out_ms != null ? `${(k.in_ms / 1000).toFixed(1)}–${(k.out_ms / 1000).toFixed(1)}` : 'still'}</i>${(k.alt || []).length ? `<i class="alt">+${k.alt.length}</i>` : ''}</div>${m?.thumb ? `<img loading="lazy" src="${esc(mediaUrl(m.thumb))}" alt="">` : ''}</div>`; };
        addItems(c, list, (u) => u.pick ? pickHtml(u) : `<div class="use loc-${esc(u.location)}" data-act="seek" data-sel="use:${esc(u.id)}" data-t="${num(u.t0)}" title="${esc(u.clip)} take ${esc(u.take)} · in ${(num(u.in_ms) / 1000).toFixed(2)} s · ${fmt(u.t0, true)}–${fmt(u.t1, true)} · ${esc(u.label)}"><div class="cap">${chip('use:' + u.id, '')}<b>${esc(u.clip)}</b>.${esc(u.take)} <i>+${(num(u.in_ms) / 1000).toFixed(1)}</i></div><img loading="lazy" src="${esc(mediaUrl(u.thumb))}" alt=""></div>`);
        c.items.forEach((it) => { it.el.style.left = `${it.x.lane / it.x.nLanes * 100}%`; it.el.style.width = `${100 / it.x.nLanes}%`; it.el.style.right = 'auto'; });
      }, act: seekAct, refresh: onBoard(refreshChips) },

    // ---------------------------------------------------------------- cast per shot
    { id: 'cast', title: 'cast', kind: 'text', w: 40, mode: 'follow', stripColor: '#ff7ab8',
      build(c) {
        addItems(c, shotSpans(), ({ s }) => (s.cast || []).map(id => { const e = store.entityById[id]; const lab = e?.short || String(e?.name || id).split(/[\s·-]+/).filter(Boolean).map(w => w[0]).join('').slice(0, 2).toUpperCase(); return `<span class="cast" data-id="${esc(id)}" style="--cc:${cssColor(e?.color)}" title="${esc(e?.name || id)}: ${esc(e?.role || '')}">${esc(lab)}</span>`; }).join('') + (s.locations?.length ? `<span class="loc" title="${esc(s.locations.join(', '))}">${esc(s.locations.map(short).join(''))}</span>` : ''));
      }, refresh: onBoard() },

    // ---------------------------------------------------------------- status / approval per shot (+ the clip uses in it)
    { id: 'status', title: 'status', kind: 'text', w: 60, mode: 'follow', stripColor: '#7fbf8f',
      build(c) {
        addItems(c, shotSpans(), ({ s }) => chip('shot:' + s.id, s.id.replace(/^c\d-/, '')) + (s.clips || []).map(u => chip('use:' + u, String(u).split('@')[0])).join(''));
      }, act: seekAct, refresh: onBoard(refreshChips) },

    // ---------------------------------------------------------------- cost
    { id: 'cost', title: 'cost $', kind: 'text', w: 80, mode: 'drive', hidden: true, stripColor: '#cfae80',
      build(c) {
        const groups = []; let run = 0;
        for (const x of store.costs.items) { run += num(x.usd); const g = groups[groups.length - 1]; if (g && g.t0 === x.t) { g.list.push(x); g.run = run; } else groups.push({ t0: x.t, list: [x], run }); }
        addItems(c, groups, (g) => g.list.map(x => `<div class="cost" data-act="seek" data-t="${num(g.t0)}" title="${esc(x.tool)} ${esc(x.date)}"><b>${num(x.usd).toFixed(2)}</b> ${esc(x.id)}</div>`).join('') + `<div class="run">Σ ${num(g.run).toFixed(2)} / ${esc(store.costs.cap_usd)}</div>`);
      }, act: seekAct },

    // ---------------------------------------------------------------- notes (notes.json v2, js/notes.js): every note with a
    // song time sits at its time: the timeline's own, and the stages' notes on a lyric line, a scene, a beat or a shot
    // (tagged with their stage). Click an empty spot of the column (or right-click > + Add > + note at this time) to type
    // a note at that ms: Enter saves, Esc cancels. The dot: done (absorbed) / reopen.
    { id: 'notes', title: 'notes', kind: 'text', w: 180, mode: 'drive', stripColor: '#f5a524',
      build(c) {
        const ctx = { song, scenes: currentScript(store.scenes)?.scenes || [], shots: store.boardShots() };
        const list = store.notes.notes.filter(n => n.status !== 'dismissed').map(n => ({ n, t0: noteTime(n, ctx) })).filter(x => x.t0 != null).sort((a, b) => a.t0 - b.t0);
        addItems(c, list, ({ n }) => `<div class="note n-${esc(n.status)} ${n.via === 'agent' ? 'ag' : 'dr'}${n.target.stage !== 'timeline' ? ' other' : ''}${n.to === 'agent' ? ' ask' : ''}" data-sel="note:${esc(n.id)}" title="${esc(`${n.id} · ${n.via === 'agent' ? 'agent' : 'director'} · ${n.status}${n.target.stage !== 'timeline' ? ` · ${STAGE_TITLE[n.target.stage]} ${n.target.kind} ${n.target.id || ''}` : ''}`)}"><span class="nst" data-act="nt" data-id="${esc(n.id)}" title="${n.status === 'open' ? 'open (click: done)' : 'done (click: reopen)'}">●</span>${n.target.stage !== 'timeline' ? `<i class="nstg" data-act="ngo" data-stage="${esc(n.target.stage)}" title="a note in ${esc(STAGE_TITLE[n.target.stage])}: open the stage">${esc(STAGE_TITLE[n.target.stage].slice(0, 3).toLowerCase())}</i>` : ''}${n.to === 'agent' ? '<i class="nask">→ agent</i>' : ''}${esc(n.text)}${(n.replies || []).map(r => `<div class="nrep ${r.via === 'agent' ? 'ag' : 'dr'}">${esc(r.text)}</div>`).join('')}</div>`);
      },
      act(c, a) { if (a.dataset.act === 'nt') store.toggleNote(a.dataset.id); if (a.dataset.act === 'ngo') window.WB?.stages?.open(a.dataset.stage); },
      refresh(c, what) { if (what !== 'notes' && what !== 'scenes' && what !== 'board') return false; this.build(c); return true; },
      // a click on an empty spot of the column: a new note at that time
      click(c, t, e) { if (e.target.closest('.it') || e.shiftKey) return false; this.editAt(c, t, e.clientY); return true; },
      dblclick(c, t, e) { if (!e.target.closest('.it')) this.editAt(c, t, e.clientY); },
      editAt(c, t, clientY) {
        document.querySelector('.noteedit')?.remove();
        t = Math.max(0, Math.min(dur, Math.round(t)));
        const ta = el('textarea', 'noteedit'); ta.placeholder = `note at ${fmt(t, true)} (Enter saves · Esc cancels · @agent asks the agent)`; ta.spellcheck = false;
        const r = c.el.getBoundingClientRect(), y = clientY ?? (tl.sheet.getBoundingClientRect().top + tl.warp.y(t));
        Object.assign(ta.style, { left: r.left + 'px', top: Math.max(r.top, Math.min(innerHeight - 64, y)) + 'px', width: Math.max(170, c.vw) + 'px' });
        document.body.appendChild(ta); ta.focus();
        const line = song.lines[Math.max(0, upperBound(song.lines.map(l => l.t0), t + 1) - 1)];
        const save = () => { let v = ta.value.trim(); ta.remove(); if (!v) return; const ask = /^@agent\b/i.test(v); if (ask) v = v.replace(/^@agent\b[:,]?\s*/i, ''); if (v) store.addNote(t, v, line && t <= line.t1 + 2000 ? line.id : null, ask ? { to: 'agent' } : {}); };
        ta.addEventListener('keydown', (ev) => {
          ev.stopPropagation();
          if (ev.key === 'Escape') ta.remove();
          if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); save(); }
        });
        ta.addEventListener('blur', () => setTimeout(() => { if (ta.isConnected) save(); }, 100));
        return ta;
      } },
  ];

  // faint downbeat lines inside audio lanes: they make the warp visible (evenly spaced bars spread where text is dense)
  function gridLines(env) {
    const { ctx, w, rows, rowsT, yOf } = env; const g = song.grid.downbeats;
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    for (let i = Math.max(0, upperBound(g, rowsT[0]) - 1); i < g.length && g[i] <= rowsT[rows]; i++) ctx.fillRect(0, Math.round(yOf(g[i])), w, 1);
  }
}

// min/max pyramid (5 ms, 20, 80, 320, 1280 ms bins) built on first use
function level(p, k) {
  p.levels ||= [{ min: p.min, max: p.max }];
  while (p.levels.length <= k) {
    const prev = p.levels[p.levels.length - 1], n = Math.ceil(prev.min.length / 4);
    const mn = new Int8Array(n), mx = new Int8Array(n);
    for (let i = 0; i < n; i++) { let a = 127, b = -127; for (let j = i * 4; j < i * 4 + 4 && j < prev.min.length; j++) { if (prev.min[j] < a) a = prev.min[j]; if (prev.max[j] > b) b = prev.max[j]; } mn[i] = a; mx[i] = b; }
    p.levels.push({ min: mn, max: mx });
  }
  return p.levels[k];
}

// one horizontal bar per device row: amplitude runs across the lane, time runs down through t(y)
export function drawPeaks(env, p, x0, w, color) {
  if (!p) return;
  const { ctx, rows, rowsT, dpr } = env;
  const narrow = w < 10 * dpr, half = w / 2, cx = x0 + half;
  if (!narrow) ctx.fillStyle = color;
  for (let r = 0; r < rows; r++) {
    const t0 = rowsT[r], t1 = rowsT[r + 1];
    const bins = (t1 - t0) / p.binMs;
    const k = bins > 4 ? Math.min(4, Math.floor(Math.log(bins) / Math.log(4))) : 0;
    const L = level(p, k), size = p.binMs * Math.pow(4, k);
    let i0 = Math.floor(t0 / size), i1 = Math.max(i0 + 1, Math.ceil(t1 / size));
    if (i0 >= L.min.length) break;
    i1 = Math.min(i1, L.min.length);
    let a = 127, b = -127;
    for (let i = i0; i < i1; i++) { if (L.min[i] < a) a = L.min[i]; if (L.max[i] > b) b = L.max[i]; }
    if (narrow) { const lv = Math.max(-a, b) / 127; ctx.fillStyle = RAMP[Math.min(31, lv * 31 | 0)]; ctx.fillRect(x0, r, w, 1); }
    else { const xa = cx + a / 127 * half, xb = cx + b / 127 * half; ctx.fillRect(xa, r, Math.max(1, xb - xa), 1); }
  }
}
