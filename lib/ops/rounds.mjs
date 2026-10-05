// Review rounds and revisions (docs/SPEC_v4_NOTES_ROUNDS.md §2; ROADMAP_v4 B6-B8). Shapes and shared logic: js/revisions.js.
//   round_send       PAGE ONLY: every open note of the director's -> one ask for the agent; notes.json `round` + 1;
//                    the state when sent is snapshotted (the round's base)
//   round_get        the round in flight: its notes grouped by stage, each with its target's content inlined, + progress
//   round_absorb     the agent did what a note asks: absorbed, linked to the change {stage, file?, version?, summary}
//                    (absorbed_in = the revision the round becomes)
//   round_reply      the agent could not (or will not) apply a note: a reply, the note stays open for the director
//   round_finish     the agent is done with the round (a summary); it never approves or closes anything
//   revision_close   PAGE ONLY: the round in flight (or the state now) becomes R<n>: an immutable snapshot + an entry in
//                    revisions.json {id, round, created, summary, notes_absorbed, files_changed, cost_delta, ...}; with
//                    settings.json `revisions_git: true` and git on PATH, also a commit in data/<p>/.history (a repo of
//                    its own, never the workbench's)
//   revision_restore PAGE ONLY: the project files back to a revision (the current state is snapshotted first); the notes
//                    (the conversation) and revisions.json are kept
//   revisions_get    the index (+ the round in flight); revision_compare {a, b}: what changed per stage between two
//                    revisions ("now" = the files now, "R0" = the state before the first round), each change linked to
//                    the notes absorbed in between
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as N from '../../js/notes.js';
import * as F from '../../js/flow.js';
import * as SC from '../../js/scenes.js';
import * as BD from '../../js/breakdown.js';
import * as SB from '../../js/storyboard.js';
import * as A from '../../js/assets.js';
import * as RV from '../../js/revisions.js';
import { fail, inside, nowIso, ops, projDir, read, readJSON, tc, writeAtomic, writeJSON } from './_shared.mjs';
import { snapshot, restore, snapFiles } from './core.mjs';
import { notesDoc, mutateNotes, setStatus, replyNote, noteView } from './notes.mjs';
import { lyricsDoc } from './lyrics.mjs';
import { scenesDoc } from './scenes.mjs';
import { breakdownDoc } from './breakdown.mjs';
import { boardDoc } from './storyboard.mjs';

// ------------------------------------------------------------------ revisions.json (the server's only)
const RFILE = 'revisions.json';
export const revDoc = (p) => RV.normRevisions(readJSON(path.join(projDir(p), RFILE), null, true));
function mutateRev(p, fn) { const d = revDoc(p); const r = fn(d); d.rev = (d.rev || 0) + 1; writeJSON(path.join(projDir(p), RFILE), d); return r === undefined ? d : r; }
const pageOnly = (via, what) => { if (via !== 'page') fail(403, `only the director ${what}, in the page (the stage rail's round controls): an agent cannot`); };
const snapDir = (p, sid) => { const d = inside(path.join(projDir(p), '.snapshots'), String(sid || '')); if (!d || !fs.existsSync(path.join(d, '.meta.json'))) fail(404, `no snapshot "${sid}"`); return d; };
const sumUsd = (costs) => +((costs?.items || []).reduce((a, x) => a + (Number(x.usd) || 0), 0)).toFixed(4);
const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
function liveRound(p, { need = true } = {}) {
  const rv = revDoc(p), r = RV.inFlight(rv);
  if (!r && need) fail(409, 'no round in flight: the director sends one from the page ("Send round to Claude" on the stage rail). For a single note outside a round use notes_status / notes_add reply_to');
  return { rv, r };
}

