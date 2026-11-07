// PROTOTYPE, for scripts/beat-eval.js only (LIVE=packages/engine/src/ml/live-ml.js): the normal live analyser, with
// its beat grid and tempo taken from BeatNet + the causal bar tracker (beatnet.js) instead of the DSP beat tracker.
// Kicks, levels, sections, key and the rest still come from the DSP analyser. Node only (reads the weights with fs).
//
// ML_MODE=dsp-fallback: use the ML grid only while its confidence is high, else the DSP grid.
import { readFileSync } from "node:fs";
import { LiveAnalyser as Base } from "../live.js";
import { MLBeat } from "./beatnet.js";

const WEIGHTS = readFileSync(new URL("./weights/beatnet-1.tlw", import.meta.url));

export class LiveAnalyser extends Base {
  constructor(sr = 22050) {
    super(sr);
    if (sr !== 22050 && sr !== 44100) throw new Error("the BeatNet prototype wants 22,050 or 44,100 Hz input");
    this.ml = new MLBeat(WEIGHTS); this.mlDec = sr === 44100 ? 2 : 1; this.mlBuf = new Float32Array(4096); this.mlCpu = 0;
  }
  push(chunk, channels = 1) {
    super.push(chunk, channels);
    if (channels !== 1) return; // (prototype: mono only)
    const k = chunk instanceof Int16Array ? 1 / 32768 : 1, n = Math.floor(chunk.length / this.mlDec);
    if (this.mlBuf.length < n) this.mlBuf = new Float32Array(n);
    for (let i = 0; i < n; i++) { let v = 0; for (let d = 0; d < this.mlDec; d++) v += chunk[i * this.mlDec + d]; this.mlBuf[i] = v * k / this.mlDec; }
    const t0 = performance.now(); this.ml.push(this.mlBuf.subarray(0, n)); this.mlCpu += performance.now() - t0;
  }
  useML() { return this.ml && this.ml.has && (process.env.ML_MODE !== "dsp-fallback" || this.ml.conf > 0.5 || !this.beat.has); }
  get bpm() { return this.useML() ? this.ml.bpm : super.bpm; }
  set bpm(v) { super.bpm = v; }
  get conf() { return this.useML() ? Math.min(1, this.ml.conf) : super.conf; }
  grid(t) { return this.useML() ? this.ml.grid(t) : super.grid(t); }
}
