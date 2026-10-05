import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCore, createIntegrityTool } from "../composition-root.js";
import type { Core } from "../composition-root.js";
import { loadCoreConfig, loadToolConfig } from "../config/config.js";
import { createBackup } from "../infrastructure/backup/create-backup.js";
import { restoreBackup } from "../infrastructure/backup/restore-backup.js";
import { verifyBackup } from "../infrastructure/backup/verify-backup.js";
import { LATEST_SCHEMA_VERSION } from "../infrastructure/sqlite/migrations.js";
import { APPLICATION_VERSION } from "../shared/version.js";
import { createOfflineProviders } from "./smoke-providers.js";

export type SmokeStep = { name: string; detail: string };

/** A step of the flow did not behave: which one, and what was wrong. */
export class SmokeFailure extends Error {
  constructor(
    readonly step: string,
    message: string,
  ) {
    super(`${step}: ${message}`);
    this.name = "SmokeFailure";
  }
}

const HANDBOOK = `# Operations handbook

## Backups
The nightly backup runs at 02:00 UTC and keeps seven daily copies. A backup contains the database and the original files.

## Restores
To restore, stop the service, verify the backup, and run the restore command. A restore never overwrites live data without an explicit flag.

## Contacts
For questions about this handbook contact the platform team.
`;
const HANDBOOK_V2 = HANDBOOK.replace("02:00 UTC", "04:30 UTC");
const GARDEN = "# Garden notes\n\nTomatoes need six hours of direct sun and regular watering.\n";

const ALICE = "smoke-user-alice";
const BOB = "smoke-user-bob";
const QUESTION = "When does the nightly backup run?";

/**
 * The application-level smoke flow, shared by `npm run smoke` (from the compiled build) and the end-to-end test:
 *
 *   start the real core (migrations, FTS5, repositories, storage, retrieval, use cases) around OFFLINE providers
 *   ingest Markdown -> ask (retrieve, answer, citation) -> duplicate upload -> replace -> list / doc
 *   -> backup -> verify the backup -> restore it into a NEW installation -> ask again there -> delete -> integrity clean
 *
 * Everything runs in a temporary directory that is removed afterwards. Only the external providers (embeddings, chat model, speech)
 * are fakes; no network and no credentials are involved. Throws SmokeFailure naming the step that misbehaved.
 */
