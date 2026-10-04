import fs from "node:fs";
import path from "node:path";
import type { EmbeddingsProvider } from "../application/ports/embeddings-provider.js";
import type { FileStorage } from "../application/ports/file-storage.js";
import type { DocumentTextExtractor } from "../application/ports/text-extractor.js";
import type { VectorStore } from "../application/ports/vector-store.js";
import { IngestDocumentUseCase } from "../application/use-cases/ingest-document.use-case.js";
import { openDatabase } from "../infrastructure/sqlite/database.js";
import { SqliteDocumentRepository } from "../infrastructure/sqlite/sqlite-document-repository.js";
import { SqliteVectorStore } from "../infrastructure/sqlite/sqlite-vector-store.js";

/** One fixture document: who owns it, its file name and its text. */
export type CorpusDocument = { owner: string; fileName: string; content: string };

export type ChunkingSettings = { chunkSize: number; chunkOverlap: number };

/** An index built from a corpus. Everything in it is the real production storage, held in memory. */
export type EvalIndex = {
  vectorStore: VectorStore;
  /** Document id -> owner, so a retrieved chunk can be attributed (and leaks detected). */
  owners: ReadonlyMap<string, string>;
  /** Chunks stored for the whole corpus. */
  chunkCount: number;
  close(): void;
};

/** Reads `<dir>/<owner>/<file>` for every file: the directory name is the owning user. */
export function loadCorpus(directory: string): CorpusDocument[] {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((owner) =>
      fs
        .readdirSync(path.join(directory, owner.name), { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((file) => ({
          owner: owner.name,
          fileName: file.name,
          content: fs.readFileSync(path.join(directory, owner.name, file.name), "utf-8"),
        })),
    )
    .sort((a, b) => a.owner.localeCompare(b.owner) || a.fileName.localeCompare(b.fileName));
}

class MemoryFileStorage implements FileStorage {
  private readonly files = new Map<string, Buffer>();

  async save(fileName: string, data: Buffer) {
    const storedName = `${this.files.size}-${fileName}`;
    this.files.set(storedName, data);
    return storedName;
  }

  async read(storedName: string) {
    const data = this.files.get(storedName);
    if (!data) throw new Error(`No such file: ${storedName}`);
    return data;
  }

  async delete(storedName: string) {
    this.files.delete(storedName);
  }
}

const utf8Extractor: DocumentTextExtractor = {
  async extract(input) {
    return { text: input.data.toString("utf-8") };
  },
};

/**
 * Indexes a corpus through the production ingestion use case: normalization, splitting with the given
 * chunking, embedding, the profile, and the SQLite transaction that also fills the FTS index. Retrieval
 * is then run against exactly the storage the bot uses, so evaluation measures the real FTS query,
 * vector scan, RRF, de-duplication and context selection - not a re-implementation of them.
 */
export async function buildEvalIndex(
  corpus: readonly CorpusDocument[],
  chunking: ChunkingSettings,
  embeddings: EmbeddingsProvider,
): Promise<EvalIndex> {
  const db = openDatabase(":memory:", { legacyEmbeddingModel: embeddings.model });
  try {
    // Ranking ties are broken by document id, so ids must not be random or two runs could order tied chunks differently.
    let sequence = 0;
    const ingest = new IngestDocumentUseCase({
      newId: () => `doc-${String((sequence += 1)).padStart(4, "0")}`,
      documents: new SqliteDocumentRepository(db),
      files: new MemoryFileStorage(),
      extractor: utf8Extractor,
      embeddings,
      options: {
        maxUploadBytes: Number.MAX_SAFE_INTEGER,
        ...chunking,
        maxDocumentsPerUser: Number.MAX_SAFE_INTEGER,
        maxStorageBytesPerUser: Number.MAX_SAFE_INTEGER,
        maxChunksPerDocument: Number.MAX_SAFE_INTEGER,
      },
    });

    const owners = new Map<string, string>();
    let chunkCount = 0;
    for (const document of corpus) {
      const result = await ingest.execute({
        userId: document.owner,
        fileName: document.fileName,
        mimeType: "text/markdown",
        data: Buffer.from(document.content, "utf-8"),
      });
      owners.set(result.documentId, document.owner);
      chunkCount += result.chunksCount;
    }

    return { vectorStore: new SqliteVectorStore(db), owners, chunkCount, close: () => db.close() };
  } catch (error) {
    db.close();
    throw error;
  }
}
