# ai-knowledge-assistant-tg-bot

Telegram bot for personal document Q&A. Upload a PDF, Markdown or text file, then ask questions (typed or spoken) and get answers grounded in your own documents, with numbered sources.

Everything runs locally except the OpenAI calls: files live on disk, metadata, vectors and the full-text index live in one SQLite file.

## Features

- Upload `PDF`, `MD`, `TXT` (size-limited, configurable)
- **Hybrid retrieval**: semantic vector search *and* SQLite FTS5 keyword search, fused with reciprocal rank fusion - finds paraphrases *and* exact identifiers, file names and error strings
- Numbered sources that match the `[n]` citations in the answer; **PDF sources show real page numbers** (`p. 8`, `pp. 12–13`)
- Deterministic check of the `[n]` references in every answer (references to sources that do not exist are removed)
- Voice questions (OpenAI transcription)
- Map-reduce summaries for long documents (chunk overlap is not summarized twice), cached after the first run
- Strict per-user isolation: every query is scoped by the Telegram user id
- Per-user storage limits and a per-user rate limit for operations that cost money
- **Index profile**: every document records the recipe it was indexed with (embedding model, chunking, extraction); `npm run reindex` shows what is stale and why, re-embeds, or re-chunks from the original file - atomically
- **Offline retrieval evaluation**: Recall@K / HitRate@K / MRR on a versioned dataset, configuration comparison, a regression gate and a benchmark - no OpenAI key needed

## Commands

| Command | Description |
| --- | --- |
| `/start`, `/help` | Introduction and command list |
| `/list` | Your indexed documents (with their ids) |
| `/ask <question>` | Ask about your documents. Plain text works too |
| `/summary <documentId>` | Short summary of a document |
| `/delete <documentId>` | Delete a document, its vectors and its file |

Sending a file uploads it; sending a voice message asks a question.

## Architecture

Dependencies point inwards: the application layer only knows ports (interfaces), never SQLite, OpenAI, the filesystem or Telegram. `src/composition-root.ts` is the single place where concrete adapters are created and injected. `test/architecture.test.ts` enforces the import rules.

```mermaid
flowchart LR
  subgraph telegram [telegram/ - delivery]
    H[handlers + middleware]
  end
  subgraph application [application/]
    UC[use cases + HybridRetriever]
    P{{ports}}
  end
  subgraph core [core/ - pure logic]
    C[types, splitter, pages, index profile, vector math, rank fusion, context selection, citations]
  end
  subgraph infra [infrastructure/ - adapters]
    SQ[(SQLite: repository, vector store, FTS5)]
    FS[local file storage]
    OA[OpenAI chat / embeddings / speech-to-text]
    PDF[PDF / text extractor]
  end
  subgraph tooling [eval/ + cli/ - tooling, never loaded by the bot]
    EV[evaluation, benchmark, reindex CLI]
  end
  H --> UC
  UC --> P
  UC --> C
  SQ -. implements .-> P
  FS -. implements .-> P
  OA -. implements .-> P
  PDF -. implements .-> P
  CR[composition-root.ts] --> H
  CR --> UC
  CR --> infra
  EV --> UC
  EV --> infra
```

```text
src/
  index.ts              entry point of the bot: load config, build the app, run it
  composition-root.ts   creates adapters once and injects them (bot + the reindex tool)
  lifecycle.ts          start polling, graceful shutdown (SIGINT/SIGTERM)
  cli/                  command-line tools: reindex, eval-retrieval, bench-retrieval (argument parsing, output, entry scripts)
  config/               environment parsing in independent sections (zod); each command loads only what it needs
  core/                 pure logic, no I/O: types, text splitter (with offsets), page provenance, index profile,
                        cosine similarity + vector codec, rank fusion (RRF), context selection, chunk-overlap
                        trimming, FTS query builder, citation checks
  application/
    hybrid-retriever.ts query embedding -> semantic + lexical search -> RRF -> context selection
    prepare-index.ts    extract -> split -> embed (shared by ingestion and re-chunking)
    assess-index.ts     compares a document's recorded recipe with the configured one
    ports/              DocumentRepository, VectorStore, IndexMaintenance, FileStorage, ChatModel,
                        EmbeddingsProvider, SpeechToText, DocumentTextExtractor
    prompts/            chat messages (system / user roles) for answering and summarizing
    use-cases/          ingest, answer, list, summarize, delete, reindex (re-embed), rechunk, run-reindex
    check-index-compatibility.ts   startup diagnostic for stale indexes
  infrastructure/
    sqlite/             connection, migrations, repository, vector store (vectors + FTS5), index maintenance
    storage/            local file storage
    openai/             chat model, embeddings, speech-to-text adapters
    documents/          PDF (per page) / MD / TXT text extraction
  eval/                 evaluation: metrics, dataset, harness, runner, comparison, baseline, report, benchmark
  telegram/             bot factory, routing, handlers, middleware (errors, rate limit), downloads, UI text
  shared/               logger, errors, rate limiter, keyed mutex, small utilities
eval/                   fixture corpus, questions (JSONL), comparison grid, baseline minimums, offline embedding lexicon
test/                   Vitest suites using fakes for the ports and in-memory SQLite
```

