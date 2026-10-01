/**
 * Candidate therapy retrieval, eligibility and comparison — §6.17 and §6.19.
 *
 * The rule §2 states as a workflow rule and §13.3 restates as a procedure:
 * **nothing is ranked until every eligible candidate has been simulated
 * separately in the same altered tissue state.** This module therefore has no
 * function that turns evidence into a rank. `retrieveCandidates` produces a set
 * with inclusion and exclusion reasons; `compareCandidates` takes *simulation
 * results* and nothing else. There is no path from an evidence score to a
 * position in the list.
 *
 * The other rule, §6.19: "display components first. A composite score is
 * enabled only when weights are frozen, justified and benchmarked; otherwise
 * use Pareto/endpoint-based comparison." So the composite is opt-in, requires a
 * signed weight set, and its absence produces a Pareto front rather than a
 * silently-defaulted ranking.
 */

import { mean } from '../core/stats';
import type { Confidence, EvidenceClass } from '../core/labels';
import { weakestConfidence } from '../core/labels';
import type { DoseResponseParameters } from '../perturb/types';

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

export type TherapyClass = 'small-molecule' | 'antibody' | 'biologic' | 'cell-therapy' | 'genetic';

export interface CandidateTherapy {
  candidateId: string;
  name: string;
  therapyClass: TherapyClass;
  /** Primary target symbol. */
  target: string;
  mechanism: string;
  actionType: 'inhibitor' | 'agonist' | 'antagonist' | 'degrader' | 'other';
  /** Evidence records backing target-disease and target-drug links. */
  evidence: CandidateEvidence[];
  /** Dose-response parameters, where any exist. */
  doseResponse: DoseResponseParameters | null;
  /** Concentration the simulation should use, and why that one. */
  suggestedConcentrationNm: number | null;
  concentrationRationale: string;
  /** Secondary targets, for the adverse analysis. */
  secondaryTargets: { symbol: string; potencyNm: number | null; source: string }[];
  eligibility: CandidateEligibility;
}

export interface CandidateEvidence {
  kind: 'target-disease' | 'drug-target' | 'bioactivity' | 'pathway' | 'perturbation-signature';
  source: string;
  identifier: string;
  summary: string;
  evidenceClass: EvidenceClass;
  retrievedAt: string;
}

export interface CandidateEligibility {
  /** Only eligible candidates may be simulated, and only simulated ones ranked. */
  eligible: boolean;
  /** Every reason, so the excluded table is informative rather than a count. */
  reasons: string[];
  /** Which requirement failed, for the table's column. */
  failed: EligibilityRequirement[];
  confidence: Confidence;
}

export type EligibilityRequirement =
  | 'stable-identifier'
  | 'target-mechanism-evidence'
  | 'target-in-feature-space'
  | 'model-pack-supports-class'
  | 'parameterisation-available'
  | 'context-policy';

export const REQUIREMENT_LABEL: Record<EligibilityRequirement, string> = {
  'stable-identifier': 'Stable compound identifier',
  'target-mechanism-evidence': 'Target and mechanism evidence',
  'target-in-feature-space': 'Target present in the model feature space',
  'model-pack-supports-class': 'Model pack supports this therapy class',
  'parameterisation-available': 'Dose-response parameterisation available',
  'context-policy': 'Evidence context policy',
};

export interface RetrievalContext {
  /** Feature symbols in the model's space. */
  featureSpace: Set<string>;
  /** Therapy classes the model packs can simulate. */
  supportedClasses: Set<TherapyClass>;
  /** Drivers extracted from the altered tissue, with their direction. */
  drivers: { symbol: string; direction: 'up' | 'down'; magnitude: number }[];
  datasetOrganism: string;
  datasetTissue: string;
}

/**
 * Eligibility, as a rule and not a judgement.
 *
 * §6.17 is explicit that "AI may summarize and prioritize retrieval queries but
 * eligibility is rule-based". Each requirement below is checkable without
 * interpretation, which is what lets the excluded-candidate table say *which*
 * rule failed rather than "not eligible".
 */
