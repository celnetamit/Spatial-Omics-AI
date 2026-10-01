/**
 * The perturbation layer: the dose-response curve, the extrapolation refusal,
 * and the eligibility rules.
 *
 * The refusal cases matter more than the success cases here. §5.3 disables
 * extrapolation by default, and the failure mode it protects against is
 * specific: the Hill form is nearly linear below the tested range and flat
 * above it, so extrapolating in either direction returns a confident number
 * from a shape nobody measured there.
 */

import { describe, expect, it } from 'vitest';
import {
  assessEligibility, createDefinition, doseResponse, resolveSelection, timeResponse, toHours, toNanomolar,
} from '../src/perturb/index';
import type { DoseResponseParameters, DrugPerturbation, MolecularPerturbation } from '../src/perturb/types';
import type { ObservationRecord } from '../src/data/types';

const parameters: DoseResponseParameters = {
  emax: 1,
  ec50Nm: 30,
  hill: 1,
  source: 'ChEMBL CHEMBL553 against CHEMBL203',
  evidenceClass: 'curated-database',
  context: { organism: 'Homo sapiens', tissueOrCellLine: 'mixed', assay: 'IC50', testedRangeNm: [0.74, 1200] },
  transferWarning: null,
};

describe('the dose-response curve', () => {
  it('is half-maximal at the EC50', () => {
    expect(doseResponse(30, parameters).effect).toBeCloseTo(0.5, 12);
  });

  it('is monotone increasing inside the tested range', () => {
    let previous = -1;
    for (const concentration of [1, 3, 10, 30, 100, 300, 1000]) {
      const value = doseResponse(concentration, parameters).effect;
      expect(value).toBeGreaterThan(previous);
      previous = value;
    }
  });

  it('refuses a concentration outside the tested range', () => {
    const below = doseResponse(0.01, parameters);
    expect(Number.isNaN(below.effect)).toBe(true);
    expect(below.extrapolated).toBe(true);
    expect(below.note).toContain('outside');

    const above = doseResponse(1e6, parameters);
    expect(Number.isNaN(above.effect)).toBe(true);
  });

  it('extrapolates only when explicitly allowed, and says so', () => {
    const allowed = doseResponse(1e6, parameters, true);
    expect(Number.isFinite(allowed.effect)).toBe(true);
    expect(allowed.extrapolated).toBe(true);
    expect(allowed.note).toContain('exploratory');
  });

  it('is unbounded by the range when the source states none', () => {
    const open = { ...parameters, context: { ...parameters.context, testedRangeNm: null } };
    expect(Number.isFinite(doseResponse(1e6, open).effect)).toBe(true);
  });
});

describe('the time response', () => {
  it('returns a plateau and says why when no model exists', () => {
    const result = timeResponse(24, null);
    expect(result.factor).toBe(1);
    expect(result.note).toContain('inventing kinetics');
  });

  it('applies a first-order rate when one is supplied', () => {
    const result = timeResponse(24, {
      ratePerHour: 0.1,
      source: 'test',
      evidenceClass: 'near-context-experimental',
      supportedIntervalHours: [1, 48],
    });
    expect(result.factor).toBeCloseTo(1 - Math.exp(-2.4), 12);
    expect(result.note).toBeNull();
  });
});

describe('unit conversion', () => {
  it('normalises concentrations to nanomolar', () => {
    expect(toNanomolar(1, 'uM')).toBe(1000);
    expect(toNanomolar(1, 'mM')).toBe(1e6);
    expect(toNanomolar(5, 'nM')).toBe(5);
  });

  it('normalises times to hours', () => {
    expect(toHours(30, 'min')).toBe(0.5);
    expect(toHours(2, 'day')).toBe(48);
  });
});

describe('selection', () => {
  const observations: ObservationRecord[] = [
    { id: 'a', x: 0, y: 0, sampleId: 's' },
    { id: 'b', x: 10, y: 0, sampleId: 's' },
    { id: 'c', x: 100, y: 0, sampleId: 's' },
    { id: 'd', x: 200, y: 0, sampleId: 's' },
  ];
  const types = ['Tumour', 'CAF', 'Tumour', 'T cell'];
  const regions = ['Core', 'Core', 'Margin', 'Stroma'];

  it('resolves a cell-type selection and keeps the ids', () => {
    const selection = resolveSelection({ mode: 'cell-type', classes: ['Tumour'] }, observations, types, regions);
    expect(selection.resolvedIndices).toEqual([0, 2]);
    // §4.4 requires the selection to be saved as an immutable id list; resolving
    // again at run time could silently target a different set of cells.
    expect(selection.observationIds).toEqual(['a', 'c']);
  });

  it('resolves a radius selection against real coordinates', () => {
    const selection = resolveSelection(
      { mode: 'radius', centre: { x: 0, y: 0 }, radius: 50 },
      observations, types, regions,
    );
    expect(selection.resolvedIndices).toEqual([0, 1]);
  });

  it('resolves whole tissue', () => {
    expect(resolveSelection({ mode: 'whole-tissue' }, observations, types, regions).resolvedIndices).toHaveLength(4);
  });
});

