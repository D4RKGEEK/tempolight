// Live listening: turns a stream of audio samples into the same "view" of the music that whole-song analysis gives
// (beat grid, kick/snare/hi-hat hits, song part, loudness, style). Pure JavaScript, no I/O: the server feeds it
// samples from a sound card, ffmpeg or a browser, and tests feed it synthetic songs.
import { gridAt } from "./signals.js";
import { FingerprintTap } from "./memory.js";
import { ChromaTap, keyOf, moodOf, chordOf, chordFit } from "./tonal.js";
import { StereoTap } from "./stereo.js";
import { BeatTracker } from "./beat.js";
import { DropPredictor } from "./drops.js";
import { RepeatLearner } from "./repeat.js";

const NF = 1024, HOP = 256;
const EDGES = (() => { const e = []; for (let i = 0; i <= 24; i++) e.push(40 * Math.pow(10000 / 40, i / 24)); return e; })();
const NB = 24, LOW_B = 6, MID_B = 15; // onset bands: 0-5 kick (40-160 Hz), 6-14 body (160-1,250 Hz), 15-23 snare noise and hats
// low-pass FIR for decimating by D: a Blackman-windowed sinc cut at the output's Nyquist frequency (for D = 2 a
// half-band filter: every other tap is zero, so only the others are kept). {n: length, h: taps, at: their offsets}
function lowpass(D) { const n = D === 2 ? 43 : 79, fc = 0.5 / D, m = (n - 1) / 2, h = [], at = []; let s = 0;
  for (let i = 0; i < n; i++) { const x = i - m, w = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)) + 0.08 * Math.cos(4 * Math.PI * i / (n - 1)), v = (x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x)) * w;
    if (Math.abs(v) > 1e-7) { h.push(v); at.push(i); s += v; } }
  return { n, h: Float32Array.from(h, v => v / s), at: Int16Array.from(at) }; }
