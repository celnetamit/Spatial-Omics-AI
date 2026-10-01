/**
 * The most informative validation experiment — §6.22.
 *
 * Rule-backed, not model-generated. §6.22 allows an AI to explain the
 * rationale, but the assay has to be chosen by a rule that maps a predicted
 * feature to an approved assay category — and the reason is in §6.22's own
 * validation line: the recommendation must "measure the predicted feature and
 * be feasible in the selected model context". A model asked for a good
 * experiment will produce a plausible one; a rule can be checked against what
 * the prediction actually says.
 *
 * The experiment chosen is the one that best *discriminates*. The largest
 * predicted change is not usually the most informative thing to measure: if the
 * model is confident about it, confirming it moves nothing. What is worth
 * measuring is where a large predicted effect meets large uncertainty, because
 * that is where the result could go either way.
 */

import type { Confidence } from '../core/labels';

export type AssayCategory =
  | 'qpcr'
  | 'flow-cytometry'
  | 'immunofluorescence'
  | 'spatial-transcriptomics'
  | 'protein-assay'
  | 'cytokine-assay'
  | 'drug-response-assay'
  | 'reporter-assay';

export interface AssaySpec {
  category: AssayCategory;
  name: string;
  /** What this assay can actually measure. */
  measures: ('transcript' | 'protein' | 'secreted-protein' | 'spatial-pattern' | 'viability' | 'cell-state')[];
  /** Whether it preserves spatial context. */
  spatial: boolean;
  /** Plain-language note on what it cannot tell you. */
  cannotShow: string;
}

export const ASSAYS: Record<AssayCategory, AssaySpec> = {
  qpcr: {
    category: 'qpcr',
    name: 'RT-qPCR',
    measures: ['transcript'],
    spatial: false,
    cannotShow: 'It measures bulk transcript across the dissociated sample, so it cannot show which cells changed or where.',
  },
  'flow-cytometry': {
    category: 'flow-cytometry',
    name: 'Flow cytometry',
    measures: ['protein', 'cell-state', 'viability'],
    spatial: false,
    cannotShow: 'Dissociation destroys spatial context, so a change localised to one region appears as a change in a fraction of cells.',
  },
  immunofluorescence: {
    category: 'immunofluorescence',
    name: 'Multiplex immunofluorescence',
    measures: ['protein', 'spatial-pattern'],
    spatial: true,
    cannotShow: 'Panel size is limited, and antibody availability rather than biology decides what can be included.',
  },
  'spatial-transcriptomics': {
    category: 'spatial-transcriptomics',
    name: 'Spatial transcriptomics',
    measures: ['transcript', 'spatial-pattern', 'cell-state'],
    spatial: true,
    cannotShow: 'It measures transcript, not protein or activity; a prediction about a phosphorylation state is not testable this way.',
  },
  'protein-assay': {
    category: 'protein-assay',
    name: 'Western blot or targeted proteomics',
    measures: ['protein'],
    spatial: false,
    cannotShow: 'Bulk measurement on a dissociated sample; no spatial or single-cell resolution.',
  },
  'cytokine-assay': {
    category: 'cytokine-assay',
    name: 'Multiplex cytokine assay',
    measures: ['secreted-protein'],
    spatial: false,
    cannotShow: 'It measures what was secreted into the medium, not which cell secreted it.',
  },
  'drug-response-assay': {
    category: 'drug-response-assay',
    name: 'Dose-response viability assay',
    measures: ['viability'],
    spatial: false,
    cannotShow: 'Viability is a downstream summary; it cannot distinguish two mechanisms that both reduce it.',
  },
  'reporter-assay': {
    category: 'reporter-assay',
    name: 'Pathway reporter assay',
    measures: ['cell-state'],
    spatial: false,
    cannotShow: 'A reporter reads one pathway’s output in a construct, not the endogenous state of the tissue.',
  },
};

export interface PredictedChange {
  symbol: string;
  /** Signed change at the final stage. */
  delta: number;
  /** Ensemble dispersion for this feature, where one exists. */
  dispersion: number;
  /** Whether the change is concentrated in one cell class or spread. */
  localisedTo: string | null;
  /** Whether the feature is a secreted ligand. */
  secreted: boolean;
  /** Whether a protein measurement exists in the dataset. */
  proteinMeasured: boolean;
  /** Whether the change is in cells the perturbation did not touch. */
  bystander: boolean;
}

export interface ValidationPlan {
  question: string;
  assay: AssaySpec;
  /** The feature or features to measure. */
  measure: string[];
  /** What would confirm the prediction, and what would refute it. */
  expectedIfCorrect: string;
  expectedIfWrong: string;
  rationale: string;
  /** Why the other candidate assays were not chosen. */
  alternativesConsidered: { assay: string; why: string }[];
  limitations: string[];
  confidence: Confidence;
  /** The prediction this plan tests, by id. */
  testsPrediction: string;
  notAClinicalProtocol: string;
}

export interface PlanInput {
  changes: PredictedChange[];
  /** The perturbation, in words. */
  perturbationDescription: string;
  /** Whether the run's propagation was spatial at all. */
  spatialPredictionAvailable: boolean;
  confidence: Confidence;
  predictionId: string;
}

/**
 * Choose the experiment.
 *
 * The score is |delta| x (dispersion + floor). A large change the ensemble
 * agrees on is worth less than a large change it disagrees about, because the
 * second is where an experiment could change the answer. The floor keeps a
 * confidently predicted large effect in contention rather than ranking it below
 * a noisy tiny one.
 */
