// WLED JSON API: read device info, write segments, switch presets. Uses Node's built-in fetch (Node 18+).

/** Device info: name, LED count, firmware version, chip, Wi-Fi signal. */
export async function getInfo(host, timeoutMs = 3000) {
  const r = await fetch(`http://${host}/json/info`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`WLED ${host} answered ${r.status}`);
  const j = await r.json();
  return { name: j.name, leds: j.leds?.count ?? 0, version: j.ver, arch: j.arch, signal: j.wifi?.signal, rssi: j.wifi?.rssi, mac: j.mac };
}

/**
 * The JSON body that sets WLED's segments to match our zones on that controller.
 * WLED's `stop` is exclusive, so a zone covering LEDs 0-99 becomes start 0, stop 100.
 * @param {{start:number, end:number, name:string, rev?:boolean}[]} segs
 */
export function segmentsBody(segs) {
  return { seg: segs.slice().sort((a, b) => a.start - b.start).map((s, i) => ({ id: i, start: s.start, stop: s.end + 1, n: s.name, rev: !!s.rev })) };
}

export async function setSegments(host, segs) {
  const r = await fetch(`http://${host}/json/state`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(segmentsBody(segs)) });
  if (!r.ok) throw new Error(`WLED ${host} refused segments: ${r.status}`);
  return r.json();
}

/** Turn WLED on/off, set brightness, or load one of its own presets (used for ambient and fallback modes). */
export async function setState(host, state) {
  const r = await fetch(`http://${host}/json/state`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(state) });
  if (!r.ok) throw new Error(`WLED ${host} refused state: ${r.status}`);
  return r.json();
}
