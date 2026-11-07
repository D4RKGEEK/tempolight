// Lookahead mode: Tempolight plays the music itself a few seconds late (the server's passthrough), while the live
// analyser hears it at once. So when the lights draw the moment the room hears (t), the analyser has already heard
// up to t + a few seconds. This keeps what the analyser said, moment by moment, and answers "what is the music at t,
// and what comes next", exactly instead of guessed:
//
//   - the part (calm, build, drop, silent) as the analyser had it at t, and the part changes after t, already heard;
//   - a drop the analyser heard after t is a certain countdown (dropSource "lookahead", dropConf 1), from as far ahead
//     as the delay. Its time is the kick that started it (the analyser notices a drop a little after it begins, by
//     its vote; looking back from later it can point at the very kick), so the flash lands on that kick, and the
//     part switches to "drop" right there too, not a moment after;
//   - a build-up's progress runs exactly to that drop (buildP 1 at the drop);
//   - the kicks, snares and hats up to t are the ones heard, not predicted.
//
// Pure JavaScript (the runtime and the tests use it). The analyser must be fed the undelayed audio; the caller says
// which analyser time is heard now (the passthrough knows which sample the speakers play).
import { gridAt } from "./signals.js";

const STEP = 0.01;      // a snapshot at most every 10 ms of audio
const KICK_BACK = 0.4;  // a drop's kick: at most this long before the analyser said "drop"

export class LookaheadTimeline {
  /** @param {{keep?:number}} [o] keep: seconds of snapshots to keep (more than the delay) */
  constructor({ keep = 10 } = {}) { this.keep = keep; this.reset(); }
  reset() { this.snaps = []; this.an = null; this.refined = new Map(); }

  /** After each push into the analyser: what it says now (at its newest sample). */
  record(an) {
    if (an !== this.an) { this.reset(); this.an = an; }
    const now = an.now, S = this.snaps, last = S[S.length - 1];
    if (last && now - last.t < STEP && last.V.state === an.state && last.V.dropT === an.dropT) return;
    const V = an.view(now), ex = an.extras();
    S.push({ t: now, V, buildStart: an.buildStart, stateT: an.stateT, extra: { bands: Float32Array.from(ex.bands), wave: Float32Array.from(ex.wave), bassL: ex.bassL } });
    while (S.length > 2 && now - S[0].t > this.keep) S.shift();
  }
  /** Seconds the analyser has heard beyond t. */
  ahead(t) { const S = this.snaps; return S.length ? Math.max(0, S[S.length - 1].t - t) : 0; }

  // the last snapshot at or before t (binary search), or -1
  at(t) { const S = this.snaps; let lo = 0, hi = S.length - 1, k = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (S[m].t <= t) { k = m; lo = m + 1; } else hi = m - 1; } return k; }

  // the time a drop really started: the kick it began with (the strongest-looking one: the first kick on the beat
  // grid's bar line in the KICK_BACK before the analyser said so; else the first kick in that window)
  dropTime(dropT) {
    if (!(dropT > -9)) return dropT; const c = this.refined.get(dropT); if (c != null) return c;
    const an = this.an, ks = an ? an.kicks : []; let first = null, bar1 = null; const B = an?.beat;
    for (const k of ks) { if (k < dropT - KICK_BACK || k > dropT + 0.02) continue; if (first == null) first = k;
      if (bar1 == null && B && B.has) { const x = (k - B.off) / B.P, n = Math.round(x); if (Math.abs(x - n) * B.P < 0.07 && ((((n - B.barOff) % 4) + 4) % 4) === 0) bar1 = k; } }
    const r = bar1 ?? first ?? dropT; this.refined.set(dropT, r); if (this.refined.size > 64) this.refined.delete(this.refined.keys().next().value);
    return r;
  }

  /**
   * The music at t (the analyser's clock: the moment the room hears now, or a little after for slow lights), in the
   * shape of LiveAnalyser.view(), plus: aheadS (how far past t the analyser has heard), upcoming ([{at, state}]: the
   * part changes heard after t). null when nothing was recorded yet.
   * @param {number} t @param {{predict?:boolean}} [o]
   */
  view(t, o = {}) {
    const S = this.snaps, an = this.an; if (!an || !S.length) return null;
    const k = Math.max(0, this.at(t)), s = S[k], V = { ...s.V }, newest = S[S.length - 1].t;
    // the drums up to t: the ones heard
    const kicks = an.kicks; let ki = kicks.length - 1, after = 0; while (ki >= 0 && kicks[ki] > t) { ki--; after++; }
    V.kick = ki >= 0 ? kicks[ki] : -9; V.pulses = []; for (let i = ki; i >= 0 && t - kicks[i] < 1; i--) V.pulses.push(kicks[i]); V.pulseN = Math.max(0, an.pulseN - after);
    const last = (arr, w) => { const out = []; for (let i = arr.length - 1; i >= 0; i--) { if (arr[i] > t) continue; if (t - arr[i] >= w) break; out.push(arr[i]); } return out; };
    const sn = last(an.snares, 0.7); V.snares = sn; V.snare = sn.length ? sn[0] : (an.snares.filter(x => x <= t).at(-1) ?? -9);
    V.hat = an.hats.filter(x => x <= t).at(-1) ?? -9;
    // the beat grid as the analyser knows it now (it only gets surer), at t
    const B = an.beat; V.g = B && B.has ? gridAt({ P: B.P, off: B.off, barOff: B.barOff }, t) : s.V.g;
    if (o.predict && V.g.has && t - V.kick < 2 && V.conf > 0.3) { V.kick = V.g.beatT; V.pulses = [V.g.beatT, V.g.beatT - V.g.P]; V.pulseN = V.g.idx; }
    V.quietFor = V.state === "silent" ? t - s.stateT : 0;
    V.buildP = V.state === "build" ? Math.min(1, Math.max(0, (t - s.buildStart) / 7)) : 0;
    // what comes after t: the part changes, and the first drop
    const upcoming = []; let drop = null, prev = s.V.state;
    for (let i = k + 1; i < S.length; i++) { const x = S[i].V; if (x.state !== prev) { upcoming.push({ at: S[i].t, state: x.state }); prev = x.state; }
      if (drop == null && x.state === "drop" && x.dropT > -9 && x.dropT !== s.V.dropT) drop = this.dropTime(x.dropT); }
    V.dropT = this.dropTime(s.V.dropT);
    if (drop != null && drop <= t) { V.state = "drop"; V.dropT = drop; V.level = "peak"; V.buildP = 0; V.quietFor = 0; drop = null; } // it has begun: its kick was heard
    if (drop != null) {
      V.nextDrop = drop; V.dropConf = 1; V.dropSource = "lookahead";
      if (V.state === "build") V.buildP = Math.min(1, Math.max(0, (t - s.buildStart) / Math.max(0.5, drop - s.buildStart)));
    } else { // nothing heard yet: the analyser's own guess beyond what it has heard, if any
      const nd = an.nextDrop(newest); if (nd != null && nd > newest) { V.nextDrop = nd; V.dropConf = an.drops.conf; V.dropSource = "predicted"; } else { V.nextDrop = null; V.dropConf = 0; V.dropSource = null; }
    }
    if (upcoming.length && upcoming[0].state === "drop" && V.state === "drop") upcoming.shift(); // (the drop that just began)
    V.upcoming = upcoming; V.aheadS = Math.max(0, newest - t); V.lookahead = true;
    return V;
  }
  /** The spectrum and waveform as they were at t (for the effects that draw them). */
  extras(t) { const S = this.snaps; if (!S.length) return {}; return S[Math.max(0, this.at(t))].extra; }
}
