// Apple Home (HomeKit) bridge. No iPhone here, so the tests play the iPhone: a small HomeKit controller with its own
// SRP client, Pair Setup M1-M6, Pair Verify M1-M4 and the encrypted session, talking to a real Tempolight app over
// TCP. Plus known-answer tests for the building blocks where public test vectors exist.
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { createApp } from "../src/app.js";
import { encode, decode, decodeList, T, ERR } from "../src/homekit/tlv.js";
import { group, toBig, toBuf, kOf, xOf, uOf, modPow, srpServer, srpClient, HAP_GROUP } from "../src/homekit/srp.js";
import { hkdf, nonce, seal, open, edKeyPair, edSign, edVerify, xKeyPair, xShared, setupUri, setupHash, newSetupCode } from "../src/homekit/hapcrypto.js";
import { answer, RR } from "../src/homekit/mdns.js";
import { hkName, hsvHex, sceneActive } from "../src/homekit/bridge.js";
import { coerce } from "../src/homekit/hap.js";
import { parseDns, devicesFromRecords, mdnsQuery } from "../../outputs/src/discover.js";

const hex = s => Buffer.from(s.replace(/\s+/g, ""), "hex");
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 4000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(20); } return false; }

// ---------------------------------------------------------------- known answers
test("SRP-6a math matches the RFC 5054 appendix B test vectors (1024-bit group, SHA-1)", () => {
  const N = toBig(hex(`EEAF0AB9 ADB38DD6 9C33F80A FA8FC5E8 60726187 75FF3C0B 9EA2314C 9C256576 D674DF74 96EA81D3 383B4813 D692C6E0 E0D5D8E2 50B98BE4
    8E495C1D 6089DAD1 5DC7D7B4 6154D6B6 CE8EF4AD 69B15D49 82559B29 7BCF1885 C529F566 660E57EC 68EDBC3C 05726CC0 2FD4CBF4 976EAA9A FD5138FE 8376435B
    9FC61D2F C0EB06E3`));
  const G = group(N, 2n, "sha1"), s = hex("BEB25379 D1A8581E B5A72767 3A2441EE");
  const a = toBig(hex("60975527 035CF2AD 1989806F 0407210B C81EDC04 E2762A56 AFD529DD DA2D4393")), b = toBig(hex("E487CB59 D31AC550 471E81F0 0F6928E0 1DDA08E9 74A004F4 9E61F5D1 05284D20"));
  assert.equal(toBuf(kOf(G)).toString("hex").toUpperCase(), "7556AA045AEF2CDD07ABAF0F665C3E818913186F");
  const x = xOf(G, s, "alice", "password123"); assert.equal(toBuf(x).toString("hex").toUpperCase(), "94B7555AABE9127CC58CCF4993DB6CF84D16C124");
  const v = modPow(2n, x, N), A = modPow(2n, a, N), B = (kOf(G) * v + modPow(2n, b, N)) % N;
  assert.equal(toBuf(uOf(G, A, B)).toString("hex").toUpperCase(), "CE38B9593487DA98554ED47D70A7AE5F462EF019");
  // the premaster secret, both ways
  const server = srpServer({ G, I: "alice", P: "password123", salt: s, b }), client = srpClient({ G, I: "alice", P: "password123", salt: s, B: server.B, a });
  const S = toBuf(client.S, 128).toString("hex").toUpperCase();
  assert.ok(S.startsWith("B0DC82BABCF30674AE450C0287745E7990A3381F63B387AAF271A10D"), "premaster secret starts as in RFC 5054");
  assert.ok(S.endsWith("C346D7E474B29EDE8A469FFECA686E5A"), "premaster secret ends as in RFC 5054");
  assert.ok(server.check(client.A, client.M1), "the server accepts the client's proof"); assert.equal(toBuf(server.S, 128).toString("hex").toUpperCase(), S);
});

