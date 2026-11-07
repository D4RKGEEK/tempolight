// Live beat tracking: tempo, beat phase and bar position from an onset-strength curve, one frame at a time.
// Pure JavaScript, no I/O, nothing allocated per frame. LiveAnalyser (live.js) feeds it; it works at any frame rate.
//
// - Tempo: a tempogram, the autocorrelation of the last 12 s of the onset curve in 3 band groups. Each tempo is scored
//   at its beat, half a beat, two, three and four beats (a comb: the right tempo has its eighths and its bar too; one
//   4/3 as fast, from 3+3+2 rhythms, doesn't), times a broad fixed preference (log-normal around 100 BPM, soft support
//   66-180 BPM; never the music style). Strong rivals 3/2 or 4/3 apart are weighed by how many of their beats have a
//   kick or snare. The scores feed a Viterbi path over the tempos: moving a little costs little, jumping anywhere else
//   costs a lot. The song's tempo moves to a new one only when the path has preferred it, by a margin, for 8 s in a row
//   (2 s when it puts a kick on every beat and the old grid doesn't; under 1 s in the first 6 s; a 3/2 or 4/3 move
//   also needs drums on more beats). The grid's period stays within 4% of the song's tempo. Held in a break.
// - Beat phase and fine tempo: a comb over the last ~4.5 s of the curve, tried at the current tempo and a few percent
//   either side, finds where the beats fall (four-on-the-floor kicks, when there are, set the phase). The grid follows
//   it (small errors smoothly, a different phase only after it has won for 0.8 s), so ramps and small tempo changes
//   are tracked between tempo estimates.
// - Bar position: at each beat, how much kick, snare and harmonic change it carries, summed for each beat of the bar
//   with a slow decay; beat 1 is the slot that wins (by a margin).
// - conf (0-1): how sure the grid is. The product of: how clearly the onsets fall on the grid (the comb's peak), how
//   long the tempo has held (0 at a change, full after 8 s), how much the tempo path agrees with the grid's tempo (or
//   its double or half), and whether something is heard lately. 0.7 and over means a beat that is really steady.

const TMIN = 50, TMAX = 200, TPO = 48, BAND_W = [1, 1, 0.7];
const PRIOR_BPM = 100, PRIOR_SD = 0.6, SUP_LO = 66, SUP_HI = 180; // tempo preference: log-normal (sd in ln units), soft support
const TG_SEC = 12;     // tempogram window
const JUMP = 6;        // Viterbi: cost (nats) of jumping to an unrelated tempo; a step of k bins costs LOC * k^2
const LOC = 0.5, BETA = 3;
const HARM = [2, 3, 4], HARM_W = [0.5, 0.35, 0.5], HALF_W = 1; // the comb's teeth past the beat: two beats, three, a bar
const HOLD = 8, HOLD_FAST = 2, EARLY = 6; // seconds a new tempo must lead before the grid takes it
const LEAD = 0.004; // onset-curve peaks come this much after the sound starts: beats go earlier by it
const NOV_B0 = 6, NOV_B1 = 21, NOV_W = 15; // harmonic change for the bar position: bands 160 Hz-5 kHz, and its weight

