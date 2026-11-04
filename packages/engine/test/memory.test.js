import test from "node:test";
import assert from "node:assert/strict";
import { LiveAnalyser, preAnalyseCore, memoryEntry, memoryAnalysis, recognise, matchAt, refineByKicks, planShow, showAt, createEffects, createDirector, buildLayout, exampleRoom, metronomeView } from "../src/index.js";
import { edm, ballad, voice, pluck, piece, minorBallad, majorPop } from "./synth.js";

const sr = 22050, song = edm(sr), pre = await preAnalyseCore(song.x, sr), bal = ballad(sr), balPre = await preAnalyseCore(bal.x, sr);
const fx = createEffects(buildLayout(exampleRoom()));
const mb = minorBallad(sr), mbPre = await preAnalyseCore(mb.x, sr), pop = majorPop(sr), popPre = await preAnalyseCore(pop.x, sr);
const LIB = [memoryEntry("EDM", pre, "edm"), memoryEntry("Ballad", balPre, "ballad"), memoryEntry("Minor ballad", mbPre, "minor"), memoryEntry("Pop", popPre, "pop")];
/** hear x live (from `start` s into the song) and recognise against `lib` once a second, as the runtime does: a lock is
 * two matches a second apart that agree. Returns the locks, right or wrong, and when the first right one came. */
function locks(x, lib, truthId, start = 0, gain = 1) { let prev = null, first = null; const right = [], wrong = [];
  listen(x, a => { const r = recognise(a.tap.q, lib, a.memoryQuery());
    if (r && prev && r.id === prev.id && Math.abs(r.pos - (prev.pos + a.t - prev.t)) < 0.3) { const ok = r.id === truthId && Math.abs(r.pos - (start + a.t)) < 0.35;
      (ok ? right : wrong).push(`${r.id}@${r.pos.toFixed(1)} (playing ${(start + a.t).toFixed(1)}, chroma ${r.chroma?.toFixed(2)})`); if (ok && first == null) first = a.t; }
    prev = r ? { ...r, t: a.t } : null; }, gain);
  return { right, wrong, first };
}
/** listen to x and call fn(analyser) about once a second once 12 s have been heard */
function listen(x, fn, gain = 1) { const a = new LiveAnalyser(sr); for (let i = 0; i < x.length; i += 512) { a.push(x.subarray(i, i + 512).map(v => v * gain)); if ((i / 512) % 43 === 0 && a.t > 12) fn(a); } return a; }

test("song memory: entries survive being saved and loaded, and recognising doesn't add anything to them", () => {
  const e = memoryEntry("EDM", pre, "a"), keys = Object.keys(e).join(), size = JSON.stringify(e).length;
  const a = new LiveAnalyser(sr), x = song.x.subarray(8 * sr); for (let i = 0; i < 14 * sr; i += 512) a.push(x.subarray(i, i + 512));
  assert.ok(recognise(a.tap.q, [e]), "recognised");
  assert.equal(Object.keys(e).join(), keys, "no caches are stored on the entry"); assert.equal(JSON.stringify(e).length, size);
  const loaded = JSON.parse(JSON.stringify(e)), r = recognise(a.tap.q, [loaded]);
  assert.ok(r && r.id === "a", "still recognised after a save and reload");
});

test("song memory: never locks onto a repetitive part at the wrong beat", () => {
  // the runtime follows a song once two matches a second apart agree; in the 8 bars of drop, every beat looks alike
  const e = memoryEntry("EDM", pre, "a"); let locks = 0;
  for (const start of [0, 2, 4, 6, 8, 10]) { let prev = null;
    listen(song.x.subarray(start * sr), a => { const r = recognise(a.tap.q, [e], { bpm: a.bpm || undefined }), truth = start + a.t;
      if (r && prev && Math.abs(r.pos - (prev.pos + a.t - prev.t)) < 0.3) { locks++; assert.ok(Math.abs(r.pos - truth) < 0.25, `locked at ${r.pos.toFixed(2)} s, playing ${truth.toFixed(2)} s`); }
      prev = r ? { ...r, t: a.t } : null; }); }
  assert.ok(locks >= 20, `still recognised (${locks} agreeing pairs)`);
});

test("song memory: matchAt confirms the song where it should be, and not another song", () => {
  const e = memoryEntry("EDM", pre, "a"), b = memoryEntry("Ballad", balPre, "b"); const own = [], other = [];
  listen(song.x, a => own.push(matchAt(a.tap.q, e, a.t, 0.2)?.score ?? 0), 0.05); // quietly, through a mic across the room
  listen(bal.x, a => { for (const d of [-8, 0, 3]) other.push(matchAt(a.tap.q, e, a.t + d, 0.2)?.score ?? 0); });
  listen(song.x, a => { for (const d of [0, 5]) other.push(matchAt(a.tap.q, b, a.t + d, 0.2)?.score ?? 0); });
  assert.ok(Math.min(...own) > 0.5, `the right song, right place: ${Math.min(...own).toFixed(2)}`);
  const top = [...other].sort((x, y) => y - x); // (the runtime needs 0.45; one song's ending can look a bit like another's)
  assert.ok(top[0] < 0.45 && top[Math.floor(top.length / 20)] < 0.25, `another song: ${top[0].toFixed(2)}, ${top[Math.floor(top.length / 20)].toFixed(2)}`);
  const a = listen(song.x, () => {}); assert.equal(matchAt(a.tap.q, e, pre.dur + 30).score, 0, "past the end of the song nothing matches");
});

