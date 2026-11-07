// Learning the song while it plays: like a human operator, after the first chorus or drop, expect the next one at the
// same point. Pure JavaScript, no I/O, no Node.js modules (it runs in the browser too). The LiveAnalyser (live.js)
// calls hop() every analysis hop (as `an.repeat`); view() goes into the live view as `V.repeat`; cue() feeds the drop
// countdown (drops.js) a drop time with source "repeat".
//
// - Units: one per bar of the live beat grid once the tempo has held for 8 s (within 3 %), else fixed 2 s windows.
//   Each unit keeps chroma (12), 8 band energies (log), onset strength, kicks and snares per second and loudness.
// - Similarity: a new unit is compared with every earlier unit of the same kind (and length): the cosine of the
//   centred chroma, and a cosine-style kernel on the z-scored rest (1 - squared distance / 2 dims: 1 the same, about 0
//   unrelated), half each. One row of similarities per unit, by lag; at most ~0.1 ms per unit.
// - Sections: novelty between the 4 units before and the 4 after each unit line (1 - cosine of the block means)
//   peaks at a section change; confirmed 6 units later. Each section gets a letter (A, B...): the letter of the earlier
//   section it repeats (A' when only fairly alike), else the next new one.
// - Matching: for every lag of at least 8 units, the last 4-8 units along that diagonal. A match needs 4 units in a
//   row at 0.6 or more, a mean well above the row's typical value, and a section change between the earlier stretch
//   and now (else it is just a loop within one section). The best lag wins (a little bonus for the nearer one).
// - Prediction: what followed the earlier stretch is what comes: its next section change (the part and letter after
//   it) and the next drop heard after it (within 16 units), at the same distance on the grid now. A prediction that
//   passes without the drop costs the match trust; the drop countdown takes the repeat's time over a riser's guess
//   from conf 0.5 (not over a pre-drop dip that disagrees).
// - New song: after 4 s of silence, when time goes backwards (a new source: the analyser was reset) or when
//   newSong() is called (song memory recognised another song). DJ mixes: units older than 8 minutes are forgotten, and
//   a new steady tempo (4 % away from the history's) starts a new history.
//
// docs/internals/live-analyser.md ("Learning the song while it plays") has the numbers.

const NC = 12, NBND = 8, ND = NC + NBND + 4; // chroma, bands, then onset, kicks/s, snares/s, loudness
const KEEP_S = 480, MAXU = 400, MINLAG = 8, LMIN = 4, LMAX = 8, W = 4;
const S_RUN = 0.6, NOV_ON = 0.45, AHEAD = 16;
const clamp = v => v < 0 ? 0 : v > 1 ? 1 : v;
const letter = n => n < 26 ? String.fromCharCode(65 + n) : "Z" + (n - 25);

export class RepeatLearner {
  constructor() { this.memId = undefined; this.reset("start"); }

  /** Forget everything (a new song). reason: why, kept in `resetReason` (start, silence, source, memory, tempo). */
  reset(reason = "manual") {
    this.units = []; this.base = 0; this.segs = []; this.bounds = []; this.nov = []; this.nLetters = 0;
    this.acc = null; this.hr = []; this.lastCount = -1; this.lastDropT = null; this.lastT = -Infinity;
    this.Pref = 0; this.stableT = null; this.kind = null;
    this.match = null; this.pred = null; this.missLag = new Map(); this.resetReason = reason; this.resets = (this.resets || 0) + 1;
    this.ms = 0; this.msMax = 0; this.nUnits = 0; this.slow = 0; // (time spent per unit, for the evaluation)
  }
  /** A new song for another reason (song memory recognised a different one): forget the history. */
  newSong(reason = "memory") { this.reset(reason); }

