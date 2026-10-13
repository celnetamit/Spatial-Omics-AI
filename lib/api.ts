/**
 * The typed client for the lab API.
 *
 * Two things it does that are worth naming.
 *
 * It keeps the *kinds* of failure distinct, because the UI has to react
 * differently: a tier refusal wants a link to the portal, a capacity refusal
 * wants a countdown, an authentication failure wants the sign-in screen, and an
 * invalid request is a bug in this file. Collapsing them into one `catch` puts
 * "try again in a moment" in front of somebody whose session has expired.
 *
 * And it polls runs rather than holding a request open. A propagation run takes
 * tens of seconds; on a held connection that looks like a hung page long before
 * it looks like a running job, and a class of thirty would exhaust the server's
 * sockets before its CPU.
 */

import type { Confidence, LabMode, ResultLabel } from '../types';

export interface ApiErrorBody {
  code: string;
  message: string;
  requestId: string;
  fieldErrors: { field: string; message: string }[];
  recoverable: boolean;
  suggestedAction: string;
  retryAfterSeconds?: number;
}

export class ApiError extends Error {
  readonly code: string;
  readonly requestId: string;
  readonly fieldErrors: { field: string; message: string }[];
  readonly recoverable: boolean;
  readonly suggestedAction: string;
  readonly retryAfterSeconds: number | null;
  readonly status: number;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.code;
    this.requestId = body.requestId;
    this.fieldErrors = body.fieldErrors ?? [];
    this.recoverable = body.recoverable;
    this.suggestedAction = body.suggestedAction ?? '';
    this.retryAfterSeconds = body.retryAfterSeconds ?? null;
  }

  get isAuthProblem(): boolean {
    return this.code === 'UNAUTHENTICATED';
  }
  get isTierProblem(): boolean {
    return this.code === 'TIER_REQUIRED';
  }
  get isCapacityProblem(): boolean {
    return this.code === 'CAPACITY' || this.code === 'RATE_LIMITED';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: 'same-origin',
      ...init,
      headers: {
        accept: 'application/json',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
    });
  } catch {
    // A network failure is not a refusal, and the difference matters: only one
    // of them is worth retrying, and the user's work is untouched either way.
    throw new ApiError(0, {
      code: 'UPSTREAM_UNAVAILABLE',
      message: 'The lab could not be reached. Check your connection and try again.',
      requestId: 'client',
      fieldErrors: [],
      recoverable: true,
      suggestedAction: 'Nothing was lost — the work is on the server.',
      retryAfterSeconds: 5,
    });
  }

  if (response.status === 204) return undefined as T;

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    const error = (body as { error?: ApiErrorBody } | null)?.error;
    throw new ApiError(
      response.status,
      error ?? {
        code: 'INTERNAL',
        message: `The lab returned ${response.status} without an explanation.`,
        requestId: 'unknown',
        fieldErrors: [],
        recoverable: response.status >= 500,
        suggestedAction: '',
      },
    );
  }

  return body as T;
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface SessionUser {
  userId: string;
  displayName: string;
  roles: string[];
  tier: LabMode;
  isReviewer: boolean;
  researchConsent: boolean;
  availableModes: LabMode[];
  /** For each mode this account cannot open, the server's reason. */
  lockedModes?: Partial<Record<LabMode, string>>;
}

export interface LabMeta {
  version: string;
  commit: string;
  portal: { loginUrl: string; homeUrl: string; labUrl?: string };
  authEnabled: boolean;
  modes: { id: LabMode; label: string; summary: string }[];
  ai: { available: boolean; unavailableReason: string | null; role: string };
  modelPack: {
    modelId: string;
    version: string;
    trainedOn: Record<string, unknown>;
    whatTheMetricsMean: string;
    limitations: string[];
  } | null;
  modelPackMissing: string | null;
  drugEvidence: {
    packId: string; version: string; retrievedAt: string;
    source: { database: string; api: string; licence: string; citation: string };
    compounds: number;
  } | null;
  resources: { version: string; statement: string; circularityNote: string; sources: string[] };
  researchExports: boolean;
  researchBoundary: string;
  problems: { severity: string; component: string; message: string }[];
}

