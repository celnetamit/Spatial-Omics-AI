/**
 * Preprocessing and harmonisation — §6.4.
 *
 * "Create versioned analysis-ready matrices while preserving the raw input."
 * The preservation is structural: nothing here mutates the `SpatialDataset` it
 * is given. Each step returns a new `DatasetView` carrying the list of
 * transforms that produced it, so the methods panel can show exactly what was
 * applied (§6.4, frontend) without a second record that could disagree.
 *
 * The normalisation is CP10K + log1p for transcriptomics and arcsinh for
 * proteomics, and those are different for a reason rather than for variety:
 * antibody counts are not a sampled library, so scaling them to a common total
 * would remove real differences in abundance, and arcsinh with a cofactor is
 * what the cytometry literature settled on for exactly this.
 */

import { Matrix, pca as computePca, type PcaResult } from '../core/matrix';
import type { Rng } from '../core/rng';
import { median } from '../core/stats';
import type { MethodRecord } from '../core/provenance';
import type { DatasetView, FeatureRecord, SpatialDataset } from '../data/types';
import { featureVector, observationVector } from '../data/types';

export interface PreprocessingParameters {
  /** Drop features detected in fewer than this fraction of observations. */
  minimumDetectionRate: number;
  /** Drop observations with fewer than this many detected features. */
  minimumDetectedFeatures: number;
  /** Target sum for count normalisation. 1e4 is the scanpy convention. */
  targetSum: number;
  /** Cofactor for the proteomic arcsinh. 5 is the CyTOF convention. */
  arcsinhCofactor: number;
  /** Number of highly variable features to keep, or 0 to keep all. */
  highlyVariableFeatures: number;
  /** Principal components to compute. */
  components: number;
  /** Scale features to unit variance before PCA. */
  scale: boolean;
  /** Clip z-scores at this absolute value when scaling. */
  scaleClip: number;
}

export const DEFAULT_PREPROCESSING: PreprocessingParameters = {
  minimumDetectionRate: 0.01,
  minimumDetectedFeatures: 5,
  targetSum: 1e4,
  arcsinhCofactor: 5,
  highlyVariableFeatures: 0,
  components: 20,
  scale: true,
  scaleClip: 10,
};

export interface PreprocessingRun {
  view: DatasetView;
  /** Principal components of the processed matrix, for neighbourhoods and OOD. */
  embedding: PcaResult | null;
  /** Observations kept, as indices into the source dataset. */
  keptObservations: Int32Array;
  /** Features kept, as indices into the source dataset. */
  keptFeatures: Int32Array;
  /** Per-observation size factor, kept so the transform can be reversed. */
  sizeFactors: Float64Array;
  methods: MethodRecord[];
  warnings: string[];
  parameters: PreprocessingParameters;
}

