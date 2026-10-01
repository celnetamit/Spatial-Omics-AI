/**
 * The statistics every COMPUTED number in this lab passes through.
 *
 * Nothing here is approximated for convenience. A differential-expression
 * p-value that is "about right" is worse than no p-value, because it is read
 * as a threshold and acted on: the incomplete beta below is a continued
 * fraction evaluated to 1e-14, not a normal approximation to the t
 * distribution, which would be visibly wrong at the sample sizes a single
 * region of a tissue actually gives you (tens of cells, not thousands).
 */

// ---------------------------------------------------------------------------
// Descriptive
// ---------------------------------------------------------------------------

export function mean(values: ArrayLike<number>): number {
  if (values.length === 0) return Number.NaN;
  let total = 0;
  for (let i = 0; i < values.length; i += 1) total += values[i] as number;
  return total / values.length;
}

/** Sample variance (n-1). NaN for n < 2, which is honest rather than zero. */
export function variance(values: ArrayLike<number>, knownMean?: number): number {
  const n = values.length;
  if (n < 2) return Number.NaN;
  const m = knownMean ?? mean(values);
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    const d = (values[i] as number) - m;
    sum += d * d;
  }
  return sum / (n - 1);
}

export function standardDeviation(values: ArrayLike<number>, knownMean?: number): number {
  return Math.sqrt(variance(values, knownMean));
}

export function median(values: ArrayLike<number>): number {
  return quantile(values, 0.5);
}

/** Linear-interpolated quantile (the type-7 definition numpy uses by default). */
export function quantile(values: ArrayLike<number>, q: number): number {
  const n = values.length;
  if (n === 0) return Number.NaN;
  const sorted = Float64Array.from(values as ArrayLike<number>).sort();
  if (n === 1) return sorted[0] as number;
  const position = (n - 1) * Math.min(1, Math.max(0, q));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower] as number;
  const weight = position - lower;
  return (sorted[lower] as number) * (1 - weight) + (sorted[upper] as number) * weight;
}

/** Median absolute deviation, scaled to be a consistent estimator of sigma. */
export function medianAbsoluteDeviation(values: ArrayLike<number>): number {
  const m = median(values);
  const deviations = new Float64Array(values.length);
  for (let i = 0; i < values.length; i += 1) deviations[i] = Math.abs((values[i] as number) - m);
  return 1.4826 * median(deviations);
}

export function sum(values: ArrayLike<number>): number {
  let total = 0;
  for (let i = 0; i < values.length; i += 1) total += values[i] as number;
  return total;
}

// ---------------------------------------------------------------------------
// Special functions
// ---------------------------------------------------------------------------

const LOG_GAMMA_COEFFICIENTS = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** Lanczos approximation; accurate to ~1e-15 for the range we use. */
export function logGamma(x: number): number {
  if (x < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  const z = x - 1;
  let a = 0.99999999999980993;
  for (let i = 0; i < LOG_GAMMA_COEFFICIENTS.length; i += 1) {
    a += (LOG_GAMMA_COEFFICIENTS[i] as number) / (z + i + 1);
  }
  const t = z + LOG_GAMMA_COEFFICIENTS.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

export function logBeta(a: number, b: number): number {
  return logGamma(a) + logGamma(b) - logGamma(a + b);
}

/**
 * Regularised incomplete beta I_x(a, b), by the Lentz continued fraction.
 *
 * This is the engine of the t-test p-value. It converges to 1e-14 in a few
 * dozen iterations across the whole range once the symmetry transform keeps x
 * on the fast side of the fraction.
 */
export function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  if (x > (a + 1) / (a + b + 2)) return 1 - incompleteBeta(1 - x, b, a);

  const front = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - logBeta(a, b)) / a;

  const tiny = 1e-30;
  let f = 1;
  let c = 1;
  let d = 0;

  for (let i = 0; i <= 300; i += 1) {
    const m = Math.floor(i / 2);
    let numerator: number;
    if (i === 0) {
      numerator = 1;
    } else if (i % 2 === 0) {
      numerator = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
    } else {
      numerator = (-((a + m) * (a + b + m)) * x) / ((a + 2 * m) * (a + 2 * m + 1));
    }

    d = 1 + numerator * d;
    if (Math.abs(d) < tiny) d = tiny;
    d = 1 / d;

    c = 1 + numerator / c;
    if (Math.abs(c) < tiny) c = tiny;

    const step = c * d;
    f *= step;

    if (Math.abs(1 - step) < 1e-14) return front * (f - 1);
  }
  // Non-convergence is reported, not rounded away.
  return Number.NaN;
}

