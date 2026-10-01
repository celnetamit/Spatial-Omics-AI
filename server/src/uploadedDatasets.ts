/**
 * Uploaded dataset persistence.
 *
 * Bundled cases live in content/ and carry simulator state. User uploads live in
 * the data volume and carry only the canonical measured dataset. Any later
 * prediction on an upload must therefore estimate activity explicitly rather
 * than pretending the hidden simulator state exists.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeToFloat64, encodeFloat64, type EncodedArray } from '@engine/data/caseFormat';
import type { DatasetMetadata, SpatialDataset } from '@engine/data/types';

interface StoredUploadedDataset {
  format: 'spatial-upload-v1';
  dataset: Omit<SpatialDataset, 'matrix'> & { matrix: EncodedArray };
}

function uploadDir(dataRoot: string): string {
  return join(dataRoot, 'uploads');
}

function assertDatasetId(datasetId: string): void {
  if (!/^usr_[a-zA-Z0-9_-]{8,80}$/.test(datasetId)) {
    throw new Error('Uploaded dataset ids must start with usr_ and contain only letters, numbers, underscores and dashes.');
  }
}

export function writeUploadedDataset(dataRoot: string, dataset: SpatialDataset): void {
  assertDatasetId(dataset.metadata.datasetId);
  const directory = uploadDir(dataRoot);
  mkdirSync(directory, { recursive: true });
  const stored: StoredUploadedDataset = {
    format: 'spatial-upload-v1',
    dataset: {
      ...dataset,
      matrix: encodeFloat64(dataset.matrix),
    },
  };
  writeFileSync(join(directory, dataset.metadata.datasetId + '.json'), JSON.stringify(stored));
}

export function readUploadedDataset(dataRoot: string, datasetId: string): SpatialDataset | null {
  assertDatasetId(datasetId);
  const path = join(uploadDir(dataRoot), datasetId + '.json');
  if (!existsSync(path)) return null;
  const stored = JSON.parse(readFileSync(path, 'utf8')) as StoredUploadedDataset;
  if (stored.format !== 'spatial-upload-v1') return null;
  return {
    ...stored.dataset,
    matrix: decodeToFloat64(stored.dataset.matrix),
  };
}

export function publicUploadedSummary(dataset: SpatialDataset): Record<string, unknown> {
  return {
    datasetId: dataset.metadata.datasetId,
    observations: dataset.observations.length,
    features: dataset.features.length,
    organism: dataset.metadata.organism,
    tissue: dataset.metadata.tissue,
    condition: dataset.metadata.condition,
    assay: dataset.metadata.assay,
    platform: dataset.metadata.platform,
    resolution: dataset.metadata.resolution,
    coordinateUnit: dataset.metadata.coordinateUnit,
    licence: dataset.metadata.licence,
    accessStatus: dataset.metadata.accessStatus,
    origin: dataset.metadata.origin,
    checksum: dataset.checksum,
    revision: dataset.revision,
    ingestedAt: dataset.ingestion.ingestedAt,
    sourceFiles: dataset.ingestion.sourceFiles.map((file) => ({ name: file.name, bytes: file.bytes, sha256: file.sha256 })),
  };
}

export function metadataFromUpload(body: Partial<DatasetMetadata> & Record<string, unknown>, projectId: string): DatasetMetadata {
  const datasetId = typeof body.datasetId === 'string' && body.datasetId.trim()
    ? body.datasetId.trim()
    : 'usr_' + projectId.replace(/[^a-zA-Z0-9]/g, '').slice(-12) + '_' + Date.now().toString(36);
  const coordinateUnit = body.coordinateUnit === 'mm' || body.coordinateUnit === 'pixel' || body.coordinateUnit === 'arbitrary'
    ? body.coordinateUnit
    : 'um';
  const resolution = body.resolution === 'spot' || body.resolution === 'subcellular' ? body.resolution : 'cell';
  const preprocessingStatus =
    body.preprocessingStatus === 'normalised' || body.preprocessingStatus === 'transformed' || body.preprocessingStatus === 'unknown'
      ? body.preprocessingStatus
      : 'raw-counts';

  return {
    datasetId,
    sampleId: String(body.sampleId ?? datasetId).trim(),
    organism: String(body.organism ?? '').trim(),
    genomeBuild: typeof body.genomeBuild === 'string' && body.genomeBuild.trim() ? body.genomeBuild.trim() : null,
    tissue: String(body.tissue ?? '').trim(),
    condition: String(body.condition ?? '').trim(),
    assay: String(body.assay ?? '').trim(),
    platform: String(body.platform ?? '').trim(),
    resolution,
    coordinateUnit,
    coordinateSystem: String(body.coordinateSystem ?? 'source coordinates').trim(),
    featureNamespace: String(body.featureNamespace ?? 'HGNC').trim(),
    preprocessingStatus,
    donorId: typeof body.donorId === 'string' && body.donorId.trim() ? body.donorId.trim() : null,
    batchId: typeof body.batchId === 'string' && body.batchId.trim() ? body.batchId.trim() : null,
    replicate: typeof body.replicate === 'string' && body.replicate.trim() ? body.replicate.trim() : null,
    licence: String(body.licence ?? 'user supplied').trim(),
    accessStatus: 'user-upload',
    origin: String(body.origin ?? 'User uploaded tabular spatial omics dataset.').trim(),
    imageAlignment: null,
  };
}
