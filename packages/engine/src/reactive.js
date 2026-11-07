// The reactive front end: what the lights can follow from the first second of any music, before (or without) a beat
// grid. LedFx's approach: a mel filterbank, each band's level against its own recent peak (gain that decays slowly),
// a fast-rise slower-fall filter, plus an onset strength per band and immediate hits from the onsets (no waiting for
// a beat grid or a confirmed kick). Pure JavaScript, no I/O, nothing allocated per hop.
//   ReactiveTap   fed the magnitude spectrum of every hop by LiveAnalyser (no extra FFT)
//   songReact()   the same fields made up from a whole-song analysis (no audio: its kicks, snares, hats, loudness)
// Both give the view's mel (0-1 per band), melOnset (0-1 per band), energy (0-1) and react: {kick, snare, hat, beat
// (hit times), kickS, beatS (how hard, 0-1), kickN, beatN (counts), P (the time between beats), centroid (0 dark -
// 1 bright), low, mid, high (0-1), onset (0-1, all bands, decaying)}.

export const MEL_N = 32;
const LOW_HZ = 150, MID_HZ = 2000;

export class ReactiveTap {
  /** @param {number} sr sample rate of the spectrum @param {number} nf FFT length (mag has nf/2 bins) */
  constructor(sr, nf, nb = MEL_N) {
    this.nb = nb; const binHz = sr / nf, fMax = Math.min(11000, sr / 2 * 0.95), mel = f => 2595 * Math.log10(1 + f / 700), hz = m => 700 * (10 ** (m / 2595) - 1);
    const m0 = mel(30), m1 = mel(fMax), e = []; for (let i = 0; i <= nb + 1; i++) e.push(hz(m0 + (m1 - m0) * i / (nb + 1)) / binHz);
    // triangular filters, each at least 2 bins wide (the lowest bands are narrower than a bin): {start bin, weights}
    this.f0 = new Int16Array(nb); this.fs = new Float32Array(nb); this.fw = []; this.cHz = new Float32Array(nb);
    for (let b = 0; b < nb; b++) { let lo = e[b], c = e[b + 1], hi = e[b + 2]; if (hi - lo < 2) { lo = c - 1; hi = c + 1; }
      const a = Math.max(1, Math.floor(lo)), z = Math.min(nf / 2 - 1, Math.ceil(hi)), w = new Float32Array(z - a + 1); let s = 0;
      for (let k = a; k <= z; k++) { const v = k < c ? (k - lo) / Math.max(1e-6, c - lo) : (hi - k) / Math.max(1e-6, hi - c); w[k - a] = Math.max(0, v); s += w[k - a]; }
      for (let k = 0; k < w.length; k++) w[k] /= s || 1; this.fs[b] = s; this.f0[b] = a; this.fw.push(w); this.cHz[b] = c * binHz; }
    this.g = new Uint8Array(nb); for (let b = 0; b < nb; b++) this.g[b] = this.cHz[b] < LOW_HZ ? 0 : this.cHz[b] < MID_HZ ? 1 : 2;
    this.gN = [0, 0, 0]; for (let b = 0; b < nb; b++) this.gN[this.g[b]]++;
    this.raw = new Float32Array(nb); this.peak = new Float32Array(nb); this.mel = new Float32Array(nb); this.melOnset = new Float32Array(nb);
    this.lg = [new Float32Array(nb), new Float32Array(nb), new Float32Array(nb)]; this.oPeak = new Float32Array(nb);
    this.kickTs = new Float32Array(16); this.ps = new Float32Array(nb); this.reset();
  }
  reset() {
    this.peak.fill(0); this.mel.fill(0); this.melOnset.fill(0); this.oPeak.fill(0); for (const a of this.lg) a.fill(0); this.G = 0; this.n = 0;
    this.eMax = 1e-4; this.energy = 0; this.pG = 1e-9; this.level = 0; this.lv0 = 0; this.lPk = 0.02; this.ps.fill(0); this.centroid = 0.4; this.lvl = [0, 0, 0]; this.onset = 0;
    this.grp = [0, 0, 0]; this.bg = [0, 0, 0]; this.top = [0, 0, 0]; this.armed = [true, true, true]; this.hitAt = [0, 0, 0]; this.lastHit = [-9, -9, -9]; this.hitS = [1, 1, 1];
    this.beat = -9; this.beatS = 1; this.beatN = 0; this.kickN = 0; this.kickTs.fill(-9); this.kickI = 0; this.P = 0.5;
  }

