// A pure-JavaScript, causal port of BeatNet's beat/downbeat network, plus a causal bar-pointer tracker that turns its
// activations into a beat grid. PROTOTYPE: not used by the director or the live analyser (see docs/internals/ml-roadmap.md).
//
// BeatNet (Heydari, Cwitkowitz and Duan, ISMIR 2021, https://github.com/mjhydri/BeatNet) is a CRNN: a log-filtered
// spectrogram and its positive difference (272 values, 50 frames a second) -> 1-D conv (2 x 10 taps) -> ReLU ->
// max-pool 2 -> dense 150 -> 2-layer LSTM (150 cells, one direction, so causal) -> dense 3 -> softmax
// [beat, downbeat, no beat]. The weights are CC BY 4.0 (attribution: see the .tlw file's meta.attribution); they are
// converted by scripts/ml/convert-beatnet.py.
//
// Our tracker is not BeatNet's particle filter: it is the forward pass (filtering only, no look-ahead) of a
// madmom-style bar-pointer HMM (Krebs, Böck and Widmer 2015) over 4/4 bars and 55-215 BPM. It is exact, deterministic
// and cheap (about 5,600 states).
import { readWeights } from "./weights.js";

// ---------------------------------------------------------------- a small complex FFT (in place, radix 2)
function fftC(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let b = n >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let size = 2; size <= n; size <<= 1) {
    const h = size >> 1, a = (inverse ? 2 : -2) * Math.PI / size, wr = Math.cos(a), wi = Math.sin(a);
    for (let s = 0; s < n; s += size) { let cr = 1, ci = 0;
      for (let q = 0; q < h; q++) { const x = s + q, y = x + h, tr = re[y] * cr - im[y] * ci, ti = re[y] * ci + im[y] * cr;
        re[y] = re[x] - tr; im[y] = im[x] - ti; re[x] += tr; im[x] += ti; const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr; } }
  }
}

/** Magnitudes of the first `bins` bins of an N-point DFT, any N (Bluestein's chirp-z with a power-of-two FFT). */
export function bluestein(N, bins) {
  let M = 1; while (M < 2 * N - 1) M <<= 1;
  const wr = new Float64Array(N), wi = new Float64Array(N);
  for (let n = 0; n < N; n++) { const a = Math.PI * ((n * n) % (2 * N)) / N; wr[n] = Math.cos(a); wi[n] = -Math.sin(a); }
  const Br = new Float64Array(M), Bi = new Float64Array(M);
  for (let n = 0; n < N; n++) { Br[n] = wr[n]; Bi[n] = -wi[n]; if (n) { Br[M - n] = wr[n]; Bi[M - n] = -wi[n]; } }
  fftC(Br, Bi);
  const ar = new Float64Array(M), ai = new Float64Array(M);
  return function mag(x, out) {
    ar.fill(0); ai.fill(0);
    for (let n = 0; n < N; n++) { ar[n] = x[n] * wr[n]; ai[n] = x[n] * wi[n]; }
    fftC(ar, ai);
    for (let k = 0; k < M; k++) { const r = ar[k] * Br[k] - ai[k] * Bi[k], i = ar[k] * Bi[k] + ai[k] * Br[k]; ar[k] = r; ai[k] = i; }
    fftC(ar, ai, true);
    for (let k = 0; k < bins; k++) out[k] = Math.hypot(ar[k], ai[k]) / M;
    return out;
  };
}

