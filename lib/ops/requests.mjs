// Requests and costs: the photoreal recipe file, the generation queue (requests_list, request_create, request_update:
// draft -> approved -> queued -> running -> done / rejected, the cap), approvals (approvals_get, set_states) and the one cost
// ledger (costs.json + a falgen folder: costSummary, costs_get, cost_record).
import fs from 'node:fs';
import path from 'node:path';
import * as A from '../../js/assets.js';
import * as RC from '../../js/recipe.js';
import { AUDIO, CFG, DEFAULTS, DIRECTOR_STATES, REQUEST_STATUSES, VIDEO, WB_DIR, appendCost, approvalOk, directorGate, fail, isFlaggedPrivate, isPrivate, ms, mutate, nowIso, ops, projDir, read, readJSON, relTo, sum, timeOfKey, write } from './_shared.mjs';
import { assetType, checkAssetLink, readAsset } from './assets.mjs';
import { generatorsInfo, planRun, runPlan } from '../run.mjs';

// the photoreal recipe (templates/photoreal_recipe.json): the default prompt template (js/recipe.js builds it)
let recipeCache = null;
export function loadRecipe() {
  const f = path.join(WB_DIR, 'templates', 'photoreal_recipe.json');
  let mt = 0; try { mt = fs.statSync(f).mtimeMs; } catch (e) { return {}; }
  if (recipeCache?.mt !== mt) recipeCache = { mt, j: readJSON(f, {}) || {} };
  return recipeCache.j;
}

const NEXT = {   // allowed status moves; "approved" from draft needs director_approved (the human said so)
  draft: ['approved', 'rejected', 'withdrawn'], approved: ['draft', 'queued', 'running', 'rejected'], queued: ['running', 'approved', 'rejected'],
  running: ['done', 'failed', 'queued', 'rejected'], done: [], rejected: ['draft'],
  failed: ['queued', 'draft', 'rejected'],   // a failed run keeps its approval: the runner may retry it (queued re-checks the cap)
  withdrawn: ['draft'],   // its author took it back (obsolete, superseded): not the director's rejection
};
// who wrote a request: the first log entry (the page stamps director / page; the tools agent)
export const requestAuthor = (r) => { const v = r.log?.[0]?.via; return v === 'page' ? 'director' : v === 'agent' ? 'agent' : r.by === 'director' ? 'director' : 'agent'; };

