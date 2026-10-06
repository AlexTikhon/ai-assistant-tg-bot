import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { Telegraf } from "telegraf";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createOfflineProviders } from "../../src/cli/smoke-providers.js";
import { createApplication } from "../../src/composition-root.js";
import type { Application, Providers } from "../../src/composition-root.js";
import { loadConfig } from "../../src/config/config.js";
import { MAX_MESSAGE_LENGTH } from "../../src/telegram/reply.js";
import { buildPdf } from "../support/pdf.js";

/**
 * The Telegram adapter, end to end through the REAL Telegraf client and routing: updates go into `bot.handleUpdate`, and the Bot API the
 * client talks to is a fake HTTP server on the loopback interface (it records every call and serves the "downloaded" files). Behind the
 * adapter are the real use cases, SQLite and file storage; only the OpenAI-backed providers are offline fakes. No external network.
 */
const TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawX";
type ApiCall = { method: string; payload: Record<string, unknown> };

let server: http.Server;
let apiRoot: string;
const calls: ApiCall[] = [];
const downloads = new Map<string, Buffer>(); // file path on the "Telegram" server -> bytes

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

let root: string;
let app: Application;
let bot: Telegraf;
let providers: ReturnType<typeof createOfflineProviders>;
let updateCounter = 0;

