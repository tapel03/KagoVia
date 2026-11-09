import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toMilli, milliToString, lineTotalCents, percentOfCents, centsToRands } from '../src/lib/money.js';
import { normaliseBrief, verifySpec, levelGeometry, sharedEdge, checkRules } from '../src/domain/plan.js';
import { templateLayout } from '../src/ai/template-provider.js';
import { takeoff, COEFFICIENTS } from '../src/domain/takeoff.js';
import { priceTakeoff } from '../src/domain/pricing.js';
import { verifyPaystackSignature, mapPaystackStatus } from '../src/payments/paystack.js';
import { createLayoutService, CircuitBreaker } from '../src/ai/provider.js';
import { canTransition } from '../src/modules/billing/service.js';
import { loadConfig } from '../src/config.js';
import { createHmac } from 'node:crypto';

test('money: quantities and cents never use floating point', () => {
  assert.equal(toMilli('12.345'), 12345);
  assert.equal(toMilli('0.1'), 100);
  assert.equal(toMilli(0.1 + 0.2), 300);
  assert.equal(toMilli('1.9995'), 2000);
  assert.equal(milliToString(12345), '12.345');
  assert.equal(lineTotalCents(1500, 333), 500); // 1.5 x R3.33 = R4.995 -> R5.00 (half up)
  assert.equal(lineTotalCents(3, 1), 0);
  assert.equal(percentOfCents(10000, 1500), 1500);
  assert.equal(percentOfCents(333, 1500), 50); // 49.95 -> 50
  assert.equal(centsToRands(123456), '1234.56');
  assert.equal(centsToRands(5), '0.05');
});

test('geometry: shared walls and perimeter of a union', () => {
  const a = { x: 0, y: 0, w: 4, d: 3 };
  const b = { x: 4, y: 0, w: 2, d: 3 };
  assert.equal(sharedEdge(a, b), 3);
  const g = levelGeometry([{ rect: a }, { rect: b }]);
  assert.equal(g.areaM2, 18);
  assert.equal(g.externalPerimeterM, 18); // 6 x 3 rectangle
  assert.equal(g.internalWallM, 3);
});

test('rules: overlaps, setbacks, small bedrooms and bad shapes are rejected', () => {
  const brief = normaliseBrief({ bedrooms: 1, bathrooms: 1, garageCars: 0, plot: { widthM: 20, depthM: 20 }, floorAreaM2: 40 });
  const base = {
    units: 'm', plot: { w: 20, d: 20 }, storeys: 1, style: 'modern', roof: { type: 'pitched', pitchDeg: 26 },
    rooms: [
      { id: 'b', type: 'bedroom', name: 'Bed', level: 0, rect: { x: 2, y: 2, w: 3, d: 3.2 }, windows: [], doors: [] },
      { id: 'w', type: 'bathroom', name: 'Bath', level: 0, rect: { x: 5, y: 2, w: 2, d: 2 }, windows: [], doors: [] },
    ],
  };
  assert.equal(verifySpec(base, brief).ok, true);
  const overlap = structuredClone(base);
  overlap.rooms[1].rect.x = 4;
  assert.equal(verifySpec(overlap, brief).report.find((r) => r.code === 'R2_OVERLAP').ok, false);
  const setback = structuredClone(base);
  setback.rooms[0].rect.x = 0.5;
  assert.equal(verifySpec(setback, brief).ok, false);
  const small = structuredClone(base);
  small.rooms[0].rect = { x: 2, y: 2, w: 2.8, d: 3 };
  assert.equal(verifySpec(small, brief).report.find((r) => r.code === 'R3_BEDROOM_SIZE').ok, false);
  assert.equal(verifySpec({ rooms: 'nope' }, brief).ok, false);
  const floating = structuredClone(base);
  floating.rooms.push({ id: 'u', type: 'study', name: 'Up', level: 1, rect: { x: 10, y: 10, w: 3, d: 3 }, windows: [], doors: [] });
  assert.equal(checkRules(floating, brief).report.find((r) => r.code === 'R5_UPPER_SUPPORTED').ok, false);
});

