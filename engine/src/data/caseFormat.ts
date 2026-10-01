/**
 * The on-disk format for a frozen demonstration case.
 *
 * The case is generated once by `engine/tools/generate-case.mjs`, committed,
 * and loaded at server startup. Generating it at boot instead would cost about
 * ten seconds on every restart and — worse — would make "the demonstration
 * case" a thing that exists only as code, so §18.1's freeze item ("exact
 * dataset / version / license") could not be discharged even in principle.
 * A frozen artefact with a checksum can be.
 *
 * Numeric arrays are base64-encoded typed arrays rather than JSON number
 * arrays. A 2,400 x 71 count matrix written as JSON text is about 900 kB and
 * takes a noticeable moment to parse; the same data as base64 Int32 is 900 kB
 * of ASCII that decodes with one `Buffer.from`. Activities are Float32, which
 * is six significant figures — comfortably finer than the solver's 1e-5
 * tolerance, so nothing meaningful is lost.
 */

import type { DatasetMetadata, FeatureRecord, IngestionReport, ObservationRecord, SpatialDataset } from './types';
import type { TissueSpec } from './tissue';

export interface EncodedArray {
  kind: 'f32' | 'f64' | 'i32';
  length: number;
  base64: string;
}

export function encodeFloat32(values: ArrayLike<number>): EncodedArray {
  const array = Float32Array.from(values as ArrayLike<number>);
  return { kind: 'f32', length: array.length, base64: Buffer.from(array.buffer).toString('base64') };
}

export function encodeFloat64(values: ArrayLike<number>): EncodedArray {
  const array = Float64Array.from(values as ArrayLike<number>);
  return { kind: 'f64', length: array.length, base64: Buffer.from(array.buffer).toString('base64') };
}

export function encodeInt32(values: ArrayLike<number>): EncodedArray {
  const array = Int32Array.from(values as ArrayLike<number>);
  return { kind: 'i32', length: array.length, base64: Buffer.from(array.buffer).toString('base64') };
}

/**
 * Decodes into a Float64Array whatever the stored width was.
 *
 * Everything downstream works in float64, so decoding a Float32 store into a
 * Float32Array would leave a typed-array mismatch waiting in the first
 * arithmetic that touches it.
 */
export function decodeToFloat64(encoded: EncodedArray): Float64Array {
  const buffer = Buffer.from(encoded.base64, 'base64');
  // `Buffer.from(base64)` may return a view into a larger pool, so the byte
  // offset has to be respected — slicing the underlying ArrayBuffer without it
  // reads someone else's bytes.
  const view = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const copy = new Uint8Array(view);
  switch (encoded.kind) {
    case 'f32':
      return Float64Array.from(new Float32Array(copy.buffer, 0, encoded.length));
    case 'f64':
      return Float64Array.from(new Float64Array(copy.buffer, 0, encoded.length));
    case 'i32':
      return Float64Array.from(new Int32Array(copy.buffer, 0, encoded.length));
  }
}

export interface FrozenCase {
  format: 'spatial-case-v1';
  caseId: string;
  title: string;
  /** One paragraph, shown wherever the case is offered. */
  description: string;
  /** The honesty statement that travels with the case. */
  simulationNotice: string;
  generatedAt: string;
  engineVersion: string;
  spec: TissueSpec;

  metadata: DatasetMetadata;
  observations: ObservationRecord[];
  features: FeatureRecord[];
  /** observations x features, counts. */
  matrix: EncodedArray;
  checksum: string;
  revision: string;
  ingestion: IngestionReport;

  /** The mechanistic state the counts were drawn from. */
  truth: EncodedArray;
  capacity: EncodedArray;
  /** Sparse: only the nodes with a non-zero exogenous drive. */
  exogenous: { nodeIndex: number; values: EncodedArray }[];
  ligandReference: EncodedArray;
  nodeCount: number;
  nodeSymbols: string[];

  cellTypes: string[];
  regions: string[];
  vesselDistance: EncodedArray;

  /** Optional companion sections, e.g. a comparable reference tissue. */
  role: 'primary' | 'reference';
  /** Case ids this one may be compared with. */
  comparableWith: string[];
}

export function decodeDataset(frozen: FrozenCase): SpatialDataset {
  return {
    metadata: frozen.metadata,
    observations: frozen.observations,
    features: frozen.features,
    matrix: decodeToFloat64(frozen.matrix),
    checksum: frozen.checksum,
    revision: frozen.revision,
    ingestion: frozen.ingestion,
  };
}

export interface DecodedCaseState {
  truth: Float64Array;
  capacity: Float64Array;
  exogenous: Float64Array;
  ligandReference: Float64Array;
  nodeCount: number;
  observationCount: number;
}

export function decodeState(frozen: FrozenCase): DecodedCaseState {
  const observationCount = frozen.observations.length;
  const nodeCount = frozen.nodeCount;
  const exogenous = new Float64Array(observationCount * nodeCount);
  for (const entry of frozen.exogenous) {
    const values = decodeToFloat64(entry.values);
    for (let i = 0; i < observationCount; i += 1) {
      exogenous[i * nodeCount + entry.nodeIndex] = values[i] as number;
    }
  }
  return {
    truth: decodeToFloat64(frozen.truth),
    capacity: decodeToFloat64(frozen.capacity),
    exogenous,
    ligandReference: decodeToFloat64(frozen.ligandReference),
    nodeCount,
    observationCount,
  };
}
