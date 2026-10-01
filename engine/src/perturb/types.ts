/**
 * Perturbation definitions — §4.4, §4.5 and §6.10.
 *
 * Two branches that converge. A `PerturbationDefinition` is immutable once
 * created (§6.11) and carries everything needed to reproduce the direct
 * response: the target, the operator or the dose, the exact cell selection, the
 * parameter values with their provenance, and the eligibility decision that let
 * it be created at all.
 *
 * The eligibility decision is stored rather than recomputed. §5.4 requires that
 * parameters cannot change silently after a run begins, and a decision
 * recomputed at read time against a newer evidence pack is a decision that has
 * changed silently.
 */

import type { Confidence, EvidenceClass } from '../core/labels';

export type PerturbationBranch = 'molecular-genetic' | 'drug';

export type MolecularOperator =
  | 'knockout'
  | 'inhibition'
  | 'activation'
  | 'overexpression'
  | 'mutation-gain-of-function'
  | 'mutation-loss-of-function';

export const OPERATOR_LABEL: Record<MolecularOperator, string> = {
  knockout: 'Knockout',
  inhibition: 'Inhibition',
  activation: 'Activation',
  overexpression: 'Overexpression',
  'mutation-gain-of-function': 'Gain-of-function mutation',
  'mutation-loss-of-function': 'Loss-of-function mutation',
};

/** What each operator does to the model, said in the terms the model uses. */
export const OPERATOR_SEMANTICS: Record<MolecularOperator, string> = {
  knockout:
    'The target node is held at zero activity for the whole simulation. Everything downstream of it responds; the node itself cannot.',
  inhibition:
    'The target’s achievable activity is scaled down by the stated fraction. Unlike a knockout it can still be driven, just less far.',
  activation:
    'A constant positive drive is added to the target, so it sits higher than its regulators alone would put it.',
  overexpression:
    'The target’s ceiling is raised above its cell-type capacity and a positive drive is applied, standing for a transgene that ignores endogenous control.',
  'mutation-gain-of-function':
    'The target is held at a high constant activity, independent of its upstream regulators — the model form a constitutively active allele takes.',
  'mutation-loss-of-function':
    'The target retains its expression but its outgoing edges are scaled down, standing for a protein that is made but does not signal.',
};

/** How the target population was chosen. */
export type SelectionMode = 'cell-type' | 'region' | 'explicit' | 'whole-tissue' | 'radius';

export interface TargetSelection {
  mode: SelectionMode;
  /** Cell types or regions named, when the mode is one of those. */
  classes?: string[];
  /** Explicit observation ids. Stored exactly, per §4.4. */
  observationIds?: string[];
  /** Centre and radius, for a spatial selection. */
  centre?: { x: number; y: number };
  radius?: number;
  /** Resolved indices, frozen at definition time. */
  resolvedIndices: number[];
  /** A sentence describing what was selected, for the report. */
  description: string;
}

export interface MolecularPerturbation {
  branch: 'molecular-genetic';
  /** Feature symbol or pathway id. */
  target: string;
  targetKind: 'gene' | 'protein' | 'pathway';
  operator: MolecularOperator;
  /**
   * Operator magnitude, in the model's own semantics.
   *
   * Knockout ignores it. Inhibition reads it as the surviving fraction.
   * Activation and overexpression read it as an additive drive in logits.
   * §4.4 forbids arbitrary universal fold-change defaults, so this comes from
   * the model pack or is marked exploratory.
   */
  magnitude: number;
  magnitudeSource: 'model-pack' | 'user-exploratory';
  stage: string;
}

export interface DrugPerturbation {
  branch: 'drug';
  drugId: string;
  drugName: string;
  /** Primary target symbol in the model's feature space. */
  target: string;
  /** Inhibitor, agonist, and so on. */
  actionType: 'inhibitor' | 'agonist' | 'antagonist' | 'degrader' | 'other';
  /** Secondary targets that carry evidence, used for off-target analysis. */
  secondaryTargets: { symbol: string; potencyNm: number | null; source: string }[];
  concentration: number;
  concentrationUnit: 'nM' | 'uM' | 'mM';
  exposureTime: number;
  exposureTimeUnit: 'min' | 'h' | 'day';
  /** The dose-response parameters actually used, with provenance. */
  doseResponse: DoseResponseParameters;
  /** Time-response rate, where one is justified. */
  timeResponse: TimeResponseParameters | null;
  /** The evidence snapshot this run was parameterised from. */
  evidenceSnapshotId: string;
}

export interface DoseResponseParameters {
  /** Maximal effect, as a fraction of the target's activity. */
  emax: number;
  /** Half-maximal concentration in nM. */
  ec50Nm: number;
  /** Hill coefficient. */
  hill: number;
  source: string;
  evidenceClass: EvidenceClass;
  /** Assay context, so a transfer warning can be raised against it. */
  context: {
    organism: string;
    tissueOrCellLine: string;
    assay: string;
    /** Concentration range the source assay covered, in nM. */
    testedRangeNm: [number, number] | null;
  };
  /** Set when the requested context differs from the evidence context. */
  transferWarning: string | null;
}

export interface TimeResponseParameters {
  /** First-order rate in inverse hours. */
  ratePerHour: number;
  source: string;
  evidenceClass: EvidenceClass;
  /** Interval the source covered, in hours. */
  supportedIntervalHours: [number, number] | null;
}

export type PerturbationSpec = MolecularPerturbation | DrugPerturbation;

export type EligibilityDecision = 'quantitative' | 'exploratory' | 'blocked';

export interface PerturbationEligibility {
  decision: EligibilityDecision;
  /** Every reason, not just the first — a form should show all of them. */
  reasons: string[];
  /** What would make it quantitative, where that is knowable. */
  remedies: string[];
  confidence: Confidence;
}

export interface PerturbationDefinition {
  id: string;
  createdAt: string;
  branch: PerturbationBranch;
  spec: PerturbationSpec;
  selection: TargetSelection;
  eligibility: PerturbationEligibility;
  /** Hash of the definition, so a run can prove which one it used. */
  checksum: string;
  /** Model pack this was validated against. */
  modelPackId: string;
  modelPackVersion: string;
}
