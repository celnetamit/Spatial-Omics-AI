/**
 * Project setup — §6.1 and §11.2's landing screen.
 *
 * The research-use boundary and the frozen workflow are on this screen because
 * §6.1 puts them here: somebody should meet what the lab is and is not before
 * they run anything, not in a footnote on the report.
 */

import { useEffect, useState } from 'react';
import { api, ApiError, type CaseSummary, type ProjectSummary } from '../../../lib/api';
import type { LabMode } from '../../../types';
import { Button, Caveat, Section, StatTile } from '../../ui/Badges';
import { Icon } from '../../ui/Icon';
import { useToast } from '../../ui/ToastContext';
import { integer, shortHash, timestamp } from '../../../lib/format';
import type { WorkspaceContext } from '../Workspace';

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
    <div className="space-y-4">
      {/*
        * The boundary is the first thing on the first screen and it was a grey
        * panel among grey panels — the same weight as the form beside it, so
        * the one statement the whole lab is built inside read as boilerplate to
        * scroll past. It keeps a plain surface rather than a warning colour,
        * because it is a scope statement and not an alert, but it now carries
        * an accent edge and a mark so the eye registers it as a different kind
        * of thing from the panels under it.
        */}
      <section
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

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Section title="New project" subtitle="§6.1 — record the study before any computation.">
          <div className="space-y-3">
            <label className="block">
              <span className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
                Project title
              </span>
              <input
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

        <div className="space-y-4">
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

          {projects.length > 0 ? (
            <Section title="Your projects">
              <ul className="space-y-1">
                {projects.map((entry) => (
                  <li key={entry.projectId}>
                    <button
                      type="button"
                      onClick={() => {
                        onProjectChange(entry);
                        context.navigate('data');
                      }}
                      className="w-full rounded px-2 py-1.5 text-left text-[12px]"
                      style={{
                        background: entry.projectId === context.project?.projectId ? 'var(--surface-raised)' : 'transparent',
                        color: 'var(--ink-secondary)',
                      }}
                    >
                      <span className="block truncate" style={{ color: 'var(--ink)' }}>
                        {entry.title}
                      </span>
                      <span className="text-[10.5px]" style={{ color: 'var(--ink-muted)' }}>
                        {entry.state.replace(/_/g, ' ').toLowerCase()} · {timestamp(entry.updatedAt)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}
        </div>
      </div>

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
