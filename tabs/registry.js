// Page registry (the NLE standard: a few PAGES, like DaVinci Resolve's pages / Premiere's workspaces; asset kinds live
// as SUB-VIEWS (bins) inside a page, like Premiere's Project panel). One module per view; a module exports default
// { mount(el, ctx), show?(ctx) }.
//   page    = { id, title, load }                       a single view (Timeline, Settings)
//           | { id, title, subs: [sub...], search? }    a page with a left sub-nav; `search` adds the asset search bar
//   sub     = { id, title, load, count?(store) }        `count` = the small number next to the name in the sub-nav
//   tab: false = not in the tab strip (Settings: Edit > Settings, Ctrl+, or the gear at the far right)
// To add a view: write tabs/<name>.js and add one line under its page (or WB.app.registerSub(pageId, sub) at runtime).
// Number keys 1..9 follow this order (1 Timeline, 2 Assets, 3 Review, 4 Settings, 5 Stages, then custom pages from
// Window > New page).
export const PAGES = [
  { id: 'timeline', title: 'Timeline', load: () => import('./timeline.js') },
  { id: 'assets', title: 'Assets', search: true, subs: [
    { id: 'characters', title: 'Characters', load: () => import('./characters.js'), count: (s) => s.entities.filter(e => e.kind === 'character').length },
    { id: 'locations', title: 'Locations', load: () => import('./locations.js'), count: (s) => s.entities.filter(e => e.kind === 'location').length },
    { id: 'props', title: 'Props', load: () => import('./props.js'), count: (s) => s.entities.filter(e => e.kind === 'prop').length },
    { id: 'media', title: 'Media', load: () => import('./media.js'), count: (s) => s.media.length },
    { id: 'clips', title: 'Clips', load: () => import('./clips.js'), count: (s) => new Set(s.uses.map(u => u.clip)).size },
  ] },
  { id: 'review', title: 'Review', subs: [
    { id: 'approvals', title: 'Approvals', load: () => import('./approvals.js'), count: (s) => Object.values(s.approvals?.items || {}).filter(v => v.state === 'changes').length || '' },
    { id: 'queue', title: 'Queue', load: () => import('./queue.js'), count: (s) => (s.requests?.items || []).filter(r => r.status === 'draft').length || '' },
    { id: 'notes', title: 'Notes', load: () => import('./notes.js'), count: (s) => s.notes.notes.filter(n => n.status === 'open').length || '' },   // every stage's notes (notes.json v2)
    { id: 'compare', title: 'Compare', load: () => import('./compare.js'), count: (s) => s.revisions?.revisions?.length || '' },   // revisions R<n> side by side (js/revisions.js)
    { id: 'costs', title: 'Costs', load: () => import('./costs.js'), count: (s) => s.costs ? '$' + Math.round(s.costs.items.reduce((a, x) => a + (Number(x.usd) || 0), 0)) : '' },
  ] },
  { id: 'settings', title: 'Settings', tab: false, load: () => import('./settings.js') },
  // the guided flow: one workspace per stage, opened from the stage rail (core/rail.js), not a tab
  { id: 'stage', title: 'Stages', tab: false, load: () => import('./stage.js') },
];
