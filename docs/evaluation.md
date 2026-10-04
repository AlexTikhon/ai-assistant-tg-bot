# Evaluating retrieval and the answerability gate

Retrieval changes are judged by numbers, not intuition. The evaluation runs the **real** pipeline - production ingestion into an in-memory SQLite database (real chunking and FTS triggers), the real FTS query, vector scan, RRF, exact-token bonus, de-duplication, caps, context budget and the confidence gate - and scores what the model would be given. It never calls a chat model, never touches your database, needs no Telegram token and, by default, no OpenAI key.

```bash
npm run eval:retrieval                    # report for the configured settings
npm run eval:retrieval -- --verbose       # + the evidence (signals) and retrieved chunks of every question
npm run eval:retrieval -- --json > eval.json
npm run eval:confidence                   # calibrate the confidence gate (calibration split) and report validation separately
npm run eval:retrieval -- --compare eval/comparisons/ranking.json    # ranking variants side by side
npm run eval:retrieval -- --compare eval/comparisons/default.json    # settings grid (RRF k, limits, chunk sizes, ...)
npm run test:retrieval                    # regression gate against eval/baseline.json (exit 1 on regression)
npm run bench:retrieval                   # timings of each stage on generated data
npm run eval:diff -- offline.json live.json
```

Embeddings come from a deterministic offline embedder (`eval-lexicon-v1`: one dimension per synonym group in `eval/embedding-lexicon.json`, plus a small hashed bag of words). Runs are reproducible byte for byte. **The offline numbers validate the pipeline and catch regressions; they do not predict OpenAI embedding quality**, and cosine scores in particular are on a different scale than a real model's.

## Dataset (version 2)

`eval/datasets/retrieval.jsonl`: a header line `{"dataset":{"version":2,...}}` and one case per line; corpus in `eval/corpus/<user>/<file>` (17 documents, two users). 61 questions: **44 answerable, 17 unanswerable**.

```json
{"id":"no-answer-error-e5099","user":"alice","split":"validation","answerable":false,
 "question":"What does error code E-5099 mean?","expectedSources":[],
 "tags":["no-answer","missing-identifier","exact-term","error-code"]}
```

