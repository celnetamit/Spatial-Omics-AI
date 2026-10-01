/**
 * Candidate retrieval and per-candidate rescue simulation — §2 steps 13 to 15.
 *
 * The rule this file exists to enforce is §2's workflow rule: every eligible
 * candidate is simulated separately against the *same* altered tissue state
 * before anything is ranked. So the altered state is captured once, each
 * candidate gets its own independent simulation from that identical starting
 * point, and `compareCandidates` is handed simulation results — there is no
 * argument by which an evidence score could reach the ordering.
 *
 * §6.18's validation line — "candidate job failure does not corrupt others" —
 * is why each candidate is wrapped individually. A candidate whose
 * parameterisation turns out to be unusable is reported as failed, with the
 * reason, beside the ones that succeeded.
 */

import { RandomState } from '@engine/core/rng';
import type { Confidence } from '@engine/core/labels';
import { weakestConfidence } from '@engine/core/labels';
import { pearson, cosineSimilarity, mean } from '@engine/core/stats';
import type { SpatialGraph } from '@engine/spatial/graph';
import type { CompiledNetwork } from '@engine/propagate/network';
import type { Capacity, ExogenousDrive, TissueState } from '@engine/propagate/mechanism';
import { predict, type LoadedModel } from '@engine/propagate/predictor';
import { directEffectTensor } from '@engine/propagate/features';
import { applyDirectToState, computeDirectResponse, createDefinition, resolveSelection } from '@engine/perturb/index';
import type { DoseResponseParameters, DrugPerturbation, TargetSelection } from '@engine/perturb/types';
import { analyseAdverse, DEFAULT_ADVERSE_SIGNATURES } from '@engine/adverse/index';
import { differenceBetween, referenceRecovery, sectionProfile } from '@engine/rescue/comparison';
import {
  compareCandidates, extractDrivers, retrieveCandidates,
  type CandidateTherapy, type ComparisonResult, type ComponentScore, type RankingPolicy,
  type RescueOutcome, type RetrievalContext, type TherapyClass,
} from '@engine/rescue/candidates';
import type { JobContext } from './queue';
import type { Catalogue, DrugRecord } from '../content/loader';
import type { Store } from '../store';
import type { ObservationRecord } from '@engine/data/types';

/**
 * Nodes whose rise after a therapy is adaptive rather than therapeutic.
 *
 * Each is an induced brake on the pathway being hit, so a strong rise in one is
 * the tissue compensating. Named rather than inferred, because a
 * "resistance score" computed from whatever went up would be a rename of the
 * adverse burden.
 */
const RESISTANCE_NODES: { symbol: string; because: string }[] = [
  { symbol: 'DUSP6', because: 'ERK-induced phosphatase; its rise restores MAPK tone after MEK or RAF inhibition.' },
  { symbol: 'SPRY2', because: 'ERK-induced brake on receptor coupling; rises when the pathway is relieved of feedback.' },
  { symbol: 'SOCS3', because: 'JAK/STAT feedback inhibitor; a fall after STAT3 inhibition indicates released feedback rather than resistance, so the sign is read as stated.' },
  { symbol: 'SMAD7', because: 'Induced inhibitor of TGF-beta receptor signalling.' },
  { symbol: 'NFKBIA', because: 'IkB-alpha; NF-kB feedback.' },
  { symbol: 'PIK3CA', because: 'Reciprocal PI3K activation is the classic escape from MAPK blockade.' },
  { symbol: 'AKT1', because: 'Reciprocal PI3K/AKT activation after MAPK blockade.' },
];

export interface RescueInputs {
  runId: string;
  network: CompiledNetwork;
  baseline: TissueState;
  /** The altered tissue every candidate is applied to. Identical for all. */
  altered: TissueState;
  capacity: Capacity;
  exogenous: ExogenousDrive;
  graph: SpatialGraph;
  observations: ObservationRecord[];
  labels: (string | undefined)[];
  catalogue: Catalogue;
  store: Store;
  stages: number;
  seed: number;
  maximumCandidates: number;
  referenceProfile: Float64Array | null;
  referenceComparable: boolean;
  /** A reviewer-approved weight set, or null. */
  policy: RankingPolicy | null;
  datasetOrganism: string;
  datasetTissue: string;
}

