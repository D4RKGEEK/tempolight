#!/usr/bin/env node
// Start a Tempolight build on a free port with a throwaway data folder, check that it answers, and stop it.
//   node scripts/smoke.js dist/tempolight-linux-x64          the one-file app
//   node scripts/smoke.js node dist/tempolight.cjs           the bundled script
//   node scripts/smoke.js node packages/server/src/index.js  the sources
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CHECKS = [
  ["/api/health", (r, b) => JSON.parse(b).ok === true],
  ["/", (r, b) => /<title>Tempolight/.test(b) && /text\/html/.test(r.headers.get("content-type"))],
  ["/engine/index.js", (r, b) => /export /.test(b) && /javascript/.test(r.headers.get("content-type"))],
  ["/packages/server/src/core.js", (r, b) => /createCore/.test(b)],
  ["/style.css", (r, b) => /text\/css/.test(r.headers.get("content-type")) && b.length > 100],
  ["/manifest.webmanifest", (r, b) => JSON.parse(b).name],
  ["/icons/icon-192.png", r => /image\/png/.test(r.headers.get("content-type"))],
  ["/phone", (r, b) => /<title>/i.test(b)],
  ["/playground", (r, b) => /<title>/i.test(b)],
  ["/api/state", (r, b) => typeof JSON.parse(b) === "object"],
  ["/api/update", (r, b) => typeof JSON.parse(b).method === "string"],
];

/** @returns {Promise<{port:number, version:string, results:string[]}>} */
export async function smoke(cmd, args = [], { timeout = 30000, env = {} } = {}) {
  const data = mkdtempSync(path.join(os.tmpdir(), "tempolight-smoke-"));
  const child = spawn(cmd, [...args, "--port", "0", "--host", "127.0.0.1", "--data", data, "--no-discover"], { env: { ...process.env, TEMPOLIGHT_NO_DISCOVER: "1", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  const exited = new Promise(r => child.on("exit", (code, sig) => r({ code, sig })));
  try {
    const port = await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`no "running" line within ${timeout} ms`)), timeout);
      const on = d => { log += d; const m = log.match(/http:\/\/localhost:(\d+)/); if (m) { clearTimeout(t); res(Number(m[1])); } };
      child.stdout.on("data", on); child.stderr.on("data", d => { log += d; });
      child.on("error", e => { clearTimeout(t); rej(e); });
      exited.then(({ code, sig }) => { clearTimeout(t); rej(new Error(`exited (${code ?? sig}) before it started`)); });
    });
    const results = [];
    let version = "";
    for (const [url, ok] of CHECKS) {
      const r = await fetch(`http://127.0.0.1:${port}${url}`), b = await r.text();
      let good = false; try { good = r.status === 200 && !!ok(r, b); } catch {}
      if (!good) throw new Error(`GET ${url} -> ${r.status} ${b.slice(0, 200)}`);
      if (url === "/api/health") version = JSON.parse(b).version;
      results.push(`ok ${url}`);
    }
    return { port, version, results };
  } catch (e) { e.message += `\n--- output ---\n${log}`; throw e; }
  finally { child.kill("SIGTERM"); await Promise.race([exited, new Promise(r => setTimeout(r, 3000))]); if (child.exitCode === null) child.kill("SIGKILL"); try { rmSync(data, { recursive: true, force: true }); } catch {} }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd) { console.error("usage: node scripts/smoke.js <command> [args…]"); process.exit(2); }
  smoke(path.isAbsolute(cmd) || !cmd.includes("/") && !cmd.includes("\\") ? cmd : path.resolve(cmd), args)
    .then(r => { console.log(`Tempolight ${r.version} answered on port ${r.port}:\n  ${r.results.join("\n  ")}`); })
    .catch(e => { console.error(`Smoke test failed: ${e.message}`); process.exit(1); });
}
