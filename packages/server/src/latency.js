// The live latency meter: for each device, roughly how long after a sound the light shows it, and what may be wrong
// (weak Wi-Fi, a controller dropping frames, the power limit holding brightness back, offline). Pure functions, no
// Node.js modules, so the online demo runs it too.
//
// delay = audio in (browser capture and the trip to the server, or the sound card's buffer)
//       + analysis (the live analyser reacts about one hop and a bit after the sound)
//       + network (one way to the controller: half its measured HTTP round trip, UDP needs no answer)
//       + frame (on average we wait half a frame to render, the controller half a frame to show it)
//       - the light timing offset (positive offsets show the light earlier)
// Songs played in the browser are driven by their play clock, which already allows for the speakers' delay the
// browser knows about, so only the network, the frame and the offset count for them. Speaker delays the browser
// can't see (Bluetooth, the air) are what the one-tap timing fix measures.
//
// Light timing (lookahead): when the beat is known ahead (a song, a beat map, predicted live beats, a metronome or a
// beat clock), the runtime renders each frame for a moment a little in the future, as far ahead as the slowest light
// is late (at most LOOKAHEAD_CAP_MS), and holds each faster light's frames back by the difference. So every light
// shows the same musical moment at the same time, on the beat. Each light's own delay ("light" = network + frame) is
// estimated here, or set by hand on the device (lightLatencyMs).

export const ANALYSIS_MS = 23; // LiveAnalyser: a 256-sample hop at 22,050 Hz (11.6 ms) plus onset smoothing
export const LOOKAHEAD_CAP_MS = 250; // render at most this far ahead (a light slower than this is late by the rest)
export const DEFAULT_NETWORK_MS = 5; // one way on a home network, for a light whose round trip wasn't measured
const FRAME_MS = { hue: 100, hueFast: 20, nanoleaf: 33, govee: 33, lifx: 50, wiz: 100, kasa: 100, yeelight: 50, twinkly: 40 }; // devices that update more slowly than our frame rate

/** Remember a new HTTP round trip for a device; the network delay uses the best of the recent ones (no WLED busy time). */
export function noteRtt(h, ms) {
  if (!(ms >= 0)) return h;
  h.rtts = [...(h.rtts || []), Math.round(ms * 10) / 10].slice(-6);
  h.rttMs = Math.min(...h.rtts);
  return h;
}

/**
 * The audio part of the delay, from what the runtime knows about the current source.
 * @param {{source:string, live?:{kind:string, inMs?:number, chunkMs?:number}|null}} o
 */
export function audioDelay({ source, live }) {
  if (source === "song" || !live || (source !== "browser" && source !== "capture")) return { audioMs: 0, analysisMs: 0 };
  const inMs = live.kind === "browser" ? (live.inMs || 0) : (live.chunkMs || 0); // the browser sends its own estimate (it includes its chunk)
  return { audioMs: Math.round(inMs), analysisMs: newestSampleClock(live.an) != null ? 0 : ANALYSIS_MS }; // an analyser with a newest-sample clock isn't behind
}

/** The live analyser's newest-sample time (s), when it has one (an.sampleT, a number or a function); else null. */
export function newestSampleClock(an) {
  if (!an) return null; const v = typeof an.sampleT === "function" ? an.sampleT() : an.sampleT;
  return Number.isFinite(v) ? v : null;
}

/**
 * One light's own delay: from the moment we send a frame to the moment the light shows it (network one way + how
 * often it updates). A device's lightLatencyMs (0-500), when set, is used instead of the estimate.
 * @returns {{ms:number, auto:boolean, networkMs:number|null, frameMs:number}}
 */
export function lightLatency(dev, health = {}, fps = 60) {
  const networkMs = dev.virtual ? 0 : health.rttMs != null ? Math.round(health.rttMs / 2) : null;
  const frameMs = Math.round(FRAME_MS[dev.kind === "hue" && dev.hue?.ent?.on ? "hueFast" : dev.kind] || 1000 / Math.max(1, fps || 60));
  const own = Number(dev.lightLatencyMs), manual = dev.lightLatencyMs != null && dev.lightLatencyMs !== "" && Number.isFinite(own);
  return { ms: manual ? Math.max(0, Math.min(500, Math.round(own))) : (networkMs ?? DEFAULT_NETWORK_MS) + frameMs, auto: !manual, networkMs, frameMs };
}

