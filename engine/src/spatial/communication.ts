/**
 * Spatial cell-cell communication — §6.7, with COMMOT as the named preference.
 *
 * The naive ligand-receptor score is `ligand_i * receptor_j` for every pair
 * within some distance, and it has a specific failure: a cell expressing a
 * ligand strongly is scored as signalling to *every* receptor-positive
 * neighbour at full strength, so a high-ligand cell in a dense region appears
 * to be driving the whole neighbourhood. That is not how a secreted molecule
 * behaves — there is a finite amount of it, and neighbours compete.
 *
 * COMMOT's answer is to treat the problem as optimal transport: ligand supply
 * and receptor demand are marginals, and the transport plan is what gets
 * reported. This implements that, with two departures stated plainly:
 *
 *  - The cost is restricted to a sparse spatial neighbourhood rather than the
 *    full n x n plan. Beyond the diffusion range the transport cost is
 *    effectively infinite anyway, and the dense version is quadratic in cells.
 *  - The transport is *unbalanced*: ligand that finds no receptor is not forced
 *    onto a distant cell. A balanced plan would move every unit somewhere, and
 *    the somewhere would be an artefact.
 *
 * The result is a candidate communication edge with a score and a permutation
 * p-value. It is an association between co-expression and proximity. It is not
 * evidence that the signal was sent.
 */

import { permutationPValue, benjaminiHochberg } from '../core/stats';
import type { Rng } from '../core/rng';
import type { MethodRecord } from '../core/provenance';
import type { ObservationRecord } from '../data/types';
import { GridIndex } from './graph';

/** One curated ligand-receptor interaction from the resource pack. */
export interface LigandReceptorPair {
  id: string;
  ligand: string;
  /** A receptor complex is all-of: every subunit must be present. */
  receptorSubunits: string[];
  /** Where the record came from, so §16.1 can name the database version. */
  source: string;
  /** Secreted signals travel; contact-dependent ones do not. */
  mode: 'secreted' | 'contact' | 'ecm';
  pathway: string;
}

export interface CommunicationEdge {
  pairId: string;
  source: number;
  target: number;
  distance: number;
  /** Transported units of ligand-receptor engagement. */
  score: number;
}

export interface CommunicationResult {
  pairId: string;
  ligand: string;
  receptor: string;
  pathway: string;
  mode: LigandReceptorPair['mode'];
  /** Total transported mass, the pair-level summary. */
  totalScore: number;
  pValue: number;
  qValue: number;
  edges: CommunicationEdge[];
  /** Per-observation sent and received totals. */
  sent: Float64Array;
  received: Float64Array;
  /** Set when a subunit of the receptor complex is not in the panel. */
  incomplete: string[];
}

const EMPTY = new Float64Array(0);

export interface CommunicationOptions {
  /**
   * Largest number of transport edges kept per pair.
   *
   * The plan over a 200 µm neighbourhood in a 2,400-cell section has of the
   * order of 10^5 entries, almost all of them negligible. Keeping the strongest
   * `maximumEdges` bounds both the artefact size and the overlay the client
   * has to draw; the per-cell sent and received totals are computed over *all*
   * of them, so no mass is lost from the summaries.
   */
  maximumEdges: number;
  /**
   * Budget on the sparse neighbourhood, in entries.
   *
   * The transport problem is O(entries) per Sinkhorn iteration and the
   * neighbourhood grows with the square of the range and linearly with the cell
   * count, so a large section at a 200 µm secreted range is where this stops
   * fitting. Rather than fail on a big upload, the range is reduced until the
   * neighbourhood fits and the reduction is reported in the method record —
   * a smaller stated range is a weaker but honest result; an out-of-memory
   * kill mid-run is neither.
   */
  neighbourhoodBudget: number;
  /**
   * Distance beyond which transport is not considered, in coordinate units.
   * Mode-dependent: a contact interaction uses the first neighbour shell.
   */
  secretedRange: number;
  contactRange: number;
  /** Entropic regularisation. Higher spreads the plan; lower sharpens it. */
  epsilon: number;
  /** Unbalanced penalty. Higher forces more of the supply to be transported. */
  marginalPenalty: number;
  sinkhornIterations: number;
  permutations: number;
}

export const DEFAULT_COMMUNICATION: CommunicationOptions = {
  maximumEdges: 20_000,
  neighbourhoodBudget: 4_000_000,
  secretedRange: 200,
  contactRange: 30,
  epsilon: 0.1,
  marginalPenalty: 1,
  sinkhornIterations: 100,
  permutations: 200,
};

