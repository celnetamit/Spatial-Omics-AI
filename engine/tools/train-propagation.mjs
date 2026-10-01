/**
 * Trains the spatial propagation model pack and writes it to content/packs/.
 *
 *   npm run model:train                       # everything, in one process
 *   SPATIAL_JOB=member:0 npm run model:train  # one ensemble member
 *   SPATIAL_JOB=baseline  npm run model:train # the graph-free baseline
 *   SPATIAL_JOB=combine   npm run model:train # evaluate and write the pack
 *
 * The split exists because the members are independent by construction — that
 * is what makes the ensemble an ensemble — so training them one after another
 * wastes every core but one. Run the jobs concurrently and the wall clock is
 * one member instead of four. Each job rebuilds the corpus from the same seed,
 * which is deterministic, so they are training on identical data.
 *
 *   for i in 0 1 2; do SPATIAL_JOB=member:$i npm run model:train & done
 *   SPATIAL_JOB=baseline npm run model:train &
 *   wait; SPATIAL_JOB=combine npm run model:train
 *
 * What it produces:
 *   content/packs/propagation-model/weights.json     the ensemble
 *   content/packs/propagation-model/model-card.json  metrics, baselines, limits
 *
 * The model card is not a formality. It carries the §14.3 baseline table, the
 * §14.4 split, and the statement of what the metrics mean — which for this pack
 * is "reproduces the mechanistic simulator it was trained on", and not anything
 * about tissue. A pack without that statement would be read as the latter.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const dist = join(root, 'engine', 'dist');

const { buildCorpus, splitIsClean, CORPUS_RECIPES } = await import(join(dist, 'validate', 'corpus.js'));
const train = await import(join(dist, 'validate', 'train.js'));
const features = await import(join(dist, 'propagate', 'features.js'));
const gnn = await import(join(dist, 'propagate', 'gnn.js'));
const uncertainty = await import(join(dist, 'uncertainty', 'index.js'));
const { Rng } = await import(join(dist, 'core', 'rng.js'));

const number = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const OPTIONS = {
  sections: number('SPATIAL_SECTIONS', 14),
  cellsPerSection: number('SPATIAL_CELLS', 500),
  stages: number('SPATIAL_STAGES', 5),
  graphK: number('SPATIAL_GRAPH_K', 6),
  biologicalEdgesPerNode: number('SPATIAL_BIO_EDGES', 4),
  seed: number('SPATIAL_SEED', 4242),
};
const EPOCHS = number('SPATIAL_EPOCHS', 60);
const HIDDEN = number('SPATIAL_HIDDEN', 48);
const LAYERS = number('SPATIAL_LAYERS', 3);
const ENSEMBLE = number('SPATIAL_ENSEMBLE', 3);

const JOB = (process.env.SPATIAL_JOB ?? 'all').trim();
const PARTS_DIR = join(root, 'content', 'packs', 'propagation-model', '.parts');

const started = Date.now();
const log = (message) => process.stdout.write(`[${JOB}] [${((Date.now() - started) / 1000).toFixed(0)}s] ${message}\n`);

log(`building corpus: ${OPTIONS.sections} sections x ${OPTIONS.cellsPerSection} cells x ${CORPUS_RECIPES.length} perturbations`);
const corpus = buildCorpus(OPTIONS);
const clean = splitIsClean(corpus.split);
if (!clean.clean) {
  process.stderr.write(`section leak between splits: ${clean.overlap.join(', ')}\n`);
  process.exit(1);
}
log(
  `corpus ready: ${corpus.examples.length} examples — ` +
    `train ${corpus.split.train.length} (${corpus.split.trainSections.length} sections), ` +
    `val ${corpus.split.validation.length} (${corpus.split.validationSections.length}), ` +
    `test ${corpus.split.test.length} (${corpus.split.testSections.length})`,
);

// -- schema ----------------------------------------------------------------
//
// The target scale comes from the TRAINING split only. Deriving it from the
// whole corpus would let the held-out sections influence the model's
// normalisation, which is a small leak but a real one, and §14.4 has no
// threshold below which leakage is acceptable.

const nodeSymbols = corpus.network.nodes.map((node) => node.symbol);
const cellClasses = ['Tumour', 'CAF', 'Macrophage', 'T cell', 'Endothelial'];

const trainDeltas = [];
for (const example of corpus.split.train) {
  for (let stage = 1; stage < example.truth.length; stage += 1) {
    const delta = new Float64Array(example.truth[stage].activity.length);
    for (let i = 0; i < delta.length; i += 1) {
      delta[i] = example.truth[stage].activity[i] - example.truth[stage - 1].activity[i];
    }
    trainDeltas.push(delta);
  }
}
const targetScale = features.deriveTargetScale(trainDeltas, nodeSymbols.length);
const schema = { nodeSymbols, cellClasses, targetScale, version: '1.0.0' };
const config = features.configFor(schema, HIDDEN, LAYERS, 1e-5);
log(`schema: ${config.inputDim} inputs -> ${config.hiddenDim} hidden x ${config.layers} layers -> ${config.outputDim} outputs`);

// -- dispatch ---------------------------------------------------------------

mkdirSync(PARTS_DIR, { recursive: true });

const trainOptions = (seed) => ({
  epochs: EPOCHS,
  learningRate: 0.004,
  finalLearningRateFraction: 0.05,
  gradientClip: 2,
  seed,
  patience: Math.max(10, Math.round(EPOCHS / 4)),
  onEpoch: (info) => {
    if (info.epoch % 5 === 0 || info.epoch <= 2) {
      log(`  epoch ${info.epoch}: train ${info.trainLoss.toFixed(4)} val ${info.validationLoss.toFixed(4)} (${info.seconds.toFixed(1)}s)`);
    }
  },
});

const memberPath = (index) => join(PARTS_DIR, `member-${index}.json`);
const BASELINE_PATH = join(PARTS_DIR, 'baseline-mlp.json');

if (JOB.startsWith('member:')) {
  const index = Number.parseInt(JOB.slice('member:'.length), 10);
  log(`training ensemble member ${index + 1}/${ENSEMBLE}`);
  // A different seed per member: an ensemble whose members share an
  // initialisation is one model with extra steps, and its disagreement would
  // underestimate uncertainty by construction.
  const result = train.trainGnn(config, schema, corpus.split.train, corpus.split.validation, 'gnn', trainOptions(1000 + index * 137));
  log(`  best epoch ${result.bestEpoch}, validation ${result.bestValidationLoss.toFixed(4)}`);
  writeFileSync(
    memberPath(index),
    JSON.stringify({
      weights: gnn.serialiseWeights(result.weights),
      history: { member: index, bestEpoch: result.bestEpoch, bestValidationLoss: result.bestValidationLoss, epochs: result.history.length },
    }),
  );
  log(`wrote ${memberPath(index)}`);
  process.exit(0);
}

if (JOB === 'baseline') {
  log('training the graph-free baseline (same architecture, edges removed)');
  const result = train.trainGnn(config, schema, corpus.split.train, corpus.split.validation, 'mlp', trainOptions(777));
  log(`  best epoch ${result.bestEpoch}, validation ${result.bestValidationLoss.toFixed(4)}`);
  writeFileSync(
    BASELINE_PATH,
    JSON.stringify({ weights: gnn.serialiseWeights(result.weights), bestEpoch: result.bestEpoch, bestValidationLoss: result.bestValidationLoss }),
  );
  log(`wrote ${BASELINE_PATH}`);
  process.exit(0);
}

const members = [];
const histories = [];
let mlp;

if (JOB === 'combine') {
  for (let index = 0; index < ENSEMBLE; index += 1) {
    if (!existsSync(memberPath(index))) {
      process.stderr.write(`missing ${memberPath(index)} — run SPATIAL_JOB=member:${index} first\n`);
      process.exit(1);
    }
    const part = JSON.parse(readFileSync(memberPath(index), 'utf8'));
    members.push(gnn.deserialiseWeights(part.weights));
    histories.push(part.history);
  }
  if (!existsSync(BASELINE_PATH)) {
    process.stderr.write(`missing ${BASELINE_PATH} — run SPATIAL_JOB=baseline first\n`);
    process.exit(1);
  }
  const baselinePart = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  mlp = {
    weights: gnn.deserialiseWeights(baselinePart.weights),
    bestEpoch: baselinePart.bestEpoch,
    bestValidationLoss: baselinePart.bestValidationLoss,
  };
  log(`loaded ${members.length} member(s) and the graph-free baseline from ${PARTS_DIR}`);
} else {
  for (let member = 0; member < ENSEMBLE; member += 1) {
    log(`training ensemble member ${member + 1}/${ENSEMBLE}`);
    const result = train.trainGnn(config, schema, corpus.split.train, corpus.split.validation, 'gnn', trainOptions(1000 + member * 137));
    log(`  member ${member + 1} best epoch ${result.bestEpoch}, validation ${result.bestValidationLoss.toFixed(4)}`);
    members.push(result.weights);
    histories.push({ member, bestEpoch: result.bestEpoch, bestValidationLoss: result.bestValidationLoss, epochs: result.history.length });
  }
  log('training the graph-free baseline (same architecture, edges removed)');
  mlp = train.trainGnn(config, schema, corpus.split.train, corpus.split.validation, 'mlp', trainOptions(777));
  log(`  graph-free best epoch ${mlp.bestEpoch}, validation ${mlp.bestValidationLoss.toFixed(4)}`);
}

log('training the linear baseline');
const linear = train.trainLinear(corpus.split.train, schema, config.inputDim, config.outputDim, 1);

// -- evaluate ---------------------------------------------------------------

const controlRng = new Rng(31337);
const primary = members[0];
const evaluations = [
  ['gnn', train.gnnPredictor(primary, 'gnn', schema)],
  ['gnn-no-biological', train.gnnPredictor(primary, 'gnn-no-biological', schema)],
  ['gnn-no-spatial', train.gnnPredictor(primary, 'gnn-no-spatial', schema)],
  ['gnn-shuffled', train.gnnPredictor(primary, 'gnn-shuffled', schema)],
  ['mlp', train.gnnPredictor(mlp.weights, 'mlp', schema)],
  ['linear', train.linearPredictor(linear, schema)],
  ['zero', train.zeroPredictor(config.outputDim)],
];

log('evaluating on the held-out sections');
const metrics = {};
for (const [name, predictor] of evaluations) {
  metrics[name] = train.evaluate(predictor, corpus.split.test, schema, controlRng);
  const m = metrics[name];
  log(
    `  ${name.padEnd(18)} rollout R2 ${m.rolloutR2.toFixed(4)}  r ${m.rolloutPearson.toFixed(4)}  ` +
      `first-neighbour R2 ${m.firstNeighbourR2.toFixed(4)}  r ${m.firstNeighbourPearson.toFixed(4)}`,
  );
}

// -- domain reference -------------------------------------------------------

log('building the out-of-domain reference from the training sections');
const domainVectors = [];
for (const example of corpus.split.train) {
  domainVectors.push(contextVector(example, corpus));
}
const domain = uncertainty.buildDomainReference(uncertainty.DOMAIN_FEATURE_NAMES, domainVectors);

function contextVector(example, built) {
  const section = built.sections.find((s) => s.id === example.sectionId);
  const counts = new Map();
  for (const label of example.labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  const n = example.observationCount;
  let activitySum = 0;
  let activitySquared = 0;
  for (let i = 0; i < example.baseline.activity.length; i += 1) {
    const value = example.baseline.activity[i];
    activitySum += value;
    activitySquared += value * value;
  }
  const activityMean = activitySum / example.baseline.activity.length;
  const activityVariance = activitySquared / example.baseline.activity.length - activityMean * activityMean;
  let touched = 0;
  const k = example.nodeCount;
  for (let i = 0; i < n; i += 1) {
    for (const node of example.targetNodes) {
      if (Math.abs(example.directEffect[i * k + node]) > 1e-9) { touched += 1; break; }
    }
  }
  return Float64Array.from([
    n,
    section ? section.graph.diagnostics.medianEdgeLength : 0,
    section ? section.graph.diagnostics.meanDegree : 0,
    (counts.get('Tumour') ?? 0) / n,
    ((counts.get('T cell') ?? 0) + (counts.get('Macrophage') ?? 0)) / n,
    (counts.get('CAF') ?? 0) / n,
    activityMean,
    Math.sqrt(Math.max(0, activityVariance)),
    touched / n,
  ]);
}

// -- calibration ------------------------------------------------------------

log('calibrating the ensemble interval on the held-out sections');
const errors = [];
const dispersions = [];
for (const example of corpus.split.test.slice(0, 20)) {
  const adjacencies = train.adjacenciesForExample(example, 'gnn');
  const classIndex = features.classIndices(example.labels, schema);
  const totalStages = example.truth.length - 1;
  for (let stage = 1; stage < example.truth.length; stage += 1) {
    const previous = example.truth[stage - 1];
    const next = example.truth[stage];
    const built = features.buildFeatures(
      { current: previous, baseline: example.baseline, directEffect: example.directEffect, classIndex, stage, totalStages },
      schema,
    );
    const memberOutputs = members.map((weights) => gnn.forward(weights, built, example.observationCount, adjacencies).output);
    for (let i = 0; i < memberOutputs[0].length; i += 1) {
      const scale = schema.targetScale[i % schema.nodeSymbols.length];
      let sum = 0;
      for (const output of memberOutputs) sum += output[i] * scale;
      const mu = sum / memberOutputs.length;
      let ss = 0;
      for (const output of memberOutputs) { const d = output[i] * scale - mu; ss += d * d; }
      const spread = memberOutputs.length > 1 ? Math.sqrt(ss / (memberOutputs.length - 1)) : 0;
      const truth = next.activity[i] - previous.activity[i];
      errors.push(truth - mu);
      dispersions.push(spread);
    }
  }
}
const calibration = uncertainty.calibrateEnsemble(Float64Array.from(errors), Float64Array.from(dispersions), 0.9);
log(`  empirical coverage ${(calibration.empirical * 100).toFixed(1)}% against a nominal 90%`);

// -- write ------------------------------------------------------------------

const outputDir = join(root, 'content', 'packs', 'propagation-model');
mkdirSync(outputDir, { recursive: true });

const serialised = members.map((weights) => gnn.serialiseWeights(weights));
writeFileSync(
  join(outputDir, 'weights.json'),
  JSON.stringify({
    format: 'spatial-gnn-ensemble-v1',
    modelId: 'spatial-propagation-gnn',
    version: '1.0.0',
    schema: {
      nodeSymbols: schema.nodeSymbols,
      cellClasses: schema.cellClasses,
      targetScale: Array.from(schema.targetScale, (v) => Number(v.toPrecision(7))),
      version: schema.version,
    },
    members: serialised,
  }),
);

const dispersionThreshold = quantileOf(dispersions, 0.9);

writeFileSync(
  join(outputDir, 'model-card.json'),
  JSON.stringify(
    {
      modelId: 'spatial-propagation-gnn',
      version: '1.0.0',
      createdAt: new Date().toISOString(),
      architecture: {
        kind: 'edge-type-aware message passing, applied as a one-step operator and rolled out',
        inputDim: config.inputDim,
        hiddenDim: config.hiddenDim,
        layers: config.layers,
        outputDim: config.outputDim,
        edgeTypes: config.edgeTypes,
        parameters: gnn.parameterCount(members[0]),
        ensembleMembers: members.length,
      },
      trainingData: {
        source: 'Simulated sections from the spatial-omics-engine tissue model, perturbed and solved by the mechanistic reaction-diffusion solver.',
        sections: OPTIONS.sections,
        cellsPerSection: OPTIONS.cellsPerSection,
        perturbations: CORPUS_RECIPES.length,
        stages: OPTIONS.stages,
        examples: corpus.examples.length,
        seed: OPTIONS.seed,
        split: {
          policy: 'section-level, never cell-level (§14.4)',
          trainSections: corpus.split.trainSections,
          validationSections: corpus.split.validationSections,
          testSections: corpus.split.testSections,
        },
        graph: { method: 'knn', k: OPTIONS.graphK, biologicalEdgesPerNode: OPTIONS.biologicalEdgesPerNode },
      },
      whatTheMetricsMean:
        'Every figure below is measured against the mechanistic simulator that generated the data. They say how well this network reproduces that mechanism on sections it was not fitted to. ' +
        'They are NOT evidence about human tissue, about any real perturbation, or about any drug. §18.1 lists a real spatial perturbation corpus as a freeze item for a research-grade release; this pack does not discharge it.',
      metrics,
      baselineNotes: Object.fromEntries(
        Object.entries(train.VARIANT_DESCRIPTION),
      ),
      uncertainty: {
        method: 'deep ensemble of independently initialised members',
        calibration,
        dispersionThreshold,
        domain,
      },
      trainingHistory: histories,
      limitations: measuredLimitations(),
    },
    (key, value) => (value instanceof Float64Array || value instanceof Int32Array ? Array.from(value) : value),
    2,
  ),
);

/**
 * The limitations, with the ones that depend on how training actually went
 * computed from the measurements rather than written down in advance.
 *
 * A fixed list ages badly and, worse, cannot report a bad result. These three
 * numbers are the ones a reader would want to know before trusting a prediction
 * and are exactly the ones a fixed list would omit: how much variance the model
 * explains where it matters, how much of that survives destroying the graph,
 * and whether the interval covers what it claims to.
 */
