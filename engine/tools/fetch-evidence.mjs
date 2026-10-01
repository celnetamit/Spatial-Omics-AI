/**
 * Retrieves the drug evidence pack from ChEMBL and writes it to
 * content/packs/drug-evidence/.
 *
 *   npm run evidence:fetch
 *
 * WHY THIS IS A SCRIPT AND NOT A LIVE CALL
 *
 * §16.1 requires the evidence version to be part of the reproducibility
 * manifest, and §5.4 requires that parameters cannot change silently after a
 * run begins. A lab that queried ChEMBL at run time would give two different
 * answers a month apart with no record of which one a stored report was based
 * on. So the pack is fetched, frozen, committed and versioned, and every run
 * names the snapshot it used.
 *
 * WHAT IS RETRIEVED AND WHAT IS CURATED
 *
 * Retrieved from ChEMBL: the molecule record, the target record (resolved by
 * UniProt accession), and every IC50/Ki/EC50 measurement against that target,
 * with its assay description and source document. The potency used by the lab
 * is the *median* of those, and the tested range is their observed span — so a
 * concentration outside it is refused as an extrapolation (§5.3).
 *
 * Curated here, and marked as such in the pack: the action type
 * (inhibitor/agonist/degrader) and the therapy class. ChEMBL's mechanism
 * endpoint was not reliably reachable when this was written, and guessing an
 * action type from an IC50 is not possible — an IC50 says how tightly
 * something binds, not what it does. These are textbook pharmacology and each
 * carries a note saying it was curated rather than retrieved.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const BASE = 'https://www.ebi.ac.uk/chembl/api/data';

/**
 * The compounds the pack covers.
 *
 * Every one targets a node in the curated network, because a drug whose target
 * the model cannot see is a drug the lab has to refuse — and a handful of those
 * are included on purpose, so the eligibility rules of §6.17 are visibly doing
 * something rather than passing everything.
 */
