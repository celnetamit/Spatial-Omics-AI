/**
 * Loads and validates everything the server serves science from: the frozen
 * demonstration cases, the propagation model pack, the drug evidence snapshot
 * and the curated resource packs.
 *
 * Validation happens at startup and a pack that fails it is *dropped*, not
 * served with a warning. The precedent is the one LogicLab records: a lab that
 * serves content it knows is broken produces results nobody can act on, and the
 * failure surfaces days later as a confusing number rather than immediately as
 * a missing feature. A missing feature is the better failure.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { decodeDataset, decodeState, decodeToFloat64, type FrozenCase, type DecodedCaseState } from '@engine/data/caseFormat';
import type { SpatialDataset } from '@engine/data/types';
import { compileNetwork, type CompiledNetwork } from '@engine/propagate/network';
import { deserialiseWeights, type GnnWeights } from '@engine/propagate/gnn';
import type { FeatureSchema } from '@engine/propagate/features';
import type { DomainReference, CalibrationSummary } from '@engine/uncertainty/index';
import { PARAMETER_REGISTRY, validateRegistry, REGISTRY_VERSION } from '../../../content/packs/parameters';
import {
  LIGAND_RECEPTOR_PAIRS, PATHWAY_SETS, RESOURCE_PROVENANCE, RESOURCE_VERSION,
  STATE_SIGNATURES, TUMOUR_MICROENVIRONMENT_PANEL,
} from '../../../content/packs/resources';

export interface LoadedCase {
  caseId: string;
  title: string;
  description: string;
  simulationNotice: string;
  role: 'primary' | 'reference';
  comparableWith: string[];
  dataset: SpatialDataset;
  state: DecodedCaseState;
  cellTypes: string[];
  regions: string[];
  vesselDistance: Float64Array;
  spec: FrozenCase['spec'];
  generatedAt: string;
}

export interface LoadedModelPack {
  modelId: string;
  version: string;
  schema: FeatureSchema;
  members: GnnWeights[];
  card: ModelCard;
  weightsChecksum: string;
}

export interface ModelCard {
  modelId: string;
  version: string;
  createdAt: string;
  architecture: Record<string, unknown>;
  trainingData: Record<string, unknown>;
  whatTheMetricsMean: string;
  metrics: Record<string, Record<string, unknown>>;
  baselineNotes: Record<string, string>;
  uncertainty: {
    method: string;
    calibration: CalibrationSummary;
    dispersionThreshold: number;
    domain: DomainReference;
  };
  trainingHistory: unknown[];
  limitations: string[];
}

export interface DrugRecord {
  drugId: string;
  name: string;
  prefName: string;
  moleculeType: string;
  maxPhase: string | number | null;
  firstApproval: number | null;
  atc: string[];
  smiles: string | null;
  target: string;
  targetUniprot: string;
  targetChemblId: string;
  targetName: string;
  targetOrganism: string;
  curated: {
    actionType: 'inhibitor' | 'agonist' | 'antagonist' | 'degrader' | 'other';
    therapyClass: 'small-molecule' | 'antibody' | 'biologic' | 'cell-therapy' | 'genetic';
    mechanism: string;
    indirect: boolean;
    note: string;
  };
  potency: {
    medianNm: number | null;
    measurements: number;
    types: string[];
    testedRangeNm: [number, number] | null;
    minNm: number | null;
    maxNm: number | null;
    rangeBasis: string;
  };
  evidence: {
    source: string;
    targetQuery: string;
    activityQuery: string;
    documentCount: number;
    documents: string[];
    exampleAssays: { id: string; description: string }[];
    retrievedAt: string;
  };
}

export interface DrugEvidencePack {
  packId: string;
  version: string;
  retrievedAt: string;
  source: { database: string; api: string; licence: string; citation: string };
  whatIsRetrievedVersusCurated: string;
  records: DrugRecord[];
  problems: string[];
}

export interface Catalogue {
  network: CompiledNetwork;
  cases: Map<string, LoadedCase>;
  modelPack: LoadedModelPack | null;
  drugEvidence: DrugEvidencePack | null;
  resources: {
    version: string;
    pathways: typeof PATHWAY_SETS;
    states: typeof STATE_SIGNATURES;
    markerPanel: typeof TUMOUR_MICROENVIRONMENT_PANEL;
    ligandReceptor: typeof LIGAND_RECEPTOR_PAIRS;
    provenance: typeof RESOURCE_PROVENANCE;
  };
  parameters: { version: string; records: typeof PARAMETER_REGISTRY };
  problems: { severity: 'error' | 'warning'; component: string; message: string }[];
}

export function loadCatalogue(contentRoot: string): Catalogue {
  const problems: Catalogue['problems'] = [];
  const network = compileNetwork();

  // -- parameter registry --------------------------------------------------

  const registry = validateRegistry();
  for (const error of registry.errors) {
    problems.push({ severity: 'error', component: 'parameter-registry', message: error });
  }
  for (const warning of registry.warnings) {
    problems.push({ severity: 'warning', component: 'parameter-registry', message: warning });
  }

  // -- cases ---------------------------------------------------------------

  const cases = new Map<string, LoadedCase>();
  const caseDir = join(contentRoot, 'case');
  if (existsSync(caseDir)) {
    for (const name of readdirSync(caseDir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const frozen = JSON.parse(readFileSync(join(caseDir, name), 'utf8')) as FrozenCase;
        if (frozen.format !== 'spatial-case-v1') {
          problems.push({ severity: 'error', component: `case:${name}`, message: `Unknown case format "${frozen.format}".` });
          continue;
        }

        /*
         * The case's node list has to match the compiled network exactly.
         *
         * The stored activity state is indexed by node position, so a case
         * frozen against an earlier network and loaded against a later one
         * would read every gene's activity from the wrong column — and produce
         * a perfectly plausible tissue in which nothing means what it says.
         * This is why the symbols are stored rather than only the count.
         */
        const expected = network.nodes.map((node) => node.symbol);
        if (frozen.nodeSymbols.length !== expected.length ||
            frozen.nodeSymbols.some((symbol, index) => symbol !== expected[index])) {
          problems.push({
            severity: 'error',
            component: `case:${frozen.caseId}`,
            message:
              `Node list does not match the compiled network (case has ${frozen.nodeSymbols.length}, network has ${expected.length}). ` +
              'The case was frozen against a different network version and must be regenerated with `npm run case:generate`.',
          });
          continue;
        }

        const dataset = decodeDataset(frozen);
        const state = decodeState(frozen);

        cases.set(frozen.caseId, {
          caseId: frozen.caseId,
          title: frozen.title,
          description: frozen.description,
          simulationNotice: frozen.simulationNotice,
          role: frozen.role,
          comparableWith: frozen.comparableWith,
          dataset,
          state,
          cellTypes: frozen.cellTypes,
          regions: frozen.regions,
          vesselDistance: decodeToFloat64(frozen.vesselDistance),
          spec: frozen.spec,
          generatedAt: frozen.generatedAt,
        });
      } catch (error) {
        problems.push({
          severity: 'error',
          component: `case:${name}`,
          message: `Could not read: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  } else {
    problems.push({
      severity: 'error',
      component: 'cases',
      message: `No case directory at ${caseDir}. Run \`npm run case:generate\`.`,
    });
  }

  // -- model pack ----------------------------------------------------------

  let modelPack: LoadedModelPack | null = null;
  const modelDir = join(contentRoot, 'packs', 'propagation-model');
  const weightsPath = join(modelDir, 'weights.json');
  const cardPath = join(modelDir, 'model-card.json');
  if (existsSync(weightsPath) && existsSync(cardPath)) {
    try {
      const raw = JSON.parse(readFileSync(weightsPath, 'utf8')) as {
        modelId: string; version: string;
        schema: { nodeSymbols: string[]; cellClasses: string[]; targetScale: number[]; version: string };
        members: Parameters<typeof deserialiseWeights>[0][];
      };
      const card = JSON.parse(readFileSync(cardPath, 'utf8')) as ModelCard;

      const expected = network.nodes.map((node) => node.symbol);
      if (raw.schema.nodeSymbols.some((symbol, index) => symbol !== expected[index])) {
        problems.push({
          severity: 'error',
          component: 'model-pack',
          message:
            'The model pack’s feature schema does not match the compiled network. Predictions would read the wrong columns. ' +
            'Retrain with `npm run model:train`.',
        });
      } else {
        const members = raw.members.map((member) => deserialiseWeights(member));
        modelPack = {
          modelId: raw.modelId,
          version: raw.version,
          schema: {
            nodeSymbols: raw.schema.nodeSymbols,
            cellClasses: raw.schema.cellClasses,
            targetScale: Float64Array.from(raw.schema.targetScale),
            version: raw.schema.version,
          },
          members,
          card,
          weightsChecksum: raw.members.map((m) => m.checksum).join('/'),
        };
        if (members.length < 2) {
          problems.push({
            severity: 'warning',
            component: 'model-pack',
            message: `Only ${members.length} ensemble member(s); uncertainty cannot be estimated from disagreement and every prediction will be capped at exploratory confidence.`,
          });
        }
      }
    } catch (error) {
      problems.push({
        severity: 'error',
        component: 'model-pack',
        message: `Could not load: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  } else {
    problems.push({
      severity: 'warning',
      component: 'model-pack',
      message:
        `No propagation model pack at ${modelDir}. Baseline analysis and the direct response are available; spatial propagation ` +
        'is not, and the lab will say so rather than substituting anything. Train one with `npm run model:train`.',
    });
  }

  // -- drug evidence -------------------------------------------------------

  let drugEvidence: DrugEvidencePack | null = null;
  const evidencePath = join(contentRoot, 'packs', 'drug-evidence', 'chembl-snapshot.json');
  if (existsSync(evidencePath)) {
    try {
      drugEvidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as DrugEvidencePack;
      const withoutPotency = drugEvidence.records.filter((r) => r.potency.medianNm === null);
      if (withoutPotency.length > 0) {
        problems.push({
          severity: 'warning',
          component: 'drug-evidence',
          message:
            `${withoutPotency.length} compound(s) have no usable potency measurement and cannot be simulated: ` +
            `${withoutPotency.map((r) => r.name).join(', ')}. They stay in the catalogue as excluded candidates with that reason.`,
        });
      }
    } catch (error) {
      problems.push({
        severity: 'error',
        component: 'drug-evidence',
        message: `Could not load: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  } else {
    problems.push({
      severity: 'warning',
      component: 'drug-evidence',
      message:
        `No drug evidence pack at ${evidencePath}. The drug perturbation branch and the rescue candidate engine are ` +
        'unavailable; the molecular/genetic branch still works. Fetch one with `npm run evidence:fetch`.',
    });
  }

  return {
    network,
    cases,
    modelPack,
    drugEvidence,
    resources: {
      version: RESOURCE_VERSION,
      pathways: PATHWAY_SETS,
      states: STATE_SIGNATURES,
      markerPanel: TUMOUR_MICROENVIRONMENT_PANEL,
      ligandReceptor: LIGAND_RECEPTOR_PAIRS,
      provenance: RESOURCE_PROVENANCE,
    },
    parameters: { version: REGISTRY_VERSION, records: PARAMETER_REGISTRY },
    problems,
  };
}

/** What a client may know about a case before it opens one. */
export function publicCaseSummary(loaded: LoadedCase): Record<string, unknown> {
  return {
    caseId: loaded.caseId,
    title: loaded.title,
    description: loaded.description,
    simulationNotice: loaded.simulationNotice,
    role: loaded.role,
    comparableWith: loaded.comparableWith,
    observations: loaded.dataset.observations.length,
    features: loaded.dataset.features.length,
    organism: loaded.dataset.metadata.organism,
    tissue: loaded.dataset.metadata.tissue,
    condition: loaded.dataset.metadata.condition,
    assay: loaded.dataset.metadata.assay,
    platform: loaded.dataset.metadata.platform,
    resolution: loaded.dataset.metadata.resolution,
    coordinateUnit: loaded.dataset.metadata.coordinateUnit,
    licence: loaded.dataset.metadata.licence,
    accessStatus: loaded.dataset.metadata.accessStatus,
    origin: loaded.dataset.metadata.origin,
    checksum: loaded.dataset.checksum,
    revision: loaded.dataset.revision,
    generatedAt: loaded.generatedAt,
    cellTypes: [...new Set(loaded.cellTypes)].sort(),
    regions: [...new Set(loaded.regions)].sort(),
  };
}
