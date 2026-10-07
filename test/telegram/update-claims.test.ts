import Database from "better-sqlite3";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { Telegraf } from "telegraf";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatModel } from "../../src/application/ports/chat-model.js";
import { createOfflineProviders } from "../../src/cli/smoke-providers.js";
import { createApplication, createCore, createIntegrityTool } from "../../src/composition-root.js";
import type { Application, Providers } from "../../src/composition-root.js";
import { loadConfig, loadCoreConfig, loadToolConfig } from "../../src/config/config.js";
import { ExternalServiceError } from "../../src/shared/errors.js";

/**
 * Durable update admission, end to end: the REAL Telegraf client and routing, the real use cases, real SQLite files and a fake Bot API on
 * loopback. Only the OpenAI-backed providers are offline fakes. Failures are injected with SQLite triggers and held HTTP responses; a "crash"
 * is an application that is closed while its handler is still in flight (so its claim never reaches a terminal state).
 */
const TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawX";
const ROTATED_TOKEN = "123456789:AAFreshlyRotatedTokenNotTheSameAsBefore1";
const HOUR = 3_600_000;
const QUESTION = "When does the nightly backup run?";
const HANDBOOK = Buffer.from("# Operations handbook\n\n## Backups\nThe nightly backup runs at 02:00 UTC and keeps seven daily copies.\n");
const ANSWER = "Based on your documents, here is the answer [1].";

type ApiCall = { method: string; payload: Record<string, unknown> };
const calls: ApiCall[] = [];
/** Bot API methods whose response is currently being held back (in the order they arrived). */
const waiting: string[] = [];
const downloads = new Map<string, Buffer>();
const holds = new Map<string, { gate: Promise<void>; recordFirst: boolean }>();
let server: http.Server;
let apiRoot: string;

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Holds the response of one Bot API method until released. `recordFirst`: the call is already recorded (Telegram "accepted" it) while the response is held. */
function hold(method: string, recordFirst = false) {
  const gate = deferred();
  holds.set(method, { gate: gate.promise, recordFirst });
  const release = () => { holds.delete(method); gate.resolve(); };
  releasers.push(release);
  return release;
}
const releasers: Array<() => void> = [];

beforeAll(async () => {
  server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => void (async () => {
      const fileMatch = /^\/file\/bot[^/]+\/(.*)$/.exec(url.pathname);
      if (request.method === "GET" && fileMatch) {
        const bytes = downloads.get(fileMatch[1]);
        response.writeHead(bytes ? 200 : 404, { "content-type": "application/octet-stream" });
        response.end(bytes ?? "");
        return;
      }
      const method = url.pathname.split("/").pop() ?? "";
      const payload = chunks.length > 0 ? (JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>) : {};
      const held = holds.get(method);
      if (held) waiting.push(method);
      if (held && !held.recordFirst) await held.gate;
      calls.push({ method, payload });
      if (held?.recordFirst) await held.gate;
      const result =
        method === "getFile"
          ? { file_id: payload.file_id, file_unique_id: "u", file_path: `documents/${payload.file_id}` }
          : method === "sendMessage"
            ? { message_id: calls.length, date: 0, chat: { id: payload.chat_id, type: "private" }, text: payload.text }
            : true;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, result }));
    })());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  apiRoot = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));

let root: string;
let apps: Application[] = [];
let app: Application;
let bot: Telegraf;
let providers: ReturnType<typeof createOfflineProviders>;
let clock: number;
let nextUpdateId: number;

type StartOptions = { providers?: Partial<Providers>; env?: Record<string, string>; botId?: number };

/** Builds the bot application on the test's data directory. Calling it again is "restarting the process". */
function start(options: StartOptions = {}) {
  providers = createOfflineProviders();
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: TOKEN,
    OPENAI_API_KEY: "sk-test-not-a-real-key-0123456789",
    DATA_DIR: path.join(root, "data"),
    OPENAI_EMBEDDINGS_MODEL: "smoke-hashed-v1",
    CHUNK_SIZE: "300",
    CHUNK_OVERLAP: "40",
    RATE_LIMIT_REQUESTS: "1000",
    HANDLER_TIMEOUT_MS: "20000",
    ...options.env,
  });
  app = createApplication(config, { ...providers, ...options.providers }, { apiRoot }, { now: () => clock });
  apps.push(app);
  bot = app.bot;
  bot.botInfo = { id: options.botId ?? 1001, is_bot: true, first_name: "Test", username: "test_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false };
  return app;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tg-bot-claims-app-"));
  calls.length = 0;
  waiting.length = 0;
  downloads.clear();
  holds.clear();
  clock = 1_800_000_000_000;
  nextUpdateId = 1;
  apps = [];
  start();
});
afterEach(async () => {
  for (const release of releasers.splice(0)) release();
  await new Promise<void>((resolve) => setTimeout(resolve, 20)); // let abandoned handlers settle before their storage goes away
  for (const each of apps) { try { await each.drain(); each.close(); } catch { /* already closed */ } }
  fs.rmSync(root, { recursive: true, force: true });
});

