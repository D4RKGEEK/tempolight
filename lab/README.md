# Sync lab (research branch, not shipped)

Experiments from the sync audit after 0.3.0 (4 Nov 2026). Nothing here is part of the app; it is the starting point
for the 0.4 harness and engine work in the roadmap.

- `beat/`: `eval.js` beat-tracking harness (F ±70 ms, CMLt/AMLt, lock time, timing error) over `songs.js`
  (15 drum songs with known beats). `live-v1.js` = the small tempo patch (F 0.59 → 0.71), `v2.js` = onset-curve
  + autocorrelation prototype. `LIVE=<module> node beat/eval.js`; `--wav f.wav --truth f.json` for your own songs.
- `structure/`: recognition, riser (drop anticipation), self-similarity sections and chord experiments (`exp*.mjs`).
- `feel/`: `measure.js` feel metrics through analysis + director + effects (`ORACLE=1`, `FIX=1`, `EXP=1`, `LIVEEXP=1`).
- `sota/`: micro-benchmarks (real FFT, allocations, profiling scripts).

WAVs and large generated files are left out; `scripts/test-songs/*.py` regenerate the EDM track.
Paths inside the scripts point at the scratch copies they were written in and may need adjusting.
