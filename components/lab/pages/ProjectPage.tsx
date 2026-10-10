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

const START_STEPS = [
  { title: 'Observe', detail: 'Select spatial transcriptomics, spatial proteomics or qualified combined spatial omics.' },
  { title: 'Perturb', detail: 'Choose a molecular/genetic or known-drug perturbation with model-supported parameters.' },
  { title: 'Propagate', detail: 'Separate direct target-cell response from first-neighbour and spatial GNN propagation.' },
  { title: 'Rescue', detail: 'Simulate every eligible therapeutic rescue candidate before comparison or ranking.' },
];

const INFRASTRUCTURE_AREAS = [
  { title: '01 Spatial omics input', detail: 'Spatial transcriptomics, spatial proteomics or qualified combined spatial omics with coordinates and metadata.' },
  { title: '02 QC and preprocessing', detail: 'Validate data, canonicalize identifiers, check eligibility and preserve provenance before prediction.' },
  { title: '03 Baseline tissue', detail: 'Analyze cells, genes/proteins, pathways, cell states, neighbourhoods and candidate interactions.' },
  { title: '04 Virtual experiment', detail: 'Select either a molecular/genetic branch or a drug branch without changing the saved baseline object.' },
  { title: '05 Direct response', detail: 'Calculate the explicit target-cell or target-state effect before any neighbourhood propagation.' },
  { title: '06 Spatial propagation', detail: 'Build a versioned spatial graph, compute first-neighbour response and run the predictive model.' },
  { title: '07 Altered tissue', detail: 'Assemble predicted molecular, pathway, cell-state, interaction and microenvironment layers.' },
  { title: '08 Rescue comparison', detail: 'Retrieve eligible candidates, simulate each one separately and compare transparent component metrics.' },
  { title: '09 Validate and export', detail: 'Explain mechanism, recommend a validation experiment and export a reproducible report bundle.' },
];

const STRATEGIC_AREAS = [
  { title: 'Beginner', detail: 'Prepared cases, illustrated QC, locked safe parameters, small rescue set and guided explanations.' },
  { title: 'Moderate', detail: 'Compatible uploads, supported targeting, evidence-backed dose/time choices and reproducible exports.' },
  { title: 'Expert', detail: 'Full provenance, graph/model versions, seeds, repeats, sensitivity analysis and diagnostics.' },
];

const NEWS_HIGHLIGHTS = [
  { title: 'Observed data uses neutral treatment with visible source dataset context.', date: 'OBSERVED' },
  { title: 'Computed values link back to a defined method and software/model version.', date: 'COMPUTED' },
  { title: 'Predicted layers carry an explicit prediction badge and uncertainty treatment.', date: 'PREDICTED' },
  { title: 'AI-assisted narrative is evidence-grounded and never creates numerical biology.', date: 'INTERPRETED' },
];

const UPCOMING_EVENTS = [
  { date: 'QC', title: 'Pipeline and eligibility', detail: 'Deterministic ingestion, preprocessing and reasons for blocking or warning.' },
  { date: 'BIO', title: 'Baseline biology', detail: 'Compare baseline outputs with trusted reference workflows and annotations.' },
  { date: 'GNN', title: 'Spatial contribution', detail: 'Validate against no-neighbour, no-edge, linear, MLP and shuffled-graph controls.' },
  { date: 'RANK', title: 'Rescue ranking', detail: 'Assess component stability, uncertainty and benchmark correlation where outcomes exist.' },
];

const HERO_STATS = [
  { label: 'Research cases', value: '2' },
  { label: 'Model nodes', value: '66' },
  { label: 'Candidate records', value: '22' },
];

const REQUIRED_SCREENS = [
  'Project setup',
  'Data and QC',
  'Baseline tissue',
  'Reference compare',
  'Select experiment',
  'Perturbation setup',
  'Propagation',
  'Predicted tissue',
  'Rescue candidates',
  'Rescue compare',
  'Interpretation',
  'Validate and report',
];

const VISUAL_LAYER_GROUPS = [
  {
    title: 'Baseline layers',
    items: ['Cell type', 'Gene expression', 'Protein abundance', 'Pathway activity', 'Cell state', 'Spatial neighbourhood', 'Cell-cell interaction'],
  },
  {
    title: 'Perturbation layers',
    items: ['Direct response', 'First-neighbour response', 'Propagation intensity', 'Delta molecular/pathway layer', 'Predicted cell state', 'Adverse/off-target region', 'Uncertainty / OOD'],
  },
  {
    title: 'Rescue layers',
    items: ['Candidate direct response', 'Propagated rescue', 'Baseline vs altered vs rescue', 'Molecular/state/spatial recovery', 'Adverse burden', 'Resistance/adaptive response', 'Uncertainty'],
  },
];

