/**
 * Ingestion and canonicalisation — §6.2.
 *
 * Heterogeneous input becomes one canonical object, or it is refused with a
 * reason a person can act on. The refusal path matters as much as the success
 * path: §4.3 distinguishes "requires metadata" from "unsupported input" because
 * one is a missing field and the other is a conversion job, and telling a
 * researcher "invalid file" for either wastes an afternoon.
 *
 * What is accepted here is tabular: a matrix with observation ids down one axis
 * and feature ids along the other, plus a coordinate table. H5AD and Zarr are
 * *not* read by this build — see `unsupportedFormatGuidance` below, which emits
 * the conversion snippet §4.3 asks for rather than pretending.
 */

import { sha256, contentHash } from '../core/provenance';
import type {
  CoordinateUnit, DatasetMetadata, FeatureRecord, IngestionReport, Modality,
  ObservationRecord, SpatialDataset,
} from './types';

export interface SourceFile {
  name: string;
  /** Decoded text. Binary formats are refused before they reach here. */
  text: string;
  bytes: number;
}

export interface IngestOptions {
  metadata: DatasetMetadata;
  /** Observations are rows of the matrix file. When false, features are rows. */
  observationsAreRows?: boolean;
  /** Which modality an unlabelled feature belongs to. */
  defaultModality?: 'transcriptomics' | 'proteomics';
  /** Per-feature modality, when a combined dataset declares it. */
  featureModalities?: Record<string, 'transcriptomics' | 'proteomics'>;
}

export type IngestOutcome =
  | { ok: true; dataset: SpatialDataset; warnings: string[] }
  | { ok: false; code: IngestErrorCode; message: string; guidance: string[] };

export type IngestErrorCode =
  | 'UNSUPPORTED_INPUT'
  | 'MISSING_METADATA'
  | 'EMPTY_MATRIX'
  | 'DUPLICATE_OBSERVATION_ID'
  | 'DUPLICATE_FEATURE_ID'
  | 'MISSING_COORDINATES'
  | 'COORDINATE_MISMATCH'
  | 'MALFORMED_TABLE'
  | 'NON_NUMERIC_VALUE';

// ---------------------------------------------------------------------------
// Delimited tables
// ---------------------------------------------------------------------------

export interface Table {
  header: string[];
  rows: string[][];
}

/**
 * A delimited-table reader that handles the quoting real exports produce.
 *
 * Splitting on the delimiter would be shorter and would corrupt any file whose
 * cell type is written `T cell, CD8+` — which is most of them, because that is
 * how the ontologies write it.
 */
