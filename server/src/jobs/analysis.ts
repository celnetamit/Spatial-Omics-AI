/**
 * The baseline analysis pipeline — §2 steps 02 to 04.
 *
 * QC, preprocessing, annotation, differential features, pathway activity, cell
 * states, the spatial graph, neighbourhood enrichment, spatial autocorrelation
 * and candidate communication. Each stage writes its own artefact so a later
 * stage reads a stored object rather than a value held in a closure, and so a
 * report can be regenerated from storage without re-running anything.
 *
 * Everything is computed on the server. The client never receives a matrix it
 * could recompute a different answer from, which is what keeps "the number on
 * screen" and "the number in the report" the same number.
 */

import { RandomState } from '@engine/core/rng';
import { emptyManifest, type ReproducibilityManifest } from '@engine/core/provenance';
import { runQc, assessComparability, type QcReport, type ComparabilityResult } from '@engine/qc/index';
import { preprocess, DEFAULT_PREPROCESSING, type PreprocessingRun } from '@engine/preprocess/index';
import {
  annotationSummary, panelCoverage, scoreMarkerPanel, useProvidedAnnotations, type AnnotationSet,
} from '@engine/annotate/index';
import {
  cellStateScores, differentialFeatures, pathwayActivity, DEFAULT_DIFFERENTIAL, DEFAULT_PATHWAY,
  type CellStateScore, type FeatureStatistic, type PathwayActivity,
} from '@engine/baseline/index';
import { buildSpatialGraph, type SpatialGraph } from '@engine/spatial/graph';
import {
  neighbourhoodEnrichment, spatialAutocorrelation, spatialDomains,
  type SpatialAutocorrelation, type SpatialDomains,
} from '@engine/spatial/neighbourhood';
import {
  spatialCommunication, summariseByClass, DEFAULT_COMMUNICATION, type CommunicationResult,
} from '@engine/spatial/communication';
import { featureVector, type DatasetView, type SpatialDataset } from '@engine/data/types';
import { ligandReceptorEdges } from '@engine/validate/corpus';
import type { JobContext } from './queue';
import type { Catalogue, LoadedCase } from '../content/loader';
import type { Store } from '../store';

export interface AnalysisOptions {
  /** Graph parameters, defaulting to the model pack's training configuration. */
  graphMethod: 'knn' | 'radius' | 'grid' | 'delaunay';
  graphK: number;
  graphRadius: number | null;
  permutations: number;
  /** Spatial domains to detect, or 0 to skip. */
  domains: number;
  /** Permutations for the communication null. */
  communicationPermutations: number;
  seed: number;
}

export const DEFAULT_ANALYSIS: AnalysisOptions = {
  graphMethod: 'knn',
  graphK: 6,
  graphRadius: null,
  permutations: 1000,
  domains: 5,
  communicationPermutations: 200,
  seed: 20260821,
};

/**
 * A QC report with its typed arrays flattened.
 *
 * `JSON.stringify` turns a Float64Array into `{"0":1,"1":2,…}`, which parses
 * back as an object and breaks every consumer that expects to index it. The
 * conversion is explicit here rather than left to a replacer, because a
 * replacer would catch it in the artefact and miss it in the API response.
 */
export interface SerialisableQc extends Omit<QcReport, 'observationMetrics' | 'featureMetrics'> {
  observationMetrics: {
    totalCounts: number[];
    detectedFeatures: number[];
    mitochondrialFraction: number[] | null;
    lowCountOutlier: number[];
    highCountOutlier: number[];
  };
  featureMetrics: {
    detectionRate: number[];
    meanValue: number[];
    varianceValue: number[];
  };
}

export function serialisableQc(report: QcReport): SerialisableQc {
  return {
    ...report,
    observationMetrics: {
      totalCounts: Array.from(report.observationMetrics.totalCounts),
      detectedFeatures: Array.from(report.observationMetrics.detectedFeatures),
      mitochondrialFraction: report.observationMetrics.mitochondrialFraction
        ? Array.from(report.observationMetrics.mitochondrialFraction)
        : null,
      lowCountOutlier: Array.from(report.observationMetrics.lowCountOutlier),
      highCountOutlier: Array.from(report.observationMetrics.highCountOutlier),
    },
    featureMetrics: {
      detectionRate: Array.from(report.featureMetrics.detectionRate),
      meanValue: Array.from(report.featureMetrics.meanValue),
      varianceValue: Array.from(report.featureMetrics.varianceValue),
    },
  };
}