### Request flow

1. Telegraf receives an update; `requestLogger` and `errorBoundary` middleware wrap every handler.
2. Handlers that call OpenAI (`/ask`, plain text, `/summary`, uploads, voice) first pass the per-user rate limit.
3. A handler reads Telegram specifics (user id, command arguments, file ids), calls one use case, and formats the result as plain text, split into several messages if it exceeds Telegram's limit.
4. `errorBoundary` replies with the message of an `AppError` (written for users) or a generic message for anything unexpected. Technical details are logged, never sent.

### Ingestion flow

```mermaid
flowchart TD
  L[per-user lock] --> Q[quota check: documents, stored bytes]
  Q --> A[validate: type, non-empty, size]
  A --> B[extract text - PDF: per page]
  B --> C[normalize + split into chunks, remember each chunk's pages]
  C --> K[chunk count limit]
  K --> D[embed chunks]
  D --> E[validate vectors: count, dimension, finite]
  E --> F[save original file]
  F --> G[(SQLite transaction: document + index profile + chunks + FTS index)]
  G -- fails --> H[delete the saved file]
```

Everything that can fail without side effects happens first, and limits are checked before any paid embedding call. The file is only written after embeddings succeeded, document and chunks are saved atomically (the full-text index is updated by triggers inside the same transaction), and the file is removed again if that last step fails. A failed upload therefore leaves no orphan file, no document without chunks and no chunks without a document. Uploads of one user run one after another so two simultaneous uploads cannot both slip under a quota.

### RAG pipeline

```mermaid
flowchart TD
  Q[User question] --> E[Query embedding]
  E --> S[Semantic search<br/>cosine over float32 vectors]
  Q --> F[FTS5 search<br/>BM25 over chunk text]
  S --> R[Reciprocal Rank Fusion]
  F --> R
  R --> L[Load text of the top candidates]
  L --> D[Diversification<br/>dedupe, overlap, per-document cap]
  D --> B[Context budget]
  B --> M[LLM]
  M --> G[Check the cited numbers]
  G --> A[Answer + numbered sources]
```

1. **Embed** the question (validated: finite, non-empty).
2. **Semantic search** compares it with the user's chunks embedded by the *same model and dimension* (cosine, `MIN_SIMILARITY_SCORE`, best `RETRIEVAL_SEMANTIC_LIMIT`). Ranking reads only ids and vectors, no chunk text.
3. **Lexical search** runs the question through FTS5 (best `RETRIEVAL_LEXICAL_LIMIT` by BM25). See "Lexical queries" below.
4. **Fuse** the two ranked lists with Reciprocal Rank Fusion (below).
5. **Load** the text of only the best `3 x RETRIEVAL_TOP_K` fused candidates.
6. **Select context** (deterministic): drop exact duplicates (e.g. the same file uploaded twice) and neighbouring chunks that mostly repeat an already selected one, cap chunks per document (soft: free slots are backfilled), stop at `RETRIEVAL_TOP_K` chunks and `RETRIEVAL_CONTEXT_MAX_CHARS` characters (the best chunk is truncated if it alone is larger).
7. If nothing is relevant the bot says so without calling the chat model.
8. Otherwise the chat model receives three messages: a **system** message with the rules (answer only from the excerpts, treat them as untrusted data, ignore instructions found inside them, cite `[n]`, say when evidence is insufficient), a **user** message with the numbered excerpts, and a **user** message with the question.
9. **Grounding check** (no second LLM call): every `[n]` in the answer must be one of the excerpts the model was shown; references to anything else (`[99]`) are removed from the text and logged. Code such as `arr[5]` and years such as `[2024]` are left alone. This proves the numbers are valid, *not* that the cited source supports the sentence.
10. The use case returns `{ answer, sources: [{ documentId, fileName, chunkIndex, pageStart?, pageEnd?, rank, score }], citations }`. Telegram shows:

