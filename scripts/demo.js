#!/usr/bin/env node
// Stream an effect to one WLED controller on a steady beat. The quickest way to see Tempolight on real lights.
//   node scripts/demo.js --host 192.168.1.41 --leds 150 --effect laser --bpm 128
//   node scripts/demo.js --list            show all effect ids
//   node scripts/demo.js --dry --leds 300  render without sending, print frame time
import { buildLayout, createEffects, metronomeView, buildSignals, toRGB8 } from "../packages/engine/src/index.js";
import { DDPSender } from "../packages/outputs/src/index.js";

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => { if (v.startsWith("--")) a.push([v.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]); return a; }, []));
const leds = Number(args.leds || 150), bpm = Number(args.bpm || 128), fps = Number(args.fps || 60), effect = args.effect || "laser";
const shape = args.shape || "line"; // line | ring | matrix
const shapes = shape === "ring" ? [{ type: "circle", count: leds, cx: 8, cy: 4.5, size: 3, dev: "demo" }]
  : shape === "matrix" ? [{ type: "matrix", cols: Number(args.cols || 16), rows: Number(args.rows || 16), cx: 8, cy: 4.5, w: 6, h: 6, dev: "demo" }]
  : [{ type: "line", count: leds, pts: [[0.5, 4.5], [15.5, 4.5]], dev: "demo" }];
const layout = buildLayout(shapes), fx = createEffects(layout);
if (args.list) { for (const e of fx.list) console.log(`${e.id.padEnd(14)} ${e.tag.padEnd(10)} ${e.name}`); process.exit(0); }
if (!fx.list.some(e => e.id === effect)) { console.error(`Unknown effect "${effect}". Run with --list to see them.`); process.exit(1); }
if (!args.host && !args.dry) { console.error("Give a WLED address with --host, or use --dry to test without hardware."); process.exit(1); }

const sender = args.host ? new DDPSender(args.host) : null;
const col = new Float32Array(layout.N * 3), rgb = new Uint8Array(layout.N * 3);
const t0 = performance.now(); let n = 0, worst = 0, total = 0;
console.log(`${effect} on ${layout.N} LEDs at ${bpm} BPM, ${fps} fps${sender ? ` -> ${args.host}` : " (dry run)"}. Ctrl+C to stop.`);
setInterval(() => {
  const t = (performance.now() - t0) / 1000, s0 = performance.now();
  fx.render(effect, buildSignals(metronomeView(t, bpm), t, { pal: fx.palettes[args.palette || "neon"] || fx.palettes.neon, fixed: true }), col);
  toRGB8(col, rgb, Number(args.brightness || 0.8));
  sender?.send(rgb);
  const dt = performance.now() - s0; worst = Math.max(worst, dt); total += dt; n++;
  if (n % (fps * 5) === 0) { console.log(`frame ${(total / n).toFixed(2)} ms average, ${worst.toFixed(2)} ms worst`); worst = 0; }
}, 1000 / fps);
