import test from "node:test";
import assert from "node:assert/strict";
import { LiveAnalyser, preAnalyseCore, memoryEntry, recognise, matchAt, refineByKicks, planShow, showAt, createEffects, createDirector, buildLayout, exampleRoom, metronomeView } from "../src/index.js";
import { edm, ballad, voice, pluck } from "./synth.js";

const sr = 22050, song = edm(sr), pre = await preAnalyseCore(song.x, sr), bal = ballad(sr), balPre = await preAnalyseCore(bal.x, sr);
const fx = createEffects(buildLayout(exampleRoom()));
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
