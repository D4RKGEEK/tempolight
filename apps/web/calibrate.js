// One-tap timing fix: play clicks through the speakers and record them with the microphone. The same clicks are also
// fed straight into a second recording channel, so the delay is measured sample-exactly on one recording: speaker
// latency (including Bluetooth) + sound travelling through the air + microphone latency.

/**
 * Find the delay between clicks on the digital channel and the same clicks heard by the microphone.
 * @param {Float32Array} mic  microphone samples
 * @param {Float32Array} ref  the clicks as they were sent to the speakers, same length and timing
 * @param {number} sr sample rate
 * @returns {{ok:boolean, delayMs:number, spreadMs:number, heard:number, sent:number}}
 */
export function analyseCalibration(mic, ref, sr) {
  const onsets = (x, thr, gap) => { const out = []; for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > thr && (!out.length || i - out[out.length - 1] > gap)) out.push(i); return out; };
  let refMax = 0; for (const v of ref) refMax = Math.max(refMax, Math.abs(v));
  const sent = onsets(ref, refMax * 0.5, sr * 0.2);
  // microphone: an envelope (1 ms), and a threshold well above the room's noise
  const win = Math.max(1, Math.round(sr / 1000)), env = new Float32Array(mic.length); let acc = 0;
  for (let i = 0; i < mic.length; i++) { acc += Math.abs(mic[i]); if (i >= win) acc -= Math.abs(mic[i - win]); env[i] = acc / win; }
  const sorted = Float32Array.from(env).sort(), noise = sorted[Math.floor(sorted.length * 0.5)], peak = sorted[sorted.length - 1];
  const thr = Math.max(noise * 6, noise + (peak - noise) * 0.25);
  const delays = [];
  for (const s of sent) { const end = Math.min(env.length, s + Math.round(sr * 0.8)); for (let i = s; i < end; i++) if (env[i] > thr) { delays.push((i - s) / sr * 1000); break; } }
  if (delays.length < Math.max(3, sent.length * 0.6) || peak < noise * 4) return { ok: false, delayMs: 0, spreadMs: 0, heard: delays.length, sent: sent.length };
  delays.sort((a, b) => a - b); const med = delays[delays.length >> 1], spread = delays.map(d => Math.abs(d - med)).sort((a, b) => a - b)[delays.length >> 1];
  return { ok: spread < 25, delayMs: med, spreadMs: spread, heard: delays.length, sent: sent.length };
}

/**
 * The light-timing setting to use, from a measured speaker-to-microphone delay.
 * Songs already make up for the delay the browser reports; this adds what it doesn't know (Bluetooth, the air, the
 * speaker itself) and the ~25 ms WLED needs to show a frame.
 */
export function offsetFromDelay(delayMs, reportedOutputMs, micLatencyMs = 10) {
  const extra = delayMs - micLatencyMs - reportedOutputMs;
  return Math.max(-400, Math.min(400, Math.round((25 - extra) / 5) * 5));
}

/** Run the measurement in this browser. deviceId: the microphone to use (optional). */
export async function measure(ctx, deviceId, onProgress = () => {}) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  try {
    const mic = ctx.createMediaStreamSource(stream), merge = ctx.createChannelMerger(2), rec = ctx.createScriptProcessor(1024, 2, 1), mute = ctx.createGain(); mute.gain.value = 0;
    const clickGain = ctx.createGain(); clickGain.gain.value = 0.9;
    mic.connect(merge, 0, 0); clickGain.connect(merge, 0, 1); clickGain.connect(ctx.destination); merge.connect(rec); rec.connect(mute).connect(ctx.destination);
    const a = [], b = []; rec.onaudioprocess = e => { a.push(new Float32Array(e.inputBuffer.getChannelData(0))); b.push(new Float32Array(e.inputBuffer.getChannelData(1))); };
    const sr = ctx.sampleRate, click = ctx.createBuffer(1, Math.round(sr * 0.004), sr), d = click.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (sr * 0.0008));
    const n = 8, t0 = ctx.currentTime + 0.6;
    for (let k = 0; k < n; k++) { const s = ctx.createBufferSource(); s.buffer = click; s.connect(clickGain); s.start(t0 + k * 0.45); }
    const total = 0.6 + n * 0.45 + 0.9;
    for (let el = 0; el < total; el += 0.1) { onProgress(el / total); await new Promise(r => setTimeout(r, 100)); }
    rec.disconnect(); merge.disconnect(); mic.disconnect(); clickGain.disconnect();
    const join = parts => { const out = new Float32Array(parts.reduce((x, p) => x + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
    return { ...analyseCalibration(join(a), join(b), sr), reportedOutputMs: ((ctx.outputLatency || 0) + (ctx.baseLatency || 0)) * 1000 };
  } finally { stream.getTracks().forEach(t => t.stop()); }
}