/** Two-sided tail of Student's t with `df` degrees of freedom. */
export function tDistributionTwoSided(t: number, df: number): number {
  if (!Number.isFinite(t) || !Number.isFinite(df) || df <= 0) return Number.NaN;
  const x = df / (df + t * t);
  const p = incompleteBeta(x, df / 2, 0.5);
  return Math.min(1, Math.max(0, p));
}

/**
 * Standard normal CDF.
 *
 * Written in terms of `erfc` rather than `1 - erf` for negative z, because the
 * subtraction loses every significant digit in the far tail: at z = -8 the true
 * value is 6e-16 and `1 - erf(8/sqrt2)` evaluates to exactly 0. A permutation
 * test never reaches there, but a Mann–Whitney on a clean separation does.
 */
export function normalCdf(z: number): number {
  const scaled = z / Math.SQRT2;
  return scaled < 0 ? 0.5 * erfc(-scaled) : 1 - 0.5 * erfc(scaled);
}

/**
 * The error function, to machine precision, through the incomplete gamma.
 *
 * The usual rational approximations carry an error around 1e-7, which is
 * invisible in a plot and not invisible in a p-value: the first version of this
 * file used one, and the Mann–Whitney tests disagreed with SciPy in the eighth
 * decimal place. That is small, but it is a disagreement with no explanation,
 * and a number this lab reports should not have one.
 *
 * erf(x) = sign(x) * P(1/2, x^2), where P is the regularised lower incomplete
 * gamma — series below the crossover, continued fraction above it, both
 * iterated to 1e-16.
 */
export function erf(x: number): number {
  if (x === 0) return 0;
  const value = lowerIncompleteGammaRegularised(0.5, x * x);
  return x < 0 ? -value : value;
}

export function erfc(x: number): number {
  if (x === 0) return 1;
  if (x < 0) return 1 + lowerIncompleteGammaRegularised(0.5, x * x);
  return upperIncompleteGammaRegularised(0.5, x * x);
}

/** P(a, x), by series. Accurate and quick for x < a + 1. */
function gammaSeries(a: number, x: number): number {
  if (x <= 0) return 0;
  let ap = a;
  let sum = 1 / a;
  let term = sum;
  for (let i = 0; i < 1000; i += 1) {
    ap += 1;
    term *= x / ap;
    sum += term;
    if (Math.abs(term) < Math.abs(sum) * 1e-16) break;
  }
  return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
}

/** Q(a, x), by the Lentz continued fraction. Used for x >= a + 1. */
function gammaContinuedFraction(a: number, x: number): number {
  const tiny = 1e-300;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= 1000; i += 1) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const step = d * c;
    h *= step;
    if (Math.abs(step - 1) < 1e-16) break;
  }
  return Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
}

export function lowerIncompleteGammaRegularised(a: number, x: number): number {
  if (x < 0 || a <= 0) return Number.NaN;
  if (x === 0) return 0;
  return x < a + 1 ? gammaSeries(a, x) : 1 - gammaContinuedFraction(a, x);
}

