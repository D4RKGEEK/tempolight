# How Tempolight hears your music

Tempolight finds the beat by listening, so it has to hear the music once per new song (learned songs then sync
exactly). Three ways, from easiest:

- **Raspberry Pi / Linux:** Music → *Listen on the server* picks the computer's own sound automatically.
- **Microphone:** Music → *Listen with a microphone*, allow it, play the music out loud. Keep the tab open.
- **This Mac's sound (BlackHole):** install BlackHole 2ch (`brew install blackhole-2ch`), make a Multi-Output Device
  with your speakers (or Bluetooth speaker) + BlackHole in Audio MIDI Setup, set it as the Mac's output, then choose
  BlackHole in Music → *Listen on the server*. With a Bluetooth speaker, run Music → Timing → *Fix the timing
  automatically* once.

A full step-by-step guide with the guided setup is on its way.
