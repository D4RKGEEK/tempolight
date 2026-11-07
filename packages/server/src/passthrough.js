// Lookahead mode's audio passthrough: Tempolight records the music, holds it back by a few seconds and plays it to the
// speakers itself, while the analyser hears it at once. So at every moment the lights know the next few seconds.
// Pure JavaScript, no Node.js modules (lookahead-mode.js runs it; the sound output itself is audio-out.js).
//
// The delay is kept steady without resampling (the same rate in and out):
//   - the output is paced by a clock: the computer's (performance.now), or better the output's own, when it reports
//     how much it has played (ffmpeg's progress): a small PLL follows that report, so a speaker whose clock runs a
//     little fast or slow doesn't make the delay creep;
//   - the input comes at the sound card's own rate, which is never exactly the output's: the delay (from when a sample
//     arrived to when it plays) is measured all the time, and when it is off by more than ~2 ms a single frame is
//     dropped or played twice (at most one per tick, inaudible) until it is back.
//
// Sample frame numbers: every frame that came in has an index (inFrames counts them); heardFrame(now) says which one
// the speakers play now, so the runtime can show the lights for exactly the audio heard.

export const LA_RATE = 44100;          // lookahead mode records and plays at this rate (the analyser halves it to 22,050 Hz)
export const LA_DEFAULT_MS = 3000, LA_MIN_MS = 1000, LA_MAX_MS = 8000;
export const LA_MARGIN_MS = 250;       // held back a little more than the lookahead, so a drop is sure (detected) by then
const LEAD_MS = 60;                    // the output gets this much ahead of where it plays (timer jitter)
const WINDOW_MS = 2000;                // the delay is the largest of the last 2 s (a chunk that arrives late isn't the truth)
const FIX_ON_MS = 2, FIX_OFF_MS = 0.5; // start fixing the delay when off by 2 ms, stop at 0.5 ms

/**
 * @param {{rate?:number, channels?:number, delayMs?:number, now?:()=>number, volume?:number, leadMs?:number}} o
 *   delayMs: from when a sample arrives to when it plays (lookahead + margin)
 */
