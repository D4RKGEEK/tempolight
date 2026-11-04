#!/usr/bin/env node
// Build the one-file app for the computer this runs on: a copy of Node with Tempolight inside (Node's Single
// Executable Applications). Release builds run this on a runner per platform (.github/workflows/release.yml).
//   node scripts/build-sea.js [--node <node binary to embed>] [--out dist] [--smoke] [--no-strip]
// Needs Node 20.12+ (22 or 24 recommended). The app stays dependency-free: the only build tool is postject, fetched
// with npx (set POSTJECT to another command, e.g. a local install). Node 25.5+ has `--build-sea` and needs no postject.
// macOS: the copy is re-signed ad hoc (codesign --sign -) after injection, or it won't start on Apple Silicon.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, writeFileSync, mkdirSync, statSync, chmodSync, rmSync, readFileSync } from "node:fs";
import path from "node:path";
import { bundle, listAssets, ROOT } from "./bundle.js";
import { smoke } from "./smoke.js";

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf("--" + k); return i >= 0 ? argv[i + 1] : d; };
const NODE = path.resolve(opt("node", process.execPath));
const OUT = path.resolve(opt("out", path.join(ROOT, "dist")));
const FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const PLATFORM = { win32: "windows", darwin: "macos", linux: "linux" }[process.platform] || process.platform;
export const exeName = (platform = PLATFORM, arch = process.arch) => `tempolight-${platform}-${arch}${platform === "windows" ? ".exe" : ""}`;
const say = s => console.log(`> ${s}`);
const run = (cmd, args, o = {}) => { say([cmd, ...args].map(a => (/\s/.test(a) ? `"${a}"` : a)).join(" ")); const r = spawnSync(cmd, args, { stdio: "inherit", shell: o.shell || false, ...o }); if (r.status !== 0) throw new Error(`${cmd} failed (${r.error?.message || `exit ${r.status}`})`); };
const has = cmd => spawnSync(cmd, ["--version"], { stdio: "ignore", shell: process.platform === "win32" }).status === 0;

const nodeVersion = execFileSync(NODE, ["-p", "process.versions.node"], { encoding: "utf8" }).trim();
const [maj, min] = nodeVersion.split(".").map(Number);
if (maj < 20 || (maj === 20 && min < 12)) throw new Error(`The embedded Node must be 20.12 or newer for SEA assets (this is ${nodeVersion})`);
const buildSea = spawnSync(NODE, ["--help"], { encoding: "utf8" }).stdout.includes("--build-sea");

mkdirSync(OUT, { recursive: true });
const work = path.join(OUT, "sea-work"); rmSync(work, { recursive: true, force: true }); mkdirSync(work, { recursive: true });
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));

// 1. one script, and the files it serves as assets
const main = path.join(work, "tempolight.cjs"); writeFileSync(main, bundle());
const assets = Object.fromEntries(listAssets().map(k => [k, path.join(ROOT, k)]));
const exe = path.join(OUT, exeName());
const blob = path.join(work, "sea-prep.blob");
const config = { main, output: buildSea ? exe : blob, disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false, assets };
if (buildSea) config.executable = NODE;
const configPath = path.join(work, "sea-config.json"); writeFileSync(configPath, JSON.stringify(config, null, 2));
say(`Tempolight ${pkg.version}: ${Object.keys(assets).length} assets, script ${(statSync(main).size / 1024).toFixed(0)} kB, Node ${nodeVersion}`);

if (buildSea) {
  // 2+3 in one step (Node 25.5+)
  run(NODE, ["--build-sea", configPath]);
} else {
  // 2. the blob
  run(NODE, ["--experimental-sea-config", configPath]);
  // 3. a copy of Node, with the blob injected
  rmSync(exe, { force: true }); copyFileSync(NODE, exe); chmodSync(exe, 0o755);
  if (process.platform === "darwin") run("codesign", ["--remove-signature", exe]);
  if (process.platform === "linux" && !argv.includes("--no-strip") && has("strip")) run("strip", ["--strip-debug", exe]); // the debug info is ~10-40 MB nobody needs
  const postject = (process.env.POSTJECT || "npx --yes postject@1.0.0-alpha.6").split(" ");
  const args = [...postject.slice(1), exe, "NODE_SEA_BLOB", blob, "--sentinel-fuse", FUSE, ...(process.platform === "darwin" ? ["--macho-segment-name", "NODE_SEA"] : [])];
  run(postject[0], args, { shell: process.platform === "win32" }); // npx is npx.cmd on Windows
}
if (process.platform === "darwin") run("codesign", ["--sign", "-", "--force", exe]);
rmSync(work, { recursive: true, force: true });
say(`Built ${path.relative(process.cwd(), exe)} (${(statSync(exe).size / 1048576).toFixed(1)} MB)`);

// 4. does it start and answer?
if (argv.includes("--smoke")) {
  const r = await smoke(exe);
  if (r.version !== pkg.version) throw new Error(`the executable says it's ${r.version}, expected ${pkg.version}`);
  say(`Smoke test passed on port ${r.port}:\n    ${r.results.join("\n    ")}`);
}
