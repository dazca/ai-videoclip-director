// The free local proposal generator (docs/SPEC_v4_NOTES_ROUNDS.md §3, ROADMAP_v4 B11): without any agent connected, 3
// SVG layouts per scene (its sketch) or per shot (its frame), made deterministically from the script: the framing (wide /
// medium / close), rule-of-thirds silhouettes (one per cast member, up to 3), a horizon and colour blocks in the scene's
// palette (its cast's look colours, else words of its text: night, dawn, neon, ...), and a camera arrow read from the
// beat text (push in, pull out, pan, tilt, orbit, handheld, static). Pure functions, no DOM, no Node APIs: the server
// runs it (lib/ops/proposals.mjs proposals_local, through the same SVG sanitiser as an agent's proposals).
//   localSceneItems(scene, {cast?, palette?}) -> [{title, why, svg}] x3
//   localShotItems(shot, {scene?, cast?, palette?}) -> [{title, why, svg}] x3
//   paletteFor(text, colors?) -> [bg, ground, figure, accent]

const W = 160, H = 90;   // 16:9, small numbers keep the files tiny
const r1 = (v) => Math.round(v * 10) / 10;
const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const hash = (s) => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
const HEX = /^#[0-9a-fA-F]{6}$/;
const lum = (h) => { const v = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
// a colour that reads on `bg`: c itself, else white / near-black
const onBg = (c, bg) => Math.abs(lum(c) - lum(bg)) >= 0.22 ? c : lum(bg) < 0.45 ? '#f2f2f2' : '#151515';

// the palette: [background, ground, figures, accent]
const MOODS = [
  [/\b(night|dark|midnight|moon|black)\b/i, ['#141a2e', '#0b0e17', '#d8d2c4', '#4f79c0']],
  [/\b(neon|club|disco|rave|lights?)\b/i, ['#1d0f2b', '#110818', '#f1e9ff', '#ff3fa4']],
  [/\b(dawn|sunrise|morning|pink)\b/i, ['#f3c6b4', '#7d5a6b', '#2b2230', '#ff9a62']],
  [/\b(dusk|sunset|golden|evening)\b/i, ['#e8955a', '#5a3328', '#24161a', '#ffd27a']],
  [/\b(rain|storm|grey|gray|fog|mist)\b/i, ['#8a929c', '#4b525b', '#1f2328', '#c9d3dd']],
  [/\b(sea|ocean|beach|water|blue)\b/i, ['#9fc8de', '#2f6f8f', '#1b2a33', '#f2e4c4']],
  [/\b(forest|green|park|garden|grass)\b/i, ['#b9cfa4', '#3f5a32', '#1c2418', '#e7d36f']],
  [/\b(studio|screen|test card|white|wall)\b/i, ['#e9e6df', '#b7b2a8', '#25272b', '#ff8844']],
];
export function paletteFor(text, colors = []) {
  const base = (MOODS.find(([re]) => re.test(String(text || ''))) || [null, ['#d9d4c9', '#8f877a', '#2a2724', '#c0503a']])[1].slice();
  const c = (colors || []).filter(x => HEX.test(String(x)));
  if (c[0]) base[2] = c[0];          // the figures wear the cast's first look colour
  if (c[1]) base[3] = c[1];          // the accent: the second
  return base;
}

// the camera move a beat's words ask for (else the framing's default)
const MOVES = [
  [/\bpush(es|ing)? in|dolly in|zoom in|closer|approach/i, 'push in'], [/\bpull(s|ing)? (out|back)|dolly out|zoom out|reveal/i, 'pull out'],
  [/\bpan(s|ning)? left|to the left|leftward/i, 'pan left'], [/\bpan(s|ning)?( right)?\b|to the right|rightward|walks?|runs?|across/i, 'pan right'],
  [/\btilt(s|ing)? up|look(s|ing)? up|rises?|up to|sky/i, 'tilt up'], [/\btilt(s|ing)? down|look(s|ing)? down|falls?|drops?/i, 'tilt down'],
  [/\borbit|circles?|around|spin/i, 'orbit'], [/\bhandheld|shaky|chase|frantic|dance|jump/i, 'handheld'], [/\bstill|static|locked|tripod|waits?|frozen/i, 'static'],
];
export const moveFor = (text, dflt) => (MOVES.find(([re]) => re.test(String(text || ''))) || [null, dflt])[1];

// --------------------------------------------------------------------------------------------- drawing
function figure(x, base, h, fill, crop) {
  // a silhouette standing on `base` (y), `h` tall: head, neck, rounded shoulders; crop = the frame's bottom (medium /
  // close shots are cut by it)
  const hr = h * 0.105, cy = base - h + hr, sy = cy + hr * 1.55, bw = h * 0.34, bot = crop ? Math.min(base, crop + 2) : base, c = bw * 0.28;
  return `<g fill="${fill}"><circle cx="${r1(x)}" cy="${r1(cy)}" r="${r1(hr)}"/><rect x="${r1(x - hr * 0.42)}" y="${r1(cy + hr * 0.6)}" width="${r1(hr * 0.84)}" height="${r1(hr * 1.2)}"/>`
    + `<path d="M${r1(x - bw / 2)} ${r1(bot)} L${r1(x - bw / 2)} ${r1(sy + c)} Q${r1(x - bw / 2)} ${r1(sy)} ${r1(x - bw / 2 + c)} ${r1(sy)} L${r1(x + bw / 2 - c)} ${r1(sy)} Q${r1(x + bw / 2)} ${r1(sy)} ${r1(x + bw / 2)} ${r1(sy + c)} L${r1(x + bw / 2)} ${r1(bot)} Z"/></g>`;
}
function arrow(move, col) {
  const cx = W / 2, cy = H / 2, a = (x1, y1, x2, y2) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${col}" stroke-width="1.6" marker-end="url(#ah)"/>`;
  switch (move) {
    case 'push in': return [[18, 12, 38, 26], [142, 12, 122, 26], [18, 78, 38, 64], [142, 78, 122, 64]].map(p => a(...p)).join('');
    case 'pull out': return [[48, 32, 22, 14], [112, 32, 138, 14], [48, 58, 22, 76], [112, 58, 138, 76]].map(p => a(...p)).join('');
    case 'pan left': return a(cx + 22, 10, cx - 22, 10);
    case 'pan right': return a(cx - 22, 10, cx + 22, 10);
    case 'tilt up': return a(150, cy + 18, 150, cy - 18);
    case 'tilt down': return a(150, cy - 18, 150, cy + 18);
    case 'orbit': return `<path d="M${cx - 30} 14 Q${cx} 2 ${cx + 30} 14" fill="none" stroke="${col}" stroke-width="1.6" marker-end="url(#ah)"/>`;
    case 'handheld': return `<polyline points="${cx - 24},12 ${cx - 16},7 ${cx - 8},13 ${cx},7 ${cx + 8},13 ${cx + 16},7 ${cx + 22},11" fill="none" stroke="${col}" stroke-width="1.4" marker-end="url(#ah)"/>`;
    default: return `<rect x="${cx - 5}" y="5" width="10" height="7" rx="1" fill="none" stroke="${col}" stroke-width="1.2"/><line x1="${cx}" y1="12" x2="${cx - 4}" y2="17" stroke="${col}" stroke-width="1.2"/><line x1="${cx}" y1="12" x2="${cx + 4}" y2="17" stroke="${col}" stroke-width="1.2"/>`;
  }
}
// one layout: framing wide | medium | close, the figures on the thirds (side: which third leads), a move, a palette
export function layoutSvg({ framing, side = 'left', n = 1, move = 'static', pal, label = '', seed = 0 }) {
  const [bg, ground, fig0, acc0] = pal, fig = onBg(fig0, bg), acc = onBg(acc0, bg);
  const hor = framing === 'wide' ? 60 : framing === 'medium' ? 66 : 74;            // the horizon (a low-angle close: lower)
  const hgt = framing === 'wide' ? 34 : framing === 'medium' ? 80 : 128;           // figure height
  const base = framing === 'wide' ? 74 : framing === 'medium' ? 112 : 150;         // where the feet would be
  const thirds = side === 'left' ? [W / 3, W * 2 / 3, W / 2] : [W * 2 / 3, W / 3, W / 2];
  const count = framing === 'close' ? 1 : Math.max(1, Math.min(3, n));
  const jitter = (k) => ((hash(seed + ':' + k) % 9) - 4);
  let figs = '';
  for (let k = count - 1; k >= 0; k--) {   // the lead figure last (in front)
    const x = thirds[k] + (k ? jitter(k) : 0), h = hgt * (k ? 0.86 : 1);
    figs += figure(x, base - (k ? 2 : 0), h, k ? acc : fig, H);
  }
  const block = framing === 'wide' ? `<rect x="${side === 'left' ? W * 2 / 3 + 6 : 6}" y="${hor - 22}" width="${W / 3 - 12}" height="22" fill="${acc}" opacity="0.55"/>` : '';
  const grid = [W / 3, W * 2 / 3].map(x => `<line x1="${r1(x)}" y1="0" x2="${r1(x)}" y2="${H}"/>`).join('') + [H / 3, H * 2 / 3].map(y => `<line x1="0" y1="${r1(y)}" x2="${W}" y2="${r1(y)}"/>`).join('');
  const ink = /^#[0-4]/.test(bg) ? '#ffffff' : '#111111';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W * 8}" height="${H * 8}">`
    + `<defs><marker id="ah" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6 Z" fill="${acc === fig ? ink : acc}"/></marker></defs>`
    + `<rect x="0" y="0" width="${W}" height="${H}" fill="${bg}"/><rect x="0" y="${hor}" width="${W}" height="${H - hor}" fill="${ground}"/>${block}`
    + `<g stroke="${ink}" stroke-opacity="0.18" stroke-width="0.4" stroke-dasharray="2 2">${grid}</g>${figs}`
    + `<g opacity="0.9">${arrow(move, acc === fig ? ink : acc)}</g>`
    + (label ? `<rect x="2" y="${H - 10}" width="${r1(label.length * 3 + 5)}" height="8" rx="1.5" fill="#000000" fill-opacity="0.55"/><text x="4.5" y="${H - 4}" font-family="Segoe UI, Arial, sans-serif" font-size="5.5" fill="#ffffff">${xmlEsc(label)}</text>` : '')
    + `</svg>`;
}

// --------------------------------------------------------------------------------------------- items
const FR = { wide: 'Wide', medium: 'Medium', close: 'Close' };
const DEFAULT_MOVE = { wide: 'pan right', medium: 'push in', close: 'static' };
function beatTexts(o) { return (o.beats || []).map(b => (typeof b === 'string' ? b : b?.text) || '').filter(Boolean); }
function items(id, text, beats, layouts, { cast = [], palette } = {}) {
  const pal = palette || paletteFor([text, ...beats].join(' '));
  const who = cast.length ? cast.slice(0, 3).join(', ') : 'one figure';
  return layouts.map(({ framing, side, beat }, k) => {
    const bt = beats[beat] ?? beats[0] ?? text, move = moveFor(bt, DEFAULT_MOVE[framing]);
    const svg = layoutSvg({ framing, side, n: Math.max(1, cast.length), move, pal, label: `${FR[framing].toUpperCase()} · ${move}`, seed: `${id}:${k}` });
    const title = `${FR[framing]} · ${framing === 'close' ? 'face' : cast.length > 1 && framing === 'wide' ? `${Math.min(3, cast.length)} figures` : 'figure'} on the ${side} third`;
    const why = clip(`${framing === 'wide' ? 'Establishes the place' : framing === 'medium' ? 'Body language and the action' : 'The emotion, up close'}; ${who}; ${move}${bt ? ` from “${clip(bt, 60)}”` : ''}.`, 280);
    return { title, why, svg };
  });
}
// a scene: wide / medium / close, alternating thirds, each from its own beat when it has some
export function localSceneItems(scene, opts = {}) {
  const beats = beatTexts(scene), text = [scene.title, scene.text].filter(Boolean).join('. ');
  const side = hash(scene.id) % 2 ? 'right' : 'left', other = side === 'left' ? 'right' : 'left';
  return items(scene.id, text, beats, [{ framing: 'wide', side, beat: 0 }, { framing: 'medium', side: other, beat: 1 }, { framing: 'close', side, beat: 2 }], { ...opts, palette: opts.palette || paletteFor([text, ...beats].join(' '), opts.colors) });
}
// a shot: its own kind first (both thirds), then the next framing in (or out, for a close)
export function localShotItems(shot, opts = {}) {
  const k = /close|insert/.test(shot.kind || '') ? 'close' : /wide|establish/.test(shot.kind || '') ? 'wide' : 'medium';
  const next = k === 'close' ? 'medium' : k === 'wide' ? 'medium' : 'close';
  const beats = [shot.camera, shot.text, ...beatTexts(opts.scene || {})].filter(Boolean), text = [shot.title, shot.text, opts.scene?.text].filter(Boolean).join('. ');
  return items(shot.id, text, beats, [{ framing: k, side: 'left', beat: 0 }, { framing: k, side: 'right', beat: 1 }, { framing: next, side: 'left', beat: 0 }], { ...opts, palette: opts.palette || paletteFor([text, ...beats].join(' '), opts.colors) });
}
