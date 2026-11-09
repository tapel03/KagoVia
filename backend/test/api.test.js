import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { createTestApp, newUser, token, json, ORIGIN, seedPrices } from './helpers.js';

let app;
before(async () => { ({ app } = await createTestApp()); });
after(async () => { await app.close(); });

test('health: live and ready', async () => {
  assert.equal((await app.inject('/health/live')).statusCode, 200);
  const ready = await app.inject('/health/ready');
  assert.equal(ready.statusCode, 200);
  assert.deepEqual(json(ready).checks, { database: true, redis: true });
});

test('auth: missing, forged, expired, wrong-issuer and HS256 tokens are rejected', async () => {
  assert.equal((await app.inject('/api/v1/auth/me')).statusCode, 401);
  const id = randomUUID();
  const bad = async (jwt) => (await app.inject({ url: '/api/v1/auth/me', headers: { authorization: `Bearer ${jwt}` } })).statusCode;
  assert.equal(await bad('not.a.jwt'), 401);
  assert.equal(await bad(await token(id, { expSeconds: -60 })), 401);
  assert.equal(await bad(await token(id, { issuer: 'https://evil.example/auth/v1' })), 401);
  assert.equal(await bad(await token(id, { audience: 'anon' })), 401);
  const hs = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(id).setIssuer('https://test.supabase.co/auth/v1')
    .setAudience('authenticated').setExpirationTime('1h').sign(new TextEncoder().encode('x'.repeat(32)));
  assert.equal(await bad(hs), 401);
  const ok = await app.inject({ url: '/api/v1/auth/me', headers: { authorization: `Bearer ${await token(id)}` } });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(json(ok).user.roles, ['customer']);
});

test('auth: login sets HttpOnly cookies; wrong password gives a neutral 401', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: ORIGIN }, payload: { email: 'a@example.com', password: 'correct horse' } });
  assert.equal(res.statusCode, 200);
  const cookies = res.cookies;
  const at = cookies.find((c) => c.name === 'kb_at');
  assert.ok(at.httpOnly);
  assert.equal(at.sameSite, 'Lax');
  assert.equal(cookies.find((c) => c.name === 'kb_rt').path, '/api/v1/auth');
  assert.equal(res.headers['cache-control'], 'no-store');
  const wrong = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: ORIGIN }, payload: { email: 'wrong@example.com', password: 'whatever1' } });
  assert.equal(wrong.statusCode, 401);
  assert.equal(json(wrong).code, 'invalid_credentials');
});

test('CSRF: cookie requests need an allowed Origin; bearer-only clients do not', async () => {
  const u = await newUser(app);
  const body = { name: 'House', regionCode: 'GP' };
  assert.equal((await u.req('POST', '/api/v1/projects', { body, origin: null })).statusCode, 403);
  assert.equal((await u.req('POST', '/api/v1/projects', { body, origin: 'https://evil.example' })).statusCode, 403);
  assert.equal((await u.req('POST', '/api/v1/projects', { body })).statusCode, 201);
  const bearer = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: { authorization: `Bearer ${u.jwt}` }, payload: body });
  assert.equal(bearer.statusCode, 201);
});

test('projects: create, list with paging, update with version check, delete', async () => {
  const u = await newUser(app);
  const created = [];
  for (let i = 0; i < 5; i++) {
    const r = await u.req('POST', '/api/v1/projects', { body: { name: `P${i}`, regionCode: 'WC', budgetCents: 150000000 } });
    assert.equal(r.statusCode, 201);
    created.push(json(r));
  }
  assert.equal(created[0].brief.bedrooms, 3); // defaults filled in
  const page1 = json(await u.req('GET', '/api/v1/projects?limit=2'));
  assert.equal(page1.items.length, 2);
  const page2 = json(await u.req('GET', `/api/v1/projects?limit=2&cursor=${page1.nextCursor}`));
  assert.equal(page2.items.length, 2);
  assert.notEqual(page1.items[0].id, page2.items[0].id);

  const p = created[0];
  const upd = await u.req('PATCH', `/api/v1/projects/${p.id}`, { body: { version: 1, name: 'Renamed', brief: { bedrooms: 4 } } });
  assert.equal(upd.statusCode, 200);
  assert.equal(json(upd).version, 2);
  assert.equal(json(upd).brief.bedrooms, 4);
  const stale = await u.req('PATCH', `/api/v1/projects/${p.id}`, { body: { version: 1, name: 'Lost update' } });
  assert.equal(stale.statusCode, 409);
  assert.equal(json(stale).code, 'version_conflict');
  assert.equal((await u.req('PATCH', `/api/v1/projects/${p.id}`, { body: { version: 2, ownerId: randomUUID() } })).statusCode, 400);
  assert.equal((await u.req('POST', '/api/v1/projects', { body: { name: 'X', regionCode: 'ZZ' } })).statusCode, 400);
  assert.equal((await u.req('DELETE', `/api/v1/projects/${p.id}`)).statusCode, 204);
  assert.equal((await u.req('GET', `/api/v1/projects/${p.id}`)).statusCode, 404);
});

