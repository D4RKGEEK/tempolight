# Stream Deck

Tempolight's Stream Deck plugin puts your lights on keys and dials, and the keys show what the lights are doing.

| Action | Key / dial | Shows |
| --- | --- | --- |
| **Scene** | Switches to a Tempolight scene | Lit while that scene is what the lights show (its settings and brightness match) |
| **Effect** | One effect by hand, or *Automatic* | Lit while it's on; *Automatic* shows the effect playing now |
| **Live pad** | Flash (in a colour), Strobe, Blackout, Freeze, Build, Drop, Next, Tap, Reset. *Press*: toggles. *Hold*: only while the key is down; hold **Build** to build up and let go for the drop | Lit while strobe / blackout / freeze / build / drop are on |
| **Lights on/off** | Power | On / Off |
| **Brightness** (Stream Deck +) | Turn: brightness (1, 2, 5 or 10% a click); press or touch: lights on/off | The brightness on the touch strip |

More for streamers (OBS, games, Twitch): [creators.md](guides/creators.md).

Needs Stream Deck 6.4 or later (Windows 10+, macOS 12+). The plugin has no packages: it runs on the Node.js that
Stream Deck comes with (Node 20) and talks to Tempolight over the network.

## Install

1. In Tempolight, open **Integrations → Stream Deck → Download the plugin** (or get
   `io.github.d4rkgeek.tempolight.streamDeckPlugin` from the releases page).
2. Open the file: Stream Deck installs it. The actions are in the **Tempolight** group.
3. Drag an action onto a key and open its settings: enter Tempolight's address (the computer running it, like
   `127.0.0.1:8080` on the same PC, or `192.168.1.20:8080`). If Tempolight is locked with a PIN, enter the PIN too.
   The address and PIN are shared by all Tempolight keys.

With a PIN, the plugin unlocks Tempolight by itself (`POST /api/unlock`) and keeps the token in memory only; when
Tempolight restarts it unlocks again. The PIN is kept in Stream Deck's own settings on that computer.

## How it works

- Keys call the HTTP API (`POST /api/scenes/<id>/apply`, `PATCH /api/show`, `POST /api/action`, `POST /api/power`,
  `POST /api/brightness`; see [api.md](api.md)).
- The plugin keeps Tempolight's live WebSocket (`/ws`) open, so titles and states follow changes made anywhere (the
  web app, schedules, OBS, chat), 4 times a second. When Tempolight can't be reached, keys say *Offline* and the plugin
  keeps trying.
- The dial sends at most about 15 changes a second; the strip follows the dial at once.

## For developers

The plugin is in `integrations/streamdeck/io.github.d4rkgeek.tempolight.sdPlugin`:
`manifest.json` (SDK version 2), `bin/plugin.js` (what Stream Deck runs), `bin/core.js` (all the logic),
`bin/ws-client.js` (a small WebSocket client; the same file as `packages/server/src/integrations/ws-client.js`, a test
checks it), `ui/inspector.html` (the key's settings) and `imgs/`.

- Pack it: `npm run streamdeck` writes `dist/io.github.d4rkgeek.tempolight.streamDeckPlugin` (a zip of the folder).
  Elgato's CLI works too: `npx @elgato/cli pack integrations/streamdeck/io.github.d4rkgeek.tempolight.sdPlugin`.
- Try it while editing: `npx @elgato/cli link integrations/streamdeck/io.github.d4rkgeek.tempolight.sdPlugin`, then
  `npx @elgato/cli restart io.github.d4rkgeek.tempolight`. Debug messages show in Stream Deck's plugin log.
- Tests: `packages/server/test/streamdeck.test.js` runs the plugin against a pretend Stream Deck (its WebSocket
  events) and a real Tempolight.
