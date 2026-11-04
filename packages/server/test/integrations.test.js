// Integrations against pretend services: a fake obs-websocket 5 server (password sign-in, requests, events), CS2 and
// Dota 2 Game State Integration posts (fixtures/gsi, shaped like what the games send), a fake Twitch IRC server
// (PRIVMSG with tags, PING), a fake EventSub WebSocket and Twitch/Discord HTTP APIs behind a fake fetch.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { createApp } from "../src/app.js";
import { attachWebSocket } from "../src/ws.js";
import { TinyWebSocket, openWebSocket } from "../src/integrations/ws-client.js";
import { obsAuth } from "../src/integrations/obs.js";
import { createGames, healthColor, bombBeeps, gsiConfig, BOMB_SECONDS } from "../src/integrations/games.js";
import { parseIrc, roleOf, chatCommand, CHAT_DEFAULTS, chatColor, SCOPES } from "../src/integrations/twitch.js";
import { isWebhook, maskWebhook } from "../src/integrations/discord.js";
import { zip, unzip, crc32 } from "../src/integrations/zip.js";
import { topLevelLines } from "../../../scripts/bundle.js";
import { startFakeWled } from "../../../scripts/fake-wled.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 5000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(30); } return false; }
const fixture = (f, token = "") => JSON.parse(readFileSync(new URL(`./fixtures/gsi/${f}`, import.meta.url), "utf8").replace("__TOKEN__", token));
async function setup(opts = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tl-int-")), app = await createApp({ dataDir: dir, discover: false, logger: null, ...opts });
  const port = await app.listen(0, "127.0.0.1"), base = `http://127.0.0.1:${port}`;
  const call = async (method, p, body, headers = {}) => { const r = await fetch(base + p, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }); let j = null; try { j = await r.json(); } catch {} return { status: r.status, body: j }; };
  return { app, base, port, call, dir, lights: null, async done() { await app.close(); this.lights?.close(); rmSync(dir, { recursive: true, force: true }); } };
}
/** A WebSocket server on a free port: onConnect(client) like ws.js. */
async function wsServer(onConnect) {
  const srv = http.createServer((q, s) => { s.writeHead(404); s.end(); }), clients = attachWebSocket(srv, "/", onConnect);
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  return { url: `ws://127.0.0.1:${srv.address().port}`, clients, close: () => { for (const c of clients) c.close(); return new Promise(r => srv.close(r)); } };
}
const res = (status, body) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const meanRGB = f => { let r = 0, g = 0, b = 0; for (let i = 0; i < f.length; i += 3) { r += f[i]; g += f[i + 1]; b += f[i + 2]; } const n = f.length / 3; return [r / n, g / n, b / n]; };
async function withLights(s) { // a fake WLED in the room, so the colours on the lights can be checked
  const w = await startFakeWled({ leds: 60 }), d = await s.call("POST", "/api/devices", { host: w.host }); await s.call("PATCH", `/api/devices/${d.body.id}`, { ddpPort: w.ddpPort });
  await until(() => w.frames > 5); s.lights = w; return w;
}

// ---------------------------------------------------------------- the WebSocket client
test("ws client: the small client talks to a WebSocket server (text, big frames, ping, close), and both copies are the same file", async () => {
  const srv = await wsServer(c => { c.onmessage = m => { if (m === "ping-me") { c.frame(0x9, Buffer.from("hi")); c.send("pinged"); } else if (m === "bye") c.close(4001); else c.send("echo:" + m); }; });
  try {
    const s = new TinyWebSocket(srv.url), got = []; let closed = null;
    s.onmessage = e => got.push(e.data); s.onclose = e => { closed = e; };
    assert.ok(await until(() => s.readyState === 1)); s.send("hello"); const big = "x".repeat(70000); s.send(big); s.send("ping-me");
    assert.ok(await until(() => got.length >= 3)); assert.deepEqual(got, ["echo:hello", "echo:" + big, "pinged"]);
    s.send("bye"); assert.ok(await until(() => closed)); assert.equal(closed.code, 4001);
    const bad = new TinyWebSocket("ws://127.0.0.1:1"); let err = null; bad.onclose = e => { err = e; }; assert.ok(await until(() => err)); assert.equal(err.code, 1006);
    assert.throws(() => new TinyWebSocket("http://x"), /Not a WebSocket/);
    const n = openWebSocket(srv.url), seen = []; n.onmessage = e => seen.push(e.data); n.onopen = () => n.send("node"); assert.ok(await until(() => seen.length)); assert.equal(seen[0], "echo:node"); n.close();
  } finally { await srv.close(); }
  const a = readFileSync(new URL("../src/integrations/ws-client.js", import.meta.url), "utf8"), b = readFileSync(new URL("../../../integrations/streamdeck/io.github.d4rkgeek.tempolight.sdPlugin/bin/ws-client.js", import.meta.url), "utf8");
  assert.equal(a, b, "integrations/streamdeck/.../bin/ws-client.js must be a copy of packages/server/src/integrations/ws-client.js");
  // the one-file bundler reads these: each must end at the top level
  for (const f of ["index.js", "games.js", "obs.js", "twitch.js", "discord.js", "zip.js", "ws-client.js"]) { const src = readFileSync(new URL(`../src/integrations/${f}`, import.meta.url), "utf8"), top = topLevelLines(src); assert.equal(top.length, src.split("\n").length, f); assert.equal(top.at(-1), true, f); }
});

