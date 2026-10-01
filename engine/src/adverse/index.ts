/**
 * Microenvironment, adverse and off-target analysis — §6.15.
 *
 * The requirement §6.15 opens with is the one that shapes this module:
 * "identify supported undesirable or non-target tissue effects **without mixing
 * them into therapeutic benefit**". So adverse burden is computed here, stored
 * in its own object, and never enters a benefit term. §6.15's validation line
 * says the same thing from the other side — "ensure high rescue cannot hide
 * adverse burden" — and the comparison module in `rescue/` keeps them as
 * separate axes for exactly that reason.
 *
 * The wording is also constrained. §6.15 forbids labelling clinical toxicity
 * from tissue signatures, so every string this module produces says "predicted
 * adverse tissue signature". That is not squeamishness: a stress signature in a
 * simulated section is not an adverse event in a patient, and a UI that says
 * "toxicity" has made a claim the pipeline cannot support.
 */

import { mean } from '../core/stats';
import type { CompiledNetwork } from '../propagate/network';
import type { TissueState } from '../propagate/mechanism';

/** A signature whose increase is undesirable, with where it came from. */
export interface AdverseSignature {
  id: string;
  name: string;
  /** Node symbols and signed weights. */
  members: Record<string, number>;
  /** What kind of undesirable effect this stands for. */
  category: 'stress' | 'inflammation' | 'cell-death' | 'fibrosis' | 'immune-evasion' | 'proliferation';
  source: string;
  /** One sentence on what a rise in it would mean, and what it would not. */
  interpretation: string;
}

/** An evidence-supported secondary target of a drug. */
export interface OffTargetRecord {
  symbol: string;
  /** Potency against the secondary target, in nM. */
  potencyNm: number | null;
  /** Potency against the primary, for the selectivity ratio. */
  primaryPotencyNm: number | null;
  source: string;
  actionType: string;
}

export interface AdverseComponent {
  signatureId: string;
  name: string;
  category: AdverseSignature['category'];
  /** Per-observation change in the signature. */
  delta: Float64Array;
  /** Mean change across the section. */
  meanDelta: number;
  /** Mean change restricted to cells the perturbation did not target. */
  nonTargetMeanDelta: number;
  /** Fraction of observations whose signature rose beyond the noise floor. */
  affectedFraction: number;
  /** Per-class breakdown, so a non-target compartment is visible. */
  byClass: { className: string; meanDelta: number; count: number }[];
  interpretation: string;
  source: string;
}

export interface AdverseResult {
  components: AdverseComponent[];
  /** Off-target engagement predicted from evidence, per secondary target. */
  offTargets: OffTargetEngagement[];
  /**
   * A single burden figure, for the comparison axis.
   *
   * The mean of the positive components only: a signature that went *down* is
   * not an adverse effect, and averaging it in would let a drug cancel its own
   * stress response against someone else's.
   */
  burden: number;
  /** Cells whose total adverse change is in the top decile. */
  hotspots: number[];
  warnings: string[];
  method: string;
  /** Present when the run could not compute an adverse result at all. */
  notInterpretable: string | null;
}

export interface OffTargetEngagement {
  symbol: string;
  /** Fraction of the secondary target engaged at the run's concentration. */
  engagement: number;
  /** Ratio of secondary to primary potency; higher is more selective. */
  selectivityFold: number | null;
  /** Whether the secondary target is measured in this dataset at all. */
  measured: boolean;
  source: string;
  note: string;
}

export interface AdverseInput {
  baseline: TissueState;
  predicted: TissueState;
  network: CompiledNetwork;
  signatures: AdverseSignature[];
  /** Per-observation class, for the non-target breakdown. */
  labels: (string | undefined)[];
  /** Observations the perturbation was applied to. */
  targetedIndices: Set<number>;
  /** Secondary targets with evidence, from the drug snapshot. */
  offTargets: OffTargetRecord[];
  /** Run concentration in nM, for the engagement calculation. */
  concentrationNm: number | null;
  /** Noise floor: changes smaller than this are not counted as affected. */
  noiseFloor?: number;
}

