export function mainKeyboard() {
  return {
    keyboard: [[{ text: "/list" }, { text: "/help" }]],
    resize_keyboard: true,
  };
}

/**
 * A thumbs-up / thumbs-down under an answer. The callback data carries only the short request id of the answer
 * ("fb:g:<id>" / "fb:b:<id>", well under Telegram's 64 bytes); the rating is stored together with what the
 * confidence gate decided for that answer. Never any question or answer text.
 */
export function feedbackKeyboard(requestId: string) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "👍", callback_data: `fb:g:${requestId}` },
          { text: "👎", callback_data: `fb:b:${requestId}` },
        ],
      ],
    },
  };
}
