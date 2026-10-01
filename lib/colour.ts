/**
 * Colour scales for the tissue canvas and the charts.
 *
 * Three jobs, three rules, and they are not interchangeable (§11.3 and the
 * data-visualisation method this estate follows):
 *
 *   categorical — identity. Eight hues in a fixed slot order, never cycled. A
 *                 ninth class folds into "Other" rather than reusing slot 1,
 *                 because a repeated hue says two classes are the same thing.
 *   sequential  — magnitude. One hue, light to dark. Never a rainbow: a rainbow
 *                 invents boundaries where the data has none, and its lightness
 *                 is not monotone, so it cannot be read in greyscale or by
 *                 anyone with a colour-vision deficiency.
 *   diverging   — polarity. Two hues and a *neutral* midpoint, anchored at
 *                 zero. A hue at the middle would make "no change" look like a
 *                 value.
 *
 * The values come from the validated reference palette in `index.css`; this
 * file reads them so a theme change is one place, not two.
 */

const SERIES_SLOTS = 8;

function cssValue(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/** Slot colours, read once per theme change. */
let cachedSeries: string[] | null = null;
let cachedTheme = '';

export function seriesColours(): string[] {
  const theme = typeof document === 'undefined' ? '' : document.documentElement.dataset.theme ?? 'dark';
  if (cachedSeries && cachedTheme === theme) return cachedSeries;
  cachedTheme = theme;
  cachedSeries = Array.from({ length: SERIES_SLOTS }, (_, i) =>
    cssValue(`--series-${i + 1}`, ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'][i] as string),
  );
  return cachedSeries;
}

export function forgetColourCache(): void {
  cachedSeries = null;
}

/**
 * A categorical colour by slot.
 *
 * Past the eighth slot the caller is expected to have folded the tail into
 * "Other"; this returns the muted ink for anything beyond, so an overflow is
 * visible as grey rather than silently duplicating slot 1.
 */
export function categorical(index: number): string {
  const colours = seriesColours();
  if (index < 0 || index >= colours.length) return cssValue('--ink-muted', '#898781');
  return colours[index] as string;
}

export const OVERFLOW_CLASS_LABEL = 'Other';

/** A sequential ramp: one hue, light to dark. `t` in [0, 1]. */
const SEQUENTIAL = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'];

export function sequential(t: number): string {
  return rampAt(SEQUENTIAL, t);
}

/**
 * A diverging ramp anchored at zero.
 *
 * `t` is in [-1, 1]. The midpoint is the theme's neutral, so zero reads as
 * "nothing" rather than as a colour.
 */
export function diverging(t: number): string {
  const negative = cssValue('--div-neg', '#3987e5');
  const neutral = cssValue('--div-mid', '#383835');
  const positive = cssValue('--div-pos', '#e66767');
  const clamped = Math.max(-1, Math.min(1, t));
  return clamped < 0 ? mix(neutral, negative, -clamped) : mix(neutral, positive, clamped);
}

function rampAt(ramp: string[], t: number): string {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
  const position = clamped * (ramp.length - 1);
  const lower = Math.floor(position);
  const upper = Math.min(ramp.length - 1, lower + 1);
  return mix(ramp[lower] as string, ramp[upper] as string, position - lower);
}

function parse(hex: string): [number, number, number] {
  const value = hex.trim().replace('#', '');
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

/**
 * Mix in linear light, not in sRGB.
 *
 * A midpoint interpolated in gamma space is noticeably darker than it should
 * be, which puts a false band across the middle of every diverging scale.
 */
function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = parse(a);
  const [br, bg, bb] = parse(b);
  const lerp = (x: number, y: number): number => {
    const xl = Math.pow(x / 255, 2.2);
    const yl = Math.pow(y / 255, 2.2);
    return Math.round(255 * Math.pow(xl + (yl - xl) * t, 1 / 2.2));
  };
  const toHex = (n: number): string => n.toString(16).padStart(2, '0');
  return `#${toHex(lerp(ar, br))}${toHex(lerp(ag, bg))}${toHex(lerp(ab, bb))}`;
}

// ---------------------------------------------------------------------------
// Layer scaling
// ---------------------------------------------------------------------------

export interface ScaleInfo {
  kind: 'sequential' | 'diverging' | 'categorical';
  /** The domain actually used, after any robust trimming. */
  domain: [number, number];
  colourFor: (value: number) => string;
  /** Ticks for the legend, in data units. */
  ticks: number[];
  /** Set when the domain was trimmed, so the legend can say so. */
  trimmedNote: string | null;
}

/**
 * Builds the scale for a layer.
 *
 * Sequential and diverging domains are trimmed to the 1st–99th percentile. Not
 * cosmetic: a single outlying cell sets the top of the range and compresses
 * every other cell into the bottom of the ramp, and in a tumour section one
 * dying cell with ten times the counts of its neighbours does exactly that. The
 * legend says the domain was trimmed and what to.
 *
 * A diverging domain is made symmetric about zero, because an asymmetric one
 * puts the neutral colour somewhere other than zero and the map then reads
 * "no change" as a change.
 */
export function buildScale(
  values: number[],
  kind: 'sequential' | 'diverging' | 'categorical',
  categories: string[] | null,
  explicitDomain?: [number, number],
): ScaleInfo {
  if (kind === 'categorical') {
    const count = categories?.length ?? 0;
    return {
      kind,
      domain: [0, Math.max(0, count - 1)],
      colourFor: (value) => categorical(Math.round(value)),
      ticks: Array.from({ length: count }, (_, i) => i),
      trimmedNote: count > SERIES_SLOTS
        ? `${count} classes and ${SERIES_SLOTS} distinct colours: classes past the eighth are drawn in grey rather than repeating a hue.`
        : null,
    };
  }

  const finite = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (finite.length === 0) {
    return { kind, domain: [0, 1], colourFor: () => cssValue('--ink-muted', '#898781'), ticks: [0, 1], trimmedNote: null };
  }

  const low = explicitDomain ? explicitDomain[0] : percentile(finite, 0.01);
  const high = explicitDomain ? explicitDomain[1] : percentile(finite, 0.99);
  const trimmed =
    !explicitDomain && (low > (finite[0] as number) || high < (finite[finite.length - 1] as number));

  if (kind === 'diverging') {
    const extent = Math.max(Math.abs(low), Math.abs(high)) || 1;
    return {
      kind,
      domain: [-extent, extent],
      colourFor: (value) => (Number.isFinite(value) ? diverging(value / extent) : cssValue('--ink-muted', '#898781')),
      ticks: [-extent, -extent / 2, 0, extent / 2, extent],
      trimmedNote: trimmed
        ? `Colour range trimmed to the 1st–99th percentile and made symmetric about zero, so the neutral colour sits at "no change".`
        : 'Colour range is symmetric about zero, so the neutral colour sits at "no change".',
    };
  }

  const span = high - low || 1;
  return {
    kind,
    domain: [low, high],
    colourFor: (value) =>
      Number.isFinite(value) ? sequential((value - low) / span) : cssValue('--ink-muted', '#898781'),
    ticks: [low, low + span / 4, low + span / 2, low + (3 * span) / 4, high],
    trimmedNote: trimmed
      ? `Colour range trimmed to the 1st–99th percentile (${low.toPrecision(3)} to ${high.toPrecision(3)}); values outside it are drawn at the ends of the ramp.`
      : null,
  };
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower] as number;
  return (sorted[lower] as number) * (upper - position) + (sorted[upper] as number) * (position - lower);
}

/** Status colours. Reserved — never reused as a series colour. */
export function statusColour(status: 'good' | 'warning' | 'serious' | 'critical'): string {
  return cssValue(`--status-${status}`, { good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b' }[status]);
}

/** The accent for a §1.5 result label. */
export function labelColour(label: string): string {
  return cssValue(`--label-${label.toLowerCase()}`, '#c3c2b7');
}
