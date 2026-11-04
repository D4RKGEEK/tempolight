# Whole-song analysis

`preAnalyseCore(x, sr, onProgress)` in [`packages/engine/src/analysis.js`](../../packages/engine/src/analysis.js)
analyses a whole song once, before it plays. It runs in the browser when a song is added on the Music page
(`apps/web/audio.js` decodes the file, mixes to mono, halves the rate above 32 kHz so 44.1 or 48 kHz become ~22-24 kHz, and calls
it), in the server on each stretch of a Spotify track heard while learning it (`spotify-learn.js`), and in tests on synthetic songs. It is `async` only to yield (`setTimeout(0)` every
600 frames) so a page stays responsive; there is no I/O.

```mermaid
flowchart LR
  X["mono samples, about 22 kHz"] --> STFT["STFT: 1024-point Hann, hop 256"]
  STFT --> BANDS["per frame: RMS, low/mid/high band means, kick/snare/hat flux, singing"]
  BANDS --> ON["peak picking: kicks (with strength), snares, hats"]
  ON --> TEMPO["tempo histogram + octave check + double-time rule"]
  TEMPO --> GRID["grid: growing least-squares fit through the kicks"]
  GRID --> BEATS["per-beat features, downbeat"]
  BEATS --> BARS["bars: calm, drop, silent; energy, dance, chord, vocal"]
  BARS --> BUILD["build-ups: the 2, 4 or 8 bars before each drop"]
  BUILD --> STYLE["style"]
  BARS --> SECT["sections: self-similarity + novelty, labels, phrase grid"]
  X --> CHROMA["songChroma: 4096-point FFT every 100 ms (+ bass chroma)"]
  CHROMA --> BEATS
  CHROMA --> KEY["key: profiles + tonic hint (bass, phrase-start chords)"]
  SECT --> KEY
  KEY --> MOOD["mood: valence, energy"]
  STYLE --> OUT["result"]
  MOOD --> OUT
```

## Steps

**STFT.** 1024-point frames with a Hann window, hop 256 (11.6 ms at 22,050 Hz), a real-input FFT
([`fft.js`](../../packages/engine/src/fft.js): the 1024 real samples packed into 512 complex values, a 512-point
radix-2 FFT and a split pass; about 2.7 x faster than the 1024-point complex FFT it replaced, and the 4096-point
chroma FFT uses it too). A 4-minute song analyses in about 1.2 s on a laptop (2.7 s before). Per
frame it keeps the RMS, the mean magnitude in three bands (low 40-150 Hz, mid 300-2,000 Hz, high 4-11 kHz) and the
positive spectral flux (sum of magnitude increases) in three onset bands: kick 40-130 Hz, snare 180-320 Hz
(x 0.6) plus 1.8-5 kHz (x 0.4), hi-hat 7-11 kHz.

**Onsets.** `pick(flux, minGap, k, strength)` takes local maxima above `k` times the mean of a ±350 ms window, keeps
those stronger than `strength` times the 90th percentile of all peaks, and enforces a minimum gap. Kicks: gap 200 ms,
k 1.6, and the low band must also carry real energy (above 35% of its 90th percentile), so a bass line's attack doesn't
count. Snares: gap 100 ms, k 1.5. Hats: gap 60 ms, k 1.4. Each kick's **strength** (`kickStrength`, aligned with
`kicks`) is its peak low-band flux against the 90th percentile of all kicks, clipped to 0-1 (a typical strong kick is
about 1).

