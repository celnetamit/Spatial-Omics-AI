/**
 * Which modes a learner may open, enforced at the routes.
 *
 * Beginner is open to everyone; Intermediate opens after the learner's first
 * completed experiment (a prediction run); Advanced stays with administrators,
 * reviewers and the Advanced tier. The session payload, project creation and
 * the mode switch all read one rule, so they cannot disagree.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
let store: Store;
let dataRoot: string;
const sessions = new Map<string, Session>();

function signIn(over: Partial<Identity>): string {
  const now = Date.now();
  const id = `sess_${Math.random().toString(36).slice(2)}`;
  sessions.set(id, {
    id,
    identity: {
      userId: 'learner-1', displayName: 'Learner', email: null, roles: ['learner'],
      tier: 'basic', isReviewer: false, researchConsent: false, ...over,
    },
    createdAt: now, expiresAt: now + 3_600_000, lastSeenAt: now, condition: null, hubToken: null,
  });
  return `${SESSION_COOKIE}=${issueSessionToken(id, now + 3_600_000)}`;
}

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'spatial-modes-'));
  store = new Store(dataRoot);
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

function project(ownerId: string): string {
  return store.createProject({
    ownerId, title: 'Modes', organism: 'Homo sapiens', tissue: 'tumour', condition: 'untreated',
    studyQuestion: 'q', mode: 'basic', datasetId: 'sim-tme-primary', datasetKind: 'bundled-case', referenceDatasetId: null,
  }).projectId;
}

const switchMode = (cookie: string, projectId: string, mode: string) =>
  app.inject({ method: 'PATCH', url: `/api/v1/projects/${projectId}/mode`, headers: { cookie }, payload: { mode } });

describe('modes for a learner', () => {
  it('starts in Beginner, with the reason for each closed mode in the session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/session', headers: { cookie: signIn({ userId: 'fresh-1' }) } });
    const user = (response.json() as { user: { availableModes: string[]; lockedModes: Record<string, string> } }).user;
    expect(user.availableModes).toEqual(['basic']);
    expect(user.lockedModes.moderate).toMatch(/first completed experiment/);
    expect(user.lockedModes.expert).toMatch(/administrators and reviewers/);
  });

  it('refuses Intermediate until an experiment has completed, then allows it', async () => {
    const cookie = signIn({ userId: 'learner-2' });
    const projectId = project('learner-2');

    const before = await switchMode(cookie, projectId, 'moderate');
    expect(before.statusCode).toBe(403);
    expect((before.json() as { error: { message: string } }).error.message).toMatch(/first completed experiment/);

    const run = store.createRun({ projectId, ownerId: 'learner-2', kind: 'prediction', perturbationId: null, seed: 1 });
    store.updateRun(run.runId, { status: 'complete', progress: 1 });

    const after = await switchMode(cookie, projectId, 'moderate');
    expect(after.statusCode).toBe(200);
    expect((after.json() as { project: { mode: string } }).project.mode).toBe('moderate');

    const session = await app.inject({ method: 'GET', url: '/api/v1/session', headers: { cookie } });
    expect((session.json() as { user: { availableModes: string[] } }).user.availableModes).toEqual(['basic', 'moderate']);

    // A completed experiment opens Intermediate only.
    expect((await switchMode(cookie, projectId, 'expert')).statusCode).toBe(403);
  });

  it('does not count a failed prediction as a completed experiment', async () => {
    const cookie = signIn({ userId: 'learner-3' });
    const projectId = project('learner-3');
    const run = store.createRun({ projectId, ownerId: 'learner-3', kind: 'prediction', perturbationId: null, seed: 1 });
    store.updateRun(run.runId, { status: 'failed' });
    expect((await switchMode(cookie, projectId, 'moderate')).statusCode).toBe(403);
  });

  it('opens every mode to an administrator', async () => {
    const cookie = signIn({ userId: 'admin-1', roles: ['learner', 'admin'] });
    const projectId = project('admin-1');
    for (const mode of ['moderate', 'expert', 'basic']) {
      expect((await switchMode(cookie, projectId, mode)).statusCode, mode).toBe(200);
    }
  });
});
