/**
 * Submitting a run: turning an API request into a worker-backed pipeline
 * execution.
 *
 * The route handlers stay about authorisation and validation, the engine stays
 * about science, and this module is the one place that knows how a run is
 * assembled — which is the one place that has to be right about the order.
 *
 * Every stage runs in a worker thread. See `protocol.ts` for why: a synchronous
 * engine on the main thread blocks the event loop for tens of seconds, which
 * makes status polls unanswerable, health checks fail, and Fastify close
 * pooled sockets the moment the loop resumes.
 */

import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { config } from '../config';
import type { Identity } from '../auth';
import type { ProjectRecord, Store } from '../store';
import type { Services } from '../routes/index';
import type { StageId } from '@engine/pipeline';
import { DEFAULT_ANALYSIS } from './analysis';
import type { Handoff, WorkerMessage, WorkerResult, WorkerTask } from './protocol';
import type { JobContext } from './queue';

export interface RunOptions {
  seed: number;
  stages: number;
  perturbationId: string | null;
  runMechanisticReference: boolean;
  graphMethod: 'knn' | 'radius' | 'grid' | 'delaunay';
  graphK: number;
  permutations: number;
}

export interface SubmitInput {
  services: Services;
  project: ProjectRecord;
  identity: Identity;
  kind: 'analysis' | 'prediction' | 'rescue' | 'report';
  options: RunOptions;
}

const WORKER_PATH = join(__dirname, 'worker.js');

export function submitRun(input: SubmitInput): { accepted: boolean; runId: string; reason?: string } {
  const { services, project, identity, kind, options } = input;
  const { store, queue } = services;

  const run = store.createRun({
    projectId: project.projectId,
    ownerId: identity.userId,
    kind,
    perturbationId: options.perturbationId,
    seed: options.seed,
  });

  const submission = queue.submit(
    run.runId,
    async (context) => {
      store.updateRun(run.runId, { status: 'running', startedAt: new Date().toISOString() });
      await execute(input, run.runId, context);
    },
    (handle) => {
      store.updateRun(run.runId, {
        status: handle.status,
        finishedAt: handle.finishedAt ? new Date(handle.finishedAt).toISOString() : null,
        progress: handle.progress.fraction,
        currentStage: handle.progress.stage,
        completedStages: handle.progress.completed,
        error: handle.error
          ? { code: handle.error.code, message: handle.error.message, recoverable: handle.error.code === 'CANCELLED' }
          : null,
      });
    },
  );

  if (!submission.accepted) {
    store.updateRun(run.runId, {
      status: 'failed',
      error: { code: 'CAPACITY', message: submission.reason ?? 'Queue full.', recoverable: true },
      finishedAt: new Date().toISOString(),
    });
    return { accepted: false, runId: run.runId, reason: submission.reason ?? 'Queue full.' };
  }

  return { accepted: true, runId: run.runId };
}

// ---------------------------------------------------------------------------

async function execute(input: SubmitInput, runId: string, context: JobContext): Promise<void> {
  const { services, project, options } = input;
  const { store } = services;

  if (input.kind === 'report') {
    await context.report({ stage: 'report', fraction: 1, message: 'Report assembled' });
    store.completeStage(project.projectId, 'report');
    return;
  }

  if (!project.datasetId) throw new Error('This project has no dataset selected.');

  const task = buildTask(input, runId);
  const result = await runInWorker(task, store, runId, context);

  switch (result.kind) {
    case 'analysis': {
      store.writeArtefact(runId, 'handoff', result.handoff);
      store.updateRun(runId, { manifest: result.artefacts.manifest });
      for (const stage of ['qc', 'preprocess', 'annotate', 'baseline', 'spatial', 'communication'] as StageId[]) {
        store.completeStage(project.projectId, stage);
      }
      break;
    }
    case 'prediction': {
      /*
       * The altered state is persisted, not held in memory.
       *
       * §2's workflow rule requires every rescue candidate to be simulated
       * against *the same* altered tissue state. An in-memory cache satisfies
       * that until the process restarts, after which it silently rebuilds a
       * state that is close but not provably identical. Writing it down means
       * the rescue stage reads the state the prediction actually produced.
       */
      store.writeArtefact(runId, 'altered-state', {
        activity: result.alteredActivity,
        perturbationDelta: result.perturbationDelta,
        sourceRunId: runId,
      });
      store.updateRun(runId, { manifest: result.manifest });
      for (const stage of ['direct-response', 'graph', 'propagation', 'altered-tissue', 'adverse', 'uncertainty'] as StageId[]) {
        store.completeStage(project.projectId, stage);
      }
      break;
    }
    case 'rescue': {
      for (const stage of ['candidates', 'rescue-simulations', 'comparison'] as StageId[]) {
        store.completeStage(project.projectId, stage);
      }
      break;
    }
  }

  void options;
}