export class BeatTracker {
  /** @param {number} fps frames (onset values) a second @param {number} [nb] bands of the spectrum passed to push() */
  constructor(fps, nb = 24) {
    this.fps = fps; this.dt = 1 / fps; this.nb = nb;
    let N = 256; while (N < fps * (TG_SEC + 1)) N <<= 1; this.N = N; this.M = N - 1;
    this.z = new Float32Array(N); this.kz = new Float32Array(N); this.zb = [new Float32Array(N), new Float32Array(N), new Float32Array(N)]; this.bMean = new Float32Array(3); this.lo = new Float32Array(N); this.mi = new Float32Array(N); this.spec = new Float32Array(N * nb);
    this.W = Math.min(N - 16, Math.round(TG_SEC * fps)); this.buf = new Float32Array(this.W);
    this.maxLag = Math.min(this.W - 2, Math.ceil(4 * fps * 60 / SUP_LO) + 2); this.ac = new Float32Array(this.maxLag + 2);
    this.nT = Math.round(Math.log2(TMAX / TMIN) * TPO) + 1;
    this.tBpm = new Float32Array(this.nT); this.tPrior = new Float32Array(this.nT); this.tV = new Float32Array(this.nT); this.tD = new Float32Array(this.nT); this.tTmp = new Float32Array(this.nT);
    for (let i = 0; i < this.nT; i++) {
      const b = TMIN * Math.pow(2, i / TPO), out = b < SUP_LO ? Math.log(SUP_LO / b) : b > SUP_HI ? Math.log(b / SUP_HI) : 0;
      this.tBpm[i] = b; this.tPrior[i] = Math.exp(-0.5 * (Math.log(b / PRIOR_BPM) / PRIOR_SD) ** 2 - 0.5 * (out / 0.06) ** 2);
    }
    this.comb = new Float32Array(Math.ceil(fps * 60 / TMIN) + 4);
    this.slot = new Float32Array(4); this.nov = new Float32Array(nb); this.nov2 = new Float32Array(nb);
    this.reset();
  }

  reset() {
    this.n = 0; this.tn = 0; this.z.fill(0); this.kz.fill(0); for (const a of this.zb) a.fill(0); this.bMean.fill(0); this.lockT = 0; this.lo.fill(0); this.mi.fill(0); this.spec.fill(0); this.tV.fill(0); this.tD.fill(0);
    this.oMean = 0; this.eS = 0; this.eF = 0; this.eL = 0; this.loM = 1e-3; this.miM = 1e-3; this.activeN = 0;
    this.has = false; this.P = 0.5; this.H = 0.5; this.a = 0; this.ia = 0; this.barOff = 0; this.slot.fill(0); this.barCand = -1; this.barCandN = 0;
    this.cand = 0; this.candT = 0; this.jump = 0; this.jumpN = 0; this.conf = 0; this.lastBeatDone = -1;
    this.holdT = 0; this.agree = 0; this.post = 0;
  }

  /** The beat grid for gridAt(): beat i is at off + i * P; beat 1 of a bar when i % 4 === barOff. */
  get off() { return this.a - this.ia * this.P; }
  get bpm() { return this.has ? 60 / this.P : 0; }

  /** Set the grid from outside (a tap tempo): beats every 60/bpm s, one of them at time t0. */
  set(bpm, t0) {
    if (!(bpm > 0)) return; const P = 60 / bpm;
    const ref = this.has ? this.a : t0; this.P = this.H = P; const k = Math.round((ref - t0) / P); this.a = t0 + k * P;
    if (!this.has) { this.ia = 0; this.holdT = this.tn; } this.has = true; this.cand = 0; this.jumpN = 0;
  }

  /**
   * One frame. @param {number} t its time @param {number} o onset strength (all bands) @param {number} lo kick band
   * @param {number} mi body band @param {number} hi snare and hat band @param {Float32Array} spec log band levels (for
   * harmonic change at bar lines)
   */
  push(t, o, lo, mi, hi, spec) {
    const { M, fps } = this, i = this.n & M, bm = this.bMean, ka = 1 / (0.1 * fps);
    // per band too, for the tempo: kick, body and snare/hat bands each vote with their own rhythm
    bm[0] += (lo - bm[0]) * ka; bm[1] += (mi - bm[1]) * ka; bm[2] += (hi - bm[2]) * ka;
    this.zb[0][i] = lo > bm[0] ? lo - bm[0] : 0; this.zb[1][i] = mi > bm[1] ? mi - bm[1] : 0; this.zb[2][i] = hi > bm[2] ? hi - bm[2] : 0;
    // the onset curve minus its recent mean (~0.1 s), half-wave rectified
    this.oMean += (o - this.oMean) * (1 / (0.1 * fps)); const z = o - this.oMean > 0 ? o - this.oMean : 0;
    this.z[i] = z; this.kz[i] = 0; this.lo[i] = lo; this.mi[i] = mi;
    const so = i * this.nb; for (let b = 0; b < this.nb; b++) this.spec[so + b] = spec[b];
    this.loM += (lo - this.loM) * (1 / (4 * fps)); this.miM += (mi - this.miM) * (1 / (4 * fps));
    // how much is heard lately (2 s) against the longer run (20 s): a break holds the tempo and the phase
    this.eS += (z - this.eS) * (1 / (2 * fps)); this.eF += (z - this.eF) * (1 / (0.6 * fps)); this.eL += (z - this.eL) * (1 / (20 * fps)); if (this.eL < this.eS * 0.5) this.eL = this.eS * 0.5;
    const active = this.eS > 0.25 * this.eL && this.eF > 0.25 * this.eL && this.eS > 1e-3;
    this.activeN = active ? this.activeN + 1 : Math.max(0, this.activeN - 2);
    this.n++; this.tn = t;
    if (this.has) this.advance(t);
    const E = Math.max(1, Math.round((this.has && this.tn - this.lockT > EARLY ? 0.5 : 0.25) * fps));
    if (active && this.n % E === 0 && this.activeN > 1.3 * fps) this.tempo();
    if (this.has && (this.n & 3) === 0) { if (active) this.phase(); else this.conf *= 0.97; }
  }

