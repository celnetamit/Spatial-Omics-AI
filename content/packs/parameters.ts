/**
 * The parameter registry — §5 and Appendix A.
 *
 * §5's rule is the one this file exists to make checkable: "The platform must
 * not use arbitrary universal biological defaults. Every biological numeric
 * parameter must be evidence-derived, calibrated, data-derived, or explicitly
 * exploratory. Engineering guardrails may have defaults, but they must be
 * distinguished from biological evidence."
 *
 * So every entry carries a `kind`, and the UI renders the two differently: a
 * `guardrail` is a deployment decision and a learner can be told it is one, a
 * `biological` parameter without a source is a bug that this file's own
 * validator refuses. `defaultValue: null` is a legitimate and common answer —
 * it means the platform has no universal default and one must come from the
 * data or the pack, which is the honest state for a drug concentration.
 */

export type ParameterKind =
  /** A biological quantity. Must have a source or be marked exploratory. */
  | 'biological'
  /** An engineering limit or a performance knob. Not a scientific claim. */
  | 'guardrail'
  /** A method choice, e.g. which statistical test. */
  | 'method'
  /** A reproducibility control, e.g. the seed. */
  | 'reproducibility';

export type EditableBy = 'system' | 'beginner' | 'moderate' | 'expert';

export type ParameterConfidence = 'high' | 'moderate' | 'exploratory' | 'not-interpretable';

export interface ParameterRecord {
  parameterId: string;
  name: string;
  /** Mathematical symbol where the handbook gives one. */
  symbol: string | null;
  unit: string | null;
  kind: ParameterKind;
  /** null means there is no universal default — §5.2 says so for C and t. */
  defaultValue: number | string | null;
  /** How a valid value is decided, in words a reader can check. */
  rangeRule: string;
  /** DOI, PMID, database record, dataset or model pack. Required if biological. */
  source: string | null;
  /** Organism, tissue, cell type, assay, drug, time — whichever apply. */
  context: string;
  editableBy: EditableBy;
  confidence: ParameterConfidence;
  version: string;
  approvedBy: string;
  approvedAt: string;
  /** Which subsystem reads it, per Appendix A. */
  subsystem: string;
  notes?: string;
}

const APPROVER = 'Spatial Omics AI Virtual LiveLab V1 implementation';
const APPROVED_AT = '2026-09-22';

