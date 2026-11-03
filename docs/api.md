# API

Everything the web app does goes through this API, so anything else can do it too. All bodies are JSON.
When a PIN lock is set, calls marked **admin** need the header `x-tempolight-token: <token>` from `POST /api/unlock`.
Calls marked with a guest area (effects, scenes, pads, brightness) work without it if that area is allowed in Settings.

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
| `POST /api/devices` | admin | `{host: "192.168.1.42", name?, ddpPort?, force?}` (reads the LED count from WLED); `{virtual: true}` for a pretend room |
| `PATCH /api/devices/:id` | admin | `{name?, host?, leds?, ddpPort?, enabled?, maxAmps?, mAperLed?, protocol?: "ddp"\|"e131"\|"artnet", universe?}`; `maxAmps` caps brightness to the power supply |
| `DELETE /api/devices/:id` | admin | also removes its shapes |
| `POST /api/devices/:id/identify` | | lights that controller's shapes |
| `POST /api/devices/:id/segments` | admin | writes the room's LED ranges into WLED as segments |
| `POST /api/discover` | admin | `{scan: true}` returns controllers found by mDNS and a network scan |
| `GET /api/room`, `PUT /api/room` | admin | `{name, shapes: [...]}` |
| `POST /api/room/preset` | admin | `{id: "fourwalls"}`, built for your controllers |

A shape: `{type: "line"|"pole"|"free"|"circle"|"rect"|"hex"|"tri"|"matrix", name, dev: "<device id>", count, from: <first LED or null for "after the previous shape">, rev, ...}` plus
`pts: [[x, y], ...]` for lines, or `cx, cy, size` (and `w, h` for rectangles, `cols, rows, w, h` for matrices). Positions are on a 16 × 9 wall view, y = 0 at the top.

## Music

| Call | Body |
| --- | --- |
| `POST /api/song` | `{name, analysis}`: the result of `preAnalyseCore()` from `/engine/analysis.js` |
| `POST /api/song/clock` | `{pos: <seconds>, playing: true}` |
| `DELETE /api/song` | |
| `GET /api/audio/sources` | sound inputs the server can capture from |
| `PATCH /api/settings` | admin: `{capture: {enabled: true, source: "auto"\|<id>, command?}}` |

## Backup

| Call | Body |
| --- | --- |
| `GET /api/backup` | admin: everything except the PIN, as one JSON file |
| `POST /api/restore` | admin: a backup file; the current PIN is kept |

Settings (`PATCH /api/settings`, admin) also take `location: {lat, lon}`, `night: {enabled, from, to, maxBrightness, warm}`
(times like `23:00`, `sunset` or `sunrise-30`) and `text: {source: "song"|"bpm"|"clock"|"custom", custom}` for the
Text Scroller. Schedules accept `time: "sunset+30"` or `"sunrise-15"` once a location is set.

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

## Home Assistant example

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
