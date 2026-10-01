/**
 * Neighbourhood statistics and spatial domains — §6.7.
 *
 * Everything here is an *association*. The frontend requirement in §6.7 is
 * blunt about it — "proximity is labelled association, not proof of causal
 * signalling" — and the wording of the outputs follows, because a panel headed
 * "interactions" gets read as a claim about signalling whatever the tooltip
 * says.
 *
 * Permutation tests use the +1-corrected p-value from `core/stats`, so the
 * smallest value a 1000-permutation test can report is 1/1001 rather than zero.
 */

import { empiricalZ, permutationPValue, benjaminiHochberg, mean } from '../core/stats';
import type { Rng } from '../core/rng';
import type { MethodRecord } from '../core/provenance';
import type { SpatialGraph } from './graph';
import { neighboursOf } from './graph';

// ---------------------------------------------------------------------------
// Neighbourhood enrichment
// ---------------------------------------------------------------------------

export interface NeighbourhoodEnrichment {
  labels: string[];
  /** labels x labels, observed count of edges between the two classes. */
  observed: Float64Array;
  /** z-score against the label-permutation null. */
  zScore: Float64Array;
  pValue: Float64Array;
  /** BH-adjusted across the upper triangle, which is where the tests are. */
  qValue: Float64Array;
  permutations: number;
  method: MethodRecord;
}

/**
 * Squidpy-style neighbourhood enrichment.
 *
 * The null permutes the *labels* over fixed positions, not the positions over
 * fixed labels. That distinction is the whole test: permuting positions would
 * destroy the tissue geometry and the resulting null would measure how
 * clustered the tissue is, which is not the question.
 */
export function neighbourhoodEnrichment(
  graph: SpatialGraph,
  labels: (string | undefined)[],
  rng: Rng,
  permutations = 1000,
): NeighbourhoodEnrichment {
  const classes = [...new Set(labels.filter((l): l is string => Boolean(l)))].sort();
  const classIndex = new Map(classes.map((name, index) => [name, index]));
  const k = classes.length;

  const assignment = new Int32Array(labels.length).fill(-1);
  labels.forEach((label, index) => {
    if (label !== undefined) assignment[index] = classIndex.get(label) ?? -1;
  });

  const observed = countEdges(graph, assignment, k);

  const nullCounts: Float64Array[] = [];
  const shuffled = Int32Array.from(assignment);
  for (let iteration = 0; iteration < permutations; iteration += 1) {
    // Fisher–Yates over the labelled positions only; unlabelled observations
    // stay unlabelled rather than joining the pool.
    const labelled: number[] = [];
    for (let i = 0; i < shuffled.length; i += 1) if ((assignment[i] as number) >= 0) labelled.push(i);
    for (let i = labelled.length - 1; i > 0; i -= 1) {
      const j = rng.int(i + 1);
      const a = shuffled[labelled[i] as number] as number;
      shuffled[labelled[i] as number] = shuffled[labelled[j] as number] as number;
      shuffled[labelled[j] as number] = a;
    }
    nullCounts.push(countEdges(graph, shuffled, k));
  }

  const zScore = new Float64Array(k * k);
  const pValue = new Float64Array(k * k).fill(Number.NaN);
  for (let a = 0; a < k; a += 1) {
    for (let b = 0; b < k; b += 1) {
      const cell = a * k + b;
      const nullDistribution = Float64Array.from(nullCounts, (counts) => counts[cell] as number);
      zScore[cell] = empiricalZ(observed[cell] as number, nullDistribution);
      pValue[cell] = permutationPValue(observed[cell] as number, nullDistribution, 'two-sided');
    }
  }

  // Adjust over the upper triangle including the diagonal — the matrix is
  // symmetric, so testing both halves would double-count every hypothesis.
  const tested: number[] = [];
  for (let a = 0; a < k; a += 1) for (let b = a; b < k; b += 1) tested.push(a * k + b);
  const adjusted = benjaminiHochberg(tested.map((cell) => pValue[cell] as number));
  const qValue = new Float64Array(k * k).fill(Number.NaN);
  tested.forEach((cell, index) => {
    const a = Math.floor(cell / k);
    const b = cell % k;
    const value = adjusted[index] as number;
    qValue[a * k + b] = value;
    qValue[b * k + a] = value;
  });

  return {
    labels: classes,
    observed,
    zScore,
    pValue,
    qValue,
    permutations,
    method: {
      id: 'spatial.neighbourhood-enrichment',
      name: 'Neighbourhood enrichment',
      version: '1.0.0',
      software: 'spatial-omics-engine',
      parameters: { permutations, graph: graph.graphId, nullModel: 'label permutation on fixed coordinates' },
      summary:
        `Counted physical edges between each pair of ${k} classes and compared them with ${permutations} label permutations. ` +
        'A positive z means the two classes neighbour each other more often than chance, which is an association and not evidence of signalling.',
      references: [
        'Palla G, Spitzer H, Klein M, et al. Squidpy. Nature Methods 2022;19:171-178. doi:10.1038/s41592-021-01358-2',
      ],
    },
  };
}