test("SRP with HomeKit's group: right code pairs, wrong code doesn't; A = 0 mod N is refused", () => {
  assert.equal(HAP_GROUP.len, 384); assert.equal(HAP_GROUP.N % 2n, 1n); assert.equal(HAP_GROUP.N >> 3071n, 1n); // the 3072-bit prime
  const srv = srpServer({ P: "123-45-679" }), c = srpClient({ P: "123-45-679", salt: srv.salt, B: srv.B });
  const M2 = srv.check(c.A, c.M1); assert.ok(M2 && c.verify(M2) && srv.K.equals(c.K) && c.K.length === 64);
  const srv2 = srpServer({ P: "123-45-679" }), bad = srpClient({ P: "123-45-678", salt: srv2.salt, B: srv2.B });
  assert.equal(srv2.check(bad.A, bad.M1), null);
  const srv3 = srpServer({ P: "123-45-679" }); assert.equal(srv3.check(toBuf(HAP_GROUP.N, 384), Buffer.alloc(64)), null);
});

test("HKDF matches RFC 5869 test case 1 (SHA-256); HomeKit uses the same code with SHA-512", () => {
  const okm = hkdf(Buffer.alloc(22, 0x0b), hex("000102030405060708090a0b0c"), hex("f0f1f2f3f4f5f6f7f8f9"), 42, "sha256");
  assert.equal(okm.toString("hex"), "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865");
  assert.equal(hkdf(Buffer.from("k"), "Control-Salt", "Control-Read-Encryption-Key").length, 32);
});

test("ChaCha20-Poly1305 matches the RFC 8439 section 2.8.2 AEAD test vector", () => {
  const key = Buffer.from(Array.from({ length: 32 }, (_, i) => 0x80 + i)), n = hex("070000004041424344454647"), aad = hex("50515253c0c1c2c3c4c5c6c7");
  const pt = Buffer.from("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.");
  const out = seal(key, n, pt, aad);
  assert.equal(out.subarray(0, 16).toString("hex"), "d31a8d34648e60db7b86afbc53ef7ec2");
  assert.equal(out.subarray(out.length - 16).toString("hex"), "1ae10b594f09e26a7e902ecbd0600691");
  assert.deepEqual(open(key, n, out, aad), pt);
  const bad = Buffer.from(out); bad[3] ^= 1; assert.equal(open(key, n, bad, aad), null, "a changed byte fails the tag");
  assert.equal(nonce("PS-Msg05").toString("hex"), "00000000" + Buffer.from("PS-Msg05").toString("hex"));
  assert.equal(nonce(1).toString("hex"), "000000000100000000000000");
});

test("TLV8: long values split into 255-byte items and join again; separators keep list entries apart", () => {
  const big = crypto.randomBytes(600), b = encode([[T.State, 2], [T.PublicKey, big], [T.Salt, Buffer.alloc(16, 7)]]);
  assert.equal(b.length, 3 + (2 + 255) * 2 + 2 + 90 + 18);
  const d = decode(b); assert.equal(d[T.State][0], 2); assert.deepEqual(d[T.PublicKey], big); assert.equal(d[T.Salt].length, 16);
  const l = decodeList(encode([[T.Identifier, "a"], [T.Separator, Buffer.alloc(0)], [T.Identifier, "b"]]));
  assert.deepEqual(l.filter(x => x[0] === T.Identifier).map(x => x[1].toString()), ["a", "b"]);
  assert.throws(() => decodeList(Buffer.from([6, 5, 1])));
});

test("Ed25519 and X25519 with raw 32-byte keys", () => {
  const kp = edKeyPair(), m = Buffer.from("hello"), sig = edSign(kp, m);
  assert.ok(edVerify(kp.pub, m, sig)); assert.ok(!edVerify(kp.pub, Buffer.from("hellO"), sig)); assert.ok(!edVerify(Buffer.alloc(31), m, sig));
  const a = xKeyPair(), b = xKeyPair(); assert.deepEqual(xShared(a, b.pub), xShared(b, a.pub));
});

