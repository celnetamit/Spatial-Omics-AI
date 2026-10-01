/**
 * The spatial predictive model — §6.14.
 *
 * An edge-type-aware message-passing network that predicts the per-cell change
 * a perturbation produces at steady state, given the baseline state, the direct
 * response and the graph. Forward and backward passes are written out here
 * rather than taken from a framework: the lab has to run the model inside the
 * same process that serves the API, on a machine with no GPU, and a 50,000
 * parameter network is small enough that an explicit implementation is both
 * faster to load and easier to audit than a dependency.
 *
 * WHAT IT IS TRAINED ON
 *
 * Perturbation/response pairs produced by the mechanistic solver in
 * `mechanism.ts`, on tissues held out at the *section* level (§14.4). So the
 * measured performance is "how well this network reproduces the mechanism it
 * was trained on", and that is what the model card says. It is not a claim
 * about tissue.
 *
 * WHY A GNN AT ALL, GIVEN THE MECHANISM IS AVAILABLE
 *
 * Because the point of §14.3 is to find out whether the spatial structure is
 * carrying anything. A message-passing model and a graph-free model of the same
 * capacity, trained on the same data, differ only in whether they can see the
 * neighbourhood — and if their held-out scores match, the neighbourhood was not
 * contributing, whatever the tissue map looked like. That comparison is the
 * deliverable; the model is how it is obtained.
 */

import { Rng } from '../core/rng';
import { contentHash } from '../core/provenance';
import type { SpatialGraph } from '../spatial/graph';

/**
 * The leak in the activation, and why it is not zero.
 *
 * A plain ReLU passes no gradient through a unit whose pre-activation is
 * negative, so a unit that lands there for every input in the training set
 * never recovers — it is dead, permanently. With enough of them the whole
 * network is stuck. That is not hypothetical here: with ReLU, ensemble member 2
 * sat at a training loss of 0.6625 from epoch two to epoch twenty without
 * moving a digit, while member 1 on a different seed reached 0.39. Two members
 * of such different quality make the ensemble's disagreement meaningless — it
 * would measure the dead member, not the uncertainty.
 *
 * A leak of 0.05 keeps a gradient flowing through the negative side at a
 * twentieth of the positive slope. The unit can recover; the non-linearity is
 * otherwise unchanged.
 */
const LEAK = 0.05;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface GnnConfig {
  /** Input features per node. */
  inputDim: number;
  hiddenDim: number;
  outputDim: number;
  /** Message-passing layers. Zero gives a plain MLP of the same width. */
  layers: number;
  /** Edge types the model aggregates over, in a fixed order. */
  edgeTypes: ('physical' | 'biological')[];
  /** L2 penalty applied in the optimiser. */
  weightDecay: number;
}

export interface GnnWeights {
  config: GnnConfig;
  /** Encoder: inputDim x hiddenDim, plus bias. */
  encoderWeight: Float64Array;
  encoderBias: Float64Array;
  /** Per layer: self, then one per edge type, each hiddenDim x hiddenDim. */
  layerSelf: Float64Array[];
  layerMessage: Float64Array[][];
  layerBias: Float64Array[];
  /** Decoder: hiddenDim x outputDim, plus bias. */
  decoderWeight: Float64Array;
  decoderBias: Float64Array;
  /** Set once the weights are frozen into a model pack. */
  checksum?: string;
}

/** Row-normalised adjacency for one edge type. */
export interface NormalisedAdjacency {
  indptr: Int32Array;
  indices: Int32Array;
  weights: Float64Array;
  /** Transposed form, needed by the backward pass. */
  tIndptr: Int32Array;
  tIndices: Int32Array;
  tWeights: Float64Array;
  nodeCount: number;
}

/**
 * Row-normalise an edge type's adjacency.
 *
 * Normalising per node is what makes the model transferable between sections of
 * different density. Without it a cell with twenty neighbours receives twenty
 * times the message a cell with one does, and the network learns local density
 * rather than local signalling — which then does not transfer to a section with
 * different cellularity.
 */
