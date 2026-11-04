// Default settings and a deep merge, shared by the Node server and the in-browser demo.
export const DEFAULTS = () => ({
  version: 2,
  settings: {
    brightness: 0.8, fps: 60, safe: false, syncOffsetMs: 0, predict: true,
    ambient: "northern", idleBrightness: 0.5, idleAfterSec: 8, dropFlash: true,
    audioSync: false, osc: { enabled: false, port: 9000 }, autoDiscover: true,
    capture: { enabled: false, source: "auto", command: "" }, metronome: { enabled: false, bpm: 120 },
    guest: { effects: true, scenes: true, pads: true, brightness: true },
    effectPrefs: {}, // effect id -> 1 liked, -1 banned (automatic mode)
    location: null,  // {lat, lon, name} for sunrise/sunset schedules and night mode
    night: { enabled: false, from: "23:00", to: "07:00", maxBrightness: 0.3, warm: true }, // calmer light at night
    text: { source: "song", custom: "TEMPOLIGHT" }, // what Text Scroller shows on matrix panels: song, bpm, clock or custom
    mqtt: { enabled: false, url: "", username: "", password: "", prefix: "homeassistant", base: "tempolight" }, // Home Assistant
    djlink: { enabled: false, port: 50001 }, // Pioneer Pro DJ Link: take the beat from CDJs/XDJs
    link: { enabled: false, port: 20808 }, // Ableton Link: follow a Link session's tempo and beat (listens only)
    // DMX fixtures (devices of kind "dmx"): a master switch; lasers and fog stay off until turned on here (see fixtures.js)
    dmx: { enabled: true, lasers: false, fog: false, fogWhen: "before", fogLead: 4, fogBurst: 3, fogCooldown: 60, fogMaxDuty: 0.1, fogLevel: 1, laserMaxSec: 60 },
    requests: true, // guests can request songs from their phones (/request)
    shows: true, // remembered songs play their show timeline (auto-generated, editable) in automatic mode
    setupDone: false, // the setup wizard was finished or skipped (it opens by itself on a first start with no lights)
    songMemory: true, // remember analysed songs and recognise them when they play again while listening live
    nowPlaying: { enabled: true, spotifyClientId: "" }, // read the track music apps on this computer play (server only, see nowplaying.js)
    moodColours: true, // with the "auto" palette, colours follow the music's mood (key, brightness, energy)
  },
  show: { power: true, mode: "auto", effect: "shock", style: "auto", palette: "auto", everyBeats: 8, speed: 1, params: {}, layer: null },
  devices: [],
  room: { name: "My room", shapes: [], zones: [] },
  scenes: [
    // names that read well to a voice assistant ("Hey Google, activate Party mode", see docs/voice.md); new installs only
    { id: "party", name: "Party mode", show: { mode: "auto", style: "party", palette: "auto" }, brightness: 1 },
    { id: "chill", name: "Chill mode", show: { mode: "auto", style: "chill", palette: "sunset" }, brightness: 0.55 },
    { id: "movie", name: "Movie mode", show: { mode: "manual", effect: "candle", palette: "mono" }, brightness: 0.25 },
    { id: "focus", name: "Focus mode", show: { mode: "manual", effect: "aurora", palette: "ocean" }, brightness: 0.4 },
    { id: "relax", name: "Relax", show: { mode: "manual", effect: "breath", palette: "sunset" }, brightness: 0.3 },
  ],
  schedules: [],
  songs: [],
  customEffects: [], // effects made in the Effects page from parts (see createEffects' customEffect)
  requests: [], // guest song requests: {id, title, by, votes, at, done} // song memory: compact analyses of songs played through Tempolight (see engine/src/memory.js)
  lock: null,
});

export function merge(base, over) {
  if (Array.isArray(base) || Array.isArray(over) || typeof base !== "object" || base === null || typeof over !== "object" || over === null) return over === undefined ? base : over;
  const out = { ...base }; for (const k of Object.keys(over)) out[k] = merge(base[k], over[k]); return out;
}

