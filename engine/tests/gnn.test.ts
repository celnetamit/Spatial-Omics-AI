/**
 * The gradients, checked against finite differences.
 *
 * A backward pass with a sign error in one term does not crash and does not
 * produce obviously wrong output — it produces a model that trains to a worse
 * optimum, and the only symptom is a validation score nobody has anything to
 * compare with. So every parameter tensor is checked against a central
 * difference of the loss before any of this is used to train anything.
 */

import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import {
  adamStep, backward, clipGradients, deserialiseWeights, emptyAdjacency, forward,
  initialiseAdam, initialiseWeights, mseLoss, normaliseAdjacency, parameterCount,
  serialiseWeights, zeroGradients, type GnnConfig, type NormalisedAdjacency,
} from '../src/propagate/gnn';
import { buildSpatialGraph } from '../src/spatial/graph';
import type { ObservationRecord } from '../src/data/types';

function tinyGraph(n: number): ObservationRecord[] {
  const observations: ObservationRecord[] = [];
  for (let i = 0; i < n; i += 1) {
    observations.push({ id: `c${i}`, x: (i % 5) * 10, y: Math.floor(i / 5) * 10, sampleId: 's' });
  }
  return observations;
}

function setup(layers: number): {
  weights: ReturnType<typeof initialiseWeights>;
  features: Float64Array;
  target: Float64Array;
  adjacencies: NormalisedAdjacency[];
  n: number;
  config: GnnConfig;
} {
  const n = 15;
  const config: GnnConfig = {
    inputDim: 6, hiddenDim: 7, outputDim: 4, layers,
    edgeTypes: ['physical', 'biological'], weightDecay: 0,
  };
  const rng = new Rng(11);
  const weights = initialiseWeights(config, rng);

  const observations = tinyGraph(n);
  const graph = buildSpatialGraph(observations, { method: 'knn', k: 3 }, 'um', [
    { source: 0, target: 7, distance: 40, weight: 0.5, edgeType: 'biological' },
    { source: 7, target: 0, distance: 40, weight: 0.5, edgeType: 'biological' },
    { source: 3, target: 11, distance: 30, weight: 0.8, edgeType: 'biological' },
  ]);
  const adjacencies = [normaliseAdjacency(graph, 'physical'), normaliseAdjacency(graph, 'biological')];

  const features = new Float64Array(n * config.inputDim);
  for (let i = 0; i < features.length; i += 1) features[i] = rng.normal();
  const target = new Float64Array(n * config.outputDim);
  for (let i = 0; i < target.length; i += 1) target[i] = rng.normal(0, 0.3);

  return { weights, features, target, adjacencies, n, config };
}

function lossOf(
  weights: ReturnType<typeof initialiseWeights>,
  features: Float64Array,
  n: number,
  adjacencies: NormalisedAdjacency[],
  target: Float64Array,
): number {
  const cache = forward(weights, features, n, adjacencies);
  const gradient = new Float64Array(cache.output.length);
  return mseLoss(cache.output, target, gradient);
}

describe('GNN gradients', () => {
  for (const layers of [0, 1, 3]) {
    it(`match central differences with ${layers} message-passing layer(s)`, () => {
      const { weights, features, target, adjacencies, n } = setup(layers);

      const cache = forward(weights, features, n, adjacencies);
      const outputGradient = new Float64Array(cache.output.length);
      mseLoss(cache.output, target, outputGradient);
      const gradients = zeroGradients(weights);
      backward(weights, features, cache, outputGradient, adjacencies, gradients);

      const tensorPairs: [Float64Array, Float64Array, string][] = [
        [weights.encoderWeight, gradients.encoderWeight, 'encoderWeight'],
        [weights.encoderBias, gradients.encoderBias, 'encoderBias'],
        [weights.decoderWeight, gradients.decoderWeight, 'decoderWeight'],
        [weights.decoderBias, gradients.decoderBias, 'decoderBias'],
      ];
      for (let l = 0; l < layers; l += 1) {
        tensorPairs.push([weights.layerSelf[l] as Float64Array, gradients.layerSelf[l] as Float64Array, `layerSelf[${l}]`]);
        tensorPairs.push([weights.layerBias[l] as Float64Array, gradients.layerBias[l] as Float64Array, `layerBias[${l}]`]);
        for (let t = 0; t < 2; t += 1) {
          tensorPairs.push([
            (weights.layerMessage[l] as Float64Array[])[t] as Float64Array,
            (gradients.layerMessage[l] as Float64Array[])[t] as Float64Array,
            `layerMessage[${l}][${t}]`,
          ]);
        }
      }

      const epsilon = 1e-6;
      for (const [tensor, gradient, name] of tensorPairs) {
        // Every element of the small tensors, a sample of the large ones: the
        // point is coverage of each *kind* of parameter, and a full sweep of
        // every weight makes the test take a minute for no extra information.
        const stride = tensor.length > 24 ? Math.ceil(tensor.length / 12) : 1;
        for (let i = 0; i < tensor.length; i += stride) {
          const original = tensor[i] as number;
          tensor[i] = original + epsilon;
          const up = lossOf(weights, features, n, adjacencies, target);
          tensor[i] = original - epsilon;
          const down = lossOf(weights, features, n, adjacencies, target);
          tensor[i] = original;

          const numerical = (up - down) / (2 * epsilon);
          const analytic = gradient[i] as number;
          const scale = Math.max(1e-6, Math.abs(numerical) + Math.abs(analytic));
          expect(
            Math.abs(numerical - analytic) / scale,
            `${name}[${i}]: analytic ${analytic}, numerical ${numerical}`,
          ).toBeLessThan(1e-5);
        }
      }
    });
  }
});

