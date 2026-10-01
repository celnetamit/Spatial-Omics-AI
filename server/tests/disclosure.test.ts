/**
 * What one account can read of another's, against a real server.
 *
 * `authorisation.test.ts` tests the capability table in isolation. This boots
 * Fastify with the real routes and asks the questions an attacker would: given
 * a project id — which is not a secret, it appears in a URL — what does a
 * different signed-in user get back?
 *
 * The answers are asserted as status codes rather than as "it refused",
 * because *how* it refuses matters. A run that exists and belongs to somebody
 * else must return 404, not 403: a 403 confirms the id is real, which is a
 * disclosure in itself on ids a user can enumerate.
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

function identity(userId: string, over: Partial<Identity> = {}): Identity {
  return {
    userId,
    displayName: userId,
    email: null,
    roles: ['learner'],
    tier: 'expert',
    isReviewer: false,
    researchConsent: false,
    ...over,
  };
}

/** A signed cookie for a session that exists, as the real sign-in would make. */
function signIn(who: Identity): string {
  const now = Date.now();
  const id = `sess_${who.userId}_${Math.random().toString(36).slice(2)}`;
  sessions.set(id, {
    id, identity: who, createdAt: now, expiresAt: now + 3_600_000,
    lastSeenAt: now, condition: null, hubToken: null,
  });
  return `${SESSION_COOKIE}=${issueSessionToken(id, now + 3_600_000)}`;
}

let owner: string;
let intruder: string;
let administrator: string;
let projectId: string;
let runId: string;

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'spatial-disclosure-'));
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

  owner = signIn(identity('owner-1'));
  intruder = signIn(identity('intruder-1'));
  administrator = signIn(identity('admin-1', { roles: ['learner', 'admin'] }));

  const project = store.createProject({
    ownerId: 'owner-1',
    title: 'Owned',
    organism: 'Homo sapiens',
    tissue: 'tumour',
    condition: 'untreated',
    studyQuestion: 'q',
    mode: 'expert',
    datasetId: 'sim-tme-primary',
    datasetKind: 'bundled-case',
    referenceDatasetId: null,
  });
  projectId = project.projectId;

  const run = store.createRun({
    projectId, ownerId: 'owner-1', kind: 'analysis', perturbationId: null, seed: 1,
  });
  runId = run.runId;
  store.updateRun(runId, { status: 'complete', progress: 1 });
  store.writeArtefact(runId, 'qc', { verdict: 'PASS', secret: 'owner-only' });
});

afterAll(async () => {
  await app?.close();
  rmSync(dataRoot, { recursive: true, force: true });
});

const get = (url: string, cookie?: string) =>
  app.inject({ method: 'GET', url, ...(cookie ? { headers: { cookie } } : {}) });

describe('another user\'s project', () => {
  it('is readable by its owner', async () => {
    const response = await get(`/api/v1/projects/${projectId}`, owner);
    expect(response.statusCode).toBe(200);
    expect(response.json().project.projectId).toBe(projectId);
  });

  it('is not readable by a different signed-in user', async () => {
    const response = await get(`/api/v1/projects/${projectId}`, intruder);
    expect(response.statusCode).toBe(404);
  });

  it('refuses with 404 rather than 403, so the id is not confirmed', async () => {
    // The response for somebody else's real project must be indistinguishable
    // from the response for an id that does not exist. Otherwise the status
    // code is an existence oracle over guessable ids.
    const real = await get(`/api/v1/projects/${projectId}`, intruder);
    const invented = await get('/api/v1/projects/prj_0000000000000000000', intruder);
    expect(real.statusCode).toBe(invented.statusCode);
    expect(real.json().error.code).toBe(invented.json().error.code);
  });

  it('does not appear in another user\'s project list', async () => {
    const response = await get('/api/v1/projects', intruder);
    expect(response.statusCode).toBe(200);
    expect(response.json().projects).toHaveLength(0);
  });

  it('is readable by an administrator', async () => {
    expect((await get(`/api/v1/projects/${projectId}`, administrator)).statusCode).toBe(200);
  });
});

describe('another user\'s run', () => {
  it('is readable by its owner and not by anyone else', async () => {
    expect((await get(`/api/v1/runs/${runId}`, owner)).statusCode).toBe(200);
    expect((await get(`/api/v1/runs/${runId}`, intruder)).statusCode).toBe(404);
  });

  it('does not leak its results', async () => {
    expect((await get(`/api/v1/runs/${runId}/results`, intruder)).statusCode).toBe(404);
  });

  it('does not leak its artefacts', async () => {
    const response = await get(`/api/v1/runs/${runId}/artefacts?name=qc`, intruder);
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('owner-only');
  });

  it('does not leak a per-cell layer', async () => {
    expect((await get(`/api/v1/runs/${runId}/layer?name=expression`, intruder)).statusCode).toBe(404);
  });

  it('does not leak its report', async () => {
    expect((await get(`/api/v1/runs/${runId}/report`, intruder)).statusCode).toBe(404);
  });
});

describe('signed-out access', () => {
  it('is refused everywhere that carries user data', async () => {
    for (const url of [
      '/api/v1/projects',
      `/api/v1/projects/${projectId}`,
      `/api/v1/runs/${runId}`,
      `/api/v1/runs/${runId}/results`,
      `/api/v1/runs/${runId}/artefacts?name=qc`,
      '/api/v1/research/export',
    ]) {
      const response = await get(url);
      expect(response.statusCode, url).toBe(401);
    }
  });

  it('still serves the public metadata a sign-in screen needs', async () => {
    expect((await get('/api/v1/meta')).statusCode).toBe(200);
    // Not 401: the client asks this before it knows whether anyone is signed
    // in, and a 401 here turns "nobody is signed in" into an error screen.
    const session = await get('/api/v1/session');
    expect(session.statusCode).toBe(200);
    expect(session.json().user).toBeNull();
  });
});

describe('the machine-readable export', () => {
  it('is refused to a learner who owns the run', async () => {
    // Ownership is not the only gate: §16 makes the depth of an export a
    // capability, so the owner of a run still cannot pull its raw artefacts.
    const response = await get(`/api/v1/runs/${runId}/artefacts?name=qc`, owner);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');
  });

  it('is allowed to an administrator', async () => {
    const response = await get(`/api/v1/runs/${runId}/artefacts?name=qc`, administrator);
    expect(response.statusCode).toBe(200);
  });
});

describe('the research export', () => {
  it('is refused to a learner', async () => {
    expect((await get('/api/v1/research/export', owner)).statusCode).toBe(403);
  });

  it('is refused to a researcher while the deployment has it switched off', async () => {
    // Two independent gates. The capability is not enough; the deployment has
    // to have been configured for it, because the consent and ethics questions
    // are answered per deployment rather than per account.
    expect(config.research.exportsEnabled).toBe(false);
    const researcher = signIn(identity('researcher-1', { roles: ['learner', 'researcher'] }));
    const response = await get('/api/v1/research/export', researcher);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toMatch(/switched off/i);
  });
});
