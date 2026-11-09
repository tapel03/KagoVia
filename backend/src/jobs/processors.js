// Job processors. Each one is idempotent: a job delivered twice does no extra harm.
import { UnrecoverableError } from 'bullmq';
import { tx } from '../lib/db.js';
import { renderSvg } from '../domain/svg.js';
import { reconcilePayment } from '../modules/billing/service.js';
import { invalidateCatalogue } from '../modules/materials/routes.js';
import { TOPICS } from '../lib/outbox.js';

async function addEvent(db, pubsub, generationId, type, data = {}) {
  const { rows } = await db.query(
    'INSERT INTO generation_events (generation_id, type, data) VALUES ($1, $2, $3) RETURNING id',
    [generationId, type, data],
  );
  await pubsub.publish(`gen:${generationId}`, { id: rows[0].id, type, data });
}

export function createAiProcessor({ db, pubsub, layouts, log }) {
  return async function processGeneration(job) {
    const { generationId } = job.data;
    const g = await tx(db, async (client) => {
      const row = (await client.query('SELECT * FROM generations WHERE id = $1 FOR UPDATE', [generationId])).rows[0];
      if (!row || row.status === 'succeeded' || row.status === 'failed') return null; // already done
      await client.query(
        "UPDATE generations SET status = 'running', attempts = attempts + 1, started_at = COALESCE(started_at, now()) WHERE id = $1",
        [generationId],
      );
      return row;
    });
    if (!g) return { skipped: true };
    await addEvent(db, pubsub, g.id, 'progress', { stage: 'designing', attempt: job.attemptsMade + 1 });

    const options = await layouts.generate(g.brief, async (o) => {
      const svg = renderSvg(o.spec);
      // Only save while the generation is still ours to finish (the sweeper may have failed it meanwhile).
      const saved = await db.query(
        `INSERT INTO floor_plans (project_id, generation_id, option_label, spec, stats, rules_report, svg, provider, model)
         SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9
          WHERE EXISTS (SELECT 1 FROM generations WHERE id = $2 AND status = 'running')
         ON CONFLICT (generation_id, option_label) DO NOTHING`,
        // JSON.stringify: node-pg would send a JS array as a Postgres array, not JSON.
        [g.project_id, g.id, o.label, JSON.stringify(o.spec), JSON.stringify(o.stats), JSON.stringify(o.report), svg, o.provider, o.model],
      );
      if (saved.rowCount) await addEvent(db, pubsub, g.id, 'option', { option: o.label, provider: o.provider, floorAreaM2: o.stats.floorAreaM2 });
    });

    if (!options.length) {
      // Nothing valid can be produced for this brief (e.g. it does not fit the plot). Retrying will not help.
      throw new UnrecoverableError('no_valid_layout');
    }
    const provider = options.some((o) => o.provider !== 'template') ? options.find((o) => o.provider !== 'template').provider : 'template';
    const finished = await db.query(
      "UPDATE generations SET status = 'succeeded', finished_at = now(), provider = $2, model = $3 WHERE id = $1 AND status = 'running'",
      [g.id, provider, options[0].model],
    );
    if (!finished.rowCount) return { abandoned: true }; // already failed by the sweeper; say nothing more
    await addEvent(db, pubsub, g.id, 'succeeded', { options: options.map((o) => o.label) });
    log?.info({ generationId: g.id, options: options.length, provider }, 'generation done');
    return { options: options.length };
  };
}

// Called by the worker when a job has failed for the last time.
export async function markGenerationFailed({ db, pubsub }, generationId, errorCode) {
  const res = await db.query(
    "UPDATE generations SET status = 'failed', finished_at = now(), error_code = $2 WHERE id = $1 AND status IN ('queued','running') RETURNING id",
    [generationId, String(errorCode).slice(0, 60)],
  );
  if (res.rowCount) {
    const message = errorCode === 'no_valid_layout'
      ? 'We could not fit a valid design on this plot. Try a smaller floor area or a bigger plot.'
      : 'Plan generation failed on our side. Please try again; this attempt does not count towards your monthly limit.';
    await addEvent(db, pubsub, generationId, 'failed', { code: errorCode, message });
  }
}

export function createEventsProcessor({ redis, log }) {
  return async function processEvent(job) {
    if (job.name === TOPICS.CATALOGUE_CHANGED) {
      await invalidateCatalogue(redis, job.data.regionCode);
      return { invalidated: job.data.regionCode };
    }
    if (job.name === TOPICS.PAYMENT_SUCCEEDED) {
      // Hook for receipts/notifications (FR-12, planned). Entitlement was already granted in the payment transaction.
      log?.info({ paymentId: job.data.paymentId }, 'payment succeeded');
      return { ok: true };
    }
    return { ignored: job.name };
  };
}

// Scheduled: asks Paystack about payments stuck in created/pending, oldest first.
// A generation is treated as lost if it never started within this time, or has been running this long since
// its first attempt began. Comfortably above the worst healthy run (3 attempts x model timeouts + backoff).
export const STUCK_GENERATION_MINUTES = 30;

export async function sweepStuckGenerations({ db, pubsub }, minutes = STUCK_GENERATION_MINUTES) {
  const { rows } = await db.query(
    `SELECT id FROM generations
      WHERE (status = 'queued' AND created_at < now() - make_interval(mins => $1))
         OR (status = 'running' AND started_at < now() - make_interval(mins => $1))
      ORDER BY created_at LIMIT 200`,
    [minutes],
  );
  for (const { id } of rows) await markGenerationFailed({ db, pubsub }, id, 'timed_out');
  return rows.length;
}

export function createMaintenanceProcessor({ db, paystack, config, log, pubsub }) {
  return async function processMaintenance(job) {
    if (job.name === 'sweep-generations') {
      const swept = await sweepStuckGenerations({ db, pubsub });
      if (swept) log?.warn({ swept }, 'failed stuck generations');
      return { swept };
    }
    if (job.name !== 'reconcile-payments') return { ignored: job.name };
    if (!config.billing.enabled) return { skipped: 'billing disabled' };
    const { rows } = await db.query(
      `SELECT id FROM payments
        WHERE ((status IN ('created','pending') AND created_at > now() - interval '7 days')
               OR (status = 'failed' AND created_at > now() - interval '24 hours'))
          AND updated_at < now() - make_interval(secs => $1)
        ORDER BY updated_at LIMIT 100`,
      [Math.round(config.workers.reconcilePendingOlderThanMs / 1000)],
    );
    let checked = 0;
    for (const { id } of rows) {
      try {
        await reconcilePayment({ db, paystack }, id);
        checked++;
      } catch (err) {
        log?.warn({ paymentId: id, err: err.message }, 'reconcile failed; will retry next run');
      }
      // Push it to the back of the line so one stubborn payment cannot starve the rest.
      await db.query("UPDATE payments SET updated_at = now() WHERE id = $1 AND status IN ('created','pending','failed')", [id]);
    }
    return { checked, found: rows.length };
  };
}
