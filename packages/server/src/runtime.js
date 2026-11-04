// The runtime: picks the music source, runs the director every frame, and streams each controller its LEDs.
// Sources, best first: a song playing in the browser (analysed ahead of time), live audio (from a browser or this
// computer's sound card), the metronome, and finally the idle/ambient effect when nothing is playing.
import { inWindow } from "./sun.js";
import { createFixtures } from "./fixtures.js";
import { createBeatSources } from "./beatsources.js";
import { buildLayout, createEffects, createDirector, segmentRanges, songView, metronomeView, gridAt, toRGB8, LiveAnalyser, memoryEntry, memoryAnalysis, recognise, matchAt, refineByKicks, planShow } from "../../engine/src/index.js";
// Everything that touches the network or the sound card comes in through `io` (see node-io.js), so the same runtime
// runs on a PC or Pi and, with pretend devices, inside the browser for the online demo.

const DEFAULT_PORT = { govee: 4003, openrgb: 6742, nanoleaf: 60222, hue: 80 }; // when a device has no port of its own

/**
 * @param {{data:object, save:()=>void}} store
 * @param {{io:object, logger?:Console|null}} opts io: DDPSender, AudioSyncSender, getInfo, setState, setSegments, ipOf,
 *   discoverWled, startCapture, listSources, splitCommand, RATE
 */
