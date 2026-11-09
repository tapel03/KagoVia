import { createHash } from 'node:crypto';
import { tx } from '../../lib/db.js';
import { HttpError } from '../../lib/errors.js';
import { verifyPaystackSignature, mapPaystackStatus } from '../../payments/paystack.js';
import { applyProviderResult, recordRefund } from './service.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Our payment id is the transaction reference. Refund and dispute events nest it differently.
// The refund/dispute payload shapes must be confirmed in the Paystack sandbox before going live.
function referenceOf(event) {
  const d = event?.data ?? {};
  return String(d.reference ?? d.transaction_reference ?? d.transaction?.reference ?? '');
}

// Event -> our status, given the stored payment. Returns null for events we only record.
// Runs inside the webhook transaction; refunds add to the payment's running refund total.
async function statusFor(client, type, data, payment, digest) {
  switch (type) {
    case 'charge.success': return mapPaystackStatus('success');
    case 'charge.failed': return mapPaystackStatus('failed');
    // Refund id from Paystack; if absent, the body digest (already unique per delivery) is the best we have.
    case 'refund.processed': return (await recordRefund(client, payment.id, Number(data?.amount), data?.id ?? `digest:${digest}`)) ?? 'refunded';
    case 'charge.dispute.create': return 'disputed';
    default: return null;
  }
}

// Provider webhooks: authenticated by signature (not cookies), so no Origin check.
// Always answer 200 once the event is safely recorded, so Paystack stops retrying.
export default async function webhookRoutes(app) {
  // Keep the exact raw bytes: the signature is computed over them.
  app.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 128 * 1024 }, (req, body, done) => done(null, body));

  app.post('/payments/paystack', {
    config: { skipOriginCheck: true, rateLimit: { max: 120, timeWindow: '1 minute' } },
    bodyLimit: 128 * 1024,
  }, async (request, reply) => {
    const raw = request.body;
    if (!Buffer.isBuffer(raw)) throw new HttpError(415, 'unsupported_media_type', 'Expected application/json');
    if (!verifyPaystackSignature(raw, request.headers['x-paystack-signature'], app.paystack.secretKey)) {
      request.log.warn('paystack webhook signature invalid');
      throw new HttpError(401, 'invalid_signature', 'Signature verification failed');
    }
    let event;
    try {
      event = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new HttpError(400, 'invalid_json', 'Body is not valid JSON');
    }
    const digest = createHash('sha256').update(raw).digest('hex');
    const reference = referenceOf(event);
    const type = String(event?.event ?? 'unknown').slice(0, 60);

    const outcome = await tx(app.db, async (client) => {
      // Only link events to payments we actually created; anything else is stored unlinked for review.
      let payment = null;
      if (UUID_RE.test(reference)) {
        payment = (await client.query('SELECT id, amount_cents FROM payments WHERE id = $1', [reference.toLowerCase()])).rows[0] ?? null;
      }
      const paymentId = payment?.id ?? null;
      // Dedup: the same delivery (same bytes) is recorded and applied once.
      const ins = await client.query(
        `INSERT INTO payment_events (payment_id, provider, event_type, digest, payload, outcome)
         VALUES ($1, 'paystack', $2, $3, $4, 'received')
         ON CONFLICT (provider, digest) DO NOTHING RETURNING id`,
        [paymentId, type, digest, event],
      );
      if (!ins.rows[0]) return 'duplicate';
      let result = 'ignored_unhandled_event';
      const status = payment ? await statusFor(client, type, event.data, payment, digest) : null;
      if (status) {
        const applied = await applyProviderResult(client, paymentId, {
          status,
          amountCents: Number(event.data.amount),
          currency: String(event.data.currency || ''),
        }, { source: 'webhook' });
        result = applied.outcome;
      } else if (!paymentId) {
        result = 'unknown_reference';
      }
      await client.query('UPDATE payment_events SET outcome = $2 WHERE id = $1', [ins.rows[0].id, result]);
      return result;
    });

    // Anything that looks like money received but not applied needs a human.
    if (outcome === 'amount_mismatch' || (type === 'charge.success' && /^(ignored_|unknown_reference)/.test(outcome))) {
      request.log.error({ reference, outcome, type }, 'paystack success not applied: manual review required');
    }
    return reply.status(200).send({ received: true, outcome });
  });
}
