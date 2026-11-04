#!/usr/bin/env node
// End-to-end test of the docs website (scripts/build-docs-site.js) in a real browser: builds it into a temporary folder,
// serves it like Cloudflare Pages does, and checks the landing page, the tabs and sidebar, every internal link and
// anchor, search, Mermaid, the API reference and its Try it panel, the themes, the 404 page and phone width.
// Needs Playwright. Run: node scripts/e2e-docs.js
// Mermaid comes from its CDN; set MERMAID_DIST to a local mermaid/dist folder to test without network.
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildDocs, serveDocs, MERMAID_URL } from "./build-docs-site.js";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const dir = mkdtempSync(path.join(os.tmpdir(), "tl-docs-")), t0 = Date.now();
const built = buildDocs({ out: dir, quiet: true }), buildMs = Date.now() - t0;
const server = await serveDocs(dir, 0), base = `http://127.0.0.1:${server.address().port}`;
const sleep = ms => new Promise(r => setTimeout(r, ms)), results = []; let failed = 0;
const ok = (c, m) => { if (!c) throw new Error(m); };
async function step(name, fn) { try { await fn(); results.push("ok   " + name); } catch (e) { failed++; results.push(`FAIL ${name}: ${e.message.split("\n")[0]}`); } }

const browser = await chromium.launch();
const mermaidDist = process.env.MERMAID_DIST || ["/opt/npm-tools/node_modules/mermaid/dist"].find(d => existsSync(path.join(d, "mermaid.esm.min.mjs")));
async function context(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark", ...opts });
  if (mermaidDist) await ctx.route(url => url.href.startsWith(MERMAID_URL.replace(/[^/]+$/, "")), r => {
    const f = path.join(mermaidDist, r.request().url().slice(MERMAID_URL.replace(/[^/]+$/, "").length)); r.fulfill(existsSync(f) ? { status: 200, contentType: "text/javascript", body: readFileSync(f) } : { status: 404 }); });
  return ctx;
}
const ctx = await context(), page = await ctx.newPage(), errors = [];
const watch = p => { p.on("pageerror", e => errors.push(`${p.url()}: ${e.message}`)); p.on("console", m => { if (m.type() === "error") errors.push(`${p.url()}: ${m.text()}`); }); };
watch(page);

