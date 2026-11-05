// "Now playing" from music apps, with pretend players: a fake command runner prints what osascript, playerctl,
// dbus-send and PowerShell print on a real computer (fixtures/nowplaying), and a fake fetch plays the Spotify Web API.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from "node:fs";
import { createApp } from "../src/app.js";
import { createNowPlaying, parseMac, parsePlayerctl, parseDbusReply, mprisTrack, parseWindows, parseSpotifyPlayer, matchSong, normTitle, PLAYERCTL_FORMAT, WINDOWS_SCRIPT } from "../src/nowplaying.js";
import { edm } from "../../engine/test/synth.js";
import { preAnalyseCore } from "../../engine/src/index.js";

const fx = f => readFileSync(new URL(`./fixtures/nowplaying/${f}`, import.meta.url), "utf8");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const near = (a, b, d = 0.01) => assert.ok(Math.abs(a - b) < d, `${a} vs ${b}`);
const SEP = "\u001f", line = (status, title, artist, dur, pos, player = "spotify") => [player, status, title, artist, "Album", Math.round(dur * 1e6), Math.round(pos * 1e6)].join(SEP);

/** Commands answer from `answer(cmd, args)`; a command it doesn't know isn't installed. */
function fakeRunner(answer) {
  const calls = [], streams = [];
  return { calls, streams,
    async run(cmd, args) { calls.push([cmd, ...args]); return (await answer(cmd, args)) ?? { code: 127, stdout: "", stderr: "", missing: true }; },
    stream(cmd, args, onLine, onExit) { const s = { cmd, args, onLine, onExit, stopped: false }; streams.push(s); calls.push([cmd, ...args]); return { stop() { s.stopped = true; } }; } };
}
const okOut = stdout => ({ code: 0, stdout, stderr: "" });

test("now playing: reads the real output of osascript, playerctl, dbus-send, PowerShell and the Spotify Web API", () => {
  let p = parseMac(fx("osascript-spotify.json"));
  assert.equal(p.error, null); assert.deepEqual(p.tracks[0], { app: "Spotify", title: "One More Time", artist: "Daft Punk", album: "Discovery", dur: 320.357, pos: 42.123000335693, playing: true, posOk: true });
  p = parseMac(fx("osascript-both.json")); assert.equal(p.tracks.length, 2); assert.equal(p.tracks[0].playing, false); near(p.tracks[0].dur, 637); near(p.tracks[1].dur, 354.32, 0.001); assert.equal(p.tracks[1].app, "Music");
  assert.match(parseMac(fx("osascript-denied.json")).error, /Not authorized/); assert.deepEqual(parseMac(""), { tracks: [], error: null });

  const pc = parsePlayerctl(fx("playerctl.txt"));
  assert.equal(pc.length, 2); assert.deepEqual(pc[0], { app: "Spotify", title: "One More Time", artist: "Daft Punk", album: "Discovery", dur: 320.357, pos: 42.123, playing: true, posOk: true });
  assert.equal(pc[1].app, "Firefox"); assert.equal(pc[1].playing, false); assert.equal(pc[1].dur, 0);
  assert.equal(PLAYERCTL_FORMAT.split(SEP).length, 9, "the 8th field is the track ID (Spotify: spotify:track:…), the 9th the address (a local file: file://…)");

  const names = parseDbusReply(fx("dbus-listnames.txt")); // captured from dbus-send against a real session bus with two MPRIS players
  assert.deepEqual(names.filter(n => n.startsWith("org.mpris.")), ["org.mpris.MediaPlayer2.spotify", "org.mpris.MediaPlayer2.vlc"]);
  const sp = parseDbusReply(fx("dbus-getall-spotify.txt"));
  assert.equal(sp.PlaybackStatus, "Playing"); assert.equal(sp.Position, 42123000); assert.deepEqual(sp.Metadata["xesam:artist"], ["Daft Punk"]); assert.equal(sp.Metadata["mpris:trackid"], "/com/spotify/track/0DiWol3AO6WpXZgp0goxAV");
  assert.deepEqual(mprisTrack("org.mpris.MediaPlayer2.spotify", sp), { app: "Spotify", title: "One More Time", artist: "Daft Punk", album: "Discovery", dur: 320.357, pos: 42.123, playing: true, posOk: true, spotifyId: "0DiWol3AO6WpXZgp0goxAV" });
  const vlc = mprisTrack("org.mpris.MediaPlayer2.vlc", parseDbusReply(fx("dbus-getall-vlc.txt")));
  assert.equal(vlc.title, 'Say "Hello" – Café', "dbus-send doesn't escape quotes: the string runs to the end of the line"); assert.equal(vlc.artist, "A, B"); assert.equal(vlc.app, "VLC"); assert.equal(vlc.playing, false);

  const w = parseWindows(fx("windows-sessions.json").trim());
  assert.equal(w.error, null); assert.equal(w.tracks.length, 2);
  assert.equal(w.tracks[0].app, "Spotify"); near(w.tracks[0].pos, 42.123, 1e-6); near(w.tracks[0].dur, 320.357); assert.equal(w.tracks[0].posOk, true, "the position is carried on from LastUpdatedTime");
  assert.equal(w.tracks[1].app, "Edge"); assert.equal(w.tracks[1].posOk, false, "no timeline: position unknown");
  assert.match(parseWindows(fx("windows-error.json").trim()).error, /Class not registered/);
  assert.ok(WINDOWS_SCRIPT.includes("IAsyncOperation`1") && WINDOWS_SCRIPT.includes("GlobalSystemMediaTransportControlsSessionManager"));

  assert.deepEqual(parseSpotifyPlayer(JSON.parse(fx("spotify-player.json"))), { app: "Spotify", device: "Kitchen speaker", title: "One More Time", artist: "Daft Punk", album: "Discovery", dur: 320.357, pos: 42.123, playing: true, posOk: true });
  assert.equal(parseSpotifyPlayer({ is_playing: false, item: null }), null);
});