```text
Sources:
[1] architecture.pdf · p. 8
[2] deployment.pdf · pp. 12–13
[3] notes.md · chunk 4
```

The numbers match the `[n]` in the answer and the excerpt numbers the model saw - they are assigned after de-duplication and diversification, from the same list. PDF chunks show the real page range they were cut from; text documents, and PDFs indexed before pages were tracked, show the chunk position.

#### Reciprocal Rank Fusion

Cosine similarity (about 0.2-1) and BM25 (an unbounded, corpus-dependent number) cannot be added meaningfully, so only the *rank* inside each list is used:

```text
score(chunk) = 1 / (k + semanticRank) + 1 / (k + lexicalRank)      k = RETRIEVAL_RRF_K (default 60); a missing list contributes 0
```

A chunk found by both methods outranks one found by a single method; a chunk found by just one still participates. Duplicates are merged by chunk id; ties are broken deterministically. The implementation is a pure function (`src/core/rank-fusion.ts`). Each result keeps `semanticRank`, `lexicalRank`, the fused score and rank for debugging (see `RAG_DEBUG`).

#### Lexical queries

The question is turned into a safe FTS5 `MATCH` expression (`src/core/lexical-query.ts`): terms are extracted, de-duplicated, double-quoted (user input can never be parsed as FTS operators) and OR-ed, so BM25 ranks by how many *rare* terms a chunk contains.

- Technical identifiers are never rewritten: `ECONNRESET`, `useEffect`, `foo.bar`, `HTTP_429`, `user_id`, `v2.14.1`, `src/app/main.ts`, `gpt-4.1-mini` are each one phrase. The FTS tokenizer (`unicode61`, `remove_diacritics 2`) lower-cases and splits at punctuation, so they match the token sequences they were indexed as (`HTTP_429` = `http 429`).
- Unicode: input is NFC-normalized, combining marks stay attached to their letters, accents are folded by the tokenizer (`cafe` finds `Café`), non-Latin scripts work. Scripts without spaces (Chinese, Japanese) are one token per run - a known limitation of `unicode61`.
- Possessives (`cat's`) lose the `'s`; a short English stop-word list is applied and can be replaced per call (`stopWords` option) for other languages. There is no stemming and no synonym expansion.
- Tried and rejected: also searching the spelled-out form of camelCase names (`useEffect` -> `use Effect`). A two-word phrase out-scores the one verbatim token in BM25, so paraphrases ranked above the exact identifier. FTS5 has no per-term weights to correct that.

### Summaries

Documents up to ~12k characters are summarized in one call. Longer ones are map-reduced: consecutive chunks are grouped (~8k characters), each group is summarized, and the partial summaries are summarized again (bounded number of rounds). Before that, the overlap the splitter repeated between neighbouring chunks (`CHUNK_OVERLAP`) is trimmed using chunk indices, so text is not summarized twice; repeated passages elsewhere in a document are left alone. The result is cached on the document (re-chunking keeps it), and simultaneous `/summary` requests for one document share a single computation.

### Storage design

- Files: `<DATA_DIR>/files/<uuid>-<sanitized name>`
- Database: `<DATA_DIR>/app.db` (SQLite, WAL mode, foreign keys on)

| Table | Purpose |
| --- | --- |
| `documents` | One row per upload: owner, names, sizes, cached summary, `index_profile` (JSON) and `index_fingerprint` |
| `document_chunks` | Chunk text, embedding (float32 BLOB), `embedding_model`, `embedding_dim`, optional `page_start` / `page_end`; stable integer key `seq`; `UNIQUE (document_id, chunk_index)`; `ON DELETE CASCADE` from `documents` |
| `chunk_fts` | FTS5 external-content index over `document_chunks.content` (`unicode61`, diacritics folded), kept in sync by insert/update/delete triggers - so ingestion, deletion, re-chunking and cascades update it in the same transaction |