// ------------------------------------------------------------------ the content a note's target points at (inlined in round_get)
function targetContent(p, t, cx) {
  const lazy = (k, f) => (k in cx ? cx[k] : (cx[k] = (() => { try { return f(); } catch (e) { return null; } })()));
  const ly = () => lazy('ly', () => F.currentVersion(lyricsDoc(p)));
  const scenes = () => lazy('sc', () => SC.currentScript(scenesDoc(p))?.scenes || []);
  const shots = () => lazy('sb', () => SB.boardShots(boardDoc(p)));
  const items = () => lazy('bd', () => BD.currentBreakdown(breakdownDoc(p))?.items || []);
  const song = () => lazy('song', () => read(p, 'song.json'));
  const [a, b] = N.splitId(t.id);
  if (t.stage === 'lyrics') {
    const v = ly();
    if (t.kind === 'line') { const L = F.flatLines(v).find(l => l.id === t.id); return L ? { version: v.id, section: L.label, line: L.text, ...(t.quote ? { words: t.quote } : {}) } : { gone: `line ${t.id} is not in the current lyrics` }; }
    if (t.kind === 'section') { const s = v?.sections?.find(x => x.id === t.id); return s ? { version: v.id, section: s.label, lines: s.lines.map(l => l.text) } : { gone: `section ${t.id} is not in the current lyrics` }; }
    return { version: v?.id || null, lines: F.flatLines(v).length };
  }
  if (t.stage === 'script') {
    if (t.kind === 'stage') return { scenes: scenes().length };
    const s = scenes().find(x => x.id === a); if (!s) return { gone: `scene ${a} is not in the current script` };
    if (t.kind === 'beat') { const x = s.beats.find(y => y.id === b); return x ? { scene: s.id, scene_title: s.title, time: tc(x.t), beat: x.text } : { gone: `beat ${t.id} is gone` }; }
    return { scene: s.id, time: `${tc(s.t0)}–${tc(s.t1)}`, title: s.title, text: clip(s.text, 600), beats: s.beats.map(x => `${x.id} ${tc(x.t)} ${clip(x.text, 120)}`) };
  }
  if (t.stage === 'breakdown') {
    if (t.kind === 'item') { const i = items().find(x => x.id === t.id); return i ? { item: i.id, kind: i.kind, name: i.name, description: clip(i.description, 400), scenes: i.links.map(l => l.scene) } : { gone: `item ${t.id} is not in the current breakdown` }; }
    if (t.kind === 'scene') { const s = scenes().find(x => x.id === t.id); return { scene: t.id, title: s?.title || null, needs: items().filter(i => i.links.some(l => l.scene === t.id)).map(i => `${i.kind} ${i.name}`) }; }
    return { items: items().length };
  }
  if (t.stage === 'characters' || t.stage === 'scenery') {
    if (t.kind === 'stage') return {};
    const e = (read(p, 'entities/index.json') || []).find(x => x.id === a); if (!e) return { gone: `asset ${a} is gone` };
    const ent = readJSON(path.join(projDir(p), e.path), {}) || {}, it = A.normIter(ent.iter);
    const out = { asset: a, kind: e.kind, name: ent.name || a };
    if (t.kind === 'node') { const n = A.nodeById(it, b); return n ? { ...out, node: n.id, tree: n.tree, image: n.image, edit: n.edit?.text || null, ...(t.pin ? { pin: t.pin } : {}) } : { ...out, gone: `node ${b} is gone` }; }
    if (t.kind === 'tree') { const h = A.headNode(it, b); return { ...out, tree: b, head: h?.id || null, image: h?.image || null, approved: A.treeState(it, b).approved || null }; }
    if (t.kind === 'use') return { ...out, scene: b, variant: ent.uses?.[b]?.variant ?? null };
    const h = A.headNode(it, A.rootTree(e.kind)); return { ...out, head: h?.id || null, image: h?.image || null };
  }
  if (t.stage === 'storyboard' || t.stage === 'final') {
    if (t.kind === 'shot') { const s = shots().find(x => x.id === t.id); return s ? { shot: s.id, scene: s.scene, time: `${tc(s.t0)}–${tc(s.t1)}`, kind: s.kind, title: s.title, text: clip(s.text, 400), camera: s.camera, cast: s.cast, sketch: s.sketch || null } : { gone: `shot ${t.id} is not in the storyboard` }; }
    if (t.kind === 'scene') return { scene: t.id, shots: shots().filter(x => x.scene === t.id).map(x => x.id) };
    return { shots: shots().length };
  }
  if (t.stage === 'timeline') { const L = (song()?.lines || []).filter(l => l.t0 <= t.t).pop(); return { time: tc(t.t ?? 0), ...(L && t.t <= L.t1 + 2000 ? { lyric: L.text, line: L.id } : {}) }; }
  return {};
}

