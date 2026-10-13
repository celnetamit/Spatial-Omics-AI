/**
 * Server entry point.
 *
 * One process, one port: the API and the built client together. That is forced
 * rather than chosen. §16.2 requires authorisation on every API and §3 gates
 * Advanced mode on a tier the hub decides — and a static bundle cannot keep a
 * decision from the browser it is sent to. Every disclosure choice is taken
 * here, where the data is.
 *
 * Startup is deliberately noisy about configuration and content. An operator
 * who has deployed without a model pack, or with research exports on, should
 * learn that from the boot log rather than from a confused user weeks later.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { LogController } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { config, startupWarnings } from './config';
import { loadCatalogue } from './content/loader';
import { Store } from './store';
import { JobQueue } from './jobs/queue';
import { AiAdapter } from './ai/adapter';
import { registerRoutes, type Services } from './routes/index';
import type { Session } from './auth';

async function main(): Promise<void> {
  const app = Fastify({
    logger: {
      level: config.isProduction ? 'info' : 'debug',
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    trustProxy: true,
    bodyLimit: config.runs.maximumUploadMb * 1024 * 1024,
    // Per-request lines are noise in production and the only way to see what a
    // development client is doing. The top-level `disableRequestLogging` says
    // the same thing and is deprecated in Fastify 5, removed in 6.
    logController: new LogController({ disableRequestLogging: config.isProduction }),
  });

  for (const warning of startupWarnings()) app.log.warn(warning);

  // -- content --------------------------------------------------------------

  const catalogue = loadCatalogue(config.contentRoot);
  for (const problem of catalogue.problems) {
    const line = `[content] ${problem.component}: ${problem.message}`;
    if (problem.severity === 'error') app.log.error(line);
    else app.log.warn(line);
  }

  app.log.info(
    `[content] ${catalogue.cases.size} case(s), ` +
      `${catalogue.network.nodes.length} network node(s), ` +
      `model pack ${catalogue.modelPack ? `${catalogue.modelPack.modelId}@${catalogue.modelPack.version} (${catalogue.modelPack.members.length} member(s))` : 'ABSENT'}, ` +
      `drug evidence ${catalogue.drugEvidence ? `${catalogue.drugEvidence.records.length} compound(s)` : 'ABSENT'}`,
  );

  /*
   * A case with no cells is served to nobody.
   *
   * The loader already refuses a case whose node list does not match the
   * network, because that one produces a plausible tissue in which nothing
   * means what it says. This is the cheaper sibling: an empty case would render
   * as a blank canvas and look like a rendering bug for as long as it took
   * somebody to check the file.
   */
  for (const [id, loaded] of [...catalogue.cases]) {
    if (loaded.dataset.observations.length === 0 || loaded.dataset.features.length === 0) {
      app.log.error(`[content] case ${id} has no observations or no features; withholding it.`);
      catalogue.cases.delete(id);
    }
  }

  // -- services -------------------------------------------------------------

  const store = new Store(config.dataRoot);
  const interrupted = store.failInterruptedRuns();
  if (interrupted > 0) app.log.warn(`[runs] marked ${interrupted} run(s) interrupted by the restart as failed`);
  const queue = new JobQueue({
    concurrency: config.runs.concurrency,
    maxQueued: config.runs.maxQueued,
    hardTimeoutMs: config.runs.hardTimeoutMs,
  });
  const ai = new AiAdapter(config.dataRoot);
  const sessions = new Map<string, Session>();

  const services: Services = { catalogue, store, queue, ai, sessions };

  const housekeeping = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (session.expiresAt < now) sessions.delete(id);
    }
    queue.prune();
    store.flush();
  }, 60_000);
  housekeeping.unref();

  // -- plugins and routes ---------------------------------------------------

  await app.register(fastifyCookie, { secret: config.session.secret });
  await registerRoutes(app, services);

  const staticRoot = config.staticRoot;
  const hasClient = existsSync(join(staticRoot, 'index.html'));
  if (hasClient) {
    await app.register(fastifyStatic, {
      root: staticRoot,
      /*
       * `index: ['index.html']`, not `index: false`.
       *
       * The hub launches this lab at its root URL. A static plugin configured
       * without an index leaves `GET /` returning 403 while every other route
       * works — which is the first thing a learner meets and a genuinely
       * confusing failure to diagnose.
       */
      index: ['index.html'],
      wildcard: false,
      cacheControl: true,
      maxAge: config.isProduction ? '1h' : 0,
      immutable: false,
    });

  } else {
    app.log.warn(
      `[static] no built client at ${staticRoot}; the API is served but the application is not. Run \`npm run build\`.`,
    );
  }

  {
    // Exactly one not-found handler. Fastify refuses a second for the same
    // prefix, and the refusal is thrown at startup — so a duplicate does not
    // fail a request, it fails the boot.
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.code(404).send({
          error: {
            code: 'NOT_FOUND',
            message: `No such endpoint: ${request.method} ${request.url}`,
            requestId: String(request.id),
            fieldErrors: [],
            recoverable: false,
            suggestedAction: 'Check the API map in §10.1.',
          },
        });
      }
      /*
       * Client-side routes fall back to the shell — but only for extension-less
       * GETs. A missing asset should 404 so a broken reference is visible,
       * rather than returning HTML the browser then fails to parse as
       * JavaScript.
       */
      if (hasClient && request.method === 'GET' && !/\.[a-zA-Z0-9]{1,8}(\?|$)/.test(request.url)) {
        return reply.type('text/html').sendFile('index.html');
      }
      return reply.code(404).send({
        error: {
          code: 'NOT_FOUND',
          message: hasClient ? 'Not found.' : 'No built client is installed in this deployment.',
          requestId: String(request.id),
          fieldErrors: [],
          recoverable: false,
          suggestedAction: hasClient ? '' : 'Run `npm run build`.',
        },
      });
    });
  }

  // -- lifecycle ------------------------------------------------------------

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`[shutdown] ${signal} received; flushing and closing`);
    clearInterval(housekeeping);
    store.close();
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('uncaughtException', (error) => {
    app.log.error({ err: error }, '[fatal] uncaught exception');
    try {
      store.close();
    } finally {
      process.exit(1);
    }
  });

  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    `[ready] Spatial Omics AI Virtual LiveLab ${config.version} on ${config.host}:${config.port} — ` +
      `${catalogue.cases.size} case(s), AI ${ai.available ? 'on' : 'off'}, auth ${config.auth.enabled ? 'on' : 'OFF'}`,
  );
}

main().catch((error) => {
  process.stderr.write(`Spatial Omics AI Virtual LiveLab failed to start: ${String(error)}\n`);
  process.exit(1);
});
