/**
 * Quality control and dataset eligibility — §6.3.
 *
 * Two questions, answered separately, because they have different answers:
 * whether the dataset can be analysed at all, and whether it is eligible for
 * predictive simulation. A tissue can be perfectly good for describing a
 * baseline and still be outside the domain any propagation model was fitted on,
 * and collapsing the two would let a run reach a PREDICTED panel it has no
 * business reaching.
 *
 * §6.3 also forbids "a universal hard-coded biological QC threshold across all
 * tissues". So the biological thresholds here are **data-driven** — median
 * absolute deviation from the dataset's own distribution — while the fixed
 * checks are the structural ones §6.3 does fix: non-empty matrix, unique ids,
 * valid coordinates, compatible feature namespace. Which kind each check is,
 * is part of the check.
 */

import { medianAbsoluteDeviation, median } from '../core/stats';
import { coordinateBounds, featureVector, observationVector, type SpatialDataset } from '../data/types';

export type QcVerdict = 'pass' | 'warning' | 'fail';

export type CheckKind =
  /** A fixed structural requirement; the same for every tissue. */
  | 'structural'
  /** A threshold derived from this dataset's own distribution. */
  | 'data-driven'
  /** A threshold supplied by the selected model or case pack. */
  | 'pack-supplied'
  /** An engineering guardrail, not a biological statement. */
  | 'engineering';

export interface QcCheck {
  id: string;
  name: string;
  kind: CheckKind;
  verdict: QcVerdict;
  /** What was measured. */
  measured: string;
  /** What it was compared against, and where that came from. */
  criterion: string;
  /** Why it matters, for the learner reading the dashboard. */
  rationale: string;
  /** Blocks predictive simulation even when the verdict is only a warning. */
  blocksPrediction: boolean;
}

export interface ObservationQcMetrics {
  /** Sum of the observation's feature values. */
  totalCounts: Float64Array;
  /** Number of features above zero. */
  detectedFeatures: Int32Array;
  /** Fraction of counts in mitochondrial genes, where any are present. */
  mitochondrialFraction: Float64Array | null;
  /** Outlier flags, from the MAD rule below. */
  lowCountOutlier: Uint8Array;
  highCountOutlier: Uint8Array;
}

export interface FeatureQcMetrics {
  /** Fraction of observations in which the feature is above zero. */
  detectionRate: Float64Array;
  meanValue: Float64Array;
  varianceValue: Float64Array;
}

export interface QcReport {
  datasetId: string;
  datasetRevision: string;
  verdict: QcVerdict;
  /** §6.3 — separate from the analysis verdict. */
  predictionEligible: boolean;
  predictionBlockers: string[];
  checks: QcCheck[];
  observationMetrics: ObservationQcMetrics;
  featureMetrics: FeatureQcMetrics;
  summary: {
    observations: number;
    features: number;
    medianCountsPerObservation: number;
    medianFeaturesPerObservation: number;
    /** Fraction of the matrix that is exactly zero. */
    sparsity: number;
    /** Median nearest-neighbour distance, in the dataset's coordinate unit. */
    medianNearestNeighbourDistance: number;
    coordinateUnit: string;
  };
  recommendedActions: string[];
  /** §4.3 status, derived from the checks. */
  eligibility: EligibilityStatus;
}

export type EligibilityStatus =
  | 'eligible'
  | 'eligible-with-limitations'
  | 'requires-metadata'
  | 'not-comparable'
  | 'unsupported-input';

export const ELIGIBILITY_BEHAVIOUR: Record<EligibilityStatus, string> = {
  eligible: 'The full approved pipeline is available.',
  'eligible-with-limitations': 'The run proceeds with warnings; affected outputs are disabled.',
  'requires-metadata': 'Prediction is blocked until the missing context is supplied.',
  'not-comparable': 'Reference comparison is disabled; the primary analysis may continue.',
  'unsupported-input': 'The run stops and conversion guidance is provided.',
};

export interface QcOptions {
  /**
   * Minimum detected features per observation, when the case pack states one.
   * Absent by default — §6.3 forbids a universal biological threshold, so with
   * no pack value the MAD rule below is what decides.
   */
  packMinimumDetectedFeatures?: number;
  packMaximumMitochondrialFraction?: number;
  /** MAD multiplier for the outlier rule. An engineering guardrail. */
  madMultiplier?: number;
  /** Minimum observations a predictive model needs to have a neighbourhood. */
  minimumObservationsForPrediction?: number;
  /** Feature ids the selected model pack requires to be present. */
  requiredFeatures?: string[];
  /** The namespace the model pack's features are identified in. */
  modelFeatureNamespace?: string;
}

