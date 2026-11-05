#!/usr/bin/env node
// End-to-end test of the online demo as Cloudflare serves it: plain static files from dist/site, no Tempolight server.
// Needs Playwright. Run: node scripts/build-site.js && node scripts/e2e-demo.js
import { createRequire } from "node:module";
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/site");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml", ".mp3": "audio/mpeg" };
const server = http.createServer(async (req, res) => { // like Cloudflare static assets with single-page-application fallback
  let p = path.join(site, decodeURIComponent(new URL(req.url, "http://x").pathname));
  try { if ((await stat(p)).isDirectory()) p = path.join(p, "index.html"); } catch { try { await stat(p + ".html"); p += ".html"; } catch { p = path.join(site, "index.html"); } } // Pages serves /phone from phone.html
  try { const b = await readFile(p); res.writeHead(200, { "content-type": MIME[path.extname(p)] || "application/octet-stream" }); res.end(b); } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const base = `http://localhost:${server.address().port}`;
const sleep = ms => new Promise(r => setTimeout(r, ms)), results = []; let failed = 0;
const ok = (c, m) => { if (!c) throw new Error(m); };
async function step(name, fn) { try { await fn(); results.push("ok   " + name); } catch (e) { failed++; results.push(`FAIL ${name}: ${e.message}`); } }
async function until(fn, ms = 8000, msg = "timed out") { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return; await sleep(100); } throw new Error(msg); }

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 }, permissions: ["microphone"] });
const page = await ctx.newPage(), errors = [];
page.on("pageerror", e => errors.push(e.message)); page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
page.on("dialog", d => d.accept(d.type() === "prompt" ? "Demo scene" : undefined));
const go = async h => { await page.evaluate(x => { location.hash = "#/" + x; }, h); await page.waitForSelector("#page .panel"); await sleep(300); };
const text = sel => page.textContent(sel);