test('template layouts always pass the rules or report no fit', () => {
  for (const bedrooms of [1, 3, 6]) {
    for (const garageCars of [0, 2, 4]) {
      const brief = normaliseBrief({ bedrooms, bathrooms: 2, garageCars, floorAreaM2: 60 + bedrooms * 40, plot: { widthM: 30, depthM: 40 } });
      for (const label of ['A', 'B', 'C']) {
        const spec = templateLayout(brief, label);
        assert.ok(spec, `expected a layout for ${bedrooms} beds ${garageCars} cars`);
        const v = verifySpec(spec, brief);
        assert.equal(v.ok, true, JSON.stringify(v.report?.filter((r) => !r.ok)));
        assert.equal(v.stats.bedrooms, bedrooms);
      }
    }
  }
  assert.equal(templateLayout(normaliseBrief({ floorAreaM2: 300, plot: { widthM: 10, depthM: 10 } }), 'A'), null);
});

test('take-off: hand-checked quantities for a 6 x 3 m two-room house', () => {
  const spec = {
    units: 'm', plot: { w: 20, d: 20 }, storeys: 1, style: 'modern', roof: { type: 'flat', pitchDeg: 0 },
    rooms: [
      { id: 'a', type: 'bedroom', name: 'A', level: 0, rect: { x: 2, y: 2, w: 4, d: 3 }, windows: [{ wall: 'N', width: 1 }], doors: [{ wall: 'S', width: 0.9, kind: 'external' }] },
      { id: 'b', type: 'bathroom', name: 'B', level: 0, rect: { x: 6, y: 2, w: 2, d: 3 }, windows: [], doors: [{ wall: 'W', width: 0.8, kind: 'internal' }] },
    ],
  };
  const lines = Object.groupBy(takeoff(spec).lines, (l) => `${l.materialCode}|${l.description}`);
  const q = (code, desc) => lines[`${code}|${desc}`]?.[0].quantity;
  const c = COEFFICIENTS;
  // External wall: perimeter 18 m x 2.7 = 48.6 m2 minus window 1.2 and door 0.9*2.1=1.89 -> 45.51 m2 x 100
  assert.equal(c.externalBricksPerM2, 100);
  assert.equal(q('brick_stock', 'External walls (double skin)'), 4551); // exactly 45.51 m2, no phantom brick
  // Internal wall: 3 m x 2.7 = 8.1 minus door 0.8*2.1=1.68 -> 6.42 m2 x 50 = 321
  assert.equal(q('brick_stock', 'Internal walls (single skin)'), 321);
  assert.equal(q('mesh_ref193', 'Ground slab mesh'), 18);
  assert.equal(q('roof_covering', 'Roof covering (flat, 0°)'), Math.round(18 * 1.15 * 1000) / 1000);
  assert.equal(q('plumbing_point', 'Plumbing points'), 3);
  assert.equal(q('electrical_point', 'Electrical points'), 6);
});

test('pricing: wastage, whole units, unpriced lines and totals', () => {
  const materials = new Map([
    ['brick_stock', { id: 'm1', unit: 'each', wastage_bp: 500 }],
    ['sand_building', { id: 'm2', unit: 'm3', wastage_bp: 1000 }],
    ['plumbing_point', { id: 'm3', unit: 'each', wastage_bp: 0 }],
  ]);
  const prices = new Map([
    ['m1', { supplier_id: 's', price_cents: 250, observed_at: new Date() }],
    ['m2', { supplier_id: 's', price_cents: 45000, observed_at: new Date() }],
  ]);
  const out = priceTakeoff([
    { component: 'walls', materialCode: 'brick_stock', description: 'b', quantity: 1001 },
    { component: 'walls', materialCode: 'sand_building', description: 's', quantity: 1.5 },
    { component: 'services', materialCode: 'plumbing_point', description: 'p', quantity: 3 },
  ], materials, prices, { labour_bp: 3500, contingency_bp: 1000, vat_bp: 1500 });
  assert.equal(out.lines[0].quantity, '1052.000'); // 1001 x 1.05 = 1051.05 -> 1052 whole bricks
  assert.equal(out.lines[0].lineTotalCents, 1052 * 250);
  assert.equal(out.lines[1].quantity, '1.650');
  assert.equal(out.lines[1].lineTotalCents, 74250);
  assert.equal(out.lines[2].status, 'unpriced');
  const t = out.totals;
  assert.equal(t.materialsCents, 263000 + 74250);
  assert.equal(t.materialsCents, 337250);
  assert.equal(t.labourCents, 118038); // 35% of 337,250 = 118,037.5 -> half up
  assert.equal(t.contingencyCents, 45529); // 10% of 455,288 = 45,528.8
  assert.equal(t.subtotalCents, t.materialsCents + t.labourCents + t.contingencyCents);
  assert.equal(t.totalCents, t.subtotalCents + t.vatCents);
  assert.equal(t.unpricedLines, 1);
});

