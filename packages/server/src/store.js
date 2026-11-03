// Everything the app remembers between restarts, in one JSON file (data/tempolight.json by default).
// Writes are debounced and atomic (write to a temp file, then rename), so a power cut can't corrupt it.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DEFAULTS, merge } from "./defaults.js";
export { DEFAULTS };

export function createStore(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, "tempolight.json");
  let data = DEFAULTS(), firstRun = true;
  if (existsSync(file)) {
    try { data = merge(DEFAULTS(), JSON.parse(readFileSync(file, "utf8"))); firstRun = false; }
    catch (e) { const bad = file + ".broken-" + Date.now(); try { renameSync(file, bad); } catch {} console.warn(`Settings file was unreadable (${e.message}); saved a copy as ${path.basename(bad)} and started fresh.`); }
  }
  let timer = null;
  const flush = () => { clearTimeout(timer); timer = null; const tmp = file + ".tmp"; writeFileSync(tmp, JSON.stringify(data, null, 2)); renameSync(tmp, file); };
  return {
    get data() { return data; }, firstRun, file,
    save() { if (!timer) timer = setTimeout(flush, 250); },
    flush,
    reset() { data = DEFAULTS(); flush(); },
  };
}

export const newId = (prefix = "") => prefix + crypto.randomBytes(4).toString("hex");

export function hashPin(pin, salt = crypto.randomBytes(8).toString("hex")) {
  return { salt, hash: crypto.scryptSync(String(pin), salt, 32).toString("hex") };
}
export function checkPin(lock, pin) {
  if (!lock) return true;
  const h = crypto.scryptSync(String(pin ?? ""), lock.salt, 32);
  return crypto.timingSafeEqual(h, Buffer.from(lock.hash, "hex"));
}
