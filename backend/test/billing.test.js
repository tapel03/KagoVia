import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTestApp, newUser, json, signPaystack } from './helpers.js';
import { reconcilePayment } from '../src/modules/billing/service.js';

let app;
let paystack;
before(async () => {
  ({ app, paystack } = await createTestApp());
});
after(async () => { await app.close(); });
beforeEach(async () => {
  await app.db.query("UPDATE plan_catalog SET is_active = (code IN ('starter','professional'))");
  paystack.failInitialize = false;
  paystack.verifyResult = null;
});

const checkout = (u, planCode, key = randomUUID()) =>
  u.req('POST', '/api/v1/billing/checkout-sessions', { body: { planCode }, headers: { 'idempotency-key': key } });

function webhook(event) {
  const body = JSON.stringify(event);
  return app.inject({
    method: 'POST', url: '/webhooks/v1/payments/paystack', payload: body,
    headers: { 'content-type': 'application/json', 'x-paystack-signature': signPaystack(body) },
  });
}
const success = (id, amount, extra = {}) => ({ event: 'charge.success', data: { reference: id, amount, currency: 'ZAR', status: 'success', ...extra } });
const entitlementCount = async (paymentId) => (await app.db.query('SELECT count(*)::int AS n FROM entitlements WHERE payment_id = $1', [paymentId])).rows[0].n;

test('plans: only active plans are listed and sold; price comes from the server', async () => {
  const plans = json(await app.inject('/api/v1/billing/plans')).items;
  assert.deepEqual(plans.map((p) => p.code), ['starter', 'professional']);
  const u = await newUser(app);
  assert.equal((await checkout(u, 'business')).statusCode, 400); // inactive
  const r = await checkout(u, 'starter');
  assert.equal(r.statusCode, 201);
  const p = json(r);
  assert.equal(p.amountCents, 29900);
  assert.equal(p.status, 'pending');
  assert.match(p.checkoutUrl, /checkout\.paystack\.test/);
  assert.equal(paystack.calls.initialize.at(-1).reference, p.id); // our id is the provider reference
});

test('idempotency: same key replays the same payment; same key with other plan is 409; no second provider call', async () => {
  const u = await newUser(app);
  const key = randomUUID();
  const before = paystack.calls.initialize.length;
  const a = json(await checkout(u, 'starter', key));
  const again = await checkout(u, 'starter', key);
  assert.equal(again.statusCode, 200);
  assert.equal(json(again).id, a.id);
  assert.equal(paystack.calls.initialize.length, before + 1);
  assert.equal((await checkout(u, 'professional', key)).statusCode, 409);
  assert.equal((await u.req('POST', '/api/v1/billing/checkout-sessions', { body: { planCode: 'starter' }, headers: { 'idempotency-key': 'abc' } })).statusCode, 400);
});

test('provider down at checkout: intent stays "created", retry with same key resumes it', async () => {
  const u = await newUser(app);
  const key = randomUUID();
  paystack.failInitialize = true;
  const down = await checkout(u, 'starter', key);
  assert.equal(down.statusCode, 503);
  const row = (await app.db.query('SELECT status FROM payments WHERE user_id = $1', [u.id])).rows[0];
  assert.equal(row.status, 'created');
  paystack.failInitialize = false;
  const retry = await checkout(u, 'starter', key);
  assert.equal(retry.statusCode, 201); // the checkout session is created on this call
  assert.equal(json(retry).status, 'pending');
  assert.equal((await app.db.query('SELECT count(*)::int AS n FROM payments WHERE user_id = $1', [u.id])).rows[0].n, 1);
});

test('webhook: bad signature is refused and nothing changes', async () => {
  const body = JSON.stringify(success(randomUUID(), 29900));
  const res = await app.inject({ method: 'POST', url: '/webhooks/v1/payments/paystack', payload: body,
    headers: { 'content-type': 'application/json', 'x-paystack-signature': 'a'.repeat(128) } });
  assert.equal(res.statusCode, 401);
  const noSig = await app.inject({ method: 'POST', url: '/webhooks/v1/payments/paystack', payload: body, headers: { 'content-type': 'application/json' } });
  assert.equal(noSig.statusCode, 401);
});

test('webhook: success grants exactly one entitlement, duplicates are ignored, late failure cannot downgrade', async () => {
  const u = await newUser(app);
  const p = json(await checkout(u, 'starter'));
  const ok = await webhook(success(p.id, 29900));
  assert.equal(ok.statusCode, 200);
  assert.equal(json(ok).outcome, 'pending_to_succeeded');
  assert.equal(json(await webhook(success(p.id, 29900))).outcome, 'duplicate');
  assert.equal(json(await webhook(success(p.id, 29900, { id: 2 }))).outcome, 'no_change'); // re-sent with new bytes
  assert.equal(await entitlementCount(p.id), 1);
  const late = await webhook({ event: 'charge.failed', data: { reference: p.id, amount: 29900, currency: 'ZAR' } });
  assert.match(json(late).outcome, /^ignored_succeeded_to_failed/);
  assert.equal(json(await u.req('GET', `/api/v1/billing/payments/${p.id}`)).status, 'succeeded');
  const ent = json(await u.req('GET', '/api/v1/me/entitlements'));
  assert.equal(ent.entitlements.length, 1);
  assert.equal(ent.aiGenerations.monthlyAllowance, 20);
  assert.equal((await app.db.query("SELECT count(*)::int AS n FROM outbox_events WHERE topic = 'payment.succeeded'")).rows[0].n >= 1, true);
});

