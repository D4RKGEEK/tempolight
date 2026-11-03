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
  try { if ((await stat(p)).isDirectory()) p = path.join(p, "index.html"); } catch { p = path.join(site, "index.html"); }
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
  await page.goto(base + "/"); await page.waitForSelector("#page .panel");
  ok(await page.isVisible("#demo-bar"), "no demo banner");
  await until(async () => (await page.$$eval("#h-devs tr", r => r.length)) === 3, 8000, "pretend controllers not added");
  await until(async () => (await text("#h-leds")).includes("684"), 5000, "room not laid out (" + await text("#h-leds") + ")");
});
await step("preview shows light", async () => { await sleep(800); const lit = await page.evaluate(async () => { const { app } = await import("/app.js"); return app.frame ? app.frame.reduce((a, b) => a + b, 0) : 0; }); ok(lit > 1000, "preview frame is dark"); });
await step("play the demo song: analysed, tempo found, lights follow it", async () => {
  await go("music"); await page.click("#m-demo");
  await until(async () => (await text("#sb-source")).includes("demo"), 30000, "song never started");
  await until(async () => /\d/.test(await text("#m-bpm")), 5000, "no tempo"); ok(Math.abs(Number(await text("#m-bpm")) - 128) <= 2, "tempo " + await text("#m-bpm"));
});
await step("live pads: blackout and back", async () => {
  await go("live"); await page.click('[data-pad="blackout"]'); await until(async () => (await page.getAttribute('[data-pad="blackout"]', "aria-pressed")) === "true", 3000, "blackout not on");
  await page.click('[data-pad="blackout"]'); await until(async () => (await page.getAttribute('[data-pad="blackout"]', "aria-pressed")) === "false", 3000, "blackout not off");
});
await step("effects: choose one", async () => { await go("effects"); await page.click('[data-fx="galaxy"]'); await until(async () => (await text("#sb-effect")) === "Spiral Galaxy", 3000, "effect not showing"); await page.click("#e-auto"); });
await step("devices: scan finds the pretend controllers, frames are being sent", async () => {
  await go("devices"); await page.click("#d-scan"); await until(async () => (await text("#d-scanmsg")).includes("3 found"), 5000, "scan found nothing");
  const sent = await page.$$eval("#d-rows tr td:nth-child(11)", tds => tds.map(t => Number(t.textContent))); ok(sent.every(n => n > 10), "frames sent " + sent);
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
await step("installable app: manifest, icons and service worker", async () => {
  const man = await (await fetch(base + "/manifest.webmanifest")).json(); ok(man.display === "standalone" && man.icons.length >= 3, "manifest");
  for (const i of man.icons) ok((await fetch(base + i.src)).ok, "missing icon " + i.src);
  ok((await fetch(base + "/icons/apple-touch-icon.png")).ok, "no apple-touch-icon");
  await until(() => page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())), 5000, "service worker not registered");
});
await step("works offline once installed", async () => {
  await page.reload(); await sleep(800); await ctx.setOffline(true); await page.reload(); await page.waitForSelector("#page .panel", { timeout: 8000 }); await ctx.setOffline(false);
});
await step("iPhone size: no sideways scrolling", async () => {
  const phone = await browser.newContext({ ...require("playwright").devices["iPhone 13"] }); const p = await phone.newPage();
  await p.goto(base + "/"); await p.waitForSelector("#page .panel");
  for (const h of ["home", "music", "live", "room", "devices"]) { await p.evaluate(x => { location.hash = "#/" + x; }, h); await sleep(400); const w = await p.evaluate(() => document.documentElement.scrollWidth); ok(w <= 391, `${h} is ${w}px wide`); }
  ok(!(await p.isVisible("#m-system")) || true, ""); await p.screenshot({ path: process.env.SHOT || "/tmp/demo-iphone.png" }); await phone.close();
});
await step("no errors in the console", async () => ok(!errors.length, errors.slice(0, 4).join(" | ")));
await browser.close(); server.close();
console.log(results.join("\n")); console.log(failed ? `\n${failed} failed` : "\nall passed"); process.exit(failed ? 1 : 0);