export const PARAMETER_REGISTRY: ParameterRecord[] = [
  // -- §5.2 core parameters -----------------------------------------------
  {
    parameterId: 'drug.concentration',
    name: 'Drug concentration',
    symbol: 'C',
    unit: 'nM / µM / mM',
    kind: 'biological',
    defaultValue: null,
    rangeRule:
      'The 10th to 90th percentile of the potency measurements retrieved for this compound and target from ChEMBL. ' +
      'Outside it the Hill model is disabled rather than extrapolated (§5.3).',
    source: 'Per-compound, from the frozen ChEMBL snapshot in content/packs/drug-evidence.',
    context: 'Compound and target specific; the assay context is stored with each record.',
    editableBy: 'moderate',
    confidence: 'moderate',
    version: '1.0.0',
    approvedBy: APPROVER,
    approvedAt: APPROVED_AT,
    subsystem: 'Drug direct model',
    notes: 'There is no universal default. §5.2 says so, and a pre-filled concentration would be read as a recommendation.',
  },
  {
    parameterId: 'drug.exposure-time',
    name: 'Exposure time',
    symbol: 't',
    unit: 'min / h / day',
    kind: 'biological',
    defaultValue: null,
    rangeRule: 'Supported experimental or model interval. Absent a validated time model, the effect is reported at plateau and t does not scale it.',
    source: null,
    context: 'No time-response model ships with V1 for any compound.',
    editableBy: 'moderate',
    confidence: 'exploratory',
    version: '1.0.0',
    approvedBy: APPROVER,
    approvedAt: APPROVED_AT,
    subsystem: 'Drug direct model',
    notes:
      'Recorded on every run and shown in the report, but it does not enter the calculation. ' +
      'Fitting a first-order rate constant with no kinetic data would be inventing kinetics, which §7.3 warns against by name.',
  },
  {
    parameterId: 'drug.target-availability',
    name: 'Target availability',
    symbol: 'A_i',
    unit: 'fraction of the section maximum',
    kind: 'biological',
    defaultValue: null,
    rangeRule: 'Data-derived: the target’s baseline activity in each cell, normalised to the highest in the section.',
    source: 'The dataset under analysis.',
    context: 'Per cell, per run.',
    editableBy: 'system',
    confidence: 'high',
    version: '1.0.0',
    approvedBy: APPROVER,
    approvedAt: APPROVED_AT,
    subsystem: 'Drug direct model',
  },
  {
    parameterId: 'drug.cell-sensitivity',
    name: 'Cell-context sensitivity',
    symbol: 'S_i',
    unit: 'dimensionless',
    kind: 'biological',
    defaultValue: 1,
    rangeRule: 'Fixed at 1 in V1. No calibrated per-cell-type sensitivity model ships with this build.',
    source: null,
    context: 'Every cell type.',
    editableBy: 'system',
    confidence: 'exploratory',
    version: '1.0.0',
    approvedBy: APPROVER,
    approvedAt: APPROVED_AT,
    subsystem: 'Drug direct model',
    notes:
      'A constant of 1 is visible in the term breakdown, which is the point: a fitted-looking number would be indistinguishable in the output from an evidence-derived one. Cell-to-cell variation in the direct effect comes entirely from A_i.',
  },
  {
    parameterId: 'drug.evidence-modifier',
    name: 'Evidence / context modifier',
    symbol: 'W_e',
    unit: 'dimensionless',
    kind: 'biological',
    defaultValue: null,
    rangeRule:
      '1.0 for direct matched experimental evidence, 0.8 for near-context, 0.7 for a curated database record or model-derived value, 0.5 for an exploratory scenario (§8.1).',
    source: '§8.1 evidence hierarchy.',
    context: 'Set by the evidence class of the dose-response parameters actually used.',
    editableBy: 'system',
    confidence: 'moderate',
    version: '1.0.0',
    approvedBy: APPROVER,
    approvedAt: APPROVED_AT,
    subsystem: 'Drug direct model',
    notes: 'A real multiplier, not a badge: a parameter transferred from another context produces a smaller predicted effect, not the same effect with a caption.',
  },
  {
    parameterId: 'graph.knn-k',
    name: 'kNN neighbours',
    symbol: 'k',
    unit: 'integer',
    kind: 'guardrail',
    defaultValue: 6,
    rangeRule: 'Engineering range 3–30. The scientific choice is benchmarked per model pack.',
    source: '§5.2 records 6 as a benchmark starting value for single-cell GNNs.',
    context: 'Single-cell resolution data.',
    editableBy: 'expert',
    confidence: 'moderate',
    version: '1.0.0',
    approvedBy: APPROVER,
    approvedAt: APPROVED_AT,
    subsystem: 'Spatial graph',
    notes: 'k = 6 is a benchmark default, not a biological truth. The shipped model pack was trained at this value and changing it moves the run off the pack’s training distribution.',
  },
  {
    parameterId: 'graph.grid-neighbours',
    name: 'Grid neighbours',
    symbol: 'n_neigh',
    unit: 'integer',
    kind: 'guardrail',
    defaultValue: 6,
    rangeRule: 'Platform geometry: 6 for a hexagonal lattice, 4 or 8 for a square one.',
    source: '§5.2; Squidpy grid conventions.',
    context: 'Spot-resolution platforms with a regular lattice.',
    editableBy: 'expert',
    confidence: 'high',
    version: '1.0.0',
    approvedBy: APPROVER,
    approvedAt: APPROVED_AT,
    subsystem: 'Spatial graph',
  },
  {
    parameterId: 'graph.radius',
    name: 'Spatial radius',
    symbol: 'r',
    unit: 'coordinate unit (µm or px)',
    kind: 'biological',
    defaultValue: null,
    rangeRule: 'Data-derived: twice the median nearest-neighbour distance of this section, unless set explicitly.',
    source: 'The dataset under analysis.',
    context: 'Per dataset; depends on the coordinate unit and the platform.',
    editableBy: 'expert',
    confidence: 'moderate',
    version: '1.0.0',
    approvedBy: APPROVER,
    approvedAt: APPROVED_AT,
    subsystem: 'Spatial graph',
    notes: '§5.2: there is no universal fixed radius. A value in pixels and the same value in micrometres describe different neighbourhoods.',
  },
  {
    parameterId: 'communication.permutations',
    name: 'Communication permutations',
    symbol: 'n_perm',
    unit: 'integer',
    kind: 'method',
    defaultValue: 1000,
    rangeRule: '>= 1000 for a final analysis; fewer only for a preview, and the result says so.',
    source: '§5.2 and §6.7.',
    context: 'All permutation-based spatial statistics.',
    editableBy: 'expert',
    confidence: 'high',
    version: '1.0.0',
    approvedBy: APPROVER,
    approvedAt: APPROVED_AT,
    subsystem: 'Spatial analysis',
    notes: 'The smallest reportable p-value is 1/(n_perm + 1); at 1000 that is 9.99e-4, and the +1 correction is applied so a test never reports p = 0.',
  },
  {
    parameterId: 'propagation.stages',
    name: 'Propagation stages',
    symbol: 'k_stage',
    unit: 'stage',
    kind: 'method',
    defaultValue: 5,
    rangeRule: 'The validated stage depth of the model pack. The shipped pack was trained on 5 stages.',
    source: 'content/packs/propagation-model/model-card.json',
    context: 'Model-pack specific.',
    editableBy: 'expert',
    confidence: 'moderate',
    version: '1.0.0',
    approvedBy: APPROVER,
    approvedAt: APPROVED_AT,
    subsystem: 'GNN / predictive model',
    notes: '§7.8: a stage counts a round of intercellular signalling in the model. It must not be translated into hours or days; nothing here is calibrated on biological time.',
  },
  {
    parameterId: 'run.seed',
    name: 'Random seed',
    symbol: 'seed',
    unit: 'integer',
    kind: 'reproducibility',
    defaultValue: 20260821,
    rangeRule: 'Any 32-bit integer. Frozen per run and stored in the manifest.',
    source: '§16.1.',
    context: 'Every stochastic step draws from a named stream derived from it.',
    editableBy: 'expert',
    confidence: 'high',
    version: '1.0.0',
    approvedBy: APPROVER,
    approvedAt: APPROVED_AT,
    subsystem: 'All',
  },
  {
    parameterId: 'ranking.weights',
    name: 'Rescue score weights',
    symbol: 'w_j',
    unit: 'dimensionless',
    kind: 'method',
    defaultValue: null,
    rangeRule: 'Versioned and reviewer-approved. Absent, no composite score is produced and the comparison is Pareto-based.',
    source: null,
    context: 'No approved weight set ships with V1.',
    editableBy: 'system',
    confidence: 'not-interpretable',
    version: '1.0.0',
    approvedBy: APPROVER,
    approvedAt: APPROVED_AT,
    subsystem: 'Recovery / rescue',
    notes:
      '§6.19 permits a composite score only when weights are frozen, justified and benchmarked. None are, so the lab shows component metrics and a Pareto front and states that there is no single ranking.',
  },

  // -- preprocessing --------------------------------------------------------
  {
    parameterId: 'preprocess.target-sum',
    name: 'Normalisation target sum',
    symbol: null,
    unit: 'counts',
    kind: 'method',
    defaultValue: 10000,
    rangeRule: 'Any positive value; 1e4 is the scanpy convention and changing it rescales every value by a constant.',
    source: 'Wolf FA, Angerer P, Theis FJ. SCANPY. Genome Biology 2018;19:15. doi:10.1186/s13059-017-1382-0',
    context: 'Transcriptomic counts only. Proteomic markers are arcsinh transformed instead.',
    editableBy: 'expert',
    confidence: 'high',
    version: '1.0.0',
    approvedBy: APPROVER,
    approvedAt: APPROVED_AT,
    subsystem: 'Preprocessing',
  },
  {
    parameterId: 'preprocess.arcsinh-cofactor',
    name: 'Proteomic arcsinh cofactor',
    symbol: null,
    unit: 'counts',
    kind: 'method',
    defaultValue: 5,
    rangeRule: 'Panel dependent; 5 is the cytometry convention. Higher values compress the low end further.',
    source: 'Standard practice in mass and flow cytometry transformation.',
    context: 'Antibody-derived abundance only.',
    editableBy: 'expert',
    confidence: 'moderate',
    version: '1.0.0',
    approvedBy: APPROVER,
    approvedAt: APPROVED_AT,
    subsystem: 'Preprocessing',
    notes: 'Protein abundance is not a sampled library, so scaling it to a common total would remove real differences in abundance.',
  },
  {
    parameterId: 'qc.mad-multiplier',
    name: 'QC outlier MAD multiplier',
    symbol: null,
    unit: 'MAD',
    kind: 'guardrail',
    defaultValue: 5,
    rangeRule: 'Applied to median(log1p counts) ± k × MAD of the dataset itself.',
    source: 'Data-driven; §6.3 forbids a universal hard-coded biological QC threshold across tissues.',
    context: 'Every dataset, computed from its own distribution.',
    editableBy: 'expert',
    confidence: 'high',
    version: '1.0.0',
    approvedBy: APPROVER,
    approvedAt: APPROVED_AT,
    subsystem: 'Ingestion / QC',
    notes: 'The multiplier is a guardrail; the threshold it produces is data-derived. A Visium spot and a Xenium cell differ by two orders of magnitude in counts, so a fixed cut-off could only be right for one of them.',
  },

  // -- AI -------------------------------------------------------------------
  {
    parameterId: 'ai.temperature',
    name: 'Interpretation model temperature',
    symbol: null,
    unit: 'dimensionless',
    kind: 'guardrail',
    defaultValue: 0.2,
    rangeRule: 'Implementation detail. §6.21 states explicitly that it does not change scientific results.',
    source: null,
    context: 'The narrative layer only. No numeric output passes through the model.',
    editableBy: 'system',
    confidence: 'high',
    version: '1.0.0',
    approvedBy: APPROVER,
    approvedAt: APPROVED_AT,
    subsystem: 'AI',
  },
];

