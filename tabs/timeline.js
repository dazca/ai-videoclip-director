import { Timeline } from '../js/timeline.js';
export default {
  mount(el, ctx) { ctx.timeline = new Timeline(el); window.WB.timeline = ctx.timeline; },
  show(ctx) { ctx.timeline?.requestRelayout(); },
};