export interface CaseSummary {
  caseId: string;
  title: string;
  description: string;
  simulationNotice: string;
  role: 'primary' | 'reference';
  comparableWith: string[];
  observations: number;
  features: number;
  organism: string;
  tissue: string;
  condition: string;
  assay: string;
  platform: string;
  resolution: string;
  coordinateUnit: string;
  licence: string;
  accessStatus: string;
  origin: string;
  checksum: string;
  revision: string;
  generatedAt: string;
  cellTypes: string[];
  regions: string[];
}

export interface ProjectSummary {
  projectId: string;
  ownerId: string;
  title: string;
  organism: string;
  tissue: string;
  condition: string;
  studyQuestion: string;
  mode: LabMode;
  datasetId: string | null;
  datasetKind: 'bundled-case' | 'upload' | null;
  referenceDatasetId: string | null;
  createdAt: string;
  updatedAt: string;
  state: string;
  sideStates: string[];
  completedStages: string[];
  failedStages: string[];
  runs: {
    runId: string; kind: string; status: string; createdAt: string;
    finishedAt: string | null; progress: number; currentStage: string | null;
  }[];
}

export interface RunStatus {
  runId: string;
  projectId: string;
  kind: string;
  status: 'queued' | 'running' | 'complete' | 'failed' | 'cancelled';
  progress: number;
  currentStage: string | null;
  completedStages: string[];
  message: string | null;
  createdAt: string;
  finishedAt: string | null;
  error: { code: string; message: string; recoverable: boolean } | null;
  warnings: string[];
}

export interface Layer {
  id: string;
  name: string;
  values: number[];
  categories: string[] | null;
  unit: string;
  label: ResultLabel;
  method: string;
  scale: 'sequential' | 'diverging' | 'categorical';
  range: [number, number];
  missing: number[];
  note: string | null;
}

export interface QcCheck {
  id: string;
  name: string;
  kind: string;
  verdict: 'pass' | 'warning' | 'fail';
  measured: string;
  criterion: string;
  rationale: string;
  blocksPrediction: boolean;
}

export interface FeatureStatistic {
  featureId: string; symbol: string; modality: string; group: string;
  groupMean: number; restMean: number; logDifference: number;
  statistic: number; pValue: number; qValue: number; effectSize: number;
  detectionInGroup: number; detectionInRest: number; nGroup: number; nRest: number;
}

export interface RunResults {
  runId: string;
  kind: string;
  status: string;
  mode: LabMode;
  observations: { ids: string[]; x: number[]; y: number[]; coordinateUnit: string } | null;
  analysis: AnalysisResults | null;
  prediction: PredictionResults | null;
  rescue: RescueResults | null;
  warnings: string[];
  error: { code: string; message: string } | null;
}

