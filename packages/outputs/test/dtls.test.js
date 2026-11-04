import test from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { DtlsClient, prf } from "../src/dtls.js";
import { pskServer } from "./dtls-server.js";
import { hueStreamMessage, HueEntertainmentSender } from "../src/hue-entertainment.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));

test("DTLS: the TLS 1.2 PRF (SHA-256) matches the published test vector", () => {
  const out = prf(Buffer.from("9bbe436ba940f017b17652849a71db35", "hex"), "test label", Buffer.from("a0ba9f936cda311827a6f796ffd5198c", "hex"), 100);
  assert.equal(out.toString("hex"), "e3f229ba727be17b8d122620557cd453c2aab21d07c3d495329b52d4e61edb5a6b301791e90d35c9c9a46b4e14baf9af0fa022f7077def17abfd3797c0564bab4fbc91666e9def9b97fce34f796789baa48082d122ee42c5a72e5a5110fff70187347b66");
});

test("DTLS: PSK handshake with the cookie exchange, application data, close_notify", async () => {
  const psk = crypto.randomBytes(16), srv = await pskServer({ psk, identity: "user-1", hint: "hint" });
  try {
    const c = new DtlsClient({ host: "127.0.0.1", port: srv.port, identity: "user-1", psk });
    await c.connect(); assert.equal(srv.S.verifies, 1); assert.equal(srv.S.hellos, 2); assert.ok(srv.S.done);
    c.send(Buffer.from("hello")); c.send(Buffer.from("world")); await sleep(50);
    assert.deepEqual(srv.S.app.map(String), ["hello", "world"]); c.close(); await sleep(30); assert.deepEqual(srv.S.alerts, [[1, 0]]); assert.deepEqual(srv.S.errors, []);
  } finally { srv.close(); }
});

test("DTLS: no cookie exchange, a fragmented ServerHello, a lost flight sent again", async () => {
  const psk = crypto.randomBytes(16), srv = await pskServer({ psk, identity: "me", cookie: false, fragmentHello: true, dropClientFlights: 1 });
  try {
    const c = new DtlsClient({ host: "127.0.0.1", port: srv.port, identity: "me", psk, retransmitMs: 150 });
    await c.connect(); assert.equal(srv.S.hellos, 1); assert.ok(srv.S.flight3 >= 2, "flight 3 was sent again"); assert.deepEqual(srv.S.errors, []);
    c.send(Buffer.from("x")); await sleep(30); assert.deepEqual(srv.S.app.map(String), ["x"]); c.close();
  } finally { srv.close(); }
});

test("DTLS: a wrong PSK or identity fails with a clear error, and nothing answering times out", async () => {
  const psk = crypto.randomBytes(16), srv = await pskServer({ psk, identity: "me" });
  try {
    await assert.rejects(new DtlsClient({ host: "127.0.0.1", port: srv.port, identity: "me", psk: crypto.randomBytes(16) }).connect(), /decrypt error/);
    await assert.rejects(new DtlsClient({ host: "127.0.0.1", port: srv.port, identity: "nobody", psk }).connect(), /unknown PSK identity/);
  } finally { srv.close(); }
  const dead = dgram.createSocket("udp4"); await new Promise(r => dead.bind(0, "127.0.0.1", r));
  try { await assert.rejects(new DtlsClient({ host: "127.0.0.1", port: dead.address().port, identity: "a", psk, timeoutMs: 400, retransmitMs: 100 }).connect(), /timed out/); } finally { dead.close(); }
});

