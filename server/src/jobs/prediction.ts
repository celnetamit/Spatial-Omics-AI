/**
 * The perturbation and propagation pipeline — §2 steps 05 to 12.
 *
 * Direct response, spatial propagation, adverse analysis, the assembled altered
 * tissue and the uncertainty assessment. §2.3's separation is kept structurally:
 * the direct response is computed from evidence and stored as its own artefact
 * before any model runs, and the propagation reads it as an input rather than
 * producing it.
 *
 * For a bundled case the mechanistic reference can be run alongside the model.
 * That is offered as a *comparison*, labelled "simulated reference", and never
 * substituted for the prediction — §15.2(9) requires every model output to be
 * labelled PREDICTED, and quietly serving the mechanism's answer when it is
 * available would make the label a lie on exactly the runs where a reader could
 * most easily be misled.
 */


import type { ReproducibilityManifest } from '@engine/core/provenance';
import type { Confidence } from '@engine/core/labels';
import { weakestConfidence } from '@engine/core/labels';
import type { SpatialGraph } from '@engine/spatial/graph';
import type { CompiledNetwork } from '@engine/propagate/network';
import {
  buildDiffusion, solveTissue,
  type Capacity, type ExogenousDrive, type TissueContext, type TissueState,
} from '@engine/propagate/mechanism';
import { pearson, rootMeanSquareError } from '@engine/core/stats';
import type { ObservationRecord } from '@engine/data/types';
import { predict, type LoadedModel, type PredictionResult } from '@engine/propagate/predictor';
import { directEffectTensor } from '@engine/propagate/features';
import { applyDirectToState, computeDirectResponse, type DirectResponse } from '@engine/perturb/index';
import type { PerturbationDefinition } from '@engine/perturb/types';
import { analyseAdverse, DEFAULT_ADVERSE_SIGNATURES, type AdverseResult, type OffTargetRecord } from '@engine/adverse/index';
import { differenceBetween, referenceRecovery, sectionProfile, type DifferenceResult, type RecoveryResult } from '@engine/rescue/comparison';
import { assessConfidence, assessDomain, type OutOfDomainResult, type UncertaintyResult } from '@engine/uncertainty/index';
import { contextVector } from '@engine/propagate/stateEstimate';
import type { JobContext } from './queue';
import type { Catalogue } from '../content/loader';
import type { Store } from '../store';

export interface PredictionInputs {
  runId: string;
  definition: PerturbationDefinition;
  network: CompiledNetwork;
  baseline: TissueState;
  capacity: Capacity;
  exogenous: ExogenousDrive;
  ligandReference: Float64Array;
  graph: SpatialGraph;
  /** Needed to rebuild the diffusion operator for the mechanistic reference. */
  observations: ObservationRecord[];
  labels: (string | undefined)[];
  catalogue: Catalogue;
  store: Store;
  stages: number;
  seed: number;
  /** Available only for a bundled case; enables the mechanistic comparison. */
  mechanismAvailable: boolean;
  /** Expert mode may request the mechanistic reference alongside. */
  runMechanisticReference: boolean;
  /** Reference tissue profile, for §7.6 recovery. */
  referenceProfile: Float64Array | null;
  referenceComparable: boolean;
  offTargets: OffTargetRecord[];
  concentrationNm: number | null;
  manifest: ReproducibilityManifest;
}