export function createRuntime(store, { io, logger = console } = {}) {
  const { DDPSender, E131Sender, GoveeSender, OpenRGBSender, NanoleafSender, HueSender, AudioSyncSender, getInfo, setState, setSegments, ipOf, discoverWled, startCapture, listSources, splitCommand, RATE } = io;
  const data = () => store.data;
  const log = [], listeners = new Set();
  function note(msg, level = "info") { const e = { t: Date.now(), level, msg }; log.push(e); if (log.length > 200) log.shift(); for (const f of listeners) f(e); if (logger) logger.log(`[tempolight] ${msg}`); }

  let L, fx, D, ranges, outs = new Map();
  const fixtures = createFixtures(), beats = createBeatSources(); // DMX fixtures; MIDI clock and Ableton Link beat grids
  const health = new Map(); // device id -> {online, rssi, version, ledsReported, lastSeen, error}
  const rt = {
    frames: 0, fps: 0, startedAt: Date.now(), source: "idle", sourceLabel: "Nothing playing", mem: { lock: null, cand: null },
    live: null,      // {an, kind, label, lastPush, clientId}
    capture: null,   // {proc, sourceId, label, error}
    song: null,      // {name, pre, pos, playing, rate, at, clientId}
    forced: null,    // {kind:"build"|"drop", t0, dur}
    taps: [], view: null, powerOffAt: 0, mapEndAt: -1e9,
  };

  function rebuild() {
    const shapes = data().room.shapes;
    const keep = D ? { ...D.settings } : null;
    L = buildLayout(shapes.map(s => ({ ...s })));
    fx = createEffects(L, { custom: data().customEffects || [] }); D = createDirector(L, fx); if (keep) Object.assign(D.settings, keep);
    ranges = segmentRanges(shapes);
    const ids = new Set(data().devices.map(d => d.id));
    for (const [id, o] of outs) if (!ids.has(id)) { o.sender.close(); outs.delete(id); }
    for (const d of data().devices) {
      const used = Math.max(0, ...ranges.filter(r => r.dev === d.id).map(r => r.end + 1));
      const size = Math.max(used, 1), ip = ipOf(d.host), port = d.ddpPort || DEFAULT_PORT[d.kind] || 4048;
      let o = outs.get(d.id);
      const proto = d.kind === "dmx" ? "dmx" : d.kind === "govee" && GoveeSender ? "govee" : d.kind === "openrgb" && OpenRGBSender ? "openrgb" : d.kind === "nanoleaf" && NanoleafSender ? "nanoleaf" : d.kind === "hue" && HueSender ? "hue" : d.protocol && d.protocol !== "ddp" && E131Sender ? d.protocol : "ddp";
      // everything a sender is built from: a change to any of it (segments, a new token after pairing again, a restored backup) makes a new sender
      const key = JSON.stringify([d.host, port, proto, d.universe ?? "", d.goveeMode || "", d.goveeSegments || 0, d.leds, d.orgbIndex ?? "", d.nanoleaf?.token, d.nanoleaf?.panels, d.hue?.user, d.hue?.lights, d.hue?.color]);
      if (!o || o.key !== key) { const old = o; // the new sender first, so a connection shared with the old one (OpenRGB) stays open
        o = { sender: proto === "dmx" ? (E131Sender ? new E131Sender(ip, { protocol: d.protocol === "e131" ? "e131" : "artnet", universe: d.universe, channels: 512, port: Number(/:(\d+)$/.exec(d.host)?.[1]) || undefined }) : { sent: 0, send() { this.sent++; }, close() {} }) : proto === "ddp" ? new DDPSender(ip, port) : proto === "hue" ? new HueSender(d.host, { user: d.hue?.user, lights: d.hue?.lights, color: d.hue?.color }) : proto === "nanoleaf" ? new NanoleafSender(d.host, { token: d.nanoleaf?.token, panels: d.nanoleaf?.panels, port }) : proto === "openrgb" ? new OpenRGBSender(ip, { port, index: d.orgbIndex || 0, leds: d.leds }) : proto === "govee" ? new GoveeSender(ip, { mode: d.goveeMode, segments: d.goveeSegments || d.leds, port }) : new E131Sender(ip, { protocol: proto, universe: d.universe }), ip, port, key }; outs.set(d.id, o); if (old) old.sender.close(); }
      o.size = size; o.buf = new Uint8Array(size * 3); o.used = used;
    }
    col8 = new Uint8Array(L.N * 3);
    syncDirector();
  }
  // your own effects changed: only the effects and the director are made again (not the layout or the connections to
  // the controllers), and what the director was doing carries over (the effect showing, pads like blackout or strobe)
  function rebuildEffects() {
    const keep = { ...D.settings }, old = D.state;
    fx = createEffects(L, { custom: data().customEffects || [] }); D = createDirector(L, fx); Object.assign(D.settings, keep);
    const ids = new Set(fx.list.map(e => e.id)), st = D.state;
    Object.assign(st, { palIdx: old.palIdx, lastSwitchBeat: old.lastSwitchBeat, poolIdx: old.poolIdx, overlay: old.overlay, styleName: old.styleName, lastState: old.lastState });
    if (ids.has(old.cur)) { st.cur = old.cur; st.showing = old.showing; }
    syncDirector();
  }
  function syncDirector() {
    const s = data().settings, sh = data().show;
    const night = !!rt.night; // night mode: no strobing, warm colours
    Object.assign(D.settings, { mode: sh.mode, effect: sh.effect, style: sh.style, palette: night && s.night.warm ? "sunset" : sh.palette, everyBeats: sh.everyBeats, speed: sh.speed,
      ambient: s.ambient, safe: s.safe || night, dropFlash: s.dropFlash && !night, prefs: s.effectPrefs || {}, params: sh.params || {}, layer: sh.layer || null, zones: data().room.zones || [] });
  }
  let col8 = new Uint8Array(0);

  // ---------------------------------------------------------------- music sources
  function pushPcm(samples, kind, label, clientId, rate = RATE) {
    if (!rt.live || rt.live.kind !== kind || rt.live.clientId !== clientId || rt.live.rate !== rate) {
      if (rt.live && rt.live.kind === "browser" && kind === "capture" && performance.now() - rt.live.lastPush < 1500) return; // a browser that is sending wins
      rt.live = { an: new LiveAnalyser(rate), kind, label, clientId, rate, lastPush: 0, started: performance.now() }; rt.mem.lock = null; rt.mem.cand = null; memT = 0;
      note(`Listening to ${label}`);
    }
    rt.live.an.push(samples); rt.live.lastPush = performance.now();
  }
  function liveFresh() { return rt.live && performance.now() - rt.live.lastPush < 1500; }
  function stopLive(clientId) { if (rt.live && (clientId == null || rt.live.clientId === clientId)) { note(`Stopped listening to ${rt.live.label}`); rt.live = null; rt.mem.lock = null; rt.mem.cand = null; } }

  function startCaptureSource() {
    stopCaptureSource();
    const c = data().settings.capture; let src;
    if (c.command) src = { id: "custom", label: "Custom capture command", cmd: splitCommand(c.command) };
    else { const all = listSources(); src = (c.source && c.source !== "auto" && all.find(s => s.id === c.source)) || all[0]; }
    if (!src) { rt.capture = { error: "No audio capture tool found on this computer (install ffmpeg, or use a browser as the audio source)." }; note(rt.capture.error, "warn"); return rt.capture; }
    const cap = { sourceId: src.id, label: src.label, error: null };
    cap.proc = startCapture(src.cmd, a => pushPcm(a, "capture", src.label, "capture"), why => {
      if (rt.capture !== cap) return;
      cap.error = why === "ended" ? null : why; cap.proc = null; if (why !== "ended") note(`Audio capture: ${why}`, "warn");
      if (data().settings.capture.enabled && why !== "ended") cap.retry = setTimeout(() => { if (rt.capture === cap) startCaptureSource(); }, 5000);
    });
    rt.capture = cap; note(`Audio capture started: ${src.label}`);
    return cap;
  }
  function stopCaptureSource() { if (rt.capture) { clearTimeout(rt.capture.retry); rt.capture.proc && rt.capture.proc.stop(); rt.capture = null; } stopLive("capture"); }

  function setSong(song, clientId) {
    const pre = song.analysis;
    for (const k of ["kicks", "snares", "hats", "drops"]) pre[k] = Array.from(pre[k] || []);
    pre.env = Float32Array.from(pre.env || []); pre.bars = pre.bars || [];
    rt.song = { name: song.name || "Song", pre, pos: 0, playing: false, rate: 1, at: performance.now(), clientId };
    if (data().settings.songMemory && pre.dur > 20 && pre.env.length) rt.song.memId = remember(rt.song.name, pre)?.id;
    note(`Song ready: ${rt.song.name} (${Math.round(pre.bpm)} BPM, ${fx.styles[pre.style]?.name || pre.style})`);
  }
  // ---------------------------------------------------------------- Pro DJ Link: the decks' beat grid
  // One deck leads: the deck already leading keeps the grid while it plays, so two decks playing at once don't make
  // the lights jump between their beats. A player beats the mixer (which echoes the master tempo), and a deck whose
  // channel the mixer says is on air beats one that isn't. Beats arrive a few ms late and uneven over Wi-Fi, so the
  // grid follows them smoothly; a beat far off the grid (the DJ cued or jumped) re-anchors it. The beat counter keeps
  // counting through deck changes, so "change effect every N beats" keeps working.
  const djP = d => 60000 / d.bpm; // ms per beat
  const djLive = (d, now) => !!d && now - d.raw < Math.max(1200, 2 * djP(d) + 250); // two beats missed: that deck stopped
  const djRank = (b, now) => { const a = rt.djAir && now - rt.djAir.at < 5000 ? rt.djAir.onAir : null; return (b.device === 0x21 ? 0 : 2) + (a && a[b.device] ? 1 : 0); };
  function djBeat(b) { // b.at is performance.now() when the beat arrived
    const d = rt.dj, P = djP(b), bib = b.beatInBar >= 1 && b.beatInBar <= 4 ? b.beatInBar : 0;
    if (djLive(d, b.at) && d.device !== b.device && djRank(b, b.at) <= djRank(d, b.at)) return;
    if (djLive(d, b.at) && d.device === b.device) {
      if (b.at - d.raw < 30) return; // the same beat twice
      const k = Math.max(1, Math.round((b.at - d.at) / P)), pred = d.at + k * P, err = b.at - pred, near = k <= 4 && Math.abs(err) < P * 0.15;
      rt.dj = { ...b, beatInBar: bib || ((d.beatInBar + k - 1) % 4) + 1, at: near ? pred + err * 0.25 : b.at, raw: b.at, n: d.n + k };
    } else rt.dj = { ...b, beatInBar: bib || 1, at: b.at, raw: b.at, n: rt.view?.g?.has ? rt.view.g.idx + 1 : d ? d.n + 1 : 0 };
  }
  function djOnAir(a) { rt.djAir = a; }
  const djFresh = now => djLive(rt.dj, now);
  // the beat grid from the leading deck, on the clock `t` that corresponds to wall time `now`: beat number n is at the last deck beat
  function djGrid(now, t) { const d = rt.dj, P = 60 / d.bpm, beatT = t - (now - d.at) / 1000; return { P, off: beatT - d.n * P - 1e-6, barOff: (((d.n - d.beatInBar + 1) % 4) + 4) % 4 }; }

  // ---------------------------------------------------------------- song memory
  const MEM_ONE = 400000, MEM_ALL = 2000000; // characters of saved JSON per song, and for all of them
  for (const e of data().songs || []) { delete e._fp; delete e._shape; } // caches an earlier version saved by mistake (they made the file 4x bigger)
  function remember(name, pre) {
    const list = data().songs, old = list.findIndex(e => e.name === name && Math.abs(e.dur - pre.dur) < 1.5);
    const e = memoryEntry(name, pre, old >= 0 ? list[old].id : "m" + Math.random().toString(36).slice(2, 10));
    e.show = old >= 0 && list[old].showEdited ? list[old].show : planShow(pre, fx, { seed: name, prefs: data().settings.effectPrefs }); e.showEdited = old >= 0 && !!list[old].showEdited; // a show of its own; hand edits are kept
    const size = JSON.stringify(e).length; if (size > MEM_ONE) { note(`“${name}” is too long to remember (a mix?): it won't be recognised later`); return old >= 0 ? list[old] : null; }
    if (old >= 0) list.splice(old, 1); else note(`Remembered “${name}”: Tempolight will recognise it when it plays again`);
    list.push(e); // the oldest go first: at most 60 songs, and at most ~2 MB in all (the browser demo keeps everything in localStorage, ~5 MB)
    let total = list.reduce((n, x) => n + JSON.stringify(x).length, 0);
    while (list.length > 60 || (total > MEM_ALL && list.length > 1)) total -= JSON.stringify(list.shift()).length;
    store.save(); return e;
  }
  const planFor = (e, seed = e.name + ":" + Date.now()) => planShow(memoryAnalysis(e), fx, { seed, prefs: data().settings.effectPrefs }); // a fresh one: a new seed
  /** The show timeline for the song playing now (played or recognised), when shows are on. */
  function currentPlan() {
    if (data().settings.shows === false) return null;
    const id = rt.source === "song" ? rt.song?.memId : rt.mem.lock && liveFresh() ? rt.mem.lock.id : null; if (!id) return null;
    const e = data().songs.find(x => x.id === id); if (!e) return null; if (!e.show) { e.show = planFor(e, e.name); store.save(); } return e.show;
  }
  let memT = 0;
  const lockPos = (L, t) => L.pos0 + (t - L.t0) * L.rate; // where in the song we are at live time t
  function release(why) { const m = rt.mem; if (m.lock) note(`Song memory: ${why} “${m.lock.name}”, back to live listening`); m.lock = null; m.cand = null; }
  function lockOn(e, pos, an, rate) { const pre = memoryAnalysis(e), ref = refineByKicks(an.kicks, an.t, pos, pre.kicks, 0.2, rate);
    rt.mem.lock = { id: e.id, name: e.name, e, pre, pos0: ref.pos, t0: an.t, rate, miss: 0 }; rt.mem.cand = null;
    note(`Song memory: recognised “${e.name}” at ${Math.floor(ref.pos / 60)}:${String(Math.floor(ref.pos % 60)).padStart(2, "0")}; following its beat map`); }
  // the live tempo against the song's: a DJ playing it 3% fast plays it 3% faster (small differences are just the tempo estimate wobbling)
  function rateOf(an, e) { if (!an.bpm || !e.bpm) return 1; for (const k of [1, 2, 0.5]) { const r = an.bpm / e.bpm / k; if (Math.abs(r - 1) < 0.06) return Math.abs(r - 1) >= 0.015 ? r : 1; } return 1; }
  function songMemoryTick() { // once a second while listening live: is this a song we know?
    const an = rt.live.an, list = data().songs, m = rt.mem;
    if (!data().settings.songMemory || !list.length) { if (m.lock) release("song memory is off: stopped following"); return; }
    if (an.t - memT < 1) return; memT = an.t;
    const known = (r, at) => m.cand && m.cand.id === r.id && Math.abs(r.pos - (m.cand.pos + (an.t - m.cand.t) * rateOf(an, at))) < 0.3; // seen twice, in step
    if (m.lock) {
      const L = m.lock, exp = lockPos(L, an.t);
      if (exp > L.pre.dur + 0.5) return release("the end of");
      // still this song, here? Only positions near where it should be count, so a chorus that comes back can't fool it
      const here = matchAt(an.tap.q, L.e, exp, 0.2);
      const ok = here && here.score > 0.45;
      if (ok) { L.miss = 0;
        const rate = rateOf(an, L.e); if (Math.abs(rate - L.rate) > 0.004) { L.pos0 = exp; L.t0 = an.t; L.rate += (rate - L.rate) * 0.5; }
        const ref = refineByKicks(an.kicks, an.t, exp, L.pre.kicks, 0.08, L.rate); if (ref.hits) L.pos0 += (ref.pos - exp) * 0.5; }
      // too flat to tell: fine in a quiet part of the song, but silence where the song is loud means it stopped
      else if (!here) { if (an.state === "silent" && songView(L.pre, exp).state !== "silent") L.miss += 2; }
      else L.miss++;
      // something we know, somewhere else, twice in step (another song, or this one after a skip): follow that instead,
      // unless where we are still fits about as well (a chorus that comes back)
      const r = recognise(an.tap.q, list, { bpm: an.bpm || undefined });
      if (r && !(r.id === L.id && Math.abs(r.pos - exp) < 0.3) && (!ok || r.score > here.score + 0.1)) { const e = list.find(x => x.id === r.id);
        if (known(r, e)) { if (e.id !== L.id) note(`Song memory: “${L.name}” is no longer playing`); return lockOn(e, r.pos, an, rateOf(an, e)); }
        m.cand = { ...r, t: an.t }; } else m.cand = null;
      if (L.miss >= 4) release("lost track of");
      return;
    }
    const r = recognise(an.tap.q, list, { bpm: an.bpm || undefined });
    if (!r) { m.cand = null; return; }
    const e = list.find(x => x.id === r.id);
    if (known(r, e)) lockOn(e, r.pos, an, rateOf(an, e)); else m.cand = { ...r, t: an.t };
  }
  function forget(id) { const list = data().songs, i = list.findIndex(e => e.id === id); if (i < 0) return false; list.splice(i, 1); if (rt.mem.lock && rt.mem.lock.id === id) rt.mem.lock = null; store.save(); return true; }

  function songClock(c, clientId) {
    if (!rt.song) return; if (clientId && rt.song.clientId && rt.song.clientId !== clientId) return;
    rt.song.pos = Number(c.pos) || 0; rt.song.playing = !!c.playing; rt.song.rate = Number(c.rate) || 1; rt.song.at = performance.now();
  }
  function clearSong(clientId) { if (rt.song && (!clientId || rt.song.clientId === clientId)) { note(`Song stopped: ${rt.song.name}`); rt.song = null; } }

  // ---------------------------------------------------------------- frame loop
  let lastT = performance.now(), fpsN = 0, fpsT = performance.now(), lastSync = 0, timer = null, previewTick = 0;
  const previewClients = new Set(), phones = new Set(), syncSender = { s: null };

  function currentView(now) {
    const s = data().settings, off = (s.syncOffsetMs || 0) / 1000;
    if (rt.song && rt.song.playing && now - rt.song.at < 4000) {
      const t = rt.song.pos + (now - rt.song.at) / 1000 * rt.song.rate + off;
      rt.source = "song"; rt.sourceLabel = rt.song.name;
      return { V: songView(rt.song.pre, t), t, extra: liveFresh() ? rt.live.an.extras() : {} };
    }
    if (liveFresh()) {
      const an = rt.live.an, t = an.t + Math.min(0.12, (now - rt.live.lastPush) / 1000) + (s.predict ? off : 0);
      songMemoryTick();
      if (rt.mem.lock) { const L = rt.mem.lock, pos = lockPos(L, t); // a song we know: use its beat map
        rt.source = rt.live.kind; rt.sourceLabel = `${rt.live.label}: ${L.name} (recognised)`;
        return { V: { ...songView(L.pre, pos), live: true, vocal: an.vocal }, t: pos, extra: an.extras() }; }
      const V = an.view(t, { predict: s.predict });
      rt.source = rt.live.kind; rt.sourceLabel = rt.live.label;
      const G = djFresh(now) ? { ...djGrid(now, t), bpm: rt.dj.bpm, label: `DJ Link (${rt.dj.name})` } : beats.grid(now, t); // DJ Link, else MIDI clock, else Ableton Link
      if (G) { V.g = gridAt(G, t); V.bpm = G.bpm; if (V.g.has && t - V.kick > 0.6) { V.kick = V.g.beatT; V.pulses = [V.g.beatT]; V.pulseN = V.g.idx; } rt.sourceLabel += ` + ${G.label}`; }
      if (V.state === "silent" && V.quietFor > (s.idleAfterSec ?? 8)) { rt.source = "idle"; rt.sourceLabel = `${rt.live.label} (quiet)`; return { V: null, t: now / 1000 }; }
      return { V, t, extra: an.extras() };
    }
    if (djFresh(now)) { const t = now / 1000, V = metronomeView(t, rt.dj.bpm, djGrid(now, t)); // decks but no audio: a steady show on their beat
      rt.source = "djlink"; rt.sourceLabel = `DJ Link: ${rt.dj.name} ${rt.dj.bpm.toFixed(1)} BPM`; return { V, t }; }
    { const t = now / 1000, G = beats.grid(now, t); if (G) { rt.source = G.kind; rt.sourceLabel = `${G.label} ${G.bpm.toFixed(1)} BPM`; return { V: metronomeView(t, G.bpm, G), t }; } } // MIDI clock or Link, no audio
    if (s.metronome.enabled) { const t = now / 1000; rt.source = "metronome"; rt.sourceLabel = `Metronome ${Math.round(s.metronome.bpm)} BPM`; return { V: metronomeView(t, s.metronome.bpm), t }; }
    rt.source = "idle"; rt.sourceLabel = "Nothing playing"; return { V: null, t: now / 1000 };
  }

  function applyForced(V, t, now) {
    const f = rt.forced; if (!f || !V) return V;
    const el = (now - f.t0) / 1000;
    if (f.kind === "build") {
      if (el < f.dur) return { ...V, state: "build", buildP: el / f.dur, nextDrop: t + (f.dur - el) };
      rt.forced = { kind: "drop", t0: now, dur: 8, dropT: t }; return { ...V, state: "drop", dropT: t };
    }
    if (f.kind === "drop") { if (f.dropT == null) f.dropT = t; if (el < Math.max(4, f.dur)) return { ...V, state: "drop", dropT: f.dropT, level: "peak" }; rt.forced = null; }
    return V;
  }

  function frame() {
    const now = performance.now(), wall = now / 1000, sh = data().show, s = data().settings;
    let { V, t, extra } = currentView(now);
    D.settings.plan = V ? currentPlan() : null;
    if (rt.forced && !V) V = metronomeView(wall, s.metronome.bpm || 124), t = wall; // "build & drop" pad works even with no music
    V = applyForced(V, t, now);
    rt.view = V; rt.t = t;
    const tx = s.text || {}; extra = { ...(extra || {}), text: tx.source === "custom" ? tx.custom : tx.source === "clock" ? new Date().toTimeString().slice(0, 5)
      : tx.source === "bpm" ? (V && V.bpm ? `${Math.round(V.bpm)} BPM` : "TEMPOLIGHT") : (rt.song ? rt.song.name : rt.source === "idle" ? tx.custom : rt.sourceLabel) };
    if (rt.screen && now - rt.screen.at < 3000) extra.screen = rt.screen; else rt.screen = null;
    const col = D.frame(V, t, extra, wall);
    let bri = s.brightness; if (!V && sh.mode === "auto") bri *= s.idleBrightness;
    if (rt.night) bri = Math.min(bri, s.night.maxBrightness);
    if (!sh.power) { bri = 0; }
    toRGB8(col, col8, bri);
    fixtures.begin({ V, t, wall, cfg: s.dmx, safe: s.safe, night: !!rt.night, power: sh.power, overlay: D.state.overlay, bri });
    // copy each shape's LEDs into its controller's buffer at its segment range
    const shapes = data().room.shapes;
    const map = rt.mapping && now - rt.mapping.at < 5000 ? rt.mapping : null; if (!map && rt.mapping) { rt.mapping = null; rt.mapEndAt = now; }
    const sendNow = sh.power || now - rt.powerOffAt < 600 || now - rt.mapEndAt < 600; // after power-off (or mapping with the power off), send black briefly, then go quiet
    for (const d of data().devices) {
      const o = outs.get(d.id); if (o && d.kind === "dmx") { dmxOut(d, o, map, now); continue; }
      if (!o || !d.enabled) continue;
      if (map) { // camera mapping: everything dark except the one LED being looked for
        const n = Math.max(o.size, d.leds || 0); if (!o.mapBuf || o.mapBuf.length !== n * 3) o.mapBuf = new Uint8Array(n * 3); o.mapBuf.fill(0);
        if (map.dev === d.id && map.led >= 0 && map.led < n) { let a = map.led, b = map.led + 1;
          if (d.kind === "govee") { const segs = Math.max(1, d.goveeMode === "segments" ? d.goveeSegments || d.leds || 1 : 1); const k = Math.floor(map.led * segs / n); a = Math.floor(k * n / segs); b = Math.max(a + 1, Math.floor((k + 1) * n / segs)); } // Govee averages LEDs into segments: light the whole segment, or it's too dim to see
          o.mapBuf.fill(map.level, a * 3, b * 3); }
        if (!d.virtual) o.sender.send(o.mapBuf); continue; }
      o.buf.fill(0);
      shapes.forEach((sp, si) => { if (sp.dev !== d.id) return; const r = ranges[si], a = L.chainStart[si], n = Math.min(sp.type === "matrix" ? sp.cols * sp.rows : sp.count, o.size - r.start);
        if (n > 0) o.buf.set(col8.subarray(a * 3, (a + n) * 3), r.start * 3); });
      // power: estimate the current the strip draws (about mAperLed at full white, ~1 mA idle per LED) and cap it to the supply
      let sum = 0; for (let k = 0; k < o.buf.length; k++) sum += o.buf[k];
      const perCh = (d.mAperLed || 60) / 3 / 255, idle = o.size; let mA = idle + sum * perCh; o.limited = false;
      if (d.maxAmps > 0 && mA > d.maxAmps * 1000) { const k = Math.max(0, (d.maxAmps * 1000 - idle) / Math.max(1, sum * perCh)); for (let q = 0; q < o.buf.length; q++) o.buf[q] = o.buf[q] * k; mA = d.maxAmps * 1000; o.limited = true; }
      o.amps = o.amps == null ? mA / 1000 : o.amps * 0.8 + mA / 1000 * 0.2;
      if (sendNow && !d.virtual) o.sender.send(o.buf);
    }
    // WLED audio sync, so the controllers' own sound-reactive effects can run too
    if (s.audioSync && liveFresh() && now - lastSync > 20) { lastSync = now; sendAudioSync(); }
    // preview for the web UI, 30 fps
    if (++previewTick % Math.max(1, Math.round((s.fps || 60) / 30)) === 0 && previewClients.size) {
      const msg = new Uint8Array(1 + col8.length); msg[0] = 1; msg.set(col8, 1);
      for (const c of previewClients) if (c.open && !c.busy) c.send(msg);
    }
    // phones as extra lights: each phone shows the colour of its own part of the room, so a crowd of phones moves with it
    if (phones.size && previewTick % Math.max(1, Math.round((s.fps || 60) / 30)) === 0) sendPhones(sh.power ? 1 : 0);
    rt.frames++; fpsN++; if (now - fpsT > 1000) { rt.fps = fpsN * 1000 / (now - fpsT); fpsN = 0; fpsT = now; }
  }
  // DMX: one universe per device, always sent (DMX nodes hold the last values, so stopping could leave fog on),
  // about 40 times a second; dark while camera mapping; zeros for 2 s after it is turned off, then nothing
  function dmxOut(d, o, map, now) {
    if (!d.enabled) { if (o.dmxOn !== false) { o.dmxOn = false; o.offAt = now; } if (now - o.offAt > 2000 || d.virtual) return; if (now - (o.lastSend || 0) >= 100) { o.lastSend = now; o.sender.send(new Uint8Array(512)); } return; }
    o.dmxOn = true; o.buf.fill(0);
    const shapes = data().room.shapes, pts = shapes.find(sp => sp.dev === d.id && sp.type === "points")?.pts || [];
    shapes.forEach((sp, si) => { if (sp.dev !== d.id) return; const r = ranges[si], a = L.chainStart[si], n = Math.min(sp.count, o.size - r.start); if (n > 0) o.buf.set(col8.subarray(a * 3, (a + n) * 3), r.start * 3); });
    const dmx = map ? new Uint8Array(512) : fixtures.render(d, o.buf, pts);
    if (!d.virtual && now - (o.lastSend || 0) >= 24) { o.lastSend = now; o.sender.send(dmx); }
  }
  /** Camera mapping: light only LED `led` of device `dev` (-1: all dark); call again within 5 s to keep it going, or end(). */
  /** `owner` (a browser's id) lets endMap(owner) stop it when that browser goes away mid-scan. */
  function mapLight(dev, led, level = 200, owner = null) {
    if (dev == null) { if (rt.mapping) rt.mapEndAt = performance.now(); rt.mapping = null; return; }
    rt.mapping = { dev, led: Number.isFinite(Number(led)) ? Math.round(Number(led)) : -1, level: Math.max(20, Math.min(255, Number(level) || 200)), at: performance.now(), owner };
  }
  function endMap(owner) { if (rt.mapping && rt.mapping.owner === owner) mapLight(null); }
  /**
   * A small picture of a shared screen (RGB bytes), for the Screen Sync effect. One browser at a time: while one
   * shares (frames less than 1.5 s old), another browser's pictures are refused ("busy"), so two don't flicker.
   */
  function setScreen(w, h, px, label, owner = null) {
    if (!(w > 0 && h > 0 && w * h <= 4096 && px.length >= w * h * 3)) return false;
    const now = performance.now(); if (rt.screen && rt.screen.owner !== owner && now - rt.screen.at < 1500) return "busy";
    rt.screen = { w, h, px, at: now, label, owner }; return true;
  }
  function clearScreen(owner) { if (rt.screen && rt.screen.owner === owner) rt.screen = null; }
  function sendPhones(on) {
    const list = [...phones].filter(c => c.open), n = list.length, N = L.N; if (!N) return;
    const win = Math.max(1, Math.round(N / Math.max(6, n * 2)));
    list.forEach((c, i) => { if (c.busy) return; const mid = Math.floor((i + 0.5) / n * N); let r = 0, g = 0, b = 0, w = 0;
      for (let k = mid - (win >> 1); k < mid - (win >> 1) + win; k++) { const q = ((k % N) + N) % N * 3, R = col8[q], G = col8[q + 1], B = col8[q + 2], l = 1 + R + G + B; r += R * l; g += G * l; b += B * l; w += l; }
      const msg = new Uint8Array(5); msg[0] = 2; msg[1] = r / w * on; msg[2] = g / w * on; msg[3] = b / w * on; msg[4] = Math.min(255, i); c.send(msg); });
  }
  function sendAudioSync() {
    const an = rt.live.an; if (!syncSender.s) syncSender.s = new AudioSyncSender();
    const fft = new Array(16); for (let i = 0; i < 16; i++) { const a = an.bands[Math.floor(i * 1.5)], b = an.bands[Math.min(23, Math.floor(i * 1.5) + 1)]; fft[i] = Math.round(255 * Math.max(a, b)); }
    let mi = 0; for (let i = 1; i < 24; i++) if (an.bands[i] > an.bands[mi]) mi = i;
    syncSender.s.send({ sampleRaw: Math.min(255, an.rms * 1200), sampleSmth: Math.min(255, an.eFast * 1200), peak: an.t - (an.kicks.at(-1) ?? -9) < 0.05, fft, magnitude: an.bands[mi] * 1000, majorPeak: 40 * Math.pow(250, (mi + 0.5) / 24) });
  }
  function startLoop() { clearInterval(timer); timer = setInterval(() => { try { frame(); } catch (e) { note(`Render error: ${e.message}`, "error"); } }, 1000 / (data().settings.fps || 60)); }

  // ---------------------------------------------------------------- devices
  async function checkDevice(d) {
    const h = health.get(d.id) || {}; health.set(d.id, h);
    if (d.virtual) return Object.assign(h, { online: true, version: "virtual", ledsReported: d.leds, lastSeen: Date.now() });
    if (d.kind === "hue") { try { const l = await io.hueLights(d.host, d.hue?.user); return Object.assign(h, { online: true, version: "Hue bridge", ledsReported: l.length, lastSeen: Date.now(), error: null }); }
      catch (e) { if (h.online !== false) note(`${d.name} is not answering (${d.host})`, "warn"); return Object.assign(h, { online: false, error: e.message }); } }
    if (d.kind === "nanoleaf") { try { const info = await io.nanoleafInfo(d.host, d.nanoleaf?.token); return Object.assign(h, { online: true, version: `Nanoleaf ${info.model}`.trim(), ledsReported: info.panels.length, lastSeen: Date.now(), error: null }); }
      catch (e) { if (h.online !== false) note(`${d.name} is not answering (${d.host})`, "warn"); return Object.assign(h, { online: false, error: e.message }); } }
    if (d.kind === "openrgb") { try { const list = await io.listOpenRGB(ipOf(d.host), d.ddpPort || 6742), c = list.find(x => x.index === (d.orgbIndex || 0));
        return Object.assign(h, { online: !!c, version: c ? `OpenRGB: ${c.name}` : "OpenRGB", ledsReported: c?.leds, lastSeen: Date.now(), error: c ? null : "device not found in OpenRGB" }); }
      catch (e) { if (h.online !== false) note(`${d.name}: OpenRGB is not answering (${d.host}). Is its SDK server running?`, "warn"); return Object.assign(h, { online: false, error: e.message }); } }
    if (d.kind === "dmx") return Object.assign(h, { online: true, version: `DMX: ${d.protocol === "e131" ? "sACN" : "Art-Net"} universe ${d.universe ?? (d.protocol === "e131" ? 1 : 0)}`, ledsReported: (d.fixtures || []).length, lastSeen: Date.now() }); // DMX nodes don't answer
    if (d.kind === "govee") return Object.assign(h, { online: true, version: "Govee (LAN)", ledsReported: d.leds, lastSeen: Date.now() }); // Govee answers status on a shared port; not checked
    try { const info = await getInfo(d.host, 2500); Object.assign(h, { online: true, rssi: info.rssi, signal: info.signal, version: info.version, ledsReported: info.leds, fps: info.fps, live: info.live, lastSeen: Date.now(), error: null });
      if (!d.leds && info.leds) { d.leds = info.leds; store.save(); } }
    catch (e) { if (h.online !== false) note(`${d.name} is not answering (${d.host})`, "warn"); Object.assign(h, { online: false, error: e.message }); }
    return h;
  }
  let healthTimer = null, rediscoverAt = 0;
  async function healthLoop() {
    await Promise.all(data().devices.map(checkDevice));
    // a controller that went missing may have a new address from the router: look for it by name
    const lost = data().devices.filter(d => !d.virtual && !d.kind && health.get(d.id)?.online === false);
    if (lost.length && Date.now() > rediscoverAt) { rediscoverAt = Date.now() + 5 * 60_000;
      try { const found = await discoverWled({ scan: false, timeoutMs: 2000 });
        for (const d of lost) { const f = found.find(x => x.name === d.name && x.host !== d.host); if (f) { note(`${d.name} moved to ${f.host}; updated`); d.host = f.host; store.save(); rebuild(); } } } catch {} }
  }

  /** Light up one device's shapes (or a single shape) for a few seconds. */
  function identify({ device, shape } = {}) {
    const shapes = data().room.shapes, idx = shape != null ? [Number(shape)] : shapes.map((s, i) => s.dev === device ? i : -1).filter(i => i >= 0);
    D.identify(performance.now() / 1000, idx.length ? idx : null);
  }
  async function syncSegments(id) {
    const d = data().devices.find(x => x.id === id); if (!d) throw new Error("No such device");
    const segs = data().room.shapes.map((s, i) => ({ s, r: ranges[i] })).filter(x => x.s.dev === id).map(x => ({ start: x.r.start, end: x.r.end, name: x.s.name, rev: false }));
    if (!segs.length) throw new Error(`${d.name} has no shapes in the room yet`);
    await setSegments(d.host, segs); note(`Sent ${segs.length} segment${segs.length > 1 ? "s" : ""} to ${d.name}`);
    return segs;
  }
  async function setPower(on) {
    data().show.power = !!on; store.save(); if (!on) rt.powerOffAt = performance.now();
    note(on ? "Lights on" : "Lights off");
    await Promise.all(data().devices.filter(d => d.enabled && !d.virtual).map(d => d.kind === "openrgb" || d.kind === "dmx" ? null : d.kind === "govee" || d.kind === "nanoleaf" || d.kind === "hue" ? outs.get(d.id)?.sender.power?.(!!on) : setState(d.host, { on: !!on }, 2000).catch(() => {})));
  }

  // ---------------------------------------------------------------- live controls (pads, OSC, API)
  function action(a) {
    const o = D.state.overlay, wall = performance.now() / 1000, on = a.on !== undefined ? !!a.on : undefined;
    switch (a.type) {
      case "flash": D.flash(wall, a.color ? hexRgb(a.color) : undefined); break;
      case "strobe": o.strobe = on ?? !o.strobe; break;
      case "blackout": o.blackout = on ?? !o.blackout; break;
      case "freeze": o.freeze = on ?? !o.freeze; break;
      case "hold": o.hold = a.color ? hexRgb(a.color).map(v => v * 0.9) : null; break;
      case "boost": o.boost = Math.max(0, Math.min(2, Number(a.value ?? (o.boost === 1 ? 1.5 : 1)))); break;
      case "next": D.next(rt.t ?? wall); break;
      case "drop": rt.forced = { kind: "drop", t0: performance.now(), dur: 8 }; break;
      case "build": rt.forced = { kind: "build", t0: performance.now(), dur: Math.max(2, Number(a.seconds) || 8) }; break;
      case "cancel": rt.forced = null; Object.assign(o, { strobe: false, blackout: false, freeze: false, hold: null, boost: 1 }); break;
      case "tap": tap(); break;
      case "identify": identify(a); break;
      case "fog": { const r = fixtures.manualFog(on ?? true, wall); if (!r.ok && on !== false) note(`Fog: ${r.why}`, "warn"); break; } // the manual fog pad (DMX)
      default: throw new Error(`Unknown action "${a.type}"`);
    }
    return overlayState();
  }
  function overlayState() { const o = D.state.overlay; return { strobe: o.strobe, blackout: o.blackout, freeze: o.freeze, hold: !!o.hold, boost: o.boost, forced: rt.forced ? rt.forced.kind : null }; }
  function tap() {
    const now = performance.now(); rt.taps = rt.taps.filter(x => now - x < 3000); rt.taps.push(now);
    if (rt.taps.length < 3) return;
    const iv = []; for (let i = 1; i < rt.taps.length; i++) iv.push(rt.taps[i] - rt.taps[i - 1]); iv.sort((a, b) => a - b);
    const bpm = Math.max(50, Math.min(200, 60000 / iv[iv.length >> 1]));
    const s = data().settings; s.metronome.bpm = Math.round(bpm * 10) / 10; store.save();
    if (liveFresh()) { const an = rt.live.an; an.bpm = bpm; an.phase = (an.t - (now - rt.taps.at(-1)) / 1000) % (60 / bpm); an.phaseSet = true; note(`Beat synced by tapping: ${Math.round(bpm)} BPM`); }
  }

  function status() {
    const V = rt.view, an = liveFresh() ? rt.live.an : null;
    return {
      type: "status", source: rt.source, sourceLabel: rt.sourceLabel, fps: Math.round(rt.fps), leds: L.N, effect: D.showing, effectName: fx.list.find(e => e.id === D.showing)?.name || D.showing, style: D.style,
      styleName: fx.styles[D.style]?.name || D.style, bpm: V && V.bpm ? Math.round(V.bpm * 10) / 10 : null, part: V ? V.state : "idle",
      beat: V && V.g.has ? V.g.beatInBar : null, level: an ? Math.round(Math.min(1, an.eFast / an.eMax) * 100) / 100 : V ? Math.round((V.loud || 0) * 100) / 100 : 0,
      bands: an ? Array.from(an.bands, v => Math.round(v * 100) / 100) : null, vocal: an ? Math.round(an.vocal * 100) / 100 : null, mapping: rt.mapping ? { device: rt.mapping.dev, led: rt.mapping.led } : null, djlink: djFresh(performance.now()) ? { name: rt.dj.name, bpm: rt.dj.bpm, beatInBar: rt.dj.beatInBar } : null, recognised: rt.mem.lock && liveFresh() ? { id: rt.mem.lock.id, name: rt.mem.lock.name, pos: Math.round(lockPos(rt.mem.lock, rt.live.an.t) * 10) / 10, dur: rt.mem.lock.pre.dur } : null, power: data().show.power, brightness: data().settings.brightness, night: !!rt.night, mqtt: rt.mqtt || null, phones: phones.size, screen: rt.screen ? rt.screen.label || "A shared screen" : null,
      song: rt.song ? { memId: rt.song.memId || null, name: rt.song.name, playing: rt.song.playing, pos: rt.song.pos + (rt.song.playing ? (performance.now() - rt.song.at) / 1000 * rt.song.rate : 0), dur: rt.song.pre.dur, bpm: rt.song.pre.bpm, style: rt.song.pre.style, drops: rt.song.pre.drops } : null,
      capture: rt.capture ? { label: rt.capture.label, running: !!rt.capture.proc, error: rt.capture.error } : null,
      overlay: overlayState(), devices: data().devices.map(d => ({ id: d.id, ...health.get(d.id), sent: outs.get(d.id)?.sender.sent || 0, used: outs.get(d.id)?.used || 0, amps: Math.round((outs.get(d.id)?.amps || 0) * 100) / 100, limited: !!outs.get(d.id)?.limited })),
      uptime: Math.round((Date.now() - rt.startedAt) / 1000),
      ...beats.status(performance.now()), dmx: data().devices.some(d => d.kind === "dmx") ? fixtures.status(performance.now() / 1000) : null,
    };
  }

  function layoutInfo() {
    return { N: L.N, x: Array.from(L.LX, v => Math.round(v * 100) / 100), y: Array.from(L.LY, v => Math.round(v * 100) / 100), shape: Array.from(L.LF), chainStart: L.chainStart, ranges, shapes: data().room.shapes };
  }

  function updateNight() {
    const n = data().settings.night, on = !!(n && n.enabled && inWindow(n.from, n.to, new Date(), data().settings.location));
    if (on !== !!rt.night) { rt.night = on; syncDirector(); note(on ? "Night mode on" : "Night mode off"); }
  }
  const nightTimer = setInterval(updateNight, 5000);

  rebuild(); startLoop(); updateNight();
  healthLoop(); healthTimer = setInterval(healthLoop, 10_000);
  if (data().settings.capture.enabled) startCaptureSource();

  return {
    get layout() { return L; }, get effects() { return fx; }, get director() { return D; }, rt, log, listeners, previewClients, phones, health,
    rebuild, rebuildEffects, syncDirector, startLoop, updateNight, pushPcm, stopLive, startCaptureSource, stopCaptureSource, setSong, songClock, clearSong,
    fixtures, beats, identify, syncSegments, setPower, action, status, setScreen, clearScreen, remember, forget, djBeat, djOnAir, planFor, mapLight, endMap, layoutInfo, checkDevice, note,
    close() { for (const [id, o] of outs) if (data().devices.find(d => d.id === id)?.kind === "dmx") try { o.sender.send(new Uint8Array(512)); } catch {} // DMX: leave everything at zero
      clearInterval(timer); clearInterval(healthTimer); clearInterval(nightTimer); stopCaptureSource(); for (const o of outs.values()) o.sender.close(); syncSender.s && syncSender.s.close(); },
  };
}

export function hexRgb(h) { const m = /^#?([0-9a-f]{6})$/i.exec(String(h)); if (!m) return [1, 1, 1]; const n = parseInt(m[1], 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; }
