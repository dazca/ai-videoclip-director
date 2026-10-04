// Popped-out preview dock (dock.html): the same renderer as the docked one, fed by the main page over a
// BroadcastChannel: playhead {t, playing} every frame it changes, the shown/pinned source and the hover source.
// Its film/pin buttons are sent back to the main page. Closing this window brings the dock back in the main page.
import { store, prefs } from '../js/store.js';
import { dock, dockChannel as chan } from './dock.js';

let clock = { t: 0, playing: false, at: performance.now() };
window.WB_DOCK_CLOCK = () => ({ t: clock.playing ? clock.t + (performance.now() - clock.at) : clock.t, playing: clock.playing });
window.WB = { store, dock };

(async function boot() {
  await store.loadAll();
  dock.ensure(); document.body.appendChild(dock.el); dock.render(true);
  const local = { film: dock.film.bind(dock), pin: dock.pin.bind(dock) };
  dock.film = () => { local.film(); chan?.postMessage({ type: 'film' }); };
  dock.pin = (on) => { local.pin(on); chan?.postMessage({ type: 'pin', source: dock.source, pinned: dock.pinned }); };
  const tick = () => { if (dock.current().kind === 'film') dock.syncFilm(false); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  if (chan) {
    chan.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === 't' || m.type === 'state') clock = { t: m.t ?? clock.t, playing: !!m.playing, at: performance.now() };
      if (m.type === 'state') { dock.source = m.source; dock.pinned = !!m.pinned; dock.hoverSrc = m.hover || null; dock.render(); }
      if (m.type === 'src') { dock.source = m.source; dock.pinned = !!m.pinned; dock.hoverSrc = null; dock.render(); }
      if (m.type === 'hover') { dock.hoverSrc = m.source; dock.render(); }
    };
    chan.postMessage({ type: 'hello' });
  }
  addEventListener('resize', () => chan?.postMessage({ type: 'geo', geo: { w: outerWidth, h: outerHeight } }));
  addEventListener('pagehide', () => chan?.postMessage({ type: 'closed' }));
  document.title = 'Preview · ' + store.project;
  document.body.dataset.ready = '1';
})();