export function analyseAdverse(input: AdverseInput): AdverseResult {
  const warnings: string[] = [];
  const noiseFloor = input.noiseFloor ?? 0.01;
  const n = input.baseline.observationCount;
  const k = input.baseline.nodeCount;

  const components: AdverseComponent[] = [];
  const totalPositive = new Float64Array(n);

  for (const signature of input.signatures) {
    const columns: number[] = [];
    const weights: number[] = [];
    const missing: string[] = [];
    for (const [symbol, weight] of Object.entries(signature.members)) {
      const node = input.network.index.get(symbol);
      if (node === undefined) missing.push(symbol);
      else {
        columns.push(node);
        weights.push(weight);
      }
    }
    if (columns.length === 0) {
      warnings.push(`Signature ${signature.id} has no members in the model's feature space and was skipped.`);
      continue;
    }
    if (missing.length > 0) {
      warnings.push(`Signature ${signature.id}: ${missing.join(', ')} not in the feature space; scored on the remaining ${columns.length}.`);
    }

    let weightTotal = 0;
    for (const weight of weights) weightTotal += Math.abs(weight);

    const delta = new Float64Array(n);
    let affected = 0;
    for (let i = 0; i < n; i += 1) {
      let total = 0;
      for (let c = 0; c < columns.length; c += 1) {
        const node = columns[c] as number;
        total +=
          (weights[c] as number) *
          ((input.predicted.activity[i * k + node] as number) - (input.baseline.activity[i * k + node] as number));
      }
      const value = weightTotal > 0 ? total / weightTotal : 0;
      delta[i] = value;
      if (value > noiseFloor) affected += 1;
      if (value > 0) totalPositive[i] = (totalPositive[i] as number) + value;
    }

    const nonTarget: number[] = [];
    for (let i = 0; i < n; i += 1) if (!input.targetedIndices.has(i)) nonTarget.push(delta[i] as number);

    const byClassMap = new Map<string, number[]>();
    for (let i = 0; i < n; i += 1) {
      const className = input.labels[i];
      if (!className) continue;
      const list = byClassMap.get(className) ?? [];
      list.push(delta[i] as number);
      byClassMap.set(className, list);
    }

    components.push({
      signatureId: signature.id,
      name: signature.name,
      category: signature.category,
      delta,
      meanDelta: mean(delta),
      nonTargetMeanDelta: nonTarget.length > 0 ? mean(nonTarget) : Number.NaN,
      affectedFraction: n > 0 ? affected / n : 0,
      byClass: [...byClassMap.entries()]
        .map(([className, values]) => ({ className, meanDelta: mean(values), count: values.length }))
        .sort((a, b) => b.meanDelta - a.meanDelta),
      interpretation: signature.interpretation,
      source: signature.source,
    });
  }

  // Hotspots: the top decile of total positive adverse change.
  const sorted = Float64Array.from(totalPositive).sort();
  const threshold = sorted.length > 0 ? (sorted[Math.floor(sorted.length * 0.9)] as number) : 0;
  const hotspots: number[] = [];
  for (let i = 0; i < n; i += 1) {
    if (threshold > noiseFloor && (totalPositive[i] as number) >= threshold) hotspots.push(i);
  }

  const offTargets = input.offTargets.map((record) =>
    engagementOf(record, input.concentrationNm, input.network),
  );

  const positives = components.map((c) => c.meanDelta).filter((value) => value > 0);
  const burden = positives.length > 0 ? mean(positives) : 0;

  return {
    components,
    offTargets,
    burden,
    hotspots,
    warnings,
    method: 'adverse.signature-delta+evidence-off-target',
    notInterpretable:
      components.length === 0
        ? 'No adverse signature could be scored against this feature space, so no adverse result is reported. An empty adverse panel is not the same as a clean one, and this run cannot tell you which it is.'
        : null,
  };
}

/**
 * Off-target engagement from a potency and a concentration.
 *
 * A one-site binding curve, occupancy = C / (C + Kd), with the measured
 * potency standing in for Kd. That is a simplification and it is stated in the
 * note the panel shows rather than buried here: a compound can be a partial
 * agonist, its cellular potency can differ from its biochemical one, and none
 * of that is modelled.
 *
 * When there is no measured potency the engagement is NaN, not zero. "No
 * evidence of off-target activity" and "no off-target activity" are different
 * findings and a panel that shows 0% for both is asserting the stronger one.
 */
