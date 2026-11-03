# Roadmap

Four phases, each closed by a test it must pass.

| Phase | Goal | Main work | Gate |
| --- | --- | --- | --- |
| 1 | Replace LedFx for one room | Live audio capture, file pre-analysis with cache, WLED discovery, Home/Devices/Rooms/Effects/Music pages, Windows/Mac/Linux/Pi builds | Looks better than LedFx on the same songs, side by side |
| 2 | Everyday use | Scenes and schedules, Home Assistant, MQTT, OSC, MIDI, open API, tap-to-sync delay, Hue and OpenRGB output | A month in real homes with no restarts |
| 3 | Parties and mapping | Phone camera mapping, live pad page, show editor with auto-generated shows, now-playing from music services, screen sync | A new user is set up in 5 minutes |
| 4 | Ecosystem | Effect gallery and sharing, effect builder, plugin API, DJ software links, vocal split, DMX | Community effects outnumber built-in ones |

## First 30 days

**Week 1: foundation** (done in v0.1): repo, engine package, test songs and analysis tests.

**Week 2: real lights**: DDP to one ESP32 at 60 fps, then three; WLED info and segments; network discovery.

**Week 3: real music**: system-sound capture on Windows and Linux; live analysis with the render loop; measure
sound-to-light delay; pre-analysis of local files with a cache.

**Week 4: usable app**: API and WebSocket; Home, Devices and Rooms pages; Raspberry Pi 4 test; Windows build;
a side-by-side video against LedFx.
