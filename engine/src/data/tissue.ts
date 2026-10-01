/**
 * The generative tissue model behind the bundled demonstration case.
 *
 * WHAT THIS PRODUCES, AND WHAT IT DOES NOT
 *
 * A simulated tumour-stroma section: an irregular tumour mass, an invasive
 * margin, surrounding stroma, a vascular network, and immune infiltrate placed
 * where each of those actually sits. Cell-type identity sets which network
 * nodes a cell can express; vessel distance sets hypoxia; the mechanistic
 * solver in `propagate/mechanism` then relaxes the whole section to a steady
 * state, and counts are drawn from it.
 *
 * It is a simulation. It is labelled `accessStatus: 'bundled-demonstration'`
 * and its `origin` field says so in a sentence that follows the dataset into
 * every report. §18.1 lists "exact dataset/version/license" as a freeze item
 * for a research-grade release, and this does not discharge that — it makes the
 * lab runnable, benchmarkable and ablatable without one, which is a different
 * and lesser thing.
 *
 * What makes it worth having rather than noise: the expression is the output of
 * a mechanism with feedback, spatial coupling and cell-type structure, so the
 * baseline analysis finds real neighbourhood enrichment, real ligand-receptor
 * structure and real pathway gradients — and a perturbation propagates through
 * the same mechanism rather than through a rule written to make it look like it
 * does.
 */

import { RandomState, type Rng } from '../core/rng';
import type { CompiledNetwork } from '../propagate/network';
import {
  buildDiffusion, computeField, emptyState, fullCapacity, meanField, noExogenousDrive, solveTissue,
  type Capacity, type ExogenousDrive, type TissueContext, type TissueState,
} from '../propagate/mechanism';
import { finaliseDataset } from './ingest';
import type {
  DatasetMetadata, FeatureRecord, IngestionReport, ObservationRecord, SpatialDataset,
} from './types';

export type CellType = 'Tumour' | 'CAF' | 'Macrophage' | 'T cell' | 'Endothelial';

export const CELL_TYPES: CellType[] = ['Tumour', 'CAF', 'Macrophage', 'T cell', 'Endothelial'];

export interface TissueSpec {
  sampleId: string;
  seed: number;
  /** Cells in the section. */
  cellCount: number;
  /** Section width and height, in µm. */
  width: number;
  height: number;
  /** Fraction of cells that are tumour. */
  tumourFraction: number;
  /** How irregular the tumour boundary is; 0 gives a disc. */
  boundaryIrregularity: number;
  /** Number of vessels. More vessels means less hypoxia. */
  vesselCount: number;
  /**
   * Fraction of vessels placed *inside* the tumour mass rather than around it.
   *
   * This, and not the vessel count, is what controls how hypoxic the core is.
   * The first version placed every vessel in a ring outside the mass, so
   * raising the count from 7 to 22 for the "well-vascularised" reference moved
   * mean CA9 in tumour cells from 36.6 to 29.7 — a difference, but not the
   * different tissue the comparison is supposed to be about. A vessel in the
   * core is what removes a hypoxic core.
   */
  intratumoralVesselFraction: number;
  /** Immune infiltration: 0 is excluded, 1 is heavily infiltrated. */
  immuneInfiltration: number;
  /** Mean counts per cell, before type-specific scaling. */
  libraryDepth: number;
  /** Negative-binomial dispersion. Lower is noisier. */
  dispersion: number;
  condition: string;
}

export const DEMONSTRATION_SPEC: TissueSpec = {
  sampleId: 'SIM-TME-001',
  seed: 20260821,
  cellCount: 2400,
  width: 1600,
  height: 1200,
  tumourFraction: 0.42,
  boundaryIrregularity: 0.28,
  vesselCount: 7,
  intratumoralVesselFraction: 0,
  immuneInfiltration: 0.45,
  libraryDepth: 2600,
  dispersion: 3.2,
  condition: 'Tumour, untreated',
};

/**
 * Which network nodes each cell type can express, and how strongly.
 *
 * This is the table that makes the tissue a tissue rather than 2400 copies of
 * one cell. A T cell that cannot make COL1A1 is a T cell; one that can is a
 * rendering artefact, and a perturbation aimed at collagen would then appear to
 * affect the immune compartment.
 *
 * Values are ceilings on activity, so 0 means the node is absent and 1 means it
 * is unconstrained. Anything not listed takes `baseline`.
 */