export function spatialCommunication(
  observations: ObservationRecord[],
  expression: (symbol: string) => Float64Array | null,
  pairs: LigandReceptorPair[],
  options: CommunicationOptions,
  rng: Rng,
  resourceVersion: string,
): { results: CommunicationResult[]; method: MethodRecord } {
  const index = new GridIndex(observations);
  const partial: Omit<CommunicationResult, 'qValue'>[] = [];
  const rangeReductions: string[] = [];

  for (const pair of pairs) {
    const ligand = expression(pair.ligand);
    const incomplete: string[] = [];
    if (!ligand) incomplete.push(pair.ligand);

    const subunits: Float64Array[] = [];
    for (const subunit of pair.receptorSubunits) {
      const values = expression(subunit);
      if (!values) incomplete.push(subunit);
      else subunits.push(values);
    }

    const receptorName = pair.receptorSubunits.join('+');
    if (!ligand || subunits.length !== pair.receptorSubunits.length) {
      // Reported as incomplete rather than scored with the subunits that are
      // present: a complex missing a subunit is not a weaker version of itself.
      partial.push({
        pairId: pair.id,
        ligand: pair.ligand,
        receptor: receptorName,
        pathway: pair.pathway,
        mode: pair.mode,
        totalScore: Number.NaN,
        pValue: Number.NaN,
        edges: [],
        sent: new Float64Array(observations.length),
        received: new Float64Array(observations.length),
        incomplete,
      });
      continue;
    }

    // Geometric mean across subunits: a complex is limited by its scarcest
    // part, and the arithmetic mean would let one abundant subunit carry it.
    const receptor = new Float64Array(observations.length);
    for (let i = 0; i < observations.length; i += 1) {
      let product = 1;
      for (const values of subunits) product *= Math.max(0, values[i] as number);
      receptor[i] = Math.pow(product, 1 / subunits.length);
    }

    const requestedRange = pair.mode === 'contact' ? options.contactRange : options.secretedRange;
    const range = fitRange(observations.length, requestedRange, options.neighbourhoodBudget, observations);
    if (range < requestedRange) {
      rangeReductions.push(
        `${pair.id}: range reduced from ${requestedRange} to ${range.toFixed(0)} coordinate units to stay inside the ${options.neighbourhoodBudget.toLocaleString()}-entry neighbourhood budget.`,
      );
    }
    const neighbourhood = buildNeighbourhood(observations, index, range);
    const plan = unbalancedSinkhorn(ligand, receptor, neighbourhood, options);

    const nullTotals = new Float64Array(options.permutations);
    const shuffledReceptor = new Float64Array(receptor.length);
    for (let iteration = 0; iteration < options.permutations; iteration += 1) {
      shuffledReceptor.set(receptor);
      for (let i = shuffledReceptor.length - 1; i > 0; i -= 1) {
        const j = rng.int(i + 1);
        const a = shuffledReceptor[i] as number;
        shuffledReceptor[i] = shuffledReceptor[j] as number;
        shuffledReceptor[j] = a;
      }
      nullTotals[iteration] = unbalancedSinkhorn(
        ligand,
        shuffledReceptor,
        neighbourhood,
        {
          ...options,
          // The null does not need the plan refined to convergence; it needs
          // the same estimator applied to shuffled data, and fewer iterations
          // of the same estimator is still that.
          sinkhornIterations: Math.max(10, Math.floor(options.sinkhornIterations / 4)),
        },
        false,
      ).total;
    }

    partial.push({
      pairId: pair.id,
      ligand: pair.ligand,
      receptor: receptorName,
      pathway: pair.pathway,
      mode: pair.mode,
      totalScore: plan.total,
      pValue: permutationPValue(plan.total, nullTotals, 'greater'),
      edges: plan.edges
        .sort((a, b) => b.score - a.score)
        .slice(0, options.maximumEdges)
        .map((edge) => ({ ...edge, pairId: pair.id })),
      sent: plan.sent,
      received: plan.received,
      incomplete,
    });
  }

  const testable = partial.map((result) => result.pValue);
  const adjusted = benjaminiHochberg(testable);
  const results = partial.map((result, i) => ({ ...result, qValue: adjusted[i] as number }));

  return {
    results,
    method: {
      id: 'spatial.communication',
      name: 'Spatial ligand-receptor communication',
      version: '1.0.0',
      software: 'spatial-omics-engine',
      parameters: {
        model: 'sparse unbalanced entropic optimal transport',
        secretedRange: options.secretedRange,
        contactRange: options.contactRange,
        epsilon: options.epsilon,
        marginalPenalty: options.marginalPenalty,
        sinkhornIterations: options.sinkhornIterations,
        permutations: options.permutations,
        maximumEdges: options.maximumEdges,
        neighbourhoodBudget: options.neighbourhoodBudget,
        rangeReductions,
        resourceVersion,
      },
      summary:
        'Ligand supply and receptor demand were treated as marginals of an unbalanced optimal transport problem over a distance-limited neighbourhood, ' +
        'so neighbours compete for a finite ligand rather than each being scored at full strength. ' +
        `Significance is against ${options.permutations} receptor permutations. These are candidate interactions — proximity and co-expression, not observed signalling.` +
        (rangeReductions.length > 0
          ? ` ${rangeReductions.length} pair(s) had their interaction range reduced to fit the neighbourhood budget: ${rangeReductions.join(' ')}`
          : ''),
      references: [
        'Cang Z, Zhao Y, Almet AA, et al. Screening cell-cell communication in spatial transcriptomics via collective optimal transport. Nature Methods 2023;20:218-228. doi:10.1038/s41592-022-01728-4',
      ],
    },
  };
}

