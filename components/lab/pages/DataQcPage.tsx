/**
 * Data and QC — §6.3 and §11.2.
 *
 * §6.3 wants the analysis verdict and the *prediction eligibility* shown
 * separately, because they have different answers: a tissue can be perfectly
 * good for describing a baseline and still be outside the domain any
 * propagation model was fitted on. A single "PASS" would hide that.
 *
 * Each check says which kind of threshold it applied — structural, data-driven,
 * pack-supplied or an engineering guardrail — so a reader can see which numbers
 * are claims about biology and which are deployment decisions.
 */

import { useState } from 'react';
import { api, ApiError } from '../../../lib/api';
import type { RunDataState } from '../useRunData';
import { useLayer } from '../useRunData';
import { Button, Caveat, DataTable, Section, StatTile, VerdictBadge } from '../../ui/Badges';
import TissueView, { type LayerChoice } from '../TissueView';
import { integer, num, percent } from '../../../lib/format';
import { useToast } from '../../ui/ToastContext';
import type { WorkspaceContext } from '../Workspace';
import { atLeast } from '../../../lib/steps';
import { PreprocessingPanel } from '../ModePanels';

const KIND_LABEL: Record<string, string> = {
  structural: 'Structural — fixed for every tissue',
  'data-driven': 'Data-driven — from this dataset’s own distribution',
  'pack-supplied': 'Pack-supplied — from the selected case or model pack',
  engineering: 'Engineering guardrail — not a biological claim',
};

const QC_LAYERS: LayerChoice[] = [
  { id: 'qc:total-counts', label: 'Total counts', kind: 'qc', key: 'total-counts', group: 'Quality' },
  { id: 'qc:detected-features', label: 'Detected features', kind: 'qc', key: 'detected-features', group: 'Quality' },
  { id: 'qc:library-outlier', label: 'Library-size outliers', kind: 'qc', key: 'library-outlier', group: 'Quality' },
  { id: 'qc:mitochondrial', label: 'Mitochondrial fraction', kind: 'qc', key: 'mitochondrial', group: 'Quality' },
  { id: 'annotation:cell-type', label: 'Cell type', kind: 'annotation', key: 'cell-type', group: 'Annotation' },
];