// the ask a round writes: one note to the agent listing every note it sends (its target and words), within 8000 chars
function askText(n, list) {
  const head = `Round ${n}: ${list.length} note${list.length > 1 ? 's' : ''} from the director. Apply each one (round_get has them grouped by stage with the content they point at), then round_absorb {note, change} per note you applied, round_reply {note, text} for one you could not, and round_finish {summary} when done.`;
  const lines = []; let size = head.length;
  for (const [i, x] of list.entries()) {
    const ln = `\n- ${x.id} [${N.STAGE_TITLE[x.target.stage]}: ${N.targetLabel(x.target)}] ${clip(x.text, 220)}`;
    if (size + ln.length > 7700) { lines.push(`\n… and ${list.length - i} more (round_get)`); break; }
    lines.push(ln); size += ln.length;
  }
  return head + lines.join('');
}

// ------------------------------------------------------------------ the optional git mirror (data/<p>/.history: a repo of its own)
function gitMirror(p, rid, sd, summary) {
  const st = readJSON(path.join(projDir(p), 'settings.json'), {}) || {};
  if (st.revisions_git !== true) return null;   // opt-in
  const git = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  const v = git(['--version']); if (v.error || v.status !== 0) return { skipped: 'git is not on PATH' };
  const H = path.join(projDir(p), '.history'), G = path.join(H, '.git');
  fs.mkdirSync(H, { recursive: true });
  if (!fs.existsSync(G)) { const r = git(['init', '-q', H]); if (r.status !== 0 || !fs.existsSync(G)) return { skipped: `git init failed: ${clip(r.stderr, 200)}` }; }
  // always name the mirror's own repository: never the workbench's (or any parent folder's)
  const g = (...args) => git([`--git-dir=${G}`, `--work-tree=${H}`, '-c', 'user.name=workbench', '-c', 'user.email=workbench@localhost', '-c', 'core.autocrlf=false', ...args], H);
  for (const e of fs.readdirSync(H)) if (e !== '.git') fs.rmSync(path.join(H, e), { recursive: true, force: true });
  for (const f of snapFiles(sd)) { if (f === '.meta.json') continue; fs.mkdirSync(path.dirname(path.join(H, f)), { recursive: true }); fs.copyFileSync(path.join(sd, f), path.join(H, f)); }
  g('add', '-A');
  const c = g('commit', '-q', '--allow-empty', '-m', `${rid}: ${clip(summary, 200) || 'revision'}`);
  if (c.status !== 0) return { skipped: `git commit failed: ${clip(c.stderr || c.stdout, 200)}` };
  const h = g('rev-parse', '--short', 'HEAD');
  return { commit: String(h.stdout || '').trim(), dir: '.history' };
}

