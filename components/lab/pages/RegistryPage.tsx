/**
 * The parameter registry — §5 and Appendix A.
 *
 * §5's rule is what this screen makes checkable: "every biological numeric
 * parameter must be evidence-derived, calibrated, data-derived, or explicitly
 * exploratory. Engineering guardrails may have defaults, but they must be
 * distinguished from biological evidence." So the kind is a column, not a
 * footnote, and a null default is shown as "no universal default" rather than
 * as a gap — which for a drug concentration is the honest state.
 */

import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, type ParameterRecord } from '../../../lib/api';
import { Caveat, DataTable, Section } from '../../ui/Badges';

const KIND_LABEL: Record<string, string> = {
  biological: 'Biological',
  guardrail: 'Engineering guardrail',
  method: 'Method choice',
  reproducibility: 'Reproducibility',
};

/*
 * The text variants, not the mark variants.
 *
 * These colour a word, and a word needs 4.5:1 where a mark needs 3:1. On the
 * light surface the plain series values fell to 2.5:1 for "Biological" and
 * 3.8:1 for "Method choice"; the -text steps are the same hues, darkened.
 */
const KIND_COLOUR: Record<string, string> = {
  biological: 'var(--series-3-text)',
  guardrail: 'var(--ink-muted)',
  method: 'var(--series-1-text)',
  reproducibility: 'var(--series-7-text)',
};

export default function RegistryPage(): React.ReactElement {
  const [records, setRecords] = useState<ParameterRecord[]>([]);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<string>('all');

  useEffect(() => {
    void api
      .registry()
      .then((payload) => {
        setRecords(payload.records);
        setNote(payload.note);
      })
      .catch((caught: unknown) => setError(caught instanceof ApiError ? caught.message : 'The registry could not be loaded.'));
  }, []);

  const kinds = useMemo(() => [...new Set(records.map((record) => record.kind))].sort(), [records]);
  const rows = records.filter((record) => kind === 'all' || record.kind === kind);

  if (error) return <Caveat tone="blocked">{error}</Caveat>;

  return (
    <div className="space-y-4">
      <Section title="Parameter registry" subtitle={note}>
        <div className="mb-3 flex flex-wrap gap-1.5">
          <Chip label={`All (${records.length})`} active={kind === 'all'} onClick={() => setKind('all')} />
          {kinds.map((entry) => (
            <Chip
              key={entry}
              label={`${KIND_LABEL[entry] ?? entry} (${records.filter((record) => record.kind === entry).length})`}
              active={kind === entry}
              onClick={() => setKind(entry)}
              colour={KIND_COLOUR[entry]}
            />
          ))}
        </div>

        <DataTable
          rows={rows}
          columns={[
            {
              key: 'name',
              header: 'Parameter',
              render: (record) => (
                <div>
                  <span style={{ color: 'var(--ink)' }}>
                    {record.name}
                    {record.symbol ? (
                      <span className="ml-1 font-mono text-[10.5px]" style={{ color: 'var(--ink-muted)' }}>
                        {record.symbol}
                      </span>
                    ) : null}
                  </span>
                  <p className="font-mono text-[10px]" style={{ color: 'var(--ink-muted)' }}>
                    {record.parameterId}
                  </p>
                </div>
              ),
            },
            {
              key: 'kind',
              header: 'Kind',
              render: (record) => (
                <span style={{ color: KIND_COLOUR[record.kind] ?? 'var(--ink-secondary)' }}>
                  {KIND_LABEL[record.kind] ?? record.kind}
                </span>
              ),
            },
            {
              key: 'default',
              header: 'Default',
              align: 'right',
              render: (record) =>
                record.defaultValue === null ? (
                  <span style={{ color: 'var(--ink-muted)' }}>no universal default</span>
                ) : (
                  <span className="tnum">
                    {String(record.defaultValue)}
                    {record.unit ? <span style={{ color: 'var(--ink-muted)' }}> {record.unit}</span> : null}
                  </span>
                ),
            },
            { key: 'range', header: 'Range rule', render: (record) => record.rangeRule },
            {
              key: 'source',
              header: 'Source',
              render: (record) =>
                record.source ?? (
                  <span style={{ color: record.confidence === 'exploratory' ? 'var(--status-serious)' : 'var(--ink-muted)' }}>
                    none — {record.confidence}
                  </span>
                ),
            },
            { key: 'who', header: 'Editable by', render: (record) => record.editableBy },
            { key: 'sub', header: 'Subsystem', render: (record) => record.subsystem },
          ]}
        />
      </Section>

      <Section title="Notes" subtitle="Where a parameter needs more than a table row.">
        <div className="space-y-2.5">
          {rows
            .filter((record) => record.notes)
            .map((record) => (
              <div key={record.parameterId} className="rounded border px-3 py-2" style={{ borderColor: 'var(--border)' }}>
                <p className="text-[12px] font-medium" style={{ color: 'var(--ink)' }}>
                  {record.name}
                </p>
                <p className="mt-0.5 text-[11.5px] leading-relaxed" style={{ color: 'var(--ink-secondary)' }}>
                  {record.notes}
                </p>
                <p className="mt-1 text-[10.5px]" style={{ color: 'var(--ink-muted)' }}>
                  Context: {record.context} · approved {record.approvedAt} · v{record.version}
                </p>
              </div>
            ))}
        </div>
      </Section>
    </div>
  );
}

function Chip({
  label,
  active,
  onClick,
  colour,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  colour?: string | undefined;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-full border px-2.5 py-1 text-[11px]"
      style={{
        borderColor: active ? (colour ?? 'var(--series-1)') : 'var(--border)',
        color: active ? (colour ?? 'var(--series-1-text)') : 'var(--ink-secondary)',
        background: active ? 'var(--surface-raised)' : 'transparent',
      }}
    >
      {label}
    </button>
  );
}