  /**
   * One hop. @param {Float32Array} mag magnitudes @param {number} t the hop's time @param {number} dt seconds a hop
   * @param {boolean} loud loud enough to be music (quieter: levels fall, no hits)
   */
  hop(mag, t, dt, loud = true) {
    const { nb, raw, peak, mel, melOnset, g } = this, lg2 = this.lg[2]; this.lg[2] = this.lg[1]; this.lg[1] = this.lg[0]; this.lg[0] = lg2; const cur = lg2, ref = this.lg[2];
    const pd = Math.pow(0.5, dt / 4), gd = Math.pow(0.5, dt / 6), od = Math.pow(0.5, dt / 3);
    let top = 0, sum = 0;
    for (let b = 0; b < nb; b++) { const w = this.fw[b], a0 = this.f0[b]; let s = 0; for (let k = 0; k < w.length; k++) { const m = mag[a0 + k]; s += w[k] * m * m; } raw[b] = Math.sqrt(s); if (raw[b] > top) top = raw[b]; sum += raw[b]; }
    // gain: each band against its own peak (falls by half in 4 s), never more than 4x the loudest band's (6 s): a band
    // that only has noise isn't blown up to full
    this.G = Math.max(this.G * gd, top, 2e-5);
    const floor = Math.max(0.25 * this.G, 2e-5), rise = 0.85, fall = 1 - Math.exp(-dt / 0.08);
    let cs = 0, cw = 0; const lv = [0, 0, 0], go = [0, 0, 0];
    for (let b = 0; b < nb; b++) {
      peak[b] = Math.max(peak[b] * pd, raw[b]); const nv = loud ? Math.min(1, raw[b] / Math.max(peak[b], floor)) : 0;
      mel[b] += (nv - mel[b]) * (nv > mel[b] ? rise : fall); lv[g[b]] += mel[b]; cs += b * mel[b]; cw += mel[b];
      // onset: the rise of the band's log level against the loudest of it and its neighbours two hops ago (a slide or
      // vibrato moves between neighbours: no onset), against the band's recent biggest rise
      cur[b] = Math.log1p(raw[b] / Math.max(0.02 * this.G, 1e-6));
      let r = ref[b]; if (b > 0 && ref[b - 1] > r) r = ref[b - 1]; if (b < nb - 1 && ref[b + 1] > r) r = ref[b + 1];
      const d = loud && this.n > 2 ? Math.max(0, cur[b] - r) : 0; this.oPeak[b] = Math.max(this.oPeak[b] * od, d, 0.3);
      const on = Math.min(1, d / this.oPeak[b]); melOnset[b] = on > melOnset[b] ? on : melOnset[b] * Math.exp(-dt / 0.08); go[g[b]] += d;
    }
    this.n++;
    for (let k = 0; k < 3; k++) { lv[k] /= this.gN[k] || 1; go[k] /= this.gN[k] || 1; this.lvl[k] = lv[k]; }
    // level: LedFx's own brightness (its Energy effect): each band's power against one gain for all bands (the loudest
    // band's, falling over ~1.6 s, so the kick leads), smoothed fast up and ~75 ms down, three thirds of the bands
    // averaged and pushed (x1.5, at most 1), then their mean, ~50 ms down
    let top2 = 0; for (let b = 0; b < nb; b++) { const q = raw[b] * raw[b] * this.fs[b]; if (q > top2) top2 = q; } const gk = 1 - Math.pow(0.99, dt * 60); this.pG += (top2 - this.pG) * (top2 > this.pG ? 0.99 : gk); const pg = Math.max(this.pG, 1e-10), sd = 1 - Math.pow(0.8, dt * 60);
    let l3 = 0; for (let k = 0; k < 3; k++) { const a = Math.floor(nb * [0, 0.25, 0.62][k]), z = Math.floor(nb * [0.25, 0.62, 1][k]); let q = 0;
      for (let b = a; b < z; b++) { const v = loud ? Math.min(1, raw[b] * raw[b] * this.fs[b] / pg) : 0; this.ps[b] += (v - this.ps[b]) * (v > this.ps[b] ? 0.99 : sd); q += this.ps[b]; }
      l3 += Math.min(1, q / (z - a) * 1.5); }
    l3 /= 3; this.lv0 += (l3 - this.lv0) * (l3 > this.lv0 ? 0.99 : 1 - Math.pow(0.7, dt * 60));
    this.lPk = Math.max(this.lPk * Math.pow(0.5, dt / 4), this.lv0, 0.02); this.level = this.lv0 / this.lPk; // (against its own recent peak)
    this.eMax = Math.max(this.eMax * Math.pow(0.5, dt / 8), sum, 1e-4);
    const en = loud ? Math.min(1, sum / this.eMax) : 0; this.energy += (en - this.energy) * (en > this.energy ? 0.5 : 1 - Math.exp(-dt / 0.3));
    if (cw > 0.05) this.centroid += (cs / cw / (nb - 1) - this.centroid) * (1 - Math.exp(-dt / 0.25));
    // hits per group: the group's onset well above its background (a follower that falls fast and rises slowly), and
    // near its recent strongest hits; fired on the first hop above (no waiting for the peak), re-armed at half of it
    const refr = [0.11, 0.09, 0.06];
    let any = 0;
    for (let k = 0; k < 3; k++) {
      const o = go[k], bg = this.bg[k]; this.top[k] = Math.max(this.top[k] * Math.pow(0.5, dt / 4), 0.05);
      const fire = loud && this.armed[k] && o > 2.5 * bg + 0.04 && o > 0.3 * this.top[k] && t - this.lastHit[k] > refr[k] && (k > 0 || this.lvl[0] > 0.2);
      if (fire) { this.armed[k] = false; this.lastHit[k] = t; this.hitS[k] = Math.min(1, o / Math.max(1e-6, this.top[k])); this.hitAt[k] = o; }
      else if (!this.armed[k] && o < 0.5 * this.hitAt[k]) this.armed[k] = true;
      if (!this.armed[k] && o > this.hitAt[k]) this.hitAt[k] = o;
      if (o > this.top[k]) this.top[k] = o;
      this.bg[k] += (o - bg) * (o < bg ? 0.25 : 0.015);
      any += o * (k === 0 ? 1 : k === 1 ? 0.8 : 0.45);
    }
    this.onset = Math.max(this.onset * Math.exp(-dt / 0.1), Math.min(1, any / Math.max(0.15, (this.top[0] + 0.8 * this.top[1] + 0.45 * this.top[2]) * 0.6)));
    // a beat: a low hit; while no low hits come (tabla's right hand, a vocal with claps), a mid hit
    const kickNow = this.lastHit[0] === t, midNow = this.lastHit[1] === t && t - this.lastHit[0] > 1.2;
    if (kickNow) { this.kickN++; this.kickTs[this.kickI] = t; this.kickI = (this.kickI + 1) & 15; }
    if ((kickNow || midNow) && t - this.beat > 0.12) { this.beat = t; this.beatS = Math.max(0.3, kickNow ? this.hitS[0] : this.hitS[1]); this.beatN++; this.tempo(); }
  }
  // the time between beats: the median gap between the recent low hits that look like beats (0.27-1.2 s), halved or
  // doubled into 0.35-0.8 s
  tempo() {
    const ts = Array.from(this.kickTs).filter(x => x > -9).sort((a, b) => a - b), gaps = [];
    for (let i = 1; i < ts.length; i++) { let d = ts[i] - ts[i - 1]; if (d < 0.2 || d > 1.6) continue; while (d < 0.35) d *= 2; while (d > 0.8) d /= 2; gaps.push(d); }
    if (gaps.length >= 3) { gaps.sort((a, b) => a - b); this.P += (gaps[gaps.length >> 1] - this.P) * 0.5; }
  }
  /** The view's reactive fields at time t (arrays are shared, read them before the next hop). */
  view() {
    const [kick, snare, hat] = this.lastHit;
    return { mel: this.mel, melOnset: this.melOnset, energy: this.energy,
      react: { kick, snare, hat, kickS: this.hitS[0], kickN: this.kickN, beat: this.beat, beatS: this.beatS, beatN: this.beatN, P: this.P,
        centroid: this.centroid, low: this.lvl[0], mid: this.lvl[1], high: this.lvl[2], onset: this.onset, level: this.level } };
  }
}

