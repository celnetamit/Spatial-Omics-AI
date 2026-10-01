/**
 * The scientific worker.
 *
 * One task, one thread, one exit. It loads only what it needs, runs the stage,
 * streams progress and artefacts back to the parent, and ends. Nothing here
 * touches the store or the network — the parent owns both — so a worker that
 * dies takes nothing with it but its own run.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { buildSpatialGraph, type GraphEdge, type SpatialGraph } from '@engine/spatial/graph';
import type { SpatialDataset, DatasetView } from '@engine/data/types';
import { buildAdjacency } from '@engine/spatial/graph';
import { sectionProfile } from '@engine/rescue/comparison';
import type { TissueState } from '@engine/propagate/mechanism';
import type { PerturbationDefinition } from '@engine/perturb/types';
import { loadCatalogue, type LoadedCase } from '../content/loader';
import { readUploadedDataset } from '../uploadedDatasets';
import { estimateState } from '@engine/propagate/stateEstimate';
import { runAnalysis } from './analysis';
import { runPrediction } from './prediction';
import { runRescue } from './rescue';
import type { Handoff, WorkerMessage, WorkerTask } from './protocol';
import type { JobContext } from './queue';

const port = parentPort;
if (!port) throw new Error('This module must be run as a worker thread.');

const task = workerData as WorkerTask;

function send(message: WorkerMessage): void {
  port?.postMessage(message);
}

/**
 * A job context that reports to the parent.
 *
 * `checkpoint` is a no-op beyond the cancellation check: the worker owns its
 * own thread, so there is no event loop to yield to and nothing to starve. The
 * parent enforces the hard timeout by terminating the thread, which does not
 * require the job's cooperation.
 */
const context: JobContext = {
  signal: new AbortController().signal,
  report: async (progress) => {
    send({
      type: 'progress',
      stage: progress.stage ?? null,
      completed: progress.completed ?? [],
      fraction: progress.fraction ?? 0,
      message: progress.message ?? '',
    });
  },
  checkpoint: async () => {},
};

/**
 * A store stand-in that forwards writes to the parent.
 *
 * The worker must not open the append-only log: two threads appending to it
 * would interleave and neither would hold the other's index. Every artefact the
 * pipeline writes is posted instead, and the parent writes it.
 */
const forwardingStore = {
  writeArtefact(runId: string, name: string, value: unknown): string {
    send({ type: 'artefact', name, value });
    return `${runId}/${name}`;
  },
  readArtefact(): null {
    return null;
  },
  listArtefacts(): string[] {
    return [];
  },
  getDefinition(): undefined {
    return undefined;
  },
  completeStage(): undefined {
    return undefined;
  },
  audit(): void {},
} as unknown as import('../store').Store;

function rehydrateGraph(handoff: Handoff): SpatialGraph {
  const edges: GraphEdge[] = handoff.graph.edges.map((edge) => ({
    source: edge.source,
    target: edge.target,
    distance: edge.distance,
    weight: edge.weight,
    edgeType: edge.edgeType,
    ...(edge.interaction ? { interaction: edge.interaction } : {}),
  }));
  return {
    graphId: handoff.graph.graphId,
    method: handoff.graph.method as SpatialGraph['method'],
    parameters: handoff.graph.parameters as unknown as SpatialGraph['parameters'],
    nodeCount: handoff.graph.nodeCount,
    edges,
    adjacency: buildAdjacency(handoff.graph.nodeCount, edges),
    coordinateUnit: handoff.graph.coordinateUnit,
    checksum: handoff.graph.checksum,
    version: handoff.graph.version,
    diagnostics: handoff.graph.diagnostics as unknown as SpatialGraph['diagnostics'],
  };
}