  /** A kick was heard `back` frames before the newest one (kicks are confirmed a few frames late). */
  markKick(back) { this.kz[(this.n - 1 - back) & this.M] = 1; }

  // time of frame k (k counts frames since reset)
  tOf(k) { return this.tn - (this.n - 1 - k) * this.dt; }

  // tempo bin of a bpm (clamped)
  binOf(bpm) { return Math.max(0, Math.min(this.nT - 1, Math.round(Math.log2(bpm / TMIN) * TPO))); }

  tempo() {
    const L = Math.min(this.n - 1, this.W), buf = this.buf, ac = this.ac, fps = this.fps, M = this.M, nT = this.nT;
    const lagMax = Math.min(this.maxLag, Math.floor(L * 0.75)); if (lagMax < 4) return;
    // autocorrelation of each band's onset curve, each normalised by its own energy (quiet hats vote as much as loud
    // kicks), summed; biased (divided by the whole length), so long lags need more evidence
    ac.fill(0); let wsum = 0;
    for (let q = 0; q < 3; q++) {
      const zq = this.zb[q]; for (let k = 0; k < L; k++) buf[k] = zq[(this.n - L + k) & M];
      let e0 = 0; for (let k = 0; k < L; k++) e0 += buf[k] * buf[k]; if (e0 < 1e-6) continue;
      const w = BAND_W[q] / e0; wsum += BAND_W[q];
      for (let l = 1; l <= lagMax + 1; l++) { let s = 0; for (let k = l; k < L; k++) s += buf[k] * buf[k - l]; ac[l] += s * w; }
    }
    if (!wsum) return;
    // the comb: each tempo scored at its beat, half a beat and two beats, times the fixed tempo preference. A tempo
    // 4/3 or 3/2 as fast as the music (3+3+2 rhythms, triplet hats) scores well at its beat but not at its half beat.
    const V = this.tV; let vmax = 0;
    for (let j = 0; j < nT; j++) {
      const lag = fps * 60 / this.tBpm[j]; if (lag > lagMax) { V[j] = 0; continue; }
      let s = this.acAt(lag), w = 1; if (lag >= 4) { s += HALF_W * this.acAt(lag / 2); w += HALF_W; }
      for (let h = 0; h < 3; h++) { const l = HARM[h] * lag; if (l > lagMax) break; s += HARM_W[h] * this.acAt(l); w += HARM_W[h]; }
      const v = Math.max(0, s / w / wsum) * this.tPrior[j]; V[j] = v; if (v > vmax) vmax = v;
    }
    if (vmax <= 0) return;
    // the best tempo and its strong relatives 3/2, 2/3, 4/3 or 3/4 as fast (3+3+2 kicks, syncopation and triplets
    // make those look periodic too): each scaled by the share of its beats with a kick or a snare
    { let jb = 0; for (let j = 1; j < nT; j++) if (V[j] > V[jb]) jb = j;
      const cb = this.drumCover(fps * 60 / this.tBpm[jb]);
      for (let j = 1; j < nT - 1; j++) {
        const v = V[j]; if (j === jb || v < 0.5 * vmax || v < V[j - 1] || v < V[j + 1]) continue;
        const d = Math.abs((j - jb) / TPO); if (!(Math.abs(d - 0.585) < 0.04 || Math.abs(d - 0.415) < 0.04)) continue;
        const f = (0.5 + this.drumCover(fps * 60 / this.tBpm[j])) / (0.5 + cb);
        for (let i = Math.max(0, j - 3); i <= Math.min(nT - 1, j + 3); i++) V[i] *= f;
      }
      vmax = 0; for (let j = 0; j < nT; j++) if (V[j] > vmax) vmax = V[j]; }
    // the Viterbi step: the best path into each tempo (a small step, or a jump from the best of all), plus this
    // estimate's score. A weak tempogram (little periodicity) counts for less.
    const D = this.tD, Tm = this.tTmp, beta = BETA * Math.min(1, vmax / 0.1); let dmax = -Infinity;
    for (let j = 0; j < nT; j++) if (D[j] > dmax) dmax = D[j];
    let best = -Infinity, bi = 0;
    for (let j = 0; j < nT; j++) {
      let m = dmax - JUMP; for (let i = Math.max(0, j - 2); i <= Math.min(nT - 1, j + 2); i++) { const c = D[i] - LOC * (i - j) * (i - j); if (c > m) m = c; }
      Tm[j] = m + beta * V[j] / vmax; if (Tm[j] > best) { best = Tm[j]; bi = j; }
    }
    for (let j = 0; j < nT; j++) D[j] = Math.max(-2 * JUMP, Tm[j] - best);
    // a near tie with a tempo 3/2, 2/3, 4/3 or 3/4 as fast (syncopated kicks make those look periodic too): the one
    // that puts a kick or a snare on more of its beats wins
    let bc = -1;
    for (let j = 1; j < nT - 1; j++) {
      const v = D[j]; if (j === bi || v < -1 || v < D[j - 1] || v < D[j + 1]) continue;
      const d = Math.abs((j - bi) / TPO); if (!(Math.abs(d - 0.585) < 0.04 || Math.abs(d - 0.415) < 0.04)) continue;
      if (bc < 0) bc = this.drumCover(fps * 60 / this.tBpm[bi]);
      const c = this.drumCover(fps * 60 / this.tBpm[j]); if (c > bc + 0.15) { bi = j; bc = c; }
    }
    // parabolic refinement on the log-tempo grid (on this estimate's scores)
    let fj = bi; if (bi > 0 && bi < nT - 1) { const y0 = V[bi - 1], y1 = V[bi], y2 = V[bi + 1], d = y0 - 2 * y1 + y2; if (d < 0) fj = bi + Math.max(-0.5, Math.min(0.5, 0.5 * (y0 - y2) / d)); }
    let T = TMIN * Math.pow(2, fj / TPO);
    // the first tempo, from a second or two of sound: a slow one whose double scores nearly as well starts at the
    // double (the path can still settle on the slow one in the first 6 s)
    if (!this.has && T < 90 && V[Math.min(nT - 1, bi + TPO)] >= 0.7 * vmax) T *= 2;
    if (!this.has) { this.P = this.H = 60 / T; this.has = true; this.a = this.tn; this.ia = 0; this.lockT = this.holdT = this.tn; this.phase(true); this.posterior(); return; }
    this.posterior();
    const cur = 60 / this.H, r = Math.log2(T / cur);
    if (Math.abs(r) < 0.035) { this.cand = 0; this.H = 60 / T; return; } // the song's tempo follows the path's small moves
    // how much the path prefers the new tempo to the grid's
    const jc = this.binOf(cur); let dc = -Infinity; for (let i = Math.max(0, jc - 1); i <= Math.min(nT - 1, jc + 1); i++) if (D[i] > dc) dc = D[i];
    const lead = D[bi] - dc, early = this.tn - this.lockT < EARLY; // the first tempo came from little audio: easier to correct
    const odd = Math.abs(Math.abs(r) - 0.585) < 0.04 || Math.abs(Math.abs(r) - 0.415) < 0.04;
    const metric = odd || Math.abs(Math.abs(r) - 1) < 0.05 || Math.abs(Math.abs(r) - 2) < 0.05; // twice, half, 3/2, 4/3 ... as fast
    if (lead < (early ? 0.3 : 1)) { this.cand = 0; return; }
    if (!(this.cand && Math.abs(Math.log2(T / this.cand)) < 0.03)) { this.cand = T; this.candT = this.tn; }
    // a real tempo change (not a metric relative) that puts a kick on every beat where the old grid doesn't: sooner
    let need = early ? 0.4 : HOLD;
    if (!early && !metric && this.tn - this.candT >= HOLD_FAST) { const cn = this.drumCover(fps * 60 / T); if (cn >= 0.75 && cn > this.drumCover(this.H * fps) + 0.25) need = HOLD_FAST; }
    // 3/2, 4/3 ... as fast only when it also puts the drums on more beats (a drumless break with a 3-against-4
    // pattern must not move the grid)
    if (!early && odd && this.tn - this.candT >= need && !(this.drumCover(fps * 60 / T) > this.drumCover(this.H * fps) + 0.1)) return;
    if (this.tn - this.candT >= need) { this.P = this.H = 60 / T; this.cand = 0; this.holdT = this.tn; this.phase(true); this.posterior(); }
  }

