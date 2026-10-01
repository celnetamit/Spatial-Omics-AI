/**
 * The frozen V1 workflow, as executable stages.
 *
 * §2 fixes the sequence and Appendix E forbids changing it, so the stage list
 * below is written once, in order, and the server's job runner walks it. A
 * stage cannot run before its inputs exist, and the state machine of §10.3 is
 * derived from which stages have completed rather than set by hand — a status
 * field that someone remembers to update is a status field that will be wrong.
 *
 * Each stage returns its outputs plus the method records that produced them, so
 * the reproducibility manifest is assembled as the run proceeds rather than
 * reconstructed at the end from whatever the report generator can still see.
 */

import type { MethodRecord, ReproducibilityManifest } from './core/provenance';
import { recordMethod } from './core/provenance';
import type { Confidence } from './core/labels';
import { weakestConfidence } from './core/labels';

export type StageId =
  | 'ingest'
  | 'qc'
  | 'preprocess'
  | 'annotate'
  | 'baseline'
  | 'spatial'
  | 'communication'
  | 'baseline-interpretation'
  | 'perturbation'
  | 'direct-response'
  | 'graph'
  | 'propagation'
  | 'adverse'
  | 'altered-tissue'
  | 'candidates'
  | 'rescue-simulations'
  | 'comparison'
  | 'uncertainty'
  | 'interpretation'
  | 'validation-plan'
  | 'report';

/** §2's step numbers, so a UI can show where a run is in the frozen workflow. */
export const STAGE_STEP: Record<StageId, string> = {
  ingest: '01',
  qc: '02',
  preprocess: '02',
  annotate: '03',
  baseline: '03',
  spatial: '03',
  communication: '03',
  'baseline-interpretation': '04',
  perturbation: '05 / 06',
  'direct-response': '07',
  graph: '08',
  propagation: '09 / 10',
  adverse: '12',
  'altered-tissue': '11',
  candidates: '13',
  'rescue-simulations': '14',
  comparison: '15',
  uncertainty: '12',
  interpretation: '16',
  'validation-plan': '16',
  report: '16',
};

export const STAGE_TITLE: Record<StageId, string> = {
  ingest: 'Ingest and canonicalise',
  qc: 'Quality control and eligibility',
  preprocess: 'Preprocess and harmonise',
  annotate: 'Annotate cells and regions',
  baseline: 'Baseline molecular and pathway analysis',
  spatial: 'Spatial neighbourhood analysis',
  communication: 'Cell-cell communication',
  'baseline-interpretation': 'Interpret the baseline',
  perturbation: 'Define the perturbation',
  'direct-response': 'Direct target-cell response',
  graph: 'Build the simulation graph',
  propagation: 'Spatial propagation',
  adverse: 'Adverse and off-target analysis',
  'altered-tissue': 'Assemble the predicted altered tissue',
  candidates: 'Retrieve rescue candidates',
  'rescue-simulations': 'Simulate each candidate',
  comparison: 'Compare candidates',
  uncertainty: 'Uncertainty and out-of-domain',
  interpretation: 'Final interpretation',
  'validation-plan': 'Validation experiment',
  report: 'Report and export',
};

/** Which stages must have completed before a stage may run. */
export const STAGE_DEPENDENCIES: Record<StageId, StageId[]> = {
  ingest: [],
  qc: ['ingest'],
  preprocess: ['qc'],
  annotate: ['preprocess'],
  baseline: ['annotate'],
  spatial: ['annotate'],
  communication: ['spatial'],
  'baseline-interpretation': ['baseline', 'spatial'],
  perturbation: ['baseline'],
  'direct-response': ['perturbation'],
  graph: ['spatial', 'perturbation'],
  propagation: ['direct-response', 'graph'],
  'altered-tissue': ['propagation'],
  adverse: ['altered-tissue'],
  uncertainty: ['propagation'],
  candidates: ['altered-tissue', 'adverse'],
  'rescue-simulations': ['candidates'],
  comparison: ['rescue-simulations'],
  interpretation: ['comparison', 'uncertainty'],
  'validation-plan': ['interpretation'],
  report: ['validation-plan'],
};

