// One look per song (looks.js): what pickLook() picks, and the director and planShow() agreeing when they play a look.
// The tests read the ratings (ratings.js) rather than naming effects, so they hold for any ratings file.
import test from "node:test";
import assert from "node:assert/strict";
import { preAnalyseCore, buildLayout, exampleRoom, createEffects, createDirector, songView, metronomeView, planShow, pickLook, songCharacter, characterOf, lookEffect, lookLabel, rating, AUTO } from "../src/index.js";
import { edm, ballad, majorPop } from "./synth.js";

const sr = 22050, L = buildLayout(exampleRoom()), fx = createEffects(L), ids = fx.list.map(e => e.id);
const edmPre = await preAnalyseCore(edm(sr).x, sr), balPre = await preAnalyseCore(ballad(sr).x, sr), popPre = await preAnalyseCore(majorPop(sr).x, sr);
const roles = lk => [lk.main, lk.drop, lk.build, lk.calm].filter(Boolean);

test("looks: a fast four-on-the-floor EDM song gets a kick-driven, high-energy effect", () => {
  const c = songCharacter(edmPre); assert.ok(c.kickFrac > 0.7 && c.energy >= 0.62, JSON.stringify(c));
  for (const seed of ["a", "b", "c", "EDM"]) { const lk = pickLook(edmPre, { seed, available: ids }), r = rating(lk.main);
    assert.ok(r.kickDriven && r.energy === "high", `${seed}: ${lk.main} ${JSON.stringify(r)}`);
    assert.ok(lk.why.includes("high energy") && lk.why.some(w => /four-on-the-floor/.test(w)), lk.why.join(", "));
    assert.ok(fx.palettes[lk.palette], `a real palette: ${lk.palette}`); }
});

test("looks: a ballad gets a calm, low-energy effect that doesn't need the beat, and no separate drop effect", () => {
  for (const seed of ["a", "b", "c", "Ballad"]) { const lk = pickLook(balPre, { seed, available: ids }), r = rating(lk.main);
    assert.ok(r.energy === "low" && !r.needsBeat && r.calm >= 60, `${seed}: ${lk.main} ${JSON.stringify(r)}`);
    assert.equal(lk.drop, null); assert.equal(lk.calm, lk.main); }
  const drumless = characterOf({ bpm: 70, style: "emotional", kickFrac: 0, drumless: true });
  for (let i = 0; i < 20; i++) { const lk = pickLook(drumless, { seed: i }); assert.ok(roles(lk).every(id => !rating(id).needsBeat), `no drums, nothing that needs a beat: ${roles(lk)}`); }
});

test("looks: banned effects are never chosen, liked ones come up more, rejected ones are skipped", () => {
  const prefs = {}; const seen = new Set();
  for (let k = 0; k < 6; k++) { const lk = pickLook(edmPre, { seed: "x", prefs, available: ids });
    for (const id of roles(lk)) assert.notEqual(prefs[id], -1, `${id} is banned`); seen.add(lk.main); prefs[lk.main] = -1; }
  assert.ok(seen.size === 6, "a new one each time");
  let liked = 0, plain = 0; const fav = AUTO.drop.find(id => rating(id).energy === "high" && rating(id).kickDriven);
  for (let i = 0; i < 40; i++) { if (pickLook(edmPre, { seed: i, prefs: { [fav]: 1 } }).main === fav) liked++; if (pickLook(edmPre, { seed: i }).main === fav) plain++; }
  assert.ok(liked > plain, `liked ${fav}: ${liked} of 40, else ${plain}`);
  const first = pickLook(edmPre, { seed: "y" }), next = pickLook(edmPre, { seed: "y", exclude: [first.main] });
  assert.notEqual(next.main, first.main); assert.ok(!roles(next).includes(first.main), "a rejected effect plays no part");
  const down = pickLook(edmPre, { seed: "y", nudge: { [first.main]: -1 } }); assert.notEqual(down.main, first.main, "a strong nudge down moves it");
});

