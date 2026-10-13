/**
 * Projects, perturbation definitions and run submission — §10.1.
 *
 * The state machine of §10.3 is derived, not set: a handler completes a stage
 * and the project's state follows from which stages have completed. That is
 * why there is no `PATCH /projects/:id/state` here, and why there cannot be.
 */

import type { FastifyInstance } from 'fastify';
import { config } from '../config';
import { ingestTabular, unsupportedFormatGuidance, type SourceFile } from '@engine/data/ingest';
import { metadataFromUpload, publicUploadedSummary, writeUploadedDataset } from '../uploadedDatasets';
import { modeLock } from '../auth';
import { deriveState, stageIsRunnable, STAGE_TITLE, type StageId } from '@engine/pipeline';
import {
  assessEligibility, createDefinition, resolveSelection, toNanomolar,
} from '@engine/perturb/index';
import { OPERATOR_LABEL, OPERATOR_SEMANTICS, type DrugPerturbation, type MolecularOperator, type MolecularPerturbation, type PerturbationSpec } from '@engine/perturb/types';
import type { LabMode, Store } from '../store';
import type { Services } from './index';
import {
  fail, modeProgress, queryString, requireCapability, requireOwnership, requireSession, type Sessions,
} from './shared';
import { submitRun } from '../jobs/runner';

interface ProjectBody {
  title?: string;
  organism?: string;
  tissue?: string;
  condition?: string;
  studyQuestion?: string;
  mode?: LabMode;
  caseId?: string;
  referenceCaseId?: string | null;
}

