/**
 * The application shell.
 *
 * §11.1 fixes the primary navigation to the scientific workflow rather than to
 * generic software menus, so the sidebar is the workflow in order and a stage
 * that cannot run yet says why rather than disappearing. Moving backwards to
 * inspect an earlier result is always allowed; changing a scientific parameter
 * creates a new run rather than overwriting one, which the server enforces.
 *
 * The reviewer gate is the same arrangement the rest of this estate uses: with
 * the expert-reviewer flag set, the undertaking is rendered *instead of* the
 * application until it is signed — not beside it — because the build the
 * agreement is about is exactly what would otherwise be glimpsed.
 */

import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { api, ApiError, type LabMeta, type ProjectSummary, type SessionUser } from './lib/api';
import { appConfig } from './lib/config';
import { logger } from './lib/logger';
import { useHashRoute } from './lib/router';
import { establishSession, forgetSession } from './lib/session';
import { forgetColourCache } from './lib/colour';
import { GOVERNANCE_PAGES, PAGE_TITLES, REFERENCE_PAGES, WORKFLOW_PAGES, type Page } from './types';
import { CommandPalette, navigationCommands, type Command } from './components/ui/CommandPalette';
import { Icon, PAGE_ICON } from './components/ui/Icon';
import { ToastProvider } from './components/ui/ToastContext';
import Workspace from './components/lab/Workspace';
import SignIn from './components/lab/SignIn';

const ReviewerAgreement = lazy(() => import('./components/governance/ReviewerAgreement'));
const Feedback = lazy(() => import('./components/governance/Feedback'));
const ExpertReview = lazy(() => import('./components/governance/ExpertReview'));
const ImplementationRegister = lazy(() => import('./components/governance/ImplementationRegister'));

type Gate = 'loading' | 'signed-out' | 'agreement-required' | 'open';

