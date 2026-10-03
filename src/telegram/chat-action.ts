import type { Context } from "telegraf";

type ChatAction = Parameters<Context["sendChatAction"]>[0];

/** Telegram clears the "typing..." indicator after ~5 seconds, so it has to be refreshed. */
const REFRESH_INTERVAL_MS = 4000;

/** Shows a chat action (typing, upload_document, ...) for as long as `task` is running. */
export async function withChatAction<T>(ctx: Context, action: ChatAction, task: () => Promise<T>) {
  const send = () => {
    ctx.sendChatAction(action).catch(() => undefined);
  };

  send();
  const timer = setInterval(send, REFRESH_INTERVAL_MS);

  try {
    return await task();
  } finally {
    clearInterval(timer);
  }
}