function toHandoff(graph: SpatialGraph, labels: (string | undefined)[], regions: (string | undefined)[]): Handoff {
  return {
    graph: {
      graphId: graph.graphId,
      method: graph.method,
      parameters: graph.parameters as unknown as Record<string, unknown>,
      coordinateUnit: graph.coordinateUnit,
      checksum: graph.checksum,
      version: graph.version,
      edges: graph.edges.map((edge) => ({
        source: edge.source,
        target: edge.target,
        distance: edge.distance,
        weight: edge.weight,
        edgeType: edge.edgeType,
        ...(edge.interaction ? { interaction: edge.interaction } : {}),
      })),
      nodeCount: graph.nodeCount,
      diagnostics: graph.diagnostics as unknown as Record<string, unknown>,
    },
    labels: labels.map((label) => label ?? null),
    regions: regions.map((region) => region ?? null),
  };
}

function stateOf(loaded: LoadedCase): TissueState {
  return {
    activity: loaded.state.truth,
    observationCount: loaded.state.observationCount,
    nodeCount: loaded.state.nodeCount,
  };
}

function rawView(dataset: SpatialDataset): DatasetView {
  return {
    datasetId: dataset.metadata.datasetId,
    sourceRevision: dataset.revision,
    viewId: dataset.revision + ':raw-upload-view',
    transforms: ['uploaded raw matrix used for proxy state estimation'],
    observations: dataset.observations,
    features: dataset.features,
    matrix: dataset.matrix,
    featureSubset: false,
    scale: dataset.metadata.preprocessingStatus === 'raw-counts' ? 'counts' : 'other',
  };
}

function estimatedUploadState(dataset: SpatialDataset, catalogue: ReturnType<typeof loadCatalogue>): {
  state: TissueState;
  capacity: Float64Array;
  exogenous: Float64Array;
  ligandReference: Float64Array;
  warnings: string[];
} {
  const estimate = estimateState(rawView(dataset), catalogue.network);
  const length = estimate.state.observationCount * estimate.state.nodeCount;
  return {
    state: estimate.state,
    capacity: new Float64Array(length).fill(1),
    exogenous: new Float64Array(length),
    ligandReference: new Float64Array(estimate.state.nodeCount),
    warnings: [estimate.method.summary, ...estimate.warnings],
  };
}

