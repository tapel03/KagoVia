// Payment state machine (docs/sys_doc/04-payments/01-payment-reliability.md).
// Invariants: price comes from the server; the intent is stored before calling the provider; a paid state is
// never downgraded; each payment grants at most one entitlement; every change happens under a row lock.
import { tx } from '../../lib/db.js';
import { writeOutbox, TOPICS } from '../../lib/outbox.js';
import { badRequest, conflict, notFound, unavailable } from '../../lib/errors.js';
import { mapPaystackStatus, providerHttpError } from '../../payments/paystack.js';

const ALLOWED = {
  created: ['pending', 'succeeded', 'failed', 'cancelled'],
  pending: ['succeeded', 'failed', 'cancelled'],
  succeeded: ['refunded', 'partially_refunded', 'disputed'],
  partially_refunded: ['refunded', 'disputed'],
  // A declined card can be retried on the same Paystack checkout. A later PROVIDER-VERIFIED success
  // must still win, otherwise the customer pays and gets nothing.
  failed: ['succeeded'],
  cancelled: ['succeeded'],
  refunded: [], disputed: [],
};
export const canTransition = (from, to) => from === to || (ALLOWED[from] || []).includes(to);

export function paymentOut(p) {
  return {
    id: p.id, planCode: p.plan_code, amountCents: p.amount_cents, currency: p.currency, status: p.status,
    checkoutUrl: ['created', 'pending'].includes(p.status) ? p.checkout_url : null,
    createdAt: p.created_at.toISOString(), updatedAt: p.updated_at.toISOString(),
  };
}

export async function createCheckout({ db, paystack, config }, user, { planCode, idempotencyKey }) {
  if (!config.billing.enabled) throw unavailable('billing_disabled', 'Payments are not enabled yet');
  if (!user.email) throw badRequest('email_required', 'Your account needs an email address to pay');

  const payment = await tx(db, async (client) => {
    const plan = (await client.query('SELECT * FROM plan_catalog WHERE code = $1 AND is_active', [planCode])).rows[0];
    if (!plan) throw badRequest('unknown_plan', 'This plan is not available');
    const inserted = await client.query(
      `INSERT INTO payments (user_id, plan_code, idempotency_key, amount_cents, currency, provider_reference)
       VALUES ($1, $2, $3, $4, $5, NULL)
       ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING *`,
      [user.id, plan.code, idempotencyKey, plan.price_cents, plan.currency],
    );
    if (inserted.rows[0]) {
      // Our payment id doubles as the provider reference, so a retry can never create a second charge.
      const { rows } = await client.query('UPDATE payments SET provider_reference = id::text WHERE id = $1 RETURNING *', [inserted.rows[0].id]);
      return rows[0];
    }
    const existing = (await client.query('SELECT * FROM payments WHERE user_id = $1 AND idempotency_key = $2', [user.id, idempotencyKey])).rows[0];
    if (existing.plan_code !== planCode) throw conflict('idempotency_key_reused', 'This Idempotency-Key was already used for a different request');
    return existing;
  });

  if (payment.status !== 'created' || payment.checkout_url) return { payment, replayed: true };

  let session;
  try {
    session = await paystack.initialize({
      email: user.email, amountCents: payment.amount_cents, currency: payment.currency, reference: payment.provider_reference,
      metadata: { paymentId: payment.id, planCode: payment.plan_code },
    });
  } catch (err) {
    // The intent stays "created"; retrying with the same key resumes it. Never mark failed here.
    throw providerHttpError(err);
  }
  const { rows } = await db.query(
    `UPDATE payments SET status = 'pending', checkout_url = $2, updated_at = now()
      WHERE id = $1 AND status = 'created' RETURNING *`,
    [payment.id, session.checkoutUrl],
  );
  return { payment: rows[0] ?? (await getPayment(db, payment.id)), replayed: false };
}

