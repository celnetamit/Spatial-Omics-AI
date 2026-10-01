/**
 * Governance: feedback, the reviewer agreement and the expert review form.
 *
 * These are org-wide records and they live on the hub, not here. This lab
 * proxies them through its own server rather than calling the hub from the page
 * with a second credential: the browser already holds one session, and adding a
 * cross-origin request with credentials is a class of mistake this estate has
 * made before.
 *
 * The reviewer flag is re-read from the server-side session on every call. A
 * page that posts `isReviewer: true` gets a 403 regardless, which is the only
 * version of this control that means anything.
 */

import type { FastifyInstance } from 'fastify';
import { config } from '../config';
import type { Services } from './index';
import { fail, requireSession, type Sessions } from './shared';
import { AGREEMENT_VERSION, agreementFingerprint } from '../../../lib/governance/reviewerAgreement';

const HUB_BASE = (): string => {
  // The governance endpoints sit on the same origin as authorize-lab.
  const verify = config.auth.verifyUrl;
  const index = verify.indexOf('/api/');
  return index > 0 ? verify.slice(0, index) : 'https://live-labs.org';
};

async function callHub(
  path: string,
  method: 'GET' | 'POST',
  hubToken: string | null,
  body?: unknown,
): Promise<{ ok: boolean; status: number; body: unknown; reachable: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${HUB_BASE()}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(hubToken ? { authorization: `Bearer ${hubToken}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
    return { ok: response.ok, status: response.status, body: parsed, reachable: true };
  } catch {
    return { ok: false, status: 0, body: null, reachable: false };
  } finally {
    clearTimeout(timer);
  }
}

export async function registerGovernanceRoutes(
  app: FastifyInstance,
  services: Services,
  sessions: Sessions,
): Promise<void> {
  app.post<{ Body: Record<string, unknown> }>('/api/v1/governance/feedback', async (request, reply) => {
    const session = requireSession(request, reply, sessions);
    if (!session) return reply;

    const result = await callHub('/api/labs/feedback', 'POST', session.hubToken, {
      ...request.body,
      lab: config.auth.labSlug,
      labVersion: config.version,
    });
    if (!result.reachable) {
      return fail(reply, 503, 'INTERNAL', 'The portal could not be reached, so your feedback was not recorded.', {
        suggestedAction: 'Try again in a moment. Nothing was saved, so nothing was lost.',
        retryAfterSeconds: 15,
      });
    }
    if (!result.ok) {
      return fail(reply, result.status, 'INTERNAL', 'The portal refused the feedback submission.');
    }
    services.store.audit({
      actorId: session.identity.userId,
      action: 'governance.feedback',
      subject: config.auth.labSlug,
      detail: {},
    });
    return reply.send(result.body ?? { recorded: true });
  });

  /**
   * Reviewer agreement status.
   *
   * Fails closed. If the portal cannot be reached, the answer is "unknown" and
   * the gate stays shut — being unable to confirm a signature is not the same
   * as knowing there is one, and the screen says which of those happened so a
   * locked reviewer can tell a network blip from a deployment gap.
   */
  app.get('/api/v1/governance/agreement', async (request, reply) => {
    const session = requireSession(request, reply, sessions);
    if (!session) return reply;
    if (!session.identity.isReviewer) {
      return fail(reply, 403, 'FORBIDDEN', 'This account is not an expert reviewer.');
    }

    const result = await callHub(
      `/api/labs/reviewer-agreement?lab=${encodeURIComponent(config.auth.labSlug)}`,
      'GET',
      session.hubToken,
    );

    if (!result.reachable) {
      return reply.send({
        status: 'unknown',
        signed: false,
        reason: 'The portal could not be reached, so this lab cannot confirm whether the agreement is signed. Access stays closed.',
        portalReachable: false,
        endpointPresent: null,
        version: AGREEMENT_VERSION,
        fingerprint: agreementFingerprint(),
      });
    }
    if (result.status === 404) {
      return reply.send({
        status: 'unknown',
        signed: false,
        reason: 'The portal has no reviewer-agreement endpoint. This is a deployment gap, not a network problem. Access stays closed.',
        portalReachable: true,
        endpointPresent: false,
        version: AGREEMENT_VERSION,
        fingerprint: agreementFingerprint(),
      });
    }

    const body = (result.body ?? {}) as { signed?: boolean; version?: string; signedAt?: string };
    return reply.send({
      status: body.signed ? 'signed' : 'not-signed',
      signed: Boolean(body.signed),
      signedVersion: body.version ?? null,
      signedAt: body.signedAt ?? null,
      reason: body.signed
        ? null
        : 'The expert reviewer agreement has not been signed for this lab.',
      portalReachable: true,
      endpointPresent: true,
      version: AGREEMENT_VERSION,
      fingerprint: agreementFingerprint(),
      /*
       * The fingerprint travels with the acknowledgement.
       *
       * The agreement text is byte-identical across every lab in this estate.
       * Recording the fingerprint alongside the version means a later change to
       * the wording is detectable rather than silently applying to people who
       * agreed to the previous one.
       */
    });
  });

  app.post<{ Body: Record<string, unknown> }>('/api/v1/governance/agreement', async (request, reply) => {
    const session = requireSession(request, reply, sessions);
    if (!session) return reply;
    // Re-read from the server-side session, never from the body.
    if (!session.identity.isReviewer) {
      return fail(reply, 403, 'FORBIDDEN', 'This account is not an expert reviewer.');
    }

    const result = await callHub('/api/labs/reviewer-agreement', 'POST', session.hubToken, {
      ...request.body,
      lab: config.auth.labSlug,
      labVersion: config.version,
      agreementVersion: AGREEMENT_VERSION,
      agreementFingerprint: agreementFingerprint(),
    });

    if (!result.reachable) {
      return fail(reply, 503, 'INTERNAL', 'The portal could not be reached, so the acknowledgement was not recorded.', {
        retryAfterSeconds: 15,
      });
    }
    if (!result.ok) {
      return fail(reply, result.status, 'INTERNAL', 'The portal refused the acknowledgement.');
    }
    services.store.audit({
      actorId: session.identity.userId,
      action: 'governance.agreement.sign',
      subject: AGREEMENT_VERSION,
      detail: { fingerprint: agreementFingerprint() },
    });
    return reply.send(result.body ?? { recorded: true });
  });

  app.post<{ Body: Record<string, unknown> }>('/api/v1/governance/review', async (request, reply) => {
    const session = requireSession(request, reply, sessions);
    if (!session) return reply;
    if (!session.identity.isReviewer) {
      return fail(reply, 403, 'FORBIDDEN', 'This account is not an expert reviewer.');
    }

    const result = await callHub('/api/labs/expert-review', 'POST', session.hubToken, {
      ...request.body,
      lab: config.auth.labSlug,
      labVersion: config.version,
    });
    if (!result.reachable) {
      return fail(reply, 503, 'INTERNAL', 'The portal could not be reached, so the review was not recorded.', {
        retryAfterSeconds: 15,
      });
    }
    if (!result.ok) {
      return fail(reply, result.status, 'INTERNAL', 'The portal refused the review submission.');
    }
    services.store.audit({
      actorId: session.identity.userId,
      action: 'governance.review',
      subject: config.auth.labSlug,
      detail: {},
    });
    return reply.send(result.body ?? { recorded: true });
  });
}
