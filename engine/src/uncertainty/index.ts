/**
 * Uncertainty and out-of-domain assessment — §6.20.
 *
 * §6.20 forbids a universal confidence threshold and asks for the four
 * categories — High / Moderate / Exploratory / Not interpretable — to be
 * "mapped from approved rules". The rules are in this file, they are stated in
 * the output beside the category, and each one names what it measured.
 *
 * The out-of-domain score is a Mahalanobis-style distance in the training
 * embedding, which is the cheapest thing that actually answers the question
 * being asked: not "is this input unusual" but "is it unusual *in the
 * directions the training data varied in*". A Euclidean distance would flag a
 * section as out of domain for being large, which the model does not care
 * about, and miss one whose cell-type composition is unlike anything it saw,
 * which it very much does.
 */

import { mean, standardDeviation, quantile } from '../core/stats';
import type { Confidence } from '../core/labels';

// ---------------------------------------------------------------------------
// Out-of-domain
// ---------------------------------------------------------------------------

/** Summary statistics of the training distribution, frozen into the pack. */
export interface DomainReference {
  /** Named context features, in a fixed order. */
  featureNames: string[];
  means: Float64Array;
  standardDeviations: Float64Array;
  /**
   * Features that did not vary across the training corpus, and so are excluded
   * from the distance.
   *
   * A feature the training set holds constant carries no information about
   * whether a new run is inside or outside the distribution: there is no spread
   * to be far from. Giving it a unit standard deviation instead — which is what
   * `sd || 1` does — turns the raw difference into the z-score, and on a feature
   * measured in hundreds that single term swamps every real one.
   *
   * This is not hypothetical. Every section in the training corpus had exactly
   * 500 cells, so `observations` had zero variance; the bundled 2,400-cell case
   * scored z = 1900 and a domain distance of 1900.01 against a 99th-percentile
   * threshold of 3.92. The verdict was right by accident — that case is out of
   * domain because it is much denser than anything trained on — but the reason
   * given was arithmetic, not biology, and it hid the reason that was true.
   *
   * Excluding them is the conservative choice in the direction that matters:
   * it can only make a run look *more* in-domain, and a run that is genuinely
   * outside on a feature that varies is still caught by that feature.
   *
   * Optional, because a pack is a frozen artefact that outlives the code that
   * wrote it: a pack built before this existed has no such list. Its distances
   * were computed with the old unit-variance floor and are not comparable to
   * these, which is why `content:validate` refuses such a pack at build time
   * rather than leaving it to fail confusingly at run time. Reading one must
   * still not throw.
   */
  excludedFeatures?: string[];
  /** The 95th percentile of training distances, the in-domain boundary. */
  distanceP95: number;
  /** The 99th percentile — beyond this, the model is extrapolating. */
  distanceP99: number;
  sampleCount: number;
}

export interface OutOfDomainResult {
  distance: number;
  /** Where this run sits relative to the training distribution. */
  status: 'in-domain' | 'edge-of-domain' | 'out-of-domain';
  /**
   * Which context features are furthest from the training range.
   *
   * `excluded` marks a feature the training corpus held constant. It reads
   * z = 0 however far the run's value is, because there is no spread to measure
   * against — without the flag that looks like agreement rather than silence.
   */
  contributors: { name: string; z: number; value: number; trainingMean: number; excluded: boolean }[];
  explanation: string;
  /** Present when the reference had to drop a feature, naming which. */
  excludedNote?: string;
}

export function assessDomain(
  contextValues: Float64Array,
  reference: DomainReference,
): OutOfDomainResult {
  const contributors: OutOfDomainResult['contributors'] = [];
  const excluded = reference.excludedFeatures ?? [];
  let squared = 0;

  for (let i = 0; i < reference.featureNames.length; i += 1) {
    const sd = reference.standardDeviations[i] as number;
    const value = contextValues[i] as number;
    const trainingMean = reference.means[i] as number;
    const excluded = !(sd > 0);
    const z = excluded ? 0 : (value - trainingMean) / sd;
    squared += z * z;
    contributors.push({ name: reference.featureNames[i] as string, z, value, trainingMean, excluded });
  }

  const distance = Math.sqrt(squared);
  contributors.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));

  const status: OutOfDomainResult['status'] =
    distance > reference.distanceP99 ? 'out-of-domain' : distance > reference.distanceP95 ? 'edge-of-domain' : 'in-domain';

  const worst = contributors[0];
  return {
    distance,
    status,
    contributors: contributors.slice(0, 5),
    explanation:
      status === 'in-domain'
        ? `This run sits inside the range the model was fitted on (distance ${distance.toFixed(2)}, 95th percentile of training ${reference.distanceP95.toFixed(2)}).`
        : status === 'edge-of-domain'
          ? `This run is at the edge of the training distribution (distance ${distance.toFixed(2)} against a 95th percentile of ${reference.distanceP95.toFixed(2)}). ` +
            (worst ? `The largest departure is ${worst.name}, ${Math.abs(worst.z).toFixed(1)} standard deviations from the training mean.` : '')
          : `This run is outside the training distribution (distance ${distance.toFixed(2)} against a 99th percentile of ${reference.distanceP99.toFixed(2)}). ` +
            (worst ? `The largest departure is ${worst.name} at ${Math.abs(worst.z).toFixed(1)} standard deviations. ` : '') +
            'The model has not been measured under these conditions and its error here is unknown rather than large — those are different statements, and only the first is supported.',
    ...(excluded.length > 0
      ? {
          excludedNote:
            `${excluded.join(', ')} did not vary across the training corpus, so ${excluded.length === 1 ? 'it is' : 'they are'} ` +
            'not part of this distance. A constant carries no evidence about what counts as far away.',
        }
      : {}),
  };
}

