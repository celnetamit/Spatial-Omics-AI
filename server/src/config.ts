/**
 * Server configuration, read once from the environment at startup and frozen.
 *
 * Everything the server needs is runtime, not build-time. That is an
 * operational decision with a specific consequence worth stating: a hub URL, an
 * AI key, the model pack path or the run concurrency can be changed on a
 * container and take effect on restart, without rebuilding an image. Only the
 * client's portal links are baked in, because the client is a static bundle and
 * the sign-in screen needs somewhere to point before it has spoken to anything.
 */

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function str(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

function int(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function bool(value: string | undefined, fallback: boolean): boolean {
  const normalised = value?.trim().toLowerCase();
  if (normalised === 'true' || normalised === '1' || normalised === 'yes') return true;
  if (normalised === 'false' || normalised === '0' || normalised === 'no') return false;
  return fallback;
}

const env = process.env;

/**
 * A secret that lasts the life of the process when none is supplied.
 *
 * Refusing to start would take a deployment down that never needed sessions to
 * survive a restart; a fixed default would be worse, because every deployment
 * would share it. Generating one and warning loudly leaves a single visible
 * consequence, stated at boot: sessions do not survive a restart.
 */
function sessionSecret(): { value: string; generated: boolean } {
  const supplied = env.SPATIAL_SESSION_SECRET?.trim();
  if (supplied && supplied.length >= 32) return { value: supplied, generated: false };
  return { value: randomBytes(32).toString('hex'), generated: true };
}

const secret = sessionSecret();

export const config = Object.freeze({
  port: int(env.PORT, 3000, 1, 65_535),
  host: str(env.HOST, '0.0.0.0'),
  nodeEnv: str(env.NODE_ENV, 'production'),
  isProduction: str(env.NODE_ENV, 'production') === 'production',

  staticRoot: resolve(str(env.SPATIAL_STATIC_ROOT, 'dist/public')),
  contentRoot: resolve(str(env.SPATIAL_CONTENT_ROOT, 'content')),
  dataRoot: resolve(str(env.SPATIAL_DATA_ROOT, 'data')),

  session: Object.freeze({
    secret: secret.value,
    secretWasGenerated: secret.generated,
    ttlMs: int(env.SPATIAL_SESSION_TTL_MS, 8 * 60 * 60 * 1000, 60_000, 7 * 24 * 60 * 60 * 1000),
  }),

  auth: Object.freeze({
    enabled: bool(env.SPATIAL_AUTH_ENABLED, true),
    verifyUrl: str(env.LAB_AUTH_VERIFY_URL, 'https://live-labs.org/api/auth/authorize-lab'),
    loginUrl: str(env.LAB_LOGIN_URL, 'https://live-labs.org/login'),
    homeUrl: str(env.LAB_HOME_URL, 'https://live-labs.org/labs'),
    labSlug: str(env.LAB_SLUG, 'spatial-ai'),
    verifyTimeoutMs: int(env.LAB_AUTH_TIMEOUT_MS, 15_000, 1_000, 60_000),
    /** Development only; ignored in production so a mis-set variable is inert. */
    devBypassRole: str(env.SPATIAL_DEV_ROLE, ''),
  }),

  runs: Object.freeze({
    /**
     * Concurrent scientific jobs.
     *
     * One by default. A propagation run on a 2,400-cell section holds a few
     * hundred megabytes of per-stage state, and two of them on a small
     * container is how the process gets killed by the OOM reaper mid-run —
     * which looks to the user like the lab silently losing their work.
     */
    concurrency: int(env.SPATIAL_RUN_CONCURRENCY, 1, 1, 8),
    maxQueued: int(env.SPATIAL_RUN_QUEUE, 32, 1, 512),
    hardTimeoutMs: int(env.SPATIAL_RUN_TIMEOUT_MS, 300_000, 5_000, 3_600_000),
    /** Per-user runs allowed per hour. */
    rateLimitPerHour: int(env.SPATIAL_RATE_LIMIT, 60, 1, 1000),
    /** Largest dataset a non-admin may upload, in cells. */
    maximumObservations: int(env.SPATIAL_MAX_OBSERVATIONS, 20_000, 100, 500_000),
    maximumFeatures: int(env.SPATIAL_MAX_FEATURES, 4_000, 5, 60_000),
    /** Upload size ceiling, in megabytes. */
    maximumUploadMb: int(env.SPATIAL_MAX_UPLOAD_MB, 64, 1, 1024),
    /** Rescue simulations launched per run. */
    maximumRescueCandidates: int(env.SPATIAL_MAX_RESCUE, 8, 1, 32),
  }),

  ai: Object.freeze({
    enabled: bool(env.SPATIAL_AI_ENABLED, false),
    provider: str(env.SPATIAL_AI_PROVIDER, 'gemini'),
    apiKey: str(env.GEMINI_API_KEY || env.SPATIAL_AI_KEY, ''),
    model: str(env.SPATIAL_AI_MODEL, 'gemini-3.7-flash'),
    /** An OpenAI-compatible gateway, used instead of the provider when set. */
    baseUrl: str(env.SPATIAL_AI_BASE_URL, ''),
    timeoutMs: int(env.SPATIAL_AI_TIMEOUT_MS, 45_000, 1_000, 180_000),
    promptVersion: str(env.SPATIAL_AI_PROMPT_VERSION, 'interpretation-prompt-1.0'),
    policyVersion: str(env.SPATIAL_AI_POLICY_VERSION, 'ai-policy-1.0'),
    rateLimitPerHour: int(env.SPATIAL_AI_RATE_LIMIT, 40, 1, 500),
  }),

  research: Object.freeze({
    exportsEnabled: bool(env.SPATIAL_RESEARCH_EXPORTS, false),
    pseudonymSalt: str(env.SPATIAL_PSEUDONYM_SALT, secret.value),
    retentionDays: int(env.SPATIAL_RETENTION_DAYS, 365, 1, 3650),
  }),

  version: str(env.SPATIAL_VERSION, '1.0.0'),
  commit: buildCommit(),
});

/**
 * Which revision is running.
 *
 * The build context has no `.git`, so the commit arrives as a build argument
 * and the Dockerfile writes it to `dist/COMMIT`. A Docker `ARG` exists only in
 * the stage that declares it, which is why reading the environment alone left
 * every image ever built reporting "unknown" — and a deployment that cannot say
 * what it is running is one nobody can roll back with confidence. The
 * environment still wins when set, so an operator can override without a
 * rebuild.
 */
function buildCommit(): string {
  const fromEnv = str(env.SOURCE_COMMIT || env.SPATIAL_COMMIT, '');
  if (fromEnv) return fromEnv;
  let dir = __dirname;
  for (let i = 0; i < 6; i += 1) {
    try {
      const stamped = readFileSync(resolve(dir, 'COMMIT'), 'utf8').trim();
      if (stamped) return stamped;
    } catch {
      // Keep walking up.
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return 'unknown';
}

export type Config = typeof config;

/** Problems an operator should meet at boot rather than discover later. */
export function startupWarnings(): string[] {
  const warnings: string[] = [];
  if (config.session.secretWasGenerated) {
    warnings.push(
      'SPATIAL_SESSION_SECRET is unset or shorter than 32 characters, so a random one was generated. ' +
        'Sessions will not survive a restart and cannot be shared across replicas.',
    );
  }
  if (!config.auth.enabled) {
    const role = config.auth.devBypassRole && !config.isProduction ? config.auth.devBypassRole : '';
    warnings.push(
      role && role !== 'learner'
        ? `Authentication is DISABLED and SPATIAL_DEV_ROLE is '${role}', so every visitor holds that role and everything it carries.`
        : 'Authentication is DISABLED. Every visitor is treated as a learner on the Beginner tier.',
    );
  }
  if (config.auth.devBypassRole && config.isProduction) {
    warnings.push(`SPATIAL_DEV_ROLE is '${config.auth.devBypassRole}' but NODE_ENV is production, so it is ignored.`);
  }
  if (config.ai.enabled && !config.ai.apiKey && !config.ai.baseUrl) {
    warnings.push(
      'AI interpretation is enabled but no provider key or gateway URL is set, so the adapter will abstain on every request.',
    );
  }
  if (config.research.exportsEnabled) {
    warnings.push(
      'Research exports are ENABLED. Confirm ethics approval and the consent flow are in place for this deployment.',
    );
  }
  if (config.runs.concurrency > 2) {
    warnings.push(
      `SPATIAL_RUN_CONCURRENCY is ${config.runs.concurrency}. Each propagation run holds the full per-stage tissue state; ` +
        'confirm the container has memory for that many at once.',
    );
  }
  return warnings;
}
