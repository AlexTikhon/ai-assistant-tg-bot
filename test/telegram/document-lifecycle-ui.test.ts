import type { Context } from "telegraf";
import { describe, expect, it, vi } from "vitest";
import type { DocumentOverview } from "../../src/application/document-overview.js";
import type { IngestDocumentUseCase } from "../../src/application/use-cases/ingest-document.use-case.js";
import type { ReplaceDocumentUseCase } from "../../src/application/use-cases/replace-document.use-case.js";
import { deriveIndexHealth } from "../../src/core/index-health.js";
import { hasCommand } from "../../src/telegram/context.js";
import { createReplaceHelpHandler } from "../../src/telegram/handlers/replace.handler.js";
import { createUploadHandler } from "../../src/telegram/handlers/upload.handler.js";
import { formatDocumentInfo, formatDocumentList, formatIngestResult } from "../../src/telegram/ui/format.js";
import { makeDocument } from "../support/fakes.js";

const healthy = { chunkCount: 4, unreadableChunkCount: 0, stale: { embedding: false, chunking: false, extractor: false }, fileMissing: false };
const overview = (overrides: Partial<DocumentOverview["document"]> = {}, facts: Partial<typeof healthy> = {}): DocumentOverview => ({
  document: makeDocument({ id: "doc-1", fileName: "notes.pdf", fileSize: 2048, createdAt: "2026-03-01T10:00:00.000Z", documentVersion: 1, contentHash: "a".repeat(64), ...overrides }),
  chunksCount: 4,
  health: deriveIndexHealth({ ...healthy, ...facts }),
});

describe("/list", () => {
  it("shows id, name, size, date and a plain state, and never a hash", () => {
    const text = formatDocumentList([overview()]);

    expect(text).toBe("doc-1\nnotes.pdf · 2 KB · added 2026-03-01 · ready");
    expect(text).not.toContain("aaaa");
  });

  it("tells a replaced document from a new one by its update date", () => {
    expect(formatDocumentList([overview({ documentVersion: 2, updatedAt: "2026-04-02T08:00:00.000Z" })])).toContain("updated 2026-04-02");
  });

  it("makes two documents with the same name distinguishable by id, date and size", () => {
    const text = formatDocumentList([
      overview({ id: "id-new", createdAt: "2026-05-02T00:00:00.000Z", fileSize: 3000 }),
      overview({ id: "id-old", createdAt: "2026-01-02T00:00:00.000Z", fileSize: 1000 }),
    ]);

    expect(text).toContain("id-new\nnotes.pdf · 2.9 KB · added 2026-05-02");
    expect(text).toContain("id-old\nnotes.pdf · 1000 B · added 2026-01-02");
  });

  it.each([
    [{ stale: { embedding: true, chunking: false, extractor: false } }, "index outdated"],
    [{ chunkCount: 0 }, "not searchable"],
    [{ unreadableChunkCount: 1 }, "partly unreadable"],
    [{ fileMissing: true }, "original file missing"],
  ] as const)("describes %j as '%s'", (facts, label) => {
    expect(formatDocumentList([overview({}, facts)])).toContain(label);
  });
});

describe("/doc", () => {
  it("shows the facts a user needs, without internals", () => {
    const text = formatDocumentInfo(overview({ documentVersion: 2, updatedAt: "2026-04-02T08:00:00.000Z" }));

    expect(text).toContain("notes.pdf");
    expect(text).toContain("ID: doc-1");
    expect(text).toContain("Type: PDF");
    expect(text).toContain("Chunks: 4");
    expect(text).toContain("Version: 2");
    expect(text).toContain("Status: ready");
    expect(text).not.toMatch(/[0-9a-f]{64}|fingerprint|dimension|profile/i);
  });
});

describe("upload results", () => {
  it("created", () => {
    expect(formatIngestResult({ kind: "created", documentId: "d1", fileName: "a.txt", chunksCount: 3, textLength: 10 })).toContain("Indexed a.txt");
  });

  it("already-exists: says so plainly, without hashes", () => {
    const text = formatIngestResult({ kind: "already-exists", documentId: "d1", fileName: "a.txt", chunksCount: 3, textLength: 10, health: deriveIndexHealth(healthy) });

    expect(text).toContain("This document is already in your knowledge base.");
    expect(text).toContain("d1");
    expect(text).not.toMatch(/[0-9a-f]{64}/);
  });

  it("already-exists but not searchable: points at /replace instead of pretending all is well", () => {
    const text = formatIngestResult({ kind: "already-exists", documentId: "d1", fileName: "a.txt", chunksCount: 0, textLength: 10, health: deriveIndexHealth({ ...healthy, chunkCount: 0 }) });

    expect(text).toContain("/replace d1");
  });

  it("replaced", () => {
    expect(formatIngestResult({ kind: "replaced", documentId: "d1", fileName: "b.txt", chunksCount: 5, textLength: 10, documentVersion: 2 })).toContain("Replaced");
  });
});