export function normaliseAdjacency(
  graph: SpatialGraph,
  edgeType: 'physical' | 'biological',
): NormalisedAdjacency {
  const n = graph.nodeCount;
  const lists: { index: number; weight: number }[][] = Array.from({ length: n }, () => []);
  for (const edge of graph.edges) {
    if (edge.edgeType !== edgeType) continue;
    (lists[edge.target] as { index: number; weight: number }[]).push({ index: edge.source, weight: edge.weight });
  }

  let total = 0;
  for (const list of lists) total += list.length;

  const indptr = new Int32Array(n + 1);
  const indices = new Int32Array(total);
  const weights = new Float64Array(total);
  let cursor = 0;
  for (let i = 0; i < n; i += 1) {
    indptr[i] = cursor;
    const list = lists[i] as { index: number; weight: number }[];
    let sum = 0;
    for (const entry of list) sum += entry.weight;
    for (const entry of list) {
      indices[cursor] = entry.index;
      weights[cursor] = sum > 0 ? entry.weight / sum : 0;
      cursor += 1;
    }
  }
  indptr[n] = cursor;

  // Transpose, built once: the backward pass needs A^T and rebuilding it per
  // step was measurably the largest cost in training.
  const outDegree = new Int32Array(n);
  for (let k = 0; k < total; k += 1) outDegree[indices[k] as number] = (outDegree[indices[k] as number] as number) + 1;
  const tIndptr = new Int32Array(n + 1);
  for (let i = 0; i < n; i += 1) tIndptr[i + 1] = (tIndptr[i] as number) + (outDegree[i] as number);
  const tIndices = new Int32Array(total);
  const tWeights = new Float64Array(total);
  const tCursor = Int32Array.from(tIndptr.subarray(0, n));
  for (let i = 0; i < n; i += 1) {
    for (let k = indptr[i] as number; k < (indptr[i + 1] as number); k += 1) {
      const source = indices[k] as number;
      const position = tCursor[source] as number;
      tIndices[position] = i;
      tWeights[position] = weights[k] as number;
      tCursor[source] = position + 1;
    }
  }

  return { indptr, indices, weights, tIndptr, tIndices, tWeights, nodeCount: n };
}

/** An adjacency with no edges — the graph-free ablation. */
export function emptyAdjacency(nodeCount: number): NormalisedAdjacency {
  const indptr = new Int32Array(nodeCount + 1);
  return {
    indptr,
    indices: new Int32Array(0),
    weights: new Float64Array(0),
    tIndptr: new Int32Array(nodeCount + 1),
    tIndices: new Int32Array(0),
    tWeights: new Float64Array(0),
    nodeCount,
  };
}

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

export function initialiseWeights(config: GnnConfig, rng: Rng): GnnWeights {
  const he = (fanIn: number): number => Math.sqrt(2 / fanIn);

  const encoderWeight = new Float64Array(config.inputDim * config.hiddenDim);
  for (let i = 0; i < encoderWeight.length; i += 1) encoderWeight[i] = rng.normal(0, he(config.inputDim));

  const layerSelf: Float64Array[] = [];
  const layerMessage: Float64Array[][] = [];
  const layerBias: Float64Array[] = [];
  for (let l = 0; l < config.layers; l += 1) {
    const self = new Float64Array(config.hiddenDim * config.hiddenDim);
    for (let i = 0; i < self.length; i += 1) self[i] = rng.normal(0, he(config.hiddenDim));
    layerSelf.push(self);

    const messages: Float64Array[] = [];
    for (let t = 0; t < config.edgeTypes.length; t += 1) {
      const message = new Float64Array(config.hiddenDim * config.hiddenDim);
      // Message weights start smaller than the self weights: at equal scale the
      // first epochs are dominated by neighbour noise and the model spends them
      // learning to ignore the graph.
      for (let i = 0; i < message.length; i += 1) message[i] = rng.normal(0, he(config.hiddenDim) * 0.5);
      messages.push(message);
    }
    layerMessage.push(messages);
    layerBias.push(new Float64Array(config.hiddenDim));
  }

  const decoderWeight = new Float64Array(config.hiddenDim * config.outputDim);
  for (let i = 0; i < decoderWeight.length; i += 1) decoderWeight[i] = rng.normal(0, he(config.hiddenDim));

  return {
    config,
    encoderWeight,
    encoderBias: new Float64Array(config.hiddenDim),
    layerSelf,
    layerMessage,
    layerBias,
    decoderWeight,
    decoderBias: new Float64Array(config.outputDim),
  };
}