const sender = (userId: number) => ({ id: userId, is_bot: false, first_name: `User${userId}` });
const privateChat = (userId: number) => ({ id: userId, type: "private" as const });

function textUpdate(text: string, options: { userId?: number; updateId?: number } = {}) {
  const userId = options.userId ?? 42;
  const updateId = options.updateId ?? nextUpdateId++;
  const command = /^\/\S+/.exec(text);
  return {
    update_id: updateId,
    message: {
      message_id: updateId, date: 1_700_000_000, chat: privateChat(userId), from: sender(userId), text,
      ...(command ? { entities: [{ type: "bot_command", offset: 0, length: command[0].length }] } : {}),
    },
  };
}

function documentUpdate(fileName: string, data: Buffer, options: { userId?: number; updateId?: number; caption?: string } = {}) {
  const userId = options.userId ?? 42;
  const updateId = options.updateId ?? nextUpdateId++;
  const fileId = `file-${updateId}`;
  downloads.set(`documents/${fileId}`, data);
  const command = options.caption ? /^\/\S+/.exec(options.caption) : null;
  return {
    update_id: updateId,
    message: {
      message_id: updateId, date: 1_700_000_000, chat: privateChat(userId), from: sender(userId),
      document: { file_id: fileId, file_unique_id: `u-${fileId}`, file_name: fileName, mime_type: "application/octet-stream", file_size: data.byteLength },
      ...(options.caption ? { caption: options.caption } : {}),
      ...(command ? { caption_entities: [{ type: "bot_command", offset: 0, length: command[0].length }] } : {}),
    },
  };
}

const send = (update: object) => bot.handleUpdate(update as never);
const replies = () => calls.filter((call) => call.method === "sendMessage").map((call) => String(call.payload.text));
const methods = (method: string) => calls.filter((call) => call.method === method);
const idFrom = (reply: string) => /Document ID: (\S+)/.exec(reply)?.[1] ?? "";
const dbPath = () => path.join(root, "data", "app.db");

async function upload(userId = 42, fileName = "handbook.md", data = HANDBOOK) {
  await send(documentUpdate(fileName, data, { userId }));
  return idFrom(replies().at(-1) ?? "");
}

function withDb<T>(action: (db: Database.Database) => T, readonly = true): T {
  const db = new Database(dbPath(), { readonly, fileMustExist: true });
  db.pragma("busy_timeout = 2000");
  try { return action(db); } finally { db.close(); }
}
type ClaimRow = { bot_id: number; update_id: number; state: string; claimed_at: number; terminal_at: number | null; error_category: string | null };
const claimRows = () => withDb((db) => db.prepare("SELECT * FROM telegram_update_claims ORDER BY bot_id, update_id").all() as ClaimRow[]);
const claimOf = (updateId: number, botId = 1001) => claimRows().find((row) => row.update_id === updateId && row.bot_id === botId);
const stateOf = (updateId: number, botId = 1001) => {
  const row = claimOf(updateId, botId);
  return row ? { state: row.state, category: row.error_category } : undefined;
};
const documentCount = () => withDb((db) => (db.prepare("SELECT COUNT(*) AS n FROM documents").get() as { n: number }).n);

/** Makes a statement kind on the ledger table fail, like a full disk or a locked database would. */
function breakLedger(kind: "INSERT" | "UPDATE") {
  withDb((db) => db.exec(`CREATE TRIGGER fail_claim_${kind.toLowerCase()} BEFORE ${kind} ON telegram_update_claims BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`), false);
}
const repairLedger = (kind: "INSERT" | "UPDATE") => withDb((db) => db.exec(`DROP TRIGGER fail_claim_${kind.toLowerCase()}`), false);

/** A chat model that blocks (until released) on prompts matching `shouldHold`, and records every call. */
function gatedChat(shouldHold: (prompt: string) => boolean = () => true) {
  const gate = deferred();
  releasers.push(gate.resolve);
  const model = {
    calls: [] as string[],
    release: gate.resolve,
    complete: async (messages: unknown) => {
      const prompt = JSON.stringify(messages);
      model.calls.push(prompt);
      if (shouldHold(prompt)) await gate.promise;
      return ANSWER;
    },
  } satisfies ChatModel & { calls: string[]; release(): void };
  return model;
}

/** The process dies: nothing is drained, the connection just goes away while handlers are still in flight. */
const crash = () => app.close();

