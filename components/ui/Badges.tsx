/**
 * The §1.5 result labels and the §5.1 confidence categories, as badges.
 *
 * A badge here is not decoration. §1.5 gives each label a required UI
 * treatment, and the reason is stated in §11.3: measured data and model output
 * must be visually distinguishable, and a prediction must carry an explicit
 * badge. The label always comes from whatever produced the value — never from
 * the component drawing it — so a badge cannot disagree with the number beside
 * it.
 *
 * Each badge carries a shape as well as a colour: a filled dot for observed, a
 * ring for computed, a triangle for predicted. Colour alone fails in greyscale,
 * in forced colours, and for a reader with a colour-vision deficiency, and this
 * is exactly the distinction that must not fail.
 */

import { useMemo, useState } from 'react';

import type { Confidence, ResultLabel } from '../../types';
import { CONFIDENCE_LABEL, RESULT_LABEL_MEANING } from '../../types';

const LABEL_MARK: Record<ResultLabel, string> = {
  OBSERVED: '●',
  COMPUTED: '◍',
  PREDICTED: '▲',
  INTERPRETED: '✎',
  HYPOTHESIS: '?',
  VALIDATION: '⚗',
};

export function ResultBadge({
  label,
  method,
  className = '',
}: {
  label: ResultLabel;
  method?: string | undefined;
  className?: string;
}): React.ReactElement {
  const colour = `var(--label-${label.toLowerCase()})`;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-sm border px-1.5 py-[1px] text-[10px] font-medium tracking-wide ${className}`}
      style={{ color: colour, borderColor: colour }}
      title={`${RESULT_LABEL_MEANING[label]}${method ? ` Method: ${method}` : ''}`}
    >
      <span aria-hidden="true">{LABEL_MARK[label]}</span>
      {label}
    </span>
  );
}

const CONFIDENCE_STATUS: Record<Confidence, 'good' | 'warning' | 'serious' | 'critical'> = {
  high: 'good',
  moderate: 'warning',
  exploratory: 'serious',
  'not-interpretable': 'critical',
};

const CONFIDENCE_MARK: Record<Confidence, string> = {
  high: '✓',
  moderate: '!',
  exploratory: '~',
  'not-interpretable': '✕',
};

export function ConfidenceBadge({
  confidence,
  rule,
  className = '',
}: {
  confidence: Confidence;
  rule?: string | undefined;
  className?: string;
}): React.ReactElement {
  const status = CONFIDENCE_STATUS[confidence];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-sm px-1.5 py-[1px] text-[10px] font-medium ${className}`}
      // The word takes the text-safe step; the outline keeps the mark colour.
      style={{ color: `var(--status-${status}-text)`, border: `1px solid var(--status-${status})` }}
      title={rule ?? ''}
    >
      {/* Icon plus label: a status colour never carries meaning alone. */}
      <span aria-hidden="true">{CONFIDENCE_MARK[confidence]}</span>
      {CONFIDENCE_LABEL[confidence]}
    </span>
  );
}

export function VerdictBadge({ verdict }: { verdict: 'pass' | 'warning' | 'fail' }): React.ReactElement {
  const status = verdict === 'pass' ? 'good' : verdict === 'warning' ? 'warning' : 'critical';
  const mark = verdict === 'pass' ? '✓' : verdict === 'warning' ? '!' : '✕';
  return (
    <span
      className="inline-flex items-center gap-1 rounded-sm px-1.5 py-[1px] text-[10px] font-semibold uppercase"
      style={{ color: `var(--status-${status}-text)`, border: `1px solid var(--status-${status})` }}
    >
      <span aria-hidden="true">{mark}</span>
      {verdict}
    </span>
  );
}

/** A quiet panel for a caveat that has to be read but is not an error. */
export function Caveat({
  children,
  tone = 'note',
}: {
  children: React.ReactNode;
  tone?: 'note' | 'warning' | 'blocked';
}): React.ReactElement {
  const colour =
    tone === 'blocked' ? 'var(--status-critical)' : tone === 'warning' ? 'var(--status-warning)' : 'var(--ink-muted)';
  return (
    <div
      className="rounded border-l-2 px-3 py-2 text-[12px] leading-relaxed"
      style={{ borderColor: colour, background: 'var(--surface-sunken)', color: 'var(--ink-secondary)' }}
    >
      {children}
    </div>
  );
}

