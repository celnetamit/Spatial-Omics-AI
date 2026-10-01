/**
 * The training and evaluation corpus, and the splits §14.4 requires.
 *
 * Each example is one perturbation applied to one simulated section, solved by
 * the mechanism to a stage-resolved steady state. The split is at the *section*
 * level, never at the cell level, because cells within a section share a ligand
 * field: a random cell-level split puts a cell's own neighbours in the training
 * set and the model can read the answer off them. That is the leakage §14.4
 * names first, and it is the one that produces a validation score nobody can
 * interpret afterwards.
 */

import { RandomState } from '../core/rng';
import type { GraphEdge, SpatialGraph } from '../spatial/graph';
import { buildSpatialGraph, GridIndex } from '../spatial/graph';
import type { ObservationRecord } from '../data/types';
import { generateTissue, type CellType, type TissueSpec } from '../data/tissue';
import { compileNetwork, type CompiledNetwork } from '../propagate/network';
import {
  buildDiffusion, cloneState, computeField, meanField, solveTissue,
  type TissueContext, type TissueState,
} from '../propagate/mechanism';
import {
  applyDirectToState, computeDirectResponse, createDefinition, resolveSelection,
} from '../perturb/index';
import type { MolecularOperator, PerturbationSpec } from '../perturb/types';

export interface CorpusExample {
  id: string;
  sectionId: string;
  perturbationLabel: string;
  /** Stage 0 is the direct-applied state; 1..S are the propagation stages. */
  truth: TissueState[];
  baseline: TissueState;
  directEffect: Float64Array;
  graph: SpatialGraph;
  labels: (string | undefined)[];
  observationCount: number;
  nodeCount: number;
  /** Target node indices, so ablation analyses can find the source. */
  targetNodes: number[];
  /** Fraction of the section selected. */
  selectedFraction: number;
}

export interface Section {
  id: string;
  spec: TissueSpec;
  baseline: TissueState;
  context: TissueContext;
  graph: SpatialGraph;
  cellTypes: CellType[];
  regions: string[];
  observations: ObservationRecord[];
  observationCount: number;
}

export interface PerturbationRecipe {
  label: string;
  target: string;
  operator: MolecularOperator;
  magnitude: number;
  selection:
    | { mode: 'cell-type'; classes: string[] }
    | { mode: 'region'; classes: string[] }
    | { mode: 'whole-tissue' }
    /** Centre and radius as fractions of the section, resolved per section. */
    | { mode: 'focal'; fx: number; fy: number; fr: number; within?: string[] };
}

/**
 * The perturbation menu the corpus is built from.
 *
 * Two things are deliberate here.
 *
 * The mechanisms span rather than repeat: a ligand knockout (propagates far), a
 * receptor knockout (barely propagates), a transcription factor knockout
 * (strong local cascade), an overexpression (opposite sign) and a partial
 * inhibition (sub-maximal). Twenty knockouts of twenty genes in one pathway
 * would teach the model one thing twenty times.
 *
 * And half of them are **focal** — applied to a disc rather than to every cell
 * of a type. That is what makes the §14.3 comparison mean anything. When a
 * whole cell type is perturbed, a cell's response is largely predictable from
 * its own type and state, so a graph-free model does nearly as well and the
 * spatial contribution is invisible: the first corpus was all cell-type-wide
 * and the GNN beat the graph-free baseline by 0.018 of R², which reads as "the
 * neighbourhood barely matters" when in fact the design had removed the
 * question. Under a focal perturbation an untouched cell's own features are
 * identical whether it sits 50 µm or 500 µm from the perturbed zone, so only a
 * model that can see the neighbourhood can tell them apart.
 */