interface TypeProfile {
  baseline: number;
  nodes: Record<string, number>;
  /** Relative library size — a lymphocyte yields far less RNA than a tumour cell. */
  depthScale: number;
}

const TYPE_PROFILES: Record<CellType, TypeProfile> = {
  Tumour: {
    baseline: 0.75,
    depthScale: 1.25,
    nodes: {
      EGFR: 1, EGF: 0.3, TGFA: 0.9, KRAS: 1, BRAF: 1, MAP2K1: 1, MAPK1: 1,
      PIK3CA: 1, AKT1: 1, MTOR: 1, PTEN: 0.6,
      HIF1A: 1, VEGFA: 1, CA9: 1, SLC2A1: 1, LDHA: 1, PGK1: 1, KDR: 0.05,
      CDH1: 1, SNAI1: 1, ZEB1: 1, VIM: 0.5, CDH2: 0.7,
      TGFB1: 0.5, TGFBR1: 0.9, TGFBR2: 0.9, SMAD2: 1, SMAD3: 1,
      MYC: 1, CCND1: 1, CDK4: 1, MKI67: 1, TP53: 1, CDKN1A: 1,
      BAX: 1, BCL2: 1, CASP3: 1, CD274: 0.9, B2M: 1,
      COL1A1: 0.05, ACTA2: 0.05, FN1: 0.3,
      IFNG: 0.02, CXCL9: 0.1, IL6: 0.4, TNF: 0.1,
    },
  },
  CAF: {
    baseline: 0.5,
    depthScale: 1.0,
    nodes: {
      COL1A1: 1, FN1: 1, ACTA2: 1, VIM: 1, CDH2: 0.6, CDH1: 0.05,
      TGFB1: 1, TGFBR1: 1, TGFBR2: 1, SMAD2: 1, SMAD3: 1, SMAD7: 1,
      SNAI1: 0.6, ZEB1: 0.6,
      CXCL12: 1, IL6: 0.9, IL6R: 0.5, STAT3: 1,
      HIF1A: 0.7, VEGFA: 0.7, PGK1: 0.7, LDHA: 0.7, CA9: 0.2,
      EGFR: 0.2, MAPK1: 0.7, AKT1: 0.7, MYC: 0.5, MKI67: 0.3,
      CD274: 0.2, IFNG: 0.01,
    },
  },
  Macrophage: {
    baseline: 0.45,
    depthScale: 0.85,
    nodes: {
      TNF: 1, TNFRSF1A: 1, NFKB1: 1, RELA: 1, NFKBIA: 1,
      IL6: 1, IL6R: 1, STAT3: 1, SOCS3: 1,
      CXCL9: 0.8, IFNGR1: 1, STAT1: 1, IRF1: 1, CD274: 1, B2M: 1,
      VEGFA: 0.8, HIF1A: 0.8, CXCR4: 0.6,
      TGFB1: 0.8, TGFBR1: 0.6, TGFBR2: 0.6,
      COL1A1: 0.05, ACTA2: 0.05, CDH1: 0.02, MKI67: 0.15,
      EGFR: 0.05, MAPK1: 0.6,
    },
  },
  'T cell': {
    baseline: 0.35,
    depthScale: 0.6,
    nodes: {
      IFNG: 1, IFNGR1: 0.7, STAT1: 1, IRF1: 1, B2M: 1,
      CXCR4: 1, CXCL9: 0.1,
      TNF: 0.7, TNFRSF1A: 0.8, NFKB1: 0.9, RELA: 0.9, NFKBIA: 0.9,
      IL6R: 0.5, STAT3: 0.7, SOCS3: 0.7,
      TGFBR1: 0.8, TGFBR2: 0.8, SMAD2: 0.7, SMAD3: 0.7,
      CD274: 0.2, MKI67: 0.3, CASP3: 0.6, BAX: 0.7, BCL2: 0.8,
      COL1A1: 0.01, ACTA2: 0.01, CDH1: 0.01, EGFR: 0.02, VEGFA: 0.1,
    },
  },
  Endothelial: {
    baseline: 0.4,
    depthScale: 0.9,
    nodes: {
      KDR: 1, VEGFA: 0.4, CDH2: 0.8, VIM: 0.8, CDH1: 0.1,
      HIF1A: 0.6, TGFBR1: 0.8, TGFBR2: 0.8, SMAD2: 0.8, SMAD3: 0.8,
      NFKB1: 0.8, RELA: 0.8, NFKBIA: 0.8, TNFRSF1A: 0.9,
      CXCL12: 0.7, IL6: 0.5, MKI67: 0.3,
      COL1A1: 0.3, FN1: 0.7, ACTA2: 0.3,
      B2M: 0.9, CD274: 0.3, IFNGR1: 0.7, STAT1: 0.8,
      EGFR: 0.1, MAPK1: 0.7, AKT1: 0.8,
    },
  },
};

