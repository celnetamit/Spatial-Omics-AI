/**
 * Number and label formatting.
 *
 * One rule runs through all of it: a number is shown with the precision it
 * carries and not one digit more. A q-value printed as 0.00 is unreadable and a
 * fold change printed to eight places is false precision, and both make a table
 * harder to trust than a blank would.
 */

/** A measured quantity, at a sensible precision for its magnitude. */
export function num(value: number | null | undefined, digits = 3): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const magnitude = Math.abs(value);
  if (magnitude === 0) return '0';
  if (magnitude >= 1e5 || magnitude < 1e-4) return value.toExponential(2);
  if (magnitude >= 100) return value.toFixed(0);
  if (magnitude >= 10) return value.toFixed(1);
  return value.toPrecision(digits);
}

export function integer(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return Math.round(value).toLocaleString();
}

export function percent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

/**
 * A p or q value.
 *
 * Below the smallest value a permutation test can report, the correct form is
 * an inequality: with 1000 permutations the smallest reportable value is
 * 1/1001, and printing "0.000" claims a precision the test does not have.
 */
export function pValue(value: number | null | undefined, permutations?: number): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (permutations && value <= 1 / (permutations + 1) + 1e-12) {
    return `≤ ${(1 / (permutations + 1)).toExponential(1)}`;
  }
  if (value < 1e-4) return value.toExponential(1);
  if (value < 0.001) return value.toFixed(5);
  return value.toFixed(4);
}

/** A signed change, with the sign always shown. */
export function delta(value: number | null | undefined, digits = 3): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const formatted = num(Math.abs(value), digits);
  if (value === 0) return '0';
  return `${value > 0 ? '+' : '−'}${formatted}`;
}

/** A concentration in nM, shown in whichever unit reads best. */
export function concentration(nanomolar: number | null | undefined): string {
  if (nanomolar === null || nanomolar === undefined || !Number.isFinite(nanomolar)) return '—';
  if (nanomolar >= 1e6) return `${num(nanomolar / 1e6)} mM`;
  if (nanomolar >= 1e3) return `${num(nanomolar / 1e3)} µM`;
  return `${num(nanomolar)} nM`;
}

export function duration(milliseconds: number | null | undefined): string {
  if (milliseconds === null || milliseconds === undefined || !Number.isFinite(milliseconds)) return '—';
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  const seconds = milliseconds / 1000;
  if (seconds < 90) return `${seconds.toFixed(1)} s`;
  return `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
}

export function timestamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/** A short hash, for a checksum shown in a manifest. */
export function shortHash(hash: string | null | undefined, length = 12): string {
  if (!hash) return '—';
  return hash.length <= length ? hash : `${hash.slice(0, length)}…`;
}

export function titleCase(value: string): string {
  return value.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Pluralise without the "(s)" that makes a sentence read like a form. */
export function plural(count: number, singular: string, pluralForm?: string): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : pluralForm ?? `${singular}s`}`;
}