test("song memory: kicks line up for a song played faster", () => {
  const rate = 1.03, kicks = pre.kicks, liveT = 40, pos = 25; // live kicks of the song at 3% faster, ending at song time 25
  const live = kicks.filter(k => k < pos && k > pos - 10).map(k => liveT - (pos - k) / rate);
  assert.ok(Math.abs(refineByKicks(live, liveT, pos + 0.06, kicks, 0.2, rate).pos - pos) < 0.02, "with the rate");
});

test("shows: every block has an effect even when everything is banned; empty and short songs; showAt edges", () => {
  const ban = {}; for (const k of Object.keys(fx.pools)) for (const id of fx.pools[k]) ban[id] = -1;
  const p = planShow(pre, fx, { prefs: ban }); assert.ok(p.length && p.every(b => fx.list.some(f => f.id === b.effect)), "real effects");
  assert.deepEqual(planShow({ ...pre, bars: [] }, fx), []);
  const one = planShow({ bars: [{ t0: 0, t1: 1.8, state: "calm", level: 0.2 }], style: "chill", dur: 1 }, fx); assert.equal(one.length, 1);
  const full = planShow(pre, fx); assert.equal(full[0].t0, 0); assert.equal(full.at(-1).t1, Math.round(pre.dur * 1000) / 1000);
  for (let i = 1; i < full.length; i++) assert.equal(full[i].t0, full[i - 1].t1, "no gaps");
  assert.equal(showAt(full, -1), null); assert.equal(showAt(full, pre.dur + 1), null); assert.equal(showAt(full, full[1].t0), full[1]);
});

test("director: a clock that jumps back doesn't break crossfades or stop the effects changing", () => {
  const L = buildLayout(exampleRoom()), D = createDirector(L, createEffects(L)); D.settings.style = "party";
  const drop = t => ({ ...metronomeView(t, 128), state: "drop" });
  for (let t = 100; t < 110; t += 1 / 30) D.frame(drop(t), t);
  D.settings.mode = "manual"; D.settings.effect = "solar"; D.frame(drop(110), 110); D.settings.mode = "auto"; // a crossfade starting at t = 110
  const c = D.frame(drop(8), 8); assert.ok(Math.max(...c) < 6, `no runaway colours (${Math.max(...c).toFixed(1)})`);
  const seen = new Set(); for (let t = 8; t < 40; t += 1 / 30) { D.frame(drop(t), t); seen.add(D.current); }
  assert.ok(seen.size >= 2, "the automatic show keeps changing effects after the jump");
  // a show's block whose effect has been banned since is skipped
  D.settings.plan = [{ t0: 0, t1: 100, part: "drop", effect: "laser" }]; D.frame(drop(41), 41); assert.equal(D.current, "laser");
  D.settings.prefs.laser = -1; D.frame(drop(42), 42); assert.notEqual(D.current, "laser");
});

test("vocal estimate: a plucked guitar melody with vibrato isn't a voice", () => {
  const avg = x => { const a = new LiveAnalyser(sr), v = []; for (let i = 0; i < x.length; i += 512) { a.push(x.subarray(i, i + 512)); if (a.t > 2) v.push(a.vocal); } return v.reduce((p, c) => p + c, 0) / v.length; };
  const g = avg(pluck(sr, 8).x), v = avg(voice(sr, 8).x); assert.ok(g < 0.2, `guitar ${g.toFixed(2)}`); assert.ok(v > 0.6, `voice ${v.toFixed(2)}`);
});

test("song memory: drumless ballads are recognised live from the middle, though the stored tempo is off", () => {
  // the whole-song tempo of a ballad is a guess (here twice what it feels like); the tempo filter must not throw it out
  assert.ok(Math.abs(balPre.bpm - 70) > 20 && LIB[1].ch && LIB[2].ch, `stored ballad tempo ${balPre.bpm}`);
  const cases = [[mb.x, "minor", 20], [mb.x, "minor", 45], [bal.x, "ballad", 10], [bal.x, "ballad", 0]];
  for (const [x, id, start] of cases) { const r = locks(x.subarray(start * sr), LIB, id, start);
    assert.equal(r.wrong.length, 0, `${id} from ${start} s: wrong locks ${r.wrong.join(", ")}`);
    assert.ok(r.first != null && r.first < 16, `${id} from ${start} s: recognised after ${r.first} s of listening (${r.right.length} agreeing)`); }
  const quiet = locks(mb.x.subarray(30 * sr), LIB, "minor", 30, 0.05); // a mic across the room
  assert.ok(quiet.first != null && quiet.first < 16 && !quiet.wrong.length, `quietly: ${quiet.first}, wrong ${quiet.wrong}`);
});

