import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCore, createIntegrityTool } from "../../src/composition-root.js";
import { loadCoreConfig, loadToolConfig } from "../../src/config/config.js";
import { createOfflineProviders } from "../../src/cli/smoke-providers.js";
import { runSmokeFlow, SmokeFailure } from "../../src/cli/smoke-flow.js";

const created: string[] = [];
afterEach(() => {
  for (const directory of created.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

describe("application smoke flow: real repositories, migrations, storage, FTS, retrieval and use cases; only the providers are fake", () => {
  it("runs the whole lifecycle in order: ingest, ask, duplicate, replace, list/doc, backup, verify, restore, ask again, delete, integrity", async () => {
    const { steps } = await runSmokeFlow();

    expect(steps.map((step) => step.name)).toEqual(["start", "ingest", "answer", "duplicate", "replace", "list/doc", "backup", "restore", "delete", "integrity"]);
    expect(steps.find((step) => step.name === "start")?.detail).toMatch(/FTS5 available.*confidence mode shadow/);
    expect(steps.find((step) => step.name === "answer")?.detail).toMatch(/handbook\.md · Operations handbook > Backups/);
    expect(steps.find((step) => step.name === "restore")?.detail).toMatch(/no re-embedding/);
  });

  it("is isolated: it never touches DATA_DIR and leaves nothing behind", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-bot-e2e-data-"));
    created.push(dataDir);
    process.env.DATA_DIR = dataDir;
    const tmpEntriesBefore = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("tg-rag-smoke-"));

    await runSmokeFlow();

    expect(fs.readdirSync(dataDir)).toEqual([]);
    expect(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("tg-rag-smoke-")).length).toBeLessThanOrEqual(tmpEntriesBefore.length);
  });

  it("the restored installation is a complete, independent installation: it opens, answers from the stored vectors and passes the deep integrity check", async () => {
    const { directory } = await runSmokeFlow({ keepFiles: true });
    created.push(directory!);
    const env = { DATA_DIR: path.join(directory!, "restored"), CHUNK_SIZE: "300", CHUNK_OVERLAP: "40", OPENAI_EMBEDDINGS_MODEL: "smoke-hashed-v1" };

    const providers = createOfflineProviders();
    const core = createCore(loadCoreConfig(env), providers);
    const bobs = await core.useCases.listDocuments.execute("smoke-user-bob");
    const answer = await core.useCases.answerQuestion.execute({ userId: "smoke-user-bob", question: "How much sun do tomatoes need?" });
    core.close();
    const tool = createIntegrityTool(loadToolConfig(env), { writable: false, verifyHashes: true });
    const report = await tool.inspect.execute();
    tool.close();

    expect(bobs).toHaveLength(1);
    expect(answer.kind).toBe("answered");
    expect(providers.embeddings.calls).toBe(1); // the query only: nothing was embedded again
    expect(report.issues).toEqual([]);
  });

  it("names the step that misbehaved", async () => {
    // A recognisable failure: a step that asserts something false.
    const failure = new SmokeFailure("answer", "the question was not answered");

    expect(failure.message).toBe("answer: the question was not answered");
    expect(failure.step).toBe("answer");
  });
});
