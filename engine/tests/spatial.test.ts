/**
 * The spatial layer: graph construction, neighbourhood statistics and the
 * ablation controls §14.3 depends on.
 *
 * Moran's I is checked against arrangements whose answer is known by
 * construction — a smooth gradient must be strongly positive, a checkerboard
 * strongly negative — because a spatial statistic that is subtly wrong is not
 * visibly wrong, and every downstream claim about tissue organisation rests
 * on it.
 */

import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import {
  ablateGraph, buildSpatialGraph, neighboursOf, shuffleGraph, type GraphEdge,
} from '../src/spatial/graph';
import {
  gearysC, moransI, neighbourhoodEnrichment, spatialDomains, symmetricWeights,
} from '../src/spatial/neighbourhood';
import type { ObservationRecord } from '../src/data/types';

function grid(side: number, pitch = 10): ObservationRecord[] {
  const out: ObservationRecord[] = [];
  for (let row = 0; row < side; row += 1) {
    for (let column = 0; column < side; column += 1) {
      out.push({ id: `c${row}_${column}`, x: column * pitch, y: row * pitch, sampleId: 's' });
    }
  }
  return out;
}

describe('graph construction', () => {
  const observations = grid(12);

  it('builds a symmetric kNN graph with the requested degree', () => {
    const graph = buildSpatialGraph(observations, { method: 'knn', k: 4 }, 'um');
    expect(graph.diagnostics.symmetric).toBe(true);
    expect(graph.diagnostics.medianDegree).toBeGreaterThanOrEqual(4);
    expect(graph.diagnostics.isolatedNodes).toBe(0);
    expect(graph.diagnostics.components).toBe(1);
  });

  it('gives the same checksum for the same inputs and a different one otherwise', () => {
    const a = buildSpatialGraph(observations, { method: 'knn', k: 4 }, 'um');
    const b = buildSpatialGraph(observations, { method: 'knn', k: 4 }, 'um');
    const c = buildSpatialGraph(observations, { method: 'knn', k: 6 }, 'um');
    expect(b.checksum).toBe(a.checksum);
    expect(c.checksum).not.toBe(a.checksum);
  });

  it('finds the true nearest neighbours, matching a brute-force search', () => {
    /*
     * Jittered, not a regular lattice.
     *
     * On an exact grid every cell has four neighbours at identical distance, so
     * k = 3 has to break a tie and any two correct implementations can pick
     * different members of it. Comparing identities there tests the tie-break,
     * not the search. Jitter removes the ties and makes the answer unique.
     */
    const rng = new Rng(21);
    const jittered = observations.map((observation) => ({
      ...observation,
      x: observation.x + rng.uniform(-3, 3),
      y: observation.y + rng.uniform(-3, 3),
    }));
    const graph = buildSpatialGraph(jittered, { method: 'knn', k: 3, symmetrise: false }, 'um');

    // Every node, not a sample: the grid index is an optimisation, and if it
    // disagrees with brute force anywhere the whole neighbourhood layer is
    // measuring something else.
    for (let index = 0; index < jittered.length; index += 1) {
      const fromGraph = new Set(neighboursOf(graph, index, 'physical').map((entry) => entry.index));
      const origin = jittered[index] as ObservationRecord;
      const brute = jittered
        .map((observation, i) => ({ i, d: Math.hypot(observation.x - origin.x, observation.y - origin.y) }))
        .filter((entry) => entry.i !== index)
        .sort((a, b) => a.d - b.d)
        .slice(0, 3)
        .map((entry) => entry.i);
      expect([...fromGraph].sort((a, b) => a - b), `node ${index}`).toEqual(brute.sort((a, b) => a - b));
    }
  });

  it('derives a radius from the data when none is given, and says so', () => {
    const graph = buildSpatialGraph(observations, { method: 'radius' }, 'um');
    expect(graph.diagnostics.warnings.join(' ')).toContain('no universal fixed radius');
    expect(graph.edges.length).toBeGreaterThan(0);
  });

  it('builds a Delaunay graph and trims the long edges across empty space', () => {
    const graph = buildSpatialGraph(observations, { method: 'delaunay', delaunayMaxEdgeFactor: 2 }, 'um');
    expect(graph.edges.length).toBeGreaterThan(observations.length);
    expect(graph.diagnostics.maximumEdgeLength).toBeLessThan(graph.diagnostics.medianEdgeLength * 3);
  });

  it('keeps physical and biological edges as distinct types', () => {
    const biological: GraphEdge[] = [
      { source: 0, target: 100, distance: 400, weight: 0.9, edgeType: 'biological', interaction: 'TGFB1->TGFBR1' },
    ];
    const graph = buildSpatialGraph(observations, { method: 'knn', k: 4 }, 'um', biological);
    expect(graph.diagnostics.biologicalEdges).toBe(1);
    // §5.4: distinct types, not merged into one weight.
    expect(neighboursOf(graph, 0, 'biological')).toHaveLength(1);
    expect(neighboursOf(graph, 0, 'physical').some((entry) => entry.index === 100)).toBe(false);
  });
});

