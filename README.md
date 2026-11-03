# Tempolight

Music-reactive lighting for [WLED](https://github.com/wled/WLED) that understands the song, not just the volume.
Tempolight finds the beat, the bars, the build-ups and the drops, picks effects to match, and treats every LED in
your room as one canvas, whatever shapes and wiring you have.

> **Status: early development (v0.1).** The engine, 62 effects, song analysis, room layouts and WLED output work
> and are tested. Live audio capture and the real web UI are next. See [Roadmap](#roadmap).

## Why another one

[LedFx](https://github.com/LedFx/LedFx) showed what music-reactive WLED can do. Tempolight is a fresh take with
different goals:

| | Tempolight |
| --- | --- |
| Music | Beat grid, bars, build-ups, drops and song style (party, pop/rock, hip-hop, chill, ballad), from whole-song analysis |
| Timing | Knows upcoming beats, so lights can fire on time instead of after the sound |
| Room | Any shapes (strips, poles, rings, polygons, matrices, freehand) mapped into one room; effects travel across it |
| Quiet music | Never goes dark: slow songs get their own effects, and an ambient layer fills quiet parts |
| Weight | Zero runtime dependencies. Node.js only; runs on a PC or a Raspberry Pi |
| Licence | MIT |

## Try it

You need [Node.js](https://nodejs.org) 20 or newer. Nothing else to install.

```bash
git clone https://github.com/D4RKGEEK/tempolight.git
cd tempolight
npm test                                   # 10 tests: effects, analysis, DDP packets, WLED segments
npm start                                  # http://localhost:8080 opens the playground
```

The **playground** (`/`) runs the whole engine in your browser: load any song, lay out shapes, try every effect,
set WLED segments. The **dashboard mock-up** is at `/console`.

### Light up a real WLED device

Find your controller's IP address in the WLED app, then:

```bash
node scripts/demo.js --list                                    # every effect id
node scripts/demo.js --host 192.168.1.41 --leds 150 --effect laser --bpm 128
node scripts/demo.js --host 192.168.1.41 --shape matrix --cols 16 --rows 16 --effect kaleido2
```

This streams an effect over DDP (WLED's real-time protocol, UDP port 4048) on a steady beat. No audio yet; that is
the next milestone.

To drive several controllers as one room, copy `tempolight.config.example.json` to `tempolight.config.json`, put in
your controllers' names and addresses, and run `npm start`.

## How it is built

```
packages/
  engine/    song analysis, room layout, 62 effects, signals. No I/O: runs in Node and in the browser
  outputs/   DDP, WLED JSON API (segments, presets), WLED audio sync
  server/    HTTP server, JSON API, render loop
apps/
  playground/  the browser playground (index.html + demo track)
  mockups/     dashboard design mock-up
scripts/
  demo.js      stream an effect to one WLED controller
  test-songs/  Python scripts that synthesize test songs with known tempo, drops and style
docs/          architecture, protocols, effects list
```

Every effect only reads per-LED coordinates (position in the room, along its shape, around its centre, along the
wiring chain) and a small set of music signals (beat phase, kick, snare, hi-hat, loudness, build-up progress).
That is why the same effect works on a ring, a pole or a 4-wall strip. Details in [docs/architecture.md](docs/architecture.md).

### Performance

Every effect renders 1,000 LEDs in under 4 ms on a desktop (checked in CI). Whole-song analysis of a 4-minute track
takes about 2 seconds on a desktop.

## Roadmap

- [x] Effects engine with 62 effects that work on any layout
- [x] Whole-song analysis: tempo, beat grid, build-ups, drops, style detection
- [x] Room layouts, WLED segments, DDP output, WLED audio-sync packets
- [x] Browser playground
- [ ] Live audio capture (system sound on Windows, macOS, Linux)
- [ ] Song pre-analysis of local files with a cache
- [ ] Web UI: Home, Devices, Rooms, Effects, Music pages
- [ ] Device discovery (mDNS) and one-click WLED segment sync
- [ ] Raspberry Pi package and Docker image
- [ ] Home Assistant, MQTT, OSC, MIDI
- [ ] Phone camera mapping, live pads, show editor

The full plan, with competitor research and page designs, is in [docs/roadmap.md](docs/roadmap.md).

## Contributing

New effects are the easiest way in: see [CONTRIBUTING.md](CONTRIBUTING.md). Please run `npm test` before opening a pull request.

## Licence

MIT. Tempolight talks to WLED over its public network protocols and contains no LedFx code.
