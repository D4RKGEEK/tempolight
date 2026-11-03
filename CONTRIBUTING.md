# Contributing to Tempolight

Thanks for helping. A few rules keep the project light and easy to run on cheap hardware.

## Ground rules

- **No runtime dependencies** without a discussion first. Node's built-in modules cover UDP, HTTP, tests and files.
- **The engine stays pure.** `packages/engine` never touches files, the network or audio devices, so it runs in the
  browser, in tests and on a Raspberry Pi unchanged.
- **Performance budget.** Every effect must render 1,000 LEDs in under 4 ms on a desktop. `npm test` checks it.
- **Photosensitivity.** Effects that strobe must respect the punch value (`S.punch`) so the safe mode can tone them down.

## Adding an effect

Effects live in `packages/engine/src/effects.js`. An effect is an object with an id, a name, a tag
(`calm`, `build`, `drop` or `any`) and a `run(S)` function that adds light to each LED:

```js
{ id: "myeffect", name: "My Effect", tag: "drop", run(S) {
    for (let i = 0; i < N; i++) {
      // PX/PY: position in the room, LS: along the shape, LA: around the shape, LG: along the wiring
      add(i, S.pal[0], 0.1 + 0.8 * S.pulse);
    }
} },
```

Useful signals: `S.t` (seconds), `S.g.phase` (0..1 within the beat), `S.g.beatInBar`, `S.pulse` (kick envelope),
`S.snareE`, `S.hatE`, `S.loud`, `S.buildP` (build-up progress), `S.pal` (two colours).

Then run `npm test`: it renders every effect on sample rooms and checks the colours are valid and fast enough.

## Development

```bash
npm test          # all tests
npm start         # server + playground on http://localhost:8080
node scripts/demo.js --dry --effect myeffect   # render without hardware, prints frame time
```
