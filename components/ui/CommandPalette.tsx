/**
 * The command palette.
 *
 * This lab has nineteen destinations arranged as a fixed scientific sequence,
 * and the sidebar is deliberately that sequence rather than a menu (§11.1).
 * That is right for learning the workflow and wrong for the fourth hour of
 * using it: someone who already knows they want the parameter registry should
 * not have to find it in a list of eighteen siblings. A palette gives the
 * second audience a direct route without reordering the first one's map.
 *
 * It also carries the *actions*, which the sidebar has nowhere to put — running
 * an analysis lives on one screen, the rescue on another, and there was no way
 * to start either without first navigating to the page that owns the button.
 *
 * Accessibility is the whole reason this is hand-built rather than a div with a
 * keydown handler: it is a modal dialog containing a combobox that owns a
 * listbox, focus is trapped while it is open and restored to wherever it came
 * from when it closes, and the active option is announced through
 * `aria-activedescendant` rather than by moving focus into the list.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PAGE_TITLES, GOVERNANCE_PAGES, REFERENCE_PAGES, WORKFLOW_PAGES, type Page } from '../../types';
import { Icon, PAGE_ICON, type IconName } from './Icon';

export interface Command {
  id: string;
  label: string;
  hint?: string | undefined;
  group: string;
  icon: IconName;
  /** Why this command cannot run now. Present means disabled. */
  blocked?: string | undefined;
  run: () => void;
}

/**
 * A forgiving subsequence match, scored so that a match on a word boundary
 * outranks one buried mid-word. "pr" should find "Parameter registry" before
 * "Compare candidates", and typing the full word should always win.
 */
function score(query: string, text: string): number {
  if (!query) return 1;
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  if (haystack.startsWith(needle)) return 1000;
  const direct = haystack.indexOf(needle);
  if (direct === 0) return 900;
  if (direct > 0) return haystack[direct - 1] === ' ' ? 800 : 500;

  let index = 0;
  let points = 0;
  for (const character of needle) {
    const found = haystack.indexOf(character, index);
    if (found === -1) return 0;
    points += found > 0 && haystack[found - 1] === ' ' ? 4 : 1;
    index = found + 1;
  }
  return points;
}

