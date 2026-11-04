#!/usr/bin/env node
// A tiny bundler for the one-file app: turns the server's ES modules into one CommonJS script that Node's Single
// Executable Applications (SEA) can run. No dependencies, and it only handles what this code base uses: static
// `import`/`export` statements at the start of a line with relative or node: specifiers, and top-level await.
//   node scripts/bundle.js [--out dist/tempolight.cjs]
// The web app's files aren't in the script: the SEA build adds them as assets (see build-sea.js), and the script reads
// them with sea.getAsset(); run outside an executable, it reads them from TEMPOLIGHT_ASSETS or this repository.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ENTRY = "packages/server/src/index.js";

// What the server serves to the browser (see STATIC_DIRS in app.js), plus package.json for the version.
export const ASSET_DIRS = ["apps/web", "apps/playground", "packages/engine/src", "packages/outputs/src", "packages/server/src"];
export const ASSET_FILES = ["package.json", "packages/engine/package.json", "packages/outputs/package.json", "packages/server/package.json"];

const NAME = String.raw`[A-Za-z_$][\w$]*`;
const spec = s => s.match(/from\s+["']([^"']+)["']\s*;?\s*$/)?.[1] ?? s.match(/^import\s+["']([^"']+)["']/)?.[1];
const names = list => list.split(",").map(s => s.trim()).filter(Boolean).map(s => { const m = s.match(new RegExp(`^(${NAME}|default)(?:\\s+as\\s+(${NAME}|default))?$`)); if (!m) throw new Error(`can't read "${s}"`); return [m[1], m[2] || m[1]]; });

// Which lines start in top-level code: not inside a string, template literal, comment or regex, and outside any
// brackets. Only those can hold an import or export statement. A small lexer, enough for hand-written modules (a `/`
// starts a regex after an operator, a bracket or a keyword, as JavaScript itself decides).
export function topLevelLines(src) {
  const top = [true]; let depth = 0, prev = "", word = "";
  const stack = []; // template literals: the bracket depth each `${` started at
  const KW = new Set(["return", "typeof", "case", "in", "of", "void", "delete", "new", "throw", "else", "do", "await", "yield"]);
  for (let i = 0; i < src.length; i++) {
    let c = src[i];
    const skipTo = (end, esc = true) => { for (i++; i < src.length && src[i] !== end; i++) { if (esc && src[i] === "\\") i++; else if (src[i] === "\n") top.push(false); } };
    if (c === "\n") { top.push(depth === 0 && !stack.length); continue; }
    if (/\s/.test(c)) continue;
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i + 1] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) { if (src[i] === "\n") top.push(false); i++; } i++; continue; }
    if (c === '"' || c === "'") { skipTo(c); prev = c; word = ""; continue; }
    if (c === "/" && (!prev || "(,=:[!&|?{};+-*%<>~^".includes(prev) || KW.has(word))) { // a regex literal
      for (i++; i < src.length && src[i] !== "/"; i++) { if (src[i] === "\\") i++; else if (src[i] === "[") skipTo("]"); }
      while (/[a-z]/i.test(src[i + 1] || "")) i++;
      prev = "/r"; word = ""; continue;
    }
    if (c === "`" || (c === "}" && stack.length && stack[stack.length - 1] === depth)) { // a template literal (or the rest of one after ${…})
      if (c === "}") stack.pop();
      for (i++; i < src.length; i++) {
        if (src[i] === "\\") { i++; continue; }
        if (src[i] === "\n") top.push(false);
        if (src[i] === "`") break;
        if (src[i] === "$" && src[i + 1] === "{") { i++; stack.push(depth); break; }
      }
      prev = "`"; word = ""; continue;
    }
    if ("([{".includes(c)) depth++; else if (")]}".includes(c)) depth--;
    if (/[\w$]/.test(c)) { word = prev && /[\w$]/.test(prev) ? word + c : c; } else word = "";
    prev = c;
  }
  return top;
}

