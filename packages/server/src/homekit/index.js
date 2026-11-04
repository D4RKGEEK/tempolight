// Apple Home (HomeKit) for Tempolight: a HomeKit bridge on this computer, found by iPhones over mDNS, paired with the
// setup code (or QR code) shown in Settings → Apple Home. Then Tempolight's light, its scenes and "Music reactive" are
// in the Home app, in Control Centre, in automations and in Siri ("Hey Siri, turn on Party mode").
//
// The bridge's identity (device ID and Ed25519 key), setup code and the paired controllers are kept in
// <data dir>/homekit.json, not in tempolight.json, so backups never carry them. Resetting makes a new identity and
// code: the Home app then sees a new accessory (remove the old one there).
//
// API: GET /api/homekit, PATCH /api/homekit {enabled}, POST /api/homekit/reset, DELETE /api/homekit/pairings/:id.
import path from "node:path";
import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from "node:fs";
import { createHapServer } from "./hap.js";
import { advertise } from "./mdns.js";
import { edKeyPair, newDeviceId, newSetupCode, newSetupId, setupHash, setupUri } from "./hapcrypto.js";
import { bridgeAccessories, structureKey } from "./bridge.js";
import { HttpError } from "../core.js";

function freshIdentity() { const kp = edKeyPair(); return { deviceId: newDeviceId(), seed: kp.seed.toString("hex"), pub: kp.pub.toString("hex"), setupCode: newSetupCode(), setupId: newSetupId(), pairings: [], aids: {}, nextAid: 10, cn: 1, hash: "", port: 0 }; }

/**
 * @param {{core:object, store:object, runtime:object, version:string, dataDir:string, mdns?:boolean, host?:string, port?:number}} o
 *   mdns: false to skip the mDNS advertisement (tests); host/port: where the HAP server listens (default all, a saved port)
 */
