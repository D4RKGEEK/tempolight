# API

Everything the web app does goes through this API, so anything else can do it too. All bodies are JSON.
When a PIN lock is set, calls marked **admin** need the header `x-tempolight-token: <token>` from `POST /api/unlock`.
Calls marked with a guest area (effects, scenes, pads, brightness) work without it if that area is allowed in Settings.

Calls that change something are refused (403) when a browser sends them from another website (its `Origin` doesn't
match the address Tempolight is reached at), and so are WebSocket connections from other websites. Scripts, Home
Assistant and other apps send no `Origin` and aren't affected. Behind a reverse proxy that changes the `Host` header, list
the public address in `TEMPOLIGHT_ALLOWED_ORIGINS` (comma-separated, for example `lights.example.com`).

## State

| Call | Area | What it does |
| --- | --- | --- |
| `GET /api/state` | | Settings, show, devices, room, scenes, schedules, effects, styles, palettes, presets |
| `GET /api/status` | | What is happening now: source, effect, tempo, song part, level, spectrum, device health |
| `GET /api/health` | | `{ok, version, uptime, fps, leds}` for monitoring |
| `GET /api/layout` | | LED positions for drawing the room |
| `GET /api/log` | | The last 100 activity messages |

## Lights

| Call | Area | Body |
| --- | --- | --- |
| `POST /api/power` | brightness | `{on: true}` (no body toggles) |
| `POST /api/brightness` | brightness | `{value: 0.6}` (0 to 1) |
| `PATCH /api/show` | effects | any of `{mode: "auto"\|"manual", effect, style, palette, everyBeats, speed, layer: {effect, amount} \| null}`. Setting `effect` alone switches to manual |
| `PATCH /api/effects/:id` | effects | `{pref: 1}` like, `{pref: -1}` ban, `{pref: 0}` neither; `{params: {speed, intensity, hue, saturation, mirror}}` or `{params: null}` to reset |
| `GET /api/custom-effects` | | your own effects |
| `POST /api/custom-effects` | effects | `{name, pattern: "wave"\|"chase"\|"pulse"\|"sparkle"\|"fill"\|"breathe"\|"gradient", axis: "along"\|"x"\|"y"\|"around"\|"centre", drive: "beat"\|"kick"\|"bass"\|"loud"\|"time", tag: "calm"\|"build"\|"drop"\|"home", colors: "palette" \| ["#ff0066", "#00ccff"], speed, width, cycles, bg}`; returns it with an id (`u-…`) to use like any effect |
| `PUT /api/custom-effects/:id`, `DELETE /api/custom-effects/:id` | effects | |
| `PUT /api/zones` | effects | `{zones: [{id, name, mode: "follow"\|"effect"\|"ambient"\|"off", effect, brightness}]}`; shapes join a zone with their `zone` field |
| `POST /api/action` | pads | `{type: "flash", color: "#ff0000"}`, `{type: "strobe", on: true}`, `blackout`, `freeze`, `hold` (`color` or none to release), `boost` (`value` 0–2), `next`, `drop`, `build` (`seconds`), `tap`, `cancel`, `identify` (`device` or `shape`) |

## Scenes and schedules

| Call | Area | Body |
| --- | --- | --- |
| `GET /api/scenes` | | |
| `POST /api/scenes` | scenes | `{name}` saves the current look; or `{name, show, brightness}` |
| `PUT /api/scenes/:id` | scenes | `{name?, show?, brightness?}` |
| `POST /api/scenes/:id/apply` | scenes | |
| `DELETE /api/scenes/:id` | scenes | |
| `GET /api/schedules` | | each has `next`, the next time it runs |
| `POST /api/schedules` | admin | `{name, time: "19:00", days: [1,2,3,4,5], action: {type: "scene", scene: "<id>"}}`; action types `scene`, `on`, `off`, `brightness` (`value`) |
| `PUT /api/schedules/:id`, `DELETE /api/schedules/:id`, `POST /api/schedules/:id/run` | admin | |

