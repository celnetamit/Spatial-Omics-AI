/**
 * Checks that the shipped content packs agree with each other.
 *
 *   npm run content:validate
 *
 * Each pack validates itself at startup — the registry has §5 rules, the loader
 * drops a malformed case — but nothing checks the *joins* between them, and the
 * joins are where a silent failure lives. A drug whose target is not a node in
 * the regulatory network does not crash: it resolves to nothing, the direct
 * effect is zero, and the lab reports that the compound did nothing. That reads
 * as a scientific result. It is a missing string match.
 *
 * So this walks the edges between packs rather than the packs themselves, and
 * exits non-zero on anything that would turn into a wrong number rather than an
 * error message. Warnings are for things a reader should know and the software
 * already handles.
 *
 * It runs on the built output, not the sources, because that is what ships.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const built = join(root, 'dist', 'server');
const contentRoot = join(root, 'content');

if (!existsSync(join(built, 'content', 'packs', 'parameters.js'))) {
  process.stderr.write('dist/server is missing — run `npm run server:build` first.\n');
  process.exit(2);
}

const enginePath = (...parts) => join(built, 'engine', 'src', ...parts);
const { compileNetwork } = await import(enginePath('propagate', 'network.js'));
const { decodeDataset, decodeToFloat64 } = await import(enginePath('data', 'caseFormat.js'));
const { contentHash } = await import(enginePath('core', 'provenance.js'));
const { PARAMETER_REGISTRY, validateRegistry, REGISTRY_VERSION } =
  await import(join(built, 'content', 'packs', 'parameters.js'));
const resources = await import(join(built, 'content', 'packs', 'resources.js'));

const errors = [];
const warnings = [];
const notes = [];
const fail = (where, message) => errors.push(`${where}: ${message}`);
const warn = (where, message) => warnings.push(`${where}: ${message}`);

const network = compileNetwork();
const nodeSymbols = new Set(network.nodes.map((node) => node.symbol));

/* ---------------------------------------------------------------- registry */

{
  const outcome = validateRegistry(PARAMETER_REGISTRY);
  for (const message of outcome.errors) fail('registry', message);
  for (const message of outcome.warnings) warn('registry', message);
  notes.push(`registry ${REGISTRY_VERSION}: ${PARAMETER_REGISTRY.length} parameters`);

  // A range rule that names a bound has to parse, or the server cannot enforce
  // it and the parameter is unconstrained in practice while appearing bounded.
  for (const record of PARAMETER_REGISTRY) {
    const { min, max } = record.bounds ?? {};
    if (min !== undefined && max !== undefined && min !== null && max !== null && min > max) {
      fail('registry', `${record.parameterId} has min ${min} above max ${max}.`);
    }
    if (
      typeof record.defaultValue === 'number' &&
      ((typeof min === 'number' && record.defaultValue < min) ||
        (typeof max === 'number' && record.defaultValue > max))
    ) {
      fail('registry', `${record.parameterId} default ${record.defaultValue} is outside its own bounds.`);
    }
  }
}

/* --------------------------------------------------------------- resources */

/*
 * "Measurable" means measured by the shipped case, not named in the marker
 * panel. A set is scored against whatever features a dataset carries, so the
 * only concrete statement available here is whether these resources work on the
 * data this lab ships with. On an upload the answer can differ, and the
 * baseline panel reports found-versus-missing members per run for that reason.
 */