test("setup code, setup URI and setup hash", () => {
  for (let i = 0; i < 50; i++) assert.match(newSetupCode(), /^\d{3}-\d{2}-\d{3}$/);
  let n = 0; assert.equal(newSetupCode(() => [12345678, 11111111, 5][n++]), "000-00-005", "trivial codes are skipped");
  const uri = setupUri("518-08-582", "1QJ8", 2); assert.match(uri, /^X-HM:\/\/[0-9A-Z]{9}1QJ8$/);
  const payload = BigInt(parseInt(uri.slice(7, 16), 36));
  assert.equal(payload & ((1n << 27n) - 1n), 51808582n); assert.equal((payload >> 28n) & 1n, 1n, "IP flag"); assert.equal((payload >> 31n) & 0xffn, 2n, "category: bridge");
  assert.equal(setupHash("1QJ8", "AA:BB:CC:DD:EE:FF"), crypto.createHash("sha512").update("1QJ8AA:BB:CC:DD:EE:FF").digest().subarray(0, 4).toString("base64"));
});

test("characteristic values are coerced to the format and range", () => {
  assert.equal(coerce({ format: "bool" }, 1), true); assert.equal(coerce({ format: "bool" }, "x"), undefined);
  assert.equal(coerce({ format: "int", minValue: 0, maxValue: 100 }, 140), 100); assert.equal(coerce({ format: "int" }, 4.6), 5); assert.equal(coerce({ format: "float" }, "nope"), undefined);
  assert.equal(hkName("Party mode!"), "Party mode"); assert.equal(hkName("🎉"), "Tempolight"); assert.equal(hkName("Kid's room"), "Kid's room");
  assert.equal(hsvHex(0, 100), "#ff0000"); assert.equal(hsvHex(120, 100), "#00ff00"); assert.equal(hsvHex(240, 50), "#8080ff"); assert.equal(hsvHex(77, 0), "#ffffff");
  const data = { show: { power: true, mode: "auto", style: "party", palette: "auto" }, settings: { brightness: 1 } };
  assert.ok(sceneActive({ show: { mode: "auto", style: "party" }, brightness: 1 }, data)); assert.ok(!sceneActive({ show: { style: "chill" } }, data));
});

test("mDNS: answers _hap._tcp questions with PTR, SRV, TXT and A records (and ignores others)", () => {
  const svc = { instance: "Tempolight 1A2B", service: "_hap._tcp.local", host: "Tempolight-1A2B.local", port: 51827, txt: { "c#": 3, ff: 0, id: "AA:BB:CC:DD:1A:2B", md: "Tempolight", pv: "1.1", "s#": 1, sf: 1, ci: 2, sh: "abcd" } };
  const interfaces = [{ address: "192.168.1.20", netmask: "255.255.255.0" }, { address: "10.0.0.5", netmask: "255.0.0.0" }];
  const r = answer(mdnsQuery("_hap._tcp.local"), svc, { from: "192.168.1.33", interfaces });
  assert.ok(r && r.unicast, "the QU bit asks for a unicast answer");
  const recs = parseDns(r.packet), dev = devicesFromRecords(recs, "_hap._tcp.local");
  assert.deepEqual(dev, [{ name: "Tempolight 1A2B", ip: "192.168.1.20", port: 51827, hostname: "Tempolight-1A2B.local" }], "only the address on the asker's network");
  const txt = recs.find(x => x.type === RR.TXT).data; for (const k of ["c#=3", "ff=0", "id=AA:BB:CC:DD:1A:2B", "md=Tempolight", "pv=1.1", "s#=1", "sf=1", "ci=2", "sh=abcd"]) assert.ok(txt.includes(k), k);
  assert.equal(answer(mdnsQuery("_wled._tcp.local"), svc, { from: "192.168.1.33", interfaces }), null);
  const aq = mdnsQuery("Tempolight-1A2B.local"); aq.writeUInt16BE(RR.A, aq.length - 4);
  const host = answer(aq, svc, { from: "10.1.2.3", interfaces }); // an A question
  assert.ok(host); assert.deepEqual(parseDns(host.packet).filter(x => x.type === RR.A).map(x => x.data), ["10.0.0.5"]);
  const legacy = Buffer.from(mdnsQuery("_hap._tcp.local")); legacy.writeUInt16BE(0x1234, 0);
  const lr = answer(legacy, svc, { from: "192.168.1.33", port: 40000, interfaces }); assert.equal(lr.packet.readUInt16BE(0), 0x1234, "a legacy query gets its ID back"); assert.equal(lr.packet.readUInt16BE(4), 1);
});

