/**
 * Training the spatial predictive model, and the baselines it has to beat.
 *
 * §14.3 lists seven minimum baselines and this module implements all of them,
 * because the number that matters is not the model's error — it is the gap
 * between the model's error and the error of something that cannot see the
 * neighbourhood. A spatial model with an R² of 0.9 that a graph-free model of
 * the same capacity also reaches has demonstrated nothing about space, and
 * reporting only the 0.9 would be the most effective way to hide that.
 */

import { Rng, RandomState } from '../core/rng';
import { pearson, spearman, meanAbsoluteError, rootMeanSquareError, cosineSimilarity, mean } from '../core/stats';
import { ridgeSolve, Matrix } from '../core/matrix';
import {
  adamStep, backward, clipGradients, forward, initialiseAdam, initialiseWeights, mseLoss,
  normaliseAdjacency, emptyAdjacency, zeroGradients,
  type GnnConfig, type GnnWeights, type NormalisedAdjacency,
} from '../propagate/gnn';
import { buildFeatures, classIndices, deriveTargetScale, type FeatureSchema } from '../propagate/features';
import { shuffleGraph } from '../spatial/graph';
import type { CorpusExample } from './corpus';

// ---------------------------------------------------------------------------
// Sample construction
// ---------------------------------------------------------------------------

export interface TrainingSample {
  exampleId: string;
  features: Float64Array;
  target: Float64Array;
  adjacencies: NormalisedAdjacency[];
  nodeCount: number;
}

/**
 * One sample per stage transition.
 *
 * Teacher forcing: each step starts from the mechanism's true previous state,
 * not from the model's own prediction. Training on its own rollout instead
 * would be training on a moving target in the early epochs, and the model
 * spends them learning to correct errors it no longer makes. The rollout is
 * *evaluated* separately, which is where the compounding cost shows up
 * honestly.
 */
export function samplesFor(
  example: CorpusExample,
  schema: FeatureSchema,
  adjacencies: NormalisedAdjacency[],
): TrainingSample[] {
  const samples: TrainingSample[] = [];
  const classIndex = classIndices(example.labels, schema);
  const totalStages = example.truth.length - 1;

  for (let stage = 1; stage < example.truth.length; stage += 1) {
    const previous = example.truth[stage - 1];
    const next = example.truth[stage];
    if (!previous || !next) continue;

    const features = buildFeatures(
      {
        current: previous,
        baseline: example.baseline,
        directEffect: example.directEffect,
        classIndex,
        stage,
        totalStages,
      },
      schema,
    );

    // Scaled into the range the loss can see. `predictStep` inverts it, so
    // everything outside this function still works in activity units.
    const k = schema.nodeSymbols.length;
    const target = new Float64Array(next.activity.length);
    for (let i = 0; i < target.length; i += 1) {
      target[i] =
        ((next.activity[i] as number) - (previous.activity[i] as number)) /
        (schema.targetScale[i % k] as number);
    }

    samples.push({
      exampleId: `${example.id}@${stage}`,
      features,
      target,
      adjacencies,
      nodeCount: example.observationCount,
    });
  }
  return samples;
}

export function adjacenciesForExample(
  example: CorpusExample,
  variant: ModelVariant,
  rng?: Rng,
): NormalisedAdjacency[] {
  switch (variant) {
    case 'gnn':
      return [normaliseAdjacency(example.graph, 'physical'), normaliseAdjacency(example.graph, 'biological')];
    case 'gnn-no-biological':
      return [normaliseAdjacency(example.graph, 'physical'), emptyAdjacency(example.graph.nodeCount)];
    case 'gnn-no-spatial':
      return [emptyAdjacency(example.graph.nodeCount), normaliseAdjacency(example.graph, 'biological')];
    case 'mlp':
    case 'linear':
    case 'zero':
      return [emptyAdjacency(example.graph.nodeCount), emptyAdjacency(example.graph.nodeCount)];
    case 'gnn-shuffled': {
      const permutation = (rng ?? new Rng(1)).permutation(example.graph.nodeCount);
      const shuffled = shuffleGraph(example.graph, permutation);
      return [normaliseAdjacency(shuffled, 'physical'), normaliseAdjacency(shuffled, 'biological')];
    }
  }
}