  // the grid's period stays within 4% of the song's tempo (H): the fine tempo can't wander off on its own
  clampP(P) { return Math.max(this.H / 1.04, Math.min(this.H * 1.04, P)); }

  // the tempogram (this.ac) at a fractional lag
  acAt(l) { const k = Math.floor(l), f = l - k; return this.ac[k] * (1 - f) + this.ac[k + 1] * f; }

  // how much of the tempo path's weight is on the grid's tempo, its double or its half (0-1)
  posterior() {
    const D = this.tD, nT = this.nT, jc = this.binOf(60 / this.H); let tot = 0, on = 0;
    for (let j = 0; j < nT; j++) { const e = Math.exp(D[j]); tot += e; const d = Math.abs(j - jc); if (d <= 2 || Math.abs(d - TPO) <= 2) on += e; }
    this.post = tot > 0 ? on / tot : 0;
  }

  // the share of the grid's last 8 beats that have an onset on them (within 2 frames)
  coverage() {
    const fps = this.fps, P = this.P * fps, end = this.n - 2, span = Math.min(this.n - 4, Math.round(4 * fps)); let mx = 0;
    let mean = 0; for (let k = end - span; k <= end; k++) { const v = this.z[k & this.M]; mean += v; if (v > mx) mx = v; } mean /= span + 1;
    if (mx <= 0) return 0;
    const last = this.n - 1 - (this.tn - this.a - LEAD) * fps; let hit = 0, nb = 0;
    for (let b = 0; b < 8; b++) { const x = Math.round(last - b * P); if (x < end - span) break; nb++; let m = 0;
      for (let k = x - 2; k <= x + 2; k++) { const v = this.z[k & this.M]; if (v > m) m = v; } if (m > Math.max(0.05 * mx, 2 * mean)) hit++; }
    return nb ? hit / nb : 0;
  }

