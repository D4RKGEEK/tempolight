#!/usr/bin/env node
// A pretend Ableton Link peer, for tests and for trying Tempolight's Link following without Ableton Live.
//   node scripts/fake-link.js [bpm]       announces a session on 224.76.78.75:20808 and answers clock pings
// Its "ghost" (session) clock is its own clock plus a big offset, so a follower that skips the measurement is wrong.
import dgram from "node:dgram";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { discoveryMessage, parseMeasurement, pongMessage, ALIVE, BYEBYE, PING, LINK_GROUP, LINK_PORT } from "../packages/server/src/ableton-link.js";

/**
 * @param {{bpm?:number, targets?:{address:string, port:number}[], ghostOffsetUs?:number, playing?:boolean|null, answerPings?:boolean, intervalMs?:number, sessionId?:string}} o
 *  targets: where the announcements go (default: the Link multicast group); tests send them straight to 127.0.0.1.
 */
export async function startFakeLinkPeer({ bpm = 120, targets = [{ address: LINK_GROUP, port: LINK_PORT }], ghostOffsetUs = 987654321, playing = true, answerPings = true, intervalMs = 250, sessionId } = {}) {
  const nodeId = crypto.randomBytes(8).toString("hex"); sessionId = sessionId || nodeId;
  const ghost = () => Math.round(performance.now() * 1000) + ghostOffsetUs;
  let timeline = { microsPerBeat: Math.round(60e6 / bpm), beatOrigin: 0, timeOrigin: 0 };
  timeline.timeOrigin = ghost() - Math.round(3.25 * timeline.microsPerBeat); // the session is at beat 3.25 now
  const beatsAtGhost = g => timeline.beatOrigin / 1e6 + (g - timeline.timeOrigin) / timeline.microsPerBeat;
  const msock = dgram.createSocket("udp4"), dsock = dgram.createSocket("udp4");
  let pings = 0;
  msock.on("message", (buf, r) => { const m = parseMeasurement(buf); if (!m || m.type !== PING) return; pings++; if (answerPings) msock.send(pongMessage(sessionId, ghost(), m.payload), r.port, r.address); });
  await new Promise(r => msock.bind(0, "127.0.0.1", r));
  const endpoint = { address: "127.0.0.1", port: msock.address().port };
  await new Promise(r => dsock.bind(0, r));
  const announce = (type = ALIVE) => { const b = discoveryMessage({ type, nodeId, sessionId, timeline, playing, endpoint }); for (const t of targets) dsock.send(b, t.port, t.address, () => {}); };
  announce(); const timer = setInterval(announce, intervalMs);
  return {
    nodeId, sessionId, endpoint, get pings() { return pings; }, get timeline() { return { ...timeline }; },
    /** The session's beat at performance.now() time `ms`. */
    beatsAt: ms => beatsAtGhost(Math.round(ms * 1000) + ghostOffsetUs),
    /** Change the tempo the way Link does: the beat stays where it is now, the timeline starts again from here. */
    setTempo(b) { const g = ghost(), at = beatsAtGhost(g); timeline = { microsPerBeat: Math.round(60e6 / b), beatOrigin: Math.round(at * 1e6), timeOrigin: g }; announce(); },
    setPlaying(p) { playing = p; announce(); },
    close() { clearInterval(timer); try { announce(BYEBYE); } catch {} setTimeout(() => { try { dsock.close(); } catch {} try { msock.close(); } catch {} }, 20); },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const bpm = Number(process.argv[2]) || 120, p = await startFakeLinkPeer({ bpm });
  console.log(`Fake Link peer at ${bpm} BPM (session ${p.sessionId}), clock answers on UDP ${p.endpoint.port}. Ctrl+C to stop.`);
  process.on("SIGINT", () => { p.close(); setTimeout(() => process.exit(0), 50); });
}
