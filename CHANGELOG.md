# Changelog

All notable changes to Tempolight. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-11-04

### Added
- Realistic room preview: strips drawn as continuous diffused light with hot cores, bloom and light spilling onto the wall; redraws only when a new frame arrives.
- Web app with Home, Music, Effects, Live pads, Scenes & schedules, Room, Devices and Settings pages; light and dark themes; phone layout.
- Live listening: this computer's sound or a microphone from the browser, or a sound card on the server (PulseAudio, ALSA, ffmpeg).
- Songs analysed in the browser before they play, with transport controls and drop markers.
- Director: automatic effects by music style and song part, crossfades, an ambient floor so quiet music never goes dark, drop flash.
- 12 new effects (74 in total): Warp Tunnel, Spiral Galaxy, Thunderstorm, Colour Chord, Bass Quake, Rising Embers, Beat Tiles, Double Helix, Drop Countdown, Solar Flare, Zigzag Beams, Welding Sparks.
- Live pads with keyboard shortcuts: flash, strobe, blackout, freeze, build & drop, drop now, next, boost, tap tempo, colour hold.
- Room presets fitted to your controllers, a shape editor with LED ranges, WLED segment sync, identify.
- WLED discovery (mDNS and network scan), health checks, address-change recovery, virtual devices.
- Scenes, day/time schedules, PIN lock with guest permissions, photosensitive-safe mode.
- OSC input, WLED audio sync output, HTTP and WebSocket API.
- Installers for Linux, Raspberry Pi and macOS (with a systemd service) and Windows; Dockerfile and compose file.
- Tests for live analysis, the director, discovery, the server API, lock, schedules, OSC and capture; a browser end-to-end test.

## [0.1.0] - 2026-11-03

### Added
- Effects engine with 62 effects that work on any layout.
- Whole-song analysis: tempo, beat grid, build-ups, drops, style detection.
- Room layouts, WLED segments, DDP output, WLED audio-sync packets.
- Browser playground.

[0.2.0]: https://github.com/D4RKGEEK/tempolight/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/D4RKGEEK/tempolight/releases/tag/v0.1.0