## Devices and room

| Call | Area | Body |
| --- | --- | --- |
| `GET /api/devices` | | |
| `POST /api/devices` | admin | `{host: "192.168.1.42", name?, ddpPort?, force?}` (reads the LED count from WLED); `{virtual: true}` for a pretend room; `{host, kind: "govee", goveeMode?: "color"\|"segments"}` for a Govee light (beta); `{host: "127.0.0.1", kind: "openrgb", index}` for a device in OpenRGB (LED count is read from it); `{host, kind: "hue"}` for a Hue bridge (press its link button first); `{host, kind: "nanoleaf"}` for Nanoleaf panels (hold the power button first; the panels are placed as a `points` shape) |
| `PATCH /api/devices/:id` | admin | `{name?, host?, leds?, ddpPort?, enabled?, maxAmps?, mAperLed?, protocol?: "ddp"\|"e131"\|"artnet", universe?, goveeMode?, goveeSegments?}`; `maxAmps` caps brightness to the power supply |
| `DELETE /api/devices/:id` | admin | also removes its shapes |
| `POST /api/devices/:id/identify` | | lights that controller's shapes |
| `POST /api/devices/:id/segments` | admin | writes the room's LED ranges into WLED as segments |
| `POST /api/discover` | admin | `{scan: true}` returns WLED controllers found by mDNS and a network scan, Govee lights (`kind: "govee"`) and OpenRGB devices on this computer (`kind: "openrgb"`, `index`) |
| `GET /api/room`, `PUT /api/room` | admin | `{name, shapes: [...]}` |
| `POST /api/room/preset` | admin | `{id: "fourwalls"}`, built for your controllers |
| `POST /api/map` | admin | camera mapping: `{device, led}` lights only that LED (`-1`: all dark), `{end: true}` goes back to the show; also over the WebSocket as `{type: "map", device, led}`. Stops by itself after 5 s without news, or as soon as the WebSocket that started it closes |

A shape: `{type: "line"|"pole"|"free"|"circle"|"rect"|"hex"|"tri"|"matrix"|"points", name, dev: "<device id>", count, from: <first LED or null for "after the previous shape">, rev, ...}` plus
`pts: [[x, y], ...]` for lines (and for `points`: one LED exactly at each point, used by camera mapping and Nanoleaf), or `cx, cy, size` (and `w, h` for rectangles, `cols, rows, w, h` for matrices). Positions are on a 16 × 9 wall view, y = 0 at the top.

## Music

| Call | Body |
| --- | --- |
| `POST /api/song` | `{name, analysis}`: the result of `preAnalyseCore()` from `/engine/analysis.js` |
| `POST /api/song/clock` | `{pos: <seconds>, playing: true}` |
| `DELETE /api/song` | |
| `GET /api/songs` | song memory: `[{id, name, bpm, dur, style, drops, at}]` |
| `DELETE /api/songs/:id` | admin: forget a song |
| `GET /api/songs/:id/show` | the song's show: `{show: [{t0, t1, part, effect}], colors, cues, bright, edited}` (made automatically the first time), plus what the show editor draws: `P, off, barOff, bpm, bars, drops, env` (loudness, 10 values a second as base64 bytes) and `palettes` (`{id: ["#rrggbb", "#rrggbb"]}`) |
| `PUT /api/songs/:id/show` | effects area: `{show: [...], colors?, cues?, bright?}` your own timeline; fields left out are kept. `colors: [{t0, t1, palette} \| {t0, t1, colors: ["#rrggbb", "#rrggbb"]}]` (no overlaps), `cues: [{t, type: "flash"\|"strobe"\|"blackout"\|"build"\|"drop", color? (flash), beats? (the others: 0.25–128)}]`, `bright: [{t, v: 0..1}]` (a straight line between keyframes). Times are seconds on the song's clock, kept to the millisecond; at most 500 of each |
| `DELETE /api/songs/:id/show` | effects area: throw away edits (colours, cues and brightness too) and make a new show |
| `PUT /api/songs/:id/show/draft`, `DELETE …/draft` | effects area: play an unsaved version (same body as `PUT …/show`) on the lights for two minutes without saving it; the show editor's live preview |
| `GET /api/audio/sources` | sound inputs the server can capture from |
| `PATCH /api/settings` | admin: `{capture: {enabled: true, source: "auto"\|<id>, command?}}` |

