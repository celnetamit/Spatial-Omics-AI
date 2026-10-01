/**
 * Reading results: run status, structured results, per-cell layers, the AI
 * interpretation, the validation plan and the report bundle.
 *
 * Runs are polled rather than held open. §9.1 keeps long work off the request
 * path, and a five-minute propagation on a held connection looks like a hung
 * page long before it looks like a running job.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config';
import { canOpenMode } from '../auth';
import { recommendValidation, type PredictedChange } from '@engine/report/validationPlan';
import { compareWithObservation } from '@engine/rescue/comparison';
import type { Services } from './index';
import { fail, queryNumber, queryString, requireCapability, requireOwnership, requireSession, type Sessions } from './shared';
import { resolveLayer } from './layers';
import { buildEvidence } from '../ai/build';
import type { RunRecord } from '../store';
import type { AnalysisArtefacts } from '../jobs/analysis';
import type { PredictionArtefacts } from '../jobs/prediction';
import type { RescueArtefacts } from '../jobs/rescue';

export async function registerResultRoutes(
  app: FastifyInstance,
  services: Services,
  sessions: Sessions,
): Promise<void> {
  const { store } = services;

  /** Resolves a run and checks it belongs to the caller. Null means answered. */
  const resolveRun = (
    request: FastifyRequest,
    reply: FastifyReply,
    runId: string,
  ): { run: NonNullable<ReturnType<typeof store.getRun>>; projectId: string } | null => {
    const session = requireSession(request, reply, sessions);
    if (!session) return null;
    const run = store.getRun(runId);
    if (!run) {
      fail(reply, 404, 'NOT_FOUND', 'No such run.');
      return null;
    }
    if (!requireOwnership(reply, session.identity, run.ownerId, 'run')) return null;
    return { run, projectId: run.projectId };
  };

  // -- status ---------------------------------------------------------------

  app.get<{ Params: { id: string } }>('/api/v1/runs/:id', async (request, reply) => {
    const resolved = resolveRun(request, reply, request.params.id);
    if (!resolved) return reply;
    const handle = services.queue.handleFor(resolved.run.runId);
    return reply.send({
      run: {
        ...resolved.run,
        // The live handle is authoritative while a job is running; the stored
        // record catches up when it settles.
        status: handle?.status ?? resolved.run.status,
        progress: handle?.progress.fraction ?? resolved.run.progress,
        currentStage: handle?.progress.stage ?? resolved.run.currentStage,
        message: handle?.progress.message ?? null,
      },
      queue: { running: services.queue.running, waiting: services.queue.depth },
    });
  });

  app.post<{ Params: { id: string } }>('/api/v1/runs/:id/cancel', async (request, reply) => {
    const resolved = resolveRun(request, reply, request.params.id);
    if (!resolved) return reply;
    const cancelled = services.queue.cancel(resolved.run.runId);
    if (!cancelled) {
      return fail(reply, 409, 'INVALID_INPUT', 'This run has already finished, so there is nothing to cancel.');
    }
    store.audit({
      actorId: resolved.run.ownerId,
      action: 'run.cancel',
      subject: resolved.run.runId,
      detail: {},
    });
    return reply.send({
      cancelled: true,
      note: 'Partial results written before cancellation are kept, and the report will say which stages completed.',
    });
  });

  // -- structured results ---------------------------------------------------

  app.get<{ Params: { id: string } }>('/api/v1/runs/:id/results', async (request, reply) => {
    const resolved = resolveRun(request, reply, request.params.id);
    if (!resolved) return reply;

    const project = store.getProject(resolved.projectId);
    const mode = project?.mode ?? 'basic';

    const analysis = store.readArtefact<AnalysisArtefacts>(resolved.run.runId, 'analysis');
    const prediction = store.readArtefact<PredictionArtefacts>(resolved.run.runId, 'prediction');
    const rescue = store.readArtefact<RescueArtefacts>(resolved.run.runId, 'rescue');
    const observations = store.readArtefact<{ ids: string[]; x: number[]; y: number[]; coordinateUnit: string }>(
      resolved.run.runId,
      'observations',
    );

    /*
     * Mode shapes what is *shown*, never what was computed.
     *
     * §3's cross-mode identity rule is the constraint: the same configuration
     * produces the same numbers in every mode. So this filter removes
     * diagnostics and provenance depth from a Beginner response — it never
     * substitutes a different value.
     */
    const expert = mode === 'expert';
    const moderate = mode === 'moderate' || expert;

    return reply.send({
      runId: resolved.run.runId,
      kind: resolved.run.kind,
      status: resolved.run.status,
      mode,
      observations,
      analysis: analysis
        ? {
            qc: {
              verdict: analysis.qc.verdict,
              predictionEligible: analysis.qc.predictionEligible,
              predictionBlockers: analysis.qc.predictionBlockers,
              eligibility: analysis.qc.eligibility,
              summary: analysis.qc.summary,
              recommendedActions: analysis.qc.recommendedActions,
              checks: analysis.qc.checks,
              // The per-cell metric arrays are a layer, not a table.
              observationMetrics: moderate ? undefined : undefined,
            },
            comparability: analysis.comparability,
            preprocessing: moderate ? analysis.preprocessing : { warnings: analysis.preprocessing.warnings },
            annotation: {
              source: analysis.annotation.source,
              classes: analysis.annotation.classes,
              unassigned: analysis.annotation.unassigned,
              exploratory: analysis.annotation.exploratory,
              summary: analysis.annotation.summary,
              panelCoverage: moderate ? analysis.annotation.panelCoverage : null,
            },
            regions: { classes: analysis.regions.classes, source: analysis.regions.source },
            domains: analysis.domains
              ? {
                  domainCount: analysis.domains.domainCount,
                  spatialCoherence: analysis.domains.spatialCoherence,
                  sizes: analysis.domains.sizes,
                }
              : null,
            differential: {
              results: analysis.differential.results
                .slice()
                .sort((a, b) => (a.qValue || 1) - (b.qValue || 1))
                .slice(0, expert ? 2000 : 400),
              skipped: analysis.differential.skipped,
              truncated: analysis.differential.results.length > (expert ? 2000 : 400),
              total: analysis.differential.results.length,
            },
            pathways: analysis.pathways.results,
            states: analysis.states.results,
            graph: moderate
              ? analysis.graph
              : { graphId: analysis.graph.graphId, method: analysis.graph.method, diagnostics: analysis.graph.diagnostics },
            enrichment: analysis.enrichment,
            autocorrelation: analysis.autocorrelation,
            communication: {
              results: analysis.communication.results,
              byClass: analysis.communication.byClass,
            },
            manifest: expert ? analysis.manifest : { seed: analysis.manifest.seed, warnings: analysis.manifest.warnings },
          }
        : null,
      prediction: prediction
        ? {
            ...prediction,
            // Per-cell arrays are layers; sending them here would double the
            // payload for data the canvas fetches by name anyway.
            direct: { ...prediction.direct, magnitude: undefined, effectByNode: undefined },
            propagation: {
              ...prediction.propagation,
              stages: prediction.propagation.stages.map((stage) => ({
                stage: stage.stage,
                label: stage.label,
                nodeMeanDelta: stage.nodeMeanDelta,
              })),
              disagreement: undefined,
            },
            altered: { ...prediction.altered, observationMagnitude: undefined },
            adverse: { ...prediction.adverse, componentDeltas: undefined },
          }
        : null,
      rescue: rescue
        ? {
            ...rescue,
            simulated: rescue.simulated.map((entry) => ({ ...entry, magnitude: undefined })),
          }
        : null,
      warnings: resolved.run.warnings,
      error: resolved.run.error,
    });
  });

  // -- layers ---------------------------------------------------------------

  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>(
    '/api/v1/runs/:id/layer',
    async (request, reply) => {
      const resolved = resolveRun(request, reply, request.params.id);
      if (!resolved) return reply;

      const kind = queryString(request.query.kind);
      const key = queryString(request.query.key);
      const stage = queryNumber(request.query.stage, 0, 0, 16);
      if (!kind) {
        return fail(reply, 400, 'INVALID_INPUT', 'A layer needs a "kind".');
      }

      const layer = resolveLayer(store, resolved.run.runId, { kind, key, stage });
      if ('error' in layer) {
        return fail(reply, 404, 'NOT_FOUND', layer.error);
      }
      return reply.send({ layer });
    },
  );

  // -- interpretation -------------------------------------------------------

  app.post<{ Params: { id: string }; Body: { stage?: 'baseline' | 'final' } }>(
    '/api/v1/runs/:id/interpretation',
    async (request, reply) => {
      const resolved = resolveRun(request, reply, request.params.id);
      if (!resolved) return reply;
      const session = requireSession(request, reply, sessions);
      if (!session) return reply;
      if (!requireCapability(reply, session.identity, 'use-ai-interpretation')) return reply;

      const stage = request.body?.stage === 'final' ? 'final' : 'baseline';
      const evidence = buildEvidence(store, resolved.run.runId, stage);
      const result = await services.ai.interpret({
        runId: resolved.run.runId,
        userId: session.identity.userId,
        stage,
        evidence,
      });

      return reply.send({
        interpretation: result,
        /*
         * The evidence object is returned alongside.
         *
         * §6.9 requires the panel to separate Observed, Computed,
         * Interpretation and Limitations, and a reader who wants to check a
         * sentence against the results should not have to take the model's
         * citation on trust. This is what the citation points at.
         */
        evidence: {
          claims: evidence.claims,
          limitations: evidence.limitations,
          missingEvidence: evidence.missingEvidence,
          uncertainty: evidence.uncertainty,
          notInterpretable: evidence.notInterpretable,
        },
      });
    },
  );

  // -- validation plan ------------------------------------------------------

  app.post<{ Params: { id: string } }>('/api/v1/runs/:id/validation-plan', async (request, reply) => {
    const resolved = resolveRun(request, reply, request.params.id);
    if (!resolved) return reply;

    const prediction = store.readArtefact<PredictionArtefacts>(resolved.run.runId, 'prediction');
    if (!prediction) {
      return fail(reply, 409, 'INVALID_INPUT', 'There is no prediction in this run to design a validation experiment for.');
    }

    const delta = store.readArtefact<{ nodeSymbols: string[]; values: number[]; observationCount: number }>(
      resolved.run.runId,
      'final-delta',
    );
    const network = services.catalogue.network;
    const secreted = new Set(network.signals.map((signal) => network.nodes[signal.ligand]?.symbol ?? ''));
    const targeted = new Set(prediction.direct.targetNodes.map((node) => prediction.nodeSymbols[node]));

    const changes: PredictedChange[] = prediction.altered.nodeMeanDelta.map((value, node) => ({
      symbol: prediction.nodeSymbols[node] as string,
      delta: value,
      dispersion: dispersionFor(delta, node),
      localisedTo: dominantClass(prediction, node),
      secreted: secreted.has(prediction.nodeSymbols[node] as string),
      proteinMeasured: false,
      bystander: !targeted.has(prediction.nodeSymbols[node] as string),
    }));

    const plan = recommendValidation({
      changes,
      perturbationDescription: prediction.perturbationId,
      spatialPredictionAvailable: prediction.propagation.available,
      confidence: prediction.confidence,
      predictionId: resolved.run.runId,
    });

    if (!plan) {
      return reply.send({
        plan: null,
        message:
          'No predicted change is large enough to design an experiment around. Measuring a change the model does not predict ' +
          'would test nothing, so no experiment is recommended.',
      });
    }

    store.writeArtefact(resolved.run.runId, 'validation-plan', plan);
    store.completeStage(resolved.projectId, 'validation-plan');
    return reply.send({ plan, message: null });
  });

  // -- prediction versus observation ---------------------------------------

  /**
   * §6.23's loop: an observed result creates a *new* comparison object and does
   * not touch the prediction. A prediction that can be revised after the fact
   * is not a prediction.
   */
  app.post<{ Params: { id: string }; Body: { observed?: Record<string, number>; label?: string } }>(
    '/api/v1/runs/:id/validation-comparison',
    async (request, reply) => {
      const resolved = resolveRun(request, reply, request.params.id);
      if (!resolved) return reply;

      const prediction = store.readArtefact<PredictionArtefacts>(resolved.run.runId, 'prediction');
      if (!prediction) {
        return fail(reply, 409, 'INVALID_INPUT', 'There is no prediction in this run to compare against.');
      }
      const observed = request.body?.observed;
      if (!observed || typeof observed !== 'object' || Object.keys(observed).length === 0) {
        return fail(reply, 400, 'INVALID_INPUT', 'Supply observed changes as { "SYMBOL": value }.');
      }

      const comparison = compareWithObservation(
        Float64Array.from(prediction.altered.nodeMeanDelta),
        new Map(Object.entries(observed).filter(([, value]) => Number.isFinite(value))),
        services.catalogue.network,
      );

      const name = `validation-comparison-${Date.now()}`;
      store.writeArtefact(resolved.run.runId, name, {
        label: request.body?.label ?? 'Observed result',
        comparedAt: new Date().toISOString(),
        comparison,
        note: 'Stored as a new object. The original prediction is unchanged (§6.23).',
      });

      return reply.code(201).send({ comparison, artefact: name });
    },
  );

  // -- report ---------------------------------------------------------------

  app.get<{ Params: { id: string } }>('/api/v1/runs/:id/report', async (request, reply) => {
    const resolved = resolveRun(request, reply, request.params.id);
    if (!resolved) return reply;
    const session = requireSession(request, reply, sessions);
    if (!session) return reply;

    const project = store.getProject(resolved.projectId);
    const machineReadable = project ? canOpenMode(session.identity, 'expert') && project.mode === 'expert' : false;

    const sections = buildReport(services, resolved.run.runId, resolved.projectId);
    return reply.send({
      report: sections,
      machineReadable,
      note: machineReadable
        ? 'Advanced mode: the full artefact set is available from /artefacts.'
        : 'Advanced mode adds the machine-readable bundle and the full parameter manifest. The scientific content is identical.',
    });
  });

  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>(
    '/api/v1/runs/:id/artefacts',
    async (request, reply) => {
      const resolved = resolveRun(request, reply, request.params.id);
      if (!resolved) return reply;
      const session = requireSession(request, reply, sessions);
      if (!session) return reply;
      if (!requireCapability(reply, session.identity, 'export-machine-readable')) return reply;

      const name = queryString(request.query.name);
      if (!name) {
        return reply.send({ artefacts: store.listArtefacts(resolved.run.runId) });
      }
      const artefact = store.readArtefact(resolved.run.runId, name);
      if (artefact === null) return fail(reply, 404, 'NOT_FOUND', `No artefact "${name}" in this run.`);
      return reply.send({ name, artefact });
    },
  );

  void config;
}

