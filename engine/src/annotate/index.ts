/**
 * Cell/spot annotation and region identification — §6.5.
 *
 * §6.5 sets the order of preference and this module follows it: a validated
 * annotation that arrived with the data is used as it stands; a reference
 * dataset is mapped if one is supplied; only failing both is anything inferred,
 * and what is inferred is labelled exploratory rather than presented as a cell
 * type.
 *
 * That order matters more than it looks. Unsupervised clusters named after
 * their top marker read exactly like annotations, and once a cluster is called
 * "Macrophage" in a figure nobody downstream remembers that a clustering
 * algorithm chose the name.
 */

import { euclidean } from '../core/matrix';
import { mean, standardDeviation } from '../core/stats';
import type { MethodRecord } from '../core/provenance';
import type { DatasetView, FeatureRecord } from '../data/types';
import { featureIndexMap } from '../data/types';

export type AnnotationSource = 'provided' | 'reference-mapped' | 'marker-scored' | 'unassigned';

export interface AnnotationSet {
  /** One label per observation, in dataset order. */
  labels: (string | undefined)[];
  /** Per-observation confidence in [0, 1], or NaN where none is defined. */
  confidence: Float64Array;
  source: AnnotationSource;
  /** Classes in the set, sorted. */
  classes: string[];
  /** Observations the method declined to assign. */
  unassigned: number;
  method: MethodRecord;
  /** Set when the labels are exploratory rather than validated annotations. */
  exploratory: boolean;
}

/** A curated marker panel: which features define which cell type. */
export interface MarkerPanel {
  id: string;
  version: string;
  source: string;
  /** Cell type to positive markers. */
  positive: Record<string, string[]>;
  /** Cell type to markers that must be low, where the panel defines any. */
  negative?: Record<string, string[]>;
}

/** §6.5's first preference: use what the data already carries. */
export function useProvidedAnnotations(view: DatasetView, field: 'cellType' | 'cellState' | 'region'): AnnotationSet | null {
  const labels = view.observations.map((observation) => observation[field]);
  const present = labels.filter((label): label is string => Boolean(label));
  if (present.length === 0) return null;

  const classes = [...new Set(present)].sort();
  return {
    labels,
    confidence: new Float64Array(labels.length).fill(Number.NaN),
    source: 'provided',
    classes,
    unassigned: labels.length - present.length,
    exploratory: false,
    method: {
      id: `annotate.provided.${field}`,
      name: 'Provided annotation',
      version: '1.0.0',
      software: 'spatial-omics-engine',
      parameters: { field },
      summary:
        `${present.length} of ${labels.length} observations carry a ${field} label from the source dataset. ` +
        'No inference was performed; the confidence column is empty because the source did not supply one, and inventing a number for it would be a fabrication.',
    },
  };
}

/**
 * Marker-panel scoring.
 *
 * The score is the mean z-score of the panel's positive markers minus the mean
 * z-score of its negatives, and the assignment is the highest-scoring class —
 * but only if it clears `minimumMargin` over the runner-up. Without that
 * margin, an ambiguous cell is assigned to whichever type wins by 0.01, and the
 * map looks confidently annotated where the data is not.
 */
