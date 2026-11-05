// The music library: point Tempolight at your music folders and it analyses every song ahead of time, as if each
// had been played once on the Music page. Each song becomes a song memory entry (beat map, sections, key, mood, the
// fingerprints) with its look and show, so it is followed exactly from the first play: straight away when a music app
// here says it plays that file (nowplaying.js), and after a few seconds of listening otherwise (song memory).
//
// Files are found by walking the chosen folders (symbolic links only when they lead to somewhere inside them) and
// analysed in a pool of worker threads (library-worker.js): one on a small computer (low-power mode), else up to one
// fewer than the CPU cores, at the lowest priority, never while the frame loop is struggling, and pausable. A file
// already analysed (same path, size and modification time) is skipped; a file with the same contents as one already
// analysed (moved or copied: the same size and the same first and last 64 kB) is not analysed again, and a song that
// is already in the library in another file (another format, the same recording) is kept once.
//
// Decoding: ffmpeg when it is installed (any format), else WAV files only (audiofile.js). Names come from the tags
// (ffprobe, or a WAV's INFO chunk) as "Artist - Title", else from the file name.
//
// Storage: library.json in the data folder (the files seen and what became of them) and one file per song in
// library/, so the settings file stays small however big the library is. Only a light copy of each song (what the
// recogniser needs: the fingerprints, tempo, length) is kept in memory; the whole entry is read from its file when
// the song plays (a few at a time are kept). The routes are /api/library (admin only).
//
// Node only: the online demo (apps/web/demo.js) never loads this file.
import { Worker } from "node:worker_threads";
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, rmSync, watch as fsWatch, realpathSync, statSync } from "node:fs";
import { readdir, stat, realpath, open } from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { HttpError } from "./core.js";
import { AUDIO_EXT, toolWorks, analyseFile } from "./audiofile.js";
import { drumlessEntry } from "../../engine/src/index.js";

const INDEX_V = 1;
export const CAPS = { full: { songs: 5000, bytes: 200 * 1024 * 1024 }, lite: { songs: 1500, bytes: 60 * 1024 * 1024 } }; // songs and bytes of song files on disk
const MAX_FOLDERS = 20, MAX_FILES = 100000, MAX_DEPTH = 32, CACHE = 12; // whole entries kept in memory (the songs playing and edited)
const SKIP_DIRS = new Set(["@eaDir", "$RECYCLE.BIN", "System Volume Information", "node_modules", "#recycle", ".Trash", ".Trashes"]);
const ID_RE = /^l[0-9a-z]{8,16}$/;
const LIGHT = ["id", "name", "dur", "bpm", "style", "fp", "ch", "key", "mode", "src", "path"]; // the light copy (plus drumless, look)

/** Is `p` the folder `root` or inside it? Both absolute and normalised. */
export function inside(root, p) { const r = path.relative(root, p); return r === "" || (!!r && !r.startsWith("..") && !path.isAbsolute(r)); }

/**
 * A folder someone typed: an absolute path ("~/Music" works too), resolved, existing, a folder, not the whole disk.
 * Returns its real path (links followed), or throws an HttpError 400 saying why.
 */
export function cleanFolder(input, home = os.homedir()) {
  let s = String(input ?? "").trim(); if (!s) throw new HttpError(400, "Type the folder's full path, for example /home/you/Music");
  if (s.length > 1024 || s.includes("\0")) throw new HttpError(400, "That isn't a folder path");
  if (s === "~" || s.startsWith("~/") || s.startsWith("~\\")) s = path.join(home, s.slice(1));
  if (!path.isAbsolute(s)) throw new HttpError(400, `“${s}” isn't a full path. Start it at the top: /home/you/Music, C:\\Users\\you\\Music or ~/Music`);
  let real; try { real = realpathSync(path.resolve(s)); } catch { throw new HttpError(400, `There is no folder ${s} on the computer Tempolight runs on`); }
  let st; try { st = statSync(real); } catch { st = null; } if (!st || !st.isDirectory()) throw new HttpError(400, `${s} isn't a folder`);
  if (path.dirname(real) === real) throw new HttpError(400, "Pick a music folder, not the whole disk");
  return real;
}

