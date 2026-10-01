/**
 * Baseline molecular, pathway and cell-state analysis — §6.6.
 *
 * What the tissue looks like before anything is done to it. Three layers, each
 * with its own statistics and its own honest failure mode:
 *
 *  - features, by a per-group differential test with FDR control;
 *  - pathways, by a decoupler-style weighted mean against a permutation null,
 *    which is the difference between "this pathway's genes are expressed" and
 *    "this pathway's genes are expressed *more than a random gene set of the
 *    same size*" — the first is mostly a statement about how many genes the
 *    pathway has;
 *  - cell states, as signature scores that are explicitly relative.
 *
 * Every test here reports its own n. A pathway score over three cells is not
 * wrong, but it is not a finding either, and the table has to say which it is.
 */

import { benjaminiHochberg, bonferroni, mannWhitneyU, welchTTest, mean, standardDeviation, empiricalZ, permutationPValue } from '../core/stats';
import type { Rng } from '../core/rng';
import type { MethodRecord } from '../core/provenance';
import type { DatasetView } from '../data/types';
import { featureIndexMap } from '../data/types';

// ---------------------------------------------------------------------------
// Differential features
// ---------------------------------------------------------------------------

export interface FeatureStatistic {
  featureId: string;
  symbol: string;
  modality: 'transcriptomics' | 'proteomics';
  group: string;
  /** Mean in the group, on the view's scale. */
  groupMean: number;
  /** Mean in everything else. */
  restMean: number;
  /** Difference of means. Called this rather than "fold change" because the
   *  view is log-transformed, so it already is a log ratio. */
  logDifference: number;
  statistic: number;
  pValue: number;
  qValue: number;
  effectSize: number;
  /** Fraction of the group in which the feature is detected. */
  detectionInGroup: number;
  detectionInRest: number;
  nGroup: number;
  nRest: number;
}

export interface DifferentialOptions {
  test: 'welch' | 'mann-whitney';
  correction: 'benjamini-hochberg' | 'bonferroni';
  /** Groups smaller than this are reported but not tested. */
  minimumGroupSize: number;
  /** Features detected in fewer than this fraction of either side are skipped. */
  minimumDetection: number;
}

export const DEFAULT_DIFFERENTIAL: DifferentialOptions = {
  test: 'welch',
  correction: 'benjamini-hochberg',
  minimumGroupSize: 10,
  minimumDetection: 0.05,
};

/**
 * One-vs-rest differential analysis per group.
 *
 * Correction is applied *within* each group's test family, not across all
 * groups at once. Pooling them would make the adjusted p-value for a marker
 * depend on how many other cell types happen to be in the section, which is not
 * a property of the marker.
 */
