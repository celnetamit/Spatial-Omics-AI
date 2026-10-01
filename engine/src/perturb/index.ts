/**
 * Direct response: translating a perturbation into a change in the model.
 *
 * §2.3 requires the direct response to be computed and stored separately from
 * spatial propagation, and the reason it gives is interpretability and
 * ablation. There is a second reason this implementation cares about: the two
 * have different evidence. A direct drug effect is parameterised from a
 * measured dose-response curve, and the propagation from it is a model
 * prediction. Merging them would give the whole result the confidence of
 * whichever half you looked at last.
 *
 * Nothing here consults an AI, and the boundary is structural rather than
 * advisory: this module has no network access and no model adapter in scope.
 */

import { contentHash } from '../core/provenance';
import { confidenceCeiling, weakestConfidence, type Confidence } from '../core/labels';
import type { CompiledNetwork } from '../propagate/network';
import type { Capacity, ExogenousDrive, TissueState } from '../propagate/mechanism';
import type { ObservationRecord } from '../data/types';
import type {
  DoseResponseParameters, DrugPerturbation, MolecularPerturbation, PerturbationDefinition,
  PerturbationEligibility, PerturbationSpec, SelectionMode, TargetSelection, TimeResponseParameters,
} from './types';

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export interface SelectionRequest {
  mode: SelectionMode;
  classes?: string[];
  observationIds?: string[];
  centre?: { x: number; y: number };
  radius?: number;
}

/**
 * Resolve a selection to indices, once, and keep them.
 *
 * §4.4 requires the selection to be "saved as an immutable cell/spot ID list or
 * region definition". Resolving at run time instead would mean a rescue
 * simulation could silently target a different set of cells than the
 * perturbation did, if anything upstream re-annotated the tissue in between —
 * and the comparison between them would then be between two different
 * experiments.
 */
export function resolveSelection(
  request: SelectionRequest,
  observations: ObservationRecord[],
  cellTypes: (string | undefined)[],
  regions: (string | undefined)[],
): TargetSelection {
  const indices: number[] = [];
  let description = '';

  switch (request.mode) {
    case 'whole-tissue': {
      for (let i = 0; i < observations.length; i += 1) indices.push(i);
      description = `All ${observations.length} observations in the section.`;
      break;
    }
    case 'cell-type': {
      const wanted = new Set(request.classes ?? []);
      for (let i = 0; i < observations.length; i += 1) {
        if (wanted.has(cellTypes[i] ?? '')) indices.push(i);
      }
      description = `${indices.length} observation(s) annotated ${[...wanted].join(', ') || '(none)'}.`;
      break;
    }
    case 'region': {
      const wanted = new Set(request.classes ?? []);
      for (let i = 0; i < observations.length; i += 1) {
        if (wanted.has(regions[i] ?? '')) indices.push(i);
      }
      description = `${indices.length} observation(s) in region ${[...wanted].join(', ') || '(none)'}.`;
      break;
    }
    case 'explicit': {
      const wanted = new Set(request.observationIds ?? []);
      for (let i = 0; i < observations.length; i += 1) {
        if (wanted.has((observations[i] as ObservationRecord).id)) indices.push(i);
      }
      description = `${indices.length} explicitly selected observation(s).`;
      break;
    }
    case 'radius': {
      const centre = request.centre ?? { x: 0, y: 0 };
      const radius = request.radius ?? 0;
      for (let i = 0; i < observations.length; i += 1) {
        const observation = observations[i] as ObservationRecord;
        const dx = observation.x - centre.x;
        const dy = observation.y - centre.y;
        if (Math.sqrt(dx * dx + dy * dy) <= radius) indices.push(i);
      }
      description = `${indices.length} observation(s) within ${radius} of (${centre.x.toFixed(0)}, ${centre.y.toFixed(0)}).`;
      break;
    }
  }

  const selection: TargetSelection = {
    mode: request.mode,
    resolvedIndices: indices,
    description,
    observationIds: indices.map((i) => (observations[i] as ObservationRecord).id),
  };
  if (request.classes) selection.classes = request.classes;
  if (request.centre) selection.centre = request.centre;
  if (request.radius !== undefined) selection.radius = request.radius;
  return selection;
}

// ---------------------------------------------------------------------------
// Dose and time response — §7.2, §7.3
// ---------------------------------------------------------------------------

