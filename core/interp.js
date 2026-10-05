// E10: the agent's interpretation, shown UNDER the director's verbatim words (an intake answer in Script › Intake, a note in
// any Notes column), styled apart from them (a left rule, italic, "agent's reading" label). The director accepts it or edits
// it here (POST /api/op/interpretation_act: page only); the agent writes it with interpretation_set. Shape: js/interpret.js.
//   interpHtml(interpretation, {key} | {note})   the block, or '' when there is none
// One delegated click handler (document) handles every block's Accept / Edit.
import { postJSON, toast, esc } from '../js/store.js';
import { ui } from './palette.js';
import { LABEL, interpTip } from '../js/interpret.js';

export function interpHtml(i, ref) {
  if (!i || !i.text) return '';
  const k = ref.key != null ? `data-itp-key="${esc(ref.key)}"` : `data-itp-note="${esc(ref.note)}"`;
  const acts = (i.status === 'proposed' ? '<b data-itp="accept" title="accept the agent\'s reading as it is">Accept</b>' : '')
    + '<b data-itp="edit" title="rewrite it in your words (the agent\'s text is kept in the history)">Edit</b>';
  return `<div class="itp s-${esc(i.status)}" ${k} title="${esc(interpTip(i))}"><span class="itph"><i class="itpw">${esc(LABEL[i.status] || i.status)}</i><span class="sp"></span>${acts}</span><span class="itpt">${esc(i.text)}</span></div>`;
}
async function act(body) {
  const r = await postJSON('/api/op/interpretation_act', body), j = await r.json().catch(() => ({}));
  if (!r.ok) { toast(`interpretation: ${j.error || r.status}`); return null; }
  return j;
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-itp]'); if (!b) return;
  const box = b.closest('.itp'); if (!box) return;
  e.preventDefault(); e.stopPropagation();
  const ref = box.dataset.itpKey != null ? { key: box.dataset.itpKey } : { note: box.dataset.itpNote };
  if (b.dataset.itp === 'accept') { if (await act({ ...ref, act: 'accept' })) toast('interpretation accepted'); return; }
  const cur = box.querySelector('.itpt')?.textContent || '';
  const text = await ui.prompt({ title: 'Your reading (it replaces the agent\'s; your verbatim words stay as they are)', value: cur });
  if (text == null || !String(text).trim() || String(text).trim() === cur.trim()) return;
  if (await act({ ...ref, act: 'edit', text: String(text).trim() })) toast('interpretation edited: it is yours now');
}, true);
