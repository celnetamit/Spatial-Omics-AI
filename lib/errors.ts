/**
 * A small error taxonomy so the UI can react to *why* something failed rather
 * than pattern-matching on message strings.
 *
 * This matters specifically here. The previous provider layer caught every
 * failure and returned a plausible-looking value — `chatWithTutor` answered
 * "I seem to be offline. Please check your connection." as a *successful*
 * assistant turn, so a rate-limited key looked to the learner like the tutor
 * had opinions about their network. Errors must stay distinguishable from
 * results all the way to the surface that renders them.
 */

export type AppErrorCode =
  | 'CONFIG'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'RATE_LIMIT'
  | 'UPSTREAM'
  | 'BAD_REQUEST'
  | 'AUTH'
  | 'BAD_RESPONSE'
  | 'UNSUPPORTED'
  | 'ABORTED'
  | 'UNKNOWN';

export interface AppErrorOptions {
  code?: AppErrorCode;
  cause?: unknown;
  retryable?: boolean;
  retryAfterSeconds?: number;
  status?: number;
}

const RETRYABLE_CODES = new Set<AppErrorCode>(['NETWORK', 'TIMEOUT', 'RATE_LIMIT', 'UPSTREAM']);

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | undefined;
  readonly status: number | undefined;

  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = options.code ?? 'UNKNOWN';
    this.retryable = options.retryable ?? RETRYABLE_CODES.has(this.code);
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.status = options.status;
  }
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof AppError) return error.code === 'ABORTED';
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return error.name === 'AbortError';
  }
  return error instanceof Error && error.name === 'AbortError';
}

export function codeForStatus(status: number): AppErrorCode {
  if (status === 401 || status === 403) return 'AUTH';
  if (status === 429) return 'RATE_LIMIT';
  if (status >= 500) return 'UPSTREAM';
  if (status >= 400) return 'BAD_REQUEST';
  return 'UNKNOWN';
}

/** Normalises anything thrown by an SDK, `fetch`, or our own code. */
export function toAppError(error: unknown, fallbackMessage: string): AppError {
  if (error instanceof AppError) return error;
  if (isAbortError(error)) {
    return new AppError('Request cancelled.', { code: 'ABORTED', retryable: false, cause: error });
  }

  const message = error instanceof Error ? error.message : String(error ?? '');
  const lower = message.toLowerCase();

  // The GenAI SDK surfaces transport failures as plain Errors with the status
  // embedded in the message; this is the only reliable classification hook.
  const statusMatch = /\b(4\d{2}|5\d{2})\b/.exec(message);
  const status = statusMatch?.[1] ? Number.parseInt(statusMatch[1], 10) : undefined;

  let code: AppErrorCode = 'UNKNOWN';
  if (lower.includes('api key') || lower.includes('api_key') || lower.includes('not configured')) {
    code = 'CONFIG';
  } else if (
    lower.includes('quota') ||
    lower.includes('rate limit') ||
    lower.includes('resource_exhausted')
  ) {
    code = 'RATE_LIMIT';
  } else if (
    lower.includes('failed to fetch') ||
    lower.includes('networkerror') ||
    lower.includes('load failed')
  ) {
    code = 'NETWORK';
  } else if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('deadline')) {
    code = 'TIMEOUT';
  } else if (lower.includes('not implemented') || lower.includes('not supported')) {
    code = 'UNSUPPORTED';
  } else if (status !== undefined) {
    code = codeForStatus(status);
  }

  const options: AppErrorOptions = { code, cause: error };
  if (status !== undefined) options.status = status;

  return new AppError(message || fallbackMessage, options);
}

/** Operator detail stays in `error.message`; this is what a learner reads. */
export function userFacingMessage(error: unknown): string {
  const appError = error instanceof AppError ? error : toAppError(error, 'Something went wrong.');

  switch (appError.code) {
    case 'CONFIG':
      return 'The AI assistant is not configured for this deployment. The analyser, linter and reference library still work — only generation and the tutor are unavailable.';
    case 'NETWORK':
      return 'Could not reach the AI service. Check your connection and try again.';
    case 'TIMEOUT':
      return 'The model took too long and the request was stopped. Try again, or shorten the design you pasted in.';
    case 'RATE_LIMIT':
      return appError.retryAfterSeconds
        ? `Rate limit reached. Please retry in about ${appError.retryAfterSeconds} seconds.`
        : 'Rate limit reached — this often happens when a whole workshop generates at once. Wait a moment and try again.';
    case 'UPSTREAM':
      return 'The AI service is temporarily unavailable. Please try again shortly.';
    case 'AUTH':
      return 'This session is not authorised for that request. Please sign in again.';
    case 'BAD_RESPONSE':
      return 'The model returned a response this lab could not read. Please try again.';
    case 'UNSUPPORTED':
      return appError.message || 'The configured AI provider does not support this operation.';
    case 'BAD_REQUEST':
      return appError.message || 'The request was rejected by the AI service.';
    case 'ABORTED':
      return 'Request cancelled.';
    default:
      return appError.message || 'An unexpected error occurred.';
  }
}
