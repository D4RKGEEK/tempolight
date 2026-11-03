#!/usr/bin/env node
// Tempolight server. Start it, open the address it prints, done.
//   tempolight [--port 8080] [--host 0.0.0.0] [--data ~/.tempolight] [--open] [--no-discover] [--audio <source|file>]
import os from "node:os";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createApp, ROOT } from "./app.js";
import { localIPv4 } from "../../outputs/src/index.js";
import { listSources, fileSource } from "./capture.js";

const argv = process.argv.slice(2);
const flag = k => argv.includes("--" + k);
const opt = (k, d) => { const i = argv.indexOf("--" + k); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };

if (flag("help") || flag("h")) {
  console.log(`Tempolight: music-reactive lighting for WLED

  tempolight [options]

  --port <n>        web UI port (default 8080, or $PORT)
  --host <ip>       listen address (default 0.0.0.0: reachable from your phone on the same Wi-Fi)
  --data <dir>      where settings are saved (default ~/.tempolight, or $TEMPOLIGHT_DATA)
  --open            open the web UI in your browser
  --no-discover     don't look for WLED controllers on first start
  --audio <source>  listen on this computer: "auto", a source id (see --list-audio), or a music file to play through
  --list-audio      show the audio sources this computer can capture from
`);
  process.exit(0);
}
if (flag("list-audio")) { const s = listSources(); console.log(s.length ? s.map(x => `  ${x.id.padEnd(16)} ${x.label}`).join("\n") : "  No capture tools found. Install ffmpeg, or use a browser as the audio source."); process.exit(0); }

const [maj] = process.versions.node.split(".").map(Number);
if (maj < 20) { console.error(`Tempolight needs Node.js 20 or newer (this is ${process.versions.node}). Get it from https://nodejs.org`); process.exit(1); }

const dataDir = path.resolve(opt("data", process.env.TEMPOLIGHT_DATA || path.join(os.homedir(), ".tempolight")));
const port = Number(opt("port", process.env.PORT || 8080)), host = opt("host", process.env.HOST || "0.0.0.0");
const app = await createApp({ dataDir, discover: !flag("no-discover") && !process.env.TEMPOLIGHT_NO_DISCOVER });

const audio = opt("audio");
if (audio) {
  const cap = app.store.data.settings.capture;
  if (existsSync(audio)) { cap.command = fileSource(path.resolve(audio)).cmd.map(w => (/\s/.test(w) ? `"${w}"` : w)).join(" "); cap.enabled = true; }
  else { cap.source = audio; cap.command = ""; cap.enabled = true; }
  app.store.save(); app.runtime.startCaptureSource();
}

let bound;
try { for (let tries = 0; ; tries++) { try { bound = await app.listen(port, host); break; } catch (e) { if (e.code !== "EADDRINUSE" || !process.env.TEMPOLIGHT_RESTART_WAIT || tries > 40) throw e; await new Promise(r => setTimeout(r, 250)); } } } // after an update, the old copy may still be closing
catch (e) {
  if (e.code === "EADDRINUSE") { console.error(`Port ${port} is already in use. Is Tempolight already running? Or start it on another port: --port ${port + 1}`); process.exit(1); }
  throw e;
}
const lan = localIPv4().map(a => `http://${a.address}:${bound}`);
console.log(`\n  Tempolight ${JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version} is running\n`);
console.log(`  On this computer:  http://localhost:${bound}`);
for (const u of lan) console.log(`  On your phone:     ${u}`);
console.log(`  Settings are saved in ${dataDir}\n`);

if (flag("open")) { const u = `http://localhost:${bound}`; const cmd = process.platform === "win32" ? ["cmd", ["/c", "start", "", u]] : process.platform === "darwin" ? ["open", [u]] : ["xdg-open", [u]]; try { spawn(cmd[0], cmd[1], { stdio: "ignore", detached: true }).unref(); } catch {} }

let closing = false;
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, async () => { if (closing) process.exit(0); closing = true; console.log("\n  Stopping…"); await app.close(); process.exit(0); });