// ---------------------------------------------------------------- OBS
function fakeObs({ password = "hunter2" } = {}) {
  const st = { identified: 0, subs: null, scene: "Just Chatting", scenes: ["Just Chatting", "Gaming", "BRB"], streaming: false, recording: true, requests: [], ready: [] };
  const salt = crypto.randomBytes(32).toString("base64");
  return wsServer(c => {
    const challenge = crypto.randomBytes(32).toString("base64");
    c.sendJSON({ op: 0, d: { obsWebSocketVersion: "5.5.4", rpcVersion: 1, ...(password ? { authentication: { challenge, salt } } : {}) } });
    c.onmessage = msg => { const m = JSON.parse(msg);
      if (m.op === 1) { // check the sign-in the way the obs-websocket protocol describes it
        const secret = crypto.createHash("sha256").update(password + salt).digest("base64"), want = crypto.createHash("sha256").update(secret + challenge).digest("base64");
        if (password && m.d.authentication !== want) { c.close(4009); return; }
        st.identified++; st.subs = m.d.eventSubscriptions; st.ready.push(c); c.sendJSON({ op: 2, d: { negotiatedRpcVersion: 1 } }); }
      else if (m.op === 6) { const { requestType, requestId } = m.d; st.requests.push(requestType);
        const data = { GetCurrentProgramScene: { currentProgramSceneName: st.scene, sceneName: st.scene }, GetSceneList: { currentProgramSceneName: st.scene, scenes: st.scenes.map((n, i) => ({ sceneName: n, sceneIndex: st.scenes.length - 1 - i })).reverse() },
          GetStreamStatus: { outputActive: st.streaming }, GetRecordStatus: { outputActive: st.recording } }[requestType];
        c.sendJSON({ op: 7, d: { requestType, requestId, requestStatus: data ? { result: true, code: 100 } : { result: false, code: 204, comment: "unknown" }, responseData: data } }); } };
  }).then(s => Object.assign(s, { st, emit: (eventType, eventData) => { for (const c of st.ready) if (c.open) c.sendJSON({ op: 5, d: { eventType, eventIntent: 4, eventData } }); } }));
}

test("OBS: signs in to obs-websocket 5, maps OBS scenes to Tempolight scenes, starts a scene with the stream, and lights the tally while recording", async () => {
  assert.equal(obsAuth("pw", "salt", "chal"), crypto.createHash("sha256").update(crypto.createHash("sha256").update("pwsalt").digest("base64") + "chal").digest("base64"));
  const obs = await fakeObs(), s = await setup({ integrations: { open: url => openWebSocket(url, { tiny: true }) } }); // the Node 20 client, end to end
  try {
    const w = await withLights(s);
    let r = await s.call("PATCH", "/api/integrations/obs", { enabled: true, url: obs.url, password: "hunter2", sceneMap: [{ obs: "Gaming", scene: "party" }, { obs: "BRB", scene: "relax" }, { obs: "", scene: "chill" }],
      onStreamStart: "chill", tally: { enabled: true, when: "recording", target: "all", color: "#ff0000" } });
    assert.equal(r.status, 200); assert.equal(r.body.hasPassword, true); assert.equal(r.body.password, undefined, "the password never comes back"); assert.equal(r.body.sceneMap.length, 2);
    assert.ok(await until(async () => (await s.call("GET", "/api/integrations")).body.obs.status?.connected), "connected");
    assert.equal(obs.st.subs & 4, 4, "scenes subscribed"); assert.equal(obs.st.subs & 64, 64, "outputs subscribed");
    const v = (await s.call("GET", "/api/integrations")).body.obs; assert.deepEqual(v.status.scenes, ["Just Chatting", "Gaming", "BRB"]); assert.equal(v.status.recording, true); assert.equal(v.status.scene, "Just Chatting");
    // recording: the tally colour (red) over the whole room
    assert.ok(await until(() => { const [R, G, B] = meanRGB(w.lastFrame); return R > 150 && G < 10 && B < 10; }), `tally red: ${meanRGB(w.lastFrame)}`);
    obs.emit("CurrentProgramSceneChanged", { sceneName: "Gaming", sceneUuid: "u1" });
    assert.ok(await until(() => s.app.store.data.show.style === "party"), "OBS Gaming -> Party mode");
    obs.emit("CurrentProgramSceneChanged", { sceneName: "Unmapped" }); await sleep(100); assert.equal(s.app.store.data.show.style, "party", "an unmapped scene changes nothing");
    obs.emit("StreamStateChanged", { outputActive: true, outputState: "OBS_WEBSOCKET_OUTPUT_STARTING" }); obs.emit("StreamStateChanged", { outputActive: true, outputState: "OBS_WEBSOCKET_OUTPUT_STARTED" });
    assert.ok(await until(() => s.app.store.data.show.style === "chill"), "stream start -> Chill mode");
    obs.emit("RecordStateChanged", { outputActive: false, outputState: "OBS_WEBSOCKET_OUTPUT_STOPPED" });
    assert.ok(await until(() => meanRGB(w.lastFrame)[1] > 10 || meanRGB(w.lastFrame)[2] > 10), "tally off: the show again");
    assert.ok(s.app.runtime.log.some(e => /OBS: connected/.test(e.msg)));
    // the wrong password: refused, and said so
    await s.call("PATCH", "/api/integrations/obs", { password: "wrong" });
    assert.ok(await until(async () => /password/i.test((await s.call("GET", "/api/integrations")).body.obs.status?.error || "")), "wrong password reported");
    assert.equal((await s.call("PATCH", "/api/integrations/obs", { url: "http://nope" })).status, 400);
    assert.equal((await s.call("PATCH", "/api/integrations/obs", { sceneMap: [{ obs: "X", scene: "nope" }] })).status, 400);
  } finally { await s.done(); await obs.close(); }
});