async function getPayment(db, id) {
  return (await db.query('SELECT * FROM payments WHERE id = $1', [id])).rows[0];
}

export async function loadOwnPayment(db, id, userId) {
  const p = (await db.query('SELECT * FROM payments WHERE id = $1 AND user_id = $2', [id, userId])).rows[0];
  if (!p) throw notFound('Payment not found');
  return p;
}

// Applies an authoritative provider result inside a transaction. Returns { payment, changed, granted }.
// verified: { status (ours), amountCents, currency }
export async function applyProviderResult(client, paymentId, verified, { source }) {
  const payment = (await client.query('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [paymentId])).rows[0];
  if (!payment) return { payment: null, changed: false, granted: false, outcome: 'unknown_payment' };

  if (verified.status === 'succeeded'
    && (verified.amountCents !== payment.amount_cents || String(verified.currency).toUpperCase() !== payment.currency)) {
    return { payment, changed: false, granted: false, outcome: 'amount_mismatch' };
  }
  if (!canTransition(payment.status, verified.status)) {
    return { payment, changed: false, granted: false, outcome: `ignored_${payment.status}_to_${verified.status}` };
  }
  // Serialise all entitlement changes for this user, so two payments landing at once cannot
  // both read the same "current period end" and overlap (paid days would be lost).
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 7))', [payment.user_id]);
  if (payment.status === verified.status) {
    await client.query('UPDATE payments SET last_verified_at = now() WHERE id = $1', [paymentId]);
    return { payment, changed: false, granted: false, outcome: 'no_change' };
  }

  const { rows } = await client.query(
    `UPDATE payments SET status = $2, updated_at = now(), last_verified_at = now() WHERE id = $1 RETURNING *`,
    [paymentId, verified.status],
  );
  let granted = false;
  if (verified.status === 'succeeded') {
    const plan = (await client.query('SELECT period_days FROM plan_catalog WHERE code = $1', [payment.plan_code])).rows[0];
    // Renewals stack after the latest active entitlement for the same plan.
    const res = await client.query(
      `INSERT INTO entitlements (user_id, plan_code, payment_id, starts_at, ends_at)
       SELECT $1, $2, $3, s.start, s.start + make_interval(days => $4)
         FROM (SELECT GREATEST(now(), COALESCE(MAX(ends_at), now())) AS start
                 FROM entitlements WHERE user_id = $1 AND plan_code = $2 AND revoked_at IS NULL) s
       ON CONFLICT (payment_id) DO NOTHING`,
      [payment.user_id, payment.plan_code, payment.id, plan.period_days],
    );
    granted = res.rowCount === 1;
    if (granted) await writeOutbox(client, TOPICS.PAYMENT_SUCCEEDED, { paymentId: payment.id, userId: payment.user_id, source });
  }
  if (['refunded', 'disputed'].includes(verified.status)) {
    // Full refund or chargeback: access from this payment stops now. Partial refunds keep access until
    // the refund policy is decided (Decision register B-05). Refund accounting itself is still planned.
    const revoked = await client.query(
      'UPDATE entitlements SET revoked_at = now() WHERE payment_id = $1 AND revoked_at IS NULL RETURNING plan_code',
      [paymentId],
    );
    if (revoked.rows[0]) await rebaseEntitlements(client, payment.user_id, revoked.rows[0].plan_code);
  }
  return { payment: rows[0], changed: true, granted, outcome: `${payment.status}_to_${verified.status}` };
}

// After a period is revoked, later stacked (prepaid) periods move up so there is no gap in paid access.
// Caller holds the per-user advisory lock.
async function rebaseEntitlements(client, userId, planCode) {
  const { rows } = await client.query(
    `SELECT id, starts_at, ends_at FROM entitlements
      WHERE user_id = $1 AND plan_code = $2 AND revoked_at IS NULL AND ends_at > now() ORDER BY starts_at`,
    [userId, planCode],
  );
  let cursor = new Date();
  for (const e of rows) {
    if (e.starts_at <= cursor) { // running now: keep it, the next one follows it
      cursor = e.ends_at > cursor ? e.ends_at : cursor;
      continue;
    }
    const length = e.ends_at - e.starts_at;
    const start = cursor;
    const end = new Date(start.getTime() + length);
    await client.query('UPDATE entitlements SET starts_at = $2, ends_at = $3 WHERE id = $1', [e.id, start, end]);
    cursor = end;
  }
}

