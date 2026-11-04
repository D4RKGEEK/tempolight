// Live listening: turns a stream of audio samples into the same "view" of the music that whole-song analysis gives
// (beat grid, kick/snare/hi-hat hits, song part, loudness, style). Pure JavaScript, no I/O: the server feeds it
// samples from a sound card, ffmpeg or a browser, and tests feed it synthetic songs.
import { gridAt } from "./signals.js";
import { FingerprintTap } from "./memory.js";
import { ChromaTap, keyOf, moodOf } from "./tonal.js";

const NF = 1024, HOP = 256;
const EDGES = (() => { const e = []; for (let i = 0; i <= 24; i++) e.push(40 * Math.pow(10000 / 40, i / 24)); return e; })();
const pct = (arr, p) => { if (!arr.length) return 0; const s = Array.from(arr).sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

export class LiveAnalyser {
  /** @param {number} sr sample rate of the samples you will push (anything from 16 kHz to 96 kHz) */
  constructor(sr = 22050) {
    this.inRate = sr; this.dec = sr > 64000 ? 4 : sr > 32000 ? 2 : 1; this.sr = sr / this.dec;
    this.binHz = this.sr / NF; this.dtHop = HOP / this.sr;
    this.win = new Float32Array(NF); for (let i = 0; i < NF; i++) this.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / NF);
    this.re = new Float32Array(NF); this.im = new Float32Array(NF); this.mag = new Float32Array(NF / 2); this.prev = new Float32Array(NF / 2);
    this.rev = new Uint16Array(NF); for (let i = 0, j = 0; i < NF; i++) { this.rev[i] = j; let b = NF >> 1; while (j & b) { j ^= b; b >>= 1; } j |= b; }
    this.cosT = new Float32Array(NF / 2); this.sinT = new Float32Array(NF / 2);
    for (let i = 0; i < NF / 2; i++) { this.cosT[i] = Math.cos(-2 * Math.PI * i / NF); this.sinT[i] = Math.sin(-2 * Math.PI * i / NF); }
    this.ring = new Float32Array(NF); this.ringPos = 0; this.filled = 0; this.sinceHop = 0; this.decAcc = 0; this.decN = 0;
    this.wave = new Float32Array(256); this.tap = new FingerprintTap(); this.ctap = new ChromaTap(this.sr); this.hopN = 0; this._lite = false;
    this.reset();
  }
  /** Low-power mode (small computers): chroma every 2nd frame, the vocal estimate every 2nd hop. */
  get lite() { return this._lite; }
  set lite(v) { this._lite = !!v; this.ctap.lite = !!v; }

  reset() {
    this.samples = 0; this.t = 0; this.hasPrev = false; if (this.tap) this.tap.reset(); if (this.ctap) this.ctap.reset();
    this.keyAcc = new Float64Array(12); this.keyN = 0; this.keyCount = 0; this.keyEst = null; this.keyCand = null; this.brightS = null; this.mood = null; this.lastMoodT = -9;
    this.hist = { k: [], s: [], h: [] }; this.lowHist = []; this.votes = []; this.last = { k: -9, s: -9, h: -9 };
    this.kicks = []; this.snares = []; this.hats = []; this.onsets = []; this.pulseN = 0;
    this.bpm = 0; this.cand = 0; this.candN = 0; this.phase = 0; this.phaseSet = false; this.lastEst = -9;
    this.eFast = 0; this.eSlow = 0; this.eMax = 1e-4; this.rms = 0;
    this.bass = 0; this.bassMax = 1e-4; this.mid = 0; this.high = 0; this.highMax = 1e-4;
    this.bands = new Float32Array(24); this.bandMax = new Float32Array(24).fill(1e-4); this.vocal = 0; this.vocalRaw = 0; this.pitchHist = []; this.ampHist = []; this.fade = 0;
    this.state = "silent"; this.cand2 = "silent"; this.candT = 0; this.stateT = 0; this.buildStart = 0; this.dropT = -9; this.barOff = 0;
    this.domS = null; this.domHist = []; this.domHistT = -9; this.domBase = null; // domBase: pct(domHist, 0.3), kept until domHist changes
    this.styleStats = { env: [], envT: -9, drops: [] }; this.style = null; this.styleCand = null; this.lastStyleT = -9; this.styleLock = null;
  }

  /** Feed samples. Accepts Float32Array (-1..1) or Int16Array. */
  push(chunk) {
    const isInt = chunk instanceof Int16Array, k = isInt ? 1 / 32768 : 1;
    for (let i = 0; i < chunk.length; i++) {
      let v = chunk[i] * k;
      if (this.dec > 1) { this.decAcc += v; if (++this.decN < this.dec) continue; v = this.decAcc / this.dec; this.decAcc = 0; this.decN = 0; }
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
    if (!this.hasPrev) { this.prev.set(mag); this.hasPrev = true; return; }
    const loudEnough = rms > 0.0015;
    const kf = this.flux(40, 110), sf = this.flux(180, 320) * 0.6 + this.flux(1800, 5000) * 0.4, hf = this.flux(7000, 10500);
    // a kick is a low-frequency hit: its flux per bin must beat the hi-hat band's, or hats and noise leak in as kicks
    // ...and the low band's energy must actually jump compared with the last ~120 ms (sustained bass notes don't)
    const lowNow = this.bandMag(40, 110), lh = this.lowHist; let la = 0; for (const v of lh) la += v; la = lh.length ? la / lh.length : lowNow;
    lh.push(lowNow); if (lh.length > 10) lh.shift(); const lowRise = lowNow / Math.max(1e-7, la);
    // snares and hi-hats are noisy: they need real energy up high, or piano and guitar attacks would count as drums
    const ref = Math.max(1e-7, this.bandMag(100, 2000)), noisy = this.bandMag(1800, 5000) / ref, airy = this.bandMag(7000, 10500) / ref;
    const kbins = Math.max(1, Math.ceil(110 / this.binHz) - Math.floor(40 / this.binHz) + 1), kpb = kf / kbins, hpb = (hf + this.flux(1800, 5000)) / Math.max(1, (10500 - 1800) / this.binHz);
    const kick = this.detect("k", kf, t, 0.2, 1.6) && loudEnough && kpb > 4 * hpb && lowRise > 1.35 && kpb > this.flux(150, 320) / Math.max(1, 170 / this.binHz), snare = this.detect("s", sf, t, 0.14, 1.8) && loudEnough && noisy > 0.05, hat = this.detect("h", hf, t, 0.07, 1.4) && loudEnough && airy > 0.015;
    if (kick) { this.kicks.push(t); this.onsets.push([t, 1.0]); this.pulseN++; }
    if (snare) { this.snares.push(t); this.onsets.push([t, kick ? 0 : 0.5]); }
    if (hat) this.hats.push(t);
    while (this.kicks.length && t - this.kicks[0] > 30) this.kicks.shift();
    while (this.snares.length && t - this.snares[0] > 30) this.snares.shift();
    while (this.hats.length && t - this.hats[0] > 30) this.hats.shift();
    while (this.onsets.length && t - this.onsets[0][0] > 10) this.onsets.shift();
    this.prev.set(mag);
    const ef = 1 - Math.exp(-dt / 0.25), es = 1 - Math.exp(-dt / 4);
    this.eFast += (rms - this.eFast) * ef; this.eSlow += (rms - this.eSlow) * es; if (this.eSlow < this.eFast * 0.3) this.eSlow = this.eFast * 0.3 + this.eSlow * 0.7; this.eMax = Math.max(this.eMax * Math.pow(0.97, dt), this.eFast, 0.004);
    const bass = this.bandMag(40, 150), high = this.bandMag(4000, 10000);
    this.bass += (bass - this.bass) * (1 - Math.exp(-dt / 0.15)); this.bassMax = Math.max(this.bassMax * Math.pow(0.97, dt), this.bass);
    this.high += (high - this.high) * (1 - Math.exp(-dt / 0.3)); this.highMax = Math.max(this.highMax * Math.pow(0.97, dt), this.high);
    this.mid += (this.bandMag(300, 2000) - this.mid) * (1 - Math.exp(-dt / 0.3));
    const bandDecay = Math.pow(0.9, dt);
    for (let b = 0; b < 24; b++) {
      const v = this.bandMag(EDGES[b], EDGES[b + 1]); this.bandMax[b] = Math.max(this.bandMax[b] * bandDecay, v, 1e-5);
      const nv = loudEnough ? Math.min(1, v / this.bandMax[b]) : 0; this.bands[b] += (nv - this.bands[b]) * (nv > this.bands[b] ? 0.7 : 0.25);
    }
    if (!this._lite || (++this.hopN & 1)) this.vocalHop(loudEnough, this._lite ? dt * 2 : dt); // (lite: every 2nd hop, covering two)
    if (t - this.lastEst > 0.5) { this.lastEst = t; this.estimateTempo(t); }
    this.sections(t, dt);
    if (t - this.lastStyleT > 2) { this.lastStyleT = t; this.estimateStyle(t); }
    if (t - this.lastMoodT > 2) { this.lastMoodT = t; this.estimateMood(t); }
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

  estimateTempo(t) {
    const src = this.kicks.filter(x => t - x < 10).length >= 6 ? this.kicks.filter(x => t - x < 10).map(x => [x, 1]) : this.onsets;
    if (src.length < 5) return;
    const hist = new Float32Array(241); // 60..180 BPM in 0.5 steps
    for (let i = 0; i < src.length; i++) for (let j = i + 1; j < src.length; j++) {
      const d = src[j][0] - src[i][0]; if (d < 0.28 || d > 4) continue;
      for (let m = 1; m <= 4; m++) { const p = d / m; if (p < 0.333 || p > 1) continue;
        const b = 60 / p, w = (src[i][1] + src[j][1]) / m, c = Math.round((b - 60) * 2);
        for (let q = Math.max(0, c - 4); q <= Math.min(240, c + 4); q++) hist[q] += w * Math.exp(-((((60 + q / 2) - b) / 0.8) ** 2)); }
    }
    const prior = this.style === "emotional" || this.style === "chill" ? 78 : 122; // slow songs: prefer the slow reading
    let best = 0, bi = 0; for (let q = 0; q <= 240; q++) { const v = hist[q] * Math.exp(-((((60 + q / 2) - prior) / 45) ** 2)); if (v > best) { best = v; bi = q; } }
    if (!best) return; const bpm = 60 + bi / 2; if (globalThis.LOGT) globalThis.LOGT.push({t, raw: bpm, cur: this.bpm, style: this.style, n: src.length, kicksrc: src !== this.onsets});
    if (!this.bpm || Math.abs(bpm - this.bpm) < 3) { this.bpm = this.bpm ? this.bpm * 0.7 + bpm * 0.3 : bpm; this.candN = 0; }
    else if (Math.abs(bpm - this.cand) < 3) { if (++this.candN >= 3) { this.bpm = bpm; this.candN = 0; } } else { this.cand = bpm; this.candN = 1; }
    const P = 60 / this.bpm; let sx = 0, sy = 0;
    for (const [x, w] of src) { if (t - x > 6) continue; const a = 2 * Math.PI * (x % P) / P, r = w * Math.exp(-(t - x) / 3); sx += Math.cos(a) * r; sy += Math.sin(a) * r; }
    if (sx || sy) { const ph = ((Math.atan2(sy, sx) / (2 * Math.PI)) + 1) % 1 * P;
      if (!this.phaseSet) { this.phase = ph; this.phaseSet = true; } else { let d = ph - this.phase; d -= Math.round(d / P) * P; this.phase = (this.phase + d * 0.35 + P) % P; } }
  }

  sections(t, dt) {
    const loud = this.eFast / this.eMax, kickRecent = t - this.last.k < 0.9;
    const dom = Math.log10(Math.max(1e-7, this.bass) / Math.max(1e-7, this.mid));
    this.domS = this.domS == null ? dom : this.domS + (dom - this.domS) * (1 - Math.exp(-dt / 0.4));
    if (t - this.domHistT > 0.1 && loud > 0.06) { this.domHistT = t; this.domHist.push(this.domS); if (this.domHist.length > 300) this.domHist.shift(); this.domBase = null; }
    if (this.domBase == null && this.domHist.length) this.domBase = pct(this.domHist, 0.3); // (sorted again only when it changed, 10 times a second at most)
    const base = this.domHist.length ? this.domBase : this.domS, bass = (this.domS - base > 0.5 && this.domHist.length > 25) ? 1 : 0;
    const snareRate = this.snares.filter(x => t - x < 2).length / 2, kicks2 = this.kicks.filter(x => t - x < 1.2).length;
    let c;
    if (loud < 0.06 || this.eFast < 0.0015) c = "silent";
    else if (bass && kickRecent && loud > 0.45 && kicks2 >= 2) c = "drop";
    else if ((!bass || kicks2 < 2) && ((snareRate >= 2.5 && loud > 0.4) || (this.eFast > this.eSlow * 1.12 && this.high / this.highMax > 0.45))) c = "build";
    else c = "calm";
    // vote over the recent past so a flickering cue can't freeze the state: drops and silence switch fast, the rest slower
    const vh = this.votes; vh.push(c); if (vh.length > 60) vh.shift();
    const need = c === "drop" ? 0.12 : c === "silent" ? 0.2 : 0.6, nWin = Math.max(1, Math.round(need / dt));
    let same = 0; for (let i = Math.max(0, vh.length - nWin); i < vh.length; i++) if (vh[i] === c) same++;
    this.cand2 = c;
    if (c !== this.state && vh.length >= nWin && same / nWin >= 0.7) {
      if (c === "drop" && (this.state === "build" || this.state === "silent" || t - this.stateT > 4)) {
        this.dropT = t; this.styleStats.drops.push(t);
        if (this.bpm) { const P = 60 / this.bpm, bi = Math.round((t - this.phase) / P); this.barOff = ((bi % 4) + 4) % 4; }
      }
      if (c === "build") this.buildStart = t;
      this.state = c; this.stateT = t;
    }
  }

  estimateStyle(t) {
    const st = this.styleStats; st.env.push(this.eFast); if (st.env.length > 15) st.env.shift(); // last 30 s, every 2 s
    st.drops = st.drops.filter(x => t - x < 180);
    if (this.styleLock) { this.style = this.styleLock; return; }
    const span = Math.min(30, t);
    if (span < 8) return;
    const lv = st.env.filter(v => v > 0.0015), dyn = lv.length > 3 ? pct(lv, 0.9) / (pct(lv, 0.25) || 1e-6) : 1;
    const hatRate = this.hats.length / span, snareRate = this.snares.length / span, bpm = this.bpm || 120;
    let onBeat = 0, nBeats = 0;
    if (this.bpm) { const P = 60 / this.bpm; for (let bt = this.phase + Math.ceil((t - span - this.phase) / P) * P; bt < t; bt += P) { nBeats++; if (this.kicks.some(k => Math.abs(k - bt) < 0.08)) onBeat++; } }
    const kickFrac = nBeats ? onBeat / nBeats : 0, percussive = hatRate > 2 || snareRate > 3.2;
    let s;
    if (!percussive) s = dyn > 2.5 ? "emotional" : "chill";
    else if (st.drops.length >= 1 && kickFrac > 0.25 && bpm >= 110) s = "party";
    else if (bpm < 102) s = "hiphop";
    else s = "poprock";
    if (s === this.styleCand) this.style = s; this.styleCand = s;
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
  /** No steady drums lately (a ballad, a piano piece): the live tempo is a guess. */
  drumless() { return this.kicks.filter(x => this.t - x < 15).length < 6; }
  /** What song memory's recognise()/matchAt() want besides the loudness fingerprint: the live tempo, chroma, drumless. */
  memoryQuery() { return { bpm: this.bpm || undefined, chroma: this.ctap.window(), drumless: this.drumless() }; }

  /** Beat grid at audio time t. */
  grid(t) {
    if (!this.bpm) return { has: false, P: 0.5, phase: 0, idx: 0, beatInBar: 0, env: 0, barPhase: 0, beatT: -9 };
    return gridAt({ P: 60 / this.bpm, off: this.phase, barOff: this.barOff }, t);
  }

  /**
   * The music at audio time t (usually this.t, or a little ahead to make up for delay), in the same shape as songView().
   * @param {number} [t]
   * @param {{predict?:boolean}} [o] predict: put the kick on the beat grid when it is locked, so lights land on time
   */
  view(t = this.t, o = {}) {
    const g = this.grid(t), loud = Math.min(1, this.eFast / this.eMax);
    const ki = this.kicks.length - 1, kick = ki >= 0 ? this.kicks[ki] : -9, pulses = [], snares = [];
    for (let i = ki; i >= 0 && t - this.kicks[i] < 1; i--) pulses.push(this.kicks[i]);
    for (let i = this.snares.length - 1; i >= 0 && t - this.snares[i] < 0.7; i--) snares.push(this.snares[i]);
    const V = { g, bpm: this.bpm, style: this.style || "party", loud, level: loud < 0.4 ? "low" : loud < 0.75 ? "mid" : "peak",
      state: this.state, buildP: this.state === "build" ? Math.min(1, (t - this.buildStart) / 7) : 0, dropT: this.dropT, nextDrop: null,
      kick, snare: this.snares.length ? this.snares[this.snares.length - 1] : -9, hat: this.hats.length ? this.hats[this.hats.length - 1] : -9,
      pulses, snares, pulseN: this.pulseN, vocal: this.vocal, quietFor: this.state === "silent" ? t - this.stateT : 0, live: true,
      key: this.keyEst ? this.keyEst.key : null, mode: this.keyEst ? this.keyEst.mode : null, keyConf: this.keyEst ? this.keyEst.confidence : 0, mood: this.mood };
    if (o.predict && g.has && t - kick < 2) { V.kick = g.beatT; V.pulses = [g.beatT, g.beatT - g.P]; V.pulseN = g.idx; }
    return V;
  }

  /** Extra per-frame signals for buildSignals(): spectrum bands, waveform, bass level. */
  extras() { return { bands: this.bands, wave: this.wave, bassL: Math.min(1, this.bass / this.bassMax) }; }
}
