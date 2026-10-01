/**
 * The AI output gate.
 *
 * §13 confines the model to explaining structured results, and this
 * implementation enforces that as output validation rather than as prompt
 * wording. These tests are the reason that distinction is worth making: each
 * one hands the gate a response a compliant model would never produce and
 * checks it is refused anyway, because the guarantee has to hold for a model
 * that ignored every instruction it was given.
 */

import { describe, expect, it } from 'vitest';
import { extractGeneLikeTokens, extractNumbers, validateResponse } from '../src/ai/gate';
import { emptyEvidence, type EvidenceObject } from '../src/ai/evidence';

function evidence(): EvidenceObject {
  const base = emptyEvidence('run_test');
  base.dataset = {
    datasetId: 'sim', organism: 'Homo sapiens', tissue: 'Tumour', condition: 'Untreated',
    assay: 'simulated', observations: 2400, features: 71, provenanceNotice: null,
  };
  base.claims = [
    {
      id: 'pathway.hypoxia',
      label: 'COMPUTED',
      statement: 'Hypoxia response is highest in Tumour and lowest in CAF.',
      values: [
        { name: 'between-group variance share', value: 0.42, unit: 'eta squared' },
        { name: 'q', value: 0.001, unit: 'BH-adjusted permutation p' },
      ],
      method: 'baseline.pathway-activity',
      confidence: 'high',
    },
    {
      id: 'delta.smad3',
      label: 'PREDICTED',
      statement: 'SMAD3 falls across the section after the perturbation.',
      values: [{ name: 'mean change', value: -0.073, unit: 'activity units' }],
      method: 'propagation rollout',
      confidence: 'moderate',
    },
  ];
  base.vocabulary = {
    features: ['SMAD3', 'TGFB1', 'CDH1'],
    cellTypes: ['Tumour', 'CAF'],
    regions: ['Tumour core'],
    pathways: ['Hypoxia response'],
    candidates: ['GALUNISERTIB'],
  };
  return base;
}

const good = {
  findings: [{ statement: 'SMAD3 falls across the section, with a mean change of -0.073.', citedClaims: ['delta.smad3'] }],
  mechanism: [{ statement: 'Hypoxia response is highest in Tumour.', citedClaims: ['pathway.hypoxia'] }],
  candidateComparison: [],
  limitations: ['This is a simulated section.'],
  hypothesis: null,
  abstained: false,
  abstentionReason: null,
};

