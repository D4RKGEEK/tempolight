// A small MQTT 3.1.1 client on Node's net module: connect (with user, password and a last-will), publish and
// subscribe at QoS 0, keep-alive pings, and reconnecting by itself. Enough for Home Assistant; no packages needed.
import net from "node:net";

const enc = s => { const b = Buffer.from(String(s), "utf8"), l = Buffer.alloc(2); l.writeUInt16BE(b.length); return Buffer.concat([l, b]); };
function remLen(n) { const out = []; do { let d = n % 128; n = Math.floor(n / 128); if (n > 0) d |= 128; out.push(d); } while (n > 0); return Buffer.from(out); }
const packet = (type, flags, body) => Buffer.concat([Buffer.from([(type << 4) | flags]), remLen(body.length), body]);

/**
 * @param {string} url mqtt://host:1883
 * @param {{username?:string, password?:string, clientId?:string, will?:{topic:string, payload:string, retain?:boolean}, keepalive?:number,
 *   onMessage?:(topic:string, payload:Buffer)=>void, onState?:(state:string, error?:string)=>void}} o
 */
export function mqttConnect(url, o = {}) {
  const u = new URL(url.includes("://") ? url : "mqtt://" + url), keep = o.keepalive || 30;
  let sock = null, buf = Buffer.alloc(0), closed = false, retry = null, ping = null, connected = false, pid = 1;
  const subs = new Set(), state = (s, e) => o.onState && o.onState(s, e);
  function open() {
    sock = net.connect(Number(u.port) || 1883, u.hostname); sock.setNoDelay(true);
    sock.on("connect", () => {
      let flags = 0x02; const parts = [enc("MQTT"), Buffer.from([4]), null, Buffer.from([keep >> 8, keep & 255]), enc(o.clientId || "tempolight")];
      if (o.will) { flags |= 0x04 | (o.will.retain ? 0x20 : 0); parts.push(enc(o.will.topic), enc(o.will.payload)); }
      const user = o.username || decodeURIComponent(u.username || ""), pass = o.password || decodeURIComponent(u.password || "");
      if (user) { flags |= 0x80; parts.push(enc(user)); } if (pass) { flags |= 0x40; parts.push(enc(pass)); }
      parts[2] = Buffer.from([flags]); sock.write(packet(1, 0, Buffer.concat(parts)));
    });
    sock.on("data", d => { buf = Buffer.concat([buf, d]); parse(); });
    sock.on("error", e => state("error", e.message));
    sock.on("close", () => { connected = false; clearInterval(ping); if (!closed) { state("reconnecting"); retry = setTimeout(open, 5000); } });
  }
  function parse() {
    for (;;) {
      if (buf.length < 2) return; let mult = 1, len = 0, i = 1, d;
      do { if (i >= buf.length) return; d = buf[i++]; len += (d & 127) * mult; mult *= 128; } while (d & 128);
      if (buf.length < i + len) return; const type = buf[0] >> 4, body = buf.subarray(i, i + len); buf = buf.subarray(i + len);
      if (type === 2) { // CONNACK
        if (body[1] !== 0) { state("error", ["", "bad protocol", "client id refused", "server unavailable", "wrong user name or password", "not authorised"][body[1]] || `refused (${body[1]})`); closed = true; sock.end(); return; }
        connected = true; state("connected"); for (const t of subs) sendSub(t); ping = setInterval(() => sock.write(Buffer.from([0xc0, 0])), keep * 1000 * 0.8);
      } else if (type === 3) { const tl = body.readUInt16BE(0), topic = body.toString("utf8", 2, 2 + tl), qos = (buf[0] >> 1) & 3; let off = 2 + tl; if (qos) off += 2;
        try { o.onMessage && o.onMessage(topic, body.subarray(off)); } catch {} }
    }
  }
  const sendSub = t => { const id = pid++ & 0xffff || 1; sock.write(packet(8, 2, Buffer.concat([Buffer.from([id >> 8, id & 255]), enc(t), Buffer.from([0])]))); };
  open();
  return {
    get connected() { return connected; },
    publish(topic, payload, { retain = false } = {}) { if (!connected) return false; sock.write(packet(3, retain ? 1 : 0, Buffer.concat([enc(topic), Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload))]))); return true; },
    subscribe(topic) { subs.add(topic); if (connected) sendSub(topic); },
    close() { closed = true; clearTimeout(retry); clearInterval(ping); try { if (connected) sock.write(Buffer.from([0xe0, 0])); sock.end(); } catch {} },
  };
}
