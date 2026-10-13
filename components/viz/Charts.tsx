/**
 * The chart primitives.
 *
 * Inline SVG, one file, no plotting library: the shapes this lab needs are a
 * bar, a line, a scatter and a matrix, and a library for four forms costs more
 * in bundle and in indirection than it saves.
 *
 * The rules these follow, from the estate's visualisation method:
 *
 *  - **One axis.** No chart here has two y-scales. Two measures of different
 *    magnitude become two charts or an indexed pair, never a dual axis.
 *  - **Colour by job.** Identity uses the fixed categorical order; magnitude
 *    uses one hue light-to-dark; polarity uses two hues and a neutral middle.
 *  - **Identity never colour-alone.** Every multi-series chart has a legend,
 *    and ≤ 4 series are also labelled directly at the mark.
 *  - **Thin marks, recessive chrome.** Hairline grid, 2px lines, 4px rounded
 *    bar ends anchored at the baseline.
 *  - **Hover by default.** Every mark has a tooltip; the hit target is larger
 *    than the mark.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { categorical, diverging, sequential } from '../../lib/colour';
import { num, percent } from '../../lib/format';

interface Margin {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const DEFAULT_MARGIN: Margin = { top: 12, right: 16, bottom: 34, left: 56 };

/*
 * The width a chart actually has, so it can be drawn at that width.
 *
 * Every chart here used to be a fixed viewBox scaled to fit (`width="100%"`),
 * which shrank the text along with the drawing: measured on the bar charts,
 * 11px labels rendered at 9px on a 390px phone, 6px at 320px, and 7px in the
 * two-column panels at 1024px. Charts now lay themselves out for the measured
 * width (the plot area flexes, the text does not) and only fall back to
 * scaling before the first measurement or if one is unavailable.
 *
 * A callback ref, because some charts mount their wrapper only after an
 * early return; the first measurement happens during commit, so the
 * re-render lands before the first paint.
 */
function useAvailableWidth(): [(node: HTMLDivElement | null) => void, number | null] {
  const [width, setWidth] = useState<number | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((node: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node) return;
    const measure = (): void => {
      const next = Math.floor(node.clientWidth);
      setWidth((current) => (next > 0 && next !== current ? next : current));
    };
    measure();
    if (typeof ResizeObserver !== 'undefined') {
      observer.current = new ResizeObserver(measure);
      observer.current.observe(node);
    }
  }, []);
  useEffect(() => () => observer.current?.disconnect(), []);
  return [ref, width];
}

/*
 * Label truncation by measured width, not by a characters-per-unit estimate.
 *
 * The estimate (5.9 units per character) was tuned at the 480-unit design
 * width, where the label column has slack. Once a chart lays itself out for
 * a narrow screen the column is tight, and "Immune-evasion signature" came
 * out 4px wider than the estimate and was clipped at the left edge. This
 * measures with the page's own font, the one the SVG text inherits.
 */
let measureContext: CanvasRenderingContext2D | null | undefined;
let measureFamily = '';
function textWidth(text: string, fontSize: number): number {
  if (measureContext === undefined) {
    measureContext = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
    measureFamily = typeof document === 'undefined' ? 'sans-serif' : getComputedStyle(document.body).fontFamily;
  }
  if (!measureContext) return text.length * fontSize * 0.62;
  measureContext.font = `${fontSize}px ${measureFamily}`;
  return measureContext.measureText(text).width;
}

/** The longest prefix of `label` (plus an ellipsis) that fits in `maxWidth`. */
function fitLabel(label: string, maxWidth: number, fontSize: number): string {
  if (textWidth(label, fontSize) <= maxWidth) return label;
  let low = 0;
  let high = label.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (textWidth(`${label.slice(0, mid)}…`, fontSize) <= maxWidth) low = mid;
    else high = mid - 1;
  }
  return `${label.slice(0, low).trimEnd()}…`;
}

/** The drawing width: the design width, or less when that is all there is. */
function fitWidth(designWidth: number, available: number | null): number {
  return available !== null && available > 0 ? Math.min(designWidth, available) : designWidth;
}

