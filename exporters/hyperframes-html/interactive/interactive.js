/* Interactive layer for an exported HyperFrames film (interactive.html next to composition/).
 *
 * The film runs untouched in a same-origin iframe in its own standalone mode (its <audio> is the master clock). This
 * script lives in the parent page and only READS the film's document: hit-testing with elementsFromPoint, computed
 * styles and boxes, node clones, video/canvas frames drawn into canvases. Lifting, hovering, dragging, zooming never
 * pause, seek or restyle the film. Only Space / the HUD / arrows / the scrubber touch the clock, on purpose.
 *
 * Playing:  hover = outline + label; click = lift into a card; a click outside the cards sends the unpinned ones
 *           back (and lifts nothing); Ctrl/Cmd+click = lift and keep the others; Shift+click = lift the enclosing
 *           window/dialog; Alt+click = pause.
 * Paused:   the film's own document takes the pointer: select / copy text, drag images, right-click natively;
 *           double-click lifts; Alt+click or Space resumes (selection cleared, clock continues from the paused ms).
 * Keys:     Space play/pause, Esc close the newest unpinned card, Left/Right seek 5 s, I outlines on/off,
 *           H HUD auto / always / never, L progress line on/off, A fit / fill (H, L, A are remembered).
 * Cards:    drag by the header, resize at the corner, Ctrl+wheel zoom (also - 100% +), pin, save/copy, x.
 * Nothing animates: cards, outlines and the HUD appear and disappear instantly. The system pointer is always visible
 * (the film hides it for its own drawn cursor; a style injected into the film document puts it back).
 * Screen: the HUD shows only at the bottom edge (48 px) or briefly after a key; outlines only while the pointer moves.
 * Aspect: fit = the whole film, letterboxed; fill = cover the window, centred (or ?focus=x,y in 0..1), overflow cropped.
 *
 * Optional files read from the package: manifest.json (file facts) and interactive.project.json (workbench shots,
 * cast, notes, script, lyric lines; written by build.mjs --project).
 */
