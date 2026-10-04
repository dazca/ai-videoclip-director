// Dev page for core/sketch: an inline sketch filling the page plus a floating one. Serve the workbench folder with any
// static server (the workbench server only serves core/, js/, tabs/ and the shell) and open /tools/sketch-dev.html.
// window.SK exposes the instances for tools/sketch-test.mjs.
import { mountSketch, openSketch, clipboard, renderSketch, renderMask } from '../core/sketch/sketch.js';

const STILLS = ['studio.jpg', 'I1.jpg', 'ada_body.jpg', 'ada_face.jpg', 'bo_body.jpg'].map(f => '../data/demo/media/still/' + f);
const ul = document.getElementById('ul'), log = document.getElementById('log');
for (const s of STILLS) { const o = document.createElement('option'); o.value = s; o.textContent = s.split('/').pop(); ul.appendChild(o); }
const say = (m) => { log.textContent = m; console.log('[sketch-dev]', m); };

const saved = [];
async function save(sketch, png, mask) {
  saved.push({ sketch, png, mask });
  say(`saved ${sketch.id}: ${sketch.strokes.length} strokes, ${sketch.pins.length} pins, png ${png.size} B, mask ${mask ? mask.size + ' B' : 'none'}`);
}
const params = new URLSearchParams(location.search);
const a = mountSketch(document.getElementById('inline'), {
  id: 'dev-a', save, underlay: params.get('underlay') ? { src: params.get('underlay'), opacity: 0.8 } : undefined,
  onDuplicate: (copy) => { SK.dup = openSketch({ sketch: copy, title: 'Duplicate ' + copy.id, save }); },
});
a.on('change', () => say(`change: ${a.get().strokes.length} strokes, ${a.get().mask.length} mask, ${a.get().pins.length} pins`));
ul.addEventListener('change', () => a.setUnderlay(ul.value ? { src: ul.value, opacity: 0.85 } : null));
document.getElementById('float').addEventListener('click', () => { SK.b = openSketch({ id: 'dev-b', title: 'Sketch dev-b (floating)', save, w: 1280, h: 720 }); });
document.getElementById('new').addEventListener('click', () => a.load({ id: 'dev-' + Date.now().toString(36), w: 1280, h: 720 }));

window.SK = { a, b: null, dup: null, saved, openSketch, mountSketch, clipboard, renderSketch, renderMask };
