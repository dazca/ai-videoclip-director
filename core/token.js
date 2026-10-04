// The per-run write token: serve.mjs puts it in <meta name="wb-token"> of index.html / dock.html and loads this file
// right after it (a classic script, so it runs before the page's modules). Every non-GET fetch to /api/ carries it in
// x-wb-token. A file, not an inline script, so the Content-Security-Policy can forbid inline scripts.
(() => {
  const t = document.querySelector('meta[name="wb-token"]')?.content || '';
  window.__WB_TOKEN__ = t;
  const f = window.fetch.bind(window);
  window.fetch = (u, o) => {
    if (typeof u === 'string' && u.startsWith('/api/') && o && o.method && o.method.toUpperCase() !== 'GET') {
      const h = new Headers(o.headers || {}); h.set('x-wb-token', t); o = { ...o, headers: h };
    }
    return f(u, o);
  };
})();
