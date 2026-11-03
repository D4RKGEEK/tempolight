# Roadmap

## Done in v0.2

- Online demo on Cloudflare Pages (tempolight.pages.dev), installable as an app on iPhone and Android
- Web app: Home, Music, Effects, Live pads, Scenes & schedules, Room, Devices, Settings
- Live listening from the browser (system sound, microphone) and on the server (PulseAudio, ALSA, ffmpeg)
- Songs analysed in the browser before playing, with transport controls and drop markers
- Director: style-aware automatic effects, crossfades, never-dark ambient floor, drop flash, photosensitive-safe mode
- 74 effects (12 new: Warp Tunnel, Spiral Galaxy, Thunderstorm, Colour Chord, Bass Quake, Rising Embers, Beat Tiles,
  Double Helix, Drop Countdown, Solar Flare, Zigzag Beams, Welding Sparks)
- Live pads with keyboard shortcuts, including Build & drop
- Scenes, day/time schedules, PIN lock with guest permissions
- WLED discovery (mDNS + network scan), identify, segment sync, health, address change recovery, virtual devices
- OSC input, WLED audio sync output, HTTP + WebSocket API
- Installers for Linux/Pi/macOS (with systemd service) and Windows, Docker image

## Next: v0.3 (suggested batch)

- **Like or ban effects**: automatic mode never shows banned effects and favours liked ones
- **Zones with effect settings**: own effect and brightness per zone; speed, size, direction, colours and intensity per effect, saved in scenes
- **One-tap timing fix**: speakers play clicks, the microphone measures the delay and sets the light timing
- **Power limit per controller**: estimated current draw, brightness capped to fit the power supply
- **Audio input picker**: choose the microphone or sound card in the browser, with a level meter
- **About 12 new effects**: Lighthouse, Corner bounce, Gravity, Wave collision, Portal, Stadium wave, Vocal glow, Chorus bloom, Drop rewind, Bass rain, Beat counter, Fireplace

## Features after that

| Area | Ideas |
| --- | --- |
| Timing and music | Song memory (recognise songs heard live and reuse their full beat map), layers (background effect plus beat accents), vocal detection |
| Home | Home Assistant via MQTT discovery, night mode, sunrise/sunset schedules, backup and restore, one-click updates, text on matrix panels (song, BPM, clock, countdown) |
| Parties | Phones as extra lights (scan a QR code), record a clip of the preview, auto-generated shows on a timeline, guest song requests |
| More lights | E1.31 and Art-Net, Govee (local network), Philips Hue Entertainment, Nanoleaf, OpenRGB, screen colour sync |
| DJs and pros | Ableton Link, Pioneer Pro DJ Link, MIDI controllers for the pads |
| Bigger projects | Phone-camera LED mapping, effect builder and gallery, multi-room |

## Effect ideas

| Group | Effects |
| --- | --- |
| Uses the room's real layout | Lighthouse, Corner bounce, Gravity, Wave collision, Portal (light pours out of the TV), Stadium wave |
| Follows the song | Vocal glow, Chorus bloom, Drop rewind, Bass rain, Beat counter |
| Calm and everyday | Fireplace, Rain on a window, Breathing guide, Focus timer, Sunrise alarm |
| Party | Colour cannons, Strobe scatter, Oscilloscope (on matrix panels) |

Not planned: cloud accounts, heavy AI audio separation, custom ESP32 firmware (stock WLED is the point).