test('webhook: wrong amount or currency never grants access', async () => {
  const u = await newUser(app);
  const p = json(await checkout(u, 'starter'));
  assert.equal(json(await webhook(success(p.id, 100))).outcome, 'amount_mismatch');
  assert.equal(json(await webhook(success(p.id, 29900, { currency: 'USD' }))).outcome, 'amount_mismatch');
  assert.equal(await entitlementCount(p.id), 0);
  assert.equal(json(await webhook(success(randomUUID(), 29900))).outcome, 'unknown_reference');
});

test('concurrency: webhook and reconciliation racing still give one entitlement', async () => {
  const u = await newUser(app);
  const p = json(await checkout(u, 'professional'));
  paystack.verifyResult = { status: 'success', amountCents: 69900, currency: 'ZAR' };
  const results = await Promise.all([
    webhook(success(p.id, 69900)),
    reconcilePayment(app, p.id),
    webhook(success(p.id, 69900, { attempt: 2 })),
    reconcilePayment(app, p.id),
  ]);
  assert.ok(results.length === 4);
  assert.equal(await entitlementCount(p.id), 1);
  assert.equal((await app.db.query('SELECT status FROM payments WHERE id = $1', [p.id])).rows[0].status, 'succeeded');
});

test('lost connection: user reconnects and reconciles; provider says pending so nothing is charged twice', async () => {
  const u = await newUser(app);
  const other = await newUser(app);
  const p = json(await checkout(u, 'starter'));
  assert.equal((await other.req('GET', `/api/v1/billing/payments/${p.id}`)).statusCode, 404);
  assert.equal((await other.req('POST', `/api/v1/billing/payments/${p.id}/reconcile`)).statusCode, 404);

  paystack.verifyResult = { status: 'abandoned', amountCents: 29900, currency: 'ZAR' };
  const pending = await u.req('POST', `/api/v1/billing/payments/${p.id}/reconcile`);
  assert.equal(json(pending).status, 'pending');
  paystack.verifyResult = { status: 'success', amountCents: 29900, currency: 'ZAR' };
  const done = await u.req('POST', `/api/v1/billing/payments/${p.id}/reconcile`);
  assert.equal(json(done).status, 'succeeded');
  assert.equal(json(done).checkoutUrl, null);
  assert.equal(await entitlementCount(p.id), 1);
  paystack.verifyResult = null; // provider outage
  const p2 = json(await checkout(u, 'starter'));
  assert.equal((await u.req('POST', `/api/v1/billing/payments/${p2.id}/reconcile`)).statusCode, 503);
  assert.equal(json(await u.req('GET', `/api/v1/billing/payments/${p2.id}`)).status, 'pending'); // never marked failed
});

test('renewal stacks after the current period', async () => {
  const u = await newUser(app);
  const a = json(await checkout(u, 'starter'));
  const b = json(await checkout(u, 'starter'));
  await webhook(success(a.id, 29900));
  await webhook(success(b.id, 29900));
  const rows = (await app.db.query('SELECT starts_at, ends_at FROM entitlements WHERE user_id = $1 ORDER BY starts_at', [u.id])).rows;
  assert.equal(rows.length, 2);
  assert.equal(rows[1].starts_at.getTime(), rows[0].ends_at.getTime());
});

test('review #1: declined card then successful retry on the same checkout grants access', async () => {
  const u = await newUser(app);
  const p = json(await checkout(u, 'starter'));
  await webhook({ event: 'charge.failed', data: { reference: p.id, amount: 29900, currency: 'ZAR' } });
  assert.equal(json(await u.req('GET', `/api/v1/billing/payments/${p.id}`)).status, 'failed');
  const ok = await webhook(success(p.id, 29900, { attempt: 'retry' }));
  assert.equal(json(ok).outcome, 'failed_to_succeeded');
  assert.equal(await entitlementCount(p.id), 1);
  // And reconciliation re-checks a recent failure too.
  const p2 = json(await checkout(u, 'starter'));
  await webhook({ event: 'charge.failed', data: { reference: p2.id, amount: 29900, currency: 'ZAR' } });
  paystack.verifyResult = { status: 'success', amountCents: 29900, currency: 'ZAR' };
  assert.equal(json(await u.req('POST', `/api/v1/billing/payments/${p2.id}/reconcile`)).status, 'succeeded');
});

