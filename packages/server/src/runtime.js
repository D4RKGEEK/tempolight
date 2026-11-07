// The runtime: picks the music source, runs the director every frame, and streams each controller its LEDs.
// Sources, best first: a song playing in the browser (analysed ahead of time), live audio (from a browser or this
// computer's sound card), the metronome, and finally the idle/ambient effect when nothing is playing.
import { inWindow } from "./sun.js";
import { createFixtures } from "./fixtures.js";
import { createBeatSources } from "./beatsources.js";
import { noteRtt, audioDelay, deviceLatency, lightLatency, timingPlan, newestSampleClock, level, LOOKAHEAD_CAP_MS } from "./latency.js";
import { createPerf, LITE } from "./perf.js";
import { syncScore, songMap, createLiveMap } from "./songmap.js";
import { buildLayout, createEffects, createDirector, segmentRanges, songView, metronomeView, gridAt, toRGB8, LiveAnalyser, memoryEntry, memoryAnalysis, recognise, matchAt, refineByKicks, planShow, SHOW_VERSION, drumlessEntry, hearsLabel, moodName, pickLook, lookLabel, LOOK_VERSION } from "../../engine/src/index.js";
// Everything that touches the network or the sound card comes in through `io` (see node-io.js), so the same runtime
// runs on a PC or Pi and, with pretend devices, inside the browser for the online demo.

const DEFAULT_PORT = { govee: 4003, openrgb: 6742, nanoleaf: 60222, hue: 80 }; // when a device has no port of its own

/**
 * @param {{data:object, save:()=>void}} store
 * @param {{io:object, logger?:Console|null, now?:()=>Date, host?:object|null, cpuUsage?:()=>{user:number, system:number}}} opts now: the wall clock (night mode); io: DDPSender, AudioSyncSender, getInfo, setState, setSegments, ipOf,
 *   discoverWled, startCapture, listSources, sourceFor (optional: named inputs, "avf:BlackHole 2ch"), splitCommand, RATE, hostInfo (optional: the computer, for the performance mode);
 *   host: what to use instead of io.hostInfo() (tests); cpuUsage: process.cpuUsage, for the CPU figure in the status
 */
