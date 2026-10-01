/**
 * The canonical spatial-omics object — §6.2's "AnnData/SpatialData-backed
 * object without losing coordinates, metadata or provenance".
 *
 * Deliberately not a copy of AnnData. What the pipeline needs is an expression
 * or abundance matrix, coordinates in a stated unit, per-observation metadata,
 * per-feature identity, and enough provenance to say where each of those came
 * from. Modelling `uns`, `layers`, `obsp` and the rest would be a data-format
 * exercise; every field below is read by something downstream.
 *
 * Two things are invariants rather than conventions:
 *
 * The raw matrix is never overwritten (§6.2). `raw` holds what was ingested,
 * and a `DatasetView` produced by preprocessing points back at it.
 *
 * Coordinates carry their unit. Spatial radius parameters are quoted in µm and
 * a matrix in pixels would silently reinterpret every neighbourhood in the run
 * — §5.2 says there is no universal fixed radius precisely because of this.
 */

export type Modality = 'transcriptomics' | 'proteomics' | 'combined';

export type ResolutionKind = 'spot' | 'cell' | 'subcellular';

export type CoordinateUnit = 'um' | 'mm' | 'pixel' | 'arbitrary';

export type PreprocessingStatus = 'raw-counts' | 'normalised' | 'transformed' | 'unknown';

/** §4.2 — everything a dataset must declare before it can be analysed. */
export interface DatasetMetadata {
  datasetId: string;
  sampleId: string;
  organism: string;
  /** Genome build, where the feature namespace depends on one. */
  genomeBuild: string | null;
  tissue: string;
  condition: string;
  assay: string;
  platform: string;
  resolution: ResolutionKind;
  coordinateUnit: CoordinateUnit;
  coordinateSystem: string;
  /** e.g. `HGNC`, `ENSEMBL`, `UNIPROT`. */
  featureNamespace: string;
  preprocessingStatus: PreprocessingStatus;
  /** Present when the dataset has donor or batch structure. */
  donorId: string | null;
  batchId: string | null;
  replicate: string | null;
  /** Licence and access status — mandatory for bundled demonstration data. */
  licence: string;
  accessStatus: 'bundled-demonstration' | 'user-upload' | 'restricted';
  /** How the data came to exist, in one honest sentence. */
  origin: string;
  imageAlignment: ImageAlignment | null;
}

export interface ImageAlignment {
  imageUri: string;
  /** Affine, row-major [a, b, c, d, e, f] mapping image px to dataset coords. */
  transform: [number, number, number, number, number, number];
  pixelSize: number;
  pixelUnit: CoordinateUnit;
  pyramidLevels: number;
}

/** One measured feature: a gene, a protein or a panel marker. */
export interface FeatureRecord {
  /** Stable identifier in `namespace`. */
  id: string;
  /** Display symbol. */
  symbol: string;
  namespace: string;
  /** Which matrix this feature lives in when the dataset is combined. */
  modality: 'transcriptomics' | 'proteomics';
  species: string;
  /** UniProt accession where known, so protein and RNA can be cross-linked. */
  uniprot?: string;
}

/** One observation: a cell, or a spot containing several. */
export interface ObservationRecord {
  id: string;
  x: number;
  y: number;
  /** Present only when the source data is three-dimensional. */
  z?: number;
  sampleId: string;
  /** Provided annotation, where the source carried one. */
  cellType?: string;
  cellState?: string;
  region?: string;
  batch?: string;
  donor?: string;
  /** Spot deconvolution weights, when the resolution is `spot`. */
  composition?: Record<string, number>;
}

/**
 * The ingested dataset, as close to what arrived as canonicalisation allows.
 *
 * `matrix` is observations x features, row-major, and `features` indexes its
 * columns. Both modalities share one matrix with a per-feature `modality` tag
 * rather than living in two: a combined dataset is analysed jointly far more
 * often than separately, and keeping two matrices in step through filtering was
 * where the first version of this lost four proteins.
 */
