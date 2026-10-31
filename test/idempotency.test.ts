import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { createMemoryStore, createSqliteStore, DEFAULT_LOCK_TIMEOUT_MS, type Store } from "../src/idempotency.ts";

const TMP = join(import.meta.dirname, "..", ".test-tmp", "idempotency");
mkdirSync(TMP, { recursive: true });
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

function clock() {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

const factories: Array<[string, (now: () => number) => Store]> = [
  ["memory store", (now) => createMemoryStore({ now })],
  ["sqlite store", (now) => createSqliteStore({ db: openDb(), now })],
];

describe.each(factories)("%s", (_name, make) => {
  it("first delivery is acquired; a second while in flight is told so", async () => {
    const store = make(clock().now);
    expect(await store.begin("evt_1")).toBe("acquired");
    expect(await store.begin("evt_1")).toBe("in_flight");
  });

  it("a completed event is a duplicate forever, even after the lock timeout", async () => {
    const c = clock();
    const store = make(c.now);
    await store.begin("evt_1");
    await store.complete("evt_1");
    expect(await store.begin("evt_1")).toBe("done");
    c.advance(DEFAULT_LOCK_TIMEOUT_MS * 10);
    expect(await store.begin("evt_1")).toBe("done");
  });

  it("a failed event can be claimed again, then completed", async () => {
    const store = make(clock().now);
    await store.begin("evt_1");
    await store.fail("evt_1", "boom");
    expect(await store.begin("evt_1")).toBe("acquired");
    await store.complete("evt_1");
    expect(await store.begin("evt_1")).toBe("done");
  });

  it("a crashed worker's lock expires: still in flight just before, reclaimable just after", async () => {
    const c = clock();
    const store = make(c.now);
    await store.begin("evt_1", { lockTimeoutMs: 1000 });
    c.advance(1000);
    expect(await store.begin("evt_1", { lockTimeoutMs: 1000 })).toBe("in_flight");
    c.advance(1);
    expect(await store.begin("evt_1", { lockTimeoutMs: 1000 })).toBe("acquired");
  });

  it("ids are independent", async () => {
    const store = make(clock().now);
    expect(await store.begin("evt_a")).toBe("acquired");
    expect(await store.begin("evt_b")).toBe("acquired");
    await store.complete("evt_a");
    expect(await store.begin("evt_b")).toBe("in_flight");
  });

  it("complete/fail on an id that is not in flight change nothing", async () => {
    const store = make(clock().now);
    await store.complete("evt_unknown");
    await store.fail("evt_unknown");
    expect(await store.begin("evt_unknown")).toBe("acquired");
    await store.complete("evt_unknown");
    await store.fail("evt_unknown", "late failure must not undo done");
    expect(await store.begin("evt_unknown")).toBe("done");
  });

  it("of many simultaneous claims exactly one wins", async () => {
    const store = make(clock().now);
    const results = await Promise.all(Array.from({ length: 25 }, () => store.begin("evt_race")));
    expect(results.filter((r) => r === "acquired")).toHaveLength(1);
    expect(results.filter((r) => r === "in_flight")).toHaveLength(24);
  });
});

describe("sqlite store specifics", () => {
  it("records type, attempts and the last error in processed_events", async () => {
    const db = openDb();
    const c = clock();
    const store = createSqliteStore({ db, now: c.now });
    await store.begin("evt_1", { type: "invoice.paid" });
    await store.fail("evt_1", "boom");
    await store.begin("evt_1");
    expect(db.prepare("SELECT type, status, attempts, last_error FROM processed_events WHERE id = 'evt_1'").get()).toEqual({
      type: "invoice.paid", status: "in_flight", attempts: 2, last_error: "boom",
    });
    await store.complete("evt_1");
    expect(db.prepare("SELECT status, last_error FROM processed_events WHERE id = 'evt_1'").get()).toEqual({ status: "done", last_error: null });
  });

  it("two connections to one database file cannot both claim an event", async () => {
    const file = join(TMP, "shared.db");
    const a = createSqliteStore({ db: openDb(file) });
    const b = createSqliteStore({ db: openDb(file) });
    const results = await Promise.all([a.begin("evt_x"), b.begin("evt_x"), a.begin("evt_x"), b.begin("evt_x")]);
    expect(results.filter((r) => r === "acquired")).toHaveLength(1);
  });

  it("an event left in flight by a process that died is reclaimed by a new process after the timeout", async () => {
    const file = join(TMP, "crash.db");
    const c = clock();
    const first = openDb(file);
    expect(await createSqliteStore({ db: first, now: c.now }).begin("evt_crash")).toBe("acquired");
    first.close(); // the process "dies" before complete()/fail()

    c.advance(DEFAULT_LOCK_TIMEOUT_MS + 1);
    const second = createSqliteStore({ db: openDb(file), now: c.now });
    expect(await second.begin("evt_crash")).toBe("acquired");
  });
});
