# Questions and answers

## Getting started

**Do I need to buy anything?** No. Tempolight is free and open source (MIT). You need lights it can drive (WLED strips
are cheapest and best for music; see [connect-lights.md](connect-lights.md)) and a computer or Raspberry Pi on the same
network. To try it with no lights at all, use **Try without lights** in the setup wizard, or the
[online demo](https://tempolight.pages.dev).

**Which computer?** Windows 10/11, macOS, Linux, or a Raspberry Pi 3, 4 or 5. A Pi Zero 2 works for small setups at a
lower frame rate (Tempolight switches to low-power mode by itself).

**Does it need the internet or an account?** No. Everything runs on your home network. The internet is only used
for things you turn on: Spotify on other devices, shared beat maps, Twitch, Discord, and checking for updates.

**Is the online demo the real app?** Yes: the same core, effects and director, running in your browser with three
pretend WLED controllers. It can't reach real lights, Spotify or a microphone on another device; install Tempolight for
that.

**Does the computer have to stay on?** Yes, while the lights should follow the music. A Raspberry Pi that does nothing
else is the usual answer ([raspberry-pi.md](../raspberry-pi.md)). Without any computer, an ESP32 with a microphone and
[Tempolight Lite](../tempolight-lite.md) (beta) is music-reactive on its own, with fewer features.

## Music

**Does it work with Spotify?** Yes, with the whole beat map once a song has been learned: [spotify.md](../spotify.md).
Spotify stopped giving new apps its audio analysis, so Tempolight learns each song the first time it hears it.

**With YouTube, Apple Music, a DJ app, the radio?** Yes: Tempolight listens (the computer's sound or a microphone) and
reacts live. Songs you've played in Tempolight before are recognised from any source and followed with their beat map.
[music-sources.md](music-sources.md).

**Do my songs get uploaded?** No. Song files play in your browser; only their beat map (tempo, beats, parts) goes to
the Tempolight server on your network. Live audio goes from the browser to that server, is analysed and thrown away.

**Why do the lights know a drop is coming?** For songs played in the app, or remembered and learned ones, the whole song
is analysed ahead: build-ups and drops are known before they play. While listening live to an unknown song, Tempolight
notices a drop as it happens.

**The lights are a bit behind the beat.** Your speakers play the sound late. Music → Timing → **Fix the timing
automatically** measures it once. [troubleshooting.md](troubleshooting.md#lights-lag-behind-the-music).

## Lights

**Which lights work?** WLED (and anything that speaks DDP, E1.31 or Art-Net), Govee (LAN, beta), OpenRGB, Nanoleaf,
Philips Hue, LIFX, WiZ, TP-Link Kasa, Yeelight, Twinkly, DMX fixtures through an Art-Net or sACN node, and phones.
All at once, as one show.

**Why does my Hue lamp look slow?** The Hue bridge takes about 10 commands a second for all its lights. Calm effects
look good; for beat effects, try fast (Entertainment) mode, which is in beta.
[connect-lights.md](connect-lights.md#philips-hue).

**Does Tapo work?** No. Tapo (and Kasa devices with the newer login firmware) need a TP-Link account login, which
Tempolight doesn't do. Older Kasa bulbs and KL strips work.

**Can I keep using WLED's own effects and presets?** Yes. When Tempolight stops sending, WLED goes back to its own
effect after a few seconds. Turn a device off in Devices (the **On** column) to leave it to WLED. **Send segments to
WLED** writes your room's ranges into WLED.

**How many LEDs?** As many as your controllers and network carry. Use an ESP32 rather than an ESP8266 above about 300 LEDs, and
split big setups over several controllers; Tempolight keeps them in sync. The status bar shows the LEDs and frames per
second, and the latency meter warns when a controller drops frames.

## Home and parties

**Can guests change things?** With a PIN (Settings → Lock) they can only do what you allow: pick effects, use scenes,
use the pads, change brightness. Guest song requests and phones as lights work while locked.

**Is it safe for people sensitive to flashing light?** Turn on Settings → Lighting → **Photosensitive-safe mode**: at
most 3 flashes a second over everything, no strobes from chat, lasers and DMX strobes off. Night mode does the same
during its hours.

**Does it work with Home Assistant, Apple Home, Google, Alexa?** Yes: [smart-home.md](smart-home.md).

**Can it wake me up?** Yes, with a sunrise that's at full light at your alarm, set by weekday or by your phone's
alarm: [wake-up.md](../wake-up.md).

## Running it

**Where are my settings?** In `~/.tempolight` (Windows: `%USERPROFILE%\.tempolight`; Pi image:
`/var/lib/tempolight`; Docker: the `tempolight` volume). Settings → **Backup** downloads everything in one file;
**Restore from a file…** brings it back on another computer (your PIN stays as it is there).

**How do I update?** Settings → About → **Check for updates**. Installs made with git or the installer scripts update
with **Update now**; the one-file app, Homebrew, winget, Scoop and Docker show the command to use. [install.md](../install.md).

**Can I run it on a server and use it from my phone?** Yes: open the *On your phone* address it prints (for example
`http://192.168.1.20:8080`) and add it to the home screen. A few browser features (microphone, camera, sharing sound)
only work on `localhost` or https.

**Can I use it in Docker?** Yes, best on Linux with host networking. Docker Desktop on a Mac or PC has limits:
[docker.md](docker.md).

**Is there an API?** Yes, HTTP and WebSocket, plus OSC and MQTT: [api.md](../api.md).

**Something's wrong.** [troubleshooting.md](troubleshooting.md), then
[open an issue](https://github.com/D4RKGEEK/tempolight/issues).
