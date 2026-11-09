// Rule-based layout generator. No AI involved. Used when no model is configured, when the circuit breaker
// is open, or as a fallback. Produces single-storey plans in three arrangements (A, B, C).
import { RULES, snap } from '../domain/plan.js';

const PASSAGE_D = 1.2;
const BASE = {
  main: { w: 4.0, d: 3.6 },
  bedroom: { w: 3.2, d: 3.0 },
  bathroom: { w: 2.4, d: 2.0 },
  ensuite: { w: 2.0, d: 2.0 },
  kitchen: { w: 3.6, d: 3.2 },
  dining: { w: 3.4, d: 3.2 },
  living: { w: 5.0, d: 4.2 },
  garageDepth: 6.0,
};

function room(id, type, name, w, d, windows, extDoors = []) {
  return {
    id, type, name, level: 0, w, d,
    windows,
    doors: [{ wall: 'internal', width: 0.8, kind: 'internal' }, ...extDoors],
  };
}

// Builds the two strips of rooms for the brief. variant controls ordering.
function rooms(brief, variant) {
  const priv = [];
  priv.push(room('bed1', 'bedroom', 'Main bedroom', BASE.main.w, BASE.main.d, [{ wall: 'N', width: 1.5 }]));
  if (brief.bathrooms >= 2) priv.push(room('ens1', 'ensuite', 'En-suite', BASE.ensuite.w, BASE.ensuite.d, [{ wall: 'N', width: 0.6 }]));
  const general = Math.max(1, brief.bathrooms - (brief.bathrooms >= 2 ? 1 : 0));
  for (let i = 2; i <= brief.bedrooms; i++) priv.push(room(`bed${i}`, 'bedroom', `Bedroom ${i}`, BASE.bedroom.w, BASE.bedroom.d, [{ wall: 'N', width: 1.2 }]));
  for (let i = 1; i <= general; i++) priv.push(room(`bath${i}`, 'bathroom', general > 1 ? `Bathroom ${i}` : 'Bathroom', BASE.bathroom.w, BASE.bathroom.d, [{ wall: 'N', width: 0.6 }]));

  let pub;
  if (variant === 'C') {
    // Open-plan kitchen, dining and living in one space.
    pub = [room('open', 'living', 'Open-plan living', BASE.living.w + BASE.kitchen.w + 1.0, BASE.living.d,
      [{ wall: 'S', width: 2.4 }, { wall: 'S', width: 1.5 }], [{ wall: 'S', width: 0.9, kind: 'external' }])];
  } else {
    pub = [
      room('kit', 'kitchen', 'Kitchen', BASE.kitchen.w, BASE.kitchen.d, [{ wall: 'S', width: 1.2 }], [{ wall: 'S', width: 0.9, kind: 'external' }]),
      room('din', 'dining', 'Dining', BASE.dining.w, BASE.dining.d, [{ wall: 'S', width: 1.5 }]),
      room('liv', 'living', 'Living', BASE.living.w, BASE.living.d, [{ wall: 'S', width: 2.4 }], [{ wall: 'S', width: 0.9, kind: 'external' }]),
    ];
  }
  if (brief.garageCars > 0) {
    // One 2.5 m door per car.
    const g = room('gar', 'garage', 'Garage', RULES.garageWidthPerCarM * brief.garageCars, BASE.garageDepth, [],
      Array.from({ length: brief.garageCars }, () => ({ wall: 'S', width: 2.5, kind: 'garage' })));
    if (variant === 'B') pub.push(g);
    else pub.unshift(g);
  }
  if (variant === 'B') priv.reverse();
  return { priv, pub };
}

function scaleRoom(r, s) {
  if (r.type === 'garage') return { ...r }; // cars do not shrink
  let w = snap(r.w * s);
  let d = snap(r.d * s);
  if (r.type === 'bedroom') {
    w = Math.max(w, RULES.minBedroomSideM);
    d = Math.max(d, RULES.minBedroomSideM);
    if (w * d < RULES.minBedroomAreaM2) w = snap(Math.ceil((RULES.minBedroomAreaM2 / d) / 0.05) * 0.05);
  }
  return { ...r, w, d };
}

