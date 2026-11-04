# Integrations for streamers and gamers

Tempolight's **Integrations** page connects the lights to OBS Studio, your games (Counter-Strike 2, Dota 2), Twitch
and Discord, and has the [Stream Deck plugin](streamdeck.md). These need Tempolight running on your computer or Pi
(not the online demo). A quick start for each is in [creators.md](guides/creators.md). The API is in [api.md](api.md#integrations-obs-games-twitch-discord-stream-deck).

**Security.** Only someone with the PIN (when Tempolight is locked) can see or change these settings. Passwords, the
Twitch sign-in and the Discord webhook stay in Tempolight's settings file and are never sent to a browser; the page
only shows that one is saved. The games' endpoint needs the game's own token, and is limited to 40 posts a second.
Chat commands have cooldowns and an allowlist. Photosensitive-safe mode (Settings) is respected everywhere: no strobe
from chat or events (a single flash instead), gentler game flashes and slow, smooth pulses.

## How it looks on the lights

Game colours, the OBS tally and colours from Twitch are drawn on top of the music show, after it and under the live
pads. Each one goes to a *target*: the whole room, a zone (make zones on the Effects page and assign shapes to them
on the Room page), or one controller. *Blend in* mixes the game's colour with the show (about half); *Take over*
replaces the show in that zone. *Strength* scales it all.

## OBS Studio

OBS 28 or later has obs-websocket 5 built in: **Tools → WebSocket Server Settings → Enable WebSocket server**, and
**Show Connect Info** for the port and password. In Tempolight enter `ws://127.0.0.1:4455` (or the OBS computer's
address) and the password. Tempolight signs in (SHA-256 challenge, the password is never sent) and listens for:

- **Scene changes**: a table maps OBS scenes to Tempolight scenes ("Gaming" → Party mode, "BRB" → Relax).
- **Stream start / stop, recording start**: a Tempolight scene for each, if you like.
- **Tally light**: a colour (red by default) in a zone while recording, streaming, or either.

Tempolight reconnects by itself when OBS restarts.

**Browser source.** Add a Browser source in OBS with `http://<tempolight>:8080/obs` (1920 × 1080). It shows the live
preview of your lights and what's playing on a transparent background. Options: `?preview=0` (no lights),
`?np=0` (no "now playing"), `?corner=tr` (tl, tr, bl, br), `?scale=1.5`, `?bg=1` (dark background). It only reads.

## Games: Valve Game State Integration

The game posts its state to `POST /api/gsi/cs2` or `/api/gsi/dota2` while you play. Turn the game on, then
**Download the config file**: it holds Tempolight's address (as your browser sees it; if the game runs on another
computer, open the page from that computer or edit the `uri`) and a token. Put it here and restart the game:

| Game | Folder |
| --- | --- |
| Counter-Strike 2 | `Steam/steamapps/common/Counter-Strike Global Offensive/game/csgo/cfg/` |
| Dota 2 | `Steam/steamapps/common/dota 2 beta/game/dota/cfg/gamestate_integration/` (make the folder), and add `-gamestateintegration` to Dota 2's launch options |

**New token** makes the old file stop working. The **Try** buttons show each effect without the game.

| Counter-Strike 2 | Lights |
| --- | --- |
| Health | Health colour: green at 100, through yellow and orange, to red; a heartbeat below 30; flickering orange while burning |
| Dead (watching a teammate) | Dark red |
| Flashbang | White, as blinded as you are, fading as you recover (safe mode: half, and it fades in) |
| Kill / headshot | A quick white / red-tinted flash |
| Bomb planted | Dark red with a pulse on every beep, faster and faster over 40 seconds (safe mode: a slow smooth pulse) |
| Bomb defused / exploded | Blue / orange flash |
| Round won / lost | The winning team's colour (CT blue, T orange) for a few seconds |

| Dota 2 | Lights |
| --- | --- |
| Health / dead | Health colour as above / dark red until you respawn |
| Mana | Blue in its own zone, brighter with more mana (off by default) |
| Day and night | Warm yellow by day, deep blue at night (and Night Stalker's night), in its own zone (off by default) |
| Kill | A quick gold flash |
| Roshan killed / Aegis | Pulsing purple / gold flash |
| Match won or lost | The winners' colour (Radiant green, Dire red) |

When the game stops posting (closed, back in the menu) the show comes back within 35 seconds, or at once from the menu.

## Twitch

### Chat commands

Tempolight reads your channel's chat anonymously (Twitch's IRC over WebSocket as `justinfan…`): no account, no token,
read-only, so it never writes in chat. Enter your channel name and pick the commands:

| Command | Does |
| --- | --- |
| `!scene party` | A scene (by name, or its first word; optionally only the scenes you tick) |
| `!effect laser` | An effect by id or name |
| `!flash red` | A flash, in a colour name (red, blue, purple, gold, …) or `#rrggbb` |
| `!color blue` | The colour for a few seconds, where *Colours show* says |
| `!strobe` | Strobe for 3 seconds (off by default; refused in safe mode) |
| `!drop` | The drop (off by default) |

*Who may use them*: everyone, subscribers (and VIPs and mods), VIPs and mods, or mods only (from the badges and tags
Twitch sends with each message). A *cooldown* per command for everyone, and one per viewer; the broadcaster is never
held back, mods skip the per-viewer one. Commands Tempolight doesn't know (other bots') are ignored.

### Follows, subs, raids and cheers

These come from Twitch EventSub, which needs a sign-in. Tempolight uses the **device-code flow** with your own
Twitch application, so there's no client secret and no redirect address to set up:

1. On [dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps), **Register Your Application**: any name,
   OAuth Redirect URL `http://localhost` (not used), Category *Other*, **Client Type: Public**.
2. Copy its **Client ID** into Tempolight and press **Connect Twitch**.
3. Tempolight shows a code: open twitch.tv/activate, sign in as the broadcaster, enter the code and allow it
   (read followers, read subscriptions, read bits).

Tempolight keeps the token in its settings file, renews it, and opens an EventSub WebSocket for: follow, new sub,
resub, gifted subs, raid and cheer (with a minimum of bits). For each, pick what the lights do: a flash, a colour for a
few seconds, a strobe, a scene, an effect, the drop, or nothing. **Try** runs it. **Sign out** forgets the token
(revoke it at twitch.tv → Settings → Connections too, if you like).

## Discord

Tempolight posts to a Discord channel through a webhook: **Server Settings → Integrations → Webhooks → New Webhook**,
pick the channel, **Copy Webhook URL**, paste it in Tempolight. It can post:

- **Now playing**: the song playing in Tempolight, or what music apps on this computer play (once it's been playing
  for a couple of seconds, so skipping through songs doesn't post each one).
- **Scene changes**.
- **Twitch follows, subs and raids** (when EventSub is connected).

Posts are spaced at least 3 seconds apart and never ping anyone (`@everyone` and mentions are disabled).

Commands *from* Discord (a bot that listens to `/scene party` in a channel) aren't built yet: they need a Discord bot
token and the Gateway (a WebSocket with heartbeats, intents and slash command registration). The plan: a bot of your
own (Discord Developer Portal), its token kept like the Twitch one, slash commands `/scene`, `/effect`, `/flash`
with the same allowlist, roles and cooldowns as Twitch chat.

## Testing without the real software

`npm test` runs these against pretend services: an obs-websocket 5 server (sign-in, requests, events), CS2 and Dota 2
payloads (`packages/server/test/fixtures/gsi`), a Twitch IRC server, an EventSub WebSocket and the Twitch and Discord
HTTP APIs, and a pretend Stream Deck for the plugin.
