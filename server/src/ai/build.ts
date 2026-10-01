/**
 * Assembling the evidence object from stored artefacts — §13.2.
 *
 * Every claim gets a stable id the model must cite, and every number in a claim
 * is listed separately so the gate can check the model's arithmetic against it.
 * Claims are built from what a stage actually produced: a missing stage
 * produces a line in `missingEvidence` rather than an absent claim, because
 * "the adverse analysis did not run" and "there were no adverse effects" are
 * different findings and a model given neither will guess.
 */

import type { Confidence } from '@engine/core/labels';
import type { Store } from '../store';
import type { AnalysisArtefacts } from '../jobs/analysis';
import type { PredictionArtefacts } from '../jobs/prediction';
import type { RescueArtefacts } from '../jobs/rescue';
import { emptyEvidence, type EvidenceClaim, type EvidenceObject } from './evidence';

export function buildEvidence(
  store: Store,
  runId: string,
  stage: 'baseline' | 'final' | 'validation-plan',
): EvidenceObject {
  const evidence = emptyEvidence(runId);
  const run = store.getRun(runId);
  const project = run ? store.getProject(run.projectId) : undefined;
  const analysis = store.readArtefact<AnalysisArtefacts>(runId, 'analysis');
  const prediction = store.readArtefact<PredictionArtefacts>(runId, 'prediction');
  const rescue = store.readArtefact<RescueArtefacts>(runId, 'rescue');

  if (!analysis) {
    return {
      ...evidence,
      notInterpretable:
        'This run has no completed analysis, so there is nothing to interpret. An interpretation of an empty result would be invention.',
    };
  }

  evidence.dataset = {
    datasetId: analysis.manifest.datasets[0]?.datasetId ?? '',
    organism: project?.organism ?? '',
    tissue: project?.tissue ?? '',
    condition: project?.condition ?? '',
    assay: '',
    observations: analysis.qc.summary.observations,
    features: analysis.qc.summary.features,
    provenanceNotice: null,
  };

  const claims: EvidenceClaim[] = [];
  const push = (claim: EvidenceClaim): void => {
    claims.push(claim);
  };

  // -- QC --------------------------------------------------------------------

  push({
    id: 'qc.verdict',
    label: 'COMPUTED',
    statement: `Quality control returned ${analysis.qc.verdict.toUpperCase()} and the dataset is ${analysis.qc.predictionEligible ? '' : 'not '}eligible for predictive simulation.`,
    values: [
      { name: 'observations', value: analysis.qc.summary.observations, unit: 'cells' },
      { name: 'features', value: analysis.qc.summary.features, unit: 'features' },
      { name: 'median counts per observation', value: analysis.qc.summary.medianCountsPerObservation, unit: 'counts' },
      { name: 'sparsity', value: analysis.qc.summary.sparsity, unit: 'fraction of zeros' },
      { name: 'median nearest-neighbour distance', value: analysis.qc.summary.medianNearestNeighbourDistance, unit: analysis.qc.summary.coordinateUnit },
    ],
    method: 'qc.metrics',
    confidence: 'high',
  });

  // -- composition -----------------------------------------------------------

  for (const entry of analysis.annotation.summary) {
    push({
      id: `composition.${slug(entry.className)}`,
      label: analysis.annotation.source === 'provided' ? 'OBSERVED' : 'COMPUTED',
      statement: `${entry.className} accounts for ${(entry.fraction * 100).toFixed(1)}% of annotated observations.`,
      values: [
        { name: 'count', value: entry.count, unit: 'cells' },
        { name: 'fraction', value: entry.fraction, unit: 'fraction' },
      ],
      method: analysis.annotation.source === 'provided' ? 'annotate.provided' : 'annotate.marker-panel',
      confidence: analysis.annotation.exploratory ? 'exploratory' : 'high',
    });
  }

  // -- differential ----------------------------------------------------------

  const topMarkers = analysis.differential.results
    .filter((result) => Number.isFinite(result.qValue) && result.qValue < 0.05 && result.logDifference > 0)
    .sort((a, b) => b.effectSize - a.effectSize)
    .slice(0, 24);

  for (const marker of topMarkers) {
    push({
      id: `marker.${slug(marker.group)}.${slug(marker.symbol)}`,
      label: 'COMPUTED',
      statement: `${marker.symbol} is higher in ${marker.group} than in the rest of the section.`,
      values: [
        { name: 'log difference', value: marker.logDifference, unit: 'log units' },
        { name: 'effect size', value: marker.effectSize, unit: "Hedges' g" },
        { name: 'q', value: marker.qValue, unit: 'BH-adjusted p' },
        { name: 'n in group', value: marker.nGroup, unit: 'cells' },
      ],
      method: 'baseline.differential',
      confidence: 'high',
    });
  }

  // -- pathways --------------------------------------------------------------

  for (const pathway of analysis.pathways.results) {
    if (!Number.isFinite(pathway.separation)) continue;
    const highest = [...pathway.byGroup].sort((a, b) => b.mean - a.mean)[0];
    const lowest = [...pathway.byGroup].sort((a, b) => a.mean - b.mean)[0];
    push({
      id: `pathway.${slug(pathway.pathwayId)}`,
      label: 'COMPUTED',
      statement:
        `${pathway.name}` +
        (highest && lowest && highest.group !== lowest.group
          ? ` is highest in ${highest.group} and lowest in ${lowest.group}.`
          : ' activity across the annotated groups.'),
      values: [
        { name: 'between-group variance share', value: pathway.separation, unit: 'eta squared' },
        { name: 'null z', value: pathway.nullZ, unit: 'z against size-matched random sets' },
        { name: 'q', value: pathway.qValue, unit: 'BH-adjusted permutation p' },
        ...(highest ? [{ name: `mean in ${highest.group}`, value: highest.mean, unit: 'weighted mean z' }] : []),
        ...(lowest ? [{ name: `mean in ${lowest.group}`, value: lowest.mean, unit: 'weighted mean z' }] : []),
      ],
      method: 'baseline.pathway-activity',
      confidence: 'high',
    });
  }

  // -- neighbourhood ---------------------------------------------------------

  const labels = analysis.enrichment.labels;
  for (let a = 0; a < labels.length; a += 1) {
    for (let b = a; b < labels.length; b += 1) {
      const cell = a * labels.length + b;
      const z = analysis.enrichment.zScore[cell];
      const q = analysis.enrichment.qValue[cell];
      if (!Number.isFinite(z) || Math.abs(z as number) < 2 || !Number.isFinite(q) || (q as number) > 0.05) continue;
      push({
        id: `neighbourhood.${slug(labels[a] as string)}.${slug(labels[b] as string)}`,
        label: 'COMPUTED',
        statement:
          `${labels[a]} and ${labels[b]} are found adjacent ${(z as number) > 0 ? 'more' : 'less'} often than a label permutation predicts. ` +
          'This is a spatial association, not evidence of signalling.',
        values: [
          { name: 'z', value: z as number, unit: 'z against the permutation null' },
          { name: 'q', value: q as number, unit: 'BH-adjusted permutation p' },
        ],
        method: 'spatial.neighbourhood-enrichment',
        confidence: 'high',
      });
    }
  }

  // -- communication ---------------------------------------------------------

  for (const result of analysis.communication.results) {
    if (!Number.isFinite(result.totalScore)) continue;
    if (!Number.isFinite(result.qValue) || result.qValue > 0.1) continue;
    push({
      id: `communication.${slug(result.pairId)}`,
      label: 'COMPUTED',
      statement: `${result.ligand} to ${result.receptor} is a candidate interaction in this section, by spatially constrained optimal transport.`,
      values: [
        { name: 'total transported', value: result.totalScore, unit: 'transported units' },
        { name: 'q', value: result.qValue, unit: 'BH-adjusted permutation p' },
      ],
      method: 'spatial.communication',
      confidence: 'moderate',
    });
  }

  // -- prediction ------------------------------------------------------------

  if (stage !== 'baseline') {
    if (prediction) {
      const definition = store.getDefinition(prediction.perturbationId);
      if (definition) {
        evidence.perturbation = {
          description: describeDefinition(definition),
          branch: definition.branch,
          decision: definition.eligibility.decision,
          eligibilityReasons: definition.eligibility.reasons,
        };
      }

      push({
        id: 'prediction.summary',
        label: 'PREDICTED',
        statement: prediction.propagation.available
          ? 'The predicted altered tissue, after the direct response and the spatial propagation.'
          : 'The direct response only; no spatial propagation was computed.',
        values: [
          { name: 'mean change magnitude', value: prediction.altered.meanMagnitude, unit: 'activity units' },
          { name: 'fraction of cells changed', value: prediction.altered.changedFraction, unit: 'fraction' },
        ],
        method: prediction.propagation.available
          ? `${prediction.propagation.modelId}@${prediction.propagation.modelVersion}`
          : prediction.direct.method,
        confidence: prediction.confidence,
      });

      const moved = prediction.altered.nodeMeanDelta
        .map((value, index) => ({ symbol: prediction.nodeSymbols[index] as string, value }))
        .filter((entry) => Math.abs(entry.value) > 0.01)
        .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
        .slice(0, 20);

      for (const entry of moved) {
        push({
          id: `delta.${slug(entry.symbol)}`,
          label: 'PREDICTED',
          statement: `${entry.symbol} ${entry.value > 0 ? 'rises' : 'falls'} across the section after the perturbation.`,
          values: [{ name: 'mean change', value: entry.value, unit: 'activity units' }],
          method: 'propagation rollout, final stage',
          confidence: prediction.confidence,
        });
      }

      for (const component of prediction.adverse.components) {
        push({
          id: `adverse.${slug(component.signatureId)}`,
          label: 'PREDICTED',
          statement: `${component.name}: ${component.interpretation}`,
          values: [
            { name: 'mean change', value: component.meanDelta, unit: 'signature units' },
            { name: 'mean change in non-target cells', value: component.nonTargetMeanDelta, unit: 'signature units' },
            { name: 'fraction affected', value: component.affectedFraction, unit: 'fraction' },
          ],
          method: prediction.adverse.method,
          confidence: prediction.confidence,
        });
      }

      evidence.uncertainty = {
        confidence: prediction.uncertainty.confidence,
        rule: prediction.uncertainty.rule,
        domainStatus: prediction.uncertainty.domain.status,
        domainExplanation: prediction.uncertainty.domain.explanation,
      };

      if (prediction.mechanisticReference.ran && prediction.mechanisticReference.agreement) {
        push({
          id: 'mechanism.agreement',
          label: 'COMPUTED',
          statement:
            'Agreement between the predictive model and the mechanistic simulator that generated this bundled case. ' +
            'This is a simulated reference, not an observation.',
          values: [
            { name: 'correlation', value: prediction.mechanisticReference.agreement.pearson, unit: 'Pearson r' },
            { name: 'RMSE', value: prediction.mechanisticReference.agreement.rmse, unit: 'activity units' },
          ],
          method: 'mechanistic reaction-diffusion solve',
          confidence: 'high',
        });
      }
    } else {
      evidence.missingEvidence.push(
        'No prediction has been run for this project, so nothing can be said about the perturbation’s effect.',
      );
    }

    if (rescue) {
      for (const entry of rescue.simulated) {
        if (entry.status !== 'complete') {
          evidence.missingEvidence.push(`${entry.name} failed to simulate: ${entry.failureReason ?? 'unknown reason'}.`);
          continue;
        }
        push({
          id: `rescue.${slug(entry.candidateId)}`,
          label: 'PREDICTED',
          statement: `${entry.name}, simulated against the altered tissue state.`,
          values: [
            ...entry.components.map((component) => ({
              name: component.name,
              value: component.value,
              unit: component.unit,
            })),
            { name: 'adverse burden', value: entry.adverseBurden, unit: 'mean of rising signatures' },
            ...(entry.resistance !== null
              ? [{ name: 'adaptive response', value: entry.resistance, unit: 'mean rise in feedback nodes' }]
              : []),
          ],
          method: 'rescue simulation',
          confidence: entry.confidence,
        });
      }

      if (rescue.comparison.noClearWinner) {
        push({
          id: 'rescue.no-clear-winner',
          label: 'COMPUTED',
          statement: rescue.comparison.noClearWinner,
          values: [],
          method: rescue.comparison.method,
          confidence: 'high',
        });
      }
      evidence.vocabulary.candidates = rescue.simulated.map((entry) => entry.name);
    } else {
      evidence.missingEvidence.push('No rescue candidates have been simulated for this project.');
    }
  }

  // -- vocabulary and limitations -------------------------------------------

  evidence.claims = claims;
  evidence.vocabulary.features = [
    ...new Set([
      ...(prediction?.nodeSymbols ?? []),
      ...analysis.differential.results.map((result) => result.symbol),
    ]),
  ];
  evidence.vocabulary.cellTypes = analysis.annotation.classes;
  evidence.vocabulary.regions = analysis.regions.classes;
  evidence.vocabulary.pathways = analysis.pathways.results.map((result) => result.name);

  evidence.limitations = [
    ...analysis.manifest.warnings,
    ...(prediction ? [prediction.propagation.stageCaveat, prediction.uncertainty.rule] : []),
  ].filter((entry) => entry && entry.trim() !== '');

  const overall: Confidence = prediction?.confidence ?? 'high';
  if (overall === 'not-interpretable') {
    evidence.notInterpretable =
      `This run is not interpretable: ${prediction?.uncertainty.rule ?? 'the prediction could not be produced.'}`;
  }

  return evidence;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function describeDefinition(definition: NonNullable<ReturnType<Store['getDefinition']>>): string {
  const spec = definition.spec;
  if (spec.branch === 'molecular-genetic') {
    return `${spec.operator.replace(/-/g, ' ')} of ${spec.target} in ${definition.selection.description}`;
  }
  return `${spec.drugName} at ${spec.concentration} ${spec.concentrationUnit} for ${spec.exposureTime} ${spec.exposureTimeUnit}, ${spec.actionType} of ${spec.target}, in ${definition.selection.description}`;
}
