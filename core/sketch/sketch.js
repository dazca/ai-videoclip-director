/* =====================================================================================================================
   Director Workbench: sketch tool (core/sketch/).  A compact in-browser paint surface, vanilla JS, no dependencies.

   mountSketch(el, opts) -> api      fill a panel with the tool (inline)
   openSketch(opts)      -> api      the same tool in a floating window (draggable, resizable; Esc asks before
                                     discarding unsaved changes); api.close(force?) closes it
   opts: { sketch?          a sketch JSON to edit (else a new one from id / w / h / underlay / paper)
           id?, w?, h?      new sketch: size in document pixels (default 1280x720, or the underlay's natural size)
           underlay?        { src, opacity?, fit?: 'contain'|'cover'|'stretch' }
           resolve?(src)    turn a stored src (a project path) into a URL to load (e.g. mediaUrl); default identity
           save?(sketch, pngBlob, maskBlob|null) -> Promise   called by Save / Ctrl+S; maskBlob is null when no mask
           onDuplicate?(copy)  Duplicate button: a deep copy with a new id (also the 'duplicate' event)
           panel?: false    hide the side panel (layers + pins list)
           title?, x?, y?, width?, height?   floating window only }
   api: get() load(sketch) setTool(t) setColor(c) setSize(n) setOpacity(o) setUnderlay(u|null) undo() redo()
        clear('sketch'|'mask'|'pins'|'all') copy() paste() duplicate() addPin(x, y, text) updatePin(n, text)
        removePin(n) fit() zoom100() setZoom(z, sx?, sy?) exportPNG({scale}) exportMask({scale}) save() destroy()
        on(event, fn) -> off      events: change, save, duplicate, tool, close
        dirty, tool, view, el (getters)
   Pure helpers: newSketch(o), normalize(s), renderSketch(s, {scale, resolve, layers}) -> canvas,
        renderMask(s, {scale}) -> canvas (black / white), clipboard {get(), has(), set(data)}

   Sketch JSON (all coordinates in document pixels, top-left origin; deterministic: the same JSON renders the same):
     { id, w, h, paper: '#ffffff'|null, underlay: {src, opacity, fit}|null,
       strokes: [ {t:'pen'|'eraser', c, size, o, pts:[[x, y, pressure 0..1], ...]}
                | {t:'line'|'arrow'|'rect'|'ellipse', c, size, o, x0, y0, x1, y1}
                | {t:'fill', c, o, x, y, tol} ],                 fill = flood fill of the sketch layer seeded at x,y
       mask:    [ {t:'paint'|'erase', size, pts:[[x, y, p], ...]} ],
       pins:    [ {n, x, y, text} ], created, updated, via }
   ===================================================================================================================== */

export const PALETTE = ['#111111', '#ffffff', '#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#0a84ff', '#bf5af2'];
const MASK_TINT = '#ff2d55';
let HATCH = null;   // the mask shows as translucent red with diagonal stripes, readable over any image
function hatch() {
  if (HATCH) return HATCH;
  const c = document.createElement('canvas'); c.width = c.height = 12; const x = c.getContext('2d');
  x.fillStyle = 'rgba(255,45,85,0.5)'; x.fillRect(0, 0, 12, 12); x.strokeStyle = MASK_TINT; x.lineWidth = 3; x.beginPath();
  for (const o of [-12, 0, 12]) { x.moveTo(o - 2, 14); x.lineTo(o + 14, -2); }
  x.stroke(); return (HATCH = c);
}
const PIN_FILL = '#f5a524';
const FONT = '"Segoe UI", Arial, sans-serif';

const now = () => new Date().toISOString().slice(0, 19);
const uid = () => 'sk' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const r1 = (v) => Math.round(v * 10) / 10;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const clone = (o) => JSON.parse(JSON.stringify(o));

// ------------------------------------------------------------------------------------------------ data
export function newSketch({ id, w, h, underlay = null, paper = '#ffffff', via = 'page' } = {}) {
  return normalize({ id: id || uid(), w: w || 1280, h: h || 720, paper, underlay, strokes: [], mask: [], pins: [], created: now(), updated: now(), via });
}
export function normalize(s) {
  const o = clone(s || {});
  o.id = o.id || uid(); o.w = Math.max(1, Math.round(o.w || 1280)); o.h = Math.max(1, Math.round(o.h || 720));
  if (o.paper === undefined) o.paper = '#ffffff';
  o.underlay = o.underlay && o.underlay.src ? { opacity: 1, fit: 'contain', ...o.underlay } : null;
  o.strokes = Array.isArray(o.strokes) ? o.strokes : []; o.mask = Array.isArray(o.mask) ? o.mask : [];
  o.pins = Array.isArray(o.pins) ? o.pins : [];
  o.created = o.created || now(); o.updated = o.updated || o.created; o.via = o.via || 'page';
  return o;
}

// app-internal clipboard: "copy from scene to scene" (shared by every sketch on the page)
let CLIP = null;
export const clipboard = { get: () => CLIP && clone(CLIP), has: () => !!CLIP, set: (d) => { CLIP = d ? clone(d) : null; } };

// ------------------------------------------------------------------------------------------------ rendering
const mk = (w, h) => { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; };
const ctx2d = (c) => c.getContext('2d', { willReadFrequently: true });
let SCR = null;   // shared scratch canvas for translucent strokes and fills
function scratch(w, h) {
  if (!SCR) SCR = mk(w, h);
  if (SCR.width !== w || SCR.height !== h) { SCR.width = w; SCR.height = h; }
  const c = ctx2d(SCR); c.setTransform(1, 0, 0, 1, 0, 0); c.globalAlpha = 1; c.globalCompositeOperation = 'source-over'; c.clearRect(0, 0, w, h);
  return c;
}
const pw = (size, p) => size * (0.15 + 0.85 * (p ?? 1));   // pressure -> width

