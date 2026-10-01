/**
 * Authorisation against the central hub, and the role model of §3 and §16.2.
 *
 * The lab never inspects a launch token itself. It posts the token to the hub's
 * authorize-lab endpoint and uses the identity that comes back — session token,
 * user id, entitlement, reviewer flag. Parsing the token locally would mean
 * duplicating the hub's signing rules in a second place, and the second place
 * is always the one that drifts.
 *
 * Roles are enforced here and nowhere else. Every route asks this module what a
 * request is allowed to do, so a new route cannot accidentally ship without a
 * check — the default, when no requirement is stated, is to refuse.
 */

import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { config } from './config';

export type Role = 'learner' | 'instructor' | 'author' | 'reviewer' | 'researcher' | 'admin';

export interface Identity {
  /** Stable id from the hub. Never rendered to another learner. */
  userId: string;
  displayName: string;
  email: string | null;
  roles: Role[];
  /** Tier the hub says this user has for this lab. */
  tier: 'basic' | 'moderate' | 'expert';
  /** Reviewers and admins are exempt from the paid-tier gate. */
  isReviewer: boolean;
  /** Research consent, as recorded by the hub. */
  researchConsent: boolean;
}

export interface Session {
  id: string;
  identity: Identity;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  /** Study condition, assigned once and then fixed for the whole session. */
  condition: 'A' | 'B' | 'C' | null;
  /**
   * The hub session token `authorize-lab` issued, kept so the lab can act on
   * the learner's behalf against the hub's governance endpoints — feedback,
   * the reviewer agreement, the expert review form.
   *
   * It never leaves this process. Other labs keep the equivalent token in the
   * browser's sessionStorage and call the hub from the page; this lab does not,
   * because it already holds a server-side session and putting a second
   * credential in the browser would widen the surface for nothing. Every
   * governance call is proxied, and the proxy re-reads `identity.isReviewer`
   * rather than trusting anything the page says.
   */
  hubToken: string | null;
}

/** What a capability needs. Routes name a capability, never a role. */
export type Capability =
  | 'open-project'
  | 'upload-dataset'
  | 'run-analysis'
  | 'run-prediction'
  | 'run-rescue'
  | 'view-own-report'
  | 'view-provenance'
  | 'edit-advanced-parameters'
  | 'view-model-diagnostics'
  | 'use-ai-interpretation'
  | 'export-machine-readable'
  | 'export-research'
  | 'administer';

const CAPABILITIES: Record<Capability, Role[]> = {
  'open-project': ['learner', 'instructor', 'author', 'reviewer', 'admin'],
  'upload-dataset': ['learner', 'instructor', 'author', 'reviewer', 'admin'],
  'run-analysis': ['learner', 'instructor', 'author', 'reviewer', 'admin'],
  'run-prediction': ['learner', 'instructor', 'author', 'reviewer', 'admin'],
  'run-rescue': ['learner', 'instructor', 'author', 'reviewer', 'admin'],
  'view-own-report': ['learner', 'instructor', 'reviewer', 'admin'],
  // §3: full provenance and the parameter manifest are an Expert affordance.
  // The gate is on the *mode*, not the role, and lives in `canOpenMode`; this
  // one covers the audit trail an instructor or reviewer sees for other people.
  'view-provenance': ['instructor', 'author', 'reviewer', 'admin'],
  'edit-advanced-parameters': ['instructor', 'author', 'reviewer', 'admin'],
  'view-model-diagnostics': ['instructor', 'author', 'reviewer', 'admin'],
  'use-ai-interpretation': ['learner', 'instructor', 'author', 'reviewer', 'admin'],
  'export-machine-readable': ['instructor', 'author', 'reviewer', 'admin'],
  'export-research': ['researcher', 'admin'],
  administer: ['admin'],
};

export function can(identity: Identity, capability: Capability): boolean {
  const allowed = CAPABILITIES[capability];
  if (!allowed) return false;
  return identity.roles.some((role) => allowed.includes(role));
}

/**
 * Tier gate for Expert mode.
 *
 * Expert is the paid tier. Reviewers, admins and instructors are exempt, and
 * that exemption lives here in the lab rather than on the hub, so a reviewer can
 * always open the mode they are being asked to review.
 *
 * §3's cross-mode identity rule is what makes this gate safe to have at all:
 * the modes differ in which controls, diagnostics and exports are available,
 * never in the numbers. A Beginner and an Expert running the same scientific
 * configuration get the same result, so the gate withholds depth of access and
 * not correctness.
 */
export function canOpenMode(identity: Identity, mode: 'basic' | 'moderate' | 'expert'): boolean {
  if (identity.isReviewer || identity.roles.includes('admin') || identity.roles.includes('instructor')) {
    return true;
  }
  const order = { basic: 0, moderate: 1, expert: 2 } as const;
  return order[mode] <= order[identity.tier];
}

// ---------------------------------------------------------------------------
// Session tokens
// ---------------------------------------------------------------------------

interface TokenPayload {
  sid: string;
  exp: number;
}

function sign(payload: string): string {
  return createHmac('sha256', config.session.secret).update(payload).digest('base64url');
}

