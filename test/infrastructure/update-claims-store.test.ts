import type Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvalidUpdateIdentityError, UPDATE_CLAIM_RETENTION_MS } from "../../src/application/ports/update-claims.js";
import { openDatabase } from "../../src/infrastructure/sqlite/database.js";
import { LATEST_SCHEMA_VERSION } from "../../src/infrastructure/sqlite/migrations.js";
import { SqliteUpdateClaimStore } from "../../src/infrastructure/sqlite/sqlite-update-claims.js";

const HOUR = 3_600_000;
const BOT = 777;

let directory: string;
let dbPath: string;
let clock: number;
const opened: Database.Database[] = [];

function open() {
  const db = openDatabase(dbPath, { legacyEmbeddingModel: "m" });
  opened.push(db);
  return db;
}
const storeOn = (db: Database.Database) => new SqliteUpdateClaimStore(db, { now: () => clock });
const rows = (db: Database.Database) => db.prepare("SELECT * FROM telegram_update_claims ORDER BY bot_id, update_id").all() as Array<Record<string, unknown>>;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "tg-bot-claims-"));
  dbPath = path.join(directory, "app.db");
  clock = 1_800_000_000_000;
});
afterEach(() => {
  for (const db of opened.splice(0)) if (db.open) db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("the claim is an atomic admission", () => {
  it("admits the first claim of (bot, update) and reports every later one as a duplicate, with the state it is in", () => {
    const store = storeOn(open());

    expect(store.claim(BOT, 900)).toEqual({ admitted: true });
    expect(store.claim(BOT, 900)).toEqual({ admitted: false, state: "running" });

    store.finish(BOT, 900, { state: "completed" });
    expect(store.claim(BOT, 900)).toEqual({ admitted: false, state: "completed" });
  });

  it("two separate connections racing for the same update: SQLite's uniqueness lets exactly one win", () => {
    const first = storeOn(open());
    const second = storeOn(open());

    const results = [first.claim(BOT, 5), second.claim(BOT, 5), first.claim(BOT, 5), second.claim(BOT, 5)];

    expect(results.filter((result) => result.admitted)).toHaveLength(1);
    expect(rows(opened[0])).toHaveLength(1);
  });

  it("the claim is a single INSERT: nothing is read first, so there is no check-then-insert window", () => {
    const statements: string[] = [];
    const db = open();
    const spy = new Proxy(db, {
      get: (target, property) => {
        if (property !== "prepare") return Reflect.get(target, property, target) as unknown;
        return (sql: string) => { statements.push(sql); return target.prepare(sql); };
      },
    });
    const store = new SqliteUpdateClaimStore(spy, { now: () => clock });

    store.claim(BOT, 1);

    expect(statements.find((sql) => /INSERT/i.test(sql))).toMatch(/ON CONFLICT[\s\S]*DO NOTHING|INSERT OR IGNORE/i);
  });
});

describe("identity is (bot_id, update_id) and nothing else", () => {
  it("the same update_id for two bots is two independent claims", () => {
    const store = storeOn(open());

    expect(store.claim(1, 900).admitted).toBe(true);
    expect(store.claim(2, 900).admitted).toBe(true);
    expect(store.claim(1, 900).admitted).toBe(false);
  });

  it("update ids are not a high-water mark: lower, equal-magnitude and very large ids are each admitted once", () => {
    const store = storeOn(open());

    for (const id of [100, 50, 101, 7, 0, Number.MAX_SAFE_INTEGER, 2 ** 40 + 3]) expect(store.claim(BOT, id)).toEqual({ admitted: true });
    expect(store.claim(BOT, 50).admitted).toBe(false);
    expect(store.claim(BOT, Number.MAX_SAFE_INTEGER).admitted).toBe(false);
    expect(store.claim(BOT, 2 ** 40 + 3).admitted).toBe(false);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a string", "900"],
    ["NaN", Number.NaN],
    ["a fraction", 1.5],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["beyond the safe integer range", 2 ** 53],
    ["a bigint", 10n],
  ])("an update_id that is %s is rejected, never coerced, and writes nothing", (_label, value) => {
    const db = open();
    const store = storeOn(db);

    expect(() => store.claim(BOT, value as never)).toThrow(InvalidUpdateIdentityError);
    expect(rows(db)).toEqual([]);
  });

  it.each([undefined, 0, -1, 1.5, Number.NaN, "7"])("a bot_id of %s is rejected", (value) => {
    const db = open();

    expect(() => storeOn(db).claim(value as never, 1)).toThrow(InvalidUpdateIdentityError);
    expect(rows(db)).toEqual([]);
  });
});

describe("terminal states", () => {
  it("a claim moves from running to exactly one terminal state, once", () => {
    const db = open();
    const store = storeOn(db);
    store.claim(BOT, 1);
    clock += 1_000;

    expect(store.finish(BOT, 1, { state: "failed", category: "external" })).toBe(true);
    expect(store.finish(BOT, 1, { state: "completed" })).toBe(false); // a second finish (e.g. a late completion) changes nothing
    expect(rows(db)).toEqual([{ bot_id: BOT, update_id: 1, state: "failed", claimed_at: clock - 1_000, terminal_at: clock, error_category: "external" }]);
  });

  it("a late finish cannot overwrite an interrupted claim", () => {
    const db = open();
    const store = storeOn(db);
    store.claim(BOT, 1);
    store.finish(BOT, 1, { state: "interrupted", category: "timeout" });

    expect(store.finish(BOT, 1, { state: "completed" })).toBe(false);
    expect(rows(db)[0]).toMatchObject({ state: "interrupted", error_category: "timeout" });
  });

  it("finishing a claim that does not exist is a no-op", () => {
    const db = open();

    expect(storeOn(db).finish(BOT, 404, { state: "completed" })).toBe(false);
    expect(rows(db)).toEqual([]);
  });

  it("refuses a category outside the allowlist (no free-form error text ever reaches the table)", () => {
    const db = open();
    const store = storeOn(db);
    store.claim(BOT, 1);

    expect(() => store.finish(BOT, 1, { state: "failed", category: "SQLITE_ERROR: secret question text" as never })).toThrow();
    expect(rows(db)[0]).toMatchObject({ state: "running", error_category: null });
  });
});

describe("startup recovery", () => {
  it("turns every running claim into interrupted with a fresh terminal time, and touches nothing else", () => {
    const db = open();
    const store = storeOn(db);
    store.claim(BOT, 1);
    store.claim(BOT, 2);
    store.claim(BOT, 3);
    store.finish(BOT, 3, { state: "completed" });
    clock += 10 * HOUR;

    expect(store.recoverInterrupted()).toBe(2);

    expect(rows(db).map((row) => [row.update_id, row.state, row.terminal_at, row.error_category])).toEqual([
      [1, "interrupted", clock, "recovered"],
      [2, "interrupted", clock, "recovered"],
      [3, "completed", clock - 10 * HOUR, null],
    ]);
    expect(store.recoverInterrupted()).toBe(0);
  });

  it("an interrupted claim keeps suppressing the same update", () => {
    const store = storeOn(open());
    store.claim(BOT, 1);
    store.recoverInterrupted();

    expect(store.claim(BOT, 1)).toEqual({ admitted: false, state: "interrupted" });
  });
});

describe("retention (48 hours from claim/terminal/recovery time, bounded batches)", () => {
  it("is 48 hours", () => expect(UPDATE_CLAIM_RETENTION_MS).toBe(48 * HOUR));

  it("keeps terminal claims up to and including 48 hours, deletes older ones", () => {
    const db = open();
    const store = storeOn(db);
    store.claim(BOT, 1); store.finish(BOT, 1, { state: "completed" });
    store.claim(BOT, 2); store.finish(BOT, 2, { state: "failed", category: "internal" });
    clock += 48 * HOUR;
    expect(store.purgeExpired(100)).toBe(0); // exactly 48 h old: still protected

    clock += 1;
    expect(store.purgeExpired(100)).toBe(2);
    expect(rows(db)).toEqual([]);
    expect(store.claim(BOT, 1)).toEqual({ admitted: true }); // past the horizon the id is simply new again
  });

  it("recent terminal claims stay protected while older ones go", () => {
    const db = open();
    const store = storeOn(db);
    store.claim(BOT, 1); store.finish(BOT, 1, { state: "completed" });
    clock += 40 * HOUR;
    store.claim(BOT, 2); store.finish(BOT, 2, { state: "completed" });
    clock += 10 * HOUR; // claim 1 is 50 h old, claim 2 is 10 h old

    expect(store.purgeExpired(100)).toBe(1);
    expect(rows(db).map((row) => row.update_id)).toEqual([2]);
  });

  it("never deletes a running claim, however old", () => {
    const db = open();
    const store = storeOn(db);
    store.claim(BOT, 1);
    clock += 500 * HOUR;

    expect(store.purgeExpired(100)).toBe(0);
    expect(rows(db)).toHaveLength(1);
  });

  it("a recovered claim gets a fresh full horizon from the recovery time, not from when it was claimed", () => {
    const db = open();
    const store = storeOn(db);
    store.claim(BOT, 1);
    clock += 100 * HOUR; // the process was down for a long time
    store.recoverInterrupted();

    expect(store.purgeExpired(100)).toBe(0);
    expect(store.claim(BOT, 1)).toEqual({ admitted: false, state: "interrupted" });
    clock += 48 * HOUR + 1;
    expect(store.purgeExpired(100)).toBe(1);
  });

  it("one call deletes at most `limit` rows, oldest first", () => {
    const db = open();
    const store = storeOn(db);
    for (let id = 1; id <= 5; id += 1) { store.claim(BOT, id); store.finish(BOT, id, { state: "completed" }); clock += 1; }
    clock += 49 * HOUR;

    expect(store.purgeExpired(2)).toBe(2);
    expect(rows(db).map((row) => row.update_id)).toEqual([3, 4, 5]);
    expect(store.purgeExpired(2)).toBe(2);
    expect(store.purgeExpired(2)).toBe(1);
  });

  it("the cleanup is served by an index on the terminal time, not a table scan", () => {
    const db = open();
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT bot_id, update_id FROM telegram_update_claims WHERE terminal_at < ? ORDER BY terminal_at LIMIT 10").all(1) as Array<{ detail: string }>;

    expect(plan.map((row) => row.detail).join(" ")).toMatch(/USING (COVERING )?INDEX idx_update_claims_terminal/);
  });
});

describe("data minimization", () => {
  it("the table has only identity, state, timestamps and an allowlisted category", () => {
    const db = open();

    const columns = (db.prepare("PRAGMA table_info(telegram_update_claims)").all() as Array<{ name: string }>).map((column) => column.name);

    expect(columns).toEqual(["bot_id", "update_id", "state", "claimed_at", "terminal_at", "error_category"]);
  });

  it("the schema itself refuses inconsistent rows", () => {
    const db = open();
    const insert = (values: string) => db.exec(`INSERT INTO telegram_update_claims (bot_id, update_id, state, claimed_at, terminal_at, error_category) VALUES ${values}`);

    expect(() => insert("(1, 1, 'bogus', 1, NULL, NULL)")).toThrow(/CHECK/);
    expect(() => insert("(1, 2, 'running', 1, 5, NULL)")).toThrow(/CHECK/); // running with a terminal time
    expect(() => insert("(1, 3, 'completed', 1, NULL, NULL)")).toThrow(/CHECK/); // terminal without a terminal time
    expect(() => insert("(1, 4, 'failed', 1, 2, 'free text with a question')")).toThrow(/CHECK/);
    expect(() => insert("(0, 5, 'running', 1, NULL, NULL)")).toThrow(/CHECK/);
    expect(() => insert("(1, 6, 'running', 1, NULL, NULL), (1, 6, 'running', 1, NULL, NULL)")).toThrow(/UNIQUE|PRIMARY/);
  });
});

describe("a closed store", () => {
  it("refuses new claims and silently ignores a late finish without touching SQLite", () => {
    const db = open();
    const store = storeOn(db);
    store.claim(BOT, 1);

    store.close();
    db.close();

    expect(() => store.claim(BOT, 2)).toThrow(/closed/);
    expect(store.finish(BOT, 1, { state: "completed" })).toBe(false);
    expect(store.recoverInterrupted).toBeTypeOf("function");
  });
});

describe("migration 11", () => {
  it("creates the table and index on a fresh database", () => {
    const db = open();

    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(11);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('telegram_update_claims','idx_update_claims_terminal') ORDER BY name").all()).toEqual([
      { name: "idx_update_claims_terminal" },
      { name: "telegram_update_claims" },
    ]);
  });

  it("upgrades a version-10 database in place, keeping its documents", () => {
    const old = open();
    old.exec("INSERT INTO documents(id,user_id,file_name,stored_name,file_size,text_length,summary,created_at) VALUES('d','u','a.txt','a.txt',3,3,'kept','2026-10-05')");
    old.exec("DROP TABLE telegram_update_claims; PRAGMA user_version = 10");
    old.close();

    const upgraded = open();

    expect(upgraded.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    expect(upgraded.prepare("SELECT summary FROM documents").all()).toEqual([{ summary: "kept" }]);
    expect(storeOn(upgraded).claim(BOT, 1)).toEqual({ admitted: true });
  });

  it("is idempotent when reopened, and keeps existing claims", () => {
    const first = open();
    storeOn(first).claim(BOT, 1);
    first.close();

    const second = open();

    expect(storeOn(second).claim(BOT, 1)).toEqual({ admitted: false, state: "running" });
  });
});