// ---------------------------------------------------------------- the network
export class BeatNet {
  /** @param {Uint8Array|ArrayBuffer} bytes a .tlw file from scripts/ml/convert-beatnet.py */
  constructor(bytes) {
    const { meta, t } = readWeights(bytes); this.meta = meta; this.W = t;
    this.sr = meta.sr; this.win = meta.win; this.hop = meta.hop; this.fps = meta.sr / meta.hop; this.bins = meta.fftBins; this.nb = meta.bands; this.H = meta.hidden;
    this.window = new Float32Array(this.win); for (let i = 0; i < this.win; i++) this.window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (this.win - 1)); // np.hanning
    this.dft = bluestein(this.win, this.bins);
    this.fr = new Float32Array(this.win); this.mag = new Float32Array(this.bins);
    this.fb = { start: t["fb.start"].data, len: t["fb.len"].data, w: t["fb.w"].data };
    this.nIn = 2 * this.nb; this.feat = new Float32Array(this.nIn); this.prevSpec = new Float32Array(this.nb);
    const L = this.nIn - 10 + 1; this.pooledN = 2 * (L >> 1); this.pooled = new Float32Array(this.pooledN); this.convL = L;
    this.z = new Float32Array(150); this.h = [new Float32Array(this.H), new Float32Array(this.H)]; this.c = [new Float32Array(this.H), new Float32Array(this.H)];
    this.g = new Float32Array(4 * this.H); this.out = new Float32Array(3);
    // the two LSTM biases are always added together: fold them
    for (const l of [0, 1]) { const a = t[`lstm.bias_ih_l${l}`].data, b = t[`lstm.bias_hh_l${l}`].data, s = new Float32Array(a.length); for (let i = 0; i < a.length; i++) s[i] = a[i] + b[i]; t[`lstm.bias_l${l}`] = { shape: [a.length], data: s }; }
    this.ring = new Float32Array(this.win); this.pos = 0; this.filled = 0; this.since = 0; this.frames = 0;
    this.reset();
  }
  reset() { this.h.forEach(a => a.fill(0)); this.c.forEach(a => a.fill(0)); this.prevSpec.fill(0); this.hasPrev = false; this.ring.fill(0); this.filled = 0; this.since = 0; this.frames = 0; }

  /** Features of the newest `win` samples (ring buffer) into this.feat. */
  features() {
    const { fr, window: w, ring, win, mag, fb, nb, feat, prevSpec } = this;
    for (let i = 0; i < win; i++) fr[i] = ring[(this.pos + i) % win] * w[i];
    this.dft(fr, mag);
    let o = 0;
    for (let b = 0; b < nb; b++) { const s = fb.start[b], n = fb.len[b]; let v = 0; for (let k = 0; k < n; k++) v += mag[s + k] * fb.w[o + k]; o += n;
      const lv = Math.log10(1 + v); feat[b] = lv; feat[nb + b] = this.hasPrev ? Math.max(0, lv - prevSpec[b]) : 0; prevSpec[b] = lv; }
    this.hasPrev = true; return feat;
  }

  /** One step of the network on a feature vector: softmax [beat, downbeat, none] into this.out. */
  step(f) {
    const W = this.W, cw = W["conv1.weight"].data, cb = W["conv1.bias"].data, L = this.convL, P = this.pooled, half = L >> 1;
    for (let ch = 0; ch < 2; ch++) { const k0 = ch * 10, b = cb[ch];
      for (let j = 0; j < half; j++) { let m = 0; // relu then max of two: max(0, a, b)
        for (let d = 0; d < 2; d++) { const p = 2 * j + d; let s = b; for (let k = 0; k < 10; k++) s += cw[k0 + k] * f[p + k]; if (s > m) m = s; }
        P[ch * half + j] = m; } }
    matvec(W["linear0.weight"].data, W["linear0.bias"].data, P, this.z, 150, this.pooledN);
    let x = this.z;
    for (let l = 0; l < 2; l++) {
      const H = this.H, g = this.g, h = this.h[l], c = this.c[l], wi = W[`lstm.weight_ih_l${l}`].data, wh = W[`lstm.weight_hh_l${l}`].data, bias = W[`lstm.bias_l${l}`].data, nx = x.length;
      for (let r = 0; r < 4 * H; r++) { let s = bias[r]; const oi = r * nx, oh = r * H; for (let k = 0; k < nx; k++) s += wi[oi + k] * x[k]; for (let k = 0; k < H; k++) s += wh[oh + k] * h[k]; g[r] = s; }
      for (let k = 0; k < H; k++) { const ig = sig(g[k]), fg = sig(g[H + k]), gg = Math.tanh(g[2 * H + k]), og = sig(g[3 * H + k]); c[k] = fg * c[k] + ig * gg; h[k] = og * Math.tanh(c[k]); }
      x = h;
    }
    const lw = W["linear.weight"].data, lb = W["linear.bias"].data, o = this.out; let mx = -Infinity;
    for (let r = 0; r < 3; r++) { let s = lb[r]; for (let k = 0; k < this.H; k++) s += lw[r * this.H + k] * x[k]; o[r] = s; if (s > mx) mx = s; }
    let sum = 0; for (let r = 0; r < 3; r++) { o[r] = Math.exp(o[r] - mx); sum += o[r]; } for (let r = 0; r < 3; r++) o[r] /= sum;
    return o;
  }

  /**
   * Feed mono samples at this.sr. Calls onFrame(act, frameTime) for each new 20 ms frame (frameTime: the centre of the
   * frame, seconds since the first sample).
   */
  push(x, onFrame) {
    for (let i = 0; i < x.length; i++) {
      this.ring[this.pos] = x[i]; this.pos = (this.pos + 1) % this.win; this.samples = (this.samples || 0) + 1;
      if (this.filled < this.win) this.filled++;
      if (++this.since >= this.hop && this.filled >= this.win) { this.since = 0; this.frames++;
        const a = this.step(this.features()); onFrame(a, (this.samples - this.win / 2) / this.sr); }
    }
  }
}
const sig = v => 1 / (1 + Math.exp(-v));
function matvec(w, b, x, out, rows, cols) { for (let r = 0; r < rows; r++) { let s = b[r]; const o = r * cols; for (let k = 0; k < cols; k++) s += w[o + k] * x[k]; out[r] = s; } }