  /** One analysis hop. a: the LiveAnalyser (its bands, onset strength, kicks, snares, chroma, beat grid, part). */
  hop(a, t) {
    if (t < this.lastT - 0.5) this.reset("source"); this.lastT = t;
    if (a.memoryId !== this.memId) { if (this.memId !== undefined) this.reset("memory"); this.memId = a.memoryId; }
    if (this.lastDropT == null) this.lastDropT = a.dropT;
    if (a.state === "silent") { if (t - a.stateT > 4 && this.units.length) this.reset("silence"); this.acc = null; this.lastCount = a.ctap.count; return; }
    // the tempo: steady for 8 s (within 3 %) makes units bars
    // (once in bars, a grid that runs on through a break at the same tempo keeps them)
    const B = a.beat, wasBars = this.acc && this.acc.kind === "bar", same = this.Pref > 0 && Math.abs(B.P - this.Pref) / this.Pref < 0.03, ok = B.has && (B.conf > 0.3 || (wasBars && same));
    if (!ok) this.stableT = null;
    else if (!this.Pref || Math.abs(B.P - this.Pref) / this.Pref > 0.03) { this.Pref = B.P; this.stableT = t; }
    else { this.Pref += (B.P - this.Pref) * 0.02; if (this.stableT == null) this.stableT = t; }
    const bars = ok && this.stableT != null && (t - this.stableT >= 8 || (wasBars && same));
    // a new tempo held for 20 s, 4 % away from the history's bars and not a double, half, 3/2 or 4/3 of it (the tracker
    // changing its mind about the metric level): another song in a mix
    if (bars && this.stableT != null && t - this.stableT >= 20 && t - this.stableT < 20.5) { const last = this.lastBarUnit();
      if (last) { const r = last.P / B.P, rel = [1, 2, 0.5, 1.5, 2 / 3, 4 / 3, 0.75].some(x => Math.abs(r / x - 1) < 0.04); if (!rel) this.reset("tempo"); } }
    // this hop's features (kept for 16 s: when units become bars, the bars since the tempo steadied are made from them)
    const bv = a.bandV, rec = { t, b: new Float32Array(NBND), on: (a.fl || 0) + (a.fm || 0) + (a.fh || 0), rms: a.rms, st: a.state, c: null, drop: null };
    for (let k = 0; k < NBND; k++) rec.b[k] = bv[3 * k] + bv[3 * k + 1] + bv[3 * k + 2];
    const c = a.ctap; if (this.lastCount < 0) this.lastCount = c.count;
    const fresh = Math.min(c.frames.length, c.count - this.lastCount); this.lastCount = c.count;
    if (fresh > 0) { rec.c = new Float32Array(NC + 1); for (let i = c.frames.length - fresh; i < c.frames.length; i++) { const f = c.frames[i]; for (let k = 0; k < NC; k++) rec.c[k] += f[k]; rec.c[NC]++; } }
    if (a.dropT > this.lastDropT + 1) { this.lastDropT = a.dropT; rec.drop = a.dropT; }
    const hr = this.hr; hr.push(rec); while (hr.length && t - hr[0].t > 16) hr.shift();
    if (bars) { const g = a.grid(t), key = g.idx - g.beatInBar, start = g.beatT - g.beatInBar * g.P;
      if (this.acc && this.acc.kind === "time") this.toBars(a, start, key, g.P, t);
      else if (!this.acc || this.acc.kind !== "bar" || this.acc.key !== key) { this.close(this.acc && this.acc.kind === "bar" && key === this.acc.key + 4 ? start : null, a); this.open("bar", start, key, B.P); } }
    else if (!this.acc || this.acc.kind !== "time" || t - this.acc.t0 >= 2) { this.close(this.acc && this.acc.kind === "time" ? t : null, a); this.open("time", t, null, 2); }
    this.add(this.acc, rec);
  }
  add(u, r) {
    for (let k = 0; k < NBND; k++) u.b[k] += r.b[k];
    u.on += r.on; u.rms += r.rms; u.n++; u.parts[r.st] = (u.parts[r.st] || 0) + 1;
    if (r.c) { for (let k = 0; k < NC; k++) u.c[k] += r.c[k]; u.cn += r.c[NC]; }
    if (r.drop != null && u.drop == null) u.drop = r.drop;
  }
  // from 2 s windows to bars: the last 16 s are made again as bars (the steady grid, run backwards)
  toBars(a, start, key, P, t) {
    const bar = 4 * P, hr = this.hr, now = hr[hr.length - 1], from = Math.max(hr[0].t, t - 16); let n = 0; while (start - (n + 1) * bar >= from - 0.05) n++;
    const first = start - n * bar; let cut = this.units.length; while (cut > 0 && this.units[cut - 1].kind === "time" && this.units[cut - 1].t1 > first + 0.05) cut--;
    this.truncate(this.base + cut); this.acc = null;
    // a few bars at another tempo before (the tracker still settling): forget them, they'd only skew the statistics
    const lb = this.lastBarUnit(); if (lb && Math.abs(lb.P - P) / P > 0.04 && this.units.filter(u => u.kind === "bar").length < 16) this.truncate(this.base);
    for (let k = n; k >= 1; k--) { const b0 = start - k * bar; this.open("bar", b0, key - 4 * k, P); for (const r of hr) if (r.t >= b0 && r.t < b0 + bar && r !== now) this.add(this.acc, r); this.close(b0 + bar, a); }
    this.open("bar", start, key, P); for (const r of hr) if (r.t >= start && r !== now) this.add(this.acc, r);
  }
  // forget the units from id on (and the section lines and novelty that needed them)
  truncate(id) {
    if (id >= this.base + this.units.length) return; this.units.length = Math.max(0, id - this.base);
    this.nov = this.nov.filter(x => x.id <= id - W); this.bounds = this.bounds.filter(b => b <= id - W - 2);
    while (this.segs.length && this.segs[this.segs.length - 1].u0 > id - W - 2) this.segs.pop();
    const last = this.segs[this.segs.length - 1]; if (last && last.u1 != null && last.u1 > id - W - 2) { last.u1 = null; last.label = null; last.part = null; }
  }

