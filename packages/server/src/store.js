// Everything the app remembers between restarts, in one JSON file (data/tempolight.json by default).
// Writes are debounced and atomic (write to a temp file, then rename), so a power cut can't corrupt it.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const DEFAULTS = () => ({
  version: 2,
  settings: {
    brightness: 0.8, fps: 60, safe: false, syncOffsetMs: 0, predict: true,
    ambient: "northern", idleBrightness: 0.5, idleAfterSec: 8, dropFlash: true,
    audioSync: false, osc: { enabled: false, port: 9000 }, autoDiscover: true,
    capture: { enabled: false, source: "auto", command: "" }, metronome: { enabled: false, bpm: 120 },
    guest: { effects: true, scenes: true, pads: true, brightness: true },
  },
  show: { power: true, mode: "auto", effect: "shock", style: "auto", palette: "auto", everyBeats: 8, speed: 1 },
  devices: [],
  room: { name: "My room", shapes: [] },
  scenes: [
    { id: "party", name: "Party", show: { mode: "auto", style: "party", palette: "auto" }, brightness: 1 },
    { id: "chill", name: "Chill evening", show: { mode: "auto", style: "chill", palette: "sunset" }, brightness: 0.55 },
    { id: "movie", name: "Movie night", show: { mode: "manual", effect: "candle", palette: "mono" }, brightness: 0.25 },
    { id: "focus", name: "Focus", show: { mode: "manual", effect: "aurora", palette: "ocean" }, brightness: 0.4 },
  ],
  schedules: [],
  lock: null,
});

function merge(base, over) {
  if (Array.isArray(base) || Array.isArray(over) || typeof base !== "object" || base === null || typeof over !== "object" || over === null) return over === undefined ? base : over;
  const out = { ...base }; for (const k of Object.keys(over)) out[k] = merge(base[k], over[k]); return out;
}

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
