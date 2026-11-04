import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import { fitPoints } from "../src/lights.js";
import { fakeLifx, fakeWiz, fakeKasa, fakeYeelight, fakeTwinkly } from "../../outputs/test/fake-lights.js";
import { pskServer } from "../../outputs/test/dtls-server.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 5000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(50); } return false; }
async function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tl-lights-")), app = await createApp({ dataDir: dir, discover: false, logger: null });
  const port = await app.listen(0, "127.0.0.1"), base = `http://127.0.0.1:${port}`;
  const call = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  return { app, call, async done() { await app.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const shapesOf = (s, id) => s.app.store.data.room.shapes.filter(x => x.dev === id);

test("room points: fitted into a box, y flipped", () => {
  assert.deepEqual(fitPoints([{ x: 0, y: 0 }, { x: 1, y: 1 }], 8, 4.5, 4), [[6, 6.5], [10, 2.5]]);
});

test("smart lights: WiZ and LIFX bulbs, a LIFX strip, Kasa strip zones, Yeelight music mode, Twinkly layout; health, power", async () => {
  const W = await fakeWiz(), L = await fakeLifx(), LS = await fakeLifx({ zones: 30, label: "Shelf", mac: "d073d5000002" }), K = await fakeKasa({ strip: true, zones: 16 }), Y = await fakeYeelight(), T = await fakeTwinkly({ leds: 60 }), s = await setup();
  try {
    const bad = await s.call("POST", "/api/devices", { host: "127.0.0.1:9", kind: "wiz" }); assert.equal(bad.status, 400); assert.match(bad.body.error, /Couldn't reach a WiZ light.*local communication/);
    const wiz = (await s.call("POST", "/api/devices", { host: W.host, kind: "wiz", name: "Bedside" })).body; assert.equal(wiz.kind, "wiz"); assert.equal(wiz.leds, 1);
    assert.deepEqual(shapesOf(s, wiz.id).map(x => [x.type, x.count]), [["points", 1]]);
    assert.equal((await s.call("POST", "/api/devices", { host: W.host, kind: "wiz" })).body.id, wiz.id, "the same light twice is the same device");
    const lifx = (await s.call("POST", "/api/devices", { host: L.host, kind: "lifx" })).body; assert.equal(lifx.name, "Desk"); assert.equal(lifx.light.mac, "d073d5112233");
    const strip = (await s.call("POST", "/api/devices", { host: LS.host, kind: "lifx" })).body; assert.equal(strip.leds, 30); assert.deepEqual(shapesOf(s, strip.id).map(x => [x.type, x.count]), [["line", 30]]);
    const p1 = shapesOf(s, wiz.id)[0].pts[0], p2 = shapesOf(s, lifx.id)[0].pts[0]; assert.notDeepEqual(p1, p2, "bulbs don't sit on top of each other");
    const kasa = (await s.call("POST", "/api/devices", { host: K.host, kind: "kasa" })).body; assert.equal(kasa.leds, 1); assert.equal(kasa.light.strip, true);
    assert.equal((await s.call("PATCH", `/api/devices/${lifx.id}`, { light: { music: true } })).status, 400, "LIFX has no options");
    assert.equal((await s.call("PATCH", `/api/devices/${kasa.id}`, { light: { perZone: "yes" } })).status, 400);
    const kz = (await s.call("PATCH", `/api/devices/${kasa.id}`, { light: { perZone: true } })).body; assert.equal(kz.leds, 16); assert.equal(shapesOf(s, kasa.id)[0].count, 16);
    const yee = (await s.call("POST", "/api/devices", { host: Y.host, kind: "yeelight" })).body; assert.equal(yee.name, "Sofa lamp");
    const tw = (await s.call("POST", "/api/devices", { host: T.host, kind: "twinkly" })).body; assert.equal(tw.leds, 60);
    const tsh = shapesOf(s, tw.id); assert.equal(tsh[0].type, "points"); assert.equal(tsh[0].pts.length, 60, "placed where the Twinkly app mapped them");
    await s.call("PATCH", `/api/devices/${tw.id}`, { light: { rtPort: T.rtPort } });
    await s.call("PATCH", "/api/show", { effect: "solar" });
    assert.ok(await until(() => W.pilots.length > 2 && L.colors.length > 2 && LS.zonesSet.length > 2 && K.cmds.some(c => c["smartlife.iot.lightStrip"]?.set_light_state?.groups) && Y.music.length > 2 && T.frames.length > 2, 6000), "every light gets colours");
    assert.equal(T.frames.at(-1).length, 180);
    const devs = (await s.call("GET", "/api/devices")).body; for (const d of [wiz, lifx, strip, kasa, yee, tw]) await s.call("POST", `/api/devices/${d.id}/check`);
    const h = Object.fromEntries((await s.call("GET", "/api/devices")).body.map(d => [d.kind + (d.leds > 1 ? "+" : ""), d.health]));
    assert.ok(Object.values(h).every(x => x.online), JSON.stringify(h)); assert.match(h.wiz.version, /WiZ ESP01/); assert.match(h["lifx+"].version, /30 zones/); assert.match(h.yeelight.version, /music mode/); assert.equal(devs.length, 6);
    const st = (await s.call("GET", "/api/status")).body; assert.ok(st.devices.every(d => d.sent > 0 && d.online), "status: frames sent to each");
    await s.call("POST", "/api/power", { on: false });
    assert.ok(await until(() => W.pilots.at(-1)?.state === false && L.power.includes(0) && K.cmds.some(c => c["smartlife.iot.lightStrip"]?.set_light_state?.on_off === 0) && Y.music.some(c => c.method === "set_power" && c.params[0] === "off") && T.mode === "off"), "all off");
  } finally { await s.done(); for (const f of [W, L, LS, K, Y, T]) f.close(); }
});

const haveOpenssl = spawnSync("openssl", ["version"]).status === 0;
test("Hue fast mode: pairs again for a client key, reads the entertainment area over CLIP v2, streams HueStream over DTLS, stops on power off", { skip: !haveOpenssl && "needs openssl for the bridge's HTTPS certificate" }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tl-hue-")), key = path.join(dir, "k.pem"), cert = path.join(dir, "c.pem");
  spawnSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=hue"], { stdio: "ignore" });
  const psk = crypto.randomBytes(16), areaId = "6e2fa3cc-1111-4b4b-9c9c-123456789abc", actions = []; let pressed = false, giveKey = false;
  const v1 = http.createServer((q, r) => { let b = ""; q.on("data", c => b += c); q.on("end", () => { const j = o => { r.writeHead(200, { "content-type": "application/json" }); r.end(JSON.stringify(o)); };
    if (q.method === "POST" && q.url === "/api") { const body = JSON.parse(b); return j(!pressed ? [{ error: { type: 101, description: "link button not pressed" } }] : [{ success: { username: "USER2", ...(giveKey && body.generateclientkey ? { clientkey: psk.toString("hex").toUpperCase() } : {}) } }]); }
    if (/^\/api\/USER\d\/lights$/.test(q.url)) return j({ 1: { name: "Left", state: { on: true, xy: [0.3, 0.3], bri: 1 } }, 2: { name: "Right", state: { on: true, xy: [0.3, 0.3], bri: 1 } } });
    j([{ success: {} }]); }); });
  const clip = https.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (q, r) => { let b = ""; q.on("data", c => b += c); q.on("end", () => { const j = (o, code = 200) => { r.writeHead(code, { "content-type": "application/json" }); r.end(JSON.stringify(o)); };
    if (q.headers["hue-application-key"] !== "USER2") return j({ errors: [{ description: "unauthorized user" }] }, 403);
    if (q.url === "/clip/v2/resource/entertainment_configuration") return j({ errors: [], data: [{ id: areaId, metadata: { name: "TV area" }, status: "inactive",
      channels: [{ channel_id: 0, members: [{ service: { rid: "ent-b", rtype: "entertainment" }, index: 0 }] }, { channel_id: 1, members: [{ service: { rid: "ent-a", rtype: "entertainment" }, index: 0 }] }] }] });
    if (q.url === "/clip/v2/resource/entertainment") return j({ data: [{ id: "ent-a", owner: { rid: "dev-a", rtype: "device" } }, { id: "ent-b", owner: { rid: "dev-b", rtype: "device" } }] });
    if (q.url === "/clip/v2/resource/light") return j({ data: [{ id: "l-a", id_v1: "/lights/1", owner: { rid: "dev-a" } }, { id: "l-b", id_v1: "/lights/2", owner: { rid: "dev-b" } }] });
    if (q.url === `/clip/v2/resource/entertainment_configuration/${areaId}` && q.method === "PUT") { actions.push(JSON.parse(b).action); return j({ data: [{ rid: areaId }] }); }
    j({ errors: [{ description: "not found" }] }, 404); }); });
  await new Promise(r => v1.listen(0, "127.0.0.1", r)); await new Promise(r => clip.listen(0, "127.0.0.1", r));
  const dtls = await pskServer({ psk, identity: "USER2" }), s = await setup(), host = `127.0.0.1:${v1.address().port}`;
  try {
    pressed = true; const add = (await s.call("POST", "/api/devices", { host, kind: "hue" })).body; assert.equal(add.hue.fastKey, false, "an old-style pairing: no client key");
    pressed = false; const no = await s.call("PATCH", `/api/devices/${add.id}`, { hueFast: true, clipPort: clip.address().port, streamPort: dtls.port });
    assert.equal(no.status, 400); assert.match(no.body.error, /link button/);
    pressed = true; giveKey = true; const on = await s.call("PATCH", `/api/devices/${add.id}`, { hueFast: true });
    assert.equal(on.status, 200, JSON.stringify(on.body)); assert.equal(on.body.hue.fast, true); assert.equal(on.body.hue.area, "TV area"); assert.deepEqual(on.body.hue.areas, [{ id: areaId, name: "TV area" }]);
    const saved = s.app.store.data.devices[0].hue; assert.deepEqual(saved.ent.channels, [{ id: 0, led: 1 }, { id: 1, led: 0 }], "channel 0 is the Right light (LED 1)");
    for (const d of [(await s.call("GET", "/api/devices")).body[0], (await s.call("GET", "/api/state")).body.devices[0], on.body]) { assert.equal(d.hue.clientkey, undefined, "the client key stays on the server"); assert.equal(d.hue.user, undefined); assert.equal(d.hue.ent, undefined); }
    await s.call("PATCH", "/api/show", { effect: "solar" });
    assert.ok(await until(() => dtls.S.app.length > 20), "HueStream messages over DTLS"); assert.deepEqual(actions, ["start"]); assert.deepEqual(dtls.S.errors, []);
    const m = dtls.S.app.at(-1); assert.equal(m.toString("latin1", 0, 9), "HueStream"); assert.equal(m.toString("latin1", 16, 52), areaId); assert.equal(m.length, 52 + 14);
    await s.call("POST", `/api/devices/${add.id}/check`); assert.match((await s.call("GET", "/api/devices")).body[0].health.version, /fast mode/);
    await s.call("POST", "/api/power", { on: false }); assert.ok(await until(() => actions.includes("stop")), "streaming stopped");
    const basic = await s.call("PATCH", `/api/devices/${add.id}`, { hueFast: false }); assert.equal(basic.body.hue.fast, false);
  } finally { await s.done(); dtls.close(); v1.close(); clip.close(); rmSync(dir, { recursive: true, force: true }); }
});
