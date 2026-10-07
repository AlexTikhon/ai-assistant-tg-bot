import type { Context } from "telegraf";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateClaimOutcome, UpdateClaimStore } from "../../src/application/ports/update-claims.js";
import { openDatabase } from "../../src/infrastructure/sqlite/database.js";
import { SqliteUpdateClaimStore } from "../../src/infrastructure/sqlite/sqlite-update-claims.js";
import { AppError, ExternalServiceError } from "../../src/shared/errors.js";
import { OperationCancelledError } from "../../src/shared/operation.js";
import { createUpdateClaimMiddleware, recoverUpdateClaims } from "../../src/telegram/update-claims.js";

const SECRET = "SECRET QUESTION about the merger and sk-proj-AbCdEfGhIjKlMnOpQrStUvWx";

type Entry = { level: string; fields: Record<string, unknown>; message: string };
function captureLog() {
  const entries: Entry[] = [];
  const at = (level: string) => (fields: Record<string, unknown>, message: string) => void entries.push({ level, fields, message });
  return { entries, log: { info: at("info"), warn: at("warn"), error: at("error") } as unknown as Parameters<typeof recoverUpdateClaims>[1] };
}

function context(updateId: unknown, extra: Record<string, unknown> = {}) {
  return {
    botInfo: { id: 1001 },
    update: { update_id: updateId, message: { text: SECRET } },
    message: { text: SECRET },
    answerCbQuery: vi.fn(async () => true),
    reply: vi.fn(async () => undefined),
    ...extra,
  } as unknown as Context & { answerCbQuery: ReturnType<typeof vi.fn>; reply: ReturnType<typeof vi.fn> };
}

let db: ReturnType<typeof openDatabase>;
let store: SqliteUpdateClaimStore;
beforeEach(() => {
  db = openDatabase(":memory:", { legacyEmbeddingModel: "m" });
  store = new SqliteUpdateClaimStore(db);
});
afterEach(() => db.close());

const stateOf = (updateId: number) => db.prepare("SELECT state, error_category AS category FROM telegram_update_claims WHERE update_id = ?").get(updateId);

describe("terminal state from the actual outcome of the chain", () => {
  it.each([
    ["returned normally", async () => undefined, { state: "completed", category: null }],
    ["a user-facing AppError", async () => { throw new AppError("shown to the user", "VALIDATION_ERROR"); }, { state: "completed", category: "rejected" }],
    ["an ExternalServiceError", async () => { throw new ExternalServiceError("openai"); }, { state: "failed", category: "external" }],
    ["any other error", async () => { throw new Error(SECRET); }, { state: "failed", category: "internal" }],
    ["an OperationCancelledError that escaped", async () => { throw new OperationCancelledError(undefined, "shutdown"); }, { state: "interrupted", category: "shutdown" }],
  ])("%s", async (_label, next, expected) => {
    const middleware = createUpdateClaimMiddleware({ store, log: captureLog().log });

    await Promise.resolve(middleware(context(1), next)).catch(() => undefined);

    expect(stateOf(1)).toEqual(expected);
  });

  it("the error is rethrown unchanged so the error boundary still answers the user", async () => {
    const failure = new AppError("Document not found.", "NOT_FOUND");

    await expect(createUpdateClaimMiddleware({ store, log: captureLog().log })(context(1), async () => { throw failure; })).rejects.toBe(failure);
  });
});

describe("duplicates", () => {
  it("do no downstream work and send nothing", async () => {
    const middleware = createUpdateClaimMiddleware({ store, log: captureLog().log });
    await middleware(context(1), async () => undefined);
    const next = vi.fn();
    const duplicate = context(1);

    await middleware(duplicate, next);

    expect(next).not.toHaveBeenCalled();
    expect(duplicate.reply).not.toHaveBeenCalled();
    expect(duplicate.answerCbQuery).not.toHaveBeenCalled();
  });

  it.each([
    ["completed", true],
    ["running", false],
  ])("a callback duplicate of a %s update gets an empty acknowledgement: %s", async (state, acknowledged) => {
    const middleware = createUpdateClaimMiddleware({ store, log: captureLog().log });
    if (state === "completed") await middleware(context(1), async () => undefined);
    else store.claim(1001, 1);
    const duplicate = context(1, { callbackQuery: { id: "cb", data: "fb:g:deadbeef" } });

    await middleware(duplicate, vi.fn());

    expect(duplicate.answerCbQuery.mock.calls).toEqual(acknowledged ? [[]] : []);
  });

  it("a failing acknowledgement is ignored", async () => {
    const middleware = createUpdateClaimMiddleware({ store, log: captureLog().log });
    await middleware(context(1), async () => undefined);
    const duplicate = context(1, { callbackQuery: { id: "cb" }, answerCbQuery: vi.fn(async () => { throw new Error("query is too old"); }) });

    await expect(middleware(duplicate, vi.fn())).resolves.toBeUndefined();
  });
});