// ---------------------------------------------------------------------------
// State machine — §10.3
// ---------------------------------------------------------------------------

export type ProjectState =
  | 'DRAFT'
  | 'DATA_READY'
  | 'QC_COMPLETE'
  | 'BASELINE_COMPLETE'
  | 'EXPERIMENT_READY'
  | 'GRAPH_READY'
  | 'CONFIG_READY'
  | 'QUEUED'
  | 'RUNNING'
  | 'PREDICTED'
  | 'RESCUE_READY'
  | 'RESCUE_RUNNING'
  | 'COMPLETE';

export type SideState = 'WARNING' | 'PARTIAL' | 'CANCELLED' | 'ERROR' | 'NOT_INTERPRETABLE';

export const PROJECT_STATE_ORDER: ProjectState[] = [
  'DRAFT', 'DATA_READY', 'QC_COMPLETE', 'BASELINE_COMPLETE', 'EXPERIMENT_READY',
  'GRAPH_READY', 'CONFIG_READY', 'QUEUED', 'RUNNING', 'PREDICTED',
  'RESCUE_READY', 'RESCUE_RUNNING', 'COMPLETE',
];

/**
 * The state derived from which stages have completed.
 *
 * Derived rather than stored, so it cannot disagree with the artefacts. A
 * project whose status says COMPLETE and whose comparison is missing is a bug
 * that only shows up when someone opens the report.
 */
export function deriveState(completed: Set<StageId>, failed: Set<StageId>): {
  state: ProjectState;
  side: SideState[];
} {
  const side: SideState[] = [];
  if (failed.size > 0) side.push('ERROR');

  let state: ProjectState = 'DRAFT';
  if (completed.has('ingest')) state = 'DATA_READY';
  if (completed.has('qc')) state = 'QC_COMPLETE';
  if (completed.has('baseline') && completed.has('spatial')) state = 'BASELINE_COMPLETE';
  if (completed.has('perturbation')) state = 'EXPERIMENT_READY';
  if (completed.has('graph')) state = 'GRAPH_READY';
  if (completed.has('direct-response')) state = 'CONFIG_READY';
  if (completed.has('propagation')) state = 'PREDICTED';
  if (completed.has('candidates')) state = 'RESCUE_READY';
  if (completed.has('rescue-simulations')) state = 'RESCUE_RUNNING';
  if (completed.has('report')) state = 'COMPLETE';

  return { state, side };
}

export function stageIsRunnable(stage: StageId, completed: Set<StageId>): { runnable: boolean; missing: StageId[] } {
  const missing = (STAGE_DEPENDENCIES[stage] ?? []).filter((dependency) => !completed.has(dependency));
  return { runnable: missing.length === 0, missing };
}

// ---------------------------------------------------------------------------
// Run context
// ---------------------------------------------------------------------------

export interface StageOutcome<T> {
  stage: StageId;
  status: 'ok' | 'warning' | 'blocked' | 'error';
  result: T | null;
  methods: MethodRecord[];
  warnings: string[];
  /** Set when the stage could not produce an interpretable result. */
  notInterpretable: string | null;
  confidence: Confidence;
  milliseconds: number;
}

export function outcome<T>(
  stage: StageId,
  result: T | null,
  parts: Partial<Omit<StageOutcome<T>, 'stage' | 'result'>> = {},
): StageOutcome<T> {
  return {
    stage,
    status: parts.status ?? (result === null ? 'blocked' : 'ok'),
    result,
    methods: parts.methods ?? [],
    warnings: parts.warnings ?? [],
    notInterpretable: parts.notInterpretable ?? null,
    confidence: parts.confidence ?? 'high',
    milliseconds: parts.milliseconds ?? 0,
  };
}

/** Folds a stage outcome into the run's manifest. */
export function absorb(manifest: ReproducibilityManifest, result: StageOutcome<unknown>): void {
  for (const method of result.methods) recordMethod(manifest, method);
  for (const warning of result.warnings) {
    if (!manifest.warnings.includes(warning)) manifest.warnings.push(warning);
  }
  manifest.timings.push({ stage: result.stage, milliseconds: result.milliseconds });
  manifest.confidence = weakestConfidence(manifest.confidence as Confidence, result.confidence);
}