test('review #2: two payments succeeding at the same moment get back-to-back periods, never overlapping', async () => {
  for (let round = 0; round < 5; round++) {
    const u = await newUser(app);
    const a = json(await checkout(u, 'starter'));
    const b = json(await checkout(u, 'starter'));
    await Promise.all([webhook(success(a.id, 29900)), webhook(success(b.id, 29900))]);
    const rows = (await app.db.query('SELECT starts_at, ends_at FROM entitlements WHERE user_id = $1 ORDER BY starts_at', [u.id])).rows;
    assert.equal(rows.length, 2);
    assert.equal(rows[1].starts_at.getTime(), rows[0].ends_at.getTime(), `round ${round}: periods overlap`);
  }
});

test('review #6: full refund and chargeback revoke access; partial refund keeps it', async () => {
  const u = await newUser(app);
  const full = json(await checkout(u, 'starter'));
  const part = json(await checkout(u, 'starter'));
  const disp = json(await checkout(u, 'starter'));
  for (const p of [full, part, disp]) await webhook(success(p.id, 29900));
  assert.equal(json(await webhook({ event: 'refund.processed', data: { transaction_reference: full.id, amount: 29900, currency: 'ZAR' } })).outcome, 'succeeded_to_refunded');
  assert.equal(json(await webhook({ event: 'refund.processed', data: { transaction_reference: part.id, amount: 10000, currency: 'ZAR' } })).outcome, 'succeeded_to_partially_refunded');
  assert.equal(json(await webhook({ event: 'charge.dispute.create', data: { transaction: { reference: disp.id }, currency: 'ZAR' } })).outcome, 'succeeded_to_disputed');
  const revoked = async (id) => (await app.db.query('SELECT revoked_at FROM entitlements WHERE payment_id = $1', [id])).rows[0].revoked_at !== null;
  assert.equal(await revoked(full.id), true);
  assert.equal(await revoked(part.id), false);
  assert.equal(await revoked(disp.id), true);
  // A late success can never resurrect a refunded payment.
  assert.match(json(await webhook(success(full.id, 29900, { late: true }))).outcome, /^ignored_refunded_to_succeeded/);
});

test('review A: two partial refunds that add up to the full amount become a full refund', async () => {
  const u = await newUser(app);
  const p = json(await checkout(u, 'starter'));
  await webhook(success(p.id, 29900));
  assert.equal(json(await webhook({ event: 'refund.processed', data: { transaction_reference: p.id, amount: 15000, currency: 'ZAR', id: 1 } })).outcome, 'succeeded_to_partially_refunded');
  assert.equal(json(await webhook({ event: 'refund.processed', data: { transaction_reference: p.id, amount: 14900, currency: 'ZAR', id: 2 } })).outcome, 'partially_refunded_to_refunded');
  assert.ok((await app.db.query('SELECT revoked_at FROM entitlements WHERE payment_id = $1', [p.id])).rows[0].revoked_at);
  assert.equal((await app.db.query('SELECT refunded_cents FROM payments WHERE id = $1', [p.id])).rows[0].refunded_cents, 29900);

  // A re-sent refund (same refund id, different bytes) is never counted twice.
  const q = json(await checkout(u, 'starter'));
  await webhook(success(q.id, 29900));
  const refund = (extra) => webhook({ event: 'refund.processed', data: { transaction_reference: q.id, amount: 10000, currency: 'ZAR', id: 777, ...extra } });
  assert.equal(json(await refund({})).outcome, 'succeeded_to_partially_refunded');
  assert.equal(json(await refund({ resent_at: 'later' })).outcome, 'no_change');
  assert.equal(json(await refund({ resent_at: 'again' })).outcome, 'no_change');
  assert.equal((await app.db.query('SELECT refunded_cents FROM payments WHERE id = $1', [q.id])).rows[0].refunded_cents, 10000);
  assert.equal((await app.db.query('SELECT revoked_at FROM entitlements WHERE payment_id = $1', [q.id])).rows[0].revoked_at, null);
});

test('review B: refunding the current period moves a prepaid next period up (no gap)', async () => {
  const u = await newUser(app);
  const a = json(await checkout(u, 'starter'));
  const b = json(await checkout(u, 'starter'));
  await webhook(success(a.id, 29900));
  await webhook(success(b.id, 29900));
  await webhook({ event: 'refund.processed', data: { transaction_reference: a.id, amount: 29900, currency: 'ZAR' } });
  const rows = (await app.db.query('SELECT starts_at, ends_at FROM entitlements WHERE payment_id = $1', [b.id])).rows;
  assert.ok(rows[0].starts_at.getTime() <= Date.now() + 1000, 'prepaid period should start now');
  assert.equal(rows[0].ends_at - rows[0].starts_at, 30 * 24 * 3600 * 1000);
  assert.equal(json(await u.req('GET', '/api/v1/me/entitlements')).entitlements.length, 1);
});

test('billing switched off returns 503 billing_disabled', async () => {
  const { app: off } = await createTestApp({ billing: { ...app.config.billing, enabled: false } });
  try {
    const u = await newUser(off);
    const res = await u.req('POST', '/api/v1/billing/checkout-sessions', { body: { planCode: 'starter' }, headers: { 'idempotency-key': randomUUID() } });
    assert.equal(res.statusCode, 503);
    assert.equal(json(res).code, 'billing_disabled');
  } finally {
    await off.close();
  }
});