describe('the ablation controls', () => {
  const observations = grid(10);
  const biological: GraphEdge[] = [
    { source: 0, target: 50, distance: 200, weight: 0.5, edgeType: 'biological' },
  ];
  const graph = buildSpatialGraph(observations, { method: 'knn', k: 4 }, 'um', biological);

  it('removes an edge class entirely rather than masking it', () => {
    const ablated = ablateGraph(graph, 'biological');
    expect(ablated.diagnostics.biologicalEdges).toBe(0);
    expect(ablated.diagnostics.physicalEdges).toBe(graph.diagnostics.physicalEdges);
    expect(ablated.checksum).not.toBe(graph.checksum);
    expect(ablated.diagnostics.warnings.join(' ')).toContain('Ablation');
  });

  it('keeps the degree sequence when shuffling, so only the neighbours change', () => {
    const permutation = new Rng(7).permutation(graph.nodeCount);
    const shuffled = shuffleGraph(graph, permutation);
    expect(shuffled.edges).toHaveLength(graph.edges.length);
    for (let node = 0; node < graph.nodeCount; node += 1) {
      expect(neighboursOf(shuffled, node).length).toBe(neighboursOf(graph, node).length);
    }
    expect(shuffled.diagnostics.warnings.join(' ')).toContain('not spatial');
  });
});

describe('spatial autocorrelation', () => {
  const side = 14;
  const observations = grid(side);
  const graph = buildSpatialGraph(observations, { method: 'knn', k: 4 }, 'um');
  const weights = symmetricWeights(graph);

  it('is strongly positive for a smooth gradient', () => {
    const values = Float64Array.from(observations, (observation) => observation.x);
    expect(moransI(values, weights)).toBeGreaterThan(0.7);
    // Geary's C runs the other way: near 0 for strong positive autocorrelation.
    expect(gearysC(values, weights)).toBeLessThan(0.4);
  });

  it('is strongly negative for a checkerboard', () => {
    const values = Float64Array.from(observations, (_, index) => {
      const row = Math.floor(index / side);
      const column = index % side;
      return (row + column) % 2 === 0 ? 1 : -1;
    });
    expect(moransI(values, weights)).toBeLessThan(-0.4);
    expect(gearysC(values, weights)).toBeGreaterThan(1.3);
  });

  it('is near zero for noise', () => {
    const rng = new Rng(3);
    const values = Float64Array.from(observations, () => rng.normal());
    expect(Math.abs(moransI(values, weights))).toBeLessThan(0.15);
  });

  it('returns NaN for a constant field rather than a number', () => {
    expect(Number.isNaN(moransI(new Float64Array(observations.length).fill(1), weights))).toBe(true);
  });
});

describe('neighbourhood enrichment', () => {
  const side = 16;
  const observations = grid(side);
  const graph = buildSpatialGraph(observations, { method: 'knn', k: 4 }, 'um');

  it('finds a positive z for a class that clusters with itself', () => {
    // Left half is A, right half is B: each neighbours itself far more than a
    // label permutation would predict.
    const labels = observations.map((observation) => (observation.x < (side * 10) / 2 ? 'A' : 'B'));
    const result = neighbourhoodEnrichment(graph, labels, new Rng(11), 200);
    const a = result.labels.indexOf('A');
    const b = result.labels.indexOf('B');
    expect(result.zScore[a * 2 + a] as number).toBeGreaterThan(4);
    expect(result.zScore[a * 2 + b] as number).toBeLessThan(-4);
    // A permutation test never reports zero.
    expect(result.pValue[a * 2 + a] as number).toBeGreaterThan(0);
  });

  it('finds no enrichment for randomly assigned labels', () => {
    const rng = new Rng(5);
    const labels = observations.map(() => (rng.next() < 0.5 ? 'A' : 'B'));
    const result = neighbourhoodEnrichment(graph, labels, new Rng(11), 200);
    const a = result.labels.indexOf('A');
    expect(Math.abs(result.zScore[a * 2 + a] as number)).toBeLessThan(3);
  });

  it('leaves unlabelled observations out of the pool rather than pooling them', () => {
    const labels = observations.map((observation, index) => (index % 3 === 0 ? undefined : observation.x < 80 ? 'A' : 'B'));
    const result = neighbourhoodEnrichment(graph, labels, new Rng(11), 100);
    expect(result.labels).toEqual(['A', 'B']);
  });
});

describe('spatial domains', () => {
  it('recovers contiguous regions from a smoothed embedding', () => {
    const side = 16;
    const observations = grid(side);
    const graph = buildSpatialGraph(observations, { method: 'knn', k: 6 }, 'um');
    // A two-dimensional embedding that is a step function in x.
    const embedding = new Float64Array(observations.length * 2);
    observations.forEach((observation, index) => {
      embedding[index * 2] = observation.x < (side * 10) / 2 ? -1 : 1;
      embedding[index * 2 + 1] = 0;
    });
    const result = spatialDomains(embedding, 2, graph, 2, new Rng(9));
    expect(result.domainCount).toBe(2);
    // Contiguity is the point: if neighbours rarely share a domain the result is
    // expression clustering, not regions.
    expect(result.spatialCoherence).toBeGreaterThan(0.9);
  });
});
