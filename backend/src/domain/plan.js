// Floor-plan contract, geometry and building-rule checks. Pure functions, no I/O.
// "The AI proposes; deterministic code verifies": nothing from a model is trusted until it passes here.

export const RULES_VERSION = 'rules-2026.11-sample';
export const ROOM_TYPES = ['bedroom', 'bathroom', 'ensuite', 'kitchen', 'living', 'dining', 'garage', 'laundry', 'study', 'passage'];
export const WALLS = ['N', 'S', 'E', 'W'];
export const STYLES = ['modern', 'contemporary', 'farmhouse', 'tuscan', 'minimalist', 'traditional'];
export const FINISHES = ['basic', 'standard', 'premium'];

// SAMPLE rule values. They must be confirmed against SANS 10400 and the local municipality before launch.
export const RULES = Object.freeze({
  setbackM: 1.0,
  maxCoverage: 0.6,
  maxStoreys: 2,
  minBedroomAreaM2: 9,
  minBedroomSideM: 2.5,
  minRoomSideM: 1.0,
  garageWidthPerCarM: 3.0,
  garageMinDepthM: 5.5,
});

const EPS = 1e-6;
// Round to 5 cm. Dividing by 20 (not multiplying by 0.05) keeps results like 3.8 exact.
export const snap = (v) => Math.round(v * 20) / 20;
const r2 = (v) => Math.round(v * 100) / 100;

// ---------- Brief ----------
export const BRIEF_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    bedrooms: { type: 'integer', minimum: 1, maximum: 8 },
    bathrooms: { type: 'integer', minimum: 1, maximum: 6 },
    floorAreaM2: { type: 'number', minimum: 30, maximum: 1000 },
    plot: {
      type: 'object', additionalProperties: false, required: ['widthM', 'depthM'],
      properties: { widthM: { type: 'number', minimum: 5, maximum: 200 }, depthM: { type: 'number', minimum: 5, maximum: 200 } },
    },
    storeys: { type: 'integer', minimum: 1, maximum: 2 },
    garageCars: { type: 'integer', minimum: 0, maximum: 4 },
    style: { type: 'string', enum: STYLES },
    finishLevel: { type: 'string', enum: FINISHES },
    notes: { type: 'string', maxLength: 1000 },
  },
};

export function normaliseBrief(input = {}) {
  return {
    bedrooms: input.bedrooms ?? 3,
    bathrooms: input.bathrooms ?? 2,
    floorAreaM2: input.floorAreaM2 ?? 150,
    plot: { widthM: input.plot?.widthM ?? 20, depthM: input.plot?.depthM ?? 30 },
    storeys: input.storeys ?? 1,
    garageCars: input.garageCars ?? 1,
    style: input.style ?? 'modern',
    finishLevel: input.finishLevel ?? 'standard',
    notes: (input.notes ?? '').slice(0, 1000),
  };
}

// ---------- PlanSpec (what a model must return) ----------
const RECT = {
  type: 'object', additionalProperties: false, required: ['x', 'y', 'w', 'd'],
  properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, d: { type: 'number' } },
};
export const PLAN_SPEC_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['units', 'plot', 'storeys', 'style', 'roof', 'rooms'],
  properties: {
    units: { type: 'string', enum: ['m'] },
    plot: { type: 'object', additionalProperties: false, required: ['w', 'd'], properties: { w: { type: 'number' }, d: { type: 'number' } } },
    storeys: { type: 'integer', minimum: 1, maximum: 2 },
    style: { type: 'string' },
    roof: {
      type: 'object', additionalProperties: false, required: ['type', 'pitchDeg'],
      properties: { type: { type: 'string', enum: ['pitched', 'mono', 'flat'] }, pitchDeg: { type: 'number', minimum: 0, maximum: 45 } },
    },
    rooms: {
      type: 'array', minItems: 2, maxItems: 40,
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'type', 'name', 'level', 'rect', 'windows', 'doors'],
        properties: {
          id: { type: 'string', maxLength: 32 },
          type: { type: 'string', enum: ROOM_TYPES },
          name: { type: 'string', maxLength: 40 },
          level: { type: 'integer', minimum: 0, maximum: 1 },
          rect: RECT,
          windows: {
            type: 'array', maxItems: 6,
            items: { type: 'object', additionalProperties: false, required: ['wall', 'width'], properties: { wall: { type: 'string', enum: WALLS }, width: { type: 'number' } } },
          },
          doors: {
            type: 'array', maxItems: 4,
            items: {
              type: 'object', additionalProperties: false, required: ['wall', 'width', 'kind'],
              properties: { wall: { type: 'string', enum: WALLS }, width: { type: 'number' }, kind: { type: 'string', enum: ['internal', 'external', 'garage'] } },
            },
          },
        },
      },
    },
  },
};