// ---------------------------------------------------------------- causal bar-pointer tracker
/**
 * Forward filtering on a bar-pointer state space: state (tempo interval tau frames, position 0 .. 4 tau - 1 in the bar).
 * The first tau / lambda positions of beat 1 are downbeat states, of beats 2-4 beat states (madmom's observation model).
 * Tempo may change only at a beat boundary, with probability ~ exp(-lambdaT |tau'/tau - 1|).
 */
export class BarTracker {
  constructor(fps = 50, { minBpm = 55, maxBpm = 215, beats = 4, lambdaT = 100, obsLambda = 16, priorBpm = 120, priorOct = +(globalThis.process?.env?.ML_PRIOR ?? 0.6) } = {}) {
    this.fps = fps; this.beats = beats; this.obsLambda = obsLambda;
    const t0 = Math.floor(60 * fps / maxBpm), t1 = Math.ceil(60 * fps / minBpm); this.taus = []; for (let t = t0; t <= t1; t++) this.taus.push(t);
    this.off = []; let n = 0; for (const t of this.taus) { this.off.push(n); n += beats * t; } this.n = n;
    this.a = new Float64Array(n); this.b = new Float64Array(n); this.bound = new Float64Array(this.taus.length * beats);
    // a tempo prior (log-normal around priorBpm, priorOct octaves wide; 0 = none): in the start distribution and in
    // every tempo change, so a half- or double-tempo path costs a little more than the usual 90-150 BPM one
    const T = this.taus.length; this.prior = new Float64Array(T);
    for (let i = 0; i < T; i++) this.prior[i] = priorOct > 0 ? Math.exp(-0.5 * (Math.log2(60 * fps / this.taus[i] / priorBpm) / priorOct) ** 2) : 1;
    this.trans = new Float64Array(T * T);
    for (let i = 0; i < T; i++) { let s = 0; for (let j = 0; j < T; j++) { const p = Math.exp(-lambdaT * Math.abs(this.taus[j] / this.taus[i] - 1)) * this.prior[j]; this.trans[i * T + j] = p; s += p; } for (let j = 0; j < T; j++) this.trans[i * T + j] /= s; }
    this.reset();
    this.out = new Float64Array(T); // mass leaving each tempo at a beat boundary, per beat index
    this.best = { tau: 0, pos: 0, p: 0 };
  }
  reset() { let s = 0; for (let i = 0; i < this.taus.length; i++) for (let p = 0; p < this.beats * this.taus[i]; p++) s += (this.a[this.off[i] + p] = this.prior[i] / this.taus[i]); for (let k = 0; k < this.n; k++) this.a[k] /= s; }
  /** One frame: act = [beat, downbeat, none]. Returns {tau, pos, conf}: the most likely state (pos within the bar). */
  step(act) {
    const { taus, off, a, b, beats, trans, bound } = this, T = taus.length;
    b.fill(0);
    // move one position forward; mass at the end of a beat moves to the start of the next beat, at any tempo
    for (let i = 0; i < T; i++) { const tau = taus[i], o = off[i];
      for (let q = 0; q < beats; q++) { const end = o + q * tau + tau - 1; bound[i * beats + q] = a[end];
        for (let p = q * tau; p < q * tau + tau - 1; p++) b[o + p + 1] += a[o + p]; } }
    for (let i = 0; i < T; i++) for (let q = 0; q < beats; q++) { const m = bound[i * beats + q]; if (m < 1e-300) continue; const nq = (q + 1) % beats;
      for (let j = 0; j < T; j++) b[off[j] + nq * taus[j]] += m * trans[i * T + j]; }
    // observation
    const pb = Math.max(1e-6, act[0]), pd = Math.max(1e-6, act[1]), pn = Math.max(1e-6, act[2]) / (this.obsLambda - 1);
    let sum = 0, bi = 0, bv = -1;
    for (let i = 0; i < T; i++) { const tau = taus[i], o = off[i], w = Math.max(1, Math.floor(tau / this.obsLambda));
      for (let p = 0; p < beats * tau; p++) { const inBeat = p % tau < w, v = b[o + p] * (inBeat ? (p < tau ? pd : pb) : pn); a[o + p] = v; sum += v; } }
    for (let k = 0; k < this.n; k++) { a[k] /= sum; if (a[k] > bv) { bv = a[k]; bi = k; } }
    let ti = 0; while (ti + 1 < T && off[ti + 1] <= bi) ti++;
    // confidence: how much mass sits near the best tempo; and the tempo as the mass-weighted interval near it (the
    // intervals are whole frames: 23 and 24 frames are 130 and 125 BPM, so a 128 BPM song sits between them)
    let near = 0, wt = 0; for (let i = Math.max(0, ti - 2); i <= Math.min(T - 1, ti + 2); i++) { let m = 0; for (let p = 0; p < beats * taus[i]; p++) m += a[off[i] + p]; near += m; wt += m * taus[i]; }
    this.best = { tau: taus[ti], tauF: wt / near, pos: bi - off[ti], conf: near };
    return this.best;
  }
}