interface Neighbourhood {
  indptr: Int32Array;
  indices: Int32Array;
  distances: Float64Array;
  /** exp(-cost/epsilon) is precomputed per call, so the kernel is the distance. */
}

/**
 * The largest range whose neighbourhood fits the budget.
 *
 * Measured rather than assumed: a section's density is not uniform, so the
 * entry count is estimated by sampling actual neighbourhood sizes and scaling.
 */
function fitRange(
  observationCount: number,
  requestedRange: number,
  budget: number,
  observations: ObservationRecord[],
): number {
  if (observationCount === 0) return requestedRange;
  const index = new GridIndex(observations);
  const sampleSize = Math.min(40, observationCount);
  const stride = Math.max(1, Math.floor(observationCount / sampleSize));

  let sampled = 0;
  let entries = 0;
  for (let i = 0; i < observationCount; i += stride) {
    entries += index.within(i, requestedRange).length + 1;
    sampled += 1;
  }
  const estimated = sampled > 0 ? (entries / sampled) * observationCount : 0;
  if (estimated <= budget) return requestedRange;

  // Entries scale roughly with the area, so with the radius squared.
  return requestedRange * Math.sqrt(budget / Math.max(1, estimated));
}

function buildNeighbourhood(
  observations: ObservationRecord[],
  index: GridIndex,
  range: number,
): Neighbourhood {
  const n = observations.length;
  const lists: { index: number; distance: number }[][] = [];
  let total = 0;
  for (let i = 0; i < n; i += 1) {
    const found = index.within(i, range);
    lists.push(found);
    total += found.length;
  }
  const indptr = new Int32Array(n + 1);
  const indices = new Int32Array(total);
  const distances = new Float64Array(total);
  let cursor = 0;
  for (let i = 0; i < n; i += 1) {
    indptr[i] = cursor;
    for (const entry of lists[i] as { index: number; distance: number }[]) {
      indices[cursor] = entry.index;
      distances[cursor] = entry.distance;
      cursor += 1;
    }
  }
  indptr[n] = cursor;
  return { indptr, indices, distances };
}

/**
 * Unbalanced Sinkhorn on a sparse cost.
 *
 * The cost is normalised distance, so `epsilon` means the same thing whatever
 * unit the coordinates are in — without that normalisation the same epsilon
 * gives a near-uniform plan on a micrometre grid and a near-degenerate one on a
 * pixel grid, which is exactly the kind of unit sensitivity §5.2 warns about.
 */
/**
 * `collectEdges` exists because of a crash.
 *
 * The permutation null runs this two hundred times per ligand-receptor pair and
 * uses only `total`. The first version built the full transport plan every time
 * — up to a hundred and forty thousand edge objects per call — and the server
 * process was killed part-way through the communication stage with no error in
 * the log, which reads exactly like a hang. Nothing about the null needs the
 * plan; it needs the same estimator applied to shuffled data.
 */
