// Live beat tracking: tempo, beat phase and bar position from an onset-strength curve, one frame at a time.
// Pure JavaScript, no I/O, nothing allocated per frame. LiveAnalyser (live.js) feeds it; it works at any frame rate.
//
// - Tempo: autocorrelation of the last 8 s of the onset curve in 3 band groups. Each tempo is scored with its double
//   lag too, times a FIXED preference for about 120 BPM (never the music style). A new tempo must win several times
//   in a row, a new metric level (double, half, 3/2) for longer. Held while little is heard (a break), so the grid
//   runs on.
// - Beat phase and fine tempo: a comb over the last ~4.5 s of the curve, tried at the current tempo and a few percent
//   either side, finds where the beats fall (four-on-the-floor kicks, when there are, set the phase). The grid follows
//   it (small errors smoothly, a different phase only after it has won for 0.8 s), so ramps and small tempo changes
//   are tracked between tempo estimates.
// - Bar position: at each beat, how much kick, snare and harmonic change it carries, summed for each beat of the bar
//   with a slow decay; beat 1 is the slot that wins (by a margin).
// - conf (0-1): how sure the grid is (clear beats in the comb, and something heard lately).

const TMIN = 50, TMAX = 200, TPO = 48, PRIOR_BPM = 120, PRIOR_OCT = 1.1, BAND_W = [1, 1, 0.7];
const LEAD = 0.004; // onset-curve peaks come this much after the sound starts: beats go earlier by it
const NOV_B0 = 6, NOV_B1 = 21, NOV_W = 15; // harmonic change for the bar position: bands 160 Hz-5 kHz, and its weight

export class BeatTracker {
  /** @param {number} fps frames (onset values) a second @param {number} [nb] bands of the spectrum passed to push() */
  constructor(fps, nb = 24) {
    this.fps = fps; this.dt = 1 / fps; this.nb = nb;
    let N = 256; while (N < fps * 10) N <<= 1; this.N = N; this.M = N - 1;
    this.z = new Float32Array(N); this.kz = new Float32Array(N); this.zb = [new Float32Array(N), new Float32Array(N), new Float32Array(N)]; this.bMean = new Float32Array(3); this.lo = new Float32Array(N); this.mi = new Float32Array(N); this.spec = new Float32Array(N * nb);
    this.W = Math.min(N - 16, Math.round(8 * fps)); this.buf = new Float32Array(this.W);
    this.maxLag = Math.min(this.W - 2, Math.ceil(2 * fps * 60 / TMIN) + 2); this.ac = new Float32Array(this.maxLag + 2);
    this.nT = Math.round(Math.log2(TMAX / TMIN) * TPO) + 1;
    this.tBpm = new Float32Array(this.nT); this.tPrior = new Float32Array(this.nT); this.tG = new Float32Array(this.nT);
    for (let i = 0; i < this.nT; i++) { const b = TMIN * Math.pow(2, i / TPO); this.tBpm[i] = b; this.tPrior[i] = Math.exp(-0.5 * (Math.log2(b / PRIOR_BPM) / PRIOR_OCT) ** 2); }
    this.comb = new Float32Array(Math.ceil(fps * 60 / TMIN) + 4);
    this.slot = new Float32Array(4); this.nov = new Float32Array(nb); this.nov2 = new Float32Array(nb);
    this.reset();
  }

  reset() {
    this.n = 0; this.tn = 0; this.z.fill(0); this.kz.fill(0); for (const a of this.zb) a.fill(0); this.bMean.fill(0); this.lockT = 0; this.lo.fill(0); this.mi.fill(0); this.spec.fill(0); this.tG.fill(0);
    this.oMean = 0; this.eS = 0; this.eF = 0; this.eL = 0; this.loM = 1e-3; this.miM = 1e-3; this.activeN = 0;
    this.has = false; this.P = 0.5; this.a = 0; this.ia = 0; this.barOff = 0; this.slot.fill(0); this.barCand = -1; this.barCandN = 0;
    this.cand = 0; this.candN = 0; this.jump = 0; this.jumpN = 0; this.conf = 0; this.lastBeatDone = -1;
  }

