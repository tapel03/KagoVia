// Worker process: outbox relay, AI generation, domain events and scheduled maintenance.
// Scale this deployment on queue age and depth, separately from the API.
import pino from 'pino';
import { loadConfig } from './config.js';
import { createPool } from './lib/db.js';
import { createRedis } from './lib/redis.js';
import { createPaystack } from './payments/paystack.js';
import { startWorkers } from './jobs/runtime.js';

const config = loadConfig();
const log = pino({ level: config.logLevel, base: { service: 'kagobuild-worker' } });
const db = createPool(config, log);
const redis = createRedis(config.redisUrl, log);
const runtime = await startWorkers({ config, db, redis, paystack: createPaystack(config.billing), log });
log.info('workers started');

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, 'stopping workers (finishing current jobs)');
  const force = setTimeout(() => process.exit(1), 60_000);
  try {
    await runtime.close();
    redis.disconnect();
    await db.end();
  } finally {
    clearTimeout(force);
    process.exit(0);
  }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
