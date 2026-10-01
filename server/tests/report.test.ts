/**
 * The report spans the whole project, not one run.
 *
 * §12.5's seventeen sections cover the entire workflow, and the workflow is
 * spread over three runs: analysis, prediction, rescue. Each writes its own
 * artefacts under its own run id.
 *
 * The first implementation read every artefact from whichever run id was asked
 * for, so the report was structurally incapable of being complete: asked on the
 * prediction run it reported QC and the baseline as absent, asked on the
 * analysis run it reported the perturbation and the candidates as absent, and
 * no run existed for which all seventeen could be present. It looked like
 * missing science rather than a lookup reading from the wrong place.
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

let cookie: string;
let projectId: string;
let analysisRunId: string;
let predictionRunId: string;
let rescueRunId: string;

/* Artefacts shaped only as far as the report reads them. */
const ANALYSIS = {
  qc: { verdict: 'PASS', eligibility: { predictionEligible: true }, checks: [], summary: 'ok' },
  manifest: { seed: 1, methods: ['qc@1.0.0'], warnings: ['a stated limitation'] },
  annotation: { summary: { classes: ['Tumour'] } },
  pathways: { results: [] },
  states: { results: [] },
  enrichment: [],
  autocorrelation: [],
  graph: { diagnostics: { physicalEdges: 10 } },
};
const PREDICTION = {
  perturbationId: 'perturbation-test',
  direct: { terms: [], warnings: [], quantitative: true, method: 'perturb.direct' },
  propagation: { available: false, unavailableReason: 'no pack', modelId: null, modelVersion: null, members: 0, stageCaveat: '' },
  altered: { meanMagnitude: 0.1 },
  adverse: { components: [], offTargets: [], burden: 0, notInterpretable: false },
  uncertainty: {
    confidence: 'exploratory',
    rule: 'stated rule',
    domain: { status: 'in-domain', explanation: '' },
  },
};
const RESCUE = {
  eligible: [], excluded: [], drivers: [], retrievalNote: 'note',
  simulated: [{ candidateId: 'C1', name: 'ONE', components: [], adverseBurden: 0 }],
  comparison: { table: [], paretoFront: ['C1'], ranking: null, noClearWinner: 'no weights' },
};

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'spatial-report-'));
  store = new Store(dataRoot);

  app = Fastify({ logger: false });
  await app.register(fastifyCookie, { secret: config.session.secret });
  await registerRoutes(app, {
    catalogue: loadCatalogue(config.contentRoot),
    store,
    queue: new JobQueue({ concurrency: 1, maxQueued: 4, hardTimeoutMs: 5_000 }),
    ai: new AiAdapter(dataRoot),
    sessions,
  } satisfies Services);
  await app.ready();

  const identity: Identity = {
    userId: 'reporter-1', displayName: 'Reporter', email: null,
    roles: ['learner'], tier: 'expert', isReviewer: false, researchConsent: false,
  };
  const now = Date.now();
  const sessionId = 'sess-report';
  sessions.set(sessionId, {
    id: sessionId, identity, createdAt: now, expiresAt: now + 3_600_000,
    lastSeenAt: now, condition: null, hubToken: null,
  });
  cookie = `${SESSION_COOKIE}=${issueSessionToken(sessionId, now + 3_600_000)}`;

  const project = store.createProject({
    ownerId: 'reporter-1', title: 'Report', organism: 'Homo sapiens', tissue: 'tumour',
    condition: 'untreated', studyQuestion: 'q', mode: 'expert',
    datasetId: 'sim-tme-primary', datasetKind: 'bundled-case', referenceDatasetId: null,
  });
  projectId = project.projectId;

  const run = (kind: 'analysis' | 'prediction' | 'rescue', artefact: string, value: unknown): string => {
    const created = store.createRun({ projectId, ownerId: 'reporter-1', kind, perturbationId: null, seed: 1 });
    store.writeArtefact(created.runId, artefact, value);
    store.updateRun(created.runId, { status: 'complete', progress: 1 });
    return created.runId;
  };

  analysisRunId = run('analysis', 'analysis', ANALYSIS);
  predictionRunId = run('prediction', 'prediction', PREDICTION);
  store.writeArtefact(predictionRunId, 'validation-plan', { assay: { name: 'IHC' }, measure: ['TGFB1'] });
  rescueRunId = run('rescue', 'rescue', RESCUE);
});

