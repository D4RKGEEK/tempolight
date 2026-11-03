# WLED protocols Tempolight uses

| Protocol | Port | Used for | Notes |
| --- | --- | --- | --- |
| DDP | UDP 4048 | Streaming pixels | Header: flags `0x40` (version 1), `0x41` on the last packet of a frame (push); sequence 1-15; type `0x0B` (RGB, 8 bits); id 1; 32-bit byte offset; 16-bit length; up to 1,440 bytes (480 pixels) per packet |
| JSON API | HTTP 80 | Device info, segments, presets, power | `GET /json/info`, `POST /json/state`. Segment `stop` is exclusive |
| Audio sync | UDP 11988, multicast 239.0.0.1 | Letting WLED's own audio effects react | 44-byte "V2" packet, header `00002`: raw and smoothed level, peak flag, 16 frequency bands (0-255), magnitude, loudest frequency |
| mDNS | UDP 5353 | Finding controllers | WLED announces `_wled._tcp`; Tempolight also scans the local /24 for `/json/info` |
| OSC | UDP 9000 (configurable) | Control from lighting desks, TouchOSC, Companion | Input only; addresses under `/tempolight/` |
| E1.31 / Art-Net | UDP 5568 / 6454 | Lighting-desk compatibility | Planned |

When a stream stops, WLED waits a few seconds and then returns to its own effect, so Tempolight can hand a room
back to WLED's presets (for example at night) simply by stopping.
