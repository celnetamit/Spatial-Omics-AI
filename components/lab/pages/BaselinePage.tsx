/**
 * Baseline tissue — §6.6, §6.7, §6.8 and §12.1.
 *
 * The measured tissue before anything is done to it: cell types, features,
 * pathways, states, neighbourhood structure and candidate communication, on one
 * map with the tables linked to it.
 *
 * Two pieces of honesty live on this screen. Neighbourhood enrichment and
 * ligand-receptor results are described as *associations* throughout, because
 * §6.7 requires it and because proximity is not evidence of signalling. And
 * when the dataset is a bundled simulated case, the pathway panel says that the
 * gene sets and the generator share a network — so a pathway score there is
 * measuring the simulator, not confirming it.
 */

import { useMemo, useState } from 'react';
import type { RunDataState } from '../useRunData';
import { useLayer } from '../useRunData';
import { Caveat, DataTable, ResultBadge, Section, StatTile } from '../../ui/Badges';
import { EmptyState } from '../../ui/EmptyState';
import TissueView, { type LayerChoice } from '../TissueView';
import { BarChart, MatrixChart } from '../../viz/Charts';
import { integer, num, percent, pValue } from '../../../lib/format';
import type { WorkspaceContext } from '../Workspace';
import { atLeast } from '../../../lib/steps';
import { GraphConstructionPanel, ProvenancePanel } from '../ModePanels';

