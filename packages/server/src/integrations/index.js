// Integrations for streamers and gamers: OBS Studio, game events (CS2 and Dota 2), Twitch chat and events, Discord,
// and the Stream Deck plugin's download. Started by app.js on a PC or Pi; the online demo never loads this folder.
//
// Their settings live in the settings file under `integrations` (not under `settings`, so /api/state never shows
// them): passwords, tokens and the webhook stay on the server. Every route that reads or changes them is admin-only
// (the PIN lock); the only open ones are the games' POST /api/gsi/<game> (which needs the game's own token) and the
// Stream Deck plugin's download (which holds no secrets).
//
// What they do to the lights goes through what the rest of Tempolight already has (scenes, effects, the live pads),
// plus one layer drawn on top of the show, after it and under the pads (the director's `post` hook, shared with
// Home & sleep): the games' colours and flashes, the OBS tally light, and colours from chat or Twitch events.
import crypto from "node:crypto";
import path from "node:path";
import { existsSync } from "node:fs";
import { HttpError } from "../core.js";
import { merge } from "../defaults.js";
import { createGames, GAMES, GAME_DEFAULTS, gsiConfig, hexColor } from "./games.js";
import { createObsClient } from "./obs.js";
import { createTwitchChat, chatCommand, CHAT_DEFAULTS, twitchAuth, createEventSub, EVENT_TYPES, SCOPES, eventText, IRC_URL, EVENTSUB_URL, HELIX, ID_BASE, COMMANDS } from "./twitch.js";
import { createDiscord, DISCORD_DEFAULTS, isWebhook, maskWebhook } from "./discord.js";
import { openWebSocket } from "./ws-client.js";
import { packFolder } from "./zip.js";

export const PLUGIN_UUID = "io.github.d4rkgeek.tempolight";
export const PLUGIN_DIR = `integrations/streamdeck/${PLUGIN_UUID}.sdPlugin`;
const RELEASES = "https://github.com/D4RKGEEK/tempolight/releases";
// the docs site's "Try it" panel (mintlify/openapi.json rendered by scripts/build-docs-site.js) may call /api/* from these
// pages once an admin turns it on (Integrations → Docs site); off by default, so other websites stay refused
export const DOCS_ORIGINS = ["https://tempolight.pages.dev", "http://localhost:3000", "http://127.0.0.1:3000"];
const REACTIONS = ["none", "flash", "color", "strobe", "scene", "effect", "drop"];

export const INTEGRATION_DEFAULTS = () => ({
  obs: { enabled: false, url: "ws://127.0.0.1:4455", password: "", sceneMap: [], onStreamStart: "", onStreamStop: "", onRecordStart: "",
    tally: { enabled: true, when: "recording", target: "all", color: "#ff0000" } },
  games: GAME_DEFAULTS(),
  twitch: { chat: CHAT_DEFAULTS(), clientId: "", eventsOn: true, target: "all", auth: null,
    events: { follow: { type: "flash", color: "#9146ff" }, subscribe: { type: "color", color: "#ffd000", seconds: 6 }, resub: { type: "color", color: "#ffd000", seconds: 6 },
      gift: { type: "color", color: "#ff3fa4", seconds: 8 }, raid: { type: "strobe", seconds: 3 }, cheer: { type: "flash", color: "#00e5ff", minBits: 1 } } },
  discord: DISCORD_DEFAULTS(),
  docs: { tryIt: false }, // let the docs site's API reference send requests here (CORS for DOCS_ORIGINS)
});

const TARGET = /^(all|off|zone:.{1,40}|dev:.{1,40})$/s;
const bad = msg => new HttpError(400, msg);
const hexOk = c => /^#[0-9a-f]{6}$/i.test(String(c || ""));
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y); };
const inv = x => -Math.log(1 - Math.min(0.995, Math.max(0, x))) / 1.6; // undo toRGB8's soft roll-off (as in home.js)

/**
 * @param {{core:object, store:object, runtime:object, root:string, open?:Function, fetch?:Function, now?:()=>number,
 *   urls?:{irc?:string, eventsub?:string, helix?:string, id?:string}, pollMs?:number, discordGapMs?:number}} o
 *   open, fetch, urls: replaced in tests (pretend OBS, Twitch and Discord)
 */
