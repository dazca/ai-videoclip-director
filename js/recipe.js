// The photoreal recipe as the default prompt template (templates/photoreal_recipe.json; why each block exists:
// docs/PHOTOREAL.md). Builds a generation prompt from editable blocks, per model: subject / identity lock, wardrobe,
// action, place, light, camera, texture (+ the medium), and the avoid list (a positive guard sentence for the image
// models, which have no negative field; Kling's negative_prompt for video). Pure functions, no DOM and no Node APIs:
// the page (the Queue's request form) and lib/store.mjs (request_create {recipe}) use the same code.
// Character-agnostic: no block names a gender. Who it is comes from the entity (its name, its identity constants:
// entity.constants[], the details that must stay identical, which go into the identity lock).
// Fields vs blocks: a field FILLS its block; the recipe's fixed sentences stay (the "Location:" / "Light:" lead, the
// shared-light sentence, the skin sentence of the texture block, the medium). Only an edited block (blocks: {<id>: text})
// replaces a block's whole text.
import * as P from './prices.js';

export const RECIPE_ID = 'photoreal';
// the fields a request fills (all optional; an empty required block is flagged, never invented)
export const FIELDS = [
  { id: 'subject', label: 'subject', hint: 'who: empty = the character\'s name; "a man in his fifties, short grey hair"; the identity lock is added when image 1 is the approved identity' },
  { id: 'wardrobe', label: 'wardrobe', hint: 'garments with materials and exact colours, props with size and position' },
  { id: 'action', label: 'action', hint: 'pose and expression, slightly unposed, gaze off-axis (video: the motion)' },
  { id: 'place', label: 'place', hint: 'a specific real place + 3-5 ordinary objects and some wear (follows "Location: ")' },
  { id: 'light', label: 'light', hint: 'key source, direction, colour temperature, hardness; practicals (the shared-light sentence is added)' },
  { id: 'camera', label: 'camera', hint: 'empty = the framing default (full body 35mm f/2.8 ~4 m; medium 50mm; close-up 85mm); video: one camera move' },
  { id: 'texture', label: 'texture', hint: 'hair and fabric detail, added after the fixed skin sentence (pores, fine lines); empty = flyaway hairs, fabric weave' },
  { id: 'grade', label: 'grade', hint: 'natural colour / Kodak Portra 400 / Cinestill 800T (night) / phone camera' },
];
export const MODELS = { nb2: 'still', seedream5: 'still', h3max: 'video', kling3pro: 'video', klingmc: 'video' };
export const FRAMINGS = { full_body: 'Full-body photograph', medium: 'Medium shot photograph', close_up: 'Close-up photograph' };
// the still blocks in prompt order (an edited block that was not built goes in its place)
export const STILL_BLOCKS = ['refs', 'identity_lock', 'constants', 'subject_wardrobe', 'action', 'location', 'light', 'camera', 'texture', 'medium', 'avoid'];
export const VIDEO_BLOCKS = ['motion', 'camera', 'ambient', 'medium'];
const LABELS = { refs: 'references', identity_lock: 'identity lock', constants: 'constants', subject_wardrobe: 'subject + wardrobe', location: 'place' };
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const dot = (s) => { s = clean(s); return !s ? '' : /[.!?]$/.test(s) ? s : s + '.'; };
const end = (s) => dot(cap(clean(s)));
const FILL = (what) => `[fill: ${what}]`;
const SKIN = 'Visible skin texture with pores, fine lines and slight natural redness';
const SHARED_LIGHT = 'The same light falls on the subject and the place, with matching shadows and a soft contact shadow at the feet.';
// the entity's identity constants (entity.constants: strings or {text}) -> clean strings
export const constantsOf = (c) => (Array.isArray(c) ? c : []).map(x => clean(typeof x === 'string' ? x : x?.text)).filter(Boolean).slice(0, 24);

