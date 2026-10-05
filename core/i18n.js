// G8: a light i18n layer for the onboarding and the main chrome (menu titles, pages, stage names, the rail, the stage bar,
// Settings' headings, the error states). One strings table per language (core/strings-<lang>.js); English is the fallback for
// a missing key, and a key missing everywhere shows the fallback given (or the key). The language is a per-browser choice
// (localStorage wb:lang; Settings › language, the onboarding's own picker), else English (not guessed from the browser: the
// onboarding asks first, and a headless test browser in another locale keeps the English it checks). Switching reloads the page (everything is drawn again in the new language).
//   t(key, vars?, fallback?)   ·   lang()   ·   setLang(id)   ·   LANGS [{id, name}]
import EN from './strings-en.js';
import CA from './strings-ca.js';
import ES from './strings-es.js';

export const LANGS = [{ id: 'en', name: 'English' }, { id: 'ca', name: 'Català' }, { id: 'es', name: 'Español' }];
const TABLES = { en: EN, ca: CA, es: ES };
function pick() {
  try { const v = JSON.parse(localStorage.getItem('wb:lang')); if (TABLES[v]) return v; } catch (e) { /* storage blocked */ }
  return 'en';
}
let cur = pick();
document.documentElement.lang = cur;
export const lang = () => cur;
export function t(key, vars, fallback) {
  let s = TABLES[cur][key] ?? EN[key] ?? fallback ?? key;
  if (vars) s = String(s).replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m));
  return s;
}
export function setLang(id, { reload = true } = {}) {
  if (!TABLES[id]) return false;
  try { localStorage.setItem('wb:lang', JSON.stringify(id)); } catch (e) { /* storage blocked: this page only */ }
  cur = id; document.documentElement.lang = id;
  if (reload) location.reload();
  return true;
}
// every key a table has that English lacks, and every English key a table lacks (tools/verify-onboarding.mjs checks both)
export const coverage = () => Object.fromEntries(Object.entries(TABLES).map(([id, tb]) => [id, { missing: Object.keys(EN).filter(k => !(k in tb)), extra: Object.keys(tb).filter(k => !(k in EN)) }]));
window.WB = Object.assign(window.WB || {}, { i18n: { t, lang, setLang, LANGS, coverage } });
