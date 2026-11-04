// Sync with Spotify: the lights follow the Spotify track that is playing, with its full beat map, without having to
// hear it. One toggle (settings.spotify.sync), on by default; it does something once Spotify plays on this computer or
// your Spotify account is connected (nowplaying.js: your own Client ID, PKCE, tokens never leave this computer).
//
//  1. Where in the track: the Spotify app on this computer when it plays here (osascript / MPRIS: exact, read every
//     second), else the Web API (GET /v1/me/player), asked about every 3 s while a track plays on and every second
//     around changes, smoothed and gliding between readings (spotify-sync.js); 429 answers are waited out.
//  2. The beat map, by Spotify track ID: song memory first (a song you played here, a map learned before, one from the
//     shared service), then the shared beat-map service if you turned it on, then Spotify's own audio analysis if your
//     Client ID still has it (apps made before 27 Nov 2024; a 403 is remembered and it isn't asked again).
//  3. No map: Tempolight learns it while the track plays and it listens live (a browser sharing system sound or a
//     microphone, or the server's sound card), lined up with the Spotify position (spotify-learn.js). Partial maps are
//     followed where they cover and completed on later plays. With a map, live kicks (when there are any) keep the
//     position locked to the beat.
//  4. Spotify paused: the lights fade to the ambient look; a skip dips and crossfades to the next song's map; volume 0
//     dims them. Cover colours (optional): the browser takes 2 or 3 colours from the album cover and sends them here.
//
// Node only (it is started by app.js, like nowplaying.js); the online demo has no Spotify.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { memoryAnalysis, refineByKicks } from "../../engine/src/index.js";
import { HttpError } from "./core.js";
import { matchSong } from "./nowplaying.js";
import { createTrackClock, pollDelay } from "./spotify-sync.js";
import { analysisToPre } from "./spotify-analysis.js";
import { createLearner, entryToMap, emptyMap, mergeMap, mapToPre, covers, coveredSec } from "./spotify-learn.js";
import { createBeatmapCloud, fromShared } from "./beatmap-cloud.js";

export const SPOTIFY_DEFAULTS = { sync: true, learn: true, analysis: true, coverColours: false, pauseFade: true, muteDim: true, cloud: { url: "", use: false, share: false } };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r3 = v => Math.round(v * 1000) / 1000;
const HEX = /^#[0-9a-f]{6}$/i;
const MODES = { off: "Off", idle: "Nothing playing", paused: "Paused", exact: "Exact (learned)", shared: "Exact (shared map)", analysis: "Spotify analysis", learning: "Learning", live: "Live" };
export const isComplete = e => !!e && (!e.cov || coveredSec(e.cov) >= 0.9 * e.dur);