test('BOLA: another user cannot read, change or delete my project (404, not 403)', async () => {
  const owner = await newUser(app);
  const stranger = await newUser(app);
  const p = json(await owner.req('POST', '/api/v1/projects', { body: { name: 'Mine', regionCode: 'GP' } }));
  assert.equal((await stranger.req('GET', `/api/v1/projects/${p.id}`)).statusCode, 404);
  assert.equal((await stranger.req('PATCH', `/api/v1/projects/${p.id}`, { body: { version: 1, name: 'x' } })).statusCode, 404);
  assert.equal((await stranger.req('DELETE', `/api/v1/projects/${p.id}`)).statusCode, 404);
  assert.equal(json(await stranger.req('GET', '/api/v1/projects')).items.length, 0);

  // Members: viewer can read but not edit; editor can edit; only the owner can delete.
  const viewer = await newUser(app);
  const editor = await newUser(app);
  await viewer.grant('customer');
  await editor.grant('customer');
  await app.db.query("INSERT INTO project_members (project_id, user_id, role, added_by) VALUES ($1, $2, 'viewer', $4), ($1, $3, 'editor', $4)",
    [p.id, viewer.id, editor.id, owner.id]);
  assert.equal((await viewer.req('GET', `/api/v1/projects/${p.id}`)).statusCode, 200);
  assert.equal((await viewer.req('PATCH', `/api/v1/projects/${p.id}`, { body: { version: 1, name: 'v' } })).statusCode, 403);
  assert.equal((await editor.req('PATCH', `/api/v1/projects/${p.id}`, { body: { version: 1, name: 'e' } })).statusCode, 200);
  assert.equal((await editor.req('DELETE', `/api/v1/projects/${p.id}`)).statusCode, 403);
});

test('materials: public catalogue, cached in Redis, falls back when Redis misses', async () => {
  await seedPrices(app, 'GP');
  const first = await app.inject('/api/v1/materials?region=GP&category=masonry');
  assert.equal(first.statusCode, 200);
  assert.equal(first.headers['x-cache'], 'miss');
  const body = json(first);
  assert.ok(body.items.length >= 3);
  assert.ok(body.items.every((i) => i.category === 'masonry' && i.lowestPriceCents > 0));
  assert.equal((await app.inject('/api/v1/materials?region=GP&category=masonry')).headers['x-cache'], 'hit');
  assert.equal((await app.inject('/api/v1/materials')).statusCode, 400);
  const injection = await app.inject(`/api/v1/materials?region=GP&q=${encodeURIComponent("%' OR 1=1 --")}`);
  assert.equal(injection.statusCode, 200);
  assert.equal(json(injection).items.length, 0);
});