await step(`builds quickly (${built.pages.length} pages in ${buildMs} ms) without warnings`, async () => {
  ok(buildMs < 10000, `took ${buildMs} ms`); ok(built.pages.length > 150, `${built.pages.length} pages`); ok(!built.warnings.length, built.warnings.slice(0, 3).join("; "));
});
await step("the landing page: hero, cards, tabs, sidebar", async () => {
  await page.goto(base + "/docs/"); await page.waitForSelector(".tl-hero");
  ok(/Lights that know the song/.test(await page.textContent(".tl-title")), "no hero title");
  ok((await page.$$(".tl-home .card")).length >= 16, "cards missing");
  ok((await page.$$(".tabs .tab")).length === 5, "tabs missing");
  ok((await page.textContent(".sidebar .nav-item.active")).includes("Home"), "Home not active");
  ok(await page.title() === "Tempolight documentation", "title " + await page.title());
  ok(await page.getAttribute('meta[property="og:image"]', "content"), "no OG image");
});
await step("tabs and the sidebar navigate", async () => {
  await page.click('.tabs .tab:has-text("Guides")'); await page.waitForURL(/\/docs\/guides\/overview\/$/);
  ok((await page.textContent(".tabs .tab.active")).includes("Guides"), "Guides tab not active");
  await page.click('.sidebar a.nav-item:has-text("Docker")'); await page.waitForURL(/\/docs\/guides\/docker\/$/);
  ok(/Docker/.test(await page.textContent(".page-head h1")), "Docker page not shown"); ok((await page.textContent(".sidebar .nav-item.active")).includes("Docker"), "Docker not active");
  await page.click(".pager-next"); await page.waitForURL(/\/docs\/raspberry-pi\/$/);
  await page.click('.tabs .tab:has-text("Reference")'); await page.waitForURL(/\/docs\/api\/$/);
  await page.click('.nav-sub summary a:has-text("Spotify")'); await page.waitForURL(/\/api-reference\/spotify\/$/);
  ok(await page.isVisible(".nav-sub[open] .nav-sub-items"), "the tag's operations aren't open in the sidebar");
  ok(/Edit on GitHub/.test(await page.textContent(".edit")), "no Edit on GitHub link");
});
await step("every internal link and anchor resolves (crawl)", async () => {
  const seen = new Map(), queue = ["/docs/", ...built.pages], bad = [];
  const fetchPage = async u => { if (!seen.has(u)) seen.set(u, fetch(base + u).then(async r => ({ status: r.status, html: (r.headers.get("content-type") || "").includes("html") ? await r.text() : "" }))); return seen.get(u); };
  for (let i = 0; i < queue.length; i++) {
    const from = queue[i], r = await fetchPage(from); if (r.status !== 200) { bad.push(`${from} -> ${r.status}`); continue; }
    for (const m of r.html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
      const href = m[1].replace(/&amp;/g, "&"); if (/^(https?:|mailto:|data:)/.test(href)) continue;
      const u = new URL(href, base + from); if (!u.pathname.startsWith("/docs")) { bad.push(`${from}: ${href} leaves the docs`); continue; }
      const target = await fetchPage(u.pathname + u.search.replace(/\?v=\w+$/, "")); if (target.status !== 200) { bad.push(`${from}: ${href} -> ${target.status}`); continue; }
      if (u.hash && u.hash.length > 1 && target.html && !target.html.includes(`id="${decodeURIComponent(u.hash.slice(1))}"`)) bad.push(`${from}: ${href} (no such anchor)`);
      if (target.html && !queue.includes(u.pathname)) queue.push(u.pathname);
    }
  }
  ok(!bad.length, `${bad.length} broken: ${bad.slice(0, 5).join(", ")}`);
  ok(seen.size > 200, `only ${seen.size} URLs checked`);
  const sitemap = await (await fetch(base + "/docs/sitemap.xml")).text(); ok((sitemap.match(/<loc>/g) || []).length === built.pages.length, "sitemap incomplete");
});
await step("search: Ctrl+K finds Spotify, Enter opens it", async () => {
  await page.goto(base + "/docs/install/"); await page.keyboard.press("Control+k"); await page.waitForSelector("[data-search-modal]:not([hidden])");
  await page.keyboard.type("spotify"); await page.waitForSelector(".search-hit");
  const titles = await page.$$eval(".search-hit .hit-title", h => h.map(x => x.textContent)); ok(titles.some(t => /Sync with Spotify/.test(t)), "no Sync with Spotify in " + titles.slice(0, 5));
  ok(/Spotify/i.test(titles[0]), "first hit " + titles[0]);
  await page.keyboard.press("Enter"); await page.waitForURL(/spotify/i); ok(await page.isHidden("[data-search-modal]"), "modal still open");
  await page.keyboard.press("/"); await page.waitForSelector("[data-search-modal]:not([hidden])"); await page.keyboard.type("put custom effects"); await page.waitForSelector(".search-hit .method");
  await page.keyboard.press("Escape"); ok(await page.isHidden("[data-search-modal]"), "Esc didn't close it");
  await page.click(".search-btn"); await page.waitForSelector("[data-search-modal]:not([hidden])"); await page.keyboard.type("zzqqxx"); await page.waitForSelector(".search-empty"); await page.keyboard.press("Escape");
});
await step("Mermaid diagrams render as SVG, and again after a theme switch", async () => {
  await page.goto(base + "/docs/guides/first-run/"); await page.waitForSelector("pre.mermaid svg", { timeout: 20000 });
  const fill = () => page.$eval("pre.mermaid svg .node rect, pre.mermaid svg .node polygon", n => getComputedStyle(n).fill);
  const dark = await fill(); await page.click("[data-theme-toggle]"); await sleep(300); await page.waitForSelector("pre.mermaid svg", { timeout: 20000 }); await sleep(500);
  ok(await page.evaluate(() => document.documentElement.dataset.theme) === "light", "theme didn't switch"); ok(await fill() !== dark, "diagram kept its dark colours");
  await page.reload(); ok(await page.evaluate(() => document.documentElement.dataset.theme) === "light", "theme not remembered");
  await page.click("[data-theme-toggle]");
});
await step("an API page: method, fields, code samples in three languages, example responses", async () => {
  await page.goto(base + "/docs/api-reference/your-own-effects/change-an-effect/"); await page.waitForSelector(".op");
  ok((await page.textContent(".endpoint")).includes("/api/custom-effects/{id}"), "no path"); ok((await page.textContent(".endpoint .method")) === "PUT", "no method");
  ok((await page.$$(".op-main .field")).length > 5, "no body fields"); ok(await page.isVisible("text=Path parameters"), "no path parameters");
  const sample = () => page.$eval(".op-aside .code-group pre:not([hidden])", p => p.textContent);
  ok(/curl -X PUT 'http:\/\/localhost:8080\/api\/custom-effects\/u-k3j9q2'/.test(await sample()), "curl sample: " + (await sample()).slice(0, 80));
  await page.click('.op-aside [role=tab]:has-text("JavaScript")'); ok(/await fetch\(/.test(await sample()), "no fetch sample");
  await page.click('.op-aside [role=tab]:has-text("Python")'); ok(/requests\.put\(/.test(await sample()) && /"colors": \[/.test(await sample()), "no Python sample");
  await page.click('.op-aside [role=tab]:has-text("cURL")');
  ok((await page.$$(".op-aside .code-group")).length === 2 && /"pattern": "chase"/.test(await page.textContent(".op-aside .code-group:nth-of-type(2), .op-aside .code-group >> nth=1")), "no example response");
  await page.click(".response:nth-child(2) summary"); ok(await page.isVisible(".response:nth-child(2) .response-body"), "a response doesn't open");
});
await step("Try it: the panel, and how to allow the docs site when Tempolight refuses", async () => {
  await page.click("[data-try]"); await page.waitForSelector(".try:not([hidden])");
  ok(await page.inputValue('[data-k="base"]') === "http://localhost:8080", "base URL"); ok(await page.inputValue('[data-k="path.id"]') === "u-k3j9q2", "path param");
  ok(/"name": "Pink chase"/.test(await page.inputValue('[data-k="body"]')), "body");
  await page.fill('[data-k="base"]', "http://127.0.0.1:9"); await page.click("[data-try-send]"); await page.waitForSelector("[data-try-help]:not([hidden])", { timeout: 10000 });
  ok(/Let the docs site try API calls/.test(await page.textContent("[data-try-help]")), "no explanation"); ok(/curl -X PUT 'http:\/\/127\.0\.0\.1:9\/api\/custom-effects\/u-k3j9q2'/.test(await page.textContent("[data-try-curl]")), "no curl alternative");
  await page.keyboard.press("Escape"); ok(await page.isHidden(".try"), "Esc didn't close it");
  errors.splice(0, errors.length, ...errors.filter(e => !/127\.0\.0\.1:9|ERR_CONNECTION_REFUSED|Failed to load resource/.test(e))); // the refused request itself
});
await step("copy buttons copy the code", async () => {
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"]); await page.goto(base + "/docs/guides/docker/");
  await page.hover(".prose .code"); await page.click(".prose .code .copy"); const clip = await page.evaluate(() => navigator.clipboard.readText());
  ok(clip.length > 10 && clip === (await page.$eval(".prose .code pre", p => p.innerText)).replace(/\n$/, ""), "clipboard: " + clip.slice(0, 40));
});
await step("On this page follows the scroll", async () => {
  await page.goto(base + "/docs/guides/troubleshooting/"); const ids = await page.$$eval(".toc a", a => a.map(x => x.dataset.id)); ok(ids.length > 3, "no table of contents");
  await page.evaluate(id => document.getElementById(id).scrollIntoView(), ids[2]); await sleep(300);
  ok((await page.getAttribute(".toc a.active", "data-id")) === ids[2], "wrong active entry " + await page.getAttribute(".toc a.active", "data-id"));
});
await step("a missing page answers 404 with the docs' 404 page", async () => {
  const r = await page.goto(base + "/docs/no-such-page/"); ok(r.status() === 404, "status " + r.status()); ok(/doesn't exist/.test(await page.textContent("h1")), "not the 404 page");
  errors.splice(0, errors.length, ...errors.filter(e => !/no-such-page.*404/.test(e)));
});
await step("light theme from the system setting", async () => {
  const c = await context({ colorScheme: "light" }), p = await c.newPage(); watch(p); await p.goto(base + "/docs/");
  ok(await p.evaluate(() => document.documentElement.dataset.theme) === "light", "not light"); ok(await p.evaluate(() => getComputedStyle(document.body).backgroundColor) === "rgb(255, 255, 255)", "background not white"); await c.close();
});
await step("phone width (390 px): no sideways scrolling, the menu opens and closes", async () => {
  const c = await context({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }), p = await c.newPage(); watch(p);
  for (const u of ["/docs/", "/docs/guides/first-run/", "/docs/api/", "/docs/internals/testing/", "/docs/api-reference/", "/docs/api-reference/your-own-effects/change-an-effect/", "/docs/overview/", "/docs/architecture/"]) {
    await p.goto(base + u); await sleep(u.includes("first-run") ? 1500 : 200); const w = await p.evaluate(() => document.documentElement.scrollWidth); ok(w <= 390, `${u} is ${w}px wide`);
  }
  ok(await p.isHidden(".sidebar .nav-item.active") || (await p.$eval(".sidebar", s => s.getBoundingClientRect().right)) <= 0, "sidebar visible before opening the menu");
  await p.click("[data-menu]"); await sleep(350); ok((await p.$eval(".sidebar", s => s.getBoundingClientRect().left)) >= 0, "menu didn't open");
  await p.click("[data-scrim]", { position: { x: 370, y: 400 } }); await sleep(350); ok((await p.$eval(".sidebar", s => s.getBoundingClientRect().right)) <= 0, "menu didn't close");
  await p.click(".search-icon-btn"); await p.waitForSelector("[data-search-modal]:not([hidden])"); await c.close();
});
await step("no errors in the console", async () => ok(!errors.length, errors.slice(0, 4).join(" | ")));
await browser.close(); server.close(); rmSync(dir, { recursive: true, force: true });
console.log(results.join("\n")); console.log(failed ? `\n${failed} failed` : "\nall passed"); process.exit(failed ? 1 : 0);
