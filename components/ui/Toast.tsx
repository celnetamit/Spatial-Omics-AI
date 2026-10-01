/**
 * Transient notices.
 *
 * Icons are inline SVG rather than a dependency: four glyphs do not justify an
 * icon package, and a toast that fails to render because a chunk did not load
 * is a worse failure than a plain one.
 *
 * A status colour never carries the meaning alone — every toast has an icon and
 * a word, which is what makes it survive forced colours and a colour-vision
 * deficiency.
 */

import { useEffect } from 'react';

export type ToastTone = 'info' | 'success' | 'warning' | 'error';

export interface ToastMessage {
  id: string;
  tone: ToastTone;
  title: string;
  detail?: string;
  /** Milliseconds before it dismisses itself; 0 means it stays. */
  duration?: number;
}

const TONE_COLOUR: Record<ToastTone, string> = {
  info: 'var(--series-1)',
  success: 'var(--status-good)',
  warning: 'var(--status-warning)',
  error: 'var(--status-critical)',
};

const TONE_LABEL: Record<ToastTone, string> = {
  info: 'Note',
  success: 'Done',
  warning: 'Warning',
  error: 'Error',
};

function Glyph({ tone }: { tone: ToastTone }): React.ReactElement {
  const common = { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  if (tone === 'success') {
    return (
      <svg {...common} aria-hidden="true">
        <path d="M3 8.5 6.2 11.7 13 4.9" />
      </svg>
    );
  }
  if (tone === 'error') {
    return (
      <svg {...common} aria-hidden="true">
        <path d="M4 4l8 8M12 4l-8 8" />
      </svg>
    );
  }
  if (tone === 'warning') {
    return (
      <svg {...common} aria-hidden="true">
        <path d="M8 2.6 14.4 13.4H1.6z" />
        <path d="M8 6.6v3.2M8 11.6v.1" />
      </svg>
    );
  }
  return (
    <svg {...common} aria-hidden="true">
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 5.2v.1M8 7.4v3.6" />
    </svg>
  );
}

export function Toast({ message, onDismiss }: { message: ToastMessage; onDismiss: (id: string) => void }): React.ReactElement {
  useEffect(() => {
    const duration = message.duration ?? 6000;
    if (duration <= 0) return;
    const timer = setTimeout(() => onDismiss(message.id), duration);
    return () => clearTimeout(timer);
  }, [message, onDismiss]);

  return (
    <div
      role="status"
      className="flex w-80 items-start gap-2 rounded-lg border px-3 py-2.5 shadow-lg"
      style={{ borderColor: 'var(--border-strong)', background: 'var(--surface-raised)' }}
    >
      <span className="mt-[2px] shrink-0" style={{ color: TONE_COLOUR[message.tone] }}>
        <Glyph tone={message.tone} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[12px] font-medium" style={{ color: 'var(--ink)' }}>
          <span className="sr-only">{TONE_LABEL[message.tone]}: </span>
          {message.title}
        </p>
        {message.detail ? (
          <p className="mt-0.5 text-[11px] leading-snug" style={{ color: 'var(--ink-secondary)' }}>
            {message.detail}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => onDismiss(message.id)}
        aria-label="Dismiss"
        className="shrink-0 text-[14px] leading-none"
        style={{ color: 'var(--ink-muted)' }}
      >
        ×
      </button>
    </div>
  );
}