## Now playing

On a PC or Mac (not in the online demo), Tempolight reads which track the music apps on that computer play, with no
account: Spotify and Music on macOS (`osascript`; macOS asks once to allow it under Privacy & Security → Automation),
any MPRIS player on Linux (`playerctl`, or `dbus-send`), and anything in the Windows media controls (PowerShell,
Windows 10 1809+). It is read about once a second. When the track is a remembered song (same title, and artist when
the file name has one, and a length within 3 s), the lights follow that song's beat map and show at the app's
position (`status.source` is `"nowplaying"`); otherwise it is only shown, and live audio still drives the lights.
A song played in the web app comes first.

| Call | Body |
| --- | --- |
| `GET /api/nowplaying` | `{enabled, supported, platform, state: "ok"\|"starting"\|"unavailable"\|"error"\|"off", message, method: "osascript"\|"playerctl"\|"dbus-send"\|"powershell", track, spotify: {clientId, connected, error, redirectUri}}` |
| `PATCH /api/nowplaying` | admin: `{enabled?: true, spotifyClientId?: "<32 hex digits>"}` |
| `POST /api/nowplaying/spotify/login` | admin: `{url}` to open: Spotify sign-in (PKCE, no client secret), which comes back to `redirectUri` (`http://127.0.0.1:<port>/api/nowplaying/spotify/callback`; add it to your Spotify app) |
| `POST /api/nowplaying/spotify/code` | admin: `{url}`, the address Spotify sent the browser to, when signing in from another device |
| `DELETE /api/nowplaying/spotify` | admin: disconnect |

With Spotify connected, Spotify playing on any of your devices is used when nothing plays on this computer. The
tokens are kept in `spotify-token.json` next to the settings and never sent to browsers (not in backups either).

`GET /api/status` has `nowPlaying: {source: "macos"|"mpris"|"windows"|"spotify", app, device, title, artist, album,
dur, pos, playing, posKnown, remembered: {id, name} | null, following}` or `null`.

## Guest song requests

Guests open `/request` on their phone (QR code on the Music page). These calls are open to everyone, even when locked.

| Call | Area | Body |
| --- | --- | --- |
| `GET /api/requests` | | `{enabled, requests: [{id, title, by, votes, at}]}`, most votes first |
| `POST /api/requests` | | `{title, by?}`; the same song again adds a vote instead (`merged: true`) |
| `POST /api/requests/:id/vote` | | |
| `PATCH /api/requests/:id` | admin | `{done: true}` when it has been played |
| `DELETE /api/requests/:id`, `DELETE /api/requests` | admin | remove one, or all |

Turn requests off with `PATCH /api/settings {requests: false}`.

## Backup

| Call | Body |
| --- | --- |
| `GET /api/backup` | admin: everything except the PIN, as one JSON file |
| `POST /api/restore` | admin: a backup file; the current PIN is kept |

Settings (`PATCH /api/settings`, admin) also take `songMemory: true|false`, `shows: true|false`, `requests: true|false`, `djlink: {enabled, port}`, `location: {lat, lon}`, `night: {enabled, from, to, maxBrightness, warm}`
(times like `23:00`, `sunset` or `sunrise-30`) and `text: {source: "song"|"bpm"|"clock"|"custom", custom}` for the
Text Scroller. Schedules accept `time: "sunset+30"` or `"sunrise-15"` once a location is set.

