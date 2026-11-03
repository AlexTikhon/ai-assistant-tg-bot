import type { Telegraf } from "telegraf";
import { botCommands } from "./ui/commands.js";

/**
 * Telegraf's onLaunch fires after getMe, BEFORE deleteWebhook and polling. Fence its public API
 * calls instead: cancellation during either startup await must never start a late poller.
 * The first getUpdates means polling has been entered, not that Telegram accepted it.
 */
export function launchPolling(bot: Telegraf, signal: AbortSignal, onPolling: () => void): Promise<void> {
  const original = bot.telegram.callApi;
  // Telegraf types name its legacy AbortSignal shim; node-fetch also accepts native signals.
  const transportSignal = signal as unknown as NonNullable<Parameters<typeof original>[2]>["signal"];
  let announced = false;
  const guarded = async (...[method, payload, options]: Parameters<typeof original>) => {
    signal.throwIfAborted();
    if (method === "getUpdates") {
      if (!announced) { announced = true; onPolling(); }
      // Telegraf owns the poll request's abort controller and stops it through bot.stop().
      return original.call(bot.telegram, method, payload, options);
    }
    const result = await original.call(bot.telegram, method, payload, { ...options, signal: transportSignal });
    signal.throwIfAborted(); // fence transports that ignore cancellation and eventually resolve
    return result;
  };
  // The generic method/result relationship is unchanged: every request is forwarded verbatim.
  bot.telegram.callApi = guarded as typeof original;

  return (async () => {
    try {
      signal.throwIfAborted();
      await bot.telegram.setMyCommands(botCommands);
      signal.throwIfAborted();
      await bot.launch(() => signal.throwIfAborted());
    } catch (error) {
      signal.throwIfAborted();
      throw error;
    } finally {
      bot.telegram.callApi = original;
    }
  })();
}
