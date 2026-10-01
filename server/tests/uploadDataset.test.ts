import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { issueSessionToken, type Identity, type Session } from '../src/auth';
import { config } from '../src/config';
import { loadCatalogue } from '../src/content/loader';
import { JobQueue } from '../src/jobs/queue';
import { AiAdapter } from '../src/ai/adapter';
import { registerRoutes, type Services } from '../src/routes/index';
import { SESSION_COOKIE } from '../src/routes/shared';
import { Store } from '../src/store';
import { readUploadedDataset } from '../src/uploadedDatasets';

let app: FastifyInstance;
let store: Store;
let dataRoot: string;
let cookie: string;
const sessions = new Map<string, Session>();

const body = {
  metadata: {
    datasetId: 'usr_test_upload',
    sampleId: 'sample-1',
    organism: 'Homo sapiens',
    tissue: 'tumour',
    condition: 'untreated',
    assay: 'spatial transcriptomics',
    platform: 'csv',
    resolution: 'cell',
    coordinateUnit: 'um',
    coordinateSystem: 'cartesian',
    featureNamespace: 'HGNC',
    preprocessingStatus: 'raw-counts',
    licence: 'test fixture',
  },
  matrix: {
    name: 'matrix.csv',
    text: 'observation_id,TGFB1,STAT3\nc1,10,2\nc2,4,9\nc3,1,3\n',
  },
  coordinates: {
    name: 'coords.csv',
    text: 'observation_id,x,y\nc1,0,0\nc2,10,0\nc3,0,10\n',
  },
  observationMetadata: {
    name: 'obs.csv',
    text: 'observation_id,cell_type,region\nc1,Tumour,core\nc2,T cell,edge\nc3,CAF,stroma\n',
  },
};

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'spatial-upload-'));
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
    userId: 'uploader-1', displayName: 'Uploader', email: null,
    roles: ['learner'], tier: 'expert', isReviewer: false, researchConsent: false,
  };
  const now = Date.now();
  sessions.set('sess-upload', {
    id: 'sess-upload', identity, createdAt: now, expiresAt: now + 3_600_000,
    lastSeenAt: now, condition: null, hubToken: null,
  });
  cookie = SESSION_COOKIE + '=' + issueSessionToken('sess-upload', now + 3_600_000);
});

afterAll(async () => {
  await app?.close();
  rmSync(dataRoot, { recursive: true, force: true });
});

async function createProject(): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/projects',
    headers: { cookie },
    payload: { title: 'Upload project', studyQuestion: 'q', mode: 'basic' },
  });
  expect(response.statusCode).toBe(201);
  return response.json().project.projectId;
}

describe('dataset upload registration', () => {
  it('canonicalises and attaches an uploaded tabular dataset to a draft project', async () => {
    const projectId = await createProject();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/' + projectId + '/datasets',
      headers: { cookie },
      payload: body,
    });

    expect(response.statusCode).toBe(201);
    const json = response.json();
    expect(json.project.datasetId).toBe('usr_test_upload');
    expect(json.project.datasetKind).toBe('upload');
    expect(json.project.completedStages).toContain('ingest');
    expect(json.dataset.observations).toBe(3);
    expect(json.dataset.features).toBe(2);

    const stored = readUploadedDataset(dataRoot, 'usr_test_upload');
    expect(stored?.observations).toHaveLength(3);
    expect(stored?.features.map((feature) => feature.symbol)).toEqual(['TGFB1', 'STAT3']);
  });

  it('refuses to replace the dataset after scientific state exists', async () => {
    const projectId = await createProject();
    store.completeStage(projectId, 'qc');
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/' + projectId + '/datasets',
      headers: { cookie },
      payload: { ...body, metadata: { ...body.metadata, datasetId: 'usr_second_upload' } },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toMatch(/computed scientific state/i);
  });

  it('gives conversion guidance instead of pretending to parse unsupported containers', async () => {
    const projectId = await createProject();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/' + projectId + '/datasets',
      headers: { cookie },
      payload: { ...body, matrix: { name: 'sample.h5ad', text: 'not really h5ad' } },
    });

    expect(response.statusCode).toBe(415);
    expect(response.json().error.suggestedAction).toContain('anndata');
  });
});