/*
 * Drawn 1:1 when the measurement is right. max-width and height:auto keep the
 * old scale-to-fit behaviour as the fallback rather than overflowing.
 */
const SVG_FIT: React.CSSProperties = { maxWidth: '100%', height: 'auto', display: 'block' };

function Tooltip({ x, y, width, lines }: { x: number; y: number; width: number; lines: string[] }): React.ReactElement {
  const boxWidth = Math.max(...lines.map((line) => line.length)) * 6.1 + 18;
  const boxHeight = lines.length * 15 + 12;
  // Flip to the left near the right edge, so the tooltip never leaves the plot.
  const left = x + boxWidth + 12 > width ? x - boxWidth - 10 : x + 10;
  return (
    <g pointerEvents="none">
      <rect
        x={left}
        y={y - boxHeight / 2}
        width={boxWidth}
        height={boxHeight}
        rx={4}
        fill="var(--surface-raised)"
        stroke="var(--border-strong)"
      />
      {lines.map((line, index) => (
        <text
          key={line + index}
          x={left + 9}
          y={y - boxHeight / 2 + 17 + index * 15}
          fontSize={11}
          fill={index === 0 ? 'var(--ink)' : 'var(--ink-secondary)'}
          className="tnum"
        >
          {line}
        </text>
      ))}
    </g>
  );
}

function Axes({
  width,
  height,
  margin,
  xTicks,
  yTicks,
  xLabel,
  yLabel,
}: {
  width: number;
  height: number;
  margin: Margin;
  xTicks: { position: number; label: string }[];
  yTicks: { position: number; label: string }[];
  xLabel?: string;
  yLabel?: string;
}): React.ReactElement {
  return (
    <g>
      {yTicks.map((tick) => (
        <g key={`y${tick.label}${tick.position}`}>
          <line
            x1={margin.left}
            x2={width - margin.right}
            y1={tick.position}
            y2={tick.position}
            stroke="var(--grid)"
            strokeWidth={1}
          />
          <text x={margin.left - 8} y={tick.position + 3.5} fontSize={10} textAnchor="end" fill="var(--ink-muted)" className="tnum">
            {tick.label}
          </text>
        </g>
      ))}
      {xTicks.map((tick) => (
        <text
          key={`x${tick.label}${tick.position}`}
          x={tick.position}
          y={height - margin.bottom + 15}
          fontSize={10}
          textAnchor="middle"
          fill="var(--ink-muted)"
        >
          {tick.label}
        </text>
      ))}
      <line
        x1={margin.left}
        x2={width - margin.right}
        y1={height - margin.bottom}
        y2={height - margin.bottom}
        stroke="var(--axis)"
        strokeWidth={1}
      />
      {xLabel ? (
        <text x={(margin.left + width - margin.right) / 2} y={height - 2} fontSize={10} textAnchor="middle" fill="var(--ink-muted)">
          {xLabel}
        </text>
      ) : null}
      {yLabel ? (
        <text
          x={-(margin.top + height - margin.bottom) / 2}
          y={11}
          fontSize={10}
          textAnchor="middle"
          fill="var(--ink-muted)"
          transform="rotate(-90)"
        >
          {yLabel}
        </text>
      ) : null}
    </g>
  );
}

// ---------------------------------------------------------------------------
// Bars
// ---------------------------------------------------------------------------

export interface BarDatum {
  label: string;
  value: number;
  /** Optional second line in the tooltip. */
  detail?: string | undefined;
  /** Fixed slot for identity colour, or undefined for a single-series bar. */
  slot?: number | undefined;
}

/**
 * A horizontal bar chart.
 *
 * Horizontal because the categories here are gene symbols and signature names,
 * which do not fit under a vertical bar without rotating the text — and
 * rotated axis labels are a reliable way to make a chart unreadable.
 *
 * `diverging` anchors the baseline at zero and colours by sign, which is what a
 * change wants; the default sequential form anchors at zero and colours by one
 * hue, which is what a magnitude wants.
 */