function unbalancedSinkhorn(
  supply: Float64Array,
  demand: Float64Array,
  neighbourhood: Neighbourhood,
  options: CommunicationOptions,
  collectEdges = true,
): { edges: Omit<CommunicationEdge, 'pairId'>[]; total: number; sent: Float64Array; received: Float64Array } {
  const n = supply.length;
  const entries = neighbourhood.indices.length;
  if (entries === 0) {
    return { edges: [], total: 0, sent: new Float64Array(n), received: new Float64Array(n) };
  }

  let maxDistance = 0;
  for (let k = 0; k < entries; k += 1) {
    const distance = neighbourhood.distances[k] as number;
    if (distance > maxDistance) maxDistance = distance;
  }
  const scale = maxDistance > 0 ? maxDistance : 1;

  const kernel = new Float64Array(entries);
  for (let k = 0; k < entries; k += 1) {
    kernel[k] = Math.exp(-((neighbourhood.distances[k] as number) / scale) / options.epsilon);
  }

  const u = new Float64Array(n).fill(1);
  const v = new Float64Array(n).fill(1);
  // The unbalanced exponent: at tau = 1 the marginals are matched as in the
  // balanced problem; below 1 supply may go unmatched.
  const tau = options.marginalPenalty / (options.marginalPenalty + options.epsilon);

  const rowSum = new Float64Array(n);
  const columnSum = new Float64Array(n);

  for (let iteration = 0; iteration < options.sinkhornIterations; iteration += 1) {
    rowSum.fill(0);
    for (let i = 0; i < n; i += 1) {
      const from = neighbourhood.indptr[i] as number;
      const to = neighbourhood.indptr[i + 1] as number;
      let total = 0;
      for (let k = from; k < to; k += 1) {
        total += (kernel[k] as number) * (v[neighbourhood.indices[k] as number] as number);
      }
      rowSum[i] = total;
    }
    for (let i = 0; i < n; i += 1) {
      const total = rowSum[i] as number;
      u[i] = total > 0 ? Math.pow((supply[i] as number) / total, tau) : 0;
    }

    columnSum.fill(0);
    for (let i = 0; i < n; i += 1) {
      const from = neighbourhood.indptr[i] as number;
      const to = neighbourhood.indptr[i + 1] as number;
      const ui = u[i] as number;
      if (ui === 0) continue;
      for (let k = from; k < to; k += 1) {
        const j = neighbourhood.indices[k] as number;
        columnSum[j] = (columnSum[j] as number) + (kernel[k] as number) * ui;
      }
    }
    for (let j = 0; j < n; j += 1) {
      const total = columnSum[j] as number;
      v[j] = total > 0 ? Math.pow((demand[j] as number) / total, tau) : 0;
    }
  }

  const edges: Omit<CommunicationEdge, 'pairId'>[] = [];
  const sent = collectEdges ? new Float64Array(n) : EMPTY;
  const received = collectEdges ? new Float64Array(n) : EMPTY;
  let total = 0;

  for (let i = 0; i < n; i += 1) {
    const from = neighbourhood.indptr[i] as number;
    const to = neighbourhood.indptr[i + 1] as number;
    const ui = u[i] as number;
    if (ui === 0) continue;
    for (let k = from; k < to; k += 1) {
      const j = neighbourhood.indices[k] as number;
      const mass = ui * (kernel[k] as number) * (v[j] as number);
      if (!(mass > 1e-9)) continue;
      total += mass;
      if (!collectEdges) continue;
      sent[i] = (sent[i] as number) + mass;
      received[j] = (received[j] as number) + mass;
      edges.push({ source: i, target: j, distance: neighbourhood.distances[k] as number, score: mass });
    }
  }

  return { edges, total, sent, received };
}

/**
 * Sender/receiver summary by class, for the panel §6.7 describes.
 *
 * Aggregating by cell type is what makes the result legible — a list of
 * fourteen thousand edges is not a finding, and "macrophages are the dominant
 * sender of this pathway into the tumour core" is.
 */
export function summariseByClass(
  result: CommunicationResult,
  labels: (string | undefined)[],
): { source: string; target: string; score: number; edges: number }[] {
  const totals = new Map<string, { score: number; edges: number }>();
  for (const edge of result.edges) {
    const source = labels[edge.source];
    const target = labels[edge.target];
    if (!source || !target) continue;
    const key = `${source}\u0000${target}`;
    const existing = totals.get(key);
    if (existing) {
      existing.score += edge.score;
      existing.edges += 1;
    } else {
      totals.set(key, { score: edge.score, edges: 1 });
    }
  }
  return [...totals.entries()]
    .map(([key, value]) => {
      const [source, target] = key.split('\u0000');
      return { source: source as string, target: target as string, score: value.score, edges: value.edges };
    })
    .sort((a, b) => b.score - a.score);
}