export function parseTable(text: string, delimiter?: string): Table {
  const content = text.replace(/^﻿/, '');
  const chosen = delimiter ?? detectDelimiter(content);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < content.length; i += 1) {
    const char = content[i] as string;
    if (inQuotes) {
      if (char === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && field.length === 0) {
      inQuotes = true;
    } else if (char === chosen) {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // Trailing blank lines are common and are not a ragged table.
  while (rows.length > 0 && (rows[rows.length - 1] as string[]).every((cell) => cell.trim() === '')) {
    rows.pop();
  }

  const header = (rows.shift() ?? []).map((cell) => cell.trim());
  return { header, rows };
}

export function detectDelimiter(text: string): string {
  const firstLine = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'));
  const counts: Record<string, number> = {
    ',': (firstLine.match(/,/g) ?? []).length,
    '\t': (firstLine.match(/\t/g) ?? []).length,
    ';': (firstLine.match(/;/g) ?? []).length,
  };
  let best = ',';
  for (const [delimiter, count] of Object.entries(counts)) {
    if (count > (counts[best] as number)) best = delimiter;
  }
  return best;
}

/** Column lookup that tolerates the spellings coordinate tables actually use. */
function findColumn(header: string[], candidates: string[]): number {
  const normalised = header.map((name) => name.trim().toLowerCase().replace(/[^a-z0-9]/g, ''));
  for (const candidate of candidates) {
    const target = candidate.toLowerCase().replace(/[^a-z0-9]/g, '');
    const index = normalised.indexOf(target);
    if (index >= 0) return index;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

export interface TabularSources {
  /** Matrix with an id column and feature columns (or the transpose). */
  matrix: SourceFile;
  /** observation_id, x, y[, z]. */
  coordinates: SourceFile;
  /** Optional per-observation annotation. */
  observationMetadata?: SourceFile;
  /** Optional per-feature identity. */
  featureMetadata?: SourceFile;
}

export function ingestTabular(sources: TabularSources, options: IngestOptions): IngestOutcome {
  const missing = missingMetadataFields(options.metadata);
  if (missing.length > 0) {
    return {
      ok: false,
      code: 'MISSING_METADATA',
      message: `The dataset is readable but ${missing.length} required field(s) are not declared.`,
      guidance: missing.map((field) => `Supply ${field}.`),
    };
  }

  const matrixTable = parseTable(sources.matrix.text);
  if (matrixTable.header.length < 2 || matrixTable.rows.length === 0) {
    return {
      ok: false,
      code: 'EMPTY_MATRIX',
      message: 'The expression matrix has no data rows, or only one column.',
      guidance: [
        'The first column should hold observation identifiers and every other column a feature.',
        'If your file is features-in-rows, set observationsAreRows to false.',
      ],
    };
  }

  const observationsAreRows = options.observationsAreRows ?? true;
  const ids: string[] = [];
  const featureIds: string[] = [];
  let values: Float64Array;

  if (observationsAreRows) {
    featureIds.push(...matrixTable.header.slice(1).map((name) => name.trim()));
    const width = featureIds.length;
    values = new Float64Array(matrixTable.rows.length * width);
    for (let i = 0; i < matrixTable.rows.length; i += 1) {
      const row = matrixTable.rows[i] as string[];
      if (row.length !== width + 1) {
        return {
          ok: false,
          code: 'MALFORMED_TABLE',
          message: `Row ${i + 2} of ${sources.matrix.name} has ${row.length} cells; the header declares ${width + 1}.`,
          guidance: ['Every row must have one cell per header column.'],
        };
      }
      ids.push((row[0] as string).trim());
      for (let j = 0; j < width; j += 1) {
        const parsed = Number.parseFloat(row[j + 1] as string);
        if (!Number.isFinite(parsed)) {
          return {
            ok: false,
            code: 'NON_NUMERIC_VALUE',
            message: `Row ${i + 2}, column "${featureIds[j]}" of ${sources.matrix.name} is not a number: "${row[j + 1]}".`,
            guidance: [
              'Expression and abundance values must be numeric.',
              'Missing values should be written as 0 for counts, or the column removed.',
            ],
          };
        }
        values[i * width + j] = parsed;
      }
    }
  } else {
    ids.push(...matrixTable.header.slice(1).map((name) => name.trim()));
    const width = ids.length;
    const rowCount = matrixTable.rows.length;
    values = new Float64Array(width * rowCount);
    for (let f = 0; f < rowCount; f += 1) {
      const row = matrixTable.rows[f] as string[];
      if (row.length !== width + 1) {
        return {
          ok: false,
          code: 'MALFORMED_TABLE',
          message: `Row ${f + 2} of ${sources.matrix.name} has ${row.length} cells; the header declares ${width + 1}.`,
          guidance: ['Every row must have one cell per header column.'],
        };
      }
      featureIds.push((row[0] as string).trim());
      for (let i = 0; i < width; i += 1) {
        const parsed = Number.parseFloat(row[i + 1] as string);
        if (!Number.isFinite(parsed)) {
          return {
            ok: false,
            code: 'NON_NUMERIC_VALUE',
            message: `Row ${f + 2}, column "${ids[i]}" of ${sources.matrix.name} is not a number: "${row[i + 1]}".`,
            guidance: ['Expression and abundance values must be numeric.'],
          };
        }
        values[i * rowCount + f] = parsed;
      }
    }
  }

  const duplicateObservation = firstDuplicate(ids);
  if (duplicateObservation) {
    return {
      ok: false,
      code: 'DUPLICATE_OBSERVATION_ID',
      message: `Observation id "${duplicateObservation}" appears more than once.`,
      guidance: [
        'Appendix B requires unique observation identifiers.',
        'Two cells with the same id cannot be told apart in a spatial graph, and the coordinate join would pick one arbitrarily.',
      ],
    };
  }
  const duplicateFeature = firstDuplicate(featureIds);
  if (duplicateFeature) {
    return {
      ok: false,
      code: 'DUPLICATE_FEATURE_ID',
      message: `Feature id "${duplicateFeature}" appears more than once.`,
      guidance: ['Collapse duplicated features before upload, or rename them so the two are distinguishable.'],
    };
  }

  // -- coordinates ---------------------------------------------------------

  const coordinateTable = parseTable(sources.coordinates.text);
  const idColumn = findColumn(coordinateTable.header, [
    'observation_id', 'observationid', 'cell_id', 'cellid', 'spot_id', 'spotid', 'barcode', 'id',
  ]);
  const xColumn = findColumn(coordinateTable.header, ['x', 'x_coord', 'xcoord', 'pxl_col_in_fullres', 'imagecol']);
  const yColumn = findColumn(coordinateTable.header, ['y', 'y_coord', 'ycoord', 'pxl_row_in_fullres', 'imagerow']);
  const zColumn = findColumn(coordinateTable.header, ['z', 'z_coord', 'zcoord']);

  if (idColumn < 0 || xColumn < 0 || yColumn < 0) {
    return {
      ok: false,
      code: 'MISSING_COORDINATES',
      message: `${sources.coordinates.name} needs an identifier column and both x and y.`,
      guidance: [
        `Columns found: ${coordinateTable.header.join(', ') || '(none)'}.`,
        'Name them observation_id, x and y (z is optional).',
      ],
    };
  }

  const coordinates = new Map<string, { x: number; y: number; z?: number }>();
  for (const row of coordinateTable.rows) {
    const id = (row[idColumn] ?? '').trim();
    if (!id) continue;
    const x = Number.parseFloat(row[xColumn] ?? '');
    const y = Number.parseFloat(row[yColumn] ?? '');
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return {
        ok: false,
        code: 'COORDINATE_MISMATCH',
        message: `Observation "${id}" has a non-numeric coordinate.`,
        guidance: ['Every observation needs a finite x and y in the declared coordinate unit.'],
      };
    }
    const z = zColumn >= 0 ? Number.parseFloat(row[zColumn] ?? '') : Number.NaN;
    coordinates.set(id, Number.isFinite(z) ? { x, y, z } : { x, y });
  }

  const withoutCoordinates = ids.filter((id) => !coordinates.has(id));
  if (withoutCoordinates.length > 0) {
    return {
      ok: false,
      code: 'COORDINATE_MISMATCH',
      message:
        `${withoutCoordinates.length} observation(s) in the matrix have no coordinate, ` +
        `starting with "${withoutCoordinates[0]}".`,
      guidance: [
        'Spatial analysis has no fallback for a cell with no position — it would have to be dropped or placed arbitrarily, and both change the neighbourhood graph.',
        withoutCoordinates.length <= 5
          ? `Missing: ${withoutCoordinates.join(', ')}.`
          : `Missing ${withoutCoordinates.length}, first five: ${withoutCoordinates.slice(0, 5).join(', ')}.`,
      ],
    };
  }

  // -- optional annotation -------------------------------------------------

  const warnings: string[] = [];
  const annotation = new Map<string, Record<string, string>>();
  if (sources.observationMetadata) {
    const table = parseTable(sources.observationMetadata.text);
    const column = findColumn(table.header, [
      'observation_id', 'observationid', 'cell_id', 'cellid', 'spot_id', 'barcode', 'id',
    ]);
    if (column < 0) {
      warnings.push(
        `${sources.observationMetadata.name} has no identifier column, so its annotations were not joined.`,
      );
    } else {
      for (const row of table.rows) {
        const id = (row[column] ?? '').trim();
        if (!id) continue;
        const record: Record<string, string> = {};
        table.header.forEach((name, index) => {
          if (index !== column) record[name.trim().toLowerCase()] = (row[index] ?? '').trim();
        });
        annotation.set(id, record);
      }
      const unjoined = [...annotation.keys()].filter((id) => !coordinates.has(id)).length;
      if (unjoined > 0) {
        warnings.push(
          `${unjoined} row(s) of ${sources.observationMetadata.name} refer to observations that are not in the matrix, and were ignored.`,
        );
      }
    }
  }

  const featureAnnotation = new Map<string, Record<string, string>>();
  if (sources.featureMetadata) {
    const table = parseTable(sources.featureMetadata.text);
    const column = findColumn(table.header, ['feature_id', 'featureid', 'gene_id', 'geneid', 'protein_id', 'id', 'symbol']);
    if (column < 0) {
      warnings.push(`${sources.featureMetadata.name} has no identifier column, so feature metadata was not joined.`);
    } else {
      for (const row of table.rows) {
        const id = (row[column] ?? '').trim();
        if (!id) continue;
        const record: Record<string, string> = {};
        table.header.forEach((name, index) => {
          record[name.trim().toLowerCase()] = (row[index] ?? '').trim();
        });
        featureAnnotation.set(id, record);
      }
    }
  }

  // -- assemble ------------------------------------------------------------

  const observations: ObservationRecord[] = ids.map((id) => {
    const position = coordinates.get(id) as { x: number; y: number; z?: number };
    const extra = annotation.get(id) ?? {};
    const record: ObservationRecord = {
      id,
      x: position.x,
      y: position.y,
      sampleId: extra.sample_id || extra.sampleid || options.metadata.sampleId,
    };
    if (position.z !== undefined) record.z = position.z;
    const cellType = extra.cell_type || extra.celltype;
    if (cellType) record.cellType = cellType;
    const cellState = extra.cell_state || extra.cellstate;
    if (cellState) record.cellState = cellState;
    if (extra.region) record.region = extra.region;
    if (extra.batch) record.batch = extra.batch;
    const donor = extra.donor || extra.donor_id;
    if (donor) record.donor = donor;
    return record;
  });

  const defaultModality: 'transcriptomics' | 'proteomics' =
    options.defaultModality ?? (options.metadata.assay.toLowerCase().includes('protein') ? 'proteomics' : 'transcriptomics');

  const features: FeatureRecord[] = featureIds.map((id) => {
    const extra = featureAnnotation.get(id) ?? {};
    const declared = options.featureModalities?.[id];
    const fromTable = extra.modality === 'proteomics' || extra.modality === 'transcriptomics' ? extra.modality : undefined;
    const record: FeatureRecord = {
      id,
      symbol: extra.symbol || id,
      namespace: extra.namespace || options.metadata.featureNamespace,
      modality: declared ?? fromTable ?? defaultModality,
      species: extra.species || options.metadata.organism,
    };
    if (extra.uniprot) record.uniprot = extra.uniprot;
    return record;
  });

  const ingestion: IngestionReport = {
    sourceFormat: 'delimited-table',
    sourceFiles: [
      { name: sources.matrix.name, bytes: sources.matrix.bytes, sha256: sha256(sources.matrix.text) },
      { name: sources.coordinates.name, bytes: sources.coordinates.bytes, sha256: sha256(sources.coordinates.text) },
      ...(sources.observationMetadata
        ? [{
            name: sources.observationMetadata.name,
            bytes: sources.observationMetadata.bytes,
            sha256: sha256(sources.observationMetadata.text),
          }]
        : []),
      ...(sources.featureMetadata
        ? [{
            name: sources.featureMetadata.name,
            bytes: sources.featureMetadata.bytes,
            sha256: sha256(sources.featureMetadata.text),
          }]
        : []),
    ],
    observationCount: observations.length,
    featureCount: features.length,
    notes: [
      observationsAreRows
        ? 'Matrix read with observations in rows.'
        : 'Matrix read with features in rows and transposed.',
      `Coordinates joined on identifier; unit declared as ${options.metadata.coordinateUnit}.`,
    ],
    unmappedFeatures: [],
    droppedObservations: [],
    ingestedAt: new Date().toISOString(),
  };

  const dataset = finaliseDataset({
    metadata: options.metadata,
    observations,
    features,
    matrix: values,
    ingestion,
  });

  return { ok: true, dataset, warnings };
}

/** Computes the checksum and revision, so no caller has to remember to. */
export function finaliseDataset(parts: {
  metadata: DatasetMetadata;
  observations: ObservationRecord[];
  features: FeatureRecord[];
  matrix: Float64Array;
  ingestion: IngestionReport;
}): SpatialDataset {
  const checksum = contentHash({
    metadata: parts.metadata,
    observations: parts.observations,
    features: parts.features,
    matrix: Array.from(parts.matrix),
  });
  return {
    metadata: parts.metadata,
    observations: parts.observations,
    features: parts.features,
    matrix: parts.matrix,
    checksum,
    revision: `${parts.metadata.datasetId}@${checksum.slice(0, 12)}`,
    ingestion: parts.ingestion,
  };
}

function firstDuplicate(values: string[]): string | null {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return null;
}

/** §4.2 — the fields without which the pipeline cannot proceed. */
export function missingMetadataFields(metadata: Partial<DatasetMetadata>): string[] {
  const missing: string[] = [];
  const required: [keyof DatasetMetadata, string][] = [
    ['datasetId', 'a dataset identifier'],
    ['sampleId', 'a sample identifier'],
    ['organism', 'the organism'],
    ['tissue', 'the tissue or organ'],
    ['condition', 'the disease or condition'],
    ['assay', 'the assay'],
    ['platform', 'the platform'],
    ['resolution', 'the resolution type (spot, cell or subcellular)'],
    ['coordinateUnit', 'the coordinate unit'],
    ['coordinateSystem', 'the coordinate system'],
    ['featureNamespace', 'the feature identifier namespace'],
    ['preprocessingStatus', 'the preprocessing status of the supplied values'],
    ['licence', 'the licence or access status'],
  ];
  for (const [field, description] of required) {
    const value = metadata[field];
    if (value === undefined || value === null || String(value).trim() === '') missing.push(description);
  }
  return missing;
}

/**
 * §4.3's "unsupported input: stop and provide conversion guidance".
 *
 * Written out rather than gestured at. A researcher with an .h5ad should be
 * able to copy four lines and come back with something this build reads, and
 * the alternative — an error saying "unsupported format" — makes them guess
 * which of the several tabular layouts we mean.
 */
export function unsupportedFormatGuidance(filename: string): { message: string; guidance: string[] } {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.h5ad') || lower.endsWith('.h5')) {
    return {
      message: 'AnnData HDF5 (.h5ad) is not read directly by this build.',
      guidance: [
        'Export the three tables this lab reads, from Python:',
        'import anndata as ad, pandas as pd',
        'a = ad.read_h5ad("your.h5ad")',
        'pd.DataFrame(a.X.toarray() if hasattr(a.X, "toarray") else a.X, index=a.obs_names, columns=a.var_names).to_csv("matrix.csv")',
        'pd.DataFrame(a.obsm["spatial"], index=a.obs_names, columns=["x","y"]).rename_axis("observation_id").to_csv("coordinates.csv")',
        'a.obs.rename_axis("observation_id").to_csv("observations.csv")',
      ],
    };
  }
  if (lower.endsWith('.zarr') || lower.endsWith('.zip')) {
    return {
      message: 'SpatialData/Zarr is not read directly by this build.',
      guidance: [
        'Open the store with spatialdata, select the table you want to analyse, and export it as above:',
        'import spatialdata as sd',
        'store = sd.read_zarr("your.zarr")',
        'table = store.tables["table"]   # an AnnData',
        'then follow the .h5ad instructions for that table.',
      ],
    };
  }
  if (lower.endsWith('.parquet')) {
    return {
      message: 'Parquet is not read directly by this build.',
      guidance: ['pandas.read_parquet(...).to_csv("matrix.csv") produces a file this lab reads.'],
    };
  }
  return {
    message: `No reader is registered for "${filename}".`,
    guidance: [
      'This build reads delimited tables: a matrix (observations in rows, features in columns) and a coordinate table with observation_id, x and y.',
      'Optional: an observation metadata table and a feature metadata table, joined on the same identifiers.',
    ],
  };
}

export function inferModality(features: FeatureRecord[]): Modality {
  let rna = false;
  let protein = false;
  for (const feature of features) {
    if (feature.modality === 'transcriptomics') rna = true;
    else protein = true;
    if (rna && protein) return 'combined';
  }
  return protein ? 'proteomics' : 'transcriptomics';
}

export function coordinateUnitLabel(unit: CoordinateUnit): string {
  switch (unit) {
    case 'um': return 'µm';
    case 'mm': return 'mm';
    case 'pixel': return 'px';
    case 'arbitrary': return 'arb. units';
  }
}