// ------------------------------------------------------------------ compare: one side (a revision's snapshot, or now)
function side(p, rv, id) {
  const dir = projDir(p);
  if (!id || id === 'now') return { id: 'now', label: 'now', dir };
  if (id === 'R0') { const b = rv.revisions.find(r => r.base)?.base; if (!b) fail(404, 'no R0: the first revision was not made from a round'); return { id: 'R0', label: 'before round 1', dir: snapDir(p, b) }; }
  const r = rv.revisions.find(x => x.id === id); if (!r) fail(404, `no revision "${id}" (revisions_get lists them)`);
  return { id, label: `${r.id}${r.summary ? ' · ' + clip(r.summary, 60) : ''}`, dir: snapDir(p, r.snapshot), created: r.created, rev: r };
}
function load(s) {
  const J = (f, d = null) => readJSON(path.join(s.dir, f), d);
  const song = J('song.json', {}), script = J('script.json', { stages: [], lines: [] }), shotsJ = J('shots.json', { shots: [], uses: [] });
  const scDoc = SC.normScenes(J('scenes.json'), song, script);
  const ents = (J('entities/index.json', []) || []).filter(e => typeof e?.path === 'string' && !/\.\./.test(e.path)).map(e => { const x = J(e.path); return x && typeof x === 'object' ? { ...x, id: e.id, kind: e.kind } : null; }).filter(Boolean);
  return { song, lyrics: F.currentVersion(F.normLyrics(J('lyrics.json'), song, {})), scenes: SC.currentScript(scDoc)?.scenes || [], shots: SB.boardShots(SB.normBoard(J('storyboard.json'), shotsJ, scDoc)),
    items: BD.currentBreakdown(BD.normBreakdown(J('breakdown.json')))?.items || [], ents, costs: J('costs.json', { items: [] }) };
}
const order = (rv, id) => id === 'now' ? 1e9 : id === 'R0' ? 0 : Number(String(id).slice(1)) || 0;
function compare(p, aId, bId) {
  const rv = revDoc(p), sa = side(p, rv, aId), sb = side(p, rv, bId), A_ = load(sa), B_ = load(sb);
  // the notes absorbed between the two (absorbed_in in (a, b]); "now" also counts the round in flight
  const lo = Math.min(order(rv, sa.id), order(rv, sb.id)), hi = Math.max(order(rv, sa.id), order(rv, sb.id));
  const live = RV.inFlight(rv), planned = live ? RV.nextRevisionId(rv) : null;
  const inRange = (rid) => { if (!rid) return false; if (rid === planned && hi === 1e9) return true; const k = order(rv, rid); return k > lo && k <= hi && k !== 1e9; };
  const notes = notesDoc(p).notes.filter(n => n.status === 'absorbed' && n.ask !== 'round' && inRange(n.absorbed_in));
  const link = (stage, id, o) => notes.filter(n => RV.noteHits(n, stage, id, o)).map(n => n.id);
  // lyrics: the changed lines (stable ids), each with a word diff
  const lines = RV.lineChanges(A_.lyrics, B_.lyrics).map(l => ({ ...l, runs: l.diff ? RV.diffRuns(l.diff) : null, diff: undefined, notes: link('lyrics', l.id, { section: (B_.lyrics?.sections || A_.lyrics?.sections || []).find(s => s.lines.some(x => x.id === l.id))?.id }) }));
  // script and storyboard: add / remove / move on the song's time line (+ the text diff of what was reworded)
  const scText = (s) => [s.title, s.text, ...(s.beats || []).map(b => b.text)].join('\n');
  const script = RV.timelineChanges(A_.scenes, B_.scenes, { text: scText }).map(x => ({ ...x, runs: x.diff ? RV.diffRuns(x.diff) : null, diff: undefined, notes: link('script', x.id) }));
  const sbText = (s) => [s.kind, s.title, s.text, s.camera, (s.cast || []).join(' '), s.sketch || ''].join('\n');
  const board = RV.timelineChanges(A_.shots, B_.shots, { text: sbText }).map(x => ({ ...x, runs: x.diff ? RV.diffRuns(x.diff) : null, diff: undefined, notes: link('storyboard', x.id, { scene: x.scene }) }));
  // breakdown: items added / removed / changed (which fields, which scene links)
  const ia = new Map(A_.items.map(i => [i.id, i])), ib = new Map(B_.items.map(i => [i.id, i])), bd = [];
  for (const id of new Set([...ia.keys(), ...ib.keys()])) {
    const x = ia.get(id), y = ib.get(id), o = y || x;
    if (x && y && JSON.stringify(x) === JSON.stringify(y)) continue;
    const row = { id, kind: o.kind, name: o.name, st: !x ? 'added' : !y ? 'removed' : 'changed', notes: link('breakdown', id) };
    if (x && y) {
      row.fields = ['name', 'description', 'kind', 'aliases', 'dropped', 'for'].filter(k => JSON.stringify(x[k]) !== JSON.stringify(y[k]));
      const ls = (i) => new Set(i.links.map(l => l.scene)); const la = ls(x), lb = ls(y);
      row.links_added = [...lb].filter(s => !la.has(s)); row.links_removed = [...la].filter(s => !lb.has(s));
      if (row.fields.includes('name')) row.was = x.name;
      if (y.dropped && !x.dropped) row.st = 'dropped';
    }
    bd.push(row);
  }
  // assets: per tree, the head (and approved) node on each side: image A / B
  const ea = new Map(A_.ents.map(e => [e.id, e])), eb = new Map(B_.ents.map(e => [e.id, e])), assets = [];
  const nodeOut = (it, n, tree) => n ? { node: n.id, image: n.image || null, private: !!n.private, approved: A.treeState(it, tree).approved === n.id } : null;
  for (const id of new Set([...ea.keys(), ...eb.keys()])) {
    const x = ea.get(id), y = eb.get(id), o = y || x, ix = A.normIter(x?.iter), iy = A.normIter(y?.iter);
    if (!x || !y) { assets.push({ id, kind: o.kind, name: o.name || id, st: !x ? 'added' : 'removed', tree: null, a: null, b: null, notes: link('assets', id) }); continue; }
    for (const tree of new Set([...Object.keys(ix.trees || {}), ...Object.keys(iy.trees || {})])) {
      const ta = A.treeState(ix, tree), tb = A.treeState(iy, tree);
      if (ta.head === tb.head && ta.approved === tb.approved) continue;
      const added = iy.nodes.filter(n => n.tree === tree && !ix.nodes.some(m => m.id === n.id)).length;
      assets.push({ id, kind: o.kind, name: o.name || id, st: !ta.head ? 'added' : 'changed', tree, a: nodeOut(ix, A.nodeById(ix, ta.head), tree), b: nodeOut(iy, A.nodeById(iy, tb.head), tree),
        approved: ta.approved !== tb.approved ? { a: ta.approved || null, b: tb.approved || null } : undefined, nodes_added: added, notes: link('assets', id) });
    }
  }
  const ca = sumUsd(A_.costs), cb = sumUsd(B_.costs), seen = new Set((A_.costs.items || []).map(x => x.id));
  const linked = new Set([...lines, ...script, ...board, ...bd, ...assets].flatMap(x => x.notes || []));
  return {
    a: { id: sa.id, label: sa.label, created: sa.created || null }, b: { id: sb.id, label: sb.label, created: sb.created || null },
    duration_ms: B_.song?.duration_ms || A_.song?.duration_ms || 0,
    lyrics: { a: A_.lyrics?.id || null, b: B_.lyrics?.id || null, lines },
    script: { a: A_.scenes.length, b: B_.scenes.length, items: script, changed: script.filter(x => x.st !== 'same').length },
    storyboard: { a: A_.shots.length, b: B_.shots.length, items: board, changed: board.filter(x => x.st !== 'same').length },
    breakdown: bd, assets,
    cost: { a: ca, b: cb, delta: +(cb - ca).toFixed(4), items: (B_.costs.items || []).filter(x => !seen.has(x.id)).map(x => ({ id: x.id, usd: x.usd, tool: x.tool || null, request: x.request || null, note: x.note || null })) },
    notes: notes.map(n => ({ id: n.id, text: n.text, where: `${N.STAGE_TITLE[n.target.stage]}: ${N.targetLabel(n.target)}`, stage: n.target.stage, target: n.target, change: n.change || null, absorbed_in: n.absorbed_in, linked: linked.has(n.id) })),
  };
}