const primaryCase = (() => {
  const path = join(contentRoot, 'case', 'sim-tme-primary.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
})();
const measured = new Set(
  (primaryCase ? decodeDataset(primaryCase).features : []).map((feature) => feature.symbol.toUpperCase()),
);

{
  notes.push(`resources ${resources.RESOURCE_VERSION}: ${resources.PATHWAY_SETS.length} pathway sets, ` +
    `${resources.STATE_SIGNATURES.length} signatures, ${resources.LIGAND_RECEPTOR_PAIRS.length} LR pairs`);

  for (const pair of resources.LIGAND_RECEPTOR_PAIRS) {
    const where = `resources/${pair.id}`;
    // Both halves must be measurable or the pair can never produce a score, and
    // an unusable pair in the list reads as a channel that was tested and found
    // quiet rather than one that was never scored.
    if (!measured.has(pair.ligand.toUpperCase())) {
      fail(where, `ligand ${pair.ligand} is not measured in the shipped case.`);
    }
    for (const subunit of pair.receptorSubunits) {
      if (!measured.has(subunit.toUpperCase())) {
        fail(where, `receptor subunit ${subunit} is not measured in the shipped case.`);
      }
    }
    if (pair.receptorSubunits.length === 0) fail(where, 'names no receptor subunit.');
    // The ligand has to be one the solver can actually transport, or the pair
    // is scored on co-expression alone while presenting as communication.
    const transported = network.signals.some((signal) => network.nodes[signal.ligand]?.symbol === pair.ligand);
    if (pair.mode === 'secreted' && !transported) {
      warn(where, `is secreted but ${pair.ligand} has no diffusion length in the network; it is scored at contact range.`);
    }
  }

  for (const set of [...resources.PATHWAY_SETS, ...resources.STATE_SIGNATURES]) {
    const where = `resources/${set.id}`;
    const members = Object.entries(set.members);
    const found = members.filter(([symbol]) => measured.has(symbol.toUpperCase()));
    if (members.length === 0) { fail(where, 'has no members.'); continue; }
    if (found.length === 0) {
      fail(where, 'has no member measured in the shipped case — it can only ever score zero.');
    } else if (found.length < 3) {
      warn(where, `has ${found.length} measurable member(s) of ${members.length}; a score over so few genes is noisy.`);
    }
    for (const [symbol, weight] of members) {
      if (!Number.isFinite(weight) || weight === 0) fail(where, `member ${symbol} has weight ${weight}.`);
    }
    if (!set.source || set.source.trim() === '') fail(where, 'names no source.');
  }

  const panel = resources.TUMOUR_MICROENVIRONMENT_PANEL;
  for (const [cellType, markers] of Object.entries(panel.positive)) {
    if (markers.length === 0) fail(`resources/${panel.id}`, `"${cellType}" has no positive marker.`);
    for (const marker of markers) {
      // A positive marker that is not measured makes the type unannotatable,
      // and the annotation then assigns those cells elsewhere rather than
      // reporting that it could not decide.
      if (!measured.has(marker.toUpperCase())) {
        fail(`resources/${panel.id}`, `positive marker ${marker} for "${cellType}" is not measured in the shipped case.`);
      }
    }
    const negatives = panel.negative?.[cellType] ?? [];
    for (const marker of negatives) {
      if (markers.includes(marker)) {
        fail(`resources/${panel.id}`, `${marker} is both a positive and a negative marker for "${cellType}".`);
      }
      if (!measured.has(marker.toUpperCase())) {
        warn(`resources/${panel.id}`, `negative marker ${marker} for "${cellType}" is not measured; that constraint is inert.`);
      }
    }
  }

  if (!resources.RESOURCE_PROVENANCE.circularityNote) {
    fail('resources', 'the circularity note is missing — §8 requires the simulated-data caveat to travel with the sets.');
  }
}

/* ----------------------------------------------------------- drug evidence */

{
  const path = join(contentRoot, 'packs', 'drug-evidence', 'chembl-snapshot.json');
  if (!existsSync(path)) {
    warn('drug-evidence', 'no snapshot — the drug branch will be unavailable.');
  } else {
    const pack = JSON.parse(readFileSync(path, 'utf8'));
    notes.push(`drug evidence ${pack.version}: ${pack.records.length} compounds, retrieved ${pack.retrievedAt}`);

    for (const record of pack.records) {
      const where = `drug-evidence/${record.prefName || record.name}`;
      const applied = record.curated.appliedToModelNode ?? record.target;

      // The join that matters. An unresolved target simulates as no effect.
      if (!applied || !nodeSymbols.has(applied)) {
        fail(where, `applies to "${applied}", which is not a node in the regulatory network.`);
      }

      if (record.curated.indirect) {
        if (!record.curated.appliedToModelNode) {
          fail(where, 'is marked indirect but names no node to apply the effect to.');
        }
        if (!record.curated.note && !record.curated.indirectNote) {
          fail(where, 'is marked indirect with no note saying what the potency was measured against.');
        }
        if (record.potency.measuredAgainst && record.potency.measuredAgainst === record.curated.appliedToModelNode) {
          fail(where, 'is marked indirect yet its potency target and applied node are the same.');
        }
      }

      const { medianNm, minNm, maxNm, measurements, types } = record.potency;
      if (medianNm === null) {
        // Allowed, and the loader refuses to simulate it — but it must be
        // declared, so a reader does not read silence as an absent problem.
        const declared = (pack.problems ?? []).some((problem) => problem.includes(record.prefName || record.name));
        if (!declared) {
          fail(where, 'has no potency and is not listed in the pack\'s problems.');
        }
      } else {
        if (!(medianNm > 0) || !Number.isFinite(medianNm)) fail(where, `median potency ${medianNm} is not a positive number.`);
        if (minNm > medianNm || maxNm < medianNm) fail(where, 'median potency falls outside the measured min/max.');
        if (!measurements || measurements < 1) fail(where, 'reports a potency with no measurement count behind it.');
        if (!types?.length) fail(where, 'reports a potency without saying what assay types it came from.');
        if (measurements < 5) warn(where, `median potency rests on ${measurements} measurement(s).`);
      }

      if (!record.curated.note) warn(where, 'has no note separating retrieved fields from curated ones.');
    }

    if (!pack.whatIsRetrievedVersusCurated) {
      fail('drug-evidence', 'does not state which fields are retrieved and which are curated.');
    }
  }
}

/* ------------------------------------------------------------------- cases */

{
  const caseDir = join(contentRoot, 'case');
  const files = existsSync(caseDir) ? readdirSync(caseDir).filter((name) => name.endsWith('.json')) : [];
  if (files.length === 0) fail('cases', 'no frozen cases — the lab has nothing to open.');

  const byId = new Map();
  for (const file of files) {
    const where = `case/${file}`;
    const frozen = JSON.parse(readFileSync(join(caseDir, file), 'utf8'));
    byId.set(frozen.caseId, frozen);

    const dataset = decodeDataset(frozen);

    // The checksum is what the reproducibility manifest cites. If it no longer
    // matches the bytes, every manifest that quotes it is wrong.
    const recomputed = contentHash({
      metadata: dataset.metadata,
      observations: dataset.observations,
      features: dataset.features,
      matrix: Array.from(dataset.matrix),
    });
    if (recomputed !== frozen.checksum) {
      fail(where, `checksum is ${frozen.checksum.slice(0, 12)} but the contents hash to ${recomputed.slice(0, 12)}.`);
    }

    const cells = dataset.observations.length;
    const genes = dataset.features.length;
    if (dataset.matrix.length !== cells * genes) {
      fail(where, `matrix is ${dataset.matrix.length} values for ${cells}×${genes}.`);
    }

    // The frozen hidden state is indexed by network node. A pack generated
    // against a different network silently misaligns every node.
    if (frozen.nodeCount !== network.nodes.length) {
      fail(where, `was frozen against ${frozen.nodeCount} network nodes; the network now has ${network.nodes.length}.`);
    }
    const symbols = frozen.nodeSymbols ?? [];
    const mismatch = symbols.findIndex((symbol, index) => network.nodes[index]?.symbol !== symbol);
    if (mismatch >= 0) {
      fail(where, `node ${mismatch} is "${symbols[mismatch]}" in the case and "${network.nodes[mismatch]?.symbol}" in the network.`);
    }

    for (const field of ['capacity', 'ligandReference', 'vesselDistance']) {
      if (!frozen[field]) { warn(where, `has no ${field}.`); continue; }
      const values = decodeToFloat64(frozen[field]);
      if (values.some((value) => !Number.isFinite(value))) {
        fail(where, `${field} contains a non-finite value.`);
      }
    }
    const reference = frozen.ligandReference ? decodeToFloat64(frozen.ligandReference) : null;
    if (reference && reference.some((value) => value <= 0)) {
      // A zero reference makes the log-ratio drive infinite for that signal;
      // the solver falls back to the section mean, but a frozen case should
      // never need the fallback.
      fail(where, 'ligandReference has a non-positive entry, which the solver would have to rescue at runtime.');
    }

    if (!frozen.simulationNotice) fail(where, 'carries no simulation notice; §1.5 requires simulated data to say so.');
    notes.push(`${frozen.caseId}: ${cells} cells × ${genes} genes, role ${frozen.role}`);
  }

  for (const [id, frozen] of byId) {
    for (const other of frozen.comparableWith ?? []) {
      if (!byId.has(other)) fail(`case/${id}`, `claims comparability with "${other}", which is not shipped.`);
    }
  }
}

/* ---------------------------------------------------------------- register */

{
  // The register is a client-side module: it is displayed, never served. Rather
  // than add it to the server build only so this check can import it, transpile
  // the one file here — it is plain data with no runtime imports.
  const ts = (await import('typescript')).default;
  const source = readFileSync(join(contentRoot, 'register.ts'), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const { IMPLEMENTATION_REGISTER, REGISTER_VERSION } = await import(
    `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`
  );
  notes.push(`register ${REGISTER_VERSION}: ${IMPLEMENTATION_REGISTER.length} rows`);
  const ids = new Set();
  for (const entry of IMPLEMENTATION_REGISTER) {
    if (ids.has(entry.id)) fail('register', `duplicate row id "${entry.id}".`);
    ids.add(entry.id);
    for (const field of ['section', 'capability', 'built', 'producedBy', 'dataLocation', 'evidence']) {
      if (!entry[field] || String(entry[field]).trim() === '') {
        fail('register', `row "${entry.id}" has an empty ${field}.`);
      }
    }
    if (entry.status !== 'implemented' && entry.evidence.length < 40) {
      // A row that says something is partial or absent has to say why at some
      // length; "not done" is not an account of itself.
      warn('register', `row "${entry.id}" is ${entry.status} with a very short explanation.`);
    }
  }
}

/* ------------------------------------------------------------- model pack */

{
  const packDir = join(contentRoot, 'packs', 'propagation-model');
  if (!existsSync(join(packDir, 'weights.json'))) {
    warn('model-pack', 'not installed — prediction, uncertainty and rescue will be unavailable.');
  } else {
    const weights = JSON.parse(readFileSync(join(packDir, 'weights.json'), 'utf8'));
    const card = existsSync(join(packDir, 'model-card.json'))
      ? JSON.parse(readFileSync(join(packDir, 'model-card.json'), 'utf8'))
      : null;

    if (!card) fail('model-pack', 'ships weights with no model card.');

    // The schema is a list of node symbols, not a count: a pack whose symbols
    // differ from the compiled network's is misaligned node by node, which
    // produces a plausible prediction about the wrong genes.
    const packSymbols = weights.schema?.nodeSymbols ?? [];
    if (packSymbols.length !== network.nodes.length) {
      fail('model-pack', `was trained against ${packSymbols.length} nodes; the network has ${network.nodes.length}.`);
    } else {
      const mismatch = packSymbols.findIndex((symbol, index) => network.nodes[index]?.symbol !== symbol);
      if (mismatch >= 0) {
        fail('model-pack', `node ${mismatch} is "${packSymbols[mismatch]}" in the pack and "${network.nodes[mismatch]?.symbol}" in the network.`);
      }
    }
    if (!weights.members?.length) fail('model-pack', 'has no ensemble members.');

    for (const member of weights.members ?? []) {
      // Recomputed the way the serialiser computes it, over config and tensors
      // only — the checksum cannot cover itself, and the format tag is not part
      // of what it attests to.
      const recomputed = contentHash({ config: member.config, tensors: member.tensors });
      if (member.checksum && member.checksum !== recomputed) {
        fail('model-pack', `a member's checksum does not match its weights (${String(member.checksum).slice(0, 8)}).`);
      }
    }

    if (card) {
      if (!card.whatTheMetricsMean) {
        fail('model-pack', 'the card does not say what its metrics mean — the one thing it must not omit.');
      }
      /*
       * §14.3's seven minimum baselines, as this pack defines them: a floor
       * (zero propagation), two graph-free models, a graph control with the
       * edges permuted, two single-edge-type ablations, and the model.
       *
       * The permuted control is the one that must never be dropped — without
       * it there is no way to tell message passing from neighbourhood
       * averaging, and the card's own limitations quote the gap between them.
       */
      const baselines = Object.keys(card.metrics ?? {});
      const required = ['zero', 'linear', 'mlp', 'gnn-shuffled', 'gnn-no-biological', 'gnn-no-spatial', 'gnn'];
      for (const name of required) {
        if (!baselines.includes(name)) fail('model-pack', `the card is missing the §14.3 baseline "${name}".`);
      }
      const gnn = card.metrics?.gnn;
      for (const rival of ['zero', 'linear', 'mlp', 'gnn-shuffled', 'gnn-no-biological', 'gnn-no-spatial']) {
        const other = card.metrics?.[rival];
        if (gnn && other && typeof gnn.firstNeighbourR2 === 'number' && typeof other.firstNeighbourR2 === 'number') {
          if (gnn.firstNeighbourR2 <= other.firstNeighbourR2) {
            // Not an error: shipping a model that fails its own baselines is a
            // decision, but it must not be an accident.
            warn(
              'model-pack',
              `"${rival}" matches or beats the model on firstNeighbourR2 ` +
                `(${other.firstNeighbourR2.toFixed(3)} vs ${gnn.firstNeighbourR2.toFixed(3)}).`,
            );
          }
        }
      }
      /*
       * A pack from before the domain reference learned to drop constant
       * features. Its distances were computed with a unit-variance floor, so
       * every real run scored as out-of-domain for an arithmetic reason. The
       * numbers in such a pack are not repairable in place — the excluded set
       * cannot be recovered, because a floored standard deviation of 1 is
       * indistinguishable from a real one — so the pack has to be rebuilt.
       */
      if (!Array.isArray(card.uncertainty?.domain?.excludedFeatures)) {
        fail(
          'model-pack',
          'its domain reference predates the constant-feature exclusion, so its out-of-domain distances are not ' +
            'trustworthy. Rebuild the pack with `SPATIAL_JOB=combine npm run model:train`.',
        );
      }

      if (card.split?.leakage && card.split.leakage !== 'clean') {
        fail('model-pack', `the card reports a ${card.split.leakage} split; §14.4 requires section-level separation.`);
      }
    }
  }
}

/* ------------------------------------------------------------------ report */

for (const note of notes) process.stdout.write(`  ${note}\n`);
if (warnings.length) {
  process.stdout.write(`\n${warnings.length} warning(s):\n`);
  for (const message of warnings) process.stdout.write(`  ! ${message}\n`);
}
if (errors.length) {
  process.stdout.write(`\n${errors.length} error(s):\n`);
  for (const message of errors) process.stdout.write(`  ✗ ${message}\n`);
  process.stdout.write('\ncontent validation FAILED\n');
  process.exit(1);
}
process.stdout.write(`\ncontent validation passed (${warnings.length} warning(s))\n`);