  // at period p (frames), the best phase's share of the last 8 beats with a kick or snare onset (low and body bands)
  drumCover(p) {
    const end = this.n - 2, span = Math.min(this.n - 4, Math.round(8 * p) + 4), M = this.M, z0 = this.zb[0], z1 = this.zb[1]; let mx = 0, mean = 0;
    for (let k = end - span; k <= end; k++) { const v = z0[k & M] + z1[k & M]; mean += v; if (v > mx) mx = v; } mean /= span + 1;
    if (mx <= 0) return 0; const thr = Math.max(0.15 * mx, 2 * mean), nb = Math.min(8, Math.floor((span - 2) / p)); let best = 0;
    for (let q = 0; q < Math.ceil(p); q++) { let hit = 0;
      for (let b = 0; b < nb; b++) { const x = Math.round(end - 2 - q - b * p); let m = 0; for (let k = x - 1; k <= x + 1; k++) { const v = z0[k & M] + z1[k & M]; if (v > m) m = v; } if (m > thr) hit++; }
      if (hit > best) best = hit; }
    return nb ? best / nb : 0;
  }

  // comb over the onset curve at period p (frames): fills this.comb for phases ph0..ph0+np-1, returns the best phase
  combAt(p, ph0, np, z = this.z) {
    const end = this.n - 2, span = Math.min(this.n - 4, 4.5 * this.fps), K = Math.max(1, Math.floor((span - ph0) / p)), tau = 2.5 * this.fps;
    const c = this.comb, M = this.M; let best = -1, bp = 0;
    for (let q = 0; q < np; q++) c[q] = 0;
    for (let k = 0; k < K; k++) {
      const w = Math.exp(-k * p / tau), x0 = end - ph0 - k * p, k0 = Math.floor(x0), f = x0 - k0, g = 1 - f;
      for (let q = 0; q < np; q++) { const j = k0 - q; c[q] += w * ((z[j & M] + 0.5 * (z[(j - 1) & M] + z[(j + 1) & M])) * g + (z[(j + 1) & M] + 0.5 * (z[j & M] + z[(j + 2) & M])) * f); }
    }
    for (let q = 0; q < np; q++) if (c[q] > best) { best = c[q]; bp = q; }
    return bp;
  }

