// Auto-generated shows: a song's analysis becomes a timeline of effects, one per section (a few bars), picked from
// the style's pools (build-ups get build effects, drops the big ones). The same song always gets the same show,
// and each block can be changed by hand; the director then plays the timeline instead of choosing on the fly.

function hashStr(s) { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return h; }

/**
 * @param {{bars:{t0:number,t1:number,state:string,level:number}[], style:string, dur:number}} pre a song analysis
 * @param {{pools:object, styles:object}} fx from createEffects()
 * @param {{seed?:string, prefs?:Record<string,number>, barsPer?:number}} [o]
 * @returns {{t0:number, t1:number, part:string, effect:string}[]}
 */
export function planShow(pre, fx, o = {}) {
  const ST = fx.styles[pre.style] || fx.styles.party, prefs = o.prefs || {}, per = o.barsPer || 8, seed = hashStr(o.seed || "");
  const pool = key => { let p = (ST.pools[key] || ST.pools.calm || ST.pools.low || []).filter(id => prefs[id] !== -1); if (!p.length) p = ST.pools[key] || [];
    const liked = p.filter(id => prefs[id] === 1); return liked.length ? [...liked, ...p.filter(id => prefs[id] !== 1)] : p; };
  const keyOf = b => ST.mode === "sections" ? (b.state === "silent" ? "calm" : b.state) : b.level < 0.35 ? "low" : b.level < 0.72 ? "mid" : "peak";
  const out = [], used = {}; let i = 0;
  const bars = pre.bars || [];
  while (i < bars.length) {
    const k = keyOf(bars[i]); let j = i; while (j + 1 < bars.length && keyOf(bars[j + 1]) === k && j + 1 - i < (k === "drop" || k === "peak" ? per / 2 : per)) j++;
    const p = pool(k), n = used[k] = (used[k] ?? (seed % Math.max(1, p.length))) ; let eff = p[n % p.length]; used[k] = n + 1;
    if (out.length && out.at(-1).effect === eff && p.length > 1) { eff = p[(n + 1) % p.length]; used[k] = n + 2; }
    const part = bars[i].state;
    if (out.length && out.at(-1).effect === eff && out.at(-1).part === part) out.at(-1).t1 = bars[j].t1; // merge repeats
    else out.push({ t0: Math.round(bars[i].t0 * 1000) / 1000, t1: Math.round(bars[j].t1 * 1000) / 1000, part, effect: eff });
    i = j + 1;
  }
  if (out.length) { out[0].t0 = 0; out.at(-1).t1 = Math.max(out.at(-1).t1, pre.dur); }
  return out;
}

/** The block of a show at time t (binary search), or null. */
export function showAt(plan, t) { let lo = 0, hi = plan.length - 1; while (lo <= hi) { const m = (lo + hi) >> 1; if (plan[m].t1 <= t) lo = m + 1; else if (plan[m].t0 > t) hi = m - 1; else return plan[m]; } return null; }
