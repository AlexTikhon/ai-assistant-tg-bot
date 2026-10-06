import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getEventListeners } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../../src/infrastructure/sqlite/database.js";
import { SqliteDocumentRepository } from "../../src/infrastructure/sqlite/sqlite-document-repository.js";
import { SqliteVectorStore } from "../../src/infrastructure/sqlite/sqlite-vector-store.js";
import { SemanticScanner } from "../../src/infrastructure/sqlite/semantic-scanner.js";
import { encodeVector } from "../../src/core/vectors.js";
import { makeChunk, makeDocument } from "../support/fakes.js";

let root: string; let db: ReturnType<typeof openDatabase>; let scanner: SemanticScanner;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tg-scanner-"));
  const file = path.join(root, "app.db");
  db = openDatabase(file, { legacyEmbeddingModel: "test-model" });
  scanner = new SemanticScanner(file, 2);
});
afterEach(async () => { await scanner.close(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });

describe("bounded semantic worker", () => {
  it("matches the SQLite reference ranking, handles corrupt vectors, and isolates users/models/document scope", async () => {
    const documents = new SqliteDocumentRepository(db);
    for (const [documentId, userId, model] of [["a", "u", "test-model"], ["b", "u", "test-model"], ["foreign", "other", "test-model"], ["old", "u", "old-model"]]) {
      await documents.saveWithChunks(makeDocument({ id: documentId, userId }), Array.from({ length: 10 }, (_, i) => makeChunk({ id: `${documentId}-${i}`, userId, documentId, chunkIndex: i, embedding: [1, i / 10], embeddingModel: model })));
    }
    db.prepare("UPDATE document_chunks SET embedding = x'' WHERE id = 'a-1'").run();
    const reference = new SqliteVectorStore(db); const worker = new SqliteVectorStore(db, scanner);
    for (const documentId of [undefined, "a", "foreign"]) {
      const query = { userId: "u", embeddingModel: "test-model", embedding: [1, 0], limit: 7, minScore: 0.2, documentId };
      expect(await worker.searchSimilar(query)).toEqual(await reference.searchSimilar(query));
    }
  });

  it("keeps the main event loop responsive during a realistic 20,000-vector scan", async () => {
    const documents = new SqliteDocumentRepository(db);
    await documents.saveWithChunks(makeDocument({ id: "large", userId: "u" }), []);
    const embedding = Array.from({ length: 1536 }, (_, i) => (i % 17 + 1) / 100);
    const insert = db.prepare("INSERT INTO document_chunks(id,document_id,user_id,chunk_index,content,embedding,embedding_model,embedding_dim,created_at) VALUES(?,'large','u',?,'cat',?,'test-model',1536,'2026-10-05')");
    const blob = encodeVector(embedding);
    db.transaction(() => { for (let i = 0; i < 20_000; i++) insert.run(`c${i}`, i, blob); })();
    let finished = false;
    const pending = scanner.search({ userId: "u", embeddingModel: "test-model", embedding, limit: 20, minScore: 0.2 }).then((value) => { finished = true; return value; });
    void pending.catch(() => undefined); // afterEach may cancel this job if the test runner times out
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(finished).toBe(false); // scoring does not execute synchronously on the calling thread
    expect((await pending).matches.map((match) => match.chunkIndex)).toEqual(Array.from({ length: 20 }, (_, i) => i));
  }, 20_000);

  it("bounds the physical queue, cancels queued work, and refuses requests after closing", async () => {
    const query = { userId: "u", embeddingModel: "test-model", embedding: [1, 0], limit: 5, minScore: 0.2 };
    const controller = new AbortController();
    const first = scanner.search(query);
    const second = scanner.search(query, controller.signal);
    await expect(scanner.search(query)).rejects.toMatchObject({ code: "SEARCH_BUSY" });
    controller.abort(new Error("caller cancelled"));
    await expect(second).rejects.toThrow("caller cancelled");
    await first;
    // close also joins any cancelled job still awaiting acknowledgement
    await scanner.close();
    await expect(scanner.search(query)).rejects.toMatchObject({ code: "OPERATION_CANCELLED" });
  });
});

describe("semantic worker lifecycle", () => {
  const query = { userId: "u", embeddingModel: "test-model", embedding: [1, 0], limit: 5, minScore: 0.2 };
  const internals = () => scanner as unknown as { worker?: { terminate(): Promise<number> }; pending: Map<number, unknown> };
  const abortListeners = (signal: AbortSignal) => getEventListeners(signal, "abort").length;

  it("rejects, instead of throwing, when the signal is already aborted, and never starts a worker for it", async () => {
    await expect(scanner.search(query, AbortSignal.abort(new Error("already cancelled")))).rejects.toThrow("already cancelled");

    expect(internals().worker).toBeUndefined();
  });

  it("an aborted job frees its queue slot as soon as the worker acknowledges it", async () => {
    const controller = new AbortController();
    const first = scanner.search(query);
    const aborted = scanner.search(query, controller.signal);
    controller.abort(new Error("caller cancelled"));
    await expect(aborted).rejects.toThrow("caller cancelled");
    await first;

    await vi.waitFor(() => expect(internals().pending.size).toBe(0));
    await expect(scanner.search(query)).resolves.toMatchObject({ matches: [] });
  });

  it("a worker that dies rejects every pending job at once, and the next search starts a fresh worker", async () => {
    const signals = [new AbortController(), new AbortController()];
    const jobs = signals.map((controller) => scanner.search(query, controller.signal));
    const results = Promise.allSettled(jobs);

    await internals().worker?.terminate(); // as if the thread crashed before producing any result

    for (const result of await results) {
      expect(result).toMatchObject({ status: "rejected", reason: expect.objectContaining({ message: "Semantic search worker stopped" }) });
    }
    expect(internals().pending.size).toBe(0);
    expect(signals.map((controller) => abortListeners(controller.signal))).toEqual([0, 0]);

    await expect(scanner.search(query)).resolves.toMatchObject({ matches: [] });
  });

  it("closing with jobs pending cancels all of them, leaves no abort listener behind and is idempotent", async () => {
    const controllers = [new AbortController(), new AbortController()];
    const jobs = controllers.map((controller) => scanner.search(query, controller.signal));
    const results = Promise.allSettled(jobs);

    await Promise.all([scanner.close(), scanner.close()]);

    for (const result of await results) {
      expect(result).toMatchObject({ status: "rejected", reason: expect.objectContaining({ code: "OPERATION_CANCELLED" }) });
    }
    expect(controllers.map((controller) => abortListeners(controller.signal))).toEqual([0, 0]);
    expect(internals().worker).toBeUndefined();
  });

  it("removes its abort listener when a search completes normally", async () => {
    const controller = new AbortController();

    await scanner.search(query, controller.signal);

    expect(abortListeners(controller.signal)).toBe(0);
  });
});
