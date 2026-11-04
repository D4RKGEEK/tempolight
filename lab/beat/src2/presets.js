// Room presets: ready-made layouts on the 16 x 9 wall view. Each preset is built for the user's actual controllers:
// shapes are spread over the devices, and LED counts are scaled so each controller's shapes add up to its LED count.
// Everything can be edited afterwards on the Room page (shape, position, which LEDs, direction).

const mk = (type, o) => Object.assign({ type, count: 60, rot: 0, start: 0, rev: false, from: null }, o);
const CEIL_U = [[0.1, 0.06], [3.75, 1.66], [12.25, 1.66], [15.9, 0.06]];
const honey = (cx, cy, r, rows, slot, base) => {
  const out = [], dx = Math.sqrt(3) * r * 1.04, dy = 1.5 * r * 1.04; let n = 0;
  rows.forEach((cnt, ri) => { for (let k = 0; k < cnt; k++) out.push(mk("hex", { name: `${base} ${++n}`, count: 24, cx: cx + (k - (cnt - 1) / 2) * dx, cy: cy + (ri - (rows.length - 1) / 2) * dy, size: r, slot })); });
  return out;
};

const P = {
  strips: { name: "One strip per controller", desc: "Each controller is a straight strip, stacked up the wall. The simplest start.", slots: 0,
    shapes: devs => devs.map((d, i) => { const y = devs.length === 1 ? 4.5 : 1 + i * (7 / Math.max(1, devs.length - 1)); return mk("line", { name: d.name || `Strip ${i + 1}`, count: d.leds || 60, pts: [[1, y], [15, y]], slot: i }); }) },
  fourwalls: { name: "One strip around four walls", desc: "A single strip along the left, back, right and front walls, split into four segments.", slots: 1,
    shapes: () => [
      mk("line", { name: "Left wall", count: 100, pts: [[0.1, 0.06], [3.75, 1.66]], slot: 0 }),
      mk("line", { name: "Back wall", count: 200, pts: [[3.75, 1.66], [12.25, 1.66]], slot: 0 }),
      mk("line", { name: "Right wall", count: 100, pts: [[12.25, 1.66], [15.9, 0.06]], slot: 0 }),
      mk("line", { name: "Front wall", count: 200, pts: [[15.9, 0.14], [0.1, 0.14]], slot: 0 })] },
  tv: { name: "TV backlight", desc: "A frame behind the TV, plus floor-lamp poles on a second controller if you have one.", slots: 2,
    shapes: () => [
      mk("rect", { name: "TV backlight", count: 110, cx: 8, cy: 3.6, w: 3.3, h: 1.85, size: 3.3, slot: 0 }),
      mk("pole", { name: "Lamp left", count: 45, pts: [[3.98, 5.85], [3.98, 1.9]], slot: 1 }),
      mk("pole", { name: "Lamp right", count: 45, pts: [[12.02, 5.85], [12.02, 1.9]], slot: 1 })] },
  desk: { name: "Gaming desk", desc: "Ceiling cove, three monitors, desk edge, light bars and hexagon panels.", slots: 3,
    shapes: () => [
      mk("free", { name: "Ceiling cove", count: 200, pts: CEIL_U.map(p => p.slice()), slot: 0 }),
      mk("rect", { name: "Main monitor", count: 90, cx: 8, cy: 3.85, w: 2.6, h: 1.5, size: 2.6, slot: 1 }),
      mk("rect", { name: "Left monitor", count: 70, cx: 5.35, cy: 3.95, w: 2.0, h: 1.2, size: 2.0, slot: 1 }),
      mk("rect", { name: "Right monitor", count: 70, cx: 10.65, cy: 3.95, w: 2.0, h: 1.2, size: 2.0, slot: 1 }),
      mk("line", { name: "Desk edge", count: 120, pts: [[4.1, 5.15], [11.9, 5.15]], slot: 1 }),
      mk("pole", { name: "Light bar left", count: 40, pts: [[3.98, 5.85], [3.98, 2.0]], slot: 1 }),
      mk("pole", { name: "Light bar right", count: 40, pts: [[12.02, 5.85], [12.02, 2.0]], slot: 1 }),
      ...honey(8, 2.3, 0.26, [3, 4], 2, "Hex")] },
  bedroom: { name: "Bedroom", desc: "Ceiling strip, headboard frame, under-bed glow, bedside lamps and a moon ring.", slots: 2,
    shapes: () => [
      mk("line", { name: "Ceiling, back wall", count: 160, pts: [[3.75, 1.66], [12.25, 1.66]], slot: 0 }),
      mk("rect", { name: "Headboard", count: 120, cx: 8, cy: 4.55, w: 4.2, h: 1.1, size: 4.2, slot: 0 }),
      mk("line", { name: "Under the bed", count: 90, pts: [[5.6, 5.8], [10.4, 5.8]], slot: 0 }),
      mk("pole", { name: "Lamp left", count: 24, pts: [[4.7, 5.85], [4.7, 4.3]], slot: 1 }),
      mk("pole", { name: "Lamp right", count: 24, pts: [[11.3, 5.85], [11.3, 4.3]], slot: 1 }),
      mk("circle", { name: "Moon ring", count: 60, cx: 10.9, cy: 2.75, size: 0.62, slot: 1 })] },
  living: { name: "Living room", desc: "Ceiling cove, TV frame, ring light, square frame, hexagons, poles and a floor strip.", slots: 3,
    shapes: () => [
      mk("free", { name: "Ceiling cove", count: 200, pts: CEIL_U.map(p => p.slice()), slot: 0 }),
      mk("rect", { name: "TV backlight", count: 110, cx: 8, cy: 3.6, w: 3.3, h: 1.85, size: 3.3, slot: 1 }),
      mk("circle", { name: "Ring light", count: 60, cx: 5.1, cy: 3.3, size: 0.75, slot: 1 }),
      mk("rect", { name: "Square frame", count: 60, cx: 10.9, cy: 3.3, w: 1.4, h: 1.4, size: 1.4, slot: 1 }),
      mk("hex", { name: "Hexagon 1", count: 30, cx: 7.4, cy: 2.25, size: 0.3, slot: 2 }),
      mk("hex", { name: "Hexagon 2", count: 30, cx: 8.0, cy: 2.25, size: 0.3, slot: 2 }),
      mk("hex", { name: "Hexagon 3", count: 30, cx: 8.6, cy: 2.25, size: 0.3, slot: 2 }),
      mk("pole", { name: "Pole left", count: 45, pts: [[3.98, 5.85], [3.98, 1.9]], slot: 1 }),
      mk("pole", { name: "Pole right", count: 45, pts: [[12.02, 5.85], [12.02, 1.9]], slot: 1 }),
      mk("line", { name: "Floor strip", count: 100, pts: [[3.85, 5.86], [12.15, 5.86]], slot: 1 })] },
  matrix: { name: "LED matrix", desc: "A matrix panel (serpentine wiring) with a floor strip and poles on a second controller.", slots: 2, fixedFirst: true,
    shapes: devs => { const n = devs[0]?.leds || 256, cols = n === 256 ? 16 : Math.max(4, Math.round(Math.sqrt(n * 2))), rows = Math.max(1, Math.floor(n / cols));
      return [mk("matrix", { name: "Matrix", cx: 8, cy: 3.5, cols, rows, w: Math.min(9, cols * 0.2), h: Math.min(4.5, rows * 0.2), slot: 0 }),
        mk("line", { name: "Floor strip", count: 100, pts: [[3.85, 5.86], [12.15, 5.86]], slot: 1 }),
        mk("pole", { name: "Pole left", count: 45, pts: [[3.98, 5.85], [3.98, 1.9]], slot: 1 }),
        mk("pole", { name: "Pole right", count: 45, pts: [[12.02, 5.85], [12.02, 1.9]], slot: 1 })]; } },
  club: { name: "Club / stage", desc: "Ceiling cove, six poles, two big rings, a triangle and a DJ booth front.", slots: 4,
    shapes: () => [
      mk("free", { name: "Ceiling cove", count: 200, pts: CEIL_U.map(p => p.slice()), slot: 0 }),
      ...[4.3, 5.8, 7.3, 8.7, 10.2, 11.7].map((x, i) => mk("pole", { name: `Pole ${i + 1}`, count: 40, pts: [[x, 5.85], [x, 2.1]], slot: i < 3 ? 1 : 2 })),
      mk("circle", { name: "Big ring left", count: 72, cx: 6.55, cy: 3.2, size: 0.62, slot: 1 }),
      mk("circle", { name: "Big ring right", count: 72, cx: 9.45, cy: 3.2, size: 0.62, slot: 2 }),
      mk("tri", { name: "Triangle", count: 54, cx: 8, cy: 2.75, size: 0.55, slot: 3 }),
      mk("line", { name: "DJ booth front", count: 90, pts: [[6.2, 5.0], [9.8, 5.0]], slot: 3 })] },
  rings: { name: "Rings and panels", desc: "Each controller is a ring, laid out in a row (light rings, round panels, fans).", slots: 0,
    shapes: devs => devs.map((d, i) => mk("circle", { name: d.name || `Ring ${i + 1}`, count: d.leds || 24, cx: 8 + (i - (devs.length - 1) / 2) * Math.min(3, 13 / Math.max(1, devs.length)), cy: 3.5, size: Math.min(1.2, 6 / Math.max(1, devs.length)), slot: i })) },
};