function brush(c, pts, size, s) {
  if (!pts?.length) return;
  const ws = pts.map(p => Math.max(0.5, pw(size, p[2]) * s));
  if (pts.length === 1) { c.beginPath(); c.arc(pts[0][0] * s, pts[0][1] * s, ws[0] / 2, 0, Math.PI * 2); c.fill(); return; }
  if (ws.every(w => w === ws[0])) {          // constant width: one smoothed path (quadratic through the midpoints)
    c.lineWidth = ws[0]; c.beginPath(); c.moveTo(pts[0][0] * s, pts[0][1] * s);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
      c.quadraticCurveTo(pts[i][0] * s, pts[i][1] * s, mx * s, my * s);
    }
    const L = pts[pts.length - 1]; c.lineTo(L[0] * s, L[1] * s); c.stroke(); return;
  }
  for (let i = 1; i < pts.length; i++) {      // variable width (pressure): round-capped segments
    c.lineWidth = (ws[i - 1] + ws[i]) / 2; c.beginPath();
    c.moveTo(pts[i - 1][0] * s, pts[i - 1][1] * s); c.lineTo(pts[i][0] * s, pts[i][1] * s); c.stroke();
  }
}
function shape(c, st, s) {
  const { x0, y0, x1, y1 } = st, lw = Math.max(0.5, st.size * s); c.lineWidth = lw;
  if (st.t === 'line') { c.beginPath(); c.moveTo(x0 * s, y0 * s); c.lineTo(x1 * s, y1 * s); c.stroke(); return; }
  if (st.t === 'arrow') {
    const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L;
    const hl = Math.min(L * 0.6, st.size * 3 + 10), hw = hl * 0.55;
    const bx = x1 - ux * hl, by = y1 - uy * hl;
    c.beginPath(); c.moveTo(x0 * s, y0 * s); c.lineTo((x1 - ux * hl * 0.7) * s, (y1 - uy * hl * 0.7) * s); c.stroke();
    c.lineWidth = Math.max(0.5, Math.min(lw, hw * s * 0.5));
    c.beginPath(); c.moveTo(x1 * s, y1 * s); c.lineTo((bx - uy * hw) * s, (by + ux * hw) * s); c.lineTo((bx + uy * hw) * s, (by - ux * hw) * s);
    c.closePath(); c.fill(); c.stroke(); return;
  }
  const x = Math.min(x0, x1) * s, y = Math.min(y0, y1) * s, w = Math.abs(x1 - x0) * s, h = Math.abs(y1 - y0) * s;
  c.beginPath();
  if (st.t === 'rect') c.rect(x, y, w, h); else c.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  c.stroke();
}
function paint(c, st, s, colour) {
  c.save(); c.lineCap = 'round'; c.lineJoin = 'round'; c.strokeStyle = c.fillStyle = colour;
  if (st.pts) brush(c, st.pts, st.size, s); else shape(c, st, s);
  c.restore();
}
const hexRGB = (h) => { const m = /^#?([0-9a-f]{6})$/i.exec(h || ''); const n = m ? parseInt(m[1], 16) : 0; return [n >> 16 & 255, n >> 8 & 255, n & 255]; };

function floodFill(c, st, s) {
  const W = c.canvas.width, H = c.canvas.height, sx = Math.floor(st.x * s), sy = Math.floor(st.y * s);
  if (sx < 0 || sy < 0 || sx >= W || sy >= H) return;
  const d = c.getImageData(0, 0, W, H).data, tol = st.tol ?? 48, i0 = (sy * W + sx) * 4;
  const T = [d[i0], d[i0 + 1], d[i0 + 2], d[i0 + 3]];
  const same = (p) => {
    const j = p * 4;
    if (T[3] < 8) return d[j + 3] <= tol;               // seed on empty paper: everything nearly transparent
    return Math.abs(d[j] - T[0]) <= tol && Math.abs(d[j + 1] - T[1]) <= tol && Math.abs(d[j + 2] - T[2]) <= tol && Math.abs(d[j + 3] - T[3]) <= tol;
  };
  const m = new Uint8Array(W * H), stack = [sx, sy];
  while (stack.length) {                                // scanline flood fill
    const y = stack.pop(), x0 = stack.pop(); let x = x0;
    while (x >= 0 && !m[y * W + x] && same(y * W + x)) x--;
    x++; let up = false, dn = false;
    while (x < W && !m[y * W + x] && same(y * W + x)) {
      m[y * W + x] = 1;
      if (y > 0) { const q = (y - 1) * W + x, ok = !m[q] && same(q); if (ok && !up) stack.push(x, y - 1); up = ok; }
      if (y < H - 1) { const q = (y + 1) * W + x, ok = !m[q] && same(q); if (ok && !dn) stack.push(x, y + 1); dn = ok; }
      x++;
    }
  }
  for (let r = Math.max(1, Math.round(s)); r > 0; r--) {   // grow under the antialiased edges of the outline
    const g = m.slice();
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const p = y * W + x; if (m[p]) continue;
      if ((x > 0 && g[p - 1]) || (x < W - 1 && g[p + 1]) || (y > 0 && g[p - W]) || (y < H - 1 && g[p + W])) m[p] = 2;
    }
  }
  const t = scratch(W, H), out = t.createImageData(W, H), o = out.data, [R, G, B] = hexRGB(st.c);
  for (let p = 0; p < m.length; p++) if (m[p]) { const j = p * 4; o[j] = R; o[j + 1] = G; o[j + 2] = B; o[j + 3] = 255; }
  t.putImageData(out, 0, 0);
  c.save(); c.globalAlpha = st.o ?? 1; c.drawImage(SCR, 0, 0); c.restore();
}

// one operation of the sketch layer (or of the mask, colour white) onto c at scale s
function applyOp(c, st, s, mask = false) {
  if (st.t === 'fill') return floodFill(c, st, s);
  const erase = st.t === 'eraser' || st.t === 'erase', a = mask ? 1 : (st.o ?? 1), col = mask ? '#ffffff' : (st.c || '#000');
  c.save(); c.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
  if (a >= 1) paint(c, st, s, erase ? '#000' : col);
  else { const W = c.canvas.width, H = c.canvas.height; paint(scratch(W, H), st, s, erase ? '#000' : col); c.globalAlpha = a; c.drawImage(SCR, 0, 0); }
  c.restore();
}
function renderLayer(cv, ops, s, mask) {
  const c = ctx2d(cv); c.setTransform(1, 0, 0, 1, 0, 0); c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
  c.clearRect(0, 0, cv.width, cv.height);
  for (const st of ops) applyOp(c, st, s, mask);
}

const IMGS = new Map();
function loadImage(url) {
  if (!IMGS.has(url)) IMGS.set(url, new Promise((ok, bad) => { const i = new Image(); i.decoding = 'async'; i.onload = () => ok(i); i.onerror = () => bad(new Error('cannot load ' + url)); i.src = url; }));
  return IMGS.get(url);
}
function fitRect(iw, ih, w, h, fit) {
  if (fit === 'stretch') return [0, 0, w, h];
  const k = (fit === 'cover' ? Math.max : Math.min)(w / iw, h / ih), dw = iw * k, dh = ih * k;
  return [(w - dw) / 2, (h - dh) / 2, dw, dh];
}
function drawUnderlay(c, sk, img, s) {
  if (!img || !sk.underlay) return;
  const [x, y, w, h] = fitRect(img.naturalWidth, img.naturalHeight, sk.w, sk.h, sk.underlay.fit);
  c.save(); c.beginPath(); c.rect(0, 0, sk.w * s, sk.h * s); c.clip(); c.globalAlpha = clamp(sk.underlay.opacity ?? 1, 0, 1);
  c.drawImage(img, x * s, y * s, w * s, h * s); c.restore();
}
function wrap(c, text, maxW, maxLines) {
  const words = String(text).replace(/\s+/g, ' ').trim().split(' '), lines = []; let cur = '';
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w;
    if (c.measureText(t).width <= maxW || !cur) cur = t; else { lines.push(cur); cur = w; }
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) {
    let l = lines[maxLines - 1]; while (l && c.measureText(l + '...').width > maxW) l = l.slice(0, -1); lines[maxLines - 1] = l + '...';
  }
  return lines;
}
export const pinRadius = (sk) => Math.max(9, Math.min(sk.w, sk.h) * 0.016);
function drawPins(c, sk, s) {
  const r = pinRadius(sk) * s;
  for (const p of sk.pins) {
    const x = p.x * s, y = p.y * s;
    c.save();
    if (p.text) {
      c.font = `${Math.round(r * 1.05)}px ${FONT}`;
      const lines = wrap(c, p.text, Math.min(sk.w * 0.42, 380) * s, 4), lh = r * 1.3, pad = r * 0.4;
      const bw = Math.max(...lines.map(l => c.measureText(l).width)) + pad * 2, bh = lines.length * lh + pad * 1.2;
      let bx = x + r * 1.35, by = y - r; if (bx + bw > sk.w * s) bx = x - r * 1.35 - bw; by = clamp(by, 0, Math.max(0, sk.h * s - bh));
      c.fillStyle = 'rgba(15,16,18,0.86)'; c.fillRect(bx, by, bw, bh);
      c.fillStyle = PIN_FILL; c.fillRect(bx, by, Math.max(1, r * 0.18), bh);
      c.fillStyle = '#f2f2f2'; c.textBaseline = 'top';
      lines.forEach((l, i) => c.fillText(l, bx + pad, by + pad * 0.7 + i * lh));
    }
    c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fillStyle = PIN_FILL; c.fill();
    c.lineWidth = Math.max(1, r * 0.14); c.strokeStyle = '#111'; c.stroke();
    c.fillStyle = '#111'; c.font = `bold ${Math.round(r * 1.15)}px ${FONT}`; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(String(p.n), x, y + r * 0.06);
    c.restore();
  }
}

// flattened render: paper + underlay + sketch + pins, at any scale (vector data, so crisp at any size)
export async function renderSketch(sk, { scale = 1, resolve = (x) => x, layers = {}, img } = {}) {
  const L = { paper: true, underlay: true, sketch: true, pins: true, ...layers };
  const W = Math.round(sk.w * scale), H = Math.round(sk.h * scale), s = W / sk.w;
  const out = mk(W, H), c = ctx2d(out);
  if (L.paper && sk.paper) { c.fillStyle = sk.paper; c.fillRect(0, 0, W, H); }
  if (L.underlay && sk.underlay) { try { drawUnderlay(c, sk, img || await loadImage(resolve(sk.underlay.src)), s); } catch (e) { console.warn(e.message); } }
  if (L.sketch) { const lay = mk(W, H); renderLayer(lay, sk.strokes, s, false); c.drawImage(lay, 0, 0); }
  if (L.pins) drawPins(c, sk, s);
  return out;
}
// mask render: opaque black, pure white where painted (thresholded, no grey) -- the format image-edit models expect
export function renderMask(sk, { scale = 1 } = {}) {
  const W = Math.round(sk.w * scale), H = Math.round(sk.h * scale), s = W / sk.w;
  const out = mk(W, H); renderLayer(out, sk.mask, s, true);
  const c = ctx2d(out), img = c.getImageData(0, 0, W, H), d = img.data;
  for (let j = 0; j < d.length; j += 4) { const v = d[j + 3] >= 128 ? 255 : 0; d[j] = d[j + 1] = d[j + 2] = v; d[j + 3] = 255; }
  c.putImageData(img, 0, 0);
  return out;
}
const toBlob = (cv) => new Promise((ok) => cv.toBlob(ok, 'image/png'));