export function preprocess(
  dataset: SpatialDataset,
  parameters: PreprocessingParameters,
  rng: Rng,
): PreprocessingRun {
  const warnings: string[] = [];
  const methods: MethodRecord[] = [];
  const n = dataset.observations.length;
  const p = dataset.features.length;

  // -- feature filtering ---------------------------------------------------

  const detectionRate = new Float64Array(p);
  for (let j = 0; j < p; j += 1) {
    const column = featureVector(dataset, j);
    let detected = 0;
    for (let i = 0; i < n; i += 1) if ((column[i] as number) > 0) detected += 1;
    detectionRate[j] = n > 0 ? detected / n : 0;
  }

  const keptFeatureList: number[] = [];
  for (let j = 0; j < p; j += 1) {
    if ((detectionRate[j] as number) >= parameters.minimumDetectionRate) keptFeatureList.push(j);
  }
  if (keptFeatureList.length === 0) {
    warnings.push(
      `No feature reached the minimum detection rate of ${(parameters.minimumDetectionRate * 100).toFixed(1)}%; the filter was skipped so the run has something to analyse.`,
    );
    for (let j = 0; j < p; j += 1) keptFeatureList.push(j);
  }

  // -- observation filtering -----------------------------------------------

  const keptObservationList: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const vector = observationVector(dataset, i);
    let detected = 0;
    for (const j of keptFeatureList) if ((vector[j] as number) > 0) detected += 1;
    if (detected >= parameters.minimumDetectedFeatures) keptObservationList.push(i);
  }
  if (keptObservationList.length === 0) {
    warnings.push(
      `No observation reached ${parameters.minimumDetectedFeatures} detected features; the filter was skipped.`,
    );
    for (let i = 0; i < n; i += 1) keptObservationList.push(i);
  }
  const dropped = n - keptObservationList.length;
  if (dropped > 0) {
    warnings.push(
      `${dropped} observation(s) were filtered out for having fewer than ${parameters.minimumDetectedFeatures} detected features.`,
    );
  }

  methods.push({
    id: 'preprocess.filter',
    name: 'Feature and observation filtering',
    version: '1.0.0',
    software: 'spatial-omics-engine',
    parameters: {
      minimumDetectionRate: parameters.minimumDetectionRate,
      minimumDetectedFeatures: parameters.minimumDetectedFeatures,
    },
    summary:
      `Kept ${keptFeatureList.length} of ${p} features detected in at least ` +
      `${(parameters.minimumDetectionRate * 100).toFixed(1)}% of observations, and ` +
      `${keptObservationList.length} of ${n} observations with at least ` +
      `${parameters.minimumDetectedFeatures} detected features.`,
  });

  // -- normalisation --------------------------------------------------------

  const keptFeatures = Int32Array.from(keptFeatureList);
  const keptObservations = Int32Array.from(keptObservationList);
  const width = keptFeatures.length;
  const height = keptObservations.length;

  const features: FeatureRecord[] = keptFeatureList.map((j) => dataset.features[j] as FeatureRecord);
  const rnaColumns: number[] = [];
  const proteinColumns: number[] = [];
  features.forEach((feature, index) => {
    if (feature.modality === 'proteomics') proteinColumns.push(index);
    else rnaColumns.push(index);
  });

  const matrix = new Float64Array(height * width);
  const sizeFactors = new Float64Array(height);
  const alreadyNormalised = dataset.metadata.preprocessingStatus !== 'raw-counts';

  for (let row = 0; row < height; row += 1) {
    const source = observationVector(dataset, keptObservations[row] as number);
    let rnaTotal = 0;
    for (const column of rnaColumns) rnaTotal += source[keptFeatures[column] as number] as number;
    const factor = rnaTotal > 0 ? rnaTotal / parameters.targetSum : 1;
    sizeFactors[row] = factor;

    for (let column = 0; column < width; column += 1) {
      const raw = source[keptFeatures[column] as number] as number;
      const feature = features[column] as FeatureRecord;
      if (feature.modality === 'proteomics') {
        matrix[row * width + column] = Math.asinh(raw / parameters.arcsinhCofactor);
      } else if (alreadyNormalised) {
        // The values already carry a transform we did not apply; log1p on top
        // of a log would be silently wrong, so the values pass through.
        matrix[row * width + column] = raw;
      } else {
        matrix[row * width + column] = Math.log1p(raw / factor);
      }
    }
  }

  if (alreadyNormalised && rnaColumns.length > 0) {
    warnings.push(
      `The dataset declares preprocessing status "${dataset.metadata.preprocessingStatus}", so transcriptomic values were used as supplied rather than normalised again.`,
    );
  }

  const scaleLabel: DatasetView['scale'] = alreadyNormalised
    ? 'other'
    : proteinColumns.length > 0 && rnaColumns.length === 0
      ? 'arcsinh'
      : 'log1p-cp10k';

  methods.push({
    id: 'preprocess.normalise',
    name: 'Normalisation',
    version: '1.0.0',
    software: 'spatial-omics-engine',
    parameters: {
      targetSum: parameters.targetSum,
      arcsinhCofactor: parameters.arcsinhCofactor,
      transcriptomicsTransform: alreadyNormalised ? 'none (supplied pre-normalised)' : 'log1p(count / size factor)',
      proteomicsTransform: 'arcsinh(value / cofactor)',
    },
    summary: alreadyNormalised
      ? 'Transcriptomic values were supplied already normalised and were not transformed again. Proteomic markers were arcsinh transformed.'
      : `Transcriptomic counts were scaled to a common total of ${parameters.targetSum.toExponential(0)} and log1p transformed; proteomic markers were arcsinh transformed with cofactor ${parameters.arcsinhCofactor}.`,
    references: [
      'Wolf FA, Angerer P, Theis FJ. SCANPY. Genome Biology 2018;19:15. doi:10.1186/s13059-017-1382-0',
    ],
  });

  // -- highly variable features --------------------------------------------

  let finalFeatures = features;
  let finalMatrix = matrix;
  let finalWidth = width;
  let finalKeptFeatures = keptFeatures;
  let featureSubset = keptFeatures.length < p;

  if (parameters.highlyVariableFeatures > 0 && parameters.highlyVariableFeatures < width) {
    const dispersion = normalisedDispersion(matrix, height, width);
    const order = Array.from({ length: width }, (_, i) => i).sort(
      (a, b) => (dispersion[b] as number) - (dispersion[a] as number),
    );
    const selected = order.slice(0, parameters.highlyVariableFeatures).sort((a, b) => a - b);

    const reduced = new Float64Array(height * selected.length);
    for (let row = 0; row < height; row += 1) {
      for (let column = 0; column < selected.length; column += 1) {
        reduced[row * selected.length + column] = matrix[row * width + (selected[column] as number)] as number;
      }
    }
    finalFeatures = selected.map((index) => features[index] as FeatureRecord);
    finalMatrix = reduced;
    finalWidth = selected.length;
    finalKeptFeatures = Int32Array.from(selected.map((index) => keptFeatures[index] as number));
    featureSubset = true;

    methods.push({
      id: 'preprocess.highly-variable',
      name: 'Highly variable feature selection',
      version: '1.0.0',
      software: 'spatial-omics-engine',
      parameters: { count: parameters.highlyVariableFeatures, statistic: 'mean-binned normalised dispersion' },
      summary:
        `Kept the ${selected.length} features with the highest dispersion relative to other features of similar mean expression.`,
    });
  }

  // -- embedding -----------------------------------------------------------

  let embedding: PcaResult | null = null;
  if (height >= 3 && finalWidth >= 2) {
    const forPca = new Matrix(height, finalWidth, Float64Array.from(finalMatrix));
    if (parameters.scale) {
      scaleColumns(forPca, parameters.scaleClip);
    }
    const componentCount = Math.min(parameters.components, Math.min(height - 1, finalWidth));
    embedding = computePca(forPca, componentCount, rng);

    methods.push({
      id: 'preprocess.pca',
      name: 'Principal component analysis',
      version: '1.0.0',
      software: 'spatial-omics-engine',
      parameters: {
        components: componentCount,
        scaled: parameters.scale,
        scaleClip: parameters.scaleClip,
        solver: 'randomised block power iteration, 7 iterations, 10 oversampled columns',
      },
      summary:
        `${componentCount} components explain ` +
        `${(sumOf(embedding.explainedVarianceRatio) * 100).toFixed(1)}% of the variance in the processed matrix.`,
    });
  } else {
    warnings.push('Too few observations or features for a principal component analysis; the embedding was skipped.');
  }

  const view: DatasetView = {
    datasetId: dataset.metadata.datasetId,
    sourceRevision: dataset.revision,
    viewId: `${dataset.revision}/preprocessed`,
    transforms: methods.map((m) => m.id),
    observations: keptObservationList.map((i) => dataset.observations[i] as never),
    features: finalFeatures,
    matrix: finalMatrix,
    featureSubset,
    scale: scaleLabel,
  };

  return {
    view,
    embedding,
    keptObservations,
    keptFeatures: finalKeptFeatures,
    sizeFactors,
    methods,
    warnings,
    parameters,
  };
}

