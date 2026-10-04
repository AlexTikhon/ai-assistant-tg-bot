/**
 * Expected application failures.
 *
 * The `message` of every AppError is safe to show to the end user. Technical details
 * (provider responses, SQL errors, ...) belong in `cause` and are only ever logged.
 */
export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string = "APP_ERROR",
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

/** The requested entity does not exist or does not belong to the user. */
export class NotFoundError extends AppError {
  constructor(message = "Document not found.") {
    super(message, "NOT_FOUND");
  }
}

/** The application cannot start: which stage failed ("database": open/migrate, "storage": the data directory). */
export class StartupError extends Error {
  constructor(
    readonly stage: "database" | "storage",
    cause: unknown,
  ) {
    super(`Startup failed at the ${stage} stage: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "StartupError";
  }
}

/** An upstream provider (OpenAI, Telegram file API) failed, timed out or answered garbage. */
export class ExternalServiceError extends AppError {
  constructor(
    public readonly service: string,
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
