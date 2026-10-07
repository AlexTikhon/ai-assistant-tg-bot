import { types } from "node:util";
import { APP_ERROR_CODES, EXTERNAL_SERVICES, StartupError } from "./errors.js";

/**
 * The only form in which an error reaches a log line (see "What may be logged" in docs/security.md).
 *
 * An error object is not a log record: SDK errors carry the request that failed (a Telegraf `TelegramError` holds the outgoing
 * answer and the chat id), providers echo input in descriptions, and every free-form `message` or `stack` can repeat a user's
 * text. Truncating or secret-scrubbing such text does not make it safe, so none of it is copied. What is written is a small,
 * bounded projection made only of values taken from a finite vocabulary (a category, a known type name, a known code, a known
 * service or Telegram method) or of numbers that were range-checked. Anything else - unknown names and codes, messages, stacks,
 * descriptions, payloads, headers, urls, paths, identifiers, other properties - is dropped, not shortened.
 *
 * The projection reads data properties only: it never calls a getter, `toJSON`, `toString` or any method of the error, and it
 * never enumerates an object, so a hostile or huge error costs the same as a small one and cannot make the logger throw.
 */

export type ErrorCategory = "application" | "external" | "network" | "storage" | "startup" | "cancellation" | "unknown";

export type SafeError = {
  category: ErrorCategory;
  /** A known error class name (see KNOWN_TYPES), or the kind of a thrown non-error value ("string", "object", ...). */
  type: string;
  /** A known application, SQLite, network, file-system or provider error code. */
  code?: string;
  /** The provider an ExternalServiceError is about (a finite list). */
  service?: string;
  /** The Telegram Bot API method a TelegramError was calling (the methods this application uses). */
  method?: string;
  /** An HTTP / Telegram status of 100-599. */
  status?: number;
  /** A provider-requested wait, in whole seconds (at most a day). */
  retryAfterSec?: number;
  /** The startup stage of a StartupError or ConfigError. */
  stage?: string;
  /** Why an operation was cancelled. */
  reason?: string;
  cause?: SafeError | TruncatedCause;
};

/** Where a cause chain stops: it came back to an error already shown, or it is deeper than MAX_CAUSE_DEPTH. */
export type TruncatedCause = { truncated: "cycle" | "depth" };

/** An error shows its cause, that error's cause, and so on, this many levels deep. */
export const MAX_CAUSE_DEPTH = 5;
const MAX_RETRY_AFTER_SEC = 24 * 60 * 60;
const MAX_PROTOTYPE_HOPS = 8;

const KNOWN_TYPES = new Set([
  // JavaScript and the platform
  "Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError", "AggregateError", "AbortError", "TimeoutError",
  // this application
  "AppError", "ValidationError", "NotFoundError", "IndexChangedError", "ExternalServiceError", "RateLimitError", "OperationCancelledError", "StartupError", "ConfigError",
  "HttpStatusError", "RestoreError", "VectorError", "InvalidUpdateIdentityError",
  // libraries
  "TelegramError", "SqliteError", "ZodError", "OpenAIError", "APIError", "APIConnectionError", "APIConnectionTimeoutError", "APIUserAbortError", "AuthenticationError",
  "BadRequestError", "ConflictError", "InternalServerError", "PermissionDeniedError", "UnprocessableEntityError",
]);

/** The OpenAI SDK's error classes: they carry `status` and a provider `code`. (RateLimitError and NotFoundError are shared with this application's own.) */
const OPENAI_TYPES = new Set([
  "OpenAIError", "APIError", "APIConnectionError", "APIConnectionTimeoutError", "AuthenticationError", "BadRequestError", "ConflictError", "InternalServerError",
  "PermissionDeniedError", "UnprocessableEntityError",
]);

const APP_CODES = new Set<string>(APP_ERROR_CODES);
const SERVICES = new Set<string>(EXTERNAL_SERVICES);
const STAGES = new Set(["config", "database", "storage"]);
const CANCEL_REASONS = new Set(["timeout", "shutdown"]);