(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const film = $('#ix-film'), ov = $('#ix-overlay'), hov = $('#ix-hover'), hovLabel = $('#ix-hover b'), cardsEl = $('#ix-cards');
  const btnPlay = $('#ix-play'), timeEl = $('#ix-time'), scrub = $('#ix-scrub'), btnLive = $('#ix-live'), hint = $('#ix-hint');
  const lineEl = $('#ix-line'), lineFill = $('#ix-line i'), toastEl = $('#ix-toast'), hud = $('#ix-hud');
  // per-viewer preferences (localStorage can be missing or throw: private windows, blocked storage)
  const pref = {
    get: (k, d, ok) => { try { const v = localStorage.getItem('ix.' + k); return v !== null && (!ok || ok.includes(v)) ? v : d; } catch (e) { return d; } },
    set: (k, v) => { try { localStorage.setItem('ix.' + k, v); } catch (e) {} },
  };
  const ASPECTS = ['fit', 'fill'], HUDS = ['auto', 'always', 'never'];
  let aspect = pref.get('aspect', 'fit', ASPECTS), hudMode = pref.get('hud', 'auto', HUDS), lineOn = pref.get('line', '0') === '1', hinted = pref.get('hinted', '0') === '1';
  const focus = (() => { const m = /[?&]focus=([\d.]+),([\d.]+)/.exec(location.search); return m ? [Math.min(1, +m[1]), Math.min(1, +m[2])] : [0.5, 0.5]; })();
  const HUD_ZONE = 48, HUD_LINGER = 1200, KEY_SHOW = 1500, STILL = 1500;

  let W = null, doc = null, root = null, A = null, CW = 1280, CH = 720, DUR = 0;
  let fit = { s: 1, ox: 0, oy: 0 };
  let ready = false, paused = false, inspect = true, drive = null, holding = false;
  let manifest = null, project = null;
  const ptr = { x: -1, y: -1, in: false, moved: -1e9, inWin: false };
  let zoneLeft = -1e9, keyUntil = -1e9, hudShown = null;
  let hoverHit = null, zTop = 100, cardN = 0, cards = [], scrubbed = false, liveT = 0, lastWall = performance.now(), scrubbing = false;

  const WIN_SEL = '.win, .kit-win, .wframe, .balloon, .tip, dialog, [role=dialog], [role=alertdialog], .dialog, .window';
  const DLG_SEL = '.balloon, .tip, dialog, [role=dialog], [role=alertdialog], .dialog';
  const BTN_SEL = 'button, .btn, .cb, .task, .start, .icon, .go, .thumb, [role=button], a[href]';

  // ------------------------------------------------------------------ clock
  // The film's clock is its master <audio> (standalone mode). Compositions without a standalone driver are driven
  // here: the HyperFrames timeline is seeked to the audio time each frame (see drive).
  // Without an <audio> element a wall clock (performance.now) stands in for it.
  const wall = { t: 0, since: null };
  const wallT = () => { const t = wall.since === null ? wall.t : wall.t + (performance.now() - wall.since) / 1000; return DUR ? Math.min(t, DUR) : t; };
  const clock = {
    t: () => A ? A.currentTime : wallT(),
    playing: () => A ? !A.paused && !A.ended : wall.since !== null && !(DUR && wallT() >= DUR),
    play: () => { if (A) return A.play().catch((e) => { if (!(e && e.name === 'AbortError')) setMode(true); }); if (DUR && wallT() >= DUR) { wall.t = 0; wall.since = null; } if (wall.since === null) wall.since = performance.now(); },
    pause: () => { if (A) return A.pause(); wall.t = wallT(); wall.since = null; },
    seek: (t) => {
      t = Math.max(0, Math.min(DUR - 0.01, t));
      if (A) A.currentTime = t; else { wall.t = t; if (wall.since !== null) wall.since = performance.now(); }
    },
  };
  const fmt = (t) => { t = Math.max(0, t || 0); const m = Math.floor(t / 60), s = t - m * 60; return m + ':' + (s < 10 ? '0' : '') + s.toFixed(3); };
  const fmtShort = (t) => fmt(t).slice(0, -2);

  // ------------------------------------------------------------------ layout: fit (letterbox) or fill (cover + crop)
  // One uniform scale either way (never stretched); every window <-> film mapping goes through fit {s, ox, oy}.
  function layout() {
    const vw = innerWidth, vh = innerHeight, s = (aspect === 'fill' ? Math.max : Math.min)(vw / CW, vh / CH);
    fit = { s, ox: (vw - CW * s) * (aspect === 'fill' ? focus[0] : 0.5), oy: (vh - CH * s) * (aspect === 'fill' ? focus[1] : 0.5) };
    document.body.dataset.aspect = aspect;
    film.style.width = CW + 'px'; film.style.height = CH + 'px';
    film.style.transform = `translate(${fit.ox}px,${fit.oy}px) scale(${s})`;
  }
  const toFilm = (x, y) => [(x - fit.ox) / fit.s, (y - fit.oy) / fit.s];
  const toWin = (r) => ({ x: fit.ox + r.left * fit.s, y: fit.oy + r.top * fit.s, w: r.width * fit.s, h: r.height * fit.s });
  addEventListener('resize', layout);
  layout(); setHint();

  // ------------------------------------------------------------------ boot
  // the iframe precedes this script, so the film may have finished loading before it runs: boot now in that case
  let booted = false;
  film.addEventListener('load', boot);
  try { const d = film.contentDocument; if (d && d.readyState === 'complete' && d.URL !== 'about:blank') setTimeout(boot); } catch (e) { setTimeout(boot); }
  async function boot() {
    if (booted) return; booted = true;
    try { W = film.contentWindow; doc = W.document; void doc.body; } catch (e) {
      return fatal('The interactive layer needs the package served over http (same origin).<br>node serve.mjs &lt;package&gt; and open /interactive.html');
    }
    const st = doc.createElement('style'); st.id = 'ix-base';
    // the film hides the system pointer (#screen {cursor: none}) because it draws its own XP cursor; in the player the
    // real pointer stays visible: arrow, or the I-beam over selectable text while paused
    st.textContent = 'html,body{margin:0!important;overflow:hidden!important;background:#000}html,body,body *{cursor:auto!important}' +
      'html.ix-hot,html.ix-hot body,html.ix-hot body *{cursor:pointer!important}';
    doc.head.appendChild(st);
    for (let i = 0; i < 600 && !(root = doc.querySelector('[data-composition-id]')); i++) await wait(50);
    if (!root) return fatal('no [data-composition-id] root in the composition');
    CW = Number(root.getAttribute('data-width')) || root.offsetWidth || 1280;
    CH = Number(root.getAttribute('data-height')) || root.offsetHeight || 720;
    DUR = Number(root.getAttribute('data-duration')) || 0;
    A = root.querySelector('audio[data-start]') || doc.querySelector('audio');
    layout();
    // the composition registers its timeline when its fonts and assets are ready
    for (let i = 0; i < 1200 && !(W.__timelines && Object.keys(W.__timelines).length); i++) await wait(50);
    const own = [...doc.scripts].some((s) => /standalone/.test(s.textContent || ''));
    if (!own && W.__timelines) drive = Object.values(W.__timelines)[0] || null;
    if (!DUR && A) DUR = A.duration || 0;
    if (!DUR && drive && drive.duration) DUR = drive.duration();
    scrub.max = String(DUR);
    // a package exported with lazy media (lazy/lazy-media.js): the opening's files first, then ready
    if (W.__hfLazy) await W.__hfLazy.until(clock.t(), clock.t() + W.__hfLazy.first, 120000);
    copyFonts();
    hookFilm();
    fetch('manifest.json').then((r) => r.ok ? r.json() : null).then((j) => { manifest = j; }).catch(() => {});
    fetch('interactive.project.json').then((r) => r.ok ? r.json() : null).then((j) => { project = j; }).catch(() => {});
    ready = true;
    window.IX.ready = true;
    clock.play();
    requestAnimationFrame(tick);
  }
  function fatal(html) { const d = document.createElement('div'); d.id = 'ix-msg'; d.innerHTML = html; document.body.appendChild(d); }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // film fonts (@font-face) copied into this document so clones and text cards render in the same faces
  function copyFonts() {
    let css = '';
    const walk = (rules, base) => { for (const r of rules) {
      if (r.type === 5) css += r.cssText.replace(/url\((['"]?)([^'")]+)\1\)/g, (m, q, u) => 'url("' + new URL(u, base).href + '")') + '\n';
      else if (r.cssRules) walk(r.cssRules, base);
    } };
    for (const sh of doc.styleSheets) { try { walk(sh.cssRules, sh.href || doc.baseURI); } catch (e) {} }
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  }

  // listeners inside the film document (no file is changed; they only stop events the layer owns)
  function hookFilm() {
    W.addEventListener('keydown', onKey, true);
    // standalone mode toggles play on any body click: while paused, clicks belong to selecting, so they stop here
    W.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.altKey) { e.preventDefault(); setMode(false); }
    }, true);
    // while paused the film document takes the pointer: report its position in window coordinates (HUD zone, outlines)
    W.addEventListener('pointermove', (e) => movedTo(fit.ox + e.clientX * fit.s, fit.oy + e.clientY * fit.s), true);
    W.addEventListener('dblclick', (e) => {
      if (!paused) return;
      const h = hitFilm(e.clientX, e.clientY, e.shiftKey);
      if (h) { W.getSelection().removeAllRanges(); lift(h, { keep: true }); }
    }, true);
  }

  // ------------------------------------------------------------------ modes
  const modeLog = [];
  function setMode(wantPaused, fromClock) {
    if (!fromClock) setHold(false);
    modeLog.push({ paused: wantPaused, t: clock.t(), wall: performance.now(), byClock: !!fromClock });
    if (!fromClock) { if (wantPaused) clock.pause(); else clock.play(); }
    paused = wantPaused;
    document.body.classList.toggle('ix-paused', paused);
    btnPlay.innerHTML = paused ? '&#9654;' : '&#10074;&#10074;';
    setHint();
    let us = doc.getElementById('ix-select');
    if (paused && !us) { us = doc.createElement('style'); us.id = 'ix-select'; us.textContent = '#' + (root.id || 'root') + ' *, [data-composition-id] *{-webkit-user-select:text!important;user-select:text!important}img{-webkit-user-drag:auto}'; doc.head.appendChild(us); }
    if (!paused) { if (us) us.remove(); try { W.getSelection().removeAllRanges(); } catch (e) {} window.focus(); }
    if (paused) hideHover(); else setHot(false);
  }
  function setHint() {
    const txt = paused ? 'paused · select / copy / drag anything · dbl-click lifts · Space resumes'
      : hinted ? '' : 'click anything · Space pauses · H bar · A fit/fill';
    hint.textContent = txt; hint.hidden = !txt;
  }
  // paused: the film document owns the pointer; a hand over things a double-click lifts (the I-beam stays on text)
  let hot = false;
  function setHot(on) { if (on !== hot && doc) { hot = on; doc.documentElement.classList.toggle('ix-hot', on); } }
  btnPlay.addEventListener('click', () => setMode(!paused));

  // ------------------------------------------------------------------ the frame loop (parent only)
  function tick(now) {
    requestAnimationFrame(tick);
    now = performance.now();
    const dt = (now - lastWall) / 1000; lastWall = now;
    const t = clock.t(), playing = clock.playing(), lazy = W.__hfLazy, intent = playing || holding;
    // lazy media: while the files at the playhead are still loading the clock waits (a seek, a slow network), then
    // goes on by itself; the viewer's play / pause state does not change
    if (lazy) { if (holding && lazy.ready(t)) { setHold(false); clock.play(); } else if (!holding && playing && !lazy.ready(t)) { setHold(true); clock.pause(); } }
    if (intent === paused) setMode(!intent, true); // ended, autoplay refused, or the film paused itself
    if (drive) driveFilm(t, playing);
    if (!scrubbed) liveT = t; else if (playing) liveT = Math.min(DUR, liveT + dt);
    if (scrubbed && Math.abs(liveT - t) < 0.3) scrubbed = false;
    document.body.classList.toggle('ix-scrubbed', scrubbed);
    btnLive.hidden = !scrubbed;
    timeEl.textContent = fmt(t).slice(0, -2) + ' / ' + fmtShort(DUR);
    if (!scrubbing) scrub.value = String(t);
    // what is under the pointer (only where the film itself is on top, not a card or the HUD)
    let h = null;
    if (ptr.in) { const top = document.elementFromPoint(ptr.x, ptr.y); if (top === ov || top === film) h = hitWin(ptr.x, ptr.y, false); }
    ov.classList.toggle('ix-over', !paused && !!h);
    if (paused) setHot(!!h && h.kind !== 'text');
    // outlines only while the pointer moves: a still screen is clean
    if (!paused && h && inspect && now - ptr.moved < STILL) showHover(h); else hideHover();
    hudTick(now, t);
  }
  function setHold(on) { if (on !== holding) { holding = on; document.body.classList.toggle('ix-wait', on); } }
  // ------------------------------------------------------------------ HUD: bottom edge / keys / always / never
  function hudTick(now, t) {
    if (ptr.in && ptr.y >= innerHeight - HUD_ZONE) zoneLeft = now;
    const on = hudMode === 'always' || (hudMode === 'auto' && (now - zoneLeft < HUD_LINGER || now < keyUntil || scrubbing));
    if (on !== hudShown) { hudShown = on; document.body.classList.toggle('ix-hud-on', on); }
    document.body.classList.toggle('ix-line-on', lineOn && !on);
    if (lineOn && !on && DUR) lineFill.style.width = (100 * t / DUR).toFixed(3) + '%';
  }
  let toastT = 0;
  function toast(msg) { toastEl.textContent = msg; toastEl.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { toastEl.hidden = true; }, 1200); }
  function setAspect(m) { aspect = ASPECTS.includes(m) ? m : 'fit'; pref.set('aspect', aspect); layout(); }
  // compositions without their own standalone driver: seek the timeline and keep timed media in step
  function driveFilm(t, playing) {
    try { drive.seek(t, false); } catch (e) {}
    for (const v of doc.querySelectorAll('video[data-start]')) {
      const rate = +v.getAttribute('data-playback-rate') || 1;
      const s = +v.getAttribute('data-start'), d = +v.getAttribute('data-duration') || 1e9, m = (+v.getAttribute('data-media-start') || 0) + (t - s) * rate;
      if (t < s || t >= s + d) { if (!v.paused) v.pause(); continue; }
      if (v.playbackRate !== rate) v.playbackRate = rate;
      if (Math.abs(v.currentTime - m) > 0.15) v.currentTime = m;
      if (playing && v.paused) v.play().catch(() => {}); else if (!playing && !v.paused) v.pause();
    }
  }

  // ------------------------------------------------------------------ seeking (explicit only)
  function seekTo(t) { if (!scrubbed) { scrubbed = true; liveT = clock.t(); } clock.seek(t); }
  scrub.addEventListener('input', () => { scrubbing = true; seekTo(+scrub.value); });
  scrub.addEventListener('change', () => { scrubbing = false; scrub.blur(); });
  btnLive.addEventListener('click', () => { clock.seek(liveT); scrubbed = false; });

  // ------------------------------------------------------------------ hit testing
  const hitWin = (x, y, container) => { const [fx, fy] = toFilm(x, y); return fx < 0 || fy < 0 || fx > CW || fy > CH ? null : hitFilm(fx, fy, container); };
  function hitFilm(x, y, container) {
    if (!doc || !root) return null;
    for (const el of doc.elementsFromPoint(x, y)) {
      if (el === root || !root.contains(el)) continue;
      const c = classify(el, x, y, container);
      if (c) return c;
    }
    return null;
  }
  function cs(el, pe) { return W.getComputedStyle(el, pe); }
  function ownText(el) { for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3 && n.nodeValue.trim()) return true; return false; }
  function bgUrl(el) { const m = /url\(["']?([^"')]+)["']?\)/.exec(cs(el).backgroundImage || ''); return m && !m[1].startsWith('data:') ? m[1] : null; }
  function coversRoot(el) { const r = el.getBoundingClientRect(), R = root.getBoundingClientRect(); return r.width >= R.width * 0.95 && r.height >= R.height * 0.95; }
  function boring(el) { const s = cs(el); return s.backgroundColor === 'rgba(0, 0, 0, 0)' && s.backgroundImage === 'none' && s.borderTopWidth === '0px' && s.boxShadow === 'none'; }
  function stackedAlpha(v) { const p = v.parentElement; return !!p && v.offsetHeight > 0 && Math.abs(v.offsetHeight / 2 - p.clientHeight) < p.clientHeight * 0.08 && cs(p).overflow === 'hidden'; }
  function textAt(el, x, y) {
    if (el instanceof W.SVGElement) return null;
    if (!ownText(el) && !el.hasAttribute('data-lyric')) return null;
    const rg = doc.createRange(); rg.selectNodeContents(el);
    let inside = false;
    for (const r of rg.getClientRects()) if (x >= r.left - 3 && x <= r.right + 3 && y >= r.top - 3 && y <= r.bottom + 3) { inside = true; break; }
    if (!inside) return null;
    let t = el.closest('[data-lyric]') || el;
    while (t.parentElement && t.parentElement !== root && cs(t).display.startsWith('inline') && !t.parentElement.matches(WIN_SEL) &&
      t.parentElement.textContent.trim().length < 400) t = t.parentElement;
    return t;
  }
  function classify(el, x, y, container) {
    if (el.closest('.cursor')) return null;
    const win = el.closest(WIN_SEL);
    if (container && win) return mk(win.matches(DLG_SEL) ? 'dialog' : 'window', win);
    const tag = el.tagName.toLowerCase();
    if (tag === 'video') {
      if (stackedAlpha(el)) return mk('dancer', el.parentElement, { media: el, alpha: true, src: el.currentSrc || el.src });
      return mk('video', el.closest('.wclip') || el, { media: el, src: el.currentSrc || el.src });
    }
    if (el.matches('.kit-sprite, .cutout, .sprite')) return mk('dancer', el, { sprite: true, src: tag === 'img' ? el.currentSrc || el.src : bgUrl(el) });
    if (tag === 'img') return mk('image', el, { src: el.currentSrc || el.src });
    if (tag === 'image') return mk('image', el, { src: new URL(el.href.baseVal, doc.baseURI).href });
    if (tag === 'canvas') return mk('element', el);
    const tx = textAt(el, x, y); if (tx) return mk('text', tx);
    const btn = el.closest(BTN_SEL); if (btn && root.contains(btn)) return mk('button', btn);
    if (win) return mk(win.matches(DLG_SEL) ? 'dialog' : 'window', win);
    const bg = bgUrl(el); if (bg) return mk('image', el, { src: new URL(bg, doc.baseURI).href, bg: true });
    const svg = el.closest('svg'); if (svg && !coversRoot(svg)) { let o = svg; while (o.parentElement && o.parentElement.closest('svg')) o = o.parentElement.closest('svg'); return mk('graphic', o); }
    if (coversRoot(el) || boring(el)) return null;
    return mk('element', el);
  }
  function mk(kind, el, o) { return Object.assign({ kind, el }, o || {}); }
  const short = (s, n = 48) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const baseName = (u) => { try { return decodeURIComponent(String(u).split(/[?#]/)[0].split('/').pop()); } catch (e) { return String(u); } };
  function nameOf(h) {
    const el = h.el;
    if (h.kind === 'text') return '"' + short(el.textContent) + '"';
    if (h.kind === 'window' || h.kind === 'dialog') { const tt = el.querySelector('.tt, .kit-ttl, b, [class*=title]'); return short(tt ? tt.textContent : el.className, 60) || h.kind; }
    if (h.src) return baseName(h.src);
    if (h.kind === 'button') return short(el.textContent, 40) || String(el.className);
    return el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).join('.') : '');
  }
  const rel = (u) => { if (!u) return ''; const b = new URL('.', doc.baseURI).href; return u.startsWith(b) ? decodeURIComponent(u.slice(b.length).split(/[?#]/)[0]) : u; };

  // ------------------------------------------------------------------ hover
  function showHover(h) {
    hoverHit = h;
    if (!h || !h.el.isConnected) { hov.style.display = 'none'; return; }
    const r = toWin(h.el.getBoundingClientRect());
    Object.assign(hov.style, { display: 'block', left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
    hov.classList.toggle('ix-below', r.y < 16);
    const lab = h.kind + ' · ' + nameOf(h);
    if (hovLabel.textContent !== lab) hovLabel.textContent = lab;
  }
  function hideHover() { if (hoverHit || hov.style.display !== 'none') { hoverHit = null; hov.style.display = 'none'; } }

  // the pointer in window coordinates, from this page or (paused) from the film document
  function movedTo(x, y) { ptr.x = x; ptr.y = y; ptr.in = x >= 0 && y >= 0 && x < innerWidth && y < innerHeight; ptr.moved = performance.now(); }
  addEventListener('pointermove', (e) => movedTo(e.clientX, e.clientY), true);
  document.documentElement.addEventListener('pointerleave', () => { ptr.in = false; });
  ov.addEventListener('click', (e) => {
    if (!ready) return;
    if (e.altKey) { setMode(true); return; }
    const keep = e.ctrlKey || e.metaKey;
    // a plain click while unpinned cards are open only sends them back; Ctrl/Cmd+click lifts and keeps them
    if (!keep && cards.some((c) => !c.pinned)) { closeAll(false); return; }
    const h = hitWin(e.clientX, e.clientY, e.shiftKey);
    if (h) lift(h, { keep });
  });
  ov.addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });

  // ------------------------------------------------------------------ keys
  function onKey(e) {
    if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName) && e.target.type !== 'range') return;
    const k = e.key, plain = !(e.ctrlKey || e.metaKey || e.altKey);
    if (k === ' ' || e.code === 'Space' || k === 'ArrowLeft' || k === 'ArrowRight') keyUntil = performance.now() + KEY_SHOW; // the bar shows briefly
    if (k === ' ' || e.code === 'Space') { e.preventDefault(); setMode(!paused); }
    else if (k === 'Escape') { e.preventDefault(); const c = [...cards].reverse().find((c) => !c.pinned) || null; if (c) closeCard(c); }
    else if (k === 'ArrowLeft' || k === 'ArrowRight') { e.preventDefault(); seekTo(clock.t() + (k === 'ArrowLeft' ? -5 : 5)); }
    else if ((k === 'i' || k === 'I') && plain) { inspect = !inspect; document.body.classList.toggle('ix-noinspect', !inspect); toast('outlines ' + (inspect ? 'on' : 'off')); }
    else if ((k === 'h' || k === 'H') && plain) {
      hudMode = HUDS[(HUDS.indexOf(hudMode) + 1) % HUDS.length]; pref.set('hud', hudMode);
      toast({ auto: 'bar: at the bottom edge', always: 'bar: always', never: 'bar: never (keys still work)' }[hudMode]);
    }
    else if ((k === 'l' || k === 'L') && plain) { lineOn = !lineOn; pref.set('line', lineOn ? '1' : '0'); toast('progress line ' + (lineOn ? 'on' : 'off')); }
    else if ((k === 'a' || k === 'A') && plain) { setAspect(ASPECTS[(ASPECTS.indexOf(aspect) + 1) % ASPECTS.length]); toast(aspect === 'fill' ? 'fill: cover the window, edges cropped' : 'fit: the whole film'); }
  }
  addEventListener('keydown', onKey, true);

  // ------------------------------------------------------------------ frozen clones (computed styles inlined)
  const URLREF = /url\((["']?)([^"')]*?)#([^"')]+)\1\)/g;
  function absAttr(c, s, name) { const v = s.getAttribute(name); if (v && !v.startsWith('#') && !/^(data|blob):/.test(v)) c.setAttribute(name, new URL(v, doc.baseURI).href); }
  function styleText(s, extra) {
    const st = cs(s); let out = '';
    for (let i = 0; i < st.length; i++) { const p = st[i]; out += p + ':' + st.getPropertyValue(p) + ';'; }
    return (out + (extra || '')).replace(URLREF, (m, q, pre, id) => pre === '' || pre.startsWith(doc.baseURI.split('#')[0].split('?')[0]) || pre.startsWith(doc.baseURI.split('#')[0]) ? 'url("#' + id + '")' : m);
  }
  const FREEZE = 'transition:none!important;animation:none!important;-webkit-user-select:text;user-select:text;pointer-events:auto;';
  let pseudoN = 0;
  function cloneStyled(src) {
    const all = [src, ...src.querySelectorAll('*')];
    if (all.length > 2500) all.length = 2500;
    const clone = src.cloneNode(true), call = [clone, ...clone.querySelectorAll('*')];
    let pseudo = '';
    for (let i = 0; i < call.length; i++) {
      const s = all[i], c = call[i]; if (!s) { c.remove(); continue; }
      c.removeAttribute('class'); c.removeAttribute('data-lyric');
      c.setAttribute('style', styleText(s, FREEZE));
      for (const pe of ['::before', '::after']) {
        const ps = cs(s, pe);
        if (ps.content && ps.content !== 'none' && ps.content !== 'normal') {
          const cls = 'ix-p' + (++pseudoN); c.classList.add(cls);
          let txt = ''; for (let k = 0; k < ps.length; k++) txt += ps[k] + ':' + ps.getPropertyValue(ps[k]) + ';';
          pseudo += '.' + cls + pe + '{' + txt + '}\n';
        }
      }
      const tag = s.tagName.toLowerCase();
      if (tag === 'img') { c.setAttribute('src', s.currentSrc || s.src); c.removeAttribute('srcset'); c.removeAttribute('loading'); }
      else if (tag === 'video' || tag === 'canvas') { const cv = frameCanvas(s); cv.setAttribute('style', c.getAttribute('style')); c.replaceWith(cv); }
      else if (tag === 'audio' || tag === 'script') c.remove();
      for (const a of ['href', 'xlink:href', 'poster']) if (s.hasAttribute && s.hasAttribute(a) && tag !== 'a') absAttr(c, s, a);
      if (tag === 'a') c.removeAttribute('href');
    }
    const r = src.getBoundingClientRect(), z = src.currentCSSZoom || 1;
    const nat = { w: Math.max(1, src.offsetWidth || r.width / z), h: Math.max(1, src.offsetHeight || r.height / z) };
    clone.style.cssText += ';position:relative!important;left:0!important;top:0!important;right:auto!important;bottom:auto!important;margin:0!important;' +
      'transform:none!important;translate:none!important;rotate:none!important;scale:none!important;opacity:1!important;visibility:visible!important;zoom:1!important;' +
      (cs(src).display.startsWith('inline') && !(src instanceof W.SVGElement) ? 'display:inline-block!important;' : '') +
      'width:' + nat.w + 'px!important;height:' + nat.h + 'px!important;max-width:none!important;max-height:none!important;';
    if (cs(src).display === 'none') clone.style.setProperty('display', 'block', 'important');
    const wrap = document.createElement('div');
    if (pseudo) { const st = document.createElement('style'); st.textContent = pseudo; wrap.appendChild(st); }
    const defs = svgDefs(clone); if (defs) wrap.appendChild(defs);
    wrap.appendChild(clone);
    return { node: wrap, clone, nat };
  }
  // SVG paint servers / filters / symbols referenced by the clone, copied next to it
  function svgDefs(clone) {
    const ids = new Set(), seen = new Set();
    const scan = (node) => {
      const html = node.outerHTML || '';
      for (const m of html.matchAll(/url\((?:&quot;|["'])?#([\w:.-]+)/g)) ids.add(m[1]);
      for (const m of html.matchAll(/href="#([\w:.-]+)"/g)) ids.add(m[1]);
    };
    scan(clone);
    if (!ids.size) return null;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '0'); svg.setAttribute('height', '0'); svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
    const d = document.createElementNS('http://www.w3.org/2000/svg', 'defs'); svg.appendChild(d);
    for (let guard = 0; ids.size && guard < 200; guard++) {
      const id = ids.values().next().value; ids.delete(id); if (seen.has(id)) continue; seen.add(id);
      const src = doc.getElementById(id); if (!src || clone.querySelector && clone.querySelector('[id="' + CSS.escape(id) + '"]')) continue;
      const c = src.cloneNode(true); d.appendChild(c); scan(c);
    }
    return d.childNodes.length ? svg : null;
  }
  function frameCanvas(v) {
    const cv = document.createElement('canvas');
    const w = v.videoWidth || v.width || v.offsetWidth || 2, h = v.videoHeight || v.height || v.offsetHeight || 2;
    cv.width = w; cv.height = h;
    try { if (!(v.tagName === 'VIDEO' && (v.readyState < 2 || v.seeking))) { cv.getContext('2d').drawImage(v, 0, 0, w, h); cv.__drawn = true; } } catch (e) {}
    return cv;
  }
  function effectiveBg(el) {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const s = cs(n);
      if (s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.backgroundColor !== 'transparent') return s.backgroundColor;
      if (s.backgroundImage !== 'none' && n !== el) break;
    }
    const c = cs(el).color.match(/\d+/g) || [0, 0, 0], lum = (0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]);
    return lum > 140 ? '#1d2026' : '#f4f4f2';
  }

  // ------------------------------------------------------------------ card contents per kind
  function contentFor(h, t) {
    const el = h.el, out = { node: null, nat: { w: 100, h: 100 }, extra: [], save: null, stop: [] };
    if (h.kind === 'image') {
      const im = document.createElement('img'); im.src = h.src; im.draggable = true; im.alt = baseName(h.src);
      out.node = im;
      const ni = el.tagName === 'IMG' ? el : null;
      out.nat = ni && ni.naturalWidth ? { w: ni.naturalWidth, h: ni.naturalHeight } : { w: 0, h: 0 };
      if (!out.nat.w) { const p = new Image(); p.src = h.src; out.nat = p.naturalWidth ? { w: p.naturalWidth, h: p.naturalHeight } : { w: 640, h: 360 }; out.wait = p.decode ? p.decode().then(() => ({ w: p.naturalWidth, h: p.naturalHeight })).catch(() => null) : null; }
      out.save = { label: 'save', href: h.src, name: baseName(h.src) };
      out.extra.push(info(`${out.nat.w}×${out.nat.h} source · Ctrl+wheel to zoom · drag out to save`));
    } else if (h.kind === 'video') {
      const v = h.media, cv = frameCanvas(v), at = v.currentTime;
      out.node = cv; out.nat = { w: cv.width, h: cv.height };
      const loop = mediaLoop(h.src, at); out.stop.push(() => { loop.pause(); loop.removeAttribute('src'); loop.load(); });
      // the film's video can be mid-seek at the click (standalone mode seeks it every frame): take the frame from
      // the card's own copy of the file, at the same media time, once it has landed there
      if (!cv.__drawn) loop.addEventListener('seeked', () => { if (!cv.__drawn) { try { cv.getContext('2d').drawImage(loop, 0, 0, cv.width, cv.height); cv.__drawn = true; } catch (e) {} } }, { once: true });
      out.extra.push(loop, info(`frame at ${v.currentTime.toFixed(3)} s of ${baseName(h.src)} · the clip loops on the left`));
      out.save = { label: 'save frame', canvas: cv, name: baseName(h.src).replace(/\.\w+$/, '') + '@' + v.currentTime.toFixed(3) + '.png' };
    } else if (h.kind === 'dancer') {
      const d = h.alpha ? alphaLoop(h.media) : spriteLoop(el, t);
      out.node = d.node; out.nat = d.nat; out.stop.push(d.stop);
      out.extra.push(info(h.alpha ? 'stacked-alpha clip, looping' : 'sprite sheet, looping on the beat grid'));
      if (h.src) out.save = { label: 'file', href: h.src, name: baseName(h.src) };
    } else {
      const c = cloneStyled(el);
      out.node = c.node; out.nat = c.nat; out.clone = c.clone;
      out.bg = h.kind === 'text' ? effectiveBg(el) : null;
      out.save = { label: 'copy', text: () => (c.clone.innerText || c.clone.textContent || '').trim() };
      if (h.kind !== 'text') out.extra.push(info('frozen at ' + fmt(t) + ' · text inside is selectable'));
    }
    return out;
  }
  function info(s) { const d = document.createElement('span'); d.textContent = s; return d; }
  function mediaLoop(src, at) {
    const v = document.createElement('video');
    v.muted = true; v.loop = true; v.playsInline = true; v.autoplay = true; v.controls = true; v.preload = 'auto'; v.src = src;
    v.addEventListener('loadedmetadata', () => { try { v.currentTime = Math.min(at || 0, Math.max(0, v.duration - 0.05)); } catch (e) {} v.play().catch(() => {}); }, { once: true });
    return v;
  }
  // a stacked-alpha clip (colour on top, alpha below) decoded into a transparent canvas, looping
  function alphaLoop(src) {
    const v = mediaLoop(src.currentSrc || src.src, src.currentTime); v.controls = false;
    const vw = src.videoWidth || 400, vh = (src.videoHeight || 1080) / 2;
    const cv = document.createElement('canvas'); cv.width = vw; cv.height = vh;
    const off = document.createElement('canvas'); off.width = vw; off.height = vh * 2;
    const ctx = cv.getContext('2d'), octx = off.getContext('2d', { willReadFrequently: true });
    const draw = (from) => {
      try {
        octx.drawImage(from, 0, 0, vw, vh * 2);
        const top = octx.getImageData(0, 0, vw, vh), bot = octx.getImageData(0, vh, vw, vh), a = top.data, b = bot.data;
        for (let i = 0; i < a.length; i += 4) a[i + 3] = b[i];
        ctx.putImageData(top, 0, 0);
      } catch (e) {}
    };
    if (src.readyState >= 2) draw(src);
    let on = true;
    (function loop() { if (!on) return; if (v.readyState >= 2 && !v.paused) draw(v); requestAnimationFrame(loop); })();
    return { node: cv, nat: { w: vw, h: vh }, stop: () => { on = false; v.pause(); v.removeAttribute('src'); v.load(); } };
  }
  // a sprite-sheet figure: the same sheet, stepped on the film's beat grid when the composition exposes it (KIT)
  function spriteLoop(el, t) {
    const s = cs(el), fw = el.offsetWidth || 200, fh = el.offsetHeight || 300;
    if (el.tagName === 'IMG') { const im = document.createElement('img'); im.src = el.currentSrc || el.src; return { node: im, nat: { w: el.naturalWidth || fw, h: el.naturalHeight || fh }, stop: () => {} }; }
    const [bw, bh] = (s.backgroundSize || '').split(' ').map(parseFloat);
    const cols = Math.max(1, Math.round((bw || fw) / fw)), rows = Math.max(1, Math.round((bh || fh) / fh));
    const src = bgUrl(el) || '', sheets = W.KIT_SHEETS || {};
    const id = Object.keys(sheets).find((k) => baseName(sheets[k].src) === baseName(src));
    const count = id ? sheets[id].count : cols * rows;
    const d = document.createElement('div');
    d.style.cssText = `width:${fw}px;height:${fh}px;background-image:${s.backgroundImage};background-size:${s.backgroundSize};background-repeat:no-repeat;filter:${s.filter === 'none' ? 'none' : s.filter}`;
    const m = /matrix\(([^,]+)/.exec(s.transform); if (m && parseFloat(m[1]) < 0) d.style.transform = 'scaleX(-1)';
    const t0 = performance.now(); let on = true;
    (function loop() {
      if (!on) return;
      const tv = t + (performance.now() - t0) / 1000;
      let f; try { f = id && W.KIT ? W.KIT.clip(id, tv) : Math.floor(tv * 12) % count; } catch (e) { f = Math.floor(tv * 12) % count; }
      d.style.backgroundPosition = -(f % cols) * fw + 'px ' + -Math.floor(f / cols) * fh + 'px';
      requestAnimationFrame(loop);
    })();
    d.style.backgroundColor = 'transparent';
    return { node: d, nat: { w: fw, h: fh }, stop: () => { on = false; } };
  }

  // ------------------------------------------------------------------ metadata
  function metaFor(h, t) {
    const lines = [], el = h.el;
    const shotEl = el.closest('[data-shot]'), shotId = shotEl ? shotEl.getAttribute('data-shot') : (W.XPE && W.XPE.find ? (W.XPE.find(t) || {}).id : null);
    lines.push(`<b>${fmt(t)}</b> song time` + (shotId ? ` · scene <b>${esc(shotId)}</b>` : '') + ` · ${esc(h.kind)} <b>${esc(nameOf(h))}</b>`);
    const tagLine = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : '');
    const src = h.src ? rel(h.src) : '';
    let fileLine = 'element ' + esc(tagLine);
    if (src) {
      fileLine = 'file <b>' + esc(src) + '</b>';
      const pkg = pkgRel(h.src); // manifest paths are relative to the package root, not to the entry's folder
      const a = manifest && manifest.assets && manifest.assets.find((x) => x.path === pkg);
      if (a) fileLine += ' · ' + [a.width && a.height ? a.width + '×' + a.height : '', a.codec, a.duration ? a.duration + ' s' : '', (a.bytes / 1048576).toFixed(1) + ' MB'].filter(Boolean).join(' · ');
    }
    lines.push(fileLine);
    if (project) {
      const ms = t * 1000, P = project;
      const shot = (P.shots || []).find((s) => s.id === shotId) || (P.shots || []).find((s) => ms >= s.t0 && ms < s.t1);
      if (shot) {
        const cast = (shot.cast || []).map((c) => (P.entities && P.entities[c]) || c).join(', ');
        lines.push(`shot <b>${esc(shot.id)}</b> ${esc(shot.title || '')}` + (cast ? ` · cast <b>${esc(cast)}</b>` : '') + (shot.locations && shot.locations.length ? ' · loc ' + esc(shot.locations.join(', ')) : ''));
        if (shot.note) lines.push('<span class="ix-n">note</span> ' + esc(shot.note));
      }
      const b = baseName(src);
      const use = b && (P.uses || []).find((u) => (baseName(u.file) === b || baseName(u.start_image) === b) && ms >= u.t0 && ms < u.t1) || b && (P.uses || []).find((u) => baseName(u.file) === b || baseName(u.start_image) === b);
      if (use) lines.push(`clip use <b>${esc(use.id)}</b> ${esc(use.label || '')}`);
      const line = (P.lines || []).find((l) => ms >= l.t0 && ms < l.t1);
      if (line) lines.push(`lyric <b>${esc(line.text)}</b>`);
      const sc = (P.script || []).filter((s) => s.t0 <= ms).pop();
      if (sc && sc.action) lines.push('script ' + esc(sc.id) + ': ' + esc(sc.action));
      const near = (P.notes || []).filter((n) => Math.abs(n.t - ms) < 6000).sort((p, q) => Math.abs(p.t - ms) - Math.abs(q.t - ms)).slice(0, 2);
      for (const n of near) lines.push(`note ${fmtShort(n.t / 1000)} ${esc(n.by || '')}: ${esc(n.text)}`);
    }
    return lines.map((l) => '<div>' + l + '</div>').join('');
  }
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const pkgRel = (u) => { try { const b = new URL('.', location.href).href, a = new URL(u, doc.baseURI).href; return a.startsWith(b) ? decodeURIComponent(a.slice(b.length).split(/[?#]/)[0]) : null; } catch (e) { return null; } };

  // ------------------------------------------------------------------ cards
  function lift(h, o) {
    o = o || {};
    const t = clock.t(), from = toWin(h.el.getBoundingClientRect());
    const c = { id: ++cardN, h, t, from, pinned: false, z: 1, name: nameOf(h) };
    const body = contentFor(h, t);
    const card = document.createElement('div'); card.className = 'ix-card'; card.dataset.kind = h.kind;
    card.innerHTML = '<div class="ix-head"><b class="ix-kind"></b><span class="ix-name"></span><span class="ix-btns">' +
      '<button data-a="zout" title="zoom out (Ctrl+wheel)">&minus;</button><button data-a="z1" title="1:1">100%</button><button data-a="zin" title="zoom in">+</button>' +
      (body.save ? '<button data-a="save"></button>' : '') + '<button data-a="pin" title="pin: stays open">pin</button><button data-a="close" title="close (Esc)">&times;</button></span></div>' +
      '<div class="ix-body"><div class="ix-zoom ix-sel"></div></div><div class="ix-extra"></div><div class="ix-meta"></div>';
    card.querySelector('.ix-kind').textContent = h.kind;
    card.querySelector('.ix-name').textContent = c.name;
    if (body.save) card.querySelector('[data-a="save"]').textContent = body.save.label;
    const zoomEl = card.querySelector('.ix-zoom'), bodyEl = card.querySelector('.ix-body');
    zoomEl.appendChild(body.node);
    if (body.bg) bodyEl.style.background = body.bg;
    else if (h.kind === 'dancer') bodyEl.style.background = 'repeating-conic-gradient(#2a2d33 0 25%, #22252a 0 50%) 0 0/16px 16px';
    else if (h.kind === 'image' || h.kind === 'video') bodyEl.style.background = '#0b0c0e';
    for (const x of body.extra) card.querySelector('.ix-extra').appendChild(x);
    card.querySelector('.ix-meta').innerHTML = metaFor(h, t);
    Object.assign(c, { card, zoomEl, bodyEl, body });
    cardsEl.appendChild(card);

    // geometry: start a little larger than on screen, inside the window
    const vw = innerWidth, vh = innerHeight, nat = body.nat;
    const k0 = from.w / Math.max(1, nat.w);
    let z = Math.max(0.25, k0 * (h.kind === 'text' ? 1.35 : 1.15));
    const chrome = card.querySelector('.ix-head').offsetHeight + card.querySelector('.ix-extra').offsetHeight + card.querySelector('.ix-meta').offsetHeight + 2;
    z = Math.min(z, (vw * 0.72 - 2) / nat.w, (vh * 0.78 - chrome) / nat.h, h.kind === 'image' || h.kind === 'video' ? 1.5 : 4);
    if (h.kind === 'text') z = Math.max(z, Math.min(1.2, (vw * 0.72) / nat.w));
    if (h.kind === 'dancer') z = Math.max(z, Math.min(vh * 0.55, 380) / nat.h);           // a figure reads at ~380 px tall
    if (h.kind === 'image' || h.kind === 'video') z = Math.max(z, Math.min(vw * 0.42, 520) / nat.w, 0.05);
    setZoom(c, z);
    const w = Math.max(220, Math.min(vw - 8, nat.w * z + 2 + (bodyEl.offsetWidth - bodyEl.clientWidth))), hh = Math.min(vh - 8, nat.h * z + chrome + 1);
    let x = from.x + from.w / 2 - w / 2, y = from.y + from.h / 2 - hh / 2;
    x = Math.max(4, Math.min(vw - w - 4, x)); y = Math.max(4, Math.min(vh - hh - 24, y));
    Object.assign(card.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: hh + 'px', zIndex: ++zTop });
    if (body.wait) body.wait.then((n) => { if (n && n.w) { c.body.nat = n; } });
    wire(c);
    if (!hinted) { hinted = true; pref.set('hinted', '1'); setHint(); }
    cards.push(c);
    return c;
  }
  function setZoom(c, z, ax, ay) {
    z = Math.max(0.05, Math.min(16, z));
    const b = c.bodyEl, old = c.z || 1;
    const px = ax === undefined ? 0 : ax + b.scrollLeft, py = ay === undefined ? 0 : ay + b.scrollTop;
    c.z = z; c.zoomEl.style.zoom = String(z);
    if (ax !== undefined) { b.scrollLeft = px * z / old - ax; b.scrollTop = py * z / old - ay; }
    const btn = c.card.querySelector('[data-a="z1"]'); if (btn) btn.textContent = Math.round(z * 100) + '%';
  }
  function wire(c) {
    const card = c.card;
    card.addEventListener('pointerdown', () => { card.style.zIndex = ++zTop; cards = cards.filter((x) => x !== c).concat(c); });
    card.querySelector('.ix-btns').addEventListener('click', (e) => {
      const a = e.target.closest('button') && e.target.closest('button').dataset.a; if (!a) return;
      if (a === 'close') closeCard(c);
      else if (a === 'pin') { c.pinned = !c.pinned; card.classList.toggle('ix-pinned', c.pinned); }
      else if (a === 'zin') setZoom(c, c.z * 1.25);
      else if (a === 'zout') setZoom(c, c.z / 1.25);
      else if (a === 'z1') setZoom(c, 1);
      else if (a === 'save') save(c, e.target);
    });
    // drag by the header
    const head = card.querySelector('.ix-head');
    head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      e.preventDefault(); head.setPointerCapture(e.pointerId);
      const sx = e.clientX - card.offsetLeft, sy = e.clientY - card.offsetTop;
      const mv = (ev) => { card.style.left = ev.clientX - sx + 'px'; card.style.top = Math.max(0, ev.clientY - sy) + 'px'; };
      const up = () => { head.removeEventListener('pointermove', mv); head.removeEventListener('pointerup', up); head.removeEventListener('pointercancel', up); };
      head.addEventListener('pointermove', mv); head.addEventListener('pointerup', up); head.addEventListener('pointercancel', up);
    });
    head.addEventListener('dblclick', (e) => { if (!e.target.closest('button')) { c.pinned = !c.pinned; card.classList.toggle('ix-pinned', c.pinned); } });
    c.bodyEl.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = c.bodyEl.getBoundingClientRect();
      setZoom(c, c.z * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
  }
  function save(c, btn) {
    const s = c.body.save;
    const flash = (txt) => { const o = btn.textContent; btn.textContent = txt; setTimeout(() => { btn.textContent = o; }, 900); };
    if (s.text) { const txt = window.getSelection().toString() || s.text(); (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(() => flash('copied'), () => flash('select + Ctrl+C')); return; }
    const a = document.createElement('a'); a.download = s.name || 'frame.png';
    if (s.canvas) { try { a.href = s.canvas.toDataURL('image/png'); } catch (e) { return flash('n/a'); } } else a.href = s.href;
    document.body.appendChild(a); a.click(); a.remove();
  }
  // a closed card simply disappears (no animation)
  function closeCard(c) {
    if (c.closing) return; c.closing = true;
    cards = cards.filter((x) => x !== c);
    for (const f of c.body.stop) try { f(); } catch (e) {}
    c.card.remove();
  }
  function closeAll(pinnedToo) { for (const c of [...cards]) if (pinnedToo || !c.pinned) closeCard(c); }

  // ------------------------------------------------------------------ test / scripting API
  window.IX = {
    ready: false,
    t: () => clock.t(), playing: () => clock.playing() || holding, holding: () => holding, paused: () => paused,
    lazy: () => (W && W.__hfLazy ? W.__hfLazy.stats() : null), audio: () => A, film: () => W,
    play: () => setMode(false), pause: () => setMode(true), back: () => btnLive.click(), modes: () => modeLog.slice(), closeAll: () => closeAll(true),
    seek: (t, asLive) => { if (asLive) { clock.seek(t); scrubbed = false; liveT = t; } else seekTo(t); },
    cards: () => cards.map((c) => ({ id: c.id, kind: c.h.kind, name: c.name, t: c.t, pinned: c.pinned, z: c.z, el: c.card })),
    aspect: () => aspect, setAspect, fit: () => ({ ...fit, vw: innerWidth, vh: innerHeight, cw: CW, ch: CH }),
    hud: () => ({ mode: hudMode, shown: !!hudShown, line: lineOn }), setHud: (m, line) => { if (HUDS.includes(m)) hudMode = m; if (line !== undefined) lineOn = !!line; },
    hitAt: (x, y, container) => { const h = hitWin(x, y, container); return h && { kind: h.kind, name: nameOf(h) }; },
    // a window point over a thing of this kind on screen now (grid scan), preferring the inside of its box
    probe(kind, o) {
      o = o || {}; let best = null;
      const step = o.step || 16;
      for (let fy = step / 2; fy < CH; fy += step) for (let fx = step / 2; fx < CW; fx += step) {
        const wx = fit.ox + fx * fit.s, wy = fit.oy + fy * fit.s;
        if (wx < 1 || wy < 1 || wx > innerWidth - 1 || wy > innerHeight - 1) continue; // cropped off in fill mode
        const top = document.elementFromPoint(wx, wy);
        if (top !== ov && top !== film) continue; // covered by a card or the HUD
        const h = hitFilm(fx, fy, o.container); if (!h || h.kind !== kind) continue;
        if (o.name && !o.name.test(nameOf(h))) continue;
        const r = h.el.getBoundingClientRect(), d = Math.min(fx - r.left, r.right - fx, fy - r.top, r.bottom - fy);
        if (!best || d > best.d) best = { d, fx, fy, name: nameOf(h) };
      }
      if (!best) return null;
      return { x: fit.ox + best.fx * fit.s, y: fit.oy + best.fy * fit.s, name: best.name };
    },
  };
})();