export interface AnalysisArtefacts {
  qc: SerialisableQc;
  comparability: ComparabilityResult | null;
  preprocessing: {
    parameters: typeof DEFAULT_PREPROCESSING;
    keptObservations: number;
    keptFeatures: number;
    warnings: string[];
    embeddingComponents: number;
    explainedVariance: number[];
  };
  annotation: {
    source: AnnotationSet['source'];
    classes: string[];
    labels: (string | undefined)[];
    confidence: number[];
    unassigned: number;
    exploratory: boolean;
    summary: ReturnType<typeof annotationSummary>;
    panelCoverage: ReturnType<typeof panelCoverage> | null;
  };
  regions: { labels: (string | undefined)[]; classes: string[]; source: string };
  domains: {
    assignment: number[];
    domainCount: number;
    spatialCoherence: number;
    sizes: number[];
  } | null;
  differential: { results: FeatureStatistic[]; skipped: string[] };
  pathways: {
    results: Omit<PathwayActivity, 'scores'>[];
    /** Per-pathway per-cell scores, for the map layer. */
    scores: Record<string, number[]>;
  };
  states: {
    results: Omit<CellStateScore, 'scores'>[];
    scores: Record<string, number[]>;
    dominant: (string | undefined)[];
  };
  graph: {
    graphId: string;
    method: string;
    parameters: Record<string, unknown>;
    checksum: string;
    diagnostics: SpatialGraph['diagnostics'];
    /** Edges, for the overlay. Capped; the cap is reported. */
    edgeSample: { source: number; target: number; type: string }[];
    edgeSampleCap: number;
  };
  enrichment: {
    labels: string[];
    observed: number[];
    zScore: number[];
    qValue: number[];
    permutations: number;
  };
  autocorrelation: SpatialAutocorrelation[];
  communication: {
    results: Omit<CommunicationResult, 'edges' | 'sent' | 'received'>[];
    byClass: Record<string, ReturnType<typeof summariseByClass>>;
    sent: Record<string, number[]>;
    received: Record<string, number[]>;
  };
  manifest: ReproducibilityManifest;
}

/** Kept in memory for the prediction stage, which needs the live objects. */
export interface AnalysisState {
  dataset: SpatialDataset;
  view: DatasetView;
  graph: SpatialGraph;
  labels: (string | undefined)[];
  regions: (string | undefined)[];
  preprocessing: PreprocessingRun;
  qc: QcReport;
}

