/**
 * Governance calls from a session with no portal token.
 *
 * With authentication disabled (a local or demo deployment) a session has no
 * portal token. The governance routes used to call the portal regardless,
 * which sent the learner's text to the production hub with no credentials,
 * got refused, and told the learner "This is a defect". They now answer
 * locally, and these tests pin that no request leaves the process.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { issueSessionToken, type Identity, type Session } from '../src/auth';
import { config } from '../src/config';
import { loadCatalogue } from '../src/content/loader';
import { Store } from '../src/store';
import { JobQueue } from '../src/jobs/queue';
import { AiAdapter } from '../src/ai/adapter';
import { registerRoutes, type Services } from '../src/routes/index';
import { SESSION_COOKIE } from '../src/routes/shared';

let app: FastifyInstance;
let dataRoot: string;
const sessions = new Map<string, Session>();

function signIn(over: Partial<Identity>): string {
  const now = Date.now();
  const id = `sess_${Math.random().toString(36).slice(2)}`;
  sessions.set(id, {
    id,
    identity: {
      userId: 'offline-1', displayName: 'Offline', email: null, roles: ['learner'],
      tier: 'basic', isReviewer: false, researchConsent: false, ...over,
    },
    createdAt: now, expiresAt: now + 3_600_000, lastSeenAt: now, condition: null,
    hubToken: null,
  });
  return `${SESSION_COOKIE}=${issueSessionToken(id, now + 3_600_000)}`;
}

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'spatial-governance-offline-'));
  const store = new Store(dataRoot);
  const services: Services = {
    catalogue: loadCatalogue(config.contentRoot),
    store,
    queue: new JobQueue({ concurrency: 1, maxQueued: 4, hardTimeoutMs: 5_000 }),
    ai: new AiAdapter(dataRoot),
    sessions,
  };
  app = Fastify({ logger: false });
  await app.register(fastifyCookie, { secret: config.session.secret });
  await registerRoutes(app, services);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  rmSync(dataRoot, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function watchFetch(): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', spy);
  return spy;
}

describe('governance without a portal session', () => {
  it('does not send feedback anywhere, and says why', async () => {
    const fetchSpy = watchFetch();
    const response = await app.inject({
      method: 'POST', url: '/api/v1/governance/feedback', headers: { cookie: signIn({}) },
      payload: { category: 'usability', message: 'The legend overlaps the scale bar.', context: '' },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(503);
    const body = response.json() as { error: { code: string; message: string; suggestedAction: string } };
    expect(body.error.code).toBe('UNAUTHENTICATED');
    expect(body.error.message).toMatch(/not connected to the portal/);
    expect(body.error.suggestedAction).not.toMatch(/defect/i);
  });

  it('does not send the agreement or a review anywhere', async () => {
    const fetchSpy = watchFetch();
    const reviewer = signIn({ isReviewer: true, roles: ['learner', 'reviewer'] });
    for (const url of ['/api/v1/governance/agreement', '/api/v1/governance/review']) {
      const response = await app.inject({ method: 'POST', url, headers: { cookie: reviewer }, payload: { confirmed: true } });
      expect(response.statusCode, url).toBe(503);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps the agreement gate closed, as unknown, without asking the portal', async () => {
    const fetchSpy = watchFetch();
    const response = await app.inject({
      method: 'GET', url: '/api/v1/governance/agreement', headers: { cookie: signIn({ isReviewer: true, roles: ['learner', 'reviewer'] }) },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'unknown', signed: false });
  });
});