export function upperIncompleteGammaRegularised(a: number, x: number): number {
  if (x < 0 || a <= 0) return Number.NaN;
  if (x === 0) return 1;
  return x < a + 1 ? 1 - gammaSeries(a, x) : gammaContinuedFraction(a, x);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

export interface TTestResult {
  statistic: number;
  df: number;
  pValue: number;
  meanA: number;
  meanB: number;
  /** Difference of means, in the units of the input. */
  difference: number;
  /** Hedges-corrected standardised effect size. */
  effectSize: number;
  nA: number;
  nB: number;
}

/**
 * Welch's unequal-variance t-test.
 *
 * Welch rather than Student because cell populations in a tissue are not the
 * same size and emphatically do not have the same variance — a tumour core and
 * its stromal rim differ in both, and pooling them inflates significance for
 * the smaller group.
 */
export function welchTTest(a: ArrayLike<number>, b: ArrayLike<number>): TTestResult {
  const nA = a.length;
  const nB = b.length;
  const meanA = mean(a);
  const meanB = mean(b);

  if (nA < 2 || nB < 2) {
    return {
      statistic: Number.NaN, df: Number.NaN, pValue: Number.NaN,
      meanA, meanB, difference: meanA - meanB, effectSize: Number.NaN, nA, nB,
    };
  }

  const varA = variance(a, meanA);
  const varB = variance(b, meanB);
  const sA = varA / nA;
  const sB = varB / nB;
  const denominator = Math.sqrt(sA + sB);

  if (denominator === 0 || !Number.isFinite(denominator)) {
    // Both groups constant: no evidence of difference, and saying p = 0 here
    // because the means differ would be a fabrication.
    return {
      statistic: 0, df: nA + nB - 2, pValue: 1,
      meanA, meanB, difference: meanA - meanB, effectSize: 0, nA, nB,
    };
  }

  const statistic = (meanA - meanB) / denominator;
  const df =
    (sA + sB) * (sA + sB) / ((sA * sA) / (nA - 1) + (sB * sB) / (nB - 1));
  const pValue = tDistributionTwoSided(statistic, df);

  const pooledSd = Math.sqrt(((nA - 1) * varA + (nB - 1) * varB) / (nA + nB - 2));
  const cohensD = pooledSd > 0 ? (meanA - meanB) / pooledSd : 0;
  // Hedges' g: the small-sample correction matters when a cell type has 12
  // members, which in spatial data it often does.
  const correction = 1 - 3 / (4 * (nA + nB) - 9);
  const effectSize = cohensD * (Number.isFinite(correction) ? correction : 1);

  return { statistic, df, pValue, meanA, meanB, difference: meanA - meanB, effectSize, nA, nB };
}

/**
 * Mann–Whitney U with a normal approximation and tie correction.
 *
 * Offered alongside Welch because expression is not normal at low counts, and
 * the model pack names which test was used rather than this file deciding.
 */
export function mannWhitneyU(a: ArrayLike<number>, b: ArrayLike<number>): {
  statistic: number; pValue: number; auc: number;
} {
  const nA = a.length;
  const nB = b.length;
  if (nA === 0 || nB === 0) return { statistic: Number.NaN, pValue: Number.NaN, auc: Number.NaN };

  const combined: { value: number; group: 0 | 1 }[] = [];
  for (let i = 0; i < nA; i += 1) combined.push({ value: a[i] as number, group: 0 });
  for (let i = 0; i < nB; i += 1) combined.push({ value: b[i] as number, group: 1 });
  combined.sort((x, y) => x.value - y.value);

  const ranks = new Float64Array(combined.length);
  let tieCorrection = 0;
  let i = 0;
  while (i < combined.length) {
    let j = i;
    while (j + 1 < combined.length && (combined[j + 1] as { value: number }).value === (combined[i] as { value: number }).value) j += 1;
    const averageRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) ranks[k] = averageRank;
    const tied = j - i + 1;
    if (tied > 1) tieCorrection += tied * tied * tied - tied;
    i = j + 1;
  }

  let rankSumA = 0;
  for (let k = 0; k < combined.length; k += 1) {
    if ((combined[k] as { group: 0 | 1 }).group === 0) rankSumA += ranks[k] as number;
  }

  const u = rankSumA - (nA * (nA + 1)) / 2;
  const n = nA + nB;
  const meanU = (nA * nB) / 2;
  const sdU = Math.sqrt(
    ((nA * nB) / 12) * ((n + 1) - tieCorrection / (n * (n - 1))),
  );
  if (!(sdU > 0)) return { statistic: u, pValue: 1, auc: u / (nA * nB) };

  const z = (u - meanU - Math.sign(u - meanU) * 0.5) / sdU;
  const pValue = 2 * (1 - normalCdf(Math.abs(z)));
  return { statistic: u, pValue: Math.min(1, Math.max(0, pValue)), auc: u / (nA * nB) };
}