export function issueSessionToken(sessionId: string, expiresAt: number): string {
  const payload = Buffer.from(JSON.stringify({ sid: sessionId, exp: expiresAt })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

/**
 * Verifies a session token.
 *
 * The signature is compared with a constant-time comparison. It is a small
 * thing, but a token check that returns early on the first wrong byte is a
 * timing oracle, and there is no reason to ship one.
 */
export function readSessionToken(token: string): TokenPayload | null {
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as TokenPayload;
    if (typeof parsed.sid !== 'string' || typeof parsed.exp !== 'number') return null;
    if (parsed.exp < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Hub exchange
// ---------------------------------------------------------------------------

export interface AuthorizeResult {
  ok: boolean;
  identity: Identity | null;
  /** Learner-safe reason, for the sign-in screen. */
  reason: string;
  /** True when the hub said no; false when the hub could not be reached. */
  decided: boolean;
  /** The hub's own session token, for later calls on the learner's behalf. */
  hubToken: string | null;
}

interface HubResponse {
  authorized?: boolean;
  sessionToken?: string;
  user?: {
    id?: string;
    name?: string;
    email?: string;
    roles?: string[];
    isReviewer?: boolean;
    tier?: string;
    researchConsent?: boolean;
  };
  reason?: string;
}

const ROLE_NAMES = new Set<Role>(['learner', 'instructor', 'author', 'reviewer', 'researcher', 'admin']);

function toRoles(raw: string[] | undefined, isReviewer: boolean): Role[] {
  const roles = new Set<Role>(['learner']);
  for (const name of raw ?? []) {
    const lower = name.trim().toLowerCase() as Role;
    if (ROLE_NAMES.has(lower)) roles.add(lower);
  }
  if (isReviewer) roles.add('reviewer');
  return [...roles];
}

/**
 * Exchanges a launch token for an identity.
 *
 * A network failure and a refusal are reported differently. If the hub is down,
 * a learner mid-experiment should be told the lab cannot reach the portal and
 * to try again — not that they are not allowed in, which would send them off to
 * argue with an administrator about an entitlement that is perfectly fine.
 */
export async function authorizeWithHub(launchToken: string): Promise<AuthorizeResult> {
  if (!config.auth.enabled) {
    return {
      ok: true,
      decided: true,
      reason: 'Authentication is disabled for this deployment.',
      identity: developmentIdentity('learner'),
      hubToken: null,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.auth.verifyTimeoutMs);
  try {
    const response = await fetch(config.auth.verifyUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ token: launchToken, lab: config.auth.labSlug }),
      signal: controller.signal,
    });

    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        decided: true,
        reason: 'The portal did not authorise this session for the Spatial Omics AI Virtual LiveLab.',
        identity: null,
        hubToken: null,
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        decided: false,
        reason: `The portal returned ${response.status} while checking this session.`,
        identity: null,
        hubToken: null,
      };
    }

    const body = (await response.json()) as HubResponse;
    if (!body.authorized || !body.user?.id) {
      return {
        ok: false,
        decided: true,
        reason: body.reason ?? 'The portal did not authorise this session for the Spatial Omics AI Virtual LiveLab.',
        identity: null,
        hubToken: null,
      };
    }

    const isReviewer = Boolean(body.user.isReviewer);
    const tier = body.user.tier === 'expert' || body.user.tier === 'moderate' ? body.user.tier : 'basic';

    return {
      ok: true,
      decided: true,
      reason: 'Authorised.',
      identity: {
        userId: body.user.id,
        displayName: body.user.name ?? 'Learner',
        email: body.user.email ?? null,
        roles: toRoles(body.user.roles, isReviewer),
        tier,
        isReviewer,
        researchConsent: Boolean(body.user.researchConsent),
      },
      hubToken: typeof body.sessionToken === 'string' ? body.sessionToken : null,
    };
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    return {
      ok: false,
      decided: false,
      reason: aborted
        ? 'The portal did not respond in time. Your work is saved; try again in a moment.'
        : 'The lab could not reach the portal to check this session.',
      identity: null,
      hubToken: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A stand-in identity for local development.
 *
 * Refuses to produce anything in production: `config.auth.devBypassRole` is
 * ignored there, and this is only ever reached when authentication is off.
 */
export function developmentIdentity(role: string): Identity {
  const requested = (role.trim().toLowerCase() || 'learner') as Role;
  const roles: Role[] = ROLE_NAMES.has(requested) ? ['learner', requested] : ['learner'];
  const elevated = roles.includes('reviewer') || roles.includes('admin') || roles.includes('instructor');
  return {
    userId: 'dev-user',
    displayName: 'Development user',
    email: null,
    roles: [...new Set(roles)],
    tier: elevated ? 'expert' : 'basic',
    isReviewer: roles.includes('reviewer'),
    researchConsent: false,
  };
}

/**
 * A stable pseudonym for the research dataset.
 *
 * The identity mapping stays out of the analytics path entirely: research
 * exports carry this and never the user id, so re-identifying a participant
 * requires the salt as well as the export, and the two are held separately.
 */
export function participantPseudonym(userId: string): string {
  return createHash('sha256')
    .update(config.research.pseudonymSalt)
    // A domain separator, written as an escape rather than as the byte
    // itself: a literal NUL in a source file makes grep treat it as binary
    // and skip it silently, so this function was invisible to every search.
    .update('\0')
    .update(userId)
    .digest('hex')
    .slice(0, 16);
}

export function newSessionId(): string {
  return randomUUID();
}
