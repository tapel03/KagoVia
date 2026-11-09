// Moves committed outbox rows into BullMQ.
// 1. Claim a batch with a short lease (one quick statement; SKIP LOCKED lets several workers share the work).
// 2. Publish each row to Redis OUTSIDE any database transaction, with a timeout.
// 3. Mark it published. If a worker dies between 2 and 3, the lease expires and the row is published again;
//    the BullMQ job id is the outbox id, so that cannot create a second job, and processors are idempotent.
import { TOPIC_QUEUE, JOB_DEFAULTS } from './queues.js';

const LEASE_SECONDS = 30;
const PUBLISH_TIMEOUT_MS = 5000;
const RETRY_AFTER_SECONDS = 5;

const withTimeout = (promise, ms) => {
  let timer;
  return Promise.race([promise, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('publish timeout')), ms); })])
    .finally(() => clearTimeout(timer));
};

export async function relayOnce(db, queues, log, { batch = 50 } = {}) {
  const { rows } = await db.query(
    `UPDATE outbox_events SET locked_until = now() + make_interval(secs => $2), attempts = attempts + 1
      WHERE id IN (SELECT id FROM outbox_events
                    WHERE published_at IS NULL AND (locked_until IS NULL OR locked_until < now())
                    ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING id, topic, payload, created_at`,
    [batch, LEASE_SECONDS],
  );
  rows.sort((a, b) => a.created_at - b.created_at);
  let published = 0;
  for (const row of rows) {
    try {
      const queue = queues[TOPIC_QUEUE[row.topic]];
      if (!queue) throw new Error(`no queue for topic ${row.topic}`);
      await withTimeout(queue.add(row.topic, { ...row.payload, outboxId: row.id }, { ...JOB_DEFAULTS, jobId: row.id }), PUBLISH_TIMEOUT_MS);
      await db.query('UPDATE outbox_events SET published_at = now(), locked_until = NULL, last_error = NULL WHERE id = $1', [row.id]);
      published++;
    } catch (err) {
      await db.query(
        'UPDATE outbox_events SET last_error = $2, locked_until = now() + make_interval(secs => $3) WHERE id = $1',
        [row.id, String(err.message).slice(0, 500), RETRY_AFTER_SECONDS],
      ).catch(() => {});
      log?.warn({ err: err.message, id: row.id }, 'outbox publish failed; will retry');
    }
  }
  return published;
}

export function startRelay(db, queues, log, { intervalMs = 1000 } = {}) {
  let stopped = false;
  let timer;
  const tick = async () => {
    if (stopped) return;
    let n = 0;
    try {
      n = await relayOnce(db, queues, log);
    } catch (err) {
      log?.error({ err: err.message }, 'outbox relay error');
    }
    if (!stopped) timer = setTimeout(tick, n > 0 ? 0 : intervalMs); // drain quickly when busy
  };
  timer = setTimeout(tick, 0);
  return () => { stopped = true; clearTimeout(timer); };
}