const pct = (arr, p) => { if (!arr.length) return 0; const s = Array.from(arr).sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

export class LiveAnalyser {
  /** @param {number} sr sample rate of the samples you will push (anything from 16 kHz to 96 kHz) */
  constructor(sr = 22050) {
    this.inRate = sr; this.dec = sr > 64000 ? 4 : sr > 32000 ? 2 : 1; this.sr = sr / this.dec;
    this.binHz = this.sr / NF; this.dtHop = HOP / this.sr;
    if (this.dec > 1) { this.fir = lowpass(this.dec); this.firBuf = new Float32Array(this.fir.n * 2); this.firPos = 0; }
    this.bandLo = new Int16Array(NB); this.bandHi = new Int16Array(NB); this.bandV = new Float32Array(NB);
    for (let b = 0; b < NB; b++) { this.bandLo[b] = Math.max(1, Math.floor(EDGES[b] / this.binHz)); this.bandHi[b] = Math.min(NF / 2 - 1, Math.ceil(EDGES[b + 1] / this.binHz)); }
    this.lb = [new Float32Array(NB), new Float32Array(NB), new Float32Array(NB)]; // log band levels, this hop and the 2 before
    this.beat = new BeatTracker(this.sr / HOP, NB);
    this.win = new Float32Array(NF); for (let i = 0; i < NF; i++) this.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / NF);
    this.re = new Float32Array(NF); this.im = new Float32Array(NF); this.mag = new Float32Array(NF / 2); this.prev = new Float32Array(NF / 2);
    this.rev = new Uint16Array(NF); for (let i = 0, j = 0; i < NF; i++) { this.rev[i] = j; let b = NF >> 1; while (j & b) { j ^= b; b >>= 1; } j |= b; }
    this.cosT = new Float32Array(NF / 2); this.sinT = new Float32Array(NF / 2);
    for (let i = 0; i < NF / 2; i++) { this.cosT[i] = Math.cos(-2 * Math.PI * i / NF); this.sinT[i] = Math.sin(-2 * Math.PI * i / NF); }
    this.ring = new Float32Array(NF); this.ringPos = 0; this.filled = 0; this.sinceHop = 0; this.decN = 0;
    this.wave = new Float32Array(256); this.tap = new FingerprintTap(); this.ctap = new ChromaTap(this.sr, 20, { bass: true }); this.chSum = new Float64Array(12); this.chBass = new Float64Array(12); this.hopN = 0; this._lite = false;
    this.reset();
  }
  /** Low-power mode (small computers): chroma every 2nd frame, the vocal estimate every 2nd hop. */
  get lite() { return this._lite; }
  set lite(v) { this._lite = !!v; this.ctap.lite = !!v; }

  reset() {
    this.samples = 0; this.t = 0; this.hasPrev = false; if (this.tap) this.tap.reset(); if (this.ctap) this.ctap.reset();
    this.keyAcc = new Float64Array(12); this.keyN = 0; this.keyCount = 0; this.keyEst = null; this.keyCand = null; this.brightS = null; this.mood = null; this.lastMoodT = -9;
    this.chord = null; this.chordBar = null; this.chordMiss = 0; this.chordCount = 0; if (this.stereo) this.stereo.reset(); this.stereoAt = -1e12;
    this.hist = { k: [], s: [], h: [] }; this.lowHist = []; this.votes = []; this.last = { k: -9, s: -9, h: -9 };
    this.kicks = []; this.snares = []; this.hats = []; this.pulseN = 0;
    if (this.beat) this.beat.reset(); this.lb?.forEach(a => a.fill(0)); this.kickM = 0; this.kickPeak = 0; this.kickOn = false; this.kickTop = 0; this.kickTops = new Float32Array(8); this.kickSort = new Float32Array(8); this.kickTopI = 0; this.kickTopN = 0; this.kickS = 1; this.lowMax = 1e-6; this.kCandT = -9; this.kPendN = 0; this.kPendT = 0; this.kPendR0 = 0; this.kPendRp = 0; this.sweepPrev = 1;
    this.levelS = "low"; this.levelT = -9; this.levelL = 0;
    this.eFast = 0; this.eSlow = 0; this.eMax = 1e-4; this.rms = 0;
    this.bass = 0; this.bassMax = 1e-4; this.mid = 0; this.high = 0; this.highMax = 1e-4;
    this.bands = new Float32Array(24); this.bandMax = new Float32Array(24).fill(1e-4); this.vocal = 0; this.vocalRaw = 0; this.pitchHist = []; this.ampHist = []; this.fade = 0;
    this.state = "silent"; this.cand2 = "silent"; this.candT = 0; this.stateT = 0; this.buildStart = 0; this.dropT = -9;
    this.domS = null; this.domHist = []; this.domHistT = -9; this.domBase = null; // domBase: pct(domHist, 0.3), kept until domHist changes
    this.styleStats = { env: [], envT: -9, drops: [] }; this.style = null; this.styleCand = null; this.styleN = 0; this.lastStyleT = -9; this.styleLock = null;
    if (this.drops) this.drops.reset(); else this.drops = new DropPredictor(); // the drop countdown (drops.js)
  }

  /**
   * Feed samples. Accepts Float32Array (-1..1) or Int16Array. channels 2: interleaved left/right; the analysis hears
   * them mixed, and a StereoTap keeps each side's level and low-band hits for the view's pan and lr (stereoOn = false:
   * mixed only).
   */
  push(chunk, channels = 1) {
    if (channels === 2) {
      const k2 = chunk instanceof Int16Array ? 1 / 32768 : 1, n = chunk.length >> 1; let m = this.monoBuf; if (!m || m.length < n) m = this.monoBuf = new Float32Array(n);
      const tap = this.stereoOn === false ? null : this.stereo || (this.stereo = new StereoTap(this.inRate));
      if (tap) { for (let i = 0; i < n; i++) { const l = chunk[2 * i] * k2, r = chunk[2 * i + 1] * k2; m[i] = (l + r) * 0.5; tap.push(l, r); } this.stereoAt = this.samples; }
      else for (let i = 0; i < n; i++) m[i] = (chunk[2 * i] + chunk[2 * i + 1]) * 0.5 * k2;
      chunk = m.subarray(0, n);
    }
    const isInt = chunk instanceof Int16Array, k = isInt ? 1 / 32768 : 1;
    for (let i = 0; i < chunk.length; i++) {
      let v = chunk[i] * k;
      if (this.dec > 1) { // low-pass, then keep every dec-th sample (no aliasing of cymbals into the hat band)
        const fb = this.firBuf, L = this.fir.n; fb[this.firPos] = fb[this.firPos + L] = v; this.firPos = (this.firPos + 1) % L;
        if (++this.decN < this.dec) continue; this.decN = 0;
        const h = this.fir.h, at = this.fir.at, o = this.firPos; v = 0; for (let j = 0; j < h.length; j++) v += h[j] * fb[o + at[j]];
      }
      this.ctap.push(v); // chroma, for the key, the mood and song memory
      this.ring[this.ringPos] = v; this.ringPos = (this.ringPos + 1) & (NF - 1); this.samples++;
      if (this.filled < NF) this.filled++;
      if (++this.sinceHop >= HOP && this.filled >= NF) { this.sinceHop = 0; this.hop(); }
    }
  }

  fft() {
    const { re, im, rev, cosT, sinT } = this;
    for (let i = 0; i < NF; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= NF; size <<= 1) { const h = size >> 1, step = NF / size;
      for (let s = 0; s < NF; s += size) for (let q = 0; q < h; q++) {
        const c = cosT[q * step], sn = sinT[q * step], a = s + q, b = a + h;
        const tr = re[b] * c - im[b] * sn, ti = re[b] * sn + im[b] * c;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti; } }
  }
  bandMag(lo, hi) { const m = this.mag; let s = 0; const a = Math.max(1, Math.floor(lo / this.binHz)), b = Math.min(m.length - 1, Math.ceil(hi / this.binHz)); for (let i = a; i <= b; i++) s += m[i]; return s / (b - a + 1); }
  flux(lo, hi) { const m = this.mag, p = this.prev; let s = 0; const a = Math.max(1, Math.floor(lo / this.binHz)), b = Math.min(m.length - 1, Math.ceil(hi / this.binHz)); for (let i = a; i <= b; i++) { const d = m[i] - p[i]; if (d > 0) s += d; } return s; }
  detect(key, val, t, refr, k) {
    const h = this.hist[key]; h.push(val); if (h.length > 70) h.shift();
    let m = 0; for (const v of h) m += v; m /= h.length; let sd = 0; for (const v of h) sd += (v - m) ** 2; sd = Math.sqrt(sd / h.length);
    if (val > m + k * sd && val > m * 1.4 && val > 1e-4 && t - this.last[key] > refr) { this.last[key] = t; return true; }
    return false;
  }

  hop() {
    const { re, im, win, ring, mag } = this; let rms = 0;
    for (let i = 0; i < NF; i++) { const v = ring[(this.ringPos + i) & (NF - 1)]; re[i] = v * win[i]; im[i] = 0; rms += v * v; }
    for (let i = 0; i < 256; i++) this.wave[i] = ring[(this.ringPos + NF - 256 + i) & (NF - 1)];
    rms = Math.sqrt(rms / NF); this.rms = rms;
    this.tap.push(this.samples / this.sr, rms); // for recognising remembered songs
    this.fft(); for (let i = 0; i < mag.length; i++) { const a = re[i], b = im[i]; mag[i] = Math.sqrt(a * a + b * b) / NF; } // (Math.hypot is several times slower)
    const t = this.t = this.samples / this.sr - NF / 2 / this.sr, dt = this.dtHop;
    // 24 log bands (40 Hz-10 kHz): levels for effects, and log-compressed for the onset curve
    const bv = this.bandV, lb2 = this.lb[2]; this.lb[2] = this.lb[1]; this.lb[1] = this.lb[0]; this.lb[0] = lb2; const cur = lb2, ref = this.lb[2];
    for (let b = 0; b < NB; b++) { let s = 0; const lo = this.bandLo[b], hi = this.bandHi[b]; for (let i = lo; i <= hi; i++) s += mag[i]; bv[b] = s / (hi - lo + 1); cur[b] = Math.log1p(3000 * bv[b]); }
    if (!this.hasPrev) { this.prev.set(mag); this.hasPrev = true; this.lb[1].set(cur); this.lb[2].set(cur); return; }
    const loudEnough = rms > 0.0015;
    // onset strength, SuperFlux style: each band's rise against the max of it and its neighbours two hops ago
    // (a vibrato or a slide doesn't count), summed per band group
    let fl = 0, fm = 0, fh = 0, fs = 0;
    for (let b = 0; b < NB; b++) { let r = ref[b]; if (b > 0 && ref[b - 1] > r) r = ref[b - 1]; if (b < NB - 1 && ref[b + 1] > r) r = ref[b + 1]; const d = cur[b] - r;
      if (d > 0) { if (b < LOW_B) { fl += d; if (b < LOW_B - 1) fs += d; } else if (b < MID_B) fm += d; else fh += d; } }
    fl /= LOW_B; fm /= MID_B - LOW_B; fh /= NB - MID_B;
    if (!loudEnough) { fl *= 0.2; fm *= 0.2; fh *= 0.2; }
    this.fl = fl; this.fm = fm; this.fh = fh;
    const sf = this.flux(180, 320) * 0.6 + this.flux(1800, 5000) * 0.4, hf = this.flux(7000, 10500);
    // a kick: the low bands' onset strength (their log rise) well above the background between hits and near the
    // recent strongest ones. No "the level must jump" test: under a sidechained or sustained bass the level hardly
    // moves, but the log rise still shows. More than the body bands', and more than the highs' unless it is a strong
    // one (a snare alone is noise that rises in every band; a kick with a snare rises much more down low).
    // It must also carry real low energy (a pluck's click rises a lot in log terms in a quiet low band), and the
    // detector re-arms once the rise has fallen to half its peak (the swell of a sidechain pump keeps rising).
    let lowLvl = 0; for (let b = 0; b < LOW_B; b++) lowLvl += bv[b]; lowLvl /= LOW_B; this.lowLvl = lowLvl; this.lowMax = Math.max(this.lowMax * Math.pow(0.5, dt / 8), lowLvl, 1e-6);
    const bg = this.kickM, above = fl > 4 * bg + 0.05 && fl > 0.35 * this.kickPeak && fl > 0.15;
    const cand = above && !this.kickOn && t - this.kCandT > 0.2 && loudEnough && fs > 0.5 * fl * LOW_B && lowLvl > 0.05 * this.lowMax && fl > 0.8 * fm && (fl > 1.3 * fh || (this.kickTopN >= 3 && fl > 0.6 * this.kickPeak));
    if (cand || (this.kickOn && fl > this.kickTop)) this.kickTop = fl;
    if (cand) { this.kickOn = true; this.kCandT = t; } else if (this.kickOn && (fl < 0.5 * this.kickTop || !above)) this.kickOn = false;
    this.kickM += (fl - bg) * (fl < bg ? 0.2 : 0.01); // the background: falls fast, rises slowly
    // ...and a kick drum's pitch falls (from ~130 Hz to ~50 Hz within a few hundred ms) where a bass note's doesn't:
    // confirmed up to 5 hops (~58 ms) later once the energy below 80 Hz, against 80-160 Hz, has grown to 3x its share
    // at the onset or just before it, and to 1.4x its share at the onset (a snare's noise lifts both at once). It keeps
    // its onset time.
    const sweep = (bv[0] + bv[1] + bv[2]) / (bv[3] + bv[4] + bv[5] + 1e-9); let kick = false, kickT = t, back = 0;
    if (this.kPendN > 0) { back = this.kPendN++;
      if (sweep > 3 * this.kPendRp && sweep > 1.4 * this.kPendR0) { kick = true; kickT = this.kPendT; this.kPendN = 0; } else if (this.kPendN > 5) this.kPendN = 0; }
    if (cand && this.kPendN === 0 && !kick) { this.kPendT = t; this.kPendR0 = sweep; this.kPendRp = Math.min(sweep, this.sweepPrev); this.kPendN = 1; }
    this.sweepPrev = sweep;
    if (kick) { // how strong kicks are lately: the median of the last 8 kicks' peaks (a riser or a snare roll can't raise it)
      this.last.k = kickT; this.kickTops[this.kickTopI] = this.kickTop; this.kickTopI = (this.kickTopI + 1) & 7;
      const n = this.kickTopN = Math.min(8, this.kickTopN + 1), s = this.kickSort;
      for (let i = 0; i < n; i++) { const v = this.kickTops[i]; let j = i; while (j > 0 && s[j - 1] > v) { s[j] = s[j - 1]; j--; } s[j] = v; }
      this.kickPeak = s[n >> 1]; this.kickS = Math.min(1, this.kickTop / (1.25 * this.kickPeak));
    }
    this.beat.push(t, 1.0 * fl + 1.0 * fm + 0.5 * fh, fl, fm, fh, cur);
    if (kick) this.beat.markKick(back);
    // snares and hi-hats are noisy: they need real energy up high, or piano and guitar attacks would count as drums
    const refB = Math.max(1e-7, this.bandMag(100, 2000)), noisy = this.bandMag(1800, 5000) / refB, airy = this.bandMag(7000, 10500) / refB;
    const snare = this.detect("s", sf, t, 0.14, 1.8) && loudEnough && noisy > 0.05, hat = this.detect("h", hf, t, 0.07, 1.4) && loudEnough && airy > 0.015;
    if (kick) { this.kicks.push(kickT); this.pulseN++; }
    if (snare) this.snares.push(t);
    if (hat) this.hats.push(t);
    while (this.kicks.length && t - this.kicks[0] > 30) this.kicks.shift();
    while (this.snares.length && t - this.snares[0] > 30) this.snares.shift();
    while (this.hats.length && t - this.hats[0] > 30) this.hats.shift();
    this.prev.set(mag);
    const ef = 1 - Math.exp(-dt / 0.25), es = 1 - Math.exp(-dt / 4);
    this.eFast += (rms - this.eFast) * ef; this.eSlow += (rms - this.eSlow) * es; if (this.eSlow < this.eFast * 0.3) this.eSlow = this.eFast * 0.3 + this.eSlow * 0.7; this.eMax = Math.max(this.eMax * Math.pow(0.97, dt), this.eFast, 0.004);
    const bass = this.bandMag(40, 150), high = this.bandMag(4000, 10000);
    this.bass += (bass - this.bass) * (1 - Math.exp(-dt / 0.15)); this.bassMax = Math.max(this.bassMax * Math.pow(0.97, dt), this.bass);
    this.high += (high - this.high) * (1 - Math.exp(-dt / 0.3)); this.highMax = Math.max(this.highMax * Math.pow(0.97, dt), this.high);
    this.mid += (this.bandMag(300, 2000) - this.mid) * (1 - Math.exp(-dt / 0.3));
    const bandDecay = Math.pow(0.9, dt);
    for (let b = 0; b < NB; b++) {
      const v = bv[b]; this.bandMax[b] = Math.max(this.bandMax[b] * bandDecay, v, 1e-5);
      const nv = loudEnough ? Math.min(1, v / this.bandMax[b]) : 0; this.bands[b] += (nv - this.bands[b]) * (nv > this.bands[b] ? 0.7 : 0.25);
    }
    if (!this._lite || (++this.hopN & 1)) this.vocalHop(loudEnough, this._lite ? dt * 2 : dt); // (lite: every 2nd hop, covering two)
    this.sections(t, dt);
    (this.repeat ||= new RepeatLearner()).hop(this, t); // learning the song while it plays (repeat.js): V.repeat, and a drop cue
    this.drops.hop(this, t);
    this.levels(t);
    if (t - this.lastStyleT > 2) { this.lastStyleT = t; this.estimateStyle(t); }
    if (t - this.lastMoodT > 2) { this.lastMoodT = t; this.estimateMood(t); }
    if (this.ctap.count !== this.chordCount) { this.chordCount = this.ctap.count; this.liveChord(); }
  }

  // the loudness level for the view: from the loudness smoothed over ~1 s (it swings with every beat), with hysteresis
  // (0.05 either side of 0.4 and 0.75), and held for at least 1 s
  levels(t) {
    this.levelL += (Math.min(1, this.eFast / this.eMax) - this.levelL) * (1 - Math.exp(-this.dtHop / 1.0)); const loud = this.levelL, cur = this.levelS, h = 0.05;
    const raw = cur === "low" ? (loud >= 0.75 + h ? "peak" : loud >= 0.4 + h ? "mid" : "low")
      : cur === "mid" ? (loud >= 0.75 + h ? "peak" : loud < 0.4 - h ? "low" : "mid")
      : (loud < 0.4 - h ? "low" : loud < 0.75 - h ? "mid" : "peak");
    if (raw !== cur && t - this.levelT >= 1) { this.levelS = raw; this.levelT = t; }
  }

  // Is someone singing? A voice is a clear tone in the 150-1000 Hz range whose pitch wanders (vibrato, melody),
  // with its harmonics and formants filling 300-3,500 Hz. Drums are noisy (no tone); a steady synth pad has a tone that
  // doesn't move. So: tonality in the vocal band, times how much that band carries, times pitch movement.
  vocalHop(loud, dt) {
    const m = this.mag, a = Math.max(1, Math.floor(250 / this.binHz)), b = Math.min(m.length - 2, Math.ceil(3500 / this.binHz));
    let sum = 0, logSum = 0, peaks = 0, n = 0;
    for (let i = a; i <= b; i++) { const v = m[i] + 1e-9; sum += v; logSum += Math.log(v); n++; if (m[i] > m[i - 1] && m[i] >= m[i + 1] && m[i] > 3 * (m[i - 2] + m[i + 2] + 1e-9) / 2) peaks += m[i]; }
    const flat = Math.exp(logSum / n) / (sum / n), tonal = Math.max(0, Math.min(1, 1 - flat * 1.6)), peakShare = peaks / sum;
    const share = this.bandMag(250, 3500) / Math.max(1e-7, this.bandMag(40, 250) * 0.5 + this.bandMag(250, 3500) + this.bandMag(3500, 10000));
    // pitch: the strongest peak in 150-1000 Hz, to a fraction of a bin (parabolic fit), tracked for half a second
    const pa = Math.max(2, Math.floor(150 / this.binHz)), pb = Math.ceil(1000 / this.binHz); let pi = pa; for (let i = pa; i <= pb; i++) if (m[i] > m[pi]) pi = i;
    const y0 = Math.log(m[pi - 1] + 1e-9), y1 = Math.log(m[pi] + 1e-9), y2 = Math.log(m[pi + 1] + 1e-9), off = Math.max(-0.5, Math.min(0.5, 0.5 * (y0 - y2) / (y0 - 2 * y1 + y2 || 1e-9)));
    // ...and that peak's level (log, corrected for where it falls between FFT bins)
    const ph = this.pitchHist, ah = this.ampHist; ph.push(m[pi] > 1e-5 ? Math.log2((pi + off) * this.binHz) : 0); ah.push(y1 - 0.25 * (y0 - y2) * off); if (ph.length > Math.round(0.5 / dt)) { ph.shift(); ah.shift(); }
    // a singer's pitch moves smoothly (vibrato, slides); two notes of a chord fighting for the top spot jump back and forth
    let d1 = 0, d2 = 0, prevD = null, fall = 0, nf = 0;
    for (let i = 1; i < ph.length; i++) { const d = ph[i] - ph[i - 1]; if (!ph[i] || !ph[i - 1] || Math.abs(d) > 0.06) { prevD = null; continue; } d1 += Math.abs(d); if (prevD != null) d2 += Math.abs(d - prevD); prevD = d;
      const da = ah[i] - ah[i - 1]; if (Math.abs(da) < 0.25) { fall -= da; nf++; } } // (a note's attack is a jump: left out)
    // a guitar note with vibrato wanders like a voice, but it was plucked: it fades away (over ~10 dB a second) where a
    // sung note is held. (A synth lead with vibrato still passes for a voice when it plays alone; over drums it doesn't.)
    this.fade = nf > 2 ? fall / nf / dt : 0; const held = Math.max(0, Math.min(1, (1.2 - this.fade) / 0.7));
    const wander = Math.min(1, d1 / 0.08) * Math.max(0, Math.min(1, (1.1 - d2 / Math.max(1e-6, d1)) / 0.6));
    const raw = loud ? Math.min(1, peakShare * 2.5) * Math.min(1, share * 1.6) * wander * held * (0.5 + 0.5 * tonal) : 0;
    this.vocalRaw = raw; this.vocal += (Math.min(1, raw * 2.2) - this.vocal) * (1 - Math.exp(-dt / 0.25));
  }

  sections(t, dt) {
    const loud = this.eFast / this.eMax, kickRecent = t - this.last.k < 0.9;
    const dom = Math.log10(Math.max(1e-7, this.bass) / Math.max(1e-7, this.mid));
    this.domS = this.domS == null ? dom : this.domS + (dom - this.domS) * (1 - Math.exp(-dt / 0.4));
    if (t - this.domHistT > 0.1 && loud > 0.06) { this.domHistT = t; this.domHist.push(this.domS); if (this.domHist.length > 300) this.domHist.shift(); this.domBase = null; }
    if (this.domBase == null && this.domHist.length) this.domBase = pct(this.domHist, 0.3); // (sorted again only when it changed, 10 times a second at most)
    const base = this.domHist.length ? this.domBase : this.domS, bass = (this.domS - base > 0.5 && this.domHist.length > 25) ? 1 : 0;
    const snareRate = this.snares.filter(x => t - x < 2).length / 2, kicks2 = this.kicks.filter(x => t - x < 1.2).length;
    // with a sure beat grid, kicks must fall on it: a snare roll's stray low hits don't make a drop
    const B = this.beat, sure = B.has && B.conf > 0.4, lk = this.kicks.length ? this.kicks[this.kicks.length - 1] : -9;
    const kickOk = !sure || this.onBeat(lk);
    // a build-up, then a kick on beat 1 with the bass coming up: the drop, at once (EDM drops land on a bar line)
    const fast = this.state === "build" && sure && t - lk < 0.3 && this.onBeat(lk) && ((((Math.round((lk - B.off) / B.P) - B.barOff) % 4) + 4) % 4) === 0
      && this.kickS > 0.8 && loud > 0.35 && dom - (this.domHist.length ? this.domBase : dom) > 0.3;
    // a drop goes on while kicks keep coming on the beat (the slower cues take a moment to agree after a fast start)
    const going = this.state === "drop" && kickRecent && kickOk && loud > 0.35;
    let c;
    if (loud < 0.06 || this.eFast < 0.0015) c = "silent";
    else if (fast || going || (bass && kickRecent && loud > 0.45 && kicks2 >= 2 && kickOk)) c = "drop";
    else if ((!bass || kicks2 < 2) && ((snareRate >= 2.5 && loud > 0.4) || (this.eFast > this.eSlow * 1.12 && this.high / this.highMax > 0.45))) c = "build";
    else c = "calm";
    // vote over the recent past so a flickering cue can't freeze the state: drops and silence switch fast, the rest slower
    const vh = this.votes; vh.push(c); if (vh.length > 60) vh.shift();
    const need = c === "drop" ? 0.12 : c === "silent" ? 0.2 : 0.6, nWin = Math.max(1, Math.round(need / dt));
    let same = 0; for (let i = Math.max(0, vh.length - nWin); i < vh.length; i++) if (vh[i] === c) same++;
    this.cand2 = c;
    if (c !== this.state && (fast || (vh.length >= nWin && same / nWin >= 0.7))) {
      if (c === "drop" && (this.state === "build" || this.state === "silent" || t - this.stateT > 4)) {
        this.dropT = t; this.styleStats.drops.push(t);
      }
      if (c === "build") this.buildStart = t;
      this.state = c; this.stateT = t; vh.fill(c); // (a fresh vote from here: no bounce straight back)
    }
  }

  // a time within 70 ms of a beat of the grid
  onBeat(k) { const B = this.beat, x = (k - B.off) / B.P; return Math.abs(x - Math.round(x)) * B.P < 0.07; }

  estimateStyle(t) {
    const st = this.styleStats; st.env.push(this.eFast); if (st.env.length > 15) st.env.shift(); // last 30 s, every 2 s
    st.drops = st.drops.filter(x => t - x < 180);
    if (this.styleLock) { this.style = this.styleLock; return; }
    const span = Math.min(30, t);
    if (span < 8) return;
    const lv = st.env.filter(v => v > 0.0015), dyn = lv.length > 3 ? pct(lv, 0.9) / (pct(lv, 0.25) || 1e-6) : 1;
    const hatRate = this.hats.length / span, snareRate = this.snares.length / span, bpm = this.bpm || 120;
    let onBeat = 0, nBeats = 0;
    if (this.beat.has) { const P = this.beat.P, off = this.beat.off; for (let bt = off + Math.ceil((t - span - off) / P) * P; bt < t; bt += P) { nBeats++; if (this.kicks.some(k => Math.abs(k - bt) < 0.08)) onBeat++; } }
    const kickFrac = nBeats ? onBeat / nBeats : 0, percussive = hatRate > 2 || snareRate > 3.2;
    let s;
    if (!percussive) s = dyn > 2.5 ? "emotional" : "chill";
    else if (st.drops.length >= 1 && kickFrac > 0.25 && bpm >= 110) s = "party";
    else if (bpm < 102) s = "hiphop";
    else s = "poprock";
    // chosen once per song: the first style must come out twice in a row; a change after that 5 times (10 s) in a row.
    // A new song (after 6 s of silence) chooses afresh.
    if (this.state === "silent" && t - this.stateT > 6) { this.style = null; this.styleN = 0; this.styleCand = null; return; }
    if (s === this.styleCand) this.styleN++; else { this.styleCand = s; this.styleN = 1; }
    if (s !== this.style && this.styleN >= (this.style ? 5 : 2)) this.style = s;
    this.features = { hatRate, snareRate, kickFrac, dyn, bpm };
  }

  // Key and mood, re-estimated every 2 s and slow to change: the key from chroma gathered over the last ~40 s (a new
  // key must win twice in a row), the mood eased over ~15 s. Both null until there is enough to go on.
  estimateMood(t) {
    const c = this.ctap, fresh = Math.min(c.frames.length, c.count - this.keyCount); this.keyCount = c.count;
    const decay = Math.exp(-2 / 40); for (let k = 0; k < 12; k++) this.keyAcc[k] *= decay; this.keyN *= decay;
    for (let i = c.frames.length - fresh; i < c.frames.length; i++) { const f = c.frames[i]; let s = 0; for (let k = 0; k < 12; k++) { this.keyAcc[k] += f[k]; s += f[k]; } if (s > 0) this.keyN++; }
    if (c.lastBright != null && this.state !== "silent") this.brightS = this.brightS == null ? c.lastBright : this.brightS + (c.lastBright - this.brightS) * 0.15;
    const k = this.keyN > 60 ? keyOf(this.keyAcc) : null; // at least ~6 s of notes
    if (k) { const same = this.keyEst && this.keyEst.key === k.key && this.keyEst.mode === k.mode;
      if (same || !this.keyEst || (this.keyCand && this.keyCand.key === k.key && this.keyCand.mode === k.mode)) { this.keyEst = k; this.keyCand = null; } else this.keyCand = k;
      if (same) this.keyEst = k; }
    const f = this.features; if (!f || !this.keyEst || this.state === "silent") return;
    const span = Math.min(30, t), target = moodOf({ majorness: this.keyEst.majorness, confidence: this.keyEst.confidence, bright: this.brightS ?? 0.5,
      onsetRate: (this.kicks.length + this.snares.length) / Math.max(1, span), bpm: f.bpm, hatRate: f.hatRate, kickFrac: f.kickFrac });
    const a = this.mood ? 1 - Math.exp(-2 / 15) : 1, m = this.mood || target;
    this.mood = { valence: Math.round((m.valence + (target.valence - m.valence) * a) * 100) / 100, energy: Math.round((m.energy + (target.energy - m.energy) * a) * 100) / 100 };
  }
  // The chord now, from the chroma since the bar line (the 24 triads, as the whole-song analysis), judged from beat 2 of
  // each bar on, at most one change a bar: a new chord must fit clearly (r 0.7 on under 6 frames, else 0.55) and beat
  // the chord showing by 0.08 on the same notes; two bars with no clear chord and it is null again (unknown).
  liveChord() {
    const g = this.grid(this.now), c = this.ctap;
    if (this.state === "silent" || !g.has) { if (this.state === "silent") { this.chord = null; this.chordMiss = 0; } return; }
    const bar = g.idx - g.beatInBar; if (g.beatInBar < 1 || this.chordBar === bar) return;
    const barT = g.beatT - g.beatInBar * g.P, end = (c.n - c.since) / this.sr, step = c.hop / this.sr, S = this.chSum, B = this.chBass, L = c.frames.length;
    S.fill(0); B.fill(0); let n = 0;
    for (let k = 0; k < L && end - k * step - 0.186 >= barT + 0.05; k++) { const f = c.frames[L - 1 - k], b = c.bassFrames[L - 1 - k]; for (let q = 0; q < 12; q++) { S[q] += f[q]; if (b) B[q] += b[q]; } n++; }
    const last = g.beatInBar === 3; if (n < 3 && !last) return;
    const ch = n ? chordOf(S, B) : null;
    if (ch && ch.index === this.chord) { this.chordBar = bar; this.chordMiss = 0; return; }
    const fit = this.chord != null ? chordFit(S, B, this.chord) : -9;
    if (ch && ch.r >= (n < 6 ? 0.7 : 0.55) && ch.r - fit >= 0.08) { this.chord = ch.index; this.chordBar = bar; this.chordMiss = 0; return; }
    if (!last) return;
    this.chordBar = bar; if (!(fit >= 0.45)) { this.chordMiss++; if (this.chordMiss >= 2) this.chord = null; } else this.chordMiss = 0;
  }
  /** No steady drums lately (a ballad, a piano piece): the live tempo is a guess. */
  drumless() { return this.kicks.filter(x => this.t - x < 15).length < 6; }
  /** What song memory's recognise()/matchAt() want besides the loudness fingerprint: the live tempo, chroma, drumless. */
  memoryQuery() { return { bpm: this.bpm || undefined, chroma: this.ctap.window(), drumless: this.drumless() }; }

  /** Time of the newest sample (the analyser's clock t is the centre of the newest frame, half a window earlier). */
  get now() { return this.samples / this.sr; }
  /** The same as `now`, under the name the runtime reads: with it, the runtime counts no analysis delay. */
  get sampleT() { return this.samples / this.sr; }
  /** The tempo (0 until there is one). Setting it, then `phase`, sets the grid by hand (a tap tempo). */
  get bpm() { return this.beat.bpm; }
  set bpm(v) { this._tapBpm = v; if (this.beat.has && v > 0) this.beat.set(v, this.beat.a); }
  /** Where beats fall: a beat at every phase + k * 60 / bpm. */
  get phase() { const B = this.beat; return B.has ? ((B.off % B.P) + B.P) % B.P : 0; }
  set phase(v) { const bpm = this._tapBpm || this.beat.bpm; if (bpm > 0 && Number.isFinite(v)) this.beat.set(bpm, v); }
  get phaseSet() { return this.beat.has; }
  set phaseSet(v) {}
  get barOff() { return this.beat.barOff; }
  /** How sure the beat grid is, 0-1: low when the beats are unclear or nothing has been heard for a while. */
  get conf() { return this.beat.has ? this.beat.conf : 0; }

  /** Beat grid at audio time t (use `now`, the newest sample's time, not `t`, to show it without delay). */
  grid(t) {
    const B = this.beat;
    if (!B.has) return { has: false, P: 0.5, phase: 0, idx: 0, beatInBar: 0, env: 0, barPhase: 0, beatT: -9 };
    return gridAt({ P: B.P, off: B.off, barOff: B.barOff }, t);
  }

  /**
   * The music at audio time t (usually this.now, or a little ahead to make up for delay), in the same shape as songView().
   * @param {number} [t]
   * @param {{predict?:boolean}} [o] predict: put the kick on the beat grid when it is sure of it (conf), so lights land
   *   on time; when it isn't, the kicks heard drive the lights
   */
  view(t = this.now, o = {}) {
    const g = this.grid(t), loud = Math.min(1, this.eFast / this.eMax), nd = this.nextDrop(t);
    const ki = this.kicks.length - 1, kick = ki >= 0 ? this.kicks[ki] : -9, pulses = [], snares = [];
    for (let i = ki; i >= 0 && t - this.kicks[i] < 1; i--) pulses.push(this.kicks[i]);
    for (let i = this.snares.length - 1; i >= 0 && t - this.snares[i] < 0.7; i--) snares.push(this.snares[i]);
    const V = { g, bpm: this.bpm, conf: this.conf, style: this.style || "party", loud, level: this.levelS,
      state: this.state, buildP: this.state === "build" ? Math.min(1, (t - this.buildStart) / 7) : 0, dropT: this.dropT, nextDrop: nd, dropConf: nd != null ? this.drops.conf : 0, dropSource: nd != null ? "predicted" : null, kickStrength: this.kickS,
      kick, snare: this.snares.length ? this.snares[this.snares.length - 1] : -9, hat: this.hats.length ? this.hats[this.hats.length - 1] : -9,
      pulses, snares, pulseN: this.pulseN, vocal: this.vocal, quietFor: this.state === "silent" ? t - this.stateT : 0, live: true,
      key: this.keyEst ? this.keyEst.key : null, mode: this.keyEst ? this.keyEst.mode : null, keyConf: this.keyEst ? this.keyEst.confidence : 0, mood: this.mood,
      styleSure: !!this.style, features: this.features || null, chord: this.chord }; // (features: what the style was chosen from: kickFrac, dyn, ...; for the director's live look)
    // a stereo source: the balance of the hit or the level now, and the two levels (only while stereo keeps coming)
    const sv = this.stereoView(); if (sv) { V.pan = sv.pan; V.lr = sv.lr; }
    // what the song did the last time it was here (repeat.js), and a drop time it gave the countdown
    V.repeat = this.repeat && this.t >= this.repeat.lastT - 0.5 ? this.repeat.view(t) : null; if (nd != null && this.drops.source === "repeat") V.dropSource = "repeat";
    if (o.predict && g.has && t - kick < 2 && this.conf > 0.3) { V.kick = g.beatT; V.pulses = [g.beatT, g.beatT - g.P]; V.pulseN = g.idx; }
    return V;
  }

  /**
   * When the next drop will probably come (on this analyser's clock), else null: the drop predictor's guess (drops.js:
   * a riser, the phrase grid and the pre-drop dip) once it is fairly sure (dropConf).
   */
  nextDrop(t) { const d = this.drops; return d.next != null && d.next > t - 0.5 && d.conf > 0 ? d.next : null; }

  /** A stereo source's balance now: {pan: -1 left .. 1 right (the hit just now, else the levels), lr: [left, right] 0..1}, or null (mono). */
  stereoView() { const sp = this.stereo; return sp && sp.stereo && this.samples - this.stereoAt < this.sr * 0.5 ? { pan: sp.pan, lr: sp.lr } : null; }

  /** Extra per-frame signals for buildSignals(): spectrum bands, waveform, bass level. */
  extras() { return { bands: this.bands, wave: this.wave, bassL: Math.min(1, this.bass / this.bassMax) }; }
}