const DEFAULTS = {
  madMultiplier: 5,
  minimumObservationsForPrediction: 100,
};

export function runQc(dataset: SpatialDataset, options: QcOptions = {}): QcReport {
  const checks: QcCheck[] = [];
  const n = dataset.observations.length;
  const p = dataset.features.length;
  const madMultiplier = options.madMultiplier ?? DEFAULTS.madMultiplier;

  // -- structural ----------------------------------------------------------

  checks.push({
    id: 'structure.non-empty',
    name: 'Matrix is not empty',
    kind: 'structural',
    verdict: n > 0 && p > 0 ? 'pass' : 'fail',
    measured: `${n} observation(s) x ${p} feature(s)`,
    criterion: 'At least one observation and one feature (§6.3, fixed).',
    rationale: 'Nothing downstream has anything to compute on.',
    blocksPrediction: true,
  });

  const observationIds = new Set(dataset.observations.map((o) => o.id));
  checks.push({
    id: 'structure.unique-observation-ids',
    name: 'Observation identifiers are unique',
    kind: 'structural',
    verdict: observationIds.size === n ? 'pass' : 'fail',
    measured: `${observationIds.size} distinct id(s) across ${n} observation(s)`,
    criterion: 'Every observation identifier appears once (§6.3, fixed).',
    rationale:
      'Two observations sharing an id cannot be distinguished in the spatial graph, and any join would pick one arbitrarily.',
    blocksPrediction: true,
  });

  const featureIds = new Set(dataset.features.map((f) => f.id));
  checks.push({
    id: 'structure.unique-feature-ids',
    name: 'Feature identifiers are unique',
    kind: 'structural',
    verdict: featureIds.size === p ? 'pass' : 'fail',
    measured: `${featureIds.size} distinct id(s) across ${p} feature(s)`,
    criterion: 'Every feature identifier appears once (§6.3, fixed).',
    rationale: 'A duplicated feature would be perturbed in one column and read in another.',
    blocksPrediction: true,
  });

  let invalidCoordinates = 0;
  for (const observation of dataset.observations) {
    if (!Number.isFinite(observation.x) || !Number.isFinite(observation.y)) invalidCoordinates += 1;
  }
  checks.push({
    id: 'structure.valid-coordinates',
    name: 'Coordinates are finite',
    kind: 'structural',
    verdict: invalidCoordinates === 0 ? 'pass' : 'fail',
    measured: `${invalidCoordinates} observation(s) without a finite coordinate`,
    criterion: 'Every observation has a finite x and y (§6.3, fixed).',
    rationale: 'A cell with no position has no neighbourhood, and placing it arbitrarily changes everyone else’s.',
    blocksPrediction: true,
  });

  const namespaces = new Set(dataset.features.map((f) => f.namespace));
  const namespaceCompatible =
    !options.modelFeatureNamespace || namespaces.has(options.modelFeatureNamespace);
  checks.push({
    id: 'structure.feature-namespace',
    name: 'Feature namespace is compatible',
    kind: 'structural',
    verdict: namespaceCompatible ? 'pass' : 'fail',
    measured: `dataset uses ${[...namespaces].join(', ') || '(none declared)'}`,
    criterion: options.modelFeatureNamespace
      ? `The selected model pack identifies features in ${options.modelFeatureNamespace}.`
      : 'No model pack selected, so no namespace is required yet.',
    rationale:
      'A perturbation target is looked up by identifier. A namespace mismatch silently finds nothing, which looks like "no effect".',
    blocksPrediction: true,
  });

  // -- coordinate geometry --------------------------------------------------

  const bounds = coordinateBounds(dataset.observations);
  const nearestDistances = nearestNeighbourDistances(dataset);
  const medianNearest = nearestDistances.length > 0 ? median(nearestDistances) : Number.NaN;

  const degenerateGeometry = bounds.width === 0 || bounds.height === 0;
  checks.push({
    id: 'geometry.spread',
    name: 'Coordinates span two dimensions',
    kind: 'structural',
    verdict: degenerateGeometry ? 'fail' : 'pass',
    measured: `x spans ${formatNumber(bounds.width)}, y spans ${formatNumber(bounds.height)} ${dataset.metadata.coordinateUnit}`,
    criterion: 'Both axes vary (§6.3, fixed).',
    rationale: 'A tissue collapsed onto a line has no neighbourhood structure to propagate through.',
    blocksPrediction: true,
  });

  const duplicatePositions = countDuplicatePositions(dataset);
  checks.push({
    id: 'geometry.duplicate-positions',
    name: 'Observations occupy distinct positions',
    kind: 'structural',
    verdict: duplicatePositions === 0 ? 'pass' : duplicatePositions > n * 0.05 ? 'fail' : 'warning',
    measured: `${duplicatePositions} observation(s) share a position with another`,
    criterion: 'Fewer than 5% of observations share exact coordinates.',
    rationale:
      'Co-located observations give a zero-distance edge, which makes distance-weighted propagation divide by zero or dominate.',
    blocksPrediction: duplicatePositions > n * 0.05,
  });

  // -- per-observation metrics ----------------------------------------------

  const totalCounts = new Float64Array(n);
  const detectedFeatures = new Int32Array(n);
  for (let i = 0; i < n; i += 1) {
    const vector = observationVector(dataset, i);
    let total = 0;
    let detected = 0;
    for (let j = 0; j < p; j += 1) {
      const value = vector[j] as number;
      total += value;
      if (value > 0) detected += 1;
    }
    totalCounts[i] = total;
    detectedFeatures[i] = detected;
  }

  const mitochondrialIndices = dataset.features
    .map((feature, index) => ({ feature, index }))
    .filter(({ feature }) => /^(MT-|mt-|MT\.)/.test(feature.symbol))
    .map(({ index }) => index);

  let mitochondrialFraction: Float64Array | null = null;
  if (mitochondrialIndices.length > 0) {
    mitochondrialFraction = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      const vector = observationVector(dataset, i);
      let mito = 0;
      for (const index of mitochondrialIndices) mito += vector[index] as number;
      const total = totalCounts[i] as number;
      mitochondrialFraction[i] = total > 0 ? mito / total : 0;
    }
  }

  /*
   * The data-driven outlier rule.
   *
   * Median ± k * MAD on log1p counts. Logging first is what makes this work on
   * count data at all: on the raw scale the distribution is right-skewed enough
   * that the upper bound sits inside the bulk and a fifth of a healthy tissue is
   * flagged as a doublet.
   */
  const logCounts = new Float64Array(n);
  for (let i = 0; i < n; i += 1) logCounts[i] = Math.log1p(totalCounts[i] as number);
  const logMedian = median(logCounts);
  const logMad = medianAbsoluteDeviation(logCounts);
  const lowBound = logMedian - madMultiplier * logMad;
  const highBound = logMedian + madMultiplier * logMad;

  const lowCountOutlier = new Uint8Array(n);
  const highCountOutlier = new Uint8Array(n);
  let lowCount = 0;
  let highCount = 0;
  for (let i = 0; i < n; i += 1) {
    const value = logCounts[i] as number;
    if (logMad > 0 && value < lowBound) {
      lowCountOutlier[i] = 1;
      lowCount += 1;
    }
    if (logMad > 0 && value > highBound) {
      highCountOutlier[i] = 1;
      highCount += 1;
    }
  }

  const outlierFraction = n > 0 ? (lowCount + highCount) / n : 0;
  checks.push({
    id: 'observation.count-outliers',
    name: 'Library size outliers',
    kind: 'data-driven',
    verdict: outlierFraction > 0.2 ? 'warning' : 'pass',
    measured: `${lowCount} low and ${highCount} high outlier(s) — ${(outlierFraction * 100).toFixed(1)}% of observations`,
    criterion:
      logMad > 0
        ? `median(log1p counts) ± ${madMultiplier} x MAD, from this dataset: [${lowBound.toFixed(2)}, ${highBound.toFixed(2)}]`
        : 'MAD is zero (all library sizes identical), so no outlier rule was applied.',
    rationale:
      'Derived from this tissue rather than a fixed cut-off, because a Visium spot and a Xenium cell differ by two orders of magnitude in counts.',
    blocksPrediction: false,
  });

  const medianDetected = median(Float64Array.from(detectedFeatures));
  if (options.packMinimumDetectedFeatures !== undefined) {
    const below = countBelow(detectedFeatures, options.packMinimumDetectedFeatures);
    checks.push({
      id: 'observation.minimum-features',
      name: 'Detected features per observation',
      kind: 'pack-supplied',
      verdict: below > n * 0.25 ? 'fail' : below > 0 ? 'warning' : 'pass',
      measured: `${below} observation(s) below ${options.packMinimumDetectedFeatures}; median is ${medianDetected}`,
      criterion: `Case pack minimum of ${options.packMinimumDetectedFeatures} detected features.`,
      rationale: 'Below the pack minimum, the model pack was not calibrated on observations this shallow.',
      blocksPrediction: below > n * 0.25,
    });
  }

  if (mitochondrialFraction && options.packMaximumMitochondrialFraction !== undefined) {
    const above = countAbove(mitochondrialFraction, options.packMaximumMitochondrialFraction);
    checks.push({
      id: 'observation.mitochondrial',
      name: 'Mitochondrial fraction',
      kind: 'pack-supplied',
      verdict: above > n * 0.25 ? 'warning' : 'pass',
      measured: `${above} observation(s) above ${(options.packMaximumMitochondrialFraction * 100).toFixed(0)}%; median is ${(median(mitochondrialFraction) * 100).toFixed(1)}%`,
      criterion: `Case pack maximum of ${(options.packMaximumMitochondrialFraction * 100).toFixed(0)}%.`,
      rationale: 'A high mitochondrial fraction indicates stressed or dying cells whose expression is not the tissue state being modelled.',
      blocksPrediction: false,
    });
  } else if (mitochondrialIndices.length === 0) {
    checks.push({
      id: 'observation.mitochondrial',
      name: 'Mitochondrial fraction',
      kind: 'structural',
      verdict: 'pass',
      measured: 'no mitochondrial features in the panel',
      criterion: 'Not applicable to this feature set.',
      rationale:
        'A targeted panel usually omits mitochondrial genes; reporting 0% would imply a measurement that was never made.',
      blocksPrediction: false,
    });
  }

  // -- per-feature metrics --------------------------------------------------

  const detectionRate = new Float64Array(p);
  const meanValue = new Float64Array(p);
  const varianceValue = new Float64Array(p);
  let zeros = 0;
  for (let j = 0; j < p; j += 1) {
    const column = featureVector(dataset, j);
    let detected = 0;
    let total = 0;
    for (let i = 0; i < n; i += 1) {
      const value = column[i] as number;
      if (value > 0) detected += 1;
      else zeros += 1;
      total += value;
    }
    detectionRate[j] = n > 0 ? detected / n : 0;
    const mu = n > 0 ? total / n : 0;
    meanValue[j] = mu;
    let ss = 0;
    for (let i = 0; i < n; i += 1) {
      const d = (column[i] as number) - mu;
      ss += d * d;
    }
    varianceValue[j] = n > 1 ? ss / (n - 1) : 0;
  }

  let neverDetected = 0;
  for (let j = 0; j < p; j += 1) if ((detectionRate[j] as number) === 0) neverDetected += 1;
  checks.push({
    id: 'feature.never-detected',
    name: 'Features detected somewhere',
    kind: 'data-driven',
    verdict: neverDetected === p ? 'fail' : neverDetected > p * 0.5 ? 'warning' : 'pass',
    measured: `${neverDetected} of ${p} feature(s) are zero in every observation`,
    criterion: 'A feature with no signal carries no information and is excluded from analysis.',
    rationale:
      'A perturbation target that is never detected cannot be knocked down, and treating it as if it could would produce a confident zero.',
    blocksPrediction: neverDetected === p,
  });

  // -- prediction eligibility ----------------------------------------------

  checks.push({
    id: 'prediction.sample-size',
    name: 'Enough observations to form neighbourhoods',
    kind: 'engineering',
    verdict:
      n >= (options.minimumObservationsForPrediction ?? DEFAULTS.minimumObservationsForPrediction)
        ? 'pass'
        : 'warning',
    measured: `${n} observation(s)`,
    criterion: `At least ${options.minimumObservationsForPrediction ?? DEFAULTS.minimumObservationsForPrediction} for spatial propagation.`,
    rationale:
      'Below this, a k-nearest-neighbour graph connects most of the tissue to most of the rest, and "spatial" propagation stops meaning anything local.',
    blocksPrediction: n < (options.minimumObservationsForPrediction ?? DEFAULTS.minimumObservationsForPrediction),
  });

  if (options.requiredFeatures && options.requiredFeatures.length > 0) {
    const present = new Set(dataset.features.flatMap((f) => [f.id.toUpperCase(), f.symbol.toUpperCase()]));
    const absent = options.requiredFeatures.filter((id) => !present.has(id.toUpperCase()));
    checks.push({
      id: 'prediction.model-features',
      name: 'Model pack features are present',
      kind: 'pack-supplied',
      verdict: absent.length === 0 ? 'pass' : absent.length > options.requiredFeatures.length * 0.2 ? 'fail' : 'warning',
      measured:
        absent.length === 0
          ? `all ${options.requiredFeatures.length} required feature(s) present`
          : `${absent.length} missing: ${absent.slice(0, 8).join(', ')}${absent.length > 8 ? ', …' : ''}`,
      criterion: 'The model pack reads a fixed feature schema.',
      rationale:
        'A missing input feature is imputed as zero by any model that does not check, which is a measurement the dataset never made.',
      blocksPrediction: absent.length > options.requiredFeatures.length * 0.2,
    });
  }

  // -- verdicts -------------------------------------------------------------

  const verdict: QcVerdict = checks.some((c) => c.verdict === 'fail')
    ? 'fail'
    : checks.some((c) => c.verdict === 'warning')
      ? 'warning'
      : 'pass';

  const blockers = checks.filter((c) => c.blocksPrediction && c.verdict !== 'pass');
  const predictionEligible = blockers.length === 0 && verdict !== 'fail';

  const eligibility: EligibilityStatus =
    verdict === 'fail'
      ? 'requires-metadata'
      : verdict === 'warning'
        ? 'eligible-with-limitations'
        : 'eligible';

  return {
    datasetId: dataset.metadata.datasetId,
    datasetRevision: dataset.revision,
    verdict,
    predictionEligible,
    predictionBlockers: blockers.map((c) => `${c.name}: ${c.measured}`),
    checks,
    observationMetrics: { totalCounts, detectedFeatures, mitochondrialFraction, lowCountOutlier, highCountOutlier },
    featureMetrics: { detectionRate, meanValue, varianceValue },
    summary: {
      observations: n,
      features: p,
      medianCountsPerObservation: median(totalCounts),
      medianFeaturesPerObservation: medianDetected,
      sparsity: n * p > 0 ? zeros / (n * p) : 0,
      medianNearestNeighbourDistance: medianNearest,
      coordinateUnit: dataset.metadata.coordinateUnit,
    },
    recommendedActions: recommendations(checks),
    eligibility,
  };
}

