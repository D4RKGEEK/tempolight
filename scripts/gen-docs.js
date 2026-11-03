#!/usr/bin/env node
// Regenerates docs/effects.md from the engine, so the list never goes stale: node scripts/gen-docs.js
import { writeFileSync } from "node:fs";
import { buildLayout, exampleRoom, createEffects } from "../packages/engine/src/index.js";
const fx = createEffects(buildLayout(exampleRoom()));
const tag = { calm: "Calm, slow and emotional", build: "Build-up", drop: "High energy", "LedFx-like": "Classic spectrum", any: "Anything" };
const used = id => Object.values(fx.styles).filter(s => Object.values(s.pools).some(p => p.includes(id))).map(s => s.name);
const rows = fx.list.map(e => `| \`${e.id}\` | ${e.name} | ${tag[e.tag] || e.tag} | ${used(e.id).join(", ") || "picked by hand"} |`);
writeFileSync(new URL("../docs/effects.md", import.meta.url), `# Effects

All ${fx.list.length} effects work on any layout: lines, poles, rings, polygons, matrices and freehand shapes. In automatic mode
Tempolight picks from them by music style and song part; the last column says which styles use each one.
Generated from \`packages/engine\` by \`npm run docs\`.

| Id | Name | Best for | Used automatically in |
| --- | --- | --- | --- |
${rows.join("\n")}
`);
console.log(`docs/effects.md: ${fx.list.length} effects`);