function measuredLimitations() {
  const out = [
    'Trained on simulated tissue only. No wet-lab perturbation data was used at any point.',
    'The cell-class vocabulary is fixed to the five types the generator produces. A dataset with other cell types maps them to the unknown-class slot.',
    `The feature space is the ${config.outputDim}-node curated network. A dataset measuring other genes cannot be predicted on without a new pack.`,
    'Stage indices count rounds of intercellular signalling in the model and are not calibrated to biological time (§7.8).',
  ];

  const gnnMetrics = metrics.gnn;
  const shuffled = metrics['gnn-shuffled'];

  if (gnnMetrics) {
    const r2 = gnnMetrics.firstNeighbourR2;
    out.push(
      `On the cells one hop from a perturbed cell — where a spatial model has to earn its keep — this pack explains ` +
        `${(r2 * 100).toFixed(1)}% of the variance (first-neighbour R² ${r2.toFixed(3)}, Pearson ` +
        `${gnnMetrics.firstNeighbourPearson.toFixed(3)}). It is directional evidence about where a perturbation ` +
        `travels, not a quantitative prediction of how much any individual cell changes.`,
    );
  }

  if (gnnMetrics && shuffled && gnnMetrics.firstNeighbourR2 > 0) {
    /*
     * The control that decides what the graph is worth.
     *
     * `gnn-shuffled` keeps the degree sequence and permutes who is adjacent to
     * whom. Skill it retains is skill that does not come from the real
     * neighbourhood — so the honest statement of what the spatial structure
     * buys is the gap between the two, not the model's score on its own.
     */
    const share = shuffled.firstNeighbourR2 / gnnMetrics.firstNeighbourR2;
    out.push(
      `Permuting the graph while keeping every cell's degree (the gnn-shuffled control) retains ` +
        `${(share * 100).toFixed(0)}% of the first-neighbour R² (${shuffled.firstNeighbourR2.toFixed(3)} against ` +
        `${gnnMetrics.firstNeighbourR2.toFixed(3)}). Most of what this model does is aggregate over *a* neighbourhood; ` +
        `the specific edges account for the remaining ${(100 - share * 100).toFixed(0)}%. Read a propagation map as ` +
        `neighbourhood context first and edge-specific routing second.`,
    );
  }

  const empirical = calibration?.empirical;
  if (typeof empirical === 'number') {
    const nominal = calibration.nominal;
    out.push(
      empirical < nominal - 0.02
        ? `The ensemble interval is too narrow: ${(empirical * 100).toFixed(1)}% of held-out errors fell inside the ` +
          `nominal ${(nominal * 100).toFixed(0)}% interval. Treat the spread as a ranking of which predictions are ` +
          `less certain, not as a ${(nominal * 100).toFixed(0)}% interval. The correction factor is reported above ` +
          `and deliberately not applied.`
        : `The ensemble spread is a relative measure of uncertainty; its absolute calibration is reported above rather than applied.`,
    );
  }

  return out;
}

function quantileOf(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

log(`wrote ${outputDir}/weights.json and model-card.json`);
log('done');
