// Wires queues, workers, the outbox relay and schedules. Used by src/worker.js and by tests.
import { Queue, Worker } from 'bullmq';
import { bullConnection } from '../lib/redis.js';
import { PubSub } from '../lib/pubsub.js';
import { createLayoutService } from '../ai/provider.js';
import { QUEUES } from './queues.js';
import { startRelay } from './outbox-relay.js';
import { createAiProcessor, createEventsProcessor, createMaintenanceProcessor, markGenerationFailed } from './processors.js';

export async function startWorkers({ config, db, redis, paystack, log, layouts, concurrency = {} }) {
  // BullMQ does not close connections it is given, so keep track and close them on shutdown.
  const connections = [];
  const conn = () => {
    const c = bullConnection(config.redisUrl);
    connections.push(c);
    return c;
  };
  const pubsub = new PubSub(redis, redis, log); // publish only in workers
  const queues = Object.fromEntries(Object.values(QUEUES).map((name) => [name, new Queue(name, { connection: conn() })]));
  const layoutService = layouts ?? createLayoutService({ aiConfig: config.ai, log });

  const recordDeadLetter = async (queue, job, err) => {
    await db.query(
      `INSERT INTO dead_letters (queue, job_id, payload, error, attempts) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (queue, job_id) DO UPDATE SET error = EXCLUDED.error, attempts = EXCLUDED.attempts`,
      [queue, String(job.id), job.data, String(err?.message || err).slice(0, 1000), job.attemptsMade],
    ).catch((e) => log?.error({ err: e.message }, 'could not record dead letter'));
  };
  // Last attempt or unrecoverable. Jobs that stall too often do not reach this handler at all in BullMQ 5;
  // the 'sweep-generations' schedule is the safety net for those.
  const isFinal = (job, err) => err?.name === 'UnrecoverableError' || !!job.finishedOn || job.attemptsMade >= (job.opts.attempts ?? 1);

  const workers = [
    new Worker(QUEUES.AI, createAiProcessor({ db, pubsub, layouts: layoutService, log }), {
      connection: conn(), concurrency: concurrency.ai ?? 10, lockDuration: 120_000,
    }),
    new Worker(QUEUES.EVENTS, createEventsProcessor({ redis, log }), { connection: conn(), concurrency: concurrency.events ?? 5 }),
    new Worker(QUEUES.MAINTENANCE, createMaintenanceProcessor({ db, paystack, config, log, pubsub }), { connection: conn(), concurrency: 1 }),
  ];

  for (const w of workers) {
    w.on('failed', async (job, err) => {
      if (!job) return;
      log?.warn({ queue: w.name, jobId: job.id, attempt: job.attemptsMade, err: err?.message }, 'job failed');
      if (!isFinal(job, err)) return;
      await recordDeadLetter(w.name, job, err);
      if (w.name === QUEUES.AI) await markGenerationFailed({ db, pubsub }, job.data.generationId, err?.message === 'no_valid_layout' ? 'no_valid_layout' : 'generation_error');
    });
    w.on('error', (err) => log?.error({ queue: w.name, err: err.message }, 'worker error'));
  }

  // Repeating reconciliation of stuck payments (one schedule, no matter how many worker copies run).
  await queues[QUEUES.MAINTENANCE].upsertJobScheduler('reconcile-payments', { every: config.workers.reconcileEveryMs }, { name: 'reconcile-payments' });
  // Safety net: generations whose job was lost (e.g. Redis failover) are failed instead of hanging forever.
  await queues[QUEUES.MAINTENANCE].upsertJobScheduler('sweep-generations', { every: 5 * 60_000 }, { name: 'sweep-generations' });

  const stopRelay = startRelay(db, queues, log, { intervalMs: config.workers.outboxPollMs });

  return {
    queues,
    workers,
    async close() {
      stopRelay();
      await Promise.all(workers.map((w) => w.close()));
      await Promise.all(Object.values(queues).map((q) => q.close()));
      await Promise.all(connections.map((c) => c.quit().catch(() => c.disconnect())));
    },
  };
}