Indexes follow the queries: `documents(user_id, created_at DESC)` for `/list`, `document_chunks(user_id, embedding_model)` for vector search; per-document access uses the unique index.

**Migrations** use `PRAGMA user_version` (`src/infrastructure/sqlite/migrations.ts`). Each runs in its own transaction; a database written by a newer version is refused.

| Version | Change |
| --- | --- |
| 1 | baseline schema |
| 2 | track `embedding_model` / `embedding_dim`, unique chunk positions, query-shaped indexes |
| 3 | embeddings stored as float32 **BLOB** instead of JSON text; chunks get a stable integer `seq` key. Unreadable JSON vectors keep their row (the text stays searchable) with dimension 0 |
| 4 | `chunk_fts` FTS5 index + sync triggers; existing chunks are indexed during the migration |
| 5 | `documents.index_profile` / `index_fingerprint`, `document_chunks.page_start` / `page_end`. Columns only, **no data is rewritten**: existing documents have no recorded recipe and are described honestly (see below) |

Existing databases upgrade automatically on the next start. The FTS5 migration needs FTS5; it is included in the SQLite build shipped with `better-sqlite3`, and a build without it fails the migration with a clear message.

**Vector BLOB format** (`src/core/vectors.ts`): the IEEE-754 binary32 value of every dimension, 4 bytes each, **little-endian**, no header; the dimension is stored in `embedding_dim`. Encoding and decoding are explicit, not whatever the host's typed arrays do, and values that do not fit float32 (a finite double above ~3.4e38 would silently become `Infinity`) are rejected like `NaN`/`Infinity`. Earlier versions wrote the host's native order, which on every supported platform (x86, ARM: little-endian) is byte-for-byte the same, so existing databases need no conversion. Little-endian hosts decode by reinterpreting the bytes (fast path); other hosts use the portable reader.

**Why BLOB vectors:** measured on 5000 chunks x 1536 dimensions, scanning JSON vectors together with the chunk text took ~264 ms per query in a micro-benchmark; reading only float32 blobs takes ~46 ms for the scan alone and ~66-75 ms for the whole `searchSimilar` call, and vectors are ~5x smaller on disk. The scan is still brute force over the user's chunks - fine for thousands of chunks, and the `VectorStore` port is the seam for an ANN index later.

### Index profile, re-embedding and re-chunking

```text
Original file
     |
 extraction  (PDF: text per page)          extractor version
     |
 chunking config  (CHUNK_SIZE, CHUNK_OVERLAP)   chunking algorithm version
     |
     + embedding model + dimension
     |
 Index Profile  ->  fingerprint (12 hex chars)
     |
 chunks + embeddings + page provenance + FTS index
     |
 Hybrid Retrieval  (top-k, RRF k, candidate limits, min score, context budget: NOT part of the profile)
     |
 Evaluation dataset
     |
 Recall / MRR / regression gate
```

Every document stores the **recipe it was indexed with** (`src/core/index-profile.ts`):

| Field | Changes when |
| --- | --- |
| `embeddingModel`, `embeddingDimension` | `OPENAI_EMBEDDINGS_MODEL` changes |
| `chunkSize`, `chunkOverlap` | `CHUNK_SIZE` / `CHUNK_OVERLAP` change |
| `chunkingVersion` | `splitText` behaves differently (a constant in the code; bump it with the change) |
| `extractorVersion` | extraction output changes - per file type, so a PDF change never touches text documents |

Query-time settings (`RETRIEVAL_*`, `MIN_SIMILARITY_SCORE`) are deliberately **not** part of it: they can change at any time without making stored data stale.

**Stale-index rules.** A document is stale when a recorded field differs from the active one, and the difference says *which kind*:

| Kind | Meaning | Effect on search | Fixed by |
| --- | --- | --- | --- |
| embedding | other model / dimension, or unreadable vectors | skipped by semantic search (still found by keywords); never compared with the wrong vectors | `npm run reindex` (re-embed) |
| chunking | other chunk size, overlap or algorithm version | none - old chunks are valid, just laid out differently | `npm run reindex -- --rechunk` |
| extractor | extraction changed (e.g. PDFs without page numbers) | none | `npm run reindex -- --rechunk` |

