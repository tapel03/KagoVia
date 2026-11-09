import { tx } from '../../lib/db.js';
import { audit } from '../../lib/audit.js';
import { writeOutbox, TOPICS } from '../../lib/outbox.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { publicUser } from '../auth/routes.js';
import { idParams, UUID } from '../projects/access.js';

// All admin routes: database admin role (never the HTML or a token claim), MFA in production, no caching,
// and every change written to the append-only audit log.
export default async function adminRoutes(app) {
  const { db, config } = app;

  app.addHook('onRequest', async (request, reply) => { reply.header('cache-control', 'no-store'); });
  app.addHook('preHandler', app.requireAdmin);
  app.addHook('preHandler', async (request) => {
    if (config.adminRequireMfa && request.user.aal !== 'aal2') throw forbidden('Admin access requires multi-factor sign-in');
  });

  app.get('/session', async (request) => ({ user: publicUser(request.user) }));

  app.get('/overview', async () => {
    const q = async (sql) => (await db.query(sql)).rows;
    const [users, projects, gens, pays, outbox, dead, reviews] = await Promise.all([
      q("SELECT count(*)::int AS total, count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS new_7d FROM app_users WHERE deleted_at IS NULL"),
      q('SELECT count(*)::int AS total FROM projects WHERE deleted_at IS NULL'),
      q("SELECT status, count(*)::int AS n FROM generations WHERE created_at > now() - interval '24 hours' GROUP BY status"),
      q("SELECT status, count(*)::int AS n FROM payments WHERE created_at > now() - interval '30 days' GROUP BY status"),
      q('SELECT count(*)::int AS backlog, EXTRACT(EPOCH FROM now() - min(created_at))::int AS oldest_s FROM outbox_events WHERE published_at IS NULL'),
      q('SELECT count(*)::int AS open FROM dead_letters WHERE resolved_at IS NULL'),
      q("SELECT count(*)::int AS pending FROM price_reviews WHERE status = 'pending'"),
    ]);
    const byStatus = (rows) => Object.fromEntries(rows.map((r) => [r.status, r.n]));
    return {
      users: users[0], projects: projects[0], generations24h: byStatus(gens), payments30d: byStatus(pays),
      outbox: { backlog: outbox[0].backlog, oldestSeconds: outbox[0].oldest_s ?? 0 },
      deadLetters: dead[0].open, pendingPriceReviews: reviews[0].pending,
    };
  });

  // ---------- Suppliers ----------
  app.get('/suppliers', async () => ({
    items: (await db.query('SELECT id, name, source_type, is_active, created_at FROM suppliers ORDER BY name')).rows,
  }));

  app.post('/suppliers', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['name', 'sourceType'],
        properties: { name: { type: 'string', minLength: 2, maxLength: 120 }, sourceType: { type: 'string', enum: ['api', 'feed', 'manual'] } },
      },
    },
  }, async (request, reply) => {
    const s = await tx(db, async (client) => {
      const ins = await client.query(
        'INSERT INTO suppliers (name, source_type) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING RETURNING *',
        [request.body.name.trim(), request.body.sourceType],
      );
      if (!ins.rows[0]) throw conflict('supplier_exists', 'A supplier with this name already exists');
      await audit(client, { actorId: request.user.id, action: 'supplier.create', target: ins.rows[0].id, ip: request.ip, details: request.body });
      return ins.rows[0];
    });
    return reply.status(201).send(s);
  });

  // ---------- Prices (manual source) with the ±10% review gate ----------
  app.post('/prices', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['materialCode', 'supplierId', 'regionCode', 'priceCents'],
        properties: {
          materialCode: { type: 'string', pattern: '^[a-z0-9_]{2,40}$' },
          supplierId: UUID,
          regionCode: { type: 'string', pattern: '^[A-Z]{2,3}$' },
          priceCents: { type: 'integer', minimum: 1, maximum: 10_000_000_000 },
          observedAt: { type: 'string', format: 'date-time' },
        },
      },
    },
  }, async (request, reply) => {
    const b = request.body;
    const observedAt = b.observedAt ? new Date(b.observedAt) : new Date();
    if (observedAt.getTime() > Date.now() + 5 * 60_000) throw badRequest('future_price', 'observedAt cannot be in the future');
    const result = await tx(db, async (client) => {
      const mat = (await client.query('SELECT id FROM materials WHERE code = $1 AND is_active', [b.materialCode])).rows[0];
      if (!mat) throw badRequest('unknown_material', 'Unknown material');
      const sup = (await client.query('SELECT id FROM suppliers WHERE id = $1 AND is_active', [b.supplierId])).rows[0];
      if (!sup) throw badRequest('unknown_supplier', 'Unknown or inactive supplier');
      const reg = (await client.query('SELECT 1 FROM regions WHERE code = $1', [b.regionCode])).rows[0];
      if (!reg) throw badRequest('unknown_region', 'Unknown region');
      const current = (await client.query(
        'SELECT price_cents FROM current_prices WHERE material_id = $1 AND supplier_id = $2 AND region_code = $3 FOR UPDATE',
        [mat.id, sup.id, b.regionCode],
      )).rows[0];
      // Compare against every reference we have, so the gate cannot be dodged by small repeated steps
      // (30-day baseline) or by a brand-new supplier priced far from the market (regional median).
      const refs = (await client.query(
        `SELECT
           (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY price_cents) FROM current_prices
             WHERE material_id = $1 AND region_code = $3 AND supplier_id <> $2) AS median,
           -- Baseline: oldest price in the last 90 days, but never older than the last APPROVED review,
           -- so an approved change becomes the new normal instead of re-triggering reviews.
           (SELECT price_cents FROM price_history WHERE material_id = $1 AND supplier_id = $2 AND region_code = $3
             -- (the approved price's history row is written in the same transaction, so its time equals decided_at)
             AND recorded_at >= GREATEST(now() - interval '90 days', COALESCE((
               SELECT max(decided_at) FROM price_reviews WHERE material_id = $1 AND supplier_id = $2 AND region_code = $3
                  AND status = 'approved'), '-infinity'::timestamptz))
             ORDER BY recorded_at ASC LIMIT 1) AS baseline`,
        [mat.id, sup.id, b.regionCode],
      )).rows[0];
      const dev = (ref) => (ref ? Math.round(((b.priceCents - Number(ref)) * 10000) / Number(ref)) : null);
      const checks = { vsCurrent: dev(current?.price_cents), vsMedian: dev(refs.median), vs90DayBaseline: dev(refs.baseline) };
      const known = Object.values(checks).filter((v) => v !== null);
      const changeBp = known.reduce((m, v) => (Math.abs(v) > Math.abs(m) ? v : m), 0);
      // Nothing to compare with (first price in the region): a second admin must confirm it.
      const noReference = known.length === 0;
      if (noReference || Math.abs(changeBp) > config.priceReviewThresholdBp) {
        const review = (await client.query(
          `INSERT INTO price_reviews (material_id, supplier_id, region_code, old_price_cents, new_price_cents, change_bp, requested_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
          [mat.id, sup.id, b.regionCode, current?.price_cents ?? null, b.priceCents, changeBp, request.user.id],
        )).rows[0];
        await audit(client, { actorId: request.user.id, action: 'price.review_requested', target: review.id, ip: request.ip, details: { ...b, checks, noReference } });
        return { status: 'review_required', reason: noReference ? 'no_reference_price' : 'large_change', reviewId: review.id, changeBp, checks };
      }
      await applyPrice(client, { materialId: mat.id, supplierId: sup.id, regionCode: b.regionCode, priceCents: b.priceCents, observedAt, userId: request.user.id });
      await audit(client, { actorId: request.user.id, action: 'price.set', target: `${b.materialCode}/${b.regionCode}`, ip: request.ip, details: { ...b, checks } });
      return { status: 'applied', changeBp, checks };
    });
    return reply.status(result.status === 'applied' ? 200 : 202).send(result);
  });

  app.get('/price-reviews', async () => ({
    items: (await db.query(
      `SELECT r.*, m.code AS material_code, s.name AS supplier_name FROM price_reviews r
         JOIN materials m ON m.id = r.material_id JOIN suppliers s ON s.id = r.supplier_id
        WHERE r.status = 'pending' ORDER BY r.created_at LIMIT 200`,
    )).rows,
  }));

  // Separation of duties: a different admin must approve a large price change.
  app.post('/price-reviews/:id/decision', {
    schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['approve'], properties: { approve: { type: 'boolean' } } } },
  }, async (request) => tx(db, async (client) => {
    const r = (await client.query('SELECT * FROM price_reviews WHERE id = $1 FOR UPDATE', [request.params.id])).rows[0];
    if (!r) throw notFound('Review not found');
    if (r.status !== 'pending') throw conflict('already_decided', 'This review was already decided');
    if (r.requested_by === request.user.id) throw forbidden('A different admin must approve this change');
    const status = request.body.approve ? 'approved' : 'rejected';
    await client.query('UPDATE price_reviews SET status = $2, decided_by = $3, decided_at = now() WHERE id = $1', [r.id, status, request.user.id]);
    if (request.body.approve) {
      await applyPrice(client, {
        materialId: r.material_id, supplierId: r.supplier_id, regionCode: r.region_code, priceCents: r.new_price_cents,
        observedAt: r.created_at, userId: request.user.id,
      });
    }
    await audit(client, { actorId: request.user.id, action: `price.review_${status}`, target: r.id, ip: request.ip });
    return { status };
  }));

  // ---------- Roles (super_admin only) ----------
  app.post('/roles', {
    preHandler: app.requireRole('super_admin'),
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['userId', 'role', 'grant'],
        properties: { userId: UUID, role: { type: 'string', enum: ['supplier', 'support', 'admin', 'super_admin'] }, grant: { type: 'boolean' } },
      },
    },
  }, async (request) => tx(db, async (client) => {
    const { userId, role, grant } = request.body;
    if (userId === request.user.id) throw forbidden('You cannot change your own roles');
    const target = (await client.query('SELECT 1 FROM app_users WHERE id = $1 AND deleted_at IS NULL', [userId])).rows[0];
    if (!target) throw notFound('User not found');
    if (grant) {
      await client.query('INSERT INTO user_roles (user_id, role, granted_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [userId, role, request.user.id]);
    } else {
      await client.query('DELETE FROM user_roles WHERE user_id = $1 AND role = $2', [userId, role]);
    }
    await audit(client, { actorId: request.user.id, action: grant ? 'role.grant' : 'role.revoke', target: userId, ip: request.ip, details: { role } });
    return { userId, role, granted: grant };
  }));

  // ---------- Failed jobs ----------
  app.get('/dead-letters', async () => ({
    items: (await db.query('SELECT * FROM dead_letters WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT 200')).rows,
  }));

  app.get('/audit-log', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 } } } },
  }, async (request) => ({
    items: (await db.query('SELECT * FROM audit_log ORDER BY id DESC LIMIT $1', [request.query.limit])).rows,
  }));
}

async function applyPrice(client, { materialId, supplierId, regionCode, priceCents, observedAt, userId }) {
  await client.query(
    `INSERT INTO current_prices (material_id, supplier_id, region_code, price_cents, observed_at) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (material_id, supplier_id, region_code) DO UPDATE SET price_cents = EXCLUDED.price_cents, observed_at = EXCLUDED.observed_at, updated_at = now()`,
    [materialId, supplierId, regionCode, priceCents, observedAt],
  );
  await client.query(
    `INSERT INTO price_history (material_id, supplier_id, region_code, price_cents, observed_at, source, recorded_by)
     VALUES ($1, $2, $3, $4, $5, 'manual', $6)`,
    [materialId, supplierId, regionCode, priceCents, observedAt, userId],
  );
  await writeOutbox(client, TOPICS.CATALOGUE_CHANGED, { regionCode });
}