describe('the graph-free ablation', () => {
  it('is the same architecture with the edges removed, not a smaller model', () => {
    const { weights, features, n } = setup(2);
    const empty = [emptyAdjacency(n), emptyAdjacency(n)];
    const cache = forward(weights, features, n, empty);
    expect(cache.output.length).toBe(n * weights.config.outputDim);
    // Every message is zero, so the prediction depends only on the node itself.
    for (const layer of cache.messages) {
      for (const message of layer) {
        for (let i = 0; i < message.length; i += 1) expect(message[i] as number).toBe(0);
      }
    }
    // Which means two nodes with identical features must get identical output.
    const twin = Float64Array.from(features);
    twin.copyWithin(0, weights.config.inputDim, weights.config.inputDim * 2);
    const twinCache = forward(weights, twin, n, empty);
    for (let d = 0; d < weights.config.outputDim; d += 1) {
      expect(twinCache.output[d] as number).toBeCloseTo(twinCache.output[weights.config.outputDim + d] as number, 12);
    }
  });
});

describe('optimisation', () => {
  it('reduces the loss on a fixed problem', () => {
    const { weights, features, target, adjacencies, n } = setup(2);
    const state = initialiseAdam(weights);
    const before = lossOf(weights, features, n, adjacencies, target);

    for (let step = 0; step < 150; step += 1) {
      const cache = forward(weights, features, n, adjacencies);
      const outputGradient = new Float64Array(cache.output.length);
      mseLoss(cache.output, target, outputGradient);
      const gradients = zeroGradients(weights);
      backward(weights, features, cache, outputGradient, adjacencies, gradients);
      clipGradients(gradients, 5);
      adamStep(weights, gradients, state, 0.02);
    }

    const after = lossOf(weights, features, n, adjacencies, target);
    expect(after).toBeLessThan(before * 0.2);
  });

  it('clips to the stated norm and reports the original', () => {
    const { weights } = setup(1);
    const gradients = zeroGradients(weights);
    gradients.decoderBias.fill(10);
    const norm = clipGradients(gradients, 1);
    expect(norm).toBeCloseTo(10 * Math.sqrt(weights.config.outputDim), 10);
    let clipped = 0;
    for (const value of gradients.decoderBias) clipped += value * value;
    expect(Math.sqrt(clipped)).toBeCloseTo(1, 10);
  });
});

describe('serialisation', () => {
  it('round-trips to the precision it stores', () => {
    const { weights, features, adjacencies, n } = setup(2);
    const before = forward(weights, features, n, adjacencies).output;

    const restored = deserialiseWeights(serialiseWeights(weights));
    const after = forward(restored, features, n, adjacencies).output;

    for (let i = 0; i < before.length; i += 1) {
      expect(after[i] as number).toBeCloseTo(before[i] as number, 5);
    }
    expect(parameterCount(restored)).toBe(parameterCount(weights));
  });

  it('refuses a pack that does not match the architecture', () => {
    const { weights } = setup(2);
    const serialised = serialiseWeights(weights);
    serialised.tensors[0] = [1, 2, 3];
    expect(() => deserialiseWeights(serialised)).toThrow(/needs/);
  });
});