/**
 * Reference comparability — §4.3's "not comparable".
 *
 * Refusing a comparison is the useful behaviour here. A difference map between
 * a Visium section and a Xenium panel would render, and every pixel of it would
 * be assay effect.
 */
export interface ComparabilityResult {
  comparable: boolean;
  reasons: string[];
  warnings: string[];
  /** Features present in both, by id. */
  sharedFeatures: string[];
}

export function assessComparability(
  primary: SpatialDataset,
  reference: SpatialDataset,
): ComparabilityResult {
  const reasons: string[] = [];
  const warnings: string[] = [];

  if (primary.metadata.organism !== reference.metadata.organism) {
    reasons.push(
      `Different organisms: ${primary.metadata.organism} and ${reference.metadata.organism}.`,
    );
  }
  if (primary.metadata.assay !== reference.metadata.assay) {
    reasons.push(`Different assays: ${primary.metadata.assay} and ${reference.metadata.assay}.`);
  }
  if (primary.metadata.resolution !== reference.metadata.resolution) {
    reasons.push(
      `Different resolutions: ${primary.metadata.resolution} and ${reference.metadata.resolution}.`,
    );
  }
  if (primary.metadata.featureNamespace !== reference.metadata.featureNamespace) {
    reasons.push(
      `Different feature namespaces: ${primary.metadata.featureNamespace} and ${reference.metadata.featureNamespace}.`,
    );
  }
  if (primary.metadata.tissue.toLowerCase() !== reference.metadata.tissue.toLowerCase()) {
    warnings.push(
      `Different tissues (${primary.metadata.tissue} vs ${reference.metadata.tissue}); the comparison is between tissues, not conditions.`,
    );
  }
  if (primary.metadata.platform !== reference.metadata.platform) {
    warnings.push(
      `Different platforms (${primary.metadata.platform} vs ${reference.metadata.platform}); expect a batch component in every difference.`,
    );
  }

  const primaryFeatures = new Set(primary.features.map((f) => f.id));
  const shared = reference.features.filter((f) => primaryFeatures.has(f.id)).map((f) => f.id);
  const coverage = primary.features.length > 0 ? shared.length / primary.features.length : 0;
  if (coverage < 0.5) {
    reasons.push(
      `Only ${shared.length} of ${primary.features.length} primary features are measured in the reference (${(coverage * 100).toFixed(0)}%).`,
    );
  } else if (coverage < 0.9) {
    warnings.push(
      `${(coverage * 100).toFixed(0)}% feature overlap; the comparison is restricted to the shared ${shared.length}.`,
    );
  }

  return { comparable: reasons.length === 0, reasons, warnings, sharedFeatures: shared };
}

