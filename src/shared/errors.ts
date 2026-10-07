import { formatMegabytes } from "./utils/text.js";

/** Every code an AppError can carry. A closed list: the log writes a code only when it is one of these (see safe-error.ts). */
export const APP_ERROR_CODES = [
  "APP_ERROR",
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "INDEX_CHANGED",
  "EXTERNAL_SERVICE_ERROR",
  "RATE_LIMITED",
  "UPDATE_ADMISSION_FAILED",
  "SEARCH_BUSY",
  "OPERATION_CANCELLED",
] as const;
export type AppErrorCode = (typeof APP_ERROR_CODES)[number];

/** The upstream services an ExternalServiceError can be about. */
export const EXTERNAL_SERVICES = ["openai", "telegram", "embeddings", "search"] as const;
export type ExternalService = (typeof EXTERNAL_SERVICES)[number];

/**
 * Expected application failures.
 *
 * The `message` of every AppError is safe to show to the end user. Technical details
 * (provider responses, SQL errors, ...) belong in `cause` and are only ever logged.
 */
export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: AppErrorCode = "APP_ERROR",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The request is invalid and the user can fix it (bad file type, empty question, ...). */
export class ValidationError extends AppError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "VALIDATION_ERROR", options);
  }
}

/** The one message for an upload refused because of its size - from the Telegram download, ingestion and replacement alike. */
export function fileTooLargeError(maxBytes: number) {
  return new ValidationError(`The file is too large. The limit is ${formatMegabytes(maxBytes)}.`);
}

/** The requested entity does not exist or does not belong to the user. */
export class NotFoundError extends AppError {
  constructor(message = "Document not found.") {
    super(message, "NOT_FOUND");
  }
}

export class IndexChangedError extends AppError {
  constructor() {
    super("The document changed while its index was being prepared. Please retry.", "INDEX_CHANGED");
  }
}

/** The application cannot start: which stage failed ("database": open/migrate, "storage": the data directory). */
export class StartupError extends Error {
  constructor(
    readonly stage: "database" | "storage",
    cause: unknown,
    /** What the operator can do about it (e.g. verify a backup and restore it). Never contains data. */
    readonly advice?: string,
  ) {
    super(`Startup failed at the ${stage} stage: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "StartupError";
  }
}

/** An upstream provider (OpenAI, Telegram file API) failed, timed out or answered garbage. */
export class ExternalServiceError extends AppError {
  constructor(
    public readonly service: ExternalService,
    options?: ErrorOptions,
    message = "The AI service is temporarily unavailable. Please try again in a moment.",
  ) {
    super(message, "EXTERNAL_SERVICE_ERROR", options);
  }
}

/** The user sent too many expensive requests in a short time; they can simply try again later. */
export class RateLimitError extends AppError {
  constructor(public readonly retryAfterMs: number) {
    super(
      `You are sending requests too quickly. Please try again in ${Math.max(1, Math.ceil(retryAfterMs / 1000))} seconds.`,
      "RATE_LIMITED",
    );
  }
}
