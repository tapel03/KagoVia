import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';

import { createPool } from './lib/db.js';
import { createRedis, createSubscriber } from './lib/redis.js';
import { PubSub } from './lib/pubsub.js';
import { errorHandler, notFoundHandler, tooMany } from './lib/errors.js';
import authPlugin from './plugins/auth.js';
import originGuard from './plugins/origin-guard.js';
import { createSupabaseAuth } from './modules/auth/supabase.js';
import { createPaystack } from './payments/paystack.js';

import healthRoutes from './modules/health/routes.js';
import authRoutes from './modules/auth/routes.js';
import projectRoutes from './modules/projects/routes.js';
import materialRoutes from './modules/materials/routes.js';
import generationRoutes from './modules/generations/routes.js';
import estimateRoutes from './modules/estimates/routes.js';
import billingRoutes from './modules/billing/routes.js';
import webhookRoutes from './modules/billing/webhooks.js';
import chatRoutes from './modules/chat/routes.js';
import adminRoutes from './modules/admin/routes.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// deps lets tests (or other entry points) inject clients: db, redis, subscriber, jwks, supabase, paystack.
export async function buildApp(config, deps = {}) {
  const app = Fastify({
    logger: deps.logger ?? {
      level: config.logLevel,
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]',
          'req.headers["x-paystack-signature"]', '*.password', '*.access_token', '*.refresh_token'],
        censor: '[redacted]',
      },
    },
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    },
    requestIdHeader: false,
    // Only trust X-Forwarded-For from our own proxies; otherwise clients could fake their IP.
    trustProxy: config.trustedProxyCidrs.length ? config.trustedProxyCidrs : false,
    bodyLimit: 256 * 1024,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: 'array', useDefaults: true, allErrors: false } },
    forceCloseConnections: true,
    return503OnClosing: true,
  });

  const db = deps.db ?? createPool(config, app.log);
  const redis = deps.redis ?? createRedis(config.redisUrl, app.log);
  const subscriber = deps.subscriber ?? createSubscriber(config.redisUrl, app.log);
  const pubsub = new PubSub(redis, subscriber, app.log);
  const supabase = deps.supabase ?? createSupabaseAuth(config.supabase);
  const paystack = deps.paystack ?? createPaystack(config.billing);

  app.decorate('config', config);
  app.decorate('db', db);
  app.decorate('redis', redis);
  app.decorate('pubsub', pubsub);
  app.decorate('supabase', supabase);
  app.decorate('paystack', paystack);

  // Route inventory (OWASP API9): every registered API route, checked against the documented list in tests.
  const inventory = [];
  app.decorate('routeInventory', inventory);
  app.addHook('onRoute', (r) => {
    for (const m of [r.method].flat()) if (!['HEAD', 'OPTIONS'].includes(m)) inventory.push(`${m} ${r.url}`);
  });

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: config.isProd ? [] : null,
      },
    },
    hsts: config.isProd ? { maxAge: 31536000, includeSubDomains: true } : false,
    crossOriginEmbedderPolicy: false,
  });
  await app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || config.allowedOrigins.includes(origin)),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['content-type', 'idempotency-key', 'authorization', 'last-event-id', 'x-request-id'],
    maxAge: 600,
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    redis,
    nameSpace: 'kb:rl:',
    skipOnError: true, // ordinary reads keep working if Redis is down; sensitive routes override to false
    keyGenerator: (req) => req.ip,
    errorResponseBuilder: (req, ctx) => tooMany(`Too many requests, try again in ${ctx.after}`),
  });
  await app.register(websocket, {
    options: { maxPayload: config.chat.maxMessageBytes * 2 },
  });
  await app.register(authPlugin, { config, db, jwks: deps.jwks });
  await app.register(originGuard, { allowedOrigins: config.allowedOrigins });

  await app.register(healthRoutes);
  await app.register(webhookRoutes, { prefix: '/webhooks/v1' });
  await app.register(async (api) => {
    await api.register(authRoutes, { prefix: '/auth' });
    await api.register(projectRoutes);
    await api.register(materialRoutes);
    await api.register(generationRoutes);
    await api.register(estimateRoutes);
    await api.register(billingRoutes);
    await api.register(chatRoutes);
    await api.register(adminRoutes, { prefix: '/admin' });
  }, { prefix: '/api/v1' });

  if (config.serveFrontend) {
    const { default: fastifyStatic } = await import('@fastify/static');
    await app.register(fastifyStatic, { root: path.resolve(here, '..', '..', 'frontend'), prefix: '/', index: false });
  }

  app.addHook('onClose', async () => {
    if (!deps.subscriber) subscriber.disconnect();
    if (!deps.redis) redis.disconnect();
    if (!deps.db) await db.end();
  });

  return app;
}
