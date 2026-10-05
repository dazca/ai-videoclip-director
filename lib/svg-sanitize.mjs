// The SVG sanitiser for proposals (docs/SPEC_v4_NOTES_ROUNDS.md §3, ROADMAP_v4 B9). An agent's SVG is untrusted: it is
// parsed by a small strict tokenizer (no DTD, no CDATA, quoted attributes only), checked against an ALLOW-LIST of
// elements and attributes, and written out again from the parsed tree (values re-escaped), so what reaches the disk is
// only what the allow-list describes. Anything else is REJECTED with the reason (an agent can fix and retry):
//   - elements outside the list: script, foreignObject, image, a, style, iframe, animate / set (they can rewrite href),
//     filter primitives that load (feImage), anything unknown
//   - attributes outside the list, every on* handler, href / xlink:href except "#id" on <use>, any url(...) except
//     url(#id), javascript: / data: / vbscript: anywhere, a style attribute with url( / expression / @import / \ escapes
//   - named entities other than the five XML ones (no DTD), a DOCTYPE, CDATA, any processing instruction but the
//     leading <?xml …?> declaration
//   - more than 64 KB, more than 4000 elements, nesting deeper than 40, a root that is not <svg>
//   - a viewBox that is not 4 finite numbers with 0 < w, h <= 10000 and an aspect between 1:4 and 4:1 (when missing, it
//     is made from width / height, else refused)
// The page then shows the file only as <img src> (an SVG in an <img> never runs script), and the server serves project
// files with a sandboxing CSP: three walls, each enough on its own.
//   sanitizeSvg(string) -> {svg, w, h, elements}   throws SvgError(400, reason)
export class SvgError extends Error { constructor(msg) { super(msg); this.code = 400; } }
const bad = (m) => { throw new SvgError('svg: ' + m); };
export const SVG_MAX = 64 * 1024;

const ELEMENTS = new Set(['svg', 'g', 'defs', 'title', 'desc', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'path',
  'text', 'tspan', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'pattern', 'marker', 'symbol', 'use']);
const TEXT_EL = new Set(['text', 'tspan', 'title', 'desc']);
const ATTRS = new Set(['id', 'viewBox', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'fx', 'fy', 'd', 'points',
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-linecap',
  'stroke-linejoin', 'stroke-miterlimit', 'opacity', 'transform', 'font-size', 'font-family', 'font-weight', 'font-style', 'text-anchor',
  'dominant-baseline', 'letter-spacing', 'dx', 'dy', 'offset', 'stop-color', 'stop-opacity', 'gradientUnits', 'gradientTransform',
  'spreadMethod', 'markerWidth', 'markerHeight', 'markerUnits', 'refX', 'refY', 'orient', 'marker-start', 'marker-mid', 'marker-end',
  'clip-path', 'clip-rule', 'clipPathUnits', 'mask', 'maskUnits', 'patternUnits', 'patternTransform', 'preserveAspectRatio', 'paint-order',
  'vector-effect', 'visibility', 'display', 'version', 'style', 'xmlns', 'xmlns:xlink', 'href', 'xlink:href', 'xml:space']);
const NS = { xmlns: 'http://www.w3.org/2000/svg', 'xmlns:xlink': 'http://www.w3.org/1999/xlink' };
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
// what may never appear in any value, once entities are decoded (and with whitespace / controls removed)
const DANGER = /(javascript|vbscript|data|livescript)\s*:|expression\s*\(|@import|-moz-binding|behavior\s*:/i;
const URL_REF = /url\s*\(/i, URL_OK = /^url\(\s*#[A-Za-z_][\w.-]{0,63}\s*\)$/;

function decode(s, where) {
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{0,31});?/g, (m, e) => {
    if (!m.endsWith(';')) bad(`an entity without ";" in ${where}`);
    if (e[0] === '#') { const c = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); if (!(c > 0 && c <= 0x10ffff)) bad(`a bad character reference in ${where}`); return String.fromCodePoint(c); }
    if (!(e in ENT)) bad(`the entity &${e}; (only &amp; &lt; &gt; &quot; &apos; and numeric ones; no DTD)`);
    return ENT[e];
  });
}
const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const escText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// eslint-disable-next-line no-control-regex
const INVIS = new RegExp('[\\s\\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]+', 'g');
const squash = (v) => v.replace(INVIS, '');