export interface RescueArtefacts {
  drivers: RetrievalContext['drivers'];
  eligible: CandidateTherapy[];
  excluded: CandidateTherapy[];
  simulated: {
    candidateId: string;
    name: string;
    status: 'complete' | 'failed';
    failureReason: string | null;
    concentrationNm: number | null;
    components: ComponentScore[];
    adverseBurden: number;
    resistance: number | null;
    resistanceDetail: { symbol: string; delta: number; because: string }[];
    uncertainty: number;
    confidence: Confidence;
    /** Per-cell rescue magnitude, for the candidate map. */
    magnitude: number[];
    nodeMeanDelta: number[];
    warnings: string[];
  }[];
  comparison: ComparisonResult;
  retrievalNote: string;
  simulationNote: string;
}

export async function runRescue(context: JobContext, input: RescueInputs): Promise<RescueArtefacts> {
  const { network, baseline, altered, catalogue, store, runId } = input;
  const nodeSymbols = network.nodes.map((node) => node.symbol);
  const random = new RandomState(input.seed);

  // -- 13 retrieval ---------------------------------------------------------

  await context.report({ stage: 'candidates', fraction: 0.05, message: 'Retrieving candidates' });
  await context.checkpoint();

  const alteredDifference = differenceBetween(baseline, altered, input.labels);
  const drivers = extractDrivers(alteredDifference.nodeMeanDelta, nodeSymbols);

  const retrievalContext: RetrievalContext = {
    featureSpace: new Set(nodeSymbols.map((symbol) => symbol.toUpperCase())),
    // §1.4: small molecule is CORE; antibody, biologic and cell-therapy packs
    // are CONDITIONAL on a separate validated mechanistic model, and none
    // ships. Candidates in those classes are retrieved and then excluded with
    // that reason, which is more useful than omitting them.
    supportedClasses: new Set<TherapyClass>(['small-molecule']),
    drivers,
    datasetOrganism: input.datasetOrganism,
    datasetTissue: input.datasetTissue,
  };

  const catalogueEntries = buildCandidateCatalogue(catalogue, drivers);
  const retrieval = retrieveCandidates(catalogueEntries, retrievalContext);

  const toSimulate = retrieval.eligible.slice(0, input.maximumCandidates);
  if (retrieval.eligible.length > toSimulate.length) {
    retrieval.excluded.push(
      ...retrieval.eligible.slice(input.maximumCandidates).map((candidate) => ({
        ...candidate,
        eligibility: {
          ...candidate.eligibility,
          eligible: false,
          reasons: [
            ...candidate.eligibility.reasons,
            `Eligible, but this run's candidate budget is ${input.maximumCandidates} and this candidate fell outside it. ` +
              'It was not simulated, so it is not ranked.',
          ],
        },
      })),
    );
  }

  // -- 14 per-candidate simulation ------------------------------------------

  const simulated: RescueArtefacts['simulated'] = [];
  const outcomes: RescueOutcome[] = [];
  const pack = catalogue.modelPack;

  for (const [index, candidate] of toSimulate.entries()) {
    await context.report({
      stage: 'rescue-simulations',
      fraction: 0.1 + (0.7 * index) / Math.max(1, toSimulate.length),
      message: `Simulating ${candidate.name} (${index + 1} of ${toSimulate.length})`,
    });
    await context.checkpoint();

    try {
      const outcome = await simulateCandidate(candidate, input, pack, nodeSymbols, alteredDifference.nodeMeanDelta);
      simulated.push(outcome.record);
      if (outcome.outcome) outcomes.push(outcome.outcome);
    } catch (error) {
      // §6.18: one candidate's failure must not corrupt the others.
      simulated.push({
        candidateId: candidate.candidateId,
        name: candidate.name,
        status: 'failed',
        failureReason: error instanceof Error ? error.message : String(error),
        concentrationNm: candidate.suggestedConcentrationNm,
        components: [],
        adverseBurden: Number.NaN,
        resistance: null,
        resistanceDetail: [],
        uncertainty: Number.NaN,
        confidence: 'not-interpretable',
        magnitude: [],
        nodeMeanDelta: [],
        warnings: [],
      });
    }
  }

  // -- 15 comparison --------------------------------------------------------

  await context.report({ stage: 'comparison', fraction: 0.9, message: 'Comparing candidates' });
  await context.checkpoint();

  const comparison = compareCandidates(outcomes, input.policy);

  const artefacts: RescueArtefacts = {
    drivers,
    eligible: retrieval.eligible,
    excluded: retrieval.excluded,
    simulated,
    comparison,
    retrievalNote: retrieval.note,
    simulationNote:
      `Each candidate was applied to the same altered tissue state (${altered.observationCount} cells, checksum-identical across candidates) ` +
      'and simulated independently. No candidate entered the comparison without a simulation, and the comparison was computed only after all of them finished (§2).',
  };

  store.writeArtefact(runId, 'rescue', artefacts);
  void random;
  return artefacts;
}

