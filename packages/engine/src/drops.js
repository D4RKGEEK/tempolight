// Drop countdown: while listening live, notice a drop coming a few seconds ahead. Pure JavaScript, no I/O (it runs
// in the browser too). The LiveAnalyser (live.js) calls hop() for every analysis hop; the predictor keeps 0.25 s
// blocks of a few features and, every block, decides whether a build-up is on and when its drop will land:
//
// - the riser: over the last 4 s the spectral centroid rises (the sound gets brighter), the energy above 3 kHz rises
//   (a noise sweep, a snare roll getting louder) and the snares come faster (a roll doubling up). Held for 2 s, it is a
//   build-up. A drumless ballad's swell rarely does all three at once.
// - the phrase grid: drops land on phrase lines, 8 or 16 bars from the song's start or the last drop (4 at least). The
//   predicted drop is the likeliest phrase line ahead, counted in beats on the beat grid.
// - the pre-drop dip: just before the drop the roll stops or the riser cuts (the loudness falls to about half for half
//   a bar or a beat). That puts the drop in the next bar and makes it sure.
//
// Hysteresis: a prediction, once made, stays put (no flapping between phrase lines) until the dip moves it, the drop
// comes, the predicted time passes without one (then the next phrase line, once; then it is dropped), or the build-up
// fizzles out (no riser for 2 s). docs/internals/live-analyser.md (Drop countdown) has the numbers.
//
// next: the predicted drop time on the analyser's clock (seconds) or null; conf: 0..1.

const BLOCK = 0.25, WIN = 16; // blocks of 0.25 s; slopes over the last 4 s
const clamp = v => v < 0 ? 0 : v > 1 ? 1 : v;
function slope(ys, n) { // least-squares slope of the last n values (x = block index, so per block)
  const m = ys.length, k = Math.min(n, m); if (k < 4) return 0; let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < k; i++) { const y = ys[m - k + i]; sx += i; sy += y; sxx += i * i; sxy += i * y; }
  const d = k * sxx - sx * sx; return d ? (k * sxy - sx * sy) / d : 0;
}
// the styles a drop countdown is for; calm and emotional songs only when it is very sure
const LOUD_STYLES = new Set(["party", "poprock", "hiphop"]);

export class DropPredictor {
  constructor() { this.reset(); }
  reset() {
    this.blk = { n: 0, c: 0, cw: 0, hi: 0, all: 0, rms: 0, t0: null }; // the block being gathered
    this.cent = []; this.hiE = []; this.allE = []; this.snr = []; this.lvl = []; // one value per block (last ~6 s)
    this.score = 0; this.riserOn = false; this.runT = null; this.offT = null; this.onT = null;
    this.dip = null; this.pred = null; this.misses = 0;
    this.anchorT = null; this.anchorKind = null; this.musicT = null; this.quietT = -9; this.dropCand = null; this.lastPred = null; this.lastDropT = -9; this.silentT = 0; this.wasSilent = true; this.armed = true; this.soundT = null;
    this.next = null; this.conf = 0; this.log = []; // log: the last predictions and how they ended (for evaluation): {at, why, made, first, heard|missed|fizzled}
  }

  /** One analysis hop. a: the LiveAnalyser (its band levels, loudness, snares, beat grid and song part). */
  hop(a, t) {
    const b = this.blk, bv = a.bandV, lo = a.bandLo, hi = a.bandHi, hz = a.binHz;
    if (b.t0 == null) b.t0 = t;
    if (this.armed && a.rms > 0.0015) { this.armed = false; this.soundT = t; } // the first sound after a silence: a song starts
    // spectral centroid over 200 Hz-10 kHz and the energy above 3 kHz, from the 24 band levels (bins x mean level)
    let cs = 0, cw = 0, he = 0, ae = 0;
    for (let k = 0; k < bv.length; k++) { const n = hi[k] - lo[k] + 1, f = (lo[k] + hi[k]) / 2 * hz, s = bv[k] * n, e = bv[k] * bv[k] * n;
      if (f >= 200) { cs += s * f; cw += s; } if (f >= 3000) he += e; ae += e; }
    if (cw > 0) { b.c += Math.log2(cs / cw); b.cw++; } b.hi += Math.log10(he + 1e-12); b.all += Math.log10(ae + 1e-12); b.rms += a.rms; b.n++;
    if (t - b.t0 >= BLOCK - 1e-6) { this.block(a, t); b.n = 0; b.c = 0; b.cw = 0; b.hi = 0; b.all = 0; b.rms = 0; b.t0 = t; }
  }