export async function registerProjectRoutes(
  app: FastifyInstance,
  services: Services,
  sessions: Sessions,
): Promise<void> {
  const { store, catalogue } = services;

  // -- create / list --------------------------------------------------------

  app.post<{ Body: ProjectBody }>('/api/v1/projects', async (request, reply) => {
    const session = requireSession(request, reply, sessions);
    if (!session) return reply;
    if (!requireCapability(reply, session.identity, 'open-project')) return reply;

    const body = request.body ?? {};
    const fieldErrors: { field: string; message: string }[] = [];
    const title = (body.title ?? '').trim();
    if (!title) fieldErrors.push({ field: 'title', message: 'A project title is required.' });

    const mode: LabMode = body.mode === 'moderate' || body.mode === 'expert' ? body.mode : 'basic';
    const lock = modeLock(session.identity, mode, modeProgress(store, session.identity.userId));
    if (lock) {
      return fail(
        reply,
        403,
        'TIER_REQUIRED',
        lock,
        {
          suggestedAction:
            'Beginner and Intermediate produce the same numbers for the same scientific configuration — only the controls, ' +
            'diagnostics and export depth differ (§3).',
        },
      );
    }

    const caseId = (body.caseId ?? '').trim();
    const loadedCase = caseId ? catalogue.cases.get(caseId) : undefined;
    if (caseId && !loadedCase) {
      fieldErrors.push({ field: 'caseId', message: `No such case: ${caseId}` });
    }

    const referenceCaseId = body.referenceCaseId?.trim() || null;
    if (referenceCaseId && !catalogue.cases.has(referenceCaseId)) {
      fieldErrors.push({ field: 'referenceCaseId', message: `No such reference case: ${referenceCaseId}` });
    }

    if (fieldErrors.length > 0) {
      return fail(reply, 400, 'INVALID_INPUT', 'The project could not be created.', { fieldErrors });
    }

    const project = store.createProject({
      ownerId: session.identity.userId,
      title,
      organism: (body.organism ?? loadedCase?.dataset.metadata.organism ?? '').trim(),
      tissue: (body.tissue ?? loadedCase?.dataset.metadata.tissue ?? '').trim(),
      condition: (body.condition ?? loadedCase?.dataset.metadata.condition ?? '').trim(),
      studyQuestion: (body.studyQuestion ?? '').trim(),
      mode,
      datasetId: loadedCase?.caseId ?? null,
      datasetKind: loadedCase ? 'bundled-case' : null,
      referenceDatasetId: referenceCaseId,
    });

    /*
     * A bundled case has already been ingested.
     *
     * The frozen case file *is* the canonicalised object: it was produced by
     * `npm run case:generate`, carries its own checksum and ingestion report,
     * and no further ingestion is possible or meaningful. Leaving `ingest`
     * incomplete made QC unrunnable — the pipeline's own dependency graph
     * refused every run with "Ingest and canonicalise has not completed", which
     * is correct behaviour applied to a stage that had.
     */
    const ready = loadedCase ? store.completeStage(project.projectId, 'ingest') ?? project : project;

    store.audit({
      actorId: session.identity.userId,
      action: 'project.create',
      subject: project.projectId,
      detail: { mode, caseId, referenceCaseId },
    });

    return reply.code(201).send({ project: projectView(ready, store) });
  });

  app.get('/api/v1/projects', async (request, reply) => {
    const session = requireSession(request, reply, sessions);
    if (!session) return reply;
    return reply.send({
      projects: store.listProjects(session.identity.userId).map((project) => projectView(project, store)),
    });
  });

  interface DatasetFileBody {
    name?: string;
    text?: string;
  }

  interface DatasetUploadBody {
    metadata?: Record<string, unknown>;
    matrix?: DatasetFileBody;
    coordinates?: DatasetFileBody;
    observationMetadata?: DatasetFileBody | null;
    featureMetadata?: DatasetFileBody | null;
    observationsAreRows?: boolean;
    defaultModality?: 'transcriptomics' | 'proteomics';
  }

  app.post<{ Params: { id: string }; Body: DatasetUploadBody }>(
    '/api/v1/projects/:id/datasets',
    async (request, reply) => {
      const session = requireSession(request, reply, sessions);
      if (!session) return reply;
      const project = store.getProject(request.params.id);
      if (!project) return fail(reply, 404, 'NOT_FOUND', 'No such project.');
      if (!requireOwnership(reply, session.identity, project.ownerId, 'project')) return reply;
      if (!requireCapability(reply, session.identity, 'upload-dataset')) return reply;

      if (project.completedStages.length > 0 || store.listRuns(project.projectId).length > 0) {
        return fail(
          reply,
          409,
          'INVALID_INPUT',
          'This project already has computed scientific state. Create a new project for a different dataset so prior runs remain immutable.',
          { suggestedAction: 'Create a fresh project, then upload the dataset before running QC.' },
        );
      }

      const body = request.body ?? {};
      const matrix = sourceFile(body.matrix, 'matrix');
      const coordinates = sourceFile(body.coordinates, 'coordinates');
      const fieldErrors: { field: string; message: string }[] = [];
      if (!matrix) fieldErrors.push({ field: 'matrix', message: 'Supply a delimited matrix file as { name, text }.' });
      if (!coordinates) fieldErrors.push({ field: 'coordinates', message: 'Supply a coordinate table as { name, text }.' });
      if (fieldErrors.length > 0) {
        return fail(reply, 400, 'INVALID_INPUT', 'The dataset upload is incomplete.', { fieldErrors });
      }

      for (const file of [matrix as SourceFile, coordinates as SourceFile]) {
        const lower = file.name.toLowerCase();
        if (lower.endsWith('.h5ad') || lower.endsWith('.h5') || lower.endsWith('.zarr') || lower.endsWith('.zip') || lower.endsWith('.parquet')) {
          const guidance = unsupportedFormatGuidance(file.name);
          return fail(reply, 415, 'INVALID_INPUT', guidance.message, {
            suggestedAction: guidance.guidance.join('\n'),
          });
        }
      }

      const observationMetadata = sourceFile(body.observationMetadata ?? undefined, 'observationMetadata');
      const featureMetadata = sourceFile(body.featureMetadata ?? undefined, 'featureMetadata');
      const metadata = metadataFromUpload(body.metadata ?? {}, project.projectId);
      const outcome = ingestTabular(
        {
          matrix: matrix as SourceFile,
          coordinates: coordinates as SourceFile,
          ...(observationMetadata ? { observationMetadata } : {}),
          ...(featureMetadata ? { featureMetadata } : {}),
        },
        {
          metadata,
          observationsAreRows: body.observationsAreRows !== false,
          defaultModality: body.defaultModality === 'proteomics' ? 'proteomics' : 'transcriptomics',
        },
      );

      if (!outcome.ok) {
        return fail(reply, 400, 'INVALID_INPUT', outcome.message, { suggestedAction: outcome.guidance.join('\n') });
      }

      if (outcome.dataset.observations.length > config.runs.maximumObservations) {
        return fail(
          reply,
          413,
          'INVALID_INPUT',
          'This deployment accepts at most ' + config.runs.maximumObservations + ' observations per uploaded dataset.',
          { suggestedAction: 'Subset the dataset or raise SPATIAL_MAX_OBSERVATIONS for a larger deployment.' },
        );
      }
      if (outcome.dataset.features.length > config.runs.maximumFeatures) {
        return fail(
          reply,
          413,
          'INVALID_INPUT',
          'This deployment accepts at most ' + config.runs.maximumFeatures + ' features per uploaded dataset.',
          { suggestedAction: 'Subset features to the panel needed for this run or raise SPATIAL_MAX_FEATURES.' },
        );
      }

      try {
        writeUploadedDataset(store.dataRoot, outcome.dataset);
      } catch (error) {
        return fail(reply, 400, 'INVALID_INPUT', error instanceof Error ? error.message : String(error));
      }

      const updated = store.updateProject(project.projectId, {
        datasetId: outcome.dataset.metadata.datasetId,
        datasetKind: 'upload',
        organism: outcome.dataset.metadata.organism,
        tissue: outcome.dataset.metadata.tissue,
        condition: outcome.dataset.metadata.condition,
        referenceDatasetId: null,
      }) ?? project;
      const ready = store.completeStage(project.projectId, 'ingest') ?? updated;

      store.audit({
        actorId: session.identity.userId,
        action: 'dataset.upload',
        subject: outcome.dataset.metadata.datasetId,
        detail: {
          projectId: project.projectId,
          observations: outcome.dataset.observations.length,
          features: outcome.dataset.features.length,
          checksum: outcome.dataset.checksum,
          warnings: outcome.warnings,
        },
      });

      return reply.code(201).send({
        project: projectView(ready, store),
        dataset: publicUploadedSummary(outcome.dataset),
        warnings: outcome.warnings,
      });
    },
  );

  app.get<{ Params: { id: string } }>('/api/v1/projects/:id', async (request, reply) => {
    const session = requireSession(request, reply, sessions);
    if (!session) return reply;
    const project = store.getProject(request.params.id);
    if (!project) return fail(reply, 404, 'NOT_FOUND', 'No such project.');
    if (!requireOwnership(reply, session.identity, project.ownerId, 'project')) return reply;
    return reply.send({ project: projectView(project, store) });
  });

  /**
   * Mode changes.
   *
   * §6.1 requires that a mode change does not alter the scientific
   * configuration, and §3's cross-mode identity rule requires that it does not
   * alter the numbers. So this endpoint touches `mode` and nothing else, and
   * completed stages are untouched — a project analysed in Beginner mode and
   * then reopened in Advanced shows the same results with more of them visible.
   */
  app.patch<{ Params: { id: string }; Body: { mode?: LabMode } }>(
    '/api/v1/projects/:id/mode',
    async (request, reply) => {
      const session = requireSession(request, reply, sessions);
      if (!session) return reply;
      const project = store.getProject(request.params.id);
      if (!project) return fail(reply, 404, 'NOT_FOUND', 'No such project.');
      if (!requireOwnership(reply, session.identity, project.ownerId, 'project')) return reply;

      const mode = request.body?.mode;
      if (mode !== 'basic' && mode !== 'moderate' && mode !== 'expert') {
        return fail(reply, 400, 'INVALID_INPUT', 'Mode must be basic, moderate or expert.');
      }
      const lock = modeLock(session.identity, mode, modeProgress(store, session.identity.userId));
      if (lock) return fail(reply, 403, 'TIER_REQUIRED', lock);
      const updated = store.updateProject(project.projectId, { mode });
      return reply.send({ project: projectView(updated ?? project, store) });
    },
  );

  // -- perturbation options -------------------------------------------------

  /**
   * What can be perturbed, and what cannot, with the reason.
   *
   * §6.10 requires unsupported options to be "disabled with reason" rather than
   * hidden. A hidden option teaches nothing; a disabled one with "this target
   * is not in the model's feature space" teaches what the model can see.
   */
  app.get<{ Params: { id: string } }>('/api/v1/projects/:id/perturbation-options', async (request, reply) => {
    const session = requireSession(request, reply, sessions);
    if (!session) return reply;
    const project = store.getProject(request.params.id);
    if (!project) return fail(reply, 404, 'NOT_FOUND', 'No such project.');
    if (!requireOwnership(reply, session.identity, project.ownerId, 'project')) return reply;

    const pack = catalogue.modelPack;
    const featureSpace = new Set(catalogue.network.nodes.map((node) => node.symbol.toUpperCase()));

    const operators: MolecularOperator[] = [
      'knockout', 'inhibition', 'activation', 'overexpression',
      'mutation-gain-of-function', 'mutation-loss-of-function',
    ];

    const loadedCase = project.datasetId ? catalogue.cases.get(project.datasetId) : undefined;
    const cellTypes = loadedCase ? [...new Set(loadedCase.cellTypes)].sort() : [];
    const regions = loadedCase ? [...new Set(loadedCase.regions)].sort() : [];

    return reply.send({
      branches: [
        {
          id: 'molecular-genetic',
          available: true,
          reason: null,
          targets: catalogue.network.nodes.map((node) => ({
            symbol: node.symbol,
            pathway: node.pathway,
            role: node.role,
            supported: featureSpace.has(node.symbol.toUpperCase()),
          })),
          operators: operators.map((operator) => ({
            id: operator,
            label: OPERATOR_LABEL[operator],
            semantics: OPERATOR_SEMANTICS[operator],
          })),
        },
        {
          id: 'drug',
          available: catalogue.drugEvidence !== null,
          reason: catalogue.drugEvidence
            ? null
            : 'No drug evidence pack is installed, so no compound has an evidence-supported concentration to simulate at.',
          compounds: (catalogue.drugEvidence?.records ?? []).map((record) => ({
            drugId: record.drugId,
            name: record.prefName || record.name,
            target: record.target,
            therapyClass: record.curated.therapyClass,
            actionType: record.curated.actionType,
            mechanism: record.curated.mechanism,
            medianPotencyNm: record.potency.medianNm,
            testedRangeNm: record.potency.testedRangeNm,
            measurements: record.potency.measurements,
            documents: record.evidence.documentCount,
            targetInFeatureSpace: featureSpace.has(record.target.toUpperCase()),
            simulatable:
              record.curated.therapyClass === 'small-molecule' &&
              record.potency.medianNm !== null &&
              featureSpace.has(record.target.toUpperCase()),
            notSimulatableReason:
              record.curated.therapyClass !== 'small-molecule'
                ? `§1.4 makes ${record.curated.therapyClass} model packs conditional on a separate validated mechanistic model, and none ships with this build.`
                : record.potency.medianNm === null
                  ? 'No potency measurement was retrieved for this compound against this target, so there is no evidence-supported concentration.'
                  : !featureSpace.has(record.target.toUpperCase())
                    ? `${record.target} is not in the model's feature space.`
                    : null,
          })),
        },
      ],
      selection: { cellTypes, regions },
      modelPack: pack ? { modelId: pack.modelId, version: pack.version } : null,
      modelPackMissing: pack
        ? null
        : 'No propagation model pack: a perturbation can be defined and its direct response computed, but nothing will propagate.',
    });
  });

  // -- create a perturbation ------------------------------------------------

  interface PerturbationBody {
    branch?: 'molecular-genetic' | 'drug';
    target?: string;
    operator?: MolecularOperator;
    magnitude?: number;
    magnitudeSource?: 'model-pack' | 'user-exploratory';
    drugId?: string;
    concentration?: number;
    concentrationUnit?: 'nM' | 'uM' | 'mM';
    exposureTime?: number;
    exposureTimeUnit?: 'min' | 'h' | 'day';
    selection?: {
      mode?: 'cell-type' | 'region' | 'explicit' | 'whole-tissue' | 'radius';
      classes?: string[];
      observationIds?: string[];
      centre?: { x: number; y: number };
      radius?: number;
    };
  }

  app.post<{ Params: { id: string }; Body: PerturbationBody }>(
    '/api/v1/projects/:id/perturbations',
    async (request, reply) => {
      const session = requireSession(request, reply, sessions);
      if (!session) return reply;
      const project = store.getProject(request.params.id);
      if (!project) return fail(reply, 404, 'NOT_FOUND', 'No such project.');
      if (!requireOwnership(reply, session.identity, project.ownerId, 'project')) return reply;
      if (!requireCapability(reply, session.identity, 'run-prediction')) return reply;

      /*
       * Selections are resolved against a bundled case's cell types and
       * regions, so an uploaded dataset cannot be perturbed at present. It
       * used to fall through to "This project has no dataset selected", which
       * is false: the project has a dataset, and its baseline may already be
       * complete. Say what is actually the case.
       */
      if (project.datasetKind === 'upload') {
        return fail(reply, 400, 'INVALID_INPUT', 'Perturbations can only be defined on the bundled cases at present. An uploaded dataset supports the baseline analysis.', {
          suggestedAction: 'To run a perturbation, start a project on one of the bundled cases.',
        });
      }
      const loadedCase = project.datasetId ? catalogue.cases.get(project.datasetId) : undefined;
      if (!loadedCase) {
        return fail(reply, 400, 'INVALID_INPUT', 'This project has no dataset selected.');
      }
      if (!project.completedStages.includes('baseline')) {
        return fail(
          reply,
          409,
          'INVALID_INPUT',
          'The baseline analysis has not completed, so there is no tissue state to perturb.',
          { suggestedAction: 'Run the baseline analysis first.' },
        );
      }

      const body = request.body ?? {};
      const selectionRequest = {
        mode: body.selection?.mode ?? 'whole-tissue',
        ...(body.selection?.classes ? { classes: body.selection.classes } : {}),
        ...(body.selection?.observationIds ? { observationIds: body.selection.observationIds } : {}),
        ...(body.selection?.centre ? { centre: body.selection.centre } : {}),
        ...(body.selection?.radius !== undefined ? { radius: body.selection.radius } : {}),
      } as Parameters<typeof resolveSelection>[0];

      const selection = resolveSelection(
        selectionRequest,
        loadedCase.dataset.observations,
        loadedCase.cellTypes,
        loadedCase.regions,
      );

      if (selection.resolvedIndices.length === 0) {
        return fail(reply, 400, 'INVALID_INPUT', 'The selection resolved to no cells.', {
          fieldErrors: [{ field: 'selection', message: selection.description }],
          // The INVALID_INPUT default talks about re-uploading a file, which is
          // not what went wrong here.
          suggestedAction: 'Choose at least one cell type or region to perturb, or target the whole tissue.',
        });
      }

      let spec: PerturbationSpec;
      if (body.branch === 'drug') {
        const evidence = catalogue.drugEvidence;
        const record = evidence?.records.find((candidate) => candidate.drugId === body.drugId);
        if (!record) {
          return fail(reply, 404, 'EVIDENCE_UNAVAILABLE', `No evidence record for compound "${body.drugId ?? ''}".`);
        }
        if (record.potency.medianNm === null) {
          return fail(
            reply,
            422,
            'UNSUPPORTED_DOSE_OR_TIME',
            `No potency measurement was retrieved for ${record.prefName} against ${record.target}, so there is no evidence-supported concentration to simulate at.`,
          );
        }

        const drugSpec: DrugPerturbation = {
          branch: 'drug',
          drugId: record.drugId,
          drugName: record.prefName || record.name,
          target: record.target,
          actionType: record.curated.actionType,
          secondaryTargets: [],
          concentration: typeof body.concentration === 'number' ? body.concentration : record.potency.medianNm,
          concentrationUnit: body.concentrationUnit ?? 'nM',
          exposureTime: typeof body.exposureTime === 'number' ? body.exposureTime : 24,
          exposureTimeUnit: body.exposureTimeUnit ?? 'h',
          doseResponse: {
            emax: 1,
            ec50Nm: record.potency.medianNm,
            hill: 1,
            source: `ChEMBL ${record.drugId} against ${record.targetChemblId}; median of ${record.potency.measurements} measurement(s).`,
            evidenceClass: 'curated-database',
            context: {
              organism: record.targetOrganism,
              tissueOrCellLine: 'Mixed; the measurements aggregate biochemical and cell-based assays.',
              assay: record.potency.types.join(', '),
              testedRangeNm: record.potency.testedRangeNm,
            },
            transferWarning:
              'Potency aggregates assay types and contexts. Emax = 1 and Hill = 1 are model assumptions, not measurements.',
          },
          timeResponse: null,
          evidenceSnapshotId: evidence?.packId ?? 'none',
        };
        spec = drugSpec;
      } else {
        const target = (body.target ?? '').trim();
        if (!target) {
          return fail(reply, 400, 'INVALID_INPUT', 'A target is required.', {
            fieldErrors: [{ field: 'target', message: 'Choose a gene or protein.' }],
          });
        }
        const molecular: MolecularPerturbation = {
          branch: 'molecular-genetic',
          target,
          targetKind: 'gene',
          operator: body.operator ?? 'knockout',
          magnitude: typeof body.magnitude === 'number' ? body.magnitude : 0,
          magnitudeSource: body.magnitudeSource ?? 'model-pack',
          stage: 'steady-state',
        };
        spec = molecular;
      }

      const eligibility = assessEligibility(spec, {
        availableFeatures: new Set(loadedCase.dataset.features.map((feature) => feature.symbol.toUpperCase())),
        supportedTargets: new Set(catalogue.network.nodes.map((node) => node.symbol.toUpperCase())),
        supportedOperators: new Set([
          'knockout', 'inhibition', 'activation', 'overexpression',
          'mutation-gain-of-function', 'mutation-loss-of-function',
        ]),
        datasetOrganism: loadedCase.dataset.metadata.organism,
        datasetTissue: loadedCase.dataset.metadata.tissue,
        modelPackId: catalogue.modelPack?.modelId ?? 'none',
        modelPackVersion: catalogue.modelPack?.version ?? '0',
      });

      const definition = createDefinition(
        spec,
        selection,
        eligibility,
        catalogue.modelPack?.modelId ?? 'none',
        catalogue.modelPack?.version ?? '0',
      );
      store.saveDefinition(definition);
      store.completeStage(project.projectId, 'perturbation');

      if (eligibility.decision === 'blocked') {
        // Stored, then refused. The definition exists so the refusal can be
        // shown with its exact parameters, which a rejected request that
        // persisted nothing could not do.
        return reply.code(422).send({
          definition,
          blocked: true,
          message: 'This perturbation is not supported and no quantitative result will be produced.',
        });
      }

      return reply.code(201).send({ definition, blocked: false });
    },
  );

  // -- run submission -------------------------------------------------------

  interface RunBody {
    kind?: 'analysis' | 'prediction' | 'rescue' | 'report';
    perturbationId?: string;
    seed?: number;
    stages?: number;
    runMechanisticReference?: boolean;
    graphMethod?: 'knn' | 'radius' | 'grid' | 'delaunay';
    graphK?: number;
    permutations?: number;
  }

  app.post<{ Params: { id: string }; Body: RunBody }>('/api/v1/projects/:id/runs', async (request, reply) => {
    const session = requireSession(request, reply, sessions);
    if (!session) return reply;
    const project = store.getProject(request.params.id);
    if (!project) return fail(reply, 404, 'NOT_FOUND', 'No such project.');
    if (!requireOwnership(reply, session.identity, project.ownerId, 'project')) return reply;

    const body = request.body ?? {};
    const kind = body.kind ?? 'analysis';
    const capability = kind === 'analysis' ? 'run-analysis' : kind === 'rescue' ? 'run-rescue' : 'run-prediction';
    if (!requireCapability(reply, session.identity, capability)) return reply;

    // Rate limit and queue depth, before any work is scheduled.
    const hourAgo = Date.now() - 60 * 60 * 1000;
    if (store.countRunsSince(session.identity.userId, hourAgo) >= config.runs.rateLimitPerHour) {
      return fail(reply, 429, 'RATE_LIMITED', `This account has reached ${config.runs.rateLimitPerHour} runs in the last hour.`, {
        retryAfterSeconds: 600,
      });
    }
    if (services.queue.depth >= config.runs.maxQueued) {
      return fail(reply, 503, 'CAPACITY', 'The run queue is full.', { retryAfterSeconds: 30 });
    }

    // Dependencies, from the pipeline's own graph rather than a hand-written
    // check that could drift from it.
    const completed = new Set<StageId>(project.completedStages);
    const firstStage: StageId = kind === 'analysis' ? 'qc' : kind === 'prediction' ? 'direct-response' : kind === 'rescue' ? 'candidates' : 'report';
    const runnable = stageIsRunnable(firstStage, completed);
    if (!runnable.runnable) {
      return fail(
        reply,
        409,
        'INVALID_INPUT',
        `${STAGE_TITLE[firstStage]} cannot run yet: ${runnable.missing.map((stage) => STAGE_TITLE[stage]).join(', ')} ${runnable.missing.length === 1 ? 'has' : 'have'} not completed.`,
        { suggestedAction: 'Run the earlier stages first.' },
      );
    }

    const submitted = submitRun({
      services,
      project,
      identity: session.identity,
      kind,
      options: {
        seed: typeof body.seed === 'number' ? body.seed : 20260821,
        stages: typeof body.stages === 'number' ? Math.min(8, Math.max(2, body.stages)) : 5,
        perturbationId: body.perturbationId ?? null,
        runMechanisticReference: body.runMechanisticReference === true,
        graphMethod: body.graphMethod ?? 'knn',
        graphK: typeof body.graphK === 'number' ? Math.min(30, Math.max(3, body.graphK)) : 6,
        permutations: typeof body.permutations === 'number' ? Math.min(2000, Math.max(100, body.permutations)) : 1000,
      },
    });

    if (!submitted.accepted) {
      return fail(reply, 503, 'CAPACITY', submitted.reason ?? 'The run could not be queued.', { retryAfterSeconds: 30 });
    }

    store.audit({
      actorId: session.identity.userId,
      action: 'run.submit',
      subject: submitted.runId,
      detail: { kind, projectId: project.projectId, perturbationId: body.perturbationId ?? null },
    });

    return reply.code(202).send({ runId: submitted.runId, status: 'queued' });
  });

  void queryString;
  void toNanomolar;
}

export function projectView(project: ReturnType<Store['getProject']> & object, store: Store): Record<string, unknown> {
  const completed = new Set<StageId>(project.completedStages);
  const failed = new Set<StageId>(project.failedStages);
  const derived = deriveState(completed, failed);
  return {
    ...project,
    state: derived.state,
    sideStates: derived.side,
    runs: store.listRuns(project.projectId).map((run) => ({
      runId: run.runId,
      kind: run.kind,
      status: run.status,
      createdAt: run.createdAt,
      finishedAt: run.finishedAt,
      progress: run.progress,
      currentStage: run.currentStage,
    })),
  };
}

function sourceFile(value: unknown, fallback: string): SourceFile | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as { name?: unknown; text?: unknown };
  if (typeof record.text !== 'string' || record.text.length === 0) return null;
  const name = typeof record.name === 'string' && record.name.trim() ? record.name.trim() : fallback;
  return { name, text: record.text, bytes: Buffer.byteLength(record.text, 'utf8') };
}