export function parameterCount(weights: GnnWeights): number {
  let total = weights.encoderWeight.length + weights.encoderBias.length;
  for (const self of weights.layerSelf) total += self.length;
  for (const messages of weights.layerMessage) for (const message of messages) total += message.length;
  for (const bias of weights.layerBias) total += bias.length;
  total += weights.decoderWeight.length + weights.decoderBias.length;
  return total;
}

// ---------------------------------------------------------------------------
// Forward
// ---------------------------------------------------------------------------

export interface ForwardCache {
  /** Post-activation hidden states, one per layer plus the encoder output. */
  hidden: Float64Array[];
  /** Pre-activation values, kept for the ReLU derivative. */
  preActivation: Float64Array[];
  /** Aggregated messages per layer per edge type. */
  messages: Float64Array[][];
  nodeCount: number;
  output: Float64Array;
}

/** y = x @ W (+ b), where W is [inDim x outDim] row-major. */
function matmul(
  x: Float64Array, rows: number, inDim: number,
  w: Float64Array, outDim: number,
  bias: Float64Array | null,
  out: Float64Array,
): void {
  for (let i = 0; i < rows; i += 1) {
    const xOffset = i * inDim;
    const outOffset = i * outDim;
    if (bias) out.set(bias, outOffset);
    else out.fill(0, outOffset, outOffset + outDim);
    for (let k = 0; k < inDim; k += 1) {
      const value = x[xOffset + k] as number;
      if (value === 0) continue;
      const wOffset = k * outDim;
      for (let j = 0; j < outDim; j += 1) {
        out[outOffset + j] = (out[outOffset + j] as number) + value * (w[wOffset + j] as number);
      }
    }
  }
}

/** Sparse aggregate: out[i] = sum_j A[i,j] * h[j]. */
function aggregate(
  adjacency: NormalisedAdjacency,
  hidden: Float64Array,
  dim: number,
  out: Float64Array,
): void {
  out.fill(0);
  for (let i = 0; i < adjacency.nodeCount; i += 1) {
    const from = adjacency.indptr[i] as number;
    const to = adjacency.indptr[i + 1] as number;
    const outOffset = i * dim;
    for (let k = from; k < to; k += 1) {
      const weight = adjacency.weights[k] as number;
      const sourceOffset = (adjacency.indices[k] as number) * dim;
      for (let d = 0; d < dim; d += 1) {
        out[outOffset + d] = (out[outOffset + d] as number) + weight * (hidden[sourceOffset + d] as number);
      }
    }
  }
}

/** The transpose aggregate the backward pass needs. */
function aggregateTranspose(
  adjacency: NormalisedAdjacency,
  gradient: Float64Array,
  dim: number,
  out: Float64Array,
): void {
  for (let i = 0; i < adjacency.nodeCount; i += 1) {
    const from = adjacency.tIndptr[i] as number;
    const to = adjacency.tIndptr[i + 1] as number;
    const outOffset = i * dim;
    for (let k = from; k < to; k += 1) {
      const weight = adjacency.tWeights[k] as number;
      const targetOffset = (adjacency.tIndices[k] as number) * dim;
      for (let d = 0; d < dim; d += 1) {
        out[outOffset + d] = (out[outOffset + d] as number) + weight * (gradient[targetOffset + d] as number);
      }
    }
  }
}

