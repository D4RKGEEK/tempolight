// mintlify/ (the Mintlify docs site) is generated from docs/ by scripts/build-mintlify.js and must stay in step with it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { build, checkSite, convertBody, lintMdx, validateDocsJson, HAND_WRITTEN } from "./build-mintlify.js";
import { existsSync, readFileSync } from "node:fs";

const ctx = (srcRel = "guides/first-run.md", slug = "guides/first-run") =>
  ({ srcRel, slug, anchorMoves: new Map([["api.md#server-to-client", "websocket"]]), splitHeads: new Set(), warn() {} });

test("mintlify/ is up to date with docs/ and the site checks out", () => {
  const { files } = build();
  const stale = [];
  for (const [k, v] of files) {
    const f = new URL(`../mintlify/${k}`, import.meta.url);
    if (!existsSync(f)) { stale.push(`${k} missing`); continue; }
    const disk = readFileSync(f);
    const same = typeof v === "string" ? disk.toString("utf8").replace(/\r\n?/g, "\n") === v : Buffer.compare(disk, v) === 0;
    if (!same) stale.push(`${k} out of date`);
  }
  assert.deepEqual(stale, [], "run: node scripts/build-mintlify.js");
  const site = new Map(files);
  for (const h of HAND_WRITTEN) {
    const f = new URL(`../mintlify/${h}`, import.meta.url);
    if (existsSync(f)) site.set(h, readFileSync(f));
  }
  assert.deepEqual(checkSite(site), []);
});

test("Markdown becomes MDX: escapes, comments, autolinks, links and callouts", () => {
  const out = convertBody([
    "Use `<host>` or <host> with {braces} and a < b.",
    "<!-- a comment -->",
    "See <https://example.com> and [the API](../api.md#server-to-client), [faq](faq.md), [code](../../packages/x.js).",
    "![shot](../images/a.png)",
    "",
    "> [!WARNING]",
    "> Mind the {gap}.",
    "",
    "**Tip:** try it.",
    "",
    "```js",
    "const x = {a: 1} < 2; // <!-- kept -->",
    "```",
  ].join("\n"), ctx());
  assert.match(out, /Use `<host>` or &lt;host> with \\\{braces\\\} and a &lt; b\./);
  assert.match(out, /\{\/\* a comment \*\/\}/);
  assert.match(out, /\[https:\/\/example\.com\]\(https:\/\/example\.com\)/);
  assert.match(out, /\[the API\]\(\/websocket#server-to-client\)/);
  assert.match(out, /\[faq\]\(\/guides\/faq\)/);
  assert.match(out, /\(https:\/\/github\.com\/D4RKGEEK\/tempolight\/blob\/main\/packages\/x\.js\)/);
  assert.match(out, /!\[shot\]\(\/images\/a\.png\)/);
  assert.match(out, /<Warning>\n+Mind the \\\{gap\\\}\.\n+<\/Warning>/);
  assert.match(out, /<Tip>\n+try it\.\n+<\/Tip>/);
  assert.match(out, /const x = \{a: 1\} < 2; \/\/ <!-- kept -->/);
  assert.deepEqual(lintMdx(out), []);
});

test("the MDX check catches what MDX can't read", () => {
  const problems = lintMdx("---\ntitle: x\n---\nA {brace} and a <b and <!-- c -->, [x](y.md).\n`{fine}`\n");
  assert.ok(problems.some(p => p.includes('unescaped "{"')));
  assert.ok(problems.some(p => p.includes("isn't a tag")));
  assert.ok(problems.some(p => p.includes("HTML comment")));
  assert.ok(problems.some(p => p.includes(".md file")));
  assert.equal(problems.filter(p => p.startsWith("5:")).length, 0);
});

test("docs.json is checked against Mintlify's schema", () => {
  const good = JSON.parse(readFileSync(new URL("../mintlify/docs.json", import.meta.url), "utf8"));
  assert.deepEqual(validateDocsJson(good), []);
  const bad = validateDocsJson({ ...good, theme: "nope", colors: {}, mystery: 1, navigation: { tabs: [{ tab: "x" }] } });
  assert.ok(bad.some(p => p.includes("theme")) && bad.some(p => p.includes("colors.primary")) && bad.some(p => p.includes("mystery")) && bad.some(p => p.includes("empty")));
});
