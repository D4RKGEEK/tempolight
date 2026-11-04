// Where in the Spotify track we are, to within a few tens of milliseconds, from readings that arrive now and then and
// are a little off each time. No I/O here (spotify.js does the asking), so it is tested with made-up readings.
//
// A reading is {id, pos, playing, at, rtt, ts}: the track, its position in seconds, whether it plays, when it was taken on
// our clock (ms, the middle of the request: the Web API measures progress_ms while it answers), how long the request
// took, and Spotify's `timestamp`. That timestamp is documented as the time the data was fetched, but in practice it is
// the time of the last change of playback state (track start, seek, pause, resume): github.com/spotify/web-api/issues/1073.
// So `progress_ms + (now - timestamp)` is wrong while a track plays on; it is used here only as a sign that something
// changed (a new timestamp means a seek or a resume happened on Spotify's side, even when the jump is small).
//
// Between readings the position runs on with our clock. A reading that disagrees by more than the jitter we expect is a
// seek; a smaller difference is noise and nudges the estimate (less for slow, uncertain answers). The estimate the
// lights see never jumps for noise: it glides (at most 5% faster or slower than real time) to the corrected line, so a
// correction can't make a beat flash twice or be skipped; only a real seek, skip or resume jumps.

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/**
 * @param {{seekSec?:number, glide?:number}} [o] seekSec: a difference bigger than this (plus half the request time) is a seek;
 *   glide: the most the shown position may run faster or slower than real time while it catches up (0.05 = 5%)
 */
export function createTrackClock(o = {}) {
  const seekSec = o.seekSec ?? 0.6, glide = o.glide ?? 0.05;
  let line = null;           // the best estimate: {id, pos, at, playing, dur}, pos at time `at` (ms)
  let shown = null;          // what the lights see: {pos, at}, gliding towards `line`
  let lastTs = null, n = 0, jitter = 0.08, lastEvent = null;
  const lineAt = at => !line ? null : line.playing ? line.pos + (at - line.at) / 1000 : line.pos;
  const clampDur = p => line && line.dur > 0 ? clamp(p, 0, line.dur) : Math.max(0, p);
  function event(kind, at) { lastEvent = { kind, at }; shown = null; return kind; }

  return {
    /** A reading; returns what happened: "track", "seek", "pause", "resume" or null (just noise). */
    sample(r) {
      const { id, pos, playing, at } = r, rtt = Math.max(1, r.rtt ?? 100), ts = r.ts ?? null, dur = r.dur ?? line?.dur ?? 0;
      const tsChanged = ts != null && lastTs != null && ts !== lastTs; lastTs = ts;
      if (!line || id !== line.id) { line = { id, pos, at, playing, dur }; n = 1; return event("track", at); }
      line.dur = dur || line.dur; n++;
      if (playing !== line.playing) { line = { id, pos, at, playing, dur: line.dur }; return event(playing ? "resume" : "pause", at); }
      if (!playing) { if (Math.abs(pos - line.pos) > 0.25) { line.pos = pos; line.at = at; return event("seek", at); } line.at = at; return null; }
      const err = pos - lineAt(at), tol = Math.max(seekSec, 3 * jitter) + rtt / 2000;
      if (Math.abs(err) > tol || (tsChanged && Math.abs(err) > 0.15)) { line = { id, pos, at, playing, dur: line.dur }; return event("seek", at); }
      // noise: move part of the way; a slow answer (big rtt) says less about when the position was measured
      const w = (n <= 3 ? 0.5 : 0.25) * clamp(150 / rtt, 0.15, 1);
      line = { id, pos: lineAt(at) + err * w, at, playing, dur: line.dur };
      jitter += (Math.abs(err) - jitter) * 0.2;
      return null;
    },
    /** The best estimate of the position at `at` (ms), or null. */
    estimate(at) { const p = lineAt(at); return p == null ? null : clampDur(p); },
    /**
     * The position to show the lights at `at`: like estimate(), but small corrections glide instead of jumping.
     * Call it often (every frame); it keeps its own state.
     */
    shown(at) {
      const target = lineAt(at); if (target == null) return null;
      if (!line.playing) { shown = { pos: target, at }; return clampDur(target); }
      if (!shown || at < shown.at) { shown = { pos: target, at }; return clampDur(target); }
      const dt = (at - shown.at) / 1000, pred = shown.pos + dt, err = target - pred;
      shown = { pos: Math.abs(err) > 0.25 ? target : pred + clamp(err, -glide * dt, glide * dt), at };
      return clampDur(shown.pos);
    },
    /** Shift the estimate by `sec` (a correction found another way, such as live kicks against the beat map). */
    nudge(sec) { if (line) line.pos += sec; },
    get id() { return line ? line.id : null; }, get playing() { return !!line && line.playing; }, get dur() { return line ? line.dur : 0; },
    get samples() { return n; }, get jitterMs() { return Math.round(jitter * 1000); }, get lastEvent() { return lastEvent; },
    reset() { line = null; shown = null; lastTs = null; n = 0; lastEvent = null; },
  };
}

/**
 * How long to wait before asking Spotify again (ms): about once a second near anything that changes (just after a
 * skip, seek or resume, the first readings of a track, its last seconds), about every 3 s while it plays on steadily,
 * and less often when this computer's own Spotify app already gives the exact position (then the Web API only adds the
 * track ID, cover and volume). Nothing playing: every 3 s; paused: every 2 s, so pressing play shows up quickly.
 * @param {{playing:boolean, pos:number|null, dur:number, samples:number, sinceEventMs:number, local:boolean, nothing:boolean}} s
 */
export function pollDelay(s) {
  if (s.nothing) return 3000;
  if (s.local) return 5000;
  if (s.sinceEventMs < 5000 || s.samples < 3) return 1000;
  if (s.playing && s.dur > 0 && s.pos != null && s.dur - s.pos < 6) return 1000;
  return s.playing ? 3000 : 2000; // paused: a resume shows up within 2 s
}