// Refunds may come in several parts. Adds this refund to the running total (under the payment row lock)
// and returns the status the total implies. refundId is the provider's refund id: a refund already counted
// is never added again, even if its webhook is re-sent with different bytes.
export async function recordRefund(client, paymentId, refundCents, refundId) {
  const payment = (await client.query('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [paymentId])).rows[0];
  if (!payment || !['succeeded', 'partially_refunded'].includes(payment.status)) return null;
  const amount = Math.max(0, Math.trunc(refundCents) || 0);
  const fresh = await client.query(
    `INSERT INTO payment_refunds (provider, refund_id, payment_id, amount_cents) VALUES ('paystack', $1, $2, $3)
     ON CONFLICT (provider, refund_id) DO NOTHING`,
    [String(refundId), paymentId, amount],
  );
  let total = payment.refunded_cents;
  if (fresh.rowCount) {
    total = (await client.query(
      'UPDATE payments SET refunded_cents = LEAST(amount_cents, refunded_cents + $2) WHERE id = $1 RETURNING refunded_cents',
      [paymentId, amount],
    )).rows[0].refunded_cents;
  }
  if (total === 0) return payment.status;
  return total >= payment.amount_cents ? 'refunded' : 'partially_refunded';
}

// Asks the provider for the authoritative status and applies it. Used by the reconcile route and worker.
export async function reconcilePayment({ db, paystack }, paymentId) {
  const payment = await getPayment(db, paymentId);
  if (!payment) throw notFound('Payment not found');
  // A recent "failed" is rechecked too: the customer may have retried the card on the same checkout.
  const recentFailure = payment.status === 'failed' && Date.now() - payment.created_at.getTime() < 24 * 3600_000;
  if (!['created', 'pending'].includes(payment.status) && !recentFailure) return { payment, outcome: 'final' };
  let verified;
  try {
    const v = await paystack.verify(payment.provider_reference);
    verified = { status: mapPaystackStatus(v.status), amountCents: v.amountCents, currency: v.currency };
  } catch (err) {
    if (err.code === 'provider_rejected' && payment.status === 'created') {
      // Provider has no such transaction: checkout was never opened. Safe to leave as created.
      return { payment, outcome: 'not_found_at_provider' };
    }
    throw providerHttpError(err);
  }
  const result = await tx(db, (client) => applyProviderResult(client, paymentId, verified, { source: 'reconcile' }));
  return { payment: result.payment, outcome: result.outcome };
}

// Generations that count towards the monthly allowance. Failures on OUR side (worker error, lost job)
// are not charged to the customer; an unfittable brief still counts (it used AI time).
export const USED_GENERATIONS_SQL = `SELECT count(*)::int AS n FROM generations
  WHERE user_id = $1 AND created_at >= date_trunc('month', now())
    AND NOT (status = 'failed' AND error_code IN ('generation_error', 'timed_out'))`;

// Monthly AI generation allowance: the best active paid plan, otherwise the free allowance.
export async function generationAllowance(db, userId, freeAllowance) {
  const { rows } = await db.query(
    `SELECT COALESCE(MAX(pc.monthly_ai_generations), 0) AS paid
       FROM entitlements e JOIN plan_catalog pc ON pc.code = e.plan_code
      WHERE e.user_id = $1 AND e.revoked_at IS NULL AND now() >= e.starts_at AND now() < e.ends_at`,
    [userId],
  );
  return Math.max(freeAllowance, rows[0].paid);
}
