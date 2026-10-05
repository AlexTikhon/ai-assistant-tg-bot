import { throwIfCancelled } from "./operation.js";

/**
 * Runs async tasks that share a key strictly one after another (FIFO); tasks with different keys
 * run concurrently. A failing task rejects only its own caller. Finished keys are forgotten.
 *
 * In-process only - which is all this single-process bot needs.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  /** Number of keys with a task running or waiting (for tests and diagnostics). */
  get activeKeys() {
    return this.tails.size;
  }

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const invoke = () => { throwIfCancelled(); return task(); };
    const result = previous.then(invoke, invoke);
    const tail = result.catch(() => undefined);

    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    });

    // Keep the actual task attached to its caller so shutdown can join storage writes/compensation.
    // The enclosing operation owns the deadline race; queued tasks check cancellation before starting.
    return result;
  }
}
