/**
 * The workspace: project state, the run lifecycle, and the active screen.
 *
 * One container holds the project and which runs belong to it, so every screen
 * reads the same answer about what has happened. The alternative — each screen
 * fetching its own — is how two panels end up showing results from different
 * runs of the same project, which is a very hard thing to notice and a very
 * easy thing to act on.
 */

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, type LabMeta, type PerturbationDefinition, type ProjectSummary, type SessionUser } from '../../lib/api';
import { PAGE_TITLES, WORKFLOW_PAGES, type Page } from '../../types';
import { StepGuide, StepNav } from './StepChrome';
import { projectStateLabel } from '../../lib/format';
import { MODE_LABEL, type LabMode } from '../../lib/governance/modeLabels';
import ModeSwitcher from '../ui/ModeSwitcher';

/*
 * Reference screens belong to the lab, not to a project: the model card, the
 * parameter registry and the about page read the same whether or not one is
 * open, so a restore in flight must not blank them.
 */
const REFERENCE_ONLY = new Set<Page>(['methods', 'register', 'about']);
import { NoProjectState, PageSkeleton } from '../ui/EmptyState';
import type { Command } from '../ui/CommandPalette';
import { Icon, PAGE_ICON, type IconName } from '../ui/Icon';
import { useToast } from '../ui/ToastContext';
import { useRunResults, useRunWatch } from './useRunData';
/*
 * The screens are lazily imported.
 *
 * The workflow is sequential — nobody opens the rescue comparison before the
 * baseline has run — so loading all fifteen screens plus every chart they use
 * into the entry chunk makes the first paint wait for code that will not be
 * touched for minutes. Each is its own chunk, fetched when it is first shown.
 *
 * Note for whoever tunes the build next: do NOT add a `manualChunks` entry for
 * these. Naming a chunk promotes it into the entry's static import graph, Vite
 * emits a <link rel="modulepreload"> for it, and the lazy import stops doing
 * anything. Check with `npm run build && grep modulepreload dist/public/index.html`.
 */
const ProjectPage = lazy(() => import('./pages/ProjectPage'));
const DataQcPage = lazy(() => import('./pages/DataQcPage'));
const BaselinePage = lazy(() => import('./pages/BaselinePage'));
const ReferencePage = lazy(() => import('./pages/ReferencePage'));
const ExperimentPage = lazy(() => import('./pages/ExperimentPage'));
const PropagationPage = lazy(() => import('./pages/PropagationPage'));
const PredictedPage = lazy(() => import('./pages/PredictedPage'));
const RescuePage = lazy(() => import('./pages/RescuePage'));
const ComparePage = lazy(() => import('./pages/ComparePage'));
const InterpretPage = lazy(() => import('./pages/InterpretPage'));
const ValidatePage = lazy(() => import('./pages/ValidatePage'));
const ReportPage = lazy(() => import('./pages/ReportPage'));
const MethodsPage = lazy(() => import('./pages/MethodsPage'));
const RegistryPage = lazy(() => import('./pages/RegistryPage'));
const AboutPage = lazy(() => import('./pages/AboutPage'));

export interface WorkspaceContext {
  project: ProjectSummary | null;
  meta: LabMeta | null;
  user: SessionUser | null;
  analysisRunId: string | null;
  predictionRunId: string | null;
  rescueRunId: string | null;
  definition: PerturbationDefinition | null;
  setDefinition: (definition: PerturbationDefinition | null) => void;
  refreshProject: () => Promise<void>;
  submitRun: (kind: 'analysis' | 'prediction' | 'rescue', body?: Record<string, unknown>) => Promise<void>;
  running: { kind: string; progress: number; message: string | null } | null;
  navigate: (page: Page) => void;
}

