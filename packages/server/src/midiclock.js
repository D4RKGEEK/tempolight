// Following MIDI clock: 24 clock messages (0xF8) per beat, with Start (0xFA), Continue (0xFB), Stop (0xFC) and Song
// Position Pointer (0xF2, in 16th notes) from DJ software or a drum machine. The browser reads them with Web MIDI and
// sends them over the WebSocket with its own timestamps; this turns them into a beat grid. No Node.js modules here.
//
// Tempo: a straight line fitted through the last two beats of clocks (time against clock number), so one late
// clock barely moves it. When clocks keep landing far from the line (the tempo changed), the fit starts again from
// the latest few. Phase: the line says when clock 0, 24, 48... of the song fell, and those are the beats.
// Bar: clock 0 after Start is the first beat of a bar; Song Position Pointer moves it (a 16th is 6 clocks). Clocks
// that arrive without a Start still give tempo and beats; which beat starts the bar is then a guess.

export const TICK = 0xf8, START = 0xfa, CONTINUE = 0xfb, STOP = 0xfc, SPP = 0xf2;
const PPQN = 24, WINDOW = 48, MIN_TICKS = 12, GAP_MS = 500;

export function createMidiClock() {
  let ticks = [], pos = 0, stopped = false, barKnown = false, last = -1e9, fit = null, miss = 0, started = false;
  function refit() {
    const n = ticks.length; if (n < 2) { fit = null; return; }
    let sx = 0, sy = 0, sxx = 0, sxy = 0; const x0 = ticks[0][0];
    for (const [x, y] of ticks) { const X = x - x0; sx += X; sy += y; sxx += X * X; sxy += X * y; }
    const d = n * sxx - sx * sx; if (!d) { fit = null; return; }
    const b = (n * sxy - sx * sy) / d, a = (sy - b * sx) / n - b * x0; // ms = a + b * clock
    fit = b > 0.5 && b < 200 ? { a, b } : null; // 12.5 to 5,000 BPM: anything else is nonsense
  }
  /** One MIDI message: code (TICK, START, ...), at (ms, the same clock as performance.now()), value (SPP: 16ths). */
  function event(code, at, value = 0) {
    switch (code) {
      case START: pos = 0; ticks = []; fit = null; stopped = false; barKnown = true; started = true; break;
      case CONTINUE: ticks = []; stopped = false; started = true; break; // the position is where Stop left it (or where SPP put it)
      case STOP: stopped = true; break;
      case SPP: pos = Math.max(0, Math.round(value)) * 6; ticks = []; barKnown = true; break;
      case TICK: {
        if (stopped) return; // a drum machine keeps sending clock while stopped: no beat until Start or Continue
        if (at - last > GAP_MS) { ticks = []; fit = null; }
        if (fit && ticks.length >= MIN_TICKS) { const err = at - (fit.a + fit.b * pos); if (Math.abs(err) > fit.b * 0.5) miss++; else miss = 0;
          if (miss >= 3) { ticks = ticks.slice(-3); miss = 0; } } // three clocks in a row off the line: the tempo changed
        ticks.push([pos, at]); if (ticks.length > WINDOW) ticks.shift(); pos++; last = at; refit(); break;
      }
      default: break;
    }
  }
  const fresh = now => !stopped && !!fit && ticks.length >= MIN_TICKS && now - last < GAP_MS;
  return {
    event, fresh,
    /** Beat grid for gridAt()/metronomeView(): beat number n falls at clock n*24; `t` is the music clock at wall time `now` (ms). */
    grid(now, t) { if (!fresh(now)) return null; const P = fit.b * PPQN / 1000, beats = (now - fit.a) / fit.b / PPQN; return { P, off: t - beats * P, barOff: 0, bpm: 60 / P }; },
    get bpm() { return fit ? 60000 / (fit.b * PPQN) : 0; },
    status(now) { return { running: fresh(now), stopped, started, barKnown, bpm: fit ? Math.round(60000 / (fit.b * PPQN) * 10) / 10 : null, beat: fit ? Math.floor((pos - 1) / PPQN) : null }; },
    reset() { ticks = []; pos = 0; stopped = false; barKnown = false; last = -1e9; fit = null; started = false; },
  };
}
