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

const evalCaseSchema = z.object({
  id: z.string().min(1),
  /** Whose documents are searched. */
  user: z.string().min(1).default("alice"),
  question: z.string().min(1),
  /** Sources that support an answer. Empty: the corpus has no answer (the question must not surface anything). */
  expectedSources: z.array(expectedSourceSchema),
  /** Terms the retrieved context should contain; reported as term coverage. */
  expectedTerms: z.array(z.string().min(1)).default([]),
  tags: z.array(z.string().min(1)).default([]),
});

export type ExpectedSource = z.infer<typeof expectedSourceSchema>;
export type EvalCase = z.infer<typeof evalCaseSchema>;

/** A retrieved chunk as the evaluation sees it: who owns it, which file it is from and its text. */
export type RetrievedForMatching = { owner: string; fileName: string; chunkIndex: number; content: string };

/** JSON Lines: one case per line; blank lines and lines starting with # are ignored. */
export function parseDataset(text: string): EvalCase[] {
  const cases: EvalCase[] = [];
  const seen = new Set<string>();

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

  if (cases.length === 0) {
    throw new Error("The dataset has no cases.");
  }
  return cases;
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