export { deriveTargetScale };

export type ModelVariant =
  | 'gnn'
  | 'gnn-no-biological'
  | 'gnn-no-spatial'
  | 'gnn-shuffled'
  | 'mlp'
  | 'linear'
  | 'zero';

export const VARIANT_DESCRIPTION: Record<ModelVariant, string> = {
  gnn: 'The spatial model: message passing over physical and biological edges.',
  'gnn-no-biological': 'Ablation: physical proximity edges only.',
  'gnn-no-spatial': 'Ablation: biological interaction edges only.',
  'gnn-shuffled': 'Control: the same degree sequence with permuted neighbours. Any skill here is not spatial.',
  mlp: 'Baseline: the same architecture with every edge removed. Sees the cell, not its neighbourhood.',
  linear: 'Baseline: ridge regression on the same node features.',
  zero: 'Baseline: direct effect only, no propagation. The floor any spatial model has to clear.',
};

// ---------------------------------------------------------------------------
// Training
// ---------------------------------------------------------------------------

export interface TrainOptions {
  epochs: number;
  learningRate: number;
  /** Cosine decay to this fraction of the initial rate. */
  finalLearningRateFraction: number;
  gradientClip: number;
  seed: number;
  /** Stop when validation loss has not improved for this many epochs. */
  patience: number;
  /** Called after each epoch, for progress reporting. */
  onEpoch?: (info: EpochInfo) => void;
}

export interface EpochInfo {
  epoch: number;
  trainLoss: number;
  validationLoss: number;
  learningRate: number;
  gradientNorm: number;
  seconds: number;
  improved: boolean;
}

export const DEFAULT_TRAIN: TrainOptions = {
  epochs: 60,
  learningRate: 0.004,
  finalLearningRateFraction: 0.05,
  gradientClip: 2,
  seed: 1234,
  patience: 12,
};

export interface TrainedModel {
  weights: GnnWeights;
  variant: ModelVariant;
  history: EpochInfo[];
  bestEpoch: number;
  bestValidationLoss: number;
}

export function trainGnn(
  config: GnnConfig,
  schema: FeatureSchema,
  trainExamples: CorpusExample[],
  validationExamples: CorpusExample[],
  variant: ModelVariant,
  options: TrainOptions,
): TrainedModel {
  const random = new RandomState(options.seed);
  const weights = initialiseWeights(config, random.stream(`init.${variant}`));
  const optimiser = initialiseAdam(weights);
  const shuffleRng = random.stream(`shuffle.${variant}`);
  const controlRng = random.stream(`control.${variant}`);

  const trainSamples = trainExamples.flatMap((example) =>
    samplesFor(example, schema, adjacenciesForExample(example, variant, controlRng)),
  );
  const validationSamples = validationExamples.flatMap((example) =>
    samplesFor(example, schema, adjacenciesForExample(example, variant, controlRng)),
  );

  const history: EpochInfo[] = [];
  let best: Float64Array[] | null = null;
  let bestLoss = Infinity;
  let bestEpoch = 0;
  let sinceImprovement = 0;

  for (let epoch = 1; epoch <= options.epochs; epoch += 1) {
    const started = Date.now();
    // Cosine decay. A constant rate leaves the last epochs bouncing around the
    // optimum and the final weights are wherever the last batch left them.
    const progress = (epoch - 1) / Math.max(1, options.epochs - 1);
    const learningRate =
      options.learningRate *
      (options.finalLearningRateFraction +
        (1 - options.finalLearningRateFraction) * 0.5 * (1 + Math.cos(Math.PI * progress)));

    const order = shuffleRng.shuffle(trainSamples.map((_, index) => index));
    let trainLoss = 0;
    let largestNorm = 0;

    for (const index of order) {
      const sample = trainSamples[index] as TrainingSample;
      const cache = forward(weights, sample.features, sample.nodeCount, sample.adjacencies);
      const outputGradient = new Float64Array(cache.output.length);
      trainLoss += mseLoss(cache.output, sample.target, outputGradient);

      const gradients = zeroGradients(weights);
      backward(weights, sample.features, cache, outputGradient, sample.adjacencies, gradients);
      const norm = clipGradients(gradients, options.gradientClip);
      if (norm > largestNorm) largestNorm = norm;
      adamStep(weights, gradients, optimiser, learningRate);
    }
    trainLoss /= Math.max(1, trainSamples.length);

    let validationLoss = 0;
    for (const sample of validationSamples) {
      const cache = forward(weights, sample.features, sample.nodeCount, sample.adjacencies);
      const scratch = new Float64Array(cache.output.length);
      validationLoss += mseLoss(cache.output, sample.target, scratch);
    }
    validationLoss /= Math.max(1, validationSamples.length);

    const improved = validationLoss < bestLoss - 1e-9;
    if (improved) {
      bestLoss = validationLoss;
      bestEpoch = epoch;
      best = snapshot(weights);
      sinceImprovement = 0;
    } else {
      sinceImprovement += 1;
    }

    const info: EpochInfo = {
      epoch,
      trainLoss,
      validationLoss,
      learningRate,
      gradientNorm: largestNorm,
      seconds: (Date.now() - started) / 1000,
      improved,
    };
    history.push(info);
    options.onEpoch?.(info);

    if (sinceImprovement >= options.patience) break;
  }

  // The returned model is the best on validation, not the last one trained.
  if (best) restore(weights, best);

  return { weights, variant, history, bestEpoch, bestValidationLoss: bestLoss };
}