/** The cheap content fingerprint: size and the first and last 64 kB (a moved or copied file has the same). */
async function quickHash(file, size) {
  const fh = await open(file, "r"); try { const h = crypto.createHash("sha1"), n = Math.min(65536, size), b = Buffer.alloc(n);
    h.update(String(size)); await fh.read(b, 0, n, 0); h.update(b); if (size > n) { await fh.read(b, 0, n, Math.max(n, size - n)); h.update(b); }
    return h.digest("base64url").slice(0, 22); } finally { await fh.close(); }
}

// the loudness shape of a stored fingerprint (10 a second), for telling the same recording in two files apart from two songs
const unb64 = s => new Uint8Array(Buffer.from(String(s || ""), "base64"));
function shapeOf(fp) { const q = unb64(fp), out = new Float32Array(q.length); let m = q[0] || 0; for (let i = 0; i < q.length; i++) { m += (q[i] - m) * 0.2; out[i] = q[i] - m; } return out; }
/** Do two entries hold the same recording? Same length (within 2 s) and loudness shapes that line up (within 1 s). */
export function sameRecording(a, b) {
  if (!a?.fp || !b?.fp || Math.abs((a.dur || 0) - (b.dur || 0)) > 2) return false;
  const x = shapeOf(a.fp), y = shapeOf(b.fp), n = Math.min(x.length, y.length); if (n < 100) return false;
  let best = 0;
  for (let d = -10; d <= 10; d++) { let xy = 0, xx = 0, yy = 0; for (let i = Math.max(0, -d); i < n && i + d < n; i++) { const u = x[i], v = y[i + d]; xy += u * v; xx += u * u; yy += v * v; }
    const c = xx > 0 && yy > 0 ? xy / Math.sqrt(xx * yy) : 0; if (c > best) best = c; }
  return best > 0.9;
}

/**
 * @param {{core:object, store:object, runtime:object, dataDir:string, ffmpeg?:string|false, ffprobe?:string|false,
 *   workers?:number, startDelay?:number, inline?:boolean, rescanMs?:number, watch?:boolean}} o ffmpeg/ffprobe: the
 *   programs (false: pretend they aren't installed); workers: the pool's size (default: from the computer); inline:
 *   analyse in this thread (the one-file app, which has no separate worker file)
 */
