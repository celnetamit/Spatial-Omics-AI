/**
 * Per-cell layers — the values the tissue canvas colours by.
 *
 * Every layer the client can draw is requested by name from here, and the
 * server resolves it from stored artefacts. The client never receives a matrix
 * it could recompute a different answer from, which is what keeps the number on
 * screen and the number in the report the same number.
 *
 * Each layer carries its §1.5 result label and the method that produced it, so
 * the badge on the canvas is decided by whatever computed the values rather
 * than by the component drawing them.
 */

import type { ResultLabel } from '@engine/core/labels';
import type { Store } from '../store';
import type { AnalysisArtefacts } from '../jobs/analysis';
import type { PredictionArtefacts } from '../jobs/prediction';
import type { RescueArtefacts } from '../jobs/rescue';

export interface Layer {
  id: string;
  name: string;
  values: number[];
  /** Categorical layers carry the class names; `values` indexes them. */
  categories: string[] | null;
  unit: string;
  label: ResultLabel;
  method: string;
  /** Suggested colour treatment, so the canvas does not have to guess. */
  scale: 'sequential' | 'diverging' | 'categorical';
  range: [number, number];
  /** Cells with no value, e.g. an unassigned annotation. */
  missing: number[];
  note: string | null;
}

export interface LayerRequest {
  kind: string;
  key: string;
  stage?: number;
}

export interface ProcessedMatrix {
  features: { id: string; symbol: string; modality: string }[];
  /** observations x features, row-major. */
  values: number[];
  scale: string;
}

export function resolveLayer(
  store: Store,
  runId: string,
  request: LayerRequest,
): Layer | { error: string } {
  const analysis = store.readArtefact<AnalysisArtefacts>(runId, 'analysis');

  switch (request.kind) {
    case 'qc':
      return analysis ? qcLayer(analysis, request.key) : { error: 'No analysis results for this run.' };
    case 'feature':
      return featureLayer(store, runId, request.key);
    case 'pathway':
      return analysis ? pathwayLayer(analysis, request.key) : { error: 'No analysis results for this run.' };
    case 'state':
      return analysis ? stateLayer(analysis, request.key) : { error: 'No analysis results for this run.' };
    case 'annotation':
      return analysis ? annotationLayer(analysis, request.key) : { error: 'No analysis results for this run.' };
    case 'communication':
      return analysis ? communicationLayer(analysis, request.key) : { error: 'No analysis results for this run.' };
    case 'direct':
      return directLayer(store, runId, request.key);
    case 'propagation':
      return propagationLayer(store, runId, request.key, request.stage ?? 0);
    case 'delta':
      return deltaLayer(store, runId, request.key);
    case 'adverse':
      return adverseLayer(store, runId, request.key);
    case 'uncertainty':
      return uncertaintyLayer(store, runId);
    case 'rescue':
      return rescueLayer(store, runId, request.key);
    case 'mechanism':
      return mechanismLayer(store, runId);
    default:
      return { error: `Unknown layer kind "${request.kind}".` };
  }
}

function rangeOf(values: number[]): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (!Number.isFinite(min)) return [0, 0];
  return [min, max];
}

function missingOf(values: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < values.length; i += 1) if (!Number.isFinite(values[i] as number)) out.push(i);
  return out;
}

function qcLayer(analysis: AnalysisArtefacts, key: string): Layer | { error: string } {
  const metrics = analysis.qc.observationMetrics;
  const options: Record<string, { name: string; values: number[] | null; unit: string }> = {
    'total-counts': { name: 'Total counts', values: metrics.totalCounts, unit: 'counts' },
    'detected-features': { name: 'Detected features', values: metrics.detectedFeatures, unit: 'features' },
    mitochondrial: { name: 'Mitochondrial fraction', values: metrics.mitochondrialFraction, unit: 'fraction' },
    'library-outlier': { name: 'Library-size outlier', values: metrics.lowCountOutlier.map((low, i) => (low ? -1 : (metrics.highCountOutlier[i] ?? 0) ? 1 : 0)), unit: 'low / normal / high' },
  };
  const chosen = options[key];
  if (!chosen) return { error: `Unknown QC layer "${key}".` };
  if (!chosen.values) {
    return {
      error:
        key === 'mitochondrial'
          ? 'This panel contains no mitochondrial features, so there is no mitochondrial fraction to show. Reporting 0% would imply a measurement that was never made.'
          : `The QC layer "${key}" is not available for this run.`,
    };
  }
  const values = Array.from(chosen.values);
  return {
    id: `qc:${key}`,
    name: chosen.name,
    values,
    categories: null,
    unit: chosen.unit,
    label: 'OBSERVED',
    method: 'qc.metrics',
    scale: 'sequential',
    range: rangeOf(values),
    missing: missingOf(values),
    note: null,
  };
}

