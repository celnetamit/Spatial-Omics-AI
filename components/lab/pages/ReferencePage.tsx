/**
 * Reference comparison — §6.8 and §4.3's "not comparable".
 *
 * Refusing a comparison is the useful behaviour here. A difference map between
 * two incomparable sections renders perfectly and every pixel of it is assay
 * effect, so the check runs first and its reasons are shown whether or not it
 * passed.
 *
 * When the comparison is allowed, the two canvases share one scale and one
 * view. Two maps on different domains make an unchanged tissue look different,
 * and that is exactly the error a comparison screen exists to avoid.
 */

import { useMemo, useState } from 'react';
import type { RunDataState } from '../useRunData';
import { useLayer } from '../useRunData';
import { Caveat, DataTable, ResultBadge, Section } from '../../ui/Badges';
import { EmptyState } from '../../ui/EmptyState';
import TissueView, { IDENTITY_VIEW, type LayerChoice, type ViewState } from '../TissueView';
import { integer } from '../../../lib/format';
import type { WorkspaceContext } from '../Workspace';

export default function ReferencePage({
  context,
  analysis,
}: {
  context: WorkspaceContext;
  analysis: RunDataState;
}): React.ReactElement {
  const results = analysis.results?.analysis;
  const observations = analysis.results?.observations;
  const [view, setView] = useState<ViewState>(IDENTITY_VIEW);

  const choices = useMemo<LayerChoice[]>(() => {
    if (!results) return [];
    return [
      { id: 'annotation:cell-type', label: 'Cell type', kind: 'annotation', key: 'cell-type', group: 'Cells' },
      ...results.pathways.map((entry) => ({
        id: `pathway:${entry.pathwayId}`,
        label: entry.name,
        kind: 'pathway',
        key: entry.pathwayId,
        group: 'Pathway activity',
      })),
    ];
  }, [results]);

  const [choice, setChoice] = useState<LayerChoice | null>(null);
  const active = choice ?? choices[0] ?? null;
  const layer = useLayer(context.analysisRunId, active?.kind ?? null, active?.key ?? '');

  if (!results) {
    return (
      <EmptyState
        title="No baseline to compare against"
        explanation="A reference comparison sets this section beside a matched one and reports whether the two are comparable at all. It needs the baseline analysis of this project first."
        requires={{ page: 'data' }}
        onGo={context.navigate}
      />
    );
  }

  if (!context.project?.referenceDatasetId) {
    return (
      <Section title="Reference comparison" subtitle="§6.8 — optional, and only when the two are biologically comparable.">
        <p className="text-[12.5px]" style={{ color: 'var(--ink-secondary)' }}>
          This project has no reference dataset. A reference is used for the disease-versus-recovery comparison and for the
          §7.6 feature recovery metric; without one, recovery is undefined and the lab reports it as such rather than
          substituting something.
        </p>
      </Section>
    );
  }

  const comparability = results.comparability;
  const points = observations ? observations.x.map((x, i) => ({ x, y: observations.y[i] as number })) : [];

  return (
    <div className="space-y-4">
      <Section
        title="Comparability"
        subtitle="§4.3 — a reference that is not biologically comparable disables the comparison rather than warning about it."
        badge={
          comparability ? (
            <ResultBadge label="COMPUTED" method="qc.comparability" />
          ) : undefined
        }
      >
        {comparability ? (
          <>
            <Caveat tone={comparability.comparable ? 'note' : 'blocked'}>
              {comparability.comparable
                ? `Comparable. ${integer(comparability.sharedFeatures.length)} features are measured in both, on the same assay, resolution and namespace.`
                : 'Not comparable. The reference comparison and the §7.6 recovery metric are disabled for this project.'}
            </Caveat>
            {comparability.reasons.length > 0 ? (
              <div className="mt-2">
                <p className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
                  Blocking reasons
                </p>
                <ul className="ml-4 mt-1 list-disc text-[12px]" style={{ color: 'var(--ink-secondary)' }}>
                  {comparability.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {comparability.warnings.length > 0 ? (
              <div className="mt-2">
                <p className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
                  Warnings that do not block
                </p>
                <ul className="ml-4 mt-1 list-disc text-[12px]" style={{ color: 'var(--ink-secondary)' }}>
                  {comparability.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        ) : (
          <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
            The comparability check has not run.
          </p>
        )}
      </Section>

      <Section
        title="Baseline section"
        subtitle="The reference section is rendered in the predicted-tissue comparison once a prediction exists; here it is the primary section's layers that are available."
      >
        <TissueView
          points={points}
          coordinateUnit={observations?.coordinateUnit ?? 'um'}
          layer={layer.layer}
          loading={layer.loading}
          error={layer.error}
          choices={choices}
          selectedId={active?.id ?? ''}
          onSelectLayer={setChoice}
          view={view}
          onViewChange={setView}
          title="Primary"
        />
      </Section>

      {comparability?.comparable ? (
        <Section title="Shared features" subtitle="The comparison is restricted to features measured in both sections.">
          <DataTable
            rows={comparability.sharedFeatures.slice(0, 200).map((symbol) => ({ symbol }))}
            maxHeight={200}
            columns={[{ key: 's', header: 'Feature', render: (row) => row.symbol }]}
          />
          {comparability.sharedFeatures.length > 200 ? (
            <p className="mt-1 text-[10.5px]" style={{ color: 'var(--ink-muted)' }}>
              Showing the first 200 of {integer(comparability.sharedFeatures.length)}.
            </p>
          ) : null}
        </Section>
      ) : null}
    </div>
  );
}