export const CORPUS_RECIPES: PerturbationRecipe[] = [
  { label: 'TGFB1 KO in CAFs', target: 'TGFB1', operator: 'knockout', magnitude: 0, selection: { mode: 'cell-type', classes: ['CAF'] } },
  { label: 'TGFBR1 KO in CAFs', target: 'TGFBR1', operator: 'knockout', magnitude: 0, selection: { mode: 'cell-type', classes: ['CAF'] } },
  { label: 'HIF1A KO in tumour', target: 'HIF1A', operator: 'knockout', magnitude: 0, selection: { mode: 'cell-type', classes: ['Tumour'] } },
  { label: 'VEGFA KO in tumour', target: 'VEGFA', operator: 'knockout', magnitude: 0, selection: { mode: 'cell-type', classes: ['Tumour'] } },
  { label: 'IFNG overexpression in T cells', target: 'IFNG', operator: 'overexpression', magnitude: 3, selection: { mode: 'cell-type', classes: ['T cell'] } },
  { label: 'IL6 KO in macrophages', target: 'IL6', operator: 'knockout', magnitude: 0, selection: { mode: 'cell-type', classes: ['Macrophage'] } },
  { label: 'EGFR inhibition in tumour', target: 'EGFR', operator: 'inhibition', magnitude: 0.2, selection: { mode: 'cell-type', classes: ['Tumour'] } },
  { label: 'TNF overexpression in macrophages', target: 'TNF', operator: 'overexpression', magnitude: 3, selection: { mode: 'cell-type', classes: ['Macrophage'] } },
  { label: 'CXCL12 KO in CAFs', target: 'CXCL12', operator: 'knockout', magnitude: 0, selection: { mode: 'cell-type', classes: ['CAF'] } },
  { label: 'SMAD3 KO in margin', target: 'SMAD3', operator: 'knockout', magnitude: 0, selection: { mode: 'region', classes: ['Invasive margin'] } },
  { label: 'MTOR inhibition in tumour', target: 'MTOR', operator: 'inhibition', magnitude: 0.3, selection: { mode: 'cell-type', classes: ['Tumour'] } },
  { label: 'STAT3 KO in core', target: 'STAT3', operator: 'knockout', magnitude: 0, selection: { mode: 'region', classes: ['Tumour core'] } },

  // Focal perturbations: a disc, at five positions, so the model meets the
  // same mechanism with the source in different parts of the section.
  { label: 'Focal TGFB1 KO (centre)', target: 'TGFB1', operator: 'knockout', magnitude: 0, selection: { mode: 'focal', fx: 0.45, fy: 0.5, fr: 0.16 } },
  { label: 'Focal TGFB1 overexpression (left)', target: 'TGFB1', operator: 'overexpression', magnitude: 3, selection: { mode: 'focal', fx: 0.25, fy: 0.45, fr: 0.14 } },
  { label: 'Focal IFNG overexpression (right)', target: 'IFNG', operator: 'overexpression', magnitude: 3, selection: { mode: 'focal', fx: 0.72, fy: 0.55, fr: 0.15 } },
  { label: 'Focal IL6 overexpression (top)', target: 'IL6', operator: 'overexpression', magnitude: 3, selection: { mode: 'focal', fx: 0.5, fy: 0.22, fr: 0.14 } },
  { label: 'Focal VEGFA KO (core)', target: 'VEGFA', operator: 'knockout', magnitude: 0, selection: { mode: 'focal', fx: 0.44, fy: 0.52, fr: 0.2 } },
  { label: 'Focal TNF overexpression (bottom)', target: 'TNF', operator: 'overexpression', magnitude: 3, selection: { mode: 'focal', fx: 0.55, fy: 0.78, fr: 0.15 } },
  { label: 'Focal CXCL12 KO (left margin)', target: 'CXCL12', operator: 'knockout', magnitude: 0, selection: { mode: 'focal', fx: 0.2, fy: 0.6, fr: 0.16 } },
  { label: 'Focal HIF1A KO (centre)', target: 'HIF1A', operator: 'knockout', magnitude: 0, selection: { mode: 'focal', fx: 0.46, fy: 0.48, fr: 0.18 } },
];

export interface CorpusOptions {
  /** Sections to generate. */
  sections: number;
  /** Biological edges kept per node, by ligand-receptor engagement. */
  biologicalEdgesPerNode?: number;
  /**
   * The centre of the per-section cell count, which is drawn around it rather
   * than used directly — a corpus with one section size teaches the domain
   * check nothing about size. Smaller than the demonstration case, for training
   * time; the density range is what makes the sections comparable to it.
   */
  cellsPerSection: number;
  /** Propagation stages to solve and train on. */
  stages: number;
  /** Graph parameters, matched to what inference will use. */
  graphK: number;
  seed: number;
}