export function assessCandidate(
  candidate: Omit<CandidateTherapy, 'eligibility'>,
  context: RetrievalContext,
): CandidateEligibility {
  const reasons: string[] = [];
  const failed: EligibilityRequirement[] = [];
  let confidence: Confidence = 'high';

  if (!candidate.candidateId || candidate.candidateId.trim() === '') {
    failed.push('stable-identifier');
    reasons.push('No stable compound identifier, so this candidate cannot be traced back to a source record.');
  }

  const mechanismEvidence = candidate.evidence.filter(
    (record) => record.kind === 'drug-target' || record.kind === 'bioactivity',
  );
  if (mechanismEvidence.length === 0) {
    failed.push('target-mechanism-evidence');
    reasons.push('No target or mechanism evidence, so the candidate cannot be ranked (§4.6).');
  }

  if (!context.featureSpace.has(candidate.target.toUpperCase())) {
    failed.push('target-in-feature-space');
    reasons.push(
      `Target ${candidate.target} is not in the model's feature space, so its effect on this tissue cannot be simulated.`,
    );
  }

  if (!context.supportedClasses.has(candidate.therapyClass)) {
    failed.push('model-pack-supports-class');
    reasons.push(
      `No validated direct-effect model for the ${candidate.therapyClass} class (§1.4 makes these conditional on a separate mechanistic model existing).`,
    );
  }

  if (!candidate.doseResponse || candidate.suggestedConcentrationNm === null) {
    failed.push('parameterisation-available');
    reasons.push('No dose-response parameterisation, so there is no evidence-supported concentration to simulate at.');
  } else {
    confidence = weakestConfidence(confidence, contextConfidence(candidate.doseResponse, context));
    if (candidate.doseResponse.transferWarning) {
      reasons.push(candidate.doseResponse.transferWarning);
    }
  }

  return { eligible: failed.length === 0, reasons, failed, confidence };
}

function contextConfidence(parameters: DoseResponseParameters, context: RetrievalContext): Confidence {
  if (parameters.context.organism.toLowerCase() !== context.datasetOrganism.toLowerCase()) return 'exploratory';
  if (parameters.evidenceClass === 'direct-matched-experimental') return 'high';
  if (parameters.evidenceClass === 'near-context-experimental') return 'moderate';
  return 'moderate';
}

export interface RetrievalResult {
  eligible: CandidateTherapy[];
  excluded: CandidateTherapy[];
  /** Drivers the retrieval was run against, for the report. */
  drivers: RetrievalContext['drivers'];
  method: string;
  note: string;
}

/**
 * Score candidates against the altered tissue's drivers — for *retrieval*, not
 * for ranking.
 *
 * A candidate whose target is a driver that went up and which inhibits it is
 * more relevant to retrieve than one that has nothing to do with the altered
 * state. The relevance number never leaves this function's output as an order:
 * the eligible set is returned sorted by name, and the only ordering the lab
 * ever displays comes from simulation.
 */
export function retrieveCandidates(
  catalogue: Omit<CandidateTherapy, 'eligibility'>[],
  context: RetrievalContext,
): RetrievalResult {
  const eligible: CandidateTherapy[] = [];
  const excluded: CandidateTherapy[] = [];

  for (const entry of catalogue) {
    const eligibility = assessCandidate(entry, context);
    const candidate: CandidateTherapy = { ...entry, eligibility };
    if (eligibility.eligible) eligible.push(candidate);
    else excluded.push(candidate);
  }

  eligible.sort((a, b) => a.name.localeCompare(b.name));
  excluded.sort((a, b) => a.name.localeCompare(b.name));

  return {
    eligible,
    excluded,
    drivers: context.drivers,
    method: 'rescue.retrieve.rule-based-eligibility',
    note:
      `${eligible.length} candidate(s) are eligible and ${excluded.length} are not. ` +
      'The eligible set is listed alphabetically: no ordering is implied before simulation, because §2 forbids ranking a candidate that has not been simulated.',
  };
}