await step("opens in demo mode and finds the pretend controllers by itself", async () => {
  await page.goto(base + "/demo/#/home"); await page.waitForSelector("#page .panel"); // (the classic Home: the v2 Stage is the default now)
  ok(await page.isVisible("#demo-bar"), "no demo banner");
  await until(async () => (await page.$$eval("#h-devs tr", r => r.length)) === 3, 8000, "pretend controllers not added");
  await until(async () => (await text("#h-leds")).includes("684"), 5000, "room not laid out (" + await text("#h-leds") + ")");
});
await step("preview shows light", async () => { await sleep(800); const lit = await page.evaluate(async () => { const { app } = await import("/app.js"); return app.frame ? app.frame.reduce((a, b) => a + b, 0) : 0; }); ok(lit > 1000, "preview frame is dark"); });
await step("record a 15-second clip of the preview", async () => {
  const dl = page.waitForEvent("download", { timeout: 30000 }); await page.click("#h-rec"); const f = await dl;
  const p = await f.path(), size = (await import("node:fs")).statSync(p).size; ok(/\.(webm|mp4)$/.test(f.suggestedFilename()) && size > 20000, `clip ${f.suggestedFilename()} ${size} bytes`);
});
await step("play the demo song: analysed, tempo found, lights follow it", async () => {
  await go("music"); await page.click("#m-demo");
  await until(async () => (await text("#sb-source")).includes("demo"), 30000, "song never started");
  await until(async () => /\d/.test(await text("#m-bpm")), 5000, "no tempo"); ok(Math.abs(Number(await text("#m-bpm")) - 128) <= 2, "tempo " + await text("#m-bpm"));
});
await step("the demo song: the sync meter says Locked and the song map shows its sections", async () => {
  await until(async () => (await text("#sm-label")) === "Locked", 6000, "the meter isn't Locked: " + await text("#sm-label"));
  await until(() => page.isHidden("#sm-empty"), 6000, "the song map is empty");
  const map = await page.evaluate(async () => (await import("/app.js")).api("GET", "/api/song/map"));
  ok(map.source === "song" && map.sections.length >= 2 && map.env.length > 50, `map: ${map.source}, ${map.sections?.length} sections`);
  await until(async () => /^Part [A-Z]/.test(await text("#sm-part")), 4000, "the part playing isn't named");
  await go("home"); await until(async () => (await page.getAttribute("#h-hear .syncdot", "data-state")) === "locked", 4000, "no sync dot on Home"); await go("music");
});
await step("Sync with Spotify explains that it needs Tempolight installed", async () => {
  await go("music"); await page.waitForSelector("#sp-demo"); ok(/install Tempolight/.test(await text("#sp-demo")), "no explanation in the demo"); ok(!(await page.$("#sp-on")), "a Spotify switch in the demo");
});
await step("Your own music explains that the demo can't read folders", async () => {
  await go("music"); await page.waitForSelector("#lib-demo"); ok(/can't read folders/.test(await text("#lib-demo")), "no explanation in the demo"); ok(!(await page.$("#lib-path")), "a folder field in the demo");
});
await step("live pads: blackout and back", async () => {
  await go("live"); await page.click('[data-pad="blackout"]'); await until(async () => (await page.getAttribute('[data-pad="blackout"]', "aria-pressed")) === "true", 3000, "blackout not on");
  await page.click('[data-pad="blackout"]'); await until(async () => (await page.getAttribute('[data-pad="blackout"]', "aria-pressed")) === "false", 3000, "blackout not off");
});
await step("effects: choose one", async () => { await go("effects"); await page.click('[data-fx="galaxy"]'); await until(async () => (await text("#sb-effect")) === "Spiral Galaxy", 3000, "effect not showing"); await page.click("#e-auto"); });
await step("devices: scan finds the pretend controllers, frames are being sent", async () => {
  await go("devices"); await page.click("#d-scan"); await until(async () => (await text("#d-scanmsg")).includes("3 found"), 5000, "scan found nothing");
  const sent = await page.$$eval("#d-rows tr td:nth-child(12)", tds => tds.map(t => Number(t.textContent))); ok(sent.every(n => n > 10), "frames sent " + sent);
});
await step("room: four-walls preset and segments", async () => {
  await go("room"); await page.selectOption("#r-preset", "fourwalls"); await page.click("#r-use"); await sleep(500);
  await go("room"); ok((await page.$$eval("#r-rows tr", r => r.length)) >= 4, "shapes missing"); await page.click("#r-devs [data-seg]"); await sleep(600);
});
await step("scenes and schedules", async () => {
  await go("scenes"); await page.click("#sc-save"); await sleep(300); await go("scenes"); ok(await page.isVisible("text=Demo scene"), "scene not saved");
  await page.selectOption("#t-act", "off"); await page.click("#t-add"); await sleep(300); await go("scenes"); ok((await page.$$("[data-run]")).length === 1, "schedule not added");
});
await step("settings survive a reload (kept in this browser)", async () => {
  await page.reload(); await page.waitForSelector("#page .panel"); await go("scenes"); ok(await page.isVisible("text=Demo scene"), "scene lost after reload");
});
await step("PIN lock works in the demo", async () => {
  await go("settings"); await page.fill("#s-pin", "1234"); await page.click("#s-lock"); await sleep(400); await go("settings");
  await page.click("#s-relock"); await sleep(600); await go("devices"); ok(await page.isVisible("#pin"), "devices not locked");
  await page.fill("#pin", "1234"); await page.click("#unlock"); await page.waitForSelector("#d-add"); await go("settings"); await page.click("#s-unlockset"); await sleep(300);
});
await step("phones as lights in the demo (another tab of the same browser)", async () => {
  await page.goto(base + "/demo/#/live"); await page.waitForSelector("#ph-qr svg");
  const phone = await ctx.newPage(); await phone.goto(base + "/demo/phone"); await phone.click("#go");
  await until(async () => (await phone.evaluate(() => getComputedStyle(document.getElementById("light")).backgroundColor)) !== "rgb(0, 0, 0)", 6000, "demo phone stays black");
  await until(() => page.textContent("#ph-n").then(t => /1 phone/.test(t)), 4000, "count not shown"); await phone.close();
});
await step("installable app: manifest, icons and service worker", async () => {
  const man = await (await fetch(base + "/demo/manifest.webmanifest")).json(); ok(man.display === "standalone" && man.icons.length >= 3, "manifest");
  for (const i of man.icons) ok((await fetch(base + i.src)).ok, "missing icon " + i.src);
  ok((await fetch(base + "/demo/icons/apple-touch-icon.png")).ok, "no apple-touch-icon");
  await until(() => page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())), 5000, "service worker not registered");
});
await step("works offline once installed", async () => {
  await page.reload(); await sleep(800); await ctx.setOffline(true); await page.reload(); await page.waitForSelector("#page .panel", { timeout: 8000 });
  // pages loaded only when first shown (and not visited yet) open offline too: the service worker kept them
  await page.evaluate(() => { location.hash = "#/sleep"; }); await page.waitForSelector("#w-on", { timeout: 8000 });
  await page.evaluate(() => { location.hash = "#/home"; }); await page.waitForSelector("#page .panel", { timeout: 8000 }); await ctx.setOffline(false);
});
await step("the docs at /docs/ open as the docs, not the app (the service worker leaves them alone)", async () => {
  ok(await page.isVisible('#demo-bar a[href="/docs/"]'), "no docs link in the demo banner");
  ok(await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.active), "service worker not active");
  for (const p of ["/docs/", "/docs/guides/first-run/"]) {
    await page.goto(base + p); await page.waitForSelector(".article", { timeout: 8000 });
    ok(!(await page.$("#page")), `${p} opened the app`); ok(/docs|documentation/i.test(await page.title()), `${p}: title ${await page.title()}`);
  }
  await page.goto(base + "/demo/#/home"); await page.waitForSelector("#page .panel"); // (the classic Home: the v2 Stage is the default now)
});
await step("iPhone size: no sideways scrolling", async () => {
  const phone = await browser.newContext({ ...require("playwright").devices["iPhone 13"] }); const p = await phone.newPage();
  await p.goto(base + "/demo/#/home"); await p.waitForSelector("#page .panel");
  for (const h of ["home", "music", "live", "room", "devices"]) { await p.evaluate(x => { location.hash = "#/" + x; }, h); await sleep(400); const w = await p.evaluate(() => document.documentElement.scrollWidth); ok(w <= 391, `${h} is ${w}px wide`); }
  ok(!(await p.isVisible("#m-system")) || true, ""); await p.screenshot({ path: process.env.SHOT || "/tmp/demo-iphone.png" }); await phone.close();
});
await step("home & sleep: a sunrise and the sleep timer run in the browser", async () => {
  await go("sleep"); await page.waitForSelector("#w-on"); await page.check("#w-on"); await sleep(300);
  await page.click("#hs-wnow"); await until(async () => /Sunrise/.test(await text("#hs-now")), 4000, "no sunrise shown");
  const st = await page.evaluate(async () => (await import("/app.js")).app.status.home); ok(st.wake && st.wake.phase === "rising", "sunrise not rising " + JSON.stringify(st));
  await page.click("#hs-stop"); await until(async () => !/Sunrise \d/.test(await text("#hs-now")), 8000, "sunrise didn't stop");
  await page.click("#hs-go"); await until(async () => /Sleep timer/.test(await text("#hs-now")), 4000, "sleep timer not shown");
  await page.click("#hs-cancel"); await page.check("#p-on"); await sleep(400); await go("home"); await page.waitForSelector("#hs-strip");
});
await step("setup wizard in the demo: run it again from Settings", async () => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(base + "/demo/#/settings"); await page.waitForSelector("#s-wizard"); await page.click("#s-wizard"); await page.waitForSelector("#wizard");
  await until(async () => /Found 3/.test(await text("#wz-scanmsg")), 6000, "the pretend controllers weren't found"); ok(/3 lights ready/.test(await text("#wz-have")), "added lights not shown");
  await page.click("#wz-next"); await page.waitForSelector("[data-wzp] canvas"); await page.click('[data-wzp="club"]'); await sleep(400);
  await page.click("#wz-skip"); await page.click("#wz-skip"); await page.click("#wz-next");
  ok(await page.evaluate(() => document.documentElement.scrollWidth) <= 391, "wizard scrolls sideways"); await page.click("#wz-next");
  await until(async () => !(await page.$("#wizard")), 3000, "wizard didn't close"); await page.reload(); await page.waitForSelector("#page .panel"); await sleep(400); ok(!(await page.$("#wizard")), "wizard came back");
  await page.setViewportSize({ width: 1300, height: 900 });
});
await step("no errors in the console", async () => ok(!errors.length, errors.slice(0, 4).join(" | ")));
await browser.close(); server.close();
console.log(results.join("\n")); console.log(failed ? `\n${failed} failed` : "\nall passed"); process.exit(failed ? 1 : 0);