/** The Bot API methods this application calls (Telegraf's `ctx.reply`, `answerCbQuery`, `telegram.getFileLink`, ... and its startup calls). */
const TELEGRAM_METHODS = new Set([
  "sendMessage", "sendChatAction", "answerCallbackQuery", "editMessageReplyMarkup", "editMessageText", "deleteMessage", "getFile", "getMe", "getUpdates", "setMyCommands", "deleteWebhook",
]);

const SQLITE_CODES = new Set([
  "SQLITE_ERROR", "SQLITE_INTERNAL", "SQLITE_PERM", "SQLITE_ABORT", "SQLITE_BUSY", "SQLITE_LOCKED", "SQLITE_NOMEM", "SQLITE_READONLY", "SQLITE_INTERRUPT", "SQLITE_IOERR",
  "SQLITE_CORRUPT", "SQLITE_NOTFOUND", "SQLITE_FULL", "SQLITE_CANTOPEN", "SQLITE_PROTOCOL", "SQLITE_EMPTY", "SQLITE_SCHEMA", "SQLITE_TOOBIG", "SQLITE_CONSTRAINT",
  "SQLITE_MISMATCH", "SQLITE_MISUSE", "SQLITE_NOLFS", "SQLITE_AUTH", "SQLITE_FORMAT", "SQLITE_RANGE", "SQLITE_NOTADB",
  "SQLITE_BUSY_RECOVERY", "SQLITE_BUSY_SNAPSHOT", "SQLITE_BUSY_TIMEOUT", "SQLITE_LOCKED_SHAREDCACHE", "SQLITE_READONLY_RECOVERY", "SQLITE_READONLY_CANTLOCK",
  "SQLITE_READONLY_ROLLBACK", "SQLITE_READONLY_DBMOVED", "SQLITE_READONLY_DIRECTORY", "SQLITE_IOERR_READ", "SQLITE_IOERR_SHORT_READ", "SQLITE_IOERR_WRITE",
  "SQLITE_IOERR_FSYNC", "SQLITE_IOERR_DIR_FSYNC", "SQLITE_IOERR_TRUNCATE", "SQLITE_IOERR_FSTAT", "SQLITE_IOERR_UNLOCK", "SQLITE_IOERR_RDLOCK", "SQLITE_IOERR_DELETE",
  "SQLITE_IOERR_ACCESS", "SQLITE_IOERR_CHECKRESERVEDLOCK", "SQLITE_IOERR_LOCK", "SQLITE_IOERR_CLOSE", "SQLITE_IOERR_NOMEM", "SQLITE_CORRUPT_VTAB", "SQLITE_CORRUPT_SEQUENCE",
  "SQLITE_CORRUPT_INDEX", "SQLITE_CANTOPEN_NOTEMPDIR", "SQLITE_CANTOPEN_ISDIR", "SQLITE_CANTOPEN_FULLPATH", "SQLITE_CANTOPEN_CONVPATH", "SQLITE_CONSTRAINT_CHECK",
  "SQLITE_CONSTRAINT_COMMITHOOK", "SQLITE_CONSTRAINT_FOREIGNKEY", "SQLITE_CONSTRAINT_FUNCTION", "SQLITE_CONSTRAINT_NOTNULL", "SQLITE_CONSTRAINT_PRIMARYKEY",
  "SQLITE_CONSTRAINT_TRIGGER", "SQLITE_CONSTRAINT_UNIQUE", "SQLITE_CONSTRAINT_VTAB", "SQLITE_CONSTRAINT_ROWID",
]);

const NETWORK_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "EPROTO", "ENETUNREACH", "ENETDOWN", "EHOSTUNREACH", "EHOSTDOWN",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_ABORTED", "UND_ERR_CLOSED", "UND_ERR_DESTROYED",
  "UND_ERR_REQ_CONTENT_LENGTH_MISMATCH", "UND_ERR_RES_CONTENT_LENGTH_MISMATCH", "UND_ERR_INVALID_ARG", "ERR_SOCKET_CONNECTION_TIMEOUT",
  "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "DEPTH_ZERO_SELF_SIGNED_CERT", "ERR_TLS_CERT_ALTNAME_INVALID",
]);