function snapshot(weights: GnnWeights): Float64Array[] {
  const out: Float64Array[] = [Float64Array.from(weights.encoderWeight), Float64Array.from(weights.encoderBias)];
  for (const self of weights.layerSelf) out.push(Float64Array.from(self));
  for (const row of weights.layerMessage) for (const message of row) out.push(Float64Array.from(message));
  for (const bias of weights.layerBias) out.push(Float64Array.from(bias));
  out.push(Float64Array.from(weights.decoderWeight), Float64Array.from(weights.decoderBias));
  return out;
}

function restore(weights: GnnWeights, values: Float64Array[]): void {
  let index = 0;
  weights.encoderWeight.set(values[index++] as Float64Array);
  weights.encoderBias.set(values[index++] as Float64Array);
  for (const self of weights.layerSelf) self.set(values[index++] as Float64Array);
  for (const row of weights.layerMessage) for (const message of row) message.set(values[index++] as Float64Array);
  for (const bias of weights.layerBias) bias.set(values[index++] as Float64Array);
  weights.decoderWeight.set(values[index++] as Float64Array);
  weights.decoderBias.set(values[index++] as Float64Array);
}

// ---------------------------------------------------------------------------
// The non-neural baselines
// ---------------------------------------------------------------------------

export interface LinearModel {
  /** outputDim x inputDim+1 coefficients, last column being the intercept. */
  coefficients: Float64Array;
  inputDim: number;
  outputDim: number;
}

/**
 * Ridge regression on the same features, fitted per output dimension.
 *
 * Present because §14.3 asks for it, and because it is genuinely informative:
 * if a linear model on node features reaches most of the GNN's score, the
 * response is mostly a function of the cell's own state and the network is
 * earning very little.
 */
