import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTestApp, newUser, json, seedPrices } from './helpers.js';
import { startWorkers } from '../src/jobs/runtime.js';
import { relayOnce } from '../src/jobs/outbox-relay.js';
import { createAiProcessor } from '../src/jobs/processors.js';
import { createLayoutService } from '../src/ai/provider.js';
import { PubSub } from '../src/lib/pubsub.js';

let app;
let runtime;
before(async () => {
  ({ app } = await createTestApp());
  runtime = await startWorkers({ config: app.config, db: app.db, redis: app.redis, paystack: null, log: null });
  await seedPrices(app, 'GP');
});
after(async () => {
  await runtime.close();
  await app.close();
});

async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}
const generate = (u, projectId, body = {}, key = randomUUID()) =>
  u.req('POST', `/api/v1/projects/${projectId}/generations`, { body, headers: { 'idempotency-key': key } });
const newProject = async (u, brief = { bedrooms: 3, bathrooms: 2, floorAreaM2: 160, plot: { widthM: 22, depthM: 32 }, garageCars: 1 }) =>
  json(await u.req('POST', '/api/v1/projects', { body: { name: 'Gen test', regionCode: 'GP', brief } }));

test('generation: outbox -> queue -> worker -> 3 verified plans, streamed over SSE', async () => {
  const u = await newUser(app);
  const p = await newProject(u);
  const res = await generate(u, p.id);
  assert.equal(res.statusCode, 202);
  const g = json(res);
  assert.equal(g.status, 'queued');

  // SSE stream ends by itself when the generation finishes.
  const sse = await u.req('GET', `/api/v1/generations/${g.id}/events`);
  assert.equal(sse.statusCode, 200);
  assert.match(sse.headers['content-type'], /text\/event-stream/);
  const events = sse.body.split('\n\n').filter((b) => b.startsWith('id:')).map((b) => ({
    id: Number(/^id: (\d+)/m.exec(b)[1]), type: /^event: (\w+)/m.exec(b)[1],
  }));
  assert.deepEqual(events.map((e) => e.type), ['queued', 'progress', 'option', 'option', 'option', 'succeeded']);
  assert.ok(events.every((e, i) => i === 0 || e.id > events[i - 1].id));

  // Replay after a disconnect: only events after Last-Event-ID.
  const replay = await u.req('GET', `/api/v1/generations/${g.id}/events`, { headers: { 'last-event-id': String(events[3].id) } });
  assert.equal((replay.body.match(/^id: /gm) || []).length, 2);

  const detail = json(await u.req('GET', `/api/v1/generations/${g.id}`));
  assert.equal(detail.status, 'succeeded');
  assert.equal(detail.provider, 'template');
  assert.deepEqual(detail.plans.map((x) => x.option), ['A', 'B', 'C']);
  assert.ok(detail.plans.every((x) => x.rulesReport.every((r) => r.ok || r.severity !== 'error')));
  assert.equal((await app.db.query('SELECT count(*)::int AS n FROM outbox_events WHERE published_at IS NULL')).rows[0].n, 0);

  const svg = await u.req('GET', detail.plans[0].svgUrl);
  assert.equal(svg.statusCode, 200);
  assert.match(svg.headers['content-type'], /image\/svg\+xml/);
  assert.match(svg.headers['content-security-policy'], /default-src 'none'/);
  assert.ok(!svg.body.includes('<script'));
});

test('generation: idempotent replay, other project with same key is 409, monthly quota enforced', async () => {
  const u = await newUser(app);
  const p = await newProject(u);
  const p2 = await newProject(u);
  const key = randomUUID();
  const first = json(await generate(u, p.id, {}, key));
  const again = await generate(u, p.id, {}, key);
  assert.equal(again.statusCode, 200);
  assert.equal(json(again).id, first.id);
  assert.equal((await generate(u, p2.id, {}, key)).statusCode, 409);
  assert.equal((await generate(u, p.id)).statusCode, 202);
  assert.equal((await generate(u, p.id)).statusCode, 202); // 3 of 3 free
  const over = await generate(u, p.id);
  assert.equal(over.statusCode, 429);
  assert.equal(json(over).code, 'quota_exceeded');
  assert.equal(json(await u.req('GET', '/api/v1/me/entitlements')).aiGenerations.usedThisMonth, 3);
});