export async function runAnalysis(
  context: JobContext,
  input: {
    runId: string;
    projectId: string;
    dataset: SpatialDataset;
    referenceDataset: SpatialDataset | null;
    loadedCase: LoadedCase | null;
    catalogue: Catalogue;
    options: AnalysisOptions;
    store: Store;
  },
): Promise<{ artefacts: AnalysisArtefacts; state: AnalysisState }> {
  const { dataset, catalogue, options, store, runId } = input;
  const random = new RandomState(options.seed);
  const manifest = emptyManifest(runId, '1.0.0', options.seed);
  manifest.datasets.push({
    datasetId: dataset.metadata.datasetId,
    revision: dataset.revision,
    sha256: dataset.checksum,
    role: 'primary',
  });
  if (input.referenceDataset) {
    manifest.datasets.push({
      datasetId: input.referenceDataset.metadata.datasetId,
      revision: input.referenceDataset.revision,
      sha256: input.referenceDataset.checksum,
      role: 'reference',
    });
  }
  manifest.parameterPack = { id: 'v1-parameter-registry', version: catalogue.parameters.version };

  // -- 02 QC ---------------------------------------------------------------

  await context.report({ stage: 'qc', fraction: 0.05, message: 'Quality control and eligibility' });
  await context.checkpoint();

  const qc = runQc(dataset, {
    requiredFeatures: catalogue.modelPack?.schema.nodeSymbols ?? [],
    modelFeatureNamespace: 'HGNC',
  });
  const qcSerialisable = serialisableQc(qc);
  store.writeArtefact(runId, 'qc', qcSerialisable);

  let comparability: ComparabilityResult | null = null;
  if (input.referenceDataset) {
    comparability = assessComparability(dataset, input.referenceDataset);
    store.writeArtefact(runId, 'comparability', comparability);
    if (!comparability.comparable) {
      manifest.warnings.push(
        `Reference comparison disabled: ${comparability.reasons.join(' ')} (§4.3, "not comparable").`,
      );
    }
  }

  // -- 02 preprocessing ----------------------------------------------------

  await context.report({ stage: 'preprocess', completed: ['qc'], fraction: 0.12, message: 'Preprocessing' });
  await context.checkpoint();

  const preprocessing = preprocess(dataset, DEFAULT_PREPROCESSING, random.stream('preprocess'));
  for (const method of preprocessing.methods) manifest.methods.push(method);
  manifest.warnings.push(...preprocessing.warnings);

  // -- 03 annotation --------------------------------------------------------

  await context.report({ stage: 'annotate', completed: ['qc', 'preprocess'], fraction: 0.2, message: 'Annotating cells and regions' });
  await context.checkpoint();

  const provided = useProvidedAnnotations(preprocessing.view, 'cellType');
  const annotation = provided ?? scoreMarkerPanel(preprocessing.view, catalogue.resources.markerPanel);
  manifest.methods.push(annotation.method);

  const providedRegions = useProvidedAnnotations(preprocessing.view, 'region');
  const regionLabels = providedRegions?.labels ?? new Array(preprocessing.view.observations.length).fill(undefined);
  if (providedRegions) manifest.methods.push(providedRegions.method);

  // -- 03 spatial graph -----------------------------------------------------

  await context.report({ stage: 'spatial', completed: ['qc', 'preprocess', 'annotate'], fraction: 0.3, message: 'Building the spatial graph' });
  await context.checkpoint();

  /*
   * Biological edges are built from the *measured* expression of the
   * ligand-receptor pairs, not from the mechanistic state — the state is only
   * available for a bundled case, and a graph that depended on it would be a
   * graph an uploaded dataset could not have.
   */
  const biologicalEdges = input.loadedCase
    ? ligandReceptorEdges(
        input.loadedCase.dataset.observations,
        {
          activity: input.loadedCase.state.truth,
          observationCount: input.loadedCase.state.observationCount,
          nodeCount: input.loadedCase.state.nodeCount,
        },
        catalogue.network,
        4,
      )
    : [];

  const graph = buildSpatialGraph(
    preprocessing.view.observations,
    {
      method: options.graphMethod,
      k: options.graphK,
      ...(options.graphRadius !== null ? { radius: options.graphRadius } : {}),
      symmetrise: true,
      weighting: 'gaussian',
    },
    dataset.metadata.coordinateUnit,
    biologicalEdges,
  );
  manifest.graph = {
    graphId: graph.graphId,
    method: graph.method,
    checksum: graph.checksum,
    parameters: graph.parameters as unknown as Record<string, unknown>,
  };
  manifest.warnings.push(...graph.diagnostics.warnings);

  // -- 03 baseline molecular ------------------------------------------------

  await context.report({ stage: 'baseline', fraction: 0.4, message: 'Differential features' });
  await context.checkpoint();

  const differential = differentialFeatures(preprocessing.view, annotation.labels, DEFAULT_DIFFERENTIAL);
  manifest.methods.push(differential.method);

  await context.report({ fraction: 0.5, message: 'Pathway activity' });
  await context.checkpoint();
  const pathways = pathwayActivity(
    preprocessing.view,
    catalogue.resources.pathways,
    { ...DEFAULT_PATHWAY, permutations: options.permutations },
    random.stream('pathway-null'),
    annotation.labels,
  );
  manifest.methods.push(pathways.method);

  await context.report({ fraction: 0.56, message: 'Cell states' });
  await context.checkpoint();
  const states = cellStateScores(preprocessing.view, catalogue.resources.states, random.stream('state-control'));
  manifest.methods.push(states.method);

  // -- 03 spatial statistics ------------------------------------------------

  await context.report({ fraction: 0.62, message: 'Neighbourhood enrichment' });
  await context.checkpoint();
  const enrichment = neighbourhoodEnrichment(
    graph,
    annotation.labels,
    random.stream('neighbourhood-permutation'),
    options.permutations,
  );
  manifest.methods.push(enrichment.method);

  await context.report({ fraction: 0.7, message: 'Spatial autocorrelation' });
  await context.checkpoint();
  // The top features by variance: running Moran's I with 1000 permutations on
  // every feature would be the longest single step in the pipeline for a table
  // nobody reads past the first twenty rows.
  const variances = preprocessing.view.features.map((feature, index) => ({
    index,
    id: feature.id,
    variance: varianceOf(featureVector(preprocessing.view, index)),
  }));
  variances.sort((a, b) => b.variance - a.variance);
  const autocorrelationTargets = variances.slice(0, 30);
  const autocorrelation = spatialAutocorrelation(
    graph,
    autocorrelationTargets.map((entry) => featureVector(preprocessing.view, entry.index)),
    autocorrelationTargets.map((entry) => entry.id),
    random.stream('moran-permutation'),
    Math.min(options.permutations, 500),
  );

  // -- 03 spatial domains ---------------------------------------------------

  let domains: SpatialDomains | null = null;
  if (options.domains > 0 && preprocessing.embedding) {
    await context.report({ fraction: 0.76, message: 'Spatial domains' });
    await context.checkpoint();
    const embedding = preprocessing.embedding;
    const dimensions = embedding.components.rows;
    domains = spatialDomains(
      embedding.scores.values,
      dimensions,
      graph,
      options.domains,
      random.stream('spatial-domains'),
    );
    manifest.methods.push(domains.method);
  }

  // -- 03 communication -----------------------------------------------------

  await context.report({ stage: 'communication', fraction: 0.85, message: 'Cell-cell communication' });
  await context.checkpoint();

  const featureIndex = new Map(preprocessing.view.features.map((feature, index) => [feature.symbol.toUpperCase(), index]));
  const communication = spatialCommunication(
    preprocessing.view.observations,
    (symbol: string) => {
      const index = featureIndex.get(symbol.toUpperCase());
      return index === undefined ? null : featureVector(preprocessing.view, index);
    },
    catalogue.resources.ligandReceptor,
    { ...DEFAULT_COMMUNICATION, permutations: options.communicationPermutations },
    random.stream('communication-permutation'),
    catalogue.resources.version,
  );
  manifest.methods.push(communication.method);

  // -- assemble -------------------------------------------------------------

  await context.report({ fraction: 0.95, message: 'Writing results' });
  await context.checkpoint();

  const EDGE_SAMPLE_CAP = 6000;
  const artefacts: AnalysisArtefacts = {
    qc: qcSerialisable,
    comparability,
    preprocessing: {
      parameters: preprocessing.parameters,
      keptObservations: preprocessing.keptObservations.length,
      keptFeatures: preprocessing.keptFeatures.length,
      warnings: preprocessing.warnings,
      embeddingComponents: preprocessing.embedding?.explainedVarianceRatio.length ?? 0,
      explainedVariance: Array.from(preprocessing.embedding?.explainedVarianceRatio ?? []),
    },
    annotation: {
      source: annotation.source,
      classes: annotation.classes,
      labels: annotation.labels,
      confidence: Array.from(annotation.confidence),
      unassigned: annotation.unassigned,
      exploratory: annotation.exploratory,
      summary: annotationSummary(annotation),
      panelCoverage: provided ? null : panelCoverage(catalogue.resources.markerPanel, preprocessing.view.features),
    },
    regions: {
      labels: regionLabels,
      classes: [...new Set(regionLabels.filter((label): label is string => Boolean(label)))].sort(),
      source: providedRegions ? 'provided' : 'none',
    },
    domains: domains
      ? {
          assignment: Array.from(domains.assignment),
          domainCount: domains.domainCount,
          spatialCoherence: domains.spatialCoherence,
          sizes: Array.from(domains.sizes),
        }
      : null,
    differential: { results: differential.results, skipped: differential.skipped },
    pathways: {
      results: pathways.results.map(({ scores, ...rest }) => {
        void scores;
        return rest;
      }),
      scores: Object.fromEntries(pathways.results.map((result) => [result.pathwayId, Array.from(result.scores)])),
    },
    states: {
      results: states.results.map(({ scores, ...rest }) => {
        void scores;
        return rest;
      }),
      scores: Object.fromEntries(states.results.map((result) => [result.stateId, Array.from(result.scores)])),
      dominant: dominantState(states.results),
    },
    graph: {
      graphId: graph.graphId,
      method: graph.method,
      parameters: graph.parameters as unknown as Record<string, unknown>,
      checksum: graph.checksum,
      diagnostics: graph.diagnostics,
      edgeSample: graph.edges.slice(0, EDGE_SAMPLE_CAP).map((edge) => ({
        source: edge.source,
        target: edge.target,
        type: edge.edgeType,
      })),
      edgeSampleCap: EDGE_SAMPLE_CAP,
    },
    enrichment: {
      labels: enrichment.labels,
      observed: Array.from(enrichment.observed),
      zScore: Array.from(enrichment.zScore),
      qValue: Array.from(enrichment.qValue),
      permutations: enrichment.permutations,
    },
    autocorrelation,
    communication: {
      results: communication.results.map(({ edges, sent, received, ...rest }) => {
        void edges;
        void sent;
        void received;
        return rest;
      }),
      byClass: Object.fromEntries(
        communication.results.map((result) => [result.pairId, summariseByClass(result, annotation.labels)]),
      ),
      sent: Object.fromEntries(communication.results.map((result) => [result.pairId, Array.from(result.sent)])),
      received: Object.fromEntries(communication.results.map((result) => [result.pairId, Array.from(result.received)])),
    },
    manifest,
  };

  store.writeArtefact(runId, 'analysis', artefacts);

  /*
   * The processed matrix is stored separately.
   *
   * Feature layers are read from it, and without it every expression layer
   * would need the whole preprocessing to be re-run — which is deterministic
   * and therefore possible, but means a page load after a restart takes
   * seconds instead of milliseconds. It is also the artefact the machine-
   * readable export hands over, so it has to exist as a file either way.
   */
  store.writeArtefact(runId, 'processed-matrix', {
    features: preprocessing.view.features.map((feature) => ({
      id: feature.id,
      symbol: feature.symbol,
      modality: feature.modality,
    })),
    values: Array.from(preprocessing.view.matrix, (value) => Number(value.toPrecision(6))),
    scale: preprocessing.view.scale,
  });

  store.writeArtefact(runId, 'observations', {
    ids: preprocessing.view.observations.map((observation) => observation.id),
    x: preprocessing.view.observations.map((observation) => observation.x),
    y: preprocessing.view.observations.map((observation) => observation.y),
    coordinateUnit: dataset.metadata.coordinateUnit,
  });

  return {
    artefacts,
    state: {
      dataset,
      view: preprocessing.view,
      graph,
      labels: annotation.labels,
      regions: regionLabels,
      preprocessing,
      qc,
    },
  };
}

function varianceOf(values: Float64Array): number {
  const n = values.length;
  if (n < 2) return 0;
  let total = 0;
  for (let i = 0; i < n; i += 1) total += values[i] as number;
  const mu = total / n;
  let ss = 0;
  for (let i = 0; i < n; i += 1) {
    const d = (values[i] as number) - mu;
    ss += d * d;
  }
  return ss / (n - 1);
}

function dominantState(results: CellStateScore[]): (string | undefined)[] {
  if (results.length === 0) return [];
  const n = (results[0] as CellStateScore).scores.length;
  const out: (string | undefined)[] = new Array(n).fill(undefined);
  for (let i = 0; i < n; i += 1) {
    let best = -Infinity;
    let bestName: string | undefined;
    for (const result of results) {
      const value = result.scores[i] as number;
      if (Number.isFinite(value) && value > best) {
        best = value;
        bestName = result.name;
      }
    }
    out[i] = bestName;
  }
  return out;
}