export function scoreMarkerPanel(
  view: DatasetView,
  panel: MarkerPanel,
  minimumMargin = 0.25,
): AnnotationSet {
  const n = view.observations.length;
  const index = featureIndexMap(view.features);
  const classes = Object.keys(panel.positive).sort();

  const zScores = zScoreMatrix(view);
  const missing: string[] = [];

  const scores: Float64Array[] = classes.map((className) => {
    const positives = resolve(panel.positive[className] ?? [], index, missing);
    const negatives = resolve(panel.negative?.[className] ?? [], index, missing);
    const out = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      let positive = 0;
      for (const column of positives) positive += zScores[i * view.features.length + column] as number;
      let negative = 0;
      for (const column of negatives) negative += zScores[i * view.features.length + column] as number;
      const positiveMean = positives.length > 0 ? positive / positives.length : 0;
      const negativeMean = negatives.length > 0 ? negative / negatives.length : 0;
      out[i] = positiveMean - negativeMean;
    }
    return out;
  });

  const labels: (string | undefined)[] = new Array(n).fill(undefined);
  const confidence = new Float64Array(n);
  let unassigned = 0;

  for (let i = 0; i < n; i += 1) {
    let bestIndex = -1;
    let best = -Infinity;
    let runnerUp = -Infinity;
    for (let c = 0; c < classes.length; c += 1) {
      const value = (scores[c] as Float64Array)[i] as number;
      if (value > best) {
        runnerUp = best;
        best = value;
        bestIndex = c;
      } else if (value > runnerUp) {
        runnerUp = value;
      }
    }
    const margin = Number.isFinite(runnerUp) ? best - runnerUp : best;
    if (bestIndex >= 0 && margin >= minimumMargin && best > 0) {
      labels[i] = classes[bestIndex];
      // Squashed margin: a cell winning by 2 z-units is not twice as confident
      // as one winning by 1, and a linear confidence would say it was.
      confidence[i] = 1 - Math.exp(-margin);
    } else {
      confidence[i] = 0;
      unassigned += 1;
    }
  }

  return {
    labels,
    confidence,
    source: 'marker-scored',
    classes,
    unassigned,
    exploratory: true,
    method: {
      id: 'annotate.marker-panel',
      name: 'Marker panel scoring',
      version: '1.0.0',
      software: 'spatial-omics-engine',
      parameters: {
        panel: panel.id,
        panelVersion: panel.version,
        minimumMargin,
        missingMarkers: missing,
      },
      summary:
        `Scored ${classes.length} classes from the ${panel.id} panel (${panel.source}) as the mean z-score of their positive markers ` +
        `minus their negatives. ${unassigned} of ${n} observations did not clear the ${minimumMargin} margin over the runner-up and are left unassigned. ` +
        (missing.length > 0 ? `${missing.length} panel marker(s) are absent from this dataset: ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ', …' : ''}. ` : '') +
        'These are exploratory labels, not validated annotations.',
      references: [panel.source],
    },
  };
}

/**
 * Reference mapping by weighted k-nearest-neighbour label transfer.
 *
 * §6.5 names scANVI. This is not scANVI: it is a nearest-neighbour transfer in
 * a shared embedding, which is the transparent version of the same operation,
 * and it is labelled as such in the method record rather than borrowing the
 * name. Its useful property is the one scANVI also has — an "unknown" class,
 * reached when the neighbours disagree, so a cell type absent from the
 * reference is reported as absent rather than forced into the nearest label.
 */
