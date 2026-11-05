#!/usr/bin/env node
// Builds the documentation website (https://tempolight.pages.dev/docs) from the Mintlify project in mintlify/: the
// navigation, colours and logos from docs.json, the MDX pages, and an API reference made from openapi.json. No
// dependencies, so Cloudflare Pages runs it inside `node scripts/build-site.js`. The renderer is in scripts/docs-site/.
//   node scripts/build-docs-site.js                    write dist/site/docs
//   node scripts/build-docs-site.js --out <dir>        write somewhere else (pages still live under /docs/)
//   node scripts/build-docs-site.js --serve [port]     build, then serve it at http://localhost:3000/docs/
// Mermaid diagrams are drawn in the browser by the official Mermaid build from a CDN (pinned below); the icons are
// Lucide's (ISC licence), copied into scripts/docs-site/icons.js by scripts/docs-site/gen-icons.js.
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { render, frontMatter, plainText } from "./docs-site/markdown.js";
import { esc } from "./docs-site/highlight.js";
import { createApiRenderer, BASE as API_BASE } from "./docs-site/openapi.js";
import { ICONS, BRANDS } from "./docs-site/icons.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "mintlify"), ASSETS = path.join(ROOT, "scripts/docs-site");
export const SITE = "https://tempolight.pages.dev", DOCS = "/docs";
export const MERMAID_URL = "https://cdn.jsdelivr.net/npm/mermaid@11.16.1/dist/mermaid.esm.min.mjs";
const REPO = "https://github.com/D4RKGEEK/tempolight";