function dispersionFor(
  delta: { nodeSymbols: string[]; values: number[]; observationCount: number } | null,
  node: number,
): number {
  if (!delta) return Number.NaN;
  // Spread of the per-cell change for this node, which stands in for the
  // ensemble dispersion when the per-node ensemble spread is not retained.
  const nodeCount = delta.nodeSymbols.length;
  let sum = 0;
  let squared = 0;
  for (let i = 0; i < delta.observationCount; i += 1) {
    const value = delta.values[i * nodeCount + node] as number;
    sum += value;
    squared += value * value;
  }
  const mean = sum / Math.max(1, delta.observationCount);
  return Math.sqrt(Math.max(0, squared / Math.max(1, delta.observationCount) - mean * mean));
}

function dominantClass(prediction: PredictionArtefacts, node: number): string | null {
  let best: string | null = null;
  let largest = 0;
  for (const entry of prediction.altered.byClass) {
    const value = Math.abs(entry.nodeMeanDelta[node] ?? 0);
    if (value > largest) {
      largest = value;
      best = entry.className;
    }
  }
  return best;
}

/**
 * §12.5's seventeen report sections, assembled from stored artefacts.
 *
 * The report spans the whole workflow, and the workflow spans several runs: QC
 * and the baseline come from the analysis run, the direct response and
 * propagation from the prediction run, the candidate simulations from the
 * rescue run. Reading every artefact from the one run whose id was asked for
 * therefore produced a report that could never be complete — requested on the
 * prediction run it reported QC as absent, on the analysis run it reported the
 * perturbation as absent, and there was no run for which all seventeen sections
 * could be present.
 *
 * So each family is read from the run that produced it. The requested run wins
 * for its own kind, because asking for the report of a particular prediction
 * means that prediction and not the newest one; for the other kinds the latest
 * completed run in the project is used, and a section stays absent when no such
 * run exists.
 */