export function differentialFeatures(
  view: DatasetView,
  groups: (string | undefined)[],
  options: DifferentialOptions,
): { results: FeatureStatistic[]; method: MethodRecord; skipped: string[] } {
  const n = view.observations.length;
  const p = view.features.length;
  const classes = [...new Set(groups.filter((g): g is string => Boolean(g)))].sort();
  const results: FeatureStatistic[] = [];
  const skipped: string[] = [];

  for (const className of classes) {
    const inGroup: number[] = [];
    const inRest: number[] = [];
    for (let i = 0; i < n; i += 1) {
      if (groups[i] === className) inGroup.push(i);
      else if (groups[i] !== undefined) inRest.push(i);
    }
    if (inGroup.length < options.minimumGroupSize || inRest.length < options.minimumGroupSize) {
      skipped.push(
        `${className}: ${inGroup.length} observation(s) against ${inRest.length}; below the minimum of ${options.minimumGroupSize} for a test.`,
      );
      continue;
    }

    const pending: FeatureStatistic[] = [];
    for (let j = 0; j < p; j += 1) {
      const groupValues = new Float64Array(inGroup.length);
      const restValues = new Float64Array(inRest.length);
      let groupDetected = 0;
      let restDetected = 0;
      for (let k = 0; k < inGroup.length; k += 1) {
        const value = view.matrix[(inGroup[k] as number) * p + j] as number;
        groupValues[k] = value;
        if (value > 0) groupDetected += 1;
      }
      for (let k = 0; k < inRest.length; k += 1) {
        const value = view.matrix[(inRest[k] as number) * p + j] as number;
        restValues[k] = value;
        if (value > 0) restDetected += 1;
      }

      const detectionInGroup = groupDetected / inGroup.length;
      const detectionInRest = restDetected / inRest.length;
      if (detectionInGroup < options.minimumDetection && detectionInRest < options.minimumDetection) {
        continue; // Undetectable on both sides: nothing to compare.
      }

      const feature = view.features[j] as { id: string; symbol: string; modality: 'transcriptomics' | 'proteomics' };
      if (options.test === 'mann-whitney') {
        const test = mannWhitneyU(groupValues, restValues);
        const groupMean = mean(groupValues);
        const restMean = mean(restValues);
        pending.push({
          featureId: feature.id, symbol: feature.symbol, modality: feature.modality, group: className,
          groupMean, restMean, logDifference: groupMean - restMean,
          statistic: test.statistic, pValue: test.pValue, qValue: Number.NaN,
          // AUC re-expressed as a signed effect: 0.5 means no separation.
          effectSize: (test.auc - 0.5) * 2,
          detectionInGroup, detectionInRest, nGroup: inGroup.length, nRest: inRest.length,
        });
      } else {
        const test = welchTTest(groupValues, restValues);
        pending.push({
          featureId: feature.id, symbol: feature.symbol, modality: feature.modality, group: className,
          groupMean: test.meanA, restMean: test.meanB, logDifference: test.difference,
          statistic: test.statistic, pValue: test.pValue, qValue: Number.NaN,
          effectSize: test.effectSize,
          detectionInGroup, detectionInRest, nGroup: inGroup.length, nRest: inRest.length,
        });
      }
    }

    const adjusted =
      options.correction === 'bonferroni'
        ? bonferroni(pending.map((r) => r.pValue))
        : benjaminiHochberg(pending.map((r) => r.pValue));
    pending.forEach((result, index) => {
      result.qValue = adjusted[index] as number;
    });
    results.push(...pending);
  }

  return {
    results,
    skipped,
    method: {
      id: 'baseline.differential',
      name: 'Differential feature analysis',
      version: '1.0.0',
      software: 'spatial-omics-engine',
      parameters: {
        test: options.test,
        correction: options.correction,
        design: 'one-vs-rest within the annotated groups',
        minimumGroupSize: options.minimumGroupSize,
        minimumDetection: options.minimumDetection,
        correctionScope: 'within each group, not pooled across groups',
      },
      summary:
        `${options.test === 'welch' ? "Welch's unequal-variance t-test" : 'Mann–Whitney U with tie correction'} ` +
        `for each feature in each of ${classes.length} group(s) against all other annotated observations, ` +
        `with ${options.correction === 'bonferroni' ? 'Bonferroni' : 'Benjamini–Hochberg'} correction applied within each group's test family. ` +
        'Values are on the processed scale, so the difference of means is already a log ratio and is labelled as such rather than as a fold change.',
    },
  };
}

// ---------------------------------------------------------------------------
// Pathway activity
// ---------------------------------------------------------------------------

/** A curated gene set with optional signed weights, as decoupler consumes. */
export interface GeneSet {
  id: string;
  name: string;
  source: string;
  /** Feature symbol to weight. A weight of -1 means the pathway represses it. */
  members: Record<string, number>;
}

export interface PathwayActivity {
  pathwayId: string;
  name: string;
  source: string;
  /** Per-observation activity. */
  scores: Float64Array;
  /** Members found in this dataset. */
  found: string[];
  missing: string[];
  /**
   * How strongly the pathway separates the annotated groups.
   *
   * The section *mean* is not reported, and that is the point. The members are
   * z-scored across cells, so the mean of the score over the whole section is
   * zero by construction — the first version of this reported it anyway and
   * every pathway in the table read 0.000, which looks like a bug and is
   * worse: it looks like a finding that nothing is happening.
   *
   * What is informative is whether the set's activity *varies with the tissue*.
   * `separation` is the between-group share of the score's total variance, and
   * the null draws random feature sets of the same size, so a pathway that
   * separates cell types more than an arbitrary set of the same size does is
   * the thing that gets a small q.
   */
  separation: number;
  /** Per-group mean activity, which is what the table shows. */
  byGroup: { group: string; n: number; mean: number; sd: number }[];
  nullZ: number;
  pValue: number;
  qValue: number;
}

