# Architect review — 2026-10-13

Snapshot: `e042e09`, branch `feat/document-lifecycle`; working tree was clean before review. Runtime implementation was not changed. Review covered composition, Telegram routing/admission, provider adapters, cancellation, lifecycle, retrieval, and the existing tests and operational checks.

## Assessment

Keep the existing architecture. Telegram adapters, application use cases/ports, core policies, and infrastructure have clear dependencies enforced by architecture tests. SQLite is a reasonable fit for the documented single-process deployment. Atomic index publication, ownership constraints, compensation, verified restore, durable update admission, and bounded semantic workers are substantial foundations.

The latest commit implements bounded, content-safe error serialization. The previous logging recommendation is complete. Durable update claims are also complete; their at-most-one-handler-admission semantics should remain explicit.

The next improvement should be **process-wide admission for expensive requests**, with leases retained until actual underlying work drains. An external queue, another database, and a framework migration would add complexity without solving this boundary directly.

## Ranked findings

### 1. High — expensive work has no process-wide admission limit

Files/functions: `src/shared/operation.ts:Operations.run` (line 50), `src/telegram/register-handlers.ts` (lines 62–78), `src/application/hybrid-retriever.ts:search` (line 207), `src/composition-root.ts:createApplication` (lines 239–264).

`Operations` tracks every operation but does not cap admissions. The rate limiter is per user; `KeyedMutex` serializes document mutations per user. Neither bounds aggregate downloads, PDF processing, transcription, embeddings, or chat generation. The semantic worker rejects excess jobs only after query embeddings have already run.

Verified probe: 100 distinct users each passed the real rate limiter, entered real `Operations.run`, and invoked the real `HybridRetriever` with a deferred fake embedding provider. Peak simultaneous query embeddings and tracked operations were both **100**. No paid calls occurred.

Impact: bursts can multiply buffered uploads, provider spend, retries, and resource contention. Per-user quotas do not cap total in-flight work.

Fix: one shared fail-fast request admission service, configured global and per-user active limits, applied after durable claims and rate checks but before expensive handlers. Retain a lease through actual task drainage, including tasks that ignore cancellation. Keep cheap commands accessible. A zero-length queue gives immediate overload feedback and bounds retained work; its trade-off is that users must resend during bursts.

### 2. High — readiness can precede polling, allowing polling after resource closure

Files/functions: `src/lifecycle.ts:startApplication` (lines 20, 37, 63), `runApplication` (lines 79–84).

The installed Telegraf source (`node_modules/telegraf/lib/telegraf.js`, lines 188–194) calls the launch callback after `getMe`, before awaited `deleteWebhook` and polling initialization. `startApplication` treats that callback as ready. Shutdown calls `stop`; if polling is not initialized, it throws, and the catch/finally path drains and closes storage without waiting for the remaining launch sequence. Signal listeners are also installed only after startup returns.

Verified with the real Telegraf class, deferred fake `deleteWebhook`, and a fake polling transport. Event order:

```text
deleteWebhook pending -> ready returned -> drain -> closed -> polling started
```

Impact: a stop/restart during delayed launch can leave polling active against closed storage. Readiness logs are premature.

Fix as a separate task: explicit starting/running/stopping/stopped lifecycle, shutdown ownership from the start, and a startup sequence that cannot initialize polling after stopping. Test delayed command sync, identity lookup, webhook deletion, startup failure, and signals. Avoid relying solely on synchronous launch test doubles.

### 3. Medium — cancellation prevents new Telegram sends but leaves a started send active

Files/functions: `src/telegram/operation.ts:createOperationMiddleware` (lines 17–22, 30), `src/telegram/reply.ts:replyLongText` (line 45).

Wrapped send methods check the signal before calling the underlying method, but do not pass cancellation into the transport. On deadline, the middleware sends a timeout response through the original method even if an answer send is still pending.

Verified deferred-send probe: after deadline, deliveries contained the timeout response; releasing the original send then appended the answer. This proves the wrapper behavior, not Telegram's eventual delivery behavior in production.

Fix: cancellation-aware delivery where supported, bounded delivery/pacing, and explicit handling of ambiguous in-flight sends. Cancellation cannot retract a message Telegram has already accepted; do not introduce automatic retries of ambiguous sends. Add deferred transport tests that cover timeout during a send and between multipart sends.

### 4. Medium — generated answers have no application-defined output budget

Files/functions: `src/infrastructure/openai/openai-chat-model.ts:createOpenAIChatModel` (line 41), `src/infrastructure/openai/response-text.ts:readTextContent` (line 2), `src/telegram/reply.ts:splitMessage` and `replyLongText` (line 45).

The chat adapter configures timeout and retries but no output-token budget. Content normalization joins the complete response; the delivery helper sends every resulting part without a total character/message cap. Provider limits still exist, but the application defines no smaller bound.

Verified helper probe: a synthetic 200,000-character answer produced **50** Telegram parts. This demonstrates the lack of a local cap; it is not a claim that the configured model produced that answer.

Fix: explicit generation-token budget plus defensive application character/message limits, applied to answers and summaries. Preserve valid Unicode and citation formatting, and disclose truncation. Keep this separate from request admission.

### 5. Medium, lower priority — lexical ranking depends on other users' corpus statistics

Files/functions: `src/infrastructure/sqlite/sqlite-vector-store.ts:LEXICAL_SELECT` (line 57), prepared lexical queries (lines 90–93).

FTS5 BM25 scores use the shared `chunk_fts` corpus before the ownership filter. Returned rows are user-scoped, but scores and ordering are affected by foreign documents.

Verified in-memory SQLite probe using the actual exported query: Alice's top two chunks changed from `A, B` to `B, C` after inserting 100 Bob chunks containing a query term. No foreign row was returned. This is ranking coupling, not demonstrated document disclosure.

Fix/trade-off: add a cross-user corpus-growth retrieval test and document the coupling. If stable tenant-local ranking is required, evaluate tenant-local statistics/reranking over a bounded candidate set or per-tenant indexes. Separate indexes increase operational complexity; prioritise findings 1–4 first. A reranker cannot fully remove coupling if global scoring has already excluded relevant candidates.

## Verification and limits

- `npm run check`: passed lint, typecheck, **104 test files, 1,548 tests passed, 5 skipped**, build, compiled lifecycle smoke, and 14 CLI smoke scenarios.
- `npm run test:retrieval`: passed the offline regression baseline.
- `npm run eval:confidence`: passed; shipped policy matches offline calibration. Validation specificity is 0.67 on six unanswerable validation questions.
- Focused synthetic probes reproduced aggregate concurrency, delayed-launch ordering, late-send behavior, missing reply budget, and cross-user lexical ranking coupling.
- No OpenAI or Telegram calls, production data access, deployment, commits, or pushes. The focused probes used fake providers/transports and in-memory SQLite.
- `npm audit` and Docker build were not run. Five skipped tests remain skipped; passing offline checks does not establish real-model answer quality.

Keep the confidence gate in shadow mode until real-embedding validation is available. The existing documentation already states this limitation correctly. A future AI-quality task should evaluate factual support and abstention in generated answers; the current citation check verifies source-number existence, not semantic support.

## Recommended next task

Implement finding 1 only using `CLAUDE_CODE_NEXT_TASK.md`. Address the startup race in the following change, then bounded output/delivery. Retain the architecture, current storage model, privacy rules, and deterministic evaluation harness.
