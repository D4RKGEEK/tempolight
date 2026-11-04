// Live pads page: follow MIDI clock from one Web MIDI input. Clock (0xF8), Start, Continue, Stop and Song Position
// Pointer messages go to the server with this browser's timestamps, about 25 times a second; the server turns them
// into the beat grid (packages/server/src/midiclock.js).
const REALTIME = new Set([0xf8, 0xfa, 0xfb, 0xfc]);

/** send(obj): sends a WebSocket message. */
export function createClockFollower(send) {
  let input = null, buf = [], timer = null;
  const onMessage = e => { const d = e.data, st = d[0];
    if (REALTIME.has(st)) buf.push([st, e.timeStamp]); else if (st === 0xf2 && d.length >= 3) buf.push([st, e.timeStamp, d[1] | (d[2] << 7)]); };
  const flush = () => { if (!input) return; if (buf.length) send({ type: "midi-clock", events: buf, now: performance.now(), label: input.name || "MIDI input" }); buf = []; };
  return {
    get input() { return input; },
    follow(inp) { this.stop(); input = inp; try { inp.open?.(); } catch {} inp.addEventListener("midimessage", onMessage); timer = setInterval(flush, 40); },
    stop() { if (!input) return; input.removeEventListener("midimessage", onMessage); clearInterval(timer); timer = null; buf = [];
      send({ type: "midi-clock", end: true, events: [], now: performance.now() }); input = null; },
  };
}