describe("the problem: one Telegram update delivered twice", () => {
  it("is handled once: one query embedding, one chat call, one answer; the redelivery does no work and says nothing", async () => {
    await upload();
    const embeddedBefore = providers.embeddings.calls;
    const update = textUpdate(QUESTION, { updateId: 900 });

    await send(update);
    const embeddedAfterFirst = providers.embeddings.calls;
    await send(update);

    expect(embeddedAfterFirst - embeddedBefore).toBe(1);
    expect(providers.embeddings.calls).toBe(embeddedAfterFirst);
    expect(providers.chatModel.calls).toHaveLength(1);
    expect(replies().filter((reply) => reply.includes("Sources:"))).toHaveLength(1);
    expect(claimRows().filter((row) => row.update_id === 900)).toHaveLength(1);
    expect(stateOf(900)).toEqual({ state: "completed", category: null });
  });

  it("the same update arriving concurrently has one winner: one downstream chain, one provider call, one answer", async () => {
    const chat = gatedChat();
    app.close(); start({ providers: { chatModel: chat } });
    await upload();
    const update = textUpdate(QUESTION, { updateId: 900 });

    const deliveries = [send(update), send(update), send(update)];
    await vi.waitFor(() => expect(chat.calls).toHaveLength(1));
    expect(stateOf(900)).toEqual({ state: "running", category: null });
    chat.release();
    await Promise.all(deliveries);

    expect(chat.calls).toHaveLength(1);
    expect(replies().filter((reply) => reply.includes("Sources:"))).toHaveLength(1);
    expect(stateOf(900)?.state).toBe("completed");
  });

  it("different updates are not serialized: another user's update is answered while the first is still in flight", async () => {
    const chat = gatedChat((prompt) => prompt.includes("SLOWQ"));
    app.close(); start({ providers: { chatModel: chat } });
    await upload(42);
    await upload(43);
    const slow = send(textUpdate(`SLOWQ ${QUESTION}`, { userId: 42, updateId: 700 }));
    await vi.waitFor(() => expect(chat.calls).toHaveLength(1));
    const answersBefore = replies().filter((reply) => reply.includes("Sources:")).length;

    await send(textUpdate(QUESTION, { userId: 43, updateId: 701 })); // completes while update 700 is blocked inside the provider

    expect(replies().filter((reply) => reply.includes("Sources:"))).toHaveLength(answersBefore + 1);
    expect(stateOf(700)?.state).toBe("running");
    expect(stateOf(701)?.state).toBe("completed");
    chat.release();
    await slow;
    expect(stateOf(700)?.state).toBe("completed");
  });
});

describe("restart: the claim outlives the process", () => {
  it("an update completed before a restart is not executed again after it: no provider work, no mutation, no reply", async () => {
    const id = await upload();
    const replace = documentUpdate("handbook.md", Buffer.from(HANDBOOK.toString().replace("02:00", "04:30")), { caption: `/replace ${id}`, updateId: 800 });
    const question = textUpdate(QUESTION, { updateId: 801 });
    await send(replace);
    await send(question);
    const versionBefore = withDb((db) => db.prepare("SELECT document_version AS v FROM documents").get());
    app.close();

    start(); // a new process on the same database
    calls.length = 0;
    await send(replace);
    await send(question);

    expect(providers.embeddings.calls).toBe(0);
    expect(providers.chatModel.calls).toHaveLength(0);
    expect(calls).toEqual([]); // not even getFile: the file was not downloaded again, and nothing was sent
    expect(withDb((db) => db.prepare("SELECT document_version AS v FROM documents").get())).toEqual(versionBefore);
    expect(documentCount()).toBe(1);
  });

  it("a fresh message after the restart is processed normally", async () => {
    await upload();
    await send(textUpdate(QUESTION, { updateId: 900 }));
    app.close();

    start();
    calls.length = 0;
    await send(textUpdate(QUESTION)); // a new update_id

    expect(providers.chatModel.calls).toHaveLength(1);
    expect(replies()).toHaveLength(1);
  });
});

