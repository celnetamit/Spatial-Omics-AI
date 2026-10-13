/**
 * The implementation register, on screen.
 *
 * Shown to everyone. A lab that publishes its limitations only to the people
 * auditing it is telling two different stories, and the row that says a
 * capability is deliberately absent is as much a part of the account as the row
 * that says one is built.
 */

import { useState } from 'react';
import { IMPLEMENTATION_REGISTER, REGISTER_VERSION, type RegisterStatus } from '../../content/register';
import { Section } from '../ui/Badges';

const STATUS_LABEL: Record<RegisterStatus, string> = {
  implemented: 'Implemented',
  partial: 'Partial',
  absent: 'Deliberately absent',
  guardrail: 'Engineering guardrail',
};

const STATUS_COLOUR: Record<RegisterStatus, string> = {
  // -text steps: these colour each entry's status word as well as its outline.
  implemented: 'var(--status-good-text)',
  partial: 'var(--status-warning-text)',
  absent: 'var(--status-serious-text)',
  guardrail: 'var(--ink-muted)',
};

const STATUS_MARK: Record<RegisterStatus, string> = {
  implemented: '✓',
  partial: '◐',
  absent: '○',
  guardrail: '⚙',
};

export default function ImplementationRegister(): React.ReactElement {
  const [filter, setFilter] = useState<RegisterStatus | 'all'>('all');
  const rows = IMPLEMENTATION_REGISTER.filter((entry) => filter === 'all' || entry.status === filter);
  const counts = IMPLEMENTATION_REGISTER.reduce<Record<string, number>>((acc, entry) => {
    acc[entry.status] = (acc[entry.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <Section
      title="Implementation register"
      subtitle={`What this build actually does, capability by capability, against the frozen V1 handbook. Version ${REGISTER_VERSION}.`}
    >
      <div className="mb-3 flex flex-wrap gap-1.5">
        <FilterChip label={`All (${IMPLEMENTATION_REGISTER.length})`} active={filter === 'all'} onClick={() => setFilter('all')} />
        {(Object.keys(STATUS_LABEL) as RegisterStatus[]).map((status) => (
          <FilterChip
            key={status}
            label={`${STATUS_MARK[status]} ${STATUS_LABEL[status]} (${counts[status] ?? 0})`}
            active={filter === status}
            onClick={() => setFilter(status)}
            colour={STATUS_COLOUR[status]}
          />
        ))}
      </div>

      <div className="space-y-2.5">
        {rows.map((entry) => (
          <article
            key={entry.id}
            className="rounded border p-3"
            style={{ borderColor: 'var(--border)', background: 'var(--surface-sunken)' }}
          >
            <header className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-[13px] font-medium" style={{ color: 'var(--ink)' }}>
                {entry.capability}
              </h3>
              <span
                className="inline-flex items-center gap-1 rounded-sm px-1.5 py-[1px] text-[10px] font-medium"
                style={{ color: STATUS_COLOUR[entry.status], border: `1px solid ${STATUS_COLOUR[entry.status]}` }}
              >
                <span aria-hidden="true">{STATUS_MARK[entry.status]}</span>
                {STATUS_LABEL[entry.status]}
              </span>
            </header>
            <p className="mt-0.5 text-[10.5px]" style={{ color: 'var(--ink-muted)' }}>
              {entry.section}
            </p>
            <dl className="mt-2 space-y-1.5 text-[11.5px] leading-relaxed">
              <Row term="Built" detail={entry.built} />
              <Row term="Produced by" detail={entry.producedBy} mono />
              <Row term="Data lives" detail={entry.dataLocation} />
              <Row term="Evidence and limits" detail={entry.evidence} emphasise />
            </dl>
          </article>
        ))}
      </div>
    </Section>
  );
}

function Row({ term, detail, mono, emphasise }: { term: string; detail: string; mono?: boolean; emphasise?: boolean }): React.ReactElement {
  return (
    <div className="grid grid-cols-[110px_1fr] gap-2">
      <dt className="text-[10.5px] uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
        {term}
      </dt>
      <dd
        className={mono ? 'font-mono text-[11px]' : ''}
        style={{ color: emphasise ? 'var(--ink)' : 'var(--ink-secondary)' }}
      >
        {detail}
      </dd>
    </div>
  );
}

function FilterChip({
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
