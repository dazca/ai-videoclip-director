// E10: the agent's interpretation next to the director's verbatim words. Pure functions, no DOM, no Node APIs: the page
// (core/interp.js) and the data layer (lib/ops/interpret.mjs) use the same code.
//
// An intake answer (scenes.json intake.<question id>) or a note (notes.json v2) may carry
//   interpretation {text, by (the agent's name, default "agent"), via: "agent", at, status: proposed | accepted | edited,
//                   agent_text? (the agent's words, kept when the director edited them), reviewed?: {by: "director", via: "page", at}}
// The verbatim answer / note text is never touched by it. The agent writes it (interpretation_set: always via "agent",
// status "proposed"); only the director accepts or edits it, in the page (interpretation_act, page only). An edited one
// is the director's words: the agent cannot overwrite it (409). Page saves of scenes.json / notes.json never write it
// (serve.mjs keeps the server's copy), so it cannot be forged as "accepted" by a save either.
export const STATUSES = ['proposed', 'accepted', 'edited'];
export const TEXT_MAX = 4000;
export const LABEL = {
  proposed: "agent's reading · not reviewed",
  accepted: "agent's reading · accepted by you",
  edited: 'your reading (edited from the agent\'s)',
};
export function cleanText(text) {
  if (typeof text !== 'string' || !text.trim()) throw Object.assign(new Error('text: the interpretation (a non-empty string)'), { code: 400 });
  if (text.length > TEXT_MAX) throw Object.assign(new Error(`text: up to ${TEXT_MAX} characters`), { code: 400 });
  return text.trim();
}
// a tooltip line: who wrote it, when, who reviewed it
export function interpTip(i) {
  if (!i) return '';
  const w = (at) => String(at || '').replace('T', ' ').slice(0, 16);
  return `written by ${i.by && i.by !== 'agent' ? `${i.by} (agent)` : 'the agent'} ${w(i.at)}`
    + (i.reviewed ? `\n${i.status === 'edited' ? 'edited' : 'accepted'} by the director ${w(i.reviewed.at)}` : '\nnot reviewed yet: Accept or Edit')
    + (i.status === 'edited' && i.agent_text ? `\nthe agent wrote: ${i.agent_text}` : '');
}
