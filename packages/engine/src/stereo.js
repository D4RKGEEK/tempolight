// Stereo balance of a live source, kept cheaply next to the (mono) analysis: per channel, the level (RMS, smoothed
// over ~80 ms) and the onset strength of the low band (below ~150 Hz, where kicks and bass are: the rise of its level,
// held for a moment), every ~12 ms. pan: -1 (all left) .. 1 (all right), from the hit when there was one just now, else
// from the levels. A source whose two channels are the same (a microphone sent as stereo) counts as mono. Pure
// JavaScript, no I/O.

export class StereoTap {
  /** @param {number} sr sample rate of what you push */
  constructor(sr = 22050) {
    this.sr = sr; this.hopN = Math.max(64, Math.round(sr * 0.0116)); this.a = 1 - Math.exp(-2 * Math.PI * 150 / sr);
    this.reset();
  }
  reset() {
    this.l1 = this.l2 = this.r1 = this.r2 = 0; this.n = 0; this.sL = this.sR = this.bL = this.bR = this.dd = this.ss = 0;
    this.prevL = this.prevR = 0; this.eL = this.eR = 0; this.hL = this.hR = 0; this.hRef = 1e-9; this.eMax = 1e-6; this.samples = 0; this.wideAt = -1e12;
  }
  /** One sample per channel (-1..1). */
  push(l, r) {
    const a = this.a; this.l1 += (l - this.l1) * a; this.l2 += (this.l1 - this.l2) * a; this.r1 += (r - this.r1) * a; this.r2 += (this.r1 - this.r2) * a; // 2-pole low-pass
    this.sL += l * l; this.sR += r * r; this.bL += this.l2 * this.l2; this.bR += this.r2 * this.r2; const d = l - r; this.dd += d * d; this.ss += l * l + r * r;
    this.samples++; if (++this.n >= this.hopN) this.step();
  }
  step() {
    const n = this.n, dt = n / this.sr, rL = Math.sqrt(this.sL / n), rR = Math.sqrt(this.sR / n), lowL = Math.sqrt(this.bL / n), lowR = Math.sqrt(this.bR / n);
    const eL2 = lowL * lowL, eR2 = lowR * lowR, fL = Math.max(0, eL2 - this.prevL), fR = Math.max(0, eR2 - this.prevR); this.prevL = eL2; this.prevR = eR2; // (in energy: a hit on one side over a bass on both still leans clearly)
    const hd = Math.exp(-dt / 0.12); this.hL = Math.max(this.hL * hd, fL); this.hR = Math.max(this.hR * hd, fR);
    this.hRef = Math.max(this.hRef * Math.exp(-dt / 8), this.hL + this.hR, 1e-9);
    const k = 1 - Math.exp(-dt / 0.08); this.eL += (rL - this.eL) * k; this.eR += (rR - this.eR) * k;
    this.eMax = Math.max(this.eMax * Math.exp(-dt / 10), this.eL, this.eR, 1e-6);
    if (this.ss > 1e-9 && this.dd > 1e-3 * this.ss) this.wideAt = this.samples; // the channels differ (-30 dB or more)
    this.n = 0; this.sL = this.sR = this.bL = this.bR = this.dd = this.ss = 0;
  }
  /** The channels have differed in the last 2 s. */
  get stereo() { return this.samples - this.wideAt < 2 * this.sr; }
  /** -1 (left) .. 1 (right): of the hit just now (the low band's onset), else of the levels. */
  get pan() {
    const h = this.hL + this.hR; if (h > 0.2 * this.hRef && h > 1e-9) return Math.round((this.hR - this.hL) / Math.max(this.hL, this.hR) * 1000) / 1000;
    const e = this.eL + this.eR; return e > 1e-6 ? Math.round((this.eR - this.eL) / e * 1000) / 1000 : 0;
  }
  /** Left and right levels, 0..1 (against the louder channel's recent peak). */
  get lr() { return [Math.min(1, this.eL / this.eMax), Math.min(1, this.eR / this.eMax)]; }
}