// ---------------------------------------------------------------- games
test("games: CS2 and Dota 2 payloads become events and layers (health colour, flashbang, bomb beeps, rounds, kills, Roshan, day and night)", () => {
  assert.deepEqual(healthColor(1), [0, 1, 0]); assert.deepEqual(healthColor(0), [1, 0, 0]); assert.deepEqual(healthColor(0.5), [1, 1, 0]);
  const beeps = bombBeeps(); assert.equal(beeps[0], 0); assert.ok(beeps.at(-1) < BOMB_SECONDS && beeps.at(-1) > BOMB_SECONDS - 0.5);
  const gap = i => beeps[i + 1] - beeps[i]; assert.ok(gap(0) > 0.9 && gap(beeps.length - 2) < 0.2, "faster and faster"); assert.ok(beeps.length > 60 && beeps.length < 140, `${beeps.length} beeps`);
  let t = 1_000_000; const G = createGames({ now: () => t }), cfg = { cs2: { enabled: true, intensity: 1, mode: "takeover", healthTarget: "zone:desk", effectsTarget: "all" }, dota2: { enabled: true, intensity: 1, mode: "blend", healthTarget: "all", manaTarget: "zone:mana", ambientTarget: "zone:back", effectsTarget: "all" } };
  const L = (o = {}) => G.layers(cfg, o);
  assert.deepEqual(G.ingest("cs2", fixture("cs2-menu.json")), []); assert.equal(L().length, 0, "in the menu: nothing");
  G.ingest("cs2", fixture("cs2-live.json"));
  let ls = L(); assert.equal(ls.length, 1); assert.equal(ls[0].target, "zone:desk"); assert.deepEqual(ls[0].color, [0, 1, 0]); assert.equal(ls[0].mix, 1);
  let ev = G.ingest("cs2", fixture("cs2-flashed.json")); assert.deepEqual(ev.map(e => e.type), ["flashbang"]);
  ls = L(); const fb = ls.find(l => l.target === "all" && l.mix); assert.ok(fb && fb.mix > 0.95, "blinded: white"); assert.ok(ls[0].color[0] > 0.4 && ls[0].color[1] === 1, "76 HP: yellow-green");
  // safe mode: half, and it fades in instead of jumping
  const G2 = createGames({ now: () => t }); G2.ingest("cs2", fixture("cs2-flashed.json")); const sf = G2.layers(cfg, { safe: true }).find(l => l.target === "all"); assert.ok(sf.mix <= 0.031, `safe flashbang starts low: ${sf.mix}`);
  for (let i = 0; i < 40; i++) G2.layers(cfg, { safe: true }); assert.ok(G2.layers(cfg, { safe: true }).find(l => l.target === "all").mix <= 0.5);
  ev = G.ingest("cs2", fixture("cs2-kill.json")); assert.deepEqual(ev, [{ type: "kill", headshot: true, n: 1 }]);
  ls = L(); const k = ls.find(l => l.add); assert.ok(k && k.add > 0.8, "kill flash"); assert.ok(k.color[1] < 0.5, "headshot: red tint");
  t += 400; assert.ok(!L().some(l => l.add > 0.2), "the flash is short");
  const safeKill = createGames({ now: () => t }); safeKill.ingest("cs2", fixture("cs2-live.json")); safeKill.ingest("cs2", fixture("cs2-kill.json"));
  assert.ok(!(safeKill.layers(cfg, { safe: true }).find(l => l.add)?.add > 0.05), "safe mode: the kill flash rises gently");
  G.ingest("cs2", fixture("cs2-low.json")); const low1 = L()[0].color[0]; t += 400; const low2 = L()[0].color[0]; assert.ok(Math.abs(low1 - low2) > 0.05, "low health: a heartbeat");
  ev = G.ingest("cs2", fixture("cs2-bomb-planted.json")); assert.deepEqual(ev.map(e => e.type), ["bomb_planted"]);
  const bombAt = t, levels = []; for (let i = 0; i < 100; i++) { t = bombAt + i * 10; const b = L().find(l => l.target === "all" && l.color[1] === 0 && l.color[0] > 0); levels.push(b.color[0]); }
  assert.ok(levels[0] > 0.95, "a beep at the plant"); assert.ok(Math.min(...levels) < 0.4, "dark red between beeps");
  t = bombAt + 39_500; G.ingest("cs2", fixture("cs2-bomb-planted.json")); const late = []; for (let i = 0; i < 30; i++) { t += 10; late.push(L().find(l => l.target === "all" && l.color[1] === 0).color[0]); } assert.ok(late.filter((x, i) => i && x > late[i - 1] + 0.3).length >= 2, "beeps come fast near the end");
  t = bombAt + 5000; const safeBomb = []; for (let i = 0; i < 60; i++) { t += 10; safeBomb.push(G.layers(cfg, { safe: true }).find(l => l.target === "all" && l.color[1] === 0).color[0]); }
  assert.ok(safeBomb.every((x, i) => !i || Math.abs(x - safeBomb[i - 1]) < 0.05), "safe mode: a smooth pulse, no beeps");
  ev = G.ingest("cs2", fixture("cs2-round-won.json")); assert.deepEqual(ev.map(e => e.type), ["bomb_defused", "round_won"]);
  ls = L(); assert.ok(ls.some(l => l.mix && l.color.join() === [0.36, 0.47, 0.68].join()), "CT blue for the win");
  assert.deepEqual(G.ingest("cs2", fixture("cs2-round-won.json")), [], "the same round once");
  t += 4000; assert.ok(!L().some(l => l.color.join() === [0.36, 0.47, 0.68].join() && l.mix), "the team colour ends");
  G.ingest("cs2", fixture("cs2-spectating.json")); ls = L(); assert.deepEqual(ls[0].color, [0.18, 0, 0], "dead, watching a teammate: dark red"); assert.equal(G.status("cs2").own, false);
  // Dota 2
  G.ingest("dota2", fixture("dota-ingame.json")); ls = G.layers({ dota2: cfg.dota2 });
  assert.equal(ls.find(l => l.target === "all").mix, 0.55, "blend"); assert.ok(ls.find(l => l.target === "zone:mana").color[2] > 0.4); assert.deepEqual(ls.find(l => l.target === "zone:back").color, [1, 0.78, 0.4], "day");
  ev = G.ingest("dota2", fixture("dota-night-roshan.json")); assert.deepEqual(ev.map(e => e.type).sort(), ["aegis", "kill", "night", "roshan_killed"]);
  ls = G.layers({ dota2: cfg.dota2 }); assert.deepEqual(ls.find(l => l.target === "zone:back").color, [0.1, 0.14, 0.5], "night"); assert.ok(ls.some(l => l.mix && l.color[2] > 0.5 && l.color[0] > 0.3), "Roshan: purple");
  assert.deepEqual(G.ingest("dota2", fixture("dota-night-roshan.json")).map(e => e.type), [], "events once");
  assert.deepEqual(G.ingest("dota2", fixture("dota-dead.json")).map(e => e.type), ["death"]); assert.equal(G.status("dota2").alive, false);
  t += 5000; assert.deepEqual(G.ingest("dota2", fixture("dota-win.json")).map(e => e.type), ["respawn", "match_won"]);
  assert.ok(G.layers({ dota2: cfg.dota2 }).some(l => l.color.join() === [0.18, 0.75, 0.3].join()), "Radiant green");
  t += 40000; assert.equal(G.layers(cfg).length, 0, "the game went quiet: the show comes back");
  // the config files
  const c = gsiConfig("cs2", { url: "http://192.168.1.5:8080/", token: "abc" }); assert.match(c, /"uri"\s+"http:\/\/192\.168\.1\.5:8080\/api\/gsi\/cs2"/); assert.match(c, /"token" "abc"/); assert.match(c, /"player_state"\s+"1"/);
  assert.match(gsiConfig("dota2", { url: "http://x:1", token: "t" }), /"hero"\s+"1"/);
});