export default function App(): React.ReactElement {
  const [page, navigate, routedProject, selectProject] = useHashRoute('project');
  const [user, setUser] = useState<SessionUser | null>(null);
  const [meta, setMeta] = useState<LabMeta | null>(null);
  const [gate, setGate] = useState<Gate>('loading');
  const [problem, setProblem] = useState<ApiError | null>(null);
  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [restoring, setRestoring] = useState(false);
  /*
   * The sidebar is a permanent column on a wide screen and a drawer below
   * `lg`. Until this existed the 224px column was unconditional: at 390px it
   * left 166px of content, which rendered the project form one or two words per
   * line. The workflow *is* the navigation here (§11.1), so it cannot simply be
   * dropped on small screens — it has to be reachable instead.
   */
  const [navOpen, setNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  /*
   * The palette's actions come from the workspace, because that is where the
   * project and the run submitter live. Passing them up rather than lifting the
   * run machinery into the shell keeps the shell ignorant of the science, which
   * is the split the rest of this file is built on.
   */
  const [runCommands, setRunCommands] = useState<Command[]>([]);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    if (typeof window === 'undefined') return 'dark';
    return (window.localStorage.getItem('spatial-theme') as 'dark' | 'light' | null) ?? 'light';
  });

  /**
   * The route is the source of truth for which project is open.
   *
   * `onProjectChange` writes the id into the fragment; this effect reads it
   * back and fetches the project. That single direction is what makes a reload,
   * a pasted link and a Back press all land in the same state — three paths
   * that previously diverged, because only the in-memory one carried a project.
   */
  useEffect(() => {
    if (gate !== 'open') return;
    if (!routedProject) {
      setProject(null);
      return;
    }
    if (project?.projectId === routedProject) return;

    let cancelled = false;
    setRestoring(true);
    void (async () => {
      try {
        const { project: fetched } = await api.project(routedProject);
        if (!cancelled) setProject(fetched);
      } catch (error) {
        // A project that cannot be opened — deleted, or another account's —
        // must not leave a stale id in the address bar pointing at nothing.
        logger.warn('Could not open the routed project', { projectId: routedProject, error: String(error) });
        if (!cancelled) {
          selectProject(null);
          setProject(null);
        }
      } finally {
        if (!cancelled) setRestoring(false);
      }
    })();
    return () => { cancelled = true; };
  }, [gate, routedProject, project?.projectId, selectProject]);

  const onProjectChange = useCallback((next: ProjectSummary | null) => {
    setProject(next);
    selectProject(next?.projectId ?? null);
  }, [selectProject]);

  useEffect(() => {
    setNavOpen(false);
  }, [page]);

  /*
   * ⌘K / Ctrl-K anywhere, and `/` when the caret is not already in a field.
   *
   * The guard matters more than the binding: without it, typing a slash into
   * the study-question box would open the palette instead of a character, which
   * is the classic way a shortcut makes an application feel hostile. `Escape`
   * is handled inside the dialog so it does not also close the drawer.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target?.isContentEditable === true;

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((current) => !current);
        return;
      }
      if (event.key === '/' && !typing && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!navOpen) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setNavOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navOpen]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    forgetColourCache();
    try {
      window.localStorage.setItem('spatial-theme', theme);
    } catch {
      // A blocked storage API is not worth failing a render over.
    }
  }, [theme]);

  const open = useCallback(async () => {
    setGate('loading');
    const established = await establishSession();
    if (!established.user) {
      setProblem(established.problem);
      setGate('signed-out');
      return;
    }
    setUser(established.user);
    setProblem(null);

    try {
      setMeta(await api.meta());
    } catch (error) {
      logger.warn('Could not read lab metadata', { error: String(error) });
    }

    /*
     * The reviewer gate.
     *
     * Fails closed. If the portal cannot be reached the lab does not open —
     * being unable to confirm a signature is not the same as knowing there is
     * one — and the screen says whether the portal was unreachable or has no
     * agreement endpoint, so a locked reviewer can tell a network blip from a
     * deployment gap.
     */
    if (established.user.isReviewer) {
      try {
        const status = await api.agreementStatus();
        setGate(status.signed ? 'open' : 'agreement-required');
        return;
      } catch (error) {
        logger.warn('Could not confirm the reviewer agreement', { error: String(error) });
        setGate('agreement-required');
        return;
      }
    }
    setGate('open');
  }, []);

  useEffect(() => {
    void open();
  }, [open]);

  if (gate === 'loading') {
    return (
      <div className="flex h-full items-center justify-center" style={{ color: 'var(--ink-muted)' }}>
        <p className="text-sm">Opening the lab…</p>
      </div>
    );
  }

  if (gate === 'signed-out') {
    return (
      <SignIn
        problem={problem}
        loginUrl={meta?.portal.loginUrl ?? appConfig.portal.loginUrl}
        homeUrl={meta?.portal.homeUrl ?? appConfig.portal.homeUrl}
        onRetry={() => {
          forgetSession();
          void open();
        }}
      />
    );
  }

  if (gate === 'agreement-required' && user) {
    return (
      <Suspense fallback={<CentredNote text="Loading the reviewer agreement…" />}>
        <ReviewerAgreement
          labTitle="Spatial Omics AI Virtual LiveLab"
          domain="Spatial omics, perturbation modelling and therapeutic rescue simulation"
          reviewBuild={meta?.version ?? appConfig.version}
          user={user}
          onSigned={() => setGate('open')}
        />
      </Suspense>
    );
  }

  const stageAvailability = availability(project);

  const commands: Command[] = [
    ...navigationCommands(navigate, stageAvailability, Boolean(user?.isReviewer)),
    ...runCommands,
    {
      id: 'toggle-theme',
      label: theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme',
      group: 'View',
      icon: theme === 'dark' ? 'sun' : 'moon',
      run: () => setTheme(theme === 'dark' ? 'light' : 'dark'),
    },
  ];

  return (
    <ToastProvider>
      <div className="app-shell flex h-full flex-col" style={{ background: 'var(--plane)' }}>
        {/*
          * Straight to the content.
          *
          * The sidebar is twelve workflow steps plus reference and governance
          * links, and it is identical on every screen — so without this a
          * keyboard or screen-reader user traverses eighteen controls before
          * reaching the page they asked for, every single time.
          */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded focus:px-3 focus:py-2 focus:text-[12px] focus:font-medium"
          style={{ background: 'var(--action)', color: '#fff' }}
        >
          Skip to content
        </a>

        {/* The drawer's scrim. Present only while it is open, and below `lg`. */}
        {navOpen ? (
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setNavOpen(false)}
            className="fixed inset-0 z-30 lg:hidden"
            style={{ background: 'rgba(0,0,0,0.5)' }}
          />
        ) : null}

        <header className="institution-masthead shrink-0">
          <div className="institution-ribbon">
            <span>Research-use spatial omics platform</span>
            <span>Virtual LiveLab v{meta?.version ?? appConfig.version}</span>
          </div>
          <div className="institution-main">
            <div className="flex min-w-0 items-center gap-3">
              <span className="brand-mark flex h-11 w-11 shrink-0 items-center justify-center">
                <Icon name="propagation" size={22} />
              </span>
              <div className="min-w-0">
                <p className="t-caption font-semibold uppercase" style={{ color: 'rgba(255,255,255,0.78)' }}>
                  Spatial Omics AI
                </p>
                <h1 className="truncate text-[1.28rem] font-semibold leading-tight text-white sm:text-[1.55rem]">
                  Virtual LiveLab Research
                </h1>
              </div>
            </div>
            <nav className="institution-links" aria-label="Primary">
              <button type="button" onClick={() => navigate('project')}>Discover research</button>
              <button type="button" onClick={() => navigate('methods')}>Methods</button>
              <button type="button" onClick={() => navigate('register')}>Resources</button>
              <button type="button" onClick={() => navigate('about')}>Integrity</button>
            </nav>
            <button
              type="button"
              onClick={() => setNavOpen(true)}
              aria-expanded={navOpen}
              aria-controls="workflow-nav"
              className="masthead-menu lg:hidden"
            >
              Workflow
            </button>
          </div>
        </header>

        <div className="min-h-0 flex flex-1">
          <nav
            id="workflow-nav"
            className={`${navOpen ? 'flex' : 'hidden'} workflow-sidebar fixed inset-y-0 left-0 z-40 w-72 shrink-0 flex-col overflow-y-auto border-r lg:static lg:z-auto lg:flex lg:w-72`}
            style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
            aria-label="Workflow"
          >
          <div className="border-b px-4 py-4" style={{ borderColor: 'var(--border)' }}>
            <div className="flex items-center gap-3">
              <span className="brand-mark flex h-9 w-9 shrink-0 items-center justify-center rounded-lg">
                <Icon name="propagation" size={18} />
              </span>
              <div className="min-w-0">
                <p className="text-[13px] font-semibold leading-tight" style={{ color: 'var(--ink)' }}>
                  Spatial Omics AI
                </p>
                <p className="t-caption mt-0.5" style={{ color: 'var(--ink-muted)' }}>
                  Virtual LiveLab · v{meta?.version ?? appConfig.version}
                </p>
              </div>
            </div>
          </div>

          {/*
            * The palette needs a visible door.
            *
            * A keyboard-only feature is a feature most people never find, and
            * the ones who would benefit most here — someone on their fourth
            * session who knows exactly where they are going — are not the ones
            * who read documentation. The button states its own shortcut, which
            * is how the shortcut gets learned.
            */}
          <div className="px-2 pt-2">
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              className="interactive t-body flex w-full items-center gap-2 rounded-md border px-2 py-1.5"
              style={{ borderColor: 'var(--border)', color: 'var(--ink-muted)', background: 'var(--surface-sunken)' }}
            >
              <Icon name="arrow-right" size={14} className="shrink-0" />
              <span className="flex-1 text-left">Jump to…</span>
              <kbd
                className="t-caption rounded border px-1 py-px"
                style={{ borderColor: 'var(--border)', color: 'var(--ink-muted)' }}
              >
                ⌘K
              </kbd>
            </button>
          </div>

          <NavGroup title="Workflow">
            {WORKFLOW_PAGES.map((item, index) => (
              <NavItem
                key={item}
                page={item}
                active={page === item}
                onSelect={navigate}
                index={index + 1}
                available={stageAvailability[item] ?? { ready: true, reason: null }}
              />
            ))}
          </NavGroup>

          <NavGroup title="Reference">
            {REFERENCE_PAGES.map((item) => (
              <NavItem key={item} page={item} active={page === item} onSelect={navigate} available={{ ready: true, reason: null }} />
            ))}
          </NavGroup>

          <NavGroup title="Governance">
            {GOVERNANCE_PAGES.filter((item) =>
              item === 'agreement' || item === 'review' ? Boolean(user?.isReviewer) : true,
            ).map((item) => (
              <NavItem key={item} page={item} active={page === item} onSelect={navigate} available={{ ready: true, reason: null }} />
            ))}
          </NavGroup>

          <div className="mt-auto border-t px-4 py-3.5" style={{ borderColor: 'var(--border)', color: 'var(--ink-muted)' }}>
            <p className="t-caption leading-relaxed">
              Research and education use. Not a clinical treatment recommendation system.
            </p>
            <button
              type="button"
              className="interactive t-caption mt-2.5 flex w-full items-center gap-2 rounded-md border px-2 py-1.5"
              style={{ borderColor: 'var(--border)', color: 'var(--ink-secondary)' }}
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            >
              <span aria-hidden="true">{theme === 'dark' ? '☀' : '☾'}</span>
              {theme === 'dark' ? 'Light theme' : 'Dark theme'}
            </button>
            {user ? (
              <p className="t-caption mt-2.5 truncate">
                {user.displayName} · {user.tier}
              </p>
            ) : null}
          </div>
          </nav>

          <main id="main" tabIndex={-1} className="min-w-0 flex-1 overflow-y-auto">
          {/*
            * The small-screen header. It carries the one control that would
            * otherwise be unreachable once the sidebar is a drawer, and the
            * lab's name, so the page still identifies itself.
            */}
          <div
            className="mobile-topbar sticky top-0 z-20 flex items-center gap-3 border-b px-4 py-2.5 lg:hidden"
            style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
          >
            <button
              type="button"
              onClick={() => setNavOpen(true)}
              aria-expanded={navOpen}
              aria-controls="workflow-nav"
              className="-ml-1 rounded p-1.5"
              style={{ color: 'var(--ink)' }}
            >
              <span className="sr-only">Open the workflow menu</span>
              <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
                <path d="M2 4.5h14M2 9h14M2 13.5h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
            {/*
              * The lab's name, not the page's. The page already announces
              * itself in the <h1> immediately below, and showing it twice wasted
              * the one line of vertical space a phone can least afford — while
              * leaving the product unidentified outside the closed drawer.
              */}
            <p className="min-w-0 truncate text-[12.5px] font-semibold" style={{ color: 'var(--ink)' }}>
              Spatial Omics AI
            </p>
          </div>
          <Suspense fallback={<CentredNote text="Loading…" />}>
            {GOVERNANCE_PAGES.includes(page) ? (
              <div className="workspace-page mx-auto max-w-4xl px-5 py-5 sm:px-6 lg:px-8">
                {/*
                  * The page heading lives here rather than inside the panels.
                  *
                  * Workspace gives every lab screen an <h1>; these four are
                  * rendered outside it and had none, so a screen reader landed
                  * on a page whose top-level structure started at <h2>. The
                  * governance components themselves are the org-wide copies and
                  * are compared byte-for-byte across labs, so the heading is
                  * added around them, not in them.
                  */}
                <h1 className="t-title mb-5" style={{ color: 'var(--ink)' }}>
                  {PAGE_TITLES[page]}
                </h1>
                {page === 'feedback' ? <Feedback labTitle="Spatial Omics AI Virtual LiveLab" /> : null}
                {page === 'implementation' ? <ImplementationRegister /> : null}
                {page === 'agreement' && user ? (
                  <ReviewerAgreement
                    labTitle="Spatial Omics AI Virtual LiveLab"
                    domain="Spatial omics, perturbation modelling and therapeutic rescue simulation"
                    reviewBuild={meta?.version ?? appConfig.version}
                    user={user}
                    onSigned={() => navigate('project')}
                    embedded
                  />
                ) : null}
                {page === 'review' && user ? <ExpertReview labTitle="Spatial Omics AI Virtual LiveLab" user={user} /> : null}
              </div>
            ) : (
              <Workspace
                page={page}
                navigate={navigate}
                user={user}
                meta={meta}
                project={project}
                onProjectChange={onProjectChange}
                restoring={restoring}
                onRegisterCommands={setRunCommands}
              />
            )}
          </Suspense>
          </main>
        </div>
        <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />
      </div>
    </ToastProvider>
  );
}

