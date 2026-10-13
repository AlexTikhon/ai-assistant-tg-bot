# Claude Code next task: bounded admission for expensive Telegram requests

Act as a senior TypeScript backend engineer. Inspect the current implementation and conventions before editing. This task is grounded in `docs/reviews/ARCHITECT_REVIEW_2026-10-13.md` at commit `e042e09`; recheck the current working tree and adapt if it has changed.

## Problem and outcome

The bot has per-user rate limits and document locks, plus a bounded semantic-worker queue, but no global bound on expensive requests. A local probe with 100 distinct users through the real `Operations`, `RateLimiter`, and `HybridRetriever` reached 100 simultaneous query embeddings. The worker's queue limit is downstream of that paid work.

Implement one process-wide, fail-fast admission service for expensive Telegram requests. Bound aggregate work and stop one user from occupying all slots. Preserve the existing single-process architecture and all current privacy, cancellation, update-claim, and document-lifecycle guarantees.

## Scope

Start with:

- `src/shared/operation.ts`: actual work tracking and drainage.
- `src/shared/errors.ts` and `src/shared/safe-error.ts`: safe overload error and its log-code allowlist.
- A small admission primitive in `src/shared/`, and a delivery adapter in `src/telegram/` if needed.
- `src/telegram/register-handlers.ts`, `src/telegram/rate-limit.ts`, `src/telegram/operation.ts`.
- `src/composition-root.ts`, `src/config/config.ts`, `.env.example`.
- Relevant shared/Telegram tests, `README.md`, and operations/security docs where behavior changes.

Reuse existing seams. Do not make application/core code depend on Telegram or infrastructure. CLI tools and standalone offline evaluation should not require bot admission settings or credentials.

## Required behavior

1. Use one shared limiter across `/ask`, `/askdoc`, summaries, document uploads/replacements, voice, and ordinary question text. Acquire before download, PDF extraction, transcription, embedding, or generation. Hold one lease across the whole expensive handler; avoid nested acquisition for voice -> question or upload -> replacement.
2. Add validated positive-integer settings `MAX_ACTIVE_EXPENSIVE_REQUESTS` (initial default 8) and `MAX_ACTIVE_EXPENSIVE_REQUESTS_PER_USER` (initial default 2). Reject a per-user maximum above the global maximum. These defaults are starting policy values, not benchmark-derived capacity claims.
3. Use fail-fast admission with **no waiting queue**. When either bound is reached, send one safe busy response inviting a new request shortly. Rejected work must trigger no download, provider call, or document mutation. Do not consume capacity for unknown commands ignored by the text handler.
4. Preserve middleware ordering: private-chat gate and durable update claim first; operation scope, existing rate check, and workload admission before expensive handlers. Keep `/help`, `/list`, `/doc`, `/delete`, `/replace` usage help, and feedback usable while expensive slots are full. Preserve existing per-user rate-limit accounting.
5. The lease bounds **actual underlying work**, not only the response-facing promise. `operationStep` may reject on abort while its tracked provider promise is still pending. Retain capacity until handler work and associated tracked tasks have settled, including cleanup/compensation and providers that ignore AbortSignal. Releasing capacity from the outer deadline catch/finally is insufficient. Integrate with the existing operation drain ownership; do not create a separate incomplete shutdown mechanism.
6. Release exactly once on success, failure, timeout, and shutdown after drainage. Stop accepting work when shutdown begins. Forget idle per-user counters; never retain one entry forever per historical user. Keep storage open until admitted work drains under the existing shutdown contract.
7. Overload remains a terminal handled rejection in the durable update ledger. A replay of the same update must not execute later when capacity becomes free; a newly sent update may retry. Preserve at-most-one handler admission semantics.
8. Any logging uses bounded counts and safe error codes only, plus existing pseudonymous-user/request-ID conventions. Register a new overload code in safe-error serialization if introduced; do not expose payloads or raw IDs.

## Acceptance tests

Use deferred fakes/barriers instead of sleeps to establish concurrent work. Add integration coverage through the real Telegram middleware/routing and existing loopback API harness where useful.

- More distinct users than the global capacity: only the configured number enter expensive work; all excess requests receive busy feedback with zero downstream effects.
- Mixed question, upload, summary, and voice routes share the same global budget; replacement is covered. The same user's excess work is rejected while another user can use remaining capacity.
- Saturation preserves cheap commands and ownership/private-chat protections. Ignored commands use no capacity.
- A provider deliberately ignores cancellation: the caller times out, but the slot remains occupied until the fake provider is released; subsequent admission succeeds only after actual drainage.
- Success, thrown errors, timeout, cleanup, and shutdown release counters once, leave no idle user entries, and cause no unhandled rejection.
- Duplicate/replayed overloaded updates stay suppressed; fresh updates can retry after release.
- Invalid configuration and default values are covered. Existing rate-limit, cancellation, update-claim, architecture, and privacy tests continue passing.

## Non-goals

Do not fix the separate startup/polling race, change Telegram transport retries or output budgets, alter BM25/retrieval/confidence policies, introduce Redis/queues/new frameworks, migrate SQLite, add authentication, enable paid evaluations, or refactor unrelated code. Content-safe error logging and durable update admission are already implemented.

## Validation and delivery

Run focused tests while developing, then `npm run check` and `npm run test:retrieval`. Use only offline providers and loopback transports. Do not call paid APIs, touch production data, commit, push, or deploy.

Finish with the changed files, admission policy and lease lifetime, evidence from the cancellation-ignoring provider test, exact validation results, and remaining limitations. Do not describe unrun checks as passed.
