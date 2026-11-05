# Director and effects

The director ([`director.js`](../../packages/engine/src/director.js)) decides what the room shows each frame; the
effects ([`effects.js`](../../packages/engine/src/effects.js)) draw it. Both are pure: they read a layout, a view of the
music and settings, and write linear RGB into a `Float32Array`. The runtime makes them in `rebuild()` and
`rebuildEffects()` and pushes settings into `director.settings` in `syncDirector()`.

```js
const L = buildLayout(shapes);                       // per-LED coordinates
const fx = createEffects(L, { custom: customEffects }); // {render(id, S, out), list, pools, styles, palettes}
const D = createDirector(L, fx);                     // {frame(V, t, extra, wall), settings, state, flash, identify, next}
const col = D.frame(V, t, extra, wall);              // Float32Array(L.N * 3), linear RGB
```

## The layout every effect reads

`buildLayout(shapes)` ([`layout.js`](../../packages/engine/src/layout.js)) places every shape's LEDs on a 16 x 9 wall
view (x right, y down) and gives each LED coordinates. Effects only use these, which is why every effect works on any
layout:

| Array | Meaning |
| --- | --- |
| `N` | number of LEDs (all shapes, in shape order) |
| `LX`, `LY` | position on the 16 x 9 wall view |
| `PX`, `PY` | room position: `PX` 0 to 1.78 left to right, `PY` 0 at the floor to 1 at the ceiling |
| `LU`, `LH` | `LX / 16` and `1 - LY / 9` |
| `LR` | distance from the room's centre, about 0-1 |
| `LS` | position along its own shape, 0-1 (loops: 0 to just under 1) |
| `LA` | angle around the shape's centre, 0-1 (loops and matrices; `LS` for open shapes) |
| `LD` | distance from the shape's centre, 0-1 |
| `LG` | position along the whole wiring chain, 0-1 |
| `LF` | index of the shape the LED belongs to |
| `LL` | 1 for loop shapes (circle, rect, hex, tri) |
| `shapes`, `chainStart` | the shapes, and the first LED index of each |

Shape types: `line`, `pole`, `free` (polylines through `pts`), `circle`, `rect`, `hex`, `tri` (closed outlines from
`cx, cy, size`, `w, h`, `rot`), `matrix` (`cols x rows`, serpentine wiring) and `points` (one LED exactly at each point:
camera mapping, Nanoleaf panels, smart bulbs, DMX fixtures). `start` rotates where a loop begins, `rev` reverses it.

## The signals object `S`

`buildSignals(V, t, opts)` ([`signals.js`](../../packages/engine/src/signals.js)) makes `S` from a view; the director
adds `text` and `screen`. With nothing playing, `idleSignals(t, pal, fixed)` gives the same fields for a slow made-up
beat (1.2 s, punch 0.2, loudness 0.35, no hits).

