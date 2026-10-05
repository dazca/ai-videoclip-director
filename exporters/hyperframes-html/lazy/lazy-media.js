/* hyperframes-html lazy media loader. lazy/build.mjs injects it, with its schedule, into the PACKAGE copy of the
 * composition's entry HTML (first thing in <head>). The composition sources are never changed.
 *
 * What it does: <img> and <video> elements whose file is in the schedule get no `src` until shortly before they are
 * on screen. The src is parked in data-hf-lazy and put back by a scheduler driven by the composition clock. It keeps
 * about `lead` s ahead of the playhead, and everything the first `first` s need comes first. Far from the playhead and
 * over `budget` bytes, it parks the src again (evicts). A seek just moves the window, so eviction is seek-safe.
 * Frames stay a pure function of time: nothing here draws or re-times anything; it only decides WHEN a file loads.
 *
 * Hooks (no composition file is touched): Element.setAttribute('src'), the img/media `src` setters, innerHTML and
 * insertAdjacentHTML strings (<img|video ... src=...>), plus static data-hf-lazy attributes the build rewrote.
 * Windows: a <video data-start data-duration> uses its own HyperFrames timing; other files use the time ranges
 * manifest.json measured (usage.visible), padded by `pad` s. A parked element found on screen is loaded at once.
 *
 * window.__hfLazy: t(), ready(t0[, t1]) -> bool, until(t0[, t1]) -> Promise<bool> (loads that range first and waits),
 * stats(), clock (assign a function to override the time source), first, lead.
 */