**Tempo.** Kicks and snares together (backbeat genres need the snare) vote into a histogram of 60-180 BPM in half-BPM
steps: every pair of onsets less than 4 s apart, divided by 1 to 4 beats, adds a Gaussian (σ 0.7 BPM, weight 1/m).
A broad prior centred on 112 BPM breaks ties. Then an **octave check**: for the winner and its x2, /2, x1.5, /1.5,
x4/3 and x0.75 relatives (within 58-185 BPM), a phase fit (the resultant length of onsets on a circle of one beat,
searched ±1 BPM in 0.05 steps) times the square root of how many grid beats have an onset within 70 ms, times a
prior, picks the tempo and its offset. **Double-time rule:** a song with long stretches without drums (an EDM intro
and break) scores too well on a half-time grid, where there are fewer beats to miss; so below 90 BPM the double-time
reading wins when it scores at least 0.6 of the best (a two-minute EDM song at 128 BPM used to read 64 and get the
`hiphop` style, no drop moments, and bar lines on the downbeat 0% of the time).

**Grid.** The beat grid is then fitted to the drums: the kicks when there are 16 or more (off-beat hi-hats can't pull
beat 1 half a beat late), otherwise kicks and snares. A least-squares line `t = off + k·P` goes through the hits within
70 ms of a grid line, first over the first 8 s with drums, then over a stretch that grows 1.6 x per step until it
covers the song; the last pass tightens to 60, 40 and 30 ms. Each step's grid is precise enough to number the beats
across the next stretch, even over a drumless break, where a search over tempos would find several near-equal fits
when the drums come in separate parts. A 4-minute song now drifts by 2 ms at most (it was 10-17 ms at tempos that
aren't round numbers, and 94 ms on a 65 s EDM track). Tempos above 150 BPM are then halved (lights read better at
half time).

**Beats and bars.** Per beat: mean low, RMS, high and mid, and the chroma over the beat. The downbeat (`barOff`, 0-3) is
the beat position whose energy jumps (low band and RMS, squared) plus 0.25 x the squared change of notes from the beat
before are largest, because new sections start on beat 1 and chords change there. Bars are 4 beats from there.

**Song parts.** Each bar's low, RMS, high, snare count and low/mid dominance are normalised between their 10th and
90th percentiles over the song. A bar is:

- `silent`: normalised RMS under 0.05 and RMS under 30% of the median and under 5% of the song's loud parts (a soft
  intro before long drops is still music);
- `drop`: low band over 0.55, dominance over 0.5, RMS over 0.45 and at least 3 kicks in the bar;
- `calm`: otherwise.

A single bar different from both neighbours takes their state (except silence). **Build-ups**: before each drop that
follows a non-drop bar, the phrase of 2, 4 or 8 bars with the strongest rise in tension (snares + 2 x hi-hats +
0.5 x RMS, inside the phrase versus the phrase before, times √L) becomes `build`. Each first drop bar's start time is
a drop.

**Loudness envelope.** RMS every 20 ms, divided by the 95th percentile, as `env` (`Float32Array`). It drives
`songView().loud`, the silence check and song memory's fingerprint.

**Style.** From the song's character: hi-hats per second, snares per second, the share of beats with a kick on them,
the dynamic range (90th / 25th percentile of the envelope above 0.02) and the tempo:

| Condition | Style |
| --- | --- |
| not percussive (hats ≤ 2/s and snares ≤ 3.2/s), dynamic range > 2.5 | `emotional` |
| not percussive | `chill` |
| at least one drop, kicks on > 25% of beats, ≥ 110 BPM | `party` |
| < 102 BPM | `hiphop` |
| otherwise | `poprock` |

**Per bar** (new fields, all optional for readers):

- `energy` (0-1): the bar's mean RMS against the song's 95th percentile frame RMS (absolute within the song; `level`
  is the 10th-90th percentile normalisation used for the parts).
- `dance` (0-1): a local danceability score, `√tempoFit · (0.45 · kicks on the 4 beats / 4 + 0.15 · snares on beats 2
  and 4 / 2 + 0.2 · eighth-note positions with any hit / 8 + 0.2 · min(1, 1.3 · energy))`, where `tempoFit =
  exp(-((bpm - 122) / 45)²)`; 0 for silent bars. The song's mean over non-silent bars is `features.dance`.