export function forward(
  weights: GnnWeights,
  features: Float64Array,
  nodeCount: number,
  adjacencies: NormalisedAdjacency[],
): ForwardCache {
  const { config } = weights;
  const hidden: Float64Array[] = [];
  const preActivation: Float64Array[] = [];
  const messages: Float64Array[][] = [];

  const encoded = new Float64Array(nodeCount * config.hiddenDim);
  matmul(features, nodeCount, config.inputDim, weights.encoderWeight, config.hiddenDim, weights.encoderBias, encoded);
  const encodedPre = Float64Array.from(encoded);
  for (let i = 0; i < encoded.length; i += 1) {
    if ((encoded[i] as number) < 0) encoded[i] = (encoded[i] as number) * LEAK;
  }
  preActivation.push(encodedPre);
  hidden.push(encoded);

  for (let l = 0; l < config.layers; l += 1) {
    const previous = hidden[l] as Float64Array;
    const next = new Float64Array(nodeCount * config.hiddenDim);
    matmul(previous, nodeCount, config.hiddenDim, weights.layerSelf[l] as Float64Array, config.hiddenDim, weights.layerBias[l] as Float64Array, next);

    const layerMessages: Float64Array[] = [];
    for (let t = 0; t < adjacencies.length; t += 1) {
      const aggregated = new Float64Array(nodeCount * config.hiddenDim);
      aggregate(adjacencies[t] as NormalisedAdjacency, previous, config.hiddenDim, aggregated);
      layerMessages.push(aggregated);

      const projected = new Float64Array(nodeCount * config.hiddenDim);
      matmul(aggregated, nodeCount, config.hiddenDim, (weights.layerMessage[l] as Float64Array[])[t] as Float64Array, config.hiddenDim, null, projected);
      for (let i = 0; i < next.length; i += 1) next[i] = (next[i] as number) + (projected[i] as number);
    }
    messages.push(layerMessages);

    // Residual. Without it a three-layer network on a sparse graph loses the
    // node's own state to the neighbourhood average by the third hop, and the
    // per-cell prediction becomes a regional one.
    for (let i = 0; i < next.length; i += 1) next[i] = (next[i] as number) + (previous[i] as number);

    const pre = Float64Array.from(next);
    for (let i = 0; i < next.length; i += 1) {
      if ((next[i] as number) < 0) next[i] = (next[i] as number) * LEAK;
    }
    preActivation.push(pre);
    hidden.push(next);
  }

  const output = new Float64Array(nodeCount * config.outputDim);
  matmul(
    hidden[hidden.length - 1] as Float64Array, nodeCount, config.hiddenDim,
    weights.decoderWeight, config.outputDim, weights.decoderBias, output,
  );

  return { hidden, preActivation, messages, nodeCount, output };
}

// ---------------------------------------------------------------------------
// Backward
// ---------------------------------------------------------------------------

export interface Gradients {
  encoderWeight: Float64Array;
  encoderBias: Float64Array;
  layerSelf: Float64Array[];
  layerMessage: Float64Array[][];
  layerBias: Float64Array[];
  decoderWeight: Float64Array;
  decoderBias: Float64Array;
}

export function zeroGradients(weights: GnnWeights): Gradients {
  return {
    encoderWeight: new Float64Array(weights.encoderWeight.length),
    encoderBias: new Float64Array(weights.encoderBias.length),
    layerSelf: weights.layerSelf.map((w) => new Float64Array(w.length)),
    layerMessage: weights.layerMessage.map((row) => row.map((w) => new Float64Array(w.length))),
    layerBias: weights.layerBias.map((b) => new Float64Array(b.length)),
    decoderWeight: new Float64Array(weights.decoderWeight.length),
    decoderBias: new Float64Array(weights.decoderBias.length),
  };
}

/** Accumulates dL/dW += x^T @ g and dL/db += sum(g). */
function accumulateLinear(
  x: Float64Array, rows: number, inDim: number,
  gradientOut: Float64Array, outDim: number,
  weightGradient: Float64Array, biasGradient: Float64Array | null,
): void {
  for (let i = 0; i < rows; i += 1) {
    const xOffset = i * inDim;
    const gOffset = i * outDim;
    for (let k = 0; k < inDim; k += 1) {
      const value = x[xOffset + k] as number;
      if (value === 0) continue;
      const wOffset = k * outDim;
      for (let j = 0; j < outDim; j += 1) {
        weightGradient[wOffset + j] = (weightGradient[wOffset + j] as number) + value * (gradientOut[gOffset + j] as number);
      }
    }
    if (biasGradient) {
      for (let j = 0; j < outDim; j += 1) {
        biasGradient[j] = (biasGradient[j] as number) + (gradientOut[gOffset + j] as number);
      }
    }
  }
}

/** dL/dx = g @ W^T. */
function backLinear(
  gradientOut: Float64Array, rows: number, outDim: number,
  weight: Float64Array, inDim: number,
  gradientIn: Float64Array,
): void {
  for (let i = 0; i < rows; i += 1) {
    const gOffset = i * outDim;
    const xOffset = i * inDim;
    for (let k = 0; k < inDim; k += 1) {
      const wOffset = k * outDim;
      let total = 0;
      for (let j = 0; j < outDim; j += 1) total += (gradientOut[gOffset + j] as number) * (weight[wOffset + j] as number);
      gradientIn[xOffset + k] = (gradientIn[xOffset + k] as number) + total;
    }
  }
}