  /** The beat grid for gridAt(): beat i is at off + i * P; beat 1 of a bar when i % 4 === barOff. */
  get off() { return this.a - this.ia * this.P; }
  get bpm() { return this.has ? 60 / this.P : 0; }

  /** Set the grid from outside (a tap tempo): beats every 60/bpm s, one of them at time t0. */
  set(bpm, t0) {
    if (!(bpm > 0)) return; const P = 60 / bpm;
    const ref = this.has ? this.a : t0; this.P = P; const k = Math.round((ref - t0) / P); this.a = t0 + k * P;
    if (!this.has) this.ia = 0; this.has = true; this.cand = 0; this.candN = 0; this.jumpN = 0;
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
    const E = Math.max(1, Math.round((this.has && this.tn - this.lockT > 6 ? 0.5 : 0.25) * fps));
    if (active && this.n % E === 0 && this.activeN > 1.3 * fps) this.tempo();
    if (this.has && (this.n & 3) === 0) { if (active) this.phase(); else this.conf *= 0.97; }
  }

  /** A kick was heard `back` frames before the newest one (kicks are confirmed a few frames late). */
  markKick(back) { this.kz[(this.n - 1 - back) & this.M] = 1; }

  // time of frame k (k counts frames since reset)
  tOf(k) { return this.tn - (this.n - 1 - k) * this.dt; }

