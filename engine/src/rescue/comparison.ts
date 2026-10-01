/**
 * Predicted altered tissue, difference metrics and reference recovery —
 * §6.16 and §7.6.
 *
 * Two rules from the handbook shape this file.
 *
 * §6.16: "preserve the original baseline object". Nothing here mutates an
 * input. The predicted state is a new object and the difference is a third.
 *
 * §7.6: recovery is defined only when the reference, the disease baseline and
 * the treated prediction are comparable, and "overshoot and sign reversal must
 * be flagged rather than automatically interpreted as improvement". That is not
 * a detail. The recovery formula R = 1 - |T-H| / (|D-H| + eps) returns a number
 * near 1 both when a feature has been restored to the reference and when it has
 * sailed past it in the same direction — and the second is not a rescue, it is
 * a different disease. Both cases are detected and reported separately here.
 */

import { mean, pearson, cosineSimilarity } from '../core/stats';
import type { TissueState } from '../propagate/mechanism';
import type { CompiledNetwork } from '../propagate/network';

export interface DifferenceResult {
  /** Per-observation, per-node signed change. */
  nodeDelta: Float64Array;
  /** Per-observation magnitude of change (L2 over nodes). */
  observationMagnitude: Float64Array;
  /** Per-node mean change across the section. */
  nodeMeanDelta: Float64Array;
  /** Per-node, per-class mean change. */
  byClass: { className: string; count: number; nodeMeanDelta: Float64Array }[];
  /** Overall magnitude, for the headline metric. */
  meanMagnitude: number;
  /** Fraction of observations that changed beyond the noise floor. */
  changedFraction: number;
  noiseFloor: number;
}

export function differenceBetween(
  baseline: TissueState,
  predicted: TissueState,
  labels: (string | undefined)[],
  noiseFloor = 0.01,
): DifferenceResult {
  const n = baseline.observationCount;
  const k = baseline.nodeCount;
  const nodeDelta = new Float64Array(n * k);
  const observationMagnitude = new Float64Array(n);
  const nodeMeanDelta = new Float64Array(k);

  let changed = 0;
  for (let i = 0; i < n; i += 1) {
    let squared = 0;
    for (let node = 0; node < k; node += 1) {
      const offset = i * k + node;
      const delta = (predicted.activity[offset] as number) - (baseline.activity[offset] as number);
      nodeDelta[offset] = delta;
      nodeMeanDelta[node] = (nodeMeanDelta[node] as number) + delta;
      squared += delta * delta;
    }
    const magnitude = Math.sqrt(squared / k);
    observationMagnitude[i] = magnitude;
    if (magnitude > noiseFloor) changed += 1;
  }
  for (let node = 0; node < k; node += 1) nodeMeanDelta[node] = (nodeMeanDelta[node] as number) / Math.max(1, n);

  const classNames = [...new Set(labels.filter((l): l is string => Boolean(l)))].sort();
  const byClass = classNames.map((className) => {
    const members: number[] = [];
    for (let i = 0; i < n; i += 1) if (labels[i] === className) members.push(i);
    const perNode = new Float64Array(k);
    for (const i of members) {
      for (let node = 0; node < k; node += 1) {
        perNode[node] = (perNode[node] as number) + (nodeDelta[i * k + node] as number);
      }
    }
    for (let node = 0; node < k; node += 1) perNode[node] = (perNode[node] as number) / Math.max(1, members.length);
    return { className, count: members.length, nodeMeanDelta: perNode };
  });

  return {
    nodeDelta,
    observationMagnitude,
    nodeMeanDelta,
    byClass,
    meanMagnitude: mean(observationMagnitude),
    changedFraction: n > 0 ? changed / n : 0,
    noiseFloor,
  };
}

// ---------------------------------------------------------------------------
// Reference recovery — §7.6
// ---------------------------------------------------------------------------

export type RecoveryVerdict =
  /** Moved toward the reference and stopped short of or at it. */
  | 'recovered'
  /** Moved toward the reference but passed it, and kept going. */
  | 'overshoot'
  /** Moved away from the reference. */
  | 'worsened'
  /** The disease and reference are already the same here; nothing to recover. */
  | 'no-gap'
  /** Not comparable, so no recovery is defined. */
  | 'undefined';

