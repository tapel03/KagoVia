// Test harness: real PostgreSQL + Redis, signed test JWTs, fake Supabase and Paystack.
// Set TEST_DATABASE_URL / TEST_REDIS_URL (defaults match the local docker-compose test services).
import { randomUUID, createHmac } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose';
import pg from 'pg';
import { Redis } from 'ioredis';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { migrate } from '../scripts/migrate.js';

export const DB_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5433/kagobuild_test';
export const REDIS_URL = process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6380/1';
export const ORIGIN = 'http://localhost:3000';
export const ISSUER = 'https://test.supabase.co/auth/v1';
export const PAYSTACK_SECRET = 'sk_test_kagobuild_secret';

const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
export const jwks = createLocalJWKSet({ keys: [jwk] });

export async function token(userId, { email = `${userId.slice(0, 8)}@example.com`, aal = 'aal1', expSeconds = 3600, issuer = ISSUER, audience = 'authenticated' } = {}) {
  return new SignJWT({ email, aal, role: 'authenticated' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setSubject(userId).setIssuer(issuer).setAudience(audience)
    .setIssuedAt().setExpirationTime(Math.floor(Date.now() / 1000) + expSeconds)
    .sign(privateKey);
}

export function testConfig(overrides = {}) {
  const c = loadConfig({
    NODE_ENV: 'test', DATABASE_URL: DB_URL, REDIS_URL, LOG_LEVEL: 'silent', PUBLIC_ORIGIN: ORIGIN, ALLOWED_ORIGINS: ORIGIN,
    SUPABASE_URL: 'https://test.supabase.co', SUPABASE_ANON_KEY: 'anon', BILLING_ENABLED: 'true', PAYSTACK_SECRET_KEY: PAYSTACK_SECRET,
    SERVE_FRONTEND: 'false', AI_FREE_MONTHLY_GENERATIONS: '3', OUTBOX_POLL_MS: '50',
  });
  return { ...c, ...overrides };
}

export function fakePaystack() {
  const calls = { initialize: [], verify: [] };
  const fake = {
    secretKey: PAYSTACK_SECRET,
    calls,
    failInitialize: false,
    verifyResult: null, // set per test: { status, amountCents, currency }
    async initialize(args) {
      calls.initialize.push(args);
      if (fake.failInitialize) {
        const { ProviderError } = await import('../src/payments/paystack.js');
        throw new ProviderError('provider_unreachable', 'down');
      }
      return { checkoutUrl: `https://checkout.paystack.test/${args.reference}`, reference: args.reference };
    },
    async verify(reference) {
      calls.verify.push(reference);
      if (!fake.verifyResult) {
        const { ProviderError } = await import('../src/payments/paystack.js');
        throw new ProviderError('provider_unavailable', 'Paystack HTTP 503');
      }
      return { reference, ...fake.verifyResult };
    },
  };
  return fake;
}

export function fakeSupabase() {
  return {
    async signUp() { return { user: { id: randomUUID() }, session: null }; },
    async signIn(email) {
      const { HttpError } = await import('../src/lib/errors.js');
      if (email === 'wrong@example.com') throw new HttpError(401, 'invalid_credentials', 'Email or password is incorrect');
      const id = '11111111-1111-4111-8111-111111111111';
      return { access_token: await token(id, { email }), refresh_token: 'refresh-abc', expires_in: 3600 };
    },
    async refresh() { return { access_token: await token('11111111-1111-4111-8111-111111111111'), refresh_token: 'refresh-def', expires_in: 3600 }; },
    async recover() { return {}; },
    async logout() { return {}; },
  };
}

let migrated = false;
export async function resetDatabase() {
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  try {
    if (!migrated) {
      await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      await migrate(DB_URL, { info() {} });
      migrated = true;
    } else {
      await client.query(`TRUNCATE app_users, user_roles, suppliers, current_prices, price_history, price_reviews, projects,
        project_members, generations, generation_events, floor_plans, estimates, estimate_lines, payments, payment_events,
        entitlements, chats, chat_participants, chat_messages, outbox_events, dead_letters, audit_log CASCADE`);
      await client.query('UPDATE plan_catalog SET is_active = false');
    }
  } finally {
    await client.end();
  }
  const r = new Redis(REDIS_URL);
  await r.flushdb();
  r.disconnect();
}

export async function createTestApp(overrides = {}, deps = {}) {
  await resetDatabase();
  const config = testConfig(overrides);
  const paystack = deps.paystack ?? fakePaystack();
  const app = await buildApp(config, { jwks, supabase: fakeSupabase(), paystack, logger: false, ...deps });
  await app.ready();
  // Readiness is false until Redis connects (correct in production); wait for it in tests.
  for (let i = 0; i < 50 && app.redis.status !== 'ready'; i++) await new Promise((r) => setTimeout(r, 20));
  return { app, config, paystack };
}

export class TestUser {
  constructor(app, { id = randomUUID(), aal = 'aal1' } = {}) {
    Object.assign(this, { app, id, aal });
  }
  async init() { this.jwt = await token(this.id, { aal: this.aal }); return this; }
  async grant(role) {
    await this.app.db.query('INSERT INTO app_users (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING', [this.id, `${this.id.slice(0, 8)}@example.com`]);
    await this.app.db.query('INSERT INTO user_roles (user_id, role) VALUES ($1, $2) ON CONFLICT DO NOTHING', [this.id, role]);
    return this;
  }
  // Browser-style request: session cookie + Origin.
  req(method, url, { body, headers = {}, origin = ORIGIN } = {}) {
    return this.app.inject({
      method, url, payload: body,
      headers: { cookie: `kb_at=${this.jwt}`, ...(origin ? { origin } : {}), ...headers },
    });
  }
}

export async function newUser(app, opts) {
  return new TestUser(app, opts).init();
}

export function signPaystack(body) {
  return createHmac('sha512', PAYSTACK_SECRET).update(body).digest('hex');
}

export async function seedPrices(app, regionCode = 'GP') {
  const sup = (await app.db.query("INSERT INTO suppliers (name, source_type) VALUES ('Test Supplier', 'manual') RETURNING id")).rows[0];
  // Every material except plumbing_point gets a price, to exercise "unpriced" lines.
  await app.db.query(
    `INSERT INTO current_prices (material_id, supplier_id, region_code, price_cents, observed_at)
     SELECT id, $1, $2, 1000 + (row_number() OVER (ORDER BY code))::int * 100, now() FROM materials WHERE code <> 'plumbing_point'`,
    [sup.id, regionCode],
  );
  return sup.id;
}

export const json = (res) => JSON.parse(res.body);