export function mapFromReference(
  queryEmbedding: Float64Array,
  queryCount: number,
  dimensions: number,
  referenceEmbedding: Float64Array,
  referenceLabels: string[],
  k = 15,
  minimumAgreement = 0.5,
): AnnotationSet {
  const referenceCount = referenceLabels.length;
  const labels: (string | undefined)[] = new Array(queryCount).fill(undefined);
  const confidence = new Float64Array(queryCount);
  let unassigned = 0;

  for (let i = 0; i < queryCount; i += 1) {
    const query = queryEmbedding.subarray(i * dimensions, (i + 1) * dimensions);
    const distances: { distance: number; label: string }[] = [];
    for (let r = 0; r < referenceCount; r += 1) {
      const reference = referenceEmbedding.subarray(r * dimensions, (r + 1) * dimensions);
      distances.push({ distance: euclidean(query, reference), label: referenceLabels[r] as string });
    }
    distances.sort((a, b) => a.distance - b.distance);
    const neighbours = distances.slice(0, Math.min(k, distances.length));

    const votes = new Map<string, number>();
    let totalWeight = 0;
    for (const neighbour of neighbours) {
      // Inverse-distance weighting: the tenth-nearest neighbour should not
      // count as much as the nearest, which a plain majority vote would let it.
      const weight = 1 / (1 + neighbour.distance);
      votes.set(neighbour.label, (votes.get(neighbour.label) ?? 0) + weight);
      totalWeight += weight;
    }

    let bestLabel: string | undefined;
    let bestWeight = 0;
    for (const [label, weight] of votes) {
      if (weight > bestWeight) {
        bestWeight = weight;
        bestLabel = label;
      }
    }
    const agreement = totalWeight > 0 ? bestWeight / totalWeight : 0;
    if (bestLabel && agreement >= minimumAgreement) {
      labels[i] = bestLabel;
      confidence[i] = agreement;
    } else {
      confidence[i] = agreement;
      unassigned += 1;
    }
  }

  const classes = [...new Set(labels.filter((l): l is string => Boolean(l)))].sort();
  return {
    labels,
    confidence,
    source: 'reference-mapped',
    classes,
    unassigned,
    exploratory: false,
    method: {
      id: 'annotate.reference-knn',
      name: 'Reference label transfer',
      version: '1.0.0',
      software: 'spatial-omics-engine',
      parameters: { k, minimumAgreement, weighting: 'inverse distance', dimensions },
      summary:
        `Each observation took the inverse-distance-weighted majority label of its ${k} nearest reference cells in the shared embedding. ` +
        `${unassigned} of ${queryCount} fell below ${(minimumAgreement * 100).toFixed(0)}% agreement and are left unassigned rather than forced to the nearest label. ` +
        'This is a nearest-neighbour transfer, not a probabilistic integration; a cell type absent from the reference cannot be recovered by it.',
    },
  };
}

/** Column-wise z-scores of the view's matrix, for marker scoring. */
function zScoreMatrix(view: DatasetView): Float64Array {
  const n = view.observations.length;
  const p = view.features.length;
  const out = new Float64Array(n * p);
  for (let j = 0; j < p; j += 1) {
    const column = new Float64Array(n);
    for (let i = 0; i < n; i += 1) column[i] = view.matrix[i * p + j] as number;
    const mu = mean(column);
    const sd = standardDeviation(column, mu);
    for (let i = 0; i < n; i += 1) {
      out[i * p + j] = sd > 0 ? ((column[i] as number) - mu) / sd : 0;
    }
  }
  return out;
}

function resolve(symbols: string[], index: Map<string, number>, missing: string[]): number[] {
  const out: number[] = [];
  for (const symbol of symbols) {
    const column = index.get(symbol.toUpperCase());
    if (column === undefined) {
      if (!missing.includes(symbol)) missing.push(symbol);
    } else {
      out.push(column);
    }
  }
  return out;
}

/** Composition of each class, for the counts panel §6.5 asks for. */
export function annotationSummary(annotation: AnnotationSet): {
  className: string; count: number; fraction: number; medianConfidence: number;
}[] {
  const total = annotation.labels.length;
  const byClass = new Map<string, number[]>();
  annotation.labels.forEach((label, index) => {
    if (!label) return;
    const list = byClass.get(label) ?? [];
    list.push(annotation.confidence[index] as number);
    byClass.set(label, list);
  });

  return [...byClass.entries()]
    .map(([className, confidences]) => {
      const finite = confidences.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
      return {
        className,
        count: confidences.length,
        fraction: total > 0 ? confidences.length / total : 0,
        medianConfidence: finite.length > 0 ? (finite[Math.floor(finite.length / 2)] as number) : Number.NaN,
      };
    })
    .sort((a, b) => b.count - a.count);
}

/** Named for the report: which features a class is actually defined by here. */
export function panelCoverage(panel: MarkerPanel, features: FeatureRecord[]): {
  className: string; present: string[]; absent: string[];
}[] {
  const index = featureIndexMap(features);
  return Object.entries(panel.positive).map(([className, markers]) => {
    const present: string[] = [];
    const absent: string[] = [];
    for (const marker of markers) {
      if (index.has(marker.toUpperCase())) present.push(marker);
      else absent.push(marker);
    }
    return { className, present, absent };
  });
}
