#!/usr/bin/env node
// Checks the documentation without building the site (no dependencies):
//   1. every ```mermaid block in README.md and docs/**/*.md compiles with the Mermaid CLI (mmdc),
//   2. every relative Markdown link, image and HTML src/href resolves to a file in the repository,
//   3. pages that go on the docs site (docs/**) have nothing VitePress would choke on: {{ … }} outside code (Vue would
//      read it as a template expression) and <words> that look like HTML tags but aren't (Vue fails on the unclosed tag).
// Exits non-zero on any problem.
//   npm run docs:check                      # all checks (needs mmdc on PATH, or MMDC="npx -y @mermaid-js/mermaid-cli@…")
//   node scripts/check-docs.js --no-mermaid # links and site checks only (fast; what CI runs on every push)
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docs = path.join(root, "docs");
const args = new Set(process.argv.slice(2));
const withMermaid = !args.has("--no-mermaid");
const problems = [];
const rel = f => path.relative(root, f).split(path.sep).join("/");
const report = (file, line, msg) => problems.push(`${rel(file)}:${line}: ${msg}`);

// ---- files ----
const SKIP_DIRS = new Set(["node_modules", ".vitepress", "flash", "public", ".git"]);
function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), out); }
    else if (e.name.endsWith(".md")) out.push(path.join(dir, e.name));
  }
  return out;
}
const files = [path.join(root, "README.md"), ...walk(docs)].filter(f => existsSync(f));