function CentredNote({ text }: { text: string }): React.ReactElement {
  return (
    <div className="flex h-full items-center justify-center">
      <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
        {text}
      </p>
    </div>
  );
}

function NavGroup({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="px-2 py-2">
      <p className="t-eyebrow px-2 pb-1.5" style={{ color: 'var(--ink-muted)' }}>
        {title}
      </p>
      <ul className="space-y-[1px]">{children}</ul>
    </div>
  );
}

function NavItem({
  page,
  active,
  onSelect,
  index,
  available,
}: {
  page: Page;
  active: boolean;
  onSelect: (page: Page) => void;
  index?: number;
  available: { ready: boolean; reason: string | null };
}): React.ReactElement {
  const glyph = PAGE_ICON[page];
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(page)}
        title={available.reason ?? undefined}
        aria-current={active ? 'page' : undefined}
        className={`${active ? '' : 'interactive'} nav-item t-body flex w-full items-center gap-2 rounded-lg py-[7px] pl-1.5 pr-2 text-left`}
        style={{
          background: active ? 'var(--nav-active)' : 'transparent',
          color: active ? 'var(--ink)' : available.ready ? 'var(--ink-secondary)' : 'var(--ink-muted)',
          fontWeight: active ? 550 : 400,
          boxShadow: active ? 'inset 3px 0 0 var(--series-1), var(--elevation-1)' : undefined,
        }}
      >
        {/*
          * The glyph carries the step's identity, the number its position.
          * A list of eighteen text labels is what made the sidebar read as a
          * table of contents rather than as the instrument's navigation — an
          * icon is what the eye returns to when it already knows where it is
          * going, and it is the difference between scanning and reading.
          */}
        {/*
          * Number *and* glyph. The workflow is a numbered sequence and the
          * ordinal is part of how it is taught and referred to, so replacing it
          * with an icon lost information; the icon is what the eye finds, the
          * number is what a person says out loud.
          */}
        {index !== undefined ? (
          <span className="tnum t-caption w-3 shrink-0 text-right tabular-nums" style={{ color: 'var(--ink-muted)' }}>
            {index}
          </span>
        ) : null}
        {glyph ? (
          <Icon
            name={glyph}
            size={15}
            className="shrink-0"
            style={{ color: active ? 'var(--series-1)' : 'currentColor', opacity: active ? 1 : 0.7 }}
          />
        ) : null}
        <span className="min-w-0 flex-1 truncate">{PAGE_TITLES[page]}</span>
        {/*
          * A lock when the step cannot be opened yet, and nothing when it can.
          *
          * Deliberately *not* a tick on the unlocked ones. `ready` means this
          * step's prerequisite has run — for `reference`, `experiment` and
          * `interpret` that is a different stage from their own, so a tick
          * would report work as finished that nobody has done. The step stays
          * visible either way and keeps its reason in the tooltip, because
          * hiding it would remove the map of where the run has got to.
          */}
        {index !== undefined && !available.ready ? (
          <Icon name="lock" size={11} className="shrink-0" style={{ color: 'var(--ink-muted)', opacity: 0.5 }} />
        ) : null}
      </button>
    </li>
  );
}