describe("fail closed", () => {
  it("a claim that cannot be written stops the chain, tells the user safely, and logs only a category and a code", async () => {
    const { entries, log } = captureLog();
    const broken: UpdateClaimStore = {
      claim: () => { throw Object.assign(new Error(`disk I/O error while storing ${SECRET}`), { code: "SQLITE_IOERR" }); },
      finish: () => false,
      recoverInterrupted: () => 0,
      purgeExpired: () => 0,
      close: () => undefined,
    };
    const next = vi.fn();

    const outcome = createUpdateClaimMiddleware({ store: broken, log })(context(1), next);

    await expect(outcome).rejects.toMatchObject({ code: "UPDATE_ADMISSION_FAILED", message: expect.stringMatching(/try again/) });
    expect(next).not.toHaveBeenCalled();
    expect(entries).toEqual([{ level: "error", fields: { category: "update-claim-failed", code: "SQLITE_IOERR" }, message: expect.any(String) }]);
    expect(JSON.stringify(entries)).not.toContain("SECRET");
  });

  it.each([
    ["missing", undefined],
    ["a string", "12"],
    ["a fraction", 1.5],
    ["unsafe", 2 ** 53],
  ])("an update_id that is %s is refused without running the chain", async (_label, updateId) => {
    const next = vi.fn();

    await expect(createUpdateClaimMiddleware({ store, log: captureLog().log })(context(updateId), next)).rejects.toMatchObject({ code: "UPDATE_ADMISSION_FAILED" });

    expect(next).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) AS n FROM telegram_update_claims").get()).toEqual({ n: 0 });
  });

  it("an update without a bot identity is refused too", async () => {
    const next = vi.fn();

    await expect(createUpdateClaimMiddleware({ store, log: captureLog().log })(context(1, { botInfo: undefined }), next)).rejects.toMatchObject({ code: "UPDATE_ADMISSION_FAILED" });

    expect(next).not.toHaveBeenCalled();
  });

  it("a terminal write that fails neither deletes the claim nor changes the handler's result, and logs only a category", async () => {
    const { entries, log } = captureLog();
    const flaky: UpdateClaimStore = {
      claim: (bot: number, update: number) => store.claim(bot, update),
      finish: () => { throw Object.assign(new Error(`locked ${SECRET}`), { code: "SQLITE_BUSY" }); },
      recoverInterrupted: () => 0,
      purgeExpired: () => 0,
      close: () => undefined,
    };

    await expect(createUpdateClaimMiddleware({ store: flaky, log })(context(1), async () => undefined)).resolves.toBeUndefined();

    expect(stateOf(1)).toEqual({ state: "running", category: null });
    expect(entries.map((entry) => entry.fields)).toEqual([{ updateId: 1, category: "update-claim-finalize-failed", code: "SQLITE_BUSY" }]);
    expect(JSON.stringify(entries)).not.toContain("SECRET");
  });

  it("a finish that finds the claim no longer running only warns", async () => {
    const { entries, log } = captureLog();
    const middleware = createUpdateClaimMiddleware({ store, log });

    await middleware(context(1), async () => { store.finish(1001, 1, { state: "interrupted", category: "shutdown" }); });

    expect(stateOf(1)).toEqual({ state: "interrupted", category: "shutdown" });
    expect(entries.map((entry) => entry.level)).toEqual(["warn"]);
  });
});

describe("what is logged", () => {
  it("never contains the update content, whatever the outcome: only ids, states and categories", async () => {
    const { entries, log } = captureLog();
    const middleware = createUpdateClaimMiddleware({ store, log });
    await middleware(context(1), async () => undefined);
    await middleware(context(1), async () => undefined); // duplicate
    await Promise.resolve(middleware(context(2), async () => { throw new Error(SECRET); })).catch(() => undefined);
    recoverUpdateClaims(store, log);

    expect(JSON.stringify(entries)).not.toMatch(/SECRET|merger|sk-proj/);
    const keys = new Set(entries.flatMap((entry) => Object.keys(entry.fields)));
    expect([...keys].sort()).toEqual(["claimState", "interrupted", "purged", "updateId"]);
  });
});

describe("retention cadence", () => {
  it("runs one bounded cleanup batch after every 256th admitted claim, never on duplicates, and a failing cleanup does not affect the update", async () => {
    const purge = vi.fn(() => 0);
    const counted: UpdateClaimStore = {
      claim: (bot: number, update: number) => store.claim(bot, update),
      finish: (bot: number, update: number, outcome: UpdateClaimOutcome) => store.finish(bot, update, outcome),
      recoverInterrupted: () => 0,
      purgeExpired: purge,
      close: () => undefined,
    };
    const middleware = createUpdateClaimMiddleware({ store: counted, log: captureLog().log });

    for (let id = 1; id <= 255; id += 1) await middleware(context(id), async () => undefined);
    await middleware(context(1), async () => undefined); // a duplicate does not count
    expect(purge).not.toHaveBeenCalled();
    await middleware(context(256), async () => undefined);
    expect(purge.mock.calls).toEqual([[500]]);

    purge.mockImplementation(() => { throw new Error("busy"); });
    for (let id = 257; id <= 512; id += 1) await expect(middleware(context(id), async () => undefined)).resolves.toBeUndefined();
    expect(stateOf(512)).toEqual({ state: "completed", category: null });
  });
});

describe("startup recovery", () => {
  it("interrupts running claims first, then removes expired ones in bounded batches", () => {
    const order: string[] = [];
    const removed = [500, 500, 120];
    const fake: UpdateClaimStore = {
      claim: () => ({ admitted: true }), finish: () => true, close: () => undefined,
      recoverInterrupted: () => { order.push("recover"); return 3; },
      purgeExpired: (limit: number) => { order.push(`purge:${limit}`); return removed.shift() ?? 0; },
    };
    const { entries, log } = captureLog();

    recoverUpdateClaims(fake, log);

    expect(order).toEqual(["recover", "purge:500", "purge:500", "purge:500"]);
    expect(entries[0].fields).toEqual({ interrupted: 3, purged: 1120 });
  });

  it("does not loop forever when every batch comes back full", () => {
    const purge = vi.fn(() => 500);
    const fake = { recoverInterrupted: () => 0, purgeExpired: purge } as unknown as UpdateClaimStore;

    recoverUpdateClaims(fake, captureLog().log);

    expect(purge).toHaveBeenCalledTimes(20);
  });
});
