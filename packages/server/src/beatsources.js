// Beat grids from outside: MIDI clock (from a browser's Web MIDI input) and Ableton Link (ableton-link.js on the
// server). The runtime asks grid(now, t) every frame, after Pro DJ Link: the first one running gives the beat grid,
// MIDI clock before Ableton Link. No Node.js modules here.
import { createMidiClock } from "./midiclock.js";

const LINK_STALE_MS = 6000; // a Link peer's announcements live 5 s

export function createBeatSources() {
  let link = null; // the latest state from the Link follower (see ableton-link.js startLink's onState)
  const midi = { clock: createMidiClock(), owner: null, label: "", at: -1e9, offs: [] };

  /** Link session's beat at wall time `now` (ms on performance.now()'s clock). */
  const linkBeats = (L, now) => L.beatOrigin / 1e6 + (now * 1000 + L.offset - L.timeOrigin) / L.microsPerBeat;
  const linkFresh = now => !!link && link.measured && link.peers > 0 && link.microsPerBeat > 0 && now - link.at < LINK_STALE_MS;

  return {
    setLink(st) { link = st ? { ...st } : null; },
    get link() { return link; },
    /**
     * MIDI clock messages from a browser: m = {events: [[code, at, value?], ...], now, label}, `at` and `now` on that
     * browser's performance.now() clock. recvNow: this side's performance.now() when it arrived. The browser's clock
     * is mapped onto ours with the smallest (arrival - sent) seen over the last 10 s, so network jitter doesn't move beats.
     * One browser at a time: another one's clock is ignored while the first is running.
     */
    midiMessage(m, clientId, recvNow) {
      if (!m || !Array.isArray(m.events) || !Number.isFinite(Number(m.now))) return false;
      if (midi.owner !== clientId) { if (midi.owner != null && recvNow - midi.at < 2000) return false; midi.owner = clientId; midi.offs = []; midi.clock.reset(); }
      midi.at = recvNow; midi.label = String(m.label || "MIDI clock").slice(0, 60);
      midi.offs.push([recvNow, recvNow - Number(m.now)]); while (midi.offs.length && recvNow - midi.offs[0][0] > 10000) midi.offs.shift();
      const off = Math.min(...midi.offs.map(o => o[1]));
      for (const e of m.events.slice(0, 400)) { if (!Array.isArray(e)) continue; const at = Number(e[1]) + off; if (Number.isFinite(at)) midi.clock.event(Number(e[0]), at, Number(e[2]) || 0); }
      return true;
    },
    midiStop(clientId) { if (midi.owner === clientId) { midi.owner = null; midi.clock.reset(); } },
    midi,
    /** {P, off, barOff, bpm, kind, label} for gridAt()/metronomeView(), or null when neither is running. */
    grid(now, t) {
      const g = midi.clock.grid(now, t); if (g) return { ...g, kind: "midiclock", label: `MIDI clock (${midi.label})` };
      if (linkFresh(now)) { const P = link.microsPerBeat / 1e6, b = linkBeats(link, now); return { P, off: t - b * P, barOff: 0, bpm: 60 / P, kind: "link", label: `Ableton Link (${link.peers} peer${link.peers === 1 ? "" : "s"})` }; }
      return null;
    },
    status(now) {
      return { midiClock: midi.owner != null ? { ...midi.clock.status(now), input: midi.label } : null,
        link: link ? { peers: link.peers, bpm: link.microsPerBeat ? Math.round(60e6 / link.microsPerBeat * 10) / 10 : null, measured: !!link.measured, playing: link.playing ?? null,
          following: linkFresh(now), beat: linkFresh(now) ? Math.round(linkBeats(link, now) * 100) / 100 : null, error: link.error || null } : null };
    },
  };
}