// Structural sanity check of untrusted model output (types and ranges). Returns list of problems.
export function checkShape(spec) {
  const errs = [];
  if (!spec || typeof spec !== 'object') return ['spec is not an object'];
  if (!Array.isArray(spec.rooms) || spec.rooms.length < 2 || spec.rooms.length > 40) errs.push('rooms must be 2..40 items');
  if (![1, 2].includes(spec.storeys)) errs.push('storeys must be 1 or 2');
  if (!spec.roof || !['pitched', 'mono', 'flat'].includes(spec.roof.type)) errs.push('roof.type invalid');
  const ids = new Set();
  for (const room of spec.rooms || []) {
    const where = `room ${String(room?.id).slice(0, 32)}`;
    if (!room || typeof room.id !== 'string' || ids.has(room.id)) errs.push(`${where}: id missing or duplicate`);
    ids.add(room?.id);
    if (!ROOM_TYPES.includes(room?.type)) errs.push(`${where}: unknown type`);
    if (![0, 1].includes(room?.level)) errs.push(`${where}: level must be 0 or 1`);
    const r = room?.rect;
    if (!r || ![r.x, r.y, r.w, r.d].every((n) => typeof n === 'number' && Number.isFinite(n))) errs.push(`${where}: rect invalid`);
    else if (r.w <= 0 || r.d <= 0 || r.w > 60 || r.d > 60) errs.push(`${where}: size out of range`);
    for (const o of [...(room?.windows || []), ...(room?.doors || [])]) {
      if (!WALLS.includes(o?.wall) || typeof o?.width !== 'number' || o.width <= 0 || o.width > 6) errs.push(`${where}: opening invalid`);
    }
  }
  return errs;
}

// Snap all dimensions to 5 cm and recompute everything server-side. Never trust model-reported areas.
export function normaliseSpec(spec) {
  return {
    units: 'm',
    plot: { w: snap(spec.plot.w), d: snap(spec.plot.d) },
    storeys: spec.storeys,
    style: String(spec.style || '').slice(0, 40),
    roof: { type: spec.roof.type, pitchDeg: Math.min(45, Math.max(0, Number(spec.roof.pitchDeg) || 0)) },
    rooms: spec.rooms.map((r) => ({
      id: String(r.id).slice(0, 32),
      type: r.type,
      name: String(r.name || r.type).slice(0, 40),
      level: r.level,
      rect: { x: snap(r.rect.x), y: snap(r.rect.y), w: snap(r.rect.w), d: snap(r.rect.d) },
      windows: (r.windows || []).map((o) => ({ wall: o.wall, width: snap(o.width) })),
      doors: (r.doors || []).map((o) => ({ wall: o.wall, width: snap(o.width), kind: o.kind || 'internal' })),
    })),
  };
}

// ---------- Geometry ----------
const area = (r) => r.w * r.d;
const overlap1d = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

export function rectsOverlap(a, b) {
  return overlap1d(a.x, a.x + a.w, b.x, b.x + b.w) > EPS && overlap1d(a.y, a.y + a.d, b.y, b.y + b.d) > EPS;
}

// Length of wall shared by two touching rectangles.
export function sharedEdge(a, b) {
  if (Math.abs(a.x + a.w - b.x) < EPS || Math.abs(b.x + b.w - a.x) < EPS) return overlap1d(a.y, a.y + a.d, b.y, b.y + b.d);
  if (Math.abs(a.y + a.d - b.y) < EPS || Math.abs(b.y + b.d - a.y) < EPS) return overlap1d(a.x, a.x + a.w, b.x, b.x + b.w);
  return 0;
}