const FILE_SYSTEM_CODES = new Set([
  "ENOENT", "EACCES", "EPERM", "EEXIST", "ENOSPC", "EMFILE", "ENFILE", "EISDIR", "ENOTDIR", "EBUSY", "EROFS", "EIO", "ENOTEMPTY", "EXDEV", "EINVAL", "ENAMETOOLONG", "ELOOP", "EDQUOT",
]);

const CANCELLATION_CODES = new Set(["ABORT_ERR", "ERR_CANCELED"]);

/** Provider codes (the OpenAI API's `code` field) that name a condition and nothing else. */
const PROVIDER_CODES = new Set([
  "invalid_api_key", "rate_limit_exceeded", "insufficient_quota", "model_not_found", "context_length_exceeded", "server_error", "invalid_request_error", "billing_not_active",
]);

/** Which category a code of each vocabulary stands for. */
function codeCategory(code: string): ErrorCategory | undefined {
  if (APP_CODES.has(code)) return code === "OPERATION_CANCELLED" ? "cancellation" : code === "EXTERNAL_SERVICE_ERROR" ? "external" : "application";
  if (SQLITE_CODES.has(code) || FILE_SYSTEM_CODES.has(code)) return "storage";
  if (NETWORK_CODES.has(code)) return "network";
  if (CANCELLATION_CODES.has(code)) return "cancellation";
  if (PROVIDER_CODES.has(code)) return "external";
  return undefined;
}

const isKnownCode = (code: string) => codeCategory(code) !== undefined;

/**
 * A data property of `target`, own or inherited. Accessors are never called (a getter is code of unknown origin, and
 * `TelegramError.code` is one), a failing Proxy trap counts as "absent", and the prototype walk is bounded.
 */
function readData(target: unknown, key: string): unknown {
  if (target === null || (typeof target !== "object" && typeof target !== "function")) return undefined;
  try {
    let current: object | null = target;
    for (let hop = 0; current !== null && hop < MAX_PROTOTYPE_HOPS; hop += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor) return "value" in descriptor ? descriptor.value : undefined;
      current = Object.getPrototypeOf(current);
    }
  } catch {
    // A hostile Proxy: treat the property as missing.
  }
  return undefined;
}

function isError(value: unknown): boolean {
  try {
    return value instanceof Error || types.isNativeError(value);
  } catch {
    return false;
  }
}

function isInstance(value: unknown, constructor: abstract new (...args: never[]) => unknown): boolean {
  try {
    return value instanceof constructor;
  } catch {
    return false;
  }
}

/**
 * The class name, when it is a known one. The `name` property is not enough: Telegraf's and the OpenAI SDK's errors leave it at
 * "Error" and only their class is named, so the more specific of `name` and the constructor's name wins.
 */
function knownTypeOf(error: unknown): string | undefined {
  let generic: string | undefined;
  for (const candidate of [readData(error, "name"), readData(readData(error, "constructor"), "name")]) {
    if (typeof candidate !== "string" || !KNOWN_TYPES.has(candidate)) continue;
    if (candidate !== "Error") return candidate;
    generic = candidate;
  }
  return generic;
}

function integerInRange(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : undefined;
}

function statusOf(error: unknown): number | undefined {
  const response = readData(error, "response");
  for (const candidate of [readData(error, "status"), readData(error, "statusCode"), readData(response, "error_code"), readData(response, "status")]) {
    const status = integerInRange(candidate, 100, 599);
    if (status !== undefined) return status;
  }
  return undefined;
}