Documents indexed before profiles existed have *unknown* chunk size/overlap. Unknown is never reported as a change - they are counted separately ("unrecorded chunk layout"), and a legacy PDF is extractor-stale because it has no page provenance. The bot logs one warning at startup with the counts and the commands; it never re-indexes by itself.

**Re-embed vs re-chunk**

| | re-embed (default) | re-chunk (`--rechunk`) |
| --- | --- | --- |
| Reads | stored chunk text | the original file |
| Chunk text, ids, positions | unchanged | rebuilt (new ids) |
| Needs | `OPENAI_API_KEY` | `OPENAI_API_KEY` and the original file |
| Use when | embedding model changed | `CHUNK_SIZE`/`CHUNK_OVERLAP` changed, chunking algorithm changed, PDFs need page numbers |

Re-chunking pipeline: read the stored file -> extract -> split with the current config -> embed -> validate -> **one SQLite transaction** that replaces all chunks, the recorded profile and the text length (the FTS index follows through its triggers). Nothing existing is deleted before the replacement is ready; a failure while reading, extracting, embedding or inside the transaction leaves the previous chunks, vectors, profile and file untouched (each of those failures is covered by a test). The file, the document row, its owner and its cached summary are never modified.

```bash
npm run reindex -- --dry-run              # why is each document stale, and what would be done? No OpenAI calls, no API key
npm run reindex                           # re-embed documents with outdated embeddings
npm run reindex -- --rechunk              # also rebuild chunk-layout / extraction-stale documents from their files
npm run reindex -- --all --rechunk        # rebuild everything
npm run reindex -- --document <id> [--rechunk]
node dist/cli/reindex.js --all            # same, from the compiled build
```

Illustrative output (ids shortened):

```text
$ npm run reindex -- --rechunk --dry-run
notes.pdf (3f2a…)
  embedding model:
    text-embedding-3-small -> text-embedding-3-large
  -> would re-embed

architecture.pdf (9c1e…)
  chunk size:
    1200 -> 900
  chunking version:
    v1 -> v2
  -> would re-chunk

Summary:
12 documents checked
1 stale embedding
1 stale chunk layout
0 extraction-version changes

Dry run: 2 documents (41 chunks) would be re-indexed with text-embedding-3-large.
```

Documents are processed one at a time with progress output; one failure is recorded and the run continues; the exit code is non-zero if any document failed, and a rerun picks up exactly what is still stale.

### Evaluating retrieval

Retrieval changes should be judged by numbers, not intuition. The evaluation runs the **real** pipeline - production ingestion into an in-memory SQLite database (so the real chunking and FTS triggers), the real FTS query, vector scan, RRF, de-duplication, caps and context budget - and scores what the model would be given.

```bash
npm run eval:retrieval                    # report for the configured settings
npm run eval:retrieval -- --verbose       # + the retrieved chunks of every question
npm run eval:retrieval -- --json          # machine-readable
npm run eval:retrieval -- --rrf-k 30 --lexical-limit 30 --chunk-size 700    # try one configuration
npm run eval:retrieval -- --compare eval/comparisons/default.json           # side-by-side grid
npm run test:retrieval                    # regression gate against eval/baseline.json (exit 1 on regression)
npm run eval:retrieval:live               # same, with the real OpenAI embedding model (needs OPENAI_API_KEY)
npm run bench:retrieval                   # timings of each stage on generated data
```

It needs **no** Telegram token and, by default, **no** OpenAI key: embeddings come from a deterministic offline embedder (`eval-lexicon-v1`: one dimension per synonym group in `eval/embedding-lexicon.json`, plus a small hashed bag-of-words). Runs are reproducible byte for byte (document ids are injected so ranking ties cannot differ between runs). **The offline numbers validate the pipeline and catch regressions; they do not predict OpenAI embedding quality** - use `eval:retrieval:live` (and your own documents) for that. Nothing in the evaluation changes your configuration or database.

**Dataset** (`eval/datasets/retrieval.jsonl`, one JSON object per line, ~30 questions; corpus in `eval/corpus/<user>/<file>`):

```json
{"id":"error-cat-feed-econnreset","user":"alice","question":"Why does the cat feed ingestion fail with ECONNRESET?",
 "expectedSources":[{"document":"ops.md","contains":"ECONNRESET means the supplier broker closed the connection"}],
 "expectedTerms":["ECONNRESET","idle timeout"],"tags":["exact-term","error-code"]}
```

