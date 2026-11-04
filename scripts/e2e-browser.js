#!/usr/bin/env node
// End-to-end test in a real browser (needs Playwright: npm i -g playwright && npx playwright install chromium).
// Starts two pretend WLED controllers and a Tempolight server, then clicks through every page like a user:
// add devices, lay out the room, play a song, listen to a microphone, live pads, effects, scenes, schedules, lock.
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../packages/server/src/app.js";
import { startFakeWled } from "./fake-wled.js";

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
const app = await createApp({ dataDir, discover: false, logger: null });
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

await step("first start shows the welcome card", async () => { await go("home"); ok(await page.isVisible("text=Welcome to Tempolight"), "no welcome card"); await shot("01-welcome"); });
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
});
await step("music: the song is remembered in song memory", async () => {
  await until(() => page.textContent("#m-songs").then(t => /BPM/.test(t)), 6000, "song not in the memory list");
  ok(app.store.data.songs.length === 1, "not stored");
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
await step("phone-sized screen has no sideways scrolling", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const h of ["home", "music", "live", "room", "devices", `timeline/${app.store.data.songs[0]?.id}`]) { await go(h); const w = await page.evaluate(() => document.documentElement.scrollWidth); ok(w <= 392, `${h} is ${w}px wide`); }
  await shot("09-phone");
});
await step("no errors in the browser console", async () => ok(!errors.length, errors.slice(0, 5).join(" | ")));

await browser.close(); await app.close(); A.close(); B.close(); rmSync(dataDir, { recursive: true, force: true });
console.log(results.join("\n")); console.log(failed ? `\n${failed} failed` : "\nall passed"); process.exit(failed ? 1 : 0);
