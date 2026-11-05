# Changelog

All notable changes to Tempolight. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Sync score and song map
- Music page → **In sync**: a live meter (Locked / Finding the beat / Not hearing) with the tempo, a beat-1 light and one plain hint ("Too quiet — turn it up or move the mic closer", "No drums — following the melody", "Following the song's beat map", "Beat from DJ Link"…), and the playing song's map: its loudness, sections (repeats share a letter) coloured calm / build-up / drop, the drops, a moving playhead and the next drop; for a song heard live that isn't known, the map grows as it plays. The look and **Not this one** / **Keep** sit under it. Home's status line has a small sync dot. API: `sync` in `/api/status`, `GET /api/song/map`, `GET /api/songs/:id/map`.

### One look per song
- Automatic mode now picks one well-chosen effect and palette for each song when it is analysed, and keeps it for the whole song, on the beat (like picking one LedFx effect). It fits the song: a fast four-on-the-floor track gets a kick-driven effect, a ballad a calm one that doesn't need a beat; the colours come from the mood. The same song always gets the same look; different songs get different ones.
- The look stays lively from inside: speed follows the tempo, it gets stronger through build-ups, the colour steps at new sections (a chorus that comes back gets the same colour), drops vary every 2 bars, and the pump, the dip before the drop and the drop flash stay.
- Music page: "Look: Kick Shockwave · Sunset (fast four-on-the-floor, high energy)", with **Not this one** (the next best look; that one won't come back for the song) and **Keep**. Live listening picks a look after a few seconds and keeps it for the song.
- Effects page → **Variety**: One look per song (the default), Song parts (one effect each for calm parts, build-ups and drops), or Show (effects change with the song, as before, now only from the rated effects). API: `show.variety`, `POST /api/song/look/next`, `POST /api/song/look/keep`, `look` in the status.

### A new sync engine
- New live beat tracker: lights land on 91% of beats (was 64%) across house, hip-hop, dubstep, broken beats, swing, breaks and tempo changes; it holds the beat through breaks and finds it again in under a second; kicks are heard under sidechained bass; beat 1 of the bar is found live. It also says how sure it is, and reacts to hits instead of guessing when it isn't.
- Every light shows the beat at the same moment: each frame is drawn a little ahead and faster lights wait for the slowest (Hue, WiZ and WLED now flash together, within a few ms). Each light's delay is set by itself; the timing slider is a fine trim on top. A steadier frame loop.
- The feel: in drops the whole room pumps on every kick; drops are clearly brighter than calm parts; every style gets a dip on the last beat before a drop, a flash and a hard cut at the drop; effects change on downbeats and 4-bar lines and never last less than a bar; drops vary every 2 bars. New settings: Punch, Drama and drop variations (Settings → Lighting).
- Song analysis: no more half-tempo readings that turned EDM into hip-hop; the beat grid stays within ~2 ms over a whole song; the key is right for minor songs; songs are split into sections (repeats share a label) with chords and energy per bar; analysis is twice as fast.
- Song memory recognises songs sooner (median 8 s instead of 14), through EQ, and when played up to 6% faster or slower.
- Feel and beat checks in `npm test` (`npm run eval:beat`, `npm run eval:feel`), so a change that makes the sync worse fails the tests.

## [0.3.0] - 2026-11-04

### The sync feels right again
- Automatic shows are what the live director would play: the same effects, changing every 2 bars in drops and as soon as the song moves to a new part. Before, a song played once got a show that changed effect only every 8 bars, so replays (and the demo track) felt flat. Old automatic shows are planned again by themselves; shows edited by hand are kept.
- Steadier song parts: a moment is "silent" only after 0.6 s of quiet, and a bar lasts until the next one starts, so build-ups no longer flicker to a calm effect between hits or at bar lines.

### Fixed
- DMX: the manual fog pad works right after fog is turned on (it used to read the settings of the frame before).
- Firmware CI: the usermod smoke test finds the WLED checkout again; Windows checkouts keep LF line endings (`.gitattributes`), so the API route checks pass there.

### Hearing the music, and the docs
- "How should Tempolight hear your music?": a guided panel on the Music page (and a setup wizard step) with three ways: this computer's sound (macOS with BlackHole and a live checklist; Linux output monitor; Windows Stereo Mix), the microphone (remembered, starts by itself when an unlearned song plays), or automatic on a Raspberry Pi. After the Mac setup you just play Spotify: no tab, no mic.
- Bluetooth speakers are detected and the light timing is kept per speaker, switching by itself when the output changes.
- A plain status line on Home and Music: "Hearing Spotify ✓ · song · learning", or "Can't hear anything → Fix".
- Documentation: a new README, a docs website (VitePress, published to GitHub Pages) with guides for every light, music source, Spotify, Docker, smart home, parties, creators, troubleshooting and an FAQ; internals pages; a complete API reference checked against the code; diagrams throughout (checked with Mermaid CLI).

### Spotify and integrations
- Sync with Spotify: exact position from the Spotify app on this computer or the Web API (smoothed, follows pause, skip and seek); old Spotify apps that still have audio analysis use it; any other song is learned on its first play and followed exactly from then on. Reacts to pause, skips and volume; optional album-cover colours. Optional shared beat maps on your own Cloudflare Worker + D1 (served once two installs agree). Guide: docs/spotify.md.
- More lights: LIFX (bulbs and multizone strips), WiZ, TP-Link Kasa, Yeelight (music mode, 20 updates/s), Twinkly (realtime, real layout), and Philips Hue Entertainment (fast streaming over a built-in DTLS client), falling back to basic Hue.
- Apple Home: Tempolight is a HomeKit bridge (no Homebridge): a light, a "Music reactive" switch and a switch per scene, so Siri works. Pair from Settings → Apple Home.
- Integrations page: Stream Deck plugin (scenes, effects, pads, brightness dial), OBS (scene mapping, stream/recording looks, tally light, /obs browser source), CS2 and Dota 2 game events, Twitch chat commands and follow/sub/raid/cheer reactions, Discord webhook posts.
- macOS: a .dmg with Tempolight.app; opening the app again shows the running Tempolight; Settings → Quit in the one-file app.

### Easier to install, lighter to run
- One-file app: a single download for Windows, macOS (a .dmg with Tempolight.app, or a zip) and Linux (no Node.js or git needed), built and smoke-tested by a new release workflow that also publishes multi-arch Docker images to ghcr.io; Homebrew, Scoop and winget manifests and `npx tempolight`. Every way to install is in docs/install.md.
- Raspberry Pi image: flash it, and Tempolight is at http://tempolight.local. With no network it opens a "Tempolight-Setup" hotspot so you can pick the Wi-Fi from your phone (docs/raspberry-pi.md).
- Home Assistant add-on: add this repository in Home Assistant; it connects to the Mosquitto broker by itself.
- Low-power mode: picked automatically on a Pi Zero/3 or slow computers (30 fps, lighter analysis, fewer messages). Song recognition no longer runs inside a frame, so it can't cause stutters (worst frame 52 ms → 19 ms with 40 remembered songs).
- Smaller downloads: the server compresses the app (brotli/gzip, ETags) and heavy pages load only when opened: the home page went from 342 KB to about 60 KB.
- Tempolight Lite (beta): a WLED usermod for an ESP32 with a microphone, with beat, build-up and drop detection and 9 Tempolight effects without a computer (firmware/, docs/tempolight-lite.md, browser installer in docs/flash). Its algorithm is tested on the host; the ESP32 build runs in CI.

### New
- Setup wizard: five steps on first start (find the lights, pick a room, fix the timing, play a test song, done), big buttons and no reading needed; run it again from Settings.
- Live latency meter: the delay from sound to light per device, with warnings for weak Wi-Fi, a slow network, a WLED that drops frames or isn't showing the stream, and the power limiter.
- Key and mood colours: the song's key, major or minor, and mood set the colours with the Automatic palette (warm for happy, deep blues for sad, reds for intense, teal for calm). Shown on the Music page.
- Song memory recognises songs without drums, using the notes (chroma) as well as loudness.
- Now playing: Tempolight reads what Spotify, Apple Music and other players on the same computer are playing (macOS, Linux, Windows; Spotify Web API optional). Remembered songs then follow their beat map exactly, with no microphone.
- Voice control: every scene is a Home Assistant scene, so "Hey Google, activate Party mode" works through Home Assistant; guide in docs/voice.md.
- Home & sleep page: a sunrise wake-up (weekly times or linked to your phone's alarm, with snooze), a sleep timer that fades out, and an hourly ambient plan for when no music plays. Guide in docs/wake-up.md.
- Show editor: a timeline on the song's waveform with effect blocks, colour blocks, flash/strobe/blackout/build/drop cues and brightness keyframes, snapping to beats and bars, undo/redo and a live preview.
- DMX fixtures over Art-Net or sACN: pars, dimmers, strobes, moving heads (move on the beat), lasers (only in drops, off by default) and fog machines (a burst before the drop, with a cool-down), plus custom channel lists.
- Ableton Link (listen-only) and MIDI clock (through the browser) as beat-grid sources.
- The online demo build now copies every server module the app needs by following imports.

### Hardening (four parallel reviews)
- Security: browsers can no longer change settings, run updates or open the WebSocket from another website (Origin check); Nanoleaf tokens and Hue user names are kept out of every API answer, including PATCH responses.
- Song memory: recognition kept working after a restart (caches were being saved and broke on reload); no more locks one or two beats off in repetitive songs; the lock now follows songs played slightly fast or slow, lets go when the song ends, the room goes silent, the source stops or song memory is turned off, and follows skips; memory is capped at about 2 MB.
- Shows: blocks can't overlap or run past the song; banned effects are skipped; a clock jump (seek, recognition) no longer breaks crossfades or stops automatic mode changing effects.
- Vocal detection: plucked guitar melodies no longer count as singing.
- Screen sync: black bars of films are cut off; one browser shares at a time; locked guests are told why; sharing stops at once; frames are dropped instead of piling up on a slow connection.
- Camera mapping: measures how slow the camera is before scanning, copes with exposure drift, stops cleanly when the page or connection closes, lights whole segments on Govee, explains that phones need https; mapped shapes move as a whole when dragged.
- Lights: Govee razer packets capped at 60 segments and re-enabled after pauses; OpenRGB sends the device's exact LED count, can't hang on a silent server and closes connections it no longer needs; Nanoleaf skips the right non-light pieces; Hue shares one ~10 commands/s budget per bridge, queues power-off, handles white-only lights.
- Pro DJ Link: automatic mode changes effect again on a DJ Link grid; the beat follows smoothly through jitter and lost packets; the leading deck stays the lead (the mixer's on-air flags decide between two); a stopped deck lets go after two beats.
- Updates: clear messages for missing git, no upstream, detached HEAD or local commits; only one update at a time; the restarted copy waits for the old one to close its ports.
- Effect builder: bad or hand-edited values are cleaned; ids can't replace built-in effects; deleting an effect also clears it from scenes, zones, layers, ambient, likes and shows; saving keeps the pads (blackout, strobe) as they are.

- Make your own effects (Effects page): pick a pattern (waves, a moving dot, pulse, sparkles, level meter, breathing, gradient), a direction, what moves it (beat, kicks, bass, loudness or time), colours, speed and size. They play in automatic mode like the built-in ones, and share codes (`TL1:…`) let friends import them.

- Philips Hue (basic): pair the bridge with its link button; each colour light becomes one light in the room. Hue's bridge takes about 10 commands a second, so Tempolight sends the light that changed most first; best for calm effects. Hue Entertainment streaming isn't supported (it needs DTLS, which Node.js doesn't include).

- Camera LED mapping (Room → Map with the camera): Tempolight lights the LEDs one at a time, a phone or laptop camera finds each one, and the strip's real shape becomes a room shape. Mirrors and reflections are skipped; missed points are filled in.

- Auto-generated shows: every remembered song gets a timeline of effects, one block per section (build-ups get build effects, drops the big ones), shown under the song on the Music page. Tap a block to change its effect, or ask for a new show. Played or recognised songs follow their show in automatic mode.

- Nanoleaf panels: pair by holding the power button, and the panels are placed in the room where they really are (new `points` shape: one light at each point). Streams with Nanoleaf's extControl mode at 30 fps; the token never leaves the server.

- OpenRGB: PC lighting (RAM, fans, keyboards, motherboards, GPUs) joins the show through OpenRGB's SDK server. Scan network lists its devices with their LED counts.

- Guest song requests: guests scan a QR code (Music page), ask for songs and vote; the host sees the most wanted on top and marks them played. Works when settings are locked.

- Pioneer Pro DJ Link (Settings → Integrations): Tempolight listens to CDJ/XDJ beat packets and takes the tempo and bar position from the decks, with or without live audio. It only listens, so it can't disturb the DJ's setup.

- Song memory: songs played through Tempolight are remembered (a compact beat map, about 10 kB each). When one plays again from anywhere else while Tempolight listens live, it is recognised in about 15 seconds from its loudness shape, lined up with the kicks to a few milliseconds, and the lights follow the stored beat map, so drops are known ahead. Status shows `recognised`.

- Vocal detection while listening live: a clear tone whose pitch moves smoothly like a voice (vibrato, melody), so drums, steady pads and piano don't count. Drives Vocal Glow and shows as "Singing" on the Music page.

- Govee lights over the local network (beta): found by Scan network, driven as one colour (all LAN models) or per segment with DreamView streaming (some models).

- One-click updates: Settings → About → Check for updates shows what's new, and Update now pulls it and restarts. For installs made with the installer or git; Docker shows how to pull the new image. The installer's service now restarts with `Restart=always`.

- Screen sync: share a screen or window on the Music page and the new Screen Sync effect spreads its colours over the room, like a room-sized ambilight.

- Phones as lights: guests scan a QR code on the Live pads page, tap Start, and their screen becomes another light. Each phone shows its own part of the room, so a crowd moves with the show. Works in the online demo too (another tab).

- Home Assistant through MQTT discovery: Tempolight shows up as a light with effects, a scene picker, tempo and song-part sensors and Flash/Drop/Next buttons. Built-in MQTT client, no extra packages.

### Added
- Night mode: from a time (or sunset) until a time (or sunrise), brightness is capped, colours stay warm and there are no strobes or drop flashes.
- Sunrise and sunset schedules (for example "sunset-15"), worked out offline from your location; "Use my location" fills it in.
- Backup and restore of devices, room, zones, scenes, schedules and settings.
- E1.31 (sACN) and Art-Net output, chosen per device, next to DDP.
- MIDI controllers on the Live pads page (notes 36–45 by default, with Learn).
- Record a 15-second clip of the preview with the music, and share or save it.
- Text Scroller effect for LED matrix panels: the song, the tempo, the clock or your own text.
- Like or ban effects: automatic mode never picks banned effects and picks liked ones more often.
- Effect settings, kept per effect and saved in scenes: speed, intensity, colour shift, saturation, mirror.
- Accent layer: a second effect added on top of whatever is showing.
- Zones: parts of the room can follow the main effect, run their own effect or the ambient light, have their own brightness, or be off.
- Power limit per controller: the estimated current draw is shown and brightness is capped to the power supply.
- Audio input picker with a level meter, and a one-tap timing fix that measures the speaker delay with the microphone.
- 19 new effects (93 in total): Lighthouse, Corner Bounce, Gravity, Wave Collision, Portal, Stadium Wave, Vocal Glow, Chorus Bloom, Drop Rewind, Bass Rain, Beat Counter, Spectrum Rings, Neon Sign, Colour Cannons, Strobe Scatter, Oscilloscope, and three everyday ones that follow the clock: Box Breathing, Focus Timer, Wake-up Sunrise.
- Effects can know how long until the next drop and since the last one (`S.dropIn`, `S.sinceDrop`).
- Online demo: the real core runs in the browser with pretend WLED controllers; built by `scripts/build-site.js` and deployed to Cloudflare on every push (`wrangler.jsonc`).
- Installable app (PWA): home-screen icon on iPhone and Android, full screen, notch-safe layout, offline start.

### Changed
- The server is split into an environment-free core (`core.js`) and a Node layer (`app.js`, `node-io.js`).

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

[Unreleased]: https://github.com/D4RKGEEK/tempolight/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/D4RKGEEK/tempolight/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/D4RKGEEK/tempolight/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/D4RKGEEK/tempolight/releases/tag/v0.1.0
