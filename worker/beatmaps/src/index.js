// Tempolight shared beat maps: a Cloudflare Worker with a D1 database (binding DB). See docs/spotify.md.
//
//   GET  /v1/maps/:spotifyId   the confirmed map for a Spotify track: {map, installs, updated}, or 404
//   POST /v1/maps/:spotifyId   an install shares what it learned: body {map} (at most 32 KB), header x-install-id
//                              (32 hex digits, random, made by Tempolight); answers {ok, confirmed, installs}
//   GET  /                     a short description
//
// A map is served only once at least two different installs sent maps that agree (map.js). Install IDs and IP addresses
// are stored only as SHA-256 hashes with the secret SALT; nothing else about the sender is kept. Rate limits per install
// and per IP (vars in wrangler.jsonc).
import { checkMap, consensus, isTrackId, isInstallId, MAX_BYTES, coverSec } from "./map.js";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type, x-install-id", "access-control-max-age": "86400" };
const json = (status, obj, extra = {}) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", ...CORS, ...extra } });

async function sha(salt, s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${s}`));
  return Array.from(new Uint8Array(d).slice(0, 16), b => b.toString(16).padStart(2, "0")).join("");
}
/** Counts one more for key k in its window; false when that is over the limit. */
async function allow(db, k, limit, windowMs, now) {
  const row = await db.prepare("SELECT n, reset FROM rate WHERE k = ?").bind(k).first();
  const n = row && row.reset > now ? row.n + 1 : 1, reset = row && row.reset > now ? row.reset : now + windowMs;
  await db.prepare("INSERT OR REPLACE INTO rate (k, n, reset) VALUES (?, ?, ?)").bind(k, n, reset).run();
  return n <= limit;
}

export async function handle(req, env, now = Date.now()) {
  const url = new URL(req.url), db = env.DB, salt = env.SALT || "tempolight";
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (url.pathname === "/" && req.method === "GET") return json(200, { service: "Tempolight shared beat maps", api: ["GET /v1/maps/:spotifyId", "POST /v1/maps/:spotifyId"], docs: "https://github.com/D4RKGEEK/tempolight/blob/main/docs/spotify.md" });
  const m = /^\/v1\/maps\/([^/]+)$/.exec(url.pathname); if (!m) return json(404, { error: "Not found" });
  const id = m[1]; if (!isTrackId(id)) return json(400, { error: "Not a Spotify track ID" });
  if (!db) return json(500, { error: "No database (bind a D1 database as DB)" });
  const ip = await sha(salt, req.headers.get("cf-connecting-ip") || "unknown"), day = Math.floor(now / 86400000), hour = Math.floor(now / 3600000);
  const lim = k => Number(env[k]) || { MAX_POSTS_PER_INSTALL_DAY: 200, MAX_POSTS_PER_IP_DAY: 400, MAX_GETS_PER_IP_HOUR: 3000 }[k];

  if (req.method === "GET") {
    if (!await allow(db, `get-ip:${ip}:${hour}`, lim("MAX_GETS_PER_IP_HOUR"), 3600000, now)) return json(429, { error: "Too many requests" }, { "retry-after": "600" });
    const row = await db.prepare("SELECT body, installs, updated FROM maps WHERE spotify_id = ?").bind(id).first();
    if (!row) return json(404, { error: "No confirmed map for this track yet" }, { "cache-control": "public, max-age=600" });
    return json(200, { map: JSON.parse(row.body), installs: row.installs, updated: row.updated }, { "cache-control": "public, max-age=3600" });
  }
  if (req.method !== "POST") return json(405, { error: "GET or POST" });
  const inst = req.headers.get("x-install-id") || ""; if (!isInstallId(inst)) return json(400, { error: "x-install-id: 32 hex digits" });
  const len = Number(req.headers.get("content-length") || 0); if (len > MAX_BYTES) return json(413, { error: `At most ${MAX_BYTES} bytes` });
  const text = await req.text(); if (new TextEncoder().encode(text).length > MAX_BYTES) return json(413, { error: `At most ${MAX_BYTES} bytes` });
  const who = await sha(salt, inst);
  if (!await allow(db, `post-ip:${ip}:${day}`, lim("MAX_POSTS_PER_IP_DAY"), 86400000, now) || !await allow(db, `post-install:${who}:${day}`, lim("MAX_POSTS_PER_INSTALL_DAY"), 86400000, now))
    return json(429, { error: "Too many maps today" }, { "retry-after": "3600" });
  let body; try { body = JSON.parse(text); } catch { return json(400, { error: "Body is not JSON" }); }
  const c = checkMap(body && body.map); if (!c.ok) return json(400, { error: c.error });
  await db.prepare("INSERT OR REPLACE INTO submissions (spotify_id, install, ip, created, bpm, cover, body) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(id, who, ip, now, c.map.bpm, coverSec(c.map), JSON.stringify(c.map)).run();
  const rows = (await db.prepare("SELECT install, body FROM submissions WHERE spotify_id = ? ORDER BY created DESC LIMIT 50").bind(id).all()).results || [];
  const best = consensus(rows.map(r => ({ install: r.install, map: JSON.parse(r.body) })));
  if (best) await db.prepare("INSERT OR REPLACE INTO maps (spotify_id, body, installs, updated) VALUES (?, ?, ?, ?)").bind(id, JSON.stringify(best.map), best.installs, now).run();
  if (Math.random() < 0.02) await db.prepare("DELETE FROM rate WHERE reset < ?").bind(now).run(); // now and then: old counters
  return json(200, { ok: true, confirmed: !!best, installs: best ? best.installs : 1 });
}

export default { fetch: (req, env) => handle(req, env).catch(e => json(500, { error: String(e && e.message || e) })) };
