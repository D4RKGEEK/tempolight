// Schedules: "every weekday at 18:30 switch to the Chill scene", "every night at 01:00 turn off", "at sunset".
import { resolveTime } from "./sun.js";
// Times are the computer's local time (set TZ to change it). Checked every 10 seconds; each schedule runs at most
// once per minute it matches, and a missed minute (computer asleep) is not replayed later.

/** Does schedule `s` fire at Date `d`? */
export function due(s, d, loc) {
  if (!s.enabled) return false;
  const time = resolveTime(s.time, d, loc); if (!time) return false;
  const [hh, mm] = String(time).split(":").map(Number);
  if (!(hh >= 0 && hh < 24 && mm >= 0 && mm < 60)) return false;
  const days = s.days && s.days.length ? s.days : [0, 1, 2, 3, 4, 5, 6];
  return d.getHours() === hh && d.getMinutes() === mm && days.includes(d.getDay());
}

/** When does a schedule next fire, from `from`? (for the UI) */
export function nextRun(s, from = new Date(), loc) {
  if (!s.enabled) return null;
  const d = new Date(from); d.setSeconds(0, 0); d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 8 * 24 * 60; i++) { if (due(s, d, loc)) return d; d.setMinutes(d.getMinutes() + 1); }
  return null;
}

export function startScheduler(getSchedules, run, now = () => new Date(), getLoc = () => null) {
  const lastRun = new Map();
  const tick = () => {
    const d = now(), key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()} ${d.getHours()}:${d.getMinutes()}`;
    for (const s of getSchedules()) if (due(s, d, getLoc()) && lastRun.get(s.id) !== key) { lastRun.set(s.id, key); try { run(s); } catch (e) { console.warn(`Schedule "${s.name}": ${e.message}`); } }
  };
  const timer = setInterval(tick, 10_000); tick();
  return { tick, stop: () => clearInterval(timer) };
}