export function startIntegrations({ core, store, runtime, root, open = openWebSocket, fetch = globalThis.fetch, now = () => Date.now(), urls = {}, pollMs = 2000, discordGapMs = 3000 }) {
  const data = () => store.data;
  let known = null; // the settings object last filled in with the defaults (a restored backup or a reset brings a new one)
  const C = () => { const d = data(); if (d.integrations !== known || !known) { d.integrations = merge(INTEGRATION_DEFAULTS(), d.integrations && typeof d.integrations === "object" ? d.integrations : {}); known = d.integrations; } return known; };
  C();
  const note = (m, l) => runtime.note(m, l);
  const safe = () => !!(data().settings.safe || runtime.rt.night);
  let tellTimer = null;
  const tell = () => { if (tellTimer) return; tellTimer = setTimeout(() => { tellTimer = null; core.broadcast({ type: "changed", what: "integrations" }); }, 300); tellTimer.unref?.(); };
  const save = () => { store.save(); tell(); };

  // ---------------------------------------------------------------- what they do to the lights
  const holds = []; // colours for a while: {target, color, until}
  let strobeTimer = null;
  function react(r, why) {
    if (!r || !r.type || r.type === "none") return false;
    try {
      if (r.type === "scene") { const sc = data().scenes.find(s => s.id === r.scene); if (!sc) return false; core.applyScene(sc); }
      else if (r.type === "effect") core.applyShow({ effect: r.effect });
      else if (r.type === "flash") runtime.action({ type: "flash", color: hexOk(r.color) ? r.color : undefined });
      else if (r.type === "drop") runtime.action({ type: "drop" });
      else if (r.type === "color") { holds.push({ target: r.target || C().twitch.target || "all", color: hexColor(r.color) || [1, 1, 1], until: now() + Math.max(1, Math.min(60, Number(r.seconds) || 6)) * 1000, at: now() }); if (holds.length > 8) holds.shift(); }
      else if (r.type === "strobe") { if (safe()) { runtime.action({ type: "flash" }); return true; } // photosensitive-safe: a single flash instead
        runtime.action({ type: "strobe", on: true }); clearTimeout(strobeTimer); strobeTimer = setTimeout(() => { try { runtime.action({ type: "strobe", on: false }); } catch {} }, Math.max(1, Math.min(10, Number(r.seconds) || 3)) * 1000); strobeTimer.unref?.(); }
      else return false;
      return true;
    } catch (e) { note(`${why || "Integration"}: ${e.message}`, "warn"); return false; }
  }

  const games = createGames({ now });
  const masks = new Map(); let maskL = null, maskShapes = null;
  function mask(target) {
    const L = runtime.layout, shapes = data().room.shapes; if (maskL !== L || maskShapes !== shapes) { masks.clear(); maskL = L; maskShapes = shapes; }
    let m = masks.get(target); if (m) return m;
    m = new Uint8Array(L.N); const [kind, id] = String(target || "all").split(/:(.*)/s);
    for (let i = 0; i < L.N; i++) { const sh = shapes[L.LF[i]]; m[i] = kind === "zone" ? (sh?.zone === id ? 1 : 0) : kind === "dev" ? (sh?.dev === id ? 1 : 0) : kind === "off" ? 0 : 1; }
    if (kind !== "off" && !m.some(Boolean)) m.fill(1); // the zone is gone: the whole room
    masks.set(target, m); return m;
  }
  /** Every layer that should be drawn now. */
  function layers() {
    const c = C(), out = games.layers(c.games, { safe: safe() }), t = now();
    const o = c.obs, ost = obs?.status();
    if (o.enabled && o.tally.enabled && ost?.connected) { const on = o.tally.when === "streaming" ? ost.streaming : o.tally.when === "either" ? ost.streaming || ost.recording : ost.recording;
      if (on) out.push({ target: o.tally.target, color: hexColor(o.tally.color) || [1, 0, 0], mix: 1 }); }
    for (let i = holds.length - 1; i >= 0; i--) { const h = holds[i]; if (t >= h.until) { holds.splice(i, 1); continue; }
      const k = Math.min(1, (h.until - t) / 600, (t - h.at) / 250); out.push({ target: h.target, color: h.color, mix: 0.9 * k }); }
    return out;
  }
  function draw(COL) {
    const ls = layers(); if (!ls.length) return; const N = runtime.layout.N;
    for (const l of ls) { if (!l.target || l.target === "off") continue; const m = mask(l.target), c = l.color;
      if (l.add) { const a = l.add * 2.2; for (let i = 0; i < N; i++) if (m[i]) { const j = i * 3; COL[j] += c[0] * a; COL[j + 1] += c[1] * a; COL[j + 2] += c[2] * a; } continue; }
      const k = Math.max(0, Math.min(1, l.mix)), v = [inv(c[0]), inv(c[1]), inv(c[2])];
      for (let i = 0; i < N; i++) if (m[i]) { const j = i * 3; COL[j] += (v[0] - COL[j]) * k; COL[j + 1] += (v[1] - COL[j + 1]) * k; COL[j + 2] += (v[2] - COL[j + 2]) * k; } }
  }
  const D = () => runtime.director, prevPost = D().settings.post;
  const post = (COL, wall) => { if (prevPost) prevPost(COL, wall); try { draw(COL); } catch (e) { if (!post.warned) { post.warned = true; note(`Integrations layer: ${e.message}`, "error"); } } };
  D().settings.post = post; // the director is made again when the room changes; its settings (and this) carry over

  // ---------------------------------------------------------------- OBS
  let obs = null, obsKey = "";
  function startObs() {
    const o = C().obs, key = JSON.stringify([o.enabled, o.url, o.password]); if (key === obsKey && (obs || !o.enabled)) return; obsKey = key;
    obs?.close(); obs = null; if (!o.enabled) return;
    let wasConnected = false;
    obs = createObsClient({ url: o.url, password: o.password, open, onChange: s => { if (s.connected !== wasConnected) { wasConnected = s.connected; note(s.connected ? `OBS: connected (${o.url})` : `OBS: ${s.error || "disconnected"}`, s.connected ? "info" : "warn"); } tell(); },
      onEvent: (type, d) => {
        const cfg = C().obs, scene = id => { const sc = id && data().scenes.find(s => s.id === id); if (sc) core.applyScene(sc); return !!sc; };
        if (type === "CurrentProgramSceneChanged") { const row = cfg.sceneMap.find(r => r.obs === d.sceneName); if (row && scene(row.scene)) note(`OBS scene “${d.sceneName}”: Tempolight scene ${data().scenes.find(s => s.id === row.scene)?.name}`); }
        else if (type === "StreamStateChanged" && d.outputState === "OBS_WEBSOCKET_OUTPUT_STARTED") { note("OBS: the stream started"); scene(cfg.onStreamStart); }
        else if (type === "StreamStateChanged" && d.outputState === "OBS_WEBSOCKET_OUTPUT_STOPPED") { note("OBS: the stream stopped"); scene(cfg.onStreamStop); }
        else if (type === "RecordStateChanged" && d.outputState === "OBS_WEBSOCKET_OUTPUT_STARTED") { note("OBS: recording"); scene(cfg.onRecordStart); }
        else if (type === "RecordStateChanged" && d.outputState === "OBS_WEBSOCKET_OUTPUT_STOPPED") note("OBS: recording stopped");
      } });
  }

  // ---------------------------------------------------------------- Twitch
  let chat = null, chatKey = "", sub = null, subKey = "", login = null; // login: a device-code sign-in in progress
  const memo = { last: new Map(), users: new Map() };
  const tw = () => C().twitch;
  const auth = () => twitchAuth({ clientId: tw().clientId, fetch, idBase: urls.id || ID_BASE });
  let lastChat = null;
  function startChat() {
    const c = tw().chat, key = JSON.stringify([c.enabled, c.channel]); if (key === chatKey && (chat || !c.enabled || !c.channel)) return; chatKey = key;
    chat?.close(); chat = null; if (!c.enabled || !c.channel) return;
    let was = false;
    chat = createTwitchChat({ channel: c.channel, url: urls.irc || IRC_URL, open, onChange: s => { if (s.joined !== was) { was = s.joined; note(s.joined ? `Twitch chat: reading #${s.channel}` : `Twitch chat: ${s.error || "disconnected"}`, s.joined ? "info" : "warn"); tell(); } },
      onMessage: m => {
        const cfg = tw().chat, r = chatCommand(m, cfg, { scenes: data().scenes, effects: runtime.effects.list, safe: safe() }, memo, now()); if (!r) return;
        lastChat = { at: now(), user: m.display, cmd: r.cmd, ok: r.ok, why: r.ok ? null : r.why };
        if (!r.ok) return;
        const a = r.action;
        if (react(a.type === "color" ? { ...a, target: tw().target } : a, "Twitch chat")) note(`Twitch chat: ${m.display} → !${r.cmd}${a.name ? ` ${a.name}` : a.color ? ` ${a.color}` : ""}`);
      } });
  }
  async function token() {
    const t = tw(), a = t.auth; if (!a) throw new Error("Not signed in to Twitch");
    if (a.expiresAt && a.expiresAt - now() < 120000 && a.refresh) { try { const r = await auth().refresh(a.refresh); Object.assign(a, { access: r.access_token, refresh: r.refresh_token || a.refresh, expiresAt: now() + (r.expires_in || 3600) * 1000 }); store.save(); }
      catch (e) { t.auth = null; save(); note(`Twitch: ${e.message}`, "warn"); throw e; } }
    return a.access;
  }
  function startSub() {
    const t = tw(), key = JSON.stringify([t.eventsOn, t.clientId, t.auth?.userId, !!t.auth]); if (key === subKey && (sub || !t.auth)) return; subKey = key;
    sub?.close(); sub = null; if (!t.eventsOn || !t.clientId || !t.auth?.userId) return;
    let was = false;
    sub = createEventSub({ token, clientId: t.clientId, userId: t.auth.userId, events: Object.keys(EVENT_TYPES), fetch, url: urls.eventsub || EVENTSUB_URL, helix: urls.helix || HELIX, open,
      onChange: s => { if (s.connected !== was) { was = s.connected; tell(); } },
      onEvent: (kind, e) => {
        const r = tw().events[kind]; if (kind === "cheer" && Number(e.bits || 0) < Number(r?.minBits || 1)) return;
        const text = eventText(kind, e); lastEvent = { at: now(), kind, text };
        note(`Twitch: ${text}`); if (r) react({ ...r, target: tw().target }, "Twitch");
        if (C().discord.twitch) discord.post(`🟣 ${text}`);
      } });
  }
  let lastEvent = null;
  async function startLogin(clientId) {
    const t = tw(); if (clientId !== undefined) { const id = String(clientId).trim(); if (!/^[a-z0-9]{20,40}$/i.test(id)) throw bad("A Twitch Client ID is about 30 letters and digits, from dev.twitch.tv/console"); if (id !== t.clientId) { t.auth = null; t.clientId = id; } }
    if (!t.clientId) throw bad("Paste your Twitch application's Client ID first");
    const a = auth(), d = await a.start().catch(e => { throw new HttpError(e.code || 502, e.message); });
    const L = login = { userCode: d.user_code, uri: d.verification_uri || "https://www.twitch.tv/activate", expiresAt: now() + (d.expires_in || 1800) * 1000, error: null };
    let every = Math.max(1, Number(d.interval) || 5) * 1000;
    const poll = async () => {
      if (login !== L) return; if (now() > L.expiresAt) { L.error = "The code expired: start again"; tell(); return; }
      try { const r = await a.poll(d.device_code); if (login !== L) return;
        if (r.pending || r.slow) { if (r.slow) every += 1000; L.timer = setTimeout(poll, every); L.timer.unref?.(); return; }
        const v = await a.validate(r.access_token); if (!v) throw new Error("Twitch gave a token that doesn't work");
        tw().auth = { access: r.access_token, refresh: r.refresh_token || "", expiresAt: now() + (r.expires_in || 3600) * 1000, login: v.login, userId: v.user_id, scopes: v.scopes || r.scope || [] };
        login = null; save(); note(`Twitch: signed in as ${v.login}`); startSub();
      } catch (e) { if (login === L) { L.error = e.message; tell(); } }
    };
    L.timer = setTimeout(poll, every); L.timer.unref?.(); save();
    return { userCode: L.userCode, uri: L.uri, expiresAt: L.expiresAt };
  }

  // ---------------------------------------------------------------- Discord
  const discord = createDiscord({ webhook: () => C().discord.webhook, username: () => C().discord.username, fetch, gapMs: discordGapMs, onChange: tell });
  const unScene = core.onScene?.(sc => { if (C().discord.scenes) discord.post(`🎛️ Scene: **${sc.name}**`); });
  function nowPlayingText() {
    const rt = runtime.rt; if (rt.song?.playing) return rt.song.name;
    const np = rt.nowPlaying?.info?.(); if (np && np.title && np.playing !== false) return np.artist ? `${np.artist} – ${np.title}` : np.title;
    if (rt.mem?.lock && rt.source !== "idle") return rt.mem.lock.name; return null;
  }
  let npSeen = null, npSeenN = 0, npPosted = null;
  const npTimer = setInterval(() => { try {
    const t = nowPlayingText(); if (t !== npSeen) { npSeen = t; npSeenN = 0; return; } if (++npSeenN !== 1 || !t || t === npPosted) return; // the same for two readings in a row (skipping through songs doesn't post each)
    npPosted = t; if (C().discord.nowPlaying) discord.post(`🎵 Now playing: **${t}**`);
  } catch {} }, pollMs); npTimer.unref?.();

  // ---------------------------------------------------------------- settings
  function view() {
    const c = C(), o = c.obs, t = c.twitch, d = c.discord;
    return {
      obs: { enabled: o.enabled, url: o.url, hasPassword: !!o.password, sceneMap: o.sceneMap, onStreamStart: o.onStreamStart, onStreamStop: o.onStreamStop, onRecordStart: o.onRecordStart, tally: o.tally, status: obs ? obs.status() : null },
      games: Object.fromEntries(Object.keys(GAMES).map(g => [g, { ...c.games[g], name: GAMES[g].name, file: GAMES[g].file, folder: GAMES[g].folder, status: games.status(g) }])),
      twitch: { chat: t.chat, status: chat ? chat.status() : null, last: lastChat, clientId: t.clientId, eventsOn: t.eventsOn, target: t.target, events: t.events,
        auth: t.auth ? { login: t.auth.login, scopes: t.auth.scopes } : null, login: login ? { userCode: login.userCode, uri: login.uri, expiresAt: login.expiresAt, error: login.error } : null,
        eventsub: sub ? sub.status() : null, lastEvent, scopes: SCOPES, commands: COMMANDS },
      discord: { hasWebhook: !!d.webhook, webhook: maskWebhook(d.webhook), nowPlaying: d.nowPlaying, scenes: d.scenes, twitch: d.twitch, username: d.username, status: discord.status() },
      docs: { tryIt: !!c.docs.tryIt, origins: DOCS_ORIGINS },
      streamdeck: { available: existsSync(path.join(root, PLUGIN_DIR)), download: "/api/integrations/streamdeck/plugin", releases: RELEASES, uuid: PLUGIN_UUID },
      runtime: { node: process.version, websocket: typeof globalThis.WebSocket === "function" ? "built-in" : "tiny" },
    };
  }
  const target = (v, what) => { const s = String(v); if (!TARGET.test(s)) throw bad(`${what} is all, off, zone:<id> or dev:<id>`); return s; };
  const sceneId = (v, what) => { if (v === "" || v == null) return ""; const s = String(v); if (!data().scenes.some(x => x.id === s)) throw bad(`${what}: no such scene`); return s; };
  const num = (v, lo, hi) => { const x = Number(v); if (!Number.isFinite(x)) throw bad("Not a number"); return Math.max(lo, Math.min(hi, x)); };
  function cleanReaction(r, what) {
    if (!r || typeof r !== "object" || !REACTIONS.includes(r.type)) throw bad(`${what}: the reaction is one of ${REACTIONS.join(", ")}`);
    const o = { type: r.type };
    if (["flash", "color"].includes(r.type) && r.color !== undefined) { if (!hexOk(r.color)) throw bad(`${what}: colours look like #9146ff`); o.color = r.color.toLowerCase(); }
    if (r.type === "color" && !o.color) o.color = "#ffffff";
    if (["color", "strobe"].includes(r.type)) o.seconds = num(r.seconds ?? (r.type === "strobe" ? 3 : 6), 1, r.type === "strobe" ? 10 : 60);
    if (r.type === "scene") o.scene = sceneId(r.scene, what) || (() => { throw bad(`${what}: pick a scene`); })();
    if (r.type === "effect") { if (!runtime.effects.list.some(e => e.id === r.effect)) throw bad(`${what}: unknown effect`); o.effect = r.effect; }
    if (r.minBits !== undefined) o.minBits = Math.round(num(r.minBits, 1, 1e6));
    return o;
  }
  function patchObs(b) {
    const o = C().obs;
    if (b.url !== undefined) { const u = String(b.url).trim(); if (!/^wss?:\/\/[^\s/]+(\/\S*)?$/.test(u)) throw bad("OBS's address looks like ws://127.0.0.1:4455"); o.url = u; }
    if (b.password) o.password = String(b.password).slice(0, 200); if (b.clearPassword) o.password = "";
    if (b.enabled !== undefined) o.enabled = !!b.enabled;
    for (const k of ["onStreamStart", "onStreamStop", "onRecordStart"]) if (b[k] !== undefined) o[k] = sceneId(b[k], k);
    if (b.sceneMap !== undefined) { if (!Array.isArray(b.sceneMap)) throw bad("sceneMap is a list of {obs, scene}");
      o.sceneMap = b.sceneMap.slice(0, 50).filter(r => r && String(r.obs || "").trim()).map(r => ({ obs: String(r.obs).trim().slice(0, 100), scene: sceneId(r.scene, `OBS scene “${r.obs}”`) })).filter(r => r.scene); }
    if (b.tally) { const t = o.tally; if (b.tally.enabled !== undefined) t.enabled = !!b.tally.enabled;
      if (b.tally.when !== undefined) { if (!["recording", "streaming", "either"].includes(b.tally.when)) throw bad("The tally is on when recording, streaming or either"); t.when = b.tally.when; }
      if (b.tally.target !== undefined) t.target = target(b.tally.target, "The tally's zone"); if (b.tally.color !== undefined) { if (!hexOk(b.tally.color)) throw bad("The tally's colour looks like #ff0000"); t.color = b.tally.color.toLowerCase(); } }
    save(); startObs();
  }
  function patchGame(game, b) {
    const g = C().games[game]; if (!g) throw new HttpError(404, `Unknown game "${game}" (cs2 or dota2)`);
    if (b.enabled !== undefined) { g.enabled = !!b.enabled; if (g.enabled && !g.token) g.token = crypto.randomBytes(16).toString("hex"); }
    if (b.intensity !== undefined) g.intensity = num(b.intensity, 0, 1);
    if (b.mode !== undefined) { if (!["blend", "takeover"].includes(b.mode)) throw bad("mode is blend or takeover"); g.mode = b.mode; }
    for (const k of ["healthTarget", "effectsTarget", "manaTarget", "ambientTarget"]) if (b[k] !== undefined && k in g) g[k] = target(b[k], k);
    for (const k of ["kills", "flashbang", "bomb", "rounds", "roshan", "daynight"]) if (b[k] !== undefined && k in g) g[k] = !!b[k];
    save(); if (!g.enabled) games.reset(game);
  }
  function patchTwitch(b) {
    const t = tw();
    if (b.chat) { const c = t.chat, x = b.chat;
      if (x.channel !== undefined) { const ch = String(x.channel).trim().toLowerCase().replace(/^https?:\/\/(www\.)?twitch\.tv\//, "").replace(/^#/, "").replace(/\/.*$/, ""); if (ch && !/^[a-z0-9_]{3,25}$/.test(ch)) throw bad("A Twitch channel name is 3 to 25 letters, digits or _"); c.channel = ch; }
      if (x.enabled !== undefined) c.enabled = !!x.enabled; if (c.enabled && !c.channel) throw bad("Enter your Twitch channel name");
      if (x.prefix !== undefined) { const p = String(x.prefix).trim(); if (!/^[!#$%&*+.?~-]$/.test(p)) throw bad("The command prefix is one character like !"); c.prefix = p; }
      if (x.who !== undefined) { if (!["everyone", "subscriber", "vip", "mod"].includes(x.who)) throw bad("Who may use commands: everyone, subscriber, vip or mod"); c.who = x.who; }
      if (x.cooldownSec !== undefined) c.cooldownSec = Math.round(num(x.cooldownSec, 0, 3600)); if (x.userCooldownSec !== undefined) c.userCooldownSec = Math.round(num(x.userCooldownSec, 0, 3600));
      if (x.strobeSec !== undefined) c.strobeSec = num(x.strobeSec, 1, 10); if (x.colorSec !== undefined) c.colorSec = num(x.colorSec, 1, 60);
      if (x.commands) for (const k of COMMANDS) if (x.commands[k] !== undefined) c.commands[k] = !!x.commands[k];
      if (x.scenes !== undefined) { if (!Array.isArray(x.scenes)) throw bad("scenes is a list of scene ids"); c.scenes = x.scenes.map(String).filter(id => data().scenes.some(s => s.id === id)); }
      if (x.effects !== undefined) { if (!Array.isArray(x.effects)) throw bad("effects is a list of effect ids"); c.effects = x.effects.map(String).filter(id => runtime.effects.list.some(e => e.id === id)); } }
    if (b.clientId !== undefined) { const id = String(b.clientId).trim(); if (id && !/^[a-z0-9]{20,40}$/i.test(id)) throw bad("A Twitch Client ID is about 30 letters and digits, from dev.twitch.tv/console"); if (id !== t.clientId) { t.auth = null; t.clientId = id; } }
    if (b.eventsOn !== undefined) t.eventsOn = !!b.eventsOn;
    if (b.target !== undefined) t.target = target(b.target, "The zone for colours");
    if (b.events) for (const k of Object.keys(EVENT_TYPES)) if (b.events[k] !== undefined) t.events[k] = cleanReaction(b.events[k], k);
    save(); startChat(); startSub();
  }
  function patchDiscord(b) {
    const d = C().discord;
    if (b.webhook !== undefined) { const u = String(b.webhook).trim(); if (u && !isWebhook(u)) throw bad("Paste the webhook address Discord shows (https://discord.com/api/webhooks/…)"); d.webhook = u; }
    for (const k of ["nowPlaying", "scenes", "twitch"]) if (b[k] !== undefined) d[k] = !!b[k];
    if (b.username !== undefined) d.username = String(b.username).trim().slice(0, 40) || "Tempolight";
    save();
  }

  // ---------------------------------------------------------------- routes
  const R = core.route, wrap = fn => async (ctx, p) => { try { return await fn(ctx, p); } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(e.code >= 400 && e.code < 600 ? e.code : 400, e.message); } };
  R("GET", "/api/integrations", "admin", () => view());
  R("PATCH", "/api/integrations/obs", "admin", wrap(ctx => { patchObs(ctx.body || {}); return view().obs; }));
  R("PATCH", "/api/integrations/games/:game", "admin", wrap((ctx, p) => { patchGame(p.game, ctx.body || {}); return view().games[p.game]; }));
  R("POST", "/api/integrations/games/:game/token", "admin", wrap((ctx, p) => { const g = C().games[p.game]; if (!g) throw new HttpError(404, "Unknown game"); g.token = crypto.randomBytes(16).toString("hex"); save(); note(`${GAMES[p.game].name}: a new game token was made; download the config file again`); return { token: g.token }; }));
  R("GET", "/api/integrations/games/:game/cfg", "admin", wrap((ctx, p) => {
    const g = C().games[p.game]; if (!g) throw new HttpError(404, "Unknown game"); if (!g.token) { g.token = crypto.randomBytes(16).toString("hex"); save(); }
    const url = String(ctx.query?.url || "").trim(); if (!/^https?:\/\/[^\s/]+$/.test(url)) throw bad("url is Tempolight's address as the game's computer reaches it, like http://127.0.0.1:8080");
    return { filename: GAMES[p.game].file, folder: GAMES[p.game].folder, content: gsiConfig(p.game, { url, token: g.token }) }; }));
  R("POST", "/api/integrations/games/:game/test", "admin", wrap((ctx, p) => { if (!C().games[p.game]) throw new HttpError(404, "Unknown game"); if (!C().games[p.game].enabled) throw bad(`Turn ${GAMES[p.game].name} on first`); return games.test(p.game, String(ctx.body?.what || "")); }));
  // the games post here: open, but only with the token from their config file; a few dozen a second at most
  const gsiRate = new Map(); let badTokens = [];
  R("POST", "/api/gsi/:game", null, (ctx, p) => {
    const g = C().games[p.game]; if (!g) throw new HttpError(404, "Unknown game (cs2 or dota2)");
    const t = now(); badTokens = badTokens.filter(x => t - x < 60000); if (badTokens.length >= 30) throw new HttpError(429, "Too many wrong tokens: wait a minute");
    const tok = ctx.body?.auth?.token; if (!g.token || !same(tok || "", g.token)) { badTokens.push(t); throw new HttpError(403, "Wrong or missing game token: download the config file again from Tempolight's Integrations page"); }
    const r = (gsiRate.get(p.game) || []).filter(x => t - x < 1000); if (r.length >= 40) throw new HttpError(429, "Too many updates"); r.push(t); gsiRate.set(p.game, r);
    if (!g.enabled) return { ok: true, off: true };
    const ev = games.ingest(p.game, ctx.body);
    for (const e of ev) if (["round_won", "round_lost", "bomb_planted", "roshan_killed", "match_won", "match_lost"].includes(e.type)) note(`${GAMES[p.game].name}: ${e.type.replace(/_/g, " ")}`);
    return { ok: true };
  });
  R("PATCH", "/api/integrations/twitch", "admin", wrap(ctx => { patchTwitch(ctx.body || {}); return view().twitch; }));
  R("POST", "/api/integrations/twitch/login", "admin", wrap(async ctx => startLogin(ctx.body?.clientId)));
  R("DELETE", "/api/integrations/twitch/login", "admin", wrap(() => { if (login) clearTimeout(login.timer); login = null; tw().auth = null; save(); startSub(); note("Twitch: signed out"); return view().twitch; }));
  R("POST", "/api/integrations/twitch/test", "admin", wrap(ctx => { const k = String(ctx.body?.kind || ""); const r = tw().events[k]; if (!r) throw bad("kind is follow, subscribe, resub, gift, raid or cheer"); react({ ...r, target: tw().target }, "Twitch test"); return { ok: true }; }));
  R("PATCH", "/api/integrations/discord", "admin", wrap(ctx => { patchDiscord(ctx.body || {}); return view().discord; }));
  R("PATCH", "/api/integrations/docs", "admin", wrap(ctx => { const b = ctx.body || {};
    if (b.tryIt !== undefined) { if (typeof b.tryIt !== "boolean") throw bad("tryIt is true or false"); C().docs.tryIt = b.tryIt; save(); note(b.tryIt ? "The docs site may now try API calls here" : "The docs site can no longer try API calls"); }
    return view().docs; }));
  R("POST", "/api/integrations/discord/test", "admin", wrap(async () => discord.test(`✅ Tempolight is connected${nowPlayingText() ? `. Now playing: **${nowPlayingText()}**` : ""}`)));

  /** The plugin's download: a file, not JSON. True when it handled the request. */
  async function handleHttp(req, res, url) {
    if (req.method !== "GET" || url.pathname !== "/api/integrations/streamdeck/plugin") return false;
    const buf = packFolder(path.join(root, PLUGIN_DIR));
    if (!buf) { res.writeHead(302, { location: RELEASES }); res.end(); return true; }
    res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${PLUGIN_UUID}.streamDeckPlugin"`, "content-length": buf.length, "cache-control": "no-store" }); res.end(buf);
    return true;
  }

  function restart() { obsKey = ""; chatKey = ""; subKey = ""; C(); startObs(); startChat(); startSub(); }
  const unChange = core.onChange?.(w => { if (w === "all") restart(); }); void unChange;
  startObs(); startChat(); startSub();
  /** Is this Origin the docs site, and may it call the API (the "Try it" panel)? */
  const docsOrigin = origin => !!origin && C().docs.tryIt === true && DOCS_ORIGINS.includes(String(origin).toLowerCase());
  return { handleHttp, docsOrigin, view, games, react, layers, discord, get obs() { return obs; }, get chat() { return chat; }, get eventsub() { return sub; },
    close() { obs?.close(); chat?.close(); sub?.close(); discord.close(); clearInterval(npTimer); clearTimeout(strobeTimer); clearTimeout(tellTimer); if (login) clearTimeout(login.timer); if (typeof unScene === "function") unScene();
      if (D().settings.post === post) D().settings.post = prevPost; } };
}
