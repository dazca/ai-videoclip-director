// The one price table of the workbench: the page, the server (lib/store.mjs) and the MCP server read every estimate from
// here. List prices of the models the photoreal recipe (docs/PHOTOREAL.md, templates/photoreal_recipe.json) uses, each
// with the date it was read on the vendor page ("verified"). Pure data + functions, no DOM and no Node APIs.
// To change a price: edit it here, set `verified` to the day you read it, and CLAUDE.md "Prices" quotes the table.
export const PRICES = {
  nb2: { name: 'Nano Banana 2 edit', endpoint: 'fal-ai/nano-banana-2/edit', unit: 'image', usd: { '1K': 0.08, '2K': 0.12 }, default: '2K', verified: '2026-10-04',
    note: 'identity / look sheets and edits; 14 refs, seed' },
  seedream5: { name: 'Seedream 5.0 Pro edit', endpoint: 'bytedance/seedream/v5/pro/edit', unit: 'image', usd: { '1536': 0.0675, '2048': 0.135 }, default: '2048', verified: '2026-10-04',
    note: '$0.0675 up to 1536², $0.135 up to 2048² (+$0.0045 per extra ref)' },
  h3max: { name: 'MiniMax H3 Max image-to-video', endpoint: 'minimax/h3-max/image-to-video', unit: 's', usd: { '768p': 0.08 }, default: '768p', verified: '2026-10-04',
    promo: { until: '2026-10-15', usd: { '768p': 0.048 } }, note: '$0.048/s at 768p until 2026-10-15 (promo), then $0.08/s' },
  kling3pro: { name: 'Kling v3 Pro image-to-video', endpoint: 'fal-ai/kling-video/v3/pro/image-to-video', unit: 's', usd: { silent: 0.112 }, default: 'silent', verified: '2026-10-04',
    note: '$0.112/s without generated audio' },
  klingmc: { name: 'Kling v3 Motion Control', endpoint: 'fal-ai/kling-video/v3/pro/motion-control', unit: 's', usd: { pro: 0.168 }, default: 'pro', verified: '2026-10-04',
    note: '$0.168/s, performance transfer from a reference clip' },
};
// what each kind of generation is estimated with (model + tier); the estimates below and the request forms use it
export const USE = {
  sheet: { model: 'nb2', tier: '2K', what: 'one sheet (identity / look / base / variant) at 2K' },
  edit: { model: 'nb2', tier: '1K', what: 'one edited image at 1K' },
  edit_mask: { model: 'nb2', tier: '1K', what: 'one masked edit at 1K (the mask goes as an extra reference image)' },
  still: { model: 'nb2', tier: '2K', what: 'one 16:9 frame at 2K' },
  video: { model: 'h3max', tier: '768p', what: 'image-to-video at 768p, per second' },
};
const day = (d) => (d instanceof Date ? d : d ? new Date(d) : new Date()).toISOString().slice(0, 10);
// the list price of one unit (an image, a second) of model at tier on a date (promos end on their `until` day)
export function price(model, tier, { date } = {}) {
  const P = PRICES[model]; if (!P) return null;
  const t = tier && P.usd[tier] != null ? tier : P.default;
  const promo = P.promo && day(date) <= P.promo.until && P.promo.usd[t] != null;
  return { model, tier: t, usd: promo ? P.promo.usd[t] : P.usd[t], unit: P.unit, endpoint: P.endpoint, name: P.name, verified: P.verified, ...(promo ? { promo_until: P.promo.until } : {}) };
}
const r2 = (x) => Math.round(x * 10000) / 10000;
// an estimate for n units: {tool, usd, why, model, tier, verified}; `use` is a USE key or {model, tier}
export function estimateWith(use, { n = 1, seconds, date } = {}) {
  const u = typeof use === 'string' ? USE[use] : use, p = u && price(u.model, u.tier, { date });
  if (!p) return null;
  const units = p.unit === 's' ? Math.max(1, Number(seconds) || 5) * Math.max(1, n) : Math.max(1, n);
  const usd = +r2(p.usd * units).toFixed(3);
  const why = `${u.what || p.name}: ${p.name} $${p.usd}${p.unit === 's' ? '/s' : ''}${p.promo_until ? ` (promo until ${p.promo_until})` : ''}${units > 1 ? ` x ${units}${p.unit === 's' ? ' s' : ''}` : ''}, list price verified ${p.verified}`;
  return { tool: p.endpoint, usd, why, model: p.model, tier: p.tier, verified: p.verified };
}
// the table as rows (CLAUDE.md, the page's price list): [{model, name, tier, usd, unit, verified, promo?}]
export function priceRows({ date } = {}) {
  const out = [];
  for (const [m, P] of Object.entries(PRICES)) for (const t of Object.keys(P.usd)) { const p = price(m, t, { date }); out.push({ model: m, name: P.name, endpoint: P.endpoint, tier: t, usd: p.usd, list_usd: P.usd[t], unit: P.unit, verified: P.verified, ...(p.promo_until ? { promo_until: p.promo_until } : {}), note: P.note }); }
  return out;
}

// which model a generation request asks for (the runner and the Queue read it): the recipe's model, else the tool /
// endpoint it names, else nb2 (a shot-video kind: H3 Max)
export function modelOf(req) {
  const m = req?.recipe?.model; if (m && PRICES[m]) return m;
  const t = String(req?.tool || '').toLowerCase();
  for (const [k, P] of Object.entries(PRICES)) if (t && (t === P.endpoint || t === k)) return k;
  if (/seedream/.test(t)) return 'seedream5';
  if (/motion-control/.test(t)) return 'klingmc';
  if (/kling/.test(t)) return 'kling3pro';
  if (/minimax|h3/.test(t)) return 'h3max';
  if (req?.kind === 'shot-video') return 'h3max';
  return 'nb2';
}
// the generator kind a request needs (Settings > Generator picks one generator per kind): image, video or motion
export const genKindOf = (req) => { const m = modelOf(req); return m === 'klingmc' ? 'motion' : PRICES[m].unit === 's' ? 'video' : 'image'; };
