import { Worker } from "node:worker_threads";
import type { SimilaritySearch } from "../../application/ports/vector-store.js";
import { AppError, ExternalServiceError } from "../../shared/errors.js";
import { OperationCancelledError } from "../../shared/operation.js";
import type { SemanticResult } from "./semantic-search.js";

type Pending = {
  resolve(result: SemanticResult): void;
  reject(error: unknown): void;
  signal?: AbortSignal;
  abort(): void;
  flag: Int32Array;
};

/** One CPU worker, at most 16 physical jobs queued; aborted jobs remain counted until acknowledged. */
export class SemanticScanner {
  private worker?: Worker;
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private closed = false;
  private closing?: Promise<void>;

  constructor(private readonly databasePath: string, private readonly maxPending = 16) {}

  search(search: SimilaritySearch, signal?: AbortSignal): Promise<SemanticResult> {
    signal?.throwIfAborted();
    if (this.closed) return Promise.reject(new OperationCancelledError());
    if (this.pending.size >= this.maxPending) {
      return Promise.reject(new AppError("Search is busy. Please try again shortly.", "SEARCH_BUSY"));
    }
    const worker = this.getWorker();
    const id = ++this.nextId;
    const flag = new Int32Array(new SharedArrayBuffer(4));
    worker.ref();
    return new Promise((resolve, reject) => {
      const abort = () => { Atomics.store(flag, 0, 1); reject(signal?.reason ?? new OperationCancelledError()); };
      this.pending.set(id, { resolve, reject, signal, abort, flag });
      signal?.addEventListener("abort", abort, { once: true });
      try { worker.postMessage({ id, search, cancellation: flag.buffer }); }
      catch (error) { this.finish(id, undefined, error); }
    });
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      this.closed = true;
      for (const [id, job] of this.pending) {
        Atomics.store(job.flag, 0, 1);
        this.finish(id, undefined, new OperationCancelledError());
      }
      await this.worker?.terminate();
      this.worker = undefined;
    })();
    return this.closing;
  }

  private getWorker(): Worker {
    if (this.worker) return this.worker;
    const source = import.meta.url.endsWith(".ts");
    const moduleUrl = new URL(source ? "./semantic-worker.ts" : "./semantic-worker.js", import.meta.url).href;
    // tsx is used only by source-mode development/tests; the compiled runtime has no loader dependency.
    const worker = new Worker(source
      ? 'const { workerData } = require("node:worker_threads"); import("tsx/esm/api").then(({ tsImport }) => tsImport(workerData.moduleUrl, workerData.moduleUrl));'
      : new URL(moduleUrl), {
      eval: source,
      workerData: { databasePath: this.databasePath, moduleUrl },
    });
    this.worker = worker;
    worker.on("message", (message: { id: number; result?: SemanticResult; error?: string }) => {
      this.finish(message.id, message.result, message.error ? new ExternalServiceError("search", { cause: new Error(message.error) }, "Search failed. Please try again.") : undefined);
    });
    const failed = (error: Error) => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      for (const id of this.pending.keys()) this.finish(id, undefined, error);
    };
    worker.on("error", failed);
    worker.on("exit", () => failed(new Error("Semantic search worker stopped")));
    worker.unref();
    return worker;
  }

  private finish(id: number, result?: SemanticResult, error?: unknown) {
    const job = this.pending.get(id);
    if (!job) return;
    this.pending.delete(id);
    job.signal?.removeEventListener("abort", job.abort);
    if (error || !result) job.reject(error ?? new Error("Missing search result"));
    else job.resolve(result);
    if (this.pending.size === 0) this.worker?.unref();
  }
}
