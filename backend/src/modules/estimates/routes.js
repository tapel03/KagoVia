import { tx } from '../../lib/db.js';
import { notFound, badRequest } from '../../lib/errors.js';
import { centsToRands } from '../../lib/money.js';
import { takeoff } from '../../domain/takeoff.js';
import { priceTakeoff } from '../../domain/pricing.js';
import { loadProject, idParams } from '../projects/access.js';

const estimateOut = (e, lines) => ({
  id: e.id, projectId: e.project_id, planId: e.plan_id, regionCode: e.region_code,
  takeoffVersion: e.takeoff_version, rulesVersion: e.rules_version,
  rates: { labourBp: e.labour_bp, contingencyBp: e.contingency_bp, vatBp: e.vat_bp },
  totals: {
    materialsCents: e.materials_cents, labourCents: e.labour_cents, contingencyCents: e.contingency_cents,
    subtotalCents: e.subtotal_cents, vatCents: e.vat_cents, totalCents: e.total_cents, unpricedLines: e.unpriced_lines,
  },
  createdAt: e.created_at.toISOString(),
  ...(lines ? {
    lines: lines.map((l) => ({
      lineNo: l.line_no, component: l.component, materialCode: l.material_code, description: l.description, unit: l.unit,
      quantity: l.quantity, status: l.status, supplierId: l.supplier_id, unitPriceCents: l.unit_price_cents,
      priceObservedAt: l.price_observed_at ? l.price_observed_at.toISOString() : null, lineTotalCents: l.line_total_cents,
    })),
  } : {}),
  note: 'Planning estimate only, not a quotation. Prices are frozen at the time shown on each line.',
});