export interface FeatureRecovery {
  nodeIndex: number;
  symbol: string;
  /** H — the reference level. */
  reference: number;
  /** D — the untreated disease level. */
  disease: number;
  /** T — the treated prediction. */
  treated: number;
  /** R_f as §7.6 defines it. Present whatever the verdict, so it can be read
   *  alongside the verdict rather than instead of it. */
  recovery: number;
  verdict: RecoveryVerdict;
  /** How far past the reference, in units of the original gap. Zero unless overshoot. */
  overshootFraction: number;
}

export interface RecoveryResult {
  features: FeatureRecovery[];
  /** Mean recovery over features with a real gap and no overshoot. */
  meanRecovery: number;
  /** Counts by verdict, which is what makes a single mean readable. */
  counts: Record<RecoveryVerdict, number>;
  /** Features that overshot, named. */
  overshooting: string[];
  /** Features that moved away from the reference. */
  worsening: string[];
  comparable: boolean;
  note: string;
}

/**
 * Feature-level recovery toward a comparable reference.
 *
 * `epsilon` is relative to the observed gap rather than absolute: a fixed
 * epsilon makes the recovery of a feature with a tiny gap depend entirely on
 * the constant, and every low-expression gene then reports a confident value.
 */
export function referenceRecovery(
  reference: Float64Array,
  disease: Float64Array,
  treated: Float64Array,
  network: CompiledNetwork,
  comparable: boolean,
  gapFloor = 0.02,
): RecoveryResult {
  const k = network.nodes.length;
  const features: FeatureRecovery[] = [];
  const counts: Record<RecoveryVerdict, number> = {
    recovered: 0, overshoot: 0, worsened: 0, 'no-gap': 0, undefined: 0,
  };
  const overshooting: string[] = [];
  const worsening: string[] = [];
  const recovered: number[] = [];

  for (let node = 0; node < k; node += 1) {
    const h = reference[node] as number;
    const d = disease[node] as number;
    const t = treated[node] as number;
    const symbol = (network.nodes[node] as { symbol: string }).symbol;
    const gap = d - h;

    let verdict: RecoveryVerdict;
    let overshootFraction = 0;

    if (!comparable) {
      verdict = 'undefined';
    } else if (Math.abs(gap) < gapFloor) {
      verdict = 'no-gap';
    } else {
      const remaining = t - h;
      if (Math.sign(remaining) !== Math.sign(gap) && Math.abs(remaining) > gapFloor) {
        // Crossed the reference: the sign of the residual flipped.
        verdict = 'overshoot';
        overshootFraction = Math.abs(remaining) / Math.abs(gap);
        overshooting.push(symbol);
      } else if (Math.abs(remaining) > Math.abs(gap)) {
        verdict = 'worsened';
        worsening.push(symbol);
      } else {
        verdict = 'recovered';
      }
    }

    const epsilon = Math.max(1e-6, Math.abs(gap) * 1e-3);
    const recovery = 1 - Math.abs(t - h) / (Math.abs(gap) + epsilon);
    counts[verdict] += 1;
    if (verdict === 'recovered') recovered.push(recovery);

    features.push({
      nodeIndex: node, symbol, reference: h, disease: d, treated: t,
      recovery, verdict, overshootFraction,
    });
  }

  return {
    features,
    meanRecovery: recovered.length > 0 ? mean(recovered) : Number.NaN,
    counts,
    overshooting,
    worsening,
    comparable,
    note: comparable
      ? `Mean recovery is over the ${counts.recovered} feature(s) that moved toward the reference without passing it. ` +
        `${counts.overshoot} overshot and ${counts.worsened} moved further away; both are excluded from the mean and listed separately, because averaging an overshoot in would read as a rescue. ` +
        `${counts['no-gap']} feature(s) had no gap larger than ${gapFloor} to close.`
      : 'The reference is not biologically comparable to this dataset, so §7.6 recovery is undefined and no value is reported.',
  };
}

