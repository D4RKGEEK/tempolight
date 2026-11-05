#!/usr/bin/env node
// End-to-end test in a real browser (needs Playwright: npm i -g playwright && npx playwright install chromium).
// Starts two pretend WLED controllers and a Tempolight server, then clicks through every page like a user:
// add devices, lay out the room, play a song, listen to a microphone, live pads, effects, scenes, schedules, lock.
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../packages/server/src/app.js";
import { startFakeWled } from "./fake-wled.js";
import dgram from "node:dgram";

const require = createRequire(import.meta.url);
let chromium; try { ({ chromium } = require("playwright")); } catch { console.error("Playwright is not installed: npm i -g playwright && npx playwright install chromium"); process.exit(2); }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shots = process.env.SHOTS || null;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = []; let failed = 0;
async function step(name, fn) { const t0 = Date.now(); try { await fn(); results.push(`ok   ${name} (${Date.now() - t0} ms)`); } catch (e) { failed++; results.push(`FAIL ${name}: ${e.message}`); } }
const ok = (c, msg) => { if (!c) throw new Error(msg); };
async function until(fn, ms = 8000, msg = "timed out") { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(100); } throw new Error(msg); }

const A = await startFakeWled({ name: "Living room", leds: 300 }), B = await startFakeWled({ name: "Desk", leds: 144 });
const dataDir = mkdtempSync(path.join(os.tmpdir(), "tempolight-e2e-"));
const app = await createApp({ dataDir, discover: false, logger: null, homekit: { mdns: false, host: "127.0.0.1" } }); // Apple Home: no mDNS from tests
const port = await app.listen(0, "127.0.0.1"), base = `http://127.0.0.1:${port}`;
const status = () => app.runtime.status();
const lum = d => { let s = 0; for (const v of d.lastFrame) s += v; return s / d.lastFrame.length; };

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--auto-accept-this-tab-capture", "--auto-select-desktop-capture-source=Entire screen", "--enable-usermedia-screen-capturing"] });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 }, permissions: ["microphone"] });
const page = await ctx.newPage(); const errors = [];
page.on("pageerror", e => errors.push(e.message)); page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
page.on("dialog", d => d.accept(d.type() === "prompt" ? "Test scene" : undefined));
const shot = async n => { if (shots) await page.screenshot({ path: path.join(shots, `${n}.png`) }); };
const go = async h => { await page.goto(`${base}/#/${h}`); await page.waitForSelector("#page .panel"); await sleep(300); };