describe("an interrupted update is never replayed automatically", () => {
  it("a claim left running by a dead process becomes interrupted at startup and keeps suppressing the update; a new message works", async () => {
    const chat = gatedChat();
    app.close(); start({ providers: { chatModel: chat } });
    await upload();
    const pending = send(textUpdate(QUESTION, { updateId: 500 }));
    await vi.waitFor(() => expect(chat.calls).toHaveLength(1));
    crash();
    expect(stateOf(500)).toEqual({ state: "running", category: null });

    start();
    expect(stateOf(500)).toEqual({ state: "interrupted", category: "recovered" });
    calls.length = 0;
    await send(textUpdate(QUESTION, { updateId: 500 }));

    expect(providers.embeddings.calls).toBe(0);
    expect(providers.chatModel.calls).toHaveLength(0);
    expect(calls).toEqual([]);
    await send(textUpdate(QUESTION, { updateId: 501 }));
    expect(providers.chatModel.calls).toHaveLength(1);
    expect(replies().filter((reply) => reply.includes("Sources:"))).toHaveLength(1);
    chat.release();
    await pending;
  });

  it("a handler that finishes after its application was closed cannot touch the ledger: the claim stays exactly as it was", async () => {
    const chat = gatedChat();
    app.close(); start({ providers: { chatModel: chat } });
    await upload();
    const inFlight = send(textUpdate(QUESTION, { updateId: 520 }));
    await vi.waitFor(() => expect(chat.calls).toHaveLength(1));
    crash();
    const before = claimOf(520);

    chat.release(); // the abandoned handler now runs to the end against a closed database
    await expect(inFlight).resolves.toBeUndefined();

    expect(before).toMatchObject({ state: "running" });
    expect(claimOf(520)).toEqual(before);
  });

  it("the motivating mixed batch: A finished, B was in flight, no offset was confirmed - after the crash neither is repeated, a new update works", async () => {
    const chat = gatedChat((prompt) => prompt.includes("SLOWQ"));
    app.close(); start({ providers: { chatModel: chat } });
    await upload(42);
    await upload(43);
    const a = textUpdate(QUESTION, { userId: 42, updateId: 101 });
    const b = textUpdate(`SLOWQ ${QUESTION}`, { userId: 43, updateId: 102 });

    const batch = Promise.all([send(a), send(b)]); // Telegraf handles one getUpdates batch concurrently
    await vi.waitFor(() => expect(stateOf(101)?.state).toBe("completed"));
    expect(stateOf(102)?.state).toBe("running");
    crash(); // the process dies before the next getUpdates would have confirmed the higher offset

    start();
    calls.length = 0;
    await Promise.all([send(a), send(b)]); // Telegram redelivers the whole batch

    expect(providers.embeddings.calls).toBe(0);
    expect(providers.chatModel.calls).toHaveLength(0);
    expect(calls).toEqual([]);
    expect(stateOf(101)).toEqual({ state: "completed", category: null });
    expect(stateOf(102)).toEqual({ state: "interrupted", category: "recovered" });
    await send(textUpdate(QUESTION, { userId: 42, updateId: 103 }));
    expect(providers.chatModel.calls).toHaveLength(1);
    chat.release();
    await batch;
  });
});

describe("what may already have happened when a claim is interrupted (no exactly-once claim, only 'not repeated')", () => {
  /** Crash at a chosen point of one update (`until` is true once it is blocked there), restart, redeliver it: nothing runs again. */
  async function crashThenReplay(update: ReturnType<typeof textUpdate> | ReturnType<typeof documentUpdate>, until: () => void) {
    calls.length = 0;
    const inFlight = send(update);
    await vi.waitFor(until);
    const before = { calls: calls.map((call) => call.method), documents: documentCount() };
    crash();
    start();
    calls.length = 0;
    await send(update);
    return { inFlight, before };
  }

  it("1. crash right after the claim, before any work: the update is lost (the user must resend), nothing runs on replay", async () => {
    await upload();
    const embeddingsBlock = deferred();
    releasers.push(embeddingsBlock.resolve);
    let queryEmbedding = 0;
    const offline = createOfflineProviders().embeddings;
    app.close();
    start({ providers: { embeddings: { model: offline.model, embedDocuments: (texts: string[]) => offline.embedDocuments(texts), embedQuery: async () => { queryEmbedding += 1; await embeddingsBlock.promise; return [1]; } } } });

    const { before } = await crashThenReplay(textUpdate(QUESTION, { updateId: 600 }), () => expect(queryEmbedding).toBe(1));

    expect(before.calls).not.toContain("sendMessage"); // no answer had been sent
    expect(stateOf(600)).toEqual({ state: "interrupted", category: "recovered" });
    expect(calls).toEqual([]);
    expect(providers.chatModel.calls).toHaveLength(0);
  });

  it("2. crash after the provider answered but before the reply left: the paid call happened once and is not repeated", async () => {
    const chat = gatedChat(() => false);
    app.close(); start({ providers: { chatModel: chat } });
    await upload();
    hold("sendMessage"); // the reply never reaches Telegram

    const { before } = await crashThenReplay(textUpdate(QUESTION, { updateId: 601 }), () => expect(waiting).toContain("sendMessage"));

    expect(chat.calls).toHaveLength(1); // the provider call did happen (it may have been charged)
    expect(before.calls.filter((method) => method === "sendMessage")).toEqual([]);
    expect(calls).toEqual([]); // replay: nothing
    expect(providers.chatModel.calls).toHaveLength(0);
    expect(stateOf(601)?.state).toBe("interrupted");
  });

  it("3. crash after the database mutation: the document exists once, the replay neither duplicates nor changes it", async () => {
    hold("sendMessage"); // the confirmation never leaves

    const { before } = await crashThenReplay(documentUpdate("handbook.md", HANDBOOK, { updateId: 602 }), () => expect(waiting).toContain("sendMessage"));

    expect(before.documents).toBe(1); // the mutation was committed before the crash
    expect(documentCount()).toBe(1);
    expect(calls).toEqual([]); // no getFile, no embedding, no reply
    expect(providers.embeddings.calls).toBe(0);
    expect(stateOf(602)?.state).toBe("interrupted");
  });

  it("4. crash after Telegram accepted the reply (response lost): the user already has the answer and does not get a second one", async () => {
    await upload();
    hold("sendMessage", true);

    const { before } = await crashThenReplay(textUpdate(QUESTION, { updateId: 603 }), () => expect(waiting).toContain("sendMessage"));

    expect(before.calls).toContain("sendMessage"); // Telegram had accepted the answer before the process died
    expect(replies()).toEqual([]); // and the replay sent nothing (calls was cleared after the crash)
    expect(providers.chatModel.calls).toHaveLength(0);
    expect(stateOf(603)?.state).toBe("interrupted");
  });

  it("5. everything done but the terminal write fails (as if the process died just before it): the claim stays running, then interrupted - no replay", async () => {
    await upload();
    breakLedger("UPDATE");
    await send(textUpdate(QUESTION, { updateId: 604 }));
    expect(replies().filter((reply) => reply.includes("Sources:"))).toHaveLength(1);
    expect(stateOf(604)).toEqual({ state: "running", category: null });
    repairLedger("UPDATE");
    crash();

    start();
    calls.length = 0;
    await send(textUpdate(QUESTION, { updateId: 604 }));

    expect(stateOf(604)).toEqual({ state: "interrupted", category: "recovered" });
    expect(calls).toEqual([]);
    expect(providers.chatModel.calls).toHaveLength(0);
  });
});