  block(a, t) {
    const b = this.blk, keep = WIN + 8, push = (arr, v) => { arr.push(v); if (arr.length > keep) arr.shift(); };
    if (this.log.length > 32) this.log.splice(0, this.log.length - 32);
    push(this.cent, b.cw ? b.c / b.cw : (this.cent.at(-1) ?? 0)); push(this.hiE, b.hi / b.n); push(this.allE, b.all / b.n);
    let sn = 0; for (let i = a.snares.length - 1; i >= 0 && t - a.snares[i] < 1; i--) sn++; push(this.snr, sn);
    push(this.lvl, b.rms / b.n);
    // a new song (after 3 s of silence): forget the phrase anchor and anything predicted
    if (a.state === "silent") { this.silentT += BLOCK; if (this.silentT >= 3) { this.wasSilent = true; this.armed = true; this.cancel(); this.anchorT = null; this.anchorKind = null; } }
    else { if (this.wasSilent) { this.wasSilent = false; this.musicT = this.soundT != null && t - this.soundT < 4 ? this.soundT : t; this.anchorT = null; this.anchorKind = "start"; } this.silentT = 0; }
    const B = a.beat, sure = B.has && B.conf > 0.35, P = B.P;
    // the phrase grid counts beats from an anchor: the song's start (weak: the app may have begun listening in the
    // middle of a song), or better the last drop heard. (Beats, not the grid's bar lines: without kicks the grid's
    // downbeat is often a beat or two out, its beats rarely are.)
    if (this.anchorKind === "start" && this.musicT != null) this.anchorT = this.musicT;
    // a drop heard. Near the predicted time (or with nothing predicted): the drop came, it anchors the phrase grid and
    // the prediction is done. Far from it, during a build-up that goes on: a snare roll's loud stretch read as a drop
    // too soon; the prediction stands.
    // A drop anchors the phrase grid once it has lasted 2 bars (the live analyser sometimes calls a loud bit of an
    // intro a drop for a moment), at the predicted time when it came within a bar of it (the prediction sits on the
    // beat grid; the drop is heard a little late).
    if (a.dropT > this.lastDropT + 1) { this.lastDropT = a.dropT; const p = this.pred || (this.lastPred && t - this.lastPred.at < 8 * P ? this.lastPred : null);
      if (!this.pred || Math.abs(a.dropT - this.pred.at) < 4 * P || !this.riserOn) {
        this.dropCand = p && a.dropT - p.at > -2 * P && a.dropT - p.at < 4 * P ? p.at : a.dropT; this.quietT = t + 3; // (no new riser in the drop's first seconds)
        if (this.pred) this.log.push({ ...this.pred, heard: a.dropT }); this.cancel(true); this.lastPred = null; } }
    if (this.dropCand != null) { if (a.state !== "drop") this.dropCand = null; else if (t - this.dropCand >= 8 * P) { this.anchorT = this.dropCand; this.anchorKind = "drop"; this.dropCand = null; } }

    // the riser score, as in the prototype (lab/structure/exp2c_riser.mjs): rising centroid x rising highs, and
    // accelerating snares while both rise (slopes per second); a little more when the song part reads as a build-up
    const k = 1 / BLOCK, cS = slope(this.cent, WIN) * k, hS = slope(this.hiE, WIN) * k, oS = slope(this.snr, WIN) * k;
    let score = this.allE.length >= 8 && !(t < this.quietT) ? 0.6 * Math.sqrt(clamp(cS / 0.12) * clamp(hS / 0.15)) + 0.4 * clamp(oS / 0.6) * (cS > 0 && hS > 0 ? 1 : 0) : 0;
    if (score > 0.3 && a.state === "build") score += 0.15;
    this.score = score;
    // on once held over 0.6 for 2 s; off (the build-up fizzled) once under 0.2 for 2 s
    if (score > 0.6) { if (this.runT == null) this.runT = t; this.offT = null; if (!this.riserOn && t - this.runT >= 2 - 1e-6) { this.riserOn = true; this.onT = t; } }
    else { this.runT = null; if (score < 0.2) { if (this.offT == null) this.offT = t; } else this.offT = null; }
    if (this.riserOn && this.offT != null && t - this.offT >= 2 && !this.dip) { this.riserOn = false; this.onT = null; if (this.pred) this.log.push({ ...this.pred, fizzled: t }); this.cancel(); }

    // the pre-drop dip: after a steady stretch of the build-up (the last second's blocks within 0.6x of each other: a
    // roll, a riser, not single hits with gaps), the loudness falls to under half of it, at once
    const L = this.lvl, building = this.riserOn || (this.pred && t < this.pred.at);
    if (building && !this.dip && sure && this.onT != null && t - this.onT >= 0.5 && L.length > 5) {
      const prev = L.slice(-5, -1); let pk = 0, lo = Infinity; for (const v of prev) { pk = Math.max(pk, v); lo = Math.min(lo, v); }
      if (L.at(-1) < 0.5 * pk && lo > 0.6 * pk && pk > 0.002) {
        // the drop is in the next bar: the predicted time if it is there (a dip heard late, at the drop itself), else a
        // phrase line of the anchor's grid, else the grid's next bar line
        const p = this.pred, iA = this.anchorT != null ? this.beatOf(B, this.anchorT) : null; let at = null;
        if (p && p.at - t > -0.15 && p.at - t < 4 * P) at = p.at;
        else if (iA != null) for (let i = this.beatOf(B, t + 0.05); i <= this.beatOf(B, t + 4 * P); i++) { const x = B.off + i * P; if (x > t + 0.05 && ((i - iA) % 16 + 16) % 16 === 0) { at = x; break; } }
        if (at == null) { const x = this.barLineAfter(B, t + 0.05); if (x - t < 4 * P * 1.05) at = x; }
        if (at != null) { this.dip = { t, at }; this.setPred(at, "dip", 1, t); }
      }
    }

    // predict: when the riser is on, the first likely phrase line ahead (kept until something says otherwise)
    if (!sure) { if (!this.dip) { this.next = null; this.conf = 0; } return; }
    if (this.riserOn && !this.pred) this.choose(B, t);
    // the predicted time passed and no drop came: once more at the next phrase line if the build-up goes on, else stop
    if (this.pred && t > this.pred.at + 0.6 * P) {
      this.log.push({ ...this.pred, missed: t }); this.lastPred = this.pred;
      if (this.riserOn && this.misses < 1 && !this.dip) { this.misses++; this.pred = null; this.choose(B, t); } else this.cancel(true); // (after a dip: wait for a new riser)
    }
    this.next = this.pred ? this.pred.at : null;
    this.conf = this.pred ? this.confidence(a, B, t) : 0;
  }

