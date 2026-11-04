// Small helpers shared by the smart-bulb outputs (LIFX, WiZ, Kasa, Yeelight, Twinkly). Node built-ins only.
import dgram from "node:dgram";
import os from "node:os";

/** "192.168.1.5" or "192.168.1.5:1234" (or "[::1]:1234") -> [ip, port or the default] */
export function hostPort(host, def) {
  const s = String(host || "").trim(), m = /^\[(.+)\](?::(\d+))?$/.exec(s) || /^([^:]+)(?::(\d+))?$/.exec(s);
  return m ? [m[1], Number(m[2]) || def] : [s, def];
}

/** sRGB 0-255 -> hue 0-360, saturation 0-1, value 0-1 */
export function rgbToHsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0; if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: ((h * 60) + 360) % 360, s: mx ? d / mx : 0, v: mx / 255 };
}

/** Average LEDs into `n` colours (zones): the device's buffer may be longer or shorter than the light has zones. */
export function zoneColours(rgb, n) {
  const leds = Math.floor(rgb.length / 3), out = new Uint8Array(n * 3); if (!leds) return out;
  for (let z = 0; z < n; z++) { const a = Math.floor(z * leds / n), b = Math.max(a + 1, Math.floor((z + 1) * leds / n)); let r = 0, g = 0, bl = 0;
    for (let i = a; i < b; i++) { r += rgb[i * 3]; g += rgb[i * 3 + 1]; bl += rgb[i * 3 + 2]; }
    out[z * 3] = Math.round(r / (b - a)); out[z * 3 + 1] = Math.round(g / (b - a)); out[z * 3 + 2] = Math.round(bl / (b - a)); }
  return out;
}
/** True when every channel moved less than `tol` (so a light that can't take many commands isn't sent the same colour again). */
export const sameColours = (a, b, tol = 3) => !!a && !!b && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < tol);

/**
 * Send UDP datagrams and collect answers for a while.
 * @param {{to:[string, number][]|[string, number], packets:Buffer[]|Buffer, timeoutMs:number, broadcast?:boolean, bindPort?:number,
 *   onMessage:(msg:Buffer, rinfo:object)=>boolean|void}} o onMessage returns true to finish early
 */
export function udpExchange({ to, packets, timeoutMs, broadcast = false, bindPort = 0, onMessage, repeatMs = 0 }) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true }); let done = false, rep = null;
    const finish = () => { if (done) return; done = true; clearTimeout(timer); clearInterval(rep); try { sock.close(); } catch {} resolve(); };
    const timer = setTimeout(finish, timeoutMs);
    sock.on("error", finish);
    sock.on("message", (m, r) => { try { if (onMessage(m, r)) finish(); } catch {} });
    const targets = Array.isArray(to[0]) ? to : [to], list = Array.isArray(packets) ? packets : [packets];
    const send = () => { for (const [ip, port] of targets) for (const p of list) { try { sock.send(p, port, ip); } catch {} } };
    sock.bind(bindPort, () => { if (broadcast) try { sock.setBroadcast(true); } catch {} send(); if (repeatMs) rep = setInterval(send, repeatMs); });
  });
}

/** The address of this computer that `ip` would see us at (for lights that connect back, like Yeelight's music mode). */
export function localAddressFor(ip, port = 9) {
  return new Promise((resolve) => {
    const s = dgram.createSocket("udp4"); const end = v => { try { s.close(); } catch {} resolve(v); };
    s.on("error", () => end(null));
    try { s.connect(port, ip, () => { try { end(s.address().address); } catch { end(null); } }); } catch { end(null); }
  });
}

/** Broadcast addresses to try for discovery: the limited broadcast, plus each local subnet's (some networks drop 255.255.255.255). */
export async function broadcastTargets() {
  const out = new Set(["255.255.255.255"]);
  for (const a of Object.values(os.networkInterfaces()).flat()) if (a && a.family === "IPv4" && !a.internal && a.netmask) {
    const ip = a.address.split(".").map(Number), m = a.netmask.split(".").map(Number); out.add(ip.map((v, i) => (v & m[i]) | (~m[i] & 255)).join(".")); }
  return [...out];
}
