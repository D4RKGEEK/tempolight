// The Stream Deck plugin (integrations/streamdeck) against a pretend Stream Deck: a WebSocket server that speaks the
// Stream Deck SDK's events (registerPlugin, willAppear, keyDown/keyUp, dialRotate, didReceiveGlobalSettings, ...),
// and a real Tempolight. Also checks the manifest and the packed .streamDeckPlugin.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.js";
import { attachWebSocket } from "../src/ws.js";
import { openWebSocket } from "../src/integrations/ws-client.js";
import { unzip } from "../src/integrations/zip.js";
import { run, ACTIONS, sceneActive, keyTitle, serverBase, parseArgs } from "../../../integrations/streamdeck/io.github.d4rkgeek.tempolight.sdPlugin/bin/core.js";
import { packageStreamDeck } from "../../../scripts/package-streamdeck.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."), PLUGIN = path.join(ROOT, "integrations/streamdeck/io.github.d4rkgeek.tempolight.sdPlugin");
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 5000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(25); } return false; }

/** A pretend Stream Deck: records what the plugin sends; send() talks to it. */
async function fakeStreamDeck() {
  const got = [], srv = http.createServer(), sd = { got, conn: null };
  attachWebSocket(srv, "/", c => { sd.conn = c; c.onmessage = m => got.push(JSON.parse(m)); });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  sd.port = srv.address().port; sd.url = `ws://127.0.0.1:${sd.port}`;
  sd.send = o => sd.conn.sendJSON(o);
  sd.last = (event, context) => got.filter(m => m.event === event && (!context || m.context === context)).at(-1);
  sd.close = () => { sd.conn?.close(); return new Promise(r => srv.close(r)); };
  return sd;
}

test("stream deck plugin: small helpers", () => {
  assert.equal(serverBase(""), "http://127.0.0.1:8080"); assert.equal(serverBase("192.168.1.5:8080/"), "http://192.168.1.5:8080"); assert.equal(serverBase("https://tl.example"), "https://tl.example");
  assert.equal(keyTitle("Party mode"), "Party\nmode"); assert.equal(keyTitle("A very longwordindeed"), "A very\nlongword…");
  assert.deepEqual(parseArgs(["-port", "28196", "-pluginUUID", "ABC", "-registerEvent", "registerPlugin", "-info", "{}"]), { port: "28196", pluginUUID: "ABC", registerEvent: "registerPlugin", info: "{}" });
  const st = { show: { mode: "auto", style: "party", palette: "auto", effect: "shock" }, settings: { brightness: 1 } };
  assert.equal(sceneActive({ show: { mode: "auto", style: "party", palette: "auto" }, brightness: 1 }, st), true);
  assert.equal(sceneActive({ show: { mode: "auto", style: "chill", palette: "sunset" }, brightness: 0.55 }, st), false);
});