function retryAfterSecOf(error: unknown): number | undefined {
  const fromTelegram = integerInRange(readData(readData(readData(error, "response"), "parameters"), "retry_after"), 0, MAX_RETRY_AFTER_SEC);
  if (fromTelegram !== undefined) return fromTelegram;
  const ms = readData(error, "retryAfterMs");
  return typeof ms === "number" && Number.isFinite(ms) && ms >= 0 && ms <= MAX_RETRY_AFTER_SEC * 1000 ? Math.ceil(ms / 1000) : undefined;
}

/** The error's own `code`, only when it belongs to one of the known vocabularies above. */
function codeOf(error: unknown): string | undefined {
  const code = readData(error, "code");
  return typeof code === "string" && isKnownCode(code) ? code : undefined;
}

function projectError(error: unknown): SafeError {
  const type = knownTypeOf(error) ?? (isInstance(error, StartupError) ? "StartupError" : "Error");
  const code = codeOf(error);
  const service = readData(error, "service");
  const status = statusOf(error);

  let category: ErrorCategory;
  if (type === "StartupError" || type === "ConfigError") category = "startup";
  else if (type === "OperationCancelledError" || type === "AbortError" || type === "APIUserAbortError") category = "cancellation";
  else if (type === "APIConnectionError" || type === "APIConnectionTimeoutError" || type === "TimeoutError") category = "network";
  else if (type === "ExternalServiceError" || type === "TelegramError" || type === "HttpStatusError" || OPENAI_TYPES.has(type)) category = "external";
  else if (type === "SqliteError" || type === "RestoreError") category = "storage";
  else if (code !== undefined) category = codeCategory(code) ?? "unknown";
  // The OpenAI SDK reuses two names of this application's own errors; those have a code (above), the SDK's may have only a status.
  else if (type === "RateLimitError" || type === "NotFoundError") category = status === undefined ? "application" : "external";
  else if (type === "AppError" || type === "ValidationError" || type === "IndexChangedError") category = "application";
  else category = "unknown";

  const projected: SafeError = { category, type };
  if (code !== undefined) projected.code = code;

  if (type === "ExternalServiceError" && typeof service === "string" && SERVICES.has(service)) projected.service = service;
  if (type === "TelegramError") {
    projected.service = "telegram";
    const method = readData(readData(error, "on"), "method");
    if (typeof method === "string" && TELEGRAM_METHODS.has(method)) projected.method = method;
  } else if (OPENAI_TYPES.has(type) || (code !== undefined && PROVIDER_CODES.has(code))) {
    projected.service = "openai";
  }

  if (status !== undefined) projected.status = status;
  const retryAfterSec = retryAfterSecOf(error);
  if (retryAfterSec !== undefined) projected.retryAfterSec = retryAfterSec;

  const stage = readData(error, "stage");
  if ((type === "StartupError" || type === "ConfigError") && typeof stage === "string" && STAGES.has(stage)) projected.stage = stage;
  const reason = readData(error, "kind");
  if (type === "OperationCancelledError" && typeof reason === "string" && CANCEL_REASONS.has(reason)) projected.reason = reason;

  return projected;
}

/** "string", "object", "array", ... - the kind of a thrown value that is not an Error. Nothing of the value itself. */
function kindOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function project(value: unknown, depth: number, seen: WeakSet<object>): SafeError | TruncatedCause {
  const isObject = (typeof value === "object" && value !== null) || typeof value === "function";
  if (isObject) {
    if (seen.has(value)) return { truncated: "cycle" };
    if (depth > MAX_CAUSE_DEPTH) return { truncated: "depth" };
    seen.add(value);
  }
  if (!isError(value)) return { category: "unknown", type: kindOf(value) };

  const projected = projectError(value);
  const cause = readData(value, "cause");
  if (cause !== undefined) projected.cause = project(cause, depth + 1, seen);
  return projected;
}

/** The loggable form of anything that was thrown. Never throws, never walks more than MAX_CAUSE_DEPTH + 1 errors. */
export function toSafeError(error: unknown): SafeError | TruncatedCause {
  try {
    return project(error, 0, new WeakSet());
  } catch {
    return { category: "unknown", type: "unserializable" };
  }
}