/**
 * Seurat-style normalised dispersion.
 *
 * Variance alone would select whatever is most abundant. Binning by mean and
 * z-scoring the dispersion within each bin is what makes a moderately expressed
 * but genuinely variable marker competitive with a highly expressed housekeeper.
 */
function normalisedDispersion(matrix: Float64Array, rows: number, cols: number): Float64Array {
  const means = new Float64Array(cols);
  const dispersions = new Float64Array(cols);

  for (let j = 0; j < cols; j += 1) {
    let total = 0;
    for (let i = 0; i < rows; i += 1) total += matrix[i * cols + j] as number;
    const mu = total / rows;
    let ss = 0;
    for (let i = 0; i < rows; i += 1) {
      const d = (matrix[i * cols + j] as number) - mu;
      ss += d * d;
    }
    const variance = rows > 1 ? ss / (rows - 1) : 0;
    means[j] = mu;
    dispersions[j] = mu > 0 ? variance / mu : 0;
  }

  const binCount = Math.min(20, Math.max(1, Math.floor(cols / 10)));
  const order = Array.from({ length: cols }, (_, i) => i).sort(
    (a, b) => (means[a] as number) - (means[b] as number),
  );
  const out = new Float64Array(cols);
  const perBin = Math.ceil(cols / binCount);

  for (let bin = 0; bin < binCount; bin += 1) {
    const members = order.slice(bin * perBin, (bin + 1) * perBin);
    if (members.length === 0) continue;
    const values = members.map((index) => dispersions[index] as number);
    const centre = median(Float64Array.from(values));
    let spread = 0;
    for (const value of values) spread += Math.abs(value - centre);
    spread = members.length > 0 ? spread / members.length : 0;
    for (const index of members) {
      out[index] = spread > 0 ? ((dispersions[index] as number) - centre) / spread : 0;
    }
  }
  return out;
}

/** z-scores columns in place, clipped, leaving constant columns at zero. */
function scaleColumns(matrix: Matrix, clip: number): void {
  for (let j = 0; j < matrix.cols; j += 1) {
    let total = 0;
    for (let i = 0; i < matrix.rows; i += 1) total += matrix.get(i, j);
    const mu = total / matrix.rows;
    let ss = 0;
    for (let i = 0; i < matrix.rows; i += 1) {
      const d = matrix.get(i, j) - mu;
      ss += d * d;
    }
    const sd = matrix.rows > 1 ? Math.sqrt(ss / (matrix.rows - 1)) : 0;
    for (let i = 0; i < matrix.rows; i += 1) {
      const value = sd > 0 ? (matrix.get(i, j) - mu) / sd : 0;
      matrix.set(i, j, Math.max(-clip, Math.min(clip, value)));
    }
  }
}

function sumOf(values: ArrayLike<number>): number {
  let total = 0;
  for (let i = 0; i < values.length; i += 1) total += values[i] as number;
  return total;
}
