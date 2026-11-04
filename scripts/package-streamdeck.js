#!/usr/bin/env node
// Packs the Stream Deck plugin into dist/io.github.d4rkgeek.tempolight.streamDeckPlugin (a zip of the .sdPlugin folder;
// double-click it to install). node scripts/package-streamdeck.js [--out file]
// Elgato's own CLI does the same with more checks: npx @elgato/cli pack integrations/streamdeck/io.github.d4rkgeek.tempolight.sdPlugin
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packFolder } from "../packages/server/src/integrations/zip.js";
import { PLUGIN_DIR, PLUGIN_UUID } from "../packages/server/src/integrations/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function packageStreamDeck(out = path.join(root, "dist", `${PLUGIN_UUID}.streamDeckPlugin`)) {
  const dir = path.join(root, PLUGIN_DIR), manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));
  // the plugin's version follows Tempolight's (Stream Deck wants four numbers)
  const v = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
  if (!manifest.Version.startsWith(v + ".")) console.warn(`Note: manifest.json says ${manifest.Version}, Tempolight is ${v}`);
  const buf = packFolder(dir); mkdirSync(path.dirname(out), { recursive: true }); writeFileSync(out, buf);
  return { out, bytes: buf.length };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--out"), r = packageStreamDeck(i > 0 ? path.resolve(process.argv[i + 1]) : undefined);
  console.log(`Wrote ${path.relative(process.cwd(), r.out)} (${(r.bytes / 1024).toFixed(0)} kB)`);
}
