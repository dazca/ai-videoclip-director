// Safe rendering helpers for template strings that end up in innerHTML: esc() (shared, from js/store.js) for text and
// quoted attributes, and a URL filter for src/href so project data (agents, importers, hand edits) never becomes script.
import { esc, mediaUrl } from '../js/store.js';
export { esc };

// drop script-capable schemes (javascript:, vbscript:, data: other than images); everything else is a path or http(s)
// a colour for a style attribute: hex only (a look's colours come from agents and hand edits), else the fallback
export const hexColor = (c, d = '#888') => /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(String(c ?? '').trim()) ? String(c).trim() : d;
export const safeUrl = (u) => { const s = String(u ?? ''); return /^\s*(javascript|vbscript):/i.test(s) || /^\s*data:(?!image\/)/i.test(s) ? '' : s; };
// a media path, resolved, filtered and escaped for a src="" / href="" attribute
export const mediaAttr = (p) => esc(safeUrl(mediaUrl(p)));