  open(kind, t0, key, P) { this.acc = { kind, t0, key, P, b: new Float64Array(NBND), c: new Float64Array(NC), cn: 0, on: 0, rms: 0, n: 0, parts: {}, drop: null }; }
  lastBarUnit() { for (let i = this.units.length - 1; i >= 0; i--) if (this.units[i].kind === "bar") return this.units[i]; return null; }

  // a unit is done at t1 (null: cut short, thrown away; a drop heard in it moves to the next)
  close(t1, a) {
    const u = this.acc; if (!u) return;
    if (t1 == null || u.n < 4) return;
    const T0 = typeof performance !== "undefined" ? performance.now() : 0, dur = t1 - u.t0, f = new Float32Array(ND);
    for (let k = 0; k < NC; k++) f[k] = u.cn ? u.c[k] / u.cn : 0;
    for (let k = 0; k < NBND; k++) f[NC + k] = Math.log10(u.b[k] / u.n / 3 + 1e-7);
    let nk = 0, ns = 0; for (const x of a.kicks) if (x >= u.t0 && x < t1) nk++; for (const x of a.snares) if (x >= u.t0 && x < t1) ns++;
    f[NC + NBND] = u.on / u.n; f[NC + NBND + 1] = nk / dur; f[NC + NBND + 2] = ns / dur; f[NC + NBND + 3] = Math.log10(u.rms / u.n + 1e-6);
    let part = "calm", pn = -1; for (const [p, n] of Object.entries(u.parts)) if (n > pn) { pn = n; part = p; }
    // a drop counts where it follows another part (the analyser now and then calls a drop again in the middle of one)
    const prev = this.units[this.units.length - 1], drop = u.drop != null && !(prev && prev.part === "drop" && part === "drop") ? u.drop : null;
    const unit = { id: this.base + this.units.length, kind: u.kind, t0: u.t0, t1, P: u.P, f, part, drop, quiet: u.rms / u.n < 0.002, row: null, z: null, seg: null };
    this.units.push(unit); this.nUnits++;
    // forget by recency
    while (this.units.length > MAXU || (this.units.length && t1 - this.units[0].t1 > KEEP_S)) { this.units.shift(); this.base++; }
    this.compare(unit);
    this.sections();
    this.matchNow(unit);
    if (T0) { const ms = performance.now() - T0; this.ms += ms; this.msMax = Math.max(this.msMax, ms); if (ms > 1) this.slow++; }
  }

