#!/usr/bin/env node
// Builds the Mintlify documentation site in mintlify/ from the Markdown in docs/ (no dependencies).
// docs/*.md stays the source of truth (GitHub and the VitePress site in website/ read it too); this turns it into MDX
// pages, a docs.json with the navigation, and copies the images, logos and favicon. See docs/mintlify.md.
//   node scripts/build-mintlify.js            # write mintlify/
//   node scripts/build-mintlify.js --check    # fail if mintlify/ is out of date or broken (CI and npm test)
//   node scripts/build-mintlify.js --check --mermaid   # also compile every Mermaid diagram with mmdc
// Hand-written files in mintlify/ are never touched: index.mdx (the landing page), custom.css and openapi.json
// (made by scripts/gen-openapi.js).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = path.join(root, "docs");
const OUT = path.join(root, "mintlify");
const REPO = "https://github.com/D4RKGEEK/tempolight";
const SITE = "https://tempolight.pages.dev", DEMO = `${SITE}/demo/`;
const PAGES_SITE = "https://d4rkgeek.github.io/tempolight/";   // the VitePress site, which also serves /flash/
export const HAND_WRITTEN = new Set(["index.mdx", "custom.css", "openapi.json"]);
const GENERATED_NOTE = "{/* Generated from docs/SOURCE by scripts/build-mintlify.js. Edit that file, then run: node scripts/build-mintlify.js */}";

// ---------- where each page goes ----------
// slug (the Mintlify page path) for a Markdown file in docs/, or null when it isn't a page of the site
export function slugOf(docsRel) {
  if (!docsRel.endsWith(".md")) return null;
  if (docsRel.startsWith("flash/") || docsRel.startsWith("public/") || docsRel.startsWith("images/")) return null;
  if (docsRel === "index.md") return "overview";                 // index.mdx is the hand-written landing page
  return docsRel.replace(/(^|\/)README\.md$/, "$1overview").replace(/\.md$/, "");
}

// a section of a source page that becomes a page of its own
const SPLITS = [
  { from: "api.md", heading: /^## WebSocket\b/, slug: "websocket", title: "WebSocket API", sidebarTitle: "WebSocket",
    description: "Live status, LED previews, audio and pads over one WebSocket at /ws.",
    stub: "Live data (status, LED previews, audio, low-delay pads) goes over one WebSocket: see [WebSocket API](/websocket)." },
];

// per page: icon (Lucide), shorter sidebar title, description override
const META = {
  overview: { icon: "sparkles", sidebarTitle: "Overview", title: "Overview" },
  "getting-started": { icon: "flag", description: "The short version: what you need, WLED settings, the setup wizard, music sources and the first fixes." },
  install: { icon: "download", sidebarTitle: "Install" },
  "guides/first-run": { icon: "play", sidebarTitle: "Your first show" },
  "setup-with-claude": { icon: "sparkles", sidebarTitle: "Set up with Claude" },
  "guides/what-you-can-do": { icon: "list-checks", sidebarTitle: "What you can do" },
  "guides/overview": { icon: "map", sidebarTitle: "All guides" },
  "guides/connect-lights": { icon: "lightbulb" },
  "guides/room-and-zones": { icon: "layout-grid" },
  "guides/music-sources": { icon: "music", sidebarTitle: "Music sources" },
  "guides/your-music": { icon: "list-music", sidebarTitle: "Your own music" },
  "hearing-music": { icon: "ear", sidebarTitle: "Hearing the music" },
  spotify: { icon: "disc-3", sidebarTitle: "Spotify" },
  effects: { icon: "wand-sparkles" },
  "guides/docker": { icon: "container", sidebarTitle: "Docker" },
  "raspberry-pi": { icon: "cpu", sidebarTitle: "Raspberry Pi" },
  "tempolight-lite": { icon: "microchip", sidebarTitle: "Tempolight Lite (ESP32)", description: "A WLED usermod for an ESP32 with a microphone: music-reactive lights without a computer (beta)." },
  "deploy-cloudflare": { icon: "cloud", sidebarTitle: "Host the online demo" },
  "guides/smart-home": { icon: "house", sidebarTitle: "Smart home" },
  voice: { icon: "mic" },
  "wake-up": { icon: "sunrise", sidebarTitle: "Wake-up and sleep", description: "A sunrise to wake up to, a fade-out to fall asleep to, and an ambient plan for the hours without music." },
  "guides/party-and-dj": { icon: "party-popper" },
  "guides/creators": { icon: "video", sidebarTitle: "Streamers and creators" },
  streamdeck: { icon: "keyboard" },
  integrations: { icon: "plug", sidebarTitle: "OBS, games, Twitch, Discord" },
  api: { icon: "braces", title: "HTTP API", sidebarTitle: "HTTP API" },
  websocket: { icon: "radio" },
  protocols: { icon: "network", sidebarTitle: "Protocols", description: "The wire details of every kind of light and beat source Tempolight talks to, for developers and network admins." },
  architecture: { icon: "layers" },
  "internals/engine-analysis": { icon: "audio-waveform" },
  "internals/live-analyser": { icon: "audio-lines" },
  "internals/song-memory": { icon: "brain" },
  "internals/director-and-effects": { icon: "clapperboard" },
  "internals/effect-ratings": { icon: "thumbs-up", description: "How good every built-in effect is in drops, build-ups and calm parts, measured on synthetic songs (generated)." },
  "internals/runtime-and-outputs": { icon: "cable" },
  "internals/data-model": { icon: "database" },
  "internals/web-app": { icon: "app-window" },
  "internals/security": { icon: "shield" },
  "internals/extending": { icon: "puzzle" },
  "internals/testing": { icon: "flask-conical" },
  mintlify: { icon: "book-marked", sidebarTitle: "This docs site" },
  "guides/troubleshooting": { icon: "wrench" },
  "guides/faq": { icon: "circle-help", sidebarTitle: "FAQ", description: "The short answers: what you need, which lights work, how good the sync is, and what it costs (nothing)." },
  roadmap: { icon: "milestone", description: "What is done, what is beta and what comes next." },
};

