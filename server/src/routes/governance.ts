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

import type { FastifyInstance, FastifyReply } from 'fastify';
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

/*
 * A session with no portal token has no portal session to act for:
 * authentication is disabled (a local or demo deployment), or the portal
 * issued no token. The routes below used to call the portal anyway, which
 * sent the submission, the learner's text included, to the production hub
 * with no credentials. The hub refused it and the learner was told "This is
 * a defect". Say what is true instead, and make no network call.
 */
function notConnected(reply: FastifyReply, what: string): FastifyReply {
  return fail(reply, 503, 'UNAUTHENTICATED', `This session is not connected to the portal, so ${what} cannot be recorded from it.`, {
    suggestedAction: 'Open the lab from the portal and try again. Nothing was sent.',
  });
}

/* A portal refusal is not a lab defect; the default INTERNAL advice said it was. */
const REFUSED = { suggestedAction: 'Nothing was recorded. Open the lab again from the portal to renew your session, then try again.' };

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

    if (!session.hubToken) return notConnected(reply, 'your feedback');
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
      // The portal says which field it refused; pass that on rather than a bare "refused".
      const said = (result.body as { message?: unknown } | null)?.message;
      return fail(reply, result.status, 'INTERNAL', typeof said === 'string' ? `The portal refused the feedback: ${said}` : 'The portal refused the feedback submission.', REFUSED);
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

    if (!session.hubToken) {
      return reply.send({
        status: 'unknown',
        signed: false,
        reason: 'This session is not connected to the portal, so this lab cannot confirm whether the agreement is signed. Access stays closed.',
        portalReachable: false,
        endpointPresent: null,
        version: AGREEMENT_VERSION,
        fingerprint: agreementFingerprint(),
      });
    }
    const result = await callHub(
      /*
       * The hub reports a signature only for the version named here; without
       * `version` it answered `signed: null` every time. That made every
       * reviewer sign again on every visit, because a recorded signature was
       * never recognised.
       */
      `/api/labs/reviewer-agreement?lab=${encodeURIComponent(config.auth.labSlug)}&version=${encodeURIComponent(AGREEMENT_VERSION)}`,
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

    /*
     * The hub answers `signed: { acknowledgedAt, agreementVersion,
     * agreementFingerprint, ... }` or `signed: null`, not a boolean. A record
     * for this version only counts if it was signed over the same text: if the
     * wording changed without a version bump, the fingerprint will not match
     * and the reviewer is asked to sign the text they are actually shown.
     */
    const body = (result.body ?? {}) as {
      signed?: { acknowledgedAt?: string; agreementVersion?: string; agreementFingerprint?: string } | null;
      message?: string;
    };
    const record = result.ok && body.signed && typeof body.signed === 'object' ? body.signed : null;
    const signed = record !== null && (!record.agreementFingerprint || record.agreementFingerprint === agreementFingerprint());
    return reply.send({
      status: signed ? 'signed' : 'not-signed',
      signed,
      signedVersion: record?.agreementVersion ?? null,
      signedAt: record?.acknowledgedAt ?? null,
      reason: signed
        ? null
        : result.ok
          ? 'The expert reviewer agreement has not been signed for this lab.'
          : (body.message ?? `The portal answered ${result.status} when asked about the agreement.`),
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

    if (!session.hubToken) return notConnected(reply, 'the acknowledgement');
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
      return fail(reply, result.status, 'INTERNAL', 'The portal refused the acknowledgement.', REFUSED);
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

    if (!session.hubToken) return notConnected(reply, 'the review');
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
      return fail(reply, result.status, 'INTERNAL', 'The portal refused the review submission.', REFUSED);
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
