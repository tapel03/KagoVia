import { createHmac, timingSafeEqual } from 'node:crypto';
import { HttpError, unavailable } from '../lib/errors.js';

// Verifies the x-paystack-signature header: HMAC SHA512 of the exact raw body with the secret key.
export function verifyPaystackSignature(rawBody, signature, secretKey) {
  if (!secretKey || typeof signature !== 'string' || !/^[a-f0-9]{128}$/i.test(signature)) return false;
  const expected = createHmac('sha512', secretKey).update(rawBody).digest();
  const given = Buffer.from(signature, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export class ProviderError extends Error {
  constructor(code, message, { retryable = true } = {}) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

export function createPaystack({ paystackSecretKey, paystackBaseUrl, callbackUrl }) {
  async function call(method, pathname, body) {
    if (!paystackSecretKey) throw unavailable('billing_not_configured', 'Payments are not configured');
    let res;
    try {
      res = await fetch(`${paystackBaseUrl}${pathname}`, {
        method,
        headers: { authorization: `Bearer ${paystackSecretKey}`, 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw new ProviderError('provider_unreachable', `Paystack unreachable: ${err.name}`);
    }
    const data = await res.json().catch(() => ({}));
    if (res.status >= 500 || res.status === 429) throw new ProviderError('provider_unavailable', `Paystack HTTP ${res.status}`);
    if (!res.ok || data.status !== true) {
      throw new ProviderError('provider_rejected', String(data.message || `Paystack HTTP ${res.status}`).slice(0, 200), { retryable: false });
    }
    return data.data;
  }

  return {
    secretKey: paystackSecretKey,
    // Amount in cents (ZAR subunit). Reference is our payment id, so retries map to the same transaction.
    async initialize({ email, amountCents, currency, reference, metadata }) {
      const d = await call('POST', '/transaction/initialize', {
        email, amount: amountCents, currency, reference, metadata,
        ...(callbackUrl ? { callback_url: callbackUrl } : {}),
      });
      return { checkoutUrl: d.authorization_url, reference: d.reference };
    },
    async verify(reference) {
      const d = await call('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
      return { status: d.status, amountCents: d.amount, currency: d.currency, reference: d.reference, paidAt: d.paid_at || null };
    },
  };
}

// Paystack transaction status -> our payment status. Unknown or in-progress states stay pending:
// a timeout or ambiguity never marks a payment failed.
export function mapPaystackStatus(status) {
  switch (status) {
    case 'success': return 'succeeded';
    case 'failed': return 'failed';
    case 'reversed': return 'refunded';
    default: return 'pending'; // ongoing, pending, processing, queued, abandoned
  }
}

export const providerHttpError = (err) => (err instanceof ProviderError
  ? new HttpError(err.retryable ? 503 : 502, err.code, err.retryable ? 'Payment provider is unavailable, try again shortly' : 'Payment provider rejected the request')
  : err);
