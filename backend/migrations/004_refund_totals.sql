-- Refunds can arrive in several parts; keep the running total so partial refunds add up correctly.
ALTER TABLE payments ADD COLUMN refunded_cents bigint NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0);

-- Each provider refund is counted once, even if its webhook is re-sent with different bytes.
CREATE TABLE payment_refunds (
  provider     text NOT NULL,
  refund_id    text NOT NULL,
  payment_id   uuid NOT NULL REFERENCES payments(id),
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, refund_id)
);
