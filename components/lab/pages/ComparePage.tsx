/**
 * Therapy comparison — §6.19 and §7.7.
 *
 * Components first. A composite score appears only when a reviewer-approved
 * weight set is configured; absent one, the screen shows a Pareto front and
 * says there is no single ranking, rather than defaulting to equal weights and
 * presenting the result as an answer.
 *
 * Benefit, adverse burden and uncertainty are three separate axes throughout.
 * That is what makes "a high rescue cannot hide an adverse burden" true rather
 * than aspirational.
 */

import type { RunDataState } from '../useRunData';
import { Caveat, ConfidenceBadge, DataTable, ResultBadge, Section, StatTile } from '../../ui/Badges';
import { EmptyState } from '../../ui/EmptyState';
import { BarChart, MatrixChart, ScatterChart } from '../../viz/Charts';
import { integer, num } from '../../../lib/format';
import type { WorkspaceContext } from '../Workspace';

export default function ComparePage({
  context,
  rescue,
}: {
  context: WorkspaceContext;
  rescue: RunDataState;
}): React.ReactElement {
  const results = rescue.results?.rescue;
  if (!results) {
    return (
      <EmptyState
        title="There is nothing to compare yet"
        explanation="Candidates are compared only after each one has been simulated separately against the same altered tissue (§2). Simulate them first and this screen will show the endpoint table and the Pareto front."
        requires={{ page: 'rescue' }}
        onGo={context.navigate}
      />
    );
  }

  const comparison = results.comparison;
  const componentIds = [...new Set(results.simulated.flatMap((entry) => entry.components.map((c) => c.id)))];
  const componentNames = new Map(results.simulated.flatMap((entry) => entry.components.map((c) => [c.id, c.name] as const)));
  const directions = new Map(results.simulated.flatMap((entry) => entry.components.map((c) => [c.id, c.direction] as const)));

  const matrixValues = comparison.table.flatMap((row) => componentIds.map((id) => row.normalised[id] ?? Number.NaN));

  const front = new Set(comparison.paretoFront);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Compared" value={integer(comparison.table.length)} detail="Every one simulated against the same altered state." />
        <StatTile label="Pareto front" value={integer(comparison.paretoFront.length)} detail="Nothing beats these on all three axes together." />
        <StatTile label="Composite score" value={comparison.composite ? 'Enabled' : 'Disabled'} detail={comparison.policy ? comparison.policy.id : 'No reviewer-approved weight set.'} />
        <StatTile label="Ties" value={integer(comparison.ties.length)} detail="Pairs within the separation threshold." />
      </div>

      {comparison.noClearWinner ? <Caveat tone="warning">{comparison.noClearWinner}</Caveat> : null}

      {comparison.degenerateComponents.length > 0 ? (
        <Caveat tone="warning">
          <p className="font-medium" style={{ color: 'var(--ink)' }}>
            These components are not separating the candidates
          </p>
          <ul className="ml-4 mt-1 list-disc">
            {comparison.degenerateComponents.map((entry) => (
              <li key={entry.id}>
                <strong style={{ color: 'var(--ink)' }}>{entry.name}</strong> — {entry.note}
              </li>
            ))}
          </ul>
        </Caveat>
      ) : null}

      <Section
        title="Component matrix"
        subtitle="Normalised within this set: 1.0 means best of the candidates simulated here, never 'good'."
        badge={<ResultBadge label="PREDICTED" />}
      >
        {comparison.table.length > 0 && componentIds.length > 0 ? (
          <MatrixChart
            labels={comparison.table.map((row) => row.name)}
            columnLabels={componentIds.map((id) => componentNames.get(id) ?? id)}
            values={matrixValues}
            mode="sequential"
            cellSize={56}
            title="Normalised component scores"
            valueFormat={(value) => num(value, 2)}
          />
        ) : (
          <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
            No components to compare.
          </p>
        )}
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10.5px]" style={{ color: 'var(--ink-muted)' }}>
          {componentIds.map((id) => (
            <span key={id}>
              {componentNames.get(id) ?? id}: {directions.get(id) === 'higher-is-better' ? 'higher is better' : 'lower is better'}
            </span>
          ))}
        </div>
      </Section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section
          title="Benefit against adverse burden"
          subtitle="Two axes, never summed. A candidate in the lower right does well on both."
          badge={<ResultBadge label="PREDICTED" />}
        >
          <ScatterChart
            points={comparison.table.map((row) => {
              const benefits = componentIds
                .filter((id) => directions.get(id) === 'higher-is-better')
                .map((id) => row.normalised[id] ?? Number.NaN)
                .filter(Number.isFinite);
              return {
                x: benefits.length > 0 ? benefits.reduce((a, b) => a + b, 0) / benefits.length : 0,
                y: row.adverseBurden,
                label: row.name,
              };
            })}
            xLabel="Mean normalised benefit"
            yLabel="Adverse burden"
            identity={false}
          />
          <p className="mt-2 text-[10.5px]" style={{ color: 'var(--ink-muted)' }}>
            Candidates on the Pareto front: {comparison.paretoFront.length > 0 ? comparison.paretoFront.join(', ') : 'none'}.
          </p>
        </Section>

        <Section title="Adverse burden by candidate" badge={<ResultBadge label="PREDICTED" />}>
          <BarChart
            data={comparison.table.map((row) => ({
              label: row.name,
              value: row.adverseBurden,
              detail: `uncertainty ${num(row.uncertainty, 4)}`,
            }))}
            valueLabel="Adverse burden"
            formatValue={(value) => num(value, 4)}
          />
        </Section>
      </div>

      <Section
        title="Candidate table"
        subtitle="The accessible alternative to the matrix, and the form the report exports."
      >
        <DataTable
          rows={comparison.table}
          columns={[
            {
              key: 'n',
              header: 'Candidate',
              sortKey: (row) => row.name,
              render: (row) => (
                <span>
                  {row.name}
                  {front.has(row.candidateId) ? (
                    <span className="ml-1.5 text-[10px]" style={{ color: 'var(--status-good)' }}>
                      Pareto
                    </span>
                  ) : null}
                </span>
              ),
            },
            /*
             * The endpoint columns sort, because reordering by an endpoint is
             * exactly the comparison §6.19 asks a reader to make for themselves
             * when no composite score exists. The default order is the one the
             * engine returned; a third click restores it.
             */
            ...componentIds.map((id) => ({
              key: id,
              header: `${componentNames.get(id) ?? id}${comparison.degenerateComponents.some((entry) => entry.id === id) ? ' ·' : ''}`,
              align: 'right' as const,
              render: (row: (typeof comparison.table)[number]) =>
                Number.isFinite(row.raw[id]) ? num(row.raw[id] as number, 3) : '—',
              sortKey: (row: (typeof comparison.table)[number]) =>
                Number.isFinite(row.raw[id]) ? (row.raw[id] as number) : Number.NaN,
            })),
            { key: 'a', header: 'Adverse', align: 'right', render: (row) => num(row.adverseBurden, 4), sortKey: (row) => row.adverseBurden },
            { key: 'u', header: 'Uncertainty', align: 'right', render: (row) => num(row.uncertainty, 4), sortKey: (row) => row.uncertainty },
            { key: 'c', header: 'Confidence', render: (row) => <ConfidenceBadge confidence={row.confidence} /> },
          ]}
        />
      </Section>

      {comparison.ties.length > 0 ? (
        <Section title="Not separated" subtitle="Pairs whose difference is below what this policy considers meaningful.">
          <DataTable
            rows={comparison.ties}
            columns={[
              { key: 'a', header: 'Candidate A', render: (r) => r.a },
              { key: 'b', header: 'Candidate B', render: (r) => r.b },
              { key: 'r', header: 'Reason', render: (r) => r.reason },
            ]}
          />
        </Section>
      ) : null}

      <Section title="Ranking policy" subtitle="§6.19 — a composite score is enabled only when weights are frozen, justified and benchmarked.">
        {comparison.policy ? (
          <dl className="space-y-1 text-[11.5px]" style={{ color: 'var(--ink-secondary)' }}>
            <div className="flex justify-between gap-3">
              <dt style={{ color: 'var(--ink-muted)' }}>Policy</dt>
              <dd>{comparison.policy.id}@{comparison.policy.version}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt style={{ color: 'var(--ink-muted)' }}>Approved by</dt>
              <dd>{comparison.policy.approvedBy}</dd>
            </div>
            <div>
              <dt style={{ color: 'var(--ink-muted)' }}>Justification</dt>
              <dd className="mt-0.5">{comparison.policy.justification}</dd>
            </div>
          </dl>
        ) : (
          <Caveat tone="warning">
            No reviewer-approved weight set is configured for this deployment, so no composite score is produced and no single
            ranking is shown. The components above and the Pareto front are the comparison. Defaulting to equal weights would
            produce an ordering that looks like an answer and is a guess.
          </Caveat>
        )}
        <p className="mt-2 text-[10.5px]" style={{ color: 'var(--ink-muted)' }}>
          Method: {comparison.method}
        </p>
      </Section>

      {context.project?.mode === 'expert' ? (
        <Section title="Resistance and adaptation" subtitle="Named feedback nodes, so the figure is not a rename of the adverse burden.">
          <DataTable
            rows={results.simulated.filter((entry) => entry.status === 'complete').flatMap((entry) =>
              entry.resistanceDetail.map((detail) => ({ candidate: entry.name, ...detail })),
            )}
            maxHeight={300}
            columns={[
              { key: 'c', header: 'Candidate', render: (r) => r.candidate },
              { key: 's', header: 'Node', render: (r) => r.symbol },
              { key: 'd', header: 'Change', align: 'right', render: (r) => num(r.delta, 4) },
              { key: 'b', header: 'Why this node', render: (r) => r.because },
            ]}
          />
        </Section>
      ) : null}
    </div>
  );
}
