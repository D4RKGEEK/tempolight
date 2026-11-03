#!/usr/bin/env node
// Regenerates the screenshots in docs/images (needs Playwright): node scripts/screenshots.js
// Starts a server with a virtual living room, plays the demo track and photographs each page in dark and light themes.
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../packages/server/src/app.js";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), out = path.join(root, "docs/images");
mkdirSync(out, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dataDir = mkdtempSync(path.join(os.tmpdir(), "tempolight-shots-"));
const app = await createApp({ dataDir, discover: false, logger: null });
const base = `http://127.0.0.1:${await app.listen(0, "127.0.0.1")}`;
const post = (p, b) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b || {}) }).then(r => r.json());
await post("/api/devices", { virtual: true, name: "Living room", leds: 700 });
await post("/api/schedules", { name: "Chill evening", time: "19:00", days: [1, 2, 3, 4, 5], action: { type: "scene", scene: "chill" } });
await post("/api/schedules", { name: "Lights off", time: "01:00", action: { type: "off" } });

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
async function shoot(theme, viewport, pages) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme: theme });
  const page = await ctx.newPage();
  await page.goto(`${base}/#/music`); await page.waitForSelector("#m-demo");
  await page.click("#m-demo");
  for (let i = 0; i < 300 && app.runtime.status().source !== "song"; i++) await sleep(100);
  // jump into the first drop, so the pictures show the lights at full energy
  const st = app.runtime.status(), at = (st.song.drops[0] + 3) / st.song.dur;
  await page.waitForSelector("#m-prog"); const box = await page.locator("#m-prog").boundingBox();
  await page.mouse.click(box.x + box.width * at, box.y + box.height / 2);
  for (const [hash, name, wait = 1500] of pages) {
    await page.evaluate(h => { location.hash = "#/" + h; }, hash); await page.waitForSelector("#page .panel"); await sleep(wait); // hash change keeps the song playing
    await page.screenshot({ path: path.join(out, `${name}.png`) }); console.log("docs/images/" + name + ".png");
  }
  await ctx.close();
}
await shoot("dark", { width: 1440, height: 900 }, [["home", "home-dark", 1200], ["music", "music"], ["effects", "effects"], ["live", "live-pads"], ["room", "room"], ["scenes", "scenes"], ["devices", "devices"], ["settings", "settings"]]);
await shoot("light", { width: 1440, height: 900 }, [["home", "home-light", 1200]]);
await shoot("dark", { width: 390, height: 844 }, [["home", "phone-home", 1200], ["live", "phone-pads"]]);
await browser.close(); await app.close(); rmSync(dataDir, { recursive: true, force: true });
