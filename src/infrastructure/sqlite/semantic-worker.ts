import type Database from "better-sqlite3";
import { parentPort, workerData } from "node:worker_threads";
import type { SimilaritySearch } from "../../application/ports/vector-store.js";
import { scoreVectors, VECTOR_COLUMNS } from "./semantic-search.js";
import type { VectorRow } from "./semantic-search.js";
import { openDatabaseReadOnly } from "./database.js";

parentPort!.on("message", (job: { id: number; search: SimilaritySearch; cancellation: SharedArrayBuffer }) => {
  let db: Database.Database | undefined;
  try {
    const cancelled = new Int32Array(job.cancellation);
    const check = () => { if (Atomics.load(cancelled, 0)) throw new Error("Search cancelled"); };
    check();
    // Never keep an idle SQLite handle: backups/restores can acquire their own barriers after a job.
    db = openDatabaseReadOnly(workerData.databasePath);
    const sql = `${VECTOR_COLUMNS}${job.search.documentId ? " AND document_id = @documentId" : ""}`;
    const rows = db.prepare<Record<string, string>, VectorRow>(sql).iterate({
      userId: job.search.userId,
      embeddingModel: job.search.embeddingModel,
      ...(job.search.documentId ? { documentId: job.search.documentId } : {}),
    });
    const result = scoreVectors(rows, job.search, check);
    parentPort!.postMessage({ id: job.id, result });
  } catch (error) {
    parentPort!.postMessage({ id: job.id, error: error instanceof Error ? error.message : "Semantic search failed" });
  } finally {
    db?.close();
  }
});
