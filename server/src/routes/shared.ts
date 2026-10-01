/**
 * Shared request plumbing: the session, the error envelope and the guards.
 *
 * §10.2 fixes the error shape and lists the scientific error classes. Every
 * refusal in this API goes through `fail` so that a client can react to *why*
 * rather than pattern-matching a message — a capacity refusal wants a retry, a
 * tier refusal wants a link to the portal, and an authentication failure wants
 * the sign-in screen.
 *
 * `requireSession` and `requireCapability` are the only way a handler gets an
 * identity. A route that forgets to call them has no identity to work with and
 * cannot compile, which is the point: the default is to refuse.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
// Registers the `cookies` property on FastifyRequest.
import '@fastify/cookie';
import { config } from '../config';
import { can, readSessionToken, type Capability, type Identity, type Session } from '../auth';
import type { ScientificErrorCode } from '@engine/pipeline';
import { ERROR_IS_RECOVERABLE, ERROR_SUGGESTION } from '@engine/pipeline';

export const SESSION_COOKIE = 'spatial_session';

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    requestId: string;
    fieldErrors: { field: string; message: string }[];
    recoverable: boolean;
    suggestedAction: string;
    retryAfterSeconds?: number;
  };
}

export function fail(
  reply: FastifyReply,
  status: number,
  code: ScientificErrorCode | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'TIER_REQUIRED' | 'NOT_FOUND' | 'RATE_LIMITED' | 'CAPACITY',
  message: string,
  extras: { fieldErrors?: { field: string; message: string }[]; retryAfterSeconds?: number; suggestedAction?: string } = {},
): FastifyReply {
  const scientific = code in ERROR_IS_RECOVERABLE ? (code as ScientificErrorCode) : null;
  const envelope: ErrorEnvelope = {
    error: {
      code,
      message,
      requestId: String(reply.request.id),
      fieldErrors: extras.fieldErrors ?? [],
      recoverable: scientific ? ERROR_IS_RECOVERABLE[scientific] : status < 500,
      suggestedAction:
        extras.suggestedAction ??
        (scientific ? ERROR_SUGGESTION[scientific] : defaultSuggestion(code)),
    },
  };
  if (extras.retryAfterSeconds !== undefined) envelope.error.retryAfterSeconds = extras.retryAfterSeconds;
  return reply.code(status).send(envelope);
}

function defaultSuggestion(code: string): string {
  switch (code) {
    case 'UNAUTHENTICATED':
      return 'Open the lab again from the portal.';
    case 'FORBIDDEN':
      return 'This account does not hold the capability this request needs.';
    case 'TIER_REQUIRED':
      return 'Advanced mode is a paid tier. Reviewers and administrators are exempt.';
    case 'NOT_FOUND':
      return 'Check the identifier; it may belong to another project.';
    case 'RATE_LIMITED':
      return 'Wait for the stated interval and try again.';
    case 'CAPACITY':
      return 'The queue is full. Wait for the running jobs to finish.';
    default:
      return 'Check the request and try again.';
  }
}

export interface Sessions {
  get(id: string): Session | undefined;
  set(id: string, session: Session): void;
  delete(id: string): void;
}

/**
 * The session for a request, from the http-only cookie.
 *
 * Returns null rather than throwing, so a handler decides whether an anonymous
 * request is an error — `GET /api/v1/meta` is answerable without one.
 */
export function sessionFor(request: FastifyRequest, sessions: Sessions): Session | null {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) return null;
  const payload = readSessionToken(token);
  if (!payload) return null;
  const session = sessions.get(payload.sid);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(payload.sid);
    return null;
  }
  session.lastSeenAt = Date.now();
  return session;
}

export function requireSession(request: FastifyRequest, reply: FastifyReply, sessions: Sessions): Session | null {
  const session = sessionFor(request, sessions);
  if (!session) {
    fail(reply, 401, 'UNAUTHENTICATED', 'This session is not signed in. Open the lab again from the portal.');
    return null;
  }
  return session;
}

export function requireCapability(
  reply: FastifyReply,
  identity: Identity,
  capability: Capability,
): boolean {
  if (can(identity, capability)) return true;
  fail(reply, 403, 'FORBIDDEN', `This account cannot ${capability.replace(/-/g, ' ')}.`);
  return false;
}

/**
 * Ownership.
 *
 * Checked on the server against the session, never against anything the page
 * sends. A project id is not a secret — it appears in a URL — so it cannot be
 * the authorisation.
 */
export function requireOwnership(
  reply: FastifyReply,
  identity: Identity,
  ownerId: string,
  what: string,
): boolean {
  if (identity.userId === ownerId) return true;
  if (identity.roles.includes('admin') || identity.roles.includes('instructor')) return true;
  fail(reply, 404, 'NOT_FOUND', `No such ${what}.`);
  return false;
}

export function cookieOptions(): {
  httpOnly: true; sameSite: 'lax'; secure: boolean; path: string; maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: 'lax',
    // In production the lab is served over TLS behind the hub's proxy; in
    // development it is plain http on localhost and a secure cookie would never
    // be sent back, which looks exactly like a broken session.
    secure: config.isProduction,
    path: '/',
    maxAge: Math.floor(config.session.ttlMs / 1000),
  };
}

/** A number from a query string, with a range. */
export function queryNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = typeof value === 'string' ? Number.parseFloat(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function queryString(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

export function queryBoolean(value: unknown, fallback = false): boolean {
  if (typeof value !== 'string') return fallback;
  const lower = value.trim().toLowerCase();
  if (lower === 'true' || lower === '1' || lower === 'yes') return true;
  if (lower === 'false' || lower === '0' || lower === 'no') return false;
  return fallback;
}
