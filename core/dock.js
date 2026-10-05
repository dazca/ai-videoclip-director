// Preview dock (Part B, SPEC v2 section 7). A small box in a corner (bottom-right by default) that shows whatever is
// relevant: the rendered film synced to the playhead (Film), the hovered/selected shot, clip at its in-point, image,
// take comparison side by side, a character / location / prop sheet, or a media file. Pin keeps a source.
// Toggle P · drag the title to any corner · drag the grip to resize · ⧉ pops it out to its own window (dock.html),
// kept in sync over a BroadcastChannel · geometry remembered in localStorage.
//   WB.dock.open() / close() / toggle() / isOpen() / show(source) / el / body   (interface from Part A, kept)
//   WB.dock.hover(source) / unhover() / film() / pin(on?) / popout() / setCorner(c) / current() / mode()
//   source = { kind: 'film'|'shot'|'use'|'compare'|'ab'|'media'|'entity'|'look'|'image'|'video', id?, src?, title?, t?, in_ms? }
//            'ab' = two takes side by side in lockstep (D6 take selection): {kind: 'ab', a, b (media ids), ain, aout, bin, bout (ms)}
//            (Part A's item.preview sends {kind:'clip'|'shot'|'entity', title, src}: resolved by id / name)
import { store, mediaUrl, prefs, PROJECT, isPrivatePath } from '../js/store.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
const fmt = (ms) => { const s = Math.max(0, ms) / 1000, m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(2).padStart(5, '0')}`; };
const FILM = { kind: 'film' };
const CORNERS = ['br', 'bl', 'tr', 'tl'];
const STANDALONE = !!window.WB_DOCK_STANDALONE || document.body.classList.contains('dockwin');   // dock.html (no inline script: CSP)
let chan = null; try { chan = new BroadcastChannel('wb-dock-' + PROJECT); } catch (e) { /* old browser */ }

// ------------------------------------------------------------------ source helpers (plain, serialisable objects)
export function normalize(s) {
  if (!s) return null;
  s = { ...s };
  if (s.kind === 'clip' && !s.id) { const u = store.uses?.find(x => x.id === s.title); if (u) { s.kind = 'use'; s.id = u.id; } }
  if (s.kind === 'clip' && s.id && !store.uses?.some(x => x.id === s.id)) { s.kind = 'compare'; }
  if (s.kind === 'shot' && !s.id) s.id = store.shots?.find(x => x.id === s.title)?.id;
  if (s.kind === 'entity' && !s.id) s.id = store.entities.find(e => e.name === s.title || e.thumb === s.src)?.id;
  if (s.kind === 'media' && !s.id && s.src) s.id = store.mediaByPath[s.src]?.id;
  if (!s.kind && s.src) s.kind = /\.(mp4|webm)$/i.test(s.src) ? 'video' : 'image';
  return s;
}
export function sourceFromKey(key) {           // "use:G05@20158", "shot:c1-desk", "media:I5_0_0", "entity:dani", "compare:G05", "look:dani/office-day"
  if (!key) return null;
  const i = key.indexOf(':'); const k = key.slice(0, i), id = key.slice(i + 1);
  if (['character', 'location', 'prop'].includes(k)) return { kind: 'entity', id };
  return { kind: k, id };
}
const sig = (s) => JSON.stringify(s || FILM);
export function titleOf(s) {
  if (!s || s.kind === 'film') return 'film · ' + (store.song?.audio?.render || '').split('/').pop();
  if (s.title && s.kind !== 'use' && s.kind !== 'shot') return s.title;
  if (s.kind === 'use') { const u = store.uses.find(x => x.id === s.id); return u ? `${u.clip}.${u.take} +${(u.in_ms / 1000).toFixed(2)} s · ${fmt(u.t0)}` : s.id; }
  if (s.kind === 'shot') { const x = store.shots.find(y => y.id === s.id); return x ? `${x.id} · ${fmt(x.t0)}–${fmt(x.t1)}` : s.id; }
  if (s.kind === 'compare') return `${s.id}: takes side by side`;
  if (s.kind === 'ab') return `A/B · ${store.mediaById[s.a]?.label || s.a} | ${store.mediaById[s.b]?.label || s.b}`;
  if (s.kind === 'media') { const m = store.mediaById[s.id]; return m ? m.label : s.id; }
  if (s.kind === 'entity') return store.entityById?.[s.id]?.name || s.id;
  if (s.kind === 'look') { const [e, l] = s.id.split('/'); return `${store.entityById?.[e]?.name || e} · ${store.entityById?.[e]?.looks?.find(x => x.id === l)?.name || l}`; }
  return s.src?.split('/').pop() || s.kind;
}
const thumbOf = (p) => { const m = store.mediaByPath[p]; return m?.thumb || p; };
const lock = (p) => isPrivatePath(p) ? '<i class="lock" title="private: crop of a real photo, local only, never exported">🔒</i>' : '';
function vid(src, { from = 0, to = null, cls = '', packed = false, autoplay = true } = {}) {
  from = Number(from) || 0; to = to == null ? null : Number(to) || null;   // sources may come from POST /api/ui: numbers only
  const v = `<video class="${cls}" src="${esc(mediaUrl(src))}#t=${(from / 1000).toFixed(2)}" data-from="${from}" ${to ? `data-to="${to}"` : ''} muted playsinline ${autoplay ? 'autoplay' : ''} loop preload="auto"></video>`;
  return packed ? `<div class="pk">${v}</div>` : v;
}
function img(p, cls = '') { return `<div class="im ${cls}">${lock(p)}<img src="${esc(mediaUrl(p))}" alt="" loading="lazy"></div>`; }

// ------------------------------------------------------------------ renderers: source -> html
function renderSource(s) {
  if (!s || s.kind === 'film') return `<video class="film" src="${esc(mediaUrl(store.song?.audio?.render))}" muted playsinline preload="auto"></video><span class="tc"></span>`;
  if (s.kind === 'shot') {
    const x = store.shots.find(y => y.id === s.id); if (!x) return miss(s);
    return vid(store.song.audio.render, { from: x.t0, to: x.t1 }) + `<span class="cap">${esc(x.id)} · ${esc(x.kind)} · ${esc(x.title.slice(0, 80))}</span>`;
  }
  if (s.kind === 'use') {
    const u = store.uses.find(y => y.id === s.id); if (!u) return miss(s);
    return vid(u.file, { from: u.in_ms, to: u.in_ms + Math.max(600, u.t1 - u.t0) }) + `<span class="cap">${esc(u.clip)}.${esc(u.take)} in ${(u.in_ms / 1000).toFixed(2)} s · ${esc(u.label || '')}</span>`;
  }
  if (s.kind === 'compare') {
    const takes = store.media.filter(m => m.kind === 'clip' && m.job === s.id).sort((a, b) => a.take - b.take);
    if (!takes.length) return miss(s);
    const using = new Set(store.uses.filter(u => u.clip === s.id).map(u => u.take));
    const from = s.in_ms ?? store.uses.find(u => u.clip === s.id)?.in_ms ?? 0;
    return `<div class="cmp n${takes.length}">${takes.map(m => `<div class="ct${using.has(m.take) ? ' on' : ''}" data-media="${esc(m.id)}">${vid(m.path, { from, to: from + 2500, cls: 'sync' })}<b>take ${esc(m.take)}${using.has(m.take) ? ' · in use' : ''}</b></div>`).join('')}</div>`;
  }
  if (s.kind === 'ab') {
    const side = (id, from, to, k) => { const m = store.mediaById[id]; if (!m) return `<div class="ct"><span class="dim">no ${esc(k)}</span></div>`; const isV = /\.(mp4|webm|mov)$/i.test(m.path);
      return `<div class="ct" data-media="${esc(m.id)}">${isV ? vid(m.path, { from, to, cls: 'sync' }) : img(m.path)}<b>${esc(k)} · ${esc(m.job != null ? `${m.job}.${m.take ?? '?'}` : m.label)}${isV && to ? ` · ${(from / 1000).toFixed(2)}–${(to / 1000).toFixed(2)} s` : ''}</b></div>`; };
    return `<div class="cmp n2 ab">${side(s.a, Number(s.ain) || 0, s.aout == null ? null : Number(s.aout), 'A')}${side(s.b, Number(s.bin) || 0, s.bout == null ? null : Number(s.bout), 'B')}</div>`;
  }
  if (s.kind === 'media') {
    const m = store.mediaById[s.id]; if (!m) return miss(s);
    const isV = /\.(mp4|webm)$/i.test(m.path), isA = /\.(wav|mp3|m4a)$/i.test(m.path);
    const body = isA ? `<div class="au"><img src="${esc(mediaUrl(m.thumb))}" alt=""><audio src="${esc(mediaUrl(m.path))}" controls preload="none"></audio></div>`
      : isV ? vid(m.path, { packed: !!m.packed_alpha }) : img(m.path);
    return body + `<span class="cap">${lock(m.path)}${esc(m.label)} · ${esc(m.kind)}${m.duration_ms ? ' · ' + (m.duration_ms / 1000).toFixed(1) + ' s' : ''}${m.shots?.length ? ' · ' + m.shots.length + ' shots' : ''}</span>`;
  }
  if (s.kind === 'entity') return renderEntity(store.entityById?.[s.id]) || miss(s);
  if (s.kind === 'look') {
    const [eid, lid] = s.id.split('/'); const e = store.entityById?.[eid]; const l = e?.looks?.find(x => x.id === lid); if (!l) return miss(s);
    return `<div class="sheet">${(l.images || []).slice(0, 6).map(p => img(thumbOf(p))).join('')}</div><span class="cap">${esc(l.name)} · ${esc((l.garments || []).join(', '))}</span>`;
  }
  if (s.kind === 'video' || /\.(mp4|webm)$/i.test(s.src || '')) return vid(s.src, { from: s.in_ms || 0 });
  if (s.src) return img(s.src);
  return miss(s);
}
const miss = (s) => `<div class="dim">nothing to show for ${esc(JSON.stringify(s))}</div>`;
function renderEntity(e) {
  if (!e) return '';
  if (e.kind === 'character') {
    const sheets = Object.values(e.sheets || {}).flat().slice(0, 3);
    const looks = (e.looks || []).slice(0, 8);
    const face = e.face || e.thumb, body = e.body;
    return `<div class="sheet ent">${face ? img(thumbOf(face), 'face') : ''}${body ? img(thumbOf(body), 'body') : ''}${sheets.map(p => img(thumbOf(p), 'sh')).join('')}
      ${looks.length ? `<div class="lk">${looks.map(l => `<div title="${esc(l.name)}">${l.images?.[0] ? `<img src="${esc(mediaUrl(thumbOf(l.images[0])))}" alt="">` : ''}<i>${esc(l.name)}</i></div>`).join('')}</div>` : ''}</div>
      <span class="cap">${esc(e.name)} · ${esc(e.identity || e.role || '')}</span>`;
  }
  if (e.kind === 'location') return `<div class="sheet loc">${img(thumbOf(e.establishing || e.refs?.[0]), 'est')}${(e.images || []).slice(1, 7).map(x => img(thumbOf(x.path))).join('')}</div><span class="cap">${esc(e.name)} · ${(e.images || []).length} images · ${(e.clips || []).length} clips</span>`;
  return `<div class="sheet loc">${img(thumbOf(e.hero || e.refs?.[0]), 'est')}${(e.images || []).slice(1, 5).map(x => img(thumbOf(x.path))).join('')}</div><span class="cap">${esc(e.name)} · ${esc(e.description || '')}</span>`;
}

// ------------------------------------------------------------------ the dock
export const dock = {
  el: null, body: null,
  source: null,          // shown/pinned source (null = film)
  hoverSrc: null,        // temporary (hover), wins unless pinned
  pinned: false, popped: null, shownSig: null, raf: 0, lastT: -1, lastPlaying: false,
  geo: Object.assign({ corner: 'br', w: 400, h: 250 }, prefs.get('dockGeo', {})),

  current() { return (!this.pinned && this.hoverSrc) || this.source || FILM; },
  mode() { const c = this.current(); return c.kind === 'film' ? 'film' : this.pinned ? 'pin' : 'hover'; },
  ensure() {
    if (this.el) return;
    const el = document.createElement('div'); el.className = 'dock' + (STANDALONE ? ' solo' : '');
    el.innerHTML = `<div class="dh"><span class="dt" title="drag to another corner">preview</span><span class="dbt"><b data-x="film" title="Film: the render at the playhead">film</b><b data-x="pin" title="pin this source">pin</b>${STANDALONE ? '' : '<b data-x="pop" title="pop out to its own window">⧉</b><b data-x="close" title="P">×</b>'}</span></div><div class="db"></div>${STANDALONE ? '' : '<i class="grip" title="resize"></i>'}`;
    el.querySelector('.dbt').addEventListener('click', (e) => {
      const x = e.target.closest('[data-x]')?.dataset.x;
      if (x === 'close') this.close(); if (x === 'film') this.film(); if (x === 'pin') this.pin(); if (x === 'pop') this.popout();
    });
    this.el = el; this.body = el.querySelector('.db');
    if (!STANDALONE) { this.applyGeo(); this.wireDrag(); }
    this.render();
  },
  isOpen() { return !!this.el?.isConnected; },
  open() {
    if (this.popped && !this.popped.closed) { this.popped.focus(); return; }
    this.ensure(); if (!this.isOpen()) document.body.appendChild(this.el);
    prefs.set('dock', true); this.render(true); this.loop();
    document.dispatchEvent(new CustomEvent('wb:dock', { detail: true }));
  },
  close() {
    if (this.popped && !this.popped.closed) { this.popped.close(); this.popped = null; }
    this.el?.remove(); cancelAnimationFrame(this.raf); this.raf = 0; this.shownSig = null;
    prefs.set('dock', false); document.dispatchEvent(new CustomEvent('wb:dock', { detail: false }));
  },
  toggle() { (this.isOpen() || (this.popped && !this.popped.closed)) ? this.close() : this.open(); },
  show(source) { this.source = normalize(source); if (this.source?.kind === 'film') this.source = null; this.pinned = !!this.source; this.hoverSrc = null; this.post({ type: 'src', source: this.source, pinned: this.pinned }); if (this.popped && !this.popped.closed) return; this.open(); this.render(); },
  hover(source) { if (this.pinned) return; this.hoverSrc = normalize(source); this.post({ type: 'hover', source: this.hoverSrc }); this.render(); },
  unhover() { if (!this.hoverSrc) return; this.hoverSrc = null; this.post({ type: 'hover', source: null }); this.render(); },
  film() { this.source = null; this.hoverSrc = null; this.pinned = false; this.post({ type: 'src', source: null, pinned: false }); this.render(); },
  pin(on) { const want = on ?? !this.pinned; if (want) { this.source = this.current().kind === 'film' ? null : this.current(); this.pinned = !!this.source; } else this.pinned = false; this.hoverSrc = null; this.post({ type: 'src', source: this.source, pinned: this.pinned }); this.render(); },

  render(force) {
    if (!this.body) return;
    const cur = this.current(), s = sig(cur);
    this.el.dataset.mode = this.mode();
    this.el.querySelector('.dt').textContent = titleOf(cur);
    this.el.querySelector('[data-x=pin]').classList.toggle('on', this.pinned);
    this.el.querySelector('[data-x=film]').classList.toggle('on', cur.kind === 'film');
    if (s === this.shownSig && !force) return;
    this.shownSig = s;
    for (const v of this.body.querySelectorAll('video')) { v.pause(); v.removeAttribute('src'); v.load(); }   // release the decoder
    this.body.innerHTML = renderSource(cur);
    this.wireVideos();
    if (cur.kind === 'film') { this.lastT = -1; this.syncFilm(true); }
  },
  wireVideos() {
    // loop each preview video between data-from and data-to; the compare grid plays its takes in lockstep
    const vs = [...this.body.querySelectorAll('video:not(.film)')];
    for (const v of vs) {
      const from = Number(v.dataset.from || 0) / 1000, to = v.dataset.to ? Number(v.dataset.to) / 1000 : null;
      v.addEventListener('loadedmetadata', () => { if (from && Math.abs(v.currentTime - from) > 0.05) v.currentTime = Math.min(from, Math.max(0, v.duration - 0.1)); v.play().catch(() => {}); }, { once: true });
      if (to) v.addEventListener('timeupdate', () => { if (v.currentTime >= Math.min(to, v.duration - 0.05)) { v.currentTime = from; if (v.classList.contains('sync')) for (const o of vs) if (o !== v) o.currentTime = Number(o.dataset.from || 0) / 1000; } });
    }
  },
  // the Film follows the playhead: exact seek on every change while paused, drift correction while playing
  playhead() {
    if (STANDALONE) return window.WB_DOCK_CLOCK?.() || { t: 0, playing: false };
    const p = window.WB?.timeline?.player; return p ? { t: p.time(), playing: p.playing } : { t: 0, playing: false };
  },
  syncFilm(force) {
    const v = this.body?.querySelector('video.film'); if (!v) return;
    const { t, playing } = this.playhead();
    if (playing) {
      if (v.paused) v.play().catch(() => {});
      const d = t - v.currentTime * 1000;                       // + = the video is behind the playhead
      if (force || Math.abs(d) > 250) { v.currentTime = t / 1000; v.playbackRate = 1; }
      else v.playbackRate = Math.abs(d) < 4 ? 1 : 1 + Math.max(-0.12, Math.min(0.12, d / 400));   // glide back within a frame
    } else {
      if (!v.paused) { v.pause(); v.playbackRate = 1; }
      if (force || t !== this.lastT) v.currentTime = t / 1000;
    }
    this.lastT = t;
    const tc = this.body.querySelector('.tc'); if (tc) tc.textContent = fmt(t);
  },
  loop() {
    if (this.raf) return;
    const tick = () => {
      this.raf = 0;
      if (!this.isOpen() && !(this.popped && !this.popped.closed)) return;
      const { t, playing } = this.playhead();
      if (this.isOpen() && this.current().kind === 'film') this.syncFilm(false);
      if (this.popped && (t !== this.lastPostT || playing !== this.lastPlaying)) { this.post({ type: 't', t, playing }); this.lastPostT = t; this.lastPlaying = playing; }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  },

  // ---- geometry: corner + size, drag the title to a corner, grip resizes
  applyGeo() {
    const g = this.geo, st = this.el.style, top = document.body.classList.contains('notop') ? 0 : 18;
    st.left = st.right = st.top = st.bottom = '';
    st.width = Math.max(200, Math.min(innerWidth - 20, g.w)) + 'px'; st.height = Math.max(120, Math.min(innerHeight - 40, g.h)) + 'px';
    if (g.corner[0] === 't') st.top = top + 'px'; else st.bottom = '0px';
    if (g.corner[1] === 'l') st.left = '0px'; else st.right = '0px';
    this.el.dataset.corner = g.corner;
  },
  setCorner(c) { if (!CORNERS.includes(c)) return; this.geo.corner = c; prefs.set('dockGeo', this.geo); if (this.el) this.applyGeo(); },
  wireDrag() {
    const head = this.el.querySelector('.dt'), grip = this.el.querySelector('.grip');
    head.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return; e.preventDefault();
      const r = this.el.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
      const move = (ev) => { const st = this.el.style; st.right = st.bottom = ''; st.left = (ev.clientX - dx) + 'px'; st.top = (ev.clientY - dy) + 'px'; };
      const up = (ev) => {
        removeEventListener('pointermove', move); removeEventListener('pointerup', up);
        const cx = ev.clientX - dx + r.width / 2, cy = ev.clientY - dy + r.height / 2;
        this.setCorner((cy < innerHeight / 2 ? 't' : 'b') + (cx < innerWidth / 2 ? 'l' : 'r'));
      };
      addEventListener('pointermove', move); addEventListener('pointerup', up);
    });
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault(); const x0 = e.clientX, y0 = e.clientY, w0 = this.el.offsetWidth, h0 = this.el.offsetHeight, c = this.geo.corner;
      const move = (ev) => {
        this.geo.w = w0 + (c[1] === 'r' ? x0 - ev.clientX : ev.clientX - x0);
        this.geo.h = h0 + (c[0] === 'b' ? y0 - ev.clientY : ev.clientY - y0);
        this.applyGeo();
      };
      const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); this.geo.w = this.el.offsetWidth; this.geo.h = this.el.offsetHeight; prefs.set('dockGeo', this.geo); };
      addEventListener('pointermove', move); addEventListener('pointerup', up);
    });
    addEventListener('resize', () => this.isOpen() && this.applyGeo());
    document.addEventListener('wb:topbar', () => this.isOpen() && this.applyGeo());
  },

  // ---- pop-out: dock.html in its own window, synced over BroadcastChannel (time, source, hover)
  popout() {
    const g = prefs.get('dockPopGeo', { w: 640, h: 380 });
    const w = window.open(`dock.html?project=${encodeURIComponent(PROJECT)}`, 'wb-dock-' + PROJECT, `popup=yes,width=${g.w},height=${g.h}`);
    if (!w) return;
    this.popped = w;
    this.el?.remove(); this.shownSig = null;
    const hello = () => this.post({ type: 'state', source: this.source, pinned: this.pinned, hover: this.hoverSrc, ...this.playhead() });
    setTimeout(hello, 400); setTimeout(hello, 1500);
    this.loop();
  },
  post(msg) { if (!STANDALONE && chan) chan.postMessage(msg); },
};

if (chan && !STANDALONE) chan.onmessage = (e) => {
  const m = e.data || {};
  if (m.type === 'hello') dock.post({ type: 'state', source: dock.source, pinned: dock.pinned, hover: dock.hoverSrc, ...dock.playhead() });
  if (m.type === 'closed') { dock.popped = null; if (prefs.get('dock', false)) { dock.ensure(); document.body.appendChild(dock.el); dock.render(true); dock.loop(); } }
  if (m.type === 'geo') prefs.set('dockPopGeo', m.geo);
  if (m.type === 'film') dock.film();
  if (m.type === 'pin') { dock.source = m.source; dock.pinned = m.pinned; }
};
export { chan as dockChannel, renderSource };