test("looks: the same song gets the same look; different songs vary", () => {
  assert.deepEqual(pickLook(edmPre, { seed: "Song A" }), pickLook(edmPre, { seed: "Song A" }));
  const mains = new Set(), pals = new Set(); for (let i = 0; i < 16; i++) { const lk = pickLook(edmPre, { seed: `Song ${i}` }); mains.add(lk.main); pals.add(lk.palette); }
  assert.ok(mains.size >= 3, `16 EDM songs get ${mains.size} different effects: ${[...mains]}`); assert.ok(pals.size >= 2, `and ${pals.size} palettes`);
  const pop = pickLook(popPre, { seed: "Pop" }); assert.ok(rating(pop.main), pop.main);
  assert.match(lookLabel(pickLook(edmPre, { seed: "Song A" }), Object.fromEntries(fx.list.map(e => [e.id, e.name]))), /^[A-Z][\w -]+ · [A-Z]\w+ \(.+, .+\)$/);
  assert.equal(pickLook(edmPre, { seed: "z", prefs: Object.fromEntries(Object.keys(fx.lum).map(id => [id, -1])) }), null, "everything banned: no look");
});

test("looks: variety one plays one effect (the drop effect only at drops), parts one per song part", () => {
  const lk = { main: "a", drop: "d", build: "b", calm: "c" };
  assert.deepEqual(["calm", "build", "drop", "silent"].map(p => lookEffect(lk, "one", p)), ["a", "a", "d", "a"]);
  assert.deepEqual(["calm", "build", "drop"].map(p => lookEffect(lk, "parts", p)), ["c", "b", "d"]);
  assert.deepEqual(["calm", "build", "drop"].map(p => lookEffect({ main: "a", drop: null, build: null, calm: "c" }, "parts", p)), ["c", "a", "a"]);
});

test("looks: a look's show is what the live director plays, in every variety", () => {
  const look = pickLook(edmPre, { seed: "EDM", available: ids });
  for (const variety of ["one", "parts", "show"]) {
    const F = createEffects(L), D = createDirector(L, F), live = []; D.settings.variety = variety; D.settings.look = variety === "show" ? null : look;
    for (let t = 0; t < edmPre.dur; t += 1 / 30) { D.frame(songView(edmPre, t), t, {}, t); if (live.at(-1) !== D.state.showing) live.push(D.state.showing); }
    const plan = planShow(edmPre, F, { variety, look }).map(b => b.effect), strip = a => a.filter((x, i) => x !== a[i - 1]);
    assert.ok(Math.abs(strip(plan).length - strip(live).length) <= (variety === "show" ? 3 : 0), `${variety}: show ${plan}, live ${live}`);
    if (variety !== "show") assert.deepEqual(strip(plan), strip(live).slice(-strip(plan).length), `${variety}: the same effects`);
    if (variety === "one") assert.ok(strip(live).length <= 2 && live.includes(look.main), `one look: ${live}`);
    for (const id of plan) assert.ok(variety === "show" ? true : roles(look).includes(id), `${variety}: ${id} is part of the look`);
  }
});

test("looks: live listening picks a look of its own, keeps it, and picks again for a new song", () => {
  const D = createDirector(L, createEffects(L)); D.settings.variety = "one"; const shown = [];
  for (let t = 0; t < 40; t += 1 / 30) { D.frame({ ...metronomeView(t, 128), live: true }, t, {}, t); if (shown.at(-1) !== D.showing) shown.push(D.showing); }
  assert.ok(D.look && D.look.provisional, "a look picked live"); const first = D.look.main;
  assert.ok(shown.length <= 3, `kept for the song: ${shown}`);
  assert.ok(D.nextLiveLook(first) && D.look.main !== first, "Not this one: another");
  for (let t = 40; t < 45; t += 1 / 30) D.frame(null, t, {}, t);
  assert.equal(D.state.liveLook, null, "nothing playing for a while: the next song gets its own");
  D.settings.look = { main: "candle", drop: null, build: null, calm: "candle", palette: "sunset", params: {}, why: [] };
  for (let t = 45; t < 48; t += 1 / 30) D.frame({ ...metronomeView(t, 128), state: "calm" }, t, {}, t);
  assert.equal(D.showing, "candle", "the song's own look wins"); assert.equal(D.look.main, "candle");
});
