# ai-knowledge-assistant-tg-bot

Telegram bot for personal document Q&A. Upload a PDF, Markdown or text file, then ask questions (typed or spoken) and get answers grounded in your own documents, with numbered sources - or an honest "I couldn't find enough information" when the documents do not hold the answer.

Everything runs locally except the OpenAI calls: files live on disk; metadata, vectors and the full-text index live in one SQLite file.

## What it does

- **Hybrid retrieval**: semantic vector search *and* SQLite FTS5 keyword search, fused with reciprocal rank fusion; chunks that contain an exact identifier from the question (`E-4012`, `ECONNRESET`, `v2.14.1`) get extra evidence.
- **Answers only with evidence**: a deterministic confidence gate runs *before* the chat model. In `enforce` mode weak or unrelated context, or an identifier that exists nowhere in your documents, gets a short refusal and no generation cost. The default is `shadow`: the decision is logged but answers are unchanged, until the threshold has been checked against real embeddings.
- **Document lifecycle**: identical uploads are recognised (per user, by content hash) and cost nothing; `/replace` swaps a document's content without ever leaving it half-indexed; `npm run integrity` and `npm run backup` check and protect the stored data.
- **Citations you can follow**: numbered sources match the `[n]` in the answer and show the best location known - PDF pages (`pp. 8–9`), Markdown sections (`Authentication > Refresh tokens`) or the chunk number. References to sources that do not exist are removed.
- Voice questions, map-reduce summaries, strict per-user isolation, per-user storage and rate limits.
- **Index profile**: every document records how it was indexed; `npm run reindex` shows what is stale and why, re-embeds or re-chunks atomically.
- **Offline evaluation**: Recall@K / MRR, an answerability confusion matrix, a calibration/validation split, ranking experiments and a regression gate - no OpenAI key needed.

```text
Q: What does ECONNREFUSED mean?       (not in any document; with RETRIEVAL_CONFIDENCE_MODE=enforce)
-> I couldn't find enough information in your uploaded documents to answer that.   [chat model not called]

Q: Why do connections fail with ECONNRESET?
-> ECONNRESET means the supplier broker closed the connection ... [1]
   Sources:
   [1] operations.md · Feed Ingestion Operations Runbook > Common errors > ECONNRESET
```