/**
 * The lookahead and how long to hold each light back. ahead: the beat is known ahead (else nothing is held and the
 * lights react as fast as they can). devices: the lights that show something now, [{id, ms}].
 * @returns {{lookaheadMs:number, holds:Map<string, number>, slowest:string|null}}
 */
export function timingPlan({ devices, ahead = true, capMs = LOOKAHEAD_CAP_MS }) {
  const holds = new Map(); let L = 0, slowest = null;
  if (ahead) for (const d of devices) if (d.ms > L) { L = d.ms; slowest = d.id; }
  L = Math.min(capMs, L);
  for (const d of devices) holds.set(d.id, ahead ? Math.max(0, L - d.ms) : 0);
  return { lookaheadMs: L, holds, slowest };
}

/**
 * Latency and warnings for one device.
 * @param {object} o
 * @param {object} o.dev       the device (settings file)
 * @param {object} o.health    what the last check found: {online, rttMs, signal, rssi, fps, live, power, maxPower, error}
 * @param {object} [o.out]     {limited, sent}: what we send it
 * @param {number} o.fps       our frame rate right now
 * @param {number} o.offsetMs  the light timing offset
 * @param {{audioMs:number, analysisMs:number}} o.audio
 * @param {boolean} [o.streaming] we are sending it frames now (power on, device enabled)
 * @param {number} [o.streamingFor] for how many seconds we had been sending when the device was last checked
 */
export function deviceLatency({ dev, health = {}, out = {}, fps = 60, offsetMs = 0, audio = { audioMs: 0, analysisMs: 0 }, streaming = true, streamingFor = 0 }) {
  const warnings = [], warn = (kind, text) => warnings.push({ kind, text });
  const ourFps = Math.max(1, fps || 60);
  const light = lightLatency(dev, health, ourFps), { networkMs, frameMs } = light;
  const latencyMs = dev.enabled === false || health.online === false ? null
    : Math.round(audio.audioMs + audio.analysisMs + light.ms - (offsetMs || 0));

  if (dev.enabled !== false && health.online === false) warn("offline", `Not answering${health.error ? ` (${health.error})` : ""}. Check it has power and is on the same Wi-Fi.`);
  if (health.online && !dev.virtual) {
    const sig = health.signal, rssi = health.rssi;
    if ((sig != null && sig < 25) || (rssi != null && rssi < -82)) warn("wifi", `Very weak Wi-Fi (${sig != null ? sig + "%" : rssi + " dBm"}): frames will be lost. Move the controller or the router closer.`);
    else if ((sig != null && sig < 45) || (rssi != null && rssi < -72)) warn("wifi", `Weak Wi-Fi (${sig != null ? sig + "%" : rssi + " dBm"}): lights may stutter.`);
    if (networkMs != null && networkMs > 60) warn("slow", `Slow network: ${networkMs} ms each way to the controller.`);
    if (streaming && streamingFor > 4 && !dev.kind) { // only WLED reports these
      if (health.live === false) warn("notlive", "WLED isn't showing our stream. In WLED, Sync settings: turn on “Receive UDP realtime”.");
      else if (health.fps > 0 && health.fps < ourFps * 0.6) warn("frames", `Dropping frames: it shows ${Math.round(health.fps)} of the ${Math.round(ourFps)} a second we send. Lower the frame rate in Settings, or improve the Wi-Fi.`);
    }
    if (health.maxPower > 0 && health.power >= health.maxPower * 0.95) warn("power", `WLED's own power limit is holding brightness back (${health.power} of ${health.maxPower} mA).`);
  }
  if (out.limited) warn("power", "The power limit is holding brightness back right now.");
  return { latencyMs, latency: { audioMs: audio.audioMs, analysisMs: audio.analysisMs, networkMs, frameMs, offsetMs: offsetMs || 0, lightMs: light.ms, lightAuto: light.auto }, latencyLevel: level(latencyMs), warnings };
}

/** good under 40 ms (hard to notice), ok under 80 ms, slow above; early (negative) is judged the same way. */
export function level(ms) { if (ms == null) return "none"; const a = Math.abs(ms); return a < 40 ? "good" : a < 80 ? "ok" : "slow"; }
