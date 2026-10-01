/**
 * Ingestion and QC.
 *
 * The refusal paths carry most of the weight. §4.3 separates "requires
 * metadata" from "unsupported input" because one is a missing field and the
 * other is a conversion job, and answering "invalid file" for either wastes an
 * afternoon — so each refusal is checked for the specific code and for guidance
 * somebody can act on.
 */

import { describe, expect, it } from 'vitest';
import {
  ingestTabular, missingMetadataFields, parseTable, unsupportedFormatGuidance,
} from '../src/data/ingest';
import { runQc, assessComparability } from '../src/qc/index';
import type { DatasetMetadata } from '../src/data/types';

const metadata: DatasetMetadata = {
  datasetId: 'test', sampleId: 's1', organism: 'Homo sapiens', genomeBuild: null,
  tissue: 'Tumour', condition: 'Untreated', assay: 'Visium', platform: '10x',
  resolution: 'spot', coordinateUnit: 'um', coordinateSystem: 'section',
  featureNamespace: 'HGNC', preprocessingStatus: 'raw-counts',
  donorId: null, batchId: null, replicate: null,
  licence: 'CC0', accessStatus: 'user-upload', origin: 'test', imageAlignment: null,
};

function file(name: string, text: string) {
  return { name, text, bytes: text.length };
}

const MATRIX = 'id,GENEA,GENEB\nc1,5,0\nc2,3,7\nc3,0,2\n';
const COORDS = 'observation_id,x,y\nc1,0,0\nc2,10,0\nc3,0,10\n';

describe('the table reader', () => {
  it('handles a quoted delimiter inside a cell', () => {
    // "T cell, CD8+" is how the ontologies write it, so splitting on the
    // delimiter corrupts most real exports.
    const table = parseTable('id,cell_type\nc1,"T cell, CD8+"\nc2,CAF\n');
    expect(table.rows[0]).toEqual(['c1', 'T cell, CD8+']);
    expect(table.rows[1]).toEqual(['c2', 'CAF']);
  });

  it('handles an escaped quote', () => {
    const table = parseTable('id,note\nc1,"she said ""yes"""\n');
    expect(table.rows[0]?.[1]).toBe('she said "yes"');
  });

  it('detects a tab delimiter', () => {
    const table = parseTable('id\tA\tB\nc1\t1\t2\n');
    expect(table.header).toEqual(['id', 'A', 'B']);
  });

  it('ignores trailing blank lines rather than calling the table ragged', () => {
    const table = parseTable('id,A\nc1,1\n\n\n');
    expect(table.rows).toHaveLength(1);
  });
});