function featureLayer(store: Store, runId: string, symbol: string): Layer | { error: string } {
  const matrix = store.readArtefact<ProcessedMatrix>(runId, 'processed-matrix');
  if (!matrix) return { error: 'The processed matrix is not stored for this run.' };
  const index = matrix.features.findIndex(
    (feature) => feature.id.toUpperCase() === symbol.toUpperCase() || feature.symbol.toUpperCase() === symbol.toUpperCase(),
  );
  if (index < 0) return { error: `"${symbol}" is not in this dataset's feature space.` };

  const width = matrix.features.length;
  const n = matrix.values.length / width;
  const values = new Array<number>(n);
  for (let i = 0; i < n; i += 1) values[i] = matrix.values[i * width + index] as number;

  const feature = matrix.features[index] as { symbol: string; modality: string };
  return {
    id: `feature:${symbol}`,
    name: feature.symbol,
    values,
    categories: null,
    unit: matrix.scale,
    label: 'OBSERVED',
    method: `preprocess.normalise (${matrix.scale})`,
    scale: 'sequential',
    range: rangeOf(values),
    missing: [],
    note:
      feature.modality === 'proteomics'
        ? 'Protein abundance, arcsinh transformed. Not on the same scale as the transcript layers.'
        : null,
  };
}

function pathwayLayer(analysis: AnalysisArtefacts, key: string): Layer | { error: string } {
  const values = analysis.pathways.scores[key];
  if (!values) return { error: `Unknown pathway "${key}".` };
  const record = analysis.pathways.results.find((result) => result.pathwayId === key);
  return {
    id: `pathway:${key}`,
    name: record?.name ?? key,
    values,
    categories: null,
    unit: 'weighted mean z',
    label: 'COMPUTED',
    method: 'baseline.pathway-activity',
    scale: 'diverging',
    range: rangeOf(values),
    missing: missingOf(values),
    note: record && record.missing.length > 0
      ? `${record.missing.length} member(s) of this set are not in the dataset: ${record.missing.slice(0, 8).join(', ')}.`
      : null,
  };
}

function stateLayer(analysis: AnalysisArtefacts, key: string): Layer | { error: string } {
  const values = analysis.states.scores[key];
  if (!values) return { error: `Unknown cell state "${key}".` };
  const record = analysis.states.results.find((result) => result.stateId === key);
  return {
    id: `state:${key}`,
    name: record?.name ?? key,
    values,
    categories: null,
    unit: 'control-corrected signature score',
    label: 'COMPUTED',
    method: 'baseline.cell-states',
    scale: 'diverging',
    range: rangeOf(values),
    missing: missingOf(values),
    note: null,
  };
}

function annotationLayer(analysis: AnalysisArtefacts, key: string): Layer | { error: string } {
  if (key === 'cell-type' || key === 'region') {
    const labels = key === 'cell-type' ? analysis.annotation.labels : analysis.regions.labels;
    const categories = key === 'cell-type' ? analysis.annotation.classes : analysis.regions.classes;
    const lookup = new Map(categories.map((name, index) => [name, index]));
    const values = labels.map((label) => (label === undefined ? Number.NaN : lookup.get(label) ?? Number.NaN));
    return {
      id: `annotation:${key}`,
      name: key === 'cell-type' ? 'Cell type' : 'Region',
      values,
      categories,
      unit: 'class',
      label: analysis.annotation.source === 'provided' ? 'OBSERVED' : 'COMPUTED',
      method: analysis.annotation.source === 'provided' ? 'annotate.provided' : 'annotate.marker-panel',
      scale: 'categorical',
      range: [0, Math.max(0, categories.length - 1)],
      missing: missingOf(values),
      note:
        key === 'cell-type' && analysis.annotation.exploratory
          ? 'These labels were inferred from a marker panel, not supplied with the data. They are exploratory, not validated annotations.'
          : null,
    };
  }
  if (key === 'confidence') {
    const values = analysis.annotation.confidence;
    return {
      id: 'annotation:confidence',
      name: 'Annotation confidence',
      values,
      categories: null,
      unit: '0 to 1',
      label: 'COMPUTED',
      method: 'annotate.marker-panel',
      scale: 'sequential',
      range: [0, 1],
      missing: missingOf(values),
      note: analysis.annotation.source === 'provided'
        ? 'The source dataset supplied labels without confidences, so this layer is empty. Inventing a number for it would be a fabrication.'
        : null,
    };
  }
  if (key === 'domain') {
    if (!analysis.domains) return { error: 'Spatial domains were not computed for this run.' };
    const categories = Array.from({ length: analysis.domains.domainCount }, (_, i) => `Domain ${i + 1}`);
    return {
      id: 'annotation:domain',
      name: 'Spatial domain',
      values: analysis.domains.assignment,
      categories,
      unit: 'domain',
      label: 'COMPUTED',
      method: 'spatial.domains',
      scale: 'categorical',
      range: [0, Math.max(0, categories.length - 1)],
      missing: [],
      note: `Neighbourhood coherence ${(analysis.domains.spatialCoherence * 100).toFixed(1)}% — the fraction of neighbouring pairs sharing a domain.`,
    };
  }
  return { error: `Unknown annotation layer "${key}".` };
}

