import fp from 'fastify-plugin';
import { forbidden } from '../lib/errors.js';

// CSRF protection for cookie sessions: state-changing browser requests must come from an allowed Origin.
// Requests authenticated only with a Bearer header (no cookie) are not exposed to CSRF and are allowed.
// Routes can opt out with { config: { skipOriginCheck: true } } (provider webhooks, verified by signature).
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

async function originGuard(app, { allowedOrigins }) {
  const allowed = new Set(allowedOrigins);
  app.addHook('onRequest', async (request) => {
    if (SAFE.has(request.method)) return;
    if (request.routeOptions?.config?.skipOriginCheck) return;
    const bearerOnly = request.headers.authorization?.startsWith('Bearer ') && !request.headers.cookie;
    if (bearerOnly) return;
    const origin = request.headers.origin;
    if (!origin || !allowed.has(origin)) throw forbidden('Request origin is not allowed');
  });
}

export default fp(originGuard, { name: 'origin-guard' });
