#!/usr/bin/env node
// Builds tempolight.pages.dev into dist/site: the homepage at / (site/index.html), the web app in demo mode at /demo/
// (the real core and runtime running in the browser, with pretend WLED controllers, plus the PWA files), the docs at
// /docs/ and the playground at /playground/. No dependencies.
// Cloudflare Pages runs this on every push (see wrangler.jsonc and docs/deploy-cloudflare.md). Try it locally:
//   node scripts/build-site.js && npx serve dist/site        (or any static file server)
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDocs } from "./build-docs-site.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), out = path.join(root, "dist/site");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
let rev = ""; try { rev = execSync("git rev-parse --short HEAD", { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch {}
const build = `${pkg.version}-${rev || Date.now().toString(36)}`;

rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });
const demo = path.join(out, "demo");
const copy = (from, to, base = out) => cpSync(path.join(root, from), path.join(base, to), { recursive: true, filter: f => !f.endsWith(".test.js") });
const dcopy = (from, to) => copy(from, to, demo);
dcopy("apps/web", "");                                  // the app, at /demo/
dcopy("packages/engine/src", "engine");                 // /demo/engine/... (what the app imports)
dcopy("packages/engine/src", "packages/engine/src");    // /demo/packages/... (what the server core imports)
// the server's browser-safe parts: core.js and runtime.js and everything they import (followed automatically, so a new
// module can't be forgotten); a Node-only import (node:dgram, node:net...) in that set stops the build with a clear error
const seen = new Set();
function follow(rel) {
  if (seen.has(rel)) return; seen.add(rel);
  const src = readFileSync(path.join(root, rel), "utf8");
  for (const m of src.matchAll(/^\s*import\s[^'"]*?["']([^"']+)["']/gm)) {
    const spec = m[1]; if (spec.startsWith("node:") || !spec.startsWith(".")) throw new Error(`${rel} imports ${spec}, which can't run in the browser demo`);
    const dep = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec)); if (!dep.startsWith("packages/engine/")) follow(dep);
  }
  if (!rel.startsWith("packages/engine/")) { mkdirSync(path.join(demo, path.dirname(rel)), { recursive: true }); dcopy(rel, rel); }
}
follow("packages/server/src/core.js"); follow("packages/server/src/runtime.js");
dcopy("apps/playground/demo.mp3", "demo.mp3");

// The app's source uses root paths ("/app.js", "/engine/...", "/phone"), as the Tempolight server serves it at /. The
// demo lives at /demo/, so every quoted root path that names one of the demo's own files gets /demo in front; other
// paths (/api/, /docs/, /playground) are left alone. New files in apps/web are picked up by themselves.
const own = readdirSync(demo).flatMap(n => [n, n.replace(/\.html$/, "")]).filter((n, i, a) => a.indexOf(n) === i).sort((a, b) => b.length - a.length);
const ownRe = new RegExp(`(["'\`(])/(${own.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?=[/"'\`?#)\\s]|$)`, "g");
function rebase(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) { rebase(f); continue; }
    if (!/\.(js|html|css)$/.test(e.name)) continue;
    let src = readFileSync(f, "utf8").replace(ownRe, "$1/demo/$2");
    if (f === path.join(demo, "sw.js")) src = src.replace(/(["'])\/\1/g, "$1/demo/$1");
    writeFileSync(f, src);
  }
}
rebase(demo);
const manPath = path.join(demo, "manifest.webmanifest"), man = JSON.parse(readFileSync(manPath, "utf8"));
const at = u => (u.startsWith("/") && !u.startsWith("/demo/") ? "/demo" + u : u);
Object.assign(man, { id: "/demo/", start_url: "/demo/", scope: "/demo/" });
for (const i of man.icons || []) i.src = at(i.src);
for (const sc of man.shortcuts || []) { sc.url = at(sc.url); for (const i of sc.icons || []) i.src = at(i.src); }
writeFileSync(manPath, JSON.stringify(man, null, 2) + "\n");

// the homepage at /, with the setup prompt from docs/setup-with-claude.md (one copy of the prompt for the site, the docs
// and the app), and /llms.txt for AI assistants
const md = readFileSync(path.join(root, "docs/setup-with-claude.md"), "utf8");
const prompt = (md.split(/^## The prompt\s*$/m)[1] || "").match(/```[a-z]*\n([\s\S]*?)\n```/)?.[1];
if (!prompt) throw new Error("docs/setup-with-claude.md has no fenced block under \"## The prompt\"");
const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
writeFileSync(path.join(out, "index.html"), readFileSync(path.join(root, "site/index.html"), "utf8").replace("<!--SETUP_PROMPT-->", esc(prompt)).replace(/__VERSION__/g, pkg.version));
writeFileSync(path.join(out, "setup-with-claude.txt"), prompt + "\n");
copy("site/llms.txt", "llms.txt");
// an app installed from the old address (service worker at /sw.js, scope /) lets go of / so the homepage shows; the
// installed app itself now lives at /demo/
writeFileSync(path.join(out, "sw.js"), `// Tempolight moved the online demo to /demo/. This replaces the old service worker at / and removes itself.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.registration.unregister().then(() => self.clients.matchAll()).then(cs => cs.forEach(c => c.navigate(c.url)))));
`);
// /about/ was the old landing page; /phone, /request and /obs were the demo's guest pages at the root
writeFileSync(path.join(out, "_redirects"), ["/about /", "/about/ /", "/about/* /", "/phone /demo/phone", "/request /demo/request", "/obs /demo/obs"].map(r => r + " 301").join("\n") + "\n");

mkdirSync(path.join(out, "playground"), { recursive: true }); copy("apps/playground/index.html", "playground/index.html"); copy("apps/playground/demo.mp3", "playground/demo.mp3");

// the documentation website at /docs/ (made from mintlify/, see scripts/build-docs-site.js)
buildDocs({ out: path.join(out, "docs") });

// demo mode on, and the version for the About box
const idx = path.join(demo, "index.html");
writeFileSync(idx, readFileSync(idx, "utf8").replace("<title>", `<meta name="tempolight-demo" content="1">\n<meta name="tempolight-version" content="${pkg.version}">\n<title>`));
for (const f of ["phone.html", "request.html"]) { const ph = path.join(demo, f); writeFileSync(ph, readFileSync(ph, "utf8").replace("<title>", `<meta name="tempolight-demo" content="1">\n<title>`)); }
// No minifying and no pre-compressed .br/.gz copies: Cloudflare Pages compresses text files itself (brotli or gzip, as
// the browser asks) and would serve a .br file only as a file of its own (sending it as the page takes a Pages Function
// in front of every request). Stripping comments and indentation saves only ~4% once compressed, and without a real
// JavaScript parser it can break template literals; the web app instead loads its pages only when they are opened.
const sw = path.join(demo, "sw.js"); writeFileSync(sw, readFileSync(sw, "utf8").replace("__BUILD__", build));
writeFileSync(path.join(out, "_headers"), `/sw.js
  Cache-Control: no-cache
/demo/sw.js
  Cache-Control: no-cache
/demo/manifest.webmanifest
  Content-Type: application/manifest+json
/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
`);
const count = d => readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? count(path.join(d, e.name)) : 1), 0);
console.log(`Built the site and the online demo ${build} into dist/site (${count(out)} files)`);