/** Concentration in nM, whatever unit it arrived in. */
export function toNanomolar(value: number, unit: 'nM' | 'uM' | 'mM'): number {
  switch (unit) {
    case 'nM': return value;
    case 'uM': return value * 1e3;
    case 'mM': return value * 1e6;
  }
}

export function toHours(value: number, unit: 'min' | 'h' | 'day'): number {
  switch (unit) {
    case 'min': return value / 60;
    case 'h': return value;
    case 'day': return value * 24;
  }
}

/**
 * The Hill/Emax curve of §7.2: D(C) = Emax * C^h / (EC50^h + C^h).
 *
 * Returns NaN outside the range the source assay covered, rather than a number.
 * §5.3 disables extrapolation by default, and the reason is specific to this
 * curve: below the tested range the Hill form is nearly linear and above it the
 * form is flat, so extrapolating in either direction returns a confident value
 * from a shape nobody measured there.
 */
export function doseResponse(
  concentrationNm: number,
  parameters: DoseResponseParameters,
  allowExtrapolation = false,
): { effect: number; extrapolated: boolean; note: string | null } {
  if (!(concentrationNm >= 0) || !Number.isFinite(concentrationNm)) {
    return { effect: Number.NaN, extrapolated: false, note: 'Concentration is not a finite non-negative number.' };
  }
  const range = parameters.context.testedRangeNm;
  const outside = range !== null && (concentrationNm < range[0] || concentrationNm > range[1]);

  if (outside && !allowExtrapolation) {
    return {
      effect: Number.NaN,
      extrapolated: true,
      note:
        `${concentrationNm.toPrecision(3)} nM is outside the ${range?.[0].toPrecision(3)}–${range?.[1].toPrecision(3)} nM range ` +
        `the source assay covered (${parameters.source}). §5.3 disables extrapolation by default, so no quantitative effect is reported.`,
    };
  }

  const numerator = Math.pow(concentrationNm, parameters.hill);
  const denominator = Math.pow(parameters.ec50Nm, parameters.hill) + numerator;
  const effect = denominator > 0 ? (parameters.emax * numerator) / denominator : 0;

  return {
    effect,
    extrapolated: outside,
    note: outside
      ? `Extrapolated beyond the tested range ${range?.[0].toPrecision(3)}–${range?.[1].toPrecision(3)} nM; treat as exploratory.`
      : null,
  };
}

/** §7.3: T(t) = 1 - exp(-k t). Returns 1 when no time model is justified. */
export function timeResponse(
  hours: number,
  parameters: TimeResponseParameters | null,
): { factor: number; note: string | null } {
  if (!parameters) {
    return {
      factor: 1,
      note:
        'No validated time model exists for this perturbation, so the effect is reported at its plateau. ' +
        'The exposure time is recorded but does not scale the result — inventing a rate constant would be inventing kinetics.',
    };
  }
  const interval = parameters.supportedIntervalHours;
  const outside = interval !== null && (hours < interval[0] || hours > interval[1]);
  const factor = 1 - Math.exp(-parameters.ratePerHour * hours);
  return {
    factor,
    note: outside
      ? `${hours} h is outside the ${interval?.[0]}–${interval?.[1]} h interval the rate was derived over (${parameters.source}).`
      : null,
  };
}

// ---------------------------------------------------------------------------
// Direct response
// ---------------------------------------------------------------------------

export interface DirectResponse {
  /** Per-observation effect magnitude in [0, 1]; 0 outside the selection. */
  magnitude: Float64Array;
  /** Clamp matrix for the solver: NaN where a node is not held. */
  clamp: Float64Array | null;
  /** Capacity after the perturbation; the original is never modified. */
  capacity: Capacity;
  /** Additional drive, for activation and overexpression. */
  exogenous: ExogenousDrive;
  /** Node indices the perturbation acts on directly. */
  targetNodes: number[];
  /** Per-term breakdown for the observation the panel is focused on. */
  terms: DirectResponseTerms[];
  warnings: string[];
  /** Whether a quantitative effect could be computed at all. */
  quantitative: boolean;
  method: string;
}