// Lays strips out top to bottom: private rooms, passage, public rooms. Stretches rooms to full strip depth and
// the last room of each strip to the full width, so the footprint is a clean rectangle.
function layout(strips, setback) {
  const sum = (list) => list.reduce((s, r) => s + r.w, 0);
  const width = snap(Math.max(sum(strips.priv), sum(strips.pub)));
  const out = [];
  let y = setback;
  const placeStrip = (list) => {
    const depth = Math.max(...list.map((r) => r.d));
    let x = setback;
    list.forEach((r, i) => {
      const w = i === list.length - 1 ? snap(setback + width - x) : r.w;
      out.push({ ...r, rect: { x: snap(x), y: snap(y), w, d: depth } });
      x += w;
    });
    y += depth;
  };
  placeStrip(strips.priv);
  out.push({ id: 'pass', type: 'passage', name: 'Passage', level: 0, rect: { x: setback, y: snap(y), w: snap(width), d: PASSAGE_D }, windows: [], doors: [] });
  y += PASSAGE_D;
  placeStrip(strips.pub);
  return { rooms: out, width, depth: y - setback };
}

const totalArea = (strips) => [...strips.priv, ...strips.pub].reduce((s, r) => s + r.w * r.d, 0);

export function templateLayout(brief, variant) {
  const plotW = brief.plot.widthM;
  const plotD = brief.plot.depthM;
  const base = rooms(brief, variant);
  const target = brief.floorAreaM2 * (variant === 'B' ? 1.05 : variant === 'C' ? 0.97 : 1);
  let s = Math.sqrt(target / (totalArea(base) + 15));
  let best = null;

  // Adjust the scale until the floor area is close to the target and the house fits the plot.
  // Rooms never shrink below the bedroom minimums, so small targets may stay a little above target.
  for (let attempt = 0; attempt < 16; attempt++) {
    s = Math.min(1.5, Math.max(0.55, s));
    const strips = { priv: base.priv.map((r) => scaleRoom(r, s)), pub: base.pub.map((r) => scaleRoom(r, s)) };
    const placed = layout(strips, RULES.setbackM);
    const area = placed.width * placed.depth;
    const fits = placed.width + 2 * RULES.setbackM <= plotW + 1e-6 && placed.depth + 2 * RULES.setbackM <= plotD + 1e-6
      && area / (plotW * plotD) <= RULES.maxCoverage;
    const error = Math.abs(area - target) / target;
    if (fits && (!best || error < best.error)) best = { error, rooms: placed.rooms };
    if (fits && error <= 0.05) break;
    const next = fits ? s * Math.sqrt(target / area) : s * 0.94;
    if (Math.abs(next - s) < 0.002) break;
    s = next;
  }
  return best ? toSpec(brief, best.rooms) : null; // null: brief does not fit the plot
}

function toSpec(brief, placed) {
  return {
    units: 'm',
    plot: { w: brief.plot.widthM, d: brief.plot.depthM },
    storeys: 1,
    style: brief.style,
    roof: { type: brief.style === 'minimalist' || brief.style === 'modern' ? 'mono' : 'pitched', pitchDeg: brief.style === 'modern' ? 10 : 26 },
    rooms: placed.map((r) => ({
      id: r.id, type: r.type, name: r.name, level: 0, rect: r.rect,
      windows: r.windows,
      // internal doors open onto the passage, which is S of private rooms and N of public rooms
      doors: r.doors.map((d) => (d.wall === 'internal' ? { ...d, wall: r.rect.y < placed.find((p) => p.id === 'pass').rect.y ? 'S' : 'N' } : d)),
    })),
  };
}

export function createTemplateProvider() {
  return {
    name: 'template',
    model: 'rules-v1',
    async proposeOptions(brief) {
      return ['A', 'B', 'C'].map((label) => ({ label, spec: templateLayout(brief, label) }));
    },
  };
}