// the top tabs (like supabase.com/docs). Pages that don't exist (yet) are left out; pages that exist but aren't
// listed land in Guides → More, so a new page in docs/ always shows up.
const NAV = [
  { tab: "Start", icon: "rocket", groups: [
    { group: "Get started", pages: ["index", "setup-with-claude", "overview", "install", "guides/first-run", "guides/what-you-can-do", "getting-started"] },
  ] },
  { tab: "Guides", icon: "book-open", groups: [
    { group: "Guides", pages: ["guides/overview"] },
    { group: "Lights and music", pages: ["guides/connect-lights", "guides/room-and-zones", "guides/music-sources", "guides/your-music", "hearing-music", "spotify", "effects"] },
    { group: "Run it anywhere", pages: ["guides/docker", "raspberry-pi", "tempolight-lite", "deploy-cloudflare"] },
    { group: "Smart home", pages: ["guides/smart-home", "voice", "wake-up"] },
    { group: "Parties and streams", pages: ["guides/party-and-dj", "guides/creators", "streamdeck", "integrations"] },
    { group: "More", pages: [], rest: true },
  ] },
  { tab: "Reference", icon: "code", groups: [
    { group: "Reference", pages: ["api", "websocket", "protocols"] },
    { group: "HTTP endpoints", openapi: "openapi.json" },
  ] },
  { tab: "Internals", icon: "cpu", groups: [
    { group: "Architecture", pages: ["architecture"] },
    { group: "Internals", pages: ["internals/engine-analysis", "internals/live-analyser", "internals/song-memory",
      "internals/director-and-effects", "internals/effect-ratings", "internals/runtime-and-outputs", "internals/data-model", "internals/web-app",
      "internals/security", "internals/extending", "internals/testing", "internals/*", "mintlify"] },
  ] },
  { tab: "Help", icon: "life-buoy", groups: [
    { group: "Help", pages: ["guides/troubleshooting", "guides/faq", "roadmap"] },
  ] },
];

// emoji in headings and VitePress features → Lucide icons
const EMOJI_ICON = { "🎵": "music", "🏠": "house", "💡": "lightbulb", "🪶": "feather", "🟢": "disc-3", "🎧": "headphones",
  "🏡": "house-plug", "🛠️": "wrench", "🛠": "wrench" };
const EMOJI_RE = /^(\p{Extended_Pictographic}️?|🟢)\s*/u;

// ---------- reading docs/ ----------
const posix = p => p.split(path.sep).join("/");
const readText = f => readFileSync(f, "utf8").replace(/\r\n?/g, "\n");
function walk(dir, filter, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name.startsWith(".") || e.name === "node_modules" || (dir === DOCS && ["flash", "public"].includes(e.name))) continue;
      walk(f, filter, out);
    }
    else if (filter(f)) out.push(f);
  }
  return out;
}

