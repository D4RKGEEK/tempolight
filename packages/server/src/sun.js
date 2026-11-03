// Sunrise and sunset for a place and day (NOAA's simplified solar equations, accurate to about a minute), so schedules
// can say "at sunset" or "30 minutes before sunrise". Works offline: only latitude and longitude are needed.
const rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;

/** @returns {{sunrise: Date|null, sunset: Date|null}} null when the sun doesn't rise or set that day (polar day/night) */
export function sunTimes(date, lat, lon) {
  const d0 = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), 12) / 86400000 + 2440587.5; // Julian day at local noon-ish
  const n = Math.round(d0 - 2451545.0 - 0.0009 + lon / 360 * -1), Jstar = 2451545.0 + 0.0009 - lon / 360 + n; // mean solar noon (east is positive)
  const M = (357.5291 + 0.98560028 * (Jstar - 2451545)) % 360, C = 1.9148 * Math.sin(rad(M)) + 0.02 * Math.sin(rad(2 * M)) + 0.0003 * Math.sin(rad(3 * M));
  const L = (M + C + 180 + 102.9372) % 360, Jtransit = Jstar + 0.0053 * Math.sin(rad(M)) - 0.0069 * Math.sin(rad(2 * L));
  const decl = Math.asin(Math.sin(rad(L)) * Math.sin(rad(23.44)));
  const cosH = (Math.sin(rad(-0.833)) - Math.sin(rad(lat)) * Math.sin(decl)) / (Math.cos(rad(lat)) * Math.cos(decl));
  if (cosH > 1 || cosH < -1) return { sunrise: null, sunset: null };
  const H = deg(Math.acos(cosH)), toDate = j => new Date((j - 2440587.5) * 86400000);
  return { sunrise: toDate(Jtransit - H / 360), sunset: toDate(Jtransit + H / 360) };
}

/** "18:30" stays as it is; "sunset", "sunrise-15", "sunset+30" become a clock time for that day (null if unknown). */
const cache = new Map();
export function resolveTime(time, date, loc) {
  const m = /^(sunrise|sunset)([+-]\d{1,3})?$/.exec(String(time || ""));
  if (!m) return time;
  if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lon)) return null;
  const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}|${loc.lat}|${loc.lon}`; // the same day is asked about every minute
  let day = cache.get(key); if (!day) { day = sunTimes(date, loc.lat, loc.lon); if (cache.size > 64) cache.clear(); cache.set(key, day); }
  const t = day[m[1]]; if (!t) return null;
  const at = new Date(t.getTime() + (Number(m[2]) || 0) * 60000);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

/** Is the clock inside a from-to window (which may cross midnight)? Times as in resolveTime. */
export function inWindow(from, to, date, loc) {
  const a = resolveTime(from, date, loc), b = resolveTime(to, date, loc); if (!a || !b) return false;
  const m = t => { const [h, mi] = t.split(":").map(Number); return h * 60 + mi; }, now = date.getHours() * 60 + date.getMinutes(), x = m(a), y = m(b);
  return x <= y ? now >= x && now < y : now >= x || now < y;
}