## Updates

| Call | Body |
| --- | --- |
| `GET /api/update` | admin: `{method: "git"\|"docker"\|"manual", behind, changes: [...], canUpdate, message}` (fetches from GitHub) |
| `POST /api/update` | admin: pulls the new version and restarts Tempolight (installs made with git or the installer) |

## Lock

| Call | Body |
| --- | --- |
| `POST /api/lock` | admin: `{pin: "1234"}` (4–8 digits); returns a token so you stay unlocked |
| `POST /api/unlock` | `{pin}` returns `{token}`, valid 12 hours |
| `DELETE /api/lock` | admin |

## WebSocket `/ws`

Add `?token=` when locked. The server sends `{type: "status", ...}` four times a second, `{type: "log"}` and
`{type: "changed", what}` when something changes. Send:

- `{type: "preview", on: true}` to get binary frames: byte 0 = 1, then R, G, B for every LED in layout order (30 fps)
- `{type: "audio-start", rate: 22050, label}` then binary messages of 16-bit little-endian mono samples to be a live audio source; `{type: "audio-stop"}`
- `{type: "clock", pos, playing}` while a song plays
- `{type: "action", action: {type: "flash"}}` for pads, with low delay
- `{type: "screen", w, h, px, label}` to feed the Screen Sync effect: `px` is base64 of `w × h` RGB bytes (up to 4,096 pixels), a few times a second;
  `{type: "screen", end: true}` when sharing stops. One browser shares at a time: another one's pictures (or a guest's while the PIN lock
  doesn't allow effects) get `{type: "screen-refused", why: "busy" | "locked", error}` back
- `{type: "phone", on: true}` to be a phone light: binary messages, byte 0 = 2, then R, G, B and the phone's place in
  the line-up (30 a second). `GET /api/network` lists this computer's addresses for the QR code; `status.phones` counts them

## Home Assistant

The easy way is MQTT discovery. In Settings → Home Assistant, turn it on and enter your broker (for example the
Mosquitto add-on: `mqtt://homeassistant.local:1883`, with a user name and password). Or with the API:
`PATCH /api/settings {mqtt: {enabled: true, url, username, password, prefix?: "homeassistant", base?: "tempolight"}}`.
The password is never sent back (`hasPassword` says one is saved).

Tempolight then appears in Home Assistant as one device with:

| Entity | Topics (with base `tempolight`) |
| --- | --- |
| Light: on/off, brightness, effect (or "Automatic") | `tempolight/light/set` (JSON schema), state on `tempolight/light/state` |
| Select: scene | `tempolight/scene/set` with a scene name |
| Scenes: one `scene` entity per Tempolight scene (no device, so it's named just like the scene, for voice assistants), plus "Tempolight off" | `homeassistant/scene/tempolight/scene_<id>/config`; activating sends the scene id to `tempolight/scene/set` ("Tempolight off": `{"state": "OFF"}` to `tempolight/light/set`). Deleted scenes are removed |
| Sensors: tempo, song part, music source | `tempolight/status` (JSON) |
| Buttons: Flash, Drop now, Next effect | `tempolight/action/set` with `flash`, `drop` or `next` |

Voice control through Home Assistant (Google Assistant, Alexa): see [voice.md](voice.md).

`tempolight/availability` is `online` or `offline` (also set by the broker if Tempolight stops suddenly).
`GET /api/status` has `mqtt: {state: "connected"|"connecting"|"reconnecting"|"error"|"off", error}`.

## Home Assistant without MQTT


```yaml
rest_command:
  tempolight_scene:
    url: "http://tempolight.local:8080/api/scenes/{{ scene }}/apply"
    method: POST
  tempolight_power:
    url: "http://tempolight.local:8080/api/power"
    method: POST
    payload: '{"on": {{ on }}}'
    content_type: "application/json"
```
