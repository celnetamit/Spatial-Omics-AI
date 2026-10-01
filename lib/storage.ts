import { logger } from './logger';

/**
 * Namespaced, versioned `localStorage` with honest guarantees.
 *
 * It replaces a `secureStorage` module that AES-encrypted every value with a
 * key compiled into the bundle, and an admin panel that labelled the result
 * "Encrypted Storage". Anyone with the bundle had the key, so the encryption
 * bought nothing but a false claim — and a false claim about where a learner's
 * data is protected is worse than no claim. What is actually true is stated
 * plainly in the privacy notice: this data is unencrypted, stays in this
 * browser, and is readable by anything else running on this origin.
 *
 * Three real problems are handled instead of the imaginary one:
 *  - reads never throw, so a corrupt or hand-edited entry degrades to the
 *    default rather than white-screening the app on mount;
 *  - writes never throw, so Safari private mode and a full quota do not turn
 *    "save this snippet" into an unhandled rejection;
 *  - entries carry a schema version, so a shape change skips stale data
 *    instead of crashing on it.
 */

const NAMESPACE = 'logiclab';
const SCHEMA_VERSION = 2;

interface Envelope<T> {
  v: number;
  data: T;
}

function fullKey(key: string): string {
  return `${NAMESPACE}:${key}`;
}

function isEnvelope<T>(value: unknown): value is Envelope<T> {
  return typeof value === 'object' && value !== null && 'v' in value && 'data' in value;
}

export const storage = {
  get<T>(key: string, fallback: T): T {
    let raw: string | null;
    try {
      raw = localStorage.getItem(fullKey(key));
    } catch {
      // Storage disabled entirely (private mode, blocked cookies).
      return fallback;
    }
    if (raw === null) return fallback;

    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isEnvelope<T>(parsed)) return fallback;
      if (parsed.v !== SCHEMA_VERSION) {
        logger.info('Discarding storage entry from an older schema', { key, found: parsed.v });
        return fallback;
      }
      return parsed.data;
    } catch {
      logger.warn('Unreadable storage entry discarded', { key });
      return fallback;
    }
  },

  /** Returns false when the value could not be persisted, so callers can say so. */
  set<T>(key: string, value: T): boolean {
    try {
      const envelope: Envelope<T> = { v: SCHEMA_VERSION, data: value };
      localStorage.setItem(fullKey(key), JSON.stringify(envelope));
      return true;
    } catch (error) {
      // QuotaExceededError is the realistic case: a learner with a few hundred
      // saved snippets, or a browser with a very small per-origin budget.
      logger.warn('Could not write to local storage', {
        key,
        reason: error instanceof Error ? error.name : 'unknown',
      });
      return false;
    }
  },

  remove(key: string): void {
    try {
      localStorage.removeItem(fullKey(key));
    } catch {
      /* nothing actionable */
    }
  },

  /** Everything this lab has stored, for the "clear my data" control. */
  clearAll(): void {
    try {
      const prefix = `${NAMESPACE}:`;
      const doomed = Object.keys(localStorage).filter((k) => k.startsWith(prefix));
      doomed.forEach((k) => localStorage.removeItem(k));
    } catch {
      /* nothing actionable */
    }
  },
};

export const StorageKeys = {
  snippets: 'snippets',
  progress: 'progress',
  assessment: 'assessment-history',
  tutorHistory: 'tutor-history',
  lastGenerator: 'generator-draft',
} as const;
