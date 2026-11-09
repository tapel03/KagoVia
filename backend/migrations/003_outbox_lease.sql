-- Outbox rows are claimed with a short lease instead of a long-running transaction, so publishing to
-- Redis never happens while PostgreSQL row locks are held.
ALTER TABLE outbox_events ADD COLUMN locked_until timestamptz;
DROP INDEX outbox_unpublished_idx;
CREATE INDEX outbox_unpublished_idx ON outbox_events (created_at) WHERE published_at IS NULL;