test("stream deck plugin: keys and a dial drive Tempolight, and show its live status", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tl-sd-")), app = await createApp({ dataDir: dir, discover: false, logger: null }), port = await app.listen(0, "127.0.0.1");
  const call = async (m, p, b, h = {}) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: m, headers: { "content-type": "application/json", ...h }, body: b === undefined ? undefined : JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
  const sd = await fakeStreamDeck();
  const plugin = run({ port: sd.port, pluginUUID: "PLUGIN-1", registerEvent: "registerPlugin" }, { open: url => openWebSocket(url, { tiny: true }), retryMs: 200 }); // Stream Deck's Node 20: the small client
  const D = () => app.runtime.director.state.overlay, data = () => app.store.data;
  try {
    assert.ok(await until(() => sd.got.some(m => m.event === "registerPlugin" && m.uuid === "PLUGIN-1")), "registers");
    assert.ok(await until(() => sd.last("getGlobalSettings", "PLUGIN-1")), "asks for its settings");
    const appear = (context, kind, settings, controller = "Keypad") => sd.send({ event: "willAppear", action: ACTIONS[kind], context, device: "DEV", payload: { settings, controller, coordinates: { column: 0, row: 0 }, isInMultiAction: false } });
    appear("k-scene", "scene", { scene: "party" }); appear("k-auto", "effect", { effect: "auto" }); appear("k-strobe", "pad", { pad: "strobe", mode: "hold" });
    appear("k-build", "pad", { pad: "build", mode: "hold" }); appear("k-flash", "pad", { pad: "flash", color: "#00ff00" }); appear("k-power", "power", {}); appear("d-bri", "brightness", { step: 0.05 }, "Encoder");
    sd.send({ event: "didReceiveGlobalSettings", payload: { settings: { server: `127.0.0.1:${port}` } } });
    assert.ok(await until(() => sd.last("setTitle", "k-scene")?.payload.title === "Party\nmode"), "the scene's name on its key");
    assert.ok(await until(() => /^Auto\n/.test(sd.last("setTitle", "k-auto")?.payload.title || "")), "automatic shows the effect playing");
    assert.ok(await until(() => sd.last("setState", "k-auto")?.payload.state === 1), "automatic is on");
    assert.ok(await until(() => sd.last("setFeedback", "d-bri")?.payload.value === "80%"), "the dial shows the brightness");
    // a scene
    data().show.style = "chill";
    sd.send({ event: "keyDown", action: ACTIONS.scene, context: "k-scene", payload: { settings: { scene: "party" } } }); sd.send({ event: "keyUp", action: ACTIONS.scene, context: "k-scene", payload: { settings: { scene: "party" } } });
    assert.ok(await until(() => data().show.style === "party" && data().settings.brightness === 1), "Party mode on");
    assert.ok(await until(() => sd.last("setState", "k-scene")?.payload.state === 1), "and its key lit");
    // hold strobe: on while held
    sd.send({ event: "keyDown", action: ACTIONS.pad, context: "k-strobe", payload: {} }); assert.ok(await until(() => D().strobe === true), "strobe while held");
    assert.ok(await until(() => sd.last("setState", "k-strobe")?.payload.state === 1));
    sd.send({ event: "keyUp", action: ACTIONS.pad, context: "k-strobe", payload: {} }); assert.ok(await until(() => D().strobe === false), "let go: off");
    // hold build: build up while held, the drop on release
    sd.send({ event: "keyDown", action: ACTIONS.pad, context: "k-build", payload: {} }); assert.ok(await until(() => app.runtime.rt.forced?.kind === "build"), "build-up");
    sd.send({ event: "keyUp", action: ACTIONS.pad, context: "k-build", payload: {} }); assert.ok(await until(() => app.runtime.rt.forced?.kind === "drop"), "the drop");
    const f0 = D().flashT || 0; sd.send({ event: "keyDown", action: ACTIONS.pad, context: "k-flash", payload: {} }); assert.ok(await until(() => D().flashT > f0)); assert.deepEqual(D().flashColor, [0, 1, 0], "flash in the key's colour");
    // the dial: 4 clicks down is 20% less; pressing it turns the lights off
    sd.send({ event: "dialRotate", action: ACTIONS.brightness, context: "d-bri", payload: { ticks: -2, pressed: false, settings: { step: 0.05 } } });
    sd.send({ event: "dialRotate", action: ACTIONS.brightness, context: "d-bri", payload: { ticks: -2, pressed: false, settings: { step: 0.05 } } });
    assert.ok(await until(() => Math.abs(data().settings.brightness - 0.8) < 1e-9), `brightness ${data().settings.brightness}`);
    assert.ok(await until(() => sd.last("setFeedback", "d-bri")?.payload.value === "80%" && sd.last("setFeedback", "d-bri")?.payload.indicator.value === 80));
    sd.send({ event: "keyDown", action: ACTIONS.power, context: "k-power", payload: {} }); assert.ok(await until(() => data().show.power === false), "power off");
    assert.ok(await until(() => sd.last("setTitle", "k-power")?.payload.title === "Off" && sd.last("setState", "k-power")?.payload.state === 0));
    assert.ok(await until(() => sd.last("setFeedback", "d-bri")?.payload.value === "Off"), "the dial says the lights are off");
    sd.send({ event: "dialDown", action: ACTIONS.brightness, context: "d-bri", payload: {} }); assert.ok(await until(() => data().show.power === true), "pressing the dial: on again");
    // a change made elsewhere (the web app) shows on the keys
    await call("POST", "/api/scenes/chill/apply"); assert.ok(await until(() => sd.last("setState", "k-scene")?.payload.state === 0), "another scene: the key goes dark");
    // the key's settings window gets the scenes and effects
    sd.send({ event: "propertyInspectorDidAppear", action: ACTIONS.scene, context: "k-scene", device: "DEV" });
    assert.ok(await until(() => sd.last("sendToPropertyInspector", "k-scene")?.payload.scenes?.some(s => s.name === "Party mode")));
    assert.equal(sd.last("sendToPropertyInspector", "k-scene").payload.connected, true);
    // locked with a PIN: without it, a key shows an alert; with it, the plugin unlocks by itself
    await call("POST", "/api/lock", { pin: "1357" }); await call("PATCH", "/api/settings", { guest: { scenes: false, pads: false, effects: false, brightness: false } }, { "x-tempolight-token": (await call("POST", "/api/unlock", { pin: "1357" })).body.token });
    const alerts = () => sd.got.filter(m => m.event === "showAlert" && m.context === "k-scene").length, a0 = alerts();
    sd.send({ event: "keyDown", action: ACTIONS.scene, context: "k-scene", payload: {} }); assert.ok(await until(() => alerts() > a0), "locked: an alert");
    sd.send({ event: "didReceiveGlobalSettings", payload: { settings: { server: `127.0.0.1:${port}`, pin: "1357" } } });
    assert.ok(await until(() => !!plugin.token), "unlocked with the PIN");
    sd.send({ event: "keyDown", action: ACTIONS.scene, context: "k-scene", payload: {} }); assert.ok(await until(() => data().show.style === "party"), "works again");
    // Tempolight goes away: the keys say so
    await app.close(); assert.ok(await until(() => sd.last("setTitle", "k-scene")?.payload.title === "Offline"), "offline");
  } finally { plugin.close(); await sd.close(); try { await app.close(); } catch {} rmSync(dir, { recursive: true, force: true }); }
});

