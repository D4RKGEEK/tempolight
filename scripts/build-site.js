#!/usr/bin/env node
// Builds the online demo into dist/site: the web app in demo mode (the real core and runtime running in the browser,
// with pretend WLED controllers), the landing page at /about/, and the PWA files. No dependencies.
// Cloudflare Pages runs this on every push (see wrangler.jsonc and docs/deploy-cloudflare.md). Try it locally:
//   node scripts/build-site.js && npx serve dist/site        (or any static file server)
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), out = path.join(root, "dist/site");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
let rev = ""; try { rev = execSync("git rev-parse --short HEAD", { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch {}
const build = `${pkg.version}-${rev || Date.now().toString(36)}`;

rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });
const copy = (from, to) => cpSync(path.join(root, from), path.join(out, to), { recursive: true, filter: f => !f.endsWith(".test.js") });
copy("apps/web", "");                                   // the app
copy("packages/engine/src", "engine");                  // /engine/... (what the app imports)
copy("packages/engine/src", "packages/engine/src");     // /packages/... (what the server core imports)
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
  if (!rel.startsWith("packages/engine/")) { mkdirSync(path.join(out, path.dirname(rel)), { recursive: true }); copy(rel, rel); }
}
follow("packages/server/src/core.js"); follow("packages/server/src/runtime.js");

copy("apps/playground/demo.mp3", "demo.mp3");
mkdirSync(path.join(out, "playground"), { recursive: true }); copy("apps/playground/index.html", "playground/index.html");
mkdirSync(path.join(out, "about"), { recursive: true }); copy("docs/index.html", "about/index.html"); copy("docs/images", "about/images");

// demo mode on, and the version for the About box
const idx = path.join(out, "index.html");
writeFileSync(idx, readFileSync(idx, "utf8").replace("<title>", `<meta name="tempolight-demo" content="1">\n<meta name="tempolight-version" content="${pkg.version}">\n<title>`));
for (const f of ["phone.html", "request.html"]) { const ph = path.join(out, f); writeFileSync(ph, readFileSync(ph, "utf8").replace("<title>", `<meta name="tempolight-demo" content="1">\n<title>`)); }
// No minifying and no pre-compressed .br/.gz copies: Cloudflare Pages compresses text files itself (brotli or gzip, as
// the browser asks) and would serve a .br file only as a file of its own (sending it as the page takes a Pages Function
// in front of every request). Stripping comments and indentation saves only ~4% once compressed, and without a real
// JavaScript parser it can break template literals; the web app instead loads its pages only when they are opened.
const sw = path.join(out, "sw.js"); writeFileSync(sw, readFileSync(sw, "utf8").replace("__BUILD__", build));
writeFileSync(path.join(out, "_headers"), `/sw.js
  Cache-Control: no-cache
/manifest.webmanifest
  Content-Type: application/manifest+json
/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
`);
const count = d => readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? count(path.join(d, e.name)) : 1), 0);
console.log(`Built the online demo ${build} into dist/site (${count(out)} files)`);