function start(overrides: Partial<Providers> = {}, env: Record<string, string> = {}) {
  providers = createOfflineProviders();
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: TOKEN,
    OPENAI_API_KEY: "sk-test-not-a-real-key-0123456789",
    DATA_DIR: path.join(root, "data"),
    OPENAI_EMBEDDINGS_MODEL: "smoke-hashed-v1",
    CHUNK_SIZE: "300",
    CHUNK_OVERLAP: "40",
    RATE_LIMIT_REQUESTS: "1000",
    ...env,
  });
  app = createApplication(config, { ...providers, ...overrides }, { apiRoot });
  bot = app.bot;
  bot.botInfo = { id: 1, is_bot: true, first_name: "Test", username: "test_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tg-bot-contract-"));
  calls.length = 0;
  downloads.clear();
  updateCounter = 0;
  start();
});
afterEach(() => {
  app.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const sender = (userId: number) => ({ id: userId, is_bot: false, first_name: `User${userId}` });
const chat = (userId: number) => ({ id: userId, type: "private" as const });

/** A text message; commands carry the bot_command entity Telegram adds. */
function textUpdate(text: string, userId = 42) {
  const command = /^\/\S+/.exec(text);
  return {
    update_id: (updateCounter += 1),
    message: {
      message_id: updateCounter,
      date: 1_700_000_000,
      chat: chat(userId),
      from: sender(userId),
      text,
      ...(command ? { entities: [{ type: "bot_command", offset: 0, length: command[0].length }] } : {}),
    },
  };
}

/** A document message; the bytes are placed where the fake server serves them from. */
function documentUpdate(fileName: string, data: Buffer, options: { caption?: string; userId?: number; fileSize?: number } = {}) {
  const userId = options.userId ?? 42;
  const fileId = `file-${updateCounter + 1}`;
  downloads.set(`documents/${fileId}`, data);
  const caption = options.caption;
  const command = caption ? /^\/\S+/.exec(caption) : null;
  return {
    update_id: (updateCounter += 1),
    message: {
      message_id: updateCounter,
      date: 1_700_000_000,
      chat: chat(userId),
      from: sender(userId),
      document: { file_id: fileId, file_unique_id: `u-${fileId}`, file_name: fileName, mime_type: "application/octet-stream", file_size: options.fileSize ?? data.byteLength },
      ...(caption ? { caption } : {}),
      ...(command ? { caption_entities: [{ type: "bot_command", offset: 0, length: command[0].length }] } : {}),
    },
  };
}

const send = (update: ReturnType<typeof textUpdate> | ReturnType<typeof documentUpdate>) => bot.handleUpdate(update as never);
const replies = () => calls.filter((call) => call.method === "sendMessage").map((call) => String(call.payload.text));
const lastReply = () => replies().at(-1) ?? "";
const idFrom = (reply: string) => /Document ID: (\S+)/.exec(reply)?.[1] ?? "";

const HANDBOOK = Buffer.from("# Operations handbook\n\n## Backups\nThe nightly backup runs at 02:00 UTC and keeps seven daily copies.\n\n## Restores\nTo restore, stop the service and run the restore command.\n");

async function upload(fileName = "handbook.md", data = HANDBOOK, userId = 42) {
  await send(documentUpdate(fileName, data, { userId }));
  return idFrom(lastReply());
}

describe("commands", () => {
  it("/start welcomes the user and shows the keyboard", async () => {
    await send(textUpdate("/start"));

    expect(lastReply()).toContain("I am your AI knowledge assistant.");
    expect(calls.find((call) => call.method === "sendMessage")?.payload.reply_markup).toBeDefined();
  });

  it("/help lists the commands", async () => {
    await send(textUpdate("/help"));

    expect(lastReply()).toMatch(/\/list.*\n.*\/doc.*\n.*\/ask/);
  });

  it("/list is empty at first, then shows the uploaded document with its id and plain state", async () => {
    await send(textUpdate("/list"));
    expect(lastReply()).toBe("No indexed documents yet. Upload a file first.");

    const id = await upload();
    await send(textUpdate("/list"));

    expect(lastReply()).toContain(id);
    expect(lastReply()).toMatch(/handbook\.md · \d+(\.\d)? (B|KB) · added \d{4}-\d{2}-\d{2} · ready/);
  });

  it("/doc shows the details of the user's document, without internals", async () => {
    const id = await upload();

    await send(textUpdate(`/doc ${id}`));

    const reply = lastReply();
    expect(reply).toContain("handbook.md");
    expect(reply).toContain("Type: MD");
    expect(reply).toContain("Section citations: yes");
    expect(reply).toContain("Status: ready");
    expect(reply).not.toMatch(/[0-9a-f]{64}|fingerprint|dimension/i);
  });

  it("/ask answers from the user's documents and lists numbered sources with the section", async () => {
    await upload();

    await send(textUpdate("/ask When does the nightly backup run?"));

    expect(lastReply()).toContain("Based on your documents, here is the answer [1].");
    expect(lastReply()).toContain("Sources:\n[1] handbook.md · Operations handbook > Backups");
    expect(calls.some((call) => call.method === "sendChatAction")).toBe(true);
  });

  it("a plain text message is a question too", async () => {
    await upload();

    await send(textUpdate("When does the nightly backup run?"));

    expect(lastReply()).toContain("Sources:");
  });

  it("/delete removes the document and it disappears from /list", async () => {
    const id = await upload();

    await send(textUpdate(`/delete ${id}`));
    expect(lastReply()).toBe(`Deleted document ${id}.`);

    await send(textUpdate("/list"));
    expect(lastReply()).toBe("No indexed documents yet. Upload a file first.");
  });
});

describe("missing arguments and unknown ids", () => {
  it.each([
    ["/ask", "Use /ask <question> or send plain text."],
    ["/doc", "Use /doc <documentId>."],
    ["/delete", "Use /delete <documentId>."],
    ["/summary", "Use /summary <documentId>."],
    ["/replace", "To replace a document, send the new file as a document with the caption /replace <documentId>. Find the id with /list."],
  ])("%s without an argument explains its usage", async (command, usage) => {
    await send(textUpdate(command));

    expect(lastReply()).toBe(usage);
  });

  it("an unknown document id is 'not found', never a stack trace or an internal error", async () => {
    await send(textUpdate("/doc 00000000-0000-0000-0000-000000000000"));
    expect(lastReply()).toBe("Document not found.");

    await send(textUpdate("/delete 00000000-0000-0000-0000-000000000000"));
    expect(lastReply()).toBe("Document not found.");
  });

  it("another user cannot see, inspect, delete or ask about someone else's document", async () => {
    const id = await upload("handbook.md", HANDBOOK, 42);

    await send({ ...textUpdate("/list", 43) });
    expect(lastReply()).toBe("No indexed documents yet. Upload a file first.");
    await send(textUpdate(`/doc ${id}`, 43));
    expect(lastReply()).toBe("Document not found.");
    await send(textUpdate(`/delete ${id}`, 43));
    expect(lastReply()).toBe("Document not found.");
    await send(textUpdate("When does the nightly backup run?", 43));
    expect(lastReply()).not.toContain("handbook.md");

    await send(textUpdate("/list", 42));
    expect(lastReply()).toContain(id); // and it is still the owner's
  });
});

describe("/askdoc: a question about one document", () => {
  const TRAVEL = Buffer.from("# Travel policy\n\n## Flights\nBook economy flights at least two weeks ahead.\n");
  const QUESTION = "When does the nightly backup run?";
  const NOT_ENOUGH = "I couldn't find enough information in your uploaded documents to answer that.";

  it("searches only the named document: the same question finds the handbook through /ask but not inside the travel policy", async () => {
    const handbook = await upload();
    const travel = await upload("travel.md", TRAVEL);

    await send(textUpdate(`/askdoc ${handbook} ${QUESTION}`));
    expect(lastReply()).toContain("Sources:\n[1] handbook.md · Operations handbook > Backups");

    const chatCallsBefore = providers.chatModel.calls.length;
    await send(textUpdate(`/askdoc ${travel} ${QUESTION}`));
    expect(lastReply()).toBe(NOT_ENOUGH);
    expect(providers.chatModel.calls).toHaveLength(chatCallsBefore); // refused before any model call

    await send(textUpdate(`/ask ${QUESTION}`)); // the whole knowledge base is unchanged
    expect(lastReply()).toContain("handbook.md");
  });

  it("a nonexistent id and another user's document id get the same answer, and nothing is embedded or generated", async () => {
    const foreign = await upload("handbook.md", HANDBOOK, 42);
    const embeddedBefore = providers.embeddings.calls;

    await send(textUpdate(`/askdoc 00000000-0000-0000-0000-000000000000 ${QUESTION}`, 43));
    const nonexistent = lastReply();
    await send(textUpdate(`/askdoc ${foreign} ${QUESTION}`, 43));

    expect(nonexistent).toBe("Document not found.");
    expect(lastReply()).toBe(nonexistent);
    expect(providers.embeddings.calls).toBe(embeddedBefore);
    expect(providers.chatModel.calls).toHaveLength(0);
  });

  it.each([
    ["no arguments", "/askdoc"],
    ["only blanks", "/askdoc    "],
    ["an id without a question", "/askdoc 7c1f2c9e-0000-4000-8000-000000000000"],
    ["an id and a blank question", "/askdoc 7c1f2c9e-0000-4000-8000-000000000000   "],
  ])("%s explains the usage and calls no provider", async (_label, command) => {
    await send(textUpdate(command));

    expect(lastReply()).toBe("Use /askdoc <documentId> <question>. Find the id with /list.");
    expect(providers.embeddings.calls).toBe(0);
  });

  it("accepts the /askdoc@botname form, extra spaces and a question over several lines", async () => {
    const id = await upload();

    await send(textUpdate(`/askdoc@test_bot    ${id}   When does the\nnightly   backup run?`));

    expect(lastReply()).toContain("Sources:\n[1] handbook.md");
  });

  it("an over-long question is refused with the same message as /ask", async () => {
    const id = await upload();

    await send(textUpdate(`/askdoc ${id} ${"why ".repeat(600)}`));

    expect(lastReply()).toMatch(/^The question is too long \(max 2000 characters\)\.$/);
  });

  it("keeps the feedback buttons, and is in the help text", async () => {
    app.close();
    start({}, { FEEDBACK_BUTTONS: "true" });
    const id = await upload();

    await send(textUpdate(`/askdoc ${id} ${QUESTION}`));
    const answer = calls.filter((call) => call.method === "sendMessage").at(-1);
    expect(JSON.stringify(answer?.payload.reply_markup)).toContain("fb:");

    await send(textUpdate("/help"));
    expect(lastReply()).toContain("/askdoc <documentId> <question>");
  });
});

describe("document upload", () => {
  it("indexes a supported file, and the same file again is recognised", async () => {
    await send(documentUpdate("handbook.md", HANDBOOK));
    expect(lastReply()).toMatch(/^Indexed handbook\.md\.\nDocument ID: \S+\nChunks: \d+\nYou can now ask questions\.$/);
    expect(calls.some((call) => call.method === "getFile")).toBe(true);

    await send(documentUpdate("same-bytes-other-name.md", HANDBOOK));
    expect(lastReply()).toContain("This document is already in your knowledge base.");
  });

  it("indexes a real PDF and /doc then shows its page citations", async () => {
    const id = await upload("manual.pdf", buildPdf(["Intro page about cats", "Second page about backups"]));
    expect(id).not.toBe("");

    await send(textUpdate(`/doc ${id}`));

    expect(lastReply()).toContain("Page citations: yes · last page with text: 2");
  });

  it("an unsupported file type is refused with a plain message and is not even downloaded", async () => {
    await send(documentUpdate("photo.png", Buffer.from("png bytes")));

    expect(lastReply()).toBe("Unsupported file type. Send PDF, MD, or TXT.");
    expect(calls.some((call) => call.method === "getFile")).toBe(false);
  });

  it("a file that is not what its extension says is refused cleanly", async () => {
    await send(documentUpdate("fake.pdf", Buffer.from("this is not a pdf")));
    expect(lastReply()).toBe("This file is named like a PDF but is not a PDF document.");

    await send(documentUpdate("binary.txt", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])));
    expect(lastReply()).toMatch(/looks like binary data/);
  });

  it("a file over the size limit is refused before it is downloaded", async () => {
    await send(documentUpdate("huge.md", HANDBOOK, { fileSize: 50 * 1024 * 1024 }));

    expect(lastReply()).toMatch(/too large/);
    expect(calls.some((call) => call.method === "getFile")).toBe(false);
  });

  it("a hostile file name is metadata only: it is indexed under that text and nothing is written outside the storage directory", async () => {
    const before = fs.readdirSync(root);

    await send(documentUpdate("../../secret.md", HANDBOOK));

    expect(lastReply()).toMatch(/^Indexed \.\.\/\.\.\/secret\.md\./);
    expect(fs.readdirSync(root)).toEqual(before);
    expect(fs.existsSync(path.join(root, "secret.md"))).toBe(false);
    expect(fs.readdirSync(path.join(root, "data", "files"))).toEqual([expect.stringMatching(/^[0-9a-f-]{36}\.md$/)]);
  });
});

