import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTestApp, newUser, json, ORIGIN, seedPrices } from './helpers.js';

// An app whose Redis is unreachable (nothing listens on this port).
let app;
before(async () => {
  ({ app } = await createTestApp({ redisUrl: 'redis://127.0.0.1:6399' }));
  await seedPrices(app, 'GP');
  await app.db.query("UPDATE plan_catalog SET is_active = true WHERE code = 'starter'");
});
after(async () => { await app.close(); });

test('Redis down: readiness fails so the load balancer stops sending traffic', async () => {
  const res = await app.inject('/health/ready');
  assert.equal(res.statusCode, 503);
  assert.deepEqual(json(res).checks, { database: true, redis: false });
  assert.equal((await app.inject('/health/live')).statusCode, 200);
});

test('Redis down: ordinary reads still work (catalogue from PostgreSQL, projects)', async () => {
  const cat = await app.inject('/api/v1/materials?region=GP');
  assert.equal(cat.statusCode, 200);
  assert.equal(cat.headers['x-cache'], 'miss');
  const u = await newUser(app);
  assert.equal((await u.req('POST', '/api/v1/projects', { body: { name: 'Still works', regionCode: 'GP' } })).statusCode, 201);
  assert.equal((await u.req('GET', '/api/v1/projects')).statusCode, 200);
});

test('review #3: Redis down, SSE replays from the database then tells the client to poll (no hang)', async () => {
  const u = await newUser(app);
  const p = json(await u.req('POST', '/api/v1/projects', { body: { name: 'SSE', regionCode: 'GP' } }));
  const g = json(await u.req('POST', `/api/v1/projects/${p.id}/generations`, { body: {}, headers: { 'idempotency-key': randomUUID() } }));
  const started = Date.now();
  const sse = await u.req('GET', `/api/v1/generations/${g.id}/events`);
  assert.ok(Date.now() - started < 5000, 'stream must end promptly');
  assert.match(sse.body, /event: queued/);
  assert.match(sse.body, /event: live_unavailable/);
  assert.equal(app.pubsub.listeners.size, 0, 'no leaked listeners');
});

test('Redis down: sign-in and payments FAIL CLOSED (503), never unlimited', async () => {
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: ORIGIN }, payload: { email: 'a@example.com', password: 'password123' } });
  assert.equal(login.statusCode, 503);
  const u = await newUser(app);
  const pay = await u.req('POST', '/api/v1/billing/checkout-sessions', { body: { planCode: 'starter' }, headers: { 'idempotency-key': randomUUID() } });
  assert.equal(pay.statusCode, 503);
  assert.equal((await app.db.query('SELECT count(*)::int AS n FROM payments')).rows[0].n, 0);
});
