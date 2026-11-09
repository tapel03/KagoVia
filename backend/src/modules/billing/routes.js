import { badRequest } from '../../lib/errors.js';
import { idParams } from '../projects/access.js';
import { createCheckout, loadOwnPayment, paymentOut, reconcilePayment, generationAllowance, USED_GENERATIONS_SQL } from './service.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Per signed-in user (runs after authentication), and FAIL CLOSED if Redis is unavailable.
// Per-user keys avoid punishing many people behind one shared IP (offices, mobile networks).
const failClosed = (max) => ({
  rateLimit: { max, timeWindow: '1 minute', skipOnError: false, hook: 'preHandler', keyGenerator: (req) => `u:${req.user?.id ?? req.ip}` },
});

export default async function billingRoutes(app) {
  const { db } = app;
  app.addHook('onRequest', async (request, reply) => { reply.header('cache-control', 'no-store'); });

  app.get('/billing/plans', async () => {
    const { rows } = await db.query(
      'SELECT code, name, price_cents, currency, period_days, monthly_ai_generations FROM plan_catalog WHERE is_active ORDER BY price_cents',
    );
    return {
      items: rows.map((p) => ({
        code: p.code, name: p.name, priceCents: p.price_cents, currency: p.currency,
        periodDays: p.period_days, monthlyAiGenerations: p.monthly_ai_generations,
      })),
    };
  });

  app.post('/billing/checkout-sessions', {
    preHandler: app.authenticate,
    config: failClosed(10),
    schema: {
      headers: { type: 'object', required: ['idempotency-key'], properties: { 'idempotency-key': { type: 'string' } } },
      body: { type: 'object', additionalProperties: false, required: ['planCode'], properties: { planCode: { type: 'string', pattern: '^[a-z_]{2,40}$' } } },
    },
  }, async (request, reply) => {
    const key = request.headers['idempotency-key'];
    if (!UUID_RE.test(key)) throw badRequest('invalid_idempotency_key', 'Idempotency-Key must be a UUID');
    const { payment, replayed } = await createCheckout(app, request.user, { planCode: request.body.planCode, idempotencyKey: key.toLowerCase() });
    return reply.status(replayed ? 200 : 201).send(paymentOut(payment));
  });

  app.get('/billing/payments/:id', { preHandler: app.authenticate, schema: { params: idParams } }, async (request) =>
    paymentOut(await loadOwnPayment(db, request.params.id, request.user.id)));

  app.post('/billing/payments/:id/reconcile', {
    preHandler: app.authenticate,
    config: failClosed(4),
    schema: { params: idParams },
  }, async (request) => {
    await loadOwnPayment(db, request.params.id, request.user.id); // ownership first
    const { payment } = await reconcilePayment(app, request.params.id);
    return paymentOut(payment);
  });

  app.get('/me/entitlements', { preHandler: app.authenticate }, async (request) => {
    const { rows } = await db.query(
      `SELECT e.plan_code, e.starts_at, e.ends_at, pc.name FROM entitlements e JOIN plan_catalog pc ON pc.code = e.plan_code
        WHERE e.user_id = $1 AND e.revoked_at IS NULL AND e.ends_at > now() ORDER BY e.ends_at`,
      [request.user.id],
    );
    const allowance = await generationAllowance(db, request.user.id, app.config.ai.freeMonthlyGenerations);
    const used = (await db.query(
      USED_GENERATIONS_SQL,
      [request.user.id],
    )).rows[0].n;
    return {
      entitlements: rows.map((e) => ({ planCode: e.plan_code, name: e.name, startsAt: e.starts_at.toISOString(), endsAt: e.ends_at.toISOString() })),
      aiGenerations: { monthlyAllowance: allowance, usedThisMonth: used },
    };
  });
}
