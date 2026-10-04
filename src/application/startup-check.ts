import { classifyStorage } from "../core/storage-layout.js";
import type { InfoLog, WarnLog } from "../shared/logger.js";
import type { ActiveRecipe } from "./assess-index.js";
import { checkIndexCompatibility } from "./check-index-compatibility.js";
import type { FileStorage } from "./ports/file-storage.js";
import type { IndexMaintenance } from "./ports/index-maintenance.js";
import type { IntegrityStore } from "./ports/integrity-store.js";

export type StartupSummary = {
  documents: number;
  embeddingStale: number;
  chunkingStale: number;
  extractorStale: number;
  /** Documents whose original file is gone from storage. */
  missingOriginals: number;
  /** Leftovers of interrupted writes that are old enough not to belong to a running one. */
  staleTemporaryFiles: number;
  /** Stored files that no document refers to. */
  orphanFiles: number;
};

type Dependencies = {
  store: IntegrityStore;
  maintenance: IndexMaintenance;
  files: FileStorage;
  recipe: Omit<ActiveRecipe, "embeddingDimension">;
  now: () => number;
  log: InfoLog & WarnLog;
};

/**
 * The cheap health summary logged at every start: counts only, read from one aggregate query, one list of
 * referenced file names and one directory listing. It does not read file contents, hash anything, repair
 * anything or call a provider, and it never prevents the bot from starting. The deep checks and the
 * repairs are `npm run integrity`.
 *
 * Outdated indexes are reported by checkIndexCompatibility (with the commands that fix them); this adds the
 * storage side: missing originals, stale temporary files, orphan files.
 */
export async function runStartupCheck(deps: Dependencies): Promise<StartupSummary> {
  const { store, maintenance, files, recipe, log } = deps;

  const index = await checkIndexCompatibility(maintenance, recipe, log);
  const documents = (await maintenance.listIndexedDocuments({ model: recipe.embeddingModel })).length;

  const summary: StartupSummary = {
    documents,
    embeddingStale: index.embeddingStale,
    chunkingStale: index.chunkingStale,
    extractorStale: index.extractorStale,
    missingOriginals: 0,
    staleTemporaryFiles: 0,
    orphanFiles: 0,
  };

  try {
    const layout = classifyStorage(await files.list(), new Set(await store.listReferencedFiles()), deps.now());
    summary.missingOriginals = layout.missing.length;
    summary.staleTemporaryFiles = layout.temporary.filter((item) => item.stale).length;
    summary.orphanFiles = layout.orphans.length;
  } catch (err) {
    log.warn({ stage: "startup-check", err }, "The file storage could not be inspected at startup; run `npm run integrity` to check it");
  }

  const problems = summary.embeddingStale + summary.chunkingStale + summary.extractorStale + summary.missingOriginals + summary.staleTemporaryFiles + summary.orphanFiles;
  if (problems > 0) {
    log.warn(
      { stage: "startup-check", ...summary },
      "Startup check found things that need attention (details: `npm run integrity`; outdated indexes: `npm run reindex -- --dry-run`)",
    );
  } else {
    log.info({ stage: "startup-check", ...summary }, "Startup check passed");
  }

  return summary;
}
