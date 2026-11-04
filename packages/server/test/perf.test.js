import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import http from "node:http";
import zlib from "node:zlib";
import os from "node:os";
import path from "node:path";
import { createApp, ROOT, acceptsEncoding } from "../src/app.js";
import { weakHost, createPerf } from "../src/perf.js";
import { LiveAnalyser, preAnalyseCore, recognise, memoryEntry } from "../../engine/src/index.js";
import { majorPop, edm } from "../../engine/test/synth.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const PI_ZERO = { cpus: Array(4).fill({ model: "ARMv7 Processor rev 4 (v7l)", speed: 1000 }), arch: "arm", model: "Raspberry Pi Zero 2 W Rev 1.0\0", cpuinfo: "processor\t: 0\nmodel name\t: ARMv7 Processor rev 4 (v7l)\nCPU architecture: 7\n" };
const BIG = { cpus: Array(8).fill({ model: "Fast CPU", speed: 3600 }), arch: "x64", model: "", cpuinfo: "" };
async function setup(opts = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tl-perf-")), app = await createApp({ dataDir: dir, discover: false, logger: null, ...opts });
  const port = await app.listen(0, "127.0.0.1"), base = `http://127.0.0.1:${port}`;
  const call = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  return { app, port, call, async done() { await app.close(); rmSync(dir, { recursive: true, force: true }); } };
}
// a raw GET (fetch would ask for and undo the compression itself)
const get = (port, p, headers = {}) => new Promise((res, rej) => http.get({ host: "127.0.0.1", port, path: p, headers }, r => { const c = []; r.on("data", x => c.push(x)); r.on("end", () => res({ status: r.statusCode, headers: r.headers, body: Buffer.concat(c) })); }).on("error", rej));

test("performance: small computers are found from their model, processor and cores", () => {
  const weak = h => weakHost(h).weak;
  assert.equal(weak(PI_ZERO), true); assert.match(weakHost(PI_ZERO).why, /Pi Zero 2 W/);
  assert.equal(weak({ ...BIG, model: "Raspberry Pi 3 Model B Plus Rev 1.3", arch: "arm64", cpus: Array(4).fill({ speed: 1400 }) }), true, "Pi 3, even 64-bit");
  assert.equal(weak({ cpus: [{ speed: 700 }], arch: "arm", cpuinfo: "model name\t: ARMv6-compatible processor rev 7 (v6l)\nModel\t\t: Raspberry Pi Model B Rev 2\n" }), true, "Pi 1 (from /proc/cpuinfo's Model line)");
  assert.equal(weak({ cpus: Array(4).fill({ speed: 1500 }), arch: "arm64", cpuinfo: "CPU architecture: 8\n", model: "Raspberry Pi 4 Model B Rev 1.4" }), false, "Pi 4 is fine");
  assert.equal(weak({ cpus: Array(4).fill({ speed: 2400 }), arch: "arm64", model: "Raspberry Pi 5 Model B Rev 1.0" }), false, "Pi 5 is fine");
  assert.equal(weak({ cpus: Array(4).fill({ speed: 0 }), arch: "x64", cpuinfo: "model name\t: ARMv7 Processor rev 4 (v7l)\n" }), true, "32-bit ARM in cpuinfo");
  assert.equal(weak({ cpus: [{ speed: 2000 }], arch: "x64" }), true, "a single core");
  assert.equal(weak({ cpus: Array(2).fill({ speed: 1100 }), arch: "x64" }), true, "an old dual-core laptop (Atom, Celeron)");
  assert.equal(weak({ cpus: Array(2).fill({ speed: 2800 }), arch: "x64" }), false, "a fast dual core");
  assert.equal(weak({ cpus: Array(8).fill({ speed: 0 }), arch: "x64" }), false, "unknown speed, many cores");
  assert.equal(weak({}), false, "nothing known (the browser demo): full");
});

