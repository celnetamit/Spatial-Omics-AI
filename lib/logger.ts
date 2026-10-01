import { appConfig } from './config';

/**
 * Thin logging façade. Production builds ship at `warn`, so debug chatter costs
 * nothing at runtime, and there is one seam to wire a real sink into later.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<Level | 'silent', number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

const threshold = LEVEL_RANK[appConfig.logLevel];

export type LogSink = (level: Level, message: string, context?: Record<string, unknown>) => void;

let externalSink: LogSink | null = null;

export function setLogSink(sink: LogSink | null): void {
  externalSink = sink;
}

function emit(level: Level, message: string, context?: Record<string, unknown>): void {
  if (LEVEL_RANK[level] >= threshold) {
    const method = level === 'debug' ? 'log' : level;
    if (context) console[method](`[spatial-ai:${level}]`, message, context);
    else console[method](`[spatial-ai:${level}]`, message);
  }

  if (externalSink && LEVEL_RANK[level] >= LEVEL_RANK.warn) {
    try {
      externalSink(level, message, context);
    } catch {
      /* a failing telemetry sink must never break the app */
    }
  }
}

export const logger = {
  debug: (message: string, context?: Record<string, unknown>) => emit('debug', message, context),
  info: (message: string, context?: Record<string, unknown>) => emit('info', message, context),
  warn: (message: string, context?: Record<string, unknown>) => emit('warn', message, context),
  error: (message: string, context?: Record<string, unknown>) => emit('error', message, context),
};
