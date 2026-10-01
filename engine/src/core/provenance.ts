/**
 * Provenance: what ran, on what, with which parameters — and the hashes that
 * make "the same run" a checkable claim rather than an assurance.
 *
 * §16.1 lists fourteen things a reproducibility manifest has to carry. They are
 * modelled here, once, so that every stage appends to the same record and the
 * report is assembled from it rather than from a component's memory of what it
 * displayed.
 */

import { createHash } from 'node:crypto';

/** SHA-256, hex. §6.2 requires it for uploaded datasets specifically. */
export function sha256(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * A content hash for structured objects.
 *
 * Keys are sorted at every level, so two objects that differ only in property
 * order hash the same — otherwise a graph checksum would change when a
 * serialiser was upgraded, and a run would look non-reproducible when nothing
 * scientific had moved. Numbers are written at full precision: rounding here
 * would let a parameter change without the checksum noticing.
 */
export function contentHash(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return JSON.stringify(String(value));
    return Number.isInteger(value) ? String(value) : value.toPrecision(17);
  }
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (ArrayBuffer.isView(value)) {
    const view = value as unknown as ArrayLike<number>;
    const parts: string[] = [];
    for (let i = 0; i < view.length; i += 1) parts.push(canonicalJson(view[i]));
    return `[${parts.join(',')}]`;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return 'null';
}

/** One step that ran, as the methods panel and the report both read it. */
export interface MethodRecord {
  /** Stable id, e.g. `preprocess.normalise.cp10k-log1p`. */
  id: string;
  /** What a reader calls it. */
  name: string;
  /** Semantic version of the implementation. */
  version: string;
  /** Software or model pack this belongs to. */
  software: string;
  /** The parameters it ran with, exactly. */
  parameters: Record<string, unknown>;
  /** A sentence a learner can read. */
  summary: string;
  /** Literature or database references, where the method has them. */
  references?: string[];
}

/** §16.1, assembled across the run rather than written at the end. */
export interface ReproducibilityManifest {
  runId: string;
  createdAt: string;
  engineVersion: string;

  datasets: { datasetId: string; revision: string; sha256: string; role: string }[];
  methods: MethodRecord[];

  parameterPack: { id: string; version: string } | null;
  graph: { graphId: string; method: string; checksum: string; parameters: Record<string, unknown> } | null;
  model: { modelId: string; version: string; weightsChecksum: string } | null;
  evidenceSnapshot: { id: string; retrievedAt: string; sources: string[] } | null;
  ai: { model: string; promptVersion: string; templateVersion: string } | null;

  seed: number;
  repeatId: number;

  /** Warnings, out-of-domain flags and the confidence status of the whole run. */
  warnings: string[];
  outOfDomain: string[];
  confidence: string;

  /** Hash of each artefact the run produced. */
  artefacts: { id: string; kind: string; checksum: string }[];

  timings: { stage: string; milliseconds: number }[];
}

export function emptyManifest(runId: string, engineVersion: string, seed: number): ReproducibilityManifest {
  return {
    runId,
    createdAt: new Date().toISOString(),
    engineVersion,
    datasets: [],
    methods: [],
    parameterPack: null,
    graph: null,
    model: null,
    evidenceSnapshot: null,
    ai: null,
    seed,
    repeatId: 0,
    warnings: [],
    outOfDomain: [],
    confidence: 'moderate',
    artefacts: [],
    timings: [],
  };
}

/** Adds a method record, replacing an earlier one with the same id. */
export function recordMethod(manifest: ReproducibilityManifest, method: MethodRecord): void {
  const index = manifest.methods.findIndex((m) => m.id === method.id);
  if (index >= 0) manifest.methods[index] = method;
  else manifest.methods.push(method);
}
