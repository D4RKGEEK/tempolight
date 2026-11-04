// A pretend Spotify Web API on 127.0.0.1 for tests: playback that moves on with a test clock, with jitter in
// progress_ms, seeks, pauses, skips and volume; `timestamp` behaving as it really does (the time of the last state
// change, not of the answer: github.com/spotify/web-api/issues/1073); audio analysis answering 403 (apps made after
// 27 Nov 2024), a fixture, or 404; and 429 with Retry-After on demand. fetchVia() sends api.spotify.com and
// accounts.spotify.com there.
import http from "node:http";

export async function startFakeSpotify({ clock, jitterMs = 0, seed = 5, analysis = "403", fixtures = {} } = {}) {
  let s = seed >>> 0; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  const st = { track: null, playing: false, pos0: 0, at0: 0, changedAt: 0, volume: 70, device: "Kitchen speaker" };
  const counts = {}, limits = { n: 0, retryAfter: 0 }; let mode = analysis;
  const posNow = () => !st.track ? 0 : Math.min(st.track.duration_ms, st.pos0 + (st.playing ? clock() - st.at0 : 0));
  const change = () => { st.changedAt = clock(); };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x"), p = u.pathname; counts[p] = (counts[p] || 0) + 1;
    const send = (code, j, h = {}) => { res.writeHead(code, { "content-type": "application/json", ...h }); res.end(j === undefined ? "" : JSON.stringify(j)); };
    if (p === "/api/token") return send(200, { access_token: "AT-test", refresh_token: "RT-test", expires_in: 3600 });
    if (!/^Bearer /.test(req.headers.authorization || "")) return send(401, { error: { status: 401, message: "No token provided" } });
    if (limits.n > 0) { limits.n--; return send(429, { error: { status: 429, message: "API rate limit exceeded" } }, { "retry-after": String(limits.retryAfter) }); }
    if (p === "/v1/me/player" || p === "/v1/me/player/currently-playing") {
      if (!st.track) return send(204);
      const pos = Math.max(0, Math.round(posNow() + rnd() * jitterMs));
      return send(200, { ...(p === "/v1/me/player" ? { device: { id: "d1", is_active: true, name: st.device, type: "Speaker", volume_percent: st.volume } } : {}),
        timestamp: st.changedAt, progress_ms: pos, is_playing: st.playing, currently_playing_type: "track", item: st.track });
    }
    const m = /^\/v1\/audio-analysis\/(\w+)$/.exec(p);
    if (m) { if (mode === "403") return send(403, { error: { status: 403, message: "Forbidden" } }); const f = fixtures[m[1]]; return f ? send(200, f) : send(404, { error: { status: 404, message: "analysis not found" } }); }
    send(404, { error: { status: 404, message: "Service not found" } });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const track = (id, name, artist, durSec) => ({ type: "track", id, name, duration_ms: Math.round(durSec * 1000), artists: [{ name: artist }], external_ids: { isrc: "TEST00000001" },
    album: { name: "Test album", images: [{ url: `https://i.scdn.co/image/${id}-640`, width: 640, height: 640 }, { url: `https://i.scdn.co/image/${id}-300`, width: 300, height: 300 }, { url: `https://i.scdn.co/image/${id}-64`, width: 64, height: 64 }] } });
  return {
    base, counts, server, track,
    /** Start playing a track ({id, name, artist, dur}) at `pos` seconds. */
    play(t, pos = 0) { st.track = track(t.id, t.name, t.artist, t.dur); st.pos0 = pos * 1000; st.at0 = clock(); st.playing = true; change(); },
    pause() { st.pos0 = posNow(); st.at0 = clock(); st.playing = false; change(); },
    resume() { st.at0 = clock(); st.playing = true; change(); },
    seek(pos) { st.pos0 = pos * 1000; st.at0 = clock(); change(); },
    stop() { st.track = null; st.playing = false; change(); },
    volume(v) { st.volume = v; },
    /** The true position now (s). */
    get pos() { return posNow() / 1000; },
    set analysis(m) { mode = m; },
    /** The next n requests get 429 with this Retry-After. */
    limit(n, retryAfter = 5) { limits.n = n; limits.retryAfter = retryAfter; },
    /** fetch() that sends Spotify's addresses here (and `other` for anything else). */
    fetchVia(other = globalThis.fetch) { return (url, o) => { const s = String(url);
      if (s.startsWith("https://api.spotify.com")) return fetch(base + s.slice("https://api.spotify.com".length), o);
      if (s.startsWith("https://accounts.spotify.com")) return fetch(base + s.slice("https://accounts.spotify.com".length), o);
      return other(url, o); }; },
    close() { return new Promise(r => { server.closeAllConnections?.(); server.close(r); }); },
  };
}