export interface PredictionArtefacts {
  perturbationId: string;
  direct: {
    magnitude: number[];
    targetNodes: number[];
    terms: DirectResponse['terms'];
    warnings: string[];
    quantitative: boolean;
    method: string;
    /** Per-cell, per-node immediate change. Sparse: only the target nodes. */
    effectByNode: Record<string, number[]>;
  };
  propagation: {
    available: boolean;
    unavailableReason: string | null;
    modelId: string;
    modelVersion: string;
    graphId: string;
    members: number;
    stages: {
      stage: number;
      label: string;
      /** Per-cell magnitude of change from baseline. */
      magnitude: number[];
      /** Per-cell magnitude of change from the previous stage. */
      stepMagnitude: number[];
      /** Section-mean change per node. */
      nodeMeanDelta: number[];
    }[];
    stageCaveat: string;
    disagreement: number[];
  };
  altered: {
    nodeMeanDelta: number[];
    observationMagnitude: number[];
    byClass: { className: string; count: number; nodeMeanDelta: number[] }[];
    meanMagnitude: number;
    changedFraction: number;
  };
  /**
   * The adverse result with the per-cell deltas moved out of the components.
   *
   * `AdverseComponent.delta` is a Float64Array, which JSON turns into
   * `{"0":…}`. The per-cell values live in `componentDeltas` keyed by signature
   * id, and the components keep everything else.
   */
  adverse: Omit<AdverseResult, 'components'> & {
    components: Omit<AdverseResult['components'][number], 'delta'>[];
    componentDeltas: Record<string, number[]>;
  };
  recovery: RecoveryResult | null;
  uncertainty: Omit<UncertaintyResult, 'perObservation'> & { domain: OutOfDomainResult };
  mechanisticReference: {
    ran: boolean;
    reason: string;
    /** Per-cell agreement between the model and the mechanism, where run. */
    agreement: { pearson: number; rmse: number; perStageRmse: number[] } | null;
    nodeMeanDelta: number[] | null;
  };
  confidence: Confidence;
  nodeSymbols: string[];
}

