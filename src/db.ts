import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

/**
 * Schema for the local mirror of the Stripe objects the handlers care about. All money columns are
 * integer minor units plus a lower-case currency. `last_event_created` is Stripe's `event.created`
 * (seconds) of the newest event applied to the row; handlers use it to ignore stale deliveries.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS customers (
  id                 TEXT PRIMARY KEY,
  email              TEXT,
  name               TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id                 TEXT PRIMARY KEY,                -- Checkout Session id (cs_...)
  customer_id        TEXT REFERENCES customers(id),
  mode               TEXT NOT NULL CHECK (mode IN ('payment', 'subscription', 'setup')),
  status             TEXT NOT NULL CHECK (status IN ('pending', 'paid')),
  amount_total       INTEGER NOT NULL CHECK (amount_total >= 0),
  currency           TEXT NOT NULL,
  payment_intent_id  TEXT,
  subscription_id    TEXT,
  client_reference_id TEXT,
  customer_email     TEXT,
  last_event_created INTEGER NOT NULL,
  created_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id                 TEXT PRIMARY KEY,                -- sub_...
  customer_id        TEXT REFERENCES customers(id),
  status             TEXT NOT NULL,                   -- Stripe status, or 'pending' for a stub from checkout
  price_id           TEXT,
  current_period_end INTEGER,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  canceled_at        INTEGER,
  last_event_created INTEGER NOT NULL,                -- 0 for a stub that no subscription event has filled yet
  last_event_id      TEXT,
  created_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  payment_intent_id  TEXT PRIMARY KEY,                -- pi_...
  charge_id          TEXT,                            -- ch_..., known once an event carrying it was processed
  customer_id        TEXT REFERENCES customers(id),
  invoice_id         TEXT,
  amount             INTEGER NOT NULL CHECK (amount >= 0),
  currency           TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('failed', 'succeeded', 'partially_refunded', 'refunded')),
  amount_refunded    INTEGER NOT NULL DEFAULT 0 CHECK (amount_refunded >= 0),
  failure_code       TEXT,
  failure_message    TEXT,
  paid_at            INTEGER,                         -- Stripe object creation time (seconds)
  last_event_created INTEGER NOT NULL,
  last_event_id      TEXT,
  updated_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS payments_charge_id ON payments(charge_id);

CREATE TABLE IF NOT EXISTS refunds (
  id                 TEXT PRIMARY KEY,                -- re_...
  charge_id          TEXT,
  payment_intent_id  TEXT,
  amount             INTEGER NOT NULL CHECK (amount >= 0),
  currency           TEXT NOT NULL,
  status             TEXT,
  reason             TEXT,
  created_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS processed_events (
  id                 TEXT PRIMARY KEY,                -- evt_...
  type               TEXT,
  status             TEXT NOT NULL CHECK (status IN ('in_flight', 'done', 'failed')),
  attempts           INTEGER NOT NULL DEFAULT 1,
  locked_at          INTEGER NOT NULL,                -- epoch ms
  finished_at        INTEGER,
  last_error         TEXT
);
`;

/** Opens (or creates) a database and applies the schema. `":memory:"` for tests. */
export function openDb(path = ":memory:"): Db {
  const db = new DatabaseSync(path);
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA_SQL);
  return db;
}

/** Runs `fn` in one transaction; a throw rolls everything back and is rethrown. */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