(function () {
  'use strict';
  var C = window.__HF_LAZY_CFG;
  if (!C || window.__hfLazy) return;
  var doc = document, ATTR = 'data-hf-lazy';
  var LEAD = C.lead, FIRST = C.first, PAD = C.pad, KEEP = C.keep, BUDGET = C.budget, CONC = C.conc;
  var EP = Element.prototype, setAttr = EP.setAttribute, getAttr = EP.getAttribute, remAttr = EP.removeAttribute;
  var imgSrc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  var medSrc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
  var inner = Object.getOwnPropertyDescriptor(EP, 'innerHTML'), iah = EP.insertAdjacentHTML;

  function norm(u) { try { var x = new URL(u, doc.baseURI); x.hash = ''; return x.href; } catch (e) { return null; } }
  var A = {};
  C.assets.forEach(function (a) {
    var href = norm(a[0]);
    if (href) A[href] = { href: href, kind: a[1], bytes: a[2], win: a[3].map(function (w) { return [w[0] - PAD, w[1] + PAD]; }), unit: null };
  });
  var units = [], waiters = [], urgent = [];

  // ---------- windows
  function winOf(u) {
    if (u.type === 'video') {
      var s = parseFloat(getAttr.call(u.el, 'data-start')), d = parseFloat(getAttr.call(u.el, 'data-duration'));
      if (isFinite(s) && isFinite(d)) return [[s - PAD, s + d + PAD]];
    }
    return u.asset.win;
  }
  function need(u, t) { // first time >= t this unit is on screen (Infinity: never again)
    var w = winOf(u), n = Infinity;
    for (var i = 0; i < w.length; i++) if (w[i][1] > t) n = Math.min(n, Math.max(w[i][0], t));
    return n;
  }
  function hits(u, t0, t1) { var w = winOf(u); for (var i = 0; i < w.length; i++) if (w[i][0] < t1 && w[i][1] > t0) return true; return false; }

  // ---------- units: one per image file (one request, shared by every <img>), one per <video> element
  function unitFor(el, a) {
    if (el.tagName === 'VIDEO') {
      if (!el.__hfl) { el.__hfl = { type: 'video', el: el, asset: a, state: 'parked' }; units.push(el.__hfl); kick(); }
      return el.__hfl;
    }
    var u = a.unit;
    if (!u) {
      u = a.unit = { type: 'img', asset: a, els: [], state: 'parked' }; units.push(u);
      var t = clock(); if (need(u, t) <= t + FIRST) release(u); // the opening loads as before
      kick();
    }
    if (el.__hfl !== u) { el.__hfl = u; u.els.push(el); }
    return u;
  }
  function managed(el, v) { if (el.tagName !== 'IMG' && el.tagName !== 'VIDEO') return null; var h = v == null ? null : norm(String(v)); return h && A[h] || null; }
  // returns true when the src was parked instead of set
  function park(el, v) {
    var a = managed(el, v); if (!a) return false;
    var u = unitFor(el, a);
    if (u.state !== 'parked') return false;
    setAttr.call(el, ATTR, v); return true;
  }
  function adopt(el) { // an element that already carries data-hf-lazy (parsed HTML)
    if (el.__hfl) return;
    var v = getAttr.call(el, ATTR), a = managed(el, v);
    if (!a) { remAttr.call(el, ATTR); setAttr.call(el, 'src', v); return; }
    if (unitFor(el, a).state !== 'parked') unpark(el);
  }
  function unpark(el) { var v = getAttr.call(el, ATTR); if (v == null) return; remAttr.call(el, ATTR); setAttr.call(el, 'src', v); }
  function repark(el) { var v = getAttr.call(el, 'src'); if (v == null) return; setAttr.call(el, ATTR, v); remAttr.call(el, 'src'); if (el.tagName === 'VIDEO') try { el.load(); } catch (e) {} }

  function release(u) {
    if (u.state !== 'parked') return;
    u.state = 'loading';
    if (u.type === 'img') {
      var im = new Image(); u.probe = im; im.__hfDone = false;
      imgSrc.set.call(im, u.asset.href);
      var fin = function () { im.__hfDone = true; kick(); };
      if (im.decode) im.decode().then(fin, fin); else { im.onload = im.onerror = fin; }
      u.els.forEach(unpark);
    } else {
      var v = u.el;
      if (!v.__hfEv) { v.__hfEv = true; ['suspend', 'canplaythrough', 'error', 'progress', 'loadeddata'].forEach(function (e) { v.addEventListener(e, function () { if (e === 'suspend') v.__hfSusp = true; kick(); }); }); }
      v.__hfSusp = false; unpark(v);
    }
  }
  function evict(u) {
    if (u.state === 'parked') return;
    u.state = 'parked'; u.probe = null;
    if (u.type === 'img') u.els.forEach(repark); else repark(u.el);
  }
  function vidOK(v) {
    if (v.error) return true;
    if (v.readyState < 1) return false;
    var d = v.duration || 0, m0 = parseFloat(getAttr.call(v, 'data-media-start')) || 0, dur = parseFloat(getAttr.call(v, 'data-duration'));
    var rate = parseFloat(getAttr.call(v, 'data-playback-rate')) || 1, m1 = isFinite(dur) ? Math.min(d, m0 + dur * rate) : d;
    var b = v.buffered;
    for (var i = 0; i < b.length; i++) if (b.start(i) <= m0 + 0.05 && b.end(i) >= m1 - 0.15) return true;
    return v.readyState >= 3 && v.__hfSusp; // the browser stopped fetching: as much as it will preload
  }
  function ok(u) {
    if (u.state === 'ok') return true;
    if (u.state !== 'loading') return false;
    if (u.type === 'img' ? u.probe && u.probe.__hfDone : vidOK(u.el)) { u.state = 'ok'; return true; }
    return false;
  }

  // ---------- the clock: the master <audio> in standalone mode, else the registered timeline
  function master() { return doc.querySelector('[data-composition-id] audio[data-start]') || doc.querySelector('audio'); }
  function clock() {
    if (L.clock) try { return +L.clock() || 0; } catch (e) {}
    var au = master(), tl = window.__timelines, k = tl && Object.keys(tl)[0];
    if (au && !window.__hf && /standalone/.test(location.search)) return au.currentTime || 0;
    if (k && tl[k] && typeof tl[k].time === 'function') return +tl[k].time() || 0;
    return au ? au.currentTime || 0 : 0;
  }

  // ---------- the scheduler
  var kicked = false;
  function kick() { if (!kicked) { kicked = true; setTimeout(tick, 0); } }
  function vis(el) { return el.isConnected && (el.checkVisibility ? el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true }) : el.getClientRects().length > 0); }
  function tick() {
    kicked = false;
    var t = clock(), i, u, loading = 0, resident = 0, missing = false;
    var hot = [[t - 0.05, t + 0.6]].concat(urgent), isHot = function (x) { return hot.some(function (r) { return hits(x, r[0], r[1]); }); };
    for (i = 0; i < units.length; i++) {
      u = units[i]; ok(u);
      // after a seek: a load that is no longer near the playhead stops, so the bandwidth goes where the playhead is
      if (u.state === 'loading' && !hits(u, t - KEEP, t + LEAD) && !isHot(u)) { evict(u); continue; }
      if (u.state === 'loading') loading++;
    }
    // needed right now (a waiter, the playhead, or a parked element already on screen): no queue
    for (i = 0; i < units.length; i++) {
      u = units[i]; if (u.state === 'ok') continue;
      var now = isHot(u);
      if (!now && u.state === 'parked') { var els = u.type === 'img' ? u.els : [u.el]; for (var j = 0; j < els.length && !now; j++) now = vis(els[j]); }
      if (now) { missing = true; if (u.state === 'parked') { release(u); loading++; } }
    }
    // ahead of the playhead, soonest first, once the playhead has its files; nothing past t + first while something
    // before it is still missing
    var queue = [];
    if (!missing) for (i = 0; i < units.length; i++) { u = units[i]; var n = need(u, t); if (n <= t + LEAD) queue.push([n, u]); }
    queue.sort(function (p, q) { return p[0] - q[0]; });
    var gate = queue.some(function (x) { return x[0] <= t + FIRST && x[1].state !== 'ok'; }) ? t + FIRST : t + LEAD;
    for (i = 0; i < queue.length && loading < CONC; i++) if (queue[i][0] <= gate && queue[i][1].state === 'parked') { release(queue[i][1]); loading++; }
    // over budget: park what is far from the playhead (no window in [t - keep, t + lead]), farthest first
    for (i = 0; i < units.length; i++) if (units[i].state !== 'parked') resident += units[i].asset.bytes;
    if (resident > BUDGET) {
      var far = units.filter(function (x) { return x.state !== 'parked' && !hits(x, t - KEEP, t + LEAD) && !urgent.some(function (r) { return hits(x, r[0], r[1]); }); })
        .map(function (x) { var w = winOf(x), d = Infinity; w.forEach(function (r) { d = Math.min(d, r[1] <= t ? t - r[1] : r[0] - t); }); return [d, x]; })
        .sort(function (p, q) { return q[0] - p[0]; });
      for (i = 0; i < far.length && resident > BUDGET; i++) { evict(far[i][1]); resident -= far[i][1].asset.bytes; L.evicted++; }
    }
    // waiters
    waiters = waiters.filter(function (w) {
      if (ready(w.t0, w.t1) || performance.now() > w.until) { urgent.splice(urgent.indexOf(w.r), 1); w.done(ready(w.t0, w.t1)); return false; }
      return true;
    });
  }
  function ready(t0, t1) {
    if (t1 === undefined) t1 = t0 + 0.5;
    for (var i = 0; i < units.length; i++) if (hits(units[i], t0, t1) && !ok(units[i])) return false;
    return true;
  }
  function until(t0, t1, ms) {
    if (t1 === undefined) t1 = t0 + 0.5;
    return new Promise(function (done) {
      var r = [t0, t1]; urgent.push(r);
      waiters.push({ t0: t0, t1: t1, r: r, done: done, until: performance.now() + (ms || 60000) });
      tick();
    });
  }

  // ---------- hooks
  EP.setAttribute = function (n, v) {
    if ((n === 'src' || n === 'SRC') && park(this, v)) return;
    return setAttr.call(this, n, v);
  };
  Object.defineProperty(HTMLImageElement.prototype, 'src', { configurable: true, enumerable: imgSrc.enumerable, get: imgSrc.get, set: function (v) { if (!park(this, v)) imgSrc.set.call(this, v); } });
  Object.defineProperty(HTMLMediaElement.prototype, 'src', { configurable: true, enumerable: medSrc.enumerable, get: medSrc.get, set: function (v) { if (!park(this, v)) medSrc.set.call(this, v); } });
  var TAG = /<(img|video)\b[^>]*>/gi, SRC = /(\s)src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/i;
  function rewrite(html) {
    if (typeof html !== 'string' || !/<(img|video)\b/i.test(html)) return html;
    return html.replace(TAG, function (tag) {
      return tag.replace(SRC, function (m, sp, a, b, c) {
        var v = a != null ? a : b != null ? b : c, h = norm(v.replace(/&amp;/g, '&'));
        return h && A[h] ? sp + ATTR + '="' + v + '"' : m;
      });
    });
  }
  function adoptIn(root) { if (root && root.querySelectorAll) { var l = root.querySelectorAll('[' + ATTR + ']'); for (var i = 0; i < l.length; i++) adopt(l[i]); } }
  Object.defineProperty(EP, 'innerHTML', { configurable: true, enumerable: inner.enumerable, get: inner.get, set: function (v) {
    var r = rewrite(v); inner.set.call(this, r); if (r !== v) adoptIn(this.content || this);
  } });
  EP.insertAdjacentHTML = function (pos, v) {
    var r = rewrite(v); iah.call(this, pos, r);
    if (r !== v) adoptIn(/^(beforebegin|afterend)$/i.test(pos) ? this.parentNode : this);
  };
  doc.addEventListener('DOMContentLoaded', function () { adoptIn(doc); kick(); });
  doc.addEventListener('seeking', kick, true); doc.addEventListener('play', kick, true);
  setInterval(tick, 200);

  var L = window.__hfLazy = {
    first: FIRST, lead: LEAD, clock: null, evicted: 0,
    t: clock, ready: ready, until: until,
    stats: function () {
      var s = { units: units.length, parked: 0, loading: 0, ok: 0, residentBytes: 0, evicted: L.evicted };
      units.forEach(function (u) { ok(u); s[u.state]++; if (u.state !== 'parked') s.residentBytes += u.asset.bytes; });
      return s;
    },
  };
})();