  // normalised features of every unit with the stats now (chroma centred and unit length; the rest z-scored)
  normalise() {
    const U = this.units, n = U.length, mu = new Float64Array(ND), sd = new Float64Array(ND); let m = 0;
    for (const u of U) { if (u.quiet) continue; m++; for (let k = NC; k < ND; k++) mu[k] += u.f[k]; }
    if (!m) return;
    for (let k = NC; k < ND; k++) mu[k] /= m;
    for (const u of U) if (!u.quiet) for (let k = NC; k < ND; k++) sd[k] += (u.f[k] - mu[k]) ** 2;
    for (let k = NC; k < ND; k++) sd[k] = Math.sqrt(sd[k] / m) + [0, 0, 0, 0, 0, 0, 0, 0, 0.05, 0.05, 0.05, 0.1][k - NC] + 0.05;
    for (let i = 0; i < n; i++) { const u = U[i], z = u.z || (u.z = new Float32Array(ND)); let cm = 0, cs = 0;
      for (let k = 0; k < NC; k++) cm += u.f[k]; cm /= NC; for (let k = 0; k < NC; k++) { z[k] = u.f[k] - cm; cs += z[k] * z[k]; }
      cs = Math.sqrt(cs); u.chroma = cs > 0.05; for (let k = 0; k < NC; k++) z[k] = cs > 0.05 ? z[k] / cs : 0;
      for (let k = NC; k < ND; k++) z[k] = (u.f[k] - mu[k]) / sd[k]; }
  }
  sim(a, b) {
    if (a.quiet || b.quiet || a.kind !== b.kind || Math.abs(a.t1 - a.t0 - (b.t1 - b.t0)) > 0.1 * (b.t1 - b.t0)) return -1;
    const za = a.z, zb = b.z; let d = 0, c = 0;
    for (let k = NC; k < ND; k++) d += (za[k] - zb[k]) ** 2;
    const st = Math.max(-1, 1 - d / (2 * (ND - NC)));
    if (!a.chroma || !b.chroma) return st;
    for (let k = 0; k < NC; k++) c += za[k] * zb[k];
    return 0.5 * c + 0.5 * st;
  }
  compare(u) {
    this.normalise(); const U = this.units, j = U.length - 1, row = new Float32Array(j + 1).fill(-1);
    for (let l = 1; l <= j; l++) row[l] = this.sim(u, U[j - l]);
    u.row = row;
  }
  S(j, l) { const u = this.units[j]; return u && u.row && l < u.row.length ? u.row[l] : -1; }

  // novelty at each unit line, section lines and their letters
  sections() {
    const U = this.units, n = U.length, b = n - W; // the line before unit b: blocks [b-W, b) and [b, b+W)
    if (b >= W) { const m1 = new Float64Array(ND), m2 = new Float64Array(ND); let ok = true;
      for (let k = 0; k < W; k++) { const p = U[b - W + k], q = U[b + k]; if (p.quiet || q.quiet || p.kind !== q.kind) { ok = false; break; } for (let d = 0; d < ND; d++) { m1[d] += p.z[d]; m2[d] += q.z[d]; } }
      let nv = 0; if (ok) { let d2 = 0; for (let d = 0; d < ND; d++) d2 += (d < NC ? 2 : 1) * ((m1[d] - m2[d]) / W) ** 2; nv = Math.sqrt(d2 / (ND - NC)); }
      this.nov.push({ id: U[b].id, v: nv });
      if (this.nov.length > MAXU) this.nov.shift();
    }
    // a peak, 2 lines either side, confirms a section line
    const N = this.nov, k = N.length - 3;
    if (k >= 2) { const c = N[k].v; if (c > NOV_ON && c >= N[k - 1].v && c >= N[k - 2].v && c > N[k + 1].v && c > N[k + 2].v) { const id = N[k].id; if (!this.bounds.length || id - this.bounds[this.bounds.length - 1] >= 2) this.newSection(id); } }
    if (this.bounds.length && this.bounds[0] < this.base - 2 * MAXU) this.bounds.shift();
  }
  newSection(id) {
    this.bounds.push(id);
    const prev = this.segs[this.segs.length - 1], from = prev ? prev.u0 : this.base;
    if (prev) { prev.u1 = id; this.finish(prev); } else this.segs.push(this.finish({ u0: from, u1: id, label: null }));
    this.segs.push({ u0: id, u1: null, label: null, part: null });
    if (this.segs.length > 64) this.segs.shift();
  }
  // a finished section: its part (most of its units) and letter (that of the earlier section it was matched with, else a new one)
  finish(s) {
    const U = this.units, parts = {};
    for (let id = s.u0; id < s.u1; id++) { const u = U[id - this.base]; if (u) parts[u.part] = (parts[u.part] || 0) + 1; }
    s.part = Object.entries(parts).sort((x, y) => y[1] - x[1])[0]?.[0] || "calm";
    if (!s.label) {
      // the letter most of its units were matched with (half of them at least), else a new one
      const votes = {}; let n = 0; for (let id = s.u0; id < s.u1; id++) { const u = U[id - this.base]; if (!u) continue; n++; if (u.mlabel) votes[u.mlabel] = (votes[u.mlabel] || 0) + 1; }
      const top = Object.entries(votes).sort((x, y) => y[1] - x[1])[0];
      s.label = top && top[1] >= n / 2 ? top[0] : letter(this.nLetters++);
    }
    return s;
  }
  segOf(id) { for (let i = this.segs.length - 1; i >= 0; i--) if (this.segs[i].u0 <= id) return this.segs[i]; return null; }

