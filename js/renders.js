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
export const PHASES = { waiting_ram: 'waiting for free RAM', warming: 'warming the cache', rendering: 'rendering', sheets: 'making the sheets', exporting: 'exporting the package', verifying: 'checking frames against the render', done: 'done', failed: 'failed', cancelled: 'cancelled' };
export const VERDICTS = ['ok', 'issues', 'fail'];
export const SHEET_FROM = ['render', 'request', 'storyboard'];
// the placeholders a command may use (anything else in braces is refused: a typo would otherwise reach the renderer)
export const PLACEHOLDERS = {
  out: 'absolute path of the MP4 to write (data/<project>/renders/<id>/<id>.mp4)', from: 'start, seconds (3 decimals)', to: 'end, seconds',
  duration: 'length, seconds', from_ms: 'start, ms', to_ms: 'end, ms', scope: 'excerpt | chapter | full', chapter: 'the chapter id (chapter scope)',
  chapter_file: 'the chapter\'s file ("xp/ch1.js"), as the storyboard names it', width: 'frame width', height: 'frame height', fps: 'frames per second',
  workers: 'render workers', id: 'the render request id', project: 'the project id', project_dir: 'absolute path of the project folder',
};
// C5: the interactive HTML package reads the same settings: `composition` (the composition folder, absolute; empty = `cwd`), its
// `entry` HTML, `hyperframes` (the HyperFrames dist folder when no node_modules above the composition has it), `verify_n` (frames
// compared with the render) and `sample_fps` (the exporter's usage pass). The exporter and verify.mjs are the workbench's own
// scripts: never a program or a path from an agent, a request or the composition.
export const DEFAULT_CONFIG = { command: null, cwd: null, warm: null, min_free_mb: 1536, ram_wait_s: 60, ram_tries: 10, abort_below_mb: 0, workers: 1, width: 1280, height: 720, fps: 30, excerpt_max_s: 20, sheet_every_s: 2, timeout_min: 120,
  composition: null, entry: 'index.html', hyperframes: null, verify_n: 12, sample_fps: 10 };
// limits per number: [min, max] (ram_wait_s may be 0 only in a test run: the server checks)
const NUM = { min_free_mb: [0, 262144], ram_wait_s: [0, 3600], ram_tries: [1, 120], abort_below_mb: [0, 262144], workers: [1, 16], width: [16, 7680], height: [16, 4320], fps: [1, 120], excerpt_max_s: [1, 600], sheet_every_s: [0.1, 60], timeout_min: [1, 1440],
  verify_n: [1, 60], sample_fps: [1, 30] };
