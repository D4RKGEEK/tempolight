// The Music page's "how locked am I" meter and song map, from signals the runtime already has. No Node.js modules
// here (the online demo runs it in the browser).
//
// syncScore(): a score 0-100, a state (locked / finding / none) and one plain hint, from where the beat comes from (a
//   song played here, song memory, DJ Link / MIDI clock / Ableton Link, or the live analyser's confidence) and how
//   loud the sound is. Smoothed over about a second, with a gap between "locked" and "finding" so it doesn't flicker.
// songMap(): a song's map for drawing: loudness (a few hundred values), sections (A, B, A, C...: repeats share a
//   label) coloured by part, drops, bars and the phrase grid.
// createLiveMap(): the map of a song Tempolight doesn't know, made as it is heard (loudness and part 4 times a second).

export const HINTS = {
  quiet: "Too quiet — turn it up or move the mic closer",
  drumless: "No drums — following the melody",
  finding: "Finding the beat…",
  memory: "Following the song's beat map",
  song: "Following the song's beat map",
  metronome: "Metronome — no music playing",
};
const EXT = { djlink: "DJ Link", midiclock: "MIDI clock", link: "Ableton Link" };
export const extHint = kind => `Beat from ${EXT[kind] || kind}`;

/**
 * What the sync score is made from right now (no smoothing): {raw 0-100, source, hint, hearing: is there sound at all}.
 * @param {object} s {source: rt.source, ext: external grid kind while listening live (djlink|midiclock|link) or null,
 *   live: {conf, drumless, misses} or null, lock: song memory follows a song, level: hearing level 0-1, sound: heard
 *   anything in the last 3 s, listening: something sends sound}
 */
export function syncRaw(s) {
  const src = s.source;
  if (src === "song") return { raw: 100, source: "song", hint: HINTS.song, hearing: true };
  if (src === "nowplaying") return { raw: 100, source: "memory", hint: HINTS.memory, hearing: true };
  if (EXT[src]) return { raw: 95, source: src, hint: extHint(src), hearing: true }; // decks or a clock, no audio
  const quiet = s.listening && (!s.sound || (s.level ?? 0) < 0.12);
  if (s.live && src !== "idle") {
    if (s.lock) return { raw: Math.max(60, 96 - 12 * (s.live.misses || 0)), source: "memory", hint: HINTS.memory, hearing: true };
    if (s.ext) return { raw: 95, source: s.ext, hint: extHint(s.ext), hearing: true };
    let raw = Math.round(Math.max(0, Math.min(1, s.live.conf || 0)) * 100);
    if (s.live.drumless) raw = Math.min(raw, 45); // no steady drums: the tempo is a guess (never called locked)
    if (quiet) raw = Math.min(raw, 30);
    return { raw, source: "live", hint: quiet ? HINTS.quiet : s.live.drumless ? HINTS.drumless : raw < 60 ? HINTS.finding : null, hearing: !!s.sound };
  }
  if (s.listening) return { raw: 0, source: "live", hint: HINTS.quiet, hearing: false }; // listening, but nothing to hear
  if (src === "metronome") return { raw: 0, source: "metronome", hint: HINTS.metronome, hearing: false };
  return { raw: 0, source: null, hint: null, hearing: false };
}

/** The smoothed score and state: keep `mem` ({}) between calls. Returns {score, state, hint, source}. */
export function syncScore(s, mem, now) {
  const r = syncRaw(s), dt = mem.at == null ? Infinity : Math.max(0, now - mem.at) / 1000;
  // a new source (a song starts, memory recognises one) jumps straight there; otherwise eased over ~1 s
  const fresh = mem.source !== r.source || !Number.isFinite(dt), v = fresh ? r.raw : mem.v + (r.raw - mem.v) * (1 - Math.exp(-dt / 1));
  if (fresh) mem.state = null; // (the gap between locked and finding is for one source, not carried over)
  mem.v = v; mem.at = now; mem.source = r.source;
  const score = Math.round(v);
  let state;
  if (!r.source || r.source === "metronome" || !r.hearing) state = "none";
  else state = score >= 65 || (mem.state === "locked" && score >= 50) ? "locked" : "finding";
  mem.state = state;
  return { score, state, hint: r.hint, source: r.source };
}

