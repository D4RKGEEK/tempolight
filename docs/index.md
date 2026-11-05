---
layout: home
title: Tempolight documentation
titleTemplate: Music-reactive lighting that understands the song

hero:
  name: Tempolight
  text: Lights that know the song
  tagline: Beats, bars, build-ups and drops, found ahead of time and played across every light in your room. WLED and a dozen other kinds of lights, from a laptop, a Raspberry Pi or Home Assistant.
  image:
    src: /images/logo.svg
    alt: Tempolight logo
  actions:
    - theme: brand
      text: Get started
      link: /getting-started
    - theme: alt
      text: Try the online demo
      link: https://tempolight.pages.dev/demo/
    - theme: alt
      text: GitHub
      link: https://github.com/D4RKGEEK/tempolight

features:
  - icon: 🎵
    title: It knows what's coming
    details: Songs are analysed before they play, songs heard before are recognised in about 8 seconds, and for a new song it hears the build-up and counts down to the drop 3 to 5 seconds ahead. A live beat tracker lands on 91% of beats.
  - icon: 🏠
    title: One room, not one strip
    details: Draw your room once (or map it with a phone camera) and 95 effects sweep across walls, spin around rings and ripple out from the centre.
  - icon: 💡
    title: Many kinds of lights
    details: WLED, E1.31/Art-Net, DMX fixtures, Philips Hue, Nanoleaf, Govee, LIFX, WiZ, Kasa, Yeelight, Twinkly, OpenRGB, and the phones of your guests.
  - icon: 🪶
    title: Light to run
    details: Node.js and nothing else. A one-file app, Docker, a Raspberry Pi image or a Home Assistant add-on; a low-power mode for a Pi Zero.
---

## Start here

Pick the path that sounds like you. Every path starts with Tempolight running somewhere: [Install](install.md) lists
every way (a one-file app, Homebrew, winget, Docker, a Raspberry Pi image, the Home Assistant add-on, or from source).
Or paste one prompt into Claude and let it do the setup: [Set up Tempolight with Claude](setup-with-claude.md).
Every feature, with where to find it in the app: [What you can do](guides/what-you-can-do.md).

<div class="tl-paths">
<div class="tl-path">

### 🏠 I have WLED lights at home

1. [Getting started](getting-started.md): what you need, WLED settings, the setup wizard.
2. [Install](install.md) on your computer, or flash the [Raspberry Pi image](raspberry-pi.md) for lights that are
   always on.
3. Draw your room and pick favourite effects: [Effects](effects.md).
4. Wake up to a sunrise and fall asleep to a fade-out: [Wake-up and sleep](wake-up.md).

</div>
<div class="tl-path">

### 🟢 I listen on Spotify

1. [Sync with Spotify](spotify.md): exact sync, songs learned on their first play, optional shared beat maps.
2. No Spotify? Tempolight also follows what Apple Music and other players on the same computer are playing, or
   listens to the computer's sound ([Getting started → Music sources](getting-started.md#music-sources)).
3. Lights a little late? Use the one-tap timing fix
   ([Troubleshooting](getting-started.md#troubleshooting)).

</div>
<div class="tl-path">

### 🎧 I DJ or throw parties

1. [Effects](effects.md) and the Live pads: flash, strobe, blackout, build & drop, with keyboard shortcuts and MIDI.
2. Pioneer Pro DJ Link, Ableton Link and MIDI clock as beat sources, DMX fixtures over Art-Net/sACN:
   [Protocols](protocols.md).
3. Guests' phones become lights and guests request songs with a QR code; a PIN lock keeps them out of your setup.
4. Streaming? [OBS, Twitch, Discord and games](integrations.md), and the [Stream Deck plugin](streamdeck.md).

</div>
<div class="tl-path">

### 🏡 I run a smart home

1. The [Home Assistant add-on](../homeassistant/tempolight/DOCS.md), or any install with MQTT: Tempolight appears by
   itself ([API → Home Assistant](api.md#home-assistant)).
2. Apple Home: Tempolight is a HomeKit bridge, so Siri works ([API → Apple Home](api.md#apple-home-homekit)).
3. [Voice control](voice.md) with Google Assistant and Alexa through Home Assistant.
4. Scenes, schedules, sunrise and sunset times, night mode and an [ambient plan](wake-up.md#ambient-plan).

</div>
<div class="tl-path">

### 🛠️ I'm a developer

1. [Architecture](architecture.md): the engine, the outputs and the server, and how a frame is made.
2. [HTTP and WebSocket API](api.md) and [the protocols](protocols.md) on the wire.
3. [Tempolight Lite](tempolight-lite.md): the WLED usermod for an ESP32 with a microphone (beta).
4. [Contributing](../CONTRIBUTING.md): new effects are one object in `packages/engine/src/effects.js`.

</div>
</div>

## How it works

```mermaid
flowchart LR
  subgraph In["Music in"]
    F["Song file<br/>(analysed first)"]
    L["Live sound<br/>mic, system audio, sound card"]
    SP["Spotify / now playing<br/>+ song memory"]
    DJ["Pro DJ Link · Ableton Link<br/>MIDI clock"]
  end
  F --> A
  L --> A
  SP --> A
  DJ --> A
  A["Analysis<br/>beat grid, song part,<br/>style, key and mood"] --> D["Director<br/>picks effects, crossfades,<br/>pads, safe mode"]
  D --> E["95 effects<br/>on the room's real shape"]
  E --> O["Outputs<br/>DDP, E1.31, Art-Net, DMX,<br/>Hue, Nanoleaf, Govee…"]
  O --> W["Your lights"]
```

The whole story, step by step, is in [Architecture](architecture.md).

## See it

<div class="tl-shots">

![The home page: a live room preview, now playing with tempo and song part](images/home-dark.png)
![The music page: songs analysed before they play, with drop markers](images/music.png)
![The room page: shapes, LED ranges and controllers](images/room.png)
![Live pads: flash, strobe, blackout, build and drop](images/live-pads.png)

</div>

## Help and feedback

- Something not working? Start with [Getting started → Troubleshooting](getting-started.md#troubleshooting), then
  [open an issue](https://github.com/D4RKGEEK/tempolight/issues).
- What's done, what's beta and what's next: [Roadmap](roadmap.md) and the
  [changelog](../CHANGELOG.md).
- Tempolight is MIT licensed and made by volunteers. [Contributions are welcome](../CONTRIBUTING.md).
