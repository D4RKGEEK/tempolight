// Shared schemas for mintlify/openapi.json (scripts/gen-openapi.js). Shapes come from the server's code
// (packages/server/src/defaults.js, core.js and the modules it plugs in) and docs/api.md. Where the code passes an
// object through without fixing its fields, the schema says so (additionalProperties) rather than guessing.

export const ref = name => ({ $ref: `#/components/schemas/${name}` });
export const nullable = s => s.$ref || !s.type ? { anyOf: [s, { type: "null" }] } : { ...s, type: [].concat(s.type, "null"), ...(s.enum ? { enum: [...s.enum, null] } : {}) };
export const str = (description, extra = {}) => ({ type: "string", ...(description ? { description } : {}), ...extra });
export const num = (description, extra = {}) => ({ type: "number", ...(description ? { description } : {}), ...extra });
export const int = (description, extra = {}) => ({ type: "integer", ...(description ? { description } : {}), ...extra });
export const bool = (description, extra = {}) => ({ type: "boolean", ...(description ? { description } : {}), ...extra });
export const en = (values, description, extra = {}) => ({ type: "string", enum: values, ...(description ? { description } : {}), ...extra });
export const arr = (items, description, extra = {}) => ({ type: "array", items, ...(description ? { description } : {}), ...extra });
/** An object; `open` (default true) lets other fields through, since most answers carry more than is listed. */
export const obj = (properties, { required, description, open = true, ...extra } = {}) => ({ type: "object", ...(description ? { description } : {}), properties,
  ...(required ? { required } : {}), ...(open === false ? { additionalProperties: false } : {}), ...extra });
export const loose = description => ({ type: "object", additionalProperties: true, description });

const hex = str("A colour, `#rrggbb`.", { pattern: "^#[0-9a-fA-F]{6}$", example: "#ff0066" });
const iso = str("An ISO date and time.", { format: "date-time" });
const unit = (d, extra) => num(d, { minimum: 0, maximum: 1, ...extra });
const target = str("Where it shows: `all`, `off`, `zone:<zone id>` or `dev:<device id>`.", { example: "all" });