/** Which workflow stages the project has reached, and why not. */
function availability(project: ProjectSummary | null): Partial<Record<Page, { ready: boolean; reason: string | null }>> {
  const done = new Set(project?.completedStages ?? []);
  const needs = (
    page: Page,
    stage: string,
    reason: string,
  ): [Page, { ready: boolean; reason: string | null }] => [
    page,
    done.has(stage) ? { ready: true, reason: null } : { ready: false, reason },
  ];

  if (!project) {
    return Object.fromEntries(
      WORKFLOW_PAGES.filter((page) => page !== 'project').map((page) => [
        page,
        { ready: false, reason: 'Create or open a project first.' },
      ]),
    );
  }

  return Object.fromEntries([
    ['project', { ready: true, reason: null }],
    needs('data', 'qc', 'Run the baseline analysis to produce a QC report.'),
    needs('baseline', 'baseline', 'Run the baseline analysis first.'),
    needs('reference', 'baseline', 'Run the baseline analysis first.'),
    needs('experiment', 'baseline', 'The baseline has to be analysed before it can be perturbed.'),
    needs('propagation', 'propagation', 'Run a prediction to see the propagation stages.'),
    needs('predicted', 'altered-tissue', 'Run a prediction to assemble the altered tissue.'),
    needs('rescue', 'candidates', 'Run the rescue stage to retrieve candidates.'),
    needs('compare', 'comparison', 'Candidates have to be simulated before they can be compared.'),
    needs('interpret', 'propagation', 'There is nothing to interpret until a prediction has run.'),
    needs('validate', 'propagation', 'A validation experiment is designed around a prediction.'),
    needs('report', 'qc', 'The report assembles whatever has completed.'),
  ]);
}
