import { TOPICS } from '../lib/outbox.js';

export const QUEUES = Object.freeze({
  AI: 'ai-generation',
  EVENTS: 'domain-events',
  MAINTENANCE: 'maintenance',
});

// Which queue each outbox topic goes to.
export const TOPIC_QUEUE = Object.freeze({
  [TOPICS.GENERATION_REQUESTED]: QUEUES.AI,
  [TOPICS.PAYMENT_SUCCEEDED]: QUEUES.EVENTS,
  [TOPICS.CATALOGUE_CHANGED]: QUEUES.EVENTS,
});

export const JOB_DEFAULTS = Object.freeze({
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { age: 24 * 3600, count: 10000 },
  removeOnFail: { age: 7 * 24 * 3600 },
});