Ground truth is the **owner + file name + a text fragment** the right chunk contains; `chunkHint` is only a hint (used alone as the last resort), so changing `CHUNK_SIZE` cannot silently invalidate the dataset - a test checks that every fragment is still inside some chunk at chunk sizes 500-1500. Scenarios: paraphrases (including questions that share no word with the answer: `semantic-only`), exact identifiers, error codes, file/reference lookups, information split across chunks, ambiguous terms, several relevant documents, questions the corpus cannot answer, and two users owning identical text (cross-user leaks are counted and fail the check).

**Metrics** (`src/eval/metrics.ts`, pure functions; binary relevance, so no nDCG):

| Metric | Meaning |
| --- | --- |
| Recall@K | share of a question's expected sources found in the first K context chunks, averaged over answerable questions |
| HitRate@K | share of questions with at least one expected source in the first K |
| MRR | mean of 1 / rank of the first relevant chunk |
| before selection | the same on the ranked candidates *before* de-duplication/caps/budget: the gap shows what diversification costs |
| term coverage | share of `expectedTerms` present in the context text |
| no-answer | how many unanswerable questions still returned context (an LLM has to abstain then) |

Per question the report shows the expected source, hit/miss, reciprocal rank, and the semantic / lexical / RRF rank of the first relevant chunk (or where it ranked when it did not reach the context), plus per-tag results.

**Regression gate.** `eval/baseline.json` pins a configuration and minimum metrics - overall and per tag (`exact-term/recallAt5` needs the keyword path, `semantic-only/recallAt5` the vector path) - with a small tolerance (0.02) below the minimum. `npm run test:retrieval` fails when quality falls materially below it or when any chunk of another user is retrieved; the same check runs in `npm test`, together with tests proving that a dead FTS path, a dead vector path and a starved context each make it fail. The baseline also has to equal the shipped defaults, so changing a default means touching the baseline in the same PR. Improvements never fail: raise the minimums deliberately.

**Comparing configurations** is a plain side-by-side runner (`eval/comparisons/default.json` lists vector-only, keyword-only, several `RRF k`, candidate limits, top-k, similarity thresholds, context budgets and chunk sizes; settings not listed come from the environment). It prints the change against the first entry and never picks or applies anything. The corpus is re-indexed only when chunking differs.

**Benchmark** (`npm run bench:retrieval -- --sizes 1000,5000,10000 --dim 1536 --users 1 --explain`): deterministic generated text (Zipf-distributed words) and vectors; per stage the median / p95 over 20 runs. A benchmark, not a test - it never fails because a machine is slow. Example, one user, 1536 dimensions (Windows laptop, Node 24; yours will differ):

| stage (ms, median / p95) | 1,000 chunks | 5,000 chunks | 10,000 chunks |
| --- | --- | --- | --- |
| semantic scan | 14.6 / 18.6 | 65.7 / 70.0 | 125 / 131 |
| FTS, rare terms | 0.55 / 0.76 | 2.50 / 3.27 | 6.22 / 8.44 |
| FTS, common terms | 0.79 / 0.89 | 3.65 / 4.25 | 8.58 / 10.7 |
| RRF fusion | 0.01 | 0.01 | 0.01 |
| context selection (load + select) | 0.19 / 0.21 | 0.79 / 0.87 | 2.04 / 2.79 |

**FTS and other users' data.** The lexical query is `chunk_fts CROSS JOIN document_chunks ... WHERE chunk_fts MATCH ? AND user_id = ?`: `EXPLAIN QUERY PLAN` shows the FTS index drives (`SCAN chunk_fts VIRTUAL TABLE INDEX 0:M1`), then one primary-key lookup per match (`SEARCH c USING INTEGER PRIMARY KEY`), and `user_id` is filtered *after* matching - so a common term pays for every user's matches. Measured with 10 users sharing the tables (`--users 10 --dim 64`): for a user with 5,000 chunks, FTS on common terms takes 18.8 ms at 50,000 total chunks versus 3.7 ms when that user is alone, 6.5 ms at 20,000 total. Real, but small next to the vector scan (66 ms for the same 5,000 chunks at 1536 dimensions), so the schema is **left alone**: no per-user FTS tables, no denormalization. Revisit if a deployment holds hundreds of thousands of chunks across many users.