// ---- Markdown scanning: fenced code blocks out, line numbers kept ----
function scan(text) {
  const lines = text.split(/\r?\n/), prose = [], fences = [];
  let fence = null;
  lines.forEach((line, i) => {
    const m = line.match(/^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)/);
    if (fence) {
      if (m && m[1][0] === fence.mark[0] && m[1].length >= fence.mark.length && !line.trim().slice(m[1].length)) { fences.push(fence); fence = null; }
      else fence.body.push(line);
      prose.push("");
    } else if (m) { fence = { mark: m[1], lang: m[2].toLowerCase(), line: i + 1, body: [] }; prose.push(""); }
    else prose.push(line);
  });
  if (fence) fences.push({ ...fence, unclosed: true });
  return { prose, fences };
}
// code spans can run over a line break (not over a blank line); newlines are kept so line numbers stay right
const stripInlineCode = text => text.replace(/(`+)(?:(?!\1)(?!\n\s*\n)[\s\S])+?\1/g, m => m.replace(/[^\n]/g, " "));
const stripHtmlComments = text => text.replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, " "));

// ---- links ----
const isExternal = t => /^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith("//");
// heading anchors, as GitHub makes them and as VitePress makes them (a link is fine if either matches)
const anchorCache = new Map();
function anchorsOf(file) {
  if (anchorCache.has(file)) return anchorCache.get(file);
  const set = new Set(), seen = new Map();
  const text = readFileSync(file, "utf8");
  for (const line of scan(text).prose) {
    const h = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (h) {
      let t = h[1];
      const explicit = t.match(/\{#([\w-]+)\}\s*$/);
      if (explicit) { set.add(explicit[1]); t = t.replace(/\s*\{#[\w-]+\}\s*$/, ""); }
      t = t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/<[^>]+>/g, "").replace(/[`*]/g, "").replace(/(^|\s)_+|_+(\s|$)/g, "$1$2");
      const gh = t.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
      const n = seen.get(gh) ?? 0; seen.set(gh, n + 1);
      set.add(n ? `${gh}-${n}` : gh);
      const vp = t.normalize("NFKD").replace(/[\u0300-\u036F]/g, "").replace(/[\u0000-\u001f]/g, "")
        .replace(/[\s~`!@#$%^&*()\-_+=[\]{}|\\;:"'“”‘’<>,.?/]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "")
        .replace(/^(\d)/, "_$1").toLowerCase();
      set.add(vp); if (n) set.add(`${vp}-${n}`);
    }
    for (const m of line.matchAll(/<a\s+(?:id|name)=["']([^"']+)["']/g)) set.add(m[1]);
  }
  anchorCache.set(file, set);
  return set;
}
function resolveTarget(file, target) {
  let t = target.trim().replace(/^<|>$/g, "");
  if (!t || isExternal(t)) return null;
  const hash = t.includes("#") ? t.slice(t.indexOf("#") + 1) : "";
  t = t.split("#")[0].split("?")[0];
  if (!t) {   // #anchor in the same file
    if (!hash || anchorsOf(file).has(decodeURIComponent(hash).toLowerCase())) return null;
    return { target, ok: false, why: "no such heading" };
  }
  try { t = decodeURIComponent(t); } catch {}
  const inDocs = file.startsWith(docs + path.sep);
  const base = t.startsWith("/") ? (inDocs ? docs : root) : path.dirname(file);
  const p = path.join(base, t.startsWith("/") ? t.slice(1) : t);
  // on the docs site "/images/x.svg" can also be a file in docs/public
  const candidates = [p, p + ".md", path.join(p, "index.md"), path.join(p, "README.md")];
  if (inDocs && t.startsWith("/")) candidates.push(path.join(docs, "public", t.slice(1)));
  const found = candidates.find(c => existsSync(c) && (c === p || statSync(c).isFile()));
  if (!found) return { target, ok: false };
  const md = statSync(found).isDirectory() ? [path.join(found, "index.md"), path.join(found, "README.md")].find(f => existsSync(f)) : found;
  if (hash && md && md.endsWith(".md") && !anchorsOf(md).has(decodeURIComponent(hash).toLowerCase()))
    return { target, ok: false, why: "no such heading" };
  return { target, ok: true };
}
function checkLinks(file, prose) {
  const text = stripInlineCode(stripHtmlComments(prose.join("\n"))).split("\n");
  text.forEach((line, i) => {
    const found = [];
    for (const m of line.matchAll(/!?\[(?:[^\[\]]|\[[^\]]*\])*\]\(\s*(<[^>]*>|[^\s)]+(?:\([^)]*\)[^\s)]*)*)(?:\s+["'(][^)]*)?\)/g)) found.push(m[1]);
    for (const m of line.matchAll(/^\s{0,3}\[[^\]]+\]:\s*(\S+)/g)) found.push(m[1]);   // [id]: target
    for (const m of line.matchAll(/\s(?:src|href|srcset)\s*=\s*["']([^"']+)["']/gi)) found.push(m[1].split(/\s+/)[0]);
    for (const target of found) {
      const r = resolveTarget(file, target);
      if (r && !r.ok) report(file, i + 1, `broken ${r.why ? `anchor (${r.why})` : "link or image"}: ${target}`);
    }
  });
}

// ---- VitePress safety (docs/ only: README.md isn't on the site) ----
const HTML_TAGS = new Set(("a abbr address area article aside audio b bdi bdo blockquote br button canvas caption cite code col colgroup data dd del details dfn dialog div dl dt em embed fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr i iframe img input ins kbd label legend li main map mark menu meter nav noscript object ol optgroup option output p picture pre progress q rp rt ruby s samp section select small source span strong sub summary sup table tbody td template textarea tfoot th thead time tr track u ul var video wbr svg path g circle rect line polyline polygon defs radialgradient lineargradient stop text tspan font center").split(" "));
const VUE_COMPONENTS = new Set(["Badge", "ClientOnly", "Content", "Mermaid", "VPTeamMembers"]);
function checkSiteSafety(file, prose) {
  const text = stripInlineCode(stripHtmlComments(prose.join("\n"))).split("\n");
  text.forEach((raw, i) => {
    const line = raw.replace(/\\[<{]/g, "  ");
    if (line.includes("{{")) report(file, i + 1, "{{ … }} outside code: Vue reads it as a template expression (put it in `code`)");
    for (const m of line.matchAll(/<\/?([A-Za-z][\w-]*)(?=[\s/>])/g)) {
      const tag = m[1];
      if (!HTML_TAGS.has(tag.toLowerCase()) && !VUE_COMPONENTS.has(tag)) report(file, i + 1, `<${tag}…> looks like an HTML tag to VitePress: put it in \`code\` or write &lt;${tag}&gt;`);
    }
  });
}

