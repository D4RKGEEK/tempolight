// Tempolight for Stream Deck: what Stream Deck runs (node plugin.js -port … -pluginUUID … -registerEvent … -info …).
// The logic is in core.js.
import { run, parseArgs } from "./core.js";

const args = parseArgs(process.argv.slice(2));
if (!args.port || !args.pluginUUID || !args.registerEvent) { console.error("Start this from Stream Deck (it passes -port, -pluginUUID and -registerEvent)."); process.exit(1); }
run(args, { log: m => console.log(`[tempolight] ${m}`) });