/** §7.1's DirectEffect_i = A_i * D(C) * T(t) * S_i * W_e, term by term. */
export interface DirectResponseTerms {
  observationIndex: number;
  /** A_i — target availability, from the measured data. */
  targetAvailability: number;
  /** D(C) — dose effect. */
  doseEffect: number;
  /** T(t) — time effect. */
  timeEffect: number;
  /** S_i — cell-context sensitivity. */
  cellSensitivity: number;
  /** W_e — evidence/context modifier. */
  evidenceModifier: number;
  product: number;
}

export interface DirectResponseInput {
  definition: PerturbationDefinition;
  network: CompiledNetwork;
  baseline: TissueState;
  capacity: Capacity;
  exogenous: ExogenousDrive;
  /** Per-observation cell type, for the sensitivity term. */
  cellTypes: (string | undefined)[];
}

export function computeDirectResponse(input: DirectResponseInput): DirectResponse {
  const { definition, network, baseline, capacity, exogenous } = input;
  const n = baseline.observationCount;
  const nodeCount = baseline.nodeCount;

  // Never modified in place — §1.3 requires the baseline state object to survive
  // the perturbation intact.
  const nextCapacity: Capacity = { values: Float64Array.from(capacity.values) };
  const nextExogenous: ExogenousDrive = { values: Float64Array.from(exogenous.values) };
  const clamp = new Float64Array(n * nodeCount).fill(Number.NaN);
  const magnitude = new Float64Array(n);
  const warnings: string[] = [];
  const terms: DirectResponseTerms[] = [];
  let usedClamp = false;

  const spec = definition.spec;
  const targetSymbol = spec.branch === 'drug' ? spec.target : spec.target;
  const targetNode = network.index.get(targetSymbol);

  if (targetNode === undefined) {
    return {
      magnitude, clamp: null, capacity: nextCapacity, exogenous: nextExogenous,
      targetNodes: [],
      terms: [],
      warnings: [`Target "${targetSymbol}" is not in the model's feature space, so no direct response could be computed.`],
      quantitative: false,
      method: 'perturb.direct.unresolved-target',
    };
  }

  if (definition.eligibility.decision === 'blocked') {
    return {
      magnitude, clamp: null, capacity: nextCapacity, exogenous: nextExogenous,
      targetNodes: [targetNode],
      terms: [],
      warnings: [
        'The perturbation was blocked at definition time, so no direct response was computed.',
        ...definition.eligibility.reasons,
      ],
      quantitative: false,
      method: 'perturb.direct.blocked',
    };
  }

  const selected = definition.selection.resolvedIndices;
  if (selected.length === 0) {
    warnings.push('The selection resolved to no observations, so the perturbation has no effect on this dataset.');
  }

  if (spec.branch === 'molecular-genetic') {
    applyMolecular(spec, selected, targetNode, network, baseline, nextCapacity, nextExogenous, clamp, magnitude, terms);
    usedClamp =
      spec.operator === 'knockout' ||
      spec.operator === 'mutation-gain-of-function';
    return {
      magnitude,
      clamp: usedClamp ? clamp : null,
      capacity: nextCapacity,
      exogenous: nextExogenous,
      targetNodes: [targetNode],
      terms,
      warnings,
      quantitative: definition.eligibility.decision === 'quantitative',
      method: `perturb.direct.molecular.${spec.operator}`,
    };
  }

  // -- drug ---------------------------------------------------------------

  const concentrationNm = toNanomolar(spec.concentration, spec.concentrationUnit);
  const hours = toHours(spec.exposureTime, spec.exposureTimeUnit);
  const dose = doseResponse(concentrationNm, spec.doseResponse, definition.eligibility.decision === 'exploratory');
  const time = timeResponse(hours, spec.timeResponse);

  if (dose.note) warnings.push(dose.note);
  if (time.note) warnings.push(time.note);

  if (!Number.isFinite(dose.effect)) {
    return {
      magnitude, clamp: null, capacity: nextCapacity, exogenous: nextExogenous,
      targetNodes: [targetNode], terms: [],
      warnings,
      quantitative: false,
      method: 'perturb.direct.drug.out-of-range',
    };
  }

  // W_e — the evidence/context modifier of §7.1. It is a real multiplier, not a
  // presentational badge: a parameter transferred from a different tissue
  // should produce a smaller predicted effect, not the same effect with a
  // caption.
  const evidenceModifier = contextModifier(spec.doseResponse);
  if (evidenceModifier < 1) {
    warnings.push(
      `Evidence context differs from this dataset, so the effect is scaled by W_e = ${evidenceModifier.toFixed(2)}. ` +
        (spec.doseResponse.transferWarning ?? ''),
    );
  }

  // A_i — target availability, read from the tissue rather than assumed. A drug
  // cannot inhibit a target a cell does not express, and this is where that
  // becomes a number rather than a caveat.
  const restingByNode = new Float64Array(n);
  let maximumResting = 0;
  for (let i = 0; i < n; i += 1) {
    const value = baseline.activity[i * nodeCount + targetNode] as number;
    restingByNode[i] = value;
    if (value > maximumResting) maximumResting = value;
  }

  for (const i of selected) {
    const availability = maximumResting > 0 ? (restingByNode[i] as number) / maximumResting : 0;
    const sensitivity = cellSensitivity(input.cellTypes[i]);
    const product = availability * dose.effect * time.factor * sensitivity * evidenceModifier;
    magnitude[i] = Math.min(1, Math.max(0, product));

    if (terms.length < 64) {
      terms.push({
        observationIndex: i,
        targetAvailability: availability,
        doseEffect: dose.effect,
        timeEffect: time.factor,
        cellSensitivity: sensitivity,
        evidenceModifier,
        product,
      });
    }

    const surviving = spec.actionType === 'agonist' ? 1 : 1 - (magnitude[i] as number);
    const base = nextCapacity.values[i * nodeCount + targetNode] as number;
    if (spec.actionType === 'agonist') {
      // An agonist drives the target rather than capping it.
      nextExogenous.values[i * nodeCount + targetNode] =
        (nextExogenous.values[i * nodeCount + targetNode] as number) + 3.0 * (magnitude[i] as number);
    } else if (spec.actionType === 'degrader') {
      // A degrader removes the protein, so the ceiling falls and nothing can
      // drive it back — unlike an inhibitor, which only blocks activity.
      nextCapacity.values[i * nodeCount + targetNode] = base * surviving;
    } else {
      nextCapacity.values[i * nodeCount + targetNode] = base * surviving;
    }
  }

  return {
    magnitude,
    clamp: null,
    capacity: nextCapacity,
    exogenous: nextExogenous,
    targetNodes: [targetNode],
    terms,
    warnings,
    quantitative: definition.eligibility.decision === 'quantitative',
    method: `perturb.direct.drug.hill-emax`,
  };
}