function engagementOf(
  record: OffTargetRecord,
  concentrationNm: number | null,
  network: CompiledNetwork,
): OffTargetEngagement {
  const measured = network.index.get(record.symbol) !== undefined;

  if (record.potencyNm === null || concentrationNm === null) {
    return {
      symbol: record.symbol,
      engagement: Number.NaN,
      selectivityFold: null,
      measured,
      source: record.source,
      note:
        record.potencyNm === null
          ? 'No measured potency against this secondary target, so engagement cannot be estimated. The interaction is recorded as known, not as quantified.'
          : 'No concentration was set for this run, so engagement cannot be estimated.',
    };
  }

  const engagement = concentrationNm / (concentrationNm + record.potencyNm);
  const selectivityFold =
    record.primaryPotencyNm !== null && record.primaryPotencyNm > 0
      ? record.potencyNm / record.primaryPotencyNm
      : null;

  return {
    symbol: record.symbol,
    engagement,
    selectivityFold,
    measured,
    source: record.source,
    note:
      `One-site occupancy at ${concentrationNm.toPrecision(3)} nM against a measured potency of ${record.potencyNm.toPrecision(3)} nM. ` +
      'Partial agonism, cellular-versus-biochemical potency differences and target expression are not modelled here.' +
      (measured ? '' : ' This target is not in the dataset’s panel, so no tissue-level consequence can be computed for it.'),
  };
}

/**
 * The V1 adverse signature set.
 *
 * Small and named. Each entry says what a rise in it would mean *in this model*
 * and, explicitly, what it would not — because the gap between "a stress
 * signature increased in a simulated section" and "this drug is toxic" is the
 * entire distance §6.15 is trying to preserve.
 */
export const DEFAULT_ADVERSE_SIGNATURES: AdverseSignature[] = [
  {
    id: 'adv.apoptosis',
    name: 'Apoptotic signature',
    category: 'cell-death',
    members: { BAX: 1, CASP3: 1, TP53: 0.5, BCL2: -1 },
    source: 'Curated from the intrinsic apoptosis pathway (Reactome R-HSA-109581).',
    interpretation:
      'A rise means the model predicts cells moving toward programmed death in this tissue. It is not an estimate of clinical toxicity, and a tissue signature cannot distinguish intended tumour-cell killing from damage to a bystander compartment — the per-class breakdown is what separates those.',
  },
  {
    id: 'adv.inflammation',
    name: 'Inflammatory signature',
    category: 'inflammation',
    members: { TNF: 1, IL6: 1, NFKB1: 0.5, RELA: 0.5, CXCL12: 0.3 },
    source: 'Curated from canonical NF-kB target genes.',
    interpretation:
      'A rise means increased inflammatory signalling in the model. Whether that is harmful depends on context that this pipeline does not have: the same signature accompanies both tissue damage and productive immune engagement.',
  },
  {
    id: 'adv.fibrosis',
    name: 'Fibrotic / matrix signature',
    category: 'fibrosis',
    members: { COL1A1: 1, FN1: 1, ACTA2: 1, TGFB1: 0.5 },
    source: 'Curated from myofibroblast conversion markers.',
    interpretation:
      'A rise means the model predicts more matrix deposition and myofibroblast character. In a tumour context this is associated with stiffening and reduced drug penetration; neither of those is simulated here.',
  },
  {
    id: 'adv.immune-evasion',
    name: 'Immune-evasion signature',
    category: 'immune-evasion',
    members: { CD274: 1, SOCS3: 0.5, B2M: -0.5 },
    source: 'Curated from PD-L1 induction and antigen-presentation loss.',
    interpretation:
      'A rise means the model predicts a state less visible to cytotoxic lymphocytes. Note that PD-L1 rises with interferon signalling, so an effective immune response and an evasive one move this signature the same way — read it with the interferon layer, not alone.',
  },
  {
    id: 'adv.hypoxic-stress',
    name: 'Hypoxic stress signature',
    category: 'stress',
    members: { HIF1A: 1, CA9: 1, SLC2A1: 0.5, LDHA: 0.5 },
    source: 'Curated from canonical HIF1A targets.',
    interpretation:
      'A rise means increased hypoxic signalling. In this model hypoxia is imposed by vessel distance, so a change here reflects the perturbation altering how cells respond to oxygen tension rather than a change in perfusion, which is not simulated.',
  },
  {
    id: 'adv.proliferation',
    name: 'Non-target proliferation',
    category: 'proliferation',
    members: { MKI67: 1, CCND1: 0.5, MYC: 0.5 },
    source: 'Curated from cell-cycle markers.',
    interpretation:
      'A rise in cells the therapy was not aimed at is undesirable. In target cells a fall is the intended effect, which is why this component is reported per class rather than as one section-wide number.',
  },
];