/** The cover image to use: the smallest that is still at least 200 px wide (Spotify lists them largest first). */
export function pickImage(images) { const l = (images || []).filter(i => i && typeof i.url === "string" && /^https:\/\//.test(i.url)); if (!l.length) return null; return (l.filter(i => (i.width || 0) >= 200).at(-1) || l[0]).url; }

/**
 * @param {{core:object, store:object, runtime:object, nowPlaying:{np:object, view:()=>object}, dataDir?:string|null, now?:()=>number,
 *   wallNow?:()=>number, fetch?:Function, tick?:number}} o now: ms, the same clock as the runtime's (performance.now()); tick: how often
 *   to look (ms; 0: never by itself, tests call tick())
 */
export function startSpotify({ core, store, runtime, nowPlaying, dataDir = null, now = () => performance.now(), wallNow = Date.now, fetch = globalThis.fetch, tick: tickMs = 200 }) {
  const np = nowPlaying.np, sp = np.spotify, rt = runtime.rt, data = () => store.data;
  const set = () => { const s = data().settings; if (!s.spotify || typeof s.spotify !== "object") s.spotify = structuredClone(SPOTIFY_DEFAULTS); const x = s.spotify;
    for (const [k, v] of Object.entries(SPOTIFY_DEFAULTS)) if (x[k] === undefined) x[k] = structuredClone(v); for (const [k, v] of Object.entries(SPOTIFY_DEFAULTS.cloud)) if (x.cloud[k] === undefined) x.cloud[k] = v; return x; };
  const on = () => set().sync !== false, memoryOn = () => data().settings.songMemory !== false;
  const clientId = () => data().settings.nowPlaying?.spotifyClientId || "";
  const note = (m, l) => runtime.note(m, l);

  // an anonymous random ID for the shared beat-map service, kept next to the settings (never in them, so not in backups or the UI)
  let installId = null; const idFile = dataDir ? path.join(dataDir, "beatmaps-install-id") : null;
  const getInstall = () => { if (installId) return installId; try { if (idFile && existsSync(idFile)) installId = readFileSync(idFile, "utf8").trim(); } catch {}
    if (!/^[0-9a-f]{32}$/.test(installId || "")) { installId = crypto.randomBytes(16).toString("hex"); try { if (idFile) writeFileSync(idFile, installId, { mode: 0o600 }); } catch {} } return installId; };
  const cloud = createBeatmapCloud({ fetch, url: () => set().cloud.url, installId: getInstall, now: wallNow });

  const clock = createTrackClock(), learner = createLearner();
  const st = { web: null, webAt: -1e9, busy: false, nextAt: 0, rtt: 0, error: null, key: null, wasPlaying: false, pausedAt: null, skipAt: -1e9, dimF: 1, dimAt: null,
    kickCorr: 0, kickAt: -1e9, kickLocked: false, lastPcm: -1e9, learnTrack: null, learning: null, learned: new Set(), looked: new Set(), colors: null, entry: null, entryKey: "", pre: null, preOf: null, finishing: null };

  // ---------------------------------------------------------------- the track now
  const sameTrack = (a, b) => !!a && !!b && (a.spotifyId && b.id ? a.spotifyId === b.id : a.title.toLowerCase() === b.title.toLowerCase());
  /** The Spotify track playing now, wherever it is read from: {via, id, key, title, artist, album, dur, pos, playing, volume, art, device, isrc}. */
  function current(at = now(), forLights = false) {
    const loc = np.track(at), local = loc && loc.source !== "spotify" && /spotify/i.test(loc.app) && loc.posKnown ? loc : null;
    const w = st.web && now() - st.webAt < 15000 ? st.web : null;
    if (local) { const same = sameTrack(local, w), id = local.spotifyId || (same ? w.id : null);
      return { via: "local", id, key: id || `~${local.title}|${local.artist}|${Math.round(local.dur)}`, title: local.title, artist: local.artist, album: local.album, dur: local.dur || (same ? w.dur : 0), pos: local.pos, playing: local.playing,
        volume: same ? w.volume : null, art: same ? w.art : null, device: "this computer", isrc: same ? w.isrc : null }; }
    if (!w) return null;
    const pos = clock.id === w.id ? (forLights ? clock.shown(at) : clock.estimate(at)) : null;
    return { via: "web", id: w.id, key: w.id, title: w.title, artist: w.artist, album: w.album, dur: w.dur, pos, playing: clock.id === w.id ? clock.playing : w.playing, volume: w.volume, art: w.art, device: w.device, isrc: w.isrc };
  }
  function localPlaying() { const l = np.track(); return !!l && l.source !== "spotify" && /spotify/i.test(l.app) && l.posKnown; }

  // ---------------------------------------------------------------- asking the Web API
  async function poll() {
    const t0 = now(), r = await sp.api("/v1/me/player?additional_types=track"), t1 = now(), at = (t0 + t1) / 2;
    st.rtt = st.rtt ? st.rtt * 0.7 + (t1 - t0) * 0.3 : t1 - t0;
    if (r.status === 429) { const s = Math.max(1, r.retryAfter || 10); st.nextAt = t1 + s * 1000; st.error = `Spotify asked Tempolight to slow down: asking again in ${Math.round(s)} s`; return; }
    if (r.status === 0) { st.error = r.noAuth ? null : r.error || "No answer from Spotify"; st.nextAt = t1 + 5000; return; }
    if (r.status === 401) { st.nextAt = t1 + 1000; return; }
    if (r.status !== 204 && (r.status < 200 || r.status >= 300)) { st.error = `Spotify said ${r.status}`; st.nextAt = t1 + 5000; return; }
    st.error = null;
    const j = r.json, it = j && j.item;
    if (!it || it.type === "episode" || !it.id) { st.web = null; st.webAt = t1; st.nextAt = t1 + pollDelay({ nothing: true }); return; }
    const dur = (Number(it.duration_ms) || 0) / 1000, playing = !!j.is_playing;
    st.web = { id: it.id, title: String(it.name || "").slice(0, 200), artist: (it.artists || []).map(a => a.name).join(", ").slice(0, 200), album: String(it.album?.name || "").slice(0, 200), dur, playing,
      volume: typeof j.device?.volume_percent === "number" ? j.device.volume_percent : null, device: j.device?.name ? String(j.device.name).slice(0, 80) : null, art: pickImage(it.album?.images), isrc: it.external_ids?.isrc || null };
    st.webAt = t1;
    const ev = j.progress_ms != null ? clock.sample({ id: it.id, pos: Number(j.progress_ms) / 1000, playing, at, rtt: t1 - t0, ts: j.timestamp ?? null, dur }) : null;
    if (ev === "seek" || ev === "track") { st.kickCorr = 0; st.kickLocked = false; }
    st.nextAt = t1 + pollDelay({ playing, pos: clock.estimate(t1), dur, samples: clock.samples, sinceEventMs: t1 - (clock.lastEvent?.at ?? -1e9), local: localPlaying(), nothing: false });
  }
  // nowplaying.js asks the same endpoint for its "Now playing" card: while we poll, it uses our answer instead
  sp.feed = () => { if (!on() || !st.web || now() - st.webAt > 2500 || clock.id !== st.web.id) return null; const w = st.web;
    return [{ app: "Spotify", device: w.device, title: w.title, artist: w.artist, album: w.album, dur: w.dur, pos: clock.estimate(now()), playing: clock.playing, posOk: true, spotifyId: w.id }]; };

  // ---------------------------------------------------------------- beat maps for a track
  let findKey = "", found = null;
  /** The remembered song for this track: by Spotify ID, else by title, artist and length (and then it gets the ID). */
  function entryFor(tr) {
    const list = data().songs || [], k = `${tr.key}|${list.length}|${list.at(-1)?.id}|${list.at(-1)?.at}`;
    if (k === findKey && (!found || list.includes(found))) return found;
    findKey = k; found = (tr.id && list.find(e => e.spotifyId === tr.id)) || (tr.title ? matchSong({ title: tr.title, artist: tr.artist, dur: tr.dur }, tr.id ? list.filter(e => !e.spotifyId || e.spotifyId === tr.id) : list) : null) || null;
    if (found && tr.id && !found.spotifyId) { found.spotifyId = tr.id; store.save(); }
    return found;
  }
  const nameOf = tr => (tr.artist ? `${tr.artist.split(",")[0].trim()} - ${tr.title}` : tr.title).slice(0, 120);
  /** Save a beat map for a track in song memory (replacing what was there for it) and mark where it came from. */
  function save(tr, pre, { cov = null, src, gridSec } = {}) {
    if (!memoryOn()) return null;
    const list = data().songs, name = nameOf(tr), old = list.find(e => tr.id && e.spotifyId === tr.id) || entryFor(tr);
    if (old) { old.name = name; old.dur = pre.dur; } // so remember() replaces it (and keeps its show edits)
    const e = runtime.remember(name, pre); if (!e) return null;
    Object.assign(e, { src, ...(tr.id ? { spotifyId: tr.id } : {}), ...(tr.isrc ? { isrc: tr.isrc } : {}), hats: (pre.hats || []).map(r3) }); // all the hi-hats (memoryEntry keeps every other one), so merging later loses none
    if (cov && coveredSec(cov) < pre.dur - 1) { e.cov = cov.map(c => [r3(c[0]), r3(c[1])]); e.gridSec = Math.round(gridSec || 0); } else { delete e.cov; delete e.gridSec; }
    findKey = ""; store.save(); core.broadcast({ type: "changed", what: "songs" }); return e;
  }
  async function lookUp(tr) {
    if (!tr.id || st.looked.has(tr.id) || !memoryOn()) return; st.looked.add(tr.id);
    let e = entryFor(tr); if (isComplete(e)) return;
    const s = set();
    if (s.cloud.use && s.cloud.url) { const got = await cloud.get(tr.id), sh = got && fromShared(got.map);
      if (sh && (!e || coveredSec(sh.cov) > coveredSec(e.cov || [[0, e.dur]]))) { e = save(tr, sh.pre, { cov: sh.cov, src: "shared", gridSec: coveredSec(sh.cov) }); if (e) note(`Spotify: got a shared beat map for “${tr.title}” (${got.installs} installs agree)`); }
      if (isComplete(e)) return; }
    if (s.analysis && s.analysisBlocked !== clientId() && sp.connected) {
      const r = await sp.api(`/v1/audio-analysis/${tr.id}`);
      if (r.status === 403) { s.analysisBlocked = clientId(); store.save(); note("Spotify: its audio analysis isn't available to this Spotify app (apps made after 27 November 2024 can't use it). Tempolight learns songs by listening instead."); return; }
      if (r.status === 200) { const pre = analysisToPre(r.json, tr.dur); if (pre && !isComplete(entryFor(tr))) { e = save(tr, pre, { src: "spotify-analysis" }); if (e) note(`Spotify: “${tr.title}” has Spotify's analysis; following its beats and sections`); } }
      else if (r.status === 429) st.looked.delete(tr.id); // ask again next time it plays
    }
  }

  // ---------------------------------------------------------------- learning by listening
  rt.pcmTap = (samples, rate, kind, inMs = 0) => {
    if (!on() || set().learn === false || !memoryOn() || (rt.song && rt.song.playing)) return;
    const at = now(), tr = current(at - (Number(inMs) || 0)); if (!tr || !tr.playing || tr.pos == null || !(tr.dur > 20) || tr.pos > tr.dur - 1) return;
    const e = entryFor(tr); if (isComplete(e) || (e && e.src === "spotify-analysis")) return;
    if (learner.id && learner.id !== tr.key) finishLearning();
    st.learnTrack = { ...tr }; st.lastPcm = at;
    if (learner.push(tr.key, samples, tr.pos, rate) && !st.learning) { st.learning = { key: tr.key, since: at }; if (st.notedKey !== tr.key) { st.notedKey = tr.key; note(`Spotify: learning “${tr.title}” while it plays`); } }
  };
  function finishLearning() {
    const tr = st.learnTrack; if (!tr || !learner.id) return; const heard = learner.heard();
    st.learning = null; if (heard.sec < 15) { learner.reset(); return; }
    const job = (async () => {
      const parts = await learner.finish(); if (!parts.length) return;
      const e0 = entryFor(tr); let map = e0 && Math.abs(e0.dur - tr.dur) < 2 && e0.src !== "spotify-analysis" ? entryToMap(e0) : emptyMap(tr.dur); map.dur = tr.dur;
      for (const p of parts) map = mergeMap(map, p);
      const e = save(tr, mapToPre(map), { cov: map.cov, src: e0 && e0.src === "shared" && !(coveredSec(map.cov) > coveredSec(e0.cov || [])) ? "shared" : "learned", gridSec: map.gridSec }); if (!e) return;
      st.learned.add(tr.key); const pc = Math.round(Math.min(1, coveredSec(map.cov) / tr.dur) * 100);
      note(`Spotify: learned “${tr.title}” (${pc < 95 ? `${pc}% of it so far` : "all of it"}). Next time the lights follow its beat map without listening.`);
      const s = set(); if (s.cloud.share && s.cloud.url && tr.id && coveredSec(map.cov) >= 0.6 * tr.dur) { const r = await cloud.put(tr.id, e); if (r.ok) note(`Spotify: shared the beat map of “${tr.title}”${r.confirmed ? ` (confirmed by ${r.installs} installs)` : ""}`); }
    })().catch(err => note(`Spotify: couldn't learn “${tr.title}”: ${err.message}`, "warn")).finally(() => { if (st.finishing === job) st.finishing = null; });
    st.finishing = job; return job;
  }

  // ---------------------------------------------------------------- every tick: polling, track changes, pauses
  async function tick() {
    if (on() && sp.connected && !st.busy && now() >= st.nextAt) { st.busy = true; try { await poll(); } catch (e) { st.error = e.message; st.nextAt = now() + 5000; } finally { st.busy = false; } }
    if (!sp.connected) st.web = null;
    const t = now(), tr = on() ? current(t) : null, key = tr ? tr.key : null;
    if (key !== st.key) {
      if (st.key && key) st.skipAt = t; // a skip: dip and crossfade to the next song
      st.key = key; st.kickCorr = 0; st.kickLocked = false; st.pausedAt = null; st.wasPlaying = false;
      if (tr) lookUp(tr).catch(e => note(`Spotify: ${e.message}`, "warn"));
    }
    if (tr) { if (st.wasPlaying && !tr.playing) st.pausedAt = t; if (tr.playing) st.pausedAt = null; st.wasPlaying = tr.playing; }
    // a stretch heard ends: another track, a pause, the end of the track, or nothing heard for a while
    if (learner.id && st.learnTrack) { const lt = st.learnTrack;
      if (learner.id !== key || (st.pausedAt != null && t - st.pausedAt > 8000) || t - st.lastPcm > 5000 || (tr && tr.pos != null && tr.dur > 0 && tr.pos > tr.dur - 0.8 && lt.key === key)) finishLearning(); }
  }
  let timer = null; if (tickMs > 0) timer = setInterval(() => { tick().catch(() => {}); }, tickMs);

  // ---------------------------------------------------------------- for the runtime
  function follow() {
    if (!on() || !memoryOn()) return null;
    const at = now(), tr = current(at, true); if (!tr || !tr.playing || tr.pos == null) return null;
    const e = entryFor(tr); if (!e) return null;
    if (st.preOf !== e || st.preAt !== e.at) { st.pre = memoryAnalysis(e); st.preOf = e; st.preAt = e.at; }
    let pos = tr.pos + st.kickCorr;
    // live kicks, when there are any, lock the position to the beat (the Web API's position can be some tens of ms off)
    if (rt.live && performance.now() - rt.live.lastPush < 1500 && at - st.kickAt > 1000 && st.pre.kicks.length) { st.kickAt = at;
      const an = rt.live.an, posLive = pos - (performance.now() - rt.live.lastPush + (rt.live.inMs || 0)) / 1000, ref = refineByKicks(an.kicks, an.t, posLive, st.pre.kicks, 0.15);
      if (ref.hits) { st.kickCorr = clamp(st.kickCorr + clamp((ref.pos - posLive) * 0.5, -0.1, 0.1), -0.5, 0.5); st.kickLocked = true; pos = tr.pos + st.kickCorr; } }
    if (!covers(e.cov, pos)) return null;
    return { id: e.id, name: e.name, app: tr.via === "local" ? "Spotify" : `Spotify${tr.device ? ` (${tr.device})` : ""}`, pre: st.pre, pos, spotify: true };
  }
  const base = rt.nowPlaying; let mine = null;
  if (base) rt.nowPlaying = {
    follow(at) { mine = follow(); return mine || base.follow(at); },
    get memId() { return mine ? mine.id : base.memId; },
    info() { const i = base.info(); return i && mine ? { ...i, remembered: { id: mine.id, name: mine.name }, following: rt.source === "nowplaying" } : i; },
  };
  function modeOf(tr, e) {
    if (!on()) return "off"; if (!tr) return "idle"; if (!tr.playing) return "paused";
    if (mine && rt.source === "nowplaying" && e && mine.id === e.id) return e.src === "spotify-analysis" ? "analysis" : e.src === "shared" ? "shared" : "exact";
    if (st.learning && st.learning.key === tr.key && now() - st.lastPcm < 3000) return "learning";
    return "live";
  }
  function info() {
    const tr = on() ? current() : null, e = tr ? entryFor(tr) : null, mode = modeOf(tr, e);
    const heard = st.learning && tr && st.learning.key === tr.key ? learner.heard() : null, haveSec = e && e.src !== "spotify-analysis" ? coveredSec(e.cov || [[0, e.dur]]) : 0;
    const learn = !tr ? null : st.finishing && st.learnTrack?.key === tr.key ? { state: "analysing" } : heard ? { state: "learning", pct: Math.min(99, Math.round((haveSec + heard.sec) / Math.max(1, tr.dur) * 100)) } : st.learned.has(tr.key) || (e && e.src === "learned" && isComplete(e)) ? { state: "learned", pct: Math.round(Math.min(1, haveSec / Math.max(1, tr.dur)) * 100) } : null;
    return { on: on(), connected: sp.connected, mode, modeName: MODES[mode], via: tr ? tr.via : null, error: st.error,
      track: tr ? { id: tr.id, title: tr.title, artist: tr.artist, album: tr.album, dur: Math.round(tr.dur * 10) / 10, pos: tr.pos == null ? null : Math.round(tr.pos * 10) / 10, playing: tr.playing, volume: tr.volume, art: tr.art, device: tr.device } : null,
      map: e ? { id: e.id, name: e.name, src: e.src || "file", cover: Math.round(Math.min(1, (e.cov ? coveredSec(e.cov) : e.dur) / Math.max(1, e.dur)) * 100) } : null,
      learn, locked: st.kickLocked };
  }
  rt.spotify = {
    info,
    /** Spotify was just paused: the lights go to the ambient look (for 15 s; after that the usual sources decide). */
    paused() { if (!on() || !set().pauseFade || st.pausedAt == null) return false; const tr = current(); return !!tr && !tr.playing && now() - st.pausedAt < 15000; },
    /** A brightness factor: dim while Spotify's volume is 0, and a short dip when the track changes. */
    dim() {
      const t = now(), dt = st.dimAt == null ? 0 : Math.max(0, (t - st.dimAt) / 1000); st.dimAt = t;
      const tr = on() ? current(t) : null; let target = set().muteDim && tr && tr.playing && tr.volume === 0 ? 0.1 : 1;
      const sk = (t - st.skipAt) / 700; if (sk >= 0 && sk < 1) target = Math.min(target, 0.35 + 0.65 * sk);
      st.dimF += (target - st.dimF) * Math.min(1, dt / 0.15); return st.dimF;
    },
    /** Cover colours as the palette (when on, the palette is Automatic and the song's show has no colours of its own). */
    timeline(tl) {
      const c = st.colors; if (!on() || !set().coverColours || !c || data().show.palette !== "auto" || (tl && tl.colors && tl.colors.length)) return tl;
      const tr = current(); if (!tr || !tr.playing || tr.art !== c.art) return tl;
      return { colors: [{ t0: -1e9, t1: 1e9, colors: c.list }], cues: tl?.cues || [], bright: tl?.bright || [] };
    },
  };

  // ---------------------------------------------------------------- API
  const view = () => { const s = set(), nv = nowPlaying.view();
    return { settings: { sync: s.sync, learn: s.learn, analysis: s.analysis, coverColours: s.coverColours, pauseFade: s.pauseFade, muteDim: s.muteDim, cloud: { ...s.cloud } },
      ...info(), analysis: !s.analysis ? "off" : s.analysisBlocked && s.analysisBlocked === clientId() ? "blocked" : "unknown",
      account: { clientId: nv.spotify.clientId, connected: nv.spotify.connected, error: nv.spotify.error, redirectUri: nv.spotify.redirectUri }, local: { supported: nv.supported, enabled: nv.enabled, platform: nv.platform },
      poll: { rttMs: Math.round(st.rtt), jitterMs: clock.jitterMs, nextInMs: Math.max(0, Math.round(st.nextAt - now())) }, cloud: { last: cloud.last }, colors: st.colors ? st.colors.list : null }; };
  core.route("GET", "/api/spotify", null, () => view());
  core.route("PATCH", "/api/spotify", "admin", ctx => {
    const b = ctx.body || {}, s = set();
    for (const k of ["sync", "learn", "analysis", "coverColours", "pauseFade", "muteDim"]) if (b[k] !== undefined) s[k] = !!b[k];
    if (b.analysis === true) { delete s.analysisBlocked; st.looked.clear(); } // try Spotify's analysis again
    if (b.sync !== undefined) { note(s.sync ? "Sync with Spotify: on" : "Sync with Spotify: off"); if (!s.sync) { learner.reset(); st.learning = null; } }
    if (b.learn === false) { learner.reset(); st.learning = null; }
    if (b.cloud && typeof b.cloud === "object") { const c = b.cloud;
      if (c.url !== undefined) { const u = String(c.url || "").trim(); if (u && !/^https?:\/\/[^\s/]+[^\s]*$/i.test(u)) throw new HttpError(400, "The beat-map service address starts with https:// (your Worker's address)"); s.cloud.url = u.replace(/\/+$/, ""); st.looked.clear(); }
      if (c.use !== undefined) { s.cloud.use = !!c.use; st.looked.clear(); } if (c.share !== undefined) s.cloud.share = !!c.share; }
    findKey = ""; store.save(); core.broadcast({ type: "changed", what: "spotify" }); return view();
  });
  core.route("POST", "/api/spotify/colors", "effects", ctx => { const b = ctx.body || {}, list = Array.isArray(b.colors) ? b.colors.filter(c => HEX.test(String(c))).slice(0, 4).map(c => c.toLowerCase()) : [];
    if (typeof b.art !== "string" || !/^https:\/\//.test(b.art) || list.length < 2) throw new HttpError(400, "{art, colors: ['#rrggbb', '#rrggbb', ...]}");
    st.colors = { art: b.art, list }; return { ok: true }; });

  return { tick, poll, follow, info, view, clock, learner, cloud, finishLearning, get finishing() { return st.finishing; }, state: st,
    close() { clearInterval(timer); timer = null; sp.feed = null; delete rt.pcmTap; delete rt.spotify; if (base) rt.nowPlaying = base; } };
}