/**
 * Drivers of the altered state: the features that moved most, with direction.
 *
 * Restricted to features whose change clears a noise floor, so a list of
 * drivers is not mostly a list of the noisiest genes in the panel.
 */
export function extractDrivers(
  nodeMeanDelta: Float64Array,
  symbols: string[],
  noiseFloor = 0.02,
  limit = 20,
): RetrievalContext['drivers'] {
  const drivers: RetrievalContext['drivers'] = [];
  for (let node = 0; node < symbols.length; node += 1) {
    const delta = nodeMeanDelta[node] as number;
    if (!Number.isFinite(delta) || Math.abs(delta) < noiseFloor) continue;
    drivers.push({ symbol: symbols[node] as string, direction: delta > 0 ? 'up' : 'down', magnitude: Math.abs(delta) });
  }
  drivers.sort((a, b) => b.magnitude - a.magnitude);
  return drivers.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Comparison — §6.19
// ---------------------------------------------------------------------------

export interface RescueOutcome {
  candidateId: string;
  name: string;
  /** Benefit components, each in its own units and each named. */
  components: ComponentScore[];
  /** Adverse burden, kept off the benefit axis entirely. */
  adverseBurden: number;
  /** Resistance/adaptation, where the model produces one. */
  resistance: number | null;
  /** Ensemble disagreement on this candidate's prediction. */
  uncertainty: number;
  confidence: Confidence;
  /** Simulation that produced this, for traceability. */
  simulationId: string;
  warnings: string[];
}

export interface ComponentScore {
  id: string;
  name: string;
  value: number;
  /** Higher is better, or lower is better — stated rather than assumed. */
  direction: 'higher-is-better' | 'lower-is-better';
  unit: string;
  method: string;
}

/** A reviewer-approved weight set. Absent, no composite score is produced. */
export interface RankingPolicy {
  id: string;
  version: string;
  approvedBy: string;
  approvedAt: string;
  /** Component id to weight. */
  benefitWeights: Record<string, number>;
  riskWeights: Record<string, number>;
  uncertaintyWeight: number;
  /** The benchmark the weights were justified against. */
  justification: string;
}

export interface ComparisonResult {
  /** Normalised component table, which is what §6.19 says to display first. */
  table: {
    candidateId: string;
    name: string;
    normalised: Record<string, number>;
    raw: Record<string, number>;
    adverseBurden: number;
    uncertainty: number;
    confidence: Confidence;
  }[];
  /** The Pareto-non-dominated set over benefit, adverse and uncertainty. */
  paretoFront: string[];
  /** Present only when an approved policy was supplied. */
  composite: { candidateId: string; score: number }[] | null;
  /**
   * Components whose raw values barely differ across the compared set.
   *
   * Min-max normalisation maps the smallest raw value to 0 and the largest to
   * 1 whatever the gap between them, so on a small set it manufactures
   * separation: two candidates scoring 0.90 and 0.89 normalise to 1.0 and 0.0
   * and the table then says one is best and the other worst. These are the
   * columns where that is happening, and the comparison says so rather than
   * letting the reader take the spread at face value.
   */
  degenerateComponents: { id: string; name: string; rawSpread: number; note: string }[];
  policy: RankingPolicy | null;
  /** Ordered result, or the explicit statement that there is not one. */
  ranking: string[] | null;
  /** Set when candidates are too close to separate. */
  noClearWinner: string | null;
  /** Pairs whose separation is within the uncertainty. */
  ties: { a: string; b: string; reason: string }[];
  method: string;
}

/**
 * Compare simulated candidates.
 *
 * Normalisation is min-max within the compared set, which makes the table
 * readable and is stated as such: a normalised 1.0 means "best of the
 * candidates that were simulated here", never "good".
 */
export function compareCandidates(
  outcomes: RescueOutcome[],
  policy: RankingPolicy | null,
  separationThreshold = 0.1,
  /**
   * A component whose raw spread is below this fraction of its own scale is
   * reported as not separating the candidates.
   */
  relativeSpreadFloor = 0.05,
): ComparisonResult {
  if (outcomes.length === 0) {
    return {
      table: [], paretoFront: [], composite: null, policy, ranking: null,
      noClearWinner: 'No candidate was simulated, so there is nothing to compare.',
      ties: [], degenerateComponents: [], method: 'rescue.compare.none',
    };
  }

  const componentIds = [...new Set(outcomes.flatMap((o) => o.components.map((c) => c.id)))];
  const ranges = new Map<string, { min: number; max: number; direction: ComponentScore['direction'] }>();
  for (const id of componentIds) {
    let min = Infinity;
    let max = -Infinity;
    let direction: ComponentScore['direction'] = 'higher-is-better';
    for (const outcome of outcomes) {
      const component = outcome.components.find((c) => c.id === id);
      if (!component || !Number.isFinite(component.value)) continue;
      direction = component.direction;
      if (component.value < min) min = component.value;
      if (component.value > max) max = component.value;
    }
    ranges.set(id, { min, max, direction });
  }

  const table = outcomes.map((outcome) => {
    const normalised: Record<string, number> = {};
    const raw: Record<string, number> = {};
    for (const id of componentIds) {
      const component = outcome.components.find((c) => c.id === id);
      const range = ranges.get(id) as { min: number; max: number; direction: ComponentScore['direction'] };
      if (!component || !Number.isFinite(component.value)) {
        normalised[id] = Number.NaN;
        raw[id] = Number.NaN;
        continue;
      }
      raw[id] = component.value;
      const span = range.max - range.min;
      // Everything equal: normalising to 0.5 rather than 0 or 1 avoids
      // inventing a separation the numbers do not contain.
      const scaled = span > 1e-12 ? (component.value - range.min) / span : 0.5;
      normalised[id] = range.direction === 'higher-is-better' ? scaled : 1 - scaled;
    }
    return {
      candidateId: outcome.candidateId,
      name: outcome.name,
      normalised,
      raw,
      adverseBurden: outcome.adverseBurden,
      uncertainty: outcome.uncertainty,
      confidence: outcome.confidence,
    };
  });

  // Pareto front over (mean benefit up, adverse down, uncertainty down).
  const objectives = table.map((row) => {
    const benefits = componentIds
      .filter((id) => (ranges.get(id) as { direction: string }).direction === 'higher-is-better')
      .map((id) => row.normalised[id] as number)
      .filter((value) => Number.isFinite(value));
    return {
      candidateId: row.candidateId,
      benefit: benefits.length > 0 ? mean(benefits) : 0,
      adverse: row.adverseBurden,
      uncertainty: Number.isFinite(row.uncertainty) ? row.uncertainty : 0,
    };
  });

  const paretoFront: string[] = [];
  for (const candidate of objectives) {
    const dominated = objectives.some(
      (other) =>
        other.candidateId !== candidate.candidateId &&
        other.benefit >= candidate.benefit &&
        other.adverse <= candidate.adverse &&
        other.uncertainty <= candidate.uncertainty &&
        (other.benefit > candidate.benefit ||
          other.adverse < candidate.adverse ||
          other.uncertainty < candidate.uncertainty),
    );
    if (!dominated) paretoFront.push(candidate.candidateId);
  }

  // Which components are not actually separating anything.
  const degenerateComponents: ComparisonResult['degenerateComponents'] = [];
  for (const id of componentIds) {
    const range = ranges.get(id) as { min: number; max: number };
    if (!Number.isFinite(range.min) || !Number.isFinite(range.max)) continue;
    const spread = range.max - range.min;
    const scale = Math.max(Math.abs(range.min), Math.abs(range.max));
    if (scale > 0 && spread / scale < relativeSpreadFloor) {
      const name = outcomes
        .flatMap((outcome) => outcome.components)
        .find((component) => component.id === id)?.name ?? id;
      degenerateComponents.push({
        id,
        name,
        rawSpread: spread,
        note:
          `Raw values span ${spread.toPrecision(2)} across the compared candidates, under ${(relativeSpreadFloor * 100).toFixed(0)}% ` +
          'of their own scale. The normalised column still runs from 0 to 1, which makes the candidates look far apart; on this ' +
          'component they are not.',
      });
    }
  }

  let composite: { candidateId: string; score: number }[] | null = null;
  let ranking: string[] | null = null;
  let noClearWinner: string | null = null;
  const ties: { a: string; b: string; reason: string }[] = [];

  if (policy) {
    // §7.7: Score_j = sum(w_b * B_jb) - sum(w_r * R_jr) - w_u * U_j
    composite = table.map((row) => {
      let score = 0;
      for (const [id, weight] of Object.entries(policy.benefitWeights)) {
        const value = row.normalised[id];
        if (Number.isFinite(value)) score += weight * (value as number);
      }
      for (const [id, weight] of Object.entries(policy.riskWeights)) {
        const value = row.normalised[id];
        if (Number.isFinite(value)) score -= weight * (value as number);
      }
      score -= policy.uncertaintyWeight * (Number.isFinite(row.uncertainty) ? row.uncertainty : 0);
      return { candidateId: row.candidateId, score };
    });
    composite.sort((a, b) => b.score - a.score);
    ranking = composite.map((entry) => entry.candidateId);

    const top = composite[0];
    const second = composite[1];
    /*
     * Two ways the top two can fail to be separated, and both matter.
     *
     * The composite scores can be close — the ordinary case. Or every benefit
     * component can be degenerate, in which case the composite scores are far
     * apart *because of the normalisation* and not because the candidates
     * differ. The second was invisible until a two-candidate comparison was
     * tried: min-max on a pair always produces 0 and 1.
     */
    const benefitIds = componentIds.filter(
      (id) => (ranges.get(id) as { direction: ComponentScore['direction'] }).direction === 'higher-is-better',
    );
    const allBenefitsDegenerate =
      benefitIds.length > 0 && benefitIds.every((id) => degenerateComponents.some((entry) => entry.id === id));

    if (top && second && Math.abs(top.score - second.score) < separationThreshold) {
      noClearWinner =
        `The top two candidates are separated by ${Math.abs(top.score - second.score).toFixed(3)}, ` +
        `which is below the ${separationThreshold} threshold this policy considers meaningful. ` +
        'They are reported as not separated rather than ranked.';
    } else if (allBenefitsDegenerate) {
      noClearWinner =
        'Every benefit component has a raw spread under ' +
        `${(relativeSpreadFloor * 100).toFixed(0)}% of its own scale across these candidates. ` +
        'The composite scores differ only because min-max normalisation stretches a negligible difference across the full ' +
        '0-to-1 range, so the ordering below is an artefact of the scaling rather than a finding.';
    }
    for (let i = 0; i < composite.length; i += 1) {
      for (let j = i + 1; j < composite.length; j += 1) {
        const a = composite[i] as { candidateId: string; score: number };
        const b = composite[j] as { candidateId: string; score: number };
        if (Math.abs(a.score - b.score) < separationThreshold) {
          ties.push({
            a: a.candidateId,
            b: b.candidateId,
            reason: `Composite scores differ by ${Math.abs(a.score - b.score).toFixed(3)}, below the ${separationThreshold} separation threshold.`,
          });
        }
      }
    }
  } else {
    noClearWinner =
      'No reviewer-approved weight set is configured, so no composite score is produced and no single ranking is shown. ' +
      `The ${paretoFront.length} candidate(s) on the Pareto front are those that nothing else beats on benefit, adverse burden and uncertainty together (§6.19).`;
  }

  return {
    table,
    paretoFront,
    composite,
    policy,
    ranking,
    noClearWinner,
    ties,
    degenerateComponents,
    method: policy ? `rescue.compare.composite:${policy.id}@${policy.version}` : 'rescue.compare.pareto',
  };
}