describe('eligibility', () => {
  const context = {
    availableFeatures: new Set(['TGFB1', 'EGFR']),
    supportedTargets: new Set(['TGFB1', 'EGFR']),
    supportedOperators: new Set(['knockout', 'inhibition']),
    datasetOrganism: 'Homo sapiens',
    datasetTissue: 'Tumour',
    modelPackId: 'pack',
    modelPackVersion: '1.0.0',
  };

  const knockout: MolecularPerturbation = {
    branch: 'molecular-genetic', target: 'TGFB1', targetKind: 'gene',
    operator: 'knockout', magnitude: 0, magnitudeSource: 'model-pack', stage: 'steady-state',
  };

  it('accepts a supported knockout as quantitative', () => {
    expect(assessEligibility(knockout, context).decision).toBe('quantitative');
  });

  it('blocks a target the dataset does not measure, and says both reasons', () => {
    const result = assessEligibility({ ...knockout, target: 'NOTAGENE' }, context);
    expect(result.decision).toBe('blocked');
    expect(result.reasons.length).toBeGreaterThanOrEqual(2);
    expect(result.confidence).toBe('not-interpretable');
  });

  it('blocks an operator the model pack does not support', () => {
    const result = assessEligibility({ ...knockout, operator: 'mutation-gain-of-function' }, context);
    expect(result.decision).toBe('blocked');
  });

  it('marks a user-chosen magnitude exploratory', () => {
    const result = assessEligibility(
      { ...knockout, operator: 'inhibition', magnitude: 0.3, magnitudeSource: 'user-exploratory' },
      context,
    );
    expect(result.decision).toBe('exploratory');
    expect(result.remedies.join(' ')).toContain('model-pack magnitude');
  });

  it('marks an out-of-range drug concentration exploratory and names the range', () => {
    const drug: DrugPerturbation = {
      branch: 'drug', drugId: 'CHEMBL553', drugName: 'ERLOTINIB', target: 'EGFR',
      actionType: 'inhibitor', secondaryTargets: [],
      concentration: 10, concentrationUnit: 'mM',
      exposureTime: 24, exposureTimeUnit: 'h',
      doseResponse: parameters, timeResponse: null, evidenceSnapshotId: 'snap',
    };
    const result = assessEligibility(drug, context);
    expect(result.decision).toBe('exploratory');
    expect(result.reasons.join(' ')).toContain('outside');
    expect(result.remedies.join(' ')).toContain('Choose a concentration');
  });

  it('records a transfer warning when the evidence organism differs', () => {
    const drug: DrugPerturbation = {
      branch: 'drug', drugId: 'X', drugName: 'X', target: 'EGFR',
      actionType: 'inhibitor', secondaryTargets: [],
      concentration: 30, concentrationUnit: 'nM',
      exposureTime: 24, exposureTimeUnit: 'h',
      doseResponse: { ...parameters, context: { ...parameters.context, organism: 'Mus musculus' } },
      timeResponse: null, evidenceSnapshotId: 'snap',
    };
    const result = assessEligibility(drug, { ...context, datasetOrganism: 'Homo sapiens' });
    expect(result.reasons.join(' ')).toContain('transfer warning');
  });
});

describe('a definition', () => {
  const observations: ObservationRecord[] = [{ id: 'a', x: 0, y: 0, sampleId: 's' }];
  const selection = resolveSelection({ mode: 'whole-tissue' }, observations, ['T'], ['R']);
  const spec: MolecularPerturbation = {
    branch: 'molecular-genetic', target: 'TGFB1', targetKind: 'gene',
    operator: 'knockout', magnitude: 0, magnitudeSource: 'model-pack', stage: 'steady-state',
  };

  it('has a checksum that depends on the parameters and not on the description', () => {
    const a = createDefinition(spec, selection, { decision: 'quantitative', reasons: [], remedies: [], confidence: 'high' }, 'p', '1');
    const b = createDefinition(
      spec,
      { ...selection, description: 'a different sentence' },
      { decision: 'quantitative', reasons: [], remedies: [], confidence: 'high' },
      'p',
      '1',
    );
    expect(b.checksum).toBe(a.checksum);

    const c = createDefinition(
      { ...spec, operator: 'inhibition', magnitude: 0.5 },
      selection,
      { decision: 'quantitative', reasons: [], remedies: [], confidence: 'high' },
      'p',
      '1',
    );
    expect(c.checksum).not.toBe(a.checksum);
  });
});
