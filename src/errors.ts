/**
 * Application errors.
 *
 * The split that matters: `userMessage` is safe to render, while `cause` and
 * the stack stay in the logs. That keeps error pages friendly without leaking
 * table names, paths, or library internals to whoever is poking at the app.
 */

export interface AppErrorOptions {
  status?: number;
  /** Short machine-readable tag for logs and tests. */
  code?: string;
  /** Per-field validation messages, keyed by form field name. */
  fields?: Record<string, string>;
  cause?: unknown;
}

export class AppError extends Error {
  readonly status: number;
  readonly userMessage: string;
  readonly code: string;
  readonly fields: Record<string, string> | undefined;

  constructor(userMessage: string, options: AppErrorOptions = {}) {
    super(userMessage, { cause: options.cause });
    this.name = 'AppError';
    this.userMessage = userMessage;
    this.status = options.status ?? 500;
    this.code = options.code ?? 'internal_error';
    this.fields = options.fields;
  }
}

export const badRequest = (message: string, options: AppErrorOptions = {}) =>
  new AppError(message, { status: 400, code: 'bad_request', ...options });

export const validationFailed = (fields: Record<string, string>, message = 'Please correct the highlighted fields.') =>
  new AppError(message, { status: 400, code: 'validation_failed', fields });

export const unauthorized = (message = 'Please sign in to continue.') =>
  new AppError(message, { status: 401, code: 'unauthorized' });

export const forbidden = (message = 'You do not have permission to do that.') =>
  new AppError(message, { status: 403, code: 'forbidden' });

export const notFound = (message = 'We could not find what you were looking for.') =>
  new AppError(message, { status: 404, code: 'not_found' });

export const conflict = (message: string, options: AppErrorOptions = {}) =>
  new AppError(message, { status: 409, code: 'conflict', ...options });

export const payloadTooLarge = (message: string) =>
  new AppError(message, { status: 413, code: 'payload_too_large' });

export const tooManyRequests = (message = 'Too many attempts. Please wait a moment and try again.') =>
  new AppError(message, { status: 429, code: 'too_many_requests' });

export const internalError = (cause: unknown, message = 'Something went wrong on our end. Please try again.') =>
  new AppError(message, { status: 500, code: 'internal_error', cause });

/** True when the value is safe to show the user verbatim. */
export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