test("song memory: unrelated songs never lock, even in the same key with the same chords and tempo", () => {
  const strangers = { "same key, chords, tempo, another tune": minorBallad(sr, 77).x, "same key, other chords": piece({ tonic: 6, mode: "minor", bpm: 64, bars: 16, seed: 21, prog: [0, 3, 4, 0, 5, 2, 6, 4] }).x,
    "minor with drums": piece({ tonic: 7, mode: "minor", bpm: 128, bars: 16, seed: 6, drums: true }).x, "the pop song's twin": majorPop(sr, 31).x,
    "another ballad": piece({ tonic: 9, mode: "major", bpm: 70, bars: 16, seed: 8, prog: [0, 5, 3, 4] }).x, "a voice": voice(sr, 20).x };
  for (const [name, x] of Object.entries(strangers)) { const r = locks(x, LIB, null); assert.equal(r.wrong.length, 0, `${name}: ${r.wrong.join(", ")}`); }
});

test("song memory: EDM still locks on the beat with chroma; entries without chroma (older ones) still match on loudness", () => {
  for (const start of [0, 6]) { const r = locks(song.x.subarray(start * sr), LIB, "edm", start);
    assert.ok(r.right.length >= 8 && !r.wrong.length, `EDM from ${start}: ${r.right.length} right, wrong ${r.wrong.join(", ")}`); }
  const old = LIB.map(e => { const o = JSON.parse(JSON.stringify(e)); delete o.ch; delete o.key; delete o.mode; delete o.mood; return o; });
  const r = locks(song.x.subarray(6 * sr), old, "edm", 6); assert.ok(r.right.length >= 6 && !r.wrong.length, `old entries: ${r.right.length} right, wrong ${r.wrong}`);
  assert.equal(memoryAnalysis(old[0]).mood, null, "an old entry has no mood");
  const total = JSON.stringify(LIB).length, perSec = LIB.reduce((n, e) => n + e.ch.length, 0) / LIB.reduce((n, e) => n + e.dur, 0);
  assert.ok(perSec < 45 && total < 50000, `chroma is ${perSec.toFixed(0)} characters a second of music; the four entries are ${total}`);
});

test("song memory: matchAt with chroma keeps following a ballad and doesn't confirm another song", () => {
  const e = LIB[2], own = [], other = [];
  listen(mb.x, a => own.push(matchAt(a.tap.q, e, a.t, 0.2, a.memoryQuery())?.score ?? 1)); // (null: too flat to tell, which the runtime lets pass)
  listen(piece({ tonic: 6, mode: "minor", bpm: 64, bars: 16, seed: 21, prog: [0, 3, 4, 0, 5, 2, 6, 4] }).x, a => { for (const d of [0, 7]) other.push(matchAt(a.tap.q, e, a.t + d, 0.2, a.memoryQuery())?.score ?? 0); });
  listen(minorBallad(sr, 77).x, a => other.push(matchAt(a.tap.q, e, a.t + 7, 0.2, a.memoryQuery())?.score ?? 0)); // its twin (same chords, another tune), elsewhere
  listen(song.x, a => other.push(matchAt(a.tap.q, e, a.t, 0.2, a.memoryQuery())?.score ?? 0));
  assert.ok(Math.min(...own) > 0.6, `own song ${Math.min(...own).toFixed(2)}`); assert.ok(Math.max(...other) < 0.45, `another song ${Math.max(...other).toFixed(2)}`);
});

test("shows: an automatic show is what the live director would play (as many changes, same effects)", async () => {
  const { songView } = await import("../src/signals.js");
  const L = buildLayout(exampleRoom()), F = createEffects(L), D = createDirector(L, F), live = [];
  for (let t = 0; t < pre.dur; t += 1 / 30) { D.frame(songView(pre, t), t, {}, t); if (live.at(-1) !== D.state.showing) live.push(D.state.showing); }
  const plan = planShow(pre, F).map(b => b.effect), drops = planShow(pre, F).filter(b => b.part === "drop").length;
  const strip = a => a.filter((x, i) => x !== a[i - 1]);
  assert.ok(Math.abs(strip(plan).length - strip(live).length) <= 3, `changes: show ${plan.length}, live ${live.length}`);
  const common = plan.filter(x => live.includes(x)).length; assert.ok(common >= plan.length - 2, `same effects: ${plan} vs ${live}`);
  // drops change effect every 4 bars (on the phrase grid) and change look in between with a variation
  assert.ok(drops >= 2, `drops change effect every 4 bars (${drops} blocks)`);
});