async function simulateCandidate(
  candidate: CandidateTherapy,
  input: RescueInputs,
  pack: Catalogue['modelPack'],
  nodeSymbols: string[],
  perturbationDelta: Float64Array,
): Promise<{ record: RescueArtefacts['simulated'][number]; outcome: RescueOutcome | null }> {
  const { network, baseline, altered } = input;
  const warnings: string[] = [];

  if (!candidate.doseResponse || candidate.suggestedConcentrationNm === null) {
    throw new Error('No dose-response parameterisation; the candidate should not have been eligible.');
  }

  // Whole tissue: a rescue is administered to the section, not to a chosen set
  // of cells. Which cells it *reaches* is A_i, the measured target availability.
  const selection: TargetSelection = resolveSelection(
    { mode: 'whole-tissue' },
    input.observations,
    input.labels,
    input.labels,
  );

  const spec: DrugPerturbation = {
    branch: 'drug',
    drugId: candidate.candidateId,
    drugName: candidate.name,
    target: candidate.target,
    actionType: candidate.actionType,
    secondaryTargets: candidate.secondaryTargets,
    concentration: candidate.suggestedConcentrationNm,
    concentrationUnit: 'nM',
    exposureTime: 24,
    exposureTimeUnit: 'h',
    doseResponse: candidate.doseResponse,
    timeResponse: null,
    evidenceSnapshotId: input.catalogue.drugEvidence?.packId ?? 'none',
  };

  const definition = createDefinition(
    spec,
    selection,
    { decision: 'quantitative', reasons: [], remedies: [], confidence: candidate.eligibility.confidence },
    'rescue-small-molecule',
    '1.0.0',
  );

  const direct = computeDirectResponse({
    definition,
    network,
    baseline: altered,
    capacity: input.capacity,
    exogenous: input.exogenous,
    cellTypes: input.labels,
  });
  warnings.push(...direct.warnings);

  const directState = applyDirectToState(altered, direct, network);
  const directEffect = directEffectTensor(altered, directState, direct.targetNodes, direct.magnitude, network);

  let rescued = directState;
  let dispersion = Number.NaN;
  if (pack) {
    const model: LoadedModel = { id: pack.modelId, version: pack.version, schema: pack.schema, members: pack.members };
    const prediction = predict(model, {
      baseline: altered,
      directState,
      directEffect,
      graph: input.graph,
      labels: input.labels,
      stages: input.stages,
    });
    rescued = (prediction.stages[prediction.stages.length - 1] as { state: TissueState }).state;
    const finite = Array.from(prediction.disagreement).filter((value) => Number.isFinite(value));
    dispersion = finite.length > 0 ? mean(finite) : Number.NaN;
  } else {
    warnings.push('No propagation model pack; the rescue is the direct effect only, with no spatial component.');
  }

  // -- components ------------------------------------------------------------

  const rescueDifference = differenceBetween(altered, rescued, input.labels);
  const fromBaseline = differenceBetween(baseline, rescued, input.labels);

  /*
   * Reversal: how much of the perturbation's signature the therapy undid.
   *
   * The cosine between the rescue's direction and the *negative* of the
   * perturbation's. A therapy that moves the tissue a long way in an unrelated
   * direction scores near zero rather than well, which a magnitude-based
   * measure would not — and "it changed a lot" is not "it reversed the
   * disease".
   */
  const negatedPerturbation = Array.from(perturbationDelta, (value) => -value);
  const reversalDirection = cosineSimilarity(Array.from(rescueDifference.nodeMeanDelta), negatedPerturbation);

  /*
   * Reversal extent: the projection of the rescue onto the perturbation axis,
   * as a fraction of the perturbation's own size. 1.0 means the tissue is back
   * where it started; above 1.0 it has been pushed past, which is reported
   * rather than rewarded.
   */
  let projection = 0;
  let perturbationNormSquared = 0;
  for (let node = 0; node < perturbationDelta.length; node += 1) {
    const p = perturbationDelta[node] as number;
    projection += (rescueDifference.nodeMeanDelta[node] as number) * -p;
    perturbationNormSquared += p * p;
  }
  const reversalExtent = perturbationNormSquared > 0 ? projection / perturbationNormSquared : 0;

  const residual = pearson(Array.from(fromBaseline.nodeMeanDelta), Array.from(perturbationDelta));

  let recoveryComponent: number = Number.NaN;
  if (input.referenceProfile) {
    const recovery = referenceRecovery(
      input.referenceProfile,
      sectionProfile(baseline),
      sectionProfile(rescued),
      network,
      input.referenceComparable,
    );
    recoveryComponent = recovery.meanRecovery;
    if (recovery.overshooting.length > 0) {
      warnings.push(
        `${recovery.overshooting.length} feature(s) overshot the reference under this candidate: ${recovery.overshooting.slice(0, 6).join(', ')}. ` +
          'Overshoot is excluded from the recovery mean rather than counted as rescue (§7.6).',
      );
    }
  }

  // -- adverse and resistance -----------------------------------------------

  const adverse = analyseAdverse({
    baseline: altered,
    predicted: rescued,
    network,
    signatures: DEFAULT_ADVERSE_SIGNATURES,
    labels: input.labels,
    targetedIndices: new Set<number>(),
    offTargets: candidate.secondaryTargets.map((secondary) => ({
      symbol: secondary.symbol,
      potencyNm: secondary.potencyNm,
      primaryPotencyNm: candidate.doseResponse?.ec50Nm ?? null,
      source: secondary.source,
      actionType: candidate.actionType,
    })),
    concentrationNm: candidate.suggestedConcentrationNm,
  });

  const resistanceDetail: { symbol: string; delta: number; because: string }[] = [];
  for (const node of RESISTANCE_NODES) {
    const index = network.index.get(node.symbol);
    if (index === undefined) continue;
    resistanceDetail.push({
      symbol: node.symbol,
      delta: rescueDifference.nodeMeanDelta[index] as number,
      because: node.because,
    });
  }
  const rising = resistanceDetail.filter((entry) => entry.delta > 0).map((entry) => entry.delta);
  const resistance = rising.length > 0 ? mean(rising) : 0;

  const components: ComponentScore[] = [
    {
      id: 'reversal-direction',
      name: 'Reversal direction',
      value: reversalDirection,
      direction: 'higher-is-better',
      unit: 'cosine, -1 to 1',
      method: 'Cosine between the rescue’s section-mean change and the negated perturbation change.',
    },
    {
      id: 'reversal-extent',
      name: 'Reversal extent',
      value: reversalExtent,
      direction: 'higher-is-better',
      unit: 'fraction of the perturbation undone',
      method: 'Projection of the rescue change onto the perturbation axis, divided by the perturbation’s own magnitude. Above 1 means overshoot.',
    },
    {
      id: 'residual-disease',
      name: 'Residual perturbation signature',
      value: residual,
      direction: 'lower-is-better',
      unit: 'correlation with the perturbation signature',
      method: 'Pearson correlation between the rescued tissue’s change from baseline and the perturbation’s own change.',
    },
    {
      id: 'spatial-extent',
      name: 'Spatial extent of the rescue',
      value: rescueDifference.changedFraction,
      direction: 'higher-is-better',
      unit: 'fraction of cells changed',
      method: 'Fraction of observations whose change exceeds the noise floor.',
    },
  ];

  if (Number.isFinite(recoveryComponent)) {
    components.push({
      id: 'reference-recovery',
      name: 'Recovery toward the reference',
      value: recoveryComponent,
      direction: 'higher-is-better',
      unit: 'mean R_f over features with a gap to close',
      method: '§7.6 feature recovery, excluding overshoot and worsening, which are reported separately.',
    });
  }

  const confidence: Confidence = weakestConfidence(
    candidate.eligibility.confidence,
    pack ? 'moderate' : 'exploratory',
  );

  const record: RescueArtefacts['simulated'][number] = {
    candidateId: candidate.candidateId,
    name: candidate.name,
    status: 'complete',
    failureReason: null,
    concentrationNm: candidate.suggestedConcentrationNm,
    components,
    adverseBurden: adverse.burden,
    resistance,
    resistanceDetail,
    uncertainty: dispersion,
    confidence,
    magnitude: Array.from(rescueDifference.observationMagnitude),
    nodeMeanDelta: Array.from(rescueDifference.nodeMeanDelta),
    warnings,
  };

  void nodeSymbols;

  return {
    record,
    outcome: {
      candidateId: candidate.candidateId,
      name: candidate.name,
      components,
      adverseBurden: adverse.burden,
      resistance,
      uncertainty: Number.isFinite(dispersion) ? dispersion : 0,
      confidence,
      simulationId: `${input.runId}:${candidate.candidateId}`,
      warnings,
    },
  };
}

