# Operations

How to run, back up, restore, upgrade and diagnose the bot. Everything here works from the **compiled** build (`dist/`) and needs no API key or bot token except the bot itself and a real `npm run reindex`.

- [Running it](#running-it) · [Docker](#docker) · [Where the data lives](#where-the-data-lives)
- [Is it up? (health and readiness)](#is-it-up-health-and-readiness)
- [Backup and restore](#backup-and-restore) · [Integrity, repair, maintenance](#integrity-repair-and-maintenance) · [Corruption](#a-damaged-database)
- [SQLite settings](#sqlite-settings) · [File permissions](#file-permissions) · [Temporary files](#temporary-files)
- [Upgrading](#upgrading) · [Continuous integration](#continuous-integration) · [Dependency audit policy](#dependency-audit-policy)
- [Worked scenarios](#worked-scenarios)

## Running it

Supported Node.js: **22.12+ and 24** (`engines` in `package.json`; both run the full test suite in CI; `.nvmrc` names 24). Node 20 is end-of-life and not tested; Node 26 is not supported by the pinned `better-sqlite3`.

```bash
git clone <repo> && cd <repo>
nvm use                      # or any Node 22.12+/24
npm ci                       # exactly what package-lock.json says
npm run check                # lint + typecheck + tests + build + smoke + smoke:cli (no credentials, no network)
cp .env.example .env         # set TELEGRAM_BOT_TOKEN and OPENAI_API_KEY
npm start                    # node --enable-source-maps dist/index.js - compiled code, no tsx
```

| Script | What it is | Runs |
| --- | --- | --- |
| `dev` | the bot with auto-restart (needs the sources) | tsx |
| `lint`, `typecheck`, `test`, `test:coverage` | development checks (ESLint with typescript-eslint, tsc, vitest) | eslint, tsc, vitest |
| `check`, `check:release` | the pre-push command; the release check adds the retrieval regression gate, the confidence report and the runtime audit | npm scripts |
| `build` | compile to `dist/` (cleans it first) | tsc |
| `start` | the bot (`--enable-source-maps`: stack traces in the log name the TypeScript file and line; the maps hold no source text) | `node --enable-source-maps dist/index.js` |
| `smoke` | can this build start with its local infrastructure? (real SQLite, FTS5, retrieval, use cases, backup, restore; offline providers) | `node dist/cli/smoke.js` |
| `smoke:cli` | do the operational commands work from compiled code without credentials? | `node dist/cli/smoke-cli.js` |
| `integrity`, `backup`, `backup:verify`, `restore`, `diagnostics`, `db:maintenance`, `reindex` | operational commands | `node dist/cli/<name>.js` |
| `eval:*`, `bench:retrieval`, `test:retrieval` | development tooling (offline evaluation; not part of a production installation) | tsx |

The operational commands are compiled on purpose: they work in a production installation (and the Docker image) that has no TypeScript tooling. Run `npm run build` first - an old `dist/` runs old code.

## Docker

```bash
docker build -t telegram-rag-bot .
docker run -d --name rag-bot --init --restart unless-stopped \
  --env-file .env \
  -v rag-bot-data:/data \
  telegram-rag-bot
```

or `docker compose up -d --build` (one service, the `.env` file, one named volume, a restart policy - nothing else, because there is nothing else to run).

- **Image.** Multi-stage, `node:24-bookworm-slim` (Debian, not Alpine: `better-sqlite3` is a native module with prebuilt glibc binaries). Dependencies come from the lockfile (`npm ci`), TypeScript is compiled in the build stage and `npm prune --omit=dev` leaves production dependencies only. The final image holds `dist/`, `node_modules/` and `package.json` - no sources, tests, `.env`, data or secrets.
- **User.** The process runs as the unprivileged `node` user, never root. The data directory `/data` is created owned by that user (mode 700).
- **Secrets** are passed at run time (`--env-file`, `-e`, compose `env_file`). Nothing is baked into the image; `.dockerignore` keeps `.env*`, `data/`, `backups/` and logs out of the build context (a test checks it).
- **Shutdown.** `docker stop` sends SIGTERM: the bot stops polling, aborts updates and provider calls, waits for actual middleware/adapter work and file cleanup, then closes storage. A stuck shutdown forces exit after 15 s (`--stop-timeout`/`stop_grace_period` 20 s leaves room). `--init` is recommended (zombie reaping) but not required.
- **Operational commands in the container:** `docker exec rag-bot node dist/cli/integrity.js`, `docker exec rag-bot node dist/cli/backup.js --output /backups/before-upgrade` (with `-v /srv/rag-backups:/backups` on the `docker run`), and so on. To run one against the volume while the bot is stopped:
  `docker run --rm -v rag-bot-data:/data telegram-rag-bot node dist/cli/diagnostics.js`.
- **No HEALTHCHECK, deliberately.** See [Is it up?](#is-it-up-health-and-readiness).

## Where the data lives

One data root, `DATA_DIR` (default `./data`; **`/data`** in the image):

| Path | What | Persist it? |
| --- | --- | --- |
| `<DATA_DIR>/app.db` (+ `-wal`, `-shm` while running) | SQLite: documents, chunks, vectors, full-text index, feedback | **yes** |
| `<DATA_DIR>/files/` | the original uploads, named `<uuid>.<ext>` | **yes** |
| `<DATA_DIR>/.restore-staging-*` | working directory of a `restore` (interrupted ones are reported by `integrity`) | no (transient) |
| `<DATA_DIR>/.restore-previous-*` | the installation a restore replaced, kept until you delete it | until you have checked the restored data |
| `dist/`, `node_modules/`, build output | the application | **no** - rebuilt from the image or the checkout |

In a container the volume must be mounted at `/data`; a bind mount works too (`-v /srv/rag-bot:/data`) if the host directory is writable by uid 1000 (`chown 1000:1000 /srv/rag-bot`). Without a mount the image still declares `/data` a volume, so the data is not kept in the container's writable layer. Backups should live **outside** the data volume (or be copied out): `-v /srv/rag-backups:/backups` and `--output /backups/<name>`.

## Is it up? (health and readiness)

The bot is one process doing Telegram long polling. It has no HTTP port, and adding one only to satisfy `HEALTHCHECK` would invent a "healthy" that says nothing about Telegram, OpenAI or SQLite. The operator's signals are the process, the exit code and the **structured startup log** (JSON lines, one per stage, in this order):

| Question | Signal |
| --- | --- |
| Is the process alive? | `docker ps` / `systemctl status` (a crash exits non-zero; use `--restart unless-stopped`) |
| Is the configuration valid? | `"stage":"config"` - "Configuration valid" (else a fatal line listing every invalid variable, exit 1) |
| Is the database initialized? | `"stage":"database"` - "Database ready" with `schemaVersion` and the application `version` (a failed migration or a damaged file is fatal, with `advice`) |
| Is storage ready? | `"stage":"storage"` - "Storage ready" (the data directory must be readable and writable) |
| Which confidence mode? | `"stage":"retrieval"` - "Retrieval confidence gate: shadow" (`confidenceMode` field; never any question text) |
| Anything needing attention? | "Startup check passed" or a warning with counts (outdated indexes, missing originals, stale temporary files, orphans) |
| Has polling started? | `"stage":"telegram"` - "Connected to Telegram; polling", then `"stage":"ready"` - "Application started" |
| Is it still polling? | "Bot polling crashed" (fatal, exit 1) if polling dies, e.g. a 409 conflict because a second instance runs |

`npm run diagnostics` (works on the data directory, also with the bot running) adds counts, versions and index health.

**Confidence mode.** `RETRIEVAL_CONFIDENCE_MODE` defaults to `shadow`: the answerability decision is computed and logged for every question, and **never changes a reply**. `enforce` (refuse weak evidence without calling the chat model) is an explicit operator decision after the threshold has been validated on real embeddings - see [rag.md](rag.md#rolling-out-the-gate). The semantic threshold (0.5) was calibrated offline on synthetic embeddings and is not validated against real ones.

## Backup and restore

### Backup

```bash
npm run backup -- --output ./backups/before-upgrade     # default ./backups/bot-backup-<UTC timestamp>
npm run backup:verify -- ./backups/before-upgrade
```

Safe while the bot runs (SQLite's online backup API, a point-in-time snapshot). A backup is a directory: `app.db`, `files/<stored name>` and `manifest.json` (written last - no manifest, no finished backup). It contains user documents and **never** `.env`, keys, the bot token or logs; treat it as sensitive data anyway (directories 0700, files 0600). `backup:verify` checks the manifest, the format version, the SHA-256 of every file and of the database, SQLite's structural check, that every document's file is present, and runs the integrity checks - including the deep full-text check - on the copy.

Backup holds a SQLite `BEGIN IMMEDIATE` write barrier from snapshot creation through copying originals and writing the manifest. Readers continue; document mutations wait and can exceed their busy timeout during a large backup. Stop the bot for large backups to avoid failed writes. The barrier requires write access to the source database, but does not modify it. It is released on success and failure. Files referenced by the snapshot cannot be removed by normal document mutations during copying.

Missing originals make creation, verification and restore fail by default. For deliberate partial disaster recovery only, pass `--allow-incomplete` separately to `backup`, `backup:verify` and `restore`. This accepts files explicitly recorded as missing in the manifest and reports warnings; hash mismatches, undeclared missing files and other integrity failures still fail. A partial restore preserves database content but cannot recover those originals.

### Format and compatibility

The manifest carries two independent versions:

- **`formatVersion`** (currently 1): the layout of the backup directory and the meaning of the manifest. Supported: `MIN_SUPPORTED_BACKUP_FORMAT`..`BACKUP_FORMAT_VERSION`. A **newer** format is refused ("use the version of the application that made it, or a newer one"); a too-old format is refused. Nothing is guessed.
- **`schemaVersion`**: the database schema inside. A backup from an **older schema** restores fine: the existing migrations run on the *candidate* (never on the live installation), and the integrity check runs after them. A **newer** schema than the application supports is refused.

`application.name` must be `telegram-rag-bot` and `application.version` records the version that wrote it.

### Restore

```bash
npm run restore -- --from ./backups/before-upgrade --dry-run                  # verify + prepare + check, change nothing
npm run restore -- --from ./backups/before-upgrade                            # into an empty / new data directory
npm run restore -- --from ./backups/before-upgrade --replace-existing         # replace an installation that holds data (it is KEPT)
npm run restore -- --from ./backups/before-upgrade --target /srv/other-data   # restore somewhere else
```

Stop the bot first. Options: `--target <dir>` (default `DATA_DIR`), `--replace-existing` (required when the target holds data), `--discard-previous` (with `--replace-existing`: delete the replaced installation afterwards), `--dry-run`. It is scriptable (no prompt); exit code 0 on success, 1 when the restore did not happen - and then the live installation is exactly as it was.

**What it does, in this order, stopping at the first failure:**

1. **Verify the backup** (read-only): everything `backup:verify` checks. An invalid manifest, a missing database, a missing stored file, a hash mismatch, an unsupported format or an integrity error refuses the restore; every finding is listed.
2. **Look at the target** (read-only): `absent`, `empty` (a database without documents or feedback and no stored files - nothing to lose), `populated`, `unreadable` (a file SQLite cannot read) or `in use` (another process holds the database - the bot is still running). `populated` and `unreadable` need `--replace-existing`; `in use` is refused.
3. **Stage a candidate** in `<data dir>/.restore-staging-<uuid>/` - inside the data directory, so the final step is a rename on one filesystem. The database and every file are copied and their SHA-256 is checked again after the copy.
4. **Migrate the candidate** if its schema is older (with the application's normal connection settings).
5. **Check the candidate**: the complete integrity check, including file hashes and the deep full-text check. Any error aborts.
6. **Activate** (see below).

**Atomicity and failure semantics.** The live database file is the single commit point. Restoring cannot be one atomic operation across a database and a directory of files, so the order is chosen so that every failure before the commit leaves the live installation untouched, and the commit itself is one atomic rename:

| Step | What happens | If it fails or the process dies here |
| --- | --- | --- |
| 1 | the live database is locked exclusively (proves the bot is not running), checkpointed and **snapshotted** into `.restore-previous-*/app.db`; closing it removes `-wal`/`-shm`, so a stale write-ahead log can never meet the restored file | nothing was changed; the snapshot is dropped |
| 2 | the staged files are **moved** into `files/` (names are unique ids; an identical file that is already there is kept; a different file with the same name aborts) | the files this restore added are removed again; the live installation is as it was |
| 3 | **commit:** the staged `app.db` is renamed over `app.db` | atomic: the old or the new database, never a mix |
| 4 | best effort: stored files the restored database does not refer to move to `.restore-previous-*/files/` | only warnings; the restored installation is already live (`integrity` lists leftovers) |

A **failure** (an error) before step 3 is rolled back by the restore itself. A **crash or kill** before step 3 leaves the live installation untouched plus the staging directory and possibly files nothing refers to - `npm run integrity` reports both (`interrupted-restore`, `orphan-file`) and `--repair` removes a staging directory older than an hour. After step 3 the backup *is* the installation.

**The replaced installation is kept**, not deleted: `.restore-previous-<time>-<id>/` holds its database snapshot and its files (for an unreadable database: the file as it was, plus its `-wal`/`-shm`, as evidence). It contains user documents; delete it yourself once the restored data is checked (`integrity` reminds you with a `previous-installation` warning; it never removes it).

A restore never calls any provider and needs no credentials.

## Integrity, repair and maintenance

```bash
npm run integrity                       # read-only, deep: documents, chunks, vectors, files, hashes, full-text index
npm run integrity -- --repair           # deterministic, free, lossless repairs only
npm run diagnostics [-- --json]         # versions, counts, storage, index health - safe to paste into a bug report
npm run db:maintenance                  # SQLite integrity_check + foreign_key_check; changes nothing
npm run db:maintenance -- --checkpoint --optimize
npm run db:maintenance -- --vacuum      # explicit only: slow, needs ~2x the database size in free disk
```

**Deep full-text check.** The cheap check compares row counts. `npm run integrity` additionally verifies the *content* of the index: SQLite's FTS5 `integrity-check` recomputes the index entries of every chunk and compares them with the index (nothing extra is stored; because the command is an `INSERT` it runs on a private in-memory copy, so the live database stays read-only, and is skipped with a warning above 1 GiB), and a deterministic sample of up to 200 chunks is searched for through the same SQL the bot's keyword search uses - each chunk must be found for its owner and not for anybody else. It runs only in explicit commands (`integrity`, `backup:verify`, `restore`), never at startup.

**Repair and verification.** `--repair` rebuilds the full-text index and then *verifies the result*: every chunk indexed, the content comparison, the sample searches. "The SQL ran" is not success - a rebuild whose result fails verification is reported as **failed** with the reason, and the exit code is 1.

`db:maintenance` runs SQLite's full `integrity_check` first and refuses to optimize or rewrite a database that is not sound. `VACUUM` is never run automatically (startup included), needs the bot stopped and the free disk space, and is refused when there is not enough.

## A damaged database

At startup the bot opens the database, migrates it and runs SQLite's structural check (`quick_check`, one pass over the file). If the file cannot be opened, is not a database, or fails the check, the start **stops at the database stage**: one fatal log line with the error category and `advice`, exit code 1, no Telegram connection. **The file is never overwritten or "fixed" automatically.** The way out is:

```bash
npm run backup:verify -- <latest backup>                       # pick one that verifies
npm run restore -- --from <latest backup> --dry-run
npm run restore -- --from <latest backup> --replace-existing   # the damaged installation is kept as evidence
```

The command-line tools print the same advice when they hit a damaged database. A migration that cannot run because existing data would violate a new constraint (migration 9: a chunk whose owner differs from its document's) stops the same way, names the documents, and changes nothing.

## SQLite settings

Applied by one function (`applyWritablePragmas`) to every writable connection - the bot, `reindex`, `integrity --repair`, a restore candidate, and the tests; the read-only connections (integrity, backup verification, diagnostics) get the busy timeout; maintenance does not migrate.

| Setting | Value | Why |
| --- | --- | --- |
| `journal_mode` | `WAL` | readers (a backup, `integrity`) and the writer do not block each other; persisted in the file |
| `synchronous` | `NORMAL` | the usual WAL companion: a commit survives an application crash; only an OS crash or power loss can lose the last commits (never corrupt the file). `FULL` would fsync every commit for a guarantee this application does not need |
| `foreign_keys` | `ON` | off by default in SQLite and per connection; the chunk -> document cascade and the chunk-owner constraint depend on it |
| `busy_timeout` | `5000` ms | a CLI tool next to the bot waits for a lock instead of failing at once |

Not set on purpose: `cache_size`, `mmap_size`, `temp_store` (defaults are fine at this scale).

## File permissions

User documents and the database are private to the account running the bot: **data directories 0700, database and stored files 0600, backup directories 0700 and their files 0600** (set explicitly, so the umask does not matter). On Windows and on file systems without POSIX modes (some bind mounts) the calls are best effort and ignored. Nothing the application creates is world-readable or world-writable (a test pins the modes on Linux).

## Temporary files

| Artifact | Where | Name | Left behind by | Discovered by |
| --- | --- | --- | --- | --- |
| upload write | `<data>/files/` | `.tmp-<uuid>.part` | a crash mid-write | `integrity` (`temporary-file`; `--repair` removes ones older than 1 h) |
| replacement / ingestion new file | `<data>/files/` | `<uuid><ext>` | a crash between writing the file and committing the row | `integrity` (`orphan-file`; `--repair --remove-orphans` after 24 h) |
| restore staging | `<data>/` | `.restore-staging-<uuid>/` | a crash during a restore | `integrity` (`interrupted-restore`; `--repair` removes after 1 h) |
| replaced installation | `<data>/` | `.restore-previous-<time>-<uuid>/` | a successful restore (intentionally) | `integrity` (`previous-installation`; never removed automatically) |
| backup | the output directory | `manifest.json.tmp` | a crash during a backup | a directory without `manifest.json` is not a backup; a failed backup removes what it created |

All names carry a random UUID, so two operations never share one, and everything lives inside the data (or backup) directory - never a shared `/tmp`.

## Upgrading

```bash
npm run backup -- --output ./backups/before-upgrade && npm run backup:verify -- ./backups/before-upgrade
git pull && npm ci && npm run build && npm run smoke
npm start          # migrations run once, each in its own transaction; the schema version is logged
```

Migrations only move forward. A database written by a newer version is refused ("newer than this application supports"). Going back is a restore of the pre-upgrade backup. `npm run diagnostics` and the startup log show the application version (`package.json`) and the schema version; a backup's manifest records the version that wrote it.

## Continuous integration

`.github/workflows/ci.yml` runs on pull requests and pushes to `main`, needs **no secrets** and calls no external service. Jobs: **verify** on Node 24 and 22 (install from the lockfile, lint, typecheck, the full test suite, build, `smoke`, `smoke:cli`, the retrieval regression baseline, the offline evaluation and the confidence calibration report), **coverage** (a diagnostic with a job summary and an artifact, no threshold), **package** (a bundle of `dist/`, the manifests and the docs), **docker** (build the image, check it runs as non-root, the volume is writable, the image holds no secrets or sources, and run `smoke` and `smoke:cli` inside it), and **security** (below). The real `better-sqlite3` is installed the normal way and exercised - nothing is mocked - and the smoke test asserts FTS5 is compiled in.

## Dependency audit policy

- `npm audit --omit=dev` (runtime dependencies) **fails the build** on any known vulnerability.
- `npm audit` (everything) is **reported, never blocking**: a transitive advisory in a development tool must not stop a release, but it is visible in every run.
- `npm audit fix --force` is never run. Dependabot (weekly: npm, GitHub Actions, the base image) opens pull requests; nothing is merged automatically.
- **Currently:** no known advisory, runtime or development. (`esbuild 0.27.3-0.28.0`, GHSA-g7r4-m6w7-qqqr, low - arbitrary file read through esbuild's development server on Windows, a transitive development dependency this project never exposes - was cleared by updating `tsx`, which pulls in the patched esbuild.) An advisory in a development-only tool that cannot be cleared by a compatible update is documented here rather than hidden.

## Worked scenarios

### A. Normal deployment from a clean checkout

| | |
| --- | --- |
| **Detection** | the startup log: `config` -> `database` -> `storage` -> `retrieval` -> startup check -> `telegram` -> `ready` |
| **Application / CLI** | `npm ci`, `npm run check` (lint, typecheck, 1400+ tests, build, smoke, smoke:cli), then `npm start`. The bot validates the configuration, creates the data directory (0700), opens `app.db` (0600, WAL), migrates to the current schema, runs the structural check, logs the confidence mode (`shadow`), syncs the command menu and starts polling |
| **DB effect** | a new database at the latest schema version, no documents |
| **Filesystem effect** | `data/` and `data/files/` created |
| **Operator sees** | seven stage log lines ending in "Application started"; `npm run diagnostics` shows schema = expected, 0 documents |
| **If a stage fails** | the bot exits 1 at that stage, naming it (invalid variables are all listed at once); nothing later is attempted |

### B. Restart with an existing persistent volume

| | |
| --- | --- |
| **Detection** | `docker stop` -> "Shutting down" ... "Shutdown complete"; `docker start` -> the same stage lines |
| **Application / CLI** | SIGTERM: stop polling, finish updates in flight (max 15 s), close the database (the WAL is checkpointed). On start: the volume's `app.db` opens (a crash-time WAL is replayed by SQLite), pending migrations (none) are skipped, `quick_check` passes, the startup check summarises the data (outdated indexes, missing originals, orphans), polling resumes |
| **DB effect** | none (a newer release's migrations run once, in transactions, if any) |
| **Filesystem effect** | none; the same `files/` is used |
| **Operator / user sees** | the bot answers again; `/list` shows the same documents; the rate limiter (in memory) starts fresh |
| **If the data is wrong** | the startup check warns with counts and points at `npm run integrity`; a damaged file stops the start (scenario C) |

### C. Live data becomes unusable; restore the latest verified backup

| | |
| --- | --- |
| **Detection** | the bot exits at start: `"stage":"database"` fatal with `advice` (corrupt / not a database), or `npm run integrity` reports `database-corrupt`, or SQLite errors in the log |
| **Application / CLI** | the damaged file is **not** touched. `npm run backup:verify -- <dir>` on the newest backups until one is OK; `npm run restore -- --from <dir> --dry-run` rehearses; `npm run restore -- --from <dir> --replace-existing` verifies, stages, migrates if older, integrity-checks the candidate, snapshots/copies the old installation, moves the files in and renames the database into place |
| **DB effect** | the live `app.db` is the backup's database (migrated to the current schema if older); the damaged file (and its `-wal`/`-shm`) are in `.restore-previous-*/` |
| **Filesystem effect** | the backup's files are in `files/`; files of the old installation the backup does not know moved to `.restore-previous-*/files/`; the staging directory is gone |
| **Operator sees** | "Restored N documents, N chunks, N original files", the kept directory name and any warnings; then start the bot; `npm run integrity` is clean |
| **User sees** | the knowledge base as of the backup (later uploads must be sent again; they are in the kept directory if needed) |
| **Recovery paths** | any failure before the commit changes nothing - fix the cause and re-run; delete `.restore-previous-*` once satisfied; a failed verification names every problem (pick an older backup) |

### D. A malicious file name such as `../../secret.txt` is uploaded

| | |
| --- | --- |
| **Detection** | not an error: a file name is data, never a path. A name without a supported extension (`/etc/passwd`, `C:\Windows\system.ini`) is answered "Unsupported file type" before the download |
| **Application** | the upload (`.txt` is supported) is downloaded within the size limit, its bytes are checked (text, not binary), the display name is cleaned (control and direction-override characters removed, length bounded, Unicode kept) and the file is stored as `files/<uuid>.txt`. The name appears only in the `documents.file_name` column and in replies, as plain text |
| **DB effect** | one document row whose `file_name` is `../../secret.txt` and whose `stored_name` is the generated name |
| **Filesystem effect** | exactly one new file inside `data/files/`; nothing outside it, nothing overwritten |
| **User sees** | "Indexed ../../secret.txt." and a document id; `/delete <id>` removes it |
| **Recovery** | none needed. Names read back from the database are validated again before they touch the file system, and a symbolic link in `files/` is never followed (tests cover traversal, absolute and drive paths, NUL, reserved names, very long and Unicode names) |

### E. The full-text index becomes inconsistent with the chunks

| | |
| --- | --- |
| **Detection** | keyword search misses text that is there; `npm run integrity` reports `fts-mismatch` (row counts), `fts-content-mismatch` (the index no longer describes the stored text) or `fts-search-broken` (sample searches wrong) - all errors with the fix `npm run integrity -- --repair` |
| **Application / CLI** | `npm run integrity -- --repair` rebuilds the index from `document_chunks.content`, then verifies it (coverage, content comparison, sample searches) and prints "rebuilt the full-text index and verified it (N chunks indexed, M sample searches ok, ...)". A rebuild that fails verification prints a failure with the reason and exits 1 |
| **DB effect** | `chunk_fts` is rebuilt; chunks, vectors and documents are untouched |
| **Filesystem effect** | none |
| **User sees** | keyword (and therefore hybrid) retrieval works again; semantic search was never affected |
| **Recovery if the repair fails** | the output says what failed; the data itself is intact - restore a verified backup (scenario C) |
