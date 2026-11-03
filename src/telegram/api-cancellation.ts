import type { Context } from "telegraf";

type TransportSignal = NonNullable<NonNullable<Parameters<Context["telegram"]["callApi"]>[2]>["signal"]>;

/** Bridge Telegraf's legacy abort-controller signal and the native operation signal without losing either. */
export async function withTelegramSignal<T>(signal: AbortSignal, previous: TransportSignal | undefined, task: (signal: TransportSignal) => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  if (!previous) return task(signal as unknown as TransportSignal);
  const controller = new AbortController();
  const abort = () => controller.abort(signal.aborted ? signal.reason : undefined);
  signal.addEventListener("abort", abort, { once: true });
  previous.addEventListener("abort", abort, { once: true });
  if (signal.aborted || previous.aborted) abort();
  try { return await task(controller.signal as unknown as TransportSignal); }
  finally {
    signal.removeEventListener("abort", abort);
    previous.removeEventListener("abort", abort);
  }
}