await step("first start opens the setup wizard; skipping it leaves the welcome card", async () => {
  await page.goto(`${base}/#/home`); await page.waitForSelector("#wizard"); ok(await page.isVisible("#wz-title"), "no wizard title"); await shot("00-wizard");
  await page.click("#wz-close"); await until(async () => !(await page.$("#wizard")), 3000, "wizard didn't close"); await until(() => app.store.data.settings.setupDone === true, 3000, "setupDone not saved");
  await go("home"); ok(!(await page.$("#wizard")), "the wizard came back after skipping it");
  ok(await page.isVisible("text=Welcome to Tempolight"), "no welcome card"); await shot("01-welcome");
});
await step("add a controller by IP address from Home", async () => {
  await page.fill("#s-ip", A.host); await page.click("#s-add");
  await until(() => app.store.data.devices.length === 1, 5000, "device not added");
  ok(app.store.data.devices[0].leds === 300, "LED count not read from WLED");
});
await step("add a second controller on the Devices page", async () => {
  await go("devices"); await page.fill("#d-ip", B.host); await page.click("#d-add");
  await until(() => app.store.data.devices.length === 2, 5000, "second device not added");
  for (const [d, f] of [[app.store.data.devices[0], A], [app.store.data.devices[1], B]]) await fetch(`${base}/api/devices/${d.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ ddpPort: f.ddpPort }) });
  await until(() => A.frames > 20 && B.frames > 20, 5000, "no DDP frames arriving");
  ok(A.badPackets + B.badPackets === 0, "bad DDP packets"); await go("devices"); await until(async () => (await page.$$("#d-rows .badge.live")).length === 2, 12000, "devices not shown online"); await shot("02-devices");
});
await step("idle: ambient light is on with nothing playing", async () => { await sleep(300); ok(lum(A) > 3, `room is dark when idle (${lum(A).toFixed(1)})`); });
await step("room: four-walls preset, send segments to WLED", async () => {
  await go("room"); await page.selectOption("#r-preset", "fourwalls"); await page.click("#r-use"); await sleep(600);
  const shapes = app.store.data.room.shapes; ok(shapes.filter(s => s.name.endsWith("wall")).length === 4, "four walls not created");
  await go("room"); await page.click(`[data-seg="${app.store.data.devices[0].id}"]`); await until(() => A.posts.some(p => p.seg && p.seg.length === 4), 4000, "segments not sent");
  ok(JSON.stringify(A.posts.at(-1).seg.map(s => [s.start, s.stop])) === "[[0,50],[50,150],[150,200],[200,300]]", "wrong segment ranges " + JSON.stringify(A.posts.at(-1).seg));
  await shot("03-room");
});
await step("room: edit a shape's LED count and save", async () => {
  await go("room"); const inp = page.locator('#r-rows input[data-k="count"]').first(); await inp.fill("60"); await inp.dispatchEvent("change");
  await page.click("#r-save"); await until(() => app.store.data.room.shapes[0].count === 60, 4000, "room not saved");
});
await step("room: camera mapping runs end to end (fake camera)", async () => {
  await go("room"); await page.click("#r-map"); await page.waitForSelector("#mp-cam"); await page.click("#mp-cam");
  await until(() => page.isEnabled("#mp-go"), 6000, "camera didn't start"); await page.selectOption("#mp-n", "40"); await page.click("#mp-go");
  let sawOne = false; for (let k = 0; k < 40 && !sawOne; k++) { const m = status().mapping; if (m && m.led >= 0) sawOne = true; await sleep(100); }
  ok(sawOne, "no LED was lit for mapping");
  // it first measures how fast the lights and the camera respond, then waits that long for each LED
  await until(() => page.textContent("#mp-go").then(t => /again/.test(t)), 120000, "mapping didn't finish"); ok(!status().mapping, "mapping mode left on");
  const msg = await page.textContent("#mp-msg"); ok(/found|hardly/i.test(msg), `no result message: ${msg}`);
  if (await page.isVisible("#mp-use")) { // use it, then drag the mapped shape hard against the left edge: it moves as a whole instead of being squashed
    await page.click("#mp-use"); await until(() => app.store.data.room.shapes.some(x => x.type === "points"), 4000, "mapped layout not saved"); await page.waitForSelector("#r-stage canvas");
    const sh = () => app.store.data.room.shapes.find(x => x.type === "points"), width = s => Math.max(...s.pts.map(p => p[0])) - Math.min(...s.pts.map(p => p[0])), w0 = width(sh());
    const i = app.store.data.room.shapes.indexOf(sh()), box = await until(async () => { await sleep(300); return page.locator("#r-stage").boundingBox(); }, 4000, "room stage not shown"), p0 = sh().pts[0]; // the page re-renders once the room is saved
    await page.mouse.move(box.x + p0[0] / 16 * box.width, box.y + p0[1] / 9 * box.height); await page.mouse.down(); await page.mouse.move(box.x - 300, box.y + p0[1] / 9 * box.height, { steps: 6 }); await page.mouse.up();
    await page.click("#r-save"); await until(() => Math.min(...app.store.data.room.shapes[i].pts.map(p => p[0])) < 0.05, 4000, "shape not dragged to the edge");
    ok(Math.abs(width(app.store.data.room.shapes[i]) - w0) < 0.01, `the mapped shape was squashed (${w0} → ${width(app.store.data.room.shapes[i])})`);
  }
  await go("map"); await page.click("#mp-cam"); await until(() => page.isEnabled("#mp-go"), 6000, "camera didn't start again"); await page.click("#mp-go");
  await until(() => status().mapping, 4000, "mapping didn't start again"); await go("home"); await until(() => !status().mapping, 1500, "leaving the page mid-scan left the lights in mapping mode");
});
await step("music: play a song, it is analysed and drives the lights", async () => {
  await go("music"); await page.setInputFiles("#m-files", path.join(root, "apps/playground/demo.mp3"));
  await until(() => status().source === "song", 60000, "song never became the source");
  const s = status(); ok(s.song && s.song.bpm > 60 && s.song.bpm < 200, "no tempo"); await sleep(1500);
  const seen = new Set(); for (let i = 0; i < 10; i++) { seen.add(lum(A).toFixed(0)); await sleep(150); } ok(seen.size > 3, "lights are not changing with the music");
  ok(status().bands && status().bands.some(v => v > 0), "no spectrum from the browser audio"); await shot("04-music");
  const hears = await until(() => page.textContent("#m-key").then(t => / (major|minor) · /.test(t) && t), 4000, "no key and mood on the Music page");
  ok(hears === status().hears, `the page shows "${hears}", the status says "${status().hears}"`);
});
await step("music: the sync meter says Locked; the song map draws its sections, drops and playhead; Home has the sync dot", async () => {
  await go("music"); await until(() => page.textContent("#sm-label").then(t => t === "Locked"), 6000, "the meter isn't Locked for a song played here");
  ok(/Following the song's beat map/.test(await page.textContent("#sm-hint")), "no hint"); ok(/^\d+$/.test(await page.textContent("#sm-bpm")), "no tempo on the meter");
  const sync = status().sync; ok(sync.state === "locked" && sync.score === 100 && sync.source === "song", JSON.stringify(sync));
  await until(() => page.isHidden("#sm-empty"), 6000, "the song map is empty");
  const map = await (await fetch(`${base}/api/song/map`)).json(); ok(map.source === "song" && map.sections.length >= 2 && map.drops.length >= 1, `map ${map.sections.length} sections`);
  await until(() => page.textContent("#sm-part").then(t => /^Part [A-Z]/.test(t)), 4000, "the part playing isn't named");
  ok(/\d:\d\d \/ \d:\d\d/.test(await page.textContent("#sm-pos")), "no position");
  const colours = await page.evaluate(() => { const c = document.querySelector("#sm-cv"), d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data, set = new Set();
    for (let i = 0; i < d.length; i += 4 * 7) if (d[i + 3] > 200) set.add(`${d[i] >> 4},${d[i + 1] >> 4},${d[i + 2] >> 4}`); return set.size; });
  ok(colours >= 4, `the map canvas is nearly blank (${colours} colours)`);
  const x0 = await page.evaluate(() => document.querySelector("#sm-pos").textContent); await sleep(1300); ok(x0 !== await page.textContent("#sm-pos"), "the playhead doesn't move");
  ok(await page.isVisible("#m-look") && await page.isVisible("#m-looknext"), "the look isn't next to the map");
  await page.locator("#m-sync").scrollIntoViewIfNeeded(); await shot("04-sync-map");
  if (process.env.MAP_SHOTS) await page.locator("#m-sync").screenshot({ path: path.join(process.env.MAP_SHOTS, "music-sync-desktop.png") });
  const ph = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 }), pp = await ph.newPage();
  try { await pp.goto(`${base}/#/music`); await pp.waitForSelector("#sm-cv"); await until(() => pp.isHidden("#sm-empty"), 6000, "phone: map empty");
    ok(await pp.evaluate(() => document.documentElement.scrollWidth) <= 392, "the Music page scrolls sideways on a phone");
    const h0 = await pp.evaluate(() => document.querySelector("#m-sync").getBoundingClientRect().height); await sleep(1200);
    ok(Math.abs(h0 - await pp.evaluate(() => document.querySelector("#m-sync").getBoundingClientRect().height)) < 1, "the panel changes height while playing");
    if (process.env.MAP_SHOTS) { await pp.evaluate(() => document.querySelector("#m-sync").scrollIntoView()); await pp.screenshot({ path: path.join(process.env.MAP_SHOTS, "music-sync-phone.png") }); }
    await pp.emulateMedia({ colorScheme: "dark" }); await sleep(1200);
    if (process.env.MAP_SHOTS) await pp.screenshot({ path: path.join(process.env.MAP_SHOTS, "music-sync-phone-dark.png") });
  } finally { await ph.close(); }
  await go("home"); await until(() => page.getAttribute("#h-hear .syncdot", "data-state").then(s => s === "locked"), 4000, "no sync dot on Home's status line");
  if (process.env.MAP_SHOTS) await page.locator("#h-hear").locator("..").locator("..").screenshot({ path: path.join(process.env.MAP_SHOTS, "home-syncdot.png") });
  await go("music");
});
await step("music: the song is remembered in song memory", async () => {
  await until(() => page.textContent("#m-songs").then(t => /BPM/.test(t)), 6000, "song not in the memory list");
  ok(app.store.data.songs.length === 1, "not stored");
});
await step("music: the song's look is shown; Not this one picks another, Keep keeps it; Effects page sets the variety", async () => {
  await go("music"); const lk0 = await until(() => status().look, 6000, "no look in the status");
  const shown = await until(() => page.textContent("#m-look").then(t => t.startsWith(lk0.mainName) && t), 4000, "the look isn't on the Music page");
  ok(/ · [A-Z]\w+ \(.+\)/.test(shown), `look label "${shown}"`); ok(status().effect === lk0.main || [lk0.drop, lk0.build, lk0.calm].includes(status().effect), "the look isn't playing");
  await shot("04a-look");
  await page.click("#m-looknext"); const lk1 = await until(() => status().look?.main !== lk0.main && status().look, 4000, "Not this one didn't change the look");
  ok(app.store.data.songs[0].look.rejected.includes(lk0.main), "the rejected effect isn't remembered with the song");
  await until(() => page.textContent("#m-look").then(t => t.startsWith(lk1.mainName)), 4000, "the new look isn't shown");
  await page.click("#m-lookkeep"); await until(() => app.store.data.songs[0].look.locked === true, 3000, "Keep not saved");
  await until(() => page.textContent("#m-lookkeep").then(t => /Kept/.test(t)), 3000, "Keep isn't shown as kept");
  await go("effects"); ok(await page.inputValue("#e-var") === "one", "variety isn't One look per song");
  await page.selectOption("#e-var", "show"); await until(() => app.store.data.show.variety === "show", 3000, "variety not saved"); // (the show editor steps below change blocks)
});
await step("music: Sync with Spotify panel: status, modes, settings, learned-song badge", async () => {
  await go("music"); await page.waitForSelector("#sp-panel #sp-mode"); ok(await page.isChecked("#sp-on"), "Sync with Spotify isn't on by default");
  await until(() => page.textContent("#sp-mode").then(t => t === "Nothing playing"), 4000, "no idle mode shown");
  ok(/Spotify/.test(await page.textContent("#sp-why")), "no explanation");
  await page.click("#sp-help summary"); ok(/\/api\/nowplaying\/spotify\/callback$/.test(await page.textContent("#sp-redir")), "no redirect URI in the set-up help");
  await page.uncheck("#sp-learn"); await until(() => app.store.data.settings.spotify.learn === false, 3000, "learning not turned off"); await page.check("#sp-learn"); await until(() => app.store.data.settings.spotify.learn === true, 3000, "learning not back on");
  const rt = app.runtime.rt, orig = rt.spotify.info, track = { id: "0DiWol3AO6WpXZgp0goxAV", title: "Test song", artist: "Someone", dur: 200, pos: 50, playing: true, volume: 50, art: null, device: "Phone" };
  try {
    rt.spotify.info = () => ({ ...orig(), on: true, connected: true, via: "web", mode: "learning", modeName: "Learning", track, learn: { state: "learning", pct: 42 } });
    await until(() => page.textContent("#sp-mode").then(t => t === "Learning this song… 42%"), 4000, "learning not shown");
    ok(/Learning this song… 42%/.test(await page.textContent("#sp-why")) && /Test song/.test(await page.textContent("#sp-title")), "learning text");
    rt.spotify.info = () => ({ ...orig(), on: true, connected: true, via: "web", mode: "exact", modeName: "Exact (learned)", track, map: { id: "x", name: "Someone - Test song", src: "learned", cover: 100 }, learn: { state: "learned", pct: 100 } });
    await until(() => page.textContent("#sp-mode").then(t => t === "Learned ✓"), 4000, "learned not shown");
    rt.spotify.info = () => ({ ...orig(), on: true, connected: true, via: "web", mode: "analysis", modeName: "Spotify analysis", track, map: { id: "x", name: "Someone - Test song", src: "spotify-analysis", cover: 100 }, learn: null });
    await until(() => page.textContent("#sp-mode").then(t => t === "Spotify analysis"), 4000, "Spotify analysis mode not shown");
  } finally { rt.spotify.info = orig; }
  const e = app.store.data.songs[0]; Object.assign(e, { spotifyId: "0DiWol3AO6WpXZgp0goxAV", src: "learned", cov: [[0, e.dur * 0.6]] });
  await go("home"); await go("music"); await until(() => page.textContent("#m-songs").then(t => /Spotify · learned · 60%/.test(t)), 4000, "no Spotify badge in the song list");
  delete e.spotifyId; delete e.src; delete e.cov; await shot("04b-spotify");
});
await step("music: the song has a show timeline; a block can be changed", async () => {
  await until(() => page.$$("#m-show .blk").then(b => b.length >= 2), 6000, "no show blocks");
  await page.click("#m-show .blk"); await page.waitForSelector("#m-blkfx"); await page.selectOption("#m-blkfx", "fireworks");
  await until(() => app.store.data.songs[0].showEdited && app.store.data.songs[0].show[0].effect === "fireworks", 4000, "block not saved"); await shot("04b-show");
});
await step("show editor: open it from the Music page, move a block, add a flash cue, save; the cue plays", async () => {
  await go("music"); await until(() => page.isVisible("#m-editshow"), 6000, "no Edit show button"); await page.click("#m-editshow");
  await page.waitForSelector('#tl-lanes [data-lane="fx"] .tl-blk'); await until(() => page.textContent("#tl-play").then(t => t === "Pause"), 4000, "the editor doesn't see the song playing");
  await page.click("#tl-play"); await until(() => !status().song.playing, 3000, "pause didn't reach the server");
  const song = () => app.store.data.songs[0], before = song().show[1].t0, blk = page.locator('#tl-lanes [data-lane="fx"] .tl-blk').nth(1), bb = await blk.boundingBox();
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2); await page.mouse.down(); await page.mouse.move(bb.x + bb.width / 2 + 60, bb.y + bb.height / 2, { steps: 6 }); await page.mouse.up();
  ok(await page.isEnabled("#tl-save"), "moving a block left nothing to save"); ok(/Unsaved/.test(await page.textContent("#tl-state")), "no unsaved-changes note");
  await page.click("#tl-undo"); ok(await page.isDisabled("#tl-save"), "undo didn't go back"); await page.click("#tl-redo"); ok(await page.isEnabled("#tl-save"), "redo didn't come back");
  const ruler = await page.locator('#tl-lanes [data-lane="ruler"]').boundingBox(), sc = await page.locator("#tl-sc").boundingBox();
  await page.mouse.click(Math.max(ruler.x, sc.x) + Math.min(sc.width * 0.6, 500), ruler.y + 8);
  await page.click('[data-add="flash"]'); await page.waitForSelector("#ti-col"); await page.fill("#ti-col", "#ff0000"); await page.dispatchEvent("#ti-col", "change");
  await page.click("#tl-save"); await until(() => song().cues?.length === 1 && song().show[1].t0 !== before, 4000, "show not saved");
  ok(song().cues[0].type === "flash" && song().cues[0].color === "#ff0000", "wrong cue saved " + JSON.stringify(song().cues)); await until(() => page.isDisabled("#tl-save"), 3000, "still unsaved after saving");
  const cueT = song().cues[0].t, P = song().P, D = app.runtime.director, n0 = D.state.cuesFired || 0;
  ok(Math.abs(((cueT - song().off) / P) - Math.round((cueT - song().off) / P)) < 0.01, "the cue isn't on a beat");
  await page.locator("#tl-sc").focus(); for (let k = 0; k < 4; k++) await page.keyboard.press("ArrowLeft"); // back four beats, then play
  await page.keyboard.press("Space"); await until(() => status().song.playing, 3000, "space didn't play");
  await until(() => (D.state.cuesFired || 0) > n0, 8000, "the flash cue never fired"); ok(D.state.lastCue.t === cueT && D.state.overlay.flashColor.join() === "1,0,0", "a different cue fired");
  await shot("04c-timeline");
});
await step("guest requests: a guest asks for a song, the host sees it", async () => {
  const g = await ctx.newPage(); g.on("pageerror", e => errors.push("request: " + e.message)); await g.goto(`${base}/request`);
  await g.fill("#title", "Daft Punk – One More Time"); await g.fill("#by", "Sam"); await g.click("#send"); await until(() => g.textContent("#msg").then(t => /Sent/.test(t)), 4000, "request not sent");
  await until(() => g.textContent("#list").then(t => /One More Time/.test(t)), 4000, "not in the guest's list"); await g.close();
  await go("music"); await until(() => page.textContent("#m-reqs").then(t => /One More Time/.test(t)), 4000, "host doesn't see it");
  await page.click("[data-rdone]"); await until(() => page.textContent("#m-reqs").then(t => /No requests/.test(t)), 4000, "not marked played");
});
await step("home shows the song with transport controls", async () => { await go("home"); await until(() => page.isVisible("#h-transport:not([hidden])"), 4000, "no transport"); await page.click("#h-play"); await sleep(600);
  ok(status().song && !status().song.playing, "pause did not reach the server"); await page.click("#h-play"); await sleep(400); ok(status().song.playing, "play did not resume"); await shot("05-home"); });