export interface GeneratedTissue {
  dataset: SpatialDataset;
  /** The mechanistic state the counts were drawn from. */
  truth: TissueState;
  capacity: Capacity;
  /** The oxygen-tension drive on HIF1A; part of the tissue, not of the network. */
  exogenous: ExogenousDrive;
  /** Capacity, exogenous drive, diffusion and reference, ready to solve with. */
  context: TissueContext;
  cellTypes: CellType[];
  regions: string[];
  /** Distance from each cell to the nearest vessel, in µm. */
  vesselDistance: Float64Array;
  spec: TissueSpec;
}

export function generateTissue(spec: TissueSpec, network: CompiledNetwork): GeneratedTissue {
  /*
   * One stream per quantity, and the geometry drawn before anything that
   * depends on it.
   *
   * These are not the same generator by design. With one shared stream,
   * changing the cell count moves the vessel positions, which moves the hypoxic
   * gradient, which changes every expression value — so two tissues meant to
   * differ only in size differ in everything, and a size ablation measures
   * nothing.
   */
  const random = new RandomState(spec.seed);
  const geometryRng = random.stream('tissue.geometry');
  const vesselRng = random.stream('tissue.vessels');
  const typeRng = random.stream('tissue.cell-types');
  const countRng = random.stream('tissue.counts');
  const jitterRng = random.stream('tissue.expression-jitter');

  // -- tumour boundary ------------------------------------------------------

  const centreX = spec.width * 0.44;
  const centreY = spec.height * 0.52;
  const baseRadius = Math.min(spec.width, spec.height) * 0.3;

  // An irregular boundary from a few Fourier modes. A disc would make the
  // invasive margin a perfect ring, and margin-localised effects would then be
  // trivially separable by radius alone.
  const modes = [2, 3, 5, 7].map((frequency) => ({
    frequency,
    amplitude: (geometryRng.next() * spec.boundaryIrregularity) / Math.sqrt(frequency),
    phase: geometryRng.next() * Math.PI * 2,
  }));

  const tumourRadiusAt = (angle: number): number => {
    let factor = 1;
    for (const mode of modes) factor += mode.amplitude * Math.cos(mode.frequency * angle + mode.phase);
    return baseRadius * Math.max(0.35, factor);
  };

  // -- vessels --------------------------------------------------------------

  const vessels: { x: number; y: number }[] = [];
  for (let v = 0; v < spec.vesselCount; v += 1) {
    const angle = vesselRng.next() * Math.PI * 2;
    // Most vessels sit in a ring outside the mass — that is what makes a
    // hypoxic core, and the hypoxic core is the structure the demonstration
    // turns on. `intratumoralVesselFraction` places the rest inside it, which
    // is how the well-vascularised reference gets a genuinely different tissue
    // rather than the same one with the gradient shifted a little.
    const inside = vesselRng.next() < spec.intratumoralVesselFraction;
    const radial = inside
      ? baseRadius * vesselRng.next() * 0.85
      : baseRadius * (0.85 + vesselRng.next() * 1.4);
    vessels.push({
      x: Math.min(spec.width, Math.max(0, centreX + Math.cos(angle) * radial)),
      y: Math.min(spec.height, Math.max(0, centreY + Math.sin(angle) * radial)),
    });
  }

  // -- cell placement -------------------------------------------------------

  const positions: { x: number; y: number }[] = [];
  const cellTypes: CellType[] = [];
  const regions: string[] = [];

  const minimumSeparation = Math.sqrt((spec.width * spec.height) / spec.cellCount) * 0.55;
  const placed: { x: number; y: number }[] = [];

  let attempts = 0;
  while (positions.length < spec.cellCount && attempts < spec.cellCount * 60) {
    attempts += 1;
    const x = geometryRng.uniform(10, spec.width - 10);
    const y = geometryRng.uniform(10, spec.height - 10);

    // Poisson-disc rejection, so cells do not overlap. A uniform scatter puts
    // pairs at sub-micron separation, and a distance-weighted graph then has an
    // edge of effectively infinite weight.
    let tooClose = false;
    for (const other of placed) {
      const dx = x - other.x;
      const dy = y - other.y;
      if (dx * dx + dy * dy < minimumSeparation * minimumSeparation) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) continue;

    const dx = x - centreX;
    const dy = y - centreY;
    const radius = Math.sqrt(dx * dx + dy * dy);
    const angle = Math.atan2(dy, dx);
    const boundary = tumourRadiusAt(angle);
    const relative = radius / boundary;

    let region: string;
    if (relative < 0.55) region = 'Tumour core';
    else if (relative < 1.0) region = 'Tumour periphery';
    else if (relative < 1.3) region = 'Invasive margin';
    else region = 'Stroma';

    // Density falls off outside the tumour, which is what a section looks like.
    const keepProbability = region === 'Stroma' ? 0.78 : 1;
    if (geometryRng.next() > keepProbability) continue;

    positions.push({ x, y });
    placed.push({ x, y });
    regions.push(region);
  }

  const n = positions.length;
  const vesselDistance = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const point = positions[i] as { x: number; y: number };
    let best = Infinity;
    for (const vessel of vessels) {
      const dx = point.x - vessel.x;
      const dy = point.y - vessel.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance < best) best = distance;
    }
    vesselDistance[i] = best;
  }

  // -- cell type assignment -------------------------------------------------

  for (let i = 0; i < n; i += 1) {
    const region = regions[i] as string;
    const nearVessel = (vesselDistance[i] as number) < 45;
    cellTypes.push(assignCellType(region, nearVessel, spec, typeRng));
  }

  // -- capacity and hypoxic drive ------------------------------------------

  const nodeCount = network.nodes.length;
  const capacity = fullCapacity(n, nodeCount);
  const hifIndex = network.index.get('HIF1A') as number;
  const vegfIndex = network.index.get('VEGFA') as number;

  for (let i = 0; i < n; i += 1) {
    const profile = TYPE_PROFILES[cellTypes[i] as CellType];
    for (let node = 0; node < nodeCount; node += 1) {
      const symbol = (network.nodes[node] as { symbol: string }).symbol;
      const declared = profile.nodes[symbol];
      const ceiling = declared === undefined ? profile.baseline : declared;
      // A little per-cell heterogeneity, so a cell type is a distribution
      // rather than 400 identical vectors — which would make every within-type
      // variance zero and every t-test degenerate.
      const jitter = Math.exp(jitterRng.normal(0, 0.18));
      capacity.values[i * nodeCount + node] = Math.min(1, Math.max(0, ceiling * jitter));
    }
  }

  /*
   * Hypoxia enters as a sustained drive on HIF1A, not as an initial value.
   *
   * Oxygen tension is a property of the tissue's vasculature and it does not
   * go away because the network relaxed. Setting it as an initial condition —
   * which is what the first version did — let the very first inner step pull
   * HIF1A back to its basal fixed point, and the hypoxic core disappeared
   * before a single ligand had diffused: CA9 correlated with vessel distance at
   * r = -0.02 inside the tumour compartment while still *looking* graded across
   * regions, because the regions differ in composition. That is a
   * near-perfect way to fool a reader, this one included.
   */
  const hypoxiaScale = 140;
  const hypoxiaStrength = 3.4;
  const exogenous = noExogenousDrive(n, nodeCount);
  const initial = emptyState(n, nodeCount);

  for (let i = 0; i < n; i += 1) {
    for (let node = 0; node < nodeCount; node += 1) {
      initial.activity[i * nodeCount + node] =
        (network.basal[node] as number) * (capacity.values[i * nodeCount + node] as number);
    }
    const hypoxia = 1 - Math.exp(-(vesselDistance[i] as number) / hypoxiaScale);
    exogenous.values[i * nodeCount + hifIndex] = hypoxiaStrength * hypoxia;
    // HIF1A must be able to reach the level the drive is asking for, so the
    // ceiling opens with it — otherwise capacity silently caps the gradient.
    capacity.values[i * nodeCount + hifIndex] = Math.max(
      capacity.values[i * nodeCount + hifIndex] as number,
      0.25 + 0.7 * hypoxia,
    );
    void vegfIndex;
  }

  // -- solve ---------------------------------------------------------------

  const observations: ObservationRecord[] = positions.map((point, i) => ({
    id: `${spec.sampleId}_${String(i).padStart(5, '0')}`,
    x: Math.round(point.x * 100) / 100,
    y: Math.round(point.y * 100) / 100,
    sampleId: spec.sampleId,
    cellType: cellTypes[i] as string,
    region: regions[i] as string,
    donor: spec.sampleId,
  }));

  const diffusion = buildDiffusion(observations, network);
  /*
   * Two passes.
   *
   * The receptor response is read relative to the section's mean ligand
   * concentration, and on the first pass that mean is taken from the initial
   * state — which is basal expression, not the tissue the solve produces. So
   * the first pass is a burn-in: its converged state gives the reference that
   * actually describes this tissue, and the second pass re-solves against it.
   * One pass leaves the reference describing a tissue that no longer exists.
   */
  const solveOptions = { innerSteps: 40, stages: 12, dt: 0.1, tolerance: 1e-5, ligandGain: 1.6, fieldCutoffFactor: 3 };
  // The burn-in has no reference yet — `null` tells the solver to compute it
  // from the state it is given, which is what the burn-in is for.
  const burnInContext: TissueContext = { capacity, exogenous, diffusion, ligandReference: null };
  const burnIn = solveTissue(initial, network, burnInContext, null, solveOptions);
  const burnInState = burnIn.stages[burnIn.stages.length - 1] as TissueState;
  const reference = meanField(computeField(burnInState, network, diffusion));

  const context: TissueContext = { capacity, exogenous, diffusion, ligandReference: reference };
  const solved = solveTissue(initial, network, context, null, { ...solveOptions, ligandReference: reference });
  const truth = solved.stages[solved.stages.length - 1] as TissueState;

  // -- counts ---------------------------------------------------------------

  const features: FeatureRecord[] = network.nodes.map((node) => {
    const record: FeatureRecord = {
      id: node.symbol,
      symbol: node.symbol,
      namespace: 'HGNC',
      modality: 'transcriptomics',
      species: 'Homo sapiens',
    };
    if (node.uniprot) record.uniprot = node.uniprot;
    return record;
  });

  // Five markers are also measured as protein, so the case exercises the
  // combined-modality path rather than declaring support for it.
  const proteinPanel = ['EGFR', 'CD274', 'MKI67', 'ACTA2', 'VIM'];
  for (const symbol of proteinPanel) {
    const node = network.nodes[network.index.get(symbol) as number] as { symbol: string; uniprot?: string };
    const record: FeatureRecord = {
      id: `PROT_${symbol}`,
      symbol: `${symbol} (protein)`,
      namespace: 'HGNC',
      modality: 'proteomics',
      species: 'Homo sapiens',
    };
    if (node.uniprot) record.uniprot = node.uniprot;
    features.push(record);
  }

  const width = features.length;
  const matrix = new Float64Array(n * width);
  for (let i = 0; i < n; i += 1) {
    const profile = TYPE_PROFILES[cellTypes[i] as CellType];
    const depth = spec.libraryDepth * profile.depthScale * Math.exp(countRng.normal(0, 0.25));
    for (let node = 0; node < nodeCount; node += 1) {
      const activity = truth.activity[i * nodeCount + node] as number;
      // A floor of 0.01 stands for ambient RNA: without it a third of the
      // matrix is structural zeros and the QC sparsity metric is meaningless.
      const mu = (depth / nodeCount) * (0.01 + activity * 3.2);
      matrix[i * width + node] = countRng.negativeBinomial(mu, spec.dispersion);
    }
    proteinPanel.forEach((symbol, offset) => {
      const node = network.index.get(symbol) as number;
      const activity = truth.activity[i * nodeCount + node] as number;
      // Protein lags transcript and has a higher floor — the two modalities
      // agreeing exactly would make the combined view pointless.
      const lagged = 0.65 * activity + 0.35 * (network.basal[node] as number);
      const mu = 60 * (0.08 + lagged * 2.4) * profile.depthScale;
      matrix[i * width + nodeCount + offset] = Math.max(0, countRng.negativeBinomial(mu, 6));
    });
  }

  const metadata: DatasetMetadata = {
    datasetId: `sim-tme-${spec.sampleId.toLowerCase()}`,
    sampleId: spec.sampleId,
    organism: 'Homo sapiens',
    genomeBuild: null,
    tissue: 'Tumour microenvironment (simulated)',
    condition: spec.condition,
    assay: 'Simulated single-cell resolved spatial transcriptomics with a 5-marker protein panel',
    platform: 'spatial-omics-engine tissue generator',
    resolution: 'cell',
    coordinateUnit: 'um',
    coordinateSystem: 'section-local',
    featureNamespace: 'HGNC',
    preprocessingStatus: 'raw-counts',
    donorId: spec.sampleId,
    batchId: null,
    replicate: null,
    licence: 'CC0-1.0 (generated by this repository)',
    accessStatus: 'bundled-demonstration',
    origin:
      'SIMULATED. Generated by the spatial-omics-engine tissue model: cells placed by Poisson-disc rejection into a tumour core, ' +
      'periphery, invasive margin and stroma; cell-type identity setting expression capacity; hypoxia from vessel distance; and a ' +
      'curated intracellular network coupled by diffusible ligands relaxed to steady state. Counts are negative-binomial draws from ' +
      'that state. This is not measured tissue, and no result computed on it is evidence about human biology.',
    imageAlignment: null,
  };

  const ingestion: IngestionReport = {
    sourceFormat: 'generated',
    sourceFiles: [],
    observationCount: n,
    featureCount: width,
    notes: [
      `Generated from spec seed ${spec.seed} with ${spec.cellCount} requested and ${n} placed cells.`,
      `Mechanistic solve: ${burnIn.stagesRun}-stage burn-in to fix the ligand reference, then ${solved.stagesRun} stage(s) ` +
        `${solved.converged ? 'to convergence' : 'without converging'} (final delta ${solved.finalDelta.toExponential(2)}).`,
      `${vessels.length} vessel(s); hypoxia length scale ${hypoxiaScale} µm.`,
    ],
    unmappedFeatures: [],
    droppedObservations: [],
    ingestedAt: new Date().toISOString(),
  };

  return {
    dataset: finaliseDataset({ metadata, observations, features, matrix, ingestion }),
    truth,
    capacity,
    exogenous,
    context,
    cellTypes,
    regions,
    vesselDistance,
    spec,
  };
}