export async function runSmokeFlow(options: { keepFiles?: boolean } = {}): Promise<{ steps: SmokeStep[]; directory?: string }> {
  const steps: SmokeStep[] = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tg-rag-smoke-"));
  const open: Core[] = [];

  const step = (name: string, detail: string) => steps.push({ name, detail });
  function expect(condition: unknown, name: string, message: string): asserts condition {
    if (!condition) throw new SmokeFailure(name, message);
  }
  const env = (directory: string) => ({ DATA_DIR: path.join(root, directory), CHUNK_SIZE: "300", CHUNK_OVERLAP: "40", OPENAI_EMBEDDINGS_MODEL: "smoke-hashed-v1" });
  const providers = createOfflineProviders();
  const start = (directory: string) => {
    const core = createCore(loadCoreConfig(env(directory)), providers);
    open.push(core);
    return core;
  };
  const closeAll = () => {
    for (const core of open.splice(0)) core.close();
  };

  try {
    // 1. Start
    const liveConfig = loadCoreConfig(env("live"));
    const live = start("live");
    expect(live.readiness.schemaVersion === LATEST_SCHEMA_VERSION, "start", `schema ${live.readiness.schemaVersion}, expected ${LATEST_SCHEMA_VERSION}`);
    const fts5 = live.db.prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS enabled").get() as { enabled: number };
    expect(fts5.enabled === 1, "start", "this SQLite build has no FTS5");
    expect(live.db.pragma("foreign_keys", { simple: true }) === 1 && live.db.pragma("journal_mode", { simple: true }) === "wal", "start", "connection pragmas are not applied");
    expect(live.readiness.confidenceMode === "shadow", "start", `confidence mode is ${live.readiness.confidenceMode}, the default must be shadow`);
    step("start", `schema ${live.readiness.schemaVersion}, FTS5 available, WAL + foreign keys on, confidence mode shadow, version ${APPLICATION_VERSION}`);

    // 2. Ingest
    const { ingestDocument, replaceDocument, answerQuestion, listDocuments, getDocument } = live.useCases;
    const created = await ingestDocument.execute({ userId: ALICE, fileName: "handbook.md", mimeType: "text/markdown", data: Buffer.from(HANDBOOK) });
    expect(created.kind === "created" && created.chunksCount > 0, "ingest", `unexpected result ${created.kind}`);
    const documentId = created.documentId;
    await ingestDocument.execute({ userId: BOB, fileName: "garden.md", mimeType: "text/markdown", data: Buffer.from(GARDEN) });
    step("ingest", `${created.chunksCount} chunks for one user's Markdown file; a second user's file stored separately`);

    // 3. Retrieve, answer, cite
    const answer = await answerQuestion.execute({ userId: ALICE, question: QUESTION });
    expect(answer.kind === "answered", "answer", `the question was not answered (${answer.kind})`);
    const source = answer.sources[0];
    expect(source?.documentId === documentId && source.fileName === "handbook.md", "answer", "the first source is not the user's handbook");
    expect(source.sectionPath?.join(" > ").includes("Backups"), "answer", `the citation has no Markdown section (${source.sectionPath?.join(" > ")})`);
    expect(answer.citations.cited.includes(1) && answer.citations.removed.length === 0, "answer", "the answer's [1] reference was not grounded");
    const bobsView = await answerQuestion.execute({ userId: BOB, question: QUESTION });
    expect(bobsView.kind !== "answered" || bobsView.sources.every((candidate) => candidate.documentId !== documentId), "answer", "another user's document was retrieved");
    step("answer", `cited ${source.fileName} · ${source.sectionPath?.join(" > ")}; the other user cannot reach it`);

    // 4. Duplicate upload
    const duplicate = await ingestDocument.execute({ userId: ALICE, fileName: "copy-of-handbook.md", mimeType: "text/markdown", data: Buffer.from(HANDBOOK) });
    expect(duplicate.kind === "already-exists" && duplicate.documentId === documentId, "duplicate", "the same bytes were not recognised");
    step("duplicate", "the same bytes are recognised and nothing is stored twice");

    // 5. Replace
    const replaced = await replaceDocument.execute({ userId: ALICE, documentId, fileName: "handbook.md", mimeType: "text/markdown", data: Buffer.from(HANDBOOK_V2) });
    expect(replaced.kind === "replaced" && replaced.documentVersion === 2, "replace", `unexpected result ${replaced.kind}`);
    const afterReplace = await answerQuestion.execute({ userId: ALICE, question: QUESTION });
    const context = JSON.stringify(providers.chatModel.calls.at(-1));
    expect(afterReplace.kind === "answered" && context.includes("04:30") && !context.includes("02:00"), "replace", "questions do not use the new content");
    step("replace", "version 2; questions use the new content only");

    // 6. List / doc
    const listed = await listDocuments.execute(ALICE);
    const info = await getDocument.execute(ALICE, documentId);
    expect(listed.length === 1 && info.health.state === "current" && info.chunksCount > 0, "list/doc", `health is ${info.health.state}`);
    step("list/doc", `1 document, version ${info.document.documentVersion}, index ${info.health.state}`);

    // 7. Backup + verify
    const recipe = { embeddingModel: providers.embeddings.model, chunkSize: 300, chunkOverlap: 40 };
    const backupDir = path.join(root, "backup");
    const manifest = await createBackup({ db: live.db, filesDir: liveConfig.storage.filesDir, outputDir: backupDir, now: () => new Date(), applicationVersion: APPLICATION_VERSION });
    const verification = await verifyBackup(backupDir, { recipe, now: Date.now });
    expect(verification.ok, "backup", `the backup did not verify: ${verification.problems.join("; ")}`);
    step("backup", `${manifest.counts.documents} documents, ${manifest.counts.files} files; verified (hashes, database, integrity)`);
    closeAll();

    // 8. Restore into a NEW installation and use it
    const restoredConfig = loadCoreConfig(env("restored"));
    const restore = await restoreBackup({ backupDir, target: restoredConfig.storage, replaceExisting: false, recipe, legacyEmbeddingModel: providers.embeddings.model, now: () => new Date() });
    expect(restore.outcome === "restored" && restore.documents === 2, "restore", `restored ${restore.documents} documents`);
    const restored = start("restored");
    const callsBefore = providers.embeddings.calls;
    const again = await restored.useCases.answerQuestion.execute({ userId: ALICE, question: QUESTION });
    expect(again.kind === "answered" && again.sources[0]?.documentId === documentId, "restore", "the restored installation does not answer from the restored document");
    expect(providers.embeddings.calls - callsBefore === 1, "restore", "restoring caused documents to be embedded again");
    step("restore", "restored into a new installation; the same question is answered from the stored vectors and text (1 query embedding, no re-embedding)");

    // 9. Delete
    await restored.useCases.deleteDocument.execute(ALICE, documentId);
    expect((await restored.useCases.listDocuments.execute(ALICE)).length === 0, "delete", "the document is still listed");
    const left = (await restored.files.list()).filter((entry) => entry.kind === "stored").length;
    expect(left === 1, "delete", `${left} stored files remain, expected only the other user's`);
    closeAll();
    step("delete", "the document, its chunks and its file are gone; the other user's document is untouched");

    // 10. Integrity
    const tool = createIntegrityTool(loadToolConfig(env("restored")), { writable: false, verifyHashes: true });
    try {
      const report = await tool.inspect.execute();
      expect(report.issues.length === 0, "integrity", report.issues.map((issue) => `${issue.code}: ${issue.message}`).join("; "));
      step("integrity", `clean: ${report.summary.documents} documents, ${report.summary.chunks} chunks, full-text index consistent`);
    } finally {
      tool.close();
    }

    return { steps, directory: options.keepFiles ? root : undefined };
  } finally {
    closeAll();
    if (!options.keepFiles) fs.rmSync(root, { recursive: true, force: true });
  }
}
