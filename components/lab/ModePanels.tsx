/**
 * The panels a mode adds.
 *
 * The server shapes its results by the project's mode: Intermediate receives
 * the preprocessing record and the full graph, Advanced also receives the run
 * manifest (results.ts). Until these panels existed none of that was drawn,
 * so the three modes looked identical on every page but Compare. Each panel
 * renders only what the server actually sent; none of them derives a value.
 */

import type { AnalysisResults } from '../../lib/api';
import { integer, num, percent, shortHash, timestamp } from '../../lib/format';
import { DataTable, Section } from '../ui/Badges';

function Facts({ rows }: { rows: [string, React.ReactNode][] }): React.ReactElement {
  return (
    <dl className="grid gap-x-6 gap-y-1.5 text-[12px] sm:grid-cols-2">
      {rows.map(([label, value]) => (
        <div key={label} className="flex justify-between gap-3 border-b py-1" style={{ borderColor: 'var(--border)' }}>
          <dt style={{ color: 'var(--ink-muted)' }}>{label}</dt>
          <dd className="tnum text-right" style={{ color: 'var(--ink)' }}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

const show = (value: unknown): string =>
  value === null || value === undefined ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value);

/** Data & QC, Intermediate: what preprocessing kept and how. */
export function PreprocessingPanel({
  preprocessing,
  observations,
}: {
  preprocessing: AnalysisResults['preprocessing'] & { embeddingComponents?: number };
  observations: number | null;
}): React.ReactElement | null {
  if (preprocessing.keptObservations === undefined) return null;
  const variance = preprocessing.explainedVariance ?? [];
  const firstFive = variance.slice(0, 5).reduce((sum, value) => sum + value, 0);
  return (
    <Section tier="moderate" title="Preprocessing" subtitle="What the filters kept, how the counts were normalised, and how much variation the embedding holds.">
      <Facts
        rows={[
          ['Cells kept', observations ? `${integer(preprocessing.keptObservations)} of ${integer(observations)}` : integer(preprocessing.keptObservations)],
          ['Features kept', integer(preprocessing.keptFeatures ?? null)],
          ['Embedding components', integer(preprocessing.embeddingComponents ?? null)],
          ['Variance in the first five components', variance.length ? percent(firstFive) : '—'],
          ...Object.entries(preprocessing.parameters ?? {}).map(([key, value]): [string, React.ReactNode] => [key, show(value)]),
        ]}
      />
      {preprocessing.warnings.length ? (
        <ul className="mt-3 list-disc pl-5 text-[11.5px]" style={{ color: 'var(--ink-secondary)' }}>
          {preprocessing.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
    </Section>
  );
}

/** Baseline, Intermediate: how the spatial graph was built. */
export function GraphConstructionPanel({ graph }: { graph: AnalysisResults['graph'] }): React.ReactElement | null {
  if (!graph.parameters) return null;
  const d = graph.diagnostics;
  return (
    <Section tier="moderate" title="Graph construction" subtitle="The neighbourhood graph every spatial statistic and the propagation run on.">
      <Facts
        rows={[
          ['Method', graph.method],
          ...Object.entries(graph.parameters).filter(([key]) => key !== 'method').map(([key, value]): [string, React.ReactNode] => [key, show(value)]),
          ['Mean / median degree', `${num(d.meanDegree, 2)} / ${num(d.medianDegree, 2)}`],
          ['Components', integer(d.components)],
          ['Largest component', percent(d.largestComponentFraction)],
          ['Isolated cells', integer(d.isolatedNodes)],
          ['Median / longest edge', `${num(d.medianEdgeLength, 1)} / ${num(d.maximumEdgeLength, 1)}`],
          ['Symmetric', d.symmetric ? 'yes' : 'no'],
          ['Checksum', <span className="font-mono">{shortHash(graph.checksum ?? null)}</span>],
        ]}
      />
    </Section>
  );
}

interface Manifest {
  runId?: string;
  createdAt?: string;
  engineVersion?: string;
  seed?: number;
  parameterPack?: { id: string; version: string } | null;
  datasets?: { datasetId: string; revision: string; sha256: string; role: string }[];
  methods?: { id: string; name: string; version: string; summary?: string }[];
  warnings?: string[];
}

/** Advanced: the run manifest, so a result can be traced to its exact inputs. */
export function ProvenancePanel({ manifest, title = 'Provenance' }: { manifest: Record<string, unknown>; title?: string }): React.ReactElement | null {
  const m = manifest as Manifest;
  if (!m.runId) return null;
  return (
    <Section tier="expert" title={title} subtitle="The exact inputs and methods behind this run: enough to reproduce it.">
      <Facts
        rows={[
          ['Run', <span className="font-mono">{m.runId}</span>],
          ['Created', timestamp(m.createdAt ?? null)],
          ['Engine version', m.engineVersion ?? '—'],
          ['Seed', show(m.seed)],
          ['Parameter pack', m.parameterPack ? `${m.parameterPack.id} ${m.parameterPack.version}` : '—'],
          ...(m.datasets ?? []).map((dataset): [string, React.ReactNode] => [
            `Dataset (${dataset.role})`,
            <span className="font-mono">{`${dataset.datasetId} · ${shortHash(dataset.sha256)}`}</span>,
          ]),
        ]}
      />
      {m.methods?.length ? (
        <div className="mt-4">
          <DataTable
            rows={m.methods}
            maxHeight={320}
            columns={[
              { key: 'n', header: 'Method', render: (r) => r.name },
              { key: 'v', header: 'Version', render: (r) => r.version },
              { key: 's', header: 'What it did', render: (r) => r.summary ?? '—' },
            ]}
          />
        </div>
      ) : null}
    </Section>
  );
}
