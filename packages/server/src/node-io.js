// The real network and sound-card access for the runtime when Tempolight runs on a PC or Raspberry Pi.
export { DDPSender, E131Sender, AudioSyncSender, getInfo, setState, setSegments, ipOf, discoverWled } from "../../outputs/src/index.js";
export { startCapture, listSources, splitCommand, RATE } from "./capture.js";
