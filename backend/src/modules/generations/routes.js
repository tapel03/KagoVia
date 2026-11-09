import { tx } from '../../lib/db.js';
import { writeOutbox, TOPICS } from '../../lib/outbox.js';
import { badRequest, conflict, notFound, unavailable, HttpError } from '../../lib/errors.js';
import { BRIEF_JSON_SCHEMA, normaliseBrief } from '../../domain/plan.js';
import { loadProject, idParams } from '../projects/access.js';
import { generationAllowance, USED_GENERATIONS_SQL } from '../billing/service.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TERMINAL = new Set(['succeeded', 'failed']);
const HEARTBEAT_MS = 15_000;
const MAX_STREAM_MS = 10 * 60_000;

const genOut = (g) => ({
  id: g.id, projectId: g.project_id, status: g.status, provider: g.provider, errorCode: g.error_code,
  createdAt: g.created_at.toISOString(), finishedAt: g.finished_at ? g.finished_at.toISOString() : null,
  eventsUrl: `/api/v1/generations/${g.id}/events`,
});
const planSummary = (p) => ({
  id: p.id, option: p.option_label, version: p.version, stats: p.stats, rulesReport: p.rules_report,
  provider: p.provider, createdAt: p.created_at.toISOString(), svgUrl: `/api/v1/plans/${p.id}/svg`,
});

// Loads a generation the user may see (through project access).
export async function loadGeneration(db, id, user) {
  const g = (await db.query('SELECT * FROM generations WHERE id = $1', [id])).rows[0];
  if (!g) throw notFound('Generation not found');
  await loadProject(db, g.project_id, user); // throws 404 for strangers
  return g;
}
async function loadPlan(db, id, user) {
  const p = (await db.query('SELECT * FROM floor_plans WHERE id = $1', [id])).rows[0];
  if (!p) throw notFound('Plan not found');
  await loadProject(db, p.project_id, user);
  return p;
}

