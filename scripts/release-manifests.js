#!/usr/bin/env node
// Fill in the package manager manifests in packaging/ (Homebrew, Scoop, winget) for a release.
//   node scripts/release-manifests.js --sums dist/release/SHA256SUMS.txt [--version 0.3.0] [--out dist/packaging]
//   node scripts/release-manifests.js --release v0.3.0     reads SHA256SUMS.txt from that GitHub release
// Writes, under --out (default dist/packaging):
//   homebrew-tempolight/Formula/tempolight.rb      } the tap repository D4RKGEEK/homebrew-tempolight, which is
//   homebrew-tempolight/bucket/tempolight.json     } also the Scoop bucket
//   winget/manifests/d/D4RKGEEK/Tempolight/<version>/*.yaml   for a pull request to microsoft/winget-pkgs
// Placeholders: {{version}}, {{date}}, {{sha256:<asset>}} and {{SHA256:<asset>}} (upper case, as winget writes it).
// Lines starting with #~ (and the "##" key in JSON) are notes for this repository and are left out.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = process.env.TEMPOLIGHT_REPO || "D4RKGEEK/tempolight";

export function parseSums(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) { const m = line.match(/^([0-9a-f]{64})\s+\*?(.+?)\s*$/i); if (m) out[path.basename(m[2])] = m[1].toLowerCase(); }
  return out;
}

export function fill(template, { version, date, sums }, file = "template") {
  let s = template.split("\n").filter(l => !l.startsWith("#~")).join("\n");
  if (file.endsWith(".json")) { const j = JSON.parse(s); delete j["##"]; s = JSON.stringify(j, null, 4) + "\n"; }
  s = s.replace(/\{\{(version|date|sha256:([^}]+)|SHA256:([^}]+))\}\}/g, (m, k, lo, up) => {
    if (k === "version") return version;
    if (k === "date") return date;
    const asset = lo || up, h = sums[asset];
    if (!h) throw new Error(`${file}: no checksum for ${asset} (have: ${Object.keys(sums).join(", ") || "none"})`);
    return up ? h.toUpperCase() : h;
  });
  if (/\{\{/.test(s)) throw new Error(`${file}: unknown placeholder ${s.match(/\{\{[^}]*\}\}/)[0]}`);
  if (file.endsWith(".json")) JSON.parse(s); // still valid
  return s;
}

export function writeManifests({ version, date = new Date().toISOString().slice(0, 10), sums, out }) {
  const P = path.join(ROOT, "packaging"), written = [];
  const put = (rel, src) => { const f = path.join(out, rel); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, fill(readFileSync(path.join(P, src), "utf8"), { version, date, sums }, src)); written.push(rel); };
  put("homebrew-tempolight/Formula/tempolight.rb", "homebrew/tempolight.rb");
  put("homebrew-tempolight/bucket/tempolight.json", "scoop/tempolight.json");
  for (const f of readdirSync(path.join(P, "winget"))) put(`winget/manifests/d/D4RKGEEK/Tempolight/${version}/${f}`, `winget/${f}`);
  return written;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2), opt = k => { const i = argv.indexOf("--" + k); return i >= 0 ? argv[i + 1] : undefined; };
  let version = opt("version"), text;
  if (opt("release")) {
    const tag = opt("release"); version ||= tag.replace(/^v/, "");
    const r = await fetch(`https://github.com/${REPO}/releases/download/${tag}/SHA256SUMS.txt`);
    if (!r.ok) throw new Error(`Couldn't download SHA256SUMS.txt from release ${tag} (${r.status})`);
    text = await r.text();
  } else if (opt("sums")) text = readFileSync(opt("sums"), "utf8");
  else { console.error("usage: node scripts/release-manifests.js (--sums <SHA256SUMS.txt> | --release <tag>) [--version x.y.z] [--out dir]"); process.exit(2); }
  version ||= JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  const out = path.resolve(opt("out") || path.join(ROOT, "dist/packaging"));
  const files = writeManifests({ version, sums: parseSums(text), out });
  console.log(`Tempolight ${version} manifests in ${path.relative(process.cwd(), out) || "."}:\n  ${files.join("\n  ")}`);
}