export function recommendValidation(input: PlanInput): ValidationPlan | null {
  const candidates = input.changes.filter((change) => Number.isFinite(change.delta) && Math.abs(change.delta) > 0.01);
  if (candidates.length === 0) return null;

  const floor = 0.005;
  const scored = candidates
    .map((change) => ({
      change,
      score:
        Math.abs(change.delta) *
        ((Number.isFinite(change.dispersion) ? change.dispersion : floor) + floor) *
        // A bystander change is the spatial claim. Confirming a direct effect
        // confirms the drug bound its target, which is not what is in doubt.
        (change.bystander ? 2 : 1),
    }))
    .sort((a, b) => b.score - a.score);

  const top = scored[0];
  if (!top) return null;
  const target = top.change;

  // The related features worth measuring alongside — same direction, same
  // compartment. A one-gene experiment is rarely the most informative one.
  const companions = scored
    .slice(1, 6)
    .filter((entry) => entry.change.localisedTo === target.localisedTo)
    .map((entry) => entry.change.symbol);

  const assay = chooseAssay(target, input.spatialPredictionAvailable);
  const alternatives = Object.values(ASSAYS)
    .filter((candidate) => candidate.category !== assay.category)
    .slice(0, 3)
    .map((candidate) => ({
      assay: candidate.name,
      why: whyNot(candidate, target, input.spatialPredictionAvailable),
    }));

  const direction = target.delta > 0 ? 'increase' : 'decrease';
  const opposite = target.delta > 0 ? 'decrease or no change' : 'increase or no change';

  return {
    question:
      target.bystander
        ? `Does ${target.symbol} ${direction} in cells that were not directly perturbed, as the spatial model predicts?`
        : `Does ${target.symbol} ${direction} in the perturbed cells, as the direct-response model predicts?`,
    assay,
    measure: [target.symbol, ...companions],
    expectedIfCorrect:
      `${target.symbol} ${direction}s by a magnitude of order ${Math.abs(target.delta).toPrecision(2)} on the model's activity scale` +
      (target.localisedTo ? `, concentrated in the ${target.localisedTo} compartment` : '') +
      (target.bystander ? ', in cells the perturbation did not reach directly' : '') +
      '. The model does not predict an absolute expression value, so the comparison is of direction and relative magnitude between treated and untreated.',
    expectedIfWrong:
      `A ${opposite} in ${target.symbol}` +
      (target.bystander
        ? ', or a change confined to the directly perturbed cells with none in their neighbours — which would say the propagation is an artefact of the model rather than a property of the tissue.'
        : ', which would say the direct-response parameterisation is wrong for this context.'),
    rationale:
      `${target.symbol} was selected because its predicted change is large *and* the ensemble disagrees about it` +
      (Number.isFinite(target.dispersion) ? ` (dispersion ${target.dispersion.toPrecision(2)})` : '') +
      '. Confirming a change the model is already confident about would resolve nothing; this is where a measurement could move the answer.' +
      (target.bystander
        ? ' It is also a bystander change, so it tests the spatial claim rather than the pharmacology.'
        : ''),
    alternativesConsidered: alternatives,
    limitations: [
      'This recommends what to measure, not how to run it. Sample size, controls and statistics are outside what the pipeline can determine.',
      assay.cannotShow,
      'The model predicts a bounded activity, not an absolute expression level, so only direction and relative magnitude are comparable.',
      input.spatialPredictionAvailable
        ? 'The predicted propagation was produced by a model fitted on simulated tissue. A disagreement is informative about the model; it is not evidence about the biology on its own.'
        : 'No spatial prediction was made in this run, so the plan tests the direct response only.',
    ],
    confidence: input.confidence,
    testsPrediction: input.predictionId,
    notAClinicalProtocol:
      'This is a research validation suggestion. It is not a clinical protocol, it does not constitute treatment guidance, and no part of this platform is a clinical decision aid.',
  };
}

function chooseAssay(target: PredictedChange, spatialAvailable: boolean): AssaySpec {
  // A secreted ligand is best measured where it ends up.
  if (target.secreted) return ASSAYS['cytokine-assay'];
  // A spatial claim needs an assay that keeps the tissue intact — otherwise the
  // measurement cannot distinguish the prediction from its negation.
  if (target.bystander && spatialAvailable) {
    return target.proteinMeasured ? ASSAYS.immunofluorescence : ASSAYS['spatial-transcriptomics'];
  }
  if (target.proteinMeasured) return ASSAYS['flow-cytometry'];
  return ASSAYS.qpcr;
}

function whyNot(candidate: AssaySpec, target: PredictedChange, spatialAvailable: boolean): string {
  if (target.bystander && spatialAvailable && !candidate.spatial) {
    return `${candidate.name} does not preserve spatial context, and the prediction being tested is about where the change happens.`;
  }
  if (target.secreted && !candidate.measures.includes('secreted-protein')) {
    return `${candidate.name} does not measure secreted protein, and the predicted change is in a ligand.`;
  }
  if (!target.proteinMeasured && candidate.measures.includes('protein') && !candidate.measures.includes('transcript')) {
    return `${candidate.name} measures protein, which this dataset does not cover for ${target.symbol}.`;
  }
  return `${candidate.name} would measure the right quantity but less directly than the recommended assay.`;
}
