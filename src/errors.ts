export type ValidationPathSegment = string | number;

export interface ValidationIssue {
  readonly path: readonly ValidationPathSegment[];
  readonly message: string;
  readonly expected?: string;
  readonly received?: string;
}

export interface FrameworkErrorOptions {
  readonly details?: unknown;
  readonly cause?: unknown;
}

export class FrameworkError extends Error {
  readonly code: string;
  readonly details: unknown;

  constructor(code: string, message: string, options: FrameworkErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.details = options.details;
  }
}

export class NotFound extends FrameworkError {
  constructor(message = "Resource not found", options: FrameworkErrorOptions = {}) {
    super("NOT_FOUND", message, options);
  }
}

export class Unauthorized extends FrameworkError {
  constructor(message = "Authentication required", options: FrameworkErrorOptions = {}) {
    super("UNAUTHORIZED", message, options);
  }
}

export class Forbidden extends FrameworkError {
  constructor(message = "Access forbidden", options: FrameworkErrorOptions = {}) {
    super("FORBIDDEN", message, options);
  }
}

export class InvalidInput extends FrameworkError {
  readonly issues: readonly ValidationIssue[];

  constructor(message = "Invalid input", issues: readonly ValidationIssue[] = [], options: FrameworkErrorOptions = {}) {
    super("INVALID_INPUT", message, {
      details: { issues, context: options.details },
      cause: options.cause,
    });
    this.issues = issues;
  }
}

export class Conflict extends FrameworkError {
  constructor(message = "Resource conflict", options: FrameworkErrorOptions = {}) {
    super("CONFLICT", message, options);
  }
}

export class Unavailable extends FrameworkError {
  constructor(message = "Service unavailable", options: FrameworkErrorOptions = {}) {
    super("UNAVAILABLE", message, options);
  }
}

export class Unexpected extends FrameworkError {
  constructor(message = "Unexpected framework error", options: FrameworkErrorOptions = {}) {
    super("UNEXPECTED", message, options);
  }
}

export function normalizeError(error: unknown): FrameworkError {
  if (error instanceof FrameworkError) {
    return error;
  }

  return new Unexpected(undefined, { cause: error });
}