// ---------------------------------------------------------------- whole-song: the same fields from an analysis
const songCache = new WeakMap();
const lastLE = (a, t) => { let lo = 0, hi = a.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (a[m] <= t) { r = m; lo = m + 1; } else hi = m - 1; } return r; };
/** mel, melOnset, energy and react at time t from a whole-song analysis (its kicks, snares, hats and loudness). */
export function songReact(pre, t) {
  let c = songCache.get(pre);
  if (!c) { const env = pre.env || [], s = Array.from(env).filter(v => v > 0.01).sort((a, b) => a - b); c = { ref: s.length ? s[Math.floor(s.length * 0.95)] || 1 : 1, mel: new Float32Array(MEL_N), on: new Float32Array(MEL_N) }; songCache.set(pre, c); }
  const env = pre.env || [], j = Math.max(0, Math.min(env.length - 1, Math.round(t / 0.02))), en = env.length ? Math.min(1, (env[j] || 0) / c.ref) : 0;
  const ks = pre.kicks || [], ss = pre.snares || [], hs = pre.hats || [], ki = lastLE(ks, t), si = lastLE(ss, t), hi = lastLE(hs, t);
  const kick = ki >= 0 ? ks[ki] : -9, snare = si >= 0 ? ss[si] : -9, hat = hi >= 0 ? hs[hi] : -9;
  const ke = Math.exp(-(t - kick) / 0.15), se = Math.exp(-(t - snare) / 0.12), he = Math.exp(-(t - hat) / 0.08);
  const low = Math.min(1, en * (0.45 + 0.55 * ke)), mid = Math.min(1, en * (0.5 + 0.4 * se)), high = Math.min(1, en * (0.3 + 0.6 * he));
  for (let b = 0; b < MEL_N; b++) { const u = b / (MEL_N - 1), lo = Math.max(0, 1 - u * 4), hiW = Math.max(0, u * 1.6 - 0.6), mi = Math.max(0, 1 - lo - hiW);
    c.mel[b] = lo * low + mi * mid + hiW * high; c.on[b] = lo * ke + mi * se * 0.8 + hiW * he * 0.6; }
  const beat = kick > -9 ? kick : snare;
  return { mel: c.mel, melOnset: c.on, energy: en, react: { kick, snare, hat, kickS: 1, kickN: ki + 1, beat, beatS: 1, beatN: ki + 1, P: pre.P || 0.5,
    centroid: Math.min(1, 0.25 + 0.5 * (high + 0.5 * mid) / Math.max(0.05, low + mid + high)), low, mid, high, onset: Math.max(ke, 0.8 * se, 0.45 * he) } };
}
