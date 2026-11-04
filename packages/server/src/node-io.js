// The real network and sound-card access for the runtime when Tempolight runs on a PC or Raspberry Pi.
import os from "node:os";
import { readFileSync } from "node:fs";
export { DDPSender, E131Sender, GoveeSender, discoverGovee, OpenRGBSender, listOpenRGB, NanoleafSender, nanoleafPair, nanoleafInfo, panelPoints, HueSender, huePair, hueLights, AudioSyncSender, getInfo, setState, setSegments, ipOf, discoverWled } from "../../outputs/src/index.js";
export { startCapture, listSources, splitCommand, RATE } from "./capture.js";

const readText = f => { try { return readFileSync(f, "utf8"); } catch { return ""; } };
/** What the performance mode needs to know about this computer (see perf.js weakHost). */
export function hostInfo() {
  return { cpus: os.cpus().map(c => ({ model: c.model, speed: c.speed })), arch: process.arch,
    model: process.platform === "linux" ? readText("/proc/device-tree/model") : "", cpuinfo: process.platform === "linux" ? readText("/proc/cpuinfo") : "" };
}
