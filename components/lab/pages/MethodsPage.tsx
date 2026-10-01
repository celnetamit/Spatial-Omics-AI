/**
 * Methods and the model card — §6.4's methods panel and §14's validation table.
 *
 * The baseline table is the point of this screen. §14.3 lists seven minimum
 * baselines, and the number that matters is not the model's error but the *gap*
 * between it and a model that cannot see the neighbourhood. A spatial model
 * that a graph-free model matches has demonstrated nothing about space, and
 * showing only the headline figure would be the most effective way to hide
 * that.
 */

import { useEffect, useState } from 'react';
import { api, ApiError, type ModelCard, type ResourcePayload } from '../../../lib/api';
import type { RunDataState } from '../useRunData';
import { Caveat, DataTable, Section, StatTile } from '../../ui/Badges';
import { BarChart } from '../../viz/Charts';
import { integer, num } from '../../../lib/format';
import type { WorkspaceContext } from '../Workspace';

export default function MethodsPage({
  context,
  analysis,
}: {
  context: WorkspaceContext;
  analysis: RunDataState;
}): React.ReactElement {
  const [card, setCard] = useState<ModelCard | null>(null);
  const [resources, setResources] = useState<ResourcePayload | null>(null);
  const [cardError, setCardError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .modelCard()
      .then(setCard)
      .catch((error: unknown) => setCardError(error instanceof ApiError ? error.message : 'No model card.'));
    void api.resources().then(setResources).catch(() => setResources(null));
  }, []);

  const methods = (analysis.results?.analysis?.manifest?.methods ?? []) as {
    id: string; name: string; version: string; software: string;
    parameters: Record<string, unknown>; summary: string; references?: string[];
  }[];

  const metrics = card?.metrics ?? {};
  const variants = Object.keys(metrics);

  return (
    <div className="space-y-4">
      <Section
        title="Model card"
        subtitle={card ? `${card.modelId}@${card.version}` : undefined}
      >
        {cardError ? (
          <Caveat tone="warning">{cardError}</Caveat>
        ) : card ? (
          <>
            <Caveat tone="warning">{card.whatTheMetricsMean}</Caveat>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatTile label="Architecture" value={String(card.architecture.kind ?? '—').split(',')[0] ?? '—'} detail={`${card.architecture.hiddenDim} hidden × ${card.architecture.layers} layers`} />
              <StatTile label="Parameters" value={integer(Number(card.architecture.parameters ?? 0))} />
              <StatTile label="Ensemble" value={String(card.architecture.ensembleMembers ?? '—')} unit="members" />
              <StatTile
                label="Training sections"
                value={String((card.trainingData.split as { trainSections?: string[] })?.trainSections?.length ?? '—')}
                detail={`${(card.trainingData.split as { testSections?: string[] })?.testSections?.length ?? 0} held out`}
              />
            </div>
          </>
        ) : (
          <Caveat>Loading…</Caveat>
        )}
      </Section>

      {card && variants.length > 0 ? (
        <>
          <Section
            title="Baselines and ablations"
            subtitle="§14.3 — the gap between the model and a model that cannot see the neighbourhood is the measurement that matters."
          >
            <BarChart
              data={variants.map((variant) => ({
                label: variant,
                value: Number(metrics[variant]?.firstNeighbourR2 ?? Number.NaN),
                detail: card.baselineNotes[variant],
              }))}
              valueLabel="First-neighbour R² (untouched cells)"
              formatValue={(value) => num(value, 3)}
            />
            <p className="mt-2 text-[11px] leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
              The first-neighbour step isolates the spatial claim. From the second propagation stage onward a bystander cell's
              own feature vector already carries its accumulated change, so a model can extrapolate its trajectory without
              consulting anyone — which understates the graph's contribution in the headline rollout figures. At the first
              step every untouched cell's input is identical whatever its distance from the perturbed zone, so only a model
              that can see the neighbourhood can tell them apart.
            </p>
            <div className="mt-3">
              <DataTable
                rows={variants.map((variant) => ({
                  variant,
                  metrics: (metrics[variant] ?? {}) as Record<string, number | number[] | string>,
                }))}
                columns={[
                  { key: 'v', header: 'Variant', render: (r) => r.variant },
                  { key: 'r2', header: 'Rollout R²', align: 'right', render: (r) => num(Number(r.metrics.rolloutR2), 3) },
                  { key: 'r', header: 'Rollout r', align: 'right', render: (r) => num(Number(r.metrics.rolloutPearson), 3) },
                  { key: 'fn', header: '1st-neighbour R²', align: 'right', render: (r) => num(Number(r.metrics.firstNeighbourR2), 3) },
                  { key: 'fnr', header: '1st-neighbour r', align: 'right', render: (r) => num(Number(r.metrics.firstNeighbourPearson), 3) },
                  { key: 'b', header: 'Bystander r', align: 'right', render: (r) => num(Number(r.metrics.bystanderPearson), 3) },
                  { key: 'rmse', header: 'Rollout RMSE', align: 'right', render: (r) => num(Number(r.metrics.rolloutRmse), 4) },
                ]}
              />
            </div>
            <div className="mt-3 space-y-1 text-[11px]" style={{ color: 'var(--ink-secondary)' }}>
              {Object.entries(card.baselineNotes).map(([variant, note]) => (
                <p key={variant}>
                  <span className="font-mono text-[10.5px]" style={{ color: 'var(--ink-muted)' }}>
                    {variant}
                  </span>{' '}
                  {note}
                </p>
              ))}
            </div>
          </Section>

          <Section title="Training data and split" subtitle="§14.4 — the split is at the section level, never at the cell level.">
            <pre
              className="code-panel max-h-72 overflow-auto rounded-lg px-3 py-2.5 font-mono text-[10.5px] leading-relaxed"
              style={{ background: 'var(--surface-sunken)', color: 'var(--ink-secondary)' }}
            >
              {JSON.stringify(card.trainingData, null, 2)}
            </pre>
            <p className="mt-2 text-[11px] leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
              A random cell-level split would put a cell's own neighbours in the training set, and the model could read the
              answer off them. Cells within a section share a ligand field, so the section is the smallest unit that can be
              held out honestly.
            </p>
          </Section>

          <Section title="Limitations" subtitle="Stated on the card, not only in the documentation.">
            <ul className="ml-4 list-disc space-y-1 text-[12px]" style={{ color: 'var(--ink-secondary)' }}>
              {card.limitations.map((entry) => (
                <li key={entry}>{entry}</li>
              ))}
            </ul>
          </Section>
        </>
      ) : null}

      {methods.length > 0 ? (
        <Section title="Methods applied in this run" subtitle="§6.4 — exactly what ran, with its parameters.">
          <div className="space-y-2">
            {methods.map((method) => (
              <details key={method.id} className="method-card rounded-lg border px-3 py-2.5" style={{ borderColor: 'var(--border)' }}>
                <summary className="cursor-pointer text-[12.5px]" style={{ color: 'var(--ink)' }}>
                  {method.name}{' '}
                  <span className="font-mono text-[10.5px]" style={{ color: 'var(--ink-muted)' }}>
                    {method.id}@{method.version}
                  </span>
                </summary>
                <p className="mt-1.5 text-[11.5px] leading-relaxed" style={{ color: 'var(--ink-secondary)' }}>
                  {method.summary}
                </p>
                <pre
                  className="code-panel mt-2 overflow-auto rounded-lg px-2.5 py-2 font-mono text-[10.5px]"
                  style={{ background: 'var(--surface-sunken)', color: 'var(--ink-secondary)' }}
                >
                  {JSON.stringify(method.parameters, null, 2)}
                </pre>
                {method.references?.length ? (
                  <ul className="mt-1.5 ml-4 list-disc text-[10.5px]" style={{ color: 'var(--ink-muted)' }}>
                    {method.references.map((reference) => (
                      <li key={reference}>{reference}</li>
                    ))}
                  </ul>
                ) : null}
              </details>
            ))}
          </div>
        </Section>
      ) : null}

      {resources ? (
        <Section title="Curated resources" subtitle={resources.provenance.statement}>
          <Caveat tone="warning">{resources.provenance.circularityNote}</Caveat>
          <div className="mt-3 grid gap-4 lg:grid-cols-2">
            <div>
              <p className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
                Pathway sets
              </p>
              <DataTable
                rows={resources.pathways}
                maxHeight={220}
                columns={[
                  { key: 'n', header: 'Set', render: (r) => r.name },
                  { key: 'm', header: 'Members', align: 'right', render: (r) => integer(r.members) },
                  { key: 's', header: 'Source', render: (r) => r.source },
                ]}
              />
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
                Ligand-receptor pairs
              </p>
              <DataTable
                rows={resources.ligandReceptor}
                maxHeight={220}
                columns={[
                  { key: 'p', header: 'Pair', render: (r) => `${r.ligand} → ${r.receptorSubunits.join('+')}` },
                  { key: 'm', header: 'Mode', render: (r) => r.mode },
                  { key: 'w', header: 'Pathway', render: (r) => r.pathway },
                ]}
              />
            </div>
          </div>
          <div className="mt-3">
            <p className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
              Secreted signals in the mechanistic model
            </p>
            <DataTable
              rows={resources.network.signals}
              maxHeight={240}
              columns={[
                { key: 'l', header: 'Ligand', render: (r) => r.ligand },
                { key: 'r', header: 'Receptor', render: (r) => r.receptor },
                { key: 'd', header: 'Diffusion length', align: 'right', render: (r) => `${r.diffusionLength} µm` },
                { key: 'p', header: 'Potency', align: 'right', render: (r) => num(r.potency, 2) },
                { key: 'w', header: 'Pathway', render: (r) => r.pathway },
              ]}
            />
            <p className="mt-1.5 text-[10.5px] leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
              The diffusion length decides how far a perturbation travels before the field falls off, and it is the single
              most consequential number in the tissue model. They differ by an order of magnitude across this list on
              purpose: a juxtacrine signal and a diffusible cytokine should not produce the same propagation profile.
            </p>
          </div>
        </Section>
      ) : null}

      {context.meta?.problems && context.meta.problems.length > 0 ? (
        <Section title="Deployment problems" subtitle="Reported at startup and shown here rather than only in a log.">
          <DataTable
            rows={context.meta.problems}
            columns={[
              { key: 's', header: 'Severity', render: (r) => r.severity },
              { key: 'c', header: 'Component', render: (r) => r.component },
              { key: 'm', header: 'Message', render: (r) => r.message },
            ]}
          />
        </Section>
      ) : null}
    </div>
  );
}
