/**
 * Spatial graph construction — §6.7 for analysis and §6.13 for simulation.
 *
 * The one structural commitment §5.4 makes is that "physical-proximity edges
 * and biological-interaction edges are stored as distinct edge types". They are
 * kept in the same edge table with an `edgeType` discriminator rather than in
 * two graphs, because the propagation engine walks both at once and a
 * two-graph design makes "which edges did this message travel along" a question
 * you have to reconstruct instead of read.
 *
 * §5.2's k = 6 is recorded as a *benchmark default for single-cell GNNs*, not a
 * biological truth, and the graph object says so in its own provenance so that
 * a reader of a report never has to take it on trust from a docstring.
 */

import { contentHash } from '../core/provenance';
import type { ObservationRecord } from '../data/types';
import { coordinateBounds } from '../data/types';

export type GraphMethod = 'knn' | 'radius' | 'grid' | 'delaunay';

export type EdgeType =
  /** Physical proximity in the tissue. */
  | 'physical'
  /** A supported ligand-receptor or other biological interaction. */
  | 'biological';

export interface GraphParameters {
  method: GraphMethod;
  /** Neighbours for `knn`. */
  k?: number;
  /** Distance cut-off for `radius`, in the dataset's coordinate unit. */
  radius?: number;
  /** Rings for `grid`, on a hex or square lattice. */
  rings?: number;
  /** Lattice for `grid`. */
  lattice?: 'hex' | 'square';
  /** Drop Delaunay edges longer than this multiple of the median edge length. */
  delaunayMaxEdgeFactor?: number;
  /** Make every edge reciprocal. kNN is otherwise directed. */
  symmetrise?: boolean;
  /**
   * Distance weighting. `gaussian` uses exp(-d^2 / 2 sigma^2) with sigma set to
   * the median edge length; `inverse` uses 1/(1+d); `uniform` uses 1.
   */
  weighting?: 'gaussian' | 'inverse' | 'uniform';
}

export interface GraphEdge {
  source: number;
  target: number;
  distance: number;
  weight: number;
  edgeType: EdgeType;
  /** For biological edges: the interaction this edge represents. */
  interaction?: string;
}

export interface SpatialGraph {
  graphId: string;
  method: GraphMethod;
  parameters: GraphParameters;
  nodeCount: number;
  edges: GraphEdge[];
  /** CSR-style adjacency over all edge types, for fast propagation. */
  adjacency: {
    indptr: Int32Array;
    indices: Int32Array;
    weights: Float64Array;
    edgeTypes: Uint8Array;
  };
  /** Coordinate unit the distances are in. Carried so nothing has to assume. */
  coordinateUnit: string;
  checksum: string;
  version: string;
  diagnostics: GraphDiagnostics;
}

