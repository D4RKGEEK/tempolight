# Tempolight

Music-reactive lighting for [WLED](https://github.com/wled/WLED) that understands the song, not just the volume.
Tempolight finds the beat, the bars, the build-ups and the drops, picks effects to match, and treats every LED in
your room as one canvas, whatever shapes and wiring you have.

Runs on a PC, a Mac or a Raspberry Pi. Needs only Node.js: no packages to install, nothing to compile.

## Install

**Linux, Raspberry Pi, macOS**

```bash
curl -fsSL https://raw.githubusercontent.com/D4RKGEEK/tempolight/main/install/install.sh | sh
tempolight --open
```

On a Raspberry Pi that should run Tempolight all the time, add `--service`, so it starts at boot:

```bash
curl -fsSL https://raw.githubusercontent.com/D4RKGEEK/tempolight/main/install/install.sh | sh -s -- --service
```

**Windows** (PowerShell)

```powershell
irm https://raw.githubusercontent.com/D4RKGEEK/tempolight/main/install/install.ps1 | iex
```

This adds Tempolight to the Start menu and desktop. When Windows asks, allow it on your network.

**Docker**

```bash
docker compose up -d        # uses host networking so it can find and reach WLED
```

**From source** (Node.js 20 or newer)

```bash
git clone https://github.com/D4RKGEEK/tempolight.git
cd tempolight
npm start                   # opens http://localhost:8080
```

## First start

1. Tempolight looks for WLED controllers on your Wi-Fi and adds the ones it finds, each as a strip in the room.
   Or add one by IP address, or press **Try it without lights** to get a virtual room.
2. Open **Music** and play a song, or listen to whatever your computer is playing.
3. That's it. The lights follow the music. Everything else is optional.

Open the address it prints on your phone to control it from the sofa.

## What's in the app

| Page | What you do there |
| --- | --- |
| **Home** | Live preview of the room, what's playing (tempo, song part, style), quick effect and colour choice, scenes, device status, activity log |
| **Music** | Play songs (analysed first, so the lights know where the drops are), listen to this computer's sound or a microphone, tap the beat, fix sound-to-light delay, metronome, listen on the server with no browser open |
| **Effects** | 74 effects that work on any layout, with search and filters; automatic or fixed; music style, colours, how often to change |
| **Live pads** | Play the lights like an instrument: flash, strobe, blackout, freeze, build & drop, drop now, next effect, boost, tap tempo, colour hold. Keyboard shortcuts |
| **Scenes & schedules** | Save the current look as a scene; run scenes, lights on/off or brightness at set times on chosen days |
| **Room** | Room layouts (four walls, TV, gaming desk, bedroom, living room, matrix, club, rings); drag shapes into place; set which LEDs each shape uses (for example LEDs 0–99 left wall, 100–199 back wall); identify shapes; write the segments into WLED |
| **Devices** | Scan the network (mDNS and a network scan), add by IP, status, Wi-Fi signal, firmware, frames sent, identify, send segments |
| **Settings** | What to show when nothing plays, idle brightness, frame rate, photosensitive-safe mode, WLED audio sync, OSC, PIN lock with guest permissions |

### How it follows the music

- **Songs you play in Tempolight** are analysed once before playing (about 2 seconds per song on a desktop): tempo,
  beat grid, bars, build-ups, drops and style (party, pop/rock, hip-hop, chill, ballad). The lights can then start a
  build-up effect on the right bar and hit the drop exactly.
- **Live listening** (your computer's sound, a microphone, or a sound card on the server) finds kicks, snares and
  hi-hats, the tempo and the song part as it goes, and predicts the next beat so lights land on time.
- **Quiet music never turns the room dark**: slow songs get calm effects, and a soft ambient layer fills quiet parts.
  When nothing plays, the ambient effect of your choice runs at a lower brightness.

### Listening on a Raspberry Pi or headless PC

Plug a USB sound card's input into your music source, then:

```bash
tempolight --list-audio          # what this computer can capture from
tempolight --audio auto          # start listening (also on the Music page)
tempolight --audio song.mp3      # play a file through it, to test a setup (needs ffmpeg)
```

### Control from other apps

- **HTTP API**: everything the app does, for Home Assistant, Stream Deck or scripts. See [docs/api.md](docs/api.md).
- **OSC** (turn it on in Settings): `/tempolight/effect laser`, `/tempolight/scene Party`, `/tempolight/flash`,
  `/tempolight/blackout 1`, `/tempolight/brightness 0.5`, `/tempolight/power 0`.
- **WLED audio sync**: Tempolight can send WLED's sound-sync packets, so WLED's own sound-reactive effects work too.

## How it is built

```
packages/
  engine/    song analysis, live listening, director (picks effects), room layout and presets, 74 effects. No I/O
  outputs/   DDP to WLED, WLED JSON API, network discovery (mDNS + scan), WLED audio sync
  server/    HTTP API, WebSocket, render loop, scenes, schedules, OSC, sound capture, PIN lock, settings file
apps/
  web/         the web app (plain JavaScript modules, no build step)
  playground/  the original single-page playground
scripts/       fake WLED device, demo streamer, browser end-to-end test, docs generator
install/       install scripts for Linux/Pi/macOS and Windows
docs/          architecture, API, protocols, effects list
```

Light goes to WLED with DDP (UDP port 4048), 480 LEDs per packet, at 60 frames a second by default. Rendering 700
LEDs with live listening uses about 7% of one desktop CPU core and 85 MB of memory. Details in
[docs/architecture.md](docs/architecture.md).

## Development

```bash
npm test                         # 27 tests: engine, analysis, live listening, outputs, server, lock, schedules, OSC, capture
npm run fake-wled                # a pretend WLED controller on 127.0.0.1:18080 for working without hardware
npm run test:browser             # clicks through every page in a real browser (needs Playwright)
npm run docs                     # regenerate docs/effects.md
```

New effects are the easiest way in: see [CONTRIBUTING.md](CONTRIBUTING.md).

## Roadmap

See [docs/roadmap.md](docs/roadmap.md). Next up: Home Assistant (MQTT discovery), phone-camera LED mapping, a show
editor, E1.31/Art-Net output and Hue.

## Licence

MIT. Tempolight talks to WLED over its public network protocols and contains no LedFx code.
