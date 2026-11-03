// Audio worklet: takes whatever the browser plays or records, mixes to mono, resamples to 22,050 Hz and posts
// 16-bit chunks of 512 samples (about 23 ms) to the page, which sends them to the Tempolight server.
class PcmTap extends AudioWorkletProcessor {
  constructor() { super(); this.ratio = sampleRate / 22050; this.pos = 0; this.prev = 0; this.out = new Int16Array(512); this.n = 0; }
  process(inputs, outputs) {
    if (outputs[0] && outputs[0][0]) outputs[0][0].fill(0);
    const inp = inputs[0]; if (!inp || !inp.length) return true;
    const a = inp[0], b = inp[1], len = a.length;
    for (let i = 0; i < len; i++) {
      const v = b ? (a[i] + b[i]) * 0.5 : a[i];
      // linear interpolation between the previous and this sample
      while (this.pos <= 1) { const s = this.prev + (v - this.prev) * this.pos; this.out[this.n++] = Math.max(-32768, Math.min(32767, s * 32767));
        if (this.n === 512) { this.port.postMessage(this.out.buffer, [this.out.buffer]); this.out = new Int16Array(512); this.n = 0; }
        this.pos += this.ratio; }
      this.pos -= 1; this.prev = v;
    }
    return true;
  }
}
registerProcessor("pcm-tap", PcmTap);