A full walk-through with real pipeline output: [docs/rag.md](docs/rag.md#worked-example).

## Quick start

Requires Node.js 20+.

```bash
npm install
cp .env.example .env      # set TELEGRAM_BOT_TOKEN and OPENAI_API_KEY
npm run dev               # or: npm run build && npm start
```

## Commands

| Command | Description |
| --- | --- |
| `/start`, `/help` | Introduction and command list |
| `/list` | Your documents with id, size, date and state (`ready`, `index outdated`, ...) |
| `/doc <documentId>` | Details of one document |
| `/ask <question>` | Ask about your documents. Plain text works too |
| `/summary <documentId>` | Short summary of a document |
| `/delete <documentId>` | Delete a document, its vectors and its file |
| `/replace <documentId>` | How to replace a document: send the new file with the caption `/replace <documentId>` |

Sending a file uploads it - the same file again is recognised ("already in your knowledge base") and costs nothing; the same name with different content is a second document, replaced only on purpose with `/replace`. Sending a voice message asks a question.

## Architecture in one picture

```text
telegram/ (handlers)  ->  application/ (use cases, HybridRetriever, ports)  ->  core/ (pure logic)
                                      ^
infrastructure/ (SQLite, OpenAI, files, PDF) implements the ports; composition-root.ts wires everything
```

Dependencies point inwards and `test/architecture.test.ts` enforces it. Details, storage schema, migrations, re-indexing and limits: [docs/architecture.md](docs/architecture.md). The RAG pipeline, the confidence gate, exact tokens and provenance: [docs/rag.md](docs/rag.md).

## Configuration

Copy `.env.example`; each command validates only the settings it uses (the evaluation commands need no secrets).

| Variable | Default | Description |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN`, `OPENAI_API_KEY` | required by the bot | Credentials |
| `OPENAI_CHAT_MODEL` / `OPENAI_EMBEDDINGS_MODEL` | `gpt-4.1-mini` / `text-embedding-3-small` | Models (changing the embeddings model: run `npm run reindex`, re-check the gate) |
| `DATA_DIR` | `data` | `app.db` and `files/` |
| `CHUNK_SIZE` / `CHUNK_OVERLAP` | `1000` / `150` | Chunking (part of the index profile) |
| `RETRIEVAL_TOP_K` | `5` | Chunks passed to the model |
| `RETRIEVAL_SEMANTIC_LIMIT` / `RETRIEVAL_LEXICAL_LIMIT` / `RETRIEVAL_RRF_K` | `20` / `20` / `60` | Candidate depth and the RRF constant |
| `RETRIEVAL_EXACT_TOKEN_BONUS` | `1` | Extra rank evidence for verbatim identifiers; `0` turns it off |
| `RETRIEVAL_CONFIDENCE_MODE` | `shadow` | `off`, `shadow` (decide and log, never refuse) or `enforce` (refuse before the chat model when the evidence is weak) - see [docs/rag.md](docs/rag.md#rolling-out-the-gate) |
| `RETRIEVAL_CONFIDENCE_MIN_SEMANTIC_SCORE` / `..._MIN_TERM_COVERAGE` | `0.5` / `0.6` | Gate thresholds, calibrated offline - see [docs/evaluation.md](docs/evaluation.md) |
| `MAX_DOCUMENTS_PER_USER`, `MAX_STORAGE_BYTES_PER_USER`, `MAX_CHUNKS_PER_DOCUMENT` | `100`, `200 MB`, `2000` | Per-user limits |
| `RATE_LIMIT_REQUESTS` / `RATE_LIMIT_WINDOW_MS` | `10` / `60000` | Expensive operations per user per window |
| `LOG_LEVEL`, `LOG_QUESTIONS`, `RAG_DEBUG` | `info`, `false`, `false` | Logging (never document text or secrets) |
| `FEEDBACK_BUTTONS` | `false` | 👍/👎 under answers, stored with the gate's decision (to calibrate it on real use) |

More variables (timeouts, upload size, `MIN_SIMILARITY_SCORE`, context budget) are listed in `.env.example`.

## Operating it

```bash
npm run integrity                      # read-only check of documents, chunks, vectors, full-text index, files, hashes
npm run integrity -- --repair          # only safe, free repairs (full-text index, content hashes, stale temp files)
npm run reindex -- --dry-run           # which documents are stale, and whether they need a re-embed or a re-chunk
npm run backup -- --output ./backups/x # consistent snapshot: database + originals + manifest (no secrets)
npm run backup:verify -- ./backups/x   # manifest, hashes, database, integrity of the copy
```

Lifecycle, failure semantics, index health, integrity, backup and restore: [docs/architecture.md](docs/architecture.md#document-lifecycle).

## Testing and evaluation

```bash
npm run typecheck && npm test        # no network access; real OpenAI/Telegram are never called
npm run eval:retrieval               # Recall@K, MRR, answerability, per tag and per split (offline, deterministic)
npm run eval:confidence              # calibrate the confidence gate on the calibration split
npm run test:retrieval               # regression gate against eval/baseline.json
npm run bench:retrieval              # timings per stage
npm run eval:retrieval:live          # real embeddings: prints the plan and stops; costs money only with --confirm-spend
```

Current offline numbers (dataset v2, 44 answerable + 17 unanswerable questions; a small synthetic corpus, so read them as a regression harness, not a benchmark): Recall@1/3/5 = 0.82 / 0.95 / 1.00, MRR 0.92; the gate lets 98% of answerable questions through and refuses 71% of unanswerable ones (validation split reported separately). Method, honest limits and the live-evaluation workflow: [docs/evaluation.md](docs/evaluation.md).

## Known limitations

- Semantic search is a brute-force scan of the user's vectors (fine for thousands of chunks, not millions); the `VectorStore` port is the seam for an ANN index.
- Keyword matching is token based (no stemming or synonyms); the semantic side covers paraphrases.
- The confidence gate is a filter, not a verdict: wording close to real content can still pass (5 of 17 unanswerable questions in the evaluation), and its similarity threshold was calibrated on a synthetic embedder and **not yet validated against real embeddings** - which is why it runs in `shadow` mode by default.
- Scanned PDFs without a text layer are rejected (no OCR). PDF citations refer to the physical PDF page index; printed page labels are not read (the PDF library reports them incorrectly - [docs/rag.md](docs/rag.md#provenance-and-citations)). Markdown sections (ATX and Setext headings) need `npm run reindex -- --rechunk` for documents indexed before this feature.
- The rate limit is per process and resets on restart; single process only (SQLite file, long polling). There is no restore command: restoring a backup is a manual, documented copy.