export interface PathwayOptions {
  /** Random gene sets drawn to build the null. */
  permutations: number;
  /** Sets with fewer members present than this are reported, not scored. */
  minimumMembers: number;
}

export const DEFAULT_PATHWAY: PathwayOptions = { permutations: 1000, minimumMembers: 3 };

/**
 * Weighted-mean pathway activity with a size-matched permutation null.
 *
 * The weighted mean of z-scored members is decoupler's `wmean`. The addition
 * here is the null: a pathway with 200 members has a mean z with much smaller
 * variance than one with 5, so comparing raw activities between pathways of
 * different sizes ranks large pathways above small ones regardless of biology.
 * Drawing random sets of *the same size* removes that, which is why the ranked
 * table uses the z and not the mean.
 */
export function pathwayActivity(
  view: DatasetView,
  geneSets: GeneSet[],
  options: PathwayOptions,
  rng: Rng,
  groups: (string | undefined)[] = [],
): { results: PathwayActivity[]; method: MethodRecord } {
  const n = view.observations.length;
  const p = view.features.length;
  const index = featureIndexMap(view.features);

  // z-score once; every set reads the same standardised matrix.
  const z = new Float64Array(n * p);
  for (let j = 0; j < p; j += 1) {
    const column = new Float64Array(n);
    for (let i = 0; i < n; i += 1) column[i] = view.matrix[i * p + j] as number;
    const mu = mean(column);
    const sd = standardDeviation(column, mu);
    for (let i = 0; i < n; i += 1) z[i * p + j] = sd > 0 ? ((column[i] as number) - mu) / sd : 0;
  }

  const partial: Omit<PathwayActivity, 'qValue'>[] = [];
  // The null for each size is drawn once and shared by every set of that size —
  // the distribution depends only on the size, and redrawing it per pathway
  // would cost a thousand draws each for an identical answer.
  const nullBySize = new Map<number, Float64Array>();

  const groupNames = [...new Set(groups.filter((g): g is string => Boolean(g)))].sort();
  const groupLookup = new Map(groupNames.map((name, index) => [name, index]));
  const groupIndex = new Int32Array(n).fill(-1);
  groups.forEach((group, index) => {
    if (index < n && group !== undefined) groupIndex[index] = groupLookup.get(group) ?? -1;
  });
  const groupCount = groupNames.length;

  for (const geneSet of geneSets) {
    const found: string[] = [];
    const missing: string[] = [];
    const columns: number[] = [];
    const weights: number[] = [];

    for (const [symbol, weight] of Object.entries(geneSet.members)) {
      const column = index.get(symbol.toUpperCase());
      if (column === undefined) {
        missing.push(symbol);
      } else {
        found.push(symbol);
        columns.push(column);
        weights.push(weight);
      }
    }

    if (columns.length < options.minimumMembers) {
      partial.push({
        pathwayId: geneSet.id, name: geneSet.name, source: geneSet.source,
        scores: new Float64Array(n).fill(Number.NaN), found, missing,
        separation: Number.NaN, byGroup: [], nullZ: Number.NaN, pValue: Number.NaN,
      });
      continue;
    }

    const scores = new Float64Array(n);
    let weightTotal = 0;
    for (const weight of weights) weightTotal += Math.abs(weight);
    for (let i = 0; i < n; i += 1) {
      let total = 0;
      for (let k = 0; k < columns.length; k += 1) {
        total += (weights[k] as number) * (z[i * p + (columns[k] as number)] as number);
      }
      scores[i] = weightTotal > 0 ? total / weightTotal : 0;
    }

    const size = columns.length;
    let nullDistribution = nullBySize.get(size);
    if (!nullDistribution) {
      nullDistribution = new Float64Array(options.permutations);
      for (let iteration = 0; iteration < options.permutations; iteration += 1) {
        const picked = rng.sampleIndices(p, size);
        const random = new Float64Array(n);
        for (let i = 0; i < n; i += 1) {
          let cellTotal = 0;
          for (const column of picked) cellTotal += z[i * p + column] as number;
          random[i] = cellTotal / size;
        }
        nullDistribution[iteration] = groupSeparation(random, groupIndex, groupCount);
      }
      nullBySize.set(size, nullDistribution);
    }

    const separation = groupSeparation(scores, groupIndex, groupCount);
    partial.push({
      pathwayId: geneSet.id, name: geneSet.name, source: geneSet.source,
      scores, found, missing,
      separation,
      byGroup: aggregateByGroup(scores, groups),
      nullZ: empiricalZ(separation, nullDistribution),
      pValue: permutationPValue(separation, nullDistribution, 'greater'),
    });
  }

  const adjusted = benjaminiHochberg(partial.map((r) => r.pValue));
  const results = partial.map((result, i) => ({ ...result, qValue: adjusted[i] as number }));

  return {
    results,
    method: {
      id: 'baseline.pathway-activity',
      name: 'Pathway activity',
      version: '1.0.0',
      software: 'spatial-omics-engine',
      parameters: {
        statistic: 'weighted mean of z-scored members (decoupler wmean)',
        permutations: options.permutations,
        nullModel: 'random feature sets of matched size',
        minimumMembers: options.minimumMembers,
      },
      summary:
        'Each pathway score is the weighted mean of its members’ z-scores, so a signed weight lets a repressed target lower the activity. ' +
        `Significance is against ${options.permutations} random feature sets of the same size, which is what makes activities comparable between a five-gene and a two-hundred-gene pathway.`,
      references: [
        'Badia-i-Mompel P, Vélez Santiago J, Braunger J, et al. decoupleR. Bioinformatics Advances 2022;2:vbac016. doi:10.1093/bioadv/vbac016',
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Cell states
// ---------------------------------------------------------------------------

export interface CellStateScore {
  stateId: string;
  name: string;
  scores: Float64Array;
  /** Observations whose score is the highest of all states. */
  dominantCount: number;
  found: string[];
  missing: string[];
}

/**
 * Signature scores for cell states, with a control set subtracted.
 *
 * The control is the part that matters. A raw signature mean is dominated by
 * how deeply the cell was sequenced, so a high-count cell scores high for
 * everything; subtracting the mean of expression-matched control features is
 * the Tirosh correction, and without it the "proliferative" map is a library
 * size map.
 */
export function cellStateScores(
  view: DatasetView,
  signatures: GeneSet[],
  rng: Rng,
  controlSetSize = 50,
  bins = 25,
): { results: CellStateScore[]; method: MethodRecord } {
  const n = view.observations.length;
  const p = view.features.length;
  const index = featureIndexMap(view.features);

  const featureMeans = new Float64Array(p);
  for (let j = 0; j < p; j += 1) {
    let total = 0;
    for (let i = 0; i < n; i += 1) total += view.matrix[i * p + j] as number;
    featureMeans[j] = n > 0 ? total / n : 0;
  }
  const order = Array.from({ length: p }, (_, j) => j).sort(
    (a, b) => (featureMeans[a] as number) - (featureMeans[b] as number),
  );
  const binOf = new Int32Array(p);
  const perBin = Math.max(1, Math.ceil(p / bins));
  order.forEach((feature, rank) => {
    binOf[feature] = Math.min(bins - 1, Math.floor(rank / perBin));
  });
  const membersOfBin: number[][] = Array.from({ length: bins }, () => [] as number[]);
  for (let j = 0; j < p; j += 1) (membersOfBin[binOf[j] as number] as number[]).push(j);

  const results: CellStateScore[] = [];
  for (const signature of signatures) {
    const found: string[] = [];
    const missing: string[] = [];
    const columns: number[] = [];
    for (const symbol of Object.keys(signature.members)) {
      const column = index.get(symbol.toUpperCase());
      if (column === undefined) missing.push(symbol);
      else {
        found.push(symbol);
        columns.push(column);
      }
    }

    const scores = new Float64Array(n);
    if (columns.length > 0) {
      const controls = new Set<number>();
      for (const column of columns) {
        const pool = membersOfBin[binOf[column] as number] as number[];
        for (let draw = 0; draw < controlSetSize && pool.length > 0; draw += 1) {
          controls.add(pool[rng.int(pool.length)] as number);
        }
      }
      const controlColumns = [...controls].filter((column) => !columns.includes(column));

      for (let i = 0; i < n; i += 1) {
        let signal = 0;
        for (const column of columns) signal += view.matrix[i * p + column] as number;
        let control = 0;
        for (const column of controlColumns) control += view.matrix[i * p + column] as number;
        scores[i] =
          signal / columns.length -
          (controlColumns.length > 0 ? control / controlColumns.length : 0);
      }
    } else {
      scores.fill(Number.NaN);
    }

    results.push({ stateId: signature.id, name: signature.name, scores, dominantCount: 0, found, missing });
  }

  for (let i = 0; i < n; i += 1) {
    let best = -Infinity;
    let bestIndex = -1;
    for (let s = 0; s < results.length; s += 1) {
      const value = (results[s] as CellStateScore).scores[i] as number;
      if (Number.isFinite(value) && value > best) {
        best = value;
        bestIndex = s;
      }
    }
    if (bestIndex >= 0) {
      (results[bestIndex] as CellStateScore).dominantCount += 1;
    }
  }

  return {
    results,
    method: {
      id: 'baseline.cell-states',
      name: 'Cell state signature scoring',
      version: '1.0.0',
      software: 'spatial-omics-engine',
      parameters: { controlSetSize, expressionBins: bins, correction: 'expression-matched control set (Tirosh)' },
      summary:
        `Each signature score is the mean of its members minus the mean of ${controlSetSize} expression-matched control features drawn from the same ` +
        `${bins} expression bins. Without that subtraction the score tracks library size, and the resulting map is of sequencing depth rather than cell state.`,
      references: [
        'Tirosh I, Izar B, Prakadan SM, et al. Dissecting the multicellular ecosystem of metastatic melanoma by single-cell RNA-seq. Science 2016;352:189-196. doi:10.1126/science.aad0501',
      ],
    },
  };
}

/**
 * The between-group share of a score's variance — eta squared.
 *
 * Zero means the score is unrelated to the annotation; one means the groups
 * explain all of it. Unlike a difference of means it does not need a direction
 * chosen in advance, which matters for a pathway that is high in one
 * compartment and low in another.
 */
function groupSeparation(scores: Float64Array, groupIndex: Int32Array, groupCount: number): number {
  if (groupCount < 2) return Number.NaN;
  const sums = new Float64Array(groupCount);
  const counts = new Int32Array(groupCount);
  let total = 0;
  let assigned = 0;

  for (let i = 0; i < scores.length; i += 1) {
    const group = groupIndex[i] as number;
    if (group < 0) continue;
    const value = scores[i] as number;
    if (!Number.isFinite(value)) continue;
    sums[group] = (sums[group] as number) + value;
    counts[group] = (counts[group] as number) + 1;
    total += value;
    assigned += 1;
  }
  if (assigned < 2) return Number.NaN;

  const grandMean = total / assigned;
  let between = 0;
  for (let g = 0; g < groupCount; g += 1) {
    const count = counts[g] as number;
    if (count === 0) continue;
    const difference = (sums[g] as number) / count - grandMean;
    between += count * difference * difference;
  }

  let totalVariance = 0;
  for (let i = 0; i < scores.length; i += 1) {
    if ((groupIndex[i] as number) < 0) continue;
    const value = scores[i] as number;
    if (!Number.isFinite(value)) continue;
    totalVariance += (value - grandMean) * (value - grandMean);
  }
  return totalVariance > 0 ? between / totalVariance : Number.NaN;
}

/** Per-region aggregates, which is how §6.6 wants the tables linked to the map. */
export function aggregateByGroup(
  values: Float64Array,
  groups: (string | undefined)[],
): { group: string; n: number; mean: number; sd: number }[] {
  const byGroup = new Map<string, number[]>();
  groups.forEach((group, index) => {
    if (!group) return;
    const value = values[index] as number;
    if (!Number.isFinite(value)) return;
    const list = byGroup.get(group) ?? [];
    list.push(value);
    byGroup.set(group, list);
  });
  return [...byGroup.entries()]
    .map(([group, list]) => {
      const array = Float64Array.from(list);
      const mu = mean(array);
      return { group, n: array.length, mean: mu, sd: standardDeviation(array, mu) };
    })
    .sort((a, b) => b.mean - a.mean);
}