/**
 * Benjamini–Hochberg adjusted p-values, with the monotonicity enforced.
 *
 * The enforcement is not decoration: without the running minimum from the
 * largest p downwards, an adjusted value can exceed the next one up, and a
 * feature table sorted by q then shows a *less* significant gene above a more
 * significant one. NaN inputs stay NaN rather than being treated as 1, so a
 * feature with too few cells to test is reported as untested.
 */
export function benjaminiHochberg(pValues: ArrayLike<number>): Float64Array {
  const n = pValues.length;
  const adjusted = new Float64Array(n).fill(Number.NaN);

  const testable: { p: number; index: number }[] = [];
  for (let i = 0; i < n; i += 1) {
    const p = pValues[i] as number;
    if (Number.isFinite(p)) testable.push({ p, index: i });
  }
  if (testable.length === 0) return adjusted;

  testable.sort((a, b) => a.p - b.p);
  const m = testable.length;
  let running = 1;
  for (let rank = m; rank >= 1; rank -= 1) {
    const entry = testable[rank - 1] as { p: number; index: number };
    running = Math.min(running, (entry.p * m) / rank);
    adjusted[entry.index] = Math.min(1, running);
  }
  return adjusted;
}

/** Bonferroni, offered because some model packs specify it. */
export function bonferroni(pValues: ArrayLike<number>): Float64Array {
  const out = new Float64Array(pValues.length);
  for (let i = 0; i < pValues.length; i += 1) {
    const p = pValues[i] as number;
    out[i] = Number.isFinite(p) ? Math.min(1, p * pValues.length) : Number.NaN;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Association
// ---------------------------------------------------------------------------

export function pearson(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return Number.NaN;
  const ma = mean(a);
  const mb = mean(b);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i += 1) {
    const x = (a[i] as number) - ma;
    const y = (b[i] as number) - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  const denominator = Math.sqrt(da * db);
  return denominator > 0 ? num / denominator : Number.NaN;
}

/** Average ranks, so ties do not silently order themselves by index. */
export function ranks(values: ArrayLike<number>): Float64Array {
  const n = values.length;
  const order = Array.from({ length: n }, (_, i) => i).sort(
    (x, y) => (values[x] as number) - (values[y] as number),
  );
  const out = new Float64Array(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (
      j + 1 < n &&
      (values[order[j + 1] as number] as number) === (values[order[i] as number] as number)
    ) {
      j += 1;
    }
    const averageRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) out[order[k] as number] = averageRank;
    i = j + 1;
  }
  return out;
}

export function spearman(a: ArrayLike<number>, b: ArrayLike<number>): number {
  return pearson(ranks(a), ranks(b));
}

/** Kendall's tau-b, for candidate ranking agreement (§14.2). */
export function kendallTau(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return Number.NaN;
  let concordant = 0;
  let discordant = 0;
  let tiedA = 0;
  let tiedB = 0;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const da = (a[i] as number) - (a[j] as number);
      const db = (b[i] as number) - (b[j] as number);
      const product = da * db;
      if (product > 0) concordant += 1;
      else if (product < 0) discordant += 1;
      else {
        if (da === 0) tiedA += 1;
        if (db === 0) tiedB += 1;
      }
    }
  }
  const total = (n * (n - 1)) / 2;
  const denominator = Math.sqrt((total - tiedA) * (total - tiedB));
  return denominator > 0 ? (concordant - discordant) / denominator : Number.NaN;
}

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denominator = Math.sqrt(na * nb);
  return denominator > 0 ? dot / denominator : Number.NaN;
}