export default async function generationRoutes(app) {
  const { db, config, pubsub } = app;

  app.post('/projects/:id/generations', {
    preHandler: app.authenticate,
    config: { rateLimit: { max: 10, timeWindow: '1 minute', hook: 'preHandler', keyGenerator: (req) => `u:${req.user?.id ?? req.ip}` } },
    schema: {
      params: idParams,
      headers: { type: 'object', required: ['idempotency-key'], properties: { 'idempotency-key': { type: 'string' } } },
      body: { type: 'object', additionalProperties: false, properties: { brief: BRIEF_JSON_SCHEMA } },
    },
  }, async (request, reply) => {
    if (!config.ai.enabled) throw unavailable('ai_disabled', 'Plan generation is switched off right now');
    const key = String(request.headers['idempotency-key']).toLowerCase();
    if (!UUID_RE.test(key)) throw badRequest('invalid_idempotency_key', 'Idempotency-Key must be a UUID');
    const user = request.user;
    const allowance = await generationAllowance(db, user.id, config.ai.freeMonthlyGenerations);

    const { generation, replayed } = await tx(db, async (client) => {
      const { project } = await loadProject(client, request.params.id, user, { write: true });
      // Serialise this user's requests so two parallel calls cannot both slip under the quota.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 42))', [user.id]);
      const existing = (await client.query('SELECT * FROM generations WHERE user_id = $1 AND idempotency_key = $2', [user.id, key])).rows[0];
      if (existing) {
        if (existing.project_id !== project.id) throw conflict('idempotency_key_reused', 'This Idempotency-Key was used for another project');
        return { generation: existing, replayed: true };
      }
      const used = (await client.query(
        USED_GENERATIONS_SQL,
        [user.id],
      )).rows[0].n;
      if (used >= allowance) {
        throw new HttpError(429, 'quota_exceeded', `You have used all ${allowance} plan generations for this month`, { allowance, used });
      }
      const brief = normaliseBrief({ ...project.brief, ...(request.body?.brief || {}) });
      const g = (await client.query(
        `INSERT INTO generations (project_id, user_id, idempotency_key, brief) VALUES ($1, $2, $3, $4) RETURNING *`,
        [project.id, user.id, key, brief],
      )).rows[0];
      await client.query("INSERT INTO generation_events (generation_id, type, data) VALUES ($1, 'queued', '{}')", [g.id]);
      await writeOutbox(client, TOPICS.GENERATION_REQUESTED, { generationId: g.id });
      return { generation: g, replayed: false };
    });
    return reply.status(replayed ? 200 : 202).send(genOut(generation));
  });

  app.get('/generations/:id', { preHandler: app.authenticate, schema: { params: idParams } }, async (request) => {
    const g = await loadGeneration(db, request.params.id, request.user);
    const plans = (await db.query('SELECT * FROM floor_plans WHERE generation_id = $1 ORDER BY option_label', [g.id])).rows;
    return { ...genOut(g), plans: plans.map(planSummary) };
  });

  // Server-Sent Events: replays stored events after Last-Event-ID, then streams live ones from Redis.
  app.get('/generations/:id/events', {
    preHandler: app.authenticate,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: { params: idParams, querystring: { type: 'object', properties: { lastEventId: { type: 'integer', minimum: 0 } } } },
  }, async (request, reply) => {
    const g = await loadGeneration(db, request.params.id, request.user);
    const headerId = Number.parseInt(request.headers['last-event-id'], 10);
    let lastId = Number.isFinite(headerId) && headerId >= 0 ? headerId : (request.query.lastEventId ?? 0);

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no', // tell nginx-style proxies not to buffer
      'x-request-id': request.id,
    });
    res.write('retry: 3000\n\n');

    let closed = false;
    let done = false;
    const buffered = [];
    let replaying = true;
    let unsubscribe = null;
    const send = (ev) => {
      if (closed || done || ev.id <= lastId) return;
      lastId = ev.id;
      res.write(`id: ${ev.id}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev.data ?? {})}\n\n`);
      if (TERMINAL.has(ev.type)) finish();
    };
    function finish() {
      if (done) return;
      done = true;
      setImmediate(() => res.end());
    }
    // Cleanup is attached BEFORE any await, so a client that leaves early never leaks timers or listeners.
    const heartbeat = setInterval(() => !closed && res.write(': ping\n\n'), HEARTBEAT_MS);
    const maxTimer = setTimeout(finish, MAX_STREAM_MS);
    res.on('close', () => {
      closed = true;
      clearInterval(heartbeat);
      clearTimeout(maxTimer);
      unsubscribe?.();
    });
    const replay = async () => {
      const { rows } = await db.query(
        'SELECT id, type, data FROM generation_events WHERE generation_id = $1 AND id > $2 ORDER BY id LIMIT 500',
        [g.id, lastId],
      );
      for (const r of rows) send({ id: r.id, type: r.type, data: r.data });
    };

    try {
      // Subscribe first, then replay from the database, so nothing falls in the gap.
      try {
        unsubscribe = await pubsub.subscribe(`gen:${g.id}`, (ev) => (replaying ? buffered.push(ev) : send(ev)));
        if (closed) unsubscribe();
      } catch {
        // Live updates unavailable (Redis down): send what the database has, then tell the client to poll
        // GET /generations/{id} instead of holding the connection open.
        await replay();
        if (!done) {
          res.write('event: live_unavailable\ndata: {"poll":"/api/v1/generations/' + g.id + '","retryAfterSeconds":5}\n\n');
          finish();
        }
        return;
      }
      await replay();
    } catch (err) {
      request.log.warn({ err }, 'sse replay failed');
      if (!done) res.write('event: error\ndata: {"code":"replay_failed"}\n\n');
      finish();
    }
    replaying = false;
    buffered.sort((a, b) => a.id - b.id).forEach(send);
  });

  app.get('/generations/:id/plans', { preHandler: app.authenticate, schema: { params: idParams } }, async (request) => {
    const g = await loadGeneration(db, request.params.id, request.user);
    const plans = (await db.query('SELECT * FROM floor_plans WHERE generation_id = $1 ORDER BY option_label', [g.id])).rows;
    return { items: plans.map(planSummary) };
  });

  app.get('/plans/:id', { preHandler: app.authenticate, schema: { params: idParams } }, async (request) => {
    const p = await loadPlan(db, request.params.id, request.user);
    return { ...planSummary(p), projectId: p.project_id, spec: p.spec };
  });

  app.get('/plans/:id/svg', { preHandler: app.authenticate, schema: { params: idParams } }, async (request, reply) => {
    const p = await loadPlan(db, request.params.id, request.user);
    return reply
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'")
      .header('cache-control', 'private, max-age=3600')
      .type('image/svg+xml')
      .send(p.svg);
  });
}