describe("storage failures are closed, never retryable", () => {
  it("a claim that cannot be written does no work at all: no provider call, no mutation, no success reply", async () => {
    await upload();
    const documentsBefore = documentCount();
    breakLedger("INSERT");
    calls.length = 0;

    await send(textUpdate(QUESTION, { updateId: 700 }));
    await send(documentUpdate("other.md", Buffer.from("# Other\n\ncontent"), { updateId: 701 }));

    expect(providers.chatModel.calls).toHaveLength(0);
    expect(documentCount()).toBe(documentsBefore);
    expect(methods("getFile")).toHaveLength(0);
    expect(replies().some((reply) => reply.includes("Sources:") || reply.startsWith("Indexed"))).toBe(false);
    expect(replies()).toEqual([expect.stringContaining("try again"), expect.stringContaining("try again")]); // one safe notice each
    expect(claimRows().filter((row) => row.update_id >= 700)).toEqual([]);
  });

  it("a terminal write that fails leaves the running claim: the update stays suppressed, and restart recovery interrupts it", async () => {
    await upload();
    breakLedger("UPDATE");
    await send(textUpdate(QUESTION, { updateId: 710 }));
    calls.length = 0;

    await send(textUpdate(QUESTION, { updateId: 710 })); // redelivered in the same process
    expect(providers.chatModel.calls).toHaveLength(1);
    expect(calls).toEqual([]);
    expect(stateOf(710)?.state).toBe("running");

    repairLedger("UPDATE");
    app.close();
    start();
    expect(stateOf(710)).toEqual({ state: "interrupted", category: "recovered" });
    await send(textUpdate(QUESTION, { updateId: 710 }));
    expect(providers.chatModel.calls).toHaveLength(0);
    expect(calls).toEqual([]);
  });

  it("the claim is never deleted to make an update retryable", async () => {
    await upload();
    breakLedger("UPDATE");
    await send(textUpdate(QUESTION, { updateId: 711 }));

    expect(claimOf(711)).toBeDefined();
  });
});

