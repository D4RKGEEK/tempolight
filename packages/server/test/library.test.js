import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, copyFileSync, renameSync, symlinkSync, utimesSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import { encodeWav, readWav, wavInfo, songName, analyseFile } from "../src/audiofile.js";
import { cleanFolder, inside, sameRecording } from "../src/library.js";
import { edm, majorPop, minorBallad } from "../../engine/test/synth.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 5000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(50); } return false; }
const SEP = "\u001f";
const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

// the test songs, written as WAV files of different kinds: 16-bit mono 22 kHz, 24-bit stereo 44.1 kHz with tags, 32-bit float
const SR = 22050, EDM = edm(SR), POP = majorPop(SR), BAL = minorBallad(SR);
const up2 = (x, ch = 2) => { const y = new Float32Array(x.length * 2 * ch); for (let i = 0; i < x.length; i++) for (let k = 0; k < 2 * ch; k++) y[i * 2 * ch + k] = x[i] * (k % 2 && ch === 2 ? 0.9 : 1); return y; };
function musicDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tl-music-")); mkdirSync(path.join(dir, "Dance", "Old"), { recursive: true });
  writeFileSync(path.join(dir, "Dance", "Synth Crew - Anthem.wav"), encodeWav(EDM.x, SR));
  writeFileSync(path.join(dir, "Dance", "Old", "track02.wav"), encodeWav(up2(POP.x), 44100, { bits: 24, channels: 2, tags: { title: "Sunny Pop", artist: "The Testers" } }));
  writeFileSync(path.join(dir, "slow_ballad.wav"), encodeWav(BAL.x, SR, { float: true }));
  writeFileSync(path.join(dir, "notes.txt"), "not music");
  writeFileSync(path.join(dir, ".hidden.wav"), encodeWav(EDM.x.subarray(0, SR * 25), SR));
  return dir;
}
async function setup(opts = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tl-lib-")), app = await createApp({ dataDir: dir, discover: false, logger: null, ...opts,
    library: { ffmpeg: false, ffprobe: false, startDelay: false, watch: false, ...opts.library }, nowPlaying: { interval: 0, ...opts.nowPlaying } });
  const port = await app.listen(0, "127.0.0.1"), base = `http://127.0.0.1:${port}`;
  const call = async (method, p, body, headers = {}) => { const r = await fetch(base + p, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  return { app, dir, call, lib: app.library, async done() { await app.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const songsOf = async s => (await s.call("GET", "/api/library")).body.songs;

test("WAV reader: 8, 16, 24 and 32-bit PCM, 32 and 64-bit float, stereo, tags and odd chunks", () => {
  const x = new Float32Array(4410); for (let i = 0; i < x.length; i++) x[i] = Math.sin(i / 7) * 0.5;
  for (const o of [{ bits: 16 }, { bits: 24 }, { bits: 32 }, { float: true, bits: 32 }]) {
    const w = readWav(encodeWav(x, 22050, o)); assert.equal(w.sr, 22050); assert.equal(w.x.length, x.length);
    assert.ok(w.x.every((v, i) => Math.abs(v - x[i]) < (o.bits === 16 ? 1e-4 : 1e-6)), JSON.stringify(o)); }
  const st = readWav(encodeWav(up2(x), 44100, { channels: 2, tags: { title: "T", artist: "A" } })); // 44.1 kHz stereo: averaged to 22,050 Hz mono
  assert.equal(st.sr, 22050); assert.equal(st.x.length, x.length); assert.ok(Math.abs(st.x[100] - x[100] * 0.95) < 1e-3); assert.deepEqual(st.tags, { title: "T", artist: "A" });
  // 8-bit, 64-bit float and WAVE_FORMAT_EXTENSIBLE, by hand; an odd-sized chunk before the data is skipped with its pad byte
  const hdr = (code, ch, sr, bits, extra = Buffer.alloc(0), ext = false) => { const f = Buffer.alloc(ext ? 40 : 16); f.writeUInt16LE(ext ? 0xfffe : code, 0); f.writeUInt16LE(ch, 2); f.writeUInt32LE(sr, 4); f.writeUInt32LE(sr * ch * bits / 8, 8); f.writeUInt16LE(ch * bits / 8, 12); f.writeUInt16LE(bits, 14); if (ext) { f.writeUInt16LE(22, 16); f.writeUInt16LE(code, 24); }
    const c = (id, b) => { const h = Buffer.alloc(8); h.write(id, 0, "ascii"); h.writeUInt32LE(b.length, 4); return Buffer.concat([h, b, Buffer.alloc(b.length & 1)]); };
    return body => { const all = Buffer.concat([c("fmt ", f), c("junk", Buffer.from("odd")), extra, c("data", body)]), r = Buffer.alloc(12); r.write("RIFF", 0, "ascii"); r.writeUInt32LE(all.length + 4, 4); r.write("WAVE", 8, "ascii"); return Buffer.concat([r, all]); }; };
  const u8 = Buffer.from([128, 255, 0, 192]); assert.deepEqual(Array.from(readWav(hdr(1, 1, 8000, 8)(u8)).x), [0, 127 / 128, -1, 0.5]);
  const d64 = Buffer.alloc(16); d64.writeDoubleLE(0.25, 0); d64.writeDoubleLE(-0.5, 8); assert.deepEqual(Array.from(readWav(hdr(3, 1, 8000, 64)(d64)).x), [0.25, -0.5]);
  const i16 = Buffer.alloc(4); i16.writeInt16LE(16384, 0); i16.writeInt16LE(-16384, 2); assert.deepEqual(Array.from(readWav(hdr(1, 2, 8000, 16, Buffer.alloc(0), true)(i16)).x), [0], "extensible PCM, stereo averaged");
  assert.throws(() => wavInfo(hdr(85, 1, 8000, 16)(i16)), /compressed format/, "MP3 inside a WAV needs ffmpeg");
  assert.throws(() => wavInfo(Buffer.from("ID3 not a wav")), /not a WAV/);
  assert.equal(songName("/m/Artist_Name - Song.mp3"), "Artist Name - Song"); assert.equal(songName("/m/x.flac", { title: "Song", artist: "Band" }), "Band - Song");
  assert.equal(songName("/m/x.flac", { title: "Band - Song", artist: "Band" }), "Band - Song", "a title that already names the artist");
});

test("library paths: only full paths to existing folders, never the whole disk; inside() can't be fooled by ..", () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "tl-paths-"));
  try {
    assert.equal(cleanFolder(d), cleanFolder(d + path.sep + "."));
    for (const bad of ["", "Music", "../etc", "./x", path.join(d, "nope"), path.parse(d).root, "a\0b"]) assert.throws(() => cleanFolder(bad), e => e.code === 400, JSON.stringify(bad));
    writeFileSync(path.join(d, "f.wav"), "x"); assert.throws(() => cleanFolder(path.join(d, "f.wav")), /isn't a folder/);
    assert.equal(cleanFolder("~/" + path.basename(d), path.dirname(d)), cleanFolder(d), "~ is the home folder");
    assert.ok(inside("/m", "/m/a/b.mp3")); assert.ok(inside("/m", "/m")); assert.ok(!inside("/m", "/m2/x")); assert.ok(!inside("/m", "/m/../etc/passwd".replace("/m/..", "")));
    assert.ok(!inside("/m", path.resolve("/m/a/../../etc")));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("library: scans a folder, analyses its WAV songs in a worker, skips what it has seen, keeps one copy of a song", async () => {
  const music = musicDir(), s = await setup({ library: { workers: 1 } });
  const outside = mkdtempSync(path.join(os.tmpdir(), "tl-outside-"));
  try {
    writeFileSync(path.join(outside, "secret.wav"), encodeWav(POP.x, SR)); // only reachable through a link out of the folder: not followed
    try { symlinkSync(path.join(outside, "secret.wav"), path.join(music, "link-out.wav")); symlinkSync(music, path.join(music, "Dance", "loop")); } catch {}
    writeFileSync(path.join(music, "Dance", "club mix.mp3"), "ID3 pretend mp3");
    assert.equal((await s.call("GET", "/api/library")).body.songs.length, 0);
    let v = (await s.call("PATCH", "/api/library", { folders: [music] })).body; assert.equal(v.folders[0].path, cleanFolder(music));
    assert.ok(await s.lib.idle(60000), "analysed");
    v = (await s.call("GET", "/api/library")).body;
    assert.deepEqual(v.songs.map(x => x.name), ["slow ballad", "Synth Crew - Anthem", "The Testers - Sunny Pop"], "names from tags, else the file name");
    assert.equal(v.counts.analysed, 3); assert.equal(v.counts.needsFfmpeg, 1, "the MP3 waits for ffmpeg"); assert.equal(v.ffmpeg, false);
    assert.equal(v.message, "Install ffmpeg to analyse MP3/AAC/FLAC; WAV works now.");
    assert.ok(v.errors.some(e => e.file === path.join("Dance", "club mix.mp3") && e.state === "needs"));
    const anthem = v.songs.find(x => x.name === "Synth Crew - Anthem"); assert.ok(Math.abs(anthem.bpm - 128) < 1, `tempo ${anthem.bpm}`);
    assert.ok(anthem.look && anthem.look.main && anthem.look.name, "a look of its own"); assert.equal(anthem.file, path.join("Dance", "Synth Crew - Anthem.wav"));
    assert.equal(v.songs.find(x => x.name === "The Testers - Sunny Pop").key, "D major");
    assert.ok(!v.songs.some(x => /secret/.test(x.file)), "a link out of the folder isn't followed");
    assert.ok(v.progress.perSongMs > 0 && v.progress.avgAnalyseMs > 0); assert.equal(v.progress.maxWorkers, 1);
    // the whole entry has the beat map, the look and the show; the settings file stays small
    const e = s.app.runtime.songById(anthem.id); assert.ok(e.kicks.length > 20 && e.look && e.show.length && e.path.endsWith("Anthem.wav"));
    s.app.store.flush(); const settings = readFileSync(path.join(s.dir, "tempolight.json"), "utf8"); assert.ok(!settings.includes(anthem.id) && settings.length < 60000, "library songs aren't in the settings file");
    assert.ok(existsSync(path.join(s.dir, "library", `${anthem.id}.json`)));
    assert.equal((await s.call("GET", "/api/state")).body.settings.library, undefined, "folder paths aren't in the public state");
    // the timeline editor works on library songs too
    assert.equal((await s.call("GET", `/api/songs/${anthem.id}/show`)).status, 200);

    // again: nothing changed, nothing analysed
    await s.call("POST", "/api/library/scan"); assert.ok(await s.lib.idle()); v = (await s.call("GET", "/api/library?songs=0")).body;
    assert.equal(v.progress.total, 0, "unchanged files are skipped"); assert.equal(v.songs, undefined);
    // a copy of a file (same contents) and the same song in another kind of file: kept once
    copyFileSync(path.join(music, "Dance", "Synth Crew - Anthem.wav"), path.join(music, "copy.wav"));
    writeFileSync(path.join(music, "Dance", "anthem-float.wav"), encodeWav(EDM.x, SR, { float: true }));
    await s.call("POST", "/api/library/scan"); assert.ok(await s.lib.idle(60000)); v = (await s.call("GET", "/api/library")).body;
    assert.equal(v.songs.length, 3); assert.equal(v.counts.duplicates, 2, "a copy and the same recording as float");
    // a moved file keeps its analysis; a changed file is analysed again
    renameSync(path.join(music, "slow_ballad.wav"), path.join(music, "Dance", "slow_ballad.wav"));
    const before = v.songs.find(x => x.name === "slow ballad").id;
    await s.call("POST", "/api/library/scan"); assert.ok(await s.lib.idle(60000)); v = (await s.call("GET", "/api/library")).body;
    assert.equal(v.progress.total, 0, "a moved file isn't analysed again"); assert.equal(v.songs.find(x => x.name === "slow ballad").id, before);
    assert.equal(v.songs.find(x => x.id === before).file, path.join("Dance", "slow_ballad.wav"));
    const later = new Date(Date.now() + 5000); utimesSync(path.join(music, "Dance", "slow_ballad.wav"), later, later);
    await s.call("POST", "/api/library/scan"); assert.ok(await s.lib.idle(60000)); v = (await s.call("GET", "/api/library")).body;
    assert.equal(v.progress.total, 1, "a changed file is analysed again"); assert.equal(v.songs.length, 3);
    // removing a song: gone, and not added back by the next scan
    const pop = v.songs.find(x => x.name === "The Testers - Sunny Pop");
    assert.equal((await s.call("DELETE", `/api/library/songs/${pop.id}`)).status, 200);
    await s.call("POST", "/api/library/scan"); assert.ok(await s.lib.idle()); v = (await s.call("GET", "/api/library")).body;
    assert.equal(v.songs.length, 2); assert.equal(v.counts.removed, 1); assert.equal(s.app.runtime.songById(pop.id), null);
    // restart: everything is still there and nothing is analysed again
    await s.app.close();
    const app2 = await createApp({ dataDir: s.dir, discover: false, logger: null, library: { ffmpeg: false, ffprobe: false, startDelay: false, watch: false }, nowPlaying: { interval: 0 } });
    try { assert.equal(app2.library.view().songs.length, 2); await app2.library.scan(); assert.ok(await app2.library.idle()); assert.equal(app2.library.view().progress.total, 0, "resumes without analysing again"); }
    finally { await app2.close(); }
    s.app.close = async () => {}; // (closed above)
  } finally { await s.done(); rmSync(music, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("library API: admin only, paths checked, unknown and odd ids refused, pause and resume", async () => {
  const music = musicDir(), s = await setup({ library: { workers: 1 } });
  try {
    for (const bad of [["../../etc"], ["relative/music"], [path.join(music, "missing")], ["/"], "not a list", [path.join(music, "notes.txt")]])
      assert.equal((await s.call("PATCH", "/api/library", { folders: bad })).status, 400, JSON.stringify(bad));
    assert.equal((await s.call("POST", "/api/library/scan")).status, 400, "no folder yet");
    for (const id of ["..%2F..%2Ftempolight", "lzzzzzzzzzz", "m12345678"]) assert.equal((await s.call("DELETE", `/api/library/songs/${id}`)).status, 404, id);
    // pause before it starts: nothing is analysed until resumed
    await s.call("POST", "/api/library/pause");
    let v = (await s.call("PATCH", "/api/library", { folders: [music], watch: false })).body; assert.equal(v.paused, true); assert.equal(v.watch, false);
    await sleep(800); v = (await s.call("GET", "/api/library")).body; assert.equal(v.progress.state, "paused"); assert.equal(v.songs.length, 0); assert.equal(v.counts.queued, 3);
    v = (await s.call("POST", "/api/library/resume")).body; assert.equal(v.paused, false);
    assert.ok(await until(async () => (await songsOf(s)).length >= 1, 30000), "analysing again");
    v = (await s.call("POST", "/api/library/pause")).body; assert.equal(v.progress.workers, 0, "pausing stops the workers at once");
    await s.call("POST", "/api/library/resume"); assert.ok(await s.lib.idle(60000)); assert.equal((await songsOf(s)).length, 3);
    // with a PIN, only an unlocked browser may see or change the library
    await s.call("POST", "/api/lock", { pin: "1234" });
    for (const [m, p] of [["GET", "/api/library"], ["PATCH", "/api/library"], ["POST", "/api/library/scan"], ["POST", "/api/library/pause"], ["DELETE", "/api/library/songs/l0123456789"]]) assert.equal((await s.call(m, p, m === "GET" ? undefined : {})).status, 403, `${m} ${p}`);
    const tok = (await s.call("POST", "/api/unlock", { pin: "1234" })).body.token;
    assert.equal((await s.call("GET", "/api/library", undefined, { "x-tempolight-token": tok })).status, 200);
  } finally { await s.done(); rmSync(music, { recursive: true, force: true }); }
});

test("library: a song heard live afterwards is recognised and followed with its beat map", async () => {
  const music = musicDir(), s = await setup({ library: { workers: 1 } });
  try {
    await s.call("POST", "/api/devices", { virtual: true });
    await s.call("PATCH", "/api/library", { folders: [music] }); assert.ok(await s.lib.idle(60000));
    assert.equal((await s.call("GET", "/api/songs")).body.length, 0, "the library isn't in the song memory list");
    const start = 5, x = EDM.x.subarray(start * SR), chunk = 11025; let i = 0, found = null;
    while (i < x.length && !found) { const pcm = new Int16Array(chunk); for (let k = 0; k < chunk; k++) pcm[k] = Math.round((x[i + k] || 0) * 0.4 * 32767);
      s.app.runtime.pushPcm(pcm, "capture", "Line in", null, SR); i += chunk; await sleep(30); found = s.app.runtime.status().recognised; }
    assert.ok(found, "recognised"); assert.equal(found.name, "Synth Crew - Anthem");
    const truth = start + s.app.runtime.rt.live.an.t; assert.ok(Math.abs(found.pos - truth) < 0.15, `position ${found.pos} vs ${truth}`); assert.ok(i / SR < 22, `took ${i / SR} s`);
    await until(() => /Anthem \(recognised\)/.test(s.app.runtime.status().sourceLabel), 2000);
    assert.match(s.app.runtime.status().sourceLabel, /Synth Crew - Anthem \(recognised\)/);
  } finally { await s.done(); rmSync(music, { recursive: true, force: true }); }
});

test("library: a music app playing a library file is followed at once, at its position", async () => {
  const music = musicDir(); let out = { code: 1, stdout: "", stderr: "No players found" };
  const runner = { async run(cmd) { return cmd === "playerctl" ? out : { code: 127, stdout: "", stderr: "", missing: true }; }, stream() { return { stop() {} }; } };
  const s = await setup({ library: { workers: 1 }, nowPlaying: { platform: "linux", runner } });
  try {
    await s.call("POST", "/api/devices", { virtual: true });
    await s.call("PATCH", "/api/library", { folders: [music] }); assert.ok(await s.lib.idle(60000));
    const file = path.join(cleanFolder(music), "Dance", "Synth Crew - Anthem.wav"), url = "file://" + file.split(path.sep).map(encodeURIComponent).join("/").replace(/^\/?/, "/").replace(/^\/\//, "/");
    // VLC with a title that names no song we know: the file says which one it is
    out = { code: 0, stdout: ["vlc", "Playing", "track 1", "", "", Math.round(EDM.x.length / SR * 1e6), 20e6, "/org/videolan/vlc/playlist/3", url].join(SEP), stderr: "" };
    await s.app.nowPlaying.np.poll(); await sleep(80);
    const st = (await s.call("GET", "/api/status")).body;
    assert.equal(st.source, "nowplaying"); assert.match(st.sourceLabel, /^VLC: Synth Crew - Anthem \(remembered\)$/); assert.equal(st.part, "drop", "0:20 is in the drop");
    assert.equal(st.nowPlaying.following, true); assert.equal(st.nowPlaying.file, file);
    assert.ok(s.app.runtime.log.some(m => /library song “Synth Crew - Anthem” \(the same file\)/.test(m.msg)));
    // a file that isn't in the library: not followed by its path
    out = { code: 0, stdout: ["vlc", "Playing", "track 1", "", "", 60e6, 20e6, "", "file:///nowhere/else.wav"].join(SEP), stderr: "" };
    await s.app.nowPlaying.np.poll(); await sleep(80); assert.notEqual((await s.call("GET", "/api/status")).body.source, "nowplaying");
  } finally { await s.done(); rmSync(music, { recursive: true, force: true }); }
});

test("library: one worker on a small computer, more on a big one; workers run at the lowest priority on Linux", async () => {
  const PI = { cpus: Array(4).fill({ model: "ARMv7 Processor rev 4 (v7l)", speed: 1000 }), arch: "arm", model: "Raspberry Pi 3 Model B Rev 1.2\0", cpuinfo: "" };
  const BIG = { cpus: Array(8).fill({ model: "x", speed: 3000 }), arch: "x64", model: "", cpuinfo: "" };
  const music = musicDir(), a = await setup({ host: PI, library: { workers: undefined } }), b = await setup({ host: BIG, library: { workers: undefined } });
  try {
    assert.equal(a.app.runtime.perf.lite, true); assert.equal(a.lib.workerCount(), 1, "low-power mode: one worker");
    assert.equal(b.lib.workerCount(), Math.max(1, Math.min(8, (os.availableParallelism?.() || os.cpus().length) - 1)), "cores - 1");
    const v = (await a.call("PATCH", "/api/library", { folders: [music] })).body; assert.equal(v.progress.maxWorkers, 1);
    assert.equal(a.lib.view().cap.maxSongs, 1500, "a smaller library on a small computer");
    assert.ok(await until(() => a.lib.workers > 0 && a.lib.nice !== null, 10000)); assert.ok(a.lib.workers <= 1);
    if (process.platform === "linux") assert.equal(a.lib.nice, 19, "the worker thread is niced");
    assert.ok(await a.lib.idle(90000));
  } finally { await a.done(); await b.done(); rmSync(music, { recursive: true, force: true }); }
});

test("library: with ffmpeg, MP3 files are decoded and named from their tags", { skip: !hasFfmpeg && "ffmpeg isn't installed" }, async () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "tl-mp3-"));
  try {
    writeFileSync(path.join(d, "a.wav"), encodeWav(EDM.x, SR));
    const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", path.join(d, "a.wav"), "-metadata", "title=Anthem", "-metadata", "artist=Synth Crew", "-b:a", "160k", path.join(d, "a.mp3")]); assert.equal(r.status, 0);
    const m = await analyseFile(path.join(d, "a.mp3"), { ffmpeg: "ffmpeg", ffprobe: "ffprobe" });
    assert.equal(m.name, "Synth Crew - Anthem"); assert.ok(Math.abs(m.entry.bpm - 128) < 1, `tempo ${m.entry.bpm}`);
    const w = await analyseFile(path.join(d, "a.wav"), {}); assert.ok(sameRecording(m.entry, w.entry), "the MP3 and the WAV are the same recording");
    assert.ok(!sameRecording(m.entry, { ...w.entry, dur: w.entry.dur + 10 }), "another length: another song");
  } finally { rmSync(d, { recursive: true, force: true }); }
});
