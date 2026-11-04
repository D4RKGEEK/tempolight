// Shared beat maps (opt-in, off by default): fetch the confirmed map of a Spotify track from a Tempolight beat-map
// service (the Cloudflare Worker in worker/beatmaps, which you deploy yourself: docs/spotify.md), and, if you allow it,
// send the maps this Tempolight learned by listening. Maps carry no names: only the track ID, the beat grid, drum hits,
// song parts and a loudness curve. Maps made from Spotify's own audio analysis are never sent (that data is Spotify's).
// No Node modules: `fetch` is passed in.
import { memoryAnalysis } from "../../engine/src/index.js";

export const MAX_BYTES = 32 * 1024;
const r3 = v => Math.round(v * 1000) / 1000;
const SHORT = { calm: "c", build: "b", drop: "d", silent: "s" }, LONG = { c: "calm", b: "build", d: "drop", s: "silent" };
const okId = id => typeof id === "string" && /^[0-9A-Za-z]{22}$/.test(id);

/** A song-memory entry as a shared map (format 1, see worker/beatmaps/src/map.js), at most 32 KB; null if it can't be. */
export function toShared(e) {
  if (!e || !(e.dur >= 20) || !(e.bpm >= 50 && e.bpm <= 220) || typeof e.env !== "string") return null;
  const P = 60 / e.bpm, k = Math.floor(e.off / P), off = e.off - k * P, barOff = ((((e.barOff | 0) + k) % 4) + 4) % 4;
  const inT = a => (a || []).filter(t => t >= 0 && t <= e.dur + 0.5).map(r3);
  const m = { v: 1, dur: r3(e.dur), bpm: Math.round(e.bpm * 1e4) / 1e4, P: Math.round(P * 1e6) / 1e6, off: Math.round(off * 1e6) / 1e6, barOff, style: e.style,
    kicks: inT(e.kicks), snares: inT(e.snares), hats: inT(e.hats), drops: inT(e.drops),
    bars: (e.bars || []).filter(b => b.t1 > b.t0 && b.t0 >= 0).map(b => [r3(b.t0), r3(b.t1), SHORT[b.state] || "c", Math.max(0, Math.min(1, Math.round((b.level || 0) * 100) / 100))]),
    env: e.env, cov: (e.cov || [[0, e.dur]]).map(c => [r3(Math.max(0, c[0])), r3(Math.min(e.dur, c[1]))]).filter(c => c[1] > c[0]),
    key: e.key || null, mode: e.mode || null, keyConfidence: e.keyConfidence || 0, mood: e.mood || null };
  if (m.off >= m.P) m.off = 0;
  // too big (a very long track): fewer hi-hats first, then none, then fewer snares
  const size = () => JSON.stringify({ map: m }).length;
  if (size() > MAX_BYTES - 200) m.hats = m.hats.filter((_, i) => i % 2 === 0);
  if (size() > MAX_BYTES - 200) m.hats = [];
  if (size() > MAX_BYTES - 200) m.snares = m.snares.filter((_, i) => i % 2 === 0);
  return size() <= MAX_BYTES - 200 && m.cov.length ? m : null;
}

/** A shared map back to an analysis Tempolight can follow ({pre, cov}); null if it doesn't look right. */
export function fromShared(m) {
  if (!m || m.v !== 1 || !(m.dur >= 20) || !(m.bpm >= 50) || !(m.P > 0) || typeof m.env !== "string" || !Array.isArray(m.bars) || !Array.isArray(m.cov)) return null;
  const nums = a => Array.isArray(a) && a.every(t => typeof t === "number" && Number.isFinite(t)) ? a : null;
  const kicks = nums(m.kicks || []), snares = nums(m.snares || []), hats = nums(m.hats || []), drops = nums(m.drops || []); if (!kicks || !snares || !hats || !drops) return null;
  const e = { bpm: m.bpm, P: m.P, off: m.off, barOff: m.barOff | 0, style: m.style || "poprock", dur: m.dur, drops, kicks, snares, hats, env: m.env,
    bars: m.bars.map(b => ({ t0: b[0], t1: b[1], state: LONG[b[2]] || "calm", level: b[3] || 0 })), key: m.key || null, mode: m.mode || null, keyConfidence: m.keyConfidence || 0, mood: m.mood || null };
  let pre; try { pre = memoryAnalysis(e); } catch { return null; }
  return { pre, cov: m.cov.map(c => [c[0], c[1]]) };
}

/**
 * @param {{fetch:Function, url:()=>string, installId:()=>string, now?:()=>number}} o url: the service ("" when not set up)
 */
export function createBeatmapCloud(o) {
  const now = o.now || Date.now, misses = new Map(); let last = null; // last: what happened most recently, for the UI
  const base = () => String(o.url() || "").trim().replace(/\/+$/, "");
  return {
    get last() { return last; },
    /** The confirmed map for a track: {map, installs} or null (none yet, not set up, or no answer). Misses are remembered for 6 hours. */
    async get(id) {
      const b = base(); if (!b || !okId(id)) return null;
      if (now() - (misses.get(id) ?? -1e15) < 6 * 3600_000) return null;
      try { const r = await o.fetch(`${b}/v1/maps/${id}`, { headers: { accept: "application/json" } });
        if (r.status === 404) { misses.set(id, now()); last = { at: now(), what: "none", id }; return null; }
        if (!r.ok) { last = { at: now(), what: "error", id, error: `the beat-map service said ${r.status}` }; return null; }
        const j = await r.json(); last = { at: now(), what: "got", id, installs: j.installs }; return j && j.map ? { map: j.map, installs: j.installs || 2 } : null;
      } catch (e) { last = { at: now(), what: "error", id, error: e.message }; return null; }
    },
    /** Send a learned map. Resolves {ok, confirmed, installs} or {ok: false, error}. */
    async put(id, entry) {
      const b = base(); if (!b || !okId(id)) return { ok: false, error: "not set up" };
      const map = toShared(entry); if (!map) return { ok: false, error: "this map can't be shared" };
      try { const r = await o.fetch(`${b}/v1/maps/${id}`, { method: "POST", headers: { "content-type": "application/json", "x-install-id": o.installId() }, body: JSON.stringify({ map }) });
        const j = await r.json().catch(() => ({})); const res = r.ok ? { ok: true, confirmed: !!j.confirmed, installs: j.installs || 1 } : { ok: false, error: j.error || `the beat-map service said ${r.status}` };
        last = { at: now(), what: r.ok ? "sent" : "error", id, ...res }; misses.delete(id); return res;
      } catch (e) { last = { at: now(), what: "error", id, error: e.message }; return { ok: false, error: e.message }; }
    },
  };
}