export function BarChart({
  data,
  width: designWidth = 480,
  height,
  valueLabel,
  mode = 'sequential',
  formatValue = (value: number) => num(value),
  emptyMessage = 'No values to show.',
}: {
  data: BarDatum[];
  width?: number;
  height?: number;
  valueLabel: string;
  mode?: 'sequential' | 'diverging' | 'categorical';
  formatValue?: (value: number) => string;
  emptyMessage?: string | undefined;
}): React.ReactElement {
  const [hover, setHover] = useState<number | null>(null);
  const [measureRef, available] = useAvailableWidth();
  const width = fitWidth(designWidth, available);
  const rowHeight = 22;
  /*
   * The label column is sized to the labels, within limits.
   *
   * It was a fixed 140 units with the text hard-truncated at 22 characters, so
   * "TGF-beta signalling and EMT" and "PI3K / AKT / mTOR signalling" both came
   * out as an ellipsis at the same place and a reader could not tell which
   * pathway a bar belonged to — on a chart whose whole job is to rank named
   * things. The column now grows for longer names and the truncation follows
   * the width it actually has, rather than a constant that had stopped
   * matching it.
   */
  const longest = data.reduce((most, d) => Math.max(most, d.label.length), 0);
  const naturalLabelWidth = Math.min(210, Math.max(110, longest * 5.9 + 14));
  /*
   * Room for the value printed at the end of each bar.
   *
   * The right margin was a fixed 20 units, so the label beside the longest bar
   * ("+0.912") ran past the edge of the viewBox and was cut to "+0." on the
   * Rescue drivers chart. A negative bar's label had the same problem on the
   * other side, where it would have collided with the category names. Each
   * side now reserves the width of its widest label, and only when a bar
   * actually points that way.
   */
  const valueRoom = (sign: 1 | -1): number => {
    const chars = data.reduce(
      (most, d) => (Number.isFinite(d.value) && Math.sign(d.value) === sign ? Math.max(most, formatValue(d.value).length) : most),
      0,
    );
    return chars === 0 ? 0 : Math.ceil(chars * 6.2 + 8);
  };
  /*
   * On a narrow screen the label column gives way first, so the bars keep at
   * least 120 units; names truncate with an ellipsis (full text in <title>).
   * At the 480-unit design width this changes nothing.
   */
  const labelWidth = Math.max(72, Math.min(naturalLabelWidth, width - valueRoom(1) - valueRoom(-1) - 120));
  const margin: Margin = {
    top: 10,
    right: Math.max(20, valueRoom(1)),
    bottom: 26,
    left: labelWidth + valueRoom(-1),
  };
  const plotHeight = height ?? data.length * rowHeight + margin.top + margin.bottom;

  const extent = useMemo(() => {
    const finite = data.map((d) => d.value).filter((v) => Number.isFinite(v));
    if (finite.length === 0) return { min: 0, max: 1 };
    const min = Math.min(0, ...finite);
    const max = Math.max(0, ...finite);
    if (mode === 'diverging') {
      const bound = Math.max(Math.abs(min), Math.abs(max)) || 1;
      return { min: -bound, max: bound };
    }
    return { min, max: max || 1 };
  }, [data, mode]);

  if (data.length === 0) {
    return (
      <p className="py-4 text-xs" style={{ color: 'var(--ink-muted)' }}>
        {emptyMessage}
      </p>
    );
  }

  const plotWidth = width - margin.left - margin.right;
  const span = extent.max - extent.min || 1;
  const xOf = (value: number): number => margin.left + ((value - extent.min) / span) * plotWidth;
  const zeroX = xOf(0);

  return (
    <div ref={measureRef} className="w-full min-w-0">
    <svg width={width} height={plotHeight} style={SVG_FIT} viewBox={`0 0 ${width} ${plotHeight}`} role="img" aria-label={`${valueLabel} by category`}>
      <line x1={zeroX} x2={zeroX} y1={margin.top} y2={plotHeight - margin.bottom} stroke="var(--axis)" strokeWidth={1} />
      {data.map((datum, index) => {
        const y = margin.top + index * rowHeight;
        const value = Number.isFinite(datum.value) ? datum.value : 0;
        const barX = value >= 0 ? zeroX : xOf(value);
        const barWidth = Math.max(1.5, Math.abs(xOf(value) - zeroX));
        const fill =
          mode === 'categorical'
            ? categorical(datum.slot ?? index)
            : mode === 'diverging'
              ? diverging(value / (extent.max || 1))
              : sequential(0.35 + 0.5 * (Math.abs(value) / (extent.max || 1)));
        return (
          <g
            key={datum.label}
            onPointerEnter={() => setHover(index)}
            onPointerLeave={() => setHover(null)}
            style={{ cursor: 'default' }}
          >
            {/* A hit target taller than the bar, so hovering is not fiddly. */}
            <rect x={2} y={y} width={width - 4} height={rowHeight} fill="transparent" />
            <text x={labelWidth - 8} y={y + rowHeight / 2 + 3.5} fontSize={11} textAnchor="end" fill="var(--ink-secondary)">
              {/* The full name stays reachable on hover, and the table view
                  beside every chart carries it in text regardless. */}
              <title>{datum.label}</title>
              {fitLabel(datum.label, labelWidth - 12, 11)}
            </text>
            <rect x={barX} y={y + 4} width={barWidth} height={rowHeight - 10} rx={3} fill={fill} opacity={hover === null || hover === index ? 1 : 0.55} />
            <text
              x={value >= 0 ? barX + barWidth + 5 : barX - 5}
              y={y + rowHeight / 2 + 3.5}
              fontSize={10}
              textAnchor={value >= 0 ? 'start' : 'end'}
              fill="var(--ink-muted)"
              className="tnum"
            >
              {Number.isFinite(datum.value) ? formatValue(datum.value) : '—'}
            </text>
          </g>
        );
      })}
      {hover !== null && data[hover] ? (
        <Tooltip
          x={xOf((data[hover] as BarDatum).value)}
          y={margin.top + hover * rowHeight + rowHeight / 2}
          width={width}
          lines={[
            (data[hover] as BarDatum).label,
            `${valueLabel}: ${formatValue((data[hover] as BarDatum).value)}`,
            ...((data[hover] as BarDatum).detail ? [(data[hover] as BarDatum).detail as string] : []),
          ]}
        />
      ) : null}
    </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dose-response
// ---------------------------------------------------------------------------

/**
 * A Hill/Emax curve on a log-concentration axis — §12.4's dose-response plot.
 *
 * The tested range is shaded. Outside it the curve is drawn as a dashed line,
 * because §5.3 disables extrapolation: the shape out there is the model's, not
 * the evidence's, and drawing it solid would say otherwise.
 */
export function DoseResponseChart({
  emax,
  ec50Nm,
  hill,
  testedRangeNm,
  markedConcentrationNm,
  width: designWidth = 440,
  height = 240,
}: {
  emax: number;
  ec50Nm: number;
  hill: number;
  testedRangeNm: [number, number] | null;
  markedConcentrationNm: number | null;
  width?: number;
  height?: number;
}): React.ReactElement {
  const [hoverX, setHoverX] = useState<number | null>(null);
  // This one had no width cap at all, so in a wide panel it scaled *up* and
  // its 10px axis text grew with it.
  const [measureRef, available] = useAvailableWidth();
  const width = fitWidth(designWidth, available);
  const margin = DEFAULT_MARGIN;
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;

  const logLow = Math.log10(Math.max(1e-3, (testedRangeNm?.[0] ?? ec50Nm / 100) / 3));
  const logHigh = Math.log10(Math.max(1e-2, (testedRangeNm?.[1] ?? ec50Nm * 100) * 3));
  const xOf = (nm: number): number =>
    margin.left + ((Math.log10(Math.max(1e-6, nm)) - logLow) / (logHigh - logLow)) * plotWidth;
  const concentrationAt = (x: number): number => Math.pow(10, logLow + ((x - margin.left) / plotWidth) * (logHigh - logLow));
  const yOf = (effect: number): number => margin.top + (1 - effect) * plotHeight;
  const response = (nm: number): number => {
    const powered = Math.pow(nm, hill);
    return (emax * powered) / (Math.pow(ec50Nm, hill) + powered);
  };

  const samples = Array.from({ length: 160 }, (_, i) => {
    const nm = Math.pow(10, logLow + (i / 159) * (logHigh - logLow));
    return { nm, x: xOf(nm), y: yOf(response(nm)) };
  });

  const inside = (nm: number): boolean => !testedRangeNm || (nm >= testedRangeNm[0] && nm <= testedRangeNm[1]);
  const insidePath = samples.filter((s) => inside(s.nm));
  const path = (points: typeof samples): string =>
    points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

  const decades: number[] = [];
  for (let e = Math.ceil(logLow); e <= Math.floor(logHigh); e += 1) decades.push(Math.pow(10, e));

  return (
    <div ref={measureRef} className="w-full min-w-0">
    <svg
      width={width}
      height={height}
      style={SVG_FIT}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="Dose-response curve"
      onPointerMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        setHoverX(((event.clientX - rect.left) / rect.width) * width);
      }}
      onPointerLeave={() => setHoverX(null)}
    >
      <Axes
        width={width}
        height={height}
        margin={margin}
        xTicks={decades.map((d) => ({ position: xOf(d), label: d >= 1000 ? `${d / 1000}µM` : `${d}nM` }))}
        yTicks={[0, 0.25, 0.5, 0.75, 1].map((v) => ({ position: yOf(v), label: percent(v, 0) }))}
        xLabel="Concentration (log scale)"
        yLabel="Effect"
      />

      {testedRangeNm ? (
        <>
          <rect
            x={xOf(testedRangeNm[0])}
            y={margin.top}
            width={Math.max(2, xOf(testedRangeNm[1]) - xOf(testedRangeNm[0]))}
            height={plotHeight}
            fill="var(--series-1)"
            opacity={0.08}
          />
          <text x={xOf(testedRangeNm[0]) + 4} y={margin.top + 11} fontSize={9.5} fill="var(--ink-muted)">
            evidence range
          </text>
        </>
      ) : null}

      {/* Outside the tested range, dashed: the shape there is the model's. */}
      <path d={path(samples)} fill="none" stroke="var(--series-1)" strokeWidth={2} strokeDasharray="4 3" opacity={0.5} />
      {insidePath.length > 1 ? <path d={path(insidePath)} fill="none" stroke="var(--series-1)" strokeWidth={2} /> : null}

      <line x1={xOf(ec50Nm)} x2={xOf(ec50Nm)} y1={yOf(0)} y2={yOf(emax / 2)} stroke="var(--ink-muted)" strokeWidth={1} strokeDasharray="3 3" />
      <text x={xOf(ec50Nm) + 4} y={yOf(emax / 2) - 5} fontSize={10} fill="var(--ink-secondary)">
        EC50 {num(ec50Nm)} nM
      </text>

      {markedConcentrationNm !== null ? (
        <>
          <circle cx={xOf(markedConcentrationNm)} cy={yOf(response(markedConcentrationNm))} r={5} fill="var(--series-2)" stroke="var(--surface)" strokeWidth={2} />
          <text x={xOf(markedConcentrationNm) + 8} y={yOf(response(markedConcentrationNm)) - 7} fontSize={10} fill="var(--series-2)">
            this run
          </text>
        </>
      ) : null}

      {hoverX !== null && hoverX > margin.left && hoverX < width - margin.right ? (
        <>
          <line x1={hoverX} x2={hoverX} y1={margin.top} y2={height - margin.bottom} stroke="var(--ink-muted)" strokeWidth={1} />
          <Tooltip
            x={hoverX}
            y={yOf(response(concentrationAt(hoverX)))}
            width={width}
            lines={[
              `${num(concentrationAt(hoverX))} nM`,
              `effect ${percent(response(concentrationAt(hoverX)))}`,
              inside(concentrationAt(hoverX)) ? 'inside the evidence range' : 'outside the evidence range',
            ]}
          />
        </>
      ) : null}
    </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scatter
// ---------------------------------------------------------------------------

export function ScatterChart({
  points,
  xLabel,
  yLabel,
  width: designWidth = 420,
  height = 320,
  identity = true,
}: {
  points: { x: number; y: number; label: string }[];
  xLabel: string;
  yLabel: string;
  width?: number;
  height?: number;
  /** Draw the y = x line, for a prediction-versus-observation plot. */
  identity?: boolean;
}): React.ReactElement {
  const [hover, setHover] = useState<number | null>(null);
  const [measureRef, available] = useAvailableWidth();
  const width = fitWidth(designWidth, available);
  const margin = DEFAULT_MARGIN;
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;

  const extent = useMemo(() => {
    const xs = points.map((p) => p.x).filter(Number.isFinite);
    const ys = points.map((p) => p.y).filter(Number.isFinite);
    const all = [...xs, ...ys];
    if (all.length === 0) return { min: -1, max: 1 };
    const bound = Math.max(...all.map(Math.abs)) || 1;
    return { min: -bound * 1.05, max: bound * 1.05 };
  }, [points]);

  const xOf = (v: number): number => margin.left + ((v - extent.min) / (extent.max - extent.min)) * plotWidth;
  const yOf = (v: number): number => margin.top + plotHeight - ((v - extent.min) / (extent.max - extent.min)) * plotHeight;
  const ticks = [extent.min, extent.min / 2, 0, extent.max / 2, extent.max];

  return (
    <div ref={measureRef} className="w-full min-w-0">
    <svg width={width} height={height} style={SVG_FIT} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${yLabel} against ${xLabel}`}>
      <Axes
        width={width}
        height={height}
        margin={margin}
        xTicks={ticks.map((t) => ({ position: xOf(t), label: num(t, 2) }))}
        yTicks={ticks.map((t) => ({ position: yOf(t), label: num(t, 2) }))}
        xLabel={xLabel}
        yLabel={yLabel}
      />
      {identity ? (
        <line
          x1={xOf(extent.min)}
          y1={yOf(extent.min)}
          x2={xOf(extent.max)}
          y2={yOf(extent.max)}
          stroke="var(--ink-muted)"
          strokeWidth={1}
          strokeDasharray="4 4"
        />
      ) : null}
      {points.map((point, index) => (
        <circle
          key={point.label}
          cx={xOf(point.x)}
          cy={yOf(point.y)}
          r={hover === index ? 6 : 4.5}
          fill="var(--series-1)"
          stroke="var(--surface)"
          strokeWidth={1.5}
          opacity={hover === null || hover === index ? 0.9 : 0.4}
          onPointerEnter={() => setHover(index)}
          onPointerLeave={() => setHover(null)}
        />
      ))}
      {hover !== null && points[hover] ? (
        <Tooltip
          x={xOf((points[hover] as { x: number }).x)}
          y={yOf((points[hover] as { y: number }).y)}
          width={width}
          lines={[
            (points[hover] as { label: string }).label,
            `${xLabel}: ${num((points[hover] as { x: number }).x)}`,
            `${yLabel}: ${num((points[hover] as { y: number }).y)}`,
          ]}
        />
      ) : null}
    </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Matrix
// ---------------------------------------------------------------------------

/**
 * A square matrix heatmap — neighbourhood enrichment and the candidate
 * comparison both take this shape.
 *
 * Diverging when the values have a sign (a z-score), sequential when they do
 * not. Cells carry a 2px surface gap so adjacent values do not blend, and the
 * value is printed in every cell when the matrix is small enough to read.
 *
 * Never scaled up: eight candidates by five components is about 320 units
 * wide, and stretched across a 1300-pixel panel its 44px cells became 180px
 * with 45px labels. Never scaled down either (see `useAvailableWidth`): in a
 * narrow panel the cells shrink instead, and below the smallest cell the
 * matrix scrolls sideways.
 */
export function MatrixChart({
  labels,
  values,
  mode = 'diverging',
  cellSize = 44,
  valueFormat = (v: number) => num(v, 2),
  title,
  columnLabels,
}: {
  labels: string[];
  values: number[];
  mode?: 'diverging' | 'sequential';
  cellSize?: number;
  valueFormat?: (value: number) => string;
  title: string;
  columnLabels?: string[] | undefined;
}): React.ReactElement {
  const [hover, setHover] = useState<{ row: number; col: number } | null>(null);
  const [measureRef, available] = useAvailableWidth();
  const columns = columnLabels ?? labels;
  /*
   * The two label gutters are sized to their labels, as the ranked bar chart's
   * is, rather than fixed at a width the names had outgrown. Row names are
   * horizontal so their gutter is their length; column names are set at -40°, so
   * the header only needs the *vertical* component of that — sin(40°) — which
   * is why a long column name costs less height than it does width.
   */
  const longestRow = labels.reduce((most, label) => Math.max(most, label.length), 0);
  const longestColumn = columns.reduce((most, label) => Math.max(most, label.length), 0);
  /*
   * 6.8 units per character, not 5.6.
   *
   * The row labels here are drug names in capitals, and a capital is roughly a
   * fifth wider than the mixed-case average an average-width estimate assumes.
   * Under-measuring them put "CAPIVASERTIB" past the left edge of its own
   * gutter, where it was clipped by the viewBox rather than ellipsised — the
   * one failure mode worse than truncation, because it removes characters from
   * the *start* of a word with nothing to show that it did.
   */
  const perCharacter = 6.8;
  const labelWidth = Math.min(180, Math.max(70, longestRow * perCharacter + 16));

  /*
   * A label set at -40° spends its length in two directions at once, and the
   * header was only ever budgeted for one of them. The vertical component sets
   * how tall the header must be; the horizontal component runs off the right of
   * the last column and was being clipped by the viewBox — silently, because an
   * `svg` clips to its viewport, so "Residual perturbation signature" simply
   * stopped mid-word with no ellipsis to say it had.
   *
   * So the length is capped at something a header can carry, and the drawing is
   * then widened by exactly the horizontal reach that cap implies. The full text
   * is in `<title>` and in the table beside the chart either way.
   */
  const columnChars = Math.min(20, Math.max(8, longestColumn));
  const headerHeight = Math.max(46, columnChars * perCharacter * 0.64 + 18);
  const overhang = Math.ceil(columnChars * perCharacter * 0.77);
  /*
   * Cells shrink to fit a narrow panel, down to 22 units, before the matrix
   * scrolls sideways inside its card. The text stays at its size either way;
   * cell values are printed only while cells can hold them, and the tooltip
   * carries them always.
   */
  const fittedCell =
    available !== null && available > 0 ? Math.floor((available - labelWidth - 8 - overhang) / columns.length) : cellSize;
  const cell = Math.max(22, Math.min(cellSize, fittedCell));
  const width = labelWidth + columns.length * cell + 8 + overhang;
  const height = headerHeight + labels.length * cell + 8;

  const bound = useMemo(() => {
    const finite = values.filter(Number.isFinite);
    return finite.length > 0 ? Math.max(...finite.map(Math.abs)) || 1 : 1;
  }, [values]);
  const maximum = useMemo(() => {
    const finite = values.filter(Number.isFinite);
    return finite.length > 0 ? Math.max(...finite) || 1 : 1;
  }, [values]);

  const showValues = cell >= 36;

  return (
    <div ref={measureRef} className="w-full min-w-0 overflow-x-auto">
    <svg width={width} height={height} style={{ display: 'block' }} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title}>
      {columns.map((label, col) => (
        <text
          key={`c${label}`}
          x={labelWidth + col * cell + cell / 2}
          y={headerHeight - 8}
          fontSize={10.5}
          textAnchor="start"
          fill="var(--ink-secondary)"
          transform={`rotate(-40 ${labelWidth + col * cell + cell / 2} ${headerHeight - 8})`}
        >
          <title>{label}</title>
          {label.length > columnChars ? `${label.slice(0, columnChars - 1)}…` : label}
        </text>
      ))}
      {labels.map((rowLabel, row) => (
        <g key={`r${rowLabel}`}>
          <text x={labelWidth - 8} y={headerHeight + row * cell + cell / 2 + 4} fontSize={10.5} textAnchor="end" fill="var(--ink-secondary)">
            <title>{rowLabel}</title>
            {fitLabel(rowLabel, labelWidth - 12, 10.5)}
          </text>
          {columns.map((columnLabel, col) => {
            const value = values[row * columns.length + col] as number;
            const fill = !Number.isFinite(value)
              ? 'var(--surface-sunken)'
              : mode === 'diverging'
                ? diverging(value / bound)
                : sequential(Math.max(0, value) / maximum);
            const isHover = hover?.row === row && hover?.col === col;
            return (
              <g key={`${rowLabel}-${columnLabel}`} onPointerEnter={() => setHover({ row, col })} onPointerLeave={() => setHover(null)}>
                <rect
                  x={labelWidth + col * cell + 1}
                  y={headerHeight + row * cell + 1}
                  width={cell - 2}
                  height={cell - 2}
                  rx={2}
                  fill={fill}
                  stroke={isHover ? 'var(--ink)' : 'transparent'}
                  strokeWidth={1.5}
                />
                {showValues && Number.isFinite(value) ? (
                  <text
                    x={labelWidth + col * cell + cell / 2}
                    y={headerHeight + row * cell + cell / 2 + 3.5}
                    fontSize={9.5}
                    textAnchor="middle"
                    fill="var(--ink)"
                    className="tnum"
                    style={{ mixBlendMode: 'difference', filter: 'invert(1)' }}
                  >
                    {valueFormat(value)}
                  </text>
                ) : null}
              </g>
            );
          })}
        </g>
      ))}
      {hover ? (
        <Tooltip
          x={labelWidth + hover.col * cell + cell}
          y={headerHeight + hover.row * cell + cell / 2}
          width={width}
          lines={[
            `${labels[hover.row]} × ${columns[hover.col]}`,
            valueFormat(values[hover.row * columns.length + hover.col] as number),
          ]}
        />
      ) : null}
    </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------

export function ColourLegend({
  kind,
  domain,
  ticks,
  unit,
  categories,
  note,
}: {
  kind: 'sequential' | 'diverging' | 'categorical';
  domain: [number, number];
  ticks: number[];
  unit: string;
  categories?: string[] | null | undefined;
  note?: string | null | undefined;
}): React.ReactElement {
  const gradientId = useId();
  /*
   * Drawn at its measured width. It used to stretch a 220-unit viewBox with
   * preserveAspectRatio="none", which widened the tick numbers along with the
   * bar: three times wider once the layer panel sat under the map at full
   * width.
   */
  const [measureRef, available] = useAvailableWidth();
  const barWidth = fitWidth(420, available ?? 220);

  if (kind === 'categorical' && categories) {
    return (
      <div className="space-y-1.5">
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {categories.map((name, index) => (
            <span key={name} className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--ink-secondary)' }}>
              <span className="h-2.5 w-2.5 shrink-0 rounded-[2px]" style={{ background: categorical(index) }} />
              {name}
            </span>
          ))}
        </div>
        {note ? (
          <p className="text-[10.5px]" style={{ color: 'var(--ink-muted)' }}>
            {note}
          </p>
        ) : null}
      </div>
    );
  }

  const stops = Array.from({ length: 11 }, (_, i) => i / 10);
  return (
    <div className="space-y-1.5">
      <div ref={measureRef} className="w-full min-w-0">
      <svg width={barWidth} height={30} style={{ display: 'block', maxWidth: '100%' }} viewBox={`0 0 ${barWidth} 30`} role="img" aria-label={`Colour scale in ${unit}`}>
        <defs>
          <linearGradient id={gradientId} x1="0" x2="1">
            {stops.map((stop) => (
              <stop
                key={stop}
                offset={`${stop * 100}%`}
                stopColor={kind === 'diverging' ? diverging(stop * 2 - 1) : sequential(stop)}
              />
            ))}
          </linearGradient>
        </defs>
        <rect x={0} y={0} width={barWidth} height={9} rx={2} fill={`url(#${gradientId})`} />
        {ticks.map((tick, index) => {
          const position = ((tick - domain[0]) / (domain[1] - domain[0] || 1)) * barWidth;
          return (
            <text
              key={`${tick}-${index}`}
              x={Math.min(barWidth - 4, Math.max(4, position))}
              y={22}
              fontSize={9.5}
              textAnchor={index === 0 ? 'start' : index === ticks.length - 1 ? 'end' : 'middle'}
              fill="var(--ink-muted)"
              className="tnum"
            >
              {num(tick, 2)}
            </text>
          );
        })}
      </svg>
      </div>
      <p className="text-[10.5px]" style={{ color: 'var(--ink-muted)' }}>
        {unit}
        {note ? ` — ${note}` : ''}
      </p>
    </div>
  );
}