test("stream deck plugin: the manifest is complete and the package holds every file it names", () => {
  const m = JSON.parse(readFileSync(path.join(PLUGIN, "manifest.json"), "utf8"));
  assert.equal(m.SDKVersion, 2); assert.equal(m.UUID, "io.github.d4rkgeek.tempolight"); assert.equal(m.Nodejs.Version, "20"); assert.ok(/^\d+\.\d+\.\d+\.\d+$/.test(m.Version));
  assert.deepEqual(m.Actions.map(a => a.UUID).sort(), Object.values(ACTIONS).sort());
  const img = p => ["", ".svg", ".png"].some(e => existsSync(path.join(PLUGIN, p + e)));
  for (const p of [m.Icon, m.CategoryIcon, ...m.Actions.flatMap(a => [a.Icon, ...(a.States || []).map(s => s.Image), a.Encoder?.Icon].filter(Boolean))]) assert.ok(img(p), `image ${p}`);
  assert.ok(existsSync(path.join(PLUGIN, m.CodePath))); assert.ok(existsSync(path.join(PLUGIN, m.PropertyInspectorPath)));
  assert.ok(m.Actions.find(a => a.UUID === ACTIONS.brightness).Controllers.includes("Encoder"));
  assert.equal(JSON.parse(readFileSync(path.join(PLUGIN, "package.json"), "utf8")).type, "module", "bin/*.js are ES modules");
  const out = path.join(mkdtempSync(path.join(os.tmpdir(), "tl-sdp-")), "t.streamDeckPlugin"), r = packageStreamDeck(out), files = unzip(readFileSync(r.out)).map(f => f.name);
  for (const f of ["manifest.json", "bin/plugin.js", "bin/core.js", "bin/ws-client.js", "ui/inspector.html", "imgs/plugin.png"]) assert.ok(files.includes(`io.github.d4rkgeek.tempolight.sdPlugin/${f}`), f);
  assert.ok(!files.some(f => /\.test\.js$|\/\./.test(f)));
  rmSync(path.dirname(out), { recursive: true, force: true });
});