export function trainLinear(
  examples: CorpusExample[],
  schema: FeatureSchema,
  inputDim: number,
  outputDim: number,
  lambda = 1,
  maximumRows = 60_000,
  seed = 99,
): LinearModel {
  const rows: Float64Array[] = [];
  const targets: Float64Array[] = [];
  const rng = new RandomState(seed).stream('linear.subsample');

  for (const example of examples) {
    for (const sample of samplesFor(example, schema, adjacenciesForExample(example, 'linear'))) {
      for (let i = 0; i < sample.nodeCount; i += 1) {
        rows.push(sample.features.subarray(i * inputDim, (i + 1) * inputDim) as Float64Array);
        targets.push(sample.target.subarray(i * outputDim, (i + 1) * outputDim) as Float64Array);
      }
    }
  }

  // Subsampled: the normal equations are O(rows * inputDim^2) and a third of a
  // million rows buys nothing over sixty thousand for a 200-parameter fit.
  let indices = rows.map((_, i) => i);
  if (indices.length > maximumRows) indices = rng.shuffle(indices).slice(0, maximumRows);

  const design = new Matrix(indices.length, inputDim + 1);
  for (let r = 0; r < indices.length; r += 1) {
    const row = rows[indices[r] as number] as Float64Array;
    for (let c = 0; c < inputDim; c += 1) design.set(r, c, row[c] as number);
    design.set(r, inputDim, 1);
  }

  const coefficients = new Float64Array(outputDim * (inputDim + 1));
  const y = new Float64Array(indices.length);
  for (let d = 0; d < outputDim; d += 1) {
    for (let r = 0; r < indices.length; r += 1) {
      y[r] = (targets[indices[r] as number] as Float64Array)[d] as number;
    }
    const solution = ridgeSolve(design, y, lambda);
    coefficients.set(solution, d * (inputDim + 1));
  }

  return { coefficients, inputDim, outputDim };
}

