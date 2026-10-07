/**
 * The durable claim ledger for Telegram updates: the application-level answer to "has this exact update already been given to the
 * handlers?". It is separate from Telegram's polling offset, which only says what the bot has asked Telegram not to send again.
 *
 * The contract is conservative AT-MOST-ONE HANDLER ADMISSION: within the retention horizon, the same (bot_id, update_id) is admitted to
 * business work once. It is deliberately not exactly-once delivery: SQLite cannot commit together with OpenAI, Telegram or the file
 * system, so after a crash nobody can know which external effects happened - and an interrupted update is therefore never replayed.
 * The user retries by sending a new message (a new update_id).
 *
 * Nothing about the content of an update is stored: only identity, state, timestamps and an allowlisted category.
 */

/** Terminal/recovered claims are protected for this long, counted from the time they became terminal (not from any Telegram timestamp). */
export const UPDATE_CLAIM_RETENTION_MS = 48 * 60 * 60 * 1000;

export type UpdateClaimState = "running" | "completed" | "failed" | "interrupted";
export type TerminalUpdateState = Exclude<UpdateClaimState, "running">;

/** Why a claim ended the way it did. A fixed vocabulary: never an error message. */
export const UPDATE_CLAIM_CATEGORIES = ["rejected", "external", "internal", "timeout", "shutdown", "recovered"] as const;
export type UpdateClaimCategory = (typeof UPDATE_CLAIM_CATEGORIES)[number];

export type UpdateClaimOutcome = { state: TerminalUpdateState; category?: UpdateClaimCategory };

export type ClaimResult = { admitted: true } | { admitted: false; state: UpdateClaimState };

/** The identity is not a usable (bot_id, update_id) pair: it is rejected, never coerced into one. */
export class InvalidUpdateIdentityError extends Error {
  constructor(what: "bot_id" | "update_id") {
    super(`${what} is not a valid identifier`);
    this.name = "InvalidUpdateIdentityError";
  }
}

/** Synchronous on purpose: the claim must be one short atomic step with no await between "admitted" and the handler chain. */
export interface UpdateClaimStore {
  /** Atomically records (botId, updateId) as running. `admitted: false` means it was claimed before (in whatever state). Throws when storage fails. */
  claim(botId: number, updateId: number): ClaimResult;
  /** running -> terminal, once. Returns false (and changes nothing) when the claim is not running any more, or the store is closed. */
  finish(botId: number, updateId: number, outcome: UpdateClaimOutcome): boolean;
  /** Startup only: every claim still running belongs to a previous process. Marks them interrupted (fresh retention horizon). Returns how many. */
  recoverInterrupted(): number;
  /** Deletes at most `limit` terminal claims older than the retention horizon, oldest first. Never touches running claims. Returns how many. */
  purgeExpired(limit: number): number;
  /** After this the store never touches SQLite again: claims throw, finishes are ignored. */
  close(): void;
}
