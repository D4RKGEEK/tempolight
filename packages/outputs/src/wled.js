// WLED JSON API: read device info, write segments, switch presets. Uses Node's built-in fetch (Node 18+).

/** Device info: name, LED count, firmware version, chip, Wi-Fi signal. */
export async function getInfo(host, timeoutMs = 3000) {
  const r = await fetch(`http://${host}/json/info`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`WLED ${host} answered ${r.status}`);
  const j = await r.json();
  return { name: j.name, leds: j.leds?.count ?? 0, version: j.ver, arch: j.arch, signal: j.wifi?.signal, rssi: j.wifi?.rssi, mac: j.mac,
    fps: j.leds?.fps, power: j.leds?.pwr, maxPower: j.leds?.maxpwr, live: !!j.live, udpPort: j.udpport };
}

/** "192.168.1.5" or "192.168.1.5:8080" -> the address to send UDP to (the HTTP port, if any, is dropped). */
export const ipOf = host => String(host).replace(/^\[|\]$/g, "").replace(/:\d+$/, "");

/** Read WLED's current segments (start/stop as WLED reports them). */
export async function getSegments(host, timeoutMs = 3000) {
  const r = await fetch(`http://${host}/json/state`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`WLED ${host} answered ${r.status}`);
  const j = await r.json(); return (j.seg || []).map(s => ({ id: s.id, start: s.start, stop: s.stop, name: s.n, on: s.on }));
}

/**
 * The JSON body that sets WLED's segments to match our zones on that controller.
 * WLED's `stop` is exclusive, so a zone covering LEDs 0-99 becomes start 0, stop 100.
 * @param {{start:number, end:number, name:string, rev?:boolean}[]} segs
 */
export function segmentsBody(segs) {
  return { seg: segs.slice().sort((a, b) => a.start - b.start).map((s, i) => ({ id: i, start: s.start, stop: s.end + 1, n: s.name, rev: !!s.rev })) };
}

export async function setSegments(host, segs, timeoutMs = 4000) {
  const r = await fetch(`http://${host}/json/state`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(segmentsBody(segs)), signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`WLED ${host} refused segments: ${r.status}`);
  return r.json();
}

/** Turn WLED on/off, set brightness, or load one of its own presets (used for ambient and fallback modes). */
export async function setState(host, state, timeoutMs = 4000) {
  const r = await fetch(`http://${host}/json/state`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(state), signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`WLED ${host} refused state: ${r.status}`);
  return r.json();
}
