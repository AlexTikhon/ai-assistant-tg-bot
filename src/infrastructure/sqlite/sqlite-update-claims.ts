import type Database from "better-sqlite3";
import {
  InvalidUpdateIdentityError,
  UPDATE_CLAIM_CATEGORIES,
  UPDATE_CLAIM_RETENTION_MS,
} from "../../application/ports/update-claims.js";
import type { ClaimResult, UpdateClaimOutcome, UpdateClaimState, UpdateClaimStore } from "../../application/ports/update-claims.js";

/** `now` is injectable so retention can be tested without waiting; it is the only clock this ledger ever reads. */
export class SqliteUpdateClaimStore implements UpdateClaimStore {
  private readonly insert;
  private readonly select;
  private readonly finishRunning;
  private readonly recover;
  private readonly purge;
  private readonly now: () => number;
  private closed = false;

  constructor(db: Database.Database, options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    // One statement is the whole admission: the PRIMARY KEY decides the winner, so there is no read-then-insert window.
    this.insert = db.prepare(
      "INSERT INTO telegram_update_claims (bot_id, update_id, state, claimed_at) VALUES (@botId, @updateId, 'running', @at) ON CONFLICT (bot_id, update_id) DO NOTHING",
    );
    this.select = db.prepare<[number, number], { state: UpdateClaimState }>("SELECT state FROM telegram_update_claims WHERE bot_id = ? AND update_id = ?");
    // `state = 'running'` is the fence: a late finish (an adapter that ignored cancellation) can never rewrite a claim that already ended.
    this.finishRunning = db.prepare(
      "UPDATE telegram_update_claims SET state = @state, terminal_at = @at, error_category = @category WHERE bot_id = @botId AND update_id = @updateId AND state = 'running'",
    );
    this.recover = db.prepare(
      "UPDATE telegram_update_claims SET state = 'interrupted', terminal_at = @at, error_category = 'recovered' WHERE state = 'running'",
    );
    this.purge = db.prepare(
      `DELETE FROM telegram_update_claims WHERE (bot_id, update_id) IN (
         SELECT bot_id, update_id FROM telegram_update_claims WHERE terminal_at < @cutoff ORDER BY terminal_at LIMIT @limit)`,
    );
  }

  claim(botId: number, updateId: number): ClaimResult {
    this.assertOpen();
    assertIdentity(botId, updateId);
    if (this.insert.run({ botId, updateId, at: this.now() }).changes === 1) return { admitted: true };
    // Only the state is read, and only to let the caller choose how to answer a duplicate; admission was already decided above.
    return { admitted: false, state: this.select.get(botId, updateId)?.state ?? "running" };
  }

  finish(botId: number, updateId: number, outcome: UpdateClaimOutcome): boolean {
    if (this.closed) return false;
    assertIdentity(botId, updateId);
    const category = outcome.category ?? null;
    if (category !== null && !(UPDATE_CLAIM_CATEGORIES as readonly string[]).includes(category)) {
      throw new TypeError("Unknown update claim category");
    }
    return this.finishRunning.run({ botId, updateId, state: outcome.state, category, at: this.now() }).changes === 1;
  }

  recoverInterrupted(): number {
    this.assertOpen();
    return this.recover.run({ at: this.now() }).changes;
  }

  purgeExpired(limit: number): number {
    this.assertOpen();
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("limit must be a positive integer");
    return this.purge.run({ cutoff: this.now() - UPDATE_CLAIM_RETENTION_MS, limit }).changes;
  }

  close(): void {
    this.closed = true;
  }

  private assertOpen() {
    if (this.closed) throw new Error("The update claim store is closed");
  }
}

function assertIdentity(botId: unknown, updateId: unknown) {
  if (typeof botId !== "number" || !Number.isSafeInteger(botId) || botId <= 0) throw new InvalidUpdateIdentityError("bot_id");
  if (typeof updateId !== "number" || !Number.isSafeInteger(updateId)) throw new InvalidUpdateIdentityError("update_id");
}
