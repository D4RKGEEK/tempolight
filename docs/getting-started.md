# Getting started

## What you need

- **LED controllers running WLED.** Any ESP8266 or ESP32 board with [WLED](https://kno.wled.ge) installed (the web
  installer takes two minutes). ESP32 is recommended for more than about 300 LEDs or high frame rates.
- **A computer on the same network** to run Tempolight: Windows 10/11, macOS, Linux, or a Raspberry Pi 3, 4 or 5.
  A Pi Zero 2 works for small setups at a lower frame rate.
- **Node.js 20 or newer.** The installers set it up for you.

## Wiring and WLED settings

1. In WLED, set the LED count and type under *Config → LED Preferences*.
2. Under *Config → Sync Interfaces*, keep *Receive UDP realtime* on (the default). Tempolight streams with DDP on UDP
   port 4048.
3. Give each controller a fixed address in your router (a DHCP reservation). Tempolight finds a controller that moved
   by its name, but a fixed address is the most reliable.
4. Name your controllers in WLED (*Config → User Interface → Server description*). Tempolight uses that name.

## First run

1. Start Tempolight (`tempolight --open`, the Start menu shortcut, or `npm start` from source).
2. It scans your network and adds every WLED controller it finds, each as a straight strip in the room.
3. Open **Music** and press **Play the demo track**. You should see the lights react within a second.

### Draw your room

The **Room** page turns your strips into a room, so effects move across it the way it really is.

- **Presets.** *One strip around four walls* takes one strip and splits it into left, back, right and front walls.
  LED counts are fitted to your controller; change them in the table.
- **LED ranges.** Each shape has a *First LED* and an LED count. Leave *First LED* on auto to continue after the
  previous shape on the same controller. Example: one 300-LED strip, LEDs 0–99 on the left wall, 100–199 on the
  back wall, 200–299 on the right wall.
- **Direction.** If a chase runs the wrong way, tick *Reverse* for that shape.
- **Identify.** Lights one shape in white with LED 0 blinking, so you can check which is which.
- **Send segments to WLED** writes your ranges into WLED as segments, handy for WLED's own effects too.

## Music sources

| Source | Best for | How |
| --- | --- | --- |
| Songs in Tempolight | Parties, best timing | Music → Add songs. Each song is analysed before it plays; drops are marked on the progress bar |
| This computer's sound | Spotify, YouTube, DJ apps | Music → Listen to this computer's sound, then share a screen or tab with audio |
| Microphone | Live music, a speaker in the room | Music → Listen with a microphone |
| Server sound card | A Raspberry Pi with no screen | Music → Listen on the server, or `tempolight --audio auto` |
| Metronome | Testing, or ambient beat | Music → Metronome |

Browsers only allow audio capture on `localhost` or HTTPS. To listen from another device, run the browser on the
computer that plays the music, or use server capture.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| No controllers found | Same network and subnet? Try **Scan network** on Devices, or add by IP. Guest Wi-Fi and Docker without host networking block discovery |
| Controller shows offline | Check its address in your router; WLED's web page should open at `http://<address>` |
| Lights flicker or stutter | Weak Wi-Fi. Lower the frame rate in Settings (30–40 fps), move the controller closer to the router, or use an Ethernet ESP32 |
| Lights are behind the beat | Music → Light timing, move right. Bluetooth speakers need about +200 ms |
| Only part of a strip lights up | The LED count in Devices or the shape counts in Room are lower than the strip |
| Colours are wrong (red is green) | Set the colour order (GRB/RGB) in WLED's LED Preferences |
| Port 8080 is in use | Start with `--port 8081` |
| Windows asks about the firewall | Allow private networks, so phones and controllers can reach it |
