# Roadmap

## Done in v0.2

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

## Next

| Phase | Goal | Main work |
| --- | --- | --- |
| 3 | Everyday home use | Home Assistant via MQTT discovery, sunrise/sunset schedules, per-zone effects, Hue and OpenRGB output, E1.31/Art-Net output |
| 4 | Parties and mapping | Phone-camera LED mapping, show editor with auto-generated shows, now-playing from music services, screen colour sync |
| 5 | Ecosystem | Effect gallery and sharing, effect builder, plugin API, DJ software links (Ableton Link, Rekordbox), DMX |
