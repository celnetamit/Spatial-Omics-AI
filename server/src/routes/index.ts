/**
 * The API of §10.1.
 *
 * Route naming follows the handbook's map rather than REST convention where the
 * two differ, because the handbook's map is what a reader of the specification
 * will look for.
 *
 * Every handler that touches a project resolves the session first, then
 * ownership, then the capability. The order matters: an unauthenticated request
 * should be told to sign in, and a request for someone else's project should be
 * told the project does not exist rather than that it exists and is forbidden.
 */

import type { FastifyInstance } from 'fastify';
import { config } from '../config';
import {
  authorizeWithHub, canOpenMode, developmentIdentity, issueSessionToken, modeLock, newSessionId,
  participantPseudonym, type Session,
} from '../auth';
import type { Store, LabMode } from '../store';
import type { Catalogue } from '../content/loader';
import { publicCaseSummary } from '../content/loader';
import type { JobQueue } from '../jobs/queue';
import type { AiAdapter } from '../ai/adapter';
import {
  cookieOptions, fail, modeProgress, queryNumber, queryString, requireCapability, requireOwnership,
  requireSession, sessionFor, SESSION_COOKIE, type Sessions,
} from './shared';
import { registerProjectRoutes } from './projects';
import { registerResultRoutes } from './results';
import { registerGovernanceRoutes } from './governance';
import { MODE_LABEL, MODE_SUMMARY } from '../../../lib/governance/modeLabels';

export interface Services {
  catalogue: Catalogue;
  store: Store;
  queue: JobQueue;
  ai: AiAdapter;
  sessions: Map<string, Session>;
}