export default function DataQcPage({
  context,
  analysis,
}: {
  context: WorkspaceContext;
  analysis: RunDataState;
}): React.ReactElement {
  const toast = useToast();
  const [layerChoice, setLayerChoice] = useState<LayerChoice>(QC_LAYERS[0] as LayerChoice);
  const layer = useLayer(context.analysisRunId, layerChoice.kind, layerChoice.key);
  const results = analysis.results?.analysis;
  const observations = analysis.results?.observations;

  if (!context.project) {
    return <Caveat>Create or open a project first.</Caveat>;
  }

  if (!context.project.datasetId) {
    return <UploadDatasetPanel context={context} toast={toast} />;
  }

  if (!results) {
    return (
      <Section title="Quality control" subtitle="§6.3 — is this dataset suitable for analysis, and separately, for prediction?">
        <p className="text-[12.5px]" style={{ color: 'var(--ink-secondary)' }}>
          No analysis has run for this project yet. The baseline analysis produces the QC report, the annotation, the
          spatial graph and every baseline layer.
        </p>
        <div className="mt-3">
          <Button variant="primary" onClick={() => void context.submitRun('analysis')} disabled={Boolean(context.running)}>
            {context.running ? 'Running…' : 'Run the baseline analysis'}
          </Button>
        </div>
      </Section>
    );
  }

  const points = observations ? observations.x.map((x, i) => ({ x, y: observations.y[i] as number })) : [];

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Analysis verdict"
          value={results.qc.verdict.toUpperCase()}
          detail={results.qc.eligibility.replace(/-/g, ' ')}
          badge={<VerdictBadge verdict={results.qc.verdict} />}
        />
        <StatTile
          label="Prediction eligible"
          value={results.qc.predictionEligible ? 'Yes' : 'No'}
          detail={
            results.qc.predictionEligible
              ? 'Nothing blocks predictive simulation.'
              : results.qc.predictionBlockers[0] ?? 'Blocked.'
          }
        />
        <StatTile label="Observations" value={integer(results.qc.summary.observations)} unit="cells" />
        <StatTile
          label="Median counts"
          value={integer(results.qc.summary.medianCountsPerObservation)}
          detail={`${percent(results.qc.summary.sparsity)} of the matrix is zero`}
        />
      </div>

      {results.qc.predictionBlockers.length > 0 ? (
        <Caveat tone="warning">
          <p className="font-medium" style={{ color: 'var(--ink)' }}>
            Predictive simulation is blocked:
          </p>
          <ul className="ml-4 mt-1 list-disc">
            {results.qc.predictionBlockers.map((blocker) => (
              <li key={blocker}>{blocker}</li>
            ))}
          </ul>
        </Caveat>
      ) : null}

      <Section
        title="QC dashboard"
        subtitle="§6.3 forbids a universal hard-coded biological threshold across tissues, so each check says which kind it is."
      >
        <DataTable
          rows={results.qc.checks}
          columns={[
            {
              key: 'name',
              header: 'Check',
              render: (check) => (
                <div>
                  <span style={{ color: 'var(--ink)' }}>{check.name}</span>
                  <p className="mt-0.5 text-[10.5px]" style={{ color: 'var(--ink-muted)' }}>
                    {KIND_LABEL[check.kind] ?? check.kind}
                  </p>
                </div>
              ),
            },
            { key: 'verdict', header: 'Verdict', render: (check) => <VerdictBadge verdict={check.verdict} /> },
            { key: 'measured', header: 'Measured', render: (check) => check.measured },
            { key: 'criterion', header: 'Against', render: (check) => check.criterion },
            {
              key: 'rationale',
              header: 'Why it matters',
              render: (check) => (
                <span>
                  {check.rationale}
                  {check.blocksPrediction ? (
                    <em className="ml-1" style={{ color: 'var(--status-warning-text)' }}>
                      Blocks prediction.
                    </em>
                  ) : null}
                </span>
              ),
            },
          ]}
        />
      </Section>

      {results.qc.recommendedActions.length > 0 ? (
        <Section title="Recommended actions">
          <ul className="ml-4 list-disc space-y-1 text-[12px]" style={{ color: 'var(--ink-secondary)' }}>
            {results.qc.recommendedActions.map((action) => (
              <li key={action}>{action}</li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section
        title="Quality across the tissue"
        subtitle="A spatial cluster of outliers usually means a section artefact rather than cell quality — which is only visible on the map."
      >
        <TissueView
          points={points}
          coordinateUnit={observations?.coordinateUnit ?? 'um'}
          layer={layer.layer}
          loading={layer.loading}
          error={layer.error}
          choices={QC_LAYERS}
          selectedId={layerChoice.id}
          onSelectLayer={setLayerChoice}
        />
      </Section>

      {results.preprocessing.warnings.length > 0 ? (
        <Section title="Preprocessing notes" subtitle="§6.4 — the methods panel shows exactly what was applied.">
          <ul className="ml-4 list-disc space-y-1 text-[12px]" style={{ color: 'var(--ink-secondary)' }}>
            {results.preprocessing.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
          {results.preprocessing.keptObservations !== undefined ? (
            <p className="mt-2 text-[11.5px]" style={{ color: 'var(--ink-muted)' }}>
              {integer(results.preprocessing.keptObservations)} observations and{' '}
              {integer(results.preprocessing.keptFeatures ?? 0)} features carried into the analysis.
              {results.preprocessing.explainedVariance
                ? ` The embedding explains ${percent(results.preprocessing.explainedVariance.reduce((a, b) => a + b, 0))} of the variance in ${results.preprocessing.explainedVariance.length} components.`
                : ''}
            </p>
          ) : null}
        </Section>
      ) : null}

      <Section title="Section geometry">
        <div className="grid gap-3 sm:grid-cols-3">
          <StatTile
            label="Median nearest neighbour"
            value={num(results.qc.summary.medianNearestNeighbourDistance)}
            unit={results.qc.summary.coordinateUnit === 'um' ? 'µm' : results.qc.summary.coordinateUnit}
            detail="Every spatial parameter is quoted in this unit."
          />
          <StatTile label="Features detected" value={integer(results.qc.summary.medianFeaturesPerObservation)} detail="median per cell" />
          <StatTile label="Sparsity" value={percent(results.qc.summary.sparsity)} detail="fraction of the matrix that is zero" />
        </div>
      </Section>

      {/* Intermediate and up: the preprocessing record the server sends from that mode. */}
      {atLeast(context.project?.mode, 'moderate') ? (
        <PreprocessingPanel preprocessing={results.preprocessing} observations={results.qc.summary.observations} />
      ) : null}
    </div>
  );
}

function UploadDatasetPanel({
  context,
  toast,
}: {
  context: WorkspaceContext;
  toast: ReturnType<typeof useToast>;
}): React.ReactElement {
  const [matrix, setMatrix] = useState<File | null>(null);
  const [coordinates, setCoordinates] = useState<File | null>(null);
  const [observations, setObservations] = useState<File | null>(null);
  const [features, setFeatures] = useState<File | null>(null);
  const [metadata, setMetadata] = useState({
    organism: context.project?.organism ?? 'Homo sapiens',
    tissue: context.project?.tissue ?? '',
    condition: context.project?.condition ?? '',
    assay: 'spatial transcriptomics',
    platform: 'user supplied',
    sampleId: '',
    featureNamespace: 'HGNC',
    coordinateUnit: 'um',
    preprocessingStatus: 'raw-counts',
    licence: 'user supplied',
  });
  const [uploading, setUploading] = useState(false);

  const update = (key: keyof typeof metadata, value: string): void => {
    setMetadata((current) => ({ ...current, [key]: value }));
  };

  const fileBody = async (file: File | null): Promise<{ name: string; text: string } | null> => {
    if (!file) return null;
    return { name: file.name, text: await file.text() };
  };

  const upload = async (): Promise<void> => {
    if (!context.project) return;
    if (!matrix || !coordinates) {
      toast.push('warning', 'Matrix and coordinates are required');
      return;
    }
    setUploading(true);
    try {
      const response = await api.uploadDataset(context.project.projectId, {
        metadata,
        matrix: await fileBody(matrix),
        coordinates: await fileBody(coordinates),
        observationMetadata: await fileBody(observations),
        featureMetadata: await fileBody(features),
        observationsAreRows: true,
      });
      toast.push(
        'success',
        'Dataset registered',
        response.warnings.length > 0 ? response.warnings.join(' ') : 'Run the baseline analysis next.',
      );
      await context.refreshProject();
      if (response.project) context.navigate('data');
    } catch (error) {
      if (error instanceof ApiError) {
        toast.push('error', 'The dataset could not be registered', (error.message + ' ' + error.suggestedAction).trim());
      } else {
        toast.push('error', 'The dataset could not be registered');
      }
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-4">
      <Section
        title="Register uploaded dataset"
        subtitle="§4 and §10.1 — tabular spatial omics input is canonicalised on the server before QC or prediction."
      >
        <Caveat>
          Upload a delimited expression matrix with observations in rows and features in columns, plus a coordinate table
          containing observation_id, x and y. H5AD, Zarr and Parquet are refused with conversion guidance rather than parsed
          partially.
        </Caveat>

        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <FileField label="Expression matrix" file={matrix} onChange={setMatrix} required />
          <FileField label="Coordinates" file={coordinates} onChange={setCoordinates} required />
          <FileField label="Observation metadata" file={observations} onChange={setObservations} />
          <FileField label="Feature metadata" file={features} onChange={setFeatures} />
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <TextField label="Sample id" value={metadata.sampleId} onChange={(value) => update('sampleId', value)} />
          <TextField label="Organism" value={metadata.organism} onChange={(value) => update('organism', value)} />
          <TextField label="Tissue" value={metadata.tissue} onChange={(value) => update('tissue', value)} />
          <TextField label="Condition" value={metadata.condition} onChange={(value) => update('condition', value)} />
          <TextField label="Assay" value={metadata.assay} onChange={(value) => update('assay', value)} />
          <TextField label="Platform" value={metadata.platform} onChange={(value) => update('platform', value)} />
          <TextField label="Feature namespace" value={metadata.featureNamespace} onChange={(value) => update('featureNamespace', value)} />
          <label className="block">
            <span className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>Coordinate unit</span>
            <select
              value={metadata.coordinateUnit}
              onChange={(event) => update('coordinateUnit', event.target.value)}
              className="mt-1 w-full rounded border px-2 py-1.5 text-[12px]"
              style={{ color: 'var(--ink)' }}
            >
              <option value="um">micrometre</option>
              <option value="mm">millimetre</option>
              <option value="pixel">pixel</option>
              <option value="arbitrary">arbitrary</option>
            </select>
          </label>
          <TextField label="Licence/access" value={metadata.licence} onChange={(value) => update('licence', value)} />
        </div>

        <div className="mt-4 flex justify-end">
          <Button variant="primary" onClick={() => void upload()} disabled={uploading}>
            {uploading ? 'Registering…' : 'Register dataset'}
          </Button>
        </div>
      </Section>
    </div>
  );
}

function FileField({
  label,
  file,
  onChange,
  required = false,
}: {
  label: string;
  file: File | null;
  onChange: (file: File | null) => void;
  required?: boolean;
}): React.ReactElement {
  return (
    <label className="block">
      <span className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
        {label}{required ? ' *' : ''}
      </span>
      <input
        type="file"
        accept=".csv,.tsv,.txt"
        onChange={(event) => onChange(event.target.files?.[0] ?? null)}
        className="mt-1 w-full rounded border px-2 py-1.5 text-[12px]"
        style={{ color: 'var(--ink)' }}
      />
      {file ? <p className="mt-1 text-[10.5px]" style={{ color: 'var(--ink-muted)' }}>{file.name}</p> : null}
    </label>
  );
}

function TextField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }): React.ReactElement {
  return (
    <label className="block">
      <span className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>{label}</span>
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 w-full rounded border px-2 py-1.5 text-[12px]"
        style={{ color: 'var(--ink)' }}
      />
    </label>
  );
}