// ---------------------------------------------------------------------------

function nearestNeighbourDistances(dataset: SpatialDataset): Float64Array {
  const n = dataset.observations.length;
  if (n < 2) return new Float64Array(0);
  // Sampled above 2000 observations: the median of a 500-point sample is within
  // a percent of the full value and the full computation is quadratic.
  const stride = n > 2000 ? Math.ceil(n / 500) : 1;
  const out: number[] = [];
  for (let i = 0; i < n; i += stride) {
    const a = dataset.observations[i] as { x: number; y: number };
    let best = Infinity;
    for (let j = 0; j < n; j += 1) {
      if (i === j) continue;
      const b = dataset.observations[j] as { x: number; y: number };
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const distance = dx * dx + dy * dy;
      if (distance < best) best = distance;
    }
    if (Number.isFinite(best)) out.push(Math.sqrt(best));
  }
  return Float64Array.from(out);
}

function countDuplicatePositions(dataset: SpatialDataset): number {
  const seen = new Set<string>();
  let duplicates = 0;
  for (const observation of dataset.observations) {
    const key = `${observation.x}|${observation.y}|${observation.z ?? 0}`;
    if (seen.has(key)) duplicates += 1;
    else seen.add(key);
  }
  return duplicates;
}

function countBelow(values: ArrayLike<number>, threshold: number): number {
  let count = 0;
  for (let i = 0; i < values.length; i += 1) if ((values[i] as number) < threshold) count += 1;
  return count;
}

