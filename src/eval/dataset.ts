import { z } from "zod";

/**
 * Ground truth is identified by things that survive re-indexing: the document's file name, the owner and
 * a fragment of text that the right chunk contains. The chunk number is only a hint (and the identifier of
 * last resort) because it changes whenever CHUNK_SIZE does.
 */
const expectedSourceSchema = z
  .object({
    /** File name of the document the answer is in. Documents are addressed per case user. */
    document: z.string().min(1),
    /** A fragment of text a relevant chunk contains (case and whitespace insensitive). */
    contains: z.string().min(1).optional(),
    /** Optional 0-based chunk position at the time the case was written; only used when there is no fragment. */
    chunkHint: z.number().int().nonnegative().optional(),
  })
  .refine((source) => source.contains !== undefined || source.chunkHint !== undefined, {
    message: "an expected source needs `contains` (preferred) or `chunkHint`",
  });

/**
 * Which cases may be used to choose thresholds and ranking variants (calibration) and which are only
 * reported afterwards (validation). Assigned by hand and fixed in the file - never shuffled at run time.
 */
export const DATASET_SPLITS = ["calibration", "validation"] as const;
export type DatasetSplit = (typeof DATASET_SPLITS)[number];

const evalCaseSchema = z
  .object({
    id: z.string().min(1),
    /** Whose documents are searched. */
    user: z.string().min(1).default("alice"),
    question: z.string().min(1),
    split: z.enum(DATASET_SPLITS),
    /** Whether the asking user's documents can answer the question. Explicit, never inferred. */
    answerable: z.boolean(),
    /** Sources that support an answer. Empty exactly when the question is not answerable. */
    expectedSources: z.array(expectedSourceSchema),
    /** Terms the retrieved context should contain; reported as term coverage. */
    expectedTerms: z.array(z.string().min(1)).default([]),
    tags: z.array(z.string().min(1)).default([]),
  })
  .superRefine((evalCase, context) => {
    if (evalCase.answerable && evalCase.expectedSources.length === 0) {
      context.addIssue({ code: "custom", path: ["expectedSources"], message: "an answerable case needs at least one expected source" });
    }
    if (!evalCase.answerable && evalCase.expectedSources.length > 0) {
      context.addIssue({ code: "custom", path: ["expectedSources"], message: "a case that is not answerable cannot have an expected source" });
    }
  });

const datasetHeaderSchema = z.object({
  dataset: z.object({
    /** Bump when cases are added, removed or relabelled: metrics of different versions are not comparable. */
    version: z.number().int().positive(),
    description: z.string().optional(),
  }),
});

export type ExpectedSource = z.infer<typeof expectedSourceSchema>;
export type EvalCase = z.infer<typeof evalCaseSchema>;

export type EvalDataset = { version: number; description?: string; cases: EvalCase[] };

export type SplitCounts = { queries: number; answerable: number; unanswerable: number };
export type DatasetDescription = SplitCounts & { bySplit: Record<DatasetSplit, SplitCounts> };

/** A retrieved chunk as the evaluation sees it: who owns it, which file it is from and its text. */
export type RetrievedForMatching = { owner: string; fileName: string; chunkIndex: number; content: string };

/**
 * JSON Lines: one header line `{"dataset":{"version":2}}` and one case per line; blank lines and lines
 * starting with # are ignored.
 */
export function parseDatasetFile(text: string): EvalDataset {
  const cases: EvalCase[] = [];
  const seen = new Set<string>();
  let header: z.infer<typeof datasetHeaderSchema>["dataset"] | undefined;

  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) {
      return;
    }

    const where = `line ${index + 1}`;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid dataset ${where}: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (typeof json === "object" && json !== null && "dataset" in json) {
      const parsedHeader = datasetHeaderSchema.safeParse(json);
      if (!parsedHeader.success) {
        const problems = parsedHeader.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
        throw new Error(`Invalid dataset ${where}: ${problems.join("; ")}`);
      }
      if (header) {
        throw new Error(`Invalid dataset ${where}: more than one dataset header`);
      }
      header = parsedHeader.data.dataset;
      return;
    }

    const parsed = evalCaseSchema.safeParse(json);
    if (!parsed.success) {
      const problems = parsed.error.issues.map((issue) => `${issue.path.join(".") || "case"}: ${issue.message}`);
      throw new Error(`Invalid dataset ${where}: ${problems.join("; ")}`);
    }
    if (seen.has(parsed.data.id)) {
      throw new Error(`Invalid dataset ${where}: duplicate id "${parsed.data.id}"`);
    }
    seen.add(parsed.data.id);
    cases.push(parsed.data);
  });

  if (!header) {
    throw new Error('The dataset has no header line, e.g. {"dataset":{"version":1}}: metric history needs a version.');
  }
  if (cases.length === 0) {
    throw new Error("The dataset has no cases.");
  }
  return { version: header.version, description: header.description, cases };
}

/** Just the cases of a dataset file. */
export function parseDataset(text: string): EvalCase[] {
  return parseDatasetFile(text).cases;
}

export function describeDataset(cases: readonly EvalCase[]): DatasetDescription {
  const count = (items: readonly EvalCase[]): SplitCounts => {
    const answerable = items.filter((item) => item.answerable).length;
    return { queries: items.length, answerable, unanswerable: items.length - answerable };
  };
  return {
    ...count(cases),
    bySplit: {
      calibration: count(cases.filter((item) => item.split === "calibration")),
      validation: count(cases.filter((item) => item.split === "validation")),
    },
  };
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/** Whether a retrieved chunk satisfies one expected source of a case asked by `user`. */
export function matchesExpectedSource(chunk: RetrievedForMatching, expected: ExpectedSource, user: string) {
  if (chunk.owner !== user || chunk.fileName !== expected.document) {
    return false;
  }
  return expected.contains !== undefined
    ? squash(chunk.content).includes(squash(expected.contains))
    : chunk.chunkIndex === expected.chunkHint;
}

/** For every expected source: the 1-based rank of the first retrieved chunk that satisfies it, else null. */
export function findMatchRanks(
  retrieved: readonly RetrievedForMatching[],
  expected: readonly ExpectedSource[],
  user: string,
): Array<number | null> {
  return expected.map((source) => {
    const index = retrieved.findIndex((chunk) => matchesExpectedSource(chunk, source, user));
    return index === -1 ? null : index + 1;
  });
}
