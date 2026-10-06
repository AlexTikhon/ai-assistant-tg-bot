# Changelog

## 1.0.0 - release candidate

A Telegram bot that answers questions from a user's own PDF, Markdown and text files, with citations.

**Retrieval**
- Hybrid search: vector similarity (a bounded worker thread) and SQLite FTS5 keyword search, fused with reciprocal rank fusion; exact identifiers, file names and versions get extra evidence.
- A deterministic confidence gate before the chat model (`off` / `shadow` / `enforce`; `shadow` is the default and never changes a reply).
- Citations with PDF pages or Markdown section paths; references to sources the model was not shown are removed.
- `/askdoc <documentId> <question>` searches one document only; `/ask` and plain text search everything.

**Documents**
- Identical uploads recognised by content hash, `/replace` without a half-indexed state, index health, re-embed and re-chunk workflows.

**Operations**
- Integrity check with safe repair, verified backup and restore, diagnostics, SQLite maintenance, graceful shutdown, quotas, rate limits, retries and cancellation.
- Docker image (non-root, one data volume) and GitHub Actions CI with no secrets.
- Logs identify users by a per-process pseudonym, never by Telegram id; `LOG_QUESTIONS` is development-only and announces itself at startup.

**Quality**
- 1,400+ tests against real SQLite, an offline end-to-end smoke test, a deterministic retrieval and answerability evaluation with a regression baseline, ESLint (async and type-import rules) and a strict TypeScript configuration.

**Removed in this release candidate**
- The `RETRIEVAL_CONFIDENCE_GATE` setting. Use `RETRIEVAL_CONFIDENCE_MODE=off|shadow|enforce`; the old name is now rejected at startup with that hint.
