import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { Telegraf } from "telegraf";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HashedEmbeddings, ScriptedChatModel } from "../../src/cli/smoke-providers.js";
import { createApplication } from "../../src/composition-root.js";
import type { Application, Providers } from "../../src/composition-root.js";
import { loadConfig } from "../../src/config/config.js";
import { ExternalServiceError, OverloadedError } from "../../src/shared/errors.js";

/**
 * Process-wide admission of expensive requests, through the REAL Telegraf routing, middleware, use cases and SQLite. The Bot API is a
 * loopback HTTP server that records every call; the OpenAI-backed providers are offline fakes whose work is held at a barrier that
 * IGNORES the abort signal (like a provider that does not support cancellation), so "work in flight" is established by a barrier, not
 * by a sleep. No external network.
 */
const TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawX";
const BUSY = new OverloadedError().message;
type ApiCall = { method: string; payload: Record<string, unknown> };

let server: http.Server;
let apiRoot: string;
const calls: ApiCall[] = [];
const downloads = new Map<string, Buffer>();

beforeAll(async () => {
  server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (request.method === "GET" && url.pathname.startsWith(`/file/bot${TOKEN}/`)) {
        const bytes = downloads.get(url.pathname.slice(`/file/bot${TOKEN}/`.length));
        response.writeHead(bytes ? 200 : 404, { "content-type": "application/octet-stream" });
        response.end(bytes ?? "");
        return;
      }
      const method = url.pathname.split("/").pop() ?? "";
      const payload = chunks.length > 0 ? (JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>) : {};
      calls.push({ method, payload });
      const result =
        method === "getFile"
          ? { file_id: payload.file_id, file_unique_id: "u", file_path: `documents/${payload.file_id}` }
          : method === "sendMessage"
            ? { message_id: calls.length, date: 0, chat: { id: payload.chat_id, type: "private" }, text: payload.text }
            : true;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  apiRoot = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

/** Work that blocks until released and never looks at an abort signal. Counts entries and simultaneous work. */
class Barrier {
  entered = 0;
  concurrent = 0;
  peak = 0;
  private open = true;
  private waiting: Array<() => void> = [];
  private listeners: Array<{ count: number; resolve: () => void }> = [];

  /** New work now blocks. Counters restart, so `entered` and `peak` describe only the work since this call. */
  close() {
    this.open = false;
    this.entered = 0;
    this.peak = 0;
    this.listeners = [];
  }
  release() {
    this.open = true;
    for (const resume of this.waiting.splice(0)) resume();
  }
  /** Resolves once at least `count` units of work have entered since `close()`. */
  reached(count: number) {
    return new Promise<void>((resolve) => {
      if (this.entered >= count) resolve();
      else this.listeners.push({ count, resolve });
    });
  }
  async pass() {
    this.entered += 1;
    this.concurrent += 1;
    this.peak = Math.max(this.peak, this.concurrent);
    for (const listener of this.listeners.filter((entry) => this.entered >= entry.count)) listener.resolve();
    this.listeners = this.listeners.filter((entry) => this.entered < entry.count);
    if (!this.open) await new Promise<void>((resume) => this.waiting.push(resume));
    this.concurrent -= 1;
  }
}

const QUESTION = "When does the nightly backup run?";
const barrier = new Barrier();
let failNextWork: Error | undefined;

class GatedEmbeddings extends HashedEmbeddings {
  override async embedDocuments(texts: string[]) {
    await barrier.pass();
    if (failNextWork) throw failNextWork;
    return super.embedDocuments(texts);
  }
  override async embedQuery(text: string) {
    await barrier.pass();
    if (failNextWork) throw failNextWork;
    return super.embedQuery(text);
  }
}
class GatedChat extends ScriptedChatModel {
  override async complete(messages: Parameters<ScriptedChatModel["complete"]>[0]) {
    await barrier.pass();
    return super.complete(messages);
  }
}
const providers = (): Providers & { embeddings: GatedEmbeddings; chatModel: GatedChat } => ({
  embeddings: new GatedEmbeddings(),
  chatModel: new GatedChat(),
  speechToText: { transcribe: async () => { await barrier.pass(); return QUESTION; } },
});

let root: string;
let app: Application;
let bot: Telegraf;
let fakes: ReturnType<typeof providers>;
let updateCounter = 0;

function start(env: Record<string, string> = {}) {
  fakes = providers();
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: TOKEN,
    OPENAI_API_KEY: "sk-test-not-a-real-key-0123456789",
    DATA_DIR: path.join(root, "data"),
    OPENAI_EMBEDDINGS_MODEL: "smoke-hashed-v1",
    CHUNK_SIZE: "300",
    CHUNK_OVERLAP: "40",
    RATE_LIMIT_REQUESTS: "1000",
    MAX_ACTIVE_EXPENSIVE_REQUESTS: "3",
    MAX_ACTIVE_EXPENSIVE_REQUESTS_PER_USER: "2",
    ...env,
  });
  app = createApplication(config, fakes, { apiRoot });
  bot = app.bot;
  bot.botInfo = { id: 1, is_bot: true, first_name: "Test", username: "test_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tg-bot-workload-"));
  calls.length = 0;
  downloads.clear();
  updateCounter = 0;
  failNextWork = undefined;
  barrier.entered = 0; barrier.concurrent = 0; barrier.peak = 0;
  barrier.release();
});
afterEach(() => {
  barrier.release();
  app.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const HANDBOOK = Buffer.from("# Operations handbook\n\n## Backups\nThe nightly backup runs at 02:00 UTC and keeps seven daily copies.\n");
const chat = (userId: number, type: "private" | "group" = "private") => ({ id: userId, type });
const sender = (userId: number) => ({ id: userId, is_bot: false, first_name: `User${userId}` });

function textUpdate(text: string, userId: number, chatType: "private" | "group" = "private") {
  const command = /^\/\S+/.exec(text);
  return {
    update_id: (updateCounter += 1),
    message: {
      message_id: updateCounter, date: 1_700_000_000, chat: chat(userId, chatType), from: sender(userId), text,
      ...(command ? { entities: [{ type: "bot_command", offset: 0, length: command[0].length }] } : {}),
    },
  };
}
function documentUpdate(fileName: string, data: Buffer, userId: number, caption?: string) {
  const fileId = `file-${updateCounter + 1}`;
  downloads.set(`documents/${fileId}`, data);
  const command = caption ? /^\/\S+/.exec(caption) : null;
  return {
    update_id: (updateCounter += 1),
    message: {
      message_id: updateCounter, date: 1_700_000_000, chat: chat(userId), from: sender(userId),
      document: { file_id: fileId, file_unique_id: `u-${fileId}`, file_name: fileName, mime_type: "application/octet-stream", file_size: data.byteLength },
      ...(caption ? { caption } : {}),
      ...(command ? { caption_entities: [{ type: "bot_command", offset: 0, length: command[0].length }] } : {}),
    },
  };
}
function voiceUpdate(userId: number) {
  const fileId = `voice-${updateCounter + 1}`;
  downloads.set(`documents/${fileId}`, Buffer.from("ogg"));
  return {
    update_id: (updateCounter += 1),
    message: { message_id: updateCounter, date: 1_700_000_000, chat: chat(userId), from: sender(userId), voice: { file_id: fileId, file_unique_id: `u-${fileId}`, duration: 2, mime_type: "audio/ogg", file_size: 3 } },
  };
}
function callbackUpdate(data: string, userId: number) {
  return {
    update_id: (updateCounter += 1),
    callback_query: {
      id: `cb-${updateCounter}`, from: sender(userId), chat_instance: "ci", data,
      message: { message_id: 1, date: 1_700_000_000, chat: chat(userId), from: { id: 1, is_bot: true, first_name: "Test" }, text: "answer" },
    },
  };
}

type Update = ReturnType<typeof textUpdate | typeof documentUpdate | typeof voiceUpdate | typeof callbackUpdate>;
const send = (update: Update) => bot.handleUpdate(update as never);
const sentTo = (userId: number) => calls.filter((call) => call.method === "sendMessage" && call.payload.chat_id === userId).map((call) => String(call.payload.text));
const busyCount = () => calls.filter((call) => call.method === "sendMessage" && call.payload.text === BUSY).length;
const methodCount = (method: string) => calls.filter((call) => call.method === method).length;
const idFrom = (reply: string) => /Document ID: (\S+)/.exec(reply)?.[1] ?? "";
/** Lets promise chains that are already runnable finish (a macrotask boundary, not a time wait). */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
/** Resolves when `count` of the promises have settled. */
const settledCount = (promises: Promise<unknown>[], count: number) =>
  new Promise<void>((resolve) => {
    let done = 0;
    for (const promise of promises) void promise.then(() => { done += 1; if (done === count) resolve(); }, () => { done += 1; if (done === count) resolve(); });
  });

async function uploadFor(userId: number) {
  await send(documentUpdate("handbook.md", HANDBOOK, userId));
  return idFrom(sentTo(userId).at(-1) ?? "");
}

describe("global bound", () => {
  it("lets only the configured number of distinct users into expensive work; the rest are told the bot is busy and cause no effects", async () => {
    start();
    const users = [101, 102, 103, 104, 105, 106];
    for (const user of users) await uploadFor(user);
    barrier.close();
    calls.length = 0;

    const pending = users.map((user) => send(textUpdate(QUESTION, user)));
    await barrier.reached(3);
    await settledCount(pending, 3);

    expect(barrier.entered).toBe(3);
    expect(barrier.peak).toBe(3);
    expect(busyCount()).toBe(3);
    expect(calls.some((call) => call.method === "sendMessage" && String(call.payload.text).includes("Sources:"))).toBe(false);
    expect(methodCount("getFile")).toBe(0);
    expect(fakes.chatModel.calls).toHaveLength(0);

    barrier.release();
    await Promise.all(pending);

    expect(barrier.peak).toBe(3);
    expect(barrier.entered).toBe(6); // the three admitted questions: one query embedding and one generation each - nothing for the refused ones
    expect(fakes.chatModel.calls).toHaveLength(3);
    expect(calls.filter((call) => call.method === "sendMessage" && String(call.payload.text).includes("Sources:"))).toHaveLength(3);
  });

  it("refuses with no provider call, no download and no document change for an upload while the bot is full", async () => {
    start({ MAX_ACTIVE_EXPENSIVE_REQUESTS: "1", MAX_ACTIVE_EXPENSIVE_REQUESTS_PER_USER: "1" });
    const owner = 201;
    const documentId = await uploadFor(owner);
    barrier.close();
    const first = send(textUpdate(QUESTION, owner));
    await barrier.reached(1);
    calls.length = 0;

    await send(documentUpdate("other.md", HANDBOOK, 202));
    await send(documentUpdate("handbook.md", HANDBOOK, 203, `/replace ${documentId}`));
    await send(voiceUpdate(204));
    await send(textUpdate(`/summary ${documentId}`, 205));
    await send(textUpdate(`/askdoc ${documentId} ${QUESTION}`, 206));
    await send(textUpdate(`/ask ${QUESTION}`, 207));

    expect(busyCount()).toBe(6);
    expect(methodCount("getFile")).toBe(0);
    expect(barrier.entered).toBe(1);
    barrier.release();
    await first;
  });
});

describe("per-user bound and mixed routes", () => {
  it("shares one budget across question, voice, summary and upload, and stops one user from taking the rest", async () => {
    start(); // 3 overall, 2 per user
    await uploadFor(301);
    const summarized = await uploadFor(302);
    barrier.close();
    calls.length = 0;

    const question = send(textUpdate(QUESTION, 301));
    const voice = send(voiceUpdate(301));
    await barrier.reached(2);
    const excess = send(documentUpdate("more.md", HANDBOOK, 301));
    await excess; // refused immediately, while the user's two requests are still running
    expect(sentTo(301)).toEqual([BUSY]);
    expect(methodCount("getFile")).toBe(1); // only the voice download; the refused upload downloaded nothing

    const summary = send(textUpdate(`/summary ${summarized}`, 302)); // another user still fits
    await barrier.reached(3);
    const refused = send(textUpdate(QUESTION, 303)); // the global bound is now reached
    await refused;
    expect(sentTo(303)).toEqual([BUSY]);

    expect(barrier.peak).toBe(3);
    barrier.release();
    await Promise.all([question, voice, summary]);
    expect(barrier.peak).toBe(3);
  });

  it("covers replacement: a /replace upload takes a slot and is refused when none is free", async () => {
    start({ MAX_ACTIVE_EXPENSIVE_REQUESTS: "1", MAX_ACTIVE_EXPENSIVE_REQUESTS_PER_USER: "1" });
    const documentId = await uploadFor(401);
    barrier.close();
    calls.length = 0;
    const replacement = send(documentUpdate("handbook.md", Buffer.from(HANDBOOK.toString().replace("02:00", "04:30")), 401, `/replace ${documentId}`));
    await barrier.reached(1);

    await send(textUpdate(QUESTION, 402));
    expect(sentTo(402)).toEqual([BUSY]);
    barrier.release();
    await replacement;

    expect(sentTo(401).at(-1)).toMatch(/^Replaced handbook\.md/);
  });
});

describe("cheap and ignored requests while the bot is full", () => {
  it("keep /help, /list, /doc, /delete, /replace usage, feedback and unknown commands working without taking capacity", async () => {
    start({ MAX_ACTIVE_EXPENSIVE_REQUESTS: "1", MAX_ACTIVE_EXPENSIVE_REQUESTS_PER_USER: "1", FEEDBACK_BUTTONS: "true" });
    await uploadFor(501);
    barrier.close();
    const running = send(textUpdate(QUESTION, 501));
    await barrier.reached(1);
    calls.length = 0;
    const entered = barrier.entered;

    await send(textUpdate("/help", 502));
    await send(textUpdate("/list", 502));
    await send(textUpdate("/doc 00000000-0000-0000-0000-000000000000", 502));
    await send(textUpdate("/delete 00000000-0000-0000-0000-000000000000", 502));
    await send(textUpdate("/replace", 502));
    await send(textUpdate("/definitely-not-a-command", 502));
    await send(callbackUpdate("fb:g:abcd1234", 502));

    const replies = sentTo(502);
    expect(replies).toHaveLength(5); // the ignored command is answered with nothing
    expect(replies).not.toContain(BUSY);
    expect(replies[0]).toMatch(/\/list/);
    expect(replies[1]).toBe("No indexed documents yet. Upload a file first.");
    expect(replies[2]).toBe("Document not found.");
    expect(methodCount("answerCallbackQuery")).toBeGreaterThan(0);
    expect(barrier.entered).toBe(entered);

    // The ignored command took no slot either: a real question from the same user is the first thing refused.
    await send(textUpdate(QUESTION, 502));
    expect(busyCount()).toBe(1);
    barrier.release();
    await running;
  });

  it("answers a message from a shared chat with the privacy notice, never the busy notice", async () => {
    start({ MAX_ACTIVE_EXPENSIVE_REQUESTS: "1", MAX_ACTIVE_EXPENSIVE_REQUESTS_PER_USER: "1" });
    await uploadFor(601);
    barrier.close();
    const running = send(textUpdate(QUESTION, 601));
    await barrier.reached(1);
    calls.length = 0;

    await send(textUpdate(QUESTION, 602, "group"));

    expect(sentTo(602)).toEqual(["Please open a private chat with me to use your documents."]);
    expect(barrier.entered).toBe(1);
    barrier.release();
    await running;
  });

  it("charges the user's rate limit before admission, as before", async () => {
    start({ MAX_ACTIVE_EXPENSIVE_REQUESTS: "1", MAX_ACTIVE_EXPENSIVE_REQUESTS_PER_USER: "1", RATE_LIMIT_REQUESTS: "3" });
    await uploadFor(701); // counted: 1 of 3
    barrier.close();
    const first = send(textUpdate(QUESTION, 701)); // counted: 2
    await barrier.reached(1);
    calls.length = 0;

    await send(textUpdate(QUESTION, 701)); // counted: 3, then refused as busy
    await send(textUpdate(QUESTION, 701)); // over the rate limit, which is checked first

    expect(sentTo(701)[0]).toBe(BUSY);
    expect(sentTo(701)[1]).toMatch(/too quickly/);
    barrier.release();
    await first;
  });
});

describe("capacity follows the actual work", () => {
  it("stays occupied after the deadline while a provider ignores cancellation, and is freed only when that provider finishes", async () => {
    start({ MAX_ACTIVE_EXPENSIVE_REQUESTS: "1", MAX_ACTIVE_EXPENSIVE_REQUESTS_PER_USER: "1", HANDLER_TIMEOUT_MS: "100" });
    barrier.close();

    const abandoned = send(textUpdate(QUESTION, 801));
    await barrier.reached(1);
    await abandoned; // resolves after the deadline's reply; the provider is still running and never saw the signal
    expect(sentTo(801).at(-1)).toMatch(/took too long/);
    expect(barrier.concurrent).toBe(1);

    await send(textUpdate(QUESTION, 802));
    expect(sentTo(802)).toEqual([BUSY]); // the caller timed out, the work did not
    expect(barrier.entered).toBe(1); // only the abandoned question ever reached the provider

    barrier.release();
    await settle();
    await settle();
    expect(barrier.concurrent).toBe(0);

    await send(textUpdate(QUESTION, 802));
    expect(sentTo(802).filter((text) => text === BUSY)).toHaveLength(1); // admitted this time: still only the earlier refusal
    expect(barrier.entered).toBeGreaterThan(1);
  });

  it("frees the slot after provider failures, again and again, so none leak", async () => {
    start({ MAX_ACTIVE_EXPENSIVE_REQUESTS: "1", MAX_ACTIVE_EXPENSIVE_REQUESTS_PER_USER: "1" });
    await uploadFor(901);
    failNextWork = new ExternalServiceError("openai");
    calls.length = 0;

    for (let attempt = 0; attempt < 4; attempt += 1) await send(textUpdate(QUESTION, 901));

    expect(busyCount()).toBe(0);
    expect(sentTo(901)).toHaveLength(4);
    failNextWork = undefined;
    await send(textUpdate(QUESTION, 901));
    expect(sentTo(901).at(-1)).toContain("Sources:");
  });
});

describe("overloaded updates in the durable ledger", () => {
  it("a replay of a refused update stays suppressed after capacity frees, while a fresh update is served", async () => {
    start({ MAX_ACTIVE_EXPENSIVE_REQUESTS: "1", MAX_ACTIVE_EXPENSIVE_REQUESTS_PER_USER: "1" });
    await uploadFor(1001);
    await uploadFor(1002);
    barrier.close();
    const running = send(textUpdate(QUESTION, 1001));
    await barrier.reached(1);
    const refused = textUpdate(QUESTION, 1002);
    calls.length = 0;
    await send(refused);
    expect(sentTo(1002)).toEqual([BUSY]);

    barrier.release();
    await running;
    const entered = barrier.entered;
    calls.length = 0;
    await send(refused); // Telegram redelivers the same update

    expect(calls.filter((call) => call.method === "sendMessage")).toHaveLength(0);
    expect(barrier.entered).toBe(entered);

    await send(textUpdate(QUESTION, 1002)); // the user sends it again
    expect(sentTo(1002).at(-1)).toContain("Sources:");
  });
});

describe("shutdown", () => {
  it("waits for admitted work to drain before storage can be closed", async () => {
    start();
    await uploadFor(1101);
    barrier.close();
    const running = send(textUpdate(QUESTION, 1101));
    await barrier.reached(1);

    let drained = false;
    const draining = app.drain().then(() => { drained = true; });
    await settle();
    expect(drained).toBe(false);

    barrier.release();
    await draining;
    await running;
    expect(drained).toBe(true);
  });
});