export function createRuntime(store, { io, logger = console, now = () => new Date(), host, cpuUsage = null } = {}) {
  const { DDPSender, E131Sender, GoveeSender, OpenRGBSender, NanoleafSender, HueSender, HueEntertainmentSender, LIGHT_KINDS: LK = {}, AudioSyncSender, getInfo, setState, setSegments, ipOf, discoverWled, startCapture, listSources, splitCommand, RATE } = io;
  const data = () => store.data;
  const log = [], listeners = new Set();
  function note(msg, level = "info") { const e = { t: Date.now(), level, msg }; log.push(e); if (log.length > 200) log.shift(); for (const f of listeners) f(e); if (logger) logger.log(`[tempolight] ${msg}`); }
  // performance mode (perf.js): full, or lite on small computers; the frame rate the loop really runs at
  const perf = createPerf({ setting: () => data().settings.performance, host: () => host !== undefined ? host : io.hostInfo ? io.hostInfo() : null, note, cpuUsage });
  const loopFps = () => { const f = data().settings.fps || 60; return perf.lite ? Math.min(f, LITE.fps) : f; };

  let L, fx, D, ranges, outs = new Map();
  const fixtures = createFixtures(), beats = createBeatSources(); // DMX fixtures; MIDI clock and Ableton Link beat grids
  const health = new Map(); // device id -> {online, rssi, version, ledsReported, lastSeen, error}
  const rt = {
    frames: 0, fps: 0, perf, startedAt: Date.now(), startedAtPerf: performance.now(), source: "idle", sourceLabel: "Nothing playing", mem: { lock: null, cand: null },
    live: null,      // {an, kind, label, lastPush, clientId}
    capture: null,   // {proc, sourceId, label, error}
    song: null,      // {name, pre, pos, playing, rate, at, clientId}
    forced: null,    // {kind:"build"|"drop", t0, dur}
    taps: [], view: null, powerOffAt: 0, mapEndAt: -1e9,
    nowPlaying: null, // set by nowplaying.js on a PC: {follow(now), memId, info()}: what the music apps here play
    spotify: null,    // set by spotify.js on a PC: {info(), paused(), dim(), timeline(tl)}; and pcmTap(samples, rate, kind, inMs): what is heard, to learn songs
    hearing: null,    // set by hearing.js on a PC: {info()}: the guided set-up's view (method, what's detected, problems)
    heardBy: {},      // kind ("browser", "capture") -> {rms, at, soundAt, label}: how loud each live source is, even one not in use
    output: null,     // the sound output this computer plays to, from hearing.js: {key, name, bluetooth}; its own light timing in settings.syncOffsets
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
      const size = Math.max(used, 1), ip = ipOf(d.host), port = d.ddpPort || DEFAULT_PORT[d.kind] || LK[d.kind]?.port || 4048;
      let o = outs.get(d.id);
      const fastHue = d.kind === "hue" && d.hue?.ent?.on && d.hue.clientkey && HueEntertainmentSender; // Hue fast mode (Entertainment streaming)
      const proto = LK[d.kind] ? d.kind : d.kind === "dmx" ? "dmx" : d.kind === "govee" && GoveeSender ? "govee" : d.kind === "openrgb" && OpenRGBSender ? "openrgb" : d.kind === "nanoleaf" && NanoleafSender ? "nanoleaf" : d.kind === "hue" && HueSender ? "hue" : d.protocol && d.protocol !== "ddp" && E131Sender ? d.protocol : "ddp";
      // everything a sender is built from: a change to any of it (segments, a new token after pairing again, a restored backup) makes a new sender
      const key = JSON.stringify([d.host, port, proto, d.universe ?? "", d.goveeMode || "", d.goveeSegments || 0, d.leds, d.orgbIndex ?? "", d.nanoleaf?.token, d.nanoleaf?.panels, d.hue?.user, d.hue?.lights, d.hue?.color, fastHue ? [d.hue.clientkey, d.hue.ent, d.hue.clipPort, d.hue.streamPort] : 0, d.light || null]);
      if (!o || o.key !== key) { const old = o; // the new sender first, so a connection shared with the old one (OpenRGB) stays open
        o = { sender: LK[proto] ? LK[proto].sender(d) : fastHue ? new HueEntertainmentSender(d.host, { user: d.hue.user, clientkey: d.hue.clientkey, area: d.hue.ent, lights: d.hue.lights, color: d.hue.color, clipPort: d.hue.clipPort, streamPort: d.hue.streamPort,
            onState: (st, err) => { if (st === "streaming") note(`${d.name}: streaming (Hue Entertainment)`); else if (st === "fallback") note(`${d.name}: fast mode isn't working (${err}); basic mode for now`, "warn"); } }) : proto === "dmx" ? (E131Sender ? new E131Sender(ip, { protocol: d.protocol === "e131" ? "e131" : "artnet", universe: d.universe, channels: 512, port: Number(/:(\d+)$/.exec(d.host)?.[1]) || undefined }) : { sent: 0, send() { this.sent++; }, close() {} }) : proto === "ddp" ? new DDPSender(ip, port) : proto === "hue" ? new HueSender(d.host, { user: d.hue?.user, lights: d.hue?.lights, color: d.hue?.color }) : proto === "nanoleaf" ? new NanoleafSender(d.host, { token: d.nanoleaf?.token, panels: d.nanoleaf?.panels, port }) : proto === "openrgb" ? new OpenRGBSender(ip, { port, index: d.orgbIndex || 0, leds: d.leds }) : proto === "govee" ? new GoveeSender(ip, { mode: d.goveeMode, segments: d.goveeSegments || d.leds, port }) : new E131Sender(ip, { protocol: proto, universe: d.universe }), ip, port, key, createdAt: Date.now() }; outs.set(d.id, o); if (old) old.sender.close(); }
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
      ambient: s.ambient, moodColours: s.moodColours !== false, chordColours: s.chordColours !== false, stereo: s.stereo || "subtle", safe: s.safe || night, dropFlash: s.dropFlash && !night, night,
      punch: s.punch ?? 0.7, dynamics: s.dynamics ?? 0.8, variations: s.variations !== false, prefs: s.effectPrefs || {}, params: sh.params || {}, layer: sh.layer || null, zones: data().room.zones || [],
      variety: sh.variety || "one", nudge: s.effectNudge || {} });
  }
  let col8 = new Uint8Array(0);

  // ---------------------------------------------------------------- music sources
  // channels 2: interleaved left/right (a stereo source), for the stereo accent; the analysis hears them mixed
  function pushPcm(samples, kind, label, clientId, rate = RATE, inMs = 0, channels = 1) { // inMs: the browser's estimate of its capture delay (latency meter)
    heard(samples, kind, label);
    if (!rt.live || rt.live.kind !== kind || rt.live.clientId !== clientId || rt.live.rate !== rate) {
      if (rt.live && rt.live.kind === "browser" && kind === "capture" && performance.now() - rt.live.lastPush < 1500) return; // a browser that is sending wins
      rt.live = { an: new LiveAnalyser(rate), kind, label, clientId, rate, lastPush: 0, started: performance.now() }; rt.mem.lock = null; rt.mem.cand = null; memT = 0; memJob = null;
      rt.live.an.lite = perf.lite; D.resetLook(); note(`Listening to ${label}`); // (a new source: a new song, a look of its own)
    }
    const st2 = channels === 2 && (samples.length & 1) === 0 ? 2 : 1; rt.live.an.stereoOn = data().settings.stereo !== "off";
    const t0 = performance.now(); rt.live.an.push(samples, st2); perf.add("analysis", performance.now() - t0); rt.live.lastPush = performance.now(); rt.live.inMs = inMs; rt.live.chunkMs = samples.length / rate * 1000;
    if (rt.pcmTap) rt.pcmTap(st2 === 2 ? mono(samples) : samples, rate, kind, inMs);
  }
  const mono = s => { const n = s.length >> 1, o = new Int16Array(n); for (let i = 0; i < n; i++) o[i] = (s[2 * i] + s[2 * i + 1]) >> 1; return o; };
  // how loud each kind of live source is (BlackHole sends exact zeros when nothing reaches it), for "Tempolight hears it"
  const SOUND_RMS = 0.0015; // about -56 dBFS: a quiet room through a microphone is more, digital silence is 0
  function heard(samples, kind, label) {
    const isInt = samples instanceof Int16Array, k = isInt ? 1 / 32768 : 1; let e = 0;
    for (let i = 0; i < samples.length; i++) { const v = samples[i] * k; e += v * v; }
    const rms = Math.sqrt(e / Math.max(1, samples.length)), now = performance.now(), h = rt.heardBy[kind] || (rt.heardBy[kind] = { rms: 0, at: 0, soundAt: -1e9, label });
    h.rms = h.at && now - h.at < 1000 ? h.rms * 0.7 + rms * 0.3 : rms; h.at = now; h.label = label; if (rms > SOUND_RMS) h.soundAt = now;
  }
  /** What Tempolight hears right now, for the status line and the guided set-up. */
  function hearingInfo() {
    const now = performance.now(), fresh = h => !!h && now - h.at < 1500, br = rt.heardBy.browser, cap = rt.heardBy.capture;
    const via = fresh(br) ? "browser" : fresh(cap) ? "capture" : null, h = via === "browser" ? br : via === "capture" ? cap : null;
    const lv = x => fresh(x) ? Math.round(Math.min(1, Math.sqrt(x.rms) * 2.2) * 100) / 100 : 0;
    return { via, label: h ? h.label : null, sound: !!h && now - h.soundAt < 3000, level: lv(h), silentSec: h ? Math.round(Math.min(600, (now - Math.max(h.soundAt, rt.startedAtPerf)) / 1000)) : null,
      capture: rt.capture ? { label: rt.capture.label, source: rt.capture.sourceId || null, running: !!rt.capture.proc, error: rt.capture.error || null, sound: fresh(cap) && now - cap.soundAt < 3000, level: lv(cap) } : null,
      method: data().settings.hearing?.method || "", output: outputInfo(), ...(rt.hearing ? rt.hearing.info() : {}) };
  }
  // ---------------------------------------------------------------- light timing, per sound output
  // settings.syncOffsetMs is the timing used when the output isn't known (or has no timing of its own yet); each output
  // that was timed (a Bluetooth speaker plays ~200 ms late, the laptop's own speakers don't) keeps its own in
  // settings.syncOffsets {key: {ms, name, bt}}, and it switches by itself when the output changes.
  function syncOffset() { const s = data().settings, k = rt.output?.key, o = k && s.syncOffsets ? s.syncOffsets[k] : null; return o && Number.isFinite(o.ms) ? o.ms : s.syncOffsetMs || 0; }
  function outputInfo() { const o = rt.output; if (!o) return null; const own = data().settings.syncOffsets?.[o.key]; return { ...o, offsetMs: syncOffset(), own: !!own }; }
  /** hearing.js: the output now playing (null: not known). A change is noted, with the timing it brings. */
  function setOutput(o) {
    const next = o && o.key ? { key: String(o.key).slice(0, 160), name: String(o.name || o.key).slice(0, 120), bluetooth: !!o.bluetooth, ...(o.guess ? { guess: true } : {}) } : null;
    if (JSON.stringify(next) === JSON.stringify(rt.output)) return false;
    const had = rt.output; rt.output = next;
    if (next && had) note(`Sound output is now ${next.name}${next.bluetooth ? " (Bluetooth)" : ""}: light timing ${syncOffset() > 0 ? "+" : ""}${syncOffset()} ms`);
    return true;
  }
  function liveFresh() { return rt.live && performance.now() - rt.live.lastPush < 1500; }
  function stopLive(clientId) { if (rt.live && (clientId == null || rt.live.clientId === clientId)) { note(`Stopped listening to ${rt.live.label}`); rt.live = null; rt.mem.lock = null; rt.mem.cand = null; } }

  function startCaptureSource() {
    stopCaptureSource();
    const c = data().settings.capture; let src;
    if (c.command) src = { id: "custom", label: "Custom capture command", cmd: splitCommand(c.command), channels: /(^|\s)(-ac\s+2|--channels[= ]2|-c\s+2)(\s|$)/.test(c.command) ? 2 : 1 }; // (stereo when the command asks for 2 channels)
    else if (/^\w+:/.test(c.source || "")) { // a named input (BlackHole 2ch, Stereo Mix, a sink's monitor): that one or none, never the microphone instead
      src = io.sourceFor?.(c.source) || null; // (capture.js; the demo has none)
      if (!src) { rt.capture = { sourceId: c.source, label: c.source.replace(/^\w+:/, ""), error: `The sound input “${c.source.replace(/^\w+:/, "")}” can't be used here.` }; note(rt.capture.error, "warn"); return rt.capture; } }
    else { const all = listSources(); src = (c.source && c.source !== "auto" && all.find(s => s.id === c.source)) || all[0]; }
    if (!src) { rt.capture = { error: "No audio capture tool found on this computer (install ffmpeg, or use a browser as the audio source)." }; note(rt.capture.error, "warn"); return rt.capture; }
    const cap = { sourceId: src.id, label: src.label, error: null, startedAt: performance.now() };
    const chans = src.channels === 2 ? 2 : 1;
    cap.proc = startCapture(src.cmd, a => pushPcm(a, "capture", src.label, "capture", RATE, 0, chans), why => {
      if (rt.capture !== cap) return;
      cap.error = why === "ended" ? null : why; cap.proc = null; if (why !== "ended") note(`Audio capture: ${why}`, "warn");
      if (data().settings.capture.enabled && why !== "ended") cap.retry = setTimeout(() => { if (rt.capture === cap) startCaptureSource(); }, 5000);
    }, chans);
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
    if (!rt.song.memId) rt.song.look = newLook(pre, rt.song.name, []); // (not remembered: a look for this time)
    const lk = rt.song.memId ? songById(rt.song.memId)?.look : rt.song.look;
    note(`Song ready: ${rt.song.name} (${Math.round(pre.bpm)} BPM, ${fx.styles[pre.style]?.name || pre.style})${lk ? `. Look: ${lookLabel(lk, fxNames())}` : ""}`);
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
  // The imported music library (library.js, on a PC) keeps its songs in files of its own, not in the settings file:
  // rt.library = {list(): light entries for recognising (id, name, dur, bpm, style, fp, ch, drumless), full(id): the
  // whole entry (read from its file), save(e), remove(id)}. Song memory is both: the songs here and the library's.
  /** Every remembered song, as entries to recognise or match by name (library songs as their light entries). */
  function songs() { const L = rt.library?.list(); return L && L.length ? data().songs.concat(L) : data().songs; }
  /** A remembered song by id, whole (a library song is read from its file). */
  function songById(id) { if (!id) return null; return data().songs.find(x => x.id === id) || rt.library?.full(id) || null; }
  const isLib = e => !!e && e.src === "library" && !!rt.library;
  /** Keep a change to a remembered song (a library song's own file, or the settings file). */
  function saveSong(e) { if (isLib(e)) rt.library.save(e); else store.save(); }
  function remember(name, pre) {
    const list = data().songs, old = list.findIndex(e => e.name === name && Math.abs(e.dur - pre.dur) < 1.5);
    const e = memoryEntry(name, pre, old >= 0 ? list[old].id : "m" + Math.random().toString(36).slice(2, 10));
    // its look (kept if it was kept by hand; the effects turned down for it stay turned down), then its show
    const was = old >= 0 ? list[old].look : null; e.look = was && was.locked ? was : newLook(pre, name, was?.rejected || []);
    e.show = old >= 0 && list[old].showEdited ? list[old].show : planShow(pre, fx, planOpts(e)); e.showEdited = old >= 0 && !!list[old].showEdited; e.showV = SHOW_V; e.showKey = showKey(e); // a show of its own; hand edits are kept
    if (old >= 0) for (const k of ["colors", "cues", "bright"]) if (list[old][k]) e[k] = list[old][k]; // and the timeline editor's colours, cues and brightness
    const size = JSON.stringify(e).length; if (size > MEM_ONE) { note(`“${name}” is too long to remember (a mix?): it won't be recognised later`); return old >= 0 ? list[old] : null; }
    if (old >= 0) list.splice(old, 1); else note(`Remembered “${name}”: Tempolight will recognise it when it plays again`);
    list.push(e); // the oldest go first: at most 60 songs, and at most ~2 MB in all (the browser demo keeps everything in localStorage, ~5 MB)
    let total = list.reduce((n, x) => n + JSON.stringify(x).length, 0);
    while (list.length > 60 || (total > MEM_ALL && list.length > 1)) total -= JSON.stringify(list.shift()).length;
    store.save(); return e;
  }
  const SHOW_V = SHOW_VERSION; // shows made by an older planner are made again, unless edited by hand
  // ---------------------------------------------------------------- looks: one effect (and palette) per song (looks.js)
  const fxNames = () => Object.fromEntries(fx.list.map(f => [f.id, f.name]));
  const variety = () => data().show.variety || "one";
  const nudges = () => data().settings.effectNudge || {};
  function newLook(pre, name, rejected = []) {
    const used = {}; for (const e of data().songs) if (e.look?.main && e.name !== name) used[e.look.main] = (used[e.look.main] || 0) + 1; // spread looks over the library
    const o = { prefs: data().settings.effectPrefs, nudge: nudges(), seed: name, available: fx.list.map(f => f.id), used };
    let lk = pickLook(pre, { ...o, exclude: rejected }); if (!lk && rejected.length) { rejected = []; lk = pickLook(pre, o); } // every one turned down: start again
    return lk ? { ...lk, rejected: [...rejected], locked: false } : null;
  }
  /** A remembered song's look, picked (again) when it has none, the picker changed, or its effect is banned now (unless kept by hand). */
  const lookTried = new WeakMap(); // entry -> the effect preferences it last found no look with (everything banned)
  function lookOf(e) {
    const L = e.look, prefs = data().settings.effectPrefs || {}, banned = L && prefs[L.main] === -1;
    if (L && !banned && (L.locked || L.v === LOOK_VERSION)) return L;
    const key = JSON.stringify(prefs); if (!L && lookTried.get(e) === key) return null;
    e.look = newLook(memoryAnalysis(e), e.name, L?.rejected || []); if (!e.look) lookTried.set(e, key); saveSong(e);
    return e.look;
  }
  /** The remembered song playing now (played here, in a music app, or recognised while listening), or null. */
  function playingEntry() {
    const id = rt.source === "song" ? rt.song?.memId : rt.source === "nowplaying" ? rt.nowPlaying?.memId : rt.mem.lock && liveFresh() ? rt.mem.lock.id : null;
    return id ? songById(id) : null;
  }
  /** The look for what plays now: the song's, or null (live listening: the director picks one as it listens). */
  function currentLook() {
    if (variety() === "show") return null;
    const e = playingEntry(); if (e) return lookOf(e);
    return rt.source === "song" && rt.song ? rt.song.look || null : null;
  }
  const planOpts = (e, seed = "") => ({ seed, prefs: data().settings.effectPrefs, everyBeats: data().show.everyBeats, variety: variety(), look: variety() === "show" ? null : lookOf(e) });
  const showKey = e => variety() === "show" ? "show" : `${variety()}:${["main", "drop", "build", "calm"].map(k => e.look?.[k] || "").join("/")}`;
  const planFor = (e, seed = e.name + ":" + Date.now()) => { const p = planShow(memoryAnalysis(e), fx, planOpts(e, seed)); e.showKey = showKey(e); return p; }; // "New show": a new seed
  /** A remembered song's show, made again when the planner, the variety or the look changed (unless edited by hand). */
  function freshShow(e) { if (!e.show || (!e.showEdited && (e.showV !== SHOW_V || e.showKey !== showKey(e)))) { e.show = planFor(e, ""); e.showV = SHOW_V; saveSong(e); } return e; }
  /** A new library song's look and show, before it is first kept (nothing is saved here). */
  function prepareSong(e) { const pre = memoryAnalysis(e); e.look = newLook(pre, e.name, []); e.show = planShow(pre, fx, planOpts(e)); e.showEdited = false; e.showV = SHOW_V; e.showKey = showKey(e); return e; }
  function nudge(id, d) { const s = data().settings; s.effectNudge ||= {}; const v = Math.round(Math.max(-1, Math.min(1, (s.effectNudge[id] || 0) + d)) * 100) / 100; if (v) s.effectNudge[id] = v; else delete s.effectNudge[id]; D.settings.nudge = s.effectNudge; }
  /** What the look is about, for the status and the API. */
  function lookInfo(L, extra = {}) {
    if (!L) return null; const n = fxNames();
    return { main: L.main, mainName: n[L.main] || L.main, drop: L.drop || null, build: L.build || null, calm: L.calm || null, palette: L.palette || null, params: L.params || {}, why: L.why || [],
      label: lookLabel(L, n), locked: !!L.locked, rejected: L.rejected || [], provisional: !!L.provisional, variety: variety(), ...extra };
  }
  // the song a "Not this one" or "Keep" is for: a remembered song (id, or the one playing), a song played here that
  // isn't remembered, or the look picked while listening live
  function lookTarget(id) {
    if (id) { const e = songById(id); return e ? { e } : null; }
    const e = playingEntry(); if (e) return { e };
    if (rt.source === "song" && rt.song && rt.song.look) return { song: rt.song };
    if (D.look && D.look.provisional) return { live: true };
    return null;
  }
  /** "Not this one": the next best look for the song; the one turned down is remembered with it (and liked a little less). */
  function lookNext(id) {
    const tg = lookTarget(id); if (!tg) return null;
    if (tg.live) { const cur = D.look; nudge(cur.main, -0.15); D.nextLiveLook(cur.main); store.save(); note(`Look: not ${fxNames()[cur.main] || cur.main}`); return lookInfo(D.look || cur, { song: null }); }
    const cur = tg.e ? lookOf(tg.e) : tg.song.look, rejected = [...new Set([...(cur?.rejected || []), ...(cur ? [cur.main] : [])])];
    const L = newLook(tg.e ? memoryAnalysis(tg.e) : tg.song.pre, tg.e ? tg.e.name : tg.song.name, rejected);
    if (cur) nudge(cur.main, -0.15);
    if (tg.e) { tg.e.look = L; freshShow(tg.e); saveSong(tg.e); } else tg.song.look = L;
    store.save(); note(`Look for “${tg.e ? tg.e.name : tg.song.name}”: ${lookLabel(L, fxNames())}`);
    return lookInfo(L, { song: tg.e ? tg.e.id : null });
  }
  /** "Keep": this song keeps its look (no new pick when the picker changes); keep false lets it go again. */
  function lookKeep(id, keep = true) {
    const tg = lookTarget(id); if (!tg) return null;
    const L = tg.e ? lookOf(tg.e) : tg.song ? tg.song.look : D.look; if (!L) return null;
    if (keep && !L.locked) nudge(L.main, 0.1);
    L.locked = !!keep; if (tg.e) saveSong(tg.e); store.save();
    return lookInfo(L, { song: tg.e ? tg.e.id : null });
  }
  /** The show timeline for the song playing now (played or recognised), when shows are on. */
  function currentPlan() {
    if (data().settings.shows === false) return null;
    const id = rt.source === "song" ? rt.song?.memId : rt.source === "nowplaying" ? rt.nowPlaying?.memId : rt.mem.lock && liveFresh() ? rt.mem.lock.id : null; if (!id) return null;
    const dr = rt.draft; if (dr && dr.id === id && performance.now() < dr.until) return dr; // the timeline editor's unsaved version, while it previews
    const e = songById(id); if (!e) return null; return freshShow(e);
  }
  /** The timeline editor previews its unsaved changes on the lights: {id, show, colors, cues, bright} for a while, or null. */
  function setDraft(d) { rt.draft = d ? { ...d, until: performance.now() + 120000 } : null; }
  let memT = 0, memJob = null;
  const MEM_SLICE = 4; // ms of matching at a time
  const lockPos = (L, t) => L.pos0 + (t - L.t0) * L.rate; // where in the song we are at live time t
  function release(why) { const m = rt.mem; if (m.lock) note(`Song memory: ${why} “${m.lock.name}”, back to live listening`); m.lock = null; m.cand = null; }
  function lockOn(e, pos, kicks, t, rate) { const pre = memoryAnalysis(e), ref = refineByKicks(kicks, t, pos, pre.kicks, 0.2, rate);
    rt.mem.lock = { id: e.id, name: e.name, e, pre, pos0: ref.pos, t0: t, rate, found: Math.abs(rate - 1) >= 0.005, miss: 0 }; rt.mem.cand = null;
    note(`Song memory: recognised “${e.name}” at ${Math.floor(ref.pos / 60)}:${String(Math.floor(ref.pos % 60)).padStart(2, "0")}; following its beat map`); }
  // the live tempo against the song's: a DJ playing it 3% fast plays it 3% faster (small differences are just the tempo estimate wobbling)
  function rateOf(an, e) { if (!an.bpm || !e.bpm || an.drumless() || drumlessEntry(e)) return 1; // (no drums: the tempo is a guess)
    for (const k of [1, 2, 0.5]) { const r = an.bpm / e.bpm / k; if (Math.abs(r - 1) < 0.06) return Math.abs(r - 1) >= 0.015 ? r : 1; } return 1; }
  // the speed the recogniser found (it searches 0.94-1.06, also for songs without drums), else the tempo's guess
  const rateFor = (r, an, e) => r && r.rate && Math.abs(r.rate - 1) >= 0.005 ? r.rate : rateOf(an, e);
  // a clear match (well ahead of every other song and place) is taken at once instead of waiting for a second one
  const sure = r => r && r.margin >= 0.25 && r.score >= 0.8;
  // Once a second while listening live: is this a song we know? The frame only takes a snapshot of what was heard; the
  // matching runs after it, in slices of a few ms between frames (one remembered song at a time, the best kept), so a
  // long list of songs on a slow computer never makes the lights stutter. The answer is the same as matching them all at once.
  function songMemoryTick() {
    const an = rt.live.an, list = data().songs, m = rt.mem, lib = rt.library?.list() || [];
    if (!data().settings.songMemory || (!list.length && !lib.length)) { memJob = null; libJob = null; if (m.lock) release("song memory is off: stopped following"); return; }
    if (memJob || an.t - memT < 1) return; memT = an.t;
    const L = m.lock, exp = L ? lockPos(L, an.t) : 0;
    if (L && exp > L.pre.dur + 0.5) return release("the end of");
    // the songs here, the library song the background search found (for a while), and the library song followed now
    const entries = list.slice(), hint = libHint && an.t - libHint.at < 20 && an.t >= libHint.at ? songById(libHint.id) : null; if (!hint) libHint = null;
    if (hint && !entries.includes(hint)) entries.push(hint); if (L && isLib(L.e) && !entries.some(e => e.id === L.id)) entries.push(L.e);
    memJob = { an, t: an.t, q: an.tap.q.slice(), query: an.memoryQuery(), kicks: an.kicks.slice(), lock: L, exp, entries, i: 0, best: null, here: undefined };
    setTimeout(memStep, 0);
    if (!L && lib.length && !libJob && an.t >= libNext) startLibSweep(an, lib);
  }
  // The music library while listening live: too many songs to try them all every second, so a search goes through
  // them in the background, a few ms at a time and at most LIB_BUDGET ms of every second, on a snapshot of what was
  // heard. The best match it finds is tried with the songs here at the next once-a-second check, which follows it as
  // usual (two matches in step, or one clear one). Songs whose tempo can't be what is heard are skipped. The matcher's
  // work for a song (about 200 kB) is kept only for the songs tried most recently (a copy of the entry it works on).
  let libHint = null, libJob = null, libNext = 0;
  const libBudget = () => perf.lite ? 40 : 120, probes = new Map(), PROBES = () => perf.lite ? 16 : 64;
  function probe(e) { let p = probes.get(e.id); if (p && p.src0 === e) { probes.delete(e.id); probes.set(e.id, p); return p; }
    p = { ...e, src0: e }; probes.set(e.id, p); while (probes.size > PROBES()) probes.delete(probes.keys().next().value); return p; }
  function startLibSweep(an, lib) {
    const bpm = an.bpm && !an.drumless() ? an.bpm : 0;
    const fits = e => !bpm || e.drumless !== false || !e.bpm || [1, 2, 0.5, 1.5, 2 / 3].some(k => Math.abs(bpm / e.bpm / k - 1) < 0.07);
    libJob = { an, t: an.t, q: an.tap.q.slice(), query: an.memoryQuery(), list: lib.filter(fits), i: 0, best: null };
    setTimeout(libStep, 0);
  }
  function libStep() {
    const J = libJob; if (!J) return;
    if (!rt.live || rt.live.an !== J.an || rt.mem.lock || !data().settings.songMemory) { libJob = null; return; }
    const t0 = performance.now();
    while (J.i < J.list.length && performance.now() - t0 < MEM_SLICE) { const e = J.list[J.i++], r = recognise(J.q, [probe(e)], J.query); if (r && (!J.best || r.score > J.best.score)) J.best = r; }
    const ms = performance.now() - t0; perf.add("memory", ms);
    if (J.i < J.list.length) { setTimeout(libStep, Math.max(1, Math.round(ms * (1000 / libBudget() - 1)))); return; }
    libJob = null; libNext = J.t + (J.best ? 0 : 2); // (nothing: a short rest before the next search)
    if (J.best) libHint = { id: J.best.id, at: J.t };
  }
  function memStep() {
    const J = memJob; if (!J) return;
    if (!rt.live || rt.live.an !== J.an || rt.mem.lock !== J.lock || !data().settings.songMemory) { if (memJob === J) memJob = null; return; } // another source, or let go meanwhile
    const t0 = performance.now();
    // still this song, here? Only positions near where it should be count, so a chorus that comes back can't fool it
    if (J.lock && J.here === undefined) J.here = matchAt(J.q, J.lock.e, J.exp, 0.2, { ...J.query, rate: J.lock.rate });
    while (J.i < J.entries.length && performance.now() - t0 < MEM_SLICE) { const r = recognise(J.q, [J.entries[J.i++]], J.query); if (r && (!J.best || r.score > J.best.score)) J.best = r; }
    perf.add("memory", performance.now() - t0);
    if (J.i < J.entries.length) { setTimeout(memStep, 0); return; }
    memJob = null; memDecide(J);
  }
  function memDecide(J) {
    const an = J.an, m = rt.mem, t = J.t, r = J.best && songById(J.best.id) ? J.best : null; // (not one forgotten meanwhile)
    const known = (r, at) => sure(r) || (m.cand && m.cand.id === r.id && Math.abs(r.pos - (m.cand.pos + (t - m.cand.t) * rateFor(r, an, at))) < 0.3); // seen twice, in step (or once, clearly)
    if (J.lock) {
      const L = J.lock, exp = J.exp, here = J.here, ok = here && here.score > 0.45;
      if (ok) { L.miss = 0;
        const rate = here.rate && Math.abs(here.rate - 1) >= 0.005 ? here.rate : L.found ? L.rate : rateOf(an, L.e); if (Math.abs(rate - L.rate) > 0.004) { L.pos0 = exp; L.t0 = t; L.rate += (rate - L.rate) * 0.5; }
        const ref = refineByKicks(J.kicks, t, exp, L.pre.kicks, 0.08, L.rate); if (ref.hits) L.pos0 += (ref.pos - exp) * 0.5; }
      // too flat to tell: fine in a quiet part of the song, but silence where the song is loud means it stopped
      else if (!here) { if (an.state === "silent" && songView(L.pre, exp).state !== "silent") L.miss += 2; }
      else L.miss++;
      // something we know, somewhere else, twice in step (another song, or this one after a skip): follow that instead,
      // unless where we are still fits about as well (a chorus that comes back)
      if (r && !(r.id === L.id && Math.abs(r.pos - exp) < 0.3) && (!ok || r.score > here.score + 0.1)) { const e = songById(r.id);
        if (known(r, e)) { if (e.id !== L.id) note(`Song memory: “${L.name}” is no longer playing`); return lockOn(e, r.pos, J.kicks, t, rateFor(r, an, e)); }
        m.cand = { ...r, t }; } else m.cand = null;
      if (L.miss >= 4) release("lost track of");
      return;
    }
    if (!r) { m.cand = null; return; }
    const e = songById(r.id);
    if (known(r, e)) lockOn(e, r.pos, J.kicks, t, rateFor(r, an, e)); else m.cand = { ...r, t };
  }
  function forget(id) { const list = data().songs, i = list.findIndex(e => e.id === id);
    if (i < 0) { if (!rt.library?.remove(id)) return false; } else { list.splice(i, 1); store.save(); }
    if (rt.mem.lock && rt.mem.lock.id === id) rt.mem.lock = null; if (libHint && libHint.id === id) libHint = null; return true; }

  function songClock(c, clientId) {
    if (!rt.song) return; if (clientId && rt.song.clientId && rt.song.clientId !== clientId) return;
    rt.song.pos = Number(c.pos) || 0; rt.song.playing = !!c.playing; rt.song.rate = Number(c.rate) || 1; rt.song.at = performance.now();
  }
  function clearSong(clientId) { if (rt.song && (!clientId || rt.song.clientId === clientId)) { note(`Song stopped: ${rt.song.name}`); rt.song = null; } }

  // ---------------------------------------------------------------- frame loop
  let lastT = performance.now(), fpsN = 0, fpsT = performance.now(), lastSync = 0, timer = null, previewTick = 0;
  const previewClients = new Set(), phones = new Set(), syncSender = { s: null };

  // now: the wall clock (ms); lead: how far ahead (ms) this frame is drawn for (light timing, below). Sources on the
  // wall clock (metronome, beat clocks, DJ Link, idle) are drawn for now + lead; sources with a music clock for where
  // the music will be by then, plus the timing trim (syncOffset).
  // a stereo source heard live (the browser playing the song, the computer's sound): its balance on a song's view too
  const lr = V => { const sv = liveFresh() && rt.live.an.stereoView ? rt.live.an.stereoView() : null; if (sv) { V.pan = sv.pan; V.lr = sv.lr; } return V; };
  function currentView(now, lead = 0) {
    rt.extBeat = null; // (a beat grid from outside while listening live: djlink, midiclock or link)
    const s = data().settings, off = syncOffset() / 1000, ld = lead / 1000, wt = (now + lead) / 1000;
    if (rt.song && rt.song.playing && now - rt.song.at < 4000) {
      const t = rt.song.pos + ((now - rt.song.at) / 1000 + ld) * rt.song.rate + off;
      rt.source = "song"; rt.sourceLabel = rt.song.name;
      return { V: lr(songView(rt.song.pre, t)), t, extra: liveFresh() ? rt.live.an.extras() : {} };
    }
    const np = rt.nowPlaying && rt.nowPlaying.follow(now); // a music app here plays a remembered song: its beat map, at the app's position
    if (np) { const t = np.pos + ld + off; rt.source = "nowplaying"; rt.sourceLabel = `${np.app}: ${np.name} (remembered)`; return { V: lr(songView(np.pre, t)), t, extra: liveFresh() ? rt.live.an.extras() : {} }; }
    if (rt.spotify && rt.spotify.paused()) { rt.source = "idle"; rt.sourceLabel = "Spotify paused"; return { V: null, t: wt }; } // fade to the ambient look
    if (liveFresh()) {
      // the analyser's clock now: its newest sample when it says (else its last frame's centre), plus the time since
      // that audio came in; then ahead by the lead and the trim when beats are predicted
      const an = rt.live.an, tl = (newestSampleClock(an) ?? an.t) + Math.min(0.12, (now - rt.live.lastPush) / 1000), t = tl + (s.predict ? off + ld : 0);
      songMemoryTick();
      if (rt.mem.lock) { const L = rt.mem.lock, pos = lockPos(L, t); // a song we know: use its beat map
        rt.source = rt.live.kind; rt.sourceLabel = `${rt.live.label}: ${L.name} (recognised)`;
        return { V: { ...lr(songView(L.pre, pos)), live: true, vocal: an.vocal, ...(L.pre.mood ? {} : { key: an.keyEst?.key || null, mode: an.keyEst?.mode || null, mood: an.mood }) }, t: pos, extra: an.extras() }; } // (remembered before key and mood were)
      const V = an.view(t, { predict: s.predict });
      rt.source = rt.live.kind; rt.sourceLabel = rt.live.label;
      const G = djFresh(now) ? { ...djGrid(now, tl), bpm: rt.dj.bpm, label: `DJ Link (${rt.dj.name})` } : beats.grid(now, tl); // DJ Link, else MIDI clock, else Ableton Link (on the analyser's clock now)
      if (G) { rt.extBeat = G.kind || "djlink"; V.g = gridAt(G, t); V.bpm = G.bpm; if (V.g.has && t - V.kick > 0.6) { V.kick = V.g.beatT; V.pulses = [V.g.beatT]; V.pulseN = V.g.idx; } rt.sourceLabel += ` + ${G.label}`; }
      if (V.state === "silent" && V.quietFor > (s.idleAfterSec ?? 8)) { rt.source = "idle"; rt.sourceLabel = `${rt.live.label} (quiet)`; return { V: null, t: wt }; }
      return { V, t, extra: an.extras() };
    }
    if (djFresh(now)) { const t = wt, V = metronomeView(t, rt.dj.bpm, djGrid(now, now / 1000)); // decks but no audio: a steady show on their beat
      rt.source = "djlink"; rt.sourceLabel = `DJ Link: ${rt.dj.name} ${rt.dj.bpm.toFixed(1)} BPM`; return { V, t }; }
    { const t = wt, G = beats.grid(now, now / 1000); if (G) { rt.source = G.kind; rt.sourceLabel = `${G.label} ${G.bpm.toFixed(1)} BPM`; return { V: metronomeView(t, G.bpm, G), t }; } } // MIDI clock or Link, no audio
    if (s.metronome.enabled) { const t = wt; rt.source = "metronome"; rt.sourceLabel = `Metronome ${Math.round(s.metronome.bpm)} BPM`; return { V: metronomeView(t, s.metronome.bpm), t }; }
    rt.source = "idle"; rt.sourceLabel = "Nothing playing"; return { V: null, t: wt };
  }

  function applyForced(V, t, now) {
    const f = rt.forced; if (!f || !V) return V;
    const el = (now - f.t0) / 1000;
    if (f.kind === "build") {
      if (el < f.dur) return { ...V, state: "build", buildP: el / f.dur, nextDrop: t + (f.dur - el), dropConf: 1, dropSource: "memory" };
      rt.forced = { kind: "drop", t0: now, dur: 8, dropT: t }; return { ...V, state: "drop", dropT: t };
    }
    if (f.kind === "drop") { if (f.dropT == null) f.dropT = t; if (el < Math.max(4, f.dur)) return { ...V, state: "drop", dropT: f.dropT, level: "peak" }; rt.forced = null; }
    return V;
  }

  // ---------------------------------------------------------------- light timing: lookahead and holding lights back
  // Lights are late by different amounts (WLED ~20 ms, Hue ~110 ms). When the beat is known ahead, each frame is
  // drawn ONCE, for the moment it will be seen: now + the slowest light's delay (L, at most LOOKAHEAD_CAP_MS) + half a
  // frame (a light shows a frame for a whole frame; the middle of that is "when"). Each faster light gets the frame
  // later, held back by L minus its own delay, so all of them show it at the same time. Drawing once matters: effects
  // keep state from frame to frame and start again when the time jumps. When the beat is only heard (live, without
  // beat prediction) nothing can be drawn ahead: nothing is held back, each light shows what was heard as soon as it can.
  const TM = { mode: "ahead", L: 0, common: 0, wantL: 0, wantC: 0, at: -1e9, src: null, slowest: null, lights: new Map(), procMs: 1, iv: [], last: 0, started: false };
  const SCREEN_MS = 40; // about how late the preview and phones show a frame (WebSocket, the screen)
  const ahead = () => !((rt.source === "browser" || rt.source === "capture") && !data().settings.predict);
  function updateTiming(now) {
    const changed = TM.src !== rt.source;
    if (changed || now - TM.at >= 250) { // the plan, 4 times a second (and at once when the source changes)
      TM.at = now; TM.src = rt.source; const fps = loopFps(), on = ahead(), list = []; TM.lights = new Map();
      for (const d of data().devices) { const l = lightLatency(d, health.get(d.id) || {}, fps); TM.lights.set(d.id, l);
        if (outs.has(d.id) && d.enabled && !d.virtual && health.get(d.id)?.online !== false) list.push({ id: d.id, ms: l.ms }); }
      const p = timingPlan({ devices: list, ahead: on }), a = audioDelay({ source: rt.source, live: liveFresh() ? rt.live : null });
      const was = TM.mode; TM.mode = on ? "ahead" : "reactive"; TM.slowest = p.slowest; TM.wantL = p.lookaheadMs; TM.wantC = on ? a.audioMs + a.analysisMs : 0;
      if (changed || was !== TM.mode || !TM.started) { TM.L = TM.wantL; TM.common = TM.wantC; TM.started = true; } // a new source starts on a new clock anyway
    }
    // otherwise move there slowly (1 ms a frame): a jump back in time would make effects start again
    const step = (v, w) => Math.abs(w - v) <= 1 ? w : v + Math.sign(w - v);
    TM.L = step(TM.L, TM.wantL); TM.common = step(TM.common, TM.wantC);
  }
  /** How far ahead (ms) this frame is drawn for, from what the music clock says is playing now. */
  const leadMs = () => TM.mode === "ahead" ? TM.L + TM.common + 500 / loopFps() + TM.procMs : 0;
  /** How long (ms) to hold a device's frame back. */
  function holdFor(d) { if (TM.mode !== "ahead") return 0; const l = TM.lights.get(d.id); return l ? Math.max(0, TM.L - l.ms) : 0; }
  // each output keeps a short queue of frames waiting to go out ({at, buf}); one timer sends what is due
  let flushTimer = null, flushAt = Infinity;
  const scr = { q: [], pool: [], sender: { send: (b, m) => sendScreens(b, m) } }; // the preview and phones, held back like a light
  function queueOut(o, buf, hold, at0, meta) {
    const q = o.q || (o.q = []), pool = o.pool || (o.pool = []);
    if (hold < 1 && !q.length) { o.sender.send(buf, meta); return; } // nothing to wait for (the slowest light, or not ahead)
    let b = pool.pop(); if (!b || b.length !== buf.length) b = new Uint8Array(buf.length); b.set(buf);
    q.push({ at: at0 + hold, buf: b, meta }); if (q.length > 96) pool.push(q.shift().buf); // (at most ~1.5 s even at 60 fps)
    if (at0 + hold <= performance.now() + 1) flushOutputs(); else armFlush(at0 + hold);
  }
  function armFlush(at) { if (flushTimer && flushAt <= at) return; clearTimeout(flushTimer); flushAt = at; flushTimer = setTimeout(flushOutputs, Math.max(0, at - performance.now() - 0.5)); }
  function flushOutputs() {
    clearTimeout(flushTimer); flushTimer = null; flushAt = Infinity; const now = performance.now(); let next = Infinity;
    for (const o of [...outs.values(), scr]) { const q = o.q; if (!q || !q.length) continue;
      let k = -1; for (let i = 0; i < q.length; i++) if (q[i].at <= now + 1) k = i; // the newest that is due; older ones are dropped
      if (k >= 0) { try { o.sender.send(q[k].buf, q[k].meta); } catch (e) { note(`Output error: ${e.message}`, "error"); } for (let i = 0; i <= k; i++) o.pool.push(q[i].buf); q.splice(0, k + 1); }
      for (const e of q) if (e.at < next) next = e.at; }
    if (next < Infinity) armFlush(next);
  }
  function dropQueued() { for (const o of [...outs.values(), scr]) if (o.q && o.q.length) { for (const e of o.q) o.pool.push(e.buf); o.q.length = 0; } }
  /** Light timing for the status: the lookahead and how even the frame loop runs. */
  function timingInfo() {
    const iv = TM.iv, n = iv.length, mean = n ? iv.reduce((a, b) => a + b, 0) / n : 0, sd = n ? Math.sqrt(iv.reduce((a, b) => a + (b - mean) ** 2, 0) / n) : 0, r2 = v => Math.round(v * 100) / 100;
    return { mode: TM.mode, lookaheadMs: Math.round(TM.L), audioMs: Math.round(TM.common), leadMs: Math.round(leadMs()), capMs: LOOKAHEAD_CAP_MS, slowest: TM.slowest,
      frame: { intervalMs: r2(mean), jitterMs: r2(sd), worstMs: n ? r2(Math.max(...iv.map(v => Math.abs(v - 1000 / loopFps())))) : 0 } };
  }

  function frame(now = performance.now()) {
    const wall = now / 1000, sh = data().show, s = data().settings;
    updateTiming(now); const lead = leadMs();
    let { V, t, extra } = currentView(now, lead);
    if (liveFresh()) liveMap.tick(rt.live.an, rt.live.an.t, rt.live.an.eFast, V ? V.state : "silent"); // the live song map, as it is heard
    D.settings.look = V ? currentLook() : null; // (null while listening live to a song it doesn't know: the director picks one)
    const pe = V ? currentPlan() : null; D.settings.plan = pe ? pe.show : null;
    D.settings.timeline = pe && (pe.colors?.length || pe.cues?.length || pe.bright?.length) ? { colors: pe.colors || [], cues: pe.cues || [], bright: pe.bright || [] } : null;
    const dz = V && rt.designFor ? rt.designFor(playingEntry(), pe) : null; // a song designed by Claude (designer.js): its blocks, colours, moments and energy arc
    if (dz) { D.settings.plan = dz.show; D.settings.timeline = dz.timeline; } D.settings.arc = dz ? dz.arc : null;
    if (rt.spotify && V) D.settings.timeline = rt.spotify.timeline(D.settings.timeline); // the album cover's colours, if on
    if (rt.forced && !V) t = (now + lead) / 1000, V = metronomeView(t, s.metronome.bpm || 124); // "build & drop" pad works even with no music
    V = applyForced(V, t, now);
    rt.view = V; rt.t = t;
    const tx = s.text || {}; extra = { ...(extra || {}), text: tx.source === "custom" ? tx.custom : tx.source === "clock" ? new Date().toTimeString().slice(0, 5)
      : tx.source === "bpm" ? (V && V.bpm ? `${Math.round(V.bpm)} BPM` : "TEMPOLIGHT") : (rt.song ? rt.song.name : rt.source === "idle" ? tx.custom : rt.sourceLabel) };
    if (rt.screen && now - rt.screen.at < 3000) extra.screen = rt.screen; else rt.screen = null;
    let bri = s.brightness; if (!V && sh.mode === "auto") bri *= rt.home?.idleBrightness() ?? s.idleBrightness; // the ambient plan's brightness for this hour, if on
    if (rt.night) bri = Math.min(bri, s.night.maxBrightness);
    if (rt.spotify) bri *= rt.spotify.dim(); // Spotify muted, or a skip's dip
    rt.bri = bri; // the sunrise alarm draws at its own brightness, whatever this is
    const tr = performance.now(), col = D.frame(V, t, extra, wall), tr2 = performance.now(); perf.add("render", tr2 - tr);
    TM.procMs = TM.procMs * 0.9 + Math.min(20, tr2 - now) * 0.1; // how long from the frame's start to sending it, on average
    if (!sh.power) { bri = 0; }
    toRGB8(col, col8, bri);
    fixtures.begin({ V, t, wall, cfg: s.dmx, safe: s.safe, night: !!rt.night, power: sh.power, overlay: D.state.overlay, bri });
    // copy each shape's LEDs into its controller's buffer at its segment range
    const shapes = data().room.shapes;
    const map = rt.mapping && now - rt.mapping.at < 5000 ? rt.mapping : null; if (!map && rt.mapping) { rt.mapping = null; rt.mapEndAt = now; }
    if (map) dropQueued(); // camera mapping: at once, nothing held back
    const sendNow = sh.power || now - rt.powerOffAt < 600 || now - rt.mapEndAt < 600; // after power-off (or mapping with the power off), send black briefly, then go quiet
    for (const d of data().devices) {
      const o = outs.get(d.id); if (o && d.kind === "dmx") { dmxOut(d, o, map, now, tr2); continue; }
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
      if (sendNow && !d.virtual) queueOut(o, o.buf, holdFor(d), tr2);
    }
    // WLED audio sync, so the controllers' own sound-reactive effects can run too
    if (s.audioSync && liveFresh() && now - lastSync > 20) { lastSync = now; sendAudioSync(); }
    const tb = performance.now(); perf.add("output", tb - tr2);
    // preview for the web UI, 30 fps (15 in low-power mode)
    // (held back like a light that is SCREEN_MS late, so the preview and phones show the beat with the lights)
    const fr = loopFps(); ++previewTick;
    const pv = previewTick % Math.max(1, Math.round(fr / (perf.lite ? LITE.previewFps : 30))) === 0 && previewClients.size > 0;
    // phones as extra lights: each phone shows the colour of its own part of the room, so a crowd of phones moves with it
    const ph = phones.size > 0 && previewTick % Math.max(1, Math.round(fr / (perf.lite ? LITE.phoneFps : 30))) === 0;
    if (pv || ph) queueOut(scr, col8, TM.mode === "ahead" ? Math.max(0, TM.L - SCREEN_MS) : 0, tr2, { pv, ph, on: sh.power ? 1 : 0 });
    rt.frames++; fpsN++; if (now - fpsT > 1000) { rt.fps = fpsN * 1000 / (now - fpsT); fpsN = 0; fpsT = now; }
    const end = performance.now(); perf.add("broadcast", end - tb);
    if (perf.frame(end - now, fr)) startLoop(); // auto mode stepped down: the loop restarts at the lower rate
  }
  // DMX: one universe per device, always sent (DMX nodes hold the last values, so stopping could leave fog on),
  // about 40 times a second; dark while camera mapping; zeros for 2 s after it is turned off, then nothing
  function dmxOut(d, o, map, now, at0 = now) {
    if (!d.enabled) { if (o.dmxOn !== false) { o.dmxOn = false; o.offAt = now; } if (now - o.offAt > 2000 || d.virtual) return; if (now - (o.lastSend || 0) >= 100) { o.lastSend = now; o.sender.send(new Uint8Array(512)); } return; }
    o.dmxOn = true; o.buf.fill(0);
    const shapes = data().room.shapes, pts = shapes.find(sp => sp.dev === d.id && sp.type === "points")?.pts || [];
    shapes.forEach((sp, si) => { if (sp.dev !== d.id) return; const r = ranges[si], a = L.chainStart[si], n = Math.min(sp.count, o.size - r.start); if (n > 0) o.buf.set(col8.subarray(a * 3, (a + n) * 3), r.start * 3); });
    const dmx = map ? new Uint8Array(512) : fixtures.render(d, o.buf, pts);
    if (!d.virtual && now - (o.lastSend || 0) >= 24) { o.lastSend = now; if (map) o.sender.send(dmx); else queueOut(o, dmx, holdFor(d), at0); }
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
  function sendScreens(col, m) {
    if (m.pv) { const msg = new Uint8Array(1 + col.length); msg[0] = 1; msg.set(col, 1); for (const c of previewClients) if (c.open && !c.busy) c.send(msg); }
    if (m.ph) sendPhones(m.on, col);
  }
  function sendPhones(on, col8) {
    const list = [...phones].filter(c => c.open), n = list.length, N = L.N; if (!N || col8.length < N * 3) return;
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
  // The frame loop runs against deadlines, not setInterval: each frame is due one frame time after the last was due, and
  // the timer is set for what is left, so a late wake-up doesn't push every later frame back (and they don't drift).
  // A loop that fell more than a frame behind (the computer was busy) starts again from now instead of rushing.
  let loopGen = 0;
  function startLoop() {
    perf.update(); if (rt.live) rt.live.an.lite = perf.lite;
    clearTimeout(timer); const gen = ++loopGen, period = 1000 / loopFps(); let due = performance.now() + period;
    const frameTick = () => {
      if (gen !== loopGen) return; const now = performance.now();
      if (TM.last) { TM.iv.push(now - TM.last); if (TM.iv.length > 120) TM.iv.shift(); } TM.last = now;
      try { frame(now); } catch (e) { note(`Render error: ${e.message}`, "error"); }
      if (gen !== loopGen) return; // frame() restarted the loop (performance mode changed)
      const after = performance.now(); due += period; if (due < after - period) due = after + period;
      timer = setTimeout(frameTick, Math.max(0, due - after - 0.5)); // (timers wake up a little late: ask a little early)
    };
    TM.last = 0; timer = setTimeout(frameTick, period); }

  // ---------------------------------------------------------------- devices
  async function checkDevice(d) {
    const h = health.get(d.id) || {}; health.set(d.id, h);
    if (d.virtual) return Object.assign(h, { online: true, version: "virtual", ledsReported: d.leds, lastSeen: Date.now() });
    if (LK[d.kind]) { try { const t0 = performance.now(), r = await LK[d.kind].check(d); noteRtt(h, performance.now() - t0); return Object.assign(h, { online: true, version: r.version, ledsReported: r.leds, lastSeen: Date.now(), error: null }); }
      catch (e) { if (h.online !== false) note(`${d.name} is not answering (${d.host})`, "warn"); return Object.assign(h, { online: false, error: e.message }); } }
    if (d.kind === "hue") { try { const t0 = performance.now(), l = await io.hueLights(d.host, d.hue?.user); noteRtt(h, performance.now() - t0); hueAreas(d, h);
        return Object.assign(h, { online: true, version: outs.get(d.id)?.sender.mode === "entertainment" ? "Hue bridge (fast mode)" : "Hue bridge", ledsReported: l.length, lastSeen: Date.now(), error: null }); }
      catch (e) { if (h.online !== false) note(`${d.name} is not answering (${d.host})`, "warn"); return Object.assign(h, { online: false, error: e.message }); } }
    if (d.kind === "nanoleaf") { try { const t0 = performance.now(), info = await io.nanoleafInfo(d.host, d.nanoleaf?.token); noteRtt(h, performance.now() - t0); return Object.assign(h, { online: true, version: `Nanoleaf ${info.model}`.trim(), ledsReported: info.panels.length, lastSeen: Date.now(), error: null }); }
      catch (e) { if (h.online !== false) note(`${d.name} is not answering (${d.host})`, "warn"); return Object.assign(h, { online: false, error: e.message }); } }
    if (d.kind === "openrgb") { try { const list = await io.listOpenRGB(ipOf(d.host), d.ddpPort || 6742), c = list.find(x => x.index === (d.orgbIndex || 0));
        return Object.assign(h, { online: !!c, version: c ? `OpenRGB: ${c.name}` : "OpenRGB", ledsReported: c?.leds, lastSeen: Date.now(), error: c ? null : "device not found in OpenRGB" }); }
      catch (e) { if (h.online !== false) note(`${d.name}: OpenRGB is not answering (${d.host}). Is its SDK server running?`, "warn"); return Object.assign(h, { online: false, error: e.message }); } }
    if (d.kind === "dmx") return Object.assign(h, { online: true, version: `DMX: ${d.protocol === "e131" ? "sACN" : "Art-Net"} universe ${d.universe ?? (d.protocol === "e131" ? 1 : 0)}`, ledsReported: (d.fixtures || []).length, lastSeen: Date.now() }); // DMX nodes don't answer
    if (d.kind === "govee") return Object.assign(h, { online: true, version: "Govee (LAN)", ledsReported: d.leds, lastSeen: Date.now() }); // Govee answers status on a shared port; not checked
    try { const t0 = performance.now(), info = await getInfo(d.host, 2500); noteRtt(h, performance.now() - t0); // the round trip, for the latency meter
      Object.assign(h, { online: true, rssi: info.rssi, signal: info.signal, version: info.version, ledsReported: info.leds, fps: info.fps, live: info.live, power: info.power, maxPower: info.maxPower, lastSeen: Date.now(), error: null });
      if (!d.leds && info.leds) { d.leds = info.leds; store.save(); } }
    catch (e) { if (h.online !== false) note(`${d.name} is not answering (${d.host})`, "warn"); Object.assign(h, { online: false, error: e.message }); }
    return h;
  }
  // does the bridge have entertainment areas (so the Devices page can offer fast mode)? Asked every 5 minutes.
  function hueAreas(d, h) { if (!io.hueEntertainmentAreas || Date.now() - (h.areasAt || 0) < 300_000) return; h.areasAt = Date.now();
    io.hueEntertainmentAreas(d.host, d.hue?.user, { clipPort: d.hue?.clipPort }).then(a => { h.hueAreas = a.map(x => ({ id: x.id, name: x.name })); }, () => { h.hueAreas ||= []; }); }
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
    data().show.power = !!on; store.save(); if (!on) { rt.powerOffAt = performance.now(); dropQueued(); } else rt.powerOnAt = Date.now(); // (frames held back from before would turn lights on again)
    note(on ? "Lights on" : "Lights off");
    await Promise.all(data().devices.filter(d => d.enabled && !d.virtual).map(d => d.kind === "openrgb" || d.kind === "dmx" ? null : d.kind === "govee" || d.kind === "nanoleaf" || d.kind === "hue" || LK[d.kind] ? outs.get(d.id)?.sender.power?.(!!on) : setState(d.host, { on: !!on }, 2000).catch(() => {})));
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
      case "fog": { const r = fixtures.manualFog(on ?? true, wall, data().settings.dmx); if (!r.ok && on !== false) note(`Fog: ${r.why}`, "warn"); break; } // the manual fog pad (DMX)
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

  // ---------------------------------------------------------------- the sync meter and the song map (songmap.js)
  const syncMem = {}, liveMap = createLiveMap(), mapCache = new WeakMap(), r3 = v => Math.round(v * 1000) / 1000;
  /** How locked on the beat it is: {score 0-100, state locked|finding|none, hint, source}. */
  function syncInfo(h) {
    const an = liveFresh() ? rt.live.an : null;
    return syncScore({ source: rt.source, ext: an ? rt.extBeat || null : null, live: an ? { conf: an.conf, drumless: an.drumless(), misses: rt.mem.lock?.miss || 0 } : null,
      lock: !!(an && rt.mem.lock), level: h.level, sound: h.sound, listening: !!h.via }, syncMem, performance.now());
  }
  const songPos = () => rt.song.pos + (rt.song.playing ? (performance.now() - rt.song.at) / 1000 * rt.song.rate : 0);
  const mapOf = (key, pre) => { const v = `${key.at}:${key.dur}:${key.env?.length}`; let c = mapCache.get(key); // (made again if a remembered song was learned further)
    if (!c || c.v !== v) mapCache.set(key, c = { v, m: songMap(pre()) }); return c.m; };
  const NO_MAP = { source: null, id: null, name: null, playing: false, growing: false, pos: null, dur: 0, env: [], envStep: 0.02, sections: [], drops: [], bars: [], phrase: null };
  /**
   * The song map: of a remembered song (id), else of what plays now: a song played here, one a music app plays or song
   * memory follows (all known ahead), or a song heard live that isn't known (made as it is heard: growing). undefined:
   * no such song.
   */
  function songMapNow(id) {
    if (id != null) { const e = data().songs.find(x => x.id === id); if (!e) return undefined; return { ...NO_MAP, source: "memory", id: e.id, name: e.name, ...mapOf(e, () => memoryAnalysis(e)) }; }
    if (rt.source === "song" && rt.song) return { ...NO_MAP, source: "song", id: rt.song.memId || null, name: rt.song.name, playing: !!rt.song.playing, ...mapOf(rt.song.pre, () => rt.song.pre), pos: r3(songPos()) };
    const e = playingEntry();
    if (rt.source === "nowplaying" && e) return { ...NO_MAP, source: "memory", id: e.id, name: e.name, playing: true, ...mapOf(e, () => memoryAnalysis(e)), pos: r3(rt.t || 0) };
    if (rt.mem.lock && liveFresh()) { const L = rt.mem.lock; return { ...NO_MAP, source: "memory", id: L.id, name: L.name, playing: true, ...mapOf(L.pre, () => L.pre), pos: r3(lockPos(L, rt.live.an.t)) }; }
    if (liveFresh() && liveMap.length) return { ...NO_MAP, source: "live", name: rt.live.label, playing: true, growing: true, ...liveMap.map(rt.live.an.t) };
    return { ...NO_MAP };
  }

  /** The next drop for the status: {next: seconds until it, at: when (the music's clock), conf 0..1, source: "memory"
   *  (known ahead: an analysed or remembered song, a show's cue, the Build & drop pad) | "predicted" (heard coming, live) |
   *  null, building: the lights are building toward it}. */
  function dropInfo(V, t) {
    const at = V && V.nextDrop != null && Number.isFinite(V.nextDrop) && Number.isFinite(t) && V.nextDrop >= t - 0.05 ? V.nextDrop : null, r = D.ramp, r2 = v => Math.round(v * 100) / 100;
    if (at == null) return { next: null, at: null, conf: 0, source: null, building: false };
    return { next: r2(Math.max(0, at - t)), at: r2(at), conf: r2(Math.max(0, Math.min(1, V.dropConf ?? 1))), source: V.dropSource === "predicted" ? "predicted" : "memory", building: !!(r && r.building && Math.abs(r.at - at) < 0.5) };
  }
  function status() {
    const V = rt.view, an = liveFresh() ? rt.live.an : null, hear = hearingInfo();
    return {
      type: "status", source: rt.source, sourceLabel: rt.sourceLabel, fps: Math.round(rt.fps), leds: L.N, effect: D.showing, effectName: fx.list.find(e => e.id === D.showing)?.name || D.showing, style: D.style,
      styleName: fx.styles[D.style]?.name || D.style, bpm: V && V.bpm ? Math.round(V.bpm * 10) / 10 : null, part: V ? V.state : "idle",
      beat: V && V.g.has ? V.g.beatInBar : null, drop: dropInfo(V, rt.t), level: an ? Math.round(Math.min(1, an.eFast / an.eMax) * 100) / 100 : V ? Math.round((V.loud || 0) * 100) / 100 : 0,
      bands: an ? Array.from(an.bands, v => Math.round(v * 100) / 100) : null, key: V && V.key ? { key: V.key, mode: V.mode, name: `${V.key} ${V.mode}`, confidence: V.keyConf ?? 0 } : null, mood: V && V.mood ? { ...V.mood, name: moodName(V.mood) } : null, hears: V ? hearsLabel(V.key, V.mode, V.mood) : null, vocal: an ? Math.round(an.vocal * 100) / 100 : null, mapping: rt.mapping ? { device: rt.mapping.dev, led: rt.mapping.led } : null, djlink: djFresh(performance.now()) ? { name: rt.dj.name, bpm: rt.dj.bpm, beatInBar: rt.dj.beatInBar } : null, recognised: rt.mem.lock && liveFresh() ? { id: rt.mem.lock.id, name: rt.mem.lock.name, pos: Math.round(lockPos(rt.mem.lock, rt.live.an.t) * 10) / 10, dur: rt.mem.lock.pre.dur } : null, power: data().show.power, brightness: data().settings.brightness, night: !!rt.night, home: rt.home ? rt.home.status() : null, mqtt: rt.mqtt || null, phones: phones.size, screen: rt.screen ? rt.screen.label || "A shared screen" : null,
      look: lookInfo(D.look, { song: playingEntry()?.id || null }),
      design: rt.designStatus ? rt.designStatus(playingEntry()) : null, // the Claude show designer for the song playing (designer.js)
      song: rt.song ? { memId: rt.song.memId || null, name: rt.song.name, playing: rt.song.playing, pos: rt.song.pos + (rt.song.playing ? (performance.now() - rt.song.at) / 1000 * rt.song.rate : 0), dur: rt.song.pre.dur, bpm: rt.song.pre.bpm, style: rt.song.pre.style, drops: rt.song.pre.drops } : null,
      nowPlaying: rt.nowPlaying ? rt.nowPlaying.info() : null, spotify: rt.spotify ? rt.spotify.info() : null,
      capture: rt.capture ? { label: rt.capture.label, running: !!rt.capture.proc, error: rt.capture.error } : null, hearing: hear, offsetMs: syncOffset(), timing: timingInfo(), sync: syncInfo(hear),
      overlay: overlayState(), devices: data().devices.map(d => { const o = outs.get(d.id), { rtts, ...h } = health.get(d.id) || {}; void rtts;
        return { id: d.id, ...h, sent: o?.sender.sent || 0, used: o?.used || 0, amps: Math.round((o?.amps || 0) * 100) / 100, limited: !!o?.limited, ...latencyOf(d, h, o) }; }),
      uptime: Math.round((Date.now() - rt.startedAt) / 1000), perf: { ...perf.status(), fps: perf.fps || Math.round(rt.fps) },
      ...beats.status(performance.now()), dmx: data().devices.some(d => d.kind === "dmx") ? fixtures.status(performance.now() / 1000) : null,
    };
  }

  // the latency meter: sound-to-light delay per device and what may be wrong (see latency.js)
  // timing: what light timing does about it: {mode, lightMs (its own delay), auto (estimated, not set by hand), holdMs
  // (held back), shownMs (what is left of the delay: about 0 when it is lined up and the trim is 0), level}
  function latencyOf(d, h, o) {
    const s = data().settings, since = Math.max(rt.startedAt, rt.powerOnAt || 0, o?.createdAt || 0);
    const r = deviceLatency({ dev: d, health: h, out: o || {}, fps: rt.fps || s.fps, offsetMs: syncOffset(), audio: audioDelay({ source: rt.source, live: liveFresh() ? rt.live : null }),
      streaming: !!(data().show.power && d.enabled && o), streamingFor: ((h.lastSeen || 0) - since) / 1000 }); // how long we had been sending when it was last checked
    const l = r.latency, made = TM.mode === "ahead" ? Math.round(TM.common + Math.min(l.lightMs, TM.L)) : 0, shownMs = r.latencyMs == null ? null : r.latencyMs - made;
    return { ...r, timing: { mode: TM.mode, lightMs: l.lightMs, auto: l.lightAuto, holdMs: Math.round(holdFor(d)), shownMs, level: level(shownMs) } };
  }
  function layoutInfo() {
    return { N: L.N, x: Array.from(L.LX, v => Math.round(v * 100) / 100), y: Array.from(L.LY, v => Math.round(v * 100) / 100), shape: Array.from(L.LF), chainStart: L.chainStart, ranges, shapes: data().room.shapes };
  }

  function updateNight() {
    const n = data().settings.night, on = !!(n && n.enabled && inWindow(n.from, n.to, now(), data().settings.location)) || !!rt.planNight; // or a "night" row of the ambient plan
    if (on !== !!rt.night) { rt.night = on; syncDirector(); note(on ? "Night mode on" : "Night mode off"); }
  }
  const nightTimer = setInterval(updateNight, 5000);

  rebuild(); startLoop(); updateNight();
  healthLoop(); healthTimer = setInterval(healthLoop, 10_000);
  if (data().settings.capture.enabled) startCaptureSource();

  return {
    get layout() { return L; }, get effects() { return fx; }, get director() { return D; }, perf, rt, log, listeners, previewClients, phones, health,
    rebuild, rebuildEffects, syncDirector, startLoop, syncOffset, setOutput, hearingInfo, updateNight, pushPcm, stopLive, startCaptureSource, stopCaptureSource, setSong, songClock, clearSong,
    fixtures, beats, identify, syncSegments, setPower, action, status, songMapNow, setScreen, clearScreen, remember, forget, songs, songById, saveSong, prepareSong, djBeat, djOnAir, planFor, freshShow, lookNext, lookKeep, lookOf, playingEntry, setDraft, mapLight, endMap, layoutInfo, checkDevice, note,
    close() { for (const [id, o] of outs) if (data().devices.find(d => d.id === id)?.kind === "dmx") try { o.sender.send(new Uint8Array(512)); } catch {} // DMX: leave everything at zero
      loopGen++; clearTimeout(timer); clearTimeout(flushTimer); clearInterval(healthTimer); clearInterval(nightTimer); stopCaptureSource(); for (const o of outs.values()) o.sender.close(); syncSender.s && syncSender.s.close(); },
  };
}

export function hexRgb(h) { const m = /^#?([0-9a-f]{6})$/i.exec(String(h)); if (!m) return [1, 1, 1]; const n = parseInt(m[1], 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; }