export interface AnalysisResults {
  qc: {
    verdict: 'pass' | 'warning' | 'fail';
    predictionEligible: boolean;
    predictionBlockers: string[];
    eligibility: string;
    summary: {
      observations: number; features: number;
      medianCountsPerObservation: number; medianFeaturesPerObservation: number;
      sparsity: number; medianNearestNeighbourDistance: number; coordinateUnit: string;
    };
    recommendedActions: string[];
    checks: QcCheck[];
  };
  comparability: { comparable: boolean; reasons: string[]; warnings: string[]; sharedFeatures: string[] } | null;
  preprocessing: {
    warnings: string[];
    parameters?: Record<string, unknown>;
    keptObservations?: number;
    keptFeatures?: number;
    explainedVariance?: number[];
  };
  annotation: {
    source: string; classes: string[]; unassigned: number; exploratory: boolean;
    summary: { className: string; count: number; fraction: number; medianConfidence: number }[];
    panelCoverage: { className: string; present: string[]; absent: string[] }[] | null;
  };
  regions: { classes: string[]; source: string };
  domains: { domainCount: number; spatialCoherence: number; sizes: number[] } | null;
  differential: { results: FeatureStatistic[]; skipped: string[]; truncated: boolean; total: number };
  pathways: {
    pathwayId: string; name: string; source: string; found: string[]; missing: string[];
    separation: number;
    byGroup: { group: string; n: number; mean: number; sd: number }[];
    nullZ: number; pValue: number; qValue: number;
  }[];
  states: { stateId: string; name: string; dominantCount: number; found: string[]; missing: string[] }[];
  graph: {
    graphId: string; method: string; checksum?: string; parameters?: Record<string, unknown>;
    diagnostics: {
      physicalEdges: number; biologicalEdges: number; meanDegree: number; medianDegree: number;
      isolatedNodes: number; components: number; largestComponentFraction: number;
      medianEdgeLength: number; maximumEdgeLength: number; symmetric: boolean; warnings: string[];
    };
    edgeSample?: { source: number; target: number; type: string }[];
  };
  enrichment: { labels: string[]; observed: number[]; zScore: number[]; qValue: number[]; permutations: number };
  autocorrelation: { featureId: string; moransI: number; gearysC: number; pValue: number; qValue: number }[];
  communication: {
    results: {
      pairId: string; ligand: string; receptor: string; pathway: string; mode: string;
      totalScore: number; pValue: number; qValue: number; incomplete: string[];
    }[];
    byClass: Record<string, { source: string; target: string; score: number; edges: number }[]>;
  };
  manifest: Record<string, unknown>;
}

export interface PredictionResults {
  perturbationId: string;
  direct: {
    targetNodes: number[];
    terms: {
      observationIndex: number; targetAvailability: number; doseEffect: number;
      timeEffect: number; cellSensitivity: number; evidenceModifier: number; product: number;
    }[];
    warnings: string[];
    quantitative: boolean;
    method: string;
  };
  propagation: {
    available: boolean;
    unavailableReason: string | null;
    modelId: string; modelVersion: string; graphId: string; members: number;
    stages: { stage: number; label: string; nodeMeanDelta: number[] }[];
    stageCaveat: string;
  };
  altered: {
    nodeMeanDelta: number[];
    byClass: { className: string; count: number; nodeMeanDelta: number[] }[];
    meanMagnitude: number;
    changedFraction: number;
  };
  adverse: {
    components: {
      signatureId: string; name: string; category: string; meanDelta: number;
      nonTargetMeanDelta: number; affectedFraction: number;
      byClass: { className: string; meanDelta: number; count: number }[];
      interpretation: string; source: string;
    }[];
    offTargets: {
      symbol: string; engagement: number; selectivityFold: number | null;
      measured: boolean; source: string; note: string;
    }[];
    burden: number;
    hotspots: number[];
    warnings: string[];
    notInterpretable: string | null;
  };
  recovery: {
    features: {
      symbol: string; reference: number; disease: number; treated: number;
      recovery: number; verdict: string; overshootFraction: number;
    }[];
    meanRecovery: number;
    counts: Record<string, number>;
    overshooting: string[];
    worsening: string[];
    comparable: boolean;
    note: string;
  } | null;
  uncertainty: {
    median: number; p90: number; highDispersionFraction: number; members: number;
    confidence: Confidence; rule: string;
    calibration: { nominal: number; empirical: number; scaleFactor: number; sampleCount: number; note: string } | null;
    domain: {
      distance: number; status: string;
      contributors: { name: string; z: number; value: number; trainingMean: number }[];
      explanation: string;
    };
  };
  mechanisticReference: {
    ran: boolean; reason: string;
    agreement: { pearson: number; rmse: number; perStageRmse: number[] } | null;
    nodeMeanDelta: number[] | null;
  };
  confidence: Confidence;
  nodeSymbols: string[];
}

