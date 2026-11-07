// A canned answer from the Claude show designer for the synthetic EDM song (synth.js edm(): 18 bars at 128 BPM,
// sections A B (calm) C D (build) E (drop, bars 8-15) A (calm), one drop at bar 8). Used by the engine and server tests;
// no test ever calls the real API.
export const EDM_DESIGN = {
  why: "Hold the room in deep blue while the track circles, warm it through the build, blow it open in neon on the drop, then close the circle in blue.",
  main: "flow",
  drop: "shock",
  sections: [
    { i: 0, arc: "hold", drop: false, palette: "ocean", reason: "A quiet minor-key opening: deep blue, slow motion, energy saved for later." },
    { i: 1, arc: "hold", drop: false, palette: "ocean", reason: "Still holding back." },
    { i: 2, arc: "build", drop: false, palette: "fire", reason: "The build starts: warmer colours, rising brightness." },
    { i: 3, arc: "build", drop: false, palette: "fire", reason: "Pushing hard toward the drop." },
    { i: 4, arc: "full", drop: true, palette: "neon", reason: "The drop: full energy, a shockwave on every kick." },
    { i: 5, arc: "breakdown", drop: false, palette: "ocean", reason: "Back to the opening blue, dimmer than before." },
  ],
  moments: [
    { bar: 7, type: "blackout", beats: 1, reason: "A beat of darkness as the last bar of the build begins." },
    { bar: 8, type: "strobe", beats: 2, reason: "The drop lands." },
    { bar: 16, type: "fade", beats: 8, reason: "Let the outro fade away." },
  ],
};

/** A Messages API answer around a text (as api.anthropic.com sends it). */
export const answer = (text, o = {}) => ({ id: "msg_test", type: "message", role: "assistant", model: o.model || "claude-sonnet-5-5", stop_reason: o.stop || "end_turn",
  content: [...(o.thinking ? [{ type: "thinking", thinking: "Let me think about the arc.", signature: "x" }] : []), { type: "text", text }], usage: { input_tokens: 2700, output_tokens: 480 } });