export function startHomeKit(o) {
  const { core, store, runtime } = o, data = () => store.data, file = path.join(o.dataDir, "homekit.json");
  if (!data().settings.homekit) data().settings.homekit = { enabled: false };
  const set = () => data().settings.homekit;
  let id = null, hap = null, mdns = null, timer = null, status = { state: "off", error: null, mdns: null }, starting = null, lastKey = "";
  const hs = { h: 0, s: 0 }; // the colour last picked in the Home app

  function load() {
    if (id) return id;
    try { if (existsSync(file)) id = { ...freshIdentity(), ...JSON.parse(readFileSync(file, "utf8")) }; } catch { id = null; }
    if (!id || !id.deviceId || !id.seed) { id = freshIdentity(); save(); }
    return id;
  }
  function save() { const tmp = file + ".tmp"; writeFileSync(tmp, JSON.stringify(id, null, 2), { mode: 0o600 }); renameSync(tmp, file); }
  const shortId = () => id.deviceId.replace(/:/g, "").slice(-4);
  const txt = () => ({ "c#": id.cn, ff: 0, id: id.deviceId, md: "Tempolight", pv: "1.1", "s#": 1, sf: id.pairings.length ? 0 : 1, ci: 2, sh: setupHash(id.setupId, id.deviceId) });
  const changedView = () => core.broadcast({ type: "changed", what: "homekit" });
  const showChanged = () => { store.save(); core.broadcast({ type: "changed", what: "show" }); };

  const tools = {
    data, version: o.version, hs, get deviceId() { return id.deviceId; },
    aidOf(sceneId) { if (!id.aids[sceneId]) { id.aids[sceneId] = id.nextAid++; save(); } return id.aids[sceneId]; },
    applyScene: sc => core.applyScene(sc),
    setPower: on => { if (!!data().show.power === !!on) return; runtime.setPower(on).then(showChanged, () => {}); showChanged(); }, // answers HomeKit at once; lights follow
    setBrightness: b => core.applySettings({ brightness: b }),
    setAuto: on => { if (on) { runtime.action({ type: "hold" }); core.applyShow({ mode: "auto" }); } else core.applyShow({ mode: "manual" }); },
    hold: hex => { runtime.action({ type: "hold", color: hex }); if (!data().show.power) tools.setPower(true); },
    held: () => !!runtime.status?.().overlay?.hold,
    identify: () => { try { runtime.identify({}); } catch {} },
  };
  const db = () => bridgeAccessories(tools);

  /** The structure changed (a scene added, renamed or deleted): a new config number tells the Home app to read it again. */
  function checkStructure() {
    const key = structureKey(db()); if (key === lastKey) return; lastKey = key;
    if (id.hash && id.hash !== key) { id.cn = id.cn >= 65535 ? 1 : id.cn + 1; mdns?.update(txt()); }
    id.hash = key; save();
  }

  async function start() {
    load(); status = { state: "starting", error: null, mdns: null };
    for (const k of Object.keys(id.aids)) if (!data().scenes.some(s => s.id === k)) delete id.aids[k]; // deleted scenes
    const state = { deviceId: id.deviceId, seed: Buffer.from(id.seed, "hex"), pub: Buffer.from(id.pub, "hex"), get pairings() { return id.pairings; }, set pairings(v) { id.pairings = v; } };
    hap = createHapServer({ state, save, setupCode: () => id.setupCode, db, log: (m, l) => runtime.note(m, l), onIdentify: tools.identify,
      onPairingsChanged: () => { mdns?.update(txt()); changedView(); } });
    let port;
    try { port = await hap.listen(o.port ?? id.port ?? 0, o.host); }
    catch { try { port = await hap.listen(0, o.host); } catch (e) { hap = null; status = { state: "error", error: `Can't listen for HomeKit: ${e.message}`, mdns: null }; runtime.note(status.error, "warn"); return; } }
    if (id.port !== port && o.port === undefined) { id.port = port; save(); }
    lastKey = ""; checkStructure();
    if (o.mdns !== false) {
      mdns = await advertise({ instance: `Tempolight ${shortId()}`, service: "_hap._tcp.local", host: `Tempolight-${shortId()}.local`, port, txt: txt() }, { onError: m => runtime.note(`Apple Home: ${m}`, "warn") });
      status.mdns = mdns.error;
    }
    timer = setInterval(() => { try { hap?.notify(); } catch {} }, 1000); // changes made elsewhere (MQTT, schedules, the web app)
    status.state = "ready"; runtime.note(`Apple Home: ready on port ${port}${id.pairings.length ? "" : ` · setup code ${id.setupCode}`}`);
  }
  async function stop() {
    clearInterval(timer); timer = null;
    mdns?.close(); mdns = null;
    if (hap) { const h = hap; hap = null; await h.close(); }
    status = { state: "off", error: null, mdns: null };
  }
  function restart() { starting = (starting || Promise.resolve()).then(async () => { await stop(); if (set().enabled) await start(); }).catch(e => { status = { state: "error", error: e.message, mdns: null }; }); return starting; }

  core.onChange(what => {
    if (!hap) return;
    if (what === "scenes" || what === "all") checkStructure();
    hap.notify();
  });

  const view = () => { const s = set(); load();
    return { enabled: !!s.enabled, state: status.state, error: status.error, mdnsError: status.mdns, port: hap?.port || null, name: `Tempolight ${shortId()}`, deviceId: id.deviceId,
      paired: id.pairings.length > 0, setupCode: id.setupCode, setupUri: setupUri(id.setupCode, id.setupId, 2),
      pairings: id.pairings.map(p => ({ id: p.id, admin: !!p.admin })), accessories: db().length - 1 }; };

  core.route("GET", "/api/homekit", "admin", () => view());
  core.route("PATCH", "/api/homekit", "admin", async ctx => { const b = ctx.body || {};
    if (b.enabled !== undefined && !!b.enabled !== !!set().enabled) { set().enabled = !!b.enabled; store.save(); runtime.note(set().enabled ? "Apple Home: on" : "Apple Home: off"); await restart(); changedView(); }
    return view(); });
  core.route("POST", "/api/homekit/reset", "admin", async () => {
    await stop(); try { unlinkSync(file); } catch {} id = null; load();
    runtime.note("Apple Home: pairing reset. Remove the old Tempolight from the Home app, then add it again with the new code.");
    if (set().enabled) await restart(); changedView(); return view(); });
  core.route("DELETE", "/api/homekit/pairings/:id", "admin", (ctx, p) => { load(); const pid = decodeURIComponent(p.id);
    if (!id.pairings.some(x => x.id === pid)) throw new HttpError(404, "No such controller");
    id.pairings = id.pairings.filter(x => x.id !== pid); if (!id.pairings.some(x => x.admin)) id.pairings = []; save();
    hap?.dropUnpaired(); mdns?.update(txt()); changedView(); return view(); });

  if (set().enabled) restart();
  return { view, restart, get ready() { return starting || Promise.resolve(); }, get hap() { return hap; }, async close() { await starting; await stop(); } }; // after a start in progress
}
