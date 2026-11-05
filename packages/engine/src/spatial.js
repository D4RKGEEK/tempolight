// Stereo spatial accent: on a hit, the side of the room the sound came from (the left or right of the room layout)
// brightens and the other side dims by as much, so the room's overall brightness stays the same. Needs a stereo source
// (the view's `pan` -1..1 and `lr` levels, live.js) and a room with some width; otherwise it does nothing (and costs
// nothing). Pure JavaScript, no I/O.

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
/** How far a hit leans the room at pan ±1: "subtle" ±55%, "strong" ±100% at the far ends (as the hit fades). */
export const STEREO_AMOUNT = { off: 0, subtle: 0.55, strong: 1 };

/** @param {{N:number, PX?:Float32Array}} layout */
export function createSpatial(layout) {
  const N = layout.N, PX = layout.PX, U = new Float32Array(N);
  let x0 = Infinity, x1 = -Infinity; if (PX) for (let i = 0; i < N; i++) { x0 = Math.min(x0, PX[i]); x1 = Math.max(x1, PX[i]); }
  const wide = !!PX && N > 1 && x1 - x0 >= 0.2; // (PX: room units, 1 = the room's height) a single upright strip has no left and right
  if (wide) for (let i = 0; i < N; i++) U[i] = 2 * (PX[i] - x0) / (x1 - x0) - 1;
  const st = { wide, lean: 0, kick: null, pan: 0, hold: 0, t: null };
  /**
   * @param {Float32Array} COL linear RGB, N*3, changed in place @param {object} V the view (pan, lr, kick, kickS)
   * @param {number} t music clock @param {"off"|"subtle"|"strong"} mode
   */
  function apply(COL, V, t, mode) {
    st.lean = 0;
    if (!wide || !V || !V.lr || typeof V.pan !== "number" || !(STEREO_AMOUNT[mode] > 0)) return;
    // the hit's side: the most one-sided balance heard lately (held ~150 ms: the balance is of the sound now, the kick
    // can be reported a few frames after it), and around the kick, kept while the hit fades
    const p = clamp(V.pan, -1, 1), dt = Math.max(0, Math.min(0.1, t - (st.t ?? t))); st.t = t; st.hold *= Math.exp(-dt / 0.15); if (Math.abs(p) > Math.abs(st.hold)) st.hold = p;
    const ka = t - V.kick; if (!(ka >= 0 && ka < 0.6)) return;
    if (st.kick == null || Math.abs(V.kick - st.kick) > 0.1) { st.kick = V.kick; st.pan = st.hold; } // (a predicted kick moves a little with the beat grid)
    if (ka < 0.15 && Math.abs(st.hold) > Math.abs(st.pan)) st.pan = st.hold;
    const hit = Math.exp(-ka / 0.2);
    const a = STEREO_AMOUNT[mode] * hit * st.pan; if (Math.abs(a) < 0.002) return;
    st.lean = a;
    // scaled as the light looks (after the LEDs' roll-off, as the director's seen()), so a bright drop still leans
    for (let i = 0; i < N; i++) { const g = 1 + a * U[i]; for (let j = i * 3; j < i * 3 + 3; j++) { const v = COL[j]; if (!(v > 0)) continue;
      const q = Math.min(0.985, (1 - Math.exp(-1.28 * v)) * g); COL[j] = -Math.log(1 - q) / 1.28; } }
  }
  return { apply, state: st };
}