- `chord`: an index into `CHORDS` (`0` C, `1` Cm, `2` C#, ... `23` Bm) or `null` when the bar has no clear notes:
  `barChords()` adds up the bar's chroma frames (a frame in from either end) and `chordOf()` takes the best of 24
  triad templates (root weighted 1.2) by Pearson correlation, plus 0.15 x the root's share of the bass chroma. About
  94-100% right on the synthetic songs.
- `vocal` (boolean): the live analyser's singing estimate (a tonal 150-1,000 Hz peak whose pitch wanders, held rather
  than plucked; see [live analyser](live-analyser.md)) run offline every 2nd frame; the bar is flagged when its mean is
  above 0.35. `features.vocal` is the share of flagged bars.

**Sections** ([`structure.js`](../../packages/engine/src/structure.js)). Each bar becomes a 16-value vector: its
chroma (scaled to length 1), `1.5 · log10(energy)`, and kicks / 4, snares / 8, hats / 8. A self-similarity matrix
(`exp(-d² / 0.5)`) is scanned with Foote checkerboard kernels 2 and 4 bars wide; their sum's local peaks above 30% of
the highest are boundaries. The **phrase grid** is the offset (0-7 bars) that puts the most novelty on multiples of 8
bars (half weight on the 4s between); its length is 16 when the song has 48+ bars and the boundaries keep to 16, else
8. A boundary one bar off the 4-bar grid moves onto it when the grid bar is at least 70% as novel. Each section is
compared with the earlier ones along the diagonal; a mean similarity above 0.6 gives it the same label (`A`, `B`,
...), so a chorus or a drop that comes back repeats its letter. `state` is the section's most common bar part. On the
2-minute EDM test song all 7 true boundaries are found (with 3 extra splits inside long parts), and both drops share a
label.

**Key, mood and chroma** come from [`tonal.js`](../../packages/engine/src/tonal.js):

- `songChroma()` runs a `ChromaTap` over the song: every 100 ms a 4096-point FFT (about 186 ms at 22 kHz, fine enough
  for semitones down to ~80 Hz); spectral peaks from 65 Hz to 4.2 kHz above 2% of the strongest are placed on the 12
  pitch classes at their interpolated frequency (weighted down above 1 kHz); each frame is scaled so its strongest
  class is 1 (all zeros for quiet or noisy frames). It also gives the median spectral-centroid brightness (350 Hz is 0,
  2.8 kHz is 1).
- `keyOf(avg, hint)`: Pearson correlation of the average chroma with the 24 rotated Krumhansl-Schmuckler profiles, plus
  0.4 x a tonic hint; the best is the key. A key and its relative (C major, A minor) share their notes, so the profiles
  alone often can't tell them apart (Am F C G read C major and "happy"). `tonicHint()` says which note is home: 30%
  from the bass chroma (30-250 Hz peaks, `ChromaTap` with `{bass: true}`), 70% from the chords that start sections,
  every 4th bar of the phrase grid, and the song's first and last sounding bar (a tonic chord of the key's kind counts
  1, of the other kind 0.5). `confidence` grows with the gap to the runner-up; `majorness` (-1 to 1) compares the best
  major and minor fits (with the hint, so valence follows the mode found).