describe("replacement", () => {
  it("a file sent with the caption /replace <id> replaces that document: same id, new content, version 2", async () => {
    const id = await upload();

    await send(documentUpdate("handbook.md", Buffer.from(HANDBOOK.toString().replace("02:00", "04:30")), { caption: `/replace ${id}` }));

    expect(lastReply()).toMatch(new RegExp(`^Replaced handbook\\.md\\.\\nDocument ID: ${id} \\(unchanged\\)`));
    await send(textUpdate(`/doc ${id}`));
    expect(lastReply()).toContain("Version: 2");
    await send(textUpdate("When does the nightly backup run?"));
    expect(JSON.stringify(providers.chatModel.calls.at(-1))).toContain("04:30");
  });

  it("the caption /replace without an id explains how, and does not index the file as a new document", async () => {
    await send(documentUpdate("handbook.md", HANDBOOK, { caption: "/replace" }));

    expect(lastReply()).toMatch(/caption \/replace <documentId>/);
    await send(textUpdate("/list"));
    expect(lastReply()).toBe("No indexed documents yet. Upload a file first.");
  });

  it("replacing a document that is not the sender's is 'not found' and changes nothing", async () => {
    const id = await upload("handbook.md", HANDBOOK, 42);

    await send(documentUpdate("evil.md", Buffer.from("# Evil\n\nreplaced!"), { caption: `/replace ${id}`, userId: 43 }));

    expect(lastReply()).toBe("Document not found.");
    await send(textUpdate(`/doc ${id}`, 42));
    expect(lastReply()).toContain("handbook.md");
  });
});