// ---------------------------------------------------------------- the pretend iPhone
class Controller {
  constructor(port) { this.port = port; this.enc = null; this.buf = Buffer.alloc(0); this.plain = Buffer.alloc(0); this.waiting = []; this.events = []; this.id = "C0FFEE-" + crypto.randomBytes(4).toString("hex").toUpperCase(); this.ltk = edKeyPair(); }
  connect() { return new Promise((res, rej) => { this.sock = net.connect(this.port, "127.0.0.1", res); this.sock.on("error", rej); this.sock.on("data", d => this.data(d)); this.closed = new Promise(r => this.sock.on("close", r)); }); }
  data(d) {
    if (!this.enc) this.plain = Buffer.concat([this.plain, d]);
    else { this.buf = Buffer.concat([this.buf, d]);
      while (this.buf.length >= 2) { const len = this.buf.readUInt16LE(0); assert.ok(len <= 1024, "frames are at most 1024 bytes"); if (this.buf.length < len + 18) break;
        const p = open(this.enc.read, nonce(this.enc.rc++), this.buf.subarray(2, len + 18), this.buf.subarray(0, 2)); assert.ok(p, "accessory frame decrypts"); this.frames = (this.frames || 0) + 1;
        this.plain = Buffer.concat([this.plain, p]); this.buf = this.buf.subarray(len + 18); } }
    for (;;) { const e = this.plain.indexOf("\r\n\r\n"); if (e < 0) return;
      const lines = this.plain.toString("latin1", 0, e).split("\r\n"), h = {}; for (const l of lines.slice(1)) { const i = l.indexOf(":"); h[l.slice(0, i).toLowerCase()] = l.slice(i + 1).trim(); }
      const len = Number(h["content-length"] || 0); if (this.plain.length < e + 4 + len) return;
      const msg = { proto: lines[0].split(" ")[0], status: Number(lines[0].split(" ")[1]), headers: h, body: Buffer.from(this.plain.subarray(e + 4, e + 4 + len)) }; this.plain = this.plain.subarray(e + 4 + len);
      if (msg.proto === "EVENT/1.0") this.events.push(JSON.parse(msg.body)); else this.waiting.shift()?.(msg); }
  }
  request(method, p, body, type = "application/hap+json") {
    const b = body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const msg = Buffer.concat([Buffer.from(`${method} ${p} HTTP/1.1\r\nHost: tempolight.local\r\n${b.length || method !== "GET" ? `Content-Type: ${type}\r\nContent-Length: ${b.length}\r\n` : ""}\r\n`), b]);
    const r = new Promise(res => this.waiting.push(res));
    if (!this.enc) this.sock.write(msg);
    else for (let i = 0; i < msg.length; i += 1024) { const c = msg.subarray(i, i + 1024), aad = Buffer.alloc(2); aad.writeUInt16LE(c.length); this.sock.write(Buffer.concat([aad, seal(this.enc.write, nonce(this.enc.wc++), c, aad)])); }
    return r;
  }
  async tlv(p, items) { const r = await this.request("POST", p, encode(items), "application/pairing+tlv8"); assert.equal(r.headers["content-type"], "application/pairing+tlv8"); return decode(r.body); }
  async json(method, p, body) { const r = await this.request(method, p, body); return { status: r.status, json: r.body.length ? JSON.parse(r.body) : null }; }