test("games: POST /api/gsi needs the game's token, is rate-limited, and the colours reach the lights; the Try buttons work", async () => {
  const s = await setup();
  try {
    const w = await withLights(s);
    assert.equal((await s.call("POST", "/api/gsi/cs2", fixture("cs2-live.json", "x"))).status, 403, "no token yet");
    let r = await s.call("PATCH", "/api/integrations/games/cs2", { enabled: true, intensity: 1, mode: "takeover" }); const tok = r.body.token; assert.match(tok, /^[0-9a-f]{32}$/);
    assert.equal((await s.call("POST", "/api/gsi/cs2", fixture("cs2-live.json", "wrong" + tok.slice(5)))).status, 403);
    assert.equal((await s.call("POST", "/api/gsi/csgo", fixture("cs2-live.json", tok))).status, 404);
    r = await s.call("POST", "/api/gsi/cs2", fixture("cs2-live.json", tok)); assert.deepEqual(r.body, { ok: true });
    assert.ok(await until(() => { const [R, G, B] = meanRGB(w.lastFrame); return G > 150 && R < 20 && B < 20; }), `full health: green ${meanRGB(w.lastFrame)}`);
    await s.call("POST", "/api/gsi/cs2", fixture("cs2-low.json", tok));
    assert.ok(await until(() => { const [R, G] = meanRGB(w.lastFrame); return R > 120 && G < R * 0.5; }), `low health: red ${meanRGB(w.lastFrame)}`);
    const st = (await s.call("GET", "/api/integrations")).body.games.cs2.status; assert.equal(st.live, true); assert.equal(st.health, 14); assert.equal(st.map, "de_mirage");
    // bursts: at most 40 a second
    const codes = await Promise.all(Array.from({ length: 45 }, () => s.call("POST", "/api/gsi/cs2", fixture("cs2-low.json", tok)).then(x => x.status)));
    assert.ok(codes.includes(429), "too many in a second are refused"); await sleep(1100);
    // turned off: the show comes back and posts are ignored
    await s.call("PATCH", "/api/integrations/games/cs2", { enabled: false });
    assert.deepEqual((await s.call("POST", "/api/gsi/cs2", fixture("cs2-live.json", tok))).body, { ok: true, off: true });
    assert.equal((await s.call("POST", "/api/integrations/games/cs2/test", { what: "bomb" })).status, 400, "Try needs it on");
    // the config file carries the token and Tempolight's address
    const cfg = await s.call("GET", `/api/integrations/games/cs2/cfg?url=${encodeURIComponent(s.base)}`);
    assert.equal(cfg.body.filename, "gamestate_integration_tempolight.cfg"); assert.ok(cfg.body.content.includes(tok)); assert.ok(cfg.body.content.includes(`${s.base}/api/gsi/cs2`));
    assert.equal((await s.call("GET", "/api/integrations/games/cs2/cfg?url=javascript:alert(1)")).status, 400);
    const tok2 = (await s.call("POST", "/api/integrations/games/cs2/token")).body.token; assert.notEqual(tok2, tok);
    // Dota 2 Try: night on a zone
    await s.call("PATCH", "/api/integrations/games/dota2", { enabled: true, healthTarget: "off", ambientTarget: "all", effectsTarget: "off", mode: "takeover", intensity: 1 });
    assert.equal((await s.call("POST", "/api/integrations/games/dota2/test", { what: "night" })).status, 200);
    assert.ok(await until(() => { const [R, G, B] = meanRGB(w.lastFrame); return B > R * 2.5 && B > 30; }), `night: blue ${meanRGB(w.lastFrame)}`);
    assert.equal((await s.call("PATCH", "/api/integrations/games/dota2", { healthTarget: "kitchen" })).status, 400);
  } finally { await s.done(); }
});