// ------------------------------------------------------------------------------------------------ geometry helpers
function bbox(st) {
  if (st.t === 'fill') return [st.x - 4, st.y - 4, st.x + 4, st.y + 4];
  const pad = (st.size || 1) / 2;
  if (st.pts) { let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity; for (const [x, y] of st.pts) { a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y); } return [a - pad, b - pad, c + pad, d + pad]; }
  return [Math.min(st.x0, st.x1) - pad, Math.min(st.y0, st.y1) - pad, Math.max(st.x0, st.x1) + pad, Math.max(st.y0, st.y1) + pad];
}
function polyOf(st) {
  if (st.pts) return st.pts;
  const { x0, y0, x1, y1 } = st;
  if (st.t === 'rect') return [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
  if (st.t === 'ellipse') { const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = Math.abs(x1 - x0) / 2, ry = Math.abs(y1 - y0) / 2; return Array.from({ length: 33 }, (_, i) => [cx + rx * Math.cos(i / 16 * Math.PI), cy + ry * Math.sin(i / 16 * Math.PI)]); }
  return [[x0, y0], [x1, y1]];
}
function segDist(px, py, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy, t = L ? clamp(((px - a[0]) * dx + (py - a[1]) * dy) / L, 0, 1) : 0;
  return Math.hypot(px - a[0] - t * dx, py - a[1] - t * dy);
}
function hit(st, x, y, tol) {
  if (st.t === 'fill') return Math.hypot(x - st.x, y - st.y) <= tol + 4;
  const [a, b, c, d] = bbox(st); if (x < a - tol || x > c + tol || y < b - tol || y > d + tol) return false;
  const P = polyOf(st), r = (st.size || 1) / 2 + tol;
  if (P.length === 1) return Math.hypot(x - P[0][0], y - P[0][1]) <= r;
  for (let i = 1; i < P.length; i++) if (segDist(x, y, P[i - 1], P[i]) <= r) return true;
  return false;
}
function moveOp(st, dx, dy) {
  if (st.pts) st.pts = st.pts.map(([x, y, p]) => [r1(x + dx), r1(y + dy), p]);
  else if (st.t === 'fill') { st.x = r1(st.x + dx); st.y = r1(st.y + dy); }
  else { st.x0 = r1(st.x0 + dx); st.y0 = r1(st.y0 + dy); st.x1 = r1(st.x1 + dx); st.y1 = r1(st.y1 + dy); }
}
function scaleOp(st, f, ox, oy) {
  if (st.size) st.size = r1(st.size * f);
  if (st.pts) st.pts = st.pts.map(([x, y, p]) => [r1(x * f + ox), r1(y * f + oy), p]);
  else if (st.t === 'fill') { st.x = r1(st.x * f + ox); st.y = r1(st.y * f + oy); }
  else { st.x0 = r1(st.x0 * f + ox); st.y0 = r1(st.y0 * f + oy); st.x1 = r1(st.x1 * f + ox); st.y1 = r1(st.y1 * f + oy); }
}

// ------------------------------------------------------------------------------------------------ UI
let cssDone = false;
function ensureCss() {
  if (cssDone || document.querySelector('link[data-sketch-css]')) { cssDone = true; return; }
  const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = new URL('./sketch.css', import.meta.url).href; l.dataset.sketchCss = '';
  document.head.appendChild(l); cssDone = true;
}
const svg = (d) => `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">${d}</svg>`;
const ICON = {
  select: svg('<path d="M3.5 2l8.5 5-3.8 1.3L6.6 13z"/>'),
  pen: svg('<path d="M2.5 13.5l1-3.6 7.3-7.3 2.6 2.6-7.3 7.3zM9.5 3.9l2.6 2.6"/>'),
  eraser: svg('<path d="M6 13.5h8M2.8 10.2l6.4-6.4 4 4-5.3 5.3H5.2z"/>'),
  line: svg('<path d="M3 13L13 3"/>'),
  arrow: svg('<path d="M3 13L12.5 3.5M6.5 3h6.5v6.5"/>'),
  rect: svg('<rect x="2.5" y="4" width="11" height="8.5"/>'),
  ellipse: svg('<ellipse cx="8" cy="8.2" rx="5.7" ry="4.6"/>'),
  fill: svg('<path d="M2.8 8l5-5 5.2 5.2-5 5zM2.8 8h10.2M13.6 10.3c1.1 1.6 1.1 3.2 0 3.2s-1.1-1.6 0-3.2z"/>'),
  pick: svg('<path d="M2.5 13.5l1-3 6-6 2 2-6 6zM9 3l1.6-1.4a1.4 1.4 0 0 1 2 2L11.2 5.2"/>'),
  mask: svg('<rect x="2.5" y="2.5" width="11" height="11" rx="1"/><circle cx="8" cy="8" r="3.2" fill="currentColor" stroke="none"/>'),
  maskerase: svg('<rect x="2.5" y="2.5" width="11" height="11" rx="1"/><circle cx="8" cy="8" r="3.2" stroke-dasharray="1.6 1.4"/>'),
  pin: svg('<path d="M8 14s4.2-4.6 4.2-7.6a4.2 4.2 0 0 0-8.4 0C3.8 9.4 8 14 8 14z"/><circle cx="8" cy="6.4" r="1.4"/>'),
  undo: svg('<path d="M5.5 3.5L2.5 6.5l3 3M2.5 6.5H10a3.3 3.3 0 0 1 0 6.6H6.5"/>'),
  redo: svg('<path d="M10.5 3.5l3 3-3 3M13.5 6.5H6a3.3 3.3 0 0 0 0 6.6h3.5"/>'),
  clear: svg('<path d="M3 4.5h10M6.2 4.5V2.8h3.6v1.7M4.4 4.5l.8 9h5.6l.8-9"/>'),
  copy: svg('<rect x="5.5" y="5.5" width="8" height="8"/><path d="M3 10.5V2.5h8"/>'),
  paste: svg('<rect x="3.5" y="3" width="9" height="11"/><path d="M6 4.5V2h4v2.5zM6 8h4M6 10.5h4"/>'),
  dup: svg('<rect x="2.5" y="2.5" width="8" height="8"/><path d="M6.5 13.5h7v-7M6.5 4.5v4M4.5 6.5h4"/>'),
  fit: svg('<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/>'),
  save: svg('<path d="M2.5 2.5h8.5l2.5 2.5v8.5h-11zM5 2.5v3.5h5V2.5M5 13.5V9.5h6v4"/>'),
  close: svg('<path d="M4 4l8 8M12 4l-8 8"/>'),
};
const TOOLS = [
  ['select', 'V', 'Select and move strokes'], ['pen', 'B', 'Pen (pressure)'], ['eraser', 'E', 'Eraser'],
  ['line', 'L', 'Line'], ['arrow', 'A', 'Arrow'], ['rect', 'R', 'Rectangle'], ['ellipse', 'O', 'Ellipse'],
  ['fill', 'F', 'Fill bucket'], ['pick', 'I', 'Eyedropper'], ['mask', 'M', 'Mask brush'], ['maskerase', 'Shift+M', 'Mask eraser'], ['pin', 'P', 'Pin (numbered note)'],
];
const KEY_TOOL = { v: 'select', b: 'pen', e: 'eraser', l: 'line', a: 'arrow', r: 'rect', o: 'ellipse', f: 'fill', i: 'pick', m: 'mask', p: 'pin' };
const SHAPES = new Set(['line', 'arrow', 'rect', 'ellipse']);
const sizeKey = (t) => t === 'eraser' ? 'erase' : (t === 'mask' || t === 'maskerase') ? 'mask' : 'draw';
const btn = (id, title, keyHint, icon, cls = 'sk-b') => `<button type="button" class="${cls}" data-act="${id}" title="${title}${keyHint ? ' (' + keyHint + ')' : ''}" aria-label="${title}">${icon}</button>`;

export function mountSketch(el, opts = {}) {
  ensureCss();
  const resolve = opts.resolve || ((s) => s);
  let sk = normalize(opts.sketch || newSketch({ id: opts.id, w: opts.w, h: opts.h, underlay: opts.underlay, paper: opts.paper }));
  let sizeFromUnderlay = !opts.sketch && !opts.w && !!sk.underlay;
  const handlers = new Map();
  const emit = (n, ...a) => { for (const f of handlers.get(n) || []) { try { f(...a); } catch (e) { console.error(e); } } };

  let tool = 'pen', tempTool = null, color = opts.color || (sk.underlay ? '#ff3b30' : '#111111'), opacity = 1;
  const sizes = { draw: 4, erase: 24, mask: 48 };
  const vis = { sketch: true, mask: true };
  let undoS = [], redoS = [], dirty = false, sel = new Set(), live = null, hover = null, spaceDown = false;
  const view = { z: 1, px: 0, py: 0, fitted: true };
  let img = null, imgMsg = '';
  const touches = new Map();

  // ---------------- DOM
  const root = document.createElement('div');
  root.className = 'sk'; root.tabIndex = 0; root.setAttribute('role', 'application'); root.setAttribute('aria-label', 'Sketch editor');
  root.innerHTML = `
<div class="sk-bar" role="toolbar" aria-label="Sketch tools">
  ${TOOLS.map(([id, k, t]) => btn('tool:' + id, t, k, ICON[id])).join('')}
  <span class="sk-sep"></span>
  <label class="sk-num" title="Size ([ and ])"><span>sz</span><input type="number" class="sk-size" min="1" max="400" step="1" aria-label="Brush size"></label>
  <label class="sk-num" title="Opacity %"><span>op</span><input type="number" class="sk-op" min="5" max="100" step="5" aria-label="Opacity percent"></label>
  <input type="color" class="sk-color" title="Colour" aria-label="Colour">
  <span class="sk-pal" role="group" aria-label="Palette">${PALETTE.map(c => `<button type="button" class="sk-sw" data-col="${c}" title="${c}" aria-label="Colour ${c}"></button>`).join('')}</span>
  <span class="sk-sep"></span>
  ${btn('undo', 'Undo', 'Ctrl+Z', ICON.undo)}${btn('redo', 'Redo', 'Ctrl+Shift+Z', ICON.redo)}${btn('clear', 'Clear layer (the mask in mask mode)', '', ICON.clear)}
  <span class="sk-sep"></span>
  ${btn('copy', 'Copy whole sketch', 'Ctrl+C', ICON.copy)}${btn('paste', 'Paste sketch into this one', 'Ctrl+V', ICON.paste)}${btn('dup', 'Duplicate sketch', '', ICON.dup)}
  <span class="sk-sep"></span>
  ${btn('fit', 'Fit', '0', ICON.fit)}<button type="button" class="sk-b sk-zoom" data-act="z100" title="Zoom; click for 100% (1)" aria-label="Zoom 100%">100%</button>
  <span class="sk-fill"></span>
  ${btn('save', 'Save', 'Ctrl+S', ICON.save)}
</div>
<div class="sk-main">
  <div class="sk-stage"><canvas class="sk-cv" aria-label="Drawing surface"></canvas><div class="sk-pins"></div><div class="sk-hud" aria-live="polite"></div></div>
  <div class="sk-side">
    <div class="sk-h">Layers</div>
    <label class="sk-row"><input type="checkbox" class="sk-vis-sketch" checked> sketch</label>
    <label class="sk-row"><input type="checkbox" class="sk-vis-mask" checked> mask <i class="sk-mk"></i></label>
    <div class="sk-row sk-ul"><span>underlay</span><input type="range" class="sk-ulop" min="0" max="100" step="5" aria-label="Underlay opacity"><select class="sk-ulfit" aria-label="Underlay fit"><option>contain</option><option>cover</option><option>stretch</option></select></div>
    <div class="sk-h">Pins <button type="button" class="sk-x sk-pinclear" title="Remove all pins" aria-label="Remove all pins">clear</button></div>
    <ol class="sk-pinlist"></ol>
    <div class="sk-empty dim">P, then click the image to pin a note.</div>
  </div>
</div>
<div class="sk-confirm" hidden role="alertdialog" aria-label="Unsaved changes"><span>Unsaved changes.</span>
  <button type="button" data-cf="save">Save</button><button type="button" data-cf="discard">Discard</button><button type="button" data-cf="cancel">Cancel</button></div>`;
  el.appendChild(root);
  const $ = (q) => root.querySelector(q);
  const stage = $('.sk-stage'), cv = $('.sk-cv'), vc = cv.getContext('2d'), pinsEl = $('.sk-pins'), hud = $('.sk-hud');
  const sizeIn = $('.sk-size'), opIn = $('.sk-op'), colIn = $('.sk-color');
  root.querySelectorAll('.sk-sw').forEach(b => { b.style.background = b.dataset.col; });
  if (opts.panel === false) root.classList.add('nopanel');
  if (!opts.save) $('[data-act=save]').title = 'Save (no save handler: emits the save event)';

  // ---------------- layer caches (document resolution x k)
  let k = 1, skL, mkL, liveS, liveM, tint;
  function allocLayers() {
    k = Math.min(2, 3000 / Math.max(sk.w, sk.h));
    const W = Math.round(sk.w * k), H = Math.round(sk.h * k);
    skL = mk(W, H); liveS = mk(W, H); mkL = mk(W, H); liveM = mk(W, H); tint = mk(W, H);
  }
  function tintFrom(src) {
    const c = ctx2d(tint); c.setTransform(1, 0, 0, 1, 0, 0); c.globalCompositeOperation = 'source-over'; c.clearRect(0, 0, tint.width, tint.height);
    c.drawImage(src, 0, 0); c.globalCompositeOperation = 'source-in'; c.fillStyle = c.createPattern(hatch(), 'repeat'); c.fillRect(0, 0, tint.width, tint.height);
    c.globalCompositeOperation = 'source-over';
  }
  function rebuild() { renderLayer(skL, sk.strokes, k, false); renderLayer(mkL, sk.mask, k, true); tintFrom(mkL); draw(); renderPins(); }
  function liveFrame() {
    if (!live) return;
    if (live.kind === 'stroke' || live.kind === 'shape') {
      const c = ctx2d(liveS); c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, liveS.width, liveS.height); c.drawImage(skL, 0, 0); applyOp(c, live.op, k, false);
    } else if (live.kind === 'mask') {
      const c = ctx2d(liveM); c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, liveM.width, liveM.height); c.drawImage(mkL, 0, 0); applyOp(c, live.op, k, true);
      tintFrom(liveM);
    }
  }

  // ---------------- underlay
  function loadUnderlay() {
    img = null; imgMsg = '';
    if (!sk.underlay) { draw(); return; }
    const src = sk.underlay.src;
    imgMsg = 'loading underlay...';
    loadImage(resolve(src)).then((i) => {
      if (!sk.underlay || sk.underlay.src !== src) return;
      img = i; imgMsg = '';
      if (sizeFromUnderlay && !sk.strokes.length && !sk.mask.length && !sk.pins.length) {
        const f = Math.min(1, 2048 / Math.max(i.naturalWidth, i.naturalHeight));
        sk.w = Math.round(i.naturalWidth * f); sk.h = Math.round(i.naturalHeight * f); allocLayers(); rebuild(); fit();
      }
      sizeFromUnderlay = false; draw();
    }).catch(() => { imgMsg = 'underlay not found: ' + src; draw(); });
    syncPanel();
  }

  // ---------------- view
  const dpr = () => window.devicePixelRatio || 1;
  function resize() {
    const r = stage.getBoundingClientRect(), d = dpr();
    cv.width = Math.max(1, Math.round(r.width * d)); cv.height = Math.max(1, Math.round(r.height * d));
    cv.style.width = r.width + 'px'; cv.style.height = r.height + 'px';
    if (view.fitted) fit(); else draw();
  }
  function fit() {
    const r = stage.getBoundingClientRect(), m = 12;
    view.z = Math.max(0.02, Math.min((r.width - m * 2) / sk.w, (r.height - m * 2) / sk.h));
    view.px = (r.width - sk.w * view.z) / 2; view.py = (r.height - sk.h * view.z) / 2; view.fitted = true; draw(); renderPins();
  }
  function setZoom(z, sx, sy) {
    const r = stage.getBoundingClientRect(); if (sx == null) { sx = r.width / 2; sy = r.height / 2; }
    z = clamp(z, 0.02, 32); const dx = (sx - view.px) / view.z, dy = (sy - view.py) / view.z;
    view.z = z; view.px = sx - dx * z; view.py = sy - dy * z; view.fitted = false; draw(); renderPins();
  }
  const toDoc = (e) => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left - view.px) / view.z, (e.clientY - r.top - view.py) / view.z]; };
  let checker = null;
  function checkerPattern() {
    if (checker) return checker;
    const c = mk(16, 16), x = c.getContext('2d'); x.fillStyle = '#3a3d42'; x.fillRect(0, 0, 16, 16); x.fillStyle = '#2c2f34'; x.fillRect(0, 0, 8, 8); x.fillRect(8, 8, 8, 8);
    return (checker = vc.createPattern(c, 'repeat'));
  }

  let raf = 0;
  function draw() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; frame(); }); }
  function frame() {
    const d = dpr(), { z, px, py } = view;
    vc.setTransform(1, 0, 0, 1, 0, 0); vc.globalAlpha = 1; vc.fillStyle = '#0b0c0e'; vc.fillRect(0, 0, cv.width, cv.height);
    vc.setTransform(d, 0, 0, d, 0, 0);
    vc.fillStyle = checkerPattern(); vc.fillRect(px, py, sk.w * z, sk.h * z);
    vc.setTransform(d * z, 0, 0, d * z, d * px, d * py);
    if (sk.paper) { vc.fillStyle = sk.paper; vc.fillRect(0, 0, sk.w, sk.h); }
    vc.imageSmoothingEnabled = true; vc.imageSmoothingQuality = 'high';
    drawUnderlay(vc, sk, img, 1);
    const showLive = live && (live.kind === 'stroke' || live.kind === 'shape');
    if (vis.sketch) vc.drawImage(showLive ? liveS : skL, 0, 0, sk.w, sk.h);
    if (vis.mask) { vc.globalAlpha = tool.startsWith('mask') ? 0.85 : 0.6; vc.drawImage(tint, 0, 0, sk.w, sk.h); vc.globalAlpha = 1; }
    // overlays in screen space
    vc.setTransform(d, 0, 0, d, 0, 0);
    vc.strokeStyle = '#2a2d32'; vc.lineWidth = 1; vc.strokeRect(Math.round(px) - 0.5, Math.round(py) - 0.5, Math.round(sk.w * z) + 1, Math.round(sk.h * z) + 1);
    const S = (x, y) => [px + x * z, py + y * z];
    if (sel.size) {
      vc.save(); vc.setLineDash([4, 3]); vc.strokeStyle = '#f5a524';
      for (const st of sel) { const [a, b, c, e] = bbox(st), [x0, y0] = S(a, b), [x1, y1] = S(c, e); vc.strokeRect(x0 - 2.5, y0 - 2.5, x1 - x0 + 5, y1 - y0 + 5); }
      vc.restore();
    }
    if (live?.kind === 'box') {
      const [x0, y0] = S(live.x0, live.y0), [x1, y1] = S(live.x1, live.y1);
      vc.save(); vc.setLineDash([3, 3]); vc.strokeStyle = '#9db7d6'; vc.strokeRect(Math.min(x0, x1) + 0.5, Math.min(y0, y1) + 0.5, Math.abs(x1 - x0), Math.abs(y1 - y0)); vc.restore();
    }
    const t = tempTool || tool;
    if (hover && !spaceDown && (t === 'pen' || t === 'eraser' || t.startsWith('mask'))) {
      const [x, y] = S(hover[0], hover[1]), r = Math.max(1.5, sizes[sizeKey(t)] * z / 2);
      vc.beginPath(); vc.arc(x, y, r, 0, Math.PI * 2); vc.strokeStyle = 'rgba(0,0,0,.6)'; vc.lineWidth = 3; vc.stroke();
      vc.strokeStyle = t.startsWith('mask') ? MASK_TINT : '#fff'; vc.lineWidth = 1; vc.stroke();
    }
    hud.textContent = `${Math.round(z * 100)}%  ${sk.w}x${sk.h}` + (hover ? `  ${Math.round(hover[0])},${Math.round(hover[1])}` : '') + (imgMsg ? '  ' + imgMsg : '') + (dirty ? '  *' : '');
    $('.sk-zoom').textContent = Math.round(z * 100) + '%';
  }

  // ---------------- history
  const snap = () => JSON.stringify({ w: sk.w, h: sk.h, underlay: sk.underlay, strokes: sk.strokes, mask: sk.mask, pins: sk.pins });
  function restore(js) {
    const o = JSON.parse(js), resized = o.w !== sk.w || o.h !== sk.h, ul = JSON.stringify(o.underlay) !== JSON.stringify(sk.underlay);
    Object.assign(sk, o); sel.clear();
    if (resized) allocLayers();
    if (ul) loadUnderlay();
    rebuild(); syncPanel(); if (resized) fit();
  }
  function changed() { dirty = true; sk.updated = now(); draw(); emit('change'); }
  function commit(fn, before = snap()) {
    fn(); const after = snap(); if (after === before) return false;
    undoS.push(before); if (undoS.length > 300) undoS.shift(); redoS = []; changed(); return true;
  }
  function undo() { if (!undoS.length) return; redoS.push(snap()); restore(undoS.pop()); changed(); }
  function redo() { if (!redoS.length) return; undoS.push(snap()); restore(redoS.pop()); changed(); }

  // ---------------- pins
  function renumber() { sk.pins.forEach((p, i) => { p.n = i + 1; }); }
  function addPin(x, y, text = '') { let p; commit(() => { p = { n: sk.pins.length + 1, x: r1(x), y: r1(y), text }; sk.pins.push(p); }); renderPins(); syncPins(); return p; }
  function updatePin(n, text) { commit(() => { const p = sk.pins.find(q => q.n === n); if (p) p.text = text; }); renderPins(); syncPins(); }
  function removePin(n) { commit(() => { sk.pins = sk.pins.filter(p => p.n !== n); renumber(); }); renderPins(); syncPins(); }
  function renderPins() {
    const r = pinRadius(sk) * Math.min(1.6, Math.max(0.6, view.z));
    const sw = stage.clientWidth;
    while (pinsEl.children.length > sk.pins.length) pinsEl.lastChild.remove();
    sk.pins.forEach((p, i) => {
      let e = pinsEl.children[i];
      if (!e) {
        e = document.createElement('div'); e.className = 'sk-pin'; e.innerHTML = '<b></b><span></span>'; pinsEl.appendChild(e);
        e.addEventListener('pointerdown', pinDown); e.addEventListener('dblclick', () => focusPin(+e.dataset.n));
      }
      e.dataset.n = p.n; e.firstChild.textContent = p.n; e.lastChild.textContent = p.text || '';
      e.title = `Pin ${p.n}${p.text ? ': ' + p.text : ''}`;
      const sx = view.px + p.x * view.z, left = sx + 240 > sw && sx > 240;   // near the right edge: note on the left
      e.classList.toggle('left', left);
      e.style.transform = `translate(${sx}px, ${view.py + p.y * view.z}px)` + (left ? ' translateX(-100%)' : '');
      e.style.setProperty('--r', Math.round(r) + 'px');
    });
  }
  function syncPins() {
    const ol = $('.sk-pinlist'); ol.textContent = '';
    for (const p of sk.pins) {
      const li = document.createElement('li'); li.dataset.n = p.n;
      li.innerHTML = '<b></b><input type="text"><button type="button" class="sk-x" aria-label="Remove pin">x</button>';
      li.firstChild.textContent = p.n;
      const inp = li.children[1]; inp.value = p.text || ''; inp.placeholder = 'note...'; inp.setAttribute('aria-label', `Pin ${p.n} note`);
      let before = null;
      inp.addEventListener('focus', () => { before = snap(); });
      inp.addEventListener('input', () => { p.text = inp.value; renderPins(); });
      inp.addEventListener('change', () => { if (before) commit(() => {}, before); before = snap(); });
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); inp.blur(); root.focus({ preventScroll: true }); } });
      li.lastChild.addEventListener('click', () => removePin(p.n));
      ol.appendChild(li);
    }
    $('.sk-empty').hidden = sk.pins.length > 0;
  }
  function focusPin(n) { const i = root.querySelector(`.sk-pinlist li[data-n="${n}"] input`); if (i) { i.focus(); i.select(); } }
  function pinDown(e) {
    const t = tempTool || tool; if (t !== 'pin' && t !== 'select') return;
    e.stopPropagation(); e.preventDefault();
    const n = +e.currentTarget.dataset.n, p = sk.pins.find(q => q.n === n); if (!p) return;
    const before = snap(), [sx, sy] = toDoc(e), ox = p.x, oy = p.y, tgt = e.currentTarget; let moved = false;
    tgt.setPointerCapture(e.pointerId);
    const mv = (ev) => { const [x, y] = toDoc(ev); if (Math.abs(x - sx) * view.z + Math.abs(y - sy) * view.z > 2) moved = true; p.x = r1(clamp(ox + x - sx, 0, sk.w)); p.y = r1(clamp(oy + y - sy, 0, sk.h)); renderPins(); };
    const up = () => { tgt.removeEventListener('pointermove', mv); tgt.removeEventListener('pointerup', up); tgt.removeEventListener('pointercancel', up); if (moved) commit(() => {}, before); else focusPin(n); };
    tgt.addEventListener('pointermove', mv); tgt.addEventListener('pointerup', up); tgt.addEventListener('pointercancel', up);
  }

  // ---------------- tools
  function setTool(t) {
    if (!ICON[t] && t !== 'hand') return;
    tool = t; tempTool = null; root.dataset.tool = t;
    root.querySelectorAll('[data-act^="tool:"]').forEach(b => { const on = b.dataset.act === 'tool:' + t; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
    if (t !== 'select') sel.clear();
    syncInputs(); draw(); emit('tool', t);
  }
  function setColor(c) { if (/^#[0-9a-f]{6}$/i.test(c)) { color = c.toLowerCase(); syncInputs(); } }
  function setSize(n) { sizes[sizeKey(tool)] = clamp(Math.round(n), 1, 400); syncInputs(); draw(); }
  function setOpacity(o) { opacity = clamp(o, 0.05, 1); syncInputs(); }
  function syncInputs() {
    sizeIn.value = sizes[sizeKey(tool)]; opIn.value = Math.round(opacity * 100); colIn.value = color;
    root.querySelectorAll('.sk-sw').forEach(b => b.classList.toggle('on', b.dataset.col === color));
  }
  function syncPanel() {
    $('.sk-ulop').value = Math.round((sk.underlay?.opacity ?? 1) * 100); $('.sk-ulfit').value = sk.underlay?.fit || 'contain';
    $('.sk-ul').classList.toggle('off', !sk.underlay);
    $('.sk-vis-sketch').checked = vis.sketch; $('.sk-vis-mask').checked = vis.mask;
  }
  function pick(x, y) {
    const t = mk(1, 1), c = t.getContext('2d', { willReadFrequently: true });
    c.setTransform(1, 0, 0, 1, -Math.floor(x), -Math.floor(y));
    if (sk.paper) { c.fillStyle = sk.paper; c.fillRect(0, 0, sk.w, sk.h); }
    drawUnderlay(c, sk, img, 1); c.drawImage(skL, 0, 0, sk.w, sk.h);
    const [r, g, b, a] = c.getImageData(0, 0, 1, 1).data;
    if (a > 0) setColor('#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join(''));
  }
  const pt = (e, x, y) => [r1(x), r1(y), e.pointerType === 'pen' ? Math.round(clamp(e.pressure || 0.5, 0.05, 1) * 100) / 100 : 1];

  // touch: a finger starts its tool only after it moves, lifts or stays 120 ms, so a second finger can still turn the
  // gesture into a pinch (zoom + pan) without leaving a dot or a pin behind
  let pend = null;
  const evCopy = (e) => ({ pointerId: e.pointerId, pointerType: e.pointerType, clientX: e.clientX, clientY: e.clientY, pressure: e.pressure,
    button: e.button, shiftKey: e.shiftKey, altKey: e.altKey, preventDefault() {} });
  function flushPend() { if (!pend) return; clearTimeout(pend.timer); const p = pend.ev; pend = null; start(p); }
  function onDown(e) {
    root.focus({ preventScroll: true });
    if (e.pointerType === 'touch') {
      touches.set(e.pointerId, [e.clientX, e.clientY]);
      try { cv.setPointerCapture(e.pointerId); } catch { /* already released */ }
      if (touches.size === 2) {                       // second finger: drop the stroke in progress, pinch instead
        if (pend) { clearTimeout(pend.timer); pend = null; }
        if (live?.kind === 'move' && live.moved) restore(live.before);
        const [a, b] = [...touches.values()], r = stage.getBoundingClientRect();
        live = { kind: 'pinch', d: Math.hypot(a[0] - b[0], a[1] - b[1]), mx: (a[0] + b[0]) / 2 - r.left, my: (a[1] + b[1]) / 2 - r.top, z: view.z, px: view.px, py: view.py };
        rebuild(); return;
      }
      if (touches.size === 1 && !live) { const ev = evCopy(e); pend = { ev, timer: setTimeout(() => { if (pend?.ev === ev) flushPend(); }, 120) }; }
      return;
    }
    start(e);
  }
  function start(e) {
    if (live) return;
    const [x, y] = toDoc(e), t = e.altKey && !SHAPES.has(tool) && tool !== 'select' ? 'pick' : tool;
    if (e.button === 1 || (e.button === 0 && (spaceDown || t === 'hand'))) {
      e.preventDefault(); try { cv.setPointerCapture(e.pointerId); } catch { /* pointer gone */ }
      live = { kind: 'pan', sx: e.clientX, sy: e.clientY, px: view.px, py: view.py }; root.classList.add('panning'); return;
    }
    if (e.button !== 0) return;
    try { cv.setPointerCapture(e.pointerId); } catch { /* pointer gone */ } e.preventDefault();
    if (t === 'pen' || t === 'eraser') live = { kind: 'stroke', op: { t, ...(t === 'pen' ? { c: color } : {}), size: sizes[sizeKey(t)], o: opacity, pts: [pt(e, x, y)] } };
    else if (t === 'mask' || t === 'maskerase') live = { kind: 'mask', op: { t: t === 'mask' ? 'paint' : 'erase', size: sizes.mask, pts: [pt(e, x, y)] } };
    else if (SHAPES.has(t)) live = { kind: 'shape', op: { t, c: color, size: sizes.draw, o: opacity, x0: r1(x), y0: r1(y), x1: r1(x), y1: r1(y) } };
    else if (t === 'fill') { if (x >= 0 && y >= 0 && x < sk.w && y < sk.h) { commit(() => sk.strokes.push({ t: 'fill', c: color, o: opacity, x: r1(x), y: r1(y), tol: 48 })); rebuild(); } return; }
    else if (t === 'pick') { pick(x, y); return; }
    else if (t === 'pin') { if (x >= 0 && y >= 0 && x <= sk.w && y <= sk.h) { const p = addPin(x, y); requestAnimationFrame(() => focusPin(p.n)); } return; }
    else if (t === 'select') {
      const tol = 4 / view.z, top = [...sk.strokes].reverse().find(st => hit(st, x, y, tol));
      if (top) {
        if (e.shiftKey) { sel.has(top) ? sel.delete(top) : sel.add(top); draw(); return; }
        if (!sel.has(top)) { sel.clear(); sel.add(top); }
        live = { kind: 'move', before: snap(), lx: x, ly: y, moved: false };
      } else { if (!e.shiftKey) sel.clear(); live = { kind: 'box', x0: x, y0: y, x1: x, y1: y, add: e.shiftKey }; }
      draw(); return;
    }
    liveFrame(); draw();
  }
  function onMove(e) {
    if (e.pointerType === 'touch' && touches.has(e.pointerId)) touches.set(e.pointerId, [e.clientX, e.clientY]);
    if (pend && pend.ev.pointerId === e.pointerId) {
      if (Math.hypot(e.clientX - pend.ev.clientX, e.clientY - pend.ev.clientY) < 8) return;
      flushPend();
    }
    const [x, y] = toDoc(e); hover = [x, y];
    if (!live) { draw(); return; }
    if (live.kind === 'pinch') {
      if (touches.size < 2) return;
      const [a, b] = [...touches.values()], r = stage.getBoundingClientRect(), d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const mx = (a[0] + b[0]) / 2 - r.left, my = (a[1] + b[1]) / 2 - r.top, z = clamp(live.z * d / (live.d || 1), 0.02, 32);
      const dx = (live.mx - live.px) / live.z, dy = (live.my - live.py) / live.z;
      view.z = z; view.px = mx - dx * z; view.py = my - dy * z; view.fitted = false; draw(); renderPins(); return;
    }
    if (live.kind === 'pan') { view.px = live.px + e.clientX - live.sx; view.py = live.py + e.clientY - live.sy; view.fitted = false; draw(); renderPins(); return; }
    if (live.kind === 'stroke' || live.kind === 'mask') {
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e], P = live.op.pts;
      for (const ce of (evs.length ? evs : [e])) {
        const [cx, cy] = toDoc(ce), L = P[P.length - 1];
        if (Math.hypot(cx - L[0], cy - L[1]) * view.z < 1.2) continue;
        P.push(pt(ce, cx, cy));
      }
      liveFrame(); draw(); return;
    }
    if (live.kind === 'shape') {
      let x1 = x, y1 = y; const o = live.op;
      if (e.shiftKey) {
        const dx = x - o.x0, dy = y - o.y0;
        if (o.t === 'rect' || o.t === 'ellipse') { const m = Math.max(Math.abs(dx), Math.abs(dy)); x1 = o.x0 + Math.sign(dx || 1) * m; y1 = o.y0 + Math.sign(dy || 1) * m; }
        else { const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4, L = Math.hypot(dx, dy); x1 = o.x0 + Math.cos(a) * L; y1 = o.y0 + Math.sin(a) * L; }
      }
      o.x1 = r1(x1); o.y1 = r1(y1); liveFrame(); draw(); return;
    }
    if (live.kind === 'move') {
      const dx = x - live.lx, dy = y - live.ly; if (!dx && !dy) return;
      for (const st of sel) moveOp(st, dx, dy); live.lx = x; live.ly = y; live.moved = true;
      renderLayer(skL, sk.strokes, k, false); draw(); return;
    }
    if (live.kind === 'box') { live.x1 = x; live.y1 = y; draw(); }
  }
  function onUp(e) {
    if (e.pointerType === 'touch') touches.delete(e.pointerId);
    if (pend && pend.ev.pointerId === e.pointerId) { if (e.type === 'pointercancel') { clearTimeout(pend.timer); pend = null; return; } flushPend(); }
    if (!live) return;
    const L = live;
    if (L.kind === 'pinch') { if (touches.size === 0) live = null; return; }
    live = null; root.classList.remove('panning');
    if (e.type === 'pointercancel' && L.kind !== 'move') { draw(); return; }
    if (L.kind === 'stroke') { commit(() => sk.strokes.push(L.op)); renderLayer(skL, sk.strokes, k, false); }
    else if (L.kind === 'mask') { commit(() => sk.mask.push(L.op)); renderLayer(mkL, sk.mask, k, true); tintFrom(mkL); }
    else if (L.kind === 'shape') {
      if (Math.hypot(L.op.x1 - L.op.x0, L.op.y1 - L.op.y0) * view.z >= 2) commit(() => sk.strokes.push(L.op));
      renderLayer(skL, sk.strokes, k, false);
    } else if (L.kind === 'move') { if (L.moved) commit(() => {}, L.before); }
    else if (L.kind === 'box') {
      const a = Math.min(L.x0, L.x1), b = Math.min(L.y0, L.y1), c = Math.max(L.x0, L.x1), d = Math.max(L.y0, L.y1);
      if (!L.add) sel.clear();
      for (const st of sk.strokes) { const [p, q, r, s] = bbox(st); if (p < c && r > a && q < d && s > b) sel.add(st); }
    }
    draw();
  }
  cv.addEventListener('pointerdown', onDown);
  cv.addEventListener('pointermove', onMove);
  cv.addEventListener('pointerup', onUp);
  cv.addEventListener('pointercancel', onUp);
  cv.addEventListener('pointerleave', () => { if (!live) { hover = null; draw(); } });
  cv.addEventListener('contextmenu', (e) => e.preventDefault());
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) setZoom(view.z * Math.exp(-clamp(e.deltaY, -100, 100) * 0.0035), e.clientX - r.left, e.clientY - r.top);
    else { view.px -= e.shiftKey ? e.deltaY : e.deltaX; view.py -= e.shiftKey ? 0 : e.deltaY; view.fitted = false; draw(); renderPins(); }
  }, { passive: false });

  // ---------------- commands
  function clear(which) {
    if (!which) which = tool.startsWith('mask') ? 'mask' : 'sketch';
    commit(() => {
      if (which === 'sketch' || which === 'all') sk.strokes = [];
      if (which === 'mask' || which === 'all') sk.mask = [];
      if (which === 'pins' || which === 'all') sk.pins = [];
    });
    sel.clear(); rebuild(); syncPins();
  }
  function copy() { CLIP = clone({ w: sk.w, h: sk.h, strokes: sk.strokes, mask: sk.mask, pins: sk.pins, from: sk.id }); flash('copied sketch'); return clipboard.get(); }
  function paste(data = CLIP) {
    if (!data) { flash('clipboard empty'); return false; }
    const d = clone(data), f = Math.min(sk.w / d.w, sk.h / d.h), ox = (sk.w - d.w * f) / 2, oy = (sk.h - d.h * f) / 2;
    d.strokes.forEach(st => scaleOp(st, f, ox, oy)); d.mask.forEach(st => scaleOp(st, f, ox, oy));
    commit(() => {
      sk.strokes.push(...d.strokes); sk.mask.push(...d.mask);
      for (const p of d.pins) sk.pins.push({ ...p, x: r1(p.x * f + ox), y: r1(p.y * f + oy) });
      renumber();
    });
    rebuild(); syncPins();
    if (d.strokes.length) { setTool('select'); sel = new Set(sk.strokes.slice(-d.strokes.length)); draw(); }
    flash('pasted'); return true;
  }
  function duplicate() {
    const c = normalize({ ...clone(sk), id: uid(), created: now(), updated: now() });
    emit('duplicate', c); opts.onDuplicate?.(c); return c;
  }
  let flashT = 0;
  function flash(msg) { imgMsg = msg; draw(); clearTimeout(flashT); flashT = setTimeout(() => { if (imgMsg === msg) { imgMsg = ''; draw(); } }, 1400); }
  async function exportPNG({ scale = 1 } = {}) { return toBlob(await renderSketch(sk, { scale, resolve, img })); }
  async function exportMask({ scale = 1 } = {}) { return toBlob(renderMask(sk, { scale })); }
  let saving = null;
  async function save() {
    if (saving) return saving;
    saving = (async () => {
      const data = api.get(), png = await exportPNG(), mask = sk.mask.length ? await exportMask() : null;
      if (opts.save) await opts.save(data, png, mask);
      dirty = false; draw(); emit('save', data, png, mask); flash('saved'); return data;
    })();
    try { return await saving; } catch (e) { flash('save failed: ' + (e.message || e)); throw e; } finally { saving = null; }
  }
  function deleteSel() { if (!sel.size) return; commit(() => { sk.strokes = sk.strokes.filter(st => !sel.has(st)); }); sel.clear(); rebuild(); }

  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act],[data-col]'); if (!b || !root.contains(b)) return;
    if (b.dataset.col) { setColor(b.dataset.col); return; }
    const a = b.dataset.act;
    if (a.startsWith('tool:')) setTool(a.slice(5));
    else ({ undo, redo, clear: () => clear(), copy, paste: () => paste(), dup: duplicate, fit, z100: () => setZoom(1), save: () => save().catch(() => {}) })[a]?.();
  });
  sizeIn.addEventListener('change', () => setSize(+sizeIn.value || 1));
  opIn.addEventListener('change', () => setOpacity((+opIn.value || 100) / 100));
  colIn.addEventListener('input', () => setColor(colIn.value));
  $('.sk-vis-sketch').addEventListener('change', (e) => { vis.sketch = e.target.checked; draw(); });
  $('.sk-vis-mask').addEventListener('change', (e) => { vis.mask = e.target.checked; draw(); });
  let ulBefore = null;
  $('.sk-ulop').addEventListener('pointerdown', () => { ulBefore = snap(); });
  $('.sk-ulop').addEventListener('input', (e) => { if (sk.underlay) { if (!ulBefore) ulBefore = snap(); sk.underlay.opacity = +e.target.value / 100; draw(); } });
  $('.sk-ulop').addEventListener('change', () => { if (ulBefore) commit(() => {}, ulBefore); ulBefore = null; });
  $('.sk-ulfit').addEventListener('change', (e) => { if (sk.underlay) commit(() => { sk.underlay.fit = e.target.value; }); draw(); });
  $('.sk-pinclear').addEventListener('click', () => clear('pins'));

  // ---------------- keyboard (only while focus is inside the tool; handled keys never reach the workbench keymap)
  root.addEventListener('keydown', (e) => {
    const tg = e.target, typing = (tg.tagName === 'INPUT' && !/^(range|checkbox|color|button)$/.test(tg.type)) || tg.tagName === 'TEXTAREA' || tg.tagName === 'SELECT';
    const ctrl = e.ctrlKey || e.metaKey, key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    let done = true;
    if (ctrl && key === 's') save().catch(() => {});
    else if (typing) done = false;
    else if (ctrl && key === 'z') e.shiftKey ? redo() : undo();
    else if (ctrl && key === 'y') redo();
    else if (ctrl && key === 'c') copy();
    else if (ctrl && key === 'v') paste();
    else if (ctrl && key === 'd') duplicate();
    else if (ctrl && key === '0') fit();
    else if (ctrl && key === '1') setZoom(1);
    else if (ctrl) done = false;
    else if (key === ' ') { if (!spaceDown) { spaceDown = true; root.classList.add('space'); } }
    else if (key === 'm' && e.shiftKey) setTool('maskerase');
    else if (KEY_TOOL[key] && !e.altKey) setTool(KEY_TOOL[key]);
    else if (key === '[') setSize(sizes[sizeKey(tool)] * (e.shiftKey ? 0.5 : 0.8) - 0.5);
    else if (key === ']') setSize(sizes[sizeKey(tool)] * (e.shiftKey ? 2 : 1.25) + 0.5);
    else if (key === '0') fit();
    else if (key === '1') setZoom(1);
    else if (key === '+' || key === '=') setZoom(view.z * 1.25);
    else if (key === '-') setZoom(view.z / 1.25);
    else if (key === 'Delete' || key === 'Backspace') deleteSel();
    else if (key === 'Escape') { if (live) { live = null; rebuild(); } else if (sel.size) { sel.clear(); draw(); } else if (api.requestClose) api.requestClose(); else done = false; }
    else done = false;
    if (done) { e.preventDefault(); e.stopPropagation(); }
  });
  root.addEventListener('keyup', (e) => { if (e.key === ' ') { spaceDown = false; root.classList.remove('space'); e.stopPropagation(); } });
  root.addEventListener('blur', () => { spaceDown = false; root.classList.remove('space'); }, true);

  const ro = new ResizeObserver(() => resize());
  ro.observe(stage);

  function load(s) {
    sk = normalize(s); sizeFromUnderlay = false; undoS = []; redoS = []; dirty = false; sel.clear();
    allocLayers(); loadUnderlay(); rebuild(); syncPins(); syncPanel(); fit();
  }

  const api = {
    get el() { return root; }, get dirty() { return dirty; }, get tool() { return tool; }, get view() { return { ...view }; },
    get color() { return color; }, get size() { return sizes[sizeKey(tool)]; }, get opacity() { return opacity; },
    get canUndo() { return undoS.length > 0; }, get canRedo() { return redoS.length > 0; },
    get selection() { return sk.strokes.map((s, i) => sel.has(s) ? i : -1).filter(i => i >= 0); },
    get: () => clone(sk),
    load, setTool, setColor, setSize, setOpacity, undo, redo, clear, copy, paste, duplicate, addPin, updatePin, removePin, focusPin,
    setUnderlay(u) { commit(() => { sk.underlay = u && u.src ? { opacity: 1, fit: 'contain', ...u } : null; }); loadUnderlay(); syncPanel(); },
    setVisible(layer, on) { vis[layer] = !!on; syncPanel(); draw(); },
    fit, zoom100: () => setZoom(1), setZoom,
    toScreen: (x, y) => { const r = cv.getBoundingClientRect(); return [r.left + view.px + x * view.z, r.top + view.py + y * view.z]; },
    exportPNG, exportMask,
    renderPNGCanvas: (o = {}) => renderSketch(sk, { resolve, img, ...o }), renderMaskCanvas: (o = {}) => renderMask(sk, o),
    save, markClean() { dirty = false; draw(); },
    on(n, f) { if (!handlers.has(n)) handlers.set(n, new Set()); handlers.get(n).add(f); return () => handlers.get(n).delete(f); },
    emit, requestClose: null,
    destroy() { ro.disconnect(); cancelAnimationFrame(raf); root.remove(); handlers.clear(); },
  };

  allocLayers(); setTool('pen'); loadUnderlay(); rebuild(); syncPins(); syncPanel(); resize();
  return api;
}

