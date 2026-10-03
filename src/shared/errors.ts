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
