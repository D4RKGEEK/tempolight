# Dashboard v2: a full redesign (not a reskin)

The problem with v1: 10 menu items (Home, Music, Effects, Live pads, Scenes & schedules, Home & sleep, Room, Devices,
Integrations, Settings) and the things people use every minute (what's playing, is it in sync, the look, the pads)
are spread over four of them. People don't know where to go. v2 is organised around one question per screen.

Visual language: design/tokens.md and design/taste-playbook.md still apply (dark first, one accent, ring + glow
depth, size and tight tracking for headings, verb + object buttons, no banned words). On top of that, v2 is a
**stage**, not a form: the room's lights are the hero of the main screen, big and alive; controls are few, large and
grouped; advanced options hide behind "More options" disclosures, never on the first view. Think music player plus
lighting console, like Spotify's Now Playing and a DJ app, not an admin panel.

## Navigation: 4 screens + More

| Screen | Route | The question it answers | Replaces |
| --- | --- | --- | --- |
| **Stage** | `#/stage` (default) | "What are my lights doing right now, and how do I change it?" | Home, Music (top), Live pads |
| **Songs** | `#/songs` | "Which music does it know and how does it hear music?" | Music (sources, library, remembered songs, Spotify) |
| **Looks** | `#/looks` | "What can the lights look like?" | Effects, Scenes |
| **Lights** | `#/lights` | "Which lights do I have, where are they, are they on time?" | Devices, Room, timing/latency |
| **More** | `#/more` | everything else | Home & sleep, Integrations, Settings, schedules, About |

Desktop: a slim left rail (icons + labels, 72-88px wide or 220px with labels; Tempolight logo top, "This computer"
bottom). Phone (≤ 760px): a bottom tab bar with the same 5 items, 64px tall, safe-area aware. Old routes
(`#/home`, `#/music`, `#/effects`, `#/live`, `#/scenes`, `#/room`, `#/devices`, `#/integrations`, `#/settings`,
`#/sleep`, and sub-routes like `#/music/sync`) keep working: they map to the new screen (or to the old page, now
reached from More). Nothing that exists today is lost; it is reorganised.

## Global top bar (every screen)

Left: screen title (28px/600). Right, always: **Hearing chip** (e.g. "● Hearing this computer", "● Spotify ·
Song name", "○ Not listening"; click opens the Songs screen's "How it hears" sheet), **Lights** power switch,
**brightness** slider, theme toggle. The status bar at the bottom of v1 goes away (its info lives on Stage).

## Stage (the main screen)

Layout desktop (1440): a big **room preview** (the live LED render, `createPreview`) fills the top ~60% of the
content area, edge to edge in a dark stage frame with the lights glowing. Overlaid on its bottom edge, a
**now-playing bar** like a music player: song name, source, sync state pill (Locked / Finding the beat / Not
hearing, with tempo and the 4 beat dots), and the **song map** strip full width with the playhead and "Next drop in
N s". Below the stage, three groups in one row:
1. **Look** card: the current look large ("Kick Shockwave · Sunset", why it was picked, palette swatches), buttons
   **Try another look** (= Not this one) and **Keep this look**; a segmented control **Variety: One look · Song
   parts · Show**.
2. **Feel** card: Punch and Drama sliders (big), Chord colours and Stereo as compact toggles.
3. **Pads** card: big touch pads Flash, Strobe, Blackout, Build, Drop, Freeze (the v1 Live pads), hold-to-act where
   v1 did; the drop countdown appears **over the stage** as a huge number when a drop is coming.
When nothing plays: the stage shows the ambient effect and the now-playing bar becomes a call to action: **Play the
demo track** / **Listen to this computer** / **Choose music**.
Phone: stage preview 16:9 at top, now-playing bar under it, then Look, Feel, Pads stacked; pads in a 3×2 grid.

## Songs

Top: **How Tempolight hears music**: one row of 4 big choice cards (This computer's sound · Microphone · Spotify ·
Play files here), the active one highlighted with its live level meter and the existing setup checklists
(BlackHole etc.) in a sheet when picked. Then **Your songs**: one unified list/grid of everything it knows
(remembered songs, your music folder, songs added here) with filters (All · Your folder · Learned · Played here),
search, each row: name, tempo, key, look, length, and actions Play / Edit show / Forget. **Add a music folder** and
**Add songs** as the two primary actions at the top right of the list; the library progress ("Analysing 34 of 210")
as a slim bar. Song detail (click a row) opens a side sheet: song map, sections, look with Try another / Keep,
**Edit the show** (opens the existing timeline editor), Forget. Spotify connection and guest song requests live in
this screen's "More options".

## Looks

A visual **gallery of effects** as cards with a small live preview each (render a mini strip/room thumbnail per
effect using the engine on a small canvas, animated only when visible or hovered), grouped: **Best for drops**,
**Build-ups**, **Calm** (from `AUTO` in ratings.js), then **All effects** (search, tag filter). Each card: name, a
"Top pick" badge if in AUTO, favourite (heart = like) and hide (= ban) controls; click = play it now (manual mode)
with a clear **Back to automatic** button in a sticky bar. **Saved looks** (= scenes) as a row of cards at the top
with **Save this look**; schedules move to More. Palette picker and music style as two compact selects in a sticky
"How it chooses" bar (Automatic / one effect, Variety).

## Lights

Top: the **room** (the layout preview) large, with each device's shapes highlighted on hover in the list. Below: a
list of **your lights** as cards (name, kind icon, LEDs, online dot, delay "lands on the beat" status from the
timing info, a test/identify button, edit), **Find lights** (network scan) and **Add a light** primary actions,
**Edit the room** (opens the existing room editor), **Map with the camera**, and a **Timing** card showing the
per-device auto delay with the trim slider and the one-tap timing fix (calibrate). Advanced device settings in each
card's edit sheet (existing forms reused).

## More

A clean grid of cards linking to: Home & sleep, Integrations (Stream Deck, OBS, games, Twitch, Discord, Home
Assistant, Apple Home), Schedules & scenes manager, Settings (general, lighting defaults, performance, safety,
lock/PIN, backup), Set up with Claude (opens the dialog from /claude-setup.js), Help & docs, About (version, update).
These reuse the existing page renderers.

## Shared components (apps/web/v2/ui.css, used by every screen)

Stage frame, now-playing bar, big choice card, gallery card with thumbnail, list row with actions, side sheet
(slides from the right on desktop, bottom sheet on phone, Esc closes, focus trapped), segmented control, big slider,
touch pad, pill/status, sticky action bar, empty state with one primary action, skeleton loading. Hover/press layer
on everything clickable. Reduced motion: no animation.

## Files and contract (so screens are built in parallel)

- `apps/web/v2/ui.css`: shared components (owned by the shell agent; others add screen-specific CSS in their own
  file `apps/web/v2/<screen>.css`, loaded by their module with a <link> it inserts once).
- `apps/web/v2/shell.js`: rail / bottom tabs, top bar with Hearing chip, sheet helper `openSheet({title, body,
  onClose}) → {el, close}`, and `mountScreen`. Exports `openSheet`, `segmented(name, options, value)`, `bigSlider`.
- Each screen is a module `apps/web/v2/<screen>.js` exporting `export function render(el) { …; return { destroy(),
  onStatus?(m), onFrame?(f), onChanged?(w) } }`, the same shape v1 page renderers return (see `PAGES` and
  `route()` in apps/web/app.js; they get the same hooks). Import helpers from "/app.js": `app, api, act, toast, esc,
  $, $$, ws, panel, opt, createPreview, refreshState, loadLayout, fmtTime, guestOk, unlocked, DEMO`.
- Registration: each screen adds ONE entry to `PAGES` in apps/web/app.js using the existing `lazyPage(() =>
  import("/v2/<screen>.js"), "render")` helper. The shell agent changes the default route and the nav; nobody else
  edits app.js beyond their one PAGES line (and the shell agent owns the old-route mapping).
- Keep every element id that scripts/e2e-browser.js or scripts/e2e-demo.js uses reachable (v1 pages stay reachable
  from More); new screens may reuse v1 renderers inside sheets.
- build-site.js copies apps/web recursively? Check; if not, make sure apps/web/v2/ is included in the demo build and
  the service worker cache list (sw.js).