  tempo() {
    const L = Math.min(this.n - 1, this.W), buf = this.buf, ac = this.ac, fps = this.fps, M = this.M;
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
    // each tempo scored with its double lag too (a bar-long pattern), times the fixed tempo preference
    let best = 0, bi = -1;
    for (let j = 0; j < this.nT; j++) {
      const lag = fps * 60 / this.tBpm[j]; if (lag > lagMax) { this.tG[j] *= 0.5; continue; }
      const k1 = Math.floor(lag), f1 = lag - k1, l2 = 2 * lag, k2 = Math.floor(l2), f2 = l2 - k2;
      let s = ac[k1] * (1 - f1) + ac[k1 + 1] * f1, w = 1; if (l2 <= lagMax) { s += 0.5 * (ac[k2] * (1 - f2) + ac[k2 + 1] * f2); w = 1.5; }
      const v = Math.max(0, s / w / wsum) * this.tPrior[j];
      this.tG[j] = this.tG[j] * 0.5 + v * 0.5; if (this.tG[j] > best) { best = this.tG[j]; bi = j; }
    }
    if (bi < 0 || best <= 0) return;
    // a near tie with a tempo 3/2, 2/3, 4/3 or 3/4 as fast (syncopated kicks make those look periodic too): the one
    // that puts a kick or a snare on more of its beats wins
    let bc = -1;
    for (let j = 1; j < this.nT - 1; j++) {
      const v = this.tG[j]; if (j === bi || v < 0.85 * best || v < this.tG[j - 1] || v < this.tG[j + 1]) continue;
      const d = Math.abs((j - bi) / TPO); if (!(Math.abs(d - 0.585) < 0.04 || Math.abs(d - 0.415) < 0.04)) continue;
      if (bc < 0) bc = this.drumCover(fps * 60 / this.tBpm[bi]);
      const c = this.drumCover(fps * 60 / this.tBpm[j]); if (c > bc + 0.15) { bi = j; bc = c; best = v; }
    }
    // parabolic refinement on the log-tempo grid
    let fj = bi; if (bi > 0 && bi < this.nT - 1) { const y0 = this.tG[bi - 1], y1 = this.tG[bi], y2 = this.tG[bi + 1], d = y0 - 2 * y1 + y2; if (d < 0) fj = bi + Math.max(-0.5, Math.min(0.5, 0.5 * (y0 - y2) / d)); }
    const T = TMIN * Math.pow(2, fj / TPO);
    if (!this.has) { this.P = 60 / T; this.has = true; this.a = this.tn; this.ia = 0; this.lockT = this.tn; this.phase(true); return; }
    const cur = 60 / this.P, r = Math.log2(T / cur);
    if (Math.abs(r) < 0.035) { this.candN = 0; return; }
    // the score of the current tempo, for comparison
    const jc = Math.round(Math.log2(cur / TMIN) * TPO), sc = jc >= 0 && jc < this.nT ? this.tG[jc] : 0;
    const early = this.tn - this.lockT < 6; // the first tempo came from little audio: easier to correct
    // 3/2, 2/3, 4/3, 3/4 of the current tempo and it puts drums on more of its beats: no margin needed
    const odd = Math.abs(Math.abs(r) - 0.585) < 0.04 || Math.abs(Math.abs(r) - 0.415) < 0.04;
    const fits = odd && this.drumCover(fps * 60 / T) > this.drumCover(this.P * fps) + 0.15;
    if (best < sc * (early || fits ? 1.02 : 1.1)) { this.candN = 0; return; }
    if (this.cand && Math.abs(Math.log2(T / this.cand)) < 0.03) this.candN++; else { this.cand = T; this.candN = 1; }
    const metric = Math.abs(r - 1) < 0.05 || Math.abs(r + 1) < 0.05 || Math.abs(Math.abs(r) - 0.585) < 0.05; // twice, half, 3/2, 2/3 as fast
    // half as fast, further from the preferred tempo, while nearly every beat still has a hit (a half-time section
    // over steady hats, dubstep): keep the tempo
    if (Math.abs(r + 1) < 0.05 && this.tPrior[Math.max(0, Math.min(this.nT - 1, Math.round(Math.log2(T / TMIN) * TPO)))] < this.tPrior[Math.max(0, Math.min(this.nT - 1, jc))] && this.coverage() > 0.7) { this.candN = 0; return; }
    if (this.candN >= (early ? 2 : metric ? 10 : 3)) { this.P = 60 / T; this.candN = 0; this.phase(true); }
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
    this.conf += (peak * Math.min(1, this.eS / Math.max(1e-6, 0.5 * this.eL)) - this.conf) * 0.08;
    let tb = this.tOf(this.n - 2 - ph0 - qf) - LEAD; const P = this.P;
    // four-on-the-floor kicks (one on nearly every beat): their times set the phase. Under a sidechain pump the swell
    // after each kick can rise more than the ducked kick and would pull the grid onto the off-beat.
    const kq = this.kickBeats(pr, ph0); if (kq >= 0) tb = this.tOf(this.n - 2 - ph0 - kq);
    // nearest grid beat to tb and the error
    const kN = Math.round((tb - this.a) / P), e = tb - (this.a + kN * P);
    if (force) { this.a += e; this.P = pr / fps; this.advance(this.tn); this.jumpN = 0; return; }
    if (peak < 0.15) return;
    const g = Math.min(1, peak * 1.5);
    if (Math.abs(e) < 0.12 * P) {
      this.a += e * 0.12 * g; this.jumpN = 0;
      if (this.eF > 0.5 * this.eL) this.P += (pr / fps - this.P) * 0.06 * g; // (not while the music thins out into a break)
    } else {
      // a different phase: it must keep winning for 0.8 s, and clearly beat the comb where the grid is now
      const qg = ((Math.round((this.tn - (this.a + kN * P)) * fps - 1 - ph0) % npr) + npr) % npr, sg = this.comb[qg];
      if (y1 < sg * 1.3) { this.jumpN = 0; return; }
      if (this.jumpN && Math.abs(((e - this.jump + 1.5 * P) % P) - 0.5 * P) < 0.08 * P) this.jumpN++; else { this.jump = e; this.jumpN = 1; }
      if (this.jumpN >= Math.round(0.8 * fps / 4)) { this.a += e; this.P = pr / fps; this.jumpN = 0; }
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