/**
 * Backward pass. `outputGradient` is dL/dy, already scaled by whatever the loss
 * divides by, so this function does not need to know the loss.
 */
export function backward(
  weights: GnnWeights,
  features: Float64Array,
  cache: ForwardCache,
  outputGradient: Float64Array,
  adjacencies: NormalisedAdjacency[],
  gradients: Gradients,
): void {
  const { config } = weights;
  const n = cache.nodeCount;

  const lastHidden = cache.hidden[cache.hidden.length - 1] as Float64Array;
  accumulateLinear(lastHidden, n, config.hiddenDim, outputGradient, config.outputDim, gradients.decoderWeight, gradients.decoderBias);

  let gradientHidden = new Float64Array(n * config.hiddenDim);
  backLinear(outputGradient, n, config.outputDim, weights.decoderWeight, config.hiddenDim, gradientHidden);

  for (let l = config.layers - 1; l >= 0; l -= 1) {
    const pre = cache.preActivation[l + 1] as Float64Array;
    for (let i = 0; i < gradientHidden.length; i += 1) {
      if ((pre[i] as number) < 0) gradientHidden[i] = (gradientHidden[i] as number) * LEAK;
    }

    const previous = cache.hidden[l] as Float64Array;
    accumulateLinear(previous, n, config.hiddenDim, gradientHidden, config.hiddenDim, gradients.layerSelf[l] as Float64Array, gradients.layerBias[l] as Float64Array);

    const gradientPrevious = new Float64Array(n * config.hiddenDim);
    backLinear(gradientHidden, n, config.hiddenDim, weights.layerSelf[l] as Float64Array, config.hiddenDim, gradientPrevious);

    for (let t = 0; t < adjacencies.length; t += 1) {
      const aggregated = (cache.messages[l] as Float64Array[])[t] as Float64Array;
      const messageWeight = (weights.layerMessage[l] as Float64Array[])[t] as Float64Array;
      accumulateLinear(aggregated, n, config.hiddenDim, gradientHidden, config.hiddenDim, (gradients.layerMessage[l] as Float64Array[])[t] as Float64Array, null);

      const gradientAggregated = new Float64Array(n * config.hiddenDim);
      backLinear(gradientHidden, n, config.hiddenDim, messageWeight, config.hiddenDim, gradientAggregated);
      // Through the aggregation: dL/dh_j += sum_i A[i,j] * dL/dagg_i.
      aggregateTranspose(adjacencies[t] as NormalisedAdjacency, gradientAggregated, config.hiddenDim, gradientPrevious);
    }

    // Residual path.
    for (let i = 0; i < gradientPrevious.length; i += 1) {
      gradientPrevious[i] = (gradientPrevious[i] as number) + (gradientHidden[i] as number);
    }
    gradientHidden = gradientPrevious;
  }

  const encoderPre = cache.preActivation[0] as Float64Array;
  for (let i = 0; i < gradientHidden.length; i += 1) {
    if ((encoderPre[i] as number) < 0) gradientHidden[i] = (gradientHidden[i] as number) * LEAK;
  }
  accumulateLinear(features, n, config.inputDim, gradientHidden, config.hiddenDim, gradients.encoderWeight, gradients.encoderBias);
}

// ---------------------------------------------------------------------------
// Optimiser
// ---------------------------------------------------------------------------

export interface AdamState {
  m: Float64Array[];
  v: Float64Array[];
  step: number;
}

function allTensors(weights: GnnWeights): Float64Array[] {
  const out: Float64Array[] = [weights.encoderWeight, weights.encoderBias];
  for (const self of weights.layerSelf) out.push(self);
  for (const messages of weights.layerMessage) for (const message of messages) out.push(message);
  for (const bias of weights.layerBias) out.push(bias);
  out.push(weights.decoderWeight, weights.decoderBias);
  return out;
}

function allGradients(gradients: Gradients): Float64Array[] {
  const out: Float64Array[] = [gradients.encoderWeight, gradients.encoderBias];
  for (const self of gradients.layerSelf) out.push(self);
  for (const messages of gradients.layerMessage) for (const message of messages) out.push(message);
  for (const bias of gradients.layerBias) out.push(bias);
  out.push(gradients.decoderWeight, gradients.decoderBias);
  return out;
}