describe("what each outcome leaves in the ledger, and that none of them can reply twice", () => {
  const expectSilentReplay = async (update: object) => {
    calls.length = 0;
    const embedded = providers.embeddings.calls;
    const chatCalls = providers.chatModel.calls.length;
    await send(update);
    expect(calls).toEqual([]);
    expect(providers.embeddings.calls).toBe(embedded);
    expect(providers.chatModel.calls).toHaveLength(chatCalls);
  };

  it("normal success: completed", async () => {
    await upload();
    const update = textUpdate(QUESTION, { updateId: 1000 });
    await send(update);

    expect(stateOf(1000)).toEqual({ state: "completed", category: null });
    await expectSilentReplay(update);
  });

  it("a rate-limit rejection is a handled outcome (completed/rejected): the replay does not repeat the 'too quickly' reply", async () => {
    app.close(); start({ env: { RATE_LIMIT_REQUESTS: "1" } });
    await send(textUpdate("first question", { userId: 44, updateId: 1010 }));
    const limited = textUpdate("second question", { userId: 44, updateId: 1011 });
    await send(limited);

    expect(replies().at(-1)).toMatch(/too quickly/);
    expect(stateOf(1011)).toEqual({ state: "completed", category: "rejected" });
    await expectSilentReplay(limited);
  });

  it("a safe user-facing error (document not found) is completed/rejected and not answered again", async () => {
    const update = textUpdate("/doc 00000000-0000-0000-0000-000000000000", { updateId: 1020 });
    await send(update);

    expect(replies()).toEqual(["Document not found."]);
    expect(stateOf(1020)).toEqual({ state: "completed", category: "rejected" });
    await expectSilentReplay(update);
  });

  it("an unexpected error is failed/internal: the generic reply is sent once, the replay is silent", async () => {
    app.close(); start({ providers: { chatModel: { complete: async () => { throw new Error("boom with the question text"); } } } });
    await upload();
    const update = textUpdate(QUESTION, { updateId: 1030 });
    await send(update);

    expect(replies().at(-1)).toBe("Something went wrong while processing your request.");
    expect(stateOf(1030)).toEqual({ state: "failed", category: "internal" });
    await expectSilentReplay(update);
  });

  it("a provider outage is failed/external", async () => {
    app.close(); start({ providers: { chatModel: { complete: async () => { throw new ExternalServiceError("openai"); } } } });
    await upload();
    const update = textUpdate(QUESTION, { updateId: 1040 });
    await send(update);

    expect(stateOf(1040)).toEqual({ state: "failed", category: "external" });
    await expectSilentReplay(update);
  });

  it("an update type nothing routes (a sticker, an edited message) is claimed and completed as a no-op, with no reply", async () => {
    const sticker = { update_id: 1050, message: { message_id: 1, date: 1, chat: privateChat(42), from: sender(42), sticker: { file_id: "s", file_unique_id: "u", type: "regular", width: 1, height: 1, is_animated: false, is_video: false } } };
    const edited = { update_id: 1051, edited_message: { message_id: 1, date: 1, edit_date: 2, chat: privateChat(42), from: sender(42), text: QUESTION } };
    await send(sticker);
    await send(edited);

    expect(calls).toEqual([]);
    expect(stateOf(1050)).toEqual({ state: "completed", category: null });
    expect(stateOf(1051)).toEqual({ state: "completed", category: null });
    expect(providers.chatModel.calls).toHaveLength(0);
  });

  it("a timeout is interrupted/timeout; the provider that ignored the abort finishes later and changes neither the ledger nor the chat", async () => {
    const release = deferred<string>();
    releasers.push(() => release.resolve("late answer [1]"));
    app.close(); start({ env: { HANDLER_TIMEOUT_MS: "300" }, providers: { chatModel: { complete: async () => release.promise } } });
    await upload();
    calls.length = 0;
    const update = textUpdate(QUESTION, { updateId: 1060 });

    await send(update);
    expect(replies()).toEqual([expect.stringContaining("cancelled")]);
    expect(stateOf(1060)).toEqual({ state: "interrupted", category: "timeout" });
    const before = claimOf(1060);
    release.resolve("late answer [1]");
    await app.drain();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(claimOf(1060)).toEqual(before); // not resurrected, not re-completed
    expect(replies()).toHaveLength(1);
    await expectSilentReplay(update);
  });

  it("a shutdown that cancels an update leaves interrupted/shutdown; a provider ignoring the abort settles during the drain, before storage closes", async () => {
    const release = deferred<string>();
    releasers.push(() => release.resolve("late answer [1]"));
    let entered = false;
    app.close(); start({ providers: { chatModel: { complete: async () => { entered = true; return release.promise; } } } });
    await upload();
    const update = textUpdate(QUESTION, { updateId: 1070 });
    const inFlight = send(update);
    await vi.waitFor(() => expect(entered).toBe(true));

    const draining = app.drain();
    await inFlight; // logically over: cancelled and answered
    expect(stateOf(1070)).toEqual({ state: "interrupted", category: "shutdown" });
    let drained = false;
    void draining.then(() => { drained = true; });
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(drained).toBe(false); // the physical work is still being waited for
    release.resolve("late answer [1]");
    await draining;
    app.close();

    expect(replies().filter((reply) => reply.includes("Sources:"))).toEqual([]); // no late answer
    start();
    expect(stateOf(1070)).toEqual({ state: "interrupted", category: "shutdown" }); // recovery has nothing to do for it
    calls.length = 0;
    await send(update);
    expect(calls).toEqual([]);
  });
});