  // the phrase lines ahead, at least a bar away: every 4 bars (16 beats) from the anchor, scored by how well they sit
  // on the phrase grid (16 or 8 bars from it better) and by how near they are (a riser rarely runs more than 8 bars).
  // With no anchor, the grid's bar lines.
  choose(B, t) {
    const P = B.P, bar = 4 * P, iA = this.anchorT != null ? this.beatOf(B, this.anchorT) : null, far = 8 * bar; let best = null, bs = -1;
    const near = (x, al) => { const s = al * Math.exp(-(x - t) / far); if (s > bs) { bs = s; best = { at: x, align: al }; } };
    if (iA != null) { const i0 = this.beatOf(B, t + 0.75 * bar), m0 = Math.ceil((i0 - iA) / 16);
      for (let m = m0; m < m0 + 8; m++) { const x = B.off + (iA + 16 * m) * P; if (x < t + 0.75 * bar) continue; near(x, m % 4 === 0 ? 1 : m % 2 === 0 ? 0.95 : 0.55); } }
    else for (let x = this.barLineAfter(B, t + 0.75 * bar), i = 0; i < 4; i++, x += bar) near(x, i === 0 ? 0.5 : 0.3);
    if (best) this.setPred(best.at, "phrase", best.align, t);
  }
  setPred(at, why, align, t) {
    if (this.pred && Math.abs(this.pred.at - at) < 0.05) { this.pred.why = why; return; }
    this.pred = { at, why, align, made: t, first: this.pred ? this.pred.first : t }; this.next = at;
  }
  confidence(a, B, t) {
    const held = this.onT != null ? clamp((t - this.onT) / 3) : 0, p = this.pred;
    let c = 0.3 + 0.2 * held + 0.15 * clamp(this.score / 0.8) + 0.15 * (p.align >= 0.9 ? 1 : p.align >= 0.5 ? 0.5 : 0)
      + 0.15 * (this.anchorKind === "drop" ? 1 : this.anchorT != null ? 0.5 : 0) - 0.15 * this.misses;
    if (this.dip) c = Math.max(c, 0.9);
    c *= clamp((B.conf - 0.3) / 0.4);
    // calm and emotional songs: only when very sure. Before the style is known: drums (hi-hats, snares) make it a
    // song for a countdown, a drumless one (a ballad) is calm
    let st = a.style; if (!st) { const span = Math.max(1, Math.min(8, t - (this.musicT ?? 0))); let n = 0; for (let i = a.hats.length - 1; i >= 0 && t - a.hats[i] < span; i--) n++; st = n / span > 1.5 ? "party" : "chill"; }
    if (!LOUD_STYLES.has(st)) c = c >= 0.85 ? c : 0;
    return Math.round(clamp(c) * 100) / 100;
  }
  cancel(done = false) { this.pred = null; this.dip = null; this.misses = 0; this.next = null; this.conf = 0; if (done) { this.riserOn = false; this.onT = null; this.runT = null; } }
  beatOf(B, x) { return Math.round((x - B.off) / B.P); }

  // bar lines on the grid: the one nearest x, or the first after x
  barLine(B, x, mode) { const i = Math.round((x - B.off) / B.P), j = i - ((((i - B.barOff) % 4) + 4) % 4); const a = B.off + j * B.P, b = a + 4 * B.P; return mode === "round" ? (x - a < b - x ? a : b) : a; }
  barLineAfter(B, x) { let y = this.barLine(B, x, "floor"); while (y <= x) y += 4 * B.P; return y; }
}