export function meanAbsoluteError(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return Number.NaN;
  let total = 0;
  for (let i = 0; i < n; i += 1) total += Math.abs((a[i] as number) - (b[i] as number));
  return total / n;
}

export function rootMeanSquareError(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return Number.NaN;
  let total = 0;
  for (let i = 0; i < n; i += 1) {
    const d = (a[i] as number) - (b[i] as number);
    total += d * d;
  }
  return Math.sqrt(total / n);
}

/**
 * Area under the ROC curve, by the Mann–Whitney identity.
 *
 * `labels` is 1 for the positive class. Returns NaN when one class is absent,
 * which is the honest answer rather than 0.5.
 */
export function auroc(scores: ArrayLike<number>, labels: ArrayLike<number>): number {
  const positives: number[] = [];
  const negatives: number[] = [];
  for (let i = 0; i < scores.length; i += 1) {
    if ((labels[i] as number) > 0.5) positives.push(scores[i] as number);
    else negatives.push(scores[i] as number);
  }
  if (positives.length === 0 || negatives.length === 0) return Number.NaN;
  return mannWhitneyU(positives, negatives).auc;
}

/** Average precision — the AUPRC estimator that does not interpolate. */
export function averagePrecision(scores: ArrayLike<number>, labels: ArrayLike<number>): number {
  const order = Array.from({ length: scores.length }, (_, i) => i).sort(
    (a, b) => (scores[b] as number) - (scores[a] as number),
  );
  let positivesSeen = 0;
  let total = 0;
  let positives = 0;
  for (let i = 0; i < labels.length; i += 1) if ((labels[i] as number) > 0.5) positives += 1;
  if (positives === 0) return Number.NaN;

  for (let rank = 0; rank < order.length; rank += 1) {
    const index = order[rank] as number;
    if ((labels[index] as number) > 0.5) {
      positivesSeen += 1;
      total += positivesSeen / (rank + 1);
    }
  }
  return total / positives;
}

/** Brier score for probabilistic outputs (§14.2). */
export function brierScore(probabilities: ArrayLike<number>, outcomes: ArrayLike<number>): number {
  const n = Math.min(probabilities.length, outcomes.length);
  if (n === 0) return Number.NaN;
  let total = 0;
  for (let i = 0; i < n; i += 1) {
    const d = (probabilities[i] as number) - (outcomes[i] as number);
    total += d * d;
  }
  return total / n;
}

// ---------------------------------------------------------------------------
// Empirical p-values
// ---------------------------------------------------------------------------

/**
 * A permutation p-value with the +1 correction in both places.
 *
 * Without it a test with 1000 permutations can report p = 0, which is not a
 * probability anyone measured — it is "smaller than 1/1000", and the correction
 * says exactly that. §6.7 sets n_perm >= 1000 for final analysis, so the
 * smallest reportable value here is 1/1001.
 */
export function permutationPValue(
  observed: number,
  nullDistribution: ArrayLike<number>,
  tail: 'greater' | 'less' | 'two-sided' = 'greater',
): number {
  const n = nullDistribution.length;
  if (n === 0) return Number.NaN;
  let extreme = 0;
  for (let i = 0; i < n; i += 1) {
    const value = nullDistribution[i] as number;
    if (tail === 'greater' && value >= observed) extreme += 1;
    else if (tail === 'less' && value <= observed) extreme += 1;
    else if (tail === 'two-sided' && Math.abs(value) >= Math.abs(observed)) extreme += 1;
  }
  return (extreme + 1) / (n + 1);
}

/** z-score of an observation against an empirical null. */
export function empiricalZ(observed: number, nullDistribution: ArrayLike<number>): number {
  const m = mean(nullDistribution);
  const sd = standardDeviation(nullDistribution, m);
  return sd > 0 ? (observed - m) / sd : Number.NaN;
}
