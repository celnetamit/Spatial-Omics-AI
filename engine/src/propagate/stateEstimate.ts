/**
 * Estimating a model state from measured expression.
 *
 * The predictive model works in the network's activity space — one bounded
 * value per node per cell. A bundled case carries that state directly, because
 * the generator produced it. An uploaded dataset does not: it carries counts,
 * and the activity has to be estimated from them.
 *
 * This is a **proxy**, and the method record says so in the words a reader will
 * see. It is a monotone rescaling of each feature's measured level onto [0, 1],
 * which preserves the ordering of cells within a feature and nothing else. In
 * particular it does not recover absolute activity, it cannot distinguish a
 * gene that is uniformly high from one that is uniformly low, and two datasets
 * rescaled this way are not on a common scale.
 *
 * The consequence is stated wherever a prediction on an uploaded dataset is
 * shown: the propagation model was fitted on states produced by a mechanism,
 * and applying it to a proxy is a transfer. The out-of-domain check in
 * `uncertainty/` is what measures how far a transfer it is, rather than this
 * module asserting it is fine.
 */

import { quantile } from '../core/stats';
import type { MethodRecord } from '../core/provenance';
import type { DatasetView } from '../data/types';
import { featureIndexMap, featureVector } from '../data/types';
import type { CompiledNetwork } from './network';
import type { TissueState } from './mechanism';

export interface StateEstimate {
  state: TissueState;
  /** Network nodes the dataset does not measure at all. */
  missingNodes: string[];
  /** Nodes filled from a protein measurement because no transcript was present. */
  proteinSubstituted: string[];
  method: MethodRecord;
  warnings: string[];
}

export interface EstimateOptions {
  /**
   * Quantiles the rescaling maps to 0 and 1.
   *
   * Not min and max. A single cell with an outlying count would otherwise set
   * the top of the scale and compress every other cell into the bottom tenth of
   * the range — which in a tumour section, where one dying cell can carry ten
   * times the counts of its neighbours, happens constantly.
   */
  lowQuantile: number;
  highQuantile: number;
  /** Level assigned to a node the dataset does not measure. */
  missingLevel: 'basal' | 'zero';
}

export const DEFAULT_ESTIMATE: EstimateOptions = {
  lowQuantile: 0.02,
  highQuantile: 0.98,
  missingLevel: 'basal',
};

export function estimateState(
  view: DatasetView,
  network: CompiledNetwork,
  options: EstimateOptions = DEFAULT_ESTIMATE,
): StateEstimate {
  const n = view.observations.length;
  const nodeCount = network.nodes.length;
  const state: TissueState = {
    activity: new Float64Array(n * nodeCount),
    observationCount: n,
    nodeCount,
  };

  const index = featureIndexMap(view.features);
  const missingNodes: string[] = [];
  const proteinSubstituted: string[] = [];
  const warnings: string[] = [];

  for (let node = 0; node < nodeCount; node += 1) {
    const symbol = (network.nodes[node] as { symbol: string }).symbol;
    let column = index.get(symbol.toUpperCase());

    if (column === undefined) {
      // A protein measurement stands in where the transcript is absent. It is a
      // different molecule with different kinetics, so it is recorded as a
      // substitution rather than treated as the same thing.
      const protein = index.get(`PROT_${symbol}`.toUpperCase());
      if (protein !== undefined) {
        column = protein;
        proteinSubstituted.push(symbol);
      }
    }

    if (column === undefined) {
      missingNodes.push(symbol);
      const level = options.missingLevel === 'basal' ? (network.basal[node] as number) : 0;
      for (let i = 0; i < n; i += 1) state.activity[i * nodeCount + node] = level;
      continue;
    }

    const values = featureVector(view, column);
    const low = quantile(values, options.lowQuantile);
    const high = quantile(values, options.highQuantile);
    const span = high - low;

    for (let i = 0; i < n; i += 1) {
      const value = values[i] as number;
      const scaled = span > 1e-12 ? (value - low) / span : 0.5;
      state.activity[i * nodeCount + node] = Math.min(1, Math.max(0, scaled));
    }
  }

  if (missingNodes.length > 0) {
    warnings.push(
      `${missingNodes.length} of ${nodeCount} model nodes are not measured in this dataset and were set to their network basal level: ` +
        `${missingNodes.slice(0, 10).join(', ')}${missingNodes.length > 10 ? ', …' : ''}. ` +
        'A perturbation aimed at one of them has no measured target availability, so its direct response will be zero rather than unknown — check the target is in the panel.',
    );
  }
  if (proteinSubstituted.length > 0) {
    warnings.push(
      `${proteinSubstituted.join(', ')} were estimated from protein measurements because no transcript was present. ` +
        'Protein abundance lags transcription and the two are not interchangeable; the substitution is recorded on each affected node.',
    );
  }

  return {
    state,
    missingNodes,
    proteinSubstituted,
    warnings,
    method: {
      id: 'propagate.state-estimate',
      name: 'Model state estimation from measured expression',
      version: '1.0.0',
      software: 'spatial-omics-engine',
      parameters: {
        rescaling: `quantile ${options.lowQuantile} to ${options.highQuantile} mapped to [0, 1], per feature`,
        missingNodePolicy: options.missingLevel,
        missingNodes: missingNodes.length,
        proteinSubstituted: proteinSubstituted.length,
      },
      summary:
        'Each network node’s activity was estimated as a monotone rescaling of its measured level between the 2nd and 98th percentile across cells. ' +
        'This preserves the ordering of cells within a feature and nothing else: it is a proxy for activity, not a measurement of it, and two datasets rescaled this way are not on a common scale. ' +
        'The propagation model was fitted on states produced by a mechanism, so applying it here is a transfer — the out-of-domain check reports how far a transfer it is.',
    },
  };
}

/**
 * Context features for the out-of-domain check.
 *
 * Deliberately the same list the model pack's domain reference was built from,
 * and in the same order — a mismatch here would compare a run's cell count
 * against the training distribution of its degree.
 */
export function contextVector(input: {
  observationCount: number;
  medianEdgeLength: number;
  meanDegree: number;
  labels: (string | undefined)[];
  state: TissueState;
  perturbedFraction: number;
}): Float64Array {
  const counts = new Map<string, number>();
  for (const label of input.labels) counts.set(label ?? '', (counts.get(label ?? '') ?? 0) + 1);
  const n = Math.max(1, input.observationCount);

  let sum = 0;
  let squared = 0;
  for (let i = 0; i < input.state.activity.length; i += 1) {
    const value = input.state.activity[i] as number;
    sum += value;
    squared += value * value;
  }
  const mean = sum / Math.max(1, input.state.activity.length);
  const variance = squared / Math.max(1, input.state.activity.length) - mean * mean;

  return Float64Array.from([
    input.observationCount,
    input.medianEdgeLength,
    input.meanDegree,
    (counts.get('Tumour') ?? 0) / n,
    ((counts.get('T cell') ?? 0) + (counts.get('Macrophage') ?? 0)) / n,
    (counts.get('CAF') ?? 0) / n,
    mean,
    Math.sqrt(Math.max(0, variance)),
    input.perturbedFraction,
  ]);
}
