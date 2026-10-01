/**
 * Inference: rolling the one-step operator forward into a stage-resolved
 * prediction, with an ensemble for uncertainty.
 *
 * §6.14 requires per-stage node states, delta features, uncertainty and the
 * model/graph versions to be stored, and first-neighbour to be separable from
 * later stages. All of that falls out of the rollout: stage 1 is the direct
 * response with no message passing applied to it yet, stage 2 is one round of
 * neighbourhood exchange, and so on.
 *
 * Uncertainty comes from a deep ensemble — several independently initialised
 * models trained on the same data. It is the method with the fewest assumptions
 * available at this scale, and its disagreement is a real and useful signal:
 * cells where the members disagree are cells whose response was not determined
 * by the training data.
 */

import type { SpatialGraph } from '../spatial/graph';
import { normaliseAdjacency, emptyAdjacency, forward, type GnnWeights, type NormalisedAdjacency } from './gnn';
import { buildFeatures, classIndices, type FeatureSchema } from './features';
import { cloneState, type TissueState } from './mechanism';

export interface PredictionInput {
  baseline: TissueState;
  /** The state after the direct response has been applied (stage 1). */
  directState: TissueState;
  directEffect: Float64Array;
  graph: SpatialGraph;
  labels: (string | undefined)[];
  stages: number;
  /** Set to drop an edge class, for the §14.3 ablations. */
  ablate?: 'physical' | 'biological' | 'none';
}

export interface StagePrediction {
  stage: number;
  label: string;
  state: TissueState;
  /** Change from the previous stage. */
  stepDelta: Float64Array;
  /** Change from baseline. */
  cumulativeDelta: Float64Array;
  /** Ensemble standard deviation per node, where an ensemble was used. */
  dispersion: Float64Array | null;
}

export interface PredictionResult {
  stages: StagePrediction[];
  /** Ensemble members that contributed. */
  members: number;
  modelId: string;
  modelVersion: string;
  graphId: string;
  /** Per-observation ensemble disagreement at the final stage. */
  disagreement: Float64Array;
}

export interface LoadedModel {
  id: string;
  version: string;
  schema: FeatureSchema;
  members: GnnWeights[];
}

export function adjacenciesFor(
  graph: SpatialGraph,
  ablate: 'physical' | 'biological' | 'none' = 'none',
): NormalisedAdjacency[] {
  return [
    ablate === 'physical' ? emptyAdjacency(graph.nodeCount) : normaliseAdjacency(graph, 'physical'),
    ablate === 'biological' ? emptyAdjacency(graph.nodeCount) : normaliseAdjacency(graph, 'biological'),
  ];
}

export function predict(model: LoadedModel, input: PredictionInput): PredictionResult {
  const adjacencies = adjacenciesFor(input.graph, input.ablate ?? 'none');
  const classIndex = classIndices(input.labels, model.schema);
  const n = input.baseline.observationCount;
  const k = input.baseline.nodeCount;

  const stages: StagePrediction[] = [];

  // Stage 1 is the direct response itself. The model is not asked for it: it is
  // computed from evidence in `perturb/`, and having a learned model overwrite
  // an evidence-parameterised value would invert the whole §2.3 separation.
  let current = cloneState(input.directState);
  stages.push({
    stage: 1,
    label: 'T1 Direct',
    state: cloneState(current),
    stepDelta: difference(input.baseline, current),
    cumulativeDelta: difference(input.baseline, current),
    dispersion: null,
  });

  for (let stage = 2; stage <= input.stages; stage += 1) {
    const features = buildFeatures(
      {
        current,
        baseline: input.baseline,
        directEffect: input.directEffect,
        classIndex,
        stage: stage - 1,
        totalStages: input.stages,
      },
      model.schema,
    );

    const memberDeltas: Float64Array[] = [];
    for (const weights of model.members) {
      memberDeltas.push(forward(weights, features, n, adjacencies).output);
    }

    const mean = new Float64Array(n * k);
    const dispersion = new Float64Array(n * k);
    for (let i = 0; i < mean.length; i += 1) {
      let total = 0;
      for (const delta of memberDeltas) total += delta[i] as number;
      const mu = total / memberDeltas.length;
      mean[i] = mu;
      if (memberDeltas.length > 1) {
        let ss = 0;
        for (const delta of memberDeltas) {
          const d = (delta[i] as number) - mu;
          ss += d * d;
        }
        dispersion[i] = Math.sqrt(ss / (memberDeltas.length - 1));
      }
    }

    const next: TissueState = {
      activity: new Float64Array(n * k),
      observationCount: n,
      nodeCount: k,
    };
    for (let i = 0; i < next.activity.length; i += 1) {
      // Clamped to [0, 1]: activity is a bounded quantity in this model, and a
      // rollout that drifts outside it is reporting something the state space
      // does not contain.
      next.activity[i] = Math.min(1, Math.max(0, (current.activity[i] as number) + (mean[i] as number)));
    }

    stages.push({
      stage,
      label: stage === 2 ? 'T2 First neighbour' : stage === input.stages ? 'Final' : `T${stage} Propagation`,
      state: cloneState(next),
      stepDelta: difference(current, next),
      cumulativeDelta: difference(input.baseline, next),
      dispersion: memberDeltas.length > 1 ? dispersion : null,
    });

    current = next;
  }

  const finalDispersion = stages[stages.length - 1]?.dispersion ?? null;
  const disagreement = new Float64Array(n);
  if (finalDispersion) {
    for (let i = 0; i < n; i += 1) {
      let largest = 0;
      for (let node = 0; node < k; node += 1) {
        const value = finalDispersion[i * k + node] as number;
        if (value > largest) largest = value;
      }
      disagreement[i] = largest;
    }
  } else {
    disagreement.fill(Number.NaN);
  }

  return {
    stages,
    members: model.members.length,
    modelId: model.id,
    modelVersion: model.version,
    graphId: input.graph.graphId,
    disagreement,
  };
}

function difference(from: TissueState, to: TissueState): Float64Array {
  const out = new Float64Array(from.activity.length);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = (to.activity[i] as number) - (from.activity[i] as number);
  }
  return out;
}
