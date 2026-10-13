import { AsyncLocalStorage } from "node:async_hooks";
import { AppError } from "./errors.js";

export type OperationOptions = { signal?: AbortSignal };
type OperationContext = {
  signal: AbortSignal;
  tasks: Set<Promise<unknown>>;
  /** Run once, in order, when the operation has fully drained (see onOperationDrained). */
  drainCallbacks: Array<() => void>;
  drained: boolean;
};
const context = new AsyncLocalStorage<OperationContext>();

function runDrainCallbacks(scope: OperationContext) {
  scope.drained = true;
  for (const callback of scope.drainCallbacks.splice(0)) {
    try {
      callback();
    } catch {
      // A failing cleanup must not stop the others, and it must not turn drainage itself into a rejection.
    }
  }
}

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

/**
 * Registers `callback` to run exactly once when the current operation has drained: its handler has settled (returned, thrown, or
 * unwound after cancellation, compensation included) AND every provider task it started through operationStep has settled -
 * including providers that ignore the abort signal. This is when the operation's resources are really free, which is later than
 * the moment its caller got a result or a timeout. Returns false, registering nothing, when called outside an operation.
 */
export function onOperationDrained(callback: () => void): boolean {
  const scope = context.getStore();
  if (!scope) return false;
  if (scope.drained) callback();
  else scope.drainCallbacks.push(callback);
  return true;
}

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
    const scope: OperationContext = { signal: controller.signal, tasks: new Set(), drainCallbacks: [], drained: false };
    const work = context.run(scope, () => Promise.resolve().then(() => task(controller.signal)));
    const drained = work.then(() => undefined, () => undefined).then(async () => {
      while (scope.tasks.size > 0) await Promise.allSettled([...scope.tasks]);
      runDrainCallbacks(scope);
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