// ---------------------------------------------------------------- Twitch chat
test("twitch: IRC lines with tags, roles, colours, and the command rules (allowlist, who, cooldowns, safe mode)", () => {
  const m = parseIrc("@badge-info=subscriber/14;badges=moderator/1,subscriber/12;color=#1E90FF;display-name=Mod\\sMia;emotes=;mod=1;room-id=1;subscriber=1;user-id=1001;user-type=mod :modmia!modmia@modmia.tmi.twitch.tv PRIVMSG #d4rkgeek :!flash red please");
  assert.equal(m.command, "PRIVMSG"); assert.equal(m.nick, "modmia"); assert.equal(m.tags["display-name"], "Mod Mia"); assert.equal(m.text, "!flash red please"); assert.deepEqual(m.params, ["#d4rkgeek"]);
  assert.equal(roleOf(m.tags), "mod"); assert.equal(roleOf({ badges: "broadcaster/1" }), "broadcaster"); assert.equal(roleOf({ badges: "vip/1" }), "vip"); assert.equal(roleOf({ badges: "founder/0" }), "subscriber"); assert.equal(roleOf({}), "everyone");
  assert.equal(parseIrc("PING :tmi.twitch.tv").text, "tmi.twitch.tv");
  assert.equal(chatColor("Red"), "#ff0000"); assert.equal(chatColor("#00FF88"), "#00ff88"); assert.equal(chatColor("plaid"), null);
  const cfg = { ...CHAT_DEFAULTS(), cooldownSec: 10, userCooldownSec: 30 }, ctx = { scenes: [{ id: "party", name: "Party mode" }, { id: "chill", name: "Chill mode" }], effects: [{ id: "laser", name: "Laser show" }, { id: "solar", name: "Solar flare" }] };
  const memo = { last: new Map(), users: new Map() }, msg = (text, user = "u1", role = "everyone") => ({ text, user, role });
  assert.equal(chatCommand(msg("hello"), cfg, ctx, memo, 0), null); assert.equal(chatCommand(msg("!lurk"), cfg, ctx, memo, 0), null, "other bots' commands: ignored");
  assert.deepEqual(chatCommand(msg("!scene party"), cfg, ctx, memo, 1000), { ok: true, cmd: "scene", action: { type: "scene", scene: "party", name: "Party mode" } });
  assert.equal(chatCommand(msg("!scene chill", "u2"), cfg, ctx, memo, 5000).why, "cooldown", "the command's cooldown");
  assert.equal(chatCommand(msg("!effect laser", "u1"), cfg, ctx, memo, 5000).why, "user-cooldown", "the same viewer again");
  assert.equal(chatCommand(msg("!effect laser", "u2"), cfg, ctx, memo, 5000).action.effect, "laser");
  assert.equal(chatCommand(msg("!effect solar flare", "u3"), cfg, ctx, memo, 16000).action.effect, "solar", "by name");
  assert.equal(chatCommand(msg("!scene chill", "boss", "broadcaster"), cfg, ctx, memo, 1001).ok, true, "the streamer skips cooldowns");
  assert.equal(chatCommand(msg("!strobe", "u4"), cfg, ctx, memo, 99000).why, "off", "not in the allowlist");
  assert.equal(chatCommand(msg("!strobe", "u4"), { ...cfg, commands: { ...cfg.commands, strobe: true } }, { ...ctx, safe: true }, memo, 99000).why, "safe");
  assert.equal(chatCommand(msg("!scene movie", "u5"), cfg, ctx, memo, 200000).why, "unknown");
  assert.equal(chatCommand(msg("!scene chill", "u6"), { ...cfg, scenes: ["party"] }, ctx, memo, 300000).why, "unknown", "only allowed scenes");
  const modOnly = { ...cfg, who: "mod" };
  assert.equal(chatCommand(msg("!flash red", "v1", "vip"), modOnly, ctx, memo, 400000).why, "role");
  assert.deepEqual(chatCommand(msg("!flash red", "m1", "mod"), modOnly, ctx, memo, 400000).action, { type: "flash", color: "#ff0000" });
  assert.equal(chatCommand(msg("!colour teal", "m2", "mod"), modOnly, ctx, memo, 500000).action.color, "#00c2a8");
});