  /** Pair Setup M1-M6. Returns the accessory's {id, ltpk}, or {error} from M2/M4/M6. */
  async pairSetup(code) {
    const m2 = await this.tlv("/pair-setup", [[T.State, 1], [T.Method, 0]]); if (m2[T.Error]) return { error: m2[T.Error][0], state: m2[T.State][0] };
    assert.equal(m2[T.State][0], 2); assert.equal(m2[T.Salt].length, 16); assert.equal(m2[T.PublicKey].length, 384);
    const srp = srpClient({ P: code, salt: m2[T.Salt], B: m2[T.PublicKey] });
    const m4 = await this.tlv("/pair-setup", [[T.State, 3], [T.PublicKey, srp.A], [T.Proof, srp.M1]]); if (m4[T.Error]) return { error: m4[T.Error][0], state: m4[T.State][0] };
    assert.ok(srp.verify(m4[T.Proof]), "the accessory's SRP proof M2 checks out");
    const key = hkdf(srp.K, "Pair-Setup-Encrypt-Salt", "Pair-Setup-Encrypt-Info"), X = hkdf(srp.K, "Pair-Setup-Controller-Sign-Salt", "Pair-Setup-Controller-Sign-Info");
    const sig = edSign(this.ltk, Buffer.concat([X, Buffer.from(this.id), this.ltk.pub]));
    const m6 = await this.tlv("/pair-setup", [[T.State, 5], [T.EncryptedData, seal(key, nonce("PS-Msg05"), encode([[T.Identifier, this.id], [T.PublicKey, this.ltk.pub], [T.Signature, sig]]))]]);
    if (m6[T.Error]) return { error: m6[T.Error][0], state: m6[T.State][0] };
    const sub = decode(open(key, nonce("PS-Msg06"), m6[T.EncryptedData])), accX = hkdf(srp.K, "Pair-Setup-Accessory-Sign-Salt", "Pair-Setup-Accessory-Sign-Info");
    assert.ok(edVerify(sub[T.PublicKey], Buffer.concat([accX, sub[T.Identifier], sub[T.PublicKey]]), sub[T.Signature]), "the accessory's long-term signature checks out");
    this.acc = { id: sub[T.Identifier].toString(), ltpk: sub[T.PublicKey] }; return this.acc;
  }
  /** Pair Verify M1-M4, then the session is encrypted. */
  async pairVerify(acc = this.acc) {
    const kp = xKeyPair(), m2 = await this.tlv("/pair-verify", [[T.State, 1], [T.PublicKey, kp.pub]]); if (m2[T.Error]) return { error: m2[T.Error][0] };
    const accPub = m2[T.PublicKey], shared = xShared(kp, accPub), key = hkdf(shared, "Pair-Verify-Encrypt-Salt", "Pair-Verify-Encrypt-Info");
    const sub = decode(open(key, nonce("PV-Msg02"), m2[T.EncryptedData])); assert.equal(sub[T.Identifier].toString(), acc.id);
    assert.ok(edVerify(acc.ltpk, Buffer.concat([accPub, sub[T.Identifier], kp.pub]), sub[T.Signature]), "the accessory proves it is the one we paired with");
    const sig = edSign(this.ltk, Buffer.concat([kp.pub, Buffer.from(this.id), accPub]));
    const m4 = await this.tlv("/pair-verify", [[T.State, 3], [T.EncryptedData, seal(key, nonce("PV-Msg03"), encode([[T.Identifier, this.id], [T.Signature, sig]]))]]);
    if (m4[T.Error]) return { error: m4[T.Error][0] };
    assert.equal(m4[T.State][0], 4);
    this.enc = { write: hkdf(shared, "Control-Salt", "Control-Write-Encryption-Key"), read: hkdf(shared, "Control-Salt", "Control-Read-Encryption-Key"), rc: 0n, wc: 0n }; return { ok: true };
  }
  close() { this.sock.destroy(); }
}
const charOf = (accs, name, type) => { for (const a of accs) { const sv = a.services.find(s => s.characteristics.some(c => c.type === "23" && c.value === name) && s.type !== "3E"); if (sv) return { aid: a.aid, ...sv.characteristics.find(c => c.type === type) }; } return null; };