export interface SpatialDataset {
  metadata: DatasetMetadata;
  observations: ObservationRecord[];
  features: FeatureRecord[];
  /** observations x features, row-major. */
  matrix: Float64Array;
  /** SHA-256 of the canonical serialisation, computed at ingestion. */
  checksum: string;
  /** Monotonic revision, incremented whenever a new canonical object is made. */
  revision: string;
  /** What the ingester did, in enough detail to repeat it. */
  ingestion: IngestionReport;
}

export interface IngestionReport {
  sourceFormat: string;
  sourceFiles: { name: string; bytes: number; sha256: string }[];
  observationCount: number;
  featureCount: number;
  /** Non-fatal things the ingester had to decide. */
  notes: string[];
  /** Identifiers that could not be mapped to the declared namespace. */
  unmappedFeatures: string[];
  droppedObservations: { id: string; reason: string }[];
  ingestedAt: string;
}

/**
 * An analysis-ready view: the same observations and features, a transformed
 * matrix, and a pointer back at what it came from.
 *
 * Kept separate from `SpatialDataset` so nothing downstream can mistake a
 * log-normalised value for a count — the two have different units and the
 * difference has to survive being passed around.
 */
export interface DatasetView {
  datasetId: string;
  sourceRevision: string;
  viewId: string;
  /** What produced this view, in order. */
  transforms: string[];
  observations: ObservationRecord[];
  features: FeatureRecord[];
  matrix: Float64Array;
  /** Set when the view holds a subset of the source's features. */
  featureSubset: boolean;
  scale: 'counts' | 'cp10k' | 'log1p-cp10k' | 'z-score' | 'arcsinh' | 'other';
}

export function observationCount(dataset: SpatialDataset | DatasetView): number {
  return dataset.observations.length;
}

export function featureCount(dataset: SpatialDataset | DatasetView): number {
  return dataset.features.length;
}

/** A live view of one observation's feature vector. */
export function observationVector(
  dataset: SpatialDataset | DatasetView,
  index: number,
): Float64Array {
  const width = dataset.features.length;
  return dataset.matrix.subarray(index * width, (index + 1) * width);
}

/** A copy of one feature's values across all observations. */
export function featureVector(
  dataset: SpatialDataset | DatasetView,
  featureIndex: number,
): Float64Array {
  const width = dataset.features.length;
  const n = dataset.observations.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 1) out[i] = dataset.matrix[i * width + featureIndex] as number;
  return out;
}

/** Feature index by id or symbol, case-insensitively, ids winning. */
export function featureIndexMap(features: FeatureRecord[]): Map<string, number> {
  const map = new Map<string, number>();
  features.forEach((feature, index) => {
    map.set(feature.symbol.toUpperCase(), index);
    if (feature.uniprot) map.set(feature.uniprot.toUpperCase(), index);
  });
  // Ids last so an id always wins a collision with someone else's symbol.
  features.forEach((feature, index) => map.set(feature.id.toUpperCase(), index));
  return map;
}

export function observationIndexMap(observations: ObservationRecord[]): Map<string, number> {
  const map = new Map<string, number>();
  observations.forEach((observation, index) => map.set(observation.id, index));
  return map;
}

/** Bounding box of the coordinates, in the dataset's own unit. */
export function coordinateBounds(observations: ObservationRecord[]): {
  minX: number; maxX: number; minY: number; maxY: number; width: number; height: number;
} {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const observation of observations) {
    if (observation.x < minX) minX = observation.x;
    if (observation.x > maxX) maxX = observation.x;
    if (observation.y < minY) minY = observation.y;
    if (observation.y > maxY) maxY = observation.y;
  }
  if (!Number.isFinite(minX)) {
    return { minX: 0, maxX: 0, minY: 0, maxY: 0, width: 0, height: 0 };
  }
  return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
}