test('paystack signature: valid, tampered and malformed', () => {
  const body = Buffer.from('{"event":"charge.success"}');
  const sig = createHmac('sha512', 'secret').update(body).digest('hex');
  assert.equal(verifyPaystackSignature(body, sig, 'secret'), true);
  assert.equal(verifyPaystackSignature(Buffer.from('{"event":"charge.success "}'), sig, 'secret'), false);
  assert.equal(verifyPaystackSignature(body, sig, 'other'), false);
  assert.equal(verifyPaystackSignature(body, 'abc', 'secret'), false);
  assert.equal(verifyPaystackSignature(body, undefined, 'secret'), false);
  assert.equal(mapPaystackStatus('abandoned'), 'pending');
  assert.equal(mapPaystackStatus('success'), 'succeeded');
});

test('payment state machine never downgrades a paid payment', () => {
  assert.equal(canTransition('pending', 'succeeded'), true);
  assert.equal(canTransition('succeeded', 'pending'), false);
  assert.equal(canTransition('succeeded', 'failed'), false);
  assert.equal(canTransition('failed', 'succeeded'), true); // card retried on the same checkout (review finding 1)
  assert.equal(canTransition('failed', 'pending'), false);
  assert.equal(canTransition('refunded', 'succeeded'), false);
  assert.equal(canTransition('created', 'succeeded'), true);
});

test('layout service: repairs bad model output, falls back to template when the model fails', async () => {
  const brief = normaliseBrief({ bedrooms: 2, bathrooms: 1, garageCars: 0, floorAreaM2: 80, plot: { widthM: 20, depthM: 25 } });
  const good = templateLayout(brief, 'A');
  let calls = 0;
  const flaky = {
    name: 'stub-llm', model: 'stub-1',
    async proposeOption(_b, _label, previous) {
      calls++;
      if (!previous) return { ...good, rooms: good.rooms.map((r, i) => (i === 0 ? { ...r, rect: { ...r.rect, x: 0 } } : r)) }; // breaks setback
      assert.ok(previous.problems.length > 0);
      return good;
    },
  };
  const svc = createLayoutService({ aiConfig: {}, model: flaky });
  const options = await svc.generate(brief);
  assert.equal(options.length, 3);
  assert.ok(options.every((o) => o.provider === 'stub-llm'));
  assert.equal(calls, 6); // each option: bad then repaired

  const breaker = new CircuitBreaker({ threshold: 2, coolDownMs: 60_000 });
  const broken = { name: 'down', model: 'x', async proposeOption() { throw new Error('timeout'); } };
  const fallback = await createLayoutService({ aiConfig: {}, model: broken, breaker }).generate(brief);
  assert.equal(fallback.length, 3);
  assert.ok(fallback.every((o) => o.provider === 'template'));
  assert.equal(breaker.isOpen, true);
});

test('config fails closed in production when settings are missing', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'x', REDIS_URL: 'y' }), /SUPABASE_URL/);
  assert.throws(() => loadConfig({
    NODE_ENV: 'production', DATABASE_URL: 'x', REDIS_URL: 'y', SUPABASE_URL: 'https://s', SUPABASE_ANON_KEY: 'k',
    PUBLIC_ORIGIN: 'https://a', ALLOWED_ORIGINS: 'http://insecure', TRUSTED_PROXY_CIDRS: '10.0.0.0/8',
  }), /ALLOWED_ORIGINS/);
  const ok = loadConfig({
    NODE_ENV: 'production', DATABASE_URL: 'x', REDIS_URL: 'y', SUPABASE_URL: 'https://s', SUPABASE_ANON_KEY: 'k',
    PUBLIC_ORIGIN: 'https://a', ALLOWED_ORIGINS: 'https://a', TRUSTED_PROXY_CIDRS: '10.0.0.0/8',
  });
  assert.equal(ok.adminRequireMfa, true);
});