export function createPassthrough({ rate = LA_RATE, channels = 2, delayMs = LA_DEFAULT_MS + LA_MARGIN_MS, now = () => performance.now(), volume = 1, leadMs = LEAD_MS } = {}) {
  const ch = channels, cap = Math.ceil((LA_MAX_MS + LA_MARGIN_MS + 3000) / 1000 * rate); // ring size in frames
  const ring = new Int16Array(cap * ch);
  const S = {
    inFrames: 0, rd: 0, out: 0, started: false, pos: 0, posAt: 0, ratio: 1, // rd: the next input frame to send; out: frames sent; pos: output frames played (estimated)
    arrivals: [], delayMs, measuredMs: null, fixing: false, dropped: 0, inserted: 0, underruns: 0, lastFixAt: 0,
    gain: Math.max(0, Math.min(1.5, volume)), gainNow: Math.max(0, Math.min(1.5, volume)),
    clock: { off0: null, offs: [], reports: 0, last: null }, // the output's own clock (reports of frames played)
    overflow: 0,
  };
  const frames = () => S.inFrames - S.rd; // waiting to be sent
  /** Frames from the capture (interleaved, Int16Array); arrivedAt: when they came in (ms, the same clock as now). */
  function push(chunk, arrivedAt = now()) {
    const n = Math.floor(chunk.length / ch); if (!n) return;
    for (let i = 0; i < n; i++) { const w = ((S.inFrames + i) % cap) * ch; for (let c = 0; c < ch; c++) ring[w + c] = chunk[i * ch + c]; }
    S.inFrames += n;
    if (frames() > cap - rate) { const lose = frames() - (cap - rate); S.rd += lose; S.overflow += lose; } // the output stopped: keep the newest
    S.arrivals.push([S.inFrames, arrivedAt]); // the last frame of this chunk came in then
    while (S.arrivals.length > 2 && arrivedAt - S.arrivals[0][1] > WINDOW_MS) S.arrivals.shift();
  }
  // the output's position, moved on to now at the clock's rate
  function advance(t) { if (!S.started) return; S.pos += (t - S.posAt) / 1000 * rate * S.ratio; S.posAt = t; }
  /** When output frame k plays (ms). */
  const playAt = (k, t) => t + (k - S.pos) / (rate * S.ratio) * 1000;
  function measure(t) {
    if (!S.started || !S.arrivals.length) return null;
    const shift = S.rd - S.out; let best = -Infinity;
    for (const [iEnd, a] of S.arrivals) { const d = playAt(iEnd - 1 - shift, t) - a; if (d > best) best = d; }
    return best;
  }
  /**
   * Called every few ms: what to send to the output now (interleaved Int16Array), or null.
   * Starts once delayMs of audio is waiting.
   */
  function tick(t = now()) {
    if (!S.started) {
      if (!S.arrivals.length) return null;
      const first = S.arrivals.find(x => x[0] > S.rd) || S.arrivals[0]; // (how long the oldest waiting audio has waited)
      const waited = t - first[1] + (first[0] - 1 - S.rd) / rate * 1000;
      if (waited < S.delayMs) return null;
      // start: the oldest frames waiting beyond the delay are skipped, so the first one sent has waited delayMs
      const extra = Math.floor((waited - S.delayMs) / 1000 * rate); if (extra > 0) S.rd = Math.min(S.inFrames, S.rd + extra);
      S.started = true; S.pos = 0; S.posAt = t; S.out = 0;
    }
    advance(t);
    // keep the delay where it should be: drop a frame (too late) or play one twice (too early)
    const m = measure(t); S.measuredMs = m;
    if (m != null) { const err = m - S.delayMs;
      if (!S.fixing && Math.abs(err) > FIX_ON_MS) S.fixing = true; else if (S.fixing && Math.abs(err) < FIX_OFF_MS) S.fixing = false; }
    const want = Math.floor(S.pos + leadMs / 1000 * rate), n = want - S.out;
    if (n <= 0) return null;
    const buf = new Int16Array(n * ch), g0 = S.gainNow, g1 = S.gain; S.gainNow = g1;
    let fix = S.fixing && m != null ? Math.sign(m - S.delayMs) : 0; // +1: drop one, -1: play one twice
    for (let i = 0; i < n; i++) {
      if (fix > 0 && frames() > 1) { S.rd++; S.dropped++; fix = 0; } // (one each tick at most)
      const have = frames() > 0, w = (S.rd % cap) * ch, g = g0 + (g1 - g0) * (i / n);
      for (let c = 0; c < ch; c++) { const v = have ? ring[w + c] * g : 0; buf[i * ch + c] = v > 32767 ? 32767 : v < -32768 ? -32768 : v; }
      if (!have) { S.underruns++; continue; } // nothing to play yet: silence, and the delay grows (fixed above)
      if (fix < 0) { S.inserted++; fix = 0; continue; } // this frame again next time
      S.rd++;
    }
    S.out += n;
    return buf;
  }
  /**
   * The output says how many frames it has played (ffmpeg's progress), at wall time t: its clock. The first reports set
   * how far behind our estimate it runs (a constant: its buffer, counted in the light timing); after that the
   * estimate follows it, its rate too (a PLL), so it never creeps.
   */
  function reportPlayed(played, t = now()) {
    if (!S.started) return; advance(t); const C = S.clock, off = played - S.pos; C.reports++; C.last = { played, t };
    if (C.off0 == null) { C.offs.push(off); if (C.offs.length >= 8) { const s = [...C.offs].sort((a, b) => a - b); C.off0 = s[s.length >> 1]; } return; }
    const e = off - C.off0; // frames: + the output is ahead of our estimate
    if (Math.abs(e) > rate * 0.5) { C.off0 = off; return; } // a jump (the output restarted): start again from here
    S.pos += e * 0.05; S.ratio = Math.max(0.99, Math.min(1.01, S.ratio + e / rate * 0.0025));
  }
  /** The input frame the speakers play at wall time t (fractional), or null before the output starts. */
  function heardFrame(t = now()) {
    if (!S.started) return null;
    const pos = S.pos + (t - S.posAt) / 1000 * rate * S.ratio;
    return pos + (S.rd - S.out); // (the frames dropped or doubled from here on are a few ms ahead; not counted)
  }
  return {
    push, tick, reportPlayed, heardFrame,
    get started() { return S.started; },
    get inFrames() { return S.inFrames; },
    set delayMs(v) { S.delayMs = v; }, get delayMs() { return S.delayMs; },
    set volume(v) { S.gain = Math.max(0, Math.min(1.5, Number(v) || 0)); }, get volume() { return S.gain; },
    rate, channels: ch,
    /** For the status: the delay asked for and measured (ms), the fixes so far, the output clock's rate against ours. */
    stats() { return { started: S.started, delayMs: S.delayMs, measuredMs: S.measuredMs == null ? null : Math.round(S.measuredMs * 10) / 10, waitingMs: Math.round(frames() / rate * 1000),
      dropped: S.dropped, inserted: S.inserted, underruns: S.underruns, overflow: S.overflow, clockPpm: Math.round((S.ratio - 1) * 1e6), clockReports: S.clock.reports }; },
  };
}