function applyMolecular(
  spec: MolecularPerturbation,
  selected: number[],
  targetNode: number,
  network: CompiledNetwork,
  baseline: TissueState,
  capacity: Capacity,
  exogenous: ExogenousDrive,
  clamp: Float64Array,
  magnitude: Float64Array,
  terms: DirectResponseTerms[],
): void {
  const nodeCount = baseline.nodeCount;

  for (const i of selected) {
    const offset = i * nodeCount + targetNode;
    const resting = baseline.activity[offset] as number;

    switch (spec.operator) {
      case 'knockout':
        clamp[offset] = 0;
        magnitude[i] = resting;
        break;
      case 'inhibition': {
        const surviving = Math.min(1, Math.max(0, spec.magnitude));
        capacity.values[offset] = (capacity.values[offset] as number) * surviving;
        magnitude[i] = resting * (1 - surviving);
        break;
      }
      case 'activation':
        exogenous.values[offset] = (exogenous.values[offset] as number) + spec.magnitude;
        magnitude[i] = Math.min(1, Math.abs(spec.magnitude) / 4);
        break;
      case 'overexpression':
        // The ceiling has to rise as well as the drive: a transgene that is
        // driven hard but capped at the cell's endogenous capacity is not an
        // overexpression, it is an activation.
        capacity.values[offset] = Math.min(1, (capacity.values[offset] as number) + 0.5);
        exogenous.values[offset] = (exogenous.values[offset] as number) + spec.magnitude;
        magnitude[i] = Math.min(1, Math.abs(spec.magnitude) / 4);
        break;
      case 'mutation-gain-of-function': {
        const level = Math.min(1, Math.max(0, spec.magnitude || 0.9));
        clamp[offset] = level;
        magnitude[i] = Math.abs(level - resting);
        break;
      }
      case 'mutation-loss-of-function': {
        // The protein is made but does not signal, so expression is untouched
        // and the outgoing edges are what weaken. Modelled by capping the
        // target's *effective* activity through the capacity of its targets is
        // not available here, so the closest faithful form is to hold the node
        // at its resting level — it can no longer respond or transmit change.
        clamp[offset] = resting;
        magnitude[i] = 0;
        break;
      }
    }

    if (terms.length < 64) {
      terms.push({
        observationIndex: i,
        targetAvailability: resting,
        doseEffect: Number.NaN,
        timeEffect: Number.NaN,
        cellSensitivity: Number.NaN,
        evidenceModifier: 1,
        product: magnitude[i] as number,
      });
    }
  }
  void network;
}

