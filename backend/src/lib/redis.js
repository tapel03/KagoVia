import { Redis } from 'ioredis';

// General-purpose client (cache, rate limits, publish). Commands fail fast instead of queueing forever
// when Redis is down, so callers can fall back to PostgreSQL.
export function createRedis(url, log, { name = 'main' } = {}) {
  const client = new Redis(url, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 5000,
    lazyConnect: false,
    retryStrategy: (times) => Math.min(times * 200, 2000),
  });
  client.on('error', (err) => log?.warn({ err: err.message, name }, 'redis error'));
  return client;
}

// Subscriber connections must be dedicated. Offline queue on so (re)subscribes survive reconnects.
export function createSubscriber(url, log) {
  const client = new Redis(url, { maxRetriesPerRequest: null, retryStrategy: (t) => Math.min(t * 200, 2000) });
  client.on('error', (err) => log?.warn({ err: err.message, name: 'subscriber' }, 'redis error'));
  return client;
}

// BullMQ requires maxRetriesPerRequest: null.
export function bullConnection(url) {
  return new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: true });
}

export async function redisReady(client) {
  try {
    return (await client.ping()) === 'PONG';
  } catch {
    return false;
  }
}
