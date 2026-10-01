/**
 * Security headers on the deployed HTTP surface.
 *
 * Route-level authorization prevents direct data disclosure. These assertions
 * keep the browser contract around that surface from drifting: no sniffing,
 * no framing, no referrer leakage, and no caching of API/project responses.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AiAdapter } from '../src/ai/adapter';
import { config } from '../src/config';
import { loadCatalogue } from '../src/content/loader';
import { JobQueue } from '../src/jobs/queue';
import { registerRoutes, type Services } from '../src/routes/index';
import { Store } from '../src/store';

let app: FastifyInstance;
let dataRoot: string;

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'spatial-security-'));
  const services: Services = {
    catalogue: loadCatalogue(config.contentRoot),
    store: new Store(dataRoot),
    queue: new JobQueue({ concurrency: 1, maxQueued: 4, hardTimeoutMs: 5_000 }),
    ai: new AiAdapter(dataRoot),
    sessions: new Map(),
  };

  app = Fastify({ logger: false });
  await app.register(fastifyCookie, { secret: config.session.secret });
  await registerRoutes(app, services);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  rmSync(dataRoot, { recursive: true, force: true });
});

describe('security headers', () => {
  it('sets a restrictive browser policy on API responses', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/meta' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['permissions-policy']).toContain('camera=()');
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });

  it('marks API and health responses as non-cacheable', async () => {
    const api = await app.inject({ method: 'GET', url: '/api/v1/meta' });
    const health = await app.inject({ method: 'GET', url: '/healthz' });

    expect(api.headers['cache-control']).toBe('no-store');
    expect(api.headers.pragma).toBe('no-cache');
    expect(health.headers['cache-control']).toBe('no-store');
  });
});
