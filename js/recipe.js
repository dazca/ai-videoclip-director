// The photoreal recipe as the default prompt template (templates/photoreal_recipe.json; why each block exists:
// docs/PHOTOREAL.md). Builds a generation prompt from editable blocks, per model: subject / identity lock, wardrobe,
// action, place, light, camera, texture (+ the medium), and the avoid list (a positive guard sentence for the image
// models, which have no negative field; Kling's negative_prompt for video). Pure functions, no DOM and no Node APIs:
// the page (the Queue's request form) and lib/store.mjs (request_create {recipe}) use the same code.
import * as P from './prices.js';

export const RECIPE_ID = 'photoreal';
// the fields a request fills (all optional; an empty required block is flagged, never invented)
export const FIELDS = [
  { id: 'subject', label: 'subject', hint: 'who: "her (the approved character)", "a man in his fifties"; the identity lock is added when refs carry the face' },
  { id: 'wardrobe', label: 'wardrobe', hint: 'garments with materials and exact colours, props with size and position' },
  { id: 'action', label: 'action', hint: 'pose and expression, slightly unposed, gaze off-axis (video: the motion)' },
  { id: 'place', label: 'place', hint: 'a specific real place + 3-5 ordinary objects and some wear' },
  { id: 'light', label: 'light', hint: 'key source, direction, colour temperature, hardness; practicals' },
  { id: 'camera', label: 'camera', hint: 'empty = the framing default (full body 35mm f/2.8 ~4 m; medium 50mm; close-up 85mm); video: one camera move' },
  { id: 'texture', label: 'texture', hint: 'empty = pores, fine lines, flyaway hairs, fabric weave' },
  { id: 'grade', label: 'grade', hint: 'natural colour / Kodak Portra 400 / Cinestill 800T (night) / phone camera' },
];
export const MODELS = { nb2: 'still', seedream5: 'still', h3max: 'video', kling3pro: 'video', klingmc: 'video' };
export const FRAMINGS = { full_body: 'Full-body photograph', medium: 'Medium shot photograph', close_up: 'Close-up photograph' };
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const end = (s) => { s = clean(s); s = s.charAt(0).toUpperCase() + s.slice(1); return !s ? '' : /[.!?]$/.test(s) ? s : s + '.'; };
const FILL = (what) => `[fill: ${what}]`;