export const schemas = {
  Error: obj({ error: str("What went wrong, in a sentence for people.") }, { required: ["error"], example: { error: "No such device" } }),
  Ok: obj({ ok: bool(undefined, { const: true }) }, { required: ["ok"], example: { ok: true } }),
  Color: hex,

  // ------------------------------------------------------------ show and effects
  Layer: obj({ effect: str("An effect id."), amount: num("How strongly the accent layer shows, 0 to 1.5.", { minimum: 0, maximum: 1.5 }) }, { required: ["effect"], description: "An accent effect drawn on top of the main one." }),
  EffectParams: obj({
    speed: num("0.1 to 4.", { minimum: 0.1, maximum: 4 }), intensity: num("0 to 3.", { minimum: 0, maximum: 3 }),
    hue: num("Hue shift in degrees, -180 to 180.", { minimum: -180, maximum: 180 }), saturation: num("0 to 2.", { minimum: 0, maximum: 2 }), mirror: bool(),
  }, { description: "One effect's own settings." }),
  Show: obj({
    power: bool("The lights are on."),
    mode: en(["auto", "manual"], "`auto` picks effects from the music; `manual` keeps `effect`."),
    effect: str("The effect shown in manual mode."),
    style: str("`auto` or a style id (`party`, `chill`, …)."),
    palette: str("`auto` or a palette id (`sunset`, `ocean`, …)."),
    everyBeats: int("Automatic mode changes effect at most every this many beats, 1 to 64.", { minimum: 1, maximum: 64 }),
    speed: num("0.1 to 4.", { minimum: 0.1, maximum: 4 }),
    params: { type: "object", additionalProperties: ref("EffectParams"), description: "Per-effect settings, by effect id." },
    layer: nullable(ref("Layer")),
  }, { description: "What the lights show.", example: { power: true, mode: "auto", effect: "shock", style: "auto", palette: "auto", everyBeats: 8, speed: 1, params: {}, layer: null } }),
  ShowPatch: obj({
    mode: en(["auto", "manual"]), effect: str("An effect id. Setting it alone switches to manual mode."), style: str("`auto` or a style id."), palette: str("A palette id."),
    everyBeats: int(undefined, { minimum: 1, maximum: 64 }), speed: num(undefined, { minimum: 0.1, maximum: 4 }), layer: nullable(ref("Layer")),
  }, { open: false }),
  Effect: obj({ id: str(), name: str(), tag: en(["calm", "build", "drop", "home"], "When automatic mode uses it."), custom: bool("One of your own effects.") }, { required: ["id", "name"], example: { id: "laser", name: "Laser", tag: "drop" } }),
  CustomEffectInput: obj({
    name: str(undefined, { maxLength: 40 }),
    pattern: en(["wave", "chase", "pulse", "sparkle", "fill", "breathe", "gradient"]),
    axis: en(["along", "x", "y", "around", "centre"], undefined, { default: "along" }),
    drive: en(["beat", "kick", "bass", "loud", "time"], "What moves it.", { default: "beat" }),
    tag: en(["calm", "build", "drop", "home"], undefined, { default: "drop" }),
    colors: { anyOf: [{ type: "string", const: "palette" }, arr(hex, undefined, { minItems: 2, maxItems: 2 })], description: "`palette`, or two colours." },
    speed: num(undefined, { minimum: 0.1, maximum: 8, default: 1 }), width: num(undefined, { minimum: 0.01, maximum: 1, default: 0.15 }),
    cycles: num(undefined, { minimum: 0.25, maximum: 8, default: 1 }), bg: num("Background glow.", { minimum: 0, maximum: 0.5, default: 0.05 }),
  }, { required: ["pattern"], example: { name: "Pink chase", pattern: "chase", axis: "along", drive: "kick", tag: "drop", colors: ["#ff0066", "#00ccff"], speed: 2, width: 0.1 } }),
  CustomEffect: { allOf: [obj({ id: str("`u-…`") }, { required: ["id"] }), ref("CustomEffectInput")],
    example: { id: "u-k3j9q2", name: "Pink chase", tag: "drop", pattern: "chase", axis: "along", drive: "kick", colors: ["#ff0066", "#00ccff"], speed: 2, width: 0.1, bg: 0.05, cycles: 1 } },
  Zone: obj({ id: str(), name: str(), mode: en(["follow", "effect", "ambient", "off"]), effect: nullable(str("For mode `effect`.")), brightness: unit() }, { example: { id: "z1", name: "Desk", mode: "effect", effect: "aurora", brightness: 0.7 } }),
  Pads: obj({ strobe: bool(), blackout: bool(), freeze: bool(), hold: bool("A colour is held."), boost: num("Brightness gain, 0 to 2."), forced: nullable(en(["build", "drop"])) },
    { description: "The live pads' state.", example: { strobe: false, blackout: false, freeze: false, hold: false, boost: 1, forced: null } }),
  Action: obj({
    type: en(["flash", "strobe", "blackout", "freeze", "hold", "boost", "next", "drop", "build", "cancel", "tap", "identify", "fog"]),
    color: { ...hex, description: "`flash`, `hold`: the colour (none: white, or release the hold)." },
    on: bool("`strobe`, `blackout`, `freeze`, `fog`: on or off (left out: toggle)."),
    value: num("`boost`: brightness gain 0 to 2.", { minimum: 0, maximum: 2 }),
    seconds: num("`build`: how long the build-up lasts (default 8)."),
    device: str("`identify`: a device id."), shape: int("`identify`: a shape index."),
  }, { required: ["type"], example: { type: "flash", color: "#ff0066" } }),

  // ------------------------------------------------------------ scenes, schedules
  Scene: obj({ id: str(), name: str(), show: loose("The show fields this scene sets (see Show)."), brightness: unit() }, { required: ["id", "name"],
    example: { id: "party", name: "Party mode", show: { mode: "auto", style: "party", palette: "auto" }, brightness: 1 } }),
  ScheduleAction: { anyOf: [
    obj({ type: { const: "scene" }, scene: str("A scene id.") }, { required: ["type", "scene"], title: "Apply a scene" }),
    obj({ type: en(["on", "off"]) }, { required: ["type"], title: "Lights on or off" }),
    obj({ type: { const: "brightness" }, value: unit() }, { required: ["type", "value"], title: "Set brightness" }),
  ], example: { type: "scene", scene: "chill" } },
  ScheduleInput: obj({
    name: str(undefined, { maxLength: 60 }),
    time: str("`HH:MM`, or `sunrise`/`sunset` with an optional offset in minutes (needs a location in Settings).", { example: "sunset+30" }),
    days: arr(int(undefined, { minimum: 0, maximum: 6 }), "Weekdays, 0 = Sunday."),
    action: ref("ScheduleAction"), enabled: bool(undefined, { default: true }),
  }, { example: { name: "Evening", time: "sunset+30", days: [1, 2, 3, 4, 5], action: { type: "scene", scene: "chill" }, enabled: true } }),
  Schedule: { allOf: [obj({ id: str("`t…`"), next: nullable(str("The next time it runs (ISO).", { format: "date-time" })) }, { required: ["id"] }), ref("ScheduleInput")],
    example: { id: "t8f2k1", name: "Evening", time: "sunset+30", days: [1, 2, 3, 4, 5], action: { type: "scene", scene: "chill" }, enabled: true, next: "2026-11-04T17:12:00.000Z" } },

  // ------------------------------------------------------------ devices and room
  DeviceHealth: obj({
    online: bool(), version: str("What answered (`0.15.0`, `Hue bridge`, `virtual`, …)."), ledsReported: int(), lastSeen: num("Milliseconds since 1970."), error: nullable(str()),
    rssi: num("WLED Wi-Fi signal (dBm)."), signal: num("WLED Wi-Fi signal (%)."), fps: num(), live: bool(), power: num(), maxPower: num(), rttMs: num(),
  }, { description: "The last check of a device. Fields depend on the kind of device." }),
  Device: obj({
    id: str("`d…`"), name: str(), host: str("Its address (`virtual` for a virtual room)."),
    kind: en(["govee", "openrgb", "hue", "nanoleaf", "lifx", "wiz", "kasa", "yeelight", "twinkly", "dmx"], "Left out for WLED."),
    leds: int(), ddpPort: int(), enabled: bool(), virtual: bool(),
    protocol: en(["ddp", "e131", "artnet"]), universe: int(), maxAmps: num(undefined, { minimum: 0, maximum: 500 }), mAperLed: num(undefined, { minimum: 5, maximum: 200 }),
    goveeMode: en(["color", "segments"]), goveeSegments: int(),
    light: loose("Smart lights: what was found (for example `zones`) and their options."),
    hue: obj({ lights: arr(str()), names: arr(str()), fast: bool(), area: nullable(str()), areas: arr(obj({ id: str(), name: str() })), fastKey: bool() }, { description: "Hue bridges only." }),
    nanoleaf: obj({ panels: arr(int()) }, { description: "Nanoleaf only." }),
    fixtures: arr(ref("Fixture"), "DMX devices only."),
    health: nullable(ref("DeviceHealth")),
  }, { required: ["id", "name", "host"], example: { id: "d4k2x9", name: "Desk strip", host: "192.168.1.42", ddpPort: 4048, leds: 120, enabled: true } }),
  DeviceInput: { anyOf: [
    obj({ host: str(undefined, { example: "192.168.1.42" }), name: str(), ddpPort: int(), leds: int(), force: bool("Add it even when it doesn't answer.") }, { required: ["host"], title: "WLED", description: "The LED count is read from WLED." }),
    obj({ virtual: { const: true }, name: str(), leds: int() }, { required: ["virtual"], title: "Virtual room", description: "A pretend room that sends nothing." }),
    obj({ host: str(), kind: { const: "govee" }, goveeMode: en(["color", "segments"]), leds: int() }, { required: ["host", "kind"], title: "Govee (beta)" }),
    obj({ host: str(undefined, { example: "127.0.0.1" }), kind: { const: "openrgb" }, index: int(), ddpPort: int(undefined, { default: 6742 }), name: str(), force: bool() }, { required: ["host", "kind"], title: "OpenRGB" }),
    obj({ host: str(), kind: { const: "hue" }, name: str() }, { required: ["host", "kind"], title: "Philips Hue", description: "Press the bridge's link button first." }),
    obj({ host: str(), kind: { const: "nanoleaf" }, name: str() }, { required: ["host", "kind"], title: "Nanoleaf", description: "Hold the power button for 5-7 s first." }),
    obj({ host: str(), kind: en(["lifx", "wiz", "kasa", "yeelight", "twinkly"]), name: str(), force: bool() }, { required: ["host", "kind"], title: "Smart lights" }),
    obj({ host: str(undefined, { example: "192.168.1.60" }), kind: { const: "dmx" }, name: str(), protocol: en(["artnet", "e131"]), universe: int("Art-Net counts from 0, sACN from 1.") }, { required: ["host", "kind"], title: "DMX universe" }),
  ], example: { host: "192.168.1.42", name: "Desk strip" } },
  DevicePatch: obj({
    name: str(), host: str(), leds: int(), ddpPort: int(), enabled: bool(), maxAmps: num("Caps brightness to the power supply.", { minimum: 0, maximum: 500 }), mAperLed: num(undefined, { minimum: 5, maximum: 200 }),
    protocol: en(["ddp", "e131", "artnet"]), universe: nullable(int()), goveeMode: en(["color", "segments"]), goveeSegments: nullable(int()),
    light: loose("Smart light options: `music` (Yeelight), `perZone` (Kasa strip), `rtPort` (Twinkly)."),
    hueFast: bool("Hue: fast mode (Entertainment streaming)."), hueArea: str("Hue: the entertainment area for fast mode."),
  }, { example: { name: "TV backlight", maxAmps: 4 } }),
  DiscoveredDevice: obj({ host: str(), ip: str(), name: str(), leds: int(), kind: str("Left out for WLED."), index: int("OpenRGB only."), added: bool("Already one of your devices.") },
    { example: { host: "wled-desk.local", ip: "192.168.1.42", name: "WLED-Desk", leds: 120, added: false } }),
  Shape: obj({
    type: en(["line", "pole", "free", "circle", "rect", "hex", "tri", "matrix", "points"]), name: str(), dev: str("The device id it belongs to."),
    count: int("LEDs, 1 to 8192.", { minimum: 1, maximum: 8192 }), from: nullable(int("Its first LED on the device; null: after the previous shape.")),
    rev: bool(), rot: num(), start: num(), zone: nullable(str()),
    pts: arr(arr(num(), undefined, { minItems: 2, maxItems: 2 }), "Points `[x, y]` for lines; for `points`, one LED at each."),
    cx: num(), cy: num(), size: num(), w: num(), h: num(), cols: int(), rows: int(),
  }, { required: ["type", "dev", "count"], description: "A piece of the room on a 16 x 9 wall view, y = 0 at the top.",
    example: { type: "line", name: "Desk strip", count: 120, dev: "d4k2x9", rot: 0, start: 0, rev: false, from: null, zone: null, pts: [[1.5, 6], [14.5, 6]] } }),
  Room: obj({ name: str(), shapes: arr(ref("Shape")), zones: arr(ref("Zone")) },
    { example: { name: "My room", shapes: [{ type: "line", name: "Desk strip", count: 120, dev: "d4k2x9", rot: 0, start: 0, rev: false, from: null, zone: null, pts: [[1.5, 6], [14.5, 6]] }], zones: [] } }),
  Layout: obj({ N: int("LEDs in all."), x: arr(num()), y: arr(num()), shape: arr(int(), "Shape index per LED."), chainStart: { description: "Where each device's LEDs start." },
    ranges: arr(obj({ dev: str(), start: int(), end: int() })), shapes: arr(ref("Shape")) }),

  // ------------------------------------------------------------ DMX
  FixtureInput: obj({
    profile: str("`rgb`, `rgbw`, `rgba`, `dimmer`, `strobe`, `moving-head`, `moving-head-16`, `moving-head-wheel`, `moving-head-wheel-16`, `laser`, `fog` or `custom`.", { default: "rgb" }),
    address: int("The first DMX channel.", { minimum: 1, maximum: 512 }), name: str(),
    channels: arr(str(), "`custom` only: channel types (`GET /api/dmx/profiles`), or `fixed:<value>`."),
    pattern: en(["circle", "figure8", "sweep", "point", "still"], "Moving heads."), target: arr(num(), "`[x, y]` in the room, for `point`."),
    cycle: num("Beats per loop.", { minimum: 1, maximum: 64 }), size: num(undefined, { minimum: 0, maximum: 0.5 }), phase: num(undefined, { minimum: 0, maximum: 1 }),
    home: arr(num(), "`[pan, tilt]`, 0 to 1."), panRange: num("Degrees.", { minimum: 90, maximum: 720 }), tiltRange: num("Degrees.", { minimum: 90, maximum: 360 }),
    wheel: arr(obj({ value: int(), color: arr(int()) })), gobos: arr(int()), patterns: arr(int()),
    shutter: nullable(obj({ open: int(), closed: int(), strobe: arr(int()) })),
    x: num("Where it is in the room, 0 to 16."), y: num("0 to 9."),
  }, { example: { profile: "moving-head", address: 1, name: "Left head", pattern: "figure8", x: 3, y: 1 } }),
  Fixture: obj({ id: str("`f…`"), profile: str(), name: str(), address: int() }, { required: ["id", "profile", "address"], description: "A DMX fixture; also has any FixtureInput fields that were set.",
    example: { id: "f7h2m0", profile: "moving-head", name: "Left head", address: 1, pattern: "figure8" } }),
  FixtureResult: obj({ fixture: ref("Fixture"), warnings: arr(str(), "Fixtures whose channels overlap.") }, { required: ["fixture", "warnings"],
    example: { fixture: { id: "f7h2m0", profile: "moving-head", name: "Left head", address: 1, pattern: "figure8" }, warnings: [] } }),

  // ------------------------------------------------------------ music
  SongSummary: obj({ id: str("`m…`"), name: str(), bpm: num(), dur: num("Seconds."), style: str(), drops: int("How many drops."), at: num("When it was remembered (ms)."),
    spotifyId: str(), src: en(["learned", "shared", "spotify-analysis"]), cover: int("Percent learned, for a partly learned song.") },
    { example: { id: "m9x2q1", name: "One More Time", bpm: 122.7, dur: 320.4, style: "party", drops: 3, at: 1762200000000 } }),
  ColorBlock: { anyOf: [obj({ t0: num(), t1: num(), palette: str() }, { required: ["t0", "t1", "palette"] }), obj({ t0: num(), t1: num(), colors: arr(hex) }, { required: ["t0", "t1", "colors"] })] },
  Cue: obj({ t: num(), type: en(["flash", "strobe", "blackout", "build", "drop"]), color: hex, beats: num(undefined, { minimum: 0.25, maximum: 128 }) }, { required: ["t", "type"] }),
  ShowBlock: obj({ t0: num(), t1: num(), part: str("`calm`, `build` or `drop`."), effect: str() }, { required: ["t0", "t1", "effect"] }),
  Keyframe: obj({ t: num(), v: unit() }, { required: ["t", "v"] }),
  SongShowInput: obj({ show: arr(ref("ShowBlock")), colors: arr(ref("ColorBlock")), cues: arr(ref("Cue")), bright: arr(ref("Keyframe")) },
    { description: "Times are seconds on the song's clock; at most 500 of each.", example: { show: [{ t0: 0, t1: 32, part: "calm", effect: "aurora" }, { t0: 32, t1: 64, part: "drop", effect: "laser" }], cues: [{ t: 32, type: "flash", color: "#ffffff" }], bright: [{ t: 0, v: 0.4 }, { t: 32, v: 1 }] } }),
  SongShow: obj({ id: str(), name: str(), dur: num(), edited: bool(), show: arr(ref("ShowBlock")), colors: arr(ref("ColorBlock")), cues: arr(ref("Cue")), bright: arr(ref("Keyframe")) },
    { example: { id: "m9x2q1", name: "One More Time", dur: 320.4, edited: true, show: [{ t0: 0, t1: 32, part: "calm", effect: "aurora" }], colors: [], cues: [], bright: [] } }),
  SongInput: obj({ name: str(), analysis: loose("The result of `preAnalyseCore()` from `/engine/analysis.js`; must have `bpm`."), clientId: str("The WebSocket connection's id, from its `hello` message.") },
    { required: ["analysis"], example: { name: "My song.mp3", analysis: { bpm: 124, dur: 210.5 }, clientId: "c3k9" } }),
  SongClock: obj({ pos: num("Seconds."), playing: bool(), rate: num(undefined, { default: 1 }) }, { required: ["pos", "playing"], example: { pos: 42.3, playing: true, rate: 1 } }),
  SoundSource: obj({ id: str(), label: str() }, { example: { id: "pulse:alsa_output.monitor", label: "Speakers (monitor)" } }),
  SongRequest: obj({ id: str("`r…`"), title: str(), by: str(), votes: int(), at: num("When it was asked for (ms)."), done: bool(), merged: bool("The same song was asked for already: a vote was added.") },
    { example: { id: "r2k8d1", title: "Daft Punk – One More Time", by: "Sam", votes: 3, at: 1762200000000 } }),

  // ------------------------------------------------------------ home
  HomeStatus: obj({
    wake: nullable(obj({ phase: en(["pending", "rising", "snoozed", "holding", "ending"]), start: iso, end: iso, progress: unit(), snoozeUntil: nullable(iso) })),
    nextWake: nullable(iso), sleep: nullable(obj({ start: iso, end: iso, progress: unit(), left: int("Seconds left.") })),
    plan: nullable(obj({ name: str(), index: int(), night: bool(), fading: bool() })),
  }, { example: { wake: null, nextWake: "2026-11-05T06:30:00.000Z", sleep: { start: "2026-11-04T22:00:00.000Z", end: "2026-11-04T22:30:00.000Z", progress: 0.2, left: 1440 }, plan: null } }),
  WakeSettings: obj({ enabled: bool(), source: en(["times", "phone"]), days: arr(str(), "7 times like `07:00`, Sunday first; empty for no alarm.", { minItems: 7, maxItems: 7 }),
    duration: int("Minutes the sunrise takes, 10 to 40."), target: str("`all`, `zone:<id>` or `dev:<id>`."), endColor: hex, endBrightness: num(), holdMin: int(), snoozeMin: int(),
    key: str("The wake-up link key; only shown when unlocked.") }),
  PlanRow: obj({ name: str(), from: str(), to: str(), look: str("`white`, `night` or an effect id."), palette: str(), kelvin: nullable(int()), brightness: unit() }),
  Home: obj({ wake: ref("WakeSettings"), sleep: obj({ minutes: int() }), plan: obj({ enabled: bool(), fade: int(), rows: arr(ref("PlanRow")) }), status: ref("HomeStatus") }),
  HomeUpdate: obj({ wake: ref("WakeSettings"), sleep: obj({ minutes: int(undefined, { minimum: 5, maximum: 180 }) }),
    plan: obj({ enabled: bool(), fade: int(), reset: bool("Back to the default rows."), rows: arr(ref("PlanRow"), undefined, { maxItems: 12 }) }) },
    { example: { wake: { enabled: true, source: "times", days: ["", "07:00", "07:00", "07:00", "07:00", "07:00", ""], duration: 20, target: "all" } } }),

  // ------------------------------------------------------------ settings and state
  Settings: obj({
    brightness: unit(), fps: int(undefined, { minimum: 10, maximum: 120 }), syncOffsetMs: int(undefined, { minimum: -500, maximum: 500 }), syncOffsets: loose("Light timing per sound output: `{key: {ms, name, bt}}`."),
    performance: en(["auto", "full", "lite"]), ambient: str("An effect id or `off`."), idleBrightness: unit(), idleAfterSec: num(undefined, { minimum: 1, maximum: 600 }),
    safe: bool("Photosensitive-safe mode."), predict: bool(), dropFlash: bool(), audioSync: bool(), autoDiscover: bool(), setupDone: bool(), songMemory: bool(), moodColours: bool(), requests: bool(), shows: bool(),
    hearing: obj({ method: en(["", "computer", "mic", "pi"]) }),
    capture: obj({ enabled: bool(), source: str("`auto` or a source id."), command: str() }), metronome: obj({ enabled: bool(), bpm: num(undefined, { minimum: 40, maximum: 220 }) }),
    osc: obj({ enabled: bool(), port: int() }), guest: obj({ effects: bool(), scenes: bool(), pads: bool(), brightness: bool() }, { description: "What guests may do while a PIN lock is set." }),
    location: nullable(obj({ lat: num(), lon: num(), name: str() })),
    night: obj({ enabled: bool(), from: str(), to: str(), maxBrightness: num(), warm: bool() }),
    text: obj({ source: en(["song", "bpm", "clock", "custom"]), custom: str() }),
    mqtt: obj({ enabled: bool(), url: str(), username: str(), password: str("Always blank in answers."), hasPassword: bool(), prefix: str(), base: str() }),
    djlink: obj({ enabled: bool(), port: int() }), link: obj({ enabled: bool(), port: int() }),
    dmx: obj({ enabled: bool(), lasers: bool(), fog: bool(), fogWhen: en(["before", "drop"]), fogLead: num(), fogBurst: num(), fogCooldown: num(), fogMaxDuty: num(), fogLevel: num(), laserMaxSec: num() }),
    effectPrefs: { type: "object", additionalProperties: { type: "integer" }, description: "Effect id: 1 liked, -1 banned." },
    homekit: obj({ enabled: bool() }), nowPlaying: obj({ enabled: bool(), spotifyClientId: str() }),
  }, { description: "The settings. Every key, its type and default: docs/internals/data-model.md.",
    example: { brightness: 0.8, fps: 60, performance: "auto", ambient: "northern", safe: false, guest: { effects: true, scenes: true, pads: true, brightness: true }, location: null, requests: true } }),
  SettingsPatch: obj({
    brightness: unit(), fps: int(undefined, { minimum: 10, maximum: 120 }), syncOffsetMs: int("Light timing for the sound output playing now (or `output`), -500 to 500 ms."), output: str("A sound output's key, for `syncOffsetMs`."),
    syncOffsets: { type: "object", additionalProperties: { type: ["number", "null"] }, description: "`{key: ms}`, or `{key: null}` to forget one." },
    performance: en(["auto", "full", "lite"]), ambient: str(), idleBrightness: unit(), idleAfterSec: num(),
    safe: bool(), predict: bool(), dropFlash: bool(), audioSync: bool(), autoDiscover: bool(), setupDone: bool(), songMemory: bool(), moodColours: bool(), requests: bool(), shows: bool(),
    hearing: obj({ method: en(["", "computer", "mic", "pi"]) }), capture: obj({ enabled: bool(), source: str(), command: str() }), metronome: obj({ enabled: bool(), bpm: num() }),
    osc: obj({ enabled: bool(), port: int() }), guest: obj({ effects: bool(), scenes: bool(), pads: bool(), brightness: bool() }), location: nullable(obj({ lat: num(), lon: num(), name: str() })),
    night: obj({ enabled: bool(), from: str(), to: str(), maxBrightness: num(), warm: bool() }), text: obj({ source: en(["song", "bpm", "clock", "custom"]), custom: str() }),
    mqtt: obj({ enabled: bool(), url: str(), username: str(), password: str(), clearPassword: bool(), prefix: str(), base: str() }),
    djlink: obj({ enabled: bool(), port: int() }), link: obj({ enabled: bool(), port: int() }),
    dmx: obj({ enabled: bool(), lasers: bool(), fog: bool(), fogWhen: en(["before", "drop"]), fogLead: num(), fogBurst: num(), fogCooldown: num(), fogMaxDuty: num(), fogLevel: num(), laserMaxSec: num() }),
  }, { description: "Any part of the settings; other keys are ignored.", example: { fps: 50, night: { enabled: true, from: "23:00", to: "07:00" } } }),
  State: obj({
    version: str(), canQuit: bool(), settings: ref("Settings"), show: ref("Show"), devices: arr(ref("Device")), room: ref("Room"), scenes: arr(ref("Scene")), schedules: arr(ref("Schedule")),
    locked: bool(), effects: arr(ref("Effect")), styles: { type: "object", additionalProperties: { type: "string" }, description: "Style id: name." }, palettes: arr(str()),
    presets: arr(obj({ id: str(), name: str(), desc: str() }), "Ready-made room layouts."), captureSources: arr(ref("SoundSource")), firstRun: bool(),
  }, { description: "Everything the web app draws. Secrets are left out." }),
  Status: obj({
    type: str(undefined, { const: "status" }), source: en(["song", "nowplaying", "browser", "capture", "djlink", "midiclock", "link", "metronome", "idle"]), sourceLabel: str(),
    fps: int(), leds: int(), uptime: int("Seconds since start."), effect: str(), effectName: str(), style: str(), styleName: str(),
    bpm: nullable(num()), part: en(["calm", "build", "drop", "silent", "idle"]), beat: nullable(int("Beat in the bar, 0 to 3.")), level: unit("Loudness."), bands: nullable(arr(num(), "24 spectrum bands, with live audio.")),
    key: nullable(obj({ key: str(), mode: str(), name: str(), confidence: num() })), mood: nullable(obj({ valence: num(), energy: num(), name: str() })), hears: nullable(str()), vocal: nullable(num()),
    song: nullable(obj({ memId: nullable(str()), name: str(), playing: bool(), pos: num(), dur: num(), bpm: num(), style: str(), drops: { description: "The drops the analysis found." } })),
    recognised: nullable(obj({ id: str(), name: str(), pos: num(), dur: num() })),
    nowPlaying: nullable(loose("See Now playing.")), spotify: nullable(loose("See Spotify.")), capture: nullable(obj({ label: str(), running: bool(), error: nullable(str()) })),
    hearing: loose("`{via, sound, level, capture, output, problem, method}`."), offsetMs: num("The light timing in use."),
    djlink: nullable(obj({ name: str(), bpm: num(), beatInBar: int() })), midiClock: nullable(loose("MIDI clock being followed.")), link: nullable(loose("Ableton Link session.")),
    power: bool(), brightness: unit(), night: bool(), overlay: ref("Pads"), home: nullable(ref("HomeStatus")),
    mqtt: nullable(obj({ state: en(["connected", "connecting", "reconnecting", "error", "off"]), error: nullable(str()) })),
    phones: int(), screen: nullable(str()), mapping: nullable(obj({ device: str(), led: int() })),
    perf: obj({ mode: str(), setting: str(), why: nullable(str()), fps: num(), frameMs: num(), cpu: num() }), dmx: nullable(loose("`{lasers: {on, why}, fog: {...}}`.")),
    devices: arr(ref("DeviceStatus")),
  }, { description: "What is happening now; the same object as the WebSocket's `status` messages.",
    example: { type: "status", source: "browser", sourceLabel: "Browser audio", fps: 60, leds: 240, uptime: 3600, effect: "laser", effectName: "Laser", style: "party", styleName: "Party", bpm: 124, part: "drop", beat: 2, level: 0.71,
      power: true, brightness: 0.8, night: false, overlay: { strobe: false, blackout: false, freeze: false, hold: false, boost: 1, forced: null }, devices: [] } }),
  DeviceStatus: obj({
    id: str(), online: bool(), sent: int(), used: int(), amps: num(), limited: bool(), latencyMs: nullable(num("Sound to light.")),
    latency: obj({ audioMs: num(), analysisMs: num(), networkMs: num(), frameMs: num(), offsetMs: num() }), latencyLevel: en(["good", "ok", "slow", "none"]),
    warnings: arr(obj({ kind: en(["offline", "wifi", "frames", "notlive", "power", "slow"]), text: str() })),
  }, { description: "One device in the status; also has its DeviceHealth fields." }),
  Health: obj({ ok: bool(), version: str(), uptime: num(), fps: int(), leds: int() }, { required: ["ok"], example: { ok: true, version: "0.3.0", uptime: 3600, fps: 60, leds: 240 } }),
  LogEntry: obj({ t: num(), level: en(["info", "warn", "error"]), msg: str() }, { example: { t: 1762200000000, level: "info", msg: "Scene: Party mode" } }),

  // ------------------------------------------------------------ the rest: loosely, as the code builds them
  Hearing: obj({ platform: str(), method: str(), problem: nullable({ description: "What is wrong, if anything." }), recommended: en(["computer", "mic", "pi"]),
    computer: obj({ kind: str(), source: nullable(str()), why: nullable(str()), on: bool(), running: bool(), steps: arr(obj({ id: str(), label: str(), state: en(["ok", "no", "maybe", "todo"]) })) }),
    pi: obj({ available: bool(), source: nullable(str()), label: nullable(str()), on: bool() }), capture: loose("Server capture."), output: { description: "The sound output playing now." } },
    { description: "The Music page's hearing panel." }),
  NowPlaying: obj({ enabled: bool(), supported: bool(), platform: str(), state: en(["ok", "starting", "unavailable", "error", "off"]), message: nullable(str()),
    method: nullable(en(["osascript", "playerctl", "dbus-send", "powershell"])), track: nullable(loose("`{source, app, device, title, artist, album, dur, pos, playing, posKnown, remembered, following}`.")),
    spotify: obj({ clientId: str(), connected: bool(), error: nullable(str()), redirectUri: str() }) },
    { example: { enabled: true, supported: true, platform: "darwin", state: "ok", message: null, method: "osascript", track: null, spotify: { clientId: "", connected: false, error: null, redirectUri: "http://127.0.0.1:8080/api/nowplaying/spotify/callback" } } }),
  Spotify: obj({ settings: obj({ sync: bool(), learn: bool(), analysis: bool(), coverColours: bool(), pauseFade: bool(), muteDim: bool(), cloud: obj({ url: str(), use: bool(), share: bool() }) }),
    on: bool(), connected: bool(), mode: en(["exact", "shared", "analysis", "learning", "live", "paused", "idle", "off"]), modeName: str(), via: nullable(str()), error: nullable(str()),
    track: nullable(loose("The Spotify track.")), map: nullable(loose("The beat map in use.")), learn: nullable(loose("Learning progress.")), locked: bool(),
    analysis: en(["off", "blocked", "unknown"]), account: loose("The connected account."), local: loose("Now playing on this computer."), poll: loose("Polling timing."), cloud: loose("The shared beat-map service."), colors: nullable(arr(hex)) }),
  HomeKit: obj({ enabled: bool(), state: en(["off", "starting", "ready", "error"]), error: nullable(str()), mdnsError: nullable(str()), port: nullable(int()), name: str(), deviceId: str(),
    paired: bool(), setupCode: str(), setupUri: str("`X-HM://…`, for the QR code."), pairings: arr(obj({ id: str(), admin: bool() })), accessories: int() },
    { example: { enabled: true, state: "ready", error: null, mdnsError: null, port: 51826, name: "Tempolight 3F2A", deviceId: "3F:2A:10:C4:9B:E1", paired: false, setupCode: "123-45-678", setupUri: "X-HM://0023ISYWY3F2A", pairings: [], accessories: 7 } }),
  Integrations: obj({ obs: loose("OBS settings and `status`."), games: { type: "object", additionalProperties: ref("Game"), description: "By game id (`cs2`, `dota2`)." }, twitch: loose("Twitch settings, sign-in and `status`."),
    discord: loose("Discord settings (`hasWebhook`, the webhook masked) and `status`."), docs: obj({ tryIt: bool("The docs site may try API calls."), origins: arr(str()) }), streamdeck: obj({ available: bool(), download: str(), releases: str(), uuid: str() }), runtime: loose("Node.js version and WebSocket client.") }),
  Game: obj({ enabled: bool(), token: str(), intensity: unit(), mode: en(["blend", "takeover"]), name: str(), file: str(), folder: str(), status: loose("Live game status.") },
    { description: "One game's settings; also has its target and event switches." }),
  Update: obj({ method: en(["git", "docker", "npm", "binary", "manual", "demo"]), current: str(), behind: int(), ahead: int(), changes: arr({ description: "A commit." }), dirty: bool(), canUpdate: bool(), message: str() },
    { required: ["method", "canUpdate"], example: { method: "docker", canUpdate: false, message: "Running in Docker: update with  docker compose pull && docker compose up -d  (or rebuild the image)." } }),
  Wifi: obj({ available: bool(), mode: en(["watch", "hotspot", "connecting", "retry"]), ssid: nullable(str()), hotspot: { description: "The setup hotspot." }, lastResult: { description: "How the last connection went." } },
    { required: ["available"], example: { available: false } }),
  Backup: obj({ tempolight: str("The version that made it."), savedAt: iso, data: loose("Everything except the PIN: devices, room, scenes, schedules, settings, songs (saved passwords and tokens too).") },
    { required: ["data"], example: { tempolight: "0.3.0", savedAt: "2026-11-04T12:00:00.000Z", data: { devices: [], room: { name: "My room", shapes: [], zones: [] }, scenes: [] } } }),
};