| Field | Type | Meaning |
| --- | --- | --- |
| `t` | number | music time in seconds (multiplied by the effect's speed setting) |
| `g` | object | beat grid: `{has, P, phase, idx, beatInBar, env, barPhase, beatT}` (see [engine analysis](engine-analysis.md#reading-it-back-with-songview)) |
| `pal` | `[[r,g,b],[r,g,b]]` | the two palette colours, 0-1 |
| `fixed` | boolean | the user picked a palette (or a colour block is active): effects with colours of their own should use `pal` instead |
| `punch` | number | how hard hits land for the style: party 1, poprock 0.85, hiphop 1, chill 0.35, emotional 0.1 |
| `loud` | number | loudness, 0-1 |
| `pulseT`, `pulses`, `pulseN` | number, number[], number | the last kick (or the grid beat when no kick for 1.6 s), the kicks of the last second, a running kick count |
| `pulse` | number | `exp(-(t - pulseT) / 0.2) * punch`: the main beat envelope |
| `kickE`, `snareE`, `hatE` | number | envelopes of the last kick (τ 0.25 s), snare (0.15 s), hi-hat (0.12 s), times punch |

The kick and snare decays follow the tempo: at 128 BPM and slower they are as above; faster songs get shorter ones
(down to 55%), so one kick doesn't smear into the next. When the view knows how hard a kick was played (`V.kickS`,
0.3 to 1, from the analysis' optional `kickStrength`; or a live `V.kickStrength`), `pulse` and `kickE` are scaled by
it. Without it every kick counts as 1.
| `snare`, `snares`, `hat` | number, number[], number | time of the last snare, snares of the last 0.7 s, last hi-hat (-9 = none) |
| `bassL` | number | bass level 0-1 (live); 0.9 in drops, 0.3 otherwise for songs |
| `bands` | `Float32Array(24)` | live spectrum, 40 Hz to 10 kHz (zeros for songs without a live stream) |
| `wave` | `Float32Array(256)` or null | the last live samples |
| `vocal` | number or null | live vocal estimate, null when there is none |
| `buildP` | number | build-up progress 0-1 in a build; otherwise a slow 16-bar ramp |
| `dropIn`, `sinceDrop` | number | seconds to the next drop (known, or predicted live with `dropConf` 0.5 or more) and since the last one; 99 = none |
| `text` | string | what Text Scroller shows (`settings.text`: song name, BPM, clock or custom) |
| `screen` | object or null | the shared screen picture `{w, h, px}` for Screen Sync |

## The effect contract

An effect is an object in one of the `FX` arrays inside `createEffects()`:

```js
{ id: "halfpulse", name: "Half Pulse", tag: "drop", run(S) {
    const [a, b] = S.pal;
    for (let i = 0; i < N; i++) add(i, LS[i] < 0.5 ? a : b, S.pulse * (0.3 + 0.7 * LH[i]));
} }
```

- `run(S)` **adds** light into the closure's `COL` (`render()` zeroes it first and points it at the caller's buffer).
  Use `add(i, [r, g, b], k)`; values are linear, about 0-2 (more saturates softly in `toRGB8`).
- Time comes from `S.t` and `S.g` only, never from `Date` or `performance.now()`: the clock can jump (seeks, a song
  being recognised), run faster (the effect's speed) or be any clock when idle.
- State that must persist between frames goes in `st(S, id, init)`, which resets when the effect starts again or the
  clock jumps (more than 0.6 s forward or back), and gives `o.dt` (≤ 50 ms) for simulations.
- Helpers in scope: `hex()`, `rainbow(x)`, `G(x, w)` (a Gaussian), `wrapd`, `hash(n)`, `splat(px, py, r, c, k)` (a
  soft light at a room position), `lerp3`, `RW` (room width in `PX` units), the bounding box `BB` and `CORNERS`.
- `tag`: `calm`, `build`, `drop`, `home` (everyday looks), `LedFx-like` or `any`; it labels the effect in the UI and in
  [effects.md](../effects.md). It doesn't put the effect in a pool by itself (custom effects excepted).
- It must stay finite on every LED for any layout (one LED, a matrix, thousands of LEDs) and fast: the engine tests
  render every effect on 1,000 LEDs in under 4 ms.

### Writing a new built-in effect

1. Add the object to `FX`, `FX2`, `FX3` or `FX4` in `packages/engine/src/effects.js` (ids are unique; the list order is
   the UI order).
2. To have automatic mode use it, add its id to `POOLS` (`calm`, `build`, `drop`, used by `party`) and/or to the
   `low`/`mid`/`peak` pools of the other styles in `STYLES`.
3. Run `npm run docs` to regenerate [docs/effects.md](../effects.md).
4. Run `node scripts/effect-score.js --write` (a few minutes) to rate it: `npm test` fails while
   `packages/engine/src/ratings.js` is stale (see below).
5. Run `node --test packages/engine/test/engine.test.js`: *every effect renders finite colours* and *performance
   budget* pick up the new one automatically.

The per-effect settings (`PATCH /api/effects/:id {params}`) work on any effect without its help: the director
renders it with `t * speed`, then applies a hue rotation and saturation as one 3 x 3 matrix, an intensity gain, and
an optional left-right mirror (each LED takes its mirror image's colour).

## Effect ratings

[`ratings.js`](../../packages/engine/src/ratings.js) (generated) says how good every built-in effect is in a drop, a
build-up and a calm part (0..100), with traits for matching effects to songs (`tempo` range, `energy`, `kickDriven`,
`needsBeat`, `busy`), and `AUTO`: the curated picks per role, best first. `rating(id)` is `null` for custom effects.
`scripts/effect-score.js` makes them by running each effect alone through the director on synthetic songs with a known
beat (EDM at 128 and 150 BPM, pop, a ballad, hip-hop, half-time and drum and bass) and measuring kick contrast, beat
sync, brightness, flicker, movement, use of the room and the build-up response, raw and with the feel layer.
`--write` regenerates `ratings.js` and the table in [effect ratings](effect-ratings.md); `--check` (and
`packages/engine/test/ratings.test.js`) only compares the effect ids and a hash of their sources, so it is cheap.

## Pools and styles

A **style** says how the director listens and which effects it picks:

| Style | Mode | Pools | Crossfade | `every` | Brightness floor | `pump` | `moment` | `dyn` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `party` (Party / EDM) | `sections`: by song part | `calm`, `build`, `drop` | 0.3 s | 1 | 0.06 | 1 | 1 | 1 |
| `poprock` (Pop / Rock) | `levels`: by loudness | `low`, `mid`, `peak` | 0.4 s | 1 | 0.07 | 0.8 | 0.85 | 0.85 |
| `hiphop` (Hip-hop / Trap) | `levels` | `low`, `mid`, `peak` | 0.3 s | 1 | 0.07 | 1 | 1 | 1 |
| `chill` (Chill / Lo-fi) | `levels` | `low`, `mid`, `peak` | 1.2 s | 2 | 0.1 | 0.3 | 0.4 | 0.5 |
| `emotional` (Emotional / Ballad) | `levels` | `low`, `mid`, `peak` | 2.0 s | 2 | 0.12 | 0 | 0.25 | 0.4 |

`pump`, `moment` and `dyn` scale the feel layer for the style (see below).

The style is the view's (from the analysis or the live estimate) unless `show.style` fixes one. `choose()` each frame:

1. Manual mode: the chosen effect (`show.effect`).
2. A show timeline for this song: the block at `t` (an effect banned since is skipped).
3. With variety `one` or `parts` (`show.variety`, default `one`) and a look: the look (see [Looks](#looks-one-effect-per-song)).
4. Otherwise `chooseStep()` in [`show.js`](../../packages/engine/src/show.js). It picks the pool for the current part
   (`sections`: `V.state`; `levels`: the loudness level), keeping only the effects automatic mode is meant to use
   (`AUTO` in [`ratings.js`](../../packages/engine/src/ratings.js), plus your own effects and liked ones; the whole
   pool if that leaves fewer than two: `autoPool()` in `looks.js`). Banned effects (`settings.effectPrefs[id] === -1`) are left
   out, liked ones (`1`) appear twice; if everything is banned the whole pool is used. Then:
   - A drop changes effect at once, as a hard cut (no crossfade). It opens with a high-impact effect from the pool
     (`fx.impact`: effects that hit on every kick), not one that played a moment ago.
   - Every other change waits for the next downbeat. An effect always lasts at least a bar.
   - In `levels` styles a level counts once it held most of a bar. A new song part (from the analysis) counts at
     once on its first downbeat, so level changes land with the part.
   - Effects change on the phrase grid: every `swapBars()` bars, counted from where the part started. The pace comes
     from `show.everyBeats` (default 8) x `every`: 4 bars at the default. In drops and peaks the look changes twice as
     often, but every other change is a variation (the palette's two colours swap and the room is mirrored, for
     `varyBars()` bars), not a new effect. `settings.variations: false` turns the variations off.
   - A banned effect leaves at once. A silence doesn't change the effect unless the effect is wrong for calm music.

   Each change moves to the next pair of the automatic palette.

After rendering comes the feel layer, then: in a silence the room dims (the planned pause right before a drop, or the
first 1.5 s of quiet) or fades to the ambient effect; otherwise `keepAlive()` mixes the ambient effect in when the room
falls under the style's floor (lowered as much as the feel layer dimmed the effect), so quiet music never goes dark.
Then the moments (below). Then the accent **layer** (`show.layer: {effect, amount}`) is added on top, and **zones**
apply: each zone (`room.zones`, shapes join with `shape.zone`) follows the show, shows its own effect or the ambient
effect, gets its own brightness, or is off.

## Looks: one effect per song

Switching effects every few bars can look busy. A look is one well-chosen effect (and palette) for the whole song,
on the beat, the way a person picks one LedFx effect and lets it run.
[`looks.js`](../../packages/engine/src/looks.js) picks it when the song is analysed; the runtime keeps it with the
remembered song.

```js
pickLook(analysis, { prefs, nudge, exclude, seed, available })
// → { main, drop, build, calm, palette, params: { speed?, intensity? }, why: ["fast four-on-the-floor", "high energy", ...], v }
```

- **The song's character** (`songCharacter(pre)`): tempo, style, the kick where the drums play (beats with a kick in
  the bars with kicks on two beats or more, times how much of the song has drums), no drums at all, energy (style,
  mood energy, kick, tempo), dynamics (drops that stand out from the rest), build-ups, vocals, mood and key.
  `characterOf()` makes one from what live listening knows.
- **The ratings** ([`ratings.js`](../../packages/engine/src/ratings.js), generated by `scripts/effect-score.js`): per
  effect `drop`, `build`, `calm` 0-100, `tempo: [min, max]`, `energy` (low, mid, high), `kickDriven`, `needsBeat`,
  `busy` 0-1; `AUTO` lists the effects automatic mode picks from, best first.
- **Main**: from `AUTO.drop` and `AUTO.calm` (and liked rated effects). The score blends the effect's drop and calm
  ratings by the song's energy, minus the energy gap, plus the tempo fit (+8 inside its range, down to -30 outside),
  +12 for a kick-driven effect on a steady four-on-the-floor (-18 with light drums), busy effects for energetic songs.
  A song without drums never gets an effect that needs the beat; one whose tempo is a guess (no steady drums) is
  marked down for it. Liked +15, `nudge` (-1..1) x 20, banned and `exclude` (rejected for this song) left out.
- **Varied but stable**: the best four are a seeded weighted choice (weights `exp((score - best) / 8)`), seeded with
  the song's name. The same song gets the same look; two EDM songs usually don't.
- **drop**: an effect of its own for the drops only when the drops really stand out, the song isn't calm, and the
  main effect isn't already a big high-energy one. **build**: when the song has build-ups. **calm**: the main effect
  when it suits calm parts (or the song is calm), else a calm one.
- **palette**: from the mood, as the mood colours do (happy: sunset or fire; calm and major: forest or ocean; sad:
  ocean or ice; tense: neon or fire), else from the style and key; a voice up front in a quiet song: sunset.
- **params**: `speed` follows the tempo (BPM / 120, 0.75 to 1.3) for effects that don't need the beat; `intensity`
  1.1 for energetic songs, 0.9 for calm ones. The director applies them on top of the effect's own settings.

**Varieties** (`settings.variety` in the director, `show.variety` in the API): `lookEffect(look, variety, part)`.

| Variety | Calm | Build-up | Drop |
| --- | --- | --- | --- |
| `one` (default) | main | main | `drop`, or main |
| `parts` | `calm` | `build`, or main | `drop`, or main |
| `show` | effects change with the song (`chooseStep()` above, `AUTO` pools only) | | |

`lookStep()` (show.js) plays a look: the effect for the part, a hard cut at a drop, otherwise on the next downbeat and
at least a bar after the last change. `planShow(pre, fx, {variety, look})` uses the same function, so a look's show is
what the live director plays (one block for `one`, a few for `parts`). The liveliness comes from inside the effect:

- **Speed** follows the tempo (`params.speed`).
- **Intensity rises through build-ups**: the build toward the drop (the feel layer below); with no drop ahead, x 0.8
  at the start to x 1.25 at the drop, on top of the energy contour.
- **Colour steps on phrase lines** (`phraseStep(V)`): each section label gets its own step (`songView` gives
  `V.section` and `V.barI`), so a chorus that comes back has the same colour, and a long section steps again every 16
  bars; live, every 16 bars. Step 0 is the look's palette, 1 and 2 turn it 40° round the colour wheel, 3 swaps its
  colours. The palette eases over 0.3 s. A palette picked by hand (not `auto`) wins.
- The drop's **2-bar variations** (restarted at every drop) and the whole **feel layer** below.

**Live listening** without a remembered song: the director picks a look of its own (`D.look.provisional`). A first
one after 2 s of music, from the tempo and the kicks so far (the effect showing stays until then). The one to keep
at the first drop or after 20 s (the first one wins a close call: a +0.6 nudge), then no more changes. A new song
(4 s of silence, nothing playing for 3 s, or a new source: `D.resetLook()`) picks again. A song recognised by song
memory plays its own look. `D.nextLiveLook(id)` is "Not this one" for it (`settings.lookExclude`).

**In the runtime** ([`runtime.js`](../../packages/server/src/runtime.js)): `remember()` stores `entry.look = {main,
drop, build, calm, palette, params, why, v, rejected: [], locked}`. `lookOf(e)` picks it again when `v` is older
than `LOOK_VERSION`, or its effect is banned, unless kept by hand (`locked`). The song's show is planned with its
look and planned again when the variety or the look changes (`showKey`). `POST /api/song/look/next` adds the main
effect to `rejected` and picks again; `keep` sets `locked`. "Not this one" nudges the effect down by 0.15 and "Keep"
up by 0.1 (`settings.effectNudge`, -1..1), so other songs feel it a little. The status has `look` with a `label`
("Kick Shockwave · Sunset (fast four-on-the-floor, high energy)").

## The feel layer

The feel layer works on the whole frame, on top of any effect. The effects themselves don't change.

- **Energy contour** (automatic mode). Each song part has a brightness to aim for: calm 0.08, a build-up rising from
  0.12 to 0.32, a drop 0.34 (mean brightness after the LED roll-off). In `levels` styles calm parts aim at 0.085, 0.13
  or 0.2 by level. The aim eases in over 0.6 s and out over 0.4 s, and jumps at a drop.
- **Evening out** (automatic mode). Each effect has a usual brightness (`fx.lum`, measured in the example room). The
  director learns what it really is in this room while it plays (6 s average), and brings it toward the part's aim.
  It also learns how much the LED roll-off keeps a bright effect from its aim. The gain stays between 0.1 and 3.
  `settings.dynamics` (0 to 1, default 0.8) times the style's `dyn` sets how far: 0 leaves effects as they are.
- **Kick pump** (drops, any mode; `levels` styles also at their peak level). The frame dips between kicks and comes
  back on each one: `1 - depth * (1 - hit * exp(-age / τ))`, τ about a quarter beat (80 to 160 ms). The depth is
  `0.8 * settings.punch` (default 0.7) times the style's `pump`. An effect that doesn't light up on the kick by itself
  gets a deeper pump, up to 0.85 (learnt per effect). Kicks on the beat grid pump on the grid's beat, so a kick
  detected a little late still lands on time. The floor and the middle of the room pump a little more than the
  ceiling and the edges. Night mode (`settings.night`) makes it 0.4 x as deep. Safe mode caps it at 0.1.
- **Build toward a drop** (any mode and variety; `rampOf()`). A drop ahead that is known (`V.dropConf` 1: an analysed
  or remembered song, a show's cue, the Build & drop pad) or predicted live from `dropConf` 0.5 (the
  [drop countdown](live-analyser.md#drop-countdown)) starts a ramp while the music builds up (a build-up part, or a
  live prediction), or over the last 2 bars before any known drop. Its progress `r` runs 0 to 1 from where it began
  (8 bars before the drop at most) to the drop; a prediction that moves keeps the start, and eases back rather than
  dropping. Over it: **brightness** from where it was to `1 + 0.9 * min(1, 1.25 * dynamics) * moment` (half at night),
  along `r²`; a known drop first eases down to `1 - 0.5 *` that over a beat, so there is more to rise. **Speed**: the
  effect's free-running animation runs up to 1.7x as fast (its clock moves ahead; kick, snare, hat and beat times move
  with it, so hits stay on time; not for effects that need the beat). **Pulses** in the last bar until its last beat:
  eighths, then sixteenths for the last two beats, `0.45 * punch * moment` deep and as bright on average; only for
  effects whose rating has mid or high energy, never in safe or night mode. `D.ramp` is `{at, conf, r, building}`
  (status `drop.building`). One effect throughout: in variety `one` the energy comes from these, not a new effect.
- **Moments** (every style, as big as its `moment`). The last beat before a sure next drop (`V.nextDrop`, `dropConf`
  0.5 or more) dims, by up to 75% (90% at the end of a ramp), without needing a silence. The first 0.7 s of a drop
  flash white (`settings.dropFlash`; 0.6 x in safe mode); after a build ramp the flash peaks higher, by as much as the
  ramp brightened the room, with the extra part gone by the next kick. The drop itself is a hard cut.

## Custom effects

Made on the Effects page without code, stored in `customEffects` (at most 100) and compiled by `customEffect(d)`:

```js
{ id: "u-1a2b3c4d", name: "My effect", tag: "calm"|"build"|"drop"|"home",
  pattern: "wave"|"chase"|"pulse"|"sparkle"|"fill"|"breathe"|"gradient",
  axis: "along"|"x"|"y"|"around"|"centre",   // LS, PX/1.78, PY, LA, LD
  drive: "beat"|"kick"|"bass"|"loud"|"time", // S.pulse, S.kickE, S.bassL, S.loud, constant 1
  colors: "palette" | ["#rrggbb", "#rrggbb"],
  speed: 0.1-8 (1), width: 0.01-1 (0.15), bg: 0-0.5 (0.05), cycles: 0.25-8 (1) }
```

The server validates them (`cleanCustom` in `core.js`) and the engine clamps them again (saved files and backups can
hold anything). A custom id can't replace a built-in one. Custom effects join the automatic pools by tag: `calm`,
`build` and `drop` into the party pools and `low`, `mid`, `peak` into the other styles (`home` joins none). Deleting
one removes every reference to it (`forgetEffect`: the shown effect, layer, ambient, zones, scenes, likes, song shows).

## Shows and timelines

A remembered song can carry a **show**: a timeline the director plays instead of choosing on the fly (with
`settings.shows` on and automatic mode).

`planShow(pre, fx, {seed, prefs, everyBeats, variety, look})` ([`show.js`](../../packages/engine/src/show.js)) makes one from the
analysis. It plays the song through `chooseStep()`, the same function the live director uses, on `songView` in
quarter-beat steps. So an automatic show is exactly what the live director would have played, only fixed: the same
song always gets the same show. Variations and the feel layer are not stored in the show: the director adds them
while it plays (a block's `part` of `drop` counts as hot). Blocks shorter than a second (or two beats) and equal neighbours are merged;
the first block starts at 0 and the last ends at the song's end. Shows are versioned (`showV`; the planner's
current version is `SHOW_VERSION` in `show.js`): an automatic show made by an older version is planned again when
it's next read, while a show edited by hand is kept.

[`timeline.js`](../../packages/engine/src/timeline.js) adds what the show editor makes, all in seconds on the song's
clock, kept to the millisecond:

```js
show:   [{t0, t1, part, effect}]                                  // effect blocks, sorted, no overlaps
colors: [{t0, t1, palette: "<id>"} | {t0, t1, colors: ["#rrggbb", "#rrggbb"]}] // override the palette
cues:   [{t, type: "flash"|"strobe"|"blackout"|"build"|"drop", color?: "#rrggbb" /* flash only */, beats?: 0.25-128}]
bright: [{t, v: 0..1}]                                            // straight lines between keyframes
```

`cleanTimeline()` validates them for `PUT /api/songs/:id/show` (at most 500 of each; unknown effects or palettes,
overlaps and times past the end are 400 errors). Cues last `beats` (default strobe 4, blackout 2, build 16, drop 16;
a flash is a single hit). In the director: build and drop cues change `V.state` (and `buildP`, `dropT`); a colour
block becomes `S.pal` with `fixed` true; flash cues fire once each as the clock passes them (`createCueFirer`: within
250 ms, so a seek forward skips them, a seek back re-arms them); strobe flashes at sixteenth notes; blackout and the
brightness curve multiply the result. The editor's unsaved version plays for two minutes through
`runtime.setDraft()`.

## Palettes and mood colours

`fx.palettes` maps an id to two linear RGB colours: `neon`, `sunset`, `ocean`, `fire`, `ice`, `forest`, `mono`, `mood`,
and `auto`, a list of five pairs (pink/orange, cyan/blue, violet/red, green/blue, yellow/red) that the director steps
through with every effect change (`state.palIdx`).

With `show.palette` `auto` and `settings.moodColours` on (or palette `mood`, for every effect), the palette follows the
music's mood: `moodPalette(valence, energy, variant)` ([`tonal.js`](../../packages/engine/src/tonal.js)) blends four
corners by smoothstepped valence and energy (happy and energetic: warm oranges and pinks; calm and major: teal and
green; calm and minor: deep blues and violets; tense: reds and magentas), two variants per corner so effect changes
still bring new colours, rescaled so blends stay as bright as the corners. The director eases towards it with a 2.5 s
time constant and drops it 5 s after the mood is gone. Night mode with `warm` on forces `sunset`.

## Overlays, pads and safe mode

`director.state.overlay` holds the live pads, applied after everything else (`runtime.action()` sets them):
`hold` (one colour everywhere), `flash` (decays over 0.6 s, white or a colour), `strobe` (12 Hz), `boost` (gain
0-2), `blackout`, `freeze` (repeat the last frame), and `identify` (one shape lit white with a chase for 4 s, the
rest dimmed). The `post` hook runs before them, so the sunrise alarm, the sleep fade and the integrations' layer sit
on top of the show but under the pads.

**Safe mode** (`settings.safe`, also forced on in night mode) adds the photosensitivity limiter (WCAG 2.3.1): the mean
brightness may jump (to more than 1.8 x the recent level + 0.12) at most 3 times a second; further jumps are scaled
down. Night mode also turns the drop flash off, and DMX strobes and lasers never run in either.

## Tests

`packages/engine/test/engine.test.js` (every effect finite, the time budget, custom effects, Text Scroller, Screen Sync),
`live.test.js` (quiet music never goes dark, blackout/flash/limiter, banned effects, zones, settings),
`director.test.js` (the feel layer: pump, drop moments, phrase grid, level hold, variations, kick strength),
`feel.test.js` (the feel scoreboard, `npm run eval:feel`, must not get worse than its baseline; the looks must meet
the targets that apply to them, and variety `one` changes effect at most twice a minute),
`looks.test.js` (what `pickLook()` picks, banned and rejected effects, a look's show against the live director, the
live look),
`timeline.test.js` (validation, lookups, the cue firer, cues in the director, a clock that jumps back) and
`tonal.test.js` (mood colours) and `ratings.test.js` (the effect ratings are up to date and keep their contract). See
[testing](testing.md).