describe("long responses", () => {
  it("a long answer is delivered in several messages, none above Telegram's limit, in order and without losing text", async () => {
    app.close();
    const sentence = "This is one sentence of a very long answer. ";
    const long = `${sentence.repeat(300)}[1]`;
    start({ chatModel: { complete: async () => long } });
    await upload();

    await send(textUpdate("When does the nightly backup run?"));

    const parts = replies().slice(1); // the first reply is the upload confirmation
    expect(parts.length).toBeGreaterThan(2);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
    const joined = parts.join(" ");
    expect(joined).toContain("[1] handbook.md");
    expect(joined.replace(/\s+/g, " ")).toContain(sentence.repeat(300).replace(/\s+/g, " ").trim());
  });
});

describe("failures are safe", () => {
  it("an unexpected internal error is answered with a generic message that carries no detail", async () => {
    app.close();
    start({ chatModel: { complete: async () => Promise.reject(new Error(`boom with secret sk-proj-AbCdEfGhIjKlMnOpQrStUvWx and ${TOKEN}`)) } });
    await upload();

    await send(textUpdate("When does the nightly backup run?"));

    expect(lastReply()).toBe("Something went wrong while processing your request.");
    expect(JSON.stringify(calls)).not.toContain("sk-proj-AbCdEfGhIjKlMnOpQrStUvWx");
  });

  it("the per-user rate limit protects the paid operations", async () => {
    app.close();
    start({}, { RATE_LIMIT_REQUESTS: "2" });
    await upload(); // 1 of 2

    await send(textUpdate("first question about backups")); // 2 of 2
    await send(textUpdate("second question about backups"));

    expect(lastReply()).toMatch(/too quickly/);
  });
});

