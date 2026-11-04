// The Tempolight documentation site. The pages are the Markdown files in ../../docs (they read fine on GitHub too);
// this folder only holds the site's settings and theme. Run it with `npm install && npm run dev` in website/.
// Published to GitHub Pages by .github/workflows/docs.yml, together with the Tempolight Lite installer at /flash/.
import { defineConfig, type DefaultTheme } from "vitepress";
import { cpSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const docsDir = path.join(repoRoot, "docs");

const REPO = "https://github.com/D4RKGEEK/tempolight";
const DEMO = "https://tempolight.pages.dev";
// GitHub Pages project site by default; the workflow passes the real base path and URL (a custom domain changes both)
const base = withSlashes(process.env.DOCS_BASE || "/tempolight/");
const siteUrl = (process.env.DOCS_URL || `https://d4rkgeek.github.io${base}`).replace(/\/?$/, "/");

function withSlashes(p: string) { return ("/" + p + "/").replace(/\/+/g, "/"); }

// ---------- sidebar: built from the files that exist, so pages other people add show up by themselves ----------

type Page = { file: string; link: string; title: string; order: number; named: boolean };

function readPage(file: string): Page {
  const src = readFileSync(file, "utf8");
  const fm = src.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const field = (k: string) => fm?.[1].match(new RegExp(`^${k}:\\s*["']?(.+?)["']?\\s*$`, "m"))?.[1];
  const heading = src.replace(/```[\s\S]*?```/g, "").match(/^#\s+(.+)$/m)?.[1];
  const clean = (t: string) => t.replace(/`/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*_]/g, "").trim();
  let rel = path.relative(docsDir, file).split(path.sep).join("/").replace(/\.md$/, "");
  rel = rel === "index" ? "" : rel.replace(/(^|\/)index$/, "$1");
  return {
    file,
    link: "/" + rel,
    title: clean(field("sidebarTitle") || field("title") || heading || path.basename(file, ".md")),
    order: Number(field("order") ?? 1000),
    named: Boolean(field("sidebarTitle") || field("title")),
  };
}

const used = new Set<string>();
// a known page, wherever it lives now (docs/<slug>.md or docs/guides/<slug>.md); left out if it doesn't exist (yet).
// `text` is a shorter name for the sidebar, unless the page sets its own (sidebarTitle or title in its front matter)
function page(slug: string, text?: string): DefaultTheme.SidebarItem[] {
  for (const f of [`${slug}.md`, `guides/${slug}.md`, `internals/${slug}.md`, `${slug}/index.md`]) {
    const file = path.join(docsDir, f);
    if (existsSync(file) && !used.has(file)) {
      used.add(file);
      const p = readPage(file);
      return [{ text: p.named ? p.title : text ?? p.title, link: p.link }];
    }
  }
  return [];
}
// every other page in a folder (index first, then by `order:` in the front matter, then by title)
function folder(dir: string): DefaultTheme.SidebarItem[] {
  const abs = path.join(docsDir, dir);
  if (!existsSync(abs)) return [];
  const pages: Page[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory() && !["flash", "public", "images", "node_modules"].includes(e.name)) walk(f);
      else if (e.name.endsWith(".md") && !used.has(f) && !(d === docsDir && e.name === "index.md")) pages.push(readPage(f));
    }
  };
  walk(abs);
  pages.sort((a, b) => Number(!a.file.endsWith("index.md")) - Number(!b.file.endsWith("index.md"))
    || a.order - b.order || a.title.localeCompare(b.title));
  return pages.map(p => { used.add(p.file); return { text: p.title, link: p.link }; });
}
// where a known page is now, for the top bar (falls back to the old place)
function linkOf(slug: string): string {
  for (const f of [`${slug}.md`, `guides/${slug}.md`, `internals/${slug}.md`, `${slug}/index.md`])
    if (existsSync(path.join(docsDir, f))) return readPage(path.join(docsDir, f)).link;
  return "/" + slug;
}
const group = (text: string, items: DefaultTheme.SidebarItem[], collapsed?: boolean): DefaultTheme.SidebarItem[] =>
  items.length ? [{ text, items, collapsed }] : [];

function sidebar(): DefaultTheme.SidebarItem[] {
  used.clear();
  used.add(path.join(docsDir, "index.md"));
  const start = [
    { text: "Overview", link: "/" },
    ...page("getting-started"), ...page("install", "Install"), ...page("hearing-music"),
  ];
  const lights = [...page("protocols", "Lights and protocols"), ...page("raspberry-pi"), ...page("tempolight-lite", "Tempolight Lite (ESP32)")];
  const music = [...page("spotify"), ...page("effects")];
  const home = [...page("voice"), ...page("wake-up", "Wake-up, sleep and ambient")];
  const streaming = [...page("integrations", "OBS, games, Twitch, Discord"), ...page("streamdeck")];
  const hosting = [...page("deploy-cloudflare", "Host the online demo")];
  const guides = folder("guides");
  const reference = [...page("api", "HTTP and WebSocket API"), ...page("architecture")];
  const internals = folder("internals");
  const project = [
    ...page("roadmap"),
    { text: "Changelog", link: `${REPO}/blob/main/CHANGELOG.md` },
    { text: "Contributing", link: `${REPO}/blob/main/CONTRIBUTING.md` },
    { text: "Security", link: `${REPO}/blob/main/SECURITY.md` },
  ];
  const more = folder(".");   // anything new at the top of docs/ that isn't listed above
  return [
    ...group("Start here", start),
    ...group("Guides", guides),
    ...group("Lights and hardware", lights),
    ...group("Music and effects", music),
    ...group("Smart home", home),
    ...group("Streaming and gaming", streaming),
    ...group("Hosting", hosting),
    ...group("More", more),
    ...group("Reference", reference),
    ...group("Internals", internals, true),
    ...group("Project", project),
  ];
}

// ---------- links that point outside the site ----------
// Pages link to files in the repository (../CHANGELOG.md, ../packages/…) so they work on GitHub. On the site those
// become GitHub links; the firmware installer (docs/flash) and the landing page (docs/index.html) get their real URLs.
function rewriteHref(href: string, relativePath: string): string | null {
  if (!href || href.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return null;
  const [, pathPart, rest = ""] = href.match(/^([^#?]*)(.*)$/)!;
  if (!pathPart) return null;
  const from = path.dirname(path.join(docsDir, relativePath));
  const abs = pathPart.startsWith("/") ? path.join(docsDir, pathPart) : path.resolve(from, pathPart);
  const inDocs = abs === docsDir || abs.startsWith(docsDir + path.sep);
  const repoRel = path.relative(repoRoot, abs).split(path.sep).join("/");
  const github = () => {
    const isDir = existsSync(abs) && statSync(abs).isDirectory();
    return `${REPO}/${isDir ? "tree" : "blob"}/main/${repoRel}${rest}`;
  };
  if (!inDocs) return github();
  const docsRel = path.relative(docsDir, abs).split(path.sep).join("/");
  if (docsRel === "flash" || docsRel.startsWith("flash/")) return `${siteUrl}flash/`;
  if (docsRel === "index.html") return `${DEMO}/about/`;
  if (/\.md$/.test(abs) || existsSync(abs + ".md") || existsSync(path.join(abs, "index.md"))) return null;  // a page
  if (/\.(png|jpe?g|gif|svg|webp|avif)$/i.test(abs)) return null;  // images are bundled by the site
  return github();
}

export default defineConfig({
  title: "Tempolight",
  description: "Music-reactive lighting that understands the song: beats, build-ups, drops and mood. For WLED and many more lights.",
  lang: "en",
  base,
  srcDir: "../docs",
  ignoreDeadLinks: ["localhostLinks"], // http://localhost:8080 is the reader's own Tempolight, not a page of this site
  outDir: ".vitepress/dist",
  srcExclude: ["**/node_modules/**", "flash/**", "public/**"],
  cleanUrls: true,
  lastUpdated: true,
  appearance: true,
  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: `${base}images/logo.svg` }],
    ["meta", { name: "theme-color", content: "#f5a524" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:title", content: "Tempolight documentation" }],
    ["meta", { property: "og:description", content: "Music-reactive lighting that understands the song." }],
    ["meta", { property: "og:image", content: `${siteUrl}images/logo.svg` }],
  ],

  themeConfig: {
    logo: { src: "/images/logo.svg", alt: "Tempolight" },
    nav: [
      { text: "Get started", link: linkOf("getting-started"), activeMatch: "^/(getting-started|install|hearing-music|guides/)" },
      { text: "Reference", link: linkOf("api"), activeMatch: "^/(api|architecture|protocols|effects|internals/)" },
      { text: "Online demo", link: DEMO },
      { text: "Flash Lite", link: `${siteUrl}flash/` },
      {
        text: "Download",
        items: [
          { text: "Latest release", link: `${REPO}/releases/latest` },
          { text: "Changelog", link: `${REPO}/blob/main/CHANGELOG.md` },
          { text: "Roadmap", link: linkOf("roadmap") },
        ],
      },
    ],
    sidebar: sidebar(),
    socialLinks: [{ icon: "github", link: REPO }],
    editLink: { pattern: `${REPO}/edit/main/docs/:path`, text: "Edit this page on GitHub" },
    search: { provider: "local" },
    outline: { level: [2, 3], label: "On this page" },
    lastUpdated: { text: "Updated" },
    externalLinkIcon: true,
    footer: {
      message: 'Released under the <a href="https://github.com/D4RKGEEK/tempolight/blob/main/LICENSE">MIT licence</a>.',
      copyright: "© 2026 D4RKGEEK and Tempolight contributors",
    },
  },

  markdown: {
    image: { lazyLoading: true },
    config(md) {
      // ```mermaid blocks become a <Mermaid> component, rendered in the browser (and again when the theme changes)
      const fence = md.renderer.rules.fence!;
      md.renderer.rules.fence = (tokens, idx, options, env, self) => {
        const t = tokens[idx];
        if (t.info.trim().split(/\s+/)[0] === "mermaid") return `<Mermaid code="${encodeURIComponent(t.content)}" />\n`;
        return fence(tokens, idx, options, env, self);
      };
      // `{{version}}` in inline code must stay text, not become a Vue expression (fenced blocks already get v-pre)
      const codeInline = md.renderer.rules.code_inline!;
      md.renderer.rules.code_inline = (tokens, idx, options, env, self) => {
        tokens[idx].attrSet("v-pre", "");
        return codeInline(tokens, idx, options, env, self);
      };
      // links to repository files outside docs/ go to GitHub (runs before VitePress's own link handling)
      const linkOpen = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
      md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
        const t = tokens[idx], href = t.attrGet("href");
        const to = href && rewriteHref(href, env.relativePath ?? "");
        if (to) t.attrSet("href", to);
        return linkOpen(tokens, idx, options, env, self);
      };
    },
  },

  vite: {
    // the pages are in ../docs and the theme in website/: the dev server may read both
    server: { fs: { allow: [repoRoot] } },
    optimizeDeps: { include: ["mermaid"] },
  },

  // the Tempolight Lite web installer is a plain page of its own: copied as it is to /flash/
  // (the docs workflow then adds the firmware image from the latest release next to it)
  buildEnd(site) {
    cpSync(path.join(docsDir, "flash"), path.join(site.outDir, "flash"), { recursive: true });
  },
});