describe("caption routing of an uploaded file", () => {
  const limits = { maxBytes: 1000, timeoutMs: 1000 };
  const created = { kind: "created", documentId: "new-1", fileName: "a.txt", chunksCount: 1, textLength: 5 } as const;

  function setup(caption?: string) {
    const ingest = { execute: vi.fn(async () => created) } as unknown as IngestDocumentUseCase;
    const replace = { execute: vi.fn(async () => ({ kind: "replaced", documentId: "d9", fileName: "a.txt", chunksCount: 1, textLength: 5, documentVersion: 2 })) } as unknown as ReplaceDocumentUseCase;
    const replies: string[] = [];
    const ctx = {
      from: { id: 42 },
      message: { document: { file_id: "f", file_name: "a.txt", mime_type: "text/plain", file_size: 10 }, ...(caption === undefined ? {} : { caption }) },
      reply: async (text: string) => void replies.push(text),
      sendChatAction: async () => undefined,
    } as unknown as Context;
    const download = vi.fn(async () => Buffer.from("hello"));
    return { handler: createUploadHandler(ingest, replace, limits, download), ingest, replace, ctx, replies, download };
  }

  it("a plain upload is ingested as a new document", async () => {
    const { handler, ctx, ingest, replace } = setup();

    await handler(ctx);

    expect(ingest.execute).toHaveBeenCalledOnce();
    expect(replace.execute).not.toHaveBeenCalled();
  });

  it("a caption '/replace <id>' replaces that document for the sender, and only that", async () => {
    const { handler, ctx, ingest, replace } = setup("/replace d9");

    await handler(ctx);

    expect(replace.execute).toHaveBeenCalledWith(expect.objectContaining({ userId: "42", documentId: "d9", fileName: "a.txt" }));
    expect(ingest.execute).not.toHaveBeenCalled();
  });

  it("'/replace' without an id explains how to use it and neither downloads nor changes anything", async () => {
    const { handler, ctx, ingest, replace, download, replies } = setup("/replace");

    await handler(ctx);

    expect(replies[0]).toMatch(/\/replace <documentId>/);
    expect(download).not.toHaveBeenCalled();
    expect(ingest.execute).not.toHaveBeenCalled();
    expect(replace.execute).not.toHaveBeenCalled();
  });

  it("any other caption is just a caption", async () => {
    const { handler, ctx, ingest } = setup("my notes from monday");

    await handler(ctx);

    expect(ingest.execute).toHaveBeenCalledOnce();
  });
});

describe("/replace command without a file", () => {
  it("explains the two-step usage", async () => {
    const replies: string[] = [];
    await createReplaceHelpHandler()({ reply: async (text: string) => void replies.push(text) } as unknown as Context);

    expect(replies[0]).toMatch(/caption/i);
    expect(replies[0]).toMatch(/\/replace <documentId>/);
  });
});

describe("hasCommand", () => {
  it("matches the command with or without arguments and bot name, and nothing that merely starts with it", () => {
    expect(hasCommand("/replace", "replace")).toBe(true);
    expect(hasCommand("/replace abc", "replace")).toBe(true);
    expect(hasCommand("/replace@MyBot abc", "replace")).toBe(true);
    expect(hasCommand("/replacement", "replace")).toBe(false);
    expect(hasCommand("please /replace", "replace")).toBe(false);
    expect(hasCommand(undefined, "replace")).toBe(false);
  });
});

describe("duplicate upload that restored a lost original", () => {
  it("tells the user, in plain words", () => {
    const text = formatIngestResult({ kind: "already-exists", documentId: "d1", fileName: "a.txt", chunksCount: 3, textLength: 10, health: deriveIndexHealth(healthy), restoredOriginal: true });

    expect(text).toContain("This document is already in your knowledge base.");
    expect(text).toContain("original file had gone missing");
  });
});
