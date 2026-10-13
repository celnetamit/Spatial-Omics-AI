/**
 * Propagation — §6.13, §6.14 and §11.2.
 *
 * §2.3 requires the direct response and the spatial propagation to be shown
 * separately, and this screen is where that separation is visible: the direct
 * response is evidence-parameterised and labelled COMPUTED, and every stage
 * after it is model output and labelled PREDICTED. Directly perturbed cells are
 * drawn as rings and their neighbours as discs, so the distinction survives
 * greyscale and colour-vision deficiency.
 *
 * The stage slider carries §7.8's caveat wherever it appears: T0–T4 count
 * rounds of intercellular signalling in the model, not hours.
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
import { atLeast } from '../../../lib/steps';

export default function PropagationPage({
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
  const [stage, setStage] = useState(1);
  const [layerChoice, setLayerChoice] = useState<LayerChoice | null>(null);

  const stages = results?.propagation.stages ?? [];
  const maxStage = stages.length > 0 ? (stages[stages.length - 1] as { stage: number }).stage : 1;

  const choices = useMemo<LayerChoice[]>(() => {
    if (!results) return [];
    const layers: LayerChoice[] = [
      { id: 'direct:magnitude', label: 'Direct response magnitude', kind: 'direct', key: 'magnitude', group: 'Direct (computed)' },
    ];
    for (const node of results.direct.targetNodes) {
      const symbol = results.nodeSymbols[node];
      if (symbol) {
        layers.push({ id: `direct:${symbol}`, label: `${symbol} immediate change`, kind: 'direct', key: symbol, group: 'Direct (computed)' });
      }
    }
    for (const entry of stages) {
      layers.push({
        id: `propagation:cumulative:${entry.stage}`,
        label: `${entry.label} — from baseline`,
        kind: 'propagation',
        key: 'cumulative',
        stage: entry.stage,
        group: 'Propagation (predicted)',
      });
      layers.push({
        id: `propagation:step:${entry.stage}`,
        label: `${entry.label} — this stage only`,
        kind: 'propagation',
        key: 'step',
        stage: entry.stage,
        group: 'Propagation (predicted)',
      });
    }
    layers.push({ id: 'uncertainty:dispersion', label: 'Ensemble disagreement', kind: 'uncertainty', key: '', group: 'Uncertainty' });
    if (results.mechanisticReference.ran) {
      layers.push({ id: 'mechanism:magnitude', label: 'Simulated reference', kind: 'mechanism', key: '', group: 'Reference' });
    }
    return layers;
  }, [results, stages]);

  const active = layerChoice ?? choices[0] ?? null;
  const layer = useLayer(context.predictionRunId, active?.kind ?? null, active?.key ?? '', active?.stage);

  if (!results) {
    return (
      <EmptyState
        title="Nothing has been propagated yet"
        explanation="This screen shows how a perturbation spreads outward from the cells it acts on directly — stage by stage, across the spatial graph. It needs a perturbation and a prediction run."
        requires={{ page: 'experiment' }}
        onGo={context.navigate}
      />
    );
  }

  const points = observations ? observations.x.map((x, i) => ({ x, y: observations.y[i] as number })) : [];
  const stageEntry = stages.find((entry) => entry.stage === stage) ?? stages[0];

  const movers = stageEntry
    ? stageEntry.nodeMeanDelta
        .map((value, index) => ({ symbol: results.nodeSymbols[index] as string, value }))
        .filter((entry) => Math.abs(entry.value) > 1e-4)
        .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
        .slice(0, 14)
    : [];

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Direct response"
          value={results.direct.quantitative ? 'Quantitative' : 'Exploratory'}
          detail="Evidence-parameterised, not model output."
          badge={<ResultBadge label="COMPUTED" method={results.direct.method} />}
        />
        <StatTile
          label="Propagation"
          value={results.propagation.available ? `${stages.length} stages` : 'Unavailable'}
          detail={results.propagation.available ? `${results.propagation.modelId}@${results.propagation.modelVersion}` : undefined}
          badge={results.propagation.available ? <ResultBadge label="PREDICTED" /> : undefined}
        />
        <StatTile
          label="Ensemble"
          value={results.propagation.members > 0 ? `${results.propagation.members} members` : '—'}
          detail={
            results.propagation.members < 2
              ? 'Below two members no disagreement can be measured.'
              : `Median disagreement ${num(results.uncertainty.median, 3)}`
          }
        />
        <StatTile
          label="Confidence"
          value=""
          badge={<ConfidenceBadge confidence={results.confidence} rule={results.uncertainty.rule} />}
          detail={results.uncertainty.rule}
        />
      </div>

      {!results.propagation.available ? (
        <Caveat tone="warning">{results.propagation.unavailableReason}</Caveat>
      ) : null}

      <Section
        title="Stage-resolved propagation"
        subtitle={results.propagation.stageCaveat}
        actions={
          stages.length > 1 ? (
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={1}
                max={maxStage}
                value={stage}
                onChange={(event) => {
                  const next = Number.parseInt(event.target.value, 10);
                  setStage(next);
                  const match = choices.find((choice) => choice.kind === 'propagation' && choice.key === 'cumulative' && choice.stage === next);
                  if (match) setLayerChoice(match);
                }}
                className="w-40"
                aria-label="Propagation stage"
              />
              <span className="text-[11px]" style={{ color: 'var(--ink-secondary)' }}>
                {stageEntry?.label ?? ''}
              </span>
            </div>
          ) : undefined
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
          onSelectLayer={(choice) => {
            setLayerChoice(choice);
            if (choice.stage !== undefined) setStage(choice.stage);
          }}
        />
        <p className="mt-2 text-[10.5px] leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
          Directly perturbed cells are drawn as rings; every other cell is a disc. §11.3 asks for the direct response and the
          neighbour response to differ in symbol and not only in colour, so the distinction survives greyscale, forced colours
          and a colour-vision deficiency.
        </p>
      </Section>

      <div className={atLeast(context.project?.mode, 'moderate') ? 'grid gap-4 lg:grid-cols-2' : 'grid gap-4'}>
        <Section
          title={`What moved at ${stageEntry?.label ?? 'this stage'}`}
          subtitle="Section-mean change per network node, relative to the unperturbed baseline."
          badge={<ResultBadge label={stage === 1 ? 'COMPUTED' : 'PREDICTED'} />}
        >
          <BarChart
            data={movers.map((entry) => ({ label: entry.symbol, value: entry.value }))}
            valueLabel="Mean activity change"
            mode="diverging"
            formatValue={(value) => delta(value, 3)}
            emptyMessage="Nothing moved beyond the noise floor at this stage."
          />
        </Section>

        {atLeast(context.project?.mode, 'moderate') ? (
        <Section
          tier="moderate"
          title="Direct response terms"
          subtitle="§7.1 — DirectEffect = A_i × D(C) × T(t) × S_i × W_e, each term shown separately rather than folded into one number."
          badge={<ResultBadge label="COMPUTED" method={results.direct.method} />}
        >
          {results.direct.terms.length > 0 ? (
            <DataTable
              rows={results.direct.terms.slice(0, 12)}
              columns={[
                { key: 'cell', header: 'Cell', render: (r) => `#${r.observationIndex}` },
                { key: 'a', header: 'A_i', align: 'right', render: (r) => num(r.targetAvailability, 3) },
                { key: 'd', header: 'D(C)', align: 'right', render: (r) => num(r.doseEffect, 3) },
                { key: 't', header: 'T(t)', align: 'right', render: (r) => num(r.timeEffect, 3) },
                { key: 's', header: 'S_i', align: 'right', render: (r) => num(r.cellSensitivity, 3) },
                { key: 'w', header: 'W_e', align: 'right', render: (r) => num(r.evidenceModifier, 3) },
                { key: 'p', header: 'Effect', align: 'right', render: (r) => num(r.product, 3) },
              ]}
            />
          ) : (
            <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
              This operator does not decompose into dose and time terms; its semantics are on the experiment screen.
            </p>
          )}
          {results.direct.warnings.length > 0 ? (
            <Caveat tone="warning">
              <ul className="ml-4 list-disc">
                {results.direct.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </Caveat>
          ) : null}
        </Section>
        ) : null}
      </div>

      {/* The comparison with the generating mechanism is Advanced's; the note
          that it was not requested stays in every mode, because it says how to get it. */}
      {results.mechanisticReference.ran ? (
        atLeast(context.project?.mode, 'expert') ? (
        <Section
          tier="expert"
          title="Simulated reference"
          subtitle="The mechanism that generated this bundled case, re-solved under the same perturbation."
          badge={<ResultBadge label="COMPUTED" method="mechanistic reaction-diffusion solve" />}
        >
          <Caveat tone="warning">{results.mechanisticReference.reason}</Caveat>
          {results.mechanisticReference.agreement ? (
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <StatTile
                label="Agreement"
                value={num(results.mechanisticReference.agreement.pearson, 3)}
                unit="Pearson r"
                detail="Model prediction against the mechanism, per cell per node."
              />
              <StatTile label="RMSE" value={num(results.mechanisticReference.agreement.rmse, 4)} unit="activity units" />
              <StatTile
                label="Error by stage"
                value={results.mechanisticReference.agreement.perStageRmse.map((value) => num(value, 3)).join(' · ')}
                detail="Compounding across the rollout is visible rather than collapsed into one figure."
              />
            </div>
          ) : null}
        </Section>
        ) : null
      ) : (
        <Caveat>{results.mechanisticReference.reason}</Caveat>
      )}

      {atLeast(context.project?.mode, 'moderate') ? (
      <Section tier="moderate" title="Graph used for this run" subtitle="§5.4 — graph parameters are versioned with the run and cannot change silently.">
        <dl className="grid gap-2 text-[11.5px] sm:grid-cols-3" style={{ color: 'var(--ink-secondary)' }}>
          <div>
            <dt style={{ color: 'var(--ink-muted)' }}>Graph</dt>
            <dd className="font-mono text-[10.5px]">{results.propagation.graphId}</dd>
          </div>
          <div>
            <dt style={{ color: 'var(--ink-muted)' }}>Model</dt>
            <dd className="font-mono text-[10.5px]">
              {results.propagation.modelId ? `${results.propagation.modelId}@${results.propagation.modelVersion}` : '—'}
            </dd>
          </div>
          <div>
            <dt style={{ color: 'var(--ink-muted)' }}>Cells changed</dt>
            <dd className="tnum">
              {percent(results.altered.changedFraction)} ({integer(Math.round(results.altered.changedFraction * (observations?.ids.length ?? 0)))})
            </dd>
          </div>
        </dl>
      </Section>
      ) : null}
    </div>
  );
}
