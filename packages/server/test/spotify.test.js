// Sync with Spotify, against a pretend Spotify Web API (fake-spotify.js) on a test clock: the position from jittery
// readings, seeks, pauses, skips, 429s; Spotify's audio analysis (403 for new apps, a legacy fixture); learning a track
// by listening from the middle of it; shared beat maps through the Worker (with an in-memory D1).
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { createApp } from "../src/app.js";
import { createTrackClock, pollDelay } from "../src/spotify-sync.js";
import { analysisToPre } from "../src/spotify-analysis.js";
import { createLearner, emptyMap, mergeMap, normGrid, unionRanges, covers } from "../src/spotify-learn.js";
import { pickImage } from "../src/spotify.js";
import { spotifyIdOf } from "../src/nowplaying.js";
import { startFakeSpotify } from "./fake-spotify.js";
import { edm } from "../../engine/test/synth.js";
import { preAnalyseCore, gridAt } from "../../engine/src/index.js";
import { handle as worker } from "../../../worker/beatmaps/src/index.js";
import { fakeD1 } from "../../../worker/beatmaps/test/fake-d1.js";

const CID = "0123456789abcdef0123456789abcdef";
const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/spotify/audio-analysis.json", import.meta.url), "utf8"));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const near = (a, b, d, msg) => assert.ok(Math.abs(a - b) <= d, `${msg || ""} ${a} vs ${b} (±${d})`);
const rng = (seed = 3) => { let s = seed; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1; };
const SONG = edm(22050), SR = 22050, SONG_DUR = SONG.x.length / SR;
const FULL = await preAnalyseCore(SONG.x, SR);