describe("callback queries", () => {
  function callbackUpdate(updateId: number, data: string) {
    return { update_id: updateId, callback_query: { id: `cb-${updateId}`, from: sender(42), chat_instance: "ci", data, message: { message_id: 9, date: 1, chat: privateChat(42), text: "answer" } } };
  }
  const feedbackRows = () => withDb((db) => (db.prepare("SELECT COUNT(*) AS n FROM answer_feedback").get() as { n: number }).n);

  async function askWithButtons() {
    app.close(); start({ env: { FEEDBACK_BUTTONS: "true" } });
    await upload();
    await send(textUpdate(QUESTION));
    const markup = JSON.stringify(calls.filter((call) => call.method === "sendMessage").at(-1)?.payload.reply_markup);
    return /fb:g:[0-9a-f]{8}/.exec(markup)![0];
  }

  it("a duplicate of a finished callback gets one empty acknowledgement (to stop the spinner) but records no second rating and edits nothing", async () => {
    const data = await askWithButtons();
    const press = callbackUpdate(2000, data);
    await send(press);
    expect(feedbackRows()).toBe(1);
    expect(methods("answerCallbackQuery").map((call) => call.payload.text)).toEqual(["Thanks for the feedback!"]);
    expect(methods("editMessageReplyMarkup")).toHaveLength(1);

    await send(press);

    expect(feedbackRows()).toBe(1);
    expect(methods("editMessageReplyMarkup")).toHaveLength(1);
    expect(methods("answerCallbackQuery").map((call) => call.payload.text)).toEqual(["Thanks for the feedback!", undefined]);
    expect(replies().filter((reply) => reply.includes("Thanks"))).toEqual([]);
  });

  it("a duplicate that arrives while the first is still running is not acknowledged at all: the winner owns the one answer", async () => {
    const data = await askWithButtons();
    const press = callbackUpdate(2001, data);
    const release = hold("answerCallbackQuery");
    const first = send(press);
    await vi.waitFor(() => expect(stateOf(2001)?.state).toBe("running"));

    await send(press);
    expect(methods("answerCallbackQuery")).toHaveLength(0);
    release();
    await first;

    expect(methods("answerCallbackQuery").map((call) => call.payload.text)).toEqual(["Thanks for the feedback!"]);
    expect(feedbackRows()).toBe(1);
  });

  it("a callback after a restart is a duplicate too: one empty acknowledgement, no business action", async () => {
    const data = await askWithButtons();
    const press = callbackUpdate(2002, data);
    await send(press);
    app.close();
    start({ env: { FEEDBACK_BUTTONS: "true" } });
    calls.length = 0;

    await send(press);

    expect(feedbackRows()).toBe(1);
    expect(calls.map((call) => call.method)).toEqual(["answerCallbackQuery"]);
    expect(calls[0].payload.text).toBeUndefined();
  });
});

describe("identity", () => {
  it("the same update_id for a different bot is admitted independently", async () => {
    await send(textUpdate("/help", { updateId: 5 }));
    app.close();
    start({ botId: 2002 });
    calls.length = 0;

    await send(textUpdate("/help", { updateId: 5 }));

    expect(replies()).toHaveLength(1);
    expect(claimRows().map((row) => [row.bot_id, row.update_id])).toEqual([[1001, 5], [2002, 5]]);
  });

  it("a rotated token does not change the namespace: the same bot and update_id stay suppressed", async () => {
    await send(textUpdate("/help", { updateId: 6 }));
    app.close();
    start({ env: { TELEGRAM_BOT_TOKEN: ROTATED_TOKEN } });
    calls.length = 0;

    await send(textUpdate("/help", { updateId: 6 }));

    expect(calls).toEqual([]);
    expect(claimRows()).toHaveLength(1);
  });

  it("the ledger never contains the token or anything derived from it", async () => {
    await send(textUpdate("/help", { updateId: 7 }));
    app.close();

    const dump = fs.readFileSync(dbPath()).toString("latin1") + (fs.existsSync(`${dbPath()}-wal`) ? fs.readFileSync(`${dbPath()}-wal`).toString("latin1") : "");
    expect(dump).not.toContain(TOKEN);
    expect(dump).not.toContain(TOKEN.split(":")[1]);
  });

  it("update ids are not a high-water mark: lower, repeated-magnitude and huge ids are each handled once", async () => {
    for (const id of [100, 50, 101, 2 ** 40, 7]) await send(textUpdate("/help", { updateId: id }));
    for (const id of [50, 100, 2 ** 40]) await send(textUpdate("/help", { updateId: id }));

    expect(replies()).toHaveLength(5);
  });

  it.each([
    ["missing", undefined],
    ["fractional", 1.5],
    ["beyond the safe integer range", 2 ** 53],
    ["not a number", "12"],
  ])("an update_id that is %s is refused before any work and writes no claim", async (_label, bad) => {
    await upload();
    const rowsBefore = claimRows().length;
    calls.length = 0;
    const update = { ...textUpdate(QUESTION), update_id: bad };

    await send(update);

    expect(providers.chatModel.calls).toHaveLength(0);
    expect(replies().some((reply) => reply.includes("Sources:"))).toBe(false);
    expect(claimRows()).toHaveLength(rowsBefore);
  });
});

