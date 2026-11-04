import test from "node:test";
import assert from "node:assert/strict";
import { hearLine, wantsAutoMic } from "./hearline.js";

const sp = (mode, learn, extra = {}) => ({ on: true, mode, learn, track: { title: "One More Time", playing: true }, ...extra });

test("status line: hearing, learning, following, or can't hear", () => {
  assert.deepEqual(hearLine({ source: "capture", spotify: sp("learning", { state: "learning", pct: 42 }), hearing: { via: "capture", sound: true, label: "BlackHole 2ch" } }),
    { ok: true, text: "Hearing Spotify ✓ · One More Time · learning 42%" });
  assert.equal(hearLine({ source: "capture", spotify: sp("live", { state: "learned", pct: 100 }), hearing: { via: "capture", sound: true } }).text, "Hearing Spotify ✓ · One More Time · learned");
  assert.equal(hearLine({ source: "nowplaying", spotify: sp("exact", null), hearing: {} }).text, "Following Spotify ✓ · One More Time · learned", "a learned song needs nothing heard");
  const no = hearLine({ source: "idle", spotify: sp("live", null), hearing: { via: null } });
  assert.equal(no.ok, false); assert.equal(no.text, "Can't hear anything"); assert.ok(no.fix); assert.match(no.why, /isn't learned yet/);
  const silent = hearLine({ source: "capture", spotify: sp("live", null), hearing: { via: "capture", sound: false, label: "BlackHole 2ch", problem: "BlackHole is silent while music plays: …" } });
  assert.equal(silent.ok, false); assert.match(silent.why, /BlackHole is silent/);
  assert.equal(hearLine({ source: "idle", nowPlaying: { app: "Music", title: "Song", playing: true }, hearing: {} }).ok, false, "Apple Music too");
  assert.deepEqual(hearLine({ source: "idle", hearing: { method: "" } }), { ok: null, text: "Not listening", fix: true, why: "Tempolight hears nothing yet." });
  assert.equal(hearLine({ source: "idle", hearing: { method: "computer", capture: { running: true, label: "BlackHole 2ch" } } }).text, "Listening (BlackHole 2ch) · waiting for music");
  assert.equal(hearLine({ source: "song", song: { name: "Demo" }, hearing: { via: "browser", sound: true } }).text, "Playing Demo ✓");
  assert.equal(hearLine({ source: "idle", hearing: { method: "computer", capture: { error: "ffmpeg stopped" }, problem: "Listening on the server stopped: ffmpeg stopped" } }).ok, false);
});

test("microphone starts by itself only when chosen, Spotify plays a song it doesn't know, and nothing else is heard", () => {
  const m = { source: "idle", spotify: sp("live", null), hearing: { via: null } }, ctx = { method: "mic", mode: null, now: 100000, lastTry: 0 };
  assert.equal(wantsAutoMic(m, ctx), true);
  assert.equal(wantsAutoMic(m, { ...ctx, method: "computer" }), false);
  assert.equal(wantsAutoMic(m, { ...ctx, mode: "mic" }), false, "already listening");
  assert.equal(wantsAutoMic(m, { ...ctx, lastTry: 90000 }), false, "tried 10 s ago");
  assert.equal(wantsAutoMic({ ...m, spotify: sp("exact", null), source: "nowplaying" }, ctx), false, "learned: nothing to hear");
  assert.equal(wantsAutoMic({ ...m, hearing: { via: "capture" } }, ctx), false, "server capture already hears it");
  assert.equal(wantsAutoMic({ ...m, spotify: { ...sp("paused", null), track: { title: "x", playing: false } } }, ctx), false, "paused");
});