const AI_CONTRACT = [
  { title: 'Allowed', detail: 'Explain QC, summarize observed/computed findings, retrieve and organize evidence, explain simulated differences and suggest validation experiments.' },
  { title: 'Not allowed', detail: 'Change QC results, invent p-values or pathways, fabricate drug effects, bypass simulation, choose hidden numeric weights or give clinical instructions.' },
  { title: 'Evidence object', detail: 'AI receives dataset IDs, selected cells/regions, feature statistics, perturbation evidence, predictions, candidate metrics, uncertainty and result labels.' },
];

const REPORT_SECTIONS = [
  'Project metadata',
  'QC and eligibility',
  'Methods and versions',
  'Baseline spatial analysis',
  'Perturbation evidence',
  'Direct response',
  'Spatial graph and propagation',
  'Predicted altered tissue',
  'Adverse/off-target results',
  'Rescue simulations',
  'Candidate comparison',
  'AI interpretation',
  'Validation experiment',
  'Reproducibility manifest',
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
    <div className="space-y-5">
      <section id="overview" className="sll-home-hero">
        <div className="sll-home-hero-copy">
          <div className="sll-hero-kicker">
            <span>Spatial Omics AI</span>
            <strong>Virtual LiveLab</strong>
          </div>
          <h2>Observe, perturb, propagate, rescue and validate</h2>
          <p>
            A research-use virtual experimentation platform for spatial perturbation propagation and AI-guided therapeutic
            rescue. The scientific sequence is frozen: observe spatial omics, apply a controlled perturbation, propagate
            effects through tissue, simulate rescue candidates, compare transparently and export validation-ready evidence.
          </p>
          <div className="landing-actions">
            <Button variant="primary" onClick={() => document.getElementById('project-title')?.focus()}>
              Start a project
            </Button>
            <Button variant="quiet" onClick={() => document.getElementById('methods-overview')?.scrollIntoView({ behavior: 'smooth' })}>
              Explore methods
            </Button>
          </div>
          <div className="sll-hero-stats" aria-label="Spatial Omics AI summary">
            <div>
              <strong>16</strong>
              <span>Frozen workflow stages</span>
            </div>
            {HERO_STATS.map((item) => (
              <div key={item.label}>
                <strong>{item.value}</strong>
                <span>{item.label}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="sll-home-hero-visual" aria-hidden="true">
          <div className="sll-orbit">
            {Array.from({ length: 42 }).map((_, index) => (
              <span key={index} className={`cell-dot cell-dot-${(index % 5) + 1}`} />
            ))}
          </div>
        </div>
      </section>

      <section id="methods-overview" className="sll-infra-section">
        <div className="sll-section-heading">
          <h3>Frozen V1 workflow</h3>
          <p>
            The handbook locks the scientific journey from spatial input to report export. The interface presents the
            sequence as one page, while the live lab keeps each scientific object immutable and reproducible.
          </p>
        </div>
        <div className="sll-infra-grid">
          {INFRASTRUCTURE_AREAS.map((area, index) => (
            <article key={area.title}>
              <span className="sll-platform-number">{String(index + 1).padStart(2, '0')}</span>
              <h4>{area.title}</h4>
              <p>{area.detail}</p>
              <span className="sll-card-link">Explore platform</span>
            </article>
          ))}
        </div>
      </section>

      <section id="repurposing-overview" className="sll-strategic-section">
        <div className="sll-section-heading">
          <h3>Three user modes, one scientific result</h3>
          <p>
            Beginner, Moderate and Expert modes expose different controls and diagnostics, but the handbook requires
            identical numerical outputs for the same data, parameters, model version and seed.
          </p>
        </div>
        <div className="sll-strategic-grid">
          {STRATEGIC_AREAS.map((area, index) => (
            <article key={area.title}>
              <div className={`sll-strategy-image sll-strategy-image-${index + 1}`} aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
              <p className="sll-card-eyebrow">User mode</p>
              <h4>{area.title}</h4>
              <p>{area.detail}</p>
              <button type="button" onClick={() => document.getElementById(index === 1 ? 'visual-requirements-title' : 'project-form')?.scrollIntoView({ behavior: 'smooth' })}>Read more</button>
            </article>
          ))}
        </div>
      </section>

      <section className="sll-news-section">
        <div className="sll-section-heading">
          <h3>Scientific result labels</h3>
          <p>
            The UI distinguishes observed data, computed analysis, predicted simulation, AI-assisted interpretation,
            hypotheses and validation recommendations. Color is never the only indicator.
          </p>
        </div>
        <div className="sll-news-list">
          {NEWS_HIGHLIGHTS.map((item) => (
            <article key={item.title}>
              <p className="sll-news-date">{item.date}</p>
              <h4>{item.title}</h4>
              <span>Review</span>
            </article>
          ))}
        </div>
      </section>

      <section id="spatial-context" className="sll-research-section">
        <div className="sll-research-links">
          {REQUIRED_SCREENS.map((screen) => (
            <button key={screen} type="button" onClick={() => document.getElementById('project-form')?.scrollIntoView({ behavior: 'smooth' })}>
              {screen}
            </button>
          ))}
        </div>
        <div className="sll-research-copy">
          <h3>Required screens</h3>
          <h4>The navigation follows the scientific workflow, not generic software menus.</h4>
          <p>
            The locked workspace moves from project setup through data/QC, baseline tissue, experiment selection,
            propagation, predicted tissue, rescue comparison, interpretation and validation/reporting. Users may inspect
            previous results, but changing a scientific parameter creates a new run rather than overwriting the old one.
          </p>
          <button type="button" onClick={() => document.getElementById('research-boundary')?.scrollIntoView({ behavior: 'smooth' })}>Read the research boundary</button>
        </div>
      </section>

      <section className="handbook-panel-grid" aria-labelledby="visual-requirements-title">
        <div className="sll-section-heading handbook-wide-heading">
          <h3 id="visual-requirements-title">Visualization and comparison requirements</h3>
          <p>
            Measured data, computed methods and predictions are visually separated. Direct response and neighbour
            propagation use distinct symbols, uncertainty uses opacity or hatching, and comparison panels keep synchronized
            scales when values are compared.
          </p>
        </div>
        {VISUAL_LAYER_GROUPS.map((group) => (
          <article key={group.title} className="handbook-card">
            <h4>{group.title}</h4>
            <ul>
              {group.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </article>
        ))}
      </section>

      <section className="handbook-split" aria-labelledby="ai-contract-title">
        <div>
          <p className="sll-card-eyebrow">AI and evidence subsystem</p>
          <h3 id="ai-contract-title">AI explains evidence. It does not create numerical biology.</h3>
          <p>
            The handbook allows AI to organize evidence, explain structured results, generate testable hypotheses and
            recommend validation experiments. Numerical outputs must come from explicit methods, calibrated parameters or
            validated models.
          </p>
        </div>
        <div className="handbook-mini-grid">
          {AI_CONTRACT.map((item) => (
            <article key={item.title} className="handbook-card">
              <h4>{item.title}</h4>
              <p>{item.detail}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="sll-events-section">
        <div className="sll-section-heading">
          <h3>Validation ladder</h3>
          <p>
            The release is accepted only when fixed datasets, scientific calculations, model outputs, uncertainty,
            ranking behavior, security and reproducibility can be tested end to end.
          </p>
        </div>
        <div className="sll-events-list">
          {UPCOMING_EVENTS.map((event) => (
            <article key={event.title}>
              <time>{event.date}</time>
              <div>
                <h4>{event.title}</h4>
                <p>{event.detail}</p>
              </div>
              <span>QA</span>
            </article>
          ))}
        </div>
      </section>

      <section className="sll-home-footer-strip">
        <div>
          <h3>Report and reproducibility manifest</h3>
          <p>
            Every export records dataset hashes, preprocessing versions, perturbation evidence, parameter-set version,
            graph checksum, model version, random seed, warnings, uncertainty, limitations and output artifact hashes.
          </p>
        </div>
        <nav aria-label="Report sections">
          {REPORT_SECTIONS.map((link) => (
            <button key={link} type="button" onClick={() => document.getElementById('project-form')?.scrollIntoView({ behavior: 'smooth' })}>
              {link}
            </button>
          ))}
        </nav>
      </section>

      <section className="quick-start-grid" aria-label="Quick start workflow">
        {START_STEPS.map((step, index) => (
          <article key={step.title} className="quick-start-card">
            <span className="tnum">{String(index + 1).padStart(2, '0')}</span>
            <h3>{step.title}</h3>
            <p>{step.detail}</p>
          </article>
        ))}
      </section>

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

      <div id="project-form" className="project-command-center grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
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
              <ul className="space-y-2">
                {projects.map((entry) => (
                  <li key={entry.projectId}>
                    <button
                      type="button"
                      onClick={() => {
                        onProjectChange(entry);
                        context.navigate('data');
                      }}
                      className="project-list-item interactive w-full rounded px-3 py-2.5 text-left text-[12px]"
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
