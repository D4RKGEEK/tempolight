# Claude show designer

Tempolight already plans a show for every song it knows: it picks a look, follows the song parts and hits the drops.
The **Claude show designer** is an optional extra on top of that. With your own Anthropic API key, Claude looks at a
summary of each song the way a human lighting designer would, and decides the energy arc, which parts get the drop
effect, the colours of each part and a few big moments: a blackout, a strobe hit, a slow fade.

It is **off by default**, it needs your own key, and the lights work exactly as before without it.

## Turn it on

1. Get an API key at [platform.claude.com](https://platform.claude.com/settings/keys) (Settings → API keys). Requests
   are billed to your Anthropic account.
2. In Tempolight open **More → Settings → Claude show designer**.
3. Paste the key, pick a model (Claude Sonnet 5.5 is a good balance; Claude Haiku 5.5 costs the least) and press
   **Test the key**. "The key works" means you are set.
4. Turn on **Design songs with Claude**.

The next time a remembered song plays (one you played here, one from your music folder, Spotify or a music app that
Tempolight has learned) and has no design yet, Tempolight sends one request. A few seconds later the Stage's Look card
says **Designed by Claude:** and the idea of the show in one sentence.

## What you see

- **Stage → Look**: "Designed by Claude: …", with **Redesign** (ask again) and **Use the automatic look** (drop the
  design; the song isn't asked about again by itself).
- **Songs → a song**: under Look, the design per section: the part, the energy arc (hold back, build, full energy,
  breakdown), the effect and palette, and Claude's reason; the moments and their bars; the model and the tokens used.
  **Design with Claude** / **Redesign with Claude** shows the estimated cost.
- Turning the designer off keeps the designs but plays the automatic looks again. Editing a song's show by hand (the
  show editor) always wins over a design.

## What is sent, and what isn't

One request per song, to `api.anthropic.com` only, with your key:

| Sent | Not sent |
| --- | --- |
| The title, artist and album from your music app (when known), and genres | Audio, never: not a sample, not a fingerprint |
| The song's sections: their letter, part (calm, build-up, drop), bars, times and average energy, and how much singing | Lyrics (Tempolight doesn't have them, and Claude is told not to invent any) |
| The drops, tempo, key, mood and length | Your room, your lights, your network, your other songs |
| The effect list with their ratings, and the palettes' colours | Your API key anywhere but the request header |

Example of the song part (shortened):

```json
{"song": {"title": "Synthetic Anthem", "artist": "Test Band"}, "durationSec": 34.75, "bpm": 127.99, "bars": 18,
 "key": "A minor", "mood": {"valence": 0.52, "energy": 0.95, "name": "happy"},
 "sections": [{"i": 0, "label": "A", "part": "calm", "bar0": 0, "bar1": 2, "start": 0, "end": 3.75, "energy": 0.11, "vocal": 0}, "…"],
 "drops": [{"t": 15, "bar": 8}], "vocalSections": []}
```

## What it costs

A request is about 2,500 tokens in (most of it the effect list) plus about 40 per section, and 500 to 1,000 tokens
out. For a typical 4-minute song with 12 to 14 sections:

| Model | Per song, about | 30 songs a day at most |
| --- | --- | --- |
| Claude Haiku 5.5 | under 0.1 cent | under $0.05 |
| Claude Sonnet 5.5 | 1.5 to 2 cents | about $0.50 |
| Claude Opus 5.5 | 3 to 4 cents | about $1 |

A song is designed once and the design is kept, so you pay again only when you press **Redesign**. The **daily limit**
(30 requests by default, failures included; 0 stops it) caps the spend. Settings shows today's requests and the
estimate for the song playing.

## When something goes wrong

Every answer is checked against a strict format. An unknown effect or palette, a bar outside the song, a missing or
extra field, text that isn't JSON, a cut-off answer, no answer within 10 seconds, a refused key: the whole design is
thrown away and the song keeps its automatic look, quietly. The problem shows in Settings → Claude show designer
("Last problem") and in the log. A song that failed isn't retried by itself; press **Design with Claude** to try again.

## Privacy and safety

- The key is kept in Tempolight's settings file on this computer (like the MQTT password), never sent back to the
  browser (`/api/state` only says `hasKey`), left out of backups and never written to the log. **Forget the key**
  removes it.
- Titles and artist names are typed by other people. They are sent as JSON data inside the request, never as
  instructions, and Claude is told to ignore anything in them that looks like an instruction.
- Claude's answer can only fill in the design format: effects, palettes, arcs and moments from fixed lists, on bars
  that exist. It can't change settings, call anything or reach your lights in any other way. Its reasons are shown as
  plain text.
- Strobe hits become single flashes in photosensitive-safe mode and night mode.
- The online demo has no designer: a key in a browser tab is a key anyone with the tab has.

## Advanced

- API: `GET/PATCH /api/designer`, `POST /api/designer/test`, `GET/POST/DELETE /api/songs/:id/design`
  ([api.md](../api.md#claude-show-designer)).
- The request, the schema and how a design becomes show blocks, colour blocks, cues and the energy contour:
  `packages/engine/src/designer.js`; the request and the cache: `packages/server/src/designer.js`. A design is kept
  as `design` on the song ([data model](../internals/data-model.md#settings)), with a version: a design from an older
  format is still shown but no longer played.
- Model ids: [Models overview](https://platform.claude.com/docs/en/models/overview). Any model id can be set with
  `PATCH /api/designer {model}`.