test('generation: parallel requests cannot exceed the quota', async () => {
  const u = await newUser(app);
  const p = await newProject(u);
  const results = await Promise.all(Array.from({ length: 6 }, () => generate(u, p.id)));
  assert.equal(results.filter((r) => r.statusCode === 202).length, 3);
  assert.equal(results.filter((r) => r.statusCode === 429).length, 3);
});

test('generation: a brief that cannot fit fails cleanly with a dead letter and a clear message', async () => {
  const u = await newUser(app);
  const p = await newProject(u, { bedrooms: 6, bathrooms: 4, floorAreaM2: 500, plot: { widthM: 12, depthM: 12 }, garageCars: 2 });
  const g = json(await generate(u, p.id));
  const done = await waitFor(async () => {
    const d = json(await u.req('GET', `/api/v1/generations/${g.id}`));
    return d.status === 'failed' ? d : null;
  });
  assert.equal(done.errorCode, 'no_valid_layout');
  const sse = await u.req('GET', `/api/v1/generations/${g.id}/events`);
  assert.match(sse.body, /event: failed/);
  assert.match(sse.body, /could not fit a valid design/);
  assert.equal((await app.db.query("SELECT count(*)::int AS n FROM dead_letters WHERE queue = 'ai-generation'")).rows[0].n, 1);
});

test('generation: duplicate job delivery does not duplicate plans', async () => {
  const u = await newUser(app);
  const p = await newProject(u);
  const g = json(await generate(u, p.id));
  await waitFor(async () => json(await u.req('GET', `/api/v1/generations/${g.id}`)).status === 'succeeded');
  const process = createAiProcessor({ db: app.db, pubsub: new PubSub(app.redis, app.redis), layouts: createLayoutService({ aiConfig: {} }) });
  assert.deepEqual(await process({ data: { generationId: g.id }, attemptsMade: 0 }), { skipped: true });
  assert.equal((await app.db.query('SELECT count(*)::int AS n FROM floor_plans WHERE generation_id = $1', [g.id])).rows[0].n, 3);
  // Re-publishing an already-published outbox row is a no-op too.
  assert.equal(await relayOnce(app.db, runtime.queues, null), 0);
});

