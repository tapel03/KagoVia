// Transactional outbox: call writeOutbox with the SAME client as the business change, inside its transaction.
// The outbox relay (src/jobs/outbox-relay.js) publishes rows to BullMQ afterwards.

export const TOPICS = Object.freeze({
  GENERATION_REQUESTED: 'generation.requested',
  PAYMENT_SUCCEEDED: 'payment.succeeded',
  CATALOGUE_CHANGED: 'catalogue.changed',
});

export async function writeOutbox(client, topic, payload) {
  if (!Object.values(TOPICS).includes(topic)) throw new Error(`Unknown outbox topic ${topic}`);
  const { rows } = await client.query(
    'INSERT INTO outbox_events (topic, payload) VALUES ($1, $2) RETURNING id',
    [topic, payload],
  );
  return rows[0].id;
}