afterAll(async () => {
  await app?.close();
  rmSync(dataRoot, { recursive: true, force: true });
});

async function report(runId: string): Promise<{
  sections: { number: number; title: string; present: boolean }[];
  assembledFrom: Record<string, string | null>;
}> {
  const response = await app.inject({ method: 'GET', url: `/api/v1/runs/${runId}/report`, headers: { cookie } });
  if (response.statusCode !== 200) throw new Error(`${response.statusCode}: ${response.body.slice(0, 600)}`);
  return response.json().report;
}

const present = (sections: { number: number; present: boolean }[]): number[] =>
  sections.filter((section) => section.present).map((section) => section.number);

describe('the assembled report', () => {
  it('is the same whichever of the project\'s runs is asked', async () => {
    const [fromAnalysis, fromPrediction, fromRescue] = await Promise.all([
      report(analysisRunId), report(predictionRunId), report(rescueRunId),
    ]);
    expect(present(fromPrediction.sections)).toEqual(present(fromAnalysis.sections));
    expect(present(fromRescue.sections)).toEqual(present(fromAnalysis.sections));
  });

  it('carries the analysis sections when asked on the prediction run', async () => {
    // 2 QC, 3 methods, 4 baseline — all written by the analysis run.
    expect(present((await report(predictionRunId)).sections)).toEqual(expect.arrayContaining([2, 3, 4]));
  });

  it('carries the rescue sections when asked on the analysis run', async () => {
    // 10 candidate evidence, 11 per-candidate simulations, 12 comparison.
    expect(present((await report(analysisRunId)).sections)).toEqual(expect.arrayContaining([10, 11, 12]));
  });

  it('carries the prediction sections and its validation plan from the prediction run', async () => {
    expect(present((await report(rescueRunId)).sections)).toEqual(expect.arrayContaining([5, 6, 7, 8, 9, 14]));
  });

  it('names the three runs it was assembled from', async () => {
    // A document stitched from three runs has to say which three; section 17's
    // manifest describes only one of them.
    const assembled = (await report(predictionRunId)).assembledFrom;
    expect(assembled).toEqual({
      requestedRun: predictionRunId,
      analysisRun: analysisRunId,
      predictionRun: predictionRunId,
      rescueRun: rescueRunId,
    });
  });

  it('leaves a section absent when no run produced it', async () => {
    const sections = (await report(analysisRunId)).sections;
    const byNumber = new Map(sections.map((section) => [section.number, section]));
    // 13 is never stored; 15 needs an uploaded observation nobody supplied.
    expect(byNumber.get(13)?.present).toBe(false);
    expect(byNumber.get(15)?.present).toBe(false);
  });
});

describe('a project with only an analysis run', () => {
  it('reports the later sections as absent rather than inventing them', async () => {
    const lone = store.createProject({
      ownerId: 'reporter-1', title: 'Lone', organism: 'Homo sapiens', tissue: 'tumour',
      condition: 'untreated', studyQuestion: 'q', mode: 'expert',
      datasetId: 'sim-tme-primary', datasetKind: 'bundled-case', referenceDatasetId: null,
    });
    const run = store.createRun({ projectId: lone.projectId, ownerId: 'reporter-1', kind: 'analysis', perturbationId: null, seed: 1 });
    store.writeArtefact(run.runId, 'analysis', ANALYSIS);
    store.updateRun(run.runId, { status: 'complete', progress: 1 });

    const sections = present((await report(run.runId)).sections);
    expect(sections).toEqual(expect.arrayContaining([1, 2, 3, 4]));
    // Nothing from another project leaks in: the lookup is scoped to this one.
    expect(sections).not.toContain(10);
    expect(sections).not.toContain(11);
  });
});