// ---------------------------------------------------------------- the song map
const ENV_STEP = 0.02; // the analysis loudness: 50 values a second
const letters = n => n < 26 ? String.fromCharCode(65 + n) : "Z" + (n - 25);
const r2 = v => Math.round(v * 100) / 100;
const r3 = v => Math.round(v * 1000) / 1000;
/** Loudness down to at most n values (the loudest of each stretch), 0-1 against the loud parts (and eased up a bit). */
export function downsample(env, n, step = ENV_STEP) {
  const len = env ? env.length : 0; if (!len) return { env: [], step };
  const k = Math.max(1, Math.ceil(len / n)), out = [];
  for (let i = 0; i < len; i += k) { let m = 0; for (let j = i; j < Math.min(len, i + k); j++) if (env[j] > m) m = env[j]; out.push(m); }
  const top = out.slice().sort((a, b) => a - b)[Math.floor(out.length * 0.97)] || 1e-9;
  return { env: out.map(v => r2(Math.sqrt(Math.min(1, v / top)))), step: r3(k * step) };
}
/** Sections from bar parts, for analyses without any: runs of the same part, labelled by part. */
function sectionsFromBars(bars) {
  const out = [], lab = {};
  for (let i = 0; i < bars.length; i++) {
    const st = bars[i].state || "calm", last = out[out.length - 1];
    if (last && last.state === st) { last.t1 = bars[i].t1; last.bar1 = i + 1; continue; }
    out.push({ t0: bars[i].t0, t1: bars[i].t1, bar0: i, bar1: i + 1, label: lab[st] ||= letters(Object.keys(lab).length), state: st });
  }
  return out;
}
/**
 * A song's map from its analysis (a song played here, a remembered one, or the one song memory follows).
 * @returns {{dur:number, env:number[], envStep:number, sections:object[], drops:number[], bars:{t0:number,state:string,energy:number}[], phrase:object|null}}
 */
export function songMap(pre, n = 480) {
  const bars = pre.bars || [], d = downsample(pre.env, n);
  const sections = (pre.sections && pre.sections.length ? pre.sections : sectionsFromBars(bars))
    .map(s => ({ t0: r3(s.t0), t1: r3(s.t1), bar0: s.bar0, bar1: s.bar1, label: s.label, state: s.state || "calm" }));
  return { dur: r3(pre.dur || 0), env: d.env, envStep: d.step, sections, drops: (pre.drops || []).map(r3),
    bars: bars.map(b => ({ t0: r3(b.t0), state: b.state || "calm", energy: r2(typeof b.energy === "number" ? b.energy : b.level ?? 0) })), phrase: pre.phrase || null };
}

/**
 * The map of a song heard live that Tempolight doesn't know: loudness and part 4 times a second, from the analyser's
 * clock. Starts again with a new analyser, or after 6 s of quiet (a new song). At most 20 minutes.
 */
export function createLiveMap() {
  let an = null, t0 = 0, quietSince = null; const env = [], parts = [];
  const reset = (a, t) => { an = a; t0 = t; env.length = 0; parts.length = 0; quietSince = null; };
  return {
    /** Each frame while listening live: the analyser, its clock now, the loudness and the part. */
    tick(a, t, loud, state) {
      if (a !== an) reset(a, t);
      const quiet = state === "silent" || state == null;
      if (quiet) { quietSince ??= t; if (t - quietSince > 6 && env.length) { reset(a, t); return; } } else quietSince = null;
      if (!env.length && quiet) { t0 = t; return; } // (a map starts with the music)
      // one value per quarter second of the analyser's clock (a stretch the frames skipped gets this one)
      const slot = Math.floor((t - t0) / 0.25); if (slot < env.length) return;
      if (slot - env.length > 4800) { reset(a, t); return; }
      while (env.length <= slot) { env.push(loud); parts.push(quiet ? "silent" : state); }
      while (env.length > 4800) { env.splice(0, 400); parts.splice(0, 400); t0 += 100; }
    },
    get length() { return env.length; },
    /** The map so far (same shape as songMap, plus pos: where the song is now, from the start of the map). */
    map(tNow) {
      const step = 0.25, dur = env.length * step, d = downsample(env, 480, step), sections = [], lab = {};
      let i = 0;
      while (i < parts.length) { let j = i; while (j < parts.length && parts[j] === parts[i]) j++;
        const st = parts[i] === "silent" ? "calm" : parts[i], prev = sections[sections.length - 1];
        if (prev && (prev.state === st || (j - i) * step < 2)) prev.t1 = j * step; // short ones join the one before
        else sections.push({ t0: i * step, t1: j * step, label: null, state: st });
        i = j; }
      for (let k = 1; k < sections.length; k++) if (sections[k].state === sections[k - 1].state) { sections[k - 1].t1 = sections[k].t1; sections.splice(k--, 1); }
      for (const s of sections) { s.label = lab[s.state] ||= letters(Object.keys(lab).length); s.t0 = r3(s.t0); s.t1 = r3(s.t1); }
      const drops = sections.filter((s, k) => s.state === "drop" && k > 0).map(s => s.t0);
      return { dur: r3(dur), env: d.env, envStep: d.step, sections, drops, bars: [], phrase: null, pos: r3(Math.max(0, Math.min(dur, (tNow ?? t0 + dur) - t0))) };
    },
  };
}