// -> {model, kind, blocks: [{id, label, text, filled}], prompt, negative_prompt?, warnings[], est}
// o: {model, framing, name, refs: n reference images, identity: true when image 1 is the approved face / identity,
//     subject, wardrobe, action, place, light, camera, texture, grade, seconds (video), blocks: {<id>: text} (an edited
//     block wins over the built one)}
export function buildRecipe(recipe, o = {}) {
  const model = MODELS[o.model] ? o.model : 'nb2', kind = MODELS[model], R = recipe || {}, warnings = [];
  const f = Object.fromEntries(FIELDS.map(x => [x.id, clean(o[x.id])]));
  const framing = FRAMINGS[o.framing] ? o.framing : 'full_body', name = clean(o.name) || 'the subject', refs = Math.max(0, Number(o.refs) || 0);
  const blocks = [];
  const add = (id, label, text, filled = true) => blocks.push({ id, label, text: clean(text), filled });
  if (kind === 'still') {
    if (refs || o.identity) add('refs', 'references', o.identity
      ? `Image 1 is ${name}, the approved identity${refs === 2 ? '; image 2 is the other reference' : refs > 2 ? `; images 2-${refs} are the other references in the order given` : ''}. Create a new photograph of the same person as Image 1.`
      : refs > 1 ? `Images 1-${refs} are the references, in the order given.` : 'Image 1 is the reference.');
    // the recipe's identity lock (photoreal_recipe.json still.identity_lock), worded for any person
    if (o.identity) add('identity_lock', 'identity lock', 'Keep the face exactly as in Image 1: bone structure, eye shape, eyebrows, nose, lips, skin tone, marks, hairline and body proportions. Do not beautify, slim or de-age.');
    add('subject_wardrobe', 'subject + wardrobe', `${FRAMINGS[framing]} of ${f.subject || name}${f.wardrobe ? `, wearing ${f.wardrobe.replace(/\.$/, '')}` : ''}.`, !!(f.subject || o.name) && !!f.wardrobe);
    add('action', 'action', end(f.action || FILL('pose and expression, slightly unposed')), !!f.action);
    add('location', 'place', `Location: ${end(f.place || FILL('a specific real place with 3-5 ordinary objects'))}`, !!f.place);
    add('light', 'light', `Light: ${(f.light || FILL('key source, direction, colour temperature')).replace(/\.$/, '')}. The same light falls on the subject and the place, with matching shadows and a soft contact shadow at the feet.`, !!f.light);
    const camDefault = R.still?.blocks?.find(b => b.id === 'camera')?.defaults?.[framing] || 'full-frame camera, 35mm, f/2.8, about 4 m away, chest height';
    add('camera', 'camera', `Shot on ${(f.camera || camDefault).replace(/^shot on /i, '').replace(/\.$/, '')}.`);
    add('texture', 'texture', end(f.texture || 'Visible skin texture with pores, fine lines and slight natural redness, a few flyaway hairs, visible fabric weave and small creases'));
    add('medium', 'medium', `Unretouched documentary photograph, ${(f.grade || 'natural colour and accurate white balance').replace(/\.$/, '')}, fine ${model === 'seedream5' ? 'high-ISO sensor grain, no beauty filters, slight colour cast' : 'sensor noise in the shadows'}.`);
    // NB2 / Seedream have no negative field: the avoid list becomes one positive guard sentence
    add('avoid', 'avoid', 'A real photograph, not a render or an illustration, no beauty filter, no text or logos.');
  } else {
    add('motion', 'motion', end(f.action || FILL('the motion only: what moves, not what the image already shows')), !!f.action);
    add('camera', 'camera', `Camera: ${(f.camera || 'static locked-off camera').replace(/^camera:\s*/i, '').replace(/\.$/, '')}.`);
    if (f.place || f.light) add('ambient', 'ambient', end([f.place, f.light].filter(Boolean).join('; ')));
    add('medium', 'medium', 'Handheld documentary footage, natural motion blur, fine film grain, real skin texture, stable face and identity throughout.');
    if (model === 'klingmc') warnings.push('motion control: describe the background and atmosphere only (the reference clip drives the motion)');
    if (!o.identity && !refs) warnings.push('video: animate an approved still only (give the still as image 1)');
  }
  // an edited block (the director's or the agent's) wins over the built one
  for (const b of blocks) if (o.blocks && typeof o.blocks[b.id] === 'string') { b.text = clean(o.blocks[b.id]); b.filled = !/\[fill:/.test(b.text); b.edited = true; }
  const prompt = blocks.map(b => b.text).filter(Boolean).join(' ');
  const open = blocks.filter(b => /\[fill:/.test(b.text)).map(b => b.label);
  if (open.length) warnings.push(`unfilled block${open.length > 1 ? 's' : ''}: ${open.join(', ')} (replace the [fill: …] text before approving)`);
  const banned = Object.values(R.avoid || {}).filter(Array.isArray).flat().filter(w => w && new RegExp(`(^|[^a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ \(.*\)$/, '')}([^a-z]|$)`, 'i').test(prompt.replace(/A real photograph, not a render or an illustration, no beauty filter/i, '')));
  if (banned.length) warnings.push(`avoid list: ${[...new Set(banned)].join(', ')} (docs/PHOTOREAL.md: name the real thing instead)`);
  const est = kind === 'still' ? P.estimateWith({ model, tier: model === 'nb2' ? '2K' : '2048', what: 'one photoreal still' }) : P.estimateWith({ model, what: 'image-to-video' }, { seconds: o.seconds || R.video?.duration_s?.default || 5 });
  return { recipe: RECIPE_ID, version: R.version || null, model, kind, framing, blocks, prompt, ...(model === 'kling3pro' && R.video?.negative_prompt ? { negative_prompt: R.video.negative_prompt } : {}), warnings, est };
}
