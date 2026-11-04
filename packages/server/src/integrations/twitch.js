// Twitch: chat commands and channel events.
//
// Chat is read anonymously over Twitch's IRC-over-WebSocket (wss://irc-ws.chat.twitch.tv:443) as "justinfan12345":
// no account, no token, read-only. Messages carry IRCv3 tags (badges, mod, vip, display-name), so commands like
// "!scene party", "!effect laser" or "!flash red" can be limited to mods or VIPs, with cooldowns and a list of the
// commands that are allowed.
//
// Follows, subs, gifted subs, raids and cheers need EventSub, which needs a user token. Tempolight gets one with the
// device-code flow (no client secret, no redirect address): the streamer makes a Twitch application of their own
// (dev.twitch.tv/console, "Public" client type), pastes its Client ID, and enters the code Tempolight shows at
// twitch.tv/activate. The token stays in Tempolight's settings file and is never sent to a browser.
import { openWebSocket } from "./ws-client.js";

export const IRC_URL = "wss://irc-ws.chat.twitch.tv:443";
export const EVENTSUB_URL = "wss://eventsub.wss.twitch.tv/ws";
export const ID_BASE = "https://id.twitch.tv", HELIX = "https://api.twitch.tv/helix";
export const SCOPES = ["moderator:read:followers", "channel:read:subscriptions", "bits:read"];
// the events Tempolight subscribes to, and what each needs in its condition
export const EVENT_TYPES = {
  follow: { type: "channel.follow", version: "2", cond: id => ({ broadcaster_user_id: id, moderator_user_id: id }) },
  subscribe: { type: "channel.subscribe", version: "1", cond: id => ({ broadcaster_user_id: id }) },
  resub: { type: "channel.subscription.message", version: "1", cond: id => ({ broadcaster_user_id: id }) },
  gift: { type: "channel.subscription.gift", version: "1", cond: id => ({ broadcaster_user_id: id }) },
  raid: { type: "channel.raid", version: "1", cond: id => ({ to_broadcaster_user_id: id }) },
  cheer: { type: "channel.cheer", version: "1", cond: id => ({ broadcaster_user_id: id }) },
};
const BY_TYPE = Object.fromEntries(Object.entries(EVENT_TYPES).map(([k, v]) => [v.type, k]));
export const COMMANDS = ["scene", "effect", "flash", "strobe", "drop", "color"];
export const COLOR_NAMES = { red: "#ff0000", green: "#00ff00", blue: "#0040ff", white: "#ffffff", yellow: "#ffd000", orange: "#ff7000", purple: "#9146ff", pink: "#ff3fa4", cyan: "#00e5ff", magenta: "#ff00ff", gold: "#ffb700", teal: "#00c2a8", lime: "#9dff00", violet: "#8f00ff", warm: "#ffb070", ice: "#a8e8ff" };

// ---------------------------------------------------------------- IRC
const unescapeTag = v => v.replace(/\\(.)/g, (_, c) => ({ s: " ", ":": ";", "\\": "\\", r: "\r", n: "\n" }[c] ?? c));
/** One IRC line: {tags, prefix, nick, command, params, text}. */
export function parseIrc(line) {
  let s = String(line).replace(/\r?\n$/, ""), tags = {}, prefix = null;
  if (s.startsWith("@")) { const i = s.indexOf(" "); for (const kv of s.slice(1, i).split(";")) { const j = kv.indexOf("="); if (j < 0) tags[kv] = ""; else tags[kv.slice(0, j)] = unescapeTag(kv.slice(j + 1)); } s = s.slice(i + 1); }
  if (s.startsWith(":")) { const i = s.indexOf(" "); prefix = s.slice(1, i); s = s.slice(i + 1); }
  let text = null; const k = s.indexOf(" :"); if (k >= 0) { text = s.slice(k + 2); s = s.slice(0, k); }
  const [command, ...params] = s.split(" ").filter(Boolean);
  return { tags, prefix, nick: prefix && prefix.includes("!") ? prefix.slice(0, prefix.indexOf("!")) : null, command: command || "", params, text };
}
/** Who wrote it: broadcaster, mod, vip, subscriber, everyone (the highest that applies). */
export function roleOf(tags) {
  const b = String(tags.badges || "").split(",").map(x => x.split("/")[0]);
  if (b.includes("broadcaster")) return "broadcaster";
  if (tags.mod === "1" || b.includes("moderator")) return "mod";
  if (tags.vip === "1" || b.includes("vip")) return "vip";
  if (tags.subscriber === "1" || b.includes("subscriber") || b.includes("founder")) return "subscriber";
  return "everyone";
}
const RANK = { everyone: 0, subscriber: 1, vip: 2, mod: 3, broadcaster: 4 };

