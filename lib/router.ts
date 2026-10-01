import { useCallback, useEffect, useState } from 'react';
import { PAGE_TITLES, type Page } from '../types';

/**
 * Fragment-based routing.
 *
 * The active section used to live in a `useState` inside the workspace, so the
 * address bar never changed. Three consequences, all of which a user meets in
 * the first few minutes: reloading dropped them back at the project screen,
 * losing whichever panel they had open; the Back button left the lab entirely
 * instead of going back one section; and an instructor could not link a class
 * to a specific screen.
 *
 * A fragment rather than a path keeps the deployment simple: `/#/baseline` is
 * the same document to any proxy however deep the route goes, so no rewrite
 * rules are needed and a direct link cannot 404.
 */

const PAGES = new Set<string>(Object.keys(PAGE_TITLES));

function fromHash(hash: string): Page | null {
  const slug = hash.replace(/^#\/?/, '').split('?')[0]?.trim() ?? '';
  return PAGES.has(slug) ? (slug as Page) : null;
}

export function routedPage(): Page | null {
  return typeof window === 'undefined' ? null : fromHash(window.location.hash);
}

/**
 * The open project travels in the fragment too.
 *
 * It used to live only in React state, and the consequence was the same one the
 * page routing was changed to fix, one level down: a reload kept the screen and
 * silently dropped the project, so a finished analysis rendered as "Run an
 * analysis to populate this screen". The work was still on the server; the page
 * had simply forgotten which project it belonged to, and nothing said so.
 *
 * It also makes a screen linkable in the way an instructor actually needs — a
 * particular result of a particular project, not just the section it lives in.
 */
export function routedProjectId(): string | null {
  if (typeof window === 'undefined') return null;
  const query = window.location.hash.split('?')[1];
  if (!query) return null;
  const value = new URLSearchParams(query).get('p')?.trim();
  // Only the shape the server issues. A fragment is user-editable, so this is
  // a sanity check on our own routing, not a security boundary — the server
  // authorises every read of a project by its session.
  return value && /^prj_[a-z0-9]{1,40}$/i.test(value) ? value : null;
}

export function hashFor(page: Page, projectId?: string | null): string {
  return projectId ? `#/${page}?p=${encodeURIComponent(projectId)}` : `#/${page}`;
}

export function useHashRoute(initial: Page): [Page, (page: Page) => void, string | null, (id: string | null) => void] {
  const [page, setPage] = useState<Page>(() => routedPage() ?? initial);
  const [projectId, setProjectId] = useState<string | null>(() => routedProjectId());

  useEffect(() => {
    const onHashChange = (): void => {
      setPage(routedPage() ?? initial);
      setProjectId(routedProjectId());
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [initial]);

  // The first visit has no fragment. Writing one immediately — replacing rather
  // than pushing — means the very first Back press leaves the lab, instead of
  // appearing to do nothing because it consumed a synthetic entry.
  useEffect(() => {
    if (routedPage() === null) window.history.replaceState(null, '', hashFor(page, routedProjectId()));
    // Mount only; later navigation goes through `navigate`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const navigate = useCallback((next: Page) => {
    const current = routedProjectId();
    if (routedPage() === next) return;
    window.history.pushState(null, '', hashFor(next, current));
    setPage(next);
    window.scrollTo({ top: 0 });
  }, []);

  /**
   * Opening or closing a project *replaces* the history entry rather than
   * pushing one. Choosing a project is not a place you navigated to, so Back
   * should leave the screen you were on, not peel off a project selection you
   * no longer remember making.
   */
  const selectProject = useCallback((id: string | null) => {
    const here = routedPage() ?? initial;
    window.history.replaceState(null, '', hashFor(here, id));
    setProjectId(id);
  }, [initial]);

  return [page, navigate, projectId, selectProject];
}
