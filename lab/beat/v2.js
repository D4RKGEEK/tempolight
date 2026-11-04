// V2 prototype: log-compressed multi-band spectral flux (SuperFlux-lite: max-filtered reference, 2-hop lag),
// autocorrelation tempogram with a log-normal tempo prior and harmonic check, comb phase search, and a PLL that
// keeps the grid through breaks. Drop-in subclass of LiveAnalyser (same grid()/bpm/phase contract).
const { LiveAnalyser } = await import(process.env.BASE || "/home/claude/tempolight/packages/engine/src/live.js");

const NB = 24, N = 768; // ODF ring: 768 hops = 8.9 s at 86 Hz
export class LiveAnalyserV2 extends LiveAnalyser {
  reset() { super.reset(); this.odf = new Float32Array(N); this.odfT = new Float64Array(N); this.on = 0; this.lb = [new Float32Array(NB), new Float32Array(NB), new Float32Array(NB)]; this.cand2b = 0; this.cand2n = 0; this.conf = 0; }
  vocalHop(loud, dt) {
    super.vocalHop(loud, dt);
    // 24 log bands from 40 Hz to 10 kHz, log-compressed
    const cur = this.lb[2]; this.lb[2] = this.lb[1]; this.lb[1] = this.lb[0]; this.lb[0] = cur;
    const E = (b) => { const lo = 40 * Math.pow(250, b / NB), hi = 40 * Math.pow(250, (b + 1) / NB); return this.bandMag(lo, hi); };
    for (let b = 0; b < NB; b++) cur[b] = Math.log1p(1e4 * E(b));
    const ref = this.lb[2]; let o = 0; // compare with 2 hops ago, max over neighbouring bands (vibrato / slow-attack suppression)
    for (let b = 0; b < NB; b++) { const r = Math.max(ref[b], b ? ref[b - 1] : 0, b < NB - 1 ? ref[b + 1] : 0); const d = cur[b] - r; if (d > 0) o += d * (b < 6 ? 1.5 : 1); } // low bands weighted up a bit
    const i = this.on % N; this.odf[i] = o; this.odfT[i] = this.t; this.on++;
  }
  estimateTempo(t) {
    if (this.on < 260) return; // ~3 s
    const L = Math.min(this.on, N), x = new Float32Array(L); let m = 0;
    for (let k = 0; k < L; k++) { x[k] = this.odf[(this.on - L + k) % N]; m += x[k]; } m /= L;
    // local-mean removal (0.3 s) then half-wave
    const W = 13, y = new Float32Array(L); for (let k = 0; k < L; k++) { let s = 0, c = 0; for (let j = Math.max(0, k - W); j <= Math.min(L - 1, k + W); j++) { s += x[j]; c++; } y[k] = Math.max(0, x[k] - s / c); }
    let energy = 0; for (let k = L - 260; k < L; k++) energy += y[k]; // recent 3 s: hold through breaks
    let e0 = 0; for (let k = 0; k < L; k++) e0 += y[k] * y[k]; if (!e0) return;
    const dt = this.dtHop, ac = lag => { const l0 = Math.floor(lag), f = lag - l0; let s = 0; for (let k = l0 + 1; k < L; k++) s += y[k] * (y[k - l0] * (1 - f) + y[k - l0 - 1] * f); return s / e0 / (L - lag) * L; };
    // tempogram 55..190 BPM, harmonic-enhanced, log-normal prior at 120 BPM (sd 1 octave)
    let best = -1, bb = 0; const sc = [];
    for (let bpm = 55; bpm <= 190; bpm += 0.5) { const lag = 60 / bpm / dt; const s = (ac(lag) + 0.5 * ac(2 * lag) + 0.25 * ac(4 * lag) - 0.25 * Math.max(0, ac(1.5 * lag))) * Math.exp(-0.5 * (Math.log2(bpm / 120) / 1.0) ** 2); sc.push(s); if (s > best) { best = s; bb = bpm; } }
    if (best <= 0) return;
    const sorted = sc.slice().sort((a, b) => b - a); this.conf = Math.max(0, Math.min(1, (best - sorted[Math.floor(sorted.length * 0.5)]) / (best + 1e-9)));
    const recentOk = energy > 0.15 * (e0 > 0 ? Math.sqrt(e0) : 1);
    if (!recentOk && this.bpm) return; // a break: keep the grid going
    // tempo hysteresis: small moves follow, a different tempo must win ~1.5 s in a row
    if (!this.bpm || Math.abs(bb - this.bpm) / this.bpm < 0.03) this.bpm = this.bpm ? this.bpm * 0.6 + bb * 0.4 : bb;
    else if (Math.abs(bb - this.cand2b) < 1.5) { if (++this.cand2n >= 3) { this.bpm = bb; this.cand2n = 0; } } else { this.cand2b = bb; this.cand2n = 1; }
    // phase: comb over the last 4 s of ODF, beats weighted by recency
    const P = 60 / this.bpm / dt, nPh = Math.ceil(P); let bp = 0, bs = -1;
    for (let ph = 0; ph < nPh; ph++) { let s = 0; for (let k = 0; k * P + ph < Math.min(L - 1, 4 / dt); k++) { const j = L - 1 - Math.round(k * P + ph); s += (y[j] + 0.5 * (y[j - 1] || 0) + 0.5 * (y[j + 1] || 0)) * Math.exp(-k * P * dt / 2.5); } if (s > bs) { bs = s; bp = ph; } }
    const beatTime = this.odfT[(this.on - 1 - bp + N * 4) % N], Ps = 60 / this.bpm, ph = ((beatTime % Ps) + Ps) % Ps;
    if (!this.phaseSet) { this.phase = ph; this.phaseSet = true; } else { let d = ph - this.phase; d -= Math.round(d / Ps) * Ps; this.phase = (this.phase + d * 0.3 + Ps) % Ps; }
  }
}
