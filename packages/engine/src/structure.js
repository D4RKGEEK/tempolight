// Song structure from a bar-by-bar description: sections (intro, verse, chorus... as repeat labels A, B, A, C) and the
// phrase grid. Pure JavaScript, no I/O; used by the whole-song analysis (analysis.js).
//
// Each bar becomes a small feature vector: which notes sound (12 chroma values, scaled to length 1), how loud it is
// (log), and how many kicks, snares and hi-hats it has. Every bar is compared with every other (a self-similarity
// matrix). Where one section ends and another starts, the bars before are alike, the bars after are alike, and the two
// groups differ: a checkerboard kernel slid along the diagonal (Foote novelty) peaks there. Kernels 2 and 4 bars wide
// are added, so both short (a 2-bar break) and long changes count. Peaks above 30% of the highest are boundaries;
// a boundary one bar off the phrase grid moves onto it when the grid bar is nearly as novel. Sections are then
// compared with the ones before them, bar by bar along the diagonal: one that matches an earlier section gets its
// label (a chorus that comes back is "B" again).

const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));

/**
 * @param {{v:Float64Array|number[]}[]} feats one feature vector per bar (see barFeature())
 * @param {string[]} [states] each bar's part ("calm", "build", "drop", "silent"), for each section's main part
 * @returns {{sections:{bar0:number, bar1:number, label:string, state:string|null}[], phrase:{len:number, first:number}, novelty:Float32Array}}
 */
export function sectionsOf(feats, states = []) {
  const n = feats.length;
  if (n < 4) return { sections: n ? [{ bar0: 0, bar1: n, label: "A", state: mainState(states, 0, n) }] : [], phrase: { len: 8, first: 0 }, novelty: new Float32Array(n) };
  // self-similarity: Gaussian of the distance between bar features
  const M = new Float32Array(n * n);
  for (let i = 0; i < n; i++) for (let j = i; j < n; j++) { const a = feats[i].v, b = feats[j].v; let d = 0; for (let k = 0; k < a.length; k++) d += (a[k] - b[k]) ** 2; M[i * n + j] = M[j * n + i] = Math.exp(-d / 0.5); }
  const nov = w => { const out = new Float32Array(n); for (let i = 0; i < n; i++) { let s = 0, c = 0;
    for (let a = -w; a < w; a++) for (let b = -w; b < w; b++) { const p = i + a, q = i + b; if (p < 0 || q < 0 || p >= n || q >= n) continue; s += ((a < 0) === (b < 0) ? 1 : -1) * M[p * n + q]; c++; }
    out[i] = c ? s / c : 0; } return out; };
  const n2 = nov(2), n4 = nov(4), N = new Float32Array(n); let top = 0;
  for (let i = 0; i < n; i++) { N[i] = Math.max(0, n2[i] + n4[i]); if (N[i] > top) top = N[i]; }
  let peaks = []; const thr = top * 0.3;
  if (top > 1e-6) for (let i = 1; i < n - 1; i++) if (N[i] > thr && N[i] >= N[i - 1] && N[i] > N[i + 1]) peaks.push(i);
  // phrase grid: the offset (0..7) that puts the most novelty on multiples of 8 bars, and 16 when the boundaries keep to that too
  let first = 0, bestOn = -1;
  for (let o = 0; o < 8; o++) { let s = 0; for (let i = o; i < n; i += 8) s += N[i]; for (let i = o + 4; i < n; i += 8) s += 0.5 * N[i]; if (s > bestOn + 1e-9) { bestOn = s; first = o; } }
  const on = (p, L) => ((p - first) % L + L) % L === 0;
  const len = n >= 48 && peaks.length >= 2 && peaks.filter(p => on(p, 16)).length >= peaks.filter(p => on(p, 8)).length * 0.75 ? 16 : 8;
  // a boundary a bar off the 4-bar grid moves onto it, when the grid bar is nearly as novel
  peaks = peaks.map(p => { if (on(p, 4)) return p; for (const q of [p - 1, p + 1]) if (q > 0 && q < n && on(q, 4) && N[q] >= N[p] * 0.7) return q; return p; });
  peaks = [...new Set(peaks)].sort((a, b) => a - b).filter((p, i, a) => i === 0 || p - a[i - 1] >= 2);
  // sections between boundaries; labels by similarity with the sections before (along the diagonal)
  const cuts = [0, ...peaks, n], segs = [];
  for (let i = 0; i + 1 < cuts.length; i++) segs.push([cuts[i], cuts[i + 1]]);
  const sim = (s, u) => { const L = Math.min(s[1] - s[0], u[1] - u[0]); let a = 0; for (let k = 0; k < L; k++) a += M[(s[0] + k) * n + u[0] + k]; return L ? a / L : 0; };
  const labels = []; let next = 0;
  for (let i = 0; i < segs.length; i++) { let best = -1, bs = 0; for (let j = 0; j < i; j++) { const v = sim(segs[i], segs[j]); if (v > bs) { bs = v; best = j; } }
    labels.push(bs > 0.6 ? labels[best] : label(next++)); }
  return { sections: segs.map((s, i) => ({ bar0: s[0], bar1: s[1], label: labels[i], state: mainState(states, s[0], s[1]) })), phrase: { len, first }, novelty: N };
}
const label = i => i < 26 ? String.fromCharCode(65 + i) : "Z" + (i - 25);
function mainState(states, a, b) { const c = {}; let best = null; for (let i = a; i < b; i++) { const s = states[i]; if (!s) continue; c[s] = (c[s] || 0) + 1; if (!best || c[s] > c[best]) best = s; } return best; }

/**
 * One bar's feature vector for sectionsOf().
 * @param {ArrayLike<number>} chroma 12 values (any scale) @param {number} energy the bar's mean loudness (0..1-ish)
 * @param {number} kicks @param {number} snares @param {number} hats counts in the bar
 */
export function barFeature(chroma, energy, kicks, snares, hats) {
  const v = new Float64Array(16); let s = 0; for (let k = 0; k < 12; k++) { v[k] = chroma[k] || 0; s += v[k] * v[k]; } s = Math.sqrt(s) || 1; for (let k = 0; k < 12; k++) v[k] /= s;
  v[12] = Math.log10(Math.max(0, energy) + 1e-3) * 1.5; v[13] = clamp(kicks / 4, 0, 2); v[14] = clamp(snares / 8, 0, 2); v[15] = clamp(hats / 8, 0, 2);
  return { v };
}