function communicationLayer(analysis: AnalysisArtefacts, key: string): Layer | { error: string } {
  const [pairId, direction] = key.split('|');
  if (!pairId || (direction !== 'sent' && direction !== 'received')) {
    return { error: 'A communication layer needs "<pairId>|sent" or "<pairId>|received".' };
  }
  const values = direction === 'sent' ? analysis.communication.sent[pairId] : analysis.communication.received[pairId];
  if (!values) return { error: `Unknown ligand-receptor pair "${pairId}".` };
  const record = analysis.communication.results.find((result) => result.pairId === pairId);
  return {
    id: `communication:${key}`,
    name: `${record?.ligand ?? pairId} → ${record?.receptor ?? ''} (${direction})`,
    values,
    categories: null,
    unit: 'transported units',
    label: 'COMPUTED',
    method: 'spatial.communication',
    scale: 'sequential',
    range: rangeOf(values),
    missing: [],
    note: 'Candidate interaction: proximity and co-expression, not observed signalling.',
  };
}

function directLayer(store: Store, runId: string, key: string): Layer | { error: string } {
  const prediction = store.readArtefact<PredictionArtefacts>(runId, 'prediction');
  if (!prediction) return { error: 'No prediction results for this run.' };
  if (key === 'magnitude') {
    return {
      id: 'direct:magnitude',
      name: 'Direct response magnitude',
      values: prediction.direct.magnitude,
      categories: null,
      unit: '0 to 1',
      label: 'COMPUTED',
      method: prediction.direct.method,
      scale: 'sequential',
      range: [0, 1],
      missing: [],
      note: prediction.direct.quantitative
        ? 'Evidence-parameterised direct effect. This is COMPUTED, not PREDICTED — no model produced it.'
        : 'Exploratory: the perturbation parameters are outside the evidence-supported range.',
    };
  }
  const values = prediction.direct.effectByNode[key];
  if (!values) return { error: `"${key}" is not a direct target of this perturbation.` };
  return {
    id: `direct:${key}`,
    name: `${key} immediate change`,
    values,
    categories: null,
    unit: 'activity change',
    label: 'COMPUTED',
    method: prediction.direct.method,
    scale: 'diverging',
    range: rangeOf(values),
    missing: [],
    note: null,
  };
}

function propagationLayer(store: Store, runId: string, key: string, stage: number): Layer | { error: string } {
  const prediction = store.readArtefact<PredictionArtefacts>(runId, 'prediction');
  if (!prediction) return { error: 'No prediction results for this run.' };
  if (!prediction.propagation.available) {
    return { error: prediction.propagation.unavailableReason ?? 'No spatial propagation was computed for this run.' };
  }
  const entry = prediction.propagation.stages.find((candidate) => candidate.stage === stage);
  if (!entry) return { error: `Stage ${stage} was not computed. Stages run from 1 to ${prediction.propagation.stages.length}.` };

  const values = key === 'step' ? entry.stepMagnitude : entry.magnitude;
  return {
    id: `propagation:${key}:${stage}`,
    name: key === 'step' ? `${entry.label} — change this stage` : `${entry.label} — change from baseline`,
    values,
    categories: null,
    unit: 'activity change magnitude',
    label: stage === 1 ? 'COMPUTED' : 'PREDICTED',
    method: stage === 1 ? 'perturb.direct' : `${prediction.propagation.modelId}@${prediction.propagation.modelVersion}`,
    scale: 'sequential',
    range: rangeOf(values),
    missing: [],
    note: prediction.propagation.stageCaveat,
  };
}