/** Section-mean activity per node, the form recovery is computed on. */
export function sectionProfile(state: TissueState): Float64Array {
  const k = state.nodeCount;
  const out = new Float64Array(k);
  for (let i = 0; i < state.observationCount; i += 1) {
    for (let node = 0; node < k; node += 1) {
      out[node] = (out[node] as number) + (state.activity[i * k + node] as number);
    }
  }
  for (let node = 0; node < k; node += 1) out[node] = (out[node] as number) / Math.max(1, state.observationCount);
  return out;
}

/** Profile restricted to one class, for per-compartment recovery. */
export function classProfile(
  state: TissueState,
  labels: (string | undefined)[],
  className: string,
): Float64Array {
  const k = state.nodeCount;
  const out = new Float64Array(k);
  let count = 0;
  for (let i = 0; i < state.observationCount; i += 1) {
    if (labels[i] !== className) continue;
    count += 1;
    for (let node = 0; node < k; node += 1) {
      out[node] = (out[node] as number) + (state.activity[i * k + node] as number);
    }
  }
  if (count > 0) for (let node = 0; node < k; node += 1) out[node] = (out[node] as number) / count;
  else out.fill(Number.NaN);
  return out;
}

// ---------------------------------------------------------------------------
// Prediction versus observation — §6.23
// ---------------------------------------------------------------------------

export interface PredictionVsObservation {
  /** Pearson across matched features. */
  correlation: number;
  spearmanCorrelation: number;
  cosine: number;
  meanAbsoluteError: number;
  /** Features present in both, by symbol. */
  matched: string[];
  /** Predicted features the observation does not cover. */
  unmatched: string[];
  /** Per-feature comparison, for the scatter §12.4 asks for. */
  points: { symbol: string; predicted: number; observed: number }[];
  note: string;
}

/**
 * Compare a predicted change with an observed one.
 *
 * Deliberately a separate object rather than an edit to the prediction: §6.23
 * requires that "optional observed validation data creates a new
 * ValidationComparison object without editing the original prediction". A
 * prediction that can be revised after the fact is not a prediction.
 */
export function compareWithObservation(
  predictedDelta: Float64Array,
  observedDelta: Map<string, number>,
  network: CompiledNetwork,
): PredictionVsObservation {
  const matched: string[] = [];
  const unmatched: string[] = [];
  const predictedValues: number[] = [];
  const observedValues: number[] = [];
  const points: { symbol: string; predicted: number; observed: number }[] = [];

  for (let node = 0; node < network.nodes.length; node += 1) {
    const symbol = (network.nodes[node] as { symbol: string }).symbol;
    const observed = observedDelta.get(symbol) ?? observedDelta.get(symbol.toUpperCase());
    if (observed === undefined) {
      unmatched.push(symbol);
      continue;
    }
    matched.push(symbol);
    const predicted = predictedDelta[node] as number;
    predictedValues.push(predicted);
    observedValues.push(observed);
    points.push({ symbol, predicted, observed });
  }

  const rank = (values: number[]): number[] => {
    const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
    const out = new Array<number>(values.length);
    order.forEach((entry, position) => {
      out[entry.index] = position + 1;
    });
    return out;
  };

  return {
    correlation: pearson(predictedValues, observedValues),
    spearmanCorrelation:
      predictedValues.length > 1 ? pearson(rank(predictedValues), rank(observedValues)) : Number.NaN,
    cosine: cosineSimilarity(predictedValues, observedValues),
    meanAbsoluteError:
      predictedValues.length > 0
        ? predictedValues.reduce((total, value, index) => total + Math.abs(value - (observedValues[index] as number)), 0) /
          predictedValues.length
        : Number.NaN,
    matched,
    unmatched,
    points,
    note:
      matched.length === 0
        ? 'No feature in the uploaded observation matches the model’s feature space, so no comparison was possible.'
        : `Compared on the ${matched.length} feature(s) present in both. ` +
          `${unmatched.length} predicted feature(s) are not covered by the observation and are excluded rather than treated as zero.`,
  };
}
