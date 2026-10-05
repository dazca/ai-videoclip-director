// E3, chapters and build status (ROADMAP_v4; the first film: "Chapter 1 is built in xp/ch1.js; the rest renders as the
// fallback"). Pure functions, no DOM and no Node APIs: the storyboard stage, the timeline's chapters band, Final and the
// data layer (storyboard_get, chapters_update) share them.
//
// storyboard.json  chapters: [{id "c1", name, scenes: [scene ids], owner?, file?, note?, by, via, at}]   (outside the
//   versions, like the notes: a chapter groups SCENES, so it survives every new storyboard version). A scene is in at most
//   one chapter. owner = who builds it (an agent's name, "lead"); file = where it is built ("xp/ch1.js"). Written by the
//   page (the storyboard's scene headers) and by an agent (chapters_update): planning, nothing is approved or spent.
//
// The BUILD STATUS is derived, never stored (a `status` sent with a chapter is dropped):
//   planned     no shot yet, or shots without any generation started and no take picked
//   generating  some shots have a request in flight / done or a picked take, but not every shot has a picked take
//   built       every shot of the chapter has a picked take (nothing renders as a placeholder)
//   approved    built, and every shot is approved / locked by the director (approvals.json shot:<id>)
// A shot without a picked take renders as its placeholder frame (js/placeholder.js): `placeholders` counts them.
export const CHAPTER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
export const STATUSES = ['planned', 'generating', 'built', 'approved'];
export const STATUS_LABEL = { planned: 'planned', generating: 'generating', built: 'built', approved: 'approved' };
const SCENE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const DONE = ['approved', 'locked'], ACTIVE = ['approved', 'queued', 'running', 'done'];
const txt = (v, n) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n);
const maxN = (list) => list.reduce((m, x) => Math.max(m, Number(/^c(\d+)$/.exec(String(x?.id))?.[1]) || 0), 0);
export const nextChapterId = (list) => `c${maxN(list || []) + 1}`;

// a chapters list from the page or an agent -> the stored shape (throws a message on what cannot be fixed); `warnings`
// collects what was dropped (a status, an unknown field). The stamps (by, via, at) are kept as given: the caller stamps.
export function cleanChapters(list, { warnings } = {}) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw new Error('chapters: a list of {id, name, scenes[], owner?, file?, note?}');
  if (list.length > 100) throw new Error('chapters: at most 100');
  const ids = new Set(), owned = new Map(), out = [];
  for (const c of list) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error('chapters: every chapter is an object');
    const id = String(c.id ?? '');
    if (!CHAPTER_ID.test(id)) throw new Error(`chapter id "${id.slice(0, 60)}": letters, digits, _ and - (up to 40), e.g. c1`);
    if (ids.has(id)) throw new Error(`chapter ${id} twice`); ids.add(id);
    if (c.scenes != null && !Array.isArray(c.scenes)) throw new Error(`chapter ${id}: scenes must be a list of scene ids`);
    const scenes = [...new Set((c.scenes || []).map(String))];
    for (const s of scenes) {
      if (!SCENE_ID.test(s)) throw new Error(`chapter ${id}: "${s.slice(0, 60)}" is not a scene id`);
      if (owned.has(s)) throw new Error(`scene ${s} is in ${owned.get(s)} and ${id}: a scene is in one chapter`);
      owned.set(s, id);
    }
    if (scenes.length > 200) throw new Error(`chapter ${id}: at most 200 scenes`);
    if (c.status != null) warnings?.push(`${id}: status ignored: the build status is derived (planned / generating / built / approved)`);
    for (const k of ['owner', 'file']) if (c[k] != null && typeof c[k] !== 'string') throw new Error(`chapter ${id}: ${k} must be text`);
    if (c.file && (/\.\.|\\|^\/|:/.test(c.file))) throw new Error(`chapter ${id}: file is a relative path of the composition (no "..", backslash, drive or leading slash)`);
    out.push({ id, name: txt(c.name, 120) || id, scenes, ...(c.owner ? { owner: txt(c.owner, 60) } : {}), ...(c.file ? { file: txt(c.file, 200) } : {}),
      ...(c.note ? { note: txt(c.note, 1000) } : {}), ...(c.by ? { by: txt(c.by, 60) } : {}), ...(c.via ? { via: c.via === 'page' ? 'page' : 'agent' } : {}), ...(c.at ? { at: txt(c.at, 30) } : {}) });
  }
  return out;
}
export const chaptersOf = (doc) => (Array.isArray(doc?.chapters) ? doc.chapters : []);
export const chapterOfScene = (chapters, sceneId) => (chapters || []).find(c => (c.scenes || []).includes(sceneId)) || null;

// one chapter with its derived build status: {id, name, owner, file, note, scenes, t0, t1, shots, picked, approved, generating,
// placeholders, status, why, shot_ids}
export function chapterView(ch, { scenes = [], shots = [], approvals = null, requests = null } = {}) {
  const S = scenes.filter(s => (ch.scenes || []).includes(s.id)), mine = shots.filter(s => (ch.scenes || []).includes(s.scene));
  const R = requests?.items || requests || [], st = (id) => approvals?.items?.[`shot:${id}`]?.state || 'draft';
  const picked = mine.filter(s => s.clip?.file).length, approved = mine.filter(s => DONE.includes(st(s.id))).length;
  const started = mine.filter(s => s.clip?.file || (s.clips || []).length || R.some(r => r.target === `shot:${s.id}` && ACTIVE.includes(r.status))).length;
  const n = mine.length;
  let status, why;
  if (!n) { status = 'planned'; why = S.length ? 'no shots yet' : 'no scenes yet'; }
  else if (picked === n && approved === n) { status = 'approved'; why = `every shot picked and approved (${n})`; }
  else if (picked === n) { status = 'built'; why = `every shot has a picked take; ${n - approved} to approve`; }
  else if (started) { status = 'generating'; why = `${picked}/${n} picked · ${n - picked} render as placeholders`; }
  else { status = 'planned'; why = `${n} shot${n === 1 ? '' : 's'}, nothing generated yet`; }
  const t0 = S.length ? Math.min(...S.map(s => s.t0)) : mine.length ? Math.min(...mine.map(s => s.t0)) : null;
  const t1 = S.length ? Math.max(...S.map(s => s.t1)) : mine.length ? Math.max(...mine.map(s => s.t1)) : null;
  return { id: ch.id, name: ch.name || ch.id, ...(ch.owner ? { owner: ch.owner } : {}), ...(ch.file ? { file: ch.file } : {}), ...(ch.note ? { note: ch.note } : {}),
    scenes: [...(ch.scenes || [])], missing_scenes: (ch.scenes || []).filter(id => !scenes.some(s => s.id === id)), t0, t1,
    shots: n, picked, approved, generating: started - picked > 0 ? started - picked : 0, placeholders: n - picked, status, why, shot_ids: mine.map(s => s.id) };
}
// every chapter, in song order (a chapter without a scene in the script last)
export function chaptersView(doc, ctx) {
  return chaptersOf(doc).map(c => chapterView(c, ctx)).sort((a, b) => (a.t0 ?? Infinity) - (b.t0 ?? Infinity) || a.id.localeCompare(b.id, undefined, { numeric: true }));
}
