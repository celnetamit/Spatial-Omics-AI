/**
 * The tissue canvas with its layer picker, legend and inspector.
 *
 * Used wherever a spatial map appears, so the legend, the scale bar, the result
 * badge and the "what does this colour mean" note travel with the picture
 * rather than being re-implemented per screen — which is how two screens end up
 * describing the same layer differently.
 */

import { useMemo, useState } from 'react';
import TissueCanvas, { IDENTITY_VIEW, type ViewState } from '../viz/TissueCanvas';
import { ColourLegend } from '../viz/Charts';
import { buildScale } from '../../lib/colour';
import { num } from '../../lib/format';
import { ResultBadge, Caveat } from '../ui/Badges';
import type { Layer } from '../../lib/api';

export interface LayerChoice {
  id: string;
  label: string;
  kind: string;
  key: string;
  stage?: number;
  group: string;
}

export default function TissueView({
  points,
  coordinateUnit,
  layer,
  loading,
  error,
  choices,
  selectedId,
  onSelectLayer,
  ringIndices,
  opacity,
  edges,
  inspector,
  height = 460,
  view,
  onViewChange,
  title,
}: {
  points: { x: number; y: number }[];
  coordinateUnit: string;
  layer: Layer | null;
  loading: boolean;
  error: string | null;
  choices: LayerChoice[];
  selectedId: string;
  onSelectLayer: (choice: LayerChoice) => void;
  ringIndices?: Set<number>;
  opacity?: number[] | null;
  edges?: { source: number; target: number; type: string }[] | null;
  inspector?: (index: number) => React.ReactNode;
  height?: number;
  view?: ViewState;
  onViewChange?: (view: ViewState) => void;
  title?: string;
}): React.ReactElement {
  const [hovered, setHovered] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);

  const scale = useMemo(
    () => buildScale(layer?.values ?? [], layer?.scale ?? 'sequential', layer?.categories ?? null),
    [layer],
  );

  const grouped = useMemo(() => {
    const groups = new Map<string, LayerChoice[]>();
    for (const choice of choices) {
      const list = groups.get(choice.group) ?? [];
      list.push(choice);
      groups.set(choice.group, list);
    }
    return [...groups.entries()];
  }, [choices]);

  const focus = selected ?? hovered;

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_260px]">
      <div className="min-w-0">
        {title ? (
          <div className="mb-2 flex items-center gap-2">
            <h3 className="text-[12.5px] font-medium" style={{ color: 'var(--ink)' }}>
              {title}
            </h3>
            {layer ? <ResultBadge label={layer.label} method={layer.method} /> : null}
          </div>
        ) : null}
        <div
          className="relative overflow-hidden rounded border"
          style={{ borderColor: 'var(--border)', background: 'var(--surface-sunken)', height }}
        >
          {layer && points.length > 0 ? (
            <TissueCanvas
              points={points}
              values={layer.values}
              scale={scale}
              coordinateUnit={coordinateUnit}
              overlay={{
                ...(ringIndices ? { ringIndices } : {}),
                ...(selected !== null ? { highlightIndices: new Set([selected]) } : {}),
                opacity: opacity ?? null,
                edges: edges ?? null,
              }}
              onHover={setHovered}
              onSelect={(index) => setSelected((current) => (current === index ? null : index))}
              ariaLabel={`Tissue map coloured by ${layer.name}`}
              {...(view ? { view } : {})}
              {...(onViewChange ? { onViewChange } : {})}
            />
          ) : (
            <div className="flex h-full items-center justify-center px-6 text-center">
              <p className="text-[12px]" style={{ color: 'var(--ink-muted)' }}>
                {loading ? 'Loading the layer…' : (error ?? 'No layer selected.')}
              </p>
            </div>
          )}
        </div>
      </div>

      <aside className="space-y-3">
        <div>
          <label className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
            Layer
          </label>
          <select
            value={selectedId}
            onChange={(event) => {
              const choice = choices.find((candidate) => candidate.id === event.target.value);
              if (choice) onSelectLayer(choice);
            }}
            className="mt-1 w-full rounded border px-2 py-1.5 text-[12px]"
            style={{ color: 'var(--ink)' }}
          >
            {grouped.map(([group, entries]) => (
              <optgroup key={group} label={group}>
                {entries.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>

        {layer ? (
          <>
            <ColourLegend
              kind={scale.kind}
              domain={scale.domain}
              ticks={scale.ticks}
              unit={layer.unit}
              categories={layer.categories}
              note={scale.trimmedNote}
            />
            {layer.note ? <Caveat>{layer.note}</Caveat> : null}
            {layer.missing.length > 0 ? (
              <p className="text-[10.5px]" style={{ color: 'var(--ink-muted)' }}>
                {layer.missing.length} cell(s) have no value for this layer and are drawn in grey.
              </p>
            ) : null}
          </>
        ) : null}

        <div className="rounded border px-2.5 py-2" style={{ borderColor: 'var(--border)', background: 'var(--surface-sunken)' }}>
          <p className="text-[10.5px] uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
            {selected !== null ? 'Selected cell' : 'Hovered cell'}
          </p>
          {focus !== null && layer ? (
            <div className="mt-1 space-y-0.5 text-[11.5px]" style={{ color: 'var(--ink-secondary)' }}>
              <p className="tnum">#{focus}</p>
              <p className="tnum">
                {layer.categories
                  ? (layer.categories[Math.round(layer.values[focus] as number)] ?? '—')
                  : num(layer.values[focus] as number)}{' '}
                <span style={{ color: 'var(--ink-muted)' }}>{layer.categories ? '' : layer.unit}</span>
              </p>
              {inspector?.(focus)}
              {selected !== null ? (
                <button type="button" className="mt-1 underline" onClick={() => setSelected(null)} style={{ color: 'var(--ink-muted)' }}>
                  Clear selection
                </button>
              ) : null}
            </div>
          ) : (
            <p className="mt-1 text-[11px]" style={{ color: 'var(--ink-muted)' }}>
              Hover a cell to inspect it; click to keep it selected. Scroll to zoom, drag to pan.
            </p>
          )}
        </div>
      </aside>
    </div>
  );
}

export { IDENTITY_VIEW };
export type { ViewState };