describe("the private-chat gate still comes first", () => {
  it.each(["group", "supergroup", "channel"] as const)("a %s update is refused before it is claimed, read, embedded or answered", async (type) => {
    const id = await upload();
    const rowsBefore = claimRows().length;
    const embeddedBefore = providers.embeddings.calls;
    calls.length = 0;
    const update = textUpdate(`/doc ${id}`, { updateId: 3000 });
    const shared = { ...update, message: { ...update.message, chat: { id: -100123, type, title: "Shared" } } };

    await send(shared);
    await send(shared);
    await send({ update_id: 3001, callback_query: { id: "cb", from: sender(42), chat_instance: "ci", data: "fb:g:deadbeef", message: { message_id: 1, date: 1, chat: { id: -100123, type, title: "Shared" }, text: "old" } } });

    expect(claimRows()).toHaveLength(rowsBefore); // nothing was claimed for them
    expect(providers.embeddings.calls).toBe(embeddedBefore);
    expect(providers.chatModel.calls).toHaveLength(0);
    expect(replies()).toEqual(["Please open a private chat with me to use your documents.", "Please open a private chat with me to use your documents."]);
    expect(methods("answerCallbackQuery")).toHaveLength(1);
  });

  it("an update without a chat at all is dropped unclaimed", async () => {
    await send({ update_id: 3002, inline_query: { id: "q", from: sender(42), query: "x", offset: "" } });

    expect(calls).toEqual([]);
    expect(claimRows()).toEqual([]);
  });
});

describe("retention through the application (injected clock, no sleeping)", () => {
  it("protects an update for 48 hours across restarts, and forgets it after that", async () => {
    await send(textUpdate("/help", { updateId: 9 }));
    app.close();

    clock += 47 * HOUR;
    start();
    calls.length = 0;
    await send(textUpdate("/help", { updateId: 9 }));
    expect(calls).toEqual([]); // still protected
    app.close();

    clock += 2 * HOUR; // 49 h after it finished
    start();
    expect(claimRows().filter((row) => row.update_id === 9)).toEqual([]); // removed by the startup cleanup
    await send(textUpdate("/help", { updateId: 9 }));
    expect(replies()).toHaveLength(1);
  });

  it("an interrupted claim gets a fresh 48-hour horizon from the restart that recovered it", async () => {
    const chat = gatedChat();
    app.close(); start({ providers: { chatModel: chat } });
    await upload();
    void send(textUpdate(QUESTION, { updateId: 10 }));
    await vi.waitFor(() => expect(chat.calls).toHaveLength(1));
    crash();

    clock += 100 * HOUR; // the bot was down for four days
    start();
    expect(claimOf(10)).toMatchObject({ state: "interrupted", terminal_at: clock });
    clock += 47 * HOUR;
    app.close();
    start();
    expect(claimOf(10)?.state).toBe("interrupted"); // still protected
    clock += 2 * HOUR;
    app.close();
    start();
    expect(claimOf(10)).toBeUndefined();
  });
});

describe("recovery belongs to the bot application, not to opening the database", () => {
  function seedRunningClaim() {
    withDb((db) => db.exec("INSERT INTO telegram_update_claims (bot_id, update_id, state, claimed_at) VALUES (1001, 77, 'running', 1)"), false);
  }

  it("createCore, the integrity tool and the other credential-free openers leave a running claim alone; createApplication recovers it", async () => {
    app.close();
    seedRunningClaim();
    const env = { DATA_DIR: path.join(root, "data"), OPENAI_EMBEDDINGS_MODEL: "smoke-hashed-v1", CHUNK_SIZE: "300", CHUNK_OVERLAP: "40" };

    const core = createCore(loadCoreConfig(env), createOfflineProviders());
    core.close();
    expect(stateOf(77)?.state).toBe("running");
    const tool = createIntegrityTool(loadToolConfig(env), { writable: true, verifyHashes: false });
    tool.close();
    const readOnly = createIntegrityTool(loadToolConfig(env), { writable: false, verifyHashes: false });
    readOnly.close();
    expect(stateOf(77)?.state).toBe("running");

    start();
    expect(stateOf(77)).toEqual({ state: "interrupted", category: "recovered" });
  });
});
