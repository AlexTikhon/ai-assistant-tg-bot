import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

type RequestContext = { requestId: string };

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * A short opaque identifier for one operation (one Telegram update): 8 random hex characters. It is made of
 * nothing but randomness - never of user content, user ids or secrets - and is meant for log correlation.
 */
export function newRequestId(): string {
  return randomBytes(4).toString("hex");
}

/** Runs `fn` (and everything it awaits) with `requestId` attached; the logger adds it to every line. */
export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return storage.run({ requestId }, fn);
}

/** The id of the operation currently running, if any. */
export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}
