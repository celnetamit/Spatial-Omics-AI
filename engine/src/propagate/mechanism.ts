/**
 * The mechanistic tissue solver: intracellular relaxation coupled to an
 * extracellular ligand field.
 *
 * This is the reference process. It is what generates the demonstration case,
 * what produces the held-out targets the spatial predictive model is measured
 * against, and — in Expert mode — what the lab can run beside a prediction to
 * show the two side by side. It is labelled "simulated reference" everywhere it
 * surfaces, never "observed", because it is a simulation of a curated network
 * and not a measurement of a tissue.
 *
 * HOW PROPAGATION ARISES
 *
 * Nothing here says "the effect spreads to neighbours". Each cell relaxes
 * toward a target set by its own incoming regulatory edges plus whatever ligand
 * reaches it; ligand-producing nodes write into a field that decays with
 * distance. Perturb one cell and its ligand output changes, which changes the
 * field, which changes its neighbours' targets, which changes *their* ligand
 * output. The spatial spread is a consequence of the mechanism rather than a
 * rule applied on top of it, which is what makes it a fair thing to ask a model
 * to learn.
 *
 * STAGES
 *
 * One stage is one round of ligand-field recomputation. That is a mechanically
 * meaningful unit — it counts rounds of intercellular signalling — and §7.8 is
 * explicit that it must not be translated into hours unless the model is
 * calibrated on time, which this one is not. The stage labels carry that
 * caveat with them.
 */

import type { ObservationRecord } from '../data/types';
import { GridIndex } from '../spatial/graph';
import type { CompiledNetwork } from './network';

export interface TissueState {
  /** observations x nodes, row-major, each in [0, 1]. */
  activity: Float64Array;
  observationCount: number;
  nodeCount: number;
}

/**
 * Per-cell capacity to express each node.
 *
 * A stromal cell cannot respond to a signal whose receptor it does not make,
 * and a model that lets it produces the classic artefact of an effect
 * propagating uniformly through a tissue regardless of who is in it. Capacity
 * is set by cell type and modulated by a perturbation.
 */
export interface Capacity {
  /** observations x nodes; multiplies the node's achievable activity. */
  values: Float64Array;
}

export interface LigandField {
  /** observations x signals; ligand concentration reaching each cell. */
  values: Float64Array;
  signalCount: number;
}

export interface SolveOptions {
  /** Intracellular relaxation steps between ligand-field updates. */
  innerSteps: number;
  /** Ligand-field rounds. Each is one propagation stage. */
  stages: number;
  /** Integration step for the relaxation. */
  dt: number;
  /** Stop early when the largest activity change falls below this. */
  tolerance: number;
  /** Gain on the extracellular term; sets how strongly ligands drive targets. */
  ligandGain: number;
  /** Distance cut-off as a multiple of each signal's diffusion length. */
  fieldCutoffFactor: number;
  /**
   * Per-signal reference concentration. Omitted, the section mean of the
   * initial state is used.
   *
   * A perturbation run passes the *baseline* tissue's reference so that the
   * before and after states are read on the same scale. Recomputing it from the
   * perturbed state would renormalise the very change being measured.
   */
  ligandReference?: Float64Array;
}

export const DEFAULT_SOLVE: SolveOptions = {
  innerSteps: 40,
  // Enough for a perturbation of a whole cell type to settle: a large
  // perturbation takes six to eight rounds, and stopping short reports a
  // transient as a steady state.
  stages: 10,
  // Below the smallest tau in the panel, so a node's time constant is something
  // the integration can express rather than a value it steps straight past.
  dt: 0.1,
  tolerance: 1e-5,
  ligandGain: 1.6,
  fieldCutoffFactor: 3,
};

export interface SolveResult {
  /** One state per stage, index 0 being the input state. */
  stages: TissueState[];
  /** The ligand field at the final stage. */
  field: LigandField;
  /** Largest per-node change in the last stage; small means converged. */
  finalDelta: number;
  converged: boolean;
  stagesRun: number;
  /** The per-signal reference used, so a later run can read the same scale. */
  ligandReference: Float64Array;
}

// ---------------------------------------------------------------------------
// Diffusion kernel
// ---------------------------------------------------------------------------