function countEdges(graph: SpatialGraph, assignment: Int32Array, k: number): Float64Array {
  const counts = new Float64Array(k * k);
  for (const edge of graph.edges) {
    if (edge.edgeType !== 'physical') continue;
    const a = assignment[edge.source] as number;
    const b = assignment[edge.target] as number;
    if (a < 0 || b < 0) continue;
    counts[a * k + b] = (counts[a * k + b] as number) + 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Spatial autocorrelation
// ---------------------------------------------------------------------------

export interface SpatialAutocorrelation {
  featureId: string;
  moransI: number;
  gearysC: number;
  pValue: number;
  qValue: number;
  permutations: number;
}

/**
 * Moran's I and Geary's C per feature, with a permutation null.
 *
 * Both are reported because they answer different questions: Moran's I is a
 * global statement about whether similar values cluster, Geary's C is more
 * sensitive to local difference, and a feature high on one and not the other is
 * telling you something about the scale of its pattern.
 */
export function spatialAutocorrelation(
  graph: SpatialGraph,
  values: Float64Array[],
  featureIds: string[],
  rng: Rng,
  permutations = 1000,
): SpatialAutocorrelation[] {
  const weights = symmetricWeights(graph);
  const results: Omit<SpatialAutocorrelation, 'qValue'>[] = [];

  for (let f = 0; f < values.length; f += 1) {
    const value = values[f] as Float64Array;
    const observedI = moransI(value, weights);
    const observedC = gearysC(value, weights);

    const nullDistribution = new Float64Array(permutations);
    const permuted = new Float64Array(value.length);
    for (let iteration = 0; iteration < permutations; iteration += 1) {
      permuted.set(value);
      for (let i = permuted.length - 1; i > 0; i -= 1) {
        const j = rng.int(i + 1);
        const a = permuted[i] as number;
        permuted[i] = permuted[j] as number;
        permuted[j] = a;
      }
      nullDistribution[iteration] = moransI(permuted, weights);
    }

    results.push({
      featureId: featureIds[f] as string,
      moransI: observedI,
      gearysC: observedC,
      pValue: permutationPValue(observedI, nullDistribution, 'two-sided'),
      permutations,
    });
  }

  const adjusted = benjaminiHochberg(results.map((r) => r.pValue));
  return results.map((result, index) => ({ ...result, qValue: adjusted[index] as number }));
}

export interface WeightMatrix {
  indptr: Int32Array;
  indices: Int32Array;
  weights: Float64Array;
  total: number;
  nodeCount: number;
}

/** Physical edges only, symmetrised, with the total weight precomputed. */
export function symmetricWeights(graph: SpatialGraph): WeightMatrix {
  const lists: { index: number; weight: number }[][] = Array.from(
    { length: graph.nodeCount },
    () => [] as { index: number; weight: number }[],
  );
  const seen = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.edgeType !== 'physical') continue;
    const key = edge.source < edge.target ? `${edge.source}|${edge.target}` : `${edge.target}|${edge.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    (lists[edge.source] as { index: number; weight: number }[]).push({ index: edge.target, weight: edge.weight });
    (lists[edge.target] as { index: number; weight: number }[]).push({ index: edge.source, weight: edge.weight });
  }

  const indptr = new Int32Array(graph.nodeCount + 1);
  let total = 0;
  for (let i = 0; i < graph.nodeCount; i += 1) {
    indptr[i + 1] = (indptr[i] as number) + (lists[i] as unknown[]).length;
  }
  const indices = new Int32Array(indptr[graph.nodeCount] as number);
  const weights = new Float64Array(indptr[graph.nodeCount] as number);
  let cursor = 0;
  for (let i = 0; i < graph.nodeCount; i += 1) {
    for (const entry of lists[i] as { index: number; weight: number }[]) {
      indices[cursor] = entry.index;
      weights[cursor] = entry.weight;
      total += entry.weight;
      cursor += 1;
    }
  }
  return { indptr, indices, weights, total, nodeCount: graph.nodeCount };
}

export function moransI(values: ArrayLike<number>, weights: WeightMatrix): number {
  const n = weights.nodeCount;
  const mu = mean(values);
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i += 1) {
    const di = (values[i] as number) - mu;
    denominator += di * di;
    const from = weights.indptr[i] as number;
    const to = weights.indptr[i + 1] as number;
    for (let k = from; k < to; k += 1) {
      const dj = (values[weights.indices[k] as number] as number) - mu;
      numerator += (weights.weights[k] as number) * di * dj;
    }
  }
  if (denominator === 0 || weights.total === 0) return Number.NaN;
  return (n / weights.total) * (numerator / denominator);
}

export function gearysC(values: ArrayLike<number>, weights: WeightMatrix): number {
  const n = weights.nodeCount;
  const mu = mean(values);
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i += 1) {
    const di = (values[i] as number) - mu;
    denominator += di * di;
    const from = weights.indptr[i] as number;
    const to = weights.indptr[i + 1] as number;
    for (let k = from; k < to; k += 1) {
      const d = (values[i] as number) - (values[weights.indices[k] as number] as number);
      numerator += (weights.weights[k] as number) * d * d;
    }
  }
  if (denominator === 0 || weights.total === 0) return Number.NaN;
  return ((n - 1) * numerator) / (2 * weights.total * denominator);
}

// ---------------------------------------------------------------------------
// Spatial domains
// ---------------------------------------------------------------------------

export interface SpatialDomains {
  /** Domain index per observation. */
  assignment: Int32Array;
  domainCount: number;
  /** Fraction of neighbours sharing an observation's domain — a coherence check. */
  spatialCoherence: number;
  /** Per-domain observation counts. */
  sizes: Int32Array;
  method: MethodRecord;
}

/**
 * Spatially smoothed k-means over the embedding.
 *
 * Clustering the expression alone produces cell types scattered across the
 * section; what §6.5 asks for is *regions*. Smoothing each observation's
 * embedding over its neighbours before clustering is the same idea BayesSpace
 * and SpaGCN implement more elaborately, and it is enough to recover contiguous
 * tissue domains while staying explainable in two sentences — which matters
 * here, because the panel has to say what it did.
 *
 * `smoothing` is the weight given to the neighbourhood mean. At 0 this is plain
 * expression clustering; at 1 the observation's own profile is ignored.
 */
export function spatialDomains(
  embedding: Float64Array,
  dimensions: number,
  graph: SpatialGraph,
  k: number,
  rng: Rng,
  smoothing = 0.5,
  restarts = 10,
): SpatialDomains {
  const n = graph.nodeCount;
  const smoothed = new Float64Array(n * dimensions);

  for (let i = 0; i < n; i += 1) {
    const neighbours = neighboursOf(graph, i, 'physical');
    let totalWeight = 0;
    const accumulator = new Float64Array(dimensions);
    for (const neighbour of neighbours) {
      totalWeight += neighbour.weight;
      for (let d = 0; d < dimensions; d += 1) {
        accumulator[d] =
          (accumulator[d] as number) + neighbour.weight * (embedding[neighbour.index * dimensions + d] as number);
      }
    }
    for (let d = 0; d < dimensions; d += 1) {
      const own = embedding[i * dimensions + d] as number;
      const neighbourhood = totalWeight > 0 ? (accumulator[d] as number) / totalWeight : own;
      smoothed[i * dimensions + d] = (1 - smoothing) * own + smoothing * neighbourhood;
    }
  }

  const best = kMeans(smoothed, n, dimensions, k, rng, restarts);

  let sharing = 0;
  let edgeCount = 0;
  for (let i = 0; i < n; i += 1) {
    for (const neighbour of neighboursOf(graph, i, 'physical')) {
      edgeCount += 1;
      if ((best.assignment[i] as number) === (best.assignment[neighbour.index] as number)) sharing += 1;
    }
  }

  const sizes = new Int32Array(k);
  for (let i = 0; i < n; i += 1) sizes[best.assignment[i] as number] = (sizes[best.assignment[i] as number] as number) + 1;

  return {
    assignment: best.assignment,
    domainCount: k,
    spatialCoherence: edgeCount > 0 ? sharing / edgeCount : Number.NaN,
    sizes,
    method: {
      id: 'spatial.domains',
      name: 'Spatial domain detection',
      version: '1.0.0',
      software: 'spatial-omics-engine',
      parameters: { k, smoothing, restarts, dimensions, graph: graph.graphId, algorithm: 'k-means++ on a neighbourhood-smoothed embedding' },
      summary:
        `Each observation's embedding was mixed ${((1 - smoothing) * 100).toFixed(0)}:${(smoothing * 100).toFixed(0)} with its ` +
        `neighbourhood mean, then clustered into ${k} domains by k-means with ${restarts} restarts. ` +
        `${(((edgeCount > 0 ? sharing / edgeCount : 0)) * 100).toFixed(1)}% of neighbouring pairs share a domain, which is the coherence this smoothing bought.`,
    },
  };
}