function buildReport(services: Services, runId: string, projectId: string): Record<string, unknown> {
  const { store } = services;
  const project = store.getProject(projectId);
  const run = store.getRun(runId);

  const latestOfKind = (kind: RunRecord['kind']): string | null => {
    if (run && run.kind === kind) return run.runId;
    const candidates = store
      .listRuns(projectId)
      .filter((candidate) => candidate.kind === kind && candidate.status === 'complete');
    return candidates.length > 0 ? (candidates[candidates.length - 1] as RunRecord).runId : null;
  };

  const analysisRunId = latestOfKind('analysis');
  const predictionRunId = latestOfKind('prediction');
  const rescueRunId = latestOfKind('rescue');

  const analysis = analysisRunId ? store.readArtefact<AnalysisArtefacts>(analysisRunId, 'analysis') : null;
  const prediction = predictionRunId ? store.readArtefact<PredictionArtefacts>(predictionRunId, 'prediction') : null;
  const rescue = rescueRunId ? store.readArtefact<RescueArtefacts>(rescueRunId, 'rescue') : null;

  // The validation plan and any prediction-versus-observation comparisons are
  // written by the prediction run, so they are read from it rather than from
  // whichever run was asked for.
  const plan = predictionRunId ? store.readArtefact(predictionRunId, 'validation-plan') : null;
  const comparisons = predictionRunId
    ? store
        .listArtefacts(predictionRunId)
        .filter((name) => name.startsWith('validation-comparison-'))
        .map((name) => store.readArtefact(predictionRunId, name))
    : [];

  const loadedCase = project?.datasetId ? services.catalogue.cases.get(project.datasetId) : undefined;

  /*
   * Which runs this report was assembled from, named in the report itself.
   *
   * A report stitched together from three runs has to say which three, or it is
   * a document whose provenance cannot be reconstructed — and the manifest in
   * section 17 describes only one of them.
   */
  const assembledFrom = {
    requestedRun: runId,
    analysisRun: analysisRunId,
    predictionRun: predictionRunId,
    rescueRun: rescueRunId,
  };

  return {
    generatedAt: new Date().toISOString(),
    assembledFrom,
    sections: [
      { number: 1, title: 'Project and dataset metadata', present: Boolean(project), content: { project, dataset: loadedCase ? { metadata: loadedCase.dataset.metadata, simulationNotice: loadedCase.simulationNotice, checksum: loadedCase.dataset.checksum } : null } },
      { number: 2, title: 'QC and eligibility', present: Boolean(analysis), content: analysis ? { verdict: analysis.qc.verdict, eligibility: analysis.qc.eligibility, checks: analysis.qc.checks, summary: analysis.qc.summary } : null },
      { number: 3, title: 'Methods and software versions', present: Boolean(analysis), content: analysis?.manifest.methods ?? null },
      { number: 4, title: 'Baseline spatial analysis', present: Boolean(analysis), content: analysis ? { annotation: analysis.annotation.summary, pathways: analysis.pathways.results, states: analysis.states.results, enrichment: analysis.enrichment, autocorrelation: analysis.autocorrelation } : null },
      { number: 5, title: 'Perturbation definition and parameter evidence', present: Boolean(prediction), content: prediction ? store.getDefinition(prediction.perturbationId) ?? null : null },
      { number: 6, title: 'Direct response', present: Boolean(prediction), content: prediction ? { terms: prediction.direct.terms, warnings: prediction.direct.warnings, quantitative: prediction.direct.quantitative, method: prediction.direct.method } : null },
      { number: 7, title: 'Spatial graph and propagation', present: Boolean(prediction), content: prediction ? { graph: analysis?.graph ?? null, propagation: { available: prediction.propagation.available, unavailableReason: prediction.propagation.unavailableReason, modelId: prediction.propagation.modelId, modelVersion: prediction.propagation.modelVersion, members: prediction.propagation.members, stageCaveat: prediction.propagation.stageCaveat } } : null },
      { number: 8, title: 'Predicted altered tissue', present: Boolean(prediction), content: prediction?.altered ?? null },
      { number: 9, title: 'Adverse and off-target results', present: Boolean(prediction), content: prediction ? { components: prediction.adverse.components, offTargets: prediction.adverse.offTargets, burden: prediction.adverse.burden, notInterpretable: prediction.adverse.notInterpretable } : null },
      { number: 10, title: 'Rescue candidate evidence and eligibility', present: Boolean(rescue), content: rescue ? { eligible: rescue.eligible, excluded: rescue.excluded, drivers: rescue.drivers, note: rescue.retrievalNote } : null },
      { number: 11, title: 'Per-candidate simulations', present: Boolean(rescue), content: rescue ? rescue.simulated.map((entry) => ({ ...entry, magnitude: undefined, nodeMeanDelta: undefined })) : null },
      { number: 12, title: 'Therapy comparison and uncertainty', present: Boolean(rescue), content: rescue ? { comparison: rescue.comparison, uncertainty: prediction?.uncertainty ?? null } : null },
      { number: 13, title: 'AI interpretation and hypothesis', present: false, content: null, note: 'Interpretations are generated on request and are not stored in the run record. Ask for one from the interpretation panel; it will be audited.' },
      /*
       * Like section 13, this one is produced on request rather than by the
       * run, so its absence means "nobody asked" and not "nothing was worth
       * measuring". Those are different claims and the second one is a
       * scientific statement, so the distinction is written down rather than
       * left to the reader.
       */
      {
        number: 14,
        title: 'Suggested validation experiment',
        present: Boolean(plan),
        content: plan,
        ...(plan
          ? {}
          : {
              note:
                'No validation experiment has been designed for this prediction yet. One is generated on request from the ' +
                'Validate screen; this is not a finding that no experiment would be informative.',
            }),
      },
      { number: 15, title: 'Prediction versus observation', present: comparisons.length > 0, content: comparisons },
      { number: 16, title: 'Limitations', present: true, content: collectLimitations(services, analysis, prediction, loadedCase) },
      { number: 17, title: 'Reproducibility manifest and references', present: Boolean(run?.manifest ?? analysis?.manifest), content: run?.manifest ?? analysis?.manifest ?? null },
    ],
  };
}

function collectLimitations(
  services: Services,
  analysis: AnalysisArtefacts | null,
  prediction: PredictionArtefacts | null,
  loadedCase: ReturnType<Services['catalogue']['cases']['get']>,
): string[] {
  const limitations: string[] = [];
  if (loadedCase) limitations.push(loadedCase.simulationNotice);
  limitations.push(services.catalogue.resources.provenance.circularityNote);
  if (services.catalogue.modelPack) {
    limitations.push(services.catalogue.modelPack.card.whatTheMetricsMean);
    limitations.push(...services.catalogue.modelPack.card.limitations);
  } else {
    limitations.push('No propagation model pack is installed, so no spatial prediction was made.');
  }
  if (analysis) limitations.push(...analysis.manifest.warnings);
  if (prediction) {
    limitations.push(prediction.propagation.stageCaveat);
    limitations.push(prediction.uncertainty.rule);
    if (prediction.uncertainty.domain.status !== 'in-domain') {
      limitations.push(prediction.uncertainty.domain.explanation);
    }
  }
  return [...new Set(limitations.filter((entry) => entry && entry.trim() !== ''))];
}
