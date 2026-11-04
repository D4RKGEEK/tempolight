import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import { edm } from "../../engine/test/synth.js";
import { preAnalyseCore } from "../../engine/src/index.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 5000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(30); } return false; }
async function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tl-test-")), app = await createApp({ dataDir: dir, discover: false, logger: null });
  const port = await app.listen(0, "127.0.0.1"), base = `http://127.0.0.1:${port}`;
  const call = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  return { app, call, async done() { await app.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("timeline editor API: colours, cues and brightness are saved, validated and played at the right moment", async () => {
  const s = await setup();
  try {
    await s.call("POST", "/api/devices", { virtual: true });
    const song = edm(22050), pre = await preAnalyseCore(song.x, song.sr), analysis = { ...pre, env: Array.from(pre.env) };
    await s.call("POST", "/api/song", { name: "Cue test", analysis });
    const id = s.app.runtime.status().song.memId, D = s.app.runtime.director; assert.ok(id);
    const g = (await s.call("GET", `/api/songs/${id}/show`)).body;
    assert.ok(g.P > 0 && g.bars.length && typeof g.env === "string", "the editor gets the beat grid, bars and loudness");
    assert.deepEqual(g.cues, []); assert.deepEqual(g.colors, []); assert.ok(/^#[0-9a-f]{6}$/.test(g.palettes.fire[0]), "palette colours as hex"); assert.ok(!g.palettes.auto);

    const cueT = 6.5, body = { show: g.show, colors: [{ t0: 0, t1: 4, palette: "fire" }], cues: [{ t: cueT, type: "flash", color: "#ff0000" }, { t: 12, type: "strobe", beats: 2 }], bright: [{ t: 0, v: 1 }, { t: 2, v: 0.5 }] };
    const put = await s.call("PUT", `/api/songs/${id}/show`, body); assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal(put.body.cues.length, 2); assert.equal(put.body.edited, true);
    for (const bad of [{ ...body, cues: [{ t: 1, type: "confetti" }] }, { ...body, colors: [{ t0: 0, t1: 2, palette: "nope" }] }, { ...body, bright: [{ t: 1, v: 5 }] }, { ...body, cues: [{ t: 1e6, type: "flash" }] }, { cues: [] }])
      assert.equal((await s.call("PUT", `/api/songs/${id}/show`, bad)).status, 400, JSON.stringify(bad).slice(0, 80));
    // an older app sends only the blocks: the cues stay
    assert.equal((await s.call("PUT", `/api/songs/${id}/show`, { show: g.show })).status, 200);
    assert.equal((await s.call("GET", `/api/songs/${id}/show`)).body.cues.length, 2);

    // play up to the flash: it fires once, a small step back doesn't fire it again, a real seek back does
    await s.call("POST", "/api/song/clock", { pos: cueT - 0.4, playing: true });
    assert.ok(await until(() => D.state.cuesFired === 1, 8000), `the flash fired (fired ${D.state.cuesFired}, clock at ${s.app.runtime.status().pos})`);
    assert.ok(Math.abs(D.state.lastCue.t - cueT) < 1e-9); assert.deepEqual(D.state.overlay.flashColor, [1, 0, 0]);
    assert.ok(D.settings.timeline && D.settings.timeline.colors.length === 1, "the director has the timeline");
    await sleep(150); await s.call("POST", "/api/song/clock", { pos: cueT - 0.05, playing: true }); await sleep(400);
    assert.equal(D.state.cuesFired, 1, "a small correction back doesn't fire it twice");
    await s.call("POST", "/api/song/clock", { pos: cueT - 0.6, playing: true });
    assert.ok(await until(() => D.state.cuesFired === 2, 3000), "after a seek back it plays again");
    await s.call("POST", "/api/song/clock", { pos: cueT + 3, playing: true }); await sleep(200); assert.equal(D.state.cuesFired, 2);

    // the editor previews unsaved changes on the lights without saving them
    const other = g.show.map(b => ({ ...b, effect: "fireworks" }));
    assert.equal((await s.call("PUT", `/api/songs/${id}/show/draft`, { show: other, cues: [] })).status, 200);
    assert.ok(await until(() => D.settings.plan?.[0]?.effect === "fireworks"), "the draft plays");
    assert.deepEqual(s.app.store.data.songs.find(e => e.id === id).show.map(b => b.effect), g.show.map(b => b.effect), "and isn't saved");
    assert.equal((await s.call("PUT", `/api/songs/${id}/show/draft`, { cues: [{ t: 1, type: "nope" }] })).status, 400);
    await s.call("DELETE", `/api/songs/${id}/show/draft`); assert.ok(await until(() => D.settings.plan?.[0]?.effect === g.show[0].effect), "back to the saved show");

    // the same song played again keeps the hand-made timeline; reset to automatic clears it
    await s.call("POST", "/api/song", { name: "Cue test", analysis }); assert.equal(s.app.store.data.songs.find(e => e.id === id).cues.length, 2, "kept when remembered again");
    const reset = (await s.call("DELETE", `/api/songs/${id}/show`)).body; assert.deepEqual(reset.cues, []); assert.equal(reset.edited, false);
    assert.equal((await s.call("GET", `/api/songs/${id}/show`)).body.colors.length, 0);
  } finally { await s.done(); }
});

test("old saved shows (just a list of blocks) keep working", async () => {
  const s = await setup();
  try {
    await s.call("POST", "/api/devices", { virtual: true });
    const song = edm(22050), pre = await preAnalyseCore(song.x, song.sr);
    await s.call("POST", "/api/song", { name: "Old one", analysis: { ...pre, env: Array.from(pre.env) } });
    const e = s.app.store.data.songs[0]; e.show = [{ t0: 0, t1: e.dur, part: "drop", effect: "fireworks" }]; e.showEdited = true; delete e.cues; delete e.colors; delete e.bright;
    const g = (await s.call("GET", `/api/songs/${e.id}/show`)).body; assert.deepEqual(g.cues, []); assert.equal(g.show.length, 1);
    await s.call("POST", "/api/song/clock", { pos: 3, playing: true });
    assert.ok(await until(() => s.app.runtime.status().effect === "fireworks"), "the blocks play"); assert.equal(s.app.runtime.director.settings.timeline, null);
  } finally { await s.done(); }
});