describe('ingestion', () => {
  it('reads a matrix and a coordinate table into one canonical object', () => {
    const result = ingestTabular({ matrix: file('m.csv', MATRIX), coordinates: file('c.csv', COORDS) }, { metadata });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dataset.observations).toHaveLength(3);
    expect(result.dataset.features.map((f) => f.id)).toEqual(['GENEA', 'GENEB']);
    expect(result.dataset.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(result.dataset.matrix[0]).toBe(5);
  });

  it('is deterministic: the same input gives the same checksum', () => {
    const a = ingestTabular({ matrix: file('m.csv', MATRIX), coordinates: file('c.csv', COORDS) }, { metadata });
    const b = ingestTabular({ matrix: file('m.csv', MATRIX), coordinates: file('c.csv', COORDS) }, { metadata });
    expect(a.ok && b.ok && a.dataset.checksum === b.dataset.checksum).toBe(true);
  });

  it('reads a transposed matrix when told to', () => {
    const transposed = 'feature,c1,c2,c3\nGENEA,5,3,0\nGENEB,0,7,2\n';
    const result = ingestTabular(
      { matrix: file('m.csv', transposed), coordinates: file('c.csv', COORDS) },
      { metadata, observationsAreRows: false },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Row-major, observations x features: index = observation * features + feature.
    expect(result.dataset.matrix[0]).toBe(5); // c1, GENEA
    expect(result.dataset.matrix[2]).toBe(3); // c2, GENEA
    expect(result.dataset.matrix[3]).toBe(7); // c2, GENEB
  });

  it('refuses a duplicated observation id and says why it matters', () => {
    const result = ingestTabular(
      { matrix: file('m.csv', 'id,A\nc1,1\nc1,2\n'), coordinates: file('c.csv', COORDS) },
      { metadata },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('DUPLICATE_OBSERVATION_ID');
    expect(result.guidance.join(' ')).toContain('spatial graph');
  });

  it('refuses an observation with no coordinate rather than dropping it', () => {
    const result = ingestTabular(
      { matrix: file('m.csv', MATRIX), coordinates: file('c.csv', 'observation_id,x,y\nc1,0,0\nc2,10,0\n') },
      { metadata },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('COORDINATE_MISMATCH');
    expect(result.message).toContain('c3');
  });

  it('refuses a non-numeric value and names the cell', () => {
    const result = ingestTabular(
      { matrix: file('m.csv', 'id,A\nc1,notanumber\n'), coordinates: file('c.csv', COORDS) },
      { metadata },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('NON_NUMERIC_VALUE');
    expect(result.message).toContain('notanumber');
  });

  it('refuses missing metadata separately from a malformed file', () => {
    const result = ingestTabular(
      { matrix: file('m.csv', MATRIX), coordinates: file('c.csv', COORDS) },
      { metadata: { ...metadata, organism: '' } },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('MISSING_METADATA');
  });

  it('joins optional annotation and reports rows it could not join', () => {
    const result = ingestTabular(
      {
        matrix: file('m.csv', MATRIX),
        coordinates: file('c.csv', COORDS),
        observationMetadata: file('o.csv', 'observation_id,cell_type\nc1,Tumour\nc9,Ghost\n'),
      },
      { metadata },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dataset.observations[0]?.cellType).toBe('Tumour');
    expect(result.warnings.join(' ')).toContain('not in the matrix');
  });
});

describe('metadata requirements', () => {
  it('names every missing field, not just the first', () => {
    const missing = missingMetadataFields({ datasetId: 'x' });
    expect(missing.length).toBeGreaterThan(5);
    expect(missing.join(' ')).toContain('organism');
  });
});

describe('unsupported formats', () => {
  it('gives runnable conversion guidance for h5ad rather than "unsupported"', () => {
    const guidance = unsupportedFormatGuidance('sample.h5ad');
    expect(guidance.message).toContain('AnnData');
    expect(guidance.guidance.join('\n')).toContain('anndata');
    expect(guidance.guidance.join('\n')).toContain('obsm["spatial"]');
  });

  it('covers zarr and parquet too', () => {
    expect(unsupportedFormatGuidance('x.zarr').guidance.join('\n')).toContain('spatialdata');
    expect(unsupportedFormatGuidance('x.parquet').guidance.join('\n')).toContain('read_parquet');
  });
});

describe('QC', () => {
  function dataset() {
    const result = ingestTabular({ matrix: file('m.csv', MATRIX), coordinates: file('c.csv', COORDS) }, { metadata });
    if (!result.ok) throw new Error('setup failed');
    return result.dataset;
  }

  it('separates the analysis verdict from prediction eligibility', () => {
    const report = runQc(dataset());
    // Three cells is fine to describe and far too few to propagate through.
    expect(report.predictionEligible).toBe(false);
    expect(report.predictionBlockers.join(' ')).toContain('Enough observations');
  });

  it('labels each check with the kind of threshold it applied', () => {
    const kinds = new Set(runQc(dataset()).checks.map((check) => check.kind));
    expect(kinds.has('structural')).toBe(true);
    expect(kinds.has('engineering')).toBe(true);
  });

  it('says a panel has no mitochondrial features rather than reporting 0%', () => {
    const report = runQc(dataset());
    const check = report.checks.find((entry) => entry.id === 'observation.mitochondrial');
    expect(check?.measured).toContain('no mitochondrial features');
    expect(check?.rationale).toContain('never made');
  });

  it('blocks on a model feature namespace mismatch', () => {
    const report = runQc(dataset(), { modelFeatureNamespace: 'ENSEMBL' });
    const check = report.checks.find((entry) => entry.id === 'structure.feature-namespace');
    expect(check?.verdict).toBe('fail');
    expect(report.predictionEligible).toBe(false);
  });
});

describe('comparability', () => {
  function dataset(over: Partial<DatasetMetadata> = {}) {
    const result = ingestTabular(
      { matrix: file('m.csv', MATRIX), coordinates: file('c.csv', COORDS) },
      { metadata: { ...metadata, ...over } },
    );
    if (!result.ok) throw new Error('setup failed');
    return result.dataset;
  }

  it('accepts two sections that match on assay, resolution and namespace', () => {
    const result = assessComparability(dataset(), dataset({ datasetId: 'b', condition: 'Treated' }));
    expect(result.comparable).toBe(true);
    expect(result.sharedFeatures).toEqual(['GENEA', 'GENEB']);
  });

  it('refuses a different assay, and says so as a blocking reason', () => {
    const result = assessComparability(dataset(), dataset({ assay: 'Xenium' }));
    expect(result.comparable).toBe(false);
    expect(result.reasons.join(' ')).toContain('Different assays');
  });

  it('warns without blocking on a different platform', () => {
    const result = assessComparability(dataset(), dataset({ platform: 'Curio' }));
    expect(result.comparable).toBe(true);
    expect(result.warnings.join(' ')).toContain('batch component');
  });
});