test('estimates: priced lines, unpriced flagged, totals add up, CSV export is safe; strangers get 404', async () => {
  const u = await newUser(app);
  const stranger = await newUser(app);
  const p = await newProject(u);
  const g = json(await generate(u, p.id));
  await waitFor(async () => json(await u.req('GET', `/api/v1/generations/${g.id}`)).status === 'succeeded');
  const plan = json(await u.req('GET', `/api/v1/generations/${g.id}`)).plans[0];

  assert.equal((await stranger.req('GET', `/api/v1/generations/${g.id}`)).statusCode, 404);
  assert.equal((await stranger.req('GET', `/api/v1/plans/${plan.id}`)).statusCode, 404);
  assert.equal((await stranger.req('GET', `/api/v1/plans/${plan.id}/svg`)).statusCode, 404);
  assert.equal((await stranger.req('POST', `/api/v1/plans/${plan.id}/estimates`)).statusCode, 404);

  const res = await u.req('POST', `/api/v1/plans/${plan.id}/estimates`);
  assert.equal(res.statusCode, 201);
  const e = json(res);
  const priced = e.lines.filter((l) => l.status === 'priced');
  const unpriced = e.lines.filter((l) => l.status === 'unpriced');
  assert.equal(unpriced.length, 1);
  assert.equal(unpriced[0].materialCode, 'plumbing_point');
  assert.equal(e.totals.unpricedLines, 1);
  assert.equal(e.totals.materialsCents, priced.reduce((s, l) => s + l.lineTotalCents, 0));
  assert.equal(e.totals.totalCents, e.totals.subtotalCents + e.totals.vatCents);
  assert.equal(e.rates.vatBp, 1500);
  assert.equal((await stranger.req('GET', `/api/v1/estimates/${e.id}`)).statusCode, 404);

  // Prices change later: the saved estimate does not.
  await app.db.query('UPDATE current_prices SET price_cents = price_cents * 2');
  assert.equal(json(await u.req('GET', `/api/v1/estimates/${e.id}`)).totals.totalCents, e.totals.totalCents);

  // CSV: formula injection is neutralised.
  await app.db.query("UPDATE estimate_lines SET description = '=HYPERLINK(\"http://evil\")' WHERE estimate_id = $1 AND line_no = 1", [e.id]);
  const csv = await u.req('GET', `/api/v1/estimates/${e.id}/export?format=csv`);
  assert.equal(csv.statusCode, 200);
  assert.match(csv.headers['content-disposition'], /attachment; filename="kagobuild-estimate-/);
  assert.ok(csv.body.includes("\"'=HYPERLINK(\"\"http://evil\"\")\""));
  assert.ok(!/,=HYPERLINK/.test(csv.body));
});

test('review #4: generations stuck after a lost job are failed by the sweeper and do not use quota', async () => {
  const u = await newUser(app);
  const p = await newProject(u);
  const stuck = (await app.db.query(
    `INSERT INTO generations (project_id, user_id, idempotency_key, brief, status, created_at)
     VALUES ($1, $2, gen_random_uuid(), '{}', 'running', now() - interval '45 minutes') RETURNING id`,
    [p.id, u.id],
  )).rows[0];
  await app.db.query("UPDATE generations SET started_at = now() - interval '40 minutes' WHERE id = $1", [stuck.id]);
  // A slow but healthy run (started 10 minutes ago) must NOT be swept (review C).
  const healthy = (await app.db.query(
    `INSERT INTO generations (project_id, user_id, idempotency_key, brief, status, created_at, started_at)
     VALUES ($1, $2, gen_random_uuid(), '{}', 'running', now() - interval '45 minutes', now() - interval '10 minutes') RETURNING id`,
    [p.id, u.id],
  )).rows[0];
  const { sweepStuckGenerations } = await import('../src/jobs/processors.js');
  assert.equal(await sweepStuckGenerations({ db: app.db, pubsub: new PubSub(app.redis, app.redis) }), 1);
  const g = json(await u.req('GET', `/api/v1/generations/${stuck.id}`));
  assert.equal(g.status, 'failed');
  assert.equal(g.errorCode, 'timed_out');
  assert.equal(json(await u.req('GET', `/api/v1/generations/${healthy.id}`)).status, 'running');
  assert.equal(json(await u.req('GET', '/api/v1/me/entitlements')).aiGenerations.usedThisMonth, 1); // only the healthy one

  // If the sweeper fails a generation while the worker is mid-run, the worker saves nothing and stays quiet.
  const layouts = {
    async generate(brief, onOption) {
      await app.db.query("UPDATE generations SET status = 'failed', error_code = 'timed_out' WHERE id = $1", [healthy.id]);
      const svc = createLayoutService({ aiConfig: {} });
      return svc.generate(brief, onOption);
    },
  };
  await app.db.query("UPDATE generations SET status = 'queued', brief = $2 WHERE id = $1", [healthy.id, p.brief]);
  const process = createAiProcessor({ db: app.db, pubsub: new PubSub(app.redis, app.redis), layouts });
  assert.deepEqual(await process({ data: { generationId: healthy.id }, attemptsMade: 0 }), { abandoned: true });
  assert.equal((await app.db.query('SELECT count(*)::int AS n FROM floor_plans WHERE generation_id = $1', [healthy.id])).rows[0].n, 0);
  const events = (await app.db.query('SELECT type FROM generation_events WHERE generation_id = $1', [healthy.id])).rows.map((r) => r.type);
  assert.ok(!events.includes('succeeded') && !events.includes('option'));
});

test('AI switched off: generation requests get 503 ai_disabled', async () => {
  const { app: off } = await createTestApp({ ai: { ...app.config.ai, enabled: false } });
  try {
    const u = await newUser(off);
    const p = json(await u.req('POST', '/api/v1/projects', { body: { name: 'x', regionCode: 'GP' } }));
    const res = await generate(u, p.id);
    assert.equal(res.statusCode, 503);
    assert.equal(json(res).code, 'ai_disabled');
  } finally {
    await off.close();
  }
});
