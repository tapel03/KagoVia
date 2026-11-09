-- KagoBuild operational schema (PostgreSQL 15+). Money is bigint cents. Quantities are numeric(14,3).
-- Users live in Supabase Auth; app_users only mirrors the id and email for ownership and support.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------- Identity and access ----------
CREATE TABLE app_users (
  id            uuid PRIMARY KEY,                 -- Supabase JWT "sub"
  email         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);

CREATE TABLE user_roles (
  user_id    uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('customer','supplier','support','admin','super_admin')),
  granted_by uuid REFERENCES app_users(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role)
);

-- ---------- Reference data and catalogue ----------
CREATE TABLE regions (
  code           text PRIMARY KEY,                -- e.g. 'GP', 'WC'
  name           text NOT NULL,
  currency       text NOT NULL DEFAULT 'ZAR' CHECK (currency = 'ZAR'),
  labour_bp      integer NOT NULL CHECK (labour_bp BETWEEN 0 AND 10000),      -- labour as % of materials, basis points
  is_active      boolean NOT NULL DEFAULT true
);

CREATE TABLE material_categories (
  code text PRIMARY KEY,
  name text NOT NULL
);

CREATE TABLE materials (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         text NOT NULL UNIQUE,              -- what the take-off engine asks for, e.g. 'brick_stock'
  name         text NOT NULL,
  category     text NOT NULL REFERENCES material_categories(code),
  unit         text NOT NULL,                     -- 'each', 'm2', 'm3', 'kg', 'bag', 'm'
  wastage_bp   integer NOT NULL DEFAULT 0 CHECK (wastage_bp BETWEEN 0 AND 5000),
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX materials_category_idx ON materials (category) WHERE is_active;

CREATE TABLE suppliers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  source_type text NOT NULL CHECK (source_type IN ('api','feed','manual')),
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Latest approved price per material, supplier and region. Estimates read this.
CREATE TABLE current_prices (
  material_id  uuid NOT NULL REFERENCES materials(id),
  supplier_id  uuid NOT NULL REFERENCES suppliers(id),
  region_code  text NOT NULL REFERENCES regions(code),
  price_cents  bigint NOT NULL CHECK (price_cents > 0),
  observed_at  timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (material_id, supplier_id, region_code)
);
CREATE INDEX current_prices_lookup_idx ON current_prices (region_code, material_id, price_cents);

-- Append-only history. Partition by month once it grows (see Scalability doc).
CREATE TABLE price_history (
  id           bigserial PRIMARY KEY,
  material_id  uuid NOT NULL REFERENCES materials(id),
  supplier_id  uuid NOT NULL REFERENCES suppliers(id),
  region_code  text NOT NULL REFERENCES regions(code),
  price_cents  bigint NOT NULL CHECK (price_cents > 0),
  observed_at  timestamptz NOT NULL,
  source       text NOT NULL CHECK (source IN ('api','feed','manual')),
  recorded_by  uuid REFERENCES app_users(id),
  recorded_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX price_history_material_idx ON price_history (material_id, region_code, observed_at DESC);

-- Price changes larger than the allowed swing wait here for approval (TRD §7 validation gate).
CREATE TABLE price_reviews (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  material_id        uuid NOT NULL REFERENCES materials(id),
  supplier_id        uuid NOT NULL REFERENCES suppliers(id),
  region_code        text NOT NULL REFERENCES regions(code),
  old_price_cents    bigint,
  new_price_cents    bigint NOT NULL CHECK (new_price_cents > 0),
  change_bp          integer,
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  requested_by       uuid REFERENCES app_users(id),
  decided_by         uuid REFERENCES app_users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  decided_at         timestamptz
);
CREATE INDEX price_reviews_pending_idx ON price_reviews (created_at) WHERE status = 'pending';

-- Versioned estimating percentages per region. The newest active row applies; estimates copy the values.
CREATE TABLE estimation_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  region_code     text NOT NULL REFERENCES regions(code),
  version         integer NOT NULL,
  contingency_bp  integer NOT NULL CHECK (contingency_bp BETWEEN 0 AND 5000),
  vat_bp          integer NOT NULL CHECK (vat_bp BETWEEN 0 AND 5000),
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (region_code, version)
);

-- ---------- Projects ----------
CREATE TABLE projects (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      uuid NOT NULL REFERENCES app_users(id),
  name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  region_code   text NOT NULL REFERENCES regions(code),
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','approved','archived')),
  brief         jsonb NOT NULL DEFAULT '{}'::jsonb,
  budget_cents  bigint CHECK (budget_cents IS NULL OR budget_cents >= 0),
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);
CREATE INDEX projects_owner_idx ON projects (owner_id, updated_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE project_members (
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES app_users(id),
  role        text NOT NULL CHECK (role IN ('viewer','editor')),
  added_by    uuid NOT NULL REFERENCES app_users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX project_members_user_idx ON project_members (user_id);

-- ---------- AI generation and plans ----------
CREATE TABLE generations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       uuid NOT NULL REFERENCES projects(id),
  user_id          uuid NOT NULL REFERENCES app_users(id),
  idempotency_key  uuid NOT NULL,
  brief            jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed')),
  attempts         integer NOT NULL DEFAULT 0,
  provider         text,
  model            text,
  error_code       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz,
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX generations_user_month_idx ON generations (user_id, created_at);
CREATE INDEX generations_project_idx ON generations (project_id, created_at DESC);

-- Progress events; serial id doubles as the SSE event id for replay.
CREATE TABLE generation_events (
  id             bigserial PRIMARY KEY,
  generation_id  uuid NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
  type           text NOT NULL CHECK (type IN ('queued','progress','option','succeeded','failed')),
  data           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX generation_events_gen_idx ON generation_events (generation_id, id);

-- Immutable plan versions. A refinement creates a new row pointing at its parent.
CREATE TABLE floor_plans (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       uuid NOT NULL REFERENCES projects(id),
  generation_id    uuid REFERENCES generations(id),
  option_label     text NOT NULL CHECK (option_label IN ('A','B','C')),
  version          integer NOT NULL DEFAULT 1,
  parent_id        uuid REFERENCES floor_plans(id),
  spec             jsonb NOT NULL,
  stats            jsonb NOT NULL,
  rules_report     jsonb NOT NULL,
  svg              text NOT NULL,
  provider         text NOT NULL,
  model            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (generation_id, option_label)
);
CREATE INDEX floor_plans_project_idx ON floor_plans (project_id, created_at DESC);

-- ---------- Estimates ----------
CREATE TABLE estimates (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id             uuid NOT NULL REFERENCES projects(id),
  plan_id                uuid NOT NULL REFERENCES floor_plans(id),
  created_by             uuid NOT NULL REFERENCES app_users(id),
  region_code            text NOT NULL REFERENCES regions(code),
  takeoff_version        text NOT NULL,
  rules_version          integer NOT NULL,
  labour_bp              integer NOT NULL,
  contingency_bp         integer NOT NULL,
  vat_bp                 integer NOT NULL,
  materials_cents        bigint NOT NULL,
  labour_cents           bigint NOT NULL,
  contingency_cents      bigint NOT NULL,
  subtotal_cents         bigint NOT NULL,
  vat_cents              bigint NOT NULL,
  total_cents            bigint NOT NULL,
  unpriced_lines         integer NOT NULL DEFAULT 0,
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX estimates_project_idx ON estimates (project_id, created_at DESC);

CREATE TABLE estimate_lines (
  id                 bigserial PRIMARY KEY,
  estimate_id        uuid NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
  line_no            integer NOT NULL,
  component          text NOT NULL,
  material_id        uuid REFERENCES materials(id),
  material_code      text NOT NULL,
  description        text NOT NULL,
  unit               text NOT NULL,
  quantity           numeric(14,3) NOT NULL CHECK (quantity >= 0),
  supplier_id        uuid REFERENCES suppliers(id),
  unit_price_cents   bigint,
  price_observed_at  timestamptz,
  line_total_cents   bigint,
  status             text NOT NULL CHECK (status IN ('priced','unpriced')),
  UNIQUE (estimate_id, line_no)
);

-- ---------- Billing ----------
CREATE TABLE plan_catalog (
  code                         text PRIMARY KEY,
  name                         text NOT NULL,
  price_cents                  bigint NOT NULL CHECK (price_cents > 0),
  currency                     text NOT NULL DEFAULT 'ZAR' CHECK (currency = 'ZAR'),
  period_days                  integer NOT NULL CHECK (period_days > 0),
  monthly_ai_generations       integer NOT NULL CHECK (monthly_ai_generations >= 0),
  is_active                    boolean NOT NULL DEFAULT false,
  created_at                   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES app_users(id),
  plan_code            text NOT NULL REFERENCES plan_catalog(code),
  idempotency_key      uuid NOT NULL,
  amount_cents         bigint NOT NULL CHECK (amount_cents > 0),
  currency             text NOT NULL CHECK (currency = 'ZAR'),
  status               text NOT NULL DEFAULT 'created'
                       CHECK (status IN ('created','pending','succeeded','failed','cancelled','refunded','partially_refunded','disputed')),
  provider             text NOT NULL DEFAULT 'paystack',
  provider_reference   text UNIQUE,              -- we use the payment id as the Paystack reference
  checkout_url         text,
  last_verified_at     timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX payments_user_idx ON payments (user_id, created_at DESC);
CREATE INDEX payments_pending_idx ON payments (updated_at) WHERE status IN ('created','pending');

-- Every provider event once (digest of the raw body) for dedup and audit.
CREATE TABLE payment_events (
  id            bigserial PRIMARY KEY,
  payment_id    uuid REFERENCES payments(id),
  provider      text NOT NULL,
  event_type    text NOT NULL,
  digest        text NOT NULL,
  payload       jsonb NOT NULL,
  outcome       text NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, digest)
);

CREATE TABLE entitlements (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES app_users(id),
  plan_code    text NOT NULL REFERENCES plan_catalog(code),
  payment_id   uuid NOT NULL UNIQUE REFERENCES payments(id),   -- one entitlement per payment, ever
  starts_at    timestamptz NOT NULL,
  ends_at      timestamptz NOT NULL,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX entitlements_user_idx ON entitlements (user_id, ends_at DESC);

-- ---------- Chat ----------
CREATE TABLE chats (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN ('support','project')),
  project_id  uuid REFERENCES projects(id),
  subject     text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 160),
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_by  uuid NOT NULL REFERENCES app_users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz,
  CHECK ((kind = 'project') = (project_id IS NOT NULL))
);
CREATE INDEX chats_support_open_idx ON chats (last_message_at DESC NULLS LAST) WHERE kind = 'support' AND status = 'open';

CREATE TABLE chat_participants (
  chat_id   uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id   uuid NOT NULL REFERENCES app_users(id),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_id, user_id)
);
CREATE INDEX chat_participants_user_idx ON chat_participants (user_id);

CREATE TABLE chat_messages (
  id             bigserial PRIMARY KEY,
  chat_id        uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  sender_id      uuid NOT NULL REFERENCES app_users(id),
  client_msg_id  uuid NOT NULL,
  body           text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chat_id, sender_id, client_msg_id)
);
CREATE INDEX chat_messages_chat_idx ON chat_messages (chat_id, id DESC);

-- ---------- Reliability ----------
CREATE TABLE outbox_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic         text NOT NULL,
  payload       jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz,
  attempts      integer NOT NULL DEFAULT 0,
  last_error    text
);
CREATE INDEX outbox_unpublished_idx ON outbox_events (created_at) WHERE published_at IS NULL;

CREATE TABLE dead_letters (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue       text NOT NULL,
  job_id      text NOT NULL,
  payload     jsonb NOT NULL,
  error       text NOT NULL,
  attempts    integer NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE (queue, job_id)
);

-- Append-only: the runtime role gets INSERT and SELECT only (see 900_runtime_role.sql.example).
CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  actor_id    uuid REFERENCES app_users(id),
  action      text NOT NULL,
  target      text,
  ip          inet,
  details     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_created_idx ON audit_log (created_at DESC);