async function main(): Promise<void> {
  const catalogue = loadCatalogue(task.contentRoot);
  const loadedCase = task.datasetKind === 'bundled-case' ? catalogue.cases.get(task.caseId) : undefined;
  const uploadedDataset = task.datasetKind === 'upload' ? readUploadedDataset(task.dataRoot, task.caseId) : null;
  if (!loadedCase && !uploadedDataset) throw new Error(`Dataset "${task.caseId}" is not available to this worker.`);
  const primaryDataset = loadedCase?.dataset ?? uploadedDataset as SpatialDataset;
  const referenceCase = task.referenceCaseId ? catalogue.cases.get(task.referenceCaseId) : undefined;

  if (task.kind === 'analysis') {
    const result = await runAnalysis(context, {
      runId: task.runId,
      projectId: '',
      dataset: primaryDataset,
      referenceDataset: referenceCase?.dataset ?? null,
      loadedCase: loadedCase ?? null,
      catalogue,
      options: task.options,
      store: forwardingStore,
    });
    send({
      type: 'done',
      result: {
        kind: 'analysis',
        artefacts: result.artefacts,
        handoff: toHandoff(result.state.graph, result.state.labels, result.state.regions),
      },
    });
    return;
  }

  if (task.kind === 'prediction') {
    const graph = rehydrateGraph(task.handoff);
    const definition = task.definition as PerturbationDefinition;
    const uploadedState = loadedCase ? null : estimatedUploadState(primaryDataset, catalogue);
    const baseline = loadedCase ? stateOf(loadedCase) : (uploadedState as NonNullable<typeof uploadedState>).state;
    const manifest = {
      runId: task.runId,
      createdAt: new Date().toISOString(),
      engineVersion: '1.0.0',
      datasets: [
        {
          datasetId: primaryDataset.metadata.datasetId,
          revision: primaryDataset.revision,
          sha256: primaryDataset.checksum,
          role: 'primary',
        },
      ],
      methods: [],
      parameterPack: { id: 'v1-parameter-registry', version: catalogue.parameters.version },
      graph: {
        graphId: graph.graphId,
        method: graph.method,
        checksum: graph.checksum,
        parameters: graph.parameters as unknown as Record<string, unknown>,
      },
      model: null,
      evidenceSnapshot: catalogue.drugEvidence
        ? {
            id: catalogue.drugEvidence.packId,
            retrievedAt: catalogue.drugEvidence.retrievedAt,
            sources: [catalogue.drugEvidence.source.database],
          }
        : null,
      ai: null,
      seed: task.seed,
      repeatId: 0,
      warnings: [] as string[],
      outOfDomain: [] as string[],
      confidence: 'moderate',
      artefacts: [] as { id: string; kind: string; checksum: string }[],
      timings: [] as { stage: string; milliseconds: number }[],
    };

    const spec = definition.spec;
    const concentrationNm =
      spec.branch === 'drug'
        ? spec.concentration * (spec.concentrationUnit === 'uM' ? 1e3 : spec.concentrationUnit === 'mM' ? 1e6 : 1)
        : null;

    if (uploadedState) manifest.warnings.push(...uploadedState.warnings);

    const result = await runPrediction(context, {
      runId: task.runId,
      definition,
      network: catalogue.network,
      baseline,
      capacity: { values: loadedCase ? loadedCase.state.capacity : (uploadedState as NonNullable<typeof uploadedState>).capacity },
      exogenous: { values: loadedCase ? loadedCase.state.exogenous : (uploadedState as NonNullable<typeof uploadedState>).exogenous },
      ligandReference: loadedCase ? loadedCase.state.ligandReference : (uploadedState as NonNullable<typeof uploadedState>).ligandReference,
      graph,
      observations: primaryDataset.observations,
      labels: task.handoff.labels.map((label) => label ?? undefined),
      catalogue,
      store: forwardingStore,
      stages: task.stages,
      seed: task.seed,
      mechanismAvailable: Boolean(loadedCase),
      runMechanisticReference: task.runMechanisticReference,
      referenceProfile: referenceCase ? sectionProfile(stateOf(referenceCase)) : null,
      referenceComparable: task.referenceComparable,
      offTargets: [],
      concentrationNm,
      manifest,
    });

    send({
      type: 'done',
      result: {
        kind: 'prediction',
        artefacts: result.artefacts,
        alteredActivity: Array.from(result.alteredState.activity),
        perturbationDelta: Array.from(result.difference.nodeMeanDelta),
        manifest,
      },
    });
    return;
  }

  const graph = rehydrateGraph(task.handoff);
  const uploadedState = loadedCase ? null : estimatedUploadState(primaryDataset, catalogue);
  const baseline = loadedCase ? stateOf(loadedCase) : (uploadedState as NonNullable<typeof uploadedState>).state;
  const altered: TissueState = {
    activity: Float64Array.from(task.alteredActivity),
    observationCount: baseline.observationCount,
    nodeCount: baseline.nodeCount,
  };

  const artefacts = await runRescue(context, {
    runId: task.runId,
    network: catalogue.network,
    baseline,
    altered,
    capacity: { values: loadedCase ? loadedCase.state.capacity : (uploadedState as NonNullable<typeof uploadedState>).capacity },
    exogenous: { values: loadedCase ? loadedCase.state.exogenous : (uploadedState as NonNullable<typeof uploadedState>).exogenous },
    graph,
    observations: primaryDataset.observations,
    labels: task.handoff.labels.map((label) => label ?? undefined),
    catalogue,
    store: forwardingStore,
    stages: task.stages,
    seed: task.seed,
    maximumCandidates: task.maximumCandidates,
    referenceProfile: referenceCase ? sectionProfile(stateOf(referenceCase)) : null,
    referenceComparable: referenceCase !== undefined,
    policy: null,
    datasetOrganism: primaryDataset.metadata.organism,
    datasetTissue: primaryDataset.metadata.tissue,
  });

  send({ type: 'done', result: { kind: 'rescue', artefacts } });
}

main().catch((error) => {
  send({
    type: 'error',
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? (error.stack ?? null) : null,
  });
  process.exit(1);
});

void buildSpatialGraph;