describe("confidence mode", () => {
  it("the bot starts in shadow mode unless the operator says otherwise", () => {
    expect(app.readiness.confidenceMode).toBe("shadow");
  });

  /** The same corpus and question under each mode, each in its own installation. A question about an identifier the documents do not contain. */
  async function replyUnder(mode: string) {
    app.close();
    start({}, { RETRIEVAL_CONFIDENCE_MODE: mode, DATA_DIR: path.join(root, `data-${mode}`) });
    await upload();
    calls.length = 0;
    await send(textUpdate("What does error E-4012 mean for the nightly backup?"));
    return { reply: lastReply(), chatCalls: providers.chatModel.calls.length };
  }

  it("shadow mode never changes what the user sees: the reply is exactly the one without any gate, while enforce would have refused", async () => {
    const off = await replyUnder("off");
    const shadow = await replyUnder("shadow");
    const enforce = await replyUnder("enforce");

    expect(off.reply).toContain("Based on your documents");
    expect(shadow).toEqual(off); // same text, same sources, same number of model calls
    expect(enforce.reply).toBe("I couldn't find enough information in your uploaded documents to answer that.");
    expect(enforce.chatCalls).toBe(0);
  });
});

describe("private delivery and cancellation", () => {
  it.each(["group", "supergroup"] as const)("refuses document operations in a %s before reading or calling providers", async (type) => {
    const id = await upload("private-salary.md");
    const embeddedBefore = providers.embeddings.calls;
    calls.length = 0;
    for (const command of ["/list", `/doc ${id}`, `/summary ${id}`, "/ask When do backups run?", `/delete ${id}`]) {
      const update = textUpdate(command);
      await bot.handleUpdate({ ...update, message: { ...update.message, chat: { id: -100123, type, title: "Shared" } } } as never);
    }
    const uploadUpdate = documentUpdate("new.txt", Buffer.from("private content"), { caption: `/replace ${id}` });
    await bot.handleUpdate({ ...uploadUpdate, message: { ...uploadUpdate.message, chat: { id: -100123, type, title: "Shared" } } } as never);
    expect(providers.embeddings.calls).toBe(embeddedBefore);
    expect(providers.chatModel.calls).toHaveLength(0);
    expect(calls.some((call) => call.method === "getFile")).toBe(false);
    expect(replies()).toHaveLength(6);
    for (const reply of replies()) expect(reply).toBe("Please open a private chat with me to use your documents.");
    await send(textUpdate("/list"));
    expect(lastReply()).toContain("private-salary.md");
  });

  it("rejects callbacks in shared chats without executing feedback or editing their message", async () => {
    app.close(); start({}, { FEEDBACK_BUTTONS: "true" });
    await bot.handleUpdate({ update_id: ++updateCounter, callback_query: {
      id: "callback", from: sender(42), chat_instance: "group", data: "fb:g:deadbeef",
      message: { message_id: 1, date: 1, chat: { id: -100123, type: "supergroup", title: "Shared" }, text: "old reply" },
    } } as never);
    expect(calls.map((call) => call.method)).toEqual(["answerCallbackQuery"]);
    expect(calls[0].payload.text).toContain("private chat");
  });

  it("sends one deadline response and no late answer when a provider ignores cancellation", async () => {
    app.close();
    let release!: (value: string) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const result = new Promise<string>((resolve) => { release = resolve; });
    let signal: AbortSignal | undefined;
    start({ chatModel: { complete: async (_messages, options) => { signal = options?.signal; entered(); return result; } } }, { HANDLER_TIMEOUT_MS: "300" });
    await upload(); calls.length = 0;
    const pending = send(textUpdate("When does the nightly backup run?"));
    await started; await pending;
    expect(signal?.aborted).toBe(true);
    expect(replies()).toHaveLength(1);
    expect(lastReply()).toContain("cancelled");
    release("late answer [1]");
    await app.drain();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(replies()).toHaveLength(1);
  });
});