test("now playing: remembered songs are matched by title (and artist) and a length within 3 seconds", () => {
  const songs = [{ id: "a", name: "Daft Punk - One More Time", dur: 320.4 }, { id: "b", name: "01. Queen - Bohemian Rhapsody", dur: 354.9 }, { id: "c", name: "99 Problems", dur: 234 },
    { id: "d", name: "Strobe (Radio Edit)", dur: 213 }, { id: "e", name: "Beyoncé_-_Halo", dur: 261 }, { id: "f", name: "Cover Band - One More Time", dur: 300 }];
  const m = (title, artist, dur) => matchSong({ title, artist, dur }, songs)?.id ?? null;
  assert.equal(m("One More Time", "Daft Punk", 320.357), "a");
  assert.equal(m("One more time!", "", 322), "a", "punctuation and case don't matter; the length decides");
  assert.equal(m("One More Time", "Daft Punk", 330), null, "10 s longer: another version");
  assert.equal(m("Bohemian Rhapsody - Remastered 2011", "Queen", 354.32), "b", "track numbers and \"- Remastered\" are ignored");
  assert.equal(m("99 Problems", "JAY-Z", 234.5), "c", "a title that starts with a number keeps it");
  assert.equal(m("Strobe", "deadmau5", 637), null);
  assert.equal(m("Halo", "Beyonce", 261.2), "e", "underscores and accents");
  assert.equal(m("One More Time", "Cover Band", 300.5), "f", "the artist picks between songs with the same title");
  assert.equal(m("One More Time", "Daft Punk", 0), "a", "no length from the player: title and artist must both match");
  assert.equal(m("One More Time", "", 0), null);
  assert.equal(normTitle("Levels (feat. Someone) [Official Video].mp3"), "levels");
});