// -> {model, kind, blocks: [{id, label, text, filled, edited?}], prompt, negative_prompt?, warnings[], est, takes}
// o: {model, framing, name, refs: n reference images, identity: true when image 1 is the approved face / identity,
//     character: true when the subject is a character (warns when its identity lock is missing), constants: the
//     entity's identity constants, subject, wardrobe, action, place, light, camera, texture, grade, seconds (video),
//     takes (how many images: the estimate covers all), blocks: {<id>: text} (an edited block wins over the built one;
//     one that was not built is added in its place, with a warning)}
export function buildRecipe(recipe, o = {}) {
  const model = MODELS[o.model] ? o.model : 'nb2', kind = MODELS[model], R = recipe || {}, warnings = [];
  const f = Object.fromEntries(FIELDS.map(x => [x.id, clean(o[x.id])]));
  const framing = FRAMINGS[o.framing] ? o.framing : 'full_body', name = clean(o.name) || 'the subject', refs = Math.max(0, Number(o.refs) || 0);
  const takes = Number.isInteger(Number(o.takes)) && Number(o.takes) >= 1 ? Math.min(8, Number(o.takes)) : 1;
  const consts = constantsOf(o.constants);
  const blocks = [];
  const add = (id, label, text, filled = true) => blocks.push({ id, label, text: clean(text), filled });
  if (kind === 'still') {
    if (refs || o.identity) add('refs', 'references', o.identity
      ? `Image 1 is ${name}, the approved identity${refs === 2 ? '; image 2 is the other reference' : refs > 2 ? `; images 2-${refs} are the other references in the order given` : ''}. Create a new photograph of the same person as Image 1.`
      : refs > 1 ? `Images 1-${refs} are the references, in the order given.` : 'Image 1 is the reference.');
    // the recipe's identity lock (photoreal_recipe.json still.identity_lock), worded for any person, + the constants
    if (o.identity) add('identity_lock', 'identity lock', `Keep the face exactly as in Image 1: bone structure, eye shape, eyebrows, nose, lips, skin tone, ${consts.length ? '' : 'marks, '}hairline and body proportions.${consts.length ? ` Keep these exactly the same: ${consts.join('; ')}.` : ''} Do not beautify, slim or de-age.`);
    else if (consts.length) add('constants', 'constants', `Keep these details exactly: ${consts.join('; ')}.`);
    add('subject_wardrobe', 'subject + wardrobe', `${FRAMINGS[framing]} of ${f.subject || name}${f.wardrobe ? `, wearing ${f.wardrobe.replace(/\.$/, '')}` : ''}.`, !!(f.subject || o.name) && !!f.wardrobe);
    add('action', 'action', end(f.action || FILL('pose and expression, slightly unposed')), !!f.action);
    // "Location: " + the field as typed (no forced capital)
    add('location', 'place', `Location: ${dot((f.place || FILL('a specific real place with 3-5 ordinary objects')).replace(/^location:\s*/i, ''))}`, !!f.place);
    // the shared-light sentence is the recipe's; added once (not when the field already says it)
    const lt = (f.light || FILL('key source, direction, colour temperature')).replace(/^light:\s*/i, '');
    add('light', 'light', `Light: ${dot(lt)}${/same light falls on/i.test(lt) ? '' : ' ' + SHARED_LIGHT}`, !!f.light);
    const camDefault = R.still?.blocks?.find(b => b.id === 'camera')?.defaults?.[framing] || 'full-frame camera, 35mm, f/2.8, about 4 m away, chest height';
    add('camera', 'camera', `Shot on ${(f.camera || camDefault).replace(/^shot on /i, '').replace(/\.$/, '')}.`);
    // the skin sentence is the point of the recipe: always there; the field adds the hair / fabric detail
    const tx = f.texture.replace(/^visible skin texture( with pores, fine lines( and slight natural redness)?)?[,;.]?\s*/i, '');
    add('texture', 'texture', /\bpores\b/i.test(tx) ? end(tx) : `${SKIN}, ${dot(tx || 'a few flyaway hairs, visible fabric weave and small creases')}`);
    add('medium', 'medium', `Unretouched documentary photograph, ${(f.grade || 'natural colour and accurate white balance').replace(/\.$/, '')}, fine ${model === 'seedream5' ? 'high-ISO sensor grain, no beauty filters, slight colour cast' : 'sensor noise in the shadows'}.`);
    // NB2 / Seedream have no negative field: the avoid list becomes one positive guard sentence
    add('avoid', 'avoid', 'A real photograph, not a render or an illustration, no beauty filter, no text or logos.');
    if (o.character && !o.identity && !(o.blocks && typeof o.blocks.identity_lock === 'string'))
      warnings.push(`no identity lock: image 1 is not ${name}'s approved identity (none approved yet, or refs[0] is not its image), so nothing tells the model to keep the face. Approve the identity first and put its image first in refs, or pass recipe.identity: true when image 1 is the face to keep`);
  } else {
    add('motion', 'motion', end(f.action || FILL('the motion only: what moves, not what the image already shows')), !!f.action);
    add('camera', 'camera', `Camera: ${(f.camera || 'static locked-off camera').replace(/^camera:\s*/i, '').replace(/\.$/, '')}.`);
    if (f.place || f.light) add('ambient', 'ambient', end([f.place, f.light].filter(Boolean).join('; ')));
    add('medium', 'medium', 'Handheld documentary footage, natural motion blur, fine film grain, real skin texture, stable face and identity throughout.');
    if (model === 'klingmc') warnings.push('motion control: describe the background and atmosphere only (the reference clip drives the motion)');
    if (!o.identity && !refs) warnings.push('video: animate an approved still only (give the still as image 1)');
  }
  // an edited block (the director's or the agent's) wins over the built one; an edited block that was not built (e.g.
  // identity_lock while identity is false) is added in its place, never dropped silently
  const order = kind === 'still' ? STILL_BLOCKS : VIDEO_BLOCKS;
  for (const [id, text] of Object.entries(o.blocks && typeof o.blocks === 'object' ? o.blocks : {})) {
    if (typeof text !== 'string') continue;
    let b = blocks.find(x => x.id === id);
    if (!b) {
      if (!order.includes(id)) { warnings.push(`block "${id}" ignored: not a ${kind} block (${order.join(', ')})`); continue; }
      if (!clean(text)) continue;
      b = { id, label: LABELS[id] || id, text: '', filled: true };
      const k = order.indexOf(id), at = blocks.findIndex(x => order.indexOf(x.id) > k);
      blocks.splice(at < 0 ? blocks.length : at, 0, b);
      warnings.push(`block "${id}" was not built (${id === 'identity_lock' ? 'identity is false: image 1 is not the approved identity' : 'nothing fills it'}): added from your text`);
    }
    b.text = clean(text); b.filled = !/\[fill:/.test(b.text); b.edited = true;
  }
  const prompt = blocks.map(b => b.text).filter(Boolean).join(' ');
  const open = blocks.filter(b => /\[fill:/.test(b.text)).map(b => b.label);
  if (open.length) warnings.push(`unfilled block${open.length > 1 ? 's' : ''}: ${open.join(', ')} (replace the [fill: …] text before approving)`);
  const banned = Object.values(R.avoid || {}).filter(Array.isArray).flat().filter(w => w && new RegExp(`(^|[^a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ \(.*\)$/, '')}([^a-z]|$)`, 'i').test(prompt.replace(/A real photograph, not a render or an illustration, no beauty filter/i, '')));
  if (banned.length) warnings.push(`avoid list: ${[...new Set(banned)].join(', ')} (docs/PHOTOREAL.md: name the real thing instead)`);
  const est = kind === 'still' ? P.estimateWith({ model, tier: model === 'nb2' ? '2K' : '2048', what: takes > 1 ? `${takes} photoreal stills` : 'one photoreal still' }, { n: takes })
    : P.estimateWith({ model, what: 'image-to-video' }, { seconds: o.seconds || R.video?.duration_s?.default || 5, n: takes });
  return { recipe: RECIPE_ID, version: R.version || null, model, kind, framing, takes, blocks, prompt, ...(model === 'kling3pro' && R.video?.negative_prompt ? { negative_prompt: R.video.negative_prompt } : {}), warnings, est };
}