function assignCellType(region: string, nearVessel: boolean, spec: TissueSpec, rng: Rng): CellType {
  if (nearVessel && rng.next() < 0.55) return 'Endothelial';

  const draw = rng.next();
  switch (region) {
    case 'Tumour core': {
      if (draw < 0.86) return 'Tumour';
      if (draw < 0.86 + 0.09 * spec.immuneInfiltration * 2) return 'Macrophage';
      if (draw < 0.97) return 'CAF';
      return 'T cell';
    }
    case 'Tumour periphery': {
      if (draw < 0.7) return 'Tumour';
      if (draw < 0.82) return 'CAF';
      if (draw < 0.82 + 0.1 * spec.immuneInfiltration * 2) return 'Macrophage';
      return 'T cell';
    }
    case 'Invasive margin': {
      // The margin is where the immune compartment concentrates, and having it
      // do so is what makes a margin-localised finding possible at all.
      if (draw < 0.26) return 'Tumour';
      if (draw < 0.5) return 'CAF';
      if (draw < 0.5 + 0.28 * spec.immuneInfiltration * 2) return 'T cell';
      if (draw < 0.9) return 'Macrophage';
      return 'Endothelial';
    }
    default: {
      if (draw < 0.52) return 'CAF';
      if (draw < 0.68) return 'Macrophage';
      if (draw < 0.68 + 0.16 * spec.immuneInfiltration * 2) return 'T cell';
      if (draw < 0.95) return 'Endothelial';
      return 'Tumour';
    }
  }
}

/** The capacity profile a cell type carries, for the case documentation. */
export function cellTypeProfile(type: CellType): Record<string, number> {
  return TYPE_PROFILES[type].nodes;
}

export function cellTypeDepthScale(type: CellType): number {
  return TYPE_PROFILES[type].depthScale;
}

/** The ligand field at the generated steady state, for the case's provenance. */
export function tissueField(tissue: GeneratedTissue, network: CompiledNetwork): Float64Array {
  const diffusion = buildDiffusion(tissue.dataset.observations, network);
  return computeField(tissue.truth, network, diffusion).values;
}