- `moodOf(f)`: `energy` from percussion (hats, kicks on beats), tempo, brightness and onset rate (tempo and onsets count
  only as much as there are drums, because a piano piece's attacks pass for snares); `valence` from majorness
  (weighted by confidence), brightness and tempo. Both 0 to 1. `moodName()` turns them into a word (euphoric, happy,
  peaceful, wistful, melancholic, tense, intense).
- `packChroma()`: the 10-a-second frames averaged in pairs (5 a second), each class as 4 bits of `sqrt(v / max)`, so
  6 bytes a frame, base64. This is song memory's second fingerprint.

## Output

```js
{
  bpm, P,            // tempo and beat length in seconds (P = 60 / bpm)
  off, barOff,       // time of a beat (s) and which beat (0-3) of the grid starts a bar
  kicks, snares, hats, // onset times in seconds, sorted
  kickStrength,      // number[] aligned with kicks, 0..1 (a typical strong kick ≈ 1)
  bars: [{t0, t1, state: "calm"|"build"|"drop"|"silent", level: 0..1,
          energy: 0..1, dance: 0..1, chord: 0..23|null, vocal: boolean}],
  sections: [{t0, t1, bar0, bar1, label: "A"|"B"|..., state}], // bar1 exclusive; they tile all the bars
  phrase: {len: 8|16, first},  // phrases start at bars first + k·len (bar indices into bars)
  drops,             // start times of drops
  env,               // Float32Array, loudness every 20 ms (1 ≈ loud)
  dur,               // seconds
  style,             // "party"|"poprock"|"hiphop"|"chill"|"emotional"
  key, mode, keyConfidence,  // "A", "minor", 0..1 (null when there are no notes)
  mood: {valence, energy},
  chroma,            // base64, 6 bytes per 200 ms (packChroma)
  features: {kickFrac, dyn, onsetRate, hatRate, snareRate, bright, dance, vocal}
}
```

`kickStrength`, the bars' `energy`, `dance`, `chord` and `vocal`, `sections`, `phrase` and `features.dance/vocal` are
new in 0.4 and optional for every reader: analyses made before (and song-memory entries saved before) don't have them.

The browser sends this as `POST /api/song {name, analysis, clientId}` (typed arrays become plain arrays in JSON;
`runtime.setSong()` turns `env` back into a `Float32Array`). With song memory on and a song longer than 20 s, the
runtime keeps a compact copy (see [song memory](song-memory.md)) and plans a show for it.

## Reading it back with songView

[`signals.js`](../../packages/engine/src/signals.js) turns an analysis and a time into a *view*, the common shape the
director takes from every source:

| Field | Meaning |
| --- | --- |
| `g` | `gridAt(pre, t)`: `{has, P, phase (0-1 within the beat), idx (beat number), beatInBar (0-3), env (decay since the beat, 0.18 s), barPhase (0-1 within the bar), beatT (time of this beat)}` |
| `bpm`, `style` | from the analysis |
| `state` | the bar's part (a bar lasts until the next one starts, across gaps under 1 s), or `silent` once the envelope has stayed under 0.1 for 0.6 s (the gaps between the hits of a build-up aren't silence) |
| `buildP` | 0-1 progress through the current run of build bars |
| `loud` | mean envelope over the last 300 ms |
| `level` | `low` / `mid` / `peak` from the bar's level and the loudness |
| `kick`, `snare`, `hat` | time of the last of each (-9 when none) |
| `pulses`, `snares`, `pulseN` | kicks of the last second, snares of the last 0.7 s, index of the last kick |
| `dropT`, `nextDrop` | the last drop's time (-9 when none) and the next one's (null when none) |
| `key`, `mode`, `keyConf`, `mood` | whole-song key and mood |

`metronomeView(t, bpm, grid?)` gives the same shape for a steady beat (state `drop`, level `peak`), optionally on a
grid from DJ Link, MIDI clock or Ableton Link. `LiveAnalyser.view()` gives it for live audio
([live analyser](live-analyser.md)).

## Tests

`packages/engine/test/engine.test.js` and `tonal.test.js` run the analysis on synthetic songs from
`packages/engine/test/synth.js` (an EDM track at 128 BPM with a 4-bar intro, a 4-bar snare-roll build-up and an 8-bar
drop; ballads, pop, voice and plucked notes with known keys) and check the tempo, the drop's position, the parts and
the key. `analysis.test.js` covers the 2-minute EDM song (`test/long-edm.js`: 8-bar intro and break without drums)
reading 124/128/140 BPM as `party` with bars on the downbeats, grid drift ≤ 2 ms over 4-minute songs at 97.13, 123.37
and 128.62 BPM, the EDM tracks reading A minor, chords, sections, the per-bar fields, the vocal flag and the real FFT.
See [testing](testing.md).
