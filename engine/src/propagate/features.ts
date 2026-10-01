/**
 * The feature vector the spatial model reads, and the rollout it produces.
 *
 * The model is a **one-step operator**: given the tissue at stage s and what
 * was done to it, predict the change to stage s+1. Rolling it forward gives the
 * stage structure §6.14 asks for — T1 direct, T2 first neighbour, T3+
 * propagation — as a property of how the model is applied rather than as five
 * separate models, and it means the first-neighbour response is *structurally*
 * one round of message passing rather than a layer someone decided to call
 * that.
 *
 * It also makes the honesty of the evaluation sharper. A model trained on
 * single steps and evaluated on a full rollout has to survive its own
 * compounding error, and §14 gets a number for that rather than for the easier
 * teacher-forced case. Both are reported.
 */

import type { CompiledNetwork } from './network';
import type { TissueState } from './mechanism';
import type { GnnConfig } from './gnn';

/** Cell classes the model pack was trained with, in a fixed order. */
export interface FeatureSchema {
  nodeSymbols: string[];
  cellClasses: string[];
  /**
   * Per-node standard deviation of the one-step target, from the training set.
   *
   * The model predicts `delta / scale` and inference multiplies back. Without
   * it the targets are around 1e-2, mean squared error is minimised by
   * predicting zero, and training does exactly that: the first version stalled
   * at a validation loss of 1.6e-4 — the loss of predicting no change — from
   * epoch one, and its held-out R² was within 0.04 of a model that predicted
   * nothing at all. The gradients were not wrong; they were negligible.
   *
   * Per node rather than global because the panel spans two orders of magnitude
   * in how much a gene moves, and a single scale lets the few large movers
   * absorb the entire loss.
   */
  targetScale: Float64Array;
  /** Included so a pack can state what it expects and be checked against it. */
  version: string;
}

/**
 * Per-node target scales from a set of one-step deltas.
 *
 * Floored at a fraction of the largest scale: a node that never moves in the
 * training set would otherwise get a scale near zero, and dividing by it turns
 * its residual noise into the dominant term in the loss.
 */
export function deriveTargetScale(
  deltas: Float64Array[],
  nodeCount: number,
  floorFraction = 0.05,
): Float64Array {
  const sums = new Float64Array(nodeCount);
  const counts = new Float64Array(nodeCount);
  for (const delta of deltas) {
    const rows = delta.length / nodeCount;
    for (let i = 0; i < rows; i += 1) {
      for (let node = 0; node < nodeCount; node += 1) {
        const value = delta[i * nodeCount + node] as number;
        sums[node] = (sums[node] as number) + value * value;
        counts[node] = (counts[node] as number) + 1;
      }
    }
  }
  const scale = new Float64Array(nodeCount);
  let largest = 0;
  for (let node = 0; node < nodeCount; node += 1) {
    const count = counts[node] as number;
    const rms = count > 0 ? Math.sqrt((sums[node] as number) / count) : 0;
    scale[node] = rms;
    if (rms > largest) largest = rms;
  }
  const floor = largest * floorFraction;
  for (let node = 0; node < nodeCount; node += 1) {
    scale[node] = Math.max(floor, scale[node] as number) || 1;
  }
  return scale;
}

export function inputDimension(schema: FeatureSchema): number {
  // current activity, accumulated delta, direct perturbation, class one-hot,
  // stage index, and a bias-like constant for cells outside every known class.
  return schema.nodeSymbols.length * 3 + schema.cellClasses.length + 2;
}

export function configFor(schema: FeatureSchema, hiddenDim: number, layers: number, weightDecay: number): GnnConfig {
  return {
    inputDim: inputDimension(schema),
    hiddenDim,
    outputDim: schema.nodeSymbols.length,
    layers,
    edgeTypes: ['physical', 'biological'],
    weightDecay,
  };
}

export interface FeatureInput {
  /** The state this step starts from. */
  current: TissueState;
  /** The unperturbed tissue, so the accumulated delta is available. */
  baseline: TissueState;
  /**
   * What the perturbation did directly, per node per cell.
   *
   * Signed: negative for an inhibition or knockout, positive for activation.
   * Zero for every cell outside the selection, which is what lets the model
   * learn that an unselected cell only changes through its neighbours.
   */
  directEffect: Float64Array;
  /** Per-observation class index into `schema.cellClasses`, or -1. */
  classIndex: Int32Array;
  /** Which propagation stage this step produces, from 1. */
  stage: number;
  /** Total stages in the rollout, for the normalisation. */
  totalStages: number;
}

export function buildFeatures(input: FeatureInput, schema: FeatureSchema): Float64Array {
  const n = input.current.observationCount;
  const k = schema.nodeSymbols.length;
  const classes = schema.cellClasses.length;
  const dim = inputDimension(schema);
  const out = new Float64Array(n * dim);

  for (let i = 0; i < n; i += 1) {
    const offset = i * dim;
    const stateOffset = i * k;
    for (let node = 0; node < k; node += 1) {
      const current = input.current.activity[stateOffset + node] as number;
      const baseline = input.baseline.activity[stateOffset + node] as number;
      out[offset + node] = current;
      out[offset + k + node] = current - baseline;
      out[offset + 2 * k + node] = input.directEffect[stateOffset + node] as number;
    }
    const classIndex = input.classIndex[i] as number;
    if (classIndex >= 0 && classIndex < classes) out[offset + 3 * k + classIndex] = 1;
    else out[offset + 3 * k + classes] = 1; // the "unknown class" slot
    out[offset + 3 * k + classes + 1] = input.totalStages > 0 ? input.stage / input.totalStages : 0;
  }
  return out;
}

/** The signed direct-effect tensor a perturbation produces, for the features. */
export function directEffectTensor(
  baseline: TissueState,
  perturbedInitial: TissueState,
  targetNodes: number[],
  magnitude: Float64Array,
  network: CompiledNetwork,
): Float64Array {
  const n = baseline.observationCount;
  const k = baseline.nodeCount;
  const out = new Float64Array(n * k);
  for (let i = 0; i < n; i += 1) {
    const size = magnitude[i] as number;
    if (!(size > 0)) continue;
    for (const node of targetNodes) {
      const before = baseline.activity[i * k + node] as number;
      const after = perturbedInitial.activity[i * k + node] as number;
      // Signed by the direction the target actually moved, so an activation and
      // an inhibition of the same size are different inputs rather than the
      // same magnitude with a label.
      out[i * k + node] = after - before;
    }
  }
  void network;
  return out;
}

/** Class indices for a list of labels against a schema. */
export function classIndices(labels: (string | undefined)[], schema: FeatureSchema): Int32Array {
  const lookup = new Map(schema.cellClasses.map((name, index) => [name, index]));
  const out = new Int32Array(labels.length).fill(-1);
  labels.forEach((label, index) => {
    if (label === undefined) return;
    out[index] = lookup.get(label) ?? -1;
  });
  return out;
}
