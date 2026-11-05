// Reading song files for the music library (library.js): any format through ffmpeg when it is installed, and WAV
// without it (a small reader for 8, 16, 24 and 32-bit PCM and 32/64-bit float, any number of channels). Songs come
// out as mono samples at about 22 kHz, as the browser hands them to the whole-song analysis (apps/web/audio.js).
// Also the song's name from its tags (ffprobe, or a WAV's LIST INFO chunk), else from the file name.
// Node only: the online demo has no files.
import { spawn } from "node:child_process";
import { readFile, open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { preAnalyseCore, memoryEntry } from "../../engine/src/index.js";

export const RATE = 22050; // the analysis rate (what ffmpeg is asked for; a WAV is averaged down to 22-24 kHz)
export const AUDIO_EXT = new Set([".wav", ".wave", ".mp3", ".m4a", ".aac", ".mp4", ".flac", ".ogg", ".oga", ".opus", ".aif", ".aiff", ".aifc", ".wma", ".webm", ".alac", ".ape", ".wv", ".mka"]);
export const WAV_EXT = new Set([".wav", ".wave"]);
export const MAX_SECONDS = 30 * 60; // longer files (DJ mixes, audiobooks) are skipped: a song memory entry is for one song
export const MAX_BYTES = 1024 * 1024 * 1024;

// ---------------------------------------------------------------- WAV
/**
 * The format of a WAV file from its first bytes: {format, channels, rate, bits, dataStart, dataBytes, tags}, or throws
 * with a short reason. format: "pcm" or "float". tags: {title, artist} from a LIST INFO chunk, when there is one.
 * @param {Buffer} buf the file (or at least its header; dataBytes is clamped to what buf holds when `whole`)
 */
export function wavInfo(buf, whole = true) {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a WAV file");
  let p = 12, fmt = null, data = null; const tags = {};
  while (p + 8 <= buf.length) {
    const id = buf.toString("ascii", p, p + 4), size = buf.readUInt32LE(p + 4), body = p + 8;
    if (id === "fmt " && body + 16 <= buf.length) {
      let code = buf.readUInt16LE(body); const channels = buf.readUInt16LE(body + 2), rate = buf.readUInt32LE(body + 4), bits = buf.readUInt16LE(body + 14);
      if (code === 0xfffe && size >= 40 && body + 26 <= buf.length) code = buf.readUInt16LE(body + 24); // WAVE_FORMAT_EXTENSIBLE: the sub-format's first two bytes
      fmt = { code, channels, rate, bits };
    } else if (id === "LIST" && body + 4 <= buf.length && buf.toString("ascii", body, body + 4) === "INFO") {
      let q = body + 4; const end = Math.min(buf.length, body + size);
      while (q + 8 <= end) { const k = buf.toString("ascii", q, q + 4), n = buf.readUInt32LE(q + 4), v = buf.toString("utf8", q + 8, Math.min(end, q + 8 + n)).replace(/\0+$/, "").trim();
        if (k === "INAM" && v) tags.title = v; if (k === "IART" && v) tags.artist = v; q += 8 + n + (n & 1); }
    } else if (id === "data") { data = { start: body, bytes: size }; if (fmt && !whole) break; }
    if (data && fmt && !whole) break;
    p = body + size + (size & 1); // chunks are padded to an even length
    if (id === "data" && (size === 0xffffffff || size === 0)) break; // a stream written without its length: the data runs to the end
  }
  if (!fmt) throw new Error("the WAV file has no format chunk");
  if (!data) throw new Error("the WAV file has no sound data");
  const format = fmt.code === 1 ? "pcm" : fmt.code === 3 ? "float" : null;
  if (!format) throw new Error(`this WAV uses a compressed format (code ${fmt.code}); install ffmpeg to read it`);
  if (format === "pcm" && ![8, 16, 24, 32].includes(fmt.bits) || format === "float" && ![32, 64].includes(fmt.bits)) throw new Error(`${fmt.bits}-bit ${format} WAV isn't supported`);
  if (!(fmt.channels >= 1 && fmt.channels <= 32) || !(fmt.rate >= 4000 && fmt.rate <= 384000)) throw new Error("the WAV file's format looks broken");
  let bytes = data.bytes === 0xffffffff || data.bytes === 0 ? Infinity : data.bytes; if (whole) bytes = Math.min(bytes, buf.length - data.start);
  return { format, channels: fmt.channels, rate: fmt.rate, bits: fmt.bits, dataStart: data.start, dataBytes: bytes, tags };
}

/**
 * A whole WAV file as mono samples (channels averaged), at about 22 kHz (whole-number steps down from a higher rate,
 * as the browser does: 44.1 kHz becomes 22,050 Hz, 48 kHz 24 kHz).
 * @param {Buffer} buf @returns {{x:Float32Array, sr:number, dur:number, tags:object}}
 */
export function readWav(buf) {
  const w = wavInfo(buf, true), B = w.bits / 8, C = w.channels, frame = B * C, n = Math.floor(w.dataBytes / frame);
  const dec = w.rate > 32000 ? Math.max(1, Math.floor(w.rate / RATE)) : 1, m = Math.floor(n / dec), x = new Float32Array(m), div = dec * C, k = div;
  // the samples as a typed array (a copy, so it is aligned), then averaged: channels and `dec` steps at a time
  const raw = buf.buffer.slice(buf.byteOffset + w.dataStart, buf.byteOffset + w.dataStart + m * dec * frame);
  let s, scale = 1;
  if (w.format === "float") s = w.bits === 32 ? new Float32Array(raw) : new Float64Array(raw);
  else if (w.bits === 16) { s = new Int16Array(raw); scale = 1 / 32768; }
  else if (w.bits === 32) { s = new Int32Array(raw); scale = 1 / 2147483648; }
  else if (w.bits === 8) { const u = new Uint8Array(raw); s = new Int16Array(u.length); for (let i = 0; i < u.length; i++) s[i] = u[i] - 128; scale = 1 / 128; }
  else { const u = new Uint8Array(raw), N = u.length / 3; s = new Int32Array(N); for (let i = 0, o = 0; i < N; i++, o += 3) s[i] = ((u[o] | u[o + 1] << 8 | u[o + 2] << 16) << 8) >> 8; scale = 1 / 8388608; }
  const g = scale / div;
  for (let i = 0, o = 0; i < m; i++) { let v = 0; for (let j = 0; j < k; j++) v += s[o++]; v *= g; x[i] = v === v && Math.abs(v) < 1e6 ? v : 0; } // (a float file can hold NaN)
  return { x, sr: w.rate / dec, dur: n / w.rate, tags: w.tags };
}

/** A WAV file's header only (the first 64 kB): its length in seconds and its tags, without reading the samples. */
export async function wavHeader(file) {
  const fh = await open(file, "r"); try { const st = await fh.stat(), b = Buffer.alloc(Math.min(st.size, 65536)); await fh.read(b, 0, b.length, 0);
    const w = wavInfo(b, false), bytes = Math.min(w.dataBytes, st.size - w.dataStart); return { dur: bytes / (w.bits / 8 * w.channels) / w.rate, tags: w.tags }; }
  finally { await fh.close(); }
}

/** Writes mono or interleaved samples (-1..1) as a WAV file's bytes: 16 or 24-bit PCM, or 32-bit float. For tests and tools. */
export function encodeWav(x, sr, { bits: b = 16, float = false, channels = 1, tags = null } = {}) {
  const bits = float ? 32 : b, B = bits / 8, n = Math.floor(x.length / channels), dataBytes = n * channels * B;
  let info = null;
  if (tags) { const parts = []; for (const [k, v] of [["INAM", tags.title], ["IART", tags.artist]]) if (v) { const s = Buffer.from(String(v) + "\0", "utf8"), pad = s.length & 1; const h = Buffer.alloc(8); h.write(k, 0, "ascii"); h.writeUInt32LE(s.length, 4); parts.push(h, s, Buffer.alloc(pad)); }
    const body = Buffer.concat([Buffer.from("INFO", "ascii"), ...parts]), h = Buffer.alloc(8); h.write("LIST", 0, "ascii"); h.writeUInt32LE(body.length, 4); info = Buffer.concat([h, body]); }
  const head = Buffer.alloc(44); head.write("RIFF", 0, "ascii"); head.writeUInt32LE(36 + dataBytes + (info ? info.length : 0), 4); head.write("WAVE", 8, "ascii");
  head.write("fmt ", 12, "ascii"); head.writeUInt32LE(16, 16); head.writeUInt16LE(float ? 3 : 1, 20); head.writeUInt16LE(channels, 22); head.writeUInt32LE(sr, 24);
  head.writeUInt32LE(sr * channels * B, 28); head.writeUInt16LE(channels * B, 32); head.writeUInt16LE(bits, 34); head.write("data", 36, "ascii"); head.writeUInt32LE(dataBytes, 40);
  const d = Buffer.alloc(dataBytes), cl = v => Math.max(-1, Math.min(1, v || 0));
  for (let i = 0; i < n * channels; i++) { const v = cl(x[i]);
    if (float) d.writeFloatLE(v, i * 4); else if (bits === 16) d.writeInt16LE(Math.round(v * 32767), i * 2); else if (bits === 24) d.writeIntLE(Math.round(v * 8388607), i * 3, 3); else d.writeInt32LE(Math.round(v * 2147483647), i * 4); }
  return info ? Buffer.concat([head.subarray(0, 36), info, head.subarray(36), d]) : Buffer.concat([head, d]);
}

// ---------------------------------------------------------------- ffmpeg and ffprobe
const lowPriority = child => { try { if (child.pid && process.platform !== "win32") os.setPriority(child.pid, 19); else if (child.pid) os.setPriority(child.pid, os.constants.priority.PRIORITY_LOW); } catch {} };
/** Runs a tool and collects its output: {code, out: Buffer, err: string, missing}. */
function run(cmd, args, { maxBytes = 512 * 1024 * 1024, timeout = 300000 } = {}) {
  return new Promise(resolve => {
    let child; try { child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); } catch (e) { return resolve({ code: -1, out: Buffer.alloc(0), err: e.message, missing: e.code === "ENOENT" }); }
    lowPriority(child);
    const chunks = []; let n = 0, err = "", done = false, big = false;
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, timeout);
    child.stdout.on("data", c => { n += c.length; if (n > maxBytes) { big = true; try { child.kill("SIGKILL"); } catch {} return; } chunks.push(c); });
    child.stderr.on("data", c => { if (err.length < 4000) err += c; });
    const end = (code, missing = false) => { if (done) return; done = true; clearTimeout(timer); resolve({ code: big ? -2 : code, out: Buffer.concat(chunks), err: big ? "too much sound (a very long file?)" : err.trim(), missing }); };
    child.on("error", e => end(-1, e.code === "ENOENT")); child.on("close", c => end(c ?? -1));
  });
}
/** Is this tool installed? (runs `<cmd> -version`) */
export async function toolWorks(cmd) { if (!cmd) return false; const r = await run(cmd, ["-version"], { timeout: 8000, maxBytes: 1 << 20 }); return r.code === 0; }