function deltaLayer(store: Store, runId: string, symbol: string): Layer | { error: string } {
  const delta = store.readArtefact<{ nodeSymbols: string[]; values: number[]; observationCount: number }>(runId, 'final-delta');
  if (!delta) return { error: 'The per-cell final change is not stored for this run.' };
  const index = delta.nodeSymbols.findIndex((node) => node.toUpperCase() === symbol.toUpperCase());
  if (index < 0) return { error: `"${symbol}" is not in the model's feature space.` };

  const nodeCount = delta.nodeSymbols.length;
  const values = new Array<number>(delta.observationCount);
  for (let i = 0; i < delta.observationCount; i += 1) values[i] = delta.values[i * nodeCount + index] as number;

  return {
    id: `delta:${symbol}`,
    name: `Δ ${symbol}`,
    values,
    categories: null,
    unit: 'activity change',
    label: 'PREDICTED',
    method: 'propagation rollout, final stage',
    scale: 'diverging',
    range: rangeOf(values),
    missing: [],
    note: null,
  };
}

function adverseLayer(store: Store, runId: string, key: string): Layer | { error: string } {
  const prediction = store.readArtefact<PredictionArtefacts>(runId, 'prediction');
  if (!prediction) return { error: 'No prediction results for this run.' };
  const values = prediction.adverse.componentDeltas[key];
  if (!values) return { error: `Unknown adverse signature "${key}".` };
  const component = prediction.adverse.components.find((entry) => entry.signatureId === key);
  return {
    id: `adverse:${key}`,
    name: component?.name ?? key,
    values,
    categories: null,
    unit: 'signature change',
    label: 'PREDICTED',
    method: prediction.adverse.method,
    scale: 'diverging',
    range: rangeOf(values),
    missing: [],
    note: component?.interpretation ?? null,
  };
}

function uncertaintyLayer(store: Store, runId: string): Layer | { error: string } {
  const values = store.readArtefact<number[]>(runId, 'uncertainty-per-cell');
  if (!values) return { error: 'No uncertainty layer for this run.' };
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) {
    return {
      error:
        'The ensemble has fewer than two members, so no disagreement can be measured. A single model always agrees with itself, and reporting that as low uncertainty would be misleading.',
    };
  }
  return {
    id: 'uncertainty:dispersion',
    name: 'Ensemble disagreement',
    values,
    categories: null,
    unit: 'activity units (standard deviation across members)',
    label: 'PREDICTED',
    method: 'deep ensemble dispersion',
    scale: 'sequential',
    range: rangeOf(values),
    missing: missingOf(values),
    note: 'Higher means the ensemble members disagree about this cell. It is a relative measure; its absolute calibration is in the model card.',
  };
}

function rescueLayer(store: Store, runId: string, candidateId: string): Layer | { error: string } {
  const rescue = store.readArtefact<RescueArtefacts>(runId, 'rescue');
  if (!rescue) return { error: 'No rescue results for this run.' };
  const record = rescue.simulated.find((entry) => entry.candidateId === candidateId);
  if (!record) return { error: `Candidate "${candidateId}" was not simulated in this run.` };
  if (record.status !== 'complete') return { error: record.failureReason ?? 'This candidate simulation failed.' };
  return {
    id: `rescue:${candidateId}`,
    name: `${record.name} — rescue magnitude`,
    values: record.magnitude,
    categories: null,
    unit: 'activity change magnitude',
    label: 'PREDICTED',
    method: 'rescue simulation on the altered tissue state',
    scale: 'sequential',
    range: rangeOf(record.magnitude),
    missing: [],
    note: `Simulated at ${record.concentrationNm?.toPrecision(3) ?? '—'} nM.`,
  };
}

function mechanismLayer(store: Store, runId: string): Layer | { error: string } {
  const reference = store.readArtefact<{ perCellMagnitude: number[]; reason: string }>(runId, 'mechanistic-reference');
  if (!reference) {
    return {
      error:
        'The mechanistic reference was not run for this prediction. It is available only for the bundled simulated cases, and only when requested.',
    };
  }
  return {
    id: 'mechanism:magnitude',
    name: 'Simulated reference — change magnitude',
    values: reference.perCellMagnitude,
    categories: null,
    unit: 'activity change magnitude',
    label: 'COMPUTED',
    method: 'mechanistic reaction-diffusion solve',
    scale: 'sequential',
    range: rangeOf(reference.perCellMagnitude),
    missing: [],
    note:
      'This is the mechanism that generated the bundled case, re-solved under the same perturbation. It is a simulated reference, ' +
      'not an observation, and agreement with it says the model learned the mechanism — not that either is right about tissue.',
  };
}
