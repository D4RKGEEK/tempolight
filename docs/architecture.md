# Architecture

```
 audio in ─┐                 ┌─> DDP (UDP 4048) ──────> WLED controllers
 song file ┼─> analysis ─┐   │
 controls ─┘             ├─> effects ─> per-controller buffers ─┼─> WLED audio sync (UDP 11988, multicast)
              room layout┘                                     └─> WLED JSON API (segments, presets)
                                   ▲
                          web UI ──┘  (HTTP + WebSocket API)
```

## Engine (`packages/engine`)

- **analysis.js**: whole-song analysis. A short-time Fourier transform (1024 samples, hop 256 at about 22 kHz) gives
  band energies and spectral flux. Peaks in the flux become kick, snare and hi-hat onsets. Tempo comes from a
  histogram of onset intervals, then the best candidate among the tempo, its double, half and 3:2 relatives is chosen
  by how well onsets line up with the grid. Bars are labelled calm, build-up, drop or silent from bass energy, bass
  dominance, loudness and snare density; build-ups are the phrase (2, 4 or 8 bars) of rising tension before a drop.
  The song's style is chosen from how percussive it is, its loudness range, its tempo and whether it has drops.
- **layout.js**: turns shapes into per-LED coordinates and works out each shape's LED range on its controller.
- **effects.js**: 62 effects. Each reads the layout arrays and a signals object and adds linear RGB light.
- **signals.js**: builds the signals object from an analysis (or a metronome) at a given time.

## Outputs (`packages/outputs`)

- **ddp.js**: DDP packets exactly as WLED expects them (version 1 flags, RGB24 type, 480 pixels per packet, push flag
  on the last packet of a frame).
- **wled.js**: WLED's JSON API for device info, segments (`stop` is exclusive) and state.
- **audiosync.js**: WLED's 44-byte audio-sync packet, so a controller can run its own audio effects.

## Server (`packages/server`)

Serves the web apps, a JSON API (`/api/status`, `/api/effects`, `POST /api/state`) and the render loop that maps
each shape's LEDs into its controller's buffer and streams them at a fixed frame rate.
