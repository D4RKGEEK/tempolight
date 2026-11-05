// Audio worklet: takes whatever the browser plays or records, resamples to 22,050 Hz and posts 16-bit chunks of 512
// frames (about 23 ms) to the page, which sends them to the Tempolight server. Mono (mixed) unless the two channels
// differ (a song or the computer's sound in stereo): then interleaved left/right, after a {channels: 2} message (and
// {channels: 1} after 2 s of identical channels), so a microphone sent as stereo costs no more than mono.
class PcmTap extends AudioWorkletProcessor {
  constructor() { super(); this.ratio = sampleRate / 22050; this.pos = 0; this.prevL = 0; this.prevR = 0; this.ch = 1; this.same = 0; this.out = new Int16Array(512); this.n = 0; }
  flush() { if (this.n) { const o = this.out.slice(0, this.n); this.port.postMessage(o.buffer, [o.buffer]); this.n = 0; } }
  setChannels(c) { this.flush(); this.ch = c; this.out = new Int16Array(512 * c); this.port.postMessage({ channels: c }); }
  process(inputs, outputs) {
    if (outputs[0] && outputs[0][0]) outputs[0][0].fill(0);
    const inp = inputs[0]; if (!inp || !inp.length) return true;
    const a = inp[0], b = inp[1] || null, len = a.length;
    // stereo when the channels differ (-30 dB or more); back to mono after ~2 s of the same
    if (b) { let d = 0, s = 0; for (let i = 0; i < len; i++) { const x = a[i] - b[i]; d += x * x; s += a[i] * a[i] + b[i] * b[i]; }
      if (s > 1e-9 && d > 1e-3 * s) { this.same = 0; if (this.ch === 1) this.setChannels(2); } else if (this.ch === 2 && (this.same += len) > 2 * sampleRate) this.setChannels(1); }
    else if (this.ch === 2) this.setChannels(1);
    const st = this.ch === 2, cap = 512 * this.ch;
    for (let i = 0; i < len; i++) {
      const l = a[i], r = b ? b[i] : l, v = (l + r) * 0.5;
      // linear interpolation between the previous and this sample
      while (this.pos <= 1) {
        if (st) { this.out[this.n++] = Math.max(-32768, Math.min(32767, (this.prevL + (l - this.prevL) * this.pos) * 32767)); this.out[this.n++] = Math.max(-32768, Math.min(32767, (this.prevR + (r - this.prevR) * this.pos) * 32767)); }
        else { const m = (this.prevL + this.prevR) * 0.5, s = m + (v - m) * this.pos; this.out[this.n++] = Math.max(-32768, Math.min(32767, s * 32767)); }
        if (this.n === cap) { this.port.postMessage(this.out.buffer, [this.out.buffer]); this.out = new Int16Array(cap); this.n = 0; }
        this.pos += this.ratio; }
      this.pos -= 1; this.prevL = l; this.prevR = r;
    }
    return true;
  }
}
registerProcessor("pcm-tap", PcmTap);
