import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildDocs } from "./build-docs-site.js";
import { render } from "./docs-site/markdown.js";
import { highlight } from "./docs-site/highlight.js";

const ctx = () => ({ link: h => h.startsWith("/") && !h.startsWith("/docs") ? "/docs" + h + "/" : h, icon: n => `<i data-icon="${n}"></i>` });

test("the docs site builds every page of mintlify/ without warnings, fast", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tl-docs-test-")), t = Date.now();
  try {
    const r = buildDocs({ out: dir, quiet: true });
    assert.ok(Date.now() - t < 10000, "under 10 s");
    assert.deepEqual(r.warnings, []);
    assert.ok(r.pages.includes("/docs/") && r.pages.includes("/docs/guides/first-run/") && r.pages.includes("/docs/api-reference/your-own-effects/change-an-effect/"));
    for (const f of ["index.html", "404.html", "search.json", "sitemap.xml", "assets/docs.css", "assets/docs.js", "logo/dark.svg", "favicon.svg", "images/home-dark.png"]) assert.ok(existsSync(path.join(dir, f)), f);
    const search = JSON.parse(readFileSync(path.join(dir, "search.json"), "utf8")); assert.ok(search.some(p => p.t === "Sync with Spotify"));
    const op = readFileSync(path.join(dir, "api-reference/your-own-effects/change-an-effect/index.html"), "utf8").replace(/<[^>]+>/g, "");
    assert.match(op, /curl -X PUT/); assert.match(op, /requests\.put/); assert.match(op, /"method":"PUT","path":"\/api\/custom-effects\/\{id\}"/, "the Try it data");
    assert.doesNotMatch(readFileSync(path.join(dir, "assets/docs.css"), "utf8"), /__\w+__/, "colours filled in");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Markdown: nested lists, tables with escaped pipes, inline marks, links and comments", () => {
  const { html, headings } = render([
    "{/* a comment */}", "## Hello `world`", "", "- one **bold** and *em*", "  1. nested [page](/install#x)", "  2. two", "- three", "",
    "| a | b |", "| --- | ---: |", "| `x \\| y` | <https://example.com> |", "", "> quote", "", "Text with http://tempolight.local and ~~gone~~.",
  ].join("\n"), ctx());
  assert.doesNotMatch(html, /comment/);
  assert.equal(headings[0].id, "hello-world");
  assert.match(html, /<ul><li>one <strong>bold<\/strong> and <em>em<\/em>\n?<ol><li>nested <a href="\/docs\/install#x\/">page<\/a><\/li><li>two<\/li><\/ol><\/li><li>three<\/li><\/ul>/);
  assert.match(html, /<td><code>x \| y<\/code><\/td><td style="text-align:right"><a href="https:\/\/example.com"/);
  assert.match(html, /<blockquote><p>quote<\/p><\/blockquote>/);
  assert.match(html, /<a href="http:\/\/tempolight.local"[^>]*>http:\/\/tempolight.local<\/a> and <del>gone<\/del>/);
});

test("MDX components: cards in columns, callouts, steps, tabs, code groups, frames, accordions", () => {
  const { html } = render([
    '<Columns cols={3}>', '  <Card title="Install" icon="download" href="/install">', "    A **one-file** app.", "  </Card>", "</Columns>", "",
    "<Note>", "  Careful.", "</Note>", "", '<Steps>', '  <Step title="First">', "    Do it.", "  </Step>", "</Steps>", "",
    "<Tabs>", '  <Tab title="Mac">mac</Tab>', '  <Tab title="Windows">win</Tab>', "</Tabs>", "",
    "<CodeGroup>", "```bash npm", "npm i", "```", "```bash Docker", "docker run", "```", "</CodeGroup>", "",
    "<Frame>", "  ![Shot](/images/a.png)", "</Frame>", "", '<Accordion title="More">', "  Hidden.", "</Accordion>", "",
    '<div className="tl-hero">', '  <h1 className="tl-title">Big</h1>', "</div>",
  ].join("\n"), ctx());
  assert.match(html, /<div class="cols cols-3"><a class="card" href="\/docs\/install\/">.*<span class="card-title">Install<\/span><span class="card-body"><p>A <strong>one-file<\/strong> app.<\/p>/s);
  assert.match(html, /class="callout callout-note".*Careful/s);
  assert.match(html, /class="step".*First.*Do it/s);
  assert.match(html, /role="tab"[^>]*>Mac<\/button>.*role="tab"[^>]*>Windows<\/button>/s);
  assert.match(html, /code-group.*>npm<\/button>.*>Docker<\/button>.*docker<\/span> run/s);
  assert.match(html, /<figure class="frame"><img src="\/docs\/images\/a.png\/" alt="Shot"/);
  assert.match(html, /<details class="accordion">.*More.*Hidden/s);
  assert.match(html, /<div class="tl-hero"><h1 class="tl-title">Big<\/h1><\/div>/);
});

test("the highlighter marks keywords, strings, comments and numbers, and escapes HTML", () => {
  assert.equal(highlight('const a = "x"; // hi', "js"), '<span class="t-k">const</span> a = <span class="t-s">&quot;x&quot;</span>; <span class="t-c">// hi</span>');
  assert.match(highlight('{"on": true, "n": 2}', "json"), /<span class="t-p">&quot;on&quot;<\/span>: <span class="t-b">true<\/span>.*<span class="t-n">2<\/span>/);
  assert.match(highlight("curl -s $TL/api # go", "bash"), /<span class="t-f">curl<\/span> <span class="t-o">-s<\/span> <span class="t-v">\$TL<\/span>\/api <span class="t-c"># go<\/span>/);
  assert.equal(highlight("<b>", "text"), "&lt;b&gt;");
});