/**
 * S_i — cell-context sensitivity.
 *
 * This build has no calibrated per-cell-type sensitivity model, so it returns 1
 * and says so. Returning a plausible-looking number here would be exactly the
 * §5 failure: a biological parameter with no evidence behind it, indistinguishable
 * in the output from one that has some.
 */
function cellSensitivity(_cellType: string | undefined): number {
  return 1;
}

export const CELL_SENSITIVITY_NOTE =
  'S_i (cell-context sensitivity) is 1 for every cell in this build. No calibrated per-cell-type sensitivity model ships with it, ' +
  'and a fitted-looking constant would be indistinguishable in the output from an evidence-derived one. ' +
  'Cell-to-cell variation in the direct effect therefore comes entirely from A_i, the measured target availability.';

/** W_e from the evidence class and context match. */
function contextModifier(parameters: DoseResponseParameters): number {
  switch (parameters.evidenceClass) {
    case 'direct-matched-experimental':
      return 1;
    case 'near-context-experimental':
      return 0.8;
    case 'curated-database':
      return 0.7;
    case 'model-derived':
      return 0.7;
    case 'exploratory-scenario':
      return 0.5;
  }
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

export interface EligibilityContext {
  /** Feature symbols present in the dataset. */
  availableFeatures: Set<string>;
  /** Nodes the model pack can perturb. */
  supportedTargets: Set<string>;
  supportedOperators: Set<string>;
  /** Dataset tissue and organism, for the transfer check. */
  datasetOrganism: string;
  datasetTissue: string;
  modelPackId: string;
  modelPackVersion: string;
}

export function assessEligibility(
  spec: PerturbationSpec,
  context: EligibilityContext,
): PerturbationEligibility {
  const reasons: string[] = [];
  const remedies: string[] = [];
  let blocked = false;
  let exploratory = false;
  let confidence: Confidence = 'high';

  const target = spec.target;
  if (!context.availableFeatures.has(target.toUpperCase())) {
    blocked = true;
    reasons.push(`"${target}" is not measured in this dataset.`);
    remedies.push('Choose a target present in the panel, or supply a dataset that measures it.');
  }
  if (!context.supportedTargets.has(target.toUpperCase())) {
    blocked = true;
    reasons.push(`The model pack ${context.modelPackId} cannot perturb "${target}".`);
    remedies.push('Choose a target the model pack supports, or select a different pack.');
  }

  if (spec.branch === 'molecular-genetic') {
    if (!context.supportedOperators.has(spec.operator)) {
      blocked = true;
      reasons.push(`The model pack does not support the ${spec.operator} operator.`);
    }
    if (spec.magnitudeSource === 'user-exploratory' && spec.operator !== 'knockout') {
      exploratory = true;
      reasons.push(
        'The magnitude was chosen by the user rather than taken from the model pack, so the result is an exploratory scenario.',
      );
      remedies.push('Use a model-pack magnitude for a quantitative result.');
      confidence = weakestConfidence(confidence, 'exploratory');
    }
  } else {
    const concentrationNm = toNanomolar(spec.concentration, spec.concentrationUnit);
    const range = spec.doseResponse.context.testedRangeNm;
    if (range && (concentrationNm < range[0] || concentrationNm > range[1])) {
      exploratory = true;
      reasons.push(
        `${spec.concentration} ${spec.concentrationUnit} is outside the ${range[0].toPrecision(3)}–${range[1].toPrecision(3)} nM range the source assay covered.`,
      );
      remedies.push(`Choose a concentration between ${range[0].toPrecision(3)} and ${range[1].toPrecision(3)} nM.`);
      confidence = weakestConfidence(confidence, 'exploratory');
    }
    if (spec.timeResponse) {
      const hours = toHours(spec.exposureTime, spec.exposureTimeUnit);
      const interval = spec.timeResponse.supportedIntervalHours;
      if (interval && (hours < interval[0] || hours > interval[1])) {
        exploratory = true;
        reasons.push(`${hours} h is outside the ${interval[0]}–${interval[1]} h interval the time model covers.`);
      }
    }
    if (spec.doseResponse.context.organism.toLowerCase() !== context.datasetOrganism.toLowerCase()) {
      reasons.push(
        `Dose-response evidence is from ${spec.doseResponse.context.organism} and this dataset is ${context.datasetOrganism}; a transfer warning applies.`,
      );
      confidence = weakestConfidence(confidence, 'moderate');
    }
    confidence = weakestConfidence(confidence, confidenceCeiling(spec.doseResponse.evidenceClass));
    if (!spec.timeResponse) {
      reasons.push('No validated time model for this drug; the effect is reported at its plateau and exposure time does not scale it.');
    }
  }

  const decision = blocked ? 'blocked' : exploratory ? 'exploratory' : 'quantitative';
  if (blocked) confidence = 'not-interpretable';

  return {
    decision,
    reasons,
    remedies,
    confidence,
  };
}

/** Freeze a definition, giving it its id and checksum. */
export function createDefinition(
  spec: PerturbationSpec,
  selection: TargetSelection,
  eligibility: PerturbationEligibility,
  modelPackId: string,
  modelPackVersion: string,
): PerturbationDefinition {
  const createdAt = new Date().toISOString();
  const checksum = contentHash({ spec, selection: { ...selection, description: undefined }, modelPackId, modelPackVersion });
  return {
    id: `perturbation-${checksum.slice(0, 12)}`,
    createdAt,
    branch: spec.branch,
    spec,
    selection,
    eligibility,
    checksum,
    modelPackId,
    modelPackVersion,
  };
}

/** A human summary of the definition, used in reports and AI evidence. */
export function describePerturbation(definition: PerturbationDefinition): string {
  const spec = definition.spec;
  if (spec.branch === 'molecular-genetic') {
    const detail =
      spec.operator === 'knockout'
        ? ''
        : spec.operator === 'inhibition'
          ? ` to ${(spec.magnitude * 100).toFixed(0)}% of its capacity`
          : ` with a drive of ${spec.magnitude.toFixed(2)}`;
    return `${spec.operator.replace(/-/g, ' ')} of ${spec.target}${detail} in ${definition.selection.description}`;
  }
  return (
    `${spec.drugName} (${spec.drugId}) at ${spec.concentration} ${spec.concentrationUnit} for ` +
    `${spec.exposureTime} ${spec.exposureTimeUnit}, acting as a ${spec.actionType} of ${spec.target}, in ${definition.selection.description}`
  );
}

export type { DrugPerturbation, MolecularPerturbation, PerturbationDefinition };

/**
 * The state immediately after the perturbation, before anything relaxes.
 *
 * This is stage T0' — the initial condition the propagation starts from, and
 * the thing the UI labels "direct response". Keeping it explicit means the
 * evidence-parameterised direct effect and the model-predicted propagation are
 * two different objects with two different provenances, which is what §2.3
 * asks for and what lets a report give them different confidence.
 */
export function applyDirectToState(
  baseline: TissueState,
  response: DirectResponse,
  network: CompiledNetwork,
): TissueState {
  const next: TissueState = {
    activity: Float64Array.from(baseline.activity),
    observationCount: baseline.observationCount,
    nodeCount: baseline.nodeCount,
  };
  const k = baseline.nodeCount;

  for (let i = 0; i < baseline.observationCount; i += 1) {
    for (const node of response.targetNodes) {
      const offset = i * k + node;
      const clamped = response.clamp ? (response.clamp[offset] as number) : Number.NaN;
      if (Number.isFinite(clamped)) {
        next.activity[offset] = clamped;
        continue;
      }
      // Not clamped: the ceiling moved, so the activity is capped to it. An
      // inhibitor that halves the ceiling halves the activity of a cell sitting
      // at its ceiling and does nothing to one sitting well below it, which is
      // the behaviour target availability is supposed to produce.
      const ceiling = response.capacity.values[offset] as number;
      const current = next.activity[offset] as number;
      if (current > ceiling) next.activity[offset] = ceiling;
    }
  }
  void network;
  return next;
}
