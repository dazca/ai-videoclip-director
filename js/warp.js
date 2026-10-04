// The warp: one monotone piecewise-linear map y(t) shared by every column (report 18, section 2).
// anchors: sorted unique integer ms; Y: px knot per anchor. Constraints {t0, t1, h}: y(t1) >= y(t0) + h.
// Forward pass (longest path over the anchor DAG): Y[k] = max(Y[k-1] + floor*dt, max over constraints ending at k of Y[a] + h).

export function lowerBound(arr, x) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; } return lo; }
export function upperBound(arr, x) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= x) lo = m + 1; else hi = m; } return lo; }

// folds [{t0, t1}]: ranges drawn at FOLD_PPS (a collapsed section); their constraints are dropped by the caller.
const FOLD_PPS = 0.6;
export function buildWarp({ duration, pxPerSec, anchorTimes, constraints, linear = false, folds = [] }) {
  const set = new Set([0, duration]);
  for (const t of anchorTimes) if (t >= 0 && t <= duration) set.add(Math.round(t));
  if (!linear) for (const c of constraints) { set.add(Math.round(c.t0)); set.add(Math.min(duration, Math.round(c.t1))); }
  for (const f of folds) { set.add(Math.round(f.t0)); set.add(Math.round(f.t1)); }
  const A = Float64Array.from([...set].sort((a, b) => a - b));
  const n = A.length;
  const Y = new Float64Array(n);
  const floor = pxPerSec / 1000;
  const rate = folds.length ? (k) => folds.some(f => A[k - 1] >= f.t0 && A[k] <= f.t1) ? Math.min(floor, FOLD_PPS / 1000) : floor : () => floor;
  if (linear) { for (let k = 1; k < n; k++) Y[k] = Y[k - 1] + rate(k) * (A[k] - A[k - 1]); return makeMap(A, Y, floor); }
  // need[k] = list of (a, h) pairs ending at anchor k, stored flat
  const head = new Int32Array(n).fill(-1), nextC = [], ca = [], ch = [];
  for (const c of constraints) {
    const a = lowerBound(A, Math.round(c.t0)), b = lowerBound(A, Math.min(duration, Math.round(c.t1)));
    if (b <= a) continue;
    ca.push(a); ch.push(c.h); nextC.push(head[b]); head[b] = ca.length - 1;
  }
  for (let k = 1; k < n; k++) {
    let y = Y[k - 1] + rate(k) * (A[k] - A[k - 1]);
    for (let i = head[k]; i >= 0; i = nextC[i]) { const v = Y[ca[i]] + ch[i]; if (v > y) y = v; }
    Y[k] = y;
  }
  return makeMap(A, Y, floor);
}

function makeMap(A, Y, floor) {
  const n = A.length;
  const y = (t) => {
    if (t <= A[0]) return Y[0];
    if (t >= A[n - 1]) return Y[n - 1];
    const k = upperBound(A, t) - 1;
    return Y[k] + (t - A[k]) * (Y[k + 1] - Y[k]) / (A[k + 1] - A[k]);
  };
  // inverse, exact to the ms: binary search on Y then one division
  const t = (yy) => {
    if (yy <= Y[0]) return A[0];
    if (yy >= Y[n - 1]) return A[n - 1];
    const k = upperBound(Y, yy) - 1;
    const dy = Y[k + 1] - Y[k];
    return dy > 0 ? A[k] + (yy - Y[k]) * (A[k + 1] - A[k]) / dy : A[k];
  };
  // local stretch (px per second) at time t, relative to the floor
  const stretch = (tt) => {
    const k = Math.min(n - 2, Math.max(0, upperBound(A, tt) - 1));
    return ((Y[k + 1] - Y[k]) / (A[k + 1] - A[k])) / floor;
  };
  return { A, Y, total: Y[n - 1], y, t, stretch, floor };
}