test("now playing: polled once a second, smooth between readings, seeks, pauses, players that hide their position", async () => {
  let T = 1000, out = okOut(line("Playing", "One More Time", "Daft Punk", 320.357, 42));
  const r = fakeRunner(cmd => cmd === "playerctl" ? out : undefined);
  const np = createNowPlaying({ platform: "linux", runner: r, now: () => T, songs: () => [{ id: "a", name: "Daft Punk - One More Time", dur: 320.4, bpm: 123, P: 60 / 123, off: 0, barOff: 0, style: "party", drops: [], kicks: [], snares: [], hats: [], bars: [], env: "", fp: "" }] });
  await np.poll();
  assert.deepEqual(r.calls[0], ["playerctl", "-a", "metadata", "--format", PLAYERCTL_FORMAT]);
  assert.deepEqual(np.status(), { state: "ok", message: "", method: "playerctl" });
  near(np.track().pos, 42); near(np.track(T + 500).pos, 42.5, 1e-9);
  T = 2000; out = okOut(line("Playing", "One More Time", "Daft Punk", 320.357, 43.1)); await np.poll();
  near(np.track().pos, 43.03, 1e-6); // a 0.1 s difference is mostly timing noise: moved 30% of the way
  const f = np.follow(T); assert.equal(f.id, "a"); assert.equal(f.app, "Spotify"); near(f.pos, 43.03, 1e-6);
  T = 3000; out = okOut(line("Playing", "One More Time", "Daft Punk", 320.357, 100)); await np.poll(); near(np.track().pos, 100, 1e-9); // a seek
  T = 4000; out = okOut(line("Paused", "One More Time", "Daft Punk", 320.357, 100.7)); await np.poll(); near(np.track(9000).pos, 100.7, 1e-9); assert.equal(np.track().playing, false); assert.equal(np.follow(T), null, "paused: no beat map");
  T = 5000; out = okOut(line("Playing", "Other song", "Someone", 200, 0)); await np.poll(); assert.equal(np.track().posKnown, true);
  T = 6000; await np.poll(); T = 7000; await np.poll(); assert.equal(np.track().posKnown, false, "stuck at 0 while playing: this player doesn't report its position");
  out = { code: 1, stdout: "", stderr: "No players found" }; T = 8000; await np.poll(); assert.equal(np.track(), null); assert.equal(np.status().state, "ok");
  out = okOut(line("Paused", "A", "B", 100, 5, "vlc") + "\n" + line("Playing", "One More Time", "Daft Punk", 320.357, 10)); await np.poll(); assert.equal(np.track().app, "Spotify", "the one playing wins");
  assert.equal(np.track(T + 7000), null, "no news for 7 s: gone");
});

test("now playing: falls back to dbus-send without playerctl, and says why when there's no desktop session", async () => {
  let bus = true;
  const r = fakeRunner((cmd, args) => { if (cmd !== "dbus-send") return;
    if (!bus) return { code: 1, stdout: "", stderr: "Failed to open connection to \"session\" message bus: Unable to autolaunch a dbus-daemon without a $DISPLAY for X11" };
    if (args.includes("org.freedesktop.DBus.ListNames")) return okOut(fx("dbus-listnames.txt"));
    return okOut(fx(args.some(a => a.endsWith(".spotify")) ? "dbus-getall-spotify.txt" : "dbus-getall-vlc.txt")); });
  const np = createNowPlaying({ platform: "linux", runner: r });
  await np.poll(); assert.equal(np.status().method, "dbus-send"); assert.equal(np.track().title, "One More Time"); assert.equal(np.track().source, "mpris");
  assert.equal(r.calls.filter(c => c.includes("org.freedesktop.DBus.Properties.GetAll")).length, 2);
  bus = false; const np2 = createNowPlaying({ platform: "linux", runner: r }); await np2.poll();
  assert.equal(np2.status().state, "unavailable"); assert.match(np2.status().message, /no D-Bus session/i);
  const none = createNowPlaying({ platform: "linux", runner: fakeRunner(() => undefined) }); await none.poll(); assert.match(none.status().message, /Install playerctl/);
});