await step("live pads: blackout, flash, build & drop", async () => {
  await go("live"); await page.click('[data-pad="blackout"]'); await sleep(300); ok(status().overlay.blackout, "blackout not on"); ok(lum(A) === 0, "LEDs not dark in blackout");
  await page.click('[data-pad="blackout"]'); await sleep(300); ok(!status().overlay.blackout, "blackout not off");
  await page.click('[data-pad="build"]'); await sleep(300); ok(status().overlay.forced === "build", "build not forced");
  await page.keyboard.press("Escape"); await sleep(300); ok(!status().overlay.forced, "Esc did not clear"); await shot("06-live");
});
await step("phones as lights: QR code, a phone joins and shows the room's colours", async () => {
  await go("live"); await until(() => page.$("#ph-qr svg"), 4000, "no QR code"); const href = await page.getAttribute("#ph-url a", "href"); ok(/\/phone$/.test(href), `phone link ${href}`);
  const phone = await ctx.newPage(); phone.on("pageerror", e => errors.push("phone: " + e.message)); await phone.goto(`${base}/phone`); await phone.click("#go");
  await until(() => status().phones === 1, 5000, "phone did not join"); await until(async () => (await phone.evaluate(() => getComputedStyle(document.getElementById("light")).backgroundColor)) !== "rgb(0, 0, 0)", 5000, "phone stays black");
  await until(() => page.textContent("#ph-n").then(t => /1 phone/.test(t)), 3000, "count not shown"); await shot("06b-phones"); await phone.close();
  await until(() => status().phones === 0, 5000, "phone not removed");
});
await step("effects: pick one by hand, then back to automatic", async () => {
  await go("effects"); await page.click('[data-fx="tunnel"]'); await sleep(400); ok(app.store.data.show.mode === "manual" && app.store.data.show.effect === "tunnel", "effect not set");
  await until(() => status().effect === "tunnel", 3000, "effect not showing"); await shot("07-effects"); await page.click("#e-auto"); await sleep(300); ok(app.store.data.show.mode === "auto", "not back to auto");
});
await step("effects: like, ban and tune an effect", async () => {
  await go("effects"); await page.click('[data-like="laser"]'); await until(() => app.store.data.settings.effectPrefs.laser === 1, 3000, "like not saved");
  await page.click('[data-ban="tunnel"]'); await until(() => app.store.data.settings.effectPrefs.tunnel === -1, 3000, "ban not saved");
  await page.selectOption("#e-sel", "laser"); await page.fill("#p-int", "2"); await page.dispatchEvent("#p-int", "input");
  await until(() => app.store.data.show.params.laser?.intensity === 2, 3000, "effect setting not saved");
  await page.selectOption("#e-layer", "stars"); await until(() => app.store.data.show.layer?.effect === "stars", 3000, "accent layer not saved"); await shot("07b-effects");
});
await step("effects: make your own effect, show it, share it, delete it", async () => {
  await go("effects"); await page.fill("#u-name", "E2E waves"); await page.selectOption("#u-pattern", "chase"); await page.selectOption("#u-drive", "time");
  await page.uncheck("#u-pal"); await page.fill("#u-c1", "#ff0000"); await page.click("#u-save");
  await until(() => app.store.data.customEffects.length === 1 && app.store.data.show.effect === app.store.data.customEffects[0].id, 4000, "not saved and shown");
  await page.waitForSelector("#u-del:not([hidden])", { timeout: 4000 }); await sleep(600); ok(lum(A) > 1, "custom effect is dark");
  await page.click("#u-share"); const code = await page.inputValue("#u-code"); ok(code.startsWith("TL1:"), "no share code");
  await page.click('#e-tags [data-tag="mine"]'); ok(/E2E waves/.test(await page.textContent("#e-grid")), "not under Mine"); await shot("07d-custom");
  await page.click("#u-del"); await until(() => app.store.data.customEffects.length === 0, 4000, "not deleted");
  await until(() => page.textContent("#u-editing").then(t => /New effect/.test(t)), 4000, "page didn't re-render after delete"); await sleep(400);
  await page.fill("#u-code", code); await page.click("#u-import"); ok(await page.inputValue("#u-name") === "E2E waves" && await page.inputValue("#u-pattern") === "chase", "share code didn't import");
  // a hostile share code: HTML in the name, junk numbers and colours. It imports as plain text and sane values.
  const evil = "TL1:" + Buffer.from(JSON.stringify({ name: '<img src=x onerror="window.__xss=1">', pattern: "wave", speed: "NaN", width: 1e9, colors: ["red"], tag: "<b>" })).toString("base64");
  await page.fill("#u-code", evil); await page.click("#u-import"); ok(await page.inputValue("#u-speed") === "1", "junk speed imported"); await page.click("#u-save");
  await until(() => app.store.data.customEffects.length === 1, 4000, "hostile code not saved"); await sleep(300);
  ok(/<img src=x/.test(await page.textContent("#e-grid")) && !(await page.evaluate(() => window.__xss)), "effect name ran as HTML");
  await page.waitForSelector("#u-del:not([hidden])", { timeout: 4000 }); await page.click("#u-del"); await until(() => app.store.data.customEffects.length === 0, 4000, "not deleted");
  await page.fill("#u-code", "TL1:" + "A".repeat(5000)); await page.click("#u-import"); ok(await page.inputValue("#u-name") !== "", "a huge code broke the form");
});
await step("room: a zone switched off goes dark on its controller", async () => {
  await go("room"); await page.click("#z-add"); await until(() => (app.store.data.room.zones || []).length === 1, 3000, "zone not created");
  const zid = app.store.data.room.zones[0].id;
  const n = (await page.$$('#r-rows select[data-k="zone"]')).length; for (let k = 0; k < n; k++) await page.locator('#r-rows select[data-k="zone"]').nth(k).selectOption(zid);
  await page.click("#r-save"); await until(() => app.store.data.room.shapes.every(sh => sh.zone === zid), 4000, "shapes not in the zone");
  await go("room"); await page.selectOption('#z-rows select[data-zk="mode"]', "off"); await until(() => app.store.data.room.zones[0].mode === "off", 3000, "zone mode not saved");
  await sleep(400); ok(lum(A) === 0, "zone off but LEDs still lit"); await shot("07c-zones");
  await page.click("#z-rows [data-zdel]"); await until(() => !app.store.data.room.zones.length, 3000, "zone not deleted"); await go("room"); await page.click("#r-save"); await sleep(300);
});
await step("devices: power limit", async () => {
  await go("devices"); const inp = page.locator("[data-amps]").first(); await inp.fill("1.5"); await inp.dispatchEvent("change");
  await until(() => app.store.data.devices[0].maxAmps === 1.5, 3000, "power limit not saved");
});
await step("devices: a DMX universe, fixtures by profile and address, live channel values, fog pad", async () => {
  const rx = dgram.createSocket("udp4"), got = []; rx.on("message", b => got.push(b)); await new Promise(r => rx.bind(0, "127.0.0.1", r));
  const rowsFor = async id => (await page.$$(`[data-xlive^="${id}:"]`)).length;
  try {
    await go("devices"); await sleep(600); // let the re-render from the last step land first
    await page.fill("#x-host", `127.0.0.1:${rx.address().port}`); await page.fill("#x-univ", "1"); await page.click("#x-add");
    const d = await until(() => app.store.data.devices.find(x => x.kind === "dmx"), 4000, "DMX universe not added");
    await page.waitForSelector(`[data-xadd="${d.id}"]`); await sleep(300);
    await page.selectOption(`[data-xprof="${d.id}"]`, "moving-head-16"); await page.fill(`[data-xnaddr="${d.id}"]`, "10"); await page.click(`[data-xadd="${d.id}"]`);
    await until(() => d.fixtures.length === 1 && d.fixtures[0].address === 10, 4000, "fixture not added"); await until(async () => await rowsFor(d.id) === 1, 4000, "fixture not shown"); await sleep(300);
    await page.selectOption(`[data-xprof="${d.id}"]`, "custom"); await page.fill(`[data-xch="${d.id}"]`, "dimmer, red, green, blue"); await page.fill(`[data-xnaddr="${d.id}"]`, "1"); await page.click(`[data-xadd="${d.id}"]`);
    await until(() => d.fixtures.length === 2 && d.fixtures[1].profile === "custom", 4000, "custom fixture not added"); await until(async () => await rowsFor(d.id) === 2, 4000, "custom fixture not shown");
    await until(async () => (await page.$$(`[data-xlive^="${d.id}:"] b`)).length === 15, 4000, "live channel values not shown");
    await until(() => got.some(b => b.toString("latin1", 0, 7) === "Art-Net" && b[14] === 1 && b.readUInt16BE(16) === 512), 4000, "no Art-Net packets for universe 1");
    await page.check("#x-las"); await until(() => app.store.data.settings.dmx.lasers === true, 3000, "lasers setting not saved"); await sleep(400);
    await page.uncheck("#x-las"); await until(() => app.store.data.settings.dmx.lasers === false, 3000, "lasers not turned off again");
    await shot("08c-dmx"); await go("live"); ok(await page.isVisible('[data-pad="fog"]'), "no fog pad with a DMX device");
  } finally { rx.close(); for (const x of app.store.data.devices.filter(x => x.kind === "dmx")) await fetch(`${base}/api/devices/${x.id}`, { method: "DELETE" }); } // later steps expect only the two WLED controllers
});
await step("devices: a smart bulb (WiZ) from the grouped kind list, shown online, its colours arrive", async () => {
  const { fakeWiz } = await import("../packages/outputs/test/fake-lights.js"), W = await fakeWiz();
  try {
    await go("devices"); await sleep(400);
    ok((await page.$$("#d-kind optgroup")).length === 3, "kinds aren't grouped");
    await page.selectOption("#d-kind", "wiz"); await page.fill("#d-ip", W.host); await page.fill("#d-name", "Bedside"); await page.click("#d-add");
    const d = await until(() => app.store.data.devices.find(x => x.kind === "wiz"), 4000, "WiZ light not added");
    await until(async () => (await page.$$(`[data-chk="${d.id}"]`)).length === 1, 4000, "WiZ row not shown");
    await page.click(`[data-chk="${d.id}"]`); await until(async () => (await page.textContent("#d-rows")).includes("WiZ ESP01"), 4000, "WiZ health not shown");
    await until(() => W.pilots.length > 0, 4000, "no setPilot commands");
  } finally { W.close(); for (const x of app.store.data.devices.filter(x => x.kind === "wiz")) await fetch(`${base}/api/devices/${x.id}`, { method: "DELETE" }); } // later steps expect only the two WLED controllers
});
await step("music: input picker, level meter and timing fix are there", async () => {
  await go("music"); ok(await page.isVisible("#m-input") && await page.isVisible("#m-cal") && (await page.$("#m-lvl")) !== null, "controls missing");
});
await step("screen sync: share a screen and the Screen Sync effect turns on", async () => {
  await go("music"); await page.click("#m-scr"); await until(() => status().screen, 6000, "no screen frames arrive");
  ok(app.store.data.show.effect === "screen", "effect not switched"); await until(() => page.textContent("#m-scr").then(t => /Stop/.test(t)), 2000, "button not updated");
  await page.click("#m-scr"); await until(() => !status().screen, 1000, "sharing did not stop straight away");
  await app.core.handle("PATCH", "/api/show", { body: { mode: "auto" } });
});
await step("scenes: save, apply; schedules: add and run now", async () => {
  await go("scenes"); await page.click("#sc-save"); await until(() => app.store.data.scenes.some(s => s.name === "Test scene"), 3000, "scene not saved");
  await go("scenes"); await page.selectOption("#t-act", "off"); await page.fill("#t-time", "23:15"); await page.click("#t-add");
  await until(() => app.store.data.schedules.length === 1, 3000, "schedule not added"); await go("scenes");
  await page.click("[data-run]"); await until(() => !app.store.data.show.power, 3000, "schedule did not turn lights off");
  await page.click('[data-apply="party"]'); await until(() => app.store.data.show.power && app.store.data.show.style === "party", 3000, "scene did not apply"); await shot("08-scenes");
});
await step("settings: location, night mode, backup; a sunset schedule", async () => {
  await go("settings"); await page.fill("#l-lat", "19.076"); await page.fill("#l-lon", "72.8777"); await page.click("#l-save");
  await until(() => app.store.data.settings.location?.lat === 19.076, 3000, "location not saved");
  await go("settings"); await page.check("#n-on"); await until(() => app.store.data.settings.night.enabled, 3000, "night mode not saved");
  await go("settings"); await page.selectOption("#x-src", "clock"); await until(() => app.store.data.settings.text.source === "clock", 3000, "text source not saved");
  const dl = page.waitForEvent("download"); await page.click("#b-down"); const f = await dl; ok(/tempolight-backup/.test(f.suggestedFilename()), "no backup download");
  await go("settings"); await page.uncheck("#n-on"); await sleep(300);
  await go("scenes"); await page.selectOption("#t-kind", "sunset"); await page.fill("#t-off", "-15"); await page.selectOption("#t-act", "on"); await page.click("#t-add");
  await until(() => app.store.data.schedules.some(x => x.time === "sunset-15"), 3000, "sunset schedule not added"); await shot("08b-settings");
});
await step("settings: Apple Home on, setup code and QR code, reset pairing, off", async () => {
  await go("settings"); await page.waitForSelector("#hk-on"); await page.check("#hk-on");
  await until(() => app.store.data.settings.homekit.enabled && app.homekit.hap, 5000, "Apple Home not turned on");
  const code = await until(async () => { const t = await page.textContent("#hk-code"); return /^\d{3}-\d{2}-\d{3}$/.test(t || "") && await page.isVisible("#hk-code") ? t : null; }, 5000, "no setup code shown");
  ok(await page.$("#hk-qr svg"), "no QR code"); ok(code === (await app.core.handle("GET", "/api/homekit")).setupCode, "shown code isn't the bridge's");
  await page.click("#hk-reset"); await until(async () => { const t = await page.textContent("#hk-code"); return t && t !== code; }, 5000, "reset didn't show a new code"); await shot("08c-apple-home");
  await page.uncheck("#hk-on"); await until(() => !app.store.data.settings.homekit.enabled && !app.homekit.hap, 5000, "Apple Home not turned off");
});
await step("listen live with a microphone", async () => {
  await go("music"); await page.click("#m-stopsong"); await sleep(300); await page.click("#m-mic");
  await until(() => status().source === "browser" || status().sourceLabel.includes("quiet"), 8000, `mic not used as source (${status().sourceLabel})`);
  await page.click("#m-stop"); await sleep(1800); ok(status().source !== "browser", "still listening after stop");
});
await step("settings: lock with a PIN; a guest is locked out of devices; PIN unlocks", async () => {
  await go("settings"); await page.fill("#s-pin", "2468"); await page.click("#s-lock"); await until(() => !!app.store.data.lock, 3000, "not locked");
  const guest = await browser.newPage(); await guest.goto(`${base}/#/devices`); await guest.waitForSelector("#pin");
  const r = await fetch(`${base}/api/devices`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); ok(r.status === 403, "API not locked");
  await guest.goto(`${base}/#/live`); await guest.waitForSelector('[data-pad="flash"]'); ok(!(await guest.isDisabled('[data-pad="flash"]')), "guest can't use pads");
  await guest.goto(`${base}/#/devices`); await guest.fill("#pin", "2468"); await guest.click("#unlock"); await guest.waitForSelector("#d-add"); await guest.close();
  await go("settings"); await page.click("#s-unlockset"); await until(() => !app.store.data.lock, 3000, "PIN not removed");
});
await step("power off sends black, power on resumes", async () => {
  await page.click("#power"); await until(() => !app.store.data.show.power, 3000, "power not off"); await sleep(300); ok(lum(A) === 0, "LEDs not off");
  await page.click("#power"); await until(() => app.store.data.show.power, 3000, "power not on"); await sleep(600); ok(lum(A) > 0, "LEDs not back on");
});
await step("music: your own music: add a folder, its songs are analysed and listed with tempo, key and look", async () => {
  const { encodeWav } = await import("../packages/server/src/audiofile.js"), { edm } = await import("../packages/engine/test/synth.js"), fs = await import("node:fs");
  const music = mkdtempSync(path.join(os.tmpdir(), "tempolight-e2e-music-")); fs.writeFileSync(path.join(music, "E2E Crew - Folder Anthem.wav"), encodeWav(edm(22050).x, 22050));
  await go("music"); await page.waitForSelector("#lib-path");
  await page.fill("#lib-path", music); await page.click("#lib-add");
  await until(async () => /Folder Anthem/.test(await page.textContent("#lib-songs")), 60000, "the song never showed up");
  const row = await page.textContent("#lib-songs"); ok(/128/.test(row), `no tempo in “${row}”`);
  ok(/song ready/.test(await page.textContent("#lib-sub")), "no count"); ok((await page.textContent("#lib-folders")).includes(music.split(path.sep).pop()), "folder not listed");
  await shot("08b-library"); rmSync(music, { recursive: true, force: true }); // (a refused path is tested in library.test.js: here it would be a console error)
});
await step("phone-sized screen has no sideways scrolling", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const h of ["home", "music", "live", "room", "devices", `timeline/${app.store.data.songs[0]?.id}`]) { await go(h); const w = await page.evaluate(() => document.documentElement.scrollWidth); ok(w <= 392, `${h} is ${w}px wide`); }
  await shot("09-phone");
});
await step("devices: the latency meter shows a delay per controller", async () => {
  await page.setViewportSize({ width: 1400, height: 950 }); await go("devices");
  await until(async () => (await page.$$("#d-lat .latrow")).length >= 2, 4000, "no latency rows");
  await until(async () => /\d+ ms/.test(await page.textContent("#d-lat")), 12000, "no delay shown");
  ok((await page.$$("#d-rows .lat")).length === 2, "no delay column"); ok(status().devices.every(d => typeof d.latencyMs === "number" && Array.isArray(d.warnings)), "status has no latency");
  A.override.wifi = { signal: 20 }; await fetch(`${base}/api/devices/${app.store.data.devices[0].id}/check`, { method: "POST" });
  await until(async () => /Very weak Wi-Fi/.test(await page.textContent("#d-lat")), 4000, "weak Wi-Fi not shown"); A.override = {};
  await go("home"); await until(async () => /Delay|warning/.test(await page.textContent("#h-lat")), 4000, "no latency badge on Home"); await shot("09b-latency");
});
await step("integrations: a game on, its config file, a Try button; the OBS browser source draws the lights", async () => {
  await go("integrations"); await page.waitForSelector('[data-game="cs2"]'); ok(await page.isVisible("#sd-dl"), "no Stream Deck download");
  await page.check('[data-game="cs2"] [data-g="enabled"]'); await until(() => app.store.data.integrations.games.cs2.enabled, 3000, "CS2 not turned on");
  await page.waitForSelector('[data-try="cs2:flash"]:not([disabled])');
  const dl = page.waitForEvent("download"); await page.click('[data-cfg="cs2"]'); const f = await dl; ok(f.suggestedFilename() === "gamestate_integration_tempolight.cfg", `config file is ${f.suggestedFilename()}`);
  await page.click('[data-try="cs2:flash"]'); await until(() => app.integrations.games.state.cs2.flashed === 1, 3000, "flashbang not tried");
  await until(() => { const f = A.lastFrame, mx = Math.max(f[0], f[1], f[2]); return mx > 5 && Math.min(f[0], f[1], f[2]) / mx > 0.6; }, 3000, "the lights didn't go white"); // (white-ish: a power limit earlier may have dimmed them)
  await page.uncheck('[data-game="cs2"] [data-g="enabled"]'); await until(() => !app.store.data.integrations.games.cs2.enabled, 3000, "CS2 not turned off");
  ok(/\/obs$/.test(await page.textContent("#bs-url")), "no browser source address"); await shot("09c-integrations");
  await page.setViewportSize({ width: 390, height: 844 }); await go("integrations"); await page.waitForSelector('[data-game="cs2"]'); const w = await page.evaluate(() => document.documentElement.scrollWidth); ok(w <= 392, `integrations is ${w}px wide`); await page.setViewportSize({ width: 1400, height: 950 });
  const o = await ctx.newPage(); o.on("pageerror", e => errors.push("obs: " + e.message)); await o.goto(`${base}/obs`); await o.waitForSelector("#stage canvas");
  ok(await o.evaluate(() => getComputedStyle(document.body).backgroundColor) === "rgba(0, 0, 0, 0)", "the browser source isn't transparent");
  await until(() => o.evaluate(() => { const c = document.querySelector("#stage canvas"), d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let s = 0; for (let i = 0; i < d.length; i += 4 * 97) s += d[i] + d[i + 1] + d[i + 2]; return s > 0; }), 6000, "the browser source draws nothing");
  await o.close();
});
await step("setup wizard on a fresh start, phone-sized: lights, room, hearing, timing, test song, PIN, done", async () => {
  const dir2 = mkdtempSync(path.join(os.tmpdir(), "tempolight-e2e-wz-")), app2 = await createApp({ dataDir: dir2, discover: false, logger: null });
  const base2 = `http://127.0.0.1:${await app2.listen(0, "127.0.0.1")}`, c2 = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ["microphone"] }), p = await c2.newPage();
  p.on("pageerror", e => errors.push("wizard: " + e.message)); p.on("console", m => { if (m.type() === "error") errors.push("wizard: " + m.text()); });
  const wide = async where => { const w = await p.evaluate(() => document.documentElement.scrollWidth); ok(w <= 392, `wizard ${where} is ${w}px wide`); };
  const dot = () => p.$eval(".wz-dots li[aria-current]", li => Number(li.dataset.dot));
  try {
    await p.goto(base2 + "/"); await p.waitForSelector("#wizard"); ok(await dot() === 0, "doesn't start at step 1"); await wide("step 1");
    ok(await p.isDisabled("#wz-next"), "Next works with no lights yet");
    await p.click("#wz-virtual"); await until(() => app2.store.data.devices.some(d => d.virtual), 4000, "no virtual device");
    await until(async () => await dot() === 1, 3000, "didn't move on to the room"); await p.waitForSelector("[data-wzp] canvas"); await wide("step 2");
    ok((await p.$$("[data-wzp] canvas")).length >= 8, "no preset pictures");
    await p.click('[data-wzp="tv"]'); await until(() => app2.store.data.room.shapes.some(sh => /TV/i.test(sh.name)), 4000, "room preset not used");
    await p.click("#wz-next"); ok(await dot() === 2, "not on the hearing step"); await p.waitForSelector('#wz-hear [data-hc="computer"]'); ok(await p.isVisible('#wz-hear [data-hc="mic"]') && await p.isVisible('#wz-hear [data-hc="pi"]'), "the three ways to hear music aren't shown");
    await until(async () => (await p.textContent("#wz-hear #hr-detail")).trim().length > 20, 5000, "nothing about this computer"); await wide("hearing step");
    await p.click("#wz-next"); ok(await dot() === 3, "not on the timing step"); ok(await p.isVisible("#wz-cal"), "no timing button");
    await p.click("#wz-back"); ok(await dot() === 2, "Back doesn't go back"); await p.click("#wz-next"); await p.click("#wz-skip");
    ok(await dot() === 4, "Skip didn't skip the timing"); await p.waitForSelector("#wz-stage canvas"); await p.click("#wz-play");
    await until(() => app2.runtime.status().source === "song", 60000, "the test song never played"); await wide("step 4");
    await until(async () => /BPM/.test(await p.textContent("#wz-songmeta")), 5000, "no tempo shown");
    await p.click("#wz-next"); ok(await dot() === 5, "not on the last step"); await p.fill("#wz-pin", "4321"); await p.click("#wz-lock");
    await until(() => !!app2.store.data.lock, 3000, "PIN not set"); await p.click("#wz-next");
    await until(async () => !(await p.$("#wizard")), 3000, "wizard didn't close"); ok(app2.store.data.settings.setupDone === true, "setupDone not set");
    await p.reload(); await p.waitForSelector("#page .panel"); await sleep(500); ok(!(await p.$("#wizard")), "wizard came back after finishing");
    await p.goto(base2 + "/#/settings"); await p.waitForSelector("#s-wizard"); await p.click("#s-wizard"); await p.waitForSelector("#wizard");
    ok(/ready/.test(await p.textContent("#wz-have")), "the added lights aren't shown when running setup again"); await p.click("#wz-close");
  } finally { await c2.close(); await app2.close(); rmSync(dir2, { recursive: true, force: true }); }
});
await step("music: How should Tempolight hear your music? on a pretend Mac: BlackHole checklist, turn on, it hears, status line and Fix, Bluetooth timing, microphone", async () => {
  // a Mac that has no BlackHole yet, then has it with a Multi-Output Device and a Bluetooth speaker (fake ffmpeg and system_profiler);
  // the "BlackHole 2ch" input is a Node process writing a sine wave
  const fx = f => readFileSync(path.join(root, "packages/server/test/fixtures/hearing", f), "utf8"), mac = { avf: "none", profile: "speakers" };
  const runner = { async run(cmd) { if (cmd === "ffmpeg") return { code: 1, stdout: "", stderr: fx(`ffmpeg-avf-${mac.avf}.txt`) }; if (cmd === "system_profiler") return { code: 0, stdout: fx(`system-profiler-${mac.profile}.json`), stderr: "" }; return { code: 127, stdout: "", stderr: "", missing: true }; } };
  const sine = [process.execPath, "-e", 'const n=1103,b=Buffer.alloc(n*2);let t=0;process.stdout.on("error",()=>process.exit(0));setInterval(()=>{for(let i=0;i<n;i++,t++)b.writeInt16LE(Math.round(9000*Math.sin(t*0.0627)),i*2);process.stdout.write(b)},50)'];
  const dir3 = mkdtempSync(path.join(os.tmpdir(), "tempolight-e2e-hear-")), app3 = await createApp({ dataDir: dir3, discover: false, logger: null, homekit: { mdns: false, host: "127.0.0.1" },
    hearing: { platform: "darwin", runner, interval: 300, listSources: () => [], commandFor: id => /BlackHole 2ch/.test(id) ? sine : false } });
  app3.store.data.settings.setupDone = true; // (no wizard over the page)
  const base3 = `http://127.0.0.1:${await app3.listen(0, "127.0.0.1")}`, p = await ctx.newPage(), st3 = () => app3.runtime.status();
  p.on("pageerror", e => errors.push("hearing: " + e.message)); p.on("console", m => { if (m.type() === "error") errors.push("hearing: " + m.text()); });
  const li = id => p.getAttribute(`#hr-steps li[data-step="${id}"]`, "class");
  try {
    await p.goto(base3 + "/#/music/hear"); await p.waitForSelector('#hear [data-hc="computer"]');
    ok(await p.textContent("#hear h2") === "How should Tempolight hear your music?", "no panel title"); ok(await p.isVisible('[data-rec="computer"]'), "This computer's sound isn't recommended on a Mac");
    ok(await p.$eval("#hear", el => el.getBoundingClientRect().top < 200), "the panel isn't at the top of the Music page");
    await until(async () => await li("blackhole") === "no", 5000, "BlackHole not shown as missing"); ok(/brew install blackhole-2ch/.test(await p.textContent("#hr-steps")), "no install command");
    ok(/existential\.audio\/blackhole/.test(await p.innerHTML("#hr-steps")), "no download link"); ok(await p.isDisabled("#hr-use"), "can turn it on without BlackHole");
    ok(/Multi-Output Device/.test(await p.textContent(".hear-midi")) && /Drift Correction/.test(await p.textContent(".hear-midi")), "no Audio MIDI Setup steps");
    mac.avf = "blackhole"; mac.profile = "multi-bt"; await p.click("#hr-check");
    await until(async () => await li("blackhole") === "ok", 5000, "BlackHole not ticked"); ok(await li("output") === "maybe", "the Multi-Output Device isn't 'confirm by listening'");
    await p.click("#hr-use"); await until(() => app3.store.data.settings.capture.enabled && app3.store.data.settings.capture.source === "avf:BlackHole 2ch", 4000, "server capture not turned on from BlackHole");
    await until(async () => await li("hears") === "ok" && await li("output") === "ok", 8000, "Tempolight hears it isn't ticked");
    await until(async () => /Hearing .*✓/.test(await p.textContent("#hr-line")), 4000, "no 'Hearing ✓' line"); ok(await p.isVisible("text=Listening to BlackHole 2ch on the server"), "not shown as on");
    await until(() => st3().hearing.output?.bluetooth === true, 4000, "the Bluetooth speaker isn't seen");
    await until(() => p.isVisible("#hr-bt"), 3000, "no Bluetooth timing prompt"); ok(/Bluetooth speakers play late/.test(await p.textContent("#hr-bt")), "prompt text"); ok(await p.isVisible("#m-btcal"), "no prompt in Timing");
    await p.evaluate(() => fetch("/api/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ syncOffsetMs: -180 }) }));
    await until(async () => !(await p.isVisible("#hr-bt")), 4000, "the prompt stays after the speaker got its timing"); await until(async () => /JBL Flip 5/.test(await p.textContent("#m-offrows")), 4000, "the speaker's timing isn't listed");
    ok(app3.store.data.settings.syncOffsets["mac:Multi-Output Device + JBL Flip 5"].ms === -180 && app3.store.data.settings.syncOffsetMs === 0, "timing not kept per speaker");
    app3.runtime.rt.nowPlaying = { info: () => ({ app: "Spotify", title: "One More Time", artist: "Daft Punk", playing: true, pos: 10, dur: 320 }), follow: () => null, memId: null }; // Spotify plays a song Tempolight doesn't know
    await until(async () => /Hearing Spotify ✓ · One More Time/.test(await p.textContent("#hr-line")), 4000, "no 'Hearing Spotify ✓ · song' line");
    await p.click("#hr-off"); await until(() => !app3.store.data.settings.capture.enabled, 3000, "capture not stopped");
    await p.goto(base3 + "/#/home"); await p.waitForSelector("#h-hear");
    await until(async () => /Can't hear anything/.test(await p.textContent("#h-hear")), 6000, "Home doesn't say it can't hear anything"); await p.click("#h-hear .hear-fix");
    await until(() => p.isVisible('#hear [data-hc="computer"]'), 4000, "Fix doesn't open the panel"); ok(/#\/music\/hear$/.test(p.url()), "Fix goes elsewhere: " + p.url());
    await p.click('[data-hc="mic"]'); await p.waitForSelector("#hr-mic"); ok(/keep this tab open/i.test(await p.textContent("#hr-detail")), "doesn't say the tab must stay open"); await p.click("#hr-mic");
    await until(() => app3.store.data.settings.hearing.method === "mic", 3000, "the microphone isn't remembered on the server"); ok(await p.evaluate(() => localStorage.getItem("tl.hear")) === "mic", "not remembered in this browser");
    await until(() => st3().hearing.via === "browser", 5000, "the microphone isn't heard");
    await p.evaluate(async () => { const { app } = await import("/app.js"); app.audio.stopLive(); }); await until(() => st3().hearing.via === null, 4000, "still hearing after stopping");
    await p.reload(); await p.waitForSelector("#hear"); await until(() => st3().hearing.via === "browser", 8000, "the microphone doesn't start by itself while Spotify plays an unlearned song");
  } finally { await p.close(); await app3.close(); rmSync(dir3, { recursive: true, force: true }); }
});
await step("no errors in the browser console", async () => ok(!errors.length, errors.slice(0, 5).join(" | ")));

await browser.close(); await app.close(); A.close(); B.close(); rmSync(dataDir, { recursive: true, force: true });
console.log(results.join("\n")); console.log(failed ? `\n${failed} failed` : "\nall passed"); process.exit(failed ? 1 : 0);
