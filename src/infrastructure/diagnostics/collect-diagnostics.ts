import type Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { assessDocument, healthOf } from "../../application/assess-index.js";
import type { ActiveRecipe } from "../../application/assess-index.js";
import { DataDirectoryRestoreArtifacts } from "../backup/restore-artifacts.js";
import { LATEST_SCHEMA_VERSION } from "../sqlite/migrations.js";
import { readPragmas } from "../sqlite/database.js";
import { SqliteIndexMaintenance } from "../sqlite/sqlite-index-maintenance.js";
import { LocalFileStorage } from "../storage/local-file-storage.js";

/**
 * Everything a bug report needs and nothing it must not contain: counts, versions, states and configuration NAMES. It has no field for a
 * secret, a document's text, a question, an answer, a user id or a file name, and it names the data directory by its last path segment only.
 */
export type Diagnostics = {
  application: { version: string; node: string; platform: string; arch: string };
  sqlite: {
    version: string;
    fts5Compiled: boolean;
    fullTextIndexPresent: boolean;
    schemaVersion: number;
    expectedSchemaVersion: number;
    pragmas: ReturnType<typeof readPragmas>;
  };
  data: {
    directoryName: string;
    directoryWritable: boolean;
    databaseBytes: number;
    users: number;
    documents: number;
    chunks: number;
    feedbackRatings: number;
    storedFiles: number;
    storedFileBytes: number;
    temporaryFiles: number;
    unreferencedFiles: number;
    restoreStagingDirectories: number;
    previousInstallations: number;
  };
  /** Per document, from the stored recipe and chunks. `null` when the schema is not the current one (the columns are not there yet). */
  index: { staleDocuments: number; corruptIndexDocuments: number; unindexedDocuments: number; missingOriginals: number } | null;
  configuration: {
    retrievalConfidenceMode: string;
    chatModel: string;
    embeddingsModel: string;
    transcribeModel: string;
    chunkSize: number;
    chunkOverlap: number;
    maxChunksPerDocument: number;
    maxPdfPages: number;
  };
  warnings: string[];
};

export type DiagnosticsInput = {
  db: Database.Database;
  dataDir: string;
  sqlitePath: string;
  filesDir: string;
  application: { version: string };
  configuration: Diagnostics["configuration"];
  recipe: Omit<ActiveRecipe, "embeddingDimension">;
};

const scalar = (db: Database.Database, sql: string) => (db.prepare<[], { n: number }>(sql).get()?.n ?? 0);
const sizeOf = (file: string) => {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
};

export async function collectDiagnostics(input: DiagnosticsInput): Promise<Diagnostics> {
  const { db } = input;
  const warnings: string[] = [];

  const schemaVersion = db.pragma("user_version", { simple: true }) as number;
  if (schemaVersion !== LATEST_SCHEMA_VERSION) {
    warnings.push(`The database schema is version ${schemaVersion}, this application expects ${LATEST_SCHEMA_VERSION}: start the bot once to migrate it.`);
  }

  const entries = await new LocalFileStorage(input.filesDir).list();
  const referenced = new Set((db.prepare<[], { name: string }>("SELECT stored_name AS name FROM documents").all()).map((row) => row.name));
  const stored = entries.filter((entry) => entry.kind === "stored");
  const restoreArtifacts = await new DataDirectoryRestoreArtifacts(input.dataDir).list();

  let writable = true;
  try {
    fs.accessSync(input.dataDir, fs.constants.R_OK | fs.constants.W_OK);
  } catch {
    writable = false;
    warnings.push("The data directory is not readable and writable by this process.");
  }

  let index: Diagnostics["index"] = null;
  if (schemaVersion === LATEST_SCHEMA_VERSION) {
    const documents = await new SqliteIndexMaintenance(db).listIndexedDocuments({ model: input.recipe.embeddingModel });
    const present = new Set(stored.map((entry) => entry.name));
    const storedNames = new Map(db.prepare<[], { id: string; name: string }>("SELECT id, stored_name AS name FROM documents").all().map((row) => [row.id, row.name]));
    const states = documents.map((document) => healthOf(assessDocument(document, input.recipe), !present.has(storedNames.get(document.documentId) ?? "")));
    index = {
      staleDocuments: states.filter((health) => health.issues.some((issue) => issue.endsWith("-stale"))).length,
      corruptIndexDocuments: states.filter((health) => health.issues.includes("corrupt-index")).length,
      unindexedDocuments: states.filter((health) => health.issues.includes("unindexed")).length,
      missingOriginals: states.filter((health) => health.issues.includes("missing-file")).length,
    };
  }

  const fts5Compiled = (db.prepare<[], { enabled: number }>("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS enabled").get()?.enabled ?? 0) === 1;
  const fullTextIndexPresent = scalar(db, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'chunk_fts'") > 0;
  if (!fts5Compiled) warnings.push("This SQLite build has no FTS5: keyword search cannot work.");
  if (fts5Compiled && !fullTextIndexPresent) warnings.push("The full-text index table is missing (schema older than 4?).");

  return {
    application: { version: input.application.version, node: process.versions.node, platform: process.platform, arch: process.arch },
    sqlite: {
      version: db.prepare<[], { v: string }>("SELECT sqlite_version() AS v").get()?.v ?? "unknown",
      fts5Compiled,
      fullTextIndexPresent,
      schemaVersion,
      expectedSchemaVersion: LATEST_SCHEMA_VERSION,
      pragmas: readPragmas(db),
    },
    data: {
      directoryName: path.basename(input.dataDir),
      directoryWritable: writable,
      databaseBytes: sizeOf(input.sqlitePath) + sizeOf(`${input.sqlitePath}-wal`),
      users: scalar(db, "SELECT COUNT(DISTINCT user_id) AS n FROM documents"),
      documents: scalar(db, "SELECT COUNT(*) AS n FROM documents"),
      chunks: scalar(db, "SELECT COUNT(*) AS n FROM document_chunks"),
      feedbackRatings: scalar(db, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'answer_feedback'") > 0 ? scalar(db, "SELECT COUNT(*) AS n FROM answer_feedback") : 0,
      storedFiles: stored.length,
      storedFileBytes: stored.reduce((sum, entry) => sum + entry.size, 0),
      temporaryFiles: entries.filter((entry) => entry.kind === "temporary").length,
      unreferencedFiles: stored.filter((entry) => !referenced.has(entry.name)).length,
      restoreStagingDirectories: restoreArtifacts.filter((artifact) => artifact.kind === "staging").length,
      previousInstallations: restoreArtifacts.filter((artifact) => artifact.kind === "previous-installation").length,
    },
    index,
    configuration: input.configuration,
    warnings,
  };
}