export async function runPrediction(
  context: JobContext,
  input: PredictionInputs,
): Promise<{ artefacts: PredictionArtefacts; alteredState: TissueState; difference: DifferenceResult }> {
  const { definition, network, baseline, catalogue, store, runId } = input;
  const nodeSymbols = network.nodes.map((node) => node.symbol);
  let confidence: Confidence = definition.eligibility.confidence;

  // -- 07 direct response ---------------------------------------------------

  await context.report({ stage: 'direct-response', fraction: 0.05, message: 'Direct target-cell response' });
  await context.checkpoint();

  const direct = computeDirectResponse({
    definition,
    network,
    baseline,
    capacity: input.capacity,
    exogenous: input.exogenous,
    cellTypes: input.labels,
  });
  const directState = applyDirectToState(baseline, direct, network);
  const directEffect = directEffectTensor(baseline, directState, direct.targetNodes, direct.magnitude, network);

  const effectByNode: Record<string, number[]> = {};
  for (const node of direct.targetNodes) {
    const column = new Array<number>(baseline.observationCount);
    for (let i = 0; i < baseline.observationCount; i += 1) {
      column[i] = directEffect[i * baseline.nodeCount + node] as number;
    }
    effectByNode[nodeSymbols[node] as string] = column;
  }

  store.writeArtefact(runId, 'direct-response', {
    magnitude: Array.from(direct.magnitude),
    targetNodes: direct.targetNodes,
    terms: direct.terms,
    warnings: direct.warnings,
    quantitative: direct.quantitative,
    method: direct.method,
  });
  input.manifest.warnings.push(...direct.warnings);

  // -- 09/10 propagation ----------------------------------------------------

  await context.report({ stage: 'propagation', completed: ['direct-response'], fraction: 0.2, message: 'Spatial propagation' });
  await context.checkpoint();

  const pack = catalogue.modelPack;
  let prediction: PredictionResult | null = null;
  let unavailableReason: string | null = null;

  if (!pack) {
    unavailableReason =
      'No propagation model pack is installed, so no spatial prediction was made. The direct response above is evidence-derived and stands on its own; ' +
      'nothing has been substituted for the propagation.';
    confidence = 'not-interpretable';
  } else if (!direct.quantitative && definition.eligibility.decision === 'blocked') {
    unavailableReason = 'The perturbation was blocked, so there was nothing to propagate.';
    confidence = 'not-interpretable';
  } else {
    const model: LoadedModel = {
      id: pack.modelId,
      version: pack.version,
      schema: pack.schema,
      members: pack.members,
    };
    prediction = predict(model, {
      baseline,
      directState,
      directEffect,
      graph: input.graph,
      labels: input.labels,
      stages: input.stages,
    });
    input.manifest.model = {
      modelId: pack.modelId,
      version: pack.version,
      weightsChecksum: pack.weightsChecksum,
    };
  }

  const finalState = prediction
    ? (prediction.stages[prediction.stages.length - 1] as { state: TissueState }).state
    : directState;

  // -- 11 altered tissue ----------------------------------------------------

  await context.report({ stage: 'altered-tissue', fraction: 0.5, message: 'Assembling the predicted altered tissue' });
  await context.checkpoint();

  const difference = differenceBetween(baseline, finalState, input.labels);

  // -- 12 adverse -----------------------------------------------------------

  await context.report({ stage: 'adverse', fraction: 0.62, message: 'Adverse and off-target analysis' });
  await context.checkpoint();

  const targeted = new Set(definition.selection.resolvedIndices);
  const adverse = analyseAdverse({
    baseline,
    predicted: finalState,
    network,
    signatures: DEFAULT_ADVERSE_SIGNATURES,
    labels: input.labels,
    targetedIndices: targeted,
    offTargets: input.offTargets,
    concentrationNm: input.concentrationNm,
  });
  input.manifest.warnings.push(...adverse.warnings);

  // -- §7.6 recovery --------------------------------------------------------

  let recovery: RecoveryResult | null = null;
  if (input.referenceProfile) {
    recovery = referenceRecovery(
      input.referenceProfile,
      sectionProfile(baseline),
      sectionProfile(finalState),
      network,
      input.referenceComparable,
    );
  }

  // -- 12 uncertainty -------------------------------------------------------

  await context.report({ stage: 'uncertainty', fraction: 0.74, message: 'Uncertainty and out-of-domain' });
  await context.checkpoint();

  const domainReference = pack?.card.uncertainty.domain ?? null;
  const vector = contextVector({
    observationCount: baseline.observationCount,
    medianEdgeLength: input.graph.diagnostics.medianEdgeLength,
    meanDegree: input.graph.diagnostics.meanDegree,
    labels: input.labels,
    state: baseline,
    perturbedFraction: definition.selection.resolvedIndices.length / Math.max(1, baseline.observationCount),
  });

  const domain: OutOfDomainResult = domainReference
    ? assessDomain(vector, {
        ...domainReference,
        means: Float64Array.from(domainReference.means as unknown as number[]),
        standardDeviations: Float64Array.from(domainReference.standardDeviations as unknown as number[]),
      })
    : {
        distance: Number.NaN,
        status: 'out-of-domain',
        contributors: [],
        explanation:
          'No model pack is installed, so there is no training distribution to compare this run against. ' +
          'That is not the same as being out of domain — it is not knowing, and the run is treated as not interpretable for that reason.',
      };

  const uncertainty = assessConfidence({
    dispersion: prediction?.disagreement ?? new Float64Array(baseline.observationCount).fill(Number.NaN),
    members: prediction?.members ?? 0,
    domain,
    upstream: confidence,
    perturbationDecision: definition.eligibility.decision,
    calibration: pack?.card.uncertainty.calibration ?? null,
    dispersionThreshold: pack?.card.uncertainty.dispersionThreshold ?? 0.02,
  });
  confidence = weakestConfidence(confidence, uncertainty.confidence);
  input.manifest.confidence = confidence;
  if (domain.status !== 'in-domain') input.manifest.outOfDomain.push(domain.explanation);

  // -- the mechanistic reference -------------------------------------------

  let mechanisticReference: PredictionArtefacts['mechanisticReference'] = {
    ran: false,
    reason: input.mechanismAvailable
      ? 'Not requested. The mechanistic reference is available for this bundled case and can be run alongside the prediction in Advanced mode.'
      : 'Unavailable. The mechanistic reference exists only for the bundled simulated cases, which carry the state and the tissue ' +
        'context the solver needs. An uploaded dataset has measured expression and an estimated state, not the mechanism that produced them.',
    agreement: null,
    nodeMeanDelta: null,
  };

  /*
   * Runnable with or without a model prediction.
   *
   * With one, it is the comparison. Without one — no model pack installed —
   * it is still the only quantitative answer available for a bundled case, and
   * withholding it because there is nothing to compare it *with* would leave
   * the screen emptier than the evidence warrants. The agreement figure is
   * null in that case rather than invented.
   */
  if (input.mechanismAvailable && input.runMechanisticReference) {
    /*
     * The mechanistic reference solve.
     *
     * This is the closest thing this lab has to §6.23's prediction-versus-
     * observation loop for a bundled case: the mechanism is what generated the
     * data, so running it under the same perturbation gives the answer the
     * model was trying to reproduce. It is labelled "simulated reference"
     * everywhere it surfaces — it is not an observation, and on an uploaded
     * dataset it does not exist at all.
     */
    await context.report({ fraction: 0.86, message: 'Mechanistic reference solve' });
    await context.checkpoint();

    const diffusion = buildDiffusion(input.observations, network);
    const perturbedContext: TissueContext = {
      capacity: direct.capacity,
      exogenous: direct.exogenous,
      diffusion,
      ligandReference: input.ligandReference,
    };
    const solved = solveTissue(directState, network, perturbedContext, direct.clamp, {
      innerSteps: 40,
      stages: input.stages - 1,
      dt: 0.1,
      tolerance: 0,
      ligandGain: 1.6,
      fieldCutoffFactor: 3,
      ligandReference: input.ligandReference,
    });

    const mechanismFinal = solved.stages[solved.stages.length - 1] as TissueState;
    const mechanismDelta: number[] = [];
    const modelDelta: number[] = [];
    for (let i = 0; i < baseline.activity.length; i += 1) {
      mechanismDelta.push((mechanismFinal.activity[i] as number) - (baseline.activity[i] as number));
      modelDelta.push((finalState.activity[i] as number) - (baseline.activity[i] as number));
    }

    // Per stage, so error compounding across the rollout is visible rather
    // than collapsed into one figure.
    const perStageRmse: number[] = [];
    if (prediction) {
      for (let stage = 1; stage < Math.min(solved.stages.length, prediction.stages.length); stage += 1) {
        const mechanismStage = solved.stages[stage] as TissueState;
        const modelStage = (prediction.stages[stage] as { state: TissueState }).state;
        perStageRmse.push(rootMeanSquareError(modelStage.activity, mechanismStage.activity));
      }
    }

    mechanisticReference = {
      ran: true,
      reason:
        `The mechanism that generated this case was re-solved under the same perturbation, for ${solved.stagesRun} stage(s). ` +
        'This is a simulated reference, not an observation: it is the answer the model was fitted to reproduce, and agreement with it ' +
        'says the model learned the mechanism — not that either is right about tissue.' +
        (prediction ? '' : ' No model pack is installed, so there is no prediction to compare it with and no agreement figure is reported.'),
      agreement: prediction
        ? {
            pearson: pearson(modelDelta, mechanismDelta),
            rmse: rootMeanSquareError(modelDelta, mechanismDelta),
            perStageRmse,
          }
        : null,
      nodeMeanDelta: perNodeMean(
        Float64Array.from(mechanismDelta),
        baseline.observationCount,
        baseline.nodeCount,
      ),
    };
    store.writeArtefact(input.runId, 'mechanistic-reference', {
      ...mechanisticReference,
      perCellMagnitude: perCellMagnitude(Float64Array.from(mechanismDelta), baseline.nodeCount),
    });
  }

  // -- assemble -------------------------------------------------------------

  await context.report({ fraction: 0.95, message: 'Writing results' });
  await context.checkpoint();

  const artefacts: PredictionArtefacts = {
    perturbationId: definition.id,
    direct: {
      magnitude: Array.from(direct.magnitude),
      targetNodes: direct.targetNodes,
      terms: direct.terms,
      warnings: direct.warnings,
      quantitative: direct.quantitative,
      method: direct.method,
      effectByNode,
    },
    propagation: {
      available: prediction !== null,
      unavailableReason,
      modelId: prediction?.modelId ?? '',
      modelVersion: prediction?.modelVersion ?? '',
      graphId: input.graph.graphId,
      members: prediction?.members ?? 0,
      stages: (prediction?.stages ?? []).map((stage) => ({
        stage: stage.stage,
        label: stage.label,
        magnitude: perCellMagnitude(stage.cumulativeDelta, baseline.nodeCount),
        stepMagnitude: perCellMagnitude(stage.stepDelta, baseline.nodeCount),
        nodeMeanDelta: perNodeMean(stage.cumulativeDelta, baseline.observationCount, baseline.nodeCount),
      })),
      stageCaveat:
        'T0–T4 count rounds of intercellular signalling in the model, not hours or days. This model is not calibrated on ' +
        'biological time, so translating a stage into a duration would be a kinetic claim nothing here supports (§7.8).',
      disagreement: Array.from(prediction?.disagreement ?? []),
    },
    altered: {
      nodeMeanDelta: Array.from(difference.nodeMeanDelta),
      observationMagnitude: Array.from(difference.observationMagnitude),
      byClass: difference.byClass.map((entry) => ({
        className: entry.className,
        count: entry.count,
        nodeMeanDelta: Array.from(entry.nodeMeanDelta),
      })),
      meanMagnitude: difference.meanMagnitude,
      changedFraction: difference.changedFraction,
    },
    adverse: {
      ...adverse,
      components: adverse.components.map(({ delta, ...rest }) => {
        void delta;
        return rest;
      }),
      componentDeltas: Object.fromEntries(adverse.components.map((c) => [c.signatureId, Array.from(c.delta)])),
    },
    recovery,
    uncertainty: (() => {
      const { perObservation, ...rest } = uncertainty;
      void perObservation;
      return { ...rest, domain };
    })(),
    mechanisticReference,
    confidence,
    nodeSymbols,
  };

  store.writeArtefact(runId, 'prediction', artefacts);
  store.writeArtefact(runId, 'uncertainty-per-cell', Array.from(uncertainty.perObservation));

  /*
   * The full per-cell, per-node change.
   *
   * Stored separately because it is the largest artefact in a run — 2,400 cells
   * by 66 nodes — and because it is what a per-gene delta layer and the
   * machine-readable export both read. Rounded to six significant figures,
   * which is finer than the solver tolerance the targets themselves carry.
   */
  store.writeArtefact(runId, 'final-delta', {
    nodeSymbols,
    observationCount: baseline.observationCount,
    values: Array.from(difference.nodeDelta, (value) => Number(value.toPrecision(6))),
  });

  return { artefacts, alteredState: finalState, difference };
}

function perCellMagnitude(delta: Float64Array, nodeCount: number): number[] {
  const n = delta.length / nodeCount;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i += 1) {
    let squared = 0;
    for (let node = 0; node < nodeCount; node += 1) {
      const value = delta[i * nodeCount + node] as number;
      squared += value * value;
    }
    out[i] = Math.sqrt(squared / nodeCount);
  }
  return out;
}

function perNodeMean(delta: Float64Array, observationCount: number, nodeCount: number): number[] {
  const out = new Array<number>(nodeCount).fill(0);
  for (let i = 0; i < observationCount; i += 1) {
    for (let node = 0; node < nodeCount; node += 1) {
      out[node] = (out[node] as number) + (delta[i * nodeCount + node] as number);
    }
  }
  for (let node = 0; node < nodeCount; node += 1) out[node] = (out[node] as number) / Math.max(1, observationCount);
  return out;
}