test("twitch chat: reads a channel anonymously over IRC-WebSocket and runs allowed commands with cooldowns and mod-only", async () => {
  const lines = [], irc = await wsServer(c => { c.onmessage = msg => { for (const l of msg.split("\r\n").filter(Boolean)) { lines.push(l);
    if (l.startsWith("JOIN ")) c.send(`:justinfan1!justinfan1@justinfan1.tmi.twitch.tv JOIN ${l.slice(5)}\r\n:tmi.twitch.tv 366 justinfan1 ${l.slice(5)} :End of /NAMES list\r\n`); } }; });
  const say = (text, { user = "viewer", id = "2001", badges = "", mod = "0" } = {}) => { for (const c of irc.clients) c.send(`@badge-info=;badges=${badges};color=;display-name=${user};emotes=;first-msg=0;flags=;id=${crypto.randomUUID()};mod=${mod};room-id=999;subscriber=0;tmi-sent-ts=${Date.now()};turbo=0;user-id=${id};user-type= :${user.toLowerCase()}!${user.toLowerCase()}@${user.toLowerCase()}.tmi.twitch.tv PRIVMSG #d4rkgeek :${text}\r\n`); };
  const s = await setup({ integrations: { urls: { irc: irc.url } } });
  try {
    assert.equal((await s.call("PATCH", "/api/integrations/twitch", { chat: { enabled: true } })).status, 400, "needs a channel");
    let r = await s.call("PATCH", "/api/integrations/twitch", { chat: { enabled: true, channel: "https://www.twitch.tv/D4rkGeek", cooldownSec: 5, userCooldownSec: 0 } });
    assert.equal(r.status, 200); assert.equal(r.body.chat.channel, "d4rkgeek");
    assert.ok(await until(async () => (await s.call("GET", "/api/integrations")).body.twitch.status?.joined), "joined");
    assert.ok(lines.includes("CAP REQ :twitch.tv/tags twitch.tv/commands")); assert.ok(lines.some(l => /^NICK justinfan\d+$/.test(l))); assert.ok(lines.includes("JOIN #d4rkgeek"));
    for (const c of irc.clients) c.send("PING :tmi.twitch.tv\r\n"); assert.ok(await until(() => lines.includes("PONG :tmi.twitch.tv")), "PONG");
    say("!scene party"); assert.ok(await until(() => s.app.store.data.show.style === "party"), "!scene party");
    say("!scene chill", { user: "Other", id: "2002" }); await sleep(150); assert.equal(s.app.store.data.show.style, "party", "cooldown");
    let v = (await s.call("GET", "/api/integrations")).body.twitch; assert.equal(v.last.why, "cooldown");
    say("!effect solar", { user: "Third", id: "2003" }); assert.ok(await until(() => s.app.store.data.show.effect === "solar"), "!effect");
    // mods only
    await s.call("PATCH", "/api/integrations/twitch", { chat: { who: "mod", cooldownSec: 0 } });
    const flashT = () => s.app.runtime.director.state.overlay.flashT || 0, before = flashT();
    say("!flash red", { user: "Viewer", id: "2004" }); await sleep(150); assert.equal(flashT(), before, "a viewer can't");
    say("!flash red", { user: "ModMia", id: "2005", badges: "moderator/1", mod: "1" }); assert.ok(await until(() => flashT() > before), "a mod can");
    assert.deepEqual(s.app.runtime.director.state.overlay.flashColor, [1, 0, 0]);
    say("!strobe", { user: "ModMia", id: "2005", badges: "moderator/1", mod: "1" }); await sleep(150); assert.equal(s.app.runtime.director.state.overlay.strobe, false, "!strobe isn't allowed by default");
    assert.ok(s.app.runtime.log.some(e => /Twitch chat: ModMia → !flash/.test(e.msg)));
    await s.call("PATCH", "/api/integrations/twitch", { chat: { enabled: false } }); assert.ok(await until(() => !irc.clients.size), "off: disconnects");
  } finally { await s.done(); await irc.close(); }
});