const CATALOGUE = [
  { name: 'ERLOTINIB', target: 'EGFR', uniprot: 'P00533', action: 'inhibitor', class: 'small-molecule',
    mechanism: 'Reversible ATP-competitive EGFR tyrosine kinase inhibitor.' },
  { name: 'GEFITINIB', target: 'EGFR', uniprot: 'P00533', action: 'inhibitor', class: 'small-molecule',
    mechanism: 'Reversible ATP-competitive EGFR tyrosine kinase inhibitor.' },
  { name: 'OSIMERTINIB', target: 'EGFR', uniprot: 'P00533', action: 'inhibitor', class: 'small-molecule',
    mechanism: 'Irreversible third-generation EGFR inhibitor, covalent at Cys797.' },
  { name: 'TRAMETINIB', target: 'MAP2K1', uniprot: 'Q02750', action: 'inhibitor', class: 'small-molecule',
    mechanism: 'Allosteric MEK1/2 inhibitor.' },
  { name: 'SELUMETINIB', target: 'MAP2K1', uniprot: 'Q02750', action: 'inhibitor', class: 'small-molecule',
    mechanism: 'Allosteric MEK1/2 inhibitor.' },
  { name: 'VEMURAFENIB', target: 'BRAF', uniprot: 'P15056', action: 'inhibitor', class: 'small-molecule',
    mechanism: 'ATP-competitive inhibitor of BRAF V600E.' },
  { name: 'DABRAFENIB', target: 'BRAF', uniprot: 'P15056', action: 'inhibitor', class: 'small-molecule',
    mechanism: 'ATP-competitive inhibitor of BRAF V600E.' },
  { name: 'SIROLIMUS', target: 'MTOR', uniprot: 'P42345', action: 'inhibitor', class: 'small-molecule',
    mechanism: 'Allosteric mTORC1 inhibitor acting through FKBP12.' },
  { name: 'EVEROLIMUS', target: 'MTOR', uniprot: 'P42345', action: 'inhibitor', class: 'small-molecule',
    mechanism: 'Allosteric mTORC1 inhibitor acting through FKBP12.' },
  { name: 'ALPELISIB', target: 'PIK3CA', uniprot: 'P42336', action: 'inhibitor', class: 'small-molecule',
    mechanism: 'PI3K alpha-selective inhibitor.' },
  { name: 'CAPIVASERTIB', target: 'AKT1', uniprot: 'P31749', action: 'inhibitor', class: 'small-molecule',
    mechanism: 'ATP-competitive pan-AKT inhibitor.' },
  { name: 'GALUNISERTIB', target: 'TGFBR1', uniprot: 'P36897', action: 'inhibitor', class: 'small-molecule',
    mechanism: 'ATP-competitive inhibitor of the TGF-beta receptor I kinase (ALK5).' },
  { name: 'PALBOCICLIB', target: 'CDK4', uniprot: 'P11802', action: 'inhibitor', class: 'small-molecule',
    mechanism: 'Selective CDK4/6 inhibitor.' },
  { name: 'RIBOCICLIB', target: 'CDK4', uniprot: 'P11802', action: 'inhibitor', class: 'small-molecule',
    mechanism: 'Selective CDK4/6 inhibitor.' },
  { name: 'VENETOCLAX', target: 'BCL2', uniprot: 'P10415', action: 'inhibitor', class: 'small-molecule',
    mechanism: 'Selective BH3-mimetic BCL-2 inhibitor.' },
  { name: 'AXITINIB', target: 'KDR', uniprot: 'P35968', action: 'inhibitor', class: 'small-molecule',
    mechanism: 'Selective VEGFR1/2/3 tyrosine kinase inhibitor.' },
  { name: 'SUNITINIB', target: 'KDR', uniprot: 'P35968', action: 'inhibitor', class: 'small-molecule',
    mechanism: 'Multi-targeted receptor tyrosine kinase inhibitor.' },
  { name: 'PLERIXAFOR', target: 'CXCR4', uniprot: 'P61073', action: 'antagonist', class: 'small-molecule',
    mechanism: 'Reversible CXCR4 antagonist.' },
  { name: 'RUXOLITINIB', target: 'STAT3', uniprot: 'O60674', action: 'inhibitor', class: 'small-molecule',
    mechanism: 'JAK1/2 inhibitor. STAT3 is not its binding target: JAK2 is, and STAT3 activity falls because JAK phosphorylates it.',
    indirect: true,
    indirectNote:
      'The potency below is measured against JAK2 (UniProt O60674), which is the molecule this compound binds. It is applied to ' +
      'the STAT3 node because STAT3 is the immediately downstream effector the model represents. That step is an inference, not a ' +
      'measurement: the relationship between JAK2 occupancy and STAT3 activity is not 1:1 and is not characterised here.' },
  // Deliberately included and expected to be excluded: §1.4 makes antibody and
  // biologic packs conditional on a separate validated mechanistic model, and
  // none ships here. A catalogue with no refusals in it teaches nothing about
  // the eligibility rules.
  { name: 'BEVACIZUMAB', target: 'VEGFA', uniprot: 'P15692', action: 'antagonist', class: 'antibody',
    mechanism: 'Humanised monoclonal antibody sequestering VEGF-A.' },
  { name: 'TOCILIZUMAB', target: 'IL6R', uniprot: 'P08887', action: 'antagonist', class: 'antibody',
    mechanism: 'Humanised monoclonal antibody against the IL-6 receptor.' },
  { name: 'ATEZOLIZUMAB', target: 'CD274', uniprot: 'Q9NZQ7', action: 'antagonist', class: 'antibody',
    mechanism: 'Monoclonal antibody blocking PD-L1.' },
  { name: 'INFLIXIMAB', target: 'TNF', uniprot: 'P01375', action: 'antagonist', class: 'antibody',
    mechanism: 'Chimeric monoclonal antibody neutralising TNF-alpha.' },
];

const RETRIEVED_AT = new Date().toISOString();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/*
 * Politeness, and why it is not optional.
 *
 * The first version of this fired four requests per compound back to back and
 * ChEMBL answered with a wall of HTTP 500s from the fourth compound onward — not
 * a refusal of the query, a refusal of the *rate*. A public API that many
 * groups share is not a resource to hammer, and a snapshot that is half
 * missing because of it is worse than one that took ten minutes.
 *
 * So: a fixed gap between requests, exponential backoff with jitter on a
 * failure, and the pack written after every compound so an interrupted run
 * resumes instead of starting over.
 */
const REQUEST_GAP_MS = 900;
let lastRequestAt = 0;

async function getJson(url, attempts = 5) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const sinceLast = Date.now() - lastRequestAt;
    if (sinceLast < REQUEST_GAP_MS) await sleep(REQUEST_GAP_MS - sinceLast);
    lastRequestAt = Date.now();
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': 'spatial-omics-livelab-evidence-fetch/1.0' },
        signal: AbortSignal.timeout(90_000),
      });
      if (response.ok) return await response.json();
      if (response.status === 404) return null;
      process.stderr.write(`  ${response.status} on ${short(url)} (attempt ${attempt})\n`);
    } catch (error) {
      process.stderr.write(`  ${String(error).slice(0, 80)} on ${short(url)} (attempt ${attempt})\n`);
    }
    // Jittered backoff: a fixed one would make several clients retry in step.
    await sleep(2000 * attempt + Math.random() * 1500);
  }
  return null;
}