const haveOpenssl = spawnSync("openssl", ["version"]).status === 0;
test("DTLS: interoperates with OpenSSL's s_server (PSK-AES128-GCM-SHA256, cookie exchange)", { skip: !haveOpenssl ? "openssl isn't installed" : process.platform === "win32" && "the OpenSSL that comes with Git for Windows doesn't serve DTLS over -listen" }, async () => {
  const psk = crypto.randomBytes(16), port = 20000 + Math.floor(Math.random() * 30000);
  const p = spawn("openssl", ["s_server", "-dtls1_2", "-listen", "-nocert", "-psk", psk.toString("hex"), "-psk_identity", "tempolight", "-cipher", "PSK-AES128-GCM-SHA256", "-accept", `127.0.0.1:${port}`, "-quiet"], { stdio: ["pipe", "pipe", "pipe"] });
  let out = "", err = ""; p.stdout.on("data", d => out += d); p.stderr.on("data", d => err += d);
  try {
    await sleep(400);
    const c = new DtlsClient({ host: "127.0.0.1", port, identity: "tempolight", psk, retransmitMs: 300 });
    await c.connect(); c.send(Buffer.from("HueStream over DTLS\n"));
    const t0 = Date.now(); while (!out.includes("HueStream over DTLS") && Date.now() - t0 < 3000) await sleep(50);
    assert.ok(out.includes("HueStream over DTLS"), `openssl got: ${out} ${err}`); c.close();
  } finally { p.kill(); }
});

test("HueStream v2: header, area id, 16-bit RGB per channel", () => {
  const id = "1a8d99cc-967b-44f2-9202-43f976c0fa6b", m = hueStreamMessage(id, 7, [{ id: 0, r: 0xffff, g: 0, b: 0x0101 }, { id: 3, r: 1, g: 2, b: 3 }]);
  assert.equal(m.length, 52 + 14); assert.equal(m.toString("latin1", 0, 9), "HueStream"); assert.deepEqual([...m.subarray(9, 16)], [2, 0, 7, 0, 0, 0, 0]);
  assert.equal(m.toString("latin1", 16, 52), id); assert.deepEqual([...m.subarray(52)], [0, 255, 255, 0, 0, 1, 1, 3, 0, 1, 0, 2, 0, 3]);
});

test("Hue Entertainment sender: starts the area, streams over DTLS, falls back to REST when streaming can't start", async () => {
  const psk = crypto.randomBytes(16), srv = await pskServer({ psk, identity: "USER" }), calls = [], states = [];
  const area = { id: "1a8d99cc-967b-44f2-9202-43f976c0fa6b", channels: [{ id: 0, led: 1 }, { id: 1, led: 0 }] };
  try {
    const s = new HueEntertainmentSender("127.0.0.1:1", { user: "USER", clientkey: psk.toString("hex"), area, lights: ["1", "2"], streamPort: srv.port, onState: st => states.push(st),
      api: { start: async () => calls.push("start"), stop: async () => calls.push("stop") } });
    const t0 = Date.now(); while (Date.now() - t0 < 1500 && srv.S.app.length < 5) { s.send(new Uint8Array([255, 0, 0, 0, 0, 255])); await sleep(10); }
    assert.ok(srv.S.app.length >= 5, "messages stream"); assert.equal(s.mode, "entertainment"); assert.deepEqual(calls, ["start"]);
    const m = srv.S.app.at(-1); assert.equal(m.toString("latin1", 0, 9), "HueStream"); assert.deepEqual([...m.subarray(52)], [0, 0, 0, 0, 0, 255, 255, 1, 255, 255, 0, 0, 0, 0], "channel 0 shows LED 1, channel 1 LED 0");
    const n = srv.S.app.length; await sleep(100); s.send(new Uint8Array(6)); assert.ok(srv.S.app.length <= n + 1);
    const before = srv.S.app.length; const t1 = Date.now(); while (Date.now() - t1 < 300) { s.send(new Uint8Array(6).fill(9)); await sleep(2); }
    assert.ok(srv.S.app.length - before <= 17, `at most 50 a second (${srv.S.app.length - before} in 300 ms)`);
    await s.power(false); assert.deepEqual(calls, ["start", "stop"]); assert.ok(states.includes("streaming")); s.close();
    // no client key: basic mode at once
    const f = new HueEntertainmentSender("127.0.0.1:1", { user: "USER", clientkey: null, area, lights: ["1"], api: { start: async () => calls.push("start2"), stop: async () => {} } });
    f.send(new Uint8Array(3)); await sleep(20); assert.equal(f.mode, "basic"); assert.ok(!calls.includes("start2")); f.close();
  } finally { srv.close(); }
});