export const CHAT_DEFAULTS = () => ({ enabled: false, channel: "", prefix: "!", who: "everyone", cooldownSec: 10, userCooldownSec: 30, commands: { scene: true, effect: true, flash: true, strobe: false, drop: false, color: true }, scenes: [], effects: [], strobeSec: 3, colorSec: 8 });

const norm = s => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
/** A colour from chat: a name or #rrggbb. */
export function chatColor(word) { const w = String(word || "").trim().toLowerCase(); if (!w) return null; if (COLOR_NAMES[w]) return COLOR_NAMES[w]; const m = /^#?([0-9a-f]{6})$/.exec(w); return m ? "#" + m[1] : null; }

/**
 * Decides what a chat message does (nothing, most of the time). Keeps the cooldowns in `memo`.
 * @param {{text:string, user:string, role:string}} msg @param {object} cfg CHAT_DEFAULTS' shape
 * @param {{scenes:{id:string,name:string}[], effects:{id:string,name:string}[], safe?:boolean}} ctx
 * @param {{last:Map<string,number>, users:Map<string,number>}} memo @param {number} now ms
 * @returns {null|{ok:false, why:string, cmd:string}|{ok:true, cmd:string, action:object}}
 */
export function chatCommand(msg, cfg, ctx, memo, now) {
  const pre = cfg.prefix || "!", text = String(msg.text || "").trim(); if (!text.startsWith(pre)) return null;
  const [word, ...rest] = text.slice(pre.length).split(/\s+/), cmd = String(word || "").toLowerCase(), arg = rest.join(" ").trim();
  const alias = { colour: "color", fx: "effect", sc: "scene" }[cmd] || cmd;
  if (!COMMANDS.includes(alias)) return null; // not ours: say nothing (other bots use ! too)
  if (!cfg.commands?.[alias]) return { ok: false, cmd: alias, why: "off" };
  const role = msg.role || "everyone", rank = RANK[role] ?? 0;
  if (rank < (RANK[cfg.who] ?? 0)) return { ok: false, cmd: alias, why: "role" };
  if (role !== "broadcaster") { // the streamer is never held back
    if (memo.last.has(alias) && now - memo.last.get(alias) < (Number(cfg.cooldownSec) || 0) * 1000) return { ok: false, cmd: alias, why: "cooldown" };
    if (rank < RANK.mod && memo.users.has(msg.user) && now - memo.users.get(msg.user) < (Number(cfg.userCooldownSec) || 0) * 1000) return { ok: false, cmd: alias, why: "user-cooldown" };
  }
  let action = null;
  if (alias === "scene") { const allowed = cfg.scenes?.length ? ctx.scenes.filter(s => cfg.scenes.includes(s.id)) : ctx.scenes, q = norm(arg);
    if (!q) return { ok: false, cmd: alias, why: "missing" };
    const sc = allowed.find(s => norm(s.name) === q || s.id === arg) || allowed.find(s => norm(s.name).split(" ")[0] === q.split(" ")[0]) || allowed.find(s => norm(s.name).includes(q));
    if (!sc) return { ok: false, cmd: alias, why: "unknown" }; action = { type: "scene", scene: sc.id, name: sc.name }; }
  else if (alias === "effect") { const allowed = cfg.effects?.length ? ctx.effects.filter(e => cfg.effects.includes(e.id)) : ctx.effects, q = norm(arg);
    if (!q) return { ok: false, cmd: alias, why: "missing" };
    const fx = allowed.find(e => e.id === arg.toLowerCase() || norm(e.name) === q) || allowed.find(e => norm(e.name).includes(q) || e.id.includes(q.replace(/ /g, "")));
    if (!fx) return { ok: false, cmd: alias, why: "unknown" }; action = { type: "effect", effect: fx.id, name: fx.name }; }
  else if (alias === "flash") { const c = arg ? chatColor(arg.split(/\s+/)[0]) : null; if (arg && !c) return { ok: false, cmd: alias, why: "unknown" }; action = { type: "flash", color: c || undefined }; }
  else if (alias === "color") { const c = chatColor(arg.split(/\s+/)[0]); if (!c) return { ok: false, cmd: alias, why: arg ? "unknown" : "missing" }; action = { type: "color", color: c, seconds: Number(cfg.colorSec) || 8 }; }
  else if (alias === "strobe") { if (ctx.safe) return { ok: false, cmd: alias, why: "safe" }; action = { type: "strobe", seconds: Math.max(1, Math.min(10, Number(cfg.strobeSec) || 3)) }; }
  else if (alias === "drop") action = { type: "drop" };
  memo.last.set(alias, now); memo.users.set(msg.user, now);
  if (memo.users.size > 5000) memo.users.clear();
  return { ok: true, cmd: alias, action };
}

/**
 * Reads a channel's chat. onMessage({user, display, role, text, tags}) for every chat line.
 * @param {{channel:string, url?:string, open?:Function, onMessage:Function, onChange?:Function, retryMs?:number}} o
 */
export function createTwitchChat({ channel, url = IRC_URL, open = openWebSocket, onMessage, onChange = () => {}, retryMs = 2000 }) {
  const ch = String(channel).toLowerCase().replace(/^#/, "").trim();
  const st = { connected: false, joined: false, channel: ch, error: null, messages: 0 };
  let sock = null, stopped = false, timer = null, wait = retryMs, buf = "";
  const tell = () => { try { onChange({ ...st }); } catch {} };
  const send = l => { try { sock?.send(l + "\r\n"); } catch {} };
  function connect() {
    if (stopped) return; let s; try { s = open(url); } catch (e) { st.error = e.message; tell(); return later(); }
    sock = s; buf = "";
    s.onopen = () => { send("CAP REQ :twitch.tv/tags twitch.tv/commands"); send("PASS SCHMOOPIIE"); send(`NICK justinfan${10000 + Math.floor(Math.random() * 89999)}`); send(`JOIN #${ch}`); st.connected = true; st.error = null; tell(); };
    s.onmessage = e => { if (typeof e.data !== "string") return; buf += e.data; const lines = buf.split("\r\n"); buf = lines.pop(); for (const l of lines) if (l) line(l); };
    s.onerror = e => { st.error = e?.message || "Couldn't connect to Twitch chat"; };
    s.onclose = () => { if (sock !== s) return; sock = null; st.connected = false; st.joined = false; tell(); later(); };
  }
  function later() { if (stopped) return; clearTimeout(timer); timer = setTimeout(connect, wait); timer.unref?.(); wait = Math.min(60000, wait * 2); }
  function line(l) {
    const m = parseIrc(l);
    if (m.command === "PING") return send(`PONG :${m.text ?? "tmi.twitch.tv"}`);
    if (m.command === "RECONNECT") { try { sock?.close(); } catch {} return; }
    if (m.command === "JOIN" || m.command === "ROOMSTATE") { if (!st.joined) { st.joined = true; wait = retryMs; tell(); } return; }
    if (m.command === "NOTICE" && /Login unsuccessful|Improperly formatted/i.test(m.text || "")) { st.error = m.text; tell(); return; }
    if (m.command !== "PRIVMSG" || m.text == null) return;
    st.messages++;
    const user = m.tags["user-id"] || m.nick || "?", display = m.tags["display-name"] || m.nick || "someone";
    let text = m.text; if (text.startsWith("\u0001ACTION ")) text = text.slice(8).replace(/\u0001$/, ""); // /me
    try { onMessage({ user, display, role: roleOf(m.tags), text, tags: m.tags }); } catch {}
  }
  connect();
  return { status: () => ({ ...st }), close() { stopped = true; clearTimeout(timer); const s = sock; sock = null; try { s?.close(); } catch {} } };
}

// ---------------------------------------------------------------- sign-in: the device-code flow
/**
 * @param {{clientId:string, fetch?:Function, idBase?:string}} o
 */
export function twitchAuth({ clientId, fetch = globalThis.fetch, idBase = ID_BASE }) {
  const form = o => new URLSearchParams(o).toString(), H = { "content-type": "application/x-www-form-urlencoded" };
  const json = async r => { let j = {}; try { j = await r.json(); } catch {} return j; };
  return {
    /** Starts a sign-in: {device_code, user_code, verification_uri, interval, expires_in}. */
    async start(scopes = SCOPES) {
      const r = await fetch(`${idBase}/oauth2/device`, { method: "POST", headers: H, body: form({ client_id: clientId, scopes: scopes.join(" ") }) }), j = await json(r);
      if (!r.ok) throw Object.assign(new Error(j.message ? `Twitch: ${j.message}` : `Twitch answered ${r.status}`), { code: 400 }); return j;
    },
    /** One poll: {pending:true}, {slow:true} or the token {access_token, refresh_token, expires_in, scope}. Throws when it expired or was refused. */
    async poll(deviceCode, scopes = SCOPES) {
      const r = await fetch(`${idBase}/oauth2/token`, { method: "POST", headers: H, body: form({ client_id: clientId, scopes: scopes.join(" "), device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }) }), j = await json(r);
      if (r.ok && j.access_token) return j;
      const m = String(j.message || "").toLowerCase(); if (m.includes("pending")) return { pending: true }; if (m.includes("slow")) return { slow: true };
      throw new Error(m.includes("expired") || m.includes("invalid device") ? "The code expired: start again" : `Twitch refused the sign-in (${j.message || r.status})`);
    },
    async refresh(refreshToken) {
      const r = await fetch(`${idBase}/oauth2/token`, { method: "POST", headers: H, body: form({ client_id: clientId, grant_type: "refresh_token", refresh_token: refreshToken }) }), j = await json(r);
      if (!r.ok || !j.access_token) throw new Error(`Twitch didn't renew the sign-in (${j.message || r.status}): connect again`); return j;
    },
    /** {login, user_id, scopes, expires_in} for a token, or null when it's no longer valid. */
    async validate(token) { const r = await fetch(`${idBase}/oauth2/validate`, { headers: { authorization: `OAuth ${token}` } }); if (r.status === 401) return null; const j = await json(r); if (!r.ok) throw new Error(`Twitch answered ${r.status}`); return j; },
  };
}

// ---------------------------------------------------------------- EventSub over WebSocket
/**
 * @param {{token:()=>Promise<string>, clientId:string, userId:string, events:string[], fetch?:Function, url?:string, helix?:string,
 *   open?:Function, onEvent:(kind:string, event:object)=>void, onChange?:Function, retryMs?:number}} o
 *   events: the keys of EVENT_TYPES to subscribe to
 */
export function createEventSub({ token, clientId, userId, events, fetch = globalThis.fetch, url = EVENTSUB_URL, helix = HELIX, open = openWebSocket, onEvent, onChange = () => {}, retryMs = 2000 }) {
  const st = { connected: false, session: null, subscribed: [], failed: [], error: null, events: 0 };
  let sock = null, stopped = false, timer = null, wait = retryMs, keep = null, keepMs = 15000, last = 0;
  const seen = new Set();
  const tell = () => { try { onChange({ ...st }); } catch {} };
  function connect(to = url, reconnecting = false) {
    if (stopped) return; let s; try { s = open(to); } catch (e) { st.error = e.message; tell(); return later(); }
    const old = sock; sock = s; s._old = reconnecting ? old : null;
    s.onmessage = e => { if (typeof e.data !== "string") return; let m; try { m = JSON.parse(e.data); } catch { return; } last = Date.now(); message(s, m); };
    s.onerror = e => { st.error = e?.message || "Couldn't connect to Twitch EventSub"; };
    s.onclose = e => { if (sock !== s) return; sock = null; st.connected = false; clearInterval(keep);
      if (e?.code === 4003 || e?.code === 4004) st.error = "Twitch closed EventSub (no subscriptions in time)"; tell(); later(); };
  }
  function later() { if (stopped) return; clearTimeout(timer); timer = setTimeout(() => connect(), wait); timer.unref?.(); wait = Math.min(60000, wait * 2); }
  async function message(s, m) {
    const type = m.metadata?.message_type, p = m.payload || {};
    if (type === "session_welcome") {
      if (s._old) { try { s._old.close(); } catch {} s._old = null; st.session = p.session.id; st.connected = true; tell(); return; } // after a reconnect the subscriptions carry over
      st.session = p.session?.id; st.connected = true; st.error = null; wait = retryMs; keepMs = ((p.session?.keepalive_timeout_seconds || 10) + 5) * 1000; last = Date.now();
      clearInterval(keep); keep = setInterval(() => { if (Date.now() - last > keepMs && sock === s) { try { s.close(); } catch {} } }, 1000); keep.unref?.();
      await subscribe(st.session); tell();
    } else if (type === "session_reconnect") connect(p.session?.reconnect_url, true);
    else if (type === "notification") {
      const id = m.metadata?.message_id; if (id) { if (seen.has(id)) return; seen.add(id); if (seen.size > 500) seen.clear(); }
      const kind = BY_TYPE[p.subscription?.type]; if (!kind) return; st.events++; tell();
      try { onEvent(kind, p.event || {}); } catch {}
    } else if (type === "revocation") { st.failed.push(`${p.subscription?.type}: ${p.subscription?.status}`); tell(); }
  }
  async function subscribe(session) {
    st.subscribed = []; st.failed = [];
    const tok = await token().catch(e => { st.error = e.message; return null; }); if (!tok) return;
    await Promise.all(events.filter(k => EVENT_TYPES[k]).map(async k => { const e = EVENT_TYPES[k];
      try { const r = await fetch(`${helix}/eventsub/subscriptions`, { method: "POST", headers: { authorization: `Bearer ${tok}`, "client-id": clientId, "content-type": "application/json" },
          body: JSON.stringify({ type: e.type, version: e.version, condition: e.cond(userId), transport: { method: "websocket", session_id: session } }) });
        if (r.ok || r.status === 409) st.subscribed.push(k); else { let j = {}; try { j = await r.json(); } catch {} st.failed.push(`${k}: ${j.message || r.status}`); } }
      catch (err) { st.failed.push(`${k}: ${err.message}`); } }));
  }
  connect();
  return { status: () => ({ ...st }), close() { stopped = true; clearTimeout(timer); clearInterval(keep); const s = sock; sock = null; try { s?.close(); } catch {} } };
}

/** A short line for an event: "alice followed", "bob raided with 25 viewers". */
export function eventText(kind, e) {
  const who = e.user_name || e.from_broadcaster_user_name || (e.is_anonymous ? "Someone" : "Someone");
  if (kind === "follow") return `${who} followed`;
  if (kind === "subscribe") return `${who} subscribed${e.tier ? ` (tier ${String(e.tier)[0]})` : ""}`;
  if (kind === "resub") return `${who} resubscribed (${e.cumulative_months || "?"} months)`;
  if (kind === "gift") return `${e.is_anonymous ? "Someone" : who} gifted ${e.total || 1} sub${(e.total || 1) > 1 ? "s" : ""}`;
  if (kind === "raid") return `${e.from_broadcaster_user_name || who} raided with ${e.viewers || 0} viewers`;
  if (kind === "cheer") return `${e.is_anonymous ? "Someone" : who} cheered ${e.bits || 0} bits`;
  return kind;
}
