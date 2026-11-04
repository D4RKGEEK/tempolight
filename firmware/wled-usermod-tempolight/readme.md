# Tempolight Lite

Tempolight-style music reactivity on the controller itself: kicks, tempo and beat grid, and the song part (calm,
build-up, drop) from AudioReactive's spectrum, with nine effects that use them (**TL Kick Shockwave**, **TL Beat
Chase**, **TL Build Fill**, **TL Drop Strobe**, **TL Aurora**, **TL Bass Rain**, **TL Bar Pulse**, **TL Tempo Wave**)
and **TL Auto**, which switches between them by song part. Part of [Tempolight](https://github.com/D4RKGEEK/tempolight);
full documentation in its `docs/tempolight-lite.md`.

## Installation

Needs the `audioreactive` usermod (the microphone and the FFT) and WLED 16 or newer. From the Tempolight repository:

```bash
firmware/scripts/add-to-wled.sh path/to/WLED   # copies this usermod and the analysis core to usermods/tempolight
```

then add `tempolight` to `custom_usermods` next to `audioreactive` (the script also writes an
`esp32dev_tempolight` environment that does this), and build.

## Usage

Enable AudioReactive (Config > Usermods), choose a TL effect on a segment. Info shows the tempo and song part with an
on/off button. Settings under Config > Usermods > tempolight: `enabled`, `sensitivity` (0-255), `fftScale` (must match
AudioReactive's FFT scaling, default square root), `latencyMs`, `strobe`, `maxFlashes` (at most 3 a second).

JSON: `info.tempolight` = `{lite: version, on, audio, fx: {name: effect id}}`; `state.tempolight` = `{on, bpm, locked,
section, beat, drops, build}`; send `{"tempolight":{"on":false}}` or `{"tempolight":{"auto":true}}` to `/json/state`.

## Change log

- 0.1.0: first version.