/** Build the domain reference from the training corpus's context vectors. */
export function buildDomainReference(
  featureNames: string[],
  vectors: Float64Array[],
): DomainReference {
  const dimension = featureNames.length;
  const means = new Float64Array(dimension);
  const standardDeviations = new Float64Array(dimension);

  const excludedFeatures: string[] = [];

  for (let d = 0; d < dimension; d += 1) {
    const column = Float64Array.from(vectors, (vector) => vector[d] as number);
    const mu = mean(column);
    means[d] = mu;
    const sd = standardDeviation(column, mu);
    // Exactly zero variance, not "small": a narrow but real spread is evidence
    // about how much variation the model saw, and a threshold on it would be an
    // invented parameter. Zero is the case where there is no evidence at all.
    if (!Number.isFinite(sd) || sd <= 0) {
      standardDeviations[d] = 0;
      excludedFeatures.push(featureNames[d] as string);
    } else {
      standardDeviations[d] = sd;
    }
  }

  const distances = Float64Array.from(vectors, (vector) => domainDistance(vector, means, standardDeviations));

  return {
    featureNames,
    means,
    standardDeviations,
    excludedFeatures,
    distanceP95: quantile(distances, 0.95),
    distanceP99: quantile(distances, 0.99),
    sampleCount: vectors.length,
  };
}

/** The shared distance, so the reference's own percentiles and a later
 * assessment cannot drift apart. A zero standard deviation means the feature
 * was excluded and contributes nothing. */
function domainDistance(vector: Float64Array, means: Float64Array, standardDeviations: Float64Array): number {
  let squared = 0;
  for (let d = 0; d < means.length; d += 1) {
    const sd = standardDeviations[d] as number;
    if (!(sd > 0)) continue;
    const z = ((vector[d] as number) - (means[d] as number)) / sd;
    squared += z * z;
  }
  return Math.sqrt(squared);
}

// ---------------------------------------------------------------------------
// Ensemble uncertainty and calibration
// ---------------------------------------------------------------------------

export interface UncertaintyResult {
  /** Per-observation ensemble dispersion at the final stage. */
  perObservation: Float64Array;
  /** Section-level summary. */
  median: number;
  p90: number;
  /** Fraction of observations whose dispersion exceeds the calibrated band. */
  highDispersionFraction: number;
  /** Ensemble members that contributed. NaN dispersion below two. */
  members: number;
  /** The category, and the rule that produced it. */
  confidence: Confidence;
  rule: string;
  /** Empirical coverage of the ensemble interval, from the held-out set. */
  calibration: CalibrationSummary | null;
}

export interface CalibrationSummary {
  /** Nominal coverage the interval was constructed for. */
  nominal: number;
  /** Fraction of held-out targets that actually fell inside it. */
  empirical: number;
  /** Multiplier applied to the ensemble spread to reach nominal coverage. */
  scaleFactor: number;
  sampleCount: number;
  note: string;
}

export interface ConfidenceInput {
  /** Per-observation ensemble dispersion. */
  dispersion: Float64Array;
  members: number;
  domain: OutOfDomainResult;
  /** The weakest confidence anything upstream reported. */
  upstream: Confidence;
  /** Whether the perturbation was quantitative, exploratory or blocked. */
  perturbationDecision: 'quantitative' | 'exploratory' | 'blocked';
  calibration: CalibrationSummary | null;
  /** Dispersion above which an observation is called high-uncertainty. */
  dispersionThreshold: number;
}

/**
 * Map measurements onto the four §5.1 categories.
 *
 * Every branch names what it measured. A confidence badge whose rule is not
 * inspectable is a mood, and the "why" tooltip §6.20 requires has to have
 * something to say.
 */