export function startLibrary({ core, store, runtime, dataDir, ...o }) {
  const data = () => store.data, rt = runtime.rt, perf = runtime.perf;
  const set = () => data().settings.library || (data().settings.library = { folders: [], watch: true, paused: false });
  const dir = path.join(dataDir, "library"), indexFile = path.join(dataDir, "library.json");
  mkdirSync(dir, { recursive: true });
  const note = (m, l) => runtime.note(m, l);

  // ---------------------------------------------------------------- what is kept
  let index = { v: INDEX_V, files: {} }; // path -> {size, mtimeMs, qh, state: done|error|needs|skipped|removed|duplicate, id?, error?, dupOf?}
  try { if (existsSync(indexFile)) { const j = JSON.parse(readFileSync(indexFile, "utf8")); if (j && j.files && typeof j.files === "object") index = { v: INDEX_V, files: j.files }; } }
  catch (e) { try { renameSync(indexFile, indexFile + ".broken-" + Date.now()); } catch {} note(`Music library: its list was unreadable (${e.message}); the folders will be analysed again`, "warn"); }
  const light = new Map(); // id -> light entry (what the recogniser and the name matching need)
  const byPath = new Map(); // a file's path (as found, and its real path) -> id
  const full = new Map(); // id -> whole entry, the most recently used few
  let bytes = 0; const sizes = new Map(); // id -> bytes of its file
  const lightOf = e => { const l = {}; for (const k of LIGHT) if (e[k] !== undefined) l[k] = e[k]; l.drumless = drumlessEntry(e);
    l.look = e.look ? { main: e.look.main, palette: e.look.palette || null, locked: !!e.look.locked } : null; return l; };
  const fileOf = id => path.join(dir, `${id}.json`); // (id is checked against ID_RE wherever it comes from outside)
  function writeEntry(e) { const s = JSON.stringify(e), tmp = fileOf(e.id) + ".tmp"; writeFileSync(tmp, s); renameSync(tmp, fileOf(e.id)); bytes += s.length - (sizes.get(e.id) || 0); sizes.set(e.id, s.length); }
  function register(e, file) {
    light.set(e.id, lightOf(e)); byPath.set(file, e.id); try { byPath.set(realpathSync(file), e.id); } catch {}
  }
  // the songs kept from before: their light copies (each file is read once at the start)
  for (const [file, r] of Object.entries(index.files)) {
    if (r.state !== "done" || !ID_RE.test(r.id || "")) continue;
    try { const s = readFileSync(fileOf(r.id), "utf8"), e = JSON.parse(s); if (e.id !== r.id) throw new Error("wrong id"); e.path = file; register(e, file); sizes.set(e.id, s.length); bytes += s.length; }
    catch { delete index.files[file]; }
  }
  let indexTimer = null;
  const saveIndex = (now = false) => { clearTimeout(indexTimer); indexTimer = null;
    const w = () => { indexTimer = null; const tmp = indexFile + ".tmp"; writeFileSync(tmp, JSON.stringify(index)); renameSync(tmp, indexFile); };
    if (now) w(); else indexTimer = setTimeout(w, 1000); };
  const dirty = new Map(); let dirtyTimer = null;
  const flushDirty = () => { clearTimeout(dirtyTimer); dirtyTimer = null; for (const e of dirty.values()) { try { writeEntry(e); } catch (err) { note(`Music library: couldn't save “${e.name}” (${err.message})`, "warn"); } } dirty.clear(); };
  function cacheFull(e) { full.delete(e.id); full.set(e.id, e); while (full.size > CACHE) { const k = full.keys().next().value; if (dirty.has(k)) break; full.delete(k); } return e; }

  const cap = () => perf.lite ? CAPS.lite : CAPS.full;
  const lib = {
    list: () => [...light.values()],
    full(id) {
      if (!ID_RE.test(String(id)) || !light.has(id)) return null;
      const c = full.get(id); if (c) return cacheFull(c);
      try { const e = JSON.parse(readFileSync(fileOf(id), "utf8")); e.src = "library"; e.path = light.get(id).path; return cacheFull(e); } catch { return null; }
    },
    byPath(p) { if (typeof p !== "string" || !p || p.includes("\0")) return null; let id = byPath.get(path.resolve(p));
      if (!id) { try { id = byPath.get(realpathSync(p)); } catch {} } return id ? light.get(id) || null : null; },
    save(e) { if (!light.has(e.id)) return; light.set(e.id, lightOf(e)); cacheFull(e); dirty.set(e.id, e); if (!dirtyTimer) dirtyTimer = setTimeout(flushDirty, 500); },
    remove(id) { return removeSong(id, "removed"); },
  };
  rt.library = lib;
  function removeSong(id, state) {
    if (!ID_RE.test(String(id)) || !light.has(id)) return false;
    const l = light.get(id); light.delete(id); full.delete(id); dirty.delete(id);
    for (const [k, v] of byPath) if (v === id) byPath.delete(k);
    try { rmSync(fileOf(id), { force: true }); } catch {} bytes -= sizes.get(id) || 0; sizes.delete(id);
    const r = l && index.files[l.path]; if (r) { if (state === "gone") delete index.files[l.path]; else { r.state = state; delete r.id; } }
    for (const r2 of Object.values(index.files)) if (r2.dupOf === id) { r2.state = "new"; delete r2.dupOf; } // its duplicates are looked at again
    saveIndex(); return true;
  }

  // ---------------------------------------------------------------- tools
  const tools = { ffmpeg: null, ffprobe: null, checked: 0, p: null };
  function checkTools() {
    if (tools.p && Date.now() - tools.checked < 30000) return tools.p; tools.checked = Date.now();
    const f = o.ffmpeg === false ? null : o.ffmpeg || process.env.TEMPOLIGHT_FFMPEG || "ffmpeg", p = o.ffprobe === false ? null : o.ffprobe || process.env.TEMPOLIGHT_FFPROBE || "ffprobe";
    return (tools.p = Promise.all([toolWorks(f), toolWorks(p)]).then(([a, b]) => { tools.ffmpeg = a ? f : null; tools.ffprobe = b ? p : null; tools.done = true; return tools; }));
  }

  // ---------------------------------------------------------------- the pool
  const embedded = !!globalThis.__tempolightAssets; // the one-file app: library-worker.js isn't a file there
  const workerCount = () => o.workers || (perf.lite ? 1 : Math.max(1, Math.min(8, (os.availableParallelism?.() || os.cpus().length) - 1)));
  const P = { queue: [], workers: [], inline: !!o.inline || embedded, jobN: 0, running: new Map(), // job -> {file, w, t}
    done: 0, total: 0, t0: 0, activeMs: 0, lastTick: 0, decodeMs: 0, analyseMs: 0, n: 0, waiting: null, nice: null };
  const heavy = () => { const target = perf.lite ? Math.min(data().settings.fps || 60, 30) : data().settings.fps || 60; // the lights come first
    return (perf.fps > 0 && perf.fps < target * 0.8) || perf.load > 0.7; };
  function newWorker() {
    const w = { worker: new Worker(new URL("./library-worker.js", import.meta.url), { workerData: { background: o.background !== false } }), jobs: new Set(), ready: false, idleSince: Date.now() };
    w.worker.on("message", m => { if (m.ready) { w.ready = true; P.nice = m.nice; return; } finish(m, w); });
    w.worker.on("error", e => { note(`Music library: an analysis worker stopped (${e.message})`, "warn"); dropWorker(w, true); });
    w.worker.on("exit", () => dropWorker(w, true));
    w.worker.unref(); P.workers.push(w); return w;
  }
  function dropWorker(w, requeue) {
    const i = P.workers.indexOf(w); if (i < 0) return; P.workers.splice(i, 1);
    for (const j of w.jobs) { const r = P.running.get(j); P.running.delete(j); if (requeue && r) P.queue.unshift(r.file); }
    w.jobs.clear(); try { w.worker.terminate(); } catch {}
    if (requeue) setTimeout(pump, 200);
  }
  const perWorker = () => perf.lite ? 1 : 2; // a second file is decoded while one is analysed
  let pumpTimer = null;
  function pump() {
    clearTimeout(pumpTimer); pumpTimer = null; tick();
    if (set().paused || closed) return;
    if (!P.queue.length) { if (!P.running.size) idle(); return; }
    if (heavy()) { P.waiting = "the lights are busy"; pumpTimer = setTimeout(pump, 3000); return; }
    if (bytes >= cap().bytes || light.size >= cap().songs) { P.waiting = null; full_(); return; }
    P.waiting = null;
    if (P.inline) { if (!P.running.size) runInline(P.queue.shift()); return; }
    while (P.workers.length < workerCount() && P.workers.length < P.queue.length + P.running.size) newWorker();
    for (const w of P.workers) while (P.queue.length && w.jobs.size < perWorker()) dispatch(w, P.queue.shift());
  }
  let fullNoted = false;
  function full_() { P.queue.length = 0; if (!fullNoted) { fullNoted = true; note(`Music library: full (${light.size} songs). Remove songs or folders to add others.`, "warn"); } }
  function dispatch(w, file) {
    const job = ++P.jobN; P.running.set(job, { file, w, t: performance.now() }); w.jobs.add(job);
    w.worker.postMessage({ job, file, ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe, id: newLibId() });
  }
  async function runInline(file) {
    const job = ++P.jobN; P.running.set(job, { file, w: null, t: performance.now() });
    let m; try { m = { job, ok: true, ...await analyseFile(file, { ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe, id: newLibId() }) }; }
    catch (e) { m = { job, ok: false, error: String(e?.message || e), needs: e?.needs || null, skip: !!e?.skip }; }
    finish(m, null);
  }
  const newLibId = () => { let id; do id = "l" + crypto.randomBytes(5).toString("hex"); while (light.has(id)); return id; };
  function tick() { const now = performance.now(); if (P.running.size && P.lastTick) P.activeMs += now - P.lastTick; P.lastTick = now; }
  function idle() { // nothing left: the workers go after a while (they hold the engine's code and buffers)
    for (const w of P.workers.slice()) if (!w.jobs.size) { if (!w.idleTimer) w.idleTimer = setTimeout(() => { if (!w.jobs.size) dropWorker(w, false); }, o.workerIdleMs ?? 30000); }
    if (P.total && P.done >= P.total && !scanning) { if (!P.announced) { P.announced = true; note(`Music library: ${light.size} song${light.size === 1 ? "" : "s"} ready${errorsCount() ? `, ${errorsCount()} couldn't be read` : ""}`); } core.broadcast({ type: "changed", what: "library" }); }
  }
  function finish(m, w) {
    tick(); const r = P.running.get(m.job); if (!r) return; P.running.delete(m.job); if (w) { w.jobs.delete(m.job); clearTimeout(w.idleTimer); w.idleTimer = null; }
    const file = r.file, rec = index.files[file]; P.done++;
    if (!rec || closed) return pump(); // (the folder was taken away meanwhile)
    if (!m.ok) {
      if (m.needs === "ffmpeg") { rec.state = "needs"; rec.error = "needs ffmpeg"; }
      else { rec.state = m.skip ? "skipped" : "error"; rec.error = String(m.error).slice(0, 200); }
      delete rec.id; saveIndex(); return pump();
    }
    P.n++; P.decodeMs += m.decodeMs; P.analyseMs += m.analyseMs;
    const e = m.entry; e.src = "library"; e.path = file;
    const twin = [...light.values()].find(l => l.path !== file && sameRecording(l, e)); // another file of the same recording
    if (twin) { rec.state = "duplicate"; rec.dupOf = twin.id; delete rec.id; delete rec.error; saveIndex(); return pump(); }
    try { runtime.prepareSong(e); } catch (err) { note(`Music library: no look for “${e.name}” (${err.message})`, "warn"); }
    try { writeEntry(e); } catch (err) { rec.state = "error"; rec.error = `couldn't save: ${err.message}`; saveIndex(); return pump(); }
    register(e, file); cacheFull(e); rec.state = "done"; rec.id = e.id; delete rec.error; delete rec.dupOf;
    saveIndex(); if (P.done % 10 === 0 || !P.queue.length) core.broadcast({ type: "changed", what: "library" });
    pump();
  }

  // ---------------------------------------------------------------- finding the files
  let scanning = false, scanAgain = false, closed = false, lastScan = null;
  const roots = () => (set().folders || []).map(f => { try { return realpathSync(f); } catch { return null; } }).filter(Boolean);
  async function walk(rootList, onFile) {
    const seen = new Set(); let count = 0;
    async function go(d, depth) {
      if (depth > MAX_DEPTH || count >= MAX_FILES || closed) return;
      let real; try { real = await realpath(d); } catch { return; }
      if (seen.has(real) || !rootList.some(r => inside(r, real))) return; seen.add(real); // never outside the chosen folders, never twice (a link loop)
      let list; try { list = await readdir(d, { withFileTypes: true }); } catch { return; }
      list.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      for (const de of list) {
        if (count >= MAX_FILES) return;
        if (de.name.startsWith(".") || SKIP_DIRS.has(de.name)) continue;
        const p = path.join(d, de.name);
        let isDir = de.isDirectory(), isFile = de.isFile();
        if (de.isSymbolicLink()) { let t; try { t = await realpath(p); } catch { continue; } if (!rootList.some(r => inside(r, t))) continue; // a link out of the folders: not followed
          let st; try { st = await stat(t); } catch { continue; } isDir = st.isDirectory(); isFile = st.isFile(); }
        if (isDir) await go(p, depth + 1);
        else if (isFile && AUDIO_EXT.has(path.extname(de.name).toLowerCase())) { let st; try { st = await stat(p); } catch { continue; } count++; await onFile(p, st); }
      }
    }
    for (const r of rootList) await go(r, 0);
    return count;
  }
  /** Look through the folders: new and changed files are queued, missing ones forgotten. */
  async function scan() {
    if (scanning) { scanAgain = true; return; } scanning = true; P.announced = false; fullNoted = false;
    try {
      await checkTools();
      const rs = roots(), found = new Set(), queued = new Set(P.queue), byHash = new Map();
      for (const [f, r] of Object.entries(index.files)) if (r.qh && r.state === "done" && r.id) byHash.set(r.qh, f);
      const toQueue = [];
      await walk(rs, async (file, st) => {
        found.add(file);
        let r = index.files[file];
        const same = r && r.size === st.size && Math.abs(r.mtimeMs - st.mtimeMs) < 1;
        if (same) {
          if (r.state === "needs" && tools.ffmpeg) r.state = "new"; // ffmpeg is here now
          if (r.state === "new" && !queued.has(file) && ![...P.running.values()].some(x => x.file === file)) toQueue.push(file);
          return; }
        if (st.size > 1024 * 1024 * 1024) { index.files[file] = { size: st.size, mtimeMs: st.mtimeMs, state: "skipped", error: "bigger than 1 GB" }; return; }
        let qh = null; try { qh = await quickHash(file, st.size); } catch { return; }
        if (r && r.id) removeSong(r.id, "gone"); // it changed: analysed again
        const other = byHash.get(qh), oid = other && index.files[other]?.id;
        if (oid && other !== file && light.has(oid)) {
          if (!existsSync(other)) { // moved (or renamed): the analysis moves with it
            const e = lib.full(oid); delete index.files[other]; for (const [k, v] of byPath) if (v === oid) byPath.delete(k);
            index.files[file] = { size: st.size, mtimeMs: st.mtimeMs, qh, state: "done", id: oid }; if (e) { e.path = file; writeEntry(e); register(e, file); } byHash.set(qh, file); return; }
          index.files[file] = { size: st.size, mtimeMs: st.mtimeMs, qh, state: "duplicate", dupOf: oid }; return; } // a copy
        index.files[file] = { size: st.size, mtimeMs: st.mtimeMs, qh, state: "new" }; toQueue.push(file);
      });
      // files that went (or whose folder was taken out of the list): forgotten
      for (const [f, r] of Object.entries(index.files)) if (!found.has(f) && (!rs.some(x => inside(x, f)) || !existsSync(f))) { if (r.id) removeSong(r.id, "gone"); delete index.files[f]; }
      P.queue = P.queue.filter(f => index.files[f]); for (const f of toQueue) if (!P.queue.includes(f)) P.queue.push(f);
      if (P.done >= P.total || !P.total) { P.done = 0; P.total = 0; P.activeMs = 0; } P.total += toQueue.length;
      lastScan = { at: Date.now(), files: found.size };
      saveIndex();
    } catch (e) { note(`Music library: couldn't look through the folders (${e.message})`, "warn"); }
    finally { scanning = false; }
    core.broadcast({ type: "changed", what: "library" });
    pump();
    if (scanAgain) { scanAgain = false; return scan(); }
  }

  // ---------------------------------------------------------------- watching the folders
  let watchers = [], watchTimer = null, rescanTimer = null;
  function rewatch() {
    for (const w of watchers) try { w.close(); } catch {} watchers = []; clearInterval(rescanTimer); rescanTimer = null;
    if (closed || !set().watch || o.watch === false) return;
    const soon = () => { clearTimeout(watchTimer); watchTimer = setTimeout(() => scan().catch(() => {}), o.watchDelay ?? 10000); };
    for (const r of roots()) { try { const w = fsWatch(r, { recursive: true, persistent: false }, soon); w.on("error", () => {}); watchers.push(w); } catch {} }
    rescanTimer = setInterval(() => scan().catch(() => {}), o.rescanMs ?? 15 * 60000); rescanTimer.unref?.(); // and now and then anyway (network drives, Linux without recursive watching)
  }

  // ---------------------------------------------------------------- the view and the routes
  const counts = () => { const c = { files: 0, analysed: light.size, queued: P.queue.length + P.running.size, errors: 0, needsFfmpeg: 0, skipped: 0, duplicates: 0, removed: 0 };
    for (const r of Object.values(index.files)) { c.files++; if (r.state === "error") c.errors++; else if (r.state === "needs") c.needsFfmpeg++; else if (r.state === "skipped") c.skipped++; else if (r.state === "duplicate") c.duplicates++; else if (r.state === "removed") c.removed++; }
    return c; };
  const errorsCount = () => Object.values(index.files).filter(r => r.state === "error").length;
  const relName = f => { const r = roots().find(x => inside(x, f)); return r ? path.relative(r, f) || path.basename(f) : path.basename(f); };
  function view(withSongs = true) {
    tick(); const c = counts(), fx = Object.fromEntries(runtime.effects.list.map(f => [f.id, f.name]));
    const state = set().paused ? "paused" : scanning ? "scanning" : P.running.size || P.queue.length ? (P.waiting ? "waiting" : "analysing") : "idle";
    const each = P.done ? P.activeMs / P.done : 0;
    const msg = !tools.ffmpeg && tools.done ? "Install ffmpeg to analyse MP3/AAC/FLAC; WAV works now." : null;
    return {
      available: true, folders: (set().folders || []).map(f => ({ path: f, exists: existsSync(f), songs: [...light.values()].filter(l => inside(f, l.path)).length })),
      watch: !!set().watch, paused: !!set().paused, ffmpeg: !!tools.ffmpeg, ffprobe: !!tools.ffprobe, message: msg,
      counts: c, cap: { songs: light.size, maxSongs: cap().songs, bytes, maxBytes: cap().bytes, full: light.size >= cap().songs || bytes >= cap().bytes },
      progress: { state, waiting: P.waiting, done: P.done, total: P.total, perSongMs: Math.round(each), avgDecodeMs: P.n ? Math.round(P.decodeMs / P.n) : 0, avgAnalyseMs: P.n ? Math.round(P.analyseMs / P.n) : 0,
        workers: P.inline ? 0 : P.workers.length, maxWorkers: P.inline ? 1 : workerCount(), inline: P.inline, current: [...P.running.values()].map(r => relName(r.file)).slice(0, 8), lastScan },
      errors: Object.entries(index.files).filter(([, r]) => r.state === "error" || r.state === "needs" || r.state === "skipped").slice(0, 50).map(([f, r]) => ({ file: relName(f), state: r.state, error: r.error || "" })),
      ...(withSongs ? { songs: [...light.values()].sort((a, b) => a.name.localeCompare(b.name)).map(l => ({ id: l.id, name: l.name, bpm: l.bpm, dur: l.dur, key: l.key ? `${l.key} ${l.mode || ""}`.trim() : null,
        look: l.look ? { main: l.look.main, name: fx[l.look.main] || l.look.main, palette: l.look.palette, locked: l.look.locked } : null, file: relName(l.path) })) } : {}),
    };
  }
  const changed = () => { store.save(); core.broadcast({ type: "changed", what: "library" }); };
  core.route("GET", "/api/library", "admin", ctx => view(ctx.query?.songs !== "0"));
  core.route("PATCH", "/api/library", "admin", async ctx => {
    const b = ctx.body || {}, s = set();
    if (b.folders !== undefined) {
      if (!Array.isArray(b.folders)) throw new HttpError(400, "folders is a list of folder paths");
      if (b.folders.length > MAX_FOLDERS) throw new HttpError(400, `At most ${MAX_FOLDERS} folders`);
      const list = []; for (const f of b.folders) { const c = cleanFolder(f); if (!list.includes(c)) list.push(c); }
      const added = list.filter(f => !(s.folders || []).includes(f)); s.folders = list;
      if (added.length) note(`Music library: added ${added.join(", ")}`);
    }
    if (b.watch !== undefined) s.watch = !!b.watch;
    changed(); rewatch(); scan().catch(() => {}); return view(false);
  });
  core.route("POST", "/api/library/scan", "admin", () => { if (!(set().folders || []).length) throw new HttpError(400, "Add a music folder first"); scan().catch(() => {}); return view(false); });
  core.route("POST", "/api/library/pause", "admin", () => { pause(); return view(false); });
  core.route("POST", "/api/library/resume", "admin", () => { set().paused = false; changed(); note("Music library: analysing again"); pump(); return view(false); });
  core.route("DELETE", "/api/library/songs/:id", "admin", (ctx, p) => {
    if (!ID_RE.test(p.id) || !light.has(p.id)) throw new HttpError(404, "That song isn't in the library");
    const name = light.get(p.id).name; runtime.forget(p.id); note(`Music library: removed “${name}” (the file stays; it won't be added again unless it changes)`); changed(); return { ok: true };
  });
  function pause() { if (set().paused) return; set().paused = true; changed(); // at once: the songs being analysed now start again on resume
    for (const r of [...P.running.values()].reverse()) if (r.w) P.queue.unshift(r.file); // (one analysed in this thread finishes)
    for (const w of P.workers.slice()) dropWorker(w, false); note("Music library: paused"); }

  // ---------------------------------------------------------------- start
  // TEMPOLIGHT_MUSIC: folders to add at every start (Docker: the folder the music is mounted at), separated by : (; on Windows)
  for (const f of String((o.env || process.env).TEMPOLIGHT_MUSIC || "").split(path.delimiter).map(x => x.trim()).filter(Boolean)) {
    try { const c = cleanFolder(f), s = set(); s.folders ||= []; if (!s.folders.includes(c) && s.folders.length < MAX_FOLDERS) { s.folders.push(c); store.save(); } }
    catch (e) { note(`Music library: TEMPOLIGHT_MUSIC: ${e.message}`, "warn"); } }
  checkTools().then(() => { if (!tools.ffmpeg && (set().folders || []).length) note("Music library: ffmpeg isn't installed, so only WAV files can be analysed. Install ffmpeg to analyse MP3, AAC and FLAC too.", "warn"); }).catch(() => {});
  let startTimer = null;
  if ((set().folders || []).length && o.startDelay !== false) startTimer = setTimeout(() => scan().catch(() => {}), o.startDelay ?? 5000); // (not while starting up)
  rewatch();
  return {
    lib, scan, view, pause, get workers() { return P.workers.length; }, workerCount, get nice() { return P.nice; },
    /** Waits until nothing is queued or being analysed (tests). */
    async idle(ms = 60000) { const t = Date.now(); while (Date.now() - t < ms) { if (!scanning && !P.queue.length && !P.running.size) return true; await new Promise(r => setTimeout(r, 50)); } return false; },
    close() { closed = true; clearTimeout(startTimer); clearTimeout(pumpTimer); clearTimeout(watchTimer); clearInterval(rescanTimer); for (const w of watchers) try { w.close(); } catch {} for (const w of P.workers.slice()) dropWorker(w, false); flushDirty(); if (indexTimer) saveIndex(true); if (rt.library === lib) delete rt.library; },
  };
}