### Limits and safeguards

| Safeguard | Default | Behaviour |
| --- | --- | --- |
| `MAX_DOCUMENTS_PER_USER` | 100 | Upload rejected with a clear message; checked before any extraction or embedding |
| `MAX_STORAGE_BYTES_PER_USER` | 200 MB | Sum of a user's original file sizes plus the new file |
| `MAX_CHUNKS_PER_DOCUMENT` | 2000 | Checked after splitting, before paying for embeddings (bounds embedding cost per file); also applies when re-chunking |
| `RATE_LIMIT_REQUESTS` per `RATE_LIMIT_WINDOW_MS` | 10 per 60 s | Sliding window per Telegram user, in memory, for questions, summaries, uploads and voice messages (a voice question counts once). Over the limit the user gets "try again in N seconds"; `/list`, `/delete` and `/help` are free |

**The rate limiter is in memory and per process, on purpose.** It resets when the bot restarts (every user gets a fresh allowance) and is not shared between instances; that fits the single-process, long-polling bot and avoids another moving part (no Redis). It sits behind a small boundary: `src/shared/rate-limiter.ts` knows nothing about Telegram and takes an injectable clock (tests never wait), and handlers reach it only through the middleware in `src/telegram/rate-limit.ts`. A shared store would only have to provide the same `check` method. Idle users are forgotten, so memory stays bounded.

Concurrency: ingestion of one user is serialized (so quotas cannot be raced), and summaries are computed once per document at a time. Everything else relies on SQLite transactions: a search never sees a half-ingested document, a document deleted during a request is simply dropped from the result, and re-indexing swaps vectors and chunks atomically.

### Observability

Every question logs one concise structured line: selected chunk count, stage timings (question embedding, semantic search, lexical search, rank fusion, context preparation, LLM generation) and total duration. Logs never contain document text, embeddings, keys or tokens. If the model cites sources that were not in the context, one warning lists the removed reference numbers (numbers only).

With `RAG_DEBUG=true` each question additionally logs a `RAG retrieval debug` entry: candidate counts per stage, selected chunk ids / document ids / chunk positions with `semanticRank`, `lexicalRank`, fused rank and score, why candidates were skipped (`duplicate`, `overlap`, `document-cap`, `budget`) and the context size in characters. Still ids and numbers only. Meant for development; it is off by default.

## Configuration

Copy `.env.example` to `.env`. Configuration is parsed in independent sections (`src/config/config.ts`), and **each command validates only what it uses**:

| Command | Needs |
| --- | --- |
| `npm start` / `npm run dev` (the bot) | everything: `TELEGRAM_BOT_TOKEN`, `OPENAI_API_KEY`, ... |
| `npm run reindex -- --dry-run` | nothing secret (storage, model name, chunking) |
| `npm run reindex` (real run) | `OPENAI_API_KEY` |
| `npm run eval:retrieval`, `npm run test:retrieval`, `npm run bench:retrieval` | nothing secret |
| `npm run eval:retrieval:live` | `OPENAI_API_KEY` |

