/**
 * Project setup — §6.1 and §11.2's landing screen.
 *
 * The research-use boundary and the frozen workflow are on this screen because
 * §6.1 puts them here: somebody should meet what the lab is and is not before
 * they run anything, not in a footnote on the report.
 *
 * This screen used to open with roughly eight sections of templated editorial
 * copy above the actual form — a hero, an "infrastructure" grid, a "strategic"
 * grid, a news list, a validation-ladder timeline — carrying a handful of
 * hardcoded numbers ("16 frozen stages", "22 candidate records") that nothing
 * kept in sync with the server. None of it was wrong exactly, but it buried
 * the one thing a returning user opens this screen to do — start or resume a
 * project — under several screens of scrolling, and it duplicated ground the
 * dedicated About and Methods pages already cover more carefully. That content
 * is gone; the boundary notice and the real twelve-step workflow reference
 * stay, because §6.1 and §2 require them here specifically.
 */

import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, type CaseSummary, type ProjectSummary } from '../../../lib/api';
import type { LabMode } from '../../../types';
import { Button, Caveat, Section, StatTile } from '../../ui/Badges';
import { Icon } from '../../ui/Icon';
import { Search } from 'lucide-react';
import { useToast } from '../../ui/ToastContext';
import { integer, shortHash, timestamp } from '../../../lib/format';
import type { WorkspaceContext } from '../Workspace';

/** §2's frozen scientific sequence, at the resolution the methodology names it
 *  — sixteen steps, which the twelve navigable screens group at a coarser
 *  grain. Kept distinct from the sidebar's numbering on purpose: conflating
 *  the two would make either list look wrong. */
const WORKFLOW = [
  'Spatial omics input',
  'Validate, QC and preprocess',
  'Baseline tissue analysis',
  'Baseline view and reference comparison',
  'Select the virtual experiment',
  'Molecular/genetic OR drug perturbation',
  'Direct target-cell response',
  'Build the spatial graph',
  'First-neighbour response',
  'Spatial propagation',
  'Predicted altered tissue',
  'Adverse, off-target and uncertainty',
  'Evidence-supported rescue candidates',
  'Simulate every eligible candidate',
  'Compare with a transparent policy',
  'Explain, validate and export',
];

/**
 * §10.3's state machine, grouped into the four buckets a project list reads
 * at a glance. The thirteen underlying states (`ProjectState`) are too fine a
 * grain for a status chip — nobody scans a project list looking for
 * `GRAPH_READY` specifically — but the bucket a state falls into is derived
 * from the same server-computed value, never guessed from the title or the
 * timestamp.
 */
type StatusBucket = 'setup' | 'running' | 'predicted' | 'complete' | 'attention';

const RUNNING_STATES = new Set(['QUEUED', 'RUNNING', 'RESCUE_RUNNING']);
const PREDICTED_STATES = new Set(['PREDICTED', 'RESCUE_READY']);

function statusBucket(project: ProjectSummary): StatusBucket {
  if (project.failedStages.length > 0) return 'attention';
  if (project.state === 'COMPLETE') return 'complete';
  if (RUNNING_STATES.has(project.state)) return 'running';
  if (PREDICTED_STATES.has(project.state)) return 'predicted';
  return 'setup';
}

const BUCKET_LABEL: Record<StatusBucket, string> = {
  setup: 'Setting up',
  running: 'Running',
  predicted: 'Predicted',
  complete: 'Complete',
  attention: 'Needs attention',
};

/**
 * The colour each bucket uses, reusing tokens that already carry this exact
 * meaning elsewhere in the lab rather than inventing a parallel palette.
 * "Predicted" takes the §1.5 result-label colour a predicted layer uses on
 * every chart; "Attention" and "Complete" take the status tokens the QC
 * verdict badge uses; "Running" takes the accent; "Setting up" stays neutral
 * ink, because nothing has gone right or wrong yet.
 */
