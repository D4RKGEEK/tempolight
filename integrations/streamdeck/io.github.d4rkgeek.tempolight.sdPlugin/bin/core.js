// Tempolight for Stream Deck: the plugin's logic. No packages: Node's own fetch, and a small WebSocket client
// (ws-client.js) for Stream Deck's socket and Tempolight's live status, since Stream Deck 6.4+ runs plugins on Node 20.
//
// Keys and dials call Tempolight's HTTP API (docs/api.md). The plugin also keeps Tempolight's live WebSocket (/ws)
// open, so key titles and states follow what the lights are doing: the active scene lit, strobe on, the brightness.
// With a PIN lock, the PIN entered in the key's settings unlocks it (POST /api/unlock); the token it gets is kept in
// memory only, and asked for again when Tempolight restarts.
import { openWebSocket } from "./ws-client.js";

export const UUID = "io.github.d4rkgeek.tempolight";
export const ACTIONS = { scene: `${UUID}.scene`, effect: `${UUID}.effect`, pad: `${UUID}.pad`, brightness: `${UUID}.brightness`, power: `${UUID}.power` };
const KIND = Object.fromEntries(Object.entries(ACTIONS).map(([k, v]) => [v, k]));
export const PADS = { flash: "Flash", strobe: "Strobe", blackout: "Blackout", freeze: "Freeze", build: "Build", drop: "Drop", next: "Next", tap: "Tap", cancel: "Reset" };
const TOGGLES = new Set(["strobe", "blackout", "freeze"]);