export function initialiseAdam(weights: GnnWeights): AdamState {
  const tensors = allTensors(weights);
  return {
    m: tensors.map((t) => new Float64Array(t.length)),
    v: tensors.map((t) => new Float64Array(t.length)),
    step: 0,
  };
}

export function adamStep(
  weights: GnnWeights,
  gradients: Gradients,
  state: AdamState,
  learningRate: number,
  beta1 = 0.9,
  beta2 = 0.999,
  epsilon = 1e-8,
): void {
  state.step += 1;
  const tensors = allTensors(weights);
  const grads = allGradients(gradients);
  const correction1 = 1 - Math.pow(beta1, state.step);
  const correction2 = 1 - Math.pow(beta2, state.step);
  const decay = weights.config.weightDecay;

  for (let t = 0; t < tensors.length; t += 1) {
    const tensor = tensors[t] as Float64Array;
    const gradient = grads[t] as Float64Array;
    const m = state.m[t] as Float64Array;
    const v = state.v[t] as Float64Array;
    for (let i = 0; i < tensor.length; i += 1) {
      // Decoupled weight decay (AdamW). Adding L2 to the gradient instead makes
      // the effective decay depend on the gradient magnitude, which is not what
      // a regulariser should do.
      const g = gradient[i] as number;
      m[i] = beta1 * (m[i] as number) + (1 - beta1) * g;
      v[i] = beta2 * (v[i] as number) + (1 - beta2) * g * g;
      const mHat = (m[i] as number) / correction1;
      const vHat = (v[i] as number) / correction2;
      tensor[i] = (tensor[i] as number) - learningRate * (mHat / (Math.sqrt(vHat) + epsilon) + decay * (tensor[i] as number));
    }
  }
}

/** Global gradient-norm clipping, applied before the optimiser step. */
export function clipGradients(gradients: Gradients, maximumNorm: number): number {
  const grads = allGradients(gradients);
  let total = 0;
  for (const tensor of grads) {
    for (let i = 0; i < tensor.length; i += 1) total += (tensor[i] as number) * (tensor[i] as number);
  }
  const norm = Math.sqrt(total);
  if (norm > maximumNorm && norm > 0) {
    const scale = maximumNorm / norm;
    for (const tensor of grads) {
      for (let i = 0; i < tensor.length; i += 1) tensor[i] = (tensor[i] as number) * scale;
    }
  }
  return norm;
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

export interface SerialisedWeights {
  config: GnnConfig;
  tensors: number[][];
  checksum: string;
  format: 'spatial-gnn-v1';
}

export function serialiseWeights(weights: GnnWeights): SerialisedWeights {
  const tensors = allTensors(weights).map((tensor) => Array.from(tensor, (value) => roundTo(value, 7)));
  const checksum = contentHash({ config: weights.config, tensors });
  return { config: weights.config, tensors, checksum, format: 'spatial-gnn-v1' };
}

export function deserialiseWeights(serialised: SerialisedWeights): GnnWeights {
  const weights = initialiseWeights(serialised.config, new Rng(1));
  const tensors = allTensors(weights);
  if (tensors.length !== serialised.tensors.length) {
    throw new Error(
      `Model pack has ${serialised.tensors.length} tensors but this architecture needs ${tensors.length}. The pack and the code are different versions.`,
    );
  }
  for (let t = 0; t < tensors.length; t += 1) {
    const target = tensors[t] as Float64Array;
    const source = serialised.tensors[t] as number[];
    if (target.length !== source.length) {
      throw new Error(`Tensor ${t} has ${source.length} values but this architecture needs ${target.length}.`);
    }
    target.set(source);
  }
  weights.checksum = serialised.checksum;
  return weights;
}

/**
 * Seven significant figures.
 *
 * The weights are stored as JSON and full float64 would triple the size of the
 * model pack for precision the predictions do not carry: the mechanistic
 * targets themselves have a solver tolerance of 1e-5.
 */
function roundTo(value: number, digits: number): number {
  return Number(value.toPrecision(digits));
}

/** Mean squared error and its gradient, in one pass. */
export function mseLoss(
  prediction: Float64Array,
  target: Float64Array,
  gradient: Float64Array,
): number {
  const n = prediction.length;
  let total = 0;
  const scale = 2 / n;
  for (let i = 0; i < n; i += 1) {
    const difference = (prediction[i] as number) - (target[i] as number);
    total += difference * difference;
    gradient[i] = scale * difference;
  }
  return total / n;
}
