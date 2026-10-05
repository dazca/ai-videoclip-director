// E5, placeholder frames (ROADMAP_v4; PRODUCTION.md: "A clip that does not exist yet must be drawn as a neutral placeholder
// frame with its id, so chapters can be built before the footage lands"). Pure functions, no DOM and no Node APIs: the
// storyboard cards, the timeline's shots column and the composition export (exporters/composition-data.mjs, edl.json
// `placeholder.svg`) draw the SAME frame from the shot's own data: its id, kind, time, text (or title), world and cast.
// A neutral 16:9 SVG (320x180), deterministic (the same shot = the same bytes), every text XML-escaped, no script, no
// external reference, no font beyond the generic families: safe as <img src="data:..."> and as a file.
//
//   placeholderFor(shot, {entities, scenes}) -> {id, label, kind, time, text, cast[], world, svg}
//   placeholderSvg(info)                       -> the SVG text
//   placeholderUri(svg)                        -> a data: URI for <img src>
const X = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clean = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
const clock = (ms) => { const s = Math.max(0, Number(ms) || 0) / 1000, m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`; };
// greedy word wrap into at most `lines` lines of `w` characters (the last one ends with … when cut)
export function wrap(text, w = 40, lines = 3) {
  const words = clean(text).split(' ').filter(Boolean), out = [];
  let cur = '';
  for (const word of words) {
    const wd = word.length > w ? word.slice(0, w - 1) + '…' : word;
    if (!cur) cur = wd; else if ((cur + ' ' + wd).length <= w) cur += ' ' + wd; else { out.push(cur); cur = wd; }
    if (out.length === lines) break;
  }
  if (cur && out.length < lines) out.push(cur);
  const cut = out.join(' ').length < clean(text).length;
  if (cut && out.length) { const l = out[out.length - 1]; out[out.length - 1] = (l.length >= w ? l.slice(0, w - 1) : l) + '…'; }
  return out;
}
export function placeholderSvg({ id = '', kind = '', time = '', text = '', cast = [], world = null, reason = null } = {}) {
  const lines = wrap(text, 40, 3), who = clean((cast || []).join(', '));
  const t = (x, y, s, fill, body, extra = '') => `<text x="${x}" y="${y}" font-size="${s}" fill="${fill}"${extra}>${X(body)}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180" width="320" height="180" font-family="Segoe UI, Arial, sans-serif">`
    + `<rect width="320" height="180" fill="#2a2c30"/><path d="M0 0L320 180M320 0L0 180" stroke="#34373c" stroke-width="1"/>`
    + `<rect x="0.5" y="0.5" width="319" height="179" fill="none" stroke="#5a5e66" stroke-dasharray="4 3"/>`
    + `<rect x="8" y="8" width="${Math.min(200, 12 + clean(id).length * 11)}" height="26" fill="#1c1d20"/>`
    + t(14, 27, 18, '#f0f0f0', clean(id).slice(0, 40), ' font-family="Consolas, monospace" font-weight="bold"')
    + t(312, 22, 11, '#c9ccd1', [clean(kind), clean(time)].filter(Boolean).join(' · '), ' text-anchor="end"')
    + (world ? t(312, 36, 10, '#d9a86c', `world: ${clean(world)}`, ' text-anchor="end"') : '')
    + lines.map((l, i) => t(14, 76 + i * 18, 13, '#d4d6da', l)).join('')
    + (who ? t(14, 150, 11, '#9fb4c8', `with ${who}`.slice(0, 52)) : '')
    + t(14, 168, 9, '#7d828a', `PLACEHOLDER${reason ? ' · ' + clean(reason) : ''} · no frame or take yet`, ' letter-spacing="1"')
    + `</svg>`;
}
export const placeholderUri = (svg) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
// the placeholder of one storyboard shot: names from the entities, the world from the shot or its scene
export function placeholderFor(shot, { entities = [], scenes = [], reason = null } = {}) {
  const sc = (scenes || []).find(x => x.id === shot?.scene) || null;
  const name = (id) => (entities || []).find(e => e?.id === id)?.name || id;
  const cast = (shot?.cast || []).map(name);
  const text = clean(shot?.text) || clean(shot?.title) || clean(sc?.title) || '';
  const world = shot?.context || sc?.context || null;
  const info = { id: shot?.id || '', kind: shot?.kind || '', time: shot ? `${clock(shot.t0)}–${clock(shot.t1)}` : '', text, cast, world, reason };
  return { id: info.id, label: clean(shot?.title) || info.id, kind: info.kind, time: info.time, text, cast, world, svg: placeholderSvg(info) };
}
// a shot shows a placeholder when it has no frame (sketch, render thumb) and no picked take
export const needsPlaceholder = (shot) => !!shot && !shot.sketch && !shot.thumb && !shot.clip?.file;