/**
 * The validator §5 implies but does not spell out.
 *
 * A biological parameter with a non-null default and no source is the exact
 * failure §5 opens with, so it is an error rather than a warning. This runs at
 * server startup and a failure is logged loudly — the registry is small enough
 * that a broken entry should never reach a deployment.
 */
export function validateRegistry(records: ParameterRecord[] = PARAMETER_REGISTRY): {
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  for (const record of records) {
    if (seen.has(record.parameterId)) errors.push(`Duplicate parameter_id: ${record.parameterId}`);
    seen.add(record.parameterId);

    if (record.kind === 'biological' && record.defaultValue !== null && record.source === null) {
      if (record.confidence !== 'exploratory') {
        errors.push(
          `${record.parameterId} is biological with a default of ${record.defaultValue} and no source. ` +
            '§5 requires evidence-derived, calibrated, data-derived or explicitly exploratory.',
        );
      } else {
        warnings.push(`${record.parameterId} has a default with no source and is marked exploratory.`);
      }
    }
    if (!record.rangeRule || record.rangeRule.trim() === '') {
      errors.push(`${record.parameterId} has no range rule.`);
    }
    if (!record.context || record.context.trim() === '') {
      errors.push(`${record.parameterId} has no context.`);
    }
  }
  return { errors, warnings };
}

export function parameterById(id: string): ParameterRecord | undefined {
  return PARAMETER_REGISTRY.find((record) => record.parameterId === id);
}

export function parametersFor(subsystem: string): ParameterRecord[] {
  return PARAMETER_REGISTRY.filter((record) => record.subsystem === subsystem);
}

export const REGISTRY_VERSION = '1.0.0';