  // the best earlier stretch matching the last units, and what followed it
  matchNow(u) {
    const U = this.units, j = U.length - 1, maxLag = j - LMIN + 1; let best = null;
    if (j >= MINLAG + LMIN - 1 && !u.quiet) {
      let sum = 0, cnt = 0; const cand = [];
      for (let l = MINLAG; l <= maxLag; l++) {
        let run = 0, m = 0, long = 0; for (let k = 0; k < 64 && j - k - l >= 0; k++) { const s = this.S(j - k, l); if (s < S_RUN) break; if (k < LMAX) { run++; m += s; } long++; }
        let mm = 0, c = 0; for (let k = 0; k < LMIN && j - k - l >= 0; k++) { mm += Math.max(-1, this.S(j - k, l)); c++; } if (c) { sum += mm / c; cnt++; }
        if (run >= LMIN) cand.push({ l, run, long, m: m / run });
      }
      const typ = cnt ? sum / cnt : 0;
      // where the section playing now began (the strongest line of the last 8 units, confirmed or not): a lag that puts it on
      // an earlier section line (or the start of what was heard) is how a person lines the two up
      let cs = null, cv = NOV_ON; for (const x of this.nov) if (x.id > u.id - 8 && x.v >= cv) { cv = x.v; cs = x.id; }
      for (const c of cand) {
        // something else between the earlier stretch and now (else it is a loop inside one section)
        if (!this.gapDiffers(j, c.l, c.run)) continue;
        const contrast = c.m - Math.max(typ, 0.2), miss = this.missLag.get(c.l) || 0;
        const conf = clamp((c.m - S_RUN) / 0.25) * clamp(contrast / 0.3) * clamp((c.run - 1) / 3) * Math.pow(0.5, miss);
        // ranking: the surest, then the longest diagonal (the stretch that began where this one began), the lag already followed, the nearer
        const score = conf + (cs != null && (cs - c.l <= this.base + 1 || this.bounds.some(b => Math.abs(b - (cs - c.l)) <= 1)) ? 0.5 : 0) + 0.3 * Math.min(c.long, 32) / 32 + (this.match && this.match.l === c.l ? 0.2 : 0) + 0.002 * (MAXU - c.l) / MAXU; if (!best || score > best.score) best = { ...c, conf, score };
      }
    }
    // hysteresis: a match that keeps going holds for a unit when the best one drops away
    if (!best && this.match && this.S(j, this.match.l) >= S_RUN - 0.1 && !this.match.held) best = { ...this.match, conf: this.match.conf * 0.8, held: true };
    if (!best || best.conf < 0.2) { // no match now: a drop time already given stays put until it passes (as the countdown's)
      this.match = null; const p = this.pred;
      if (p && p.drop && p.drop.at > u.t1 && p.conf >= 0.5) { p.nextPart = p.nextPart && p.nextPart.at > u.t1 ? p.nextPart : null; p.kept = true; } else this.pred = null;
      return; }
    this.match = best; this.predict(u, best);
  }
  // between the earlier stretch and now, two units in a row unlike the current stretch (each one's best similarity to
  // it, 0.6 on average at most); else the match is a loop inside one section
  gapDiffers(j, l, run) {
    const w = [];
    for (let g = j - l + 1; g <= j - run; g++) { let mx = -1; for (let k = 0; k < run; k++) { const s = this.S(j - k, j - k - g); if (s > mx) mx = s; }
      if (this.units[g].quiet) { w.length = 0; continue; } w.push(mx); if (w.length > 2) w.shift(); if (w.length === 2 && w[0] + w[1] < 1.2) return true; }
    return false;
  }
  predict(u, M) {
    const U = this.units, i = u.id - M.l, uDur = u.kind === "bar" ? 4 * u.P : u.t1 - u.t0, P = u.kind === "bar" ? u.P : null;
    const tAt = id => u.t1 + (id - i - 1) * uDur; // the time unit id's twin starts now
    // the next section line after the earlier stretch (before now)
    const bnext = this.bounds.find(b => b > i + 1 && b <= u.id - 1 && b - i <= 4 * AHEAD), seg = bnext != null ? this.segs.find(s => s.u0 === bnext) : null;
    const nextPart = bnext != null ? { at: tAt(bnext), label: seg ? seg.label || this.provisional(seg) : null, part: seg ? seg.part || U[bnext - this.base]?.part || null : U[bnext - this.base]?.part || null, len: seg && seg.u1 != null ? (seg.u1 - seg.u0) * uDur : null } : null;
    // the next drop heard after it (the drop's place in its unit, on the beat grid)
    let drop = null;
    for (let id = i + 1; id <= Math.min(u.id - 1, i + AHEAD); id++) { const v = U[id - this.base]; if (!v || v.drop == null || id < 4 || !this.bounds.some(b => Math.abs(b - id) <= 1)) continue; // (a drop that began a section; not the song starting)
      let off = v.drop - v.t0; if (P) off = Math.round(off / P) * P; if (off > uDur * 0.9) off = 0;
      drop = { at: tAt(id) + off, from: v.drop }; break; }
    const cur = this.segOf(u.id), of = this.segOf(i), label = of ? (of.label || this.provisional(of)) : null;
    const lab = label && M.conf >= 0.5 ? label.replace(/'$/, "") + (M.m >= 0.75 ? "" : "'") : null; if (lab) u.mlabel = lab.replace(/'$/, "");
    if (cur && cur.u1 == null && cur.u0 <= u.id - M.run + 1 && lab) cur.of = lab; // (the open section, when it began before this run)
    const keep = this.pred && this.pred.drop && !drop && this.pred.drop.at > u.t1 ? this.pred.drop : null; // (a drop time given a unit ago still stands)
    this.pred = { conf: Math.round(M.conf * 100) / 100, lag: u.t0 - U[i - this.base].t0, matchAt: U[i - this.base].t1, made: u.t1, nextPart, drop: drop || keep, label: lab || label, P };
  }
  provisional(s) { return s.label || (s.of ? s.of : null); }

  /** Called by the drop countdown (drops.js) after each of its blocks: the repeat's drop time takes over from conf 0.5. */
  cue(dp, a, t) {
    const p = this.pred, d = p && p.drop, P = p && p.P ? p.P : 0.5;
    if (d && a.dropT > p.made && Math.abs(a.dropT - d.at) < 4 * P) { this.heard = d.at; p.drop = null; return this.uncue(dp); } // it came
    if (d && t > d.at + 4 * P) { const l = this.match ? this.match.l : 0; this.missLag.set(l, (this.missLag.get(l) || 0) + 1); p.drop = null; return this.uncue(dp); } // it didn't
    if (!d || p.conf < 0.5 || d.at - t > 40 || t > d.at + 0.6 * P || d.at === this.heard) return this.uncue(dp);
    if (dp.dip && Math.abs(dp.dip.at - d.at) > P * 1.5) return this.uncue(dp); // a pre-drop dip that says otherwise wins
    dp.next = d.at; dp.conf = Math.max(dp.conf, Math.min(0.95, 0.4 + 0.55 * p.conf)); dp.source = "repeat";
  }
  uncue(dp) { if (dp.source === "repeat") dp.source = null; }

  /** For the view: {matchAt, conf, nextPart, nextDropIn, label, lag} (null when nothing matches). */
  view(t) {
    const p = this.pred; if (!p) return null;
    const np = p.nextPart && p.nextPart.at > t - 0.25 ? { label: p.nextPart.label, part: p.nextPart.part, at: p.nextPart.at, in: Math.max(0, p.nextPart.at - t), len: p.nextPart.len } : null;
    return { matchAt: p.matchAt + (t - p.made), conf: p.conf, nextPart: np, nextDropIn: p.drop && p.drop.at > t - 0.25 ? Math.max(0, p.drop.at - t) : null, nextDropAt: p.drop ? p.drop.at : null, label: p.label, lag: p.lag, reuse: !!p.label };
  }

  /** The sections heard so far, for the song map: [{t0, t1, label, part}], the newest one open (t1: its last unit). */
  sectionList() {
    const U = this.units, out = [], at = id => U[id - this.base];
    for (const s of this.segs) { const a = at(s.u0) || U[0]; if (!a) continue; const b = s.u1 != null ? at(s.u1 - 1) : U[U.length - 1]; if (!b || b.t1 < a.t0) continue;
      out.push({ t0: a.t0, t1: b.t1, label: s.label || s.of || null, part: s.part || null, open: s.u1 == null }); }
    return out;
  }
}