// ---------- Markdown helpers ----------
const isExternal = t => /^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith("//");
export function githubSlug(text) {
  const t = text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/<[^>]+>/g, "").replace(/[`*]/g, "").replace(/(^|\s)_+|_+(\s|$)/g, "$1$2");
  return t.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
}
function headingsOf(lines) {
  const out = [], seen = new Map();
  let fence = null;
  for (const line of lines) {
    const f = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !line.trim().slice(f[1].length)) fence = null; continue; }
    if (f) { fence = f[1]; continue; }
    const h = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (!h) continue;
    const s = githubSlug(h[2]), n = seen.get(s) ?? 0; seen.set(s, n + 1);
    out.push({ level: h[1].length, text: h[2], slug: n ? `${s}-${n}` : s });
  }
  return out;
}
const plain = t => t.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/<[^>]+>/g, "")
  .replace(/`([^`]*)`/g, "$1").replace(/(\*\*|__|\*|_)(\S[\s\S]*?\S|\S)\1/g, "$2").replace(/\s+/g, " ").trim();
// the page's description: its first paragraph of prose (Markdown source), as plain text, cut at a sentence end near
// 200 characters. When that paragraph is the page's opening, short and has no links, it is dropped from the body
// (Mintlify shows the description under the title, so it would be there twice).
function describe(src) {
  const paras = src.split(/\n\s*\n/);
  const first = paras.findIndex(p => p.trim());
  for (let i = 0; i < paras.length; i++) {
    const t = paras[i].trim();
    if (!t || /^(#|```|~~~|\||<|>|[-*+] |\d+\. |!\[|\{\/\*)/.test(t)) continue;
    let s = plain(t);
    const whole = s.length <= 200;
    if (!whole) {
      const cut = s.slice(0, 200), end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(": "));
      s = end > 60 ? cut.slice(0, end + 1).replace(/:$/, ".") : cut.replace(/\s+\S*$/, "") + "…";
    }
    const drop = whole && i === first && !/\]\(|`|<|\{/.test(t) && /[.!?]$/.test(s);
    return { text: s, body: drop ? paras.filter((_, k) => k !== i).join("\n\n") : src };
  }
  return { text: "", body: src };
}
const yamlStr = s => JSON.stringify(s);
const attr = s => JSON.stringify(s).replace(/[{}<>]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

// ---------- the converter ----------
// ctx: { srcRel (docs-relative source path), slug, pages: Map(slug → {anchors:Set}), anchorMoves: Map("srcRel#a" → slug),
//        warn(msg) }
export function rewriteHref(href, ctx) {
  if (!href || isExternal(href)) return href;
  const [, pathPart, query = "", hash = ""] = href.match(/^([^#?]*)(\?[^#]*)?(#.*)?$/) || [, href];
  const anchor = hash.slice(1);
  if (!pathPart) {   // same page: the anchor may now live on a split-off page
    const target = ctx.anchorMoves.get(`${ctx.srcRel}#${anchor}`) || slugOf(ctx.srcRel);
    if (target === ctx.slug) return href;
    return `/${target}${ctx.splitHeads.has(`${ctx.srcRel}#${anchor}`) ? "" : hash}`;
  }
  if (pathPart.startsWith("/") && !pathPart.endsWith(".md") && !existsSync(path.join(DOCS, pathPart))) return href;   // already a site path
  const abs = pathPart.startsWith("/") ? path.join(DOCS, pathPart) : path.resolve(path.join(DOCS, path.dirname(ctx.srcRel)), pathPart);
  const repoRel = posix(path.relative(root, abs));
  const inDocs = abs === DOCS || abs.startsWith(DOCS + path.sep);
  const github = () => `${REPO}/${existsSync(abs) && statSync(abs).isDirectory() ? "tree" : "blob"}/main/${repoRel}${query}${hash}`;
  if (!inDocs) return github();
  const docsRel = posix(path.relative(DOCS, abs));
  if (docsRel === "flash" || docsRel.startsWith("flash/")) return `${PAGES_SITE}flash/`;
  if (docsRel === "index.html") return `${SITE}/`;
  if (/^(public\/)?images\//.test(docsRel)) return "/" + docsRel.replace(/^public\//, "");
  let md = docsRel;
  if (!md.endsWith(".md")) {
    if (existsSync(path.join(DOCS, md + ".md"))) md += ".md";
    else if (existsSync(path.join(DOCS, md, "index.md"))) md = (md ? md + "/" : "") + "index.md";
    else if (existsSync(path.join(DOCS, md, "README.md"))) md = (md ? md + "/" : "") + "README.md";
  }
  const slug = slugOf(md);
  if (!slug || !existsSync(path.join(DOCS, md))) { if (!existsSync(abs)) ctx.warn(`link to a missing file: ${href}`); return github(); }
  const moved = anchor && ctx.anchorMoves.get(`${md}#${anchor}`);
  const target = moved || slug;
  if (moved && ctx.splitHeads.has(`${md}#${anchor}`)) return `/${target}`;
  return `/${target}${query}${hash}`;
}

// `text` outside code: make it safe for MDX and rewrite links. Code spans (they may run over line breaks, not over
// blank lines) are set aside first and put back untouched; a link's label may hold one.
export function inlineMdx(s, ctx) {
  const code = [];
  s = s.replace(/(`+)(?:(?!\1)(?!\n\s*\n)[\s\S])+?\1/g, m => `\u0000C${code.push(m) - 1}\u0000`);
  // autolinks <https://…> → [https://…](https://…)
  const auto = [];
  s = s.replace(/<((?:https?|mailto):[^>\s]+)>/g, (_, u) => `\u0000L${auto.push(u) - 1}\u0000`);
  // the few HTML tags we keep, made JSX-friendly
  const keep = [];
  s = s.replace(/<br\s*\/?>|<\/?(?:kbd|sup|sub|b|i|em|strong|code|s)>|<a\s+(?:id|name)=["'][^"']+["']\s*>\s*<\/a>/gi, m =>
    `\u0000K${keep.push(m.replace(/^<br\s*\/?>$/i, "<br />").replace(/<a\s+name=/i, "<a id=")) - 1}\u0000`);
  // links and images: rewrite the target
  const links = [];
  s = s.replace(/(!?\[)((?:[^\[\]]|\[[^\]]*\])*)\]\(\s*<?([^)\s>]*)>?(\s+"[^"]*")?\s*\)/g, (m, open, label, href, title = "") =>
    `\u0000A${links.push({ open, label, to: rewriteHref(href, ctx), title }) - 1}\u0000`);
  s = s.replace(/^(\s*\[[^\]]+\]:\s*)(\S+)/gm, (_, a, href) => a + rewriteHref(href, ctx));   // reference definitions
  const esc = t => t.replace(/[{}]/g, c => "\\" + c).replace(/</g, "&lt;");
  s = esc(s);
  s = s.replace(/\u0000A(\d+)\u0000/g, (_, i) => { const l = links[+i]; return `${l.open}${esc(l.label)}](${l.to}${l.title})`; });
  s = s.replace(/\u0000K(\d+)\u0000/g, (_, i) => keep[+i]);
  s = s.replace(/\u0000L(\d+)\u0000/g, (_, i) => `[${auto[+i]}](${auto[+i]})`);
  return s.replace(/\u0000C(\d+)\u0000/g, (_, i) => code[+i]);
}

const CALLOUT = { NOTE: "Note", TIP: "Tip", IMPORTANT: "Info", WARNING: "Warning", CAUTION: "Warning", INFO: "Info" };
const CALLOUT_WORD = { note: "Note", tip: "Tip", important: "Info", warning: "Warning", caution: "Warning", info: "Info", heads: "Warning" };

// a whole page body (front matter and the first heading already removed) → MDX
export function convertBody(src, ctx) {
  const lines = src.split("\n");
  const out = [];            // { raw: true, s } JSX lines we write; { raw: false, s } Markdown lines (inline pass later)
  const md = s => out.push({ raw: false, s });
  const jsx = s => { out.push({ raw: false, s: "" }, { raw: true, s }, { raw: false, s: "" }); };
  let fence = null;
  const divs = [];           // open <div> blocks: what each one closes with
  let pendingCardTitle = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = line.match(/^(\s{0,3})(`{3,}|~{3,})(.*)$/);
    if (fence) {
      out.push({ raw: true, s: line });
      if (f && f[2][0] === fence[0] && f[2].length >= fence.length && !f[3].trim()) fence = null;
      continue;
    }
    if (f) { fence = f[2]; out.push({ raw: true, s: line }); continue; }
    if (/^ {4,}\S/.test(line) && (i === 0 || !lines[i - 1].trim()) && !/^\s*([-*+]|\d+\.)\s/.test(lines[i - 2] ?? "") && isIndentedCode(lines, i))
      ctx.warn(`line ${i + 1}: an indented code block (MDX has none; use a fence)`);
    // HTML comments → MDX comments
    if (/^\s*<!--/.test(line)) {
      let j = i, text = line;
      while (!text.includes("-->") && j + 1 < lines.length) text += "\n" + lines[++j];
      const inner = text.replace(/^\s*<!--/, "").replace(/-->\s*$/, "").replace(/\*\//g, "* /").trim();
      out.push({ raw: true, s: `{/* ${inner} */}` });
      i = j; continue;
    }
    // <div class="…"> wrappers from the VitePress pages
    const div = line.match(/^\s*<div\s+class=["']([^"']+)["']\s*>\s*$/);
    if (div) {
      const cls = div[1];
      if (cls === "tl-paths" || cls === "tl-shots") { jsx(`<Columns cols={2}>`); divs.push("</Columns>"); }
      else if (cls === "tl-path") { divs.push("</Card>"); pendingCardTitle = true; }
      else { jsx(`<div className=${attr(cls)}>`); divs.push("</div>"); }
      continue;
    }
    if (/^\s*<\/div>\s*$/.test(line) && divs.length) {
      if (pendingCardTitle) { jsx("<Card>"); pendingCardTitle = false; }
      jsx(divs.pop()); continue;
    }
    if (pendingCardTitle) {
      const h = line.match(/^#{2,6}\s+(.+)$/);
      if (h) {
        const e = h[1].match(EMOJI_RE), icon = e && (EMOJI_ICON[e[1]] || EMOJI_ICON[e[1].replace(/️/, "")]);
        const title = plain(h[1].replace(EMOJI_RE, ""));
        jsx(`<Card title=${attr(title)}${icon ? ` icon=${attr(icon)}` : ""}>`);
        pendingCardTitle = false; continue;
      }
      if (line.trim()) { jsx("<Card>"); pendingCardTitle = false; }
      else continue;
    }
    // images on their own inside a two-column grid: one column each
    // blockquotes: GitHub alerts (> [!NOTE]) and > **Note:** become callouts
    if (/^\s{0,3}>/.test(line)) {
      const block = [];
      let j = i;
      while (j < lines.length && /^\s{0,3}>/.test(lines[j])) block.push(lines[j++].replace(/^\s{0,3}>\s?/, ""));
      let kind = null;
      const alert = block[0].match(/^\[!(\w+)\]\s*$/);
      if (alert && CALLOUT[alert[1].toUpperCase()]) { kind = CALLOUT[alert[1].toUpperCase()]; block.shift(); }
      else {
        const w = block[0].match(/^\*\*(Note|Tip|Important|Warning|Caution|Info|Heads up)[:.]?\*\*:?\s*/i);
        if (w) { kind = CALLOUT_WORD[w[1].toLowerCase().split(" ")[0]]; block[0] = block[0].slice(w[0].length); }
      }
      if (kind) {
        jsx(`<${kind}>`);
        for (const b of convertBody(block.join("\n"), ctx).split("\n")) out.push({ raw: true, s: b });
        jsx(`</${kind}>`);
      } else for (const b of block) md("> " + b);
      i = j - 1; continue;
    }
    // a paragraph that starts with **Note:** / **Tip:** / **Warning:**
    const w = line.match(/^\*\*(Note|Tip|Warning|Important|Caution)[:.]\*\*\s*|^\*\*(Note|Tip|Warning|Important|Caution)\*\*:\s*/);
    if (w && (i === 0 || !lines[i - 1].trim())) {
      const kind = CALLOUT_WORD[(w[1] || w[2]).toLowerCase()];
      const para = [line.slice(w[0].length)];
      let j = i + 1;
      while (j < lines.length && lines[j].trim() && !/^\s{0,3}(#|```|~~~|[-*+] |\d+\. |\|)/.test(lines[j])) para.push(lines[j++]);
      jsx(`<${kind}>`);
      out.push({ raw: true, s: inlineMdx(para.join("\n"), ctx) });
      jsx(`</${kind}>`);
      i = j - 1; continue;
    }
    // headings with an explicit {#id}: MDX would read the braces as code
    const hid = line.match(/^(#{1,6}\s+.*?)\s*\{#([\w-]+)\}\s*$/);
    if (hid) { md(`${hid[1]}`); ctx.warn(`line ${i + 1}: {#${hid[2]}} dropped (Mintlify makes its own heading ids)`); continue; }
    // ESM look-alikes: a paragraph starting with "import " or "export " would be read as JavaScript
    if (/^(import|export)\s/.test(line) && (i === 0 || !lines[i - 1].trim())) { md(line.replace(/^(i|e)/, c => `&#${c.charCodeAt(0)};`)); continue; }
    md(line);
  }
  if (fence) ctx.warn("an unclosed code fence");
  while (divs.length) { ctx.warn("an unclosed <div>"); jsx(divs.pop()); }
  // inline pass over runs of Markdown lines (so code spans over line breaks stay whole)
  const res = [];
  let run = [];
  const flush = () => { if (run.length) { res.push(inlineMdx(run.join("\n"), ctx)); run = []; } };
  for (const o of out) { if (o.raw) { flush(); res.push(o.s); } else run.push(o.s); }
  flush();
  // images in a <Columns> grid: each on its own paragraph, framed
  let text = res.join("\n");
  text = text.replace(/(<Columns cols=\{2\}>\n)([\s\S]*?)(\n<\/Columns>)/g, (m, a, inner, b) => {
    if (!/^\s*(!\[[^\]]*\]\([^)]*\)\s*)+$/.test(inner)) return m;
    const imgs = inner.match(/!\[[^\]]*\]\([^)]*\)/g);
    return a + "\n" + imgs.map(img => `<Frame>\n  ${img}\n</Frame>`).join("\n\n") + "\n" + b;
  });
  return text.replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
function isIndentedCode(lines, i) {
  // a run of 4-space lines after a blank line that isn't inside a list item
  for (let k = i - 1; k >= 0; k--) {
    if (!lines[k].trim()) continue;
    return !/^\s*([-*+]|\d+\.)\s|^\s{2,}\S/.test(lines[k]);
  }
  return true;
}

// ---------- the front matter of docs/index.md (VitePress home layout) → cards ----------
function homeFrontMatter(fm) {
  const get = k => fm.match(new RegExp(`^\\s*${k}:\\s*(.+)$`, "m"))?.[1].trim().replace(/^["']|["']$/g, "");
  const features = [];
  const block = fm.split(/^features:\s*$/m)[1] || "";
  for (const item of block.split(/^\s*-\s+(?=icon:|title:)/m).slice(1)) {
    const f = k => item.match(new RegExp(`^\\s*${k}:\\s*(.+)$`, "m"))?.[1].trim().replace(/^["']|["']$/g, "");
    features.push({ icon: f("icon"), title: f("title"), details: f("details") });
  }
  return { text: get("text"), tagline: get("tagline"), features };
}

// ---------- building everything ----------
export function build() {
  const files = new Map();   // mintlify-relative path → string | Buffer
  const warnings = [];
  const sources = walk(DOCS, f => f.endsWith(".md")).map(f => posix(path.relative(DOCS, f))).filter(r => slugOf(r));
  const srcBySlug = new Map();
  for (const rel of sources) srcBySlug.set(slugOf(rel), rel);
  // anchors that move to a split-off page
  const anchorMoves = new Map(), splitHeads = new Set();   // "api.md#auth" → "websocket"; the split sections' own headings
  const texts = new Map(sources.map(r => [r, readText(path.join(DOCS, r))]));
  const pieces = [];   // { slug, srcRel, body, title, ... }
  for (const rel of sources) {
    let text = texts.get(rel), fm = "";
    const m = text.match(/^---\n([\s\S]*?)\n---\n/);
    if (m) { fm = m[1]; text = text.slice(m[0].length); }
    const h1 = text.match(/^\s*#\s+(.+)\n/);
    let title = h1 ? plain(h1[1]) : null;
    if (h1) text = text.slice(text.indexOf(h1[0]) + h1[0].length);
    const fmField = k => fm.match(new RegExp(`^${k}:\\s*(.+)$`, "m"))?.[1].trim().replace(/^["']|["']$/g, "");
    title = fmField("title") && !/^layout:\s*home/m.test(fm) ? fmField("title") : title;
    let body = text;
    for (const sp of SPLITS.filter(s => s.from === rel)) {
      const ls = body.split("\n");
      const start = ls.findIndex(l => sp.heading.test(l));
      if (start < 0) { warnings.push(`docs/${rel}: no section ${sp.heading} to split off`); continue; }
      const level = ls[start].match(/^#+/)[0].length;
      let end = ls.findIndex((l, k) => k > start && new RegExp(`^#{1,${level}}\\s`).test(l) && !insideFence(ls, k));
      if (end < 0) end = ls.length;
      // the section's sub-headings move up a level (### Server to client → ##); their anchors stay the same
      const section = ls.slice(start + 1, end).map((l, k) => insideFence(ls, start + 1 + k) ? l : l.replace(/^#(#{2,6}\s)/, "$1")).join("\n");
      const hs = headingsOf(ls.slice(start, end));
      for (const h of hs) anchorMoves.set(`${rel}#${h.slug}`, sp.slug);
      splitHeads.add(`${rel}#${hs[0].slug}`);
      body = [...ls.slice(0, start), ls[start].replace(/^(#+\s+).*$/, `$1${sp.sidebarTitle}`), "", sp.stub, "", ...ls.slice(end)].join("\n");
      pieces.push({ slug: sp.slug, srcRel: rel, body: section, title: sp.title, description: sp.description, fm: "", split: sp });
    }
    pieces.push({ slug: slugOf(rel), srcRel: rel, body, title, fm });
  }
  // the moved headings' anchors on the source page: the stub heading keeps the section's own anchor
  for (const p of pieces) {
    const warn = msg => warnings.push(`docs/${p.srcRel}${p.split ? ` (→ ${p.slug})` : ""}: ${msg}`);
    const ctx = { srcRel: p.srcRel, slug: p.slug, anchorMoves, splitHeads, warn };
    const meta = META[p.slug] || {};
    let prefix = "", title = meta.title || p.title || p.slug, description = meta.description || p.description;
    if (p.slug === "overview" && /^layout:\s*home/m.test(p.fm)) {
      const home = homeFrontMatter(p.fm);
      description ||= home.tagline;
      if (home.features.length) {
        prefix = `<Columns cols={2}>\n` + home.features.map(f => {
          const icon = EMOJI_ICON[f.icon] || EMOJI_ICON[(f.icon || "").replace(/️/, "")];
          return `  <Card title=${attr(f.title)}${icon ? ` icon=${attr(icon)}` : ""}>\n    ${inlineMdx(f.details, ctx)}\n  </Card>`;
        }).join("\n") + "\n</Columns>\n\n";
      }
    }
    let src = p.body;
    if (!description) ({ text: description, body: src } = describe(src));
    const body = convertBody(src, ctx);
    const front = ["---", `title: ${yamlStr(title)}`];
    if (meta.sidebarTitle && meta.sidebarTitle !== title) front.push(`sidebarTitle: ${yamlStr(meta.sidebarTitle)}`);
    if (description) front.push(`description: ${yamlStr(description)}`);
    if (meta.icon) front.push(`icon: ${yamlStr(meta.icon)}`);
    front.push("---", "");
    const note = GENERATED_NOTE.replace("SOURCE", p.srcRel);
    files.set(`${p.slug}.mdx`, front.join("\n") + note + "\n\n" + prefix + body);
  }
  // images, logos, favicon
  for (const f of walk(path.join(DOCS, "images"), () => true)) files.set(posix(path.join("images", path.relative(path.join(DOCS, "images"), f))), readFileSync(f));
  const icon = readText(path.join(root, "apps/web/icons/icon.svg"));
  files.set("favicon.svg", icon);
  files.set("logo/light.svg", wordmark(icon, "#1c2026"));
  files.set("logo/dark.svg", wordmark(icon, "#e6e9ee"));
  // docs.json
  const pageSlugs = new Set([...files.keys()].filter(k => k.endsWith(".mdx")).map(k => k.slice(0, -4)));
  if (existsSync(path.join(OUT, "index.mdx"))) pageSlugs.add("index");
  files.set("docs.json", JSON.stringify(docsJson(pageSlugs, warnings), null, 2) + "\n");
  return { files, warnings };
}
function insideFence(lines, k) {
  let fence = null;
  for (let i = 0; i < k; i++) {
    const f = lines[i].match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !f[2].trim()) fence = null; }
    else if (f) fence = f[1];
  }
  return Boolean(fence);
}

// the app icon next to the name, for the navbar
function wordmark(iconSvg, color) {
  const inner = iconSvg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "").trim();
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 560 128" width="560" height="128" role="img" aria-label="Tempolight">
  <svg x="0" y="0" width="128" height="128" viewBox="0 0 128 128">
  ${inner.replace(/\n/g, "\n  ")}
  </svg>
  <text x="152" y="88" fill="${color}" font-family="system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif" font-size="72" font-weight="700" letter-spacing="-1">Tempolight</text>
</svg>
`;
}

function docsJson(pageSlugs, warnings) {
  const placed = new Set();
  const take = p => {
    if (p.endsWith("/*")) {
      const dir = p.slice(0, -1);
      return [...pageSlugs].filter(s => s.startsWith(dir) && !placed.has(s)).sort().map(s => (placed.add(s), s));
    }
    if (!pageSlugs.has(p)) { if (p !== "index" && p !== "setup-with-claude") warnings.push(`docs.json: page "${p}" is in the navigation but doesn't exist; left out`); return []; }
    if (placed.has(p)) return [];
    placed.add(p); return [p];
  };
  // first pass: everything listed by name (so a wildcard doesn't grab a page listed elsewhere)
  const named = NAV.flatMap(t => t.groups.flatMap(g => (g.pages || []).filter(p => !p.endsWith("/*"))));
  const tabs = NAV.map(t => ({
    tab: t.tab, icon: t.icon,
    groups: t.groups.map(g => {
      if (g.openapi) return { group: g.group, openapi: g.openapi };
      const pages = (g.pages || []).flatMap(p => p.endsWith("/*")
        ? take(p).filter(s => !named.includes(s))
        : take(p));
      return { group: g.group, pages, rest: g.rest };
    }),
  }));
  for (const s of named) placed.add(s);
  const rest = [...pageSlugs].filter(s => !placed.has(s)).sort();
  for (const t of tabs) for (const g of t.groups) if (g.rest) { g.pages.push(...rest); delete g.rest; }
  for (const t of tabs) t.groups = t.groups.filter(g => g.openapi || g.pages.length);
  return {
    $schema: "https://mintlify.com/docs.json",
    theme: "mint",
    name: "Tempolight",
    description: "Music-reactive lighting that understands the song: beats, build-ups, drops and mood. For WLED and many more lights.",
    colors: { primary: "#b86f00", light: "#f5a524", dark: "#b86f00" },
    background: { color: { light: "#ffffff", dark: "#111317" } },
    appearance: { default: "dark" },
    icons: { library: "lucide" },
    logo: { light: "/logo/light.svg", dark: "/logo/dark.svg", href: "/" },
    favicon: "/favicon.svg",
    styling: { eyebrows: "section", codeblocks: "system", latex: false },
    navbar: {
      links: [{ type: "github", href: REPO }],
      primary: { type: "button", label: "Try the demo", href: `${DEMO}/demo/` },
    },
    navigation: {
      global: {
        anchors: [
          { anchor: "GitHub", icon: "github", href: REPO },
          { anchor: "Online demo", icon: "monitor-play", href: `${DEMO}/demo/` },
          { anchor: "Releases", icon: "tag", href: `${REPO}/releases` },
        ],
      },
      tabs,
    },
    // Tempolight runs on the reader's own network and refuses requests from other websites: no "try it" button
    api: { playground: { display: "simple" }, examples: { languages: ["curl", "javascript", "python"] } },
    contextual: { options: ["copy", "view", "chatgpt", "claude"] },
    footer: { socials: { github: REPO } },
  };
}

// ---------- checks ----------
// MDX trouble outside code: a bare < (not a tag we emit), a bare { or }, HTML comments, leftover .md links
const JSX_TAGS = /^<\/?(Note|Tip|Warning|Info|Check|Danger|Card|Columns|Column|Frame|Steps|Step|Tabs|Tab|CodeGroup|Accordion|AccordionGroup|Icon|Tooltip|div|span|a|img|br|kbd|sup|sub|b|i|em|strong|code|s|p|h1|h2|h3|section|Visibility|Badge|Update|Tile)\b/;
export function lintMdx(text) {
  const problems = [];
  const blank = m => m.replace(/[^\n]/g, " ");
  // front matter, fences, code spans (over line breaks too) and MDX comments out; newlines kept for line numbers
  let t = text.replace(/^---\n[\s\S]*?\n---\n/, blank);
  const lines = t.split("\n");
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const f = lines[i].match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !f[2].trim()) fence = null; lines[i] = ""; continue; }
    if (f) { fence = f[1]; lines[i] = ""; }
  }
  if (fence) problems.push("unclosed code fence");
  t = lines.join("\n").replace(/(`+)(?:(?!\1)(?!\n\s*\n)[\s\S])+?\1/g, blank).replace(/\{\/\*[\s\S]*?\*\/\}/g, blank);
  t.split("\n").forEach((line, i) => {
    let s = line;
    if (/<!--/.test(s)) problems.push(`${i + 1}: HTML comment (use {/* */})`);
    // JSX attribute expressions we write ourselves: cols={2}
    s = s.replace(/=\{[\w.]+\}/g, "=\"\"");
    for (const m of s.matchAll(/\\?[{}]/g)) if (m[0].length === 1) problems.push(`${i + 1}: unescaped "${m[0]}"`);
    for (const m of s.matchAll(/<(?!\s*$)/g)) {
      const rest = s.slice(m.index);
      if (!JSX_TAGS.test(rest)) problems.push(`${i + 1}: "<" that isn't a tag: ${rest.slice(0, 30)}`);
    }
    for (const m of s.matchAll(/\]\(([^)\s]+)\)/g)) if (!isExternal(m[1]) && /\.md(#|$)/.test(m[1])) problems.push(`${i + 1}: link to a .md file: ${m[1]}`);
  });
  return problems;
}

// pages, links and images in the finished site
export function checkSite(files) {
  const problems = [];
  const pages = new Map();   // slug → text
  for (const [k, v] of files) if (k.endsWith(".mdx")) pages.set(k.slice(0, -4), String(v));
  const anchors = new Map([...pages].map(([slug, t]) => [slug, new Set(headingsOf(t.split("\n")).map(h => h.slug))]));
  let docs;
  try { docs = JSON.parse(String(files.get("docs.json"))); } catch (e) { return [`docs.json: ${e.message}`]; }
  problems.push(...validateDocsJson(docs).map(p => `docs.json: ${p}`));
  // every page in the navigation exists
  const navPages = [];
  const visit = n => {
    if (Array.isArray(n)) return n.forEach(visit);
    if (typeof n === "string") return navPages.push(n);
    if (n && typeof n === "object") for (const k of ["tabs", "groups", "pages", "anchors", "menu"]) if (n[k]) visit(n[k]);
  };
  visit(docs.navigation);
  for (const p of navPages) if (!/^(GET|POST|PUT|PATCH|DELETE) /.test(p) && !pages.has(p)) problems.push(`docs.json: navigation page "${p}" has no ${p}.mdx`);
  for (const slug of pages.keys()) if (!navPages.includes(slug)) problems.push(`${slug}.mdx: not in the navigation`);
  // every internal link and image resolves
  for (const [slug, text] of pages) {
    const body = text.replace(/^---\n[\s\S]*?\n---\n/, "").replace(/(^|\n)\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, "\n").replace(/`[^`\n]*`/g, "");
    const refs = [...body.matchAll(/!?\[(?:[^\[\]]|\[[^\]]*\])*\]\(([^)\s]+)/g)].map(m => m[1]);
    refs.push(...[...body.matchAll(/\b(?:href|src|img)=["']([^"']+)["']/g)].map(m => m[1]));
    for (const r of refs) {
      if (isExternal(r)) continue;
      const [p, a] = r.split("#");
      if (!p) { if (a && !anchors.get(slug).has(a)) problems.push(`${slug}.mdx: no heading for #${a}`); continue; }
      if (!p.startsWith("/")) { problems.push(`${slug}.mdx: relative link ${r} (use /path)`); continue; }
      const t = p.slice(1).replace(/\/$/, "") || "index";
      if (files.has(t)) continue;                                              // an image or other file
      if (/\.(png|jpe?g|gif|svg|webp|avif|mp4)$/i.test(t)) { problems.push(`${slug}.mdx: missing image ${r}`); continue; }
      if (!pages.has(t)) { problems.push(`${slug}.mdx: link to a missing page ${r}`); continue; }
      if (a && !anchors.get(t).has(a)) problems.push(`${slug}.mdx: no heading #${a} in ${t}.mdx`);
    }
    for (const p of lintMdx(text)) problems.push(`${slug}.mdx:${p}`);
  }
  for (const k of ["logo", "favicon"]) {
    const v = docs[k], list = typeof v === "string" ? [v] : ["light", "dark"].map(m => v?.[m]).filter(Boolean);
    for (const f of list) if (!files.has(f.slice(1))) problems.push(`docs.json: ${k} ${f} is missing`);
  }
  for (const f of openapiFiles(docs.navigation)) if (!files.has(f.replace(/^\//, ""))) console.warn(`warning: docs.json uses ${f}, which isn't in mintlify/ yet (scripts/gen-openapi.js makes it)`);
  return problems;
}
function openapiFiles(n, out = new Set()) {
  if (Array.isArray(n)) n.forEach(x => openapiFiles(x, out));
  else if (n && typeof n === "object") for (const [k, v] of Object.entries(n)) {
    if (k === "openapi") { const src = typeof v === "string" ? v : v?.source; if (src && !isExternal(src)) out.add(src); }
    else openapiFiles(v, out);
  }
  return out;
}

// docs.json against the documented schema (https://mintlify.com/docs.json): the parts this site uses
const THEMES = ["mint", "maple", "palm", "willow", "linden", "almond", "aspen", "sequoia", "luma"];
export function validateDocsJson(d) {
  const p = [];
  const hex = v => typeof v === "string" && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v);
  const allowedTop = ["$schema", "theme", "name", "description", "colors", "logo", "favicon", "api", "appearance", "background",
    "navbar", "navigation", "footer", "banner", "redirects", "contextual", "fonts", "icons", "styling", "integrations", "seo",
    "search", "metadata", "variables", "errors", "interaction", "thumbnails", "feedback", "markdown"];
  for (const k of Object.keys(d)) if (!allowedTop.includes(k)) p.push(`unknown key "${k}"`);
  if (!THEMES.includes(d.theme)) p.push(`theme must be one of ${THEMES.join(", ")}`);
  if (typeof d.name !== "string" || !d.name) p.push("name is required");
  if (!d.colors || !hex(d.colors.primary)) p.push("colors.primary must be a hex colour");
  for (const k of ["light", "dark"]) if (d.colors?.[k] !== undefined && !hex(d.colors[k])) p.push(`colors.${k} must be a hex colour`);
  if (d.appearance && !["system", "light", "dark"].includes(d.appearance.default)) p.push("appearance.default");
  if (d.icons && !["fontawesome", "lucide", "tabler"].includes(d.icons.library)) p.push("icons.library");
  if (d.logo && typeof d.logo === "object" && (!d.logo.light || !d.logo.dark)) p.push("logo needs light and dark");
  for (const l of d.navbar?.links || []) {
    if (!l.href) p.push("navbar.links[].href is required");
    if (l.type && !["github", "discord"].includes(l.type)) p.push("navbar.links[].type");
    if (!l.type && !l.label) p.push("navbar.links[].label is required without a type");
  }
  if (d.navbar?.primary && (!["button", "github", "discord"].includes(d.navbar.primary.type) || !d.navbar.primary.href
    || (d.navbar.primary.type === "button" && !d.navbar.primary.label))) p.push("navbar.primary");
  const socials = ["x", "website", "facebook", "youtube", "discord", "slack", "github", "linkedin", "instagram", "hacker-news", "medium", "telegram", "twitter", "x-twitter", "earth-americas", "bluesky", "threads", "reddit", "podcast"];
  for (const k of Object.keys(d.footer?.socials || {})) if (!socials.includes(k)) p.push(`footer.socials.${k}`);
  const nav = d.navigation;
  if (!nav || typeof nav !== "object") { p.push("navigation is required"); return p; }
  for (const a of nav.global?.anchors || []) if (!a.anchor || !a.href) p.push("navigation.global.anchors[] needs anchor and href");
  const roots = ["pages", "groups", "tabs", "anchors", "dropdowns", "products", "versions", "languages"].filter(k => nav[k]);
  if (roots.length !== 1) p.push(`navigation needs exactly one of pages/groups/tabs/anchors/…, has ${roots.join(", ") || "none"}`);
  const group = (g, where) => {
    if (typeof g === "string") return;
    if (!g.group) p.push(`${where}: a group needs "group"`);
    if (!g.pages && !g.openapi) p.push(`${where} "${g.group}": needs pages or openapi`);
    for (const k of Object.keys(g)) if (!["group", "pages", "icon", "tag", "expanded", "root", "openapi", "hidden", "public", "asyncapi"].includes(k)) p.push(`${where} "${g.group}": unknown key ${k}`);
    (g.pages || []).forEach((x, i) => group(x, `${where}.pages[${i}]`));
  };
  (nav.tabs || []).forEach((t, i) => {
    if (!t.tab) p.push(`navigation.tabs[${i}] needs "tab"`);
    const kids = ["pages", "groups", "anchors", "dropdowns", "menu", "href", "openapi"].filter(k => t[k]);
    if (!kids.length) p.push(`navigation.tabs[${i}] "${t.tab}" is empty`);
    (t.groups || []).forEach((g, j) => group(g, `navigation.tabs[${i}].groups[${j}]`));
  });
  if (d.api?.playground && !["interactive", "simple", "none", "auth"].includes(d.api.playground.display)) p.push("api.playground.display");
  return p;
}

// ---------- write / check ----------
function existing() {
  const map = new Map();
  for (const f of walk(OUT, () => true)) {
    const rel = posix(path.relative(OUT, f));
    if (rel.startsWith(".")) continue;
    map.set(rel, readFileSync(f));
  }
  return map;
}
const same = (a, b) => {
  const isText = x => typeof x === "string";
  if (isText(a) || isText(b)) return String(a).replace(/\r\n?/g, "\n") === String(b).replace(/\r\n?/g, "\n");
  return Buffer.compare(a, b) === 0;
};

function mermaidCheck(files) {
  const mmdc = process.env.MMDC || "mmdc";
  const dir = mkdtempSync(path.join(os.tmpdir(), "tl-mint-"));
  const problems = [];
  try {
    let n = 0;
    for (const [k, v] of files) {
      if (!k.endsWith(".mdx")) continue;
      for (const m of String(v).matchAll(/^```mermaid[^\n]*\n([\s\S]*?)\n```$/gm)) {
        const f = path.join(dir, `d${n++}.mmd`);
        writeFileSync(f, m[1]);
        const r = spawnSync(mmdc, ["-q", "-i", f, "-o", f + ".svg"], { encoding: "utf8", shell: process.platform === "win32" });
        if (r.status !== 0) problems.push(`${k}: a Mermaid diagram doesn't compile: ${(r.stderr || r.error?.message || "").split("\n").slice(0, 3).join(" ")}`);
      }
    }
    console.log(`${n} Mermaid diagrams compiled`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  return problems;
}

export function run(args) {
  const { files, warnings } = build();
  for (const w of warnings) console.warn("warning: " + w);
  const disk = existing();
  // the site as it will be: generated files plus the hand-written ones
  const site = new Map(files);
  for (const h of HAND_WRITTEN) if (disk.has(h)) site.set(h, disk.get(h));
  if (args.includes("--check")) {
    const problems = [];
    for (const [k, v] of files) {
      if (!disk.has(k)) problems.push(`mintlify/${k} is missing`);
      else if (!same(v, disk.get(k))) problems.push(`mintlify/${k} is out of date`);
    }
    for (const k of disk.keys()) if (!files.has(k) && !HAND_WRITTEN.has(k)) problems.push(`mintlify/${k} isn't made from docs/ any more (delete it)`);
    if (problems.length) problems.push("run: node scripts/build-mintlify.js");
    problems.push(...checkSite(site));
    if (args.includes("--mermaid")) problems.push(...mermaidCheck(site));
    if (problems.length) { console.error(problems.join("\n")); return 1; }
    console.log(`mintlify/ is up to date: ${[...site.keys()].filter(k => k.endsWith(".mdx")).length} pages, all links, images and the navigation check out`);
    return 0;
  }
  mkdirSync(OUT, { recursive: true });
  let written = 0;
  for (const [k, v] of files) {
    if (disk.has(k) && same(v, disk.get(k))) continue;
    mkdirSync(path.dirname(path.join(OUT, k)), { recursive: true });
    writeFileSync(path.join(OUT, k), v);
    written++;
  }
  for (const k of disk.keys()) if (!files.has(k) && !HAND_WRITTEN.has(k)) { rmSync(path.join(OUT, k)); console.log(`removed mintlify/${k}`); }
  const problems = checkSite(site);
  console.log(`mintlify/: ${files.size} files (${written} changed)`);
  if (problems.length) { console.error(problems.join("\n")); return 1; }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = run(process.argv.slice(2));