| Variable | Default | Description |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | required by the bot | Bot token from @BotFather |
| `OPENAI_API_KEY` | required by the bot and by anything that calls OpenAI | OpenAI API key |
| `OPENAI_CHAT_MODEL` | `gpt-4.1-mini` | Answers and summaries |
| `OPENAI_EMBEDDINGS_MODEL` | `text-embedding-3-small` | Chunk and query vectors (part of the index profile: run `npm run reindex` after changing) |
| `OPENAI_TRANSCRIBE_MODEL` | `whisper-1` | Voice transcription |
| `DATA_DIR` | `data` | Where `app.db` and `files/` live |
| `MAX_UPLOAD_BYTES` | `10485760` | Upload size limit (Telegram bots can download at most 20 MB) |
| `CHUNK_SIZE` / `CHUNK_OVERLAP` | `1000` / `150` | Chunking in characters (part of the index profile: `npm run reindex -- --rechunk` applies a change to existing documents) |
| `RETRIEVAL_TOP_K` | `5` | Maximum chunks passed to the model |
| `MIN_SIMILARITY_SCORE` | `0.2` | Minimum cosine similarity for a semantic candidate |
| `RETRIEVAL_SEMANTIC_LIMIT` / `RETRIEVAL_LEXICAL_LIMIT` | `20` / `20` | Depth of the two candidate lists that are fused |
| `RETRIEVAL_RRF_K` | `60` | Constant of reciprocal rank fusion |
| `RETRIEVAL_CONTEXT_MAX_CHARS` | `6000` | Approximate budget for the chunk text sent to the model |
| `MAX_DOCUMENTS_PER_USER` | `100` | Documents per user |
| `MAX_STORAGE_BYTES_PER_USER` | `209715200` | Stored original file bytes per user |
| `MAX_CHUNKS_PER_DOCUMENT` | `2000` | Chunks a single document may produce |
| `RATE_LIMIT_REQUESTS` / `RATE_LIMIT_WINDOW_MS` | `10` / `60000` | Expensive operations allowed per user per window |
| `REQUEST_TIMEOUT_MS` | `60000` | Timeout for OpenAI calls and Telegram file downloads |
| `HANDLER_TIMEOUT_MS` | `300000` | Telegraf handler timeout (indexing a big PDF is slow) |
| `LOG_LEVEL` | `info` | pino log level |
| `LOG_QUESTIONS` | `false` | Also log question text (development only) |
| `RAG_DEBUG` | `false` | Log retrieval details: ids, ranks, counts, timings (development only) |

Logs are structured JSON (pino). They contain ids, sizes and durations; never document text, embeddings, API keys or bot tokens (secret-looking strings are scrubbed from logged errors).

## Development

Requires Node.js 20+.

```bash
npm install
npm run dev               # tsx watch
npm run typecheck         # tsc --noEmit (src + tests)
npm test                  # vitest run (includes the retrieval regression check)
npm run build             # compile to dist/
npm start                 # run the compiled app: node dist/index.js
npm run reindex           # bring documents in line with the index recipe (see "Index profile")
npm run eval:retrieval    # offline retrieval evaluation (see "Evaluating retrieval")
npm run test:retrieval    # retrieval quality gate
npm run bench:retrieval   # retrieval timings
```

`npm start` runs compiled JavaScript, so run `npm run build` first.

### Tests

`npm test` runs Vitest without any network access. Application tests use fakes for the ports (embeddings, chat model, file storage, extractor) together with a real in-memory SQLite database. Covered: text splitting (including offsets), page provenance, cosine similarity and the explicit little-endian vector codec, rank fusion, context selection, overlap trimming, the FTS query builder and FTS search (technical identifiers, Unicode, user isolation, deletion, stale embeddings), hybrid retrieval, ingestion success/rollback/limits/concurrency, index profiles and every kind of staleness, re-embedding and re-chunking (including that each kind of failure preserves the previous index), dry runs without provider calls, citation formatting and grounding, the evaluation metrics, dataset, runner, comparison and regression gate, the architecture's import rules, rate limiting with an injected clock, migrations from every released schema, OpenAI adapters (fake `fetch`), Telegram helpers and graceful shutdown. The real OpenAI and Telegram APIs are never called by the automated tests.

## Known limitations

- Semantic search is a brute-force scan of the user's vectors (~66 ms at 5000 chunks x 1536 dimensions, ~125 ms at 10,000): fine for thousands of chunks, not for millions. Lexical search uses an FTS index but filters by user after matching (see the measurement above).
- Keyword matching is token based (no stemming, no synonyms, no segmentation of Chinese/Japanese); the semantic side covers paraphrases.
- Hybrid retrieval always brings *something* when any question word matches (OR semantics): in the evaluation every unanswerable question still returned context, so the chat model - not retrieval - decides to abstain.
- RRF weighs both lists equally by rank only: a chunk that is the clear #1 for a rare exact term can be outranked by chunks that are mid-table in both lists (in the evaluation dataset the `error-feeder-e4012` question shows it: `E-4012` is the lexical #1 but is outranked).
- Scanned PDFs without a text layer are rejected (no OCR). Page numbers are the pages as counted by the PDF (not printed page labels). Markdown sections are not tracked, only chunk positions.
- The rate limit is per process and resets on restart; single process only (SQLite file, long polling).
- The offline evaluation's embedder is synthetic; its numbers are for regression detection, not an estimate of production quality.