test('admin: customers are refused; admins need MFA when required; price gate and two-person approval', async () => {
  const customer = await newUser(app);
  assert.equal((await customer.req('GET', '/api/v1/admin/overview')).statusCode, 403);

  const admin = await (await newUser(app, { aal: 'aal2' })).grant('admin');
  const admin2 = await (await newUser(app, { aal: 'aal2' })).grant('admin');
  const overview = await admin.req('GET', '/api/v1/admin/overview');
  assert.equal(overview.statusCode, 200);
  assert.ok('outbox' in json(overview));

  const sup = json(await admin.req('POST', '/api/v1/admin/suppliers', { body: { name: 'Cashbuild Test', sourceType: 'manual' } }));
  const set = (cents, who = admin) => who.req('POST', '/api/v1/admin/prices', { body: { materialCode: 'cement_50kg', supplierId: sup.id, regionCode: 'KZN', priceCents: cents } });
  const approve = async (res) => {
    assert.equal(res.statusCode, 202);
    const { reviewId } = json(res);
    assert.equal((await admin2.req('POST', `/api/v1/admin/price-reviews/${reviewId}/decision`, { body: { approve: true } })).statusCode, 200);
  };
  const first = await set(10000); // first price in the region: nothing to compare with, so it needs a second admin
  assert.equal(json(first).reason, 'no_reference_price');
  await approve(first);
  assert.equal((await set(10900)).statusCode, 200); // +9% applies
  const big = await set(15000); // +38% needs review
  assert.equal(big.statusCode, 202);
  const { reviewId } = json(big);
  assert.equal((await admin.req('POST', `/api/v1/admin/price-reviews/${reviewId}/decision`, { body: { approve: true } })).statusCode, 403);
  assert.equal((await admin2.req('POST', `/api/v1/admin/price-reviews/${reviewId}/decision`, { body: { approve: true } })).statusCode, 200);
  const price = (await app.db.query("SELECT price_cents FROM current_prices cp JOIN materials m ON m.id = cp.material_id WHERE m.code = 'cement_50kg' AND region_code = 'KZN'")).rows[0];
  assert.equal(price.price_cents, 15000);
  // The approved price is the new baseline: a routine +5% afterwards applies without another review.
  assert.equal((await set(15750)).statusCode, 200);
  assert.equal((await app.db.query("SELECT count(*)::int AS n FROM price_history WHERE region_code = 'KZN'")).rows[0].n, 4);
  assert.ok((await app.db.query("SELECT count(*)::int AS n FROM outbox_events WHERE topic = 'catalogue.changed'")).rows[0].n >= 3);
  const actions = (await app.db.query('SELECT action FROM audit_log ORDER BY id')).rows.map((r) => r.action);
  assert.ok(actions.includes('price.review_requested') && actions.includes('price.review_approved'));

  // Review #9: a new supplier far below the market, and small repeated steps, both need a second admin.
  const cheap = json(await admin.req('POST', '/api/v1/admin/suppliers', { body: { name: 'Too Cheap Ltd', sourceType: 'manual' } }));
  const lowball = await admin.req('POST', '/api/v1/admin/prices', { body: { materialCode: 'cement_50kg', supplierId: cheap.id, regionCode: 'KZN', priceCents: 1 } });
  assert.equal(lowball.statusCode, 202);
  assert.ok(json(lowball).checks.vsMedian < -9000);
  const steady = json(await admin.req('POST', '/api/v1/admin/suppliers', { body: { name: 'Stepper', sourceType: 'manual' } }));
  const step = (cents) => admin.req('POST', '/api/v1/admin/prices', { body: { materialCode: 'brick_stock', supplierId: steady.id, regionCode: 'KZN', priceCents: cents } });
  await approve(await step(250)); // first price, no market yet: second admin confirms
  assert.equal((await step(274)).statusCode, 200); // +9.6%
  const third = await step(300); // +9.5% on current but +20% on the 90-day baseline
  assert.equal(third.statusCode, 202);
  assert.equal(json(third).checks.vs90DayBaseline, 2000);

  // Roles: only super_admin, never on yourself.
  assert.equal((await admin.req('POST', '/api/v1/admin/roles', { body: { userId: customer.id, role: 'admin', grant: true } })).statusCode, 403);
  const boss = await (await newUser(app, { aal: 'aal2' })).grant('super_admin');
  assert.equal((await boss.req('POST', '/api/v1/admin/roles', { body: { userId: boss.id, role: 'support', grant: true } })).statusCode, 403);
  assert.equal((await boss.req('POST', '/api/v1/admin/roles', { body: { userId: customer.id, role: 'support', grant: true } })).statusCode, 200);
});

test('admin MFA is enforced when configured', async () => {
  const { app: strict } = await createTestApp({ adminRequireMfa: true });
  try {
    const noMfa = await (await newUser(strict, { aal: 'aal1' })).grant('admin');
    const res = await noMfa.req('GET', '/api/v1/admin/session');
    assert.equal(res.statusCode, 403);
    assert.match(json(res).detail, /multi-factor/);
    const mfa = await (await newUser(strict, { aal: 'aal2' })).grant('admin');
    assert.equal((await mfa.req('GET', '/api/v1/admin/session')).statusCode, 200);
  } finally {
    await strict.close();
  }
});