function countAbove(values: ArrayLike<number>, threshold: number): number {
  let count = 0;
  for (let i = 0; i < values.length; i += 1) if ((values[i] as number) > threshold) count += 1;
  return count;
}

function recommendations(checks: QcCheck[]): string[] {
  const actions: string[] = [];
  for (const check of checks) {
    if (check.verdict === 'pass') continue;
    switch (check.id) {
      case 'structure.unique-observation-ids':
        actions.push('Deduplicate observation identifiers before re-uploading.');
        break;
      case 'structure.feature-namespace':
        actions.push('Map the feature identifiers to the namespace the model pack uses, or choose a different model pack.');
        break;
      case 'observation.count-outliers':
        actions.push('Inspect the library-size outliers on the tissue map — a spatial cluster of them usually means a section artefact rather than cell quality.');
        break;
      case 'observation.minimum-features':
        actions.push('Filter the shallow observations, or choose a model pack calibrated on this depth.');
        break;
      case 'feature.never-detected':
        actions.push('Undetected features are excluded from analysis; confirm the panel matches the tissue.');
        break;
      case 'prediction.sample-size':
        actions.push('Predictive simulation needs a larger field of view; baseline analysis is still available.');
        break;
      case 'prediction.model-features':
        actions.push('Supply the missing model features, or select a pack whose schema this dataset satisfies.');
        break;
      case 'geometry.duplicate-positions':
        actions.push('Collapse or jitter co-located observations; a zero-distance edge has no defined weight.');
        break;
      default:
        actions.push(`${check.name}: ${check.measured}.`);
    }
  }
  return [...new Set(actions)];
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (Math.abs(value) >= 1000) return value.toFixed(0);
  if (Math.abs(value) >= 1) return value.toFixed(1);
  return value.toFixed(3);
}

export function qcVerdictLabel(verdict: QcVerdict): string {
  switch (verdict) {
    case 'pass': return 'PASS';
    case 'warning': return 'WARNING';
    case 'fail': return 'FAIL';
  }
}