// ---- Mermaid ----
const blocks = [];
for (const file of files) {
  const { prose, fences } = scan(readFileSync(file, "utf8"));
  for (const f of fences) {
    if (f.unclosed) report(file, f.line, "code block is never closed");
    if (f.lang === "mermaid") blocks.push({ file, line: f.line, code: f.body.join("\n") });
  }
  checkLinks(file, prose);
  if (file.startsWith(docs + path.sep)) checkSiteSafety(file, prose);
}

// the docs site's logo/favicon copy (docs/public) must stay the same file as docs/images/logo.svg
const pubLogo = path.join(docs, "public/images/logo.svg"), logo = path.join(docs, "images/logo.svg");
if (existsSync(pubLogo) && readFileSync(pubLogo, "utf8") !== readFileSync(logo, "utf8")) problems.push("docs/public/images/logo.svg differs from docs/images/logo.svg (copy it again)");

function run(cmd, argv) {
  return new Promise(resolve => {
    const p = spawn(cmd[0], [...cmd.slice(1), ...argv], { stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
    let out = ""; p.stdout.on("data", d => out += d); p.stderr.on("data", d => out += d);
    p.on("error", e => resolve({ code: 127, out: String(e.message) }));
    p.on("close", code => resolve({ code, out }));
  });
}

async function checkMermaid() {
  if (!blocks.length) return;
  const cmd = (process.env.MMDC || "mmdc").split(/\s+/).filter(Boolean);
  const tmp = mkdtempSync(path.join(os.tmpdir(), "tl-mermaid-"));
  // headless Chrome on CI runners (and as root) needs --no-sandbox
  const pptr = path.join(tmp, "puppeteer.json");
  writeFileSync(pptr, JSON.stringify({ args: ["--no-sandbox", "--disable-setuid-sandbox"] }));
  let next = 0, ran = 0;
  const worker = async () => {
    while (next < blocks.length) {
      const b = blocks[next], n = next++;
      const input = path.join(tmp, `block-${n}.mmd`), output = path.join(tmp, `block-${n}.svg`);
      writeFileSync(input, b.code + "\n");
      const r = await run(cmd, ["-q", "-p", pptr, "-i", input, "-o", output]);
      ran++;
      if (r.code === 127) {
        problems.push(`could not run ${cmd.join(" ")} (${r.out.trim()}): install @mermaid-js/mermaid-cli, set MMDC, or pass --no-mermaid`);
        next = blocks.length; return;
      }
      if (r.code !== 0 || !existsSync(output) || statSync(output).size === 0) {
        const msg = r.out.split("\n").filter(l => l.trim() && !/^\s+at /.test(l)).slice(0, 6).join("\n    ");
        report(b.file, b.line, `Mermaid diagram doesn't compile:\n    ${msg || `exit code ${r.code}`}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, blocks.length) }, worker));
  rmSync(tmp, { recursive: true, force: true });
  console.log(`Mermaid: ${ran} diagram(s) compiled with ${cmd.join(" ")}`);
}

if (withMermaid) await checkMermaid();
else console.log(`Mermaid: skipped (${blocks.length} diagram(s) found)`);
console.log(`Checked ${files.length} Markdown file(s): links, images${withMermaid ? ", Mermaid" : ""} and VitePress safety`);
if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n` + problems.map(p => "  " + p).join("\n"));
  process.exit(1);
}
console.log("Docs OK");