/** A labelled figure. Not a chart — §12 reserves those for comparisons. */
export function StatTile({
  label,
  value,
  unit,
  detail,
  badge,
}: {
  label: string;
  value: string;
  unit?: string | undefined;
  detail?: string | undefined;
  badge?: React.ReactNode;
}): React.ReactElement {
  return (
    <div
      className="stat-tile rounded-lg border px-3.5 py-3"
      style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
    >
      {/*
        * The badge never shrinks: when the label and badge do not fit on one
        * line, the badge wraps below the label. Squeezed, "Not interpretable"
        * broke across two lines and ran into the tile edge at 1024px.
        */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
        <span className="t-eyebrow" style={{ color: 'var(--ink-muted)' }}>
          {label}
        </span>
        {badge ? <span className="shrink-0 whitespace-nowrap">{badge}</span> : null}
      </div>
      {/*
        * The value is the point of the tile, so it is given the display step and
        * proportional figures. It used to be `text-xl` beside an 11px label —
        * close enough in weight that the tile read as a paragraph with a big
        * first word rather than as a figure with a caption.
        */}
      <div className="mt-1.5 flex flex-wrap items-baseline gap-x-1.5">
        <span className="t-display" style={{ color: 'var(--ink)' }}>
          {value}
        </span>
        {unit ? (
          <span className="t-small whitespace-nowrap" style={{ color: 'var(--ink-muted)' }}>
            {unit}
          </span>
        ) : null}
      </div>
      {detail ? (
        <p className="mt-1.5 t-small" style={{ color: 'var(--ink-secondary)' }}>
          {detail}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Marks a section that a mode adds, so a reader can see what their mode is
 * giving them. Beginner sections carry no tag.
 */
export function ModeTag({ tier }: { tier: 'moderate' | 'expert' }): React.ReactElement {
  return (
    <span className="mode-tag" data-tier={tier} title={tier === 'expert' ? 'Shown in Advanced mode' : 'Shown in Intermediate and Advanced modes'}>
      {tier === 'expert' ? 'Advanced' : 'Intermediate'}
    </span>
  );
}

export function Section({
  title,
  subtitle,
  badge,
  children,
  actions,
  tier,
}: {
  title: string;
  subtitle?: string | undefined;
  badge?: React.ReactNode;
  children: React.ReactNode;
  actions?: React.ReactNode;
  /** The lowest mode that shows this section; renders a tag in the header. */
  tier?: 'moderate' | 'expert' | undefined;
}): React.ReactElement {
  return (
    <section
      className="section-card overflow-hidden border"
      style={{ borderColor: 'var(--border)', background: 'var(--surface)', boxShadow: 'var(--elevation-1)' }}
    >
      <header
        className="flex flex-wrap items-start justify-between gap-3 border-b px-5 py-3.5"
        style={{ borderColor: 'var(--border)' }}
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="t-heading" style={{ color: 'var(--ink)' }}>
              {title}
            </h2>
            {tier ? <ModeTag tier={tier} /> : null}
            {badge}
          </div>
          {subtitle ? (
            <p className="t-small mt-1" style={{ color: 'var(--ink-secondary)' }}>
              {subtitle}
            </p>
          ) : null}
        </div>
        {actions}
      </header>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

export function Button({
  children,
  onClick,
  variant = 'secondary',
  disabled,
  title,
  type = 'button',
}: {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'quiet';
  disabled?: boolean;
  title?: string;
  type?: 'button' | 'submit';
}): React.ReactElement {
  /*
   * `btn` carries the hover and active states from the stylesheet, because they
   * need `:hover`/`:active` selectors that an inline style object cannot express
   * — and a control with no feedback on press is the detail that makes an
   * interface feel unfinished more than any single wrong colour.
   */
  const base = `btn btn-${variant} t-body rounded-md px-3 py-1.5 font-medium disabled:cursor-not-allowed disabled:opacity-45`;
  const styles: React.CSSProperties =
    variant === 'primary'
      ? { background: 'var(--action)', color: '#fff' }
      : variant === 'quiet'
        ? { color: 'var(--ink-secondary)' }
        : { border: '1px solid var(--border-strong)', color: 'var(--ink)', background: 'var(--surface-raised)' };
  return (
    <button type={type} className={base} style={styles} onClick={onClick} disabled={disabled} title={title}>
      {children}
    </button>
  );
}

/**
 * A table that is also the accessible alternative to a chart.
 *
 * Every chart in this lab has one of these beside or behind it. That is not
 * only an accessibility affordance: three of the light-mode series colours sit
 * below 3:1 against the surface, and the rule for those is that the values are
 * available as text.
 */
export function DataTable<T>({
  rows,
  columns,
  empty = 'Nothing to show.',
  maxHeight,
}: {
  rows: T[];
  columns: {
    key: string;
    header: string;
    align?: 'left' | 'right';
    render: (row: T) => React.ReactNode;
    /**
     * Makes the column sortable. Opt-in and explicit, because `render` returns
     * a node and deriving an order from rendered markup would sort "1.2e-3"
     * after "9" and a badge by its icon — a table that sorts wrongly is worse
     * than one that does not sort.
     */
    sortKey?: (row: T) => string | number;
  }[];
  empty?: string;
  maxHeight?: number;
}): React.ReactElement {
  const [sort, setSort] = useState<{ key: string; direction: 'asc' | 'desc' } | null>(null);

  /*
   * The displayed order. The default is the order the caller supplied, which is
   * frequently meaningful here — candidates arrive ranked, QC checks run in
   * sequence — so sorting is something the reader turns on rather than a state
   * the table starts in, and a third click returns to it.
   */
  const ordered = useMemo(() => {
    if (!sort) return rows;
    const column = columns.find((candidate) => candidate.key === sort.key);
    if (!column?.sortKey) return rows;
    const read = column.sortKey;
    const factor = sort.direction === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const left = read(a);
      const right = read(b);
      // Non-finite values sort last in both directions: a missing measurement
      // is not the smallest measurement.
      const leftBad = typeof left === 'number' && !Number.isFinite(left);
      const rightBad = typeof right === 'number' && !Number.isFinite(right);
      if (leftBad || rightBad) return leftBad && rightBad ? 0 : leftBad ? 1 : -1;
      if (typeof left === 'number' && typeof right === 'number') return (left - right) * factor;
      return String(left).localeCompare(String(right), undefined, { numeric: true }) * factor;
    });
  }, [rows, columns, sort]);

  const toggle = (key: string): void => {
    setSort((current) => {
      if (current?.key !== key) return { key, direction: 'desc' };
      if (current.direction === 'desc') return { key, direction: 'asc' };
      return null;
    });
  };

  if (rows.length === 0) {
    return (
      <p className="py-3 text-xs" style={{ color: 'var(--ink-muted)' }}>
        {empty}
      </p>
    );
  }
  /*
   * Scanning aids, which a table of this density needs more than a chart does.
   *
   * The QC table is twelve rows of five columns of small prose, and with a
   * hairline under every row and nothing else it read as one grey block: the
   * eye had no way to hold a row while crossing it. Three changes do the work —
   * a row hover that follows the pointer across the full width, generous
   * vertical padding so each row is a band rather than a line, and a header
   * that is visually a label rather than another row of data.
   *
   * No zebra striping: with a hover band and this much row padding it adds a
   * second, competing rhythm, and on the dark theme the stripe is either
   * invisible or loud.
   */
  return (
    <>
      {/*
        * Below `sm` the table becomes a stack of cards, one per row.
        *
        * A five-column table on a 390px screen can only scroll sideways, and
        * then each column is two words wide and the header scrolls out of view
        * — so a reader holds a row by memory while dragging across it. Stacking
        * puts each cell under its own label and turns the row into something
        * readable in one direction.
        *
        * Only one of the two ever exists for assistive technology, because
        * `hidden` is `display: none` and is not announced. The same data, laid
        * out for the space available.
        */}
      <ul className="space-y-2 sm:hidden">
        {ordered.map((row, index) => (
          <li
            key={index}
            className="rounded-md border px-3 py-2.5"
            style={{ borderColor: 'var(--border)', background: 'var(--surface-sunken)' }}
          >
            <dl className="space-y-1.5">
              {columns.map((column) => (
                <div key={column.key} className="grid grid-cols-[5.5rem_1fr] items-baseline gap-x-3">
                  <dt className="t-caption truncate" style={{ color: 'var(--ink-muted)' }}>
                    {column.header}
                  </dt>
                  <dd className="min-w-0 text-[11.5px] leading-relaxed" style={{ color: 'var(--ink-secondary)' }}>
                    {column.render(row)}
                  </dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>

      <div className="table-shell -mx-1 hidden overflow-auto sm:block" style={maxHeight ? { maxHeight } : undefined}>
      <table className="w-full border-collapse text-[11.5px]">
        <thead className="sticky top-0 z-10" style={{ background: 'var(--surface)' }}>
          <tr>
            {columns.map((column) => {
              const sortable = Boolean(column.sortKey);
              const direction = sort?.key === column.key ? sort.direction : null;
              return (
                <th
                  key={column.key}
                  scope="col"
                  aria-sort={direction ? (direction === 'asc' ? 'ascending' : 'descending') : sortable ? 'none' : undefined}
                  className={`t-eyebrow border-b px-2.5 pb-2 pt-1 ${column.align === 'right' ? 'text-right' : 'text-left'}`}
                  style={{ borderColor: 'var(--border-strong)', color: 'var(--ink-muted)' }}
                >
                  {sortable ? (
                    <button
                      type="button"
                      onClick={() => toggle(column.key)}
                      className={`interactive -mx-1 inline-flex items-center gap-1 rounded px-1 py-0.5 ${column.align === 'right' ? 'flex-row-reverse' : ''}`}
                      style={{ color: direction ? 'var(--ink)' : 'inherit' }}
                    >
                      {column.header}
                      {/* The arrow appears only once a column is sorting, so a
                          header row is not a row of chevrons competing with the
                          data. The hover state is what advertises the affordance. */}
                      <span aria-hidden="true" style={{ opacity: direction ? 1 : 0.35, fontSize: '0.85em' }}>
                        {direction === 'asc' ? '▲' : '▼'}
                      </span>
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {ordered.map((row, index) => (
            <tr key={index} className="interactive align-top">
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={`border-b px-2.5 py-2.5 leading-relaxed ${column.align === 'right' ? 'text-right tnum' : 'text-left'}`}
                  style={{ borderColor: 'var(--border)', color: 'var(--ink-secondary)' }}
                >
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </>
  );
}