interface KMeansResult {
  assignment: Int32Array;
  centroids: Float64Array;
  inertia: number;
}

/** k-means++ seeding, Lloyd iterations, best of `restarts` by inertia. */
function kMeans(
  data: Float64Array,
  n: number,
  dimensions: number,
  k: number,
  rng: Rng,
  restarts: number,
): KMeansResult {
  let best: KMeansResult | null = null;

  for (let restart = 0; restart < restarts; restart += 1) {
    const centroids = new Float64Array(k * dimensions);
    const first = rng.int(n);
    for (let d = 0; d < dimensions; d += 1) centroids[d] = data[first * dimensions + d] as number;

    const closest = new Float64Array(n).fill(Infinity);
    for (let c = 1; c < k; c += 1) {
      let total = 0;
      for (let i = 0; i < n; i += 1) {
        const distance = squaredDistance(data, i, centroids, c - 1, dimensions);
        if (distance < (closest[i] as number)) closest[i] = distance;
        total += closest[i] as number;
      }
      let target = rng.next() * total;
      let chosen = n - 1;
      for (let i = 0; i < n; i += 1) {
        target -= closest[i] as number;
        if (target <= 0) {
          chosen = i;
          break;
        }
      }
      for (let d = 0; d < dimensions; d += 1) {
        centroids[c * dimensions + d] = data[chosen * dimensions + d] as number;
      }
    }

    const assignment = new Int32Array(n);
    let inertia = 0;
    for (let iteration = 0; iteration < 100; iteration += 1) {
      let moved = false;
      inertia = 0;
      for (let i = 0; i < n; i += 1) {
        let bestCluster = 0;
        let bestDistance = Infinity;
        for (let c = 0; c < k; c += 1) {
          const distance = squaredDistance(data, i, centroids, c, dimensions);
          if (distance < bestDistance) {
            bestDistance = distance;
            bestCluster = c;
          }
        }
        inertia += bestDistance;
        if ((assignment[i] as number) !== bestCluster) {
          assignment[i] = bestCluster;
          moved = true;
        }
      }

      const counts = new Int32Array(k);
      centroids.fill(0);
      for (let i = 0; i < n; i += 1) {
        const cluster = assignment[i] as number;
        counts[cluster] = (counts[cluster] as number) + 1;
        for (let d = 0; d < dimensions; d += 1) {
          centroids[cluster * dimensions + d] =
            (centroids[cluster * dimensions + d] as number) + (data[i * dimensions + d] as number);
        }
      }
      for (let c = 0; c < k; c += 1) {
        const count = counts[c] as number;
        if (count === 0) {
          // An empty cluster is re-seeded on the point furthest from its own
          // centroid, rather than left empty to distort the inertia.
          const orphan = rng.int(n);
          for (let d = 0; d < dimensions; d += 1) {
            centroids[c * dimensions + d] = data[orphan * dimensions + d] as number;
          }
          continue;
        }
        for (let d = 0; d < dimensions; d += 1) {
          centroids[c * dimensions + d] = (centroids[c * dimensions + d] as number) / count;
        }
      }

      if (!moved && iteration > 0) break;
    }

    if (!best || inertia < best.inertia) {
      best = { assignment: Int32Array.from(assignment), centroids: Float64Array.from(centroids), inertia };
    }
  }

  return best as KMeansResult;
}

function squaredDistance(
  data: Float64Array,
  row: number,
  centroids: Float64Array,
  cluster: number,
  dimensions: number,
): number {
  let total = 0;
  for (let d = 0; d < dimensions; d += 1) {
    const difference = (data[row * dimensions + d] as number) - (centroids[cluster * dimensions + d] as number);
    total += difference * difference;
  }
  return total;
}
