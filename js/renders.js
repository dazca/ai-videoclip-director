// E4 render jobs and E8 contact sheets (ROADMAP_v4). Pure functions, no DOM and no Node APIs: the page (core/renders.js,
// Final, Review › Queue, Compare) and the data layer (lib/ops/renders.mjs) share them.
//
// renders.json (the server's only; the page reads it, never a page save):
//   {v: 1, rev,
//    config: {command: [argv], cwd, warm?: [argv], min_free_mb, ram_wait_s, ram_tries, abort_below_mb, workers, width, height,
//             fps, excerpt_max_s, sheet_every_s, timeout_min, by: "director", via: "page", at} | null
//             (the director's, set in the page only: render_config. The workbench never hard-codes a composition: the command
//             is an argv list (no shell) with {placeholders} filled per job. An agent never sets it, and a request never
//             carries one: the command is read from here only, at the director's click)
//    sheets: [{id, kind: contact | seams, from: render | request | storyboard, source, file, t0, t1, frames[{t, label, shot?}],
//              revision, cols, by, via, at, asks[note ids], reviews[{id, verdict: ok | issues | fail, items[{t?, shot?,
//              constant?, ok, note}], note, by, via: "agent", at}]}]}
// A render job is a request of kind "render" in requests.json: render {scope: excerpt | chapter | full, t0, t1, chapter?, why?}
// (proposed by an agent with render_propose, or by the director), started ONLY by the director's click (render_start, page
// only: a confirm in the page), and its run state in render_run {phase, started, ended?, pid?, ram{start_mb, min_mb, samples},
// log, out?, sheets[], revision?, why?}. Outputs: renders/<id>/<id>.mp4 (kind render), <id>-sheet.jpg and <id>-seams.jpg (kind
// sheet), registered as media and linked to the request and the revision current at the start. Cost: $0 (local), heavy: one
// render at a time on the machine (a lock), only with enough free RAM, chapters before the full film (PRODUCTION.md).
export const RENDER_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const SHEET_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const SCOPES = ['excerpt', 'chapter', 'full'];
export const PHASES = { waiting_ram: 'waiting for free RAM', warming: 'warming the cache', rendering: 'rendering', sheets: 'making the sheets', done: 'done', failed: 'failed', cancelled: 'cancelled' };
export const VERDICTS = ['ok', 'issues', 'fail'];
export const SHEET_FROM = ['render', 'request', 'storyboard'];
// the placeholders a command may use (anything else in braces is refused: a typo would otherwise reach the renderer)
export const PLACEHOLDERS = {
  out: 'absolute path of the MP4 to write (data/<project>/renders/<id>/<id>.mp4)', from: 'start, seconds (3 decimals)', to: 'end, seconds',
  duration: 'length, seconds', from_ms: 'start, ms', to_ms: 'end, ms', scope: 'excerpt | chapter | full', chapter: 'the chapter id (chapter scope)',
  chapter_file: 'the chapter\'s file ("xp/ch1.js"), as the storyboard names it', width: 'frame width', height: 'frame height', fps: 'frames per second',
  workers: 'render workers', id: 'the render request id', project: 'the project id', project_dir: 'absolute path of the project folder',
};
export const DEFAULT_CONFIG = { command: null, cwd: null, warm: null, min_free_mb: 1536, ram_wait_s: 60, ram_tries: 10, abort_below_mb: 0, workers: 1, width: 1280, height: 720, fps: 30, excerpt_max_s: 20, sheet_every_s: 2, timeout_min: 120 };
// limits per number: [min, max] (ram_wait_s may be 0 only in a test run: the server checks)
const NUM = { min_free_mb: [0, 262144], ram_wait_s: [0, 3600], ram_tries: [1, 120], abort_below_mb: [0, 262144], workers: [1, 16], width: [16, 7680], height: [16, 4320], fps: [1, 120], excerpt_max_s: [1, 600], sheet_every_s: [0.1, 60], timeout_min: [1, 1440] };
const ARG_MAX = 2000, ARGS_MAX = 64;
const str = (v, n) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n);
const clock = (ms) => { const s = Math.max(0, ms || 0) / 1000, m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(2).padStart(5, '0')}`; };
export const tc = clock;

export const emptyRenders = () => ({ v: 1, rev: 0, config: null, sheets: [] });
export const normRenders = (d) => (d && typeof d === 'object' && !Array.isArray(d) ? { ...emptyRenders(), ...d, sheets: Array.isArray(d.sheets) ? d.sheets : [] } : emptyRenders());
export const configOf = (d) => ({ ...DEFAULT_CONFIG, ...(d?.config || {}) });

// an argv list (a command or the warm-up): strings, no NUL, every {name} a known placeholder; -> the list or throws
export function checkArgv(a, what = 'command') {
  if (!Array.isArray(a) || !a.length || a.length > ARGS_MAX) throw new Error(`${what}: a list of 1-${ARGS_MAX} arguments (the program first; no shell)`);
  return a.map((x, i) => {
    if (typeof x !== 'string' || x.length > ARG_MAX || /\0/.test(x)) throw new Error(`${what}[${i}]: a string up to ${ARG_MAX} characters`);
    if (i === 0 && !x.trim()) throw new Error(`${what}[0]: the program to run`);
    for (const m of x.matchAll(/\{([^{}]*)\}/g)) if (!Object.hasOwn(PLACEHOLDERS, m[1])) throw new Error(`${what}[${i}]: unknown placeholder {${str(m[1], 30)}} (known: ${Object.keys(PLACEHOLDERS).map(k => `{${k}}`).join(' ')})`);
    return x;
  });
}
// the director's settings from the page -> the stored config (throws a message); cwd is checked by the server (a folder)
export function checkConfig(c, { test = false } = {}) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error('config: {command: [argv], cwd?, warm?, min_free_mb?, ...}');
  const out = { command: checkArgv(c.command), cwd: c.cwd == null || c.cwd === '' ? null : str(c.cwd, 1000), warm: c.warm == null || (Array.isArray(c.warm) && !c.warm.length) ? null : checkArgv(c.warm, 'warm') };
  for (const [k, [lo, hi]] of Object.entries(NUM)) {
    const v = c[k] == null || c[k] === '' ? DEFAULT_CONFIG[k] : Number(c[k]);
    if (!Number.isFinite(v) || v < lo || v > hi) throw new Error(`${k}: a number ${lo}-${hi}`);
    out[k] = ['min_free_mb', 'ram_tries', 'abort_below_mb', 'workers', 'width', 'height', 'fps', 'timeout_min'].includes(k) ? Math.round(v) : v;
  }
  if (!test && out.ram_wait_s < 5) throw new Error('ram_wait_s: at least 5 s between RAM checks');
  return out;
}
// fill the placeholders of an argv list (values are plain strings: no shell ever sees them)
export const fillArgv = (argv, vals) => (argv || []).map(x => x.replace(/\{([a-z_]+)\}/g, (m, k) => (Object.hasOwn(vals, k) ? String(vals[k]) : m)));

// a render spec from an agent or the page -> {scope, t0, t1, chapter?, why?} (throws); ctx {song, chapters (chaptersView), excerptMaxS}
export function checkSpec(s, { song, chapters = [], excerptMaxS = DEFAULT_CONFIG.excerpt_max_s } = {}) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error('render: {scope: excerpt | chapter | full, t0?, t1?, chapter?, why?}');
  if (!SCOPES.includes(s.scope)) throw new Error('render.scope: excerpt | chapter | full');
  const dur = Math.round(Number(song?.duration_ms) || 0), why = s.why != null ? str(s.why, 400) : '';
  const base = { scope: s.scope, ...(why ? { why } : {}) };
  if (s.scope === 'full') return { ...base, t0: 0, t1: dur };
  if (s.scope === 'chapter') {
    if (typeof s.chapter !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(s.chapter)) throw new Error('render.chapter: a chapter id (storyboard chapters)');
    const c = chapters.find(x => x.id === s.chapter); if (!c) throw new Error(`render.chapter: no chapter "${s.chapter}"`);
    if (!(c.t1 > c.t0)) throw new Error(`render.chapter: ${c.id} has no scenes in the script yet`);
    return { ...base, chapter: c.id, t0: c.t0, t1: c.t1 };
  }
  const t0 = Math.round(Number(s.t0)), t1 = Math.round(Number(s.t1));
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t0 < 0 || t1 <= t0 || (dur && t1 > dur)) throw new Error(`render: t0 < t1 inside the song (0-${clock(dur)}), in ms`);
  if (t1 - t0 > excerptMaxS * 1000 + 1) throw new Error(`render: an excerpt is at most ${excerptMaxS} s (PRODUCTION.md: excerpts of at most 20 s; chapters and the full film have their own scope)`);
  return { ...base, t0, t1 };
}
export const specLabel = (r) => { const s = r?.render || {}; return s.scope === 'full' ? 'full film' : s.scope === 'chapter' ? `chapter ${s.chapter}` : `excerpt ${clock(s.t0)}–${clock(s.t1)}`; };
// the etiquette's order: the full film only once every chapter (with scenes) has a done chapter render
export function orderGaps(chapters, requests) {
  const done = new Set((requests || []).filter(r => r.kind === 'render' && r.status === 'done' && r.render?.scope === 'chapter').map(r => r.render.chapter));
  return chapters.filter(c => c.t1 > c.t0 && !done.has(c.id)).map(c => c.id);
}
// the seams inside [t0, t1): the chapter starts (song ms), labelled
export const seamsIn = (chapters, t0, t1) => chapters.filter(c => c.t0 > t0 && c.t0 < t1).map(c => ({ t: c.t0, label: `${c.id} ${c.name || ''}`.trim() }));
// the revision a render or a sheet belongs to: the newest closed revision (R<n>), else "R0" (before the first)
export const currentRevision = (rv) => (rv?.revisions || []).at(-1)?.id || 'R0';
// the sheets of a revision, newest first (Compare)
export const sheetsOfRevision = (doc, rev) => (doc?.sheets || []).filter(s => (s.revision || 'R0') === rev).slice().reverse();
export const lastReview = (s) => (s?.reviews || []).at(-1) || null;
export const isRender = (r) => r?.kind === 'render';