/**
 * The precomputed diffusion operator.
 *
 * Built once per tissue and reused for every solve — it depends only on the
 * geometry, and rebuilding it per candidate rescue simulation was the single
 * largest cost in the first version of this.
 *
 * The kernel is exp(-d / lambda) normalised so that a uniform unit source gives
 * a uniform unit field. Without that normalisation, a cell in a dense region
 * receives more signal purely because it has more neighbours, and every result
 * ends up being a density map.
 */
export interface DiffusionOperator {
  /** One sparse kernel per signal. */
  kernels: { indptr: Int32Array; indices: Int32Array; weights: Float64Array }[];
  observationCount: number;
}

export function buildDiffusion(
  observations: ObservationRecord[],
  network: CompiledNetwork,
  cutoffFactor = DEFAULT_SOLVE.fieldCutoffFactor,
): DiffusionOperator {
  const index = new GridIndex(observations);
  const n = observations.length;
  const kernels: DiffusionOperator['kernels'] = [];

  for (const signal of network.signals) {
    const cutoff = signal.diffusionLength * cutoffFactor;
    const lists: { index: number; weight: number }[][] = [];
    let total = 0;

    for (let i = 0; i < n; i += 1) {
      const neighbours = index.within(i, cutoff);
      // Self-signalling is included: an autocrine loop is real, and excluding
      // it would make a cell's own ligand the one thing it cannot sense.
      const entries: { index: number; weight: number }[] = [{ index: i, weight: 1 }];
      let weightTotal = 1;
      for (const neighbour of neighbours) {
        const weight = Math.exp(-neighbour.distance / signal.diffusionLength);
        if (weight < 1e-4) continue;
        entries.push({ index: neighbour.index, weight });
        weightTotal += weight;
      }
      for (const entry of entries) entry.weight /= weightTotal;
      lists.push(entries);
      total += entries.length;
    }

    const indptr = new Int32Array(n + 1);
    const indices = new Int32Array(total);
    const weights = new Float64Array(total);
    let cursor = 0;
    for (let i = 0; i < n; i += 1) {
      indptr[i] = cursor;
      for (const entry of lists[i] as { index: number; weight: number }[]) {
        indices[cursor] = entry.index;
        weights[cursor] = entry.weight;
        cursor += 1;
      }
    }
    indptr[n] = cursor;
    kernels.push({ indptr, indices, weights });
  }

  return { kernels, observationCount: n };
}

export function computeField(
  state: TissueState,
  network: CompiledNetwork,
  diffusion: DiffusionOperator,
): LigandField {
  const n = state.observationCount;
  const signalCount = network.signals.length;
  const values = new Float64Array(n * signalCount);

  for (let s = 0; s < signalCount; s += 1) {
    const signal = network.signals[s] as { ligand: number };
    const kernel = diffusion.kernels[s] as { indptr: Int32Array; indices: Int32Array; weights: Float64Array };
    for (let i = 0; i < n; i += 1) {
      const from = kernel.indptr[i] as number;
      const to = kernel.indptr[i + 1] as number;
      let total = 0;
      for (let k = from; k < to; k += 1) {
        const source = kernel.indices[k] as number;
        total += (kernel.weights[k] as number) * (state.activity[source * state.nodeCount + signal.ligand] as number);
      }
      values[i * signalCount + s] = total;
    }
  }

  return { values, signalCount };
}

// ---------------------------------------------------------------------------
// Relaxation
// ---------------------------------------------------------------------------

/**
 * Response-curve constants, and why these values.
 *
 * The slope of `EDGE_GAIN * tanh(x / EDGE_SCALE)` at the origin is
 * EDGE_GAIN / EDGE_SCALE, and *that* is the number that decides stability, not
 * EDGE_GAIN. Multiplied by the sigmoid's own slope near a typical activity
 * (≈0.16) it gives the loop gain of a single regulatory edge. The first
 * version used 2.2 and 0.12 — a slope of 18, so each edge had a gain near 3 —
 * and this network has four negative feedback pairs (DUSP6/ERK, IkB/NF-kB,
 * SOCS3/STAT3, SMAD7/TGFBR1). It did exactly what a loop gain of 9 does: the
 * baseline tissue oscillated and never settled, final delta 0.46.
 *
 * At 2.0 and 0.4 the slope is 5, a single edge has a gain near 0.8, and the
 * baseline converges in ten to twelve rounds across every spec tried. The
 * saturation is still ±2 logits, so a knockout is a strong effect — the change
 * was to the sensitivity near the resting point, not to the depth of the
 * response.
 *
 * `MAX_RATE` caps how far a node moves toward its target in one step. A rate
 * near 1 turns a negative feedback pair into a two-step oscillator regardless
 * of gain.
 *
 * `LIGAND_FLOOR` keeps the log finite where a ligand is genuinely absent, and
 * sets the concentration below which further reduction stops mattering.
 */