describe('the gate', () => {
  it('accepts a response whose every number and name is in the evidence', () => {
    const verdict = validateResponse(good, evidence());
    expect(verdict.accepted).toBe(true);
    expect(verdict.rejections).toEqual([]);
  });

  it('accepts a fenced JSON string, because that is what models emit', () => {
    const verdict = validateResponse('```json\n' + JSON.stringify(good) + '\n```', evidence());
    expect(verdict.accepted).toBe(true);
  });

  it('refuses a number that is not in the evidence', () => {
    const verdict = validateResponse(
      { ...good, findings: [{ statement: 'SMAD3 falls by 0.42 log units in 88% of cells.', citedClaims: ['delta.smad3'] }] },
      evidence(),
    );
    expect(verdict.accepted).toBe(false);
    expect(verdict.rejections.map((r) => r.code)).toContain('FABRICATED_NUMBER');
    expect(verdict.learnerMessage).toContain('does not appear anywhere in this run');
  });

  it('accepts a percentage written either way', () => {
    const withPercent = evidence();
    withPercent.claims[0]!.values.push({ name: 'fraction affected', value: 0.42, unit: 'fraction' });
    const verdict = validateResponse(
      { ...good, findings: [{ statement: 'It affects 42% of the section.', citedClaims: ['pathway.hypoxia'] }] },
      withPercent,
    );
    expect(verdict.accepted).toBe(true);
  });

  it('refuses a gene the dataset does not measure', () => {
    const verdict = validateResponse(
      { ...good, findings: [{ statement: 'MYC and SMAD3 both fall.', citedClaims: ['delta.smad3'] }] },
      evidence(),
    );
    expect(verdict.accepted).toBe(false);
    expect(verdict.rejections.map((r) => r.code)).toContain('UNKNOWN_VOCABULARY');
  });

  it('refuses a statement with no citation', () => {
    const verdict = validateResponse(
      { ...good, findings: [{ statement: 'The tissue looks inflamed.', citedClaims: [] }] },
      evidence(),
    );
    expect(verdict.accepted).toBe(false);
    expect(verdict.rejections.map((r) => r.code)).toContain('UNCITED_CLAIM');
  });

  it('refuses a citation to a result that does not exist', () => {
    const verdict = validateResponse(
      { ...good, findings: [{ statement: 'SMAD3 falls.', citedClaims: ['delta.invented'] }] },
      evidence(),
    );
    expect(verdict.accepted).toBe(false);
    expect(verdict.rejections.map((r) => r.code)).toContain('UNKNOWN_CLAIM_ID');
  });

  it('refuses clinical advice', () => {
    const verdict = validateResponse(
      {
        ...good,
        findings: [{ statement: 'GALUNISERTIB should be prescribed here.', citedClaims: ['delta.smad3'] }],
      },
      evidence(),
    );
    expect(verdict.accepted).toBe(false);
    expect(verdict.rejections.map((r) => r.code)).toContain('CLINICAL_ADVICE');
  });

  it('refuses an assertion of certainty', () => {
    const verdict = validateResponse(
      { ...good, findings: [{ statement: 'This proves SMAD3 falls.', citedClaims: ['delta.smad3'] }] },
      evidence(),
    );
    expect(verdict.accepted).toBe(false);
    expect(verdict.rejections.map((r) => r.code)).toContain('CERTAINTY_CLAIM');
  });

  it('refuses an association described as a cause', () => {
    const verdict = validateResponse(
      { ...good, mechanism: [{ statement: 'CAF signals to Tumour.', citedClaims: ['pathway.hypoxia'] }] },
      evidence(),
    );
    expect(verdict.accepted).toBe(false);
    expect(verdict.rejections.map((r) => r.code)).toContain('CAUSAL_OVERREACH');
  });

  it('accepts an abstention without checking anything else', () => {
    const verdict = validateResponse(
      { ...good, abstained: true, abstentionReason: 'The evidence does not support an interpretation.' },
      evidence(),
    );
    expect(verdict.accepted).toBe(true);
    expect(verdict.response?.abstained).toBe(true);
  });

  it('refuses a malformed response rather than salvaging it', () => {
    expect(validateResponse('not json at all', evidence()).accepted).toBe(false);
    expect(validateResponse(null, evidence()).accepted).toBe(false);
    expect(validateResponse(42, evidence()).accepted).toBe(false);
  });

  it('refuses an empty non-abstaining response', () => {
    const verdict = validateResponse(
      { findings: [], mechanism: [], candidateComparison: [], limitations: [], hypothesis: null, abstained: false, abstentionReason: null },
      evidence(),
    );
    expect(verdict.accepted).toBe(false);
    expect(verdict.rejections.map((r) => r.code)).toContain('EMPTY');
  });

  it('tells the reader the rest of the page is unaffected', () => {
    const verdict = validateResponse(
      { ...good, findings: [{ statement: 'SMAD3 falls by 0.918 units.', citedClaims: ['delta.smad3'] }] },
      evidence(),
    );
    expect(verdict.accepted).toBe(false);
    expect(verdict.learnerMessage).toContain('do not pass through any language model');
  });

  it('accepts a magnitude written without its sign', () => {
    // "falls by 0.073" is how anybody would write a change of -0.073, and the
    // signed value is on screen beside the sentence.
    const verdict = validateResponse(
      { ...good, findings: [{ statement: 'SMAD3 falls by 0.073.', citedClaims: ['delta.smad3'] }] },
      evidence(),
    );
    expect(verdict.accepted).toBe(true);
  });
});

describe('the extractors', () => {
  it('finds numbers including exponentials and negatives', () => {
    const found = extractNumbers('a change of -0.073 with q = 1.2e-4 and 88%');
    const readings = found.flatMap((candidate) => candidate.readings);
    expect(readings).toContain(-0.073);
    expect(readings).toContain(1.2e-4);
    expect(readings).toContain(88);
    // A percentage carries both readings on one candidate, so either can match.
    expect(found.find((candidate) => candidate.written === '88%')?.readings).toEqual([88, 0.88]);
  });

  it('does not read the digits inside a gene symbol as figures', () => {
    const readings = extractNumbers('SMAD3 and CDH1 and MAP2K1 and CDK4/6 all changed').flatMap((c) => c.readings);
    expect(readings).toEqual([]);
  });

  it('finds symbol-shaped tokens and skips ordinary acronyms', () => {
    const tokens = extractGeneLikeTokens('SMAD3 and CDH1 change; the RNA was measured by qPCR and is PREDICTED');
    expect(tokens).toContain('SMAD3');
    expect(tokens).toContain('CDH1');
    expect(tokens).not.toContain('RNA');
    expect(tokens).not.toContain('PREDICTED');
  });
});
