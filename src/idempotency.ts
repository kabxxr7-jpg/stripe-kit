import type { Db } from "./db.ts";

/**
 * Event-id dedupe. A delivery is in one of three states:
 *   in_flight  a worker holds it and is running the handler
 *   done       the handler finished; further deliveries of this id are duplicates
 *   failed     the handler threw; the next delivery may run it again
 *
 * `begin` is the only atomic step: it either hands the caller the right to run the handler
 * ("acquired") or says why not.
 */
export type BeginResult = "acquired" | "done" | "in_flight";

export interface Store {
  /**
   * Try to claim `id`. Claims a fresh id, a `failed` id, and an `in_flight` id whose lock is older
   * than `lockTimeoutMs` (a crashed worker must not block an event forever).
   */
  begin(id: string, options?: { lockTimeoutMs?: number; type?: string }): Promise<BeginResult>;
  complete(id: string): Promise<void>;
  fail(id: string, error?: string): Promise<void>;
}

export const DEFAULT_LOCK_TIMEOUT_MS = 5 * 60_000;

/**
 * Single-process only. Fine for tests, local development and one long-lived server; useless across
 * serverless invocations or several instances (use the SQLite store, or your own, there).
 */
export function createMemoryStore(options: { now?: () => number } = {}): Store {
  const now = options.now ?? Date.now;
  const rows = new Map<string, { status: "in_flight" | "done" | "failed"; lockedAt: number }>();

  return {
    async begin(id, opts = {}) {
      // No await between the read and the write: in one process this is atomic.
      const lockTimeoutMs = opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
      const row = rows.get(id);
      if (!row) {
        rows.set(id, { status: "in_flight", lockedAt: now() });
        return "acquired";
      }
      if (row.status === "done") return "done";
      if (row.status === "failed" || now() - row.lockedAt > lockTimeoutMs) {
        rows.set(id, { status: "in_flight", lockedAt: now() });
        return "acquired";
      }
      return "in_flight";
    },
    async complete(id) {
      const row = rows.get(id);
      if (row?.status === "in_flight") rows.set(id, { status: "done", lockedAt: row.lockedAt });
    },
    async fail(id) {
      const row = rows.get(id);
      if (row?.status === "in_flight") rows.set(id, { status: "failed", lockedAt: row.lockedAt });
    },
  };
}

/**
 * Store on the `processed_events` table (see SCHEMA_SQL). Each statement is atomic on its own and
 * `node:sqlite` is synchronous, so the claim is:
 *   1. INSERT ... ON CONFLICT (id) DO NOTHING       -> a changed row means "first delivery"
 *   2. otherwise UPDATE ... WHERE failed OR stale   -> a changed row means "reclaimed"
 * If neither changed a row the id is `done`, or held by a live worker.
 *
 * Several processes can share one database file (SQLite serialises the writes). Limit: the lock is
 * time-based, not fenced. A handler that runs longer than `lockTimeoutMs` can be reclaimed by a
 * second worker, so keep handlers short or raise the timeout.
 */
export function createSqliteStore(options: { db: Db; now?: () => number }): Store {
  const { db } = options;
  const now = options.now ?? Date.now;

  const insert = db.prepare(
    "INSERT INTO processed_events (id, type, status, attempts, locked_at) VALUES (?, ?, 'in_flight', 1, ?) ON CONFLICT (id) DO NOTHING",
  );
  const reclaim = db.prepare(
    "UPDATE processed_events SET status = 'in_flight', attempts = attempts + 1, locked_at = ?, finished_at = NULL " +
      "WHERE id = ? AND (status = 'failed' OR (status = 'in_flight' AND locked_at < ?))",
  );
  const select = db.prepare("SELECT status FROM processed_events WHERE id = ?");
  const complete = db.prepare(
    "UPDATE processed_events SET status = 'done', finished_at = ?, last_error = NULL WHERE id = ? AND status = 'in_flight'",
  );
  const fail = db.prepare(
    "UPDATE processed_events SET status = 'failed', finished_at = ?, last_error = ? WHERE id = ? AND status = 'in_flight'",
  );

  return {
    async begin(id, opts = {}) {
      const lockTimeoutMs = opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
      const at = now();
      if (Number(insert.run(id, opts.type ?? null, at).changes) > 0) return "acquired";
      if (Number(reclaim.run(at, id, at - lockTimeoutMs).changes) > 0) return "acquired";
      const row = select.get(id) as { status: string } | undefined;
      return row?.status === "done" ? "done" : "in_flight";
    },
    async complete(id) {
      complete.run(now(), id);
    },
    async fail(id, error) {
      fail.run(now(), error ?? null, id);
    },
  };
}