// For non-overlapping axis-aligned rooms: union perimeter = sum of perimeters - 2 x shared walls.
export function levelGeometry(rooms) {
  let sumPerim = 0;
  let sumArea = 0;
  let shared = 0;
  for (let i = 0; i < rooms.length; i++) {
    const a = rooms[i].rect;
    sumPerim += 2 * (a.w + a.d);
    sumArea += area(a);
    for (let j = i + 1; j < rooms.length; j++) shared += sharedEdge(a, rooms[j].rect);
  }
  const externalPerimeter = sumPerim - 2 * shared;
  return {
    areaM2: r2(sumArea),
    externalPerimeterM: r2(externalPerimeter),
    internalWallM: r2(shared), // each shared edge is one internal wall
  };
}

export function bbox(rooms) {
  const xs0 = Math.min(...rooms.map((r) => r.rect.x));
  const ys0 = Math.min(...rooms.map((r) => r.rect.y));
  const xs1 = Math.max(...rooms.map((r) => r.rect.x + r.rect.w));
  const ys1 = Math.max(...rooms.map((r) => r.rect.y + r.rect.d));
  return { x: xs0, y: ys0, w: xs1 - xs0, d: ys1 - ys0 };
}

export function planStats(spec) {
  const levels = [...new Set(spec.rooms.map((r) => r.level))].sort();
  const byLevel = Object.fromEntries(levels.map((l) => [l, levelGeometry(spec.rooms.filter((r) => r.level === l))]));
  const count = (t) => spec.rooms.filter((r) => r.type === t).length;
  const ground = byLevel[0] || { areaM2: 0 };
  return {
    storeys: levels.length,
    bedrooms: count('bedroom'),
    bathrooms: count('bathroom') + count('ensuite'),
    garages: count('garage'),
    floorAreaM2: r2(Object.values(byLevel).reduce((s, g) => s + g.areaM2, 0)),
    footprintM2: ground.areaM2,
    coverage: r2(ground.areaM2 / (spec.plot.w * spec.plot.d)),
    levels: byLevel,
  };
}

