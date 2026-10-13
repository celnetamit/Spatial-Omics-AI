/**
 * Whether a reviewer has signed the agreement, as read from the hub.
 *
 * The hub reports a signature only for the version the request names, and
 * answers with the signed record or `null`. The lab used to ask without a
 * version and read the answer as a boolean, so a signature was never
 * recognised and every reviewer was sent back to the form on every visit.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { issueSessionToken, type Session } from '../src/auth';
import { config } from '../src/config';
import { loadCatalogue } from '../src/content/loader';
import { Store } from '../src/store';
import { JobQueue } from '../src/jobs/queue';
import { AiAdapter } from '../src/ai/adapter';
import { registerRoutes, type Services } from '../src/routes/index';
import { SESSION_COOKIE } from '../src/routes/shared';
import { AGREEMENT_VERSION, agreementFingerprint } from '../../lib/governance/reviewerAgreement';

let app: FastifyInstance;
let dataRoot: string;
const sessions = new Map<string, Session>();

function reviewerCookie(): string {
  const now = Date.now();
  const id = `sess_${Math.random().toString(36).slice(2)}`;
  sessions.set(id, {
    id,
    identity: {
      userId: 'reviewer-1', displayName: 'Reviewer', email: 'r@example.org', roles: ['learner', 'reviewer'],
      tier: 'basic', isReviewer: true, researchConsent: false,
    },
    createdAt: now, expiresAt: now + 3_600_000, lastSeenAt: now, condition: null, hubToken: 'hub-session-token',
  });
  return `${SESSION_COOKIE}=${issueSessionToken(id, now + 3_600_000)}`;
}

function hubAnswers(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', spy);
  return spy;
}

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'spatial-agreement-'));
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

afterEach(() => vi.unstubAllGlobals());

const status = async (): Promise<{ signed: boolean; signedAt: string | null }> =>
  (await app.inject({ method: 'GET', url: '/api/v1/governance/agreement', headers: { cookie: reviewerCookie() } })).json();

describe('the reviewer agreement status', () => {
  it('asks the hub about this version and recognises a signature for it', async () => {
    const spy = hubAnswers({
      ok: true,
      signed: { acknowledgedAt: '2026-10-13T09:00:00.000Z', agreementVersion: AGREEMENT_VERSION, agreementFingerprint: agreementFingerprint() },
    });
    const answer = await status();
    expect(String(spy.mock.calls[0]?.[0])).toContain(`version=${encodeURIComponent(AGREEMENT_VERSION)}`);
    expect(answer.signed).toBe(true);
    expect(answer.signedAt).toBe('2026-10-13T09:00:00.000Z');
  });

  it('keeps the gate closed when the hub has no signature', async () => {
    hubAnswers({ ok: true, signed: null });
    expect((await status()).signed).toBe(false);
  });

  it('asks again when the signed text differs from the text shown now', async () => {
    hubAnswers({ ok: true, signed: { acknowledgedAt: '2026-10-01T09:00:00.000Z', agreementVersion: AGREEMENT_VERSION, agreementFingerprint: 'an-older-text' } });
    expect((await status()).signed).toBe(false);
  });

  it('keeps the gate closed when the hub refuses', async () => {
    hubAnswers({ ok: false, code: 'NOT_A_REVIEWER', message: 'This account is not registered as an expert reviewer.' }, 403);
    expect((await status()).signed).toBe(false);
  });
});
