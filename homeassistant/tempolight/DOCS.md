# Tempolight add-on

Runs Tempolight, music-reactive lighting for WLED, on your Home Assistant machine. It finds your WLED controllers,
and with the Mosquitto broker add-on installed it appears in Home Assistant by itself (a light with effects, scenes
and actions, through MQTT discovery).

## Install

1. **Settings → Add-ons → Add-on store**, then **⋮ → Repositories**.
2. Add `https://github.com/D4RKGEEK/tempolight` and close the dialog.
3. Find **Tempolight** in the store (reload the page if it isn't there yet), **Install**. Home Assistant builds it on
   your machine, which takes a few minutes the first time.
4. **Start**, then **Open web UI** (or open `http://<your Home Assistant address>:8080`).

For Home Assistant to see Tempolight, install the official **Mosquitto broker** add-on first (and the MQTT
integration it offers). Tempolight asks the Supervisor for the broker's address and login at every start and connects
by itself; there's nothing to type.

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `port` | `8080` | Port of the web interface. With host networking this is the port on your Home Assistant machine. If you change it, the *Open web UI* button still points at 8080: open `http://<address>:<port>` instead |
| `mqtt_auto` | `true` | Use the Mosquitto broker add-on automatically |
| `mqtt_url` | empty | Another broker instead, e.g. `mqtt://192.168.1.10:1883` (plain MQTT; TLS isn't supported) |
| `mqtt_username`, `mqtt_password` | empty | Login for `mqtt_url` |
| `discover` | `true` | Look for WLED controllers the first time Tempolight starts |

The MQTT settings from these options (or from Mosquitto) are applied at every start and win over what is set in
Tempolight's own Settings page. To turn the connection off, set `mqtt_auto` to false and leave `mqtt_url` empty, then
switch it off in Tempolight's Settings.

## Why host networking, and no sidebar panel (ingress)

- **Host networking** (`host_network: true`): Tempolight finds WLED with mDNS, streams to it over UDP (DDP, E1.31,
  Art-Net) and listens to Pro DJ Link and Ableton Link broadcasts. Docker's port mapping blocks all of that.
- **No ingress**: Home Assistant serves ingress add-ons under a path like `/api/hassio_ingress/<token>/`. Tempolight's
  web app loads its files and talks to its API and WebSocket with absolute paths (`/app.js`, `/api/…`, `/ws`), which
  would point outside that prefix and fail. So the add-on opens in its own tab on port 8080 (`webui`). It also works
  from phones on your network the same way, and as an installable app (PWA).
  Browsers only allow microphone and screen audio capture on `localhost` or HTTPS; use **Listen on the server** (a
  sound card on the Home Assistant machine) or a browser on the computer that plays the music.

## Data, updates, audio

- Settings are kept in the add-on's `/data` folder (`/data/tempolight/tempolight.json`) and are part of Home
  Assistant backups. Tempolight's own **Settings → Backup** works too.
- The add-on's version is the Tempolight release it builds. Updates come through the add-on store; Tempolight's
  *Check for updates* button only explains that.
- `audio: true` gives the add-on Home Assistant's audio (PulseAudio). With a USB sound card on the Home Assistant
  machine, pick it as the input in the add-on's **Configuration** tab (*Audio*), then **Music → Listen on the server**
  in Tempolight.
- `/media` is mounted read-only, for music files: add it in **Music → Your own music** (type `/media`) and every song
  in it is analysed ahead.

## Trying it without Home Assistant

```bash
docker build --build-arg TEMPOLIGHT_REF=main -t tempolight-addon homeassistant/tempolight
echo '{"port":8080,"mqtt_auto":false,"mqtt_url":"mqtt://192.168.1.10:1883","discover":true}' > options.json
docker run --rm --network host -v "$PWD/options.json:/data/options.json" tempolight-addon
```