// Keep in sync with docs/sys_doc/02-architecture/08-backend-design.md §4. A new route fails this test until documented.
const DOCUMENTED_ROUTES = `
GET /health/live
GET /health/ready
POST /webhooks/v1/payments/paystack
POST /api/v1/auth/register
POST /api/v1/auth/login
POST /api/v1/auth/forgot
POST /api/v1/auth/refresh
POST /api/v1/auth/logout
GET /api/v1/auth/me
GET /api/v1/projects
POST /api/v1/projects
GET /api/v1/projects/:id
PATCH /api/v1/projects/:id
DELETE /api/v1/projects/:id
GET /api/v1/materials
POST /api/v1/projects/:id/generations
GET /api/v1/generations/:id
GET /api/v1/generations/:id/events
GET /api/v1/generations/:id/plans
GET /api/v1/plans/:id
GET /api/v1/plans/:id/svg
POST /api/v1/plans/:id/estimates
GET /api/v1/estimates/:id
GET /api/v1/projects/:id/estimates
GET /api/v1/estimates/:id/export
GET /api/v1/billing/plans
POST /api/v1/billing/checkout-sessions
GET /api/v1/billing/payments/:id
POST /api/v1/billing/payments/:id/reconcile
GET /api/v1/me/entitlements
POST /api/v1/support/chats
GET /api/v1/support/chats
GET /api/v1/support/chats/:id/messages
POST /api/v1/support/chats/:id/messages
GET /api/v1/support/chats/ws
GET /api/v1/admin/session
GET /api/v1/admin/overview
GET /api/v1/admin/suppliers
POST /api/v1/admin/suppliers
POST /api/v1/admin/prices
GET /api/v1/admin/price-reviews
POST /api/v1/admin/price-reviews/:id/decision
POST /api/v1/admin/roles
GET /api/v1/admin/dead-letters
GET /api/v1/admin/audit-log`.trim().split('\n').sort();

test('route inventory matches the documented API exactly (no hidden or debug routes)', () => {
  const actual = [...new Set(app.routeInventory)].filter((r) => !r.endsWith(' *')).sort();
  assert.deepEqual(actual, DOCUMENTED_ROUTES);
});

test('throwaway emails: refused at sign-up, login and reset, and on any token that carries one', async () => {
  // Each call from its own address, so the 5-per-minute sign-in limit does not get in the way.
  let ip = 10;
  const post = (url, payload) => app.inject({ method: 'POST', url, headers: { origin: ORIGIN }, payload, remoteAddress: `10.9.0.${ip++}` });
  for (const email of ['bot@mailinator.com', 'BOT@MAILINATOR.COM', 'x@abc.mailinator.com', 'x@10minutemail.com', 'x@yopmail.com', 'x@guerrillamail.com']) {
    const res = await post('/api/v1/auth/register', { email, password: 'Str0ng!pass' });
    assert.equal(res.statusCode, 400, email);
    assert.equal(json(res).code, 'disposable_email');
    assert.match(json(res).detail, /permanent email address/);
  }
  assert.equal(json(await post('/api/v1/auth/login', { email: 'x@mailinator.com', password: 'Str0ng!pass' })).code, 'disposable_email');
  assert.equal(json(await post('/api/v1/auth/forgot', { email: 'x@mailinator.com' })).code, 'disposable_email');

  // Real providers are fine.
  assert.equal((await post('/api/v1/auth/register', { email: 'thabo@gmail.com', password: 'Str0ng!pass' })).statusCode, 201);
  assert.equal((await post('/api/v1/auth/register', { email: 'naledi@company.co.za', password: 'Str0ng!pass' })).statusCode, 201);

  // An account made directly at Supabase with a throwaway address cannot use the API either.
  const sneaky = await token(randomUUID(), { email: 'x@mailinator.com' });
  const res = await app.inject({ url: '/api/v1/auth/me', headers: { authorization: `Bearer ${sneaky}` } });
  assert.equal(res.statusCode, 403);
  assert.equal(json(res).code, 'disposable_email');
  assert.equal((await app.db.query("SELECT count(*)::int AS n FROM app_users WHERE email = 'x@mailinator.com'")).rows[0].n, 0);
});

test('throwaway emails: extra blocked domains and an allow-list override come from settings', async () => {
  const { createDisposableChecker } = await import('../src/lib/disposable-email.js');
  const c = createDisposableChecker({ extraDomains: ['spammy.example'], allowDomains: ['yopmail.com'] });
  assert.ok(c.size > 5000);
  assert.equal(c.isDisposableEmail('a@spammy.example'), true);
  assert.equal(c.isDisposableEmail('a@mail.spammy.example'), true);
  assert.equal(c.isDisposableEmail('a@yopmail.com'), false);
  assert.equal(c.isDisposableEmail('a@gmail.com'), false);
  assert.equal(c.isDisposableEmail('not-an-email'), false);
});

test('errors are RFC 7807 problem documents with a request id; unknown routes are 404', async () => {
  const res = await app.inject('/api/v1/nope');
  assert.equal(res.statusCode, 404);
  assert.match(res.headers['content-type'], /application\/problem\+json/);
  assert.ok(json(res).requestId);
  assert.equal(res.headers['x-request-id'], json(res).requestId);
});