// ---------------------------------------------------------------- Twitch EventSub and Discord, with the PIN lock
test("twitch events and discord: device-code sign-in, EventSub follow/raid/cheer, webhook posts; secrets stay on the server and behind the PIN", async () => {
  const posts = [], helix = [], tokenPolls = { n: 0 };
  const fetch = async (url, init = {}) => {
    const u = new URL(url), body = init.body ? String(init.body) : "";
    if (u.hostname === "id.twitch.tv" && u.pathname === "/oauth2/device") { assert.match(body, /client_id=abcdefghij0123456789klmnop/); assert.match(decodeURIComponent(body.replace(/\+/g, " ")), /moderator:read:followers/); return res(200, { device_code: "dev-1", user_code: "WDJBMJHT", verification_uri: "https://www.twitch.tv/activate?public=true&device-code=WDJBMJHT", expires_in: 1800, interval: 1 }); }
    if (u.hostname === "id.twitch.tv" && u.pathname === "/oauth2/token") { if (++tokenPolls.n < 2) return res(400, { status: 400, message: "authorization_pending" }); return res(200, { access_token: "SECRET-ACCESS-TOKEN", refresh_token: "SECRET-REFRESH", expires_in: 14400, scope: SCOPES, token_type: "bearer" }); }
    if (u.hostname === "id.twitch.tv" && u.pathname === "/oauth2/validate") { assert.equal(init.headers.authorization, "OAuth SECRET-ACCESS-TOKEN"); return res(200, { client_id: "abcdefghij0123456789klmnop", login: "d4rkgeek", scopes: SCOPES, user_id: "141981764", expires_in: 14400 }); }
    if (u.hostname === "api.twitch.tv" && u.pathname === "/helix/eventsub/subscriptions") { const b = JSON.parse(body); helix.push(b); assert.equal(init.headers.authorization, "Bearer SECRET-ACCESS-TOKEN"); assert.equal(b.transport.session_id, "AQoQexAWVYKSTIu4ec_2VAxyuhAB");
      return b.type === "channel.cheer" ? res(403, { error: "Forbidden", status: 403, message: "subscription missing proper authorization" }) : res(202, { data: [{ id: crypto.randomUUID(), status: "enabled", type: b.type }], total: 1 }); }
    if (u.hostname === "discord.com") { posts.push(JSON.parse(body)); return res(204); }
    throw new Error("unexpected fetch " + url);
  };
  const es = await wsServer(c => c.sendJSON({ metadata: { message_id: crypto.randomUUID(), message_type: "session_welcome", message_timestamp: new Date().toISOString() }, payload: { session: { id: "AQoQexAWVYKSTIu4ec_2VAxyuhAB", status: "connected", connected_at: new Date().toISOString(), keepalive_timeout_seconds: 10, reconnect_url: null } } }));
  const notify = (type, event) => { for (const c of es.clients) c.sendJSON({ metadata: { message_id: crypto.randomUUID(), message_type: "notification", message_timestamp: new Date().toISOString(), subscription_type: type, subscription_version: "1" },
    payload: { subscription: { id: "s", status: "enabled", type, version: "1", cost: 0, condition: { broadcaster_user_id: "141981764" }, transport: { method: "websocket", session_id: "AQoQexAWVYKSTIu4ec_2VAxyuhAB" }, created_at: new Date().toISOString() }, event } }); };
  const s = await setup({ integrations: { fetch, urls: { eventsub: es.url }, pollMs: 40, discordGapMs: 40 } });
  const HOOK = "https://discord.com/api/webhooks/1234567890123456789/AbCdEfGhIjKlMnOpQrStUvWxYz_0123456789-abcdefghijklmnopqrstuvwxyzABCDEF";
  try {
    assert.equal((await s.call("POST", "/api/integrations/twitch/login", {})).status, 400, "a Client ID first");
    let r = await s.call("POST", "/api/integrations/twitch/login", { clientId: "abcdefghij0123456789klmnop" }); assert.equal(r.status, 200); assert.equal(r.body.userCode, "WDJBMJHT");
    assert.ok(await until(async () => (await s.call("GET", "/api/integrations")).body.twitch.auth?.login === "d4rkgeek", 6000), "signed in");
    assert.ok(await until(async () => (await s.call("GET", "/api/integrations")).body.twitch.eventsub?.subscribed.length === 5), "subscribed");
    const v = (await s.call("GET", "/api/integrations")).body.twitch; assert.deepEqual(v.eventsub.failed.map(x => x.split(":")[0]), ["cheer"], "a missing scope is reported");
    assert.deepEqual(helix.find(b => b.type === "channel.follow").condition, { broadcaster_user_id: "141981764", moderator_user_id: "141981764" }); assert.equal(helix.find(b => b.type === "channel.follow").version, "2");
    assert.deepEqual(helix.find(b => b.type === "channel.raid").condition, { to_broadcaster_user_id: "141981764" });
    // Discord: the webhook, checked; posts scene changes and (optionally) Twitch events
    assert.equal((await s.call("PATCH", "/api/integrations/discord", { webhook: "https://evil.example/api/webhooks/1/x" })).status, 400);
    r = await s.call("PATCH", "/api/integrations/discord", { webhook: HOOK, scenes: true, twitch: true, nowPlaying: true }); assert.equal(r.body.hasWebhook, true); assert.ok(!JSON.stringify(r.body).includes("AbCdEfGhIjKlMnOp"), "the webhook's secret part isn't sent back");
    // events: follow -> purple flash, raid -> strobe for a moment
    const D = s.app.runtime.director.state.overlay, f0 = D.flashT || 0;
    notify("channel.follow", { user_id: "1234", user_login: "cool_user", user_name: "Cool_User", broadcaster_user_id: "141981764", broadcaster_user_login: "d4rkgeek", broadcaster_user_name: "D4rkGeek", followed_at: new Date().toISOString() });
    assert.ok(await until(() => (D.flashT || 0) > f0), "follow: flash"); assert.deepEqual(D.flashColor.map(x => Math.round(x * 255)), [0x91, 0x46, 0xff]);
    assert.ok(await until(() => posts.some(p => /Cool_User followed/.test(p.content))), "Discord: the follow");
    await s.call("PATCH", "/api/integrations/twitch", { events: { raid: { type: "strobe", seconds: 1 } } });
    notify("channel.raid", { from_broadcaster_user_id: "1", from_broadcaster_user_login: "raider", from_broadcaster_user_name: "Raider", to_broadcaster_user_id: "141981764", viewers: 42 });
    assert.ok(await until(() => D.strobe === true), "raid: strobe"); assert.ok(await until(() => D.strobe === false, 3000), "and it stops");
    // safe mode: no strobe, a flash instead
    await s.call("PATCH", "/api/settings", { safe: true }); const f1 = D.flashT; notify("channel.raid", { from_broadcaster_user_name: "Raider2", viewers: 5 });
    assert.ok(await until(() => D.flashT > f1)); assert.equal(D.strobe, false, "photosensitive-safe: no strobe"); await s.call("PATCH", "/api/settings", { safe: false });
    // a scene: posted to Discord
    await s.call("POST", "/api/scenes/chill/apply"); assert.ok(await until(() => posts.some(p => p.content.includes("Scene: **Chill mode**"))));
    assert.ok(posts.every(p => p.username === "Tempolight" && Array.isArray(p.allowed_mentions.parse) && !p.allowed_mentions.parse.length), "no @everyone pings");
    // now playing, from the music apps on this computer
    s.app.runtime.rt.nowPlaying = { info: () => ({ title: "One More Time", artist: "Daft Punk", playing: true }), follow: () => null, memId: null };
    assert.ok(await until(() => posts.some(p => p.content === "🎵 Now playing: **Daft Punk – One More Time**")), "now playing posted");
    await sleep(300); assert.equal(posts.filter(p => /Now playing/.test(p.content)).length, 1, "once");
    // secrets: never in /api/state; integrations admin-only once a PIN is set; the game route still works with its token
    const state = JSON.stringify((await s.call("GET", "/api/state")).body);
    for (const secret of ["SECRET-ACCESS-TOKEN", "SECRET-REFRESH", "AbCdEfGhIjKlMnOp", "integrations"]) assert.ok(!state.includes(secret), secret);
    const all = JSON.stringify((await s.call("GET", "/api/integrations")).body); assert.ok(!all.includes("SECRET-ACCESS-TOKEN") && !all.includes("SECRET-REFRESH") && !all.includes("AbCdEfGhIjKlMnOp"));
    const gtok = (await s.call("PATCH", "/api/integrations/games/cs2", { enabled: true })).body.token;
    const lock = await s.call("POST", "/api/lock", { pin: "2468" });
    for (const [m, p] of [["GET", "/api/integrations"], ["PATCH", "/api/integrations/obs"], ["PATCH", "/api/integrations/twitch"], ["POST", "/api/integrations/discord/test"], ["GET", "/api/integrations/games/cs2/cfg?url=http://x:1"], ["POST", "/api/integrations/twitch/login"]])
      assert.equal((await s.call(m, p, m === "GET" ? undefined : {})).status, 403, `${m} ${p} is admin-only`);
    assert.equal((await s.call("GET", "/api/integrations", undefined, { "x-tempolight-token": lock.body.token })).status, 200);
    assert.equal((await s.call("POST", "/api/gsi/cs2", fixture("cs2-live.json", gtok))).status, 200, "the game's own token works with the lock");
    // a restart keeps the sign-in (in the settings file, not the browser)
    s.app.store.flush(); const saved = JSON.parse(readFileSync(path.join(s.dir, "tempolight.json"), "utf8")); assert.equal(saved.integrations.twitch.auth.access, "SECRET-ACCESS-TOKEN");
    assert.equal(isWebhook(HOOK), true); assert.match(maskWebhook(HOOK), /\/1234567890123456789\/…CDEF$/); assert.equal(isWebhook("https://discord.com/api/webhooks/abc/def"), false);
  } finally { await s.done(); await es.close(); }
});

test("zip: what the Stream Deck plugin is packed with reads back (crc, deflate)", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  const files = [{ name: "a/b.txt", data: Buffer.from("hello ".repeat(100)) }, { name: "a/c.bin", data: crypto.randomBytes(300) }], out = unzip(zip(files));
  assert.deepEqual(out.map(f => [f.name, f.data.toString("hex")]), files.map(f => [f.name, f.data.toString("hex")]));
  assert.ok(out.every((f, i) => f.crc === crc32(files[i].data)));
});