// ---------- Rules ----------
// Returns { ok, report: [{code, ok, severity, message}] }. Any failed "error" makes the option invalid.
export function checkRules(spec, brief) {
  const report = [];
  const add = (code, ok, severity, message) => report.push({ code, ok, severity, message });
  const s = RULES.setbackM;

  // R1 inside plot with boundary setbacks
  const outside = spec.rooms.filter((r) => r.rect.x < s - EPS || r.rect.y < s - EPS
    || r.rect.x + r.rect.w > spec.plot.w - s + EPS || r.rect.y + r.rect.d > spec.plot.d - s + EPS);
  add('R1_SETBACK', outside.length === 0, 'error',
    outside.length ? `${outside.length} room(s) closer than ${s} m to the boundary` : `All rooms at least ${s} m from boundaries`);

  // R2 no overlapping rooms on the same level
  let overlaps = 0;
  for (let i = 0; i < spec.rooms.length; i++) {
    for (let j = i + 1; j < spec.rooms.length; j++) {
      const a = spec.rooms[i];
      const b = spec.rooms[j];
      if (a.level === b.level && rectsOverlap(a.rect, b.rect)) overlaps++;
    }
  }
  add('R2_OVERLAP', overlaps === 0, 'error', overlaps ? `${overlaps} overlapping room pair(s)` : 'No overlapping rooms');

  // R3 bedroom size
  const small = spec.rooms.filter((r) => r.type === 'bedroom'
    && (area(r.rect) < RULES.minBedroomAreaM2 - EPS || Math.min(r.rect.w, r.rect.d) < RULES.minBedroomSideM - EPS));
  add('R3_BEDROOM_SIZE', small.length === 0, 'error',
    small.length ? `${small.length} bedroom(s) under ${RULES.minBedroomAreaM2} m² or narrower than ${RULES.minBedroomSideM} m`
      : `Bedrooms at least ${RULES.minBedroomAreaM2} m²`);

  // R4 storeys
  const levels = new Set(spec.rooms.map((r) => r.level));
  add('R4_STOREYS', levels.size <= RULES.maxStoreys && levels.has(0), 'error',
    levels.has(0) ? `${levels.size} storey(s)` : 'No ground floor');

  // R5 upper floor must sit on the ground floor footprint
  const upper = spec.rooms.filter((r) => r.level === 1);
  const ground = spec.rooms.filter((r) => r.level === 0);
  const unsupported = upper.filter((u) => {
    const a = area(u.rect);
    const covered = ground.reduce((sum, g) => sum + overlap1d(u.rect.x, u.rect.x + u.rect.w, g.rect.x, g.rect.x + g.rect.w)
      * overlap1d(u.rect.y, u.rect.y + u.rect.d, g.rect.y, g.rect.y + g.rect.d), 0);
    return covered < a - 0.01;
  });
  add('R5_UPPER_SUPPORTED', unsupported.length === 0, 'error',
    unsupported.length ? `${unsupported.length} upper room(s) not over the ground floor` : 'Upper floor supported');

  // R6 plot coverage
  const stats = planStats(spec);
  add('R6_COVERAGE', stats.coverage <= RULES.maxCoverage + EPS, 'error',
    `Coverage ${Math.round(stats.coverage * 100)}% (max ${RULES.maxCoverage * 100}%)`);

  // R7 minimum room side
  const narrow = spec.rooms.filter((r) => Math.min(r.rect.w, r.rect.d) < RULES.minRoomSideM - EPS);
  add('R7_MIN_SIDE', narrow.length === 0, 'error', narrow.length ? `${narrow.length} room(s) narrower than ${RULES.minRoomSideM} m` : 'Room widths OK');

  // R8 openings fit their wall
  const badOpenings = spec.rooms.filter((r) => [...r.windows, ...r.doors].some((o) => {
    const wallLen = o.wall === 'N' || o.wall === 'S' ? r.rect.w : r.rect.d;
    return o.width > wallLen + EPS;
  }));
  add('R8_OPENINGS', badOpenings.length === 0, 'error', badOpenings.length ? 'Opening wider than its wall' : 'Openings fit');

  // Warnings: brief match (do not invalidate the option)
  if (brief) {
    add('W1_BEDROOMS', stats.bedrooms === brief.bedrooms, 'warning', `${stats.bedrooms} of ${brief.bedrooms} requested bedrooms`);
    add('W2_BATHROOMS', stats.bathrooms >= brief.bathrooms, 'warning', `${stats.bathrooms} of ${brief.bathrooms} requested bathrooms`);
    const garage = spec.rooms.find((r) => r.type === 'garage');
    // One side fits the cars side by side, the other fits a car's length (either orientation).
    const fitsCars = (a, b) => a >= RULES.garageWidthPerCarM * brief.garageCars - EPS && b >= RULES.garageMinDepthM - EPS;
    const garageOk = brief.garageCars === 0
      || (!!garage && (fitsCars(garage.rect.w, garage.rect.d) || fitsCars(garage.rect.d, garage.rect.w)));
    add('W3_GARAGE', !!garageOk, 'warning', brief.garageCars ? `Garage for ${brief.garageCars} car(s)` : 'No garage requested');
    const diff = Math.abs(stats.floorAreaM2 - brief.floorAreaM2) / brief.floorAreaM2;
    add('W4_AREA', diff <= 0.2, 'warning', `Floor area ${stats.floorAreaM2} m² (target ${brief.floorAreaM2} m²)`);
  }

  const ok = report.every((r) => r.ok || r.severity !== 'error');
  return { ok, report, stats };
}

// Full verification pipeline for untrusted specs.
export function verifySpec(rawSpec, brief) {
  const shape = checkShape(rawSpec);
  if (shape.length) return { ok: false, shapeErrors: shape };
  const spec = normaliseSpec(rawSpec);
  const rules = checkRules(spec, brief);
  return { ok: rules.ok, spec, ...rules };
}