test("now playing: macOS (osascript) and Windows (a PowerShell loop) readers", async () => {
  let out = okOut(fx("osascript-both.json"));
  const mac = fakeRunner(cmd => cmd === "osascript" ? out : undefined), m = createNowPlaying({ platform: "darwin", runner: mac, songs: () => [{ id: "q", name: "Queen - Bohemian Rhapsody", dur: 354 }] });
  await m.poll(); assert.equal(mac.calls[0][0], "osascript"); assert.deepEqual(mac.calls[0].slice(1, 3), ["-l", "JavaScript"]); assert.match(mac.calls[0][4], /com\.spotify\.client/);
  assert.equal(m.track().app, "Music", "Spotify is paused, Music plays"); assert.equal(m.match().id, "q");
  out = okOut(fx("osascript-denied.json")); await m.poll(); assert.equal(m.status().state, "error"); assert.match(m.status().message, /Privacy & Security → Automation/);

  let T = 0; const win = fakeRunner(() => undefined), w = createNowPlaying({ platform: "win32", runner: win, now: () => T });
  await w.poll(); assert.equal(win.streams.length, 1); const s = win.streams[0];
  assert.equal(s.cmd, "powershell.exe"); assert.equal(Buffer.from(s.args[s.args.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le"), WINDOWS_SCRIPT);
  assert.equal(w.track(), null, "nothing until the first line");
  s.onLine(fx("windows-sessions.json").trim()); T = 200; await w.poll();
  assert.equal(w.track().app, "Spotify"); near(w.track().pos, 42.123 + 0.2, 1e-6); assert.equal(w.status().method, "powershell"); assert.equal(win.streams.length, 1, "one PowerShell, kept running");
  s.onExit("stopped (exit 1) Unable to find type [Windows.Media.Control...]"); await w.poll(); assert.match(w.status().message, /Windows 10 \(version 1809\)/);
  T = 16000; await w.poll(); assert.equal(win.streams.length, 2, "started again a while later");
  w.stop(); assert.equal(win.streams[1].stopped, true);
});

async function setup(nowPlaying) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tl-np-")), app = await createApp({ dataDir: dir, discover: false, logger: null, nowPlaying: { interval: 0, ...nowPlaying } });
  const port = await app.listen(0, "127.0.0.1"), base = `http://127.0.0.1:${port}`;
  const call = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j, text: t }; };
  return { app, dir, port, base, call, np: app.nowPlaying.np, async done() { await app.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("now playing: a remembered song playing in a music app drives the lights with its beat map and show", async () => {
  let out = { code: 1, stdout: "", stderr: "No players found" };
  const s = await setup({ platform: "linux", runner: fakeRunner(cmd => cmd === "playerctl" ? out : undefined) });
  try {
    await s.call("POST", "/api/devices", { virtual: true });
    const song = edm(22050), pre = await preAnalyseCore(song.x, song.sr);
    await s.call("POST", "/api/song", { name: "Synth anthem", analysis: { ...pre, env: Array.from(pre.env) } }); await s.call("DELETE", "/api/song");
    const mem = (await s.call("GET", "/api/songs")).body[0];
    await s.np.poll(); assert.equal((await s.call("GET", "/api/status")).body.nowPlaying, null);
    out = okOut(line("Playing", "Synth Anthem", "Tempolight", mem.dur + 1.2, 20)); await s.np.poll(); await sleep(80);
    let st = (await s.call("GET", "/api/status")).body;
    assert.equal(st.source, "nowplaying"); assert.match(st.sourceLabel, /^Spotify: Synth anthem \(remembered\)$/); assert.equal(st.part, "drop", "at 0:20 the remembered song is in its drop");
    assert.equal(st.nowPlaying.title, "Synth Anthem"); assert.equal(st.nowPlaying.following, true); assert.deepEqual(st.nowPlaying.remembered, { id: mem.id, name: "Synth anthem" }); assert.ok(st.nowPlaying.pos >= 20 && st.nowPlaying.pos < 21);
    assert.ok(Array.isArray(s.app.runtime.director.settings.plan) && s.app.runtime.director.settings.plan.length, "its show timeline is used");
    assert.ok(s.app.runtime.log.some(e => /is the remembered song “Synth anthem”/.test(e.msg)));
    out = okOut(line("Playing", "Synth anthem", "Tempolight", mem.dur, 3)); await s.np.poll(); await sleep(80);
    assert.notEqual(s.app.runtime.status().part, "drop", "a seek back to 0:03 moves the beat map with it");

    await s.call("PATCH", "/api/settings", { songMemory: false }); await sleep(80); assert.equal(s.app.runtime.status().source, "idle", "song memory off: not followed"); await s.call("PATCH", "/api/settings", { songMemory: true });
    out = okOut(line("Playing", "Something new", "Someone", 180, 30)); await s.np.poll(); await sleep(80);
    st = (await s.call("GET", "/api/status")).body;
    assert.equal(st.source, "idle", "not remembered and nothing heard"); assert.equal(st.nowPlaying.title, "Something new"); assert.equal(st.nowPlaying.remembered, null); assert.equal(st.nowPlaying.following, false);
    const v = (await s.call("GET", "/api/nowplaying")).body; assert.equal(v.enabled, true); assert.equal(v.state, "ok"); assert.equal(v.method, "playerctl"); assert.equal(v.track.title, "Something new");

    assert.equal((await s.call("PATCH", "/api/nowplaying", { enabled: false })).body.state, "off"); await s.np.poll();
    assert.equal((await s.call("GET", "/api/status")).body.nowPlaying, null); assert.equal((await s.call("GET", "/api/state")).body.settings.nowPlaying.enabled, false);
    await s.call("PATCH", "/api/nowplaying", { enabled: true });
    await s.call("POST", "/api/lock", { pin: "4321" }); assert.equal((await s.call("PATCH", "/api/nowplaying", { enabled: false })).status, 403, "settings need the PIN");
  } finally { await s.done(); }
});

test("now playing: Spotify Web API sign-in with PKCE; the tokens stay on the server", async () => {
  let T = 0, W = Date.now(); const tokenCalls = [], CID = "0123456789abcdef0123456789abcdef";
  const resp = (status, j) => ({ status, ok: status >= 200 && status < 300, headers: { get: () => null }, json: async () => j });
  const fakeFetch = async (url, o = {}) => {
    if (url === "https://accounts.spotify.com/api/token") { const b = Object.fromEntries(new URLSearchParams(o.body)); tokenCalls.push(b);
      return b.grant_type === "authorization_code" ? resp(200, { access_token: "AT-secret-1", refresh_token: "RT-secret", expires_in: 3600 }) : resp(200, { access_token: "AT-secret-2", expires_in: 3600 }); }
    if (url === "https://api.spotify.com/v1/me/player") { assert.match(o.headers.authorization, /^Bearer AT-secret-/); return resp(200, JSON.parse(fx("spotify-player.json"))); }
    throw new Error("unexpected " + url);
  };
  const s = await setup({ platform: "linux", runner: fakeRunner(cmd => cmd === "playerctl" ? { code: 1, stdout: "", stderr: "No players found" } : undefined), fetch: fakeFetch, now: () => T, wallNow: () => W });
  try {
    assert.equal((await s.call("POST", "/api/nowplaying/spotify/login")).status, 400, "needs a Client ID first");
    assert.equal((await s.call("PATCH", "/api/nowplaying", { spotifyClientId: "not an id" })).status, 400);
    assert.equal((await s.call("PATCH", "/api/nowplaying", { spotifyClientId: CID })).body.spotify.clientId, CID);
    const login = (await s.call("POST", "/api/nowplaying/spotify/login")).body, u = new URL(login.url), q = u.searchParams;
    assert.equal(u.origin + u.pathname, "https://accounts.spotify.com/authorize"); assert.equal(q.get("client_id"), CID); assert.equal(q.get("code_challenge_method"), "S256");
    assert.equal(q.get("redirect_uri"), `http://127.0.0.1:${s.port}/api/nowplaying/spotify/callback`); assert.equal(q.get("scope"), "user-read-playback-state user-read-currently-playing");
    const bad = await fetch(`${s.base}/api/nowplaying/spotify/callback?code=x&state=wrong`); assert.equal(bad.status, 400); assert.match(await bad.text(), /Connect Spotify again/);
    const good = await fetch(`${s.base}/api/nowplaying/spotify/callback?code=C1&state=${q.get("state")}`); assert.equal(good.status, 200); assert.match(await good.text(), /Spotify is connected/);
    const ex = tokenCalls[0]; assert.equal(ex.code, "C1"); assert.equal(ex.client_id, CID); assert.equal(ex.redirect_uri, q.get("redirect_uri"));
    assert.equal(crypto.createHash("sha256").update(ex.code_verifier).digest("base64url"), q.get("code_challenge"), "the verifier matches the challenge");
    assert.equal((await s.call("GET", "/api/nowplaying")).body.spotify.connected, true);
    const file = path.join(s.dir, "spotify-token.json"); assert.ok(existsSync(file)); if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);

    await s.np.poll(); const tr = (await s.call("GET", "/api/status")).body.nowPlaying;
    assert.equal(tr.source, "spotify"); assert.equal(tr.device, "Kitchen speaker"); assert.equal(tr.title, "One More Time"); near(tr.pos, 42.1, 0.05);
    for (const p of ["/api/nowplaying", "/api/state", "/api/backup", "/api/status", "/api/log"]) assert.doesNotMatch((await s.call("GET", p)).text, /secret/, `${p} must not carry Spotify tokens`);

    W += 2 * 3600_000; T += 2500; await s.np.poll(); assert.equal(tokenCalls[1].grant_type, "refresh_token"); assert.equal(tokenCalls[1].refresh_token, "RT-secret");
    assert.equal((await s.call("DELETE", "/api/nowplaying/spotify")).body.spotify.connected, false); assert.ok(!existsSync(file));
    const q2 = new URL((await s.call("POST", "/api/nowplaying/spotify/login")).body.url).searchParams; // signing in from a phone: the 127.0.0.1 address is pasted back
    const r = await s.call("POST", "/api/nowplaying/spotify/code", { url: `http://127.0.0.1:${s.port}/api/nowplaying/spotify/callback?code=C2&state=${q2.get("state")}` });
    assert.equal(r.status, 200); assert.equal(r.body.spotify.connected, true); assert.equal(tokenCalls.at(-1).code, "C2");
    assert.equal((await s.call("POST", "/api/nowplaying/spotify/code", { url: `http://127.0.0.1/x?code=C3&state=${q2.get("state")}` })).status, 400, "a sign-in link works once");
  } finally { await s.done(); }
});
