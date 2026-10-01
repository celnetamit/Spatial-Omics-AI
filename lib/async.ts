import { AppError } from './errors';

/** Promise-based sleep that rejects promptly when the signal aborts. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AppError('Request cancelled.', { code: 'ABORTED', retryable: false }));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AppError('Request cancelled.', { code: 'ABORTED', retryable: false }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Combines caller cancellation with a hard deadline.
 *
 * `dispose()` MUST be called in a `finally` — without it the timer keeps the
 * controller (and everything it closes over) alive, a slow leak in a long-lived
 * single-page app.
 */
export function withTimeout(
  timeoutMs: number,
  signal?: AbortSignal,
): { signal: AbortSignal; dispose: () => void; timedOut: () => boolean } {
  const controller = new AbortController();
  let didTimeout = false;

  const timer = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, timeoutMs);

  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  return {
    signal: controller.signal,
    timedOut: () => didTimeout,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onExternalAbort);
    },
  };
}