  // with kicks on at least 6 of the last 8 beats at period p, the phase (comb index) they agree on, else -1
  kickBeats(p, ph0) {
    const q = this.combAt(p, ph0, Math.ceil(p), this.kz), kz = this.kz, M = this.M, end = this.n - 2; let hit = 0, s = 0, sw = 0;
    for (let k = 0; k < 8; k++) { const x = Math.round(end - ph0 - q - k * p); for (let j = x - 2; j <= x + 2; j++) if (kz[j & M]) { hit++; s += j - x; sw++; break; } }
    return hit >= 6 ? q - s / sw : -1;
  }

  // follow the beats: phase every 4 frames from the comb, the tempo fine-tuned by trying a few percent either side
  phase(force = false) {
    const fps = this.fps, ph0 = 3, p = this.P * fps; let bestS = -1, bestR = 0;
    for (let j = -4; j <= 4; j++) {
      const r = 1 + 0.01 * j, q = this.combAt(p * r, ph0, Math.ceil(p * r)), s = this.comb[q];
      if (s > bestS) { bestS = s; bestR = r; }
    }
    // fine tempo: parabola through the scores around the best ratio
    const sAt = r => { const q = this.combAt(p * r, ph0, Math.ceil(p * r)); return this.comb[q]; };
    const sl = sAt(bestR - 0.005), sr = sAt(bestR + 0.005), sm = bestS;
    let rr = bestR; const d = sl - 2 * sm + sr; if (d < 0) rr = bestR + 0.005 * Math.max(-1, Math.min(1, 0.5 * (sl - sr) / d));
    // the phase at the refined period
    const pr = p * rr, npr = Math.ceil(pr), q = this.combAt(pr, ph0, npr);
    let mean = 0; for (let k = 0; k < npr; k++) mean += this.comb[k]; mean /= npr;
    const c = this.comb, y0 = c[(q - 1 + npr) % npr], y1 = c[q], y2 = c[(q + 1) % npr], dd = y0 - 2 * y1 + y2;
    const qf = q + (dd < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (y0 - y2) / dd)) : 0);
    const peak = y1 > 0 ? Math.max(0, Math.min(1, (y1 - mean) / y1)) : 0;
    // conf: onsets on the grid (the comb's peak) x how long the tempo has held x the tempo path's agreement x heard lately
    this.agree += (peak - this.agree) * 0.08;
    const held = Math.max(0, Math.min(1, (this.tn - this.holdT) / HOLD));
    this.conf += (Math.min(1, this.agree / 0.6) * held * this.post * Math.min(1, this.eS / Math.max(1e-6, 0.5 * this.eL)) - this.conf) * 0.08;
    let tb = this.tOf(this.n - 2 - ph0 - qf) - LEAD; const P = this.P;
    // four-on-the-floor kicks (one on nearly every beat): their times set the phase. Under a sidechain pump the swell
    // after each kick can rise more than the ducked kick and would pull the grid onto the off-beat.
    const kq = this.kickBeats(pr, ph0); if (kq >= 0) tb = this.tOf(this.n - 2 - ph0 - kq);
    // nearest grid beat to tb and the error
    const kN = Math.round((tb - this.a) / P), e = tb - (this.a + kN * P);
    if (force) { this.a += e; this.P = this.clampP(pr / fps); this.advance(this.tn); this.jumpN = 0; return; }
    if (peak < 0.15) return;
    const g = Math.min(1, peak * 1.5);
    if (Math.abs(e) < 0.12 * P) {
      this.a += e * 0.12 * g; this.jumpN = 0;
      if (this.eF > 0.5 * this.eL) this.P = this.clampP(this.P + (pr / fps - this.P) * 0.06 * g); // (not while the music thins out into a break)
    } else {
      // a different phase: it must keep winning for 0.8 s, and clearly beat the comb where the grid is now
      const qg = ((Math.round((this.tn - (this.a + kN * P)) * fps - 1 - ph0) % npr) + npr) % npr, sg = this.comb[qg];
      if (y1 < sg * 1.3) { this.jumpN = 0; return; }
      if (this.jumpN && Math.abs(((e - this.jump + 1.5 * P) % P) - 0.5 * P) < 0.08 * P) this.jumpN++; else { this.jump = e; this.jumpN = 1; }
      if (this.jumpN >= Math.round(0.8 * fps / 4)) { this.a += e; this.P = this.clampP(pr / fps); this.jumpN = 0; }
    }
  }

  // move the anchor to the latest beat (so the beat count stays continuous when the tempo changes); at each beat
  // passed, gather what decides the bar position
  advance(t) {
    while (this.a + this.P <= t) { this.a += this.P; this.ia++; }
    while (this.a > t) { this.a -= this.P; this.ia--; }
    // the beat before last is complete (its onsets and the harmonic change after it are in): score it once
    const ib = this.ia - 1; if (ib <= this.lastBeatDone) return; this.lastBeatDone = ib;
    const tb = this.a - this.P, fps = this.fps, kb = this.n - 1 - (this.tn - tb) * fps; if (kb < fps * 1.5) return;
    if (this.activeN < fps) return;
    const w = Math.max(1, Math.round(0.06 * fps)); let kl = 0, km = 0;
    for (let k = Math.round(kb) - w; k <= Math.round(kb) + w; k++) { const l = this.lo[k & this.M], m = this.mi[k & this.M]; if (l > kl) kl = l; if (m > km) km = m; }
    kl /= this.loM * 4 + 1e-6; km /= this.miM * 4 + 1e-6;
    // harmonic change (chords change on beat 1): each band's floor (its quietest frame, so the drum hits and their
    // tails don't count) between the beats after this one against the one before, over 160 Hz-5 kHz
    const P = this.P * fps, a0 = Math.round(0.15 * P), a1 = Math.round(0.85 * P), nb = this.nb, lo = this.nov, hi = this.nov2, k0 = Math.round(kb), sp = this.spec;
    lo.fill(1e9); hi.fill(1e9);
    for (let k = a0; k <= a1; k++) { const A = ((k0 + k) & this.M) * nb, B = ((k0 - k) & this.M) * nb;
      for (let b = NOV_B0; b < NOV_B1; b++) { if (sp[A + b] < hi[b]) hi[b] = sp[A + b]; if (sp[B + b] < lo[b]) lo[b] = sp[B + b]; } }
    let nv = 0; for (let b = NOV_B0; b < NOV_B1; b++) nv += Math.abs(hi[b] - lo[b]); nv /= NOV_B1 - NOV_B0;
    const j = ((ib % 4) + 4) % 4, s = this.slot;
    for (let q = 0; q < 4; q++) s[q] *= 0.97;
    s[j] += Math.min(3, kl) - 0.6 * Math.min(3, km) + NOV_W * Math.min(1, nv);
    let bj = 0; for (let q = 1; q < 4; q++) if (s[q] > s[bj]) bj = q;
    if (bj === this.barOff) { this.barCandN = 0; return; }
    if (s[bj] < s[this.barOff] + 0.5) return;
    if (bj === this.barCand) { if (++this.barCandN >= 4) { this.barOff = bj; this.barCandN = 0; } } else { this.barCand = bj; this.barCandN = 1; }
  }
}