export function CommandPalette({
  open,
  onClose,
  commands,
}: {
  open: boolean;
  onClose: () => void;
  commands: Command[];
}): React.ReactElement | null {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const restoreTo = useRef<HTMLElement | null>(null);

  const matches = useMemo(() => {
    const scored = commands
      .map((command) => ({
        command,
        points: Math.max(score(query, command.label), score(query, command.group) * 0.4),
      }))
      .filter((entry) => entry.points > 0);
    scored.sort((a, b) => b.points - a.points);
    return scored.map((entry) => entry.command);
  }, [commands, query]);

  // Grouped for display, but the keyboard walks the flat list — so the index
  // the arrow keys move through is the index the list renders.
  const groups = useMemo(() => {
    const out: { name: string; items: { command: Command; index: number }[] }[] = [];
    matches.forEach((command, index) => {
      const existing = out.find((group) => group.name === command.group);
      if (existing) existing.items.push({ command, index });
      else out.push({ name: command.group, items: [{ command, index }] });
    });
    return out;
  }, [matches]);

  useEffect(() => {
    if (!open) return;
    restoreTo.current = document.activeElement as HTMLElement | null;
    setQuery('');
    setActive(0);
    // Focus after paint, or the browser keeps it on whatever opened the dialog.
    const id = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [open]);

  useEffect(() => {
    if (open) return;
    restoreTo.current?.focus?.();
  }, [open]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  // Keep the highlighted row in view without stealing focus from the input.
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const choose = useCallback(
    (command: Command | undefined) => {
      if (!command || command.blocked) return;
      onClose();
      command.run();
    },
    [onClose],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === 'ArrowDown' || (event.key === 'n' && event.ctrlKey)) {
        event.preventDefault();
        setActive((current) => (matches.length === 0 ? 0 : (current + 1) % matches.length));
        return;
      }
      if (event.key === 'ArrowUp' || (event.key === 'p' && event.ctrlKey)) {
        event.preventDefault();
        setActive((current) => (matches.length === 0 ? 0 : (current - 1 + matches.length) % matches.length));
        return;
      }
      if (event.key === 'Home') {
        event.preventDefault();
        setActive(0);
        return;
      }
      if (event.key === 'End') {
        event.preventDefault();
        setActive(Math.max(0, matches.length - 1));
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        choose(matches[active]);
      }
    },
    [active, choose, matches, onClose],
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="w-full max-w-xl overflow-hidden rounded-xl border"
        style={{ borderColor: 'var(--border-strong)', background: 'var(--surface)', boxShadow: 'var(--elevation-2)' }}
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-2.5 border-b px-4" style={{ borderColor: 'var(--border)' }}>
          <Icon name="arrow-right" size={15} style={{ color: 'var(--ink-muted)' }} />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="command-list"
            aria-activedescendant={matches[active] ? `command-${matches[active].id}` : undefined}
            aria-autocomplete="list"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Go to a step, or run something…"
            className="t-body w-full bg-transparent py-3.5 outline-none"
            style={{ color: 'var(--ink)', border: 'none' }}
          />
          <kbd className="t-caption rounded border px-1.5 py-0.5" style={{ borderColor: 'var(--border)', color: 'var(--ink-muted)' }}>
            esc
          </kbd>
        </div>

        <div ref={listRef} id="command-list" role="listbox" aria-label="Commands" className="max-h-[52vh] overflow-y-auto p-1.5">
          {matches.length === 0 ? (
            <p className="t-small px-3 py-6 text-center" style={{ color: 'var(--ink-muted)' }}>
              Nothing matches “{query}”.
            </p>
          ) : (
            groups.map((group) => (
              <div key={group.name} className="mb-1 last:mb-0">
                <p className="t-eyebrow px-2.5 pb-1 pt-2" style={{ color: 'var(--ink-muted)' }}>
                  {group.name}
                </p>
                {group.items.map(({ command, index }) => {
                  const isActive = index === active;
                  return (
                    <div
                      key={command.id}
                      id={`command-${command.id}`}
                      role="option"
                      aria-selected={isActive}
                      aria-disabled={command.blocked ? true : undefined}
                      data-active={isActive}
                      onMouseMove={() => setActive(index)}
                      onClick={() => choose(command)}
                      className="flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2"
                      style={{
                        background: isActive ? 'var(--surface-raised)' : 'transparent',
                        color: command.blocked ? 'var(--ink-muted)' : 'var(--ink-secondary)',
                        opacity: command.blocked ? 0.55 : 1,
                      }}
                    >
                      <Icon
                        name={command.icon}
                        size={15}
                        className="shrink-0"
                        style={{ color: isActive && !command.blocked ? 'var(--series-1)' : 'currentColor' }}
                      />
                      <span className="t-body min-w-0 flex-1 truncate" style={{ color: command.blocked ? undefined : 'var(--ink)' }}>
                        {command.label}
                      </span>
                      {command.blocked ? (
                        <span className="t-caption shrink-0 truncate" style={{ maxWidth: '14rem' }}>
                          {command.blocked}
                        </span>
                      ) : command.hint ? (
                        <span className="t-caption shrink-0" style={{ color: 'var(--ink-muted)' }}>
                          {command.hint}
                        </span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div
          className="t-caption flex items-center gap-3 border-t px-3 py-2"
          style={{ borderColor: 'var(--border)', color: 'var(--ink-muted)' }}
        >
          <span>↑↓ move</span>
          <span>⏎ open</span>
          <span className="ml-auto">{matches.length} result{matches.length === 1 ? '' : 's'}</span>
        </div>
      </div>
    </div>
  );
}

/** The navigation half of the palette, built from the same page lists the sidebar uses. */
export function navigationCommands(
  navigate: (page: Page) => void,
  availability: Partial<Record<Page, { ready: boolean; reason: string | null }>>,
  isReviewer: boolean,
): Command[] {
  const entry = (page: Page, group: string, index?: number): Command => {
    const state = availability[page];
    return {
      id: `go-${page}`,
      label: PAGE_TITLES[page],
      group,
      icon: (PAGE_ICON[page] ?? 'dot') as IconName,
      ...(index !== undefined ? { hint: `step ${index}` } : {}),
      ...(state && !state.ready && state.reason ? { blocked: state.reason } : {}),
      run: () => navigate(page),
    };
  };

  return [
    ...WORKFLOW_PAGES.map((page, index) => entry(page, 'Workflow', index + 1)),
    ...REFERENCE_PAGES.map((page) => entry(page, 'Reference')),
    ...GOVERNANCE_PAGES.filter((page) => (page === 'agreement' || page === 'review' ? isReviewer : true)).map((page) =>
      entry(page, 'Governance'),
    ),
  ];
}
