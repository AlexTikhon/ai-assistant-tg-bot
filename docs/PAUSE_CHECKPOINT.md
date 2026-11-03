# Pause checkpoint — 2026-11-03

Development is paused after two local closeout commits. Starting snapshot: `ab73709` on `main`, clean and equal to the local `origin/main` reference. No push, deployment, live provider requests, production database access or schema changes were part of this closeout. The release audit required one compatible runtime dependency update (Zod); its exact manifest/lockfile change was reviewed before commit.

## Architecture decision

Keep the current TypeScript single-process application: Telegram adapters -> application use cases/ports -> core policies, with infrastructure adapters wired in `composition-root.ts`. SQLite/WAL/FTS5, revision-fenced index publication, per-user mutation locks, bounded semantic workers, durable update admission and compensated file publication fit the present scale. Adding a queue, HTTP frontend, another database or a framework would increase the maintenance surface without addressing the closeout defects.

Review covered runtime composition, Telegram routing/privacy/admission/delivery, operation drainage, document ingestion/replacement/deletion/summary, retrieval/citations/confidence, SQLite ownership/publication, provider adapters, storage, backup/restore, CLI tooling, configuration, CI and their tests. This is a bounded local architecture review and verification checkpoint, not a production certification or an assertion that every possible defect is excluded.

## What was completed

1. `9170a51` — `fix: fence Telegram startup during graceful shutdown`. One lifecycle owner from command sync through polling shutdown; cancellation checks around startup transport awaits; readiness at the first polling request; polling and actual application work settle before storage closes. Signals are handled during the initial diagnostic too. Real Telegraf tests cover delayed startup stages, ignored cancellation, API failures, idempotence and signal listener cleanup. Fixed CRLF-dependent operational source checks on Windows.
2. The commit containing this checkpoint — bounded generation and Telegram delivery. `CHAT_MAX_OUTPUT_TOKENS=2048` by default (1..8192); 16,000 UTF-16 units per generated result, including summary cache reads; 8 messages / 24,000 units per delivered reply. Visible shortening notices cover provider token exhaustion and defensive truncation. Telegram calls receive cancellation and a 10-second transport deadline; underlying tasks stay tracked until settled. Ambiguous sends are not retried or followed by a competing timeout/error reply. Tests cover the SDK request body, Unicode/citations, oversized injected providers, cached summaries, cancellation during/between sends and cancellation-ignoring transports. The initial release audit found [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) in Zod 4.3.6 (patched in 4.6.6); the closeout updates the direct dependency and lockfile to 4.6.7 within major version 4.

## Verification

`npm run check:release` passed with exit code 0 on Windows x64, Node 24.11.1 / npm 11.6.2, after the Zod update:

- ESLint and TypeScript checks passed.
- 113 test files passed: 1,634 tests passed, 5 skipped. The skips are the POSIX permission test and four symlink scenarios unavailable in this Windows environment; no Linux permission evidence is claimed.
- TypeScript build and compiled application smoke passed, including ownership isolation, ingestion, duplicate recognition, replacement, retrieval, verified backup/restore, deletion and integrity.
- Compiled CLI smoke passed all 14 scenarios without credentials.
- Retrieval regression baseline, offline evaluation and confidence calibration passed. On the 61-query synthetic dataset: Recall@5 = 1.00, MRR = 0.92, isolation violations = 0. Validation answerability specificity remains 0.67 on six unanswerable validation queries; this does not justify enabling enforcement.
- `npm audit --omit=dev`: zero known runtime vulnerabilities at this checkpoint. The separate full audit's 12 development findings are recorded below and in `operations.md`.
- Staged manifest and whitespace were reviewed before each local commit. The only dependency change is Zod 4.3.6 -> 4.6.7; schema version remains 11. No push was run.

## Accepted limitations

- **AI quality:** confidence remains `shadow`; offline synthetic embeddings validate pipeline regressions, not real-model retrieval, factual correctness or citation support. Citation checks validate reference numbers, not whether the cited text supports the claim. Do not enable `enforce` from offline results alone.
- **Delivery:** readiness means the first polling request was issued, not that Telegram accepted it. Cancellation cannot retract an accepted message. A failed or interrupted send may leave no answer or a partial multipart reply; the user must send a fresh request. The ledger guarantees at-most-one handler admission within retention, not exactly-once external effects.
- **Cost:** token limits apply per generation call. Map-reduce summaries can still make multiple calls; there is no aggregate monetary budget per request or persistent daily quota.
- **Scale:** one bot process per SQLite database/token; admission and rate limits reset on restart. Semantic search remains a bounded per-user scan. FTS5 filters returned rows by owner, but BM25 uses shared corpus statistics, so other users' documents can affect ranking without returning foreign content. Tenant-local ranking would require separate statistics/indexes or a deliberately evaluated retrieval change.
- **Storage:** host storage and unencrypted backups are trusted operator assets; stop the bot before restore. No OCR for scanned PDFs. A stuck shutdown forces process exit after 15 seconds and relies on startup claim recovery and integrity tooling.
- **Evidence:** no real Telegram/OpenAI interaction, paid/live evaluation, hosted CI or Docker image verification was performed in this closeout. Automated tests use disposable data and fake providers/transports; no operator backup of existing user data was created.
- **Development dependencies:** the separate full `npm audit` reports 12 development-graph findings (11 moderate through ESLint/minimatch and one high in Vite 8.3.2). They remain visible under the existing non-blocking development-audit policy; no forced upgrade/downgrade was applied. The bot runtime and `tsx watch` development command do not expose a Vite development server. Review compatible tooling updates on resume.

## Resume procedure

1. Read this checkpoint, inspect `git status`/history and runtime versions; refresh the dependency audit before adding features.
2. Install from the lockfile with `npm ci` if needed; run `npm run check:release` on a supported Node version (22.12+ or 24). Keep the confidence gate in shadow mode.
3. Before touching an existing installation, back up its explicit `DATA_DIR`, run `npm run backup:verify -- <backup>`, and rehearse restore into a disposable target. Never seed/reset an unknown database.
4. Separately verify real Telegram startup, SIGTERM/restart, upload -> ask -> summary -> delete, overload and interrupted delivery with an approved private test corpus and provider budget.
5. Choose one next slice from fresh evidence. The first product-quality candidate is a real-embedding evaluation set covering retrieval, abstention, citation support, latency and cost. Collections, `/train`, a frontend, Ollama, multi-process hosting and ANN remain proposals; none is an accepted next task.

The old admission task in `CLAUDE_CODE_NEXT_TASK.md` was completed by `ab73709`; its replacement points here so the paused project does not accidentally restart an already implemented task.