export function predictLinear(model: LinearModel, features: Float64Array, nodeCount: number): Float64Array {
  const out = new Float64Array(nodeCount * model.outputDim);
  const width = model.inputDim + 1;
  for (let i = 0; i < nodeCount; i += 1) {
    for (let d = 0; d < model.outputDim; d += 1) {
      let total = model.coefficients[d * width + model.inputDim] as number;
      for (let c = 0; c < model.inputDim; c += 1) {
        total += (model.coefficients[d * width + c] as number) * (features[i * model.inputDim + c] as number);
      }
      out[i * model.outputDim + d] = total;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export interface EvaluationMetrics {
  variant: ModelVariant;
  /** One-step, teacher forced. */
  stepMse: number;
  stepMae: number;
  stepPearson: number;
  stepSpearman: number;
  /** Full rollout from the direct state to the final stage. */
  rolloutRmse: number;
  rolloutPearson: number;
  rolloutCosine: number;
  /** Fraction of the target variance the model explains on the rollout. */
  rolloutR2: number;
  /** Rollout error restricted to cells the perturbation did not touch. */
  bystanderRmse: number;
  bystanderPearson: number;
  /**
   * The first-neighbour step, on untouched cells only.
   *
   * This is the metric that isolates the spatial claim, and the reason it is
   * reported separately is that the headline rollout numbers understate the
   * graph's contribution — badly. From stage 2 onward a bystander's own feature
   * vector already carries its accumulated change, so the model can extrapolate
   * its trajectory without consulting anyone. Only at the first propagation
   * step is every untouched cell's input identical whatever its distance from
   * the perturbed zone, so the neighbourhood is the only thing that can tell
   * them apart.
   *
   * A graph-free baseline is structurally incapable of beating a constant here.
   * If the GNN does not either, the spatial model is not doing spatial work,
   * and that is what this number is for.
   */
  firstNeighbourRmse: number;
  firstNeighbourPearson: number;
  /** The same, for the shuffled-graph control's benefit: how much is location. */
  firstNeighbourR2: number;
  /** Per-stage rollout RMSE, so error compounding is visible. */
  perStageRmse: number[];
  examples: number;
  cells: number;
}

export interface Predictor {
  variant: ModelVariant;
  predictStep: (features: Float64Array, nodeCount: number, adjacencies: NormalisedAdjacency[]) => Float64Array;
}

export function gnnPredictor(weights: GnnWeights, variant: ModelVariant, schema: FeatureSchema): Predictor {
  const k = schema.nodeSymbols.length;
  return {
    variant,
    predictStep: (features, nodeCount, adjacencies) => {
      const output = forward(weights, features, nodeCount, adjacencies).output;
      const out = new Float64Array(output.length);
      for (let i = 0; i < output.length; i += 1) {
        out[i] = (output[i] as number) * (schema.targetScale[i % k] as number);
      }
      return out;
    },
  };
}

export function linearPredictor(model: LinearModel, schema: FeatureSchema): Predictor {
  const k = schema.nodeSymbols.length;
  return {
    variant: 'linear',
    predictStep: (features, nodeCount) => {
      const output = predictLinear(model, features, nodeCount);
      for (let i = 0; i < output.length; i += 1) {
        output[i] = (output[i] as number) * (schema.targetScale[i % k] as number);
      }
      return output;
    },
  };
}

/**
 * §14.3's "direct-effect-only / no-neighbour baseline".
 *
 * It predicts no further change after the direct response, so its rollout is
 * the direct effect and nothing else. Its correlation with the truth is not
 * zero — a perturbation's largest effect is usually in the cells it was applied
 * to — and that is exactly why it is the baseline to beat: any model that
 * cannot clear it has added nothing to "the drug affects the cells it reaches".
 */
export function directOnlyPredictor(outputDim: number): Predictor {
  return {
    variant: 'zero',
    predictStep: (_features, nodeCount) => new Float64Array(nodeCount * outputDim),
  };
}

export const zeroPredictor = directOnlyPredictor;

export function evaluate(
  predictor: Predictor,
  examples: CorpusExample[],
  schema: FeatureSchema,
  controlRng?: Rng,
): EvaluationMetrics {
  const stepPredictions: number[] = [];
  const stepTargets: number[] = [];
  const rolloutPredictions: number[] = [];
  const rolloutTargets: number[] = [];
  const bystanderPredictions: number[] = [];
  const bystanderTargets: number[] = [];
  const perStageSquared: number[] = [];
  const perStageCount: number[] = [];
  const firstNeighbourPredictions: number[] = [];
  const firstNeighbourTargets: number[] = [];
  let cells = 0;

  for (const example of examples) {
    const adjacencies = adjacenciesForExample(example, predictor.variant, controlRng);
    const classIndex = classIndices(example.labels, schema);
    const totalStages = example.truth.length - 1;
    const k = example.nodeCount;
    cells += example.observationCount;

    // Which cells were directly perturbed, so the bystander metric can exclude
    // them. The whole spatial claim lives in the cells nothing was done to.
    const directlyTouched = new Uint8Array(example.observationCount);
    for (let i = 0; i < example.observationCount; i += 1) {
      for (const node of example.targetNodes) {
        if (Math.abs(example.directEffect[i * k + node] as number) > 1e-9) {
          directlyTouched[i] = 1;
          break;
        }
      }
    }

    // One-step, teacher forced.
    for (let stage = 1; stage < example.truth.length; stage += 1) {
      const previous = example.truth[stage - 1];
      const next = example.truth[stage];
      if (!previous || !next) continue;
      const features = buildFeatures(
        { current: previous, baseline: example.baseline, directEffect: example.directEffect, classIndex, stage, totalStages },
        schema,
      );
      const prediction = predictor.predictStep(features, example.observationCount, adjacencies);
      for (let i = 0; i < prediction.length; i += 1) {
        stepPredictions.push(prediction[i] as number);
        stepTargets.push((next.activity[i] as number) - (previous.activity[i] as number));
      }

      // The first propagation step, on untouched cells only.
      if (stage === 1) {
        for (let i = 0; i < example.observationCount; i += 1) {
          if ((directlyTouched[i] as number) === 1) continue;
          for (let node = 0; node < k; node += 1) {
            const offset = i * k + node;
            firstNeighbourPredictions.push(prediction[offset] as number);
            firstNeighbourTargets.push((next.activity[offset] as number) - (previous.activity[offset] as number));
          }
        }
      }
    }

    // Full rollout.
    let current = {
      activity: Float64Array.from((example.truth[0] as { activity: Float64Array }).activity),
      observationCount: example.observationCount,
      nodeCount: k,
    };
    for (let stage = 1; stage < example.truth.length; stage += 1) {
      const features = buildFeatures(
        { current, baseline: example.baseline, directEffect: example.directEffect, classIndex, stage, totalStages },
        schema,
      );
      const prediction = predictor.predictStep(features, example.observationCount, adjacencies);
      const next = new Float64Array(current.activity.length);
      for (let i = 0; i < next.length; i += 1) {
        next[i] = Math.min(1, Math.max(0, (current.activity[i] as number) + (prediction[i] as number)));
      }
      current = { activity: next, observationCount: example.observationCount, nodeCount: k };

      const truth = example.truth[stage] as { activity: Float64Array };
      let squared = 0;
      for (let i = 0; i < next.length; i += 1) {
        const error = (next[i] as number) - (truth.activity[i] as number);
        squared += error * error;
      }
      perStageSquared[stage - 1] = (perStageSquared[stage - 1] ?? 0) + squared;
      perStageCount[stage - 1] = (perStageCount[stage - 1] ?? 0) + next.length;
    }

    const finalTruth = example.truth[example.truth.length - 1] as { activity: Float64Array };
    for (let i = 0; i < example.observationCount; i += 1) {
      for (let node = 0; node < k; node += 1) {
        const offset = i * k + node;
        const predictedDelta = (current.activity[offset] as number) - (example.baseline.activity[offset] as number);
        const trueDelta = (finalTruth.activity[offset] as number) - (example.baseline.activity[offset] as number);
        rolloutPredictions.push(predictedDelta);
        rolloutTargets.push(trueDelta);
        if ((directlyTouched[i] as number) === 0) {
          bystanderPredictions.push(predictedDelta);
          bystanderTargets.push(trueDelta);
        }
      }
    }
  }

  const firstNeighbourMean = mean(firstNeighbourTargets);
  let firstNeighbourTotal = 0;
  let firstNeighbourResidual = 0;
  for (let i = 0; i < firstNeighbourTargets.length; i += 1) {
    const target = firstNeighbourTargets[i] as number;
    firstNeighbourTotal += (target - firstNeighbourMean) * (target - firstNeighbourMean);
    const error = target - (firstNeighbourPredictions[i] as number);
    firstNeighbourResidual += error * error;
  }

  const targetMean = mean(rolloutTargets);
  let totalSumSquares = 0;
  let residualSumSquares = 0;
  for (let i = 0; i < rolloutTargets.length; i += 1) {
    const target = rolloutTargets[i] as number;
    totalSumSquares += (target - targetMean) * (target - targetMean);
    const error = target - (rolloutPredictions[i] as number);
    residualSumSquares += error * error;
  }

  return {
    variant: predictor.variant,
    stepMse: rootMeanSquareError(stepPredictions, stepTargets) ** 2,
    stepMae: meanAbsoluteError(stepPredictions, stepTargets),
    stepPearson: pearson(stepPredictions, stepTargets),
    stepSpearman: sampledSpearman(stepPredictions, stepTargets),
    rolloutRmse: rootMeanSquareError(rolloutPredictions, rolloutTargets),
    rolloutPearson: pearson(rolloutPredictions, rolloutTargets),
    rolloutCosine: cosineSimilarity(rolloutPredictions, rolloutTargets),
    rolloutR2: totalSumSquares > 0 ? 1 - residualSumSquares / totalSumSquares : Number.NaN,
    bystanderRmse: rootMeanSquareError(bystanderPredictions, bystanderTargets),
    bystanderPearson: pearson(bystanderPredictions, bystanderTargets),
    firstNeighbourRmse: rootMeanSquareError(firstNeighbourPredictions, firstNeighbourTargets),
    firstNeighbourPearson: pearson(firstNeighbourPredictions, firstNeighbourTargets),
    firstNeighbourR2: firstNeighbourTotal > 0 ? 1 - firstNeighbourResidual / firstNeighbourTotal : Number.NaN,
    perStageRmse: perStageSquared.map((total, index) => Math.sqrt(total / Math.max(1, perStageCount[index] ?? 1))),
    examples: examples.length,
    cells,
  };
}

/**
 * Spearman on a subsample.
 *
 * The full rank correlation would sort several million values per variant, and
 * the estimate is stable well before that. The subsample is deterministic so
 * the reported number does not move between runs.
 */
function sampledSpearman(a: number[], b: number[], limit = 50_000): number {
  if (a.length <= limit) return spearman(a, b);
  const stride = Math.ceil(a.length / limit);
  const sampledA: number[] = [];
  const sampledB: number[] = [];
  for (let i = 0; i < a.length; i += stride) {
    sampledA.push(a[i] as number);
    sampledB.push(b[i] as number);
  }
  return spearman(sampledA, sampledB);
}
