/**
 * Predicted altered tissue — §6.15, §6.16 and §12.2.
 *
 * The assembled post-perturbation state, the adverse and off-target analysis,
 * and the reference recovery. §6.15's requirement shapes the layout: adverse
 * burden is its own panel with its own axis and never enters a benefit figure,
 * because "ensure high rescue cannot hide adverse burden" is impossible if the
 * two are added together anywhere.
 *
 * The wording is constrained too. §6.15 forbids labelling clinical toxicity
 * from tissue signatures, so every adverse component says what a rise in it
 * means *in this model* and what it does not.
 */

import { useMemo, useState } from 'react';
import type { RunDataState } from '../useRunData';
import { runObservations, useLayer } from '../useRunData';
import { Caveat, ConfidenceBadge, DataTable, ResultBadge, Section, StatTile } from '../../ui/Badges';
import { EmptyState } from '../../ui/EmptyState';
import TissueView, { type LayerChoice } from '../TissueView';
import { BarChart } from '../../viz/Charts';
import { delta, integer, num, percent } from '../../../lib/format';
import type { WorkspaceContext } from '../Workspace';

export default function PredictedPage({
  context,
  prediction,
  analysis,
}: {
  context: WorkspaceContext;
  prediction: RunDataState;
  analysis: RunDataState;
}): React.ReactElement {
  const results = prediction.results?.prediction;
  const observations = runObservations(prediction, analysis);
  const [layerChoice, setLayerChoice] = useState<LayerChoice | null>(null);
  const [uncertaintyOverlay, setUncertaintyOverlay] = useState(true);

  const choices = useMemo<LayerChoice[]>(() => {
    if (!results) return [];
    const movers = results.altered.nodeMeanDelta
      .map((value, index) => ({ symbol: results.nodeSymbols[index] as string, value }))
      .filter((entry) => Math.abs(entry.value) > 1e-4)
      .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
      .slice(0, 24);

    return [
      ...movers.map((entry) => ({
        id: `delta:${entry.symbol}`,
        label: `Δ ${entry.symbol}`,
        kind: 'delta',
        key: entry.symbol,
        group: 'Feature change',
      })),
      ...results.adverse.components.map((entry) => ({
        id: `adverse:${entry.signatureId}`,
        label: entry.name,
        kind: 'adverse',
        key: entry.signatureId,
        group: 'Adverse signatures',
      })),
      { id: 'uncertainty:dispersion', label: 'Ensemble disagreement', kind: 'uncertainty', key: '', group: 'Uncertainty' },
    ];
  }, [results]);

  const active = layerChoice ?? choices[0] ?? null;
  const layer = useLayer(context.predictionRunId, active?.kind ?? null, active?.key ?? '');
  const uncertainty = useLayer(context.predictionRunId, uncertaintyOverlay ? 'uncertainty' : null, '');

  /*
   * The uncertainty channel is opacity, not a second colour ramp.
   *
   * §11.3: "uncertainty should be represented with opacity, hatching, border
   * style or an uncertainty layer so color is not overloaded". Colour is
   * already carrying the value here.
   *
   * This has to stay above the `!results` return below, not after it. It used
   * to sit below, which is a real Rules-of-Hooks violation rather than a style
   * preference: on the first render after opening this page directly — the
   * prediction has not arrived yet, so `results` is still null, the component
   * returns early and this `useMemo` is never called. The moment the fetch
   * resolves, the same mounted instance re-renders with `results` populated,
   * tries to call a hook it skipped last time, and React throws rather than
   * guess which previous hook this one was supposed to be. It reproduced
   * reliably on every direct or bookmarked link to this page — exactly what a
   * returning user's link looks like — and the error boundary caught it,
   * which is why the symptom was a page that rendered nothing useful rather
   * than a visible stack trace.
   */
  const opacity = useMemo(() => {
    if (!uncertaintyOverlay || !uncertainty.layer) return null;
    const values = uncertainty.layer.values;
    const finite = values.filter(Number.isFinite);
    if (finite.length === 0) return null;
    const high = Math.max(...finite) || 1;
    return values.map((value) => (Number.isFinite(value) ? 1 - 0.7 * Math.min(1, value / high) : 0.25));
  }, [uncertaintyOverlay, uncertainty.layer]);

  if (!results) {
    return (
      <EmptyState
        title="No predicted tissue state yet"
        explanation="This screen shows the altered tissue: the direct response in the targeted cells, what propagation did to the rest, and the uncertainty attached to both. Define a perturbation and run the prediction."
        requires={{ page: 'experiment' }}
        onGo={context.navigate}
      />
    );
  }

  const points = observations ? observations.x.map((x, i) => ({ x, y: observations.y[i] as number })) : [];

  const topChanges = results.altered.nodeMeanDelta
    .map((value, index) => ({ symbol: results.nodeSymbols[index] as string, value }))
    .filter((entry) => Math.abs(entry.value) > 1e-4)
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    .slice(0, 16);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Mean change"
          value={num(results.altered.meanMagnitude, 4)}
          unit="activity units"
          badge={<ResultBadge label="PREDICTED" />}
        />
        <StatTile label="Cells changed" value={percent(results.altered.changedFraction)} detail="beyond the noise floor" />
        <StatTile
          label="Adverse burden"
          value={num(results.adverse.burden, 4)}
          detail="Mean of the signatures that rose. Kept off the benefit axis entirely (§6.15)."
        />
        <StatTile
          label="Confidence"
          value=""
          badge={<ConfidenceBadge confidence={results.confidence} rule={results.uncertainty.rule} />}
          detail={results.uncertainty.domain.explanation}
        />
      </div>

      <Section
        title="Predicted altered tissue"
        subtitle="Every layer here is model output and is labelled PREDICTED. The baseline object is unchanged."
        actions={
          <label className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--ink-secondary)' }}>
            <input type="checkbox" checked={uncertaintyOverlay} onChange={(event) => setUncertaintyOverlay(event.target.checked)} />
            Fade by uncertainty
          </label>
        }
      >
        <TissueView
          points={points}
          coordinateUnit={observations?.coordinateUnit ?? 'um'}
          layer={layer.layer}
          loading={layer.loading}
          error={layer.error}
          choices={choices}
          selectedId={active?.id ?? ''}
          onSelectLayer={setLayerChoice}
          opacity={opacity}
        />
        {uncertaintyOverlay && opacity ? (
          <p className="mt-2 text-[10.5px]" style={{ color: 'var(--ink-muted)' }}>
            Faded cells are the ones the ensemble members disagree about. Uncertainty is carried by opacity rather than by a
            second colour ramp, because colour is already carrying the value.
          </p>
        ) : null}
      </Section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section
          title="What changed"
          subtitle="Section-mean change per node, from baseline to the final stage."
          badge={<ResultBadge label="PREDICTED" />}
        >
          <BarChart
            data={topChanges.map((entry) => ({ label: entry.symbol, value: entry.value }))}
            valueLabel="Mean activity change"
            mode="diverging"
            formatValue={(value) => delta(value, 3)}
          />
        </Section>

        <Section
          title="Adverse and off-target"
          subtitle="Separate metrics on their own axis. A high rescue cannot hide an adverse burden, because the two are never added."
          badge={<ResultBadge label="PREDICTED" />}
        >
          {results.adverse.notInterpretable ? (
            <Caveat tone="warning">{results.adverse.notInterpretable}</Caveat>
          ) : (
            <>
              <BarChart
                data={results.adverse.components.map((entry) => ({
                  label: entry.name,
                  value: entry.meanDelta,
                  detail: `${percent(entry.affectedFraction)} of cells above the noise floor · non-target mean ${delta(entry.nonTargetMeanDelta, 3)}`,
                }))}
                valueLabel="Signature change"
                mode="diverging"
                formatValue={(value) => delta(value, 3)}
              />
              <div className="mt-3 space-y-2">
                {results.adverse.components.map((entry) => (
                  <details key={entry.signatureId} className="rounded border px-2.5 py-1.5" style={{ borderColor: 'var(--border)' }}>
                    <summary className="cursor-pointer text-[12px]" style={{ color: 'var(--ink)' }}>
                      {entry.name} · {delta(entry.meanDelta, 3)}
                    </summary>
                    <p className="mt-1.5 text-[11.5px] leading-relaxed" style={{ color: 'var(--ink-secondary)' }}>
                      {entry.interpretation}
                    </p>
                    <div className="mt-2">
                      <DataTable
                        rows={entry.byClass}
                        columns={[
                          { key: 'c', header: 'Class', render: (row) => row.className },
                          { key: 'n', header: 'Cells', align: 'right', render: (row) => integer(row.count) },
                          { key: 'd', header: 'Mean change', align: 'right', render: (row) => delta(row.meanDelta, 3) },
                        ]}
                      />
                    </div>
                    <p className="mt-1.5 text-[10.5px]" style={{ color: 'var(--ink-muted)' }}>
                      Source: {entry.source}
                    </p>
                  </details>
                ))}
              </div>
            </>
          )}

          {results.adverse.offTargets.length > 0 ? (
            <div className="mt-3">
              <p className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
                Off-target engagement
              </p>
              <DataTable
                rows={results.adverse.offTargets}
                columns={[
                  { key: 's', header: 'Target', render: (r) => r.symbol },
                  {
                    key: 'e',
                    header: 'Engagement',
                    align: 'right',
                    render: (r) => (Number.isFinite(r.engagement) ? percent(r.engagement) : 'not quantified'),
                  },
                  { key: 'm', header: 'In panel', render: (r) => (r.measured ? 'yes' : 'no') },
                  { key: 'n', header: 'Note', render: (r) => r.note },
                ]}
              />
            </div>
          ) : null}
        </Section>
      </div>

      {results.recovery ? (
        <Section
          title="Recovery toward the reference"
          subtitle="§7.6 — overshoot and sign reversal are flagged rather than counted as improvement."
          badge={<ResultBadge label="PREDICTED" />}
        >
          <Caveat>{results.recovery.note}</Caveat>
          <div className="mt-3 grid gap-3 sm:grid-cols-4">
            <StatTile
              label="Mean recovery"
              value={Number.isFinite(results.recovery.meanRecovery) ? num(results.recovery.meanRecovery, 3) : '—'}
              detail={`over ${integer(results.recovery.counts.recovered ?? 0)} feature(s)`}
            />
            <StatTile label="Overshot" value={integer(results.recovery.counts.overshoot ?? 0)} detail="excluded from the mean" />
            <StatTile label="Worsened" value={integer(results.recovery.counts.worsened ?? 0)} />
            <StatTile label="No gap to close" value={integer(results.recovery.counts['no-gap'] ?? 0)} />
          </div>
          <div className="mt-3">
            <DataTable
              rows={[...results.recovery.features]
                .filter((entry) => entry.verdict !== 'no-gap' && entry.verdict !== 'undefined')
                .sort((a, b) => b.recovery - a.recovery)
                .slice(0, 20)}
              maxHeight={280}
              columns={[
                { key: 's', header: 'Feature', render: (r) => r.symbol },
                { key: 'h', header: 'Reference', align: 'right', render: (r) => num(r.reference, 3) },
                { key: 'd', header: 'Baseline', align: 'right', render: (r) => num(r.disease, 3) },
                { key: 't', header: 'Predicted', align: 'right', render: (r) => num(r.treated, 3) },
                { key: 'r', header: 'R_f', align: 'right', render: (r) => num(r.recovery, 3) },
                {
                  key: 'v',
                  header: 'Verdict',
                  render: (r) => (
                    <span
                      style={{
                        color:
                          r.verdict === 'recovered'
                            ? 'var(--status-good-text)'
                            : r.verdict === 'overshoot'
                              ? 'var(--status-warning-text)'
                              : 'var(--status-serious-text)',
                      }}
                    >
                      {r.verdict}
                      {r.verdict === 'overshoot' ? ` (${num(r.overshootFraction, 2)}× the gap)` : ''}
                    </span>
                  ),
                },
              ]}
            />
          </div>
        </Section>
      ) : null}

      <Section title="Out-of-domain assessment" subtitle="§6.20 — how far this run sits from the distribution the model was fitted on.">
        <Caveat tone={results.uncertainty.domain.status === 'in-domain' ? 'note' : 'warning'}>
          {results.uncertainty.domain.explanation}
        </Caveat>
        {results.uncertainty.domain.contributors.length > 0 ? (
          <div className="mt-3">
            <DataTable
              rows={results.uncertainty.domain.contributors}
              columns={[
                { key: 'n', header: 'Context feature', render: (r) => r.name },
                { key: 'v', header: 'This run', align: 'right', render: (r) => num(r.value, 3) },
                { key: 'm', header: 'Training mean', align: 'right', render: (r) => num(r.trainingMean, 3) },
                { key: 'z', header: 'z', align: 'right', render: (r) => num(r.z, 2) },
              ]}
            />
          </div>
        ) : null}
        {results.uncertainty.calibration ? (
          <p className="mt-3 text-[11.5px] leading-relaxed" style={{ color: 'var(--ink-secondary)' }}>
            {results.uncertainty.calibration.note}
          </p>
        ) : null}
      </Section>
    </div>
  );
}