function checkValue(el, name, v) {
  if (v.length > 20000) bad(`<${el} ${name}> is too long`);
  const flat = squash(v);
  if (DANGER.test(flat) || DANGER.test(v)) bad(`<${el} ${name}="…"> holds a script / data URL or a CSS expression`);
  if (name === 'href' || name === 'xlink:href') {
    if (el !== 'use') bad(`${name} is allowed only on <use> (an internal "#id")`);
    if (!/^#[A-Za-z_][\w.-]{0,63}$/.test(v.trim())) bad(`<use ${name}="${v.slice(0, 40)}">: only an internal reference "#id" (no external files)`);
    return v.trim();
  }
  if (name === 'xmlns' || name === 'xmlns:xlink') { if (v !== NS[name]) bad(`${name} must be ${NS[name]}`); return v; }
  if (name === 'style') {
    if (/url\s*\(|[\\<>]|\/\*/i.test(v) || /url\(/i.test(flat)) bad(`<${el} style="…">: no url(), escapes or comments in a style`);
    return v;
  }
  if (URL_REF.test(v) || /url\(/i.test(flat)) {
    if (!['fill', 'stroke', 'clip-path', 'mask', 'marker-start', 'marker-mid', 'marker-end'].includes(name) || !URL_OK.test(v.trim())) bad(`<${el} ${name}="${v.slice(0, 40)}">: only url(#id) (an internal reference) is allowed`);
  }
  return v;
}

function viewBoxOf(attrs) {
  const num = (s) => { const m = /^\s*([0-9]*\.?[0-9]+(?:e[+-]?\d+)?)\s*(px)?\s*$/i.exec(s || ''); return m ? Number(m[1]) : null; };
  let vb = attrs.viewBox;
  if (vb == null) { const w = num(attrs.width), h = num(attrs.height); if (!(w > 0 && h > 0)) bad('the root <svg> needs a viewBox (or a numeric width and height)'); vb = `0 0 ${w} ${h}`; }
  const p = String(vb).trim().split(/[\s,]+/).map(Number);
  if (p.length !== 4 || !p.every(Number.isFinite)) bad('viewBox: four numbers "min-x min-y width height"');
  const [, , w, h] = p;
  if (!(w > 0 && h > 0 && w <= 10000 && h <= 10000)) bad('viewBox: width and height between 0 and 10000');
  if (w / h > 4 || h / w > 4) bad('viewBox: an aspect ratio between 1:4 and 4:1');
  return { vb: p.join(' '), w, h };
}

export function sanitizeSvg(input) {
  if (typeof input !== 'string' || !input.trim()) bad('an SVG string is required');
  if (Buffer.byteLength(input, 'utf8') > SVG_MAX) bad(`more than ${SVG_MAX / 1024} KB`);
  const s = input.replace(/^﻿/, '');
  let i = 0, root = null, count = 0;
  const stack = [], out = [];
  const node = (name, attrs) => ({ name, attrs, kids: [] });
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    const text = lt < 0 ? s.slice(i) : s.slice(i, lt);
    if (text) {
      if (text.trim()) {
        if (!stack.length) bad('text outside the root <svg>');
        const top = stack[stack.length - 1];
        if (TEXT_EL.has(top.name)) top.kids.push({ text: decode(text, `<${top.name}> text`) });
      }
    }
    if (lt < 0) break;
    i = lt;
    if (s.startsWith('<!--', i)) { const e = s.indexOf('-->', i + 4); if (e < 0) bad('an unclosed comment'); i = e + 3; continue; }
    if (s.startsWith('<![CDATA[', i)) bad('CDATA sections are not allowed');
    if (s.startsWith('<!', i)) bad('a DOCTYPE / declaration is not allowed (no DTD, no external entities)');
    if (s.startsWith('<?', i)) {
      // only the XML declaration, before the root (an <?xml-stylesheet?> could load a remote style sheet)
      if (root || i !== s.search(/\S/) || !/^<\?xml\s/.test(s.slice(i, i + 6))) bad('processing instructions are not allowed (only an <?xml …?> declaration at the start)');
      const e = s.indexOf('?>', i + 2); if (e < 0) bad('an unclosed <?xml …?>'); i = e + 2; continue;
    }
    if (s.startsWith('</', i)) {
      const m = /^<\/([A-Za-z_][\w:.-]*)\s*>/.exec(s.slice(i, i + 200)); if (!m) bad('a malformed closing tag');
      const top = stack.pop(); if (!top || top.name !== m[1]) bad(`</${m[1]}> does not close <${top ? top.name : 'nothing'}>`);
      i += m[0].length; continue;
    }
    const m = /^<([A-Za-z_][\w:.-]*)/.exec(s.slice(i, i + 200)); if (!m) bad('a "<" that does not start a tag (escape it as &lt;)');
    const name = m[1]; i += m[0].length;
    if (!ELEMENTS.has(name)) bad(`<${name}> is not allowed (allowed: ${[...ELEMENTS].join(', ')})`);
    const attrs = {};
    let selfClose = false;
    for (;;) {
      const ws = /^\s*/.exec(s.slice(i))[0]; i += ws.length;
      if (s.startsWith('/>', i)) { selfClose = true; i += 2; break; }
      if (s[i] === '>') { i += 1; break; }
      if (i >= s.length) bad(`an unclosed <${name}>`);
      if (!ws) bad(`<${name}>: attributes must be separated by spaces`);
      const a = /^([A-Za-z_][\w:.-]*)\s*=\s*("([^"<]*)"|'([^'<]*)')/.exec(s.slice(i, i + 21000));
      if (!a) { const nm = /^[^\s=/>]+/.exec(s.slice(i))?.[0] || s.slice(i, i + 20); bad(/^on/i.test(nm) ? `<${name} ${nm}>: event handlers (on*) are not allowed` : `<${name}>: "${nm}" must be name="quoted value" (no "<" inside)`); }
      const an = a[1];
      if (/^on/i.test(an)) bad(`<${name} ${an}>: event handlers (on*) are not allowed`);
      if (!ATTRS.has(an)) bad(`<${name} ${an}> is not an allowed attribute`);
      if (Object.hasOwn(attrs, an)) bad(`<${name}> repeats ${an}`);
      attrs[an] = checkValue(name, an, decode(a[3] ?? a[4], `<${name} ${an}>`));
      i += a[0].length;
    }
    if (++count > 4000) bad('more than 4000 elements');
    const n = node(name, attrs);
    if (!stack.length) { if (root) bad('more than one root element'); if (name !== 'svg') bad('the root element must be <svg>'); root = n; }
    else stack[stack.length - 1].kids.push(n);
    if (!selfClose) { stack.push(n); if (stack.length > 40) bad('nested deeper than 40'); }
  }
  if (stack.length) bad(`<${stack[stack.length - 1].name}> is not closed`);
  if (!root) bad('no <svg> element');
  const { vb, w, h } = viewBoxOf(root.attrs);
  root.attrs.viewBox = vb; root.attrs.xmlns = NS.xmlns;
  // written out again from the parsed tree: only allowed names, every value escaped
  const emit = (n) => {
    if (n.text != null) { out.push(escText(n.text)); return; }
    out.push(`<${n.name}${Object.entries(n.attrs).map(([k, v]) => ` ${k}="${escAttr(v)}"`).join('')}`);
    if (!n.kids.length) { out.push('/>'); return; }
    out.push('>'); n.kids.forEach(emit); out.push(`</${n.name}>`);
  };
  emit(root);
  const svg = out.join('');
  if (Buffer.byteLength(svg, 'utf8') > SVG_MAX * 1.5) bad('too large once written out');
  return { svg, w, h, elements: count };
}
