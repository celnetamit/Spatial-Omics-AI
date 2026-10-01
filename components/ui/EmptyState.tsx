/**
 * What a workflow screen shows before its stage has run.
 *
 * Every one of these screens used to render a single grey sentence — "Simulate
 * rescue candidates to populate this screen." — on an otherwise blank page.
 * Three things were wrong with that at a production standard, and they compound:
 * the screen reads as broken rather than as waiting; it names the missing step
 * without saying which of the twelve it is or where to find it; and it offers no
 * way to go and do it, so the user has to work out the sidebar mapping
 * themselves. On a 1600-pixel canvas the effect is a page that looks like a
 * loading failure.
 *
 * So an empty state here states three things and offers one: what this screen
 * will show, why it is empty *now*, and the step that fills it — with a control
 * that goes straight there. It is deliberately not a spinner: nothing is
 * loading, and pretending otherwise would be a lie the user waits on.
 */

import type { Page } from '../../types';
import { PAGE_TITLES } from '../../types';

export function EmptyState({
  title,
  explanation,
  requires,
  onGo,
  action,
}: {
  /** What this screen is for, in the affirmative. */
  title: string;
  /** Why it has nothing to show, in plain words. */
  explanation: string;
  /** The workflow step that produces what is missing. */
  requires?: { page: Page; label?: string } | undefined;
  onGo?: ((page: Page) => void) | undefined;
  /** An action that can be taken from here instead of navigating away. */
  action?: React.ReactNode;
}): React.ReactElement {
  const target = requires ? (requires.label ?? PAGE_TITLES[requires.page]) : null;

  return (
    <div
      className="flex min-h-[18rem] items-center justify-center rounded-lg border px-6 py-12"
      style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
    >
      <div className="max-w-md text-center">
        {/*
         * A quiet mark, not an illustration. It signals "nothing here yet"
         * without implying an error state, which a warning glyph would.
         */}
        <div
          aria-hidden="true"
          className="mx-auto mb-4 flex h-9 w-9 items-center justify-center rounded-full border"
          style={{ borderColor: 'var(--border-strong)', color: 'var(--ink-muted)' }}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.25" strokeDasharray="2.5 2.5" />
          </svg>
        </div>

        <h2 className="text-[13.5px] font-semibold" style={{ color: 'var(--ink)' }}>
          {title}
        </h2>
        <p className="mt-1.5 text-[12px] leading-relaxed" style={{ color: 'var(--ink-secondary)' }}>
          {explanation}
        </p>

        {(requires && onGo) || action ? (
          <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
            {action}
            {requires && onGo ? (
              <button
                type="button"
                onClick={() => onGo(requires.page)}
                className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors"
                style={{ background: 'var(--action)', color: '#fff' }}
              >
                Go to {target}
                <span aria-hidden="true"> →</span>
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The state where a project simply has not been opened.
 *
 * Distinct from "this stage has not run": the work may well exist, and telling
 * someone to run an analysis they have already run is worse than saying
 * nothing. This is the screen a bookmarked link with no project lands on.
 */
export function NoProjectState({ onGo }: { onGo: (page: Page) => void }): React.ReactElement {
  return (
    <EmptyState
      title="No project is open"
      explanation="Every screen in the workflow belongs to a project. Open one — or create one — and this screen will show its results."
      requires={{ page: 'project', label: 'Project' }}
      onGo={onGo}
    />
  );
}

/**
 * The shape of a screen before its code has arrived.
 *
 * Every workflow screen is a lazily-imported chunk, and the fallback was the
 * word "Loading…" centred on an otherwise blank page — so navigating produced a
 * flash of nothing, then a full page at once. A skeleton holds the page's
 * actual geometry during that gap: the eye stays where it was, and the arriving
 * content lands in the space already reserved for it instead of pushing the
 * viewport around.
 *
 * `aria-hidden` with a polite status line beside it: the bars are decoration
 * and announcing twelve of them would be noise, but "Loading" still needs to
 * reach a screen reader once.
 */
export function PageSkeleton(): React.ReactElement {
  return (
    <div>
      <span className="sr-only" role="status">
        Loading
      </span>
      <div aria-hidden="true" className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((slot) => (
            <div
              key={slot}
              className="rounded-md border px-3.5 py-3"
              style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
            >
              <div className="skeleton h-2.5 w-20 rounded" />
              <div className="skeleton mt-3 h-6 w-24 rounded" />
            </div>
          ))}
        </div>
        <div
          className="overflow-hidden rounded-lg border"
          style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
        >
          <div className="border-b px-5 py-3.5" style={{ borderColor: 'var(--border)' }}>
            <div className="skeleton h-3 w-44 rounded" />
            <div className="skeleton mt-2 h-2.5 w-72 rounded" />
          </div>
          <div className="space-y-2.5 px-5 py-4">
            {[0, 1, 2, 3, 4].map((slot) => (
              <div key={slot} className="skeleton h-3 rounded" style={{ width: `${92 - slot * 9}%` }} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