Object.assign(ops, {
  // ---------------- rounds
  round_send(p, { via, by = 'director' } = {}) {
    pageOnly(via, 'sends a round to the agent');
    const rv = revDoc(p), cur = RV.inFlight(rv);
    if (cur) fail(409, `round ${cur.n} is still with the agent (${cur.status}): close its revision first`);
    const list = RV.roundCandidates(notesDoc(p));
    if (!list.length) fail(400, 'no open notes to send: write notes in any stage first');
    const base = snapshot(p, `before round ${notesDoc(p).round || 1}`, true);
    let n = 0, askId = null;
    mutateNotes(p, (d) => {
      n = d.round || 1;
      const ask = N.makeNote(d, { target: { stage: 'final', kind: 'stage', id: null }, text: askText(n, list), by: 'director', via: 'page', to: 'agent', ask: 'round' });
      d.notes.push(ask); askId = ask.id; d.round = n + 1;
    });
    const r = { n, status: 'sent', sent_at: nowIso(), sent_by: String(by).slice(0, 60), notes: list.map(x => x.id), ask: askId, base: base.id };
    mutateRev(p, (d) => { d.rounds.push(r); });
    return { round: n, notes: r.notes.length, ask: askId, base: base.id, next: 'the agent picks it up with round_get' };
  },
  round_get(p, { stage } = {}) {
    if (stage != null && !N.STAGES.includes(stage)) fail(400, `stage: one of ${N.STAGES.join(', ')}`);
    const { rv, r } = liveRound(p, { need: false }), d = notesDoc(p);
    if (!r) {
      const open = RV.roundCandidates(d);
      return { round: d.round || 1, status: 'collecting', open: open.length, revisions: rv.revisions.length,
        hint: 'the director has not sent this round yet: nothing to apply. They send it from the page ("Send round to Claude" on the stage rail); ask them, then call round_get again (until then, open notes are still in notes_get).' };
    }
    const by = new Map(d.notes.map(n => [n.id, n])), cx = {}, ctx = { song: read(p, 'song.json') }, stages = {};
    for (const id of r.notes) {
      const n = by.get(id); if (!n || (stage && n.target.stage !== stage)) continue;
      const v = noteView(n, ctx);
      (stages[n.target.stage] ||= []).push({ id: n.id, where: v.where, target: n.target, text: n.text, by: n.by, status: n.status, ...(v.time ? { time: v.time } : {}),
        ...(n.to === 'agent' ? { ask: n.ask } : {}), replies: (n.replies || []).map(x => ({ by: x.by, via: x.via, text: x.text, at: x.at })), ...(n.change ? { change: n.change } : {}),
        content: targetContent(p, n.target, cx) });
    }
    return { round: r.n, status: r.status, sent_at: r.sent_at, ask: r.ask, becomes: RV.nextRevisionId(rv), progress: RV.roundProgress(d, r), stages,
      rules: 'apply each open note with the stage tools (a new version each time; never approve), then round_absorb {note, change: {stage, file, version, summary}}; round_reply {note, text} when you cannot; round_finish {summary} at the end. The director reviews and closes the revision in the page.' };
  },
  round_absorb(p, { note, change, by = 'agent' } = {}) {
    const { rv, r } = liveRound(p);
    const n = N.findNote(notesDoc(p), String(note || '')); if (!n) fail(404, `no note "${note}" (round_get lists the round's notes)`);
    if (!r.notes.includes(n.id)) fail(409, `${n.id} is not in round ${r.n} (round_get lists its notes; a note written since goes into the next round)`);
    if (!change || typeof change !== 'object' || Array.isArray(change)) fail(400, 'change: {stage, file?, version?, summary} (what you changed for this note)');
    if (!N.STAGES.includes(change.stage)) fail(400, `change.stage: one of ${N.STAGES.join(', ')}`);
    if (typeof change.summary !== 'string' || !change.summary.trim() || change.summary.length > 500) fail(400, 'change.summary: what changed, 1-500 characters (e.g. "line 7 rewritten in v4")');
    if (change.file != null && (typeof change.file !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_./-]{0,159}$/.test(change.file) || change.file.split('/').some(s => s === '..' || s === '.'))) fail(400, 'change.file: the project file you changed (e.g. "lyrics.json", "entities/characters/ada.json")');
    if (change.version != null && (typeof change.version !== 'string' || !/^[A-Za-z0-9_.:-]{1,40}$/.test(change.version))) fail(400, 'change.version: the version you saved (e.g. "v4")');
    const rid = RV.nextRevisionId(rv);
    setStatus(p, n.id, 'absorbed', { reply: change.summary, by, via: 'agent' });
    const ch = { stage: change.stage, ...(change.file ? { file: change.file } : {}), ...(change.version ? { version: change.version } : {}), summary: change.summary.trim(), at: nowIso(), by: String(by || 'agent').slice(0, 60) };
    mutateNotes(p, (d) => { const x = N.findNote(d, n.id); x.absorbed_in = rid; x.change = ch; });
    return { note: n.id, absorbed_in: rid, change: ch, progress: RV.roundProgress(notesDoc(p), r) };
  },
  round_reply(p, { note, text, by = 'agent' } = {}) {
    const { r } = liveRound(p);
    const n = N.findNote(notesDoc(p), String(note || '')); if (!n) fail(404, `no note "${note}"`);
    if (!r.notes.includes(n.id)) fail(409, `${n.id} is not in round ${r.n}`);
    const x = replyNote(p, n.id, text, { by, via: 'agent' });
    return { note: n.id, reply: x.reply.id, status: x.note.status, progress: RV.roundProgress(notesDoc(p), r) };
  },
  round_finish(p, { summary, by = 'agent' } = {}) {
    const { r } = liveRound(p);
    if (r.status === 'finished') fail(409, `round ${r.n} is already finished: the director closes its revision in the page`);
    if (typeof summary !== 'string' || !summary.trim() || summary.length > 2000) fail(400, 'summary: what you did in this round, 1-2000 characters');
    const d = notesDoc(p), ask = N.findNote(d, r.ask);
    if (ask && ask.status === 'open') setStatus(p, ask.id, 'absorbed', { reply: summary, by, via: 'agent' });
    const prog = RV.roundProgress(notesDoc(p), r);
    mutateRev(p, (x) => { const y = x.rounds.find(z => z.n === r.n); Object.assign(y, { status: 'finished', finished_at: nowIso(), finished_by: String(by).slice(0, 60), summary: summary.trim(), progress: prog }); });
    return { round: r.n, status: 'finished', progress: prog, next: 'the director reviews the changes and closes the revision in the page (Close revision); nothing was approved' };
  },
  // ---------------- revisions
  revision_close(p, { via, summary } = {}) {
    pageOnly(via, 'closes a revision');
    if (summary != null && (typeof summary !== 'string' || summary.length > 2000)) fail(400, 'summary: up to 2000 characters');
    const rv0 = revDoc(p), r = RV.inFlight(rv0), rid = RV.nextRevisionId(rv0), prev = RV.lastRevision(rv0), at = nowIso();
    let absorbed = [], replied = [];
    if (r) {
      // the notes the agent absorbed in this round are absorbed in this revision; the round's ask is closed with it
      mutateNotes(p, (d) => {
        const prog = new Set();
        for (const id of r.notes) { const n = N.findNote(d, id); if (n?.status === 'absorbed') { n.absorbed_in = rid; absorbed.push(n.id); } else if (n && (n.replies || []).some(x => x.via === 'agent' && String(x.at || '') >= String(r.sent_at || ''))) prog.add(n.id); }
        replied = [...prog];
        const ask = N.findNote(d, r.ask);
        if (ask) { if (ask.status === 'open') Object.assign(ask, { status: 'absorbed', closed_by: 'director', closed_via: 'page', closed_at: at }); ask.absorbed_in = rid; }
      });
    }
    const sum = String(summary || '').trim() || r?.summary || (r ? `round ${r.n}: ${absorbed.length} note${absorbed.length === 1 ? '' : 's'} absorbed` : 'checkpoint');
    const snap = snapshot(p, `${rid} ${sum}`), sd = snapDir(p, snap.id);
    writeJSON(path.join(sd, '.meta.json'), { ...snap, revision: rid, immutable: true });
    // what changed since the previous revision (else since the round was sent)
    const was = prev ? snapDir(p, prev.snapshot) : r?.base ? snapDir(p, r.base) : null, files_changed = [];
    if (was) {
      const fa = new Set(snapFiles(was).filter(f => f !== '.meta.json')), fb = new Set(snapFiles(sd).filter(f => f !== '.meta.json'));
      for (const f of new Set([...fa, ...fb])) if (!fa.has(f) || !fb.has(f) || !fs.readFileSync(path.join(was, f)).equals(fs.readFileSync(path.join(sd, f)))) files_changed.push(f);
    }
    const cost = sumUsd(readJSON(path.join(sd, 'costs.json'), { items: [] })), costWas = prev ? prev.cost_usd : was ? sumUsd(readJSON(path.join(was, 'costs.json'), { items: [] })) : cost;
    const entry = { id: rid, n: Number(rid.slice(1)), round: r?.n ?? null, created: at, summary: sum, notes_absorbed: absorbed, notes_replied: replied, files_changed: files_changed.sort(),
      cost_usd: cost, cost_delta: +(cost - (costWas || 0)).toFixed(4), snapshot: snap.id, base: r?.base || null, by: 'director', via: 'page' };
    const git = gitMirror(p, rid, sd, sum); if (git) entry.git = git;
    mutateRev(p, (d) => {
      if (r) { const y = d.rounds.find(z => z.n === r.n); Object.assign(y, { status: 'closed', closed_at: at, revision: rid }); }
      d.revisions.push(entry);
    });
    return entry;
  },
  revision_restore(p, { via, id } = {}) {
    pageOnly(via, 'restores a revision');
    const rv = revDoc(p), rev = rv.revisions.find(x => x.id === id); if (!rev) fail(404, `no revision "${id}"`);
    // the notes are the conversation: kept as they are now (the content goes back; what was said about it stays)
    const nf = path.join(projDir(p), 'notes.json'), notesNow = fs.existsSync(nf) ? fs.readFileSync(nf) : null;
    const res = restore(p, rev.snapshot, { agent: false });
    if (notesNow) { const j = JSON.parse(notesNow), cur = readJSON(nf, {}) || {}; j.rev = Math.max(j.rev || 0, cur.rev || 0) + 1; writeAtomic(nf, JSON.stringify(j, null, 1)); }
    mutateRev(p, (d) => { d.restores.push({ at: nowIso(), revision: id, previous: res.previous }); });
    return { ...res, revision: id, notes: 'kept as they are now', undo: `the state before the restore is snapshot ${res.previous}` };
  },
  revisions_get(p, { compare: cmp } = {}) {
    const rv = revDoc(p), r = RV.inFlight(rv);
    if (cmp != null) {
      if (!Array.isArray(cmp) || cmp.length !== 2 || !cmp.every(x => typeof x === 'string')) fail(400, 'compare: [a, b], each "R<n>", "R0" (before round 1) or "now"');
      return ops.revision_compare(p, { a: cmp[0], b: cmp[1] });
    }
    return { revisions: rv.revisions, in_flight: r ? { ...r, progress: RV.roundProgress(notesDoc(p), r) } : null, rounds: rv.rounds.slice(-10), restores: rv.restores.slice(-10), collecting: notesDoc(p).round || 1 };
  },
  revision_compare(p, { a, b } = {}) {
    const rv = revDoc(p), last = RV.lastRevision(rv);
    if (!b) b = last ? last.id : 'now';
    if (!a) a = b === 'now' ? (last ? last.id : 'R0') : rv.revisions.length > 1 ? rv.revisions.at(-2).id : 'R0';
    for (const x of [a, b]) if (typeof x !== 'string' || !/^(now|R\d{1,5})$/.test(x)) fail(400, 'a, b: "R<n>", "R0" (before round 1) or "now"');
    return compare(p, a, b);
  },
});