// the recipe's subject from the request's asset link: the entity's name, whether image 1 is its approved identity (the
// identity lock), its identity constants (entity.constants[]: the details that must stay identical) and whether it is a
// character (a missing identity lock is then warned). An explicit recipe.name / identity / constants wins.
function recipeSubject(p, type, link, refs, o = {}) {
  let name = o.name, identity = o.identity, constants = Array.isArray(o.constants) ? o.constants : undefined, character = false;
  if (link) {
    const { ent } = readAsset(p, type, link.id), rn = A.approvedNode(ent.iter, A.TYPE[type].root);
    name ??= ent.name || ent.id; character = type === 'character';
    identity ??= !!rn && character && (refs[0] === rn.image || refs[0] === A.nodeById(ent.iter, link.from)?.image);
    constants ??= RC.constantsOf(ent.constants);
  }
  return { name, identity: !!identity, character, constants: RC.constantsOf(constants) };
}
// the warnings a recipe rebuild replaces (request_update recipe)
const RECIPE_WARNING = /^(no identity lock|unfilled block|avoid list|block "|motion control:|video: animate)/;
// what a request stores of its recipe: v 2 = only the blocks marked edited win when it is rebuilt (request_update)
const recipeRecord = (built, who, o) => ({ id: built.recipe, v: 2, version: built.version, model: built.model, framing: built.framing, ...(who.name ? { name: String(who.name).slice(0, 200) } : {}), identity: !!who.identity,
  ...(who.character ? { character: true } : {}), ...(who.constants.length ? { constants: who.constants } : {}), ...(built.takes > 1 ? { takes: built.takes } : {}),
  fields: Object.fromEntries(RC.FIELDS.map(x => [x.id, o[x.id]]).filter(([, v]) => v != null && v !== '')),
  blocks: built.blocks.map(({ id, label, text, edited }) => ({ id, label, text, ...(edited ? { edited: true } : {}) })) });
// ------------------------------------------------------------------ one cost ledger: the workbench's costs.json + falgen's
// A project may name a falgen folder (a runner that spends outside the queue) in project.json: "falgen": "<dir>" or
// {"dir": "<dir>", "ledger": "<file>"}, paths relative to the media base (or absolute inside it); read only, never
// written. Its gen/spent.json ({"total"}) and the "via falgen" rows of its LEDGER.md (default <dir>/../LEDGER.md:
// "| date | job | fal <job> via falgen | | usd | ... |") are merged into costs_get without double counting: a falgen row
// whose job is already a workbench cost item (id, job or request) counts once (the workbench's); the part of spent.json
// that no ledger row itemises counts as "falgen (not itemised)". Other ledger rows are listed, not added.
const num = (s) => { const m = /-?\d+(\.\d+)?/.exec(String(s ?? '').replace(/,/g, '')); return m ? Number(m[0]) : null; };
// The link may also be set in the page (Settings > costs: settings.json "falgen", the same shape); project.json wins.
export function falgenLink(p) {
  const meta = readJSON(path.join(projDir(p), 'project.json'), {}) || {};
  if (meta.falgen) return { f: meta.falgen, from: 'project.json' };
  const s = read(p, 'settings.json') || {};
  return s.falgen ? { f: s.falgen, from: 'settings.json' } : null;
}
// falgen folders near the project that nobody linked: <media base>[/*[/*]]/gen/spent.json (read only: names, no content)
let candCache = { at: 0, base: null, list: [] };
export function falgenCandidates() {
  if (candCache.base === CFG.mediaBase && Date.now() - candCache.at < 2000) return candCache.list;   // (a burst of calls scans once)
  const out = [], skip = (n) => n.startsWith('.') || n === 'node_modules' || n === 'data'; let seen = 0;
  const look = (d, depth) => {
    if (out.length >= 8 || ++seen > 600) return;
    try { if (fs.statSync(path.join(d, 'gen', 'spent.json')).isFile()) out.push(relTo(CFG.mediaBase, path.join(d, 'gen'))); } catch (e) { /* none here */ }
    if (depth >= 2) return;
    let names = []; try { names = fs.readdirSync(d, { withFileTypes: true }).filter(x => x.isDirectory() && !skip(x.name)).map(x => x.name).slice(0, 200); } catch (e) { return; }
    for (const n of names) look(path.join(d, n), depth + 1);
  };
  look(CFG.mediaBase, 0);
  candCache = { at: Date.now(), base: CFG.mediaBase, list: out };
  return out;
}
export function falgenSource(p) {
  const link = falgenLink(p), f = link?.f;
  if (!f) return null;
  const dirRel = typeof f === 'string' ? f : f?.dir;
  const within = (x) => { if (typeof x !== 'string' || !x || /\0/.test(x)) return null; const abs = path.resolve(CFG.mediaBase, x); return abs === CFG.mediaBase || abs.startsWith(CFG.mediaBase + path.sep) ? abs : null; };
  const dir = within(dirRel);
  if (!dir) return { error: `${link.from} falgen: "${dirRel}" must be a folder inside the media base (${CFG.mediaBase})`, rows: [], other: [], total: null, from: link.from };
  const ledger = within(typeof f === 'object' && f.ledger ? f.ledger : path.relative(CFG.mediaBase, path.join(dir, '..', 'LEDGER.md')));
  const spent = readJSON(path.join(dir, 'spent.json'), null);
  const rows = [], other = [];
  let text = ''; try { text = ledger ? fs.readFileSync(ledger, 'utf8') : ''; } catch (e) { /* no ledger */ }
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('|')) continue;
    const c = line.split('|').slice(1, -1).map(x => x.trim());
    if (c.length < 5 || !/^\d{4}-\d{2}-\d{2}$/.test(c[0])) continue;
    const usd = num(c[4]);
    if (/via falgen/i.test(c[2])) rows.push({ date: c[0], job: c[1], tool: c[2], usd: usd ?? 0 });
    else other.push({ date: c[0], phase: c[1], tool: c[2], items: c[3], usd, approx: /~/.test(c[4]) });
  }
  return { dir: relTo(CFG.mediaBase, dir), ledger: ledger ? relTo(CFG.mediaBase, ledger) : null, total: Number(spent?.total) >= 0 ? Number(spent.total) : null, rows, other, from: link.from, ...(spent ? {} : { missing: `${relTo(CFG.mediaBase, dir)}/spent.json not found` }) };
}
export function costSummary(project) {
  const C = read(project, 'costs.json'), R = read(project, 'requests.json').items || [];
  const spent = +sum(C.items || [], x => x.usd).toFixed(2);
  const committed = +sum(R.filter(r => ['approved', 'queued', 'running'].includes(r.status)), r => r.est_cost).toFixed(2);
  const drafts = +sum(R.filter(r => r.status === 'draft'), r => r.est_cost).toFixed(2);
  const cap = Number(C.cap_usd) || 0;
  const sources = [{ id: 'workbench', label: 'workbench (costs.json)', usd: spent, rows: (C.items || []).length }];
  const fg = falgenSource(project), warnings = [];
  let extra = 0, falgen = null;
  if (fg) {
    const keys = new Set((C.items || []).flatMap(x => [x.id, x.job, x.request]).filter(Boolean).map(x => String(x).toLowerCase()));
    const fresh = fg.rows.filter(r => !keys.has(String(r.job).toLowerCase())), dup = fg.rows.length - fresh.length;
    const rowsUsd = +sum(fg.rows, r => r.usd).toFixed(3), freshUsd = +sum(fresh, r => r.usd).toFixed(3);
    const unitemized = fg.total != null && fg.total - rowsUsd > 0.005 ? +(fg.total - rowsUsd).toFixed(3) : 0;
    extra = freshUsd + unitemized;
    sources.push({ id: 'falgen', label: `falgen ledger rows not in costs.json (${fg.ledger || 'no ledger'})`, usd: +freshUsd.toFixed(2), rows: fresh.length, deduped: dup });
    if (unitemized) sources.push({ id: 'falgen_unitemized', label: `falgen spent.json total not itemised by a ledger row (${fg.dir}/spent.json $${fg.total})`, usd: +unitemized.toFixed(2) });
    falgen = { linked: true, from: fg.from, dir: fg.dir, ledger: fg.ledger, spent_json_total: fg.total, ledger_rows: fg.rows.length, deduped: dup, new_rows: fresh.slice(-20), other_ledger_rows: fg.other, ...(fg.error ? { error: fg.error } : {}), ...(fg.missing ? { missing: fg.missing } : {}),
      rule: 'a falgen row whose job is a costs.json item (id, job or request) counts once; spent.json beyond the itemised rows counts as not itemised; other ledger rows are listed, not added' };
    if (fg.error) warnings.push(fg.error); else if (fg.missing) warnings.push(`falgen is linked (${fg.from}) but ${fg.missing}: its spend is not counted`);
  } else {
    // not linked: say so, and point at a falgen folder that exists nearby (spend there is invisible until it is linked)
    const cands = falgenCandidates();
    falgen = { linked: false, candidates: cands, how: 'link a falgen folder (a runner that spends outside the queue) in the page: Settings > costs > falgen folder, or in data/<project>/project.json: {"falgen": "<folder, relative to the media base>"}' };
    if (cands.length) warnings.push(`falgen: not configured, but ${cands.map(c => c + '/spent.json').join(', ')} exist${cands.length > 1 ? '' : 's'} near the project: its spend is NOT in this total. Link it (Settings > costs > falgen folder, or project.json "falgen": "${cands[0]}"), or record its jobs with cost_record`);
  }
  const total = +(spent + extra).toFixed(2);
  return { cap_usd: cap, spent_usd: spent, total_spent_usd: total, committed_usd: committed, drafts_usd: drafts, remaining_usd: cap ? +(cap - total - committed).toFixed(2) : null,
    sources, falgen, ...(warnings.length ? { warnings } : {}),
    other_usd: +sum(C.pre_production || [], x => x.usd).toFixed(2), ...(C.fal_total_usd != null ? { provider_total_usd: C.fal_total_usd } : {}),
    jobs: (C.items || []).length, recent: (C.items || []).slice(-10) };
}

