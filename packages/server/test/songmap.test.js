import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import { syncRaw, syncScore, songMap, createLiveMap, downsample, HINTS } from "../src/songmap.js";
import { edm } from "../../engine/test/synth.js";
import { preAnalyseCore } from "../../engine/src/index.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 5000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(50); } return false; }
async function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tl-map-")), app = await createApp({ dataDir: dir, discover: false, logger: null });
  const port = await app.listen(0, "127.0.0.1"), base = `http://127.0.0.1:${port}`;
  const call = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  return { app, call, async done() { await app.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const live = (conf, drumless = false) => ({ conf, drumless, misses: 0 });

test("sync score: states and hints from the real signals", () => {
  const base = { source: "browser", ext: null, lock: false, level: 0.5, sound: true, listening: true };
  assert.deepEqual(syncRaw({ ...base, source: "song" }), { raw: 100, source: "song", hint: HINTS.song, hearing: true });
  assert.equal(syncRaw({ ...base, source: "nowplaying" }).source, "memory");
  assert.equal(syncRaw({ ...base, live: live(0.3), lock: true }).hint, "Following the song's beat map");
  assert.equal(syncRaw({ ...base, live: live(0.3), ext: "djlink" }).hint, "Beat from DJ Link");
  assert.equal(syncRaw({ ...base, source: "midiclock", listening: false }).hint, "Beat from MIDI clock");
  assert.equal(syncRaw({ ...base, live: live(0.3), ext: "link" }).hint, "Beat from Ableton Link");
  assert.equal(syncRaw({ ...base, live: live(0.9) }).hint, null, "locked live: nothing to say");
  assert.equal(syncRaw({ ...base, live: live(0.3) }).hint, "Finding the beat…");
  assert.equal(syncRaw({ ...base, live: live(0.9, true) }).hint, "No drums — following the melody");
  assert.ok(syncRaw({ ...base, live: live(0.9, true) }).raw < 65, "no drums: not called locked");
  assert.equal(syncRaw({ ...base, live: live(0.9), level: 0.05 }).hint, "Too quiet — turn it up or move the mic closer");
  assert.equal(syncRaw({ ...base, source: "idle", live: live(0), sound: false }).hint, HINTS.quiet, "listening to silence");
  assert.deepEqual(syncRaw({ source: "idle", listening: false }), { raw: 0, source: null, hint: null, hearing: false });

  // smoothing: a new source jumps; the same source eases; locked holds down to 50
  const mem = {}; let r = syncScore({ ...base, live: live(0.9) }, mem, 0);
  assert.deepEqual(r, { score: 90, state: "locked", hint: null, source: "live" });
  r = syncScore({ ...base, live: live(0.55) }, mem, 250); assert.equal(r.state, "locked"); assert.ok(r.score > 55 && r.score < 90, `eased ${r.score}`);
  for (let t = 500; t < 6000; t += 250) r = syncScore({ ...base, live: live(0.3) }, mem, t);
  assert.equal(r.state, "finding"); assert.equal(r.score, 30); assert.equal(r.hint, "Finding the beat…");
  r = syncScore({ ...base, source: "song" }, mem, 6250); assert.deepEqual(r, { score: 100, state: "locked", hint: HINTS.song, source: "song" });
  r = syncScore({ ...base, live: live(0.9, true) }, mem, 6300); assert.equal(r.state, "finding", "locked from the song isn't carried over to a drumless live song");
  r = syncScore({ source: "idle", listening: false }, mem, 6500); assert.deepEqual(r, { score: 0, state: "none", hint: null, source: null });
  r = syncScore({ ...base, source: "idle", live: live(0), sound: false }, mem, 6750); assert.equal(r.state, "none"); assert.equal(r.hint, HINTS.quiet);
});

test("song map: sections, drops, bars and loudness from an analysis; a live map grows as it is heard", () => {
  const env = new Float32Array(50 * 60).map((_, i) => i < 1500 ? 0.1 : 0.8);
  const bars = Array.from({ length: 30 }, (_, i) => ({ t0: i * 2, t1: i * 2 + 2, state: i < 15 ? "calm" : i < 20 ? "build" : "drop", level: 0.5 }));
  const m = songMap({ dur: 60, env, bars, drops: [40], sections: null });
  assert.ok(m.env.length <= 480 && m.env.length >= 400, `env ${m.env.length}`); assert.equal(m.env.at(-1), 1); assert.ok(m.env[0] < 0.5);
  assert.ok(Math.abs(m.envStep * m.env.length - 60) < 1, "env covers the song");
  assert.deepEqual(m.sections.map(s => [s.t0, s.t1, s.label, s.state]), [[0, 30, "A", "calm"], [30, 40, "B", "build"], [40, 60, "C", "drop"]], "sections from the bars when there are none");
  assert.deepEqual(m.drops, [40]); assert.equal(m.bars.length, 30); assert.deepEqual(m.bars[20], { t0: 40, state: "drop", energy: 0.5 });
  const secs = [{ t0: 0, t1: 30, bar0: 0, bar1: 15, label: "A", state: "calm" }, { t0: 30, t1: 60, bar0: 15, bar1: 30, label: "A", state: "drop" }];
  assert.deepEqual(songMap({ dur: 60, env, bars, drops: [], sections: secs, phrase: { len: 8, first: 0 } }).sections.map(s => s.label), ["A", "A"], "repeats keep their label");
  assert.deepEqual(downsample([], 10).env, []);

  const L = createLiveMap(), an = {}; let t = 0;
  const feed = (sec, state, loud) => { for (const end = t + sec; t < end; t += 0.05) L.tick(an, t, loud, state); };
  feed(2, "silent", 0); assert.equal(L.length, 0, "a map starts with the music");
  feed(20, "calm", 0.2); feed(1, "build", 0.5); feed(8, "build", 0.5); feed(12, "drop", 0.9);
  let lm = L.map(t); assert.ok(Math.abs(lm.dur - 41) < 0.6, `dur ${lm.dur}`); assert.ok(Math.abs(lm.pos - 41) < 0.6, `pos ${lm.pos}`);
  assert.deepEqual(lm.sections.map(s => [s.label, s.state]), [["A", "calm"], ["B", "build"], ["C", "drop"]]);
  assert.equal(lm.drops.length, 1); assert.ok(Math.abs(lm.drops[0] - 29) < 0.6, `drop at ${lm.drops[0]}`);
  feed(0.6, "calm", 0.2); feed(10, "drop", 0.9); lm = L.map(t);
  assert.deepEqual(lm.sections.map(s => s.label), ["A", "B", "C"], "a short part joins the one before");
  feed(7, "silent", 0); feed(3, "calm", 0.3); lm = L.map(t); assert.ok(lm.dur < 4, "a new song after 6 s of quiet starts a new map");
});

test("sync and song map in /api/status and the map routes, for a song played here and one heard live", async () => {
  const s = await setup();
  try {
    await s.call("POST", "/api/devices", { virtual: true });
    let st = (await s.call("GET", "/api/status")).body;
    assert.deepEqual(st.sync, { score: 0, state: "none", hint: null, source: null }, "nothing playing");
    assert.equal((await s.call("GET", "/api/song/map")).body.source, null);
    const song = edm(22050), pre = await preAnalyseCore(song.x, song.sr);
    await s.call("POST", "/api/song", { name: "Synth anthem", analysis: { ...pre, env: Array.from(pre.env) } });
    await s.call("POST", "/api/song/clock", { pos: 10, playing: true, rate: 1 });
    await until(async () => (await s.call("GET", "/api/status")).body.source === "song");
    st = (await s.call("GET", "/api/status")).body;
    assert.deepEqual(st.sync, { score: 100, state: "locked", hint: "Following the song's beat map", source: "song" });
    const m = (await s.call("GET", "/api/song/map")).body;
    assert.equal(m.source, "song"); assert.equal(m.name, "Synth anthem"); assert.ok(m.id, "remembered"); assert.equal(m.growing, false);
    assert.ok(m.pos >= 10 && m.pos < 12, `pos ${m.pos}`); assert.ok(Math.abs(m.dur - pre.dur) < 0.01);
    assert.ok(m.sections.length >= 2 && m.sections.every(x => x.t1 > x.t0 && /^[A-Z]/.test(x.label) && ["calm", "build", "drop", "silent"].includes(x.state)), JSON.stringify(m.sections));
    assert.ok(m.drops.length >= 1 && m.bars.length > 10 && m.env.length > 100 && m.env.length <= 480);
    const byId = (await s.call("GET", `/api/songs/${m.id}/map`)).body;
    assert.deepEqual(byId.sections, m.sections); assert.equal(byId.pos, null); assert.equal(byId.source, "memory");
    assert.equal((await s.call("GET", "/api/songs/nope/map")).status, 404);
    await s.call("DELETE", "/api/song");

    // heard live (song memory off, so it isn't recognised): the map grows, the score comes from the analyser
    await s.call("PATCH", "/api/settings", { songMemory: false });
    const x = song.x, chunk = 11025; let states = new Set();
    for (let i = 0; i < 24 * 22050; i += chunk) { const pcm = new Int16Array(chunk); for (let k = 0; k < chunk; k++) pcm[k] = Math.round((x[i + k] || 0) * 0.6 * 32767);
      s.app.runtime.pushPcm(pcm, "capture", "Line in", null, 22050); await sleep(25); const y = s.app.runtime.status().sync; states.add(y.state);
      assert.ok(Number.isInteger(y.score) && y.score >= 0 && y.score <= 100 && ["locked", "finding", "none"].includes(y.state)); }
    st = s.app.runtime.status(); assert.equal(st.sync.source, "live"); assert.equal(st.sync.state, "locked", JSON.stringify(st.sync)); assert.ok(states.has("finding"), "finding the beat at first");
    const lm = (await s.call("GET", "/api/song/map")).body;
    assert.equal(lm.source, "live"); assert.equal(lm.growing, true); assert.ok(lm.dur > 15 && lm.dur < 25, `dur ${lm.dur}`); assert.ok(lm.sections.length >= 1 && lm.env.length > 50);
  } finally { await s.done(); }
});