/**
 * Activations to a beat grid, causally: BeatNet + BarTracker, and a grid that keeps counting beats (idx) across small
 * phase corrections. grid(t) has the same shape as signals.js gridAt().
 */
export class MLBeat {
  /** @param {Uint8Array|ArrayBuffer} bytes */
  constructor(bytes, o = {}) { this.net = new BeatNet(bytes); this.tr = new BarTracker(this.net.fps, o); this.reset(); this.cpuMs = 0; }
  reset() { this.net.reset(); this.tr.reset(); this.has = false; this.idx0 = 0; this.last = 0; this.P = 0.5; this.bib0 = 0; this.conf = 0; this.acts = []; }
  get bpm() { return this.has ? 60 / this.P : 0; }
  push(x) {
    this.net.push(x, (act, ft) => {
      const s = this.tr.step(act), P = s.tauF / this.net.fps, inBeat = s.pos % s.tau, last = ft - inBeat / this.net.fps, bib = Math.floor(s.pos / s.tau);
      if (this.keepActs) this.acts.push([ft, act[0], act[1]]);
      if (ft < 1.5) return; // let the filter settle before showing a grid
      if (this.has) this.idx0 += Math.round((last - this.last) / this.P); else this.idx0 = 0;
      this.has = true; this.last = last; this.P = P; this.bib0 = bib; this.conf = s.conf;
    });
  }
  grid(t) {
    if (!this.has) return { has: false, P: 0.5, phase: 0, idx: 0, beatInBar: 0, env: 0, barPhase: 0, beatT: -9 };
    const P = this.P, x = (t - this.last) / P, k = Math.floor(x), ph = x - k, bib = (((this.bib0 + k) % 4) + 4) % 4;
    return { has: true, P, phase: ph, idx: this.idx0 + k, beatInBar: bib, env: Math.exp(-ph * P / 0.18), barPhase: (bib + ph) / 4, beatT: this.last + k * P };
  }
}