Object.assign(ops, {
  // ---------------- approvals
  approvals_get(p, { keys, prefix, state } = {}) {
    const A = read(p, 'approvals.json');
    const items = Object.entries(A.items || {}).filter(([k, v]) => (!keys || keys.includes(k)) && (!prefix || k.startsWith(prefix)) && (!state || v.state === state));
    const counts = {}; for (const v of Object.values(A.items || {})) counts[v.state] = (counts[v.state] || 0) + 1;
    return { states: A.states, counts, items: Object.fromEntries(items), ...(keys ? { missing_are_draft: keys.filter(k => !A.items?.[k]) } : {}) };
  },
  set_states(p, { keys, state, comment, by = 'agent', director_approved = false }) {
    if (!Array.isArray(keys) || !keys.length) fail(400, 'keys: a non-empty list like ["shot:c1-desk", "use:G05@20158"]');
    for (const k of keys) if (typeof k !== 'string' || !/^[a-z-]+:.+/.test(k)) fail(400, `bad key "${k}" (kind:id)`);
    const states = read(p, 'approvals.json').states || DEFAULTS['approvals.json'].states;
    if (!states.includes(state)) fail(400, `state must be one of ${states.join(', ')}`);
    if (DIRECTOR_STATES.includes(state)) directorGate(director_approved);
    mutate(p, 'approvals.json', (d) => { for (const k of keys) d.items[k] = { ...(d.items[k] || {}), state, by, via: 'agent', at: nowIso(), ...(comment ? { comment } : {}) }; });
    return { state, keys };
  },
  // ---------------- generation requests
  requests_list(p, { status, target } = {}) {
    return (read(p, 'requests.json').items || []).filter(r => (!status || r.status === status) && (!target || r.target === target));
  },
  request_create(p, { kind, target, prompt, refs = [], est_cost, look, tool, by = 'agent', extra, char, asset, recipe, takes }) {
    if (!kind) fail(400, 'kind required');
    if (!Array.isArray(refs)) fail(400, 'refs: a list of paths');
    if (est_cost != null && !(Number(est_cost) >= 0)) fail(400, 'est_cost: USD, a number >= 0');
    if (takes != null && !(Number.isInteger(takes) && takes >= 1 && takes <= 8)) fail(400, 'takes: how many images to make, an integer 1-8 (est_cost covers all of them)');
    if (est_cost == null && !recipe) fail(400, 'est_cost (USD, a number >= 0) is required: the director approves against the cap (or pass recipe: the photoreal recipe estimates it from js/prices.js)');
    const warnings = [];
    // an asset generation (stages 4 and 5) names the tree it grows (asset_iteration_add reads it back): `asset` {type, id,
    // tree, from, kind}. `char` {id, ...} (the stage-4 name) is still accepted for a character, with a deprecation
    // warning, and stored as `asset` only
    const ln = asset ?? extra?.asset, lc = char ?? extra?.char;
    let link = null, type = null;
    if (ln == null && lc != null) warnings.push('char is deprecated: pass asset {type: "character", id, tree, from, kind} (stored as asset)');
    if (ln != null || lc != null) {
      type = ln != null ? assetType(ln?.type) : 'character'; link = checkAssetLink(p, ln ?? lc, type);
      const { char: _c, asset: _a, ...ex } = (extra && typeof extra === 'object') ? extra : {};
      target ||= `${type}:${link.id}`; extra = { ...ex, asset: { type, ...link } };
      // a variant (look) sheet starts from the approved root (identity): say so now, before anything is spent
      const T = A.TYPE[type], { ent } = readAsset(p, type, link.id), rn = A.approvedNode(ent.iter, T.root);
      if (A.treeVariant(link.tree) && !link.from) {
        if (!rn) {
          const open = (Array.isArray(ent.iter.proposals) ? ent.iter.proposals : []).filter(x => x.status === 'open' && x.tree === T.root).map(x => x.id);
          const heads = A.treeNodes(ent.iter, T.root).map(n => n.id);
          warnings.push(`${link.id} has no approved ${T.rootWord} yet. Order: (1) the director approves the ${T.rootWord} in the page (${open.length ? `accept the ${T.rootWord} import proposal ${open.join(', ')}, then approve it` : heads.length ? `approve one of its nodes ${heads.slice(-3).join(', ')}` : `there is none: request the ${T.rootWord} sheet, or node_import_propose an existing image as it`}); (2) put the approved ${T.rootWord} image first in refs (request_update refs; the identity lock is added); (3) the director approves this request and it runs. Its outputs then join ${link.tree} grown from the approved ${T.rootWord} (from is filled in when they are registered). Run before (1), they cannot become nodes: the runner proposes them as imports instead`);
        }
        else warnings.push(`from is null: a ${T.vWord} sheet starts from the approved ${T.rootWord} node ${rn.id} (set from: "${rn.id}", its image first in refs)`);
      }
    }
    // the photoreal recipe (templates/photoreal_recipe.json, js/recipe.js): the prompt built from blocks, per model
    let rec = null;
    if (recipe) {
      const o = recipe === true ? {} : (typeof recipe === 'object' && !Array.isArray(recipe) ? recipe : fail(400, 'recipe: true or {model, framing, subject, wardrobe, action, place, light, camera, texture, grade, seconds, takes, blocks}'));
      if (o.takes != null && takes != null && Number(o.takes) !== takes) fail(400, `takes ${takes} and recipe.takes ${o.takes} differ: give one`);
      takes ??= o.takes;
      if (takes != null && !(Number.isInteger(takes) && takes >= 1 && takes <= 8)) fail(400, 'recipe.takes: how many images to make, an integer 1-8');
      const who = recipeSubject(p, type, link, refs, o);
      const built = RC.buildRecipe(loadRecipe(), { ...o, ...who, takes: takes || 1, refs: refs.length });
      rec = recipeRecord(built, who, o);
      if (prompt) warnings.push('prompt given: it is used as is; the recipe blocks are stored with the request (recipe.blocks) to edit later');
      else prompt = built.prompt;
      if (est_cost == null) est_cost = built.est.usd;   // the estimate covers every take
      tool ||= built.est.tool;
      warnings.push(...built.warnings);
      if (built.negative_prompt) rec.negative_prompt = built.negative_prompt;
    }
    // extra goes first and never carries lifecycle fields: a new request is always a draft
    const { id: _i, status: _s, log: _l, by: _b, at: _a, est_cost: _e, outputs: _o, actual_cost_usd: _c, why: _w, warnings: _wa, recipe: _r, handoff: _h, linked: _k, last_run: _lr, private_upload_ok: _pu, ...rest } = (extra && typeof extra === 'object') ? extra : {};
    const item = { ...rest, id: `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`, kind, target: target || null, prompt: prompt || '', refs, est_cost: Number(est_cost),
      status: 'draft', by, at: nowIso(), ...(tool ? { tool } : {}), ...(takes > 1 ? { takes } : {}), ...(look ? { look } : {}), ...(rec ? { recipe: rec } : {}), ...(warnings.length ? { warnings } : {}), log: [{ at: nowIso(), by, via: 'agent', status: 'draft' }] };
    mutate(p, 'requests.json', (d) => { d.items.push(item); });
    return item;
  },
  // a cost that was spent outside the queue (falgen or another runner, work done before a request existed): recorded in
  // costs.json with its provenance (via, job, take). It is never an approval: no request changes status, and a request's
  // own cost is recorded by request_update done. The same (job, take) is recorded once.
  cost_record(p, { usd, via, job, take, takes, tool, date, request, note, t, by = 'agent' } = {}) {
    if (!(Number(usd) >= 0) || usd === '' || usd == null) fail(400, 'usd: what was spent, a number >= 0');
    if (typeof via !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(via)) fail(400, 'via: who spent it, a short word (falgen, retro, manual, fal-console)');
    if (job != null && (typeof job !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,63}$/.test(job))) fail(400, 'job: the runner\'s job id (letters, digits, _ . @ -)');
    if (take != null && !(Number.isInteger(take) && take >= 0)) fail(400, 'take: an integer >= 0');
    if (takes != null && !(Number.isInteger(takes) && takes >= 1 && takes <= 64)) fail(400, 'takes: how many takes the job made, an integer 1-64');
    if (takes != null && take != null) fail(400, 'takes (the whole job) or take (one take), not both');
    if (date != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) fail(400, 'date: YYYY-MM-DD');
    let req = null;
    if (request != null) {
      req = (read(p, 'requests.json').items || []).find(r => r.id === request); if (!req) fail(404, `no request "${request}"`);
      if (req.status === 'done') fail(409, `request ${request} is done: its cost was recorded when it was marked done`);
    }
    const C = read(p, 'costs.json'); C.items ||= [];
    const dup = job != null && C.items.find(x => (x.job === job || (!x.job && x.id === job)) && (take == null || x.take == null || x.take === take));
    if (dup) return { recorded: false, reason: `already recorded (job ${job}${take != null ? ' take ' + take : ''})`, item: dup, costs: costSummary(p) };
    const ids = new Set(C.items.map(x => x.id));
    let id = job ? (take != null ? `${job}#${take}` : job) : `c${Date.now().toString(36)}`; for (let k = 2; ids.has(id); k++) id = `${job || 'c'}-${k}`;
    const item = { id, t: ms(t, 't') ?? timeOfKey(p, req?.target) ?? 0, usd: Number(usd), tool: tool ? String(tool).slice(0, 200) : via, date: date || nowIso().slice(0, 10), via, recorded_by: String(by).slice(0, 60), recorded_at: nowIso(),
      ...(job ? { job } : {}), ...(take != null ? { take } : {}), ...(takes > 1 ? { takes } : {}), ...(req ? { request: req.id } : {}), ...(note ? { note: String(note).slice(0, 1000) } : {}) };
    if (!appendCost(p, item, (x) => x.id === item.id || (job != null && (x.job === job || (!x.job && x.id === job)) && (take == null || x.take == null || x.take === take)))) return { recorded: false, reason: `already recorded (job ${job}${take != null ? ' take ' + take : ''}; by another process just now)`, costs: costSummary(p) };
    const c = costSummary(p);
    return { recorded: true, item, costs: c, note: 'a cost record is never an approval: no request was approved or moved', ...(c.cap_usd && c.total_spent_usd > c.cap_usd ? { warnings: [`spent $${c.total_spent_usd} is over the cap $${c.cap_usd}`] } : {}) };
  },
});

