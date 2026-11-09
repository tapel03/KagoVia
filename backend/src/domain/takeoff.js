// Deterministic material take-off (TRD §6). Pure function: same plan in, same quantities out.
// Quantities here EXCLUDE wastage; pricing adds each material's wastage from the catalogue.
// COEFFICIENTS ARE SAMPLE VALUES and must be signed off by a quantity surveyor before launch.
import { levelGeometry } from './plan.js';

export const TAKEOFF_VERSION = 'takeoff-2026.11-sample';

export const COEFFICIENTS = Object.freeze({
  wallHeightM: 2.7,
  externalBricksPerM2: 100, // double-skin 230 mm wall
  internalBricksPerM2: 50,  // single-skin 110 mm wall
  cementBagsPer1000Bricks: 3.5,
  sandM3Per1000Bricks: 0.7,
  foundationWidthM: 0.6,
  foundationThicknessM: 0.23,
  foundationRebarKgPerM3: 40,
  groundSlabThicknessM: 0.085,
  upperSlabThicknessM: 0.17,
  upperSlabRebarKgPerM3: 100,
  roofOverhangFactor: 1.15,
  windowHeightM: 1.2,
  doorHeightM: 2.1,
  garageDoorHeightM: 2.4,
  plumbingPoints: { bathroom: 3, ensuite: 3, kitchen: 2, laundry: 2 },
  electricalPoints: { bedroom: 4, living: 6, dining: 3, kitchen: 8, bathroom: 2, ensuite: 2, garage: 3, study: 5, passage: 2, laundry: 3 },
});

const round3 = (v) => Math.round(v * 1000) / 1000;
// Round up to whole units, ignoring floating-point noise (45.510000000000005 bricks/m2 must not become an extra brick).
const ceilClean = (v) => Math.ceil(round3(v));

export function takeoff(spec, c = COEFFICIENTS) {
  const levels = [...new Set(spec.rooms.map((r) => r.level))].sort();
  const lines = [];
  const add = (component, materialCode, description, quantity) => {
    if (quantity > 0) lines.push({ component, materialCode, description, quantity: round3(quantity) });
  };

  let extBricks = 0;
  let intBricks = 0;
  for (const level of levels) {
    const rooms = spec.rooms.filter((r) => r.level === level);
    const g = levelGeometry(rooms);
    const openings = rooms.flatMap((r) => [
      ...r.windows.map((w) => ({ external: true, area: w.width * c.windowHeightM })),
      // Each door is listed on one room only (the contract), so it is deducted once.
      ...r.doors.map((d) => ({
        external: d.kind !== 'internal',
        area: d.width * (d.kind === 'garage' ? c.garageDoorHeightM : c.doorHeightM),
      })),
    ]);
    const extOpen = openings.filter((o) => o.external).reduce((s, o) => s + o.area, 0);
    const intOpen = openings.filter((o) => !o.external).reduce((s, o) => s + o.area, 0);
    const extWall = Math.max(0, g.externalPerimeterM * c.wallHeightM - extOpen);
    const intWall = Math.max(0, g.internalWallM * c.wallHeightM - intOpen);
    extBricks += extWall * c.externalBricksPerM2;
    intBricks += intWall * c.internalBricksPerM2;

    if (level === 0) {
      const stripLen = g.externalPerimeterM + g.internalWallM;
      const footingM3 = stripLen * c.foundationWidthM * c.foundationThicknessM;
      add('foundations', 'concrete_25mpa', `Strip footings ${stripLen.toFixed(1)} m`, footingM3);
      add('foundations', 'rebar_y10', 'Footing reinforcement', footingM3 * c.foundationRebarKgPerM3);
      add('floor_slab', 'concrete_25mpa', `Ground slab ${g.areaM2} m²`, g.areaM2 * c.groundSlabThicknessM);
      add('floor_slab', 'mesh_ref193', 'Ground slab mesh', g.areaM2);
    } else {
      const m3 = g.areaM2 * c.upperSlabThicknessM;
      add('upper_slab', 'concrete_25mpa', `Suspended slab level ${level}`, m3);
      add('upper_slab', 'rebar_y10', `Suspended slab reinforcement level ${level}`, m3 * c.upperSlabRebarKgPerM3);
    }
  }

  add('walls', 'brick_stock', 'External walls (double skin)', ceilClean(extBricks));
  add('walls', 'brick_stock', 'Internal walls (single skin)', ceilClean(intBricks));
  const thousands = (extBricks + intBricks) / 1000;
  add('walls', 'cement_50kg', 'Mortar cement', ceilClean(thousands * c.cementBagsPer1000Bricks));
  add('walls', 'sand_building', 'Mortar sand', thousands * c.sandM3Per1000Bricks);

  // Roof over the ground-floor footprint (upper floors sit within it, rule R5).
  const footprint = levelGeometry(spec.rooms.filter((r) => r.level === 0)).areaM2;
  const pitch = spec.roof.type === 'flat' ? 0 : spec.roof.pitchDeg;
  const roofArea = (footprint / Math.cos((pitch * Math.PI) / 180)) * c.roofOverhangFactor;
  add('roof', 'roof_covering', `Roof covering (${spec.roof.type}, ${pitch}°)`, roofArea);
  add('roof', 'roof_timber', 'Roof structure', roofArea);

  const topLevel = Math.max(...levels);
  const finishable = spec.rooms.filter((r) => r.type !== 'garage');
  add('finishes', 'floor_tile', 'Floor tiles (excl. garage)', finishable.reduce((s, r) => s + r.rect.w * r.rect.d, 0));
  add('finishes', 'ceiling_board', 'Ceilings below roof',
    spec.rooms.filter((r) => r.level === topLevel).reduce((s, r) => s + r.rect.w * r.rect.d, 0));

  const doors = spec.rooms.flatMap((r) => r.doors);
  add('openings', 'door_internal', 'Internal doors', doors.filter((d) => d.kind === 'internal').length);
  add('openings', 'door_external', 'External doors', doors.filter((d) => d.kind === 'external').length);
  add('openings', 'door_garage', 'Garage doors', doors.filter((d) => d.kind === 'garage').length);
  add('openings', 'window_std', 'Windows', spec.rooms.reduce((s, r) => s + r.windows.length, 0));

  const points = (table) => spec.rooms.reduce((s, r) => s + (table[r.type] || 0), 0);
  add('services', 'plumbing_point', 'Plumbing points', points(c.plumbingPoints));
  add('services', 'electrical_point', 'Electrical points', points(c.electricalPoints));

  return { version: TAKEOFF_VERSION, lines };
}
