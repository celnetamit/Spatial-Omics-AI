/**
 * The structured evidence object an interpretation is built from — §13.2.
 *
 * This is the *only* thing a model is given. It is assembled from stored
 * artefacts by their result ids, so every claim the model can make has
 * something behind it, and the validator in `gate.ts` can check whether a
 * number in the response appears here.
 *
 * Nothing is rounded on the way in. §6.9 requires a numeric consistency test
 * against the result manifest, and a value rounded for the prompt and unrounded
 * in the report would fail it for a reason that has nothing to do with the
 * model.
 */

import type { Confidence } from '@engine/core/labels';

export interface EvidenceClaim {
  /** Stable id the model must cite. */
  id: string;
  /** What kind of result this is — the §1.5 label. */
  label: 'OBSERVED' | 'COMPUTED' | 'PREDICTED';
  statement: string;
  /** Numbers in this claim, so the gate can check the model's arithmetic. */
  values: { name: string; value: number; unit: string }[];
  method: string;
  confidence: Confidence;
}

export interface EvidenceObject {
  runId: string;
  generatedAt: string;
  dataset: {
    datasetId: string;
    organism: string;
    tissue: string;
    condition: string;
    assay: string;
    observations: number;
    features: number;
    /** The simulation notice, when the dataset is a bundled case. */
    provenanceNotice: string | null;
  };
  perturbation: {
    description: string;
    branch: string;
    decision: string;
    eligibilityReasons: string[];
  } | null;
  claims: EvidenceClaim[];
  /** Feature symbols the model may name. Anything else is a hallucination. */
  vocabulary: {
    features: string[];
    cellTypes: string[];
    regions: string[];
    pathways: string[];
    candidates: string[];
  };
  limitations: string[];
  missingEvidence: string[];
  uncertainty: {
    confidence: Confidence;
    rule: string;
    domainStatus: string;
    domainExplanation: string;
  };
  /** Set when the run cannot support an interpretation at all. */
  notInterpretable: string | null;
}

/** The response schema the model must produce, and the gate enforces. */
export interface InterpretationResponse {
  findings: { statement: string; citedClaims: string[] }[];
  mechanism: { statement: string; citedClaims: string[] }[];
  candidateComparison: { statement: string; citedClaims: string[] }[];
  limitations: string[];
  hypothesis: { statement: string; howToTest: string } | null;
  /** The model must be able to say it cannot interpret the run. */
  abstained: boolean;
  abstentionReason: string | null;
}

export const RESPONSE_SHAPE_DESCRIPTION = `{
  "findings":            [{ "statement": string, "citedClaims": string[] }],
  "mechanism":           [{ "statement": string, "citedClaims": string[] }],
  "candidateComparison": [{ "statement": string, "citedClaims": string[] }],
  "limitations":         string[],
  "hypothesis":          { "statement": string, "howToTest": string } | null,
  "abstained":           boolean,
  "abstentionReason":    string | null
}`;

export function emptyEvidence(runId: string): EvidenceObject {
  return {
    runId,
    generatedAt: new Date().toISOString(),
    dataset: {
      datasetId: '',
      organism: '',
      tissue: '',
      condition: '',
      assay: '',
      observations: 0,
      features: 0,
      provenanceNotice: null,
    },
    perturbation: null,
    claims: [],
    vocabulary: { features: [], cellTypes: [], regions: [], pathways: [], candidates: [] },
    limitations: [],
    missingEvidence: [],
    uncertainty: {
      confidence: 'not-interpretable',
      rule: '',
      domainStatus: 'out-of-domain',
      domainExplanation: '',
    },
    notInterpretable: null,
  };
}

/** Every number anywhere in the evidence, for the gate's numeric check. */
export function evidenceNumbers(evidence: EvidenceObject): number[] {
  const numbers: number[] = [
    evidence.dataset.observations,
    evidence.dataset.features,
  ];
  for (const claim of evidence.claims) {
    for (const value of claim.values) numbers.push(value.value);
  }
  return numbers.filter((value) => Number.isFinite(value));
}

export function claimIds(evidence: EvidenceObject): Set<string> {
  return new Set(evidence.claims.map((claim) => claim.id));
}
