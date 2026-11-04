// The one-line answer to "does Tempolight hear my music?", for the Home and Music pages, and when the browser should
// start its microphone by itself. Plain functions of the status message (no page, no imports), so they are tested in
// Node (hearline.test.js).

const FOLLOWING = new Set(["exact", "shared", "analysis"]);

/** The music app's track, from Sync with Spotify or Now playing: {app, title, playing} or null. */
export function trackOf(m) {
  const sp = m?.spotify, t = sp && sp.on !== false ? sp.track : null, np = m?.nowPlaying;
  if (t) return { app: "Spotify", title: t.title, playing: !!t.playing };
  if (np) return { app: np.app || "Music", title: np.title, playing: !!np.playing };
  return null;
}

/**
 * @returns {{ok: boolean|null, text: string, why?: string, fix?: boolean}} ok: true (hearing / following), false (it can't
 *   hear the music: show "Fix"), null (nothing to hear; "Set up" when nothing is set up)
 */
export function hearLine(m) {
  if (!m) return { ok: null, text: "" };
  const h = m.hearing || {}, sp = m.spotify, tr = trackOf(m), lr = sp?.learn;
  const following = (sp && FOLLOWING.has(sp.mode)) || m.source === "nowplaying";
  const live = !!h.via || m.source === "browser" || m.source === "capture";
  const sound = live && h.sound !== false;
  const learned = following ? (sp?.mode === "analysis" ? "Spotify's analysis" : sp?.mode === "shared" ? "learned (shared map)" : "learned")
    : lr?.state === "learning" ? `learning ${lr.pct ?? 0}%` : lr?.state === "analysing" ? "learning…" : lr?.state === "learned" ? "learned"
    : sp?.map && sp.map.cover < 100 ? `learned ${sp.map.cover}%` : null;
  if (m.source === "song" && m.song) return { ok: true, text: `Playing ${m.song.name} ✓` };
  if (tr && tr.playing) {
    if (sound) return { ok: true, text: `Hearing ${tr.app} ✓ · ${tr.title}${learned ? ` · ${learned}` : ""}` };
    if (following) return { ok: true, text: `Following ${tr.app} ✓ · ${tr.title} · ${learned}` };
    return { ok: false, fix: true, text: "Can't hear anything",
      why: h.problem || (live ? `${h.label || "The input"} is silent while ${tr.app} plays.` : `${tr.title} isn't learned yet, and nothing sends Tempolight its sound.`) };
  }
  if (h.problem && (h.capture?.error || h.method === "computer")) return { ok: false, fix: true, text: "Can't hear anything", why: h.problem };
  if (sound) return { ok: true, text: `Hearing ${h.label || "live audio"} ✓` };
  if (h.capture?.running || live) return { ok: null, text: `Listening (${h.capture?.label || h.label || "live audio"}) · waiting for music` };
  if (tr) return { ok: null, text: `${tr.app} is paused` };
  return { ok: null, text: "Not listening", fix: !h.method, why: "Tempolight hears nothing yet." };
}

/** Should the browser start its microphone now? ctx: {method, mode (what the browser plays or hears now), now, lastTry} */
export function wantsAutoMic(m, ctx) {
  if (ctx.method !== "mic" || ctx.mode) return false; // not chosen, or the browser already plays or listens
  if (ctx.now - (ctx.lastTry || 0) < 30000) return false; // (it was refused, or failed: not again straight away)
  const tr = trackOf(m); if (!tr || !tr.playing) return false;
  if ((m.spotify && FOLLOWING.has(m.spotify.mode)) || m.source === "nowplaying") return false; // a learned song: nothing to hear
  if (m.hearing?.via) return false; // something already sends sound (server capture, another browser)
  return true;
}
