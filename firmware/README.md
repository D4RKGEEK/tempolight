# Tempolight Lite firmware

A WLED usermod that gives an ESP32 with a microphone Tempolight-style music reactivity on its own: kick detection,
tempo and beat grid, calm / build-up / drop, nine effects and an automatic mode. What it does for users, wiring and
flashing: [docs/tempolight-lite.md](../docs/tempolight-lite.md). This file is for building and changing it.

```
firmware/
  core/                      the analysis and the effects: plain C++17, no Arduino or WLED headers
    tempolight_lite.h/.cpp     LiteAnalyser (GEQ frames -> kicks, tempo, beat grid, song part), FlashWindow, effects
  wled-usermod-tempolight/   the WLED usermod (WLED 16 library usermod, name "tempolight")
    usermod_tempolight.h       reads AudioReactive, registers the TL effects, JSON state / info / config
    usermod_tempolight.cpp     REGISTER_USERMOD
    library.json, readme.md
  scripts/add-to-wled.sh     copies the usermod and the core into a WLED tree, adds [env:esp32dev_tempolight]
  test/
    run.sh                     host tests (npm run test:firmware)
    test_lite.cpp, synth.h     synthetic songs -> emulated AudioReactive GEQ -> analyser and effects
    wled_stub/                 the usermod compiled against a tiny WLED stand-in (with WLED_DIR set)
```

## How it works

AudioReactive (WLED's audio usermod) samples the microphone at 22,050 Hz, runs a 512-point FFT about 43 times a
second and publishes 16 GEQ channels (0-255) and a smoothed volume through `getUMData()` (`um_data->u_data[2]` and
`[0]`). Lite polls that in `loop()` and feeds each new frame to `LiteAnalyser::update()`, a compact port of
`packages/engine/src/live.js`:

- **Kicks:** the rise of channels 0-1 (43-129 Hz) against its recent mean and spread (as `detect()` in live.js), and
  only if, per bin, it beats the highs' rise and the snare body's (AudioReactive's pink-noise weighting and
  square-root scaling are undone first, so "per bin" means the same as in live.js), the low band really jumps, it
  reaches a good part of the channel range, and, when a noise burst comes with it, it's about as strong as this song's
  recent kicks (snare rolls leak into the low channels). Snares need their body (129-301 Hz) and noise (1.9-4.5 kHz).
- **Tempo:** every 0.5 s, a histogram of intervals between the last 10 s of kicks (or of all onsets without steady
  kicks), as in `estimateTempo()`, then refined with a least-squares line through the onsets, because 23 ms frames
  would otherwise bias it by a BPM. Phase from the circular mean of the onsets, eased in. The grid is moved back by
  the frame latency (20 ms by default) so beats land on the sound.
- **Song part:** the rules and the vote of `sections()`: bass dominance against the song's own 30th percentile, kicks
  in the last two beats, snare rate, rising energy with highs. The bar starts on the first kick of the drop.
- **Effects** draw palette index + brightness per LED into a `PixelSink`; in WLED that is the segment through its
  palette. Flashes go through one shared `FlashWindow`: at most 3 a second over all segments.

Memory: the analyser is about 3 KB (static, in the usermod); effects use `SEGENV.allocateData()`, at most 112 bytes
+ 2 bytes per LED (Bass Rain; TL Auto reserves the largest, plus 8). On a computer one analyser frame takes ~1-2 µs and one
300-LED effect frame ~10 µs, so the ESP32 has plenty of headroom next to AudioReactive (to be measured on hardware).

## Build

PlatformIO and Node.js 20 (for WLED's web UI build):

```bash
git clone --branch v16.0.1 https://github.com/wled/WLED.git
firmware/scripts/add-to-wled.sh WLED          # usermods/tempolight + platformio_override.ini
cd WLED && npm ci && pio run -e esp32dev_tempolight
# flash over USB:  pio run -e esp32dev_tempolight -t upload
```

The environment extends WLED's `esp32dev` with `custom_usermods = audioreactive tempolight`, AudioReactive enabled at
first boot and a generic I2S microphone on GPIO 32 (SD), 15 (WS), 14 (SCK). To add it to your own environment
instead, run the script once (for `usermods/tempolight`) and put `tempolight` in that environment's
`custom_usermods`, next to `audioreactive`. WLED 16 is required (library usermods, `void` effect functions);
WLED 0.15 isn't supported.

CI (`.github/workflows/firmware.yml`) runs the host tests, builds this environment against WLED v16.0.1, checks that
the usermod is in the image, and on tags attaches `tempolight-lite-esp32.bin` (factory image at offset 0, for the web
installer and esptool) and `tempolight-lite-esp32-update.bin` (app only, for WLED's OTA page) to the release and
publishes the installer ([docs/flash](../docs/flash/index.html), ESP Web Tools) to GitHub Pages.

## Test

```bash
npm run test:firmware                    # = firmware/test/run.sh, needs g++ or clang++
WLED_DIR=path/to/WLED npm run test:firmware   # also compiles the usermod against wled_stub and smoke-tests it
```

`test_lite.cpp` makes the EDM test song of `packages/engine/test/synth.js` (intro, snare-roll build-up, drop, outro;
at 128 BPM and five other tempos, with and without microphone noise), turns it into GEQ frames the way AudioReactive
does (512-sample FFT, the 22 kHz channel mapping, pink-noise factors, the rise/fall limiter, square-root scaling, the
squelch), and checks tempo, kicks, beats against the real beat times, bar position, song parts, the drop time, and
that every effect stays in its memory at 1, 7, 60 and 300 LEDs and never flashes more than 3 times a second. It's not
part of `npm test`, which must run without a C++ compiler.

What only hardware can confirm: a real microphone in a real room (levels, AGC and squelch, reflections), the
thresholds on real music, CPU time next to AudioReactive's FFT task, and the effects' look on LEDs.
