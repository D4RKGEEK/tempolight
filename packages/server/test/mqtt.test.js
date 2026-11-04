import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { createApp } from "../src/app.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 5000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(30); } return false; }
const str = s => { const b = Buffer.from(s), l = Buffer.alloc(2); l.writeUInt16BE(b.length); return Buffer.concat([l, b]); };
const rl = n => { const o = []; do { let d = n % 128; n = Math.floor(n / 128); if (n) d |= 128; o.push(d); } while (n); return Buffer.from(o); };

// a tiny MQTT broker: remembers retained messages (and sends them to new subscribers), records connects, forwards
// publishes to subscribers (topics, + and # wildcards)
const matches = (f, t) => { const a = f.split("/"), b = t.split("/"); for (let i = 0; i < a.length; i++) { if (a[i] === "#") return true; if (i >= b.length || (a[i] !== "+" && a[i] !== b[i])) return false; } return a.length === b.length; };
const pub = (topic, payload, retain) => { const body = Buffer.concat([str(topic), Buffer.from(payload)]); return Buffer.concat([Buffer.from([retain ? 0x31 : 0x30]), rl(body.length), body]); };
function startBroker() {
  const retained = new Map(), clients = new Set(), connects = [];
  const server = net.createServer(sock => {
    const c = { sock, subs: new Set() }; clients.add(c); let buf = Buffer.alloc(0);
    sock.on("data", d => { buf = Buffer.concat([buf, d]);
      for (;;) { if (buf.length < 2) break; let m = 1, len = 0, i = 1, x; do { if (i >= buf.length) return; x = buf[i++]; len += (x & 127) * m; m *= 128; } while (x & 128);
        if (buf.length < i + len) break; const h = buf[0], body = buf.subarray(i, i + len); buf = buf.subarray(i + len); const type = h >> 4;
        if (type === 1) { const flags = body[7]; let o = 10; const id = body.toString("utf8", o + 2, o + 2 + body.readUInt16BE(o)); o += 2 + body.readUInt16BE(o);
          let will = null; if (flags & 4) { const t = body.toString("utf8", o + 2, o + 2 + body.readUInt16BE(o)); o += 2 + body.readUInt16BE(o); const p = body.toString("utf8", o + 2, o + 2 + body.readUInt16BE(o)); o += 2 + body.readUInt16BE(o); will = { t, p }; }
          let user = null; if (flags & 0x80) { user = body.toString("utf8", o + 2, o + 2 + body.readUInt16BE(o)); }
          connects.push({ id, will, user }); sock.write(Buffer.from([0x20, 2, 0, 0])); }
        else if (type === 3) { const tl = body.readUInt16BE(0), topic = body.toString("utf8", 2, 2 + tl), payload = body.subarray(2 + tl);
          if (h & 1) retained.set(topic, payload.toString()); for (const o of clients) if ([...o.subs].some(f => matches(f, topic))) o.sock.write(Buffer.concat([Buffer.from([0x30]), rl(body.length), body])); }
        else if (type === 8) { const tl = body.readUInt16BE(2), f = body.toString("utf8", 4, 4 + tl); c.subs.add(f); sock.write(Buffer.from([0x90, 3, body[0], body[1], 0]));
          for (const [t, v] of retained) if (v && matches(f, t)) sock.write(pub(t, v, true)); }
        else if (type === 12) sock.write(Buffer.from([0xd0, 0])); } });
    sock.on("close", () => clients.delete(c)); sock.on("error", () => {});
  });
  return new Promise(r => server.listen(0, "127.0.0.1", () => r({ port: server.address().port, retained, connects,
    send(topic, payload) { const pkt = pub(topic, payload, false); for (const o of clients) if ([...o.subs].some(f => matches(f, topic))) o.sock.write(pkt); },
    close: () => new Promise(res => { for (const o of clients) o.sock.destroy(); server.close(res); }) })));
}