export const ROOM_PRESETS = Object.fromEntries(Object.entries(P).map(([id, p]) => [id, { id, name: p.name, desc: p.desc }]));

/**
 * Build a preset for these controllers.
 * @param {string} id preset id
 * @param {{id:string, name?:string, leds?:number}[]} devices
 */
export function buildPreset(id, devices) {
  const p = P[id] || P.strips, devs = devices.length ? devices : [{ id: "dev1", name: "WLED", leds: 300 }];
  const shapes = p.shapes(devs);
  // slot -> device; the slots of a preset wrap around when there are fewer controllers than slots
  for (const s of shapes) { s.dev = devs[s.slot % devs.length].id; delete s.slot; }
  // controllers the preset has no place for still get a strip along the floor, so nothing goes dark
  const spare = devs.filter(d => !shapes.some(s => s.dev === d.id));
  spare.forEach((d, i) => { const y = 8.6 - i * 0.35; shapes.push(mk("line", { name: d.name || "Strip", count: d.leds || 60, pts: [[1, y], [15, y]], dev: d.id })); });
  // fit LED counts to each controller (a matrix keeps its grid)
  for (const d of devs) {
    const mine = shapes.filter(s => s.dev === d.id); if (!d.leds || !mine.length) continue;
    const fixed = mine.filter(s => s.type === "matrix").reduce((a, s) => a + s.cols * s.rows, 0), flex = mine.filter(s => s.type !== "matrix");
    const want = Math.max(flex.length, d.leds - fixed), have = flex.reduce((a, s) => a + s.count, 0); if (!have) continue;
    let used = 0; flex.forEach((s, i) => { s.count = i === flex.length - 1 ? Math.max(1, want - used) : Math.max(1, Math.round(s.count * want / have)); used += s.count; });
  }
  return shapes;
}
