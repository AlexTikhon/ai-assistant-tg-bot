import { AsyncLocalStorage } from "node:async_hooks";
import { AppError } from "./errors.js";

export type OperationOptions = { signal?: AbortSignal };
type OperationContext = { signal: AbortSignal; tasks: Set<Promise<unknown>> };
const context = new AsyncLocalStorage<OperationContext>();

export class OperationCancelledError extends AppError {
  constructor(
    message = "This request took too long and was cancelled. Please try a smaller request.",
    /** Why it was cancelled: its deadline passed, or the application is shutting down. */
    readonly kind: "timeout" | "shutdown" = "timeout",
  ) {
    super(message, "OPERATION_CANCELLED");
  }
}

/** The update's deadline follows the same async scope as its request id, including queued work. */
export const operationSignal = () => context.getStore()?.signal;
export const throwIfCancelled = () => operationSignal()?.throwIfAborted();

/** Stops the application chain even when an injected provider ignores the signal. */
export async function operationStep<T>(task: () => Promise<T>, signal = operationSignal()): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return task();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    const work = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return task();
    });
    // Abort ends the application chain, but adapters may still be releasing resources.
    const scope = context.getStore();
    scope?.tasks.add(work);
    void work.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
      scope?.tasks.delete(work);
    });
  });
}

/** Tracks actual middleware work, independently of Telegraf's timeout/polling promises. */
export class Operations {
  private readonly active = new Map<AbortController, Promise<unknown>>();
  private stopping = false;

  get activeCount() { return this.active.size; }

  async run<T>(timeoutMs: number, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.stopping) throw new OperationCancelledError("The bot is restarting. Please try again shortly.", "shutdown");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new OperationCancelledError()), timeoutMs);
    const scope: OperationContext = { signal: controller.signal, tasks: new Set() };
    const work = context.run(scope, () => Promise.resolve().then(() => task(controller.signal)));
    const drained = work.then(() => undefined, () => undefined).then(async () => {
      while (scope.tasks.size > 0) await Promise.allSettled([...scope.tasks]);
    });
    this.active.set(controller, drained);
    void drained.finally(() => {
      clearTimeout(timer);
      this.active.delete(controller);
    });
    try {
      return await operationStep(() => work, controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    for (const controller of this.active.keys()) {
      controller.abort(new OperationCancelledError("The bot is restarting. Please try again shortly.", "shutdown"));
    }
    await Promise.allSettled([...this.active.values()]);
  }
}