test("Home Assistant: MQTT discovery, state and commands", async () => {
  const broker = await startBroker(), dir = mkdtempSync(path.join(os.tmpdir(), "tl-mqtt-"));
  const app = await createApp({ dataDir: dir, discover: false, logger: null }), port = await app.listen(0, "127.0.0.1");
  const call = async (m, p, b) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: m, headers: { "content-type": "application/json" }, body: b && JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
  try {
    broker.retained.set("homeassistant/scene/tempolight/scene_gone/config", JSON.stringify({ name: "Deleted while Tempolight was off" })); // left over from an earlier run
    assert.equal((await call("PATCH", "/api/settings", { mqtt: { enabled: true, url: "" } })).status, 400);
    const r = await call("PATCH", "/api/settings", { mqtt: { enabled: true, url: `mqtt://127.0.0.1:${broker.port}`, username: "ha", password: "secret" } });
    assert.equal(r.status, 200); assert.equal(r.body.mqtt.password, "", "the password is not sent back"); assert.equal(r.body.mqtt.hasPassword, true);
    assert.ok(await until(() => broker.retained.has("homeassistant/light/tempolight/light/config")), "the light is announced");
    assert.equal(broker.connects[0].user, "ha"); assert.equal(broker.connects[0].will.t, "tempolight/availability");
    const light = JSON.parse(broker.retained.get("homeassistant/light/tempolight/light/config"));
    assert.equal(light.command_topic, "tempolight/light/set"); assert.ok(light.effect_list.includes("Automatic")); assert.equal(light.device.name, "Tempolight");
    for (const k of ["select/tempolight/scene", "sensor/tempolight/bpm", "button/tempolight/flash"]) assert.ok(broker.retained.has(`homeassistant/${k}/config`), k);
    assert.equal(broker.retained.get("tempolight/availability"), "online");
    assert.ok(await until(() => broker.retained.has("tempolight/light/state")));
    assert.equal(JSON.parse(broker.retained.get("tempolight/light/state")).state, "ON");
    assert.equal((await call("GET", "/api/status")).body.mqtt.state, "connected");

    broker.send("tempolight/light/set", JSON.stringify({ brightness: 128, effect: light.effect_list[3] }));
    assert.ok(await until(async () => Math.abs((await call("GET", "/api/state")).body.settings.brightness - 128 / 255) < 0.01), "brightness from Home Assistant");
    const st = (await call("GET", "/api/state")).body; assert.equal(st.show.mode, "manual"); assert.equal(st.effects.find(e => e.id === st.show.effect).name, light.effect_list[3]);
    broker.send("tempolight/light/set", JSON.stringify({ state: "OFF" }));
    assert.ok(await until(() => JSON.parse(broker.retained.get("tempolight/light/state")).state === "OFF"), "power off is reported back");
    broker.send("tempolight/light/set", JSON.stringify({ state: "ON", effect: "Automatic" }));
    assert.ok(await until(async () => (await call("GET", "/api/state")).body.show.mode === "auto"));

    const movie = (await call("POST", "/api/scenes", { name: "Movie night" })).body;
    assert.ok(await until(() => JSON.parse(broker.retained.get("homeassistant/select/tempolight/scene/config")).options.includes("Movie night")), "new scenes are re-announced");

    // every scene is also a Home Assistant scene entity, for "Hey Google, activate Party mode"
    const party = JSON.parse(broker.retained.get("homeassistant/scene/tempolight/scene_party/config"));
    assert.deepEqual([party.name, party.command_topic, party.payload_on, party.availability_topic, party.unique_id], ["Party mode", "tempolight/scene/set", "party", "tempolight/availability", "tempolight_scene_party"]);
    assert.equal(party.device, undefined, "no device, so the name a voice assistant hears is just the scene's name");
    for (const id of ["chill", "movie", "focus", "relax"]) assert.ok(broker.retained.has(`homeassistant/scene/tempolight/scene_${id}/config`), id);
    assert.ok(await until(() => broker.retained.has(`homeassistant/scene/tempolight/scene_${movie.id}/config`)), "a new scene gets its entity");
    broker.send("tempolight/scene/set", "chill"); // what Home Assistant sends when the "Chill mode" scene is activated
    assert.ok(await until(async () => { const b = (await call("GET", "/api/state")).body; return b.show.style === "chill" && Math.abs(b.settings.brightness - 0.55) < 0.01; }), "activating the scene in Home Assistant applies it");
    const off = JSON.parse(broker.retained.get("homeassistant/scene/tempolight/tempolight_off/config"));
    assert.equal(off.name, "Tempolight off"); assert.equal(off.command_topic, "tempolight/light/set");
    broker.send(off.command_topic, off.payload_on);
    assert.ok(await until(() => JSON.parse(broker.retained.get("tempolight/light/state")).state === "OFF"), "\"Tempolight off\" turns the lights off");
    assert.ok(await until(() => broker.retained.get("homeassistant/scene/tempolight/scene_gone/config") === ""), "scene entities of scenes that no longer exist are removed");
    await call("DELETE", `/api/scenes/${movie.id}`);
    assert.ok(await until(() => broker.retained.get(`homeassistant/scene/tempolight/scene_${movie.id}/config`) === ""), "a deleted scene is removed from Home Assistant");
    await call("PATCH", "/api/settings", { mqtt: { enabled: false } });
    assert.ok(await until(() => broker.retained.get("tempolight/availability") === "offline"), "turning it off marks Tempolight unavailable");
  } finally { await app.close(); await broker.close(); rmSync(dir, { recursive: true, force: true }); }
});