/** Times a stage and packages whatever it returns or throws. */
export async function runStage<T>(
  stage: StageId,
  work: () => Promise<StageOutcome<T>> | StageOutcome<T>,
): Promise<StageOutcome<T>> {
  const started = Date.now();
  try {
    const result = await work();
    return { ...result, milliseconds: Date.now() - started };
  } catch (error) {
    return {
      stage,
      status: 'error',
      result: null,
      methods: [],
      warnings: [],
      notInterpretable: `${STAGE_TITLE[stage]} failed: ${error instanceof Error ? error.message : String(error)}`,
      confidence: 'not-interpretable',
      milliseconds: Date.now() - started,
    };
  }
}

/** §10.2's scientific error classes. */
export type ScientificErrorCode =
  | 'INVALID_INPUT'
  | 'MISSING_METADATA'
  | 'QC_FAILED'
  | 'REFERENCE_NOT_COMPARABLE'
  | 'UNSUPPORTED_PERTURBATION'
  | 'UNSUPPORTED_DOSE_OR_TIME'
  | 'INELIGIBLE_MODEL'
  | 'INVALID_GRAPH'
  | 'OUT_OF_DOMAIN'
  | 'EVIDENCE_UNAVAILABLE'
  | 'QUOTA_EXCEEDED'
  | 'CANCELLED'
  | 'PARTIAL_RUN'
  | 'INTERNAL';

export const ERROR_IS_RECOVERABLE: Record<ScientificErrorCode, boolean> = {
  INVALID_INPUT: true,
  MISSING_METADATA: true,
  QC_FAILED: true,
  REFERENCE_NOT_COMPARABLE: true,
  UNSUPPORTED_PERTURBATION: true,
  UNSUPPORTED_DOSE_OR_TIME: true,
  INELIGIBLE_MODEL: true,
  INVALID_GRAPH: true,
  OUT_OF_DOMAIN: false,
  EVIDENCE_UNAVAILABLE: true,
  QUOTA_EXCEEDED: true,
  CANCELLED: true,
  PARTIAL_RUN: true,
  INTERNAL: false,
};

export const ERROR_SUGGESTION: Record<ScientificErrorCode, string> = {
  INVALID_INPUT: 'Check the file against the schema in Appendix B and upload it again.',
  MISSING_METADATA: 'Supply the missing dataset metadata; prediction stays blocked until it is present.',
  QC_FAILED: 'Review the QC dashboard. A critical failure blocks prediction but baseline analysis may still be available.',
  REFERENCE_NOT_COMPARABLE: 'Choose a reference with the same assay, resolution and feature namespace, or run without one.',
  UNSUPPORTED_PERTURBATION: 'Choose a target and operator the selected model pack supports.',
  UNSUPPORTED_DOSE_OR_TIME: 'Choose a value inside the evidence-supported range, or mark the run explicitly exploratory.',
  INELIGIBLE_MODEL: 'Select a model pack whose feature schema this dataset satisfies.',
  INVALID_GRAPH: 'Adjust the graph parameters; the current settings leave the tissue disconnected or degenerate.',
  OUT_OF_DOMAIN: 'The run is outside the model’s validated domain. Results are not interpretable and are withheld rather than shown with a caveat.',
  EVIDENCE_UNAVAILABLE: 'The evidence pack does not cover this target or compound. Retrieval is from a frozen snapshot, not a live query.',
  QUOTA_EXCEEDED: 'Wait for running jobs to finish, or ask an administrator to raise the project quota.',
  CANCELLED: 'The run was cancelled. Partial results up to the cancelled stage are kept.',
  PARTIAL_RUN: 'Some stages did not complete. The report will say which, and the missing outputs are absent rather than estimated.',
  INTERNAL: 'This is a defect. The correlation id in this message identifies the run in the server log.',
};