function short(url) {
  return url.replace(BASE, '').slice(0, 90);
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function quantile(values, q) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] * (upper - position) + sorted[upper] * (position - lower);
}

const outputDir = join(root, 'content', 'packs', 'drug-evidence');
const outputPath = join(outputDir, 'chembl-snapshot.json');
mkdirSync(outputDir, { recursive: true });

// Resume: a compound already in the snapshot is not fetched again. Delete the
// file to force a full refresh.
//
// `fetchProblems` holds only the failures that produce no record at all — no
// molecule, no target. Everything derivable from a record is derived at write
// time instead, because a carried-over list goes stale exactly here: on resume
// the compound is skipped, its problem line is never re-pushed, and the pack
// ends up with a record that has no potency and no declaration that it has
// none. Bevacizumab reached the shipped snapshot that way.
let records = [];
let fetchProblems = [];
if (existsSync(outputPath)) {
  try {
    const previous = JSON.parse(readFileSync(outputPath, 'utf8'));
    records = previous.records ?? [];
    fetchProblems = (previous.problems ?? []).filter((problem) => /no ChEMBL (molecule record|target)/.test(problem));
    process.stdout.write(`resuming: ${records.length} record(s) already present\n`);
  } catch {
    process.stdout.write('existing snapshot is unreadable; starting over\n');
  }
}
const have = new Set(records.map((record) => record.name));

/**
 * Every problem the pack has, recomputed from what it contains.
 *
 * A record with no usable potency is a problem whether or not this run is the
 * one that fetched it, so it is stated here rather than remembered.
 */
function allProblems() {
  const derived = records
    .filter((record) => record.potency.medianNm === null)
    .map((record) => `${record.prefName || record.name}: no usable potency measurement against ${record.targetChemblId}.`);
  return [...new Set([...derived, ...fetchProblems])];
}

function writeSnapshot() {
  writeFileSync(
    outputPath,
    JSON.stringify(
      {
        packId: 'drug-evidence-chembl',
        version: '1.0.0',
        retrievedAt: RETRIEVED_AT,
        source: {
          database: 'ChEMBL',
          api: BASE,
          licence: 'ChEMBL data is available under CC BY-SA 3.0.',
          citation:
            'Zdrazil B, Felix E, Hunter F, et al. The ChEMBL Database in 2023. Nucleic Acids Research 2024;52:D1180-D1192. doi:10.1093/nar/gkad1004',
        },
        whatIsRetrievedVersusCurated:
          'Molecule records, target records and potency measurements are retrieved verbatim from ChEMBL. ' +
          'Action type, therapy class and mechanism descriptions are curated and are marked as such on every record.',
        records,
        problems: allProblems(),
      },
      null,
      2,
    ),
  );
}