export interface RescueResults {
  drivers: { symbol: string; direction: 'up' | 'down'; magnitude: number }[];
  eligible: CandidateSummary[];
  excluded: CandidateSummary[];
  simulated: {
    candidateId: string; name: string; status: 'complete' | 'failed';
    failureReason: string | null; concentrationNm: number | null;
    components: { id: string; name: string; value: number; direction: string; unit: string; method: string }[];
    adverseBurden: number;
    resistance: number | null;
    resistanceDetail: { symbol: string; delta: number; because: string }[];
    uncertainty: number;
    confidence: Confidence;
    nodeMeanDelta: number[];
    warnings: string[];
  }[];
  comparison: {
    table: {
      candidateId: string; name: string;
      normalised: Record<string, number>; raw: Record<string, number>;
      adverseBurden: number; uncertainty: number; confidence: Confidence;
    }[];
    paretoFront: string[];
    composite: { candidateId: string; score: number }[] | null;
    policy: {
      id: string; version: string; approvedBy: string; approvedAt: string;
      benefitWeights: Record<string, number>; riskWeights: Record<string, number>;
      uncertaintyWeight: number; justification: string;
    } | null;
    ranking: string[] | null;
    noClearWinner: string | null;
    ties: { a: string; b: string; reason: string }[];
    degenerateComponents: { id: string; name: string; rawSpread: number; note: string }[];
    method: string;
  };
  retrievalNote: string;
  simulationNote: string;
}

export interface CandidateSummary {
  candidateId: string;
  name: string;
  therapyClass: string;
  target: string;
  mechanism: string;
  actionType: string;
  evidence: { kind: string; source: string; identifier: string; summary: string; evidenceClass: string; retrievedAt: string }[];
  suggestedConcentrationNm: number | null;
  concentrationRationale: string;
  eligibility: { eligible: boolean; reasons: string[]; failed: string[]; confidence: Confidence };
}

export interface PerturbationOptions {
  branches: (
    | {
        id: 'molecular-genetic'; available: boolean; reason: string | null;
        targets: { symbol: string; pathway: string; role: string; supported: boolean }[];
        operators: { id: string; label: string; semantics: string }[];
      }
    | {
        id: 'drug'; available: boolean; reason: string | null;
        compounds: {
          drugId: string; name: string; target: string; therapyClass: string; actionType: string;
          mechanism: string; medianPotencyNm: number | null; testedRangeNm: [number, number] | null;
          measurements: number; documents: number; targetInFeatureSpace: boolean;
          simulatable: boolean; notSimulatableReason: string | null;
        }[];
      }
  )[];
  selection: { cellTypes: string[]; regions: string[] };
  modelPack: { modelId: string; version: string } | null;
  modelPackMissing: string | null;
}

export interface PerturbationDefinition {
  id: string;
  createdAt: string;
  branch: string;
  spec: Record<string, unknown>;
  selection: { mode: string; description: string; resolvedIndices: number[]; observationIds?: string[] };
  eligibility: { decision: 'quantitative' | 'exploratory' | 'blocked'; reasons: string[]; remedies: string[]; confidence: Confidence };
  checksum: string;
  modelPackId: string;
  modelPackVersion: string;
}

export interface InterpretationPayload {
  interpretation: {
    available: boolean;
    response: {
      findings: { statement: string; citedClaims: string[] }[];
      mechanism: { statement: string; citedClaims: string[] }[];
      candidateComparison: { statement: string; citedClaims: string[] }[];
      limitations: string[];
      hypothesis: { statement: string; howToTest: string } | null;
      abstained: boolean;
      abstentionReason: string | null;
    } | null;
    message: string;
    detail: string | null;
    model: string;
    promptVersion: string;
    policyVersion: string;
    gate: { accepted: boolean; rejections: { code: string; detail: string }[] } | null;
    milliseconds: number;
  };
  evidence: {
    claims: {
      id: string; label: ResultLabel; statement: string;
      values: { name: string; value: number; unit: string }[];
      method: string; confidence: Confidence;
    }[];
    limitations: string[];
    missingEvidence: string[];
    uncertainty: { confidence: Confidence; rule: string; domainStatus: string; domainExplanation: string };
    notInterpretable: string | null;
  };
}