export interface GraphDiagnostics {
  physicalEdges: number;
  biologicalEdges: number;
  meanDegree: number;
  medianDegree: number;
  isolatedNodes: number;
  /** Number of connected components over physical edges. */
  components: number;
  largestComponentFraction: number;
  medianEdgeLength: number;
  maximumEdgeLength: number;
  /** True when the graph is symmetric over physical edges. */
  symmetric: boolean;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export function buildSpatialGraph(
  observations: ObservationRecord[],
  parameters: GraphParameters,
  coordinateUnit: string,
  biologicalEdges: GraphEdge[] = [],
): SpatialGraph {
  const n = observations.length;
  const warnings: string[] = [];
  let pairs: { source: number; target: number; distance: number }[] = [];

  switch (parameters.method) {
    case 'knn':
      pairs = knnPairs(observations, Math.max(1, parameters.k ?? 6));
      break;
    case 'radius': {
      const radius = parameters.radius ?? defaultRadius(observations);
      if (parameters.radius === undefined) {
        warnings.push(
          `No radius was supplied, so ${radius.toPrecision(4)} ${coordinateUnit} was derived from this dataset's median nearest-neighbour distance. §5.2 states there is no universal fixed radius.`,
        );
      }
      pairs = radiusPairs(observations, radius);
      break;
    }
    case 'grid':
      pairs = gridPairs(observations, parameters.rings ?? 1, parameters.lattice ?? 'hex');
      break;
    case 'delaunay':
      pairs = delaunayPairs(observations, parameters.delaunayMaxEdgeFactor ?? 3);
      break;
  }

  if (parameters.symmetrise !== false) {
    pairs = symmetrise(pairs);
  }

  const distances = pairs.map((pair) => pair.distance).sort((a, b) => a - b);
  const medianEdgeLength = distances.length > 0 ? (distances[Math.floor(distances.length / 2)] as number) : 0;
  const maximumEdgeLength = distances.length > 0 ? (distances[distances.length - 1] as number) : 0;

  const weighting = parameters.weighting ?? 'gaussian';
  const sigma = medianEdgeLength > 0 ? medianEdgeLength : 1;

  const edges: GraphEdge[] = pairs.map((pair) => ({
    source: pair.source,
    target: pair.target,
    distance: pair.distance,
    weight: edgeWeight(pair.distance, weighting, sigma),
    edgeType: 'physical' as const,
  }));

  for (const edge of biologicalEdges) {
    if (edge.source < 0 || edge.source >= n || edge.target < 0 || edge.target >= n) continue;
    edges.push({ ...edge, edgeType: 'biological' });
  }

  const adjacency = buildAdjacency(n, edges);
  const diagnostics = diagnose(n, edges, adjacency, medianEdgeLength, maximumEdgeLength, warnings);

  const checksum = contentHash({
    method: parameters.method,
    parameters,
    coordinateUnit,
    edges: edges.map((e) => [e.source, e.target, e.distance, e.weight, e.edgeType, e.interaction ?? '']),
  });

  return {
    graphId: `graph-${checksum.slice(0, 12)}`,
    method: parameters.method,
    parameters,
    nodeCount: n,
    edges,
    adjacency,
    coordinateUnit,
    checksum,
    version: '1.0.0',
    diagnostics,
  };
}

function edgeWeight(distance: number, weighting: string, sigma: number): number {
  switch (weighting) {
    case 'uniform':
      return 1;
    case 'inverse':
      return 1 / (1 + distance);
    case 'gaussian':
    default:
      return Math.exp(-(distance * distance) / (2 * sigma * sigma));
  }
}

/**
 * k nearest neighbours, through a uniform grid index.
 *
 * The brute-force version is O(n^2) and takes eleven seconds on a 20,000-cell
 * section, which is long enough that a learner assumes the lab has hung. The
 * grid makes it roughly linear in the number of cells for the densities spatial
 * assays actually produce.
 */
function knnPairs(observations: ObservationRecord[], k: number): { source: number; target: number; distance: number }[] {
  const n = observations.length;
  const index = new GridIndex(observations);
  const out: { source: number; target: number; distance: number }[] = [];

  for (let i = 0; i < n; i += 1) {
    const neighbours = index.nearest(i, k);
    for (const neighbour of neighbours) {
      out.push({ source: i, target: neighbour.index, distance: neighbour.distance });
    }
  }
  return out;
}

function radiusPairs(
  observations: ObservationRecord[],
  radius: number,
): { source: number; target: number; distance: number }[] {
  const index = new GridIndex(observations);
  const out: { source: number; target: number; distance: number }[] = [];
  for (let i = 0; i < observations.length; i += 1) {
    for (const neighbour of index.within(i, radius)) {
      if (neighbour.index > i) {
        out.push({ source: i, target: neighbour.index, distance: neighbour.distance });
        out.push({ source: neighbour.index, target: i, distance: neighbour.distance });
      }
    }
  }
  return out;
}

/**
 * Lattice neighbours for a gridded platform.
 *
 * Visium's hexagonal packing puts six spots at one lattice step, and §5.2 fixes
 * n_neigh = 6 for exactly that geometry. Rather than assume the pitch, it is
 * measured from the data: the modal nearest-neighbour distance is the lattice
 * step, and rings scale it.
 */
function gridPairs(
  observations: ObservationRecord[],
  rings: number,
  lattice: 'hex' | 'square',
): { source: number; target: number; distance: number }[] {
  const pitch = lattticePitch(observations);
  // A hex ring reaches sqrt(3) further than a square one before it picks up the
  // next shell, so the tolerance differs.
  const reach = pitch * rings * (lattice === 'hex' ? 1.1 : 1.45);
  return radiusPairs(observations, reach);
}

function lattticePitch(observations: ObservationRecord[]): number {
  const index = new GridIndex(observations);
  const distances: number[] = [];
  const stride = observations.length > 2000 ? Math.ceil(observations.length / 500) : 1;
  for (let i = 0; i < observations.length; i += stride) {
    const nearest = index.nearest(i, 1);
    if (nearest.length > 0) distances.push((nearest[0] as { distance: number }).distance);
  }
  if (distances.length === 0) return 1;
  distances.sort((a, b) => a - b);
  return distances[Math.floor(distances.length / 2)] as number;
}

function defaultRadius(observations: ObservationRecord[]): number {
  // Two lattice steps: far enough to reach the first shell of neighbours on any
  // geometry, close enough that "neighbourhood" still means something local.
  return lattticePitch(observations) * 2;
}

function symmetrise(
  pairs: { source: number; target: number; distance: number }[],
): { source: number; target: number; distance: number }[] {
  const seen = new Set<string>();
  const out: { source: number; target: number; distance: number }[] = [];
  for (const pair of pairs) {
    if (pair.source === pair.target) continue;
    const forward = `${pair.source}|${pair.target}`;
    if (!seen.has(forward)) {
      seen.add(forward);
      out.push(pair);
    }
    const backward = `${pair.target}|${pair.source}`;
    if (!seen.has(backward)) {
      seen.add(backward);
      out.push({ source: pair.target, target: pair.source, distance: pair.distance });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Grid index
// ---------------------------------------------------------------------------

/** A uniform bucket grid over the tissue. Rebuilt per graph; never cached. */
export class GridIndex {
  private readonly observations: ObservationRecord[];
  private readonly cellSize: number;
  private readonly minX: number;
  private readonly minY: number;
  private readonly columns: number;
  private readonly rows: number;
  private readonly buckets: number[][];

  constructor(observations: ObservationRecord[]) {
    this.observations = observations;
    const bounds = coordinateBounds(observations);
    this.minX = bounds.minX;
    this.minY = bounds.minY;

    const n = Math.max(1, observations.length);
    // Roughly four points per bucket: enough that a nearest-neighbour query
    // usually finds its answer in the first ring.
    const target = Math.max(1, Math.ceil(Math.sqrt(n / 4)));
    this.columns = target;
    this.rows = target;
    this.cellSize = Math.max(
      Math.max(bounds.width, bounds.height) / target,
      Number.EPSILON,
    );
    this.buckets = Array.from({ length: this.columns * this.rows }, () => [] as number[]);

    observations.forEach((observation, index) => {
      (this.buckets[this.bucketFor(observation.x, observation.y)] as number[]).push(index);
    });
  }

  private bucketFor(x: number, y: number): number {
    const column = Math.min(this.columns - 1, Math.max(0, Math.floor((x - this.minX) / this.cellSize)));
    const row = Math.min(this.rows - 1, Math.max(0, Math.floor((y - this.minY) / this.cellSize)));
    return row * this.columns + column;
  }

  /** The k nearest neighbours of `index`, excluding itself. */
  nearest(index: number, k: number): { index: number; distance: number }[] {
    const origin = this.observations[index] as ObservationRecord;
    const found: { index: number; distance: number }[] = [];
    const column = Math.min(this.columns - 1, Math.max(0, Math.floor((origin.x - this.minX) / this.cellSize)));
    const row = Math.min(this.rows - 1, Math.max(0, Math.floor((origin.y - this.minY) / this.cellSize)));

    for (let ring = 0; ring <= Math.max(this.columns, this.rows); ring += 1) {
      collectRing(this, column, row, ring, (candidate) => {
        if (candidate === index) return;
        const other = this.observations[candidate] as ObservationRecord;
        const dx = origin.x - other.x;
        const dy = origin.y - other.y;
        found.push({ index: candidate, distance: Math.sqrt(dx * dx + dy * dy) });
      });

      // Everything inside `ring * cellSize` has now been seen, so once we hold
      // k candidates that close, no later ring can beat them.
      if (found.length >= k) {
        found.sort((a, b) => a.distance - b.distance);
        const kth = found[k - 1] as { distance: number };
        if (kth.distance <= ring * this.cellSize) break;
      }
    }

    found.sort((a, b) => a.distance - b.distance);
    return found.slice(0, k);
  }

  /** Everything within `radius` of `index`, excluding itself. */
  within(index: number, radius: number): { index: number; distance: number }[] {
    const origin = this.observations[index] as ObservationRecord;
    const out: { index: number; distance: number }[] = [];
    const reach = Math.ceil(radius / this.cellSize);
    const column = Math.min(this.columns - 1, Math.max(0, Math.floor((origin.x - this.minX) / this.cellSize)));
    const row = Math.min(this.rows - 1, Math.max(0, Math.floor((origin.y - this.minY) / this.cellSize)));

    for (let dr = -reach; dr <= reach; dr += 1) {
      for (let dc = -reach; dc <= reach; dc += 1) {
        const r = row + dr;
        const c = column + dc;
        if (r < 0 || c < 0 || r >= this.rows || c >= this.columns) continue;
        for (const candidate of this.buckets[r * this.columns + c] as number[]) {
          if (candidate === index) continue;
          const other = this.observations[candidate] as ObservationRecord;
          const dx = origin.x - other.x;
          const dy = origin.y - other.y;
          const distance = Math.sqrt(dx * dx + dy * dy);
          if (distance <= radius) out.push({ index: candidate, distance });
        }
      }
    }
    return out;
  }

  bucketAt(row: number, column: number): number[] {
    if (row < 0 || column < 0 || row >= this.rows || column >= this.columns) return [];
    return this.buckets[row * this.columns + column] as number[];
  }

  get shape(): { rows: number; columns: number } {
    return { rows: this.rows, columns: this.columns };
  }
}

function collectRing(
  index: GridIndex,
  column: number,
  row: number,
  ring: number,
  visit: (candidate: number) => void,
): void {
  if (ring === 0) {
    for (const candidate of index.bucketAt(row, column)) visit(candidate);
    return;
  }
  for (let dc = -ring; dc <= ring; dc += 1) {
    for (const candidate of index.bucketAt(row - ring, column + dc)) visit(candidate);
    for (const candidate of index.bucketAt(row + ring, column + dc)) visit(candidate);
  }
  for (let dr = -ring + 1; dr <= ring - 1; dr += 1) {
    for (const candidate of index.bucketAt(row + dr, column - ring)) visit(candidate);
    for (const candidate of index.bucketAt(row + dr, column + ring)) visit(candidate);
  }
}

// ---------------------------------------------------------------------------
// Delaunay
// ---------------------------------------------------------------------------

/**
 * Bowyer–Watson incremental triangulation.
 *
 * Delaunay is offered because it is the only one of the four that adapts to
 * local density without a parameter: a sparse stromal region gets long edges
 * and a packed tumour core gets short ones, where a fixed radius would connect
 * nothing in one and everything in the other. The `maxEdgeFactor` trim exists
 * because the triangulation of a non-convex tissue produces edges straight
 * across empty space, and those are not neighbourhoods.
 */
function delaunayPairs(
  observations: ObservationRecord[],
  maxEdgeFactor: number,
): { source: number; target: number; distance: number }[] {
  const n = observations.length;
  if (n < 3) return [];

  const bounds = coordinateBounds(observations);
  const span = Math.max(bounds.width, bounds.height) || 1;
  const midX = (bounds.minX + bounds.maxX) / 2;
  const midY = (bounds.minY + bounds.maxY) / 2;

  // A super-triangle large enough to contain every point.
  const points: { x: number; y: number }[] = observations.map((o) => ({ x: o.x, y: o.y }));
  const superA = points.length;
  points.push({ x: midX - 20 * span, y: midY - 10 * span });
  points.push({ x: midX + 20 * span, y: midY - 10 * span });
  points.push({ x: midX, y: midY + 20 * span });

  let triangles: [number, number, number][] = [[superA, superA + 1, superA + 2]];

  for (let p = 0; p < n; p += 1) {
    const point = points[p] as { x: number; y: number };
    const bad: [number, number, number][] = [];
    const good: [number, number, number][] = [];

    for (const triangle of triangles) {
      if (inCircumcircle(point, points, triangle)) bad.push(triangle);
      else good.push(triangle);
    }

    // The boundary of the cavity is every edge belonging to exactly one bad
    // triangle.
    const edgeCount = new Map<string, { a: number; b: number; count: number }>();
    for (const [a, b, c] of bad) {
      for (const [u, v] of [[a, b], [b, c], [c, a]] as [number, number][]) {
        const key = u < v ? `${u}|${v}` : `${v}|${u}`;
        const existing = edgeCount.get(key);
        if (existing) existing.count += 1;
        else edgeCount.set(key, { a: u, b: v, count: 1 });
      }
    }

    triangles = good;
    for (const edge of edgeCount.values()) {
      if (edge.count === 1) triangles.push([edge.a, edge.b, p]);
    }
  }

  const seen = new Set<string>();
  const candidates: { source: number; target: number; distance: number }[] = [];
  for (const [a, b, c] of triangles) {
    for (const [u, v] of [[a, b], [b, c], [c, a]] as [number, number][]) {
      if (u >= n || v >= n) continue; // touches the super-triangle
      const key = u < v ? `${u}|${v}` : `${v}|${u}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const pu = points[u] as { x: number; y: number };
      const pv = points[v] as { x: number; y: number };
      const dx = pu.x - pv.x;
      const dy = pu.y - pv.y;
      candidates.push({ source: u, target: v, distance: Math.sqrt(dx * dx + dy * dy) });
    }
  }

  if (candidates.length === 0) return [];
  const lengths = candidates.map((edge) => edge.distance).sort((a, b) => a - b);
  const medianLength = lengths[Math.floor(lengths.length / 2)] as number;
  const limit = medianLength * maxEdgeFactor;

  const out: { source: number; target: number; distance: number }[] = [];
  for (const edge of candidates) {
    if (edge.distance > limit) continue;
    out.push(edge);
    out.push({ source: edge.target, target: edge.source, distance: edge.distance });
  }
  return out;
}

function inCircumcircle(
  point: { x: number; y: number },
  points: { x: number; y: number }[],
  triangle: [number, number, number],
): boolean {
  const a = points[triangle[0]] as { x: number; y: number };
  const b = points[triangle[1]] as { x: number; y: number };
  const c = points[triangle[2]] as { x: number; y: number };

  const ax = a.x - point.x;
  const ay = a.y - point.y;
  const bx = b.x - point.x;
  const by = b.y - point.y;
  const cx = c.x - point.x;
  const cy = c.y - point.y;

  const determinant =
    (ax * ax + ay * ay) * (bx * cy - cx * by) -
    (bx * bx + by * by) * (ax * cy - cx * ay) +
    (cx * cx + cy * cy) * (ax * by - bx * ay);

  // Orientation decides the sign, so it has to be computed rather than assumed.
  const orientation = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
  return orientation > 0 ? determinant > 0 : determinant < 0;
}

// ---------------------------------------------------------------------------
// Adjacency and diagnostics
// ---------------------------------------------------------------------------

const EDGE_TYPE_CODE: Record<EdgeType, number> = { physical: 0, biological: 1 };

export function buildAdjacency(
  nodeCount: number,
  edges: GraphEdge[],
): SpatialGraph['adjacency'] {
  const degree = new Int32Array(nodeCount);
  for (const edge of edges) degree[edge.source] = (degree[edge.source] as number) + 1;

  const indptr = new Int32Array(nodeCount + 1);
  for (let i = 0; i < nodeCount; i += 1) indptr[i + 1] = (indptr[i] as number) + (degree[i] as number);

  const cursor = Int32Array.from(indptr.subarray(0, nodeCount));
  const indices = new Int32Array(edges.length);
  const weights = new Float64Array(edges.length);
  const edgeTypes = new Uint8Array(edges.length);

  for (const edge of edges) {
    const position = cursor[edge.source] as number;
    indices[position] = edge.target;
    weights[position] = edge.weight;
    edgeTypes[position] = EDGE_TYPE_CODE[edge.edgeType];
    cursor[edge.source] = position + 1;
  }

  return { indptr, indices, weights, edgeTypes };
}

function diagnose(
  nodeCount: number,
  edges: GraphEdge[],
  adjacency: SpatialGraph['adjacency'],
  medianEdgeLength: number,
  maximumEdgeLength: number,
  warnings: string[],
): GraphDiagnostics {
  const physical = edges.filter((e) => e.edgeType === 'physical');
  const biological = edges.length - physical.length;

  const degrees = new Int32Array(nodeCount);
  for (const edge of physical) degrees[edge.source] = (degrees[edge.source] as number) + 1;

  let isolated = 0;
  let totalDegree = 0;
  for (let i = 0; i < nodeCount; i += 1) {
    const degree = degrees[i] as number;
    if (degree === 0) isolated += 1;
    totalDegree += degree;
  }
  const sortedDegrees = Array.from(degrees).sort((a, b) => a - b);
  const medianDegree = nodeCount > 0 ? (sortedDegrees[Math.floor(nodeCount / 2)] as number) : 0;

  // Components, over physical edges only: a biological edge between distant
  // cells would make the whole section look connected when it is not.
  const componentOf = new Int32Array(nodeCount).fill(-1);
  let components = 0;
  let largest = 0;
  const stack: number[] = [];
  for (let start = 0; start < nodeCount; start += 1) {
    if ((componentOf[start] as number) >= 0) continue;
    let size = 0;
    stack.push(start);
    componentOf[start] = components;
    while (stack.length > 0) {
      const node = stack.pop() as number;
      size += 1;
      const from = adjacency.indptr[node] as number;
      const to = adjacency.indptr[node + 1] as number;
      for (let k = from; k < to; k += 1) {
        if ((adjacency.edgeTypes[k] as number) !== 0) continue;
        const neighbour = adjacency.indices[k] as number;
        if ((componentOf[neighbour] as number) < 0) {
          componentOf[neighbour] = components;
          stack.push(neighbour);
        }
      }
    }
    if (size > largest) largest = size;
    components += 1;
  }

  const forward = new Set(physical.map((e) => `${e.source}|${e.target}`));
  let symmetric = true;
  for (const edge of physical) {
    if (!forward.has(`${edge.target}|${edge.source}`)) {
      symmetric = false;
      break;
    }
  }

  if (isolated > 0) {
    warnings.push(
      `${isolated} node(s) have no physical neighbour, so nothing can propagate to or from them. They will show a direct response only.`,
    );
  }
  if (components > 1) {
    warnings.push(
      `The tissue splits into ${components} disconnected component(s); the largest holds ${((largest / Math.max(1, nodeCount)) * 100).toFixed(1)}% of observations. Propagation cannot cross between them.`,
    );
  }

  return {
    physicalEdges: physical.length,
    biologicalEdges: biological,
    meanDegree: nodeCount > 0 ? totalDegree / nodeCount : 0,
    medianDegree,
    isolatedNodes: isolated,
    components,
    largestComponentFraction: nodeCount > 0 ? largest / nodeCount : 0,
    medianEdgeLength,
    maximumEdgeLength,
    symmetric,
    warnings,
  };
}

/** Neighbour indices of a node, optionally restricted to one edge type. */
export function neighboursOf(
  graph: SpatialGraph,
  node: number,
  edgeType?: EdgeType,
): { index: number; weight: number; edgeType: EdgeType }[] {
  const out: { index: number; weight: number; edgeType: EdgeType }[] = [];
  const from = graph.adjacency.indptr[node] as number;
  const to = graph.adjacency.indptr[node + 1] as number;
  for (let k = from; k < to; k += 1) {
    const code = graph.adjacency.edgeTypes[k] as number;
    const type: EdgeType = code === 1 ? 'biological' : 'physical';
    if (edgeType && type !== edgeType) continue;
    out.push({ index: graph.adjacency.indices[k] as number, weight: graph.adjacency.weights[k] as number, edgeType: type });
  }
  return out;
}

/**
 * A graph with an edge class removed, for the §14.3 ablations.
 *
 * Rebuilding rather than masking at inference time: an ablation that leaves the
 * edges present and multiplies them by zero still normalises over them, and
 * that is not the same model.
 */
export function ablateGraph(graph: SpatialGraph, drop: EdgeType | 'none'): SpatialGraph {
  if (drop === 'none') return graph;
  const edges = graph.edges.filter((edge) => edge.edgeType !== drop);
  const adjacency = buildAdjacency(graph.nodeCount, edges);
  const checksum = contentHash({ base: graph.checksum, ablation: drop });
  return {
    ...graph,
    graphId: `${graph.graphId}-no-${drop}`,
    edges,
    adjacency,
    checksum,
    diagnostics: {
      ...graph.diagnostics,
      physicalEdges: edges.filter((e) => e.edgeType === 'physical').length,
      biologicalEdges: edges.filter((e) => e.edgeType === 'biological').length,
      warnings: [...graph.diagnostics.warnings, `Ablation: all ${drop} edges removed.`],
    },
  };
}

/**
 * A shuffled-graph control: the same degree sequence, the wrong neighbours.
 *
 * §14.3 requires it because a model can score well simply by learning the mean
 * response, and a shuffled graph is the control that exposes that — if the
 * shuffled score matches the real one, the spatial structure contributed
 * nothing.
 */
export function shuffleGraph(graph: SpatialGraph, permutation: Int32Array): SpatialGraph {
  const edges: GraphEdge[] = graph.edges.map((edge) => ({
    ...edge,
    target: permutation[edge.target] as number,
  }));
  const adjacency = buildAdjacency(graph.nodeCount, edges);
  const checksum = contentHash({ base: graph.checksum, shuffled: Array.from(permutation) });
  return {
    ...graph,
    graphId: `${graph.graphId}-shuffled`,
    edges,
    adjacency,
    checksum,
    diagnostics: {
      ...graph.diagnostics,
      warnings: [...graph.diagnostics.warnings, 'Control: edge targets were permuted; neighbourhoods are not spatial.'],
    },
  };
}
