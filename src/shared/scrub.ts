/**
 * The single place that knows what a secret looks like. Everything that prints to a person - logs, startup errors, command-line
 * tools, diagnostics - goes through it, so a new kind of output cannot invent its own (leaky) rule.
 */

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // Telegram bot tokens, also when embedded in api.telegram.org URLs (.../bot<token>/getMe, .../file/bot<token>/documents/file_1.pdf).
  // No leading \b: in URLs the token follows "bot" directly ("/bot123456:ABC...").
  [/\d{6,}:[A-Za-z0-9_-]{30,}/g, "[redacted-telegram-token]"],
  // OpenAI-style API keys (sk-..., sk-proj-...).
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "[redacted-api-key]"],
  [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]"],
  // The configuration variables themselves, as they appear in an .env line or a shell command (NAME=value). Only "=": the validation
  // messages read "NAME: Invalid input", where nothing is a secret and the text is what the operator needs.
  [/\b(TELEGRAM_BOT_TOKEN|OPENAI_API_KEY)(\s*=\s*)["']?[^\s"']+["']?/g, "$1$2[redacted]"],
];

/** Secrets that do not look like anything in particular (a key from a proxy, a test value): registered by value when the configuration is read. */
const registered = new Set<string>();
const MIN_REGISTERED_LENGTH = 8; // shorter values would also destroy ordinary words in the output

export function registerSecret(value: string | undefined) {
  if (value && value.length >= MIN_REGISTERED_LENGTH) {
    registered.add(value);
  }
}

/** For tests. */
export function clearRegisteredSecrets() {
  registered.clear();
}

/** Removes anything that looks like a bot token or API key - and every registered secret value - from free-form text. */
export function scrubSecrets(text: string) {
  let result = SECRET_PATTERNS.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), text);
  for (const secret of registered) {
    result = result.split(secret).join("[redacted]");
  }
  return result;
}

const MAX_DEPTH = 4;

/**
 * Scrubs every string inside a value (objects, arrays, errors), for data that is about to be printed as a whole - an error's
 * `cause`, a provider's response object, a `url` property. Returns a copy; cycles and depth are bounded.
 */
export function scrubDeep(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return scrubSecrets(value);
  if (value === null || typeof value !== "object") return value;
  if (value instanceof URL) return scrubSecrets(value.href);
  if (depth >= MAX_DEPTH || seen.has(value)) return "[truncated]";
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => scrubDeep(item, depth + 1, seen));

  const copy: Record<string, unknown> = {};
  for (const key of Object.getOwnPropertyNames(value)) {
    if (/^(authorization|cookie|set-cookie|x-api-key)$/i.test(key)) {
      copy[key] = "[redacted]";
      continue;
    }
    copy[key] = scrubDeep((value as Record<string, unknown>)[key], depth + 1, seen);
  }
  return copy;
}

/** The text of an error (and its causes) as safe to print: message only, no stack, secrets removed. */
export function describeErrorSafely(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? ` (caused by: ${describeErrorSafely(error.cause)})` : "";
    return `${scrubSecrets(error.message)}${cause}`;
  }
  return scrubSecrets(String(error));
}