function buildTask(input: SubmitInput, runId: string): WorkerTask {
  const { services, project, options } = input;
  const { store } = services;
  const caseId = project.datasetId as string;
  const datasetKind = project.datasetKind ?? 'bundled-case';
  const referenceCaseId = project.referenceDatasetId;

  if (input.kind === 'analysis') {
    return {
      kind: 'analysis',
      runId,
      contentRoot: config.contentRoot,
      dataRoot: store.dataRoot,
      seed: options.seed,
      caseId,
      datasetKind,
      referenceCaseId,
      options: {
        ...DEFAULT_ANALYSIS,
        graphMethod: options.graphMethod,
        graphK: options.graphK,
        permutations: options.permutations,
        seed: options.seed,
      },
    };
  }

  const handoff = mostRecentArtefact<Handoff>(store, project, 'handoff');
  if (!handoff) {
    throw new Error('The baseline analysis has not produced a spatial graph yet. Run it first.');
  }

  if (input.kind === 'prediction') {
    if (!options.perturbationId) throw new Error('No perturbation was named for this run.');
    const definition = store.getDefinition(options.perturbationId);
    if (!definition) throw new Error(`No such perturbation: ${options.perturbationId}`);

    const analysisRunId = mostRecentRunId(store, project, 'analysis');
    const analysis = analysisRunId
      ? store.readArtefact<{ comparability: { comparable: boolean } | null }>(analysisRunId, 'analysis')
      : null;

    return {
      kind: 'prediction',
      runId,
      contentRoot: config.contentRoot,
      dataRoot: store.dataRoot,
      seed: options.seed,
      caseId,
      datasetKind,
      referenceCaseId,
      definition,
      handoff,
      stages: options.stages,
      runMechanisticReference: options.runMechanisticReference,
      referenceComparable: analysis?.comparability?.comparable ?? false,
    };
  }

  const predictionRunId = mostRecentRunId(store, project, 'prediction');
  const altered = predictionRunId
    ? store.readArtefact<{ activity: number[]; perturbationDelta: number[] }>(predictionRunId, 'altered-state')
    : null;
  if (!altered) {
    throw new Error(
      'No altered tissue state is stored for this project. Run a prediction first — every rescue candidate has to be applied to the same altered state.',
    );
  }

  return {
    kind: 'rescue',
    runId,
    contentRoot: config.contentRoot,
    dataRoot: store.dataRoot,
    seed: options.seed,
    caseId,
    datasetKind,
    referenceCaseId,
    handoff,
    alteredActivity: altered.activity,
    perturbationDelta: altered.perturbationDelta,
    stages: options.stages,
    maximumCandidates: config.runs.maximumRescueCandidates,
  };
}

function mostRecentRunId(store: Store, project: ProjectRecord, kind: string): string | null {
  const runs = store.listRuns(project.projectId).filter((run) => run.kind === kind && run.status === 'complete');
  return runs.length > 0 ? (runs[runs.length - 1] as { runId: string }).runId : null;
}

function mostRecentArtefact<T>(store: Store, project: ProjectRecord, name: string): T | null {
  const runs = store.listRuns(project.projectId).filter((run) => run.status === 'complete');
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const found = store.readArtefact<T>((runs[i] as { runId: string }).runId, name);
    if (found) return found;
  }
  return null;
}

/**
 * Runs a task in a worker and settles when it finishes.
 *
 * The worker is terminated on cancellation and on the hard timeout, neither of
 * which needs the job's cooperation — which is the point of the arrangement. A
 * worker that exits non-zero without having sent a result is reported as a
 * crash rather than as a silent success.
 */
function runInWorker(
  task: WorkerTask,
  store: Store,
  runId: string,
  context: JobContext,
): Promise<WorkerResult> {
  return new Promise<WorkerResult>((resolve, reject) => {
    const worker = new Worker(WORKER_PATH, {
      workerData: task,
      resourceLimits: {
        // A pathological input kills the worker, not the server.
        maxOldGenerationSizeMb: 2048,
      },
    });

    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      context.signal.removeEventListener('abort', onAbort);
      void worker.terminate();
      fn();
    };

    const deadline = setTimeout(() => {
      finish(() =>
        reject(
          new Error(
            `The run exceeded its ${Math.round(config.runs.hardTimeoutMs / 1000)} second budget and was stopped. Artefacts written before the stop are kept.`,
          ),
        ),
      );
    }, config.runs.hardTimeoutMs);

    const onAbort = (): void => {
      finish(() => reject(new Error('The run was cancelled.')));
    };
    context.signal.addEventListener('abort', onAbort, { once: true });

    worker.on('message', (message: WorkerMessage) => {
      switch (message.type) {
        case 'progress':
          void context.report({
            stage: message.stage,
            completed: message.completed,
            fraction: message.fraction,
            message: message.message,
          });
          store.updateRun(runId, {
            currentStage: message.stage,
            completedStages: message.completed,
            progress: message.fraction,
          });
          break;
        case 'artefact':
          store.writeArtefact(runId, message.name, message.value);
          break;
        case 'done':
          finish(() => resolve(message.result));
          break;
        case 'error':
          finish(() => reject(new Error(message.message)));
          break;
      }
    });

    worker.on('error', (error) => {
      finish(() => reject(error));
    });

    worker.on('exit', (code) => {
      if (settled) return;
      finish(() =>
        reject(
          new Error(
            code === 0
              ? 'The worker exited without returning a result.'
              : `The worker exited with code ${code}. If this was a memory limit, the run is too large for this deployment.`,
          ),
        ),
      );
    });
  });
}