export interface ValidationPlanPayload {
  plan: {
    question: string;
    assay: { category: string; name: string; measures: string[]; spatial: boolean; cannotShow: string };
    measure: string[];
    expectedIfCorrect: string;
    expectedIfWrong: string;
    rationale: string;
    alternativesConsidered: { assay: string; why: string }[];
    limitations: string[];
    confidence: Confidence;
    testsPrediction: string;
    notAClinicalProtocol: string;
  } | null;
  message: string | null;
}

export interface ReportPayload {
  report: {
    generatedAt: string;
    sections: { number: number; title: string; present: boolean; content: unknown; note?: string }[];
  };
  machineReadable: boolean;
  note: string;
}

// ---------------------------------------------------------------------------

export const api = {
  signIn: (token: string | null) =>
    request<{ user: SessionUser; authDisabled: boolean }>('/api/v1/auth/session', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),
  session: () => request<{ user: SessionUser | null; authDisabled: boolean }>('/api/v1/session'),
  signOut: () => request<void>('/api/v1/auth/sign-out', { method: 'POST' }),

  meta: () => request<LabMeta>('/api/v1/meta'),
  cases: () => request<{ cases: CaseSummary[] }>('/api/v1/cases'),
  registry: () => request<{ version: string; records: ParameterRecord[]; note: string }>('/api/v1/registry'),
  modelCard: () => request<ModelCard>('/api/v1/model-card'),
  resources: () => request<ResourcePayload>('/api/v1/resources'),
  drugs: () => request<DrugPayload>('/api/v1/drugs'),

  projects: () => request<{ projects: ProjectSummary[] }>('/api/v1/projects'),
  project: (id: string) => request<{ project: ProjectSummary }>(`/api/v1/projects/${id}`),
  createProject: (body: Record<string, unknown>) =>
    request<{ project: ProjectSummary }>('/api/v1/projects', { method: 'POST', body: JSON.stringify(body) }),
  setMode: (id: string, mode: LabMode) =>
    request<{ project: ProjectSummary }>(`/api/v1/projects/${id}/mode`, {
      method: 'PATCH',
      body: JSON.stringify({ mode }),
    }),

  uploadDataset: (id: string, body: Record<string, unknown>) =>
    request<{ project: ProjectSummary; dataset: Record<string, unknown>; warnings: string[] }>(
      `/api/v1/projects/${id}/datasets`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  perturbationOptions: (id: string) =>
    request<PerturbationOptions>(`/api/v1/projects/${id}/perturbation-options`),
  createPerturbation: (id: string, body: Record<string, unknown>) =>
    request<{ definition: PerturbationDefinition; blocked: boolean; message?: string }>(
      `/api/v1/projects/${id}/perturbations`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  submitRun: (id: string, body: Record<string, unknown>) =>
    request<{ runId: string; status: string }>(`/api/v1/projects/${id}/runs`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  run: (runId: string) =>
    request<{ run: RunStatus; queue: { running: number; waiting: number } }>(`/api/v1/runs/${runId}`),
  cancelRun: (runId: string) =>
    request<{ cancelled: boolean; note: string }>(`/api/v1/runs/${runId}/cancel`, { method: 'POST' }),
  results: (runId: string) => request<RunResults>(`/api/v1/runs/${runId}/results`),
  layer: (runId: string, kind: string, key: string, stage?: number) => {
    const params = new URLSearchParams({ kind, key });
    if (stage !== undefined) params.set('stage', String(stage));
    return request<{ layer: Layer }>(`/api/v1/runs/${runId}/layer?${params.toString()}`);
  },
  interpretation: (runId: string, stage: 'baseline' | 'final') =>
    request<InterpretationPayload>(`/api/v1/runs/${runId}/interpretation`, {
      method: 'POST',
      body: JSON.stringify({ stage }),
    }),
  validationPlan: (runId: string) =>
    request<ValidationPlanPayload>(`/api/v1/runs/${runId}/validation-plan`, { method: 'POST', body: '{}' }),
  validationComparison: (runId: string, observed: Record<string, number>, label: string) =>
    request<{ comparison: Record<string, unknown>; artefact: string }>(
      `/api/v1/runs/${runId}/validation-comparison`,
      { method: 'POST', body: JSON.stringify({ observed, label }) },
    ),
  report: (runId: string) => request<ReportPayload>(`/api/v1/runs/${runId}/report`),
  artefacts: (runId: string, name?: string) =>
    request<{ artefacts?: string[]; name?: string; artefact?: unknown }>(
      `/api/v1/runs/${runId}/artefacts${name ? `?name=${encodeURIComponent(name)}` : ''}`,
    ),

  agreementStatus: () => request<AgreementStatus>('/api/v1/governance/agreement'),
  signAgreement: (body: Record<string, unknown>) =>
    request<unknown>('/api/v1/governance/agreement', { method: 'POST', body: JSON.stringify(body) }),
  sendFeedback: (body: Record<string, unknown>) =>
    request<unknown>('/api/v1/governance/feedback', { method: 'POST', body: JSON.stringify(body) }),
  submitReview: (body: Record<string, unknown>) =>
    request<unknown>('/api/v1/governance/review', { method: 'POST', body: JSON.stringify(body) }),
};

export interface AgreementStatus {
  status: 'signed' | 'not-signed' | 'unknown';
  signed: boolean;
  signedVersion?: string | null;
  signedAt?: string | null;
  reason: string | null;
  portalReachable: boolean;
  endpointPresent: boolean | null;
  version: string;
  fingerprint: string;
}

export interface ParameterRecord {
  parameterId: string; name: string; symbol: string | null; unit: string | null;
  kind: string; defaultValue: number | string | null; rangeRule: string;
  source: string | null; context: string; editableBy: string; confidence: string;
  version: string; approvedBy: string; approvedAt: string; subsystem: string; notes?: string;
}

export interface ModelCard {
  modelId: string; version: string; createdAt: string;
  architecture: Record<string, unknown>;
  trainingData: Record<string, unknown>;
  whatTheMetricsMean: string;
  metrics: Record<string, Record<string, number | number[] | string>>;
  baselineNotes: Record<string, string>;
  uncertainty: Record<string, unknown>;
  trainingHistory: unknown[];
  limitations: string[];
}

export interface ResourcePayload {
  version: string;
  provenance: { statement: string; circularityNote: string; sources: string[] };
  pathways: { id: string; name: string; source: string; members: number }[];
  states: { id: string; name: string; source: string; members: number }[];
  ligandReceptor: { id: string; ligand: string; receptorSubunits: string[]; source: string; mode: string; pathway: string }[];
  markerPanel: { id: string; version: string; source: string; positive: Record<string, string[]>; negative?: Record<string, string[]> };
  network: {
    nodes: { symbol: string; pathway: string; role: string; basal: number; tau: number; uniprot?: string }[];
    signals: { ligand: string; receptor: string; diffusionLength: number; potency: number; pathway: string }[];
  };
}

export interface DrugPayload {
  packId: string; version: string; retrievedAt: string;
  source: { database: string; api: string; licence: string; citation: string };
  whatIsRetrievedVersusCurated: string;
  records: Record<string, unknown>[];
  problems: string[];
}

/**
 * Polls a run to completion.
 *
 * The interval widens as the run goes on: a run that finishes in three seconds
 * should feel immediate, and one that takes four minutes should not generate
 * two hundred requests to say so.
 */
export async function awaitRun(
  runId: string,
  onProgress?: (status: RunStatus) => void,
  signal?: AbortSignal,
): Promise<RunStatus> {
  let delay = 600;
  for (;;) {
    if (signal?.aborted) throw new ApiError(0, {
      code: 'CANCELLED', message: 'Stopped watching this run.', requestId: 'client',
      fieldErrors: [], recoverable: true, suggestedAction: '',
    });
    const { run } = await api.run(runId);
    onProgress?.(run);
    if (run.status === 'complete' || run.status === 'failed' || run.status === 'cancelled') return run;
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(4000, Math.round(delay * 1.25));
  }
}
