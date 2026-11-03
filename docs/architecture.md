# Architecture

```
 browser: song file ─ decode + preAnalyseCore ─► beat map (POST /api/song) + playback clock ─┐
 browser: system sound / mic ─ AudioWorklet (22 kHz, 16-bit) ─► WebSocket ──────────────────┤
 server: sound card (parec / arecord / ffmpeg) ─────────────────────────────────────────────┤
                                                                                             ▼
                                                LiveAnalyser / songView ─► director ─► effects
                                                                                      │
                     room layout (shapes → per-LED coordinates, LED ranges per controller)
                                                                                      ▼
                                 per-controller buffers ─► DDP (UDP 4048) ─► WLED controllers
                                                        └► preview frames ─► web UI (WebSocket)
```

## Engine (`packages/engine`, no I/O, runs in Node and the browser)

- **analysis.js**: whole-song analysis. A short-time Fourier transform (1024 samples, hop 256 at about 22 kHz) gives
  band energies and spectral flux. Peaks in the flux become kick, snare and hi-hat onsets. Tempo comes from a
  histogram of onset intervals; the best of the tempo, its double, half and 3:2 relatives is chosen by how well onsets
  line up with the grid, and the grid is phase-locked to the kicks. Bars are labelled calm, build-up, drop or silent;
  build-ups are the phrase (2, 4 or 8 bars) of rising tension before a drop. Style comes from how percussive the song
  is, its loudness range, its tempo and whether it has drops.
- **live.js**: the same ideas on a stream. Each hop (11.6 ms) gives band levels and onsets; a kick must be a low hit
  that beats the hi-hat band and the snare body and makes the low band jump, so bass notes and piano attacks don't
  count as drums; snares and hats need real high-frequency energy. Tempo is re-estimated twice a second, the song part
  is decided by a vote over the last fraction of a second, and the style every 2 seconds over the last 30.
- **director.js**: picks the effect from the style's pools for the current part (or a fixed effect), crossfades,
  keeps quiet music lit with the ambient effect, flashes on drops, applies live-pad overlays and the photosensitivity
  limiter (at most 3 big brightness jumps per second).
- **effects.js**: 74 effects. Each reads per-LED coordinates and a signals object and adds linear RGB light.
- **layout.js / presets.js**: shapes on a 16 × 9 wall view become per-LED coordinates (room position, position along
  the shape, angle and distance from its centre, position along the wiring); presets are fitted to your controllers.
- **signals.js**: builds the signals object (beat phase, kick/snare/hat envelopes, loudness, build-up progress).

## Outputs (`packages/outputs`)

- **ddp.js**: DDP packets exactly as WLED expects them (version 1, RGB24, 480 pixels per packet, push flag on the last).
- **wled.js**: WLED JSON API: info, state, segments (`stop` is exclusive).
- **discover.js**: mDNS query for `_wled._tcp.local` (with a unicast-reply fallback when port 5353 is taken) and a
  scan of the local /24 for `/json/info`.
- **audiosync.js**: WLED's 44-byte audio sync packet.

## Server (`packages/server`)

- **app.js**: HTTP routes, static files, WebSocket, PIN lock, OSC and scheduler wiring, first-run discovery.
- **runtime.js**: chooses the source (song > live audio > metronome > idle), runs the director at the frame rate,
  maps each shape's LEDs into its controller's buffer and streams them; device health checks every 10 seconds, and a
  controller that changes address is found again by name.
- **store.js**: one JSON settings file, written atomically. **ws.js**: a minimal RFC 6455 WebSocket server.
  **capture.js**: sound capture commands. **scheduler.js**: day/time schedules. **osc.js**: OSC over UDP.