Object.assign(ops, {
  request_update(p, { id, status, prompt, refs, est_cost, outputs, actual_cost_usd, why, tool, by = 'agent', director_approved = false, register_media = true, media_kind, recipe, generator, superseded_by }) {
    const cur = (read(p, 'requests.json').items || []).find(r => r.id === id);
    if (!cur) fail(404, `no request "${id}"`);
    // recipe {blocks: {<id>: text}, <field>: text, identity?, takes?}: rebuild the prompt from the stored recipe with these
    // edits (a prompt edit). The blocks marked edited keep their text; the others are rebuilt from the fields, the refs
    // and the entity (its name, constants and whether image 1 is now its approved identity)
    let recipePatch = null, warnings = [];
    if (recipe != null) {
      if (!cur.recipe) fail(400, `request ${id} was not made from the recipe (create it with recipe, or edit prompt)`);
      if (typeof recipe !== 'object' || Array.isArray(recipe)) fail(400, 'recipe: {blocks: {<block id>: text}, subject?, wardrobe?, place?, light?, identity?, takes?, ...}');
      if (recipe.identity != null && typeof recipe.identity !== 'boolean') fail(400, 'recipe.identity: true when image 1 is the approved face / identity');
      if (recipe.takes != null && !(Number.isInteger(recipe.takes) && recipe.takes >= 1 && recipe.takes <= 8)) fail(400, 'recipe.takes: an integer 1-8');
      const fields = { ...(cur.recipe.fields || {}), ...Object.fromEntries(RC.FIELDS.map(x => [x.id, recipe[x.id]]).filter(([, v]) => v != null)) };
      const v2 = cur.recipe.v >= 2, R0 = refs || cur.refs || [];
      const L = A.linkOf(cur), type = L ? (L.type || 'character') : null;
      let who = { name: cur.recipe.name, identity: !!cur.recipe.identity, character: !!cur.recipe.character, constants: RC.constantsOf(cur.recipe.constants) };
      try { if (L) who = recipeSubject(p, type, L, R0, { name: cur.recipe.name, identity: recipe.identity ?? (refs ? undefined : cur.recipe.identity) }); } catch (e) { /* the entity is gone: keep what the request stored */ }
      if (!L && recipe.identity != null) who.identity = recipe.identity;
      const identityChanged = who.identity !== !!cur.recipe.identity;
      const blocks = { ...Object.fromEntries((cur.recipe.blocks || []).filter(b => !v2 || b.edited).map(b => [b.id, b.text])), ...(recipe.blocks || {}) };
      // a changed field rebuilds its block unless that block was edited in this call; a changed identity its references
      for (const k of Object.keys(recipe)) if (k !== 'blocks') for (const b of cur.recipe.blocks || []) if (!recipe.blocks?.[b.id] && (b.id === k || (k === 'place' && b.id === 'location') || ((k === 'subject' || k === 'wardrobe') && b.id === 'subject_wardrobe') || (k === 'grade' && b.id === 'medium'))) delete blocks[b.id];
      if (identityChanged) for (const b of ['refs', 'identity_lock', 'constants']) if (!recipe.blocks?.[b]) delete blocks[b];
      const takes = recipe.takes ?? cur.recipe.takes ?? cur.takes ?? 1;
      const built = RC.buildRecipe(loadRecipe(), { ...fields, model: cur.recipe.model, framing: cur.recipe.framing, ...who, takes, refs: R0.length, blocks });
      prompt = built.prompt; recipePatch = { ...recipeRecord(built, who, fields), fields };
      warnings = built.warnings;
      if (recipe.takes != null && recipe.takes !== (cur.takes || 1)) { est_cost ??= built.est.usd; recipePatch.takes_changed = true; }
    }
    const takesPatch = recipePatch?.takes_changed ? recipe.takes : null; if (recipePatch) delete recipePatch.takes_changed;
    // the tool/model is part of what the director approved; at done, `tool` only names what ran (recorded in costs.json)
    const toolEdit = tool != null && tool !== cur.tool && status !== 'done';
    const patch = {}, edits = prompt != null || refs != null || est_cost != null || toolEdit;
    if (edits) {
      if (!['draft', 'approved'].includes(cur.status)) fail(409, `request ${id} is ${cur.status}: only draft or approved requests can be edited`);
      if (est_cost != null && !(Number(est_cost) >= 0)) fail(400, 'est_cost: a number >= 0');
      if (prompt != null) patch.prompt = prompt; if (refs != null) patch.refs = refs; if (est_cost != null) patch.est_cost = Number(est_cost); if (toolEdit) patch.tool = tool;
      if (recipePatch) {
        patch.recipe = recipePatch; if (takesPatch) patch.takes = takesPatch;
        const ws = [...(cur.warnings || []).filter(w => !RECIPE_WARNING.test(w)), ...warnings]; if (ws.length || cur.warnings) patch.warnings = ws;
      }
      if (cur.private_upload_ok) patch.private_upload_ok = false;   // the director's "allow uploading private refs" was for what they saw
      if (cur.status === 'approved') {     // an edit voids the approval, whatever status the same call asks for
        if (status && status !== 'draft') fail(409, `request ${id} is approved: an edit (prompt/refs/est_cost/tool) voids the approval and sends it back to draft; ask the director to approve it again`);
        status = 'draft';
      }
    }
    if (status && status !== cur.status) {
      if (!REQUEST_STATUSES.includes(status)) fail(400, `status must be one of ${REQUEST_STATUSES.join(', ')}`);
      if (!NEXT[cur.status].includes(status)) fail(409, `cannot move a ${cur.status} request to ${status} (allowed: ${NEXT[cur.status].join(', ') || 'none'})`);
      if (status === 'approved' && cur.status === 'draft') {
        if (!director_approved) fail(403, 'only the director approves requests: ask them (or they click the chip in Review > Queue); pass director_approved:true only when they said so in this conversation');
        directorGate(true);
      }
      if ((status === 'queued' || status === 'running') && !approvalOk(cur)) fail(403, `request ${id} has no director approval on record (approved in the page${CFG.agentApprovals ? ' or by director_approved:true' : ''}): ask the director to approve it in Review > Queue`);
      if (status === 'queued' || status === 'running') {
        const c = costSummary(p), est = Number(patch.est_cost ?? cur.est_cost) || 0;
        const others = ['approved', 'queued', 'running'].includes(cur.status) ? c.committed_usd - (Number(cur.est_cost) || 0) : c.committed_usd;
        if (c.total_spent_usd + others + est > c.cap_usd + 1e-9) fail(402, `over the cap: spent $${c.total_spent_usd} + committed $${others.toFixed(2)} + this $${est} > cap $${c.cap_usd}; ask the director to raise costs.json cap_usd or reject something`);
      }
      if (status === 'done') {
        if (!Array.isArray(outputs) || !outputs.length) fail(400, 'done needs outputs: [paths of the generated files]');
        if (actual_cost_usd == null || !(Number(actual_cost_usd) >= 0)) fail(400, 'done needs actual_cost_usd (what the provider charged, 0 if free)');
      }
      if (status === 'rejected' && !why && cur.status !== 'draft') fail(400, 'rejected needs why (what failed)');
      // withdrawn: its author takes a draft back (obsolete, superseded). Not the director's rejection: an agent withdraws
      // only an agent's draft (the director's own drafts and decisions stay theirs)
      if (status === 'withdrawn' && requestAuthor(cur) === 'director') fail(403, `request ${id} is the director's draft: only they withdraw it (in the page); say why in a note instead`);
      if (status === 'failed' && !why) fail(400, 'failed needs why (what went wrong)');
      patch.status = status;
    }
    if (superseded_by != null) {
      const ids = Array.isArray(superseded_by) ? superseded_by : [superseded_by];
      if (ids.some(x => typeof x !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_:/-]{0,79}$/.test(x))) fail(400, 'superseded_by: ids of what replaces it (requests, proposals ip02, nodes n04)');
      if ((patch.status || cur.status) !== 'withdrawn') fail(400, 'superseded_by goes with status "withdrawn"');
      patch.superseded_by = [...new Set(ids)].slice(0, 20);
    }
    if (outputs) patch.outputs = outputs;
    if (actual_cost_usd != null) patch.actual_cost_usd = Number(actual_cost_usd);
    if (why) patch.why = why;
    let registered = [];
    if (patch.status === 'done') {
      const usd = Number(actual_cost_usd), t = timeOfKey(p, cur.target) ?? 0;
      // one cost item per request (id = request id), recorded here once: the merged ledger (costs_get) dedupes by id / job
      // / request, so a runner's cost_record of the same job cannot count it twice
      {
        appendCost(p, { id: cur.id, t, usd, tool: tool || cur.tool || cur.kind, date: nowIso().slice(0, 10), request: cur.id, ...(generator ? { via: 'runner', generator: String(generator).slice(0, 32), job: cur.id } : {}) }, (x) => x.request === cur.id || x.id === cur.id);
      }
      if (register_media) for (const [i, o] of outputs.entries()) {
        try { const r = ops.media_add(p, { path: o, kind: media_kind || (VIDEO.test(o) ? 'clip' : AUDIO.test(o) ? 'audio' : 'still'), label: `${cur.kind} ${cur.target || ''} · ${cur.id}`.trim(), job: cur.id, take: i, cost_usd: +(usd / outputs.length).toFixed(3), request: cur.id,
          ...((cur.refs || []).some(x => isPrivate(x) || isFlaggedPrivate(x, [p])) ? { private: true } : {}),   // made from a private photo: private too
          entities: /^(character|location|prop):/.test(cur.target || '') ? [cur.target.split(':')[1]] : [], shots: /^shot:/.test(cur.target || '') ? [cur.target.slice(5)] : [] }); registered.push(r.media.path); }
        catch (e) { registered.push(`(not indexed: ${o}: ${e.message})`); }
      }
      if (registered.length) patch.outputs = registered.map((r, i) => r.startsWith('(') ? outputs[i] : r);
    }
    const item = mutate(p, 'requests.json', (d) => {
      const r = d.items.find(x => x.id === id);
      Object.assign(r, patch, { at: nowIso() });
      if (patch.private_upload_ok === false) (r.log ||= []).push({ at: nowIso(), by, via: 'agent', private_upload: false, why: 'edited: tick "allow uploading private refs" again' });
      if (patch.status) (r.log ||= []).push({ at: nowIso(), by, via: 'agent', status: patch.status, ...(patch.status === 'approved' && cur.status === 'draft' ? { director_approved: true } : {}), ...(why ? { why } : {}) });
      return { ...r };
    });
    return { request: item, ...(recipePatch && warnings.length ? { warnings } : {}), ...(patch.status === 'done' ? { cost_recorded_usd: Number(actual_cost_usd), media: registered, costs: costSummary(p) } : {}) };
  },
  costs_get(p) { return costSummary(p); },
  // ---------------- the runner (lib/run.mjs, generators/): run APPROVED requests; the page's Run buttons, request_run and
  // tools/run.mjs share it. dry_run: the plan (generator, model, endpoint, takes, estimate, cap, outputs that exist)
  // with no call, file or status change. Otherwise the runnable ones start in the background (wait: true returns when
  // they finish); progress reaches the page through the server's SSE and requests.json.
  async request_run(p, { ids, all = false, dry_run = false, parallel = 2, wait = false, by = 'agent' } = {}) {
    if (ids != null && (!Array.isArray(ids) || ids.some(x => typeof x !== 'string'))) fail(400, 'ids: a list of request ids');
    const plan = planRun(p, { ids, all: !!all });
    const refused = plan.items.filter(x => !x.ok).map(({ id, status, why }) => ({ id, status, why }));
    if (dry_run) return { dry_run: true, ...plan, refused, note: 'dry run: nothing was submitted, written or spent; no status changed' };
    const who = String(by || 'agent').slice(0, 40), started = plan.items.filter(x => x.ok).map(x => ({ id: x.id, generator: x.generator, tool: x.tool, takes: x.takes, est_usd: x.est_usd, resume: x.resume || undefined }));
    const job = runPlan(p, plan, { parallel, by: `runner (${who})` });
    if (wait) { const results = await job; return { results, refused, costs: costSummary(p) }; }
    job.catch((e) => console.error('runner:', e.message));
    return { started, refused, est_total_usd: plan.est_total_usd, note: started.length ? 'running in the background: the Queue shows it live; wait_for {request: <id>, until: ["done", "failed"]} returns when one finishes' : 'nothing to run' };
  },
  generators_get(p) { return generatorsInfo(p); },
});