// Split a module into its import/export statements (which may span lines) and the rest.
const STMT = /^(import\s+([\w$]+|\*|\{|["'])|export\s+(async\s+function|function|class|const|let|var|default|\{|\*))/;
function statements(src) {
  src = src.replace(/^#!.*/, "");
  const lines = src.split("\n"), top = topLevelLines(src), out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!top[i] || !STMT.test(line)) { out.push({ kind: "code", text: line }); continue; }
    let stmt = line;
    // an import or a re-export with a brace list continues until the braces close
    if (/^(import|export\s*\{)/.test(line)) while ((stmt.match(/\{/g) || []).length > (stmt.match(/\}/g) || []).length && i + 1 < lines.length) stmt += "\n" + lines[++i];
    out.push({ kind: "stmt", text: stmt, line: i + 1 });
  }
  return out;
}

// The names a `const` declaration list declares at its top level: "A = 1, B = f(x, y)" -> [A, B]
function declared(decl) {
  const out = [new RegExp(`^${NAME}`).exec(decl)[0]]; let depth = 0, q = null;
  for (let i = 0; i < decl.length; i++) {
    const c = decl[i];
    if (q) { if (c === "\\") i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === "`") q = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === ";" && !depth) break;
    else if (c === "," && !depth) { const m = new RegExp(`^\\s*(${NAME})\\s*=`).exec(decl.slice(i + 1)); if (m) out.push(m[1]); }
  }
  return out;
}

/** Turn one ES module into the body of an async factory. */
export function transform(src, file, resolve) {
  const head = [], exportsDefs = [], deps = [], body = [];
  const dep = s => { const id = resolve(s); if (!id.startsWith("node:")) deps.push(id); return id.startsWith("node:") ? `require(${JSON.stringify(id)})` : `__mods[${JSON.stringify(id)}]`; };
  const getter = (exported, expr) => exportsDefs.push(`${JSON.stringify(exported)}: { enumerable: true, get: () => ${expr} }`);
  let m;
  for (const s of statements(src)) {
    if (s.kind === "code") { body.push(s.text); continue; }
    const t = s.text.trim(), where = `${file}:${s.line}`;
    if (t.startsWith("import")) {
      const from = spec(t); if (!from) throw new Error(`${where}: can't read the import`);
      const mod = dep(from), node = from.startsWith("node:");
      const clause = t.replace(/^import\s+/, "").replace(/\s*from\s+["'][^"']+["']\s*;?\s*$/, "").trim();
      if (/^["']/.test(clause)) { head.push(`${mod};`); body.push(""); continue; } // side-effect import
      let rest = clause;
      if ((m = rest.match(new RegExp(`^(${NAME})\\s*(,|$)`))) && m[1] !== "type") { head.push(`const ${m[1]} = ${node ? mod : `${mod}.default`};`); rest = rest.slice(m[0].length).trim(); }
      if ((m = rest.match(new RegExp(`^\\*\\s+as\\s+(${NAME})$`)))) { head.push(`const ${m[1]} = ${mod};`); rest = ""; }
      if ((m = rest.match(/^\{([\s\S]*)\}$/))) { const n = names(m[1]); head.push(`const { ${n.map(([a, b]) => a === b ? a : `${a}: ${b}`).join(", ")} } = ${mod};`); rest = ""; }
      if (rest) throw new Error(`${where}: can't read the import "${t}"`);
      body.push(...Array(t.split("\n").length).fill("")); // keep line numbers close to the source's
      continue;
    }
    // exports
    if ((m = t.match(/^export\s+\*\s+from\s+["']([^"']+)["']/))) { const mod = dep(m[1]); head.push(`__star(__exports, ${mod});`); body.push(""); continue; }
    if ((m = t.match(/^export\s*\{([\s\S]*)\}\s*(from\s+["'][^"']+["'])?\s*;?\s*$/))) {
      const mod = m[2] ? dep(spec(t)) : null;
      for (const [local, exported] of names(m[1])) getter(exported, mod ? `${mod}[${JSON.stringify(local)}]` : local);
      body.push(...Array(t.split("\n").length).fill("")); continue;
    }
    if ((m = t.match(new RegExp(`^export\\s+default\\s+(async\\s+function|function|class)\\b\\s*(\\*?\\s*${NAME})?`)))) {
      const nm = m[2]?.replace("*", "").trim();
      if (nm) { getter("default", nm); body.push(s.text.replace(/^export\s+default\s+/, "")); } else { getter("default", "__default"); body.push(s.text.replace(/^export\s+default\s+/, "const __default = ")); }
      continue;
    }
    if (/^export\s+default\s/.test(t)) { getter("default", "__default"); body.push(s.text.replace(/^export\s+default\s+/, "const __default = ")); continue; }
    if ((m = t.match(new RegExp(`^export\\s+(?:async\\s+)?(?:function\\s*\\*?|class)\\s*(${NAME})`)))) { getter(m[1], m[1]); body.push(s.text.replace(/^export\s+/, "")); continue; }
    if ((m = t.match(new RegExp(`^export\\s+(const|let|var)\\s+(${NAME})\\s*=`)))) {
      if (m[1] !== "const") throw new Error(`${where}: "export ${m[1]}" isn't supported (exports are read through getters, but keep them const)`);
      // `export const a = 1, b = 2` on one line: export each top-level name declared there
      for (const n of declared(t.split("\n")[0].replace(/^export\s+const\s+/, ""))) getter(n, n);
      body.push(s.text.replace(/^export\s+/, "")); continue;
    }
    throw new Error(`${where}: can't bundle "${t.split("\n")[0]}"`);
  }
  let code = body.join("\n");
  if (/(^|[^.\w$])import\s*\(/m.test(code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""))) throw new Error(`${file}: dynamic import() isn't supported by the bundler`);
  code = code.replace(/\bimport\.meta\.url\b/g, "__meta.url").replace(/\bimport\.meta\b/g, "__meta");
  const defs = exportsDefs.length ? `Object.defineProperties(__exports, {\n  ${exportsDefs.join(",\n  ")}\n});\n` : "";
  return { deps: [...new Set(deps)], code: `${defs}${head.join("\n")}\n${code}` };
}

/** Bundle the server into one CommonJS script (a string). */
export function bundle({ root = ROOT, entry = ENTRY, assets = listAssets(root) } = {}) {
  const mods = new Map(), order = [], visiting = new Set();
  const visit = (id, chain) => {
    if (mods.has(id)) return;
    if (visiting.has(id)) throw new Error(`import cycle: ${[...chain, id].join(" -> ")} (the bundler needs a cycle-free graph)`);
    visiting.add(id);
    const src = readFileSync(path.join(root, id), "utf8");
    const resolve = s => { if (s.startsWith("node:")) return s; if (!s.startsWith(".")) throw new Error(`${id}: "${s}" isn't a relative import (the app has no dependencies)`); return path.posix.normalize(path.posix.join(path.posix.dirname(id), s)); };
    const t = transform(src, id, resolve);
    for (const d of t.deps) visit(d, [...chain, id]);
    visiting.delete(id); mods.set(id, t); order.push(id);
  };
  visit(entry, []);
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const parts = order.map(id => `// ---- ${id}\n__defs[${JSON.stringify(id)}] = { deps: ${JSON.stringify(mods.get(id).deps)}, run: async (__exports, __meta) => {\n${mods.get(id).code}\n} };`);
  return `// Tempolight ${pkg.version}, bundled by scripts/bundle.js from ${order.length} modules. Edit the sources, not this file.
"use strict";
const __path = require("node:path"), __fs = require("node:fs"), { pathToFileURL: __toUrl } = require("node:url");
let __sea = null; try { const s = require("node:sea"); if (s.isSea()) __sea = s; } catch {}
// In an executable the app's files are SEA assets; otherwise they're read from a folder (this repository by default).
const __root = __sea ? __path.dirname(process.execPath) : __path.resolve(process.env.TEMPOLIGHT_ASSETS || __path.join(__dirname, ".."));
const __keys = new Set(${JSON.stringify(assets)});
globalThis.__tempolightAssets = {
  sea: !!__sea, root: __root,
  key(file) { const r = __path.relative(__root, file).split(__path.sep).join("/"); return r.startsWith("..") ? null : r; },
  read(file) { const k = this.key(file); if (k == null || !__keys.has(k)) throw Object.assign(new Error("ENOENT: " + file), { code: "ENOENT" }); return __sea ? Buffer.from(__sea.getAsset(k)) : __fs.readFileSync(__path.join(__root, k)); },
  stat(file) { const k = this.key(file); if (k == null) throw Object.assign(new Error("ENOENT: " + file), { code: "ENOENT" }); const dir = k === "" || [...__keys].some(x => x.startsWith(k + "/")); if (!dir && !__keys.has(k)) throw Object.assign(new Error("ENOENT: " + file), { code: "ENOENT" }); return { isDirectory: () => dir, isFile: () => !dir }; },
};
if (__sea) { process.argv = process.argv.filter((a, i) => i < 2 || !a.startsWith("-psn_")); if (process.argv.length <= 2) process.argv.push("--open"); } // double-clicked (or opened as a Mac app, which may add -psn_…): open the browser too
const __defs = {}, __mods = {}, __loading = {};
function __star(target, src) { for (const k of Object.keys(src)) if (k !== "default" && !(k in target)) Object.defineProperty(target, k, { enumerable: true, get: () => src[k] }); }
function __load(id) {
  return __loading[id] ||= (async () => {
    const d = __defs[id]; for (const dep of d.deps) await __load(dep);
    const ex = __mods[id] = Object.create(null);
    await d.run(ex, { url: __toUrl(__path.join(__root, id)).href });
    return ex;
  })();
}
${parts.join("\n\n")}

__load(${JSON.stringify(entry)}).catch(e => {
  console.error(e && e.stack || e);
  // double-clicked on Windows: keep the window open long enough to read why it stopped
  if (__sea && process.platform === "win32" && process.stdin.isTTY) { console.error("\\nPress Enter to close."); process.stdin.once("data", () => process.exit(1)); }
  else process.exit(1);
});
`;
}

/** The files the executable carries, as paths relative to the repository with forward slashes. */
export function listAssets(root = ROOT) {
  const out = [...ASSET_FILES];
  const walk = rel => { for (const e of readdirSync(path.join(root, rel), { withFileTypes: true })) { const r = `${rel}/${e.name}`; if (e.isDirectory()) walk(r); else if (!/\.test\.js$|\.DS_Store$/.test(e.name)) out.push(r); } };
  for (const d of ASSET_DIRS) walk(d);
  return out.sort();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--out"), out = path.resolve(i > 0 ? process.argv[i + 1] : path.join(ROOT, "dist/tempolight.cjs"));
  mkdirSync(path.dirname(out), { recursive: true });
  const code = bundle(); writeFileSync(out, code);
  console.log(`Wrote ${path.relative(process.cwd(), out)} (${(code.length / 1024).toFixed(0)} kB)`);
}