/** A Tempolight server with Spotify connected (a token file as after signing in), on clock C.T, talking to the fake. */
async function setup(fake, C, { fetch, settings = {}, playerctl = null } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tl-spotify-"));
  writeFileSync(path.join(dir, "tempolight.json"), JSON.stringify({ settings: { nowPlaying: { enabled: true, spotifyClientId: CID }, ...settings } }));
  writeFileSync(path.join(dir, "spotify-token.json"), JSON.stringify({ access_token: "AT-test", refresh_token: "RT-test", expires_at: 1e13, clientId: CID }));
  const runner = { async run(cmd) { const out = playerctl && playerctl(); return cmd === "playerctl" ? (out ? { code: 0, stdout: out, stderr: "" } : { code: 1, stdout: "", stderr: "No players found" }) : { code: 127, stdout: "", stderr: "", missing: true }; }, stream() { return { stop() {} }; } };
  const app = await createApp({ dataDir: dir, discover: false, logger: null, nowPlaying: { platform: "linux", runner, fetch: fetch || fake.fetchVia(), now: () => C.T, wallNow: () => C.T, interval: 0 }, spotify: { now: () => C.T, tick: 0 } });
  const call = async (method, p, body) => { try { return { status: 200, body: JSON.parse(JSON.stringify(await app.core.handle(method, p, { headers: {}, query: {}, body: body ?? {} }))) }; } catch (e) { return { status: e.code || 500, body: { error: e.message } }; } };
  const advance = async (ms, step = 250) => { for (let t = 0; t < ms; t += step) { C.T += step; await app.spotify.tick(); } };
  return { app, dir, call, advance, sp: app.spotify, rt: app.runtime.rt, async done() { await app.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("spotify: track IDs from the local players, cover image choice, poll timing", () => {
  assert.equal(spotifyIdOf("spotify:track:0DiWol3AO6WpXZgp0goxAV"), "0DiWol3AO6WpXZgp0goxAV");
  assert.equal(spotifyIdOf("/com/spotify/track/0DiWol3AO6WpXZgp0goxAV"), "0DiWol3AO6WpXZgp0goxAV");
  assert.equal(spotifyIdOf("https://open.spotify.com/track/0DiWol3AO6WpXZgp0goxAV?si=x"), "0DiWol3AO6WpXZgp0goxAV");
  assert.equal(spotifyIdOf("file:///music/a.mp3"), null);
  assert.equal(pickImage([{ url: "https://a/640", width: 640 }, { url: "https://a/300", width: 300 }, { url: "https://a/64", width: 64 }]), "https://a/300");
  assert.equal(pickImage([{ url: "http://insecure", width: 640 }]), null);
  const base = { playing: true, pos: 50, dur: 200, samples: 10, sinceEventMs: 60000, local: false, nothing: false };
  assert.equal(pollDelay(base), 3000, "steady: every 3 s"); assert.equal(pollDelay({ ...base, sinceEventMs: 2000 }), 1000, "just after a seek: every second");
  assert.equal(pollDelay({ ...base, pos: 196 }), 1000, "the last seconds of a track"); assert.equal(pollDelay({ ...base, samples: 1 }), 1000, "a new track");
  assert.equal(pollDelay({ ...base, local: true }), 5000, "Spotify plays here: the local player gives the position");
});

test("spotify: the position from jittery readings, seeks and pauses; corrections glide", () => {
  const c = createTrackClock(), r = rng(9); let T = 0, truth = 40, maxStep = 0;
  const read = () => ({ id: "A", pos: truth + r() * 0.12, playing: true, at: T, rtt: 80 + Math.abs(r()) * 200, ts: 1000, dur: 240 });
  assert.equal(c.sample(read()), "track");
  let prevShown = c.shown(T), errs = [];
  for (let k = 0; k < 400; k++) { T += 50; truth += 0.05; if (k % 50 === 49) assert.equal(c.sample(read()), null, "noise isn't a seek");
    const sh = c.shown(T); maxStep = Math.max(maxStep, Math.abs(sh - prevShown - 0.05)); prevShown = sh; if (k > 100) errs.push(Math.abs(c.estimate(T) - truth)); }
  const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
  assert.ok(mean < 0.04, `mean error ${Math.round(mean * 1000)} ms with ±120 ms jitter`);
  assert.ok(maxStep <= 0.05 * 0.05 + 1e-9, `the shown position glides (biggest extra step ${maxStep})`);
  truth = 120; assert.equal(c.sample({ ...read(), pos: truth }), "seek"); near(c.shown(T), 120, 0.001, "a seek jumps");
  assert.equal(c.sample({ ...read(), pos: truth, playing: false }), "pause"); T += 5000; near(c.estimate(T), 120, 0.001, "paused: stays");
  assert.equal(c.sample({ ...read(), pos: 120, playing: true, ts: 2000 }), "resume");
  T += 1000; truth = 121.2; assert.equal(c.sample({ ...read(), pos: truth, ts: 3000 }), "seek", "a new Spotify timestamp with a 200 ms jump: a small seek");
  assert.equal(c.sample({ ...read(), id: "B", pos: 0 }), "track");
});

test("spotify: legacy audio analysis becomes a beat map (beats, bars, sections, loudness, key)", () => {
  const p = analysisToPre(FIXTURE);
  near(p.bpm, 128, 0.05, "tempo"); near(p.off, 0.21, 0.01, "first beat"); assert.equal(p.barOff, 0);
  assert.equal(p.bars.length, 24); assert.equal(p.bars.map(b => b.state[0]).join(""), "ccccccccbbbbddddddddcccc", "intro, build-up, drop, outro from the sections' loudness");
  assert.deepEqual(p.drops.map(t => Math.round(t * 100) / 100), [22.71]);
  assert.equal(p.kicks.length, 32, "a kick on every beat of the drop"); assert.ok(p.snares.length >= 6, "snares in the build-up"); assert.ok(p.hats.length >= 40);
  assert.equal(p.key, "A"); assert.equal(p.mode, "minor"); assert.ok(typeof p.chroma === "string" && p.chroma.length > 100);
  assert.equal(p.env.length, Math.ceil(46.21 / 0.02)); const avg = t => { let x = 0; for (let k = 0; k < 50; k++) x += p.env[Math.round(t / 0.02) + k]; return x / 50; }; assert.ok(avg(25) > 0.5 && avg(5) < 0.3, `loud drop, quiet intro (${avg(25).toFixed(2)}, ${avg(5).toFixed(2)})`);
  assert.equal(analysisToPre({ track: {}, beats: [] }), null);
});

test("spotify: learning from the middle of a track lines the map up with the track's start; a later play completes it", async () => {
  assert.deepEqual(normGrid(0.5, 1.3, 1), { P: 0.5, off: 0.30000000000000004, barOff: 3 });
  assert.deepEqual(unionRanges([[10, 20], [0, 5], [19, 30], [5.2, 6]]), [[0, 6], [10, 30]]);
  assert.equal(covers([[10, 20]], 15), true); assert.equal(covers([[10, 20]], 5), false); assert.equal(covers(undefined, 5), true);
  const r = rng(4), L = createLearner(); let i = Math.round(10 * SR);
  for (; i + 2048 <= SONG.x.length; i += 2048) L.push("T", SONG.x.subarray(i, i + 2048), (i + 2048) / SR + r() * 0.06); // the Spotify position, ±60 ms
  let [part] = await L.finish(); near(part.t0, 10, 0.03, "the stretch starts at 0:10 on the track's clock");
  let m = mergeMap(emptyMap(SONG_DUR), part);
  const hits = m.kicks.filter(t => FULL.kicks.some(k => Math.abs(k - t) < 0.03)).length;
  assert.ok(hits >= m.kicks.length * 0.9, `${hits} of ${m.kicks.length} learned kicks within 30 ms of the song's`);
  near(m.drops[0], SONG.dropStart, 0.03, "the drop"); near(m.bpm, 128, 0.2, "tempo");
  const g = gridAt(m, 20), gf = gridAt(FULL, 20); near(g.beatT, gf.beatT, 0.03, "beats on the song's grid"); assert.equal(g.beatInBar, gf.beatInBar, "and bar 1 where the song's is");
  const L2 = createLearner(); for (let k = 0; k + 2048 <= 16 * SR; k += 2048) L2.push("T", SONG.x.subarray(k, k + 2048), (k + 2048) / SR);
  m = mergeMap(m, (await L2.finish())[0]); assert.equal(m.cov.length, 1); near(m.cov[0][0], 0, 0.03); near(m.drops[0], SONG.dropStart, 0.03);
});

test("spotify: precise sync with the Web API: jitter, steady polling, seeks, pauses, 429, volume, skips", async () => {
  const C = { T: 1e6 }, fake = await startFakeSpotify({ clock: () => C.T, jitterMs: 60 }), s = await setup(fake, C);
  try {
    fake.play({ id: "0DiWol3AO6WpXZgp0goxAV", name: "Unknown song", artist: "Someone", dur: 200 }, 30);
    await s.advance(20000);
    let errs = []; for (let k = 0; k < 40; k++) { await s.advance(250); errs.push(Math.abs(s.sp.clock.estimate(C.T) - fake.pos)); }
    const mean = errs.reduce((a, b) => a + b, 0) / errs.length; assert.ok(mean < 0.04, `mean error ${Math.round(mean * 1000)} ms (readings ±60 ms)`);
    let n0 = fake.counts["/v1/me/player"]; await s.advance(12000); const steady = fake.counts["/v1/me/player"] - n0;
    assert.ok(steady >= 3 && steady <= 5, `steady: about every 3 s (${steady} in 12 s)`);
    let v = (await s.call("GET", "/api/spotify")).body;
    assert.equal(v.on, true); assert.equal(v.connected, true); assert.equal(v.via, "web"); assert.equal(v.track.title, "Unknown song"); assert.equal(v.track.volume, 70); assert.equal(v.track.art, "https://i.scdn.co/image/0DiWol3AO6WpXZgp0goxAV-300");
    assert.equal(v.mode, "live", "no beat map and nothing heard"); assert.equal(v.analysis, "blocked", "the fake answers 403 for audio analysis: this app can't have it");
    assert.ok(s.app.runtime.log.some(e => /audio analysis isn't available/.test(e.msg)));
    const st = (await s.call("GET", "/api/state")).body; assert.equal(st.settings.spotify.analysisBlocked, CID);
    assert.ok(!JSON.stringify(st).includes("AT-test"), "no tokens in the state");

    fake.seek(120); await s.advance(3500); near(s.sp.clock.estimate(C.T), fake.pos, 0.15, "after a seek");
    n0 = fake.counts["/v1/me/player"]; await s.advance(3000); assert.ok(fake.counts["/v1/me/player"] - n0 >= 2, "asks every second just after a seek");
    fake.pause(); await s.advance(3000); assert.equal(s.sp.info().mode, "paused"); assert.equal(s.rt.spotify.paused(), true);
    await sleep(80); assert.equal(s.app.runtime.status().source, "idle"); assert.equal(s.app.runtime.status().sourceLabel, "Spotify paused");
    fake.resume(); await s.advance(1500); assert.equal(s.rt.spotify.paused(), false);

    fake.limit(2, 4); n0 = fake.counts["/v1/me/player"]; await s.advance(3500);
    const during = fake.counts["/v1/me/player"] - n0; assert.ok(during === 1, `one request, then it waits for Retry-After (${during})`);
    assert.match(s.sp.info().error, /slow down/); await s.advance(9000); assert.ok(fake.counts["/v1/me/player"] - n0 >= 3); assert.equal(s.sp.info().error, null);

    fake.volume(0); await s.advance(4000); for (let k = 0; k < 20; k++) { C.T += 50; s.rt.spotify.dim(); } near(s.rt.spotify.dim(), 0.1, 0.02, "volume 0 dims");
    fake.volume(60); await s.advance(4000); for (let k = 0; k < 20; k++) { C.T += 50; s.rt.spotify.dim(); }
    fake.play({ id: "4uLU6hMCjMI75M1A2tKUQC", name: "Next song", artist: "Someone", dur: 180 }, 0); await s.advance(3500, 100);
    let low = 1; for (let k = 0; k < 8; k++) { C.T += 50; low = Math.min(low, s.rt.spotify.dim()); } // (the skip was seen a moment ago)
    assert.equal(s.sp.info().track.title, "Next song"); assert.equal(fake.counts["/v1/audio-analysis/4uLU6hMCjMI75M1A2tKUQC"] || 0, 0, "after a 403, audio analysis isn't asked again");
    fake.play({ id: "6habFhsOp2NvshLv26DqMb", name: "Third", artist: "Someone", dur: 180 }, 0);
    for (let k = 0; k < 40 && s.sp.info().track.title !== "Third"; k++) await s.advance(100, 100); // until the next reading sees it
    low = 1; for (let k = 0; k < 8; k++) { C.T += 50; low = Math.min(low, s.rt.spotify.dim()); }
    assert.ok(low < 0.75, `a skip dips the lights (${low.toFixed(2)})`);
    fake.stop(); await s.advance(6000); assert.equal(s.sp.info().track, null); assert.equal(s.sp.info().mode, "idle");
  } finally { await s.done(); await fake.close(); }
});

test("spotify: a remembered song gets its Spotify ID and is followed exactly; legacy analysis is used when the app has it", async () => {
  const C = { T: 1e6 }, LEG = "1LegacyTrack0000000000";
  const fake = await startFakeSpotify({ clock: () => C.T, jitterMs: 30, analysis: "fixture", fixtures: { [LEG]: FIXTURE } }), s = await setup(fake, C);
  try {
    await s.call("POST", "/api/devices", { virtual: true });
    await s.call("POST", "/api/song", { name: "Tempolight - Synth anthem", analysis: { ...FULL, env: Array.from(FULL.env) } }); await s.call("DELETE", "/api/song");
    const mem = (await s.call("GET", "/api/songs")).body[0];
    fake.play({ id: "2SynthAnthem0000000000", name: "Synth Anthem", artist: "Tempolight", dur: mem.dur }, 20); await s.advance(3000);
    await sleep(80); let st = s.app.runtime.status();
    assert.equal(st.source, "nowplaying"); assert.equal(st.part, "drop", "0:20 is in the drop"); assert.match(st.sourceLabel, /^Spotify \(Kitchen speaker\): Tempolight - Synth anthem/);
    assert.equal(st.spotify.mode, "exact"); assert.equal(st.spotify.modeName, "Exact (learned)"); assert.equal(st.spotify.map.src, "file");
    assert.equal((await s.call("GET", "/api/songs")).body[0].spotifyId, "2SynthAnthem0000000000", "matched by title, artist and length, then keyed by ID");
    fake.seek(3); await s.advance(1500); await sleep(80); assert.notEqual(s.app.runtime.status().part, "drop", "a seek moves the beat map with it");

    fake.play({ id: LEG, name: "Legacy", artist: "Old app", dur: 46.21 }, 25); await s.advance(2000); await sleep(150); await s.advance(500); await sleep(80);
    const e = s.app.store.data.songs.find(x => x.spotifyId === LEG); assert.ok(e, "saved in song memory"); assert.equal(e.src, "spotify-analysis");
    st = s.app.runtime.status(); assert.equal(st.source, "nowplaying"); assert.equal(st.spotify.mode, "analysis"); assert.equal(st.spotify.modeName, "Spotify analysis"); assert.equal(st.part, "drop");
    assert.equal(fake.counts[`/v1/audio-analysis/${LEG}`], 1);
    // cover colours: the browser sends them, they become the palette while the track plays
    assert.equal((await s.call("POST", "/api/spotify/colors", { art: "https://x/y", colors: ["#zz0000"] })).status, 400);
    await s.call("PATCH", "/api/spotify", { coverColours: true }); await s.call("POST", "/api/spotify/colors", { art: `https://i.scdn.co/image/${LEG}-300`, colors: ["#ff2200", "#0044ff", "#ffee00"] });
    assert.deepEqual(s.rt.spotify.timeline(null).colors[0].colors, ["#ff2200", "#0044ff", "#ffee00"]);
    await s.call("PATCH", "/api/show", { palette: "ocean" }); assert.equal(s.rt.spotify.timeline(null), null, "a palette you picked wins");
    await s.call("PATCH", "/api/spotify", { sync: false }); await sleep(80); assert.notEqual(s.app.runtime.status().spotify.mode, "analysis"); assert.equal(s.app.runtime.status().spotify.mode, "off");
  } finally { await s.done(); await fake.close(); }
});

test("spotify: a new track is learned while it plays (from the middle), completed on the next play, shared, and followed without listening", async () => {
  const C = { T: 1e6 }, ID = "3LearnMe00000000000000", fake = await startFakeSpotify({ clock: () => C.T, jitterMs: 40 });
  const env = { DB: fakeD1(readFileSync(new URL("../../../worker/beatmaps/schema.sql", import.meta.url), "utf8")), SALT: "s" };
  const viaWorker = (url, o) => String(url).startsWith("https://maps.test") ? worker(new Request(url, o), env) : globalThis.fetch(url, o);
  const s = await setup(fake, C, { fetch: fake.fetchVia(viaWorker) });
  const modes = new Set(), listen = async (from, to) => { // the browser sends what it hears: 100 ms chunks, as they play
    fake.play({ id: ID, name: "Learn me", artist: "Tempolight", dur: SONG_DUR }, from);
    for (let i = Math.round(from * SR); i + 2205 <= Math.min(SONG.x.length, Math.round(to * SR)); i += 2205) { C.T += 100; await s.sp.tick();
      const c = new Int16Array(2205); for (let k = 0; k < 2205; k++) c[k] = Math.round(SONG.x[i + k] * 32000); s.app.runtime.pushPcm(c, "browser", "Test tab", "b1", 22050, 0); modes.add(s.sp.info().mode); } };
  try {
    assert.equal((await s.call("PATCH", "/api/spotify", { cloud: { url: "ftp://nope" } })).status, 400);
    await s.call("PATCH", "/api/spotify", { cloud: { url: "https://maps.test/", share: true } });
    await listen(10, SONG_DUR); assert.ok(modes.has("learning"), [...modes].join());
    await s.advance(600, 100); assert.ok(s.sp.finishing, "the end of the track: what was heard is analysed"); await s.sp.finishing;
    let e = s.app.store.data.songs.find(x => x.spotifyId === ID); assert.ok(e, "learned into song memory"); assert.equal(e.src, "learned"); assert.equal(e.name, "Tempolight - Learn me");
    near(e.cov[0][0], 10, 0.05, "covers from 0:10"); assert.ok(e.cov[0][1] > SONG_DUR - 2);
    const hits = e.kicks.filter(t => FULL.kicks.some(k => Math.abs(k - t) < 0.03)).length; assert.ok(hits >= e.kicks.length * 0.85, `${hits}/${e.kicks.length} kicks within 30 ms`);
    near(e.drops[0], SONG.dropStart, 0.03, "the drop at 0:15 on the track's clock");
    assert.equal(s.sp.info().learn.state, "learned"); assert.ok(s.app.runtime.log.some(x => /learned “Learn me” \(\d+% of it so far\)/.test(x.msg)));
    assert.equal(env.DB.tables.get("submissions").rows.length, 1, "shared (more than 60% learned)"); assert.equal(env.DB.tables.get("maps").rows.length, 0, "not confirmed by one install");
    const songs = (await s.call("GET", "/api/songs")).body; assert.equal(songs[0].src, "learned"); assert.ok(songs[0].cover > 60 && songs[0].cover < 100);

    // the next play starts at the beginning: the start is learned too, and the map is complete
    await listen(0, 20); fake.stop(); await s.advance(1000); await s.sp.finishing;
    e = s.app.store.data.songs.find(x => x.spotifyId === ID); const sg = (await s.call("GET", "/api/songs")).body.find(x => x.id === e.id);
    assert.ok(!e.cov || sg.cover >= 90, `complete (${sg.cover}%)`); assert.ok(!e.cov || e.cov[0][0] < 3.5, "from the start (once Spotify says it started again)"); near(e.drops[0], SONG.dropStart, 0.03);
    // played again, nothing heard: followed from the map
    fake.play({ id: ID, name: "Learn me", artist: "Tempolight", dur: SONG_DUR }, 18); await s.advance(3500); await sleep(80);
    const st = s.app.runtime.status(); assert.equal(st.source, "nowplaying"); assert.equal(st.spotify.mode, "exact"); assert.equal(st.part, "drop");

    // another install sends a map that agrees: confirmed; a fresh Tempolight with "Use shared beat maps" gets it
    const sub = JSON.parse(env.DB.tables.get("submissions").rows.at(-1).body);
    const r = await worker(new Request(`https://maps.test/v1/maps/${ID}`, { method: "POST", headers: { "content-type": "application/json", "x-install-id": "b".repeat(32) }, body: JSON.stringify({ map: { ...sub, kicks: sub.kicks.map(t => +(t + 0.004).toFixed(3)) } }) }), env);
    assert.equal((await r.json()).confirmed, true);
    const C2 = { T: 1e6 }, fake2 = await startFakeSpotify({ clock: () => C2.T }), s2 = await setup(fake2, C2, { fetch: fake2.fetchVia(viaWorker), settings: { spotify: { cloud: { url: "https://maps.test", use: true, share: false } } } });
    try {
      fake2.play({ id: ID, name: "Learn me", artist: "Tempolight", dur: SONG_DUR }, 20); await s2.advance(1500); await sleep(100); await s2.advance(500); await sleep(80);
      const e2 = s2.app.store.data.songs.find(x => x.spotifyId === ID); assert.ok(e2, "the shared map was fetched"); assert.equal(e2.src, "shared");
      const st2 = s2.app.runtime.status(); assert.equal(st2.source, "nowplaying"); assert.equal(st2.spotify.mode, "shared"); assert.equal(st2.part, "drop");
    } finally { await s2.done(); await fake2.close(); }
  } finally { await s.done(); await fake.close(); }
});

test("spotify: when Spotify plays on this computer, its own player gives the position (and the ID); the Web API is asked less", async () => {
  const C = { T: 1e6 }, ID = "0DiWol3AO6WpXZgp0goxAV", fake = await startFakeSpotify({ clock: () => C.T, jitterMs: 150 });
  let localPos = 61.5; const line = () => ["spotify", "Playing", "One More Time", "Daft Punk", "Discovery", 320357000, Math.round(localPos * 1e6), `/com/spotify/track/${ID}`].join("\u001f");
  const s = await setup(fake, C, { playerctl: line });
  try {
    fake.play({ id: ID, name: "One More Time", artist: "Daft Punk", dur: 320.357 }, 60);
    const np = s.app.nowPlaying.np; for (let k = 0; k < 12; k++) { C.T += 500; localPos += 0.5; await np.poll(); await s.sp.tick(); }
    const i = s.sp.info(); assert.equal(i.via, "local"); assert.equal(i.track.id, ID, "the ID from MPRIS"); assert.equal(i.track.volume, 70, "volume and cover still from the Web API");
    near(i.track.pos, localPos, 0.11, "the local position, not the Web API's");
    const n0 = fake.counts["/v1/me/player"]; for (let k = 0; k < 20; k++) { C.T += 500; localPos += 0.5; await np.poll(); await s.sp.tick(); }
    assert.ok(fake.counts["/v1/me/player"] - n0 <= 2, "every 5 s while the local player has it");
  } finally { await s.done(); await fake.close(); }
});