test("a HomeKit controller pairs, verifies, reads the bridge, switches a scene and gets events", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tl-hk-"));
  let app = await createApp({ dataDir: dir, logger: null, discover: false, homekit: { mdns: false, host: "127.0.0.1" } }); await app.listen(0, "127.0.0.1");
  const api = (m, p, body) => app.core.handle(m, p, { body: body || {} });
  try {
    assert.equal((await api("GET", "/api/homekit")).enabled, false, "off until turned on"); assert.equal(app.homekit.hap, null);
    let v = await api("PATCH", "/api/homekit", { enabled: true });
    assert.equal(v.state, "ready"); assert.ok(v.port > 0); assert.match(v.setupCode, /^\d{3}-\d{2}-\d{3}$/); assert.match(v.setupUri, /^X-HM:\/\//); assert.equal(v.paired, false);
    assert.equal(app.store.data.settings.homekit.enabled, true);

    // before pairing: nothing but pairing and identify
    const c = new Controller(v.port); await c.connect();
    assert.equal((await c.json("GET", "/accessories")).status, 470);
    assert.equal((await c.request("POST", "/identify")).status, 204, "identify works while unpaired");
    // a wrong code is refused at M4
    const wrong = await c.pairSetup(v.setupCode === "111-22-333" ? "111-22-334" : "111-22-333"); assert.deepEqual(wrong, { error: ERR.Authentication, state: 4 });
    // the right code pairs
    const acc = await c.pairSetup(v.setupCode); assert.ok(acc.id && acc.ltpk.length === 32, JSON.stringify(acc)); assert.equal(acc.id, v.deviceId);
    v = await api("GET", "/api/homekit"); assert.equal(v.paired, true); assert.equal(v.pairings.length, 1); assert.equal(v.pairings[0].id, c.id); assert.equal(v.pairings[0].admin, true);
    const saved = JSON.parse(readFileSync(path.join(dir, "homekit.json"), "utf8")); assert.equal(saved.pairings[0].pub, c.ltk.pub.toString("hex"));
    assert.ok(!JSON.stringify(app.store.data).includes(saved.seed), "the private key is not in tempolight.json (or backups)");
    // a second Pair Setup is refused now
    const other = new Controller(v.port); await other.connect(); assert.deepEqual(await other.pairSetup(v.setupCode), { error: ERR.Unavailable, state: 2 }); other.close();
    // an unknown controller can't verify
    const stranger = new Controller(v.port); await stranger.connect(); assert.deepEqual(await stranger.pairVerify(acc), { error: ERR.Authentication }); stranger.close();

    // verify, then the encrypted session
    assert.deepEqual(await c.pairVerify(), { ok: true });
    const r = await c.json("GET", "/accessories"); assert.equal(r.status, 200); assert.ok(c.frames > 1, "the accessory list came in several encrypted frames");
    const accs = r.json.accessories; assert.equal(accs[0].aid, 1); assert.ok(accs.every(a => a.services[0].type === "3E" && a.services[0].iid === 1), "every accessory has Accessory Information at iid 1");
    assert.ok(accs[0].services.some(s => s.type === "A2"), "the bridge has Protocol Information");
    const iids = accs.map(a => a.services.flatMap(s => [s.iid, ...s.characteristics.map(x => x.iid)])); for (const l of iids) assert.equal(new Set(l).size, l.length, "iids are unique in an accessory");
    const lightOn = charOf(accs, "Tempolight", "25"), bright = charOf(accs, "Tempolight", "8"), party = charOf(accs, "Party mode", "25"), chill = charOf(accs, "Chill mode", "25"), auto = charOf(accs, "Music reactive", "25");
    assert.ok(lightOn && bright && party && chill && auto); assert.equal(bright.unit, "percentage"); assert.equal(bright.maxValue, 100);
    assert.equal(accs.length, 3 + app.store.data.scenes.length, "bridge, light, Music reactive and one switch per scene");

    // a second controller connection (Home app on another device) follows the same characteristics
    const watch = new Controller(v.port); watch.ltk = c.ltk; watch.id = c.id; await watch.connect(); assert.deepEqual(await watch.pairVerify(acc), { ok: true });
    const ev = [lightOn, bright, party, chill, auto].map(x => ({ aid: x.aid, iid: x.iid, ev: true }));
    assert.equal((await c.json("PUT", "/characteristics", { characteristics: ev })).status, 204);
    assert.equal((await watch.json("PUT", "/characteristics", { characteristics: ev })).status, 204);

    // "Hey Siri, turn on Party mode"
    assert.equal((await c.json("PUT", "/characteristics", { characteristics: [{ aid: party.aid, iid: party.iid, value: true }] })).status, 204);
    assert.equal(app.store.data.show.style, "party"); assert.equal(app.store.data.settings.brightness, 1);
    let g = await c.json("GET", `/characteristics?id=${party.aid}.${party.iid},${chill.aid}.${chill.iid},${bright.aid}.${bright.iid}`);
    assert.equal(g.status, 200); assert.deepEqual(g.json.characteristics.map(x => x.value), [true, false, 100]);
    assert.ok(await until(() => watch.events.some(e => e.characteristics.some(x => x.aid === party.aid && x.iid === party.iid && x.value === true))), "the other controller hears Party mode turn on");
    assert.ok(watch.events.some(e => e.characteristics.some(x => x.aid === bright.aid && x.value === 100)), "and the brightness it set");

    // brightness from the Home app
    assert.equal((await c.json("PUT", "/characteristics", { characteristics: [{ aid: bright.aid, iid: bright.iid, value: 40 }] })).status, 204);
    assert.equal(app.store.data.settings.brightness, 0.4);
    assert.ok(await until(() => c.events.some(e => e.characteristics.some(x => x.aid === party.aid && x.value === false))), "Party mode reads off once the show no longer matches it");
    assert.ok(!c.events.some(e => e.characteristics.some(x => x.aid === bright.aid && x.value === 40)), "no event back to the controller that wrote it");

    // a change made in Tempolight (the web app, a schedule) reaches the Home app as an event
    c.events.length = 0; await api("POST", "/api/power", { on: false });
    assert.ok(await until(() => c.events.some(e => e.characteristics.some(x => x.aid === lightOn.aid && x.iid === lightOn.iid && x.value === false))), "power off is pushed as an EVENT");
    await api("PATCH", "/api/show", { mode: "manual", effect: "aurora" });
    assert.ok(await until(() => c.events.some(e => e.characteristics.some(x => x.aid === auto.aid && x.value === false))), "Music reactive off when the effect is picked by hand");
    // and back with the Music reactive switch, and the light switch
    assert.equal((await c.json("PUT", "/characteristics", { characteristics: [{ aid: auto.aid, iid: auto.iid, value: 1 }, { aid: lightOn.aid, iid: lightOn.iid, value: true }] })).status, 204);
    assert.equal(app.store.data.show.mode, "auto"); assert.equal(app.store.data.show.power, true);

    // errors are per characteristic (207)
    g = await c.json("PUT", "/characteristics", { characteristics: [{ aid: 1, iid: 5, value: "x" }, { aid: 99, iid: 9, value: true }, { aid: bright.aid, iid: bright.iid, value: "loud" }, { aid: 1, iid: 5, ev: true }] });
    assert.equal(g.status, 207); assert.deepEqual(g.json.characteristics.map(x => x.status), [-70404, -70409, -70410, -70406]);
    g = await c.json("GET", `/characteristics?id=1.2,${bright.aid}.${bright.iid}&meta=1&perms=1&type=1&ev=1`); assert.equal(g.status, 207);
    assert.equal(g.json.characteristics[0].status, -70405); assert.equal(g.json.characteristics[1].status, 0); assert.equal(g.json.characteristics[1].ev, true); assert.equal(g.json.characteristics[1].format, "int");

    // /pairings: list, add a non-admin controller, which can't manage pairings, then remove it
    const list = async who => decodeList((await who.request("POST", "/pairings", encode([[T.State, 1], [T.Method, 5]]), "application/pairing+tlv8")).body).filter(x => x[0] === T.Identifier).map(x => x[1].toString());
    assert.deepEqual(await list(c), [c.id]);
    const guest = new Controller(v.port); let a = decode((await c.request("POST", "/pairings", encode([[T.State, 1], [T.Method, 3], [T.Identifier, guest.id], [T.PublicKey, guest.ltk.pub], [T.Permissions, 0]]), "application/pairing+tlv8")).body);
    assert.equal(a[T.State][0], 2); assert.equal(a[T.Error], undefined); assert.deepEqual(await list(c), [c.id, guest.id]);
    await guest.connect(); assert.deepEqual(await guest.pairVerify(acc), { ok: true });
    assert.equal((await guest.json("GET", "/accessories")).status, 200, "the added controller can use the bridge");
    a = decode((await guest.request("POST", "/pairings", encode([[T.State, 1], [T.Method, 5]]), "application/pairing+tlv8")).body); assert.equal(a[T.Error][0], ERR.Authentication, "but not manage pairings");
    a = decode((await c.request("POST", "/pairings", encode([[T.State, 1], [T.Method, 4], [T.Identifier, guest.id]]), "application/pairing+tlv8")).body); assert.equal(a[T.State][0], 2);
    await Promise.race([guest.closed, sleep(2000)]); assert.ok(guest.sock.destroyed, "a removed controller is disconnected"); assert.deepEqual(await list(c), [c.id]);

    // a new scene: new switch, new config number
    const cn = JSON.parse(readFileSync(path.join(dir, "homekit.json"), "utf8")).cn;
    await api("POST", "/api/scenes", { name: "Disco time", show: { mode: "auto", style: "party" }, brightness: 0.9 });
    const accs2 = (await c.json("GET", "/accessories")).json.accessories; assert.ok(charOf(accs2, "Disco time", "25"));
    assert.equal(charOf(accs2, "Party mode", "25").aid, party.aid, "existing scenes keep their accessory id");
    assert.equal(JSON.parse(readFileSync(path.join(dir, "homekit.json"), "utf8")).cn, cn + 1);
    c.close(); watch.close();

    // after a restart: same identity, same pairing
    await app.close(); app = await createApp({ dataDir: dir, logger: null, discover: false, homekit: { mdns: false, host: "127.0.0.1" } }); await app.homekit.ready;
    v = await api("GET", "/api/homekit"); assert.equal(v.state, "ready"); assert.equal(v.deviceId, acc.id); assert.equal(v.paired, true);
    const again = new Controller(v.port); again.ltk = c.ltk; again.id = c.id; await again.connect(); assert.deepEqual(await again.pairVerify(acc), { ok: true });
    assert.equal((await again.json("GET", `/characteristics?id=${party.aid}.${party.iid}`)).status, 200);

    // reset: a new identity and code, unpaired, the old controller is dropped
    const before = v.setupCode; v = await api("POST", "/api/homekit/reset");
    assert.equal(v.paired, false); assert.notEqual(v.deviceId, acc.id); assert.equal(v.state, "ready"); void before;
    await Promise.race([again.closed, sleep(2000)]); assert.ok(again.sock.destroyed);
    const fresh = new Controller(v.port); await fresh.connect(); assert.ok((await fresh.pairSetup(v.setupCode)).id); fresh.close();
    // turning it off stops the server
    v = await api("PATCH", "/api/homekit", { enabled: false }); assert.equal(v.state, "off"); assert.equal(app.homekit.hap, null);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
