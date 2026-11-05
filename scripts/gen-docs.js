#!/usr/bin/env node
// Regenerates docs/effects.md from the engine, so the list never goes stale: node scripts/gen-docs.js
import { writeFileSync } from "node:fs";
import { buildLayout, exampleRoom, createEffects } from "../packages/engine/src/index.js";
const fx = createEffects(buildLayout(exampleRoom()));
const tag = { calm: "Calm, slow and emotional", build: "Build-up", drop: "High energy", home: "Everyday (follows the clock)", "LedFx-like": "Classic spectrum", any: "Anything" };
const used = id => Object.values(fx.styles).filter(s => Object.values(s.pools).some(p => p.includes(id))).map(s => s.name);
const rows = fx.list.map(e => `| \`${e.id}\` | ${e.name} | ${tag[e.tag] || e.tag} | ${used(e.id).join(", ") || "picked by hand"} |`);
writeFileSync(new URL("../docs/effects.md", import.meta.url), `# Effects

All ${fx.list.length} effects work on any layout: lines, poles, rings, polygons, matrices and freehand shapes, drawn across the
room you set up on the Room page ([room-and-zones.md](guides/room-and-zones.md)).

- **Automatic** (the default): Tempolight picks one look for each song: one effect and its colours, chosen to fit
  the song (see [One look per song](guides/first-run.md#one-look-per-song)). With **Variety** set to *Show* it picks
  from them by music style and song part (calm parts, build-ups, drops); the last column says which styles use each
  one. On the Effects page, ♥ makes automatic mode pick an effect more often and ⊘ bans it; **Change effect every**
  sets how many beats an effect stays in a show.
- **By hand**: tap an effect on the Effects page (or pick it on Home) and it stays until you press **Back to
  automatic**. *Picked by hand* effects are never chosen automatically.
- **Tune** any effect under Effect settings (speed, intensity, colour shift, saturation, mirror; kept per effect and
  saved in scenes), add an **Accent layer** on top, give a [zone](guides/room-and-zones.md#zones) its own effect, or
  make your own under **Make your own** and share it with a \`TL1:\` code.

Generated from \`packages/engine\` by \`npm run docs\`.

| Id | Name | Best for | Used automatically in |
| --- | --- | --- | --- |
${rows.join("\n")}
`);
console.log(`docs/effects.md: ${fx.list.length} effects`);