/**
 * ffmpeg: any audio file to mono samples, at most MAX_SECONDS. ffmpeg only decodes and mixes to mono, at the file's
 * own rate, as a float WAV (its header says the rate); the step down to ~22 kHz is the WAV reader's average, which
 * costs far less than ffmpeg's resampler and is what the browser does too.
 */
export async function ffmpegDecode(file, ffmpeg = "ffmpeg") {
  const r = await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", file, "-map", "0:a:0", "-vn", "-t", String(MAX_SECONDS + 1), "-ac", "1", "-c:a", "pcm_f32le", "-f", "wav", "-"]);
  if (r.missing) throw Object.assign(new Error("ffmpeg isn't installed"), { needs: "ffmpeg" });
  if (r.code !== 0) throw new Error(`ffmpeg couldn't read it: ${(r.err.split("\n").pop() || `exit ${r.code}`).split(file).join("the file").slice(0, 200)}`);
  const w = readWav(r.out); return { x: w.x, sr: w.sr, dur: w.dur };
}

/** ffprobe: {title, artist, dur} of a file (empty strings and 0 when it doesn't say); null when ffprobe can't run. */
export async function probe(file, ffprobe = "ffprobe") {
  if (!ffprobe) return null;
  const r = await run(ffprobe, ["-v", "error", "-show_entries", "format=duration:format_tags:stream_tags", "-of", "json", file], { timeout: 20000, maxBytes: 4 << 20 });
  if (r.code !== 0) return null;
  let j; try { j = JSON.parse(String(r.out)); } catch { return null; }
  const all = [j.format?.tags || {}, ...(j.streams || []).map(s => s.tags || {})], tag = k => { for (const t of all) for (const [kk, v] of Object.entries(t)) if (kk.toLowerCase() === k && String(v).trim()) return String(v).trim(); return ""; };
  return { title: tag("title"), artist: tag("artist") || tag("album_artist"), dur: Number(j.format?.duration) || 0 };
}