export const DEFAULT_CORPUS: CorpusOptions = {
  sections: 18,
  cellsPerSection: 700,
  stages: 5,
  graphK: 6,
  biologicalEdgesPerNode: 4,
  seed: 4242,
};

/**
 * Biological edges: ligand-receptor engagement between cells, kept separate
 * from proximity as §5.4 requires.
 *
 * Built from the same secreted signals the mechanism uses, scored as
 * `ligand(source) * receptor(target) * exp(-d / diffusionLength)`. These reach
 * further than the kNN shell — a 150 µm cytokine crosses four or five
 * proximity hops — so they give the model a channel that the physical graph
 * does not, which is the point of having two edge types rather than one.
 *
 * Only the strongest few per node are kept. A dense biological graph would make
 * every cell a neighbour of every other and the distinction would evaporate.
 */
export function ligandReceptorEdges(
  observations: ObservationRecord[],
  state: TissueState,
  network: CompiledNetwork,
  perNode = 4,
): GraphEdge[] {
  if (perNode <= 0) return [];
  const n = observations.length;
  const k = state.nodeCount;
  const index = new GridIndex(observations);
  const edges: GraphEdge[] = [];

  for (let target = 0; target < n; target += 1) {
    const candidates: { source: number; score: number; distance: number; interaction: string }[] = [];

    for (const signal of network.signals) {
      const receptorLevel = state.activity[target * k + signal.receptor] as number;
      if (receptorLevel < 0.05) continue;
      const reach = signal.diffusionLength * 2.5;
      for (const neighbour of index.within(target, reach)) {
        const ligandLevel = state.activity[neighbour.index * k + signal.ligand] as number;
        if (ligandLevel < 0.05) continue;
        const score =
          ligandLevel * receptorLevel * signal.potency * Math.exp(-neighbour.distance / signal.diffusionLength);
        if (score < 1e-4) continue;
        candidates.push({
          source: neighbour.index,
          score,
          distance: neighbour.distance,
          interaction: `${(network.nodes[signal.ligand] as { symbol: string }).symbol}->${(network.nodes[signal.receptor] as { symbol: string }).symbol}`,
        });
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    const seen = new Set<number>();
    for (const candidate of candidates) {
      if (seen.size >= perNode) break;
      if (seen.has(candidate.source) || candidate.source === target) continue;
      seen.add(candidate.source);
      edges.push({
        source: candidate.source,
        target,
        distance: candidate.distance,
        weight: candidate.score,
        edgeType: 'biological',
        interaction: candidate.interaction,
      });
    }
  }
  return edges;
}

/**
 * Sections varying in composition, density and vascularity.
 *
 * The variation is the point. Trained on sections that differ only by noise,
 * a model learns the one tissue it saw and its held-out score says nothing
 * about whether it generalises — which is precisely the claim being tested.
 */
export function buildSections(options: CorpusOptions, network: CompiledNetwork): Section[] {
  const random = new RandomState(options.seed);
  const specRng = random.stream('corpus.specs');
  const sections: Section[] = [];

  for (let s = 0; s < options.sections; s += 1) {
    /*
     * Cell count and cell density both vary across the corpus, and they have to.
     *
     * The first version fixed `cellCount` at one value and drew the section's
     * width and height from a narrow range, which produced two failures at
     * once. `observations` had zero variance, so the out-of-domain check could
     * not use it at all — and with the old `sd || 1` floor it became the only
     * thing the check used, scoring the 2,400-cell demonstration case at 1900
     * standard deviations. And every section came out around 800 cells/mm²
     * while the demonstration case is 1,250, so the one tissue this lab ships
     * was 55% denser than anything the model had ever seen. Measured against
     * the mechanism it was meant to reproduce, agreement on that case fell to
     * r = 0.18, against 0.68 on held-out sections of the training size.
     *
     * A model is only usable on tissue like the tissue it was fitted to, so the
     * corpus has to cover what the lab actually serves rather than what is
     * cheapest to generate. Density is sampled over a range that brackets the
     * demonstration case on both sides; the area follows from the count and the
     * density rather than being drawn independently.
     */
    const cellCount = Math.round(options.cellsPerSection * (0.7 + specRng.next() * 0.6));
    const densityPerMm2 = 700 + specRng.next() * 1000;
    const area = (cellCount / densityPerMm2) * 1e6;
    const aspect = 1.15 + specRng.next() * 0.5;
    const width = Math.round(Math.sqrt(area * aspect));

    const spec: TissueSpec = {
      sampleId: `SIM-SEC-${String(s + 1).padStart(3, '0')}`,
      seed: (options.seed + s * 7919) >>> 0,
      cellCount,
      width,
      height: Math.round(area / width),
      tumourFraction: 0.3 + specRng.next() * 0.3,
      boundaryIrregularity: 0.15 + specRng.next() * 0.3,
      vesselCount: 3 + specRng.int(7),
      intratumoralVesselFraction: specRng.next() * 0.5,
      immuneInfiltration: 0.15 + specRng.next() * 0.7,
      libraryDepth: 2000 + specRng.int(1500),
      dispersion: 2.5 + specRng.next() * 2,
      condition: 'Simulated tumour section',
    };

    const tissue = generateTissue(spec, network);
    const graph = buildSpatialGraph(
      tissue.dataset.observations,
      { method: 'knn', k: options.graphK, symmetrise: true, weighting: 'gaussian' },
      'um',
      ligandReceptorEdges(tissue.dataset.observations, tissue.truth, network, options.biologicalEdgesPerNode),
    );

    sections.push({
      id: spec.sampleId,
      spec,
      baseline: tissue.truth,
      context: tissue.context,
      graph,
      cellTypes: tissue.cellTypes,
      regions: tissue.regions,
      observations: tissue.dataset.observations,
      observationCount: tissue.dataset.observations.length,
    });
  }

  return sections;
}

export function buildExamples(
  sections: Section[],
  recipes: PerturbationRecipe[],
  network: CompiledNetwork,
  stages: number,
): CorpusExample[] {
  const examples: CorpusExample[] = [];

  for (const section of sections) {
    // Real coordinates: a focal selection resolves against them, and the
    // placeholder zeros the first version used silently selected every cell.
    const observations = section.observations;

    for (const recipe of recipes) {
      let request: Parameters<typeof resolveSelection>[0];
      if (recipe.selection.mode === 'whole-tissue') {
        request = { mode: 'whole-tissue' };
      } else if (recipe.selection.mode === 'focal') {
        const focal = recipe.selection;
        request = {
          mode: 'radius',
          centre: { x: section.spec.width * focal.fx, y: section.spec.height * focal.fy },
          radius: Math.min(section.spec.width, section.spec.height) * focal.fr,
        };
      } else {
        request = { mode: recipe.selection.mode, classes: recipe.selection.classes };
      }
      const selection = resolveSelection(request, observations, section.cellTypes, section.regions);
      if (selection.resolvedIndices.length === 0) continue;

      const spec: PerturbationSpec = {
        branch: 'molecular-genetic',
        target: recipe.target,
        targetKind: 'gene',
        operator: recipe.operator,
        magnitude: recipe.magnitude,
        magnitudeSource: 'model-pack',
        stage: 'steady-state',
      };
      const definition = createDefinition(
        spec,
        selection,
        { decision: 'quantitative', reasons: [], remedies: [], confidence: 'high' },
        'corpus',
        '1.0.0',
      );

      const direct = computeDirectResponse({
        definition,
        network,
        baseline: section.baseline,
        capacity: section.context.capacity,
        exogenous: section.context.exogenous,
        cellTypes: section.cellTypes,
      });

      const directState = applyDirectToState(section.baseline, direct, network);
      const perturbedContext: TissueContext = {
        capacity: direct.capacity,
        exogenous: direct.exogenous,
        diffusion: section.context.diffusion,
        ligandReference: section.context.ligandReference,
      };

      const solved = solveTissue(directState, network, perturbedContext, direct.clamp, {
        innerSteps: 40,
        stages,
        dt: 0.1,
        tolerance: 0,
        ligandGain: 1.6,
        fieldCutoffFactor: 3,
        ...(section.context.ligandReference ? { ligandReference: section.context.ligandReference } : {}),
      });

      const directEffect = new Float64Array(section.observationCount * section.baseline.nodeCount);
      for (let i = 0; i < section.observationCount; i += 1) {
        for (const node of direct.targetNodes) {
          const offset = i * section.baseline.nodeCount + node;
          directEffect[offset] = (directState.activity[offset] as number) - (section.baseline.activity[offset] as number);
        }
      }

      examples.push({
        id: `${section.id}::${recipe.label}`,
        sectionId: section.id,
        perturbationLabel: recipe.label,
        truth: solved.stages.map(cloneState),
        baseline: cloneState(section.baseline),
        directEffect,
        graph: section.graph,
        labels: section.cellTypes,
        observationCount: section.observationCount,
        nodeCount: section.baseline.nodeCount,
        targetNodes: direct.targetNodes,
        selectedFraction: selection.resolvedIndices.length / section.observationCount,
      });
    }
  }

  return examples;
}

export interface CorpusSplit {
  train: CorpusExample[];
  validation: CorpusExample[];
  test: CorpusExample[];
  trainSections: string[];
  validationSections: string[];
  testSections: string[];
}

/**
 * Split at the section level, with a fixed seed.
 *
 * Every perturbation of a section goes to the same side. Splitting by example
 * would put the same tissue in train and test under different perturbations,
 * and the model could learn the section's baseline rather than the response.
 */
export function splitCorpus(examples: CorpusExample[], seed: number, validationFraction = 0.2, testFraction = 0.2): CorpusSplit {
  const sections = [...new Set(examples.map((e) => e.sectionId))].sort();
  const rng = new RandomState(seed).stream('corpus.split');
  const shuffled = rng.shuffle([...sections]);

  const testCount = Math.max(1, Math.round(sections.length * testFraction));
  const validationCount = Math.max(1, Math.round(sections.length * validationFraction));
  const testSections = new Set(shuffled.slice(0, testCount));
  const validationSections = new Set(shuffled.slice(testCount, testCount + validationCount));

  const train: CorpusExample[] = [];
  const validation: CorpusExample[] = [];
  const test: CorpusExample[] = [];
  for (const example of examples) {
    if (testSections.has(example.sectionId)) test.push(example);
    else if (validationSections.has(example.sectionId)) validation.push(example);
    else train.push(example);
  }

  return {
    train,
    validation,
    test,
    trainSections: sections.filter((s) => !testSections.has(s) && !validationSections.has(s)),
    validationSections: [...validationSections].sort(),
    testSections: [...testSections].sort(),
  };
}

/** The whole corpus, ready to train on. */
export function buildCorpus(options: CorpusOptions = DEFAULT_CORPUS): {
  network: CompiledNetwork;
  sections: Section[];
  examples: CorpusExample[];
  split: CorpusSplit;
} {
  const network = compileNetwork();
  const sections = buildSections(options, network);
  const examples = buildExamples(sections, CORPUS_RECIPES, network, options.stages);
  const split = splitCorpus(examples, options.seed);
  return { network, sections, examples, split };
}

/** Sanity: the section-level split must not leak a section across sides. */
export function splitIsClean(split: CorpusSplit): { clean: boolean; overlap: string[] } {
  const train = new Set(split.train.map((e) => e.sectionId));
  const validation = new Set(split.validation.map((e) => e.sectionId));
  const test = new Set(split.test.map((e) => e.sectionId));
  const overlap: string[] = [];
  for (const id of train) {
    if (validation.has(id) || test.has(id)) overlap.push(id);
  }
  for (const id of validation) if (test.has(id)) overlap.push(id);
  return { clean: overlap.length === 0, overlap: [...new Set(overlap)] };
}

export { meanField, computeField, buildDiffusion };