export default function BaselinePage({
  context,
  analysis,
}: {
  context: WorkspaceContext;
  analysis: RunDataState;
}): React.ReactElement {
  const results = analysis.results?.analysis;
  const observations = analysis.results?.observations;
  const [group, setGroup] = useState<string>('');
  const [showEdges, setShowEdges] = useState(false);

  const choices = useMemo<LayerChoice[]>(() => {
    if (!results) return [];
    const layers: LayerChoice[] = [
      { id: 'annotation:cell-type', label: 'Cell type', kind: 'annotation', key: 'cell-type', group: 'Cells' },
      { id: 'annotation:confidence', label: 'Annotation confidence', kind: 'annotation', key: 'confidence', group: 'Cells' },
    ];
    if (results.regions.classes.length > 0) {
      layers.push({ id: 'annotation:region', label: 'Region', kind: 'annotation', key: 'region', group: 'Cells' });
    }
    if (results.domains) {
      layers.push({ id: 'annotation:domain', label: 'Spatial domain', kind: 'annotation', key: 'domain', group: 'Cells' });
    }
    for (const pathway of results.pathways) {
      layers.push({ id: `pathway:${pathway.pathwayId}`, label: pathway.name, kind: 'pathway', key: pathway.pathwayId, group: 'Pathway activity' });
    }
    for (const state of results.states) {
      layers.push({ id: `state:${state.stateId}`, label: state.name, kind: 'state', key: state.stateId, group: 'Cell state' });
    }
    const topFeatures = [...results.differential.results]
      .sort((a, b) => b.effectSize - a.effectSize)
      .map((entry) => entry.symbol);
    for (const symbol of [...new Set(topFeatures)].slice(0, 30)) {
      layers.push({ id: `feature:${symbol}`, label: symbol, kind: 'feature', key: symbol, group: 'Feature expression' });
    }
    for (const pair of results.communication.results) {
      if (!Number.isFinite(pair.totalScore)) continue;
      layers.push({
        id: `communication:${pair.pairId}|sent`,
        label: `${pair.ligand} → ${pair.receptor} (sent)`,
        kind: 'communication',
        key: `${pair.pairId}|sent`,
        group: 'Communication',
      });
      layers.push({
        id: `communication:${pair.pairId}|received`,
        label: `${pair.ligand} → ${pair.receptor} (received)`,
        kind: 'communication',
        key: `${pair.pairId}|received`,
        group: 'Communication',
      });
    }
    return layers;
  }, [results]);

  const [layerChoice, setLayerChoice] = useState<LayerChoice | null>(null);
  const active = layerChoice ?? choices[0] ?? null;
  const layer = useLayer(context.analysisRunId, active?.kind ?? null, active?.key ?? '');

  if (!results) {
    return (
      <EmptyState
        title="The baseline tissue has not been analysed yet"
        explanation="This screen maps the unperturbed section: its cell types, spatial domains, pathway activity and cell-to-cell communication. All of it comes from the baseline analysis run."
        requires={{ page: 'data' }}
        onGo={context.navigate}
      />
    );
  }

  const points = observations ? observations.x.map((x, i) => ({ x, y: observations.y[i] as number })) : [];
  // Beginner keeps the core picture; Intermediate adds the spatial statistics
  // and how the graph was built; Advanced adds the run's provenance.
  const intermediate = atLeast(context.project?.mode, 'moderate');
  const groups = results.annotation.classes;
  const activeGroup = group || (groups[0] ?? '');
  const markers = results.differential.results
    .filter((entry) => entry.group === activeGroup && entry.logDifference > 0)
    .sort((a, b) => b.effectSize - a.effectSize)
    .slice(0, 14);

  const isSimulated = context.project?.datasetId?.startsWith('sim-') ?? false;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Cell classes"
          value={String(results.annotation.classes.length)}
          detail={
            results.annotation.exploratory
              ? 'Inferred from a marker panel — exploratory, not validated annotations.'
              : 'Supplied with the dataset.'
          }
          badge={<ResultBadge label={results.annotation.exploratory ? 'COMPUTED' : 'OBSERVED'} />}
        />
        <StatTile
          label="Graph"
          value={integer(results.graph.diagnostics.physicalEdges)}
          unit="physical edges"
          detail={`${integer(results.graph.diagnostics.biologicalEdges)} biological, median degree ${results.graph.diagnostics.medianDegree}`}
        />
        <StatTile
          label="Connectivity"
          value={percent(results.graph.diagnostics.largestComponentFraction, 0)}
          detail={`${results.graph.diagnostics.components} component(s), ${results.graph.diagnostics.isolatedNodes} isolated`}
        />
        <StatTile
          label="Domains"
          value={results.domains ? String(results.domains.domainCount) : '—'}
          detail={results.domains ? `${percent(results.domains.spatialCoherence)} neighbourhood coherence` : 'Not computed.'}
        />
      </div>

      {results.annotation.unassigned > 0 ? (
        <Caveat>
          {integer(results.annotation.unassigned)} observation(s) were not assigned a cell type. They are left unassigned
          rather than forced to the nearest label, and appear in grey on the map.
        </Caveat>
      ) : null}

      <Section
        title="Tissue map"
        subtitle="Click a cell to keep it selected. Every layer here was computed on the server; the client draws it, it does not derive it."
        actions={
          // The edges come with the full graph, which the server sends from
          // Intermediate up. In Beginner the toggle drew nothing, so it is only
          // offered where it works.
          results.graph.edgeSample ? (
            <label className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--ink-secondary)' }}>
              <input type="checkbox" checked={showEdges} onChange={(event) => setShowEdges(event.target.checked)} />
              Graph overlay
            </label>
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
          onSelectLayer={setLayerChoice}
          edges={showEdges ? (results.graph.edgeSample ?? null) : null}
        />
        {showEdges && results.graph.edgeSample ? (
          <p className="mt-2 text-[10.5px]" style={{ color: 'var(--ink-muted)' }}>
            Physical proximity edges in grey, biological interaction edges in violet — stored as distinct types (§5.4).
            Showing the first {integer(results.graph.edgeSample.length)} of{' '}
            {integer(results.graph.diagnostics.physicalEdges + results.graph.diagnostics.biologicalEdges)}.
          </p>
        ) : null}
      </Section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section
          title="Markers"
          subtitle="One-vs-rest within each annotated group, with the multiple-testing correction applied inside each group rather than pooled."
          badge={<ResultBadge label="COMPUTED" method="baseline.differential" />}
          actions={
            <select
              aria-label="Cell class to show markers for"
              value={activeGroup}
              onChange={(event) => setGroup(event.target.value)}
              className="rounded border px-2 py-1 text-[11px]"
              style={{ color: 'var(--ink)' }}
            >
              {groups.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          }
        >
          {markers.length > 0 ? (
            <>
              <BarChart
                data={markers.map((entry) => ({
                  label: entry.symbol,
                  value: entry.effectSize,
                  detail: `q = ${pValue(entry.qValue)} · Δ = ${num(entry.logDifference)} log units · n = ${integer(entry.nGroup)}`,
                }))}
                valueLabel="Effect size (Hedges' g)"
                formatValue={(value) => num(value, 2)}
              />
              <DataTable
                rows={markers}
                maxHeight={220}
                columns={[
                  { key: 'symbol', header: 'Feature', render: (r) => r.symbol },
                  { key: 'effect', header: "Hedges' g", align: 'right', render: (r) => num(r.effectSize, 2) },
                  { key: 'diff', header: 'Δ log', align: 'right', render: (r) => num(r.logDifference, 2) },
                  { key: 'q', header: 'q', align: 'right', render: (r) => pValue(r.qValue) },
                  { key: 'detect', header: 'Detected', align: 'right', render: (r) => percent(r.detectionInGroup, 0) },
                ]}
              />
            </>
          ) : (
            <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
              No marker cleared the threshold for this group.
            </p>
          )}
          {results.differential.skipped.length > 0 ? (
            <Caveat>
              <p className="font-medium">Groups not tested:</p>
              <ul className="ml-4 list-disc">
                {results.differential.skipped.map((entry) => (
                  <li key={entry}>{entry}</li>
                ))}
              </ul>
            </Caveat>
          ) : null}
        </Section>

        <Section
          title="Pathway activity"
          subtitle="The between-group share of each score's variance — not the section mean, which is zero by construction for a z-scored quantity."
          badge={<ResultBadge label="COMPUTED" method="baseline.pathway-activity" />}
        >
          <BarChart
            data={results.pathways
              .filter((entry) => Number.isFinite(entry.separation))
              .sort((a, b) => b.separation - a.separation)
              .map((entry) => {
                const sorted = [...entry.byGroup].sort((a, b) => b.mean - a.mean);
                const top = sorted[0];
                return {
                  label: entry.name,
                  value: entry.separation,
                  detail: `${top ? `highest in ${top.group}` : ''} · z = ${num(entry.nullZ, 2)} · q = ${pValue(entry.qValue)}`,
                };
              })}
            valueLabel="Between-group variance share"
            formatValue={(value) => num(value, 2)}
          />
          {isSimulated ? (
            <Caveat tone="warning">
              {context.meta?.resources.circularityNote ??
                'On a bundled simulated case the gene sets and the generator share a network, so a pathway score measures the simulator rather than confirming it.'}
            </Caveat>
          ) : null}
        </Section>
      </div>

      {intermediate ? (
      <div className="grid gap-4 lg:grid-cols-2">
        <Section
          tier="moderate"
          title="Neighbourhood enrichment"
          subtitle={`Against ${integer(results.enrichment.permutations)} label permutations on fixed coordinates. A spatial association — not evidence of signalling.`}
          badge={<ResultBadge label="COMPUTED" method="spatial.neighbourhood-enrichment" />}
        >
          <MatrixChart
            labels={results.enrichment.labels}
            values={results.enrichment.zScore}
            mode="diverging"
            title="Neighbourhood enrichment z-scores"
            valueFormat={(value) => num(value, 1)}
          />
          <p className="mt-2 text-[10.5px]" style={{ color: 'var(--ink-muted)' }}>
            Positive means the two classes neighbour each other more often than chance; negative means they segregate.
          </p>
        </Section>

        <Section
          tier="moderate"
          title="Candidate communication"
          subtitle="Sparse unbalanced optimal transport: neighbours compete for a finite ligand rather than each being scored at full strength."
          badge={<ResultBadge label="COMPUTED" method="spatial.communication" />}
        >
          <DataTable
            rows={results.communication.results.filter((entry) => Number.isFinite(entry.totalScore)).sort((a, b) => b.totalScore - a.totalScore)}
            maxHeight={260}
            columns={[
              { key: 'pair', header: 'Interaction', render: (r) => `${r.ligand} → ${r.receptor}` },
              { key: 'mode', header: 'Mode', render: (r) => r.mode },
              { key: 'score', header: 'Transported', align: 'right', render: (r) => num(r.totalScore, 3) },
              { key: 'q', header: 'q', align: 'right', render: (r) => pValue(r.qValue) },
              {
                key: 'top',
                header: 'Dominant sender → receiver',
                render: (r) => {
                  const top = (analysis.results?.analysis?.communication.byClass[r.pairId] ?? [])[0];
                  return top ? `${top.source} → ${top.target}` : '—';
                },
              },
            ]}
            empty="No ligand-receptor pair could be scored on this feature set."
          />
          {results.communication.results.some((entry) => entry.incomplete.length > 0) ? (
            <Caveat>
              Some receptor complexes are incomplete in this panel and were reported rather than scored — a complex missing
              a subunit is not a weaker version of itself.
            </Caveat>
          ) : null}
        </Section>
      </div>

      ) : null}

      {intermediate ? (
      <Section
        tier="moderate"
        title="Spatial autocorrelation"
        subtitle="Moran's I on the thirty most variable features. Both statistics are reported: a feature high on one and not the other is telling you about the scale of its pattern."
        badge={<ResultBadge label="COMPUTED" method="spatial.autocorrelation" />}
      >
        <DataTable
          rows={[...results.autocorrelation].sort((a, b) => b.moransI - a.moransI).slice(0, 16)}
          columns={[
            { key: 'f', header: 'Feature', render: (r) => r.featureId },
            { key: 'i', header: "Moran's I", align: 'right', render: (r) => num(r.moransI, 3) },
            { key: 'c', header: "Geary's C", align: 'right', render: (r) => num(r.gearysC, 3) },
            { key: 'q', header: 'q', align: 'right', render: (r) => pValue(r.qValue) },
          ]}
        />
      </Section>
      ) : null}

      {intermediate ? <GraphConstructionPanel graph={results.graph} /> : null}
      {atLeast(context.project?.mode, 'expert') ? <ProvenancePanel manifest={results.manifest} /> : null}
    </div>
  );
}