for (const entry of CATALOGUE) {
  if (have.has(entry.name)) {
    process.stdout.write(`${entry.name} — already present, skipping\n`);
    continue;
  }
  process.stdout.write(`${entry.name} -> ${entry.target} (${entry.uniprot})\n`);

  const moleculeResult = await getJson(`${BASE}/molecule.json?pref_name__iexact=${encodeURIComponent(entry.name)}&limit=1`);
  const molecule = moleculeResult?.molecules?.[0];
  if (!molecule) {
    fetchProblems.push(`${entry.name}: no ChEMBL molecule record.`);
    continue;
  }

  const targetResult = await getJson(`${BASE}/target.json?target_components__accession=${entry.uniprot}&limit=5`);
  const target = (targetResult?.targets ?? []).find(
    (t) => t.target_type === 'SINGLE PROTEIN' && t.organism === 'Homo sapiens',
  ) ?? targetResult?.targets?.[0];
  if (!target) {
    fetchProblems.push(`${entry.name}: no ChEMBL target for ${entry.uniprot}.`);
    continue;
  }

  // Every potency measurement against this target, in nM.
  const measurements = [];
  const documents = new Set();
  const assays = [];
  // IC50 and Ki only. EC50 and Kd added two requests per compound for a handful
  // of extra measurements, and the request count is what the API objects to.
  for (const type of ['IC50', 'Ki']) {
    const activities = await getJson(
      `${BASE}/activity.json?molecule_chembl_id=${molecule.molecule_chembl_id}` +
        `&target_chembl_id=${target.target_chembl_id}&standard_type=${type}&standard_units=nM&limit=250`,
    );
    for (const activity of activities?.activities ?? []) {
      const value = Number(activity.standard_value);
      if (!Number.isFinite(value) || value <= 0) continue;
      // `standard_relation` of '>' or '<' means the assay did not resolve the
      // value; treating a ">10000" as 10000 would make an inactive compound
      // look like a weak one.
      if (activity.standard_relation && activity.standard_relation !== '=') continue;
      measurements.push({ type, value, assay: activity.assay_chembl_id, document: activity.document_chembl_id });
      if (activity.document_chembl_id) documents.add(activity.document_chembl_id);
      if (assays.length < 6 && activity.assay_description) {
        assays.push({ id: activity.assay_chembl_id, description: activity.assay_description });
      }
    }
  }

  const values = measurements.map((m) => m.value);
  const potency = median(values);

  /*
   * The "tested range" is the 10th to 90th percentile of the measurements, not
   * their min and max.
   *
   * ChEMBL aggregates assays of very different kinds, and the extremes are
   * usually a single outlying biochemical assay at 0.1 nM or a cell viability
   * readout at 50 µM. Using them as the supported range would let a run sit
   * five orders of magnitude from where the evidence actually is and still
   * count as in-range, which is precisely the extrapolation §5.3 disables.
   */
  const rangeLow = quantile(values, 0.1);
  const rangeHigh = quantile(values, 0.9);

  records.push({
    drugId: molecule.molecule_chembl_id,
    name: entry.name,
    prefName: molecule.pref_name,
    moleculeType: molecule.molecule_type,
    maxPhase: molecule.max_phase,
    firstApproval: molecule.first_approval ?? null,
    atc: molecule.atc_classifications ?? [],
    smiles: molecule.molecule_structures?.canonical_smiles ?? null,

    target: entry.target,
    targetUniprot: entry.uniprot,
    targetChemblId: target.target_chembl_id,
    targetName: target.pref_name,
    targetOrganism: target.organism,

    curated: {
      actionType: entry.action,
      therapyClass: entry.class,
      mechanism: entry.mechanism,
      /*
       * `indirect` means the potency is against a different molecule from the
       * model node it is applied to.
       *
       * Ruxolitinib is the case that forced this field. Its ChEMBL potency is
       * against JAK2; the model has no JAK2 node, and the effect it represents
       * is on STAT3. Recording it as "target: STAT3, IC50 2.8 nM" without
       * saying so would assert a measurement against STAT3 that nobody made.
       */
      indirect: entry.indirect ?? false,
      indirectNote: entry.indirectNote ?? null,
      /** The molecule the potency was actually measured against. */
      potencyMeasuredAgainst: { name: target.pref_name, uniprot: entry.uniprot, chemblId: target.target_chembl_id },
      /** The model node the effect is applied to. */
      appliedToModelNode: entry.target,
      note:
        'Action type, therapy class and mechanism text are curated from standard pharmacology, not retrieved. ' +
        'A potency measurement says how tightly a compound binds, not what binding does, so these cannot be derived from the activity records below.',
    },

    potency: {
      medianNm: potency,
      measurements: values.length,
      types: [...new Set(measurements.map((m) => m.type))],
      testedRangeNm: rangeLow !== null && rangeHigh !== null ? [rangeLow, rangeHigh] : null,
      minNm: values.length ? Math.min(...values) : null,
      maxNm: values.length ? Math.max(...values) : null,
      rangeBasis: values.length
        ? '10th to 90th percentile of the retrieved measurements; the extremes are single assays of unlike kinds.'
        : null,
    },

    evidence: {
      source: 'ChEMBL',
      targetQuery: `${BASE}/target.json?target_components__accession=${entry.uniprot}`,
      activityQuery: `${BASE}/activity.json?molecule_chembl_id=${molecule.molecule_chembl_id}&target_chembl_id=${target.target_chembl_id}`,
      documentCount: documents.size,
      documents: [...documents].slice(0, 25),
      exampleAssays: assays,
      retrievedAt: RETRIEVED_AT,
    },
  });

  // Written after every compound, so an interrupted run resumes.
  writeSnapshot();
  process.stdout.write(`  ${values.length} measurement(s), median ${potency === null ? 'n/a' : potency.toPrecision(3)} nM\n`);
}

writeSnapshot();

process.stdout.write(`\nwrote ${records.length} record(s) to ${outputPath}\n`);
const finalProblems = allProblems();
if (finalProblems.length > 0) process.stdout.write(`problems:\n  ${finalProblems.join('\n  ')}\n`);