const BUCKET_COLOUR: Record<StatusBucket, string> = {
  setup: 'var(--ink-muted)',
  // `--action` is tuned as a UI fill/border (3:1), not small text (4.5:1) —
  // `--series-1-text` is the step already taken for exactly this elsewhere.
  running: 'var(--series-1-text)',
  predicted: 'var(--label-predicted)',
  complete: 'var(--status-good)',
  attention: 'var(--status-critical)',
};

function StatusChip({ bucket }: { bucket: StatusBucket }): React.ReactElement {
  const colour = BUCKET_COLOUR[bucket];
  return (
    <span
      className="t-caption inline-flex shrink-0 items-center gap-1 rounded-sm border px-1.5 py-[1px] font-medium uppercase tracking-wide"
      style={{ color: colour, borderColor: colour }}
    >
      {bucket === 'running' ? (
        <span aria-hidden="true" className="status-pulse-dot" style={{ background: colour }} />
      ) : null}
      {BUCKET_LABEL[bucket]}
    </span>
  );
}

type SortOrder = 'updated' | 'title';

export default function ProjectPage({
  context,
  onProjectChange,
}: {
  context: WorkspaceContext;
  onProjectChange: (project: ProjectSummary | null) => void;
}): React.ReactElement {
  const toast = useToast();
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [title, setTitle] = useState('');
  const [question, setQuestion] = useState('');
  const [caseId, setCaseId] = useState('');
  const [referenceId, setReferenceId] = useState('');
  const [mode, setMode] = useState<LabMode>('basic');
  const [creating, setCreating] = useState(false);

  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<StatusBucket | 'all'>('all');
  const [sort, setSort] = useState<SortOrder>('updated');

  useEffect(() => {
    void (async () => {
      try {
        const [caseList, projectList] = await Promise.all([api.cases(), api.projects()]);
        setCases(caseList.cases);
        setProjects(projectList.projects);
        const primary = caseList.cases.find((entry) => entry.role === 'primary');
        if (primary) setCaseId(primary.caseId);
      } catch (error) {
        if (error instanceof ApiError) toast.push('error', 'Could not load the case list', error.message);
      }
    })();
  }, [toast]);

  useEffect(() => {
    const available = context.user?.availableModes ?? ['basic'];
    if (!available.includes(mode)) setMode(available[available.length - 1] as LabMode);
    // Only when the account changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context.user?.userId]);

  const chosen = cases.find((entry) => entry.caseId === caseId);
  const comparable = chosen ? cases.filter((entry) => chosen.comparableWith.includes(entry.caseId)) : [];

  const bucketCounts = useMemo(() => {
    const counts: Record<StatusBucket, number> = { setup: 0, running: 0, predicted: 0, complete: 0, attention: 0 };
    for (const project of projects) counts[statusBucket(project)] += 1;
    return counts;
  }, [projects]);

  const visibleProjects = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = projects.filter((project) => {
      if (filter !== 'all' && statusBucket(project) !== filter) return false;
      if (needle && !project.title.toLowerCase().includes(needle)) return false;
      return true;
    });
    const sorted = [...filtered];
    if (sort === 'title') sorted.sort((a, b) => a.title.localeCompare(b.title));
    else sorted.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    return sorted;
  }, [projects, query, filter, sort]);

  const create = async (): Promise<void> => {
    if (!title.trim()) {
      toast.push('warning', 'A project needs a title');
      return;
    }
    setCreating(true);
    try {
      const { project } = await api.createProject({
        title: title.trim(),
        studyQuestion: question.trim(),
        mode,
        caseId,
        referenceCaseId: referenceId || null,
      });
      onProjectChange(project);
      toast.push('success', 'Project created', 'Run the baseline analysis next.');
      context.navigate('data');
    } catch (error) {
      if (error instanceof ApiError) {
        toast.push('error', 'The project could not be created', `${error.message} ${error.suggestedAction}`.trim());
      }
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-5">
      <section
        id="research-boundary"
        className="overflow-hidden rounded-lg border"
        style={{
          borderColor: 'var(--border)',
          background: 'var(--surface)',
          boxShadow: 'var(--elevation-1)',
          borderLeft: '3px solid var(--series-1)',
        }}
      >
        <div className="flex items-start gap-3 px-5 py-4">
          <span
            className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
            style={{ background: 'color-mix(in oklab, var(--series-1) 16%, transparent)', color: 'var(--series-1)' }}
          >
            <Icon name="about" size={15} />
          </span>
          <div className="min-w-0">
            <h2 className="t-heading" style={{ color: 'var(--ink)' }}>
              Research-use boundary
            </h2>
            <p className="t-small mt-1" style={{ color: 'var(--ink-secondary)' }}>
              Read this before running anything. It is the scope the whole lab is built inside.
            </p>
          </div>
        </div>
        <div className="border-t px-5 py-4" style={{ borderColor: 'var(--border)' }}>
          <div className="t-body space-y-2.5" style={{ color: 'var(--ink-secondary)' }}>
            <p>
              This is a research and education platform for virtual experimentation. It is{' '}
              <strong style={{ color: 'var(--ink)' }}>not a clinical treatment recommendation system</strong>, and no output
              from it is clinical guidance.
            </p>
            <p>
              Every numerical result comes from an explicit analysis method, a calibrated parameter or a trained model. The AI
              layer explains structured results and organises evidence; it never produces a number, a map or a comparison, and
              its output is checked against the evidence it was given before it is shown.
            </p>
            {context.meta?.modelPackMissing ? <Caveat tone="warning">{context.meta.modelPackMissing}</Caveat> : null}
          </div>
        </div>
      </section>

      <div id="project-form" className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Section title="New project" subtitle="§6.1 — record the study before any computation.">
          <div className="space-y-3">
            <label className="block">
              <span className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
                Project title
              </span>
              <input
                id="project-title"
                type="text"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="e.g. TGFB1 loss in the fibroblast compartment"
                className="mt-1 w-full rounded border px-2 py-1.5 text-[12px]"
                style={{ color: 'var(--ink)' }}
              />
            </label>

            <label className="block">
              <span className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
                Study question
              </span>
              <textarea
                value={question}
                rows={2}
                onChange={(event) => setQuestion(event.target.value)}
                placeholder="What are you trying to find out?"
                className="mt-1 w-full rounded border px-2 py-1.5 text-[12px]"
                style={{ color: 'var(--ink)' }}
              />
            </label>

            <label className="block">
              <span className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
                Dataset
              </span>
              <select
                value={caseId}
                onChange={(event) => {
                  setCaseId(event.target.value);
                  setReferenceId('');
                }}
                className="mt-1 w-full rounded border px-2 py-1.5 text-[12px]"
                style={{ color: 'var(--ink)' }}
              >
                <option value="">Upload a tabular dataset after creating the project</option>
                {cases
                  .filter((entry) => entry.role === 'primary')
                  .map((entry) => (
                    <option key={entry.caseId} value={entry.caseId}>
                      {entry.title}
                    </option>
                  ))}
              </select>
            </label>

            {comparable.length > 0 ? (
              <label className="block">
                <span className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
                  Reference comparison (optional)
                </span>
                <select
                  value={referenceId}
                  onChange={(event) => setReferenceId(event.target.value)}
                  className="mt-1 w-full rounded border px-2 py-1.5 text-[12px]"
                  style={{ color: 'var(--ink)' }}
                >
                  <option value="">None</option>
                  {comparable.map((entry) => (
                    <option key={entry.caseId} value={entry.caseId}>
                      {entry.title}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            <fieldset>
              <legend className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
                Mode
              </legend>
              <div className="mt-1.5 space-y-1.5">
                {(context.meta?.modes ?? []).map((entry) => {
                  const allowed = context.user?.availableModes.includes(entry.id) ?? false;
                  return (
                    <label
                      key={entry.id}
                      className="flex items-start gap-2 text-[12px]"
                      style={{ color: allowed ? 'var(--ink-secondary)' : 'var(--ink-muted)' }}
                      title={allowed ? undefined : 'Advanced is a paid tier. Reviewers and administrators are exempt.'}
                    >
                      <input
                        type="radio"
                        name="mode"
                        className="mt-0.5"
                        checked={mode === entry.id}
                        disabled={!allowed}
                        onChange={() => setMode(entry.id)}
                      />
                      <span>{entry.summary}</span>
                    </label>
                  );
                })}
              </div>
              <p className="mt-1.5 text-[10.5px] leading-snug" style={{ color: 'var(--ink-muted)' }}>
                The modes differ in which controls, diagnostics and exports are available — never in the numbers. For the
                same datasets, parameters, model version and seed, all three return the same result (§3).
              </p>
            </fieldset>

            <Button variant="primary" onClick={() => void create()} disabled={creating}>
              {creating ? 'Creating…' : 'Create project'}
            </Button>
          </div>
        </Section>

        {chosen ? (
          <Section title="Selected dataset" subtitle={chosen.title}>
            <Caveat tone="warning">{chosen.simulationNotice}</Caveat>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <StatTile label="Observations" value={integer(chosen.observations)} unit="cells" />
              <StatTile label="Features" value={integer(chosen.features)} />
            </div>
            <dl className="t-small mt-4 space-y-1.5" style={{ color: 'var(--ink-secondary)' }}>
              <Meta term="Organism" value={chosen.organism} />
              <Meta term="Tissue" value={chosen.tissue} />
              <Meta term="Condition" value={chosen.condition} />
              <Meta term="Assay" value={chosen.assay} />
              <Meta term="Resolution" value={chosen.resolution} />
              <Meta term="Coordinate unit" value={chosen.coordinateUnit === 'um' ? 'µm' : chosen.coordinateUnit} />
              <Meta term="Licence" value={chosen.licence} />
              <Meta term="Checksum" value={shortHash(chosen.checksum, 16)} />
              <Meta term="Generated" value={timestamp(chosen.generatedAt)} />
            </dl>
          </Section>
        ) : null}
      </div>

      {/*
        * The project workspace.
        *
        * Search, a status filter and a sort order, all computed client-side
        * over the project list the page already fetched — no new endpoint,
        * because the list a single researcher keeps here is not the scale
        * that needs server-side paging, and adding one would be new surface
        * for no present need. If that stops being true, the filtering logic
        * here moves to the query rather than disappearing.
        */}
      {projects.length > 0 ? (
        <Section
          title="Your projects"
          subtitle={`${projects.length} project${projects.length === 1 ? '' : 's'} · ${bucketCounts.attention > 0 ? `${bucketCounts.attention} need${bucketCounts.attention === 1 ? 's' : ''} attention` : 'none need attention'}`}
        >
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <label className="relative flex-1" style={{ minWidth: '12rem' }}>
              <span className="sr-only">Search your projects</span>
              <Search
                size={13}
                strokeWidth={2}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2"
                style={{ color: 'var(--ink-muted)' }}
              />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search by title…"
                className="w-full rounded border py-1.5 pl-7 pr-2 text-[12px]"
                style={{ color: 'var(--ink)' }}
              />
            </label>
            <select
              value={sort}
              onChange={(event) => setSort(event.target.value as SortOrder)}
              className="rounded border px-2 py-1.5 text-[12px]"
              style={{ color: 'var(--ink)' }}
              aria-label="Sort projects"
            >
              <option value="updated">Recently updated</option>
              <option value="title">Title A–Z</option>
            </select>
          </div>

          <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="Filter by status">
            <FilterChip label="All" count={projects.length} active={filter === 'all'} onClick={() => setFilter('all')} />
            {(['attention', 'running', 'predicted', 'complete', 'setup'] as StatusBucket[])
              .filter((bucket) => bucketCounts[bucket] > 0)
              .map((bucket) => (
                <FilterChip
                  key={bucket}
                  label={BUCKET_LABEL[bucket]}
                  count={bucketCounts[bucket]}
                  active={filter === bucket}
                  colour={BUCKET_COLOUR[bucket]}
                  onClick={() => setFilter(bucket)}
                />
              ))}
          </div>

          {visibleProjects.length === 0 ? (
            <p className="t-small py-6 text-center" style={{ color: 'var(--ink-muted)' }}>
              {query ? `No project matches "${query}".` : 'No project in this status.'}
            </p>
          ) : (
            <ul className="space-y-2">
              {visibleProjects.map((entry) => {
                const bucket = statusBucket(entry);
                const open = entry.projectId === context.project?.projectId;
                return (
                  <li key={entry.projectId}>
                    <button
                      type="button"
                      onClick={() => {
                        onProjectChange(entry);
                        context.navigate('data');
                      }}
                      className="project-card interactive w-full rounded-lg border px-3.5 py-3 text-left"
                      style={{
                        borderColor: open ? 'var(--series-1)' : 'var(--border)',
                        background: open ? 'var(--surface-raised)' : 'var(--surface)',
                      }}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <span className="t-body block truncate font-medium" style={{ color: 'var(--ink)' }}>
                            {entry.title}
                          </span>
                          <span className="t-caption mt-1 block" style={{ color: 'var(--ink-muted)' }}>
                            {entry.mode} mode · updated {timestamp(entry.updatedAt)}
                          </span>
                        </div>
                        <StatusChip bucket={bucket} />
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>
      ) : null}

      <Section title="The frozen V1 workflow" subtitle="§2 — the scientific sequence is fixed and this lab follows it in order.">
        <ol className="grid gap-x-6 gap-y-1 text-[11.5px] sm:grid-cols-2 lg:grid-cols-4" style={{ color: 'var(--ink-secondary)' }}>
          {WORKFLOW.map((step, index) => (
            <li key={step} className="flex gap-2">
              <span className="tnum w-5 shrink-0 text-right" style={{ color: 'var(--ink-muted)' }}>
                {String(index + 1).padStart(2, '0')}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
        <p className="mt-3 text-[11px] leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
          Therapy ranking happens only after every eligible candidate has been simulated separately in the same altered
          tissue state. The AI may retrieve and explain candidates; it cannot replace the numerical simulation or the
          comparison.
        </p>
      </Section>
    </div>
  );
}

function FilterChip({
  label,
  count,
  active,
  colour,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  colour?: string;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="interactive t-caption flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-medium"
      style={{
        // `--series-1-text`, not `--series-1`: the border only needs 3:1 as a
        // UI outline, but this colour doubles as the label's text, which
        // needs 4.5:1 — `--series-1` was validated for the former only.
        borderColor: active ? (colour ?? 'var(--series-1-text)') : 'var(--border)',
        color: active ? (colour ?? 'var(--series-1-text)') : 'var(--ink-secondary)',
        background: active ? 'var(--surface-raised)' : 'transparent',
      }}
    >
      {label}
      {/* `--ink-secondary`, not `--ink-muted`, once the chip is active: the
          active background is `--surface-raised`, and muted ink was tuned
          against the page's own surface rather than this raised one. */}
      <span style={{ color: active ? 'var(--ink-secondary)' : 'var(--ink-muted)' }}>{count}</span>
    </button>
  );
}

/**
 * A term-and-value row in the dataset panel.
 *
 * Two columns on a grid rather than `justify-between` with a right-aligned
 * value. The old arrangement was fine while every value was one short word and
 * fell apart on the one that is not: the assay string wrapped to three lines,
 * each ragged on the left, so the column had no edge to read down and the
 * longest — most informative — value was the hardest to read. A fixed term
 * column and a left-aligned value keeps every line starting in the same place.
 */
function Meta({ term, value }: { term: string; value: string }): React.ReactElement {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] gap-x-3 gap-y-0.5">
      <dt className="truncate" style={{ color: 'var(--ink-muted)' }}>
        {term}
      </dt>
      <dd className="min-w-0 break-words">{value}</dd>
    </div>
  );
}