export default function Workspace({
  page,
  navigate,
  user,
  meta,
  project,
  onProjectChange,
  restoring = false,
  onRegisterCommands,
  onUserRefresh,
}: {
  page: Page;
  navigate: (page: Page) => void;
  user: SessionUser | null;
  meta: LabMeta | null;
  project: ProjectSummary | null;
  onProjectChange: (project: ProjectSummary | null) => void;
  /** A project named in the address bar is being fetched. */
  restoring?: boolean;
  /** Publishes this workspace's runnable actions to the command palette. */
  onRegisterCommands?: ((commands: Command[]) => void) | undefined;
  /** Re-reads the signed-in user; a completed prediction can open a mode. */
  onUserRefresh?: (() => Promise<void>) | undefined;
}): React.ReactElement {
  const toast = useToast();
  const [definition, setDefinition] = useState<PerturbationDefinition | null>(null);
  const [runningKind, setRunningKind] = useState<string | null>(null);

  const refreshProject = useCallback(async () => {
    if (!project) return;
    try {
      const { project: fresh } = await api.project(project.projectId);
      onProjectChange(fresh);
    } catch (error) {
      if (error instanceof ApiError) toast.push('error', 'Could not refresh the project', error.message);
    }
  }, [project, onProjectChange, toast]);

  const watch = useRunWatch(
    useCallback(
      (status) => {
        setRunningKind(null);
        void refreshProject();
        if (status.status === 'complete') {
          toast.push('success', `${PAGE_TITLES[page] ?? 'Run'} finished`, 'Results are ready.');
          if (status.kind === 'prediction') void onUserRefresh?.();
        } else if (status.status === 'failed') {
          toast.push('error', 'The run failed', status.error?.message ?? 'No reason was given.');
        } else if (status.status === 'cancelled') {
          toast.push('warning', 'The run was cancelled', 'Artefacts written before the stop are kept.');
        }
      },
      [refreshProject, toast, page, onUserRefresh],
    ),
  );

  const latest = useCallback(
    (kind: string): string | null => {
      const runs = (project?.runs ?? []).filter((run) => run.kind === kind && run.status === 'complete');
      return runs.length > 0 ? (runs[runs.length - 1] as { runId: string }).runId : null;
    },
    [project],
  );

  const analysisRunId = useMemo(() => latest('analysis'), [latest]);
  const predictionRunId = useMemo(() => latest('prediction'), [latest]);
  const rescueRunId = useMemo(() => latest('rescue'), [latest]);

  const submitRun = useCallback(
    async (kind: 'analysis' | 'prediction' | 'rescue', body: Record<string, unknown> = {}) => {
      if (!project) return;
      try {
        const { runId } = await api.submitRun(project.projectId, { kind, ...body });
        setRunningKind(kind);
        watch.start(runId);
        await refreshProject();
      } catch (error) {
        if (error instanceof ApiError) {
          toast.push('error', 'The run could not be started', `${error.message} ${error.suggestedAction}`.trim());
        } else {
          toast.push('error', 'The run could not be started');
        }
      }
    },
    [project, watch, refreshProject, toast],
  );

  // Adopt a run that is still going when the page is reloaded, so a refresh
  // mid-run does not look like the run vanished.
  useEffect(() => {
    if (runningKind || !project) return;
    const active = project.runs.find((run) => run.status === 'queued' || run.status === 'running');
    if (active) {
      setRunningKind(active.kind);
      watch.start(active.runId);
    }
    // Only when the project identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.projectId]);

  const context: WorkspaceContext = {
    project,
    meta,
    user,
    analysisRunId,
    predictionRunId,
    rescueRunId,
    definition,
    setDefinition,
    refreshProject,
    submitRun,
    running: runningKind
      ? {
          kind: runningKind,
          progress: watch.status?.progress ?? 0,
          message: watch.status?.message ?? null,
        }
      : null,
    navigate,
  };

  /*
   * The runnable actions, with the reason each one cannot run right now.
   *
   * The palette shows a blocked command rather than hiding it: "Run the rescue
   * stage — needs a prediction first" answers the question, where an absent
   * entry leaves the user wondering whether they mis-typed. The reasons come
   * from the same project state the sidebar reads, so the two cannot disagree.
   */
  useEffect(() => {
    if (!onRegisterCommands) return;
    const busy = runningKind ? `a ${runningKind} run is in progress` : null;
    const stages = new Set(project?.completedStages ?? []);
    const blockedBy = (need: string | null): string | undefined => busy ?? need ?? undefined;

    onRegisterCommands([
      {
        id: 'run-analysis',
        label: 'Run the baseline analysis',
        group: 'Run',
        icon: 'data',
        ...(blockedBy(project ? null : 'open a project first') ? { blocked: blockedBy(project ? null : 'open a project first') } : {}),
        run: () => void submitRun('analysis'),
      },
      {
        id: 'run-prediction',
        label: 'Run the prediction',
        group: 'Run',
        icon: 'propagation',
        ...(blockedBy(
          !project ? 'open a project first' : !definition ? 'define a perturbation first' : null,
        )
          ? {
              blocked: blockedBy(
                !project ? 'open a project first' : !definition ? 'define a perturbation first' : null,
              ),
            }
          : {}),
        run: () => void submitRun('prediction', definition ? { perturbationId: definition.id } : {}),
      },
      {
        id: 'run-rescue',
        label: 'Simulate the rescue candidates',
        group: 'Run',
        icon: 'rescue',
        ...(blockedBy(
          !project ? 'open a project first' : !stages.has('altered-tissue') ? 'needs a prediction first' : null,
        )
          ? {
              blocked: blockedBy(
                !project ? 'open a project first' : !stages.has('altered-tissue') ? 'needs a prediction first' : null,
              ),
            }
          : {}),
        run: () => void submitRun('rescue', { stages: 5 }),
      },
    ]);
  }, [onRegisterCommands, project, definition, runningKind, submitRun]);

  const analysis = useRunResults(analysisRunId);
  const prediction = useRunResults(predictionRunId);
  const rescue = useRunResults(rescueRunId);

  /*
   * Switching mode re-reads the results: the server shapes what it returns by
   * the project's mode (diagnostics and provenance depth). The numbers are the
   * same in every mode (§3), so nothing is re-run.
   */
  const [modeBusy, setModeBusy] = useState(false);
  const changeMode = useCallback(
    async (mode: LabMode) => {
      if (!project || mode === project.mode) return;
      setModeBusy(true);
      try {
        const { project: updated } = await api.setMode(project.projectId, mode);
        onProjectChange(updated);
        analysis.reload();
        prediction.reload();
        rescue.reload();
        toast.push('success', `${MODE_LABEL[mode]} mode`, 'Same results; this mode shows its own controls and depth of detail.');
      } catch (error) {
        toast.push('error', 'The mode was not changed', error instanceof ApiError ? error.message : 'Try again in a moment.');
      } finally {
        setModeBusy(false);
      }
    },
    [project, onProjectChange, analysis, prediction, rescue, toast],
  );

  // Say so when a mode opens during the session (Intermediate, after the
  // first completed prediction), rather than leaving it to be noticed.
  const previousModes = useRef<LabMode[] | null>(null);
  useEffect(() => {
    const now = user?.availableModes ?? null;
    const before = previousModes.current;
    previousModes.current = now;
    if (!before || !now) return;
    for (const mode of now) {
      if (!before.includes(mode)) {
        toast.push('success', `${MODE_LABEL[mode]} mode is now open`, 'Switch to it from the mode control at the top of any page.');
      }
    }
  }, [user?.availableModes, toast]);

  return (
    <div className={`workspace-page workspace-page-${page} mx-auto px-5 py-6 sm:px-6 lg:px-8`}>
      {/*
        * The page header.
        *
        * It was a heading with a run of dot-separated words under it, which put
        * the project's title, its state and its mode at the same weight as each
        * other and at the same weight as nothing in particular. Each is a
        * different kind of fact: the title names the work, the state is a
        * lifecycle position, the mode is a setting that changes what the screen
        * offers. Chips separate them, and a rule under the header gives the
        * content below an edge to start from instead of floating.
        */}
      {/*
        * Every page gets this header, the Project page included. It used to be
        * skipped there because the page drew its own hero; that hero is gone,
        * and without this the page had no h1 at all.
        */}
      {(
        <header
          className="page-hero mb-6 flex flex-wrap items-start justify-between gap-4 px-4 py-4 sm:px-5"
          style={{ borderColor: 'var(--border)' }}
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              {PAGE_ICON[page] ? (
                <span
                  className="brand-mark flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
                  style={{ borderColor: 'var(--border)' }}
                >
                  <Icon name={PAGE_ICON[page] as IconName} size={18} />
                </span>
              ) : null}
              <h1 className="t-title truncate" style={{ color: 'var(--ink)' }}>
                {PAGE_TITLES[page]}
              </h1>
            </div>
            {project ? (
              <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                <Chip tone="strong">{project.title}</Chip>
                <Chip>{projectStateLabel(project.state)}</Chip>
              </div>
            ) : null}
          </div>
          {project || context.running ? (
            <div className="flex flex-col items-start gap-2 sm:items-end">
              {project ? (
                <ModeSwitcher
                  current={project.mode}
                  available={user?.availableModes ?? ['basic']}
                  locks={user?.lockedModes ?? {}}
                  busy={modeBusy}
                  onChange={(mode) => void changeMode(mode)}
                  onLocked={(mode, reason) => toast.push('info', `${MODE_LABEL[mode]} is locked`, reason)}
                />
              ) : null}
              {context.running ? (
                <RunProgress kind={context.running.kind} progress={context.running.progress} message={context.running.message} />
              ) : null}
            </div>
          ) : null}
        </header>
      )}

      {/*
        * Beginner mode's guide to the step. The other modes trade it for the
        * diagnostics and provenance their tagged sections add.
        */}
      {WORKFLOW_PAGES.includes(page) && (project?.mode ?? 'basic') === 'basic' ? <StepGuide page={page} /> : null}

      <Suspense fallback={<PageSkeleton />}>
      {/*
        * A restore in flight is not an empty stage.
        *
        * On a reload the project id is in the address bar but the project has
        * not arrived yet. Rendering the ordinary empty state here would tell
        * someone to run an analysis they have already run — so the screens wait
        * for the answer instead of guessing at it.
        */}
      {page === 'project' ? <ProjectPage context={context} onProjectChange={onProjectChange} /> : null}
      {restoring && page !== 'project' && !REFERENCE_ONLY.has(page) ? <RestoringProject /> : null}
      {/*
        * No project at all is a different answer from "this stage has not run",
        * and the stage screens cannot tell them apart — with no project their
        * results are null either way, so each one said "run the analysis" to a
        * user who had nowhere to run it. The distinction is made once, here.
        */}
      {!restoring && !project && page !== 'project' && !REFERENCE_ONLY.has(page) ? (
        <NoProjectState onGo={navigate} />
      ) : null}
      {page === 'data' && !restoring && project ? <DataQcPage context={context} analysis={analysis} /> : null}
      {page === 'baseline' && !restoring && project ? <BaselinePage context={context} analysis={analysis} /> : null}
      {page === 'reference' && !restoring && project ? <ReferencePage context={context} analysis={analysis} /> : null}
      {page === 'experiment' && !restoring && project ? <ExperimentPage context={context} /> : null}
      {page === 'propagation' && !restoring && project ? <PropagationPage context={context} prediction={prediction} analysis={analysis} /> : null}
      {page === 'predicted' && !restoring && project ? <PredictedPage context={context} prediction={prediction} analysis={analysis} /> : null}
      {page === 'rescue' && !restoring && project ? <RescuePage context={context} rescue={rescue} analysis={analysis} /> : null}
      {page === 'compare' && !restoring && project ? <ComparePage context={context} rescue={rescue} /> : null}
      {page === 'interpret' && !restoring && project ? <InterpretPage context={context} /> : null}
      {page === 'validate' && !restoring && project ? <ValidatePage context={context} prediction={prediction} /> : null}
      {page === 'report' && !restoring && project ? <ReportPage context={context} /> : null}
      {page === 'methods' ? <MethodsPage context={context} analysis={analysis} /> : null}
      {page === 'register' ? <RegistryPage /> : null}
      {page === 'about' ? <AboutPage context={context} /> : null}
      </Suspense>

      {/* Where this step sits, and Next once it is complete. */}
      <StepNav page={page} project={project} navigate={navigate} />
    </div>
  );
}

/** A small labelled pill for a single fact about the open project. */
function Chip({ children, tone = 'quiet' }: { children: React.ReactNode; tone?: 'quiet' | 'strong' }): React.ReactElement {
  return (
    <span
      className="t-caption inline-flex max-w-[22rem] items-center truncate rounded border px-1.5 py-0.5"
      style={{
        borderColor: 'var(--border)',
        background: tone === 'strong' ? 'var(--surface-raised)' : 'transparent',
        color: tone === 'strong' ? 'var(--ink)' : 'var(--ink-muted)',
      }}
    >
      {children}
    </span>
  );
}

/** The pause between a reload and the project arriving. */
function RestoringProject(): React.ReactElement {
  return (
    <div
      className="flex min-h-[18rem] items-center justify-center rounded-lg border"
      style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
      role="status"
      aria-live="polite"
    >
      <p className="text-[12px]" style={{ color: 'var(--ink-muted)' }}>
        Opening the project…
      </p>
    </div>
  );
}

function RunProgress({
  kind,
  progress,
  message,
}: {
  kind: string;
  progress: number;
  message: string | null;
}): React.ReactElement {
  const percent = Math.round(progress * 100);
  return (
    <div className="w-64 rounded border px-3 py-2" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
      <div className="flex items-baseline justify-between text-[11px]">
        <span style={{ color: 'var(--ink-secondary)' }}>{kind} running</span>
        <span className="tnum" style={{ color: 'var(--ink-muted)' }}>
          {percent}%
        </span>
      </div>
      {/*
        * A progressbar, deliberately not a live region.
        *
        * An analysis takes about a minute and the status is polled throughout,
        * so `aria-live` here would read a new percentage aloud every second or
        * two and talk over everything else on the screen. The role lets a
        * screen reader query progress when its user asks for it, and the toast
        * that fires on completion is what actually announces the result —
        * which is the part worth interrupting for.
        */}
      <div
        role="progressbar"
        aria-label={`${kind} run`}
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={message ? `${percent}%, ${message}` : `${percent}%`}
        className="mt-1.5 h-1 overflow-hidden rounded"
        style={{ background: 'var(--surface-sunken)' }}
      >
        <div className="h-full rounded transition-all" style={{ width: `${Math.max(2, percent)}%`, background: 'var(--series-1)' }} />
      </div>
      {message ? (
        <p className="mt-1 truncate text-[10.5px]" style={{ color: 'var(--ink-muted)' }}>
          {message}
        </p>
      ) : null}
    </div>
  );
}