// ------------------------------------------------------------------------------------------------ floating window
let zTop = 9000;
export function openSketch(opts = {}) {
  ensureCss();
  const win = document.createElement('div');
  win.className = 'sk-win'; win.setAttribute('role', 'dialog'); win.setAttribute('aria-label', opts.title || 'Sketch');
  const W = Math.min(opts.width || 960, innerWidth - 20), H = Math.min(opts.height || 640, innerHeight - 20);
  win.style.width = W + 'px'; win.style.height = H + 'px';
  win.style.left = (opts.x ?? Math.max(10, (innerWidth - W) / 2)) + 'px'; win.style.top = (opts.y ?? Math.max(10, (innerHeight - H) / 2)) + 'px';
  win.style.zIndex = ++zTop;
  win.innerHTML = `<div class="sk-wtitle"><span></span><button type="button" class="sk-b sk-wclose" title="Close (Esc)" aria-label="Close sketch">${ICON.close}</button></div><div class="sk-wbody"></div>`;
  win.querySelector('.sk-wtitle span').textContent = opts.title || 'Sketch';
  document.body.appendChild(win);
  const api = mountSketch(win.querySelector('.sk-wbody'), opts);
  const confirmEl = api.el.querySelector('.sk-confirm');
  let closed = false;
  function close(force = false) {
    if (closed) return true;
    if (!force && api.dirty) { confirmEl.hidden = false; confirmEl.querySelector('[data-cf=save]').focus(); return false; }
    closed = true; api.emit('close'); opts.onClose?.(); api.destroy(); win.remove(); return true;
  }
  confirmEl.addEventListener('click', async (e) => {
    const a = e.target.dataset?.cf; if (!a) return;
    confirmEl.hidden = true;
    if (a === 'save') { try { await api.save(); close(true); } catch { /* stays open; the HUD says why */ } }
    else if (a === 'discard') close(true);
    else api.el.focus();
  });
  confirmEl.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); confirmEl.hidden = true; api.el.focus(); } });
  api.requestClose = () => close(false);
  api.close = close;
  api.window = win;
  win.querySelector('.sk-wclose').addEventListener('click', () => close(false));
  win.addEventListener('pointerdown', () => { win.style.zIndex = ++zTop; }, true);
  const bar = win.querySelector('.sk-wtitle');
  bar.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    e.preventDefault(); bar.setPointerCapture(e.pointerId);
    const sx = e.clientX - win.offsetLeft, sy = e.clientY - win.offsetTop;
    const mv = (ev) => { win.style.left = clamp(ev.clientX - sx, -win.offsetWidth + 60, innerWidth - 60) + 'px'; win.style.top = clamp(ev.clientY - sy, 0, innerHeight - 24) + 'px'; };
    const up = () => { bar.removeEventListener('pointermove', mv); bar.removeEventListener('pointerup', up); };
    bar.addEventListener('pointermove', mv); bar.addEventListener('pointerup', up);
  });
  api.el.focus({ preventScroll: true });
  return api;
}
