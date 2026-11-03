# Contributing to Tempolight

Thanks for helping. A few rules keep the project light and easy to run on cheap hardware.

## Ground rules

- **No runtime dependencies** without a discussion first. Node's built-in modules cover UDP, HTTP, tests and files.
- **The engine stays pure.** `packages/engine` never touches files, the network or audio devices, so it runs in the
  browser, in tests and on a Raspberry Pi unchanged.
- **Performance budget.** Every effect must render 1,000 LEDs in under 4 ms on a desktop. `npm test` checks it.
- **Photosensitivity.** Effects that strobe must respect the punch value (`S.punch`) so calm styles tone them down;
  safe mode also limits big brightness jumps to 3 a second.
- **The web app has no build step.** Plain JavaScript modules in `apps/web`, system fonts, works offline.

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

Add its id to a pool in `POOLS` or a style in `STYLES` if automatic mode should use it. Then run `npm test`: it renders
every effect on sample rooms and checks the colours are valid and fast enough, and `npm run docs`.

## Development

```bash
npm test                 # all tests
npm run serve            # the app on http://localhost:8080 (npm start also opens a browser)
npm run fake-wled        # a pretend WLED controller to stream to
npm run test:browser     # end-to-end test in a real browser (needs Playwright)
npm run docs             # regenerate docs/effects.md after adding an effect
node scripts/demo.js --dry --effect myeffect   # render without hardware, prints frame time
```