export function assessConfidence(input: ConfidenceInput): UncertaintyResult {
  const sorted = Float64Array.from(input.dispersion).sort();
  const median = sorted.length > 0 ? quantile(sorted, 0.5) : Number.NaN;
  const p90 = sorted.length > 0 ? quantile(sorted, 0.9) : Number.NaN;

  let high = 0;
  for (let i = 0; i < input.dispersion.length; i += 1) {
    if ((input.dispersion[i] as number) > input.dispersionThreshold) high += 1;
  }
  const highDispersionFraction = input.dispersion.length > 0 ? high / input.dispersion.length : Number.NaN;

  let confidence: Confidence;
  let rule: string;

  if (input.perturbationDecision === 'blocked') {
    confidence = 'not-interpretable';
    rule = 'The perturbation was blocked at definition time, so there is no prediction to be confident about.';
  } else if (input.domain.status === 'out-of-domain') {
    confidence = 'not-interpretable';
    rule = Number.isFinite(input.domain.distance)
      ? `The run is outside the model's training distribution (distance ${input.domain.distance.toFixed(2)} > the 99th percentile). ` +
        'The model has no measured error here, so no confidence category above "not interpretable" can be justified.'
      : // No distance means no training distribution to compare against, which
        // is a different situation from being far from one. Formatting NaN into
        // "distance NaN > the 99th percentile" said neither.
        input.domain.explanation;
  } else if (input.members < 2) {
    confidence = 'exploratory';
    rule =
      'Only one ensemble member is loaded, so no disagreement can be measured. A single model always agrees with itself, and that is not evidence of anything.';
  } else if (input.perturbationDecision === 'exploratory') {
    confidence = 'exploratory';
    rule = 'The perturbation is outside the evidence-supported parameter range, so the whole prediction is exploratory whatever the ensemble agrees on.';
  } else if (input.domain.status === 'edge-of-domain') {
    confidence = 'moderate';
    rule = `The run sits at the edge of the training distribution (distance ${input.domain.distance.toFixed(2)} > the 95th percentile), so confidence is capped at moderate.`;
  } else if (highDispersionFraction > 0.25) {
    confidence = 'moderate';
    rule =
      `${(highDispersionFraction * 100).toFixed(0)}% of observations exceed the dispersion threshold of ${input.dispersionThreshold.toFixed(3)}, ` +
      'so the ensemble does not agree across much of the section.';
  } else if (input.calibration && input.calibration.empirical < input.calibration.nominal - 0.1) {
    confidence = 'moderate';
    rule =
      `The ensemble interval is under-covering on held-out data: ${(input.calibration.empirical * 100).toFixed(0)}% empirical against ` +
      `${(input.calibration.nominal * 100).toFixed(0)}% nominal, so the intervals are narrower than the errors.`;
  } else {
    confidence = 'high';
    rule =
      `The run is in domain, ${input.members} ensemble members agree within the calibrated band across ` +
      `${(100 - highDispersionFraction * 100).toFixed(0)}% of the section, and the perturbation is within its evidence-supported range.`;
  }

  // Upstream never improves: a prediction cannot be more confident than the
  // data it was computed from.
  const order: Confidence[] = ['high', 'moderate', 'exploratory', 'not-interpretable'];
  if (order.indexOf(input.upstream) > order.indexOf(confidence)) {
    confidence = input.upstream;
    rule = `Capped by upstream confidence: ${rule}`;
  }

  return {
    perObservation: input.dispersion,
    median,
    p90,
    highDispersionFraction,
    members: input.members,
    confidence,
    rule,
    calibration: input.calibration,
  };
}

/**
 * Calibrate the ensemble interval against held-out errors.
 *
 * A deep ensemble's spread is a *relative* measure of uncertainty and is
 * systematically too narrow as an absolute one — members trained on the same
 * data agree more than they are right. The scale factor is the multiplier that
 * makes the interval cover its nominal fraction on held-out data, and it is
 * reported rather than applied silently.
 */
export function calibrateEnsemble(
  errors: Float64Array,
  dispersions: Float64Array,
  nominal = 0.9,
): CalibrationSummary {
  const n = Math.min(errors.length, dispersions.length);
  if (n === 0) {
    return { nominal, empirical: Number.NaN, scaleFactor: Number.NaN, sampleCount: 0, note: 'No held-out data.' };
  }

  // z for a two-sided nominal interval under a normal assumption.
  const z = nominal >= 0.99 ? 2.576 : nominal >= 0.95 ? 1.96 : nominal >= 0.9 ? 1.645 : 1;

  let covered = 0;
  const ratios: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const spread = dispersions[i] as number;
    const error = Math.abs(errors[i] as number);
    if (spread > 0) {
      if (error <= z * spread) covered += 1;
      ratios.push(error / spread);
    }
  }

  const empirical = covered / n;
  const scaleFactor = ratios.length > 0 ? quantile(Float64Array.from(ratios), nominal) / z : Number.NaN;

  return {
    nominal,
    empirical,
    scaleFactor,
    sampleCount: n,
    note:
      `${(empirical * 100).toFixed(1)}% of held-out errors fell inside the nominal ${(nominal * 100).toFixed(0)}% interval. ` +
      (Number.isFinite(scaleFactor)
        ? `Multiplying the ensemble spread by ${scaleFactor.toFixed(2)} would reach nominal coverage. That factor is reported, not applied — an interval widened to hit a target is calibrated by construction and says nothing.`
        : 'No usable spread values, so no scale factor could be estimated.'),
  };
}

/** Per-observation context vector the domain check reads. */
export const DOMAIN_FEATURE_NAMES = [
  'observations',
  'median nearest-neighbour distance',
  'mean physical degree',
  'tumour fraction',
  'immune fraction',
  'stromal fraction',
  'mean baseline activity',
  'baseline activity spread',
  'perturbed fraction',
];