test("performance: auto steps down when the frame loop can't keep up, never when set to full", () => {
  let t = 0, setting = "auto"; const notes = [];
  const P = createPerf({ setting: () => setting, host: () => BIG, note: m => notes.push(m), clock: () => t });
  assert.equal(P.mode, "full");
  const run = (ms, n) => { let changed = false; for (let i = 0; i < n; i++) { t += 1000 / 60; changed = P.frame(ms, 60) || changed; } return changed; };
  assert.equal(run(2, 600), false, "light frames: stays full"); assert.equal(P.mode, "full");
  assert.equal(run(14, 300), false, "one slow window is not enough");
  assert.equal(run(14, 400), true, "a second one steps down"); assert.equal(P.mode, "lite"); assert.match(notes[0], /can't keep up/);
  assert.match(P.status().why, /couldn't keep up/); assert.equal(P.status().frameMs, 14);
  setting = "full"; P.update(); assert.equal(P.mode, "full", "full in Settings wins"); assert.equal(run(14, 800), false, "and stays full");
  setting = "auto"; P.update(); assert.equal(P.mode, "full", "back to auto: a fresh start");
  const W = createPerf({ setting: () => "auto", host: () => PI_ZERO, note() {}, clock: () => t }); assert.equal(W.mode, "lite"); assert.match(W.status().why, /Pi Zero/);
});

test("performance: a Pi Zero starts in lite mode (30 fps, lighter analyser); Settings can switch it; /api/status shows it", async () => {
  const s = await setup({ host: PI_ZERO });
  try {
    await s.call("POST", "/api/devices", { virtual: true });
    let st = (await s.call("GET", "/api/status")).body; assert.equal(st.perf.mode, "lite"); assert.equal(st.perf.setting, "auto"); assert.match(st.perf.why, /Pi Zero/);
    for (const k of ["mode", "fps", "frameMs", "cpu"]) assert.ok(k in st.perf, k);
    const f0 = s.app.runtime.rt.frames; await sleep(1500); const fps = (s.app.runtime.rt.frames - f0) / 1.5; assert.ok(fps > 15 && fps < 34, `about 30 fps (${fps})`);
    s.app.runtime.pushPcm(new Int16Array(2205), "capture", "Line in", null, 22050); assert.equal(s.app.runtime.rt.live.an.lite, true, "the analyser skips its heavier extras");
    assert.equal((await s.call("PATCH", "/api/settings", { performance: "turbo" })).status, 400);
    assert.equal((await s.call("PATCH", "/api/settings", { performance: "full" })).body.performance, "full");
    st = (await s.call("GET", "/api/status")).body; assert.equal(st.perf.mode, "full"); assert.equal(s.app.runtime.rt.live.an.lite, false, "the analyser follows");
    await s.call("PATCH", "/api/settings", { performance: "auto" }); assert.equal((await s.call("GET", "/api/status")).body.perf.mode, "lite");
  } finally { await s.done(); }
  const b = await setup({ host: BIG });
  try { const st = (await b.call("GET", "/api/status")).body; assert.equal(st.perf.mode, "full"); assert.equal(b.app.store.data.settings.performance, "auto"); }
  finally { await b.done(); }
});

test("performance: lite listening finds the same tempo and key; recognition one song at a time gives the same answer", async () => {
  const song = majorPop(22050), pcm = new Int16Array(song.x.length); for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(song.x[i] * 0.6 * 32767);
  const out = {};
  for (const lite of [false, true]) { const an = new LiveAnalyser(22050); an.lite = lite; for (let i = 0; i < pcm.length; i += 1102) an.push(pcm.subarray(i, i + 1102)); out[lite] = an; }
  assert.ok(Math.abs(out.true.bpm - out.false.bpm) < 1, `${out.true.bpm} vs ${out.false.bpm}`);
  assert.deepEqual([out.true.keyEst?.key, out.true.keyEst?.mode], [out.false.keyEst?.key, out.false.keyEst?.mode]);
  assert.ok(out.true.ctap.window(), "chroma for song memory is still there");
  // the runtime matches remembered songs one per slice and keeps the best: the same as recognise() over the list
  const a = edm(22050), entries = [];
  for (const [i, x] of [a.x, majorPop(22050).x].entries()) entries.push(memoryEntry("s" + i, await preAnalyseCore(x, 22050), "m" + i));
  const an = new LiveAnalyser(22050), q = new Int16Array(a.x.length); for (let i = 0; i < q.length; i++) q[i] = Math.round(a.x[i] * 0.5 * 32767);
  for (let i = 0; i < 20 * 22050; i += 1102) an.push(q.subarray(i, i + 1102));
  const all = recognise(an.tap.q, entries, an.memoryQuery()); let best = null;
  for (const e of entries) { const r = recognise(an.tap.q, [e], an.memoryQuery()); if (r && (!best || r.score > best.score)) best = r; }
  assert.ok(all && all.id === "m0"); assert.deepEqual(best, all);
});

test("web app files: compressed (brotli, gzip), ETags and 304s, long cache only for versioned URLs", async () => {
  assert.equal(acceptsEncoding("gzip, deflate, br", "br"), true); assert.equal(acceptsEncoding("br;q=0, gzip", "br"), false); assert.equal(acceptsEncoding("*", "gzip"), true); assert.equal(acceptsEncoding("", "gzip"), false);
  const s = await setup();
  try {
    const raw = readFileSync(path.join(ROOT, "apps/web/app.js"));
    const plain = await get(s.port, "/app.js"); assert.equal(plain.status, 200); assert.equal(plain.headers["content-encoding"], undefined); assert.deepEqual(plain.body, raw);
    assert.equal(plain.headers["cache-control"], "no-cache"); assert.match(plain.headers.vary, /Accept-Encoding/i); assert.ok(plain.headers.etag);
    const gz = await get(s.port, "/app.js", { "accept-encoding": "gzip" }); assert.equal(gz.headers["content-encoding"], "gzip");
    assert.deepEqual(zlib.gunzipSync(gz.body), raw); assert.ok(gz.body.length < raw.length / 2, "much smaller"); assert.equal(Number(gz.headers["content-length"]), gz.body.length);
    let br = null; for (let i = 0; i < 50 && br?.headers["content-encoding"] !== "br"; i++) { br = await get(s.port, "/app.js", { "accept-encoding": "br, gzip" }); if (br.headers["content-encoding"] !== "br") await sleep(100); }
    assert.equal(br.headers["content-encoding"], "br", "brotli once it's made"); assert.deepEqual(zlib.brotliDecompressSync(br.body), raw); assert.ok(br.body.length < gz.body.length);
    for (const tag of [plain.headers.etag, gz.headers.etag, br.headers.etag]) { const r = await get(s.port, "/app.js", { "accept-encoding": "br, gzip", "if-none-match": tag }); assert.equal(r.status, 304, tag); assert.equal(r.body.length, 0); }
    assert.equal((await get(s.port, "/app.js", { "if-none-match": '"stale"' })).status, 200);
    const png = await get(s.port, "/icons/icon-192.png", { "accept-encoding": "br, gzip" }); assert.equal(png.status, 200); assert.equal(png.headers["content-encoding"], undefined, "images are already compressed");
    assert.match((await get(s.port, "/style.css?v=abc")).headers["cache-control"], /max-age=31536000, immutable/);
    const page = await get(s.port, "/#/music", { "accept-encoding": "gzip" }); assert.equal(page.headers["content-type"], "text/html; charset=utf-8"); assert.match(zlib.gunzipSync(page.body).toString(), /<title>Tempolight/);
    const deep = await get(s.port, "/engine/layout.js", { "accept-encoding": "gzip" }); assert.equal(deep.headers["content-encoding"], "gzip");
    assert.equal((await get(s.port, "/engine/../../package.json")).status, 404, "nothing outside the served folders");
  } finally { await s.done(); }
});