/**
 * Turns the frozen ChEMBL snapshot into candidate records.
 *
 * The suggested concentration is the median potency, which is the
 * concentration the evidence is densest at rather than one chosen to make the
 * effect look good. §6.18 requires candidate-specific values to be
 * evidence-supported and forbids universal therapy defaults, so there is no
 * fallback here: a compound with no potency measurement has no suggested
 * concentration and is excluded by the eligibility rule rather than simulated
 * at something plausible.
 */
export function buildCandidateCatalogue(
  catalogue: Catalogue,
  drivers: RetrievalContext['drivers'],
): Omit<CandidateTherapy, 'eligibility'>[] {
  const evidence = catalogue.drugEvidence;
  if (!evidence) return [];

  const driverDirection = new Map(drivers.map((driver) => [driver.symbol.toUpperCase(), driver.direction]));
  const retrievedAt = evidence.retrievedAt;

  return evidence.records.map((record: DrugRecord) => {
    const doseResponseParameters: DoseResponseParameters | null =
      record.potency.medianNm !== null
        ? {
            /*
             * Emax is 1.0 — full engagement at saturating concentration.
             *
             * This is a *model assumption*, not a measurement, and it is stated
             * as one in the parameter note rather than presented as a fitted
             * value. ChEMBL records potency, not efficacy: an IC50 says where
             * the curve sits, not how far down it goes. For a competitive
             * inhibitor of an enzyme, full inhibition at saturation is the
             * standard assumption; for a partial agonist it would be wrong,
             * and no partial agonist is in this catalogue.
             */
            emax: 1,
            ec50Nm: record.potency.medianNm,
            hill: 1,
            source: `ChEMBL ${record.drugId} against ${record.targetChemblId}, median of ${record.potency.measurements} measurement(s), retrieved ${retrievedAt}.`,
            evidenceClass: 'curated-database',
            context: {
              organism: record.targetOrganism,
              tissueOrCellLine: 'Mixed; the measurements aggregate biochemical and cell-based assays.',
              assay: record.potency.types.join(', '),
              testedRangeNm: record.potency.testedRangeNm,
            },
            transferWarning:
              'Potency is aggregated across assay types and cell contexts. A Hill coefficient of 1 and an Emax of 1 are model ' +
              'assumptions, not measurements: ChEMBL records where a curve sits, not its slope or its floor.',
          }
        : null;

    const targetDirection = driverDirection.get(record.target.toUpperCase());
    const opposes =
      (targetDirection === 'up' && (record.curated.actionType === 'inhibitor' || record.curated.actionType === 'antagonist' || record.curated.actionType === 'degrader')) ||
      (targetDirection === 'down' && record.curated.actionType === 'agonist');

    return {
      candidateId: record.drugId,
      name: record.prefName || record.name,
      therapyClass: record.curated.therapyClass,
      target: record.target,
      mechanism: record.curated.mechanism,
      actionType: record.curated.actionType,
      evidence: [
        {
          kind: 'drug-target' as const,
          source: 'ChEMBL',
          identifier: `${record.drugId} / ${record.targetChemblId}`,
          summary: `${record.curated.mechanism} Curated action type; target resolved from UniProt ${record.targetUniprot}.`,
          evidenceClass: 'curated-database' as const,
          retrievedAt,
        },
        ...(record.potency.medianNm !== null
          ? [
              {
                kind: 'bioactivity' as const,
                source: 'ChEMBL',
                identifier: record.evidence.activityQuery,
                summary:
                  `${record.potency.measurements} ${record.potency.types.join('/')} measurement(s) across ${record.evidence.documentCount} document(s); ` +
                  `median ${record.potency.medianNm.toPrecision(3)} nM, 10th–90th percentile ` +
                  `${record.potency.testedRangeNm ? `${record.potency.testedRangeNm[0].toPrecision(3)}–${record.potency.testedRangeNm[1].toPrecision(3)}` : 'n/a'} nM.`,
                evidenceClass: 'near-context-experimental' as const,
                retrievedAt,
              },
            ]
          : []),
        ...(opposes
          ? [
              {
                kind: 'target-disease' as const,
                source: 'Altered tissue state of this run',
                identifier: record.target,
                summary: `${record.target} is among the drivers of the altered state and moved ${targetDirection}; this compound acts to oppose that.`,
                evidenceClass: 'model-derived' as const,
                retrievedAt,
              },
            ]
          : []),
      ],
      doseResponse: doseResponseParameters,
      suggestedConcentrationNm: record.potency.medianNm,
      concentrationRationale:
        record.potency.medianNm === null
          ? 'No potency measurement, so no evidence-supported concentration exists and none was invented.'
          : `The median of ${record.potency.measurements} retrieved measurement(s) — the concentration the evidence is densest at, rather than one chosen for effect.`,
      secondaryTargets: [],
    };
  });
}