/** An icon's inline SVG (Lucide, or a brand mark); a missing name is reported once and drawn as a dot. */
const missingIcons = new Set();
export function icon(name, cls = "ic", size) {
  const n = String(name || "").replace(/^lucide[-:]/, ""), body = ICONS[n] ?? BRANDS[n]?.body;
  if (body === undefined) { missingIcons.add(n); return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>`; }
  const brand = !ICONS[n] && BRANDS[n];
  return `<svg class="${cls}" viewBox="${brand ? brand.viewBox : "0 0 24 24"}"${size ? ` width="${size}" height="${size}"` : ""} ${brand ? 'fill="currentColor"' : 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'} aria-hidden="true">${body}</svg>`;
}

export function buildDocs({ out = path.join(ROOT, "dist/site/docs"), quiet = false } = {}) {
  const t0 = Date.now();
  const cfg = JSON.parse(readFileSync(path.join(SRC, "docs.json"), "utf8"));
  const spec = JSON.parse(readFileSync(path.join(SRC, "openapi.json"), "utf8"));
  const warnings = [];

  // ---------------------------------------------------------------- pages and navigation
  const pages = new Map(); // slug -> page
  const url = slug => slug === "index" ? `${DOCS}/` : `${DOCS}/${slug}/`;
  for (const slug of cfg.navigation.tabs.flatMap(t => t.groups.flatMap(g => g.pages || []))) {
    const file = path.join(SRC, slug + ".mdx"); if (!existsSync(file)) { warnings.push(`docs.json lists ${slug}, but mintlify/${slug}.mdx is missing`); continue; }
    const raw = readFileSync(file, "utf8"), { data, body } = frontMatter(raw);
    const source = /Generated from (docs\/\S+?) by/.exec(body)?.[1] || `mintlify/${slug}.mdx`;
    pages.set(slug, { slug, url: url(slug), title: data.title || slug, sidebarTitle: data.sidebarTitle || data.title || slug, description: data.description || "", icon: data.icon, mode: data.mode, body, source });
  }
  const api = createApiRenderer({ spec, md: s => render(s, ctx()).html, icon });
  const knownPaths = new Set([...[...pages.values()].map(p => p.url), `${API_BASE}/`, ...api.model.tags.map(t => t.url), ...api.model.ops.map(o => o.url)]);

  /** Rewrites a link in a page: internal pages to /docs/<page>/, images and logos to /docs/... */
  function link(href, kind) {
    if (!href || /^(#|mailto:|tel:|data:)/.test(href) || /^[a-z][a-z\d+.-]*:/i.test(href)) return href;
    if (!href.startsWith("/")) return href;
    const [p0, hash] = href.split("#"), p = p0.replace(/\/+$/, "") || "/";
    if (p === "/" || p === "/index") return `${DOCS}/${hash ? "#" + hash : ""}`;
    if (p.startsWith(DOCS + "/") || p === DOCS) return href;
    if (kind === "image" || /\.(png|jpe?g|gif|svg|webp|avif|mp4|webm|pdf)$/i.test(p)) return DOCS + p;
    const slug = p.slice(1);
    if (pages.has(slug)) return url(slug) + (hash ? "#" + hash : "");
    if (knownPaths.has(`${DOCS}${p}/`)) return `${DOCS}${p}/` + (hash ? "#" + hash : "");
    warnings.push(`a link to ${href} goes to no page`); return `${DOCS}${p}/` + (hash ? "#" + hash : "");
  }
  function ctx() { return { link, icon }; }

  // the sidebar of each tab: groups of pages, and the API reference's tags (the "openapi" group)
  const tabs = cfg.navigation.tabs.map((t, ti) => ({ ...t, index: ti, slug: t.tab.toLowerCase(), groups: t.groups.map(g => g.openapi ? { group: g.group, api: true } : { group: g.group, pages: (g.pages || []).filter(s => pages.has(s)) }) }));
  const order = []; // every page in reading order, for previous / next
  for (const t of tabs) for (const g of t.groups) {
    if (g.api) { order.push({ url: `${API_BASE}/`, title: "API reference", tab: t, group: g.group }); for (const tg of api.model.tags) { order.push({ url: tg.url, title: tg.name, tab: t, group: g.group }); for (const o of tg.ops) order.push({ url: o.url, title: o.title, tab: t, group: g.group, tag: tg }); } }
    else for (const s of g.pages) { const p = pages.get(s); if (!p.tab) { p.tab = t; p.group = g.group; order.push({ url: p.url, title: p.sidebarTitle, tab: t, group: g.group, page: p }); } }
  }
  const startTab = tabs.find(t => t.groups.some(g => g.pages?.includes("index"))) || tabs[0];

  function sidebar(tab, current) {
    const item = (href, label, ic, extra = "") => `<a class="nav-item${href === current ? " active" : ""}" href="${href}"${href === current ? ' aria-current="page"' : ""}>${ic ? icon(ic, "ic") : ""}<span>${label}</span>${extra}</a>`;
    const anchors = (cfg.navigation.global?.anchors || []).map(a => `<a class="nav-anchor" href="${esc(a.href)}" target="_blank" rel="noopener"><span class="nav-anchor-icon">${icon(a.icon, "ic")}</span><span>${esc(a.anchor)}</span></a>`).join("");
    const groups = tab.groups.map((g, gi) => {
      let inner;
      if (g.api) inner = item(`${API_BASE}/`, "Overview", "book-open") + api.model.tags.map(tg => {
        const open = current.startsWith(tg.url);
        return `<details class="nav-sub"${open ? " open" : ""}><summary class="nav-item${current === tg.url ? " active" : ""}">${icon(tg.icon, "ic")}<a href="${tg.url}">${esc(tg.name)}</a>${icon("chevron-right", "ic chev")}</summary><div class="nav-sub-items">${tg.ops.map(o => item(o.url, esc(o.title), null, "").replace("<span>", api.methodPill(o.method, "sm") + "<span>")).join("")}</div></details>`;
      }).join("");
      else inner = g.pages.map(s => { const p = pages.get(s); return item(p.url, esc(p.sidebarTitle), p.icon); }).join("");
      return `<div class="nav-group"><button class="nav-group-title" type="button" aria-expanded="true" aria-controls="ng-${tab.index}-${gi}">${esc(g.group)}${icon("chevron-down", "ic chev")}</button><div class="nav-group-items" id="ng-${tab.index}-${gi}">${inner}</div></div>`;
    }).join("");
    return `<div class="nav-anchors">${anchors}</div>${groups}`;
  }

  // ---------------------------------------------------------------- the page around the content
  const logo = (cls = "") => `<a class="logo ${cls}" href="${DOCS}/" aria-label="Tempolight docs home"><img class="logo-dark" src="${DOCS}${cfg.logo.dark}" alt="Tempolight" width="123" height="28"><img class="logo-light" src="${DOCS}${cfg.logo.light}" alt="Tempolight" width="123" height="28"><span class="logo-docs">Docs</span></a>`;
  const primary = cfg.navbar?.primary, github = (cfg.navbar?.links || []).find(l => l.type === "github")?.href || REPO;
  const assetV = createHash("sha256").update(readFileSync(path.join(ASSETS, "docs.css"))).update(readFileSync(path.join(ASSETS, "docs.js"))).update(JSON.stringify(cfg.colors || {})).digest("hex").slice(0, 10);
  function layout(o) {
    const { title, description = cfg.description, href, tab, content, toc = [], prevNext, edit, kind = "page", mermaid } = o;
    const full = href === `${DOCS}/` ? `${cfg.name} documentation` : `${title} · ${cfg.name} docs`;
    const tabsHtml = tabs.map(t => { const first = order.find(x => x.tab === t); return `<a class="tab${t === tab ? " active" : ""}" href="${first ? first.url : "#"}"${t === tab ? ' aria-current="true"' : ""}>${icon(t.icon, "ic")}<span>${esc(t.tab)}</span></a>`; }).join("");
    const tocHtml = toc.length ? `<aside class="toc" aria-label="On this page"><div class="toc-inner"><div class="toc-title">${icon("text", "ic")}On this page</div><nav>${toc.map(h => `<a class="toc-l${h.depth}" href="#${h.id}" data-id="${h.id}">${esc(h.text)}</a>`).join("")}</nav></div></aside>` : "";
    const pn = prevNext ? `<nav class="pager" aria-label="Previous and next pages">${prevNext[0] ? `<a class="pager-prev" href="${prevNext[0].url}"><span class="pager-label">${icon("arrow-left", "ic")}Previous</span><span class="pager-title">${esc(prevNext[0].title)}</span></a>` : "<span></span>"}${prevNext[1] ? `<a class="pager-next" href="${prevNext[1].url}"><span class="pager-label">Next${icon("arrow-right", "ic")}</span><span class="pager-title">${esc(prevNext[1].title)}</span></a>` : "<span></span>"}</nav>` : "";
    const foot = kind === "404" ? "" : `<div class="page-foot"><div class="feedback" data-feedback><span>Was this page helpful?</span><button type="button" data-fb="yes">${icon("thumbs-up", "ic")}Yes</button><button type="button" data-fb="no">${icon("thumbs-down", "ic")}No</button><span class="feedback-thanks" hidden>Thanks for telling us.</span><a class="feedback-issue" hidden href="${REPO}/issues/new?title=${encodeURIComponent("Docs: " + title)}&body=${encodeURIComponent(`Page: ${SITE}${href}\n\nWhat was missing or wrong?\n`)}" target="_blank" rel="noopener">Tell us what was missing ${icon("arrow-up-right", "ic")}</a></div>${edit ? `<a class="edit" href="${REPO}/edit/main/${edit}" target="_blank" rel="noopener">${icon("pencil", "ic")}Edit on GitHub</a>` : ""}</div>${pn}
      <footer class="site-foot"><div class="site-foot-row">${logo("logo-sm")}<div class="site-foot-links"><a href="${SITE}/">Home</a><a href="${SITE}/demo/">Online demo</a><a href="${REPO}/releases">Releases</a><a href="${github}" target="_blank" rel="noopener" aria-label="GitHub">${icon("github", "ic")}</a></div></div><p>Tempolight is free and open source (MIT). These docs are built from <a href="${REPO}/tree/main/docs" target="_blank" rel="noopener">docs/</a> in the repository.</p></footer>`;
    const ogImage = `${SITE}${DOCS}/images/home-dark.png`;
    return `<!doctype html>
<html lang="en" data-kind="${kind}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(full)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${SITE}${href}">
<meta property="og:type" content="website"><meta property="og:site_name" content="${esc(cfg.name)} docs"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}"><meta property="og:url" content="${SITE}${href}"><meta property="og:image" content="${ogImage}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(description)}"><meta name="twitter:image" content="${ogImage}">
<meta name="theme-color" content="${cfg.background?.color?.dark || "#111317"}" media="(prefers-color-scheme: dark)"><meta name="theme-color" content="${cfg.background?.color?.light || "#ffffff"}" media="(prefers-color-scheme: light)">
<link rel="icon" href="${DOCS}${cfg.favicon}" type="image/svg+xml">
<link rel="stylesheet" href="${DOCS}/assets/docs.css?v=${assetV}">
<script>try{var t=localStorage.getItem("tl-docs-theme");if(t!=="light"&&t!=="dark")t=matchMedia("(prefers-color-scheme: light)").matches?"light":"${cfg.appearance?.default === "light" ? "light" : "dark"}";document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme="dark"}</script>
<script type="module" src="${DOCS}/assets/docs.js?v=${assetV}"></script>
</head>
<body>
<a class="skip" href="#content">Skip to content</a>
<header class="top">
  <div class="top-row">
    <button class="icon-btn menu-btn" type="button" aria-label="Open the menu" aria-expanded="false" aria-controls="sidebar" data-menu>${icon("menu", "ic")}</button>
    ${logo()}
    <button class="search-btn" type="button" data-search aria-label="Search the docs">${icon("search", "ic")}<span class="search-btn-text">Search the docs…</span><kbd class="kbd"><span data-mod>Ctrl</span> K</kbd></button>
    <div class="top-actions">
      <button class="icon-btn search-icon-btn" type="button" data-search aria-label="Search">${icon("search", "ic")}</button>
      <a class="top-link" href="${github}" target="_blank" rel="noopener" aria-label="Tempolight on GitHub">${icon("github", "ic")}<span>GitHub</span></a>
      <button class="icon-btn theme-btn" type="button" data-theme-toggle aria-label="Switch between dark and light">${icon("sun", "ic sun")}${icon("moon", "ic moon")}</button>
      ${primary ? `<a class="btn btn-primary top-cta" href="${esc(primary.href)}">${esc(primary.label)}${icon("arrow-up-right", "ic")}</a>` : ""}
    </div>
  </div>
  <nav class="tabs" aria-label="Sections">${tabsHtml}</nav>
</header>
<div class="scrim" data-scrim hidden></div>
<div class="layout${toc.length ? " has-toc" : ""}">
  <aside class="sidebar" id="sidebar" aria-label="Pages"><nav class="sidebar-inner">${sidebar(tab, href)}</nav></aside>
  <main class="main" id="content">
    <article class="article">${content}</article>
    ${foot}
  </main>
  ${tocHtml}
</div>
<div class="search" data-search-modal hidden role="dialog" aria-modal="true" aria-label="Search the docs">
  <div class="search-panel">
    <div class="search-input">${icon("search", "ic")}<input type="search" placeholder="Search the docs…" aria-label="Search" autocomplete="off" spellcheck="false" data-search-input><kbd class="kbd">Esc</kbd></div>
    <div class="search-results" data-search-results role="listbox"></div>
    <div class="search-foot"><span><kbd class="kbd">↑</kbd><kbd class="kbd">↓</kbd> to move</span><span><kbd class="kbd">↵</kbd> to open</span><span><kbd class="kbd">Esc</kbd> to close</span></div>
  </div>
</div>
${mermaid ? `<script type="application/json" id="mermaid-src">${JSON.stringify({ url: MERMAID_URL })}</script>` : ""}
</body>
</html>
`;
  }
  const header = (eyebrow, title, description) => `<header class="page-head">${eyebrow ? `<div class="eyebrow">${esc(eyebrow)}</div>` : ""}<h1>${esc(title)}</h1>${description ? `<p class="lead">${esc(description)}</p>` : ""}</header>`;
  const neighbours = href => { const k = order.findIndex(x => x.url === href); return [order[k - 1], order[k + 1]]; };

  // ---------------------------------------------------------------- write
  rmSync(out, { recursive: true, force: true }); mkdirSync(path.join(out, "assets"), { recursive: true });
  const written = [], search = [];
  const write = (href, html) => { const f = path.join(out, href.slice(DOCS.length + 1), "index.html"); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, html); written.push(href); };

  for (const p of pages.values()) {
    const r = render(p.body, ctx()), frame = p.mode === "frame" || p.slug === "index";
    // the description is often the first paragraph itself (build-mintlify.js takes it from there): don't show it twice
    const norm = x => plainText(x).replace(/\s+/g, " ").trim().toLowerCase(), firstP = /^<p>([\s\S]*?)<\/p>/.exec(r.html)?.[1] || "";
    const lead = p.description && !norm(firstP).startsWith(norm(p.description).slice(0, 80)) ? p.description : "";
    const content = frame ? `<div class="frame-page">${r.html}</div>` : header(p.group, p.title, lead) + `<div class="prose">${r.html}</div>`;
    write(p.url, layout({ title: p.title, description: p.description, href: p.url, tab: p.tab, content, toc: frame ? [] : r.headings.filter(h => h.depth >= 2 && h.depth <= 3), prevNext: neighbours(p.url), edit: p.source, kind: frame ? "home" : "page", mermaid: r.mermaid }));
    search.push({ t: p.title, u: p.url, g: `${p.tab.tab} · ${p.group}`, d: p.description, s: r.sections.map(s => [s.heading, s.id, s.text.slice(0, 600)]) });
  }
  const refTab = tabs.find(t => t.groups.some(g => g.api)) || tabs[0], refGroup = refTab.groups.find(g => g.api)?.group || "API";
  write(`${API_BASE}/`, layout({ title: "API reference", description: "Every HTTP endpoint of Tempolight, with parameters, bodies, responses, code samples and a Try it panel.", href: `${API_BASE}/`, tab: refTab,
    content: header(refGroup, "API reference", "Every HTTP endpoint, with its parameters, request body and responses, code samples in curl, JavaScript and Python, and a Try it panel.") + `<div class="prose">${api.overviewPage()}</div>`, toc: [{ depth: 2, id: "base-url", text: "Base URL" }, { depth: 2, id: "groups", text: "Endpoints by area" }], prevNext: neighbours(`${API_BASE}/`), edit: "scripts/openapi/operations.js", kind: "page" }));
  search.push({ t: "API reference", u: `${API_BASE}/`, g: `${refTab.tab} · ${refGroup}`, d: plainText(spec.info?.description || "").slice(0, 300), s: [] });
  for (const tg of api.model.tags) {
    write(tg.url, layout({ title: tg.name, description: tg.description, href: tg.url, tab: refTab, content: header("API reference", tg.name, "") + `<div class="prose">${api.tagPage(tg)}</div>`, prevNext: neighbours(tg.url), edit: "scripts/openapi/operations.js", kind: "page" }));
    search.push({ t: tg.name, u: tg.url, g: `API · ${refGroup}`, d: tg.description, s: [] });
    for (const o of tg.ops) {
      const r = api.operationPage(o);
      write(o.url, layout({ title: o.title, description: r.description || `${o.method} ${o.path}`, href: o.url, tab: refTab, content: header(tg.name, o.title, "") + r.html, prevNext: neighbours(o.url), edit: "scripts/openapi/operations.js", kind: "api" }));
      search.push({ t: o.title, u: o.url, g: `API · ${tg.name}`, m: o.method, p: o.path, d: plainText(o.op.description || "").replace(/\*\*/g, "").slice(0, 300), s: [] });
    }
  }
  // 404
  writeFileSync(path.join(out, "404.html"), layout({ title: "Page not found", description: "This page doesn't exist.", href: `${DOCS}/404`, tab: startTab, kind: "404",
    content: `<div class="notfound"><div class="notfound-code">404</div><h1>This page doesn't exist</h1><p class="lead">It may have moved when the docs were reorganised. Try searching, or start from the home page.</p><div class="tl-actions"><a class="tl-btn tl-btn-primary" href="${DOCS}/">Docs home</a><button class="tl-btn" type="button" data-search>${icon("search", "ic")}Search the docs</button></div></div>` }));

  // assets: CSS and JS (with the brand colours from docs.json), images, logos, favicon, the search index, the sitemap
  const colors = cfg.colors || {};
  writeFileSync(path.join(out, "assets/docs.css"), readFileSync(path.join(ASSETS, "docs.css"), "utf8").replace(/__PRIMARY__/g, colors.primary || "#b86f00").replace(/__LIGHT__/g, colors.light || "#f5a524").replace(/__BG_DARK__/g, cfg.background?.color?.dark || "#111317").replace(/__BG_LIGHT__/g, cfg.background?.color?.light || "#ffffff"));
  writeFileSync(path.join(out, "assets/docs.js"), readFileSync(path.join(ASSETS, "docs.js"), "utf8").replace("__ICONS__", JSON.stringify({ file: icon("file-text", "ic"), hash: icon("hash", "ic"), api: icon("braces", "ic"), enter: icon("corner-down-left", "ic"), x: icon("x", "ic"), copy: icon("copy", "ic"), check: icon("check", "ic ok"), expand: icon("maximize-2", "ic") })));
  for (const d of ["images", "logo"]) if (existsSync(path.join(SRC, d))) cpSync(path.join(SRC, d), path.join(out, d), { recursive: true });
  copyFileSync(path.join(SRC, cfg.favicon.replace(/^\//, "")), path.join(out, path.basename(cfg.favicon)));
  writeFileSync(path.join(out, "search.json"), JSON.stringify(search));
  writeFileSync(path.join(out, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${written.map(u => `  <url><loc>${SITE}${u}</loc></url>`).join("\n")}\n</urlset>\n`);
  writeFileSync(path.join(out, "robots.txt"), `User-agent: *\nAllow: /docs/\nSitemap: ${SITE}${DOCS}/sitemap.xml\n`);

  for (const n of missingIcons) warnings.push(`no icon "${n}" in scripts/docs-site/icons.js (run scripts/docs-site/gen-icons.js)`);
  if (!quiet) { for (const w of [...new Set(warnings)]) console.warn("docs: " + w); console.log(`Built the docs site into ${path.relative(ROOT, out) || out}: ${written.length} pages (${pages.size} guides and references, ${api.model.ops.length} API operations) in ${Date.now() - t0} ms`); }
  return { pages: written, warnings: [...new Set(warnings)], out };
}

// ---------------------------------------------------------------- command line
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".gif": "image/gif", ".xml": "application/xml", ".txt": "text/plain" };
/** A static server like Cloudflare Pages for the docs: /docs/x/ -> <dir>/x/index.html, a missing page -> 404.html */
export function serveDocs(dir, port = 3000, host = "127.0.0.1") {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x"); let p = decodeURIComponent(u.pathname);
    if (p === "/" || p === DOCS) { res.writeHead(302, { location: `${DOCS}/` }); return res.end(); }
    if (!p.startsWith(DOCS + "/")) { res.writeHead(404); return res.end("Not found"); }
    let f = path.join(dir, p.slice(DOCS.length)); if (!f.startsWith(dir)) { res.writeHead(403); return res.end(); }
    try { if (statSync(f).isDirectory()) { if (!p.endsWith("/")) { res.writeHead(308, { location: p + "/" + u.search }); return res.end(); } f = path.join(f, "index.html"); } } catch {}
    let code = 200; if (!existsSync(f)) { code = 404; f = path.join(dir, "404.html"); }
    res.writeHead(code, { "content-type": MIME[path.extname(f)] || "application/octet-stream", "cache-control": "no-cache" }); res.end(readFileSync(f));
  });
  return new Promise(r => server.listen(port, host, () => r(server)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), at = k => args.indexOf(k), outArg = at("--out") >= 0 ? path.resolve(args[at("--out") + 1]) : undefined;
  const r = buildDocs({ out: outArg });
  if (at("--serve") >= 0) {
    const port = Number(args[at("--serve") + 1]) || 3000, s = await serveDocs(r.out, port);
    console.log(`Serving the docs at http://localhost:${s.address().port}${DOCS}/ (Ctrl+C to stop)`);
  }
}