const EDGE_GAIN = 2.0;
const EDGE_SCALE = 0.4;
const LIGAND_FLOOR = 0.02;
const MAX_RATE = 0.3;

/** Logit of the basal activity, so basal is the fixed point with no input. */
function basalBias(basal: number): number {
  const clamped = Math.min(0.999, Math.max(0.001, basal));
  return Math.log(clamped / (1 - clamped));
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Relax the intracellular network with the ligand field held fixed.
 *
 * Holding the field fixed inside the inner loop is what gives the stage
 * structure its meaning: everything that happens within a stage is a cell
 * responding to signals that were already present, and a new stage is required
 * for a changed signal to reach anybody.
 */
function relax(
  state: TissueState,
  network: CompiledNetwork,
  capacity: Capacity,
  field: LigandField,
  reference: Float64Array,
  exogenous: ExogenousDrive,
  clamp: Float64Array | null,
  options: SolveOptions,
): number {
  const n = state.observationCount;
  const nodeCount = state.nodeCount;
  const bias = Float64Array.from(network.basal, basalBias);
  let largestDelta = 0;

  for (let step = 0; step < options.innerSteps; step += 1) {
    let delta = 0;
    for (let i = 0; i < n; i += 1) {
      const rowOffset = i * nodeCount;
      for (let node = 0; node < nodeCount; node += 1) {
        const clampValue = clamp ? (clamp[rowOffset + node] as number) : Number.NaN;
        if (Number.isFinite(clampValue)) {
          state.activity[rowOffset + node] = clampValue;
          continue;
        }

        let drive = (bias[node] as number) + (exogenous.values[rowOffset + node] as number);

        for (const edge of network.incoming[node] as { source: number; weight: number }[]) {
          /*
           * Each edge is centred on the source's *resting level in this cell* —
           * its capacity times its basal — and not on the network-wide basal.
           *
           * That distinction is the whole stability of this solver. A T cell
           * has a CDH1 capacity of 0.01, so against a network-wide basal of
           * 0.45 it reads as CDH1 being profoundly repressed, and every edge out
           * of CDH1 fires at saturation in every T cell in the section. What is
           * actually being measured there is cell identity, not regulation.
           * Centring per cell means an unperturbed tissue is an exact fixed
           * point whatever its composition, and the regulatory edges carry only
           * departures from it — which is what they are for. With the
           * network-wide centring the baseline solve did not converge at all
           * (final delta 0.46, drifting rather than settling).
           *
           * tanh at EDGE_SCALE gives a steep response to a small departure and
           * saturates instead of running away, which is what a saturable
           * regulatory step does.
           */
          const resting =
            (capacity.values[rowOffset + edge.source] as number) * (network.basal[edge.source] as number);
          const deviation = (state.activity[rowOffset + edge.source] as number) - resting;
          drive += edge.weight * EDGE_GAIN * Math.tanh(deviation / EDGE_SCALE);
        }

        for (let s = 0; s < network.signals.length; s += 1) {
          const signal = network.signals[s] as { receptor: number; potency: number; ligand: number };
          if (signal.receptor !== node) continue;
          /*
           * Receptor occupancy responds to the *log* of concentration, which is
           * why a dose-response curve is drawn on a log axis. A linear term
           * would be insensitive at the low concentrations most of this field
           * sits at, and would saturate nothing at the high end.
           *
           * The reference is the section mean for this signal, so what a cell
           * responds to is local enrichment rather than an absolute unit that
           * this model has no way to fix. Referencing the ligand node's basal
           * activity instead — the first attempt — suppressed every receptor in
           * the tissue, because the mean field is a capacity-weighted average
           * and sits well below the basal of a ligand only some cell types make.
           *
           * A local perturbation moves the section mean by a few parts in a
           * thousand, so this normalisation is not a channel through which one
           * cell can signal to a distant one; it is a unit choice.
           */
          const concentration = field.values[i * field.signalCount + s] as number;
          drive +=
            options.ligandGain *
            signal.potency *
            Math.log((concentration + LIGAND_FLOOR) / ((reference[s] as number) + LIGAND_FLOOR));
        }

        const ceiling = capacity.values[rowOffset + node] as number;
        const target = ceiling * sigmoid(drive);
        const current = state.activity[rowOffset + node] as number;
        // Capped: an update rate near 1 makes a negative feedback pair a
        // two-step oscillator, and this network has four of them (DUSP6/ERK,
        // IkB/NF-kB, SOCS3/STAT3, SMAD7/TGFBR1).
        const rate = Math.min(MAX_RATE, options.dt / Math.max(0.05, network.tau[node] as number));
        const next = current + rate * (target - current);
        const change = Math.abs(next - current);
        if (change > delta) delta = change;
        state.activity[rowOffset + node] = next;
      }
    }
    largestDelta = delta;
    if (delta < options.tolerance) break;
  }
  return largestDelta;
}

/**
 * Solve the tissue to a stage-resolved steady state.
 *
 * `clamp` holds nodes at a fixed value — how a knockout is expressed. NaN means
 * "not clamped", so a sparse clamp costs one comparison per node rather than a
 * separate index.
 */
/**
 * Everything about a tissue that is not the network and not the state.
 *
 * Bundled into one object on purpose. These four travel together and a solve is
 * wrong — silently, plausibly wrong — if any one of them is left behind: the
 * first harness written against the loose-argument version forgot the exogenous
 * drive, every scenario it ran showed HIF1A collapsing by 0.5 across the whole
 * section, and the output looked enough like a result that the mistake took a
 * while to find. A caller cannot now pass three of the four.
 */
export interface TissueContext {
  capacity: Capacity;
  exogenous: ExogenousDrive;
  diffusion: DiffusionOperator;
  /**
   * Per-signal reference concentration. See `SolveOptions.ligandReference`.
   *
   * `null` means "compute it from the state I am giving you", which is what a
   * burn-in pass wants. A zero-filled array does NOT mean that — see
   * `resolveReference`.
   */
  ligandReference: Float64Array | null;
}

export function solveTissue(
  initial: TissueState,
  network: CompiledNetwork,
  context: TissueContext,
  clamp: Float64Array | null,
  options: SolveOptions = DEFAULT_SOLVE,
): SolveResult {
  const { capacity, diffusion } = context;
  const drive = context.exogenous;
  const stages: TissueState[] = [cloneState(initial)];
  const state = cloneState(initial);
  let field = computeField(state, network, diffusion);
  const reference = resolveReference(options.ligandReference ?? context.ligandReference, field, network);
  let delta = Infinity;
  let converged = false;
  let stagesRun = 0;

  for (let stage = 0; stage < options.stages; stage += 1) {
    const before = cloneState(state);
    relax(state, network, capacity, field, reference, drive, clamp, options);
    field = computeField(state, network, diffusion);
    stages.push(cloneState(state));
    stagesRun = stage + 1;

    /*
     * Convergence is measured between *stages*, not inside the inner loop.
     *
     * The inner loop settles to the fixed point of the field it was given
     * within a few steps, so its own last delta is near zero after the first
     * stage — which is what made the first version of this stop after one
     * round and report "converged" for a tissue in which nothing had yet
     * propagated anywhere. What has to be small before the solve is finished is
     * the change from one round of intercellular signalling to the next.
     */
    delta = largestChange(before, state);
    if (stage >= 1 && delta < options.tolerance) {
      converged = true;
      break;
    }
  }

  return { stages, field, finalDelta: delta, converged, stagesRun, ligandReference: reference };
}

function largestChange(before: TissueState, after: TissueState): number {
  let largest = 0;
  for (let i = 0; i < before.activity.length; i += 1) {
    const change = Math.abs((after.activity[i] as number) - (before.activity[i] as number));
    if (change > largest) largest = change;
  }
  return largest;
}

/**
 * The reference concentration, per signal, with an invalid entry replaced.
 *
 * A reference of zero is not a low reference — it is a division by the floor,
 * and `log((c + 0.02) / 0.02)` drives every receptor in the tissue at once. A
 * caller that passes a zero-filled array (a plausible way to say "I do not have
 * one") would get a tissue that has relaxed to somewhere else entirely, with no
 * error: the first test written against this did exactly that and the
 * unperturbed tissue drifted by 0.75 activity units.
 *
 * So each entry is checked, and an entry that is not a positive finite number
 * falls back to that signal's section mean. Per signal rather than all-or-
 * nothing, because a ligand genuinely absent from a panel should not invalidate
 * the references for the others.
 */
function resolveReference(
  supplied: Float64Array | null | undefined,
  field: LigandField,
  network: CompiledNetwork,
): Float64Array {
  const mean = meanField(field);
  if (!supplied || supplied.length !== network.signals.length) return mean;
  const out = Float64Array.from(supplied);
  for (let s = 0; s < out.length; s += 1) {
    const value = out[s] as number;
    if (!Number.isFinite(value) || value <= 0) out[s] = mean[s] as number;
  }
  return out;
}

/** Section mean per signal — the reference concentration. */
export function meanField(field: LigandField): Float64Array {
  const out = new Float64Array(field.signalCount);
  const n = field.signalCount > 0 ? field.values.length / field.signalCount : 0;
  for (let i = 0; i < n; i += 1) {
    for (let s = 0; s < field.signalCount; s += 1) {
      out[s] = (out[s] as number) + (field.values[i * field.signalCount + s] as number);
    }
  }
  if (n > 0) for (let s = 0; s < field.signalCount; s += 1) out[s] = (out[s] as number) / n;
  return out;
}

export function cloneState(state: TissueState): TissueState {
  return {
    activity: Float64Array.from(state.activity),
    observationCount: state.observationCount,
    nodeCount: state.nodeCount,
  };
}

export function emptyState(observationCount: number, nodeCount: number): TissueState {
  return { activity: new Float64Array(observationCount * nodeCount), observationCount, nodeCount };
}

/**
 * A persistent per-cell, per-node input from outside the network.
 *
 * Oxygen tension is the motivating case. Hypoxia is not something the curated
 * network produces — it comes from the vasculature, which the network has no
 * node for — so it enters as a drive on HIF1A that stays applied. Writing it
 * into the initial state instead, which is what the first version did, meant
 * the relaxation pulled HIF1A straight back to basal and the hypoxic core
 * vanished by the second inner step: the region means still looked graded
 * because cell-type composition differs by region, but the correlation with
 * vessel distance inside one cell type was r = -0.02.
 *
 * Anything the tissue is embedded in rather than made of belongs here.
 */
export interface ExogenousDrive {
  /** observations x nodes, in logit units, added to each node's drive. */
  values: Float64Array;
}

export function noExogenousDrive(observationCount: number, nodeCount: number): ExogenousDrive {
  return { values: new Float64Array(observationCount * nodeCount) };
}

/** A capacity matrix where every cell can express everything. */
export function fullCapacity(observationCount: number, nodeCount: number): Capacity {
  return { values: new Float64Array(observationCount * nodeCount).fill(1) };
}

/** Largest absolute change per observation between two states. */
export function stateDelta(before: TissueState, after: TissueState): Float64Array {
  const out = new Float64Array(before.observationCount);
  for (let i = 0; i < before.observationCount; i += 1) {
    let largest = 0;
    for (let node = 0; node < before.nodeCount; node += 1) {
      const change = Math.abs(
        (after.activity[i * after.nodeCount + node] as number) -
          (before.activity[i * before.nodeCount + node] as number),
      );
      if (change > largest) largest = change;
    }
    out[i] = largest;
  }
  return out;
}

/** Signed per-node change, which is what the delta layers render. */
export function nodeDelta(before: TissueState, after: TissueState): Float64Array {
  const out = new Float64Array(before.activity.length);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = (after.activity[i] as number) - (before.activity[i] as number);
  }
  return out;
}

/** The stage labels, with the caveat §7.8 requires attached to them. */
export const STAGE_LABELS = ['T0 Baseline', 'T1 Direct', 'T2 First neighbour', 'T3 Propagation', 'T4 Propagation', 'Final'];

export const STAGE_CAVEAT =
  'T0–T4 count rounds of intercellular signalling in the model, not hours or days. ' +
  'This model is not calibrated on biological time, so translating a stage into a duration would be a kinetic claim nothing here supports.';

export function stageLabel(index: number, total: number): string {
  if (index === 0) return 'T0 Baseline';
  if (index >= total) return 'Final';
  return STAGE_LABELS[Math.min(index, STAGE_LABELS.length - 2)] as string;
}