// the composition's entry HTML: a relative path inside its folder (no "..", ".", backslash, drive, leading slash)
export const ENTRY_RE = /^(?!.*(^|\/)\.{1,2}(\/|$))[A-Za-z0-9_][\w.-]*(\/[\w.-]+)*\.html?$/;
const ARG_MAX = 2000, ARGS_MAX = 64;
const str = (v, n) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n);
const clock = (ms) => { const s = Math.max(0, ms || 0) / 1000, m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(2).padStart(5, '0')}`; };
export const tc = clock;

export const emptyRenders = () => ({ v: 1, rev: 0, config: null, sheets: [], packages: [] });
export const normRenders = (d) => (d && typeof d === 'object' && !Array.isArray(d) ? { ...emptyRenders(), ...d, sheets: Array.isArray(d.sheets) ? d.sheets : [], packages: Array.isArray(d.packages) ? d.packages : [] } : emptyRenders());
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
  const dir = (v) => (v == null || v === '' ? null : str(v, 1000));
  const out = { command: checkArgv(c.command), cwd: dir(c.cwd), warm: c.warm == null || (Array.isArray(c.warm) && !c.warm.length) ? null : checkArgv(c.warm, 'warm'),
    composition: dir(c.composition), hyperframes: dir(c.hyperframes), entry: c.entry == null || c.entry === '' ? DEFAULT_CONFIG.entry : String(c.entry) };
  if (out.entry.length > 200 || !ENTRY_RE.test(out.entry)) throw new Error('entry: the composition\'s HTML file, a relative path inside its folder ("index.html")');
  for (const [k, [lo, hi]] of Object.entries(NUM)) {
    const v = c[k] == null || c[k] === '' ? DEFAULT_CONFIG[k] : Number(c[k]);
    if (!Number.isFinite(v) || v < lo || v > hi) throw new Error(`${k}: a number ${lo}-${hi}`);
    out[k] = ['min_free_mb', 'ram_tries', 'abort_below_mb', 'workers', 'width', 'height', 'fps', 'timeout_min', 'verify_n', 'sample_fps'].includes(k) ? Math.round(v) : v;
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

// ------------------------------------------------------------------ C5: the interactive HTML package (File › Export)
// A package job is a request of kind "package": package {why?, against? (a done render id)}, proposed by an agent
// (package_propose) or made by the director's click, and started ONLY by the director (package_start, page only, after the
// dialog's confirm). It runs exporters/hyperframes-html/export.mjs --interactive on the composition of the render settings, then
// verify.mjs --against the newest done render (or the one named), under the same machine lock and RAM floor as a render. Its run:
// package_run {phase: waiting_ram | exporting | verifying | done | failed | cancelled, started, ended?, ram, log, revision, against?,
// report?}. Its files, always named from the id: exports/package/<id>/ (index.html, composition/, manifest.json, …),
// exports/package/<id>-verify/ (verify.json, cmp-<t>.jpg: package | render side by side) and exports/package/<id>.log.
// renders.json packages[] registers each done package: {id, dir, entry, composition, against {render, scope, t0, t1} | null,
// report, manifest {assets, bytes, system_fonts}, revision, by, via, at}.
export const isPackage = (r) => r?.kind === 'package';
export const isHeavy = (r) => isRender(r) || isPackage(r);
export const PKG_IMG = /^cmp-\d{1,6}\.\d{3}\.jpg$/;
export const pkgLabel = (r) => `interactive HTML package${r?.package?.against ? ` · against ${r.package.against}` : ''}`;
// the render a package is checked against: the one named (done, with its MP4), else the newest done render
export function againstRender(requests, named) {
  const done = (requests || []).filter(r => isRender(r) && r.status === 'done' && r.render_run?.out);
  if (named) return done.find(r => r.id === named) || null;
  const t = (r) => Date.parse(r.render_run?.ended || r.at || 0) || 0;
  return done.map((r, i) => [r, i]).sort((a, b) => t(b[0]) - t(a[0]) || b[1] - a[1])[0]?.[0] || null;   // same second: the later one in the file
}
// verify.json (exporters/hyperframes-html/verify.mjs) -> the frame-match report: frames, passed, rate, verdict, the worst frames
export function packageReport(v, { worst = 4 } = {}) {
  const fr = Array.isArray(v?.frames) ? v.frames : [], th = v?.thresholds || {};
  const maxMad = Number(th.maxMadPct ?? 5), minPsnr = Number(th.minPsnr ?? 20);
  const bad = (x) => !(Number(x.madPct) <= maxMad) || !(Number(x.psnr) >= minPsnr) || (x.pendingMedia || []).length > 0;
  const pass = fr.filter(x => !bad(x)).length, rq = v?.requests || {};
  const problems = [...(v?.integrity?.problems || []).map(x => `integrity: ${x}`), ...(rq.failed || []).map(x => `request failed: ${x}`),
    ...(rq.external || []).map(x => `external request: ${x}`), ...(rq.pageErrors || []).map(x => `page error: ${x}`), ...(rq.networkFailures || []).map(x => `network: ${x}`)]
    .map(x => str(x, 300)).slice(0, 20);
  const avg = (k) => (fr.length ? +(fr.reduce((s, x) => s + (Number(x[k]) || 0), 0) / fr.length).toFixed(2) : null);
  return { frames: fr.length, pass, rate: fr.length ? +(pass / fr.length).toFixed(4) : 0, verdict: fr.length && pass === fr.length && !problems.length ? 'pass' : 'fail',
    mad_mean: avg('madPct'), psnr_mean: avg('psnr'), thresholds: { max_mad_pct: maxMad, min_psnr: minPsnr }, problems,
    worst: fr.slice().sort((a, b) => (Number(b.madPct) || 0) - (Number(a.madPct) || 0)).slice(0, worst)
      .map(x => ({ t: Number(x.t), frame: Number(x.frame), mad: Number(x.madPct), psnr: Number(x.psnr), bad: bad(x), ...(PKG_IMG.test(String(x.image || '')) ? { image: x.image } : {}) })) };
}
export const pctOf = (r) => `${Math.round((r?.rate || 0) * 100)} %`;
