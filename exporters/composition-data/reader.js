/* reader.js · Director Workbench composition data reader (edl.json, format director-workbench/composition-edl v1).
 * Drop-in, dependency-free, ES5. A HyperFrames composition includes it before its own scripts:
 *     <script src="wb/reader.js"></script>
 *     <script>var EDL = WB_EDL.load("wb/edl.json");</script>     (a synchronous read at build time, like world.js's HEAD checks)
 * or hands it a parsed document: WB_EDL.from(doc). In Node: require("./reader.js").
 *
 * Every lookup is a pure function of (the document, the song time t), so a frame renders the same every time:
 *   EDL.at(t)            the shot under song time t (ms; t0 <= t < t1) resolved at t, or null between shots
 *   EDL.shot(id, t?)     shot `id` resolved at t (default its t0)
 *   EDL.use(useId, t?)   the shot covering a clip use ("G05@20158": clip id @ use start in ms) resolved at t
 *   EDL.atSeconds(s)     at(s * 1000), for compositions that count in seconds
 *   EDL.shotAt(t)        the raw shot row (no resolution)
 *   EDL.song             the song's timing anchors (duration_ms, bpm, beat_ms, bar_ms, first_beat_ms, sections, lines)
 *   EDL.chapters         the chapters with their derived build status (planned | generating | built | approved), E3
 * A resolution: {shot, t0, t1, inside, status: "picked" | "placeholder", file (relative to the composition, or null),
 *   kind: "video" | "image" | null, take, request, in_ms, out_ms, media_ms, media_s (the take's time to show at t:
 *   in_ms + (t - t0), clamped to [in_ms, out_ms); a still: 0), placeholder {reason: unpicked | private | missing |
 *   unmapped, label, id, kind, time, text, cast, world, svg} | null, placeholder_src (E5: the placeholder frame as a data:
 *   URI for <img src>, or null), world (E6: the shot's world, or null), looks {character: look id | null}, variants
 *   {location / prop: variant id | null}, alt []}.
 * Docs: docs/COMPOSITION_ROUNDTRIP.md in the Director Workbench. */
(function (root) {
  "use strict";
  var FORMAT = "director-workbench/composition-edl", VERSION = 1;

  function from(doc) {
    if (!doc || typeof doc !== "object" || doc.format !== FORMAT) throw new Error("WB_EDL: not a " + FORMAT + " document");
    if (doc.version !== VERSION) throw new Error("WB_EDL: edl.json version " + doc.version + "; this reader reads version " + VERSION);
    var shots = (doc.shots || []).slice().sort(function (a, b) { return a.t0 - b.t0 || a.t1 - b.t1; });
    var byId = {}, byUse = {}, i, j;
    for (i = 0; i < shots.length; i++) {
      byId[shots[i].id] = shots[i];
      for (j = 0; j < (shots[i].uses || []).length; j++) byUse[shots[i].uses[j]] = shots[i];
    }
    // the last shot starting at or before t that still covers it (binary search on t0)
    function shotAt(t) {
      var lo = 0, hi = shots.length - 1, k = -1;
      while (lo <= hi) { var m = (lo + hi) >> 1; if (shots[m].t0 <= t) { k = m; lo = m + 1; } else hi = m - 1; }
      for (; k >= 0; k--) if (t < shots[k].t1) return shots[k];
      return null;
    }
    function resolve(s, t) {
      if (!s) return null;
      var tt = t == null ? s.t0 : Number(t), k = s.take || null;
      var r = { shot: s.id, t0: s.t0, t1: s.t1, inside: tt >= s.t0 && tt < s.t1, status: s.status, file: null, kind: null, take: null, request: null,
        in_ms: null, out_ms: null, media_ms: null, media_s: null, placeholder: s.placeholder || null, looks: s.looks || {}, variants: s.variants || {}, alt: s.alt || [],
        placeholder_src: s.placeholder && s.placeholder.svg ? "data:image/svg+xml;charset=utf-8," + encodeURIComponent(s.placeholder.svg) : null, world: s.world || null };
      if (s.status !== "picked" || !k) return r;
      // review #3 I4: a file outside the composition (absolute, a drive, a scheme, "..") is never handed out: a placeholder
      if (typeof k.file !== "string" || /^([a-z][a-z0-9+.-]*:|[\/\\])/i.test(k.file) || k.file.split(/[\/\\]/).indexOf("..") >= 0) { r.status = "placeholder"; r.placeholder = r.placeholder || { reason: "unsafe" }; return r; }
      r.file = k.file; r.kind = k.kind; r.take = k.take; r.request = k.request; r.in_ms = k.in_ms; r.out_ms = k.out_ms;
      if (k.kind === "video") {
        var m = k.in_ms + (tt - s.t0), top = k.out_ms == null ? Infinity : k.out_ms - 1;
        r.media_ms = Math.max(k.in_ms, Math.min(top, m));
      } else r.media_ms = 0;
      r.media_s = r.media_ms / 1000;
      return r;
    }
    return {
      doc: doc, version: doc.version, checksum: doc.checksum || null, project: doc.project, song: doc.song || null, shots: shots, chapters: doc.chapters || [],
      shotAt: shotAt,
      at: function (t) { return resolve(shotAt(Number(t)), t); },
      atSeconds: function (s) { var t = Number(s) * 1000; return resolve(shotAt(t), t); },
      shot: function (id, t) { return resolve(byId[id] || null, t); },
      use: function (useId, t) { return resolve(byUse[useId] || null, t); }
    };
  }
  // a synchronous read (build time; HyperFrames serves the composition folder over http)
  function load(url) {
    var x = new XMLHttpRequest();
    x.open("GET", url, false); x.send(null);
    if (!(x.status === 200 || (x.status === 0 && x.responseText))) throw new Error("WB_EDL: cannot read " + url + " (HTTP " + x.status + ")");
    return from(JSON.parse(x.responseText));
  }
  var api = { FORMAT: FORMAT, VERSION: VERSION, from: from, load: load };
  if (typeof module === "object" && module.exports) module.exports = api; else root.WB_EDL = api;
})(typeof window !== "undefined" ? window : this);
