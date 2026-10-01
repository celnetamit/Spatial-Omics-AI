/**
 * Candidate eligibility, the comparison policy and §7.6 recovery.
 *
 * The rules under test are the ones that stop a plausible-looking ranking
 * appearing where the evidence does not support one:
 *
 *  - no composite score without a reviewer-approved weight set (§6.19);
 *  - no candidate in the comparison that was not simulated (§2);
 *  - overshoot counted as overshoot, not as rescue (§7.6);
 *  - adverse burden on its own axis, so a high benefit cannot hide it (§6.15).
 */

import { describe, expect, it } from 'vitest';
import {
  assessCandidate, compareCandidates, extractDrivers, retrieveCandidates,
  type CandidateTherapy, type RankingPolicy, type RescueOutcome, type RetrievalContext,
} from '../src/rescue/candidates';
import { referenceRecovery } from '../src/rescue/comparison';
import { compileNetwork } from '../src/propagate/network';

const network = compileNetwork();

const context: RetrievalContext = {
  featureSpace: new Set(['EGFR', 'TGFBR1', 'VEGFA']),
  supportedClasses: new Set(['small-molecule']),
  drivers: [{ symbol: 'TGFBR1', direction: 'up', magnitude: 0.2 }],
  datasetOrganism: 'Homo sapiens',
  datasetTissue: 'Tumour',
};

function candidate(over: Partial<Omit<CandidateTherapy, 'eligibility'>> = {}): Omit<CandidateTherapy, 'eligibility'> {
  return {
    candidateId: 'CHEMBL1',
    name: 'Test compound',
    therapyClass: 'small-molecule',
    target: 'EGFR',
    mechanism: 'Inhibitor.',
    actionType: 'inhibitor',
    evidence: [
      { kind: 'drug-target', source: 'ChEMBL', identifier: 'x', summary: 'y', evidenceClass: 'curated-database', retrievedAt: '2026-09-22' },
      { kind: 'bioactivity', source: 'ChEMBL', identifier: 'x', summary: 'y', evidenceClass: 'near-context-experimental', retrievedAt: '2026-09-22' },
    ],
    doseResponse: {
      emax: 1, ec50Nm: 30, hill: 1, source: 's', evidenceClass: 'curated-database',
      context: { organism: 'Homo sapiens', tissueOrCellLine: 'mixed', assay: 'IC50', testedRangeNm: [1, 1000] },
      transferWarning: null,
    },
    suggestedConcentrationNm: 30,
    concentrationRationale: 'median',
    secondaryTargets: [],
    ...over,
  };
}

describe('candidate eligibility', () => {
  it('accepts a small molecule with evidence, a target in the space and a parameterisation', () => {
    expect(assessCandidate(candidate(), context).eligible).toBe(true);
  });

  it('refuses a therapy class with no validated mechanistic model, and names it', () => {
    const result = assessCandidate(candidate({ therapyClass: 'antibody' }), context);
    expect(result.eligible).toBe(false);
    expect(result.failed).toContain('model-pack-supports-class');
    expect(result.reasons.join(' ')).toContain('§1.4');
  });

  it('refuses a compound with no dose-response parameterisation', () => {
    const result = assessCandidate(candidate({ doseResponse: null, suggestedConcentrationNm: null }), context);
    expect(result.eligible).toBe(false);
    expect(result.failed).toContain('parameterisation-available');
  });

  it('refuses a target outside the model feature space', () => {
    const result = assessCandidate(candidate({ target: 'MYC' }), context);
    expect(result.eligible).toBe(false);
    expect(result.failed).toContain('target-in-feature-space');
  });

  it('refuses a candidate with no mechanism evidence', () => {
    const result = assessCandidate(candidate({ evidence: [] }), context);
    expect(result.eligible).toBe(false);
    expect(result.failed).toContain('target-mechanism-evidence');
  });
});

