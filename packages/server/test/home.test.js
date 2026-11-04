// Home & sleep: sunrise alarm, sleep timer and the ambient plan, with an injected clock.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import { startFakeWled } from "../../../scripts/fake-wled.js";
import { wakeWindow, keyAt, sunriseColor, sunriseLevel, planIndex, kelvinRGB, DEFAULT_PLAN_ROWS } from "../src/home.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const MIN = 60_000;
async function setup() {
  const clock = { t: +new Date(2026, 10, 2, 6, 0, 0) }; // a Monday, 06:00
  const dir = mkdtempSync(path.join(os.tmpdir(), "tl-home-")), app = await createApp({ dataDir: dir, discover: false, logger: null, now: () => new Date(clock.t) });
  const port = await app.listen(0, "127.0.0.1"), base = `http://127.0.0.1:${port}`;
  const call = async (method, p, body, headers = {}) => { const r = await fetch(base + p, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  await call("PATCH", "/api/settings", { fps: 20 }); // light on the CPU: other test files measure speed at the same time
  const wled = await startFakeWled({ leds: 60 });
  const dev = (await call("POST", "/api/devices", { host: wled.host })).body; await call("PATCH", `/api/devices/${dev.id}`, { ddpPort: wled.ddpPort });
  const home = app.core.home, at = (h, m, s = 0, day = 2) => { clock.t = +new Date(2026, 10, day, h, m, s); home.tick(); };
  const frame = async () => { const n = wled.frames; while (wled.frames < n + 3) await sleep(10); const f = wled.lastFrame, c = [0, 0, 0]; for (let i = 0; i < f.length; i++) c[i % 3] += f[i]; return c.map(v => v / (f.length / 3)); };
  return { app, call, clock, home, at, frame, wled, st: () => app.runtime.status().home,
    async done() { await app.close(); wled.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("wake-up maths: alarm windows, keyframes, sunrise colours, plan rows across midnight", () => {
  const now = +new Date(2026, 10, 2, 22, 0);
  let w = wakeWindow({ at: "07:00", duration: 30 }, now); assert.equal(new Date(w.end).getDate(), 3, "07:00 is tomorrow morning"); assert.equal(w.end - w.start, 30 * MIN);
  w = wakeWindow({ inMinutes: 10, duration: 30 }, now); assert.equal(w.start, now, "an alarm closer than the sunrise starts now"); assert.equal(w.end, now + 10 * MIN);
  w = wakeWindow({ duration: 15 }, now); assert.deepEqual([w.start, w.end], [now, now + 15 * MIN], "no alarm: start now");
  w = wakeWindow({ at: now + 60 * MIN }, now, 20); assert.equal(w.start, now + 40 * MIN, "milliseconds (Tasker's %na_time_ms)");
  w = wakeWindow({ at: Math.round((now + 60 * MIN) / 1000) }, now, 20); assert.equal(w.end, now + 60 * MIN, "seconds");
  w = wakeWindow({ at: new Date(now + 90 * MIN).toISOString() }, now, 30); assert.equal(w.end, now + 90 * MIN, "ISO date (Home Assistant)");
  assert.equal(wakeWindow({ at: "soon" }, now), null); assert.equal(wakeWindow({ at: now + 3 * 24 * 60 * MIN }, now), null, "more than 36 hours away");
  const k = [{ t: 0, p: 0 }, { t: 10, p: 1 }, { t: 20, p: 0.3 }]; assert.equal(keyAt(k, -5), 0); assert.equal(keyAt(k, 5), 0.5); assert.ok(Math.abs(keyAt(k, 15) - 0.65) < 1e-9); assert.equal(keyAt(k, 99), 0.3);
  const c0 = sunriseColor(0), c1 = sunriseColor(1, [1, 0.9, 0.8]); assert.ok(c0[0] > 10 * c0[1] && c0[2] === 0, "starts deep red"); assert.deepEqual(c1, [1, 0.9, 0.8], "ends at the end colour");
  assert.ok(sunriseLevel(0) < 0.02 && sunriseLevel(0.5) < 0.3 && sunriseLevel(1) === 1, "a faint glow first, most light at the end");
  const warm = kelvinRGB(2200), cool = kelvinRGB(6500); assert.ok(warm[2] < 0.5 && cool[2] > 0.9 && warm[0] === 1, "colour temperatures");
  const rows = [{ from: "22:00", to: "02:00" }, { from: "02:00", to: "22:00" }];
  assert.equal(planIndex(rows, new Date(2026, 0, 1, 23, 30)), 0); assert.equal(planIndex(rows, new Date(2026, 0, 2, 1, 59)), 0, "after midnight"); assert.equal(planIndex(rows, new Date(2026, 0, 2, 2, 0)), 1);
  assert.equal(planIndex(DEFAULT_PLAN_ROWS(), new Date(2026, 0, 2, 3, 0)), 4, "the default plan's night row covers 03:00");
});

test("sunrise: ramps from deep red to warm white at its own brightness, pads still work, then hands back", async () => {
  const s = await setup();
  try {
    assert.equal((await s.call("POST", "/api/wake", {})).status, 409, "refused while wake-up is off");
    await s.call("PUT", "/api/home", { wake: { enabled: true, source: "phone", duration: 30, endColor: "#ffd2a1" } });
    // a low brightness slider and night mode (cap 20%) must not stop the alarm getting bright
    await s.call("PATCH", "/api/settings", { brightness: 0.2, night: { enabled: true, from: "23:00", to: "07:00", maxBrightness: 0.2 } }); s.app.runtime.updateNight();
    assert.equal(s.app.runtime.status().night, true);
    await s.call("POST", "/api/power", { on: false });
    const r = await s.call("POST", "/api/wake", { at: "06:30" }); assert.equal(r.status, 200); assert.equal(r.body.wake.phase, "rising");
    assert.equal(s.app.store.data.show.power, true, "the sunrise turns the lights on"); for (let k = 0; k < 50 && !s.wled.state.on; k++) await sleep(20); assert.equal(s.wled.state.on, true, "WLED told to switch on");
    s.at(6, 2); const early = await s.frame(); assert.ok(early[0] > 0 && early[0] < 60 && early[0] > 4 * (early[1] + early[2] + 0.1), `early: dim deep red ${early.map(Math.round)}`);
    s.at(6, 15); const mid = await s.frame(); assert.ok(mid[0] > early[0] * 2 && mid[1] < mid[0] * 0.6, `halfway: brighter, orange ${mid.map(Math.round)}`);
    s.at(6, 30); const end = await s.frame(); assert.ok(end[0] > 240 && end[1] > 180 && end[2] > 120, `full: warm white at full brightness ${end.map(Math.round)}`);
    assert.equal(s.st().wake.phase, "holding");
    await s.call("POST", "/api/action", { type: "blackout", on: true }); assert.ok((await s.frame()).every(v => v === 0), "blackout still works over the sunrise");
    await s.call("POST", "/api/action", { type: "blackout", on: false });
    // the alarm is stopped on the phone: back to the show (night-capped ambient) within a few seconds
    assert.equal((await s.call("POST", "/api/wake/stop")).body.wake.phase, "ending");
    s.at(6, 30, 10); assert.equal(s.st().wake, null, "sunrise gone after the fade");
    const after = await s.frame(); assert.ok(after[0] + after[1] + after[2] < (end[0] + end[1] + end[2]) * 0.5, `show again ${after.map(Math.round)}`);
  } finally { await s.done(); }
});

test("sunrise: snooze dims to a glow and comes back; holds, then ends by itself; switching off stops it", async () => {
  const s = await setup();
  try {
    await s.call("PUT", "/api/home", { wake: { enabled: true, source: "phone", duration: 20, holdMin: 10, snoozeMin: 9 } });
    await s.call("POST", "/api/wake", { inMinutes: 20 }); s.at(6, 20);
    assert.equal(s.st().wake.progress, 1);
    const sn = await s.call("POST", "/api/wake/snooze"); assert.equal(sn.body.wake.phase, "snoozed");
    s.at(6, 20, 10); assert.equal(s.st().wake.progress, 0.3, "dimmed to a glow");
    s.at(6, 28); assert.equal(s.st().wake.progress, 0.3); assert.equal(s.st().wake.phase, "snoozed");
    s.at(6, 30, 30); assert.equal(s.st().wake.phase, "rising"); assert.ok(s.st().wake.progress > 0.4 && s.st().wake.progress < 1, "rising again after the snooze");
    s.at(6, 32); assert.equal(s.st().wake.progress, 1);
    s.at(6, 42, 1); assert.equal(s.st().wake.phase, "ending", "the hold is over"); s.at(6, 43, 2); assert.equal(s.st().wake, null);
    await s.call("POST", "/api/wake", {}); s.at(6, 44); assert.equal(s.st().wake.phase, "rising");
    await s.call("POST", "/api/power", { on: false }); s.home.tick(); s.home.tick(); assert.equal(s.st().wake, null, "lights switched off: the sunrise stops");
    // a phone sending tomorrow's alarm while a sunrise runs doesn't cut it short
    await s.call("POST", "/api/wake", {}); s.at(6, 45);
    const nx = await s.call("POST", "/api/wake", { at: "07:00", duration: 10 }); assert.equal(nx.body.wake.phase, "rising"); assert.ok(nx.body.nextWake.includes("T"), "next sunrise kept for later");
    await s.call("DELETE", "/api/wake"); assert.equal(s.st().nextWake, null, "next one cancelled"); assert.equal(s.st().wake.phase, "rising", "the running one stays");
  } finally { await s.done(); }
});

test("weekly wake-up times start the sunrise before the alarm; skip works", async () => {
  const s = await setup();
  try {
    await s.call("PUT", "/api/home", { wake: { enabled: true, source: "times", days: ["", "07:00", "07:00", "07:00", "07:00", "07:00", ""], duration: 20 } });
    assert.equal((await s.call("PUT", "/api/home", { wake: { duration: 50 } })).status, 400, "10 to 40 minutes");
    assert.equal((await s.call("PUT", "/api/home", { wake: { days: ["7am"] } })).status, 400);
    await s.call("POST", "/api/power", { on: false });
    s.at(6, 39); assert.equal(s.st().wake, null); assert.equal(new Date(s.st().nextWake).getHours(), 7);
    s.at(6, 40, 1); assert.equal(s.st().wake.phase, "rising", "20 minutes before 07:00"); assert.equal(new Date(s.st().wake.end).getMinutes(), 0);
    assert.equal(s.app.store.data.show.power, true);
    s.at(7, 0); s.at(7, 1); assert.equal(s.st().wake.progress, 1, "only once per alarm");
    await s.call("POST", "/api/wake/stop"); s.at(7, 2); assert.equal(s.st().wake, null);
    s.at(7, 3); assert.equal(s.st().wake, null, "a stopped alarm doesn't come back");
    assert.equal(new Date(s.st().nextWake).getDate(), 3, "next: tomorrow");
    await s.call("DELETE", "/api/wake"); assert.equal(new Date(s.st().nextWake).getDate(), 4, "skipped tomorrow");
    s.at(6, 50, 0, 3); assert.equal(s.st().wake, null, "tomorrow skipped");
    s.at(6, 41, 0, 7); assert.equal(s.st().wake, null, "Saturday has no alarm");
  } finally { await s.done(); }
});

test("wind-down: fades warm to off over the minutes, cancelled by a brightness or power change", async () => {
  const s = await setup();
  try {
    await s.call("PUT", "/api/home", { plan: { enabled: true, rows: [{ name: "All day", from: "00:00", to: "23:59", look: "white", kelvin: 6500, brightness: 1 }] } });
    s.at(19, 0); s.at(20, 0); const before = await s.frame();
    const r = await s.call("POST", "/api/sleep", { minutes: 30 }); assert.equal(r.status, 200); assert.equal(r.body.sleep.left, 1800);
    s.at(20, 10); const warm = await s.frame(); assert.ok(warm[2] < before[2] * 0.4 && warm[0] > warm[2] * 2, `warmer ${before.map(Math.round)} -> ${warm.map(Math.round)}`);
    s.at(20, 25); const dim = await s.frame(); assert.ok(dim[0] < warm[0] * 0.5, `dimmer ${dim.map(Math.round)}`);
    s.at(20, 30, 1); assert.equal(s.st().sleep, null); assert.equal(s.app.store.data.show.power, false, "off at the end");
    assert.equal(s.app.store.data.settings.brightness, 0.8, "the brightness setting is untouched for tomorrow");
    await s.call("POST", "/api/power", { on: true });
    await s.call("POST", "/api/sleep", {}); s.at(20, 35); assert.ok(s.st().sleep);
    await s.call("POST", "/api/brightness", { value: 0.5 }); s.home.tick(); assert.equal(s.st().sleep, null, "brightness changed: cancelled");
    await s.call("POST", "/api/sleep", { minutes: 10 }); await s.call("POST", "/api/power", { on: false }); s.home.tick(); assert.equal(s.st().sleep, null, "power off: cancelled");
    await s.call("POST", "/api/sleep", { minutes: 10 }); await s.call("DELETE", "/api/sleep"); assert.equal(s.st().sleep, null);
    assert.equal((await s.call("POST", "/api/sleep", { minutes: 0 })).status, 400);
  } finally { await s.done(); }
});

test("ambient plan: hourly looks crossfade, rows cross midnight, night rows turn night mode on", async () => {
  const s = await setup();
  try {
    assert.equal((await s.call("GET", "/api/home")).body.plan.enabled, false, "off unless turned on");
    assert.equal((await s.call("PUT", "/api/home", { plan: { rows: [{ name: "x", from: "7am", to: "09:00", look: "white" }] } })).status, 400);
    assert.equal((await s.call("PUT", "/api/home", { plan: { rows: [{ name: "x", from: "07:00", to: "09:00", look: "nope" }] } })).status, 400);
    await s.call("PUT", "/api/home", { plan: { enabled: true, fade: 60, reset: true } });
    s.at(8, 0); s.at(8, 59, 50); assert.equal(s.st().plan.name, "Morning"); assert.equal(s.app.runtime.rt.home.idleBrightness(), 0.8);
    s.at(9, 0, 0); s.at(9, 0, 30); assert.equal(s.st().plan.name, "Daytime"); assert.equal(s.st().plan.fading, true);
    const mid = s.app.runtime.rt.home.idleBrightness(); assert.ok(mid < 0.8 && mid > 0.6, `brightness crossfades (${mid})`);
    s.at(9, 1, 31); assert.equal(s.st().plan.fading, false); assert.equal(s.app.runtime.rt.home.idleBrightness(), 0.6);
    const day = await s.frame(); assert.ok(day[0] > 0 && day[2] > day[0] * 0.6, `neutral white ${day.map(Math.round)}`);
    s.at(22, 0); s.at(22, 5); const late = await s.frame(); assert.equal(s.st().plan.name, "Late evening"); assert.ok(late[2] < late[0] * 0.6, `warm ${late.map(Math.round)}`);
    assert.equal(s.app.runtime.status().night, false);
    s.at(23, 30); assert.equal(s.st().plan.name, "Night"); assert.equal(s.app.runtime.status().night, true, "a night row turns night mode on");
    assert.equal(s.app.runtime.director.settings.safe, true, "no strobes");
    s.at(3, 0, 0, 3); assert.equal(s.st().plan.name, "Night", "still night after midnight"); assert.equal(s.app.runtime.status().night, true);
    s.at(7, 30, 0, 3); assert.equal(s.st().plan.name, "Morning"); assert.equal(s.app.runtime.status().night, false, "and off in the morning");
    // night mode's own hours win over a plan row: the night look then, capped by night mode
    await s.call("PATCH", "/api/settings", { night: { enabled: true, from: "07:00", to: "08:00", maxBrightness: 0.25 } }); s.app.runtime.updateNight(); s.at(7, 31, 0, 3);
    s.at(7, 40, 0, 3); assert.equal(s.st().plan.night, true); assert.equal(s.st().plan.name, "Night"); assert.ok(s.app.runtime.rt.home.idleBrightness() <= 0.25);
    await s.call("PATCH", "/api/settings", { night: { enabled: false } }); s.app.runtime.updateNight();
    // turning the plan off fades back to the usual ambient
    s.at(10, 0, 0, 3); await s.call("PUT", "/api/home", { plan: { enabled: false } }); s.at(10, 0, 20, 3); assert.equal(s.st().plan.fading, true);
    s.at(10, 2, 0, 3); assert.equal(s.st().plan, null); assert.equal(s.app.runtime.rt.home.idleBrightness(), undefined);
  } finally { await s.done(); }
});

test("phone links: the wake-up key works only for wake and sleep calls, and is never shown to guests", async () => {
  const s = await setup();
  try {
    await s.call("PUT", "/api/home", { wake: { enabled: true } });
    const key = (await s.call("GET", "/api/home")).body.wake.key; assert.match(key, /^[0-9a-f]{32}$/);
    const tok = (await s.call("POST", "/api/lock", { pin: "2468" })).body.token, admin = { "x-tempolight-token": tok };
    assert.equal((await s.call("POST", "/api/wake", {})).status, 200, "guests may (brightness is a guest area)");
    await s.call("PATCH", "/api/settings", { guest: { brightness: false } }, admin);
    assert.equal((await s.call("POST", "/api/wake", {})).status, 403);
    assert.equal((await s.call("POST", "/api/wake?key=" + "0".repeat(32), {})).status, 403, "wrong key");
    assert.equal((await s.call("POST", "/api/wake/snooze?key=" + key, {})).status, 200);
    assert.equal((await s.call("POST", "/api/wake", { key })).status, 200, "key in the body");
    assert.equal((await s.call("POST", "/api/sleep", {}, { "x-tempolight-key": key })).status, 200, "key in a header");
    assert.equal((await s.call("PATCH", "/api/settings?key=" + key, { fps: 30 })).status, 403, "the key opens nothing else");
    assert.equal((await s.call("PUT", "/api/home?key=" + key, { wake: { enabled: false } })).status, 403);
    assert.equal((await s.call("GET", "/api/home")).body.wake.key, undefined, "not shown without the PIN");
    assert.ok(!JSON.stringify((await s.call("GET", "/api/state")).body).includes(key));
    assert.equal((await s.call("GET", "/api/home", undefined, admin)).body.wake.key, key);
    const nk = (await s.call("POST", "/api/wake/key", {}, admin)).body.key; assert.notEqual(nk, key);
    assert.equal((await s.call("POST", "/api/wake/stop?key=" + key, {})).status, 403, "the old key stops working");
  } finally { await s.done(); }
});
