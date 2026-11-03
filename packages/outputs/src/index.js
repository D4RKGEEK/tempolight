// @tempolight/outputs: send light to WLED controllers. Node built-ins only.
export { ddpPackets, DDPSender, DDP_PORT, DDP_MAX_DATA, DDP_FLAGS_VER1, DDP_FLAGS_PUSH, DDP_TYPE_RGB24 } from "./ddp.js";
export { getInfo, segmentsBody, setSegments, setState } from "./wled.js";
export { audioSyncPacket, AudioSyncSender, AUDIOSYNC_PORT, AUDIOSYNC_GROUP } from "./audiosync.js";