describe('retrieval', () => {
  it('returns the eligible set alphabetically, implying no ordering', () => {
    const result = retrieveCandidates(
      [candidate({ candidateId: 'B', name: 'Zeta' }), candidate({ candidateId: 'A', name: 'Alpha' })],
      context,
    );
    expect(result.eligible.map((entry) => entry.name)).toEqual(['Alpha', 'Zeta']);
    expect(result.note).toContain('no ordering is implied before simulation');
  });

  it('keeps the excluded candidates with their reasons rather than dropping them', () => {
    const result = retrieveCandidates([candidate({ therapyClass: 'antibody' })], context);
    expect(result.eligible).toHaveLength(0);
    expect(result.excluded).toHaveLength(1);
    expect(result.excluded[0]?.eligibility.reasons.length).toBeGreaterThan(0);
  });
});

describe('drivers', () => {
  it('ranks by magnitude and drops anything under the noise floor', () => {
    const symbols = ['A', 'B', 'C', 'D'];
    const deltas = Float64Array.from([0.001, -0.3, 0.15, 0]);
    const drivers = extractDrivers(deltas, symbols, 0.02);
    expect(drivers.map((entry) => entry.symbol)).toEqual(['B', 'C']);
    expect(drivers[0]?.direction).toBe('down');
  });
});

function outcome(name: string, benefit: number, adverse: number, uncertainty = 0): RescueOutcome {
  return {
    candidateId: name,
    name,
    components: [
      { id: 'reversal-extent', name: 'Reversal extent', value: benefit, direction: 'higher-is-better', unit: 'fraction', method: 'm' },
      { id: 'residual-disease', name: 'Residual', value: 1 - benefit, direction: 'lower-is-better', unit: 'r', method: 'm' },
    ],
    adverseBurden: adverse,
    resistance: 0,
    uncertainty,
    confidence: 'moderate',
    simulationId: `sim-${name}`,
    warnings: [],
  };
}

describe('comparison', () => {
  it('produces no composite score and says so when there is no approved policy', () => {
    const result = compareCandidates([outcome('A', 0.8, 0.1), outcome('B', 0.4, 0.05)], null);
    expect(result.composite).toBeNull();
    expect(result.ranking).toBeNull();
    expect(result.noClearWinner).toContain('No reviewer-approved weight set');
    expect(result.method).toBe('rescue.compare.pareto');
  });

  it('keeps a candidate on the Pareto front when nothing beats it on all axes', () => {
    // A is better on benefit, B is better on adverse: neither dominates.
    const result = compareCandidates([outcome('A', 0.8, 0.3), outcome('B', 0.4, 0.05)], null);
    expect(result.paretoFront.sort()).toEqual(['A', 'B']);
  });

  it('drops a dominated candidate from the front', () => {
    const result = compareCandidates(
      [outcome('good', 0.9, 0.05), outcome('worse', 0.4, 0.4)],
      null,
    );
    expect(result.paretoFront).toEqual(['good']);
  });

  it('never invents a separation when the values are identical', () => {
    const result = compareCandidates([outcome('A', 0.5, 0.1), outcome('B', 0.5, 0.1)], null);
    // Normalising an all-equal column to 0 or 1 would make one look best.
    for (const row of result.table) {
      expect(row.normalised['reversal-extent']).toBe(0.5);
    }
  });

  it('produces a ranking only with a policy, and flags a tie below the threshold', () => {
    const policy: RankingPolicy = {
      id: 'test-policy', version: '1.0.0', approvedBy: 'test', approvedAt: '2026-09-22',
      benefitWeights: { 'reversal-extent': 1 },
      riskWeights: { 'residual-disease': 0.5 },
      uncertaintyWeight: 0.1,
      justification: 'test',
    };
    const result = compareCandidates([outcome('A', 0.9, 0.1), outcome('B', 0.4, 0.1)], policy, 0.2);
    expect(result.composite).not.toBeNull();
    expect(result.ranking).toEqual(['A', 'B']);
    expect(result.noClearWinner).toBeNull();
  });

  it('refuses to present an ordering that comes from the normalisation rather than the data', () => {
    const policy: RankingPolicy = {
      id: 'test-policy', version: '1.0.0', approvedBy: 'test', approvedAt: '2026-09-22',
      benefitWeights: { 'reversal-extent': 1 }, riskWeights: {}, uncertaintyWeight: 0,
      justification: 'test',
    };
    /*
     * 0.900 against 0.899. Min-max normalisation sends these to 1 and 0, so the
     * composite scores are a full point apart and the ranking looks decisive.
     * The candidates differ by one part in nine hundred.
     */
    const result = compareCandidates([outcome('A', 0.9, 0.1), outcome('B', 0.899, 0.1)], policy, 0.2);
    expect(result.degenerateComponents.map((entry) => entry.id)).toContain('reversal-extent');
    expect(result.noClearWinner).toContain('artefact of the scaling');
  });

  it('names a component that is not separating anything even without a policy', () => {
    const result = compareCandidates([outcome('A', 0.5, 0.1), outcome('B', 0.5001, 0.1)], null);
    expect(result.degenerateComponents.length).toBeGreaterThan(0);
    expect(result.degenerateComponents[0]?.note).toContain('they are not');
  });

  it('says there is nothing to compare rather than returning an empty ranking', () => {
    const result = compareCandidates([], null);
    expect(result.noClearWinner).toContain('nothing to compare');
  });
});