export async function buildEstimate(client, plan, project, userId) {
  const rules = (await client.query(
    `SELECT r.labour_bp, er.version, er.contingency_bp, er.vat_bp
       FROM regions r JOIN estimation_rules er ON er.region_code = r.code AND er.is_active
      WHERE r.code = $1 ORDER BY er.version DESC LIMIT 1`,
    [project.region_code],
  )).rows[0];
  if (!rules) throw badRequest('no_rules_for_region', 'No estimating rules for this region');

  const t = takeoff(plan.spec);
  const codes = [...new Set(t.lines.map((l) => l.materialCode))];
  const mats = (await client.query('SELECT id, code, name, unit, wastage_bp FROM materials WHERE code = ANY($1) AND is_active', [codes])).rows;
  const materials = new Map(mats.map((m) => [m.code, m]));
  // Cheapest current price per material in this region.
  const priceRows = (await client.query(
    `SELECT DISTINCT ON (material_id) material_id, supplier_id, price_cents, observed_at
       FROM current_prices cp JOIN suppliers s ON s.id = cp.supplier_id AND s.is_active
      WHERE region_code = $1 AND material_id = ANY($2)
      ORDER BY material_id, price_cents ASC, observed_at DESC`,
    [project.region_code, mats.map((m) => m.id)],
  )).rows;
  const prices = new Map(priceRows.map((p) => [p.material_id, p]));
  const priced = priceTakeoff(t.lines, materials, prices, rules);
  const tt = priced.totals;

  const e = (await client.query(
    `INSERT INTO estimates (project_id, plan_id, created_by, region_code, takeoff_version, rules_version, labour_bp, contingency_bp, vat_bp,
        materials_cents, labour_cents, contingency_cents, subtotal_cents, vat_cents, total_cents, unpriced_lines)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
    [project.id, plan.id, userId, project.region_code, t.version, rules.version, rules.labour_bp, rules.contingency_bp, rules.vat_bp,
      tt.materialsCents, tt.labourCents, tt.contingencyCents, tt.subtotalCents, tt.vatCents, tt.totalCents, tt.unpricedLines],
  )).rows[0];
  const L = priced.lines;
  await client.query(
    `INSERT INTO estimate_lines (estimate_id, line_no, component, material_id, material_code, description, unit, quantity,
        supplier_id, unit_price_cents, price_observed_at, line_total_cents, status)
     SELECT $1, * FROM unnest($2::int[], $3::text[], $4::uuid[], $5::text[], $6::text[], $7::text[], $8::numeric[],
        $9::uuid[], $10::bigint[], $11::timestamptz[], $12::bigint[], $13::text[])`,
    [e.id, L.map((l) => l.lineNo), L.map((l) => l.component), L.map((l) => l.materialId), L.map((l) => l.materialCode),
      L.map((l) => l.description), L.map((l) => l.unit), L.map((l) => l.quantity), L.map((l) => l.supplierId),
      L.map((l) => l.unitPriceCents), L.map((l) => l.priceObservedAt), L.map((l) => l.lineTotalCents), L.map((l) => l.status)],
  );
  return e;
}

async function loadEstimate(db, id, user) {
  const e = (await db.query('SELECT * FROM estimates WHERE id = $1', [id])).rows[0];
  if (!e) throw notFound('Estimate not found');
  await loadProject(db, e.project_id, user);
  return e;
}

const csvCell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stop spreadsheet formula injection
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export default async function estimateRoutes(app) {
  const { db } = app;
  app.addHook('onRequest', async (request, reply) => { reply.header('cache-control', 'private, no-store'); });

  app.post('/plans/:id/estimates', {
    preHandler: app.authenticate,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: { params: idParams },
  }, async (request, reply) => {
    const e = await tx(db, async (client) => {
      const plan = (await client.query('SELECT * FROM floor_plans WHERE id = $1', [request.params.id])).rows[0];
      if (!plan) throw notFound('Plan not found');
      const { project } = await loadProject(client, plan.project_id, request.user, { write: true });
      return buildEstimate(client, plan, project, request.user.id);
    });
    const lines = (await db.query('SELECT * FROM estimate_lines WHERE estimate_id = $1 ORDER BY line_no', [e.id])).rows;
    return reply.status(201).send(estimateOut(e, lines));
  });

  app.get('/estimates/:id', { preHandler: app.authenticate, schema: { params: idParams } }, async (request) => {
    const e = await loadEstimate(db, request.params.id, request.user);
    const lines = (await db.query('SELECT * FROM estimate_lines WHERE estimate_id = $1 ORDER BY line_no', [e.id])).rows;
    return estimateOut(e, lines);
  });

  app.get('/projects/:id/estimates', { preHandler: app.authenticate, schema: { params: idParams } }, async (request) => {
    const { project } = await loadProject(db, request.params.id, request.user);
    const { rows } = await db.query('SELECT * FROM estimates WHERE project_id = $1 ORDER BY created_at DESC LIMIT 50', [project.id]);
    return { items: rows.map((e) => estimateOut(e)) };
  });

  app.get('/estimates/:id/export', {
    preHandler: app.authenticate,
    schema: {
      params: idParams,
      querystring: { type: 'object', additionalProperties: false, required: ['format'], properties: { format: { type: 'string', enum: ['csv'] } } },
    },
  }, async (request, reply) => {
    const e = await loadEstimate(db, request.params.id, request.user);
    const lines = (await db.query(
      `SELECT l.*, s.name AS supplier_name FROM estimate_lines l LEFT JOIN suppliers s ON s.id = l.supplier_id
        WHERE estimate_id = $1 ORDER BY line_no`, [e.id],
    )).rows;
    const rows = [['Line', 'Component', 'Material', 'Description', 'Unit', 'Quantity', 'Supplier', 'Unit price (R)', 'Price date', 'Line total (R)', 'Status']];
    for (const l of lines) {
      rows.push([l.line_no, l.component, l.material_code, l.description, l.unit, l.quantity, l.supplier_name ?? '',
        l.unit_price_cents == null ? '' : centsToRands(l.unit_price_cents), l.price_observed_at ? l.price_observed_at.toISOString().slice(0, 10) : '',
        l.line_total_cents == null ? '' : centsToRands(l.line_total_cents), l.status]);
    }
    rows.push([]);
    for (const [label, cents] of [['Materials', e.materials_cents], ['Labour', e.labour_cents], ['Contingency', e.contingency_cents],
      ['Subtotal', e.subtotal_cents], [`VAT ${e.vat_bp / 100}%`, e.vat_cents], ['Total', e.total_cents]]) {
      rows.push(['', '', '', label, '', '', '', '', '', centsToRands(cents), '']);
    }
    rows.push(['', '', '', 'Planning estimate only, not a quotation.']);
    const csv = `﻿${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
    return reply
      .type('text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="kagobuild-estimate-${e.id.slice(0, 8)}.csv"`)
      .send(csv);
  });
}
