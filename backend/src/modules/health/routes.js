import { redisReady } from '../../lib/redis.js';

// Load balancers call these. Minimal output; no versions or internals.
export default async function healthRoutes(app) {
  app.get('/health/live', { config: { rateLimit: false } }, async () => ({ status: 'ok' }));

  app.get('/health/ready', { config: { rateLimit: false } }, async (request, reply) => {
    const [dbOk, redisOk] = await Promise.all([
      app.db.query('SELECT 1').then(() => true, () => false),
      redisReady(app.redis),
    ]);
    const ok = dbOk && redisOk;
    return reply.status(ok ? 200 : 503).send({ status: ok ? 'ready' : 'not_ready', checks: { database: dbOk, redis: redisOk } });
  });
}