// ---------------------------------------------------------------- names
const clean = s => String(s ?? "").replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
/** "Artist - Title" from tags, else the file name without its extension (underscores as spaces). */
export function songName(file, tags = {}) {
  const t = clean(tags.title), a = clean(tags.artist);
  if (t) return (a && !t.toLowerCase().startsWith(a.toLowerCase() + " - ") ? `${a} - ${t}` : t).slice(0, 120);
  return clean(path.basename(file).replace(/\.[^.]+$/, "").replace(/_/g, " ")).slice(0, 120) || "Song";
}

// ---------------------------------------------------------------- one song, start to end
/**
 * Decode and analyse one file: the song memory entry (memoryEntry) without its look and show, which the runtime adds.
 * @param {string} file @param {{ffmpeg?:string|null, ffprobe?:string|null, id?:string}} o ffmpeg/ffprobe: the
 *   programs to use (null: not installed; WAV files are still read)
 * @returns {Promise<{entry:object, name:string, decodeMs:number, analyseMs:number, dur:number}>}
 */
export async function analyseFile(file, o = {}) { return analyseDecoded(await decodeFile(file, o), o); }

const tooLong = () => Object.assign(new Error(`longer than ${MAX_SECONDS / 60} minutes (a mix?)`), { skip: true });
/** The first half of analyseFile: the samples and tags ({x, sr, dur, tags, decodeMs}). ffprobe runs alongside ffmpeg. */
export async function decodeFile(file, o = {}) {
  const ext = path.extname(file).toLowerCase(), t0 = performance.now();
  let tags = null, dec;
  if (WAV_EXT.has(ext)) { // natively first (no ffmpeg needed); ffmpeg only for the WAV formats the reader doesn't know
    try { const h = await wavHeader(file); if (h.dur > MAX_SECONDS) throw tooLong(); dec = readWav(await readFile(file)); tags = dec.tags; }
    catch (e) { if (e.skip || !o.ffmpeg) throw e; dec = await ffmpegDecode(file, o.ffmpeg); }
    if (o.ffprobe && !tags?.title) tags = { ...tags, ...await probeTags(file, o.ffprobe) };
  } else {
    if (!o.ffmpeg) throw Object.assign(new Error("needs ffmpeg"), { needs: "ffmpeg" });
    const [d, t] = await Promise.all([ffmpegDecode(file, o.ffmpeg), o.ffprobe ? probeTags(file, o.ffprobe) : null]); dec = d; tags = t;
  }
  if (dec.dur > MAX_SECONDS) throw tooLong();
  if (dec.dur < 20) throw Object.assign(new Error("shorter than 20 seconds"), { skip: true });
  return { x: dec.x, sr: dec.sr, dur: dec.dur, tags: tags || {}, decodeMs: performance.now() - t0, file };
}
const probeTags = async (file, ffprobe) => { const p = await probe(file, ffprobe); return p ? Object.fromEntries(Object.entries(p).filter(([k, v]) => v && k !== "dur")) : {}; };
/** The second half: the whole-song analysis and its song memory entry ({entry, name, decodeMs, analyseMs, dur}). */
export async function analyseDecoded(dec, o = {}) {
  const t1 = performance.now(), pre = await preAnalyseCore(dec.x, dec.sr), t2 = performance.now();
  const name = songName(dec.file, dec.tags), entry = memoryEntry(name, pre, o.id || "l" + Math.random().toString(36).slice(2, 10));
  return { entry, name, decodeMs: dec.decodeMs, analyseMs: t2 - t1, dur: dec.dur };
}