describe('reference recovery', () => {
  const symbols = network.nodes.map((node) => node.symbol);
  const index = (symbol: string): number => symbols.indexOf(symbol);

  function profiles(): { reference: Float64Array; disease: Float64Array; treated: Float64Array } {
    const size = symbols.length;
    return {
      reference: new Float64Array(size).fill(0.2),
      disease: new Float64Array(size).fill(0.2),
      treated: new Float64Array(size).fill(0.2),
    };
  }

  it('is undefined when the reference is not comparable', () => {
    const { reference, disease, treated } = profiles();
    const result = referenceRecovery(reference, disease, treated, network, false);
    expect(Number.isNaN(result.meanRecovery)).toBe(true);
    expect(result.note).toContain('undefined');
  });

  it('scores a feature restored to the reference as recovered', () => {
    const { reference, disease, treated } = profiles();
    const node = index('CDH1');
    reference[node] = 0.5;
    disease[node] = 0.1;
    treated[node] = 0.48;
    const result = referenceRecovery(reference, disease, treated, network, true);
    const feature = result.features[node];
    expect(feature?.verdict).toBe('recovered');
    expect(feature?.recovery).toBeGreaterThan(0.9);
  });

  it('flags an overshoot rather than counting it as a rescue', () => {
    const { reference, disease, treated } = profiles();
    const node = index('CDH1');
    reference[node] = 0.5;
    disease[node] = 0.1;
    treated[node] = 0.9; // sailed past the reference
    const result = referenceRecovery(reference, disease, treated, network, true);
    expect(result.features[node]?.verdict).toBe('overshoot');
    expect(result.overshooting).toContain('CDH1');
    // R_f alone is what makes this dangerous: it is high for an overshoot.
    expect(result.counts.recovered).toBe(0);
  });

  it('flags a feature that moved further away', () => {
    const { reference, disease, treated } = profiles();
    const node = index('CDH1');
    reference[node] = 0.5;
    disease[node] = 0.3;
    treated[node] = 0.1;
    const result = referenceRecovery(reference, disease, treated, network, true);
    expect(result.features[node]?.verdict).toBe('worsened');
    expect(result.worsening).toContain('CDH1');
  });

  it('reports a feature with no gap as having nothing to recover', () => {
    const { reference, disease, treated } = profiles();
    const result = referenceRecovery(reference, disease, treated, network, true);
    expect(result.counts['no-gap']).toBe(symbols.length);
    expect(Number.isNaN(result.meanRecovery)).toBe(true);
  });
});