/** "192.168.1.5:8080", "tempolight.local" or "http://…" to a base address without a trailing slash. */
export function serverBase(s) { let v = String(s || "").trim(); if (!v) v = "127.0.0.1:8080"; if (!/^https?:\/\//i.test(v)) v = "http://" + v; return v.replace(/\/+$/, ""); }
/** Is this scene what the lights show now? Every setting the scene sets matches (and its brightness). */
export function sceneActive(sc, state) {
  if (!sc || !state) return false; const sh = state.show || {}, want = sc.show || {};
  for (const [k, v] of Object.entries(want)) { if (k === "params" || k === "layer") continue; if (sh[k] !== v) return false; }
  if (sc.brightness != null && Math.abs((state.settings?.brightness ?? -1) - sc.brightness) > 0.011) return false;
  return Object.keys(want).length > 0;
}
/** A title that fits a key: at most 3 lines of about 8 characters. */
export function keyTitle(s) {
  const words = String(s || "").split(/\s+/).filter(Boolean), lines = [];
  for (const w of words) { const l = lines[lines.length - 1]; if (l && (l + " " + w).length <= 8) lines[lines.length - 1] = l + " " + w; else lines.push(w.length > 9 ? w.slice(0, 8) + "…" : w); }
  return lines.slice(0, 3).join("\n");
}

/**
 * @param {{port:number|string, pluginUUID:string, registerEvent:string}} args what Stream Deck starts the plugin with
 * @param {{fetch?:Function, open?:Function, sdUrl?:string, log?:Function, retryMs?:number}} [deps] replaced in tests
 */
export function run(args, { fetch = globalThis.fetch, open = openWebSocket, sdUrl, log = () => {}, retryMs = 2000 } = {}) {
  const keys = new Map(); // context -> {kind, settings, shown:{title,state,feedback}, controller, held}
  let globals = { server: "", pin: "" }, base = "", token = null, state = null, status = null, live = null, liveTimer = null, refreshTimer = null, closed = false, error = null, gotGlobals = false;
  let pending = null, briTimer = null, sending = false; // the brightness dial
  const sd = open(sdUrl || `ws://127.0.0.1:${args.port}`);
  const out = o => { try { sd.send(JSON.stringify(o)); } catch {} };
  sd.onopen = () => { out({ event: args.registerEvent, uuid: args.pluginUUID }); out({ event: "getGlobalSettings", context: args.pluginUUID }); };
  sd.onmessage = e => { if (typeof e.data !== "string") return; let m; try { m = JSON.parse(e.data); } catch { return; } try { handle(m); } catch (err) { log(`error: ${err.message}`); } };
  sd.onclose = () => { if (!closed) { log("Stream Deck closed the connection"); stop(); } };

  // ---------------------------------------------------------------- Tempolight
  async function api(method, path, body, again = true) {
    if (!base) throw new Error("Enter Tempolight's address in the key's settings");
    const r = await fetch(base + path, { method, headers: { "content-type": "application/json", ...(token ? { "x-tempolight-token": token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    let j = null; try { j = await r.json(); } catch {}
    if (r.status === 403 && again && globals.pin) { await unlock(); return api(method, path, body, false); }
    if (!r.ok) throw new Error(j?.error || `Tempolight answered ${r.status}`);
    return j;
  }
  async function unlock() {
    const r = await fetch(base + "/api/unlock", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin: String(globals.pin) }) });
    let j = null; try { j = await r.json(); } catch {} if (!r.ok || !j?.token) throw new Error(j?.error || "Couldn't unlock Tempolight"); token = j.token;
    if (live) { const l = live; live = null; try { l.close(); } catch {} connectLive(); } // the live connection again, with the token
  }
  async function refresh() { try { state = await api("GET", "/api/state"); error = null; } catch (e) { error = e.message; } paintAll(); tellInspectors(); }
  const refreshSoon = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 150); };
  function connectLive() {
    clearTimeout(liveTimer); if (closed || !base) return;
    const url = base.replace(/^http/i, "ws") + "/ws" + (token ? `?token=${encodeURIComponent(token)}` : "");
    let s; try { s = open(url); } catch (e) { error = e.message; return later(); }
    live = s;
    s.onopen = () => { error = null; refresh(); };
    s.onmessage = e => { if (typeof e.data !== "string") return; let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === "status" || m.type === "hello") { status = m; paintAll(); } else if (m.type === "changed") refreshSoon(); };
    s.onerror = () => {};
    s.onclose = () => { if (live !== s) return; live = null; status = null; if (!error) error = `Can't reach Tempolight at ${base}`; paintAll(); later(); };
  }
  function later() { clearTimeout(liveTimer); if (closed) return; liveTimer = setTimeout(connectLive, retryMs); liveTimer.unref?.(); }
  function setGlobals(g) {
    const before = JSON.stringify([base, globals.pin]); globals = { server: String(g?.server || ""), pin: String(g?.pin || "") }; base = serverBase(globals.server); gotGlobals = true;
    if (JSON.stringify([base, globals.pin]) === before && live) return;
    token = null; state = null; status = null; if (live) { const l = live; live = null; try { l.close(); } catch {} }
    connectLive(); (globals.pin ? unlock().catch(e => { error = e.message; tellInspectors(); }) : Promise.resolve()).then(refresh);
  }

  // ---------------------------------------------------------------- keys
  const scene = k => state?.scenes?.find(s => s.id === k.settings.scene);
  function look(k) { // what a key should show now: {title, state} or, for a dial, {feedback}
    const off = !status || !state, s = k.settings || {};
    if (k.kind === "scene") { const sc = scene(k); return { title: s.title || (sc ? keyTitle(sc.name) : off ? "Scene" : "Pick a\nscene"), state: sc && !off && sceneActive(sc, state) ? 1 : 0 }; }
    if (k.kind === "effect") { const id = s.effect || "auto", fx = state?.effects?.find(e => e.id === id);
      if (id === "auto") return { title: s.title || (status && state?.show?.mode === "auto" ? `Auto\n${keyTitle(status.effectName || "")}` : "Auto"), state: state?.show?.mode === "auto" ? 1 : 0 };
      return { title: s.title || keyTitle(fx ? fx.name : id), state: state?.show?.mode === "manual" && state?.show?.effect === id ? 1 : 0 }; }
    if (k.kind === "pad") { const p = PADS[s.pad] ? s.pad : "flash", o = status?.overlay || {};
      const on = TOGGLES.has(p) ? !!o[p] : (p === "build" || p === "drop") ? o.forced === p : false;
      return { title: s.title || PADS[p], state: on ? 1 : 0 }; }
    if (k.kind === "power") { const on = status ? !!status.power : !!state?.show?.power; return { title: s.title || (off ? "Tempo\nlight" : on ? "On" : "Off"), state: on ? 1 : 0 }; }
    if (k.kind === "brightness") { const b = pending != null ? pending : status?.brightness ?? state?.settings?.brightness ?? 0, pct = Math.round(b * 100);
      return { feedback: { title: s.title || "Brightness", value: off ? "–" : status && !status.power ? "Off" : `${pct}%`, indicator: { value: off ? 0 : pct } }, title: off ? "–" : `${pct}%` }; }
    return { title: "" };
  }
  function paint(ctx, k) {
    const L = look(k), sh = k.shown;
    const t = error && !status ? "Offline" : L.title;
    if (t !== sh.title) { sh.title = t; out({ event: "setTitle", context: ctx, payload: { title: t, target: 0 } }); }
    if (L.state !== undefined && L.state !== sh.state && k.controller !== "Encoder") { sh.state = L.state; out({ event: "setState", context: ctx, payload: { state: L.state } }); }
    if (L.feedback && k.controller === "Encoder") { const f = JSON.stringify(L.feedback); if (f !== sh.feedback) { sh.feedback = f; out({ event: "setFeedback", context: ctx, payload: L.feedback }); } }
  }
  function paintAll() { for (const [ctx, k] of keys) paint(ctx, k); }
  const fail = (ctx, e) => { log(`${e.message}`); error = e.message; out({ event: "showAlert", context: ctx }); tellInspectors(); };

  async function press(ctx, k) {
    const s = k.settings || {};
    if (k.kind === "scene") { if (!s.scene) throw new Error("Pick a scene in the key's settings"); await api("POST", `/api/scenes/${encodeURIComponent(s.scene)}/apply`); }
    else if (k.kind === "effect") { const id = s.effect || "auto"; await api("PATCH", "/api/show", id === "auto" ? { mode: "auto" } : { effect: id }); }
    else if (k.kind === "power") { const on = status ? !!status.power : !!state?.show?.power; await api("POST", "/api/power", { on: !on }); if (status) status.power = !on; }
    else if (k.kind === "brightness") { await api("POST", "/api/power", { on: !(status ? status.power : true) }); }
    else if (k.kind === "pad") { const p = PADS[s.pad] ? s.pad : "flash", hold = s.mode === "hold", o = status?.overlay || {};
      if (TOGGLES.has(p)) await action({ type: p, on: hold ? true : !o[p] });
      else if (p === "flash") await action({ type: "flash", color: /^#[0-9a-f]{6}$/i.test(s.color || "") ? s.color : undefined });
      else if (p === "build") await action({ type: "build", seconds: Number(s.seconds) || 8 });
      else await action({ type: p }); }
    else return;
    if (k.kind !== "pad" && k.kind !== "brightness") refreshSoon();
  }
  async function release(ctx, k) {
    const s = k.settings || {}; if (k.kind !== "pad" || s.mode !== "hold") return; const p = PADS[s.pad] ? s.pad : "flash";
    if (TOGGLES.has(p)) await action({ type: p, on: false }); else if (p === "build") await action({ type: "drop" }); // hold to build up, let go for the drop
  }
  async function action(a) { const o = await api("POST", "/api/action", a); if (status && o && typeof o === "object") { status.overlay = o; paintAll(); } return o; }
  // the dial: turning sends at most ~15 changes a second; the value shown follows the dial at once
  function turn(ctx, k, ticks) {
    const step = Math.max(0.01, Math.min(0.25, Number(k.settings?.step) || 0.05)), cur = pending ?? status?.brightness ?? state?.settings?.brightness ?? 0.5;
    pending = Math.max(0, Math.min(1, Math.round((cur + ticks * step) * 100) / 100)); paintAll();
    if (!briTimer) briTimer = setTimeout(flushBri, 60);
  }
  async function flushBri() {
    briTimer = null; if (pending == null) return; if (sending) { briTimer = setTimeout(flushBri, 60); return; }
    const v = pending; sending = true;
    try { await api("POST", "/api/brightness", { value: v }); if (status) status.brightness = v; } catch (e) { error = e.message; }
    sending = false; if (pending === v) pending = null; else briTimer = setTimeout(flushBri, 30); paintAll();
  }

  // ---------------------------------------------------------------- the property inspector (the key's settings)
  const inspectors = new Map(); // context -> action uuid, while its settings are open
  function tellInspectors() { for (const [ctx, action] of inspectors) toInspector(ctx, action); }
  function toInspector(ctx, action) {
    out({ event: "sendToPropertyInspector", action, context: ctx, payload: { type: "info", connected: !!status, error: status ? null : error, server: base, locked: !!state?.locked, hasToken: !!token,
      scenes: (state?.scenes || []).map(s => ({ id: s.id, name: s.name })), effects: (state?.effects || []).map(e => ({ id: e.id, name: e.name })), pads: PADS } });
  }

  function handle(m) {
    const ctx = m.context, p = m.payload || {};
    switch (m.event) {
      case "didReceiveGlobalSettings": setGlobals(p.settings || {}); tellInspectors(); break;
      case "willAppear": { const kind = KIND[m.action]; if (!kind) return; keys.set(ctx, { kind, settings: p.settings || {}, controller: p.controller || "Keypad", shown: {} }); if (!gotGlobals) out({ event: "getGlobalSettings", context: args.pluginUUID }); paint(ctx, keys.get(ctx)); break; }
      case "willDisappear": keys.delete(ctx); inspectors.delete(ctx); break;
      case "didReceiveSettings": { const k = keys.get(ctx); if (k) { k.settings = p.settings || {}; k.shown = {}; paint(ctx, k); } break; }
      case "keyDown": case "dialDown": case "touchTap": { const k = keys.get(ctx); if (!k) return; if (m.event !== "keyDown" && k.kind !== "brightness") return; k.held = true; press(ctx, k).catch(e => fail(ctx, e)); break; }
      case "keyUp": case "dialUp": { const k = keys.get(ctx); if (!k) return; k.held = false; if (m.event === "keyUp") release(ctx, k).catch(e => fail(ctx, e)); break; }
      case "dialRotate": { const k = keys.get(ctx); if (k && k.kind === "brightness") turn(ctx, k, Number(p.ticks) || 0); break; }
      case "propertyInspectorDidAppear": inspectors.set(ctx, m.action); toInspector(ctx, m.action); break;
      case "propertyInspectorDidDisappear": inspectors.delete(ctx); break;
      case "sendToPlugin": if (p.type === "refresh") { inspectors.set(ctx, m.action); refresh().then(() => toInspector(ctx, m.action)); } break;
      case "systemDidWakeUp": if (!live) connectLive(); break;
      default: break;
    }
  }
  function stop() { closed = true; clearTimeout(liveTimer); clearTimeout(refreshTimer); clearTimeout(briTimer); if (live) { const l = live; live = null; try { l.close(); } catch {} } }
  return { handle, keys, get state() { return state; }, get status() { return status; }, get error() { return error; }, get token() { return token; }, close() { stop(); try { sd.close(); } catch {} } };
}

/** Stream Deck starts plugins as: node plugin.js -port 28196 -pluginUUID … -registerEvent registerPlugin -info {…} */
export function parseArgs(argv) { const o = {}; for (let i = 0; i < argv.length; i++) if (/^-\w+$/.test(argv[i]) && i + 1 < argv.length) { o[argv[i].slice(1)] = argv[i + 1]; i++; } return o; }
