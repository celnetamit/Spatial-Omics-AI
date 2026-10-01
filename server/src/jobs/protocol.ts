/**
 * The message protocol between the server and a scientific worker.
 *
 * WHY A WORKER AT ALL
 *
 * The engine is synchronous by design — it is pure computation over typed
 * arrays with no I/O to await — and a single analysis stage runs for tens of
 * seconds. On the main thread that blocks the event loop for the whole stage,
 * and the consequences are not subtle: status polls cannot be answered, so the
 * run looks hung; `/healthz` cannot be answered, so an orchestrator restarts
 * the container mid-run; and Fastify's keep-alive timer fires the moment the
 * loop resumes, closing pooled sockets so the *next* client request is reset.
 * That last one is how this was found — the client saw ECONNRESET at 76% and
 * the server log showed nothing at all, because nothing had gone wrong with the
 * computation.
 *
 * Putting the work in a worker fixes all three, and adds two properties worth
 * having on their own: a heap cap, so a pathological input kills the worker
 * rather than the server, and a hard wall-clock kill that does not depend on
 * the job cooperating.
 *
 * WHAT CROSSES THE BOUNDARY
 *
 * Structured-cloneable data only. The worker loads the case it needs from disk
 * itself rather than receiving a three-megabyte dataset, and hands back
 * artefacts plus a small `handoff` — the graph and the labels — that the next
 * stage needs. The store stays on the main thread: two threads appending to the
 * same log would interleave and neither would hold the other's index.
 */

import type { StageId } from '@engine/pipeline';
import type { AnalysisArtefacts, AnalysisOptions } from './analysis';
import type { PredictionArtefacts } from './prediction';
import type { RescueArtefacts } from './rescue';

export interface WorkerTaskBase {
  runId: string;
  contentRoot: string;
  dataRoot: string;
  seed: number;
}

export interface AnalysisTask extends WorkerTaskBase {
  kind: 'analysis';
  caseId: string;
  datasetKind: 'bundled-case' | 'upload';
  referenceCaseId: string | null;
  options: AnalysisOptions;
}

export interface PredictionTask extends WorkerTaskBase {
  kind: 'prediction';
  caseId: string;
  datasetKind: 'bundled-case' | 'upload';
  referenceCaseId: string | null;
  definition: unknown;
  handoff: Handoff;
  stages: number;
  runMechanisticReference: boolean;
  referenceComparable: boolean;
}

export interface RescueTask extends WorkerTaskBase {
  kind: 'rescue';
  caseId: string;
  datasetKind: 'bundled-case' | 'upload';
  referenceCaseId: string | null;
  handoff: Handoff;
  /** The altered tissue every candidate is applied to, as a flat array. */
  alteredActivity: number[];
  perturbationDelta: number[];
  stages: number;
  maximumCandidates: number;
}

export type WorkerTask = AnalysisTask | PredictionTask | RescueTask;

/**
 * What one stage hands the next.
 *
 * Deliberately small and explicit. An earlier design kept the live objects in a
 * module-level map on the main thread, which worked until a restart and then
 * silently rebuilt a graph that was not the one the prediction had used.
 * Serialising it means the next stage reads the graph that actually ran.
 */
export interface Handoff {
  graph: {
    graphId: string;
    method: string;
    parameters: Record<string, unknown>;
    coordinateUnit: string;
    checksum: string;
    version: string;
    edges: { source: number; target: number; distance: number; weight: number; edgeType: 'physical' | 'biological'; interaction?: string }[];
    nodeCount: number;
    diagnostics: Record<string, unknown>;
  };
  labels: (string | null)[];
  regions: (string | null)[];
}

export type WorkerMessage =
  | { type: 'progress'; stage: StageId | null; completed: StageId[]; fraction: number; message: string }
  | { type: 'artefact'; name: string; value: unknown }
  | { type: 'done'; result: WorkerResult }
  | { type: 'error'; message: string; stack: string | null };

export type WorkerResult =
  | { kind: 'analysis'; artefacts: AnalysisArtefacts; handoff: Handoff }
  | {
      kind: 'prediction';
      artefacts: PredictionArtefacts;
      alteredActivity: number[];
      perturbationDelta: number[];
      manifest: AnalysisArtefacts['manifest'];
    }
  | { kind: 'rescue'; artefacts: RescueArtefacts };
