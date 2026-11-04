// The one-file app's bundler (scripts/bundle.js): the transform handles the module syntax the code base uses, and the
// bundled server starts and serves the web app and the API like the sources do.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { bundle, transform, listAssets, ROOT } from "./bundle.js";
import { smoke } from "./smoke.js";

test("bundler: imports, exports and re-exports", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tl-bundle-"));
  try {
    const w = (f, s) => { mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); writeFileSync(path.join(dir, f), s); };
    w("package.json", JSON.stringify({ version: "9.9.9" }));
    w("a.js", `export const A = 1, B = [2, 3], C = f(4, 5);\nfunction f(x, y) { return x + y; }\nexport function inc(n) { return n + A; }\nexport class K { get v() { return "k"; } }\nexport default { d: true };\nconst hidden = "h";\nexport { hidden as shown };\n`);
    w("b.js", `export * from "./a.js";\nexport {\n  inc as plusOne,\n  K\n} from "./a.js";\nexport const url = import.meta.url;\nawait new Promise(r => setTimeout(r, 1));\nexport const awaited = true;\n`);
    w("main.js", `#!/usr/bin/env node\nimport path from "node:path";\nimport { join } from "node:path";\nimport def, { A } from "./a.js";\nimport * as b from "./b.js";\nimport {\n  plusOne,\n  shown as s\n} from "./b.js";\nconst tpl = \`\nimport nothing from "./nowhere.js";\n\`;\nconsole.log(JSON.stringify({ A, B: b.B, C: b.C, inc: plusOne(1), K: new b.K().v, def, s, star: Object.keys(b).sort(), awaited: b.awaited, url: b.url.endsWith("/b.js"), p: typeof path.join === typeof join, ObjC: "ObjC.import(\\"x\\")" }));\n`);
    const out = path.join(dir, "out.cjs");
    // the template literal holds an import-looking line; the bundler would fail on "./nowhere.js" if it took it for one
    const code = bundle({ root: dir, entry: "main.js", assets: [] });
    writeFileSync(out, code);
    const { execFileSync } = await import("node:child_process");
    const r = JSON.parse(execFileSync(process.execPath, [out], { encoding: "utf8", env: { ...process.env, TEMPOLIGHT_ASSETS: dir } }));
    assert.deepEqual(r, { A: 1, B: [2, 3], C: 9, inc: 2, K: "k", def: { d: true }, s: "h", star: ["A", "B", "C", "K", "awaited", "inc", "plusOne", "shown", "url"], awaited: true, url: true, p: true, ObjC: 'ObjC.import("x")' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("bundler: rejects what it can't bundle", () => {
  const r = s => s;
  assert.throws(() => transform(`export let x = 1;\n`, "x.js", r), /export let/);
  assert.throws(() => transform(`const m = await import("./m.js");\n`, "x.js", r), /dynamic import/);
  assert.doesNotThrow(() => transform(`/** @param {import("./m.js").T} t */\nconst ok = "ObjC.import('x')";\n`, "x.js", r));
});

test("bundler: the assets include the web app and the engine, not the tests", () => {
  const a = listAssets();
  for (const f of ["package.json", "apps/web/index.html", "apps/web/app.js", "apps/playground/index.html", "packages/engine/src/index.js", "packages/server/src/core.js"]) assert.ok(a.includes(f), f);
  assert.ok(!a.some(f => /\.test\.js$/.test(f)));
});

test("bundled server starts and serves the web app and the API", { timeout: 60000 }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tl-bundle-"));
  try {
    const out = path.join(dir, "tempolight.cjs"); writeFileSync(out, bundle());
    const r = await smoke(process.execPath, [out], { env: { TEMPOLIGHT_ASSETS: ROOT } });
    assert.match(r.version, /^\d+\.\d+\.\d+/);
    assert.ok(r.results.includes("ok /api/health"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("bundler: the lexer ends every source file at the top level", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const { topLevelLines } = await import("./bundle.js");
  for (const dir of ["packages/engine/src", "packages/outputs/src", "packages/server/src", "apps/web"]) for (const f of readdirSync(path.join(ROOT, dir)).filter(f => f.endsWith(".js"))) {
    const src = readFileSync(path.join(ROOT, dir, f), "utf8"), top = topLevelLines(src);
    assert.equal(top.length, src.split("\n").length, `${dir}/${f}`);
    assert.equal(top[top.length - 1], true, `${dir}/${f} ends inside a string, comment or brackets`);
  }
});