- **`answerable` is explicit** on every case; answerable cases carry expected sources, unanswerable ones none (the parser enforces both).
- **Ground truth** is owner + file name + a text fragment the right chunk contains (`chunkHint` is only a hint), so changing `CHUNK_SIZE` cannot silently invalidate the dataset; a test checks every fragment is still inside some chunk at chunk sizes 500-1500.
- **Unanswerable kinds** (17): `unrelated` (3), `missing-fact` (2: AWS region, parental leave), `similar-terms` (2: connection-pool size, log retention), `wrong-entity` (PurrFeed 5 vs 3), `missing-file` (`deployment-guide.md`), `missing-identifier` (4: `E-5099`, `ECONNREFUSED`, `HTTP_418`, `v3.2.0`), `cross-user` (4: the answer exists, but only in another user's documents).
- **`split`** is `calibration` or `validation`, assigned by hand and fixed in the file (39 / 22 questions, both splits contain answerable and unanswerable ones). Never shuffled at run time; do not move a case after seeing its result.
- The **version** (and the index fingerprint) is in every report and export, so metric history is meaningful: metrics of different dataset versions are not comparable. Bump it when cases are added, removed or relabelled. History is files, not a database.

> This is a small local corpus. One question is 1.6% of the answerable set; differences of one or two questions are noise. It is a regression harness and a decision aid, not a statistically rigorous benchmark.

## Metrics

Retrieval (answerable questions): Recall@K, HitRate@K, MRR, and the same *before* context selection (the gap shows what diversification costs).

Answerability (the confidence gate, `positive` = let through to the model):

| | answerable | unanswerable |
| --- | --- | --- |
| let through | TP | **FP** - weak context sent to the model |
| refused | **FN** - a valid question refused | TN |

precision, recall, specificity, false-positive rate (FPR), false-negative rate (FNR); `n/a` (JSON `null`) when a rate has no cases behind it. Everything is also broken down by tag and by split.

## Confidence signals

Computed from the loaded, user-scoped candidates only (`computeRetrievalSignals`, pure): top semantic score and its gap, top BM25 score, top RRF score and its gap, number of candidates found by both methods, exact technical tokens asked / found, and the best share of the question's content words found in one candidate. None was assumed to be useful; they are exposed in `--verbose` and `--json`, and the evaluation prints how they differ between answerable and unanswerable questions:

```text
Evidence by group:
                               answerable  unanswerable
  questions                            44            17
  median top semantic score          0.57          0.55
  median top RRF score             0.0328        0.0164
  median term coverage               0.71          0.50
  with semantic hit                   73%           59%
  with lexical hit                   100%          88%
  with dual-method hit                73%           47%
  with exact-token hit                55%            0%
```

Reading it: semantic score alone barely separates the groups on this corpus (0.57 vs 0.55); a *named identifier that exists* separates perfectly (55% vs 0%); term coverage and dual-method hits help somewhat. The gate therefore combines three rules instead of trusting one number.

## The gate

`assessRetrievalConfidence` (pure, `src/core/retrieval-confidence.ts`), first matching rule wins:

1. nothing retrieved -> abstain (`no-candidates`)
2. the question names an identifier / file name / version that **no candidate contains** -> abstain (`identifier-not-found`)
3. an exact target of the question occurs in a candidate -> answer (`exact-token`)
4. best cosine similarity >= `RETRIEVAL_CONFIDENCE_MIN_SEMANTIC_SCORE` -> answer (`semantic`)
5. one candidate contains >= `RETRIEVAL_CONFIDENCE_MIN_TERM_COVERAGE` of the question's content words -> answer (`term-coverage`)
6. otherwise abstain (`weak-evidence`)

On abstention the chat model is **not called**; the bot says "I couldn't find enough information in your uploaded documents to answer that." (it does not claim that the answer does not exist).

### Calibration protocol

`npm run eval:confidence` sweeps a fixed grid (312 policies: similarity 0.30-0.80 plus "off", coverage 0.40-1.00, identifier rule on/off) over the **calibration** split and picks the policy with the highest specificity among those keeping recall >= 0.90 (refusing valid questions is the costlier mistake); ties go to the least aggressive policy. The **validation** split is then reported separately and never consulted by the choice. A test fails when the shipped policy is no longer the one calibration chooses, so changing the dataset or the retrieval forces a deliberate re-calibration.

Result (`minSemanticScore=0.5 minTermCoverage=0.6 requireKnownIdentifiers=true`; no other policy with recall >= 0.9 has higher specificity on calibration):

| split | queries | TP | FN | FP | TN | precision | recall | specificity | FPR | FNR |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| calibration | 39 | 27 | 1 | 3 | 8 | 0.90 | 0.96 | 0.73 | 0.27 | 0.04 |
| validation | 22 | 16 | 0 | 2 | 4 | 0.89 | 1.00 | 0.67 | 0.33 | 0.00 |
| all | 61 | 43 | 1 | 5 | 12 | 0.90 | 0.98 | 0.71 | 0.29 | 0.02 |
| no gate (previous behaviour) | 61 | 44 | 0 | 17 | 0 | 0.72 | 1.00 | 0.00 | 1.00 | 0.00 |

Misclassified: wrongly refused - `paraphrase-money-back` (calibration; "How can I get my money back...", semantic 0.39, coverage 0.40). Wrongly let through - calibration: `no-answer-train-berlin`, `no-answer-parental-leave`, `no-answer-postgres-pool`; validation: `no-answer-aws-region`, `isolation-alice-cannot-see-bob` (the Lisbon hotel question matches Alice's own travel policy). These are questions whose wording is close to real content ("train", "leave", "PostgreSQL", "hotel"): with these embeddings no cheap, model-free rule separates them from a paraphrase. Per kind: missing identifiers are refused 4/4, wrong entity and missing file 1/1, unrelated 2/3, similar terms 1/2, missing fact 0/2.

**The gate is a filter, not a verdict.** It removes the clear cases (unrelated questions, absent identifiers, nothing relevant) *before* paying for generation; the system prompt still tells the model to say when the excerpts are insufficient. Do not expect it to catch every unanswerable question.

**Transfer to real embeddings is unverified.** Cosine similarities are specific to an embedding model. The 0.5 threshold was calibrated against the synthetic embedder; with `text-embedding-3-small` the right value may be lower. That is why the bot ships with the gate in **shadow** mode (`RETRIEVAL_CONFIDENCE_MODE=shadow`): the decision is logged for every question but never applied - see [Rolling out the gate](rag.md#rolling-out-the-gate). Re-run the calibration with a live run (below) and read the shadow log (or the optional feedback buttons) before switching to `enforce`; use `off` to disable the gate completely. The identifier and exact-token rules do not depend on the embedding scale. The mode is an operating setting, not an evaluation setting: `eval:*` always measures the gate itself.

## Ranking experiments

Questions were: does anything beat plain RRF? One small, explicit matrix (`eval/comparisons/ranking.json`), judged on the calibration split first, validation only reported.

| variant | calibration R@1 / R@5 / MRR | validation R@1 / R@5 / MRR |
| --- | --- | --- |
| A plain RRF | 0.70 / 1.00 / 0.85 | 0.78 / 0.94 / 0.86 |
| B lexical x1.5 | 0.70 / 0.96 / 0.83 | 0.78 / 0.94 / 0.86 |
| B lexical x2 | 0.70 / 0.96 / 0.84 | 0.78 / 0.94 / 0.86 |
| B semantic x1.5 | 0.70 / 1.00 / 0.85 | 0.78 / 0.94 / 0.86 |
| C exact-token bonus 0.5 | 0.73 / 1.00 / 0.88 | 0.91 / 0.94 / 0.94 |
| C exact-token bonus 1 | 0.73 / 1.00 / 0.88 | 0.97 / 1.00 / 1.00 |
| C exact-token bonus 2 | 0.73 / 1.00 / 0.88 | 0.97 / 1.00 / 1.00 |

- **Weighted RRF (B)** is not adopted: it lowered paraphrase R@5 (1.00 -> 0.91) and semantic-only MRR (0.42 -> 0.23) and fixed nothing. At k = 60 rank differences are tiny (1/61 vs 1/65), so a weight on one list cannot overturn a chunk found by both lists - a unit test documents this.
- **Exact-token bonus (C)** is adopted at **1** (`RETRIEVAL_EXACT_TOKEN_BONUS`): a chunk that contains an identifier / file name / version / quoted phrase of the question verbatim gets one extra vote worth `1/(k+1)`, as if a third "exact match" ranker had put it first. Calibration could not tell 0.5, 1 and 2 apart (all identical), so the value was chosen as the natural unit, not tuned. Calibration: R@1 0.70 -> 0.73, MRR 0.85 -> 0.88, exact-term MRR 0.88 -> 0.93, no tag regresses. Validation shows the gain is not limited to the original `E-4012` case (which sits in validation): the three blind exact-token questions added later (`BATCH_SIZE`, `DATABASE_URL`, `SUPPLIER_API_KEY`) also improve (exact-term R@1 0.67 -> 1.00 with bonus 1; bonus 0.5 fixes them but not `E-4012`).
- **Full dataset**: R@1 0.73 -> 0.82, R@3 0.91 -> 0.95, R@5 0.98 -> 1.00, MRR 0.85 -> 0.92; exact-term R@1 0.72 -> 0.89, error-code R@1 0.70 -> 0.90; paraphrase, semantic-only and multi-document unchanged. The answerability error rates do not depend on the ranking variant here.
- **D (rank-gap-aware)** was not tried: the bonus already removes the failure it was meant for, and any gap rule needs thresholds that would be fitted to a handful of cases.

Honesty note: the validation split contains `E-4012`, the case that motivated the bonus, and the choice of 1 over 0.5 was made after seeing the validation table. That is why six blind exact-token questions were added (three per split, written before they were run); they are the independent evidence.

### Exact-token detection

`extractTechnicalTokens` (`src/core/technical-tokens.ts`, pure, no model) is deliberately conservative. A word counts only by its *shape*: an underscore or path (`HTTP_429`, `user_id`, `config/settings.yaml`), a digit next to letters (`E-4012`, `ABC-123`), a version (`v2.14.1`), lowerCamelCase (`useEffect`), a known file extension, or an ALL-CAPS word of 5+ letters (`ECONNRESET`; shorter acronyms such as `API`, `HTTP`, `JSON` are too generic). Ordinary words, hyphenated words (`Wi-Fi`), plain numbers, `3rd`/`24h`, and PascalCase product names (`PostgreSQL`, `PurrFeed`) are not tokens; an all-caps question has no all-caps tokens. Matching is whole-token, case-insensitive: `E-4012` is not found in `E-40120`, and a file name also matches the document's own name. Features like "contains a quoted phrase" are used only as exact targets; no query classifier exists.

The `E-4012` case: it is lexical #1 but absent from the semantic ranking, so plain RRF scores it 1/61 (0.016) against about 0.031 for chunks that sit mid-table in both lists, and ranks it #6, outside the 5-chunk context. With the bonus it is #1 (validation R@1 for `error-code`: 0.67 -> 1.00).

## Live evaluation (costs money - never runs by itself)

`npm run eval:retrieval:live` is `eval:retrieval --live`. It **only prints a plan** and exits with an error unless you add `--confirm-spend`:

```bash
npm run eval:retrieval:live -- --dry-run                 # plan only, no key needed
npm run eval:retrieval:live -- --limit 12 --dry-run      # a smaller plan
npm run eval:retrieval:live -- --limit 12 --confirm-spend --json > live.json
```

The plan says how many texts will be embedded (distinct chunks + distinct questions) and in how many API requests, with a rough token estimate. Needs only `OPENAI_API_KEY` (no Telegram token); the index is in memory, so no stored document is read or changed; no secret is written to any output. Only embeddings are called, never a chat model. `--limit n` takes the first n questions of the dataset.

Run the **same dataset** offline and live, then compare metrics (not scores):

```bash
npm run eval:retrieval -- --json > offline.json
npm run eval:diff -- offline.json live.json
```

`eval:diff` compares Recall@K, MRR and the answerability metrics, warns when dataset version, query count, chunking or retrieval settings differ, and refuses to compare cosine scores. `npm run eval:confidence -- --live --confirm-spend` calibrates the gate for the real model.

## JSON export

`--json` prints one document (`exportVersion` 1): `embeddings`, `dataset` (version, counts, per split), `index` (profile + fingerprint), `configuration` (chunking, retrieval incl. defaults, confidence policy), `metrics`, `answerability`, `bySplit`, `byTag`, `signals`, and one entry per question (decision, reason, signals, ranks). No timestamps, so identical inputs give identical bytes. It contains the dataset's questions but never document text, expected-text fragments or credentials.

## Regression gate and benchmark

`eval/baseline.json` pins the shipped configuration (retrieval defaults, exact-token bonus and policy) and minimum metrics overall and per tag - `exact-term/recallAt1` guards the exact-token bonus, `semantic-only/recallAt5` the vector path, `answerabilityRecall` / `answerabilitySpecificity` the gate, `missing-identifier/answerabilitySpecificity` the identifier rule - with a tolerance of 0.02. Tests prove that a dead FTS path, a dead vector path, a starved context, a gate that lets everything through, a gate without the identifier rule and a disabled bonus each make it fail.

`npm run bench:retrieval` (deterministic generated data; one user, 1536 dimensions; median / p95 in ms):

| stage | 1,000 chunks | 5,000 chunks | 10,000 chunks |
| --- | --- | --- | --- |
| semantic scan | 13.1 / 15.0 | 66.7 / 189 | 287 / 337 |
| FTS, rare terms | 0.51 / 0.70 | 5.6 / 11.9 | 9.2 / 13.4 |
| FTS, common terms | 0.77 / 0.88 | 8.0 / 9.8 | 15.2 / 17.6 |
| RRF fusion | 0.01 | 0.03 | 0.02 |
| context selection | 0.20 / 0.22 | 1.6 / 1.8 | 3.1 / 4.2 |
| exact-token bonus | 0.11 / 0.13 | 0.20 / 0.38 | 0.19 / 0.36 |
| evidence signals + gate | 0.38 / 0.63 | 0.48 / 0.59 | 0.47 / 0.49 |

The new code costs under 1 ms per question - negligible next to the vector scan and orders of magnitude below an LLM call (the gate *saves* a generation whenever it abstains). The semantic scan numbers vary a lot between sessions on a development machine (the same unchanged commit measured 125-290 ms at 10,000 chunks on different runs); compare stages within one run. The scan is not optimized in this iteration.

## Known limits of the evaluation

- Small, synthetic, hand-written corpus; 17 unanswerable questions; thresholds are plateaus, not optima.
- The offline embedder is not OpenAI: similarity thresholds are not transferable. Use a live run.
- The gate is calibrated for English text (stop words, tokenization); other languages work for the semantic and exact-token rules but term coverage is weaker.
- Markdown sections and PDF pages are provenance for citations; they are not evaluated as retrieval features.
