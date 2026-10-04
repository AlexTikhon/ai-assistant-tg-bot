import { z } from "zod";
import type { EmbeddingsProvider } from "../application/ports/embeddings-provider.js";
import type { EvalCase } from "./dataset.js";
import { buildEvalIndex } from "./harness.js";
import type { ChunkingSettings, CorpusDocument, EvalIndex } from "./harness.js";
import { runEvaluation } from "./runner.js";
import type { EvalReport, RetrievalSettings } from "./runner.js";

/** Everything that can differ between two evaluated configurations: indexing and query-time settings. */
export type EvalSettings = ChunkingSettings & RetrievalSettings;

export type ConfigOverride = { name: string } & Partial<EvalSettings>;

const comparisonSchema = z.object({
  configs: z
    .array(
      z
        .object({
          name: z.string().min(1),
          chunkSize: z.number().int().positive().optional(),
          chunkOverlap: z.number().int().nonnegative().optional(),
          topK: z.number().int().positive().optional(),
          minScore: z.number().min(-1).max(1).optional(),
          semanticLimit: z.number().int().nonnegative().optional(),
          lexicalLimit: z.number().int().nonnegative().optional(),
          rrfK: z.number().positive().optional(),
          contextMaxChars: z.number().int().positive().optional(),
        })
        .strict(),
    )
    .min(1, "at least one configuration is required"),
});

/** A comparison file: `{ "configs": [{ "name": "...", "rrfK": 40, ... }] }`. Missing settings come from the base. */
export function parseComparison(json: string): ConfigOverride[] {
  const parsed = comparisonSchema.safeParse(JSON.parse(json));
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".") || "comparison"}: ${issue.message}`);
    throw new Error(`Invalid comparison file: ${problems.join("; ")}`);
  }

  const names = parsed.data.configs.map((config) => config.name);
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate !== undefined) {
    throw new Error(`Invalid comparison file: duplicate configuration name "${duplicate}"`);
  }
  return parsed.data.configs;
}

export type ComparisonResult = {
  name: string;
  settings: EvalSettings;
  chunkCount: number;
  report: EvalReport;
};

export type CompareInput = {
  corpus: readonly CorpusDocument[];
  cases: readonly EvalCase[];
  embeddings: EmbeddingsProvider;
  /** Settings every configuration starts from. */
  base: EvalSettings;
  configs: readonly ConfigOverride[];
  ks?: readonly number[];
};

/**
 * Runs the same questions against each configuration, in order. The corpus is indexed once per distinct
 * chunking (re-indexing only when chunk size or overlap differ); query-time settings are free to change.
 * A plain side-by-side runner: it reports, it never picks a winner or touches any configuration.
 */
export async function compareConfigs(input: CompareInput): Promise<ComparisonResult[]> {
  const indexes = new Map<string, EvalIndex>();
  try {
    const results: ComparisonResult[] = [];

    for (const { name, ...overrides } of input.configs) {
      const settings: EvalSettings = { ...input.base, ...definedOnly(overrides) };
      if (settings.chunkOverlap >= settings.chunkSize) {
        throw new Error(`Configuration "${name}": chunkOverlap must be smaller than chunkSize.`);
      }

      const key = `${settings.chunkSize}/${settings.chunkOverlap}`;
      let index = indexes.get(key);
      if (!index) {
        index = await buildEvalIndex(input.corpus, settings, input.embeddings);
        indexes.set(key, index);
      }

      const report = await runEvaluation({
        cases: input.cases,
        index,
        embeddings: input.embeddings,
        retrieval: settings,
        ks: input.ks,
      });
      results.push({ name, settings, chunkCount: index.chunkCount, report });
    }

    return results;
  } finally {
    indexes.forEach((index) => index.close());
  }
}

function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