export async function registerRoutes(app: FastifyInstance, services: Services): Promise<void> {
  const sessions: Sessions = {
    get: (id) => services.sessions.get(id),
    set: (id, session) => {
      services.sessions.set(id, session);
    },
    delete: (id) => {
      services.sessions.delete(id);
    },
  };

  app.addHook('onRequest', async (request, reply) => {
    /*
     * Browser-side hardening for the one-origin deployment.
     *
     * The handbook's §16 security controls focus on API authorization, upload
     * handling, secrets and exports. Those controls do not help if a browser is
     * allowed to sniff a JSON response as script, cache project data on a shared
     * machine, or frame the lab in a hostile page, so every response gets the
     * invariant headers here and user/project-carrying API responses get
     * explicit no-store semantics.
     */
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    reply.header(
      'permissions-policy',
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), interest-cohort=()',
    );
    reply.header(
      'content-security-policy',
      [
        "default-src 'self'",
        "base-uri 'self'",
        "connect-src 'self'",
        "font-src 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "img-src 'self' data: blob:",
        "object-src 'none'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
      ].join('; '),
    );

    if (request.url.startsWith('/api/') || request.url === '/healthz') {
      reply.header('cache-control', 'no-store');
      reply.header('pragma', 'no-cache');
    }
  });

  // -- health ---------------------------------------------------------------

  app.get('/healthz', async (_request, reply) => {
    const errors = services.catalogue.problems.filter((problem) => problem.severity === 'error');
    const degraded = errors.length > 0 || services.catalogue.cases.size === 0;
    return reply.code(degraded ? 503 : 200).send({
      status: degraded ? 'degraded' : 'ok',
      version: config.version,
      commit: config.commit,
      cases: services.catalogue.cases.size,
      modelPack: services.catalogue.modelPack?.version ?? null,
      drugEvidence: services.catalogue.drugEvidence?.version ?? null,
      queue: { running: services.queue.running, waiting: services.queue.depth },
      problems: errors.map((problem) => `${problem.component}: ${problem.message}`),
    });
  });

  // -- session --------------------------------------------------------------

  /**
   * Exchanges a launch token for a session cookie.
   *
   * The token is spent here and never returned to the page. A launch token in
   * the browser is a credential that survives a copied link, a bookmark and the
   * history; an http-only cookie does not.
   */
  app.post<{ Body: { token?: string } }>('/api/v1/auth/session', async (request, reply) => {
    const token = typeof request.body?.token === 'string' ? request.body.token.trim() : '';

    if (!config.auth.enabled) {
      const identity = developmentIdentity(config.isProduction ? 'learner' : config.auth.devBypassRole);
      const session = newSession(identity, null);
      services.sessions.set(session.id, session);
      reply.setCookie(SESSION_COOKIE, issueSessionToken(session.id, session.expiresAt), cookieOptions());
      return reply.send({ user: publicUser(session, services.store), authDisabled: true });
    }

    if (!token) {
      return fail(reply, 400, 'INVALID_INPUT', 'No launch token was supplied.', {
        suggestedAction: 'Open the lab from the portal rather than by its address.',
      });
    }

    const result = await authorizeWithHub(token);
    if (!result.ok || !result.identity) {
      // A refusal and an unreachable portal are different failures and are
      // reported differently: one sends the learner to an administrator, the
      // other tells them to try again.
      return fail(reply, result.decided ? 403 : 503, result.decided ? 'FORBIDDEN' : 'INTERNAL', result.reason, {
        suggestedAction: result.decided
          ? 'Ask an administrator to check this account’s access to this lab.'
          : 'Wait a moment and open the lab again from the portal.',
        ...(result.decided ? {} : { retryAfterSeconds: 10 }),
      });
    }

    const session = newSession(result.identity, result.hubToken);
    services.sessions.set(session.id, session);
    reply.setCookie(SESSION_COOKIE, issueSessionToken(session.id, session.expiresAt), cookieOptions());
    services.store.audit({
      actorId: result.identity.userId,
      action: 'session.open',
      subject: result.identity.userId,
      detail: { tier: result.identity.tier, isReviewer: result.identity.isReviewer },
    });
    return reply.send({ user: publicUser(session, services.store), authDisabled: false });
  });

  /**
   * Who am I.
   *
   * Answers 200 with `user: null` when nobody is signed in, rather than 401.
   * "Nobody" is a valid answer to this question, not an error: the client asks
   * it on every load before it decides whether to spend a launch token, and a
   * 401 there put a red line in the console on every single page view for a
   * path that is working exactly as designed. Endpoints that *do* need a
   * session still refuse without one.
   */
  app.get('/api/v1/session', async (request, reply) => {
    const session = sessionFor(request, sessions);
    return reply.send({
      user: session ? publicUser(session, services.store) : null,
      authDisabled: !config.auth.enabled,
    });
  });

  app.post('/api/v1/auth/sign-out', async (request, reply) => {
    const session = sessionFor(request, sessions);
    if (session) services.sessions.delete(session.id);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.code(204).send();
  });

  // -- meta -----------------------------------------------------------------

  /**
   * What this deployment is and is not.
   *
   * Read at runtime, so a change to the AI configuration or the model pack
   * takes a restart rather than a rebuild. The client asks for this before it
   * renders anything that depends on a capability existing.
   */
  app.get('/api/v1/meta', async (_request, reply) => {
    const pack = services.catalogue.modelPack;
    return reply.send({
      version: config.version,
      commit: config.commit,
      portal: {
        loginUrl: config.auth.loginUrl,
        homeUrl: config.auth.homeUrl,
        /*
         * The "Back to homepage" target: this lab's page on the portal. The
         * portal serves lab pages at /dashboard/labs/<slug>, on the origin that
         * also serves authorize-lab, so a staging deployment links to its own
         * portal without separate configuration.
         */
        labUrl: config.auth.labPageUrl || `${new URL(config.auth.verifyUrl).origin}/dashboard/labs/${config.auth.labSlug}`,
      },
      authEnabled: config.auth.enabled,
      modes: (['basic', 'moderate', 'expert'] as LabMode[]).map((mode) => ({
        id: mode,
        label: MODE_LABEL[mode],
        summary: MODE_SUMMARY[mode],
      })),
      ai: {
        available: services.ai.available,
        unavailableReason: services.ai.unavailableReason,
        role:
          'The AI explains structured results. It never produces a number, a map or a comparison, and every response is checked ' +
          'against the evidence it was given before it is shown. With no provider configured the lab is complete.',
      },
      modelPack: pack
        ? {
            modelId: pack.modelId,
            version: pack.version,
            trainedOn: pack.card.trainingData,
            whatTheMetricsMean: pack.card.whatTheMetricsMean,
            limitations: pack.card.limitations,
          }
        : null,
      modelPackMissing: pack
        ? null
        : 'No propagation model pack is installed. Baseline analysis and the evidence-parameterised direct response are available; ' +
          'spatial propagation and the rescue engine are not, and nothing is substituted for them.',
      drugEvidence: services.catalogue.drugEvidence
        ? {
            packId: services.catalogue.drugEvidence.packId,
            version: services.catalogue.drugEvidence.version,
            retrievedAt: services.catalogue.drugEvidence.retrievedAt,
            source: services.catalogue.drugEvidence.source,
            compounds: services.catalogue.drugEvidence.records.length,
          }
        : null,
      resources: services.catalogue.resources.provenance,
      researchExports: config.research.exportsEnabled,
      researchBoundary:
        'Research and education use. This platform is not a clinical treatment recommendation system, and no output from it is ' +
        'clinical guidance (§1.4).',
      problems: services.catalogue.problems,
    });
  });

  // -- reference material ---------------------------------------------------

  app.get('/api/v1/cases', async (request, reply) => {
    const session = requireSession(request, reply, sessions);
    if (!session) return reply;
    return reply.send({
      cases: [...services.catalogue.cases.values()].map(publicCaseSummary),
    });
  });

  app.get('/api/v1/registry', async (request, reply) => {
    const session = requireSession(request, reply, sessions);
    if (!session) return reply;
    return reply.send({
      version: services.catalogue.parameters.version,
      records: services.catalogue.parameters.records,
      note:
        'Every biological parameter here is evidence-derived, calibrated, data-derived or explicitly exploratory (§5). ' +
        'Engineering guardrails are marked as such and are not scientific claims. A null default means there is no universal ' +
        'default — which for a drug concentration is the honest state, not a gap.',
    });
  });

  app.get('/api/v1/model-card', async (request, reply) => {
    const session = requireSession(request, reply, sessions);
    if (!session) return reply;
    const pack = services.catalogue.modelPack;
    if (!pack) {
      return fail(reply, 404, 'NOT_FOUND', 'No propagation model pack is installed in this deployment.');
    }
    return reply.send(pack.card);
  });

  app.get('/api/v1/resources', async (request, reply) => {
    const session = requireSession(request, reply, sessions);
    if (!session) return reply;
    return reply.send({
      version: services.catalogue.resources.version,
      provenance: services.catalogue.resources.provenance,
      pathways: services.catalogue.resources.pathways.map((set) => ({
        id: set.id,
        name: set.name,
        source: set.source,
        members: Object.keys(set.members).length,
      })),
      states: services.catalogue.resources.states.map((set) => ({
        id: set.id,
        name: set.name,
        source: set.source,
        members: Object.keys(set.members).length,
      })),
      ligandReceptor: services.catalogue.resources.ligandReceptor,
      markerPanel: services.catalogue.resources.markerPanel,
      network: {
        nodes: services.catalogue.network.nodes,
        signals: services.catalogue.network.signals.map((signal) => ({
          ligand: services.catalogue.network.nodes[signal.ligand]?.symbol,
          receptor: services.catalogue.network.nodes[signal.receptor]?.symbol,
          diffusionLength: signal.diffusionLength,
          potency: signal.potency,
          pathway: signal.pathway,
        })),
      },
    });
  });

  app.get('/api/v1/drugs', async (request, reply) => {
    const session = requireSession(request, reply, sessions);
    if (!session) return reply;
    const evidence = services.catalogue.drugEvidence;
    if (!evidence) {
      return fail(
        reply,
        404,
        'EVIDENCE_UNAVAILABLE',
        'No drug evidence pack is installed, so the drug perturbation branch is unavailable in this deployment.',
      );
    }
    return reply.send({
      packId: evidence.packId,
      version: evidence.version,
      retrievedAt: evidence.retrievedAt,
      source: evidence.source,
      whatIsRetrievedVersusCurated: evidence.whatIsRetrievedVersusCurated,
      records: evidence.records,
      problems: evidence.problems,
    });
  });

  // -- delegated groups -----------------------------------------------------

  await registerProjectRoutes(app, services, sessions);
  await registerResultRoutes(app, services, sessions);
  await registerGovernanceRoutes(app, services, sessions);

  // -- research export ------------------------------------------------------

  /**
   * Refused unless explicitly enabled, whatever the caller's role.
   *
   * §16.2 asks for an audit log and a documented retention policy; this is the
   * switch that keeps a deployment from exporting participant-linked data
   * because somebody held the right role.
   */
  app.get('/api/v1/research/export', async (request, reply) => {
    const session = requireSession(request, reply, sessions);
    if (!session) return reply;
    if (!requireCapability(reply, session.identity, 'export-research')) return reply;
    if (!config.research.exportsEnabled) {
      return fail(
        reply,
        403,
        'FORBIDDEN',
        'Research exports are switched off for this deployment.',
        { suggestedAction: 'Set SPATIAL_RESEARCH_EXPORTS once ethics approval and the consent flow are in place.' },
      );
    }

    const since = queryNumber((request.query as Record<string, unknown>).since, 0, 0, Date.now());
    const projects = services.store.listProjects(session.identity.userId);
    services.store.audit({
      actorId: session.identity.userId,
      action: 'research.export',
      subject: 'all',
      detail: { since, projects: projects.length },
    });

    return reply.send({
      exportedAt: new Date().toISOString(),
      pseudonymisation:
        'Participant identifiers are replaced by a salted hash. Re-identifying a participant needs the salt as well as this ' +
        'export, and the two are held separately.',
      retentionDays: config.research.retentionDays,
      projects: projects.map((project) => ({
        ...project,
        ownerId: participantPseudonym(project.ownerId),
      })),
    });
  });

  /*
   * The not-found handler is registered once, in `index.ts`.
   *
   * Fastify allows exactly one per prefix, and registering a second throws at
   * startup with "Not found handler already set" — which is a boot failure, not
   * a request failure, so the whole lab fails to come up. `index.ts` owns it
   * because it also has to decide whether an extension-less GET falls back to
   * the application shell, which depends on whether a built client exists.
   */

  void queryString;
  void requireOwnership;
  void canOpenMode;
}

function newSession(identity: ReturnType<typeof developmentIdentity>, hubToken: string | null): Session {
  const now = Date.now();
  return {
    id: newSessionId(),
    identity,
    createdAt: now,
    expiresAt: now + config.session.ttlMs,
    lastSeenAt: now,
    condition: null,
    hubToken,
  };
}

export function publicUser(session: Session, store: Store): Record<string, unknown> {
  const progress = modeProgress(store, session.identity.userId);
  const modes: LabMode[] = ['basic', 'moderate', 'expert'];
  return {
    userId: session.identity.userId,
    displayName: session.identity.displayName,
    email: session.identity.email,
    roles: session.identity.roles,
    tier: session.identity.tier,
    isReviewer: session.identity.isReviewer,
    researchConsent: session.identity.researchConsent,
    /** Which modes this account may open, decided on the server. */
    availableModes: modes.filter((mode) => canOpenMode(session.identity, mode, progress)),
    /** For each closed mode, why, so the client can say how to open it. */
    lockedModes: Object.fromEntries(
      modes.flatMap((mode) => {
        const reason = modeLock(session.identity, mode, progress);
        return reason ? [[mode, reason]] : [];
      }),
    ),
  };
}
