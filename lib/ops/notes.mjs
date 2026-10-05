// Notes pinned to song time (notes.json): notes_list, note_add, note_resolve. The per-stage notes live with their
// stage (lyrics_note_*, scene_note_*, breakdown_note_*, asset_note_add, shot_note_*).
import { fail, ms, mutate, nextId, nowIso, ops, read, tc } from './_shared.mjs';

Object.assign(ops, {
  // ---------------- notes
  notes_list(p, { status, t0, t1, by } = {}) {
    const a = ms(t0) ?? -Infinity, b = ms(t1) ?? Infinity;
    return read(p, 'notes.json').notes.filter(n => (!status || n.status === status) && (!by || n.by === by) && n.t >= a && n.t <= b).map(n => ({ ...n, time: tc(n.t) }));
  },
  note_add(p, { t, text, line_id, about, by = 'agent', reply_to }) {
    if (!text) fail(400, 'text required');
    const tm = ms(t, 't'); if (tm == null) fail(400, 't required (ms or m:ss.mmm)');
    let line = line_id;
    if (!line) { const L = read(p, 'song.json').lines.filter(l => l.t0 <= tm).pop(); line = L && tm <= L.t1 + 2000 ? L.id : null; }
    return mutate(p, 'notes.json', (d) => {
      // via:"agent": written through the agent surface, whatever `by` says (the page's own notes have no via)
      const n = { id: nextId(d.notes, 'n'), t: tm, line_id: line || null, by, via: 'agent', text: String(text), status: 'open', at: nowIso(), ...(about ? { about } : {}), ...(reply_to ? { reply_to } : {}) };
      d.notes.push(n); d.notes.sort((x, y) => x.t - y.t); return n;
    });
  },
  note_resolve(p, { id, reply, by = 'agent', reopen = false }) {
    const r = mutate(p, 'notes.json', (d) => {
      const n = d.notes.find(x => x.id === id); if (!n) fail(404, `no note "${id}"`);
      n.status = reopen ? 'open' : 'resolved'; n.resolved_by = by; n.resolved_at = nowIso(); return { ...n };
    });
    const answer = reply ? ops.note_add(p, { t: r.t, text: reply, line_id: r.line_id, about: r.about, by, reply_to: id }) : null;
    if (answer && !reopen) mutate(p, 'notes.json', (d) => { const n = d.notes.find(x => x.id === answer.id); if (n) n.status = 'resolved'; });
    return { note: r, ...(answer ? { reply: answer.id } : {}) };
  },
});
